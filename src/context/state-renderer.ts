import type { ResolvedControlRoomConfig } from '../config/control-room-config.js';
import { formatClockDisplay } from '../core/world-clock.js';
import type { GameSystemModule, SystemCapabilities } from '../schema/tracker-module.js';
import type { FormDefinition } from '../state/forms.js';
import type {
  CharacterEntity,
  CharacterProgression,
  FactionEntity,
  RelationEntry,
  ResourcePool,
  ThreatEntity,
  WorldState,
} from '../state/world-state.js';
import { computeLocationCast } from '../world/cast-presence.js';
import { clipTextToTokenBudget, estimateTokens, fitItemsToBudget } from './tokenizer-budget.js';

/**
 * Parameters accepted by {@link renderWorldStateBlock}.
 */
export interface RenderWorldStateParams {
  state: WorldState;
  config: ResolvedControlRoomConfig;
  maxTokens?: number;
  formDefinitions?: readonly FormDefinition[];
}

interface RenderedStateItem {
  text: string;
  blockSlot: number;
  sequence: number;
  priority: number;
}

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

const COMBAT_MODULE_IDS = new Set(['combat', 'tactical_combat']);
const PROGRESSION_MODULE_IDS = new Set(['progression', 'rpg_progression']);
const FACTION_MODULE_IDS = new Set(['factions', 'faction_agendas']);
const CLOCK_MODULE_IDS = new Set(['clocks', 'calendar_clock', 'dual_world_clock']);
const RELATIONSHIP_MODULE_IDS = new Set(['relationships', 'relationship_affinity']);
const CHRONICLE_MODULE_IDS = new Set(['chronicle', 'episodic_chronicle']);

const BUILTIN_GLOBAL_MODULE_FIELDS_HANDLED_ELSEWHERE = new Set([
  'location',
  'mood',
  'presentCharacterIds',
  'time_of_day',
  'pacing',
  'scene_focus',
  'milestone_note',
  'clock_hold_recommended',
  'rumor_hook',
]);

const BUILTIN_RPG_PLAYER_FIELDS = new Set(['level', 'xp', 'class', 'gold', 'hp', 'willpower', 'stamina']);

const CANONICAL_RESOURCE_ORDER = ['hp', 'willpower', 'stamina', 'mana'];

export function isSafeRecordKey(key: string): boolean {
  return key.length > 0 && !FORBIDDEN_KEYS.has(key);
}

export function getOwnSafe<T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  if (record === undefined || typeof record !== 'object' || record === null) {
    return undefined;
  }
  if (!isSafeRecordKey(key) || !Object.hasOwn(record, key)) {
    return undefined;
  }
  return Object.getOwnPropertyDescriptor(record, key)?.value as T | undefined;
}

