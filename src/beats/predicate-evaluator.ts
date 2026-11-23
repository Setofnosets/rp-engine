import { type ValidationError, validationError } from '../core/errors.js';
import { matchesLocationPredicate } from '../state/spatial-topology.js';
import type {
  CharacterEntity,
  FactionEntity,
  RelationEntry,
  ThreatEntity,
  WorldState,
} from '../state/world-state.js';
import type { LocationEntity } from '../state/spatial-topology.js';
import {
  type BeatStatus,
  COMPARISON_OPS,
  type ComparisonOp,
  type EntityCollection,
  type PredicateAst,
  isSafePathString,
  isUnsafePropertyKey,
} from './predicate-ast.js';

export interface PredicateEvalContext {
  readonly state: WorldState;
  readonly beatStatuses: ReadonlyMap<string, BeatStatus> | Readonly<Record<string, BeatStatus>>;
  readonly recentTranscriptLines?: readonly string[];
  warnings?: ValidationError[];
}

const VALID_OPS: ReadonlySet<string> = new Set(COMPARISON_OPS);
const WORD_CHAR_START_RE = /^[\p{L}\p{N}_]/u;
const WORD_CHAR_END_RE = /[\p{L}\p{N}_]$/u;
const MENTION_REGEX_CACHE = new Map<string, RegExp>();
const MAX_MENTION_CACHE_SIZE = 512;

type EntityRecord = CharacterEntity | FactionEntity | ThreatEntity | LocationEntity;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

function pushMissingWarning(ctx: PredicateEvalContext, path: string, message: string): void {
  if (ctx.warnings) {
    ctx.warnings.push(validationError(path, 'MISSING_KEY_DEFAULTED', message));
  }
}

function getOwnValue<T>(
  record: Readonly<Record<string, T>> | undefined,
  key: string
): { found: true; value: T } | { found: false } {
  if (!record || isUnsafePropertyKey(key) || !Object.hasOwn(record, key)) {
    return { found: false };
  }
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor || descriptor.value === undefined) {
    return { found: false };
  }
  return { found: true, value: descriptor.value as T };
}

function resolveOwnPath(
  root: unknown,
  path: string
): { found: true; value: unknown } | { found: false } {
  if (!isSafePathString(path) || root === null || typeof root !== 'object') {
    return { found: false };
  }

  // Prefer direct own key first when present (e.g., flat custom field keys containing dots).
  if (!Array.isArray(root) && Object.hasOwn(root, path)) {
    const directDesc = Object.getOwnPropertyDescriptor(root, path);
    if (directDesc && directDesc.value !== undefined) {
      return { found: true, value: directDesc.value };
    }
  }

  const segments = path.split('.');
  let current: unknown = root;
  for (const segment of segments) {
    if (isUnsafePropertyKey(segment) || current === null || typeof current !== 'object') {
      return { found: false };
    }
    if (Array.isArray(current)) {
      if (segment === 'length') {
        current = current.length;
        continue;
      }
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return { found: false };
      }
      current = current[index];
      continue;
    }
    if (!Object.hasOwn(current, segment)) {
      return { found: false };
    }
    const descriptor = Object.getOwnPropertyDescriptor(current, segment);
    if (!descriptor || descriptor.value === undefined) {
      return { found: false };
    }
    current = descriptor.value;
  }

  return { found: true, value: current };
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (a === null || b === null || typeof a !== typeof b) {
    return false;
  }
  if (typeof a !== 'object') {
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
  if (!isPlainObject(a) || !isPlainObject(b)) {
    return false;
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) {
    return false;
  }
  for (const key of keysA) {
    if (isUnsafePropertyKey(key) || !Object.hasOwn(b, key)) {
      return false;
    }
    const descA = Object.getOwnPropertyDescriptor(a, key);
    const descB = Object.getOwnPropertyDescriptor(b, key);
    if (!deepEqual(descA?.value, descB?.value)) {
      return false;
    }
  }
  return true;
}

