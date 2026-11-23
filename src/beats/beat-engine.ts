import type { BeatPressure } from '../config/control-room-config.js';
import { type ValidationError, validationError } from '../core/errors.js';
import { type Result, err, ok } from '../core/result.js';
import type { AuditEntry } from '../state/audit-log.js';
import type { PatchOperation, PatchSource } from '../state/patch.js';
import { type ReducerOptions, applyPatchBatch } from '../state/reducer.js';
import type { WorldState } from '../state/world-state.js';
import {
  type BeatDefinition,
  type BeatEffect,
  type BeatLedgerState,
  type BeatRuntimeRecord,
  type RequiresPolicy,
  canTransitionBeat,
  cloneBeatLedger,
  createInitialBeatRecord,
  isTerminalBeatStatus,
} from './beat-ledger.js';
import {
  type DependencyEntry,
  type DependencyIndex,
  buildDependencyIndex,
  findDirtyIds,
} from './dependency-compiler.js';
import {
  type BeatStatus,
  type PredicateAst,
  isUnsafePropertyKey,
} from './predicate-ast.js';
import { evaluatePredicate } from './predicate-evaluator.js';
import {
  type BoundRoleResult,
  bindBeatRoles,
  interpolateBeatTemplate,
} from './role-binder.js';

export interface BeatTransition {
  readonly beatId: string;
  readonly from: BeatStatus;
  readonly to: BeatStatus;
  readonly reason: string;
}

export interface LiveNudgeEntry {
  readonly beatId: string;
  readonly class: 'gate' | 'nudge';
  readonly text: string;
}

export interface ActiveAmbientEntry {
  readonly beatId: string;
  readonly lore?: string;
  readonly nudge?: string;
}

export interface EvaluateBeatGraphParams {
  readonly state: WorldState;
  readonly ledger: BeatLedgerState;
  readonly beats: readonly BeatDefinition[];
  readonly dependencyIndex?: DependencyIndex;
  readonly changedPaths?: ReadonlySet<string>;
  readonly recentTranscriptLines?: readonly string[];
  readonly beatPressure?: BeatPressure;
  readonly reducerOptions?: ReducerOptions;
}

export interface EvaluateBeatGraphResult {
  readonly nextState: WorldState;
  readonly nextLedger: BeatLedgerState;
  readonly transitions: BeatTransition[];
  readonly triggeredScripts: string[];
  readonly injectedLorePaths: string[];
  readonly liveNudges: LiveNudgeEntry[];
  readonly activeAmbient: ActiveAmbientEntry[];
  readonly auditEntries: AuditEntry[];
  readonly changedPaths: Set<string>;
  readonly warnings: ValidationError[];
}

export type ForcedBeatStatus = 'resolved' | 'deferred' | 'short_circuited';

export interface ForceBeatTransitionOptions {
  readonly beats?: readonly BeatDefinition[];
  readonly reason?: string;
  readonly reducerOptions?: ReducerOptions;
}

export interface ForceBeatTransitionResult {
  readonly nextLedger: BeatLedgerState;
  readonly nextState: WorldState;
  readonly transition: BeatTransition | null;
  readonly triggeredScripts: string[];
  readonly injectedLorePaths: string[];
  readonly auditEntries: AuditEntry[];
  readonly changedPaths: Set<string>;
  readonly warnings: ValidationError[];
}

const VALID_FORCED_STATUSES: ReadonlySet<string> = new Set([
  'resolved',
  'deferred',
  'short_circuited',
]);

