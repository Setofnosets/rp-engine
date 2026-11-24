import type {
  ControlRoomLayer,
  CustomPromptBlockSpec,
  GenerationPresetConfig,
  ResolvedControlRoomConfig,
} from '../../config/control-room-config.js';
import { isUnsafeRecordKey } from '../cartridge-schema.js';

export interface SillyTavernPresetExportOptions {
  presetName?: string;
}

const DEFAULT_EXPORT_SECTION_ORDER: readonly string[] = [
  'system',
  'persona',
  'card',
  'world',
  'transcript_window',
  'latest_input',
];

const REFEREE_INTERNAL_SECTIONS: ReadonlySet<string> = new Set([
  'narrative_pacing',
  'game_system_rules',
  'state',
  'combat_outcome',
  'plot',
  'latest_input',
  'cyoa',
]);

function compareStringsDeterministic(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

function getOwnSafe<T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  if (record === undefined || isUnsafeRecordKey(key) || !Object.hasOwn(record, key)) {
    return undefined;
  }
  return Object.getOwnPropertyDescriptor(record, key)?.value as T | undefined;
}

function isResolvedConfig(
  config: Readonly<ControlRoomLayer | ResolvedControlRoomConfig>
): config is Readonly<ResolvedControlRoomConfig> {
  return 'packId' in config && typeof config.packId === 'string';
}

function resolvePresetName(
  config: Readonly<ControlRoomLayer | ResolvedControlRoomConfig>,
  options?: SillyTavernPresetExportOptions
): string {
  const fromOption = options?.presetName?.trim();
  if (fromOption && fromOption.length > 0) {
    return fromOption;
  }
  const fromGen = config.generation?.presetName?.trim();
  if (fromGen && fromGen.length > 0) {
    return fromGen;
  }
  if (isResolvedConfig(config) && config.packName.trim().length > 0) {
    return config.packName.trim();
  }
  return 'Referee Preset';
}

function resolveMaxContextTokens(
  config: Readonly<ControlRoomLayer | ResolvedControlRoomConfig>,
  gen: Readonly<GenerationPresetConfig> | undefined
): number | undefined {
  if (typeof gen?.maxContextTokens === 'number' && Number.isFinite(gen.maxContextTokens)) {
    return Math.floor(gen.maxContextTokens);
  }
  const totalBudget = config.tokenBudgets?.totalMaxTokens;
  if (typeof totalBudget === 'number' && Number.isFinite(totalBudget)) {
    const maxTokens =
      typeof gen?.maxTokens === 'number' && Number.isFinite(gen.maxTokens)
        ? Math.floor(gen.maxTokens)
        : 512;
    return Math.floor(totalBudget) + maxTokens;
  }
  return undefined;
}

function allocateUniqueIdentifier(
  desired: string,
  usedIdentifiers: Set<string>
): string {
  const cleaned =
    desired.trim().length > 0 && !isUnsafeRecordKey(desired.trim())
      ? desired.trim()
      : 'custom_prompt';
  let candidate = cleaned;
  let suffix = 2;
  while (usedIdentifiers.has(candidate) || isUnsafeRecordKey(candidate)) {
    candidate = `${cleaned}_${suffix}`;
    suffix += 1;
  }
  usedIdentifiers.add(candidate);
  return candidate;
}

/**
 * Export a Referee {@link ControlRoomLayer} or {@link ResolvedControlRoomConfig} to a
 * SillyTavern Chat Completion preset JSON object (`prompts[]` + `prompt_order[]`).
 */
