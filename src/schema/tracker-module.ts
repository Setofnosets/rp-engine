import { type ValidationError } from '../core/errors.js';
import { ErrorAccumulator, type Result, err, ok } from '../core/result.js';
import type { CharacterSectionDef } from './character-sections.js';

export type SpatialMode = 'scene_only' | 'emergent' | 'authored_graph';
export type CombatMode = 'tactical_grid' | 'traditional' | 'disabled';
export type ProgressionMode = 'rpg_levels' | 'point_buy' | 'disabled';
export type ClockMode = 'full_sim' | 'calendar_only' | 'disabled';

export interface SystemCapabilities {
  spatialMode: SpatialMode;
  combatMode: CombatMode;
  progression: ProgressionMode;
  clocks: ClockMode;
  factions: boolean;
  beats: boolean;
  relationships: boolean;
  chronicle: boolean;
}

export type CadencePolicy =
  | 'every_turn'
  | { everyNTurns: number }
  | 'on_clock_advance'
  | 'on_combat_end'
  | 'manual_only';

export type ConfirmPolicy = 'auto' | 'batch_confirm' | 'always_confirm' | 'locked';
export type EffectOwner = 'engine' | 'tracker' | 'hybrid';

export type DynamicFieldSpec =
  | {
      type: 'meter';
      min: number;
      max: number;
      default: number;
      writableByTracker: boolean;
      confirmPolicy?: ConfirmPolicy;
      description?: string;
    }
  | {
      type: 'counter';
      min?: number;
      max?: number;
      default: number;
      writableByTracker: boolean;
      confirmPolicy?: ConfirmPolicy;
      description?: string;
    }
  | {
      type: 'enum';
      options: readonly string[];
      default: string;
      writableByTracker: boolean;
      confirmPolicy?: ConfirmPolicy;
      description?: string;
    }
  | {
      type: 'boolean';
      default: boolean;
      writableByTracker: boolean;
      confirmPolicy?: ConfirmPolicy;
      description?: string;
    }
  | {
      type: 'string';
      maxLength?: number;
      default: string;
      writableByTracker: boolean;
      confirmPolicy?: ConfirmPolicy;
      description?: string;
    }
  | {
      type: 'string_list';
      maxItems?: number;
      default: readonly string[];
      writableByTracker: boolean;
      confirmPolicy?: ConfirmPolicy;
      description?: string;
    };

export type ModuleScope = 'global' | 'session';
export type ModuleTarget = 'global' | 'player' | 'npc' | 'location';
export type ModuleWidgetType = 'bar' | 'badge' | 'tags' | 'card' | 'hidden';

export interface GameSystemModuleUi {
  widget: ModuleWidgetType;
  order: number;
}

export interface GameSystemModule {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  scope: ModuleScope;
  target: ModuleTarget;
  effectOwner: EffectOwner;
  cadence: CadencePolicy;
  fields: Record<string, DynamicFieldSpec>;
  trackerInstruction: string;
  narratorRule: string;
  ui: GameSystemModuleUi;
}

export interface SystemPack {
  spec: 'system-pack/0.1';
  id: string;
  name: string;
  description: string;
  capabilities: SystemCapabilities;
  pcCoreSections: CharacterSectionDef[];
  npcCoreSections: CharacterSectionDef[];
  gameSystems: GameSystemModule[];
  blockOrder: string[];
  syspromptSectionOrder: string[];
  basePrompts?: Record<string, string>;
}

const VALID_SPATIAL_MODES: ReadonlySet<SpatialMode> = new Set([
  'scene_only',
  'emergent',
  'authored_graph',
]);
const VALID_COMBAT_MODES: ReadonlySet<CombatMode> = new Set([
  'tactical_grid',
  'traditional',
  'disabled',
]);
const VALID_PROGRESSION_MODES: ReadonlySet<ProgressionMode> = new Set([
  'rpg_levels',
  'point_buy',
  'disabled',
]);
const VALID_CLOCK_MODES: ReadonlySet<ClockMode> = new Set([
  'full_sim',
  'calendar_only',
  'disabled',
]);
const VALID_CONFIRM_POLICIES: ReadonlySet<ConfirmPolicy> = new Set([
  'auto',
  'batch_confirm',
  'always_confirm',
  'locked',
]);
const VALID_EFFECT_OWNERS: ReadonlySet<EffectOwner> = new Set(['engine', 'tracker', 'hybrid']);
const VALID_MODULE_SCOPES: ReadonlySet<ModuleScope> = new Set(['global', 'session']);
const VALID_MODULE_TARGETS: ReadonlySet<ModuleTarget> = new Set([
  'global',
  'player',
  'npc',
  'location',
]);
const VALID_MODULE_WIDGETS: ReadonlySet<ModuleWidgetType> = new Set([
  'bar',
  'badge',
  'tags',
  'card',
  'hidden',
]);
const VALID_STRING_CADENCES: ReadonlySet<string> = new Set([
  'every_turn',
  'on_clock_advance',
  'on_combat_end',
  'manual_only',
]);

