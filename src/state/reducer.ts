import { type ValidationError, validationError } from '../core/errors.js';
import { type Result, err, ok } from '../core/result.js';
import { advanceClock, holdClock, parseIsoDate, releaseClock } from '../core/world-clock.js';
import type {
  CompiledFieldPolicy,
  CompiledTrackerSchema,
} from '../schema/dynamic-schema-compiler.js';
import type { DynamicFieldSpec } from '../schema/tracker-module.js';
import type { AuditEntry } from './audit-log.js';
import { type FormIndex, applyFormProfileOverlay, isLegalTransform } from './forms.js';
import {
  type EntityCollectionName,
  PATCH_SOURCES,
  type PatchBatch,
  type PatchOperation,
  type PatchSource,
} from './patch.js';
import {
  type LocationEntity,
  registerOrResolveEmergentLocation,
  slugifyLocationName,
  validateTravelTarget,
} from './spatial-topology.js';
import {
  CHARACTER_STATUSES,
  CHRONICLE_CATEGORIES,
  ENDING_STATUSES,
  FACTION_SIDES,
  FACTION_STATUSES,
  THREAT_RANKS,
  THREAT_STATUSES,
  WORLD_ARCS,
  type CharacterEntity,
  type CharacterProgression,
  type CharacterStatus,
  type ChronicleCategory,
  type ChronicleEntry,
  type EndingStatus,
  type FactionEntity,
  type FactionSide,
  type FactionStatus,
  type RelationEntry,
  type ResourcePool,
  type ThreatEntity,
  type ThreatRank,
  type ThreatStatus,
  type WorldArc,
  type WorldState,
  cloneWorldState,
} from './world-state.js';

/**
 * Optional configuration passed to {@link applyPatchBatch}.
 */
export interface ReducerOptions {
  compiledSchema?: CompiledTrackerSchema;
  formIndex?: FormIndex;
  auditSeqStart?: number;
}

/**
 * Operation rejected by tracker permission or plot-guard gates without aborting valid ops.
 */
export interface RejectedOperation {
  op: PatchOperation;
  reason: string;
}

/**
 * Output produced when {@link applyPatchBatch} commits successfully.
 */
export interface ReducePatchBatchResult {
  nextState: WorldState;
  auditEntries: AuditEntry[];
  changedPaths: Set<string>;
  pendingConfirmations: PatchOperation[];
  rejectedOperations: Array<{ op: PatchOperation; reason: string }>;
  daysElapsed: number;
  slotsElapsed: number;
  expiredTimers: string[];
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const VALID_PATCH_SOURCES: ReadonlySet<string> = new Set(PATCH_SOURCES);
const VALID_CHARACTER_STATUSES: ReadonlySet<string> = new Set(CHARACTER_STATUSES);
const VALID_FACTION_SIDES: ReadonlySet<string> = new Set(FACTION_SIDES);
const VALID_FACTION_STATUSES: ReadonlySet<string> = new Set(FACTION_STATUSES);
const VALID_THREAT_RANKS: ReadonlySet<string> = new Set(THREAT_RANKS);
const VALID_THREAT_STATUSES: ReadonlySet<string> = new Set(THREAT_STATUSES);
const VALID_CHRONICLE_CATEGORIES: ReadonlySet<string> = new Set(CHRONICLE_CATEGORIES);
const VALID_WORLD_ARCS: ReadonlySet<string> = new Set(WORLD_ARCS);
const VALID_ENDING_STATUSES: ReadonlySet<string> = new Set(ENDING_STATUSES);
const VALID_COLLECTIONS: ReadonlySet<string> = new Set([
  'characters',
  'factions',
  'threats',
  'locations',
]);

function isSafeKey(key: string): boolean {
  return key.length > 0 && !FORBIDDEN_KEYS.has(key);
}

function isSafeEntityId(key: string): boolean {
  return (
    isSafeKey(key) &&
    key.trim().length > 0 &&
    !key.includes('.') &&
    !key.includes('/') &&
    !key.includes('\\')
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

function getOwn<T extends object>(obj: T, key: string): unknown {
  if (!isSafeKey(key) || !Object.hasOwn(obj, key)) {
    return undefined;
  }
  return Object.getOwnPropertyDescriptor(obj, key)?.value;
}

function setOwn<T extends object>(obj: T, key: string, value: unknown): void {
  Object.defineProperty(obj, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function normalizeZero(value: number): number {
  return value === 0 ? 0 : value;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function cloneSafeValue(value: unknown, errorPath: string): Result<unknown, ValidationError[]> {
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (let i = 0; i < value.length; i += 1) {
      const clonedItem = cloneSafeValue(value[i], `${errorPath}[${i}]`);
      if (!clonedItem.ok) {
        return clonedItem;
      }
      out.push(clonedItem.value);
    }
    return ok(out);
  }
  if (value instanceof Date) {
    return ok(new Date(value.getTime()));
  }
  if (value !== null && typeof value === 'object') {
    if (!isPlainObject(value)) {
      return err([
        validationError(errorPath, 'INVALID_TYPE', `${errorPath} must be a plain JSON-safe value`),
      ]);
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.getOwnPropertyNames(value)) {
      if (!isSafeKey(key)) {
        return err([
          validationError(errorPath, 'UNSAFE_KEY', `Forbidden key "${key}" at ${errorPath}`),
        ]);
      }
      const val = Object.getOwnPropertyDescriptor(value, key)?.value;
      const clonedChild = cloneSafeValue(val, `${errorPath}.${key}`);
      if (!clonedChild.ok) {
        return clonedChild;
      }
      setOwn(out, key, clonedChild.value);
    }
    return ok(out);
  }
  return ok(value);
}

function cloneForAudit(value: unknown): unknown {
  const res = cloneSafeValue(value, 'audit');
  return res.ok ? res.value : undefined;
}

function cloneOperation(op: PatchOperation): PatchOperation {
  const cloned = cloneForAudit(op);
  return (cloned ?? op) as PatchOperation;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true;
  }
  if (typeof a !== typeof b || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i], b[i])) {
        return false;
      }
    }
    return true;
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const keysA = Object.keys(a as Record<string, unknown>);
    const keysB = Object.keys(b as Record<string, unknown>);
    if (keysA.length !== keysB.length) {
      return false;
    }
    for (const key of keysA) {
      if (!Object.hasOwn(b as object, key)) {
        return false;
      }
      const valA = getOwn(a as object, key);
      const valB = getOwn(b as object, key);
      if (!deepEqual(valA, valB)) {
        return false;
      }
    }
    return true;
  }
  return false;
}

function parseDotPath(path: string, errorPath: string): Result<string[], ValidationError[]> {
  if (typeof path !== 'string' || path.trim().length === 0) {
    return err([validationError(errorPath, 'INVALID_PATH', 'Path must be a non-empty string')]);
  }
  const segments = path.split('.');
  for (const seg of segments) {
    if (!isSafeKey(seg)) {
      return err([
        validationError(errorPath, 'UNSAFE_PATH', `Invalid or forbidden path segment in "${path}"`),
      ]);
    }
  }
  return ok(segments);
}

function buildPolicyLookupCandidates(canonicalPath: string, state: WorldState): string[] {
  const candidates: string[] = [];
  const pushUnique = (candidate: string): void => {
    if (!candidates.includes(candidate)) {
      candidates.push(candidate);
    }
  };

  pushUnique(canonicalPath);

  if (canonicalPath.includes('.customFields.')) {
    pushUnique(canonicalPath.replace('.customFields.', '.custom_fields.'));
  }
  if (canonicalPath.startsWith('customFields.')) {
    pushUnique(`custom_fields.${canonicalPath.slice('customFields.'.length)}`);
  }

  if (canonicalPath.startsWith('player.customFields.')) {
    const rest = canonicalPath.slice('player.customFields.'.length);
    pushUnique(`player.custom_fields.${rest}`);
    pushUnique(`entities.characters.player.custom_fields.${rest}`);
    pushUnique(`entities.characters.player.customFields.${rest}`);
    if (state.player.characterId !== null) {
      pushUnique(`entities.characters.${state.player.characterId}.custom_fields.${rest}`);
      pushUnique(`entities.characters.${state.player.characterId}.customFields.${rest}`);
    }
  }

  if (canonicalPath.startsWith('player.sections.')) {
    const rest = canonicalPath.slice('player.sections.'.length);
    pushUnique(`entities.characters.player.sections.${rest}`);
    if (state.player.characterId !== null) {
      pushUnique(`entities.characters.${state.player.characterId}.sections.${rest}`);
    }
  }

  if (canonicalPath.startsWith('player.progression.')) {
    const rest = canonicalPath.slice('player.progression.'.length);
    pushUnique(`entities.characters.player.progression.${rest}`);
    if (rest === 'className') {
      pushUnique('player.progression.class');
      pushUnique('entities.characters.player.progression.class');
    }
  }

  if (canonicalPath.startsWith('player.resources.')) {
    const rest = canonicalPath.slice('player.resources.'.length);
    pushUnique(`entities.characters.player.resources.${rest}`);
    if (rest.endsWith('.current')) {
      const resourceKey = rest.slice(0, -'.current'.length);
      pushUnique(`player.resources.${resourceKey}`);
      pushUnique(`entities.characters.player.resources.${resourceKey}`);
    }
  }

  if (canonicalPath.startsWith('entities.characters.')) {
    const segments = canonicalPath.split('.');
    const charId = segments[2];
    if (charId !== undefined) {
      if (segments[3] === 'resources' && segments[4] !== undefined && segments[5] === 'current') {
        pushUnique(`entities.characters.${charId}.resources.${segments[4]}`);
      }
      if (segments[3] === 'progression' && segments[4] === 'className') {
        pushUnique(`entities.characters.${charId}.progression.class`);
      }
      if (state.player.characterId !== null && charId === state.player.characterId) {
        const tail = segments.slice(3).join('.');
        pushUnique(`entities.characters.player.${tail}`);
        if (tail.startsWith('customFields.')) {
          pushUnique(`entities.characters.player.custom_fields.${tail.slice('customFields.'.length)}`);
        }
        if (segments[3] === 'resources' && segments[4] !== undefined && segments[5] === 'current') {
          pushUnique(`entities.characters.player.resources.${segments[4]}`);
        }
      }
    }
  }

  return candidates;
}

function matchPattern(patternSegments: string[], candidateSegments: string[]): number | null {
  if (patternSegments.length !== candidateSegments.length) {
    return null;
  }
  let wildcardWeight = 0;
  for (let i = 0; i < patternSegments.length; i += 1) {
    const pat = patternSegments[i];
    const seg = candidateSegments[i];
    if (pat === undefined || seg === undefined) {
      return null;
    }
    if (pat === '*') {
      wildcardWeight += 1;
    } else if (pat.endsWith('*') && seg.startsWith(pat.slice(0, -1))) {
      wildcardWeight += 0.5;
    } else if (pat !== seg) {
      return null;
    }
  }
  return wildcardWeight;
}

function lookupFieldPolicy(
  compiledSchema: CompiledTrackerSchema | undefined,
  canonicalPath: string,
  state: WorldState
): CompiledFieldPolicy | undefined {
  if (!compiledSchema) {
    return undefined;
  }
  const { fieldPolicyMap } = compiledSchema;
  const candidates = buildPolicyLookupCandidates(canonicalPath, state);

  for (const candidate of candidates) {
    const exact = fieldPolicyMap.get(candidate);
    if (exact !== undefined) {
      return exact;
    }
  }

  let bestPolicy: CompiledFieldPolicy | undefined;
  let bestWildcards = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    const candidateSegs = candidate.split('.');
    for (const [pattern, policy] of fieldPolicyMap.entries()) {
      if (!pattern.includes('*')) {
        continue;
      }
      const wildcards = matchPattern(pattern.split('.'), candidateSegs);
      if (wildcards === null) {
        continue;
      }
      if (
        wildcards < bestWildcards ||
        (wildcards === bestWildcards && bestPolicy !== undefined && pattern < bestPolicy.pathPattern)
      ) {
        bestWildcards = wildcards;
        bestPolicy = policy;
      }
    }
    if (bestPolicy !== undefined) {
      return bestPolicy;
    }
  }

  return undefined;
}

type TrackerGateDecision =
  | { action: 'allow' }
  | { action: 'reject'; reason: string }
  | { action: 'pending'; reason: string };

function evaluateTrackerGate(
  source: PatchSource,
  canonicalPath: string,
  policy: CompiledFieldPolicy | undefined
): TrackerGateDecision {
  if (source !== 'tracker') {
    return { action: 'allow' };
  }

  // Hard plot guard: tracker cannot mutate flags.route_* unless explicitly marked writable in fieldPolicyMap.
  if (canonicalPath.startsWith('flags.route_')) {
    if (!policy || !policy.writableByTracker || policy.confirmPolicy === 'locked') {
      return {
        action: 'reject',
        reason: `Hard plot guard: tracker cannot mutate "${canonicalPath}" without explicit writable policy`,
      };
    }
  }

  if (!policy) {
    return { action: 'allow' };
  }

  if (!policy.writableByTracker || policy.confirmPolicy === 'locked') {
    return {
      action: 'reject',
      reason: `Field "${canonicalPath}" is locked / non-writable for tracker`,
    };
  }

  if (policy.confirmPolicy === 'always_confirm' || policy.confirmPolicy === 'batch_confirm') {
    return {
      action: 'pending',
      reason: `Field "${canonicalPath}" requires "${policy.confirmPolicy}" confirmation`,
    };
  }

  return { action: 'allow' };
}

function enforceDynamicFieldSpec(
  spec: DynamicFieldSpec,
  value: unknown,
  path: string
): Result<unknown, ValidationError[]> {
  switch (spec.type) {
    case 'meter': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return err([
          validationError(path, 'INVALID_TYPE', `Field "${path}" requires a finite number (meter)`),
        ]);
      }
      const clamped = Math.min(spec.max, Math.max(spec.min, value));
      return ok(normalizeZero(clamped));
    }
    case 'counter': {
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        return err([
          validationError(path, 'INVALID_INTEGER', `Field "${path}" requires an integer (counter)`),
        ]);
      }
      let nextVal = value;
      if (spec.min !== undefined) {
        nextVal = Math.max(spec.min, nextVal);
      }
      if (spec.max !== undefined) {
        nextVal = Math.min(spec.max, nextVal);
      }
      return ok(normalizeZero(nextVal));
    }
    case 'enum': {
      if (typeof value !== 'string' || !spec.options.includes(value)) {
        return err([
          validationError(
            path,
            'INVALID_ENUM',
            `Field "${path}" must be one of [${spec.options.join(', ')}]`
          ),
        ]);
      }
      return ok(value);
    }
    case 'boolean': {
      if (typeof value !== 'boolean') {
        return err([
          validationError(path, 'INVALID_TYPE', `Field "${path}" requires a boolean`),
        ]);
      }
      return ok(value);
    }
    case 'string': {
      if (typeof value !== 'string') {
        return err([
          validationError(path, 'INVALID_TYPE', `Field "${path}" requires a string`),
        ]);
      }
      if (spec.maxLength !== undefined && value.length > spec.maxLength) {
        return err([
          validationError(
            path,
            'EXCEEDS_MAX_LENGTH',
            `Field "${path}" length ${value.length} exceeds maxLength ${spec.maxLength}`
          ),
        ]);
      }
      return ok(value);
    }
    case 'string_list': {
      if (!isStringArray(value)) {
        return err([
          validationError(path, 'INVALID_TYPE', `Field "${path}" requires an array of strings`),
        ]);
      }
      if (spec.maxItems !== undefined && value.length > spec.maxItems) {
        return err([
          validationError(
            path,
            'EXCEEDS_MAX_ITEMS',
            `Field "${path}" item count ${value.length} exceeds maxItems ${spec.maxItems}`
          ),
        ]);
      }
      return ok([...value]);
    }
  }
}

