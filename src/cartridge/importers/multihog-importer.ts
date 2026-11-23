import {
  type SkillDefinition,
  validateSkillCatalog,
} from '../../combat/skill-registry.js';
import { type ValidationError, validationError } from '../../core/errors.js';
import { ErrorAccumulator, type Result, err, ok } from '../../core/result.js';
import {
  type CharacterSectionDef,
  type CharacterSectionFieldType,
  DEFAULT_NPC_SECTIONS,
  DEFAULT_PC_SECTIONS,
  cloneCharacterSections,
} from '../../schema/character-sections.js';
import type {
  CadencePolicy,
  CombatMode,
  ConfirmPolicy,
  DynamicFieldSpec,
  EffectOwner,
  GameSystemModule,
  ModuleScope,
  ModuleTarget,
  ModuleWidgetType,
  ProgressionMode,
  SpatialMode,
  SystemCapabilities,
  SystemPack,
  ClockMode,
} from '../../schema/tracker-module.js';
import {
  type CartridgeCombatConfig,
  isPlainObject,
  isUnsafeRecordKey,
  scanObjectForUnsafeKeys,
  setSafeProperty,
} from '../cartridge-schema.js';
import { parseAndValidateSystemPack } from '../system-pack-schema.js';

export interface MultihogImportResult {
  systemPack: SystemPack;
  combatOverrides?: CartridgeCombatConfig;
  warnings: ValidationError[];
}

const VALID_FIELD_KEY_RE = /^[a-zA-Z0-9_-]+$/;

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

function slugifyId(raw: string, fallback: string): string {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length === 0 || isUnsafeRecordKey(slug)) {
    return fallback;
  }
  return slug;
}

function sanitizeFieldKey(rawKey: string, fallback: string): string {
  const cleaned = rawKey
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (cleaned.length === 0 || isUnsafeRecordKey(cleaned) || !VALID_FIELD_KEY_RE.test(cleaned)) {
    return fallback;
  }
  return cleaned;
}

function normalizeConfirmPolicy(raw: unknown): ConfirmPolicy | undefined {
  if (raw === 'auto' || raw === 'batch_confirm' || raw === 'always_confirm' || raw === 'locked') {
    return raw;
  }
  if (raw === 'manual' || raw === 'confirm') {
    return 'always_confirm';
  }
  if (raw === 'batch') {
    return 'batch_confirm';
  }
  return undefined;
}

function normalizeCadence(raw: unknown): CadencePolicy {
  if (
    raw === 'every_turn' ||
    raw === 'on_clock_advance' ||
    raw === 'on_combat_end' ||
    raw === 'manual_only'
  ) {
    return raw;
  }
  if (isPlainObject(raw)) {
    const n = getOwnNumber(raw, 'everyNTurns');
    if (n !== undefined && Number.isInteger(n) && n >= 1) {
      return { everyNTurns: n };
    }
  }
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 1) {
    return raw === 1 ? 'every_turn' : { everyNTurns: raw };
  }
  return 'every_turn';
}

function normalizeSectionFieldType(raw: unknown): CharacterSectionFieldType {
  if (raw === 'prose' || raw === 'bullet_list' || raw === 'stat_block') {
    return raw;
  }
  if (raw === 'list' || raw === 'bullets' || raw === 'array' || raw === 'tags' || raw === 'string_list') {
    return 'bullet_list';
  }
  if (raw === 'stats' || raw === 'statblock' || raw === 'table') {
    return 'stat_block';
  }
  return 'prose';
}

