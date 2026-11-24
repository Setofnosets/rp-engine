import type { ResolvedControlRoomConfig } from '../config/control-room-config.js';
import type { CharacterSectionDef, CharacterSectionFieldType } from '../schema/character-sections.js';
import {
  type ConfirmPolicy,
  type DynamicFieldSpec,
  type GameSystemModule,
  type SpatialMode,
  type SystemCapabilities,
  cloneDynamicFieldSpec,
} from '../schema/tracker-module.js';
import { type FormDefinition, type FormIndex, buildFormIndex } from '../state/forms.js';
import type {
  CharacterEntity,
  CharacterProgression,
  CharacterStatus,
  CorruptionState,
  RelationEntry,
  ResourcePool,
  WorldState,
} from '../state/world-state.js';
import { computeLocationCast } from './cast-presence.js';

export type CharacterPresenceBucket =
  | 'player'
  | 'in_scene_pinned'
  | 'in_scene'
  | 'offscreen_located'
  | 'offscreen_unlocated'
  | 'inactive';

export interface SettingCharacterFilter {
  locationId?: string;
  status?: CharacterStatus;
  allegiance?: string;
  formGroup?: string;
  presentOnly?: boolean;
  includePlayer?: boolean;
  query?: string;
}

export interface PlayerAffinitySummary {
  affinity: number;
  maxAffinity: number;
  label: string;
}

export interface SettingCharacterSummary {
  id: string;
  name: string;
  isPlayer: boolean;
  status: CharacterStatus;
  presence: CharacterPresenceBucket;
  presentInScene: boolean;
  isPinned: boolean;
  locationId: string | null;
  locationName: string | null;
  allegiance: string;
  allegianceName: string | null;
  mood: string;
  activeFormId: string | null;
  activeFormName: string | null;
  formGroup: string | null;
  playerAffinity: PlayerAffinitySummary | null;
  populatedSectionCount: number;
  totalSectionCount: number;
}

export interface SettingRosterInspection {
  spatialMode: SpatialMode;
  activeSceneLocation: string;
  activeSceneLocationId: string | null;
  totalCharacters: number;
  presentCount: number;
  offscreenCount: number;
  inactiveCount: number;
  characters: SettingCharacterSummary[];
  byLocation: Record<string, SettingCharacterSummary[]>;
}

export interface DossierSectionEntry {
  id: string;
  name: string;
  fieldType: CharacterSectionFieldType;
  value: string | string[] | null;
  populated: boolean;
  hiddenUntilSet: boolean;
  writableByTracker: boolean;
  confirmPolicy: ConfirmPolicy;
}

export interface DossierCustomFieldEntry {
  moduleId: string;
  moduleName: string;
  fieldId: string;
  spec: DynamicFieldSpec;
  value: unknown;
}

export interface CharacterDossier {
  summary: SettingCharacterSummary;
  forms: {
    activeFormId: string | null;
    formGroup: string | null;
    availableForms: FormDefinition[];
    siblingCharacterIdsInGroup: string[];
    exclusiveActiveCharacterId: string | null;
  };
  agency: {
    mood: string;
    allegiance: string;
    allegianceName: string | null;
    agenda: string;
    goals: string[];
    traits: string[];
    abilities: string[];
  };
  sections: DossierSectionEntry[];
  customFields: DossierCustomFieldEntry[];
  progression?: CharacterProgression;
  resources?: Record<string, ResourcePool>;
  corruption?: CorruptionState;
  relations: {
    outgoing: Record<string, RelationEntry>;
    incoming: Record<string, RelationEntry>;
  };
}

export interface InspectCharacterOptions {
  filter?: SettingCharacterFilter;
  formDefinitions?: readonly FormDefinition[];
}

export interface InspectDossierOptions {
  formDefinitions?: readonly FormDefinition[];
}

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

const NON_ACTIVE_CHARACTER_STATUSES: ReadonlySet<CharacterStatus> = new Set([
  'dead',
  'captured',
  'imprisoned',
  'missing',
  'retired',
  'lost',
]);

const PRESENCE_SORT_ORDER: Record<CharacterPresenceBucket, number> = {
  player: 0,
  in_scene_pinned: 1,
  in_scene: 2,
  offscreen_located: 3,
  offscreen_unlocated: 4,
  inactive: 5,
};

