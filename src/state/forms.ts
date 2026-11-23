import { RefereeError } from '../core/errors.js';
import type { CharacterEntity, CharacterProgression, ResourcePool } from './world-state.js';

/**
 * Definition of an alternate or base character form within a mutually exclusive form group.
 */
export interface FormDefinition {
  id: string;
  formGroup: string;
  characterId: string;
  displayName: string;
  description?: string;
  abilities?: string[];
  traits?: string[];
  sections?: Record<string, string | string[]>;
  legalTargets?: string[];
}

/**
 * Indexed lookup tables for form definitions keyed by form ID and form group.
 */
export interface FormIndex {
  readonly byId: ReadonlyMap<string, FormDefinition>;
  readonly byGroup: ReadonlyMap<string, readonly FormDefinition[]>;
}

function setRecordEntry<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function cloneSections(
  sections: Readonly<Record<string, string | readonly string[]>>
): Record<string, string | string[]> {
  const cloned: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(sections)) {
    setRecordEntry(cloned, key, typeof value === 'string' ? value : [...value]);
  }
  return cloned;
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
    cloned.sections = cloneSections(form.sections);
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
    cloned.attributes = { ...progression.attributes };
  }
  return cloned;
}

function cloneResources(resources: Record<string, ResourcePool>): Record<string, ResourcePool> {
  const cloned: Record<string, ResourcePool> = {};
  for (const [key, pool] of Object.entries(resources)) {
    setRecordEntry(cloned, key, { current: pool.current, max: pool.max });
  }
  return cloned;
}

function cloneCustomFields(customFields: Record<string, unknown>): Record<string, unknown> {
  const cloned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(customFields)) {
    setRecordEntry(cloned, key, cloneUnknownValue(value));
  }
  return cloned;
}

function cloneUnknownValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(cloneUnknownValue);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      setRecordEntry(out, k, cloneUnknownValue(v));
    }
    return out;
  }
  return value;
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

/**
 * Build isolated lookup maps by `id` and `formGroup` from a list of {@link FormDefinition}s.
 * Throws a {@link RefereeError} on invalid or duplicate form IDs.
 */
export function buildFormIndex(forms: readonly FormDefinition[]): FormIndex {
  const byId = new Map<string, FormDefinition>();
  const groupLists = new Map<string, FormDefinition[]>();

  for (const rawForm of forms) {
    if (typeof rawForm.id !== 'string' || rawForm.id.trim().length === 0) {
      throw new RefereeError('FormDefinition id must be a non-empty string', {
        code: 'INVALID_FORM_DEFINITION',
        details: { form: rawForm },
      });
    }
    if (typeof rawForm.formGroup !== 'string' || rawForm.formGroup.trim().length === 0) {
      throw new RefereeError(`FormDefinition "${rawForm.id}" must have a non-empty formGroup`, {
        code: 'INVALID_FORM_DEFINITION',
        details: { formId: rawForm.id },
      });
    }
    if (byId.has(rawForm.id)) {
      throw new RefereeError(`Duplicate form definition id "${rawForm.id}"`, {
        code: 'DUPLICATE_FORM_ID',
        details: { formId: rawForm.id },
      });
    }

    const cloned = cloneFormDefinition(rawForm);
    byId.set(cloned.id, cloned);

    let list = groupLists.get(cloned.formGroup);
    if (!list) {
      list = [];
      groupLists.set(cloned.formGroup, list);
    }
    list.push(cloned);
  }

  const byGroup = new Map<string, readonly FormDefinition[]>();
  for (const [groupId, list] of groupLists.entries()) {
    byGroup.set(groupId, Object.freeze([...list]));
  }

  return { byId, byGroup };
}

/**
 * Determine whether transitioning from `currentFormId` to `targetFormId` is permitted
 * according to the indexed {@link FormDefinition} rules.
 */
