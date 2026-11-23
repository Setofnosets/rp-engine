import { describe, expect, it } from 'vitest';
import { RefereeError } from '../../src/core/errors.js';
import {
  type FormDefinition,
  applyFormProfileOverlay,
  buildFormIndex,
  isLegalTransform,
  selectExclusiveCast,
} from '../../src/state/forms.js';
import type { CharacterEntity } from '../../src/state/world-state.js';

function makeForms(): FormDefinition[] {
  return [
    {
      id: 'leila_civilian',
      formGroup: 'leila_renya',
      characterId: 'leila',
      displayName: 'Leila Renya',
      description: 'Civilian cover identity',
      abilities: ['Investigative Journalism'],
      traits: ['guarded', 'observant'],
      sections: {
        sec_body: 'Auburn hair, glasses, tailored trench coat.',
        sec_equipment: 'Press badge, notepad.',
      },
      legalTargets: ['leila_eclipse'],
    },
    {
      id: 'leila_eclipse',
      formGroup: 'leila_renya',
      characterId: 'leila',
      displayName: 'Eclipse',
      description: 'Masked vigilante persona',
      abilities: ['Shadow Step', 'Umbral Blade'],
      traits: ['relentless', 'theatrical'],
      sections: {
        sec_body: 'Cloaked in shifting dusk-weave.',
        sec_equipment: 'Umbral mask, twin daggers.',
      },
      legalTargets: ['leila_civilian', 'leila_umbra'],
    },
    {
      id: 'leila_umbra',
      formGroup: 'leila_renya',
      characterId: 'leila',
      displayName: 'Umbra Ascendant',
      abilities: ['Void Resonance'],
      traits: ['distant'],
      legalTargets: [],
    },
    {
      id: 'kestrel_a',
      formGroup: 'kestrel',
      characterId: 'kestrel',
      displayName: 'Kestrel Base',
    },
    {
      id: 'kestrel_b',
      formGroup: 'kestrel',
      characterId: 'kestrel',
      displayName: 'Kestrel Overdrive',
    },
    {
      id: 'symbiote_host_b',
      formGroup: 'kestrel',
      characterId: 'other_host',
      displayName: 'Other Host',
    },
  ];
}

function makeCharacter(overrides: Partial<CharacterEntity> = {}): CharacterEntity {
  return {
    id: 'leila',
    name: 'Leila Renya',
    status: 'active',
    presentInScene: true,
    locationId: 'newsroom',
    formId: 'leila_civilian',
    formGroup: 'leila_renya',
    sections: {
      sec_body: 'Auburn hair, glasses, tailored trench coat.',
      sec_equipment: 'Press badge, notepad.',
      sec_background: 'Veteran metro reporter.',
    },
    customFields: {
      cover_intact: true,
    },
    progression: {
      level: 4,
      xp: 1250,
      className: 'Shadowblade',
      attributes: { agility: 16 },
    },
    resources: {
      hp: { current: 24, max: 35 },
      willpower: { current: 7, max: 10 },
    },
    corruption: {
      stage: 1,
      progress: 35,
      source: 'shadow-shard',
    },
    abilities: ['Investigative Journalism'],
    goals: ['Expose Clairity Corp'],
    agenda: 'Investigate dockside shipments',
    allegiance: 'hero',
    mood: 'focused',
    traits: ['guarded', 'observant'],
    ...overrides,
  };
}

describe('buildFormIndex', () => {
  it('indexes form definitions by id and formGroup and isolates caller mutations', () => {
    const forms = makeForms();
    const index = buildFormIndex(forms);

    expect(index.byId.size).toBe(6);
    expect(index.byId.get('leila_eclipse')?.displayName).toBe('Eclipse');
    expect(index.byGroup.get('leila_renya')?.map((f) => f.id)).toEqual([
      'leila_civilian',
      'leila_eclipse',
      'leila_umbra',
    ]);

    // Mutate caller data after indexing
    forms[0]!.abilities!.push('Mutated Ability');
    forms[0]!.sections!['sec_body'] = 'Mutated Body';

    const indexed = index.byId.get('leila_civilian')!;
    expect(indexed.abilities).toEqual(['Investigative Journalism']);
    expect(indexed.sections?.['sec_body']).toBe('Auburn hair, glasses, tailored trench coat.');
  });

  it('rejects duplicate form ids and empty id or formGroup', () => {
    const forms = makeForms();
    expect(() => buildFormIndex([...forms, { ...forms[0]! }])).toThrowError(RefereeError);
    expect(() =>
      buildFormIndex([{ id: ' ', formGroup: 'g', characterId: 'c', displayName: 'X' }])
    ).toThrowError(RefereeError);
    expect(() =>
      buildFormIndex([{ id: 'f1', formGroup: '', characterId: 'c', displayName: 'X' }])
    ).toThrowError(RefereeError);
  });
});

