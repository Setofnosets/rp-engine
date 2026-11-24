import { describe, expect, it } from 'vitest';
import type { CombatantState, CombatState } from '../../src/combat/action-validator.js';
import type { GridTile, TacticalGrid } from '../../src/combat/grid-types.js';
import type { PassiveDefinition } from '../../src/combat/passives-and-willpower.js';
import {
  applyCombatTransformation,
  applyTransformTempHpDamage,
  type CombatFormLoadout,
  despawnSummonsForFallenCaster,
  purgeSummonsOnEncounterEnd,
  revertAllTransformsOnEncounterEnd,
  revertCombatTransformation,
  spawnCombatSummon,
  type SummonTemplate,
  tickAndCleanupSummons,
  tickCombatTransformations,
} from '../../src/combat/summons-and-transforms.js';
import { createQueuedRng, createSeededRng } from '../../src/core/prng.js';

function makeGrid(width: number, height: number, blockedCoords: Array<{ x: number; y: number }> = []): TacticalGrid {
  const blocked = new Set(blockedCoords.map((c) => `${c.x},${c.y}`));
  const tiles: GridTile[] = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const isBlocked = blocked.has(`${x},${y}`);
      tiles.push({
        x,
        y,
        passable: !isBlocked,
        cover: isBlocked ? 'full' : 'none',
        elevation: 0,
        hazard: 'none',
        blocksLos: isBlocked,
      });
    }
  }
  return { width, height, theme: 'ruins', tiles };
}

function makeCombatant(overrides: Partial<CombatantState> & { id: string }): CombatantState {
  return {
    name: overrides.id,
    team: 'ally',
    coord: { x: 0, y: 0 },
    alive: true,
    hp: 30,
    maxHp: 30,
    ac: 14,
    speed: 6,
    remainingMovement: 6,
    remainingActions: { action: 1, bonus: 1, reaction: 1 },
    resources: { mana: 10 },
    cooldowns: {},
    stats: { str: 10, dex: 12, int: 14 },
    statuses: [],
    abilities: ['basic_strike', 'spark'],
    passives: [],
    willpower: 10,
    maxWillpower: 10,
    ...overrides,
  };
}

function makeCombatState(
  combatantsList: CombatantState[],
  options?: {
    mode?: 'tactical_grid' | 'traditional';
    grid?: TacticalGrid | null;
    initiativeOrder?: string[];
    turnIndex?: number;
  }
): CombatState {
  const combatants: Record<string, CombatantState> = {};
  for (const c of combatantsList) {
    combatants[c.id] = c;
  }
  return {
    active: true,
    mode: options?.mode ?? 'tactical_grid',
    round: 1,
    turnIndex: options?.turnIndex ?? 0,
    initiativeOrder: options?.initiativeOrder ?? combatantsList.map((c) => c.id),
    grid: options?.grid !== undefined ? options.grid : makeGrid(5, 5),
    combatants,
    triggerCountsThisTurn: {},
  };
}

const WOLF_TEMPLATE: SummonTemplate = {
  id: 'spirit_wolf',
  name: 'Spirit Wolf',
  maxHp: 18,
  ac: 13,
  speed: 8,
  stats: { str: 14, dex: 16 },
  abilities: ['bite', 'pack_howl'],
  passives: [
    {
      id: 'pack_tactics',
      name: 'Pack Tactics',
      hook: 'on_hit',
      priority: 1,
      effect: { type: 'damage', dice: '1d4' },
    },
  ],
  durationTurns: 3,
  maxActivePerCaster: 2,
  capPolicy: 'evict_oldest',
  despawnOnSummonerDefeat: true,
  initiativePolicy: 'after_summoner',
};

