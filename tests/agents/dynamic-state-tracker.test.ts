import { describe, expect, it } from 'vitest';
import {
  normalizeTrackerResponse,
  runDynamicStateTracker,
} from '../../src/agents/dynamic-state-tracker.js';
import { resolveEffectiveControlRoomConfig } from '../../src/config/control-room-config.js';
import { createMockModelGateway } from '../../src/gateway/mock-provider.js';
import { compileActiveTrackerSchema } from '../../src/schema/dynamic-schema-compiler.js';
import { STOCK_FREEFORM_PACK } from '../../src/schema/stock-system-packs.js';
import type { GameSystemModule } from '../../src/schema/tracker-module.js';
import { applyPatchBatch } from '../../src/state/reducer.js';
import { type CharacterEntity, createWorldState } from '../../src/state/world-state.js';

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

function createCyberpunkModule(cadence: GameSystemModule['cadence']): GameSystemModule {
  return {
    id: 'cybernetics',
    name: 'Cybernetics & Humanity',
    enabled: true,
    scope: 'session',
    target: 'player',
    effectOwner: 'tracker',
    cadence,
    fields: {
      cyberpsychosis: {
        type: 'meter',
        min: 0,
        max: 100,
        default: 0,
        writableByTracker: true,
        confirmPolicy: 'auto',
        description: 'Cyberpsychosis strain meter',
      },
      cyberware: {
        type: 'string_list',
        maxItems: 10,
        default: [],
        writableByTracker: true,
        confirmPolicy: 'auto',
        description: 'Installed cyberware implants',
      },
    },
    trackerInstruction: 'Update cyberpsychosis and installed cyberware implants.',
    narratorRule: '',
    ui: { widget: 'bar', order: 2 },
  };
}

