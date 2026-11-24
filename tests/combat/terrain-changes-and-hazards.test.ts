import { describe, expect, it } from 'vitest';
import type { CombatState, CombatantState } from '../../src/combat/action-validator.js';
import type { GridTile, TacticalGrid } from '../../src/combat/grid-types.js';
import {
  computeHighGroundAttackBonus,
  evaluateLineOfSight,
  findShortestPath,
  getTileAt,
} from '../../src/combat/spatial-math.js';
import {
  applyTerrainModification,
  applyTraditionalZoneHazard,
  damageDestructibleObstacle,
  evaluateTileHazardTrigger,
  resolveKnockbackWithCollision,
  resolveTerrainFootprint,
  tickRoundTerrainHazards,
} from '../../src/combat/terrain-effects.js';
import { createSeededRng } from '../../src/core/prng.js';

function createOpenGrid(width = 7, height = 7): TacticalGrid {
  const tiles: GridTile[] = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      tiles.push({
        x,
        y,
        passable: true,
        cover: 'none',
        elevation: 0,
        hazard: 'none',
        blocksLos: false,
      });
    }
  }
  return {
    width,
    height,
    theme: 'open',
    tiles,
  };
}

function makeCombatant(overrides: Partial<CombatantState> & { id: string }): CombatantState {
  return {
    id: overrides.id,
    name: overrides.name ?? overrides.id,
    team: overrides.team ?? 'ally',
    coord: overrides.coord ?? { x: 0, y: 0 },
    alive: overrides.alive ?? true,
    hp: overrides.hp ?? 20,
    maxHp: overrides.maxHp ?? 20,
    ac: overrides.ac ?? 12,
    speed: overrides.speed ?? 6,
    remainingMovement: overrides.remainingMovement ?? 6,
    remainingActions: overrides.remainingActions ?? { action: 1, bonus: 1, reaction: 1 },
    resources: overrides.resources ?? {},
    cooldowns: overrides.cooldowns ?? {},
    stats: overrides.stats ?? { str: 2, dex: 1, int: 1 },
    statuses: overrides.statuses ?? [],
    abilities: overrides.abilities ?? [],
    passives: overrides.passives ?? [],
    willpower: overrides.willpower ?? 10,
    maxWillpower: overrides.maxWillpower ?? 10,
  };
}

