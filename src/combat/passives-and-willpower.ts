import { RefereeError } from '../core/errors.js';
import type { SkillEffectSpec } from './skill-registry.js';

export const PASSIVE_TRIGGER_HOOKS = Object.freeze([
  'on_turn_start',
  'on_hit',
  'on_damaged',
  'on_kill',
  'on_ally_down',
] as const);

export type PassiveTriggerHook = (typeof PASSIVE_TRIGGER_HOOKS)[number];

/**
 * Optional activation thresholds evaluated against the passive owner's current stats.
 */
export interface PassiveCondition {
  readonly minWillpower?: number;
  /** Maximum HP percentage on a 0–100 scale (e.g. `50` requires HP <= 50% of maxHp). */
  readonly maxHpPercent?: number;
}

/**
 * Declarative definition of a passive ability or reactive trigger.
 */
export interface PassiveDefinition {
  readonly id: string;
  readonly name: string;
  readonly hook: PassiveTriggerHook;
  readonly priority: number;
  readonly maxTriggersPerTurn?: number;
  readonly condition?: PassiveCondition;
  readonly effect: SkillEffectSpec;
}

/**
 * Actor combat stats checked by passive trigger conditions.
 */
export interface PassiveActorStats {
  readonly hp: number;
  readonly maxHp: number;
  readonly willpower: number;
}

/**
 * Parameters passed to {@link evaluatePassiveHooks}.
 */
export interface EvaluatePassiveHooksParams {
  readonly hook: PassiveTriggerHook;
  readonly passives: readonly PassiveDefinition[];
  readonly triggerCountsThisTurn: Record<string, number>;
  readonly recursionDepth: number;
  /** Maximum inclusive recursion depth allowed before halting chained triggers (default: `2`). */
  readonly maxRecursionDepth?: number;
  readonly actorStats: PassiveActorStats;
}

/**
 * Result returned by {@link evaluatePassiveHooks}.
 */
export interface EvaluatePassiveHooksResult {
  readonly triggered: PassiveDefinition[];
  readonly nextTriggerCounts: Record<string, number>;
}

/**
 * Result returned by {@link adjustWillpower}.
 */
export interface AdjustWillpowerResult {
  readonly next: number;
  readonly thresholdCrossed: 'shattered' | 'surging' | null;
}

export const DEFAULT_MAX_PASSIVE_RECURSION_DEPTH = 2;

export const WILLPOWER_BREAK_OUTCOMES = Object.freeze([
  'defeat',
  'flee',
  'surrender',
  'incapacitate',
  'switch_side',
] as const);

export type WillpowerBreakOutcome = (typeof WILLPOWER_BREAK_OUTCOMES)[number];

const VALID_WILLPOWER_OUTCOMES: ReadonlySet<string> = new Set(WILLPOWER_BREAK_OUTCOMES);

/**
 * Result of resolving a willpower-break outcome policy against a combatant.
 */
export interface WillpowerBreakResolution {
  readonly outcome: WillpowerBreakOutcome;
  readonly alive: boolean;
  readonly team: 'ally' | 'enemy' | 'neutral';
  readonly hp: number;
  readonly willpower: number;
  readonly removedFromCombat: boolean;
  readonly appliedStatusId: string | null;
}

/**
 * Returns `true` when an unmodified d20 roll is a natural 20 (critical roll).
 */
export function isCriticalNaturalRoll(d20: number): boolean {
  return d20 === 20;
}

/**
 * Returns `true` when an unmodified d20 roll is a natural 1 (fumble roll).
 */
export function isFumbleNaturalRoll(d20: number): boolean {
  return d20 === 1;
}

/**
 * Purely resolve a combatant's willpower-break outcome policy into updated alive/team/status state.
 */
export function resolveWillpowerBreak(
  combatant: {
    readonly alive: boolean;
    readonly team: 'ally' | 'enemy' | 'neutral';
    readonly hp: number;
    readonly willpower: number;
  },
  outcomePolicy: WillpowerBreakOutcome
): WillpowerBreakResolution {
  if (typeof outcomePolicy !== 'string' || !VALID_WILLPOWER_OUTCOMES.has(outcomePolicy)) {
    throw new RefereeError(`Invalid willpower break outcome policy "${String(outcomePolicy)}"`, {
      code: 'INVALID_WILLPOWER_OUTCOME',
      details: { outcomePolicy },
    });
  }

  const safeHp = Number.isFinite(combatant.hp) && combatant.hp > 0 ? combatant.hp : 0;

  switch (outcomePolicy) {
    case 'defeat':
      return {
        outcome: 'defeat',
        alive: false,
        team: combatant.team,
        hp: 0,
        willpower: 0,
        removedFromCombat: true,
        appliedStatusId: 'defeated',
      };
    case 'flee':
      return {
        outcome: 'flee',
        alive: combatant.alive,
        team: combatant.team,
        hp: safeHp === 0 ? 0 : safeHp,
        willpower: 0,
        removedFromCombat: true,
        appliedStatusId: 'fled',
      };
    case 'surrender':
      return {
        outcome: 'surrender',
        alive: combatant.alive,
        team: 'neutral',
        hp: safeHp === 0 ? 0 : safeHp,
        willpower: 0,
        removedFromCombat: true,
        appliedStatusId: 'surrendered',
      };
    case 'incapacitate':
      return {
        outcome: 'incapacitate',
        alive: combatant.alive,
        team: combatant.team,
        hp: safeHp === 0 ? 0 : safeHp,
        willpower: 0,
        removedFromCombat: false,
        appliedStatusId: 'incapacitated',
      };
    case 'switch_side':
      return {
        outcome: 'switch_side',
        alive: combatant.alive,
        team:
          combatant.team === 'ally'
            ? 'enemy'
            : combatant.team === 'enemy'
              ? 'ally'
              : 'neutral',
        hp: safeHp === 0 ? 0 : safeHp,
        willpower: 0,
        removedFromCombat: false,
        appliedStatusId: 'charmed',
      };
  }
}

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