function convertSections(
  rawSections: unknown,
  fallbackDefaults: readonly CharacterSectionDef[],
  prefix: string,
  warnings: ValidationError[]
): CharacterSectionDef[] {
  if (rawSections === undefined) {
    return cloneCharacterSections(fallbackDefaults);
  }
  if (!Array.isArray(rawSections)) {
    warnings.push(
      validationError(prefix, 'INVALID_SECTIONS', `${prefix} was not an array; using defaults`)
    );
    return cloneCharacterSections(fallbackDefaults);
  }

  const out: CharacterSectionDef[] = [];
  const seenIds = new Set<string>();

  for (let i = 0; i < rawSections.length; i += 1) {
    const rawItem = rawSections[i];
    if (!isPlainObject(rawItem)) {
      warnings.push(
        validationError(`${prefix}[${i}]`, 'SKIPPED_SECTION', 'Non-object character section skipped')
      );
      continue;
    }

    const name =
      getOwnString(rawItem, 'name')?.trim() ||
      getOwnString(rawItem, 'label')?.trim() ||
      getOwnString(rawItem, 'title')?.trim() ||
      `Section ${i + 1}`;

    const rawId = getOwnString(rawItem, 'id')?.trim() || slugifyId(name, `sec_${i + 1}`);
    let id = isUnsafeRecordKey(rawId) ? `sec_${i + 1}` : rawId;
    if (seenIds.has(id)) {
      id = `${id}_${i + 1}`;
    }
    seenIds.add(id);

    const description = getOwnString(rawItem, 'description') ?? getOwnString(rawItem, 'prompt') ?? '';
    const icon = getOwnString(rawItem, 'icon') ?? '📋';
    const color = getOwnString(rawItem, 'color')?.trim() || '#64748b';
    const fieldType = normalizeSectionFieldType(
      getOwnValue(rawItem, 'fieldType') ?? getOwnValue(rawItem, 'type')
    );
    const hiddenUntilSet = getOwnBoolean(rawItem, 'hiddenUntilSet');
    const writableByTracker =
      getOwnBoolean(rawItem, 'writableByTracker') ??
      !(getOwnBoolean(rawItem, 'readOnly') ?? false);
    const confirmPolicy = normalizeConfirmPolicy(getOwnValue(rawItem, 'confirmPolicy'));
    const cadence = normalizeCadence(getOwnValue(rawItem, 'cadence'));

    out.push({
      id,
      name,
      description,
      icon,
      color,
      fieldType,
      ...(hiddenUntilSet !== undefined ? { hiddenUntilSet } : {}),
      writableByTracker,
      ...(confirmPolicy !== undefined ? { confirmPolicy } : {}),
      cadence,
    });
  }

  return out;
}