const COMBAT_MODULE_IDS = new Set(['combat', 'tactical_combat']);
const PROGRESSION_MODULE_IDS = new Set(['progression', 'rpg_progression']);
const FACTION_MODULE_IDS = new Set(['factions', 'faction_agendas']);
const CLOCK_MODULE_IDS = new Set(['clocks', 'calendar_clock', 'dual_world_clock']);
const RELATIONSHIP_MODULE_IDS = new Set(['relationships', 'relationship_affinity']);
const CHRONICLE_MODULE_IDS = new Set(['chronicle', 'episodic_chronicle']);

function isSafeKey(key: string): boolean {
  return key.length > 0 && !FORBIDDEN_KEYS.has(key);
}

function getOwn<T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  if (record === undefined || !isSafeKey(key) || !Object.hasOwn(record, key)) {
    return undefined;
  }
  return Object.getOwnPropertyDescriptor(record, key)?.value as T | undefined;
}

function setOwn<T>(record: Record<string, T>, key: string, value: T): void {
  if (!isSafeKey(key)) {
    return;
  }
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

function compareIdsDeterministic(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

function cloneUnknownValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(cloneUnknownValue);
  }
  if (value instanceof Date) {
    return new Date(value.getTime());
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSafeKey(k)) {
        setOwn(out, k, cloneUnknownValue(v));
      }
    }
    return out;
  }
  return value;
}

function cloneFormDefinition(form: FormDefinition): FormDefinition {
  const cloned: FormDefinition = {
    id: form.id,
    formGroup: form.formGroup,
    characterId: form.characterId,
    displayName: form.displayName,
  };
  if (form.description !== undefined) {
    cloned.description = form.description;
  }
  if (form.abilities !== undefined) {
    cloned.abilities = [...form.abilities];
  }
  if (form.traits !== undefined) {
    cloned.traits = [...form.traits];
  }
  if (form.sections !== undefined) {
    const sections: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(form.sections)) {
      if (isSafeKey(k)) {
        setOwn(sections, k, Array.isArray(v) ? [...v] : v);
      }
    }
    cloned.sections = sections;
  }
  if (form.legalTargets !== undefined) {
    cloned.legalTargets = [...form.legalTargets];
  }
  return cloned;
}

function cloneProgression(progression: CharacterProgression): CharacterProgression {
  const cloned: CharacterProgression = {
    level: progression.level,
    xp: progression.xp,
  };
  if (progression.className !== undefined) {
    cloned.className = progression.className;
  }
  if (progression.subclass !== undefined) {
    cloned.subclass = progression.subclass;
  }
  if (progression.attributes !== undefined) {
    const attrs: Record<string, number> = {};
    for (const [k, v] of Object.entries(progression.attributes)) {
      if (isSafeKey(k)) {
        setOwn(attrs, k, v);
      }
    }
    cloned.attributes = attrs;
  }
  return cloned;
}

function cloneResources(resources: Readonly<Record<string, ResourcePool>>): Record<string, ResourcePool> {
  const out: Record<string, ResourcePool> = {};
  for (const [k, pool] of Object.entries(resources)) {
    if (isSafeKey(k)) {
      setOwn(out, k, { current: pool.current, max: pool.max });
    }
  }
  return out;
}