function compareIdsLexicographic(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function sortBeatsDeterministic(beats: readonly BeatDefinition[]): BeatDefinition[] {
  return [...beats].sort((a, b) => {
    if (b.priority !== a.priority) {
      return b.priority - a.priority;
    }
    return compareIdsLexicographic(a.id, b.id);
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

function cloneSafeUnknown(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(cloneSafeUnknown);
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (isUnsafePropertyKey(key)) {
      continue;
    }
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (desc !== undefined) {
      Object.defineProperty(out, key, {
        value: cloneSafeUnknown(desc.value),
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
  }
  return out;
}

function getOwnRecord(
  records: Readonly<Record<string, BeatRuntimeRecord>>,
  id: string
): BeatRuntimeRecord | undefined {
  if (isUnsafePropertyKey(id) || !Object.hasOwn(records, id)) {
    return undefined;
  }
  const desc = Object.getOwnPropertyDescriptor(records, id);
  return desc?.value as BeatRuntimeRecord | undefined;
}

function setOwnRecord(
  records: Record<string, BeatRuntimeRecord>,
  id: string,
  record: BeatRuntimeRecord
): void {
  Object.defineProperty(records, id, {
    value: record,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

function buildStatusMap(ledger: BeatLedgerState): Map<string, BeatStatus> {
  const map = new Map<string, BeatStatus>();
  for (const id of Object.keys(ledger.records)) {
    if (isUnsafePropertyKey(id)) {
      continue;
    }
    const rec = getOwnRecord(ledger.records, id);
    if (rec) {
      map.set(id, rec.status);
    }
  }
  return map;
}

function resolveSetPath(key: string, value: unknown): string {
  if (key.includes('.')) {
    return key;
  }
  if (typeof value === 'boolean') {
    return `flags.${key}`;
  }
  if (typeof value === 'number') {
    return `counters.${key}`;
  }
  return `customFields.${key}`;
}

function resolveIncrementPath(key: string): string {
  if (key.includes('.')) {
    return key;
  }
  return `counters.${key}`;
}

function scaleAstNode(ast: PredicateAst, pressure: 'generous' | 'harsh'): PredicateAst {
  if ('clock' in ast) {
    const scaledValue =
      pressure === 'generous'
        ? Math.ceil(ast.value * 1.5)
        : Math.max(1, Math.floor(ast.value * 0.75));
    return {
      clock: ast.clock,
      op: ast.op,
      value: scaledValue,
    };
  }
  if ('all' in ast) {
    return {
      all: ast.all.map((child) => scaleAstNode(child, pressure)),
    };
  }
  if ('any' in ast) {
    return {
      any: ast.any.map((child) => scaleAstNode(child, pressure)),
    };
  }
  if ('not' in ast) {
    return {
      not: scaleAstNode(ast.not, pressure),
    };
  }
  return ast;
}

/**
 * Scale a deadline {@link PredicateAst} according to {@link BeatPressure}:
 * - `'off'` -> `null` (disabled)
 * - `'standard'` -> unchanged
 * - `'generous'` -> scales `clock` values by `Math.ceil(v * 1.5)`
 * - `'harsh'` -> scales `clock` values by `Math.max(1, Math.floor(v * 0.75))`
 */
export function scalePredicateForBeatPressure(
  ast: PredicateAst,
  pressure: BeatPressure
): PredicateAst | null {
  if (pressure === 'off') {
    return null;
  }
  if (pressure === 'standard') {
    return ast;
  }
  return scaleAstNode(ast, pressure);
}

/**
 * Compile a complete {@link DependencyIndex} across all beat predicates (`when`, `until`,
 * `impossible_when`, `deadline`) and `requires` beat references.
 */
export function buildBeatDependencyIndex(beats: readonly BeatDefinition[]): DependencyIndex {
  const entries: DependencyEntry[] = [];
  for (const beat of beats) {
    if (isUnsafePropertyKey(beat.id)) {
      continue;
    }
    const predicates: PredicateAst[] = [beat.when];
    if (beat.until) predicates.push(beat.until);
    if (beat.impossible_when) predicates.push(beat.impossible_when);
    if (beat.deadline) predicates.push(beat.deadline);
    if (beat.requires) {
      for (const reqId of beat.requires) {
        predicates.push({ beat: reqId, status: 'resolved' });
      }
    }
    entries.push({ id: beat.id, predicates });
  }
  return buildDependencyIndex(entries);
}

function compileEffects(
  beatId: string,
  effects: readonly BeatEffect[] | undefined,
  boundRoles: Readonly<Record<string, BoundRoleResult>>,
  state: WorldState,
  triggeredScripts: string[],
  injectedLorePaths: string[]
): PatchOperation[] {
  if (!effects || effects.length === 0) {
    return [];
  }

  const operations: PatchOperation[] = [];
  const involvedEntityIds = Array.from(
    new Set(
      Object.values(boundRoles)
        .filter((b) => b !== undefined)
        .map((b) => b.entityId)
    )
  ).sort(compareIdsLexicographic);

  const safeSceneLocationId =
    state.scene.locationId !== null &&
    (state.capabilities.spatialMode !== 'authored_graph' ||
      (!isUnsafePropertyKey(state.scene.locationId) &&
        Object.hasOwn(state.entities.locations, state.scene.locationId)))
      ? state.scene.locationId
      : null;

  for (const effect of effects) {
    if ('op' in effect) {
      operations.push(effect);
      continue;
    }
    if ('set' in effect && isPlainObject(effect.set)) {
      const keys = Object.keys(effect.set)
        .filter((k) => !isUnsafePropertyKey(k))
        .sort(compareIdsLexicographic);
      for (const key of keys) {
        const desc = Object.getOwnPropertyDescriptor(effect.set, key);
        const rawVal = desc?.value;
        const value =
          typeof rawVal === 'string'
            ? interpolateBeatTemplate(rawVal, boundRoles)
            : cloneSafeUnknown(rawVal);
        operations.push({
          op: 'set',
          path: resolveSetPath(key, value),
          value,
        });
      }
    }
    if ('increment' in effect && isPlainObject(effect.increment)) {
      const keys = Object.keys(effect.increment)
        .filter((k) => !isUnsafePropertyKey(k))
        .sort(compareIdsLexicographic);
      for (const key of keys) {
        const desc = Object.getOwnPropertyDescriptor(effect.increment, key);
        const delta = desc?.value;
        if (typeof delta === 'number') {
          operations.push({
            op: 'increment',
            path: resolveIncrementPath(key),
            delta,
          });
        }
      }
    }
    if ('entity_patch' in effect && effect.entity_patch !== undefined) {
      const ep = effect.entity_patch;
      const entityId = interpolateBeatTemplate(ep.entityId, boundRoles);
      const patch = cloneSafeUnknown(ep.patch);
      if (isPlainObject(patch)) {
        operations.push({
          op: 'entity_patch',
          collection: ep.collection,
          entityId,
          patch,
        });
      }
    }
    if ('chronicle' in effect && effect.chronicle !== undefined) {
      const title = interpolateBeatTemplate(effect.chronicle.title, boundRoles);
      const summary = interpolateBeatTemplate(effect.chronicle.summary, boundRoles);
      operations.push({
        op: 'chronicle_append',
        entry: {
          category: effect.chronicle.category,
          title,
          summary,
          locationId: safeSceneLocationId,
          involvedEntityIds,
          keywords: ['beat', beatId],
        },
      });
    }
    if ('inject' in effect && typeof effect.inject === 'string') {
      injectedLorePaths.push(interpolateBeatTemplate(effect.inject, boundRoles));
    }
    if ('script' in effect && typeof effect.script === 'string') {
      triggeredScripts.push(interpolateBeatTemplate(effect.script, boundRoles));
    }
  }

  return operations;
}

function areRequiresSatisfied(
  beat: BeatDefinition,
  statusMap: ReadonlyMap<string, BeatStatus>
): boolean {
  if (!beat.requires || beat.requires.length === 0) {
    return true;
  }
  const policy: RequiresPolicy = beat.requiresPolicy ?? 'terminal_completed';
  for (const reqId of beat.requires) {
    const reqStatus = statusMap.get(reqId);
    if (reqStatus === undefined) {
      return false;
    }
    if (policy === 'any_terminal') {
      if (!isTerminalBeatStatus(reqStatus)) {
        return false;
      }
    } else if (reqStatus !== 'resolved' && reqStatus !== 'adapted') {
      return false;
    }
  }
  return true;
}

function clearLiveIdsForBeat(ledger: BeatLedgerState, beatId: string): void {
  if (ledger.liveGateId === beatId) {
    ledger.liveGateId = null;
  }
  ledger.liveNudgeIds = ledger.liveNudgeIds.filter((id) => id !== beatId);
  ledger.activeAmbientIds = ledger.activeAmbientIds.filter((id) => id !== beatId);
}

/**
 * Evaluate the beat lifecycle graph for one turn / state transition pass.
 *
 * Returns a pure no-op immediately when `state.capabilities.beats === false`.
 */
export function evaluateBeatGraph(
  params: EvaluateBeatGraphParams
): EvaluateBeatGraphResult {
  const {
    state,
    ledger,
    beats,
    dependencyIndex,
    changedPaths: inputChangedPaths,
    recentTranscriptLines,
    beatPressure = 'standard',
    reducerOptions,
  } = params;

  if (!state.capabilities.beats) {
    return {
      nextState: state,
      nextLedger: ledger,
      transitions: [],
      triggeredScripts: [],
      injectedLorePaths: [],
      liveNudges: [],
      activeAmbient: [],
      auditEntries: [],
      changedPaths: new Set<string>(),
      warnings: [],
    };
  }

  const nextLedger = cloneBeatLedger(ledger);
  let currentState = state;
  const transitions: BeatTransition[] = [];
  const triggeredScripts: string[] = [];
  const injectedLorePaths: string[] = [];
  const auditEntries: AuditEntry[] = [];
  const changedPaths = new Set<string>();
  const warnings: ValidationError[] = [];

  const validBeats: BeatDefinition[] = [];
  const beatById = new Map<string, BeatDefinition>();
  for (const beat of beats) {
    if (typeof beat.id !== 'string' || beat.id.trim().length === 0 || isUnsafePropertyKey(beat.id)) {
      continue;
    }
    if (!beatById.has(beat.id)) {
      beatById.set(beat.id, beat);
      validBeats.push(beat);
    }
    if (!getOwnRecord(nextLedger.records, beat.id)) {
      setOwnRecord(nextLedger.records, beat.id, createInitialBeatRecord(beat.id));
    }
  }

  const orderedBeats = sortBeatsDeterministic(validBeats);
  const statusMap = buildStatusMap(nextLedger);
  let nextAuditSeq = reducerOptions?.auditSeqStart ?? 1;
  let effectBatchSeq = 1;

  // Build dirty set when DependencyIndex + changedPaths are both supplied.
  const useDirtyFilter = dependencyIndex !== undefined && inputChangedPaths !== undefined;
  const dirtyIds = new Set<string>();
  const dependentsByReq = new Map<string, Set<string>>();

  if (useDirtyFilter) {
    for (const beat of orderedBeats) {
      if (beat.requires) {
        for (const reqId of beat.requires) {
          let bucket = dependentsByReq.get(reqId);
          if (!bucket) {
            bucket = new Set<string>();
            dependentsByReq.set(reqId, bucket);
          }
          bucket.add(beat.id);
        }
      }
    }

    const lookupPaths = new Set<string>(inputChangedPaths);
    if (recentTranscriptLines && recentTranscriptLines.length > 0) {
      lookupPaths.add('transcript.mentions');
    }
    for (const id of findDirtyIds(dependencyIndex, lookupPaths)) {
      dirtyIds.add(id);
    }

    let hasEntityOrSceneChange = false;
    for (const p of inputChangedPaths) {
      if (p.startsWith('entities.') || p.startsWith('scene.')) {
        hasEntityOrSceneChange = true;
        break;
      }
    }
    if (hasEntityOrSceneChange) {
      for (const beat of orderedBeats) {
        if (beat.roles && Object.keys(beat.roles).length > 0) {
          dirtyIds.add(beat.id);
        }
      }
    }
  }

  const expandDirtyFromPaths = (paths: ReadonlySet<string>): void => {
    if (!useDirtyFilter || paths.size === 0) {
      return;
    }
    for (const id of findDirtyIds(dependencyIndex, paths)) {
      dirtyIds.add(id);
    }
  };

  const isBeatDirtyOrActive = (beatId: string, status: BeatStatus): boolean => {
    if (!useDirtyFilter) {
      return true;
    }
    if (status === 'live' || status === 'eligible') {
      return true;
    }
    return dirtyIds.has(beatId);
  };

  const applyPhaseEffects = (
    beat: BeatDefinition,
    record: BeatRuntimeRecord,
    phase: string,
    effects: readonly BeatEffect[] | undefined,
    source: PatchSource = 'beat'
  ): void => {
    const ops = compileEffects(
      beat.id,
      effects,
      record.boundRoles,
      currentState,
      triggeredScripts,
      injectedLorePaths
    );
    if (ops.length === 0) {
      return;
    }
    const batchRes = applyPatchBatch(
      currentState,
      {
        eventId: `beat:${beat.id}:${phase}:t${currentState.meta.turn}:n${effectBatchSeq}`,
        source,
        operations: ops,
        reason: `Beat "${beat.id}" ${phase}`,
      },
      {
        ...reducerOptions,
        auditSeqStart: nextAuditSeq,
      }
    );
    effectBatchSeq += 1;

    if (!batchRes.ok) {
      for (const e of batchRes.error) {
        warnings.push(e);
      }
      return;
    }

    currentState = batchRes.value.nextState;
    auditEntries.push(...batchRes.value.auditEntries);
    nextAuditSeq += batchRes.value.auditEntries.length;
    for (const p of batchRes.value.changedPaths) {
      changedPaths.add(p);
    }
    expandDirtyFromPaths(batchRes.value.changedPaths);
  };

  const transitionBeat = (
    beat: BeatDefinition,
    record: BeatRuntimeRecord,
    to: BeatStatus,
    reason: string
  ): boolean => {
    const from = record.status;
    if (from === to) {
      return false;
    }
    if (!canTransitionBeat(from, to)) {
      return false;
    }
    record.status = to;
    record.lastTransitionTurn = currentState.meta.turn;
    statusMap.set(beat.id, to);
    transitions.push({ beatId: beat.id, from, to, reason });

    const beatPath = `beats.${beat.id}.status`;
    changedPaths.add(beatPath);
    if (useDirtyFilter) {
      expandDirtyFromPaths(new Set([beatPath]));
      const reqDependents = dependentsByReq.get(beat.id);
      if (reqDependents) {
        for (const depId of reqDependents) {
          dirtyIds.add(depId);
        }
      }
    }
    if (to !== 'live') {
      clearLiveIdsForBeat(nextLedger, beat.id);
    }
    return true;
  };

  const evalPredicateNow = (ast: PredicateAst): boolean =>
    evaluatePredicate(ast, {
      state: currentState,
      beatStatuses: statusMap,
      recentTranscriptLines,
      warnings,
    });

  // (1) impossible_when -> short_circuited
  for (const beat of orderedBeats) {
    const record = getOwnRecord(nextLedger.records, beat.id);
    if (!record || isTerminalBeatStatus(record.status)) {
      continue;
    }
    if (!isBeatDirtyOrActive(beat.id, record.status) || !beat.impossible_when) {
      continue;
    }
    if (evalPredicateNow(beat.impossible_when)) {
      if (transitionBeat(beat, record, 'short_circuited', 'impossible_when predicate satisfied')) {
        applyPhaseEffects(beat, record, 'on_short_circuit', beat.on_short_circuit);
      }
    }
  }

  // (2) until on live/eligible -> resolved/adapted
  for (const beat of orderedBeats) {
    const record = getOwnRecord(nextLedger.records, beat.id);
    if (!record || (record.status !== 'live' && record.status !== 'eligible')) {
      continue;
    }
    if (!beat.until) {
      continue;
    }
    if (evalPredicateNow(beat.until)) {
      const target: BeatStatus = record.adapted ? 'adapted' : 'resolved';
      const reason = record.adapted
        ? 'until predicate satisfied (adapted)'
        : 'until predicate satisfied';
      if (transitionBeat(beat, record, target, reason)) {
        applyPhaseEffects(beat, record, 'on_resolve', beat.on_resolve);
      }
    }
  }

  // (3) pressure-scaled deadline -> on_deadline + escalate/defer/close
  for (const beat of orderedBeats) {
    const record = getOwnRecord(nextLedger.records, beat.id);
    if (!record || isTerminalBeatStatus(record.status) || record.deadlineFired) {
      continue;
    }
    if (!isBeatDirtyOrActive(beat.id, record.status) || !beat.deadline) {
      continue;
    }
    const scaledDeadline = scalePredicateForBeatPressure(beat.deadline, beatPressure);
    if (scaledDeadline === null) {
      continue;
    }
    if (evalPredicateNow(scaledDeadline)) {
      record.deadlineFired = true;
      applyPhaseEffects(beat, record, 'on_deadline', beat.on_deadline);
      const policy = beat.deadlinePolicy ?? 'defer';
      if (policy === 'defer') {
        transitionBeat(beat, record, 'deferred', 'deadline reached (policy: defer)');
      } else if (policy === 'close') {
        transitionBeat(beat, record, 'closed', 'deadline reached (policy: close)');
      }
    }
  }

  // (4) eligibility loss on live -> dormant + on_abort
  for (const beat of orderedBeats) {
    const record = getOwnRecord(nextLedger.records, beat.id);
    if (!record || record.status !== 'live') {
      continue;
    }
    const requiresOk = areRequiresSatisfied(beat, statusMap);
    const whenOk = evalPredicateNow(beat.when);
    if (!requiresOk || !whenOk) {
      if (transitionBeat(beat, record, 'dormant', 'eligibility lost while live')) {
        applyPhaseEffects(beat, record, 'on_abort', beat.on_abort);
      }
    }
  }

  // (5) requires + when + bindBeatRoles (strict missing role -> short_circuited)
  for (const beat of orderedBeats) {
    const record = getOwnRecord(nextLedger.records, beat.id);
    if (!record || isTerminalBeatStatus(record.status) || record.status === 'deferred') {
      continue;
    }
    if (!isBeatDirtyOrActive(beat.id, record.status)) {
      continue;
    }

    const requiresOk = areRequiresSatisfied(beat, statusMap);
    const whenOk = requiresOk ? evalPredicateNow(beat.when) : false;

    if (!requiresOk || !whenOk) {
      if (record.status === 'eligible') {
        transitionBeat(beat, record, 'dormant', 'eligibility lost before activation');
      }
      continue;
    }

    const flexibility = beat.flexibility ?? 'adaptable';
    if (record.status === 'live') {
      if (flexibility === 'strict' && beat.roles) {
        const bindCheck = bindBeatRoles(beat.roles, currentState, { allowFallback: false });
        if (!bindCheck.ok) {
          const reason = `missing strict role "${bindCheck.missingStrictRole ?? ''}"`;
          if (transitionBeat(beat, record, 'short_circuited', reason)) {
            applyPhaseEffects(beat, record, 'on_short_circuit', beat.on_short_circuit);
          }
        }
      }
      continue;
    }

    // record.status is 'dormant' or 'eligible'
    const bindRes = bindBeatRoles(beat.roles, currentState, {
      allowFallback: flexibility !== 'strict',
    });

    if (!bindRes.ok) {
      if (flexibility === 'strict') {
        const reason = `missing strict role "${bindRes.missingStrictRole ?? ''}"`;
        if (transitionBeat(beat, record, 'short_circuited', reason)) {
          applyPhaseEffects(beat, record, 'on_short_circuit', beat.on_short_circuit);
        }
      } else if (record.status === 'eligible') {
        transitionBeat(beat, record, 'dormant', 'required adaptable role unavailable');
      }
      continue;
    }

    record.boundRoles = bindRes.bindings;
    record.adapted = Object.values(bindRes.bindings).some((b) => b.adapted);

    if (record.status === 'dormant') {
      transitionBeat(beat, record, 'eligible', 'requires, when, and role bindings satisfied');
    }
  }

  // (6) priority desc + lexicographic id selection (BR-3):
  //     0..1 gate, 0..N nudges, 0..N ambient, firing on_entry atomically via applyPatchBatch
  const eligibleOrLiveGates: BeatDefinition[] = [];
  const eligibleOrLiveNudges: BeatDefinition[] = [];
  const eligibleOrLiveAmbient: BeatDefinition[] = [];

  for (const beat of orderedBeats) {
    const record = getOwnRecord(nextLedger.records, beat.id);
    if (!record || (record.status !== 'eligible' && record.status !== 'live')) {
      continue;
    }
    if (beat.class === 'gate') {
      eligibleOrLiveGates.push(beat);
    } else if (beat.class === 'nudge') {
      eligibleOrLiveNudges.push(beat);
    } else if (beat.class === 'ambient') {
      eligibleOrLiveAmbient.push(beat);
    }
  }

  const liveNudges: LiveNudgeEntry[] = [];
  const activeAmbient: ActiveAmbientEntry[] = [];

  // Select 0..1 gate
  const selectedGate = eligibleOrLiveGates[0];
  for (let i = 1; i < eligibleOrLiveGates.length; i += 1) {
    const preempted = eligibleOrLiveGates[i];
    if (!preempted) continue;
    const preemptedRec = getOwnRecord(nextLedger.records, preempted.id);
    if (preemptedRec && preemptedRec.status === 'live') {
      transitionBeat(preempted, preemptedRec, 'eligible', 'preempted by higher-priority gate');
    }
  }

  if (selectedGate) {
    const gateRec = getOwnRecord(nextLedger.records, selectedGate.id);
    if (gateRec) {
      nextLedger.liveGateId = selectedGate.id;
      if (gateRec.status !== 'live') {
        transitionBeat(selectedGate, gateRec, 'live', 'selected as active gate');
      }
      if (!gateRec.entryEffectsFired) {
        gateRec.entryEffectsFired = true;
        applyPhaseEffects(selectedGate, gateRec, 'on_entry', selectedGate.on_entry);
      }
      if (selectedGate.nudge !== undefined && selectedGate.nudge.length > 0) {
        liveNudges.push({
          beatId: selectedGate.id,
          class: 'gate',
          text: interpolateBeatTemplate(selectedGate.nudge, gateRec.boundRoles),
        });
      }
    }
  } else {
    nextLedger.liveGateId = null;
  }

  // Select 0..N nudges
  const nextLiveNudgeIds: string[] = [];
  for (const nudgeBeat of eligibleOrLiveNudges) {
    const nudgeRec = getOwnRecord(nextLedger.records, nudgeBeat.id);
    if (!nudgeRec) continue;
    nextLiveNudgeIds.push(nudgeBeat.id);
    if (nudgeRec.status !== 'live') {
      transitionBeat(nudgeBeat, nudgeRec, 'live', 'selected as active nudge');
    }
    if (!nudgeRec.entryEffectsFired) {
      nudgeRec.entryEffectsFired = true;
      applyPhaseEffects(nudgeBeat, nudgeRec, 'on_entry', nudgeBeat.on_entry);
    }
    if (nudgeBeat.nudge !== undefined && nudgeBeat.nudge.length > 0) {
      liveNudges.push({
        beatId: nudgeBeat.id,
        class: 'nudge',
        text: interpolateBeatTemplate(nudgeBeat.nudge, nudgeRec.boundRoles),
      });
    }
  }
  nextLedger.liveNudgeIds = nextLiveNudgeIds;

  // Select 0..N ambient
  const nextActiveAmbientIds: string[] = [];
  for (const ambientBeat of eligibleOrLiveAmbient) {
    const ambientRec = getOwnRecord(nextLedger.records, ambientBeat.id);
    if (!ambientRec) continue;
    nextActiveAmbientIds.push(ambientBeat.id);
    if (ambientRec.status !== 'live') {
      transitionBeat(ambientBeat, ambientRec, 'live', 'selected as active ambient');
    }
    if (!ambientRec.entryEffectsFired) {
      ambientRec.entryEffectsFired = true;
      applyPhaseEffects(ambientBeat, ambientRec, 'on_entry', ambientBeat.on_entry);
    }
    const entry: ActiveAmbientEntry = {
      beatId: ambientBeat.id,
      ...(ambientBeat.lore !== undefined
        ? { lore: interpolateBeatTemplate(ambientBeat.lore, ambientRec.boundRoles) }
        : {}),
      ...(ambientBeat.nudge !== undefined
        ? { nudge: interpolateBeatTemplate(ambientBeat.nudge, ambientRec.boundRoles) }
        : {}),
    };
    activeAmbient.push(entry);
  }
  nextLedger.activeAmbientIds = nextActiveAmbientIds;

  return {
    nextState: currentState,
    nextLedger,
    transitions,
    triggeredScripts,
    injectedLorePaths,
    liveNudges,
    activeAmbient,
    auditEntries,
    changedPaths,
    warnings,
  };
}

/**
 * Director Steering Bar manual beat override (`source: 'user_director'`).
 * Enforces BR-9 monotonicity via {@link canTransitionBeat}.
 */
export function forceBeatTransition(
  ledger: BeatLedgerState,
  state: WorldState,
  beatId: string,
  targetStatus: ForcedBeatStatus,
  options: ForceBeatTransitionOptions = {}
): Result<ForceBeatTransitionResult, ValidationError[]> {
  if (typeof beatId !== 'string' || beatId.trim().length === 0 || isUnsafePropertyKey(beatId)) {
    return err([validationError('beatId', 'INVALID_BEAT_ID', 'Invalid or unsafe beatId')]);
  }
  if (!VALID_FORCED_STATUSES.has(targetStatus)) {
    return err([
      validationError(
        'targetStatus',
        'INVALID_BEAT_STATUS',
        `Director forced targetStatus must be resolved, deferred, or short_circuited (got "${String(targetStatus)}")`
      ),
    ]);
  }

  const existingRecord = getOwnRecord(ledger.records, beatId);
  if (!existingRecord) {
    return err([
      validationError('beatId', 'BEAT_NOT_FOUND', `Beat "${beatId}" does not exist in ledger`),
    ]);
  }

  const fromStatus = existingRecord.status;
  if (!canTransitionBeat(fromStatus, targetStatus)) {
    return err([
      validationError(
        'targetStatus',
        'ILLEGAL_BEAT_TRANSITION',
        `Cannot transition terminal beat "${beatId}" from "${fromStatus}" to "${targetStatus}"`
      ),
    ]);
  }

  const nextLedger = cloneBeatLedger(ledger);
  const nextRecord = getOwnRecord(nextLedger.records, beatId);
  if (!nextRecord) {
    return err([
      validationError('beatId', 'BEAT_NOT_FOUND', `Beat "${beatId}" does not exist in ledger`),
    ]);
  }

  if (fromStatus === targetStatus) {
    return ok({
      nextLedger,
      nextState: state,
      transition: null,
      triggeredScripts: [],
      injectedLorePaths: [],
      auditEntries: [],
      changedPaths: new Set<string>(),
      warnings: [],
    });
  }

  const reason = options.reason ?? `Director override to "${targetStatus}"`;
  nextRecord.status = targetStatus;
  nextRecord.lastTransitionTurn = state.meta.turn;
  clearLiveIdsForBeat(nextLedger, beatId);

  const transition: BeatTransition = {
    beatId,
    from: fromStatus,
    to: targetStatus,
    reason,
  };

  let nextState = state;
  const triggeredScripts: string[] = [];
  const injectedLorePaths: string[] = [];
  const changedPaths = new Set<string>([`beats.${beatId}.status`]);
  const warnings: ValidationError[] = [];
  let nextAuditSeq = options.reducerOptions?.auditSeqStart ?? 1;

  const auditEntries: AuditEntry[] = [
    Object.freeze({
      turn: state.meta.turn,
      storyTurn: state.clocks.storyTurn,
      timestampSeq: nextAuditSeq,
      source: 'user_director',
      eventId: `director:beat:${beatId}:${targetStatus}:t${state.meta.turn}`,
      op: 'beat_transition',
      path: `beats.${beatId}.status`,
      oldValue: fromStatus,
      newValue: targetStatus,
      status: 'committed',
      reason,
    }),
  ];
  nextAuditSeq += 1;

  const beatDef = options.beats?.find((b) => b.id === beatId);
  const effectsToApply =
    beatDef === undefined
      ? undefined
      : targetStatus === 'resolved'
        ? beatDef.on_resolve
        : targetStatus === 'short_circuited'
          ? beatDef.on_short_circuit
          : undefined;

  if (effectsToApply && effectsToApply.length > 0) {
    const ops = compileEffects(
      beatId,
      effectsToApply,
      nextRecord.boundRoles,
      nextState,
      triggeredScripts,
      injectedLorePaths
    );
    if (ops.length > 0) {
      const batchRes = applyPatchBatch(
        nextState,
        {
          eventId: `director:beat:${beatId}:${targetStatus}:t${state.meta.turn}:effects`,
          source: 'user_director',
          operations: ops,
          reason,
        },
        {
          ...options.reducerOptions,
          auditSeqStart: nextAuditSeq,
        }
      );
      if (!batchRes.ok) {
        for (const e of batchRes.error) {
          warnings.push(e);
        }
      } else {
        nextState = batchRes.value.nextState;
        auditEntries.push(...batchRes.value.auditEntries);
        for (const p of batchRes.value.changedPaths) {
          changedPaths.add(p);
        }
      }
    }
  }

  return ok({
    nextLedger,
    nextState,
    transition,
    triggeredScripts,
    injectedLorePaths,
    auditEntries,
    changedPaths,
    warnings,
  });
}