export function exportToSillyTavernChatCompletionPreset(
  config: Readonly<ControlRoomLayer | ResolvedControlRoomConfig>,
  options?: SillyTavernPresetExportOptions
): Record<string, unknown> {
  const presetName = resolvePresetName(config, options);
  const gen = config.generation;
  const templates = gen?.stFormatTemplates;
  const basePrompts = config.basePrompts;
  const unlockedSections = config.unlockedPromptSections;
  const customBlocks = config.customPromptBlocks;

  const sectionOrder =
    config.syspromptSectionOrder !== undefined && config.syspromptSectionOrder.length > 0
      ? config.syspromptSectionOrder
      : [...DEFAULT_EXPORT_SECTION_ORDER];

  const orderSet = new Set(sectionOrder);
  const hasCustomWorldBefore =
    orderSet.has('st_prompt:worldInfoBefore') ||
    getOwnSafe(basePrompts, 'st_prompt:worldInfoBefore') !== undefined;
  const hasCustomWorldAfter =
    orderSet.has('st_prompt:worldInfoAfter') ||
    getOwnSafe(basePrompts, 'st_prompt:worldInfoAfter') !== undefined;

  const prompts: Array<Record<string, unknown>> = [];
  const order: Array<{ identifier: string; enabled: boolean }> = [];
  const usedIdentifiers = new Set<string>();
  const exportedSectionKeys = new Set<string>();

  const pushPrompt = (
    promptObj: Record<string, unknown>,
    identifier: string,
    enabled: boolean
  ): void => {
    prompts.push(promptObj);
    order.push({ identifier, enabled });
  };

  const emitCustomSection = (sectionId: string): void => {
    const spec: CustomPromptBlockSpec | undefined = getOwnSafe(customBlocks, sectionId);
    const content = getOwnSafe(basePrompts, sectionId) ?? '';
    const unlockedFlag = getOwnSafe(unlockedSections, sectionId);
    const enabled = unlockedFlag !== false;

    const rawId = sectionId.startsWith('st_prompt:')
      ? sectionId.slice('st_prompt:'.length)
      : sectionId;
    const identifier = allocateUniqueIdentifier(rawId, usedIdentifiers);
    const isDialogueMarker = identifier === 'dialogueExamples' && content.length === 0;

    pushPrompt(
      {
        identifier,
        name: spec?.name ?? rawId,
        system_prompt: !isDialogueMarker,
        role: spec?.role ?? 'system',
        content,
        marker: isDialogueMarker,
        injection_position: spec?.injectionPosition === 'in_chat' ? 1 : 0,
        ...(spec?.injectionDepth !== undefined
          ? { injection_depth: spec.injectionDepth }
          : spec?.injectionPosition === 'in_chat'
            ? { injection_depth: 4 }
            : {}),
        forbid_overrides: false,
      },
      identifier,
      enabled
    );
  };

  for (const sectionId of sectionOrder) {
    if (typeof sectionId !== 'string' || isUnsafeRecordKey(sectionId) || exportedSectionKeys.has(sectionId)) {
      continue;
    }
    exportedSectionKeys.add(sectionId);

    if (sectionId === 'system') {
      const identifier = allocateUniqueIdentifier('main', usedIdentifiers);
      const sysContent = getOwnSafe(basePrompts, 'system') ?? '';
      const sysUnlocked = getOwnSafe(unlockedSections, 'system');
      const enabled = sysUnlocked !== false;
      pushPrompt(
        {
          identifier,
          name: 'Main Prompt',
          system_prompt: true,
          role: 'system',
          content: sysContent,
          marker: false,
          injection_position: 0,
          injection_depth: 4,
          forbid_overrides: false,
        },
        identifier,
        enabled
      );
      continue;
    }

    if (sectionId === 'persona') {
      const identifier = allocateUniqueIdentifier('personaDescription', usedIdentifiers);
      const enabled = getOwnSafe(unlockedSections, 'persona') !== false;
      pushPrompt(
        {
          identifier,
          name: 'Persona Description',
          system_prompt: false,
          role: 'system',
          content: '',
          marker: true,
        },
        identifier,
        enabled
      );
      continue;
    }

    if (sectionId === 'card') {
      const enabled = getOwnSafe(unlockedSections, 'card') !== false;
      const cardMarkers: Array<[string, string]> = [
        ['charDescription', 'Char Description'],
        ['charPersonality', 'Char Personality'],
        ['scenario', 'Scenario'],
      ];
      for (const [markerId, markerName] of cardMarkers) {
        const identifier = allocateUniqueIdentifier(markerId, usedIdentifiers);
        pushPrompt(
          {
            identifier,
            name: markerName,
            system_prompt: false,
            role: 'system',
            content: '',
            marker: true,
          },
          identifier,
          enabled
        );
      }
      continue;
    }

    if (sectionId === 'world') {
      if (hasCustomWorldBefore && hasCustomWorldAfter) {
        continue;
      }
      const worldId = hasCustomWorldBefore ? 'worldInfoAfter' : 'worldInfoBefore';
      const worldName = hasCustomWorldBefore ? 'World Info (after)' : 'World Info (before)';
      const identifier = allocateUniqueIdentifier(worldId, usedIdentifiers);
      const enabled = getOwnSafe(unlockedSections, 'world') !== false;
      pushPrompt(
        {
          identifier,
          name: worldName,
          system_prompt: false,
          role: 'system',
          content: '',
          marker: true,
        },
        identifier,
        enabled
      );
      continue;
    }

    if (sectionId === 'transcript_window') {
      const identifier = allocateUniqueIdentifier('chatHistory', usedIdentifiers);
      const enabled = getOwnSafe(unlockedSections, 'transcript_window') !== false;
      pushPrompt(
        {
          identifier,
          name: 'Chat History',
          system_prompt: false,
          role: 'system',
          content: '',
          marker: true,
        },
        identifier,
        enabled
      );
      continue;
    }

    if (REFEREE_INTERNAL_SECTIONS.has(sectionId)) {
      const customOverride = getOwnSafe(basePrompts, sectionId);
      if (
        sectionId !== 'latest_input' &&
        customOverride !== undefined &&
        getOwnSafe(unlockedSections, sectionId) === true
      ) {
        emitCustomSection(sectionId);
      }
      continue;
    }

    emitCustomSection(sectionId);
  }

  const extraStKeys = new Set<string>();
  if (customBlocks !== undefined) {
    for (const k of Object.keys(customBlocks)) {
      if (!isUnsafeRecordKey(k) && !exportedSectionKeys.has(k)) {
        extraStKeys.add(k);
      }
    }
  }
  if (basePrompts !== undefined) {
    for (const k of Object.keys(basePrompts)) {
      if (!isUnsafeRecordKey(k) && k.startsWith('st_prompt:') && !exportedSectionKeys.has(k)) {
        extraStKeys.add(k);
      }
    }
  }
  for (const extraKey of [...extraStKeys].sort(compareStringsDeterministic)) {
    exportedSectionKeys.add(extraKey);
    emitCustomSection(extraKey);
  }

  const out: Record<string, unknown> = {
    name: presetName,
    chat_completion_source: 'openai',
  };

  if (typeof gen?.temperature === 'number' && Number.isFinite(gen.temperature)) {
    out['temperature'] = gen.temperature;
  }
  if (typeof gen?.maxTokens === 'number' && Number.isFinite(gen.maxTokens)) {
    out['openai_max_tokens'] = Math.floor(gen.maxTokens);
  }
  const maxContext = resolveMaxContextTokens(config, gen);
  if (maxContext !== undefined) {
    out['openai_max_context'] = maxContext;
  }
  if (typeof gen?.topP === 'number' && Number.isFinite(gen.topP)) {
    out['top_p'] = gen.topP;
  }
  if (typeof gen?.topK === 'number' && Number.isFinite(gen.topK)) {
    out['top_k'] = Math.floor(gen.topK);
  }
  if (typeof gen?.minP === 'number' && Number.isFinite(gen.minP)) {
    out['min_p'] = gen.minP;
  }
  if (typeof gen?.topA === 'number' && Number.isFinite(gen.topA)) {
    out['top_a'] = gen.topA;
  }
  if (typeof gen?.typicalP === 'number' && Number.isFinite(gen.typicalP)) {
    out['typical_p'] = gen.typicalP;
  }
  if (typeof gen?.tfs === 'number' && Number.isFinite(gen.tfs)) {
    out['tfs'] = gen.tfs;
  }
  if (typeof gen?.frequencyPenalty === 'number' && Number.isFinite(gen.frequencyPenalty)) {
    out['frequency_penalty'] = gen.frequencyPenalty;
  }
  if (typeof gen?.presencePenalty === 'number' && Number.isFinite(gen.presencePenalty)) {
    out['presence_penalty'] = gen.presencePenalty;
  }
  if (typeof gen?.repetitionPenalty === 'number' && Number.isFinite(gen.repetitionPenalty)) {
    out['repetition_penalty'] = gen.repetitionPenalty;
  }
  if (typeof gen?.seed === 'number' && Number.isFinite(gen.seed)) {
    out['seed'] = Math.trunc(gen.seed);
  }
  if (gen?.stopSequences !== undefined) {
    out['stop'] = [...gen.stopSequences];
    out['custom_stopping_strings'] = [...gen.stopSequences];
  }

  if (templates !== undefined) {
    if (templates.wiFormat !== undefined) {
      out['wi_format'] = templates.wiFormat;
    }
    if (templates.scenarioFormat !== undefined) {
      out['scenario_format'] = templates.scenarioFormat;
    }
    if (templates.personalityFormat !== undefined) {
      out['personality_format'] = templates.personalityFormat;
    }
    if (templates.impersonationPrompt !== undefined) {
      out['impersonation_prompt'] = templates.impersonationPrompt;
    }
    if (templates.newChatPrompt !== undefined) {
      out['new_chat_prompt'] = templates.newChatPrompt;
    }
    if (templates.continueNudgePrompt !== undefined) {
      out['continue_nudge_prompt'] = templates.continueNudgePrompt;
    }
  }

  out['prompts'] = prompts;
  out['prompt_order'] = [
    {
      character_id: 100001,
      order,
    },
  ];

  return out;
}