interface ResolvedTarget {
  canonicalPath: string;
  read: () => unknown;
  write: (value: unknown) => Result<void, ValidationError[]>;
  defaultIncrementBase?: number;
  allowPushCreate?: boolean;
  validateValue: (value: unknown) => Result<unknown, ValidationError[]>;
}

function validateNullableString(value: unknown, path: string): Result<string | null, ValidationError[]> {
  if (value !== null && typeof value !== 'string') {
    return err([validationError(path, 'INVALID_TYPE', `${path} must be a string or null`)]);
  }
  return ok(value);
}

function validateFiniteNumber(value: unknown, path: string): Result<number, ValidationError[]> {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return err([validationError(path, 'INVALID_NUMBER', `${path} must be a finite number`)]);
  }
  return ok(normalizeZero(value));
}

function validateNonNegInt(value: unknown, path: string): Result<number, ValidationError[]> {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return err([
      validationError(path, 'INVALID_INTEGER', `${path} must be a non-negative integer`),
    ]);
  }
  return ok(normalizeZero(value));
}

function validateCharacterIdsExist(
  ids: unknown,
  state: WorldState,
  path: string
): Result<string[], ValidationError[]> {
  if (!isStringArray(ids)) {
    return err([validationError(path, 'INVALID_TYPE', `${path} must be an array of strings`)]);
  }
  for (const id of ids) {
    if (!isSafeKey(id) || !Object.hasOwn(state.entities.characters, id)) {
      return err([
        validationError(
          path,
          'UNRESOLVED_CHARACTER',
          `${path} references unknown character "${id}"`
        ),
      ]);
    }
  }
  return ok([...ids]);
}

function validateResourcePool(value: unknown, path: string): Result<ResourcePool, ValidationError[]> {
  if (!isPlainObject(value)) {
    return err([validationError(path, 'INVALID_TYPE', `${path} must be a ResourcePool object`)]);
  }
  const current = getOwn(value, 'current');
  const max = getOwn(value, 'max');
  if (typeof current !== 'number' || !Number.isFinite(current) || current < 0) {
    return err([
      validationError(`${path}.current`, 'INVALID_NUMBER', 'ResourcePool current must be >= 0'),
    ]);
  }
  if (typeof max !== 'number' || !Number.isFinite(max) || max < 0) {
    return err([
      validationError(`${path}.max`, 'INVALID_NUMBER', 'ResourcePool max must be >= 0'),
    ]);
  }
  if (current > max) {
    return err([
      validationError(`${path}.current`, 'OUT_OF_RANGE', 'ResourcePool current cannot exceed max'),
    ]);
  }
  return ok({ current: normalizeZero(current), max: normalizeZero(max) });
}

function validateRelationEntry(
  value: unknown,
  path: string
): Result<RelationEntry, ValidationError[]> {
  if (!isPlainObject(value)) {
    return err([validationError(path, 'INVALID_TYPE', `${path} must be a RelationEntry object`)]);
  }
  const affinity = getOwn(value, 'affinity');
  const maxAffinity = getOwn(value, 'maxAffinity');
  const label = getOwn(value, 'label');
  const tags = getOwn(value, 'tags');
  if (typeof affinity !== 'number' || !Number.isFinite(affinity)) {
    return err([validationError(`${path}.affinity`, 'INVALID_NUMBER', 'affinity must be finite')]);
  }
  if (typeof maxAffinity !== 'number' || !Number.isFinite(maxAffinity) || maxAffinity < 0) {
    return err([
      validationError(`${path}.maxAffinity`, 'INVALID_NUMBER', 'maxAffinity must be >= 0'),
    ]);
  }
  if (typeof label !== 'string') {
    return err([validationError(`${path}.label`, 'INVALID_TYPE', 'label must be a string')]);
  }
  if (!isStringArray(tags)) {
    return err([validationError(`${path}.tags`, 'INVALID_TYPE', 'tags must be string[]')]);
  }
  return ok({
    affinity: normalizeZero(affinity),
    maxAffinity: normalizeZero(maxAffinity),
    label,
    tags: [...tags],
  });
}

function validateEntityFieldValue(
  collection: EntityCollectionName,
  entity: CharacterEntity | FactionEntity | ThreatEntity | LocationEntity,
  field: string,
  value: unknown,
  path: string,
  state: WorldState
): Result<unknown, ValidationError[]> {
  if (field === 'id') {
    if (value !== entity.id) {
      return err([validationError(path, 'ID_IMMUTABLE', `Cannot change entity id "${entity.id}"`)]);
    }
    return ok(value);
  }

  switch (collection) {
    case 'characters': {
      switch (field) {
        case 'name':
        case 'agenda':
        case 'allegiance':
        case 'mood':
          return typeof value === 'string'
            ? ok(value)
            : err([validationError(path, 'INVALID_TYPE', `${path} must be a string`)]);
        case 'status':
          return typeof value === 'string' && VALID_CHARACTER_STATUSES.has(value)
            ? ok(value as CharacterStatus)
            : err([validationError(path, 'INVALID_ENUM', `Invalid CharacterStatus "${String(value)}"`)]);
        case 'presentInScene':
          return typeof value === 'boolean'
            ? ok(value)
            : err([validationError(path, 'INVALID_TYPE', `${path} must be a boolean`)]);
        case 'locationId':
        case 'formId':
        case 'formGroup':
          return validateNullableString(value, path);
        case 'abilities':
        case 'goals':
        case 'traits':
          return isStringArray(value)
            ? ok([...value])
            : err([validationError(path, 'INVALID_TYPE', `${path} must be string[]`)]);
        case 'sections': {
          if (!isPlainObject(value)) {
            return err([validationError(path, 'INVALID_TYPE', `${path} must be a plain record`)]);
          }
          const out: Record<string, string | string[]> = {};
          for (const [k, v] of Object.entries(value)) {
            if (!isSafeKey(k)) {
              return err([validationError(`${path}.${k}`, 'UNSAFE_KEY', `Forbidden key "${k}"`)]);
            }
            if (typeof v === 'string') {
              setOwn(out, k, v);
            } else if (isStringArray(v)) {
              setOwn(out, k, [...v]);
            } else {
              return err([
                validationError(`${path}.${k}`, 'INVALID_TYPE', 'Section value must be string or string[]'),
              ]);
            }
          }
          return ok(out);
        }
        case 'customFields': {
          if (!isPlainObject(value)) {
            return err([validationError(path, 'INVALID_TYPE', `${path} must be a plain record`)]);
          }
          return cloneSafeValue(value, path);
        }
        case 'resources': {
          if (!isPlainObject(value)) {
            return err([validationError(path, 'INVALID_TYPE', `${path} must be a plain record`)]);
          }
          const out: Record<string, ResourcePool> = {};
          for (const [k, v] of Object.entries(value)) {
            if (!isSafeKey(k)) {
              return err([validationError(`${path}.${k}`, 'UNSAFE_KEY', `Forbidden key "${k}"`)]);
            }
            const pool = validateResourcePool(v, `${path}.${k}`);
            if (!pool.ok) {
              return pool;
            }
            setOwn(out, k, pool.value);
          }
          return ok(out);
        }
        case 'progression': {
          if (!isPlainObject(value)) {
            return err([validationError(path, 'INVALID_TYPE', `${path} must be an object`)]);
          }
          const level = getOwn(value, 'level');
          const xp = getOwn(value, 'xp');
          if (typeof level !== 'number' || !Number.isInteger(level) || level < 1) {
            return err([validationError(`${path}.level`, 'INVALID_INTEGER', 'level must be >= 1')]);
          }
          if (typeof xp !== 'number' || !Number.isFinite(xp) || xp < 0) {
            return err([validationError(`${path}.xp`, 'INVALID_NUMBER', 'xp must be >= 0')]);
          }
          return cloneSafeValue(value, path);
        }
        case 'corruption': {
          if (!isPlainObject(value)) {
            return err([validationError(path, 'INVALID_TYPE', `${path} must be an object`)]);
          }
          const stage = getOwn(value, 'stage');
          const progress = getOwn(value, 'progress');
          const source = getOwn(value, 'source');
          if (typeof stage !== 'number' || !Number.isInteger(stage) || stage < 0) {
            return err([validationError(`${path}.stage`, 'INVALID_INTEGER', 'stage must be >= 0')]);
          }
          if (typeof progress !== 'number' || !Number.isFinite(progress) || progress < 0 || progress > 100) {
            return err([
              validationError(`${path}.progress`, 'OUT_OF_RANGE', 'progress must be in [0, 100]'),
            ]);
          }
          if (source !== null && typeof source !== 'string') {
            return err([
              validationError(`${path}.source`, 'INVALID_TYPE', 'source must be string or null'),
            ]);
          }
          return ok({ stage, progress: normalizeZero(progress), source });
        }
        default:
          return err([
            validationError(path, 'INVALID_PATH', `Unknown CharacterEntity field "${field}"`),
          ]);
      }
    }
    case 'factions': {
      switch (field) {
        case 'name':
          return typeof value === 'string' && value.trim().length > 0
            ? ok(value)
            : err([validationError(path, 'REQUIRED', `${path} must be a non-empty string`)]);
        case 'side':
          return typeof value === 'string' && VALID_FACTION_SIDES.has(value)
            ? ok(value as FactionSide)
            : err([validationError(path, 'INVALID_ENUM', `Invalid FactionSide "${String(value)}"`)]);
        case 'status':
          return typeof value === 'string' && VALID_FACTION_STATUSES.has(value)
            ? ok(value as FactionStatus)
            : err([validationError(path, 'INVALID_ENUM', `Invalid FactionStatus "${String(value)}"`)]);
        case 'influence':
          if (typeof value !== 'number' || !Number.isFinite(value)) {
            return err([validationError(path, 'INVALID_NUMBER', 'influence must be finite')]);
          }
          return ok(normalizeZero(Math.min(100, Math.max(0, value))));
        case 'headquartersLocationId':
          if (value !== null && typeof value !== 'string') {
            return err([validationError(path, 'INVALID_TYPE', `${path} must be string or null`)]);
          }
          if (
            value !== null &&
            state.capabilities.spatialMode === 'authored_graph' &&
            !Object.hasOwn(state.entities.locations, value)
          ) {
            return err([
              validationError(path, 'UNRESOLVED_LOCATION', `Location "${value}" does not exist`),
            ]);
          }
          return ok(value);
        case 'goals':
          return isStringArray(value)
            ? ok([...value])
            : err([validationError(path, 'INVALID_TYPE', `${path} must be string[]`)]);
        default:
          return err([
            validationError(path, 'INVALID_PATH', `Unknown FactionEntity field "${field}"`),
          ]);
      }
    }
    case 'threats': {
      switch (field) {
        case 'name':
          return typeof value === 'string' && value.trim().length > 0
            ? ok(value)
            : err([validationError(path, 'REQUIRED', `${path} must be a non-empty string`)]);
        case 'agenda':
          return typeof value === 'string'
            ? ok(value)
            : err([validationError(path, 'INVALID_TYPE', `${path} must be a string`)]);
        case 'rank':
          return typeof value === 'string' && VALID_THREAT_RANKS.has(value)
            ? ok(value as ThreatRank)
            : err([validationError(path, 'INVALID_ENUM', `Invalid ThreatRank "${String(value)}"`)]);
        case 'status':
          return typeof value === 'string' && VALID_THREAT_STATUSES.has(value)
            ? ok(value as ThreatStatus)
            : err([validationError(path, 'INVALID_ENUM', `Invalid ThreatStatus "${String(value)}"`)]);
        case 'stage':
          return validateNonNegInt(value, path);
        case 'progress':
          if (typeof value !== 'number' || !Number.isFinite(value)) {
            return err([validationError(path, 'INVALID_NUMBER', 'progress must be finite')]);
          }
          return ok(normalizeZero(Math.min(100, Math.max(0, value))));
        case 'locationId':
        case 'sourceFactionId':
          return validateNullableString(value, path);
        default:
          return err([
            validationError(path, 'INVALID_PATH', `Unknown ThreatEntity field "${field}"`),
          ]);
      }
    }
    case 'locations': {
      switch (field) {
        case 'name':
          return typeof value === 'string' && value.trim().length > 0
            ? ok(value)
            : err([validationError(path, 'REQUIRED', `${path} must be a non-empty string`)]);
        case 'kind':
        case 'status':
        case 'notes':
          return typeof value === 'string'
            ? ok(value)
            : err([validationError(path, 'INVALID_TYPE', `${path} must be a string`)]);
        case 'controllingFactionId':
          return validateNullableString(value, path);
        case 'discovered':
          return typeof value === 'boolean'
            ? ok(value)
            : err([validationError(path, 'INVALID_TYPE', `${path} must be a boolean`)]);
        case 'connectedLocations': {
          if (!isStringArray(value)) {
            return err([validationError(path, 'INVALID_TYPE', `${path} must be string[]`)]);
          }
          if (state.capabilities.spatialMode === 'authored_graph') {
            for (const connId of value) {
              if (connId === entity.id) {
                return err([
                  validationError(
                    path,
                    'SELF_CONNECTED_LOCATION',
                    `Location "${entity.id}" cannot connect to itself`
                  ),
                ]);
              }
              if (!isSafeKey(connId) || !Object.hasOwn(state.entities.locations, connId)) {
                return err([
                  validationError(
                    path,
                    'UNRESOLVED_LOCATION',
                    `Connected location "${connId}" does not resolve in entities.locations`
                  ),
                ]);
              }
            }
          }
          return ok([...value]);
        }
        case 'tags':
          return isStringArray(value)
            ? ok([...value])
            : err([validationError(path, 'INVALID_TYPE', `${path} must be string[]`)]);
        default:
          return err([
            validationError(path, 'INVALID_PATH', `Unknown LocationEntity field "${field}"`),
          ]);
      }
    }
  }
}

