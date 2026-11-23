import { describe, expect, it } from 'vitest';
import {
  ALL_PAYLOAD_GROUP_IDS,
  type ControlRoomLayer,
  DEFAULT_COMBAT_RULES,
  DEFAULT_TUNING_DIALS,
  createEmptyControlRoomLayer,
  createStockBaselineConfig,
  resetSectionToBaseline,
  resolveEffectiveControlRoomConfig,
  setFieldConfirmPolicy,
  setSectionOverride,
  toggleCapability,
  toggleGameSystemModule,
  upsertCustomField,
} from '../../src/config/control-room-config.js';
import {
  PAYLOAD_GROUP_DEFINITIONS,
  type PayloadBundle,
  applySelectivePayloadGroups,
  createPayloadBundleFromSystemPack,
  getPayloadBundleGroupDiffs,
  isPayloadGroupModified,
} from '../../src/config/selective-loader.js';
import { isOk } from '../../src/core/result.js';
import {
  type CharacterSectionDef,
  OPTIONAL_CYBERWARE_SECTION,
  OPTIONAL_DESIRES_SECTION,
  cloneCharacterSection,
} from '../../src/schema/character-sections.js';
import {
  compileActiveTrackerSchema,
  validateEffectiveSystemConfig,
} from '../../src/schema/dynamic-schema-compiler.js';
import {
  STOCK_FREEFORM_PACK,
  STOCK_LIVING_WORLD_PACK,
  STOCK_SLICE_OF_LIFE_PACK,
  STOCK_TACTICAL_RPG_PACK,
  getStockSystemPack,
} from '../../src/schema/stock-system-packs.js';
import type { DynamicFieldSpec, SystemPack } from '../../src/schema/tracker-module.js';

