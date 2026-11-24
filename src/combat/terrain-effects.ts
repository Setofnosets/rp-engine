import { rollDice } from '../core/dice.js';
import type { RngState } from '../core/prng.js';
import { unwrap } from '../core/result.js';
import {
  type CombatState,
  type CombatTeam,
  type CombatantState,
  getOwnNumber,
  getSafeCombatant,
  getSafeCombatantIds,
} from './action-validator.js';
import type {
  GridCoord,
  GridTile,
  TacticalGrid,
  TerrainModificationSpec,
  TileHazard,
} from './grid-types.js';
import { chebyshevDistance, evaluateLineOfSight, getTileAt } from './spatial-math.js';
import { type ActiveStatusEffect, applyStatusEffect } from './status-effects.js';

const DEFAULT_HAZARD_DAMAGE_DICE = '1d4';
const DEFAULT_KNOCKBACK_COLLISION_DICE = '1d6';
const DEFAULT_ICE_SAVE_DC = 12;
const DEFAULT_TRADITIONAL_ZONE_DURATION = 3;

export interface TileHazardTriggerResult {
  readonly triggered: boolean;
  readonly hazard: TileHazard;
  readonly timing: 'turn_start' | 'step_entry';
  readonly damage: number;
  readonly healing: number;
  readonly appliedStatuses: ActiveStatusEffect[];
  readonly savePassed?: boolean;
  readonly nextRng: RngState;
}

export type KnockbackCollisionType = 'none' | 'wall' | 'obstacle' | 'combatant';

export interface KnockbackCollisionResult {
  readonly movedSteps: number;
  readonly finalCoord: GridCoord;
  readonly collided: boolean;
  readonly collisionType: KnockbackCollisionType;
  readonly collisionDamage: number;
  readonly collidedCombatantId: string | null;
  readonly shatteredObstacle: boolean;
  readonly nextRng: RngState;
}

export interface TraditionalZoneHazardResult {
  readonly applied: boolean;
  readonly zoneStatuses: ActiveStatusEffect[];
  readonly affectedCombatantIds: string[];
}

function normalizeZero(value: number): number {
  return value === 0 ? 0 : value;
}

function normalizeCoord(coord: GridCoord): GridCoord {
  return {
    x: normalizeZero(coord.x),
    y: normalizeZero(coord.y),
  };
}

function coordsEqual(a: GridCoord, b: GridCoord): boolean {
  return a.x === b.x && a.y === b.y;
}

function cloneTile(tile: GridTile): GridTile {
  const cloned: GridTile = {
    x: normalizeZero(tile.x),
    y: normalizeZero(tile.y),
    passable: tile.passable,
    cover: tile.cover,
    elevation: normalizeZero(tile.elevation),
    hazard: tile.hazard,
    blocksLos: tile.blocksLos,
  };
  if (tile.baseHazard !== undefined) {
    cloned.baseHazard = tile.baseHazard;
  }
  if (tile.hazardDurationRounds !== undefined) {
    cloned.hazardDurationRounds =
      tile.hazardDurationRounds === null ? null : normalizeZero(tile.hazardDurationRounds);
  }
  if (tile.hazardDamageDice !== undefined) {
    cloned.hazardDamageDice = tile.hazardDamageDice;
  }
  if (tile.destructible !== undefined) {
    cloned.destructible = tile.destructible;
  }
  if (tile.obstacleHp !== undefined) {
    cloned.obstacleHp = normalizeZero(tile.obstacleHp);
  }
  if (tile.maxObstacleHp !== undefined) {
    cloned.maxObstacleHp = normalizeZero(tile.maxObstacleHp);
  }
  return cloned;
}

function findTileIndex(tiles: readonly GridTile[], width: number, coord: GridCoord): number {
  const directIdx = coord.y * width + coord.x;
  const direct = tiles[directIdx];
  if (direct !== undefined && direct.x === coord.x && direct.y === coord.y) {
    return directIdx;
  }
  return tiles.findIndex((t) => t.x === coord.x && t.y === coord.y);
}

function isPointInCone(
  origin: GridCoord,
  aimPoint: GridCoord,
  candidate: GridCoord,
  maxRange: number
): boolean {
  if (coordsEqual(origin, candidate)) {
    return false;
  }
  if (chebyshevDistance(origin, candidate) > maxRange) {
    return false;
  }
  const dirX = aimPoint.x - origin.x;
  const dirY = aimPoint.y - origin.y;
  const candX = candidate.x - origin.x;
  const candY = candidate.y - origin.y;
  const dirLen = Math.hypot(dirX, dirY);
  const candLen = Math.hypot(candX, candY);
  if (dirLen === 0 || candLen === 0) {
    return false;
  }
  const cosTheta = (dirX * candX + dirY * candY) / (dirLen * candLen);
  return cosTheta >= Math.SQRT1_2 - 1e-6;
}

