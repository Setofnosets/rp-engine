import { type ValidationError, validationError } from '../core/errors.js';
import { ErrorAccumulator, type Result, err, ok } from '../core/result.js';
import type { EntityCollectionName, PatchOperation } from '../state/patch.js';
import type { ChronicleCategory } from '../state/world-state.js';
import {
  BEAT_STATUSES,
  type BeatStatus,
  type PredicateAst,
  isUnsafePropertyKey,
  validatePredicateAst,
} from './predicate-ast.js';
import type { BeatRoleSpec, BoundRoleResult } from './role-binder.js';

export const BEAT_CLASSES = Object.freeze(['gate', 'nudge', 'ambient'] as const);
export type BeatClass = (typeof BEAT_CLASSES)[number];

export const BEAT_FLEXIBILITIES = Object.freeze(['strict', 'adaptable', 'optional'] as const);
export type BeatFlexibility = (typeof BEAT_FLEXIBILITIES)[number];

export const DEADLINE_POLICIES = Object.freeze(['escalate', 'defer', 'close'] as const);
export type DeadlinePolicy = (typeof DEADLINE_POLICIES)[number];

export const REQUIRES_POLICIES = Object.freeze(['terminal_completed', 'any_terminal'] as const);
export type RequiresPolicy = (typeof REQUIRES_POLICIES)[number];

export type BeatEffect =
  | { readonly set: Record<string, unknown> }
  | { readonly increment: Record<string, number> }
  | {
      readonly entity_patch: {
        readonly collection: EntityCollectionName;
        readonly entityId: string;
        readonly patch: Record<string, unknown>;
      };
    }
  | {
      readonly chronicle: {
        readonly category: ChronicleCategory;
        readonly title: string;
        readonly summary: string;
      };
    }
  | { readonly inject: string }
  | { readonly script: string }
  | PatchOperation;

export interface BeatDefinition {
  readonly id: string;
  readonly act?: string;
  readonly class: BeatClass;
  readonly flexibility?: BeatFlexibility;
  readonly priority: number;
  readonly route?: string;
  readonly requires?: readonly string[];
  readonly requiresPolicy?: RequiresPolicy;
  readonly roles?: Record<string, BeatRoleSpec>;
  readonly when: PredicateAst;
  readonly until?: PredicateAst;
  readonly impossible_when?: PredicateAst;
  readonly deadline?: PredicateAst;
  readonly deadlinePolicy?: DeadlinePolicy;
  readonly on_entry?: readonly BeatEffect[];
  readonly on_resolve?: readonly BeatEffect[];
  readonly on_deadline?: readonly BeatEffect[];
  readonly on_short_circuit?: readonly BeatEffect[];
  readonly on_abort?: readonly BeatEffect[];
  readonly nudge?: string;
  readonly lore?: string;
  readonly once?: boolean;
}

export interface BeatRuntimeRecord {
  id: string;
  status: BeatStatus;
  boundRoles: Record<string, BoundRoleResult>;
  adapted: boolean;
  deadlineFired: boolean;
  entryEffectsFired: boolean;
  lastTransitionTurn: number;
}

export interface BeatLedgerState {
  records: Record<string, BeatRuntimeRecord>;
  liveGateId: string | null;
  liveNudgeIds: string[];
  activeAmbientIds: string[];
}

export const TERMINAL_BEAT_STATUSES = Object.freeze([
  'resolved',
  'adapted',
  'short_circuited',
  'closed',
] as const);

const TERMINAL_STATUS_SET: ReadonlySet<string> = new Set(TERMINAL_BEAT_STATUSES);
const VALID_BEAT_STATUS_SET: ReadonlySet<string> = new Set(BEAT_STATUSES);
const VALID_BEAT_CLASSES: ReadonlySet<string> = new Set(BEAT_CLASSES);
const VALID_BEAT_FLEXIBILITIES: ReadonlySet<string> = new Set(BEAT_FLEXIBILITIES);
const VALID_DEADLINE_POLICIES: ReadonlySet<string> = new Set(DEADLINE_POLICIES);
const VALID_REQUIRES_POLICIES: ReadonlySet<string> = new Set(REQUIRES_POLICIES);