function cloneRelationEntry(entry: RelationEntry): RelationEntry {
  return {
    affinity: entry.affinity,
    maxAffinity: entry.maxAffinity,
    label: entry.label,
    tags: [...entry.tags],
  };
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

interface FormResolutionContext {
  formIndex: FormIndex | null;
  byFormIdGroup: Map<string, string>;
  byCharacterGroups: Map<string, Set<string>>;
}

function buildFormResolutionContext(formDefinitions?: readonly FormDefinition[]): FormResolutionContext {
  const byFormIdGroup = new Map<string, string>();
  const byCharacterGroups = new Map<string, Set<string>>();

  if (formDefinitions === undefined || formDefinitions.length === 0) {
    return { formIndex: null, byFormIdGroup, byCharacterGroups };
  }

  let formIndex: FormIndex | null = null;
  try {
    formIndex = buildFormIndex(formDefinitions);
  } catch {
    formIndex = null;
  }

  for (const def of formDefinitions) {
    if (
      typeof def.id !== 'string' ||
      def.id.length === 0 ||
      typeof def.formGroup !== 'string' ||
      def.formGroup.length === 0
    ) {
      continue;
    }
    if (!byFormIdGroup.has(def.id)) {
      byFormIdGroup.set(def.id, def.formGroup);
    }
    if (typeof def.characterId === 'string' && def.characterId.length > 0) {
      let groups = byCharacterGroups.get(def.characterId);
      if (!groups) {
        groups = new Set<string>();
        byCharacterGroups.set(def.characterId, groups);
      }
      groups.add(def.formGroup);
    }
  }

  return { formIndex, byFormIdGroup, byCharacterGroups };
}

function resolveEffectiveFormGroup(
  character: CharacterEntity,
  ctx: FormResolutionContext
): string | null {
  if (typeof character.formGroup === 'string' && character.formGroup.trim().length > 0) {
    return character.formGroup;
  }
  if (typeof character.formId === 'string' && character.formId.length > 0) {
    const group = ctx.byFormIdGroup.get(character.formId);
    if (group !== undefined) {
      return group;
    }
  }
  const byIdForm = ctx.byFormIdGroup.get(character.id);
  if (byIdForm !== undefined) {
    return byIdForm;
  }
  const charGroups = ctx.byCharacterGroups.get(character.id);
  if (charGroups && charGroups.size === 1) {
    return [...charGroups][0] ?? null;
  }
  return character.formGroup;
}

function resolveActiveFormName(
  activeFormId: string | null,
  ctx: FormResolutionContext
): string | null {
  if (activeFormId === null || activeFormId.length === 0 || ctx.formIndex === null) {
    return null;
  }
  const def = ctx.formIndex.byId.get(activeFormId);
  return def !== undefined ? def.displayName : null;
}

function resolveActiveSceneLocationName(state: WorldState): string {
  if (state.scene.location.trim().length > 0) {
    return state.scene.location;
  }
  const locId = state.scene.locationId;
  if (locId !== null) {
    const loc = getOwn(state.entities.locations, locId);
    if (loc !== undefined) {
      return loc.name;
    }
  }
  return state.scene.location;
}

function resolveLocationName(
  state: WorldState,
  locationId: string | null,
  presentInScene: boolean
): string | null {
  if (locationId !== null) {
    const loc = getOwn(state.entities.locations, locationId);
    if (loc !== undefined) {
      return loc.name;
    }
    if (locationId === state.scene.locationId && state.scene.location.trim().length > 0) {
      return state.scene.location;
    }
    return locationId.length > 0 ? locationId : null;
  }

  if (
    state.capabilities.spatialMode === 'scene_only' &&
    presentInScene &&
    state.scene.location.trim().length > 0
  ) {
    return state.scene.location;
  }

  return null;
}

function resolveAllegianceName(state: WorldState, allegiance: string): string | null {
  if (allegiance.trim().length === 0) {
    return null;
  }
  const faction = getOwn(state.entities.factions, allegiance);
  return faction !== undefined ? faction.name : null;
}

function collectPlayerRelationIds(state: WorldState): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const candidate of [state.player.id, state.player.characterId, 'player']) {
    if (typeof candidate === 'string' && isSafeKey(candidate) && !seen.has(candidate)) {
      seen.add(candidate);
      ids.push(candidate);
    }
  }
  return ids;
}

function resolvePlayerAffinity(state: WorldState, npcId: string): PlayerAffinitySummary | null {
  const playerIds = collectPlayerRelationIds(state);

  for (const pid of playerIds) {
    const fromPlayer = getOwn(state.relations, pid);
    const entry = getOwn(fromPlayer, npcId);
    if (entry !== undefined) {
      return {
        affinity: entry.affinity,
        maxAffinity: entry.maxAffinity,
        label: entry.label,
      };
    }
  }

  const fromNpc = getOwn(state.relations, npcId);
  if (fromNpc !== undefined) {
    for (const pid of playerIds) {
      const entry = getOwn(fromNpc, pid);
      if (entry !== undefined) {
        return {
          affinity: entry.affinity,
          maxAffinity: entry.maxAffinity,
          label: entry.label,
        };
      }
    }
  }

  return null;
}

function isSectionValuePopulated(value: string | string[] | null): boolean {
  if (value === null) {
    return false;
  }
  if (typeof value === 'string') {
    return value.trim().length > 0;
  }
  return value.some((item) => typeof item === 'string' && item.trim().length > 0);
}