function convertFieldSpec(
  rawSpec: Record<string, unknown>,
  path: string,
  warnings: ValidationError[]
): DynamicFieldSpec {
  const rawType = (
    getOwnString(rawSpec, 'type') ??
    getOwnString(rawSpec, 'kind') ??
    'string'
  ).toLowerCase();
  const writableByTracker =
    getOwnBoolean(rawSpec, 'writableByTracker') ??
    !(getOwnBoolean(rawSpec, 'locked') ?? getOwnBoolean(rawSpec, 'readOnly') ?? false);
  const confirmPolicy = normalizeConfirmPolicy(getOwnValue(rawSpec, 'confirmPolicy'));
  const description = getOwnString(rawSpec, 'description') ?? getOwnString(rawSpec, 'label');

  const common = {
    writableByTracker,
    ...(confirmPolicy !== undefined ? { confirmPolicy } : {}),
    ...(description !== undefined ? { description } : {}),
  };

  if (rawType === 'meter' || rawType === 'bar' || rawType === 'gauge' || rawType === 'float') {
    const rawMin = getOwnNumber(rawSpec, 'min') ?? 0;
    const rawMax = getOwnNumber(rawSpec, 'max') ?? Math.max(100, rawMin);
    const min = Math.min(rawMin, rawMax);
    const max = Math.max(rawMin, rawMax);
    const rawDef = getOwnNumber(rawSpec, 'default') ?? min;
    const def = Math.min(max, Math.max(min, rawDef));
    return { type: 'meter', min, max, default: def, ...common };
  }

  if (rawType === 'counter' || rawType === 'number' || rawType === 'int' || rawType === 'integer') {
    const rawMin = getOwnNumber(rawSpec, 'min');
    const rawMax = getOwnNumber(rawSpec, 'max');
    const min = rawMin !== undefined ? Math.trunc(rawMin) : undefined;
    const max = rawMax !== undefined ? Math.trunc(rawMax) : undefined;
    const orderedMin = min !== undefined && max !== undefined ? Math.min(min, max) : min;
    const orderedMax = min !== undefined && max !== undefined ? Math.max(min, max) : max;
    let def = Math.round(getOwnNumber(rawSpec, 'default') ?? orderedMin ?? 0);
    if (orderedMin !== undefined && def < orderedMin) {
      def = orderedMin;
    }
    if (orderedMax !== undefined && def > orderedMax) {
      def = orderedMax;
    }
    return {
      type: 'counter',
      ...(orderedMin !== undefined ? { min: orderedMin } : {}),
      ...(orderedMax !== undefined ? { max: orderedMax } : {}),
      default: def,
      ...common,
    };
  }

  if (rawType === 'enum' || rawType === 'select' || rawType === 'choice') {
    const rawOptions = getOwnValue(rawSpec, 'options') ?? getOwnValue(rawSpec, 'choices');
    const options: string[] = [];
    const seen = new Set<string>();
    if (Array.isArray(rawOptions)) {
      for (const opt of rawOptions) {
        if (typeof opt === 'string' && opt.length > 0 && !seen.has(opt)) {
          seen.add(opt);
          options.push(opt);
        }
      }
    }
    if (options.length === 0) {
      warnings.push(
        validationError(path, 'EMPTY_ENUM_OPTIONS', 'Enum field had no options; falling back to ["default"]')
      );
      options.push('default');
    }
    const rawDefault = getOwnString(rawSpec, 'default');
    const def = rawDefault !== undefined && seen.has(rawDefault) ? rawDefault : options[0]!;
    return { type: 'enum', options, default: def, ...common };
  }

  if (rawType === 'boolean' || rawType === 'bool' || rawType === 'toggle' || rawType === 'checkbox') {
    const def = getOwnBoolean(rawSpec, 'default') ?? false;
    return { type: 'boolean', default: def, ...common };
  }

  if (
    rawType === 'string_list' ||
    rawType === 'list' ||
    rawType === 'array' ||
    rawType === 'tags' ||
    rawType === 'string[]'
  ) {
    const rawDef = getOwnValue(rawSpec, 'default');
    const def = Array.isArray(rawDef)
      ? rawDef.filter((item): item is string => typeof item === 'string')
      : [];
    const rawMaxItems = getOwnNumber(rawSpec, 'maxItems');
    const maxItems =
      rawMaxItems !== undefined && Number.isInteger(rawMaxItems) && rawMaxItems >= def.length
        ? rawMaxItems
        : undefined;
    return {
      type: 'string_list',
      ...(maxItems !== undefined ? { maxItems } : {}),
      default: def,
      ...common,
    };
  }

  const rawDef = getOwnValue(rawSpec, 'default');
  const def = typeof rawDef === 'string' ? rawDef : rawDef === undefined || rawDef === null ? '' : String(rawDef);
  const rawMaxLen = getOwnNumber(rawSpec, 'maxLength');
  const maxLength =
    rawMaxLen !== undefined && Number.isInteger(rawMaxLen) && rawMaxLen >= def.length
      ? rawMaxLen
      : undefined;
  return {
    type: 'string',
    ...(maxLength !== undefined ? { maxLength } : {}),
    default: def,
    ...common,
  };
}

function normalizeScope(raw: unknown): ModuleScope {
  return raw === 'global' ? 'global' : 'session';
}

function normalizeTarget(raw: unknown): ModuleTarget {
  if (raw === 'global' || raw === 'player' || raw === 'npc' || raw === 'location') {
    return raw;
  }
  if (raw === 'character' || raw === 'pc') {
    return 'player';
  }
  return 'global';
}

function normalizeEffectOwner(raw: unknown): EffectOwner {
  if (raw === 'engine' || raw === 'tracker' || raw === 'hybrid') {
    return raw;
  }
  return 'tracker';
}

