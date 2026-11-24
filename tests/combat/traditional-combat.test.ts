import { describe, expect, it } from 'vitest';
import { proposePhasedTeamActions } from '../../src/agents/combat-agent.js';
import type { CombatantState } from '../../src/combat/action-validator.js';
import {
  SkillRegistry,
  type SkillDefinition,
  createDefaultSkillCatalog,
} from '../../src/combat/skill-registry.js';
import {
  buildTraditionalAftermathPatches,
  buildTraditionalEncounterParticipants,
  computeTraditionalEffectiveAc,
  resolveTraditionalCombatTurn,
  resolveTraditionalEnemyPhase,
  resolveTraditionalTargetIds,
  startTraditionalEncounter,
} from '../../src/combat/traditional-theater.js';
import { validationError } from '../../src/core/errors.js';
import { createQueuedRng, createSeededRng } from '../../src/core/prng.js';
import { err, ok } from '../../src/core/result.js';
import type { ModelGateway } from '../../src/gateway/model-gateway.js';
import type { SystemCapabilities } from '../../src/schema/tracker-module.js';
import { applyPatchBatch } from '../../src/state/reducer.js';
import { type CharacterEntity, type WorldState, createWorldState } from '../../src/state/world-state.js';

const TRADITIONAL_CAPABILITIES: SystemCapabilities = {
  spatialMode: 'emergent',
  combatMode: 'traditional',
  progression: 'rpg_levels',
  clocks: 'full_sim',
  factions: false,
  beats: false,
  relationships: false,
  chronicle: false,
};

function makeCombatant(overrides: Partial<CombatantState> & { id: string }): CombatantState {
  return {
    name: overrides.id,
    team: 'ally',
    coord: { x: 0, y: 0 },
    alive: true,
    hp: 30,
    maxHp: 30,
    ac: 12,
    speed: 30,
    remainingMovement: 0,
    remainingActions: { action: 1, bonus: 1, reaction: 1 },
    resources: { mp: 10 },
    cooldowns: {},
    stats: { str: 3, dex: 2, con: 2 },
    statuses: [],
    abilities: [],
    passives: [],
    willpower: 10,
    maxWillpower: 10,
    formationRow: 'front',
    ...overrides,
  };
}

function makeRegistry(extraSkills: readonly SkillDefinition[] = []): SkillRegistry {
  const registry = createDefaultSkillCatalog();
  for (const skill of extraSkills) {
    registry.register(skill);
  }
  return registry;
}

function makeWorldWithParty(): WorldState {
  const hero: CharacterEntity = {
    id: 'hero',
    name: 'Hero',
    status: 'active',
    presentInScene: true,
    locationId: 'loc_1',
    formId: null,
    formGroup: null,
    sections: {},
    customFields: {
      ac: 12,
      formationRow: 'front',
      equipped: {
        armor: { id: 'steel_plate', acBonus: 3, statBonuses: { str: 2 } },
      },
    },
    progression: {
      level: 2,
      xp: 100,
      className: 'warrior',
      attributes: { str: 3, dex: 1, con: 2 },
    },
    resources: {
      hp: { current: 35, max: 35 },
      mp: { current: 10, max: 10 },
      willpower: { current: 10, max: 10 },
    },
    abilities: ['power_strike'],
    goals: [],
    agenda: '',
    allegiance: 'party',
    mood: 'focused',
    traits: [],
  };

  const mage: CharacterEntity = {
    id: 'mage',
    name: 'Lyra',
    status: 'active',
    presentInScene: true,
    locationId: 'loc_1',
    formId: null,
    formGroup: null,
    sections: {},
    customFields: {
      ac: 11,
      formationRow: 'back',
    },
    progression: {
      level: 2,
      xp: 100,
      className: 'mage',
      attributes: { str: 0, dex: 2, int: 4 },
    },
    resources: {
      hp: { current: 22, max: 22 },
      mp: { current: 20, max: 20 },
      willpower: { current: 12, max: 12 },
    },
    abilities: ['arcane_bolt'],
    goals: [],
    agenda: '',
    allegiance: 'party',
    mood: 'calm',
    traits: [],
  };

  return createWorldState({
    capabilities: TRADITIONAL_CAPABILITIES,
    player: {
      id: 'player',
      name: 'Hero',
      characterId: 'hero',
      inventory: {
        items: { healing_potion: 2 },
        currency: { gold: 50 },
      },
    },
    scene: {
      location: 'Arena',
      locationId: 'loc_1',
      presentCharacterIds: ['hero', 'mage'],
    },
    entities: {
      characters: {
        hero,
        mage,
      },
    },
  });
}