function resolveResourcePath(
  resources: Record<string, ResourcePool> | undefined,
  tail: string[],
  canonicalPath: string
): Result<ResolvedTarget, ValidationError[]> {
  if (tail.length === 1) {
    const resKey = tail[0] as string;
    return ok({
      canonicalPath,
      read: () => (resources ? getOwn(resources, resKey) : undefined),
      validateValue: (v) => validateResourcePool(v, canonicalPath),
      write: (v) => {
        if (!resources) {
          return err([
            validationError(
              canonicalPath,
              'MISSING_SUBSYSTEM',
              `Resources container does not exist for "${canonicalPath}"`
            ),
          ]);
        }
        setOwn(resources, resKey, v);
        return ok(undefined);
      },
    });
  }
  if (tail.length === 2 && (tail[1] === 'current' || tail[1] === 'max')) {
    const resKey = tail[0] as string;
    const subKey = tail[1];
    if (!resources || !Object.hasOwn(resources, resKey)) {
      return err([
        validationError(canonicalPath, 'ENTITY_NOT_FOUND', `Resource "${resKey}" does not exist`),
      ]);
    }
    const pool = getOwn(resources, resKey) as ResourcePool;
    return ok({
      canonicalPath,
      read: () => getOwn(pool, subKey),
      validateValue: (v) => {
        const numRes = validateFiniteNumber(v, canonicalPath);
        if (!numRes.ok) {
          return numRes;
        }
        if (subKey === 'current') {
          return ok(normalizeZero(Math.min(pool.max, Math.max(0, numRes.value))));
        }
        if (numRes.value < 0) {
          return err([validationError(canonicalPath, 'OUT_OF_RANGE', 'Resource max must be >= 0')]);
        }
        return ok(numRes.value);
      },
      write: (v) => {
        setOwn(pool, subKey, v as number);
        if (subKey === 'max' && pool.current > pool.max) {
          pool.current = pool.max;
        }
        return ok(undefined);
      },
    });
  }
  return err([validationError(canonicalPath, 'INVALID_PATH', `Invalid resource path "${canonicalPath}"`)]);
}

function resolveProgressionPath(
  progression: CharacterEntity['progression'],
  tail: string[],
  canonicalPath: string
): Result<ResolvedTarget, ValidationError[]> {
  if (!progression) {
    return err([
      validationError(
        canonicalPath,
        'MISSING_SUBSYSTEM',
        `Progression is not enabled on target at "${canonicalPath}"`
      ),
    ]);
  }
  const field = tail[0];
  if (tail.length === 1 && (field === 'level' || field === 'xp' || field === 'className' || field === 'subclass')) {
    return ok({
      canonicalPath,
      read: () => getOwn(progression, field),
      validateValue: (v) => {
        if (field === 'level') {
          if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
            return err([validationError(canonicalPath, 'INVALID_INTEGER', 'level must be integer >= 1')]);
          }
          return ok(v);
        }
        if (field === 'xp') {
          if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
            return err([validationError(canonicalPath, 'INVALID_NUMBER', 'xp must be >= 0')]);
          }
          return ok(normalizeZero(v));
        }
        if (typeof v !== 'string') {
          return err([validationError(canonicalPath, 'INVALID_TYPE', `${canonicalPath} must be string`)]);
        }
        return ok(v);
      },
      write: (v) => {
        setOwn(progression, field, v);
        return ok(undefined);
      },
    });
  }
  if (tail.length === 2 && field === 'attributes') {
    const attrKey = tail[1] as string;
    return ok({
      canonicalPath,
      read: () => (progression.attributes ? getOwn(progression.attributes, attrKey) : undefined),
      validateValue: (v) => validateFiniteNumber(v, canonicalPath),
      write: (v) => {
        if (!progression.attributes) {
          progression.attributes = {};
        }
        setOwn(progression.attributes, attrKey, v as number);
        return ok(undefined);
      },
    });
  }
  return err([validationError(canonicalPath, 'INVALID_PATH', `Invalid progression path "${canonicalPath}"`)]);
}

function resolveNestedRecordTarget(
  rootRecord: Record<string, unknown>,
  tail: string[],
  canonicalPath: string
): Result<ResolvedTarget, ValidationError[]> {
  if (tail.length === 0) {
    return err([validationError(canonicalPath, 'INVALID_PATH', `Missing key in "${canonicalPath}"`)]);
  }
  let cursor: Record<string, unknown> = rootRecord;
  for (let i = 0; i < tail.length - 1; i += 1) {
    const seg = tail[i] as string;
    const child = getOwn(cursor, seg);
    if (!isPlainObject(child)) {
      return err([
        validationError(
          canonicalPath,
          'INVALID_PATH',
          `Intermediate segment "${seg}" in "${canonicalPath}" does not exist as a plain object`
        ),
      ]);
    }
    cursor = child;
  }
  const leafKey = tail[tail.length - 1] as string;
  return ok({
    canonicalPath,
    defaultIncrementBase: 0,
    allowPushCreate: true,
    read: () => getOwn(cursor, leafKey),
    validateValue: (v) => cloneSafeValue(v, canonicalPath),
    write: (v) => {
      setOwn(cursor, leafKey, v);
      return ok(undefined);
    },
  });
}

function resolveWorldStateTarget(
  state: WorldState,
  path: string
): Result<ResolvedTarget, ValidationError[]> {
  const segRes = parseDotPath(path, 'path');
  if (!segRes.ok) {
    return segRes;
  }
  const segs = segRes.value;
  const root = segs[0] as string;

  if (root === 'flags' && segs.length === 2) {
    const key = segs[1] as string;
    return ok({
      canonicalPath: path,
      read: () => getOwn(state.flags, key),
      validateValue: (v) =>
        typeof v === 'boolean'
          ? ok(v)
          : err([validationError(path, 'INVALID_TYPE', `${path} must be a boolean`)]),
      write: (v) => {
        setOwn(state.flags, key, v as boolean);
        return ok(undefined);
      },
    });
  }

  if (root === 'counters' && segs.length === 2) {
    const key = segs[1] as string;
    return ok({
      canonicalPath: path,
      defaultIncrementBase: 0,
      read: () => getOwn(state.counters, key),
      validateValue: (v) => validateFiniteNumber(v, path),
      write: (v) => {
        setOwn(state.counters, key, v as number);
        return ok(undefined);
      },
    });
  }

  if (root === 'customFields' && segs.length >= 2) {
    return resolveNestedRecordTarget(state.customFields, segs.slice(1), path);
  }

  if (root === 'meta' && segs.length === 2) {
    const field = segs[1] as string;
    if (!Object.hasOwn(state.meta, field) || field === 'rngState') {
      return err([validationError(path, 'INVALID_PATH', `Cannot directly patch "${path}"`)]);
    }
    return ok({
      canonicalPath: path,
      read: () => getOwn(state.meta, field),
      validateValue: (v) => {
        switch (field) {
          case 'sessionId':
            return typeof v === 'string' && v.trim().length > 0
              ? ok(v)
              : err([validationError(path, 'REQUIRED', 'sessionId must be non-empty string')]);
          case 'turn':
            return validateNonNegInt(v, path);
          case 'arc':
            return typeof v === 'string' && VALID_WORLD_ARCS.has(v)
              ? ok(v as WorldArc)
              : err([validationError(path, 'INVALID_ENUM', `Invalid arc "${String(v)}"`)]);
          case 'endingStatus':
            return typeof v === 'string' && VALID_ENDING_STATUSES.has(v)
              ? ok(v as EndingStatus)
              : err([validationError(path, 'INVALID_ENUM', `Invalid endingStatus "${String(v)}"`)]);
          case 'activeEndingId':
            return validateNullableString(v, path);
          default:
            return err([validationError(path, 'INVALID_PATH', `Invalid meta path "${path}"`)]);
        }
      },
      write: (v) => {
        setOwn(state.meta, field, v);
        return ok(undefined);
      },
    });
  }

  if (root === 'scene' && segs.length === 2) {
    const field = segs[1] as string;
    if (!Object.hasOwn(state.scene, field)) {
      return err([validationError(path, 'INVALID_PATH', `Unknown scene field "${field}"`)]);
    }
    return ok({
      canonicalPath: path,
      read: () => getOwn(state.scene, field),
      validateValue: (v) => {
        switch (field) {
          case 'location':
          case 'mood':
          case 'pacing':
            return typeof v === 'string'
              ? ok(v)
              : err([validationError(path, 'INVALID_TYPE', `${path} must be a string`)]);
          case 'locationId':
          case 'directorNudge':
            if (v !== null && typeof v !== 'string') {
              return err([validationError(path, 'INVALID_TYPE', `${path} must be string or null`)]);
            }
            if (
              field === 'locationId' &&
              v !== null &&
              state.capabilities.spatialMode === 'authored_graph' &&
              !Object.hasOwn(state.entities.locations, v)
            ) {
              return err([
                validationError(path, 'UNRESOLVED_LOCATION', `Location "${v}" does not exist`),
              ]);
            }
            return ok(v);
          case 'presentCharacterIds':
          case 'pinnedCharacterIds':
            return validateCharacterIdsExist(v, state, path);
          default:
            return err([validationError(path, 'INVALID_PATH', `Unknown scene field "${field}"`)]);
        }
      },
      write: (v) => {
        setOwn(state.scene, field, v);
        return ok(undefined);
      },
    });
  }

  if (root === 'player' && segs.length >= 2) {
    const field = segs[1] as string;
    if (segs.length === 2 && (field === 'id' || field === 'name' || field === 'characterId' || field === 'locationId')) {
      return ok({
        canonicalPath: path,
        read: () => getOwn(state.player, field),
        validateValue: (v) => {
          if (field === 'id') {
            return typeof v === 'string' && v.trim().length > 0
              ? ok(v)
              : err([validationError(path, 'REQUIRED', 'player.id must be non-empty string')]);
          }
          if (field === 'name') {
            return typeof v === 'string'
              ? ok(v)
              : err([validationError(path, 'INVALID_TYPE', 'player.name must be a string')]);
          }
          if (field === 'characterId') {
            if (v !== null && (typeof v !== 'string' || !Object.hasOwn(state.entities.characters, v))) {
              return err([
                validationError(path, 'UNRESOLVED_CHARACTER', `Character "${String(v)}" not found`),
              ]);
            }
            return ok(v);
          }
          if (v !== null && typeof v !== 'string') {
            return err([validationError(path, 'INVALID_TYPE', `${path} must be string or null`)]);
          }
          if (
            v !== null &&
            state.capabilities.spatialMode === 'authored_graph' &&
            !Object.hasOwn(state.entities.locations, v)
          ) {
            return err([
              validationError(path, 'UNRESOLVED_LOCATION', `Location "${v}" does not exist`),
            ]);
          }
          return ok(v);
        },
        write: (v) => {
          setOwn(state.player, field, v);
          return ok(undefined);
        },
      });
    }
    if (field === 'inventory' && segs.length === 4 && (segs[2] === 'items' || segs[2] === 'currency')) {
      const bucket = segs[2] === 'items' ? state.player.inventory.items : state.player.inventory.currency;
      const itemKey = segs[3] as string;
      return ok({
        canonicalPath: path,
        defaultIncrementBase: 0,
        read: () => getOwn(bucket, itemKey),
        validateValue: (v) => validateFiniteNumber(v, path),
        write: (v) => {
          setOwn(bucket, itemKey, v as number);
          return ok(undefined);
        },
      });
    }
    if (field === 'customFields' && segs.length >= 3) {
      return resolveNestedRecordTarget(state.player.customFields, segs.slice(2), path);
    }
    if (field === 'sections' && segs.length === 3) {
      const secKey = segs[2] as string;
      return ok({
        canonicalPath: path,
        allowPushCreate: true,
        read: () => getOwn(state.player.sections, secKey),
        validateValue: (v) => {
          if (typeof v === 'string') {
            return ok(v);
          }
          if (isStringArray(v)) {
            return ok([...v]);
          }
          return err([
            validationError(path, 'INVALID_TYPE', `${path} must be a string or string[]`),
          ]);
        },
        write: (v) => {
          setOwn(state.player.sections, secKey, v as string | string[]);
          return ok(undefined);
        },
      });
    }
    if (field === 'progression' && segs.length >= 3) {
      return resolveProgressionPath(state.player.progression, segs.slice(2), path);
    }
    if (field === 'resources' && segs.length >= 3) {
      return resolveResourcePath(state.player.resources, segs.slice(2), path);
    }
    return err([validationError(path, 'INVALID_PATH', `Invalid player path "${path}"`)]);
  }

  if (root === 'turnEvents' && segs.length === 2) {
    const field = segs[1] as string;
    if (field !== 'combatOutcomes' && field !== 'rumors' && field !== 'systemNotices') {
      return err([validationError(path, 'INVALID_PATH', `Invalid turnEvents path "${path}"`)]);
    }
    return ok({
      canonicalPath: path,
      read: () => getOwn(state.turnEvents, field),
      validateValue: (v) =>
        isStringArray(v)
          ? ok([...v])
          : err([validationError(path, 'INVALID_TYPE', `${path} must be string[]`)]),
      write: (v) => {
        setOwn(state.turnEvents, field, v as string[]);
        return ok(undefined);
      },
    });
  }

  if (root === 'clocks' && segs.length >= 2) {
    const field = segs[1] as string;
    if (segs.length === 2) {
      if (field === 'slotsPerDay' || field === 'timers') {
        return err([validationError(path, 'INVALID_PATH', `Cannot overwrite "${path}" directly`)]);
      }
      if (!Object.hasOwn(state.clocks, field)) {
        return err([validationError(path, 'INVALID_PATH', `Unknown clock field "${field}"`)]);
      }
      return ok({
        canonicalPath: path,
        read: () => getOwn(state.clocks, field),
        validateValue: (v) => {
          switch (field) {
            case 'turn':
            case 'storyTurn':
              return validateNonNegInt(v, path);
            case 'day':
              return typeof v === 'number' && Number.isInteger(v) && v >= 1
                ? ok(v)
                : err([validationError(path, 'INVALID_INTEGER', 'clocks.day must be integer >= 1')]);
            case 'inGameDate':
              if (v === null) {
                return ok(null);
              }
              return typeof v === 'string' && parseIsoDate(v) !== null
                ? ok(v)
                : err([validationError(path, 'INVALID_DATE', `Invalid ISO date "${String(v)}"`)]);
            case 'slot':
              return typeof v === 'string' && state.clocks.slotsPerDay.includes(v)
                ? ok(v)
                : err([validationError(path, 'UNKNOWN_SLOT', `Invalid clock slot "${String(v)}"`)]);
            case 'held':
              return typeof v === 'boolean'
                ? ok(v)
                : err([validationError(path, 'INVALID_TYPE', 'clocks.held must be boolean')]);
            case 'holdReason':
              return validateNullableString(v, path);
            default:
              return err([validationError(path, 'INVALID_PATH', `Unknown clock field "${field}"`)]);
          }
        },
        write: (v) => {
          setOwn(state.clocks, field, v);
          return ok(undefined);
        },
      });
    }
    if (field === 'timers' && segs.length === 4) {
      const timerId = segs[2] as string;
      const prop = segs[3] as string;
      const timer = getOwn(state.clocks.timers, timerId);
      if (!isPlainObject(timer)) {
        return err([validationError(path, 'ENTITY_NOT_FOUND', `Timer "${timerId}" does not exist`)]);
      }
      if (prop !== 'current' && prop !== 'max' && prop !== 'repeat' && prop !== 'tickOn') {
        return err([validationError(path, 'INVALID_PATH', `Unknown timer property "${prop}"`)]);
      }
      return ok({
        canonicalPath: path,
        read: () => getOwn(timer, prop),
        validateValue: (v) => {
          if (prop === 'current') {
            return typeof v === 'number' && Number.isFinite(v) && v >= 0
              ? ok(normalizeZero(v))
              : err([validationError(path, 'INVALID_NUMBER', 'timer current must be >= 0')]);
          }
          if (prop === 'max') {
            return typeof v === 'number' && Number.isFinite(v) && v > 0
              ? ok(normalizeZero(v))
              : err([validationError(path, 'INVALID_NUMBER', 'timer max must be > 0')]);
          }
          if (prop === 'repeat') {
            return typeof v === 'boolean'
              ? ok(v)
              : err([validationError(path, 'INVALID_TYPE', 'timer repeat must be boolean')]);
          }
          return v === 'turn' || v === 'slot' || v === 'day'
            ? ok(v)
            : err([validationError(path, 'INVALID_ENUM', 'timer tickOn must be turn|slot|day')]);
        },
        write: (v) => {
          setOwn(timer, prop, v);
          return ok(undefined);
        },
      });
    }
    return err([validationError(path, 'INVALID_PATH', `Invalid clock path "${path}"`)]);
  }

  if (root === 'relations' && (segs.length === 3 || segs.length === 4)) {
    const fromId = segs[1] as string;
    const toId = segs[2] as string;
    const ensureEntry = (): RelationEntry => {
      let fromMap = getOwn(state.relations, fromId) as Record<string, RelationEntry> | undefined;
      if (!fromMap) {
        fromMap = {};
        setOwn(state.relations, fromId, fromMap);
      }
      let entry = getOwn(fromMap, toId) as RelationEntry | undefined;
      if (!entry) {
        entry = { affinity: 0, maxAffinity: 100, label: 'stranger', tags: [] };
        setOwn(fromMap, toId, entry);
      }
      return entry;
    };
    const readExistingEntry = (): RelationEntry | undefined => {
      const fromMap = getOwn(state.relations, fromId) as Record<string, RelationEntry> | undefined;
      return fromMap ? (getOwn(fromMap, toId) as RelationEntry | undefined) : undefined;
    };

    if (segs.length === 3) {
      return ok({
        canonicalPath: path,
        read: () => readExistingEntry(),
        validateValue: (v) => validateRelationEntry(v, path),
        write: (v) => {
          let fromMap = getOwn(state.relations, fromId) as Record<string, RelationEntry> | undefined;
          if (!fromMap) {
            fromMap = {};
            setOwn(state.relations, fromId, fromMap);
          }
          setOwn(fromMap, toId, v as RelationEntry);
          return ok(undefined);
        },
      });
    }

    const field = segs[3] as string;
    if (field !== 'affinity' && field !== 'maxAffinity' && field !== 'label' && field !== 'tags') {
      return err([validationError(path, 'INVALID_PATH', `Unknown RelationEntry field "${field}"`)]);
    }
    return ok({
      canonicalPath: path,
      defaultIncrementBase: field === 'affinity' ? 0 : undefined,
      allowPushCreate: field === 'tags',
      read: () => {
        const entry = readExistingEntry();
        return entry ? getOwn(entry, field) : undefined;
      },
      validateValue: (v) => {
        if (field === 'affinity') {
          return validateFiniteNumber(v, path);
        }
        if (field === 'maxAffinity') {
          if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
            return err([validationError(path, 'INVALID_NUMBER', 'maxAffinity must be >= 0')]);
          }
          return ok(normalizeZero(v));
        }
        if (field === 'label') {
          return typeof v === 'string'
            ? ok(v)
            : err([validationError(path, 'INVALID_TYPE', `${path} must be a string`)]);
        }
        return isStringArray(v)
          ? ok([...v])
          : err([validationError(path, 'INVALID_TYPE', `${path} must be string[]`)]);
      },
      write: (v) => {
        const entry = ensureEntry();
        setOwn(entry, field, v);
        return ok(undefined);
      },
    });
  }

  if (root === 'entities' && segs.length >= 4) {
    const collectionName = segs[1] as string;
    if (!VALID_COLLECTIONS.has(collectionName)) {
      return err([
        validationError(path, 'INVALID_COLLECTION', `Unknown entity collection "${collectionName}"`),
      ]);
    }
    const collection = collectionName as EntityCollectionName;
    const entityId = segs[2] as string;
    const entityMap = state.entities[collection];
    if (!Object.hasOwn(entityMap, entityId)) {
      return err([
        validationError(
          path,
          'ENTITY_NOT_FOUND',
          `Entity "${entityId}" not found in entities.${collection}`
        ),
      ]);
    }
    const entity = getOwn(entityMap, entityId) as
      | CharacterEntity
      | FactionEntity
      | ThreatEntity
      | LocationEntity;

    if (segs.length === 4) {
      const field = segs[3] as string;
      return ok({
        canonicalPath: path,
        read: () => getOwn(entity, field),
        validateValue: (v) => validateEntityFieldValue(collection, entity, field, v, path, state),
        write: (v) => {
          setOwn(entity, field, v);
          return ok(undefined);
        },
      });
    }

    if (collection === 'characters') {
      const char = entity as CharacterEntity;
      const sub = segs[3] as string;
      if (sub === 'sections' && segs.length === 5) {
        const secId = segs[4] as string;
        return ok({
          canonicalPath: path,
          allowPushCreate: true,
          read: () => getOwn(char.sections, secId),
          validateValue: (v) => {
            if (typeof v === 'string') {
              return ok(v);
            }
            if (isStringArray(v)) {
              return ok([...v]);
            }
            return err([
              validationError(path, 'INVALID_TYPE', `${path} must be string or string[]`),
            ]);
          },
          write: (v) => {
            setOwn(char.sections, secId, v as string | string[]);
            return ok(undefined);
          },
        });
      }
      if (sub === 'customFields' && segs.length >= 5) {
        return resolveNestedRecordTarget(char.customFields, segs.slice(4), path);
      }
      if (sub === 'progression' && segs.length >= 5) {
        return resolveProgressionPath(char.progression, segs.slice(4), path);
      }
      if (sub === 'resources' && segs.length >= 5) {
        return resolveResourcePath(char.resources, segs.slice(4), path);
      }
      if (sub === 'corruption' && segs.length === 5) {
        const corrField = segs[4] as string;
        if (!char.corruption) {
          return err([
            validationError(path, 'MISSING_SUBSYSTEM', `Character "${entityId}" has no corruption state`),
          ]);
        }
        const corr = char.corruption;
        if (corrField !== 'stage' && corrField !== 'progress' && corrField !== 'source') {
          return err([
            validationError(path, 'INVALID_PATH', `Unknown corruption field "${corrField}"`),
          ]);
        }
        return ok({
          canonicalPath: path,
          read: () => getOwn(corr, corrField),
          validateValue: (v) => {
            if (corrField === 'stage') {
              return validateNonNegInt(v, path);
            }
            if (corrField === 'progress') {
              if (typeof v !== 'number' || !Number.isFinite(v)) {
                return err([validationError(path, 'INVALID_NUMBER', 'progress must be finite')]);
              }
              return ok(normalizeZero(Math.min(100, Math.max(0, v))));
            }
            return validateNullableString(v, path);
          },
          write: (v) => {
            setOwn(corr, corrField, v);
            return ok(undefined);
          },
        });
      }
    }

    return err([validationError(path, 'INVALID_PATH', `Invalid entity path "${path}"`)]);
  }

  return err([validationError(path, 'INVALID_PATH', `Unsupported WorldState path "${path}"`)]);
}