function normalizeWidget(raw: unknown): ModuleWidgetType {
  if (raw === 'bar' || raw === 'badge' || raw === 'tags' || raw === 'card' || raw === 'hidden') {
    return raw;
  }
  return 'card';
}

function convertGameSystems(
  rawSystems: unknown,
  warnings: ValidationError[]
): GameSystemModule[] {
  const modules: GameSystemModule[] = [];
  const seenIds = new Set<string>();

  const processModuleEntry = (
    rawMod: Record<string, unknown>,
    fallbackId: string,
    index: number
  ): void => {
    const rawId = getOwnString(rawMod, 'id')?.trim() || fallbackId;
    let id = isUnsafeRecordKey(rawId) ? fallbackId : rawId;
    if (seenIds.has(id)) {
      id = `${id}_${index + 1}`;
    }
    seenIds.add(id);

    const name =
      getOwnString(rawMod, 'name')?.trim() ||
      getOwnString(rawMod, 'title')?.trim() ||
      id;
    const description = getOwnString(rawMod, 'description');
    const enabled = getOwnBoolean(rawMod, 'enabled') ?? true;
    const scope = normalizeScope(getOwnValue(rawMod, 'scope'));
    const target = normalizeTarget(getOwnValue(rawMod, 'target'));
    const effectOwner = normalizeEffectOwner(getOwnValue(rawMod, 'effectOwner'));
    const cadence = normalizeCadence(getOwnValue(rawMod, 'cadence'));

    const fields: Record<string, DynamicFieldSpec> = {};
    const rawFields = getOwnValue(rawMod, 'fields');
    if (isPlainObject(rawFields)) {
      for (const rawKey of Object.keys(rawFields)) {
        if (isUnsafeRecordKey(rawKey)) {
          continue;
        }
        const rawSpec = getOwnValue(rawFields, rawKey);
        if (!isPlainObject(rawSpec)) {
          continue;
        }
        const key = sanitizeFieldKey(rawKey, `field_${Object.keys(fields).length + 1}`);
        setSafeProperty(
          fields,
          key,
          convertFieldSpec(rawSpec, `gameSystems.${id}.fields.${key}`, warnings)
        );
      }
    } else if (Array.isArray(rawFields)) {
      for (let fIdx = 0; fIdx < rawFields.length; fIdx += 1) {
        const rawSpec = rawFields[fIdx];
        if (!isPlainObject(rawSpec)) {
          continue;
        }
        const rawKey =
          getOwnString(rawSpec, 'id') ??
          getOwnString(rawSpec, 'key') ??
          getOwnString(rawSpec, 'name') ??
          `field_${fIdx + 1}`;
        const key = sanitizeFieldKey(rawKey, `field_${fIdx + 1}`);
        setSafeProperty(
          fields,
          key,
          convertFieldSpec(rawSpec, `gameSystems.${id}.fields.${key}`, warnings)
        );
      }
    }

    const trackerInstruction =
      getOwnString(rawMod, 'trackerInstruction') ??
      getOwnString(rawMod, 'instruction') ??
      '';
    const narratorRule =
      getOwnString(rawMod, 'narratorRule') ??
      getOwnString(rawMod, 'promptRule') ??
      '';

    const rawUi = getOwnValue(rawMod, 'ui');
    const uiObj = isPlainObject(rawUi) ? rawUi : {};
    const widget = normalizeWidget(getOwnValue(uiObj, 'widget'));
    const order = getOwnNumber(uiObj, 'order') ?? index + 1;

    modules.push({
      id,
      name,
      ...(description !== undefined ? { description } : {}),
      enabled,
      scope,
      target,
      effectOwner,
      cadence,
      fields,
      trackerInstruction,
      narratorRule,
      ui: { widget, order },
    });
  };

  if (Array.isArray(rawSystems)) {
    for (let i = 0; i < rawSystems.length; i += 1) {
      const item = rawSystems[i];
      if (!isPlainObject(item)) {
        warnings.push(
          validationError(`gameSystems[${i}]`, 'SKIPPED_MODULE', 'Non-object gameSystem skipped')
        );
        continue;
      }
      processModuleEntry(item, `system_${i + 1}`, i);
    }
  } else if (isPlainObject(rawSystems)) {
    const keys = Object.keys(rawSystems).filter((k) => !isUnsafeRecordKey(k)).sort();
    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[i]!;
      const item = getOwnValue(rawSystems, key);
      if (isPlainObject(item)) {
        processModuleEntry(item, slugifyId(key, `system_${i + 1}`), i);
      }
    }
  }

  return modules;
}

