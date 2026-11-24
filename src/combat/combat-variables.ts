import { parseDiceNotation } from '../core/dice.js';
import { RefereeError, type ValidationError } from '../core/errors.js';
import { ErrorAccumulator, type Result, err, ok } from '../core/result.js';
import {
  type CombatState,
  type CombatantState,
  areTeamsHostile,
  getOwnNumber,
  getSafeCombatant,
  getSafeCombatantIds,
  isSafeKey,
} from './action-validator.js';
import { chebyshevDistance } from './spatial-math.js';

export const COMBAT_SCALE_VARIABLES = Object.freeze([
  'enemies',
  'allies',
  'outnumbered',
  'adjacentEnemies',
  'adjacentAllies',
  'round',
  'missingHpPct',
  'targetMissingHpPct',
  'level',
  'targetStacks',
] as const);

export type CombatScaleVariable = (typeof COMBAT_SCALE_VARIABLES)[number];

const VALID_SCALE_VARIABLES: ReadonlySet<string> = new Set(COMBAT_SCALE_VARIABLES);
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Declarative scaling rule that adds a bounded variable-derived bonus to a roll or value.
 */
export interface CombatVariableScaleSpec {
  readonly variable: CombatScaleVariable;
  readonly per: number;
  readonly min?: number;
  readonly max?: number;
}

export type CombatVariableValues = Record<CombatScaleVariable, number>;