function resolveIncrementBase(
  target: ResolvedTarget,
  policy: CompiledFieldPolicy | undefined,
  path: string
): Result<number, ValidationError[]> {
  const existing = target.read();
  if (typeof existing === 'number') {
    if (!Number.isFinite(existing)) {
      return err([validationError(path, 'INVALID_NUMBER', `Existing value at "${path}" is not finite`)]);
    }
    return ok(existing);
  }
  if (existing !== undefined) {
    return err([
      validationError(
        path,
        'INVALID_TYPE',
        `Cannot increment non-numeric value at "${path}" (${typeof existing})`
      ),
    ]);
  }
  if (policy && (policy.spec.type === 'meter' || policy.spec.type === 'counter')) {
    return ok(policy.spec.default);
  }
  if (target.defaultIncrementBase !== undefined) {
    return ok(target.defaultIncrementBase);
  }
  return err([
    validationError(path, 'MISSING_VALUE', `Cannot increment uninitialized value at "${path}"`),
  ]);
}

function validateAndCommitValue(
  target: ResolvedTarget,
  policy: CompiledFieldPolicy | undefined,
  proposedValue: unknown,
  path: string
): Result<unknown, ValidationError[]> {
  let candidate = proposedValue;
  if (policy) {
    // Only apply spec directly if path is not setting a whole ResourcePool object on a meter resource.
    const isWholeResourcePool =
      policy.spec.type === 'meter' &&
      /(?:^|\.)resources\.[^.]+$/.test(path) &&
      isPlainObject(candidate);
    if (!isWholeResourcePool) {
      const specRes = enforceDynamicFieldSpec(policy.spec, candidate, path);
      if (!specRes.ok) {
        return specRes;
      }
      candidate = specRes.value;
    }
  }

  const targetRes = target.validateValue(candidate);
  if (!targetRes.ok) {
    return targetRes;
  }

  const writeRes = target.write(targetRes.value);
  if (!writeRes.ok) {
    return writeRes;
  }
  return ok(targetRes.value);
}

interface ExecContext {
  nextState: WorldState;
  options: ReducerOptions;
  batch: PatchBatch;
  auditEntries: AuditEntry[];
  changedPaths: Set<string>;
  pendingConfirmations: PatchOperation[];
  rejectedOperations: RejectedOperation[];
  seq: number;
  daysElapsed: number;
  slotsElapsed: number;
  expiredTimers: string[];
}

function emitAudit(
  ctx: ExecContext,
  opName: string,
  path: string,
  oldValue: unknown,
  newValue: unknown,
  status: AuditEntry['status'],
  reason?: string
): void {
  const entry: AuditEntry = {
    turn: ctx.nextState.meta.turn,
    storyTurn: ctx.nextState.clocks.storyTurn,
    timestampSeq: ctx.seq,
    source: ctx.batch.source,
    eventId: ctx.batch.eventId,
    op: opName,
    path,
    oldValue: cloneForAudit(oldValue),
    newValue: cloneForAudit(newValue),
    status,
  };
  const resolvedReason = reason ?? ctx.batch.reason;
  if (resolvedReason !== undefined) {
    entry.reason = resolvedReason;
  }
  ctx.seq += 1;
  ctx.auditEntries.push(entry);
}

function recordChangedIfDifferent(
  ctx: ExecContext,
  path: string,
  oldValue: unknown,
  newValue: unknown
): void {
  if (!deepEqual(oldValue, newValue)) {
    ctx.changedPaths.add(path);
  }
}

const VALID_CHARACTER_UPSERT_KEYS: ReadonlySet<string> = new Set([
  'id',
  'name',
  'status',
  'presentInScene',
  'locationId',
  'formId',
  'formGroup',
  'sections',
  'customFields',
  'progression',
  'resources',
  'corruption',
  'abilities',
  'goals',
  'agenda',
  'allegiance',
  'mood',
  'traits',
]);

function cloneCharacterForUpsert(char: CharacterEntity): CharacterEntity {
  const sections: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(char.sections)) {
    if (isSafeKey(k)) {
      setOwn(sections, k, Array.isArray(v) ? [...v] : v);
    }
  }
  const clonedCustom = cloneForAudit(char.customFields);
  const cloned: CharacterEntity = {
    id: char.id,
    name: char.name,
    status: char.status,
    presentInScene: char.presentInScene,
    locationId: char.locationId,
    formId: char.formId,
    formGroup: char.formGroup,
    sections,
    customFields: isPlainObject(clonedCustom) ? clonedCustom : {},
    abilities: [...char.abilities],
    goals: [...char.goals],
    agenda: char.agenda,
    allegiance: char.allegiance,
    mood: char.mood,
    traits: [...char.traits],
  };
  if (char.progression !== undefined) {
    cloned.progression = {
      level: char.progression.level,
      xp: char.progression.xp,
      ...(char.progression.className !== undefined ? { className: char.progression.className } : {}),
      ...(char.progression.subclass !== undefined ? { subclass: char.progression.subclass } : {}),
      ...(char.progression.attributes !== undefined
        ? { attributes: { ...(cloneForAudit(char.progression.attributes) as Record<string, number>) } }
        : {}),
    };
  }
  if (char.resources !== undefined) {
    const resources: Record<string, ResourcePool> = {};
    for (const [k, pool] of Object.entries(char.resources)) {
      if (isSafeKey(k)) {
        setOwn(resources, k, { current: pool.current, max: pool.max });
      }
    }
    cloned.resources = resources;
  }
  if (char.corruption !== undefined) {
    cloned.corruption = { ...char.corruption };
  }
  return cloned;
}