function appendCustomFieldsModules(
  rawCustomFields: unknown,
  modules: GameSystemModule[],
  warnings: ValidationError[]
): void {
  if (rawCustomFields === undefined || rawCustomFields === null) {
    return;
  }

  const byTarget = new Map<ModuleTarget, Record<string, DynamicFieldSpec>>();
  const addFieldForTarget = (
    target: ModuleTarget,
    rawKey: string,
    rawSpec: Record<string, unknown>,
    idx: number
  ): void => {
    const key = sanitizeFieldKey(rawKey, `custom_${idx + 1}`);
    let record = byTarget.get(target);
    if (!record) {
      record = {};
      byTarget.set(target, record);
    }
    if (!Object.hasOwn(record, key)) {
      setSafeProperty(
        record,
        key,
        convertFieldSpec(rawSpec, `customFields.${key}`, warnings)
      );
    }
  };

  if (Array.isArray(rawCustomFields)) {
    for (let i = 0; i < rawCustomFields.length; i += 1) {
      const item = rawCustomFields[i];
      if (!isPlainObject(item)) {
        continue;
      }
      const rawKey =
        getOwnString(item, 'key') ??
        getOwnString(item, 'id') ??
        getOwnString(item, 'name') ??
        `custom_${i + 1}`;
      const target = normalizeTarget(getOwnValue(item, 'target'));
      addFieldForTarget(target, rawKey, item, i);
    }
  } else if (isPlainObject(rawCustomFields)) {
    const keys = Object.keys(rawCustomFields).filter((k) => !isUnsafeRecordKey(k)).sort();
    for (let i = 0; i < keys.length; i += 1) {
      const rawKey = keys[i]!;
      const item = getOwnValue(rawCustomFields, rawKey);
      if (!isPlainObject(item)) {
        continue;
      }
      const target = normalizeTarget(getOwnValue(item, 'target'));
      addFieldForTarget(target, rawKey, item, i);
    }
  }

  const existingIds = new Set(modules.map((m) => m.id));
  const usedFieldKeysByTarget = new Map<ModuleTarget, Set<string>>();
  for (const mod of modules) {
    let set = usedFieldKeysByTarget.get(mod.target);
    if (!set) {
      set = new Set<string>();
      usedFieldKeysByTarget.set(mod.target, set);
    }
    for (const k of Object.keys(mod.fields)) {
      set.add(k);
    }
  }

  for (const target of ['global', 'player', 'npc', 'location'] as const) {
    const fields = byTarget.get(target);
    if (!fields) {
      continue;
    }
    const existingKeys = usedFieldKeysByTarget.get(target) ?? new Set<string>();
    const filteredFields: Record<string, DynamicFieldSpec> = {};
    for (const k of Object.keys(fields)) {
      if (existingKeys.has(k)) {
        warnings.push(
          validationError(
            `customFields.${k}`,
            'FIELD_COLLISION_SKIPPED',
            `Custom field "${k}" for target "${target}" collides with an existing gameSystem field and was skipped`
          )
        );
        continue;
      }
      const spec = getOwnValue(fields, k) as DynamicFieldSpec | undefined;
      if (spec) {
        setSafeProperty(filteredFields, k, spec);
      }
    }

    if (Object.keys(filteredFields).length === 0) {
      continue;
    }

    let modId = target === 'global' ? 'custom_fields' : `custom_fields_${target}`;
    while (existingIds.has(modId)) {
      modId = `${modId}_ext`;
    }
    existingIds.add(modId);

    modules.push({
      id: modId,
      name: target === 'global' ? 'Custom Fields' : `Custom Fields (${target})`,
      description: `Imported Multihog custom fields for target ${target}`,
      enabled: true,
      scope: 'session',
      target,
      effectOwner: 'tracker',
      cadence: 'every_turn',
      fields: filteredFields,
      trackerInstruction: `Update ${modId} custom fields only when explicitly evidenced in the scene.`,
      narratorRule: '',
      ui: { widget: 'card', order: modules.length + 1 },
    });
  }
}