export function compareValues(actual: unknown, op: ComparisonOp, expected: unknown): boolean {
  switch (op) {
    case '==':
      return deepEqual(actual, expected);

    case '!=':
      return !deepEqual(actual, expected);

    case '<':
    case '<=':
    case '>':
    case '>=': {
      if (
        typeof actual === 'number' &&
        typeof expected === 'number' &&
        Number.isFinite(actual) &&
        Number.isFinite(expected)
      ) {
        if (op === '<') return actual < expected;
        if (op === '<=') return actual <= expected;
        if (op === '>') return actual > expected;
        return actual >= expected;
      }
      if (typeof actual === 'string' && typeof expected === 'string') {
        if (op === '<') return actual < expected;
        if (op === '<=') return actual <= expected;
        if (op === '>') return actual > expected;
        return actual >= expected;
      }
      return false;
    }

    case 'in': {
      if (Array.isArray(expected)) {
        return expected.some((item) => deepEqual(actual, item));
      }
      if (typeof expected === 'string' && typeof actual === 'string') {
        return expected.includes(actual);
      }
      return false;
    }

    case 'contains': {
      if (Array.isArray(actual)) {
        return actual.some((item) => deepEqual(item, expected));
      }
      if (typeof actual === 'string' && typeof expected === 'string') {
        return actual.includes(expected);
      }
      return false;
    }
  }
}

function getEntityCollection(
  state: WorldState,
  collection: EntityCollection
): Readonly<Record<string, EntityRecord>> {
  switch (collection) {
    case 'characters':
      return state.entities.characters;
    case 'factions':
      return state.entities.factions;
    case 'threats':
      return state.entities.threats;
    case 'locations':
      return state.entities.locations;
  }
}

function isWhereOpObject(
  value: unknown
): value is { readonly op: ComparisonOp; readonly value: unknown } {
  return (
    isPlainObject(value) &&
    Object.hasOwn(value, 'op') &&
    Object.hasOwn(value, 'value') &&
    typeof value.op === 'string' &&
    VALID_OPS.has(value.op)
  );
}

function matchesWhereValue(actual: unknown, expected: unknown): boolean {
  if (isWhereOpObject(expected)) {
    return compareValues(actual, expected.op, expected.value);
  }
  if (isPlainObject(expected)) {
    if (!isPlainObject(actual)) {
      return false;
    }
    return matchesWhere(actual, expected);
  }
  if (Array.isArray(actual) && !Array.isArray(expected)) {
    return actual.some((item) => deepEqual(item, expected));
  }
  return deepEqual(actual, expected);
}

