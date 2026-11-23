import { describe, expect, it } from 'vitest';
import { runDynamicStateTracker } from '../../src/agents/dynamic-state-tracker.js';
import { resolveEffectiveControlRoomConfig } from '../../src/config/control-room-config.js';
import { createMockModelGateway } from '../../src/gateway/mock-provider.js';
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
});
