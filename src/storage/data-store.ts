import type { Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  type CartridgeBundle,
  validateCartridgeStructure,
} from '../cartridge/cartridge-schema.js';
import { parseAndValidateSystemPack } from '../cartridge/system-pack-schema.js';
import {
  type BeatPressure,
  type ControlRoomLayer,
  type GenerationSourceFormat,
  type NarrativePacing,
  cloneControlRoomLayer,
} from '../config/control-room-config.js';
import {
  type UserPersonaPreset,
  cloneUserPersonaPreset,
  validateUserPersonaPreset,
} from '../config/persona-preset.js';
import { RefereeError, type ValidationError, validationError } from '../core/errors.js';
import { ErrorAccumulator, type Result, err, ok } from '../core/result.js';
import {
  type ConnectionsFileDocument,
  loadConnectionsFile,
  saveConnectionsFile,
} from '../gateway/connection-store.js';
import {
  type CharacterSectionDef,
  validateCharacterSectionList,
} from '../schema/character-sections.js';
import { cloneSystemPack } from '../schema/dynamic-schema-compiler.js';
import {
  type CadencePolicy,
  type ClockMode,
  type CombatMode,
  type ConfirmPolicy,
  type DynamicFieldSpec,
  type GameSystemModule,
  type ProgressionMode,
  type SpatialMode,
  type SystemPack,
  validateCadencePolicy,
  validateConfirmPolicy,
  validateDynamicFieldSpec,
  validateGameSystemModule,
} from '../schema/tracker-module.js';

/**
 * Saved Control Room preset persisted on disk under `presets/<id>.json`.
 */
export interface SavedControlRoomPreset {
  id: string;
  name: string;
  description?: string;
  sourceFormat: GenerationSourceFormat;
  layer: ControlRoomLayer;
  updatedAt: string;
}

/**
 * Input payload accepted by {@link RefereeDataStore.savePreset}; `updatedAt` defaults
 * to the current ISO timestamp when omitted.
 */
export type SaveControlRoomPresetInput = Omit<SavedControlRoomPreset, 'updatedAt'> & {
  updatedAt?: string;
};

/**
 * Resilient directory listing result containing validated items and non-fatal warnings
 * for skipped or corrupt entries.
 */
export interface StorageListResult<T> {
  items: T[];
  warnings: ValidationError[];
}

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
const WINDOWS_RESERVED_CHARS_REGEX = /[<>:"|?*]/;
const CONTROL_CHARS_REGEX = /[\x00-\x1f]/;

const VALID_GENERATION_SOURCE_FORMATS: ReadonlySet<GenerationSourceFormat> = new Set([
  'referee',
  'st_chat_completion',
  'st_text_completion',
]);
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
const VALID_MODULE_SCOPES: ReadonlySet<string> = new Set(['global', 'session']);
const VALID_MODULE_TARGETS: ReadonlySet<string> = new Set([
  'global',
  'player',
  'npc',
  'location',
]);
const VALID_EFFECT_OWNERS: ReadonlySet<string> = new Set(['engine', 'tracker', 'hybrid']);
const VALID_WIDGETS: ReadonlySet<string> = new Set(['bar', 'badge', 'tags', 'card', 'hidden']);
const VALID_BEAT_PRESSURES: ReadonlySet<BeatPressure> = new Set([
  'off',
  'generous',
  'standard',
  'harsh',
]);
const VALID_NARRATIVE_PACINGS: ReadonlySet<NarrativePacing> = new Set([
  'slow_burn',
  'balanced',
  'fast_forward',
]);
const VALID_CUSTOM_BLOCK_ROLES: ReadonlySet<string> = new Set(['system', 'user', 'assistant']);
const VALID_INJECTION_POSITIONS: ReadonlySet<string> = new Set(['relative', 'in_chat']);

const GENERATION_NUMERIC_FIELDS = [
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
] as const;

const ST_FORMAT_TEMPLATE_FIELDS = [
  'wiFormat',
  'scenarioFormat',
  'personalityFormat',
  'impersonationPrompt',
  'newChatPrompt',
  'continueNudgePrompt',
  'storyString',
  'inputSequence',
  'outputSequence',
] as const;

const TOKEN_BUDGET_FIELDS = [
  'system',
  'card',
  'state',
  'combatOutcome',
  'plot',
  'world',
  'totalMaxTokens',
] as const;

function isSafeKey(key: string): boolean {
  return key.length > 0 && !FORBIDDEN_KEYS.has(key);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

function getOwn(obj: Record<string, unknown>, key: string): unknown {
  if (!isSafeKey(key) || !Object.hasOwn(obj, key)) {
    return undefined;
  }
  return Object.getOwnPropertyDescriptor(obj, key)?.value;
}

function setOwn<T>(obj: Record<string, T>, key: string, value: T): void {
  if (!isSafeKey(key)) {
    return;
  }
  Object.defineProperty(obj, key, {
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

function containsForbiddenKeys(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsForbiddenKeys);
  }
  if (value !== null && typeof value === 'object') {
    for (const key of Object.getOwnPropertyNames(value)) {
      if (!isSafeKey(key)) {
        return true;
      }
      const child = Object.getOwnPropertyDescriptor(value, key)?.value;
      if (containsForbiddenKeys(child)) {
        return true;
      }
    }
  }
  return false;
}

function sanitizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeJsonValue);
  }
  if (value !== null && typeof value === 'object' && isPlainRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.getOwnPropertyNames(value)) {
      if (!isSafeKey(key)) {
        continue;
      }
      const desc = Object.getOwnPropertyDescriptor(value, key);
      if (desc !== undefined && desc.value !== undefined) {
        setOwn(out, key, sanitizeJsonValue(desc.value));
      }
    }
    return out;
  }
  return value;
}

function isEnoentError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

function formatFsError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/**
 * Validate that a storage identifier is safe for single-segment filesystem paths and
 * immune to path traversal, Windows reserved character issues, and prototype pollution.
 */
