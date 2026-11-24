import {
  type ControlRoomLayer,
  type CustomPromptBlockInjectionPosition,
  type CustomPromptBlockRole,
  type CustomPromptBlockSpec,
  type GenerationPresetConfig,
  type GenerationSourceFormat,
  type StFormatTemplates,
  cloneControlRoomLayer,
  cloneGenerationPresetConfig,
  cloneTokenBudgetsPartial,
} from '../../config/control-room-config.js';
import { type SectionTokenBudgets, validateTokenBudgets } from '../../context/tokenizer-budget.js';
import { type ValidationError, validationError } from '../../core/errors.js';
import { ErrorAccumulator, type Result, err, ok } from '../../core/result.js';
import {
  isPlainObject,
  isUnsafeRecordKey,
  scanObjectForUnsafeKeys,
  setSafeProperty,
} from '../cartridge-schema.js';

export type SillyTavernPresetFormat = GenerationSourceFormat;

export interface SillyTavernPresetImportOptions {
  presetName?: string;
  characterId?: number | string;
  preserveRefereeCoreRules?: boolean;
  includeDisabledPrompts?: boolean;
}

export interface SillyTavernPresetImportResult {
  format: SillyTavernPresetFormat;
  presetName: string;
  layer: ControlRoomLayer;
  generation: GenerationPresetConfig;
  tokenBudgets: Partial<SectionTokenBudgets>;
  warnings: ValidationError[];
}

const DEFAULT_FALLBACK_MAX_TOKENS = 512;
const MIN_DERIVED_TOTAL_TOKENS = 256;

const CARD_MARKER_IDS: ReadonlySet<string> = new Set([
  'charDescription',
  'charPersonality',
  'scenario',
]);

const WORLD_MARKER_IDS: ReadonlySet<string> = new Set([
  'worldInfoBefore',
  'worldInfoAfter',
]);

const KNOWN_ST_MARKER_NAMES: Readonly<Record<string, string>> = {
  main: 'Main Prompt',
  personaDescription: 'Persona Description',
  charDescription: 'Char Description',
  charPersonality: 'Char Personality',
  scenario: 'Scenario',
  worldInfoBefore: 'World Info (before)',
  worldInfoAfter: 'World Info (after)',
  chatHistory: 'Chat History',
  dialogueExamples: 'Dialogue Examples',
  enhanceDefinitions: 'Enhance Definitions',
  nsfw: 'Auxiliary Prompt',
  jailbreak: 'Post-History Instructions',
};

const CONTROL_ROOM_LAYER_KEYS: readonly string[] = [
  'capabilities',
  'pcCoreSections',
  'npcCoreSections',
  'sectionConfirmPolicies',
  'gameSystems',
  'gameSystemOverrides',
  'blockOrder',
  'syspromptSectionOrder',
  'basePrompts',
  'unlockedPromptSections',
  'customPromptBlocks',
  'combatRules',
  'tuningDials',
  'generation',
  'tokenBudgets',
];

const VALID_CUSTOM_ROLES: ReadonlySet<string> = new Set(['system', 'user', 'assistant']);
const VALID_INJECTION_POSITIONS: ReadonlySet<string> = new Set(['relative', 'in_chat']);
const VALID_GENERATION_SOURCE_FORMATS: ReadonlySet<string> = new Set([
  'st_chat_completion',
  'st_text_completion',
  'referee',
]);

const ST_GENERATION_NUMERIC_FIELDS: readonly (
  | 'temperature'
  | 'maxTokens'
  | 'maxContextTokens'
  | 'topP'
  | 'topK'
  | 'minP'
  | 'topA'
  | 'typicalP'
  | 'tfs'
  | 'frequencyPenalty'
  | 'presencePenalty'
  | 'repetitionPenalty'
  | 'seed'
)[] = [
  'temperature',
  'maxTokens',
  'maxContextTokens',
  'topP',
  'topK',
  'minP',
  'topA',
  'typicalP',
  'tfs',
  'frequencyPenalty',
  'presencePenalty',
  'repetitionPenalty',
  'seed',
];

const ST_FORMAT_TEMPLATE_KEYS: readonly (keyof StFormatTemplates)[] = [
  'wiFormat',
  'scenarioFormat',
  'personalityFormat',
  'impersonationPrompt',
  'newChatPrompt',
  'continueNudgePrompt',
  'storyString',
  'inputSequence',
  'outputSequence',
];

function sanitizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeJsonValue);
  }
  if (value !== null && typeof value === 'object' && isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.getOwnPropertyNames(value)) {
      if (isUnsafeRecordKey(key)) {
        continue;
      }
      const desc = Object.getOwnPropertyDescriptor(value, key);
      if (desc !== undefined) {
        setSafeProperty(out, key, sanitizeJsonValue(desc.value));
      }
    }
    return out;
  }
  return value;
}

function getOwnValue(obj: Record<string, unknown>, key: string): unknown {
  if (isUnsafeRecordKey(key) || !Object.hasOwn(obj, key)) {
    return undefined;
  }
  return Object.getOwnPropertyDescriptor(obj, key)?.value;
}

function getOwnString(obj: Record<string, unknown>, key: string): string | undefined {
  const val = getOwnValue(obj, key);
  return typeof val === 'string' ? val : undefined;
}

function getOwnBoolean(obj: Record<string, unknown>, key: string): boolean | undefined {
  const val = getOwnValue(obj, key);
  return typeof val === 'boolean' ? val : undefined;
}

function getOwnNumber(obj: Record<string, unknown>, key: string): number | undefined {
  const val = getOwnValue(obj, key);
  return typeof val === 'number' && Number.isFinite(val) ? val : undefined;
}