describe('isLegalTransform', () => {
  it('enforces explicit legalTargets and prevents invalid transitions', () => {
    const index = buildFormIndex(makeForms());

    // Explicit legalTargets
    expect(isLegalTransform('leila_civilian', 'leila_eclipse', index)).toBe(true);
    expect(isLegalTransform('leila_civilian', 'leila_umbra', index)).toBe(false);
    expect(isLegalTransform('leila_civilian', 'leila_civilian', index)).toBe(false);
    expect(isLegalTransform('leila_eclipse', 'leila_civilian', index)).toBe(true);
    expect(isLegalTransform('leila_eclipse', 'leila_umbra', index)).toBe(true);

    // Explicitly empty legalTargets locks form
    expect(isLegalTransform('leila_umbra', 'leila_civilian', index)).toBe(false);
    expect(isLegalTransform('leila_umbra', 'leila_eclipse', index)).toBe(false);

    // Null currentFormId can adopt any indexed form; unknown forms fail
    expect(isLegalTransform(null, 'leila_civilian', index)).toBe(true);
    expect(isLegalTransform(null, 'nonexistent', index)).toBe(false);
    expect(isLegalTransform('unknown_current', 'leila_eclipse', index)).toBe(false);
    expect(isLegalTransform('leila_civilian', 'nonexistent', index)).toBe(false);
  });

  it('falls back to same formGroup and characterId when legalTargets is omitted', () => {
    const index = buildFormIndex(makeForms());

    expect(isLegalTransform('kestrel_a', 'kestrel_b', index)).toBe(true);
    expect(isLegalTransform('kestrel_b', 'kestrel_a', index)).toBe(true);
    expect(isLegalTransform('kestrel_a', 'kestrel_a', index)).toBe(false);
    // Different characterId in the same formGroup does not auto-allow transform without legalTargets
    expect(isLegalTransform('kestrel_a', 'symbiote_host_b', index)).toBe(false);
    // Different formGroup
    expect(isLegalTransform('kestrel_a', 'leila_civilian', index)).toBe(false);
  });
});

describe('applyFormProfileOverlay', () => {
  it('updates identity, traits, abilities, and overlaid sections while preserving resources, corruption, and progression', () => {
    const index = buildFormIndex(makeForms());
    const original = makeCharacter();

    const transformed = applyFormProfileOverlay(original, 'leila_eclipse', index);

    expect(transformed.formId).toBe('leila_eclipse');
    expect(transformed.formGroup).toBe('leila_renya');
    expect(transformed.name).toBe('Eclipse');
    expect(transformed.abilities).toEqual(['Shadow Step', 'Umbral Blade']);
    expect(transformed.traits).toEqual(['relentless', 'theatrical']);
    expect(transformed.sections).toEqual({
      sec_body: 'Cloaked in shifting dusk-weave.',
      sec_equipment: 'Umbral mask, twin daggers.',
      sec_background: 'Veteran metro reporter.',
    });

    // Preserved live RPG/world state
    expect(transformed.resources).toEqual({
      hp: { current: 24, max: 35 },
      willpower: { current: 7, max: 10 },
    });
    expect(transformed.progression).toEqual({
      level: 4,
      xp: 1250,
      className: 'Shadowblade',
      attributes: { agility: 16 },
    });
    expect(transformed.corruption).toEqual({
      stage: 1,
      progress: 35,
      source: 'shadow-shard',
    });
    expect(transformed.goals).toEqual(['Expose Clairity Corp']);
    expect(transformed.locationId).toBe('newsroom');

    // Verify immutability / no shared mutable references
    transformed.resources!.hp!.current = 1;
    transformed.progression!.attributes!.agility = 99;
    transformed.corruption!.stage = 5;
    transformed.abilities.push('Extra');
    expect(original.name).toBe('Leila Renya');
    expect(original.formId).toBe('leila_civilian');
    expect(original.resources?.hp?.current).toBe(24);
    expect(original.progression?.attributes?.agility).toBe(16);
    expect(original.corruption?.stage).toBe(1);
    expect(original.abilities).toEqual(['Investigative Journalism']);
  });

  it('keeps optional progression/resources/corruption omitted on Tier 0 characters and throws on missing form', () => {
    const index = buildFormIndex(makeForms());
    const tier0Char = makeCharacter({
      progression: undefined,
      resources: undefined,
      corruption: undefined,
    });

    const transformed = applyFormProfileOverlay(tier0Char, 'leila_eclipse', index);
    expect(transformed.progression).toBeUndefined();
    expect(transformed.resources).toBeUndefined();
    expect(transformed.corruption).toBeUndefined();

    expect(() => applyFormProfileOverlay(tier0Char, 'missing_form', index)).toThrowError(
      RefereeError
    );
  });
});

describe('selectExclusiveCast', () => {
  it('prevents co-existence of entities sharing a formGroup and resolves deterministically', () => {
    const pool = [
      { id: 'npc_zara', formGroup: null },
      { id: 'leila_eclipse', formGroup: 'leila_renya' },
      { id: 'leila_civilian', formGroup: 'leila_renya' },
      { id: 'npc_alex', formGroup: undefined },
      { id: 'kestrel_b', formGroup: 'kestrel' },
      { id: 'kestrel_a', formGroup: 'kestrel' },
    ];

    const selected = selectExclusiveCast(pool);
    expect(selected.map((e) => e.id)).toEqual([
      'kestrel_a',
      'leila_civilian',
      'npc_alex',
      'npc_zara',
    ]);

    // Permutation invariance
    const reversed = selectExclusiveCast([...pool].reverse());
    expect(reversed.map((e) => e.id)).toEqual(selected.map((e) => e.id));
  });

  it('honors preferIds priority order and deduplicates duplicate ids', () => {
    const pool = [
      { id: 'leila_civilian', formGroup: 'leila_renya' },
      { id: 'leila_eclipse', formGroup: 'leila_renya' },
      { id: 'leila_umbra', formGroup: 'leila_renya' },
      { id: 'npc_alex', formGroup: '' },
      { id: 'npc_alex', formGroup: '' },
      { id: 'npc_beth', formGroup: null },
    ];

    const selected = selectExclusiveCast(pool, ['leila_umbra', 'npc_beth']);
    expect(selected.map((e) => e.id)).toEqual(['leila_umbra', 'npc_beth', 'npc_alex']);
  });
});
