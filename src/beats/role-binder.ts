import type { LocationEntity } from '../state/spatial-topology.js';
import type { CharacterEntity, FactionEntity, WorldState } from '../state/world-state.js';
import {
  COMPARISON_OPS,
  type ComparisonOp,
  isSafePathString,
  isUnsafePropertyKey,
} from './predicate-ast.js';
import { compareValues } from './predicate-evaluator.js';

export type RoleEntityCollection = 'characters' | 'factions' | 'locations';

export interface BeatRoleSpec {
  readonly default: string;
  readonly fallbackQuery?: {
    readonly collection: RoleEntityCollection;
    readonly where: Record<string, unknown>;
  };
}

export interface BoundRoleResult {
  readonly roleKey: string;
  readonly entityId: string;
  readonly displayName: string;
  readonly adapted: boolean;
  readonly adaptedFrom?: string;
  readonly adaptedTo?: string;
}

export interface BindBeatRolesOptions {
  readonly allowFallback?: boolean;
}

export interface BindBeatRolesOutcome {
  readonly ok: boolean;
  readonly bindings: Record<string, BoundRoleResult>;
  readonly missingStrictRole?: string;
}

type RoleEntityRecord = CharacterEntity | FactionEntity | LocationEntity;

const VALID_OPS: ReadonlySet<string> = new Set(COMPARISON_OPS);
const TEMPLATE_TOKEN_RE = /\{\{roles\.([^{}.]+)\.(name|id)\}\}/gu;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

function getOwnEntity<T>(
  collection: Readonly<Record<string, T>>,
  id: string
): T | undefined {
  if (isUnsafePropertyKey(id) || !Object.hasOwn(collection, id)) {
    return undefined;
  }
  const desc = Object.getOwnPropertyDescriptor(collection, id);
  return desc?.value as T | undefined;
}

