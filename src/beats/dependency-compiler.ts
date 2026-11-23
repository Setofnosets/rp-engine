import { type EntityCollection, type PredicateAst, isUnsafePropertyKey } from './predicate-ast.js';

export interface DependencyEntry {
  readonly id: string;
  readonly predicates: readonly PredicateAst[];
}

export interface DependencyIndex {
  readonly exact: ReadonlyMap<string, ReadonlySet<string>>;
  readonly byParentPrefix: ReadonlyMap<string, ReadonlySet<string>>;
  readonly entryCount: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

function canonicalizeClockKey(clockKey: string): string {
  switch (clockKey) {
    case 'day':
      return 'clocks.day';
    case 'turn':
      return 'clocks.turn';
    case 'story_turn':
    case 'storyTurn':
      return 'clocks.storyTurn';
    default:
      return `clocks.timers.${clockKey}`;
  }
}

function collectWhereFieldPaths(
  where: Record<string, unknown>,
  prefix: string,
  out: string[]
): void {
  const keys = Object.keys(where);
  for (const key of keys) {
    if (isUnsafePropertyKey(key)) {
      continue;
    }
    const nextPath = prefix.length > 0 ? `${prefix}.${key}` : key;
    const descriptor = Object.getOwnPropertyDescriptor(where, key);
    const val = descriptor ? descriptor.value : undefined;
    if (isPlainObject(val) && !Object.hasOwn(val, 'op') && Object.keys(val).length > 0) {
      collectWhereFieldPaths(val, nextPath, out);
    } else {
      out.push(nextPath);
    }
  }
}

function addWhereDependencies(
  collection: EntityCollection,
  where: Record<string, unknown>,
  deps: Set<string>
): void {
  const fieldPaths: string[] = [];
  collectWhereFieldPaths(where, '', fieldPaths);
  if (fieldPaths.length === 0) {
    deps.add(`entities.${collection}.*`);
    return;
  }
  for (const fieldPath of fieldPaths) {
    deps.add(`entities.${collection}.*.${fieldPath}`);
  }
}

function collectDependenciesInto(ast: PredicateAst, deps: Set<string>): void {
  if ('flag' in ast) {
    deps.add(`flags.${ast.flag}`);
    return;
  }

  if ('counter' in ast) {
    deps.add(`counters.${ast.counter}`);
    return;
  }

  if ('custom_field' in ast) {
    if (ast.target === undefined || ast.target === 'global') {
      deps.add(`customFields.${ast.custom_field}`);
    } else if (ast.target === 'player') {
      deps.add(`player.customFields.${ast.custom_field}`);
    } else {
      deps.add(`entities.characters.${ast.target}.customFields.${ast.custom_field}`);
    }
    return;
  }

  if ('clock' in ast) {
    deps.add(canonicalizeClockKey(ast.clock));
    return;
  }

  if ('slot' in ast) {
    deps.add('clocks.slot');
    return;
  }

  if ('at' in ast) {
    deps.add('scene.location');
    deps.add('scene.locationId');
    return;
  }

  if ('relation' in ast) {
    deps.add(`relations.${ast.relation[0]}.${ast.relation[1]}`);
    return;
  }

  if ('entity' in ast) {
    deps.add(`entities.${ast.entity[0]}.${ast.entity[1]}.${ast.entity[2]}`);
    return;
  }

  if ('any_entity' in ast) {
    addWhereDependencies(ast.any_entity, ast.where, deps);
    return;
  }

  if ('count_entities' in ast) {
    addWhereDependencies(ast.count_entities, ast.where, deps);
    return;
  }

  if ('beat' in ast) {
    deps.add(`beats.${ast.beat}.status`);
    return;
  }

  if ('form_active' in ast) {
    deps.add(`entities.characters.${ast.form_active.character}.formId`);
    return;
  }

  if ('character' in ast && 'form' in ast) {
    deps.add(`entities.characters.${ast.character}.formId`);
    return;
  }

  if ('mentions' in ast) {
    deps.add('transcript.mentions');
    return;
  }

  if ('all' in ast) {
    for (const child of ast.all) {
      collectDependenciesInto(child, deps);
    }
    return;
  }

  if ('any' in ast) {
    for (const child of ast.any) {
      collectDependenciesInto(child, deps);
    }
    return;
  }

  if ('not' in ast) {
    collectDependenciesInto(ast.not, deps);
  }
}

/**
 * Compile a {@link PredicateAst} into a deduplicated set of canonical WorldState/beat/transcript
 * dependency path patterns for dirty-flag indexing.
 */
export function compilePredicateDependencies(ast: PredicateAst): Set<string> {
  const deps = new Set<string>();
  collectDependenciesInto(ast, deps);
  return deps;
}

function addToIndexBucket(
  map: Map<string, Set<string>>,
  key: string,
  entryId: string
): void {
  let bucket = map.get(key);
  if (!bucket) {
    bucket = new Set<string>();
    map.set(key, bucket);
  }
  bucket.add(entryId);
}

/**
 * Build an inverted dependency index mapping canonical path patterns and their parent prefixes
 * to entry IDs for sub-millisecond dirty-ID lookup.
 */
export function buildDependencyIndex(
  entries: ReadonlyArray<DependencyEntry>
): DependencyIndex {
  const exact = new Map<string, Set<string>>();
  const byParentPrefix = new Map<string, Set<string>>();

  for (const entry of entries) {
    for (const predicate of entry.predicates) {
      const deps = compilePredicateDependencies(predicate);
      for (const dep of deps) {
        addToIndexBucket(exact, dep, entry.id);

        // Index every strict dot-prefix so whole-object/entity mutations find child deps in O(1).
        let dotIdx = dep.indexOf('.');
        while (dotIdx !== -1) {
          const prefix = dep.slice(0, dotIdx);
          if (prefix.length > 0) {
            addToIndexBucket(byParentPrefix, prefix, entry.id);
          }
          dotIdx = dep.indexOf('.', dotIdx + 1);
        }
      }
    }
  }

  return {
    exact,
    byParentPrefix,
    entryCount: entries.length,
  };
}

function addBucketIds(
  bucket: ReadonlySet<string> | undefined,
  dirtyIds: Set<string>
): void {
  if (!bucket) {
    return;
  }
  for (const id of bucket) {
    dirtyIds.add(id);
  }
}

function matchPathAgainstIndex(
  index: DependencyIndex,
  path: string,
  dirtyIds: Set<string>
): void {
  // 1. Exact dependency match
  addBucketIds(index.exact.get(path), dirtyIds);

  // 2. Changed parent -> dependent child paths
  addBucketIds(index.byParentPrefix.get(path), dirtyIds);

  // 3. Changed child -> dependent parent paths (walk strict ancestor prefixes in `exact`)
  let dotIdx = path.lastIndexOf('.');
  while (dotIdx > 0) {
    const ancestor = path.slice(0, dotIdx);
    addBucketIds(index.exact.get(ancestor), dirtyIds);
    dotIdx = path.lastIndexOf('.', dotIdx - 1);
  }
}

/**
 * Find all indexed entry IDs whose predicate dependencies are affected by `changedPaths`.
 * Supports exact path matches, ancestor/descendant path invalidation, and `entities.<coll>.*.<field>` wildcards.
 */
export function findDirtyIds(
  index: DependencyIndex,
  changedPaths: ReadonlySet<string>
): Set<string> {
  const dirtyIds = new Set<string>();

  for (const rawPath of changedPaths) {
    if (rawPath.length === 0) {
      continue;
    }

    const normalizedPath = rawPath === 'clocks.story_turn' ? 'clocks.storyTurn' : rawPath;
    matchPathAgainstIndex(index, normalizedPath, dirtyIds);

    // Support wildcard `entities.<coll>.*.<field>` matching for any concrete `entities.<coll>.<id>...` path
    if (normalizedPath.startsWith('entities.')) {
      const firstDot = 8; // 'entities'.length
      const secondDot = normalizedPath.indexOf('.', firstDot + 1);
      if (secondDot > firstDot + 1) {
        const thirdDot = normalizedPath.indexOf('.', secondDot + 1);
        const collPrefix = normalizedPath.slice(0, secondDot); // 'entities.<coll>'
        const idSegment =
          thirdDot === -1
            ? normalizedPath.slice(secondDot + 1)
            : normalizedPath.slice(secondDot + 1, thirdDot);

        if (idSegment.length > 0 && idSegment !== '*') {
          const wildcardPath =
            thirdDot === -1
              ? `${collPrefix}.*`
              : `${collPrefix}.*${normalizedPath.slice(thirdDot)}`;
          matchPathAgainstIndex(index, wildcardPath, dirtyIds);
        }
      }
    }
  }

  return dirtyIds;
}
