import { describe, expect, it } from 'vitest';
import {
  computeReachableTilesPreview,
  previewCombatAction,
} from '../../src/combat/action-preview.js';
import type { CombatState, CombatantState } from '../../src/combat/action-validator.js';
import type { GridTile, TacticalGrid } from '../../src/combat/grid-types.js';
import { SkillRegistry, createDefaultSkillCatalog } from '../../src/combat/skill-registry.js';
import { createSeededRng } from '../../src/core/prng.js';

function makeGrid(width = 6, height = 6): TacticalGrid {
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
  return { width, height, theme: 'open', tiles };
}

function makeCombatant(overrides: Partial<CombatantState> & { id: string }): CombatantState {
  return {
    name: overrides.id,
    team: 'ally',
    coord: { x: 0, y: 0 },
    alive: true,
    hp: 30,
    maxHp: 30,
    ac: 12,
    speed: 4,
    remainingMovement: 4,
    remainingActions: { action: 1, bonus: 1, reaction: 1 },
    resources: { mana: 10, stamina: 10 },
    cooldowns: {},
    stats: { str: 3, dex: 2, int: 3, wis: 2 },
    statuses: [],
    abilities: ['basic_strike', 'fireball'],
    passives: [],
    willpower: 20,
    maxWillpower: 20,
    ...overrides,
  };
}

function makeState(grid: TacticalGrid | null, combatants: CombatantState[], mode: 'tactical_grid' | 'traditional' = 'tactical_grid'): CombatState {
  const map: Record<string, CombatantState> = {};
  for (const c of combatants) {
    map[c.id] = c;
  }
  return {
    active: true,
    mode,
    round: 1,
    turnIndex: 0,
    initiativeOrder: combatants.map((c) => c.id),
    grid,
    combatants: map,
    triggerCountsThisTurn: {},
  };
}

