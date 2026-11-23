import { describe, expect, it } from 'vitest';
import { runCastDirector } from '../../src/agents/cast-director-agent.js';
import { runChronicleRouter } from '../../src/agents/chronicle-router-agent.js';
import { proposeNpcCombatActions } from '../../src/agents/combat-agent.js';
import { parsePlayerIntent } from '../../src/agents/intent-parser.js';
import { runStorylinePlanner } from '../../src/agents/storyline-agent.js';
import { type BeatDefinition, createInitialBeatLedger } from '../../src/beats/beat-ledger.js';
import type { CombatState, CombatantState } from '../../src/combat/action-validator.js';
import { resolveCombatTurn } from '../../src/combat/combat-resolver.js';
import type { GridTile, TacticalGrid } from '../../src/combat/grid-types.js';
import { createDefaultSkillCatalog } from '../../src/combat/skill-registry.js';
import { resolveEffectiveControlRoomConfig } from '../../src/config/control-room-config.js';
import { createSeededRng } from '../../src/core/prng.js';
import { createMockModelGateway } from '../../src/gateway/mock-provider.js';
import { STOCK_TACTICAL_RPG_PACK } from '../../src/schema/stock-system-packs.js';
import type { SystemCapabilities } from '../../src/schema/tracker-module.js';
import type { FormDefinition } from '../../src/state/forms.js';
import { applyPatchBatch } from '../../src/state/reducer.js';
import type { LocationEntity } from '../../src/state/spatial-topology.js';
import {
  type CharacterEntity,
  type FactionEntity,
  type ThreatEntity,
  createWorldState,
} from '../../src/state/world-state.js';

function makeCapabilities(overrides: Partial<SystemCapabilities> = {}): SystemCapabilities {
  return {
    spatialMode: 'scene_only',
    combatMode: 'disabled',
    progression: 'disabled',
    clocks: 'disabled',
    factions: false,
    beats: false,
    relationships: false,
    chronicle: false,
    ...overrides,
  };
}

function makeLocation(overrides: Partial<LocationEntity> & { id: string }): LocationEntity {
  return {
    name: overrides.id,
    kind: 'zone',
    status: 'normal',
    controllingFactionId: null,
    connectedLocations: [],
    discovered: true,
    tags: [],
    notes: '',
    ...overrides,
  };
}

function makeCharacter(overrides: Partial<CharacterEntity> & { id: string }): CharacterEntity {
  return {
    name: overrides.id,
    status: 'active',
    presentInScene: true,
    locationId: null,
    formId: null,
    formGroup: null,
    sections: {},
    customFields: {},
    abilities: [],
    goals: [],
    agenda: '',
    allegiance: 'neutral',
    mood: 'neutral',
    traits: [],
    ...overrides,
  };
}

function makeFaction(overrides: Partial<FactionEntity> & { id: string }): FactionEntity {
  return {
    name: overrides.id,
    side: 'neutral',
    status: 'active',
    influence: 50,
    headquartersLocationId: null,
    goals: [],
    ...overrides,
  };
}

function makeThreat(overrides: Partial<ThreatEntity> & { id: string }): ThreatEntity {
  return {
    name: overrides.id,
    rank: 'main',
    status: 'active',
    stage: 0,
    progress: 0,
    locationId: null,
    sourceFactionId: null,
    agenda: '',
    ...overrides,
  };
}

function makeOpenGrid(width = 6, height = 6): TacticalGrid {
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
    abilities: ['basic_strike', 'power_strike'],
    passives: [],
    willpower: 20,
    maxWillpower: 20,
    ...overrides,
  };
}

