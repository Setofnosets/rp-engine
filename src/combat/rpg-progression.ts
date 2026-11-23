import { RefereeError } from '../core/errors.js';
import type { SystemCapabilities } from '../schema/tracker-module.js';
import type { PatchOperation } from '../state/patch.js';
import type {
  CharacterEntity,
  CharacterProgression,
  ResourcePool,
} from '../state/world-state.js';

/**
 * Configuration curve governing XP level thresholds, HP growth per level,
 * and optional per-class skill/ability unlocks by level.
 */
export interface LevelUpCurve {
  readonly xpThresholds: readonly number[];
  readonly hpPerLevel: number;
  readonly classUnlocks?: Record<string, Record<number, readonly string[]>>;
}

/**
 * Deterministic result of awarding experience points to a {@link CharacterEntity}.
 */
export interface AwardExperienceResult {
  readonly nextCharacter: CharacterEntity;
  readonly leveledUp: boolean;
  readonly levelsGained: number;
  readonly unlockedAbilities: string[];
  readonly patches: PatchOperation[];
}

export const DEFAULT_LEVEL_UP_CURVE: LevelUpCurve = {
  xpThresholds: [0, 100, 300, 600, 1000, 1500, 2100, 2800, 3600, 4500],
  hpPerLevel: 10,
  classUnlocks: {
    warrior: {
      2: ['power_strike'],
      4: ['whirlwind'],
    },
    mage: {
      2: ['fireball'],
      3: ['arcane_shield'],
    },
    cleric: {
      2: ['healing_word'],
    },
  },
};

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

function isSafeKey(key: string): boolean {
  return key.length > 0 && !FORBIDDEN_KEYS.has(key);
}

function setOwnProperty<T>(record: Record<string, T>, key: string, value: T): void {
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
    for (const key of Object.keys(value as Record<string, unknown>)) {
      if (isSafeKey(key)) {
        const prop = Object.getOwnPropertyDescriptor(value, key)?.value;
        setOwnProperty(out, key, cloneUnknownValue(prop));
      }
    }
    return out;
  }
  return value;
}

function cloneCharacter(character: CharacterEntity): CharacterEntity {
  const sections: Record<string, string | string[]> = {};
  for (const key of Object.keys(character.sections)) {
    if (isSafeKey(key) && Object.hasOwn(character.sections, key)) {
      const value = character.sections[key];
      if (value !== undefined) {
        setOwnProperty(sections, key, Array.isArray(value) ? [...value] : value);
      }
    }
  }

  const customFields: Record<string, unknown> = {};
  for (const key of Object.keys(character.customFields)) {
    if (isSafeKey(key) && Object.hasOwn(character.customFields, key)) {
      setOwnProperty(customFields, key, cloneUnknownValue(character.customFields[key]));
    }
  }

  let progression: CharacterProgression | undefined;
  if (character.progression !== undefined) {
    let attributes: Record<string, number> | undefined;
    if (character.progression.attributes !== undefined) {
      attributes = {};
      for (const key of Object.keys(character.progression.attributes)) {
        if (isSafeKey(key) && Object.hasOwn(character.progression.attributes, key)) {
          const attr = character.progression.attributes[key];
          if (typeof attr === 'number') {
            setOwnProperty(attributes, key, attr);
          }
        }
      }
    }
    progression = {
      level: character.progression.level,
      xp: character.progression.xp,
      ...(character.progression.className !== undefined
        ? { className: character.progression.className }
        : {}),
      ...(character.progression.subclass !== undefined
        ? { subclass: character.progression.subclass }
        : {}),
      ...(attributes !== undefined ? { attributes } : {}),
    };
  }

  let resources: Record<string, ResourcePool> | undefined;
  if (character.resources !== undefined) {
    resources = {};
    for (const key of Object.keys(character.resources)) {
      if (isSafeKey(key) && Object.hasOwn(character.resources, key)) {
        const pool = character.resources[key];
        if (pool !== undefined) {
          setOwnProperty(resources, key, { current: pool.current, max: pool.max });
        }
      }
    }
  }

  return {
    id: character.id,
    name: character.name,
    status: character.status,
    presentInScene: character.presentInScene,
    locationId: character.locationId,
    formId: character.formId,
    formGroup: character.formGroup,
    sections,
    customFields,
    ...(progression !== undefined ? { progression } : {}),
    ...(resources !== undefined ? { resources } : {}),
    ...(character.corruption !== undefined ? { corruption: { ...character.corruption } } : {}),
    abilities: [...character.abilities],
    goals: [...character.goals],
    agenda: character.agenda,
    allegiance: character.allegiance,
    mood: character.mood,
    traits: [...character.traits],
  };
}

function getThresholdForLevel(xpThresholds: readonly number[], targetLevel: number): number | undefined {
  if (xpThresholds.length === 0 || targetLevel < 2) {
    return undefined;
  }
  const startsAtLevelOne = xpThresholds[0] === 0;
  const index = startsAtLevelOne ? targetLevel - 1 : targetLevel - 2;
  if (index < 0 || index >= xpThresholds.length) {
    return undefined;
  }
  const threshold = xpThresholds[index];
  return typeof threshold === 'number' && Number.isFinite(threshold) ? threshold : undefined;
}