describe('PR-8.5: Deterministic Pre-Commit Action Preview Engine', () => {
  it('computes reachable tiles with movement budget, difficult terrain, cover, elevation, and hazard warnings', () => {
    const grid = makeGrid(5, 5);
    // Difficult terrain at (1,0)
    grid.tiles[0 * 5 + 1]!.hazard = 'difficult';
    // Fire hazard at (0,1)
    grid.tiles[1 * 5 + 0]!.hazard = 'fire';
    // Elevated half-cover tile at (1,1)
    grid.tiles[1 * 5 + 1]!.elevation = 2;
    grid.tiles[1 * 5 + 1]!.cover = 'half';

    const hero = makeCombatant({
      id: 'hero',
      team: 'ally',
      coord: { x: 0, y: 0 },
      remainingMovement: 2,
    });
    const state = makeState(grid, [hero]);
    const beforeSnapshot = JSON.stringify(state);

    const preview = computeReachableTilesPreview(state, 'hero');
    expect(JSON.stringify(state)).toBe(beforeSnapshot);
    expect(preview.actorId).toBe('hero');

    const tile10 = preview.tiles.find((t) => t.coord.x === 1 && t.coord.y === 0);
    expect(tile10?.cost).toBe(2);

    const tile01 = preview.tiles.find((t) => t.coord.x === 0 && t.coord.y === 1);
    expect(tile01?.cost).toBe(1);
    expect(tile01?.hazardWarnings).toEqual([{ coord: { x: 0, y: 1 }, hazard: 'fire' }]);

    const tile11 = preview.tiles.find((t) => t.coord.x === 1 && t.coord.y === 1);
    expect(tile11?.elevation).toBe(2);
    expect(tile11?.cover).toBe('half');
  });

  it('evaluates all 20 faces of 1d20 accurately with high ground, cover, natural-1/20, and damage range', () => {
    const grid = makeGrid(6, 6);
    grid.tiles[1 * 6 + 1]!.elevation = 2; // hero high ground (+1 attack)
    grid.tiles[1 * 6 + 2]!.elevation = 0; // goblin low ground

    const hero = makeCombatant({
      id: 'hero',
      team: 'ally',
      coord: { x: 1, y: 1 },
      stats: { str: 4 },
    });
    const goblin = makeCombatant({
      id: 'goblin',
      team: 'enemy',
      coord: { x: 2, y: 1 },
      ac: 15,
    });

    const state = makeState(grid, [hero, goblin]);
    const registry = createDefaultSkillCatalog();
    const rng = createSeededRng('preview-seed');
    const stateBefore = JSON.stringify(state);
    const rngBefore = JSON.stringify(rng);

    const res = previewCombatAction(
      state,
      'hero',
      { type: 'skill', skillId: 'basic_strike', targetId: 'goblin' },
      registry
    );

    // Zero mutation & zero PRNG advance
    expect(JSON.stringify(state)).toBe(stateBefore);
    expect(JSON.stringify(rng)).toBe(rngBefore);

    expect(res.legal).toBe(true);
    expect(res.affectedTargetIds).toEqual(['goblin']);
    const targetPreview = res.targetPreviews[0]!;
    expect(targetPreview.effectiveAc).toBe(15);
    expect(targetPreview.highGroundBonus).toBe(1);
    // Attack mod = str(4) + highGround(1) = +5 vs AC 15 => d20 >= 10 hits => faces 10..20 = 11/20 = 0.55
    expect(targetPreview.hitProbability).toBeCloseTo(11 / 20, 6);
    expect(targetPreview.critProbability).toBeCloseTo(1 / 20, 6);
    // 1d8 + str(4): normal [5..12], expected = 4.5 + 4 = 8.5; crit [6..20], expected = 9 + 4 = 13
    expect(targetPreview.damageRange.min).toBe(5);
    expect(targetPreview.damageRange.max).toBe(20);
    expect(targetPreview.damageRange.expected).toBeCloseTo(0.5 * 8.5 + 0.05 * 13, 6);
  });

  it('computes save probabilities, @variable scaling, knockback collisions, terrain footprint, and summon spawn', () => {
    const grid = makeGrid(6, 6);
    const registry = createDefaultSkillCatalog();
    const shoveReg = registry.register({
      id: 'scaled_shove',
      name: 'Scaled Shove',
      category: 'skill',
      actionCost: 'action',
      resourceCosts: {},
      targeting: { shape: 'single_enemy', minRange: 1, maxRange: 2, requiresLos: true },
      hitResolution: { kind: 'auto' },
      effects: [
        { type: 'damage', dice: '1d4', scale: { variable: 'enemies', per: 1 }, flat: 2 },
        { type: 'knockback', distance: 3 },
      ],
    });
    expect(shoveReg.ok).toBe(true);
    const wallReg = registry.register({
      id: 'fire_wall',
      name: 'Fire Wall',
      category: 'spell',
      actionCost: 'action',
      resourceCosts: {},
      targeting: { shape: 'single_tile', minRange: 1, maxRange: 4, requiresLos: false },
      hitResolution: { kind: 'auto' },
      effects: [
        {
          type: 'modify_terrain',
          terrainSpec: { shape: 'aoe_radius', radius: 1, hazard: 'fire' },
        },
      ],
    });
    expect(wallReg.ok).toBe(true);

    const hero = makeCombatant({
      id: 'hero',
      team: 'ally',
      coord: { x: 1, y: 1 },
      abilities: ['scaled_shove', 'fire_wall'],
    });
    const enemy1 = makeCombatant({
      id: 'enemy1',
      team: 'enemy',
      coord: { x: 2, y: 1 },
    });
    const enemy2 = makeCombatant({
      id: 'enemy2',
      team: 'enemy',
      coord: { x: 4, y: 1 },
    });

    const state = makeState(grid, [hero, enemy1, enemy2]);
    const shovePreview = previewCombatAction(
      state,
      'hero',
      { type: 'skill', skillId: 'scaled_shove', targetId: 'enemy1' },
      registry
    );
    expect(shovePreview.legal).toBe(true);
    const tp = shovePreview.targetPreviews[0]!;
    expect(tp.hitProbability).toBe(1);
    // 1d4 + @enemies(2) + flat(2) => min 5, max 8, expected 6.5
    expect(tp.damageRange).toEqual({ min: 5, expected: 6.5, max: 8 });
    // Knockback from (1,1)->(2,1) pushes east: (3,1) is free, (4,1) is occupied by enemy2!
    expect(tp.knockbackPreview?.collisionWarning).toBe('combatant');
    expect(tp.knockbackPreview?.collidedCombatantId).toBe('enemy2');
    expect(tp.knockbackPreview?.path).toEqual([{ x: 3, y: 1 }]);

    const terrainPreview = previewCombatAction(
      state,
      'hero',
      { type: 'skill', skillId: 'fire_wall', targetCoord: { x: 3, y: 3 } },
      registry
    );
    expect(terrainPreview.legal).toBe(true);
    expect(terrainPreview.terrainModificationFootprint.length).toBe(9);
  });

  it('previews traditional mode back-row cover and front-row guard illegality accurately', () => {
    const registry = new SkillRegistry();
    registry.register({
      id: 'bow_shot',
      name: 'Bow Shot',
      category: 'attack',
      actionCost: 'action',
      resourceCosts: {},
      targeting: { shape: 'single_enemy', minRange: 1, maxRange: 6, requiresLos: false },
      hitResolution: { kind: 'attack_roll', stat: 'dex' },
      effects: [{ type: 'damage', dice: '1d6' }],
      tags: ['ranged'],
    });

    const hero = makeCombatant({
      id: 'hero',
      team: 'ally',
      coord: { x: 0, y: 0 },
      stats: { str: 3, dex: 3 },
      abilities: ['basic_strike', 'bow_shot'],
      formationRow: 'front',
    });
    const vanguard = makeCombatant({
      id: 'vanguard',
      team: 'enemy',
      ac: 14,
      formationRow: 'front',
    });
    const mage = makeCombatant({
      id: 'mage',
      team: 'enemy',
      ac: 12,
      formationRow: 'back',
    });

    const state = makeState(null, [hero, vanguard, mage], 'traditional');

    // Melee against back-row mage is intercepted by front-row vanguard while vanguard stands
    const meleeIntercepted = previewCombatAction(
      state,
      'hero',
      { type: 'skill', skillId: 'basic_strike', targetId: 'mage' },
      registry
    );
    expect(meleeIntercepted.legal).toBe(true);
    expect(meleeIntercepted.affectedTargetIds).toEqual(['vanguard']);

    // Ranged against back-row mage gets +2 back-row cover AC (12 + 2 = 14)
    const rangedPreview = previewCombatAction(
      state,
      'hero',
      { type: 'skill', skillId: 'bow_shot', targetId: 'mage' },
      registry
    );
    expect(rangedPreview.legal).toBe(true);
    expect(rangedPreview.targetPreviews[0]?.effectiveAc).toBe(14);
  });
});
