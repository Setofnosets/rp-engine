import {
  type BeatDefinition,
  validateBeatDefinitions,
} from '../beats/beat-ledger.js';
import {
  type EndingDefinition,
  type RouteDefinition,
  validateRoutesAndEndings,
} from '../beats/routes-and-endings.js';
import {
  type EffectTemplate,
  validateEffectTemplate,
} from '../combat/effect-templates.js';
import {
  type SkillDefinition,
  validateSkillCatalog,
} from '../combat/skill-registry.js';
import {
  type CombatFormLoadout,
  type SummonTemplate,
} from '../combat/summons-and-transforms.js';
import { type TraditionalTurnStyle } from '../combat/traditional-theater.js';
import {
  type BeatPressure,
  type ControlRoomLayer,
  type NarrativePacing,
} from '../config/control-room-config.js';
import { type ValidationError, validationError } from '../core/errors.js';
import { ErrorAccumulator, type Result, err, ok } from '../core/result.js';
import { parseIsoDate } from '../core/world-clock.js';
import {
  type ScriptManifest,
  validateScriptManifest,
} from '../sandbox/capabilities.js';
import { validateCharacterSectionList } from '../schema/character-sections.js';
import {
  type CharacterSectionDef,
} from '../schema/character-sections.js';
import {
  type ClockMode,
  type CombatMode,
  type DynamicFieldSpec,
  type GameSystemModule,
  type ProgressionMode,
  type SpatialMode,
  validateCadencePolicy,
  validateConfirmPolicy,
  validateDynamicFieldSpec,
  validateGameSystemModule,
  validateSystemCapabilities,
} from '../schema/tracker-module.js';
import { validateCharacterCardSheet } from '../state/character-card-sheet.js';
import { type FormDefinition } from '../state/forms.js';
import { type LocationEntity } from '../state/spatial-topology.js';
import {
  CHARACTER_STATUSES,
  CHRONICLE_CATEGORIES,
  ENDING_STATUSES,
  FACTION_SIDES,
  FACTION_STATUSES,
  THREAT_RANKS,
  THREAT_STATUSES,
  WORLD_ARCS,
  type CharacterEntity,
  type FactionEntity,
  type ThreatEntity,
  type WorldState,
} from '../state/world-state.js';
import { type AgendaConfig, validateAgendaConfig } from '../world/agendas.js';

export interface CartridgePersonaSpec {
  name: string;
  description: string;
  scenario?: string;
  firstMessage?: string;
  systemPrompt?: string;
}

export interface CartridgeCardSpec {
  spec: 'cartridge/0.1';
  id: string;
  version: string;
  title: string;
  author?: string;
  description: string;
  recommendedSystemPack?: string;
  persona: CartridgePersonaSpec;
  scripts?: readonly ScriptManifest[];
  importsStateFrom?: readonly string[];
}

export interface CartridgeInitialEntities {
  characters?: Record<string, CharacterEntity>;
  factions?: Record<string, FactionEntity>;
  threats?: Record<string, ThreatEntity>;
  locations?: Record<string, LocationEntity>;
  forms?: readonly FormDefinition[];
}

export interface CartridgeCombatConfig {
  skills?: readonly SkillDefinition[];
  turnStyle?: TraditionalTurnStyle;
  summons?: Record<string, SummonTemplate>;
  formLoadouts?: Record<string, CombatFormLoadout>;
  effectTemplates?: Record<string, EffectTemplate>;
}

export interface CartridgeBundle {
  rootDir: string | null;
  card: CartridgeCardSpec;
  systemOverrides?: ControlRoomLayer;
  initialState?: Partial<WorldState>;
  initialEntities?: CartridgeInitialEntities;
  agendas?: AgendaConfig;
  combat?: CartridgeCombatConfig;
  beats: BeatDefinition[];
  routes: RouteDefinition[];
  endings: EndingDefinition[];
  loreFiles: Record<string, string>;
  endingPromptFiles: Record<string, string>;
  scriptFiles: Record<string, string>;
  binaryAssets?: Record<string, Uint8Array>;
}

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
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
const VALID_EFFECT_OWNERS: ReadonlySet<string> = new Set([
  'engine',
  'tracker',
  'hybrid',
]);
const VALID_WIDGETS: ReadonlySet<string> = new Set([
  'bar',
  'badge',
  'tags',
  'card',
  'hidden',
]);
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
const VALID_CHARACTER_STATUSES: ReadonlySet<string> = new Set(CHARACTER_STATUSES);
const VALID_FACTION_SIDES: ReadonlySet<string> = new Set(FACTION_SIDES);
const VALID_FACTION_STATUSES: ReadonlySet<string> = new Set(FACTION_STATUSES);
const VALID_THREAT_RANKS: ReadonlySet<string> = new Set(THREAT_RANKS);
const VALID_THREAT_STATUSES: ReadonlySet<string> = new Set(THREAT_STATUSES);
const VALID_WORLD_ARCS: ReadonlySet<string> = new Set(WORLD_ARCS);
const VALID_ENDING_STATUSES: ReadonlySet<string> = new Set(ENDING_STATUSES);
const VALID_CHRONICLE_CATEGORIES: ReadonlySet<string> = new Set(CHRONICLE_CATEGORIES);
const VALID_ROLE_COLLECTIONS: ReadonlySet<string> = new Set([
  'characters',
  'factions',
  'locations',
]);

export function isUnsafeRecordKey(key: string): boolean {
  return FORBIDDEN_KEYS.has(key);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

export function setSafeProperty<T>(
  record: Record<string, T>,
  key: string,
  value: T
): void {
  if (isUnsafeRecordKey(key)) {
    return;
  }
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

export function getSafeProperty<T>(
  record: Readonly<Record<string, T>>,
  key: string
): T | undefined {
  if (isUnsafeRecordKey(key) || !Object.hasOwn(record, key)) {
    return undefined;
  }
  return Object.getOwnPropertyDescriptor(record, key)?.value as T | undefined;
}

export function isSafeAssetPath(assetPath: string): boolean {
  if (typeof assetPath !== 'string' || assetPath.length === 0) {
    return false;
  }
  if (assetPath.includes('\\') || assetPath.startsWith('/') || /^[a-zA-Z]:/.test(assetPath)) {
    return false;
  }
  if (!assetPath.startsWith('assets/')) {
    return false;
  }
  const segments = assetPath.split('/');
  if (segments.length < 2) {
    return false;
  }
  for (const seg of segments) {
    if (seg.length === 0 || seg === '.' || seg === '..' || isUnsafeRecordKey(seg)) {
      return false;
    }
  }
  return true;
}

function validateBinaryAssetsField(
  rawAssets: unknown,
  acc: ErrorAccumulator
): void {
  if (rawAssets === undefined) {
    return;
  }
  if (!isPlainObject(rawAssets)) {
    acc.add('', 'INVALID_TYPE', 'binaryAssets must be a plain object');
    return;
  }
  for (const key of Object.getOwnPropertyNames(rawAssets)) {
    if (isUnsafeRecordKey(key)) {
      acc.add(key, 'UNSAFE_PROPERTY_KEY', `Forbidden key "${key}" in binaryAssets`);
      continue;
    }
    if (!isSafeAssetPath(key)) {
      acc.add(
        key,
        'UNSAFE_ASSET_PATH',
        `Binary asset path "${key}" must be a safe relative path under "assets/"`
      );
      continue;
    }
    const val = Object.getOwnPropertyDescriptor(rawAssets, key)?.value;
    if (!(val instanceof Uint8Array)) {
      acc.add(key, 'INVALID_TYPE', `binaryAssets["${key}"] must be a Uint8Array`);
    }
  }
}

export function scanObjectForUnsafeKeys(
  value: unknown,
  acc: ErrorAccumulator
): void {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      scanObjectForUnsafeKeys(value[i], acc.scope(`[${i}]`));
    }
    return;
  }
  if (value === null || typeof value !== 'object') {
    return;
  }
  if (!isPlainObject(value)) {
    return;
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    if (isUnsafeRecordKey(key)) {
      acc.add(key, 'UNSAFE_PROPERTY_KEY', `Forbidden prototype property key "${key}"`);
      continue;
    }
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (desc !== undefined) {
      scanObjectForUnsafeKeys(desc.value, acc.scope(key));
    }
  }
}

function validateNonEmptySafeId(
  value: unknown,
  path: string,
  acc: ErrorAccumulator,
  code = 'REQUIRED'
): value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    acc.add(path, code, `${path || 'id'} must be a non-empty string`);
    return false;
  }
  if (isUnsafeRecordKey(value.trim())) {
    acc.add(path, 'UNSAFE_PROPERTY_KEY', `Forbidden prototype key "${value}"`);
    return false;
  }
  return true;
}

function validateStringRecordField(
  raw: unknown,
  acc: ErrorAccumulator,
  label: string
): void {
  if (!isPlainObject(raw)) {
    acc.add('', 'INVALID_TYPE', `${label} must be a plain string record`);
    return;
  }
  for (const key of Object.getOwnPropertyNames(raw)) {
    if (isUnsafeRecordKey(key)) {
      acc.add(key, 'UNSAFE_PROPERTY_KEY', `Forbidden key "${key}" in ${label}`);
      continue;
    }
    const val = Object.getOwnPropertyDescriptor(raw, key)?.value;
    if (typeof val !== 'string') {
      acc.add(key, 'INVALID_TYPE', `${label}.${key} must be a string`);
    }
  }
}