function resolveSectionEntries(
  sectionDefs: readonly CharacterSectionDef[],
  capabilities: SystemCapabilities,
  primarySections: Readonly<Record<string, string | string[]>>,
  fallbackSections?: Readonly<Record<string, string | string[]>>
): DossierSectionEntry[] {
  const entries: DossierSectionEntry[] = [];

  for (const sec of sectionDefs) {
    if (!isSectionPermittedByCapabilities(sec.id, capabilities)) {
      continue;
    }

    const raw =
      getOwn(primarySections, sec.id) ??
      (fallbackSections !== undefined ? getOwn(fallbackSections, sec.id) : undefined);

    const value: string | string[] | null =
      raw === undefined ? null : Array.isArray(raw) ? [...raw] : raw;

    entries.push({
      id: sec.id,
      name: sec.name,
      fieldType: sec.fieldType,
      value,
      populated: isSectionValuePopulated(value),
      hiddenUntilSet: sec.hiddenUntilSet === true,
      writableByTracker: sec.writableByTracker,
      confirmPolicy: sec.confirmPolicy ?? (sec.writableByTracker ? 'auto' : 'locked'),
    });
  }

  return entries;
}

function getLinkedPlayerCharacter(state: WorldState): CharacterEntity | undefined {
  if (typeof state.player.characterId !== 'string' || !isSafeKey(state.player.characterId)) {
    return undefined;
  }
  return getOwn(state.entities.characters, state.player.characterId);
}

function resolvePlayerDisplayName(state: WorldState, linkedChar?: CharacterEntity): string {
  const playerName = state.player.name.trim();
  if (playerName.length > 0 && (playerName !== 'The Player' || linkedChar === undefined)) {
    return state.player.name;
  }
  if (linkedChar !== undefined && linkedChar.name.trim().length > 0) {
    return linkedChar.name;
  }
  return state.player.name;
}

function buildPlayerSummary(
  state: WorldState,
  config: ResolvedControlRoomConfig,
  formCtx: FormResolutionContext,
  pinnedSet: ReadonlySet<string>
): { summary: SettingCharacterSummary; traits: string[]; linkedChar?: CharacterEntity } {
  const linkedChar = getLinkedPlayerCharacter(state);
  const id = linkedChar !== undefined ? linkedChar.id : state.player.id;
  const name = resolvePlayerDisplayName(state, linkedChar);
  const status: CharacterStatus = linkedChar !== undefined ? linkedChar.status : 'active';
  const locationId = state.player.locationId ?? linkedChar?.locationId ?? state.scene.locationId;
  const locationName = resolveLocationName(state, locationId, true);
  const allegiance = linkedChar?.allegiance ?? '';
  const allegianceName = resolveAllegianceName(state, allegiance);
  const mood = linkedChar?.mood ?? 'neutral';
  const activeFormId = linkedChar?.formId ?? null;
  const activeFormName = resolveActiveFormName(activeFormId, formCtx);
  const formGroup = linkedChar !== undefined ? resolveEffectiveFormGroup(linkedChar, formCtx) : null;
  const isPinned =
    pinnedSet.has(state.player.id) || (linkedChar !== undefined && pinnedSet.has(linkedChar.id));

  const sections = resolveSectionEntries(
    config.pcCoreSections,
    config.capabilities,
    state.player.sections,
    linkedChar?.sections
  );
  const populatedSectionCount = sections.filter((s) => s.populated).length;

  return {
    summary: {
      id,
      name,
      isPlayer: true,
      status,
      presence: 'player',
      presentInScene: true,
      isPinned,
      locationId,
      locationName,
      allegiance,
      allegianceName,
      mood,
      activeFormId,
      activeFormName,
      formGroup,
      playerAffinity: null,
      populatedSectionCount,
      totalSectionCount: sections.length,
    },
    traits: linkedChar !== undefined ? [...linkedChar.traits] : [],
    ...(linkedChar !== undefined ? { linkedChar } : {}),
  };
}

function classifyNpcPresence(
  char: CharacterEntity,
  presentIdSet: ReadonlySet<string>,
  pinnedSet: ReadonlySet<string>
): CharacterPresenceBucket {
  if (NON_ACTIVE_CHARACTER_STATUSES.has(char.status)) {
    return 'inactive';
  }
  if (presentIdSet.has(char.id)) {
    return pinnedSet.has(char.id) ? 'in_scene_pinned' : 'in_scene';
  }
  if (char.locationId !== null && char.locationId.trim().length > 0) {
    return 'offscreen_located';
  }
  return 'offscreen_unlocated';
}

