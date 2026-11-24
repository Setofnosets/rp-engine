import { type FormDefinition, selectExclusiveCast } from '../state/forms.js';
import type {
  CharacterEntity,
  CharacterStatus,
  ThreatEntity,
  WorldState,
} from '../state/world-state.js';

/**
 * Deterministic cast and active-threat snapshot for the active scene/location.
 */
export interface CastPresenceResult {
  presentCharacterIds: string[];
  presentCharacters: CharacterEntity[];
  activeThreatsHere: ThreatEntity[];
  excludedPlayerCharacterId: string | null;
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

function isSafeKey(key: string): boolean {
  return key.length > 0 && !FORBIDDEN_KEYS.has(key);
}

function getOwn<T>(record: Record<string, T>, key: string): T | undefined {
  if (!isSafeKey(key) || !Object.hasOwn(record, key)) {
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
      setOwn(out, k, cloneUnknownValue(v));
    }
    return out;
  }
  return value;
}

function cloneCharacter(character: CharacterEntity): CharacterEntity {
  const sections: Record<string, string | string[]> = {};
  for (const [key, val] of Object.entries(character.sections)) {
    setOwn(sections, key, Array.isArray(val) ? [...val] : val);
  }

  const customFields: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(character.customFields)) {
    setOwn(customFields, key, cloneUnknownValue(val));
  }

  const cloned: CharacterEntity = {
    id: character.id,
    name: character.name,
    status: character.status,
    presentInScene: character.presentInScene,
    locationId: character.locationId,
    formId: character.formId,
    formGroup: character.formGroup,
    sections,
    customFields,
    abilities: [...character.abilities],
    goals: [...character.goals],
    agenda: character.agenda,
    allegiance: character.allegiance,
    mood: character.mood,
    traits: [...character.traits],
  };

  if (character.progression !== undefined) {
    let attrs: Record<string, number> | undefined;
    if (character.progression.attributes !== undefined) {
      attrs = {};
      for (const [attrKey, attrVal] of Object.entries(character.progression.attributes)) {
        setOwn(attrs, attrKey, attrVal);
      }
    }
    cloned.progression = {
      level: character.progression.level,
      xp: character.progression.xp,
      ...(character.progression.className !== undefined
        ? { className: character.progression.className }
        : {}),
      ...(character.progression.subclass !== undefined
        ? { subclass: character.progression.subclass }
        : {}),
      ...(attrs !== undefined ? { attributes: attrs } : {}),
    };
  }

  if (character.resources !== undefined) {
    const resources: Record<string, { current: number; max: number }> = {};
    for (const [k, pool] of Object.entries(character.resources)) {
      setOwn(resources, k, { current: pool.current, max: pool.max });
    }
    cloned.resources = resources;
  }

  if (character.corruption !== undefined) {
    cloned.corruption = { ...character.corruption };
  }
  if (character.lockedForms !== undefined) {
    const lockedForms: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(character.lockedForms)) {
      setOwn(lockedForms, k, v);
    }
    cloned.lockedForms = lockedForms;
  }

  return cloned;
}

