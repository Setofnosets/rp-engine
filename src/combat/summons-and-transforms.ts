import { nextInt, type RngState } from '../core/prng.js';
import type { PatchOperation } from '../state/patch.js';
import type { CombatantState, CombatState } from './action-validator.js';
import type { GridCoord, TacticalGrid } from './grid-types.js';
import type { PassiveDefinition } from './passives-and-willpower.js';
import { getTileAt } from './spatial-math.js';
import type { ActiveStatusEffect } from './status-effects.js';

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * 8-directional BFS neighbor offsets: orthogonal directions first, then diagonals,
 * in a fixed deterministic order.
 */
const BFS_DIRECTIONS: ReadonlyArray<GridCoord> = Object.freeze([
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
  { x: 1, y: -1 },
  { x: 1, y: 1 },
  { x: -1, y: 1 },
  { x: -1, y: -1 },
]);

/**
 * Definition for a combat-time summonable unit.
 */
export interface SummonTemplate {
  id: string;
  name: string;
  maxHp: number;
  ac: number;
  speed: number;
  stats: Record<string, number>;
  abilities: string[];
  passives?: PassiveDefinition[];
  durationTurns: number | null;
  maxActivePerCaster: number;
  capPolicy?: 'evict_oldest' | 'reject';
  despawnOnSummonerDefeat: boolean;
  initiativePolicy: 'after_summoner' | 'roll';
}

/**
 * Definition for a multi-stage combat transformation loadout.
 */
export interface CombatFormLoadout {
  id: string;
  displayName: string;
  statOverrides?: Record<string, number>;
  statBonuses?: Record<string, number>;
  acOverride?: number;
  speedOverride?: number;
  tempHpPool?: number;
  abilities: string[];
  replaceAbilities: boolean;
  passives?: PassiveDefinition[];
  durationTurns: number | null;
  revertOnZeroTempHp?: boolean;
  persistFormIdToWorld?: string;
}

export interface PreTransformSnapshot {
  ac: number;
  speed: number;
  stats: Record<string, number>;
  abilities: string[];
  passives: PassiveDefinition[];
}

export interface SpawnCombatSummonResult {
  nextCombatState: CombatState;
  spawnedId: string | null;
  evictedIds: string[];
  nextRng: RngState;
  reason?: string;
}

export interface DespawnSummonsResult {
  nextCombatState: CombatState;
  despawnedIds: string[];
}

export interface PurgeSummonsResult {
  nextCombatState: CombatState;
  purgedIds: string[];
}

export interface ApplyCombatTransformationResult {
  nextCombatState: CombatState;
  applied: boolean;
  worldPatches: PatchOperation[];
}

export interface RevertCombatTransformationResult {
  nextCombatState: CombatState;
  reverted: boolean;
}

export interface TickTransformationsResult {
  nextCombatState: CombatState;
  revertedIds: string[];
}

export interface ApplyTransformTempHpDamageResult {
  nextCombatState: CombatState;
  absorbedDamage: number;
  remainingDamage: number;
  reverted: boolean;
}

export interface RevertAllTransformsResult {
  nextCombatState: CombatState;
  revertedIds: string[];
}

function normalizeNumber(value: number): number {
  return value === 0 ? 0 : value;
}

function isSafeKey(key: string): boolean {
  return key.length > 0 && !FORBIDDEN_KEYS.has(key);
}

function setOwnProperty<T>(target: Record<string, T>, key: string, value: T): void {
  if (!isSafeKey(key)) {
    return;
  }
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

function getOwnProperty<T>(record: Record<string, T>, key: string): T | undefined {
  if (!isSafeKey(key) || !Object.hasOwn(record, key)) {
    return undefined;
  }
  const desc = Object.getOwnPropertyDescriptor(record, key);
  return desc?.value as T | undefined;
}

function getOwnNumber(record: Record<string, number>, key: string): number | undefined {
  const val = getOwnProperty(record, key);
  return typeof val === 'number' && Number.isFinite(val) ? normalizeNumber(val) : undefined;
}

function cloneNumberRecord(record: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of Object.keys(record)) {
    if (isSafeKey(key) && Object.hasOwn(record, key)) {
      const val = getOwnNumber(record, key);
      if (val !== undefined) {
        setOwnProperty(out, key, val);
      }
    }
  }
  return out;
}

