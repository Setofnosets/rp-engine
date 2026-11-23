import { describe, expect, it } from 'vitest';
import {
  type ControlRoomLayer,
  createStockBaselineConfig,
  resolveEffectiveControlRoomConfig,
} from '../../src/config/control-room-config.js';
import {
  exportToSillyTavernChatCompletionPreset,
  exportToSillyTavernTextCompletionPreset,
} from '../../src/cartridge/exporters/st-preset-exporter.js';
import { importSillyTavernPreset } from '../../src/cartridge/importers/st-preset-importer.js';
import { isErr, isOk } from '../../src/core/result.js';
import { STOCK_SLICE_OF_LIFE_PACK } from '../../src/schema/stock-system-packs.js';

function createRealisticChatCompletionPreset(): Record<string, unknown> {
  return {
    name: 'Noir Storyteller v2',
    chat_completion_source: 'openai',
    temperature: 0.85,
    openai_max_tokens: 700,
    openai_max_context: 16384,
    top_p: 0.92,
    top_k: 40,
    min_p: 0.05,
    top_a: 0.1,
    typical_p: 0.95,
    tfs: 0.98,
    frequency_penalty: 0.15,
    presence_penalty: 0.2,
    repetition_penalty: 1.08,
    seed: 4242,
    stop: ['\nUser:', '\n[OOC]'],
    wi_format: '[World Info: {0}]',
    scenario_format: '[Scenario: {0}]',
    personality_format: '[Personality: {0}]',
    impersonation_prompt: 'Write from {{user}} perspective.',
    new_chat_prompt: '[Start a new scene]',
    continue_nudge_prompt: '[Continue seamlessly]',
    prompts: [
      {
        identifier: 'main',
        name: 'Main Prompt',
        system_prompt: true,
        role: 'system',
        content: 'Write evocative noir prose in third-person limited.',
        marker: false,
      },
      {
        identifier: 'worldInfoBefore',
        name: 'World Info (before)',
        system_prompt: false,
        role: 'system',
        content: 'Preceding lore context header.',
        marker: false,
      },
      {
        identifier: 'personaDescription',
        name: 'Persona Description',
        system_prompt: false,
        role: 'system',
        content: '',
        marker: true,
      },
      {
        identifier: 'charDescription',
        name: 'Char Description',
        system_prompt: false,
        role: 'system',
        content: '',
        marker: true,
      },
      {
        identifier: 'charPersonality',
        name: 'Char Personality',
        system_prompt: false,
        role: 'system',
        content: '',
        marker: true,
      },
      {
        identifier: 'scenario',
        name: 'Scenario',
        system_prompt: false,
        role: 'system',
        content: '',
        marker: true,
      },
      {
        identifier: 'enhanceDefinitions',
        name: 'Enhance Definitions',
        system_prompt: true,
        role: 'system',
        content: 'Keep character voices distinct.',
        marker: false,
      },
      {
        identifier: 'worldInfoAfter',
        name: 'World Info (after)',
        system_prompt: false,
        role: 'system',
        content: '',
        marker: true,
      },
      {
        identifier: 'dialogueExamples',
        name: 'Dialogue Examples',
        system_prompt: false,
        role: 'system',
        content: '',
        marker: true,
      },
      {
        identifier: 'chatHistory',
        name: 'Chat History',
        system_prompt: false,
        role: 'system',
        content: '',
        marker: true,
      },
      {
        identifier: 'nsfw',
        name: 'Auxiliary Tone',
        system_prompt: true,
        role: 'system',
        content: 'Do not shy away from mature dramatic tension.',
        marker: false,
        injection_position: 0,
        injection_depth: 4,
      },
      {
        identifier: 'f1a2b3c4-5678-90ab-cdef-1234567890ab',
        name: 'Depth Author Note',
        system_prompt: true,
        role: 'assistant',
        content: '[Director Note: Rain drums on the stained glass.]',
        marker: false,
        injection_position: 1,
        injection_depth: 2,
      },
      {
        identifier: 'jailbreak',
        name: 'Post-History Instructions',
        system_prompt: true,
        role: 'system',
        content: 'Disabled OOC nudge.',
        marker: false,
      },
    ],
    prompt_order: [
      {
        character_id: 100000,
        order: [
          { identifier: 'main', enabled: true },
          { identifier: 'chatHistory', enabled: true },
        ],
      },
      {
        character_id: 100001,
        order: [
          { identifier: 'main', enabled: true },
          { identifier: 'worldInfoBefore', enabled: true },
          { identifier: 'personaDescription', enabled: true },
          { identifier: 'charDescription', enabled: true },
          { identifier: 'charPersonality', enabled: true },
          { identifier: 'scenario', enabled: true },
          { identifier: 'enhanceDefinitions', enabled: true },
          { identifier: 'worldInfoAfter', enabled: true },
          { identifier: 'dialogueExamples', enabled: true },
          { identifier: 'chatHistory', enabled: true },
          { identifier: 'nsfw', enabled: true },
          { identifier: 'f1a2b3c4-5678-90ab-cdef-1234567890ab', enabled: true },
          { identifier: 'jailbreak', enabled: false },
        ],
      },
      {
        character_id: 42,
        order: [
          { identifier: 'main', enabled: true },
          { identifier: 'charDescription', enabled: true },
          { identifier: 'chatHistory', enabled: true },
        ],
      },
    ],
  };
}

