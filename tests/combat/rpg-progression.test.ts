import { describe, expect, it } from 'vitest';
import { type LevelUpCurve, awardExperience } from '../../src/combat/rpg-progression.js';
import type { SystemCapabilities } from '../../src/schema/tracker-module.js';
import { applyPatchBatch } from '../../src/state/reducer.js';
import { type CharacterEntity, createWorldState } from '../../src/state/world-state.js';

const RPG_CAPABILITIES: SystemCapabilities = {
  spatialMode: 'emergent',
  combatMode: 'tactical_grid',
  progression: 'rpg_levels',
  clocks: 'full_sim',
  factions: false,
  beats: false,
  relationships: false,
  chronicle: false,
};

const DISABLED_CAPABILITIES: SystemCapabilities = {
  ...RPG_CAPABILITIES,
  progression: 'disabled',
};

function createHero(overrides: Partial<CharacterEntity> = {}): CharacterEntity {
  return {
    id: 'hero',
    name: 'Kaelen',
    status: 'active',
    presentInScene: true,
    locationId: 'camp',
    formId: null,
    formGroup: null,
    sections: {},
    customFields: {},
    progression: {
      level: 1,
      xp: 0,
      className: 'warrior',
    },
    resources: {
      hp: { current: 20, max: 20 },
    },
    abilities: ['basic_strike'],
    goals: [],
    agenda: '',
    allegiance: 'party',
    mood: 'steady',
    traits: [],
    ...overrides,
  };
}

describe('RPG Progression (awardExperience)', () => {
  it('safely no-ops when capabilities.progression is disabled', () => {
    const hero = createHero();
    const res = awardExperience(hero, 500, DISABLED_CAPABILITIES);

    expect(res.leveledUp).toBe(false);
    expect(res.levelsGained).toBe(0);
    expect(res.unlockedAbilities).toEqual([]);
    expect(res.patches).toEqual([]);
    expect(res.nextCharacter.progression?.level).toBe(1);
    expect(res.nextCharacter.progression?.xp).toBe(0);
    expect(res.nextCharacter.resources?.['hp']).toEqual({ current: 20, max: 20 });
    expect(res.nextCharacter.abilities).toEqual(['basic_strike']);
    // Ensure defensive copy was returned without mutating input
    expect(res.nextCharacter).not.toBe(hero);
  });

  it('safely no-ops when character.progression is undefined', () => {
    const narrativeNpc = createHero({ id: 'merchant', progression: undefined });
    const res = awardExperience(narrativeNpc, 500, RPG_CAPABILITIES);

    expect(res.leveledUp).toBe(false);
    expect(res.levelsGained).toBe(0);
    expect(res.unlockedAbilities).toEqual([]);
    expect(res.patches).toEqual([]);
    expect(res.nextCharacter.progression).toBeUndefined();
  });

  it('handles multi-level XP jumps, unlocks class skills without duplicates, increases hp.max/current, and does not mutate input', () => {
    const hero = createHero({
      resources: { hp: { current: 15, max: 20 } },
      abilities: ['basic_strike', 'power_strike'], // power_strike already known
    });

    const curve: LevelUpCurve = {
      xpThresholds: [0, 100, 300, 600],
      hpPerLevel: 8,
      classUnlocks: {
        warrior: {
          2: ['power_strike', 'shield_wall'],
          3: ['cleave'],
          4: ['whirlwind'],
        },
      },
    };

    const res = awardExperience(hero, 650, RPG_CAPABILITIES, curve);

    expect(res.leveledUp).toBe(true);
    expect(res.levelsGained).toBe(3); // 1 -> 4
    expect(res.nextCharacter.progression?.level).toBe(4);
    expect(res.nextCharacter.progression?.xp).toBe(650);
    expect(res.nextCharacter.resources?.['hp']).toEqual({
      current: 15 + 24,
      max: 20 + 24,
    });
    expect(res.unlockedAbilities).toEqual(['shield_wall', 'cleave', 'whirlwind']);
    expect(res.nextCharacter.abilities).toEqual([
      'basic_strike',
      'power_strike',
      'shield_wall',
      'cleave',
      'whirlwind',
    ]);

    // Input hero remains untouched
    expect(hero.progression?.level).toBe(1);
    expect(hero.progression?.xp).toBe(0);
    expect(hero.resources?.['hp']).toEqual({ current: 15, max: 20 });
    expect(hero.abilities).toEqual(['basic_strike', 'power_strike']);
  });

  it('supports xpThresholds starting at level 2 threshold (> 0) and non-leveling XP increments', () => {
    const hero = createHero();
    const curve: LevelUpCurve = {
      xpThresholds: [100, 250, 500],
      hpPerLevel: 5,
      classUnlocks: {
        warrior: {
          2: ['power_strike'],
        },
      },
    };

    const subThreshold = awardExperience(hero, 50, RPG_CAPABILITIES, curve);
    expect(subThreshold.leveledUp).toBe(false);
    expect(subThreshold.levelsGained).toBe(0);
    expect(subThreshold.nextCharacter.progression?.xp).toBe(50);
    expect(subThreshold.nextCharacter.progression?.level).toBe(1);
    expect(subThreshold.patches).toEqual([
      { op: 'set', path: 'entities.characters.hero.progression.xp', value: 50 },
    ]);

    const leveled = awardExperience(subThreshold.nextCharacter, 60, RPG_CAPABILITIES, curve);
    expect(leveled.leveledUp).toBe(true);
    expect(leveled.levelsGained).toBe(1);
    expect(leveled.nextCharacter.progression?.level).toBe(2);
    expect(leveled.nextCharacter.progression?.xp).toBe(110);
    expect(leveled.unlockedAbilities).toEqual(['power_strike']);
  });

  it('guards against prototype pollution on className during unlock lookup', () => {
    const hero = createHero({
      progression: { level: 1, xp: 0, className: 'constructor' },
    });
    const res = awardExperience(hero, 200, RPG_CAPABILITIES);
    expect(res.leveledUp).toBe(true);
    expect(res.unlockedAbilities).toEqual([]);
  });

  it('emits PatchOperations compatible with WorldState reducer applyPatchBatch', () => {
    const hero = createHero({
      resources: { hp: { current: 20, max: 20 } },
    });
    const state = createWorldState({
      sessionId: 'progression-reducer-check',
      capabilities: RPG_CAPABILITIES,
      entities: {
        characters: {
          [hero.id]: hero,
        },
      },
    });

    const awardRes = awardExperience(hero, 150, RPG_CAPABILITIES);
    expect(awardRes.leveledUp).toBe(true);

    const patchRes = applyPatchBatch(state, {
      eventId: 'evt_xp_1',
      source: 'combat',
      operations: awardRes.patches,
    });

    expect(patchRes.ok).toBe(true);
    if (patchRes.ok) {
      const updatedHero = patchRes.value.nextState.entities.characters['hero'];
      expect(updatedHero?.progression?.level).toBe(2);
      expect(updatedHero?.progression?.xp).toBe(150);
      expect(updatedHero?.resources?.['hp']).toEqual({ current: 30, max: 30 });
      expect(updatedHero?.abilities).toEqual(['basic_strike', 'power_strike']);
    }
  });
});