function cloneThreat(threat: ThreatEntity): ThreatEntity {
  return { ...threat };
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

interface FormLookup {
  byFormId: Map<string, string>;
  byCharacterId: Map<string, Set<string>>;
}

function buildFormGroupLookup(formDefinitions?: readonly FormDefinition[]): FormLookup {
  const byFormId = new Map<string, string>();
  const byCharacterId = new Map<string, Set<string>>();

  if (!formDefinitions) {
    return { byFormId, byCharacterId };
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
    if (!byFormId.has(def.id)) {
      byFormId.set(def.id, def.formGroup);
    }
    if (typeof def.characterId === 'string' && def.characterId.length > 0) {
      let groups = byCharacterId.get(def.characterId);
      if (!groups) {
        groups = new Set<string>();
        byCharacterId.set(def.characterId, groups);
      }
      groups.add(def.formGroup);
    }
  }

  return { byFormId, byCharacterId };
}

function resolveEffectiveFormGroup(character: CharacterEntity, lookup: FormLookup): string | null {
  if (typeof character.formGroup === 'string' && character.formGroup.trim().length > 0) {
    return character.formGroup;
  }
  if (typeof character.formId === 'string' && character.formId.length > 0) {
    const group = lookup.byFormId.get(character.formId);
    if (group !== undefined) {
      return group;
    }
  }
  const byIdForm = lookup.byFormId.get(character.id);
  if (byIdForm !== undefined) {
    return byIdForm;
  }
  const charGroups = lookup.byCharacterId.get(character.id);
  if (charGroups && charGroups.size === 1) {
    return [...charGroups][0] ?? null;
  }
  return character.formGroup;
}

/**
 * Deterministically compute the active NPC cast and threats present in the current scene.
 *
 * - Tier 0 (`scene_only`): active characters with `presentInScene === true` or pinned.
 * - Tier 1/2 (`emergent` | `authored_graph`): active characters at `scene.locationId` or pinned.
 * - Always excludes `state.player.characterId` and non-active statuses (`dead`, `captured`,
 *   `imprisoned`, `missing`, `retired`, `lost`).
 * - Enforces {@link selectExclusiveCast} across `formGroup`, preferring `state.scene.pinnedCharacterIds`.
 */
export function computeLocationCast(
  state: WorldState,
  formDefinitions?: readonly FormDefinition[]
): CastPresenceResult {
  const playerCharacterId = state.player.characterId ?? null;
  const canonCharacterId = state.player.canonCharacterId ?? null;
  const excludedPlayerCharacterId = canonCharacterId ?? playerCharacterId;
  const pinnedIds = state.scene.pinnedCharacterIds;
  const pinnedSet = new Set(pinnedIds);
  const sceneLocationId = state.scene.locationId;
  const spatialMode = state.capabilities.spatialMode;
  const formLookup = buildFormGroupLookup(formDefinitions);

  const excludedCanonFormGroups = new Set<string>();
  if (canonCharacterId !== null && isSafeKey(canonCharacterId)) {
    const canonChar = getOwn(state.entities.characters, canonCharacterId);
    if (canonChar) {
      const canonGroup = resolveEffectiveFormGroup(canonChar, formLookup);
      if (typeof canonGroup === 'string' && canonGroup.length > 0) {
        excludedCanonFormGroups.add(canonGroup);
      }
    }
    const charFormGroups = formLookup.byCharacterId.get(canonCharacterId);
    if (charFormGroups) {
      for (const g of charFormGroups) {
        excludedCanonFormGroups.add(g);
      }
    }
    const directFormGroup = formLookup.byFormId.get(canonCharacterId);
    if (directFormGroup !== undefined) {
      excludedCanonFormGroups.add(directFormGroup);
    }
  }

  const candidates: Array<{
    id: string;
    formGroup: string | null;
    character: CharacterEntity;
  }> = [];

  const charIds = Object.keys(state.entities.characters).filter(isSafeKey).sort(compareIdsDeterministic);

  for (const charId of charIds) {
    if (
      (playerCharacterId !== null && charId === playerCharacterId) ||
      (canonCharacterId !== null && charId === canonCharacterId)
    ) {
      continue;
    }

    const character = getOwn(state.entities.characters, charId);
    if (!character || NON_ACTIVE_CHARACTER_STATUSES.has(character.status)) {
      continue;
    }

    const effectiveGroup = resolveEffectiveFormGroup(character, formLookup);
    if (
      canonCharacterId !== null &&
      typeof effectiveGroup === 'string' &&
      excludedCanonFormGroups.has(effectiveGroup)
    ) {
      continue;
    }

    const isPinned = pinnedSet.has(charId);
    let isPresent = false;
    if (spatialMode === 'scene_only') {
      isPresent = character.presentInScene === true || isPinned;
    } else {
      isPresent =
        (sceneLocationId !== null && character.locationId === sceneLocationId) || isPinned;
    }

    if (!isPresent) {
      continue;
    }

    candidates.push({
      id: charId,
      formGroup: effectiveGroup,
      character: cloneCharacter(character),
    });
  }

  const exclusiveWinners = selectExclusiveCast(candidates, pinnedIds);
  const presentCharacters = exclusiveWinners.map((item) => item.character);
  const presentCharacterIds = presentCharacters.map((character) => character.id);

  // Active threats at current scene location or linked via controlling faction HQ
  const activeThreatsHere: ThreatEntity[] = [];
  if (sceneLocationId !== null && isSafeKey(sceneLocationId)) {
    const sceneLocation = getOwn(state.entities.locations, sceneLocationId);
    const threatIds = Object.keys(state.entities.threats)
      .filter(isSafeKey)
      .sort(compareIdsDeterministic);

    for (const threatId of threatIds) {
      const threat = getOwn(state.entities.threats, threatId);
      if (!threat || threat.status !== 'active') {
        continue;
      }

      const directlyHere = threat.locationId === sceneLocationId;
      let factionLinkedHere = false;

      if (threat.sourceFactionId !== null && isSafeKey(threat.sourceFactionId)) {
        const sourceFaction = getOwn(state.entities.factions, threat.sourceFactionId);
        if (sourceFaction && sourceFaction.headquartersLocationId === sceneLocationId) {
          factionLinkedHere = true;
        } else if (sceneLocation && sceneLocation.controllingFactionId === threat.sourceFactionId) {
          factionLinkedHere = true;
        }
      }

      if (directlyHere || factionLinkedHere) {
        activeThreatsHere.push(cloneThreat(threat));
      }
    }
  }

  return {
    presentCharacterIds,
    presentCharacters,
    activeThreatsHere,
    excludedPlayerCharacterId,
  };
}