export function isLegalTransform(
  currentFormId: string | null,
  targetFormId: string,
  formIndex: FormIndex
): boolean {
  if (typeof targetFormId !== 'string' || targetFormId.length === 0) {
    return false;
  }

  const target = formIndex.byId.get(targetFormId);
  if (!target) {
    return false;
  }

  if (currentFormId === null) {
    return true;
  }

  const current = formIndex.byId.get(currentFormId);
  if (!current) {
    return false;
  }

  if (current.legalTargets !== undefined) {
    return current.legalTargets.includes(targetFormId);
  }

  if (currentFormId === targetFormId) {
    return false;
  }

  return current.formGroup === target.formGroup && current.characterId === target.characterId;
}

/**
 * Return a new {@link CharacterEntity} with the target form's display identity, traits,
 * abilities, and overlaid sections applied, while preserving live `resources`,
 * `corruption`, `progression`, and external `WorldState.relations`.
 */
export function applyFormProfileOverlay(
  character: CharacterEntity,
  targetFormId: string,
  formIndex: FormIndex
): CharacterEntity {
  const form = formIndex.byId.get(targetFormId);
  if (!form) {
    throw new RefereeError(`Target form "${targetFormId}" was not found in FormIndex`, {
      code: 'FORM_NOT_FOUND',
      details: { targetFormId },
    });
  }

  const nextSections = cloneSections(character.sections);
  if (form.sections !== undefined) {
    for (const [sectionKey, sectionValue] of Object.entries(form.sections)) {
      setRecordEntry(
        nextSections,
        sectionKey,
        typeof sectionValue === 'string' ? sectionValue : [...sectionValue]
      );
    }
  }

  const nextCharacter: CharacterEntity = {
    id: character.id,
    name: form.displayName,
    status: character.status,
    presentInScene: character.presentInScene,
    locationId: character.locationId,
    formId: form.id,
    formGroup: form.formGroup,
    sections: nextSections,
    customFields: cloneCustomFields(character.customFields),
    abilities: form.abilities !== undefined ? [...form.abilities] : [...character.abilities],
    goals: [...character.goals],
    agenda: character.agenda,
    allegiance: character.allegiance,
    mood: character.mood,
    traits: form.traits !== undefined ? [...form.traits] : [...character.traits],
  };

  if (character.progression !== undefined) {
    nextCharacter.progression = cloneProgression(character.progression);
  }
  if (character.resources !== undefined) {
    nextCharacter.resources = cloneResources(character.resources);
  }
  if (character.corruption !== undefined) {
    nextCharacter.corruption = { ...character.corruption };
  }

  return nextCharacter;
}

/**
 * Filter a candidate pool so at most one entity per non-empty `formGroup` survives.
 * Resolution and output order are deterministic: `preferIds` rank first (in given order),
 * followed by ascending lexicographic code-unit `id`.
 */
export function selectExclusiveCast<T extends { id: string; formGroup?: string | null }>(
  pool: readonly T[],
  preferIds?: readonly string[]
): T[] {
  const preferOrder = new Map<string, number>();
  if (preferIds) {
    for (let i = 0; i < preferIds.length; i += 1) {
      const id = preferIds[i];
      if (id !== undefined && !preferOrder.has(id)) {
        preferOrder.set(id, i);
      }
    }
  }

  const uniqueById = new Map<string, T>();
  for (const item of pool) {
    if (!uniqueById.has(item.id)) {
      uniqueById.set(item.id, item);
    }
  }

  const sorted = [...uniqueById.values()].sort((a, b) => {
    const aRank = preferOrder.get(a.id) ?? Number.POSITIVE_INFINITY;
    const bRank = preferOrder.get(b.id) ?? Number.POSITIVE_INFINITY;
    if (aRank !== bRank) {
      return aRank - bRank;
    }
    return compareIdsDeterministic(a.id, b.id);
  });

  const occupiedGroups = new Set<string>();
  const selected: T[] = [];

  for (const candidate of sorted) {
    const group = candidate.formGroup;
    if (typeof group === 'string' && group.length > 0) {
      if (occupiedGroups.has(group)) {
        continue;
      }
      occupiedGroups.add(group);
    }
    selected.push(candidate);
  }

  return selected;
}
