import { type ValidationError, validationError } from '../core/errors.js';
import type { RngState } from '../core/prng.js';
import { type Result, err, ok } from '../core/result.js';
import { PATCH_SOURCES, type PatchBatch } from './patch.js';
import { type ReducerOptions, applyPatchBatch } from './reducer.js';
import { computeStateHash } from './swipe-tree.js';
import { type WorldState, cloneWorldState, validateWorldState } from './world-state.js';

export interface EventLogRecord {
  turn: number;
  batch: PatchBatch;
  postStateHash: string;
  rngBefore: RngState;
  rngAfter: RngState;
}

export type ReplayOptions = ReducerOptions & {
  targetTurn?: number;
};

export interface ReplayResult {
  finalState: WorldState;
  verifiedHashes: boolean;
  replayedCount: number;
}

const VALID_PATCH_SOURCES: ReadonlySet<string> = new Set(PATCH_SOURCES);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

function isPatchBatchShape(value: unknown): value is PatchBatch {
  return (
    isPlainObject(value) &&
    typeof value.eventId === 'string' &&
    value.eventId.trim().length > 0 &&
    typeof value.source === 'string' &&
    VALID_PATCH_SOURCES.has(value.source) &&
    Array.isArray(value.operations)
  );
}

function isValidRngState(value: unknown): value is RngState {
  if (!isPlainObject(value)) {
    return false;
  }
  if (value.type === 'xoshiro128**') {
    return (
      typeof value.s0 === 'number' &&
      typeof value.s1 === 'number' &&
      typeof value.s2 === 'number' &&
      typeof value.s3 === 'number' &&
      typeof value.drawCount === 'number' &&
      Number.isInteger(value.drawCount) &&
      value.drawCount >= 0
    );
  }
  if (value.type === 'queued') {
    return (
      Array.isArray(value.queue) &&
      typeof value.cursor === 'number' &&
      Number.isInteger(value.cursor) &&
      value.cursor >= 0 &&
      typeof value.drawCount === 'number' &&
      Number.isInteger(value.drawCount) &&
      value.drawCount >= 0 &&
      isValidRngState(value.fallback)
    );
  }
  return false;
}

function cloneRngState(rngState: RngState): RngState {
  if (rngState.type === 'queued') {
    return {
      type: 'queued',
      queue: [...rngState.queue],
      cursor: rngState.cursor,
      fallback: { ...rngState.fallback },
      drawCount: rngState.drawCount,
    };
  }
  return { ...rngState };
}

function rngStatesEqual(a: RngState, b: RngState): boolean {
  if (a.type !== b.type || a.drawCount !== b.drawCount) {
    return false;
  }
  if (a.type === 'xoshiro128**' && b.type === 'xoshiro128**') {
    return a.s0 === b.s0 && a.s1 === b.s1 && a.s2 === b.s2 && a.s3 === b.s3;
  }
  if (a.type === 'queued' && b.type === 'queued') {
    if (
      a.cursor !== b.cursor ||
      a.queue.length !== b.queue.length ||
      !rngStatesEqual(a.fallback, b.fallback)
    ) {
      return false;
    }
    for (let i = 0; i < a.queue.length; i += 1) {
      if (a.queue[i] !== b.queue[i]) {
        return false;
      }
    }
    return true;
  }
  return false;
}

/**
 * Deterministically replay a sequence of {@link EventLogRecord} entries starting from
 * `initialSnapshot`, applying each `PatchBatch` via {@link applyPatchBatch} and verifying
 * `computeStateHash` at every step.
 */