const ALLOWED_TRANSITIONS: Readonly<Record<BeatStatus, readonly BeatStatus[]>> = Object.freeze({
  dormant: Object.freeze([
    'eligible',
    'deferred',
    'resolved',
    'adapted',
    'short_circuited',
    'closed',
  ] as const),
  eligible: Object.freeze([
    'dormant',
    'live',
    'deferred',
    'resolved',
    'adapted',
    'short_circuited',
    'closed',
  ] as const),
  live: Object.freeze([
    'dormant',
    'eligible',
    'deferred',
    'resolved',
    'adapted',
    'short_circuited',
    'closed',
  ] as const),
  deferred: Object.freeze([
    'dormant',
    'eligible',
    'live',
    'resolved',
    'adapted',
    'short_circuited',
    'closed',
  ] as const),
  resolved: Object.freeze([] as const),
  adapted: Object.freeze([] as const),
  short_circuited: Object.freeze([] as const),
  closed: Object.freeze([] as const),
});

/**
 * Returns `true` when `status` is one of the terminal beat statuses
 * (`resolved`, `adapted`, `short_circuited`, `closed`).
 */
export function isTerminalBeatStatus(status: BeatStatus): boolean {
  return TERMINAL_STATUS_SET.has(status);
}

/**
 * Monotonic beat transition guard (BR-9): once a beat reaches a terminal status,
 * it never reopens or transitions to another status.
 */
export function canTransitionBeat(from: BeatStatus, to: BeatStatus): boolean {
  if (!VALID_BEAT_STATUS_SET.has(from) || !VALID_BEAT_STATUS_SET.has(to)) {
    return false;
  }
  if (from === to) {
    return true;
  }
  if (TERMINAL_STATUS_SET.has(from)) {
    return false;
  }
  if (!Object.hasOwn(ALLOWED_TRANSITIONS, from)) {
    return false;
  }
  const desc = Object.getOwnPropertyDescriptor(ALLOWED_TRANSITIONS, from);
  const allowed = desc?.value as readonly BeatStatus[] | undefined;
  return allowed !== undefined && allowed.includes(to);
}

