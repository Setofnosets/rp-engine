import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BeatDefinition } from '../../src/beats/beat-ledger.js';
import type { EndingDefinition, RouteDefinition } from '../../src/beats/routes-and-endings.js';
import type { CartridgeBundle } from '../../src/cartridge/cartridge-schema.js';
import type { CombatantState } from '../../src/combat/action-validator.js';
import type { SkillDefinition } from '../../src/combat/skill-registry.js';
import { SkillRegistry } from '../../src/combat/skill-registry.js';
import type { UserPersonaPreset } from '../../src/config/persona-preset.js';
import { isErr, isOk } from '../../src/core/result.js';
import { createMockModelGateway } from '../../src/gateway/mock-provider.js';
import {
  RefereeDataStore,
  SessionRuntime as BarrelSessionRuntime,
  exportSystemPackToJson,
  exportToSillyTavernChatCompletionPreset,
  importSillyTavernPreset,
  inspectSettingCharacters as barrelInspectSettingCharacters,
  loadConnectionsFile,
  replayFromEvents,
  validateUserPersonaPreset,
} from '../../src/index.js';
import { applyDirectorSteering } from '../../src/runtime/director-steering.js';
import type { SessionRuntimeEvent } from '../../src/runtime/event-bus.js';
import { SessionRuntime } from '../../src/runtime/session-runtime.js';
import {
  STOCK_FREEFORM_PACK,
  STOCK_LIVING_WORLD_PACK,
  STOCK_SLICE_OF_LIFE_PACK,
  STOCK_TACTICAL_RPG_PACK,
} from '../../src/schema/stock-system-packs.js';
import { loadSessionSave } from '../../src/state/persistence.js';
import { getLinearTranscript } from '../../src/state/swipe-tree.js';
import { type CharacterEntity, createWorldState } from '../../src/state/world-state.js';

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

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

function makeCombatant(overrides: Partial<CombatantState> & { id: string }): CombatantState {
  return {
    name: overrides.id,
    team: 'ally',
    coord: { x: 1, y: 1 },
    alive: true,
    hp: 30,
    maxHp: 30,
    ac: 10,
    speed: 6,
    remainingMovement: 6,
    remainingActions: { action: 1, bonus: 1, reaction: 1 },
    resources: {},
    cooldowns: {},
    stats: { str: 4, dex: 2, initiative: 10 },
    statuses: [],
    abilities: ['basic_strike'],
    passives: [],
    willpower: 5,
    maxWillpower: 10,
    ...overrides,
  };
}

function makeBaseCartridge(overrides: Partial<CartridgeBundle>): CartridgeBundle {
  return {
    rootDir: null,
    card: {
      spec: 'cartridge/0.1',
      id: 'test-cartridge',
      version: '1.0.0',
      title: 'Test Cartridge',
      description: 'Test scenario',
      persona: {
        name: 'Elena',
        description: 'A sharp-witted investigator.',
        scenario: 'A rainy evening in the city.',
      },
      ...(overrides.card ?? {}),
    },
    beats: [],
    routes: [],
    endings: [],
    loreFiles: {},
    endingPromptFiles: {},
    scriptFiles: {},
    ...overrides,
  };
}

