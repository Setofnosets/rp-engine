import { type ValidationError } from '../core/errors.js';
import { ErrorAccumulator, type Result } from '../core/result.js';
import {
  type CharacterSectionDef,
  cloneCharacterSections,
  validateCharacterSectionList,
} from './character-sections.js';
import {
  type CadencePolicy,
  type ConfirmPolicy,
  type DynamicFieldSpec,
  type GameSystemModule,
  type SystemCapabilities,
  type SystemPack,
  cloneDynamicFieldSpec,
  cloneGameSystemModule,
  cloneSystemCapabilities,
  validateGameSystemModule,
  validateSystemCapabilities,
} from './tracker-module.js';

export interface EffectiveSystemConfig {
  capabilities: SystemCapabilities;
  pcCoreSections: CharacterSectionDef[];
  npcCoreSections: CharacterSectionDef[];
  gameSystems: GameSystemModule[];
  blockOrder: string[];
  syspromptSectionOrder: string[];
}

export interface CompiledFieldPolicy {
  pathPattern: string;
  spec: DynamicFieldSpec;
  moduleId: string;
  writableByTracker: boolean;
  confirmPolicy: ConfirmPolicy;
}

export interface CadenceContext {
  turn: number;
  clockAdvancedThisTurn: boolean;
  combatEndedThisTurn: boolean;
  manualTrigger?: boolean;
}

export interface CompiledTrackerSchema {
  trackerJsonSchema: Record<string, unknown> | null;
  activeTrackerInstructions: string[];
  activeNarratorRules: string[];
  fieldPolicyMap: Map<string, CompiledFieldPolicy>;
  dueModuleIds: string[];
}

const SCENE_MODULE_IDS = new Set(['scene', 'scene_context']);
const RELATIONSHIP_MODULE_IDS = new Set(['relationships', 'relationship_affinity']);
const PROGRESSION_MODULE_IDS = new Set(['progression', 'rpg_progression']);
const COMBAT_MODULE_IDS = new Set(['combat', 'tactical_combat']);
const FACTION_MODULE_IDS = new Set(['factions', 'faction_agendas']);
const CLOCK_MODULE_IDS = new Set(['clocks', 'calendar_clock', 'dual_world_clock']);
const CHRONICLE_MODULE_IDS = new Set(['chronicle', 'episodic_chronicle']);