describe('PR-8.4: Combat Summons', () => {
  it('locates nearest unoccupied passable tile via deterministic BFS around blocked obstacles', () => {
    // Center at (2, 2) is blocked by a pillar; (2,1), (3,2), (2,3) are blocked; (1,2) is occupied by summoner.
    // Nearest open tile in ring 1 is diagonal (3,1) in BFS_DIRECTIONS order.
    const grid = makeGrid(5, 5, [
      { x: 2, y: 2 },
      { x: 2, y: 1 },
      { x: 3, y: 2 },
      { x: 2, y: 3 },
    ]);
    const summoner = makeCombatant({ id: 'caster', coord: { x: 1, y: 2 } });
    const enemy = makeCombatant({ id: 'goblin', team: 'enemy', coord: { x: 4, y: 4 } });
    const state = makeCombatState([summoner, enemy], { grid });
    const rng = createSeededRng('bfs-test');

    const res1 = spawnCombatSummon(state, 'caster', WOLF_TEMPLATE, { x: 2, y: 2 }, rng);
    const res2 = spawnCombatSummon(state, 'caster', WOLF_TEMPLATE, { x: 2, y: 2 }, rng);

    expect(res1.spawnedId).toBe('summon:caster:spirit_wolf:1');
    expect(res1.nextCombatState.combatants[res1.spawnedId!]?.coord).toEqual({ x: 3, y: 1 });
    expect(res1.nextCombatState.combatants[res1.spawnedId!]?.isSummon).toBe(true);
    expect(res1.nextCombatState.combatants[res1.spawnedId!]?.summonerId).toBe('caster');
    expect(res1.nextCombatState.combatants[res1.spawnedId!]?.summonRemainingTurns).toBe(3);

    // Determinism check
    expect(res2.spawnedId).toBe(res1.spawnedId);
    expect(res2.nextCombatState.combatants[res2.spawnedId!]?.coord).toEqual({ x: 3, y: 1 });

    // Input state remains unmutated
    expect(Object.keys(state.combatants)).toEqual(['caster', 'goblin']);
  });

  it('spawns directly on caster team in traditional mode without needing a grid', () => {
    const summoner = makeCombatant({ id: 'caster', formationRow: 'back', coord: { x: 0, y: 0 } });
    const state = makeCombatState([summoner], { mode: 'traditional', grid: null });
    const rng = createSeededRng('trad-test');

    const res = spawnCombatSummon(state, 'caster', WOLF_TEMPLATE, null, rng);
    expect(res.spawnedId).toBe('summon:caster:spirit_wolf:1');
    const spawned = res.nextCombatState.combatants[res.spawnedId!];
    expect(spawned?.team).toBe('ally');
    expect(spawned?.formationRow).toBe('back');
  });

  it('enforces maxActivePerCaster with evict_oldest and reject policies', () => {
    const summoner = makeCombatant({ id: 'caster', coord: { x: 0, y: 0 } });
    let state = makeCombatState([summoner]);
    const rng = createSeededRng('cap-test');

    const r1 = spawnCombatSummon(state, 'caster', WOLF_TEMPLATE, { x: 1, y: 0 }, rng);
    state = r1.nextCombatState;
    const r2 = spawnCombatSummon(state, 'caster', WOLF_TEMPLATE, { x: 2, y: 0 }, r1.nextRng);
    state = r2.nextCombatState;

    expect(r1.spawnedId).toBe('summon:caster:spirit_wolf:1');
    expect(r2.spawnedId).toBe('summon:caster:spirit_wolf:2');

    // 3rd spawn evicts oldest (:1)
    const r3 = spawnCombatSummon(state, 'caster', WOLF_TEMPLATE, { x: 3, y: 0 }, r2.nextRng);
    expect(r3.evictedIds).toEqual(['summon:caster:spirit_wolf:1']);
    expect(r3.spawnedId).toBe('summon:caster:spirit_wolf:3');
    expect(r3.nextCombatState.combatants['summon:caster:spirit_wolf:1']).toBeUndefined();
    expect(r3.nextCombatState.initiativeOrder).not.toContain('summon:caster:spirit_wolf:1');

    // Reject policy refuses 3rd spawn
    const rejectTemplate: SummonTemplate = { ...WOLF_TEMPLATE, capPolicy: 'reject' };
    const rReject = spawnCombatSummon(r3.nextCombatState, 'caster', rejectTemplate, { x: 4, y: 0 }, r3.nextRng);
    expect(rReject.spawnedId).toBeNull();
    expect(rReject.evictedIds).toEqual([]);
    expect(Object.keys(rReject.nextCombatState.combatants)).toHaveLength(3);
  });

  it('handles initiativePolicy after_summoner and roll deterministically', () => {
    const ally = makeCombatant({ id: 'ally1', stats: { dex: 10 }, coord: { x: 0, y: 0 } });
    const summoner = makeCombatant({ id: 'caster', stats: { dex: 12 }, coord: { x: 1, y: 0 } });
    const enemy = makeCombatant({ id: 'enemy1', team: 'enemy', stats: { dex: 8 }, coord: { x: 4, y: 4 } });

    // turnIndex points to 'caster' (index 1)
    const state = makeCombatState([ally, summoner, enemy], {
      initiativeOrder: ['ally1', 'caster', 'enemy1'],
      turnIndex: 1,
    });

    // after_summoner inserts right after caster
    const afterRes = spawnCombatSummon(state, 'caster', WOLF_TEMPLATE, { x: 2, y: 0 }, createSeededRng('init'));
    expect(afterRes.nextCombatState.initiativeOrder).toEqual([
      'ally1',
      'caster',
      'summon:caster:spirit_wolf:1',
      'enemy1',
    ]);
    expect(afterRes.nextCombatState.turnIndex).toBe(1);

    // roll policy with high queued roll (0.95 -> d20=20, + dex 16 = 36) inserts at index 0 and shifts turnIndex
    const rollTemplate: SummonTemplate = { ...WOLF_TEMPLATE, initiativePolicy: 'roll' };
    const queuedRng = createQueuedRng([0.95], 'fallback');
    const rollRes = spawnCombatSummon(state, 'caster', rollTemplate, { x: 2, y: 0 }, queuedRng);
    expect(rollRes.nextCombatState.initiativeOrder[0]).toBe('summon:caster:spirit_wolf:1');
    expect(rollRes.nextCombatState.turnIndex).toBe(2);
    expect(rollRes.nextRng.drawCount).toBe(1);
  });

  it('ticks summon durations, despawns on summoner defeat, and purges all summons on encounter end', () => {
    const caster = makeCombatant({ id: 'caster', coord: { x: 0, y: 0 } });
    const other = makeCombatant({ id: 'other', coord: { x: 0, y: 4 } });
    const state0 = makeCombatState([caster, other]);

    const s1 = spawnCombatSummon(
      state0,
      'caster',
      { ...WOLF_TEMPLATE, durationTurns: 2 },
      { x: 1, y: 0 },
      createSeededRng('tick')
    );
    const s2 = spawnCombatSummon(
      s1.nextCombatState,
      'other',
      { ...WOLF_TEMPLATE, id: 'golem', durationTurns: null },
      { x: 1, y: 4 },
      s1.nextRng
    );

    // Tick caster's summon twice -> despawns on second tick
    const t1 = tickAndCleanupSummons(s2.nextCombatState, s1.spawnedId!);
    expect(t1.despawnedIds).toEqual([]);
    expect(t1.nextCombatState.combatants[s1.spawnedId!]?.summonRemainingTurns).toBe(1);

    const t2 = tickAndCleanupSummons(t1.nextCombatState, s1.spawnedId!);
    expect(t2.despawnedIds).toEqual([s1.spawnedId!]);
    expect(t2.nextCombatState.combatants[s1.spawnedId!]).toBeUndefined();

    // Permanent summon of 'other' is unaffected by tick
    const tOther = tickAndCleanupSummons(t2.nextCombatState, s2.spawnedId!);
    expect(tOther.despawnedIds).toEqual([]);
    expect(tOther.nextCombatState.combatants[s2.spawnedId!]).toBeDefined();

    // Despawn for fallen caster removes only that caster's summons
    const s3 = spawnCombatSummon(
      tOther.nextCombatState,
      'caster',
      WOLF_TEMPLATE,
      { x: 1, y: 0 },
      s2.nextRng
    );
    const fallen = despawnSummonsForFallenCaster(s3.nextCombatState, 'caster');
    expect(fallen.despawnedIds).toEqual([s3.spawnedId!]);
    expect(fallen.nextCombatState.combatants[s2.spawnedId!]).toBeDefined();

    // Encounter end purge removes all remaining summons
    const purged = purgeSummonsOnEncounterEnd(fallen.nextCombatState);
    expect(purged.purgedIds).toEqual([s2.spawnedId!]);
    expect(Object.keys(purged.nextCombatState.combatants)).toEqual(['caster', 'other']);
    expect(purged.nextCombatState.initiativeOrder).toEqual(['caster', 'other']);
  });
});

