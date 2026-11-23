import { parseDiceNotation } from '../core/dice.js';
import { RefereeError, type ValidationError, validationError } from '../core/errors.js';
import { ErrorAccumulator, type Result, err, ok } from '../core/result.js';

export const SKILL_CATEGORIES = Object.freeze([
  'attack',
  'skill',
  'spell',
  'item',
  'movement',
  'defend',
] as const);

export type SkillCategory = (typeof SKILL_CATEGORIES)[number];

export const ACTION_COST_TYPES = Object.freeze([
  'action',
  'bonus',
  'free',
  'reaction',
] as const);

export type ActionCostType = (typeof ACTION_COST_TYPES)[number];

export const TARGETING_SHAPES = Object.freeze([
  'self',
  'single_enemy',
  'single_ally',
  'aoe_radius',
  'line',
  'cone',
] as const);

export type TargetingShape = (typeof TARGETING_SHAPES)[number];

export const SKILL_EFFECT_TYPES = Object.freeze([
  'damage',
  'heal',
  'apply_status',
  'remove_status',
  'knockback',
  'restore_resource',
] as const);

export type SkillEffectType = (typeof SKILL_EFFECT_TYPES)[number];

export const HIT_RESOLUTION_KINDS = Object.freeze([
  'auto',
  'attack_roll',
  'save',
] as const);

export type HitResolutionKind = (typeof HIT_RESOLUTION_KINDS)[number];

/**
 * Declarative specification for a single effect produced by a skill or passive.
 */
export interface SkillEffectSpec {
  readonly type: SkillEffectType;
  readonly dice?: string;
  readonly flat?: number;
  readonly scalingStat?: string;
  readonly statusId?: string;
  readonly statusDuration?: number;
  readonly statusIntensity?: number;
  readonly distance?: number;
  readonly resourceKey?: string;
}

/**
 * Targeting geometry and range rules for a skill.
 */
export interface SkillTargetingSpec {
  readonly shape: TargetingShape;
  readonly minRange: number;
  readonly maxRange: number;
  readonly radius?: number;
  readonly requiresLos: boolean;
}

/**
 * Hit resolution rules for a skill.
 */
export interface SkillHitResolutionSpec {
  readonly kind: HitResolutionKind;
  readonly stat?: string;
  readonly saveStat?: string;
  readonly dc?: number;
}

/**
 * Declarative definition of a skill, spell, item, or combat action.
 */
export interface SkillDefinition {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly category: SkillCategory;
  readonly actionCost: ActionCostType;
  readonly resourceCosts: Record<string, number>;
  readonly cooldownTurns?: number;
  readonly targeting: SkillTargetingSpec;
  readonly hitResolution: SkillHitResolutionSpec;
  readonly effects: readonly SkillEffectSpec[];
  readonly tags?: readonly string[];
}

const VALID_CATEGORIES: ReadonlySet<string> = new Set(SKILL_CATEGORIES);
const VALID_ACTION_COSTS: ReadonlySet<string> = new Set(ACTION_COST_TYPES);
const VALID_TARGETING_SHAPES: ReadonlySet<string> = new Set(TARGETING_SHAPES);
const VALID_EFFECT_TYPES: ReadonlySet<string> = new Set(SKILL_EFFECT_TYPES);
const VALID_HIT_KINDS: ReadonlySet<string> = new Set(HIT_RESOLUTION_KINDS);
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

function getOwnValue(obj: Record<string, unknown>, key: string): unknown {
  if (!isSafeKey(key) || !Object.hasOwn(obj, key)) {
    return undefined;
  }
  return Object.getOwnPropertyDescriptor(obj, key)?.value;
}

