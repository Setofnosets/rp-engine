import { type ValidationError, validationError } from '../core/errors.js';
import { ErrorAccumulator, type Result, err, ok } from '../core/result.js';
import type { AuditEntry } from '../state/audit-log.js';
import type { PatchOperation } from '../state/patch.js';
import { type ReducerOptions, applyPatchBatch } from '../state/reducer.js';
import type { WorldState } from '../state/world-state.js';
import type { BeatDefinition, BeatLedgerState } from './beat-ledger.js';
import {
  type BeatStatus,
  type PredicateAst,
  isSafePathString,
  isUnsafePropertyKey,
  validatePredicateAst,
} from './predicate-ast.js';
import { evaluatePredicate } from './predicate-evaluator.js';

export interface RouteDefinition {
  id: string;
  group?: string;
  lock: string;
  priority: number;
  when: PredicateAst;
  announce?: string;
}

export interface EndingBranchOption {
  id: string;
  label: string;
  activateRoute?: string;
  routeGroup?: string;
  patch?: Record<string, unknown>;
  targetArc?: 'post-victory' | 'season';
}

export interface EndingDefinition {
  id: string;
  route?: string;
  priority?: number;
  when: PredicateAst;
  epilogue: { promptPath?: string; template?: string };
  mark: string;
  branches?: readonly EndingBranchOption[];
}

export interface EvaluateRoutesParams {
  readonly state: WorldState;
  readonly ledger: BeatLedgerState;
  readonly routes: readonly RouteDefinition[];
  readonly recentTranscriptLines?: readonly string[];
  readonly reducerOptions?: ReducerOptions;
}

export interface EvaluateRoutesResult {
  readonly nextState: WorldState;
  readonly newlyLockedRoutes: RouteDefinition[];
  readonly announcements: string[];
  readonly auditEntries: AuditEntry[];
  readonly changedPaths: Set<string>;
  readonly warnings: ValidationError[];
}

export interface FilterBeatsForActiveRoutesOptions {
  readonly requireRouteLocked?: boolean;
}

export interface EvaluateEndingsParams {
  readonly state: WorldState;
  readonly ledger: BeatLedgerState;
  readonly endings: readonly EndingDefinition[];
  readonly routes: readonly RouteDefinition[];
  readonly recentTranscriptLines?: readonly string[];
  readonly reducerOptions?: ReducerOptions;
}

export interface EvaluateEndingsResult {
  readonly nextState: WorldState;
  readonly triggeredEnding: EndingDefinition | null;
  readonly auditEntries: AuditEntry[];
  readonly changedPaths: Set<string>;
  readonly warnings: ValidationError[];
}

export interface ChooseEndingBranchParams {
  readonly state: WorldState;
  readonly ending: EndingDefinition;
  readonly branchId: string;
  readonly routes?: readonly RouteDefinition[];
  readonly reducerOptions?: ReducerOptions;
}

export interface ChooseEndingBranchResult {
  readonly nextState: WorldState;
  readonly branch: EndingBranchOption;
  readonly auditEntries: AuditEntry[];
  readonly changedPaths: Set<string>;
}

const DEFAULT_ROUTE_GROUP = 'default';
const VALID_TARGET_ARCS: ReadonlySet<string> = new Set(['post-victory', 'season']);
const WORLD_STATE_PATCH_NAMESPACES: ReadonlySet<string> = new Set([
  'flags',
  'counters',
  'customFields',
  'meta',
  'scene',
  'player',
  'clocks',
  'turnEvents',
  'relations',
  'entities',
]);