describe('PR-4.5: SessionRuntime, Swipe Rollback & Director Steering', () => {
  it('Freeform Pack (stock-freeform): runs zero-cartridge chat cleanly with zero tracker LLM calls and supports streaming', async () => {
    const gateway = createMockModelGateway({
      narrator: [
        { kind: 'text', text: 'Rain taps softly against the windowpane.' },
        { kind: 'stream', chunks: ['She smiles ', 'across ', 'the table.'] },
      ],
    });

    const runtime = new SessionRuntime({
      sessionId: 'freeform-sess-1',
      systemPack: STOCK_FREEFORM_PACK,
      gateway,
      seed: 'freeform-seed',
    });

    const events: SessionRuntimeEvent[] = [];
    runtime.eventBus.on((evt) => {
      events.push(evt);
    });

    const turn1 = await runtime.executeTurn({ text: 'Hello, nice evening.' });
    expect(isOk(turn1)).toBe(true);
    if (!turn1.ok) return;

    expect(turn1.value.turn).toBe(1);
    expect(turn1.value.narratorText).toBe('Rain taps softly against the windowpane.');
    expect(turn1.value.trackerSkippedByCadence).toBe(true);
    expect(turn1.value.pendingConfirmations).toHaveLength(0);
    expect(turn1.value.triggeredEnding).toBeNull();
    expect(gateway.mockProvider.recordedCalls).toHaveLength(1);
    expect(gateway.mockProvider.recordedCalls[0]?.role).toBe('narrator');
    expect(events.map((e) => e.type)).toEqual([
      'turn_started',
      'intent_parsed',
      'action_resolved',
      'clock_advanced',
      'prompt_compiled',
      'narrator_completed',
      'tracker_completed',
    ]);

    events.length = 0;
    const turn2 = await runtime.executeTurn({
      text: 'Shall we order coffee?',
      streamNarrator: true,
    });
    expect(isOk(turn2)).toBe(true);
    if (!turn2.ok) return;

    expect(turn2.value.turn).toBe(2);
    expect(turn2.value.narratorText).toBe('She smiles across the table.');
    expect(turn2.value.trackerSkippedByCadence).toBe(true);
    expect(gateway.mockProvider.recordedCalls).toHaveLength(2);
    const chunkEvents = events.filter((e) => e.type === 'narrator_chunk');
    expect(chunkEvents.filter((e) => e.type === 'narrator_chunk' && !e.done)).toHaveLength(3);
    expect(chunkEvents[chunkEvents.length - 1]).toEqual({
      type: 'narrator_chunk',
      turn: 2,
      text: '',
      done: true,
    });
  });

  it('Slice-of-Life Pack (stock-slice-of-life) + Swipe Rollback: restores location on regenerateTurn and switches swipes cleanly', async () => {
    const pc = makeCharacter({
      id: 'pc_hero',
      name: 'Maya',
      presentInScene: true,
      sections: { sec_equipment: 'Denim jacket' },
    });

    const cartridge = makeBaseCartridge({
      card: {
        spec: 'cartridge/0.1',
        id: 'sol-cafe',
        version: '1.0.0',
        title: 'Cafe Evening',
        description: 'Slice of life story',
        recommendedSystemPack: 'stock-slice-of-life',
        persona: {
          name: 'Claire',
          description: 'Barista and close friend.',
          scenario: 'Evening at the corner cafe.',
        },
      },
      initialState: {
        player: {
          id: 'player',
          name: 'Maya',
          characterId: 'pc_hero',
          locationId: null,
          inventory: { items: {}, currency: {} },
          customFields: {},
          sections: { sec_equipment: 'Denim jacket' },
        },
        scene: {
          location: 'Cafe',
          locationId: null,
          presentCharacterIds: [],
          pinnedCharacterIds: [],
          mood: 'relaxed',
          pacing: 'balanced',
          directorNudge: null,
        },
      },
      initialEntities: {
        characters: {
          pc_hero: pc,
          npc_claire: makeCharacter({
            id: 'npc_claire',
            name: 'Claire',
            presentInScene: true,
          }),
        },
      },
    });

    const gateway = createMockModelGateway({
      narrator: [
        'We step out onto the breezy balcony overlooking the street.',
        'We stay cozy inside the warm cafe while rain falls outside.',
      ],
      state_tracker: [
        // Swipe 0 tracker: updates Worn Equipment, sets mood='happy', location='Balcony'
        {
          kind: 'json',
          value: {
            scene: {
              location: 'Balcony',
              mood: 'happy',
            },
            pc_sections: {
              sec_equipment: 'Wool scarf and denim jacket',
            },
          },
        },
        // Swipe 1 tracker after rollback: sets mood='curious' without changing location ('Cafe')
        {
          kind: 'json',
          value: {
            scene: {
              mood: 'curious',
            },
          },
        },
      ],
    });

    const runtime = new SessionRuntime({
      sessionId: 'sol-swipe-test',
      cartridge,
      systemPack: STOCK_SLICE_OF_LIFE_PACK,
      gateway,
      seed: 'sol-seed',
    });

    expect(runtime.getState().scene.location).toBe('Cafe');

    // Turn 1 (Swipe 0)
    const turn1 = await runtime.executeTurn({ text: 'Let us step outside for air.' });
    expect(isOk(turn1)).toBe(true);
    if (!turn1.ok) return;

    expect(turn1.value.swipeIndex).toBe(0);
    expect(turn1.value.state.scene.location).toBe('Balcony');
    expect(turn1.value.state.scene.mood).toBe('happy');
    expect(turn1.value.state.player.sections['sec_equipment']).toBe('Wool scarf and denim jacket');

    // Regenerate -> Swipe 1 rolls back to location = 'Cafe', then sets mood = 'curious'
    const rolledEvents: SessionRuntimeEvent[] = [];
    runtime.eventBus.on((e) => {
      if (e.type === 'swipe_rolled_back' || e.type === 'swipe_switched') {
        rolledEvents.push(e);
      }
    });

    const regen = await runtime.regenerateTurn(turn1.value.assistantMessageId);
    expect(isOk(regen)).toBe(true);
    if (!regen.ok) return;

    expect(regen.value.swipeIndex).toBe(1);
    expect(regen.value.narratorText).toContain('warm cafe');
    expect(regen.value.state.scene.location).toBe('Cafe');
    expect(regen.value.state.scene.mood).toBe('curious');
    expect(regen.value.state.player.sections['sec_equipment']).toBe('Denim jacket');
    expect(rolledEvents[0]?.type).toBe('swipe_rolled_back');

    // Switch back to Swipe 0 -> restores mood = 'happy', location = 'Balcony'
    const sw0 = runtime.switchSwipe(turn1.value.assistantMessageId, 0);
    expect(isOk(sw0)).toBe(true);
    if (!sw0.ok) return;

    expect(sw0.value.state.scene.mood).toBe('happy');
    expect(sw0.value.state.scene.location).toBe('Balcony');
    expect(sw0.value.state.player.sections['sec_equipment']).toBe('Wool scarf and denim jacket');
    expect(rolledEvents[1]?.type).toBe('swipe_switched');

    // Switch back to Swipe 1 -> restores mood = 'curious', location = 'Cafe'
    const sw1 = runtime.switchSwipe(turn1.value.assistantMessageId, 1);
    expect(isOk(sw1)).toBe(true);
    if (!sw1.ok) return;
    expect(sw1.value.state.scene.mood).toBe('curious');
    expect(sw1.value.state.scene.location).toBe('Cafe');
  });

  it('Tactical RPG Pack (stock-tactical-rpg): startCombat holds clock, resolves move+skill & enemy turn, victory releases hold, awards XP & resolves beat', async () => {
    const finisherSkill: SkillDefinition = {
      id: 'meteor_cleave',
      name: 'Meteor Cleave',
      category: 'attack',
      actionCost: 'action',
      resourceCosts: {},
      targeting: {
        shape: 'single_enemy',
        minRange: 1,
        maxRange: 5,
        requiresLos: false,
      },
      hitResolution: {
        kind: 'auto',
      },
      effects: [
        {
          type: 'damage',
          flat: 50,
        },
      ],
    };

    const registry = SkillRegistry.createDefaultSkillCatalog();
    registry.register(finisherSkill);

    const defeatGuardsBeat: BeatDefinition = {
      id: 'defeat-guards',
      class: 'gate',
      priority: 10,
      when: {
        clock: 'turn',
        op: '>=',
        value: 1,
      },
      until: {
        entity: ['characters', 'guard_1', 'status'],
        op: '==',
        value: 'dead',
      },
      on_resolve: [
        {
          set: {
            'flags.guards_defeated': true,
          },
        },
      ],
    };

    const cartridge = makeBaseCartridge({
      card: {
        spec: 'cartridge/0.1',
        id: 'rpg-dungeon',
        version: '1.0.0',
        title: 'Watchtower Raid',
        description: 'Tactical RPG encounter',
        recommendedSystemPack: 'stock-tactical-rpg',
        persona: {
          name: 'Chronicler',
          description: 'Tactical RPG narrator.',
        },
      },
      initialState: {
        player: {
          id: 'player',
          name: 'Kael',
          characterId: 'hero_1',
          locationId: 'courtyard',
          progression: { level: 1, xp: 0, className: 'Vanguard' },
          resources: {
            hp: { current: 30, max: 30 },
            willpower: { current: 10, max: 10 },
            stamina: { current: 100, max: 100 },
          },
          inventory: { items: {}, currency: {} },
          customFields: {},
          sections: {},
        },
        scene: {
          location: 'Watchtower Courtyard',
          locationId: 'courtyard',
          presentCharacterIds: ['guard_1'],
          pinnedCharacterIds: [],
          mood: 'tense',
          pacing: 'balanced',
          directorNudge: null,
        },
      },
      initialEntities: {
        characters: {
          hero_1: makeCharacter({
            id: 'hero_1',
            name: 'Kael',
            locationId: 'courtyard',
            progression: { level: 1, xp: 0, className: 'Vanguard' },
            resources: {
              hp: { current: 30, max: 30 },
              willpower: { current: 10, max: 10 },
              stamina: { current: 100, max: 100 },
            },
          }),
          guard_1: makeCharacter({
            id: 'guard_1',
            name: 'Watch Guard',
            locationId: 'courtyard',
            allegiance: 'enemy',
            resources: {
              hp: { current: 15, max: 15 },
            },
          }),
        },
        locations: {
          courtyard: {
            id: 'courtyard',
            name: 'Watchtower Courtyard',
            kind: 'courtyard',
            status: 'contested',
            controllingFactionId: null,
            connectedLocations: [],
            discovered: true,
            tags: ['combat'],
            notes: '',
          },
        },
      },
      beats: [defeatGuardsBeat],
    });

    const gateway = createMockModelGateway({
      narrator: [
        'Kael advances and parries the watch guard.',
        'Kael unleashes Meteor Cleave, felling the guard in a single decisive arc!',
      ],
      state_tracker: {
        kind: 'json',
        value: {
          scene: {
            mood: 'triumphant',
          },
          player_custom_fields: {
            combat_aftermath: 'Watch guard defeated in the courtyard.',
          },
        },
      },
      chronicle_router: {
        kind: 'json',
        value: {
          shouldRecord: false,
          category: 'event',
          title: 'Skirmish',
          summary: 'Skirmish resolved.',
          keywords: ['combat'],
          involvedEntityIds: ['hero_1'],
        },
      },
    });

    const runtime = new SessionRuntime({
      sessionId: 'rpg-combat-test',
      cartridge,
      systemPack: STOCK_TACTICAL_RPG_PACK,
      gateway,
      skillRegistry: registry,
      seed: 'rpg-seed',
    });

    const startRes = runtime.startCombat(
      [
        makeCombatant({
          id: 'hero_1',
          name: 'Kael',
          team: 'ally',
          hp: 30,
          maxHp: 30,
          stats: { str: 4, dex: 2, initiative: 100 },
          abilities: ['basic_strike', 'meteor_cleave'],
        }),
        makeCombatant({
          id: 'guard_1',
          name: 'Watch Guard',
          team: 'enemy',
          hp: 15,
          maxHp: 15,
          stats: { str: 2, dex: 1, initiative: 1 },
          abilities: ['basic_strike'],
        }),
      ],
      { mode: 'tactical_grid', theme: 'open', gridSize: { width: 8, height: 8 }, xpAwardOnVictory: 120 }
    );

    expect(isOk(startRes)).toBe(true);
    if (!startRes.ok) return;
    expect(startRes.value.state.clocks.held).toBe(true);
    expect(startRes.value.combatState.active).toBe(true);

    // Turn 1: Move one step and defend; then enemy NPC turn resolves automatically via deterministic fallback AI!
    const combatState1 = startRes.value.combatState;
    const heroCoord = combatState1.combatants['hero_1']!.coord;
    const moveTarget = { x: heroCoord.x + 1, y: heroCoord.y };

    const turn1 = await runtime.executeTurn({
      text: 'I step forward and raise my guard.',
      combatActions: [{ type: 'move', to: moveTarget }, { type: 'defend' }],
    });
    expect(isOk(turn1)).toBe(true);
    if (!turn1.ok) return;

    expect(turn1.value.combatState?.active).toBe(true);
    expect(turn1.value.state.clocks.held).toBe(true);
    expect(turn1.value.compiledPrompt.renderedSections['combat_outcome']).toContain('[COMBAT_OUTCOME]');

    // Turn 2: Player defeats the guard with Meteor Cleave -> clock hold released, XP awarded, beat resolved!
    const turn2 = await runtime.executeTurn({
      text: '/skill meteor_cleave guard_1',
    });
    expect(isOk(turn2)).toBe(true);
    if (!turn2.ok) return;

    expect(turn2.value.combatState?.active).toBe(false);
    expect(turn2.value.state.clocks.held).toBe(false);
    expect(turn2.value.state.entities.characters['guard_1']?.status).toBe('dead');
    expect(turn2.value.state.entities.characters['hero_1']?.progression?.xp).toBeGreaterThanOrEqual(120);
    expect(turn2.value.beatLedger.records['defeat-guards']?.status).toBe('resolved');
    expect(turn2.value.state.flags['guards_defeated']).toBe(true);
  });

  it('Living-World Pack (stock-living-world) + Director Steering Bar: /travel advances clock & triggers agendas, harsh pressure fires soft deadline, oocNudge injects into [PLOT], and ending + branch works', async () => {
    const routeDefs: RouteDefinition[] = [
      {
        id: 'loyal',
        lock: 'route_loyal',
        priority: 1,
        when: { flag: 'oath_kept' },
        announce: 'Loyal path locked.',
      },
      {
        id: 'epilogue-peace',
        group: 'post_ending',
        lock: 'route_post_peace',
        priority: 1,
        when: { flag: 'peace_chosen' },
      },
    ];

    const beats: BeatDefinition[] = [
      {
        id: 'harbor-deadline',
        class: 'nudge',
        flexibility: 'adaptable',
        priority: 10,
        when: { clock: 'turn', op: '>=', value: 1 },
        // Under harsh pressure, threshold 3 scales down by 0.7 -> ceil(2.1) = 3, or 2 -> ceil(1.4) = 2!
        deadline: { clock: 'turn', op: '>=', value: 2 },
        deadlinePolicy: 'escalate',
        nudge: 'Meet the courier before the harbor closes.',
        on_deadline: [{ set: { 'flags.harbor_missed': true } }],
      },
      {
        id: 'citadel-oath',
        class: 'gate',
        priority: 20,
        when: { clock: 'turn', op: '>=', value: 1 },
        until: { at: 'citadel' },
        on_resolve: [{ set: { 'flags.oath_kept': true, 'flags.citadel_reached': true } }],
      },
    ];

    const endings: EndingDefinition[] = [
      {
        id: 'dawn-victory',
        route: 'loyal',
        priority: 10,
        when: {
          all: [{ flag: 'citadel_reached' }, { flag: 'harbor_missed' }],
        },
        epilogue: {
          template: 'Write a sweeping epilogue of the citadel at dawn.',
        },
        mark: 'ending_dawn_victory',
        branches: [
          {
            id: 'rebuild-realm',
            label: 'Rebuild the Realm',
            activateRoute: 'epilogue-peace',
            routeGroup: 'post_ending',
            targetArc: 'post-victory',
            patch: { rebuilt: true },
          },
        ],
      },
    ];

    const cartridge = makeBaseCartridge({
      card: {
        spec: 'cartridge/0.1',
        id: 'living-realm',
        version: '1.0.0',
        title: 'Shattered Citadel',
        description: 'Living world simulation',
        recommendedSystemPack: 'stock-living-world',
        persona: {
          name: 'Chronicler',
          description: 'World narrator.',
        },
      },
      systemOverrides: {
        tuningDials: {
          beatPressure: 'harsh',
        },
      },
      initialState: {
        clocks: {
          turn: 0,
          storyTurn: 0,
          day: 1,
          inGameDate: '2026-04-01',
          slot: 'night',
          slotsPerDay: ['morning', 'afternoon', 'evening', 'night'],
          held: false,
          holdReason: null,
          timers: {},
        },
        scene: {
          location: 'Outer Plaza',
          locationId: 'plaza',
          presentCharacterIds: [],
          pinnedCharacterIds: [],
          mood: 'tense',
          pacing: 'balanced',
          directorNudge: null,
        },
        player: {
          id: 'player',
          name: 'Aria',
          characterId: null,
          locationId: 'plaza',
          inventory: { items: {}, currency: {} },
          customFields: {},
          sections: {},
        },
      },
      initialEntities: {
        locations: {
          plaza: {
            id: 'plaza',
            name: 'Outer Plaza',
            kind: 'district',
            status: 'normal',
            controllingFactionId: 'guild',
            connectedLocations: ['citadel'],
            discovered: true,
            tags: ['plaza'],
            notes: '',
          },
          citadel: {
            id: 'citadel',
            name: 'High Citadel',
            kind: 'fortress',
            status: 'contested',
            controllingFactionId: 'syndicate',
            connectedLocations: ['plaza'],
            discovered: false,
            tags: ['citadel'],
            notes: '',
          },
        },
        factions: {
          guild: {
            id: 'guild',
            name: 'Lantern Guild',
            side: 'hero',
            status: 'active',
            influence: 50,
            headquartersLocationId: 'plaza',
            goals: ['Protect the harbor'],
          },
          syndicate: {
            id: 'syndicate',
            name: 'Iron Syndicate',
            side: 'villain',
            status: 'active',
            influence: 60,
            headquartersLocationId: 'citadel',
            goals: ['Seize the citadel'],
          },
        },
        threats: {
          eclipse_ritual: {
            id: 'eclipse_ritual',
            name: 'Eclipse Ritual',
            rank: 'main',
            status: 'active',
            stage: 1,
            progress: 10,
            locationId: 'citadel',
            sourceFactionId: 'syndicate',
            agenda: 'Darken the sky',
          },
        },
        characters: {
          npc_scout: makeCharacter({
            id: 'npc_scout',
            name: 'Vex',
            locationId: 'plaza',
            presentInScene: false,
          }),
        },
      },
      routes: routeDefs,
      beats,
      endings,
    });

    const gateway = createMockModelGateway({
      narrator: [
        'Under the looming eclipse, Aria waits in the plaza.',
        'At dawn, Aria marches into the High Citadel as peace returns.',
      ],
      state_tracker: {
        kind: 'json',
        value: {
          scene: {
            mood: 'dramatic',
          },
        },
      },
    });

    const runtime = new SessionRuntime({
      sessionId: 'living-world-test',
      cartridge,
      systemPack: STOCK_LIVING_WORLD_PACK,
      gateway,
      seed: 'living-seed',
    });

    const events: SessionRuntimeEvent[] = [];
    runtime.eventBus.on((evt) => {
      events.push(evt);
    });

    // Turn 1: Director passes one-turn oocNudge
    const turn1 = await runtime.executeTurn({
      text: 'Survey the plaza.',
      directorSteering: {
        oocNudge: 'Emphasize the eclipse shadow over the plaza.',
      },
    });
    expect(isOk(turn1)).toBe(true);
    if (!turn1.ok) return;

    expect(turn1.value.compiledPrompt.renderedSections['plot']).toContain(
      'Emphasize the eclipse shadow over the plaza.'
    );
    expect(turn1.value.beatLedger.records['harbor-deadline']?.status).toBe('live');

    // Turn 2: /travel citadel advances night -> morning Day 2 (daysElapsed=1 -> agenda tick!),
    // harsh deadline fires on turn 2 (harbor_missed=true), citadel-oath resolves (oath_kept=true, route_loyal locked),
    // ending 'dawn-victory' triggers and injects epilogue template into [PLOT], and previous oocNudge is cleared!
    const turn2 = await runtime.executeTurn({
      text: '/travel citadel',
    });
    expect(isOk(turn2)).toBe(true);
    if (!turn2.ok) return;

    expect(turn2.value.state.scene.locationId).toBe('citadel');
    expect(turn2.value.state.clocks.day).toBe(2);
    expect(turn2.value.state.clocks.slot).toBe('morning');
    expect(turn2.value.state.flags['harbor_missed']).toBe(true);
    expect(turn2.value.state.flags['route_loyal']).toBe(true);
    expect(turn2.value.triggeredEnding?.id).toBe('dawn-victory');
    expect(turn2.value.state.meta.endingStatus).toBe('epilogue');
    expect(turn2.value.compiledPrompt.renderedSections['plot']).toContain(
      'Write a sweeping epilogue of the citadel at dawn.'
    );
    expect(turn2.value.compiledPrompt.renderedSections['plot']).not.toContain(
      'Emphasize the eclipse shadow over the plaza.'
    );
    expect(events.some((e) => e.type === 'agendas_ticked')).toBe(true);
    expect(events.some((e) => e.type === 'route_locked')).toBe(true);
    expect(events.some((e) => e.type === 'ending_triggered')).toBe(true);

    // Post-ending branch choice
    const branchRes = runtime.choosePostEndingBranch('rebuild-realm');
    expect(isOk(branchRes)).toBe(true);
    if (!branchRes.ok) return;
    expect(branchRes.value.nextState.meta.arc).toBe('post-victory');
    expect(branchRes.value.nextState.meta.endingStatus).toBe('continued');
    expect(branchRes.value.nextState.flags['route_post_peace']).toBe(true);
    expect(branchRes.value.nextState.flags['rebuilt']).toBe(true);

    // Standalone applyDirectorSteering check (pin, dismiss, rest_to_morning)
    const stateBeforeSteer = runtime.getState();
    const steerRes = applyDirectorSteering({
      state: stateBeforeSteer,
      ledger: runtime.getBeatLedger(),
      steering: {
        clockAction: 'rest_to_morning',
        pinCharacterIds: ['npc_scout'],
      },
      beats,
    });
    expect(isOk(steerRes)).toBe(true);
    if (!steerRes.ok) return;
    expect(steerRes.value.nextState.clocks.day).toBe(3);
    expect(steerRes.value.nextState.clocks.slot).toBe('morning');
    expect(steerRes.value.nextState.scene.pinnedCharacterIds).toEqual(['npc_scout']);
    expect(steerRes.value.nextState.scene.presentCharacterIds).toContain('npc_scout');
  });

  it('Pending Confirmation Gate: holds always_confirm tracker patch until confirmPendingPatches is called', async () => {
    const gateway = createMockModelGateway({
      narrator: 'The cybernetic diagnostic chimes.',
      state_tracker: {
        kind: 'json',
        value: {
          scene: {
            mood: 'alert',
          },
          player_custom_fields: {
            trauma_level: 42,
            notes: 'Minor spark',
          },
        },
      },
    });

    const runtime = new SessionRuntime({
      sessionId: 'confirm-gate-test',
      systemPack: STOCK_SLICE_OF_LIFE_PACK,
      userControlRoomLayer: {
        gameSystems: [
          {
            id: 'scene_context',
            name: 'Scene Context',
            enabled: true,
            scope: 'session',
            target: 'global',
            effectOwner: 'tracker',
            cadence: 'every_turn',
            fields: {
              mood: {
                type: 'string',
                maxLength: 64,
                default: 'neutral',
                writableByTracker: true,
                confirmPolicy: 'auto',
              },
            },
            trackerInstruction: 'Track scene mood.',
            narratorRule: '',
            ui: { widget: 'card', order: 1 },
          },
          {
            id: 'trauma_module',
            name: 'Trauma Tracker',
            enabled: true,
            scope: 'session',
            target: 'player',
            effectOwner: 'tracker',
            cadence: 'every_turn',
            fields: {
              trauma_level: {
                type: 'meter',
                min: 0,
                max: 100,
                default: 0,
                writableByTracker: true,
                confirmPolicy: 'always_confirm',
              },
              notes: {
                type: 'string',
                maxLength: 120,
                default: '',
                writableByTracker: true,
                confirmPolicy: 'auto',
              },
            },
            trackerInstruction: 'Track trauma_level and notes.',
            narratorRule: '',
            ui: { widget: 'bar', order: 2 },
          },
        ],
      },
      gateway,
      seed: 'confirm-seed',
    });

    const events: SessionRuntimeEvent[] = [];
    runtime.eventBus.on((e) => events.push(e));

    const turn1 = await runtime.executeTurn({ text: 'Check vitals.' });
    expect(isOk(turn1)).toBe(true);
    if (!turn1.ok) return;

    // Auto fields committed immediately, always_confirm field held in pendingConfirmations
    expect(turn1.value.state.scene.mood).toBe('alert');
    expect(turn1.value.state.player.customFields['notes']).toBe('Minor spark');
    expect(turn1.value.state.player.customFields['trauma_level']).toBeUndefined();
    expect(turn1.value.pendingConfirmations).toHaveLength(1);
    expect(runtime.getPendingConfirmations()).toHaveLength(1);
    expect(events.some((e) => e.type === 'confirmations_queued')).toBe(true);

    // Confirm pending patch -> trauma_level now applies
    const confirmed = runtime.confirmPendingPatches('accept_all');
    expect(isOk(confirmed)).toBe(true);
    if (!confirmed.ok) return;

    expect(confirmed.value.appliedCount).toBe(1);
    expect(confirmed.value.state.player.customFields['trauma_level']).toBe(42);
    expect(runtime.getPendingConfirmations()).toHaveLength(0);
  });

  it('Persistence & Control Room updates: saves turn-0 checkpoint, events, audit, swipe-tree, and loads cleanly', async () => {
    const saveDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rp-runtime-save-'));
    tempDirs.push(saveDir);

    const gateway = createMockModelGateway({
      narrator: 'A quiet moment in the archive.',
    });

    const runtime = new SessionRuntime({
      sessionId: 'persist-sess-1',
      systemPack: STOCK_FREEFORM_PACK,
      gateway,
      saveDir,
      seed: 'persist-seed',
    });

    const turn1 = await runtime.executeTurn({ text: 'Open the ledger.' });
    expect(isOk(turn1)).toBe(true);

    const loaded = await loadSessionSave(saveDir);
    expect(isOk(loaded)).toBe(true);
    if (!loaded.ok) return;

    expect(loaded.value.manifest.sessionId).toBe('persist-sess-1');
    expect(loaded.value.swipeTree?.activeLeafMessageId).toBe(
      turn1.ok ? turn1.value.assistantMessageId : null
    );
    expect(loaded.value.events.length).toBeGreaterThanOrEqual(1);
    expect(loaded.value.auditEntries.length).toBeGreaterThanOrEqual(1);

    // Selective pack switch & updateControlRoom
    const upd = runtime.updateControlRoom((layer) => ({
      ...layer,
      tuningDials: { narrativePacing: 'slow_burn' },
    }));
    expect(isOk(upd)).toBe(true);
    if (!upd.ok) return;
    expect(upd.value.tuningDials.narrativePacing).toBe('slow_burn');

    const switched = runtime.switchSystemPack(STOCK_SLICE_OF_LIFE_PACK, ['capabilities']);
    expect(isOk(switched)).toBe(true);
    if (!switched.ok) return;
    expect(switched.value.capabilities.relationships).toBe(true);
    expect(switched.value.tuningDials.narrativePacing).toBe('slow_burn');
    expect(runtime.getState().capabilities.relationships).toBe(true);
    await runtime.flushPendingSaves();
  });

  it('Rejects invalid authored travel targets and rolls back cleanly without mutating runtime state', async () => {
    const cartridge = makeBaseCartridge({
      card: {
        spec: 'cartridge/0.1',
        id: 'authored-travel-test',
        version: '1.0.0',
        title: 'Authored Map',
        description: 'Map test',
        recommendedSystemPack: 'stock-living-world',
        persona: { name: 'Guide', description: 'Guide' },
      },
      initialState: {
        scene: {
          location: 'Gate',
          locationId: 'gate',
          presentCharacterIds: [],
          pinnedCharacterIds: [],
          mood: 'neutral',
          pacing: 'balanced',
          directorNudge: null,
        },
      },
      initialEntities: {
        locations: {
          gate: {
            id: 'gate',
            name: 'Gate',
            kind: 'gate',
            status: 'normal',
            controllingFactionId: null,
            connectedLocations: [],
            discovered: true,
            tags: [],
            notes: '',
          },
          vault: {
            id: 'vault',
            name: 'Vault',
            kind: 'vault',
            status: 'locked',
            controllingFactionId: null,
            connectedLocations: [],
            discovered: false,
            tags: [],
            notes: '',
          },
        },
      },
    });

    const gateway = createMockModelGateway({
      narrator: 'Unreachable.',
    });

    const runtime = new SessionRuntime({
      sessionId: 'travel-err-test',
      cartridge,
      systemPack: STOCK_LIVING_WORLD_PACK,
      gateway,
      seed: 'travel-err',
    });

    const badTravel = await runtime.executeTurn({ text: '/travel vault' });
    expect(isErr(badTravel)).toBe(true);
    expect(runtime.getState().meta.turn).toBe(0);
    expect(runtime.getState().scene.locationId).toBe('gate');

    // Verify prototype-pollution guards in applyDirectorSteering
    const baseState = createWorldState({ sessionId: 'proto-guard' });
    const badSteer = applyDirectorSteering({
      state: baseState,
      ledger: {
        records: {},
        liveGateId: null,
        liveNudgeIds: [],
        activeAmbientIds: [],
      },
      steering: {
        pinCharacterIds: ['__proto__'],
      },
    });
    expect(isErr(badSteer)).toBe(true);
  });

  it('Executes sandboxed beat scripts, slash commands (/rest, /hold_clock, /release_clock, /play_as), partial confirmation indices, and maintains deterministic replay', async () => {
    const scriptBeat: BeatDefinition = {
      id: 'script-trigger-beat',
      class: 'nudge',
      priority: 10,
      when: { clock: 'turn', op: '>=', value: 1 },
      on_entry: [{ script: 'ward_pulse' }],
      nudge: 'The arcane ward pulses.',
    };

    const cartridge = makeBaseCartridge({
      card: {
        spec: 'cartridge/0.1',
        id: 'script-slash-test',
        version: '1.0.0',
        title: 'Arcane Ward',
        description: 'Sandboxed script + slash test',
        recommendedSystemPack: 'stock-tactical-rpg',
        persona: { name: 'Guide', description: 'Guide' },
        scripts: [
          {
            scriptId: 'ward_pulse',
            capabilities: ['state:read', 'state:write:flags.*', 'prompt:inject'],
          },
        ],
      },
      scriptFiles: {
        'scripts/ward_pulse.js': `
          engine.state.set('flags.ward_active', true);
          engine.prompt.inject('plot', 'A faint cyan ward shimmers across the threshold.');
        `,
      },
      initialState: {
        clocks: {
          turn: 0,
          storyTurn: 0,
          day: 1,
          inGameDate: '2026-05-01',
          slot: 'night',
          slotsPerDay: ['morning', 'afternoon', 'evening', 'night'],
          held: false,
          holdReason: null,
          timers: {},
        },
        player: {
          id: 'player',
          name: 'Lyra',
          characterId: 'pc_lyra',
          locationId: 'sanctum',
          progression: { level: 1, xp: 0 },
          resources: {
            hp: { current: 10, max: 20 },
            stamina: { current: 40, max: 100 },
          },
          inventory: { items: {}, currency: {} },
          customFields: {},
          sections: {},
        },
        scene: {
          location: 'Sanctum',
          locationId: 'sanctum',
          presentCharacterIds: ['npc_orion'],
          pinnedCharacterIds: [],
          mood: 'calm',
          pacing: 'balanced',
          directorNudge: null,
        },
      },
      initialEntities: {
        characters: {
          pc_lyra: makeCharacter({
            id: 'pc_lyra',
            name: 'Lyra',
            locationId: 'sanctum',
            resources: {
              hp: { current: 10, max: 20 },
              stamina: { current: 40, max: 100 },
            },
          }),
          npc_orion: makeCharacter({
            id: 'npc_orion',
            name: 'Orion',
            locationId: 'gallery',
            presentInScene: false,
          }),
        },
        locations: {
          sanctum: {
            id: 'sanctum',
            name: 'Sanctum',
            kind: 'room',
            status: 'normal',
            controllingFactionId: null,
            connectedLocations: ['gallery'],
            discovered: true,
            tags: [],
            notes: '',
          },
          gallery: {
            id: 'gallery',
            name: 'Sunlit Gallery',
            kind: 'hall',
            status: 'normal',
            controllingFactionId: null,
            connectedLocations: ['sanctum'],
            discovered: true,
            tags: [],
            notes: '',
          },
        },
      },
      beats: [scriptBeat],
    });

    const makeRuntime = () =>
      new SessionRuntime({
        sessionId: 'det-sess',
        cartridge,
        systemPack: STOCK_TACTICAL_RPG_PACK,
        gateway: createMockModelGateway({
          narrator: 'The ward hums and dawn breaks.',
          state_tracker: {
            kind: 'json',
            value: {
              scene: { mood: 'serene' },
            },
          },
        }),
        seed: 'fixed-det-seed',
      });

    const rtA = makeRuntime();
    const rtB = makeRuntime();

    // Turn 1: /rest heals resources, advances night -> morning Day 2, beat fires ward_pulse script
    const resA1 = await rtA.executeTurn({ text: '/rest' });
    const resB1 = await rtB.executeTurn({ text: '/rest' });
    expect(isOk(resA1)).toBe(true);
    expect(isOk(resB1)).toBe(true);
    if (!resA1.ok || !resB1.ok) return;

    expect(resA1.value.state.flags['ward_active']).toBe(true);
    expect(resA1.value.compiledPrompt.renderedSections['plot']).toContain(
      'A faint cyan ward shimmers across the threshold.'
    );
    expect(resA1.value.state.clocks.day).toBe(2);
    expect(resA1.value.state.clocks.slot).toBe('morning');
    expect(resA1.value.state.player.resources?.['hp']?.current).toBeGreaterThan(10);
    expect(resA1.value.state.player.resources?.['stamina']?.current).toBe(100);
    expect(resA1.value.state.meta.rngState).toEqual(resB1.value.state.meta.rngState);

    // /hold_clock -> /release_clock -> /play_as npc_orion
    const holdRes = await rtA.executeTurn({ text: '/hold_clock ritual pause' });
    expect(isOk(holdRes)).toBe(true);
    if (!holdRes.ok) return;
    expect(holdRes.value.state.clocks.held).toBe(true);

    const relRes = await rtA.executeTurn({ text: '/release_clock' });
    expect(isOk(relRes)).toBe(true);
    if (!relRes.ok) return;
    expect(relRes.value.state.clocks.held).toBe(false);

    const playAsRes = await rtA.executeTurn({ text: '/play_as npc_orion' });
    expect(isOk(playAsRes)).toBe(true);
    if (!playAsRes.ok) return;
    expect(playAsRes.value.state.player.characterId).toBe('npc_orion');
    expect(playAsRes.value.state.scene.locationId).toBe('gallery');
    expect(playAsRes.value.state.scene.location).toBe('Sunlit Gallery');

    // Verify acceptIndices & reject_all on confirmPendingPatches
    const gwConfirm = createMockModelGateway({
      narrator: 'Diagnostic complete.',
      state_tracker: {
        kind: 'json',
        value: {
          player_custom_fields: {
            alpha_stat: 11,
            beta_stat: 22,
          },
        },
      },
    });
    const rtConfirm = new SessionRuntime({
      sessionId: 'partial-confirm',
      systemPack: STOCK_SLICE_OF_LIFE_PACK,
      userControlRoomLayer: {
        gameSystems: [
          {
            id: 'two_confirm_fields',
            name: 'Two Confirm Fields',
            enabled: true,
            scope: 'session',
            target: 'player',
            effectOwner: 'tracker',
            cadence: 'every_turn',
            fields: {
              alpha_stat: {
                type: 'counter',
                min: 0,
                default: 0,
                writableByTracker: true,
                confirmPolicy: 'always_confirm',
              },
              beta_stat: {
                type: 'counter',
                min: 0,
                default: 0,
                writableByTracker: true,
                confirmPolicy: 'always_confirm',
              },
            },
            trackerInstruction: 'Track alpha_stat and beta_stat.',
            narratorRule: '',
            ui: { widget: 'card', order: 1 },
          },
        ],
      },
      gateway: gwConfirm,
      seed: 'confirm-idx',
    });

    const tConf = await rtConfirm.executeTurn({ text: 'Scan both.' });
    expect(isOk(tConf)).toBe(true);
    expect(rtConfirm.getPendingConfirmations()).toHaveLength(2);

    const partial = rtConfirm.confirmPendingPatches({ acceptIndices: [0] });
    expect(isOk(partial)).toBe(true);
    if (!partial.ok) return;
    expect(partial.value.appliedCount).toBe(1);
    expect(partial.value.state.player.customFields['alpha_stat']).toBe(11);
    expect(partial.value.state.player.customFields['beta_stat']).toBeUndefined();
    expect(rtConfirm.getPendingConfirmations()).toHaveLength(0);

    const rejRes = rtConfirm.confirmPendingPatches('reject_all');
    expect(isOk(rejRes)).toBe(true);
  });
});

