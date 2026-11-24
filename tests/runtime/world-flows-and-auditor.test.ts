import { describe, expect, it } from 'vitest';
import { runAuditorPass, runDeterministicStateAudit } from '../../src/agents/auditor-agent.js';
import type { CartridgeBundle } from '../../src/cartridge/cartridge-schema.js';
import type { CombatantState } from '../../src/combat/action-validator.js';
import { createQueuedRng } from '../../src/core/prng.js';
import { isErr, isOk } from '../../src/core/result.js';
import { createMockModelGateway } from '../../src/gateway/mock-provider.js';
import { type SessionRuntimeEvent } from '../../src/runtime/event-bus.js';
import { SessionRuntime } from '../../src/runtime/session-runtime.js';
import {
  STOCK_LIVING_WORLD_PACK,
  STOCK_TACTICAL_RPG_PACK,
} from '../../src/schema/stock-system-packs.js';
import {
  type FormDefinition,
  type FormTransitionRule,
  buildFormIndex,
} from '../../src/state/forms.js';
import { applyPatchBatch } from '../../src/state/reducer.js';
import {
  type CharacterEntity,
  type WorldState,
  cloneWorldState,
  createWorldState,
} from '../../src/state/world-state.js';
import {
  evaluateDigestFlow,
  executeDowntime,
  executeTravel,
} from '../../src/world/flow-hooks.js';

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

function makeLivingWorldState(): WorldState {
  return createWorldState({
    sessionId: 'test-living-world',
    capabilities: {
      ...STOCK_LIVING_WORLD_PACK.capabilities,
      progression: 'rpg_levels',
    },
    rngState: createQueuedRng([0.05, 0.99], 'travel-seed'),
    player: {
      id: 'player',
      name: 'Alex',
      locationId: 'safehouse',
      progression: { level: 1, xp: 0 },
      resources: {
        hp: { current: 12, max: 20 },
        stamina: { current: 5, max: 10 },
      },
    },
    scene: {
      location: 'Safehouse',
      locationId: 'safehouse',
      presentCharacterIds: ['ally-1'],
    },
    locations: {
      safehouse: {
        id: 'safehouse',
        name: 'Safehouse',
        kind: 'safehouse',
        status: 'normal',
        controllingFactionId: 'vanguard',
        connectedLocations: ['market', 'vault', 'ruins'],
        discovered: true,
        discoveryState: 'visited',
        tags: ['safehouse', 'hub'],
        notes: 'Player base',
        connectionsMeta: {
          market: { state: 'open' },
          vault: { state: 'locked' },
          ruins: { state: 'open' },
        },
      },
      market: {
        id: 'market',
        name: 'Central Market',
        kind: 'district',
        status: 'normal',
        controllingFactionId: 'vanguard',
        connectedLocations: ['safehouse'],
        discovered: true,
        discoveryState: 'discovered',
        tags: ['safe'],
        notes: 'Bustling market',
      },
      vault: {
        id: 'vault',
        name: 'Sealed Vault',
        kind: 'vault',
        status: 'locked',
        controllingFactionId: null,
        connectedLocations: ['safehouse'],
        discovered: false,
        discoveryState: 'rumored',
        tags: ['dungeon'],
        notes: 'Locked vault',
      },
      ruins: {
        id: 'ruins',
        name: 'Ash Ruins',
        kind: 'ruins',
        status: 'contested',
        controllingFactionId: null,
        connectedLocations: ['safehouse'],
        discovered: false,
        discoveryState: 'unknown',
        tags: ['dangerous', 'ruins'],
        notes: 'Contested ruins',
      },
    },
    characters: {
      'ally-1': makeCharacter({
        id: 'ally-1',
        name: 'Mira',
        locationId: 'safehouse',
        presentInScene: true,
      }),
      'scout-2': makeCharacter({
        id: 'scout-2',
        name: 'Kael',
        locationId: 'market',
        presentInScene: false,
      }),
    },
    factions: {
      vanguard: {
        id: 'vanguard',
        name: 'Vanguard',
        side: 'hero',
        status: 'active',
        influence: 3,
        headquartersLocationId: 'safehouse',
        goals: ['Protect the city'],
      },
    },
    threats: {
      raiders: {
        id: 'raiders',
        name: 'Ash Raiders',
        rank: 'main',
        status: 'active',
        stage: 2,
        progress: 1,
        locationId: 'ruins',
        sourceFactionId: null,
        agenda: 'Raid the outer districts',
      },
    },
  });
}

