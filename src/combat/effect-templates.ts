import { parseDiceNotation } from '../core/dice.js';
import { type ValidationError } from '../core/errors.js';
import { ErrorAccumulator, type Result, err, ok } from '../core/result.js';
import {
  type CombatState,
  type CombatantState,
  areTeamsHostile,
  getSafeCombatant,
  isSafeKey,
} from './action-validator.js';
import {
  COMBAT_SCALE_VARIABLES,
  type CombatVariableScaleSpec,
  validateCombatVariableScaleSpec,
} from './combat-variables.js';

export const EFFECT_TEMPLATE_ROLES = Object.freeze([
  '$caster',
  '$target',
  '$area',
  '$areaHostile',
  '$areaFriendly',
] as const);

export type EffectTemplateRole = (typeof EFFECT_TEMPLATE_ROLES)[number];

export const EFFECT_TEMPLATE_STEP_KINDS = Object.freeze([
  'damage',
  'drain',
  'heal',
  'status',
  'cure',
  'terrain',
  'summon',
  'transform',
  'revert_transform',
  'log',
] as const);

export type EffectTemplateStepKind = (typeof EFFECT_TEMPLATE_STEP_KINDS)[number];

export interface EffectTemplateStep {
  readonly kind: EffectTemplateStepKind;
  readonly role: EffectTemplateRole;
  readonly dice?: string;
  readonly flat?: number;
  readonly scalingStat?: string;
  readonly scale?: CombatVariableScaleSpec;
  readonly damageType?: string;
  readonly targetResource?: string;
  readonly healCaster?: boolean;
  readonly statusId?: string;
  readonly statusDuration?: number;
  readonly statusIntensity?: number;
  readonly terrainSpec?: Record<string, unknown>;
  readonly summonId?: string;
  readonly formLoadoutId?: string;
  readonly durationTurns?: number | null;
  readonly tempHp?: number;
  readonly revertOnZeroTempHp?: boolean;
  readonly message?: string;
}

export interface EffectTemplate {
  readonly id: string;
  readonly skillId: string;
  readonly steps: readonly EffectTemplateStep[];
  readonly cachedAtTurn?: number;
  readonly source: string;
}

export interface ExpandedEffectTemplateStepTargets {
  readonly stepIndex: number;
  readonly step: EffectTemplateStep;
  readonly targetIds: readonly string[];
}

export interface ExpandedEffectTemplateTargets {
  readonly roles: Record<EffectTemplateRole, readonly string[]>;
  readonly stepTargets: readonly ExpandedEffectTemplateStepTargets[];
}

const VALID_ROLES: ReadonlySet<string> = new Set(EFFECT_TEMPLATE_ROLES);
const VALID_STEP_KINDS: ReadonlySet<string> = new Set(EFFECT_TEMPLATE_STEP_KINDS);
const VALID_SCALE_VARS: ReadonlySet<string> = new Set(COMBAT_SCALE_VARIABLES);
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

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

function getOwnValue(obj: Record<string, unknown>, key: string): unknown {
  if (!isSafeKey(key) || !Object.hasOwn(obj, key)) {
    return undefined;
  }
  return Object.getOwnPropertyDescriptor(obj, key)?.value;
}

function checkNoForbiddenKeys(obj: Record<string, unknown>, acc: ErrorAccumulator): void {
  for (const key of Object.getOwnPropertyNames(obj)) {
    if (FORBIDDEN_KEYS.has(key)) {
      acc.add(key, 'FORBIDDEN_KEY', `Forbidden property key "${key}" is not allowed`);
    }
  }
}