describe('PR-7.11: M7 SessionRuntime Integration & Barrel Exports', () => {
  it('exports M7 modules and persistence/replay helpers cleanly from src/index.ts', () => {
    expect(BarrelSessionRuntime).toBe(SessionRuntime);
    expect(typeof RefereeDataStore).toBe('function');
    expect(typeof loadConnectionsFile).toBe('function');
    expect(typeof validateUserPersonaPreset).toBe('function');
    expect(typeof barrelInspectSettingCharacters).toBe('function');
    expect(typeof importSillyTavernPreset).toBe('function');
    expect(typeof exportToSillyTavernChatCompletionPreset).toBe('function');
    expect(typeof exportSystemPackToJson).toBe('function');
    expect(typeof replayFromEvents).toBe('function');
  });

  it('seeds ST card firstMessage at Turn 0 and excludes it from duplicate seeding on resume', async () => {
    const saveDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rp-m7-greeting-'));
    tempDirs.push(saveDir);

    const cartridge = makeBaseCartridge({
      card: {
        spec: 'cartridge/0.1',
        id: 'greeting-card',
        version: '1.0.0',
        title: 'Lantern Greeting',
        description: 'Greeting test',
        recommendedSystemPack: 'stock-freeform',
        persona: {
          name: 'Claire',
          description: 'Warm barista.',
          firstMessage: '  She slides a steaming mug across the counter. "Welcome in."  ',
        },
      },
    });

    const gateway = createMockModelGateway({
      narrator: ['Good morning! What can I get you?', 'Coming right up!'],
    });

    const runtime = new SessionRuntime({
      sessionId: 'greeting-sess-1',
      cartridge,
      systemPack: STOCK_FREEFORM_PACK,
      gateway,
      saveDir,
      seed: 'greeting-seed',
    });

    const initialTranscript = getLinearTranscript(runtime.getSwipeTree());
    expect(initialTranscript).toEqual([
      {
        messageId: 'msg-greeting-0',
        role: 'assistant',
        content: 'She slides a steaming mug across the counter. "Welcome in."',
        swipeIndex: 0,
      },
    ]);

    const turn1 = await runtime.executeTurn({ text: 'Morning Claire!' });
    expect(isOk(turn1)).toBe(true);
    if (!turn1.ok) return;

    // Turn 1 prompt includes Turn 0 greeting in recentTranscript
    const transcriptMsgs = turn1.value.compiledPrompt.messages.filter(
      (m) => m.role === 'assistant' && m.content.includes('steaming mug')
    );
    expect(transcriptMsgs).toHaveLength(1);
    expect(turn1.value.userMessageId).not.toBe('msg-greeting-0');

    // Resume from disk -> greeting node is preserved once (not duplicated)
    const resumedRes = await SessionRuntime.fromSaveDirectory(saveDir, {
      sessionId: 'greeting-sess-1',
      cartridge,
      systemPack: STOCK_FREEFORM_PACK,
      gateway,
      seed: 'greeting-seed',
    });
    expect(isOk(resumedRes)).toBe(true);
    if (!resumedRes.ok) return;

    const resumedTranscript = getLinearTranscript(resumedRes.value.getSwipeTree());
    expect(resumedTranscript.map((m) => m.messageId)).toEqual([
      'msg-greeting-0',
      turn1.value.userMessageId,
      turn1.value.assistantMessageId,
    ]);
  });

  it('applies initial userPersona, supports applyUserPersona & updatePlayerProfile, and injects [PERSONA] alongside [CARD]', async () => {
    const saveDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rp-m7-persona-'));
    tempDirs.push(saveDir);

    const initialPersona: UserPersonaPreset = {
      id: 'persona-rowan',
      name: 'Rowan',
      description: 'An observant lantern-bearer from the northern marsh.',
      sections: { sec_appearance: 'Oilskin cloak and brass compass' },
      customFields: { origin_region: 'Northern Marsh' },
    };

    const gateway = createMockModelGateway({
      narrator: [
        'Elena glances at your oilskin cloak.',
        'Elena nods toward Aria.',
        'Elena speaks to Aria without a persona card.',
      ],
    });

    const runtime = new SessionRuntime({
      sessionId: 'persona-sess-1',
      cartridge: makeBaseCartridge({
        card: {
          spec: 'cartridge/0.1',
          id: 'persona-card',
          version: '1.0.0',
          title: 'Persona Test',
          description: 'Persona test',
          recommendedSystemPack: 'stock-freeform',
          persona: { name: 'Elena', description: 'Sharp-witted archivist.' },
        },
      }),
      systemPack: STOCK_FREEFORM_PACK,
      userPersona: initialPersona,
      gateway,
      saveDir,
      seed: 'persona-seed',
    });

    // Turn 0 already reflects initial persona
    expect(runtime.getState().player.name).toBe('Rowan');
    expect(runtime.getState().player.sections['sec_appearance']).toBe('Oilskin cloak and brass compass');
    expect(runtime.getState().player.customFields['origin_region']).toBe('Northern Marsh');
    expect(runtime.getActivePersona()?.name).toBe('Rowan');

    const turn1 = await runtime.executeTurn({ text: 'Hello Elena.' });
    expect(isOk(turn1)).toBe(true);
    if (!turn1.ok) return;
    expect(turn1.value.compiledPrompt.renderedSections['persona']).toContain('[PERSONA]');
    expect(turn1.value.compiledPrompt.renderedSections['persona']).toContain('Rowan');
    expect(turn1.value.compiledPrompt.renderedSections['persona']).toContain('lantern-bearer');
    expect(turn1.value.compiledPrompt.renderedSections['card']).toContain('[CARD]');

    // updatePlayerProfile updates activePersona + WorldState.player + persona.json on disk
    const updRes = await runtime.updatePlayerProfile({
      name: 'Aria',
      description: 'A seasoned cartographer.',
      sections: { sec_personality: 'Calm under pressure' },
      customFields: { compass_bearing: 'North' },
    });
    expect(isOk(updRes)).toBe(true);
    if (!updRes.ok) return;
    expect(updRes.value.player.name).toBe('Aria');
    expect(updRes.value.player.sections['sec_personality']).toBe('Calm under pressure');
    expect(updRes.value.player.sections['sec_appearance']).toBe('Oilskin cloak and brass compass');
    expect(runtime.getActivePersona()?.name).toBe('Aria');

    const loadedWithPersona = await loadSessionSave(saveDir);
    expect(isOk(loadedWithPersona)).toBe(true);
    if (loadedWithPersona.ok) {
      expect(loadedWithPersona.value.activePersona?.name).toBe('Aria');
    }

    const turn2 = await runtime.executeTurn({ text: 'Check the map.' });
    expect(isOk(turn2)).toBe(true);
    if (!turn2.ok) return;
    expect(turn2.value.compiledPrompt.renderedSections['persona']).toContain('Aria');
    expect(turn2.value.compiledPrompt.renderedSections['persona']).toContain('cartographer');

    // Clearing persona removes [PERSONA] and persists null
    const clearRes = await runtime.applyUserPersona(null);
    expect(isOk(clearRes)).toBe(true);
    expect(runtime.getActivePersona()).toBeNull();

    const loadedCleared = await loadSessionSave(saveDir);
    expect(isOk(loadedCleared)).toBe(true);
    if (loadedCleared.ok) {
      expect(loadedCleared.value.activePersona).toBeNull();
    }

    const turn3 = await runtime.executeTurn({ text: 'Continue onward.' });
    expect(isOk(turn3)).toBe(true);
    if (!turn3.ok) return;
    expect(turn3.value.compiledPrompt.renderedSections['persona']).toBeUndefined();

    // Rejects prototype-polluting keys in updatePlayerProfile
    const badProfile = await runtime.updatePlayerProfile(
      JSON.parse('{"__proto__":{"polluted":true}}') as { name?: string }
    );
    expect(isErr(badProfile)).toBe(true);
  });

  it('forwards config.generation sampling parameters to narrator generateText and streamText', async () => {
    const capturedRequests: Array<Record<string, unknown>> = [];
    const gateway = createMockModelGateway({
      narrator: [
        (ctx) => {
          capturedRequests.push(ctx.request as unknown as Record<string, unknown>);
          return { kind: 'text', text: 'First reply.' };
        },
        (ctx) => {
          capturedRequests.push(ctx.request as unknown as Record<string, unknown>);
          return { kind: 'stream', chunks: ['Streamed ', 'reply.'] };
        },
      ],
    });

    const runtime = new SessionRuntime({
      sessionId: 'sampling-sess-1',
      systemPack: STOCK_FREEFORM_PACK,
      userControlRoomLayer: {
        generation: {
          presetName: 'Noir Sampling',
          sourceFormat: 'st_chat_completion',
          temperature: 0.72,
          maxTokens: 320,
          maxContextTokens: 4096,
          topP: 0.91,
          topK: 40,
          minP: 0.05,
          topA: 0.2,
          typicalP: 0.95,
          tfs: 0.9,
          frequencyPenalty: 0.15,
          presencePenalty: 0.1,
          repetitionPenalty: 1.08,
          stopSequences: ['\nUser:', '###'],
          seed: 777,
        },
      },
      gateway,
      seed: 'sampling-seed',
    });

    const t1 = await runtime.executeTurn({ text: 'Speak.' });
    expect(isOk(t1)).toBe(true);
    const t2 = await runtime.executeTurn({ text: 'Whisper.', streamNarrator: true });
    expect(isOk(t2)).toBe(true);

    expect(capturedRequests).toHaveLength(2);
    for (const req of capturedRequests) {
      expect(req['role']).toBe('narrator');
      expect(req['temperature']).toBe(0.72);
      expect(req['maxTokens']).toBe(320);
      expect(req['maxContextTokens']).toBe(4096);
      expect(req['topP']).toBe(0.91);
      expect(req['topK']).toBe(40);
      expect(req['minP']).toBe(0.05);
      expect(req['topA']).toBe(0.2);
      expect(req['typicalP']).toBe(0.95);
      expect(req['tfs']).toBe(0.9);
      expect(req['frequencyPenalty']).toBe(0.15);
      expect(req['presencePenalty']).toBe(0.1);
      expect(req['repetitionPenalty']).toBe(1.08);
      expect(req['stopSequences']).toEqual(['\nUser:', '###']);
      expect(req['seed']).toBe(777);
    }
  });

  it('supports inspectSettingCharacters, inspectCharacterDossier, upsertCharacter, and emergent NPC auto-registration', async () => {
    const gateway = createMockModelGateway({
      narrator: 'A hooded courier slips into the cafe and sets down a sealed envelope.',
      state_tracker: {
        kind: 'json',
        value: {
          scene: {
            mood: 'intriguing',
          },
          new_characters: [
            {
              id: 'npc_courier',
              name: 'Julian Vance',
              mood: 'guarded',
              allegiance: 'guild',
              traits: ['observant'],
              presentInScene: true,
              sections: {
                sec_equipment: 'Rain-soaked trench coat',
              },
            },
          ],
        },
      },
    });

    const runtime = new SessionRuntime({
      sessionId: 'inspector-emergent-sess',
      cartridge: makeBaseCartridge({
        card: {
          spec: 'cartridge/0.1',
          id: 'inspector-card',
          version: '1.0.0',
          title: 'Cafe Roster',
          description: 'Roster test',
          recommendedSystemPack: 'stock-slice-of-life',
          persona: { name: 'Claire', description: 'Barista' },
        },
        initialEntities: {
          characters: {
            npc_claire: makeCharacter({ id: 'npc_claire', name: 'Claire', presentInScene: true }),
          },
        },
      }),
      systemPack: STOCK_SLICE_OF_LIFE_PACK,
      gateway,
      seed: 'emergent-seed',
    });

    // Upsert a character manually and inspect roster + dossier
    const upsertRes = runtime.upsertCharacter('npc_baron', {
      name: 'Baron Corvus',
      mood: 'scheming',
      presentInScene: false,
      traits: ['cunning'],
    });
    expect(isOk(upsertRes)).toBe(true);

    const rosterBefore = runtime.inspectSettingCharacters({ presentOnly: true });
    expect(rosterBefore.characters.some((c) => c.id === 'npc_claire')).toBe(true);
    expect(rosterBefore.characters.some((c) => c.id === 'npc_baron')).toBe(false);

    const baronDossier = runtime.inspectCharacterDossier('Baron Corvus');
    expect(baronDossier).not.toBeNull();
    expect(baronDossier?.summary.id).toBe('npc_baron');
    expect(baronDossier?.agency.traits).toEqual(['cunning']);

    // Turn 1: tracker auto-registers emergent NPC Julian Vance because spatialMode !== 'authored_graph'
    const turn1 = await runtime.executeTurn({ text: 'Watch the door.' });
    expect(isOk(turn1)).toBe(true);
    if (!turn1.ok) return;

    const registeredCourier = turn1.value.state.entities.characters['npc_courier'];
    expect(registeredCourier).toBeDefined();
    expect(registeredCourier?.name).toBe('Julian Vance');
    expect(registeredCourier?.sections['sec_equipment']).toBe('Rain-soaked trench coat');
    expect(turn1.value.state.scene.presentCharacterIds).toContain('npc_courier');

    const courierDossier = runtime.inspectCharacterDossier('julian vance');
    expect(courierDossier?.summary.id).toBe('npc_courier');
    expect(courierDossier?.summary.presentInScene).toBe(true);
  });

  it('snapshots combatState across checkpoints and restores combatState & clock hold on switchSwipe and regenerateTurn', async () => {
    const cartridge = makeBaseCartridge({
      card: {
        spec: 'cartridge/0.1',
        id: 'combat-swipe-card',
        version: '1.0.0',
        title: 'Combat Rollback',
        description: 'Combat swipe rollback test',
        recommendedSystemPack: 'stock-tactical-rpg',
        persona: { name: 'Chronicler', description: 'RPG narrator' },
      },
      initialState: {
        player: {
          id: 'player',
          name: 'Kael',
          characterId: 'hero_1',
          locationId: 'arena',
          progression: { level: 1, xp: 0 },
          resources: { hp: { current: 30, max: 30 } },
          inventory: { items: {}, currency: {} },
          customFields: {},
          sections: {},
        },
        scene: {
          location: 'Arena',
          locationId: 'arena',
          presentCharacterIds: ['raider_1'],
          pinnedCharacterIds: [],
          mood: 'calm',
          pacing: 'balanced',
          directorNudge: null,
        },
      },
      initialEntities: {
        characters: {
          hero_1: makeCharacter({ id: 'hero_1', name: 'Kael', locationId: 'arena' }),
          raider_1: makeCharacter({
            id: 'raider_1',
            name: 'Raider',
            locationId: 'arena',
            allegiance: 'enemy',
          }),
        },
        locations: {
          arena: {
            id: 'arena',
            name: 'Arena',
            kind: 'arena',
            status: 'normal',
            controllingFactionId: null,
            connectedLocations: [],
            discovered: true,
            tags: [],
            notes: '',
          },
        },
      },
    });

    const gateway = createMockModelGateway({
      narrator: [
        'Turn 1 peaceful.',
        'Turn 2 clash!',
        'Turn 2 alternate clash!',
      ],
      state_tracker: [
        { kind: 'json', value: { scene: { mood: 'calm' } } },
        { kind: 'json', value: { scene: { mood: 'fierce' } } },
        { kind: 'json', value: { scene: { mood: 'tense' } } },
      ],
    });

    const runtime = new SessionRuntime({
      sessionId: 'combat-swipe-sess',
      cartridge,
      systemPack: STOCK_TACTICAL_RPG_PACK,
      gateway,
      seed: 'combat-swipe-seed',
    });

    // Turn 1: No combat yet
    const turn1 = await runtime.executeTurn({ text: 'Inspect the arena.' });
    expect(isOk(turn1)).toBe(true);
    if (!turn1.ok) return;
    expect(turn1.value.combatState).toBeNull();
    expect(turn1.value.state.clocks.held).toBe(false);

    // Start combat before Turn 2
    const startRes = runtime.startCombat([
      makeCombatant({
        id: 'hero_1',
        name: 'Kael',
        team: 'ally',
        stats: { str: 4, dex: 2, initiative: 100 },
      }),
      makeCombatant({
        id: 'raider_1',
        name: 'Raider',
        team: 'enemy',
        stats: { str: 2, dex: 1, initiative: 1 },
      }),
    ]);
    expect(isOk(startRes)).toBe(true);

    const turn2 = await runtime.executeTurn({
      text: 'Raise shield!',
      combatActions: [{ type: 'defend' }],
    });
    expect(isOk(turn2)).toBe(true);
    if (!turn2.ok) return;
    expect(turn2.value.combatState?.active).toBe(true);
    expect(turn2.value.state.clocks.held).toBe(true);

    // Regenerate Turn 2 -> preserves combatState & clock hold from Turn 2's pre-response checkpoint
    const regen2 = await runtime.regenerateTurn(turn2.value.assistantMessageId);
    expect(isOk(regen2)).toBe(true);
    if (!regen2.ok) return;
    expect(regen2.value.combatState?.active).toBe(true);
    expect(regen2.value.state.clocks.held).toBe(true);
    expect(runtime.getCombatState()?.active).toBe(true);

    // Switch swipe back to Turn 1 (pre-combat) -> restores combatState === null & clocks.held === false!
    const sw1 = runtime.switchSwipe(turn1.value.assistantMessageId, 0);
    expect(isOk(sw1)).toBe(true);
    if (!sw1.ok) return;
    expect(runtime.getCombatState()).toBeNull();
    expect(sw1.value.state.clocks.held).toBe(false);

    // Switch forward to Turn 2 swipe 1 -> restores active combatState & clocks.held === true!
    const sw2 = runtime.switchSwipe(turn2.value.assistantMessageId, 1);
    expect(isOk(sw2)).toBe(true);
    if (!sw2.ok) return;
    expect(runtime.getCombatState()?.active).toBe(true);
    expect(sw2.value.state.clocks.held).toBe(true);
  });

  it('round-trips full SessionRuntime state via fromSaveDirectory (state, userLayer, activePersona, swipeTree, combatState, and continuing turns)', async () => {
    const saveDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rp-m7-resume-'));
    tempDirs.push(saveDir);

    const persona: UserPersonaPreset = {
      id: 'persona-kael',
      name: 'Kael',
      description: 'Vanguard scout.',
    };

    const cartridge = makeBaseCartridge({
      card: {
        spec: 'cartridge/0.1',
        id: 'resume-rpg-card',
        version: '1.0.0',
        title: 'Resume Campaign',
        description: 'Full resume round-trip',
        recommendedSystemPack: 'stock-tactical-rpg',
        persona: { name: 'Chronicler', description: 'RPG narrator' },
      },
      initialState: {
        player: {
          id: 'player',
          name: 'The Player',
          characterId: 'hero_1',
          locationId: 'courtyard',
          progression: { level: 1, xp: 0 },
          resources: { hp: { current: 30, max: 30 } },
          inventory: { items: {}, currency: {} },
          customFields: {},
          sections: {},
        },
        scene: {
          location: 'Courtyard',
          locationId: 'courtyard',
          presentCharacterIds: ['raider_1'],
          pinnedCharacterIds: [],
          mood: 'tense',
          pacing: 'balanced',
          directorNudge: null,
        },
      },
      initialEntities: {
        characters: {
          hero_1: makeCharacter({ id: 'hero_1', name: 'Kael', locationId: 'courtyard' }),
          raider_1: makeCharacter({
            id: 'raider_1',
            name: 'Raider',
            locationId: 'courtyard',
            allegiance: 'enemy',
          }),
        },
        locations: {
          courtyard: {
            id: 'courtyard',
            name: 'Courtyard',
            kind: 'courtyard',
            status: 'normal',
            controllingFactionId: null,
            connectedLocations: [],
            discovered: true,
            tags: [],
            notes: '',
          },
        },
      },
    });

    const gateway = createMockModelGateway({
      narrator: ['Turn 1 clash!', 'Turn 2 resumed clash!'],
      state_tracker: [
        { kind: 'json', value: { scene: { mood: 'fierce' } } },
        { kind: 'json', value: { scene: { mood: 'victorious' } } },
      ],
    });

    const runtime = new SessionRuntime({
      sessionId: 'resume-sess-1',
      cartridge,
      systemPack: STOCK_TACTICAL_RPG_PACK,
      userControlRoomLayer: {
        tuningDials: { narrativePacing: 'slow_burn' },
      },
      userPersona: persona,
      gateway,
      saveDir,
      seed: 'resume-seed',
    });

    const startRes = runtime.startCombat([
      makeCombatant({
        id: 'hero_1',
        name: 'Kael',
        team: 'ally',
        stats: { str: 4, dex: 2, initiative: 100 },
      }),
      makeCombatant({
        id: 'raider_1',
        name: 'Raider',
        team: 'enemy',
        stats: { str: 2, dex: 1, initiative: 1 },
      }),
    ]);
    expect(isOk(startRes)).toBe(true);

    const turn1 = await runtime.executeTurn({
      text: 'Hold the line!',
      combatActions: [{ type: 'defend' }],
    });
    expect(isOk(turn1)).toBe(true);
    if (!turn1.ok) return;

    // Update control room layer after saveInitialized = true and ensure it persists to disk
    const crUpdate = await runtime.updateControlRoomLayer((layer) => ({
      ...layer,
      tuningDials: { ...layer.tuningDials, cyoaEnabled: true },
    }));
    expect(isOk(crUpdate)).toBe(true);

    // Mismatched cartridge must fail cleanly
    const mismatchCartridge = await SessionRuntime.fromSaveDirectory(saveDir, {
      sessionId: 'resume-sess-1',
      cartridge: makeBaseCartridge({
        card: {
          spec: 'cartridge/0.1',
          id: 'wrong-card',
          version: '1.0.0',
          title: 'Wrong',
          description: 'Wrong',
          persona: { name: 'X', description: 'Y' },
        },
      }),
      gateway,
    });
    expect(isErr(mismatchCartridge)).toBe(true);

    // Resume from save directory
    const resumedRes = await SessionRuntime.fromSaveDirectory(saveDir, {
      sessionId: 'resume-sess-1',
      cartridge,
      systemPack: STOCK_TACTICAL_RPG_PACK,
      gateway,
      seed: 'resume-seed',
    });
    expect(isOk(resumedRes)).toBe(true);
    if (!resumedRes.ok) return;

    const resumed = resumedRes.value;
    expect(resumed.getState().meta.turn).toBe(1);
    expect(resumed.getState().player.name).toBe('Kael');
    expect(resumed.getState().scene.mood).toBe('fierce');
    expect(resumed.getActivePersona()?.name).toBe('Kael');
    expect(resumed.getConfig().tuningDials.narrativePacing).toBe('slow_burn');
    expect(resumed.getConfig().tuningDials.cyoaEnabled).toBe(true);
    expect(resumed.getCombatState()?.active).toBe(true);
    expect(resumed.getSwipeTree().activeLeafMessageId).toBe(turn1.value.assistantMessageId);

    // Continuing turns after resume produces unique messageIds & updates disk cleanly
    const turn2 = await resumed.executeTurn({
      text: 'Press the advantage!',
      combatActions: [{ type: 'defend' }],
    });
    expect(isOk(turn2)).toBe(true);
    if (!turn2.ok) return;

    expect(turn2.value.turn).toBe(2);
    expect(turn2.value.userMessageId).not.toBe(turn1.value.userMessageId);
    expect(turn2.value.assistantMessageId).not.toBe(turn1.value.assistantMessageId);
    expect(turn2.value.state.scene.mood).toBe('victorious');

    const reloadedSave = await loadSessionSave(saveDir);
    expect(isOk(reloadedSave)).toBe(true);
    if (reloadedSave.ok) {
      expect(reloadedSave.value.manifest.currentTurn).toBe(2);
      expect(getLinearTranscript(reloadedSave.value.swipeTree!)).toHaveLength(4);
    }

    // Verify replay-based resume when swipeTree is absent (e.g. legacy/checkpoint+events save)
    const replayOnlyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rp-m7-replay-resume-'));
    tempDirs.push(replayOnlyDir);
    const replayGateway = createMockModelGateway({
      narrator: ['Replay turn 1.', 'Replay turn 2.'],
      state_tracker: [
        { kind: 'json', value: { scene: { mood: 'curious' } } },
        { kind: 'json', value: { scene: { mood: 'determined' } } },
      ],
    });
    const replayRt = new SessionRuntime({
      sessionId: 'replay-sess-1',
      systemPack: STOCK_SLICE_OF_LIFE_PACK,
      gateway: replayGateway,
      saveDir: replayOnlyDir,
      seed: 'replay-seed',
    });
    expect(isOk(await replayRt.executeTurn({ text: 'Turn 1' }))).toBe(true);
    expect(isOk(await replayRt.executeTurn({ text: 'Turn 2' }))).toBe(true);
    await fs.rm(path.join(replayOnlyDir, 'swipe-tree.json'), { force: true });

    const replayResumed = await SessionRuntime.fromSaveDirectory(replayOnlyDir, {
      sessionId: 'replay-sess-1',
      systemPack: STOCK_SLICE_OF_LIFE_PACK,
      gateway: replayGateway,
      seed: 'replay-seed',
    });
    expect(isOk(replayResumed)).toBe(true);
    if (replayResumed.ok) {
      expect(replayResumed.value.getState().meta.turn).toBe(2);
      expect(replayResumed.value.getState().scene.mood).toBe('determined');
    }
  });
});
