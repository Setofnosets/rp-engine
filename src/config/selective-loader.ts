import { cloneCharacterSections } from '../schema/character-sections.js';
import {
  cloneGameSystemModule,
  type SystemPack,
} from '../schema/tracker-module.js';
import {
  ALL_PAYLOAD_GROUP_IDS,
  type ControlRoomLayer,
  DEFAULT_COMBAT_RULES,
  DEFAULT_TUNING_DIALS,
  type PayloadGroupId,
  type ResolvedControlRoomConfig,
  cloneBooleanRecord,
  cloneCapabilitiesPartial,
  cloneCombatRulesPartial,
  cloneControlRoomLayer,
  cloneCustomPromptBlocks,
  cloneGameSystemOverrides,
  cloneGenerationPresetConfig,
  cloneStringRecord,
  cloneTokenBudgetsPartial,
  cloneTuningDialsPartial,
} from './control-room-config.js';
import { computeNormalizedFingerprint } from './prompt-diff.js';

export interface PayloadBundle extends ControlRoomLayer {
  spec?: string;
  id?: string;
  name?: string;
  description?: string;
  version?: number;
}

export interface PayloadGroupDefinition {
  readonly id: PayloadGroupId;
  readonly label: string;
  readonly description: string;
}

export const PAYLOAD_GROUP_DEFINITIONS: readonly PayloadGroupDefinition[] = Object.freeze([
  {
    id: 'capabilities',
    label: 'Capabilities',
    description: 'Spatial tier, combat mode, progression, clocks, factions, beats, relationships, chronicle',
  },
  {
    id: 'characterSections',
    label: 'Character Sections',
    description: 'PC and NPC modular character sheet section schemas',
  },
  {
    id: 'gameSystems',
    label: 'Game Systems & Custom Fields',
    description: 'Dynamic tracker modules, custom fields, module overrides, and block order',
  },
  {
    id: 'promptSections',
    label: 'Prompt Sections',
    description: 'Base prompt overrides, unlocked prompt flags, and system prompt section order',
  },
  {
    id: 'combatRules',
    label: 'Combat Rules',
    description: 'Dice settings, partial-action salvage, fallback tactics, and skill overrides',
  },
  {
    id: 'tuningDials',
    label: 'Tuning Dials',
    description: 'Beat pressure, narrative pacing, CYOA toggle, and date/time display formats',
  },
  {
    id: 'generation',
    label: 'Generation & Token Budgets',
    description: 'Sampling presets, SillyTavern format templates, and prompt section token budgets',
  },
]);

/**
 * Apply ONLY the selected {@link PayloadGroupId} groups from `incomingBundle` onto a deep clone
 * of `currentLayer`, leaving all unselected groups on `currentLayer` completely untouched.
 */
export function applySelectivePayloadGroups(
  currentLayer: Readonly<ControlRoomLayer>,
  incomingBundle: Readonly<PayloadBundle>,
  selectedGroups: readonly PayloadGroupId[]
): ControlRoomLayer {
  const next = cloneControlRoomLayer(currentLayer);
  if (selectedGroups.length === 0) {
    return next;
  }

  const selected = new Set<PayloadGroupId>(selectedGroups);

  if (selected.has('capabilities')) {
    if (incomingBundle.capabilities !== undefined) {
      next.capabilities = cloneCapabilitiesPartial(incomingBundle.capabilities);
    } else {
      delete next.capabilities;
    }
  }

  if (selected.has('characterSections')) {
    if (incomingBundle.pcCoreSections !== undefined) {
      next.pcCoreSections = cloneCharacterSections(incomingBundle.pcCoreSections);
    } else {
      delete next.pcCoreSections;
    }

    if (incomingBundle.npcCoreSections !== undefined) {
      next.npcCoreSections = cloneCharacterSections(incomingBundle.npcCoreSections);
    } else {
      delete next.npcCoreSections;
    }

    if (incomingBundle.sectionConfirmPolicies !== undefined) {
      next.sectionConfirmPolicies = {
        ...(incomingBundle.sectionConfirmPolicies.pc !== undefined
          ? { pc: { ...incomingBundle.sectionConfirmPolicies.pc } }
          : {}),
        ...(incomingBundle.sectionConfirmPolicies.npc !== undefined
          ? { npc: { ...incomingBundle.sectionConfirmPolicies.npc } }
          : {}),
      };
    } else {
      delete next.sectionConfirmPolicies;
    }
  }

  if (selected.has('gameSystems')) {
    if (incomingBundle.gameSystems !== undefined) {
      next.gameSystems = incomingBundle.gameSystems.map(cloneGameSystemModule);
    } else {
      delete next.gameSystems;
    }

    if (incomingBundle.gameSystemOverrides !== undefined) {
      next.gameSystemOverrides = cloneGameSystemOverrides(incomingBundle.gameSystemOverrides);
    } else {
      delete next.gameSystemOverrides;
    }

    if (incomingBundle.blockOrder !== undefined) {
      next.blockOrder = [...incomingBundle.blockOrder];
    } else {
      delete next.blockOrder;
    }
  }

  if (selected.has('promptSections')) {
    if (incomingBundle.basePrompts !== undefined) {
      next.basePrompts = cloneStringRecord(incomingBundle.basePrompts);
    } else {
      delete next.basePrompts;
    }

    if (incomingBundle.unlockedPromptSections !== undefined) {
      next.unlockedPromptSections = cloneBooleanRecord(incomingBundle.unlockedPromptSections);
    } else {
      delete next.unlockedPromptSections;
    }

    if (incomingBundle.syspromptSectionOrder !== undefined) {
      next.syspromptSectionOrder = [...incomingBundle.syspromptSectionOrder];
    } else {
      delete next.syspromptSectionOrder;
    }

    if (incomingBundle.customPromptBlocks !== undefined) {
      next.customPromptBlocks = cloneCustomPromptBlocks(incomingBundle.customPromptBlocks);
    } else {
      delete next.customPromptBlocks;
    }
  }

  if (selected.has('combatRules')) {
    if (incomingBundle.combatRules !== undefined) {
      next.combatRules = cloneCombatRulesPartial(incomingBundle.combatRules);
    } else {
      delete next.combatRules;
    }
  }

  if (selected.has('tuningDials')) {
    if (incomingBundle.tuningDials !== undefined) {
      next.tuningDials = cloneTuningDialsPartial(incomingBundle.tuningDials);
    } else {
      delete next.tuningDials;
    }
  }

  if (selected.has('generation')) {
    if (incomingBundle.generation !== undefined) {
      next.generation = cloneGenerationPresetConfig(incomingBundle.generation);
    } else {
      delete next.generation;
    }

    if (incomingBundle.tokenBudgets !== undefined) {
      next.tokenBudgets = cloneTokenBudgetsPartial(incomingBundle.tokenBudgets);
    } else {
      delete next.tokenBudgets;
    }
  }

  return next;
}

