import { type ValidationError, validationError } from '../core/errors.js';
import { ErrorAccumulator, type Result, err, ok } from '../core/result.js';
import type { PatchOperation } from '../state/patch.js';
import type { CharacterProgression, ResourcePool, WorldState } from '../state/world-state.js';

/**
 * Reusable player persona preset saved by the user for populating `WorldState.player`
 * across sessions and cartridges.
 */
export interface UserPersonaPreset {
  id: string;
  name: string;
  description: string;
  characterId?: string | null;
  sections?: Readonly<Record<string, string | readonly string[]>>;
  customFields?: Readonly<Record<string, unknown>>;
  resources?: Readonly<Record<string, ResourcePool>>;
  progression?: CharacterProgression;
  updatedAt?: string;
}

const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

function isSafeKey(key: string): boolean {
  return key.length > 0 && !UNSAFE_KEYS.has(key);
}

function isSafePathSegment(key: string): boolean {
  return (
    isSafeKey(key) &&
    key.trim().length > 0 &&
    !key.includes('.') &&
    !key.includes('/') &&
    !key.includes('\\')
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

function getOwn<T extends object>(obj: T, key: string): unknown {
  if (!isSafeKey(key) || !Object.hasOwn(obj, key)) {
    return undefined;
  }
  return Object.getOwnPropertyDescriptor(obj, key)?.value;
}

function setOwn<T extends object, V>(obj: T, key: string, value: V): void {
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

function normalizeZero(value: number): number {
  return value === 0 ? 0 : value;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function validateAndCloneJsonValue(
  value: unknown,
  path: string,
  acc: ErrorAccumulator
): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      acc.add(path, 'INVALID_NUMBER', `${path} must be a finite number`);
      return 0;
    }
    return normalizeZero(value);
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (let i = 0; i < value.length; i += 1) {
      out.push(validateAndCloneJsonValue(value[i], `${path}[${i}]`, acc));
    }
    return out;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.getOwnPropertyNames(value)) {
      if (!isSafeKey(key)) {
        acc.add(path, 'UNSAFE_KEY', `Forbidden key "${key}" at ${path}`);
        continue;
      }
      const childVal = Object.getOwnPropertyDescriptor(value, key)?.value;
      if (childVal === undefined) {
        continue;
      }
      setOwn(out, key, validateAndCloneJsonValue(childVal, `${path}.${key}`, acc));
    }
    return out;
  }
  acc.add(path, 'INVALID_TYPE', `${path} must be a JSON-safe value`);
  return undefined;
}

function cloneJsonValueSafe(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'number' && Number.isFinite(value) ? normalizeZero(value) : value;
  }
  if (Array.isArray(value)) {
    return value.map(cloneJsonValueSafe);
  }
  if (!isPlainObject(value)) {
    return undefined;
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.getOwnPropertyNames(value)) {
    if (!isSafeKey(key)) {
      continue;
    }
    const child = Object.getOwnPropertyDescriptor(value, key)?.value;
    if (child !== undefined) {
      setOwn(out, key, cloneJsonValueSafe(child));
    }
  }
  return out;
}

function cloneSectionsRecord(
  sections: Readonly<Record<string, string | readonly string[]>>
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const key of Object.getOwnPropertyNames(sections)) {
    if (!isSafeKey(key) || key.trim().length === 0) {
      continue;
    }
    const val = Object.getOwnPropertyDescriptor(sections, key)?.value;
    if (typeof val === 'string') {
      setOwn(out, key, val);
    } else if (isStringArray(val)) {
      setOwn(out, key, [...val]);
    }
  }
  return out;
}

function cloneCustomFieldsRecord(
  customFields: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.getOwnPropertyNames(customFields)) {
    if (!isSafeKey(key) || key.trim().length === 0) {
      continue;
    }
    const val = Object.getOwnPropertyDescriptor(customFields, key)?.value;
    if (val !== undefined) {
      setOwn(out, key, cloneJsonValueSafe(val));
    }
  }
  return out;
}

function cloneResourcesRecord(
  resources: Readonly<Record<string, ResourcePool>>
): Record<string, ResourcePool> {
  const out: Record<string, ResourcePool> = {};
  for (const key of Object.getOwnPropertyNames(resources)) {
    if (!isSafePathSegment(key)) {
      continue;
    }
    const pool = Object.getOwnPropertyDescriptor(resources, key)?.value as ResourcePool | undefined;
    if (
      pool !== undefined &&
      isPlainObject(pool) &&
      typeof pool.current === 'number' &&
      typeof pool.max === 'number'
    ) {
      setOwn(out, key, {
        current: normalizeZero(pool.current),
        max: normalizeZero(pool.max),
      });
    }
  }
  return out;
}