function appendPacingAndCyoaModules(
  payload: Record<string, unknown>,
  modules: GameSystemModule[],
  basePrompts: Record<string, string>
): void {
  const existingIds = new Set(modules.map((m) => m.id));

  const rawPacing = getOwnValue(payload, 'narrativePacing');
  if (rawPacing !== undefined && !existingIds.has('narrative_pacing')) {
    const pacingDefault =
      typeof rawPacing === 'string' &&
      (rawPacing === 'slow_burn' || rawPacing === 'balanced' || rawPacing === 'fast_forward')
        ? rawPacing
        : isPlainObject(rawPacing) &&
            (getOwnString(rawPacing, 'mode') === 'slow_burn' ||
              getOwnString(rawPacing, 'mode') === 'balanced' ||
              getOwnString(rawPacing, 'mode') === 'fast_forward')
          ? (getOwnString(rawPacing, 'mode') as string)
          : 'balanced';

    const pacingRule = isPlainObject(rawPacing)
      ? getOwnString(rawPacing, 'narratorRule') ??
        getOwnString(rawPacing, 'instruction') ??
        'Match prose rhythm to the active narrative pacing mode.'
      : 'Match prose rhythm to the active narrative pacing mode.';

    modules.push({
      id: 'narrative_pacing',
      name: 'Narrative Pacing',
      description: 'Imported Multihog narrative pacing configuration.',
      enabled: isPlainObject(rawPacing) ? (getOwnBoolean(rawPacing, 'enabled') ?? true) : true,
      scope: 'session',
      target: 'global',
      effectOwner: 'tracker',
      cadence: 'every_turn',
      fields: {
        pacing: {
          type: 'enum',
          options: ['slow_burn', 'balanced', 'fast_forward'],
          default: pacingDefault,
          writableByTracker: true,
          confirmPolicy: 'auto',
          description: 'Active narrative pacing tempo',
        },
      },
      trackerInstruction: 'Adjust pacing only when narrative tempo shifts clearly.',
      narratorRule: pacingRule,
      ui: { widget: 'tags', order: modules.length + 1 },
    });
    existingIds.add('narrative_pacing');
  }

  const rawCyoa = getOwnValue(payload, 'cyoaConfig');
  if (isPlainObject(rawCyoa)) {
    const enabled = getOwnBoolean(rawCyoa, 'enabled') ?? true;
    const prompt = getOwnString(rawCyoa, 'prompt') ?? getOwnString(rawCyoa, 'instruction');
    if (prompt && prompt.trim().length > 0) {
      setSafeProperty(basePrompts, 'cyoa', prompt.trim());
    }
    if (!existingIds.has('cyoa_choices')) {
      modules.push({
        id: 'cyoa_choices',
        name: 'CYOA Choices',
        description: 'Imported Multihog interactive choice configuration.',
        enabled,
        scope: 'session',
        target: 'global',
        effectOwner: 'hybrid',
        cadence: 'every_turn',
        fields: {},
        trackerInstruction: '',
        narratorRule:
          prompt?.trim() ||
          'Offer concise, meaningful player decision points when appropriate without overriding agency.',
        ui: { widget: 'hidden', order: modules.length + 1 },
      });
    }
  }
}