function firstDefinedNumber(obj: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const val = getOwnNumber(obj, key);
    if (val !== undefined) {
      return val;
    }
  }
  return undefined;
}

function firstDefinedString(obj: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const val = getOwnString(obj, key);
    if (val !== undefined) {
      return val;
    }
  }
  return undefined;
}

function extractStopSequences(obj: Record<string, unknown>, keys: readonly string[]): string[] | undefined {
  for (const key of keys) {
    const raw = getOwnValue(obj, key);
    if (raw === undefined) {
      continue;
    }
    if (Array.isArray(raw)) {
      const cleaned = raw.filter((item): item is string => typeof item === 'string' && item.length > 0);
      return cleaned;
    }
    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (trimmed.length === 0) {
        return [];
      }
      if (trimmed.startsWith('[')) {
        try {
          const parsed: unknown = JSON.parse(trimmed);
          if (Array.isArray(parsed)) {
            return parsed.filter((item): item is string => typeof item === 'string' && item.length > 0);
          }
        } catch {
          // Treat as literal stop sequence when not valid JSON array.
        }
      }
      return [raw];
    }
  }
  return undefined;
}

function sanitizePromptSlug(rawId: string, fallbackIndex: number): string {
  const cleaned = rawId
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '');
  if (cleaned.length === 0 || isUnsafeRecordKey(cleaned)) {
    return `prompt_${fallbackIndex + 1}`;
  }
  return cleaned;
}

function allocateUniqueStPromptId(
  rawId: string,
  usedIds: Set<string>,
  fallbackIndex: number
): string {
  const baseSlug = sanitizePromptSlug(rawId, fallbackIndex);
  let candidate = `st_prompt:${baseSlug}`;
  let suffix = 2;
  while (usedIds.has(candidate) || isUnsafeRecordKey(candidate)) {
    candidate = `st_prompt:${baseSlug}_${suffix}`;
    suffix += 1;
  }
  usedIds.add(candidate);
  return candidate;
}

function normalizePromptRole(rawRole: unknown): CustomPromptBlockRole {
  if (rawRole === 'user' || rawRole === 'assistant' || rawRole === 'system') {
    return rawRole;
  }
  return 'system';
}

function pushUniqueSection(order: string[], seen: Set<string>, sectionId: string): void {
  if (!isUnsafeRecordKey(sectionId) && !seen.has(sectionId)) {
    seen.add(sectionId);
    order.push(sectionId);
  }
}

function insertSectionsAfterAnchor(
  order: string[],
  seen: Set<string>,
  anchorId: string,
  sectionsToInsert: readonly string[]
): void {
  const anchorIndex = order.indexOf(anchorId);
  if (anchorIndex === -1) {
    for (const sec of sectionsToInsert) {
      pushUniqueSection(order, seen, sec);
    }
    return;
  }
  let insertOffset = anchorIndex + 1;
  for (const sec of sectionsToInsert) {
    if (isUnsafeRecordKey(sec) || seen.has(sec)) {
      continue;
    }
    order.splice(insertOffset, 0, sec);
    seen.add(sec);
    insertOffset += 1;
  }
}

function insertSectionBeforeAnchors(
  order: string[],
  seen: Set<string>,
  sectionId: string,
  anchors: readonly string[]
): void {
  if (isUnsafeRecordKey(sectionId) || seen.has(sectionId)) {
    return;
  }
  for (const anchor of anchors) {
    const idx = order.indexOf(anchor);
    if (idx !== -1) {
      order.splice(idx, 0, sectionId);
      seen.add(sectionId);
      return;
    }
  }
  order.push(sectionId);
  seen.add(sectionId);
}

function ensureRefereeCoreSections(order: string[], seen: Set<string>): void {
  if (!seen.has('system')) {
    order.unshift('system');
    seen.add('system');
  }
  insertSectionsAfterAnchor(order, seen, 'system', ['narrative_pacing', 'game_system_rules']);

  if (seen.has('card')) {
    insertSectionsAfterAnchor(order, seen, 'card', ['state', 'combat_outcome', 'plot']);
  } else {
    for (const sec of ['state', 'combat_outcome', 'plot']) {
      insertSectionBeforeAnchors(order, seen, sec, ['world', 'transcript_window', 'latest_input']);
    }
  }

  insertSectionBeforeAnchors(order, seen, 'world', ['transcript_window', 'latest_input']);
  insertSectionBeforeAnchors(order, seen, 'transcript_window', ['latest_input']);
  pushUniqueSection(order, seen, 'latest_input');
}

function buildStFormatTemplates(
  root: Record<string, unknown>,
  includeTextCompletionFields: boolean
): StFormatTemplates | undefined {
  const templates: StFormatTemplates = {};
  let hasAny = false;

  const assignString = (targetKey: keyof StFormatTemplates, sourceKey: string): void => {
    const val = getOwnString(root, sourceKey);
    if (val !== undefined) {
      templates[targetKey] = val;
      hasAny = true;
    }
  };

  assignString('wiFormat', 'wi_format');
  assignString('scenarioFormat', 'scenario_format');
  assignString('personalityFormat', 'personality_format');
  assignString('impersonationPrompt', 'impersonation_prompt');
  assignString('newChatPrompt', 'new_chat_prompt');
  assignString('continueNudgePrompt', 'continue_nudge_prompt');

  if (includeTextCompletionFields) {
    assignString('storyString', 'story_string');
    assignString('inputSequence', 'input_sequence');
    assignString('outputSequence', 'output_sequence');
  }

  return hasAny ? templates : undefined;
}

