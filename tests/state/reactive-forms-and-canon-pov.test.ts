import { describe, expect, it } from 'vitest';
import { evaluateBeatGraph, evaluateReactiveFormsForState } from '../../src/beats/beat-engine.js';
import { createInitialBeatLedger } from '../../src/beats/beat-ledger.js';
import { isErr, isOk } from '../../src/core/result.js';
import {
  type FormDefinition,
  type FormTransitionRule,
  buildFormIndex,
  buildFormRuleDependencyIndex,
  evaluateFormTransitionRules,
  validateFormTransitionRules,
} from '../../src/state/forms.js';
import { applyPatchBatch } from '../../src/state/reducer.js';
import {
  bindPlayerToCanonCharacter,
  createWorldState,
  validateWorldState,
} from '../../src/state/world-state.js';
import { computeLocationCast } from '../../src/world/cast-presence.js';

const VAIVA_FORMS: FormDefinition[] = [
  {
    id: 'vaiva_civilian',
    formGroup: 'vaiva_group',
    characterId: 'vaiva',
    displayName: 'Vaiva',
    abilities: ['investigative_eye'],
    traits: ['composed'],
    sections: { appearance: 'Plain trenchcoat and press badge.' },
  },
  {
    id: 'vaiva_colorgarde',
    formGroup: 'vaiva_group',
    characterId: 'vaiva',
    displayName: 'Colorgarde',
    abilities: ['prism_shield', 'chromatic_lance'],
    traits: ['vigilant', 'heroic'],
    sections: { appearance: 'Prismatic armor with refracting visor.' },
  },
  {
    id: 'vaiva_corrupted',
    formGroup: 'vaiva_group',
    characterId: 'vaiva',
    displayName: 'Fractured Colorgarde',
    abilities: ['void_refraction'],
    traits: ['corrupted'],
    sections: { appearance: 'Cracked obsidian prisms leaking shadow.' },
    legalTargets: ['vaiva_civilian'],
  },
];

function createTestState() {
  return createWorldState({
    sessionId: 'sess-pr73',
    capabilities: {
      spatialMode: 'authored_graph',
      progression: 'rpg_levels',
      combatMode: 'traditional',
      clocks: 'disabled',
      factions: false,
      beats: false,
      relationships: false,
      chronicle: false,
    },
    scene: {
      location: 'Plaza',
      locationId: 'plaza',
      presentCharacterIds: ['vaiva', 'vaiva_doppelganger', 'claire'],
    },
    locations: [
      {
        id: 'plaza',
        name: 'Plaza',
        kind: 'landmark',
        status: 'safe',
        notes: 'Central square',
        tags: ['public'],
        connectedLocations: [],
        controllingFactionId: null,
        discovered: true,
      },
      {
        id: 'newsroom',
        name: 'Newsroom',
        kind: 'landmark',
        status: 'safe',
        notes: 'Press office',
        tags: ['indoor'],
        connectedLocations: [],
        controllingFactionId: null,
        discovered: true,
      },
    ],
    characters: [
      {
        id: 'vaiva',
        name: 'Vaiva',
        status: 'active',
        presentInScene: true,
        locationId: 'newsroom',
        formId: 'vaiva_civilian',
        formGroup: 'vaiva_group',
        sections: { appearance: 'Plain trenchcoat and press badge.' },
        customFields: {},
        progression: { level: 3, xp: 450, className: 'Prism', attributes: { resolve: 14 } },
        resources: { hp: { current: 24, max: 24 }, willpower: { current: 12, max: 12 } },
        corruption: { stage: 0, progress: 0, source: null },
        abilities: ['investigative_eye'],
        goals: ['Protect NeoTerra'],
        agenda: 'Uncover the leak',
        allegiance: 'colorgarde',
        mood: 'focused',
        traits: ['composed'],
      },
      {
        id: 'vaiva_doppelganger',
        name: 'Colorgarde (Alt)',
        status: 'active',
        presentInScene: true,
        locationId: 'newsroom',
        formId: 'vaiva_colorgarde',
        formGroup: 'vaiva_group',
        sections: {},
        customFields: {},
        abilities: ['prism_shield'],
        goals: [],
        agenda: '',
        allegiance: 'colorgarde',
        mood: 'alert',
        traits: ['vigilant'],
      },
      {
        id: 'claire',
        name: 'Claire Atropos',
        status: 'active',
        presentInScene: true,
        locationId: 'newsroom',
        formId: null,
        formGroup: null,
        sections: {},
        customFields: {},
        abilities: ['time_cut'],
        goals: [],
        agenda: 'Observe',
        allegiance: 'neutral',
        mood: 'calm',
        traits: ['analytical'],
      },
    ],
  });
}