function synthesizeStoryStringFromOrder(sectionOrder: readonly string[]): string {
  const parts: string[] = [];
  for (const sectionId of sectionOrder) {
    switch (sectionId) {
      case 'system':
        parts.push('{{system}}');
        break;
      case 'world':
        parts.push('{{wiBefore}}');
        break;
      case 'persona':
        parts.push('{{persona}}');
        break;
      case 'card':
        parts.push('{{description}}\n{{personality}}\n{{scenario}}');
        break;
      case 'st_prompt:dialogueExamples':
        parts.push('{{mesExamples}}');
        break;
    }
  }
  return parts.length > 0
    ? parts.join('\n\n')
    : '{{system}}\n\n{{wiBefore}}\n\n{{description}}\n{{personality}}\n{{scenario}}\n\n{{persona}}';
}

/**
 * Export a Referee {@link ControlRoomLayer} or {@link ResolvedControlRoomConfig} to a
 * SillyTavern Text Completion / Instruct preset JSON object.
 */
export function exportToSillyTavernTextCompletionPreset(
  config: Readonly<ControlRoomLayer | ResolvedControlRoomConfig>,
  options?: SillyTavernPresetExportOptions
): Record<string, unknown> {
  const presetName = resolvePresetName(config, options);
  const gen = config.generation;
  const templates = gen?.stFormatTemplates;
  const sectionOrder =
    config.syspromptSectionOrder !== undefined && config.syspromptSectionOrder.length > 0
      ? config.syspromptSectionOrder
      : DEFAULT_EXPORT_SECTION_ORDER;

  const out: Record<string, unknown> = {
    name: presetName,
  };

  if (typeof gen?.temperature === 'number' && Number.isFinite(gen.temperature)) {
    out['temp'] = gen.temperature;
  }
  if (typeof gen?.maxTokens === 'number' && Number.isFinite(gen.maxTokens)) {
    out['amount_gen'] = Math.floor(gen.maxTokens);
  }
  const maxContext = resolveMaxContextTokens(config, gen);
  if (maxContext !== undefined) {
    out['max_context'] = maxContext;
  }
  if (typeof gen?.topP === 'number' && Number.isFinite(gen.topP)) {
    out['top_p'] = gen.topP;
  }
  if (typeof gen?.topK === 'number' && Number.isFinite(gen.topK)) {
    out['top_k'] = Math.floor(gen.topK);
  }
  if (typeof gen?.minP === 'number' && Number.isFinite(gen.minP)) {
    out['min_p'] = gen.minP;
  }
  if (typeof gen?.topA === 'number' && Number.isFinite(gen.topA)) {
    out['top_a'] = gen.topA;
  }
  if (typeof gen?.typicalP === 'number' && Number.isFinite(gen.typicalP)) {
    out['typical'] = gen.typicalP;
  }
  if (typeof gen?.tfs === 'number' && Number.isFinite(gen.tfs)) {
    out['tfs'] = gen.tfs;
  }
  if (typeof gen?.frequencyPenalty === 'number' && Number.isFinite(gen.frequencyPenalty)) {
    out['freq_pen'] = gen.frequencyPenalty;
  }
  if (typeof gen?.presencePenalty === 'number' && Number.isFinite(gen.presencePenalty)) {
    out['pres_pen'] = gen.presencePenalty;
  }
  if (typeof gen?.repetitionPenalty === 'number' && Number.isFinite(gen.repetitionPenalty)) {
    out['rep_pen'] = gen.repetitionPenalty;
  }
  if (typeof gen?.seed === 'number' && Number.isFinite(gen.seed)) {
    out['seed'] = Math.trunc(gen.seed);
  }
  if (gen?.stopSequences !== undefined) {
    out['stopping_strings'] = [...gen.stopSequences];
  }

  const systemPrompt = getOwnSafe(config.basePrompts, 'system');
  if (systemPrompt !== undefined) {
    out['system_prompt'] = systemPrompt;
  }

  out['story_string'] =
    templates?.storyString !== undefined
      ? templates.storyString
      : synthesizeStoryStringFromOrder(sectionOrder);

  if (templates?.inputSequence !== undefined) {
    out['input_sequence'] = templates.inputSequence;
  }
  if (templates?.outputSequence !== undefined) {
    out['output_sequence'] = templates.outputSequence;
  }
  if (templates?.wiFormat !== undefined) {
    out['wi_format'] = templates.wiFormat;
  }
  if (templates?.scenarioFormat !== undefined) {
    out['scenario_format'] = templates.scenarioFormat;
  }
  if (templates?.personalityFormat !== undefined) {
    out['personality_format'] = templates.personalityFormat;
  }

  return out;
}