function applyUpsertRecordEntries(
  ctx: ExecContext,
  characterId: string,
  opName: string,
  kind: 'sections' | 'customFields' | 'resources',
  rawRecord: unknown,
  targetChar: CharacterEntity,
  existingChar: CharacterEntity | undefined,
  opErrPath: string
): Result<void, ValidationError[]> {
  if (!isPlainObject(rawRecord)) {
    return err([
      validationError(`${opErrPath}.character.${kind}`, 'INVALID_TYPE', `${kind} must be a plain record`),
    ]);
  }
  const keys = Object.getOwnPropertyNames(rawRecord).sort();
  for (const key of keys) {
    if (!isSafeKey(key)) {
      return err([
        validationError(`${opErrPath}.character.${kind}.${key}`, 'UNSAFE_KEY', `Forbidden key "${key}"`),
      ]);
    }
    const rawVal = Object.getOwnPropertyDescriptor(rawRecord, key)?.value;
    if (rawVal === undefined) {
      continue;
    }

    const canonicalPath = `entities.characters.${characterId}.${kind}.${key}`;
    const policy = lookupFieldPolicy(ctx.options.compiledSchema, canonicalPath, ctx.nextState);
    const oldContainer =
      existingChar === undefined
        ? undefined
        : kind === 'sections'
          ? existingChar.sections
          : kind === 'customFields'
            ? existingChar.customFields
            : existingChar.resources;
    const oldVal = oldContainer ? cloneForAudit(getOwn(oldContainer, key)) : undefined;
    const gate = evaluateTrackerGate(ctx.batch.source, canonicalPath, policy);

    const makeDivertedOp = (): PatchOperation => {
      if (kind === 'sections') {
        return {
          op: 'section_patch',
          target: { characterId },
          sectionId: key,
          value: cloneForAudit(rawVal) as string | string[],
        };
      }
      if (kind === 'customFields') {
        return {
          op: 'custom_field_patch',
          target: { characterId },
          fieldId: key,
          value: cloneForAudit(rawVal),
        };
      }
      return {
        op: 'set',
        path: canonicalPath,
        value: cloneForAudit(rawVal),
      };
    };

    if (gate.action === 'reject') {
      ctx.rejectedOperations.push({ op: makeDivertedOp(), reason: gate.reason });
      emitAudit(ctx, opName, canonicalPath, oldVal, rawVal, 'rejected', gate.reason);
      continue;
    }
    if (gate.action === 'pending') {
      ctx.pendingConfirmations.push(makeDivertedOp());
      emitAudit(ctx, opName, canonicalPath, oldVal, rawVal, 'pending_confirmation', gate.reason);
      continue;
    }

    if (kind === 'sections') {
      if (typeof rawVal !== 'string' && !isStringArray(rawVal)) {
        return err([
          validationError(canonicalPath, 'INVALID_TYPE', 'Section value must be string or string[]'),
        ]);
      }
      let nextVal: unknown = typeof rawVal === 'string' ? rawVal : [...rawVal];
      if (policy) {
        const specRes = enforceDynamicFieldSpec(policy.spec, nextVal, canonicalPath);
        if (!specRes.ok) {
          return specRes;
        }
        nextVal = specRes.value;
      }
      setOwn(targetChar.sections, key, nextVal as string | string[]);
    } else if (kind === 'customFields') {
      const safeRes = cloneSafeValue(rawVal, canonicalPath);
      if (!safeRes.ok) {
        return safeRes;
      }
      let nextVal = safeRes.value;
      if (policy) {
        const specRes = enforceDynamicFieldSpec(policy.spec, nextVal, canonicalPath);
        if (!specRes.ok) {
          return specRes;
        }
        nextVal = specRes.value;
      }
      setOwn(targetChar.customFields, key, nextVal);
    } else {
      const poolRes = validateResourcePool(rawVal, canonicalPath);
      if (!poolRes.ok) {
        return poolRes;
      }
      if (!targetChar.resources) {
        targetChar.resources = {};
      }
      setOwn(targetChar.resources, key, poolRes.value);
    }
  }
  return ok(undefined);
}

function applyUpsertProgression(
  ctx: ExecContext,
  characterId: string,
  rawProg: unknown,
  targetChar: CharacterEntity,
  existingChar: CharacterEntity | undefined,
  opErrPath: string
): Result<void, ValidationError[]> {
  if (!isPlainObject(rawProg)) {
    return err([
      validationError(`${opErrPath}.character.progression`, 'INVALID_TYPE', 'progression must be an object'),
    ]);
  }
  const progKeys = Object.getOwnPropertyNames(rawProg).sort();
  for (const key of progKeys) {
    if (!isSafeKey(key)) {
      return err([
        validationError(
          `${opErrPath}.character.progression.${key}`,
          'UNSAFE_KEY',
          `Forbidden progression key "${key}"`
        ),
      ]);
    }
    if (
      key !== 'level' &&
      key !== 'xp' &&
      key !== 'className' &&
      key !== 'subclass' &&
      key !== 'attributes'
    ) {
      return err([
        validationError(
          `${opErrPath}.character.progression.${key}`,
          'INVALID_PATH',
          `Unknown progression field "${key}"`
        ),
      ]);
    }
  }

  const baseProg: Partial<CharacterProgression> = targetChar.progression
    ? {
        level: targetChar.progression.level,
        xp: targetChar.progression.xp,
        ...(targetChar.progression.className !== undefined
          ? { className: targetChar.progression.className }
          : {}),
        ...(targetChar.progression.subclass !== undefined
          ? { subclass: targetChar.progression.subclass }
          : {}),
        ...(targetChar.progression.attributes !== undefined
          ? {
              attributes: {
                ...(cloneForAudit(targetChar.progression.attributes) as Record<string, number>),
              },
            }
          : {}),
      }
    : {};

  for (const key of progKeys) {
    const rawVal = Object.getOwnPropertyDescriptor(rawProg, key)?.value;
    if (rawVal === undefined) {
      continue;
    }

    if (key === 'attributes') {
      if (!isPlainObject(rawVal)) {
        return err([
          validationError(
            `${opErrPath}.character.progression.attributes`,
            'INVALID_TYPE',
            'progression.attributes must be a plain record'
          ),
        ]);
      }
      const attrMap: Record<string, number> = baseProg.attributes ? { ...baseProg.attributes } : {};
      for (const attrKey of Object.getOwnPropertyNames(rawVal).sort()) {
        if (!isSafeKey(attrKey)) {
          return err([
            validationError(
              `${opErrPath}.character.progression.attributes.${attrKey}`,
              'UNSAFE_KEY',
              `Forbidden attribute key "${attrKey}"`
            ),
          ]);
        }
        const attrVal = Object.getOwnPropertyDescriptor(rawVal, attrKey)?.value;
        if (attrVal === undefined) {
          continue;
        }
        const attrPath = `entities.characters.${characterId}.progression.attributes.${attrKey}`;
        const policy = lookupFieldPolicy(ctx.options.compiledSchema, attrPath, ctx.nextState);
        const oldVal = existingChar?.progression?.attributes
          ? getOwn(existingChar.progression.attributes, attrKey)
          : undefined;
        const gate = evaluateTrackerGate(ctx.batch.source, attrPath, policy);
        if (gate.action === 'reject') {
          ctx.rejectedOperations.push({
            op: { op: 'set', path: attrPath, value: cloneForAudit(attrVal) },
            reason: gate.reason,
          });
          emitAudit(ctx, 'character_upsert', attrPath, oldVal, attrVal, 'rejected', gate.reason);
          continue;
        }
        if (gate.action === 'pending') {
          ctx.pendingConfirmations.push({
            op: 'set',
            path: attrPath,
            value: cloneForAudit(attrVal),
          });
          emitAudit(
            ctx,
            'character_upsert',
            attrPath,
            oldVal,
            attrVal,
            'pending_confirmation',
            gate.reason
          );
          continue;
        }
        const numRes = validateFiniteNumber(attrVal, attrPath);
        if (!numRes.ok) {
          return numRes;
        }
        setOwn(attrMap, attrKey, numRes.value);
      }
      baseProg.attributes = attrMap;
      continue;
    }

    const fieldPath = `entities.characters.${characterId}.progression.${key}`;
    const policy = lookupFieldPolicy(ctx.options.compiledSchema, fieldPath, ctx.nextState);
    const oldVal = existingChar?.progression ? getOwn(existingChar.progression, key) : undefined;
    const gate = evaluateTrackerGate(ctx.batch.source, fieldPath, policy);
    if (gate.action === 'reject') {
      ctx.rejectedOperations.push({
        op: { op: 'set', path: fieldPath, value: cloneForAudit(rawVal) },
        reason: gate.reason,
      });
      emitAudit(ctx, 'character_upsert', fieldPath, oldVal, rawVal, 'rejected', gate.reason);
      continue;
    }
    if (gate.action === 'pending') {
      ctx.pendingConfirmations.push({ op: 'set', path: fieldPath, value: cloneForAudit(rawVal) });
      emitAudit(
        ctx,
        'character_upsert',
        fieldPath,
        oldVal,
        rawVal,
        'pending_confirmation',
        gate.reason
      );
      continue;
    }

    if (key === 'level') {
      if (typeof rawVal !== 'number' || !Number.isInteger(rawVal) || rawVal < 1) {
        return err([validationError(fieldPath, 'INVALID_INTEGER', 'level must be >= 1')]);
      }
      baseProg.level = rawVal;
    } else if (key === 'xp') {
      if (typeof rawVal !== 'number' || !Number.isFinite(rawVal) || rawVal < 0) {
        return err([validationError(fieldPath, 'INVALID_NUMBER', 'xp must be >= 0')]);
      }
      baseProg.xp = normalizeZero(rawVal);
    } else if (key === 'className') {
      if (typeof rawVal !== 'string') {
        return err([validationError(fieldPath, 'INVALID_TYPE', 'className must be a string')]);
      }
      baseProg.className = rawVal;
    } else {
      if (typeof rawVal !== 'string') {
        return err([validationError(fieldPath, 'INVALID_TYPE', 'subclass must be a string')]);
      }
      baseProg.subclass = rawVal;
    }
  }

  if (baseProg.level !== undefined && baseProg.xp !== undefined) {
    targetChar.progression = {
      level: baseProg.level,
      xp: baseProg.xp,
      ...(baseProg.className !== undefined ? { className: baseProg.className } : {}),
      ...(baseProg.subclass !== undefined ? { subclass: baseProg.subclass } : {}),
      ...(baseProg.attributes !== undefined ? { attributes: baseProg.attributes } : {}),
    };
  } else if (targetChar.progression === undefined && ctx.batch.source !== 'tracker') {
    return err([
      validationError(
        `${opErrPath}.character.progression`,
        'REQUIRED',
        'New character progression requires integer level >= 1 and finite xp >= 0'
      ),
    ]);
  }
  return ok(undefined);
}

function applyCharacterUpsertOperation(
  ctx: ExecContext,
  op: Extract<PatchOperation, { op: 'character_upsert' }>,
  opIndex: number
): Result<void, ValidationError[]> {
  const opErrPath = `operations[${opIndex}]`;

  if (typeof op.characterId !== 'string' || op.characterId.trim().length === 0) {
    return err([
      validationError(
        `${opErrPath}.characterId`,
        'REQUIRED',
        'character_upsert characterId must be a non-empty string'
      ),
    ]);
  }
  if (!isSafeEntityId(op.characterId)) {
    return err([
      validationError(
        `${opErrPath}.characterId`,
        'UNSAFE_KEY',
        `Invalid characterId "${op.characterId}"`
      ),
    ]);
  }
  if (op.mergeIfExists !== undefined && typeof op.mergeIfExists !== 'boolean') {
    return err([
      validationError(
        `${opErrPath}.mergeIfExists`,
        'INVALID_TYPE',
        'mergeIfExists must be a boolean'
      ),
    ]);
  }
  if (!isPlainObject(op.character)) {
    return err([
      validationError(
        `${opErrPath}.character`,
        'INVALID_TYPE',
        'character_upsert character must be a plain object'
      ),
    ]);
  }

  const providedKeys = Object.getOwnPropertyNames(op.character).sort();
  for (const key of providedKeys) {
    if (!isSafeKey(key)) {
      return err([
        validationError(
          `${opErrPath}.character`,
          'UNSAFE_KEY',
          `Forbidden key "${key}" in character_upsert`
        ),
      ]);
    }
    if (!VALID_CHARACTER_UPSERT_KEYS.has(key)) {
      return err([
        validationError(
          `${opErrPath}.character.${key}`,
          'INVALID_PATH',
          `Unknown CharacterEntity field "${key}"`
        ),
      ]);
    }
  }

  const rawName = getOwn(op.character, 'name');
  if (typeof rawName !== 'string' || rawName.trim().length === 0) {
    return err([
      validationError(
        `${opErrPath}.character.name`,
        'REQUIRED',
        'character_upsert character.name must be a non-empty string'
      ),
    ]);
  }
  if (
    Object.hasOwn(op.character, 'id') &&
    getOwn(op.character, 'id') !== undefined &&
    getOwn(op.character, 'id') !== op.characterId
  ) {
    return err([
      validationError(
        `${opErrPath}.character.id`,
        'ID_IMMUTABLE',
        `Character id must match characterId "${op.characterId}"`
      ),
    ]);
  }

  const existing = getOwn(ctx.nextState.entities.characters, op.characterId) as
    | CharacterEntity
    | undefined;
  if (existing !== undefined && op.mergeIfExists === false) {
    return err([
      validationError(
        `${opErrPath}.characterId`,
        'ENTITY_ALREADY_EXISTS',
        `Character "${op.characterId}" already exists and mergeIfExists is false`
      ),
    ]);
  }

  const nextChar: CharacterEntity =
    existing !== undefined
      ? cloneCharacterForUpsert(existing)
      : {
          id: op.characterId,
          name: rawName,
          status: 'active',
          presentInScene: ctx.nextState.scene.locationId === null,
          locationId: ctx.nextState.scene.locationId,
          formId: null,
          formGroup: null,
          sections: {},
          customFields: {},
          abilities: [],
          goals: [],
          agenda: '',
          allegiance: '',
          mood: 'neutral',
          traits: [],
        };

  for (const key of providedKeys) {
    if (key === 'id') {
      continue;
    }
    const rawVal = Object.getOwnPropertyDescriptor(op.character, key)?.value;
    if (rawVal === undefined) {
      continue;
    }

    if (key === 'sections' || key === 'customFields' || key === 'resources') {
      const recRes = applyUpsertRecordEntries(
        ctx,
        op.characterId,
        op.op,
        key,
        rawVal,
        nextChar,
        existing,
        opErrPath
      );
      if (!recRes.ok) {
        return recRes;
      }
      continue;
    }

    if (key === 'progression') {
      const progRes = applyUpsertProgression(
        ctx,
        op.characterId,
        rawVal,
        nextChar,
        existing,
        opErrPath
      );
      if (!progRes.ok) {
        return progRes;
      }
      continue;
    }

    const canonicalFieldPath = `entities.characters.${op.characterId}.${key}`;
    const policy = lookupFieldPolicy(ctx.options.compiledSchema, canonicalFieldPath, ctx.nextState);
    const oldVal = existing !== undefined ? cloneForAudit(getOwn(existing, key)) : undefined;
    const gate = evaluateTrackerGate(ctx.batch.source, canonicalFieldPath, policy);
    if (gate.action === 'reject') {
      ctx.rejectedOperations.push({
        op: {
          op: 'entity_patch',
          collection: 'characters',
          entityId: op.characterId,
          patch: { [key]: cloneForAudit(rawVal) },
        },
        reason: gate.reason,
      });
      emitAudit(ctx, op.op, canonicalFieldPath, oldVal, rawVal, 'rejected', gate.reason);
      continue;
    }
    if (gate.action === 'pending') {
      ctx.pendingConfirmations.push({
        op: 'entity_patch',
        collection: 'characters',
        entityId: op.characterId,
        patch: { [key]: cloneForAudit(rawVal) },
      });
      emitAudit(
        ctx,
        op.op,
        canonicalFieldPath,
        oldVal,
        rawVal,
        'pending_confirmation',
        gate.reason
      );
      continue;
    }

    const safeRes = cloneSafeValue(rawVal, `${opErrPath}.character.${key}`);
    if (!safeRes.ok) {
      return safeRes;
    }
    let nextVal = safeRes.value;
    if (policy) {
      const specRes = enforceDynamicFieldSpec(policy.spec, nextVal, canonicalFieldPath);
      if (!specRes.ok) {
        return specRes;
      }
      nextVal = specRes.value;
    }
    const validated = validateEntityFieldValue(
      'characters',
      nextChar,
      key,
      nextVal,
      canonicalFieldPath,
      ctx.nextState
    );
    if (!validated.ok) {
      return validated;
    }
    setOwn(nextChar, key, validated.value);
  }

  setOwn(ctx.nextState.entities.characters, op.characterId, nextChar);
  const entityPath = `entities.characters.${op.characterId}`;
  if (existing === undefined) {
    ctx.changedPaths.add(entityPath);
  } else {
    recordChangedIfDifferent(ctx, entityPath, existing, nextChar);
  }
  emitAudit(ctx, op.op, entityPath, existing, nextChar, 'committed');

  const isPlayerChar = ctx.nextState.player.characterId === op.characterId;
  if (!isPlayerChar) {
    const isPresentHere =
      ctx.nextState.capabilities.spatialMode === 'scene_only'
        ? nextChar.presentInScene
        : ctx.nextState.scene.locationId !== null &&
          nextChar.locationId === ctx.nextState.scene.locationId;
    const isActiveAndPresent = nextChar.status === 'active' && isPresentHere;
    const alreadyPresent = ctx.nextState.scene.presentCharacterIds.includes(op.characterId);
    if (isActiveAndPresent && !alreadyPresent) {
      ctx.nextState.scene.presentCharacterIds = [
        ...ctx.nextState.scene.presentCharacterIds,
        op.characterId,
      ];
      ctx.changedPaths.add('scene.presentCharacterIds');
    } else if (
      !isActiveAndPresent &&
      alreadyPresent &&
      (nextChar.status !== 'active' ||
        !ctx.nextState.scene.pinnedCharacterIds.includes(op.characterId))
    ) {
      ctx.nextState.scene.presentCharacterIds =
        ctx.nextState.scene.presentCharacterIds.filter((id) => id !== op.characterId);
      ctx.changedPaths.add('scene.presentCharacterIds');
    }
  }

  return ok(undefined);
}

