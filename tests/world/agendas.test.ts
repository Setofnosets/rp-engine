import { describe, expect, it } from 'vitest';
import { createQueuedRng, createSeededRng } from '../../src/core/prng.js';
import { isErr, isOk } from '../../src/core/result.js';
import { STOCK_LIVING_WORLD_PACK } from '../../src/schema/stock-system-packs.js';
import { applyPatchBatch } from '../../src/state/reducer.js';
import {
  type WorldState,
  cloneWorldState,
  createWorldState,
  validateWorldState,
} from '../../src/state/world-state.js';
import {
  type AgendaConfig,
  DEFAULT_AGENDA_CONFIG,
  runAgendaTick,
  validateAgendaConfig,
} from '../../src/world/agendas.js';

function makeLivingWorldState(factionsEnabled = true): WorldState {
  return createWorldState({
    sessionId: 'agenda-test-session',
    rngSeed: 'agenda-fixed-seed',
    capabilities: {
      ...STOCK_LIVING_WORLD_PACK.capabilities,
      factions: factionsEnabled,
    },
    player: {
      id: 'player',
      name: 'Elena',
      characterId: 'elena',
      locationId: 'plaza',
    },
    scene: {
      location: 'Central Plaza',
      locationId: 'plaza',
      presentCharacterIds: ['elena', 'captain'],
      pinnedCharacterIds: ['pinned_envoy'],
    },
    locations: [
      {
        id: 'plaza',
        name: 'Central Plaza',
        kind: 'district',
        status: 'normal',
        controllingFactionId: 'vanguard',
        connectedLocations: ['harbor', 'market'],
        discovered: true,
        tags: ['hub'],
        notes: '',
      },
      {
        id: 'harbor',
        name: 'Harbor District',
        kind: 'district',
        status: 'contested',
        controllingFactionId: 'syndicate',
        connectedLocations: ['plaza', 'warehouse'],
        discovered: true,
        tags: ['docks'],
        notes: '',
      },
      {
        id: 'market',
        name: 'Grand Market',
        kind: 'district',
        status: 'normal',
        controllingFactionId: 'vanguard',
        connectedLocations: ['plaza'],
        discovered: true,
        tags: ['trade'],
        notes: '',
      },
      {
        id: 'warehouse',
        name: 'Syndicate Warehouse',
        kind: 'hideout',
        status: 'normal',
        controllingFactionId: 'syndicate',
        connectedLocations: ['harbor'],
        discovered: false,
        tags: ['hidden'],
        notes: '',
      },
    ],
    factions: [
      {
        id: 'vanguard',
        name: 'Silver Vanguard',
        side: 'hero',
        status: 'active',
        influence: 60,
        headquartersLocationId: 'plaza',
        goals: ['Protect citizens'],
      },
      {
        id: 'syndicate',
        name: 'Obsidian Syndicate',
        side: 'villain',
        status: 'active',
        influence: 99,
        headquartersLocationId: 'warehouse',
        goals: ['Control docks'],
      },
      {
        id: 'remnant',
        name: 'Old Remnant',
        side: 'neutral',
        status: 'dormant',
        influence: 20,
        headquartersLocationId: 'market',
        goals: ['Wait quietly'],
      },
    ],
    threats: [
      {
        id: 'void_rift',
        name: 'Void Rift',
        rank: 'main',
        status: 'active',
        stage: 0,
        progress: 23,
        locationId: 'harbor',
        sourceFactionId: 'syndicate',
        agenda: 'Expand the breach',
      },
      {
        id: 'dock_smugglers',
        name: 'Smuggler Surge',
        rank: 'secondary',
        status: 'active',
        stage: 1,
        progress: 49,
        locationId: 'harbor',
        sourceFactionId: 'syndicate',
        agenda: 'Flood market with contraband',
      },
      {
        id: 'slumbering_titan',
        name: 'Slumbering Titan',
        rank: 'main',
        status: 'dormant',
        stage: 0,
        progress: 10,
        locationId: null,
        sourceFactionId: null,
        agenda: 'Sleep beneath the sea',
      },
    ],
    characters: [
      {
        id: 'elena',
        name: 'Elena',
        status: 'active',
        presentInScene: true,
        locationId: 'plaza',
        formId: null,
        formGroup: null,
        sections: {},
        customFields: {},
        abilities: [],
        goals: [],
        agenda: '',
        allegiance: 'vanguard',
        mood: 'focused',
        traits: [],
      },
      {
        id: 'captain',
        name: 'Captain Vance',
        status: 'active',
        presentInScene: true,
        locationId: 'plaza',
        formId: null,
        formGroup: null,
        sections: {},
        customFields: {},
        abilities: [],
        goals: [],
        agenda: 'Guard square',
        allegiance: 'vanguard',
        mood: 'alert',
        traits: [],
      },
      {
        id: 'pinned_envoy',
        name: 'Envoy Lyra',
        status: 'offscreen',
        presentInScene: false,
        locationId: 'market',
        formId: null,
        formGroup: null,
        sections: {},
        customFields: {},
        abilities: [],
        goals: [],
        agenda: 'Await meeting',
        allegiance: 'vanguard',
        mood: 'calm',
        traits: [],
      },
      {
        id: 'broker_kane',
        name: 'Broker Kane',
        status: 'offscreen',
        presentInScene: false,
        locationId: 'harbor',
        formId: null,
        formGroup: null,
        sections: {},
        customFields: {},
        abilities: [],
        goals: [],
        agenda: 'Move shipments',
        allegiance: 'syndicate',
        mood: 'guarded',
        traits: [],
      },
      {
        id: 'courier_mira',
        name: 'Courier Mira',
        status: 'active',
        presentInScene: false,
        locationId: 'market',
        formId: null,
        formGroup: null,
        sections: {},
        customFields: {},
        abilities: [],
        goals: [],
        agenda: 'Deliver dispatches',
        allegiance: 'vanguard',
        mood: 'hurried',
        traits: [],
      },
      {
        id: 'scout_tomas',
        name: 'Scout Tomas',
        status: 'offscreen',
        presentInScene: false,
        locationId: 'harbor',
        formId: null,
        formGroup: null,
        sections: {},
        customFields: {},
        abilities: [],
        goals: [],
        agenda: 'Watch the pier',
        allegiance: 'vanguard',
        mood: 'quiet',
        traits: [],
      },
      {
        id: 'fallen_agent',
        name: 'Fallen Agent',
        status: 'dead',
        presentInScene: false,
        locationId: 'harbor',
        formId: null,
        formGroup: null,
        sections: {},
        customFields: {},
        abilities: [],
        goals: [],
        agenda: '',
        allegiance: 'syndicate',
        mood: 'none',
        traits: [],
      },
    ],
  });
}

