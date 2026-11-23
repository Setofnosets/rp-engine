import { describe, expect, it } from 'vitest';
import {
  type CombatState,
  type CombatantState,
  validateSingleCombatAction,
} from '../../src/combat/action-validator.js';
import { resolveCombatTurn } from '../../src/combat/combat-resolver.js';
import type { GridTile, TacticalGrid } from '../../src/combat/grid-types.js';
import { createDefaultSkillCatalog } from '../../src/combat/skill-registry.js';
import { createQueuedRng, createSeededRng } from '../../src/core/prng.js';
import { createWorldState } from '../../src/state/world-state.js';

function makeOpenGrid(width = 8, height = 8): TacticalGrid {
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

function makeUnit(overrides: Partial<CombatantState> & { id: string }): CombatantState {
  return {
    name: overrides.id,
    team: 'ally',
    coord: { x: 0, y: 0 },
    alive: true,
    hp: 20,
    maxHp: 20,
    ac: 10,
    speed: 4,
    remainingMovement: 4,
    remainingActions: { action: 1, bonus: 1, reaction: 1 },
    resources: { mana: 10, stamina: 10 },
    cooldowns: {},
    stats: { str: 3, dex: 2, int: 3, wis: 3 },
    statuses: [],
    abilities: ['basic_strike', 'fireball', 'healing_word'],
    passives: [],
    willpower: 20,
    maxWillpower: 20,
    ...overrides,
  };
}

describe('Combat-Multihog Oracle Regressions', () => {
  it('Oracle 1: skips dead units in initiative order when advancing turns and wrapping rounds', () => {
    const registry = createDefaultSkillCatalog();
    const world = createWorldState({ sessionId: 'oracle-1' });
    const hero = makeUnit({ id: 'hero', team: 'ally', coord: { x: 1, y: 1 } });
    const deadGoblin = makeUnit({
      id: 'dead_goblin',
      team: 'enemy',
      coord: { x: 2, y: 1 },
      alive: false,
      hp: 0,
    });
    const liveGoblin = makeUnit({
      id: 'live_goblin',
      team: 'enemy',
      coord: { x: 4, y: 4 },
      alive: true,
      hp: 15,
    });

    const combat: CombatState = {
      active: true,
      mode: 'tactical_grid',
      round: 1,
      turnIndex: 0,
      initiativeOrder: ['hero', 'dead_goblin', 'live_goblin'],
      grid: makeOpenGrid(),
      combatants: {
        hero,
        dead_goblin: deadGoblin,
        live_goblin: liveGoblin,
      },
      triggerCountsThisTurn: {},
    };

    // Hero finishes turn -> skips dead_goblin (index 1) and lands on live_goblin (index 2)
    const afterHero = resolveCombatTurn({
      combatState: combat,
      worldState: world,
      actorId: 'hero',
      proposedActions: [{ type: 'defend' }],
      registry,
      rng: createSeededRng('o1-a'),
    });
    expect(afterHero.nextCombatState.round).toBe(1);
    expect(afterHero.nextCombatState.turnIndex).toBe(2);

    // Live goblin kills nothing, finishes turn -> wraps around to hero (index 0) and increments round to 2
    const afterGoblin = resolveCombatTurn({
      combatState: afterHero.nextCombatState,
      worldState: world,
      actorId: 'live_goblin',
      proposedActions: [{ type: 'defend' }],
      registry,
      rng: createSeededRng('o1-b'),
    });
    expect(afterGoblin.nextCombatState.round).toBe(2);
    expect(afterGoblin.nextCombatState.turnIndex).toBe(0);
  });

  it('Oracle 2: rejects stale target hint pointing at a dead enemy and salvages via fallback to next living enemy', () => {
    const registry = createDefaultSkillCatalog();
    const world = createWorldState({ sessionId: 'oracle-2' });
    const hero = makeUnit({
      id: 'hero',
      team: 'ally',
      coord: { x: 2, y: 2 },
      speed: 4,
      abilities: ['basic_strike'],
    });
    const deadGoblin = makeUnit({
      id: 'goblin_dead',
      team: 'enemy',
      coord: { x: 3, y: 2 },
      alive: false,
      hp: 0,
    });
    const livingGoblin = makeUnit({
      id: 'goblin_alive',
      team: 'enemy',
      coord: { x: 2, y: 3 },
      alive: true,
      hp: 12,
      ac: 10,
    });

    const combat: CombatState = {
      active: true,
      mode: 'tactical_grid',
      round: 1,
      turnIndex: 0,
      initiativeOrder: ['hero', 'goblin_alive', 'goblin_dead'],
      grid: makeOpenGrid(),
      combatants: {
        hero,
        goblin_dead: deadGoblin,
        goblin_alive: livingGoblin,
      },
      triggerCountsThisTurn: {},
    };

    const check = validateSingleCombatAction(
      combat,
      'hero',
      { type: 'skill', skillId: 'basic_strike', targetId: 'goblin_dead' },
      registry
    );
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.error.some((e) => e.code === 'TARGET_DEAD')).toBe(true);
    }

    // LLM proposes stale dead target; resolver rejects and falls back to living adjacent goblin_alive
    const res = resolveCombatTurn({
      combatState: combat,
      worldState: world,
      actorId: 'hero',
      proposedActions: [{ type: 'skill', skillId: 'basic_strike', targetId: 'goblin_dead' }],
      registry,
      rng: createQueuedRng([0.85, 0.5]), // hit, 1d8->5 + str 3 = 8 dmg
    });

    expect(res.usedFallback).toBe(true);
    expect(res.rejectedReasons.some((r) => r.includes('TARGET_DEAD'))).toBe(true);
    expect(res.outcomeSummary.damageDealt['goblin_alive']).toBe(8);
    expect(res.nextCombatState.combatants['goblin_alive']?.hp).toBe(4);
    expect(res.nextCombatState.combatants['goblin_dead']?.hp).toBe(0);
  });

  it('Oracle 3: enforces 0-HP floor clamp on overkill damage and max-HP cap on healing', () => {
    const registry = createDefaultSkillCatalog();
    const world = createWorldState({ sessionId: 'oracle-3' });

    const nukeRes = registry.register({
      id: 'meteor',
      name: 'Meteor',
      category: 'spell',
      actionCost: 'action',
      resourceCosts: {},
      targeting: { shape: 'single_enemy', minRange: 1, maxRange: 6, requiresLos: false },
      hitResolution: { kind: 'auto' },
      effects: [{ type: 'damage', flat: 999 }],
    });
    expect(nukeRes.ok).toBe(true);

    const megaHealRes = registry.register({
      id: 'mega_heal',
      name: 'Mega Heal',
      category: 'spell',
      actionCost: 'bonus',
      resourceCosts: {},
      targeting: { shape: 'single_ally', minRange: 0, maxRange: 6, requiresLos: false },
      hitResolution: { kind: 'auto' },
      effects: [{ type: 'heal', flat: 500 }],
    });
    expect(megaHealRes.ok).toBe(true);

    const hero = makeUnit({
      id: 'hero',
      team: 'ally',
      hp: 15,
      maxHp: 20,
      coord: { x: 0, y: 0 },
      abilities: ['mega_heal', 'meteor'],
    });
    const ally = makeUnit({
      id: 'ally',
      team: 'ally',
      hp: 10,
      maxHp: 25,
      coord: { x: 1, y: 0 },
    });
    const goblin = makeUnit({
      id: 'goblin',
      team: 'enemy',
      hp: 5,
      maxHp: 12,
      coord: { x: 2, y: 0 },
    });

    const combat: CombatState = {
      active: true,
      mode: 'tactical_grid',
      round: 1,
      turnIndex: 0,
      initiativeOrder: ['hero', 'ally', 'goblin'],
      grid: makeOpenGrid(),
      combatants: { hero, ally, goblin },
      triggerCountsThisTurn: {},
    };

    const res = resolveCombatTurn({
      combatState: combat,
      worldState: world,
      actorId: 'hero',
      proposedActions: [
        { type: 'skill', skillId: 'mega_heal', targetId: 'ally' },
        { type: 'skill', skillId: 'meteor', targetId: 'goblin' },
      ],
      registry,
      rng: createSeededRng('o3'),
    });

    // Ally healed 10 + 500 -> capped strictly at maxHp 25
    expect(res.nextCombatState.combatants['ally']?.hp).toBe(25);
    // Goblin took 999 from 5 -> floored strictly at 0 (never negative) and marked dead
    expect(res.nextCombatState.combatants['goblin']?.hp).toBe(0);
    expect(res.nextCombatState.combatants['goblin']?.alive).toBe(false);
  });

  it('Oracle 4: enforces AoE radius damage rules and stunned actor turn skip with clean status expiry', () => {
    const registry = createDefaultSkillCatalog();
    const world = createWorldState({ sessionId: 'oracle-4' });

    const mage = makeUnit({
      id: 'mage',
      team: 'ally',
      coord: { x: 0, y: 0 },
      resources: { mana: 10 },
      stats: { str: 0, dex: 0, int: 2 },
      abilities: ['fireball'],
    });
    const allyNearBlast = makeUnit({
      id: 'ally_near',
      team: 'ally',
      coord: { x: 4, y: 1 },
      hp: 20,
      maxHp: 20,
    });
    const inRadius1 = makeUnit({
      id: 'goblin_center',
      team: 'enemy',
      coord: { x: 4, y: 0 },
      hp: 30,
      maxHp: 30,
      stats: { dex: 0 },
    });
    const inRadius2 = makeUnit({
      id: 'goblin_edge',
      team: 'enemy',
      coord: { x: 6, y: 2 }, // chebyshev distance from (4,0) is max(2, 2) = 2 <= radius 2
      hp: 30,
      maxHp: 30,
      stats: { dex: 0 },
    });
    const outOfRadius = makeUnit({
      id: 'goblin_far',
      team: 'enemy',
      coord: { x: 7, y: 0 }, // chebyshev distance from (4,0) is 3 > radius 2
      hp: 30,
      maxHp: 30,
      stats: { dex: 0 },
    });
    const deadInRadius = makeUnit({
      id: 'goblin_corpse',
      team: 'enemy',
      coord: { x: 4, y: 0 },
      alive: false,
      hp: 0,
      maxHp: 30,
    });

    const combat: CombatState = {
      active: true,
      mode: 'tactical_grid',
      round: 1,
      turnIndex: 0,
      initiativeOrder: ['mage', 'goblin_center', 'goblin_edge', 'goblin_far', 'ally_near', 'goblin_corpse'],
      grid: makeOpenGrid(),
      combatants: {
        mage,
        ally_near: allyNearBlast,
        goblin_center: inRadius1,
        goblin_edge: inRadius2,
        goblin_far: outOfRadius,
        goblin_corpse: deadInRadius,
      },
      triggerCountsThisTurn: {},
    };

    // Targets are sorted lexicographically: ['goblin_center', 'goblin_edge'].
    // goblin_center: save roll 0.1 -> 3 (<14 fail), 3d6 (0.5, 0.5, 0.5 -> 4+4+4=12) + int(2) = 14 dmg!
    // goblin_edge: save roll 0.9 -> 19 (>=14 save), 3d6 (0.5, 0.5, 0.5 -> 12) + int(2) = 14 => halved to 7 dmg!
    const rng = createQueuedRng([0.1, 0.5, 0.5, 0.5, 0.9, 0.5, 0.5, 0.5]);

    const aoeRes = resolveCombatTurn({
      combatState: combat,
      worldState: world,
      actorId: 'mage',
      proposedActions: [
        { type: 'skill', skillId: 'fireball', targetCoord: { x: 4, y: 0 } },
      ],
      registry,
      rng,
    });

    expect(aoeRes.nextCombatState.combatants['goblin_center']?.hp).toBe(16);
    expect(aoeRes.nextCombatState.combatants['goblin_center']?.statuses.some((s) => s.id === 'burning')).toBe(true);
    expect(aoeRes.nextCombatState.combatants['goblin_edge']?.hp).toBe(23);
    expect(aoeRes.nextCombatState.combatants['goblin_edge']?.statuses.some((s) => s.id === 'burning')).toBe(false);
    expect(aoeRes.nextCombatState.combatants['goblin_far']?.hp).toBe(30);
    expect(aoeRes.nextCombatState.combatants['ally_near']?.hp).toBe(20);
    expect(aoeRes.nextCombatState.combatants['goblin_corpse']?.hp).toBe(0);

    // Stunned actor turn skip test
    const stunnedCombat: CombatState = {
      ...aoeRes.nextCombatState,
      combatants: {
        ...aoeRes.nextCombatState.combatants,
        goblin_center: {
          ...aoeRes.nextCombatState.combatants['goblin_center']!,
          statuses: [
            {
              id: 'stunned',
              name: 'Stunned',
              remainingTurns: 1,
              intensity: 1,
              stackPolicy: 'refresh',
              tickTiming: 'turn_end',
              stun: true,
            },
          ],
        },
      },
    };

    const stunnedTurn = resolveCombatTurn({
      combatState: stunnedCombat,
      worldState: world,
      actorId: 'goblin_center',
      proposedActions: [{ type: 'skill', skillId: 'basic_strike', targetId: 'mage' }],
      registry,
      rng: createSeededRng('stun-skip'),
    });

    expect(stunnedTurn.outcomeSummary.executedActions).toEqual([]);
    expect(stunnedTurn.usedFallback).toBe(false);
    expect(stunnedTurn.rejectedReasons.some((r) => r.includes('ACTOR_STUNNED'))).toBe(true);
    // Turn_end tick expired the 1-turn stun after skipping the turn
    expect(
      stunnedTurn.nextCombatState.combatants['goblin_center']?.statuses.some((s) => s.id === 'stunned')
    ).toBe(false);
  });

  it('Oracle 5: stunned actor cannot execute move or skill; rooted actor cannot move but can execute skill', () => {
    const registry = createDefaultSkillCatalog();
    const grid = makeOpenGrid();

    const stunnedHero = makeUnit({
      id: 'stunned_hero',
      team: 'ally',
      coord: { x: 1, y: 1 },
      statuses: [
        {
          id: 'stunned',
          name: 'Stunned',
          remainingTurns: 1,
          intensity: 1,
          stackPolicy: 'refresh',
          tickTiming: 'turn_end',
          stun: true,
        },
      ],
    });
    const rootedHero = makeUnit({
      id: 'rooted_hero',
      team: 'ally',
      coord: { x: 2, y: 1 },
      statuses: [
        {
          id: 'rooted',
          name: 'Rooted',
          remainingTurns: 1,
          intensity: 1,
          stackPolicy: 'refresh',
          tickTiming: 'turn_end',
          root: true,
        },
      ],
    });
    const enemy = makeUnit({
      id: 'enemy',
      team: 'enemy',
      coord: { x: 3, y: 1 },
    });

    const combat: CombatState = {
      active: true,
      mode: 'tactical_grid',
      round: 1,
      turnIndex: 0,
      initiativeOrder: ['stunned_hero', 'rooted_hero', 'enemy'],
      grid,
      combatants: {
        stunned_hero: stunnedHero,
        rooted_hero: rootedHero,
        enemy,
      },
      triggerCountsThisTurn: {},
    };

    // Stunned actor cannot move
    const stunnedMove = validateSingleCombatAction(
      combat,
      'stunned_hero',
      { type: 'move', to: { x: 1, y: 2 } },
      registry
    );
    expect(stunnedMove.ok).toBe(false);
    if (!stunnedMove.ok) {
      expect(stunnedMove.error.some((e) => e.code === 'ACTOR_STUNNED')).toBe(true);
    }

    // Stunned actor cannot use skill
    const stunnedSkill = validateSingleCombatAction(
      combat,
      'stunned_hero',
      { type: 'skill', skillId: 'basic_strike', targetId: 'enemy' },
      registry
    );
    expect(stunnedSkill.ok).toBe(false);
    if (!stunnedSkill.ok) {
      expect(stunnedSkill.error.some((e) => e.code === 'ACTOR_STUNNED')).toBe(true);
    }

    // Rooted actor cannot move
    const rootedMove = validateSingleCombatAction(
      combat,
      'rooted_hero',
      { type: 'move', to: { x: 2, y: 2 } },
      registry
    );
    expect(rootedMove.ok).toBe(false);
    if (!rootedMove.ok) {
      expect(rootedMove.error.some((e) => e.code === 'ACTOR_ROOTED')).toBe(true);
    }

    // Rooted actor CAN still execute an adjacent skill
    const rootedSkill = validateSingleCombatAction(
      combat,
      'rooted_hero',
      { type: 'skill', skillId: 'basic_strike', targetId: 'enemy' },
      registry
    );
    expect(rootedSkill.ok).toBe(true);
  });
});