/**
 * Compute all in-bounds grid coordinates affected by a terrain modification shape.
 */
export function resolveTerrainFootprint(
  grid: TacticalGrid,
  origin: GridCoord,
  aimCoord: GridCoord,
  spec: TerrainModificationSpec
): GridCoord[] {
  if (!Number.isSafeInteger(grid.width) || !Number.isSafeInteger(grid.height) || grid.width <= 0 || grid.height <= 0) {
    return [];
  }

  switch (spec.shape) {
    case 'single_tile': {
      return getTileAt(grid, aimCoord) !== null ? [normalizeCoord(aimCoord)] : [];
    }
    case 'aoe_radius': {
      if (getTileAt(grid, aimCoord) === null) {
        return [];
      }
      const radius =
        spec.radius !== undefined && Number.isFinite(spec.radius)
          ? Math.max(0, Math.floor(spec.radius))
          : 1;
      const minX = Math.max(0, aimCoord.x - radius);
      const maxX = Math.min(grid.width - 1, aimCoord.x + radius);
      const minY = Math.max(0, aimCoord.y - radius);
      const maxY = Math.min(grid.height - 1, aimCoord.y + radius);
      const coords: GridCoord[] = [];
      for (let y = minY; y <= maxY; y += 1) {
        for (let x = minX; x <= maxX; x += 1) {
          const candidate = normalizeCoord({ x, y });
          if (chebyshevDistance(aimCoord, candidate) <= radius && getTileAt(grid, candidate) !== null) {
            coords.push(candidate);
          }
        }
      }
      return coords;
    }
    case 'line': {
      if (getTileAt(grid, origin) === null || getTileAt(grid, aimCoord) === null) {
        return [];
      }
      const path = evaluateLineOfSight(grid, origin, aimCoord).path.slice(1);
      const maxSteps =
        spec.radius !== undefined && Number.isFinite(spec.radius) && spec.radius > 0
          ? Math.floor(spec.radius)
          : path.length;
      return path.slice(0, maxSteps).map(normalizeCoord);
    }
    case 'cone': {
      if (getTileAt(grid, origin) === null || getTileAt(grid, aimCoord) === null) {
        return [];
      }
      const maxRange =
        spec.radius !== undefined && Number.isFinite(spec.radius) && spec.radius > 0
          ? Math.floor(spec.radius)
          : Math.max(1, chebyshevDistance(origin, aimCoord));
      const minX = Math.max(0, origin.x - maxRange);
      const maxX = Math.min(grid.width - 1, origin.x + maxRange);
      const minY = Math.max(0, origin.y - maxRange);
      const maxY = Math.min(grid.height - 1, origin.y + maxRange);
      const coords: GridCoord[] = [];
      for (let y = minY; y <= maxY; y += 1) {
        for (let x = minX; x <= maxX; x += 1) {
          const candidate = normalizeCoord({ x, y });
          if (
            isPointInCone(origin, aimCoord, candidate, maxRange) &&
            getTileAt(grid, candidate) !== null
          ) {
            coords.push(candidate);
          }
        }
      }
      return coords;
    }
  }
}

