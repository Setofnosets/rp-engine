import {
  type CharacterSectionDef,
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
  | 'tuningDials';

export const ALL_PAYLOAD_GROUP_IDS: readonly PayloadGroupId[] = Object.freeze([
  'capabilities',
  'characterSections',
  'gameSystems',
  'promptSections',
  'combatRules',
  'tuningDials',
]);

export interface TuningDials {
  beatPressure: BeatPressure;
  narrativePacing: NarrativePacing;
  cyoaEnabled: boolean;
  use24hTime: boolean;
  useDdMmYyFormat: boolean;
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
  combatRules?: Partial<CombatRulesConfig>;
  tuningDials?: Partial<TuningDials>;
}

export interface ResolvedControlRoomConfig extends EffectiveSystemConfig {
  packId: string;
  packName: string;
  basePrompts: Record<string, string>;
  unlockedPromptSections: Record<string, boolean>;
  combatRules: CombatRulesConfig;
  tuningDials: TuningDials;
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
  return cloned;
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
  if (layer.combatRules !== undefined) {
    cloned.combatRules = cloneCombatRulesPartial(layer.combatRules);
  }
  if (layer.tuningDials !== undefined) {
    cloned.tuningDials = cloneTuningDialsPartial(layer.tuningDials);
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
    combatRules: cloneCombatRules(config.combatRules),
    tuningDials: { ...config.tuningDials },
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
    combatRules: mergeCombatRules(base.combatRules, layer.combatRules),
    tuningDials: mergeTuningDials(base.tuningDials, layer.tuningDials),
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
