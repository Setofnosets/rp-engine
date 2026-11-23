import { describe, expect, it } from 'vitest';
import {
  type CombatState,
  type CombatantState,
  validateSingleCombatAction,
} from '../../src/combat/action-validator.js';
import {
  resolveCombatTurn,
  startCombatEncounter,
} from '../../src/combat/combat-resolver.js';
import { computeFallbackActions } from '../../src/combat/fallback-tactics.js';
import type { GridTile, TacticalGrid } from '../../src/combat/grid-types.js';
import { createDefaultSkillCatalog } from '../../src/combat/skill-registry.js';
import { createQueuedRng, createSeededRng } from '../../src/core/prng.js';
import type { SystemCapabilities } from '../../src/schema/tracker-module.js';
import { applyPatchBatch } from '../../src/state/reducer.js';
import { type CharacterEntity, type WorldState, createWorldState } from '../../src/state/world-state.js';

const TACTICAL_CAPABILITIES: SystemCapabilities = {
  spatialMode: 'emergent',
  combatMode: 'tactical_grid',
  progression: 'rpg_levels',
  clocks: 'full_sim',
  factions: false,
  beats: false,
  relationships: false,
  chronicle: false,
};

function makeOpenGrid(width = 8, height = 6): TacticalGrid {
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
    abilities: ['basic_strike', 'fireball', 'power_strike'],
    passives: [],
    willpower: 20,
    maxWillpower: 20,
    ...overrides,
  };
}

function makeCharacter(overrides: Partial<CharacterEntity> & { id: string }): CharacterEntity {
  return {
    name: overrides.id,
    status: 'active',
    presentInScene: true,
    locationId: 'arena',
    formId: null,
    formGroup: null,
    sections: {},
    customFields: {},
    progression: {
      level: 1,
      xp: 0,
      className: 'warrior',
    },
    resources: {
      hp: { current: 30, max: 30 },
    },
    abilities: ['basic_strike'],
    goals: [],
    agenda: '',
    allegiance: 'party',
    mood: 'focused',
    traits: [],
    ...overrides,
  };
}

function makeTestWorld(characters: Record<string, CharacterEntity> = {}): WorldState {
  return createWorldState({
    sessionId: 'combat-test-session',
    capabilities: TACTICAL_CAPABILITIES,
    characters,
  });
}