export function setOwnSafe<T>(record: Record<string, T>, key: string, value: T): void {
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

export function compareStringsDeterministic(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

/**
 * Intersect state and control-room capabilities so disabled capabilities on either layer
 * suppress the corresponding blocks and system rules.
 */
export function resolveEffectiveCapabilities(
  stateCaps: SystemCapabilities,
  configCaps: SystemCapabilities
): SystemCapabilities {
  const spatialMode =
    stateCaps.spatialMode === 'scene_only' || configCaps.spatialMode === 'scene_only'
      ? 'scene_only'
      : stateCaps.spatialMode === 'emergent' || configCaps.spatialMode === 'emergent'
        ? 'emergent'
        : 'authored_graph';

  const combatMode =
    stateCaps.combatMode === 'disabled' || configCaps.combatMode === 'disabled'
      ? 'disabled'
      : configCaps.combatMode;

  const progression =
    stateCaps.progression === 'disabled' || configCaps.progression === 'disabled'
      ? 'disabled'
      : configCaps.progression;

  const clocks =
    stateCaps.clocks === 'disabled' || configCaps.clocks === 'disabled'
      ? 'disabled'
      : stateCaps.clocks === 'calendar_only' || configCaps.clocks === 'calendar_only'
        ? 'calendar_only'
        : 'full_sim';

  return {
    spatialMode,
    combatMode,
    progression,
    clocks,
    factions: stateCaps.factions && configCaps.factions,
    beats: stateCaps.beats && configCaps.beats,
    relationships: stateCaps.relationships && configCaps.relationships,
    chronicle: stateCaps.chronicle && configCaps.chronicle,
  };
}

/**
 * Check whether a {@link GameSystemModule} is permitted by the resolved {@link SystemCapabilities}.
 */
export function isModulePermittedByCapabilities(
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

/**
 * Check if all matching modules in `ids` present in `config.gameSystems` are explicitly disabled.
 */
export function isModuleCategoryExplicitlyDisabled(
  config: ResolvedControlRoomConfig,
  ids: ReadonlySet<string>
): boolean {
  const matching = config.gameSystems.filter((mod) => ids.has(mod.id));
  if (matching.length === 0) {
    return false;
  }
  return matching.every((mod) => !mod.enabled);
}

/**
 * Return enabled and capability-permitted {@link GameSystemModule}s sorted deterministically.
 */
export function getActiveGameSystemModules(
  config: ResolvedControlRoomConfig,
  capabilities: SystemCapabilities
): GameSystemModule[] {
  return config.gameSystems
    .filter((mod) => mod.enabled && isModulePermittedByCapabilities(mod.id, capabilities))
    .slice()
    .sort((a, b) => a.ui.order - b.ui.order || compareStringsDeterministic(a.id, b.id));
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

function formatCompactValue(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : null;
  }
  if (typeof value === 'boolean') {
    return value ? 'yes' : 'no';
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => formatCompactValue(item))
      .filter((item): item is string => item !== null);
    return parts.length > 0 ? parts.join(', ') : null;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>)
      .filter(isSafeRecordKey)
      .sort(compareStringsDeterministic);
    const pairs: string[] = [];
    for (const k of keys) {
      const inner = getOwnSafe(value as Record<string, unknown>, k);
      const formatted = formatCompactValue(inner);
      if (formatted !== null) {
        pairs.push(`${k}=${formatted}`);
      }
    }
    return pairs.length > 0 ? pairs.join(', ') : null;
  }
  return null;
}

function formatSectionValue(value: string | readonly string[] | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (Array.isArray(value)) {
    const items = value
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .map((item) => item.trim());
    return items.length > 0 ? items.join('; ') : null;
  }
  return null;
}

function formatResourcesSummary(resources: Readonly<Record<string, ResourcePool>> | undefined): string | null {
  if (resources === undefined) {
    return null;
  }
  const safeKeys = Object.keys(resources).filter(isSafeRecordKey);
  if (safeKeys.length === 0) {
    return null;
  }

  const orderedKeys: string[] = [];
  for (const canonical of CANONICAL_RESOURCE_ORDER) {
    if (Object.hasOwn(resources, canonical)) {
      orderedKeys.push(canonical);
    }
  }
  const restKeys = safeKeys
    .filter((k) => !CANONICAL_RESOURCE_ORDER.includes(k))
    .sort(compareStringsDeterministic);
  for (const k of restKeys) {
    orderedKeys.push(k);
  }

  const parts: string[] = [];
  for (const key of orderedKeys) {
    const pool = getOwnSafe(resources, key);
    if (pool && Number.isFinite(pool.current) && Number.isFinite(pool.max)) {
      const label = key === 'hp' ? 'HP' : key.charAt(0).toUpperCase() + key.slice(1);
      parts.push(`${label} ${pool.current}/${pool.max}`);
    }
  }
  return parts.length > 0 ? parts.join(', ') : null;
}

function formatProgressionSummary(progression: CharacterProgression | undefined): string | null {
  if (progression === undefined) {
    return null;
  }
  const parts: string[] = [`Lv ${progression.level}`];
  if (typeof progression.className === 'string' && progression.className.trim().length > 0) {
    parts[0] = `Lv ${progression.level} ${progression.className.trim()}`;
  }
  if (typeof progression.subclass === 'string' && progression.subclass.trim().length > 0) {
    parts.push(`(${progression.subclass.trim()})`);
  }
  parts.push(`XP ${progression.xp}`);
  return parts.join(' ');
}

function findRelationForCharacter(
  state: WorldState,
  characterId: string
): RelationEntry | undefined {
  const playerIds = [state.player.id, state.player.characterId, 'player'].filter(
    (id): id is string => typeof id === 'string' && id.length > 0 && isSafeRecordKey(id)
  );

  for (const pid of playerIds) {
    const fromPlayer = getOwnSafe(state.relations, pid);
    const rel = getOwnSafe(fromPlayer, characterId);
    if (rel !== undefined) {
      return rel;
    }
  }

  const fromChar = getOwnSafe(state.relations, characterId);
  if (fromChar !== undefined) {
    for (const pid of playerIds) {
      const rel = getOwnSafe(fromChar, pid);
      if (rel !== undefined) {
        return rel;
      }
    }
  }

  return undefined;
}

function resolveBlockSlotIndex(
  blockOrder: readonly string[],
  candidates: readonly string[],
  fallbackIndex: number
): number {
  for (let i = 0; i < blockOrder.length; i += 1) {
    const name = blockOrder[i];
    if (name !== undefined && candidates.includes(name)) {
      return i;
    }
  }
  return fallbackIndex;
}

function buildLocationLabel(state: WorldState, capabilities: SystemCapabilities): string {
  if (capabilities.spatialMode === 'scene_only') {
    const loc = state.scene.location.trim();
    return loc.length > 0 ? loc : 'Unknown';
  }

  const locId = state.scene.locationId;
  if (typeof locId === 'string' && isSafeRecordKey(locId)) {
    const locEntity = getOwnSafe(state.entities.locations, locId);
    if (locEntity !== undefined) {
      let label = `${locEntity.name} (${locEntity.status})`;
      if (
        capabilities.factions &&
        typeof locEntity.controllingFactionId === 'string' &&
        isSafeRecordKey(locEntity.controllingFactionId)
      ) {
        const faction = getOwnSafe(state.entities.factions, locEntity.controllingFactionId);
        if (faction !== undefined && faction.name.trim().length > 0) {
          label += ` [controlled by ${faction.name.trim()}]`;
        }
      }
      return label;
    }
  }

  const fallback = state.scene.location.trim();
  if (fallback.length > 0) {
    return fallback;
  }
  return typeof locId === 'string' && locId.trim().length > 0 ? locId.trim() : 'Unknown';
}

function buildBlockOrderSlots(blockOrder: readonly string[]): {
  scene: number;
  pacing: number;
  time: number;
  character: number;
  inventory: number;
  cast: number;
  worldSummary: number;
} {
  const baseCount = blockOrder.length;
  const scene = resolveBlockSlotIndex(blockOrder, ['SCENE'], 0);
  const pacing = resolveBlockSlotIndex(blockOrder, ['PACING'], scene + 0.1);
  const character = resolveBlockSlotIndex(blockOrder, ['CHARACTER'], scene + 0.2);
  const inventory = resolveBlockSlotIndex(blockOrder, ['INVENTORY'], character + 0.1);
  const cast = resolveBlockSlotIndex(
    blockOrder,
    ['PARTY', 'CAST', 'RELATIONSHIPS'],
    character + 0.2
  );
  const worldSummary = resolveBlockSlotIndex(
    blockOrder,
    ['FACTIONS', 'THREATS'],
    baseCount + 10
  );
  const time = resolveBlockSlotIndex(blockOrder, ['TIME'], baseCount + 5);

  return { scene, pacing, time, character, inventory, cast, worldSummary };
}

/**
 * Detailed output returned by {@link renderWorldStateBlockWithStats}.
 */
export interface RenderedWorldStateStats {
  text: string;
  droppedCount: number;
}

interface BlockOrderSlots {
  scene: number;
  pacing: number;
  time: number;
  character: number;
  inventory: number;
  cast: number;
  worldSummary: number;
}

interface StateRenderContext {
  state: WorldState;
  config: ResolvedControlRoomConfig;
  effectiveCaps: SystemCapabilities;
  activeModules: readonly GameSystemModule[];
  slots: BlockOrderSlots;
  clocksEnabled: boolean;
  combatEnabled: boolean;
  progressionEnabled: boolean;
  factionsEnabled: boolean;
  relationshipsEnabled: boolean;
  formDefinitions?: readonly FormDefinition[];
  pushItem: (text: string, blockSlot: number, priority: number) => void;
}

function appendClockAndSceneItems(ctx: StateRenderContext): void {
  const { state, config, effectiveCaps, activeModules, slots, clocksEnabled, pushItem } = ctx;

  if (clocksEnabled) {
    const clockLine = formatClockDisplay(state.clocks, config.tuningDials);
    pushItem(`Time: ${clockLine}`, slots.time, 100);
  }

  const hasSeparatePacingBlock = config.blockOrder.includes('PACING');
  const locationLabel = buildLocationLabel(state, effectiveCaps);
  const sceneParts: string[] = [`Scene: ${locationLabel}`];
  if (state.scene.mood.trim().length > 0) {
    sceneParts.push(`Mood: ${state.scene.mood.trim()}`);
  }
  if (!hasSeparatePacingBlock && state.scene.pacing.trim().length > 0) {
    sceneParts.push(`Pacing: ${state.scene.pacing.trim()}`);
  }
  pushItem(sceneParts.join(' | '), slots.scene, 100);

  if (hasSeparatePacingBlock && state.scene.pacing.trim().length > 0) {
    let pacingText = `Pacing: ${state.scene.pacing.trim()}`;
    const pacingModule = activeModules.find((m) => m.id === 'narrative_pacing');
    if (pacingModule !== undefined) {
      const focus = formatCompactValue(getOwnSafe(state.customFields, 'scene_focus'));
      if (focus !== null) {
        pacingText += ` | Focus: ${focus}`;
      }
    }
    pushItem(pacingText, slots.pacing, 95);
  }

  const globalFieldPairs: string[] = [];
  for (const mod of activeModules) {
    if (mod.target !== 'global' && mod.target !== 'location') {
      continue;
    }
    const fieldKeys = Object.keys(mod.fields)
      .filter(isSafeRecordKey)
      .sort(compareStringsDeterministic);
    for (const fieldKey of fieldKeys) {
      if (BUILTIN_GLOBAL_MODULE_FIELDS_HANDLED_ELSEWHERE.has(fieldKey)) {
        continue;
      }
      const formatted = formatCompactValue(getOwnSafe(state.customFields, fieldKey));
      if (formatted !== null) {
        globalFieldPairs.push(`${fieldKey}: ${formatted}`);
      }
    }
  }
  if (globalFieldPairs.length > 0) {
    pushItem(`World State: ${globalFieldPairs.join(' | ')}`, slots.scene, 74);
  }
}

function appendPlayerItems(ctx: StateRenderContext): void {
  const {
    state,
    config,
    effectiveCaps,
    activeModules,
    slots,
    combatEnabled,
    progressionEnabled,
    pushItem,
  } = ctx;

  const linkedPlayerChar =
    typeof state.player.characterId === 'string' && isSafeRecordKey(state.player.characterId)
      ? getOwnSafe(state.entities.characters, state.player.characterId)
      : undefined;

  const povHeaderParts: string[] = [`POV: ${state.player.name}`];
  if (progressionEnabled) {
    const prog = state.player.progression ?? linkedPlayerChar?.progression;
    const progText = formatProgressionSummary(prog);
    if (progText !== null) {
      povHeaderParts.push(progText);
    }
    if (combatEnabled) {
      const res = state.player.resources ?? linkedPlayerChar?.resources;
      const resText = formatResourcesSummary(res);
      if (resText !== null) {
        povHeaderParts.push(resText);
      }
    }
  }
  pushItem(povHeaderParts.join(' | '), slots.character, 98);

  if (progressionEnabled) {
    const prog = state.player.progression ?? linkedPlayerChar?.progression;
    if (prog?.attributes !== undefined) {
      const attrPairs: string[] = [];
      for (const attrKey of Object.keys(prog.attributes)
        .filter(isSafeRecordKey)
        .sort(compareStringsDeterministic)) {
        const attrVal = getOwnSafe(prog.attributes, attrKey);
        if (typeof attrVal === 'number' && Number.isFinite(attrVal)) {
          attrPairs.push(`${attrKey} ${attrVal}`);
        }
      }
      if (attrPairs.length > 0) {
        pushItem(`  Attributes: ${attrPairs.join(', ')}`, slots.character, 72);
      }
    }

    const invParts: string[] = [];
    const currencyEntries: string[] = [];
    for (const curKey of Object.keys(state.player.inventory.currency)
      .filter(isSafeRecordKey)
      .sort(compareStringsDeterministic)) {
      const amount = getOwnSafe(state.player.inventory.currency, curKey);
      if (typeof amount === 'number' && Number.isFinite(amount)) {
        currencyEntries.push(`${curKey} ${amount}`);
      }
    }
    if (currencyEntries.length > 0) {
      invParts.push(`Currency: ${currencyEntries.join(', ')}`);
    }

    const itemEntries: string[] = [];
    for (const itemKey of Object.keys(state.player.inventory.items)
      .filter(isSafeRecordKey)
      .sort(compareStringsDeterministic)) {
      const count = getOwnSafe(state.player.inventory.items, itemKey);
      if (typeof count === 'number' && Number.isFinite(count) && count > 0) {
        itemEntries.push(`${itemKey} x${count}`);
      }
    }
    if (itemEntries.length > 0) {
      invParts.push(`Inventory: ${itemEntries.join(', ')}`);
    }

    if (invParts.length > 0) {
      pushItem(`  ${invParts.join(' | ')}`, slots.inventory, 70);
    }
  }

  for (const sec of config.pcCoreSections) {
    if (!isSectionPermittedByCapabilities(sec.id, effectiveCaps)) {
      continue;
    }
    const rawVal =
      getOwnSafe(state.player.sections, sec.id) ??
      (linkedPlayerChar !== undefined ? getOwnSafe(linkedPlayerChar.sections, sec.id) : undefined);
    const formatted = formatSectionValue(rawVal);
    if (formatted !== null) {
      pushItem(`  ${sec.name}: ${formatted}`, slots.character, 65);
    }
  }

  const playerCustomPairs: string[] = [];
  for (const mod of activeModules) {
    if (mod.target !== 'player') {
      continue;
    }
    for (const fieldKey of Object.keys(mod.fields)
      .filter(isSafeRecordKey)
      .sort(compareStringsDeterministic)) {
      if (BUILTIN_RPG_PLAYER_FIELDS.has(fieldKey)) {
        continue;
      }
      const rawVal =
        getOwnSafe(state.player.customFields, fieldKey) ??
        (linkedPlayerChar !== undefined
          ? getOwnSafe(linkedPlayerChar.customFields, fieldKey)
          : undefined);
      const formatted = formatCompactValue(rawVal);
      if (formatted !== null) {
        playerCustomPairs.push(`${fieldKey}: ${formatted}`);
      }
    }
  }
  if (playerCustomPairs.length > 0) {
    pushItem(`  Custom: ${playerCustomPairs.join(' | ')}`, slots.character, 68);
  }
}

function appendPresentCastItems(ctx: StateRenderContext): void {
  const {
    state,
    config,
    effectiveCaps,
    activeModules,
    slots,
    combatEnabled,
    progressionEnabled,
    relationshipsEnabled,
    formDefinitions,
    pushItem,
  } = ctx;

  const cast = computeLocationCast({ ...state, capabilities: effectiveCaps }, formDefinitions);
  const pinnedSet = new Set(state.scene.pinnedCharacterIds);
  const formById = new Map<string, FormDefinition>();
  if (formDefinitions !== undefined) {
    for (const def of formDefinitions) {
      if (typeof def.id === 'string' && def.id.length > 0 && !formById.has(def.id)) {
        formById.set(def.id, def);
      }
    }
  }

  for (const char of cast.presentCharacters) {
    const isPinned = pinnedSet.has(char.id);
    const charCorePriority = isPinned ? 92 : 86;
    const charDetailPriority = isPinned ? 62 : 56;

    const headerParts: string[] = [`- ${char.name}`];
    if (typeof char.formId === 'string' && char.formId.trim().length > 0) {
      const formDef = formById.get(char.formId);
      if (formDef !== undefined && formDef.displayName !== char.formId) {
        headerParts.push(`[form: ${formDef.displayName} (${char.formId})]`);
      } else {
        headerParts.push(`[form: ${char.formId}]`);
      }
    }
    if (char.mood.trim().length > 0 && char.mood.trim() !== 'neutral') {
      headerParts.push(`(mood: ${char.mood.trim()})`);
    }

    if (progressionEnabled && char.progression !== undefined) {
      const progText = formatProgressionSummary(char.progression);
      if (progText !== null) {
        headerParts.push(progText);
      }
    }
    if (combatEnabled) {
      const resText = formatResourcesSummary(char.resources);
      if (resText !== null) {
        headerParts.push(resText);
      }
    }
    if (combatEnabled || progressionEnabled) {
      const abilities = char.abilities.map((a) => a.trim()).filter((a) => a.length > 0);
      if (abilities.length > 0) {
        headerParts.push(`Abilities: ${abilities.join(', ')}`);
      }
    }
    if (relationshipsEnabled) {
      const rel = findRelationForCharacter(state, char.id);
      if (rel !== undefined) {
        const tagText = rel.tags.length > 0 ? `; ${rel.tags.join(', ')}` : '';
        headerParts.push(`Rel: ${rel.label} (${rel.affinity}${tagText})`);
      }
    }

    pushItem(headerParts.join(' | '), slots.cast, charCorePriority);

    const npcDetails: string[] = [];
    for (const sec of config.npcCoreSections) {
      if (!isSectionPermittedByCapabilities(sec.id, effectiveCaps)) {
        continue;
      }
      const formatted = formatSectionValue(getOwnSafe(char.sections, sec.id));
      if (formatted !== null) {
        npcDetails.push(`${sec.name}: ${formatted}`);
      }
    }

    for (const mod of activeModules) {
      if (mod.target !== 'npc') {
        continue;
      }
      for (const fieldKey of Object.keys(mod.fields)
        .filter(isSafeRecordKey)
        .sort(compareStringsDeterministic)) {
        const formatted = formatCompactValue(getOwnSafe(char.customFields, fieldKey));
        if (formatted !== null) {
          npcDetails.push(`${fieldKey}: ${formatted}`);
        }
      }
    }

    if (npcDetails.length > 0) {
      pushItem(`  ${char.name} · ${npcDetails.join(' | ')}`, slots.cast, charDetailPriority);
    }
  }

  if (effectiveCaps.spatialMode !== 'scene_only') {
    for (const threat of cast.activeThreatsHere) {
      pushItem(
        `- Threat Here: ${threat.name} (${threat.rank}, stage ${threat.stage}, progress ${threat.progress}%)`,
        slots.cast,
        82
      );
    }
  }
}

function appendOffscreenWorldItems(ctx: StateRenderContext): void {
  const { state, slots, factionsEnabled, pushItem } = ctx;
  if (!factionsEnabled) {
    return;
  }

  const activeFactions: FactionEntity[] = [];
  for (const factionId of Object.keys(state.entities.factions)
    .filter(isSafeRecordKey)
    .sort(compareStringsDeterministic)) {
    const faction = getOwnSafe(state.entities.factions, factionId);
    if (
      faction !== undefined &&
      (faction.status === 'active' ||
        faction.status === 'dominant' ||
        faction.status === 'underground')
    ) {
      activeFactions.push(faction);
    }
  }

  activeFactions.sort(
    (a, b) => b.influence - a.influence || compareStringsDeterministic(a.id, b.id)
  );
  for (const faction of activeFactions) {
    pushItem(
      `- Faction: ${faction.name} (${faction.side}, inf ${faction.influence})`,
      slots.worldSummary,
      45
    );
  }

  const activeThreats: ThreatEntity[] = [];
  for (const threatId of Object.keys(state.entities.threats)
    .filter(isSafeRecordKey)
    .sort(compareStringsDeterministic)) {
    const threat = getOwnSafe(state.entities.threats, threatId);
    if (threat !== undefined && threat.status === 'active') {
      activeThreats.push(threat);
    }
  }

  activeThreats.sort((a, b) => {
    if (a.rank !== b.rank) {
      return a.rank === 'main' ? -1 : 1;
    }
    if (b.stage !== a.stage) {
      return b.stage - a.stage;
    }
    if (b.progress !== a.progress) {
      return b.progress - a.progress;
    }
    return compareStringsDeterministic(a.id, b.id);
  });

  for (const threat of activeThreats) {
    pushItem(
      `- Threat: ${threat.name} [${threat.rank}] stage ${threat.stage} (${threat.progress}%)`,
      slots.worldSummary,
      42
    );
  }

  const rumors = state.turnEvents.rumors
    .filter((r) => typeof r === 'string' && r.trim().length > 0)
    .map((r) => r.trim())
    .slice(0, 3);
  for (const rumor of rumors) {
    pushItem(`- Rumor: ${rumor}`, slots.worldSummary, 35);
  }
}

function selectAndFormatStateItems(
  items: readonly RenderedStateItem[],
  maxTokens?: number
): RenderedWorldStateStats {
  if (items.length === 0) {
    return { text: '', droppedCount: 0 };
  }

  const orderedText = items
    .slice()
    .sort((a, b) => a.blockSlot - b.blockSlot || a.sequence - b.sequence)
    .map((item) => item.text)
    .join('\n');

  if (maxTokens === undefined) {
    return { text: orderedText, droppedCount: 0 };
  }

  const budget = Number.isFinite(maxTokens) ? Math.max(0, Math.floor(maxTokens)) : 0;
  if (budget === 0) {
    return { text: '', droppedCount: items.length };
  }
  if (estimateTokens(orderedText) <= budget) {
    return { text: orderedText, droppedCount: 0 };
  }

  // Prioritize core scene/POV and present NPCs over off-screen world bloat
  const prioritized = items
    .slice()
    .sort(
      (a, b) =>
        b.priority - a.priority || a.blockSlot - b.blockSlot || a.sequence - b.sequence
    );

  const fitted = fitItemsToBudget(prioritized, budget);
  let droppedCount = fitted.droppedCount;
  const selected = fitted.included
    .slice()
    .sort((a, b) => a.blockSlot - b.blockSlot || a.sequence - b.sequence);

  while (selected.length > 1) {
    const joined = selected.map((item) => item.text).join('\n');
    if (estimateTokens(joined) <= budget) {
      return { text: joined, droppedCount };
    }
    let lowestIdx = 0;
    for (let i = 1; i < selected.length; i += 1) {
      const candidate = selected[i]!;
      const lowest = selected[lowestIdx]!;
      if (
        candidate.priority < lowest.priority ||
        (candidate.priority === lowest.priority && candidate.sequence > lowest.sequence)
      ) {
        lowestIdx = i;
      }
    }
    selected.splice(lowestIdx, 1);
    droppedCount += 1;
  }

  const singleText = selected.map((item) => item.text).join('\n');
  return { text: clipTextToTokenBudget(singleText, budget), droppedCount };
}

/**
 * Render the concise, capability-gated `[STATE]` block body following `config.blockOrder`
 * and `state.capabilities`. Disabled modules and capabilities produce 0 tokens, and optional
 * `maxTokens` prioritizes core scene/POV and present NPCs over off-screen world bloat.
 */
export function renderWorldStateBlock(params: RenderWorldStateParams): string {
  return renderWorldStateBlockWithStats(params).text;
}

/**
 * Render the `[STATE]` block body along with the count of items dropped under `maxTokens`.
 */
export function renderWorldStateBlockWithStats(
  params: RenderWorldStateParams
): RenderedWorldStateStats {
  const { state, config, maxTokens, formDefinitions } = params;
  const effectiveCaps = resolveEffectiveCapabilities(state.capabilities, config.capabilities);
  const items: RenderedStateItem[] = [];
  let seq = 0;

  const ctx: StateRenderContext = {
    state,
    config,
    effectiveCaps,
    activeModules: getActiveGameSystemModules(config, effectiveCaps),
    slots: buildBlockOrderSlots(config.blockOrder),
    clocksEnabled:
      effectiveCaps.clocks !== 'disabled' &&
      !isModuleCategoryExplicitlyDisabled(config, CLOCK_MODULE_IDS),
    combatEnabled:
      effectiveCaps.combatMode !== 'disabled' &&
      !isModuleCategoryExplicitlyDisabled(config, COMBAT_MODULE_IDS),
    progressionEnabled:
      effectiveCaps.progression !== 'disabled' &&
      !isModuleCategoryExplicitlyDisabled(config, PROGRESSION_MODULE_IDS),
    factionsEnabled:
      effectiveCaps.factions && !isModuleCategoryExplicitlyDisabled(config, FACTION_MODULE_IDS),
    relationshipsEnabled:
      effectiveCaps.relationships &&
      !isModuleCategoryExplicitlyDisabled(config, RELATIONSHIP_MODULE_IDS),
    formDefinitions,
    pushItem: (text: string, blockSlot: number, priority: number): void => {
      const trimmed = text.trim();
      if (trimmed.length === 0) {
        return;
      }
      items.push({ text: trimmed, blockSlot, sequence: seq, priority });
      seq += 1;
    },
  };

  appendClockAndSceneItems(ctx);
  appendPlayerItems(ctx);
  appendPresentCastItems(ctx);
  appendOffscreenWorldItems(ctx);

  return selectAndFormatStateItems(items, maxTokens);
}