function buildNpcSummary(
  state: WorldState,
  config: ResolvedControlRoomConfig,
  char: CharacterEntity,
  formCtx: FormResolutionContext,
  presentIdSet: ReadonlySet<string>,
  pinnedSet: ReadonlySet<string>
): SettingCharacterSummary {
  const presence = classifyNpcPresence(char, presentIdSet, pinnedSet);
  const presentInScene = presence === 'in_scene_pinned' || presence === 'in_scene';
  const isPinned = pinnedSet.has(char.id);
  const locationName = resolveLocationName(state, char.locationId, presentInScene);
  const allegianceName = resolveAllegianceName(state, char.allegiance);
  const activeFormId = char.formId;
  const activeFormName = resolveActiveFormName(activeFormId, formCtx);
  const formGroup = resolveEffectiveFormGroup(char, formCtx);
  const playerAffinity = resolvePlayerAffinity(state, char.id);

  const sections = resolveSectionEntries(
    config.npcCoreSections,
    config.capabilities,
    char.sections
  );
  const populatedSectionCount = sections.filter((s) => s.populated).length;

  return {
    id: char.id,
    name: char.name,
    isPlayer: false,
    status: char.status,
    presence,
    presentInScene,
    isPinned,
    locationId: char.locationId,
    locationName,
    allegiance: char.allegiance,
    allegianceName,
    mood: char.mood,
    activeFormId,
    activeFormName,
    formGroup,
    playerAffinity,
    populatedSectionCount,
    totalSectionCount: sections.length,
  };
}

function matchesFilter(
  summary: SettingCharacterSummary,
  traits: readonly string[],
  filter: SettingCharacterFilter | undefined
): boolean {
  if (filter === undefined) {
    return true;
  }
  if (filter.includePlayer === false && summary.isPlayer) {
    return false;
  }
  if (filter.locationId !== undefined && summary.locationId !== filter.locationId) {
    return false;
  }
  if (filter.status !== undefined && summary.status !== filter.status) {
    return false;
  }
  if (filter.allegiance !== undefined && summary.allegiance !== filter.allegiance) {
    return false;
  }
  if (filter.formGroup !== undefined && summary.formGroup !== filter.formGroup) {
    return false;
  }
  if (filter.presentOnly === true && !summary.presentInScene) {
    return false;
  }
  if (filter.query !== undefined) {
    const q = filter.query.trim().toLowerCase();
    if (q.length > 0) {
      const matched =
        summary.id.toLowerCase().includes(q) ||
        summary.name.toLowerCase().includes(q) ||
        summary.allegiance.toLowerCase().includes(q) ||
        traits.some((trait) => trait.toLowerCase().includes(q));
      if (!matched) {
        return false;
      }
    }
  }
  return true;
}

function resolveLocationGroupKey(summary: SettingCharacterSummary): string {
  if (summary.locationId !== null && isSafeKey(summary.locationId)) {
    return summary.locationId;
  }
  if (summary.locationName !== null && isSafeKey(summary.locationName)) {
    return summary.locationName;
  }
  return 'unlocated';
}

function resolveCustomFieldValue(
  module: GameSystemModule,
  fieldId: string,
  spec: DynamicFieldSpec,
  primaryFields: Readonly<Record<string, unknown>>,
  fallbackFields?: Readonly<Record<string, unknown>>
): unknown {
  const sources: ReadonlyArray<Readonly<Record<string, unknown>>> =
    fallbackFields !== undefined ? [primaryFields, fallbackFields] : [primaryFields];

  for (const src of sources) {
    const nested = getOwn(src, module.id);
    if (isPlainRecord(nested)) {
      const nestedVal = getOwn(nested, fieldId);
      if (nestedVal !== undefined) {
        return cloneUnknownValue(nestedVal);
      }
    }
    const direct = getOwn(src, fieldId);
    if (direct !== undefined) {
      return cloneUnknownValue(direct);
    }
  }

  return cloneUnknownValue(spec.default);
}