function validateBooleanRecordField(
  raw: unknown,
  acc: ErrorAccumulator,
  label: string
): void {
  if (!isPlainObject(raw)) {
    acc.add('', 'INVALID_TYPE', `${label} must be a plain boolean record`);
    return;
  }
  for (const key of Object.getOwnPropertyNames(raw)) {
    if (isUnsafeRecordKey(key)) {
      acc.add(key, 'UNSAFE_PROPERTY_KEY', `Forbidden key "${key}" in ${label}`);
      continue;
    }
    const val = Object.getOwnPropertyDescriptor(raw, key)?.value;
    if (typeof val !== 'boolean') {
      acc.add(key, 'INVALID_TYPE', `${label}.${key} must be a boolean`);
    }
  }
}

function validateNumberRecordField(
  raw: unknown,
  acc: ErrorAccumulator,
  label: string
): void {
  if (!isPlainObject(raw)) {
    acc.add('', 'INVALID_TYPE', `${label} must be a plain number record`);
    return;
  }
  for (const key of Object.getOwnPropertyNames(raw)) {
    if (isUnsafeRecordKey(key)) {
      acc.add(key, 'UNSAFE_PROPERTY_KEY', `Forbidden key "${key}" in ${label}`);
      continue;
    }
    const val = Object.getOwnPropertyDescriptor(raw, key)?.value;
    if (typeof val !== 'number' || !Number.isFinite(val)) {
      acc.add(key, 'INVALID_NUMBER', `${label}.${key} must be a finite number`);
    }
  }
}

function validateStringArray(
  raw: unknown,
  acc: ErrorAccumulator,
  label: string,
  requireNonEmpty = false
): void {
  if (!Array.isArray(raw)) {
    acc.add('', 'INVALID_TYPE', `${label} must be an array of strings`);
    return;
  }
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    if (typeof item !== 'string') {
      acc.add(`[${i}]`, 'INVALID_TYPE', `${label}[${i}] must be a string`);
    } else if (requireNonEmpty && item.trim().length === 0) {
      acc.add(`[${i}]`, 'REQUIRED', `${label}[${i}] must be a non-empty string`);
    }
  }
}

function validateCardSpec(rawCard: unknown, acc: ErrorAccumulator): void {
  if (!isPlainObject(rawCard)) {
    acc.add('', 'INVALID_TYPE', 'card must be a non-null plain object');
    return;
  }

  if (rawCard['spec'] !== 'cartridge/0.1') {
    acc.add('spec', 'INVALID_SPEC', `Unsupported cartridge spec "${String(rawCard['spec'])}"`);
  }

  validateNonEmptySafeId(rawCard['id'], 'id', acc);

  if (typeof rawCard['version'] !== 'string' || rawCard['version'].trim().length === 0) {
    acc.add('version', 'REQUIRED', 'card.version must be a non-empty string');
  }
  if (typeof rawCard['title'] !== 'string' || rawCard['title'].trim().length === 0) {
    acc.add('title', 'REQUIRED', 'card.title must be a non-empty string');
  }
  if (rawCard['author'] !== undefined && typeof rawCard['author'] !== 'string') {
    acc.add('author', 'INVALID_TYPE', 'card.author must be a string when specified');
  }
  if (typeof rawCard['description'] !== 'string') {
    acc.add('description', 'INVALID_TYPE', 'card.description must be a string');
  }
  if (rawCard['recommendedSystemPack'] !== undefined) {
    if (
      typeof rawCard['recommendedSystemPack'] !== 'string' ||
      rawCard['recommendedSystemPack'].trim().length === 0
    ) {
      acc.add(
        'recommendedSystemPack',
        'REQUIRED',
        'card.recommendedSystemPack must be a non-empty string when specified'
      );
    } else if (isUnsafeRecordKey(rawCard['recommendedSystemPack'].trim())) {
      acc.add(
        'recommendedSystemPack',
        'UNSAFE_PROPERTY_KEY',
        `Forbidden recommendedSystemPack "${rawCard['recommendedSystemPack']}"`
      );
    }
  }

  const rawPersona = rawCard['persona'];
  if (!isPlainObject(rawPersona)) {
    acc.add('persona', 'INVALID_TYPE', 'card.persona must be a plain object');
  } else {
    const pAcc = acc.scope('persona');
    if (typeof rawPersona['name'] !== 'string' || rawPersona['name'].trim().length === 0) {
      pAcc.add('name', 'REQUIRED', 'persona.name must be a non-empty string');
    }
    if (typeof rawPersona['description'] !== 'string') {
      pAcc.add('description', 'INVALID_TYPE', 'persona.description must be a string');
    }
    if (rawPersona['scenario'] !== undefined && typeof rawPersona['scenario'] !== 'string') {
      pAcc.add('scenario', 'INVALID_TYPE', 'persona.scenario must be a string');
    }
    if (
      rawPersona['firstMessage'] !== undefined &&
      typeof rawPersona['firstMessage'] !== 'string'
    ) {
      pAcc.add('firstMessage', 'INVALID_TYPE', 'persona.firstMessage must be a string');
    }
    if (
      rawPersona['systemPrompt'] !== undefined &&
      typeof rawPersona['systemPrompt'] !== 'string'
    ) {
      pAcc.add('systemPrompt', 'INVALID_TYPE', 'persona.systemPrompt must be a string');
    }
  }

  if (rawCard['scripts'] !== undefined) {
    if (!Array.isArray(rawCard['scripts'])) {
      acc.add('scripts', 'INVALID_TYPE', 'card.scripts must be an array');
    } else {
      const seenScriptIds = new Set<string>();
      for (let i = 0; i < rawCard['scripts'].length; i += 1) {
        const manifest = rawCard['scripts'][i] as ScriptManifest;
        const mScope = acc.scope(`scripts[${i}]`);
        mScope.absorb(validateScriptManifest(manifest));
        if (
          manifest !== null &&
          typeof manifest === 'object' &&
          typeof manifest.scriptId === 'string' &&
          manifest.scriptId.trim().length > 0
        ) {
          if (isUnsafeRecordKey(manifest.scriptId.trim())) {
            mScope.add('scriptId', 'UNSAFE_PROPERTY_KEY', `Forbidden scriptId "${manifest.scriptId}"`);
          } else if (seenScriptIds.has(manifest.scriptId)) {
            mScope.add('scriptId', 'DUPLICATE_ID', `Duplicate scriptId "${manifest.scriptId}"`);
          } else {
            seenScriptIds.add(manifest.scriptId);
          }
        }
      }
    }
  }

  if (rawCard['importsStateFrom'] !== undefined) {
    validateStringArray(
      rawCard['importsStateFrom'],
      acc.scope('importsStateFrom'),
      'importsStateFrom',
      true
    );
  }
}

