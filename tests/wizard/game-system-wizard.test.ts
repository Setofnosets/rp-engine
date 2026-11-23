import { describe, expect, it } from 'vitest';
import { isErr, isOk } from '../../src/core/result.js';
import { createMockModelGateway } from '../../src/gateway/mock-provider.js';
import { compileActiveTrackerSchema } from '../../src/schema/dynamic-schema-compiler.js';
import { getStockSystemPack } from '../../src/schema/stock-system-packs.js';
import type { GameSystemModule } from '../../src/schema/tracker-module.js';
import {
  GameSystemWizard,
  type WizardGeneratedSystem,
} from '../../src/wizard/game-system-wizard.js';
import {
  GAME_SYSTEM_WIZARD_OUTPUT_SCHEMA,
  buildWizardSystemPrompt,
  buildWizardUserMessages,
} from '../../src/wizard/wizard-prompts.js';

function createSurvivalPayload(): Omit<WizardGeneratedSystem, 'rawText'> {
  return {
    module: {
      id: 'survival_sustenance',
      name: 'Survival Sustenance (Hunger & Thirst)',
      description: 'Tracks player hunger and hydration across time slots.',
      enabled: true,
      scope: 'session',
      target: 'player',
      effectOwner: 'hybrid',
      cadence: 'every_turn',
      fields: {
        hunger: {
          type: 'meter',
          min: 0,
          max: 100,
          default: 100,
          writableByTracker: true,
          confirmPolicy: 'auto',
          description: 'Satiety meter (100 = full, 0 = starving)',
        },
        thirst: {
          type: 'meter',
          min: 0,
          max: 100,
          default: 100,
          writableByTracker: true,
          confirmPolicy: 'auto',
          description: 'Hydration meter (100 = hydrated, 0 = parched)',
        },
      },
      trackerInstruction:
        'Increase hunger or thirst when the player eats food or drinks water; avoid manual decay since clock triggers handle slot ticks.',
      narratorRule:
        'When hunger or thirst falls below 30, weave physical fatigue, dry mouth, or stomach pangs organically into prose.',
      ui: {
        widget: 'bar',
        order: 10,
      },
    },
    clockTriggers: [
      {
        on: 'slot',
        op: 'increment',
        field: 'hunger',
        value: -10,
      },
      {
        on: 'slot',
        op: 'increment',
        field: 'thirst',
        value: -15,
      },
    ],
    suggestedBeats: [
      {
        id: 'beat_low_hunger_nudge',
        class: 'nudge',
        priority: 80,
        when: {
          field: 'hunger',
          lte: 25,
        },
        nudge: 'Highlight growing weakness from hunger and hint at nearby rations or foraging options.',
      },
    ],
    previewCard: {
      title: 'Survival Sustenance',
      hunger: 100,
      thirst: 100,
    },
  };
}

describe('wizard-prompts', () => {
  it('builds role-appropriate Architect system prompts and supports custom overrides', () => {
    const enginePrompt = buildWizardSystemPrompt({ effectOwner: 'engine' });
    expect(enginePrompt).toContain('GAME_SYSTEM_WIZARD_OUTPUT_SCHEMA');
    expect(enginePrompt).toContain('Ownership mode: "engine"');
    expect(enginePrompt).toContain('writableByTracker: false');

    const trackerPrompt = buildWizardSystemPrompt({ effectOwner: 'tracker' });
    expect(trackerPrompt).toContain('Ownership mode: "tracker"');
    expect(trackerPrompt).toContain('writableByTracker: true');

    const hybridPrompt = buildWizardSystemPrompt({ effectOwner: 'hybrid' });
    expect(hybridPrompt).toContain('Ownership mode: "hybrid"');

    const custom = 'Custom wizard prompt for strict sci-fi ship fuel systems.';
    expect(buildWizardSystemPrompt({ effectOwner: 'hybrid', customPromptOverride: custom })).toBe(
      custom
    );
    expect(
      buildWizardSystemPrompt({ effectOwner: 'hybrid', customPromptOverride: '   ' })
    ).toContain('Referee Engine Game System Architect');
  });

  it('builds initial and refinement ChatMessages cleanly', () => {
    const initialMessages = buildWizardUserMessages({
      description: 'Track radiation exposure on the player.',
      effectOwner: 'hybrid',
      target: 'player',
      loreContext: 'Post-apocalyptic wasteland.',
    });
    expect(initialMessages).toHaveLength(1);
    expect(initialMessages[0]?.role).toBe('user');
    expect(initialMessages[0]?.content).toContain('Track radiation exposure');
    expect(initialMessages[0]?.content).toContain('Target entity scope: player');
    expect(initialMessages[0]?.content).toContain('Post-apocalyptic wasteland.');

    const draft = createSurvivalPayload().module;
    const refineMessages = buildWizardUserMessages({
      description: 'Survival sustenance system',
      previousDraft: draft,
      refinementFeedback: 'Add a hypothermia meter and change widget to card.',
    });
    expect(refineMessages).toHaveLength(3);
    expect(refineMessages[0]?.role).toBe('user');
    expect(refineMessages[1]?.role).toBe('assistant');
    expect(refineMessages[1]?.content).toContain('"survival_sustenance"');
    expect(refineMessages[2]?.role).toBe('user');
    expect(refineMessages[2]?.content).toContain('Add a hypothermia meter');
  });
});

