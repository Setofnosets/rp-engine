import { describe, expect, it } from 'vitest';
import { createWorldState } from '../../src/state/world-state.js';
import { type BeatStatus, type PredicateAst } from '../../src/beats/predicate-ast.js';
import {
  type DependencyEntry,
  buildDependencyIndex,
  compilePredicateDependencies,
  findDirtyIds,
} from '../../src/beats/dependency-compiler.js';
import {
  type PredicateEvalContext,
  evaluatePredicate,
} from '../../src/beats/predicate-evaluator.js';

describe('compilePredicateDependencies', () => {
  it('produces canonical dependency paths for every predicate variant', () => {
    expect([...compilePredicateDependencies({ flag: 'gate_open' })]).toEqual(['flags.gate_open']);
    expect([...compilePredicateDependencies({ counter: 'suspicion', op: '>=', value: 3 })]).toEqual([
      'counters.suspicion',
    ]);
    expect([
      ...compilePredicateDependencies({ custom_field: 'weather', op: '==', value: 'stormy' }),
    ]).toEqual(['customFields.weather']);
    expect([
      ...compilePredicateDependencies({
        custom_field: 'sanity',
        target: 'player',
        op: '<',
        value: 50,
      }),
    ]).toEqual(['player.customFields.sanity']);
    expect([
      ...compilePredicateDependencies({
        custom_field: 'trust',
        target: 'aria',
        op: '>=',
        value: 5,
      }),
    ]).toEqual(['entities.characters.aria.customFields.trust']);
    expect([...compilePredicateDependencies({ clock: 'day', op: '>=', value: 2 })]).toEqual([
      'clocks.day',
    ]);
    expect([...compilePredicateDependencies({ clock: 'story_turn', op: '>=', value: 5 })]).toEqual([
      'clocks.storyTurn',
    ]);
    expect([...compilePredicateDependencies({ clock: 'turn', op: '>=', value: 10 })]).toEqual([
      'clocks.turn',
    ]);
    expect([...compilePredicateDependencies({ clock: 'ritual', op: '==', value: 0 })]).toEqual([
      'clocks.timers.ritual',
    ]);
    expect([...compilePredicateDependencies({ slot: 'night' })]).toEqual(['clocks.slot']);
    expect(compilePredicateDependencies({ at: 'central-plaza' })).toEqual(
      new Set(['scene.location', 'scene.locationId'])
    );
    expect([
      ...compilePredicateDependencies({
        relation: ['player', 'aria'],
        field: 'affinity',
        op: '>=',
        value: 50,
      }),
    ]).toEqual(['relations.player.aria']);
    expect([
      ...compilePredicateDependencies({
        entity: ['characters', 'aria', 'progression.level'],
        op: '>=',
        value: 5,
      }),
    ]).toEqual(['entities.characters.aria.progression.level']);
    expect(
      compilePredicateDependencies({
        any_entity: 'characters',
        where: { status: 'captured', 'progression.level': { op: '>=', value: 4 } },
      })
    ).toEqual(new Set(['entities.characters.*.status', 'entities.characters.*.progression.level']));
    expect(
      compilePredicateDependencies({
        count_entities: 'factions',
        where: { status: 'active' },
        op: '>=',
        value: 2,
      })
    ).toEqual(new Set(['entities.factions.*.status']));
    expect([
      ...compilePredicateDependencies({
        count_entities: 'locations',
        where: {},
        op: '>',
        value: 0,
      }),
    ]).toEqual(['entities.locations.*']);
    expect([...compilePredicateDependencies({ beat: 'intro', status: 'resolved' })]).toEqual([
      'beats.intro.status',
    ]);
    expect([
      ...compilePredicateDependencies({ form_active: { character: 'aria', form: 'wolf' } }),
    ]).toEqual(['entities.characters.aria.formId']);
    expect([
      ...compilePredicateDependencies({ character: 'aria', form: 'wolf' }),
    ]).toEqual(['entities.characters.aria.formId']);
    expect([...compilePredicateDependencies({ mentions: ['iron key'] })]).toEqual([
      'transcript.mentions',
    ]);
  });

  it('deduplicates and combines dependencies across all, any, and not combinators', () => {
    const ast: PredicateAst = {
      all: [
        { flag: 'gate_open' },
        {
          any: [
            { flag: 'gate_open', value: false },
            { not: { at: 'docks' } },
          ],
        },
      ],
    };

    expect(compilePredicateDependencies(ast)).toEqual(
      new Set(['flags.gate_open', 'scene.location', 'scene.locationId'])
    );
  });
});