function resolveCharacterCustomFields(
  config: ResolvedControlRoomConfig,
  target: 'player' | 'npc',
  primaryFields: Readonly<Record<string, unknown>>,
  fallbackFields?: Readonly<Record<string, unknown>>
): DossierCustomFieldEntry[] {
  const sortedModules = [...config.gameSystems]
    .filter(
      (mod) =>
        mod.enabled &&
        mod.target === target &&
        isModulePermittedByCapabilities(mod.id, config.capabilities)
    )
    .sort((a, b) => a.ui.order - b.ui.order || compareIdsDeterministic(a.id, b.id));

  const entries: DossierCustomFieldEntry[] = [];
  for (const mod of sortedModules) {
    const fieldKeys = Object.keys(mod.fields).filter(isSafeKey).sort(compareIdsDeterministic);
    for (const fieldId of fieldKeys) {
      const spec = getOwn(mod.fields, fieldId);
      if (spec === undefined) {
        continue;
      }
      entries.push({
        moduleId: mod.id,
        moduleName: mod.name,
        fieldId,
        spec: cloneDynamicFieldSpec(spec),
        value: resolveCustomFieldValue(mod, fieldId, spec, primaryFields, fallbackFields),
      });
    }
  }

  return entries;
}

function resolveRelationsForIds(
  state: WorldState,
  targetIds: readonly string[]
): {
  outgoing: Record<string, RelationEntry>;
  incoming: Record<string, RelationEntry>;
} {
  const outgoing: Record<string, RelationEntry> = {};
  const incoming: Record<string, RelationEntry> = {};
  const targetIdSet = new Set(targetIds);

  for (const selfId of targetIds) {
    const fromSelf = getOwn(state.relations, selfId);
    if (!isPlainRecord(fromSelf)) {
      continue;
    }
    const peerIds = Object.keys(fromSelf).filter(isSafeKey).sort(compareIdsDeterministic);
    for (const peerId of peerIds) {
      if (Object.hasOwn(outgoing, peerId)) {
        continue;
      }
      const entry = getOwn(fromSelf, peerId);
      if (entry !== undefined) {
        setOwn(outgoing, peerId, cloneRelationEntry(entry));
      }
    }
  }

  const allSourceIds = Object.keys(state.relations).filter(isSafeKey).sort(compareIdsDeterministic);
  for (const sourceId of allSourceIds) {
    if (targetIdSet.has(sourceId)) {
      continue;
    }
    const fromSource = getOwn(state.relations, sourceId);
    if (!isPlainRecord(fromSource)) {
      continue;
    }
    for (const selfId of targetIds) {
      const entry = getOwn(fromSource, selfId);
      if (entry !== undefined) {
        setOwn(incoming, sourceId, cloneRelationEntry(entry));
        break;
      }
    }
  }

  return { outgoing, incoming };
}

function resolveDossierForms(
  state: WorldState,
  charId: string,
  isPlayer: boolean,
  activeFormId: string | null,
  formGroup: string | null,
  formCtx: FormResolutionContext,
  presentIdSet: ReadonlySet<string>
): CharacterDossier['forms'] {
  const availableForms: FormDefinition[] = [];
  if (formCtx.formIndex !== null) {
    const seenFormIds = new Set<string>();
    const matchCharacterIds = isPlayer
      ? new Set([charId, state.player.id, 'player'])
      : new Set([charId]);

    const formIds = [...formCtx.formIndex.byId.keys()].sort(compareIdsDeterministic);
    for (const fid of formIds) {
      const def = formCtx.formIndex.byId.get(fid);
      if (def === undefined) {
        continue;
      }
      if (matchCharacterIds.has(def.characterId) || fid === activeFormId) {
        if (!seenFormIds.has(def.id)) {
          seenFormIds.add(def.id);
          availableForms.push(cloneFormDefinition(def));
        }
      }
    }
  }

  const siblingCharacterIdsInGroup: string[] = [];
  let exclusiveActiveCharacterId: string | null = null;

  if (formGroup !== null) {
    const allCharIds = Object.keys(state.entities.characters)
      .filter(isSafeKey)
      .sort(compareIdsDeterministic);

    for (const otherId of allCharIds) {
      const otherChar = getOwn(state.entities.characters, otherId);
      if (otherChar === undefined) {
        continue;
      }
      const otherGroup = resolveEffectiveFormGroup(otherChar, formCtx);
      if (otherGroup !== formGroup) {
        continue;
      }
      if (otherId !== charId) {
        siblingCharacterIdsInGroup.push(otherId);
      }
      if (exclusiveActiveCharacterId === null && presentIdSet.has(otherId)) {
        exclusiveActiveCharacterId = otherId;
      }
    }

    if (
      exclusiveActiveCharacterId === null &&
      isPlayer &&
      formGroup !== null
    ) {
      exclusiveActiveCharacterId = charId;
    }
  }

  return {
    activeFormId,
    formGroup,
    availableForms,
    siblingCharacterIdsInGroup,
    exclusiveActiveCharacterId,
  };
}