function validateControlRoomLayerField(
  rawLayer: unknown,
  acc: ErrorAccumulator
): void {
  if (!isPlainObject(rawLayer)) {
    acc.add('', 'INVALID_TYPE', 'systemOverrides must be a plain object');
    return;
  }

  if (rawLayer['capabilities'] !== undefined) {
    const caps = rawLayer['capabilities'];
    const cAcc = acc.scope('capabilities');
    if (!isPlainObject(caps)) {
      cAcc.add('', 'INVALID_TYPE', 'capabilities must be a plain object');
    } else {
      if (
        caps['spatialMode'] !== undefined &&
        !VALID_SPATIAL_MODES.has(caps['spatialMode'] as SpatialMode)
      ) {
        cAcc.add('spatialMode', 'INVALID_CAPABILITY', 'Invalid spatialMode');
      }
      if (
        caps['combatMode'] !== undefined &&
        !VALID_COMBAT_MODES.has(caps['combatMode'] as CombatMode)
      ) {
        cAcc.add('combatMode', 'INVALID_CAPABILITY', 'Invalid combatMode');
      }
      if (
        caps['progression'] !== undefined &&
        !VALID_PROGRESSION_MODES.has(caps['progression'] as ProgressionMode)
      ) {
        cAcc.add('progression', 'INVALID_CAPABILITY', 'Invalid progression mode');
      }
      if (caps['clocks'] !== undefined && !VALID_CLOCK_MODES.has(caps['clocks'] as ClockMode)) {
        cAcc.add('clocks', 'INVALID_CAPABILITY', 'Invalid clocks mode');
      }
      for (const boolKey of ['factions', 'beats', 'relationships', 'chronicle'] as const) {
        if (caps[boolKey] !== undefined && typeof caps[boolKey] !== 'boolean') {
          cAcc.add(boolKey, 'INVALID_TYPE', `${boolKey} capability must be a boolean`);
        }
      }
    }
  }

  if (rawLayer['pcCoreSections'] !== undefined) {
    acc.absorb(
      validateCharacterSectionList(
        rawLayer['pcCoreSections'] as CharacterSectionDef[],
        'pcCoreSections'
      )
    );
  }
  if (rawLayer['npcCoreSections'] !== undefined) {
    acc.absorb(
      validateCharacterSectionList(
        rawLayer['npcCoreSections'] as CharacterSectionDef[],
        'npcCoreSections'
      )
    );
  }

  if (rawLayer['sectionConfirmPolicies'] !== undefined) {
    const policies = rawLayer['sectionConfirmPolicies'];
    const pAcc = acc.scope('sectionConfirmPolicies');
    if (!isPlainObject(policies)) {
      pAcc.add('', 'INVALID_TYPE', 'sectionConfirmPolicies must be a plain object');
    } else {
      for (const target of ['pc', 'npc'] as const) {
        const targetPolicies = policies[target];
        if (targetPolicies !== undefined) {
          if (!isPlainObject(targetPolicies)) {
            pAcc.add(target, 'INVALID_TYPE', `sectionConfirmPolicies.${target} must be a plain object`);
          } else {
            for (const [secId, policy] of Object.entries(targetPolicies)) {
              pAcc.absorb(
                validateConfirmPolicy(
                  policy as Parameters<typeof validateConfirmPolicy>[0],
                  `${target}.${secId}`
                )
              );
            }
          }
        }
      }
    }
  }

  if (rawLayer['gameSystems'] !== undefined) {
    if (!Array.isArray(rawLayer['gameSystems'])) {
      acc.add('gameSystems', 'INVALID_TYPE', 'gameSystems must be an array');
    } else {
      const seenIds = new Set<string>();
      for (let i = 0; i < rawLayer['gameSystems'].length; i += 1) {
        const mod = rawLayer['gameSystems'][i] as GameSystemModule;
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

  if (rawLayer['gameSystemOverrides'] !== undefined) {
    const overrides = rawLayer['gameSystemOverrides'];
    const oAcc = acc.scope('gameSystemOverrides');
    if (!isPlainObject(overrides)) {
      oAcc.add('', 'INVALID_TYPE', 'gameSystemOverrides must be a plain object');
    } else {
      for (const [modId, rawOverride] of Object.entries(overrides)) {
        const mAcc = oAcc.scope(modId);
        if (!isPlainObject(rawOverride)) {
          mAcc.add('', 'INVALID_TYPE', 'GameSystemModuleOverride must be a plain object');
          continue;
        }
        if (rawOverride['name'] !== undefined && typeof rawOverride['name'] !== 'string') {
          mAcc.add('name', 'INVALID_TYPE', 'name must be a string');
        }
        if (
          rawOverride['description'] !== undefined &&
          typeof rawOverride['description'] !== 'string'
        ) {
          mAcc.add('description', 'INVALID_TYPE', 'description must be a string');
        }
        if (rawOverride['enabled'] !== undefined && typeof rawOverride['enabled'] !== 'boolean') {
          mAcc.add('enabled', 'INVALID_TYPE', 'enabled must be a boolean');
        }
        if (
          rawOverride['scope'] !== undefined &&
          !VALID_MODULE_SCOPES.has(String(rawOverride['scope']))
        ) {
          mAcc.add('scope', 'INVALID_SCOPE', `Invalid scope "${String(rawOverride['scope'])}"`);
        }
        if (
          rawOverride['target'] !== undefined &&
          !VALID_MODULE_TARGETS.has(String(rawOverride['target']))
        ) {
          mAcc.add('target', 'INVALID_TARGET', `Invalid target "${String(rawOverride['target'])}"`);
        }
        if (
          rawOverride['effectOwner'] !== undefined &&
          !VALID_EFFECT_OWNERS.has(String(rawOverride['effectOwner']))
        ) {
          mAcc.add(
            'effectOwner',
            'INVALID_EFFECT_OWNER',
            `Invalid effectOwner "${String(rawOverride['effectOwner'])}"`
          );
        }
        if (rawOverride['cadence'] !== undefined) {
          mAcc.absorb(
            validateCadencePolicy(
              rawOverride['cadence'] as Parameters<typeof validateCadencePolicy>[0],
              'cadence'
            )
          );
        }
        if (rawOverride['fields'] !== undefined) {
          if (!isPlainObject(rawOverride['fields'])) {
            mAcc.add('fields', 'INVALID_TYPE', 'fields must be a plain record');
          } else {
            for (const [fieldKey, spec] of Object.entries(rawOverride['fields'])) {
              mAcc.absorb(
                validateDynamicFieldSpec(spec as DynamicFieldSpec, `fields.${fieldKey}`)
              );
            }
          }
        }
        if (rawOverride['fieldConfirmPolicies'] !== undefined) {
          if (!isPlainObject(rawOverride['fieldConfirmPolicies'])) {
            mAcc.add(
              'fieldConfirmPolicies',
              'INVALID_TYPE',
              'fieldConfirmPolicies must be a plain record'
            );
          } else {
            for (const [fieldKey, policy] of Object.entries(rawOverride['fieldConfirmPolicies'])) {
              mAcc.absorb(
                validateConfirmPolicy(
                  policy as Parameters<typeof validateConfirmPolicy>[0],
                  `fieldConfirmPolicies.${fieldKey}`
                )
              );
            }
          }
        }
        if (rawOverride['ui'] !== undefined) {
          if (!isPlainObject(rawOverride['ui'])) {
            mAcc.add('ui', 'INVALID_TYPE', 'ui must be a plain object');
          } else {
            if (
              rawOverride['ui']['widget'] !== undefined &&
              !VALID_WIDGETS.has(String(rawOverride['ui']['widget']))
            ) {
              mAcc.add(
                'ui.widget',
                'INVALID_WIDGET',
                `Invalid ui.widget "${String(rawOverride['ui']['widget'])}"`
              );
            }
            if (
              rawOverride['ui']['order'] !== undefined &&
              (typeof rawOverride['ui']['order'] !== 'number' ||
                !Number.isFinite(rawOverride['ui']['order']))
            ) {
              mAcc.add('ui.order', 'INVALID_NUMBER', 'ui.order must be a finite number');
            }
          }
        }
      }
    }
  }

  if (rawLayer['blockOrder'] !== undefined) {
    validateStringArray(rawLayer['blockOrder'], acc.scope('blockOrder'), 'blockOrder');
  }
  if (rawLayer['syspromptSectionOrder'] !== undefined) {
    validateStringArray(
      rawLayer['syspromptSectionOrder'],
      acc.scope('syspromptSectionOrder'),
      'syspromptSectionOrder'
    );
  }
  if (rawLayer['basePrompts'] !== undefined) {
    validateStringRecordField(rawLayer['basePrompts'], acc.scope('basePrompts'), 'basePrompts');
  }
  if (rawLayer['unlockedPromptSections'] !== undefined) {
    validateBooleanRecordField(
      rawLayer['unlockedPromptSections'],
      acc.scope('unlockedPromptSections'),
      'unlockedPromptSections'
    );
  }

  if (rawLayer['combatRules'] !== undefined) {
    const cr = rawLayer['combatRules'];
    const crAcc = acc.scope('combatRules');
    if (!isPlainObject(cr)) {
      crAcc.add('', 'INVALID_TYPE', 'combatRules must be a plain object');
    } else {
      if (cr['diceEnabled'] !== undefined && typeof cr['diceEnabled'] !== 'boolean') {
        crAcc.add('diceEnabled', 'INVALID_TYPE', 'diceEnabled must be a boolean');
      }
      if (
        cr['diceMode'] !== undefined &&
        cr['diceMode'] !== 'd20' &&
        cr['diceMode'] !== 'd100'
      ) {
        crAcc.add('diceMode', 'INVALID_ENUM', 'diceMode must be "d20" or "d100"');
      }
      if (
        cr['allowPartialActionSalvage'] !== undefined &&
        typeof cr['allowPartialActionSalvage'] !== 'boolean'
      ) {
        crAcc.add(
          'allowPartialActionSalvage',
          'INVALID_TYPE',
          'allowPartialActionSalvage must be a boolean'
        );
      }
      if (
        cr['fallbackTacticsEnabled'] !== undefined &&
        typeof cr['fallbackTacticsEnabled'] !== 'boolean'
      ) {
        crAcc.add(
          'fallbackTacticsEnabled',
          'INVALID_TYPE',
          'fallbackTacticsEnabled must be a boolean'
        );
      }
      if (cr['customRules'] !== undefined) {
        validateStringRecordField(cr['customRules'], crAcc.scope('customRules'), 'customRules');
      }
      if (cr['skillOverrides'] !== undefined && !isPlainObject(cr['skillOverrides'])) {
        crAcc.add('skillOverrides', 'INVALID_TYPE', 'skillOverrides must be a plain object');
      }
    }
  }

  if (rawLayer['tuningDials'] !== undefined) {
    const td = rawLayer['tuningDials'];
    const tdAcc = acc.scope('tuningDials');
    if (!isPlainObject(td)) {
      tdAcc.add('', 'INVALID_TYPE', 'tuningDials must be a plain object');
    } else {
      if (
        td['beatPressure'] !== undefined &&
        !VALID_BEAT_PRESSURES.has(td['beatPressure'] as BeatPressure)
      ) {
        tdAcc.add('beatPressure', 'INVALID_ENUM', 'Invalid beatPressure');
      }
      if (
        td['narrativePacing'] !== undefined &&
        !VALID_NARRATIVE_PACINGS.has(td['narrativePacing'] as NarrativePacing)
      ) {
        tdAcc.add('narrativePacing', 'INVALID_ENUM', 'Invalid narrativePacing');
      }
      for (const bKey of ['cyoaEnabled', 'use24hTime', 'useDdMmYyFormat'] as const) {
        if (td[bKey] !== undefined && typeof td[bKey] !== 'boolean') {
          tdAcc.add(bKey, 'INVALID_TYPE', `${bKey} must be a boolean`);
        }
      }
    }
  }
}

function validateProgressionSpec(raw: unknown, acc: ErrorAccumulator): void {
  if (!isPlainObject(raw)) {
    acc.add('', 'INVALID_TYPE', 'progression must be a plain object');
    return;
  }
  if (typeof raw['level'] !== 'number' || !Number.isInteger(raw['level']) || raw['level'] < 1) {
    acc.add('level', 'INVALID_INTEGER', 'progression.level must be an integer >= 1');
  }
  if (typeof raw['xp'] !== 'number' || !Number.isFinite(raw['xp']) || raw['xp'] < 0) {
    acc.add('xp', 'INVALID_NUMBER', 'progression.xp must be a finite number >= 0');
  }
  if (raw['className'] !== undefined && typeof raw['className'] !== 'string') {
    acc.add('className', 'INVALID_TYPE', 'progression.className must be a string');
  }
  if (raw['subclass'] !== undefined && typeof raw['subclass'] !== 'string') {
    acc.add('subclass', 'INVALID_TYPE', 'progression.subclass must be a string');
  }
  if (raw['attributes'] !== undefined) {
    validateNumberRecordField(raw['attributes'], acc.scope('attributes'), 'progression.attributes');
  }
}

function validateResourcesSpec(raw: unknown, acc: ErrorAccumulator): void {
  if (!isPlainObject(raw)) {
    acc.add('', 'INVALID_TYPE', 'resources must be a plain record');
    return;
  }
  for (const [poolKey, poolVal] of Object.entries(raw)) {
    const pAcc = acc.scope(poolKey);
    if (!isPlainObject(poolVal)) {
      pAcc.add('', 'INVALID_TYPE', 'ResourcePool must be a plain object');
      continue;
    }
    if (
      typeof poolVal['current'] !== 'number' ||
      !Number.isFinite(poolVal['current']) ||
      poolVal['current'] < 0
    ) {
      pAcc.add('current', 'INVALID_NUMBER', 'ResourcePool current must be >= 0');
    }
    if (
      typeof poolVal['max'] !== 'number' ||
      !Number.isFinite(poolVal['max']) ||
      poolVal['max'] < 0
    ) {
      pAcc.add('max', 'INVALID_NUMBER', 'ResourcePool max must be >= 0');
    }
    if (
      typeof poolVal['current'] === 'number' &&
      typeof poolVal['max'] === 'number' &&
      Number.isFinite(poolVal['current']) &&
      Number.isFinite(poolVal['max']) &&
      poolVal['current'] > poolVal['max']
    ) {
      pAcc.add('current', 'OUT_OF_RANGE', 'ResourcePool current cannot exceed max');
    }
  }
}

function validateInitialEntitiesSection(
  rawEntities: unknown,
  acc: ErrorAccumulator
): void {
  if (!isPlainObject(rawEntities)) {
    acc.add('', 'INVALID_TYPE', 'initialEntities must be a plain object');
    return;
  }

  if (rawEntities['locations'] !== undefined) {
    const locs = rawEntities['locations'];
    const lAcc = acc.scope('locations');
    if (!isPlainObject(locs)) {
      lAcc.add('', 'INVALID_TYPE', 'locations must be a plain record');
    } else {
      for (const [key, rawLoc] of Object.entries(locs)) {
        const entryAcc = lAcc.scope(key);
        if (!validateNonEmptySafeId(key, '', entryAcc, 'INVALID_KEY')) {
          continue;
        }
        if (!isPlainObject(rawLoc)) {
          entryAcc.add('', 'INVALID_TYPE', 'LocationEntity must be a plain object');
          continue;
        }
        if (rawLoc['id'] !== undefined && rawLoc['id'] !== key) {
          entryAcc.add('id', 'ID_MISMATCH', `Location id "${String(rawLoc['id'])}" must match key "${key}"`);
        }
        if (typeof rawLoc['name'] !== 'string' || rawLoc['name'].trim().length === 0) {
          entryAcc.add('name', 'REQUIRED', 'Location name must be a non-empty string');
        }
        if (
          rawLoc['controllingFactionId'] !== undefined &&
          rawLoc['controllingFactionId'] !== null &&
          typeof rawLoc['controllingFactionId'] !== 'string'
        ) {
          entryAcc.add(
            'controllingFactionId',
            'INVALID_TYPE',
            'controllingFactionId must be a string or null'
          );
        }
        if (rawLoc['connectedLocations'] !== undefined) {
          validateStringArray(
            rawLoc['connectedLocations'],
            entryAcc.scope('connectedLocations'),
            'connectedLocations',
            true
          );
        }
        if (rawLoc['discovered'] !== undefined && typeof rawLoc['discovered'] !== 'boolean') {
          entryAcc.add('discovered', 'INVALID_TYPE', 'discovered must be a boolean');
        }
        if (rawLoc['tags'] !== undefined) {
          validateStringArray(rawLoc['tags'], entryAcc.scope('tags'), 'tags');
        }
        if (rawLoc['notes'] !== undefined && typeof rawLoc['notes'] !== 'string') {
          entryAcc.add('notes', 'INVALID_TYPE', 'notes must be a string');
        }
      }
    }
  }

  if (rawEntities['characters'] !== undefined) {
    const chars = rawEntities['characters'];
    const cAcc = acc.scope('characters');
    if (!isPlainObject(chars)) {
      cAcc.add('', 'INVALID_TYPE', 'characters must be a plain record');
    } else {
      for (const [key, rawChar] of Object.entries(chars)) {
        const entryAcc = cAcc.scope(key);
        if (!validateNonEmptySafeId(key, '', entryAcc, 'INVALID_KEY')) {
          continue;
        }
        if (!isPlainObject(rawChar)) {
          entryAcc.add('', 'INVALID_TYPE', 'CharacterEntity must be a plain object');
          continue;
        }
        if (rawChar['id'] !== undefined && rawChar['id'] !== key) {
          entryAcc.add('id', 'ID_MISMATCH', `Character id "${String(rawChar['id'])}" must match key "${key}"`);
        }
        if (typeof rawChar['name'] !== 'string' || rawChar['name'].trim().length === 0) {
          entryAcc.add('name', 'REQUIRED', 'Character name must be a non-empty string');
        }
        if (
          rawChar['status'] !== undefined &&
          (typeof rawChar['status'] !== 'string' ||
            !VALID_CHARACTER_STATUSES.has(rawChar['status']))
        ) {
          entryAcc.add(
            'status',
            'INVALID_ENUM',
            `Invalid CharacterStatus "${String(rawChar['status'])}"`
          );
        }
        if (
          rawChar['presentInScene'] !== undefined &&
          typeof rawChar['presentInScene'] !== 'boolean'
        ) {
          entryAcc.add('presentInScene', 'INVALID_TYPE', 'presentInScene must be a boolean');
        }
        for (const nullableStr of ['locationId', 'formId', 'formGroup'] as const) {
          if (
            rawChar[nullableStr] !== undefined &&
            rawChar[nullableStr] !== null &&
            typeof rawChar[nullableStr] !== 'string'
          ) {
            entryAcc.add(nullableStr, 'INVALID_TYPE', `${nullableStr} must be a string or null`);
          }
        }
        if (rawChar['sections'] !== undefined) {
          if (!isPlainObject(rawChar['sections'])) {
            entryAcc.add('sections', 'INVALID_TYPE', 'sections must be a plain object');
          } else {
            for (const [secId, secVal] of Object.entries(rawChar['sections'])) {
              const validSec =
                typeof secVal === 'string' ||
                (Array.isArray(secVal) && secVal.every((x) => typeof x === 'string'));
              if (!validSec) {
                entryAcc.add(
                  `sections.${secId}`,
                  'INVALID_SECTION_VALUE',
                  'Section value must be string or string[]'
                );
              }
            }
          }
        }
        if (rawChar['customFields'] !== undefined && !isPlainObject(rawChar['customFields'])) {
          entryAcc.add('customFields', 'INVALID_TYPE', 'customFields must be a plain object');
        }
        for (const arrField of ['abilities', 'goals', 'traits'] as const) {
          if (rawChar[arrField] !== undefined) {
            validateStringArray(rawChar[arrField], entryAcc.scope(arrField), arrField);
          }
        }
        if (rawChar['cardSheet'] !== undefined) {
          const sheetRes = validateCharacterCardSheet(rawChar['cardSheet']);
          if (!sheetRes.ok) {
            entryAcc.scope('cardSheet').addAll(sheetRes.error);
          }
        }
        if (rawChar['portraitAsset'] !== undefined && typeof rawChar['portraitAsset'] !== 'string') {
          entryAcc.add('portraitAsset', 'INVALID_TYPE', 'portraitAsset must be a string');
        }
        for (const strField of ['agenda', 'allegiance', 'mood'] as const) {
          if (rawChar[strField] !== undefined && typeof rawChar[strField] !== 'string') {
            entryAcc.add(strField, 'INVALID_TYPE', `${strField} must be a string`);
          }
        }
        if (rawChar['progression'] !== undefined) {
          validateProgressionSpec(rawChar['progression'], entryAcc.scope('progression'));
        }
        if (rawChar['resources'] !== undefined) {
          validateResourcesSpec(rawChar['resources'], entryAcc.scope('resources'));
        }
        if (rawChar['corruption'] !== undefined) {
          const c = rawChar['corruption'];
          const corrAcc = entryAcc.scope('corruption');
          if (!isPlainObject(c)) {
            corrAcc.add('', 'INVALID_TYPE', 'corruption must be a plain object');
          } else {
            if (typeof c['stage'] !== 'number' || !Number.isInteger(c['stage']) || c['stage'] < 0) {
              corrAcc.add('stage', 'INVALID_INTEGER', 'corruption.stage must be an integer >= 0');
            }
            if (
              typeof c['progress'] !== 'number' ||
              !Number.isFinite(c['progress']) ||
              c['progress'] < 0 ||
              c['progress'] > 100
            ) {
              corrAcc.add('progress', 'OUT_OF_RANGE', 'corruption.progress must be in [0, 100]');
            }
            if (c['source'] !== null && typeof c['source'] !== 'string') {
              corrAcc.add('source', 'INVALID_TYPE', 'corruption.source must be string or null');
            }
          }
        }
      }
    }
  }

  if (rawEntities['factions'] !== undefined) {
    const facs = rawEntities['factions'];
    const fAcc = acc.scope('factions');
    if (!isPlainObject(facs)) {
      fAcc.add('', 'INVALID_TYPE', 'factions must be a plain record');
    } else {
      for (const [key, rawFac] of Object.entries(facs)) {
        const entryAcc = fAcc.scope(key);
        if (!validateNonEmptySafeId(key, '', entryAcc, 'INVALID_KEY')) {
          continue;
        }
        if (!isPlainObject(rawFac)) {
          entryAcc.add('', 'INVALID_TYPE', 'FactionEntity must be a plain object');
          continue;
        }
        if (rawFac['id'] !== undefined && rawFac['id'] !== key) {
          entryAcc.add('id', 'ID_MISMATCH', `Faction id "${String(rawFac['id'])}" must match key "${key}"`);
        }
        if (typeof rawFac['name'] !== 'string' || rawFac['name'].trim().length === 0) {
          entryAcc.add('name', 'REQUIRED', 'Faction name must be a non-empty string');
        }
        if (
          rawFac['side'] !== undefined &&
          (typeof rawFac['side'] !== 'string' || !VALID_FACTION_SIDES.has(rawFac['side']))
        ) {
          entryAcc.add('side', 'INVALID_ENUM', `Invalid FactionSide "${String(rawFac['side'])}"`);
        }
        if (
          rawFac['status'] !== undefined &&
          (typeof rawFac['status'] !== 'string' || !VALID_FACTION_STATUSES.has(rawFac['status']))
        ) {
          entryAcc.add(
            'status',
            'INVALID_ENUM',
            `Invalid FactionStatus "${String(rawFac['status'])}"`
          );
        }
        if (
          rawFac['influence'] !== undefined &&
          (typeof rawFac['influence'] !== 'number' ||
            !Number.isFinite(rawFac['influence']) ||
            rawFac['influence'] < 0 ||
            rawFac['influence'] > 100)
        ) {
          entryAcc.add('influence', 'OUT_OF_RANGE', 'influence must be a number in [0, 100]');
        }
        if (
          rawFac['headquartersLocationId'] !== undefined &&
          rawFac['headquartersLocationId'] !== null &&
          typeof rawFac['headquartersLocationId'] !== 'string'
        ) {
          entryAcc.add(
            'headquartersLocationId',
            'INVALID_TYPE',
            'headquartersLocationId must be a string or null'
          );
        }
        if (rawFac['goals'] !== undefined) {
          validateStringArray(rawFac['goals'], entryAcc.scope('goals'), 'goals');
        }
      }
    }
  }

  if (rawEntities['threats'] !== undefined) {
    const threats = rawEntities['threats'];
    const tAcc = acc.scope('threats');
    if (!isPlainObject(threats)) {
      tAcc.add('', 'INVALID_TYPE', 'threats must be a plain record');
    } else {
      for (const [key, rawThreat] of Object.entries(threats)) {
        const entryAcc = tAcc.scope(key);
        if (!validateNonEmptySafeId(key, '', entryAcc, 'INVALID_KEY')) {
          continue;
        }
        if (!isPlainObject(rawThreat)) {
          entryAcc.add('', 'INVALID_TYPE', 'ThreatEntity must be a plain object');
          continue;
        }
        if (rawThreat['id'] !== undefined && rawThreat['id'] !== key) {
          entryAcc.add(
            'id',
            'ID_MISMATCH',
            `Threat id "${String(rawThreat['id'])}" must match key "${key}"`
          );
        }
        if (typeof rawThreat['name'] !== 'string' || rawThreat['name'].trim().length === 0) {
          entryAcc.add('name', 'REQUIRED', 'Threat name must be a non-empty string');
        }
        if (
          rawThreat['rank'] !== undefined &&
          (typeof rawThreat['rank'] !== 'string' || !VALID_THREAT_RANKS.has(rawThreat['rank']))
        ) {
          entryAcc.add('rank', 'INVALID_ENUM', `Invalid ThreatRank "${String(rawThreat['rank'])}"`);
        }
        if (
          rawThreat['status'] !== undefined &&
          (typeof rawThreat['status'] !== 'string' || !VALID_THREAT_STATUSES.has(rawThreat['status']))
        ) {
          entryAcc.add(
            'status',
            'INVALID_ENUM',
            `Invalid ThreatStatus "${String(rawThreat['status'])}"`
          );
        }
        if (
          rawThreat['stage'] !== undefined &&
          (typeof rawThreat['stage'] !== 'number' ||
            !Number.isInteger(rawThreat['stage']) ||
            rawThreat['stage'] < 0)
        ) {
          entryAcc.add('stage', 'INVALID_INTEGER', 'stage must be an integer >= 0');
        }
        if (
          rawThreat['progress'] !== undefined &&
          (typeof rawThreat['progress'] !== 'number' ||
            !Number.isFinite(rawThreat['progress']) ||
            rawThreat['progress'] < 0 ||
            rawThreat['progress'] > 100)
        ) {
          entryAcc.add('progress', 'OUT_OF_RANGE', 'progress must be in [0, 100]');
        }
        for (const nullableStr of ['locationId', 'sourceFactionId'] as const) {
          if (
            rawThreat[nullableStr] !== undefined &&
            rawThreat[nullableStr] !== null &&
            typeof rawThreat[nullableStr] !== 'string'
          ) {
            entryAcc.add(nullableStr, 'INVALID_TYPE', `${nullableStr} must be a string or null`);
          }
        }
        if (rawThreat['agenda'] !== undefined && typeof rawThreat['agenda'] !== 'string') {
          entryAcc.add('agenda', 'INVALID_TYPE', 'agenda must be a string');
        }
      }
    }
  }

  if (rawEntities['forms'] !== undefined) {
    const forms = rawEntities['forms'];
    const formAcc = acc.scope('forms');
    if (!Array.isArray(forms)) {
      formAcc.add('', 'INVALID_TYPE', 'forms must be an array');
    } else {
      const seenFormIds = new Set<string>();
      for (let i = 0; i < forms.length; i += 1) {
        const rawForm = forms[i];
        const fScope = formAcc.scope(`[${i}]`);
        if (!isPlainObject(rawForm)) {
          fScope.add('', 'INVALID_TYPE', 'FormDefinition must be a plain object');
          continue;
        }
        if (validateNonEmptySafeId(rawForm['id'], 'id', fScope)) {
          const fid = String(rawForm['id']);
          if (seenFormIds.has(fid)) {
            fScope.add('id', 'DUPLICATE_ID', `Duplicate form id "${fid}"`);
          } else {
            seenFormIds.add(fid);
          }
        }
        validateNonEmptySafeId(rawForm['formGroup'], 'formGroup', fScope);
        validateNonEmptySafeId(rawForm['characterId'], 'characterId', fScope);
        if (
          typeof rawForm['displayName'] !== 'string' ||
          rawForm['displayName'].trim().length === 0
        ) {
          fScope.add('displayName', 'REQUIRED', 'Form displayName must be a non-empty string');
        }
        if (rawForm['legalTargets'] !== undefined) {
          validateStringArray(
            rawForm['legalTargets'],
            fScope.scope('legalTargets'),
            'legalTargets',
            true
          );
        }
      }
    }
  }
}

function validateInitialStateSection(
  rawState: unknown,
  acc: ErrorAccumulator
): void {
  if (!isPlainObject(rawState)) {
    acc.add('', 'INVALID_TYPE', 'initialState must be a plain object');
    return;
  }

  if (rawState['schemaVersion'] !== undefined && rawState['schemaVersion'] !== 2) {
    acc.add('schemaVersion', 'INVALID_SCHEMA_VERSION', 'initialState.schemaVersion must be 2');
  }

  if (rawState['capabilities'] !== undefined) {
    acc.absorb(
      validateSystemCapabilities(
        rawState['capabilities'] as Parameters<typeof validateSystemCapabilities>[0],
        'capabilities'
      )
    );
  }

  if (rawState['meta'] !== undefined) {
    const meta = rawState['meta'];
    const mAcc = acc.scope('meta');
    if (!isPlainObject(meta)) {
      mAcc.add('', 'INVALID_TYPE', 'meta must be a plain object');
    } else {
      if (
        meta['sessionId'] !== undefined &&
        (typeof meta['sessionId'] !== 'string' || meta['sessionId'].trim().length === 0)
      ) {
        mAcc.add('sessionId', 'REQUIRED', 'meta.sessionId must be a non-empty string');
      }
      if (
        meta['turn'] !== undefined &&
        (typeof meta['turn'] !== 'number' || !Number.isInteger(meta['turn']) || meta['turn'] < 0)
      ) {
        mAcc.add('turn', 'INVALID_TURN', 'meta.turn must be a non-negative integer');
      }
      if (meta['arc'] !== undefined && !VALID_WORLD_ARCS.has(String(meta['arc']))) {
        mAcc.add('arc', 'INVALID_ENUM', `Invalid arc "${String(meta['arc'])}"`);
      }
      if (
        meta['endingStatus'] !== undefined &&
        !VALID_ENDING_STATUSES.has(String(meta['endingStatus']))
      ) {
        mAcc.add(
          'endingStatus',
          'INVALID_ENUM',
          `Invalid endingStatus "${String(meta['endingStatus'])}"`
        );
      }
      if (
        meta['activeEndingId'] !== undefined &&
        meta['activeEndingId'] !== null &&
        typeof meta['activeEndingId'] !== 'string'
      ) {
        mAcc.add('activeEndingId', 'INVALID_TYPE', 'meta.activeEndingId must be string or null');
      }
    }
  }

  if (rawState['flags'] !== undefined) {
    validateBooleanRecordField(rawState['flags'], acc.scope('flags'), 'flags');
  }
  if (rawState['counters'] !== undefined) {
    validateNumberRecordField(rawState['counters'], acc.scope('counters'), 'counters');
  }
  if (rawState['customFields'] !== undefined && !isPlainObject(rawState['customFields'])) {
    acc.add('customFields', 'INVALID_TYPE', 'customFields must be a plain object');
  }

  if (rawState['clocks'] !== undefined) {
    const clocks = rawState['clocks'];
    const cAcc = acc.scope('clocks');
    if (!isPlainObject(clocks)) {
      cAcc.add('', 'INVALID_TYPE', 'clocks must be a plain object');
    } else {
      if (
        clocks['turn'] !== undefined &&
        (typeof clocks['turn'] !== 'number' || !Number.isInteger(clocks['turn']) || clocks['turn'] < 0)
      ) {
        cAcc.add('turn', 'INVALID_TURN', 'clocks.turn must be an integer >= 0');
      }
      if (
        clocks['storyTurn'] !== undefined &&
        (typeof clocks['storyTurn'] !== 'number' ||
          !Number.isInteger(clocks['storyTurn']) ||
          clocks['storyTurn'] < 0)
      ) {
        cAcc.add('storyTurn', 'INVALID_STORY_TURN', 'clocks.storyTurn must be an integer >= 0');
      }
      if (
        clocks['day'] !== undefined &&
        (typeof clocks['day'] !== 'number' || !Number.isInteger(clocks['day']) || clocks['day'] < 1)
      ) {
        cAcc.add('day', 'INVALID_DAY', 'clocks.day must be an integer >= 1');
      }
      if (
        clocks['inGameDate'] !== undefined &&
        clocks['inGameDate'] !== null &&
        parseIsoDate(clocks['inGameDate']) === null
      ) {
        cAcc.add('inGameDate', 'INVALID_DATE', 'clocks.inGameDate must be YYYY-MM-DD or null');
      }
      if (clocks['slotsPerDay'] !== undefined) {
        validateStringArray(clocks['slotsPerDay'], cAcc.scope('slotsPerDay'), 'slotsPerDay', true);
      }
      if (clocks['slot'] !== undefined && typeof clocks['slot'] !== 'string') {
        cAcc.add('slot', 'INVALID_TYPE', 'clocks.slot must be a string');
      }
      if (clocks['held'] !== undefined && typeof clocks['held'] !== 'boolean') {
        cAcc.add('held', 'INVALID_TYPE', 'clocks.held must be a boolean');
      }
      if (
        clocks['holdReason'] !== undefined &&
        clocks['holdReason'] !== null &&
        typeof clocks['holdReason'] !== 'string'
      ) {
        cAcc.add('holdReason', 'INVALID_TYPE', 'clocks.holdReason must be a string or null');
      }
      if (clocks['timers'] !== undefined) {
        if (!isPlainObject(clocks['timers'])) {
          cAcc.add('timers', 'INVALID_TYPE', 'clocks.timers must be a plain record');
        } else {
          for (const [tId, rawTimer] of Object.entries(clocks['timers'])) {
            const tScope = cAcc.scope(`timers.${tId}`);
            if (!isPlainObject(rawTimer)) {
              tScope.add('', 'INVALID_TYPE', 'ClockTimer must be a plain object');
              continue;
            }
            if (typeof rawTimer['current'] !== 'number' || !Number.isFinite(rawTimer['current']) || rawTimer['current'] < 0) {
              tScope.add('current', 'INVALID_TIMER_CURRENT', 'Timer current must be >= 0');
            }
            if (typeof rawTimer['max'] !== 'number' || !Number.isFinite(rawTimer['max']) || rawTimer['max'] <= 0) {
              tScope.add('max', 'INVALID_TIMER_MAX', 'Timer max must be > 0');
            }
            if (
              rawTimer['tickOn'] !== 'turn' &&
              rawTimer['tickOn'] !== 'slot' &&
              rawTimer['tickOn'] !== 'day'
            ) {
              tScope.add('tickOn', 'INVALID_ENUM', 'tickOn must be turn, slot, or day');
            }
          }
        }
      }
    }
  }

  if (rawState['scene'] !== undefined) {
    const scene = rawState['scene'];
    const sAcc = acc.scope('scene');
    if (!isPlainObject(scene)) {
      sAcc.add('', 'INVALID_TYPE', 'scene must be a plain object');
    } else {
      for (const strKey of ['location', 'mood', 'pacing'] as const) {
        if (scene[strKey] !== undefined && typeof scene[strKey] !== 'string') {
          sAcc.add(strKey, 'INVALID_TYPE', `scene.${strKey} must be a string`);
        }
      }
      for (const nullableKey of ['locationId', 'directorNudge'] as const) {
        if (
          scene[nullableKey] !== undefined &&
          scene[nullableKey] !== null &&
          typeof scene[nullableKey] !== 'string'
        ) {
          sAcc.add(nullableKey, 'INVALID_TYPE', `scene.${nullableKey} must be string or null`);
        }
      }
      for (const arrKey of ['presentCharacterIds', 'pinnedCharacterIds'] as const) {
        if (scene[arrKey] !== undefined) {
          validateStringArray(scene[arrKey], sAcc.scope(arrKey), `scene.${arrKey}`);
        }
      }
    }
  }

  if (rawState['player'] !== undefined) {
    const player = rawState['player'];
    const pAcc = acc.scope('player');
    if (!isPlainObject(player)) {
      pAcc.add('', 'INVALID_TYPE', 'player must be a plain object');
    } else {
      if (player['id'] !== undefined && (typeof player['id'] !== 'string' || player['id'].trim().length === 0)) {
        pAcc.add('id', 'REQUIRED', 'player.id must be a non-empty string');
      }
      if (player['name'] !== undefined && typeof player['name'] !== 'string') {
        pAcc.add('name', 'INVALID_TYPE', 'player.name must be a string');
      }
      for (const nullableKey of ['characterId', 'locationId'] as const) {
        if (
          player[nullableKey] !== undefined &&
          player[nullableKey] !== null &&
          typeof player[nullableKey] !== 'string'
        ) {
          pAcc.add(nullableKey, 'INVALID_TYPE', `player.${nullableKey} must be string or null`);
        }
      }
      if (player['customFields'] !== undefined && !isPlainObject(player['customFields'])) {
        pAcc.add('customFields', 'INVALID_TYPE', 'player.customFields must be a plain object');
      }
      if (player['progression'] !== undefined) {
        validateProgressionSpec(player['progression'], pAcc.scope('progression'));
      }
      if (player['resources'] !== undefined) {
        validateResourcesSpec(player['resources'], pAcc.scope('resources'));
      }
      if (player['inventory'] !== undefined) {
        const inv = player['inventory'];
        if (!isPlainObject(inv)) {
          pAcc.add('inventory', 'INVALID_TYPE', 'player.inventory must be a plain object');
        } else {
          if (inv['items'] !== undefined) {
            validateNumberRecordField(inv['items'], pAcc.scope('inventory.items'), 'inventory.items');
          }
          if (inv['currency'] !== undefined) {
            validateNumberRecordField(
              inv['currency'],
              pAcc.scope('inventory.currency'),
              'inventory.currency'
            );
          }
        }
      }
    }
  }

  if (rawState['entities'] !== undefined) {
    validateInitialEntitiesSection(rawState['entities'], acc.scope('entities'));
  }

  if (rawState['chronicle'] !== undefined) {
    const chr = rawState['chronicle'];
    const chAcc = acc.scope('chronicle');
    if (!isPlainObject(chr)) {
      chAcc.add('', 'INVALID_TYPE', 'chronicle must be a plain object');
    } else if (chr['events'] !== undefined) {
      if (!Array.isArray(chr['events'])) {
        chAcc.add('events', 'INVALID_TYPE', 'chronicle.events must be an array');
      } else {
        for (let i = 0; i < chr['events'].length; i += 1) {
          const ev = chr['events'][i];
          const eScope = chAcc.scope(`events[${i}]`);
          if (!isPlainObject(ev)) {
            eScope.add('', 'INVALID_TYPE', 'ChronicleEntry must be a plain object');
            continue;
          }
          if (
            ev['category'] !== undefined &&
            !VALID_CHRONICLE_CATEGORIES.has(String(ev['category']))
          ) {
            eScope.add('category', 'INVALID_ENUM', `Invalid category "${String(ev['category'])}"`);
          }
        }
      }
    }
  }

  if (rawState['turnEvents'] !== undefined) {
    const te = rawState['turnEvents'];
    const teAcc = acc.scope('turnEvents');
    if (!isPlainObject(te)) {
      teAcc.add('', 'INVALID_TYPE', 'turnEvents must be a plain object');
    } else {
      for (const k of ['combatOutcomes', 'rumors', 'systemNotices'] as const) {
        if (te[k] !== undefined) {
          validateStringArray(te[k], teAcc.scope(k), `turnEvents.${k}`);
        }
      }
    }
  }
}

function validateBeatExtras(beats: readonly BeatDefinition[], acc: ErrorAccumulator): void {
  for (let i = 0; i < beats.length; i += 1) {
    const beat = beats[i] as unknown;
    if (!isPlainObject(beat)) {
      continue;
    }
    const bAcc = acc.scope(`[${i}]`);

    if (beat['act'] !== undefined && typeof beat['act'] !== 'string') {
      bAcc.add('act', 'INVALID_TYPE', 'beat.act must be a string');
    }
    if (beat['route'] !== undefined) {
      validateNonEmptySafeId(beat['route'], 'route', bAcc, 'INVALID_ROUTE_REF');
    }
    if (beat['nudge'] !== undefined && typeof beat['nudge'] !== 'string') {
      bAcc.add('nudge', 'INVALID_TYPE', 'beat.nudge must be a string');
    }
    if (beat['lore'] !== undefined && (typeof beat['lore'] !== 'string' || beat['lore'].trim().length === 0)) {
      bAcc.add('lore', 'INVALID_LORE_PATH', 'beat.lore must be a non-empty string when specified');
    }
    if (beat['once'] !== undefined && typeof beat['once'] !== 'boolean') {
      bAcc.add('once', 'INVALID_TYPE', 'beat.once must be a boolean');
    }

    if (beat['roles'] !== undefined) {
      const roles = beat['roles'];
      const rAcc = bAcc.scope('roles');
      if (!isPlainObject(roles)) {
        rAcc.add('', 'INVALID_TYPE', 'beat.roles must be a plain object');
      } else {
        for (const [roleKey, spec] of Object.entries(roles)) {
          const rsAcc = rAcc.scope(roleKey);
          if (isUnsafeRecordKey(roleKey)) {
            rsAcc.add('', 'UNSAFE_PROPERTY_KEY', `Forbidden role key "${roleKey}"`);
            continue;
          }
          if (!isPlainObject(spec)) {
            rsAcc.add('', 'INVALID_TYPE', 'BeatRoleSpec must be a plain object');
            continue;
          }
          validateNonEmptySafeId(spec['default'], 'default', rsAcc);
          if (spec['fallbackQuery'] !== undefined) {
            const fq = spec['fallbackQuery'];
            const fqAcc = rsAcc.scope('fallbackQuery');
            if (!isPlainObject(fq)) {
              fqAcc.add('', 'INVALID_TYPE', 'fallbackQuery must be a plain object');
            } else {
              if (!VALID_ROLE_COLLECTIONS.has(String(fq['collection']))) {
                fqAcc.add(
                  'collection',
                  'INVALID_COLLECTION',
                  `Invalid fallbackQuery collection "${String(fq['collection'])}"`
                );
              }
              if (!isPlainObject(fq['where'])) {
                fqAcc.add('where', 'INVALID_TYPE', 'fallbackQuery.where must be a plain object');
              }
            }
          }
        }
      }
    }

    for (const hookName of [
      'on_entry',
      'on_resolve',
      'on_deadline',
      'on_short_circuit',
      'on_abort',
    ] as const) {
      const hookEffects = beat[hookName];
      if (hookEffects === undefined) {
        continue;
      }
      const hAcc = bAcc.scope(hookName);
      if (!Array.isArray(hookEffects)) {
        hAcc.add('', 'INVALID_TYPE', `${hookName} must be an array of BeatEffect objects`);
        continue;
      }
      for (let j = 0; j < hookEffects.length; j += 1) {
        const eff = hookEffects[j];
        const eAcc = hAcc.scope(`[${j}]`);
        if (!isPlainObject(eff)) {
          eAcc.add('', 'INVALID_TYPE', 'BeatEffect must be a plain object');
          continue;
        }
        const hasKnownKind =
          Object.hasOwn(eff, 'set') ||
          Object.hasOwn(eff, 'increment') ||
          Object.hasOwn(eff, 'entity_patch') ||
          Object.hasOwn(eff, 'chronicle') ||
          Object.hasOwn(eff, 'inject') ||
          Object.hasOwn(eff, 'script') ||
          Object.hasOwn(eff, 'op');
        if (!hasKnownKind) {
          eAcc.add('', 'UNKNOWN_BEAT_EFFECT', 'Unrecognized BeatEffect shape');
          continue;
        }
        if (Object.hasOwn(eff, 'set') && !isPlainObject(eff['set'])) {
          eAcc.add('set', 'INVALID_TYPE', 'BeatEffect set must be a plain object');
        }
        if (Object.hasOwn(eff, 'increment')) {
          validateNumberRecordField(eff['increment'], eAcc.scope('increment'), 'increment');
        }
        if (Object.hasOwn(eff, 'entity_patch')) {
          const ep = eff['entity_patch'];
          const epAcc = eAcc.scope('entity_patch');
          if (!isPlainObject(ep)) {
            epAcc.add('', 'INVALID_TYPE', 'entity_patch must be a plain object');
          } else {
            const coll = String(ep['collection']);
            if (
              coll !== 'characters' &&
              coll !== 'factions' &&
              coll !== 'threats' &&
              coll !== 'locations'
            ) {
              epAcc.add('collection', 'INVALID_COLLECTION', `Invalid collection "${coll}"`);
            }
            if (typeof ep['entityId'] !== 'string' || ep['entityId'].trim().length === 0) {
              epAcc.add('entityId', 'REQUIRED', 'entity_patch.entityId must be a non-empty string');
            }
            if (!isPlainObject(ep['patch'])) {
              epAcc.add('patch', 'INVALID_TYPE', 'entity_patch.patch must be a plain object');
            }
          }
        }
        if (Object.hasOwn(eff, 'chronicle')) {
          const chr = eff['chronicle'];
          const cAcc = eAcc.scope('chronicle');
          if (!isPlainObject(chr)) {
            cAcc.add('', 'INVALID_TYPE', 'chronicle effect must be a plain object');
          } else {
            if (!VALID_CHRONICLE_CATEGORIES.has(String(chr['category']))) {
              cAcc.add(
                'category',
                'INVALID_ENUM',
                `Invalid chronicle category "${String(chr['category'])}"`
              );
            }
            if (typeof chr['title'] !== 'string') {
              cAcc.add('title', 'INVALID_TYPE', 'chronicle.title must be a string');
            }
            if (typeof chr['summary'] !== 'string') {
              cAcc.add('summary', 'INVALID_TYPE', 'chronicle.summary must be a string');
            }
          }
        }
        if (Object.hasOwn(eff, 'inject') && (typeof eff['inject'] !== 'string' || eff['inject'].trim().length === 0)) {
          eAcc.add('inject', 'INVALID_LORE_PATH', 'BeatEffect inject must be a non-empty string');
        }
        if (Object.hasOwn(eff, 'script') && (typeof eff['script'] !== 'string' || eff['script'].trim().length === 0)) {
          eAcc.add('script', 'INVALID_SCRIPT_REF', 'BeatEffect script must be a non-empty string');
        }
      }
    }
  }
}

function validateCombatNumberRecordField(
  raw: unknown,
  acc: ErrorAccumulator,
  fieldName: string
): void {
  if (!isPlainObject(raw)) {
    acc.add(fieldName, 'INVALID_TYPE', `${fieldName} must be a plain object`);
    return;
  }
  for (const key of Object.keys(raw)) {
    if (isUnsafeRecordKey(key)) {
      acc.add(`${fieldName}.${key}`, 'UNSAFE_KEY', `Unsafe key "${key}"`);
      continue;
    }
    const val = Object.getOwnPropertyDescriptor(raw, key)?.value;
    if (typeof val !== 'number' || !Number.isFinite(val)) {
      acc.add(`${fieldName}.${key}`, 'INVALID_NUMBER', `${fieldName}.${key} must be a finite number`);
    }
  }
}

function validateCombatStringArrayField(
  raw: unknown,
  acc: ErrorAccumulator,
  fieldName: string
): void {
  if (!Array.isArray(raw)) {
    acc.add(fieldName, 'INVALID_TYPE', `${fieldName} must be an array of strings`);
    return;
  }
  for (let i = 0; i < raw.length; i += 1) {
    if (typeof raw[i] !== 'string' || raw[i].trim().length === 0) {
      acc.add(`${fieldName}[${i}]`, 'INVALID_TYPE', `${fieldName}[${i}] must be a non-empty string`);
    }
  }
}

function validateSummonTemplateField(raw: unknown, acc: ErrorAccumulator): void {
  if (!isPlainObject(raw)) {
    acc.add('', 'INVALID_TYPE', 'SummonTemplate must be a plain object');
    return;
  }
  const id = Object.getOwnPropertyDescriptor(raw, 'id')?.value;
  if (typeof id !== 'string' || id.trim().length === 0 || isUnsafeRecordKey(id)) {
    acc.add('id', 'INVALID_ID', 'SummonTemplate.id must be a safe non-empty string');
  }
  const name = Object.getOwnPropertyDescriptor(raw, 'name')?.value;
  if (typeof name !== 'string' || name.trim().length === 0) {
    acc.add('name', 'INVALID_NAME', 'SummonTemplate.name must be a non-empty string');
  }
  const maxHp = Object.getOwnPropertyDescriptor(raw, 'maxHp')?.value;
  if (typeof maxHp !== 'number' || !Number.isFinite(maxHp) || maxHp <= 0) {
    acc.add('maxHp', 'INVALID_NUMBER', 'SummonTemplate.maxHp must be a positive finite number');
  }
  const ac = Object.getOwnPropertyDescriptor(raw, 'ac')?.value;
  if (typeof ac !== 'number' || !Number.isFinite(ac) || ac < 0) {
    acc.add('ac', 'INVALID_NUMBER', 'SummonTemplate.ac must be a non-negative finite number');
  }
  const speed = Object.getOwnPropertyDescriptor(raw, 'speed')?.value;
  if (typeof speed !== 'number' || !Number.isFinite(speed) || speed < 0) {
    acc.add('speed', 'INVALID_NUMBER', 'SummonTemplate.speed must be a non-negative finite number');
  }
  validateCombatNumberRecordField(Object.getOwnPropertyDescriptor(raw, 'stats')?.value, acc, 'stats');
  validateCombatStringArrayField(Object.getOwnPropertyDescriptor(raw, 'abilities')?.value, acc, 'abilities');

  const durationTurns = Object.getOwnPropertyDescriptor(raw, 'durationTurns')?.value;
  if (
    durationTurns !== null &&
    (typeof durationTurns !== 'number' || !Number.isFinite(durationTurns) || durationTurns < 1)
  ) {
    acc.add('durationTurns', 'INVALID_DURATION', 'SummonTemplate.durationTurns must be null or >= 1');
  }
  const maxActive = Object.getOwnPropertyDescriptor(raw, 'maxActivePerCaster')?.value;
  if (typeof maxActive !== 'number' || !Number.isSafeInteger(maxActive) || maxActive < 1) {
    acc.add('maxActivePerCaster', 'INVALID_NUMBER', 'SummonTemplate.maxActivePerCaster must be an integer >= 1');
  }
  const capPolicy = Object.getOwnPropertyDescriptor(raw, 'capPolicy')?.value;
  if (capPolicy !== undefined && capPolicy !== 'evict_oldest' && capPolicy !== 'reject') {
    acc.add('capPolicy', 'INVALID_ENUM', 'SummonTemplate.capPolicy must be "evict_oldest" or "reject"');
  }
  const despawn = Object.getOwnPropertyDescriptor(raw, 'despawnOnSummonerDefeat')?.value;
  if (typeof despawn !== 'boolean') {
    acc.add('despawnOnSummonerDefeat', 'INVALID_TYPE', 'SummonTemplate.despawnOnSummonerDefeat must be a boolean');
  }
  const initPolicy = Object.getOwnPropertyDescriptor(raw, 'initiativePolicy')?.value;
  if (initPolicy !== 'after_summoner' && initPolicy !== 'roll') {
    acc.add('initiativePolicy', 'INVALID_ENUM', 'SummonTemplate.initiativePolicy must be "after_summoner" or "roll"');
  }
}

function validateFormLoadoutField(raw: unknown, acc: ErrorAccumulator): void {
  if (!isPlainObject(raw)) {
    acc.add('', 'INVALID_TYPE', 'CombatFormLoadout must be a plain object');
    return;
  }
  const id = Object.getOwnPropertyDescriptor(raw, 'id')?.value;
  if (typeof id !== 'string' || id.trim().length === 0 || isUnsafeRecordKey(id)) {
    acc.add('id', 'INVALID_ID', 'CombatFormLoadout.id must be a safe non-empty string');
  }
  const displayName = Object.getOwnPropertyDescriptor(raw, 'displayName')?.value;
  if (typeof displayName !== 'string' || displayName.trim().length === 0) {
    acc.add('displayName', 'INVALID_NAME', 'CombatFormLoadout.displayName must be a non-empty string');
  }
  validateCombatStringArrayField(Object.getOwnPropertyDescriptor(raw, 'abilities')?.value, acc, 'abilities');

  const replaceAbilities = Object.getOwnPropertyDescriptor(raw, 'replaceAbilities')?.value;
  if (typeof replaceAbilities !== 'boolean') {
    acc.add('replaceAbilities', 'INVALID_TYPE', 'CombatFormLoadout.replaceAbilities must be a boolean');
  }
  const durationTurns = Object.getOwnPropertyDescriptor(raw, 'durationTurns')?.value;
  if (
    durationTurns !== null &&
    (typeof durationTurns !== 'number' || !Number.isFinite(durationTurns) || durationTurns < 1)
  ) {
    acc.add('durationTurns', 'INVALID_DURATION', 'CombatFormLoadout.durationTurns must be null or >= 1');
  }

  const statOverrides = Object.getOwnPropertyDescriptor(raw, 'statOverrides')?.value;
  if (statOverrides !== undefined) {
    validateCombatNumberRecordField(statOverrides, acc, 'statOverrides');
  }
  const statBonuses = Object.getOwnPropertyDescriptor(raw, 'statBonuses')?.value;
  if (statBonuses !== undefined) {
    validateCombatNumberRecordField(statBonuses, acc, 'statBonuses');
  }
  for (const numField of ['acOverride', 'speedOverride', 'tempHpPool'] as const) {
    const val = Object.getOwnPropertyDescriptor(raw, numField)?.value;
    if (val !== undefined && (typeof val !== 'number' || !Number.isFinite(val) || val < 0)) {
      acc.add(numField, 'INVALID_NUMBER', `CombatFormLoadout.${numField} must be a non-negative finite number`);
    }
  }
  const revertOnZero = Object.getOwnPropertyDescriptor(raw, 'revertOnZeroTempHp')?.value;
  if (revertOnZero !== undefined && typeof revertOnZero !== 'boolean') {
    acc.add('revertOnZeroTempHp', 'INVALID_TYPE', 'CombatFormLoadout.revertOnZeroTempHp must be a boolean');
  }
  const persistFormId = Object.getOwnPropertyDescriptor(raw, 'persistFormIdToWorld')?.value;
  if (persistFormId !== undefined && (typeof persistFormId !== 'string' || persistFormId.trim().length === 0)) {
    acc.add('persistFormIdToWorld', 'INVALID_TYPE', 'CombatFormLoadout.persistFormIdToWorld must be a non-empty string');
  }
}

function validateCartridgeCombatConfig(combat: unknown, acc: ErrorAccumulator): void {
  if (!isPlainObject(combat)) {
    acc.add('', 'INVALID_TYPE', 'combat must be a plain object');
    return;
  }

  const skills = Object.getOwnPropertyDescriptor(combat, 'skills')?.value;
  if (skills !== undefined) {
    const skillsRes = validateSkillCatalog(skills as readonly SkillDefinition[]);
    if (!skillsRes.ok) {
      acc.scope('skills').addAll(skillsRes.error);
    }
  }

  const turnStyle = Object.getOwnPropertyDescriptor(combat, 'turnStyle')?.value;
  if (turnStyle !== undefined && turnStyle !== 'initiative' && turnStyle !== 'phased') {
    acc.add('turnStyle', 'INVALID_TURN_STYLE', 'combat.turnStyle must be "initiative" or "phased"');
  }

  const summons = Object.getOwnPropertyDescriptor(combat, 'summons')?.value;
  if (summons !== undefined) {
    if (!isPlainObject(summons)) {
      acc.add('summons', 'INVALID_TYPE', 'combat.summons must be a plain object');
    } else {
      for (const key of Object.keys(summons)) {
        if (isUnsafeRecordKey(key)) {
          acc.add(`summons.${key}`, 'UNSAFE_KEY', `Unsafe key "${key}" in combat.summons`);
          continue;
        }
        const tpl = Object.getOwnPropertyDescriptor(summons, key)?.value;
        validateSummonTemplateField(tpl, acc.scope(`summons.${key}`));
      }
    }
  }

  const formLoadouts = Object.getOwnPropertyDescriptor(combat, 'formLoadouts')?.value;
  if (formLoadouts !== undefined) {
    if (!isPlainObject(formLoadouts)) {
      acc.add('formLoadouts', 'INVALID_TYPE', 'combat.formLoadouts must be a plain object');
    } else {
      for (const key of Object.keys(formLoadouts)) {
        if (isUnsafeRecordKey(key)) {
          acc.add(`formLoadouts.${key}`, 'UNSAFE_KEY', `Unsafe key "${key}" in combat.formLoadouts`);
          continue;
        }
        const loadout = Object.getOwnPropertyDescriptor(formLoadouts, key)?.value;
        validateFormLoadoutField(loadout, acc.scope(`formLoadouts.${key}`));
      }
    }
  }

  const effectTemplates = Object.getOwnPropertyDescriptor(combat, 'effectTemplates')?.value;
  if (effectTemplates !== undefined) {
    if (!isPlainObject(effectTemplates)) {
      acc.add('effectTemplates', 'INVALID_TYPE', 'combat.effectTemplates must be a plain object');
    } else {
      for (const key of Object.keys(effectTemplates)) {
        if (isUnsafeRecordKey(key)) {
          acc.add(`effectTemplates.${key}`, 'UNSAFE_KEY', `Unsafe key "${key}" in combat.effectTemplates`);
          continue;
        }
        const tpl = Object.getOwnPropertyDescriptor(effectTemplates, key)?.value;
        const tplRes = validateEffectTemplate(tpl);
        if (!tplRes.ok) {
          acc.scope(`effectTemplates.${key}`).addAll(tplRes.error);
        }
      }
    }
  }
}

/**
 * Validate structural integrity of a {@link CartridgeBundle}, supporting both
 * minimal Tier 0 cartridges (`card` + optional `loreFiles` with empty beats/routes/endings/entities)
 * and full campaign cartridges.
 */
export function validateCartridgeStructure(
  bundle: CartridgeBundle
): Result<CartridgeBundle, ValidationError[]> {
  if (!isPlainObject(bundle)) {
    return err([
      validationError('', 'INVALID_TYPE', 'CartridgeBundle must be a non-null plain object'),
    ]);
  }

  const acc = new ErrorAccumulator();
  scanObjectForUnsafeKeys(bundle, acc);

  if (bundle.rootDir !== null && typeof bundle.rootDir !== 'string') {
    acc.add('rootDir', 'INVALID_TYPE', 'rootDir must be a string or null');
  }

  validateCardSpec(bundle.card, acc.scope('card'));

  if (bundle.systemOverrides !== undefined) {
    validateControlRoomLayerField(bundle.systemOverrides, acc.scope('systemOverrides'));
  }

  if (bundle.initialState !== undefined) {
    validateInitialStateSection(bundle.initialState, acc.scope('initialState'));
  }

  if (bundle.initialEntities !== undefined) {
    validateInitialEntitiesSection(bundle.initialEntities, acc.scope('initialEntities'));
  }

  if (bundle.agendas !== undefined) {
    const agendaRes = validateAgendaConfig(bundle.agendas);
    if (!agendaRes.ok) {
      acc.addAll(agendaRes.error);
    }
  }

  if (bundle.combat !== undefined) {
    validateCartridgeCombatConfig(bundle.combat, acc.scope('combat'));
  }

  const beatsRes = validateBeatDefinitions(bundle.beats, 'beats');
  if (!beatsRes.ok) {
    acc.addAll(beatsRes.error);
  } else {
    validateBeatExtras(bundle.beats, acc.scope('beats'));
  }

  const routesRes = validateRoutesAndEndings(bundle.routes, bundle.endings);
  if (!routesRes.ok) {
    acc.addAll(routesRes.error);
  }

  validateStringRecordField(bundle.loreFiles, acc.scope('loreFiles'), 'loreFiles');
  validateStringRecordField(
    bundle.endingPromptFiles,
    acc.scope('endingPromptFiles'),
    'endingPromptFiles'
  );
  validateStringRecordField(bundle.scriptFiles, acc.scope('scriptFiles'), 'scriptFiles');
  validateBinaryAssetsField(bundle.binaryAssets, acc.scope('binaryAssets'));

  return acc.toResult(bundle);
}