export function validateSafeStorageId(id: string): Result<string, ValidationError[]> {
  if (typeof id !== 'string') {
    return err([validationError('id', 'INVALID_TYPE', 'Storage ID must be a string')]);
  }
  if (id.length === 0 || id.trim().length === 0) {
    return err([validationError('id', 'REQUIRED', 'Storage ID must be a non-empty string')]);
  }
  if (id !== id.trim()) {
    return err([
      validationError(
        'id',
        'INVALID_ID',
        'Storage ID must not contain leading or trailing whitespace'
      ),
    ]);
  }
  if (FORBIDDEN_KEYS.has(id)) {
    return err([
      validationError('id', 'UNSAFE_KEY', `Forbidden prototype-polluting storage ID "${id}"`),
    ]);
  }
  if (CONTROL_CHARS_REGEX.test(id)) {
    return err([
      validationError('id', 'UNSAFE_ID', 'Storage ID must not contain NUL bytes or control chars'),
    ]);
  }
  if (id.includes('/') || id.includes('\\')) {
    return err([
      validationError('id', 'UNSAFE_ID', `Storage ID "${id}" must not contain path separators`),
    ]);
  }
  if (id.includes('..') || id.includes('.')) {
    return err([
      validationError('id', 'UNSAFE_ID', `Storage ID "${id}" must not contain "." or ".."`),
    ]);
  }
  if (WINDOWS_RESERVED_CHARS_REGEX.test(id)) {
    return err([
      validationError(
        'id',
        'UNSAFE_ID',
        `Storage ID "${id}" contains reserved filesystem characters`
      ),
    ]);
  }
  return ok(id);
}

function resolveContainedPath(
  targetSubdir: string,
  id: string,
  fileSuffix: string
): Result<string, ValidationError[]> {
  const validId = validateSafeStorageId(id);
  if (!validId.ok) {
    return validId;
  }

  const resolvedSubdir = path.resolve(targetSubdir);
  const resolvedTarget = path.resolve(resolvedSubdir, `${validId.value}${fileSuffix}`);
  const relative = path.relative(resolvedSubdir, resolvedTarget);

  if (
    relative.length === 0 ||
    relative.startsWith('..') ||
    path.isAbsolute(relative) ||
    path.dirname(resolvedTarget) !== resolvedSubdir
  ) {
    return err([
      validationError(
        'id',
        'PATH_TRAVERSAL',
        `Resolved path for storage ID "${id}" escapes target directory`
      ),
    ]);
  }

  return ok(resolvedTarget);
}

function validateStringRecord(raw: unknown, acc: ErrorAccumulator, label: string): void {
  if (!isPlainRecord(raw)) {
    acc.add('', 'INVALID_TYPE', `${label} must be a plain string record`);
    return;
  }
  for (const key of Object.getOwnPropertyNames(raw)) {
    if (!isSafeKey(key)) {
      acc.add(key, 'UNSAFE_KEY', `Forbidden key "${key}" in ${label}`);
      continue;
    }
    const val = getOwn(raw, key);
    if (typeof val !== 'string') {
      acc.add(key, 'INVALID_TYPE', `${label}.${key} must be a string`);
    }
  }
}

function validateBooleanRecord(raw: unknown, acc: ErrorAccumulator, label: string): void {
  if (!isPlainRecord(raw)) {
    acc.add('', 'INVALID_TYPE', `${label} must be a plain boolean record`);
    return;
  }
  for (const key of Object.getOwnPropertyNames(raw)) {
    if (!isSafeKey(key)) {
      acc.add(key, 'UNSAFE_KEY', `Forbidden key "${key}" in ${label}`);
      continue;
    }
    const val = getOwn(raw, key);
    if (typeof val !== 'boolean') {
      acc.add(key, 'INVALID_TYPE', `${label}.${key} must be a boolean`);
    }
  }
}

function validateStringArray(raw: unknown, acc: ErrorAccumulator, label: string): void {
  if (!Array.isArray(raw)) {
    acc.add('', 'INVALID_TYPE', `${label} must be an array of strings`);
    return;
  }
  for (let i = 0; i < raw.length; i += 1) {
    if (typeof raw[i] !== 'string') {
      acc.add(`[${i}]`, 'INVALID_TYPE', `${label}[${i}] must be a string`);
    }
  }
}

