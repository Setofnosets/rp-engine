import { describe, expect, it } from 'vitest';
import {
  type UserPersonaPreset,
  buildPlayerPatchFromPersona,
  cloneUserPersonaPreset,
  validateUserPersonaPreset,
} from '../../src/config/persona-preset.js';
import { isErr, isOk } from '../../src/core/result.js';
import { applyPatchBatch } from '../../src/state/reducer.js';
import { createWorldState } from '../../src/state/world-state.js';

describe('UserPersonaPreset', () => {
  it('validates and deep-clones a complete UserPersonaPreset', () => {
    const raw = {
      id: '  lyra-voss  ',
      name: '  Lyra Voss  ',
      description: 'Former orbital salvage engineer with a dry wit.',
      characterId: 'lyra_char',
      sections: {
        sec_species: 'Human',
        sec_strengths: ['Zero-G EVA', 'Micro-soldering'],
      },
      customFields: {
        callsign: 'Sparrow',
        meta: { clearance: 3, tags: ['verified'] },
      },
      resources: {
        hp: { current: 24, max: 30 },
        stamina: { current: 80, max: 100 },
      },
      progression: {
        level: 4,
        xp: 1250,
        className: 'Engineer',
        subclass: 'Rig Specialist',
        attributes: { tech: 16, grit: 12 },
      },
      updatedAt: '2026-03-14T12:00:00.000Z',
    };

    const res = validateUserPersonaPreset(raw);
    expect(isOk(res)).toBe(true);
    if (!res.ok) {
      return;
    }

    expect(res.value.id).toBe('lyra-voss');
    expect(res.value.name).toBe('Lyra Voss');
    expect(res.value.characterId).toBe('lyra_char');
    expect(res.value.sections?.['sec_strengths']).toEqual(['Zero-G EVA', 'Micro-soldering']);
    expect(res.value.progression?.attributes).toEqual({ tech: 16, grit: 12 });

    // Mutate input raw after validation -> validated output stays isolated
    (raw.sections.sec_strengths as string[]).push('MUTATED');
    raw.customFields.meta.tags.push('MUTATED');
    raw.resources.hp.current = 0;
    raw.progression.attributes.tech = 99;
    expect(res.value.sections?.['sec_strengths']).toEqual(['Zero-G EVA', 'Micro-soldering']);
    expect((res.value.customFields?.['meta'] as { tags: string[] }).tags).toEqual(['verified']);
    expect(res.value.resources?.['hp']?.current).toBe(24);
    expect(res.value.progression?.attributes?.['tech']).toBe(16);

    // cloneUserPersonaPreset produces an independent deep copy
    const cloned = cloneUserPersonaPreset(res.value);
    expect(cloned).toEqual(res.value);
    expect(cloned).not.toBe(res.value);
    (cloned.sections!['sec_strengths'] as string[]).push('CLONE_EDIT');
    cloned.resources!['hp']!.current = 1;
    expect(res.value.sections?.['sec_strengths']).toEqual(['Zero-G EVA', 'Micro-soldering']);
    expect(res.value.resources?.['hp']?.current).toBe(24);
  });

  it('rejects invalid fields and prototype-pollution payloads with structured ValidationErrors', () => {
    const nonObj = validateUserPersonaPreset('not-an-object');
    expect(isErr(nonObj)).toBe(true);

    const badFields = validateUserPersonaPreset({
      id: '   ',
      name: '',
      description: 42,
      characterId: 'bad.id',
      sections: { sec_body: 123 },
      customFields: { badNum: Number.NaN },
      resources: { hp: { current: 15, max: 10 } },
      progression: { level: 0, xp: -5, attributes: { str: Number.POSITIVE_INFINITY } },
      updatedAt: 999,
    });
    expect(isErr(badFields)).toBe(true);
    if (!badFields.ok) {
      const codes = badFields.error.map((e) => e.code);
      expect(codes).toContain('REQUIRED');
      expect(codes).toContain('INVALID_TYPE');
      expect(codes).toContain('UNSAFE_KEY');
      expect(codes).toContain('INVALID_NUMBER');
      expect(codes).toContain('OUT_OF_RANGE');
      expect(codes).toContain('INVALID_INTEGER');
    }

    const polluted = JSON.parse(
      '{"id":"p1","name":"Safe","description":"Desc","__proto__":{"admin":true},"sections":{"constructor":"bad"},"customFields":{"nested":{"prototype":"evil"}}}'
    ) as unknown;
    const pollutedRes = validateUserPersonaPreset(polluted);
    expect(isErr(pollutedRes)).toBe(true);
    if (!pollutedRes.ok) {
      expect(pollutedRes.error.some((e) => e.code === 'UNSAFE_KEY')).toBe(true);
    }
    expect(({} as Record<string, unknown>)['admin']).toBeUndefined();
  });

  it('buildPlayerPatchFromPersona emits atomic ops that apply cleanly via applyPatchBatch', () => {
    const state = createWorldState({
      sessionId: 'persona-test',
      capabilities: {
        spatialMode: 'scene_only',
        combatMode: 'traditional',
        progression: 'rpg_levels',
        clocks: 'disabled',
        factions: false,
        beats: false,
        relationships: false,
        chronicle: false,
      },
      characters: [
        {
          id: 'lyra_char',
          name: 'Lyra Voss',
          status: 'active',
          presentInScene: true,
          locationId: null,
          formId: null,
          formGroup: null,
          sections: {},
          customFields: {},
          abilities: [],
          goals: [],
          agenda: '',
          allegiance: '',
          mood: 'focused',
          traits: [],
        },
      ],
    });

    const persona: UserPersonaPreset = {
      id: 'lyra',
      name: 'Lyra Voss',
      description: 'Salvage specialist',
      characterId: 'lyra_char',
      sections: {
        sec_strengths: ['Zero-G EVA', 'Electronics'],
        sec_body: 'Lean build with oil-stained coveralls.',
      },
      customFields: {
        callsign: 'Sparrow',
        hazard_rating: 2,
      },
      resources: {
        hp: { current: 18, max: 20 },
        mana: { current: 10, max: 10 },
      },
      progression: {
        level: 3,
        xp: 450,
        className: 'Artificer',
        subclass: 'Salvager',
        attributes: { tech: 15, agility: 13 },
      },
    };

    const ops = buildPlayerPatchFromPersona(persona, state);
    expect(ops.some((op) => op.op === 'set' && op.path === 'player.name')).toBe(true);
    expect(ops.some((op) => op.op === 'set' && op.path === 'player.characterId')).toBe(true);
    expect(ops.some((op) => op.op === 'section_patch' && op.sectionId === 'sec_body')).toBe(true);
    expect(ops.some((op) => op.op === 'custom_field_patch' && op.fieldId === 'callsign')).toBe(true);
    expect(ops.some((op) => op.op === 'set' && op.path === 'player.resources.mana')).toBe(true);
    expect(ops.some((op) => op.op === 'set' && op.path === 'player.progression.attributes.tech')).toBe(
      true
    );

    const reduced = applyPatchBatch(state, {
      eventId: 'evt-apply-persona',
      source: 'player',
      operations: ops,
    });
    expect(isOk(reduced)).toBe(true);
    if (!reduced.ok) {
      return;
    }

    const nextPlayer = reduced.value.nextState.player;
    expect(nextPlayer.name).toBe('Lyra Voss');
    expect(nextPlayer.characterId).toBe('lyra_char');
    expect(nextPlayer.sections['sec_body']).toBe('Lean build with oil-stained coveralls.');
    expect(nextPlayer.sections['sec_strengths']).toEqual(['Zero-G EVA', 'Electronics']);
    expect(nextPlayer.customFields['callsign']).toBe('Sparrow');
    expect(nextPlayer.customFields['hazard_rating']).toBe(2);
    expect(nextPlayer.resources?.['hp']).toEqual({ current: 18, max: 20 });
    expect(nextPlayer.resources?.['mana']).toEqual({ current: 10, max: 10 });
    expect(nextPlayer.progression).toEqual({
      level: 3,
      xp: 450,
      className: 'Artificer',
      subclass: 'Salvager',
      attributes: { tech: 15, agility: 13 },
    });
  });

  it('skips missing subsystems and unresolved characterIds cleanly so freeform patches still succeed', () => {
    const freeformState = createWorldState({
      sessionId: 'freeform-persona',
    });
    expect(freeformState.player.resources).toBeUndefined();
    expect(freeformState.player.progression).toBeUndefined();

    const persona: UserPersonaPreset = {
      id: 'kairo',
      name: 'Kairo',
      description: 'Wanderer',
      characterId: 'missing_character_id',
      sections: {
        sec_personality: 'Calm and observant.',
      },
      customFields: {
        motto: 'Wait and watch.',
      },
      resources: {
        hp: { current: 10, max: 10 },
      },
      progression: {
        level: 2,
        xp: 100,
      },
    };

    const ops = buildPlayerPatchFromPersona(persona, freeformState);
    expect(ops.some((op) => op.op === 'set' && op.path === 'player.characterId')).toBe(false);
    expect(ops.some((op) => op.op === 'set' && op.path.startsWith('player.resources.'))).toBe(false);
    expect(ops.some((op) => op.op === 'set' && op.path.startsWith('player.progression.'))).toBe(
      false
    );

    const reduced = applyPatchBatch(freeformState, {
      eventId: 'evt-freeform-persona',
      source: 'player',
      operations: ops,
    });
    expect(isOk(reduced)).toBe(true);
    if (!reduced.ok) {
      return;
    }
    expect(reduced.value.nextState.player.name).toBe('Kairo');
    expect(reduced.value.nextState.player.sections['sec_personality']).toBe('Calm and observant.');
    expect(reduced.value.nextState.player.customFields['motto']).toBe('Wait and watch.');

    // Explicit null characterId IS emitted to unlink player.characterId
    const unlinkPersona: UserPersonaPreset = {
      id: 'unlink',
      name: 'Kairo',
      description: '',
      characterId: null,
    };
    const unlinkOps = buildPlayerPatchFromPersona(unlinkPersona, freeformState);
    expect(unlinkOps).toContainEqual({ op: 'set', path: 'player.characterId', value: null });
  });
});
