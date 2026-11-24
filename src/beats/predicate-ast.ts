import { type ValidationError } from '../core/errors.js';
import { ErrorAccumulator, type Result, err, ok } from '../core/result.js';

export const COMPARISON_OPS = Object.freeze([
  '==',
  '!=',
  '<',
  '<=',
  '>',
  '>=',
  'in',
  'contains',
] as const);

export type ComparisonOp = (typeof COMPARISON_OPS)[number];

export const BEAT_STATUSES = Object.freeze([
  'dormant',
  'eligible',
  'live',
  'deferred',
  'resolved',
  'adapted',
  'short_circuited',
  'closed',
] as const);

export type BeatStatus = (typeof BEAT_STATUSES)[number];

export const ENTITY_COLLECTIONS = Object.freeze([
  'characters',
  'factions',
  'threats',
  'locations',
] as const);

export type EntityCollection = (typeof ENTITY_COLLECTIONS)[number];

export const RELATION_FIELDS = Object.freeze(['affinity', 'label', 'tag'] as const);

export type RelationField = (typeof RELATION_FIELDS)[number];

export type PredicateAst =
  | { flag: string; value?: boolean }
  | { counter: string; op: ComparisonOp; value: number }
  | { custom_field: string; target?: 'global' | 'player' | string; op: ComparisonOp; value: unknown }
  | { clock: 'day' | 'story_turn' | 'turn' | string; op: ComparisonOp; value: number }
  | { slot: string }
  | {
      at: string;
      discoveryState?: 'unknown' | 'rumored' | 'discovered' | 'visited';
      districtId?: string;
    }
  | { relation: readonly [string, string]; field: RelationField; op: ComparisonOp; value: unknown }
  | { entity: readonly [EntityCollection, string, string]; op: ComparisonOp; value: unknown }
  | { any_entity: EntityCollection; where: Record<string, unknown> }
  | { count_entities: EntityCollection; where: Record<string, unknown>; op: ComparisonOp; value: number }
  | { beat: string; status: BeatStatus | readonly BeatStatus[] }
  | { form_active: { character: string; form: string } }
  | { character: string; form: string }
  | { mentions: readonly string[]; window?: number }
  | { all: readonly PredicateAst[] }
  | { any: readonly PredicateAst[] }
  | { not: PredicateAst };

const VALID_COMPARISON_OPS: ReadonlySet<string> = new Set(COMPARISON_OPS);
const VALID_BEAT_STATUSES: ReadonlySet<string> = new Set(BEAT_STATUSES);
const VALID_ENTITY_COLLECTIONS: ReadonlySet<string> = new Set(ENTITY_COLLECTIONS);
const VALID_RELATION_FIELDS: ReadonlySet<string> = new Set(RELATION_FIELDS);

const UNSAFE_PROPERTY_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

const PRIMARY_PREDICATE_KEYS: ReadonlySet<string> = new Set([
  'flag',
  'counter',
  'custom_field',
  'clock',
  'slot',
  'at',
  'relation',
  'entity',
  'any_entity',
  'count_entities',
  'beat',
  'form_active',
  'mentions',
  'all',
  'any',
  'not',
]);

export function isUnsafePropertyKey(key: string): boolean {
  return UNSAFE_PROPERTY_KEYS.has(key);
}

export function isSafePathString(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return false;
  }
  if (isUnsafePropertyKey(value) || isUnsafePropertyKey(trimmed)) {
    return false;
  }
  const segments = value.split('.');
  for (const segment of segments) {
    if (segment.length === 0 || isUnsafePropertyKey(segment)) {
      return false;
    }
  }
  return true;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

function checkAllowedKeys(
  obj: Record<string, unknown>,
  allowedKeys: readonly string[],
  acc: ErrorAccumulator
): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.getOwnPropertyNames(obj)) {
    if (isUnsafePropertyKey(key)) {
      acc.add(key, 'UNSAFE_PROPERTY_KEY', `Forbidden prototype property key "${key}"`);
      continue;
    }
    if (!allowed.has(key)) {
      acc.add(key, 'INVALID_PREDICATE_KEYS', `Unexpected key "${key}" in predicate`);
    }
  }
}