function compareStringsDeterministic(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

function isModulePermittedByCapabilities(
  moduleId: string,
  capabilities: SystemCapabilities
): boolean {
  if (COMBAT_MODULE_IDS.has(moduleId)) {
    return capabilities.combatMode !== 'disabled';
  }
  if (PROGRESSION_MODULE_IDS.has(moduleId)) {
    return capabilities.progression !== 'disabled';
  }
  if (FACTION_MODULE_IDS.has(moduleId)) {
    return capabilities.factions;
  }
  if (CLOCK_MODULE_IDS.has(moduleId)) {
    return capabilities.clocks !== 'disabled';
  }
  if (RELATIONSHIP_MODULE_IDS.has(moduleId)) {
    return capabilities.relationships;
  }
  if (CHRONICLE_MODULE_IDS.has(moduleId)) {
    return capabilities.chronicle;
  }
  return true;
}

function isSectionPermittedByCapabilities(
  sectionId: string,
  capabilities: SystemCapabilities
): boolean {
  if (sectionId === 'sec_combat_profile') {
    return capabilities.combatMode !== 'disabled';
  }
  return true;
}

function resolveConfirmPolicy(writableByTracker: boolean, confirmPolicy?: ConfirmPolicy): ConfirmPolicy {
  if (confirmPolicy !== undefined) {
    return confirmPolicy;
  }
  return writableByTracker ? 'auto' : 'locked';
}

function isEffectivelyWritable(writableByTracker: boolean, confirmPolicy?: ConfirmPolicy): boolean {
  return writableByTracker && confirmPolicy !== 'locked';
}

function fieldSpecToJsonSchema(spec: DynamicFieldSpec): Record<string, unknown> {
  const withDescription = (schema: Record<string, unknown>): Record<string, unknown> => {
    if (spec.description !== undefined && spec.description.length > 0) {
      schema['description'] = spec.description;
    }
    return schema;
  };

  switch (spec.type) {
    case 'meter':
      return withDescription({
        type: 'number',
        minimum: spec.min,
        maximum: spec.max,
      });
    case 'counter': {
      const schema: Record<string, unknown> = { type: 'integer' };
      if (spec.min !== undefined) {
        schema['minimum'] = spec.min;
      }
      if (spec.max !== undefined) {
        schema['maximum'] = spec.max;
      }
      return withDescription(schema);
    }
    case 'enum':
      return withDescription({
        type: 'string',
        enum: [...spec.options],
      });
    case 'boolean':
      return withDescription({
        type: 'boolean',
      });
    case 'string': {
      const schema: Record<string, unknown> = { type: 'string' };
      if (spec.maxLength !== undefined) {
        schema['maxLength'] = spec.maxLength;
      }
      return withDescription(schema);
    }
    case 'string_list': {
      const schema: Record<string, unknown> = {
        type: 'array',
        items: { type: 'string' },
      };
      if (spec.maxItems !== undefined) {
        schema['maxItems'] = spec.maxItems;
      }
      return withDescription(schema);
    }
  }
}

function sectionToFieldSpec(section: CharacterSectionDef): DynamicFieldSpec {
  if (section.fieldType === 'bullet_list') {
    return {
      type: 'string_list',
      default: [],
      writableByTracker: section.writableByTracker,
      ...(section.confirmPolicy !== undefined ? { confirmPolicy: section.confirmPolicy } : {}),
      description: section.description,
    };
  }
  return {
    type: 'string',
    default: '',
    writableByTracker: section.writableByTracker,
    ...(section.confirmPolicy !== undefined ? { confirmPolicy: section.confirmPolicy } : {}),
    description: section.description,
  };
}

function registerPolicy(
  map: Map<string, CompiledFieldPolicy>,
  pathPattern: string,
  spec: DynamicFieldSpec,
  moduleId: string
): void {
  const confirmPolicy = resolveConfirmPolicy(spec.writableByTracker, spec.confirmPolicy);
  const writableByTracker = isEffectivelyWritable(spec.writableByTracker, confirmPolicy);
  map.set(pathPattern, {
    pathPattern,
    spec: cloneDynamicFieldSpec(spec),
    moduleId,
    writableByTracker,
    confirmPolicy,
  });
}

const COMBAT_RESOURCE_KEYS = new Set(['hp', 'willpower', 'stamina', 'mana']);
const PROGRESSION_CORE_KEYS = new Set(['level', 'xp', 'class', 'gold']);
const FACTION_CORE_KEYS = new Set(['influence', 'status']);

function resolveModuleFieldPathPattern(module: GameSystemModule, fieldKey: string): string {
  if (SCENE_MODULE_IDS.has(module.id)) {
    return `scene.${fieldKey}`;
  }
  if (RELATIONSHIP_MODULE_IDS.has(module.id)) {
    return `relations.*.*.${fieldKey}`;
  }
  if (PROGRESSION_MODULE_IDS.has(module.id)) {
    if (PROGRESSION_CORE_KEYS.has(fieldKey)) {
      return module.target === 'player'
        ? `entities.characters.player.progression.${fieldKey}`
        : `entities.characters.*.progression.${fieldKey}`;
    }
    return `progression.${fieldKey}`;
  }
  if (COMBAT_MODULE_IDS.has(module.id)) {
    if (COMBAT_RESOURCE_KEYS.has(fieldKey)) {
      return module.target === 'player'
        ? `entities.characters.player.resources.${fieldKey}`
        : `entities.characters.*.resources.${fieldKey}`;
    }
    return `combat.${fieldKey}`;
  }
  if (FACTION_MODULE_IDS.has(module.id)) {
    if (FACTION_CORE_KEYS.has(fieldKey)) {
      return `entities.factions.*.${fieldKey}`;
    }
    return `factions.${fieldKey}`;
  }

  switch (module.target) {
    case 'global':
      return `custom_fields.${fieldKey}`;
    case 'player':
      return `entities.characters.player.custom_fields.${fieldKey}`;
    case 'npc':
      return `entities.characters.*.custom_fields.${fieldKey}`;
    case 'location':
      return `entities.locations.*.custom_fields.${fieldKey}`;
  }
}

/**
 * Determine whether a module or section cadence policy is due on the given turn context.
 */
export function isCadenceDue(cadence: CadencePolicy, context: CadenceContext): boolean {
  if (typeof cadence === 'string') {
    switch (cadence) {
      case 'every_turn':
        return true;
      case 'on_clock_advance':
        return context.clockAdvancedThisTurn;
      case 'on_combat_end':
        return context.combatEndedThisTurn;
      case 'manual_only':
        return Boolean(context.manualTrigger);
      default: {
        const exhaustive: never = cadence;
        return Boolean(exhaustive) && false;
      }
    }
  }

  if (
    typeof cadence === 'object' &&
    cadence !== null &&
    Number.isInteger(cadence.everyNTurns) &&
    cadence.everyNTurns >= 1 &&
    Number.isInteger(context.turn) &&
    context.turn >= 1
  ) {
    return context.turn % cadence.everyNTurns === 0;
  }

  return false;
}

/**
 * Compile the active tracker JSON Schema, narrator rules, tracker instructions,
 * and full field policy map for the current turn and system configuration.
 */
export function compileActiveTrackerSchema(
  config: EffectiveSystemConfig,
  context: CadenceContext
): CompiledTrackerSchema {
  const fieldPolicyMap = new Map<string, CompiledFieldPolicy>();
  const activeTrackerInstructions: string[] = [];
  const activeNarratorRules: string[] = [];
  const dueModuleIds: string[] = [];

  const sceneProperties: Record<string, unknown> = {};
  const globalCustomProperties: Record<string, unknown> = {};
  const playerCustomProperties: Record<string, unknown> = {};
  const npcCustomProperties: Record<string, unknown> = {};
  const locationCustomProperties: Record<string, unknown> = {};
  const progressionProperties: Record<string, unknown> = {};
  const combatProperties: Record<string, unknown> = {};
  const factionProperties: Record<string, unknown> = {};
  const pcSectionProperties: Record<string, unknown> = {};
  const npcSectionProperties: Record<string, unknown> = {};

  const { capabilities } = config;

  // Baseline capability-owned engine policies (non-writable by tracker, enforced by reducer).
  if (capabilities.progression !== 'disabled') {
    registerPolicy(
      fieldPolicyMap,
      'entities.characters.*.progression.level',
      {
        type: 'counter',
        min: 1,
        default: 1,
        writableByTracker: false,
        confirmPolicy: 'locked',
        description: 'Character progression level (engine-owned)',
      },
      'progression'
    );
    registerPolicy(
      fieldPolicyMap,
      'entities.characters.*.progression.xp',
      {
        type: 'counter',
        min: 0,
        default: 0,
        writableByTracker: false,
        confirmPolicy: 'locked',
        description: 'Character experience points (engine-owned)',
      },
      'progression'
    );
    registerPolicy(
      fieldPolicyMap,
      'entities.characters.*.progression.class',
      {
        type: 'string',
        default: '',
        writableByTracker: false,
        confirmPolicy: 'locked',
        description: 'Character class or archetype (engine-owned)',
      },
      'progression'
    );
  }

  if (capabilities.combatMode !== 'disabled') {
    registerPolicy(
      fieldPolicyMap,
      'entities.characters.*.resources.hp',
      {
        type: 'meter',
        min: 0,
        max: 9999,
        default: 10,
        writableByTracker: false,
        confirmPolicy: 'locked',
        description: 'Character hit points (engine-owned)',
      },
      'combat'
    );
    registerPolicy(
      fieldPolicyMap,
      'entities.characters.*.resources.willpower',
      {
        type: 'meter',
        min: 0,
        max: 100,
        default: 10,
        writableByTracker: false,
        confirmPolicy: 'locked',
        description: 'Character willpower resource (engine-owned)',
      },
      'combat'
    );
    registerPolicy(
      fieldPolicyMap,
      'entities.characters.*.resources.stamina',
      {
        type: 'meter',
        min: 0,
        max: 100,
        default: 100,
        writableByTracker: false,
        confirmPolicy: 'locked',
        description: 'Character stamina resource (engine-owned)',
      },
      'combat'
    );
  }

  if (capabilities.factions) {
    registerPolicy(
      fieldPolicyMap,
      'entities.factions.*.influence',
      {
        type: 'meter',
        min: 0,
        max: 100,
        default: 50,
        writableByTracker: false,
        confirmPolicy: 'locked',
        description: 'Faction influence meter (engine-owned)',
      },
      'factions'
    );
    registerPolicy(
      fieldPolicyMap,
      'entities.threats.*.progress',
      {
        type: 'meter',
        min: 0,
        max: 100,
        default: 0,
        writableByTracker: false,
        confirmPolicy: 'locked',
        description: 'Threat escalation progress (engine-owned)',
      },
      'factions'
    );
  }

  // Sort enabled & capability-permitted modules deterministically by UI order then ID.
  const sortedModules = [...config.gameSystems].sort(
    (a, b) => a.ui.order - b.ui.order || compareStringsDeterministic(a.id, b.id)
  );

  let explicitRelationshipModule: GameSystemModule | undefined;
  let relationshipModuleDue = false;
  const relationshipExtraProperties: Record<string, unknown> = {};

  for (const mod of sortedModules) {
    if (RELATIONSHIP_MODULE_IDS.has(mod.id)) {
      explicitRelationshipModule = mod;
    }

    if (!mod.enabled || !isModulePermittedByCapabilities(mod.id, capabilities)) {
      continue;
    }

    if (mod.narratorRule.trim().length > 0) {
      activeNarratorRules.push(mod.narratorRule);
    }

    const due = isCadenceDue(mod.cadence, context);
    let modEmittedWritableSchema = false;

    for (const [fieldKey, spec] of Object.entries(mod.fields)) {
      const pathPattern = resolveModuleFieldPathPattern(mod, fieldKey);
      registerPolicy(fieldPolicyMap, pathPattern, spec, mod.id);

      if (!due || !isEffectivelyWritable(spec.writableByTracker, spec.confirmPolicy)) {
        continue;
      }

      const jsonSchema = fieldSpecToJsonSchema(spec);
      modEmittedWritableSchema = true;

      if (SCENE_MODULE_IDS.has(mod.id)) {
        sceneProperties[fieldKey] = jsonSchema;
      } else if (RELATIONSHIP_MODULE_IDS.has(mod.id)) {
        relationshipExtraProperties[fieldKey] = jsonSchema;
      } else if (PROGRESSION_MODULE_IDS.has(mod.id)) {
        progressionProperties[fieldKey] = jsonSchema;
      } else if (COMBAT_MODULE_IDS.has(mod.id)) {
        combatProperties[fieldKey] = jsonSchema;
      } else if (FACTION_MODULE_IDS.has(mod.id)) {
        factionProperties[fieldKey] = jsonSchema;
      } else {
        switch (mod.target) {
          case 'global':
            globalCustomProperties[fieldKey] = jsonSchema;
            break;
          case 'player':
            playerCustomProperties[fieldKey] = jsonSchema;
            break;
          case 'npc':
            npcCustomProperties[fieldKey] = jsonSchema;
            break;
          case 'location':
            locationCustomProperties[fieldKey] = jsonSchema;
            break;
        }
      }
    }

    if (RELATIONSHIP_MODULE_IDS.has(mod.id) && due) {
      relationshipModuleDue = true;
      modEmittedWritableSchema = true;
    }

    if (due && modEmittedWritableSchema) {
      dueModuleIds.push(mod.id);
      if (mod.trackerInstruction.trim().length > 0) {
        activeTrackerInstructions.push(mod.trackerInstruction);
      }
    }
  }

  // Relationships capability handling (explicit module or implicit capability default).
  const relationshipsEnabled =
    capabilities.relationships &&
    (explicitRelationshipModule === undefined || explicitRelationshipModule.enabled);
  if (relationshipsEnabled) {
    const relModuleId = explicitRelationshipModule?.id ?? 'relationships';
    const affinitySpec: DynamicFieldSpec = {
      type: 'meter',
      min: -100,
      max: 100,
      default: 0,
      writableByTracker: true,
      confirmPolicy: 'auto',
      description: 'Relationship affinity score (-100 to 100)',
    };
    const labelSpec: DynamicFieldSpec = {
      type: 'string',
      maxLength: 64,
      default: 'stranger',
      writableByTracker: true,
      confirmPolicy: 'auto',
      description: 'Current relationship label',
    };
    const tagsSpec: DynamicFieldSpec = {
      type: 'string_list',
      maxItems: 10,
      default: [],
      writableByTracker: true,
      confirmPolicy: 'auto',
      description: 'Relationship descriptor tags',
    };
    if (!fieldPolicyMap.has('relations.*.*.affinity')) {
      registerPolicy(fieldPolicyMap, 'relations.*.*.affinity', affinitySpec, relModuleId);
    }
    if (!fieldPolicyMap.has('relations.*.*.label')) {
      registerPolicy(fieldPolicyMap, 'relations.*.*.label', labelSpec, relModuleId);
    }
    if (!fieldPolicyMap.has('relations.*.*.tags')) {
      registerPolicy(fieldPolicyMap, 'relations.*.*.tags', tagsSpec, relModuleId);
    }

    if (explicitRelationshipModule === undefined) {
      relationshipModuleDue = true;
      dueModuleIds.push('relationships');
    }
  }

  // Modular PC character sections
  let anyPcSectionDue = false;
  for (const section of config.pcCoreSections) {
    if (!isSectionPermittedByCapabilities(section.id, capabilities)) {
      continue;
    }
    const sectionSpec = sectionToFieldSpec(section);
    registerPolicy(
      fieldPolicyMap,
      `entities.characters.player.sections.${section.id}`,
      sectionSpec,
      'pc_core_sections'
    );
    if (
      isEffectivelyWritable(section.writableByTracker, section.confirmPolicy) &&
      isCadenceDue(section.cadence, context)
    ) {
      pcSectionProperties[section.id] = fieldSpecToJsonSchema(sectionSpec);
      anyPcSectionDue = true;
    }
  }
  if (anyPcSectionDue) {
    dueModuleIds.push('pc_core_sections');
  }

  // Modular NPC character sections
  let anyNpcSectionDue = false;
  for (const section of config.npcCoreSections) {
    if (!isSectionPermittedByCapabilities(section.id, capabilities)) {
      continue;
    }
    const sectionSpec = sectionToFieldSpec(section);
    registerPolicy(
      fieldPolicyMap,
      `entities.characters.*.sections.${section.id}`,
      sectionSpec,
      'npc_core_sections'
    );
    if (
      isEffectivelyWritable(section.writableByTracker, section.confirmPolicy) &&
      isCadenceDue(section.cadence, context)
    ) {
      npcSectionProperties[section.id] = fieldSpecToJsonSchema(sectionSpec);
      anyNpcSectionDue = true;
    }
  }
  if (anyNpcSectionDue) {
    dueModuleIds.push('npc_core_sections');
  }

  // Build root tracker JSON Schema properties from all active & due buckets.
  const rootProperties: Record<string, unknown> = {};

  if (Object.keys(sceneProperties).length > 0) {
    rootProperties['scene'] = {
      type: 'object',
      additionalProperties: false,
      properties: sceneProperties,
    };
  }

  if (Object.keys(globalCustomProperties).length > 0) {
    rootProperties['custom_fields'] = {
      type: 'object',
      additionalProperties: false,
      properties: globalCustomProperties,
    };
  }

  if (Object.keys(playerCustomProperties).length > 0) {
    rootProperties['player_custom_fields'] = {
      type: 'object',
      additionalProperties: false,
      properties: playerCustomProperties,
    };
  }

  if (Object.keys(npcCustomProperties).length > 0) {
    rootProperties['npc_custom_fields'] = {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['characterId'],
        properties: {
          characterId: { type: 'string' },
          ...npcCustomProperties,
        },
      },
    };
  }

  if (Object.keys(locationCustomProperties).length > 0) {
    rootProperties['location_custom_fields'] = {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['locationId'],
        properties: {
          locationId: { type: 'string' },
          ...locationCustomProperties,
        },
      },
    };
  }

  if (Object.keys(pcSectionProperties).length > 0) {
    rootProperties['pc_sections'] = {
      type: 'object',
      additionalProperties: false,
      properties: pcSectionProperties,
    };
  }

  if (Object.keys(npcSectionProperties).length > 0) {
    rootProperties['npc_sections'] = {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['characterId'],
        properties: {
          characterId: { type: 'string' },
          ...npcSectionProperties,
        },
      },
    };
  }

  if (relationshipsEnabled && relationshipModuleDue) {
    const relItemProperties: Record<string, unknown> = {
      fromId: { type: 'string' },
      toId: { type: 'string' },
    };
    if (fieldPolicyMap.get('relations.*.*.affinity')?.writableByTracker !== false) {
      relItemProperties['affinityDelta'] = {
        type: 'integer',
        minimum: -25,
        maximum: 25,
        description: 'Signed change to apply to affinity this turn',
      };
    }
    if (fieldPolicyMap.get('relations.*.*.label')?.writableByTracker !== false) {
      relItemProperties['label'] = { type: 'string', maxLength: 64 };
    }
    if (fieldPolicyMap.get('relations.*.*.tags')?.writableByTracker !== false) {
      relItemProperties['tags'] = { type: 'array', items: { type: 'string' }, maxItems: 10 };
    }
    for (const [key, val] of Object.entries(relationshipExtraProperties)) {
      relItemProperties[key] = val;
    }

    rootProperties['relationships'] = {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['fromId', 'toId'],
        properties: relItemProperties,
      },
    };
  }

  if (Object.keys(progressionProperties).length > 0) {
    rootProperties['progression'] = {
      type: 'object',
      additionalProperties: false,
      properties: progressionProperties,
    };
  }

  if (Object.keys(combatProperties).length > 0) {
    rootProperties['combat'] = {
      type: 'object',
      additionalProperties: false,
      properties: combatProperties,
    };
  }

  if (Object.keys(factionProperties).length > 0) {
    rootProperties['factions'] = {
      type: 'object',
      additionalProperties: false,
      properties: factionProperties,
    };
  }

  if (Object.keys(rootProperties).length === 0) {
    return {
      trackerJsonSchema: null,
      activeTrackerInstructions,
      activeNarratorRules,
      fieldPolicyMap,
      dueModuleIds,
    };
  }

  return {
    trackerJsonSchema: {
      type: 'object',
      additionalProperties: false,
      properties: rootProperties,
    },
    activeTrackerInstructions,
    activeNarratorRules,
    fieldPolicyMap,
    dueModuleIds,
  };
}