describe('validateAgendaConfig', () => {
  it('validates DEFAULT_AGENDA_CONFIG and rejects invalid fields', () => {
    expect(isOk(validateAgendaConfig(DEFAULT_AGENDA_CONFIG))).toBe(true);

    const invalid: AgendaConfig = {
      ...DEFAULT_AGENDA_CONFIG,
      maxFactionDeltaPerTick: -1,
      maxNpcMovesPerTick: 1.5,
      rumorsPerTick: -2,
    };
    const res = validateAgendaConfig(invalid);
    expect(isErr(res)).toBe(true);
    if (!res.ok) {
      expect(res.error.length).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('runAgendaTick', () => {
  it('is completely deterministic with a fixed seed over 3 days and emits valid PatchOperations', () => {
    const state = makeLivingWorldState(true);
    const snapshotBefore = cloneWorldState(state);
    const seedRng = createSeededRng('fixed-agenda-seed-42');

    const runA = runAgendaTick(state, DEFAULT_AGENDA_CONFIG, 3, seedRng);
    const runB = runAgendaTick(state, DEFAULT_AGENDA_CONFIG, 3, seedRng);

    // Deterministic equality across runs
    expect(runA).toEqual(runB);
    expect(runA.nextRng).not.toEqual(seedRng);

    // Input state remains unmutated
    expect(state).toEqual(snapshotBefore);

    // Active factions advanced (0.5 * 3 = 1.5); syndicate clamped at 100; dormant remnant unchanged
    expect(runA.nextState.entities.factions['vanguard']?.influence).toBe(61.5);
    expect(runA.nextState.entities.factions['syndicate']?.influence).toBe(100);
    expect(runA.nextState.entities.factions['remnant']?.influence).toBe(20);

    // Active threats advanced and crossed stage thresholds [25, 50, 75, 100]
    expect(runA.nextState.entities.threats['void_rift']?.progress).toBe(26);
    expect(runA.nextState.entities.threats['void_rift']?.stage).toBe(1);
    expect(runA.nextState.entities.threats['dock_smugglers']?.progress).toBe(50.5);
    expect(runA.nextState.entities.threats['dock_smugglers']?.stage).toBe(2);
    expect(runA.nextState.entities.threats['slumbering_titan']?.progress).toBe(10);
    expect(runA.nextState.entities.threats['slumbering_titan']?.stage).toBe(0);

    // Up to maxNpcMovesPerTick (2) off-screen NPC relocations occurred; player, present, pinned, and dead never moved
    const movedOps = runA.operations.filter(
      (op) => op.op === 'entity_patch' && op.collection === 'characters'
    );
    expect(movedOps.length).toBeGreaterThan(0);
    expect(movedOps.length).toBeLessThanOrEqual(DEFAULT_AGENDA_CONFIG.maxNpcMovesPerTick);
    expect(runA.nextState.entities.characters['elena']?.locationId).toBe('plaza');
    expect(runA.nextState.entities.characters['captain']?.locationId).toBe('plaza');
    expect(runA.nextState.entities.characters['pinned_envoy']?.locationId).toBe('market');
    expect(runA.nextState.entities.characters['fallen_agent']?.locationId).toBe('harbor');

    // Rumors generated up to rumorsPerTick (2), appended to turnEvents.rumors, no unresolved placeholders
    expect(runA.generatedRumors).toHaveLength(2);
    expect(runA.nextState.turnEvents.rumors).toEqual(runA.generatedRumors);
    for (const rumor of runA.generatedRumors) {
      expect(rumor).not.toMatch(/\{(faction|location|threat)\}/);
    }

    // Operations apply cleanly via applyPatchBatch and match nextState
    const reduced = applyPatchBatch(state, {
      eventId: 'agenda-tick-1',
      source: 'agenda',
      operations: runA.operations,
    });
    expect(isOk(reduced)).toBe(true);
    if (reduced.ok) {
      expect(reduced.value.nextState.entities).toEqual(runA.nextState.entities);
      expect(reduced.value.nextState.turnEvents.rumors).toEqual(runA.nextState.turnEvents.rumors);
    }

    // Produced WorldState passes strict validation with zero warnings
    const validated = validateWorldState(runA.nextState);
    expect(isOk(validated)).toBe(true);
    if (validated.ok) {
      expect(validated.value.warnings).toEqual([]);
    }
  });

  it('returns a zero-op when capabilities.factions is false or daysElapsed <= 0', () => {
    const disabledState = makeLivingWorldState(false);
    const rng = createSeededRng('noop-seed');

    const disabledRes = runAgendaTick(disabledState, DEFAULT_AGENDA_CONFIG, 5, rng);
    expect(disabledRes.operations).toEqual([]);
    expect(disabledRes.generatedRumors).toEqual([]);
    expect(disabledRes.nextState).toEqual(disabledState);
    expect(disabledRes.nextRng).toEqual(rng);

    const enabledState = makeLivingWorldState(true);
    const zeroDaysRes = runAgendaTick(enabledState, DEFAULT_AGENDA_CONFIG, 0, rng);
    expect(zeroDaysRes.operations).toEqual([]);
    expect(zeroDaysRes.generatedRumors).toEqual([]);
    expect(zeroDaysRes.nextState).toEqual(enabledState);
    expect(zeroDaysRes.nextRng).toEqual(rng);

    const negativeDaysRes = runAgendaTick(enabledState, DEFAULT_AGENDA_CONFIG, -3, rng);
    expect(negativeDaysRes.operations).toEqual([]);
    expect(negativeDaysRes.generatedRumors).toEqual([]);
    expect(negativeDaysRes.nextState).toEqual(enabledState);
  });

  it('clamps daysElapsed by maxDaysPerTick, caps faction delta by maxFactionDeltaPerTick, and advances multiple threat stages', () => {
    const state = makeLivingWorldState(true);
    const rng = createQueuedRng([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]);
    const customConfig: AgendaConfig = {
      ...DEFAULT_AGENDA_CONFIG,
      factionInfluencePerDay: 2.0,
      mainThreatProgressPerDay: 5.0,
      maxFactionDeltaPerTick: 5,
      maxDaysPerTick: 10,
      maxNpcMovesPerTick: 1,
      rumorsPerTick: 1,
    };

    // 30 days should clamp to maxDaysPerTick = 10
    // Faction raw delta = 10 * 2.0 = 20, capped to maxFactionDeltaPerTick = 5 (vanguard 60 -> 65)
    // Main threat delta = 10 * 5.0 = 50 (void_rift 23 -> 73, crossing 25 and 50 -> stage 2)
    const res = runAgendaTick(state, customConfig, 30, rng);

    expect(res.nextState.entities.factions['vanguard']?.influence).toBe(65);
    expect(res.nextState.entities.threats['void_rift']?.progress).toBe(73);
    expect(res.nextState.entities.threats['void_rift']?.stage).toBe(2);
    expect(res.generatedRumors).toHaveLength(1);
    const charMoves = res.operations.filter(
      (op) => op.op === 'entity_patch' && op.collection === 'characters'
    );
    expect(charMoves).toHaveLength(1);
  });

  it('allows off-screen NPC with disconnected location to relocate toward their faction HQ', () => {
    const state = createWorldState({
      sessionId: 'hq-move',
      capabilities: { ...STOCK_LIVING_WORLD_PACK.capabilities, factions: true },
      locations: [
        {
          id: 'outpost',
          name: 'Remote Outpost',
          kind: 'camp',
          status: 'normal',
          controllingFactionId: null,
          connectedLocations: [],
          discovered: true,
          tags: [],
          notes: '',
        },
        {
          id: 'citadel',
          name: 'Iron Citadel',
          kind: 'fortress',
          status: 'normal',
          controllingFactionId: 'iron_legion',
          connectedLocations: [],
          discovered: true,
          tags: [],
          notes: '',
        },
      ],
      factions: [
        {
          id: 'iron_legion',
          name: 'Iron Legion',
          side: 'neutral',
          status: 'active',
          influence: 50,
          headquartersLocationId: 'citadel',
          goals: ['Fortify'],
        },
      ],
      characters: [
        {
          id: 'legion_officer',
          name: 'Officer Torin',
          status: 'offscreen',
          presentInScene: false,
          locationId: 'outpost',
          formId: null,
          formGroup: null,
          sections: {},
          customFields: {},
          abilities: [],
          goals: [],
          agenda: 'Return to HQ',
          allegiance: 'iron_legion',
          mood: 'focused',
          traits: [],
        },
      ],
      scene: { location: 'Iron Citadel', locationId: 'citadel' },
    });

    const res = runAgendaTick(state, DEFAULT_AGENDA_CONFIG, 1, createSeededRng('hq-seed'));
    expect(res.nextState.entities.characters['legion_officer']?.locationId).toBe('citadel');
  });
});
