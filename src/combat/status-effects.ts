import { rollDice } from '../core/dice.js';
import { RefereeError, formatValidationErrors } from '../core/errors.js';
import type { RngState } from '../core/prng.js';

export const STATUS_STACK_POLICIES = Object.freeze([
  'refresh',
  'stack_intensity',
  'ignore',
] as const);

export type StatusStackPolicy = (typeof STATUS_STACK_POLICIES)[number];

export type StatusTickTiming = 'turn_start' | 'turn_end';

/**
 * Runtime instance of an active status effect attached to a combatant.
 */
export interface ActiveStatusEffect {
  readonly id: string;
  readonly name: string;
  readonly remainingTurns: number;
  readonly intensity: number;
  readonly stackPolicy: StatusStackPolicy;
  readonly tickTiming: StatusTickTiming;
  readonly damageDice?: string;
  readonly healDice?: string;
  readonly stun?: boolean;
  readonly root?: boolean;
  readonly statModifiers?: Record<string, number>;
}

/**
 * Deterministic result of ticking active status effects for a turn boundary.
 */
export interface TickStatusEffectsResult {
  readonly statuses: ActiveStatusEffect[];
  readonly tickDamageTotal: number;
  readonly tickHealingTotal: number;
  readonly isStunned: boolean;
  readonly isRooted: boolean;
  readonly expiredIds: string[];
  readonly nextRng: RngState;
}

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

function isSafeKey(key: string): boolean {
  return key.length > 0 && !FORBIDDEN_KEYS.has(key);
}