/**
 * Validate an {@link EffectiveSystemConfig} structure and detect duplicate IDs or path collisions.
 */
export function validateEffectiveSystemConfig(
  config: EffectiveSystemConfig,
  basePath = ''
): Result<EffectiveSystemConfig, ValidationError[]> {
  const acc = new ErrorAccumulator(basePath);

  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    acc.add('', 'INVALID_TYPE', 'EffectiveSystemConfig must be a non-null object');
    return acc.toResult(config);
  }

  acc.absorb(validateSystemCapabilities(config.capabilities, 'capabilities'));
  acc.absorb(validateCharacterSectionList(config.pcCoreSections, 'pcCoreSections'));
  acc.absorb(validateCharacterSectionList(config.npcCoreSections, 'npcCoreSections'));

  if (!Array.isArray(config.gameSystems)) {
    acc.add('gameSystems', 'INVALID_TYPE', 'gameSystems must be an array');
  } else {
    const seenIds = new Set<string>();
    const seenFieldPaths = new Map<string, string>();
    for (let i = 0; i < config.gameSystems.length; i += 1) {
      const mod = config.gameSystems[i];
      if (mod === undefined) {
        continue;
      }
      acc.absorb(validateGameSystemModule(mod, `gameSystems[${i}]`));
      if (typeof mod.id === 'string' && mod.id.trim().length > 0) {
        if (seenIds.has(mod.id)) {
          acc.add(
            `gameSystems[${i}].id`,
            'DUPLICATE_MODULE_ID',
            `Duplicate GameSystemModule id "${mod.id}"`
          );
        } else {
          seenIds.add(mod.id);
        }
      }
      if (mod.enabled && typeof mod.fields === 'object' && mod.fields !== null) {
        for (const fieldKey of Object.keys(mod.fields)) {
          const pathPattern = resolveModuleFieldPathPattern(mod, fieldKey);
          const owner = seenFieldPaths.get(pathPattern);
          if (owner !== undefined) {
            acc.add(
              `gameSystems[${i}].fields.${fieldKey}`,
              'FIELD_PATH_COLLISION',
              `Field path "${pathPattern}" collides with module "${owner}"`
            );
          } else {
            seenFieldPaths.set(pathPattern, mod.id);
          }
        }
      }
    }
  }

  if (!Array.isArray(config.blockOrder) || !config.blockOrder.every((b) => typeof b === 'string')) {
    acc.add('blockOrder', 'INVALID_TYPE', 'blockOrder must be an array of strings');
  }
  if (
    !Array.isArray(config.syspromptSectionOrder) ||
    !config.syspromptSectionOrder.every((s) => typeof s === 'string')
  ) {
    acc.add(
      'syspromptSectionOrder',
      'INVALID_TYPE',
      'syspromptSectionOrder must be an array of strings'
    );
  }

  return acc.toResult(config);
}