export function replayFromEvents(
  initialSnapshot: WorldState,
  events: readonly EventLogRecord[],
  options?: ReplayOptions
): Result<ReplayResult, ValidationError[]> {
  const initialValidation = validateWorldState(initialSnapshot);
  if (!initialValidation.ok) {
    return err(initialValidation.error);
  }

  if (!Array.isArray(events)) {
    return err([validationError('events', 'INVALID_TYPE', 'events must be an array')]);
  }

  const targetTurn = options?.targetTurn;
  if (targetTurn !== undefined) {
    if (typeof targetTurn !== 'number' || !Number.isInteger(targetTurn) || targetTurn < 0) {
      return err([
        validationError('targetTurn', 'INVALID_TURN', 'targetTurn must be a non-negative integer'),
      ]);
    }
  }

  let currentState = cloneWorldState(initialValidation.value.state);
  let replayedCount = 0;
  let nextAuditSeq = options?.auditSeqStart ?? 1;

  for (let i = 0; i < events.length; i += 1) {
    const record = events[i];
    if (!isPlainObject(record)) {
      return err([
        validationError(`events[${i}]`, 'INVALID_TYPE', `Event record at index ${i} must be an object`),
      ]);
    }
    if (typeof record.turn !== 'number' || !Number.isInteger(record.turn) || record.turn < 0) {
      return err([
        validationError(
          `events[${i}].turn`,
          'INVALID_TURN',
          `Event turn at index ${i} must be a non-negative integer`
        ),
      ]);
    }
    if (targetTurn !== undefined && record.turn > targetTurn) {
      break;
    }
    if (typeof record.postStateHash !== 'string' || record.postStateHash.trim().length === 0) {
      return err([
        validationError(
          `events[${i}].postStateHash`,
          'REQUIRED',
          `Event postStateHash at index ${i} must be a non-empty string`
        ),
      ]);
    }
    if (!isValidRngState(record.rngBefore)) {
      return err([
        validationError(
          `events[${i}].rngBefore`,
          'INVALID_RNG_STATE',
          `Event rngBefore at index ${i} is not a valid RngState`
        ),
      ]);
    }
    if (!isValidRngState(record.rngAfter)) {
      return err([
        validationError(
          `events[${i}].rngAfter`,
          'INVALID_RNG_STATE',
          `Event rngAfter at index ${i} is not a valid RngState`
        ),
      ]);
    }

    const rngAdvanced = !rngStatesEqual(record.rngBefore, record.rngAfter);
    if (rngAdvanced && !rngStatesEqual(record.rngBefore, currentState.meta.rngState)) {
      return err([
        validationError(
          `events[${i}].rngBefore`,
          'RNG_CHAIN_MISMATCH',
          `Event rngBefore at index ${i} (turn ${record.turn}) does not match current WorldState rngState`
        ),
      ]);
    }

    const stepOptions: ReducerOptions = {
      auditSeqStart: nextAuditSeq,
      ...(options?.compiledSchema !== undefined ? { compiledSchema: options.compiledSchema } : {}),
      ...(options?.formIndex !== undefined ? { formIndex: options.formIndex } : {}),
    };

    if (!isPatchBatchShape(record.batch)) {
      return err([
        validationError(
          `events[${i}].batch`,
          'INVALID_PATCH_BATCH',
          `Event batch at index ${i} is not a valid PatchBatch`
        ),
      ]);
    }

    const batchRes = applyPatchBatch(currentState, record.batch, stepOptions);
    if (!batchRes.ok) {
      return err(batchRes.error);
    }

    const nextState = batchRes.value.nextState;
    if (rngAdvanced || rngStatesEqual(record.rngBefore, currentState.meta.rngState)) {
      nextState.meta.rngState = cloneRngState(record.rngAfter);
    }

    const actualHash = computeStateHash(nextState);
    if (actualHash !== record.postStateHash) {
      return err([
        validationError(
          `events[${i}].postStateHash`,
          'STATE_HASH_MISMATCH',
          `State hash mismatch at event ${i} (turn ${record.turn}): expected "${record.postStateHash}", got "${actualHash}"`
        ),
      ]);
    }

    nextAuditSeq += batchRes.value.auditEntries.length;
    currentState = nextState;
    replayedCount += 1;
  }

  return ok({
    finalState: currentState,
    verifiedHashes: true,
    replayedCount,
  });
}