function validateSafeString(
  raw: unknown,
  fieldName: string,
  code: string,
  acc: ErrorAccumulator,
  checkPathSegments = false
): void {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    acc.add(fieldName, code, `${fieldName} must be a non-empty string`);
    return;
  }
  if (isUnsafePropertyKey(raw) || isUnsafePropertyKey(raw.trim())) {
    acc.add(fieldName, 'UNSAFE_PROPERTY_KEY', `${fieldName} cannot use reserved key "${raw}"`);
    return;
  }
  if (checkPathSegments && !isSafePathString(raw)) {
    acc.add(
      fieldName,
      'INVALID_PATH_SEGMENT',
      `${fieldName} contains empty or unsafe dot-path segment`
    );
  }
}

function validateComparisonOp(raw: unknown, acc: ErrorAccumulator): void {
  if (typeof raw !== 'string' || !VALID_COMPARISON_OPS.has(raw)) {
    acc.add(
      'op',
      'INVALID_COMPARISON_OP',
      `Invalid comparison op "${String(raw)}"; expected one of ${COMPARISON_OPS.join(', ')}`
    );
  }
}

function validateWhereValue(raw: unknown, acc: ErrorAccumulator): void {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return;
  }
  if (!isPlainObject(raw)) {
    acc.add('', 'INVALID_WHERE_CLAUSE', 'where matcher value must be a plain value, array, or object');
    return;
  }
  for (const key of Object.getOwnPropertyNames(raw)) {
    if (isUnsafePropertyKey(key)) {
      acc.add(key, 'UNSAFE_PROPERTY_KEY', `Forbidden prototype property key "${key}" in where clause`);
    }
  }
  if (Object.hasOwn(raw, 'op')) {
    checkAllowedKeys(raw, ['op', 'value'], acc);
    validateComparisonOp(raw.op, acc);
    if (!Object.hasOwn(raw, 'value')) {
      acc.add('value', 'MISSING_VALUE', 'where operator matcher must include a value');
    }
    return;
  }
  for (const key of Object.keys(raw)) {
    if (!isSafePathString(key)) {
      acc.add(key, 'INVALID_PATH_SEGMENT', `Unsafe or empty where key "${key}"`);
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (descriptor) {
      validateWhereValue(descriptor.value, acc.scope(key));
    }
  }
}