describe('PR-7.3: Reactive Multi-Form Rules & Canon Character Player Takeover', () => {
  it('validates FormTransitionRule definitions and rejects mismatched groups or unsafe keys', () => {
    const formIndex = buildFormIndex(VAIVA_FORMS);

    const validRules: FormTransitionRule[] = [
      {
        id: 'rule_corrupt',
        formGroup: 'vaiva_group',
        fromFormId: '*',
        toFormId: 'vaiva_corrupted',
        when: { flag: 'void_breach', value: true },
        priority: 100,
        permanent: true,
        reversibleBy: ['purification_ritual'],
        triggerTag: 'corruption_threshold',
        secretIdentity: {
          knownByCharacterIds: ['claire'],
          unmaskOnPublicTransform: true,
        },
      },
    ];
    expect(isOk(validateFormTransitionRules(validRules, formIndex))).toBe(true);

    const invalidRules: FormTransitionRule[] = [
      {
        id: '__proto__',
        formGroup: 'vaiva_group',
        fromFormId: 'missing_form',
        toFormId: 'vaiva_corrupted',
        when: { flag: 'x', value: true },
        priority: Number.NaN,
      },
    ];
    const invalidRes = validateFormTransitionRules(invalidRules, formIndex);
    expect(isErr(invalidRes)).toBe(true);
    if (!invalidRes.ok) {
      const codes = invalidRes.error.map((e) => e.code);
      expect(codes).toContain('UNSAFE_PROPERTY_KEY');
      expect(codes).toContain('FORM_NOT_FOUND');
      expect(codes).toContain('INVALID_NUMBER');
    }
  });

  it('evaluates rules deterministically by priority/id, triggers corruption morph, and enforces permanent lock + cure', () => {
    const formIndex = buildFormIndex(VAIVA_FORMS);
    const rules: FormTransitionRule[] = [
      {
        id: 'rule_hero_transform',
        formGroup: 'vaiva_group',
        fromFormId: 'vaiva_civilian',
        toFormId: 'vaiva_colorgarde',
        when: { flag: 'alarm_raised', value: true },
        priority: 50,
      },
      {
        id: 'rule_corrupt_threshold',
        formGroup: 'vaiva_group',
        fromFormId: '*',
        toFormId: 'vaiva_corrupted',
        when: {
          entity: ['characters', 'vaiva', 'corruption.progress'],
          op: '>=',
          value: 80,
        },
        priority: 100,
        permanent: true,
        reversibleBy: ['purification_ritual'],
        triggerTag: 'corruption',
      },
      {
        id: 'rule_cure_vaiva',
        formGroup: 'vaiva_group',
        fromFormId: 'vaiva_corrupted',
        toFormId: 'vaiva_civilian',
        when: { flag: 'purified', value: true },
        priority: 80,
        reversibleBy: ['purification_ritual'],
      },
    ];

    const baseState = createTestState();
    const depIndex = buildFormRuleDependencyIndex(rules);

    // Raise alarm and push corruption to 85 -> higher priority corruption rule (100) wins over hero (50)
    const mutatedRes = applyPatchBatch(baseState, {
      eventId: 'evt-corrupt',
      source: 'engine',
      operations: [
        { op: 'set', path: 'flags.alarm_raised', value: true },
        {
          op: 'entity_patch',
          collection: 'characters',
          entityId: 'vaiva',
          patch: { corruption: { stage: 2, progress: 85, source: 'void_shard' } },
        },
      ],
    });
    expect(isOk(mutatedRes)).toBe(true);
    if (!mutatedRes.ok) return;

    const reactiveRes = evaluateReactiveFormsForState({
      state: mutatedRes.value.nextState,
      formIndex,
      formRules: rules,
      dependencyIndex: depIndex,
      changedPaths: mutatedRes.value.changedPaths,
    });
    expect(isOk(reactiveRes)).toBe(true);
    if (!reactiveRes.ok) return;

    expect(reactiveRes.value.operations).toHaveLength(1);
    expect(reactiveRes.value.operations[0]).toMatchObject({
      op: 'form_transform',
      characterId: 'vaiva',
      targetFormId: 'vaiva_corrupted',
      lockPermanent: true,
      triggerTag: 'corruption',
    });

    const corruptedState = reactiveRes.value.nextState;
    const vaivaCorrupted = corruptedState.entities.characters['vaiva'];
    expect(vaivaCorrupted?.formId).toBe('vaiva_corrupted');
    expect(vaivaCorrupted?.name).toBe('Fractured Colorgarde');
    expect(vaivaCorrupted?.lockedForms?.['vaiva_corrupted']).toBe(true);
    expect(vaivaCorrupted?.resources?.['hp']).toEqual({ current: 24, max: 24 });

    // Manual revert without cureTrigger is blocked by FORM_LOCKED
    const blockedRevert = applyPatchBatch(
      corruptedState,
      {
        eventId: 'evt-manual-revert',
        source: 'engine',
        operations: [{ op: 'form_transform', characterId: 'vaiva', targetFormId: 'vaiva_civilian' }],
      },
      { formIndex, formRules: rules }
    );
    expect(isErr(blockedRevert)).toBe(true);
    if (!blockedRevert.ok) {
      expect(blockedRevert.error[0]?.code).toBe('FORM_LOCKED');
    }

    // Wrong cureTrigger is also blocked
    const wrongCure = applyPatchBatch(
      corruptedState,
      {
        eventId: 'evt-wrong-cure',
        source: 'engine',
        operations: [
          {
            op: 'form_transform',
            characterId: 'vaiva',
            targetFormId: 'vaiva_civilian',
            cureTrigger: 'bandaid',
          },
        ],
      },
      { formIndex, formRules: rules }
    );
    expect(isErr(wrongCure)).toBe(true);

    // Setting purified flag without activeCureTriggers still respects permanent lock
    const purifiedFlagRes = applyPatchBatch(corruptedState, {
      eventId: 'evt-purified-flag',
      source: 'engine',
      operations: [{ op: 'set', path: 'flags.purified', value: true }],
    });
    expect(isOk(purifiedFlagRes)).toBe(true);
    if (!purifiedFlagRes.ok) return;

    const opsWithoutCure = evaluateFormTransitionRules(
      purifiedFlagRes.value.nextState,
      formIndex,
      rules
    );
    expect(opsWithoutCure).toEqual([]);

    // With activeCureTriggers: ['purification_ritual'], beat-engine / reactive evaluation cures the form
    const ledger = createInitialBeatLedger([]);
    const beatRes = evaluateBeatGraph({
      state: purifiedFlagRes.value.nextState,
      ledger,
      beats: [],
      formIndex,
      formRules: rules,
      activeCureTriggers: ['purification_ritual'],
    });

    const curedVaiva = beatRes.nextState.entities.characters['vaiva'];
    expect(curedVaiva?.formId).toBe('vaiva_civilian');
    expect(curedVaiva?.name).toBe('Vaiva');
    expect(curedVaiva?.lockedForms).toBeUndefined();
  });

  it('binds player to canon character and excludes canon character + same formGroup NPCs from cast', () => {
    const formIndex = buildFormIndex(VAIVA_FORMS);
    const initial = createTestState();
    const snapshot = structuredClone(initial);

    const bound = bindPlayerToCanonCharacter(initial, 'vaiva', formIndex);
    // Input state remains unmutated
    expect(initial).toEqual(snapshot);

    expect(bound.player.characterId).toBe('vaiva');
    expect(bound.player.canonCharacterId).toBe('vaiva');
    expect(bound.player.name).toBe('Vaiva');
    expect(bound.player.locationId).toBe('newsroom');
    expect(bound.player.sections['appearance']).toBe('Plain trenchcoat and press badge.');
    expect(bound.player.resources?.['hp']).toEqual({ current: 24, max: 24 });
    expect(bound.player.progression?.level).toBe(3);
    expect(bound.scene.locationId).toBe('newsroom');
    expect(bound.scene.location).toBe('Newsroom');
    expect(bound.scene.presentCharacterIds).toEqual(['claire']);

    // computeLocationCast excludes both 'vaiva' and 'vaiva_doppelganger' (same formGroup)
    const cast1 = computeLocationCast(bound, VAIVA_FORMS);
    expect(cast1.excludedPlayerCharacterId).toBe('vaiva');
    expect(cast1.presentCharacterIds).toEqual(['claire']);

    // Switching Vaiva to Colorgarde keeps player synced and still excludes vaiva_doppelganger
    const transformedRes = applyPatchBatch(
      bound,
      {
        eventId: 'evt-transform-canon',
        source: 'engine',
        operations: [{ op: 'form_transform', characterId: 'vaiva', targetFormId: 'vaiva_colorgarde' }],
      },
      { formIndex }
    );
    expect(isOk(transformedRes)).toBe(true);
    if (!transformedRes.ok) return;

    expect(transformedRes.value.nextState.player.name).toBe('Colorgarde');
    expect(transformedRes.value.nextState.player.sections['appearance']).toBe(
      'Prismatic armor with refracting visor.'
    );

    const cast2 = computeLocationCast(transformedRes.value.nextState, VAIVA_FORMS);
    expect(cast2.presentCharacterIds).toEqual(['claire']);

    // validateWorldState accepts valid canonCharacterId + lockedForms and rejects unresolved canonCharacterId
    const validCheck = validateWorldState(transformedRes.value.nextState);
    expect(isOk(validCheck)).toBe(true);

    const badState = structuredClone(bound);
    badState.player.canonCharacterId = 'nonexistent_char';
    const invalidCheck = validateWorldState(badState);
    expect(isErr(invalidCheck)).toBe(true);
  });
});