/**
 * Convert a {@link SystemPack} into a cloned {@link PayloadBundle}.
 */
export function createPayloadBundleFromSystemPack(
  pack: SystemPack,
  extras?: Readonly<
    Pick<
      PayloadBundle,
      | 'combatRules'
      | 'tuningDials'
      | 'unlockedPromptSections'
      | 'gameSystemOverrides'
      | 'customPromptBlocks'
      | 'generation'
      | 'tokenBudgets'
      | 'version'
    >
  >
): PayloadBundle {
  return {
    spec: pack.spec,
    id: pack.id,
    name: pack.name,
    description: pack.description,
    capabilities: cloneCapabilitiesPartial(pack.capabilities),
    pcCoreSections: cloneCharacterSections(pack.pcCoreSections),
    npcCoreSections: cloneCharacterSections(pack.npcCoreSections),
    gameSystems: pack.gameSystems.map(cloneGameSystemModule),
    blockOrder: [...pack.blockOrder],
    syspromptSectionOrder: [...pack.syspromptSectionOrder],
    ...(pack.basePrompts !== undefined
      ? { basePrompts: cloneStringRecord(pack.basePrompts) }
      : {}),
    ...(extras?.unlockedPromptSections !== undefined
      ? { unlockedPromptSections: cloneBooleanRecord(extras.unlockedPromptSections) }
      : {}),
    ...(extras?.gameSystemOverrides !== undefined
      ? { gameSystemOverrides: cloneGameSystemOverrides(extras.gameSystemOverrides) }
      : {}),
    ...(extras?.customPromptBlocks !== undefined
      ? { customPromptBlocks: cloneCustomPromptBlocks(extras.customPromptBlocks) }
      : {}),
    ...(extras?.combatRules !== undefined
      ? { combatRules: cloneCombatRulesPartial(extras.combatRules) }
      : {}),
    ...(extras?.tuningDials !== undefined
      ? { tuningDials: cloneTuningDialsPartial(extras.tuningDials) }
      : {}),
    ...(extras?.generation !== undefined
      ? { generation: cloneGenerationPresetConfig(extras.generation) }
      : {}),
    ...(extras?.tokenBudgets !== undefined
      ? { tokenBudgets: cloneTokenBudgetsPartial(extras.tokenBudgets) }
      : {}),
    ...(extras?.version !== undefined ? { version: extras.version } : {}),
  };
}

function isResolvedConfig(
  value: Readonly<ControlRoomLayer | ResolvedControlRoomConfig>
): value is Readonly<ResolvedControlRoomConfig> {
  return 'packId' in value && typeof value.packId === 'string';
}