describe('PR-8.4: Multi-Stage Transformation Loadouts', () => {
  const basePassive: PassiveDefinition = {
    id: 'keen_eye',
    name: 'Keen Eye',
    hook: 'on_hit',
    priority: 1,
    effect: { type: 'damage', dice: '1d4' },
  };

  const armorRigLoadout: CombatFormLoadout = {
    id: 'colorgarde_rig',
    displayName: 'Colorgarde Armor Rig',
    statBonuses: { str: 4, con: 2 },
    acOverride: 18,
    speedOverride: 8,
    tempHpPool: 20,
    abilities: ['photon_lance', 'spark'],
    replaceAbilities: false,
    passives: [
      {
        id: 'plated_hull',
        name: 'Plated Hull',
        hook: 'on_damaged',
        priority: 1,
        effect: { type: 'heal', dice: '1d4' },
      },
    ],
    durationTurns: 4,
    revertOnZeroTempHp: true,
    persistFormIdToWorld: 'form_colorgarde_rig',
  };

  const frogPolymorphLoadout: CombatFormLoadout = {
    id: 'polymorph_frog',
    displayName: 'Helpless Frog',
    statOverrides: { str: 1, dex: 6, int: 2 },
    acOverride: 8,
    speedOverride: 2,
    abilities: [],
    replaceAbilities: true,
    passives: [],
    durationTurns: 2,
    revertOnZeroTempHp: false,
  };

  it('applies empowerment loadout, merges abilities/passives, and emits form_transform world patch', () => {
    const hero = makeCombatant({
      id: 'hero',
      ac: 13,
      speed: 6,
      stats: { str: 10, dex: 12 },
      abilities: ['basic_strike', 'spark'],
      passives: [basePassive],
    });
    const state = makeCombatState([hero]);

    const res = applyCombatTransformation(state, 'hero', armorRigLoadout);
    expect(res.applied).toBe(true);
    expect(res.worldPatches).toEqual([
      {
        op: 'form_transform',
        characterId: 'hero',
        targetFormId: 'form_colorgarde_rig',
        triggerTag: 'combat_transform:colorgarde_rig',
      },
    ]);

    const transformed = res.nextCombatState.combatants['hero']!;
    expect(transformed.ac).toBe(18);
    expect(transformed.speed).toBe(8);
    expect(transformed.stats).toEqual({ str: 14, dex: 12, con: 2 });
    expect(transformed.abilities).toEqual(['basic_strike', 'spark', 'photon_lance']);
    expect(transformed.passives.map((p) => p.id)).toEqual(['keen_eye', 'plated_hull']);
    expect(transformed.activeTransform?.tempHp).toBe(20);
    expect(transformed.activeTransform?.remainingTurns).toBe(4);
  });

  it('supports helpless polymorph and preserves root baseline across chained transformations', () => {
    const hero = makeCombatant({
      id: 'hero',
      ac: 13,
      speed: 6,
      stats: { str: 10, dex: 12, int: 14 },
      abilities: ['basic_strike', 'spark'],
      passives: [basePassive],
    });
    const state0 = makeCombatState([hero]);

    // Stage 1: Empower into Armor Rig
    const stage1 = applyCombatTransformation(state0, 'hero', armorRigLoadout);
    // Stage 2: Enemy casts Helpless Polymorph on the transformed hero
    const stage2 = applyCombatTransformation(stage1.nextCombatState, 'hero', frogPolymorphLoadout);

    const frogHero = stage2.nextCombatState.combatants['hero']!;
    expect(frogHero.ac).toBe(8);
    expect(frogHero.speed).toBe(2);
    expect(frogHero.remainingMovement).toBe(2);
    expect(frogHero.stats).toEqual({ str: 1, dex: 6, int: 2 });
    expect(frogHero.abilities).toEqual([]);
    expect(frogHero.passives).toEqual([]);
    expect(frogHero.activeTransform?.loadoutId).toBe('polymorph_frog');
    expect(stage2.worldPatches).toEqual([]);

    // Revert restores original root baseline (NOT Stage 1 Armor Rig!)
    const reverted = revertCombatTransformation(stage2.nextCombatState, 'hero');
    expect(reverted.reverted).toBe(true);
    const restored = reverted.nextCombatState.combatants['hero']!;
    expect(restored.ac).toBe(13);
    expect(restored.speed).toBe(6);
    expect(restored.stats).toEqual({ str: 10, dex: 12, int: 14 });
    expect(restored.abilities).toEqual(['basic_strike', 'spark']);
    expect(restored.passives).toEqual([basePassive]);
    expect(restored.activeTransform).toBeUndefined();
  });

  it('auto-reverts on zero tempHp when revertOnZeroTempHp is true, on duration expiry, and on encounter end', () => {
    const hero = makeCombatant({ id: 'hero', ac: 13, speed: 6 });
    const ally = makeCombatant({ id: 'ally', ac: 12, speed: 6 });
    const state = makeCombatState([hero, ally]);

    const tHero = applyCombatTransformation(state, 'hero', armorRigLoadout);
    // Absorb partial damage (12 of 20 tempHp) -> remains transformed
    const dmg1 = applyTransformTempHpDamage(tHero.nextCombatState, 'hero', 12);
    expect(dmg1.absorbedDamage).toBe(12);
    expect(dmg1.remainingDamage).toBe(0);
    expect(dmg1.reverted).toBe(false);
    expect(dmg1.nextCombatState.combatants['hero']?.activeTransform?.tempHp).toBe(8);

    // Absorb remaining 8 tempHp + 5 overflow -> auto-reverts!
    const dmg2 = applyTransformTempHpDamage(dmg1.nextCombatState, 'hero', 13);
    expect(dmg2.absorbedDamage).toBe(8);
    expect(dmg2.remainingDamage).toBe(5);
    expect(dmg2.reverted).toBe(true);
    expect(dmg2.nextCombatState.combatants['hero']?.activeTransform).toBeUndefined();
    expect(dmg2.nextCombatState.combatants['hero']?.ac).toBe(13);

    // Duration expiry auto-revert
    const tAlly = applyCombatTransformation(dmg2.nextCombatState, 'ally', {
      ...frogPolymorphLoadout,
      durationTurns: 2,
    });
    const tick1 = tickCombatTransformations(tAlly.nextCombatState, 'ally');
    expect(tick1.revertedIds).toEqual([]);
    const tick2 = tickCombatTransformations(tick1.nextCombatState, 'ally');
    expect(tick2.revertedIds).toEqual(['ally']);
    expect(tick2.nextCombatState.combatants['ally']?.activeTransform).toBeUndefined();
    expect(tick2.nextCombatState.combatants['ally']?.ac).toBe(12);

    // Encounter end reverts all remaining transforms
    const tBoth = applyCombatTransformation(tick2.nextCombatState, 'hero', armorRigLoadout);
    const endRes = revertAllTransformsOnEncounterEnd(tBoth.nextCombatState);
    expect(endRes.revertedIds).toEqual(['hero']);
    expect(endRes.nextCombatState.combatants['hero']?.activeTransform).toBeUndefined();
    expect(endRes.nextCombatState.combatants['hero']?.ac).toBe(13);
  });

  it('normalizes -0 and blocks prototype-pollution keys in stats', () => {
    const hero = makeCombatant({ id: 'hero', stats: { str: -0 } });
    const state = makeCombatState([hero]);
    const maliciousOverrides = JSON.parse('{"__proto__": {"polluted": true}, "str": -0}') as Record<string, number>;

    const res = applyCombatTransformation(state, 'hero', {
      id: 'safe_form',
      displayName: 'Safe Form',
      statOverrides: maliciousOverrides,
      abilities: [],
      replaceAbilities: false,
      durationTurns: null,
    });

    const heroAfter = res.nextCombatState.combatants['hero']!;
    expect(Object.is(heroAfter.stats['str'], 0)).toBe(true);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});