describe('parsePlayerIntent', () => {
  it('parses all deterministic slash commands without making any LLM calls', async () => {
    const state = createWorldState();
    const gateway = createMockModelGateway();

    const travel = await parsePlayerIntent({
      input: '/travel central_plaza',
      state,
      inCombat: false,
      gateway,
      availableLocationIds: ['central_plaza'],
    });
    expect(travel.usedLlm).toBe(false);
    expect(travel.warnings).toEqual([]);
    expect(travel.intent).toEqual({
      kind: 'command',
      command: 'travel',
      args: { locationId: 'central_plaza' },
      rawText: '/travel central_plaza',
    });

    const rest = await parsePlayerIntent({ input: '/rest', state, inCombat: false, gateway });
    expect(rest.intent).toEqual({ kind: 'command', command: 'rest', args: {}, rawText: '/rest' });

    const hold = await parsePlayerIntent({ input: '/hold-clock', state, inCombat: false, gateway });
    expect(hold.intent).toEqual({
      kind: 'command',
      command: 'hold_clock',
      args: {},
      rawText: '/hold-clock',
    });

    const release = await parsePlayerIntent({
      input: '/release-clock',
      state,
      inCombat: false,
      gateway,
    });
    expect(release.intent).toEqual({
      kind: 'command',
      command: 'release_clock',
      args: {},
      rawText: '/release-clock',
    });

    const playAs = await parsePlayerIntent({
      input: '/play-as hero_2',
      state,
      inCombat: false,
      gateway,
    });
    expect(playAs.intent).toEqual({
      kind: 'command',
      command: 'play_as',
      args: { characterId: 'hero_2' },
      rawText: '/play-as hero_2',
    });

    const move = await parsePlayerIntent({ input: '/move 3,4', state, inCombat: true, gateway });
    expect(move.intent).toEqual({
      kind: 'command',
      command: 'move',
      args: { x: 3, y: 4 },
      rawText: '/move 3,4',
    });

    const attack = await parsePlayerIntent({
      input: '/attack goblin_1',
      state,
      inCombat: true,
      gateway,
    });
    expect(attack.intent).toEqual({
      kind: 'command',
      command: 'attack',
      args: { targetId: 'goblin_1' },
      rawText: '/attack goblin_1',
    });

    const skill = await parsePlayerIntent({
      input: '/skill fireball goblin_1',
      state,
      inCombat: true,
      gateway,
      availableSkillIds: ['fireball'],
    });
    expect(skill.intent).toEqual({
      kind: 'command',
      command: 'skill',
      args: { skillId: 'fireball', targetId: 'goblin_1' },
      rawText: '/skill fireball goblin_1',
    });

    const defend = await parsePlayerIntent({ input: '/defend', state, inCombat: true, gateway });
    expect(defend.intent).toEqual({
      kind: 'command',
      command: 'defend',
      args: {},
      rawText: '/defend',
    });

    const endTurn = await parsePlayerIntent({
      input: '/end-turn',
      state,
      inCombat: true,
      gateway,
    });
    expect(endTurn.intent).toEqual({
      kind: 'command',
      command: 'end_turn',
      args: {},
      rawText: '/end-turn',
    });

    expect(gateway.mockProvider.recordedCalls).toHaveLength(0);
  });

  it('uses LLM fallback in combat when enabled and degrades cleanly on malformed output', async () => {
    const state = createWorldState();
    const okGateway = createMockModelGateway({
      intent_parser: {
        kind: 'json',
        value: {
          actions: [
            { type: 'move', to: { x: 2, y: 1 } },
            { type: 'skill', skillId: 'power_strike', targetId: 'raider_1' },
            { type: 'skill', skillId: 'hallucinated_nuke', targetId: 'raider_1' },
          ],
        },
      },
    });

    const parsed = await parsePlayerIntent({
      input: 'I rush forward and slam the raider!',
      state,
      inCombat: true,
      gateway: okGateway,
      allowLlmFallback: true,
      availableSkillIds: ['basic_strike', 'power_strike'],
    });
    expect(parsed.usedLlm).toBe(true);
    expect(parsed.intent).toEqual({
      kind: 'combat_actions',
      actions: [
        { type: 'move', to: { x: 2, y: 1 } },
        { type: 'skill', skillId: 'power_strike', targetId: 'raider_1' },
      ],
      rawText: 'I rush forward and slam the raider!',
    });
    expect(parsed.warnings).toHaveLength(1);

    const badGateway = createMockModelGateway({
      intent_parser: 'not valid json at all {{{',
    });
    const degraded = await parsePlayerIntent({
      input: 'I try something wild',
      state,
      inCombat: true,
      gateway: badGateway,
      allowLlmFallback: true,
    });
    expect(degraded.usedLlm).toBe(true);
    expect(degraded.intent).toEqual({ kind: 'chat', text: 'I try something wild' });
    expect(degraded.warnings.length).toBeGreaterThan(0);
  });
});