function compareStringsLexicographic(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

function getOwnFlag(flags: Readonly<Record<string, boolean>>, key: string): boolean | undefined {
  if (isUnsafePropertyKey(key) || !Object.hasOwn(flags, key)) {
    return undefined;
  }
  const desc = Object.getOwnPropertyDescriptor(flags, key);
  return typeof desc?.value === 'boolean' ? desc.value : undefined;
}

function isFlagLocked(state: WorldState, lockFlag: string): boolean {
  return getOwnFlag(state.flags, lockFlag) === true;
}

function buildStatusMap(ledger: BeatLedgerState): Map<string, BeatStatus> {
  const map = new Map<string, BeatStatus>();
  for (const id of Object.keys(ledger.records)) {
    if (isUnsafePropertyKey(id) || !Object.hasOwn(ledger.records, id)) {
      continue;
    }
    const desc = Object.getOwnPropertyDescriptor(ledger.records, id);
    const rec = desc?.value as { status?: BeatStatus } | undefined;
    if (rec && typeof rec.status === 'string') {
      map.set(id, rec.status);
    }
  }
  return map;
}

function validateSafeIdentifier(
  value: unknown,
  field: string,
  code: string,
  acc: ErrorAccumulator
): value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    acc.add(field, code, `${field} must be a non-empty string`);
    return false;
  }
  if (isUnsafePropertyKey(value) || isUnsafePropertyKey(value.trim())) {
    acc.add(field, 'UNSAFE_PROPERTY_KEY', `Forbidden prototype property key "${value}"`);
    return false;
  }
  return true;
}

function validateUnknownTreeForUnsafeKeys(value: unknown, acc: ErrorAccumulator): void {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      validateUnknownTreeForUnsafeKeys(value[i], acc.scope(`[${i}]`));
    }
    return;
  }
  if (value === null || typeof value !== 'object' || value instanceof Date) {
    return;
  }
  if (!isPlainObject(value)) {
    acc.add('', 'INVALID_PATCH_VALUE', 'Patch values must be JSON-safe plain values');
    return;
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    if (isUnsafePropertyKey(key)) {
      acc.add(key, 'UNSAFE_PROPERTY_KEY', `Forbidden prototype property key "${key}"`);
      continue;
    }
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (desc) {
      validateUnknownTreeForUnsafeKeys(desc.value, acc.scope(key));
    }
  }
}

function cloneSafeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(cloneSafeValue);
  }
  if (value instanceof Date) {
    return new Date(value.getTime());
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.getOwnPropertyNames(value)) {
      if (isUnsafePropertyKey(key)) {
        continue;
      }
      const desc = Object.getOwnPropertyDescriptor(value, key);
      if (desc !== undefined) {
        Object.defineProperty(out, key, {
          value: cloneSafeValue(desc.value),
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
    }
    return out;
  }
  return value;
}

function flattenPatchObject(
  obj: Record<string, unknown>,
  prefix: string,
  maxDepth: number,
  out: PatchOperation[],
  acc: ErrorAccumulator
): void {
  const keys = Object.getOwnPropertyNames(obj).sort(compareStringsLexicographic);
  for (const key of keys) {
    if (isUnsafePropertyKey(key)) {
      acc.add(key, 'UNSAFE_PROPERTY_KEY', `Forbidden prototype property key "${key}"`);
      continue;
    }
    if (key.trim().length === 0) {
      acc.add(key, 'INVALID_PATH_SEGMENT', 'Patch key cannot be empty');
      continue;
    }
    const desc = Object.getOwnPropertyDescriptor(obj, key);
    const val = desc?.value;
    const nextPath = `${prefix}.${key}`;
    if (!isSafePathString(nextPath)) {
      acc.add(key, 'INVALID_PATH_SEGMENT', `Unsafe or empty patch path "${nextPath}"`);
      continue;
    }
    if (
      maxDepth > 1 &&
      prefix !== 'customFields' &&
      !prefix.endsWith('.customFields') &&
      isPlainObject(val) &&
      Object.getOwnPropertyNames(val).length > 0
    ) {
      flattenPatchObject(val, nextPath, maxDepth - 1, out, acc.scope(key));
      continue;
    }
    validateUnknownTreeForUnsafeKeys(val, acc.scope(key));
    out.push({ op: 'set', path: nextPath, value: cloneSafeValue(val) });
  }
}

function compileBranchPatchOperations(
  patch: unknown,
  errorPath = 'branch.patch'
): Result<PatchOperation[], ValidationError[]> {
  const acc = new ErrorAccumulator(errorPath);
  if (!isPlainObject(patch)) {
    acc.add('', 'INVALID_TYPE', 'branch.patch must be a plain object');
    return acc.toResult([]);
  }

  const operations: PatchOperation[] = [];
  const keys = Object.getOwnPropertyNames(patch).sort(compareStringsLexicographic);

  for (const key of keys) {
    if (isUnsafePropertyKey(key)) {
      acc.add(key, 'UNSAFE_PROPERTY_KEY', `Forbidden prototype property key "${key}"`);
      continue;
    }
    if (key.trim().length === 0) {
      acc.add(key, 'INVALID_PATH_SEGMENT', 'Patch key cannot be empty');
      continue;
    }

    const desc = Object.getOwnPropertyDescriptor(patch, key);
    const val = desc?.value;

    if (key.includes('.')) {
      if (!isSafePathString(key)) {
        acc.add(key, 'INVALID_PATH_SEGMENT', `Unsafe or empty patch path "${key}"`);
        continue;
      }
      validateUnknownTreeForUnsafeKeys(val, acc.scope(key));
      operations.push({ op: 'set', path: key, value: cloneSafeValue(val) });
      continue;
    }

    if (WORLD_STATE_PATCH_NAMESPACES.has(key) && isPlainObject(val)) {
      let maxDepth = 1;
      if (key === 'player' || key === 'clocks') {
        maxDepth = 3;
      } else if (key === 'relations') {
        maxDepth = 3;
      } else if (key === 'entities') {
        maxDepth = 5;
      }
      flattenPatchObject(val, key, maxDepth, operations, acc.scope(key));
      continue;
    }

    validateUnknownTreeForUnsafeKeys(val, acc.scope(key));
    let resolvedPath: string;
    if (typeof val === 'boolean') {
      resolvedPath = `flags.${key}`;
    } else if (typeof val === 'number') {
      resolvedPath = `counters.${key}`;
    } else {
      resolvedPath = `customFields.${key}`;
    }
    operations.push({ op: 'set', path: resolvedPath, value: cloneSafeValue(val) });
  }

  if (acc.hasErrors()) {
    return err([...acc.errors]);
  }
  return ok(operations);
}

/**
 * Validate route definitions, ending definitions, and post-ending branch cross-references.
 */
export function validateRoutesAndEndings(
  routes: readonly RouteDefinition[],
  endings: readonly EndingDefinition[],
  routeDefs?: readonly RouteDefinition[]
): Result<void, ValidationError[]> {
  const acc = new ErrorAccumulator();

  if (!Array.isArray(routes)) {
    acc.add('routes', 'INVALID_TYPE', 'routes must be an array');
  }
  if (!Array.isArray(endings)) {
    acc.add('endings', 'INVALID_TYPE', 'endings must be an array');
  }
  if (routeDefs !== undefined && !Array.isArray(routeDefs)) {
    acc.add('routeDefs', 'INVALID_TYPE', 'routeDefs must be an array when provided');
  }
  if (acc.hasErrors()) {
    return err([...acc.errors]);
  }

  const seenRouteIds = new Set<string>();
  const knownRouteIds = new Set<string>();
  const routesAcc = acc.scope('routes');

  for (let i = 0; i < routes.length; i += 1) {
    const route = routes[i];
    const rAcc = routesAcc.scope(`[${i}]`);
    if (!isPlainObject(route)) {
      rAcc.add('', 'INVALID_TYPE', 'RouteDefinition must be a plain object');
      continue;
    }

    if (validateSafeIdentifier(route.id, 'id', 'REQUIRED', rAcc)) {
      if (seenRouteIds.has(route.id)) {
        rAcc.add('id', 'DUPLICATE_ID', `Duplicate route id "${route.id}"`);
      } else {
        seenRouteIds.add(route.id);
        knownRouteIds.add(route.id);
      }
    }

    if (route.group !== undefined) {
      validateSafeIdentifier(route.group, 'group', 'INVALID_ROUTE_GROUP', rAcc);
    }

    if (validateSafeIdentifier(route.lock, 'lock', 'REQUIRED', rAcc)) {
      if (!isSafePathString(route.lock) || route.lock.includes('.')) {
        rAcc.add(
          'lock',
          'INVALID_LOCK_FLAG',
          `route.lock "${route.lock}" must be a valid single-segment flag key`
        );
      }
    }

    if (typeof route.priority !== 'number' || !Number.isFinite(route.priority)) {
      rAcc.add('priority', 'INVALID_NUMBER', 'route.priority must be a finite number');
    }

    if (route.announce !== undefined && typeof route.announce !== 'string') {
      rAcc.add('announce', 'INVALID_TYPE', 'route.announce must be a string when specified');
    }

    rAcc.scope('when').absorb(validatePredicateAst(route.when));
  }

  if (routeDefs !== undefined) {
    for (const def of routeDefs) {
      if (isPlainObject(def) && typeof def.id === 'string' && def.id.trim().length > 0 && !isUnsafePropertyKey(def.id)) {
        knownRouteIds.add(def.id);
      }
    }
  }

  const seenEndingIds = new Set<string>();
  const endingsAcc = acc.scope('endings');

  for (let i = 0; i < endings.length; i += 1) {
    const ending = endings[i];
    const eAcc = endingsAcc.scope(`[${i}]`);
    if (!isPlainObject(ending)) {
      eAcc.add('', 'INVALID_TYPE', 'EndingDefinition must be a plain object');
      continue;
    }

    if (validateSafeIdentifier(ending.id, 'id', 'REQUIRED', eAcc)) {
      if (seenEndingIds.has(ending.id)) {
        eAcc.add('id', 'DUPLICATE_ID', `Duplicate ending id "${ending.id}"`);
      } else {
        seenEndingIds.add(ending.id);
      }
    }

    if (ending.route !== undefined) {
      if (validateSafeIdentifier(ending.route, 'route', 'INVALID_ROUTE_REF', eAcc)) {
        if (!knownRouteIds.has(ending.route)) {
          eAcc.add(
            'route',
            'UNKNOWN_ROUTE_REF',
            `Ending references unknown route "${ending.route}"`
          );
        }
      }
    }

    if (
      ending.priority !== undefined &&
      (typeof ending.priority !== 'number' || !Number.isFinite(ending.priority))
    ) {
      eAcc.add('priority', 'INVALID_NUMBER', 'ending.priority must be a finite number');
    }

    if (validateSafeIdentifier(ending.mark, 'mark', 'REQUIRED', eAcc)) {
      if (!isSafePathString(ending.mark) || ending.mark.includes('.')) {
        eAcc.add(
          'mark',
          'INVALID_MARK_FLAG',
          `ending.mark "${ending.mark}" must be a valid single-segment flag key`
        );
      }
    }

    if (!isPlainObject(ending.epilogue)) {
      eAcc.add('epilogue', 'INVALID_TYPE', 'ending.epilogue must be a plain object');
    } else {
      const epAcc = eAcc.scope('epilogue');
      if (
        ending.epilogue.promptPath !== undefined &&
        (typeof ending.epilogue.promptPath !== 'string' || ending.epilogue.promptPath.trim().length === 0)
      ) {
        epAcc.add('promptPath', 'REQUIRED', 'epilogue.promptPath must be a non-empty string when specified');
      }
      if (ending.epilogue.template !== undefined && typeof ending.epilogue.template !== 'string') {
        epAcc.add('template', 'INVALID_TYPE', 'epilogue.template must be a string when specified');
      }
    }

    eAcc.scope('when').absorb(validatePredicateAst(ending.when));

    if (ending.branches !== undefined) {
      if (!Array.isArray(ending.branches)) {
        eAcc.add('branches', 'INVALID_TYPE', 'ending.branches must be an array');
      } else {
        const seenBranchIds = new Set<string>();
        const branchesAcc = eAcc.scope('branches');
        for (let j = 0; j < ending.branches.length; j += 1) {
          const branch = ending.branches[j];
          const bAcc = branchesAcc.scope(`[${j}]`);
          if (!isPlainObject(branch)) {
            bAcc.add('', 'INVALID_TYPE', 'EndingBranchOption must be a plain object');
            continue;
          }

          if (validateSafeIdentifier(branch.id, 'id', 'REQUIRED', bAcc)) {
            if (seenBranchIds.has(branch.id)) {
              bAcc.add(
                'id',
                'DUPLICATE_BRANCH_ID',
                `Duplicate branch id "${branch.id}" in ending "${String(ending.id)}"`
              );
            } else {
              seenBranchIds.add(branch.id);
            }
          }

          if (typeof branch.label !== 'string' || branch.label.trim().length === 0) {
            bAcc.add('label', 'REQUIRED', 'branch.label must be a non-empty string');
          }

          if (branch.activateRoute !== undefined) {
            if (
              validateSafeIdentifier(
                branch.activateRoute,
                'activateRoute',
                'INVALID_ROUTE_REF',
                bAcc
              )
            ) {
              if (!knownRouteIds.has(branch.activateRoute)) {
                bAcc.add(
                  'activateRoute',
                  'UNKNOWN_ROUTE_REF',
                  `Branch references unknown activateRoute "${branch.activateRoute}"`
                );
              }
            }
          }

          if (branch.routeGroup !== undefined) {
            validateSafeIdentifier(branch.routeGroup, 'routeGroup', 'INVALID_ROUTE_GROUP', bAcc);
          }

          if (
            branch.targetArc !== undefined &&
            (typeof branch.targetArc !== 'string' || !VALID_TARGET_ARCS.has(branch.targetArc))
          ) {
            bAcc.add(
              'targetArc',
              'INVALID_ENUM',
              `Invalid targetArc "${String(branch.targetArc)}"; expected 'post-victory' or 'season'`
            );
          }

          if (branch.patch !== undefined) {
            const patchRes = compileBranchPatchOperations(branch.patch, '');
            if (!patchRes.ok) {
              bAcc.scope('patch').addAll(patchRes.error);
            }
          }
        }
      }
    }
  }

  return acc.toResult();
}

/**
 * Determine which route is currently locked (`state.flags[route.lock] === true`)
 * in each route group (`route.group ?? 'default'`).
 */
export function getLockedRoutesByGroup(
  state: WorldState,
  routes: readonly RouteDefinition[]
): Map<string, RouteDefinition> {
  const lockedByGroup = new Map<string, RouteDefinition>();
  for (const route of routes) {
    const group = route.group ?? DEFAULT_ROUTE_GROUP;
    if (lockedByGroup.has(group)) {
      continue;
    }
    if (isFlagLocked(state, route.lock)) {
      lockedByGroup.set(group, route);
    }
  }
  return lockedByGroup;
}

/**
 * Evaluate route lock conditions within each route group (`group ?? 'default'`).
 *
 * Enforces first-lock-wins per group: if no route in a group is locked yet,
 * candidates are evaluated in descending `priority` order (tie-break: declaration order)
 * and the first matching route locks via `{ op: 'route_lock', routeId, lockFlag }`.
 */
export function evaluateRoutes(params: EvaluateRoutesParams): EvaluateRoutesResult {
  const { state, ledger, routes, recentTranscriptLines, reducerOptions } = params;

  let currentState = state;
  const newlyLockedRoutes: RouteDefinition[] = [];
  const announcements: string[] = [];
  const auditEntries: AuditEntry[] = [];
  const changedPaths = new Set<string>();
  const warnings: ValidationError[] = [];

  const groups = new Map<string, Array<{ route: RouteDefinition; index: number }>>();
  for (let i = 0; i < routes.length; i += 1) {
    const route = routes[i];
    if (!route) {
      continue;
    }
    const groupName = route.group ?? DEFAULT_ROUTE_GROUP;
    let bucket = groups.get(groupName);
    if (!bucket) {
      bucket = [];
      groups.set(groupName, bucket);
    }
    bucket.push({ route, index: i });
  }

  const beatStatuses = buildStatusMap(ledger);
  let nextAuditSeq = reducerOptions?.auditSeqStart ?? 1;
  let batchSeq = 1;

  for (const [groupName, entries] of groups.entries()) {
    const alreadyLocked = entries.some((entry) => isFlagLocked(currentState, entry.route.lock));
    if (alreadyLocked) {
      continue;
    }

    const sorted = [...entries].sort((a, b) => {
      if (b.route.priority !== a.route.priority) {
        return b.route.priority - a.route.priority;
      }
      return a.index - b.index;
    });

    for (const { route } of sorted) {
      if (
        typeof route.id !== 'string' ||
        route.id.trim().length === 0 ||
        typeof route.lock !== 'string' ||
        route.lock.trim().length === 0 ||
        isUnsafePropertyKey(route.lock)
      ) {
        warnings.push(
          validationError(
            `routes.${String(route.id)}`,
            'INVALID_ROUTE_DEFINITION',
            `Skipping route "${String(route.id)}" with invalid id or lock flag`
          )
        );
        continue;
      }

      const matched = evaluatePredicate(route.when, {
        state: currentState,
        beatStatuses,
        recentTranscriptLines,
        warnings,
      });

      if (!matched) {
        continue;
      }

      const batchRes = applyPatchBatch(
        currentState,
        {
          eventId: `route_lock:${route.id}:t${currentState.meta.turn}:n${batchSeq}`,
          source: 'beat',
          operations: [
            {
              op: 'route_lock',
              routeId: route.id,
              lockFlag: route.lock,
            },
          ],
          reason: `Route "${route.id}" locked in group "${groupName}"`,
        },
        {
          ...reducerOptions,
          auditSeqStart: nextAuditSeq,
        }
      );
      batchSeq += 1;

      if (!batchRes.ok) {
        warnings.push(...batchRes.error);
        break;
      }

      currentState = batchRes.value.nextState;
      auditEntries.push(...batchRes.value.auditEntries);
      nextAuditSeq += batchRes.value.auditEntries.length;
      for (const path of batchRes.value.changedPaths) {
        changedPaths.add(path);
      }

      newlyLockedRoutes.push(route);
      if (route.announce !== undefined && route.announce.length > 0) {
        announcements.push(route.announce);
      }
      break;
    }
  }

  return {
    nextState: currentState,
    newlyLockedRoutes,
    announcements,
    auditEntries,
    changedPaths,
    warnings,
  };
}

/**
 * Filter beat definitions to those active under currently locked routes.
 *
 * - Beats without `route` are always included.
 * - When `requireRouteLocked` is `true` (default), beats declaring `route` are included
 *   only when that route exists and its `lock` flag is `true`.
 * - When `requireRouteLocked` is `false`, beats declaring `route` are included when
 *   that route is locked OR no competing route in its group is locked.
 */
export function filterBeatsForActiveRoutes(
  beats: readonly BeatDefinition[],
  state: WorldState,
  routes: readonly RouteDefinition[],
  options: FilterBeatsForActiveRoutesOptions = {}
): BeatDefinition[] {
  const requireRouteLocked = options.requireRouteLocked ?? true;
  const routeById = new Map<string, RouteDefinition>();
  for (const route of routes) {
    if (typeof route.id === 'string' && !routeById.has(route.id)) {
      routeById.set(route.id, route);
    }
  }
  const lockedByGroup = getLockedRoutesByGroup(state, routes);

  const filtered: BeatDefinition[] = [];
  for (const beat of beats) {
    if (beat.route === undefined) {
      filtered.push(beat);
      continue;
    }

    const route = routeById.get(beat.route);
    if (!route) {
      continue;
    }

    if (requireRouteLocked) {
      if (isFlagLocked(state, route.lock)) {
        filtered.push(beat);
      }
      continue;
    }

    const group = route.group ?? DEFAULT_ROUTE_GROUP;
    const lockedInGroup = lockedByGroup.get(group);
    if (!lockedInGroup || lockedInGroup.id === route.id) {
      filtered.push(beat);
    }
  }

  return filtered;
}

/**
 * Evaluate ending definitions when `state.capabilities.beats` is enabled and
 * `state.meta.endingStatus === 'none'`.
 *
 * Endings are checked in descending `priority ?? 0` order (tie-break: declaration order).
 * The first ending whose optional `route` is locked and `when` predicate holds triggers
 * atomically, setting `meta.endingStatus = 'epilogue'`, `meta.activeEndingId = ending.id`,
 * and `flags[ending.mark] = true`.
 */
export function evaluateEndings(params: EvaluateEndingsParams): EvaluateEndingsResult {
  const { state, ledger, endings, routes, recentTranscriptLines, reducerOptions } = params;

  if (!state.capabilities.beats || state.meta.endingStatus !== 'none') {
    return {
      nextState: state,
      triggeredEnding: null,
      auditEntries: [],
      changedPaths: new Set<string>(),
      warnings: [],
    };
  }

  const warnings: ValidationError[] = [];
  const beatStatuses = buildStatusMap(ledger);
  const routeById = new Map<string, RouteDefinition>();
  for (const route of routes) {
    if (typeof route.id === 'string' && !routeById.has(route.id)) {
      routeById.set(route.id, route);
    }
  }

  const orderedEndings = endings
    .map((ending, index) => ({
      ending,
      index,
      priority: ending.priority ?? 0,
    }))
    .sort((a, b) => {
      if (b.priority !== a.priority) {
        return b.priority - a.priority;
      }
      return a.index - b.index;
    });

  for (const { ending } of orderedEndings) {
    if (ending.route !== undefined) {
      const requiredRoute = routeById.get(ending.route);
      if (!requiredRoute || !isFlagLocked(state, requiredRoute.lock)) {
        continue;
      }
    }

    const matched = evaluatePredicate(ending.when, {
      state,
      beatStatuses,
      recentTranscriptLines,
      warnings,
    });
    if (!matched) {
      continue;
    }

    if (
      typeof ending.mark !== 'string' ||
      ending.mark.trim().length === 0 ||
      isUnsafePropertyKey(ending.mark) ||
      ending.mark.includes('.')
    ) {
      warnings.push(
        validationError(
          `endings.${ending.id}.mark`,
          'INVALID_MARK_FLAG',
          `Ending "${ending.id}" has invalid mark flag "${String(ending.mark)}"`
        )
      );
      continue;
    }

    const batchRes = applyPatchBatch(
      state,
      {
        eventId: `ending:${ending.id}:t${state.meta.turn}`,
        source: 'engine',
        operations: [
          { op: 'set', path: 'meta.endingStatus', value: 'epilogue' },
          { op: 'set', path: 'meta.activeEndingId', value: ending.id },
          { op: 'set', path: `flags.${ending.mark}`, value: true },
        ],
        reason: `Ending "${ending.id}" triggered`,
      },
      reducerOptions
    );

    if (!batchRes.ok) {
      warnings.push(...batchRes.error);
      continue;
    }

    return {
      nextState: batchRes.value.nextState,
      triggeredEnding: ending,
      auditEntries: batchRes.value.auditEntries,
      changedPaths: batchRes.value.changedPaths,
      warnings,
    };
  }

  return {
    nextState: state,
    triggeredEnding: null,
    auditEntries: [],
    changedPaths: new Set<string>(),
    warnings,
  };
}

/**
 * Commit a post-ending branch choice (`ending.branches`) atomically:
 * - Applies optional `branch.patch`.
 * - Sets `meta.arc = branch.targetArc ?? 'post-victory'` and `meta.endingStatus = 'continued'`.
 * - When `branch.activateRoute` is set, clears competing locks in `branch.routeGroup ?? 'default'`
 *   and locks the chosen post-ending route (`flags[route.lock] = true`).
 */
export function chooseEndingBranch(
  params: ChooseEndingBranchParams
): Result<ChooseEndingBranchResult, ValidationError[]> {
  const { state, ending, branchId, routes, reducerOptions } = params;

  const branch = ending.branches?.find((option) => option.id === branchId);
  if (!branch) {
    return err([
      validationError(
        'branchId',
        'UNKNOWN_BRANCH',
        `Ending "${ending.id}" does not define branch "${branchId}"`
      ),
    ]);
  }

  const operations: PatchOperation[] = [];
  let targetRoute: RouteDefinition | undefined;

  if (branch.activateRoute !== undefined) {
    targetRoute = routes?.find((route) => route.id === branch.activateRoute);
    if (!targetRoute) {
      return err([
        validationError(
          'branch.activateRoute',
          'UNKNOWN_ROUTE_REF',
          `Branch "${branch.id}" references unknown route "${branch.activateRoute}"`
        ),
      ]);
    }
    if (isUnsafePropertyKey(targetRoute.lock) || !isSafePathString(targetRoute.lock) || targetRoute.lock.includes('.')) {
      return err([
        validationError(
          'route.lock',
          'INVALID_LOCK_FLAG',
          `Route "${targetRoute.id}" has invalid lock flag "${targetRoute.lock}"`
        ),
      ]);
    }

    const groupToClear = branch.routeGroup ?? DEFAULT_ROUTE_GROUP;
    for (const candidate of routes ?? []) {
      const candidateGroup = candidate.group ?? DEFAULT_ROUTE_GROUP;
      if (
        candidateGroup === groupToClear &&
        candidate.id !== targetRoute.id &&
        candidate.lock !== targetRoute.lock &&
        isFlagLocked(state, candidate.lock)
      ) {
        operations.push({
          op: 'set',
          path: `flags.${candidate.lock}`,
          value: false,
        });
      }
    }
  }

  if (branch.patch !== undefined) {
    const patchOpsRes = compileBranchPatchOperations(branch.patch);
    if (!patchOpsRes.ok) {
      return patchOpsRes;
    }
    operations.push(...patchOpsRes.value);
  }

  const targetArc = branch.targetArc ?? 'post-victory';
  operations.push(
    { op: 'set', path: 'meta.arc', value: targetArc },
    { op: 'set', path: 'meta.endingStatus', value: 'continued' }
  );

  if (targetRoute !== undefined) {
    operations.push({
      op: 'route_lock',
      routeId: targetRoute.id,
      lockFlag: targetRoute.lock,
    });
  }

  const batchRes = applyPatchBatch(
    state,
    {
      eventId: `ending_branch:${ending.id}:${branch.id}:t${state.meta.turn}`,
      source: 'engine',
      operations,
      reason: `Ending "${ending.id}" branch "${branch.id}" selected`,
    },
    reducerOptions
  );

  if (!batchRes.ok) {
    return batchRes;
  }

  return ok({
    nextState: batchRes.value.nextState,
    branch,
    auditEntries: batchRes.value.auditEntries,
    changedPaths: batchRes.value.changedPaths,
  });
}