function extractLayerGroupValue(
  layer: Readonly<ControlRoomLayer | ResolvedControlRoomConfig>,
  groupId: PayloadGroupId,
  resolvedBaseline?: Readonly<ResolvedControlRoomConfig>
): unknown {
  const isLayerResolved = isResolvedConfig(layer);
  switch (groupId) {
    case 'capabilities':
      if (resolvedBaseline !== undefined && !isLayerResolved) {
        return {
          ...resolvedBaseline.capabilities,
          ...(layer.capabilities ?? {}),
        };
      }
      return layer.capabilities;
    case 'characterSections':
      if (resolvedBaseline !== undefined && !isLayerResolved) {
        return {
          pcCoreSections: layer.pcCoreSections ?? resolvedBaseline.pcCoreSections,
          npcCoreSections: layer.npcCoreSections ?? resolvedBaseline.npcCoreSections,
        };
      }
      return {
        pcCoreSections: layer.pcCoreSections,
        npcCoreSections: layer.npcCoreSections,
      };
    case 'gameSystems': {
      const overrides =
        !isLayerResolved &&
        layer.gameSystemOverrides !== undefined &&
        Object.keys(layer.gameSystemOverrides).length > 0
          ? layer.gameSystemOverrides
          : undefined;
      if (resolvedBaseline !== undefined && !isLayerResolved) {
        return {
          gameSystems: layer.gameSystems ?? resolvedBaseline.gameSystems,
          blockOrder: layer.blockOrder ?? resolvedBaseline.blockOrder,
          ...(overrides !== undefined ? { gameSystemOverrides: overrides } : {}),
        };
      }
      return {
        gameSystems: layer.gameSystems,
        blockOrder: layer.blockOrder,
        ...(overrides !== undefined ? { gameSystemOverrides: overrides } : {}),
      };
    }
    case 'promptSections':
      if (resolvedBaseline !== undefined && !isLayerResolved) {
        return {
          basePrompts: layer.basePrompts ?? {},
          unlockedPromptSections: layer.unlockedPromptSections ?? {},
          syspromptSectionOrder:
            layer.syspromptSectionOrder ?? resolvedBaseline.syspromptSectionOrder,
          ...(layer.customPromptBlocks !== undefined
            ? { customPromptBlocks: layer.customPromptBlocks }
            : {}),
        };
      }
      return {
        basePrompts: layer.basePrompts,
        unlockedPromptSections: layer.unlockedPromptSections,
        syspromptSectionOrder: layer.syspromptSectionOrder,
        ...(layer.customPromptBlocks !== undefined
          ? { customPromptBlocks: layer.customPromptBlocks }
          : {}),
      };
    case 'combatRules':
      if (resolvedBaseline !== undefined) {
        return {
          ...DEFAULT_COMBAT_RULES,
          ...(layer.combatRules ?? {}),
          customRules: {
            ...DEFAULT_COMBAT_RULES.customRules,
            ...(layer.combatRules?.customRules ?? {}),
          },
          skillOverrides: {
            ...DEFAULT_COMBAT_RULES.skillOverrides,
            ...(layer.combatRules?.skillOverrides ?? {}),
          },
        };
      }
      return layer.combatRules;
    case 'tuningDials':
      if (resolvedBaseline !== undefined) {
        return {
          ...DEFAULT_TUNING_DIALS,
          ...(layer.tuningDials ?? {}),
        };
      }
      return layer.tuningDials;
    case 'generation':
      if (layer.generation === undefined && layer.tokenBudgets === undefined) {
        return undefined;
      }
      return {
        ...(layer.generation !== undefined ? { generation: layer.generation } : {}),
        ...(layer.tokenBudgets !== undefined ? { tokenBudgets: layer.tokenBudgets } : {}),
      };
  }
}

/**
 * Determine whether a given payload group in `incomingBundle` differs from `baseline`
 * (using normalized fingerprints). Useful for rendering "modified" vs "stock" badges in
 * a selective import dialog.
 */
export function isPayloadGroupModified(
  groupId: PayloadGroupId,
  incomingBundle: Readonly<PayloadBundle>,
  baseline: Readonly<ControlRoomLayer | ResolvedControlRoomConfig>
): boolean {
  const resolvedBaseline = isResolvedConfig(baseline) ? baseline : undefined;
  const incomingFp = computeNormalizedFingerprint(
    extractLayerGroupValue(incomingBundle, groupId, resolvedBaseline)
  );
  const baselineFp = computeNormalizedFingerprint(
    extractLayerGroupValue(baseline, groupId, resolvedBaseline)
  );
  return incomingFp !== baselineFp;
}

/**
 * Compute per-group modification flags across all {@link PayloadGroupId}s.
 */
export function getPayloadBundleGroupDiffs(
  incomingBundle: Readonly<PayloadBundle>,
  baseline: Readonly<ControlRoomLayer | ResolvedControlRoomConfig>
): Record<PayloadGroupId, boolean> {
  const diffs = {} as Record<PayloadGroupId, boolean>;
  for (const groupId of ALL_PAYLOAD_GROUP_IDS) {
    diffs[groupId] = isPayloadGroupModified(groupId, incomingBundle, baseline);
  }
  return diffs;
}