describe('3-Layer Control Room Config', () => {
  it('resolves baseline config from stock packs with default dials and combat rules', () => {
    const resolved = resolveEffectiveControlRoomConfig(STOCK_SLICE_OF_LIFE_PACK);

    expect(resolved.packId).toBe('stock-slice-of-life');
    expect(resolved.packName).toBe(STOCK_SLICE_OF_LIFE_PACK.name);
    expect(resolved.capabilities).toEqual(STOCK_SLICE_OF_LIFE_PACK.capabilities);
    expect(resolved.pcCoreSections).toEqual(STOCK_SLICE_OF_LIFE_PACK.pcCoreSections);
    expect(resolved.npcCoreSections).toEqual(STOCK_SLICE_OF_LIFE_PACK.npcCoreSections);
    expect(resolved.gameSystems).toEqual(STOCK_SLICE_OF_LIFE_PACK.gameSystems);
    expect(resolved.blockOrder).toEqual(STOCK_SLICE_OF_LIFE_PACK.blockOrder);
    expect(resolved.syspromptSectionOrder).toEqual(STOCK_SLICE_OF_LIFE_PACK.syspromptSectionOrder);
    expect(resolved.basePrompts).toEqual({});
    expect(resolved.unlockedPromptSections).toEqual({});
    expect(resolved.tuningDials).toEqual(DEFAULT_TUNING_DIALS);
    expect(resolved.combatRules).toEqual(DEFAULT_COMBAT_RULES);

    expect(isOk(validateEffectiveSystemConfig(resolved))).toBe(true);
    const compiled = compileActiveTrackerSchema(resolved, {
      turn: 1,
      clockAdvancedThisTurn: false,
      combatEndedThisTurn: false,
    });
    expect(compiled.trackerJsonSchema).not.toBeNull();
  });

  it('enforces 3-layer precedence: Stock -> Cartridge -> User without clobbering undefined keys', () => {
    const stockPack: SystemPack = {
      ...getStockSystemPack('stock-slice-of-life')!,
      basePrompts: {
        system: 'Stock System Prompt',
        persona: 'Stock Persona Prompt',
        state: 'Stock State Prompt',
      },
    };

    const cartridgeLayer: ControlRoomLayer = {
      capabilities: {
        combatMode: 'traditional',
        beats: true,
        factions: undefined, // should NOT overwrite stockPack.capabilities.factions
      },
      basePrompts: {
        system: 'Cartridge System Prompt',
        persona: 'Cartridge Persona Prompt',
      },
      unlockedPromptSections: {
        system: true,
      },
      combatRules: {
        diceMode: 'd100',
        customRules: { crits: 'Double dice on 01-05' },
      },
      tuningDials: {
        beatPressure: 'generous',
        cyoaEnabled: true,
      },
    };

    const userLayer: ControlRoomLayer = {
      capabilities: {
        beats: false, // user overrides cartridge
      },
      basePrompts: {
        persona: 'User Persona Prompt', // user overrides cartridge
      },
      combatRules: {
        fallbackTacticsEnabled: false, // user overrides stock default while preserving cartridge diceMode
        customRules: { cover: 'Half cover gives +2 AC' },
      },
      tuningDials: {
        beatPressure: 'harsh', // user overrides cartridge
        use24hTime: true,
      },
    };

    const resolved = resolveEffectiveControlRoomConfig(stockPack, cartridgeLayer, userLayer);

    // Capabilities: Stock (scene_only, false factions) -> Cartridge (traditional) -> User (beats: false)
    expect(resolved.capabilities).toEqual({
      spatialMode: 'scene_only',
      combatMode: 'traditional',
      progression: 'disabled',
      clocks: 'calendar_only',
      factions: false,
      beats: false,
      relationships: true,
      chronicle: true,
    });

    // Prompts: state from Stock, system from Cartridge, persona from User
    expect(resolved.basePrompts).toEqual({
      system: 'Cartridge System Prompt',
      persona: 'User Persona Prompt',
      state: 'Stock State Prompt',
    });
    expect(resolved.unlockedPromptSections).toEqual({
      system: true,
    });

    // Combat rules: Cartridge diceMode preserved, User fallbackTacticsEnabled applied, customRules merged
    expect(resolved.combatRules).toEqual({
      diceEnabled: true,
      diceMode: 'd100',
      allowPartialActionSalvage: true,
      fallbackTacticsEnabled: false,
      customRules: {
        crits: 'Double dice on 01-05',
        cover: 'Half cover gives +2 AC',
      },
      skillOverrides: {},
    });

    // Tuning dials: Cartridge cyoaEnabled preserved, User beatPressure + use24hTime applied, rest Stock default
    expect(resolved.tuningDials).toEqual({
      beatPressure: 'harsh',
      narrativePacing: 'balanced',
      cyoaEnabled: true,
      use24hTime: true,
      useDdMmYyFormat: false,
    });
  });

  it('prevents mutation leaks across stock packs, layers, and resolved configs', () => {
    const cartridgeLayer: ControlRoomLayer = {
      capabilities: { beats: true },
      pcCoreSections: [cloneCharacterSection(OPTIONAL_DESIRES_SECTION)],
      basePrompts: { system: 'Cartridge' },
      combatRules: {
        skillOverrides: { fireball: { apCost: 2 } },
      },
    };
    const userLayer: ControlRoomLayer = {
      tuningDials: { cyoaEnabled: true },
    };

    const resolved = resolveEffectiveControlRoomConfig(
      STOCK_FREEFORM_PACK,
      cartridgeLayer,
      userLayer
    );

    // Mutate resolved output aggressively
    resolved.capabilities.factions = true;
    resolved.pcCoreSections.push(cloneCharacterSection(OPTIONAL_CYBERWARE_SECTION));
    resolved.gameSystems[0]!.enabled = false;
    resolved.blockOrder.push('EXTRA');
    resolved.basePrompts['system'] = 'Mutated';
    resolved.combatRules.skillOverrides['fireball']!['apCost'] = 999;

    // Inputs and stock pack must be untouched
    expect(STOCK_FREEFORM_PACK.capabilities.factions).toBe(false);
    expect(STOCK_FREEFORM_PACK.gameSystems[0]?.enabled).toBe(true);
    expect(cartridgeLayer.pcCoreSections?.length).toBe(1);
    expect(cartridgeLayer.basePrompts?.['system']).toBe('Cartridge');
    expect(cartridgeLayer.combatRules?.skillOverrides?.['fireball']?.['apCost']).toBe(2);

    // Re-resolving yields clean values
    const resolvedAgain = resolveEffectiveControlRoomConfig(
      STOCK_FREEFORM_PACK,
      cartridgeLayer,
      userLayer
    );
    expect(resolvedAgain.capabilities.factions).toBe(false);
    expect(resolvedAgain.pcCoreSections.length).toBe(1);
    expect(resolvedAgain.basePrompts['system']).toBe('Cartridge');
    expect(resolvedAgain.combatRules.skillOverrides['fireball']?.['apCost']).toBe(2);
  });

  it('pure helpers toggleGameSystemModule, toggleCapability, upsertCustomField, setFieldConfirmPolicy work on sparse and populated layers', () => {
    // 1) Sparse layer workflow
    const empty = createEmptyControlRoomLayer();
    const withToggle = toggleGameSystemModule(
      empty,
      'relationship_affinity',
      false,
      STOCK_SLICE_OF_LIFE_PACK
    );
    expect(empty).toEqual({});

    const withFlippedCap = toggleCapability(
      withToggle,
      'factions',
      undefined,
      STOCK_SLICE_OF_LIFE_PACK.capabilities
    );
    const withModeCap = toggleCapability(withFlippedCap, 'spatialMode', 'emergent');

    const hungerSpec: DynamicFieldSpec = {
      type: 'meter',
      min: 0,
      max: 100,
      default: 80,
      writableByTracker: true,
      confirmPolicy: 'auto',
      description: 'Character hunger level',
    };
    const weatherSpec: DynamicFieldSpec = {
      type: 'string',
      maxLength: 50,
      default: 'clear',
      writableByTracker: true,
    };

    // Add field to brand-new module AND to existing stock module
    const withCustomMod = upsertCustomField(withModeCap, 'survival', 'hunger', hungerSpec);
    const withExistingModField = upsertCustomField(
      withCustomMod,
      'scene_context',
      'weather',
      weatherSpec
    );

    const withPolicy = setFieldConfirmPolicy(
      withExistingModField,
      'survival',
      'hunger',
      'always_confirm'
    );
    const withStockPolicy = setFieldConfirmPolicy(
      withPolicy,
      'scene_context',
      'mood',
      'locked'
    );
    const withSectionPolicy = setFieldConfirmPolicy(
      withStockPolicy,
      'pc_core_sections',
      'sec_equipment',
      'always_confirm'
    );

    const resolved = resolveEffectiveControlRoomConfig(
      STOCK_SLICE_OF_LIFE_PACK,
      undefined,
      withSectionPolicy
    );

    expect(resolved.capabilities.factions).toBe(true);
    expect(resolved.capabilities.spatialMode).toBe('emergent');
    expect(
      resolved.pcCoreSections.find((s) => s.id === 'sec_equipment')?.confirmPolicy
    ).toBe('always_confirm');

    // Upserting a field without confirmPolicy clears prior fieldConfirmPolicies override on that field
    const clearedPolicy = upsertCustomField(withStockPolicy, 'survival', 'hunger', {
      type: 'meter',
      min: 0,
      max: 100,
      default: 60,
      writableByTracker: true,
    });
    const resolvedCleared = resolveEffectiveControlRoomConfig(
      STOCK_SLICE_OF_LIFE_PACK,
      undefined,
      clearedPolicy
    );
    expect(
      resolvedCleared.gameSystems.find((m) => m.id === 'survival')?.fields['hunger']?.confirmPolicy
    ).toBeUndefined();

    const relMod = resolved.gameSystems.find((m) => m.id === 'relationship_affinity');
    expect(relMod?.enabled).toBe(false);

    const sceneMod = resolved.gameSystems.find((m) => m.id === 'scene_context');
    expect(sceneMod?.fields['location']).toBeDefined();
    expect(sceneMod?.fields['weather']).toEqual(weatherSpec);
    expect(sceneMod?.fields['mood']?.confirmPolicy).toBe('locked');

    const survivalMod = resolved.gameSystems.find((m) => m.id === 'survival');
    expect(survivalMod).toBeDefined();
    expect(survivalMod?.fields['hunger']).toEqual({
      ...hungerSpec,
      confirmPolicy: 'always_confirm',
    });

    // Compiled schema should validate and include new fields while locking mood
    expect(isOk(validateEffectiveSystemConfig(resolved))).toBe(true);
    const compiled = compileActiveTrackerSchema(resolved, {
      turn: 1,
      clockAdvancedThisTurn: false,
      combatEndedThisTurn: false,
    });
    expect(compiled.fieldPolicyMap.get('scene.mood')?.writableByTracker).toBe(false);
    expect(compiled.fieldPolicyMap.get('custom_fields.hunger')?.confirmPolicy).toBe(
      'always_confirm'
    );

    // 2) Populated layer workflow
    const populated: ControlRoomLayer = {
      gameSystems: STOCK_TACTICAL_RPG_PACK.gameSystems.map((m) => ({
        ...m,
        fields: { ...m.fields },
        ui: { ...m.ui },
      })),
      pcCoreSections: STOCK_TACTICAL_RPG_PACK.pcCoreSections.map(cloneCharacterSection),
    };
    const pop1 = toggleGameSystemModule(populated, 'tactical_combat');
    expect(pop1.gameSystems?.find((m) => m.id === 'tactical_combat')?.enabled).toBe(false);
    expect(populated.gameSystems?.find((m) => m.id === 'tactical_combat')?.enabled).toBe(true);

    const pop2 = upsertCustomField(pop1, 'arcane_mana', 'mana', {
      type: 'meter',
      min: 0,
      max: 50,
      default: 50,
      writableByTracker: false,
      confirmPolicy: 'locked',
    });
    expect(pop2.gameSystems?.find((m) => m.id === 'arcane_mana')?.fields['mana']).toBeDefined();

    const pop3 = setFieldConfirmPolicy(pop2, 'pc_core_sections', 'sec_equipment', 'locked');
    expect(
      pop3.pcCoreSections?.find((s) => s.id === 'sec_equipment')?.confirmPolicy
    ).toBe('locked');
  });

  it('pure helpers setSectionOverride and resetSectionToBaseline preserve immutability and restore fallback', () => {
    const stockPack: SystemPack = {
      ...getStockSystemPack('stock-freeform')!,
      basePrompts: {
        system: 'Stock System',
      },
    };
    const cartridgeLayer: ControlRoomLayer = {
      basePrompts: {
        system: 'Cartridge System',
      },
    };

    const user0: ControlRoomLayer = {};
    const user1 = setSectionOverride(user0, 'system', 'User Custom System');
    expect(user0.basePrompts).toBeUndefined();
    expect(user1.basePrompts?.['system']).toBe('User Custom System');
    expect(user1.unlockedPromptSections?.['system']).toBe(true);

    const resolved1 = resolveEffectiveControlRoomConfig(stockPack, cartridgeLayer, user1);
    expect(resolved1.basePrompts['system']).toBe('User Custom System');

    const user2 = resetSectionToBaseline(user1, 'system');
    expect(user1.basePrompts?.['system']).toBe('User Custom System');
    expect(user2.basePrompts?.['system']).toBeUndefined();
    expect(user2.unlockedPromptSections?.['system']).toBeUndefined();

    // Falls back to Cartridge baseline when cartridgeLayer defines it, or Stock otherwise
    const resolvedWithCartridge = resolveEffectiveControlRoomConfig(
      stockPack,
      cartridgeLayer,
      user2
    );
    expect(resolvedWithCartridge.basePrompts['system']).toBe('Cartridge System');

    const resolvedWithoutCartridge = resolveEffectiveControlRoomConfig(stockPack, undefined, user2);
    expect(resolvedWithoutCartridge.basePrompts['system']).toBe('Stock System');
  });

  it('ignores unsafe prototype keys in helper mutations', () => {
    const pollutedAttempt = setSectionOverride({}, '__proto__', 'evil');
    expect(Object.hasOwn(pollutedAttempt.basePrompts ?? {}, '__proto__')).toBe(false);
    expect(({} as Record<string, unknown>)['__proto__']).toBe(Object.prototype);

    const fieldAttempt = upsertCustomField({}, 'constructor', 'x', {
      type: 'boolean',
      default: false,
      writableByTracker: true,
    });
    expect(fieldAttempt.gameSystemOverrides).toBeUndefined();
  });
});