function getClassUnlocksForLevel(
  classUnlocks: Record<string, Record<number, readonly string[]>> | undefined,
  className: string | undefined,
  level: number
): readonly string[] {
  if (classUnlocks === undefined || className === undefined || !isSafeKey(className)) {
    return [];
  }
  if (!Object.hasOwn(classUnlocks, className)) {
    return [];
  }
  const byLevel = Object.getOwnPropertyDescriptor(classUnlocks, className)?.value as
    | Record<number, readonly string[]>
    | undefined;
  if (byLevel === undefined || byLevel === null || typeof byLevel !== 'object') {
    return [];
  }
  const levelKey = String(level);
  if (!isSafeKey(levelKey) || !Object.hasOwn(byLevel, levelKey)) {
    return [];
  }
  const unlocked = Object.getOwnPropertyDescriptor(byLevel, levelKey)?.value;
  return Array.isArray(unlocked) ? (unlocked as readonly string[]) : [];
}

/**
 * Purely award experience points to a character when RPG progression is enabled in
 * {@link SystemCapabilities} and on `character.progression`. Handles multi-level jumps,
 * HP pool increases, deduplicated class ability unlocks, and emits compatible {@link PatchOperation}s.
 */
export function awardExperience(
  character: CharacterEntity,
  xpDelta: number,
  capabilities: SystemCapabilities,
  curve: LevelUpCurve = DEFAULT_LEVEL_UP_CURVE
): AwardExperienceResult {
  if (!isSafeKey(character.id)) {
    throw new RefereeError(`Invalid or forbidden character id "${character.id}"`, {
      code: 'INVALID_CHARACTER_ID',
    });
  }
  if (!Number.isFinite(xpDelta)) {
    throw new RefereeError(`xpDelta must be a finite number; received ${String(xpDelta)}`, {
      code: 'INVALID_XP_DELTA',
      details: { xpDelta },
    });
  }

  const nextCharacter = cloneCharacter(character);

  // Opt-in check: disabled progression capability or absent character progression is a safe no-op.
  if (
    capabilities.progression === 'disabled' ||
    nextCharacter.progression === undefined ||
    xpDelta <= 0
  ) {
    return {
      nextCharacter,
      leveledUp: false,
      levelsGained: 0,
      unlockedAbilities: [],
      patches: [],
    };
  }

  const progression = nextCharacter.progression;
  if (!Number.isFinite(progression.level) || !Number.isFinite(progression.xp)) {
    throw new RefereeError('Character progression level and xp must be finite numbers', {
      code: 'INVALID_PROGRESSION_STATE',
      details: { level: progression.level, xp: progression.xp },
    });
  }
  const startLevel = Math.max(1, Math.floor(progression.level));
  const nextXp = Math.max(0, Math.max(0, progression.xp) + xpDelta);
  progression.xp = nextXp === 0 ? 0 : nextXp;

  let currentLevel = startLevel;
  while (true) {
    const candidateLevel = currentLevel + 1;
    const threshold = getThresholdForLevel(curve.xpThresholds, candidateLevel);
    if (threshold === undefined || nextXp < threshold) {
      break;
    }
    currentLevel = candidateLevel;
  }

  const levelsGained = currentLevel - startLevel;
  const leveledUp = levelsGained > 0;
  progression.level = currentLevel;

  const patches: PatchOperation[] = [
    {
      op: 'set',
      path: `entities.characters.${nextCharacter.id}.progression.xp`,
      value: progression.xp,
    },
  ];

  const unlockedAbilities: string[] = [];

  if (leveledUp) {
    patches.push({
      op: 'set',
      path: `entities.characters.${nextCharacter.id}.progression.level`,
      value: currentLevel,
    });

    const safeHpPerLevel =
      Number.isFinite(curve.hpPerLevel) && curve.hpPerLevel > 0 ? curve.hpPerLevel : 0;
    const hpIncrease = safeHpPerLevel * levelsGained;

    if (hpIncrease > 0 && nextCharacter.resources !== undefined) {
      if (Object.hasOwn(nextCharacter.resources, 'hp')) {
        const hpPool = nextCharacter.resources['hp'];
        if (hpPool !== undefined) {
          const nextMax = Math.max(0, hpPool.max + hpIncrease);
          const nextCurrent = Math.min(nextMax, Math.max(0, hpPool.current + hpIncrease));
          hpPool.max = nextMax;
          hpPool.current = nextCurrent;
          // Emit max before current so reducer clamping never truncates the healed amount.
          patches.push(
            {
              op: 'set',
              path: `entities.characters.${nextCharacter.id}.resources.hp.max`,
              value: nextMax,
            },
            {
              op: 'set',
              path: `entities.characters.${nextCharacter.id}.resources.hp.current`,
              value: nextCurrent,
            }
          );
        }
      } else {
        const newHpPool: ResourcePool = { current: hpIncrease, max: hpIncrease };
        setOwnProperty(nextCharacter.resources, 'hp', newHpPool);
        patches.push({
          op: 'set',
          path: `entities.characters.${nextCharacter.id}.resources.hp`,
          value: { ...newHpPool },
        });
      }
    }

    const existingAbilitySet = new Set<string>(nextCharacter.abilities);
    for (let lvl = startLevel + 1; lvl <= currentLevel; lvl++) {
      const unlocks = getClassUnlocksForLevel(curve.classUnlocks, progression.className, lvl);
      for (const abilityId of unlocks) {
        if (typeof abilityId === 'string' && abilityId.length > 0 && !existingAbilitySet.has(abilityId)) {
          existingAbilitySet.add(abilityId);
          nextCharacter.abilities.push(abilityId);
          unlockedAbilities.push(abilityId);
          patches.push({
            op: 'push',
            path: `entities.characters.${nextCharacter.id}.abilities`,
            value: abilityId,
          });
        }
      }
    }
  }

  return {
    nextCharacter,
    leveledUp,
    levelsGained,
    unlockedAbilities,
    patches,
  };
}