/**
 * Validate a {@link SystemPack} document including metadata and effective config rules.
 */
export function validateSystemPack(pack: SystemPack): Result<SystemPack, ValidationError[]> {
  const acc = new ErrorAccumulator();

  if (typeof pack !== 'object' || pack === null || Array.isArray(pack)) {
    acc.add('', 'INVALID_TYPE', 'SystemPack must be a non-null object');
    return acc.toResult(pack);
  }

  if (pack.spec !== 'system-pack/0.1') {
    acc.add('spec', 'INVALID_SPEC', `Unsupported spec "${String(pack.spec)}"`);
  }
  if (typeof pack.id !== 'string' || pack.id.trim().length === 0) {
    acc.add('id', 'REQUIRED', 'SystemPack id must be a non-empty string');
  }
  if (typeof pack.name !== 'string' || pack.name.trim().length === 0) {
    acc.add('name', 'REQUIRED', 'SystemPack name must be a non-empty string');
  }
  if (typeof pack.description !== 'string') {
    acc.add('description', 'INVALID_TYPE', 'SystemPack description must be a string');
  }
  if (pack.basePrompts !== undefined) {
    if (
      typeof pack.basePrompts !== 'object' ||
      pack.basePrompts === null ||
      Array.isArray(pack.basePrompts)
    ) {
      acc.add('basePrompts', 'INVALID_TYPE', 'basePrompts must be a plain string dictionary');
    } else {
      for (const [key, val] of Object.entries(pack.basePrompts)) {
        if (typeof val !== 'string') {
          acc.add(`basePrompts.${key}`, 'INVALID_TYPE', 'basePrompt entry must be a string');
        }
      }
    }
  }

  acc.absorb(validateEffectiveSystemConfig(pack));
  return acc.toResult(pack);
}

/**
 * Deep-clone a {@link SystemPack} so callers receive an isolated copy.
 */
export function cloneSystemPack(pack: SystemPack): SystemPack {
  return {
    spec: pack.spec,
    id: pack.id,
    name: pack.name,
    description: pack.description,
    capabilities: cloneSystemCapabilities(pack.capabilities),
    pcCoreSections: cloneCharacterSections(pack.pcCoreSections),
    npcCoreSections: cloneCharacterSections(pack.npcCoreSections),
    gameSystems: pack.gameSystems.map(cloneGameSystemModule),
    blockOrder: [...pack.blockOrder],
    syspromptSectionOrder: [...pack.syspromptSectionOrder],
    ...(pack.basePrompts !== undefined ? { basePrompts: { ...pack.basePrompts } } : {}),
  };
}