/**
 * Inspect all characters in a setting (NPCs plus optional player), classifying presence,
 * location, faction allegiance, active forms, player affinity, and section completeness.
 */
export function inspectSettingCharacters(
  state: WorldState,
  config: ResolvedControlRoomConfig,
  options: InspectCharacterOptions = {}
): SettingRosterInspection {
  const filter = options.filter;
  const formCtx = buildFormResolutionContext(options.formDefinitions);
  const cast = computeLocationCast(state, options.formDefinitions);
  const presentIdSet = new Set(cast.presentCharacterIds);
  const pinnedSet = new Set(state.scene.pinnedCharacterIds);
  const linkedPlayerCharId = state.player.characterId;

  const candidates: Array<{ summary: SettingCharacterSummary; traits: string[] }> = [];

  if (filter?.includePlayer !== false) {
    const playerEntry = buildPlayerSummary(state, config, formCtx, pinnedSet);
    candidates.push({ summary: playerEntry.summary, traits: playerEntry.traits });
  }

  const charIds = Object.keys(state.entities.characters)
    .filter(isSafeKey)
    .sort(compareIdsDeterministic);

  for (const charId of charIds) {
    if (linkedPlayerCharId !== null && charId === linkedPlayerCharId) {
      continue;
    }
    const char = getOwn(state.entities.characters, charId);
    if (char === undefined) {
      continue;
    }
    const summary = buildNpcSummary(state, config, char, formCtx, presentIdSet, pinnedSet);
    candidates.push({ summary, traits: char.traits });
  }

  const filteredSummaries = candidates
    .filter((entry) => matchesFilter(entry.summary, entry.traits, filter))
    .map((entry) => entry.summary)
    .sort(
      (a, b) =>
        PRESENCE_SORT_ORDER[a.presence] - PRESENCE_SORT_ORDER[b.presence] ||
        compareIdsDeterministic(a.id, b.id)
    );

  const byLocation: Record<string, SettingCharacterSummary[]> = {};
  let presentCount = 0;
  let offscreenCount = 0;
  let inactiveCount = 0;

  for (const summary of filteredSummaries) {
    if (summary.presentInScene) {
      presentCount += 1;
    } else if (summary.presence === 'inactive') {
      inactiveCount += 1;
    } else {
      offscreenCount += 1;
    }

    const locKey = resolveLocationGroupKey(summary);
    const existingGroup = getOwn(byLocation, locKey);
    if (existingGroup !== undefined) {
      existingGroup.push(summary);
    } else {
      setOwn(byLocation, locKey, [summary]);
    }
  }

  return {
    spatialMode: state.capabilities.spatialMode,
    activeSceneLocation: resolveActiveSceneLocationName(state),
    activeSceneLocationId: state.scene.locationId,
    totalCharacters: filteredSummaries.length,
    presentCount,
    offscreenCount,
    inactiveCount,
    characters: filteredSummaries,
    byLocation,
  };
}

function resolveDossierTarget(
  state: WorldState,
  characterIdOrName: string
): { isPlayer: boolean; char?: CharacterEntity } | null {
  const needle = characterIdOrName.trim();
  if (needle.length === 0) {
    return null;
  }

  const linkedChar = getLinkedPlayerCharacter(state);

  if (
    needle === 'player' ||
    needle === state.player.id ||
    (state.player.characterId !== null && needle === state.player.characterId)
  ) {
    return linkedChar !== undefined ? { isPlayer: true, char: linkedChar } : { isPlayer: true };
  }

  if (isSafeKey(needle) && Object.hasOwn(state.entities.characters, needle)) {
    const exactChar = getOwn(state.entities.characters, needle);
    if (exactChar !== undefined) {
      return { isPlayer: false, char: exactChar };
    }
  }

  const needleLower = needle.toLowerCase();
  const playerDisplayName = resolvePlayerDisplayName(state, linkedChar).trim().toLowerCase();
  if (
    needleLower === 'player' ||
    playerDisplayName === needleLower ||
    state.player.name.trim().toLowerCase() === needleLower ||
    (linkedChar !== undefined && linkedChar.name.trim().toLowerCase() === needleLower)
  ) {
    return linkedChar !== undefined ? { isPlayer: true, char: linkedChar } : { isPlayer: true };
  }

  const charIds = Object.keys(state.entities.characters)
    .filter(isSafeKey)
    .sort(compareIdsDeterministic);

  for (const charId of charIds) {
    if (state.player.characterId !== null && charId === state.player.characterId) {
      continue;
    }
    const char = getOwn(state.entities.characters, charId);
    if (char !== undefined && char.name.trim().toLowerCase() === needleLower) {
      return { isPlayer: false, char };
    }
  }

  return null;
}