function setOwnNumber(record: Record<string, number>, key: string, value: number): void {
  Object.defineProperty(record, key, {
    value: value === 0 ? 0 : value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function cloneStatModifiers(
  modifiers: Record<string, number> | undefined
): Record<string, number> | undefined {
  if (modifiers === undefined) {
    return undefined;
  }
  const cloned: Record<string, number> = {};
  for (const key of Object.keys(modifiers)) {
    if (isSafeKey(key) && Object.hasOwn(modifiers, key)) {
      const value = modifiers[key];
      if (typeof value === 'number' && Number.isFinite(value)) {
        setOwnNumber(cloned, key, value);
      }
    }
  }
  return cloned;
}

function cloneStatusEffect(effect: ActiveStatusEffect): ActiveStatusEffect {
  const clonedStatModifiers = cloneStatModifiers(effect.statModifiers);
  return {
    id: effect.id,
    name: effect.name,
    remainingTurns: effect.remainingTurns === 0 ? 0 : effect.remainingTurns,
    intensity: effect.intensity === 0 ? 0 : effect.intensity,
    stackPolicy: effect.stackPolicy,
    tickTiming: effect.tickTiming,
    ...(effect.damageDice !== undefined ? { damageDice: effect.damageDice } : {}),
    ...(effect.healDice !== undefined ? { healDice: effect.healDice } : {}),
    ...(effect.stun !== undefined ? { stun: effect.stun } : {}),
    ...(effect.root !== undefined ? { root: effect.root } : {}),
    ...(clonedStatModifiers !== undefined ? { statModifiers: clonedStatModifiers } : {}),
  };
}

/**
 * Purely apply or stack a status effect onto an existing list of active status effects
 * according to the status effect's {@link StatusStackPolicy}.
 */
export function applyStatusEffect(
  statuses: readonly ActiveStatusEffect[],
  newStatus: ActiveStatusEffect
): ActiveStatusEffect[] {
  if (!isSafeKey(newStatus.id)) {
    throw new RefereeError(`Invalid or forbidden status id "${newStatus.id}"`, {
      code: 'INVALID_STATUS_ID',
    });
  }

  const nextStatuses = statuses.map(cloneStatusEffect);
  if (!Number.isFinite(newStatus.remainingTurns) || newStatus.remainingTurns <= 0) {
    return nextStatuses;
  }

  const safeNewIntensity =
    Number.isFinite(newStatus.intensity) && newStatus.intensity > 0 ? newStatus.intensity : 0;

  const existingIndex = nextStatuses.findIndex((status) => status.id === newStatus.id);
  if (existingIndex === -1) {
    const clonedNew = cloneStatusEffect({
      ...newStatus,
      intensity: safeNewIntensity,
    });
    nextStatuses.push(clonedNew);
    return nextStatuses;
  }

  const existing = nextStatuses[existingIndex];
  if (existing === undefined) {
    return nextStatuses;
  }

  const safeExistingIntensity =
    Number.isFinite(existing.intensity) && existing.intensity > 0 ? existing.intensity : 0;

  switch (existing.stackPolicy) {
    case 'ignore': {
      return nextStatuses;
    }
    case 'refresh': {
      nextStatuses[existingIndex] = {
        ...existing,
        remainingTurns: Math.max(existing.remainingTurns, newStatus.remainingTurns),
        intensity: Math.max(safeExistingIntensity, safeNewIntensity),
      };
      return nextStatuses;
    }
    case 'stack_intensity': {
      nextStatuses[existingIndex] = {
        ...existing,
        remainingTurns: Math.max(existing.remainingTurns, newStatus.remainingTurns),
        intensity: safeExistingIntensity + safeNewIntensity,
      };
      return nextStatuses;
    }
  }
}

/**
 * Purely tick active status effects matching `timing` (`'turn_start'` or `'turn_end'`),
 * computing deterministic tick damage and healing, decrementing durations, expiring
 * 0-turn effects, and reporting active stun/root flags.
 */
export function tickStatusEffects(
  statuses: readonly ActiveStatusEffect[],
  timing: StatusTickTiming,
  rng: RngState
): TickStatusEffectsResult {
  let currentRng = rng;
  let tickDamageTotal = 0;
  let tickHealingTotal = 0;
  let isStunned = false;
  let isRooted = false;
  const surviving: ActiveStatusEffect[] = [];
  const expiredIds: string[] = [];

  for (const rawStatus of statuses) {
    const status = cloneStatusEffect(rawStatus);

    if (status.tickTiming !== timing) {
      if (status.remainingTurns > 0) {
        if (status.stun === true) {
          isStunned = true;
        }
        if (status.root === true) {
          isRooted = true;
        }
        surviving.push(status);
      } else {
        expiredIds.push(status.id);
      }
      continue;
    }

    const effectiveIntensity =
      Number.isFinite(status.intensity) && status.intensity > 0 ? status.intensity : 0;

    if (status.damageDice !== undefined && status.remainingTurns > 0 && effectiveIntensity > 0) {
      const rollRes = rollDice(status.damageDice, currentRng);
      if (!rollRes.ok) {
        throw new RefereeError(
          `Invalid damageDice "${status.damageDice}" on status "${status.id}": ${formatValidationErrors(rollRes.error)}`,
          { code: 'INVALID_STATUS_DICE', details: rollRes.error }
        );
      }
      currentRng = rollRes.value.nextState;
      const rolled = Math.max(0, rollRes.value.total);
      tickDamageTotal += Math.round(rolled * effectiveIntensity);
    }

    if (status.healDice !== undefined && status.remainingTurns > 0 && effectiveIntensity > 0) {
      const rollRes = rollDice(status.healDice, currentRng);
      if (!rollRes.ok) {
        throw new RefereeError(
          `Invalid healDice "${status.healDice}" on status "${status.id}": ${formatValidationErrors(rollRes.error)}`,
          { code: 'INVALID_STATUS_DICE', details: rollRes.error }
        );
      }
      currentRng = rollRes.value.nextState;
      const rolled = Math.max(0, rollRes.value.total);
      tickHealingTotal += Math.round(rolled * effectiveIntensity);
    }

    const nextRemainingTurns = Math.max(0, status.remainingTurns - 1);
    if (nextRemainingTurns <= 0) {
      expiredIds.push(status.id);
      continue;
    }

    if (status.stun === true) {
      isStunned = true;
    }
    if (status.root === true) {
      isRooted = true;
    }

    surviving.push({
      ...status,
      remainingTurns: nextRemainingTurns,
    });
  }

  return {
    statuses: surviving,
    tickDamageTotal,
    tickHealingTotal,
    isStunned,
    isRooted,
    expiredIds,
    nextRng: currentRng,
  };
}
