import type { SectionTokenBudgets } from '../context/tokenizer-budget.js';
import type { SamplingParameters } from '../gateway/types.js';
import {
  type CharacterSectionDef,
  SHEET_PRESETS,
  type SheetPresetId,
  cloneCharacterSections,
} from '../schema/character-sections.js';
import type { EffectiveSystemConfig } from '../schema/dynamic-schema-compiler.js';
import {
  type CadencePolicy,
  type ConfirmPolicy,
  type DynamicFieldSpec,
  type EffectOwner,
  type GameSystemModule,
  type GameSystemModuleUi,
  type ModuleScope,
  type ModuleTarget,
  type SystemCapabilities,
  type SystemPack,
  cloneCadencePolicy,
  cloneDynamicFieldSpec,
  cloneGameSystemModule,
  cloneSystemCapabilities,
} from '../schema/tracker-module.js';

export type BeatPressure = 'off' | 'generous' | 'standard' | 'harsh';
export type NarrativePacing = 'slow_burn' | 'balanced' | 'fast_forward';

export type PayloadGroupId =
  | 'capabilities'
  | 'characterSections'
  | 'gameSystems'
  | 'promptSections'
  | 'combatRules'
  | 'tuningDials'
  | 'generation';

export const ALL_PAYLOAD_GROUP_IDS: readonly PayloadGroupId[] = Object.freeze([
  'capabilities',
  'characterSections',
  'gameSystems',
  'promptSections',
  'combatRules',
  'tuningDials',
  'generation',
]);

export interface TuningDials {
  beatPressure: BeatPressure;
  narrativePacing: NarrativePacing;
  cyoaEnabled: boolean;
  use24hTime: boolean;
  useDdMmYyFormat: boolean;
  autoRegisterEmergentNpcs?: boolean;
}

export interface StFormatTemplates {
  wiFormat?: string;
  scenarioFormat?: string;
  personalityFormat?: string;
  impersonationPrompt?: string;
  newChatPrompt?: string;
  continueNudgePrompt?: string;
  storyString?: string;
  inputSequence?: string;
  outputSequence?: string;
}

export type GenerationSourceFormat = 'st_chat_completion' | 'st_text_completion' | 'referee';

export interface GenerationPresetConfig extends SamplingParameters {
  presetName?: string;
  sourceFormat?: GenerationSourceFormat;
  stFormatTemplates?: StFormatTemplates;
}

export type CustomPromptBlockRole = 'system' | 'user' | 'assistant';
export type CustomPromptBlockInjectionPosition = 'relative' | 'in_chat';

export interface CustomPromptBlockSpec {
  id: string;
  name: string;
  role: CustomPromptBlockRole;
  injectionPosition?: CustomPromptBlockInjectionPosition;
  injectionDepth?: number;
}

export interface CombatRulesConfig {
  diceEnabled: boolean;
  diceMode: 'd20' | 'd100';
  allowPartialActionSalvage: boolean;
  fallbackTacticsEnabled: boolean;
  customRules: Record<string, string>;
  skillOverrides: Record<string, Record<string, unknown>>;
}

export interface GameSystemModuleOverride {
  name?: string;
  description?: string;
  enabled?: boolean;
  scope?: ModuleScope;
  target?: ModuleTarget;
  effectOwner?: EffectOwner;
  cadence?: CadencePolicy;
  fields?: Record<string, DynamicFieldSpec>;
  fieldConfirmPolicies?: Record<string, ConfirmPolicy>;
  trackerInstruction?: string;
  narratorRule?: string;
  ui?: Partial<GameSystemModuleUi>;
  createIfMissing?: boolean;
}

export interface SectionConfirmPolicyOverrides {
  pc?: Record<string, ConfirmPolicy>;
  npc?: Record<string, ConfirmPolicy>;
}

export interface ControlRoomLayer {
  capabilities?: Partial<SystemCapabilities>;
  pcCoreSections?: CharacterSectionDef[];
  npcCoreSections?: CharacterSectionDef[];
  sectionConfirmPolicies?: SectionConfirmPolicyOverrides;
  gameSystems?: GameSystemModule[];
  gameSystemOverrides?: Record<string, GameSystemModuleOverride>;
  blockOrder?: string[];
  syspromptSectionOrder?: string[];
  basePrompts?: Record<string, string>;
  unlockedPromptSections?: Record<string, boolean>;
  customPromptBlocks?: Record<string, CustomPromptBlockSpec>;
  combatRules?: Partial<CombatRulesConfig>;
  tuningDials?: Partial<TuningDials>;
  generation?: GenerationPresetConfig;
  tokenBudgets?: Partial<SectionTokenBudgets>;
}

export interface ResolvedControlRoomConfig extends EffectiveSystemConfig {
  packId: string;
  packName: string;
  basePrompts: Record<string, string>;
  unlockedPromptSections: Record<string, boolean>;
  customPromptBlocks?: Record<string, CustomPromptBlockSpec>;
  combatRules: CombatRulesConfig;
  tuningDials: TuningDials;
  generation?: GenerationPresetConfig;
  tokenBudgets?: Partial<SectionTokenBudgets>;
}

export const DEFAULT_TUNING_DIALS: Readonly<TuningDials> = Object.freeze({
  beatPressure: 'standard',
  narrativePacing: 'balanced',
  cyoaEnabled: false,
  use24hTime: false,
  useDdMmYyFormat: false,
});

export const DEFAULT_COMBAT_RULES: Readonly<CombatRulesConfig> = Object.freeze({
  diceEnabled: true,
  diceMode: 'd20',
  allowPartialActionSalvage: true,
  fallbackTacticsEnabled: true,
  customRules: Object.freeze({}),
  skillOverrides: Object.freeze({}),
});

const UNSAFE_RECORD_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

function isSafeRecordKey(key: string): boolean {
  return !UNSAFE_RECORD_KEYS.has(key);
}

function setSafeRecordEntry<T>(record: Record<string, T>, key: string, value: T): void {
  if (!isSafeRecordKey(key)) {
    return;
  }
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function compareStringsDeterministic(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

function cloneUnknownValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(cloneUnknownValue);
  }
  const cloned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (isSafeRecordKey(k)) {
      cloned[k] = cloneUnknownValue(v);
    }
  }
  return cloned;
}

export function cloneStringRecord(source: Readonly<Record<string, string>>): Record<string, string> {
  const cloned: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (isSafeRecordKey(key) && typeof value === 'string') {
      cloned[key] = value;
    }
  }
  return cloned;
}

export function cloneBooleanRecord(
  source: Readonly<Record<string, boolean>>
): Record<string, boolean> {
  const cloned: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(source)) {
    if (isSafeRecordKey(key) && typeof value === 'boolean') {
      cloned[key] = value;
    }
  }
  return cloned;
}