function deriveTokenBudgets(
  maxContextTokens: number | undefined,
  maxTokens: number | undefined
): Partial<SectionTokenBudgets> {
  if (maxContextTokens === undefined || maxContextTokens <= 0) {
    return {};
  }
  const reserve =
    maxTokens !== undefined && maxTokens >= 0
      ? Math.floor(maxTokens)
      : DEFAULT_FALLBACK_MAX_TOKENS;
  return {
    totalMaxTokens: Math.max(MIN_DERIVED_TOTAL_TOKENS, Math.floor(maxContextTokens) - reserve),
  };
}

function isChatCompletionPreset(root: Record<string, unknown>): boolean {
  return (
    Array.isArray(getOwnValue(root, 'prompts')) ||
    Array.isArray(getOwnValue(root, 'prompt_order')) ||
    getOwnValue(root, 'openai_max_tokens') !== undefined ||
    getOwnValue(root, 'openai_max_context') !== undefined ||
    getOwnValue(root, 'chat_completion_source') !== undefined
  );
}

function isTextCompletionPreset(root: Record<string, unknown>): boolean {
  if (
    Array.isArray(getOwnValue(root, 'prompts')) ||
    Array.isArray(getOwnValue(root, 'prompt_order'))
  ) {
    return false;
  }
  return (
    getOwnValue(root, 'amount_gen') !== undefined ||
    getOwnValue(root, 'max_length') !== undefined ||
    getOwnValue(root, 'rep_pen') !== undefined ||
    getOwnValue(root, 'story_string') !== undefined ||
    getOwnValue(root, 'input_sequence') !== undefined ||
    getOwnValue(root, 'output_sequence') !== undefined ||
    getOwnValue(root, 'system_sequence') !== undefined ||
    getOwnValue(root, 'wrap') !== undefined ||
    getOwnValue(root, 'system_prompt') !== undefined
  );
}

function isRefereePreset(root: Record<string, unknown>): boolean {
  if (isPlainObject(getOwnValue(root, 'layer'))) {
    return true;
  }
  return CONTROL_ROOM_LAYER_KEYS.some((key) => getOwnValue(root, key) !== undefined);
}

interface PromptOrderEntry {
  identifier: string;
  enabled?: boolean;
}

function resolvePromptOrderList(
  rawPromptOrder: unknown,
  rawPrompts: readonly Record<string, unknown>[],
  preferredCharacterId: number | string | undefined
): PromptOrderEntry[] {
  if (Array.isArray(rawPromptOrder)) {
    const candidates: Array<{ characterId: unknown; order: unknown[] }> = [];
    for (const item of rawPromptOrder) {
      if (!isPlainObject(item)) {
        continue;
      }
      const order = getOwnValue(item, 'order');
      if (Array.isArray(order)) {
        candidates.push({
          characterId: getOwnValue(item, 'character_id'),
          order,
        });
      }
    }

    if (candidates.length > 0) {
      const findByCharId = (target: number | string): { order: unknown[] } | undefined => {
        const targetStr = String(target);
        return candidates.find(
          (c) => c.characterId !== undefined && c.characterId !== null && String(c.characterId) === targetStr
        );
      };

      let chosen: { order: unknown[] } | undefined;
      if (preferredCharacterId !== undefined) {
        chosen = findByCharId(preferredCharacterId);
      }
      if (chosen === undefined) {
        chosen = findByCharId(100001) ?? findByCharId(100000);
      }
      if (chosen === undefined) {
        // Deterministically prefer longest order list, breaking ties with the last entry.
        chosen = candidates.reduce((best, current) =>
          current.order.length >= best.order.length ? current : best
        );
      }

      const resolved: PromptOrderEntry[] = [];
      for (const entry of chosen.order) {
        if (!isPlainObject(entry)) {
          continue;
        }
        const identifier = getOwnString(entry, 'identifier')?.trim();
        if (!identifier) {
          continue;
        }
        const enabled = getOwnBoolean(entry, 'enabled');
        resolved.push({
          identifier,
          ...(enabled !== undefined ? { enabled } : {}),
        });
      }
      return resolved;
    }
  }

  const fallbackOrder: PromptOrderEntry[] = [];
  for (const prompt of rawPrompts) {
    const identifier = getOwnString(prompt, 'identifier')?.trim();
    if (!identifier) {
      continue;
    }
    const enabled = getOwnBoolean(prompt, 'enabled');
    fallbackOrder.push({
      identifier,
      ...(enabled !== undefined ? { enabled } : {}),
    });
  }
  return fallbackOrder;
}