function applySingleOperation(
  ctx: ExecContext,
  op: PatchOperation,
  opIndex: number
): Result<void, ValidationError[]> {
  const opErrPath = `operations[${opIndex}]`;

  switch (op.op) {
    case 'set': {
      const safeRes = cloneSafeValue(op.value, `${opErrPath}.value`);
      if (!safeRes.ok) {
        return safeRes;
      }
      const targetRes = resolveWorldStateTarget(ctx.nextState, op.path);
      if (!targetRes.ok) {
        return targetRes;
      }
      const target = targetRes.value;
      const policy = lookupFieldPolicy(ctx.options.compiledSchema, target.canonicalPath, ctx.nextState);
      const oldValue = cloneForAudit(target.read());
      const gate = evaluateTrackerGate(ctx.batch.source, target.canonicalPath, policy);
      if (gate.action === 'reject') {
        ctx.rejectedOperations.push({ op: cloneOperation(op), reason: gate.reason });
        emitAudit(ctx, op.op, target.canonicalPath, oldValue, safeRes.value, 'rejected', gate.reason);
        return ok(undefined);
      }
      if (gate.action === 'pending') {
        ctx.pendingConfirmations.push(cloneOperation(op));
        emitAudit(
          ctx,
          op.op,
          target.canonicalPath,
          oldValue,
          safeRes.value,
          'pending_confirmation',
          gate.reason
        );
        return ok(undefined);
      }

      const committed = validateAndCommitValue(target, policy, safeRes.value, target.canonicalPath);
      if (!committed.ok) {
        return committed;
      }
      recordChangedIfDifferent(ctx, target.canonicalPath, oldValue, committed.value);
      emitAudit(ctx, op.op, target.canonicalPath, oldValue, committed.value, 'committed');
      return ok(undefined);
    }

    case 'increment': {
      if (typeof op.delta !== 'number' || !Number.isFinite(op.delta)) {
        return err([
          validationError(`${opErrPath}.delta`, 'INVALID_DELTA', 'increment delta must be finite'),
        ]);
      }
      const targetRes = resolveWorldStateTarget(ctx.nextState, op.path);
      if (!targetRes.ok) {
        return targetRes;
      }
      const target = targetRes.value;
      const policy = lookupFieldPolicy(ctx.options.compiledSchema, target.canonicalPath, ctx.nextState);
      const oldValue = cloneForAudit(target.read());
      const gate = evaluateTrackerGate(ctx.batch.source, target.canonicalPath, policy);
      if (gate.action === 'reject') {
        ctx.rejectedOperations.push({ op: cloneOperation(op), reason: gate.reason });
        emitAudit(ctx, op.op, target.canonicalPath, oldValue, op.delta, 'rejected', gate.reason);
        return ok(undefined);
      }
      if (gate.action === 'pending') {
        ctx.pendingConfirmations.push(cloneOperation(op));
        emitAudit(
          ctx,
          op.op,
          target.canonicalPath,
          oldValue,
          op.delta,
          'pending_confirmation',
          gate.reason
        );
        return ok(undefined);
      }

      const baseRes = resolveIncrementBase(target, policy, target.canonicalPath);
      if (!baseRes.ok) {
        return baseRes;
      }
      const nextNum = normalizeZero(baseRes.value + op.delta);
      const committed = validateAndCommitValue(target, policy, nextNum, target.canonicalPath);
      if (!committed.ok) {
        return committed;
      }
      recordChangedIfDifferent(ctx, target.canonicalPath, oldValue, committed.value);
      emitAudit(ctx, op.op, target.canonicalPath, oldValue, committed.value, 'committed');
      return ok(undefined);
    }

    case 'clamp': {
      if (
        typeof op.min !== 'number' ||
        !Number.isFinite(op.min) ||
        typeof op.max !== 'number' ||
        !Number.isFinite(op.max) ||
        op.min > op.max
      ) {
        return err([
          validationError(opErrPath, 'INVALID_RANGE', 'clamp requires finite min <= max'),
        ]);
      }
      const targetRes = resolveWorldStateTarget(ctx.nextState, op.path);
      if (!targetRes.ok) {
        return targetRes;
      }
      const target = targetRes.value;
      const policy = lookupFieldPolicy(ctx.options.compiledSchema, target.canonicalPath, ctx.nextState);
      const existing = target.read();
      const oldValue = cloneForAudit(existing);
      const gate = evaluateTrackerGate(ctx.batch.source, target.canonicalPath, policy);
      if (gate.action === 'reject') {
        ctx.rejectedOperations.push({ op: cloneOperation(op), reason: gate.reason });
        emitAudit(ctx, op.op, target.canonicalPath, oldValue, existing, 'rejected', gate.reason);
        return ok(undefined);
      }
      if (gate.action === 'pending') {
        ctx.pendingConfirmations.push(cloneOperation(op));
        emitAudit(
          ctx,
          op.op,
          target.canonicalPath,
          oldValue,
          existing,
          'pending_confirmation',
          gate.reason
        );
        return ok(undefined);
      }

      if (typeof existing !== 'number' || !Number.isFinite(existing)) {
        return err([
          validationError(
            target.canonicalPath,
            'INVALID_TYPE',
            `clamp target "${target.canonicalPath}" must be a finite number`
          ),
        ]);
      }
      const clamped = normalizeZero(Math.min(op.max, Math.max(op.min, existing)));
      const committed = validateAndCommitValue(target, policy, clamped, target.canonicalPath);
      if (!committed.ok) {
        return committed;
      }
      recordChangedIfDifferent(ctx, target.canonicalPath, oldValue, committed.value);
      emitAudit(ctx, op.op, target.canonicalPath, oldValue, committed.value, 'committed');
      return ok(undefined);
    }

    case 'push': {
      const targetRes = resolveWorldStateTarget(ctx.nextState, op.path);
      if (!targetRes.ok) {
        return targetRes;
      }
      const target = targetRes.value;
      const policy = lookupFieldPolicy(ctx.options.compiledSchema, target.canonicalPath, ctx.nextState);
      const existing = target.read();
      const oldValue = cloneForAudit(existing);
      const gate = evaluateTrackerGate(ctx.batch.source, target.canonicalPath, policy);
      if (gate.action === 'reject') {
        ctx.rejectedOperations.push({ op: cloneOperation(op), reason: gate.reason });
        emitAudit(ctx, op.op, target.canonicalPath, oldValue, op.value, 'rejected', gate.reason);
        return ok(undefined);
      }
      if (gate.action === 'pending') {
        ctx.pendingConfirmations.push(cloneOperation(op));
        emitAudit(
          ctx,
          op.op,
          target.canonicalPath,
          oldValue,
          op.value,
          'pending_confirmation',
          gate.reason
        );
        return ok(undefined);
      }

      let baseArray: unknown[];
      if (Array.isArray(existing)) {
        baseArray = [...existing];
      } else if (existing === undefined && target.allowPushCreate) {
        baseArray = [];
      } else {
        return err([
          validationError(
            target.canonicalPath,
            'INVALID_TYPE',
            `push target "${target.canonicalPath}" is not an array`
          ),
        ]);
      }

      const safeItemRes = cloneSafeValue(op.value, `${opErrPath}.value`);
      if (!safeItemRes.ok) {
        return safeItemRes;
      }
      baseArray.push(safeItemRes.value);
      const committed = validateAndCommitValue(target, policy, baseArray, target.canonicalPath);
      if (!committed.ok) {
        return committed;
      }
      recordChangedIfDifferent(ctx, target.canonicalPath, oldValue, committed.value);
      emitAudit(ctx, op.op, target.canonicalPath, oldValue, committed.value, 'committed');
      return ok(undefined);
    }

    case 'remove': {
      const targetRes = resolveWorldStateTarget(ctx.nextState, op.path);
      if (!targetRes.ok) {
        return targetRes;
      }
      const target = targetRes.value;
      const policy = lookupFieldPolicy(ctx.options.compiledSchema, target.canonicalPath, ctx.nextState);
      const existing = target.read();
      const oldValue = cloneForAudit(existing);
      const gate = evaluateTrackerGate(ctx.batch.source, target.canonicalPath, policy);
      if (gate.action === 'reject') {
        ctx.rejectedOperations.push({ op: cloneOperation(op), reason: gate.reason });
        emitAudit(ctx, op.op, target.canonicalPath, oldValue, op.value, 'rejected', gate.reason);
        return ok(undefined);
      }
      if (gate.action === 'pending') {
        ctx.pendingConfirmations.push(cloneOperation(op));
        emitAudit(
          ctx,
          op.op,
          target.canonicalPath,
          oldValue,
          op.value,
          'pending_confirmation',
          gate.reason
        );
        return ok(undefined);
      }

      if (!Array.isArray(existing)) {
        return err([
          validationError(
            target.canonicalPath,
            'INVALID_TYPE',
            `remove target "${target.canonicalPath}" is not an array`
          ),
        ]);
      }
      const nextArray = existing.filter((item) => !deepEqual(item, op.value));
      const committed = validateAndCommitValue(target, policy, nextArray, target.canonicalPath);
      if (!committed.ok) {
        return committed;
      }
      recordChangedIfDifferent(ctx, target.canonicalPath, oldValue, committed.value);
      emitAudit(ctx, op.op, target.canonicalPath, oldValue, committed.value, 'committed');
      return ok(undefined);
    }

    case 'section_patch': {
      if (!isSafeKey(op.sectionId)) {
        return err([
          validationError(
            `${opErrPath}.sectionId`,
            'UNSAFE_KEY',
            `Invalid sectionId "${String(op.sectionId)}"`
          ),
        ]);
      }
      if (typeof op.value !== 'string' && !isStringArray(op.value)) {
        return err([
          validationError(
            `${opErrPath}.value`,
            'INVALID_TYPE',
            'section_patch value must be a string or string[]'
          ),
        ]);
      }
      let canonicalPath: string;
      let sectionsRecord: Record<string, string | string[]>;
      if (op.target === 'player') {
        canonicalPath = `player.sections.${op.sectionId}`;
        sectionsRecord = ctx.nextState.player.sections;
      } else {
        if (!isSafeKey(op.target.characterId)) {
          return err([
            validationError(`${opErrPath}.target.characterId`, 'UNSAFE_KEY', 'Invalid characterId'),
          ]);
        }
        if (!Object.hasOwn(ctx.nextState.entities.characters, op.target.characterId)) {
          return err([
            validationError(
              `${opErrPath}.target.characterId`,
              'ENTITY_NOT_FOUND',
              `Character "${op.target.characterId}" does not exist`
            ),
          ]);
        }
        canonicalPath = `entities.characters.${op.target.characterId}.sections.${op.sectionId}`;
        const char = getOwn(ctx.nextState.entities.characters, op.target.characterId) as CharacterEntity;
        sectionsRecord = char.sections;
      }

      const policy = lookupFieldPolicy(ctx.options.compiledSchema, canonicalPath, ctx.nextState);
      const oldValue = cloneForAudit(getOwn(sectionsRecord, op.sectionId));
      const gate = evaluateTrackerGate(ctx.batch.source, canonicalPath, policy);
      if (gate.action === 'reject') {
        ctx.rejectedOperations.push({ op: cloneOperation(op), reason: gate.reason });
        emitAudit(ctx, op.op, canonicalPath, oldValue, op.value, 'rejected', gate.reason);
        return ok(undefined);
      }
      if (gate.action === 'pending') {
        ctx.pendingConfirmations.push(cloneOperation(op));
        emitAudit(
          ctx,
          op.op,
          canonicalPath,
          oldValue,
          op.value,
          'pending_confirmation',
          gate.reason
        );
        return ok(undefined);
      }

      let nextVal: unknown = typeof op.value === 'string' ? op.value : [...op.value];
      if (policy) {
        const specRes = enforceDynamicFieldSpec(policy.spec, nextVal, canonicalPath);
        if (!specRes.ok) {
          return specRes;
        }
        nextVal = specRes.value;
      }
      setOwn(sectionsRecord, op.sectionId, nextVal as string | string[]);
      recordChangedIfDifferent(ctx, canonicalPath, oldValue, nextVal);
      emitAudit(ctx, op.op, canonicalPath, oldValue, nextVal, 'committed');
      return ok(undefined);
    }

    case 'custom_field_patch': {
      if (!isSafeKey(op.fieldId)) {
        return err([
          validationError(
            `${opErrPath}.fieldId`,
            'UNSAFE_KEY',
            `Invalid fieldId "${String(op.fieldId)}"`
          ),
        ]);
      }
      let canonicalPath: string;
      let targetRecord: Record<string, unknown>;
      if (op.target === 'global') {
        canonicalPath = `customFields.${op.fieldId}`;
        targetRecord = ctx.nextState.customFields;
      } else if (op.target === 'player') {
        canonicalPath = `player.customFields.${op.fieldId}`;
        targetRecord = ctx.nextState.player.customFields;
      } else {
        if (!isSafeKey(op.target.characterId)) {
          return err([
            validationError(`${opErrPath}.target.characterId`, 'UNSAFE_KEY', 'Invalid characterId'),
          ]);
        }
        if (!Object.hasOwn(ctx.nextState.entities.characters, op.target.characterId)) {
          return err([
            validationError(
              `${opErrPath}.target.characterId`,
              'ENTITY_NOT_FOUND',
              `Character "${op.target.characterId}" does not exist`
            ),
          ]);
        }
        canonicalPath = `entities.characters.${op.target.characterId}.customFields.${op.fieldId}`;
        const char = getOwn(ctx.nextState.entities.characters, op.target.characterId) as CharacterEntity;
        targetRecord = char.customFields;
      }

      const policy = lookupFieldPolicy(ctx.options.compiledSchema, canonicalPath, ctx.nextState);
      const oldValue = cloneForAudit(getOwn(targetRecord, op.fieldId));
      const gate = evaluateTrackerGate(ctx.batch.source, canonicalPath, policy);
      if (gate.action === 'reject') {
        ctx.rejectedOperations.push({ op: cloneOperation(op), reason: gate.reason });
        emitAudit(ctx, op.op, canonicalPath, oldValue, op.value, 'rejected', gate.reason);
        return ok(undefined);
      }
      if (gate.action === 'pending') {
        ctx.pendingConfirmations.push(cloneOperation(op));
        emitAudit(
          ctx,
          op.op,
          canonicalPath,
          oldValue,
          op.value,
          'pending_confirmation',
          gate.reason
        );
        return ok(undefined);
      }

      const safeRes = cloneSafeValue(op.value, `${opErrPath}.value`);
      if (!safeRes.ok) {
        return safeRes;
      }
      let nextVal = safeRes.value;
      if (policy) {
        const specRes = enforceDynamicFieldSpec(policy.spec, nextVal, canonicalPath);
        if (!specRes.ok) {
          return specRes;
        }
        nextVal = specRes.value;
      }
      setOwn(targetRecord, op.fieldId, nextVal);
      recordChangedIfDifferent(ctx, canonicalPath, oldValue, nextVal);
      emitAudit(ctx, op.op, canonicalPath, oldValue, nextVal, 'committed');
      return ok(undefined);
    }

    case 'entity_patch': {
      if (!VALID_COLLECTIONS.has(op.collection)) {
        return err([
          validationError(
            `${opErrPath}.collection`,
            'INVALID_COLLECTION',
            `Invalid entity collection "${String(op.collection)}"`
          ),
        ]);
      }
      if (!isSafeKey(op.entityId)) {
        return err([
          validationError(`${opErrPath}.entityId`, 'UNSAFE_KEY', `Invalid entityId "${op.entityId}"`),
        ]);
      }
      if (!isPlainObject(op.patch)) {
        return err([
          validationError(`${opErrPath}.patch`, 'INVALID_TYPE', 'entity_patch patch must be an object'),
        ]);
      }
      const collectionMap = ctx.nextState.entities[op.collection];
      if (!Object.hasOwn(collectionMap, op.entityId)) {
        return err([
          validationError(
            `${opErrPath}.entityId`,
            'ENTITY_NOT_FOUND',
            `Entity "${op.entityId}" not found in entities.${op.collection}`
          ),
        ]);
      }
      const entity = getOwn(collectionMap, op.entityId) as
        | CharacterEntity
        | FactionEntity
        | ThreatEntity
        | LocationEntity;

      const patchKeys = Object.getOwnPropertyNames(op.patch).sort();
      for (const key of patchKeys) {
        if (!isSafeKey(key)) {
          return err([
            validationError(`${opErrPath}.patch`, 'UNSAFE_KEY', `Forbidden patch key "${key}"`),
          ]);
        }
        const rawFieldVal = Object.getOwnPropertyDescriptor(op.patch, key)?.value;
        const canonicalPath = `entities.${op.collection}.${op.entityId}.${key}`;
        const policy = lookupFieldPolicy(ctx.options.compiledSchema, canonicalPath, ctx.nextState);
        const oldValue = cloneForAudit(getOwn(entity, key));
        const gate = evaluateTrackerGate(ctx.batch.source, canonicalPath, policy);
        if (gate.action === 'reject') {
          const singleFieldOp: PatchOperation = {
            op: 'entity_patch',
            collection: op.collection,
            entityId: op.entityId,
            patch: { [key]: cloneForAudit(rawFieldVal) },
          };
          ctx.rejectedOperations.push({ op: singleFieldOp, reason: gate.reason });
          emitAudit(ctx, op.op, canonicalPath, oldValue, rawFieldVal, 'rejected', gate.reason);
          continue;
        }
        if (gate.action === 'pending') {
          const singleFieldOp: PatchOperation = {
            op: 'entity_patch',
            collection: op.collection,
            entityId: op.entityId,
            patch: { [key]: cloneForAudit(rawFieldVal) },
          };
          ctx.pendingConfirmations.push(singleFieldOp);
          emitAudit(
            ctx,
            op.op,
            canonicalPath,
            oldValue,
            rawFieldVal,
            'pending_confirmation',
            gate.reason
          );
          continue;
        }

        const safeRes = cloneSafeValue(rawFieldVal, `${opErrPath}.patch.${key}`);
        if (!safeRes.ok) {
          return safeRes;
        }
        let nextFieldVal = safeRes.value;
        if (policy) {
          const specRes = enforceDynamicFieldSpec(policy.spec, nextFieldVal, canonicalPath);
          if (!specRes.ok) {
            return specRes;
          }
          nextFieldVal = specRes.value;
        }
        const validated = validateEntityFieldValue(
          op.collection,
          entity,
          key,
          nextFieldVal,
          canonicalPath,
          ctx.nextState
        );
        if (!validated.ok) {
          return validated;
        }
        setOwn(entity, key, validated.value);
        recordChangedIfDifferent(ctx, canonicalPath, oldValue, validated.value);
        emitAudit(ctx, op.op, canonicalPath, oldValue, validated.value, 'committed');
      }
      return ok(undefined);
    }

    case 'form_transform': {
      if (!isSafeKey(op.characterId)) {
        return err([
          validationError(`${opErrPath}.characterId`, 'UNSAFE_KEY', 'Invalid characterId'),
        ]);
      }
      if (typeof op.targetFormId !== 'string' || op.targetFormId.trim().length === 0) {
        return err([
          validationError(
            `${opErrPath}.targetFormId`,
            'REQUIRED',
            'targetFormId must be a non-empty string'
          ),
        ]);
      }
      if (!Object.hasOwn(ctx.nextState.entities.characters, op.characterId)) {
        return err([
          validationError(
            `${opErrPath}.characterId`,
            'ENTITY_NOT_FOUND',
            `Character "${op.characterId}" does not exist`
          ),
        ]);
      }

      const char = getOwn(ctx.nextState.entities.characters, op.characterId) as CharacterEntity;
      const canonicalPath = `entities.characters.${op.characterId}.formId`;
      const policy = lookupFieldPolicy(ctx.options.compiledSchema, canonicalPath, ctx.nextState);
      const oldFormId = char.formId;
      const gate = evaluateTrackerGate(ctx.batch.source, canonicalPath, policy);
      if (gate.action === 'reject') {
        ctx.rejectedOperations.push({ op: cloneOperation(op), reason: gate.reason });
        emitAudit(ctx, op.op, canonicalPath, oldFormId, op.targetFormId, 'rejected', gate.reason);
        return ok(undefined);
      }
      if (gate.action === 'pending') {
        ctx.pendingConfirmations.push(cloneOperation(op));
        emitAudit(
          ctx,
          op.op,
          canonicalPath,
          oldFormId,
          op.targetFormId,
          'pending_confirmation',
          gate.reason
        );
        return ok(undefined);
      }

      if (ctx.options.formIndex) {
        if (!isLegalTransform(char.formId, op.targetFormId, ctx.options.formIndex)) {
          return err([
            validationError(
              canonicalPath,
              'ILLEGAL_FORM_TRANSFORM',
              `Illegal form transform for "${op.characterId}" from "${String(char.formId)}" to "${op.targetFormId}"`
            ),
          ]);
        }
        const transformed = applyFormProfileOverlay(char, op.targetFormId, ctx.options.formIndex);
        setOwn(ctx.nextState.entities.characters, op.characterId, transformed);
        recordChangedIfDifferent(
          ctx,
          `entities.characters.${op.characterId}.formId`,
          char.formId,
          transformed.formId
        );
        recordChangedIfDifferent(
          ctx,
          `entities.characters.${op.characterId}.formGroup`,
          char.formGroup,
          transformed.formGroup
        );
        recordChangedIfDifferent(
          ctx,
          `entities.characters.${op.characterId}.name`,
          char.name,
          transformed.name
        );
        recordChangedIfDifferent(
          ctx,
          `entities.characters.${op.characterId}.abilities`,
          char.abilities,
          transformed.abilities
        );
        recordChangedIfDifferent(
          ctx,
          `entities.characters.${op.characterId}.traits`,
          char.traits,
          transformed.traits
        );
        for (const [secKey, secVal] of Object.entries(transformed.sections)) {
          recordChangedIfDifferent(
            ctx,
            `entities.characters.${op.characterId}.sections.${secKey}`,
            getOwn(char.sections, secKey),
            secVal
          );
        }
        emitAudit(ctx, op.op, canonicalPath, oldFormId, transformed.formId, 'committed');
      } else {
        char.formId = op.targetFormId;
        recordChangedIfDifferent(ctx, canonicalPath, oldFormId, op.targetFormId);
        emitAudit(ctx, op.op, canonicalPath, oldFormId, op.targetFormId, 'committed');
      }
      return ok(undefined);
    }

    case 'emergent_location_visit': {
      if (typeof op.locationName !== 'string' || op.locationName.trim().length === 0) {
        return err([
          validationError(
            `${opErrPath}.locationName`,
            'EMPTY_LOCATION_NAME',
            'locationName must be a non-empty string'
          ),
        ]);
      }

      const canonicalPath = 'scene.location';
      const policy = lookupFieldPolicy(ctx.options.compiledSchema, canonicalPath, ctx.nextState);
      const oldLocation = ctx.nextState.scene.location;
      const oldLocationId = ctx.nextState.scene.locationId;
      const oldPlayerLocationId = ctx.nextState.player.locationId;
      const gate = evaluateTrackerGate(ctx.batch.source, canonicalPath, policy);
      if (gate.action === 'reject') {
        ctx.rejectedOperations.push({ op: cloneOperation(op), reason: gate.reason });
        emitAudit(ctx, op.op, canonicalPath, oldLocation, op.locationName, 'rejected', gate.reason);
        return ok(undefined);
      }
      if (gate.action === 'pending') {
        ctx.pendingConfirmations.push(cloneOperation(op));
        emitAudit(
          ctx,
          op.op,
          canonicalPath,
          oldLocation,
          op.locationName,
          'pending_confirmation',
          gate.reason
        );
        return ok(undefined);
      }

      const mode = ctx.nextState.capabilities.spatialMode;
      const trimmedName = op.locationName.trim();

      if (mode === 'scene_only') {
        ctx.nextState.scene.location = trimmedName;
        recordChangedIfDifferent(ctx, 'scene.location', oldLocation, trimmedName);
        emitAudit(ctx, op.op, 'scene.location', oldLocation, trimmedName, 'committed');
        return ok(undefined);
      }

      if (mode === 'emergent') {
        const res = registerOrResolveEmergentLocation(
          ctx.nextState.entities.locations,
          trimmedName,
          ctx.nextState.scene.locationId
        );
        const prevLocations = ctx.nextState.entities.locations;
        ctx.nextState.entities.locations = res.nextLocations;
        const resolvedLoc = getOwn(res.nextLocations, res.locationId) as LocationEntity;
        ctx.nextState.scene.locationId = res.locationId;
        ctx.nextState.scene.location = resolvedLoc.name;
        ctx.nextState.player.locationId = res.locationId;

        recordChangedIfDifferent(ctx, 'scene.location', oldLocation, resolvedLoc.name);
        recordChangedIfDifferent(ctx, 'scene.locationId', oldLocationId, res.locationId);
        recordChangedIfDifferent(ctx, 'player.locationId', oldPlayerLocationId, res.locationId);
        recordChangedIfDifferent(
          ctx,
          `entities.locations.${res.locationId}`,
          getOwn(prevLocations, res.locationId),
          resolvedLoc
        );
        if (oldLocationId !== null && oldLocationId !== res.locationId) {
          recordChangedIfDifferent(
            ctx,
            `entities.locations.${oldLocationId}`,
            getOwn(prevLocations, oldLocationId),
            getOwn(res.nextLocations, oldLocationId)
          );
        }
        emitAudit(ctx, op.op, 'scene.location', oldLocation, resolvedLoc.name, 'committed');
        return ok(undefined);
      }

      // Tier 2: authored_graph
      const travelRes = validateTravelTarget(
        'authored_graph',
        ctx.nextState.entities.locations,
        ctx.nextState.scene.locationId,
        trimmedName
      );
      if (!travelRes.ok) {
        return travelRes;
      }
      const targetId = travelRes.value.targetId as string;
      const targetLoc = getOwn(ctx.nextState.entities.locations, targetId) as LocationEntity;
      const wasDiscovered = targetLoc.discovered;
      targetLoc.discovered = true;
      ctx.nextState.scene.locationId = targetId;
      ctx.nextState.scene.location = travelRes.value.targetName;
      ctx.nextState.player.locationId = targetId;

      recordChangedIfDifferent(ctx, 'scene.location', oldLocation, travelRes.value.targetName);
      recordChangedIfDifferent(ctx, 'scene.locationId', oldLocationId, targetId);
      recordChangedIfDifferent(ctx, 'player.locationId', oldPlayerLocationId, targetId);
      recordChangedIfDifferent(
        ctx,
        `entities.locations.${targetId}.discovered`,
        wasDiscovered,
        true
      );
      emitAudit(ctx, op.op, 'scene.location', oldLocation, travelRes.value.targetName, 'committed');
      return ok(undefined);
    }

    case 'chronicle_append': {
      const rawEntry = op.entry;
      if (!isPlainObject(rawEntry)) {
        return err([
          validationError(`${opErrPath}.entry`, 'INVALID_TYPE', 'chronicle entry must be an object'),
        ]);
      }
      if (typeof rawEntry.title !== 'string' || rawEntry.title.trim().length === 0) {
        return err([
          validationError(
            `${opErrPath}.entry.title`,
            'REQUIRED',
            'chronicle entry title must be a non-empty string'
          ),
        ]);
      }
      if (
        typeof rawEntry.category !== 'string' ||
        !VALID_CHRONICLE_CATEGORIES.has(rawEntry.category)
      ) {
        return err([
          validationError(
            `${opErrPath}.entry.category`,
            'INVALID_ENUM',
            `Invalid ChronicleCategory "${String(rawEntry.category)}"`
          ),
        ]);
      }
      if (typeof rawEntry.summary !== 'string') {
        return err([
          validationError(`${opErrPath}.entry.summary`, 'INVALID_TYPE', 'summary must be a string'),
        ]);
      }
      if (rawEntry.locationId !== null && typeof rawEntry.locationId !== 'string') {
        return err([
          validationError(
            `${opErrPath}.entry.locationId`,
            'INVALID_TYPE',
            'locationId must be string or null'
          ),
        ]);
      }
      if (
        rawEntry.locationId !== null &&
        ctx.nextState.capabilities.spatialMode === 'authored_graph' &&
        (!isSafeKey(rawEntry.locationId) ||
          !Object.hasOwn(ctx.nextState.entities.locations, rawEntry.locationId))
      ) {
        return err([
          validationError(
            `${opErrPath}.entry.locationId`,
            'UNRESOLVED_LOCATION',
            `Chronicle locationId "${rawEntry.locationId}" does not resolve in entities.locations`
          ),
        ]);
      }
      if (!isStringArray(rawEntry.involvedEntityIds)) {
        return err([
          validationError(
            `${opErrPath}.entry.involvedEntityIds`,
            'INVALID_TYPE',
            'involvedEntityIds must be string[]'
          ),
        ]);
      }
      if (!isStringArray(rawEntry.keywords)) {
        return err([
          validationError(`${opErrPath}.entry.keywords`, 'INVALID_TYPE', 'keywords must be string[]'),
        ]);
      }

      const canonicalPath = 'chronicle.events';
      const policy = lookupFieldPolicy(ctx.options.compiledSchema, canonicalPath, ctx.nextState);
      const oldEvents = cloneForAudit(ctx.nextState.chronicle.events);
      const gate = evaluateTrackerGate(ctx.batch.source, canonicalPath, policy);
      if (gate.action === 'reject') {
        ctx.rejectedOperations.push({ op: cloneOperation(op), reason: gate.reason });
        emitAudit(ctx, op.op, canonicalPath, oldEvents, rawEntry, 'rejected', gate.reason);
        return ok(undefined);
      }
      if (gate.action === 'pending') {
        ctx.pendingConfirmations.push(cloneOperation(op));
        emitAudit(ctx, op.op, canonicalPath, oldEvents, rawEntry, 'pending_confirmation', gate.reason);
        return ok(undefined);
      }

      const normalizedTitle = rawEntry.title.trim().toLowerCase();
      const existingIdx = ctx.nextState.chronicle.events.findIndex(
        (evt) => evt.title.trim().toLowerCase() === normalizedTitle
      );

      if (existingIdx >= 0) {
        const existing = ctx.nextState.chronicle.events[existingIdx] as ChronicleEntry;
        const mergedEntityIds = [...new Set([...existing.involvedEntityIds, ...rawEntry.involvedEntityIds])];
        const mergedKeywords = [...new Set([...existing.keywords, ...rawEntry.keywords])];
        const updatedEntry: ChronicleEntry = {
          id: existing.id,
          turn: ctx.nextState.meta.turn,
          day: ctx.nextState.clocks.day,
          date: ctx.nextState.clocks.inGameDate,
          title: rawEntry.title.trim(),
          category: rawEntry.category as ChronicleCategory,
          summary: rawEntry.summary,
          locationId: rawEntry.locationId,
          involvedEntityIds: mergedEntityIds,
          keywords: mergedKeywords,
        };
        ctx.nextState.chronicle.events[existingIdx] = updatedEntry;
        recordChangedIfDifferent(ctx, canonicalPath, oldEvents, ctx.nextState.chronicle.events);
        emitAudit(ctx, op.op, canonicalPath, existing, updatedEntry, 'committed');
        return ok(undefined);
      }

      const baseId =
        typeof rawEntry.id === 'string' && rawEntry.id.trim().length > 0
          ? rawEntry.id.trim()
          : `chronicle-${ctx.nextState.meta.turn}-${slugifyLocationName(rawEntry.title)}`;
      let uniqueId = baseId;
      let suffix = 2;
      const existingIds = new Set(ctx.nextState.chronicle.events.map((e) => e.id));
      while (existingIds.has(uniqueId)) {
        uniqueId = `${baseId}-${suffix}`;
        suffix += 1;
      }

      const newEntry: ChronicleEntry = {
        id: uniqueId,
        turn: ctx.nextState.meta.turn,
        day: ctx.nextState.clocks.day,
        date: ctx.nextState.clocks.inGameDate,
        title: rawEntry.title.trim(),
        category: rawEntry.category as ChronicleCategory,
        summary: rawEntry.summary,
        locationId: rawEntry.locationId,
        involvedEntityIds: [...rawEntry.involvedEntityIds],
        keywords: [...rawEntry.keywords],
      };
      ctx.nextState.chronicle.events.push(newEntry);
      ctx.changedPaths.add(canonicalPath);
      emitAudit(ctx, op.op, canonicalPath, null, newEntry, 'committed');
      return ok(undefined);
    }

    case 'clock_advance': {
      if (
        op.mechanicalTurns !== undefined &&
        (!Number.isInteger(op.mechanicalTurns) || op.mechanicalTurns < 0)
      ) {
        return err([
          validationError(
            `${opErrPath}.mechanicalTurns`,
            'INVALID_INTEGER',
            'mechanicalTurns must be a non-negative integer'
          ),
        ]);
      }
      if (
        op.storySlots !== undefined &&
        (!Number.isInteger(op.storySlots) || op.storySlots < 0)
      ) {
        return err([
          validationError(
            `${opErrPath}.storySlots`,
            'INVALID_INTEGER',
            'storySlots must be a non-negative integer'
          ),
        ]);
      }

      const policy = lookupFieldPolicy(ctx.options.compiledSchema, 'clocks', ctx.nextState);
      const oldClock = ctx.nextState.clocks;
      const gate = evaluateTrackerGate(ctx.batch.source, 'clocks', policy);
      if (gate.action === 'reject') {
        ctx.rejectedOperations.push({ op: cloneOperation(op), reason: gate.reason });
        emitAudit(ctx, op.op, 'clocks', oldClock, op, 'rejected', gate.reason);
        return ok(undefined);
      }
      if (gate.action === 'pending') {
        ctx.pendingConfirmations.push(cloneOperation(op));
        emitAudit(ctx, op.op, 'clocks', oldClock, op, 'pending_confirmation', gate.reason);
        return ok(undefined);
      }

      const advRes = advanceClock(oldClock, {
        ...(op.mechanicalTurns !== undefined ? { mechanicalTurns: op.mechanicalTurns } : {}),
        ...(op.storySlots !== undefined ? { storySlots: op.storySlots } : {}),
        ...(op.forceIgnoreHold !== undefined ? { forceIgnoreHold: op.forceIgnoreHold } : {}),
      });

      const nextClock = advRes.nextClock;
      ctx.nextState.clocks = {
        ...nextClock,
        slotsPerDay: [...nextClock.slotsPerDay],
      };
      ctx.nextState.meta.turn = nextClock.turn;

      ctx.daysElapsed += advRes.daysElapsed;
      ctx.slotsElapsed += advRes.slotsElapsed;
      ctx.expiredTimers.push(...advRes.expiredTimers);

      recordChangedIfDifferent(ctx, 'clocks.turn', oldClock.turn, nextClock.turn);
      recordChangedIfDifferent(ctx, 'meta.turn', oldClock.turn, nextClock.turn);
      recordChangedIfDifferent(ctx, 'clocks.storyTurn', oldClock.storyTurn, nextClock.storyTurn);
      recordChangedIfDifferent(ctx, 'clocks.day', oldClock.day, nextClock.day);
      recordChangedIfDifferent(ctx, 'clocks.inGameDate', oldClock.inGameDate, nextClock.inGameDate);
      recordChangedIfDifferent(ctx, 'clocks.slot', oldClock.slot, nextClock.slot);
      for (const timerId of Object.keys(nextClock.timers)) {
        const prevTimer = getOwn(oldClock.timers, timerId) as { current: number } | undefined;
        const nextTimer = getOwn(nextClock.timers, timerId) as { current: number } | undefined;
        recordChangedIfDifferent(
          ctx,
          `clocks.timers.${timerId}.current`,
          prevTimer?.current,
          nextTimer?.current
        );
      }

      emitAudit(ctx, op.op, 'clocks', oldClock, ctx.nextState.clocks, 'committed');
      return ok(undefined);
    }

    case 'clock_hold': {
      if (typeof op.reason !== 'string') {
        return err([
          validationError(`${opErrPath}.reason`, 'INVALID_TYPE', 'clock_hold reason must be string'),
        ]);
      }
      const policy = lookupFieldPolicy(ctx.options.compiledSchema, 'clocks.held', ctx.nextState);
      const oldHeld = ctx.nextState.clocks.held;
      const oldReason = ctx.nextState.clocks.holdReason;
      const gate = evaluateTrackerGate(ctx.batch.source, 'clocks.held', policy);
      if (gate.action === 'reject') {
        ctx.rejectedOperations.push({ op: cloneOperation(op), reason: gate.reason });
        emitAudit(ctx, op.op, 'clocks.held', oldHeld, true, 'rejected', gate.reason);
        return ok(undefined);
      }
      if (gate.action === 'pending') {
        ctx.pendingConfirmations.push(cloneOperation(op));
        emitAudit(ctx, op.op, 'clocks.held', oldHeld, true, 'pending_confirmation', gate.reason);
        return ok(undefined);
      }

      const heldClock = holdClock(ctx.nextState.clocks, op.reason);
      ctx.nextState.clocks = {
        ...heldClock,
        slotsPerDay: [...heldClock.slotsPerDay],
      };
      recordChangedIfDifferent(ctx, 'clocks.held', oldHeld, ctx.nextState.clocks.held);
      recordChangedIfDifferent(ctx, 'clocks.holdReason', oldReason, ctx.nextState.clocks.holdReason);
      emitAudit(ctx, op.op, 'clocks.held', oldHeld, true, 'committed', op.reason);
      return ok(undefined);
    }

    case 'clock_release': {
      const policy = lookupFieldPolicy(ctx.options.compiledSchema, 'clocks.held', ctx.nextState);
      const oldHeld = ctx.nextState.clocks.held;
      const oldReason = ctx.nextState.clocks.holdReason;
      const gate = evaluateTrackerGate(ctx.batch.source, 'clocks.held', policy);
      if (gate.action === 'reject') {
        ctx.rejectedOperations.push({ op: cloneOperation(op), reason: gate.reason });
        emitAudit(ctx, op.op, 'clocks.held', oldHeld, false, 'rejected', gate.reason);
        return ok(undefined);
      }
      if (gate.action === 'pending') {
        ctx.pendingConfirmations.push(cloneOperation(op));
        emitAudit(ctx, op.op, 'clocks.held', oldHeld, false, 'pending_confirmation', gate.reason);
        return ok(undefined);
      }

      const releasedClock = releaseClock(ctx.nextState.clocks);
      ctx.nextState.clocks = {
        ...releasedClock,
        slotsPerDay: [...releasedClock.slotsPerDay],
      };
      recordChangedIfDifferent(ctx, 'clocks.held', oldHeld, ctx.nextState.clocks.held);
      recordChangedIfDifferent(ctx, 'clocks.holdReason', oldReason, ctx.nextState.clocks.holdReason);
      emitAudit(ctx, op.op, 'clocks.held', oldHeld, false, 'committed');
      return ok(undefined);
    }

    case 'route_lock': {
      if (typeof op.routeId !== 'string' || op.routeId.trim().length === 0) {
        return err([
          validationError(`${opErrPath}.routeId`, 'REQUIRED', 'routeId must be a non-empty string'),
        ]);
      }
      if (!isSafeKey(op.lockFlag)) {
        return err([
          validationError(
            `${opErrPath}.lockFlag`,
            'UNSAFE_KEY',
            `Invalid lockFlag "${String(op.lockFlag)}"`
          ),
        ]);
      }

      const canonicalPath = `flags.${op.lockFlag}`;
      const oldValue = cloneForAudit(getOwn(ctx.nextState.flags, op.lockFlag));

      if (ctx.batch.source === 'tracker') {
        const reason = `Hard plot guard: tracker is prohibited from executing route_lock (${op.routeId})`;
        ctx.rejectedOperations.push({ op: cloneOperation(op), reason });
        emitAudit(ctx, op.op, canonicalPath, oldValue, true, 'rejected', reason);
        return ok(undefined);
      }

      setOwn(ctx.nextState.flags, op.lockFlag, true);
      recordChangedIfDifferent(ctx, canonicalPath, oldValue, true);
      emitAudit(
        ctx,
        op.op,
        canonicalPath,
        oldValue,
        true,
        'committed',
        ctx.batch.reason ?? `route_lock:${op.routeId}`
      );
      return ok(undefined);
    }

    case 'character_upsert': {
      return applyCharacterUpsertOperation(ctx, op, opIndex);
    }
  }
}