function inferCapabilities(
  payload: Record<string, unknown>,
  modules: readonly GameSystemModule[],
  hasSkills: boolean
): SystemCapabilities {
  const rawCaps = getOwnValue(payload, 'capabilities');
  const capsObj = isPlainObject(rawCaps) ? rawCaps : {};

  const rawSpatial = getOwnValue(capsObj, 'spatialMode');
  const spatialMode: SpatialMode =
    rawSpatial === 'scene_only' || rawSpatial === 'emergent' || rawSpatial === 'authored_graph'
      ? rawSpatial
      : 'emergent';

  const hasCombatMod = modules.some(
    (m) => m.enabled && (m.id === 'combat' || m.id === 'tactical_combat')
  );
  const rawCombat = getOwnValue(capsObj, 'combatMode');
  const combatMode: CombatMode =
    rawCombat === 'tactical_grid' || rawCombat === 'traditional' || rawCombat === 'disabled'
      ? rawCombat
      : hasSkills || hasCombatMod
        ? 'tactical_grid'
        : 'disabled';

  const hasProgMod = modules.some(
    (m) => m.enabled && (m.id === 'progression' || m.id === 'rpg_progression')
  );
  const rawProg = getOwnValue(capsObj, 'progression');
  const progression: ProgressionMode =
    rawProg === 'rpg_levels' || rawProg === 'point_buy' || rawProg === 'disabled'
      ? rawProg
      : hasProgMod
        ? 'rpg_levels'
        : 'disabled';

  const rawClocks = getOwnValue(capsObj, 'clocks');
  const clocks: ClockMode =
    rawClocks === 'full_sim' || rawClocks === 'calendar_only' || rawClocks === 'disabled'
      ? rawClocks
      : 'calendar_only';

  return {
    spatialMode,
    combatMode,
    progression,
    clocks,
    factions: getOwnBoolean(capsObj, 'factions') ?? false,
    beats: getOwnBoolean(capsObj, 'beats') ?? false,
    relationships: getOwnBoolean(capsObj, 'relationships') ?? true,
    chronicle: getOwnBoolean(capsObj, 'chronicle') ?? true,
  };
}

function extractStringArray(raw: unknown, fallback: readonly string[]): string[] {
  if (!Array.isArray(raw)) {
    return [...fallback];
  }
  const filtered = raw.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  return filtered.length > 0 ? filtered : [...fallback];
}

function extractSkills(
  rawSkills: unknown,
  warnings: ValidationError[]
): CartridgeCombatConfig | undefined {
  if (rawSkills === undefined || rawSkills === null) {
    return undefined;
  }
  if (!Array.isArray(rawSkills)) {
    warnings.push(
      validationError('skills', 'INVALID_SKILLS', 'Multihog skills payload is not an array; ignored')
    );
    return undefined;
  }

  const candidates: SkillDefinition[] = [];
  for (let i = 0; i < rawSkills.length; i += 1) {
    const item = rawSkills[i];
    if (!isPlainObject(item)) {
      continue;
    }
    const res = validateSkillCatalog([item as unknown as SkillDefinition]);
    if (res.ok) {
      candidates.push(item as unknown as SkillDefinition);
    } else {
      warnings.push(
        validationError(
          `skills[${i}]`,
          'SKIPPED_SKILL',
          `Multihog skill at index ${i} did not match SkillDefinition schema and was skipped`
        )
      );
    }
  }

  return candidates.length > 0 ? { skills: candidates } : undefined;
}

/**
 * Import a Combat-Multihog cartridge (wrapper `{ format: 'multihog-game-cartridge', name, payload }`
 * or flat payload object) into a validated `system-pack/0.1` {@link SystemPack} and optional
 * {@link CartridgeCombatConfig}.
 */