describe('PR-9.4: Living-World Flows (Travel, Downtime, Newsroom), Reactive Forms & Auditor', () => {
  it('executeTravel blocks locked/unreachable connections, marks visited, triggers deterministic encounter, and compiles arrivalSummary', () => {
    const state = makeLivingWorldState();

    // Locked connection blocked
    const lockedRes = executeTravel(state, 'vault');
    expect(isErr(lockedRes)).toBe(true);
    if (isErr(lockedRes)) {
      expect(lockedRes.error[0]?.code).toBe('CONNECTION_BLOCKED');
    }

    // Open dangerous destination triggers encounter (queued roll = 0.05 < risk)
    const ruinsRes = executeTravel(state, 'ruins');
    expect(isOk(ruinsRes)).toBe(true);
    if (isOk(ruinsRes)) {
      expect(ruinsRes.value.encounterTriggered).toBe(true);
      expect(ruinsRes.value.encounterActionPending).toBe('engage');
      expect(ruinsRes.value.arrivalSummary.targetLocationId).toBe('ruins');
      expect(ruinsRes.value.arrivalSummary.discoveryState).toBe('visited');
      expect(ruinsRes.value.arrivalSummary.previousDiscoveryState).toBe('unknown');
      expect(ruinsRes.value.arrivalSummary.activeThreatsAtTarget).toEqual(['raiders']);
      expect(ruinsRes.value.arrivalSummary.summaryText).toContain('Arrived at Ash Ruins');

      const applied = applyPatchBatch(state, {
        eventId: 'travel-ruins',
        source: 'engine',
        operations: ruinsRes.value.patches,
      });
      expect(isOk(applied)).toBe(true);
      if (isOk(applied)) {
        expect(applied.value.nextState.scene.locationId).toBe('ruins');
        expect(applied.value.nextState.entities.locations['ruins']?.discoveryState).toBe('visited');
        expect(applied.value.nextState.entities.locations['ruins']?.discovered).toBe(true);
        expect(applied.value.nextState.customFields['encounterActionPending']).toBe('engage');
        expect(applied.value.nextState.clocks.slot).toBe('afternoon');
      }
    }
  });

  it('executeDowntime validates safehouse, advances clock slot, and emits deterministic patches for all 5 activities', () => {
    const state = makeLivingWorldState();

    // Rejects downtime in contested/hostile location
    const unsafeState = cloneWorldState(state);
    unsafeState.scene.locationId = 'ruins';
    const unsafeRes = executeDowntime(unsafeState, 'recover');
    expect(isErr(unsafeRes)).toBe(true);
    if (isErr(unsafeRes)) {
      expect(unsafeRes.error[0]?.code).toBe('DOWNTIME_UNSAFE_LOCATION');
    }

    // Recover restores resources & advances slot
    const recoverRes = executeDowntime(state, 'recover');
    expect(isOk(recoverRes)).toBe(true);
    if (isOk(recoverRes)) {
      const applied = applyPatchBatch(state, {
        eventId: 'dt-recover',
        source: 'engine',
        operations: recoverRes.value.patches,
      });
      expect(isOk(applied)).toBe(true);
      if (isOk(applied)) {
        expect(applied.value.nextState.player.resources?.['hp']?.current).toBe(20);
        expect(applied.value.nextState.player.resources?.['stamina']?.current).toBe(10);
        expect(applied.value.nextState.clocks.slot).toBe('afternoon');
      }
    }

    // Train awards XP
    const trainRes = executeDowntime(state, 'train', { xpAmount: 40 });
    expect(isOk(trainRes)).toBe(true);
    if (isOk(trainRes)) {
      const applied = applyPatchBatch(state, {
        eventId: 'dt-train',
        source: 'engine',
        operations: trainRes.value.patches,
      });
      expect(isOk(applied)).toBe(true);
      if (isOk(applied)) {
        expect(applied.value.nextState.player.progression?.xp).toBe(40);
      }
    }

    // Research adds intel
    const researchRes = executeDowntime(state, 'research', { intelAmount: 2 });
    expect(isOk(researchRes)).toBe(true);
    if (isOk(researchRes)) {
      const applied = applyPatchBatch(state, {
        eventId: 'dt-research',
        source: 'engine',
        operations: researchRes.value.patches,
      });
      expect(isOk(applied)).toBe(true);
      if (isOk(applied)) {
        expect(applied.value.nextState.counters['intel']).toBe(2);
      }
    }

    // Patrol bolsters faction influence
    const patrolRes = executeDowntime(state, 'patrol');
    expect(isOk(patrolRes)).toBe(true);
    if (isOk(patrolRes)) {
      const applied = applyPatchBatch(state, {
        eventId: 'dt-patrol',
        source: 'engine',
        operations: patrolRes.value.patches,
      });
      expect(isOk(applied)).toBe(true);
      if (isOk(applied)) {
        expect(applied.value.nextState.entities.factions['vanguard']?.influence).toBe(4);
      }
    }

    // Socialize updates relation affinity
    const socializeRes = executeDowntime(state, 'socialize', { targetCharacterId: 'ally-1' });
    expect(isOk(socializeRes)).toBe(true);
    if (isOk(socializeRes)) {
      const applied = applyPatchBatch(state, {
        eventId: 'dt-socialize',
        source: 'engine',
        operations: socializeRes.value.patches,
      });
      expect(isOk(applied)).toBe(true);
      if (isOk(applied)) {
        expect(applied.value.nextState.relations['player']?.['ally-1']?.affinity).toBe(5);
      }
    }
  });

  it('evaluateDigestFlow publishes structured DigestEdition every 3 days or 6 chronicle events', () => {
    const state = makeLivingWorldState();

    // Day 1 with 0 events -> should not publish
    const day1Res = evaluateDigestFlow(state);
    expect(day1Res.published).toBe(false);
    expect(day1Res.edition).toBeNull();

    // Day 3 -> publishes
    const day3State = cloneWorldState(state);
    day3State.clocks.day = 3;
    day3State.clocks.inGameDate = '2026-04-03';
    day3State.chronicle.events.push({
      id: 'evt-1',
      turn: 4,
      day: 2,
      date: '2026-04-02',
      title: 'Market Skirmish',
      category: 'event',
      summary: 'Vanguard repelled scouts near the market.',
      locationId: 'market',
      involvedEntityIds: ['ally-1'],
      keywords: ['skirmish'],
    });

    const day3Res = evaluateDigestFlow(day3State, { masthead: 'NeoTerra Herald' });
    expect(day3Res.published).toBe(true);
    expect(day3Res.edition).not.toBeNull();
    expect(day3Res.edition?.masthead).toBe('NeoTerra Herald');
    expect(day3Res.edition?.day).toBe(3);
    expect(day3Res.edition?.inGameDate).toBe('2026-04-03');
    expect(day3Res.edition?.headlines.length).toBeGreaterThan(0);
    expect(day3Res.edition?.locationIds).toContain('market');

    const applied = applyPatchBatch(day3State, {
      eventId: 'digest-3',
      source: 'engine',
      operations: day3Res.patches,
    });
    expect(isOk(applied)).toBe(true);
    if (isOk(applied)) {
      expect(applied.value.nextState.chronicle.digestEditions).toHaveLength(1);
      // Day 4 with 0 new events -> should not publish again
      const day4State = cloneWorldState(applied.value.nextState);
      day4State.clocks.day = 4;
      expect(evaluateDigestFlow(day4State).published).toBe(false);
    }
  });

  it('runDeterministicStateAudit and runAuditorPass detect and auto-correct injected state contradictions', async () => {
    const forms: FormDefinition[] = [
      {
        id: 'hero-civilian',
        formGroup: 'hero-identity',
        characterId: 'hero-civ',
        displayName: 'Civilian',
      },
      {
        id: 'hero-armored',
        formGroup: 'hero-identity',
        characterId: 'hero-armor',
        displayName: 'Armored',
      },
    ];
    const formIndex = buildFormIndex(forms);

    const state = createWorldState({
      sessionId: 'audit-test',
      player: {
        id: 'player',
        name: 'Player',
        canonCharacterId: 'hero-civ',
        resources: {
          hp: { current: 80, max: 100 },
        },
      },
      scene: {
        location: 'Plaza',
        locationId: null,
        presentCharacterIds: [
          'dead-npc',
          'hero-civ',
          'hero-armor',
          'valid-npc',
        ],
      },
      characters: {
        'dead-npc': makeCharacter({ id: 'dead-npc', status: 'dead', presentInScene: true }),
        'hero-civ': makeCharacter({
          id: 'hero-civ',
          formId: 'hero-civilian',
          formGroup: 'hero-identity',
          presentInScene: true,
        }),
        'hero-armor': makeCharacter({
          id: 'hero-armor',
          formId: 'hero-armored',
          formGroup: 'hero-identity',
          presentInScene: true,
        }),
        'valid-npc': makeCharacter({
          id: 'valid-npc',
          presentInScene: true,
          resources: { mp: { current: 10, max: 20 } },
        }),
      },
    });
    // Inject out-of-bounds resource contradictions after creation
    if (state.player.resources?.['hp']) {
      state.player.resources['hp'].current = 150;
    }
    const validNpc = state.entities.characters['valid-npc'];
    if (validNpc?.resources?.['mp']) {
      validNpc.resources['mp'].current = -5;
    }

    const audit = runDeterministicStateAudit(state, formIndex);
    const codes = audit.findings.map((f) => f.code);
    expect(codes).toContain('INACTIVE_CHARACTER_IN_SCENE');
    expect(codes).toContain('CANON_POV_DUPLICATE_IN_SCENE');
    expect(codes).toContain('RESOURCE_OUT_OF_BOUNDS');

    const applied = applyPatchBatch(state, {
      eventId: 'audit-fix',
      source: 'engine',
      operations: audit.correctivePatches,
    });
    expect(isOk(applied)).toBe(true);
    if (isOk(applied)) {
      expect(applied.value.nextState.scene.presentCharacterIds).toEqual(['valid-npc']);
      expect(applied.value.nextState.player.resources?.['hp']?.current).toBe(100);
      expect(applied.value.nextState.entities.characters['valid-npc']?.resources?.['mp']?.current).toBe(0);
    }

    // Also verify formGroup exclusivity for two non-canon NPCs in same formGroup
    const npcGroupState = createWorldState({
      sessionId: 'audit-group-test',
      scene: {
        location: 'Plaza',
        locationId: null,
        presentCharacterIds: ['form-a', 'form-b'],
      },
      characters: {
        'form-a': makeCharacter({ id: 'form-a', formId: 'hero-civilian', formGroup: 'hero-identity' }),
        'form-b': makeCharacter({ id: 'form-b', formId: 'hero-armored', formGroup: 'hero-identity' }),
      },
    });
    const groupAudit = runDeterministicStateAudit(npcGroupState, formIndex);
    expect(groupAudit.findings.some((f) => f.code === 'FORM_GROUP_EXCLUSIVITY_VIOLATION')).toBe(true);

    // Optional LLM continuity pass
    const gateway = createMockModelGateway({
      storyline_planner: [
        {
          kind: 'json',
          value: { notes: ['Verify timeline consistency for Plaza arrival.'] },
        },
      ],
    });
    const turn5State = cloneWorldState(npcGroupState);
    turn5State.meta.turn = 5;
    const passRes = await runAuditorPass({
      state: turn5State,
      formIndex,
      gateway,
      useLlmPass: true,
      llmCadenceTurns: 5,
    });
    expect(passRes.skippedLlmByCadence).toBe(false);
    expect(passRes.findings.some((f) => f.code === 'LLM_CONTINUITY_NOTE')).toBe(true);
  });

  it('SessionRuntime wires travel(), downtime(), 3-day newsroom digest, reactive form rules, post-turn auditor, and traditional turnStyle', async () => {
    const forms: FormDefinition[] = [
      {
        id: 'base-form',
        formGroup: 'sentinel',
        characterId: 'sentinel-npc',
        displayName: 'Base Sentinel',
        legalTargets: ['awakened-form'],
      },
      {
        id: 'awakened-form',
        formGroup: 'sentinel',
        characterId: 'sentinel-npc',
        displayName: 'Awakened Sentinel',
        abilities: ['solar_flare'],
      },
    ];
    const formRules: FormTransitionRule[] = [
      {
        id: 'rule-awaken',
        formGroup: 'sentinel',
        fromFormId: 'base-form',
        toFormId: 'awakened-form',
        priority: 10,
        when: { clock: 'day', op: '>=', value: 3 },
        triggerTag: 'awakened',
      },
    ];

    const cartridge: CartridgeBundle = {
      rootDir: null,
      card: {
        spec: 'cartridge/0.1',
        id: 'living-world-runtime-test',
        version: '1.0.0',
        title: 'Living World Runtime Test',
        description: 'Tests travel, downtime, newsroom, reactive forms, and auditor',
        persona: {
          name: 'Narrator',
          description: 'World narrator',
        },
      },
      initialState: {
        capabilities: {
          ...STOCK_LIVING_WORLD_PACK.capabilities,
          combatMode: 'traditional',
        },
        player: {
          id: 'player',
          name: 'Alex',
          characterId: null,
          locationId: 'safehouse',
          progression: { level: 1, xp: 0 },
          resources: { hp: { current: 10, max: 20 } },
          inventory: { items: {}, currency: {} },
          customFields: {},
          sections: {},
        },
        scene: {
          location: 'Safehouse',
          locationId: 'safehouse',
          presentCharacterIds: ['sentinel-npc'],
          pinnedCharacterIds: [],
          mood: 'calm',
          pacing: 'steady',
          directorNudge: null,
        },
        clocks: {
          turn: 0,
          storyTurn: 0,
          day: 1,
          inGameDate: '2026-05-01',
          slot: 'morning',
          slotsPerDay: ['morning', 'afternoon', 'evening', 'night'],
          held: false,
          holdReason: null,
          timers: {},
        },
      },
      initialEntities: {
        forms,
        locations: {
          safehouse: {
            id: 'safehouse',
            name: 'Safehouse',
            kind: 'safehouse',
            status: 'normal',
            controllingFactionId: null,
            connectedLocations: ['market'],
            discovered: true,
            discoveryState: 'visited',
            tags: ['safehouse'],
            notes: '',
            connectionsMeta: { market: { state: 'open' } },
          },
          market: {
            id: 'market',
            name: 'Market',
            kind: 'district',
            status: 'normal',
            controllingFactionId: null,
            connectedLocations: ['safehouse'],
            discovered: false,
            discoveryState: 'discovered',
            tags: ['safe'],
            notes: '',
          },
        },
        characters: {
          'sentinel-npc': makeCharacter({
            id: 'sentinel-npc',
            name: 'Sentinel',
            locationId: 'safehouse',
            formId: 'base-form',
            formGroup: 'sentinel',
            presentInScene: true,
          }),
          'ghost-npc': makeCharacter({
            id: 'ghost-npc',
            name: 'Ghost',
            status: 'dead',
            locationId: 'safehouse',
            presentInScene: false,
          }),
        },
      },
      beats: [],
      routes: [],
      endings: [],
      loreFiles: {},
      endingPromptFiles: {},
      scriptFiles: {},
    };

    const gateway = createMockModelGateway({
      narrator: [
        { kind: 'text', text: 'You prepare in the safehouse.' },
        { kind: 'text', text: 'The sentinel awakens as days pass.' },
      ],
      storyline_planner: [
        {
          kind: 'json',
          value: { notes: ['Day 3 transition verified.'] },
        },
      ],
    });

    const runtime = new SessionRuntime({
      sessionId: 'runtime-flows-test',
      cartridge,
      systemPack: {
        ...STOCK_LIVING_WORLD_PACK,
        capabilities: {
          ...STOCK_LIVING_WORLD_PACK.capabilities,
          combatMode: 'traditional',
        },
      },
      gateway,
      formRules,
      digestConfig: { everyDays: 3, masthead: 'City Dispatch' },
      auditorLlmCadenceTurns: 1,
      useBoundaryLlmAgents: { auditor: true },
    });

    const events: SessionRuntimeEvent[] = [];
    runtime.eventBus.on((evt) => events.push(evt));

    // runtime.downtime()
    const dtRes = runtime.downtime('recover');
    expect(isOk(dtRes)).toBe(true);
    expect(runtime.getState().player.resources?.['hp']?.current).toBe(20);
    expect(runtime.getState().clocks.slot).toBe('afternoon');

    // runtime.travel()
    const trRes = runtime.travel('market', { disableEncounters: true });
    expect(isOk(trRes)).toBe(true);
    expect(runtime.getState().scene.locationId).toBe('market');
    expect(runtime.getState().entities.locations['market']?.discoveryState).toBe('visited');

    // Turn 1: tracker injects dead-npc & hp=999; Auditor auto-corrects both!
    const turn1 = await runtime.executeTurn({
      text: 'Inspect the market.',
      directorSteering: {
        clockAction: { advanceSlots: 8 }, // advances to Day 3!
      },
    });
    expect(isOk(turn1)).toBe(true);
    if (isOk(turn1)) {
      // Reactive form rule fired
      expect(turn1.value.state.entities.characters['sentinel-npc']?.formId).toBe('awakened-form');
      // Newsroom digest published on Day 3
      expect(turn1.value.state.chronicle.digestEditions).toHaveLength(1);
      expect(turn1.value.state.chronicle.digestEditions?.[0]?.masthead).toBe('City Dispatch');
      expect(events.some((e) => e.type === 'digest_published')).toBe(true);
      // Auditor fixed injected contradictions
      expect(turn1.value.state.scene.presentCharacterIds).not.toContain('ghost-npc');
      expect(turn1.value.state.player.resources?.['hp']?.current).toBe(20);
      expect(events.some((e) => e.type === 'auditor_completed')).toBe(true);
    }

    // Traditional combat with turnStyle: 'phased'
    const participants: CombatantState[] = [
      {
        id: 'player',
        name: 'Alex',
        team: 'ally',
        hp: 20,
        maxHp: 20,
        ac: 14,
        speed: 30,
        coord: { x: 0, y: 0 },
        stats: { str: 14, dex: 12 },
        statuses: [],
        alive: true,
        remainingMovement: 30,
        remainingActions: { action: 1, bonus: 1, reaction: 1 },
        resources: {},
        cooldowns: {},
        abilities: ['basic_strike'],
        passives: [],
        willpower: 5,
        maxWillpower: 10,
      },
      {
        id: 'bandit',
        name: 'Bandit',
        team: 'enemy',
        hp: 10,
        maxHp: 10,
        ac: 11,
        speed: 30,
        coord: { x: 1, y: 0 },
        stats: { str: 10, dex: 10 },
        statuses: [],
        alive: true,
        remainingMovement: 30,
        remainingActions: { action: 1, bonus: 1, reaction: 1 },
        resources: {},
        cooldowns: {},
        abilities: ['basic_strike'],
        passives: [],
        willpower: 5,
        maxWillpower: 10,
      },
    ];
    const combatStart = runtime.startCombat(participants, {
      mode: 'traditional',
      turnStyle: 'phased',
    });
    expect(isOk(combatStart)).toBe(true);
    if (isOk(combatStart)) {
      expect(combatStart.value.combatState.mode).toBe('traditional');
      expect(combatStart.value.combatState.turnStyle).toBe('phased');
      expect(combatStart.value.combatState.grid).toBeNull();
    }
  });
});
