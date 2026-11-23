import { describe, expect, it } from 'vitest';
import { type ValidationError } from '../../src/core/errors.js';
import { isErr, isOk } from '../../src/core/result.js';
import { type WorldState, createWorldState } from '../../src/state/world-state.js';
import {
  type BeatStatus,
  type PredicateAst,
  validatePredicateAst,
} from '../../src/beats/predicate-ast.js';
import {
  type PredicateEvalContext,
  evaluatePredicate,
} from '../../src/beats/predicate-evaluator.js';

function createRichWorldState(): WorldState {
  return createWorldState({
    sessionId: 'test-session',
    capabilities: {
      spatialMode: 'authored_graph',
      combatMode: 'traditional',
      progression: 'rpg_levels',
      clocks: 'full_sim',
      factions: true,
      beats: true,
      relationships: true,
      chronicle: true,
    },
    clocks: {
      turn: 12,
      storyTurn: 7,
      day: 3,
      slot: 'evening',
      timers: {
        ritual_countdown: {
          current: 2,
          max: 5,
          tickOn: 'slot',
        },
      },
    },
    flags: {
      gate_open: true,
      alarm_triggered: false,
    },
    counters: {
      suspicion: 4,
      relics_found: 2,
    },
    customFields: {
      weather: 'stormy',
      'flat.dotted': 42,
      tension: {
        tier: 3,
        tags: ['critical', 'urgent'],
      },
    },
    player: {
      id: 'player',
      name: 'Kael',
      characterId: null,
      locationId: 'central-plaza',
      customFields: {
        reputation: 15,
        perks: ['night_vision', 'silver_tongue'],
      },
    },
    scene: {
      location: 'Central Plaza',
      locationId: 'central-plaza',
    },
    locations: {
      'central-plaza': {
        id: 'central-plaza',
        name: 'Central Plaza',
        kind: 'district',
        status: 'normal',
        controllingFactionId: null,
        connectedLocations: ['harbor-district'],
        discovered: true,
        tags: ['public', 'outdoor'],
        notes: '',
      },
      'harbor-district': {
        id: 'harbor-district',
        name: 'Harbor District',
        kind: 'district',
        status: 'contested',
        controllingFactionId: 'syndicate',
        connectedLocations: ['central-plaza'],
        discovered: true,
        tags: ['docks', 'smuggling'],
        notes: '',
      },
    },
    characters: {
      aria: {
        id: 'aria',
        name: 'Aria',
        status: 'active',
        presentInScene: true,
        locationId: 'central-plaza',
        formId: 'shadow_wolf',
        formGroup: 'lycan',
        sections: {},
        customFields: {
          trustLevel: 8,
        },
        progression: {
          level: 6,
          xp: 1200,
        },
        resources: {
          hp: { current: 18, max: 24 },
        },
        abilities: ['shadow_step'],
        goals: ['protect_archive'],
        agenda: 'guard',
        allegiance: 'vanguard',
        mood: 'focused',
        traits: ['loyal', 'stealthy'],
      },
      vance: {
        id: 'vance',
        name: 'Vance',
        status: 'captured',
        presentInScene: false,
        locationId: 'harbor-district',
        formId: null,
        formGroup: null,
        sections: {},
        customFields: {},
        progression: {
          level: 3,
          xp: 300,
        },
        abilities: [],
        goals: ['escape'],
        agenda: 'survive',
        allegiance: 'syndicate',
        mood: 'anxious',
        traits: ['cunning'],
      },
    },
    factions: {
      vanguard: {
        id: 'vanguard',
        name: 'Vanguard',
        side: 'hero',
        status: 'active',
        influence: 65,
        headquartersLocationId: 'central-plaza',
        goals: ['keep_order'],
      },
      syndicate: {
        id: 'syndicate',
        name: 'Syndicate',
        side: 'villain',
        status: 'underground',
        influence: 40,
        headquartersLocationId: 'harbor-district',
        goals: ['seize_docks'],
      },
    },
    threats: {
      leviathan: {
        id: 'leviathan',
        name: 'Harbor Leviathan',
        rank: 'main',
        status: 'active',
        stage: 2,
        progress: 55,
        locationId: 'harbor-district',
        sourceFactionId: null,
        agenda: 'awaken',
      },
    },
    relations: {
      player: {
        aria: {
          affinity: 75,
          maxAffinity: 100,
          label: 'trusted ally',
          tags: ['ally', 'sworn'],
        },
      },
    },
  });
}