function cloneStatus(status: ActiveStatusEffect): ActiveStatusEffect {
  return {
    ...status,
    ...(status.statModifiers !== undefined
      ? { statModifiers: cloneNumberRecord(status.statModifiers) }
      : {}),
  };
}

function clonePassive(passive: PassiveDefinition): PassiveDefinition {
  return {
    ...passive,
    ...(passive.condition !== undefined ? { condition: { ...passive.condition } } : {}),
    effect: { ...passive.effect },
  };
}

function cloneUnknownRecord(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    if (isSafeKey(key) && Object.hasOwn(record, key)) {
      const val = Object.getOwnPropertyDescriptor(record, key)?.value;
      if (Array.isArray(val)) {
        setOwnProperty(out, key, val.map((item) => (typeof item === 'object' && item !== null ? { ...(item as Record<string, unknown>) } : item)));
      } else if (typeof val === 'object' && val !== null) {
        setOwnProperty(out, key, cloneUnknownRecord(val as Record<string, unknown>));
      } else if (typeof val === 'number') {
        setOwnProperty(out, key, normalizeNumber(val));
      } else {
        setOwnProperty(out, key, val);
      }
    }
  }
  return out;
}

function cloneCombatant(c: CombatantState): CombatantState {
  const cloned: CombatantState = {
    id: c.id,
    name: c.name,
    team: c.team,
    coord: { x: normalizeNumber(c.coord.x), y: normalizeNumber(c.coord.y) },
    alive: c.alive,
    hp: normalizeNumber(c.hp),
    maxHp: normalizeNumber(c.maxHp),
    ac: normalizeNumber(c.ac),
    speed: normalizeNumber(c.speed),
    remainingMovement: normalizeNumber(c.remainingMovement),
    remainingActions: {
      action: normalizeNumber(c.remainingActions.action),
      bonus: normalizeNumber(c.remainingActions.bonus),
      reaction: normalizeNumber(c.remainingActions.reaction),
    },
    resources: cloneNumberRecord(c.resources),
    cooldowns: cloneNumberRecord(c.cooldowns),
    stats: cloneNumberRecord(c.stats),
    statuses: c.statuses.map(cloneStatus),
    abilities: [...c.abilities],
    passives: c.passives.map(clonePassive),
    willpower: normalizeNumber(c.willpower),
    maxWillpower: normalizeNumber(c.maxWillpower),
  };

  if (c.formationRow !== undefined) {
    cloned.formationRow = c.formationRow;
  }
  if (c.willpowerOutcome !== undefined) {
    cloned.willpowerOutcome = c.willpowerOutcome;
  }
  if (c.isSummon !== undefined) {
    cloned.isSummon = c.isSummon;
  }
  if (c.summonerId !== undefined) {
    cloned.summonerId = c.summonerId;
  }
  if (c.summonRemainingTurns !== undefined) {
    cloned.summonRemainingTurns = normalizeNumber(c.summonRemainingTurns);
  }
  if (c.activeTransform !== undefined) {
    cloned.activeTransform = {
      loadoutId: c.activeTransform.loadoutId,
      remainingTurns:
        c.activeTransform.remainingTurns === null
          ? null
          : normalizeNumber(c.activeTransform.remainingTurns),
      tempHp: normalizeNumber(c.activeTransform.tempHp),
      revertOnZeroTempHp: c.activeTransform.revertOnZeroTempHp,
      preTransformSnapshot: cloneUnknownRecord(c.activeTransform.preTransformSnapshot),
    };
  }

  return cloned;
}

function cloneGrid(grid: TacticalGrid | null): TacticalGrid | null {
  if (grid === null) {
    return null;
  }
  return {
    width: grid.width,
    height: grid.height,
    theme: grid.theme,
    tiles: grid.tiles.map((t) => ({ ...t })),
  };
}

function cloneTriggerCountsMap(
  map: Record<string, Record<string, number>>
): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const actorKey of Object.keys(map)) {
    if (isSafeKey(actorKey) && Object.hasOwn(map, actorKey)) {
      const inner = Object.getOwnPropertyDescriptor(map, actorKey)?.value as
        | Record<string, number>
        | undefined;
      if (inner !== undefined && typeof inner === 'object' && inner !== null) {
        setOwnProperty(out, actorKey, cloneNumberRecord(inner));
      }
    }
  }
  return out;
}