export function cloneBoundRoles(
  boundRoles: Readonly<Record<string, BoundRoleResult>>
): Record<string, BoundRoleResult> {
  const cloned: Record<string, BoundRoleResult> = {};
  for (const key of Object.keys(boundRoles)) {
    if (isUnsafePropertyKey(key)) {
      continue;
    }
    const desc = Object.getOwnPropertyDescriptor(boundRoles, key);
    const val = desc?.value as BoundRoleResult | undefined;
    if (!val) {
      continue;
    }
    Object.defineProperty(cloned, key, {
      value: {
        roleKey: val.roleKey,
        entityId: val.entityId,
        displayName: val.displayName,
        adapted: val.adapted,
        ...(val.adaptedFrom !== undefined ? { adaptedFrom: val.adaptedFrom } : {}),
        ...(val.adaptedTo !== undefined ? { adaptedTo: val.adaptedTo } : {}),
      },
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return cloned;
}

export function cloneBeatRuntimeRecord(
  record: Readonly<BeatRuntimeRecord>
): BeatRuntimeRecord {
  return {
    id: record.id,
    status: record.status,
    boundRoles: cloneBoundRoles(record.boundRoles),
    adapted: record.adapted,
    deadlineFired: record.deadlineFired,
    entryEffectsFired: record.entryEffectsFired,
    lastTransitionTurn: record.lastTransitionTurn,
  };
}

export function cloneBeatLedger(ledger: Readonly<BeatLedgerState>): BeatLedgerState {
  const records: Record<string, BeatRuntimeRecord> = {};
  for (const id of Object.keys(ledger.records)) {
    if (isUnsafePropertyKey(id)) {
      continue;
    }
    const desc = Object.getOwnPropertyDescriptor(ledger.records, id);
    const rec = desc?.value as BeatRuntimeRecord | undefined;
    if (!rec) {
      continue;
    }
    Object.defineProperty(records, id, {
      value: cloneBeatRuntimeRecord(rec),
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return {
    records,
    liveGateId: ledger.liveGateId,
    liveNudgeIds: [...ledger.liveNudgeIds],
    activeAmbientIds: [...ledger.activeAmbientIds],
  };
}

export function createInitialBeatRecord(id: string): BeatRuntimeRecord {
  return {
    id,
    status: 'dormant',
    boundRoles: {},
    adapted: false,
    deadlineFired: false,
    entryEffectsFired: false,
    lastTransitionTurn: 0,
  };
}

/**
 * Create an initial {@link BeatLedgerState} with every beat initialized to `'dormant'`.
 */
export function createInitialBeatLedger(beats: readonly BeatDefinition[]): BeatLedgerState {
  const records: Record<string, BeatRuntimeRecord> = {};
  for (const beat of beats) {
    if (typeof beat.id !== 'string' || beat.id.trim().length === 0 || isUnsafePropertyKey(beat.id)) {
      continue;
    }
    if (!Object.hasOwn(records, beat.id)) {
      Object.defineProperty(records, beat.id, {
        value: createInitialBeatRecord(beat.id),
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
  }
  return {
    records,
    liveGateId: null,
    liveNudgeIds: [],
    activeAmbientIds: [],
  };
}

function validateOptionalPredicate(
  ast: unknown,
  fieldPath: string,
  acc: ErrorAccumulator
): void {
  if (ast === undefined) {
    return;
  }
  acc.scope(fieldPath).absorb(validatePredicateAst(ast));
}

/**
 * Validate a collection of {@link BeatDefinition} entries using {@link ErrorAccumulator}.
 */
export function validateBeatDefinitions(
  beats: readonly BeatDefinition[],
  path = 'beats'
): Result<readonly BeatDefinition[], ValidationError[]> {
  if (!Array.isArray(beats)) {
    return err([validationError(path, 'INVALID_TYPE', 'beats must be an array')]);
  }

  const acc = new ErrorAccumulator(path);
  const seenIds = new Set<string>();

  for (let i = 0; i < beats.length; i += 1) {
    const beat = beats[i];
    const beatAcc = acc.scope(`[${i}]`);
    if (!beat || typeof beat !== 'object') {
      beatAcc.add('', 'INVALID_TYPE', 'BeatDefinition must be an object');
      continue;
    }

    if (typeof beat.id !== 'string' || beat.id.trim().length === 0) {
      beatAcc.add('id', 'REQUIRED', 'beat.id must be a non-empty string');
    } else if (isUnsafePropertyKey(beat.id)) {
      beatAcc.add('id', 'UNSAFE_PROPERTY_KEY', `Unsafe beat.id "${beat.id}"`);
    } else if (seenIds.has(beat.id)) {
      beatAcc.add('id', 'DUPLICATE_ID', `Duplicate beat id "${beat.id}"`);
    } else {
      seenIds.add(beat.id);
    }

    if (!VALID_BEAT_CLASSES.has(beat.class)) {
      beatAcc.add('class', 'INVALID_ENUM', `Invalid beat class "${String(beat.class)}"`);
    }
    if (beat.flexibility !== undefined && !VALID_BEAT_FLEXIBILITIES.has(beat.flexibility)) {
      beatAcc.add(
        'flexibility',
        'INVALID_ENUM',
        `Invalid beat flexibility "${String(beat.flexibility)}"`
      );
    }
    if (typeof beat.priority !== 'number' || !Number.isFinite(beat.priority)) {
      beatAcc.add('priority', 'INVALID_NUMBER', 'beat.priority must be a finite number');
    }
    if (beat.deadlinePolicy !== undefined && !VALID_DEADLINE_POLICIES.has(beat.deadlinePolicy)) {
      beatAcc.add(
        'deadlinePolicy',
        'INVALID_ENUM',
        `Invalid deadlinePolicy "${String(beat.deadlinePolicy)}"`
      );
    }
    if (beat.requiresPolicy !== undefined && !VALID_REQUIRES_POLICIES.has(beat.requiresPolicy)) {
      beatAcc.add(
        'requiresPolicy',
        'INVALID_ENUM',
        `Invalid requiresPolicy "${String(beat.requiresPolicy)}"`
      );
    }

    beatAcc.scope('when').absorb(validatePredicateAst(beat.when));
    validateOptionalPredicate(beat.until, 'until', beatAcc);
    validateOptionalPredicate(beat.impossible_when, 'impossible_when', beatAcc);
    validateOptionalPredicate(beat.deadline, 'deadline', beatAcc);
  }

  for (let i = 0; i < beats.length; i += 1) {
    const beat = beats[i];
    if (!beat || !Array.isArray(beat.requires)) {
      continue;
    }
    for (let j = 0; j < beat.requires.length; j += 1) {
      const reqId = beat.requires[j];
      if (typeof reqId !== 'string' || reqId.trim().length === 0) {
        acc.add(`[${i}].requires[${j}]`, 'INVALID_ID', 'requires entry must be a non-empty string');
      } else if (reqId === beat.id) {
        acc.add(`[${i}].requires[${j}]`, 'SELF_DEPENDENCY', 'A beat cannot require itself');
      } else if (!seenIds.has(reqId)) {
        acc.add(
          `[${i}].requires[${j}]`,
          'UNKNOWN_BEAT_REF',
          `Unknown required beat "${reqId}"`
        );
      }
    }
  }

  if (acc.hasErrors()) {
    return err([...acc.errors]);
  }
  return ok(beats);
}