/**
 * Inspect a single character's complete dossier (player or NPC), matching `'player'`,
 * exact character ID, or case-insensitive character name.
 */
export function inspectCharacterDossier(
  state: WorldState,
  config: ResolvedControlRoomConfig,
  characterIdOrName: string,
  options: InspectDossierOptions = {}
): CharacterDossier | null {
  const target = resolveDossierTarget(state, characterIdOrName);
  if (target === null) {
    return null;
  }

  const formCtx = buildFormResolutionContext(options.formDefinitions);
  const cast = computeLocationCast(state, options.formDefinitions);
  const presentIdSet = new Set(cast.presentCharacterIds);
  const pinnedSet = new Set(state.scene.pinnedCharacterIds);

  if (target.isPlayer) {
    const playerBuilt = buildPlayerSummary(state, config, formCtx, pinnedSet);
    const linkedChar = playerBuilt.linkedChar;
    const summary = playerBuilt.summary;

    const forms = resolveDossierForms(
      state,
      summary.id,
      true,
      summary.activeFormId,
      summary.formGroup,
      formCtx,
      presentIdSet
    );

    const sections = resolveSectionEntries(
      config.pcCoreSections,
      config.capabilities,
      state.player.sections,
      linkedChar?.sections
    );

    const customFields = resolveCharacterCustomFields(
      config,
      'player',
      state.player.customFields,
      linkedChar?.customFields
    );

    const progression = state.player.progression ?? linkedChar?.progression;
    const resources = state.player.resources ?? linkedChar?.resources;
    const corruption = linkedChar?.corruption;
    const relations = resolveRelationsForIds(state, collectPlayerRelationIds(state));

    return {
      summary,
      forms,
      agency: {
        mood: summary.mood,
        allegiance: summary.allegiance,
        allegianceName: summary.allegianceName,
        agenda: linkedChar?.agenda ?? '',
        goals: linkedChar !== undefined ? [...linkedChar.goals] : [],
        traits: linkedChar !== undefined ? [...linkedChar.traits] : [],
        abilities: linkedChar !== undefined ? [...linkedChar.abilities] : [],
      },
      sections,
      customFields,
      ...(progression !== undefined ? { progression: cloneProgression(progression) } : {}),
      ...(resources !== undefined ? { resources: cloneResources(resources) } : {}),
      ...(corruption !== undefined ? { corruption: { ...corruption } } : {}),
      relations,
    };
  }

  const char = target.char;
  if (char === undefined) {
    return null;
  }

  const summary = buildNpcSummary(state, config, char, formCtx, presentIdSet, pinnedSet);
  const forms = resolveDossierForms(
    state,
    char.id,
    false,
    summary.activeFormId,
    summary.formGroup,
    formCtx,
    presentIdSet
  );
  const sections = resolveSectionEntries(
    config.npcCoreSections,
    config.capabilities,
    char.sections
  );
  const customFields = resolveCharacterCustomFields(config, 'npc', char.customFields);
  const relations = resolveRelationsForIds(state, [char.id]);

  return {
    summary,
    forms,
    agency: {
      mood: char.mood,
      allegiance: char.allegiance,
      allegianceName: summary.allegianceName,
      agenda: char.agenda,
      goals: [...char.goals],
      traits: [...char.traits],
      abilities: [...char.abilities],
    },
    sections,
    customFields,
    ...(char.progression !== undefined ? { progression: cloneProgression(char.progression) } : {}),
    ...(char.resources !== undefined ? { resources: cloneResources(char.resources) } : {}),
    ...(char.corruption !== undefined ? { corruption: { ...char.corruption } } : {}),
    relations,
  };
}