describe('validatePredicateAst', () => {
  it('accepts all valid predicate AST variants including nested combinators', () => {
    const validCases: readonly unknown[] = [
      { flag: 'gate_open' },
      { flag: 'alarm_triggered', value: false },
      { counter: 'suspicion', op: '>=', value: 4 },
      { custom_field: 'weather', op: '==', value: 'stormy' },
      { custom_field: 'reputation', target: 'player', op: '>', value: 10 },
      { clock: 'day', op: '>=', value: 3 },
      { clock: 'story_turn', op: '==', value: 7 },
      { clock: 'turn', op: '<=', value: 12 },
      { slot: 'evening' },
      { at: 'central-plaza' },
      { relation: ['player', 'aria'], field: 'affinity', op: '>=', value: 50 },
      { relation: ['player', 'aria'], field: 'label', op: 'contains', value: 'ally' },
      { relation: ['player', 'aria'], field: 'tag', op: 'contains', value: 'sworn' },
      { entity: ['characters', 'aria', 'progression.level'], op: '>=', value: 5 },
      { any_entity: 'characters', where: { status: 'captured', 'progression.level': { op: '>=', value: 2 } } },
      { count_entities: 'factions', where: { status: 'active' }, op: '==', value: 1 },
      { beat: 'intro', status: 'resolved' },
      { beat: 'act1', status: ['eligible', 'live'] },
      { form_active: { character: 'aria', form: 'shadow_wolf' } },
      { character: 'aria', form: 'shadow_wolf' },
      { mentions: ['iron key', 'vault'], window: 3 },
      { all: [{ flag: 'gate_open' }, { not: { flag: 'alarm_triggered' } }] },
      { any: [{ slot: 'evening' }, { slot: 'night' }] },
      { not: { at: 'harbor-district' } },
    ];

    for (const candidate of validCases) {
      const res = validatePredicateAst(candidate);
      expect(isOk(res)).toBe(true);
    }
  });

  it('rejects unknown keys, invalid operators, non-array combinators, empty mentions, and invalid beat statuses', () => {
    const invalidCases: ReadonlyArray<{ input: unknown; expectedCode: string }> = [
      { input: null, expectedCode: 'INVALID_PREDICATE_AST' },
      { input: ['flag'], expectedCode: 'INVALID_PREDICATE_AST' },
      { input: { unknownKey: 123 }, expectedCode: 'UNKNOWN_PREDICATE_TYPE' },
      { input: { flag: 'gate_open', extra: true }, expectedCode: 'INVALID_PREDICATE_KEYS' },
      { input: { flag: 'gate_open', counter: 'x', op: '==', value: 1 }, expectedCode: 'AMBIGUOUS_PREDICATE_TYPE' },
      { input: { counter: 'x', op: '===', value: 1 }, expectedCode: 'INVALID_COMPARISON_OP' },
      { input: { counter: 'x', op: '>=', value: Number.NaN }, expectedCode: 'INVALID_COUNTER_VALUE' },
      { input: { clock: 'day', op: '>', value: Number.POSITIVE_INFINITY }, expectedCode: 'INVALID_CLOCK_VALUE' },
      { input: { all: { flag: 'a' } }, expectedCode: 'INVALID_ALL_COMBINATOR' },
      { input: { any: 'not-array' }, expectedCode: 'INVALID_ANY_COMBINATOR' },
      { input: { mentions: [] }, expectedCode: 'EMPTY_MENTIONS_ARRAY' },
      { input: { mentions: ['   '] }, expectedCode: 'INVALID_MENTION_PHRASE' },
      { input: { mentions: ['key'], window: 0 }, expectedCode: 'INVALID_WINDOW_SIZE' },
      { input: { beat: 'b1', status: 'bogus_status' }, expectedCode: 'INVALID_BEAT_STATUS' },
      { input: { beat: 'b1', status: [] }, expectedCode: 'EMPTY_BEAT_STATUS_ARRAY' },
      { input: { entity: ['items', 'sword', 'dmg'], op: '>', value: 1 }, expectedCode: 'INVALID_ENTITY_COLLECTION' },
      { input: { relation: ['a'], field: 'affinity', op: '>', value: 0 }, expectedCode: 'INVALID_RELATION_PAIR' },
      { input: { relation: ['a', 'b'], field: 'trust', op: '>', value: 0 }, expectedCode: 'INVALID_RELATION_FIELD' },
      { input: { character: 'aria', form: 'wolf', extra: 1 }, expectedCode: 'INVALID_PREDICATE_KEYS' },
    ];

    for (const testCase of invalidCases) {
      const res = validatePredicateAst(testCase.input);
      expect(isErr(res)).toBe(true);
      if (isErr(res)) {
        expect(res.error.some((e) => e.code === testCase.expectedCode)).toBe(true);
      }
    }
  });

  it('rejects prototype pollution keys in AST nodes, dot-paths, and where clauses', () => {
    const protoPayload = JSON.parse('{"flag":"a","__proto__":{"polluted":true}}') as unknown;
    const res1 = validatePredicateAst(protoPayload);
    expect(isErr(res1)).toBe(true);
    if (isErr(res1)) {
      expect(res1.error.some((e) => e.code === 'UNSAFE_PROPERTY_KEY')).toBe(true);
    }

    const res2 = validatePredicateAst({
      entity: ['characters', 'aria', 'constructor.prototype'],
      op: '!=',
      value: null,
    });
    expect(isErr(res2)).toBe(true);

    const whereProto = JSON.parse('{"any_entity":"characters","where":{"__proto__":"x"}}') as unknown;
    const res3 = validatePredicateAst(whereProto);
    expect(isErr(res3)).toBe(true);
  });

  it('reports scoped paths for nested combinator validation errors', () => {
    const res = validatePredicateAst({
      all: [
        { flag: 'ok' },
        { not: { mentions: [] } },
      ],
    });
    expect(isErr(res)).toBe(true);
    if (isErr(res)) {
      expect(res.error[0]?.path).toBe('all[1].not.mentions');
    }
  });
});