describe('runCastDirector', () => {
  it('computes deterministic cast presence and strips hallucinated, dead, player, unknown Tier 2 locations, and formGroup duplicates', async () => {
    const locMarket = makeLocation({ id: 'market', name: 'Market', connectedLocations: ['docks'] });
    const locDocks = makeLocation({ id: 'docks', name: 'Docks', connectedLocations: ['market', 'newsroom'] });
    const locNewsroom = makeLocation({ id: 'newsroom', name: 'Daily Planet', connectedLocations: ['docks'] });

    const playerChar = makeCharacter({
      id: 'pc_hero',
      name: 'Hero',
      locationId: 'market',
      presentInScene: true,
    });
    const clark = makeCharacter({
      id: 'clark_kent',
      name: 'Clark Kent',
      locationId: 'market',
      presentInScene: true,
      formId: 'form_clark',
      formGroup: 'kryptonian',
    });
    const superman = makeCharacter({
      id: 'superman',
      name: 'Superman',
      locationId: 'docks',
      presentInScene: false,
      formId: 'form_superman',
      formGroup: 'kryptonian',
    });
    const deadNpc = makeCharacter({
      id: 'dead_agent',
      name: 'Fallen Agent',
      status: 'dead',
      locationId: 'docks',
    });
    const validArrival = makeCharacter({
      id: 'lois_lane',
      name: 'Lois Lane',
      locationId: 'docks',
      presentInScene: false,
    });
    const validOffscreen = makeCharacter({
      id: 'jimmy_olsen',
      name: 'Jimmy Olsen',
      locationId: 'docks',
      presentInScene: false,
    });

    const formDefinitions: FormDefinition[] = [
      { id: 'form_clark', formGroup: 'kryptonian', characterId: 'clark_kent', displayName: 'Clark' },
      { id: 'form_superman', formGroup: 'kryptonian', characterId: 'superman', displayName: 'Superman' },
    ];

    const state = createWorldState({
      capabilities: makeCapabilities({ spatialMode: 'authored_graph' }),
      player: {
        id: 'player',
        name: 'Player',
        characterId: 'pc_hero',
        locationId: 'market',
      },
      scene: {
        location: 'Market',
        locationId: 'market',
        mood: 'busy',
        pacing: 'balanced',
        presentCharacterIds: ['clark_kent'],
        pinnedCharacterIds: [],
        directorNudge: null,
      },
      entities: {
        characters: {
          pc_hero: playerChar,
          clark_kent: clark,
          superman,
          dead_agent: deadNpc,
          lois_lane: validArrival,
          jimmy_olsen: validOffscreen,
        },
        locations: {
          market: locMarket,
          docks: locDocks,
          newsroom: locNewsroom,
        },
      },
    });

    const gateway = createMockModelGateway({
      cast_director: {
        kind: 'json',
        value: {
          arrivals: [
            { characterId: 'ghost_id', reason: 'hallucinated' },
            { characterId: 'dead_agent', reason: 'zombie' },
            { characterId: 'pc_hero', reason: 'player hijack' },
            { characterId: 'superman', reason: 'duplicate formGroup with clark_kent' },
            { characterId: 'lois_lane', reason: 'arrives with notebook' },
          ],
          offscreenMoves: [
            { characterId: 'jimmy_olsen', locationId: 'nonexistent_tier2_loc' },
            { characterId: 'jimmy_olsen', locationId: 'newsroom' },
          ],
        },
      },
    });

    const result = await runCastDirector({
      state,
      formDefinitions,
      gateway,
      useLlmPass: true,
      recentExchangeText: 'Lois hurries into the market.',
    });

    expect(result.presence.presentCharacterIds).toEqual(['clark_kent']);
    expect(result.presence.excludedPlayerCharacterId).toBe('pc_hero');

    expect(result.strippedInvalidItems).toEqual([
      'arrival:ghost_id:unknown_character',
      'arrival:dead_agent:invalid_status_dead',
      'arrival:pc_hero:player_character',
      'arrival:superman:duplicate_form_group_kryptonian',
      'offscreenMove:jimmy_olsen:unknown_location_nonexistent_tier2_loc',
    ]);

    expect(result.proposedBatch).not.toBeNull();
    const reduced = applyPatchBatch(state, result.proposedBatch!);
    expect(reduced.ok).toBe(true);
    if (reduced.ok) {
      expect(reduced.value.nextState.entities.characters['lois_lane']?.locationId).toBe('market');
      expect(reduced.value.nextState.entities.characters['lois_lane']?.presentInScene).toBe(true);
      expect(reduced.value.nextState.entities.characters['jimmy_olsen']?.locationId).toBe('newsroom');
      expect(reduced.value.nextState.scene.presentCharacterIds).toEqual(['clark_kent', 'lois_lane']);
    }
  });
});