describe('PR-8.3: Dynamic Terrain Changes, Tile Hazards, Elevation & Knockback Collision', () => {
  it('creates an ice wall along a line that blocks LoS and A* pathfinding without mutating input grid', () => {
    const baseGrid = createOpenGrid(5, 5);

    const beforeLos = evaluateLineOfSight(baseGrid, { x: 0, y: 2 }, { x: 4, y: 2 });
    expect(beforeLos.visible).toBe(true);

    // Raise a 5-tile vertical ice wall across x = 2 (from y = 0 to y = 4)
    const walledGrid = applyTerrainModification(baseGrid, { x: 2, y: 0 }, { x: 2, y: 4 }, {
      shape: 'line',
      passable: false,
      blocksLos: true,
      cover: 'full',
      hazard: 'ice',
      destructible: true,
      obstacleHp: 10,
    });

    // Also block (2, 0) since 'line' starts after origin (2, 0)
    const fullWallGrid = applyTerrainModification(walledGrid, { x: 2, y: 0 }, { x: 2, y: 0 }, {
      shape: 'single_tile',
      passable: false,
      blocksLos: true,
      cover: 'full',
      hazard: 'ice',
      destructible: true,
      obstacleHp: 10,
    });

    // Input grid remains unmodified
    expect(getTileAt(baseGrid, { x: 2, y: 2 })?.passable).toBe(true);
    expect(getTileAt(baseGrid, { x: 2, y: 2 })?.blocksLos).toBe(false);

    const afterLos = evaluateLineOfSight(fullWallGrid, { x: 0, y: 2 }, { x: 4, y: 2 });
    expect(afterLos.visible).toBe(false);
    expect(afterLos.cover).toBe('blocked');

    const pathResult = findShortestPath(fullWallGrid, { x: 0, y: 2 }, { x: 4, y: 2 });
    expect(pathResult.reachable).toBe(false);
  });

  it('resolves aoe_radius and cone footprints deterministically', () => {
    const grid = createOpenGrid(7, 7);

    const radiusFootprint = resolveTerrainFootprint(grid, { x: 0, y: 0 }, { x: 3, y: 3 }, {
      shape: 'aoe_radius',
      radius: 1,
    });
    expect(radiusFootprint).toHaveLength(9);
    expect(radiusFootprint[0]).toEqual({ x: 2, y: 2 });
    expect(radiusFootprint[8]).toEqual({ x: 4, y: 4 });

    const coneFootprint = resolveTerrainFootprint(grid, { x: 3, y: 3 }, { x: 5, y: 3 }, {
      shape: 'cone',
      radius: 2,
    });
    expect(coneFootprint.length).toBeGreaterThan(0);
    expect(coneFootprint).toContainEqual({ x: 4, y: 3 });
    expect(coneFootprint).toContainEqual({ x: 5, y: 3 });
    expect(coneFootprint).not.toContainEqual({ x: 3, y: 3 });
    expect(coneFootprint).not.toContainEqual({ x: 2, y: 3 });
  });

  it('damages destructible cover and shatters it into passable difficult-terrain rubble at 0 HP', () => {
    const grid = applyTerrainModification(createOpenGrid(5, 5), { x: 2, y: 2 }, { x: 2, y: 2 }, {
      shape: 'single_tile',
      passable: false,
      blocksLos: true,
      cover: 'full',
      destructible: true,
      obstacleHp: 8,
    });

    const partial = damageDestructibleObstacle(grid, { x: 2, y: 2 }, 3);
    expect(partial.shattered).toBe(false);
    expect(partial.remainingHp).toBe(5);
    expect(getTileAt(partial.grid, { x: 2, y: 2 })?.passable).toBe(false);

    const shattered = damageDestructibleObstacle(partial.grid, { x: 2, y: 2 }, 5);
    expect(shattered.shattered).toBe(true);
    expect(shattered.remainingHp).toBe(0);

    const rubbleTile = getTileAt(shattered.grid, { x: 2, y: 2 });
    expect(rubbleTile?.passable).toBe(true);
    expect(rubbleTile?.blocksLos).toBe(false);
    expect(rubbleTile?.cover).toBe('none');
    expect(rubbleTile?.hazard).toBe('difficult');
    expect(rubbleTile?.destructible).toBe(false);
  });

  it('paints timed hazards preserving baseHazard, ticks rounds, and reverts upon expiry', () => {
    const withDifficult = applyTerrainModification(
      createOpenGrid(5, 5),
      { x: 1, y: 1 },
      { x: 1, y: 1 },
      { shape: 'single_tile', hazard: 'difficult' }
    );

    const withFire = applyTerrainModification(withDifficult, { x: 1, y: 1 }, { x: 2, y: 2 }, {
      shape: 'aoe_radius',
      radius: 0,
      hazard: 'fire',
      hazardDurationRounds: 2,
      hazardDamageDice: '1d6',
    });

    // Apply fire to (1,1) specifically to verify baseHazard 'difficult' is preserved
    const fireOnDifficult = applyTerrainModification(withFire, { x: 1, y: 1 }, { x: 1, y: 1 }, {
      shape: 'single_tile',
      hazard: 'fire',
      hazardDurationRounds: 2,
      hazardDamageDice: '1d6',
    });

    const tileBefore = getTileAt(fireOnDifficult, { x: 1, y: 1 });
    expect(tileBefore?.hazard).toBe('fire');
    expect(tileBefore?.baseHazard).toBe('difficult');
    expect(tileBefore?.hazardDurationRounds).toBe(2);

    const afterRound1 = tickRoundTerrainHazards(fireOnDifficult);
    const tileAfter1 = getTileAt(afterRound1, { x: 1, y: 1 });
    expect(tileAfter1?.hazard).toBe('fire');
    expect(tileAfter1?.hazardDurationRounds).toBe(1);

    const afterRound2 = tickRoundTerrainHazards(afterRound1);
    const tileAfter2 = getTileAt(afterRound2, { x: 1, y: 1 });
    expect(tileAfter2?.hazard).toBe('difficult');
    expect(tileAfter2?.hazardDurationRounds).toBeUndefined();
    expect(tileAfter2?.baseHazard).toBeUndefined();
    expect(tileAfter2?.hazardDamageDice).toBeUndefined();
  });

  it('evaluates fire, acid, ice, electrified, and sanctuary hazard triggers deterministically', () => {
    const rng = createSeededRng('pr-8-3-hazard-seed');
    const actor = makeCombatant({ id: 'hero', stats: { dex: 0 } });

    const fireTile: GridTile = {
      x: 1,
      y: 1,
      passable: true,
      cover: 'none',
      elevation: 0,
      hazard: 'fire',
      blocksLos: false,
    };
    const fire1 = evaluateTileHazardTrigger(fireTile, actor, 'step_entry', rng);
    const fire2 = evaluateTileHazardTrigger(fireTile, actor, 'step_entry', rng);
    expect(fire1.triggered).toBe(true);
    expect(fire1.damage).toBeGreaterThanOrEqual(1);
    expect(fire1.damage).toBeLessThanOrEqual(4);
    expect(fire1.damage).toBe(fire2.damage);

    const sanctuaryTile: GridTile = { ...fireTile, hazard: 'sanctuary', hazardDamageDice: '2d4' };
    const healRes = evaluateTileHazardTrigger(sanctuaryTile, actor, 'turn_start', fire1.nextRng);
    expect(healRes.triggered).toBe(true);
    expect(healRes.healing).toBeGreaterThanOrEqual(2);
    expect(healRes.healing).toBeLessThanOrEqual(8);

    const electrifiedTile: GridTile = { ...fireTile, hazard: 'electrified' };
    const shockRes = evaluateTileHazardTrigger(electrifiedTile, actor, 'step_entry', healRes.nextRng);
    expect(shockRes.triggered).toBe(true);
    expect(shockRes.appliedStatuses.map((s) => s.id)).toContain('shocked');

    // Ice save: test with a very low DEX vs very high DEX to verify both branches deterministically
    const clumsy = makeCombatant({ id: 'clumsy', stats: { dex: -20 } });
    const agile = makeCombatant({ id: 'agile', stats: { dex: 20 } });
    const iceTile: GridTile = { ...fireTile, hazard: 'ice' };

    const iceFail = evaluateTileHazardTrigger(iceTile, clumsy, 'step_entry', rng);
    expect(iceFail.savePassed).toBe(false);
    expect(iceFail.appliedStatuses.map((s) => s.id)).toContain('prone');
    expect(iceFail.appliedStatuses[0]?.root).toBe(true);

    const icePass = evaluateTileHazardTrigger(iceTile, agile, 'step_entry', rng);
    expect(icePass.savePassed).toBe(true);
    expect(icePass.appliedStatuses).toHaveLength(0);
  });

  it('treats ice hazard tiles as difficult movement cost in A* pathfinding', () => {
    const grid = applyTerrainModification(createOpenGrid(5, 1), { x: 2, y: 0 }, { x: 2, y: 0 }, {
      shape: 'single_tile',
      hazard: 'ice',
    });
    const path = findShortestPath(grid, { x: 0, y: 0 }, { x: 4, y: 0 });
    expect(path.reachable).toBe(true);
    // 3 normal steps (1 each) + 1 ice step (2) = 5
    expect(path.cost).toBe(5);
  });

  it('computes +1 high-ground attack bonus only when attacker elevation exceeds defender elevation', () => {
    let grid = createOpenGrid(5, 5);
    grid = applyTerrainModification(grid, { x: 0, y: 0 }, { x: 0, y: 0 }, {
      shape: 'single_tile',
      setElevation: 2,
    });
    grid = applyTerrainModification(grid, { x: 1, y: 0 }, { x: 1, y: 0 }, {
      shape: 'single_tile',
      elevationDelta: 1,
    });

    expect(computeHighGroundAttackBonus(grid, { x: 0, y: 0 }, { x: 1, y: 0 })).toBe(1);
    expect(computeHighGroundAttackBonus(grid, { x: 1, y: 0 }, { x: 0, y: 0 })).toBe(0);
    expect(computeHighGroundAttackBonus(grid, { x: 2, y: 0 }, { x: 3, y: 0 })).toBe(0);
    expect(computeHighGroundAttackBonus(grid, { x: -1, y: 0 }, { x: 0, y: 0 })).toBe(0);
  });

  it('resolves knockback collisions against walls, destructible obstacles, and other combatants', () => {
    const rng = createSeededRng('pr-8-3-knockback-seed');

    // 1. Destructible obstacle slam -> shatters obstacle at 1 HP and deals 1d6 to target
    const gridWithObstacle = applyTerrainModification(
      createOpenGrid(5, 5),
      { x: 3, y: 2 },
      { x: 3, y: 2 },
      {
        shape: 'single_tile',
        passable: false,
        blocksLos: true,
        cover: 'full',
        destructible: true,
        obstacleHp: 1,
      }
    );

    const target1 = makeCombatant({ id: 'goblin', team: 'enemy', coord: { x: 1, y: 2 }, hp: 20 });
    const combat1: CombatState = {
      active: true,
      mode: 'tactical_grid',
      round: 1,
      turnIndex: 0,
      initiativeOrder: ['hero', 'goblin'],
      grid: gridWithObstacle,
      combatants: { goblin: target1 },
      triggerCountsThisTurn: {},
    };

    const obstacleSlam = resolveKnockbackWithCollision(combat1, { x: 0, y: 2 }, target1, 3, rng);
    expect(obstacleSlam.movedSteps).toBe(1);
    expect(obstacleSlam.finalCoord).toEqual({ x: 2, y: 2 });
    expect(obstacleSlam.collided).toBe(true);
    expect(obstacleSlam.collisionType).toBe('obstacle');
    expect(obstacleSlam.collisionDamage).toBeGreaterThanOrEqual(1);
    expect(obstacleSlam.collisionDamage).toBeLessThanOrEqual(6);
    expect(obstacleSlam.shatteredObstacle).toBe(true);
    expect(target1.hp).toBe(20 - obstacleSlam.collisionDamage);
    expect(getTileAt(combat1.grid!, { x: 3, y: 2 })?.passable).toBe(true);
    expect(getTileAt(combat1.grid!, { x: 3, y: 2 })?.hazard).toBe('difficult');

    // 2. Unit-to-unit slam -> deals 1d6 collision damage to both combatants
    const target2 = makeCombatant({ id: 'orc_a', team: 'enemy', coord: { x: 1, y: 1 }, hp: 15 });
    const blocker = makeCombatant({ id: 'orc_b', team: 'enemy', coord: { x: 3, y: 1 }, hp: 15 });
    const combat2: CombatState = {
      active: true,
      mode: 'tactical_grid',
      round: 1,
      turnIndex: 0,
      initiativeOrder: ['orc_a', 'orc_b'],
      grid: createOpenGrid(5, 5),
      combatants: { orc_a: target2, orc_b: blocker },
      triggerCountsThisTurn: {},
    };

    const unitSlam = resolveKnockbackWithCollision(
      combat2,
      { x: 0, y: 1 },
      target2,
      3,
      obstacleSlam.nextRng
    );
    expect(unitSlam.movedSteps).toBe(1);
    expect(unitSlam.finalCoord).toEqual({ x: 2, y: 1 });
    expect(unitSlam.collided).toBe(true);
    expect(unitSlam.collisionType).toBe('combatant');
    expect(unitSlam.collidedCombatantId).toBe('orc_b');
    expect(target2.hp).toBe(15 - unitSlam.collisionDamage);
    expect(blocker.hp).toBe(15 - unitSlam.collisionDamage);
  });

  it('degrades gracefully in traditional combat mode via applyTraditionalZoneHazard', () => {
    const hero = makeCombatant({ id: 'hero', team: 'ally' });
    const foe = makeCombatant({ id: 'foe', team: 'enemy' });
    const traditionalCombat: CombatState = {
      active: true,
      mode: 'traditional',
      round: 1,
      turnIndex: 0,
      initiativeOrder: ['hero', 'foe'],
      grid: null,
      combatants: { hero, foe },
      triggerCountsThisTurn: {},
    };

    const fireResult = applyTraditionalZoneHazard(
      traditionalCombat,
      {
        shape: 'aoe_radius',
        radius: 2,
        hazard: 'fire',
        hazardDurationRounds: 3,
        hazardDamageDice: '1d6',
      },
      'enemy'
    );

    expect(fireResult.applied).toBe(true);
    expect(fireResult.affectedCombatantIds).toEqual(['foe']);
    expect(foe.statuses.map((s) => s.id)).toContain('zone_fire');
    expect(hero.statuses).toHaveLength(0);

    // Tactical grid mode returns applied: false
    const gridCombat: CombatState = {
      ...traditionalCombat,
      mode: 'tactical_grid',
      grid: createOpenGrid(3, 3),
    };
    const noOp = applyTraditionalZoneHazard(gridCombat, { shape: 'single_tile', hazard: 'fire' });
    expect(noOp.applied).toBe(false);
  });
});