describe('DependencyIndex and findDirtyIds', () => {
  it('resolves exact matches, parent/child paths, and wildcard entities.<coll>.*.<field> matches without false positives', () => {
    const index = buildDependencyIndex([
      { id: 'b-flag', predicates: [{ flag: 'gate_open' }] },
      { id: 'b-entity-exact', predicates: [{ entity: ['characters', 'aria', 'mood'], op: '==', value: 'happy' }] },
      { id: 'b-entity-nested', predicates: [{ entity: ['characters', 'aria', 'progression.level'], op: '>=', value: 5 }] },
      { id: 'b-any-status', predicates: [{ any_entity: 'characters', where: { status: 'captured' } }] },
      { id: 'b-count-mood', predicates: [{ count_entities: 'characters', where: { mood: 'angry' }, op: '>=', value: 1 }] },
      { id: 'b-rel', predicates: [{ relation: ['player', 'aria'], field: 'affinity', op: '>=', value: 50 }] },
      { id: 'b-clock', predicates: [{ clock: 'story_turn', op: '>=', value: 3 }] },
      { id: 'b-mentions', predicates: [{ mentions: ['vault'] }] },
    ]);

    // Specific entity field change triggers exact + matching wildcard, NOT unrelated field wildcards
    const dirty1 = findDirtyIds(index, new Set(['entities.characters.npc_99.status']));
    expect(dirty1).toEqual(new Set(['b-any-status']));

    // Changing aria.mood triggers b-entity-exact + b-count-mood, NOT b-any-status or b-entity-nested
    const dirty2 = findDirtyIds(index, new Set(['entities.characters.aria.mood']));
    expect(dirty2).toEqual(new Set(['b-entity-exact', 'b-count-mood']));

    // Parent replacement of aria.progression triggers b-entity-nested
    const dirty3 = findDirtyIds(index, new Set(['entities.characters.aria.progression']));
    expect(dirty3).toEqual(new Set(['b-entity-nested']));

    // Whole entity addition/replacement triggers all deps for aria + all character wildcards
    const dirty4 = findDirtyIds(index, new Set(['entities.characters.aria']));
    expect(dirty4).toEqual(new Set(['b-entity-exact', 'b-entity-nested', 'b-any-status', 'b-count-mood']));

    // Child mutation under relation triggers relations.<from>.<to>
    const dirty5 = findDirtyIds(index, new Set(['relations.player.aria.affinity']));
    expect(dirty5).toEqual(new Set(['b-rel']));

    // Clock story_turn alias maps to clocks.storyTurn
    const dirty6 = findDirtyIds(index, new Set(['clocks.story_turn']));
    expect(dirty6).toEqual(new Set(['b-clock']));

    // Unrelated change returns empty set
    const dirtyNone = findDirtyIds(index, new Set(['flags.unrelated_flag']));
    expect(dirtyNone.size).toBe(0);
  });

  it('benchmarks 500 mixed predicates: findDirtyIds + evaluating affected beats for 3 mutated paths completes in < 5 ms', () => {
    const entries: DependencyEntry[] = [];
    const astById = new Map<string, PredicateAst>();

    for (let i = 0; i < 500; i += 1) {
      const id = `beat-${String(i).padStart(3, '0')}`;
      let ast: PredicateAst;
      const variant = i % 10;
      switch (variant) {
        case 0:
          ast = { flag: `flag_${i % 40}` };
          break;
        case 1:
          ast = { counter: `counter_${i % 40}`, op: '>=', value: (i % 5) + 1 };
          break;
        case 2:
          ast = { custom_field: `field_${i % 30}`, op: '==', value: 'active' };
          break;
        case 3:
          ast = { clock: i % 2 === 0 ? 'day' : 'story_turn', op: '>=', value: (i % 10) + 1 };
          break;
        case 4:
          ast = { slot: i % 2 === 0 ? 'evening' : 'morning' };
          break;
        case 5:
          ast = { at: i % 3 === 0 ? 'central-plaza' : `district-${i % 20}` };
          break;
        case 6:
          ast = {
            relation: ['player', `npc_${i % 25}`],
            field: 'affinity',
            op: '>=',
            value: 30,
          };
          break;
        case 7:
          ast = {
            entity: ['characters', `npc_${i % 30}`, 'status'],
            op: '==',
            value: 'active',
          };
          break;
        case 8:
          ast =
            i % 20 === 8
              ? { any_entity: 'characters', where: { status: 'captured' } }
              : { count_entities: 'factions', where: { status: 'active' }, op: '>=', value: 1 };
          break;
        default:
          ast = {
            all: [
              { beat: `beat-${String(i % 25).padStart(3, '0')}`, status: 'resolved' },
              { mentions: [`keyword_${i % 15}`], window: 2 },
            ],
          };
          break;
      }
      entries.push({ id, predicates: [ast] });
      astById.set(id, ast);
    }

    const index = buildDependencyIndex(entries);

    const characters: Record<string, ReturnType<typeof createWorldState>['entities']['characters'][string]> = {};
    for (let i = 0; i < 30; i += 1) {
      const charId = `npc_${i}`;
      characters[charId] = {
        id: charId,
        name: `NPC ${i}`,
        status: i === 12 ? 'captured' : 'active',
        presentInScene: i < 5,
        locationId: 'central-plaza',
        formId: null,
        formGroup: null,
        sections: {},
        customFields: {},
        abilities: [],
        goals: [],
        agenda: '',
        allegiance: 'neutral',
        mood: 'neutral',
        traits: [],
      };
    }

    const state = createWorldState({
      capabilities: {
        spatialMode: 'authored_graph',
        combatMode: 'disabled',
        progression: 'disabled',
        clocks: 'full_sim',
        factions: true,
        beats: true,
        relationships: true,
        chronicle: false,
      },
      flags: {
        flag_0: true,
        flag_10: true,
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
          connectedLocations: [],
          discovered: true,
          tags: ['hub'],
          notes: '',
        },
      },
      characters,
    });

    const beatStatuses = new Map<string, BeatStatus>();
    for (let i = 0; i < 25; i += 1) {
      beatStatuses.set(`beat-${String(i).padStart(3, '0')}`, 'resolved');
    }

    const ctx: PredicateEvalContext = {
      state,
      beatStatuses,
      recentTranscriptLines: ['We heard rumors near the central-plaza.'],
    };

    const changedPaths = new Set([
      'flags.flag_0',
      'entities.characters.npc_12.status',
      'scene.locationId',
    ]);

    // Warm up JIT once before measuring so cold module init doesn't skew steady-state turn cost.
    findDirtyIds(index, changedPaths);

    const startMs = performance.now();
    const dirtyIds = findDirtyIds(index, changedPaths);
    const evalResults = new Map<string, boolean>();
    for (const id of dirtyIds) {
      const ast = astById.get(id);
      if (ast) {
        evalResults.set(id, evaluatePredicate(ast, ctx));
      }
    }
    const elapsedMs = performance.now() - startMs;

    expect(dirtyIds.size).toBeGreaterThan(0);
    expect(dirtyIds.size).toBeLessThan(150);
    expect(evalResults.get('beat-000')).toBe(true);
    expect(evalResults.get('beat-008')).toBe(true);
    expect(elapsedMs).toBeLessThan(5);
    console.info(
      `[PR-2.1 benchmark] 500 predicates indexed, dirtyIds=${dirtyIds.size}, elapsed=${elapsedMs.toFixed(3)} ms`
    );
  });
});