function setOwnValue<T>(obj: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(obj, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function checkNoForbiddenKeys(obj: Record<string, unknown>, acc: ErrorAccumulator): boolean {
  let valid = true;
  for (const key of Object.getOwnPropertyNames(obj)) {
    if (FORBIDDEN_KEYS.has(key)) {
      acc.add(key, 'FORBIDDEN_KEY', `Forbidden property key "${key}" is not allowed`);
      valid = false;
    }
  }
  return valid;
}

function cloneResourceCosts(costs: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of Object.keys(costs)) {
    if (isSafeKey(key) && Object.hasOwn(costs, key)) {
      const value = costs[key];
      if (typeof value === 'number') {
        setOwnValue(out, key, value === 0 ? 0 : value);
      }
    }
  }
  return out;
}

function cloneEffectSpec(effect: SkillEffectSpec): SkillEffectSpec {
  return {
    type: effect.type,
    ...(effect.dice !== undefined ? { dice: effect.dice } : {}),
    ...(effect.flat !== undefined ? { flat: effect.flat === 0 ? 0 : effect.flat } : {}),
    ...(effect.scalingStat !== undefined ? { scalingStat: effect.scalingStat } : {}),
    ...(effect.statusId !== undefined ? { statusId: effect.statusId } : {}),
    ...(effect.statusDuration !== undefined ? { statusDuration: effect.statusDuration } : {}),
    ...(effect.statusIntensity !== undefined ? { statusIntensity: effect.statusIntensity } : {}),
    ...(effect.distance !== undefined ? { distance: effect.distance === 0 ? 0 : effect.distance } : {}),
    ...(effect.resourceKey !== undefined ? { resourceKey: effect.resourceKey } : {}),
  };
}

function cloneSkillDefinition(skill: SkillDefinition): SkillDefinition {
  return {
    id: skill.id,
    name: skill.name,
    ...(skill.description !== undefined ? { description: skill.description } : {}),
    category: skill.category,
    actionCost: skill.actionCost,
    resourceCosts: cloneResourceCosts(skill.resourceCosts),
    ...(skill.cooldownTurns !== undefined ? { cooldownTurns: skill.cooldownTurns } : {}),
    targeting: {
      shape: skill.targeting.shape,
      minRange: skill.targeting.minRange === 0 ? 0 : skill.targeting.minRange,
      maxRange: skill.targeting.maxRange === 0 ? 0 : skill.targeting.maxRange,
      ...(skill.targeting.radius !== undefined
        ? { radius: skill.targeting.radius === 0 ? 0 : skill.targeting.radius }
        : {}),
      requiresLos: skill.targeting.requiresLos,
    },
    hitResolution: {
      kind: skill.hitResolution.kind,
      ...(skill.hitResolution.stat !== undefined ? { stat: skill.hitResolution.stat } : {}),
      ...(skill.hitResolution.saveStat !== undefined
        ? { saveStat: skill.hitResolution.saveStat }
        : {}),
      ...(skill.hitResolution.dc !== undefined ? { dc: skill.hitResolution.dc } : {}),
    },
    effects: skill.effects.map(cloneEffectSpec),
    ...(skill.tags !== undefined ? { tags: [...skill.tags] } : {}),
  };
}

/**
 * Validate an unknown value as a {@link SkillEffectSpec}.
 */
export function validateSkillEffectSpec(
  raw: unknown,
  pathPrefix = ''
): Result<SkillEffectSpec, ValidationError[]> {
  const acc = new ErrorAccumulator(pathPrefix);

  if (!isPlainObject(raw)) {
    acc.add('', 'INVALID_TYPE', 'Skill effect must be a plain object');
    return err([...acc.errors]);
  }

  checkNoForbiddenKeys(raw, acc);

  const rawType = getOwnValue(raw, 'type');
  if (typeof rawType !== 'string' || !VALID_EFFECT_TYPES.has(rawType)) {
    acc.add(
      'type',
      'INVALID_EFFECT_TYPE',
      `Effect type must be one of: ${SKILL_EFFECT_TYPES.join(', ')}`
    );
  }

  const rawDice = getOwnValue(raw, 'dice');
  let dice: string | undefined;
  if (rawDice !== undefined) {
    if (typeof rawDice !== 'string') {
      acc.add('dice', 'INVALID_TYPE', 'Effect dice must be a string');
    } else {
      const parsed = parseDiceNotation(rawDice);
      if (!parsed.ok) {
        acc.scope('dice').addAll(parsed.error);
      } else {
        dice = parsed.value.notation;
      }
    }
  }

  const rawFlat = getOwnValue(raw, 'flat');
  let flat: number | undefined;
  if (rawFlat !== undefined) {
    if (typeof rawFlat !== 'number' || !Number.isFinite(rawFlat)) {
      acc.add('flat', 'INVALID_NUMBER', 'Effect flat bonus must be a finite number');
    } else {
      flat = rawFlat === 0 ? 0 : rawFlat;
    }
  }

  const rawScalingStat = getOwnValue(raw, 'scalingStat');
  let scalingStat: string | undefined;
  if (rawScalingStat !== undefined) {
    if (typeof rawScalingStat !== 'string' || !isSafeKey(rawScalingStat.trim())) {
      acc.add('scalingStat', 'INVALID_STRING', 'Effect scalingStat must be a safe non-empty string');
    } else {
      scalingStat = rawScalingStat.trim();
    }
  }

  const rawStatusId = getOwnValue(raw, 'statusId');
  let statusId: string | undefined;
  if (rawStatusId !== undefined) {
    if (typeof rawStatusId !== 'string' || !isSafeKey(rawStatusId.trim())) {
      acc.add('statusId', 'INVALID_STRING', 'Effect statusId must be a safe non-empty string');
    } else {
      statusId = rawStatusId.trim();
    }
  }

  const rawStatusDuration = getOwnValue(raw, 'statusDuration');
  let statusDuration: number | undefined;
  if (rawStatusDuration !== undefined) {
    if (
      typeof rawStatusDuration !== 'number' ||
      !Number.isSafeInteger(rawStatusDuration) ||
      rawStatusDuration < 1
    ) {
      acc.add(
        'statusDuration',
        'INVALID_INTEGER',
        'Effect statusDuration must be a safe integer >= 1'
      );
    } else {
      statusDuration = rawStatusDuration;
    }
  }

  const rawStatusIntensity = getOwnValue(raw, 'statusIntensity');
  let statusIntensity: number | undefined;
  if (rawStatusIntensity !== undefined) {
    if (
      typeof rawStatusIntensity !== 'number' ||
      !Number.isFinite(rawStatusIntensity) ||
      rawStatusIntensity <= 0
    ) {
      acc.add(
        'statusIntensity',
        'INVALID_NUMBER',
        'Effect statusIntensity must be a finite number > 0'
      );
    } else {
      statusIntensity = rawStatusIntensity;
    }
  }

  const rawDistance = getOwnValue(raw, 'distance');
  let distance: number | undefined;
  if (rawDistance !== undefined) {
    if (typeof rawDistance !== 'number' || !Number.isFinite(rawDistance) || rawDistance < 0) {
      acc.add('distance', 'INVALID_NUMBER', 'Effect distance must be a finite number >= 0');
    } else {
      distance = rawDistance === 0 ? 0 : rawDistance;
    }
  }

  const rawResourceKey = getOwnValue(raw, 'resourceKey');
  let resourceKey: string | undefined;
  if (rawResourceKey !== undefined) {
    if (typeof rawResourceKey !== 'string' || !isSafeKey(rawResourceKey.trim())) {
      acc.add('resourceKey', 'INVALID_STRING', 'Effect resourceKey must be a safe non-empty string');
    } else {
      resourceKey = rawResourceKey.trim();
    }
  }

  if (typeof rawType === 'string' && VALID_EFFECT_TYPES.has(rawType)) {
    const effectType = rawType as SkillEffectType;
    if ((effectType === 'apply_status' || effectType === 'remove_status') && statusId === undefined) {
      acc.add(
        'statusId',
        'REQUIRED',
        `Effect type "${effectType}" requires a non-empty statusId`
      );
    }
    if (effectType === 'restore_resource' && resourceKey === undefined) {
      acc.add(
        'resourceKey',
        'REQUIRED',
        'Effect type "restore_resource" requires a non-empty resourceKey'
      );
    }
    if (effectType === 'knockback' && distance === undefined) {
      acc.add('distance', 'REQUIRED', 'Effect type "knockback" requires distance');
    }
  }

  if (acc.hasErrors()) {
    return err([...acc.errors]);
  }

  return ok({
    type: rawType as SkillEffectType,
    ...(dice !== undefined ? { dice } : {}),
    ...(flat !== undefined ? { flat } : {}),
    ...(scalingStat !== undefined ? { scalingStat } : {}),
    ...(statusId !== undefined ? { statusId } : {}),
    ...(statusDuration !== undefined ? { statusDuration } : {}),
    ...(statusIntensity !== undefined ? { statusIntensity } : {}),
    ...(distance !== undefined ? { distance } : {}),
    ...(resourceKey !== undefined ? { resourceKey } : {}),
  });
}

/**
 * Validate an unknown value as a {@link SkillDefinition}.
 */
export function validateSkillDefinition(
  raw: unknown,
  pathPrefix = ''
): Result<SkillDefinition, ValidationError[]> {
  const acc = new ErrorAccumulator(pathPrefix);

  if (!isPlainObject(raw)) {
    acc.add('', 'INVALID_TYPE', 'Skill definition must be a plain object');
    return err([...acc.errors]);
  }

  checkNoForbiddenKeys(raw, acc);

  const rawId = getOwnValue(raw, 'id');
  let id = '';
  if (typeof rawId !== 'string' || rawId.trim().length === 0) {
    acc.add('id', 'REQUIRED', 'Skill id must be a non-empty string');
  } else if (!isSafeKey(rawId.trim())) {
    acc.add('id', 'FORBIDDEN_KEY', `Skill id "${rawId}" is forbidden`);
  } else {
    id = rawId.trim();
  }

  const rawName = getOwnValue(raw, 'name');
  let name = '';
  if (typeof rawName !== 'string' || rawName.trim().length === 0) {
    acc.add('name', 'REQUIRED', 'Skill name must be a non-empty string');
  } else {
    name = rawName.trim();
  }

  const rawDescription = getOwnValue(raw, 'description');
  let description: string | undefined;
  if (rawDescription !== undefined) {
    if (typeof rawDescription !== 'string') {
      acc.add('description', 'INVALID_TYPE', 'Skill description must be a string');
    } else {
      description = rawDescription;
    }
  }

  const rawCategory = getOwnValue(raw, 'category');
  if (typeof rawCategory !== 'string' || !VALID_CATEGORIES.has(rawCategory)) {
    acc.add(
      'category',
      'INVALID_CATEGORY',
      `Skill category must be one of: ${SKILL_CATEGORIES.join(', ')}`
    );
  }

  const rawActionCost = getOwnValue(raw, 'actionCost');
  if (typeof rawActionCost !== 'string' || !VALID_ACTION_COSTS.has(rawActionCost)) {
    acc.add(
      'actionCost',
      'INVALID_ACTION_COST',
      `Skill actionCost must be one of: ${ACTION_COST_TYPES.join(', ')}`
    );
  }

  const rawResourceCosts = getOwnValue(raw, 'resourceCosts');
  const resourceCosts: Record<string, number> = {};
  if (!isPlainObject(rawResourceCosts)) {
    acc.add('resourceCosts', 'INVALID_TYPE', 'Skill resourceCosts must be a plain object');
  } else {
    const costAcc = acc.scope('resourceCosts');
    checkNoForbiddenKeys(rawResourceCosts, costAcc);
    for (const key of Object.keys(rawResourceCosts)) {
      if (!isSafeKey(key)) {
        continue;
      }
      const val = getOwnValue(rawResourceCosts, key);
      if (typeof val !== 'number' || !Number.isFinite(val) || val < 0) {
        costAcc.add(key, 'INVALID_COST', `Resource cost for "${key}" must be a finite number >= 0`);
      } else {
        setOwnValue(resourceCosts, key, val === 0 ? 0 : val);
      }
    }
  }

  const rawCooldown = getOwnValue(raw, 'cooldownTurns');
  let cooldownTurns: number | undefined;
  if (rawCooldown !== undefined) {
    if (typeof rawCooldown !== 'number' || !Number.isSafeInteger(rawCooldown) || rawCooldown < 0) {
      acc.add('cooldownTurns', 'INVALID_INTEGER', 'cooldownTurns must be a safe integer >= 0');
    } else {
      cooldownTurns = rawCooldown === 0 ? 0 : rawCooldown;
    }
  }

  const rawTargeting = getOwnValue(raw, 'targeting');
  let targeting: SkillTargetingSpec | undefined;
  if (!isPlainObject(rawTargeting)) {
    acc.add('targeting', 'INVALID_TYPE', 'Skill targeting must be a plain object');
  } else {
    const targetAcc = acc.scope('targeting');
    checkNoForbiddenKeys(rawTargeting, targetAcc);

    const rawShape = getOwnValue(rawTargeting, 'shape');
    if (typeof rawShape !== 'string' || !VALID_TARGETING_SHAPES.has(rawShape)) {
      targetAcc.add(
        'shape',
        'INVALID_TARGETING_SHAPE',
        `Targeting shape must be one of: ${TARGETING_SHAPES.join(', ')}`
      );
    }

    const rawMinRange = getOwnValue(rawTargeting, 'minRange');
    if (typeof rawMinRange !== 'number' || !Number.isFinite(rawMinRange) || rawMinRange < 0) {
      targetAcc.add('minRange', 'INVALID_RANGE', 'minRange must be a finite number >= 0');
    }

    const rawMaxRange = getOwnValue(rawTargeting, 'maxRange');
    if (typeof rawMaxRange !== 'number' || !Number.isFinite(rawMaxRange) || rawMaxRange < 0) {
      targetAcc.add('maxRange', 'INVALID_RANGE', 'maxRange must be a finite number >= 0');
    } else if (
      typeof rawMinRange === 'number' &&
      Number.isFinite(rawMinRange) &&
      rawMaxRange < rawMinRange
    ) {
      targetAcc.add('maxRange', 'INVALID_RANGE_ORDER', 'maxRange must be >= minRange');
    }

    const rawRadius = getOwnValue(rawTargeting, 'radius');
    let radius: number | undefined;
    if (rawRadius !== undefined) {
      if (typeof rawRadius !== 'number' || !Number.isFinite(rawRadius) || rawRadius < 0) {
        targetAcc.add('radius', 'INVALID_RADIUS', 'radius must be a finite number >= 0');
      } else {
        radius = rawRadius === 0 ? 0 : rawRadius;
      }
    } else if (rawShape === 'aoe_radius') {
      targetAcc.add('radius', 'REQUIRED', 'Targeting shape "aoe_radius" requires radius');
    }

    const rawRequiresLos = getOwnValue(rawTargeting, 'requiresLos');
    if (typeof rawRequiresLos !== 'boolean') {
      targetAcc.add('requiresLos', 'INVALID_TYPE', 'requiresLos must be a boolean');
    }

    if (!targetAcc.hasErrors()) {
      targeting = {
        shape: rawShape as TargetingShape,
        minRange: (rawMinRange as number) === 0 ? 0 : (rawMinRange as number),
        maxRange: (rawMaxRange as number) === 0 ? 0 : (rawMaxRange as number),
        ...(radius !== undefined ? { radius } : {}),
        requiresLos: rawRequiresLos as boolean,
      };
    }
  }

  const rawHit = getOwnValue(raw, 'hitResolution');
  let hitResolution: SkillHitResolutionSpec | undefined;
  if (!isPlainObject(rawHit)) {
    acc.add('hitResolution', 'INVALID_TYPE', 'Skill hitResolution must be a plain object');
  } else {
    const hitAcc = acc.scope('hitResolution');
    checkNoForbiddenKeys(rawHit, hitAcc);

    const rawKind = getOwnValue(rawHit, 'kind');
    if (typeof rawKind !== 'string' || !VALID_HIT_KINDS.has(rawKind)) {
      hitAcc.add(
        'kind',
        'INVALID_HIT_KIND',
        `hitResolution.kind must be one of: ${HIT_RESOLUTION_KINDS.join(', ')}`
      );
    }

    const rawStat = getOwnValue(rawHit, 'stat');
    let stat: string | undefined;
    if (rawStat !== undefined) {
      if (typeof rawStat !== 'string' || !isSafeKey(rawStat.trim())) {
        hitAcc.add('stat', 'INVALID_STRING', 'hitResolution.stat must be a safe non-empty string');
      } else {
        stat = rawStat.trim();
      }
    }

    const rawSaveStat = getOwnValue(rawHit, 'saveStat');
    let saveStat: string | undefined;
    if (rawSaveStat !== undefined) {
      if (typeof rawSaveStat !== 'string' || !isSafeKey(rawSaveStat.trim())) {
        hitAcc.add(
          'saveStat',
          'INVALID_STRING',
          'hitResolution.saveStat must be a safe non-empty string'
        );
      } else {
        saveStat = rawSaveStat.trim();
      }
    }

    const rawDc = getOwnValue(rawHit, 'dc');
    let dc: number | undefined;
    if (rawDc !== undefined) {
      if (typeof rawDc !== 'number' || !Number.isFinite(rawDc) || rawDc < 0) {
        hitAcc.add('dc', 'INVALID_NUMBER', 'hitResolution.dc must be a finite number >= 0');
      } else {
        dc = rawDc === 0 ? 0 : rawDc;
      }
    }

    if (rawKind === 'save') {
      if (saveStat === undefined) {
        hitAcc.add('saveStat', 'REQUIRED', 'hitResolution.kind "save" requires saveStat');
      }
      if (dc === undefined) {
        hitAcc.add('dc', 'REQUIRED', 'hitResolution.kind "save" requires dc');
      }
    }

    if (!hitAcc.hasErrors()) {
      hitResolution = {
        kind: rawKind as HitResolutionKind,
        ...(stat !== undefined ? { stat } : {}),
        ...(saveStat !== undefined ? { saveStat } : {}),
        ...(dc !== undefined ? { dc } : {}),
      };
    }
  }

  const rawEffects = getOwnValue(raw, 'effects');
  const effects: SkillEffectSpec[] = [];
  if (!Array.isArray(rawEffects)) {
    acc.add('effects', 'INVALID_TYPE', 'Skill effects must be an array');
  } else {
    for (let i = 0; i < rawEffects.length; i++) {
      const effectRes = validateSkillEffectSpec(rawEffects[i]);
      if (!effectRes.ok) {
        acc.scope(`effects[${i}]`).addAll(effectRes.error);
      } else {
        effects.push(effectRes.value);
      }
    }
  }

  const rawTags = getOwnValue(raw, 'tags');
  let tags: string[] | undefined;
  if (rawTags !== undefined) {
    if (!Array.isArray(rawTags)) {
      acc.add('tags', 'INVALID_TYPE', 'Skill tags must be an array of strings');
    } else {
      tags = [];
      for (let i = 0; i < rawTags.length; i++) {
        const tag = rawTags[i];
        if (typeof tag !== 'string' || tag.trim().length === 0) {
          acc.add(`tags[${i}]`, 'INVALID_TAG', 'Each skill tag must be a non-empty string');
        } else {
          tags.push(tag.trim());
        }
      }
    }
  }

  if (acc.hasErrors() || targeting === undefined || hitResolution === undefined) {
    return err([...acc.errors]);
  }

  return ok({
    id,
    name,
    ...(description !== undefined ? { description } : {}),
    category: rawCategory as SkillCategory,
    actionCost: rawActionCost as ActionCostType,
    resourceCosts,
    ...(cooldownTurns !== undefined ? { cooldownTurns } : {}),
    targeting,
    hitResolution,
    effects,
    ...(tags !== undefined ? { tags } : {}),
  });
}

/**
 * Validate an unknown skill catalog array, verifying every skill definition and checking
 * for duplicate skill IDs across the catalog.
 */
export function validateSkillCatalog(
  catalog: unknown
): Result<SkillDefinition[], ValidationError[]> {
  if (!Array.isArray(catalog)) {
    return err([validationError('catalog', 'INVALID_TYPE', 'Skill catalog must be an array')]);
  }

  const acc = new ErrorAccumulator();
  const seenIds = new Set<string>();
  const validated: SkillDefinition[] = [];

  for (let i = 0; i < catalog.length; i++) {
    const res = validateSkillDefinition(catalog[i]);
    if (!res.ok) {
      acc.scope(`catalog[${i}]`).addAll(res.error);
      continue;
    }
    const skill = res.value;
    if (seenIds.has(skill.id)) {
      acc.add(`catalog[${i}].id`, 'DUPLICATE_SKILL_ID', `Duplicate skill id "${skill.id}"`);
      continue;
    }
    seenIds.add(skill.id);
    validated.push(skill);
  }

  return acc.toResult(validated);
}

/**
 * In-memory registry storing validated {@link SkillDefinition} entries keyed by skill ID.
 */
export class SkillRegistry {
  private readonly skills = new Map<string, SkillDefinition>();

  constructor(initialSkills: readonly SkillDefinition[] = []) {
    for (const skill of initialSkills) {
      const res = this.register(skill);
      if (!res.ok) {
        throw new RefereeError(
          `Invalid initial skill "${String((skill as { id?: unknown })?.id)}": ${res.error.map((e) => e.message).join('; ')}`,
          { code: 'INVALID_SKILL_DEFINITION', details: res.error }
        );
      }
    }
  }

  /**
   * Validate and register a skill definition into this registry.
   * Rejects invalid definitions or duplicate skill IDs.
   */
  register(skill: SkillDefinition): Result<void, ValidationError[]> {
    const validated = validateSkillDefinition(skill);
    if (!validated.ok) {
      return validated;
    }

    const clean = validated.value;
    if (this.skills.has(clean.id)) {
      return err([
        validationError('id', 'DUPLICATE_SKILL_ID', `Skill "${clean.id}" is already registered`),
      ]);
    }

    this.skills.set(clean.id, clean);
    return ok();
  }

  /**
   * Look up a registered skill by ID, returning a defensive copy or `undefined` if absent.
   */
  get(id: string): SkillDefinition | undefined {
    if (typeof id !== 'string' || !isSafeKey(id)) {
      return undefined;
    }
    const skill = this.skills.get(id);
    return skill !== undefined ? cloneSkillDefinition(skill) : undefined;
  }

  /**
   * Return defensive copies of all registered skills in registration order.
   */
  list(): readonly SkillDefinition[] {
    return Array.from(this.skills.values(), (skill) => cloneSkillDefinition(skill));
  }

  /**
   * Validate an external skill catalog array.
   */
  static validateSkillCatalog(catalog: unknown): Result<SkillDefinition[], ValidationError[]> {
    return validateSkillCatalog(catalog);
  }

  /**
   * Validate an external skill catalog array (instance convenience delegate).
   */
  validateSkillCatalog(catalog: unknown): Result<SkillDefinition[], ValidationError[]> {
    return validateSkillCatalog(catalog);
  }

  /**
   * Build a {@link SkillRegistry} pre-populated with a default tactical combat catalog.
   */
  static createDefaultSkillCatalog(): SkillRegistry {
    return createDefaultSkillCatalog();
  }
}

const DEFAULT_SKILLS: readonly SkillDefinition[] = [
  {
    id: 'basic_strike',
    name: 'Basic Strike',
    description: 'A standard melee weapon strike against an adjacent foe.',
    category: 'attack',
    actionCost: 'action',
    resourceCosts: {},
    targeting: {
      shape: 'single_enemy',
      minRange: 1,
      maxRange: 1,
      requiresLos: true,
    },
    hitResolution: {
      kind: 'attack_roll',
      stat: 'str',
    },
    effects: [
      {
        type: 'damage',
        dice: '1d8',
        scalingStat: 'str',
      },
    ],
    tags: ['melee', 'weapon'],
  },
  {
    id: 'power_strike',
    name: 'Power Strike',
    description: 'A heavy blow that deals bonus damage and knocks the target back.',
    category: 'skill',
    actionCost: 'action',
    resourceCosts: { stamina: 2 },
    cooldownTurns: 1,
    targeting: {
      shape: 'single_enemy',
      minRange: 1,
      maxRange: 1,
      requiresLos: true,
    },
    hitResolution: {
      kind: 'attack_roll',
      stat: 'str',
    },
    effects: [
      {
        type: 'damage',
        dice: '2d8',
        flat: 2,
        scalingStat: 'str',
      },
      {
        type: 'knockback',
        distance: 1,
      },
    ],
    tags: ['melee', 'heavy'],
  },
  {
    id: 'fireball',
    name: 'Fireball',
    description: 'Hurls an explosive orb of fire that ignites targets in an area.',
    category: 'spell',
    actionCost: 'action',
    resourceCosts: { mana: 5 },
    cooldownTurns: 2,
    targeting: {
      shape: 'aoe_radius',
      minRange: 1,
      maxRange: 8,
      radius: 2,
      requiresLos: true,
    },
    hitResolution: {
      kind: 'save',
      saveStat: 'dex',
      dc: 14,
    },
    effects: [
      {
        type: 'damage',
        dice: '3d6',
        scalingStat: 'int',
      },
      {
        type: 'apply_status',
        statusId: 'burning',
        statusDuration: 2,
        statusIntensity: 1,
      },
    ],
    tags: ['fire', 'aoe', 'magic'],
  },
  {
    id: 'healing_word',
    name: 'Healing Word',
    description: 'Mends an ally at range with restorative magic.',
    category: 'spell',
    actionCost: 'bonus',
    resourceCosts: { mana: 3 },
    targeting: {
      shape: 'single_ally',
      minRange: 0,
      maxRange: 6,
      requiresLos: true,
    },
    hitResolution: {
      kind: 'auto',
    },
    effects: [
      {
        type: 'heal',
        dice: '1d6',
        flat: 2,
        scalingStat: 'wis',
      },
    ],
    tags: ['healing', 'magic'],
  },
  {
    id: 'minor_healing_potion',
    name: 'Minor Healing Potion',
    description: 'Consumable tonic that restores health and clears poison.',
    category: 'item',
    actionCost: 'bonus',
    resourceCosts: {},
    targeting: {
      shape: 'self',
      minRange: 0,
      maxRange: 0,
      requiresLos: false,
    },
    hitResolution: {
      kind: 'auto',
    },
    effects: [
      {
        type: 'heal',
        dice: '2d4',
        flat: 2,
      },
      {
        type: 'remove_status',
        statusId: 'poisoned',
      },
    ],
    tags: ['consumable', 'healing'],
  },
  {
    id: 'dash',
    name: 'Dash',
    description: 'Sprints across the battlefield, granting temporary haste.',
    category: 'movement',
    actionCost: 'action',
    resourceCosts: {},
    targeting: {
      shape: 'self',
      minRange: 0,
      maxRange: 0,
      requiresLos: false,
    },
    hitResolution: {
      kind: 'auto',
    },
    effects: [
      {
        type: 'apply_status',
        statusId: 'hasted',
        statusDuration: 1,
        statusIntensity: 1,
      },
    ],
    tags: ['mobility'],
  },
  {
    id: 'guard_stance',
    name: 'Guard Stance',
    description: 'Takes a defensive posture to brace against incoming attacks.',
    category: 'defend',
    actionCost: 'action',
    resourceCosts: {},
    targeting: {
      shape: 'self',
      minRange: 0,
      maxRange: 0,
      requiresLos: false,
    },
    hitResolution: {
      kind: 'auto',
    },
    effects: [
      {
        type: 'apply_status',
        statusId: 'guarded',
        statusDuration: 1,
        statusIntensity: 1,
      },
    ],
    tags: ['defense'],
  },
];

/**
 * Create a {@link SkillRegistry} populated with the default combat skill catalog.
 */
export function createDefaultSkillCatalog(): SkillRegistry {
  return new SkillRegistry(DEFAULT_SKILLS);
}