describe('runStorylinePlanner', () => {
  it('is a no-op when beats are disabled or useLlmPass is false', async () => {
    const state = createWorldState({ capabilities: makeCapabilities({ beats: false }) });
    const beats: BeatDefinition[] = [];
    const ledger = createInitialBeatLedger(beats);
    const gateway = createMockModelGateway();

    const res = await runStorylinePlanner({
      state,
      ledger,
      beats,
      gateway,
      useLlmPass: true,
    });
    expect(res.proposedBatch).toBeNull();
    expect(gateway.mockProvider.recordedCalls).toHaveLength(0);
  });

  it('strips unknown IDs and unauthorized hard plot flags / engine fields while keeping soft updates', async () => {
    const threat = makeThreat({ id: 'syndicate_plot', name: 'Syndicate Plot' });
    const faction = makeFaction({ id: 'wardens', name: 'City Wardens' });
    const npc = makeCharacter({ id: 'aria', name: 'Aria' });
    const state = createWorldState({
      capabilities: makeCapabilities({ beats: true, factions: true }),
      entities: {
        threats: { syndicate_plot: threat },
        factions: { wardens: faction },
        characters: { aria: npc },
      },
    });
    const beats: BeatDefinition[] = [];
    const ledger = createInitialBeatLedger(beats);

    const gateway = createMockModelGateway({
      storyline_planner: {
        kind: 'json',
        value: {
          flags: { route_secret_ending: true },
          threatUpdates: [
            { threatId: 'unknown_threat', agenda: 'invalid' },
            { threatId: 'syndicate_plot', agenda: 'Infiltrate the harbor', progress: 100 },
          ],
          factionUpdates: [
            { factionId: 'wardens', goals: ['Secure the docks'], influence: 99 },
          ],
          characterUpdates: [
            { characterId: 'aria', mood: 'determined', status: 'dead', goals: ['Find proof'] },
          ],
        },
      },
    });

    const result = await runStorylinePlanner({
      state,
      ledger,
      beats,
      gateway,
      useLlmPass: true,
      recentExchangeText: 'Aria uncovers a manifest.',
    });

    expect(result.strippedInvalidItems).toEqual([
      'unauthorized_root:flags',
      'threat:unknown_threat:unknown_threat',
      'unauthorized_field:threats:syndicate_plot.progress',
      'unauthorized_field:factions:wardens.influence',
      'unauthorized_field:characters:aria.status',
    ]);

    expect(result.proposedBatch).not.toBeNull();
    const reduced = applyPatchBatch(state, result.proposedBatch!);
    expect(reduced.ok).toBe(true);
    if (reduced.ok) {
      const next = reduced.value.nextState;
      expect(next.entities.threats['syndicate_plot']?.agenda).toBe('Infiltrate the harbor');
      expect(next.entities.threats['syndicate_plot']?.progress).toBe(0);
      expect(next.entities.factions['wardens']?.goals).toEqual(['Secure the docks']);
      expect(next.entities.factions['wardens']?.influence).toBe(50);
      expect(next.entities.characters['aria']?.mood).toBe('determined');
      expect(next.entities.characters['aria']?.status).toBe('active');
      expect(next.entities.characters['aria']?.goals).toEqual(['Find proof']);
      expect(next.flags['route_secret_ending']).toBeUndefined();
    }
  });
});