function importChatCompletionPreset(
  root: Record<string, unknown>,
  options: SillyTavernPresetImportOptions
): Result<SillyTavernPresetImportResult, ValidationError[]> {
  const warnings: ValidationError[] = [];
  const preserveRefereeCoreRules = options.preserveRefereeCoreRules !== false;
  const includeDisabledPrompts = options.includeDisabledPrompts !== false;

  const presetName =
    options.presetName?.trim() ||
    firstDefinedString(root, ['name', 'preset_name'])?.trim() ||
    'Imported SillyTavern Chat Preset';

  const temperature = firstDefinedNumber(root, ['temperature', 'temp']);
  const maxTokens = firstDefinedNumber(root, ['openai_max_tokens', 'max_tokens']);
  const maxContextTokens = firstDefinedNumber(root, ['openai_max_context', 'max_context']);
  const topP = getOwnNumber(root, 'top_p');
  const topK = getOwnNumber(root, 'top_k');
  const minP = getOwnNumber(root, 'min_p');
  const topA = getOwnNumber(root, 'top_a');
  const typicalP = firstDefinedNumber(root, ['typical_p', 'typical']);
  const tfs = getOwnNumber(root, 'tfs');
  const frequencyPenalty = firstDefinedNumber(root, ['frequency_penalty', 'freq_pen']);
  const presencePenalty = firstDefinedNumber(root, ['presence_penalty', 'pres_pen']);
  const repetitionPenalty = firstDefinedNumber(root, ['repetition_penalty', 'rep_pen']);
  const rawSeed = getOwnNumber(root, 'seed');
  const seed = rawSeed !== undefined && rawSeed >= 0 ? Math.trunc(rawSeed) : undefined;
  const stopSequences = extractStopSequences(root, ['stop', 'custom_stopping_strings']);
  const stFormatTemplates = buildStFormatTemplates(root, false);

  const generation: GenerationPresetConfig = {
    presetName,
    sourceFormat: 'st_chat_completion',
    ...(temperature !== undefined ? { temperature } : {}),
    ...(maxTokens !== undefined ? { maxTokens: Math.floor(maxTokens) } : {}),
    ...(maxContextTokens !== undefined ? { maxContextTokens: Math.floor(maxContextTokens) } : {}),
    ...(topP !== undefined ? { topP } : {}),
    ...(topK !== undefined ? { topK: Math.floor(topK) } : {}),
    ...(minP !== undefined ? { minP } : {}),
    ...(topA !== undefined ? { topA } : {}),
    ...(typicalP !== undefined ? { typicalP } : {}),
    ...(tfs !== undefined ? { tfs } : {}),
    ...(frequencyPenalty !== undefined ? { frequencyPenalty } : {}),
    ...(presencePenalty !== undefined ? { presencePenalty } : {}),
    ...(repetitionPenalty !== undefined ? { repetitionPenalty } : {}),
    ...(stopSequences !== undefined ? { stopSequences } : {}),
    ...(seed !== undefined ? { seed } : {}),
    ...(stFormatTemplates !== undefined ? { stFormatTemplates } : {}),
  };

  const tokenBudgets = deriveTokenBudgets(maxContextTokens, maxTokens);

  const rawPromptsVal = getOwnValue(root, 'prompts');
  const rawPrompts: Record<string, unknown>[] = [];
  const promptsById = new Map<string, Record<string, unknown>>();
  if (Array.isArray(rawPromptsVal)) {
    for (let i = 0; i < rawPromptsVal.length; i += 1) {
      const item = rawPromptsVal[i];
      if (!isPlainObject(item)) {
        warnings.push(
          validationError(`prompts[${i}]`, 'SKIPPED_PROMPT', 'Non-object prompt entry skipped')
        );
        continue;
      }
      rawPrompts.push(item);
      const id = getOwnString(item, 'identifier')?.trim();
      if (id && !promptsById.has(id)) {
        promptsById.set(id, item);
      }
    }
  }

  const orderEntries = resolvePromptOrderList(
    getOwnValue(root, 'prompt_order'),
    rawPrompts,
    options.characterId
  );

  const syspromptSectionOrder: string[] = [];
  const seenSections = new Set<string>();
  const basePrompts: Record<string, string> = {};
  const unlockedPromptSections: Record<string, boolean> = {};
  const customPromptBlocks: Record<string, CustomPromptBlockSpec> = {};
  const usedPromptIds = new Set<string>();

  for (let i = 0; i < orderEntries.length; i += 1) {
    const orderEntry = orderEntries[i];
    if (!orderEntry) {
      continue;
    }
    const { identifier } = orderEntry;
    const promptDef = promptsById.get(identifier);
    if (promptDef === undefined && !Object.hasOwn(KNOWN_ST_MARKER_NAMES, identifier)) {
      warnings.push(
        validationError(
          `prompt_order[${i}]`,
          'MISSING_PROMPT_DEFINITION',
          `Prompt order entry "${identifier}" has no matching definition in prompts[] and was skipped`
        )
      );
      continue;
    }

    const enabled =
      orderEntry.enabled !== undefined
        ? orderEntry.enabled
        : promptDef !== undefined
          ? (getOwnBoolean(promptDef, 'enabled') ?? true)
          : true;

    const content = promptDef !== undefined ? (getOwnString(promptDef, 'content') ?? '') : '';
    const isMarker = promptDef !== undefined ? (getOwnBoolean(promptDef, 'marker') ?? false) : true;

    if (identifier === 'main') {
      if (content.trim().length > 0 && (enabled || includeDisabledPrompts)) {
        setSafeProperty(basePrompts, 'system', content);
        setSafeProperty(unlockedPromptSections, 'system', enabled);
      }
      if (enabled || includeDisabledPrompts || preserveRefereeCoreRules) {
        pushUniqueSection(syspromptSectionOrder, seenSections, 'system');
        if (preserveRefereeCoreRules) {
          insertSectionsAfterAnchor(syspromptSectionOrder, seenSections, 'system', [
            'narrative_pacing',
            'game_system_rules',
          ]);
        }
      }
      continue;
    }

    if (identifier === 'personaDescription') {
      if (enabled) {
        pushUniqueSection(syspromptSectionOrder, seenSections, 'persona');
      }
      continue;
    }

    if (CARD_MARKER_IDS.has(identifier)) {
      if (enabled && !seenSections.has('card')) {
        pushUniqueSection(syspromptSectionOrder, seenSections, 'card');
        if (preserveRefereeCoreRules) {
          insertSectionsAfterAnchor(syspromptSectionOrder, seenSections, 'card', [
            'state',
            'combat_outcome',
            'plot',
          ]);
        }
      }
      continue;
    }

    if (WORLD_MARKER_IDS.has(identifier)) {
      if (enabled && !seenSections.has('world')) {
        pushUniqueSection(syspromptSectionOrder, seenSections, 'world');
      }
      if (!isMarker && content.trim().length > 0 && (enabled || includeDisabledPrompts)) {
        const blockId = allocateUniqueStPromptId(identifier, usedPromptIds, i);
        const name =
          getOwnString(promptDef ?? {}, 'name')?.trim() ||
          KNOWN_ST_MARKER_NAMES[identifier] ||
          identifier;
        const role = normalizePromptRole(getOwnValue(promptDef ?? {}, 'role'));
        const rawPos = getOwnNumber(promptDef ?? {}, 'injection_position');
        const injectionPosition: CustomPromptBlockInjectionPosition =
          rawPos === 1 ? 'in_chat' : 'relative';
        const rawDepth = getOwnNumber(promptDef ?? {}, 'injection_depth');
        const spec: CustomPromptBlockSpec = {
          id: blockId,
          name,
          role,
          injectionPosition,
          ...(rawDepth !== undefined ? { injectionDepth: Math.max(0, Math.trunc(rawDepth)) } : {}),
        };
        setSafeProperty(customPromptBlocks, blockId, spec);
        setSafeProperty(basePrompts, blockId, content);
        setSafeProperty(unlockedPromptSections, blockId, enabled);
        pushUniqueSection(syspromptSectionOrder, seenSections, blockId);
      }
      continue;
    }

    if (identifier === 'chatHistory') {
      if (enabled) {
        pushUniqueSection(syspromptSectionOrder, seenSections, 'transcript_window');
      }
      continue;
    }

    if (!enabled && !includeDisabledPrompts) {
      continue;
    }

    const blockId = allocateUniqueStPromptId(identifier, usedPromptIds, i);
    const name =
      getOwnString(promptDef ?? {}, 'name')?.trim() ||
      KNOWN_ST_MARKER_NAMES[identifier] ||
      identifier;
    const role = normalizePromptRole(getOwnValue(promptDef ?? {}, 'role'));
    const rawPos = getOwnNumber(promptDef ?? {}, 'injection_position');
    const injectionPosition: CustomPromptBlockInjectionPosition =
      rawPos === 1 ? 'in_chat' : 'relative';
    const rawDepth = getOwnNumber(promptDef ?? {}, 'injection_depth');

    const spec: CustomPromptBlockSpec = {
      id: blockId,
      name,
      role,
      injectionPosition,
      ...(rawDepth !== undefined ? { injectionDepth: Math.max(0, Math.trunc(rawDepth)) } : {}),
    };

    setSafeProperty(customPromptBlocks, blockId, spec);
    setSafeProperty(basePrompts, blockId, content);
    setSafeProperty(unlockedPromptSections, blockId, enabled);
    pushUniqueSection(syspromptSectionOrder, seenSections, blockId);
  }

  if (preserveRefereeCoreRules) {
    ensureRefereeCoreSections(syspromptSectionOrder, seenSections);
  }

  const layer: ControlRoomLayer = {
    syspromptSectionOrder,
    ...(Object.keys(basePrompts).length > 0 ? { basePrompts } : {}),
    ...(Object.keys(unlockedPromptSections).length > 0 ? { unlockedPromptSections } : {}),
    ...(Object.keys(customPromptBlocks).length > 0 ? { customPromptBlocks } : {}),
    generation: cloneGenerationPresetConfig(generation),
    ...(Object.keys(tokenBudgets).length > 0 ? { tokenBudgets } : {}),
  };

  return ok({
    format: 'st_chat_completion',
    presetName,
    layer,
    generation,
    tokenBudgets,
    warnings,
  });
}