/**
 * Atomically apply a {@link PatchBatch} to a {@link WorldState} snapshot.
 *
 * - Clones `state` upfront so input state is never mutated on commit or rollback.
 * - Enforces `compiledSchema.fieldPolicyMap` bounds, types, tracker writability, and confirmation gates.
 * - Aborts all-or-nothing (BR-2) on any structural, type, or invariant error.
 */
export function applyPatchBatch(
  state: WorldState,
  batch: PatchBatch,
  options: ReducerOptions = {}
): Result<ReducePatchBatchResult, ValidationError[]> {
  if (typeof batch !== 'object' || batch === null) {
    return err([validationError('batch', 'INVALID_TYPE', 'PatchBatch must be an object')]);
  }
  if (typeof batch.eventId !== 'string' || batch.eventId.trim().length === 0) {
    return err([
      validationError('batch.eventId', 'REQUIRED', 'PatchBatch eventId must be a non-empty string'),
    ]);
  }
  if (!VALID_PATCH_SOURCES.has(batch.source)) {
    return err([
      validationError(
        'batch.source',
        'INVALID_ENUM',
        `Unsupported PatchSource "${String(batch.source)}"`
      ),
    ]);
  }
  if (!Array.isArray(batch.operations)) {
    return err([
      validationError('batch.operations', 'INVALID_TYPE', 'PatchBatch operations must be an array'),
    ]);
  }

  const nextState = cloneWorldState(state);
  const ctx: ExecContext = {
    nextState,
    options,
    batch,
    auditEntries: [],
    changedPaths: new Set<string>(),
    pendingConfirmations: [],
    rejectedOperations: [],
    seq: options.auditSeqStart ?? 1,
    daysElapsed: 0,
    slotsElapsed: 0,
    expiredTimers: [],
  };

  for (let i = 0; i < batch.operations.length; i += 1) {
    const op = batch.operations[i];
    if (!op) {
      return err([
        validationError(`operations[${i}]`, 'INVALID_TYPE', 'PatchOperation cannot be undefined'),
      ]);
    }
    const opRes = applySingleOperation(ctx, op, i);
    if (!opRes.ok) {
      return opRes;
    }
  }

  return ok({
    nextState: ctx.nextState,
    auditEntries: ctx.auditEntries,
    changedPaths: ctx.changedPaths,
    pendingConfirmations: ctx.pendingConfirmations,
    rejectedOperations: ctx.rejectedOperations,
    daysElapsed: ctx.daysElapsed,
    slotsElapsed: ctx.slotsElapsed,
    expiredTimers: ctx.expiredTimers,
  });
}