describe('proposeNpcCombatActions', () => {
  it('returns valid proposed actions from combat_agent and degrades cleanly to fallback on error', async () => {
    const registry = createDefaultSkillCatalog();
    const ally = makeCombatant({ id: 'hero', team: 'ally', coord: { x: 1, y: 1 } });
    const enemy = makeCombatant({ id: 'raider', team: 'enemy', coord: { x: 2, y: 1 } });

    const combatState: CombatState = {
      active: true,
      mode: 'tactical_grid',
      round: 1,
      turnIndex: 1,
      initiativeOrder: ['hero', 'raider'],
      grid: makeOpenGrid(),
      combatants: { hero: ally, raider: enemy },
      triggerCountsThisTurn: {},
    };

    const okGateway = createMockModelGateway({
      combat_agent: {
        kind: 'json',
        value: {
          actions: [{ type: 'skill', skillId: 'power_strike', targetId: 'hero' }],
        },
      },
    });

    const okRes = await proposeNpcCombatActions({
      combatState,
      actorId: 'raider',
      registry,
      gateway: okGateway,
    });
    expect(okRes.usedFallbackOnError).toBe(false);
    expect(okRes.proposedActions).toEqual([
      { type: 'skill', skillId: 'power_strike', targetId: 'hero' },
    ]);

    const timeoutGateway = createMockModelGateway({
      combat_agent: {
        kind: 'timeout',
        message: 'Timed out waiting for NPC tactical decision',
      },
    });

    const errRes = await proposeNpcCombatActions({
      combatState,
      actorId: 'raider',
      registry,
      gateway: timeoutGateway,
    });
    expect(errRes.usedFallbackOnError).toBe(true);
    expect(errRes.proposedActions).toEqual([]);
    expect(errRes.warnings.length).toBeGreaterThan(0);

    // Verify resolveCombatTurn cleanly falls back to deterministic computeFallbackActions
    const worldState = createWorldState();
    const turnResult = resolveCombatTurn({
      combatState,
      worldState,
      actorId: 'raider',
      proposedActions: errRes.proposedActions,
      registry,
      rng: createSeededRng(42),
    });
    expect(turnResult.usedFallback).toBe(true);
    expect(turnResult.outcomeSummary.executedActions.length).toBeGreaterThan(0);
  });
});

describe('runChronicleRouter', () => {
  it('skips when chronicle is disabled or cadence is not due, and records milestone + emergent visit when due', async () => {
    const disabledState = createWorldState({ capabilities: makeCapabilities({ chronicle: false }) });
    const config = resolveEffectiveControlRoomConfig(STOCK_TACTICAL_RPG_PACK);
    const gateway = createMockModelGateway({
      chronicle_router: {
        kind: 'json',
        value: {
          category: 'quest',
          title: 'Vault Breached',
          summary: 'The crew cracked the Obsidian Vault under cover of storm.',
          keywords: ['vault', 'heist'],
          involvedEntityIds: ['aria'],
          emergentLocationName: 'Obsidian Vault',
        },
      },
    });

    const skippedCap = await runChronicleRouter({
      state: disabledState,
      config,
      turnContext: { turn: 5, clockAdvancedThisTurn: false, combatEndedThisTurn: false },
      recentExchangeText: 'We opened the vault.',
      gateway,
    });
    expect(skippedCap.skippedByCadence).toBe(true);
    expect(gateway.mockProvider.recordedCalls).toHaveLength(0);

    // STOCK_RPG_PROGRESSION_PACK has episodic_chronicle with everyNTurns: 5
    const activeState = createWorldState({
      capabilities: { ...config.capabilities, spatialMode: 'emergent', chronicle: true },
    });

    const turn2 = await runChronicleRouter({
      state: activeState,
      config,
      turnContext: { turn: 2, clockAdvancedThisTurn: false, combatEndedThisTurn: false },
      recentExchangeText: 'Walking down the hall.',
      gateway,
    });
    expect(turn2.skippedByCadence).toBe(true);
    expect(gateway.mockProvider.recordedCalls).toHaveLength(0);

    const turn5 = await runChronicleRouter({
      state: activeState,
      config,
      turnContext: { turn: 5, clockAdvancedThisTurn: false, combatEndedThisTurn: false },
      recentExchangeText: 'The vault door swings wide.',
      gateway,
    });
    expect(turn5.skippedByCadence).toBe(false);
    expect(turn5.proposedBatch).not.toBeNull();
    expect(gateway.mockProvider.recordedCalls).toHaveLength(1);

    const reduced = applyPatchBatch(activeState, turn5.proposedBatch!);
    expect(reduced.ok).toBe(true);
    if (reduced.ok) {
      const next = reduced.value.nextState;
      expect(next.scene.location).toBe('Obsidian Vault');
      expect(next.scene.locationId).toBe('obsidian-vault');
      expect(next.chronicle.events).toHaveLength(1);
      expect(next.chronicle.events[0]?.title).toBe('Vault Breached');
      expect(next.chronicle.events[0]?.locationId).toBe('obsidian-vault');
    }
  });
});