function validateControlRoomLayerValue(rawLayer: unknown, acc: ErrorAccumulator): void {
  if (!isPlainRecord(rawLayer)) {
    acc.add('', 'INVALID_TYPE', 'layer must be a plain object');
    return;
  }

  const rawCaps = getOwn(rawLayer, 'capabilities');
  if (rawCaps !== undefined) {
    const cAcc = acc.scope('capabilities');
    if (!isPlainRecord(rawCaps)) {
      cAcc.add('', 'INVALID_TYPE', 'capabilities must be a plain object');
    } else {
      const spatialMode = getOwn(rawCaps, 'spatialMode');
      if (spatialMode !== undefined && !VALID_SPATIAL_MODES.has(spatialMode as SpatialMode)) {
        cAcc.add('spatialMode', 'INVALID_CAPABILITY', 'Invalid spatialMode');
      }
      const combatMode = getOwn(rawCaps, 'combatMode');
      if (combatMode !== undefined && !VALID_COMBAT_MODES.has(combatMode as CombatMode)) {
        cAcc.add('combatMode', 'INVALID_CAPABILITY', 'Invalid combatMode');
      }
      const progression = getOwn(rawCaps, 'progression');
      if (progression !== undefined && !VALID_PROGRESSION_MODES.has(progression as ProgressionMode)) {
        cAcc.add('progression', 'INVALID_CAPABILITY', 'Invalid progression mode');
      }
      const clocks = getOwn(rawCaps, 'clocks');
      if (clocks !== undefined && !VALID_CLOCK_MODES.has(clocks as ClockMode)) {
        cAcc.add('clocks', 'INVALID_CAPABILITY', 'Invalid clocks mode');
      }
      for (const boolKey of ['factions', 'beats', 'relationships', 'chronicle'] as const) {
        const val = getOwn(rawCaps, boolKey);
        if (val !== undefined && typeof val !== 'boolean') {
          cAcc.add(boolKey, 'INVALID_TYPE', `${boolKey} capability must be a boolean`);
        }
      }
    }
  }

  const pcCoreSections = getOwn(rawLayer, 'pcCoreSections');
  if (pcCoreSections !== undefined) {
    acc.absorb(
      validateCharacterSectionList(pcCoreSections as CharacterSectionDef[], 'pcCoreSections')
    );
  }
  const npcCoreSections = getOwn(rawLayer, 'npcCoreSections');
  if (npcCoreSections !== undefined) {
    acc.absorb(
      validateCharacterSectionList(npcCoreSections as CharacterSectionDef[], 'npcCoreSections')
    );
  }

  const rawPolicies = getOwn(rawLayer, 'sectionConfirmPolicies');
  if (rawPolicies !== undefined) {
    const pAcc = acc.scope('sectionConfirmPolicies');
    if (!isPlainRecord(rawPolicies)) {
      pAcc.add('', 'INVALID_TYPE', 'sectionConfirmPolicies must be a plain object');
    } else {
      for (const target of ['pc', 'npc'] as const) {
        const targetPolicies = getOwn(rawPolicies, target);
        if (targetPolicies !== undefined) {
          if (!isPlainRecord(targetPolicies)) {
            pAcc.add(target, 'INVALID_TYPE', `sectionConfirmPolicies.${target} must be a plain object`);
          } else {
            for (const secId of Object.getOwnPropertyNames(targetPolicies)) {
              if (!isSafeKey(secId)) {
                pAcc.add(`${target}.${secId}`, 'UNSAFE_KEY', `Forbidden key "${secId}"`);
                continue;
              }
              const policy = getOwn(targetPolicies, secId);
              pAcc.absorb(validateConfirmPolicy(policy as ConfirmPolicy, `${target}.${secId}`));
            }
          }
        }
      }
    }
  }

  const rawGameSystems = getOwn(rawLayer, 'gameSystems');
  if (rawGameSystems !== undefined) {
    if (!Array.isArray(rawGameSystems)) {
      acc.add('gameSystems', 'INVALID_TYPE', 'gameSystems must be an array');
    } else {
      const seenIds = new Set<string>();
      for (let i = 0; i < rawGameSystems.length; i += 1) {
        const mod = rawGameSystems[i] as GameSystemModule;
        acc.absorb(validateGameSystemModule(mod, `gameSystems[${i}]`));
        if (mod && typeof mod.id === 'string' && mod.id.trim().length > 0) {
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
      }
    }
  }

  const rawOverrides = getOwn(rawLayer, 'gameSystemOverrides');
  if (rawOverrides !== undefined) {
    const oAcc = acc.scope('gameSystemOverrides');
    if (!isPlainRecord(rawOverrides)) {
      oAcc.add('', 'INVALID_TYPE', 'gameSystemOverrides must be a plain object');
    } else {
      for (const modId of Object.getOwnPropertyNames(rawOverrides)) {
        const mAcc = oAcc.scope(modId);
        if (!isSafeKey(modId)) {
          mAcc.add('', 'UNSAFE_KEY', `Forbidden key "${modId}"`);
          continue;
        }
        const rawOverride = getOwn(rawOverrides, modId);
        if (!isPlainRecord(rawOverride)) {
          mAcc.add('', 'INVALID_TYPE', 'GameSystemModuleOverride must be a plain object');
          continue;
        }
        for (const strKey of ['name', 'description', 'trackerInstruction', 'narratorRule'] as const) {
          const val = getOwn(rawOverride, strKey);
          if (val !== undefined && typeof val !== 'string') {
            mAcc.add(strKey, 'INVALID_TYPE', `${strKey} must be a string`);
          }
        }
        for (const boolKey of ['enabled', 'createIfMissing'] as const) {
          const val = getOwn(rawOverride, boolKey);
          if (val !== undefined && typeof val !== 'boolean') {
            mAcc.add(boolKey, 'INVALID_TYPE', `${boolKey} must be a boolean`);
          }
        }
        const scope = getOwn(rawOverride, 'scope');
        if (scope !== undefined && !VALID_MODULE_SCOPES.has(String(scope))) {
          mAcc.add('scope', 'INVALID_SCOPE', `Invalid scope "${String(scope)}"`);
        }
        const target = getOwn(rawOverride, 'target');
        if (target !== undefined && !VALID_MODULE_TARGETS.has(String(target))) {
          mAcc.add('target', 'INVALID_TARGET', `Invalid target "${String(target)}"`);
        }
        const effectOwner = getOwn(rawOverride, 'effectOwner');
        if (effectOwner !== undefined && !VALID_EFFECT_OWNERS.has(String(effectOwner))) {
          mAcc.add(
            'effectOwner',
            'INVALID_EFFECT_OWNER',
            `Invalid effectOwner "${String(effectOwner)}"`
          );
        }
        const cadence = getOwn(rawOverride, 'cadence');
        if (cadence !== undefined) {
          mAcc.absorb(validateCadencePolicy(cadence as CadencePolicy, 'cadence'));
        }
        const fields = getOwn(rawOverride, 'fields');
        if (fields !== undefined) {
          if (!isPlainRecord(fields)) {
            mAcc.add('fields', 'INVALID_TYPE', 'fields must be a plain record');
          } else {
            for (const fieldKey of Object.getOwnPropertyNames(fields)) {
              if (!isSafeKey(fieldKey)) {
                mAcc.add(`fields.${fieldKey}`, 'UNSAFE_KEY', `Forbidden key "${fieldKey}"`);
                continue;
              }
              mAcc.absorb(
                validateDynamicFieldSpec(
                  getOwn(fields, fieldKey) as DynamicFieldSpec,
                  `fields.${fieldKey}`
                )
              );
            }
          }
        }
        const fieldPolicies = getOwn(rawOverride, 'fieldConfirmPolicies');
        if (fieldPolicies !== undefined) {
          if (!isPlainRecord(fieldPolicies)) {
            mAcc.add(
              'fieldConfirmPolicies',
              'INVALID_TYPE',
              'fieldConfirmPolicies must be a plain record'
            );
          } else {
            for (const fieldKey of Object.getOwnPropertyNames(fieldPolicies)) {
              if (!isSafeKey(fieldKey)) {
                mAcc.add(
                  `fieldConfirmPolicies.${fieldKey}`,
                  'UNSAFE_KEY',
                  `Forbidden key "${fieldKey}"`
                );
                continue;
              }
              mAcc.absorb(
                validateConfirmPolicy(
                  getOwn(fieldPolicies, fieldKey) as ConfirmPolicy,
                  `fieldConfirmPolicies.${fieldKey}`
                )
              );
            }
          }
        }
        const ui = getOwn(rawOverride, 'ui');
        if (ui !== undefined) {
          if (!isPlainRecord(ui)) {
            mAcc.add('ui', 'INVALID_TYPE', 'ui must be a plain object');
          } else {
            const widget = getOwn(ui, 'widget');
            if (widget !== undefined && !VALID_WIDGETS.has(String(widget))) {
              mAcc.add('ui.widget', 'INVALID_WIDGET', `Invalid ui.widget "${String(widget)}"`);
            }
            const order = getOwn(ui, 'order');
            if (order !== undefined && (typeof order !== 'number' || !Number.isFinite(order))) {
              mAcc.add('ui.order', 'INVALID_NUMBER', 'ui.order must be a finite number');
            }
          }
        }
      }
    }
  }

  const blockOrder = getOwn(rawLayer, 'blockOrder');
  if (blockOrder !== undefined) {
    validateStringArray(blockOrder, acc.scope('blockOrder'), 'blockOrder');
  }
  const syspromptSectionOrder = getOwn(rawLayer, 'syspromptSectionOrder');
  if (syspromptSectionOrder !== undefined) {
    validateStringArray(
      syspromptSectionOrder,
      acc.scope('syspromptSectionOrder'),
      'syspromptSectionOrder'
    );
  }
  const basePrompts = getOwn(rawLayer, 'basePrompts');
  if (basePrompts !== undefined) {
    validateStringRecord(basePrompts, acc.scope('basePrompts'), 'basePrompts');
  }
  const unlockedPromptSections = getOwn(rawLayer, 'unlockedPromptSections');
  if (unlockedPromptSections !== undefined) {
    validateBooleanRecord(
      unlockedPromptSections,
      acc.scope('unlockedPromptSections'),
      'unlockedPromptSections'
    );
  }

  const customBlocks = getOwn(rawLayer, 'customPromptBlocks');
  if (customBlocks !== undefined) {
    const cbAcc = acc.scope('customPromptBlocks');
    if (!isPlainRecord(customBlocks)) {
      cbAcc.add('', 'INVALID_TYPE', 'customPromptBlocks must be a plain object');
    } else {
      for (const blockKey of Object.getOwnPropertyNames(customBlocks)) {
        const bAcc = cbAcc.scope(blockKey);
        if (!isSafeKey(blockKey)) {
          bAcc.add('', 'UNSAFE_KEY', `Forbidden key "${blockKey}"`);
          continue;
        }
        const block = getOwn(customBlocks, blockKey);
        if (!isPlainRecord(block)) {
          bAcc.add('', 'INVALID_TYPE', 'CustomPromptBlockSpec must be a plain object');
          continue;
        }
        const bid = getOwn(block, 'id');
        if (typeof bid !== 'string' || bid.trim().length === 0) {
          bAcc.add('id', 'REQUIRED', 'CustomPromptBlockSpec.id must be a non-empty string');
        }
        const bname = getOwn(block, 'name');
        if (typeof bname !== 'string' || bname.trim().length === 0) {
          bAcc.add('name', 'REQUIRED', 'CustomPromptBlockSpec.name must be a non-empty string');
        }
        const role = getOwn(block, 'role');
        if (!VALID_CUSTOM_BLOCK_ROLES.has(String(role))) {
          bAcc.add('role', 'INVALID_ENUM', 'role must be system, user, or assistant');
        }
        const injPos = getOwn(block, 'injectionPosition');
        if (injPos !== undefined && !VALID_INJECTION_POSITIONS.has(String(injPos))) {
          bAcc.add(
            'injectionPosition',
            'INVALID_ENUM',
            'injectionPosition must be relative or in_chat'
          );
        }
        const injDepth = getOwn(block, 'injectionDepth');
        if (injDepth !== undefined && (typeof injDepth !== 'number' || !Number.isFinite(injDepth))) {
          bAcc.add('injectionDepth', 'INVALID_NUMBER', 'injectionDepth must be a finite number');
        }
      }
    }
  }

  const rawCombatRules = getOwn(rawLayer, 'combatRules');
  if (rawCombatRules !== undefined) {
    const crAcc = acc.scope('combatRules');
    if (!isPlainRecord(rawCombatRules)) {
      crAcc.add('', 'INVALID_TYPE', 'combatRules must be a plain object');
    } else {
      for (const boolKey of [
        'diceEnabled',
        'allowPartialActionSalvage',
        'fallbackTacticsEnabled',
      ] as const) {
        const val = getOwn(rawCombatRules, boolKey);
        if (val !== undefined && typeof val !== 'boolean') {
          crAcc.add(boolKey, 'INVALID_TYPE', `${boolKey} must be a boolean`);
        }
      }
      const diceMode = getOwn(rawCombatRules, 'diceMode');
      if (diceMode !== undefined && diceMode !== 'd20' && diceMode !== 'd100') {
        crAcc.add('diceMode', 'INVALID_ENUM', 'diceMode must be "d20" or "d100"');
      }
      const customRules = getOwn(rawCombatRules, 'customRules');
      if (customRules !== undefined) {
        validateStringRecord(customRules, crAcc.scope('customRules'), 'customRules');
      }
      const skillOverrides = getOwn(rawCombatRules, 'skillOverrides');
      if (skillOverrides !== undefined && !isPlainRecord(skillOverrides)) {
        crAcc.add('skillOverrides', 'INVALID_TYPE', 'skillOverrides must be a plain object');
      }
    }
  }

  const rawTuning = getOwn(rawLayer, 'tuningDials');
  if (rawTuning !== undefined) {
    const tdAcc = acc.scope('tuningDials');
    if (!isPlainRecord(rawTuning)) {
      tdAcc.add('', 'INVALID_TYPE', 'tuningDials must be a plain object');
    } else {
      const beatPressure = getOwn(rawTuning, 'beatPressure');
      if (beatPressure !== undefined && !VALID_BEAT_PRESSURES.has(beatPressure as BeatPressure)) {
        tdAcc.add('beatPressure', 'INVALID_ENUM', 'Invalid beatPressure');
      }
      const narrativePacing = getOwn(rawTuning, 'narrativePacing');
      if (
        narrativePacing !== undefined &&
        !VALID_NARRATIVE_PACINGS.has(narrativePacing as NarrativePacing)
      ) {
        tdAcc.add('narrativePacing', 'INVALID_ENUM', 'Invalid narrativePacing');
      }
      for (const boolKey of [
        'cyoaEnabled',
        'use24hTime',
        'useDdMmYyFormat',
        'autoRegisterEmergentNpcs',
      ] as const) {
        const val = getOwn(rawTuning, boolKey);
        if (val !== undefined && typeof val !== 'boolean') {
          tdAcc.add(boolKey, 'INVALID_TYPE', `${boolKey} must be a boolean`);
        }
      }
    }
  }

  const rawGen = getOwn(rawLayer, 'generation');
  if (rawGen !== undefined) {
    const gAcc = acc.scope('generation');
    if (!isPlainRecord(rawGen)) {
      gAcc.add('', 'INVALID_TYPE', 'generation must be a plain object');
    } else {
      const presetName = getOwn(rawGen, 'presetName');
      if (presetName !== undefined && typeof presetName !== 'string') {
        gAcc.add('presetName', 'INVALID_TYPE', 'presetName must be a string');
      }
      const genSourceFormat = getOwn(rawGen, 'sourceFormat');
      if (
        genSourceFormat !== undefined &&
        !VALID_GENERATION_SOURCE_FORMATS.has(genSourceFormat as GenerationSourceFormat)
      ) {
        gAcc.add('sourceFormat', 'INVALID_ENUM', 'Invalid generation sourceFormat');
      }
      for (const numKey of GENERATION_NUMERIC_FIELDS) {
        const val = getOwn(rawGen, numKey);
        if (val !== undefined && (typeof val !== 'number' || !Number.isFinite(val))) {
          gAcc.add(numKey, 'INVALID_NUMBER', `${numKey} must be a finite number`);
        }
      }
      const stopSeqs = getOwn(rawGen, 'stopSequences');
      if (stopSeqs !== undefined) {
        validateStringArray(stopSeqs, gAcc.scope('stopSequences'), 'stopSequences');
      }
      const templates = getOwn(rawGen, 'stFormatTemplates');
      if (templates !== undefined) {
        const tAcc = gAcc.scope('stFormatTemplates');
        if (!isPlainRecord(templates)) {
          tAcc.add('', 'INVALID_TYPE', 'stFormatTemplates must be a plain object');
        } else {
          for (const tplKey of ST_FORMAT_TEMPLATE_FIELDS) {
            const val = getOwn(templates, tplKey);
            if (val !== undefined && typeof val !== 'string') {
              tAcc.add(tplKey, 'INVALID_TYPE', `${tplKey} must be a string`);
            }
          }
        }
      }
    }
  }

  const rawBudgets = getOwn(rawLayer, 'tokenBudgets');
  if (rawBudgets !== undefined) {
    const tbAcc = acc.scope('tokenBudgets');
    if (!isPlainRecord(rawBudgets)) {
      tbAcc.add('', 'INVALID_TYPE', 'tokenBudgets must be a plain object');
    } else {
      for (const key of TOKEN_BUDGET_FIELDS) {
        const val = getOwn(rawBudgets, key);
        if (val !== undefined && (typeof val !== 'number' || !Number.isFinite(val))) {
          tbAcc.add(key, 'INVALID_NUMBER', `${key} must be a finite number`);
        }
      }
    }
  }
}

function validateSavedControlRoomPreset(
  raw: unknown,
  fallbackUpdatedAt?: string
): Result<SavedControlRoomPreset, ValidationError[]> {
  if (containsForbiddenKeys(raw)) {
    return err([
      validationError(
        '',
        'UNSAFE_KEY',
        'Forbidden prototype-polluting key in SavedControlRoomPreset'
      ),
    ]);
  }
  if (!isPlainRecord(raw)) {
    return err([
      validationError('', 'INVALID_TYPE', 'SavedControlRoomPreset must be a plain object'),
    ]);
  }

  const acc = new ErrorAccumulator();

  const rawId = getOwn(raw, 'id');
  const idRes = validateSafeStorageId(rawId as string);
  if (!idRes.ok) {
    acc.addAll(idRes.error);
  }

  const rawName = getOwn(raw, 'name');
  let name = '';
  if (typeof rawName !== 'string' || rawName.trim().length === 0) {
    acc.add('name', 'REQUIRED', 'Preset name must be a non-empty string');
  } else {
    name = rawName.trim();
  }

  const rawDescription = getOwn(raw, 'description');
  let description: string | undefined;
  if (rawDescription !== undefined) {
    if (typeof rawDescription !== 'string') {
      acc.add('description', 'INVALID_TYPE', 'Preset description must be a string');
    } else {
      description = rawDescription;
    }
  }

  const rawSourceFormat = getOwn(raw, 'sourceFormat');
  let sourceFormat: GenerationSourceFormat = 'referee';
  if (
    typeof rawSourceFormat !== 'string' ||
    !VALID_GENERATION_SOURCE_FORMATS.has(rawSourceFormat as GenerationSourceFormat)
  ) {
    acc.add(
      'sourceFormat',
      'INVALID_ENUM',
      'sourceFormat must be one of: referee, st_chat_completion, st_text_completion'
    );
  } else {
    sourceFormat = rawSourceFormat as GenerationSourceFormat;
  }

  const rawLayer = getOwn(raw, 'layer');
  validateControlRoomLayerValue(rawLayer, acc.scope('layer'));

  const rawUpdatedAt = getOwn(raw, 'updatedAt');
  let updatedAt = '';
  if (rawUpdatedAt === undefined) {
    if (fallbackUpdatedAt !== undefined) {
      updatedAt = fallbackUpdatedAt;
    } else {
      acc.add('updatedAt', 'REQUIRED', 'updatedAt must be a non-empty ISO timestamp string');
    }
  } else if (typeof rawUpdatedAt !== 'string' || rawUpdatedAt.trim().length === 0) {
    acc.add('updatedAt', 'INVALID_TYPE', 'updatedAt must be a non-empty ISO timestamp string');
  } else {
    updatedAt = rawUpdatedAt;
  }

  if (acc.hasErrors() || !idRes.ok) {
    return err([...acc.errors]);
  }

  return ok({
    id: idRes.value,
    name,
    ...(description !== undefined ? { description } : {}),
    sourceFormat,
    layer: cloneControlRoomLayer(rawLayer as ControlRoomLayer),
    updatedAt,
  });
}

async function atomicWriteJson(
  targetPath: string,
  payload: unknown
): Promise<Result<void, ValidationError[]>> {
  const parentDir = path.dirname(targetPath);
  const tmpPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  let handle: fs.FileHandle | undefined;

  try {
    await fs.mkdir(parentDir, { recursive: true });
    handle = await fs.open(tmpPath, 'w');
    await handle.writeFile(serialized, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(tmpPath, targetPath);
    return ok();
  } catch (caught) {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
    await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    return err([
      validationError(
        'filePath',
        'FILE_WRITE_ERROR',
        `Failed to write file "${targetPath}": ${formatFsError(caught, 'Unable to write file')}`
      ),
    ]);
  }
}

async function readAndParseJsonFile(
  filePath: string,
  notFoundMessage: string
): Promise<Result<unknown, ValidationError[]>> {
  let rawText: string;
  try {
    rawText = await fs.readFile(filePath, 'utf8');
  } catch (caught) {
    if (isEnoentError(caught)) {
      return err([validationError('id', 'NOT_FOUND', notFoundMessage)]);
    }
    return err([
      validationError(
        filePath,
        'FILE_READ_ERROR',
        `Failed to read file "${filePath}": ${formatFsError(caught, 'Unable to read file')}`
      ),
    ]);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText) as unknown;
  } catch (caught) {
    return err([
      validationError(
        filePath,
        'INVALID_JSON',
        `Failed to parse JSON in "${filePath}": ${formatFsError(caught, 'Malformed JSON')}`
      ),
    ]);
  }

  if (containsForbiddenKeys(parsed)) {
    return err([
      validationError(
        filePath,
        'UNSAFE_KEY',
        `Forbidden prototype-polluting key detected in "${filePath}"`
      ),
    ]);
  }

  return ok(parsed);
}

async function deleteContainedJsonFile(
  targetPath: string,
  notFoundMessage: string
): Promise<Result<void, ValidationError[]>> {
  try {
    await fs.unlink(targetPath);
    return ok();
  } catch (caught) {
    if (isEnoentError(caught)) {
      return err([validationError('id', 'NOT_FOUND', notFoundMessage)]);
    }
    return err([
      validationError(
        targetPath,
        'FILE_DELETE_ERROR',
        `Failed to delete file "${targetPath}": ${formatFsError(caught, 'Unable to delete file')}`
      ),
    ]);
  }
}

/**
 * Unified disk storage manager rooted at `dataDir` for Referee connections, presets,
 * personas, system packs, cartridge bundles, and save session discovery.
 */
export class RefereeDataStore {
  readonly rootDir: string;
  private readonly presetsDir: string;
  private readonly personasDir: string;
  private readonly systemPacksDir: string;
  private readonly cartridgesDir: string;
  private readonly savesDir: string;

  constructor(rootDir: string) {
    if (typeof rootDir !== 'string' || rootDir.trim().length === 0 || rootDir.includes('\0')) {
      throw new RefereeError('dataDir rootDir must be a non-empty valid path', {
        code: 'INVALID_DATA_DIR',
      });
    }
    this.rootDir = path.resolve(rootDir);
    this.presetsDir = path.join(this.rootDir, 'presets');
    this.personasDir = path.join(this.rootDir, 'personas');
    this.systemPacksDir = path.join(this.rootDir, 'system-packs');
    this.cartridgesDir = path.join(this.rootDir, 'cartridges');
    this.savesDir = path.join(this.rootDir, 'saves');
  }

  /**
   * Ensure the `dataDir` root and all standard collection subdirectories exist on disk.
   */
  async init(): Promise<Result<void, ValidationError[]>> {
    const dirs = [
      this.rootDir,
      this.presetsDir,
      this.personasDir,
      this.systemPacksDir,
      this.cartridgesDir,
      this.savesDir,
    ];
    try {
      for (const dir of dirs) {
        await fs.mkdir(dir, { recursive: true });
      }
      return ok();
    } catch (caught) {
      return err([
        validationError(
          'rootDir',
          'INIT_ERROR',
          `Failed to initialize dataDir "${this.rootDir}": ${formatFsError(caught, 'Unable to create directories')}`
        ),
      ]);
    }
  }

  /**
   * Return the absolute path to `<dataDir>/connections.json`.
   */
  getConnectionsPath(): string {
    return path.join(this.rootDir, 'connections.json');
  }

  /**
   * Load and validate `<dataDir>/connections.json`, delegating to `connection-store.ts`.
   */
  async loadConnections(): Promise<Result<ConnectionsFileDocument, ValidationError[]>> {
    return loadConnectionsFile(this.getConnectionsPath());
  }

  /**
   * Atomically validate and write `<dataDir>/connections.json`, delegating to `connection-store.ts`.
   */
  async saveConnections(doc: ConnectionsFileDocument): Promise<Result<void, ValidationError[]>> {
    return saveConnectionsFile(this.getConnectionsPath(), doc);
  }

  /**
   * List all valid saved Control Room presets under `presets/`, skipping corrupt files with warnings.
   */
  async listPresets(): Promise<StorageListResult<SavedControlRoomPreset>> {
    return this.listJsonCollection(
      this.presetsDir,
      '.json',
      (id) => this.getPreset(id),
      (item) => item.id
    );
  }

  /**
   * Load and validate a saved Control Room preset from `presets/<id>.json`.
   */
  async getPreset(id: string): Promise<Result<SavedControlRoomPreset, ValidationError[]>> {
    const pathRes = resolveContainedPath(this.presetsDir, id, '.json');
    if (!pathRes.ok) {
      return pathRes;
    }
    const parsedRes = await readAndParseJsonFile(pathRes.value, `Preset "${id}" not found`);
    if (!parsedRes.ok) {
      return parsedRes;
    }
    const validated = validateSavedControlRoomPreset(parsedRes.value);
    if (!validated.ok) {
      return validated;
    }
    if (validated.value.id !== id) {
      return err([
        validationError(
          'id',
          'ID_MISMATCH',
          `Preset id "${validated.value.id}" does not match filename id "${id}"`
        ),
      ]);
    }
    return validated;
  }

  /**
   * Validate and atomically save a Control Room preset to `presets/<id>.json`.
   */
  async savePreset(
    preset: SaveControlRoomPresetInput
  ): Promise<Result<SavedControlRoomPreset, ValidationError[]>> {
    const validated = validateSavedControlRoomPreset(preset, new Date().toISOString());
    if (!validated.ok) {
      return validated;
    }
    const pathRes = resolveContainedPath(this.presetsDir, validated.value.id, '.json');
    if (!pathRes.ok) {
      return pathRes;
    }
    const writeRes = await atomicWriteJson(pathRes.value, validated.value);
    if (!writeRes.ok) {
      return writeRes;
    }
    return ok(validated.value);
  }

  /**
   * Delete a saved Control Room preset from `presets/<id>.json`.
   */
  async deletePreset(id: string): Promise<Result<void, ValidationError[]>> {
    const pathRes = resolveContainedPath(this.presetsDir, id, '.json');
    if (!pathRes.ok) {
      return pathRes;
    }
    return deleteContainedJsonFile(pathRes.value, `Preset "${id}" not found`);
  }

  /**
   * List all valid saved user persona presets under `personas/`, skipping corrupt files with warnings.
   */
  async listPersonas(): Promise<StorageListResult<UserPersonaPreset>> {
    return this.listJsonCollection(
      this.personasDir,
      '.json',
      (id) => this.getPersona(id),
      (item) => item.id
    );
  }

  /**
   * Load and validate a user persona preset from `personas/<id>.json`.
   */
  async getPersona(id: string): Promise<Result<UserPersonaPreset, ValidationError[]>> {
    const pathRes = resolveContainedPath(this.personasDir, id, '.json');
    if (!pathRes.ok) {
      return pathRes;
    }
    const parsedRes = await readAndParseJsonFile(pathRes.value, `Persona "${id}" not found`);
    if (!parsedRes.ok) {
      return parsedRes;
    }
    const validated = validateUserPersonaPreset(parsedRes.value);
    if (!validated.ok) {
      return validated;
    }
    if (validated.value.id !== id) {
      return err([
        validationError(
          'id',
          'ID_MISMATCH',
          `Persona id "${validated.value.id}" does not match filename id "${id}"`
        ),
      ]);
    }
    return validated;
  }

  /**
   * Validate and atomically save a user persona preset to `personas/<id>.json`.
   */
  async savePersona(
    persona: UserPersonaPreset
  ): Promise<Result<UserPersonaPreset, ValidationError[]>> {
    if (containsForbiddenKeys(persona)) {
      return err([
        validationError(
          '',
          'UNSAFE_KEY',
          'Forbidden prototype-polluting key in UserPersonaPreset'
        ),
      ]);
    }
    if (!isPlainRecord(persona)) {
      return err([
        validationError('', 'INVALID_TYPE', 'UserPersonaPreset must be a plain object'),
      ]);
    }

    const rawId = getOwn(persona, 'id');
    const idCheck = validateSafeStorageId(rawId as string);
    if (!idCheck.ok) {
      return idCheck;
    }

    const candidate: UserPersonaPreset = {
      ...persona,
      updatedAt:
        persona.updatedAt !== undefined ? persona.updatedAt : new Date().toISOString(),
    };
    if (
      typeof candidate.updatedAt !== 'string' ||
      candidate.updatedAt.trim().length === 0
    ) {
      return err([
        validationError('updatedAt', 'INVALID_TYPE', 'updatedAt must be a non-empty string'),
      ]);
    }

    const validated = validateUserPersonaPreset(candidate);
    if (!validated.ok) {
      return validated;
    }
    const pathRes = resolveContainedPath(this.personasDir, validated.value.id, '.json');
    if (!pathRes.ok) {
      return pathRes;
    }
    const writeRes = await atomicWriteJson(pathRes.value, validated.value);
    if (!writeRes.ok) {
      return writeRes;
    }
    return ok(cloneUserPersonaPreset(validated.value));
  }

  /**
   * Delete a user persona preset from `personas/<id>.json`.
   */
  async deletePersona(id: string): Promise<Result<void, ValidationError[]>> {
    const pathRes = resolveContainedPath(this.personasDir, id, '.json');
    if (!pathRes.ok) {
      return pathRes;
    }
    return deleteContainedJsonFile(pathRes.value, `Persona "${id}" not found`);
  }

  /**
   * List all valid custom system packs under `system-packs/`, skipping corrupt files with warnings.
   */
  async listSystemPacks(): Promise<StorageListResult<SystemPack>> {
    return this.listJsonCollection(
      this.systemPacksDir,
      '.json',
      (id) => this.getSystemPack(id),
      (item) => item.id
    );
  }

  /**
   * Load and validate a custom system pack from `system-packs/<id>.json`.
   */
  async getSystemPack(id: string): Promise<Result<SystemPack, ValidationError[]>> {
    const pathRes = resolveContainedPath(this.systemPacksDir, id, '.json');
    if (!pathRes.ok) {
      return pathRes;
    }
    const parsedRes = await readAndParseJsonFile(pathRes.value, `SystemPack "${id}" not found`);
    if (!parsedRes.ok) {
      return parsedRes;
    }
    const validated = parseAndValidateSystemPack(parsedRes.value);
    if (!validated.ok) {
      return validated;
    }
    if (validated.value.id !== id) {
      return err([
        validationError(
          'id',
          'ID_MISMATCH',
          `SystemPack id "${validated.value.id}" does not match filename id "${id}"`
        ),
      ]);
    }
    return validated;
  }

  /**
   * Validate and atomically save a custom system pack to `system-packs/<id>.json`.
   */
  async saveSystemPack(pack: SystemPack): Promise<Result<SystemPack, ValidationError[]>> {
    if (containsForbiddenKeys(pack)) {
      return err([
        validationError('', 'UNSAFE_KEY', 'Forbidden prototype-polluting key in SystemPack'),
      ]);
    }
    if (!isPlainRecord(pack)) {
      return err([validationError('', 'INVALID_TYPE', 'SystemPack must be a plain object')]);
    }

    const idCheck = validateSafeStorageId(getOwn(pack, 'id') as string);
    if (!idCheck.ok) {
      return idCheck;
    }

    const validated = parseAndValidateSystemPack(pack);
    if (!validated.ok) {
      return validated;
    }

    const pathRes = resolveContainedPath(this.systemPacksDir, validated.value.id, '.json');
    if (!pathRes.ok) {
      return pathRes;
    }
    const writeRes = await atomicWriteJson(pathRes.value, validated.value);
    if (!writeRes.ok) {
      return writeRes;
    }
    return ok(cloneSystemPack(validated.value));
  }

  /**
   * Delete a custom system pack from `system-packs/<id>.json`.
   */
  async deleteSystemPack(id: string): Promise<Result<void, ValidationError[]>> {
    const pathRes = resolveContainedPath(this.systemPacksDir, id, '.json');
    if (!pathRes.ok) {
      return pathRes;
    }
    return deleteContainedJsonFile(pathRes.value, `SystemPack "${id}" not found`);
  }

  /**
   * List all valid cartridge bundles under `cartridges/`, skipping corrupt files with warnings.
   */
  async listCartridges(): Promise<StorageListResult<CartridgeBundle>> {
    return this.listJsonCollection(
      this.cartridgesDir,
      '.bundle.json',
      (id) => this.getCartridgeBundle(id),
      (item) => item.card.id
    );
  }

  /**
   * Load and validate a cartridge bundle from `cartridges/<id>.bundle.json`.
   */
  async getCartridgeBundle(id: string): Promise<Result<CartridgeBundle, ValidationError[]>> {
    const pathRes = resolveContainedPath(this.cartridgesDir, id, '.bundle.json');
    if (!pathRes.ok) {
      return pathRes;
    }
    const parsedRes = await readAndParseJsonFile(
      pathRes.value,
      `Cartridge bundle "${id}" not found`
    );
    if (!parsedRes.ok) {
      return parsedRes;
    }
    const sanitized = sanitizeJsonValue(parsedRes.value) as CartridgeBundle;
    const validated = validateCartridgeStructure(sanitized);
    if (!validated.ok) {
      return validated;
    }
    if (validated.value.card.id !== id) {
      return err([
        validationError(
          'card.id',
          'ID_MISMATCH',
          `Cartridge card.id "${validated.value.card.id}" does not match filename id "${id}"`
        ),
      ]);
    }
    return ok(validated.value);
  }

  /**
   * Validate and atomically save a cartridge bundle to `cartridges/<id>.bundle.json`.
   */
  async saveCartridgeBundle(
    bundle: CartridgeBundle
  ): Promise<Result<CartridgeBundle, ValidationError[]>> {
    if (containsForbiddenKeys(bundle)) {
      return err([
        validationError('', 'UNSAFE_KEY', 'Forbidden prototype-polluting key in CartridgeBundle'),
      ]);
    }
    if (!isPlainRecord(bundle)) {
      return err([
        validationError('', 'INVALID_TYPE', 'CartridgeBundle must be a plain object'),
      ]);
    }

    const rawCard = getOwn(bundle, 'card');
    if (!isPlainRecord(rawCard)) {
      return err([
        validationError('card', 'INVALID_TYPE', 'CartridgeBundle.card must be a plain object'),
      ]);
    }

    const idCheck = validateSafeStorageId(getOwn(rawCard, 'id') as string);
    if (!idCheck.ok) {
      return idCheck;
    }

    const sanitized = sanitizeJsonValue(bundle) as CartridgeBundle;
    const validated = validateCartridgeStructure(sanitized);
    if (!validated.ok) {
      return validated;
    }

    const pathRes = resolveContainedPath(this.cartridgesDir, validated.value.card.id, '.bundle.json');
    if (!pathRes.ok) {
      return pathRes;
    }
    const writeRes = await atomicWriteJson(pathRes.value, validated.value);
    if (!writeRes.ok) {
      return writeRes;
    }
    return ok(validated.value);
  }

  /**
   * Delete a cartridge bundle from `cartridges/<id>.bundle.json`.
   */
  async deleteCartridgeBundle(id: string): Promise<Result<void, ValidationError[]>> {
    const pathRes = resolveContainedPath(this.cartridgesDir, id, '.bundle.json');
    if (!pathRes.ok) {
      return pathRes;
    }
    return deleteContainedJsonFile(pathRes.value, `Cartridge bundle "${id}" not found`);
  }

  /**
   * Resolve and validate the directory path for a session's save folder under `saves/<sessionId>/`.
   */
  getSessionSaveDir(sessionId: string): Result<string, ValidationError[]> {
    return resolveContainedPath(this.savesDir, sessionId, '');
  }

  /**
   * Discover saved session IDs under `saves/`, skipping non-directories and invalid names with warnings.
   */
  async listSavedSessionIds(): Promise<StorageListResult<string>> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(this.savesDir, { withFileTypes: true });
    } catch (caught) {
      if (isEnoentError(caught)) {
        return { items: [], warnings: [] };
      }
      return {
        items: [],
        warnings: [
          validationError(
            this.savesDir,
            'FILE_READ_ERROR',
            `Failed to read saves directory "${this.savesDir}": ${formatFsError(caught, 'Unable to read directory')}`
          ),
        ],
      };
    }

    const items: string[] = [];
    const warnings: ValidationError[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const idRes = validateSafeStorageId(entry.name);
      if (!idRes.ok) {
        for (const w of idRes.error) {
          warnings.push(validationError(`saves/${entry.name}`, w.code, w.message));
        }
        continue;
      }
      items.push(idRes.value);
    }

    items.sort(compareStringsDeterministic);
    return { items, warnings };
  }

  private async listJsonCollection<T>(
    dirPath: string,
    suffix: string,
    loader: (id: string) => Promise<Result<T, ValidationError[]>>,
    getId: (item: T) => string
  ): Promise<StorageListResult<T>> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch (caught) {
      if (isEnoentError(caught)) {
        return { items: [], warnings: [] };
      }
      return {
        items: [],
        warnings: [
          validationError(
            dirPath,
            'FILE_READ_ERROR',
            `Failed to read directory "${dirPath}": ${formatFsError(caught, 'Unable to read directory')}`
          ),
        ],
      };
    }

    const items: T[] = [];
    const warnings: ValidationError[] = [];
    const sortedNames = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
      .map((entry) => entry.name)
      .sort(compareStringsDeterministic);

    for (const fileName of sortedNames) {
      const id = fileName.slice(0, -suffix.length);
      const idRes = validateSafeStorageId(id);
      if (!idRes.ok) {
        for (const w of idRes.error) {
          warnings.push(validationError(fileName, w.code, w.message));
        }
        continue;
      }

      const loadRes = await loader(idRes.value);
      if (!loadRes.ok) {
        for (const w of loadRes.error) {
          warnings.push(validationError(fileName, w.code, w.message));
        }
        continue;
      }
      items.push(loadRes.value);
    }

    items.sort((a, b) => compareStringsDeterministic(getId(a), getId(b)));
    return { items, warnings };
  }
}