describe('Selective Payload Loader', () => {
  it('defines metadata for all 6 PayloadGroupIds', () => {
    const ids = PAYLOAD_GROUP_DEFINITIONS.map((d) => d.id);
    expect(ids).toEqual([...ALL_PAYLOAD_GROUP_IDS]);
  });

  it('applies ONLY selected groups while keeping unselected user groups untouched', () => {
    const customPcSection: CharacterSectionDef = cloneCharacterSection(OPTIONAL_DESIRES_SECTION);
    const customNpcSection: CharacterSectionDef = cloneCharacterSection(OPTIONAL_CYBERWARE_SECTION);

    const currentLayer: ControlRoomLayer = {
      capabilities: { ...STOCK_SLICE_OF_LIFE_PACK.capabilities },
      pcCoreSections: [customPcSection],
      npcCoreSections: [customNpcSection],
      gameSystems: STOCK_SLICE_OF_LIFE_PACK.gameSystems.map((m) => ({
        ...m,
        fields: { ...m.fields },
        ui: { ...m.ui },
      })),
      blockOrder: ['SCENE', 'CHARACTER'],
      syspromptSectionOrder: ['system', 'persona', 'state'],
      basePrompts: {
        system: 'User Custom System Prompt',
      },
      unlockedPromptSections: {
        system: true,
      },
      combatRules: {
        diceEnabled: false,
        diceMode: 'd20',
      },
      tuningDials: {
        beatPressure: 'off',
        narrativePacing: 'slow_burn',
        cyoaEnabled: true,
        use24hTime: true,
        useDdMmYyFormat: true,
      },
    };

    const incomingTacticalBundle: PayloadBundle = {
      ...createPayloadBundleFromSystemPack(STOCK_TACTICAL_RPG_PACK),
      basePrompts: {
        system: 'Tactical Cartridge Prompt',
      },
      unlockedPromptSections: {
        system: false,
      },
      combatRules: {
        diceEnabled: true,
        diceMode: 'd100',
        allowPartialActionSalvage: true,
        fallbackTacticsEnabled: true,
        customRules: { flanking: '+2 advantage' },
      },
      tuningDials: {
        beatPressure: 'harsh',
        narrativePacing: 'fast_forward',
        cyoaEnabled: false,
        use24hTime: false,
        useDdMmYyFormat: false,
      },
    };

    // Selectively load ONLY capabilities + gameSystems (leaving characterSections, promptSections, combatRules, tuningDials untouched)
    const result = applySelectivePayloadGroups(currentLayer, incomingTacticalBundle, [
      'capabilities',
      'gameSystems',
    ]);

    // Selected groups replaced with incoming bundle
    expect(result.capabilities).toEqual(STOCK_TACTICAL_RPG_PACK.capabilities);
    expect(result.gameSystems?.some((m) => m.id === 'tactical_combat')).toBe(true);
    expect(result.blockOrder).toEqual(STOCK_TACTICAL_RPG_PACK.blockOrder);

    // Unselected groups preserved verbatim from user's currentLayer
    expect(result.pcCoreSections).toEqual([customPcSection]);
    expect(result.npcCoreSections).toEqual([customNpcSection]);
    expect(result.basePrompts).toEqual({ system: 'User Custom System Prompt' });
    expect(result.unlockedPromptSections).toEqual({ system: true });
    expect(result.syspromptSectionOrder).toEqual(['system', 'persona', 'state']);
    expect(result.combatRules).toEqual({ diceEnabled: false, diceMode: 'd20' });
    expect(result.tuningDials).toEqual(currentLayer.tuningDials);

    // Verify immutability: mutating result doesn't mutate currentLayer or incomingTacticalBundle
    result.pcCoreSections![0]!.name = 'Mutated';
    result.gameSystems![0]!.name = 'Mutated System';
    expect(currentLayer.pcCoreSections![0]!.name).toBe('Desires');
    expect(incomingTacticalBundle.gameSystems![0]!.name).toBe('Scene Context');
  });

  it('handles empty selection, duplicate group ids, and clearing selected optional fields when omitted in incoming bundle', () => {
    const currentLayer: ControlRoomLayer = {
      basePrompts: { system: 'Old Prompt' },
      unlockedPromptSections: { system: true },
      syspromptSectionOrder: ['system', 'state'],
      tuningDials: { beatPressure: 'harsh', cyoaEnabled: true },
    };

    // Empty selection -> identical deep clone
    const noopResult = applySelectivePayloadGroups(currentLayer, {}, []);
    expect(noopResult).toEqual(currentLayer);
    expect(noopResult).not.toBe(currentLayer);

    // Selecting promptSections + tuningDials from a bundle that omits overrides resets those groups
    const stockBundle = createPayloadBundleFromSystemPack(STOCK_LIVING_WORLD_PACK);
    const resetSelected = applySelectivePayloadGroups(currentLayer, stockBundle, [
      'promptSections',
      'promptSections',
      'tuningDials',
    ]);

    expect(resetSelected.basePrompts).toBeUndefined();
    expect(resetSelected.unlockedPromptSections).toBeUndefined();
    expect(resetSelected.syspromptSectionOrder).toEqual(STOCK_LIVING_WORLD_PACK.syspromptSectionOrder);
    expect(resetSelected.tuningDials).toBeUndefined();
  });

  it('detects modified vs stock payload groups accurately', () => {
    const freeformBaseline = createStockBaselineConfig(STOCK_FREEFORM_PACK);
    const freeformBundle = createPayloadBundleFromSystemPack(STOCK_FREEFORM_PACK);

    const freeformDiffs = getPayloadBundleGroupDiffs(freeformBundle, freeformBaseline);
    expect(freeformDiffs).toEqual({
      capabilities: false,
      characterSections: false,
      gameSystems: false,
      promptSections: false,
      combatRules: false,
      tuningDials: false,
    });

    const tacticalBundle = createPayloadBundleFromSystemPack(STOCK_TACTICAL_RPG_PACK, {
      tuningDials: { beatPressure: 'harsh' },
    });
    const tacticalDiffs = getPayloadBundleGroupDiffs(tacticalBundle, freeformBaseline);

    expect(tacticalDiffs.capabilities).toBe(true);
    expect(tacticalDiffs.characterSections).toBe(true);
    expect(tacticalDiffs.gameSystems).toBe(true);
    expect(tacticalDiffs.promptSections).toBe(true);
    expect(tacticalDiffs.combatRules).toBe(false);
    expect(tacticalDiffs.tuningDials).toBe(true);

    expect(isPayloadGroupModified('tuningDials', tacticalBundle, freeformBaseline)).toBe(true);
  });
});