function clonePlainRecord(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    if (!isSafeKey(key) || !Object.hasOwn(record, key)) {
      continue;
    }
    const val = Object.getOwnPropertyDescriptor(record, key)?.value;
    let clonedVal: unknown = val;
    if (typeof val === 'number') {
      clonedVal = normalizeZero(val);
    } else if (Array.isArray(val)) {
      clonedVal = [...val];
    } else if (isPlainObject(val)) {
      clonedVal = clonePlainRecord(val);
    }
    Object.defineProperty(out, key, {
      value: clonedVal,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

function validateSafePlainRecord(
  raw: unknown,
  acc: ErrorAccumulator,
  field: string
): Record<string, unknown> | undefined {
  if (!isPlainObject(raw)) {
    acc.add(field, 'INVALID_TYPE', `${field} must be a plain object`);
    return undefined;
  }
  const scoped = acc.scope(field);
  checkNoForbiddenKeys(raw, scoped);
  if (scoped.hasErrors()) {
    return undefined;
  }
  return clonePlainRecord(raw);
}

function validateTemplateDice(rawDice: string, acc: ErrorAccumulator): string | undefined {
  const trimmed = rawDice.trim();
  if (trimmed.length === 0) {
    acc.add('dice', 'EMPTY_NOTATION', 'Dice expression cannot be empty');
    return undefined;
  }
  if (trimmed.includes('@')) {
    let invalidVar = false;
    const probe = trimmed.replace(/@([a-zA-Z_][a-zA-Z0-9_]*)/g, (_m, name: string) => {
      if (!isSafeKey(name) || !VALID_SCALE_VARS.has(name)) {
        acc.add('dice', 'UNKNOWN_COMBAT_VARIABLE', `Unknown combat scale variable "@${name}"`);
        invalidVar = true;
      }
      return '1';
    });
    if (invalidVar) {
      return undefined;
    }
    const compact = probe.replace(/\s+/g, '');
    if (!/^[+-]?\d+(?:[+-]\d+)*$/.test(compact)) {
      const match = /^(\d*d\d+(?:k[hl]\d+)?)((?:[+-]\d+)*)$/i.exec(compact);
      if (match === null) {
        acc.add('dice', 'INVALID_NOTATION', `Invalid template dice expression "${trimmed}"`);
        return undefined;
      }
      const parsed = parseDiceNotation(match[1] ?? '');
      if (!parsed.ok) {
        acc.scope('dice').addAll(parsed.error);
        return undefined;
      }
    }
    return trimmed;
  }

  const parsed = parseDiceNotation(trimmed);
  if (!parsed.ok) {
    acc.scope('dice').addAll(parsed.error);
    return undefined;
  }
  return parsed.value.notation;
}

function cloneStep(step: EffectTemplateStep): EffectTemplateStep {
  return {
    kind: step.kind,
    role: step.role,
    ...(step.dice !== undefined ? { dice: step.dice } : {}),
    ...(step.flat !== undefined ? { flat: normalizeZero(step.flat) } : {}),
    ...(step.scalingStat !== undefined ? { scalingStat: step.scalingStat } : {}),
    ...(step.scale !== undefined ? { scale: { ...step.scale } } : {}),
    ...(step.damageType !== undefined ? { damageType: step.damageType } : {}),
    ...(step.targetResource !== undefined ? { targetResource: step.targetResource } : {}),
    ...(step.healCaster !== undefined ? { healCaster: step.healCaster } : {}),
    ...(step.statusId !== undefined ? { statusId: step.statusId } : {}),
    ...(step.statusDuration !== undefined ? { statusDuration: step.statusDuration } : {}),
    ...(step.statusIntensity !== undefined ? { statusIntensity: step.statusIntensity } : {}),
    ...(step.terrainSpec !== undefined ? { terrainSpec: clonePlainRecord(step.terrainSpec) } : {}),
    ...(step.summonId !== undefined ? { summonId: step.summonId } : {}),
    ...(step.formLoadoutId !== undefined ? { formLoadoutId: step.formLoadoutId } : {}),
    ...(step.durationTurns !== undefined ? { durationTurns: step.durationTurns } : {}),
    ...(step.tempHp !== undefined ? { tempHp: normalizeZero(step.tempHp) } : {}),
    ...(step.revertOnZeroTempHp !== undefined
      ? { revertOnZeroTempHp: step.revertOnZeroTempHp }
      : {}),
    ...(step.message !== undefined ? { message: step.message } : {}),
  };
}

/**
 * Return a defensive deep clone of an {@link EffectTemplate}.
 */
export function cloneEffectTemplate(template: EffectTemplate): EffectTemplate {
  return {
    id: template.id,
    skillId: template.skillId,
    steps: template.steps.map(cloneStep),
    ...(template.cachedAtTurn !== undefined
      ? { cachedAtTurn: normalizeZero(template.cachedAtTurn) }
      : {}),
    source: template.source,
  };
}

function validateStep(raw: unknown, acc: ErrorAccumulator): EffectTemplateStep | undefined {
  if (!isPlainObject(raw)) {
    acc.add('', 'INVALID_TYPE', 'Effect template step must be a plain object');
    return undefined;
  }
  checkNoForbiddenKeys(raw, acc);

  const rawKind = getOwnValue(raw, 'kind');
  if (typeof rawKind !== 'string' || !VALID_STEP_KINDS.has(rawKind)) {
    acc.add(
      'kind',
      'INVALID_STEP_KIND',
      `Step kind must be one of: ${EFFECT_TEMPLATE_STEP_KINDS.join(', ')}`
    );
  }

  const rawRole = getOwnValue(raw, 'role');
  if (typeof rawRole !== 'string' || !VALID_ROLES.has(rawRole)) {
    acc.add(
      'role',
      'INVALID_TEMPLATE_ROLE',
      `Step role must be one of: ${EFFECT_TEMPLATE_ROLES.join(', ')}`
    );
  }

  let dice: string | undefined;
  const rawDice = getOwnValue(raw, 'dice');
  if (rawDice !== undefined) {
    if (typeof rawDice !== 'string') {
      acc.add('dice', 'INVALID_TYPE', 'Step dice must be a string');
    } else {
      dice = validateTemplateDice(rawDice, acc);
    }
  }

  let flat: number | undefined;
  const rawFlat = getOwnValue(raw, 'flat');
  if (rawFlat !== undefined) {
    if (typeof rawFlat !== 'number' || !Number.isFinite(rawFlat)) {
      acc.add('flat', 'INVALID_NUMBER', 'Step flat must be a finite number');
    } else {
      flat = normalizeZero(rawFlat);
    }
  }

  let scalingStat: string | undefined;
  const rawScalingStat = getOwnValue(raw, 'scalingStat');
  if (rawScalingStat !== undefined) {
    if (typeof rawScalingStat !== 'string' || !isSafeKey(rawScalingStat.trim())) {
      acc.add('scalingStat', 'INVALID_STRING', 'Step scalingStat must be a safe non-empty string');
    } else {
      scalingStat = rawScalingStat.trim();
    }
  }

  let scale: CombatVariableScaleSpec | undefined;
  const rawScale = getOwnValue(raw, 'scale');
  if (rawScale !== undefined) {
    const scaleRes = validateCombatVariableScaleSpec(rawScale);
    if (!scaleRes.ok) {
      acc.scope('scale').addAll(scaleRes.error);
    } else {
      scale = scaleRes.value;
    }
  }

  let damageType: string | undefined;
  const rawDamageType = getOwnValue(raw, 'damageType');
  if (rawDamageType !== undefined) {
    if (typeof rawDamageType !== 'string' || !isSafeKey(rawDamageType.trim())) {
      acc.add('damageType', 'INVALID_STRING', 'Step damageType must be a safe non-empty string');
    } else {
      damageType = rawDamageType.trim();
    }
  }

  let targetResource: string | undefined;
  const rawTargetResource = getOwnValue(raw, 'targetResource');
  if (rawTargetResource !== undefined) {
    if (typeof rawTargetResource !== 'string' || !isSafeKey(rawTargetResource.trim())) {
      acc.add(
        'targetResource',
        'INVALID_STRING',
        'Step targetResource must be a safe non-empty string'
      );
    } else {
      targetResource = rawTargetResource.trim();
    }
  }

  let healCaster: boolean | undefined;
  const rawHealCaster = getOwnValue(raw, 'healCaster');
  if (rawHealCaster !== undefined) {
    if (typeof rawHealCaster !== 'boolean') {
      acc.add('healCaster', 'INVALID_TYPE', 'Step healCaster must be a boolean');
    } else {
      healCaster = rawHealCaster;
    }
  }

  let statusId: string | undefined;
  const rawStatusId = getOwnValue(raw, 'statusId');
  if (rawStatusId !== undefined) {
    if (typeof rawStatusId !== 'string' || !isSafeKey(rawStatusId.trim())) {
      acc.add('statusId', 'INVALID_STRING', 'Step statusId must be a safe non-empty string');
    } else {
      statusId = rawStatusId.trim();
    }
  }

  let statusDuration: number | undefined;
  const rawStatusDuration = getOwnValue(raw, 'statusDuration');
  if (rawStatusDuration !== undefined) {
    if (
      typeof rawStatusDuration !== 'number' ||
      !Number.isSafeInteger(rawStatusDuration) ||
      rawStatusDuration < 1
    ) {
      acc.add('statusDuration', 'INVALID_INTEGER', 'Step statusDuration must be a safe integer >= 1');
    } else {
      statusDuration = rawStatusDuration;
    }
  }

  let statusIntensity: number | undefined;
  const rawStatusIntensity = getOwnValue(raw, 'statusIntensity');
  if (rawStatusIntensity !== undefined) {
    if (
      typeof rawStatusIntensity !== 'number' ||
      !Number.isFinite(rawStatusIntensity) ||
      rawStatusIntensity <= 0
    ) {
      acc.add('statusIntensity', 'INVALID_NUMBER', 'Step statusIntensity must be a finite number > 0');
    } else {
      statusIntensity = rawStatusIntensity;
    }
  }

  let terrainSpec: Record<string, unknown> | undefined;
  const rawTerrainSpec = getOwnValue(raw, 'terrainSpec');
  if (rawTerrainSpec !== undefined) {
    terrainSpec = validateSafePlainRecord(rawTerrainSpec, acc, 'terrainSpec');
  }

  let summonId: string | undefined;
  const rawSummonId = getOwnValue(raw, 'summonId');
  if (rawSummonId !== undefined) {
    if (typeof rawSummonId !== 'string' || !isSafeKey(rawSummonId.trim())) {
      acc.add('summonId', 'INVALID_STRING', 'Step summonId must be a safe non-empty string');
    } else {
      summonId = rawSummonId.trim();
    }
  }

  let formLoadoutId: string | undefined;
  const rawFormLoadoutId = getOwnValue(raw, 'formLoadoutId');
  if (rawFormLoadoutId !== undefined) {
    if (typeof rawFormLoadoutId !== 'string' || !isSafeKey(rawFormLoadoutId.trim())) {
      acc.add(
        'formLoadoutId',
        'INVALID_STRING',
        'Step formLoadoutId must be a safe non-empty string'
      );
    } else {
      formLoadoutId = rawFormLoadoutId.trim();
    }
  }

  let durationTurns: number | null | undefined;
  const rawDurationTurns = getOwnValue(raw, 'durationTurns');
  if (rawDurationTurns !== undefined) {
    if (rawDurationTurns === null) {
      durationTurns = null;
    } else if (
      typeof rawDurationTurns !== 'number' ||
      !Number.isSafeInteger(rawDurationTurns) ||
      rawDurationTurns < 1
    ) {
      acc.add(
        'durationTurns',
        'INVALID_INTEGER',
        'Step durationTurns must be null or a safe integer >= 1'
      );
    } else {
      durationTurns = rawDurationTurns;
    }
  }

  let tempHp: number | undefined;
  const rawTempHp = getOwnValue(raw, 'tempHp');
  if (rawTempHp !== undefined) {
    if (typeof rawTempHp !== 'number' || !Number.isFinite(rawTempHp) || rawTempHp < 0) {
      acc.add('tempHp', 'INVALID_NUMBER', 'Step tempHp must be a finite number >= 0');
    } else {
      tempHp = normalizeZero(rawTempHp);
    }
  }

  let revertOnZeroTempHp: boolean | undefined;
  const rawRevertOnZeroTempHp = getOwnValue(raw, 'revertOnZeroTempHp');
  if (rawRevertOnZeroTempHp !== undefined) {
    if (typeof rawRevertOnZeroTempHp !== 'boolean') {
      acc.add(
        'revertOnZeroTempHp',
        'INVALID_TYPE',
        'Step revertOnZeroTempHp must be a boolean'
      );
    } else {
      revertOnZeroTempHp = rawRevertOnZeroTempHp;
    }
  }

  let message: string | undefined;
  const rawMessage = getOwnValue(raw, 'message');
  if (rawMessage !== undefined) {
    if (typeof rawMessage !== 'string' || rawMessage.trim().length === 0) {
      acc.add('message', 'INVALID_STRING', 'Step message must be a non-empty string');
    } else {
      message = rawMessage.trim();
    }
  }

  if (typeof rawKind === 'string' && VALID_STEP_KINDS.has(rawKind)) {
    const kind = rawKind as EffectTemplateStepKind;
    if (kind === 'status' && statusId === undefined) {
      acc.add('statusId', 'REQUIRED', 'Step kind "status" requires statusId');
    }
    if (kind === 'terrain' && terrainSpec === undefined) {
      acc.add('terrainSpec', 'REQUIRED', 'Step kind "terrain" requires terrainSpec');
    }
    if (kind === 'summon' && summonId === undefined) {
      acc.add('summonId', 'REQUIRED', 'Step kind "summon" requires summonId');
    }
    if (kind === 'transform' && formLoadoutId === undefined) {
      acc.add('formLoadoutId', 'REQUIRED', 'Step kind "transform" requires formLoadoutId');
    }
    if (kind === 'log' && message === undefined) {
      acc.add('message', 'REQUIRED', 'Step kind "log" requires message');
    }
  }

  if (acc.hasErrors()) {
    return undefined;
  }

  return {
    kind: rawKind as EffectTemplateStepKind,
    role: rawRole as EffectTemplateRole,
    ...(dice !== undefined ? { dice } : {}),
    ...(flat !== undefined ? { flat } : {}),
    ...(scalingStat !== undefined ? { scalingStat } : {}),
    ...(scale !== undefined ? { scale } : {}),
    ...(damageType !== undefined ? { damageType } : {}),
    ...(targetResource !== undefined ? { targetResource } : {}),
    ...(healCaster !== undefined ? { healCaster } : {}),
    ...(statusId !== undefined ? { statusId } : {}),
    ...(statusDuration !== undefined ? { statusDuration } : {}),
    ...(statusIntensity !== undefined ? { statusIntensity } : {}),
    ...(terrainSpec !== undefined ? { terrainSpec } : {}),
    ...(summonId !== undefined ? { summonId } : {}),
    ...(formLoadoutId !== undefined ? { formLoadoutId } : {}),
    ...(durationTurns !== undefined ? { durationTurns } : {}),
    ...(tempHp !== undefined ? { tempHp } : {}),
    ...(revertOnZeroTempHp !== undefined ? { revertOnZeroTempHp } : {}),
    ...(message !== undefined ? { message } : {}),
  };
}

/**
 * Validate an unknown value as a cached {@link EffectTemplate}.
 */
export function validateEffectTemplate(
  raw: unknown,
  pathPrefix = ''
): Result<EffectTemplate, ValidationError[]> {
  const acc = new ErrorAccumulator(pathPrefix);

  if (!isPlainObject(raw)) {
    acc.add('', 'INVALID_TYPE', 'Effect template must be a plain object');
    return err([...acc.errors]);
  }

  checkNoForbiddenKeys(raw, acc);

  const rawId = getOwnValue(raw, 'id');
  let id = '';
  if (typeof rawId !== 'string' || rawId.trim().length === 0) {
    acc.add('id', 'REQUIRED', 'Effect template id must be a non-empty string');
  } else if (!isSafeKey(rawId.trim())) {
    acc.add('id', 'FORBIDDEN_KEY', `Effect template id "${rawId}" is forbidden`);
  } else {
    id = rawId.trim();
  }

  const rawSkillId = getOwnValue(raw, 'skillId');
  let skillId = '';
  if (typeof rawSkillId !== 'string' || rawSkillId.trim().length === 0) {
    acc.add('skillId', 'REQUIRED', 'Effect template skillId must be a non-empty string');
  } else if (!isSafeKey(rawSkillId.trim())) {
    acc.add('skillId', 'FORBIDDEN_KEY', `Effect template skillId "${rawSkillId}" is forbidden`);
  } else {
    skillId = rawSkillId.trim();
  }

  const rawSource = getOwnValue(raw, 'source');
  let source = '';
  if (typeof rawSource !== 'string' || rawSource.trim().length === 0) {
    acc.add('source', 'REQUIRED', 'Effect template source must be a non-empty string');
  } else if (!isSafeKey(rawSource.trim())) {
    acc.add('source', 'FORBIDDEN_KEY', `Effect template source "${rawSource}" is forbidden`);
  } else {
    source = rawSource.trim();
  }

  let cachedAtTurn: number | undefined;
  const rawCachedAtTurn = getOwnValue(raw, 'cachedAtTurn');
  if (rawCachedAtTurn !== undefined) {
    if (
      typeof rawCachedAtTurn !== 'number' ||
      !Number.isSafeInteger(rawCachedAtTurn) ||
      rawCachedAtTurn < 0
    ) {
      acc.add('cachedAtTurn', 'INVALID_INTEGER', 'cachedAtTurn must be a safe integer >= 0');
    } else {
      cachedAtTurn = normalizeZero(rawCachedAtTurn);
    }
  }

  const rawSteps = getOwnValue(raw, 'steps');
  const steps: EffectTemplateStep[] = [];
  if (!Array.isArray(rawSteps)) {
    acc.add('steps', 'INVALID_TYPE', 'Effect template steps must be an array');
  } else {
    for (let i = 0; i < rawSteps.length; i++) {
      const step = validateStep(rawSteps[i], acc.scope(`steps[${i}]`));
      if (step !== undefined) {
        steps.push(step);
      }
    }
  }

  if (acc.hasErrors()) {
    return err([...acc.errors]);
  }

  return ok({
    id,
    skillId,
    steps,
    ...(cachedAtTurn !== undefined ? { cachedAtTurn } : {}),
    source,
  });
}

/**
 * Expand symbolic template roles (`$caster`, `$target`, `$area`, `$areaHostile`, `$areaFriendly`)
 * into deterministic combatant ID lists for each template step.
 */
export function expandEffectTemplateTargets(
  template: EffectTemplate,
  combat: CombatState,
  caster: CombatantState,
  primaryTarget?: CombatantState,
  areaTargetIds: readonly string[] = []
): ExpandedEffectTemplateTargets {
  const casterIds: string[] = caster.alive && caster.hp > 0 ? [caster.id] : [];
  const targetIds: string[] =
    primaryTarget !== undefined && primaryTarget.alive && primaryTarget.hp > 0
      ? [primaryTarget.id]
      : [];

  const areaIds: string[] = [];
  const areaHostileIds: string[] = [];
  const areaFriendlyIds: string[] = [];
  const seenArea = new Set<string>();

  for (const rawId of areaTargetIds) {
    if (typeof rawId !== 'string' || !isSafeKey(rawId) || seenArea.has(rawId)) {
      continue;
    }
    const unit = getSafeCombatant(combat, rawId);
    if (unit === undefined || !unit.alive || unit.hp <= 0) {
      continue;
    }
    seenArea.add(rawId);
    areaIds.push(rawId);
    if (areTeamsHostile(caster.team, unit.team)) {
      areaHostileIds.push(rawId);
    } else if (unit.team === caster.team) {
      areaFriendlyIds.push(rawId);
    }
  }

  const roles: Record<EffectTemplateRole, readonly string[]> = {
    $caster: casterIds,
    $target: targetIds,
    $area: areaIds,
    $areaHostile: areaHostileIds,
    $areaFriendly: areaFriendlyIds,
  };

  const stepTargets: ExpandedEffectTemplateStepTargets[] = template.steps.map((step, stepIndex) => ({
    stepIndex,
    step: cloneStep(step),
    targetIds: [...roles[step.role]],
  }));

  return {
    roles,
    stepTargets,
  };
}