function applySpecToTile(tile: GridTile, spec: TerrainModificationSpec): GridTile {
  const next = cloneTile(tile);

  if (spec.passable !== undefined) {
    next.passable = spec.passable;
  }
  if (spec.blocksLos !== undefined) {
    next.blocksLos = spec.blocksLos;
  }
  if (spec.cover !== undefined) {
    next.cover = spec.cover;
  }

  if (spec.setElevation !== undefined && Number.isFinite(spec.setElevation)) {
    next.elevation = normalizeZero(spec.setElevation);
  } else if (spec.elevationDelta !== undefined && Number.isFinite(spec.elevationDelta)) {
    next.elevation = normalizeZero(next.elevation + spec.elevationDelta);
  }

  if (spec.destructible !== undefined) {
    next.destructible = spec.destructible;
    if (!spec.destructible) {
      delete next.obstacleHp;
      delete next.maxObstacleHp;
    }
  }
  if (spec.obstacleHp !== undefined && Number.isFinite(spec.obstacleHp)) {
    const safeHp = Math.max(0, normalizeZero(spec.obstacleHp));
    next.obstacleHp = safeHp;
    next.maxObstacleHp = safeHp;
    if (spec.destructible === undefined && safeHp > 0) {
      next.destructible = true;
    }
  }

  if (spec.hazard !== undefined) {
    const hasFiniteDuration =
      spec.hazardDurationRounds !== undefined &&
      spec.hazardDurationRounds !== null &&
      Number.isFinite(spec.hazardDurationRounds);

    if (hasFiniteDuration) {
      const rounds = Math.floor(spec.hazardDurationRounds as number);
      if (rounds > 0) {
        if (next.baseHazard === undefined) {
          next.baseHazard = next.hazard;
        }
        next.hazard = spec.hazard;
        next.hazardDurationRounds = rounds;
      } else {
        next.hazard = next.baseHazard ?? next.hazard;
        delete next.baseHazard;
        delete next.hazardDurationRounds;
        delete next.hazardDamageDice;
      }
    } else {
      next.hazard = spec.hazard;
      next.baseHazard = spec.hazard;
      delete next.hazardDurationRounds;
      if (spec.hazard === 'none') {
        delete next.baseHazard;
        delete next.hazardDamageDice;
      }
    }
  }

  if (spec.hazardDamageDice !== undefined) {
    next.hazardDamageDice = spec.hazardDamageDice;
  } else if (spec.hazard !== undefined && spec.hazard !== tile.hazard) {
    delete next.hazardDamageDice;
  }

  return next;
}

/**
 * Purely apply a {@link TerrainModificationSpec} to a {@link TacticalGrid}, returning
 * an updated grid without mutating the input grid or its tiles.
 */
export function applyTerrainModification(
  grid: TacticalGrid,
  origin: GridCoord,
  aimCoord: GridCoord,
  spec: TerrainModificationSpec
): TacticalGrid {
  const tiles = grid.tiles.map(cloneTile);
  const footprint = resolveTerrainFootprint(grid, origin, aimCoord, spec);

  for (const coord of footprint) {
    const idx = findTileIndex(tiles, grid.width, coord);
    const existing = idx >= 0 ? tiles[idx] : undefined;
    if (existing !== undefined) {
      tiles[idx] = applySpecToTile(existing, spec);
    }
  }

  return {
    width: grid.width,
    height: grid.height,
    theme: grid.theme,
    tiles,
  };
}

/**
 * Decrement `hazardDurationRounds` on all timed hazard tiles at round boundaries,
 * reverting expired temporary surfaces back to their preserved `baseHazard` (or `'none'`).
 */
export function tickRoundTerrainHazards(grid: TacticalGrid): TacticalGrid {
  const tiles = grid.tiles.map((tile) => {
    const next = cloneTile(tile);
    if (next.hazardDurationRounds === undefined || next.hazardDurationRounds === null) {
      return next;
    }

    const remaining = Math.floor(next.hazardDurationRounds) - 1;
    if (remaining <= 0) {
      next.hazard = next.baseHazard ?? 'none';
      delete next.baseHazard;
      delete next.hazardDurationRounds;
      delete next.hazardDamageDice;
      return next;
    }

    next.hazardDurationRounds = normalizeZero(remaining);
    return next;
  });

  return {
    width: grid.width,
    height: grid.height,
    theme: grid.theme,
    tiles,
  };
}

/**
 * Apply damage to a destructible obstacle at `coord`, shattering it into passable
 * difficult-terrain rubble when its `obstacleHp` reaches `0`.
 */
export function damageDestructibleObstacle(
  grid: TacticalGrid,
  coord: GridCoord,
  damage: number
): { grid: TacticalGrid; shattered: boolean; remainingHp: number } {
  const tiles = grid.tiles.map(cloneTile);
  const idx = findTileIndex(tiles, grid.width, coord);
  const tile = idx >= 0 ? tiles[idx] : undefined;

  if (tile === undefined || tile.destructible !== true) {
    return {
      grid: { width: grid.width, height: grid.height, theme: grid.theme, tiles },
      shattered: false,
      remainingHp: tile?.obstacleHp ?? 0,
    };
  }

  const safeDamage = Number.isFinite(damage) && damage > 0 ? Math.floor(damage) : 0;
  const currentHp = tile.obstacleHp ?? 1;
  const nextHp = Math.max(0, normalizeZero(currentHp - safeDamage));

  if (nextHp <= 0) {
    tile.passable = true;
    tile.blocksLos = false;
    tile.cover = 'none';
    tile.hazard = 'difficult';
    tile.destructible = false;
    tile.obstacleHp = 0;
    tiles[idx] = tile;
    return {
      grid: { width: grid.width, height: grid.height, theme: grid.theme, tiles },
      shattered: true,
      remainingHp: 0,
    };
  }

  tile.obstacleHp = nextHp;
  tiles[idx] = tile;
  return {
    grid: { width: grid.width, height: grid.height, theme: grid.theme, tiles },
    shattered: false,
    remainingHp: nextHp,
  };
}