function cloneConfirmPolicyRecord(
  source: Readonly<Record<string, ConfirmPolicy>>
): Record<string, ConfirmPolicy> {
  const cloned: Record<string, ConfirmPolicy> = {};
  for (const [key, value] of Object.entries(source)) {
    if (isSafeRecordKey(key) && value !== undefined) {
      cloned[key] = value;
    }
  }
  return cloned;
}

function cloneSkillOverrides(
  source: Readonly<Record<string, Readonly<Record<string, unknown>>>>
): Record<string, Record<string, unknown>> {
  const cloned: Record<string, Record<string, unknown>> = {};
  for (const [skillId, skillPatch] of Object.entries(source)) {
    if (!isSafeRecordKey(skillId) || skillPatch === null || typeof skillPatch !== 'object') {
      continue;
    }
    const inner: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(skillPatch)) {
      if (isSafeRecordKey(k)) {
        inner[k] = cloneUnknownValue(v);
      }
    }
    cloned[skillId] = inner;
  }
  return cloned;
}

export function cloneCombatRules(rules: Readonly<CombatRulesConfig>): CombatRulesConfig {
  return {
    diceEnabled: rules.diceEnabled,
    diceMode: rules.diceMode,
    allowPartialActionSalvage: rules.allowPartialActionSalvage,
    fallbackTacticsEnabled: rules.fallbackTacticsEnabled,
    customRules: cloneStringRecord(rules.customRules),
    skillOverrides: cloneSkillOverrides(rules.skillOverrides),
  };
}

export function cloneCombatRulesPartial(
  rules: Readonly<Partial<CombatRulesConfig>>
): Partial<CombatRulesConfig> {
  const cloned: Partial<CombatRulesConfig> = {};
  if (rules.diceEnabled !== undefined) {
    cloned.diceEnabled = rules.diceEnabled;
  }
  if (rules.diceMode !== undefined) {
    cloned.diceMode = rules.diceMode;
  }
  if (rules.allowPartialActionSalvage !== undefined) {
    cloned.allowPartialActionSalvage = rules.allowPartialActionSalvage;
  }
  if (rules.fallbackTacticsEnabled !== undefined) {
    cloned.fallbackTacticsEnabled = rules.fallbackTacticsEnabled;
  }
  if (rules.customRules !== undefined) {
    cloned.customRules = cloneStringRecord(rules.customRules);
  }
  if (rules.skillOverrides !== undefined) {
    cloned.skillOverrides = cloneSkillOverrides(rules.skillOverrides);
  }
  return cloned;
}

export function cloneGameSystemModuleOverride(
  override: Readonly<GameSystemModuleOverride>
): GameSystemModuleOverride {
  const cloned: GameSystemModuleOverride = {};
  if (override.name !== undefined) {
    cloned.name = override.name;
  }
  if (override.description !== undefined) {
    cloned.description = override.description;
  }
  if (override.enabled !== undefined) {
    cloned.enabled = override.enabled;
  }
  if (override.scope !== undefined) {
    cloned.scope = override.scope;
  }
  if (override.target !== undefined) {
    cloned.target = override.target;
  }
  if (override.effectOwner !== undefined) {
    cloned.effectOwner = override.effectOwner;
  }
  if (override.cadence !== undefined) {
    cloned.cadence = cloneCadencePolicy(override.cadence);
  }
  if (override.fields !== undefined) {
    const clonedFields: Record<string, DynamicFieldSpec> = {};
    for (const [fieldKey, spec] of Object.entries(override.fields)) {
      if (isSafeRecordKey(fieldKey)) {
        clonedFields[fieldKey] = cloneDynamicFieldSpec(spec);
      }
    }
    cloned.fields = clonedFields;
  }
  if (override.fieldConfirmPolicies !== undefined) {
    cloned.fieldConfirmPolicies = cloneConfirmPolicyRecord(override.fieldConfirmPolicies);
  }
  if (override.trackerInstruction !== undefined) {
    cloned.trackerInstruction = override.trackerInstruction;
  }
  if (override.narratorRule !== undefined) {
    cloned.narratorRule = override.narratorRule;
  }
  if (override.ui !== undefined) {
    cloned.ui = { ...override.ui };
  }
  if (override.createIfMissing !== undefined) {
    cloned.createIfMissing = override.createIfMissing;
  }
  return cloned;
}

export function cloneGameSystemOverrides(
  overrides: Readonly<Record<string, GameSystemModuleOverride>>
): Record<string, GameSystemModuleOverride> {
  const cloned: Record<string, GameSystemModuleOverride> = {};
  for (const [moduleId, override] of Object.entries(overrides)) {
    if (isSafeRecordKey(moduleId)) {
      cloned[moduleId] = cloneGameSystemModuleOverride(override);
    }
  }
  return cloned;
}

export function cloneCapabilitiesPartial(
  capabilities: Readonly<Partial<SystemCapabilities>>
): Partial<SystemCapabilities> {
  const cloned: Partial<SystemCapabilities> = {};
  if (capabilities.spatialMode !== undefined) {
    cloned.spatialMode = capabilities.spatialMode;
  }
  if (capabilities.combatMode !== undefined) {
    cloned.combatMode = capabilities.combatMode;
  }
  if (capabilities.progression !== undefined) {
    cloned.progression = capabilities.progression;
  }
  if (capabilities.clocks !== undefined) {
    cloned.clocks = capabilities.clocks;
  }
  if (capabilities.factions !== undefined) {
    cloned.factions = capabilities.factions;
  }
  if (capabilities.beats !== undefined) {
    cloned.beats = capabilities.beats;
  }
  if (capabilities.relationships !== undefined) {
    cloned.relationships = capabilities.relationships;
  }
  if (capabilities.chronicle !== undefined) {
    cloned.chronicle = capabilities.chronicle;
  }
  return cloned;
}

export function cloneTuningDialsPartial(
  dials: Readonly<Partial<TuningDials>>
): Partial<TuningDials> {
  const cloned: Partial<TuningDials> = {};
  if (dials.beatPressure !== undefined) {
    cloned.beatPressure = dials.beatPressure;
  }
  if (dials.narrativePacing !== undefined) {
    cloned.narrativePacing = dials.narrativePacing;
  }
  if (dials.cyoaEnabled !== undefined) {
    cloned.cyoaEnabled = dials.cyoaEnabled;
  }
  if (dials.use24hTime !== undefined) {
    cloned.use24hTime = dials.use24hTime;
  }
  if (dials.useDdMmYyFormat !== undefined) {
    cloned.useDdMmYyFormat = dials.useDdMmYyFormat;
  }
  if (dials.autoRegisterEmergentNpcs !== undefined) {
    cloned.autoRegisterEmergentNpcs = dials.autoRegisterEmergentNpcs;
  }
  return cloned;
}

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