function parseStoryStringMacroOrder(
  storyString: string | undefined,
  preserveRefereeCoreRules: boolean
): { order: string[]; hasDialogueExamples: boolean } {
  const order: string[] = [];
  const seen = new Set<string>();
  let hasDialogueExamples = false;

  if (typeof storyString === 'string' && storyString.length > 0) {
    const macroRe =
      /\{\{\s*(system|wiBefore|description|personality|scenario|persona|wiAfter|mesExamples)\s*\}\}/g;
    let match: RegExpExecArray | null = macroRe.exec(storyString);
    while (match !== null) {
      const macro = match[1];
      switch (macro) {
        case 'system':
          pushUniqueSection(order, seen, 'system');
          if (preserveRefereeCoreRules) {
            insertSectionsAfterAnchor(order, seen, 'system', [
              'narrative_pacing',
              'game_system_rules',
            ]);
          }
          break;
        case 'wiBefore':
        case 'wiAfter':
          pushUniqueSection(order, seen, 'world');
          break;
        case 'description':
        case 'personality':
        case 'scenario':
          if (!seen.has('card')) {
            pushUniqueSection(order, seen, 'card');
            if (preserveRefereeCoreRules) {
              insertSectionsAfterAnchor(order, seen, 'card', [
                'state',
                'combat_outcome',
                'plot',
              ]);
            }
          }
          break;
        case 'persona':
          pushUniqueSection(order, seen, 'persona');
          break;
        case 'mesExamples':
          pushUniqueSection(order, seen, 'st_prompt:dialogueExamples');
          hasDialogueExamples = true;
          break;
      }
      match = macroRe.exec(storyString);
    }
  }

  if (order.length === 0) {
    pushUniqueSection(order, seen, 'system');
    if (preserveRefereeCoreRules) {
      pushUniqueSection(order, seen, 'narrative_pacing');
      pushUniqueSection(order, seen, 'game_system_rules');
    }
    pushUniqueSection(order, seen, 'persona');
    pushUniqueSection(order, seen, 'card');
    if (preserveRefereeCoreRules) {
      pushUniqueSection(order, seen, 'state');
      pushUniqueSection(order, seen, 'combat_outcome');
      pushUniqueSection(order, seen, 'plot');
    }
    pushUniqueSection(order, seen, 'world');
    pushUniqueSection(order, seen, 'transcript_window');
    pushUniqueSection(order, seen, 'latest_input');
  } else if (preserveRefereeCoreRules) {
    ensureRefereeCoreSections(order, seen);
  }

  return { order, hasDialogueExamples };
}