function getSafeCombatantIds(state: CombatState): string[] {
  return Object.keys(state.combatants).filter(
    (id) => isSafeKey(id) && Object.hasOwn(state.combatants, id)
  );
}

function getSafeCombatant(state: CombatState, id: string): CombatantState | undefined {
  return getOwnProperty(state.combatants, id);
}

function cloneCombatState(state: CombatState): CombatState {
  const combatants: Record<string, CombatantState> = {};
  for (const id of getSafeCombatantIds(state)) {
    const c = getSafeCombatant(state, id);
    if (c !== undefined) {
      setOwnProperty(combatants, id, cloneCombatant(c));
    }
  }

  return {
    active: state.active,
    mode: state.mode,
    ...(state.turnStyle !== undefined ? { turnStyle: state.turnStyle } : {}),
    round: normalizeNumber(state.round),
    turnIndex: normalizeNumber(state.turnIndex),
    initiativeOrder: [...state.initiativeOrder],
    grid: cloneGrid(state.grid),
    combatants,
    triggerCountsThisTurn: cloneTriggerCountsMap(state.triggerCountsThisTurn),
    ...(state.encounterActionPending !== undefined
      ? { encounterActionPending: state.encounterActionPending }
      : {}),
  };
}

function removeCombatantFromState(state: CombatState, combatantId: string): void {
  if (!isSafeKey(combatantId)) {
    return;
  }
  delete state.combatants[combatantId];

  const removedIndices: number[] = [];
  for (let i = 0; i < state.initiativeOrder.length; i += 1) {
    if (state.initiativeOrder[i] === combatantId) {
      removedIndices.push(i);
    }
  }

  if (removedIndices.length > 0) {
    let shift = 0;
    for (const idx of removedIndices) {
      if (idx < state.turnIndex) {
        shift += 1;
      }
    }
    state.initiativeOrder = state.initiativeOrder.filter((id) => id !== combatantId);
    const nextLen = state.initiativeOrder.length;
    if (nextLen === 0) {
      state.turnIndex = 0;
    } else {
      state.turnIndex = Math.max(0, Math.min(state.turnIndex - shift, nextLen - 1));
    }
  }
}

function parseSummonSequence(id: string): number | null {
  const lastColon = id.lastIndexOf(':');
  if (lastColon === -1 || lastColon === id.length - 1) {
    return null;
  }
  const suffix = Number(id.slice(lastColon + 1));
  return Number.isInteger(suffix) && suffix > 0 ? suffix : null;
}

function nextSummonId(state: CombatState, summonerId: string, templateId: string): string {
  const prefix = `summon:${summonerId}:${templateId}:`;
  let maxSeq = 0;
  for (const id of getSafeCombatantIds(state)) {
    if (id.startsWith(prefix)) {
      const seq = parseSummonSequence(id);
      if (seq !== null && seq > maxSeq) {
        maxSeq = seq;
      }
    }
  }
  return `${prefix}${maxSeq + 1}`;
}

function getActiveSummonsForCaster(state: CombatState, summonerId: string): CombatantState[] {
  const summons: CombatantState[] = [];
  for (const id of getSafeCombatantIds(state)) {
    const c = getSafeCombatant(state, id);
    if (c !== undefined && c.isSummon === true && c.summonerId === summonerId && c.alive) {
      summons.push(c);
    }
  }
  // Sort by creation sequence if available so eviction order is strictly deterministic.
  summons.sort((a, b) => {
    const seqA = parseSummonSequence(a.id);
    const seqB = parseSummonSequence(b.id);
    if (seqA !== null && seqB !== null && seqA !== seqB) {
      return seqA - seqB;
    }
    return 0;
  });
  return summons;
}

function buildOccupiedCoordKeys(state: CombatState): Set<string> {
  const occupied = new Set<string>();
  for (const id of getSafeCombatantIds(state)) {
    const c = getSafeCombatant(state, id);
    if (c !== undefined && c.alive) {
      occupied.add(`${normalizeNumber(c.coord.x)},${normalizeNumber(c.coord.y)}`);
    }
  }
  return occupied;
}

/**
 * Find the nearest unoccupied passable tile on `grid` around `center` using deterministic BFS.
 */