function validateWhereClause(raw: unknown, acc: ErrorAccumulator): void {
  if (!isPlainObject(raw)) {
    acc.add('where', 'INVALID_WHERE_CLAUSE', 'where clause must be a plain object');
    return;
  }
  const whereAcc = acc.scope('where');
  for (const key of Object.getOwnPropertyNames(raw)) {
    if (isUnsafePropertyKey(key)) {
      whereAcc.add(
        key,
        'UNSAFE_PROPERTY_KEY',
        `Forbidden prototype property key "${key}" in where clause`
      );
      continue;
    }
    if (!isSafePathString(key)) {
      whereAcc.add(key, 'INVALID_PATH_SEGMENT', `Unsafe or empty where field path "${key}"`);
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (descriptor) {
      validateWhereValue(descriptor.value, whereAcc.scope(key));
    }
  }
}

function recordUnsafeOwnKeys(obj: Record<string, unknown>, acc: ErrorAccumulator): void {
  for (const ownKey of Object.getOwnPropertyNames(obj)) {
    if (isUnsafePropertyKey(ownKey)) {
      acc.add(ownKey, 'UNSAFE_PROPERTY_KEY', `Forbidden prototype property key "${ownKey}"`);
    }
  }
}

function validatePredicateInto(value: unknown, acc: ErrorAccumulator): void {
  if (!isPlainObject(value)) {
    acc.add('', 'INVALID_PREDICATE_AST', 'Predicate AST must be a non-null plain object');
    return;
  }

  const matchedPrimaries: string[] = [];
  for (const key of PRIMARY_PREDICATE_KEYS) {
    if (Object.hasOwn(value, key)) {
      matchedPrimaries.push(key);
    }
  }

  const hasFlatForm =
    !Object.hasOwn(value, 'form_active') &&
    (Object.hasOwn(value, 'character') || Object.hasOwn(value, 'form'));
  if (hasFlatForm) {
    matchedPrimaries.push('form_flat');
  }

  if (matchedPrimaries.length === 0) {
    recordUnsafeOwnKeys(value, acc);
    acc.add(
      '',
      'UNKNOWN_PREDICATE_TYPE',
      'Predicate AST object has no recognized predicate discriminant key'
    );
    return;
  }

  if (matchedPrimaries.length > 1) {
    recordUnsafeOwnKeys(value, acc);
    acc.add(
      '',
      'AMBIGUOUS_PREDICATE_TYPE',
      `Predicate AST object cannot combine multiple predicate types: ${matchedPrimaries.join(', ')}`
    );
    return;
  }

  const kind = matchedPrimaries[0];
  switch (kind) {
    case 'flag': {
      checkAllowedKeys(value, ['flag', 'value'], acc);
      validateSafeString(value.flag, 'flag', 'INVALID_FLAG_NAME', acc);
      if (value.value !== undefined && typeof value.value !== 'boolean') {
        acc.add('value', 'INVALID_FLAG_VALUE', 'flag value must be a boolean when specified');
      }
      break;
    }

    case 'counter': {
      checkAllowedKeys(value, ['counter', 'op', 'value'], acc);
      validateSafeString(value.counter, 'counter', 'INVALID_COUNTER_NAME', acc);
      validateComparisonOp(value.op, acc);
      if (typeof value.value !== 'number' || !Number.isFinite(value.value)) {
        acc.add('value', 'INVALID_COUNTER_VALUE', 'counter value must be a finite number');
      }
      break;
    }

    case 'custom_field': {
      checkAllowedKeys(value, ['custom_field', 'target', 'op', 'value'], acc);
      validateSafeString(value.custom_field, 'custom_field', 'INVALID_CUSTOM_FIELD_NAME', acc, true);
      if (value.target !== undefined) {
        validateSafeString(value.target, 'target', 'INVALID_CUSTOM_FIELD_TARGET', acc);
      }
      validateComparisonOp(value.op, acc);
      if (!Object.hasOwn(value, 'value')) {
        acc.add('value', 'MISSING_VALUE', 'custom_field predicate must include a value property');
      }
      break;
    }

    case 'clock': {
      checkAllowedKeys(value, ['clock', 'op', 'value'], acc);
      validateSafeString(value.clock, 'clock', 'INVALID_CLOCK_NAME', acc);
      validateComparisonOp(value.op, acc);
      if (typeof value.value !== 'number' || !Number.isFinite(value.value)) {
        acc.add('value', 'INVALID_CLOCK_VALUE', 'clock value must be a finite number');
      }
      break;
    }

    case 'slot': {
      checkAllowedKeys(value, ['slot'], acc);
      validateSafeString(value.slot, 'slot', 'INVALID_SLOT_NAME', acc);
      break;
    }

    case 'at': {
      checkAllowedKeys(value, ['at', 'discoveryState', 'districtId'], acc);
      validateSafeString(value.at, 'at', 'INVALID_LOCATION_NAME', acc);
      if (
        value.discoveryState !== undefined &&
        value.discoveryState !== 'unknown' &&
        value.discoveryState !== 'rumored' &&
        value.discoveryState !== 'discovered' &&
        value.discoveryState !== 'visited'
      ) {
        acc.add(
          'discoveryState',
          'INVALID_DISCOVERY_STATE',
          'discoveryState must be unknown, rumored, discovered, or visited'
        );
      }
      if (value.districtId !== undefined) {
        validateSafeString(value.districtId, 'districtId', 'INVALID_DISTRICT_ID', acc);
      }
      break;
    }

    case 'relation': {
      checkAllowedKeys(value, ['relation', 'field', 'op', 'value'], acc);
      if (!Array.isArray(value.relation) || value.relation.length !== 2) {
        acc.add(
          'relation',
          'INVALID_RELATION_PAIR',
          'relation must be a 2-element tuple [from, to]'
        );
      } else {
        validateSafeString(value.relation[0], 'relation[0]', 'INVALID_RELATION_ENTITY', acc);
        validateSafeString(value.relation[1], 'relation[1]', 'INVALID_RELATION_ENTITY', acc);
      }
      if (typeof value.field !== 'string' || !VALID_RELATION_FIELDS.has(value.field)) {
        acc.add(
          'field',
          'INVALID_RELATION_FIELD',
          `Invalid relation field "${String(value.field)}"`
        );
      }
      validateComparisonOp(value.op, acc);
      if (!Object.hasOwn(value, 'value')) {
        acc.add('value', 'MISSING_VALUE', 'relation predicate must include a value property');
      }
      break;
    }

    case 'entity': {
      checkAllowedKeys(value, ['entity', 'op', 'value'], acc);
      if (!Array.isArray(value.entity) || value.entity.length !== 3) {
        acc.add(
          'entity',
          'INVALID_ENTITY_TUPLE',
          'entity must be a 3-element tuple [collection, id, fieldPath]'
        );
      } else {
        const [coll, id, fieldPath] = value.entity;
        if (typeof coll !== 'string' || !VALID_ENTITY_COLLECTIONS.has(coll)) {
          acc.add(
            'entity[0]',
            'INVALID_ENTITY_COLLECTION',
            `Invalid entity collection "${String(coll)}"`
          );
        }
        validateSafeString(id, 'entity[1]', 'INVALID_ENTITY_ID', acc);
        validateSafeString(fieldPath, 'entity[2]', 'INVALID_ENTITY_PATH', acc, true);
      }
      validateComparisonOp(value.op, acc);
      if (!Object.hasOwn(value, 'value')) {
        acc.add('value', 'MISSING_VALUE', 'entity predicate must include a value property');
      }
      break;
    }

    case 'any_entity': {
      checkAllowedKeys(value, ['any_entity', 'where'], acc);
      if (typeof value.any_entity !== 'string' || !VALID_ENTITY_COLLECTIONS.has(value.any_entity)) {
        acc.add(
          'any_entity',
          'INVALID_ENTITY_COLLECTION',
          `Invalid entity collection "${String(value.any_entity)}"`
        );
      }
      validateWhereClause(value.where, acc);
      break;
    }

    case 'count_entities': {
      checkAllowedKeys(value, ['count_entities', 'where', 'op', 'value'], acc);
      if (
        typeof value.count_entities !== 'string' ||
        !VALID_ENTITY_COLLECTIONS.has(value.count_entities)
      ) {
        acc.add(
          'count_entities',
          'INVALID_ENTITY_COLLECTION',
          `Invalid entity collection "${String(value.count_entities)}"`
        );
      }
      validateWhereClause(value.where, acc);
      validateComparisonOp(value.op, acc);
      if (typeof value.value !== 'number' || !Number.isFinite(value.value)) {
        acc.add('value', 'INVALID_COUNT_VALUE', 'count_entities value must be a finite number');
      }
      break;
    }

    case 'beat': {
      checkAllowedKeys(value, ['beat', 'status'], acc);
      validateSafeString(value.beat, 'beat', 'INVALID_BEAT_ID', acc);
      if (typeof value.status === 'string') {
        if (!VALID_BEAT_STATUSES.has(value.status)) {
          acc.add('status', 'INVALID_BEAT_STATUS', `Invalid beat status "${value.status}"`);
        }
      } else if (Array.isArray(value.status)) {
        if (value.status.length === 0) {
          acc.add('status', 'EMPTY_BEAT_STATUS_ARRAY', 'beat status array cannot be empty');
        } else {
          for (let i = 0; i < value.status.length; i += 1) {
            const st = value.status[i];
            if (typeof st !== 'string' || !VALID_BEAT_STATUSES.has(st)) {
              acc.add(
                `status[${i}]`,
                'INVALID_BEAT_STATUS',
                `Invalid beat status "${String(st)}"`
              );
            }
          }
        }
      } else {
        acc.add(
          'status',
          'INVALID_BEAT_STATUS_TYPE',
          'beat status must be a BeatStatus string or non-empty array of BeatStatus values'
        );
      }
      break;
    }

    case 'form_active': {
      checkAllowedKeys(value, ['form_active'], acc);
      if (!isPlainObject(value.form_active)) {
        acc.add('form_active', 'INVALID_FORM_ACTIVE', 'form_active must be a plain object');
      } else {
        const faAcc = acc.scope('form_active');
        checkAllowedKeys(value.form_active, ['character', 'form'], faAcc);
        validateSafeString(value.form_active.character, 'character', 'INVALID_CHARACTER_NAME', faAcc);
        validateSafeString(value.form_active.form, 'form', 'INVALID_FORM_NAME', faAcc);
      }
      break;
    }

    case 'form_flat': {
      checkAllowedKeys(value, ['character', 'form'], acc);
      validateSafeString(value.character, 'character', 'INVALID_CHARACTER_NAME', acc);
      validateSafeString(value.form, 'form', 'INVALID_FORM_NAME', acc);
      break;
    }

    case 'mentions': {
      checkAllowedKeys(value, ['mentions', 'window'], acc);
      if (!Array.isArray(value.mentions) || value.mentions.length === 0) {
        acc.add('mentions', 'EMPTY_MENTIONS_ARRAY', 'mentions must be a non-empty array of strings');
      } else {
        for (let i = 0; i < value.mentions.length; i += 1) {
          const phrase = value.mentions[i];
          if (typeof phrase !== 'string' || phrase.trim().length === 0) {
            acc.add(
              `mentions[${i}]`,
              'INVALID_MENTION_PHRASE',
              'Each mention phrase must be a non-empty string'
            );
          }
        }
      }
      if (
        value.window !== undefined &&
        (typeof value.window !== 'number' || !Number.isInteger(value.window) || value.window <= 0)
      ) {
        acc.add('window', 'INVALID_WINDOW_SIZE', 'mentions window must be a positive integer');
      }
      break;
    }

    case 'all': {
      checkAllowedKeys(value, ['all'], acc);
      if (!Array.isArray(value.all)) {
        acc.add('all', 'INVALID_ALL_COMBINATOR', 'all combinator must be an array');
      } else {
        for (let i = 0; i < value.all.length; i += 1) {
          validatePredicateInto(value.all[i], acc.scope(`all[${i}]`));
        }
      }
      break;
    }

    case 'any': {
      checkAllowedKeys(value, ['any'], acc);
      if (!Array.isArray(value.any)) {
        acc.add('any', 'INVALID_ANY_COMBINATOR', 'any combinator must be an array');
      } else {
        for (let i = 0; i < value.any.length; i += 1) {
          validatePredicateInto(value.any[i], acc.scope(`any[${i}]`));
        }
      }
      break;
    }

    case 'not': {
      checkAllowedKeys(value, ['not'], acc);
      validatePredicateInto(value.not, acc.scope('not'));
      break;
    }
  }
}

/**
 * Validate an unknown value as a {@link PredicateAst}, rejecting unknown keys,
 * invalid operators, non-array combinators, empty `mentions`, and prototype pollution keys.
 */
export function validatePredicateAst(
  value: unknown,
  path = ''
): Result<PredicateAst, ValidationError[]> {
  const acc = new ErrorAccumulator(path);
  validatePredicateInto(value, acc);
  if (acc.hasErrors()) {
    return err([...acc.errors]);
  }
  return ok(value as PredicateAst);
}