function normalizeZero(value: number): number {
  return value === 0 ? 0 : value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

function computeMissingHpPct(combatant: CombatantState | undefined): number {
  if (combatant === undefined || !Number.isFinite(combatant.maxHp) || combatant.maxHp <= 0) {
    return 0;
  }
  const clampedHp = Math.max(0, Math.min(combatant.maxHp, Number.isFinite(combatant.hp) ? combatant.hp : 0));
  const pct = Math.round(((combatant.maxHp - clampedHp) / combatant.maxHp) * 100);
  return normalizeZero(Math.max(0, Math.min(100, pct)));
}

function computeTargetStacks(target: CombatantState | undefined): number {
  if (target === undefined) {
    return 0;
  }
  let total = 0;
  for (const status of target.statuses) {
    if (status.remainingTurns > 0 && Number.isFinite(status.intensity) && status.intensity > 0) {
      total += status.intensity;
    }
  }
  return normalizeZero(total);
}

/**
 * Validate an unknown value as a {@link CombatVariableScaleSpec}.
 */
export function validateCombatVariableScaleSpec(
  raw: unknown,
  pathPrefix = ''
): Result<CombatVariableScaleSpec, ValidationError[]> {
  const acc = new ErrorAccumulator(pathPrefix);

  if (!isPlainObject(raw)) {
    acc.add('', 'INVALID_TYPE', 'Scale spec must be a plain object');
    return err([...acc.errors]);
  }

  for (const key of Object.getOwnPropertyNames(raw)) {
    if (FORBIDDEN_KEYS.has(key)) {
      acc.add(key, 'FORBIDDEN_KEY', `Forbidden property key "${key}" is not allowed`);
    }
  }

  const rawVariable = Object.hasOwn(raw, 'variable')
    ? Object.getOwnPropertyDescriptor(raw, 'variable')?.value
    : undefined;
  if (typeof rawVariable !== 'string' || !VALID_SCALE_VARIABLES.has(rawVariable)) {
    acc.add(
      'variable',
      'INVALID_SCALE_VARIABLE',
      `Scale variable must be one of: ${COMBAT_SCALE_VARIABLES.join(', ')}`
    );
  }

  const rawPer = Object.hasOwn(raw, 'per')
    ? Object.getOwnPropertyDescriptor(raw, 'per')?.value
    : undefined;
  if (typeof rawPer !== 'number' || !Number.isFinite(rawPer)) {
    acc.add('per', 'INVALID_NUMBER', 'Scale per must be a finite number');
  }

  const rawMin = Object.hasOwn(raw, 'min')
    ? Object.getOwnPropertyDescriptor(raw, 'min')?.value
    : undefined;
  let min: number | undefined;
  if (rawMin !== undefined) {
    if (typeof rawMin !== 'number' || !Number.isFinite(rawMin)) {
      acc.add('min', 'INVALID_NUMBER', 'Scale min must be a finite number');
    } else {
      min = normalizeZero(rawMin);
    }
  }

  const rawMax = Object.hasOwn(raw, 'max')
    ? Object.getOwnPropertyDescriptor(raw, 'max')?.value
    : undefined;
  let max: number | undefined;
  if (rawMax !== undefined) {
    if (typeof rawMax !== 'number' || !Number.isFinite(rawMax)) {
      acc.add('max', 'INVALID_NUMBER', 'Scale max must be a finite number');
    } else {
      max = normalizeZero(rawMax);
    }
  }

  if (min !== undefined && max !== undefined && min > max) {
    acc.add('max', 'INVALID_RANGE_ORDER', 'Scale max must be >= min');
  }

  if (acc.hasErrors()) {
    return err([...acc.errors]);
  }

  return ok({
    variable: rawVariable as CombatScaleVariable,
    per: normalizeZero(rawPer as number),
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
  });
}

/**
 * Compute all 10 deterministic `@variable` scaling values for a combatant in the current combat state.
 */
export function computeCombatVariables(
  combatState: CombatState,
  actor: CombatantState,
  target?: CombatantState
): CombatVariableValues {
  let enemies = 0;
  let allies = 0;
  let adjacentEnemies = 0;
  let adjacentAllies = 0;

  const ids = getSafeCombatantIds(combatState);
  for (const id of ids) {
    const candidate = getSafeCombatant(combatState, id);
    if (candidate === undefined || !candidate.alive || candidate.hp <= 0) {
      continue;
    }

    const isHostile = areTeamsHostile(actor.team, candidate.team);
    const isAlly = candidate.id !== actor.id && candidate.team === actor.team;

    if (isHostile) {
      enemies += 1;
    } else if (isAlly) {
      allies += 1;
    }

    if (combatState.mode === 'tactical_grid') {
      if (candidate.id !== actor.id && chebyshevDistance(actor.coord, candidate.coord) <= 1) {
        if (isHostile) {
          adjacentEnemies += 1;
        } else if (isAlly) {
          adjacentAllies += 1;
        }
      }
    }
  }

  if (combatState.mode === 'traditional') {
    adjacentEnemies = enemies;
    adjacentAllies = allies;
  }

  const actorAliveCount = actor.alive && actor.hp > 0 ? 1 : 0;
  const outnumbered = Math.max(0, enemies - (allies + actorAliveCount));
  const round =
    Number.isFinite(combatState.round) && combatState.round >= 0
      ? Math.trunc(combatState.round)
      : 0;
  const rawLevel = getOwnNumber(actor.stats, 'level');
  const level =
    rawLevel !== undefined && rawLevel >= 1 ? Math.floor(rawLevel) : 1;

  return {
    enemies: normalizeZero(enemies),
    allies: normalizeZero(allies),
    outnumbered: normalizeZero(outnumbered),
    adjacentEnemies: normalizeZero(adjacentEnemies),
    adjacentAllies: normalizeZero(adjacentAllies),
    round: normalizeZero(round),
    missingHpPct: computeMissingHpPct(actor),
    targetMissingHpPct: computeMissingHpPct(target),
    level: normalizeZero(level),
    targetStacks: computeTargetStacks(target),
  };
}

function computeScaleBonus(
  vars: Partial<Record<CombatScaleVariable, number>>,
  scale: CombatVariableScaleSpec
): number {
  if (!VALID_SCALE_VARIABLES.has(scale.variable) || !Number.isFinite(scale.per)) {
    throw new RefereeError('Invalid combat variable scale specification', {
      code: 'INVALID_SCALE_SPEC',
      details: scale,
    });
  }
  const rawVal = Object.hasOwn(vars, scale.variable)
    ? Object.getOwnPropertyDescriptor(vars, scale.variable)?.value
    : 0;
  const varValue = typeof rawVal === 'number' && Number.isFinite(rawVal) ? rawVal : 0;
  let bonus = Math.trunc(varValue * scale.per);
  if (scale.min !== undefined && Number.isFinite(scale.min)) {
    bonus = Math.max(Math.trunc(scale.min), bonus);
  }
  if (scale.max !== undefined && Number.isFinite(scale.max)) {
    bonus = Math.min(Math.trunc(scale.max), bonus);
  }
  return normalizeZero(bonus);
}

/**
 * Substitute `@variable` tokens in a dice expression and apply an optional {@link CombatVariableScaleSpec} bonus.
 */
export function resolveScaledDiceExpression(
  expr: string,
  vars: Partial<Record<CombatScaleVariable, number>>,
  scale?: CombatVariableScaleSpec
): string {
  if (typeof expr !== 'string' || expr.trim().length === 0) {
    throw new RefereeError('Dice expression must be a non-empty string', {
      code: 'INVALID_DICE_EXPRESSION',
      details: { expr },
    });
  }

  const substituted = expr.trim().replace(/@([a-zA-Z_][a-zA-Z0-9_]*)/g, (_match, name: string) => {
    if (!isSafeKey(name) || !VALID_SCALE_VARIABLES.has(name)) {
      throw new RefereeError(`Unknown combat scale variable "@${name}"`, {
        code: 'UNKNOWN_COMBAT_VARIABLE',
        details: { variable: name, expr },
      });
    }
    const rawVal = Object.hasOwn(vars, name)
      ? Object.getOwnPropertyDescriptor(vars, name)?.value
      : 0;
    const num = typeof rawVal === 'number' && Number.isFinite(rawVal) ? Math.trunc(rawVal) : 0;
    return String(normalizeZero(num));
  });

  const scaleBonus = scale !== undefined ? computeScaleBonus(vars, scale) : 0;

  // Support pure integer expressions (no 'd') as well as NdM(+/-K)* expressions.
  const compact = substituted.replace(/\s+/g, '');
  if (/^[+-]?\d+(?:[+-]\d+)*$/.test(compact)) {
    const terms = compact.match(/[+-]?\d+/g) ?? [];
    let total = scaleBonus;
    for (const term of terms) {
      total += Number.parseInt(term, 10);
    }
    return String(normalizeZero(total));
  }

  // Extract leading dice core + optional sequence of +/- integer modifiers.
  const diceCoreMatch = /^(\d*d\d+(?:k[hl]\d+)?)((?:[+-]\d+)*)$/i.exec(compact);
  if (diceCoreMatch === null) {
    throw new RefereeError(`Invalid scaled dice expression "${substituted}"`, {
      code: 'INVALID_DICE_EXPRESSION',
      details: { expr, substituted },
    });
  }

  const diceCore = diceCoreMatch[1] ?? '';
  const modChain = diceCoreMatch[2] ?? '';

  const parsedCore = parseDiceNotation(diceCore);
  if (!parsedCore.ok) {
    throw new RefereeError(`Invalid dice core "${diceCore}" in expression "${expr}"`, {
      code: 'INVALID_DICE_EXPRESSION',
      details: parsedCore.error,
    });
  }

  let totalModifier = parsedCore.value.modifier + scaleBonus;
  if (modChain.length > 0) {
    const terms = modChain.match(/[+-]\d+/g) ?? [];
    for (const term of terms) {
      totalModifier += Number.parseInt(term, 10);
    }
  }

  totalModifier = normalizeZero(totalModifier);
  const keepSuffix =
    parsedCore.value.keepMode === 'highest' && parsedCore.value.keepCount !== undefined
      ? `kh${parsedCore.value.keepCount}`
      : parsedCore.value.keepMode === 'lowest' && parsedCore.value.keepCount !== undefined
        ? `kl${parsedCore.value.keepCount}`
        : '';
  const modSuffix =
    totalModifier > 0 ? `+${totalModifier}` : totalModifier < 0 ? `${totalModifier}` : '';

  return `${parsedCore.value.diceCount}d${parsedCore.value.sides}${keepSuffix}${modSuffix}`;
}