function findNearestUnoccupiedPassableTile(
  grid: TacticalGrid,
  center: GridCoord,
  occupiedKeys: ReadonlySet<string>
): GridCoord | null {
  if (grid.width <= 0 || grid.height <= 0) {
    return null;
  }

  const startX = Math.max(0, Math.min(grid.width - 1, Math.trunc(normalizeNumber(center.x))));
  const startY = Math.max(0, Math.min(grid.height - 1, Math.trunc(normalizeNumber(center.y))));

  const queue: GridCoord[] = [{ x: startX, y: startY }];
  const visited = new Set<string>([`${startX},${startY}`]);
  let head = 0;

  while (head < queue.length) {
    const current = queue[head] as GridCoord;
    head += 1;

    const tile = getTileAt(grid, current);
    const coordKey = `${current.x},${current.y}`;
    if (tile !== null && tile.passable && !occupiedKeys.has(coordKey)) {
      return { x: normalizeNumber(current.x), y: normalizeNumber(current.y) };
    }

    for (const dir of BFS_DIRECTIONS) {
      const nx = current.x + dir.x;
      const ny = current.y + dir.y;
      if (nx < 0 || nx >= grid.width || ny < 0 || ny >= grid.height) {
        continue;
      }
      const nextKey = `${nx},${ny}`;
      if (!visited.has(nextKey)) {
        visited.add(nextKey);
        queue.push({ x: nx, y: ny });
      }
    }
  }

  return null;
}

/**
 * Spawn a combat summon for `summonerId` using `template`.
 *
 * - In `tactical_grid` mode, locates the nearest unoccupied passable tile around
 *   `preferredCoord ?? summoner.coord` via deterministic 8-way BFS.
 * - Enforces `maxActivePerCaster` (`evict_oldest` default or `reject`).
 * - Inserts the summon into `initiativeOrder` per `initiativePolicy`.
 */
