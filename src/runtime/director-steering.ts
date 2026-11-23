import { forceBeatTransition } from '../beats/beat-engine.js';
import {
  type BeatDefinition,
  type BeatLedgerState,
  cloneBeatLedger,
} from '../beats/beat-ledger.js';
import { type ValidationError, validationError } from '../core/errors.js';
import { ErrorAccumulator, type Result, err, ok } from '../core/result.js';
import type { AuditEntry } from '../state/audit-log.js';
import type { FormDefinition } from '../state/forms.js';
import type { PatchOperation } from '../state/patch.js';
import { type ReducerOptions, applyPatchBatch } from '../state/reducer.js';
import { type WorldState, cloneWorldState } from '../state/world-state.js';
import { computeLocationCast } from '../world/cast-presence.js';

export type DirectorClockAction =
  | 'hold'
  | 'release'
  | { readonly advanceSlots: number }
  | 'rest_to_morning';

export interface DirectorBeatOverride {
  readonly beatId: string;
  readonly status: 'resolved' | 'deferred' | 'short_circuited';
  readonly reason?: string;
}

export interface DirectorSteeringInput {
  readonly clockAction?: DirectorClockAction;
  readonly oocNudge?: string | null;
  readonly pinCharacterIds?: readonly string[];
  readonly dismissCharacterIds?: readonly string[];
  readonly beatOverrides?: readonly DirectorBeatOverride[];
}

export interface ApplyDirectorSteeringParams {
  readonly state: WorldState;
  readonly ledger: BeatLedgerState;
  readonly steering: DirectorSteeringInput;
  readonly beats?: readonly BeatDefinition[];
  readonly reducerOptions?: ReducerOptions;
  readonly formDefinitions?: readonly FormDefinition[];
}

export interface ApplyDirectorSteeringResult {
  readonly nextState: WorldState;
  readonly nextLedger: BeatLedgerState;
  readonly auditEntries: AuditEntry[];
  readonly changedPaths: Set<string>;
  readonly daysElapsed: number;
  readonly slotsElapsed: number;
  readonly triggeredScripts: string[];
  readonly injectedLorePaths: string[];
}

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