function matchesWhere(target: object, where: Record<string, unknown>): boolean {
  const keys = Object.keys(where);
  for (const key of keys) {
    if (!isSafePathString(key)) {
      return false;
    }
    const descriptor = Object.getOwnPropertyDescriptor(where, key);
    const expected = descriptor ? descriptor.value : undefined;
    const resolved = resolveOwnPath(target, key);
    const actual = resolved.found ? resolved.value : null;
    if (!matchesWhereValue(actual, expected)) {
      return false;
    }
  }
  return true;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getMentionRegex(phrase: string): RegExp | null {
  const trimmed = phrase.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const cached = MENTION_REGEX_CACHE.get(trimmed);
  if (cached) {
    return cached;
  }

  const tokens = trimmed.split(/\s+/).map(escapeRegExp);
  const body = tokens.join('\\s+');
  const prefix = WORD_CHAR_START_RE.test(trimmed) ? '(?<![\\p{L}\\p{N}_])' : '';
  const suffix = WORD_CHAR_END_RE.test(trimmed) ? '(?![\\p{L}\\p{N}_])' : '';
  const regex = new RegExp(`${prefix}${body}${suffix}`, 'iu');

  if (MENTION_REGEX_CACHE.size >= MAX_MENTION_CACHE_SIZE) {
    MENTION_REGEX_CACHE.clear();
  }
  MENTION_REGEX_CACHE.set(trimmed, regex);
  return regex;
}

function evaluateRelation(
  ast: Extract<PredicateAst, { relation: readonly [string, string] }>,
  ctx: PredicateEvalContext
): boolean {
  const [fromId, toId] = ast.relation;
  const fromMapRes = getOwnValue(ctx.state.relations, fromId);
  const entryRes = fromMapRes.found ? getOwnValue(fromMapRes.value, toId) : { found: false as const };

  let entry: RelationEntry;
  if (!entryRes.found) {
    pushMissingWarning(
      ctx,
      `relations.${fromId}.${toId}`,
      `Missing relation "${fromId}" -> "${toId}" defaulted for evaluation`
    );
    entry = {
      affinity: 0,
      maxAffinity: 100,
      label: '',
      tags: [],
    };
  } else {
    entry = entryRes.value;
  }

  switch (ast.field) {
    case 'affinity':
      return compareValues(entry.affinity, ast.op, ast.value);
    case 'label':
      return compareValues(entry.label, ast.op, ast.value);
    case 'tag': {
      if (ast.op === '==' && typeof ast.value === 'string') {
        return entry.tags.includes(ast.value);
      }
      if (ast.op === '!=' && typeof ast.value === 'string') {
        return !entry.tags.includes(ast.value);
      }
      if (ast.op === 'in' && Array.isArray(ast.value)) {
        const expectedList = ast.value;
        return entry.tags.some((tag) => expectedList.some((item) => deepEqual(tag, item)));
      }
      return compareValues(entry.tags, ast.op, ast.value);
    }
  }
}

function isBeatStatusMap(
  statuses: ReadonlyMap<string, BeatStatus> | Readonly<Record<string, BeatStatus>>
): statuses is ReadonlyMap<string, BeatStatus> {
  return (
    statuses instanceof Map ||
    typeof (statuses as { get?: unknown }).get === 'function'
  );
}

function evaluateBeatStatus(
  ast: Extract<PredicateAst, { beat: string }>,
  ctx: PredicateEvalContext
): boolean {
  let actualStatus: BeatStatus | undefined;
  if (isBeatStatusMap(ctx.beatStatuses)) {
    actualStatus = ctx.beatStatuses.get(ast.beat);
  } else {
    const res = getOwnValue(ctx.beatStatuses, ast.beat);
    actualStatus = res.found ? res.value : undefined;
  }

  if (actualStatus === undefined) {
    pushMissingWarning(
      ctx,
      `beats.${ast.beat}.status`,
      `Missing status for beat "${ast.beat}" defaulted to null`
    );
    return false;
  }

  if (Array.isArray(ast.status)) {
    return ast.status.includes(actualStatus);
  }
  return actualStatus === ast.status;
}

function evaluateFormActive(
  character: string,
  form: string,
  ctx: PredicateEvalContext
): boolean {
  const charRes = getOwnValue(ctx.state.entities.characters, character);
  if (!charRes.found) {
    pushMissingWarning(
      ctx,
      `entities.characters.${character}`,
      `Missing character "${character}" for form_active check`
    );
    return false;
  }
  return charRes.value.formId === form;
}

/**
 * Pure and total evaluator for {@link PredicateAst} against a {@link PredicateEvalContext}.
 * Missing flags default to `false`, missing counters/clocks default to `0`, and missing
 * entity/custom fields default to `null` (appending BR-8 warnings when `ctx.warnings` is provided).
 */
export function evaluatePredicate(ast: PredicateAst, ctx: PredicateEvalContext): boolean {
  if ('flag' in ast) {
    const flagRes = getOwnValue(ctx.state.flags, ast.flag);
    let actual: boolean;
    if (!flagRes.found || typeof flagRes.value !== 'boolean') {
      pushMissingWarning(
        ctx,
        `flags.${ast.flag}`,
        `Missing flag "${ast.flag}" defaulted to false`
      );
      actual = false;
    } else {
      actual = flagRes.value;
    }
    const expected = ast.value ?? true;
    return actual === expected;
  }

  if ('counter' in ast) {
    const counterRes = getOwnValue(ctx.state.counters, ast.counter);
    let actual: number;
    if (!counterRes.found || typeof counterRes.value !== 'number' || !Number.isFinite(counterRes.value)) {
      pushMissingWarning(
        ctx,
        `counters.${ast.counter}`,
        `Missing counter "${ast.counter}" defaulted to 0`
      );
      actual = 0;
    } else {
      actual = counterRes.value;
    }
    return compareValues(actual, ast.op, ast.value);
  }

  if ('custom_field' in ast) {
    let container: Record<string, unknown> | undefined;
    let basePath: string;

    if (ast.target === undefined || ast.target === 'global') {
      container = ctx.state.customFields;
      basePath = 'customFields';
    } else if (ast.target === 'player') {
      container = ctx.state.player.customFields;
      basePath = 'player.customFields';
    } else {
      const charRes = getOwnValue(ctx.state.entities.characters, ast.target);
      if (!charRes.found) {
        pushMissingWarning(
          ctx,
          `entities.characters.${ast.target}`,
          `Missing target character "${ast.target}" for custom_field "${ast.custom_field}"`
        );
        return compareValues(null, ast.op, ast.value);
      }
      container = charRes.value.customFields;
      basePath = `entities.characters.${ast.target}.customFields`;
    }

    const fieldRes = resolveOwnPath(container, ast.custom_field);
    let actual: unknown;
    if (!fieldRes.found) {
      pushMissingWarning(
        ctx,
        `${basePath}.${ast.custom_field}`,
        `Missing custom field "${basePath}.${ast.custom_field}" defaulted to null`
      );
      actual = null;
    } else {
      actual = fieldRes.value;
    }
    return compareValues(actual, ast.op, ast.value);
  }

  if ('clock' in ast) {
    let actual: number;
    if (ast.clock === 'day') {
      actual = Number.isFinite(ctx.state.clocks.day) ? ctx.state.clocks.day : 0;
    } else if (ast.clock === 'turn') {
      actual = Number.isFinite(ctx.state.clocks.turn) ? ctx.state.clocks.turn : 0;
    } else if (ast.clock === 'story_turn' || ast.clock === 'storyTurn') {
      actual = Number.isFinite(ctx.state.clocks.storyTurn) ? ctx.state.clocks.storyTurn : 0;
    } else {
      const timerRes = getOwnValue(ctx.state.clocks.timers, ast.clock);
      if (!timerRes.found || typeof timerRes.value.current !== 'number' || !Number.isFinite(timerRes.value.current)) {
        pushMissingWarning(
          ctx,
          `clocks.timers.${ast.clock}`,
          `Missing clock timer "${ast.clock}" defaulted to 0`
        );
        actual = 0;
      } else {
        actual = timerRes.value.current;
      }
    }
    return compareValues(actual, ast.op, ast.value);
  }

  if ('slot' in ast) {
    if (typeof ctx.state.clocks.slot !== 'string') {
      return false;
    }
    return ctx.state.clocks.slot.trim().toLowerCase() === ast.slot.trim().toLowerCase();
  }

  if ('at' in ast) {
    return matchesLocationPredicate(
      ctx.state.capabilities.spatialMode,
      ctx.state.scene,
      ctx.state.entities.locations,
      ast.at
    );
  }

  if ('relation' in ast) {
    return evaluateRelation(ast, ctx);
  }

  if ('entity' in ast) {
    const [coll, id, fieldPath] = ast.entity;
    const collection = getEntityCollection(ctx.state, coll);
    const entityRes = getOwnValue(collection, id);
    if (!entityRes.found) {
      pushMissingWarning(
        ctx,
        `entities.${coll}.${id}`,
        `Missing entity "${coll}.${id}" defaulted to null`
      );
      return compareValues(null, ast.op, ast.value);
    }

    const fieldRes = resolveOwnPath(entityRes.value, fieldPath);
    let actual: unknown;
    if (!fieldRes.found) {
      pushMissingWarning(
        ctx,
        `entities.${coll}.${id}.${fieldPath}`,
        `Missing entity field "entities.${coll}.${id}.${fieldPath}" defaulted to null`
      );
      actual = null;
    } else {
      actual = fieldRes.value;
    }
    return compareValues(actual, ast.op, ast.value);
  }

  if ('any_entity' in ast) {
    const collection = getEntityCollection(ctx.state, ast.any_entity);
    const sortedKeys = Object.keys(collection).sort();
    for (const key of sortedKeys) {
      const entityRes = getOwnValue(collection, key);
      if (entityRes.found && matchesWhere(entityRes.value, ast.where)) {
        return true;
      }
    }
    return false;
  }

  if ('count_entities' in ast) {
    const collection = getEntityCollection(ctx.state, ast.count_entities);
    const sortedKeys = Object.keys(collection).sort();
    let count = 0;
    for (const key of sortedKeys) {
      const entityRes = getOwnValue(collection, key);
      if (entityRes.found && matchesWhere(entityRes.value, ast.where)) {
        count += 1;
      }
    }
    return compareValues(count, ast.op, ast.value);
  }

  if ('beat' in ast) {
    return evaluateBeatStatus(ast, ctx);
  }

  if ('form_active' in ast) {
    return evaluateFormActive(ast.form_active.character, ast.form_active.form, ctx);
  }

  if ('character' in ast && 'form' in ast) {
    return evaluateFormActive(ast.character, ast.form, ctx);
  }

  if ('mentions' in ast) {
    const windowSize = ast.window ?? 2;
    const lines = ctx.recentTranscriptLines;
    if (!lines || lines.length === 0 || windowSize <= 0) {
      return false;
    }
    const windowLines = lines.slice(-windowSize);
    for (const phrase of ast.mentions) {
      const regex = getMentionRegex(phrase);
      if (!regex) {
        continue;
      }
      for (const line of windowLines) {
        if (regex.test(line)) {
          return true;
        }
      }
    }
    return false;
  }

  if ('all' in ast) {
    for (const sub of ast.all) {
      if (!evaluatePredicate(sub, ctx)) {
        return false;
      }
    }
    return true;
  }

  if ('any' in ast) {
    for (const sub of ast.any) {
      if (evaluatePredicate(sub, ctx)) {
        return true;
      }
    }
    return false;
  }

  if ('not' in ast) {
    return !evaluatePredicate(ast.not, ctx);
  }

  return false;
}