/**
 * Deterministically evaluate a tile hazard trigger when a combatant enters a tile or starts their turn on it.
 */
export function evaluateTileHazardTrigger(
  tile: GridTile,
  combatant: CombatantState,
  timing: 'turn_start' | 'step_entry',
  rng: RngState
): TileHazardTriggerResult {
  if (!combatant.alive || combatant.hp <= 0) {
    return {
      triggered: false,
      hazard: tile.hazard,
      timing,
      damage: 0,
      healing: 0,
      appliedStatuses: [],
      nextRng: rng,
    };
  }

  switch (tile.hazard) {
    case 'none':
    case 'difficult': {
      return {
        triggered: false,
        hazard: tile.hazard,
        timing,
        damage: 0,
        healing: 0,
        appliedStatuses: [],
        nextRng: rng,
      };
    }
    case 'fire':
    case 'acid': {
      const dice = tile.hazardDamageDice ?? DEFAULT_HAZARD_DAMAGE_DICE;
      const rolled = unwrap(rollDice(dice, rng));
      return {
        triggered: true,
        hazard: tile.hazard,
        timing,
        damage: Math.max(0, normalizeZero(rolled.total)),
        healing: 0,
        appliedStatuses: [],
        nextRng: rolled.nextState,
      };
    }
    case 'ice': {
      const saveRoll = unwrap(rollDice('1d20', rng));
      const dexMod = getOwnNumber(combatant.stats, 'dex') ?? 0;
      const savePassed = saveRoll.total + dexMod >= DEFAULT_ICE_SAVE_DC;
      const appliedStatuses: ActiveStatusEffect[] = savePassed
        ? []
        : [
            {
              id: 'prone',
              name: 'Prone',
              remainingTurns: 1,
              intensity: 1,
              stackPolicy: 'refresh',
              tickTiming: 'turn_end',
              root: true,
            },
          ];
      return {
        triggered: true,
        hazard: 'ice',
        timing,
        damage: 0,
        healing: 0,
        appliedStatuses,
        savePassed,
        nextRng: saveRoll.nextState,
      };
    }
    case 'electrified': {
      let currentRng = rng;
      let damage = 0;
      if (tile.hazardDamageDice !== undefined) {
        const rolled = unwrap(rollDice(tile.hazardDamageDice, currentRng));
        currentRng = rolled.nextState;
        damage = Math.max(0, normalizeZero(rolled.total));
      }
      const shocked: ActiveStatusEffect = {
        id: 'shocked',
        name: 'Shocked',
        remainingTurns: 1,
        intensity: 1,
        stackPolicy: 'refresh',
        tickTiming: 'turn_end',
        statModifiers: { ac: -1 },
      };
      return {
        triggered: true,
        hazard: 'electrified',
        timing,
        damage,
        healing: 0,
        appliedStatuses: [shocked],
        nextRng: currentRng,
      };
    }
    case 'sanctuary': {
      const dice = tile.hazardDamageDice ?? DEFAULT_HAZARD_DAMAGE_DICE;
      const rolled = unwrap(rollDice(dice, rng));
      return {
        triggered: true,
        hazard: 'sanctuary',
        timing,
        damage: 0,
        healing: Math.max(0, normalizeZero(rolled.total)),
        appliedStatuses: [],
        nextRng: rolled.nextState,
      };
    }
  }
}

function applyCollisionDamage(combatant: CombatantState, damage: number): void {
  const safeDamage = Math.max(0, normalizeZero(damage));
  combatant.hp = Math.max(0, normalizeZero(combatant.hp - safeDamage));
  if (combatant.hp <= 0) {
    combatant.hp = 0;
    combatant.alive = false;
  }
}