describe('GameSystemWizard', () => {
  it('generates Survival Sustenance (Hunger & Thirst) with clockTriggers and nudge beat and compiles cleanly', async () => {
    const survivalPayload = createSurvivalPayload();
    const gateway = createMockModelGateway({
      game_system_wizard: {
        kind: 'json',
        value: survivalPayload,
      },
    });
    const wizard = new GameSystemWizard(gateway);

    const res = await wizard.generateSystem({
      description:
        'Survival Sustenance (Hunger & Thirst) for the player with -10 hunger per slot and a low-hunger nudge beat.',
      effectOwner: 'hybrid',
      target: 'player',
      loreContext: 'Harsh wilderness expedition.',
    });

    expect(isOk(res)).toBe(true);
    if (!isOk(res)) {
      return;
    }

    const generated = res.value;
    expect(generated.module.id).toBe('survival_sustenance');
    expect(generated.module.target).toBe('player');
    expect(generated.clockTriggers).toEqual([
      { on: 'slot', op: 'increment', field: 'hunger', value: -10 },
      { on: 'slot', op: 'increment', field: 'thirst', value: -15 },
    ]);
    expect(generated.suggestedBeats).toHaveLength(1);
    expect(generated.suggestedBeats[0]?.class).toBe('nudge');
    expect(generated.previewCard).toEqual({
      title: 'Survival Sustenance',
      hunger: 100,
      thirst: 100,
    });
    expect(generated.rawText).toContain('survival_sustenance');

    // Verify gateway call metadata
    const recorded = gateway.mockProvider.getCallsForRole('game_system_wizard');
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.schema).toEqual(GAME_SYSTEM_WIZARD_OUTPUT_SCHEMA);
    expect(recorded[0]?.schemaName).toBe('game_system_wizard_output');
    expect(recorded[0]?.messages[0]?.role).toBe('system');
    expect(recorded[0]?.messages[1]?.content).toContain('Harsh wilderness expedition.');

    // Verify immediate compilation with compileActiveTrackerSchema
    const basePack = getStockSystemPack('stock-slice-of-life');
    expect(basePack).toBeDefined();
    basePack!.gameSystems.push(generated.module);

    const compiled = compileActiveTrackerSchema(basePack!, {
      turn: 1,
      clockAdvancedThisTurn: false,
      combatEndedThisTurn: false,
    });

    expect(compiled.dueModuleIds).toContain('survival_sustenance');
    expect(compiled.activeNarratorRules).toContain(generated.module.narratorRule);
    expect(compiled.activeTrackerInstructions).toContain(generated.module.trackerInstruction);
    expect(compiled.fieldPolicyMap.get('entities.characters.player.custom_fields.hunger')?.spec.type).toBe(
      'meter'
    );
    expect(compiled.fieldPolicyMap.get('entities.characters.player.custom_fields.thirst')?.spec.type).toBe(
      'meter'
    );

    const rootProps = compiled.trackerJsonSchema?.['properties'] as Record<string, unknown>;
    const playerCustomProps = (rootProps['player_custom_fields'] as Record<string, unknown>)[
      'properties'
    ] as Record<string, unknown>;
    expect(playerCustomProps['hunger']).toEqual({
      type: 'number',
      minimum: 0,
      maximum: 100,
      description: 'Satiety meter (100 = full, 0 = starving)',
    });
    expect(playerCustomProps['thirst']).toEqual({
      type: 'number',
      minimum: 0,
      maximum: 100,
      description: 'Hydration meter (100 = hydrated, 0 = parched)',
    });

    // Verify human-readable preview summary
    const summary = wizard.renderPreviewSummary(generated);
    expect(summary).toContain('Survival Sustenance (Hunger & Thirst) (survival_sustenance)');
    expect(summary).toContain('HUD Preview Card:');
    expect(summary).toContain('Narrator Rule:');
    expect(summary).toContain('[slot] hunger increment -10');
    expect(summary).toContain('[nudge] beat_low_hunger_nudge');
  });

  it('supports refinement iteration given previousDraft and refinementFeedback', async () => {
    const initialDraft = createSurvivalPayload().module;
    const refinedPayload = createSurvivalPayload();
    refinedPayload.module.fields['warmth'] = {
      type: 'meter',
      min: 0,
      max: 100,
      default: 80,
      writableByTracker: true,
      confirmPolicy: 'auto',
      description: 'Body warmth meter in freezing weather',
    };
    refinedPayload.module.ui.widget = 'card';
    refinedPayload.clockTriggers.push({
      on: 'slot',
      op: 'increment',
      field: 'warmth',
      value: -5,
    });

    const gateway = createMockModelGateway({
      game_system_wizard: {
        kind: 'json',
        value: refinedPayload,
      },
    });
    const wizard = new GameSystemWizard(gateway);

    const res = await wizard.generateSystem({
      description: 'Survival sustenance system for arctic expeditions.',
      effectOwner: 'hybrid',
      target: 'player',
      previousDraft: initialDraft,
      refinementFeedback: 'Add a warmth meter that drops by 5 each slot and use a card widget.',
    });

    expect(isOk(res)).toBe(true);
    if (!isOk(res)) {
      return;
    }

    expect(res.value.module.fields['warmth']?.type).toBe('meter');
    expect(res.value.module.ui.widget).toBe('card');
    expect(res.value.clockTriggers).toHaveLength(3);

    const calls = gateway.mockProvider.getCallsForRole('game_system_wizard');
    expect(calls).toHaveLength(1);
    const messages = calls[0]?.messages ?? [];
    expect(messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(messages[2]?.content).toContain('"survival_sustenance"');
    expect(messages[3]?.content).toContain('Add a warmth meter that drops by 5 each slot');
  });

  it('rejects a clockTrigger referencing a nonexistent module field', async () => {
    const badTriggerPayload = createSurvivalPayload();
    badTriggerPayload.clockTriggers.push({
      on: 'day',
      op: 'increment',
      field: 'phantom_stamina',
      value: -20,
    });

    const gateway = createMockModelGateway({
      game_system_wizard: {
        kind: 'json',
        value: badTriggerPayload,
      },
    });
    const wizard = new GameSystemWizard(gateway);

    const res = await wizard.generateSystem({
      description: 'Survival system',
      effectOwner: 'hybrid',
    });

    expect(isErr(res)).toBe(true);
    if (isErr(res)) {
      expect(
        res.error.some(
          (e) => e.path === 'clockTriggers[2].field' && e.code === 'UNKNOWN_TRIGGER_FIELD'
        )
      ).toBe(true);
    }
  });

  it('rejects invalid GameSystemModule field specifications (semantic and structural)', async () => {
    // 1. Semantic failure caught by validateGameSystemModule (meter min > max)
    const invalidRangePayload = createSurvivalPayload();
    invalidRangePayload.module.fields['hunger'] = {
      type: 'meter',
      min: 100,
      max: 10,
      default: 50,
      writableByTracker: true,
    };

    // 2. Semantic failure caught by validateGameSystemModule (enum default not in options)
    const invalidEnumPayload = createSurvivalPayload();
    invalidEnumPayload.module.fields['state'] = {
      type: 'enum',
      options: ['fed', 'hungry'],
      default: 'starving',
      writableByTracker: true,
    };

    // 3. Structural schema failure caught by ModelGateway schema check
    const invalidTypePayload = {
      module: {
        ...createSurvivalPayload().module,
        fields: {
          broken: {
            type: 'unknown_kind',
            default: 1,
            writableByTracker: true,
          },
        },
      },
    };

    const gateway = createMockModelGateway({
      game_system_wizard: [
        { kind: 'json', value: invalidRangePayload },
        { kind: 'json', value: invalidEnumPayload },
        { kind: 'json', value: invalidTypePayload },
      ],
    });
    const wizard = new GameSystemWizard(gateway);

    const res1 = await wizard.generateSystem({ description: 'Bad meter range' });
    expect(isErr(res1)).toBe(true);
    if (isErr(res1)) {
      expect(
        res1.error.some((e) => e.path === 'module.fields.hunger.min' && e.code === 'INVALID_RANGE')
      ).toBe(true);
    }

    const res2 = await wizard.generateSystem({ description: 'Bad enum default' });
    expect(isErr(res2)).toBe(true);
    if (isErr(res2)) {
      expect(
        res2.error.some(
          (e) => e.path === 'module.fields.state.default' && e.code === 'INVALID_DEFAULT'
        )
      ).toBe(true);
    }

    const res3 = await wizard.generateSystem({ description: 'Unsupported field type' });
    expect(isErr(res3)).toBe(true);
    if (isErr(res3)) {
      expect(res3.error.length).toBeGreaterThan(0);
    }
  });

  it('rejects malformed suggestedBeats, non-numeric increment clockTriggers, and empty requests', async () => {
    const gateway = createMockModelGateway({
      game_system_wizard: [
        {
          kind: 'json',
          value: {
            module: createSurvivalPayload().module,
            clockTriggers: [
              {
                on: 'turn',
                op: 'increment',
                field: 'hunger',
                value: 'not_a_number',
              },
            ],
            suggestedBeats: [
              {
                id: 'dup_beat',
                class: 'ambient',
                priority: 10,
                when: { hunger: 50 },
                nudge: 'First beat.',
              },
              {
                id: 'dup_beat',
                class: 'nudge',
                priority: 20,
                when: { hunger: 10 },
                nudge: '   ',
              },
            ],
          },
        },
      ],
    });
    const wizard = new GameSystemWizard(gateway);

    const emptyRes = await wizard.generateSystem({ description: '   ' });
    expect(isErr(emptyRes)).toBe(true);
    if (isErr(emptyRes)) {
      expect(emptyRes.error[0]?.code).toBe('REQUIRED');
    }

    const invalidRes = await wizard.generateSystem({ description: 'Check triggers and beats' });
    expect(isErr(invalidRes)).toBe(true);
    if (isErr(invalidRes)) {
      expect(
        invalidRes.error.some(
          (e) => e.path === 'clockTriggers[0].value' && e.code === 'INVALID_TRIGGER_VALUE'
        )
      ).toBe(true);
      expect(
        invalidRes.error.some(
          (e) => e.path === 'suggestedBeats[1].id' && e.code === 'DUPLICATE_BEAT_ID'
        )
      ).toBe(true);
      expect(
        invalidRes.error.some(
          (e) => e.path === 'suggestedBeats[1].nudge' && e.code === 'REQUIRED'
        )
      ).toBe(true);
    }
  });

  it('synthesizes a fallback previewCard when optional fields are omitted and honors AbortSignal and JSON repair', async () => {
    const minimalModule: GameSystemModule = {
      id: 'sanity_meter',
      name: 'Sanity',
      enabled: true,
      scope: 'session',
      target: 'player',
      effectOwner: 'tracker',
      cadence: { everyNTurns: 2 },
      fields: {
        composure: {
          type: 'counter',
          min: 0,
          max: 10,
          default: 10,
          writableByTracker: true,
        },
      },
      trackerInstruction: 'Adjust composure after eldritch encounters.',
      narratorRule: 'Describe mounting paranoia as composure drops.',
      ui: { widget: 'badge', order: 4 },
    };

    const fencedJson = [
      '```json',
      JSON.stringify({ module: minimalModule }),
      '```',
    ].join('\n');

    const gateway = createMockModelGateway({
      game_system_wizard: [fencedJson],
    });
    const wizard = new GameSystemWizard(gateway);

    const okRes = await wizard.generateSystem({
      description: 'Eldritch sanity composure tracker.',
      effectOwner: 'tracker',
      customSystemPrompt: 'Always output minimal JSON.',
    });

    expect(isOk(okRes)).toBe(true);
    if (isOk(okRes)) {
      expect(okRes.value.clockTriggers).toEqual([]);
      expect(okRes.value.suggestedBeats).toEqual([]);
      expect(okRes.value.previewCard).toEqual({
        id: 'sanity_meter',
        name: 'Sanity',
        widget: 'badge',
        target: 'player',
        fields: { composure: 10 },
      });

      const summary = wizard.renderPreviewSummary(okRes.value);
      expect(summary).toContain('every 2 turns');
      expect(summary).toContain('composure: counter [0..10], default=10 (tracker-writable)');
    }

    const controller = new AbortController();
    controller.abort();
    const abortedRes = await wizard.generateSystem(
      { description: 'Should abort immediately' },
      controller.signal
    );
    expect(isErr(abortedRes)).toBe(true);
    if (isErr(abortedRes)) {
      expect(abortedRes.error[0]?.code).toBe('ABORTED');
    }
  });

  it('guards against mutation leaks and prototype-polluting keys in returned data', async () => {
    const sourcePayload = createSurvivalPayload();
    const rawWithProto = JSON.stringify({
      ...sourcePayload,
      previewCard: {
        title: 'Safe Card',
        nested: { tags: ['a', 'b'] },
      },
    });
    // Inject a literal "__proto__" key inside JSON text to ensure cloning skips it safely
    const payloadText = rawWithProto.replace(
      '"title":"Safe Card"',
      '"title":"Safe Card","__proto__":{"polluted":true}'
    );

    const gateway = createMockModelGateway({
      game_system_wizard: [payloadText],
    });
    const wizard = new GameSystemWizard(gateway);

    const res = await wizard.generateSystem({ description: 'Check isolation' });
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) {
      return;
    }

    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(res.value.previewCard, '__proto__')).toBe(false);

    // Mutate returned arrays/objects without affecting subsequent compilations or original fixture
    res.value.module.fields['hunger']!.description = 'Mutated';
    expect(sourcePayload.module.fields['hunger']?.description).not.toBe('Mutated');
  });

  it('rejects numeric clockTrigger ops on non-numeric fields while permitting set on booleans', async () => {
    const baseModule: GameSystemModule = {
      ...createSurvivalPayload().module,
      fields: {
        exhausted: {
          type: 'boolean',
          default: false,
          writableByTracker: true,
        },
      },
    };

    const gateway = createMockModelGateway({
      game_system_wizard: [
        {
          kind: 'json',
          value: {
            module: baseModule,
            clockTriggers: [
              {
                on: 'day',
                op: 'increment',
                field: 'exhausted',
                value: 1,
              },
            ],
          },
        },
        {
          kind: 'json',
          value: {
            module: baseModule,
            clockTriggers: [
              {
                on: 'day',
                op: 'set',
                field: 'exhausted',
                value: true,
              },
            ],
          },
        },
      ],
    });
    const wizard = new GameSystemWizard(gateway);

    const badOpRes = await wizard.generateSystem({ description: 'Exhaustion boolean increment' });
    expect(isErr(badOpRes)).toBe(true);
    if (isErr(badOpRes)) {
      expect(
        badOpRes.error.some(
          (e) => e.path === 'clockTriggers[0].op' && e.code === 'INVALID_TRIGGER_OP'
        )
      ).toBe(true);
    }

    const okSetRes = await wizard.generateSystem({ description: 'Exhaustion daily reset' });
    expect(isOk(okSetRes)).toBe(true);
    if (isOk(okSetRes)) {
      expect(okSetRes.value.clockTriggers).toEqual([
        { on: 'day', op: 'set', field: 'exhausted', value: true },
      ]);
    }
  });
});