function setSafeBinding(
  target: Record<string, BoundRoleResult>,
  roleKey: string,
  binding: BoundRoleResult
): void {
  Object.defineProperty(target, roleKey, {
    value: binding,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

function resolveOwnPath(
  root: unknown,
  path: string
): { found: true; value: unknown } | { found: false } {
  if (!isSafePathString(path) || root === null || typeof root !== 'object') {
    return { found: false };
  }

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
    const desc = Object.getOwnPropertyDescriptor(current, segment);
    if (!desc || desc.value === undefined) {
      return { found: false };
    }
    current = desc.value;
  }

  return { found: true, value: current };
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
    return actual.some((item) => compareValues(item, '==', expected));
  }
  return compareValues(actual, '==', expected);
}

function matchesWhere(target: object, where: Record<string, unknown>): boolean {
  for (const key of Object.keys(where)) {
    if (!isSafePathString(key)) {
      return false;
    }
    const desc = Object.getOwnPropertyDescriptor(where, key);
    const expected = desc ? desc.value : undefined;
    const resolved = resolveOwnPath(target, key);
    const actual = resolved.found ? resolved.value : null;
    if (!matchesWhereValue(actual, expected)) {
      return false;
    }
  }
  return true;
}

function isEntityUsable(collection: RoleEntityCollection, entity: RoleEntityRecord): boolean {
  switch (collection) {
    case 'characters':
      return (entity as CharacterEntity).status === 'active';
    case 'factions':
      return (entity as FactionEntity).status !== 'disbanded';
    case 'locations':
      return (entity as LocationEntity).status !== 'destroyed';
  }
}

function getCollectionMap(
  state: WorldState,
  collection: RoleEntityCollection
): Readonly<Record<string, RoleEntityRecord>> {
  switch (collection) {
    case 'characters':
      return state.entities.characters;
    case 'factions':
      return state.entities.factions;
    case 'locations':
      return state.entities.locations;
  }
}

function lookupDefaultEntity(
  state: WorldState,
  defaultId: string,
  preferredCollection?: RoleEntityCollection
): { collection: RoleEntityCollection; entity: RoleEntityRecord } | undefined {
  if (isUnsafePropertyKey(defaultId)) {
    return undefined;
  }
  const order: readonly RoleEntityCollection[] =
    preferredCollection !== undefined
      ? [
          preferredCollection,
          ...(['characters', 'factions', 'locations'] as const).filter(
            (c) => c !== preferredCollection
          ),
        ]
      : ['characters', 'factions', 'locations'];

  for (const collection of order) {
    const map = getCollectionMap(state, collection);
    const entity = getOwnEntity(map, defaultId);
    if (entity !== undefined) {
      return { collection, entity };
    }
  }
  return undefined;
}

function isInCurrentSceneOrLocation(
  collection: RoleEntityCollection,
  entity: RoleEntityRecord,
  state: WorldState
): boolean {
  const sceneLocId = state.scene.locationId;
  switch (collection) {
    case 'characters': {
      const char = entity as CharacterEntity;
      if (char.presentInScene || state.scene.presentCharacterIds.includes(char.id)) {
        return true;
      }
      return sceneLocId !== null && char.locationId === sceneLocId;
    }
    case 'factions': {
      const faction = entity as FactionEntity;
      return sceneLocId !== null && faction.headquartersLocationId === sceneLocId;
    }
    case 'locations':
      return sceneLocId !== null && entity.id === sceneLocId;
  }
}

function compareIdsLexicographic(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Bind beat roles against the current {@link WorldState}.
 *
 * - Checks whether each role's default character/entity exists and is usable (`status === 'active'` for characters).
 * - If unavailable and `fallbackQuery` exists (and fallback is allowed), resolves candidates
 *   deterministically (preferring entities in the same location/scene first, then lexicographically by `id`).
 */
export function bindBeatRoles(
  roles: Readonly<Record<string, BeatRoleSpec>> | undefined,
  state: WorldState,
  options: BindBeatRolesOptions = {}
): BindBeatRolesOutcome {
  if (!roles) {
    return { ok: true, bindings: {} };
  }

  const roleKeys = Object.keys(roles)
    .filter((key) => !isUnsafePropertyKey(key))
    .sort(compareIdsLexicographic);

  if (roleKeys.length === 0) {
    return { ok: true, bindings: {} };
  }

  const allowFallback = options.allowFallback ?? true;
  const bindings: Record<string, BoundRoleResult> = {};

  for (const roleKey of roleKeys) {
    const specDesc = Object.getOwnPropertyDescriptor(roles, roleKey);
    const spec = specDesc?.value as BeatRoleSpec | undefined;
    if (!spec || typeof spec.default !== 'string' || spec.default.trim().length === 0) {
      return { ok: false, bindings: {}, missingStrictRole: roleKey };
    }

    const found = lookupDefaultEntity(state, spec.default, spec.fallbackQuery?.collection);
    if (found && isEntityUsable(found.collection, found.entity)) {
      setSafeBinding(bindings, roleKey, {
        roleKey,
        entityId: found.entity.id,
        displayName: found.entity.name,
        adapted: false,
      });
      continue;
    }

    if (!allowFallback || !spec.fallbackQuery) {
      return { ok: false, bindings: {}, missingStrictRole: roleKey };
    }

    const { collection, where } = spec.fallbackQuery;
    const collectionMap = getCollectionMap(state, collection);
    const candidates: RoleEntityRecord[] = [];

    for (const candidateId of Object.keys(collectionMap)) {
      if (isUnsafePropertyKey(candidateId)) {
        continue;
      }
      const candidate = getOwnEntity(collectionMap, candidateId);
      if (
        candidate &&
        isEntityUsable(collection, candidate) &&
        matchesWhere(candidate, where)
      ) {
        candidates.push(candidate);
      }
    }

    candidates.sort((a, b) => {
      const aLocal = isInCurrentSceneOrLocation(collection, a, state);
      const bLocal = isInCurrentSceneOrLocation(collection, b, state);
      if (aLocal && !bLocal) return -1;
      if (!aLocal && bLocal) return 1;
      return compareIdsLexicographic(a.id, b.id);
    });

    const chosen = candidates[0];
    if (!chosen) {
      return { ok: false, bindings: {}, missingStrictRole: roleKey };
    }

    setSafeBinding(bindings, roleKey, {
      roleKey,
      entityId: chosen.id,
      displayName: chosen.name,
      adapted: true,
      adaptedFrom: spec.default,
      adaptedTo: chosen.id,
    });
  }

  return { ok: true, bindings };
}

/**
 * Interpolate `{{roles.<key>.name}}` and `{{roles.<key>.id}}` placeholders in a beat template string.
 */
export function interpolateBeatTemplate(
  template: string,
  bindings: Readonly<Record<string, BoundRoleResult>>
): string {
  if (template.length === 0) {
    return template;
  }

  return template.replace(
    TEMPLATE_TOKEN_RE,
    (fullMatch, roleKey: string, field: 'name' | 'id') => {
      if (isUnsafePropertyKey(roleKey) || !Object.hasOwn(bindings, roleKey)) {
        return fullMatch;
      }
      const desc = Object.getOwnPropertyDescriptor(bindings, roleKey);
      const bound = desc?.value as BoundRoleResult | undefined;
      if (!bound) {
        return fullMatch;
      }
      return field === 'name' ? bound.displayName : bound.entityId;
    }
  );
}