function importTextCompletionPreset(
  root: Record<string, unknown>,
  options: SillyTavernPresetImportOptions
): Result<SillyTavernPresetImportResult, ValidationError[]> {
  const warnings: ValidationError[] = [];
  const preserveRefereeCoreRules = options.preserveRefereeCoreRules !== false;

  const presetName =
    options.presetName?.trim() ||
    firstDefinedString(root, ['name', 'preset_name'])?.trim() ||
    'Imported SillyTavern Text Completion Preset';

  const temperature = firstDefinedNumber(root, ['temp', 'temperature']);
  const maxTokens = firstDefinedNumber(root, ['amount_gen', 'max_length', 'max_tokens']);
  const maxContextTokens = firstDefinedNumber(root, ['max_context', 'max_context_length']);
  const topP = getOwnNumber(root, 'top_p');
  const topK = getOwnNumber(root, 'top_k');
  const minP = getOwnNumber(root, 'min_p');
  const topA = getOwnNumber(root, 'top_a');
  const typicalP = firstDefinedNumber(root, ['typical', 'typical_p']);
  const tfs = getOwnNumber(root, 'tfs');
  const frequencyPenalty = firstDefinedNumber(root, ['freq_pen', 'frequency_penalty']);
  const presencePenalty = firstDefinedNumber(root, ['pres_pen', 'presence_penalty']);
  const repetitionPenalty = firstDefinedNumber(root, ['rep_pen', 'repetition_penalty']);
  const rawSeed = getOwnNumber(root, 'seed');
  const seed = rawSeed !== undefined && rawSeed >= 0 ? Math.trunc(rawSeed) : undefined;
  const stopSequences = extractStopSequences(root, ['stop_sequence', 'stopping_strings', 'stop']);
  const stFormatTemplates = buildStFormatTemplates(root, true);

  if (
    getOwnString(root, 'input_sequence') !== undefined ||
    getOwnString(root, 'output_sequence') !== undefined ||
    getOwnString(root, 'system_sequence') !== undefined ||
    getOwnString(root, 'story_string') !== undefined ||
    getOwnValue(root, 'wrap') !== undefined
  ) {
    warnings.push(
      validationError(
        'stFormatTemplates',
        'INSTRUCT_SEQUENCES_PRESERVED',
        'Raw SillyTavern instruct/story_string templates were preserved in generation.stFormatTemplates; Referee compiles structured chat messages unless a text-completion adapter is used.'
      )
    );
  }

  const generation: GenerationPresetConfig = {
    presetName,
    sourceFormat: 'st_text_completion',
    ...(temperature !== undefined ? { temperature } : {}),
    ...(maxTokens !== undefined ? { maxTokens: Math.floor(maxTokens) } : {}),
    ...(maxContextTokens !== undefined ? { maxContextTokens: Math.floor(maxContextTokens) } : {}),
    ...(topP !== undefined ? { topP } : {}),
    ...(topK !== undefined ? { topK: Math.floor(topK) } : {}),
    ...(minP !== undefined ? { minP } : {}),
    ...(topA !== undefined ? { topA } : {}),
    ...(typicalP !== undefined ? { typicalP } : {}),
    ...(tfs !== undefined ? { tfs } : {}),
    ...(frequencyPenalty !== undefined ? { frequencyPenalty } : {}),
    ...(presencePenalty !== undefined ? { presencePenalty } : {}),
    ...(repetitionPenalty !== undefined ? { repetitionPenalty } : {}),
    ...(stopSequences !== undefined ? { stopSequences } : {}),
    ...(seed !== undefined ? { seed } : {}),
    ...(stFormatTemplates !== undefined ? { stFormatTemplates } : {}),
  };

  const tokenBudgets = deriveTokenBudgets(maxContextTokens, maxTokens);

  const basePrompts: Record<string, string> = {};
  const unlockedPromptSections: Record<string, boolean> = {};
  const customPromptBlocks: Record<string, CustomPromptBlockSpec> = {};

  const systemPrompt = getOwnString(root, 'system_prompt');
  if (systemPrompt !== undefined && systemPrompt.trim().length > 0) {
    setSafeProperty(basePrompts, 'system', systemPrompt);
    setSafeProperty(unlockedPromptSections, 'system', true);
  }

  const { order: syspromptSectionOrder, hasDialogueExamples } = parseStoryStringMacroOrder(
    getOwnString(root, 'story_string'),
    preserveRefereeCoreRules
  );

  if (hasDialogueExamples) {
    setSafeProperty(basePrompts, 'st_prompt:dialogueExamples', '');
    setSafeProperty(unlockedPromptSections, 'st_prompt:dialogueExamples', true);
    setSafeProperty(customPromptBlocks, 'st_prompt:dialogueExamples', {
      id: 'st_prompt:dialogueExamples',
      name: 'Dialogue Examples',
      role: 'system',
      injectionPosition: 'relative',
    });
  }

  const layer: ControlRoomLayer = {
    syspromptSectionOrder,
    ...(Object.keys(basePrompts).length > 0 ? { basePrompts } : {}),
    ...(Object.keys(unlockedPromptSections).length > 0 ? { unlockedPromptSections } : {}),
    ...(Object.keys(customPromptBlocks).length > 0 ? { customPromptBlocks } : {}),
    generation: cloneGenerationPresetConfig(generation),
    ...(Object.keys(tokenBudgets).length > 0 ? { tokenBudgets } : {}),
  };

  return ok({
    format: 'st_text_completion',
    presetName,
    layer,
    generation,
    tokenBudgets,
    warnings,
  });
}