describe('PR-7.8 SillyTavern Preset Importer & Exporter', () => {
  it('imports a realistic SillyTavern Chat Completion preset with prompt_order 100001, custom blocks, depth-2 injection, and sampling params', () => {
    const raw = createRealisticChatCompletionPreset();
    const res = importSillyTavernPreset(raw);

    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;

    const imported = res.value;
    expect(imported.format).toBe('st_chat_completion');
    expect(imported.presetName).toBe('Noir Storyteller v2');
    expect(imported.warnings).toEqual([]);

    expect(imported.generation).toEqual({
      presetName: 'Noir Storyteller v2',
      sourceFormat: 'st_chat_completion',
      temperature: 0.85,
      maxTokens: 700,
      maxContextTokens: 16384,
      topP: 0.92,
      topK: 40,
      minP: 0.05,
      topA: 0.1,
      typicalP: 0.95,
      tfs: 0.98,
      frequencyPenalty: 0.15,
      presencePenalty: 0.2,
      repetitionPenalty: 1.08,
      seed: 4242,
      stopSequences: ['\nUser:', '\n[OOC]'],
      stFormatTemplates: {
        wiFormat: '[World Info: {0}]',
        scenarioFormat: '[Scenario: {0}]',
        personalityFormat: '[Personality: {0}]',
        impersonationPrompt: 'Write from {{user}} perspective.',
        newChatPrompt: '[Start a new scene]',
        continueNudgePrompt: '[Continue seamlessly]',
      },
    });

    expect(imported.tokenBudgets).toEqual({
      totalMaxTokens: 16384 - 700,
    });

    // Anchoring & ordering check
    expect(imported.layer.syspromptSectionOrder).toEqual([
      'system',
      'narrative_pacing',
      'game_system_rules',
      'world',
      'st_prompt:worldInfoBefore',
      'persona',
      'card',
      'state',
      'combat_outcome',
      'plot',
      'st_prompt:enhanceDefinitions',
      'st_prompt:dialogueExamples',
      'transcript_window',
      'st_prompt:nsfw',
      'st_prompt:f1a2b3c4-5678-90ab-cdef-1234567890ab',
      'st_prompt:jailbreak',
      'latest_input',
    ]);

    expect(imported.layer.basePrompts?.['system']).toBe(
      'Write evocative noir prose in third-person limited.'
    );
    expect(imported.layer.unlockedPromptSections?.['system']).toBe(true);
    expect(imported.layer.basePrompts?.['st_prompt:worldInfoBefore']).toBe(
      'Preceding lore context header.'
    );
    expect(imported.layer.unlockedPromptSections?.['st_prompt:jailbreak']).toBe(false);
    expect(imported.layer.basePrompts?.['st_prompt:jailbreak']).toBe('Disabled OOC nudge.');

    expect(
      imported.layer.customPromptBlocks?.['st_prompt:f1a2b3c4-5678-90ab-cdef-1234567890ab']
    ).toEqual({
      id: 'st_prompt:f1a2b3c4-5678-90ab-cdef-1234567890ab',
      name: 'Depth Author Note',
      role: 'assistant',
      injectionPosition: 'in_chat',
      injectionDepth: 2,
    });
    expect(imported.layer.customPromptBlocks?.['st_prompt:nsfw']).toEqual({
      id: 'st_prompt:nsfw',
      name: 'Auxiliary Tone',
      role: 'system',
      injectionPosition: 'relative',
      injectionDepth: 4,
    });

    // Verify imported layer merges cleanly into ResolvedControlRoomConfig
    const resolved = resolveEffectiveControlRoomConfig(STOCK_SLICE_OF_LIFE_PACK, imported.layer);
    expect(resolved.basePrompts['system']).toBe(
      'Write evocative noir prose in third-person limited.'
    );
    expect(resolved.unlockedPromptSections['system']).toBe(true);
    expect(resolved.basePrompts['st_prompt:nsfw']).toBe(
      'Do not shy away from mature dramatic tension.'
    );
    expect(resolved.unlockedPromptSections['st_prompt:nsfw']).toBe(true);
    expect(resolved.unlockedPromptSections['st_prompt:jailbreak']).toBe(false);
    expect(resolved.generation?.temperature).toBe(0.85);
    expect(resolved.tokenBudgets?.totalMaxTokens).toBe(16384 - 700);
  });

  it('respects characterId, includeDisabledPrompts: false, preserveRefereeCoreRules: false, negative seed, and unique sanitized IDs', () => {
    const raw = createRealisticChatCompletionPreset();
    const char42Res = importSillyTavernPreset(raw, {
      characterId: 42,
      includeDisabledPrompts: false,
      preserveRefereeCoreRules: false,
    });
    expect(isOk(char42Res)).toBe(true);
    if (!isOk(char42Res)) return;

    expect(char42Res.value.layer.syspromptSectionOrder).toEqual([
      'system',
      'card',
      'transcript_window',
    ]);

    // Collision + disabled + negative seed check
    const collisionPreset = {
      name: 'Collision Test',
      openai_max_context: 600,
      openai_max_tokens: 500,
      seed: -1,
      prompts: [
        { identifier: 'my prompt', name: 'First', content: 'A', role: 'system' },
        { identifier: 'my!prompt', name: 'Second', content: 'B', role: 'user' },
        { identifier: 'disabled_one', name: 'Disabled', content: 'C', enabled: false },
      ],
      prompt_order: [
        {
          character_id: 999,
          order: [
            { identifier: 'my prompt', enabled: true },
            { identifier: 'my!prompt', enabled: true },
            { identifier: 'disabled_one', enabled: false },
          ],
        },
      ],
    };

    const colRes = importSillyTavernPreset(JSON.stringify(collisionPreset), {
      includeDisabledPrompts: false,
    });
    expect(isOk(colRes)).toBe(true);
    if (!isOk(colRes)) return;

    expect(colRes.value.generation.seed).toBeUndefined();
    expect(colRes.value.tokenBudgets.totalMaxTokens).toBe(256); // Math.max(256, 600 - 500)
    expect(colRes.value.layer.basePrompts?.['st_prompt:my_prompt']).toBe('A');
    expect(colRes.value.layer.basePrompts?.['st_prompt:my_prompt_2']).toBe('B');
    expect(colRes.value.layer.basePrompts?.['st_prompt:disabled_one']).toBeUndefined();
  });

  it('imports SillyTavern Text Completion / Instruct presets, parses story_string macros, and emits instruct warning', () => {
    const textPreset = {
      name: 'Mistral Instruct RP',
      temp: 0.72,
      amount_gen: 400,
      max_context: 8192,
      top_p: 0.9,
      top_k: 50,
      min_p: 0.06,
      rep_pen: 1.12,
      freq_pen: 0.05,
      pres_pen: 0.08,
      tfs: 0.97,
      typical: 0.9,
      seed: 123,
      stopping_strings: ['</s>', '[INST]'],
      system_prompt: 'Stay grounded in the scene.',
      story_string:
        '{{system}}\n{{wiBefore}}\n{{persona}}\n{{description}}\n{{personality}}\n{{scenario}}\n{{wiAfter}}\n{{mesExamples}}',
      input_sequence: '[INST] ',
      output_sequence: ' [/INST]',
      wi_format: 'Lore: {0}',
      scenario_format: 'Setting: {0}',
      personality_format: 'Traits: {0}',
    };

    const res = importSillyTavernPreset(Buffer.from(JSON.stringify(textPreset), 'utf8'));
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;

    const imported = res.value;
    expect(imported.format).toBe('st_text_completion');
    expect(imported.presetName).toBe('Mistral Instruct RP');
    expect(imported.warnings.some((w) => w.code === 'INSTRUCT_SEQUENCES_PRESERVED')).toBe(true);

    expect(imported.generation).toEqual({
      presetName: 'Mistral Instruct RP',
      sourceFormat: 'st_text_completion',
      temperature: 0.72,
      maxTokens: 400,
      maxContextTokens: 8192,
      topP: 0.9,
      topK: 50,
      minP: 0.06,
      typicalP: 0.9,
      tfs: 0.97,
      frequencyPenalty: 0.05,
      presencePenalty: 0.08,
      repetitionPenalty: 1.12,
      seed: 123,
      stopSequences: ['</s>', '[INST]'],
      stFormatTemplates: {
        storyString: textPreset.story_string,
        inputSequence: '[INST] ',
        outputSequence: ' [/INST]',
        wiFormat: 'Lore: {0}',
        scenarioFormat: 'Setting: {0}',
        personalityFormat: 'Traits: {0}',
      },
    });
    expect(imported.tokenBudgets).toEqual({ totalMaxTokens: 8192 - 400 });
    expect(imported.layer.basePrompts?.['system']).toBe('Stay grounded in the scene.');
    expect(imported.layer.unlockedPromptSections?.['system']).toBe(true);
    expect(imported.layer.syspromptSectionOrder).toEqual([
      'system',
      'narrative_pacing',
      'game_system_rules',
      'world',
      'persona',
      'card',
      'state',
      'combat_outcome',
      'plot',
      'st_prompt:dialogueExamples',
      'transcript_window',
      'latest_input',
    ]);
  });

  it('imports native Referee ControlRoomLayer JSON (flat and wrapped)', () => {
    const nativeLayer: ControlRoomLayer = {
      syspromptSectionOrder: ['system', 'persona', 'card', 'state', 'transcript_window', 'latest_input'],
      basePrompts: {
        system: 'Custom Referee override.',
      },
      unlockedPromptSections: {
        system: true,
      },
      generation: {
        presetName: 'Referee Balanced',
        sourceFormat: 'referee',
        temperature: 0.65,
        maxTokens: 500,
      },
      tokenBudgets: {
        state: 800,
        totalMaxTokens: 6000,
      },
    };

    const flatRes = importSillyTavernPreset(JSON.stringify(nativeLayer));
    expect(isOk(flatRes)).toBe(true);
    if (isOk(flatRes)) {
      expect(flatRes.value.format).toBe('referee');
      expect(flatRes.value.presetName).toBe('Referee Balanced');
      expect(flatRes.value.generation.temperature).toBe(0.65);
      expect(flatRes.value.tokenBudgets).toEqual({ state: 800, totalMaxTokens: 6000 });
    }

    const wrappedRes = importSillyTavernPreset({ name: 'Wrapped Preset', layer: nativeLayer });
    expect(isOk(wrappedRes)).toBe(true);
    if (isOk(wrappedRes)) {
      expect(wrappedRes.value.format).toBe('referee');
      expect(wrappedRes.value.presetName).toBe('Wrapped Preset');
      expect(wrappedRes.value.layer.basePrompts?.['system']).toBe('Custom Referee override.');
    }
  });

  it('round-trips Chat Completion and Text Completion export -> import cleanly', () => {
    const chatPreset = createRealisticChatCompletionPreset();
    const firstChatImport = importSillyTavernPreset(chatPreset);
    expect(isOk(firstChatImport)).toBe(true);
    if (!isOk(firstChatImport)) return;

    const exportedChat = exportToSillyTavernChatCompletionPreset(firstChatImport.value.layer);
    const secondChatImport = importSillyTavernPreset(exportedChat);
    expect(isOk(secondChatImport)).toBe(true);
    if (!isOk(secondChatImport)) return;

    expect(secondChatImport.value.presetName).toBe(firstChatImport.value.presetName);
    expect(secondChatImport.value.generation).toEqual(firstChatImport.value.generation);
    expect(secondChatImport.value.tokenBudgets).toEqual(firstChatImport.value.tokenBudgets);
    expect(secondChatImport.value.layer.basePrompts).toEqual(firstChatImport.value.layer.basePrompts);
    expect(secondChatImport.value.layer.unlockedPromptSections).toEqual(
      firstChatImport.value.layer.unlockedPromptSections
    );
    expect(secondChatImport.value.layer.customPromptBlocks).toEqual(
      firstChatImport.value.layer.customPromptBlocks
    );
    expect(secondChatImport.value.layer.syspromptSectionOrder).toEqual(
      firstChatImport.value.layer.syspromptSectionOrder
    );

    // Export ResolvedControlRoomConfig to Text Completion and re-import
    const resolved = resolveEffectiveControlRoomConfig(STOCK_SLICE_OF_LIFE_PACK, {
      basePrompts: { system: 'Narrate with precision.' },
      unlockedPromptSections: { system: true },
      generation: {
        presetName: 'Resolved Text Preset',
        temperature: 0.7,
        maxTokens: 350,
        maxContextTokens: 4096,
        stFormatTemplates: {
          storyString: '{{system}}\n{{wiBefore}}\n{{description}}\n{{persona}}',
          inputSequence: 'User:',
          outputSequence: 'Assistant:',
        },
      },
    });
    const exportedText = exportToSillyTavernTextCompletionPreset(resolved);
    const reimportedText = importSillyTavernPreset(exportedText);
    expect(isOk(reimportedText)).toBe(true);
    if (!isOk(reimportedText)) return;

    expect(reimportedText.value.format).toBe('st_text_completion');
    expect(reimportedText.value.presetName).toBe('Resolved Text Preset');
    expect(reimportedText.value.generation.temperature).toBe(0.7);
    expect(reimportedText.value.generation.maxTokens).toBe(350);
    expect(reimportedText.value.generation.maxContextTokens).toBe(4096);
    expect(reimportedText.value.generation.stFormatTemplates?.inputSequence).toBe('User:');
    expect(reimportedText.value.generation.stFormatTemplates?.outputSequence).toBe('Assistant:');
    expect(reimportedText.value.layer.basePrompts?.['system']).toBe('Narrate with precision.');

    // Also verify default stock baseline exports cleanly without generation preset
    const stockBaseline = createStockBaselineConfig(STOCK_SLICE_OF_LIFE_PACK);
    const exportedStockChat = exportToSillyTavernChatCompletionPreset(stockBaseline);
    expect(exportedStockChat['name']).toBe(STOCK_SLICE_OF_LIFE_PACK.name);
    expect(Array.isArray(exportedStockChat['prompts'])).toBe(true);
    expect(Array.isArray(exportedStockChat['prompt_order'])).toBe(true);
  });

  it('rejects invalid JSON, non-object roots, unrecognized formats, and __proto__/constructor/prototype payloads', () => {
    const invalidJson = importSillyTavernPreset('{not valid json');
    expect(isErr(invalidJson)).toBe(true);
    if (isErr(invalidJson)) {
      expect(invalidJson.error[0]?.code).toBe('INVALID_JSON');
    }

    const emptyStr = importSillyTavernPreset('   ');
    expect(isErr(emptyStr)).toBe(true);
    if (isErr(emptyStr)) {
      expect(emptyStr.error[0]?.code).toBe('EMPTY_PAYLOAD');
    }

    const arrayRoot = importSillyTavernPreset('[1, 2, 3]');
    expect(isErr(arrayRoot)).toBe(true);
    if (isErr(arrayRoot)) {
      expect(arrayRoot.error[0]?.code).toBe('INVALID_TYPE');
    }

    const unknownObj = importSillyTavernPreset({ unrelated: true });
    expect(isErr(unknownObj)).toBe(true);
    if (isErr(unknownObj)) {
      expect(unknownObj.error[0]?.code).toBe('UNRECOGNIZED_PRESET_FORMAT');
    }

    const protoPayload = '{"name": "Evil", "openai_max_tokens": 256, "__proto__": {"polluted": true}}';
    const protoRes = importSillyTavernPreset(protoPayload);
    expect(isErr(protoRes)).toBe(true);
    if (isErr(protoRes)) {
      expect(protoRes.error.some((e) => e.code === 'UNSAFE_PROPERTY_KEY')).toBe(true);
    }

    const nestedConstructorPayload = JSON.stringify({
      name: 'Evil Nested',
      prompts: [
        {
          identifier: 'main',
          content: 'hi',
          constructor: { prototype: { polluted: true } },
        },
      ],
    });
    const ctorRes = importSillyTavernPreset(nestedConstructorPayload);
    expect(isErr(ctorRes)).toBe(true);
    if (isErr(ctorRes)) {
      expect(ctorRes.error.some((e) => e.code === 'UNSAFE_PROPERTY_KEY')).toBe(true);
    }
  });
});