/**
 * Step `target` along the knockback vector away from `casterCoord`, resolving collisions
 * against walls, destructible obstacles (damaging and shattering them at `<= 0` HP),
 * and other living combatants with deterministic `1d6` collision damage.
 */
export function resolveKnockbackWithCollision(
  combat: CombatState,
  casterCoord: GridCoord,
  target: CombatantState,
  distance: number,
  rng: RngState
): KnockbackCollisionResult {
  if (
    combat.mode !== 'tactical_grid' ||
    combat.grid === null ||
    !Number.isFinite(distance) ||
    distance <= 0 ||
    !target.alive ||
    target.hp <= 0
  ) {
    return {
      movedSteps: 0,
      finalCoord: normalizeCoord(target.coord),
      collided: false,
      collisionType: 'none',
      collisionDamage: 0,
      collidedCombatantId: null,
      shatteredObstacle: false,
      nextRng: rng,
    };
  }

  const dx = Math.sign(target.coord.x - casterCoord.x);
  const dy = Math.sign(target.coord.y - casterCoord.y);
  if (dx === 0 && dy === 0) {
    return {
      movedSteps: 0,
      finalCoord: normalizeCoord(target.coord),
      collided: false,
      collisionType: 'none',
      collisionDamage: 0,
      collidedCombatantId: null,
      shatteredObstacle: false,
      nextRng: rng,
    };
  }

  const occupantByCoord = new Map<string, CombatantState>();
  for (const id of getSafeCombatantIds(combat)) {
    const candidate = getSafeCombatant(combat, id);
    if (candidate !== undefined && candidate.alive && candidate.hp > 0 && candidate.id !== target.id) {
      occupantByCoord.set(`${candidate.coord.x},${candidate.coord.y}`, candidate);
    }
  }

  const steps = Math.floor(distance);
  let movedSteps = 0;
  let currentRng = rng;

  for (let i = 0; i < steps; i += 1) {
    const nextCoord = normalizeCoord({
      x: target.coord.x + dx,
      y: target.coord.y + dy,
    });
    const tile = getTileAt(combat.grid, nextCoord);

    if (tile === null || !tile.passable) {
      const slamRoll = unwrap(rollDice(DEFAULT_KNOCKBACK_COLLISION_DICE, currentRng));
      currentRng = slamRoll.nextState;
      const collisionDamage = Math.max(0, normalizeZero(slamRoll.total));
      applyCollisionDamage(target, collisionDamage);

      let shatteredObstacle = false;
      let collisionType: KnockbackCollisionType = 'wall';

      if (tile !== null && tile.destructible === true) {
        collisionType = 'obstacle';
        const obstacleResult = damageDestructibleObstacle(combat.grid, nextCoord, collisionDamage);
        combat.grid = obstacleResult.grid;
        shatteredObstacle = obstacleResult.shattered;
      }

      return {
        movedSteps,
        finalCoord: normalizeCoord(target.coord),
        collided: true,
        collisionType,
        collisionDamage,
        collidedCombatantId: null,
        shatteredObstacle,
        nextRng: currentRng,
      };
    }

    const occupant = occupantByCoord.get(`${nextCoord.x},${nextCoord.y}`);
    if (occupant !== undefined) {
      const slamRoll = unwrap(rollDice(DEFAULT_KNOCKBACK_COLLISION_DICE, currentRng));
      currentRng = slamRoll.nextState;
      const collisionDamage = Math.max(0, normalizeZero(slamRoll.total));
      applyCollisionDamage(target, collisionDamage);
      applyCollisionDamage(occupant, collisionDamage);

      return {
        movedSteps,
        finalCoord: normalizeCoord(target.coord),
        collided: true,
        collisionType: 'combatant',
        collisionDamage,
        collidedCombatantId: occupant.id,
        shatteredObstacle: false,
        nextRng: currentRng,
      };
    }

    target.coord = nextCoord;
    movedSteps += 1;
  }

  return {
    movedSteps,
    finalCoord: normalizeCoord(target.coord),
    collided: false,
    collisionType: 'none',
    collisionDamage: 0,
    collidedCombatantId: null,
    shatteredObstacle: false,
    nextRng: currentRng,
  };
}