function validateAndImportRefereePreset(
  root: Record<string, unknown>,
  options: SillyTavernPresetImportOptions
): Result<SillyTavernPresetImportResult, ValidationError[]> {
  const nestedLayer = getOwnValue(root, 'layer');
  const rawLayer = isPlainObject(nestedLayer) ? nestedLayer : root;
  const basePath = isPlainObject(nestedLayer) ? 'layer' : '';

  const acc = new ErrorAccumulator(basePath);

  const checkStringArray = (field: string): void => {
    const val = getOwnValue(rawLayer, field);
    if (val === undefined) {
      return;
    }
    if (!Array.isArray(val) || !val.every((item) => typeof item === 'string')) {
      acc.add(field, 'INVALID_TYPE', `${field} must be an array of strings`);
    }
  };

  checkStringArray('blockOrder');
  checkStringArray('syspromptSectionOrder');

  const rawBasePrompts = getOwnValue(rawLayer, 'basePrompts');
  if (rawBasePrompts !== undefined) {
    if (!isPlainObject(rawBasePrompts)) {
      acc.add('basePrompts', 'INVALID_TYPE', 'basePrompts must be a plain object');
    } else {
      for (const key of Object.keys(rawBasePrompts)) {
        if (typeof getOwnValue(rawBasePrompts, key) !== 'string') {
          acc.add(`basePrompts.${key}`, 'INVALID_TYPE', 'basePrompts values must be strings');
        }
      }
    }
  }

  const rawUnlocked = getOwnValue(rawLayer, 'unlockedPromptSections');
  if (rawUnlocked !== undefined) {
    if (!isPlainObject(rawUnlocked)) {
      acc.add(
        'unlockedPromptSections',
        'INVALID_TYPE',
        'unlockedPromptSections must be a plain object'
      );
    } else {
      for (const key of Object.keys(rawUnlocked)) {
        if (typeof getOwnValue(rawUnlocked, key) !== 'boolean') {
          acc.add(
            `unlockedPromptSections.${key}`,
            'INVALID_TYPE',
            'unlockedPromptSections values must be booleans'
          );
        }
      }
    }
  }

  const rawCustomBlocks = getOwnValue(rawLayer, 'customPromptBlocks');
  if (rawCustomBlocks !== undefined) {
    if (!isPlainObject(rawCustomBlocks)) {
      acc.add('customPromptBlocks', 'INVALID_TYPE', 'customPromptBlocks must be a plain object');
    } else {
      for (const key of Object.keys(rawCustomBlocks)) {
        const block = getOwnValue(rawCustomBlocks, key);
        const blockAcc = acc.scope(`customPromptBlocks.${key}`);
        if (!isPlainObject(block)) {
          blockAcc.add('', 'INVALID_TYPE', 'CustomPromptBlockSpec must be a plain object');
          continue;
        }
        if (typeof getOwnValue(block, 'id') !== 'string') {
          blockAcc.add('id', 'INVALID_TYPE', 'id must be a string');
        }
        if (typeof getOwnValue(block, 'name') !== 'string') {
          blockAcc.add('name', 'INVALID_TYPE', 'name must be a string');
        }
        const role = getOwnValue(block, 'role');
        if (typeof role !== 'string' || !VALID_CUSTOM_ROLES.has(role)) {
          blockAcc.add('role', 'INVALID_ENUM', 'role must be system, user, or assistant');
        }
        const injPos = getOwnValue(block, 'injectionPosition');
        if (
          injPos !== undefined &&
          (typeof injPos !== 'string' || !VALID_INJECTION_POSITIONS.has(injPos))
        ) {
          blockAcc.add(
            'injectionPosition',
            'INVALID_ENUM',
            'injectionPosition must be relative or in_chat'
          );
        }
        const injDepth = getOwnValue(block, 'injectionDepth');
        if (injDepth !== undefined && (typeof injDepth !== 'number' || !Number.isFinite(injDepth))) {
          blockAcc.add('injectionDepth', 'INVALID_NUMBER', 'injectionDepth must be a finite number');
        }
      }
    }
  }

  const rawGen = getOwnValue(rawLayer, 'generation');
  if (rawGen !== undefined) {
    const gAcc = acc.scope('generation');
    if (!isPlainObject(rawGen)) {
      gAcc.add('', 'INVALID_TYPE', 'generation must be a plain object');
    } else {
      for (const numKey of ST_GENERATION_NUMERIC_FIELDS) {
        const numVal = getOwnValue(rawGen, numKey);
        if (numVal !== undefined && (typeof numVal !== 'number' || !Number.isFinite(numVal))) {
          gAcc.add(numKey, 'INVALID_NUMBER', `${numKey} must be a finite number`);
        }
      }
      const stopSeq = getOwnValue(rawGen, 'stopSequences');
      if (
        stopSeq !== undefined &&
        (!Array.isArray(stopSeq) || !stopSeq.every((s) => typeof s === 'string'))
      ) {
        gAcc.add('stopSequences', 'INVALID_TYPE', 'stopSequences must be an array of strings');
      }
      const genPresetName = getOwnValue(rawGen, 'presetName');
      if (genPresetName !== undefined && typeof genPresetName !== 'string') {
        gAcc.add('presetName', 'INVALID_TYPE', 'presetName must be a string');
      }
      const srcFormat = getOwnValue(rawGen, 'sourceFormat');
      if (
        srcFormat !== undefined &&
        (typeof srcFormat !== 'string' || !VALID_GENERATION_SOURCE_FORMATS.has(srcFormat))
      ) {
        gAcc.add('sourceFormat', 'INVALID_ENUM', 'Invalid generation sourceFormat');
      }
      const rawTemplates = getOwnValue(rawGen, 'stFormatTemplates');
      if (rawTemplates !== undefined) {
        if (!isPlainObject(rawTemplates)) {
          gAcc.add('stFormatTemplates', 'INVALID_TYPE', 'stFormatTemplates must be a plain object');
        } else {
          for (const tKey of ST_FORMAT_TEMPLATE_KEYS) {
            const tVal = getOwnValue(rawTemplates, tKey);
            if (tVal !== undefined && typeof tVal !== 'string') {
              gAcc.add(
                `stFormatTemplates.${tKey}`,
                'INVALID_TYPE',
                `${tKey} must be a string`
              );
            }
          }
        }
      }
    }
  }

  const rawBudgets = getOwnValue(rawLayer, 'tokenBudgets');
  if (rawBudgets !== undefined) {
    acc.absorb(
      validateTokenBudgets(rawBudgets as Partial<SectionTokenBudgets>, 'tokenBudgets')
    );
  }

  if (acc.hasErrors()) {
    return err([...acc.errors]);
  }

  const clonedLayer = cloneControlRoomLayer(rawLayer as unknown as ControlRoomLayer);
  const presetName =
    options.presetName?.trim() ||
    firstDefinedString(root, ['name', 'presetName'])?.trim() ||
    clonedLayer.generation?.presetName?.trim() ||
    'Imported Referee Preset';

  const generation: GenerationPresetConfig = {
    ...(clonedLayer.generation !== undefined ? cloneGenerationPresetConfig(clonedLayer.generation) : {}),
    presetName,
    sourceFormat: clonedLayer.generation?.sourceFormat ?? 'referee',
  };
  clonedLayer.generation = cloneGenerationPresetConfig(generation);

  const tokenBudgets =
    clonedLayer.tokenBudgets !== undefined
      ? cloneTokenBudgetsPartial(clonedLayer.tokenBudgets)
      : {};

  return ok({
    format: 'referee',
    presetName,
    layer: clonedLayer,
    generation,
    tokenBudgets,
    warnings: [],
  });
}