describe('Traditional Theater Combat Engine (PR-8.2)', () => {
  it('supports phased turn style with arbitrary ally acting order and enemy phase batching', () => {
    const world = makeWorldWithParty();
    const registry = makeRegistry();
    const rng = createSeededRng('phased-order-seed');

    const allyA = makeCombatant({ id: 'ally_a', team: 'ally', stats: { str: 4, dex: 3 } });
    const allyB = makeCombatant({ id: 'ally_b', team: 'ally', stats: { str: 4, dex: 1 } });
    const enemy1 = makeCombatant({ id: 'enemy_1', team: 'enemy', hp: 40, maxHp: 40, ac: 10 });
    const enemy2 = makeCombatant({ id: 'enemy_2', team: 'enemy', hp: 40, maxHp: 40, ac: 10 });

    const start = startTraditionalEncounter({
      worldState: world,
      participants: [allyA, allyB, enemy1, enemy2],
      turnStyle: 'phased',
      rng,
    });

    expect(start.combatState.mode).toBe('traditional');
    expect(start.combatState.turnStyle).toBe('phased');
    expect(start.combatState.activePhase).toBe('player');
    expect(start.worldPatches).toEqual([{ op: 'clock_hold', reason: 'combat' }]);

    // Enemy cannot act during Player Phase
    const wrongPhase = resolveTraditionalCombatTurn({
      combatState: start.combatState,
      worldState: world,
      actorId: 'enemy_1',
      proposedActions: [{ type: 'defend' }],
      registry,
      rng: start.nextRng,
    });
    expect(wrongPhase.rejectedReasons.some((r) => r.startsWith('WRONG_PHASE'))).toBe(true);

    // Player chooses ally_b to act BEFORE ally_a
    const turnB = resolveTraditionalCombatTurn({
      combatState: start.combatState,
      worldState: world,
      actorId: 'ally_b',
      proposedActions: [{ type: 'skill', skillId: 'basic_strike', targetId: 'enemy_1' }],
      registry,
      rng: start.nextRng,
    });
    expect(turnB.nextCombatState.activePhase).toBe('player');
    expect(turnB.nextCombatState.actedThisPhase['ally_b']).toBe(true);

    // ally_b cannot act twice in the same Player Phase
    const doubleAct = resolveTraditionalCombatTurn({
      combatState: turnB.nextCombatState,
      worldState: world,
      actorId: 'ally_b',
      proposedActions: [{ type: 'defend' }],
      registry,
      rng: turnB.nextRng,
    });
    expect(doubleAct.rejectedReasons.some((r) => r.startsWith('ALREADY_ACTED'))).toBe(true);

    // Now ally_a acts -> transitions to Enemy Phase
    const turnA = resolveTraditionalCombatTurn({
      combatState: turnB.nextCombatState,
      worldState: world,
      actorId: 'ally_a',
      proposedActions: [{ type: 'defend' }],
      registry,
      rng: turnB.nextRng,
    });
    expect(turnA.nextCombatState.activePhase).toBe('enemy');
    expect(turnA.nextCombatState.round).toBe(1);

    // Enemy Phase executes all living enemies together and advances to Round 2 Player Phase
    const enemyPhase = resolveTraditionalEnemyPhase({
      combatState: turnA.nextCombatState,
      worldState: world,
      teamActions: {
        enemy_1: [{ type: 'defend' }],
        enemy_2: [{ type: 'skill', skillId: 'basic_strike', targetId: 'ally_a' }],
      },
      registry,
      rng: turnA.nextRng,
    });
    expect(enemyPhase.turnResults.length).toBe(2);
    expect(enemyPhase.nextCombatState.activePhase).toBe('player');
    expect(enemyPhase.nextCombatState.round).toBe(2);
  });

  it('supports strict 1d20 + mod initiative turn style', () => {
    const world = makeWorldWithParty();
    const registry = makeRegistry();
    // Queued RNG values in [0, 1): enemy_slow rolls first (0.05 -> low), ally_fast rolls second (0.95 -> high)
    const rng = createQueuedRng([0.05, 0.95, 0.5, 0.5]);

    const allyFast = makeCombatant({ id: 'ally_fast', team: 'ally', stats: { dex: 5, str: 4 } });
    const enemySlow = makeCombatant({ id: 'enemy_slow', team: 'enemy', stats: { dex: 0, str: 2 } });

    const start = startTraditionalEncounter({
      worldState: world,
      participants: [enemySlow, allyFast],
      turnStyle: 'initiative',
      rng,
    });

    expect(start.combatState.turnStyle).toBe('initiative');
    expect(start.combatState.initiativeOrder).toEqual(['ally_fast', 'enemy_slow']);
    expect(start.combatState.turnIndex).toBe(0);

    const t1 = resolveTraditionalCombatTurn({
      combatState: start.combatState,
      worldState: world,
      actorId: 'ally_fast',
      proposedActions: [{ type: 'defend' }],
      registry,
      rng: start.nextRng,
    });
    expect(t1.nextCombatState.turnIndex).toBe(1);
    expect(t1.nextCombatState.round).toBe(1);

    const t2 = resolveTraditionalCombatTurn({
      combatState: t1.nextCombatState,
      worldState: world,
      actorId: 'enemy_slow',
      proposedActions: [{ type: 'defend' }],
      registry,
      rng: t1.nextRng,
    });
    expect(t2.nextCombatState.turnIndex).toBe(0);
    expect(t2.nextCombatState.round).toBe(2);
  });

  it('enforces front-row melee interception, block mode, ignores_formation, and back-row ranged AC bonus', () => {
    const world = makeWorldWithParty();
    const rangedArrow: SkillDefinition = {
      id: 'ranged_arrow',
      name: 'Ranged Arrow',
      category: 'attack',
      actionCost: 'action',
      resourceCosts: {},
      targeting: { shape: 'single_enemy', minRange: 1, maxRange: 6, requiresLos: false },
      hitResolution: { kind: 'attack_roll', stat: 'dex' },
      effects: [{ type: 'damage', dice: '1d6', scalingStat: 'dex' }],
      tags: ['ranged'],
    };
    const shadowStepStrike: SkillDefinition = {
      id: 'shadow_step',
      name: 'Shadow Step',
      category: 'skill',
      actionCost: 'action',
      resourceCosts: {},
      targeting: { shape: 'single_enemy', minRange: 1, maxRange: 1, requiresLos: false },
      hitResolution: { kind: 'auto' },
      effects: [{ type: 'damage', flat: 8 }],
      tags: ['melee', 'ignores_formation'],
    };
    const registry = makeRegistry([rangedArrow, shadowStepStrike]);

    const attacker = makeCombatant({
      id: 'attacker',
      team: 'ally',
      abilities: ['ranged_arrow', 'shadow_step'],
      stats: { str: 5, dex: 4 },
    });
    const enemyFront = makeCombatant({
      id: 'e_front',
      team: 'enemy',
      formationRow: 'front',
      hp: 30,
      maxHp: 30,
      ac: 10,
    });
    const enemyBack = makeCombatant({
      id: 'e_back',
      team: 'enemy',
      formationRow: 'back',
      hp: 30,
      maxHp: 30,
      ac: 12,
    });

    // 1. Redirect mode (default): melee attack on e_back redirects to e_front
    const redirectStart = startTraditionalEncounter({
      worldState: world,
      participants: [attacker, enemyFront, enemyBack],
      turnStyle: 'phased',
      formationConfig: { frontRowInterceptionMode: 'redirect', backRowCoverAcBonus: 2 },
      rng: createQueuedRng([0.8, 0.5, 0.5, 0.85, 0.5]),
    });

    // Back-row unit gets +2 AC against ranged while front-row ally stands
    expect(computeTraditionalEffectiveAc(redirectStart.combatState, 'e_back', true)).toBe(14);
    expect(computeTraditionalEffectiveAc(redirectStart.combatState, 'e_back', false)).toBe(12);

    const meleeRedirect = resolveTraditionalCombatTurn({
      combatState: redirectStart.combatState,
      worldState: world,
      actorId: 'attacker',
      proposedActions: [{ type: 'skill', skillId: 'basic_strike', targetId: 'e_back' }],
      registry,
      rng: redirectStart.nextRng,
    });
    expect(meleeRedirect.interceptedTargets['e_back']).toBe('e_front');
    expect(meleeRedirect.nextCombatState.combatants['e_front']!.hp).toBeLessThan(30);
    expect(meleeRedirect.nextCombatState.combatants['e_back']!.hp).toBe(30);

    // 2. Block mode: melee attack on e_back is rejected while e_front stands
    const blockStart = startTraditionalEncounter({
      worldState: world,
      participants: [attacker, enemyFront, enemyBack],
      turnStyle: 'phased',
      formationConfig: { frontRowInterceptionMode: 'block' },
      rng: createSeededRng('block-mode'),
    });
    const basicStrike = registry.get('basic_strike')!;
    const blockedRes = resolveTraditionalTargetIds({
      combatState: blockStart.combatState,
      actorId: 'attacker',
      skill: basicStrike,
      primaryTargetId: 'e_back',
    });
    expect(blockedRes.ok).toBe(false);
    if (!blockedRes.ok) {
      expect(blockedRes.code).toBe('FRONT_ROW_GUARDED');
    }

    // 3. Ranged & ignores_formation bypass front-row guard
    const rangedRes = resolveTraditionalTargetIds({
      combatState: blockStart.combatState,
      actorId: 'attacker',
      skill: rangedArrow,
      primaryTargetId: 'e_back',
    });
    expect(rangedRes).toEqual({ ok: true, targetIds: ['e_back'] });

    const shadowRes = resolveTraditionalTargetIds({
      combatState: blockStart.combatState,
      actorId: 'attacker',
      skill: shadowStepStrike,
      primaryTargetId: 'e_back',
    });
    expect(shadowRes).toEqual({ ok: true, targetIds: ['e_back'] });
  });

  it('resolves bounded splash/aoe_radius vs all_enemies cleanly', () => {
    const world = makeWorldWithParty();
    const splashSkill: SkillDefinition = {
      id: 'cleave_splash',
      name: 'Cleave Splash',
      category: 'skill',
      actionCost: 'action',
      resourceCosts: {},
      targeting: { shape: 'splash', minRange: 1, maxRange: 3, radius: 1, requiresLos: false },
      hitResolution: { kind: 'auto' },
      effects: [{ type: 'damage', flat: 5 }],
    };
    const cappedAoeSkill: SkillDefinition = {
      id: 'capped_aoe',
      name: 'Capped AoE',
      category: 'spell',
      actionCost: 'action',
      resourceCosts: {},
      targeting: {
        shape: 'aoe_radius',
        minRange: 1,
        maxRange: 5,
        radius: 3,
        maxTargets: 3,
        requiresLos: false,
      },
      hitResolution: { kind: 'auto' },
      effects: [{ type: 'damage', flat: 4 }],
    };
    const allEnemiesSkill: SkillDefinition = {
      id: 'meteor_swarm',
      name: 'Meteor Swarm',
      category: 'spell',
      actionCost: 'action',
      resourceCosts: {},
      targeting: { shape: 'all_enemies', minRange: 1, maxRange: 10, requiresLos: false },
      hitResolution: { kind: 'auto' },
      effects: [{ type: 'damage', flat: 10 }],
    };

    const caster = makeCombatant({
      id: 'caster',
      team: 'ally',
      abilities: ['cleave_splash', 'capped_aoe', 'meteor_swarm'],
    });
    const enemies = ['e1', 'e2', 'e3', 'e4', 'e5'].map((id) =>
      makeCombatant({ id, team: 'enemy' })
    );

    const start = startTraditionalEncounter({
      worldState: world,
      participants: [caster, ...enemies],
      turnStyle: 'phased',
      rng: createSeededRng('aoe-bound'),
    });

    // Splash with radius 1 -> 1 + 1 = 2 targets, starting with primaryTargetId
    const splashTargets = resolveTraditionalTargetIds({
      combatState: start.combatState,
      actorId: 'caster',
      skill: splashSkill,
      primaryTargetId: 'e4',
    });
    expect(splashTargets).toEqual({ ok: true, targetIds: ['e4', 'e1'] });

    // aoe_radius with radius 3 (cap 4) and maxTargets 3 -> 3 targets
    const cappedTargets = resolveTraditionalTargetIds({
      combatState: start.combatState,
      actorId: 'caster',
      skill: cappedAoeSkill,
      primaryTargetId: 'e3',
    });
    expect(cappedTargets).toEqual({ ok: true, targetIds: ['e3', 'e1', 'e2'] });

    // all_enemies -> all 5 living enemies
    const allTargets = resolveTraditionalTargetIds({
      combatState: start.combatState,
      actorId: 'caster',
      skill: allEnemiesSkill,
    });
    expect(allTargets).toEqual({ ok: true, targetIds: ['e1', 'e2', 'e3', 'e4', 'e5'] });
  });

  it('handles item usage, flee, @variable scaling, crits, and willpower break', () => {
    const world = makeWorldWithParty();
    const potionSkill: SkillDefinition = {
      id: 'healing_potion',
      name: 'Healing Potion',
      category: 'item',
      actionCost: 'action',
      resourceCosts: {},
      targeting: { shape: 'self', minRange: 0, maxRange: 0, requiresLos: false },
      hitResolution: { kind: 'auto' },
      effects: [{ type: 'heal', flat: 10 }],
    };
    const variableStrike: SkillDefinition = {
      id: 'swarm_breaker',
      name: 'Swarm Breaker',
      category: 'skill',
      actionCost: 'action',
      resourceCosts: {},
      targeting: { shape: 'single_enemy', minRange: 1, maxRange: 1, requiresLos: false },
      hitResolution: { kind: 'attack_roll', stat: 'str' },
      effects: [
        {
          type: 'damage',
          dice: '1d6',
          scale: { variable: 'enemies', per: 2, min: 0, max: 10 },
        },
      ],
    };
    const registry = makeRegistry([potionSkill, variableStrike]);

    const hero = makeCombatant({
      id: 'hero',
      team: 'ally',
      hp: 15,
      maxHp: 35,
      abilities: ['swarm_breaker'],
      stats: { str: 3, dex: 2 },
    });
    const coward = makeCombatant({
      id: 'coward',
      team: 'enemy',
      hp: 30,
      maxHp: 30,
      willpower: 1,
      maxWillpower: 10,
      willpowerOutcome: 'flee',
    });

    // Roll 20 (0.99 -> crit!) then dice rolls
    const start = startTraditionalEncounter({
      worldState: world,
      participants: [hero, coward],
      turnStyle: 'phased',
      rng: createQueuedRng([0.5, 0.5, 0.99, 0.6, 0.6, 0.8]),
    });

    // Use healing_potion item
    const itemTurn = resolveTraditionalCombatTurn({
      combatState: start.combatState,
      worldState: world,
      actorId: 'hero',
      proposedActions: [{ type: 'item', itemId: 'healing_potion' }],
      registry,
      rng: start.nextRng,
    });
    expect(itemTurn.nextCombatState.combatants['hero']!.hp).toBe(25);
    expect(itemTurn.nextCombatState.expendedItems['healing_potion']).toBe(1);

    // Enemy turn: coward flees with fleeDc 0
    const fleeTurn = resolveTraditionalCombatTurn({
      combatState: itemTurn.nextCombatState,
      worldState: world,
      actorId: 'coward',
      proposedActions: [{ type: 'flee' }],
      registry,
      rng: itemTurn.nextRng,
      fleeDc: 0,
    });
    expect(fleeTurn.nextCombatState.fledIds).toContain('coward');
    expect(fleeTurn.outcomeSummary.encounterEnded).toBe(true);
    expect(fleeTurn.outcomeSummary.winnerTeam).toBe('ally');
  });

  it('builds encounter participants from WorldState and applies aftermath patches cleanly', () => {
    const world = makeWorldWithParty();
    const { participants, availableItems } = buildTraditionalEncounterParticipants(world, [
      {
        id: 'goblin_1',
        name: 'Goblin',
        maxHp: 12,
        ac: 11,
        abilities: ['basic_strike'],
        formationRow: 'front',
      },
    ]);

    expect(availableItems).toEqual({ healing_potion: 2 });
    const hero = participants.find((p) => p.id === 'hero');
    const mage = participants.find((p) => p.id === 'mage');
    const goblin = participants.find((p) => p.id === 'goblin_1');

    expect(hero).toBeDefined();
    expect(hero?.ac).toBe(15); // 12 base + 3 steel_plate
    expect(hero?.stats['str']).toBe(5); // 3 base + 2 steel_plate
    expect(hero?.formationRow).toBe('front');
    expect(mage?.formationRow).toBe('back');
    expect(goblin?.team).toBe('enemy');

    const start = startTraditionalEncounter({
      worldState: world,
      participants,
      turnStyle: 'phased',
      rng: createSeededRng('prelude-aftermath'),
    });

    const potionSkill: SkillDefinition = {
      id: 'healing_potion',
      name: 'Healing Potion',
      category: 'item',
      actionCost: 'action',
      resourceCosts: {},
      targeting: { shape: 'self', minRange: 0, maxRange: 0, requiresLos: false },
      hitResolution: { kind: 'auto' },
      effects: [{ type: 'heal', flat: 5 }],
    };
    const arcaneBolt: SkillDefinition = {
      id: 'arcane_bolt',
      name: 'Arcane Bolt',
      category: 'spell',
      actionCost: 'action',
      resourceCosts: { mp: 4 },
      targeting: { shape: 'single_enemy', minRange: 1, maxRange: 6, requiresLos: false },
      hitResolution: { kind: 'auto' },
      effects: [{ type: 'damage', flat: 20 }],
    };
    const registry = makeRegistry([potionSkill, arcaneBolt]);

    // Hero uses healing_potion, Mage defeats goblin_1
    const t1 = resolveTraditionalCombatTurn({
      combatState: start.combatState,
      worldState: world,
      actorId: 'hero',
      proposedActions: [{ type: 'item', itemId: 'healing_potion' }],
      registry,
      rng: start.nextRng,
    });

    const t2 = resolveTraditionalCombatTurn({
      combatState: t1.nextCombatState,
      worldState: world,
      actorId: 'mage',
      proposedActions: [{ type: 'skill', skillId: 'arcane_bolt', targetId: 'goblin_1' }],
      registry,
      rng: t1.nextRng,
      xpAwardOnVictory: 50,
    });

    expect(t2.outcomeSummary.encounterEnded).toBe(true);
    expect(t2.outcomeSummary.winnerTeam).toBe('ally');

    const patches = buildTraditionalAftermathPatches(
      t2.nextCombatState,
      world,
      t2.outcomeSummary,
      { xpAwardOnVictory: 50 }
    );
    expect(patches.some((p) => p.op === 'clock_release')).toBe(true);
    expect(patches.some((p) => p.op === 'set' && p.path === 'player.inventory.items.healing_potion')).toBe(true);

    const applied = applyPatchBatch(world, {
      eventId: 'aftermath_1',
      source: 'combat',
      operations: patches,
    });
    expect(applied.ok).toBe(true);
    if (applied.ok) {
      expect(applied.value.nextState.player.inventory.items['healing_potion']).toBe(1);
      expect(applied.value.nextState.entities.characters['mage']!.resources!['mp']!.current).toBe(16);
      expect(applied.value.nextState.entities.characters['hero']!.progression!.xp).toBe(150);
    }
  });

  it('proposes batched phased team actions with per-unit fallback on invalid or gateway error', async () => {
    const world = makeWorldWithParty();
    const registry = makeRegistry();
    const ally = makeCombatant({ id: 'hero', team: 'ally' });
    const orc1 = makeCombatant({ id: 'orc_1', team: 'enemy', abilities: ['basic_strike'] });
    const orc2 = makeCombatant({ id: 'orc_2', team: 'enemy', abilities: ['basic_strike'] });

    const start = startTraditionalEncounter({
      worldState: world,
      participants: [ally, orc1, orc2],
      turnStyle: 'phased',
      rng: createSeededRng('ai-batch'),
    });

    // Partial salvage: orc_1 has valid action, orc_2 has illegal skill -> orc_2 falls back
    const partialGateway: ModelGateway = {
      generateStructured: async () =>
        ok({
          data: {
            unitActions: [
              { unitId: 'orc_1', actions: [{ type: 'skill', skillId: 'basic_strike', targetId: 'hero' }] },
              { unitId: 'orc_2', actions: [{ type: 'skill', skillId: 'forbidden_nuke', targetId: 'hero' }] },
            ],
          },
          rawText: '{}',
        }),
    } as unknown as ModelGateway;

    const partialRes = await proposePhasedTeamActions({
      combatState: start.combatState,
      unitsToAct: ['orc_1', 'orc_2'],
      registry,
      gateway: partialGateway,
    });

    expect(partialRes.usedFallbackForAny).toBe(true);
    expect(partialRes.teamActions['orc_1']).toEqual([
      { type: 'skill', skillId: 'basic_strike', targetId: 'hero' },
    ]);
    expect(partialRes.unitResults.find((u) => u.unitId === 'orc_1')?.usedFallback).toBe(false);
    expect(partialRes.unitResults.find((u) => u.unitId === 'orc_2')?.usedFallback).toBe(true);
    expect(partialRes.teamActions['orc_2']!.length).toBeGreaterThan(0);

    // Gateway error -> all units fall back deterministically
    const failingGateway: ModelGateway = {
      generateStructured: async () => err([validationError('gateway', 'GATEWAY_DOWN', 'Offline')]),
    } as unknown as ModelGateway;

    const failRes = await proposePhasedTeamActions({
      combatState: start.combatState,
      unitsToAct: ['orc_1', 'orc_2'],
      registry,
      gateway: failingGateway,
    });
    expect(failRes.usedFallbackForAny).toBe(true);
    expect(failRes.unitResults.every((u) => u.usedFallback)).toBe(true);
    expect(failRes.teamActions['orc_1']!.length).toBeGreaterThan(0);
    expect(failRes.teamActions['orc_2']!.length).toBeGreaterThan(0);
  });
});