function isSafeKey(key: string): boolean {
  return key.length > 0 && !FORBIDDEN_KEYS.has(key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

function computeSlotsToMorning(state: WorldState): number {
  const slotsPerDay = state.clocks.slotsPerDay;
  if (slotsPerDay.length === 0) {
    return 1;
  }
  const morningIdxRaw = slotsPerDay.indexOf('morning');
  const morningIdx = morningIdxRaw >= 0 ? morningIdxRaw : 0;
  const currIdxRaw = slotsPerDay.indexOf(state.clocks.slot);
  const currIdx = currIdxRaw >= 0 ? currIdxRaw : 0;
  const len = slotsPerDay.length;
  const diff = (morningIdx - currIdx + len) % len;
  return diff === 0 ? len : diff;
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Translate Director Steering Bar controls (clock hold/release/advance/rest, one-turn OOC nudge,
 * character pin/dismiss, and manual beat overrides) into atomic `user_director` state mutations.
 */
export function applyDirectorSteering(
  params: ApplyDirectorSteeringParams
): Result<ApplyDirectorSteeringResult, ValidationError[]> {
  const { state, ledger, steering, beats, reducerOptions } = params;

  if (!isPlainObject(steering as unknown)) {
    return err([
      validationError('steering', 'INVALID_TYPE', 'DirectorSteeringInput must be an object'),
    ]);
  }

  const acc = new ErrorAccumulator('steering');
  const operations: PatchOperation[] = [];

  if (steering.clockAction !== undefined) {
    const action = steering.clockAction;
    if (action === 'hold') {
      operations.push({ op: 'clock_hold', reason: 'Director clock hold' });
    } else if (action === 'release') {
      operations.push({ op: 'clock_release' });
    } else if (action === 'rest_to_morning') {
      operations.push({
        op: 'clock_advance',
        mechanicalTurns: 0,
        storySlots: computeSlotsToMorning(state),
        forceIgnoreHold: true,
      });
    } else if (isPlainObject(action) && Object.hasOwn(action, 'advanceSlots')) {
      const slots = Object.getOwnPropertyDescriptor(action, 'advanceSlots')?.value;
      if (typeof slots !== 'number' || !Number.isInteger(slots) || slots < 0) {
        acc.add(
          'clockAction.advanceSlots',
          'INVALID_INTEGER',
          'advanceSlots must be a non-negative integer'
        );
      } else {
        operations.push({
          op: 'clock_advance',
          mechanicalTurns: 0,
          storySlots: slots,
        });
      }
    } else {
      acc.add(
        'clockAction',
        'INVALID_CLOCK_ACTION',
        'clockAction must be "hold", "release", "rest_to_morning", or { advanceSlots }'
      );
    }
  }

  if (steering.oocNudge !== undefined) {
    if (steering.oocNudge !== null && typeof steering.oocNudge !== 'string') {
      acc.add('oocNudge', 'INVALID_TYPE', 'oocNudge must be a string or null');
    } else {
      operations.push({
        op: 'set',
        path: 'scene.directorNudge',
        value: steering.oocNudge,
      });
    }
  }

  const pinIds: string[] = [];
  const dismissIds: string[] = [];
  let hasCastAdjustment = false;

  if (steering.dismissCharacterIds !== undefined) {
    hasCastAdjustment = true;
    if (!Array.isArray(steering.dismissCharacterIds)) {
      acc.add('dismissCharacterIds', 'INVALID_TYPE', 'dismissCharacterIds must be an array');
    } else {
      for (let i = 0; i < steering.dismissCharacterIds.length; i += 1) {
        const id = steering.dismissCharacterIds[i];
        if (typeof id !== 'string' || !isSafeKey(id)) {
          acc.add(
            `dismissCharacterIds[${i}]`,
            'UNSAFE_KEY',
            `Invalid character ID "${String(id)}"`
          );
        } else if (!Object.hasOwn(state.entities.characters, id)) {
          acc.add(
            `dismissCharacterIds[${i}]`,
            'UNRESOLVED_CHARACTER',
            `Character "${id}" does not exist in entities.characters`
          );
        } else if (!dismissIds.includes(id)) {
          dismissIds.push(id);
        }
      }
    }
  }

  if (steering.pinCharacterIds !== undefined) {
    hasCastAdjustment = true;
    if (!Array.isArray(steering.pinCharacterIds)) {
      acc.add('pinCharacterIds', 'INVALID_TYPE', 'pinCharacterIds must be an array');
    } else {
      for (let i = 0; i < steering.pinCharacterIds.length; i += 1) {
        const id = steering.pinCharacterIds[i];
        if (typeof id !== 'string' || !isSafeKey(id)) {
          acc.add(`pinCharacterIds[${i}]`, 'UNSAFE_KEY', `Invalid character ID "${String(id)}"`);
        } else if (!Object.hasOwn(state.entities.characters, id)) {
          acc.add(
            `pinCharacterIds[${i}]`,
            'UNRESOLVED_CHARACTER',
            `Character "${id}" does not exist in entities.characters`
          );
        } else if (!pinIds.includes(id)) {
          pinIds.push(id);
        }
      }
    }
  }

  if (steering.beatOverrides !== undefined && !Array.isArray(steering.beatOverrides)) {
    acc.add('beatOverrides', 'INVALID_TYPE', 'beatOverrides must be an array');
  }

  if (acc.hasErrors()) {
    return err([...acc.errors]);
  }

  if (hasCastAdjustment) {
    const dismissSet = new Set(dismissIds);
    const nextPinned = state.scene.pinnedCharacterIds.filter((id) => !dismissSet.has(id));
    for (const id of pinIds) {
      if (!nextPinned.includes(id)) {
        nextPinned.push(id);
      }
    }

    operations.push({
      op: 'set',
      path: 'scene.pinnedCharacterIds',
      value: nextPinned,
    });

    if (state.capabilities.spatialMode === 'scene_only') {
      for (const id of dismissIds) {
        if (!pinIds.includes(id)) {
          operations.push({
            op: 'entity_patch',
            collection: 'characters',
            entityId: id,
            patch: { presentInScene: false },
          });
        }
      }
      for (const id of pinIds) {
        operations.push({
          op: 'entity_patch',
          collection: 'characters',
          entityId: id,
          patch: { presentInScene: true },
        });
      }
    }
  }

  let currentState = cloneWorldState(state);
  let currentLedger = cloneBeatLedger(ledger);
  const auditEntries: AuditEntry[] = [];
  const changedPaths = new Set<string>();
  let daysElapsed = 0;
  let slotsElapsed = 0;
  const triggeredScripts: string[] = [];
  const injectedLorePaths: string[] = [];
  let nextAuditSeq = reducerOptions?.auditSeqStart ?? 1;

  if (operations.length > 0) {
    const batchRes = applyPatchBatch(
      currentState,
      {
        eventId: `director:steering:t${currentState.meta.turn}:s${nextAuditSeq}`,
        source: 'user_director',
        operations,
        reason: 'Director Steering Bar update',
      },
      {
        ...reducerOptions,
        auditSeqStart: nextAuditSeq,
      }
    );
    if (!batchRes.ok) {
      return err(batchRes.error);
    }
    currentState = batchRes.value.nextState;
    auditEntries.push(...batchRes.value.auditEntries);
    nextAuditSeq += batchRes.value.auditEntries.length;
    for (const p of batchRes.value.changedPaths) {
      changedPaths.add(p);
    }
    daysElapsed += batchRes.value.daysElapsed;
    slotsElapsed += batchRes.value.slotsElapsed;

    if (hasCastAdjustment) {
      const cast = computeLocationCast(currentState, params.formDefinitions);
      if (!arraysEqual(cast.presentCharacterIds, currentState.scene.presentCharacterIds)) {
        const castSyncRes = applyPatchBatch(
          currentState,
          {
            eventId: `director:cast_sync:t${currentState.meta.turn}:s${nextAuditSeq}`,
            source: 'user_director',
            operations: [
              {
                op: 'set',
                path: 'scene.presentCharacterIds',
                value: cast.presentCharacterIds,
              },
            ],
            reason: 'Sync scene presentCharacterIds after Director cast adjustment',
          },
          {
            ...reducerOptions,
            auditSeqStart: nextAuditSeq,
          }
        );
        if (!castSyncRes.ok) {
          return err(castSyncRes.error);
        }
        currentState = castSyncRes.value.nextState;
        auditEntries.push(...castSyncRes.value.auditEntries);
        nextAuditSeq += castSyncRes.value.auditEntries.length;
        for (const p of castSyncRes.value.changedPaths) {
          changedPaths.add(p);
        }
      }
    }
  }

  if (steering.beatOverrides !== undefined) {
    for (let i = 0; i < steering.beatOverrides.length; i += 1) {
      const override = steering.beatOverrides[i];
      if (!override || !isPlainObject(override as unknown)) {
        return err([
          validationError(
            `steering.beatOverrides[${i}]`,
            'INVALID_TYPE',
            'Beat override entry must be an object'
          ),
        ]);
      }

      const forceRes = forceBeatTransition(
        currentLedger,
        currentState,
        override.beatId,
        override.status,
        {
          ...(beats !== undefined ? { beats } : {}),
          ...(override.reason !== undefined ? { reason: override.reason } : {}),
          reducerOptions: {
            ...reducerOptions,
            auditSeqStart: nextAuditSeq,
          },
        }
      );

      if (!forceRes.ok) {
        return err(forceRes.error);
      }

      currentLedger = forceRes.value.nextLedger;
      currentState = forceRes.value.nextState;
      auditEntries.push(...forceRes.value.auditEntries);
      nextAuditSeq += forceRes.value.auditEntries.length;
      for (const p of forceRes.value.changedPaths) {
        changedPaths.add(p);
      }
      for (const scriptId of forceRes.value.triggeredScripts) {
        if (!triggeredScripts.includes(scriptId)) {
          triggeredScripts.push(scriptId);
        }
      }
      for (const lorePath of forceRes.value.injectedLorePaths) {
        if (!injectedLorePaths.includes(lorePath)) {
          injectedLorePaths.push(lorePath);
        }
      }
    }
  }

  return ok({
    nextState: currentState,
    nextLedger: currentLedger,
    auditEntries,
    changedPaths,
    daysElapsed,
    slotsElapsed,
    triggeredScripts,
    injectedLorePaths,
  });
}