function parseRawPresetInput(
  input: string | Buffer | Record<string, unknown>
): Result<Record<string, unknown>, ValidationError[]> {
  let parsed: unknown;
  if (Buffer.isBuffer(input)) {
    const text = input.toString('utf8').trim();
    if (text.length === 0) {
      return err([validationError('', 'EMPTY_PAYLOAD', 'Preset buffer payload is empty')]);
    }
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return err([validationError('', 'INVALID_JSON', 'Failed to parse preset buffer as JSON')]);
    }
  } else if (typeof input === 'string') {
    const trimmed = input.trim();
    if (trimmed.length === 0) {
      return err([validationError('', 'EMPTY_PAYLOAD', 'Preset string payload is empty')]);
    }
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      return err([validationError('', 'INVALID_JSON', 'Failed to parse preset string as JSON')]);
    }
  } else if (isPlainObject(input)) {
    parsed = input;
  } else {
    return err([
      validationError(
        '',
        'INVALID_TYPE',
        'Preset input must be a JSON string, Buffer, or plain object'
      ),
    ]);
  }

  if (!isPlainObject(parsed)) {
    return err([
      validationError('', 'INVALID_TYPE', 'Decoded preset root must be a plain object'),
    ]);
  }

  const acc = new ErrorAccumulator();
  scanObjectForUnsafeKeys(parsed, acc);
  if (acc.hasErrors()) {
    return err([...acc.errors]);
  }

  return ok(sanitizeJsonValue(parsed) as Record<string, unknown>);
}

/**
 * Import a SillyTavern Chat Completion preset, SillyTavern Text Completion / Instruct preset,
 * or native Referee {@link ControlRoomLayer} preset into a normalized Control Room overlay.
 */
export function importSillyTavernPreset(
  input: string | Buffer | Record<string, unknown>,
  options: SillyTavernPresetImportOptions = {}
): Result<SillyTavernPresetImportResult, ValidationError[]> {
  const parsedRes = parseRawPresetInput(input);
  if (!parsedRes.ok) {
    return parsedRes;
  }

  const root = parsedRes.value;

  if (isChatCompletionPreset(root)) {
    return importChatCompletionPreset(root, options);
  }
  if (isTextCompletionPreset(root)) {
    return importTextCompletionPreset(root, options);
  }
  if (isRefereePreset(root)) {
    return validateAndImportRefereePreset(root, options);
  }

  return err([
    validationError(
      '',
      'UNRECOGNIZED_PRESET_FORMAT',
      'Input object does not match SillyTavern Chat Completion, Text Completion, or Referee ControlRoomLayer format'
    ),
  ]);
}