function cloneProgression(progression: Readonly<CharacterProgression>): CharacterProgression {
  const cloned: CharacterProgression = {
    level: progression.level,
    xp: normalizeZero(progression.xp),
  };
  if (progression.className !== undefined) {
    cloned.className = progression.className;
  }
  if (progression.subclass !== undefined) {
    cloned.subclass = progression.subclass;
  }
  if (progression.attributes !== undefined) {
    const attrs: Record<string, number> = {};
    for (const key of Object.getOwnPropertyNames(progression.attributes)) {
      if (!isSafePathSegment(key)) {
        continue;
      }
      const val = Object.getOwnPropertyDescriptor(progression.attributes, key)?.value;
      if (typeof val === 'number' && Number.isFinite(val)) {
        setOwn(attrs, key, normalizeZero(val));
      }
    }
    cloned.attributes = attrs;
  }
  return cloned;
}

/**
 * Validate an unknown input into a sanitized, deep-cloned {@link UserPersonaPreset}.
 */
export function validateUserPersonaPreset(
  raw: unknown
): Result<UserPersonaPreset, ValidationError[]> {
  if (!isPlainObject(raw)) {
    return err([validationError('', 'INVALID_TYPE', 'UserPersonaPreset must be a plain object')]);
  }

  const acc = new ErrorAccumulator();

  for (const key of Object.getOwnPropertyNames(raw)) {
    if (!isSafeKey(key)) {
      acc.add('', 'UNSAFE_KEY', `Forbidden key "${key}" on UserPersonaPreset`);
    }
  }

  const rawId = getOwn(raw, 'id');
  let id = '';
  if (typeof rawId !== 'string' || rawId.trim().length === 0) {
    acc.add('id', 'REQUIRED', 'UserPersonaPreset id must be a non-empty string');
  } else if (!isSafeKey(rawId.trim())) {
    acc.add('id', 'UNSAFE_KEY', `Forbidden preset id "${rawId}"`);
  } else {
    id = rawId.trim();
  }

  const rawName = getOwn(raw, 'name');
  let name = '';
  if (typeof rawName !== 'string' || rawName.trim().length === 0) {
    acc.add('name', 'REQUIRED', 'UserPersonaPreset name must be a non-empty string');
  } else {
    name = rawName.trim();
  }

  const rawDescription = getOwn(raw, 'description');
  let description = '';
  if (typeof rawDescription !== 'string') {
    acc.add('description', 'INVALID_TYPE', 'UserPersonaPreset description must be a string');
  } else {
    description = rawDescription;
  }

  const rawCharacterId = getOwn(raw, 'characterId');
  let characterId: string | null | undefined;
  if (rawCharacterId !== undefined) {
    if (rawCharacterId === null) {
      characterId = null;
    } else if (typeof rawCharacterId !== 'string' || rawCharacterId.trim().length === 0) {
      acc.add(
        'characterId',
        'INVALID_TYPE',
        'characterId must be null or a non-empty string'
      );
    } else if (!isSafePathSegment(rawCharacterId)) {
      acc.add(
        'characterId',
        'UNSAFE_KEY',
        `Invalid or forbidden characterId "${rawCharacterId}"`
      );
    } else {
      characterId = rawCharacterId;
    }
  }

  const rawSections = getOwn(raw, 'sections');
  let sections: Record<string, string | string[]> | undefined;
  if (rawSections !== undefined) {
    if (!isPlainObject(rawSections)) {
      acc.add('sections', 'INVALID_TYPE', 'sections must be a plain object');
    } else {
      sections = {};
      for (const secKey of Object.getOwnPropertyNames(rawSections)) {
        if (!isSafeKey(secKey) || secKey.trim().length === 0) {
          acc.add('sections', 'UNSAFE_KEY', `Invalid or forbidden section key "${secKey}"`);
          continue;
        }
        const secVal = Object.getOwnPropertyDescriptor(rawSections, secKey)?.value;
        if (typeof secVal === 'string') {
          setOwn(sections, secKey, secVal);
        } else if (isStringArray(secVal)) {
          setOwn(sections, secKey, [...secVal]);
        } else {
          acc.add(
            `sections.${secKey}`,
            'INVALID_TYPE',
            `sections.${secKey} must be a string or string[]`
          );
        }
      }
    }
  }

  const rawCustomFields = getOwn(raw, 'customFields');
  let customFields: Record<string, unknown> | undefined;
  if (rawCustomFields !== undefined) {
    if (!isPlainObject(rawCustomFields)) {
      acc.add('customFields', 'INVALID_TYPE', 'customFields must be a plain object');
    } else {
      customFields = {};
      for (const fieldKey of Object.getOwnPropertyNames(rawCustomFields)) {
        if (!isSafeKey(fieldKey) || fieldKey.trim().length === 0) {
          acc.add(
            'customFields',
            'UNSAFE_KEY',
            `Invalid or forbidden customField key "${fieldKey}"`
          );
          continue;
        }
        const fieldVal = Object.getOwnPropertyDescriptor(rawCustomFields, fieldKey)?.value;
        if (fieldVal === undefined) {
          continue;
        }
        const cloned = validateAndCloneJsonValue(fieldVal, `customFields.${fieldKey}`, acc);
        setOwn(customFields, fieldKey, cloned);
      }
    }
  }

  const rawResources = getOwn(raw, 'resources');
  let resources: Record<string, ResourcePool> | undefined;
  if (rawResources !== undefined) {
    if (!isPlainObject(rawResources)) {
      acc.add('resources', 'INVALID_TYPE', 'resources must be a plain object');
    } else {
      resources = {};
      for (const resKey of Object.getOwnPropertyNames(rawResources)) {
        if (!isSafePathSegment(resKey)) {
          acc.add('resources', 'UNSAFE_KEY', `Invalid or forbidden resource key "${resKey}"`);
          continue;
        }
        const poolRaw = Object.getOwnPropertyDescriptor(rawResources, resKey)?.value;
        if (!isPlainObject(poolRaw)) {
          acc.add(
            `resources.${resKey}`,
            'INVALID_TYPE',
            `resources.${resKey} must be a ResourcePool object`
          );
          continue;
        }
        for (const subKey of Object.getOwnPropertyNames(poolRaw)) {
          if (!isSafeKey(subKey)) {
            acc.add(`resources.${resKey}`, 'UNSAFE_KEY', `Forbidden key "${subKey}"`);
          }
        }
        const current = getOwn(poolRaw, 'current');
        const max = getOwn(poolRaw, 'max');
        let validPool = true;
        if (typeof current !== 'number' || !Number.isFinite(current) || current < 0) {
          acc.add(
            `resources.${resKey}.current`,
            'INVALID_NUMBER',
            'ResourcePool current must be a finite number >= 0'
          );
          validPool = false;
        }
        if (typeof max !== 'number' || !Number.isFinite(max) || max < 0) {
          acc.add(
            `resources.${resKey}.max`,
            'INVALID_NUMBER',
            'ResourcePool max must be a finite number >= 0'
          );
          validPool = false;
        }
        if (validPool && (current as number) > (max as number)) {
          acc.add(
            `resources.${resKey}.current`,
            'OUT_OF_RANGE',
            'ResourcePool current cannot exceed max'
          );
          validPool = false;
        }
        if (validPool) {
          setOwn(resources, resKey, {
            current: normalizeZero(current as number),
            max: normalizeZero(max as number),
          });
        }
      }
    }
  }

  const rawProgression = getOwn(raw, 'progression');
  let progression: CharacterProgression | undefined;
  if (rawProgression !== undefined) {
    if (!isPlainObject(rawProgression)) {
      acc.add('progression', 'INVALID_TYPE', 'progression must be a plain object');
    } else {
      for (const pKey of Object.getOwnPropertyNames(rawProgression)) {
        if (!isSafeKey(pKey)) {
          acc.add('progression', 'UNSAFE_KEY', `Forbidden key "${pKey}" in progression`);
        }
      }
      const level = getOwn(rawProgression, 'level');
      const xp = getOwn(rawProgression, 'xp');
      const className = getOwn(rawProgression, 'className');
      const subclass = getOwn(rawProgression, 'subclass');
      const rawAttrs = getOwn(rawProgression, 'attributes');

      if (typeof level !== 'number' || !Number.isInteger(level) || level < 1) {
        acc.add('progression.level', 'INVALID_INTEGER', 'progression.level must be integer >= 1');
      }
      if (typeof xp !== 'number' || !Number.isFinite(xp) || xp < 0) {
        acc.add('progression.xp', 'INVALID_NUMBER', 'progression.xp must be finite number >= 0');
      }
      if (className !== undefined && typeof className !== 'string') {
        acc.add('progression.className', 'INVALID_TYPE', 'progression.className must be a string');
      }
      if (subclass !== undefined && typeof subclass !== 'string') {
        acc.add('progression.subclass', 'INVALID_TYPE', 'progression.subclass must be a string');
      }

      let attributes: Record<string, number> | undefined;
      if (rawAttrs !== undefined) {
        if (!isPlainObject(rawAttrs)) {
          acc.add(
            'progression.attributes',
            'INVALID_TYPE',
            'progression.attributes must be a plain object'
          );
        } else {
          attributes = {};
          for (const attrKey of Object.getOwnPropertyNames(rawAttrs)) {
            if (!isSafePathSegment(attrKey)) {
              acc.add(
                'progression.attributes',
                'UNSAFE_KEY',
                `Invalid or forbidden attribute key "${attrKey}"`
              );
              continue;
            }
            const attrVal = Object.getOwnPropertyDescriptor(rawAttrs, attrKey)?.value;
            if (typeof attrVal !== 'number' || !Number.isFinite(attrVal)) {
              acc.add(
                `progression.attributes.${attrKey}`,
                'INVALID_NUMBER',
                `progression.attributes.${attrKey} must be a finite number`
              );
            } else {
              setOwn(attributes, attrKey, normalizeZero(attrVal));
            }
          }
        }
      }

      if (
        typeof level === 'number' &&
        Number.isInteger(level) &&
        level >= 1 &&
        typeof xp === 'number' &&
        Number.isFinite(xp) &&
        xp >= 0
      ) {
        progression = {
          level,
          xp: normalizeZero(xp),
          ...(typeof className === 'string' ? { className } : {}),
          ...(typeof subclass === 'string' ? { subclass } : {}),
          ...(attributes !== undefined ? { attributes } : {}),
        };
      }
    }
  }

  const rawUpdatedAt = getOwn(raw, 'updatedAt');
  let updatedAt: string | undefined;
  if (rawUpdatedAt !== undefined) {
    if (typeof rawUpdatedAt !== 'string') {
      acc.add('updatedAt', 'INVALID_TYPE', 'updatedAt must be a string');
    } else {
      updatedAt = rawUpdatedAt;
    }
  }

  if (acc.hasErrors()) {
    return err([...acc.errors]);
  }

  const preset: UserPersonaPreset = {
    id,
    name,
    description,
    ...(characterId !== undefined ? { characterId } : {}),
    ...(sections !== undefined ? { sections } : {}),
    ...(customFields !== undefined ? { customFields } : {}),
    ...(resources !== undefined ? { resources } : {}),
    ...(progression !== undefined ? { progression } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
  };

  return ok(preset);
}

/**
 * Deep-clone a {@link UserPersonaPreset} safely with prototype-pollution guards.
 */
export function cloneUserPersonaPreset(preset: Readonly<UserPersonaPreset>): UserPersonaPreset {
  const cloned: UserPersonaPreset = {
    id: preset.id,
    name: preset.name,
    description: preset.description,
  };
  if (preset.characterId !== undefined) {
    cloned.characterId = preset.characterId;
  }
  if (preset.sections !== undefined) {
    cloned.sections = cloneSectionsRecord(preset.sections);
  }
  if (preset.customFields !== undefined) {
    cloned.customFields = cloneCustomFieldsRecord(preset.customFields);
  }
  if (preset.resources !== undefined) {
    cloned.resources = cloneResourcesRecord(preset.resources);
  }
  if (preset.progression !== undefined) {
    cloned.progression = cloneProgression(preset.progression);
  }
  if (preset.updatedAt !== undefined) {
    cloned.updatedAt = preset.updatedAt;
  }
  return cloned;
}

/**
 * Translate a {@link UserPersonaPreset} into deterministic, atomic {@link PatchOperation}s
 * targeting `WorldState.player` (`set`, `section_patch`, `custom_field_patch`), skipping
 * subsystem paths (`resources`, `progression`, unresolved `characterId`) that do not exist
 * on `currentState` so the resulting batch applies cleanly via `applyPatchBatch`.
 */
export function buildPlayerPatchFromPersona(
  persona: Readonly<UserPersonaPreset>,
  currentState: Readonly<WorldState>
): PatchOperation[] {
  const ops: PatchOperation[] = [];

  if (typeof persona.name === 'string' && persona.name.trim().length > 0) {
    ops.push({
      op: 'set',
      path: 'player.name',
      value: persona.name,
    });
  }

  if (persona.characterId !== undefined) {
    if (persona.characterId === null) {
      ops.push({
        op: 'set',
        path: 'player.characterId',
        value: null,
      });
    } else if (
      typeof persona.characterId === 'string' &&
      isSafePathSegment(persona.characterId) &&
      Object.hasOwn(currentState.entities.characters, persona.characterId)
    ) {
      ops.push({
        op: 'set',
        path: 'player.characterId',
        value: persona.characterId,
      });
    }
  }

  if (persona.sections !== undefined) {
    const sectionKeys = Object.keys(persona.sections)
      .filter((k) => isSafeKey(k) && k.trim().length > 0)
      .sort(compareStringsDeterministic);
    for (const sectionId of sectionKeys) {
      const value = getOwn(persona.sections, sectionId);
      if (typeof value === 'string') {
        ops.push({
          op: 'section_patch',
          target: 'player',
          sectionId,
          value,
        });
      } else if (isStringArray(value)) {
        ops.push({
          op: 'section_patch',
          target: 'player',
          sectionId,
          value: [...value],
        });
      }
    }
  }

  if (persona.customFields !== undefined) {
    const fieldKeys = Object.keys(persona.customFields)
      .filter((k) => isSafeKey(k) && k.trim().length > 0)
      .sort(compareStringsDeterministic);
    for (const fieldId of fieldKeys) {
      const rawVal = getOwn(persona.customFields, fieldId);
      if (rawVal === undefined) {
        continue;
      }
      const clonedVal = cloneJsonValueSafe(rawVal);
      if (clonedVal !== undefined) {
        ops.push({
          op: 'custom_field_patch',
          target: 'player',
          fieldId,
          value: clonedVal,
        });
      }
    }
  }

  if (persona.resources !== undefined && currentState.player.resources !== undefined) {
    const resourceKeys = Object.keys(persona.resources)
      .filter(isSafePathSegment)
      .sort(compareStringsDeterministic);
    for (const resKey of resourceKeys) {
      const pool = getOwn(persona.resources, resKey) as ResourcePool | undefined;
      if (
        pool !== undefined &&
        isPlainObject(pool) &&
        typeof pool.current === 'number' &&
        Number.isFinite(pool.current) &&
        pool.current >= 0 &&
        typeof pool.max === 'number' &&
        Number.isFinite(pool.max) &&
        pool.max >= 0 &&
        pool.current <= pool.max
      ) {
        ops.push({
          op: 'set',
          path: `player.resources.${resKey}`,
          value: {
            current: normalizeZero(pool.current),
            max: normalizeZero(pool.max),
          },
        });
      }
    }
  }

  if (persona.progression !== undefined && currentState.player.progression !== undefined) {
    const prog = persona.progression;
    if (typeof prog.level === 'number' && Number.isInteger(prog.level) && prog.level >= 1) {
      ops.push({
        op: 'set',
        path: 'player.progression.level',
        value: prog.level,
      });
    }
    if (typeof prog.xp === 'number' && Number.isFinite(prog.xp) && prog.xp >= 0) {
      ops.push({
        op: 'set',
        path: 'player.progression.xp',
        value: normalizeZero(prog.xp),
      });
    }
    if (typeof prog.className === 'string') {
      ops.push({
        op: 'set',
        path: 'player.progression.className',
        value: prog.className,
      });
    }
    if (typeof prog.subclass === 'string') {
      ops.push({
        op: 'set',
        path: 'player.progression.subclass',
        value: prog.subclass,
      });
    }
    if (prog.attributes !== undefined) {
      const attrKeys = Object.keys(prog.attributes)
        .filter(isSafePathSegment)
        .sort(compareStringsDeterministic);
      for (const attrKey of attrKeys) {
        const attrVal = getOwn(prog.attributes, attrKey);
        if (typeof attrVal === 'number' && Number.isFinite(attrVal)) {
          ops.push({
            op: 'set',
            path: `player.progression.attributes.${attrKey}`,
            value: normalizeZero(attrVal),
          });
        }
      }
    }
  }

  return ops;
}