describe('PR-3.3: Action Validator, Partial-Prefix Salvage, Fallback AI & Traditional Mode', () => {
  it('validates partial-prefix salvage: keeps valid 2-tile move and runs deterministic fallback basic_strike when spell fails for lack of mana', () => {
    const registry = createDefaultSkillCatalog();
    const grid = makeOpenGrid(8, 6);
    const hero = makeCombatant({
      id: 'hero',
      team: 'ally',
      coord: { x: 0, y: 0 },
      speed: 4,
      remainingMovement: 4,
      resources: { mana: 1 }, // fireball requires mana: 5
      abilities: ['basic_strike', 'fireball'],
    });
    const goblin = makeCombatant({
      id: 'goblin',
      team: 'enemy',
      coord: { x: 3, y: 0 },
      hp: 15,
      maxHp: 15,
      ac: 10,
      abilities: ['basic_strike'],
    });

    const combatState: CombatState = {
      active: true,
      mode: 'tactical_grid',
      round: 1,
      turnIndex: 0,
      initiativeOrder: ['hero', 'goblin'],
      grid,
      combatants: { hero, goblin },
      triggerCountsThisTurn: {},
    };
    const worldState = makeTestWorld({
      hero: makeCharacter({ id: 'hero' }),
      goblin: makeCharacter({
        id: 'goblin',
        resources: { hp: { current: 15, max: 15 } },
      }),
    });

    // Queue rolls: 1d20 -> high roll (0.8 => 17 + str 3 >= AC 10), 1d8 -> 0.5 => 5 + str 3 = 8 damage
    const rng = createQueuedRng([0.8, 0.5]);

    const result = resolveCombatTurn({
      combatState,
      worldState,
      actorId: 'hero',
      proposedActions: [
        { type: 'move', to: { x: 2, y: 0 } }, // valid 2-tile move adjacent to goblin at (3,0)
        { type: 'skill', skillId: 'fireball', targetId: 'goblin', targetCoord: { x: 3, y: 0 } }, // illegal: out of mana
      ],
      registry,
      rng,
    });

    // Input combatState must not be mutated
    expect(combatState.combatants['hero']?.coord).toEqual({ x: 0, y: 0 });
    expect(combatState.combatants['goblin']?.hp).toBe(15);

    // Move prefix was salvaged and committed
    expect(result.nextCombatState.combatants['hero']?.coord).toEqual({ x: 2, y: 0 });
    expect(result.salvagedCount).toBe(1);
    expect(result.outcomeSummary.salvagedPrefixCount).toBe(1);
    expect(result.usedFallback).toBe(true);
    expect(result.rejectedReasons.some((r) => r.includes('INSUFFICIENT_RESOURCE'))).toBe(true);

    // Fallback attacked goblin with basic_strike from the salvaged tile (2,0)
    expect(result.outcomeSummary.executedActions).toEqual(['move:2,0', 'skill:basic_strike']);
    expect(result.outcomeSummary.damageDealt['goblin']).toBe(8);
    expect(result.nextCombatState.combatants['goblin']?.hp).toBe(7);
  });

  it('salvages valid move and falls back to defend when enemy remains out of range', () => {
    const registry = createDefaultSkillCatalog();
    const grid = makeOpenGrid(12, 6);
    const hero = makeCombatant({
      id: 'hero',
      team: 'ally',
      coord: { x: 0, y: 0 },
      speed: 2,
      remainingMovement: 2,
      resources: { mana: 0 },
      abilities: ['basic_strike', 'fireball'],
    });
    const farGoblin = makeCombatant({
      id: 'goblin',
      team: 'enemy',
      coord: { x: 10, y: 0 },
      hp: 15,
      maxHp: 15,
    });

    const combatState: CombatState = {
      active: true,
      mode: 'tactical_grid',
      round: 1,
      turnIndex: 0,
      initiativeOrder: ['hero', 'goblin'],
      grid,
      combatants: { hero, goblin: farGoblin },
      triggerCountsThisTurn: {},
    };
    const worldState = makeTestWorld();

    const result = resolveCombatTurn({
      combatState,
      worldState,
      actorId: 'hero',
      proposedActions: [
        { type: 'move', to: { x: 2, y: 0 } },
        { type: 'skill', skillId: 'fireball', targetId: 'goblin', targetCoord: { x: 10, y: 0 } },
      ],
      registry,
      rng: createSeededRng('salvage-defend'),
    });

    expect(result.salvagedCount).toBe(1);
    expect(result.usedFallback).toBe(true);
    expect(result.nextCombatState.combatants['hero']?.coord).toEqual({ x: 2, y: 0 });
    expect(result.outcomeSummary.executedActions).toEqual(['move:2,0', 'defend']);
    expect(result.nextCombatState.combatants['hero']?.statuses.some((s) => s.id === 'guarded')).toBe(
      true
    );
  });

  it('rejects blocked/occupied movement paths, non-adjacent steps, cooldowns, and enforces cover AC bonuses', () => {
    const registry = createDefaultSkillCatalog();
    const grid = makeOpenGrid(6, 6);
    // Put an obstacle wall at (1, 1) and half cover at (2, 0)
    const wallTile = grid.tiles[1 * 6 + 1];
    if (wallTile) {
      wallTile.passable = false;
      wallTile.blocksLos = true;
      wallTile.cover = 'full';
    }
    const coverTile = grid.tiles[0 * 6 + 2];
    if (coverTile) {
      coverTile.cover = 'half';
    }

    const hero = makeCombatant({
      id: 'hero',
      team: 'ally',
      coord: { x: 0, y: 0 },
      cooldowns: { power_strike: 1 },
      stats: { str: 0 },
    });
    const enemyBehindCover = makeCombatant({
      id: 'enemy',
      team: 'enemy',
      coord: { x: 3, y: 0 },
      ac: 14,
      hp: 20,
      maxHp: 20,
    });

    const combat: CombatState = {
      active: true,
      mode: 'tactical_grid',
      round: 1,
      turnIndex: 0,
      initiativeOrder: ['hero', 'enemy'],
      grid,
      combatants: { hero, enemy: enemyBehindCover },
      triggerCountsThisTurn: {},
    };

    // Non-adjacent step rejected
    const nonAdj = validateSingleCombatAction(
      combat,
      'hero',
      { type: 'move', path: [{ x: 0, y: 0 }, { x: 2, y: 0 }] },
      registry
    );
    expect(nonAdj.ok).toBe(false);
    if (!nonAdj.ok) {
      expect(nonAdj.error.some((e) => e.code === 'NON_ADJACENT_STEP')).toBe(true);
    }

    // Obstacle tile rejected
    const obstacleMove = validateSingleCombatAction(
      combat,
      'hero',
      { type: 'move', path: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
      registry
    );
    expect(obstacleMove.ok).toBe(false);
    if (!obstacleMove.ok) {
      expect(obstacleMove.error.some((e) => e.code === 'IMPASSABLE_TILE')).toBe(true);
    }

    // Occupied tile rejected
    const occupiedMove = validateSingleCombatAction(
      combat,
      'hero',
      { type: 'move', to: { x: 3, y: 0 } },
      registry
    );
    expect(occupiedMove.ok).toBe(false);
    if (!occupiedMove.ok) {
      expect(occupiedMove.error.some((e) => e.code === 'OCCUPIED_TILE')).toBe(true);
    }

    // Cooldown rejected
    const cdSkill = validateSingleCombatAction(
      combat,
      'hero',
      { type: 'skill', skillId: 'power_strike', targetId: 'enemy' },
      registry
    );
    expect(cdSkill.ok).toBe(false);
    if (!cdSkill.ok) {
      expect(cdSkill.error.some((e) => e.code === 'SKILL_ON_COOLDOWN')).toBe(true);
    }

    // Cover bonus (+2 AC for half cover): enemy AC 14 + 2 = 16; roll of 15 misses!
    const rangedRes = registry.register({
      id: 'bow_shot',
      name: 'Bow Shot',
      category: 'attack',
      actionCost: 'action',
      resourceCosts: {},
      targeting: { shape: 'single_enemy', minRange: 1, maxRange: 6, requiresLos: true },
      hitResolution: { kind: 'attack_roll', stat: 'str' },
      effects: [{ type: 'damage', dice: '1d8' }],
    });
    expect(rangedRes.ok).toBe(true);
    hero.abilities.push('bow_shot');

    // 1d20 roll = 15 (0.7 => floor(0.7 * 20) + 1 = 15). Without cover 15 >= 14 hits; with half cover 15 < 16 misses!
    const coverMissTurn = resolveCombatTurn({
      combatState: combat,
      worldState: makeTestWorld(),
      actorId: 'hero',
      proposedActions: [{ type: 'skill', skillId: 'bow_shot', targetId: 'enemy' }],
      registry,
      rng: createQueuedRng([0.7]),
    });
    expect(coverMissTurn.nextCombatState.combatants['enemy']?.hp).toBe(20);
  });

  it('supports traditional (gridless) combat mode end-to-end with fallback AI and victory resolution', () => {
    const registry = createDefaultSkillCatalog();
    const world0 = makeTestWorld({
      hero: makeCharacter({
        id: 'hero',
        resources: { hp: { current: 25, max: 25 } },
      }),
      bandit: makeCharacter({
        id: 'bandit',
        resources: { hp: { current: 8, max: 8 } },
      }),
    });

    const hero = makeCombatant({
      id: 'hero',
      team: 'ally',
      hp: 25,
      maxHp: 25,
      stats: { str: 4, dex: 3, initiative: 10 },
      abilities: ['basic_strike', 'power_strike'],
    });
    const bandit = makeCombatant({
      id: 'bandit',
      team: 'enemy',
      hp: 8,
      maxHp: 8,
      ac: 10,
      stats: { str: 1, dex: 1, initiative: 0 },
      abilities: ['basic_strike'],
    });

    const started = startCombatEncounter({
      worldState: world0,
      participants: [hero, bandit],
      mode: 'traditional',
      rng: createSeededRng('trad-mode'),
    });

    expect(started.combatState.mode).toBe('traditional');
    expect(started.combatState.grid).toBeNull();
    expect(started.combatState.active).toBe(true);
    expect(started.worldPatches).toEqual([{ op: 'clock_hold', reason: 'combat' }]);

    // Apply clock_hold patch to world state
    const heldRes = applyPatchBatch(world0, {
      eventId: 'start-combat',
      source: 'combat',
      operations: started.worldPatches,
    });
    expect(heldRes.ok).toBe(true);
    if (!heldRes.ok) return;
    expect(heldRes.value.nextState.clocks.held).toBe(true);
    expect(heldRes.value.nextState.clocks.holdReason).toBe('combat');

    // Traditional mode fallback actions pick best affordable attack skill
    const fb = computeFallbackActions(started.combatState, 'hero', registry);
    expect(fb).toEqual([{ type: 'skill', skillId: 'power_strike', targetId: 'bandit' }]);

    // Proposing illegal 'move' in traditional mode triggers fallback strike and wins encounter
    const rng = createQueuedRng([0.9, 0.7, 0.7]); // d20=19 (hit), 2d8 => 6+6+2+str(4)=18 dmg
    const turnRes = resolveCombatTurn({
      combatState: started.combatState,
      worldState: heldRes.value.nextState,
      actorId: 'hero',
      proposedActions: [{ type: 'move', to: { x: 1, y: 1 } }],
      registry,
      rng,
      xpAwardOnVictory: 150,
    });

    expect(turnRes.usedFallback).toBe(true);
    expect(turnRes.rejectedReasons.some((r) => r.includes('MOVE_UNAVAILABLE_IN_TRADITIONAL'))).toBe(
      true
    );
    expect(turnRes.nextCombatState.active).toBe(false);
    expect(turnRes.outcomeSummary.encounterEnded).toBe(true);
    expect(turnRes.outcomeSummary.winnerTeam).toBe('ally');
    expect(turnRes.nextCombatState.combatants['bandit']?.alive).toBe(false);
    expect(turnRes.nextCombatState.combatants['bandit']?.hp).toBe(0);

    // Apply end-of-turn worldPatches and verify clock_release, dead status, XP level-up, and combatOutcomes
    const endRes = applyPatchBatch(heldRes.value.nextState, {
      eventId: 'end-combat',
      source: 'combat',
      operations: turnRes.worldPatches,
    });
    expect(endRes.ok).toBe(true);
    if (!endRes.ok) return;

    const finalWorld = endRes.value.nextState;
    expect(finalWorld.clocks.held).toBe(false);
    expect(finalWorld.clocks.holdReason).toBeNull();
    expect(finalWorld.entities.characters['bandit']?.status).toBe('dead');
    expect(finalWorld.entities.characters['bandit']?.resources?.['hp']?.current).toBe(0);
    expect(finalWorld.entities.characters['hero']?.progression?.xp).toBe(150);
    expect(finalWorld.entities.characters['hero']?.progression?.level).toBe(2);
    expect(finalWorld.turnEvents.combatOutcomes).toHaveLength(1);
    expect(finalWorld.turnEvents.combatOutcomes[0]).toContain('winner=ally');
  });

  it('integrates startCombatEncounter clock_hold, tactical deployment, passives recursion guard, and character HP sync', () => {
    const registry = createDefaultSkillCatalog();
    const world0 = makeTestWorld({
      hero: makeCharacter({
        id: 'hero',
        resources: { hp: { current: 30, max: 30 } },
      }),
      orc: makeCharacter({
        id: 'orc',
        resources: { hp: { current: 20, max: 20 } },
      }),
    });

    const hero = makeCombatant({
      id: 'hero',
      team: 'ally',
      hp: 30,
      maxHp: 30,
      ac: 10,
      speed: 8,
      stats: { str: 3, dex: 2 },
      passives: [
        {
          id: 'thorns_aura',
          name: 'Thorns Aura',
          hook: 'on_damaged',
          priority: 10,
          effect: { type: 'damage', flat: 2 },
        },
      ],
    });
    const orc = makeCombatant({
      id: 'orc',
      team: 'enemy',
      hp: 20,
      maxHp: 20,
      ac: 10,
      speed: 8,
      stats: { str: 2, dex: 1 },
      passives: [
        {
          id: 'counter_spike',
          name: 'Counter Spike',
          hook: 'on_damaged',
          priority: 10,
          effect: { type: 'damage', flat: 3 },
        },
      ],
    });

    const started = startCombatEncounter({
      worldState: world0,
      participants: [hero, orc],
      mode: 'tactical_grid',
      theme: 'open',
      gridSize: { width: 8, height: 6 },
      rng: createSeededRng('clock-hold-grid'),
    });

    expect(started.combatState.grid).not.toBeNull();
    expect(started.combatState.combatants['hero']?.coord.x).toBeLessThanOrEqual(1);
    expect(started.combatState.combatants['orc']?.coord.x).toBeGreaterThanOrEqual(6);
    expect(started.worldPatches).toEqual([{ op: 'clock_hold', reason: 'combat' }]);

    // Place hero adjacent to orc to test bounded reactive passive chain (depth <= 2)
    const testCombat = {
      ...started.combatState,
      combatants: {
        ...started.combatState.combatants,
        hero: { ...started.combatState.combatants['hero']!, coord: { x: 2, y: 2 } },
        orc: { ...started.combatState.combatants['orc']!, coord: { x: 3, y: 2 } },
      },
    };

    const turnRes = resolveCombatTurn({
      combatState: testCombat,
      worldState: world0,
      actorId: 'hero',
      proposedActions: [{ type: 'skill', skillId: 'basic_strike', targetId: 'orc' }],
      registry,
      rng: createQueuedRng([0.8, 0.5]), // hit, 1d8->5 + 3 str = 8 dmg
    });

    // Depth 0: orc on_damaged deals 3 to hero (hero 30 -> 27)
    // Depth 1: hero on_damaged deals 2 to orc (orc 20 - 8 - 2 = 10)
    // Depth 2: orc on_damaged deals 3 to hero (hero 27 -> 24)
    // Depth 3: blocked by maxRecursionDepth (2)!
    expect(turnRes.nextCombatState.combatants['orc']?.hp).toBe(10);
    expect(turnRes.nextCombatState.combatants['hero']?.hp).toBe(24);

    const patched = applyPatchBatch(world0, {
      eventId: 'sync-hp',
      source: 'combat',
      operations: turnRes.worldPatches,
    });
    expect(patched.ok).toBe(true);
    if (patched.ok) {
      expect(patched.value.nextState.entities.characters['orc']?.resources?.['hp']?.current).toBe(10);
      expect(patched.value.nextState.entities.characters['hero']?.resources?.['hp']?.current).toBe(24);
    }
  });

  it('guards against prototype pollution keys cleanly', () => {
    const registry = createDefaultSkillCatalog();
    const combat: CombatState = {
      active: true,
      mode: 'traditional',
      round: 1,
      turnIndex: 0,
      initiativeOrder: ['hero'],
      grid: null,
      combatants: {
        hero: makeCombatant({ id: 'hero' }),
      },
      triggerCountsThisTurn: {},
    };

    const badActor = validateSingleCombatAction(combat, '__proto__', { type: 'defend' }, registry);
    expect(badActor.ok).toBe(false);

    const badSkill = validateSingleCombatAction(
      combat,
      'hero',
      { type: 'skill', skillId: 'constructor', targetId: 'hero' },
      registry
    );
    expect(badSkill.ok).toBe(false);
  });

  it('tracks cooldown decay across turns, handles bonus action + salvage, and guarantees strict seed determinism', () => {
    const registry = createDefaultSkillCatalog();
    const worldNoXp = createWorldState({
      sessionId: 'determinism-check',
      capabilities: {
        ...TACTICAL_CAPABILITIES,
        progression: 'disabled',
      },
      characters: {
        hero: makeCharacter({ id: 'hero', resources: { hp: { current: 30, max: 30 } } }),
      },
    });

    const hero = makeCombatant({
      id: 'hero',
      team: 'ally',
      hp: 18,
      maxHp: 30,
      coord: { x: 1, y: 1 },
      resources: { mana: 10, stamina: 10 },
      abilities: ['minor_healing_potion', 'power_strike', 'fireball'],
    });
    const enemy = makeCombatant({
      id: 'enemy',
      team: 'enemy',
      hp: 30,
      maxHp: 30,
      ac: 10,
      coord: { x: 2, y: 1 },
    });

    const initialCombat: CombatState = {
      active: true,
      mode: 'tactical_grid',
      round: 1,
      turnIndex: 0,
      initiativeOrder: ['hero', 'enemy'],
      grid: makeOpenGrid(6, 6),
      combatants: { hero, enemy },
      triggerCountsThisTurn: {},
    };

    // Bonus potion heals + power_strike triggers cooldown 1
    const runTurn = (): ReturnType<typeof resolveCombatTurn> =>
      resolveCombatTurn({
        combatState: initialCombat,
        worldState: worldNoXp,
        actorId: 'hero',
        proposedActions: [
          { type: 'skill', skillId: 'minor_healing_potion' },
          { type: 'skill', skillId: 'power_strike', targetId: 'enemy' },
        ],
        registry,
        rng: createSeededRng('deterministic-seed'),
        xpAwardOnVictory: 200,
      });

    const runA = runTurn();
    const runB = runTurn();
    expect(runA).toEqual(runB);
    expect(runA.nextCombatState.combatants['hero']?.cooldowns['power_strike']).toBe(1);
    expect(runA.nextCombatState.combatants['hero']?.hp).toBeGreaterThan(18);

    // Next hero turn: power_strike is still on cooldown -> rejected & salvaged via fallback basic_strike;
    // then cooldown decays from 1 -> 0 at end of turn!
    const turn2 = resolveCombatTurn({
      combatState: runA.nextCombatState,
      worldState: worldNoXp,
      actorId: 'hero',
      proposedActions: [{ type: 'skill', skillId: 'power_strike', targetId: 'enemy' }],
      registry,
      rng: runA.nextRng,
      xpAwardOnVictory: 200,
    });
    expect(turn2.usedFallback).toBe(true);
    expect(turn2.rejectedReasons.some((r) => r.includes('SKILL_ON_COOLDOWN'))).toBe(true);
    expect(turn2.nextCombatState.combatants['hero']?.cooldowns['power_strike']).toBe(0);

    // Verify no XP patches were emitted when progression is disabled
    expect(turn2.worldPatches.some((p) => p.op === 'set' && p.path.includes('.progression.'))).toBe(
      false
    );
  });
});