function buildTraditionalZoneStatuses(spec: TerrainModificationSpec): ActiveStatusEffect[] {
  const duration =
    spec.hazardDurationRounds !== undefined &&
    spec.hazardDurationRounds !== null &&
    Number.isFinite(spec.hazardDurationRounds) &&
    spec.hazardDurationRounds > 0
      ? Math.floor(spec.hazardDurationRounds)
      : DEFAULT_TRADITIONAL_ZONE_DURATION;

  const statuses: ActiveStatusEffect[] = [];

  if (spec.hazard !== undefined && spec.hazard !== 'none') {
    switch (spec.hazard) {
      case 'fire':
      case 'acid': {
        statuses.push({
          id: `zone_${spec.hazard}`,
          name: spec.hazard === 'fire' ? 'Burning Zone' : 'Acidic Zone',
          remainingTurns: duration,
          intensity: 1,
          stackPolicy: 'refresh',
          tickTiming: 'turn_start',
          damageDice: spec.hazardDamageDice ?? DEFAULT_HAZARD_DAMAGE_DICE,
        });
        break;
      }
      case 'ice': {
        statuses.push({
          id: 'zone_ice',
          name: 'Frozen Zone',
          remainingTurns: duration,
          intensity: 1,
          stackPolicy: 'refresh',
          tickTiming: 'turn_start',
          root: true,
        });
        break;
      }
      case 'electrified': {
        statuses.push({
          id: 'zone_electrified',
          name: 'Electrified Zone',
          remainingTurns: duration,
          intensity: 1,
          stackPolicy: 'refresh',
          tickTiming: 'turn_start',
          statModifiers: { ac: -1 },
        });
        break;
      }
      case 'sanctuary': {
        statuses.push({
          id: 'zone_sanctuary',
          name: 'Sanctuary Zone',
          remainingTurns: duration,
          intensity: 1,
          stackPolicy: 'refresh',
          tickTiming: 'turn_start',
          healDice: spec.hazardDamageDice ?? DEFAULT_HAZARD_DAMAGE_DICE,
        });
        break;
      }
      case 'difficult': {
        statuses.push({
          id: 'zone_difficult',
          name: 'Difficult Zone',
          remainingTurns: duration,
          intensity: 1,
          stackPolicy: 'refresh',
          tickTiming: 'turn_end',
          statModifiers: { speed: -2 },
        });
        break;
      }
    }
  }

  if (spec.cover === 'half' || spec.cover === 'full') {
    statuses.push({
      id: 'zone_cover',
      name: spec.cover === 'full' ? 'Full Cover Zone' : 'Half Cover Zone',
      remainingTurns: duration,
      intensity: spec.cover === 'full' ? 2 : 1,
      stackPolicy: 'refresh',
      tickTiming: 'turn_end',
      statModifiers: { ac: spec.cover === 'full' ? 5 : 2 },
    });
  }

  if (
    (spec.elevationDelta !== undefined && spec.elevationDelta > 0) ||
    (spec.setElevation !== undefined && spec.setElevation > 0)
  ) {
    statuses.push({
      id: 'zone_high_ground',
      name: 'High Ground Zone',
      remainingTurns: duration,
      intensity: 1,
      stackPolicy: 'refresh',
      tickTiming: 'turn_end',
      statModifiers: { attack: 1 },
    });
  }

  return statuses;
}

/**
 * Graceful degradation helper for `traditional` (no-grid) combat mode, mapping
 * `modify_terrain` specifications onto battlefield zone status effects.
 */
export function applyTraditionalZoneHazard(
  combat: CombatState,
  spec: TerrainModificationSpec,
  targetTeam?: CombatTeam
): TraditionalZoneHazardResult {
  if (combat.mode !== 'traditional') {
    return {
      applied: false,
      zoneStatuses: [],
      affectedCombatantIds: [],
    };
  }

  const zoneStatuses = buildTraditionalZoneStatuses(spec);
  if (zoneStatuses.length === 0) {
    return {
      applied: false,
      zoneStatuses: [],
      affectedCombatantIds: [],
    };
  }

  const affectedCombatantIds: string[] = [];
  for (const id of getSafeCombatantIds(combat)) {
    const combatant = getSafeCombatant(combat, id);
    if (combatant === undefined || !combatant.alive || combatant.hp <= 0) {
      continue;
    }
    if (targetTeam !== undefined && combatant.team !== targetTeam) {
      continue;
    }
    let nextStatuses = combatant.statuses;
    for (const status of zoneStatuses) {
      nextStatuses = applyStatusEffect(nextStatuses, status);
    }
    combatant.statuses = nextStatuses;
    affectedCombatantIds.push(combatant.id);
  }

  return {
    applied: affectedCombatantIds.length > 0,
    zoneStatuses,
    affectedCombatantIds,
  };
}