/**
 * Validate a {@link ConfirmPolicy} value.
 */
export function validateConfirmPolicy(
  policy: ConfirmPolicy,
  path = 'confirmPolicy'
): Result<ConfirmPolicy, ValidationError[]> {
  if (!VALID_CONFIRM_POLICIES.has(policy)) {
    return err([
      {
        path,
        code: 'INVALID_CONFIRM_POLICY',
        message: `Unsupported confirmPolicy "${String(policy)}"`,
      },
    ]);
  }
  return ok(policy);
}

/**
 * Validate a {@link CadencePolicy} value.
 */
export function validateCadencePolicy(
  cadence: CadencePolicy,
  path = 'cadence'
): Result<CadencePolicy, ValidationError[]> {
  if (typeof cadence === 'string') {
    if (!VALID_STRING_CADENCES.has(cadence)) {
      return err([
        {
          path,
          code: 'INVALID_CADENCE',
          message: `Unsupported cadence policy "${cadence}"`,
        },
      ]);
    }
    return ok(cadence);
  }

  if (
    typeof cadence === 'object' &&
    cadence !== null &&
    'everyNTurns' in cadence &&
    typeof cadence.everyNTurns === 'number'
  ) {
    if (!Number.isInteger(cadence.everyNTurns) || cadence.everyNTurns < 1) {
      return err([
        {
          path: `${path}.everyNTurns`,
          code: 'INVALID_CADENCE_INTERVAL',
          message: 'everyNTurns must be a positive integer >= 1',
        },
      ]);
    }
    return ok(cadence);
  }

  return err([
    {
      path,
      code: 'INVALID_CADENCE',
      message: 'Cadence policy must be a valid preset string or { everyNTurns: number }',
    },
  ]);
}

/**
 * Validate a {@link DynamicFieldSpec} definition including bounds, defaults, and policies.
 */