export function importMultihogCartridge(
  rawPayload: unknown,
  options: { id?: string; name?: string } = {}
): Result<MultihogImportResult, ValidationError[]> {
  if (!isPlainObject(rawPayload)) {
    return err([
      validationError('', 'INVALID_TYPE', 'Multihog cartridge input must be a non-null plain object'),
    ]);
  }

  const acc = new ErrorAccumulator();
  scanObjectForUnsafeKeys(rawPayload, acc);
  if (acc.hasErrors()) {
    return err([...acc.errors]);
  }

  const sanitizedRoot = sanitizeJsonValue(rawPayload) as Record<string, unknown>;
  const format = getOwnString(sanitizedRoot, 'format');
  const maybePayload = getOwnValue(sanitizedRoot, 'payload');

  let payload: Record<string, unknown>;
  if (format === 'multihog-game-cartridge' || isPlainObject(maybePayload)) {
    if (!isPlainObject(maybePayload)) {
      return err([
        validationError('payload', 'INVALID_TYPE', 'Multihog wrapper must contain a plain payload object'),
      ]);
    }
    payload = maybePayload;
  } else {
    payload = sanitizedRoot;
  }

  const warnings: ValidationError[] = [];

  const name =
    options.name?.trim() ||
    getOwnString(sanitizedRoot, 'name')?.trim() ||
    getOwnString(payload, 'name')?.trim() ||
    'Imported Multihog System';

  const id =
    options.id?.trim() ||
    getOwnString(payload, 'id')?.trim() ||
    getOwnString(sanitizedRoot, 'id')?.trim() ||
    slugifyId(name, 'multihog-system');

  const description =
    getOwnString(payload, 'description') ??
    getOwnString(sanitizedRoot, 'description') ??
    `Imported Combat-Multihog system pack (${name})`;

  const pcCoreSections = convertSections(
    getOwnValue(payload, 'pcCoreSections'),
    DEFAULT_PC_SECTIONS,
    'pcCoreSections',
    warnings
  );
  const npcCoreSections = convertSections(
    getOwnValue(payload, 'npcCoreSections'),
    DEFAULT_NPC_SECTIONS,
    'npcCoreSections',
    warnings
  );

  const gameSystems = convertGameSystems(getOwnValue(payload, 'gameSystems'), warnings);
  appendCustomFieldsModules(getOwnValue(payload, 'customFields'), gameSystems, warnings);

  const basePrompts: Record<string, string> = {};
  const rawBasePrompts = getOwnValue(payload, 'basePrompts');
  if (isPlainObject(rawBasePrompts)) {
    for (const k of Object.keys(rawBasePrompts)) {
      if (!isUnsafeRecordKey(k)) {
        const v = getOwnString(rawBasePrompts, k);
        if (v !== undefined) {
          setSafeProperty(basePrompts, k, v);
        }
      }
    }
  }

  appendPacingAndCyoaModules(payload, gameSystems, basePrompts);

  const combatOverrides = extractSkills(getOwnValue(payload, 'skills'), warnings);
  const capabilities = inferCapabilities(
    payload,
    gameSystems,
    combatOverrides !== undefined && (combatOverrides.skills?.length ?? 0) > 0
  );

  const blockOrder = extractStringArray(getOwnValue(payload, 'blockOrder'), [
    'SCENE',
    'CHARACTER',
    'RELATIONSHIPS',
    'TIME',
    'CHRONICLE',
  ]);
  const syspromptSectionOrder = extractStringArray(getOwnValue(payload, 'syspromptSectionOrder'), [
    'system',
    'narrative_pacing',
    'game_system_rules',
    'persona',
    'card',
    'state',
    'world',
    'transcript_window',
    'latest_input',
  ]);

  const rawPackCandidate: Record<string, unknown> = {
    spec: 'system-pack/0.1',
    id,
    name,
    description,
    capabilities,
    pcCoreSections,
    npcCoreSections,
    gameSystems,
    blockOrder,
    syspromptSectionOrder,
    ...(Object.keys(basePrompts).length > 0 ? { basePrompts } : {}),
  };

  const validated = parseAndValidateSystemPack(rawPackCandidate);
  if (!validated.ok) {
    return validated;
  }

  return ok({
    systemPack: validated.value,
    ...(combatOverrides !== undefined ? { combatOverrides } : {}),
    warnings,
  });
}