export function cloneStFormatTemplates(
  templates: Readonly<StFormatTemplates>
): StFormatTemplates {
  const cloned: StFormatTemplates = {};
  for (const key of ST_FORMAT_TEMPLATE_KEYS) {
    const val = templates[key];
    if (typeof val === 'string') {
      cloned[key] = val;
    }
  }
  return cloned;
}

function mergeStFormatTemplates(
  base?: Readonly<StFormatTemplates>,
  patch?: Readonly<StFormatTemplates>
): StFormatTemplates | undefined {
  if (base === undefined && patch === undefined) {
    return undefined;
  }
  const merged = base !== undefined ? cloneStFormatTemplates(base) : {};
  if (patch !== undefined) {
    for (const key of ST_FORMAT_TEMPLATE_KEYS) {
      const val = patch[key];
      if (typeof val === 'string') {
        merged[key] = val;
      }
    }
  }
  return merged;
}

type MutableGenerationPresetConfig = {
  -readonly [K in keyof GenerationPresetConfig]: GenerationPresetConfig[K];
};

const GENERATION_NUMERIC_KEYS: readonly (
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

export function cloneGenerationPresetConfig(
  preset: Readonly<GenerationPresetConfig>
): GenerationPresetConfig {
  const cloned: MutableGenerationPresetConfig = {};
  for (const key of GENERATION_NUMERIC_KEYS) {
    const val = preset[key];
    if (typeof val === 'number' && Number.isFinite(val)) {
      cloned[key] = val;
    }
  }
  if (preset.stopSequences !== undefined) {
    cloned.stopSequences = [...preset.stopSequences];
  }
  if (preset.presetName !== undefined) {
    cloned.presetName = preset.presetName;
  }
  if (preset.sourceFormat !== undefined) {
    cloned.sourceFormat = preset.sourceFormat;
  }
  if (preset.stFormatTemplates !== undefined) {
    cloned.stFormatTemplates = cloneStFormatTemplates(preset.stFormatTemplates);
  }
  return cloned;
}

function mergeGenerationPresetConfig(
  base?: Readonly<GenerationPresetConfig>,
  patch?: Readonly<GenerationPresetConfig>
): GenerationPresetConfig | undefined {
  if (base === undefined && patch === undefined) {
    return undefined;
  }
  const next: MutableGenerationPresetConfig =
    base !== undefined ? cloneGenerationPresetConfig(base) : {};
  if (patch === undefined) {
    return next;
  }
  for (const key of GENERATION_NUMERIC_KEYS) {
    const val = patch[key];
    if (typeof val === 'number' && Number.isFinite(val)) {
      next[key] = val;
    }
  }
  if (patch.stopSequences !== undefined) {
    next.stopSequences = [...patch.stopSequences];
  }
  if (patch.presetName !== undefined) {
    next.presetName = patch.presetName;
  }
  if (patch.sourceFormat !== undefined) {
    next.sourceFormat = patch.sourceFormat;
  }
  if (patch.stFormatTemplates !== undefined) {
    next.stFormatTemplates = mergeStFormatTemplates(
      next.stFormatTemplates,
      patch.stFormatTemplates
    );
  }
  return next;
}

export function cloneCustomPromptBlockSpec(
  spec: Readonly<CustomPromptBlockSpec>
): CustomPromptBlockSpec {
  const cloned: CustomPromptBlockSpec = {
    id: spec.id,
    name: spec.name,
    role: spec.role,
  };
  if (spec.injectionPosition !== undefined) {
    cloned.injectionPosition = spec.injectionPosition;
  }
  if (spec.injectionDepth !== undefined) {
    cloned.injectionDepth = spec.injectionDepth;
  }
  return cloned;
}

export function cloneCustomPromptBlocks(
  blocks: Readonly<Record<string, CustomPromptBlockSpec>>
): Record<string, CustomPromptBlockSpec> {
  const cloned: Record<string, CustomPromptBlockSpec> = {};
  for (const [key, spec] of Object.entries(blocks)) {
    if (isSafeRecordKey(key) && spec !== undefined && spec !== null) {
      setSafeRecordEntry(cloned, key, cloneCustomPromptBlockSpec(spec));
    }
  }
  return cloned;
}

function mergeCustomPromptBlocks(
  base?: Readonly<Record<string, CustomPromptBlockSpec>>,
  patch?: Readonly<Record<string, CustomPromptBlockSpec>>
): Record<string, CustomPromptBlockSpec> | undefined {
  if (base === undefined && patch === undefined) {
    return undefined;
  }
  const merged = base !== undefined ? cloneCustomPromptBlocks(base) : {};
  if (patch !== undefined) {
    for (const [key, spec] of Object.entries(patch)) {
      if (isSafeRecordKey(key) && spec !== undefined && spec !== null) {
        setSafeRecordEntry(merged, key, cloneCustomPromptBlockSpec(spec));
      }
    }
  }
  return merged;
}

const TOKEN_BUDGET_KEYS: readonly (keyof SectionTokenBudgets)[] = [
  'system',
  'card',
  'state',
  'combatOutcome',
  'plot',
  'world',
  'totalMaxTokens',
];

export function cloneTokenBudgetsPartial(
  budgets: Readonly<Partial<SectionTokenBudgets>>
): Partial<SectionTokenBudgets> {
  const cloned: Partial<SectionTokenBudgets> = {};
  for (const key of TOKEN_BUDGET_KEYS) {
    const val = budgets[key];
    if (typeof val === 'number' && Number.isFinite(val)) {
      cloned[key] = val;
    }
  }
  return cloned;
}

function mergeTokenBudgets(
  base?: Readonly<Partial<SectionTokenBudgets>>,
  patch?: Readonly<Partial<SectionTokenBudgets>>
): Partial<SectionTokenBudgets> | undefined {
  if (base === undefined && patch === undefined) {
    return undefined;
  }
  const merged = base !== undefined ? cloneTokenBudgetsPartial(base) : {};
  if (patch !== undefined) {
    for (const key of TOKEN_BUDGET_KEYS) {
      const val = patch[key];
      if (typeof val === 'number' && Number.isFinite(val)) {
        merged[key] = val;
      }
    }
  }
  return merged;
}

function cloneSectionConfirmPolicies(
  policies: Readonly<SectionConfirmPolicyOverrides>
): SectionConfirmPolicyOverrides {
  const cloned: SectionConfirmPolicyOverrides = {};
  if (policies.pc !== undefined) {
    cloned.pc = cloneConfirmPolicyRecord(policies.pc);
  }
  if (policies.npc !== undefined) {
    cloned.npc = cloneConfirmPolicyRecord(policies.npc);
  }
  return cloned;
}

export function cloneControlRoomLayer(layer: Readonly<ControlRoomLayer>): ControlRoomLayer {
  const cloned: ControlRoomLayer = {};
  if (layer.capabilities !== undefined) {
    cloned.capabilities = cloneCapabilitiesPartial(layer.capabilities);
  }
  if (layer.pcCoreSections !== undefined) {
    cloned.pcCoreSections = cloneCharacterSections(layer.pcCoreSections);
  }
  if (layer.npcCoreSections !== undefined) {
    cloned.npcCoreSections = cloneCharacterSections(layer.npcCoreSections);
  }
  if (layer.sectionConfirmPolicies !== undefined) {
    cloned.sectionConfirmPolicies = cloneSectionConfirmPolicies(layer.sectionConfirmPolicies);
  }
  if (layer.gameSystems !== undefined) {
    cloned.gameSystems = layer.gameSystems.map(cloneGameSystemModule);
  }
  if (layer.gameSystemOverrides !== undefined) {
    cloned.gameSystemOverrides = cloneGameSystemOverrides(layer.gameSystemOverrides);
  }
  if (layer.blockOrder !== undefined) {
    cloned.blockOrder = [...layer.blockOrder];
  }
  if (layer.syspromptSectionOrder !== undefined) {
    cloned.syspromptSectionOrder = [...layer.syspromptSectionOrder];
  }
  if (layer.basePrompts !== undefined) {
    cloned.basePrompts = cloneStringRecord(layer.basePrompts);
  }
  if (layer.unlockedPromptSections !== undefined) {
    cloned.unlockedPromptSections = cloneBooleanRecord(layer.unlockedPromptSections);
  }
  if (layer.customPromptBlocks !== undefined) {
    cloned.customPromptBlocks = cloneCustomPromptBlocks(layer.customPromptBlocks);
  }
  if (layer.combatRules !== undefined) {
    cloned.combatRules = cloneCombatRulesPartial(layer.combatRules);
  }
  if (layer.tuningDials !== undefined) {
    cloned.tuningDials = cloneTuningDialsPartial(layer.tuningDials);
  }
  if (layer.generation !== undefined) {
    cloned.generation = cloneGenerationPresetConfig(layer.generation);
  }
  if (layer.tokenBudgets !== undefined) {
    cloned.tokenBudgets = cloneTokenBudgetsPartial(layer.tokenBudgets);
  }
  return cloned;
}

export function cloneResolvedControlRoomConfig(
  config: Readonly<ResolvedControlRoomConfig>
): ResolvedControlRoomConfig {
  return {
    packId: config.packId,
    packName: config.packName,
    capabilities: cloneSystemCapabilities(config.capabilities),
    pcCoreSections: cloneCharacterSections(config.pcCoreSections),
    npcCoreSections: cloneCharacterSections(config.npcCoreSections),
    gameSystems: config.gameSystems.map(cloneGameSystemModule),
    blockOrder: [...config.blockOrder],
    syspromptSectionOrder: [...config.syspromptSectionOrder],
    basePrompts: cloneStringRecord(config.basePrompts),
    unlockedPromptSections: cloneBooleanRecord(config.unlockedPromptSections),
    ...(config.customPromptBlocks !== undefined
      ? { customPromptBlocks: cloneCustomPromptBlocks(config.customPromptBlocks) }
      : {}),
    combatRules: cloneCombatRules(config.combatRules),
    tuningDials: { ...config.tuningDials },
    ...(config.generation !== undefined
      ? { generation: cloneGenerationPresetConfig(config.generation) }
      : {}),
    ...(config.tokenBudgets !== undefined
      ? { tokenBudgets: cloneTokenBudgetsPartial(config.tokenBudgets) }
      : {}),
  };
}

export function createEmptyControlRoomLayer(): ControlRoomLayer {
  return {};
}

function mergeCapabilities(
  base: SystemCapabilities,
  patch?: Readonly<Partial<SystemCapabilities>>
): SystemCapabilities {
  const next = cloneSystemCapabilities(base);
  if (patch === undefined) {
    return next;
  }
  if (patch.spatialMode !== undefined) {
    next.spatialMode = patch.spatialMode;
  }
  if (patch.combatMode !== undefined) {
    next.combatMode = patch.combatMode;
  }
  if (patch.progression !== undefined) {
    next.progression = patch.progression;
  }
  if (patch.clocks !== undefined) {
    next.clocks = patch.clocks;
  }
  if (patch.factions !== undefined) {
    next.factions = patch.factions;
  }
  if (patch.beats !== undefined) {
    next.beats = patch.beats;
  }
  if (patch.relationships !== undefined) {
    next.relationships = patch.relationships;
  }
  if (patch.chronicle !== undefined) {
    next.chronicle = patch.chronicle;
  }
  return next;
}

function mergeTuningDials(
  base: TuningDials,
  patch?: Readonly<Partial<TuningDials>>
): TuningDials {
  const next: TuningDials = { ...base };
  if (patch === undefined) {
    return next;
  }
  if (patch.beatPressure !== undefined) {
    next.beatPressure = patch.beatPressure;
  }
  if (patch.narrativePacing !== undefined) {
    next.narrativePacing = patch.narrativePacing;
  }
  if (patch.cyoaEnabled !== undefined) {
    next.cyoaEnabled = patch.cyoaEnabled;
  }
  if (patch.use24hTime !== undefined) {
    next.use24hTime = patch.use24hTime;
  }
  if (patch.useDdMmYyFormat !== undefined) {
    next.useDdMmYyFormat = patch.useDdMmYyFormat;
  }
  if (patch.autoRegisterEmergentNpcs !== undefined) {
    next.autoRegisterEmergentNpcs = patch.autoRegisterEmergentNpcs;
  }
  return next;
}

function mergeCombatRules(
  base: CombatRulesConfig,
  patch?: Readonly<Partial<CombatRulesConfig>>
): CombatRulesConfig {
  const next = cloneCombatRules(base);
  if (patch === undefined) {
    return next;
  }
  if (patch.diceEnabled !== undefined) {
    next.diceEnabled = patch.diceEnabled;
  }
  if (patch.diceMode !== undefined) {
    next.diceMode = patch.diceMode;
  }
  if (patch.allowPartialActionSalvage !== undefined) {
    next.allowPartialActionSalvage = patch.allowPartialActionSalvage;
  }
  if (patch.fallbackTacticsEnabled !== undefined) {
    next.fallbackTacticsEnabled = patch.fallbackTacticsEnabled;
  }
  if (patch.customRules !== undefined) {
    for (const [k, v] of Object.entries(patch.customRules)) {
      if (isSafeRecordKey(k) && typeof v === 'string') {
        next.customRules[k] = v;
      }
    }
  }
  if (patch.skillOverrides !== undefined) {
    for (const [skillId, skillPatch] of Object.entries(patch.skillOverrides)) {
      if (!isSafeRecordKey(skillId) || skillPatch === null || typeof skillPatch !== 'object') {
        continue;
      }
      const existing = next.skillOverrides[skillId] ?? {};
      const mergedSkill: Record<string, unknown> = { ...existing };
      for (const [k, v] of Object.entries(skillPatch)) {
        if (isSafeRecordKey(k) && v !== undefined) {
          mergedSkill[k] = cloneUnknownValue(v);
        }
      }
      next.skillOverrides[skillId] = mergedSkill;
    }
  }
  return next;
}

function applyModuleOverrideToExisting(
  mod: GameSystemModule,
  override: GameSystemModuleOverride
): GameSystemModule {
  const next = cloneGameSystemModule(mod);
  if (override.name !== undefined) {
    next.name = override.name;
  }
  if (override.description !== undefined) {
    next.description = override.description;
  }
  if (override.enabled !== undefined) {
    next.enabled = override.enabled;
  }
  if (override.scope !== undefined) {
    next.scope = override.scope;
  }
  if (override.target !== undefined) {
    next.target = override.target;
  }
  if (override.effectOwner !== undefined) {
    next.effectOwner = override.effectOwner;
  }
  if (override.cadence !== undefined) {
    next.cadence = cloneCadencePolicy(override.cadence);
  }
  if (override.fields !== undefined) {
    for (const [fieldKey, spec] of Object.entries(override.fields)) {
      if (isSafeRecordKey(fieldKey)) {
        next.fields[fieldKey] = cloneDynamicFieldSpec(spec);
      }
    }
  }
  if (override.fieldConfirmPolicies !== undefined) {
    for (const [fieldKey, policy] of Object.entries(override.fieldConfirmPolicies)) {
      if (isSafeRecordKey(fieldKey) && Object.hasOwn(next.fields, fieldKey)) {
        const existingSpec = next.fields[fieldKey];
        if (existingSpec !== undefined) {
          next.fields[fieldKey] = {
            ...cloneDynamicFieldSpec(existingSpec),
            confirmPolicy: policy,
          };
        }
      }
    }
  }
  if (override.trackerInstruction !== undefined) {
    next.trackerInstruction = override.trackerInstruction;
  }
  if (override.narratorRule !== undefined) {
    next.narratorRule = override.narratorRule;
  }
  if (override.ui !== undefined) {
    next.ui = {
      widget: override.ui.widget ?? next.ui.widget,
      order: override.ui.order ?? next.ui.order,
    };
  }
  return next;
}

function createCustomModuleFromOverride(
  moduleId: string,
  override: GameSystemModuleOverride,
  defaultOrder: number
): GameSystemModule {
  const fields: Record<string, DynamicFieldSpec> = {};
  if (override.fields !== undefined) {
    for (const [fieldKey, spec] of Object.entries(override.fields)) {
      if (isSafeRecordKey(fieldKey)) {
        const cloned = cloneDynamicFieldSpec(spec);
        const policy = override.fieldConfirmPolicies?.[fieldKey];
        fields[fieldKey] = policy !== undefined ? { ...cloned, confirmPolicy: policy } : cloned;
      }
    }
  }

  return {
    id: moduleId,
    name: override.name ?? moduleId,
    ...(override.description !== undefined ? { description: override.description } : {}),
    enabled: override.enabled ?? true,
    scope: override.scope ?? 'session',
    target: override.target ?? 'global',
    effectOwner: override.effectOwner ?? 'tracker',
    cadence: override.cadence !== undefined ? cloneCadencePolicy(override.cadence) : 'every_turn',
    fields,
    trackerInstruction: override.trackerInstruction ?? '',
    narratorRule: override.narratorRule ?? '',
    ui: {
      widget: override.ui?.widget ?? 'card',
      order: override.ui?.order ?? defaultOrder,
    },
  };
}

function applyGameSystemOverrides(
  modules: GameSystemModule[],
  overrides?: Readonly<Record<string, GameSystemModuleOverride>>
): GameSystemModule[] {
  const nextModules = modules.map(cloneGameSystemModule);
  if (overrides === undefined) {
    return nextModules;
  }

  const indexById = new Map<string, number>();
  for (let i = 0; i < nextModules.length; i += 1) {
    const mod = nextModules[i];
    if (mod !== undefined) {
      indexById.set(mod.id, i);
    }
  }

  const sortedIds = Object.keys(overrides).filter(isSafeRecordKey).sort(compareStringsDeterministic);
  for (const moduleId of sortedIds) {
    const override = overrides[moduleId];
    if (override === undefined) {
      continue;
    }
    const existingIndex = indexById.get(moduleId);
    if (existingIndex !== undefined) {
      const existingMod = nextModules[existingIndex];
      if (existingMod !== undefined) {
        nextModules[existingIndex] = applyModuleOverrideToExisting(existingMod, override);
      }
    } else if (
      override.createIfMissing ||
      (override.fields !== undefined && Object.keys(override.fields).length > 0)
    ) {
      const created = createCustomModuleFromOverride(
        moduleId,
        override,
        nextModules.length + 1
      );
      indexById.set(moduleId, nextModules.length);
      nextModules.push(created);
    }
  }

  return nextModules;
}

export function createStockBaselineConfig(stockPack: SystemPack): ResolvedControlRoomConfig {
  return {
    packId: stockPack.id,
    packName: stockPack.name,
    capabilities: cloneSystemCapabilities(stockPack.capabilities),
    pcCoreSections: cloneCharacterSections(stockPack.pcCoreSections),
    npcCoreSections: cloneCharacterSections(stockPack.npcCoreSections),
    gameSystems: stockPack.gameSystems.map(cloneGameSystemModule),
    blockOrder: [...stockPack.blockOrder],
    syspromptSectionOrder: [...stockPack.syspromptSectionOrder],
    basePrompts: stockPack.basePrompts !== undefined ? cloneStringRecord(stockPack.basePrompts) : {},
    unlockedPromptSections: {},
    combatRules: cloneCombatRules(DEFAULT_COMBAT_RULES),
    tuningDials: { ...DEFAULT_TUNING_DIALS },
  };
}

function applySectionConfirmPolicies(
  sections: CharacterSectionDef[],
  policies?: Readonly<Record<string, ConfirmPolicy>>
): CharacterSectionDef[] {
  const cloned = cloneCharacterSections(sections);
  if (policies === undefined) {
    return cloned;
  }
  return cloned.map((sec) => {
    if (isSafeRecordKey(sec.id) && Object.hasOwn(policies, sec.id)) {
      const policy = policies[sec.id];
      if (policy !== undefined) {
        return { ...sec, confirmPolicy: policy };
      }
    }
    return sec;
  });
}

export function applyControlRoomLayer(
  base: Readonly<ResolvedControlRoomConfig>,
  layer?: Readonly<ControlRoomLayer>
): ResolvedControlRoomConfig {
  if (layer === undefined) {
    return cloneResolvedControlRoomConfig(base);
  }

  const baseGameSystems =
    layer.gameSystems !== undefined ? layer.gameSystems : base.gameSystems;
  const mergedGameSystems = applyGameSystemOverrides(
    baseGameSystems,
    layer.gameSystemOverrides
  );

  const rawPcSections =
    layer.pcCoreSections !== undefined ? layer.pcCoreSections : base.pcCoreSections;
  const rawNpcSections =
    layer.npcCoreSections !== undefined ? layer.npcCoreSections : base.npcCoreSections;
  const mergedPcSections = applySectionConfirmPolicies(
    rawPcSections,
    layer.sectionConfirmPolicies?.pc
  );
  const mergedNpcSections = applySectionConfirmPolicies(
    rawNpcSections,
    layer.sectionConfirmPolicies?.npc
  );

  const mergedBasePrompts = cloneStringRecord(base.basePrompts);
  if (layer.basePrompts !== undefined) {
    for (const [k, v] of Object.entries(layer.basePrompts)) {
      if (isSafeRecordKey(k) && typeof v === 'string') {
        mergedBasePrompts[k] = v;
      }
    }
  }

  const mergedUnlocked = cloneBooleanRecord(base.unlockedPromptSections);
  if (layer.unlockedPromptSections !== undefined) {
    for (const [k, v] of Object.entries(layer.unlockedPromptSections)) {
      if (isSafeRecordKey(k) && typeof v === 'boolean') {
        mergedUnlocked[k] = v;
      }
    }
  }

  const mergedCustomPromptBlocks = mergeCustomPromptBlocks(
    base.customPromptBlocks,
    layer.customPromptBlocks
  );
  const mergedGeneration = mergeGenerationPresetConfig(base.generation, layer.generation);
  const mergedTokenBudgets = mergeTokenBudgets(base.tokenBudgets, layer.tokenBudgets);

  return {
    packId: base.packId,
    packName: base.packName,
    capabilities: mergeCapabilities(base.capabilities, layer.capabilities),
    pcCoreSections: mergedPcSections,
    npcCoreSections: mergedNpcSections,
    gameSystems: mergedGameSystems,
    blockOrder: layer.blockOrder !== undefined ? [...layer.blockOrder] : [...base.blockOrder],
    syspromptSectionOrder:
      layer.syspromptSectionOrder !== undefined
        ? [...layer.syspromptSectionOrder]
        : [...base.syspromptSectionOrder],
    basePrompts: mergedBasePrompts,
    unlockedPromptSections: mergedUnlocked,
    ...(mergedCustomPromptBlocks !== undefined
      ? { customPromptBlocks: mergedCustomPromptBlocks }
      : {}),
    combatRules: mergeCombatRules(base.combatRules, layer.combatRules),
    tuningDials: mergeTuningDials(base.tuningDials, layer.tuningDials),
    ...(mergedGeneration !== undefined ? { generation: mergedGeneration } : {}),
    ...(mergedTokenBudgets !== undefined ? { tokenBudgets: mergedTokenBudgets } : {}),
  };
}

/**
 * Resolve effective Control Room configuration with strict 3-layer precedence:
 * Stock Defaults -> Active SystemPack / Cartridge Overrides -> User Session/Global Overrides.
 */
export function resolveEffectiveControlRoomConfig(
  stockPack: SystemPack,
  cartridgeLayer?: Readonly<ControlRoomLayer>,
  userLayer?: Readonly<ControlRoomLayer>
): ResolvedControlRoomConfig {
  const stockBaseline = createStockBaselineConfig(stockPack);
  const afterCartridge = applyControlRoomLayer(stockBaseline, cartridgeLayer);
  return applyControlRoomLayer(afterCartridge, userLayer);
}

/**
 * Pure helper: enable/disable (or toggle) a GameSystemModule on a {@link ControlRoomLayer}.
 * When `layer.gameSystems` already contains `moduleId`, updates that entry directly.
 * Otherwise records a non-destructive override in `layer.gameSystemOverrides`.
 */
export function toggleGameSystemModule(
  layer: Readonly<ControlRoomLayer>,
  moduleId: string,
  enabled?: boolean,
  baseline?: Readonly<Pick<EffectiveSystemConfig, 'gameSystems'>>
): ControlRoomLayer {
  const next = cloneControlRoomLayer(layer);
  if (!isSafeRecordKey(moduleId) || moduleId.trim().length === 0) {
    return next;
  }

  if (next.gameSystems !== undefined) {
    const idx = next.gameSystems.findIndex((mod) => mod.id === moduleId);
    if (idx !== -1) {
      const existing = next.gameSystems[idx];
      if (existing !== undefined) {
        const nextEnabled = enabled !== undefined ? enabled : !existing.enabled;
        next.gameSystems[idx] = {
          ...existing,
          enabled: nextEnabled,
        };
        if (next.gameSystemOverrides?.[moduleId] !== undefined) {
          next.gameSystemOverrides[moduleId] = {
            ...next.gameSystemOverrides[moduleId],
            enabled: nextEnabled,
          };
        }
        return next;
      }
    }
  }

  const overrides = next.gameSystemOverrides ?? {};
  const currentOverride = overrides[moduleId] ?? {};
  const baselineMod = baseline?.gameSystems.find((mod) => mod.id === moduleId);
  const currentEnabled = currentOverride.enabled ?? baselineMod?.enabled ?? true;
  const nextEnabled = enabled !== undefined ? enabled : !currentEnabled;

  next.gameSystemOverrides = {
    ...overrides,
    [moduleId]: {
      ...currentOverride,
      enabled: nextEnabled,
    },
  };
  return next;
}

const BOOLEAN_CAPABILITY_KEYS: ReadonlySet<keyof SystemCapabilities> = new Set([
  'factions',
  'beats',
  'relationships',
  'chronicle',
]);

/**
 * Pure helper: set or toggle a capability flag/mode on a {@link ControlRoomLayer}.
 */
export function toggleCapability<K extends keyof SystemCapabilities>(
  layer: Readonly<ControlRoomLayer>,
  capabilityKey: K,
  value?: SystemCapabilities[K],
  baseline?: Readonly<SystemCapabilities>
): ControlRoomLayer {
  const next = cloneControlRoomLayer(layer);
  const currentCaps = next.capabilities ?? {};

  let resolvedValue: SystemCapabilities[K] | undefined = value;
  if (resolvedValue === undefined) {
    const existing = currentCaps[capabilityKey];
    if (typeof existing === 'boolean') {
      resolvedValue = !existing as SystemCapabilities[K];
    } else if (baseline !== undefined && typeof baseline[capabilityKey] === 'boolean') {
      resolvedValue = !(baseline[capabilityKey] as boolean) as SystemCapabilities[K];
    } else if (BOOLEAN_CAPABILITY_KEYS.has(capabilityKey)) {
      resolvedValue = true as SystemCapabilities[K];
    } else {
      return next;
    }
  }

  next.capabilities = {
    ...currentCaps,
    [capabilityKey]: resolvedValue,
  };
  return next;
}

/**
 * Pure helper: insert or update a typed {@link DynamicFieldSpec} in a GameSystemModule.
 * If `layer.gameSystems` is populated, updates or appends the module directly;
 * if `layer` is sparse (`layer.gameSystems` undefined), records the upsert in `gameSystemOverrides`
 * so baseline modules from Stock/Cartridge layers remain intact.
 */
export function upsertCustomField(
  layer: Readonly<ControlRoomLayer>,
  systemModuleId: string,
  fieldKey: string,
  fieldDef: DynamicFieldSpec
): ControlRoomLayer {
  const next = cloneControlRoomLayer(layer);
  if (
    !isSafeRecordKey(systemModuleId) ||
    systemModuleId.trim().length === 0 ||
    !isSafeRecordKey(fieldKey) ||
    fieldKey.trim().length === 0
  ) {
    return next;
  }

  const clonedSpec = cloneDynamicFieldSpec(fieldDef);

  if (next.gameSystems !== undefined) {
    const idx = next.gameSystems.findIndex((mod) => mod.id === systemModuleId);
    if (idx !== -1) {
      const existing = next.gameSystems[idx];
      if (existing !== undefined) {
        next.gameSystems[idx] = {
          ...existing,
          fields: {
            ...existing.fields,
            [fieldKey]: clonedSpec,
          },
        };
      }
    } else {
      next.gameSystems.push({
        id: systemModuleId,
        name: systemModuleId,
        enabled: true,
        scope: 'session',
        target: 'global',
        effectOwner: 'tracker',
        cadence: 'every_turn',
        fields: {
          [fieldKey]: clonedSpec,
        },
        trackerInstruction: '',
        narratorRule: '',
        ui: { widget: 'card', order: next.gameSystems.length + 1 },
      });
    }
    return next;
  }

  const overrides = next.gameSystemOverrides ?? {};
  const existingOverride = overrides[systemModuleId] ?? {};
  const nextFields: Record<string, DynamicFieldSpec> = {
    ...(existingOverride.fields ?? {}),
    [fieldKey]: clonedSpec,
  };
  const nextPolicies = existingOverride.fieldConfirmPolicies
    ? { ...existingOverride.fieldConfirmPolicies }
    : undefined;
  if (nextPolicies !== undefined) {
    if (clonedSpec.confirmPolicy !== undefined) {
      nextPolicies[fieldKey] = clonedSpec.confirmPolicy;
    } else {
      delete nextPolicies[fieldKey];
    }
  }

  next.gameSystemOverrides = {
    ...overrides,
    [systemModuleId]: {
      ...existingOverride,
      createIfMissing: true,
      fields: nextFields,
      ...(nextPolicies !== undefined ? { fieldConfirmPolicies: nextPolicies } : {}),
    },
  };
  return next;
}

/**
 * Pure helper: set the {@link ConfirmPolicy} for a specific module field (or character section
 * when `systemModuleId` is `'pc_core_sections'` or `'npc_core_sections'`).
 */
export function setFieldConfirmPolicy(
  layer: Readonly<ControlRoomLayer>,
  systemModuleId: string,
  fieldKey: string,
  confirmPolicy: ConfirmPolicy
): ControlRoomLayer {
  const next = cloneControlRoomLayer(layer);
  if (
    !isSafeRecordKey(systemModuleId) ||
    systemModuleId.trim().length === 0 ||
    !isSafeRecordKey(fieldKey) ||
    fieldKey.trim().length === 0
  ) {
    return next;
  }

  if (systemModuleId === 'pc_core_sections') {
    if (next.pcCoreSections !== undefined) {
      next.pcCoreSections = next.pcCoreSections.map((sec) =>
        sec.id === fieldKey ? { ...sec, confirmPolicy } : sec
      );
      return next;
    }
    next.sectionConfirmPolicies = {
      ...(next.sectionConfirmPolicies ?? {}),
      pc: {
        ...(next.sectionConfirmPolicies?.pc ?? {}),
        [fieldKey]: confirmPolicy,
      },
    };
    return next;
  }

  if (systemModuleId === 'npc_core_sections') {
    if (next.npcCoreSections !== undefined) {
      next.npcCoreSections = next.npcCoreSections.map((sec) =>
        sec.id === fieldKey ? { ...sec, confirmPolicy } : sec
      );
      return next;
    }
    next.sectionConfirmPolicies = {
      ...(next.sectionConfirmPolicies ?? {}),
      npc: {
        ...(next.sectionConfirmPolicies?.npc ?? {}),
        [fieldKey]: confirmPolicy,
      },
    };
    return next;
  }

  if (next.gameSystems !== undefined) {
    const idx = next.gameSystems.findIndex((mod) => mod.id === systemModuleId);
    if (idx !== -1) {
      const existingMod = next.gameSystems[idx];
      if (existingMod !== undefined && Object.hasOwn(existingMod.fields, fieldKey)) {
        const existingField = existingMod.fields[fieldKey];
        if (existingField !== undefined) {
          next.gameSystems[idx] = {
            ...existingMod,
            fields: {
              ...existingMod.fields,
              [fieldKey]: {
                ...cloneDynamicFieldSpec(existingField),
                confirmPolicy,
              },
            },
          };
          return next;
        }
      }
    }
  }

  const overrides = next.gameSystemOverrides ?? {};
  const existingOverride = overrides[systemModuleId] ?? {};
  const nextPolicies: Record<string, ConfirmPolicy> = {
    ...(existingOverride.fieldConfirmPolicies ?? {}),
    [fieldKey]: confirmPolicy,
  };
  const nextFields = existingOverride.fields ? { ...existingOverride.fields } : undefined;
  if (nextFields !== undefined && Object.hasOwn(nextFields, fieldKey)) {
    const existingField = nextFields[fieldKey];
    if (existingField !== undefined) {
      nextFields[fieldKey] = {
        ...cloneDynamicFieldSpec(existingField),
        confirmPolicy,
      };
    }
  }

  next.gameSystemOverrides = {
    ...overrides,
    [systemModuleId]: {
      ...existingOverride,
      ...(nextFields !== undefined ? { fields: nextFields } : {}),
      fieldConfirmPolicies: nextPolicies,
    },
  };
  return next;
}

/**
 * Pure helper: set a prompt section override and mark it unlocked on a {@link ControlRoomLayer}.
 */
export function setSectionOverride(
  layer: Readonly<ControlRoomLayer>,
  sectionId: string,
  text: string
): ControlRoomLayer {
  const next = cloneControlRoomLayer(layer);
  if (!isSafeRecordKey(sectionId) || sectionId.trim().length === 0) {
    return next;
  }

  next.basePrompts = {
    ...(next.basePrompts ?? {}),
    [sectionId]: text,
  };
  next.unlockedPromptSections = {
    ...(next.unlockedPromptSections ?? {}),
    [sectionId]: true,
  };
  return next;
}

/**
 * Pure helper: remove a prompt section override and unlock flag from a {@link ControlRoomLayer}
 * so the section falls back to the Cartridge or Stock baseline.
 */
export function resetSectionToBaseline(
  layer: Readonly<ControlRoomLayer>,
  sectionId: string
): ControlRoomLayer {
  const next = cloneControlRoomLayer(layer);
  if (!isSafeRecordKey(sectionId)) {
    return next;
  }

  if (next.basePrompts !== undefined) {
    delete next.basePrompts[sectionId];
  }
  if (next.unlockedPromptSections !== undefined) {
    delete next.unlockedPromptSections[sectionId];
  }
  return next;
}

/**
 * Pure helper: merge a partial {@link GenerationPresetConfig} into `layer.generation`.
 */
export function setGenerationPreset(
  layer: Readonly<ControlRoomLayer>,
  patch: Readonly<GenerationPresetConfig>
): ControlRoomLayer {
  const next = cloneControlRoomLayer(layer);
  next.generation = mergeGenerationPresetConfig(next.generation, patch);
  return next;
}

function insertSectionIdBeforeAnchor(order: string[], sectionId: string): string[] {
  if (order.includes(sectionId)) {
    return order;
  }
  const nextOrder = [...order];
  const transcriptIdx = nextOrder.indexOf('transcript_window');
  if (transcriptIdx !== -1) {
    nextOrder.splice(transcriptIdx, 0, sectionId);
    return nextOrder;
  }
  const latestInputIdx = nextOrder.indexOf('latest_input');
  if (latestInputIdx !== -1) {
    nextOrder.splice(latestInputIdx, 0, sectionId);
    return nextOrder;
  }
  nextOrder.push(sectionId);
  return nextOrder;
}

/**
 * Pure helper: insert or update a custom prompt block definition, its text content,
 * and its enabled/unlocked state on a {@link ControlRoomLayer}.
 */
export function upsertCustomPromptBlock(
  layer: Readonly<ControlRoomLayer>,
  spec: Readonly<CustomPromptBlockSpec>,
  content: string,
  enabled = true,
  baseline?: Readonly<Pick<EffectiveSystemConfig, 'syspromptSectionOrder'>>
): ControlRoomLayer {
  const next = cloneControlRoomLayer(layer);
  if (
    typeof spec.id !== 'string' ||
    !isSafeRecordKey(spec.id) ||
    spec.id.trim().length === 0
  ) {
    return next;
  }

  const nextBlocks = next.customPromptBlocks ?? {};
  setSafeRecordEntry(nextBlocks, spec.id, cloneCustomPromptBlockSpec(spec));
  next.customPromptBlocks = nextBlocks;

  const nextBasePrompts = next.basePrompts ?? {};
  setSafeRecordEntry(nextBasePrompts, spec.id, content);
  next.basePrompts = nextBasePrompts;

  const nextUnlocked = next.unlockedPromptSections ?? {};
  setSafeRecordEntry(nextUnlocked, spec.id, Boolean(enabled));
  next.unlockedPromptSections = nextUnlocked;

  if (next.syspromptSectionOrder === undefined && baseline?.syspromptSectionOrder !== undefined) {
    next.syspromptSectionOrder = [...baseline.syspromptSectionOrder];
  }
  if (next.syspromptSectionOrder !== undefined) {
    next.syspromptSectionOrder = insertSectionIdBeforeAnchor(next.syspromptSectionOrder, spec.id);
  }

  return next;
}

/**
 * Pure helper: remove a custom prompt block and its associated prompt text / unlock flag
 * (and section order entry if present) from a {@link ControlRoomLayer}.
 */
export function removeCustomPromptBlock(
  layer: Readonly<ControlRoomLayer>,
  id: string
): ControlRoomLayer {
  const next = cloneControlRoomLayer(layer);
  if (typeof id !== 'string' || !isSafeRecordKey(id) || id.trim().length === 0) {
    return next;
  }

  if (next.customPromptBlocks !== undefined) {
    delete next.customPromptBlocks[id];
  }
  if (next.basePrompts !== undefined) {
    delete next.basePrompts[id];
  }
  if (next.unlockedPromptSections !== undefined) {
    delete next.unlockedPromptSections[id];
  }
  if (next.syspromptSectionOrder !== undefined) {
    next.syspromptSectionOrder = next.syspromptSectionOrder.filter((entry) => entry !== id);
  }
  return next;
}

/**
 * Pure helper: apply one of the built-in {@link SHEET_PRESETS} to `pcCoreSections`,
 * `npcCoreSections`, or both on a {@link ControlRoomLayer}.
 */
export function applySheetPreset(
  layer: Readonly<ControlRoomLayer>,
  presetId: SheetPresetId | string,
  target: 'pc' | 'npc' | 'both' = 'both'
): ControlRoomLayer {
  const next = cloneControlRoomLayer(layer);
  if (typeof presetId !== 'string' || !isSafeRecordKey(presetId) || !Object.hasOwn(SHEET_PRESETS, presetId)) {
    return next;
  }

  const preset = SHEET_PRESETS[presetId as SheetPresetId];
  if (preset === undefined) {
    return next;
  }

  if (target === 'pc' || target === 'both') {
    next.pcCoreSections = cloneCharacterSections(preset.pcCoreSections);
  }
  if (target === 'npc' || target === 'both') {
    next.npcCoreSections = cloneCharacterSections(preset.npcCoreSections);
  }
  return next;
}