export function validateDynamicFieldSpec(
  spec: DynamicFieldSpec,
  path = 'field'
): Result<DynamicFieldSpec, ValidationError[]> {
  const acc = new ErrorAccumulator(path);

  if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) {
    acc.add('', 'INVALID_TYPE', 'DynamicFieldSpec must be a non-null object');
    return acc.toResult(spec);
  }

  if (typeof spec.writableByTracker !== 'boolean') {
    acc.add('writableByTracker', 'INVALID_TYPE', 'writableByTracker must be a boolean');
  }
  if (spec.confirmPolicy !== undefined) {
    acc.absorb(validateConfirmPolicy(spec.confirmPolicy, 'confirmPolicy'));
  }

  switch (spec.type) {
    case 'meter': {
      if (!Number.isFinite(spec.min)) {
        acc.add('min', 'INVALID_NUMBER', 'meter min must be a finite number');
      }
      if (!Number.isFinite(spec.max)) {
        acc.add('max', 'INVALID_NUMBER', 'meter max must be a finite number');
      }
      if (!Number.isFinite(spec.default)) {
        acc.add('default', 'INVALID_NUMBER', 'meter default must be a finite number');
      }
      if (Number.isFinite(spec.min) && Number.isFinite(spec.max)) {
        if (spec.min > spec.max) {
          acc.add('min', 'INVALID_RANGE', 'meter min cannot exceed max');
        } else if (
          Number.isFinite(spec.default) &&
          (spec.default < spec.min || spec.default > spec.max)
        ) {
          acc.add('default', 'OUT_OF_RANGE', 'meter default must fall within [min, max]');
        }
      }
      break;
    }
    case 'counter': {
      if (spec.min !== undefined && !Number.isInteger(spec.min)) {
        acc.add('min', 'INVALID_INTEGER', 'counter min must be an integer when provided');
      }
      if (spec.max !== undefined && !Number.isInteger(spec.max)) {
        acc.add('max', 'INVALID_INTEGER', 'counter max must be an integer when provided');
      }
      if (!Number.isInteger(spec.default)) {
        acc.add('default', 'INVALID_INTEGER', 'counter default must be an integer');
      }
      if (
        spec.min !== undefined &&
        spec.max !== undefined &&
        Number.isFinite(spec.min) &&
        Number.isFinite(spec.max) &&
        spec.min > spec.max
      ) {
        acc.add('min', 'INVALID_RANGE', 'counter min cannot exceed max');
      } else {
        if (spec.min !== undefined && Number.isFinite(spec.default) && spec.default < spec.min) {
          acc.add('default', 'OUT_OF_RANGE', 'counter default cannot be less than min');
        }
        if (spec.max !== undefined && Number.isFinite(spec.default) && spec.default > spec.max) {
          acc.add('default', 'OUT_OF_RANGE', 'counter default cannot exceed max');
        }
      }
      break;
    }
    case 'enum': {
      if (!Array.isArray(spec.options) || spec.options.length === 0) {
        acc.add('options', 'EMPTY_OPTIONS', 'enum options must be a non-empty array');
      } else {
        const seen = new Set<string>();
        for (let i = 0; i < spec.options.length; i += 1) {
          const opt = spec.options[i];
          if (typeof opt !== 'string' || opt.length === 0) {
            acc.add(`options[${i}]`, 'INVALID_OPTION', 'enum option must be a non-empty string');
          } else if (seen.has(opt)) {
            acc.add(`options[${i}]`, 'DUPLICATE_OPTION', `Duplicate enum option "${opt}"`);
          } else {
            seen.add(opt);
          }
        }
        if (typeof spec.default !== 'string' || !seen.has(spec.default)) {
          acc.add('default', 'INVALID_DEFAULT', 'enum default must be present in options');
        }
      }
      break;
    }
    case 'boolean': {
      if (typeof spec.default !== 'boolean') {
        acc.add('default', 'INVALID_TYPE', 'boolean default must be a boolean');
      }
      break;
    }
    case 'string': {
      if (typeof spec.default !== 'string') {
        acc.add('default', 'INVALID_TYPE', 'string default must be a string');
      }
      if (spec.maxLength !== undefined) {
        if (!Number.isInteger(spec.maxLength) || spec.maxLength < 0) {
          acc.add('maxLength', 'INVALID_LENGTH', 'string maxLength must be an integer >= 0');
        } else if (typeof spec.default === 'string' && spec.default.length > spec.maxLength) {
          acc.add('default', 'EXCEEDS_MAX_LENGTH', 'string default exceeds maxLength');
        }
      }
      break;
    }
    case 'string_list': {
      if (!Array.isArray(spec.default) || !spec.default.every((item) => typeof item === 'string')) {
        acc.add('default', 'INVALID_TYPE', 'string_list default must be an array of strings');
      }
      if (spec.maxItems !== undefined) {
        if (!Number.isInteger(spec.maxItems) || spec.maxItems < 0) {
          acc.add('maxItems', 'INVALID_LENGTH', 'string_list maxItems must be an integer >= 0');
        } else if (Array.isArray(spec.default) && spec.default.length > spec.maxItems) {
          acc.add('default', 'EXCEEDS_MAX_ITEMS', 'string_list default exceeds maxItems');
        }
      }
      break;
    }
    default: {
      const exhaustive: never = spec;
      acc.add('type', 'UNKNOWN_FIELD_TYPE', `Unknown field spec type: ${String(exhaustive)}`);
    }
  }

  return acc.toResult(spec);
}

/**
 * Validate a {@link SystemCapabilities} capability manifest.
 */
export function validateSystemCapabilities(
  capabilities: SystemCapabilities,
  path = 'capabilities'
): Result<SystemCapabilities, ValidationError[]> {
  const acc = new ErrorAccumulator(path);

  if (typeof capabilities !== 'object' || capabilities === null || Array.isArray(capabilities)) {
    acc.add('', 'INVALID_TYPE', 'capabilities must be a non-null object');
    return acc.toResult(capabilities);
  }

  if (!VALID_SPATIAL_MODES.has(capabilities.spatialMode)) {
    acc.add('spatialMode', 'INVALID_CAPABILITY', 'Invalid spatialMode');
  }
  if (!VALID_COMBAT_MODES.has(capabilities.combatMode)) {
    acc.add('combatMode', 'INVALID_CAPABILITY', 'Invalid combatMode');
  }
  if (!VALID_PROGRESSION_MODES.has(capabilities.progression)) {
    acc.add('progression', 'INVALID_CAPABILITY', 'Invalid progression mode');
  }
  if (!VALID_CLOCK_MODES.has(capabilities.clocks)) {
    acc.add('clocks', 'INVALID_CAPABILITY', 'Invalid clocks mode');
  }
  const booleanKeys = ['factions', 'beats', 'relationships', 'chronicle'] as const;
  for (const key of booleanKeys) {
    if (typeof capabilities[key] !== 'boolean') {
      acc.add(key, 'INVALID_TYPE', `${key} capability must be a boolean`);
    }
  }

  return acc.toResult(capabilities);
}

/**
 * Validate a {@link GameSystemModule} definition.
 */