export function spawnCombatSummon(
  combatState: CombatState,
  summonerId: string,
  template: SummonTemplate,
  preferredCoord: GridCoord | null | undefined,
  rng: RngState
): SpawnCombatSummonResult {
  const workingState = cloneCombatState(combatState);
  const summoner = getSafeCombatant(workingState, summonerId);

  if (summoner === undefined || !summoner.alive) {
    return {
      nextCombatState: workingState,
      spawnedId: null,
      evictedIds: [],
      nextRng: rng,
      reason: 'Summoner is missing or defeated.',
    };
  }

  if (template.maxActivePerCaster <= 0) {
    return {
      nextCombatState: workingState,
      spawnedId: null,
      evictedIds: [],
      nextRng: rng,
      reason: 'maxActivePerCaster is 0.',
    };
  }

  const activeSummons = getActiveSummonsForCaster(workingState, summonerId);
  const capPolicy = template.capPolicy ?? 'evict_oldest';
  const evictedIds: string[] = [];

  if (activeSummons.length >= template.maxActivePerCaster) {
    if (capPolicy === 'reject') {
      return {
        nextCombatState: workingState,
        spawnedId: null,
        evictedIds: [],
        nextRng: rng,
        reason: `Summon cap (${template.maxActivePerCaster}) reached for ${summonerId}.`,
      };
    }

    const toEvictCount = activeSummons.length - template.maxActivePerCaster + 1;
    for (let i = 0; i < toEvictCount; i += 1) {
      const oldest = activeSummons[i];
      if (oldest !== undefined) {
        removeCombatantFromState(workingState, oldest.id);
        evictedIds.push(oldest.id);
      }
    }
  }

  let spawnCoord: GridCoord;
  if (workingState.mode === 'tactical_grid' && workingState.grid !== null) {
    const center = preferredCoord ?? summoner.coord;
    const occupiedKeys = buildOccupiedCoordKeys(workingState);
    const resolved = findNearestUnoccupiedPassableTile(workingState.grid, center, occupiedKeys);
    if (resolved === null) {
      // Return untouched state if no tile is available even after eviction check.
      return {
        nextCombatState: cloneCombatState(combatState),
        spawnedId: null,
        evictedIds: [],
        nextRng: rng,
        reason: 'No unoccupied passable tile available for summon.',
      };
    }
    spawnCoord = resolved;
  } else {
    spawnCoord = {
      x: normalizeNumber(preferredCoord?.x ?? summoner.coord.x),
      y: normalizeNumber(preferredCoord?.y ?? summoner.coord.y),
    };
  }

  const spawnedId = nextSummonId(workingState, summonerId, template.id);
  const clampedMaxHp = normalizeNumber(Math.max(1, template.maxHp));
  const normalizedSpeed = normalizeNumber(Math.max(0, template.speed));

  const summonCombatant: CombatantState = {
    id: spawnedId,
    name: template.name,
    team: summoner.team,
    coord: spawnCoord,
    alive: true,
    hp: clampedMaxHp,
    maxHp: clampedMaxHp,
    ac: normalizeNumber(template.ac),
    speed: normalizedSpeed,
    remainingMovement: normalizedSpeed,
    remainingActions: {
      action: 1,
      bonus: 1,
      reaction: 1,
    },
    resources: {},
    cooldowns: {},
    stats: cloneNumberRecord(template.stats),
    statuses: [],
    abilities: [...template.abilities],
    passives: (template.passives ?? []).map(clonePassive),
    willpower: 0,
    maxWillpower: 0,
    isSummon: true,
    summonerId,
    ...(summoner.formationRow !== undefined ? { formationRow: summoner.formationRow } : {}),
    ...(template.durationTurns !== null
      ? { summonRemainingTurns: normalizeNumber(Math.max(0, template.durationTurns)) }
      : {}),
  };

  setOwnProperty(workingState.combatants, spawnedId, summonCombatant);

  let nextRng = rng;
  let insertIdx = workingState.initiativeOrder.length;

  if (template.initiativePolicy === 'after_summoner') {
    const summonerIdx = workingState.initiativeOrder.indexOf(summonerId);
    if (summonerIdx !== -1) {
      insertIdx = summonerIdx + 1;
    }
  } else {
    const rollStep = nextInt(rng, 1, 20);
    nextRng = rollStep.nextState;
    const summonDex = getOwnNumber(summonCombatant.stats, 'dex') ?? 0;
    const summonInitTotal = rollStep.value + summonDex;

    for (let i = 0; i < workingState.initiativeOrder.length; i += 1) {
      const existingId = workingState.initiativeOrder[i] as string;
      const existing = getSafeCombatant(workingState, existingId);
      const existingBonus =
        existing !== undefined
          ? getOwnNumber(existing.stats, 'initiative') ?? getOwnNumber(existing.stats, 'dex') ?? 0
          : 0;
      const existingBaseline = 10 + existingBonus;
      if (summonInitTotal > existingBaseline) {
        insertIdx = i;
        break;
      }
      if (summonInitTotal === existingBaseline && summonDex > existingBonus) {
        insertIdx = i;
        break;
      }
    }
  }

  workingState.initiativeOrder.splice(insertIdx, 0, spawnedId);
  if (insertIdx <= workingState.turnIndex && workingState.initiativeOrder.length > 1) {
    workingState.turnIndex += 1;
  }

  return {
    nextCombatState: workingState,
    spawnedId,
    evictedIds,
    nextRng,
  };
}

/**
 * Tick summon duration for `actorId` and despawn expired or defeated summons.
 */
export function tickAndCleanupSummons(
  combatState: CombatState,
  actorId: string
): DespawnSummonsResult {
  const workingState = cloneCombatState(combatState);
  const despawnedIds: string[] = [];

  const actor = getSafeCombatant(workingState, actorId);
  if (actor !== undefined && actor.isSummon === true) {
    if (!actor.alive) {
      removeCombatantFromState(workingState, actorId);
      despawnedIds.push(actorId);
    } else if (actor.summonRemainingTurns !== undefined) {
      const nextTurns = normalizeNumber(actor.summonRemainingTurns - 1);
      actor.summonRemainingTurns = nextTurns;
      if (nextTurns <= 0) {
        removeCombatantFromState(workingState, actorId);
        despawnedIds.push(actorId);
      }
    }
  }

  return {
    nextCombatState: workingState,
    despawnedIds,
  };
}

/**
 * Despawn all summons belonging to a fallen `summonerId`.
 */