describe('evaluatePredicate', () => {
  it('evaluates flag predicates and defaults missing flags to false with BR-8 warning', () => {
    const state = createRichWorldState();
    const warnings: ValidationError[] = [];
    const ctx: PredicateEvalContext = { state, beatStatuses: new Map(), warnings };

    expect(evaluatePredicate({ flag: 'gate_open' }, ctx)).toBe(true);
    expect(evaluatePredicate({ flag: 'alarm_triggered', value: false }, ctx)).toBe(true);
    expect(evaluatePredicate({ flag: 'alarm_triggered', value: true }, ctx)).toBe(false);
    expect(warnings).toHaveLength(0);

    expect(evaluatePredicate({ flag: 'nonexistent_flag' }, ctx)).toBe(false);
    expect(evaluatePredicate({ flag: 'nonexistent_flag', value: false }, ctx)).toBe(true);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]?.path).toBe('flags.nonexistent_flag');
    expect(warnings[0]?.code).toBe('MISSING_KEY_DEFAULTED');
  });

  it('evaluates counter predicates and defaults missing counters to 0 with BR-8 warning', () => {
    const state = createRichWorldState();
    const warnings: ValidationError[] = [];
    const ctx: PredicateEvalContext = { state, beatStatuses: {}, warnings };

    expect(evaluatePredicate({ counter: 'suspicion', op: '==', value: 4 }, ctx)).toBe(true);
    expect(evaluatePredicate({ counter: 'suspicion', op: '!=', value: 3 }, ctx)).toBe(true);
    expect(evaluatePredicate({ counter: 'suspicion', op: '>=', value: 4 }, ctx)).toBe(true);
    expect(evaluatePredicate({ counter: 'suspicion', op: '>', value: 4 }, ctx)).toBe(false);
    expect(evaluatePredicate({ counter: 'suspicion', op: '<=', value: 4 }, ctx)).toBe(true);
    expect(evaluatePredicate({ counter: 'suspicion', op: '<', value: 5 }, ctx)).toBe(true);
    expect(warnings).toHaveLength(0);

    expect(evaluatePredicate({ counter: 'missing_counter', op: '==', value: 0 }, ctx)).toBe(true);
    expect(evaluatePredicate({ counter: 'missing_counter', op: '>', value: 0 }, ctx)).toBe(false);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]?.path).toBe('counters.missing_counter');
  });

  it('evaluates custom_field across global, player, and character targets with safe missing defaults', () => {
    const state = createRichWorldState();
    const warnings: ValidationError[] = [];
    const ctx: PredicateEvalContext = { state, beatStatuses: {}, warnings };

    expect(evaluatePredicate({ custom_field: 'weather', op: '==', value: 'stormy' }, ctx)).toBe(true);
    expect(evaluatePredicate({ custom_field: 'flat.dotted', op: '==', value: 42 }, ctx)).toBe(true);
    expect(evaluatePredicate({ custom_field: 'tension.tier', target: 'global', op: '>=', value: 3 }, ctx)).toBe(true);
    expect(evaluatePredicate({ custom_field: 'tension.tags', op: 'contains', value: 'critical' }, ctx)).toBe(true);
    expect(evaluatePredicate({ custom_field: 'reputation', target: 'player', op: 'in', value: [10, 15, 20] }, ctx)).toBe(true);
    expect(evaluatePredicate({ custom_field: 'perks', target: 'player', op: 'contains', value: 'night_vision' }, ctx)).toBe(true);
    expect(evaluatePredicate({ custom_field: 'trustLevel', target: 'aria', op: '>=', value: 8 }, ctx)).toBe(true);
    expect(warnings).toHaveLength(0);

    expect(evaluatePredicate({ custom_field: 'missing_key', op: '==', value: null }, ctx)).toBe(true);
    expect(evaluatePredicate({ custom_field: 'trustLevel', target: 'unknown_npc', op: '>', value: 0 }, ctx)).toBe(false);
    expect(warnings).toHaveLength(2);
  });

  it('evaluates clock and slot predicates including story_turn and custom timers', () => {
    const state = createRichWorldState();
    const warnings: ValidationError[] = [];
    const ctx: PredicateEvalContext = { state, beatStatuses: {}, warnings };

    expect(evaluatePredicate({ clock: 'day', op: '==', value: 3 }, ctx)).toBe(true);
    expect(evaluatePredicate({ clock: 'turn', op: '>=', value: 12 }, ctx)).toBe(true);
    expect(evaluatePredicate({ clock: 'story_turn', op: '==', value: 7 }, ctx)).toBe(true);
    expect(evaluatePredicate({ clock: 'storyTurn', op: '<', value: 10 }, ctx)).toBe(true);
    expect(evaluatePredicate({ clock: 'ritual_countdown', op: '<=', value: 2 }, ctx)).toBe(true);
    expect(evaluatePredicate({ slot: 'evening' }, ctx)).toBe(true);
    expect(evaluatePredicate({ slot: ' Evening ' }, ctx)).toBe(true);
    expect(evaluatePredicate({ slot: 'morning' }, ctx)).toBe(false);
    expect(warnings).toHaveLength(0);

    expect(evaluatePredicate({ clock: 'missing_timer', op: '==', value: 0 }, ctx)).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.path).toBe('clocks.timers.missing_timer');
  });

  it('evaluates at matcher across Tier 0 (scene_only), Tier 1 (emergent), and Tier 2 (authored_graph)', () => {
    const tier0State = createWorldState({
      capabilities: {
        spatialMode: 'scene_only',
        combatMode: 'disabled',
        progression: 'disabled',
        clocks: 'disabled',
        factions: false,
        beats: false,
        relationships: false,
        chronicle: false,
      },
      scene: {
        location: 'The Rusty Tavern',
        locationId: null,
      },
    });
    const tier0Ctx: PredicateEvalContext = { state: tier0State, beatStatuses: {} };

    expect(evaluatePredicate({ at: 'tavern' }, tier0Ctx)).toBe(true);
    expect(evaluatePredicate({ at: 'Rusty Tavern' }, tier0Ctx)).toBe(true);
    expect(evaluatePredicate({ at: 'tavern cellar' }, tier0Ctx)).toBe(false);

    const tier1State = createWorldState({
      capabilities: {
        spatialMode: 'emergent',
        combatMode: 'disabled',
        progression: 'disabled',
        clocks: 'disabled',
        factions: false,
        beats: false,
        relationships: false,
        chronicle: false,
      },
      scene: {
        location: 'Neon Alley',
        locationId: 'neon-alley',
      },
      locations: {
        'neon-alley': {
          id: 'neon-alley',
          name: 'Neon Alley',
          kind: 'emergent',
          status: 'normal',
          controllingFactionId: null,
          connectedLocations: [],
          discovered: true,
          tags: ['backstreet', 'rainy'],
          notes: '',
        },
      },
    });
    const tier1Ctx: PredicateEvalContext = { state: tier1State, beatStatuses: {} };
    expect(evaluatePredicate({ at: 'neon-alley' }, tier1Ctx)).toBe(true);
    expect(evaluatePredicate({ at: 'rainy' }, tier1Ctx)).toBe(true);
    expect(evaluatePredicate({ at: 'central-plaza' }, tier1Ctx)).toBe(false);

    const tier2State = createRichWorldState();
    const tier2Ctx: PredicateEvalContext = { state: tier2State, beatStatuses: {} };

    expect(evaluatePredicate({ at: 'central-plaza' }, tier2Ctx)).toBe(true);
    expect(evaluatePredicate({ at: 'outdoor' }, tier2Ctx)).toBe(true);
    expect(evaluatePredicate({ at: 'harbor-district' }, tier2Ctx)).toBe(false);
    expect(evaluatePredicate({ at: 'docks' }, tier2Ctx)).toBe(false);
  });

  it('evaluates relation predicates and defaults missing relations safely', () => {
    const state = createRichWorldState();
    const warnings: ValidationError[] = [];
    const ctx: PredicateEvalContext = { state, beatStatuses: {}, warnings };

    expect(evaluatePredicate({ relation: ['player', 'aria'], field: 'affinity', op: '>=', value: 75 }, ctx)).toBe(true);
    expect(evaluatePredicate({ relation: ['player', 'aria'], field: 'label', op: 'contains', value: 'trusted' }, ctx)).toBe(true);
    expect(evaluatePredicate({ relation: ['player', 'aria'], field: 'tag', op: 'contains', value: 'sworn' }, ctx)).toBe(true);
    expect(evaluatePredicate({ relation: ['player', 'aria'], field: 'tag', op: '==', value: 'ally' }, ctx)).toBe(true);
    expect(evaluatePredicate({ relation: ['player', 'aria'], field: 'tag', op: 'in', value: ['rival', 'ally'] }, ctx)).toBe(true);
    expect(warnings).toHaveLength(0);

    expect(evaluatePredicate({ relation: ['player', 'vance'], field: 'affinity', op: '<', value: 10 }, ctx)).toBe(true);
    expect(evaluatePredicate({ relation: ['player', 'vance'], field: 'tag', op: 'contains', value: 'ally' }, ctx)).toBe(false);
    expect(warnings).toHaveLength(2);
  });

  it('evaluates entity, any_entity, and count_entities across collections with missing-field resilience', () => {
    const state = createRichWorldState();
    const warnings: ValidationError[] = [];
    const ctx: PredicateEvalContext = { state, beatStatuses: {}, warnings };

    expect(evaluatePredicate({ entity: ['characters', 'aria', 'progression.level'], op: '>=', value: 6 }, ctx)).toBe(true);
    expect(evaluatePredicate({ entity: ['characters', 'aria', 'resources.hp.current'], op: '==', value: 18 }, ctx)).toBe(true);
    expect(evaluatePredicate({ entity: ['characters', 'aria', 'traits'], op: 'contains', value: 'stealthy' }, ctx)).toBe(true);
    expect(evaluatePredicate({ entity: ['factions', 'vanguard', 'influence'], op: '>', value: 50 }, ctx)).toBe(true);
    expect(evaluatePredicate({ entity: ['threats', 'leviathan', 'stage'], op: '==', value: 2 }, ctx)).toBe(true);
    expect(evaluatePredicate({ entity: ['locations', 'central-plaza', 'controllingFactionId'], op: '==', value: null }, ctx)).toBe(true);
    expect(warnings).toHaveLength(0);

    // Missing entity or missing nested field defaults to null and emits BR-8 warning
    expect(evaluatePredicate({ entity: ['characters', 'ghost', 'progression.level'], op: '>', value: 0 }, ctx)).toBe(false);
    expect(evaluatePredicate({ entity: ['characters', 'vance', 'resources.hp.current'], op: '==', value: null }, ctx)).toBe(true);
    expect(warnings).toHaveLength(2);

    expect(
      evaluatePredicate(
        {
          any_entity: 'characters',
          where: { status: 'captured', 'progression.level': { op: '>=', value: 3 } },
        },
        ctx
      )
    ).toBe(true);

    expect(
      evaluatePredicate(
        {
          any_entity: 'characters',
          where: { traits: 'stealthy', allegiance: 'syndicate' },
        },
        ctx
      )
    ).toBe(false);

    expect(
      evaluatePredicate(
        {
          any_entity: 'characters',
          where: { progression: { level: { op: '>=', value: 6 } }, traits: 'stealthy' },
        },
        ctx
      )
    ).toBe(true);

    expect(
      evaluatePredicate(
        {
          any_entity: 'characters',
          where: { 'corruption.stage': { op: '>=', value: 1 } },
        },
        ctx
      )
    ).toBe(false);

    expect(
      evaluatePredicate(
        {
          count_entities: 'characters',
          where: { status: { op: 'in', value: ['active', 'captured'] } },
          op: '==',
          value: 2,
        },
        ctx
      )
    ).toBe(true);

    expect(
      evaluatePredicate(
        {
          count_entities: 'locations',
          where: {},
          op: '==',
          value: 2,
        },
        ctx
      )
    ).toBe(true);
  });

  it('evaluates beat status across Map and Record and supports form_active nested & flat shapes', () => {
    const state = createRichWorldState();
    const warnings: ValidationError[] = [];
    const statusMap = new Map<string, BeatStatus>([
      ['beat-1', 'resolved'],
      ['beat-2', 'live'],
    ]);
    const mapCtx: PredicateEvalContext = { state, beatStatuses: statusMap, warnings };

    expect(evaluatePredicate({ beat: 'beat-1', status: 'resolved' }, mapCtx)).toBe(true);
    expect(evaluatePredicate({ beat: 'beat-2', status: ['eligible', 'live'] }, mapCtx)).toBe(true);
    expect(evaluatePredicate({ beat: 'beat-2', status: 'closed' }, mapCtx)).toBe(false);
    expect(evaluatePredicate({ beat: 'missing-beat', status: 'dormant' }, mapCtx)).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.path).toBe('beats.missing-beat.status');

    const recordCtx: PredicateEvalContext = {
      state,
      beatStatuses: { 'beat-1': 'adapted' },
    };
    expect(evaluatePredicate({ beat: 'beat-1', status: ['resolved', 'adapted'] }, recordCtx)).toBe(true);

    expect(evaluatePredicate({ form_active: { character: 'aria', form: 'shadow_wolf' } }, mapCtx)).toBe(true);
    expect(evaluatePredicate({ character: 'aria', form: 'shadow_wolf' }, mapCtx)).toBe(true);
    expect(evaluatePredicate({ form_active: { character: 'aria', form: 'human' } }, mapCtx)).toBe(false);
    expect(evaluatePredicate({ form_active: { character: 'missing', form: 'human' } }, mapCtx)).toBe(false);
  });

  it('evaluates mentions with default window=2, custom window, and word-boundary phrase matching', () => {
    const state = createRichWorldState();
    const lines = [
      'Line 1: We spotted the obsidian vault earlier.',
      'Line 2: An ironic keynote played over the intercom.',
      'Line 3: Aria retrieved the Iron   Key from the pedestal.',
    ];

    const ctx: PredicateEvalContext = {
      state,
      beatStatuses: {},
      recentTranscriptLines: lines,
    };

    // Default window = 2 (lines 2 and 3)
    expect(evaluatePredicate({ mentions: ['iron key'] }, ctx)).toBe(true);
    expect(evaluatePredicate({ mentions: ['key'] }, ctx)).toBe(true);
    // Line 1 is outside default window=2
    expect(evaluatePredicate({ mentions: ['obsidian vault'] }, ctx)).toBe(false);
    // Window=3 includes line 1
    expect(evaluatePredicate({ mentions: ['obsidian vault'], window: 3 }, ctx)).toBe(true);
    // Boundary check: 'key' must NOT match 'keynote' on line 2 alone, 'iron' must NOT match 'ironic'
    const onlyLine2Ctx: PredicateEvalContext = {
      state,
      beatStatuses: {},
      recentTranscriptLines: ['An ironic keynote played over the intercom.'],
    };
    expect(evaluatePredicate({ mentions: ['iron', 'key', 'iron key'] }, onlyLine2Ctx)).toBe(false);

    // Special regex characters and Unicode word boundaries
    const specialCtx: PredicateEvalContext = {
      state,
      beatStatuses: {},
      recentTranscriptLines: [
        'We met at the Café before checking Project [Alpha].',
        'She wrote C++ bindings for the scanner.',
      ],
    };
    expect(evaluatePredicate({ mentions: ['café'], window: 2 }, specialCtx)).toBe(true);
    expect(evaluatePredicate({ mentions: ['Project [Alpha]'], window: 2 }, specialCtx)).toBe(true);
    expect(evaluatePredicate({ mentions: ['C++'], window: 1 }, specialCtx)).toBe(true);
    expect(evaluatePredicate({ mentions: ['café'], window: 1 }, specialCtx)).toBe(false);

    // Empty / missing transcript
    expect(evaluatePredicate({ mentions: ['key'] }, { state, beatStatuses: {} })).toBe(false);
  });

  it('evaluates all, any, not combinators cleanly and never mutates input state or AST', () => {
    const state = createRichWorldState();
    const snapshotBefore = JSON.stringify(state);
    const ast: PredicateAst = {
      all: [
        { flag: 'gate_open' },
        {
          any: [
            { counter: 'suspicion', op: '>=', value: 10 },
            { not: { flag: 'alarm_triggered' } },
          ],
        },
      ],
    };
    const astBefore = JSON.stringify(ast);

    const ctx: PredicateEvalContext = { state, beatStatuses: {} };
    expect(evaluatePredicate(ast, ctx)).toBe(true);
    expect(evaluatePredicate({ all: [] }, ctx)).toBe(true);
    expect(evaluatePredicate({ any: [] }, ctx)).toBe(false);
    expect(JSON.stringify(state)).toBe(snapshotBefore);
    expect(JSON.stringify(ast)).toBe(astBefore);
  });

  it('guards against prototype property lookups even on unvalidated crafted ASTs', () => {
    const state = createRichWorldState();
    const warnings: ValidationError[] = [];
    const ctx: PredicateEvalContext = { state, beatStatuses: {}, warnings };

    const craftedFlag = { flag: 'constructor' } as PredicateAst;
    expect(evaluatePredicate(craftedFlag, ctx)).toBe(false);

    const craftedEntity = {
      entity: ['characters', 'toString', 'constructor'],
      op: '!=',
      value: null,
    } as PredicateAst;
    expect(evaluatePredicate(craftedEntity, ctx)).toBe(false);

    const craftedCustom = {
      custom_field: '__proto__.polluted',
      op: '!=',
      value: null,
    } as PredicateAst;
    expect(evaluatePredicate(craftedCustom, ctx)).toBe(false);
    expect(warnings.length).toBeGreaterThanOrEqual(3);
  });
});