export function validateGameSystemModule(
  module: GameSystemModule,
  path = 'gameSystem'
): Result<GameSystemModule, ValidationError[]> {
  const acc = new ErrorAccumulator(path);

  if (typeof module !== 'object' || module === null || Array.isArray(module)) {
    acc.add('', 'INVALID_TYPE', 'GameSystemModule must be a non-null object');
    return acc.toResult(module);
  }

  if (typeof module.id !== 'string' || module.id.trim().length === 0) {
    acc.add('id', 'REQUIRED', 'GameSystemModule id must be a non-empty string');
  }
  if (typeof module.name !== 'string' || module.name.trim().length === 0) {
    acc.add('name', 'REQUIRED', 'GameSystemModule name must be a non-empty string');
  }
  if (typeof module.enabled !== 'boolean') {
    acc.add('enabled', 'INVALID_TYPE', 'GameSystemModule enabled must be a boolean');
  }
  if (!VALID_MODULE_SCOPES.has(module.scope)) {
    acc.add('scope', 'INVALID_SCOPE', `Invalid module scope "${String(module.scope)}"`);
  }
  if (!VALID_MODULE_TARGETS.has(module.target)) {
    acc.add('target', 'INVALID_TARGET', `Invalid module target "${String(module.target)}"`);
  }
  if (!VALID_EFFECT_OWNERS.has(module.effectOwner)) {
    acc.add(
      'effectOwner',
      'INVALID_EFFECT_OWNER',
      `Invalid effectOwner "${String(module.effectOwner)}"`
    );
  }
  acc.absorb(validateCadencePolicy(module.cadence, 'cadence'));

  if (typeof module.fields !== 'object' || module.fields === null || Array.isArray(module.fields)) {
    acc.add('fields', 'INVALID_TYPE', 'GameSystemModule fields must be a plain record');
  } else {
    for (const [fieldKey, fieldSpec] of Object.entries(module.fields)) {
      if (!/^[a-zA-Z0-9_-]+$/.test(fieldKey)) {
        acc.add(
          `fields.${fieldKey}`,
          'INVALID_KEY',
          'Field key must be non-empty and contain only letters, digits, underscores, or hyphens'
        );
      } else {
        acc.absorb(validateDynamicFieldSpec(fieldSpec, `fields.${fieldKey}`));
      }
    }
  }

  if (typeof module.trackerInstruction !== 'string') {
    acc.add('trackerInstruction', 'INVALID_TYPE', 'trackerInstruction must be a string');
  }
  if (typeof module.narratorRule !== 'string') {
    acc.add('narratorRule', 'INVALID_TYPE', 'narratorRule must be a string');
  }

  if (typeof module.ui !== 'object' || module.ui === null) {
    acc.add('ui', 'INVALID_TYPE', 'ui configuration is required');
  } else {
    if (!VALID_MODULE_WIDGETS.has(module.ui.widget)) {
      acc.add('ui.widget', 'INVALID_WIDGET', `Invalid ui.widget "${String(module.ui.widget)}"`);
    }
    if (!Number.isFinite(module.ui.order)) {
      acc.add('ui.order', 'INVALID_NUMBER', 'ui.order must be a finite number');
    }
  }

  return acc.toResult(module);
}

/**
 * Deep-clone a {@link CadencePolicy} value.
 */
export function cloneCadencePolicy(cadence: CadencePolicy): CadencePolicy {
  if (typeof cadence === 'string') {
    return cadence;
  }
  return { everyNTurns: cadence.everyNTurns };
}

/**
 * Deep-clone a {@link DynamicFieldSpec} so callers cannot mutate shared schemas.
 */
export function cloneDynamicFieldSpec(spec: DynamicFieldSpec): DynamicFieldSpec {
  switch (spec.type) {
    case 'enum':
      return { ...spec, options: [...spec.options] };
    case 'string_list':
      return { ...spec, default: [...spec.default] };
    default:
      return { ...spec };
  }
}

/**
 * Deep-clone a {@link GameSystemModule}.
 */
export function cloneGameSystemModule(module: GameSystemModule): GameSystemModule {
  const clonedFields: Record<string, DynamicFieldSpec> = {};
  for (const [key, spec] of Object.entries(module.fields)) {
    clonedFields[key] = cloneDynamicFieldSpec(spec);
  }
  return {
    ...module,
    cadence: cloneCadencePolicy(module.cadence),
    fields: clonedFields,
    ui: { ...module.ui },
  };
}

/**
 * Clone a {@link SystemCapabilities} object.
 */
export function cloneSystemCapabilities(capabilities: SystemCapabilities): SystemCapabilities {
  return { ...capabilities };
}