export function despawnSummonsForFallenCaster(
  combatState: CombatState,
  summonerId: string,
  shouldDespawn?: (summon: CombatantState) => boolean
): DespawnSummonsResult {
  const workingState = cloneCombatState(combatState);
  const despawnedIds: string[] = [];

  for (const id of getSafeCombatantIds(workingState)) {
    const c = getSafeCombatant(workingState, id);
    if (
      c !== undefined &&
      c.isSummon === true &&
      c.summonerId === summonerId &&
      (shouldDespawn === undefined || shouldDespawn(c))
    ) {
      removeCombatantFromState(workingState, id);
      despawnedIds.push(id);
    }
  }

  return {
    nextCombatState: workingState,
    despawnedIds,
  };
}

/**
 * Strip all temporary `isSummon: true` combatants when an encounter ends
 * so `WorldState.entities.characters` is never polluted with summon tokens.
 */
export function purgeSummonsOnEncounterEnd(combatState: CombatState): PurgeSummonsResult {
  const workingState = cloneCombatState(combatState);
  const purgedIds: string[] = [];

  for (const id of getSafeCombatantIds(workingState)) {
    const c = getSafeCombatant(workingState, id);
    if (c !== undefined && c.isSummon === true) {
      removeCombatantFromState(workingState, id);
      purgedIds.push(id);
    }
  }

  return {
    nextCombatState: workingState,
    purgedIds,
  };
}

function captureSnapshot(combatant: CombatantState): PreTransformSnapshot {
  return {
    ac: normalizeNumber(combatant.ac),
    speed: normalizeNumber(combatant.speed),
    stats: cloneNumberRecord(combatant.stats),
    abilities: [...combatant.abilities],
    passives: combatant.passives.map(clonePassive),
  };
}

function readSnapshot(raw: Record<string, unknown>, fallback: CombatantState): PreTransformSnapshot {
  const acVal = Object.getOwnPropertyDescriptor(raw, 'ac')?.value;
  const speedVal = Object.getOwnPropertyDescriptor(raw, 'speed')?.value;
  const statsVal = Object.getOwnPropertyDescriptor(raw, 'stats')?.value;
  const abilitiesVal = Object.getOwnPropertyDescriptor(raw, 'abilities')?.value;
  const passivesVal = Object.getOwnPropertyDescriptor(raw, 'passives')?.value;

  const stats: Record<string, number> =
    typeof statsVal === 'object' && statsVal !== null && !Array.isArray(statsVal)
      ? cloneNumberRecord(statsVal as Record<string, number>)
      : cloneNumberRecord(fallback.stats);

  const abilities: string[] = Array.isArray(abilitiesVal)
    ? abilitiesVal.filter((item): item is string => typeof item === 'string')
    : [...fallback.abilities];

  const passives: PassiveDefinition[] = Array.isArray(passivesVal)
    ? passivesVal
        .filter((item): item is PassiveDefinition => typeof item === 'object' && item !== null)
        .map(clonePassive)
    : fallback.passives.map(clonePassive);

  return {
    ac: typeof acVal === 'number' && Number.isFinite(acVal) ? normalizeNumber(acVal) : normalizeNumber(fallback.ac),
    speed:
      typeof speedVal === 'number' && Number.isFinite(speedVal)
        ? normalizeNumber(speedVal)
        : normalizeNumber(fallback.speed),
    stats,
    abilities,
    passives,
  };
}

function snapshotToRecord(snapshot: PreTransformSnapshot): Record<string, unknown> {
  return {
    ac: normalizeNumber(snapshot.ac),
    speed: normalizeNumber(snapshot.speed),
    stats: cloneNumberRecord(snapshot.stats),
    abilities: [...snapshot.abilities],
    passives: snapshot.passives.map(clonePassive),
  };
}