describe('runDynamicStateTracker', () => {
  it('short-circuits with zero LLM calls when cadence is not due (everyNTurns: 3)', async () => {
    const config = resolveEffectiveControlRoomConfig(STOCK_FREEFORM_PACK, {
      gameSystems: [createCyberpunkModule({ everyNTurns: 3 })],
    });
    const state = createWorldState({
      capabilities: config.capabilities,
    });
    const gateway = createMockModelGateway({
      state_tracker: {
        kind: 'json',
        value: {
          player_custom_fields: {
            cyberpsychosis: 25,
            cyberware: ['Sandevistan'],
          },
        },
      },
    });

    // Turn 1: skipped
    const turn1 = await runDynamicStateTracker({
      state,
      config,
      gateway,
      turnContext: { turn: 1, clockAdvancedThisTurn: false, combatEndedThisTurn: false },
      recentExchangeText: 'V checks her chrome.',
      latestNarratorReply: 'The clinic hums quietly.',
    });
    expect(turn1.skippedByCadence).toBe(true);
    expect(turn1.proposedBatch).toBeNull();
    expect(turn1.compiledSchema.trackerJsonSchema).toBeNull();
    expect(gateway.mockProvider.recordedCalls).toHaveLength(0);

    // Turn 2: skipped
    const turn2 = await runDynamicStateTracker({
      state,
      config,
      gateway,
      turnContext: { turn: 2, clockAdvancedThisTurn: false, combatEndedThisTurn: false },
      recentExchangeText: 'V walks down the street.',
      latestNarratorReply: 'Rain slicks the neon pavement.',
    });
    expect(turn2.skippedByCadence).toBe(true);
    expect(turn2.proposedBatch).toBeNull();
    expect(gateway.mockProvider.recordedCalls).toHaveLength(0);

    // Turn 3: due, invokes LLM once
    const turn3 = await runDynamicStateTracker({
      state,
      config,
      gateway,
      turnContext: { turn: 3, clockAdvancedThisTurn: false, combatEndedThisTurn: false },
      recentExchangeText: 'V fires up the Sandevistan.',
      latestNarratorReply: 'Time seems to fracture as chrome surges.',
    });
    expect(turn3.skippedByCadence).toBe(false);
    expect(turn3.proposedBatch).not.toBeNull();
    expect(gateway.mockProvider.recordedCalls).toHaveLength(1);
    expect(gateway.mockProvider.recordedCalls[0]?.role).toBe('state_tracker');
  });

  it('skips manual_only modules unless manualTrigger is true', async () => {
    const config = resolveEffectiveControlRoomConfig(STOCK_FREEFORM_PACK);
    const state = createWorldState({ capabilities: config.capabilities });
    const gateway = createMockModelGateway({
      state_tracker: {
        kind: 'json',
        value: {
          scene: {
            location: 'Afterlife Bar',
            mood: 'tense',
            presentCharacterIds: [],
          },
        },
      },
    });

    const autoTurn = await runDynamicStateTracker({
      state,
      config,
      gateway,
      turnContext: { turn: 1, clockAdvancedThisTurn: false, combatEndedThisTurn: false },
      recentExchangeText: 'Hello',
      latestNarratorReply: 'Hi',
    });
    expect(autoTurn.skippedByCadence).toBe(true);
    expect(gateway.mockProvider.recordedCalls).toHaveLength(0);

    const manualTurn = await runDynamicStateTracker({
      state,
      config,
      gateway,
      turnContext: {
        turn: 1,
        clockAdvancedThisTurn: false,
        combatEndedThisTurn: false,
        manualTrigger: true,
      },
      recentExchangeText: 'Entering the Afterlife.',
      latestNarratorReply: 'Bass vibrates through the booth.',
    });
    expect(manualTurn.skippedByCadence).toBe(false);
    expect(manualTurn.proposedBatch).not.toBeNull();
    expect(gateway.mockProvider.recordedCalls).toHaveLength(1);
  });

  it('extracts dynamic custom fields (cyberpsychosis + cyberware) and commits safely via applyPatchBatch', async () => {
    const config = resolveEffectiveControlRoomConfig(STOCK_FREEFORM_PACK, {
      gameSystems: [createCyberpunkModule('every_turn')],
    });
    const state = createWorldState({ capabilities: config.capabilities });
    const gateway = createMockModelGateway({
      state_tracker: {
        kind: 'json',
        value: {
          player_custom_fields: {
            cyberpsychosis: 42,
            cyberware: ['Mantis Blades', 'Kiroshi Optics'],
          },
        },
      },
    });

    const result = await runDynamicStateTracker({
      state,
      config,
      gateway,
      turnContext: { turn: 4, clockAdvancedThisTurn: false, combatEndedThisTurn: false },
      recentExchangeText: 'Ripperdoc finishes installing the Mantis Blades.',
      latestNarratorReply: 'Your neural link spikes briefly before stabilizing.',
    });

    expect(result.skippedByCadence).toBe(false);
    expect(result.warnings).toEqual([]);
    expect(result.proposedBatch).not.toBeNull();
    expect(result.proposedBatch?.source).toBe('tracker');

    const reduced = applyPatchBatch(state, result.proposedBatch!, {
      compiledSchema: result.compiledSchema,
    });
    expect(reduced.ok).toBe(true);
    if (reduced.ok) {
      expect(reduced.value.nextState.player.customFields['cyberpsychosis']).toBe(42);
      expect(reduced.value.nextState.player.customFields['cyberware']).toEqual([
        'Mantis Blades',
        'Kiroshi Optics',
      ]);
      expect(reduced.value.rejectedOperations).toHaveLength(0);
    }
  });

  it('normalizes emergent scene location, sections, and relationships into valid PatchOperations', async () => {
    const config = resolveEffectiveControlRoomConfig(STOCK_FREEFORM_PACK, {
      capabilities: {
        spatialMode: 'emergent',
        relationships: true,
      },
      pcCoreSections: [
        {
          id: 'condition',
          name: 'Condition',
          description: 'Physical condition',
          icon: 'heart',
          color: '#ff0000',
          fieldType: 'prose',
          writableByTracker: true,
          confirmPolicy: 'auto',
          cadence: 'every_turn',
        },
      ],
      npcCoreSections: [
        {
          id: 'attitude',
          name: 'Attitude',
          description: 'Current attitude',
          icon: 'smile',
          color: '#00ff00',
          fieldType: 'prose',
          writableByTracker: true,
          confirmPolicy: 'auto',
          cadence: 'every_turn',
        },
      ],
      gameSystemOverrides: {
        scene_context: {
          cadence: 'every_turn',
        },
      },
    });

    const judy = makeCharacter({ id: 'judy', name: 'Judy Alvarez' });
    const state = createWorldState({
      capabilities: config.capabilities,
      entities: { characters: { judy } },
    });

    const gateway = createMockModelGateway({
      state_tracker: {
        kind: 'json',
        value: {
          scene: {
            location: 'Lizzie Bar Basement',
            mood: 'intrigue',
          },
          pc_sections: {
            condition: 'fatigued',
          },
          npc_sections: [
            {
              characterId: 'judy',
              attitude: 'cautiously hopeful',
            },
          ],
          relationships: [
            {
              fromId: 'player',
              toId: 'judy',
              affinityDelta: 15,
              label: 'trusted ally',
              tags: ['techie', 'confidant'],
            },
          ],
        },
      },
    });

    const result = await runDynamicStateTracker({
      state,
      config,
      gateway,
      turnContext: { turn: 5, clockAdvancedThisTurn: false, combatEndedThisTurn: false },
      recentExchangeText: 'We head down to the Lizzie Bar Basement.',
      latestNarratorReply: 'Judy nods in appreciation.',
    });

    expect(result.proposedBatch).not.toBeNull();
    const ops = result.proposedBatch!.operations;
    expect(ops.some((op) => op.op === 'emergent_location_visit' && op.locationName === 'Lizzie Bar Basement')).toBe(
      true
    );
    expect(ops.some((op) => op.op === 'section_patch' && op.sectionId === 'condition')).toBe(true);
    expect(ops.some((op) => op.op === 'section_patch' && op.sectionId === 'attitude')).toBe(true);

    const reduced = applyPatchBatch(state, result.proposedBatch!, {
      compiledSchema: result.compiledSchema,
    });
    expect(reduced.ok).toBe(true);
    if (reduced.ok) {
      const next = reduced.value.nextState;
      expect(next.scene.location).toBe('Lizzie Bar Basement');
      expect(next.scene.locationId).toBe('lizzie-bar-basement');
      expect(next.player.sections['condition']).toBe('fatigued');
      expect(next.entities.characters['judy']?.sections['attitude']).toBe('cautiously hopeful');
      expect(next.relations['player']?.['judy']?.affinity).toBe(15);
      expect(next.relations['player']?.['judy']?.label).toBe('trusted ally');
      expect(next.relations['player']?.['judy']?.tags).toEqual(['techie', 'confidant']);
    }
  });

  it('degrades gracefully on gateway errors without throwing', async () => {
    const config = resolveEffectiveControlRoomConfig(STOCK_FREEFORM_PACK, {
      gameSystems: [createCyberpunkModule('every_turn')],
    });
    const state = createWorldState({ capabilities: config.capabilities });
    const gateway = createMockModelGateway({
      state_tracker: {
        kind: 'error',
        code: 'PROVIDER_TIMEOUT',
        message: 'Simulated tracker timeout',
      },
    });

    const result = await runDynamicStateTracker({
      state,
      config,
      gateway,
      turnContext: { turn: 1, clockAdvancedThisTurn: false, combatEndedThisTurn: false },
      recentExchangeText: 'Exchange',
      latestNarratorReply: 'Reply',
    });

    expect(result.skippedByCadence).toBe(false);
    expect(result.proposedBatch).toBeNull();
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('ignores unknown characters and prototype-pollution keys safely', async () => {
    const config = resolveEffectiveControlRoomConfig(STOCK_FREEFORM_PACK, {
      npcCoreSections: [
        {
          id: 'notes',
          name: 'Notes',
          description: 'Notes',
          icon: 'file',
          color: '#888888',
          fieldType: 'prose',
          writableByTracker: true,
          confirmPolicy: 'auto',
          cadence: 'every_turn',
        },
      ],
    });
    const state = createWorldState({ capabilities: config.capabilities });
    const gateway = createMockModelGateway({
      state_tracker: {
        kind: 'json',
        value: {
          npc_sections: [
            { characterId: '__proto__', notes: 'bad' },
            { characterId: 'ghost_npc', notes: 'missing' },
          ],
        },
      },
    });

    const result = await runDynamicStateTracker({
      state,
      config,
      gateway,
      turnContext: { turn: 1, clockAdvancedThisTurn: false, combatEndedThisTurn: false },
      recentExchangeText: 'Exchange',
      latestNarratorReply: 'Reply',
    });

    expect(result.proposedBatch).toBeNull();
    expect(result.warnings.length).toBe(2);
    expect(({} as Record<string, unknown>)['notes']).toBeUndefined();
  });

  it('auto-registers emergent NPCs before same-turn sections, custom fields, moods, and relationships', async () => {
    const config = resolveEffectiveControlRoomConfig(STOCK_FREEFORM_PACK, {
      capabilities: {
        spatialMode: 'emergent',
        relationships: true,
      },
      npcCoreSections: [
        {
          id: 'sec_personality',
          name: 'Personality',
          description: 'Personality',
          icon: 'brain',
          color: '#8b5cf6',
          fieldType: 'prose',
          writableByTracker: true,
          confirmPolicy: 'auto',
          cadence: 'every_turn',
        },
        {
          id: 'sec_attitude',
          name: 'Attitude',
          description: 'Attitude',
          icon: 'smile',
          color: '#00ff00',
          fieldType: 'prose',
          writableByTracker: true,
          confirmPolicy: 'auto',
          cadence: 'every_turn',
        },
      ],
      gameSystems: [
        {
          id: 'npc_secrets',
          name: 'NPC Secrets',
          enabled: true,
          scope: 'session',
          target: 'npc',
          effectOwner: 'tracker',
          cadence: 'every_turn',
          fields: {
            suspicion: {
              type: 'counter',
              min: 0,
              max: 10,
              default: 0,
              writableByTracker: true,
              confirmPolicy: 'auto',
            },
          },
          trackerInstruction: 'Track suspicion.',
          narratorRule: '',
          ui: { widget: 'badge', order: 1 },
        },
      ],
    });

    const state = createWorldState({ capabilities: config.capabilities });
    const gateway = createMockModelGateway({
      state_tracker: {
        kind: 'json',
        value: {
          new_characters: [
            {
              id: 'Elena Vance!',
              name: 'Elena Vance',
              mood: 'guarded',
              allegiance: 'Independent',
              traits: ['observant', 'sharp-tongued'],
              presentInScene: true,
              sections: {
                sec_personality: 'Calculating yet fair',
              },
            },
          ],
          npc_sections: [
            {
              characterId: 'elena_vance',
              sec_attitude: 'cautious curiosity',
            },
          ],
          npc_custom_fields: [
            {
              characterId: 'elena_vance',
              suspicion: 2,
            },
          ],
          relationships: [
            {
              fromId: 'player',
              toId: 'elena_vance',
              affinityDelta: 10,
              label: 'acquaintance',
              tags: ['contact'],
            },
          ],
        },
      },
    });

    const result = await runDynamicStateTracker({
      state,
      config,
      gateway,
      turnContext: { turn: 2, clockAdvancedThisTurn: false, combatEndedThisTurn: false },
      recentExchangeText: 'A woman in a trench coat steps into the alley.',
      latestNarratorReply: 'Elena Vance inclines her head and studies you.',
      autoRegisterEmergentNpcs: true,
    });

    expect(result.skippedByCadence).toBe(false);
    expect(result.warnings).toEqual([]);
    expect(result.proposedBatch).not.toBeNull();

    const ops = result.proposedBatch!.operations;
    expect(ops[0]?.op).toBe('character_upsert');
    const firstNonUpsertIdx = ops.findIndex((op) => op.op !== 'character_upsert');
    expect(firstNonUpsertIdx).toBeGreaterThan(0);
    expect(ops.slice(firstNonUpsertIdx).every((op) => op.op !== 'character_upsert')).toBe(true);

    const reduced = applyPatchBatch(state, result.proposedBatch!, {
      compiledSchema: result.compiledSchema,
    });
    expect(reduced.ok).toBe(true);
    if (reduced.ok) {
      const elena = reduced.value.nextState.entities.characters['elena_vance'];
      expect(elena).toBeDefined();
      expect(elena?.name).toBe('Elena Vance');
      expect(elena?.allegiance).toBe('Independent');
      expect(elena?.traits).toEqual(['observant', 'sharp-tongued']);
      expect(elena?.mood).toBe('guarded');
      expect(elena?.sections['sec_personality']).toBe('Calculating yet fair');
      expect(elena?.sections['sec_attitude']).toBe('cautious curiosity');
      expect(elena?.customFields['suspicion']).toBe(2);
      expect(reduced.value.nextState.relations['player']?.['elena_vance']?.affinity).toBe(10);
      expect(reduced.value.nextState.relations['player']?.['elena_vance']?.label).toBe(
        'acquaintance'
      );
    }
  });

  it('caps new_characters at 5 per turn, blocks unsafe/player/existing IDs, and respects section confirmPolicy', async () => {
    const config = resolveEffectiveControlRoomConfig(STOCK_FREEFORM_PACK, {
      npcCoreSections: [
        {
          id: 'sec_auto',
          name: 'Auto',
          description: 'Auto',
          icon: 'file',
          color: '#111111',
          fieldType: 'prose',
          writableByTracker: true,
          confirmPolicy: 'auto',
          cadence: 'every_turn',
        },
        {
          id: 'sec_locked',
          name: 'Locked',
          description: 'Locked',
          icon: 'lock',
          color: '#222222',
          fieldType: 'prose',
          writableByTracker: false,
          confirmPolicy: 'locked',
          cadence: 'every_turn',
        },
        {
          id: 'sec_confirm',
          name: 'Confirm',
          description: 'Confirm',
          icon: 'check',
          color: '#333333',
          fieldType: 'prose',
          writableByTracker: true,
          confirmPolicy: 'batch_confirm',
          cadence: 'every_turn',
        },
      ],
    });

    const existingNpc = makeCharacter({ id: 'existing_npc', name: 'Existing NPC' });
    const pcEntity = makeCharacter({ id: 'pc_hero', name: 'Hero' });
    const state = createWorldState({
      capabilities: config.capabilities,
      player: {
        id: 'player',
        name: 'Hero',
        characterId: 'pc_hero',
        locationId: null,
        inventory: { items: {}, currency: {} },
        customFields: {},
        sections: {},
      },
      entities: {
        characters: {
          existing_npc: existingNpc,
          pc_hero: pcEntity,
        },
      },
    });

    const gateway = createMockModelGateway({
      state_tracker: {
        kind: 'json',
        value: {
          new_characters: [
            { id: '__proto__', name: 'Proto' },
            { id: 'constructor', name: 'Ctor' },
            { id: 'prototype', name: 'ProtoType' },
            { id: 'player', name: 'Fake Player' },
            { id: 'pc_hero', name: 'Fake PC' },
            { id: 'existing_npc', name: 'Overwrite Attempt' },
            {
              id: 'npc_one',
              name: 'NPC One',
              sections: {
                sec_auto: 'Allowed',
                sec_confirm: 'Needs confirmation',
              },
            },
            { id: 'npc_one', name: 'Duplicate NPC One' },
            { id: 'npc_two', name: 'NPC Two' },
            { id: 'npc_three', name: 'NPC Three' },
            { id: 'npc_four', name: 'NPC Four' },
            { id: 'npc_five', name: 'NPC Five' },
            { id: 'npc_six', name: 'NPC Six Over Cap' },
          ],
        },
      },
    });

    const result = await runDynamicStateTracker({
      state,
      config,
      gateway,
      turnContext: { turn: 1, clockAdvancedThisTurn: false, combatEndedThisTurn: false },
      recentExchangeText: 'A crowded tavern.',
      latestNarratorReply: 'Six patrons turn toward you.',
      autoRegisterEmergentNpcs: true,
    });

    expect(result.proposedBatch).not.toBeNull();
    const ops = result.proposedBatch!.operations;
    const upserts = ops.filter((op) => op.op === 'character_upsert');
    expect(upserts).toHaveLength(5);
    expect(upserts.map((op) => op.characterId)).toEqual([
      'npc_one',
      'npc_two',
      'npc_three',
      'npc_four',
      'npc_five',
    ]);

    // batch_confirm diverted to section_patch after upserts
    const npcOneUpsert = upserts[0] as Extract<(typeof ops)[number], { op: 'character_upsert' }>;
    expect(npcOneUpsert.character.sections).toEqual({ sec_auto: 'Allowed' });

    const sectionPatches = ops.filter((op) => op.op === 'section_patch');
    expect(sectionPatches).toEqual([
      {
        op: 'section_patch',
        target: { characterId: 'npc_one' },
        sectionId: 'sec_confirm',
        value: 'Needs confirmation',
      },
    ]);
    // All character_upsert ops appear before any section_patch
    const lastUpsertIdx = ops.reduce((acc, op, idx) => (op.op === 'character_upsert' ? idx : acc), -1);
    const firstPatchIdx = ops.findIndex((op) => op.op === 'section_patch');
    expect(lastUpsertIdx).toBeLessThan(firstPatchIdx);

    expect(result.warnings.some((w) => w.code === 'UNSAFE_KEY')).toBe(true);
    expect(result.warnings.some((w) => w.code === 'PLAYER_ID_CONFLICT')).toBe(true);
    expect(result.warnings.some((w) => w.code === 'CHARACTER_ALREADY_EXISTS')).toBe(true);
    expect(result.warnings.some((w) => w.code === 'MAX_EMERGENT_NPCS_EXCEEDED')).toBe(true);

    const reduced = applyPatchBatch(state, result.proposedBatch!, {
      compiledSchema: result.compiledSchema,
    });
    expect(reduced.ok).toBe(true);
    if (reduced.ok) {
      const next = reduced.value.nextState;
      expect(next.entities.characters['npc_one']?.sections).toEqual({ sec_auto: 'Allowed' });
      expect(next.entities.characters['npc_six']).toBeUndefined();
      expect(next.entities.characters['existing_npc']?.name).toBe('Existing NPC');
      expect(reduced.value.pendingConfirmations).toEqual([
        {
          op: 'section_patch',
          target: { characterId: 'npc_one' },
          sectionId: 'sec_confirm',
          value: 'Needs confirmation',
        },
      ]);
    }
  });

  it('strips locked initial sections and supports same-turn moods when normalizing new_characters directly', () => {
    const config = resolveEffectiveControlRoomConfig(STOCK_FREEFORM_PACK, {
      npcCoreSections: [
        {
          id: 'sec_auto',
          name: 'Auto',
          description: 'Auto',
          icon: 'file',
          color: '#111111',
          fieldType: 'prose',
          writableByTracker: true,
          confirmPolicy: 'auto',
          cadence: 'every_turn',
        },
        {
          id: 'sec_locked',
          name: 'Locked',
          description: 'Locked',
          icon: 'lock',
          color: '#222222',
          fieldType: 'prose',
          writableByTracker: false,
          confirmPolicy: 'locked',
          cadence: 'every_turn',
        },
      ],
    });
    const state = createWorldState({ capabilities: config.capabilities });
    const compiledSchema = compileActiveTrackerSchema(config, {
      turn: 1,
      clockAdvancedThisTurn: false,
      combatEndedThisTurn: false,
      autoRegisterEmergentNpcs: true,
    });

    const normalized = normalizeTrackerResponse(
      {
        new_characters: [
          {
            id: 'Captain Aria',
            name: 'Captain Aria',
            mood: 'calm',
            sections: {
              sec_auto: 'Sharp eyes',
              sec_locked: 'Secret royal blood',
            },
          },
        ],
        moods: [{ characterId: 'captain_aria', mood: 'alert' }],
      },
      state,
      1,
      compiledSchema,
      true
    );

    expect(normalized.warnings.some((w) => w.code === 'LOCKED_SECTION')).toBe(true);
    expect(normalized.batch).not.toBeNull();
    const ops = normalized.batch!.operations;
    expect(ops[0]).toEqual({
      op: 'character_upsert',
      characterId: 'captain_aria',
      character: {
        name: 'Captain Aria',
        mood: 'calm',
        presentInScene: true,
        sections: { sec_auto: 'Sharp eyes' },
      },
      mergeIfExists: false,
    });
    expect(ops[1]).toEqual({
      op: 'entity_patch',
      collection: 'characters',
      entityId: 'captain_aria',
      patch: { mood: 'alert' },
    });

    const reduced = applyPatchBatch(state, normalized.batch!, { compiledSchema });
    expect(reduced.ok).toBe(true);
    if (reduced.ok) {
      const aria = reduced.value.nextState.entities.characters['captain_aria'];
      expect(aria?.mood).toBe('alert');
      expect(aria?.sections).toEqual({ sec_auto: 'Sharp eyes' });
    }
  });

  it('ignores new_characters when autoRegisterEmergentNpcs is falsy', async () => {
    const config = resolveEffectiveControlRoomConfig(STOCK_FREEFORM_PACK, {
      npcCoreSections: [
        {
          id: 'sec_notes',
          name: 'Notes',
          description: 'Notes',
          icon: 'file',
          color: '#888888',
          fieldType: 'prose',
          writableByTracker: true,
          confirmPolicy: 'auto',
          cadence: 'every_turn',
        },
      ],
    });
    const state = createWorldState({ capabilities: config.capabilities });
    const gateway = createMockModelGateway({
      state_tracker: {
        kind: 'json',
        value: {
          new_characters: [{ id: 'stranger', name: 'Stranger' }],
          npc_sections: [{ characterId: 'stranger', sec_notes: 'Tall' }],
        },
      },
    });

    const result = await runDynamicStateTracker({
      state,
      config,
      gateway,
      turnContext: { turn: 1, clockAdvancedThisTurn: false, combatEndedThisTurn: false },
      recentExchangeText: 'A stranger passes by.',
      latestNarratorReply: 'They vanish into the crowd.',
    });

    expect(result.skippedByCadence).toBe(false);
    expect(result.proposedBatch).toBeNull();
    expect(result.warnings.length).toBeGreaterThan(0);

    const directIgnored = normalizeTrackerResponse(
      {
        new_characters: [{ id: 'stranger', name: 'Stranger' }],
        npc_sections: [{ characterId: 'stranger', sec_notes: 'Tall' }],
      },
      state,
      1,
      result.compiledSchema,
      false
    );
    expect(directIgnored.batch).toBeNull();
    expect(directIgnored.warnings).toHaveLength(1);
    expect(directIgnored.warnings[0]?.code).toBe('UNKNOWN_CHARACTER');
  });
});