function isSafeKey(key: string): boolean {
  return key.length > 0 && !FORBIDDEN_KEYS.has(key);
}

function getOwnCount(record: Record<string, number>, key: string): number {
  if (!isSafeKey(key) || !Object.hasOwn(record, key)) {
    return 0;
  }
  const value = Object.getOwnPropertyDescriptor(record, key)?.value;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function setOwnCount(record: Record<string, number>, key: string, value: number): void {
  Object.defineProperty(record, key, {
    value: value === 0 ? 0 : value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function cloneTriggerCounts(counts: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of Object.keys(counts)) {
    if (isSafeKey(key) && Object.hasOwn(counts, key)) {
      const value = getOwnCount(counts, key);
      setOwnCount(out, key, value);
    }
  }
  return out;
}

function clonePassive(passive: PassiveDefinition): PassiveDefinition {
  return {
    id: passive.id,
    name: passive.name,
    hook: passive.hook,
    priority: passive.priority,
    ...(passive.maxTriggersPerTurn !== undefined
      ? { maxTriggersPerTurn: passive.maxTriggersPerTurn }
      : {}),
    ...(passive.condition !== undefined
      ? {
          condition: {
            ...(passive.condition.minWillpower !== undefined
              ? { minWillpower: passive.condition.minWillpower }
              : {}),
            ...(passive.condition.maxHpPercent !== undefined
              ? { maxHpPercent: passive.condition.maxHpPercent }
              : {}),
          },
        }
      : {}),
    effect: { ...passive.effect },
  };
}

function meetsCondition(
  condition: PassiveCondition | undefined,
  actorStats: PassiveActorStats
): boolean {
  if (condition === undefined) {
    return true;
  }
  if (condition.minWillpower !== undefined && actorStats.willpower < condition.minWillpower) {
    return false;
  }
  if (condition.maxHpPercent !== undefined) {
    const hpPercent =
      actorStats.maxHp > 0 ? (Math.max(0, actorStats.hp) / actorStats.maxHp) * 100 : 0;
    if (hpPercent > condition.maxHpPercent) {
      return false;
    }
  }
  return true;
}

/**
 * Evaluate which passive definitions trigger for a given combat hook while enforcing
 * both a strict recursion depth cap (defaulting to `<= 2`) and per-turn trigger caps
 * to prevent infinite reactive loops.
 */
export function evaluatePassiveHooks(
  params: EvaluatePassiveHooksParams
): EvaluatePassiveHooksResult {
  const nextTriggerCounts = cloneTriggerCounts(params.triggerCountsThisTurn);
  const maxDepth =
    params.maxRecursionDepth !== undefined && Number.isFinite(params.maxRecursionDepth)
      ? Math.max(0, params.maxRecursionDepth)
      : DEFAULT_MAX_PASSIVE_RECURSION_DEPTH;

  if (
    !Number.isFinite(params.recursionDepth) ||
    params.recursionDepth < 0 ||
    params.recursionDepth > maxDepth
  ) {
    return {
      triggered: [],
      nextTriggerCounts,
    };
  }

  const candidates = params.passives
    .filter((passive) => isSafeKey(passive.id) && passive.hook === params.hook)
    .sort((a, b) => b.priority - a.priority);

  const triggered: PassiveDefinition[] = [];

  for (const passive of candidates) {
    const countThisTurn = getOwnCount(nextTriggerCounts, passive.id);
    if (
      passive.maxTriggersPerTurn !== undefined &&
      countThisTurn >= Math.max(0, passive.maxTriggersPerTurn)
    ) {
      continue;
    }

    if (!meetsCondition(passive.condition, params.actorStats)) {
      continue;
    }

    setOwnCount(nextTriggerCounts, passive.id, countThisTurn + 1);
    triggered.push(clonePassive(passive));
  }

  return {
    triggered,
    nextTriggerCounts,
  };
}

/**
 * Purely adjust an actor's willpower within `[0, max]` and detect threshold crossings
 * (`'shattered'` when dropping to `0`, `'surging'` when reaching `max`).
 */
export function adjustWillpower(
  current: number,
  max: number,
  delta: number
): AdjustWillpowerResult {
  if (!Number.isFinite(current) || !Number.isFinite(max) || !Number.isFinite(delta)) {
    throw new RefereeError('adjustWillpower arguments must all be finite numbers', {
      code: 'INVALID_WILLPOWER_ARGS',
      details: { current, max, delta },
    });
  }

  const safeMax = Math.max(0, max);
  const clampedCurrent = Math.max(0, Math.min(safeMax, current));
  const rawNext = clampedCurrent + delta;
  const clampedNext = Math.max(0, Math.min(safeMax, rawNext));
  const next = clampedNext === 0 ? 0 : clampedNext;

  let thresholdCrossed: 'shattered' | 'surging' | null = null;
  if (safeMax > 0) {
    if (clampedCurrent > 0 && next === 0) {
      thresholdCrossed = 'shattered';
    } else if (clampedCurrent < safeMax && next === safeMax) {
      thresholdCrossed = 'surging';
    }
  }

  return {
    next,
    thresholdCrossed,
  };
}