function mergeUniqueStrings(base: readonly string[], additions: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of base) {
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  for (const item of additions) {
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

function mergePassives(
  base: readonly PassiveDefinition[],
  additions: readonly PassiveDefinition[]
): PassiveDefinition[] {
  const seen = new Set<string>();
  const out: PassiveDefinition[] = [];
  for (const p of base) {
    if (!seen.has(p.id)) {
      seen.add(p.id);
      out.push(clonePassive(p));
    }
  }
  for (const p of additions) {
    if (!seen.has(p.id)) {
      seen.add(p.id);
      out.push(clonePassive(p));
    }
  }
  return out;
}

function restoreFromSnapshot(target: CombatantState, snapshot: PreTransformSnapshot): void {
  target.ac = normalizeNumber(snapshot.ac);
  target.speed = normalizeNumber(snapshot.speed);
  target.stats = cloneNumberRecord(snapshot.stats);
  target.abilities = [...snapshot.abilities];
  target.passives = snapshot.passives.map(clonePassive);
  delete target.activeTransform;
}

/**
 * Apply a multi-stage transformation loadout to `targetId`.
 *
 * Captures an immutable root `preTransformSnapshot` only if the target is not
 * already transformed, so chained transformations (Form A -> Form B -> revert)
 * always restore the original baseline cleanly.
 */
export function applyCombatTransformation(
  combatState: CombatState,
  targetId: string,
  loadout: CombatFormLoadout
): ApplyCombatTransformationResult {
  const workingState = cloneCombatState(combatState);
  const target = getSafeCombatant(workingState, targetId);

  if (target === undefined || !target.alive) {
    return {
      nextCombatState: workingState,
      applied: false,
      worldPatches: [],
    };
  }

  // Preserve the root pre-transform snapshot across chained transformations.
  const rootSnapshot =
    target.activeTransform !== undefined
      ? readSnapshot(target.activeTransform.preTransformSnapshot, target)
      : captureSnapshot(target);

  const nextStats = cloneNumberRecord(rootSnapshot.stats);
  if (loadout.statOverrides !== undefined) {
    for (const key of Object.keys(loadout.statOverrides)) {
      if (isSafeKey(key) && Object.hasOwn(loadout.statOverrides, key)) {
        const val = getOwnNumber(loadout.statOverrides, key);
        if (val !== undefined) {
          setOwnProperty(nextStats, key, val);
        }
      }
    }
  }
  if (loadout.statBonuses !== undefined) {
    for (const key of Object.keys(loadout.statBonuses)) {
      if (isSafeKey(key) && Object.hasOwn(loadout.statBonuses, key)) {
        const bonus = getOwnNumber(loadout.statBonuses, key);
        if (bonus !== undefined) {
          const baseVal = getOwnNumber(nextStats, key) ?? 0;
          setOwnProperty(nextStats, key, normalizeNumber(baseVal + bonus));
        }
      }
    }
  }

  const nextAc =
    loadout.acOverride !== undefined ? normalizeNumber(loadout.acOverride) : rootSnapshot.ac;
  const nextSpeed =
    loadout.speedOverride !== undefined
      ? normalizeNumber(Math.max(0, loadout.speedOverride))
      : rootSnapshot.speed;

  const nextAbilities = loadout.replaceAbilities
    ? [...loadout.abilities]
    : mergeUniqueStrings(rootSnapshot.abilities, loadout.abilities);

  let nextPassives: PassiveDefinition[];
  if (loadout.passives !== undefined) {
    nextPassives = loadout.replaceAbilities
      ? loadout.passives.map(clonePassive)
      : mergePassives(rootSnapshot.passives, loadout.passives);
  } else {
    nextPassives = rootSnapshot.passives.map(clonePassive);
  }

  target.stats = nextStats;
  target.ac = nextAc;
  target.speed = nextSpeed;
  target.remainingMovement = normalizeNumber(Math.min(target.remainingMovement, nextSpeed));
  target.abilities = nextAbilities;
  target.passives = nextPassives;

  target.activeTransform = {
    loadoutId: loadout.id,
    remainingTurns:
      loadout.durationTurns === null
        ? null
        : normalizeNumber(Math.max(0, loadout.durationTurns)),
    tempHp:
      loadout.tempHpPool !== undefined ? normalizeNumber(Math.max(0, loadout.tempHpPool)) : 0,
    revertOnZeroTempHp: Boolean(loadout.revertOnZeroTempHp),
    preTransformSnapshot: snapshotToRecord(rootSnapshot),
  };

  const worldPatches: PatchOperation[] = [];
  if (loadout.persistFormIdToWorld !== undefined && loadout.persistFormIdToWorld.length > 0) {
    worldPatches.push({
      op: 'form_transform',
      characterId: target.id,
      targetFormId: loadout.persistFormIdToWorld,
      triggerTag: `combat_transform:${loadout.id}`,
    });
  }

  return {
    nextCombatState: workingState,
    applied: true,
    worldPatches,
  };
}

/**
 * Revert `targetId` back to its root pre-transformation baseline.
 */
export function revertCombatTransformation(
  combatState: CombatState,
  targetId: string
): RevertCombatTransformationResult {
  const workingState = cloneCombatState(combatState);
  const target = getSafeCombatant(workingState, targetId);

  if (target === undefined || target.activeTransform === undefined) {
    return {
      nextCombatState: workingState,
      reverted: false,
    };
  }

  const rootSnapshot = readSnapshot(target.activeTransform.preTransformSnapshot, target);
  restoreFromSnapshot(target, rootSnapshot);

  return {
    nextCombatState: workingState,
    reverted: true,
  };
}

/**
 * Absorb incoming damage into `activeTransform.tempHp` (if any) and auto-revert
 * when `tempHp <= 0` and `revertOnZeroTempHp` is enabled.
 */
export function applyTransformTempHpDamage(
  combatState: CombatState,
  targetId: string,
  damageAmount: number
): ApplyTransformTempHpDamageResult {
  const workingState = cloneCombatState(combatState);
  const target = getSafeCombatant(workingState, targetId);
  const sanitizedDamage = normalizeNumber(Math.max(0, damageAmount));

  if (target === undefined || target.activeTransform === undefined) {
    return {
      nextCombatState: workingState,
      absorbedDamage: 0,
      remainingDamage: sanitizedDamage,
      reverted: false,
    };
  }

  const currentTempHp = normalizeNumber(Math.max(0, target.activeTransform.tempHp));
  const absorbedDamage = normalizeNumber(Math.min(currentTempHp, sanitizedDamage));
  const remainingDamage = normalizeNumber(sanitizedDamage - absorbedDamage);
  const nextTempHp = normalizeNumber(currentTempHp - absorbedDamage);
  target.activeTransform.tempHp = nextTempHp;

  let reverted = false;
  if (target.activeTransform.revertOnZeroTempHp && nextTempHp <= 0) {
    const rootSnapshot = readSnapshot(target.activeTransform.preTransformSnapshot, target);
    restoreFromSnapshot(target, rootSnapshot);
    reverted = true;
  }

  return {
    nextCombatState: workingState,
    absorbedDamage,
    remainingDamage,
    reverted,
  };
}

/**
 * Tick transformation duration for `actorId`, auto-reverting if `remainingTurns <= 0`
 * or if `revertOnZeroTempHp && tempHp <= 0`.
 */
export function tickCombatTransformations(
  combatState: CombatState,
  actorId: string
): TickTransformationsResult {
  const workingState = cloneCombatState(combatState);
  const actor = getSafeCombatant(workingState, actorId);
  const revertedIds: string[] = [];

  if (actor !== undefined && actor.activeTransform !== undefined) {
    if (actor.activeTransform.revertOnZeroTempHp && actor.activeTransform.tempHp <= 0) {
      const rootSnapshot = readSnapshot(actor.activeTransform.preTransformSnapshot, actor);
      restoreFromSnapshot(actor, rootSnapshot);
      revertedIds.push(actorId);
    } else if (actor.activeTransform.remainingTurns !== null) {
      const nextTurns = normalizeNumber(actor.activeTransform.remainingTurns - 1);
      actor.activeTransform.remainingTurns = nextTurns;
      if (nextTurns <= 0) {
        const rootSnapshot = readSnapshot(actor.activeTransform.preTransformSnapshot, actor);
        restoreFromSnapshot(actor, rootSnapshot);
        revertedIds.push(actorId);
      }
    }
  }

  return {
    nextCombatState: workingState,
    revertedIds,
  };
}

/**
 * Revert all active combat transformations across all combatants on encounter end.
 */
export function revertAllTransformsOnEncounterEnd(
  combatState: CombatState
): RevertAllTransformsResult {
  const workingState = cloneCombatState(combatState);
  const revertedIds: string[] = [];

  for (const id of getSafeCombatantIds(workingState)) {
    const c = getSafeCombatant(workingState, id);
    if (c !== undefined && c.activeTransform !== undefined) {
      const rootSnapshot = readSnapshot(c.activeTransform.preTransformSnapshot, c);
      restoreFromSnapshot(c, rootSnapshot);
      revertedIds.push(id);
    }
  }

  return {
    nextCombatState: workingState,
    revertedIds,
  };
}
