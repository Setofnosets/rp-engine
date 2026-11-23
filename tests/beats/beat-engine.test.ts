import { describe, expect, it } from 'vitest';
import {
  type BeatDefinition,
  TERMINAL_BEAT_STATUSES,
  canTransitionBeat,
  createInitialBeatLedger,
  isTerminalBeatStatus,
  validateBeatDefinitions,
} from '../../src/beats/beat-ledger.js';
import {
  buildBeatDependencyIndex,
  evaluateBeatGraph,
  forceBeatTransition,
  scalePredicateForBeatPressure,
} from '../../src/beats/beat-engine.js';
import { isErr, isOk } from '../../src/core/result.js';
import { type WorldState, createWorldState } from '../../src/state/world-state.js';

function createEngineTestState(overrides?: {
  beatsEnabled?: boolean;
  day?: number;
  turn?: number;
  flags?: Record<string, boolean>;
  counters?: Record<string, number>;
  ariaStatus?: 'active' | 'dead';
}): WorldState {
  return createWorldState({
    sessionId: 'beat-engine-test',
    turn: overrides?.turn ?? 1,
    capabilities: {
      spatialMode: 'authored_graph',
      combatMode: 'disabled',
      progression: 'rpg_levels',
      clocks: 'full_sim',
      factions: true,
      beats: overrides?.beatsEnabled ?? true,
      relationships: true,
      chronicle: true,
    },
    clocks: {
      turn: overrides?.turn ?? 1,
      storyTurn: overrides?.turn ?? 1,
      day: overrides?.day ?? 1,
      slot: 'morning',
    },
    flags: overrides?.flags ?? {},
    counters: overrides?.counters ?? {},
    scene: {
      location: 'Central Plaza',
      locationId: 'central-plaza',
      presentCharacterIds: ['cora'],
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
    characters: {
      aria: {
        id: 'aria',
        name: 'Aria Voss',
        status: overrides?.ariaStatus ?? 'active',
        presentInScene: true,
        locationId: 'central-plaza',
        formId: null,
        formGroup: null,
        sections: {},
        customFields: {},
        abilities: [],
        goals: [],
        agenda: 'guide',
        allegiance: 'vanguard',
        mood: 'focused',
        traits: ['guide'],
      },
      cora: {
        id: 'cora',
        name: 'Cora Vale',
        status: 'active',
        presentInScene: true,
        locationId: 'central-plaza',
        formId: null,
        formGroup: null,
        sections: {},
        customFields: {},
        abilities: [],
        goals: [],
        agenda: 'assist',
        allegiance: 'vanguard',
        mood: 'alert',
        traits: ['guide'],
      },
    },
    threats: {
      blight: {
        id: 'blight',
        name: 'The Blight',
        rank: 'main',
        status: 'active',
        stage: 1,
        progress: 10,
        locationId: null,
        sourceFactionId: null,
        agenda: 'spread',
      },
    },
  });
}

describe('beat-ledger monotonicity & validation', () => {
  it('enforces BR-9 monotonicity for TERMINAL_BEAT_STATUSES', () => {
    expect(TERMINAL_BEAT_STATUSES).toEqual(['resolved', 'adapted', 'short_circuited', 'closed']);

    for (const terminal of TERMINAL_BEAT_STATUSES) {
      expect(isTerminalBeatStatus(terminal)).toBe(true);
      expect(canTransitionBeat(terminal, terminal)).toBe(true);
      for (const target of [
        'dormant',
        'eligible',
        'live',
        'deferred',
        'resolved',
        'adapted',
        'short_circuited',
        'closed',
      ] as const) {
        if (target !== terminal) {
          expect(canTransitionBeat(terminal, target)).toBe(false);
        }
      }
    }

    expect(canTransitionBeat('dormant', 'eligible')).toBe(true);
    expect(canTransitionBeat('eligible', 'live')).toBe(true);
    expect(canTransitionBeat('live', 'dormant')).toBe(true);
    expect(canTransitionBeat('dormant', 'live')).toBe(false);
    expect(canTransitionBeat('deferred', 'eligible')).toBe(true);
  });

  it('never reopens a terminal beat during subsequent evaluateBeatGraph passes', () => {
    const beats: BeatDefinition[] = [
      {
        id: 'gate_once',
        class: 'gate',
        priority: 10,
        when: { flag: 'active' },
        until: { flag: 'done' },
      },
    ];
    let state = createEngineTestState({ flags: { active: true, done: false } });
    let ledger = createInitialBeatLedger(beats);

    const pass1 = evaluateBeatGraph({ state, ledger, beats });
    expect(pass1.nextLedger.records.gate_once?.status).toBe('live');

    state = createEngineTestState({ flags: { active: true, done: true }, turn: 2 });
    const pass2 = evaluateBeatGraph({ state, ledger: pass1.nextLedger, beats });
    expect(pass2.nextLedger.records.gate_once?.status).toBe('resolved');

    // Even if conditions look active again and done becomes false, terminal beat stays resolved
    state = createEngineTestState({ flags: { active: true, done: false }, turn: 3 });
    const pass3 = evaluateBeatGraph({ state, ledger: pass2.nextLedger, beats });
    expect(pass3.nextLedger.records.gate_once?.status).toBe('resolved');
    expect(pass3.transitions).toHaveLength(0);
    expect(pass3.nextLedger.liveGateId).toBeNull();
  });

  it('validates beat definitions with ErrorAccumulator and catches duplicates, self-requires, and unknown refs', () => {
    const validRes = validateBeatDefinitions([
      { id: 'b1', class: 'gate', priority: 10, when: { flag: 'ready' } },
      { id: 'b2', class: 'nudge', priority: 5, requires: ['b1'], when: { flag: 'go' } },
    ]);
    expect(isOk(validRes)).toBe(true);

    const invalidRes = validateBeatDefinitions([
      { id: 'b1', class: 'gate', priority: 10, requires: ['b1'], when: { flag: 'a' } },
      { id: 'b1', class: 'nudge', priority: 5, requires: ['missing_beat'], when: { flag: 'b' } },
    ]);
    expect(isErr(invalidRes)).toBe(true);
    if (isErr(invalidRes)) {
      const codes = invalidRes.error.map((e) => e.code);
      expect(codes).toContain('SELF_DEPENDENCY');
      expect(codes).toContain('DUPLICATE_ID');
      expect(codes).toContain('UNKNOWN_BEAT_REF');
    }
  });
});

describe('scalePredicateForBeatPressure and deadline handling', () => {
  it('scales Day 4 clock deadlines according to beatPressure: off -> null, generous -> 6, standard -> 4, harsh -> 3', () => {
    const deadlineAst = { clock: 'day', op: '>=', value: 4 } as const;

    expect(scalePredicateForBeatPressure(deadlineAst, 'off')).toBeNull();
    expect(scalePredicateForBeatPressure(deadlineAst, 'standard')).toEqual({
      clock: 'day',
      op: '>=',
      value: 4,
    });
    expect(scalePredicateForBeatPressure(deadlineAst, 'generous')).toEqual({
      clock: 'day',
      op: '>=',
      value: 6,
    });
    expect(scalePredicateForBeatPressure(deadlineAst, 'harsh')).toEqual({
      clock: 'day',
      op: '>=',
      value: 3,
    });

    // Nested combinator scaling and minimum 1 clamp on harsh
    const nested = {
      all: [
        { clock: 'day', op: '>=', value: 1 },
        { not: { flag: 'saved' } },
      ],
    } as const;
    expect(scalePredicateForBeatPressure(nested, 'harsh')).toEqual({
      all: [
        { clock: 'day', op: '>=', value: 1 },
        { not: { flag: 'saved' } },
      ],
    });
  });

  it('applies pressure-scaled deadlines with escalate, defer, and close policies without firing twice', () => {
    const beats: BeatDefinition[] = [
      {
        id: 'b_escalate',
        class: 'nudge',
        priority: 10,
        when: { flag: 'open' },
        deadline: { clock: 'day', op: '>=', value: 4 },
        deadlinePolicy: 'escalate',
        on_deadline: [{ increment: { escalation_count: 1 } }],
      },
      {
        id: 'b_defer',
        class: 'nudge',
        priority: 8,
        when: { flag: 'open' },
        deadline: { clock: 'day', op: '>=', value: 4 },
        deadlinePolicy: 'defer',
        on_deadline: [{ set: { missed_defer: true } }],
      },
      {
        id: 'b_close',
        class: 'nudge',
        priority: 6,
        when: { flag: 'open' },
        deadline: { clock: 'day', op: '>=', value: 4 },
        deadlinePolicy: 'close',
        on_deadline: [{ set: { missed_close: true } }],
      },
    ];

    const initialLedger = createInitialBeatLedger(beats);

    // Day 3 under harsh pressure triggers Day 4 deadline (scaled to Day 3)
    const day3State = createEngineTestState({ day: 3, flags: { open: true } });
    const offRes = evaluateBeatGraph({
      state: day3State,
      ledger: initialLedger,
      beats,
      beatPressure: 'off',
    });
    expect(offRes.nextLedger.records.b_escalate?.deadlineFired).toBe(false);
    expect(offRes.nextLedger.records.b_defer?.status).toBe('live');
    expect(offRes.nextLedger.records.b_close?.status).toBe('live');

    const harshRes = evaluateBeatGraph({
      state: day3State,
      ledger: initialLedger,
      beats,
      beatPressure: 'harsh',
    });
    expect(harshRes.nextLedger.records.b_escalate?.deadlineFired).toBe(true);
    expect(harshRes.nextLedger.records.b_escalate?.status).toBe('live'); // stays active on escalate
    expect(harshRes.nextState.counters.escalation_count).toBe(1);
    expect(harshRes.nextLedger.records.b_defer?.status).toBe('deferred');
    expect(harshRes.nextState.flags.missed_defer).toBe(true);
    expect(harshRes.nextLedger.records.b_close?.status).toBe('closed');
    expect(harshRes.nextState.flags.missed_close).toBe(true);

    // Next turn: escalate deadline does NOT fire a second time, deferred stays deferred
    const day4State = { ...harshRes.nextState, clocks: { ...harshRes.nextState.clocks, day: 4 } };
    const repeatRes = evaluateBeatGraph({
      state: day4State,
      ledger: harshRes.nextLedger,
      beats,
      beatPressure: 'harsh',
    });
    expect(repeatRes.nextState.counters.escalation_count).toBe(1);
    expect(repeatRes.nextLedger.records.b_defer?.status).toBe('deferred');

    // Day 5 under generous pressure (Day 4 -> Day 6) has NOT fired yet; Day 6 fires
    const day5State = createEngineTestState({ day: 5, flags: { open: true } });
    const genDay5 = evaluateBeatGraph({
      state: day5State,
      ledger: initialLedger,
      beats,
      beatPressure: 'generous',
    });
    expect(genDay5.nextLedger.records.b_close?.status).toBe('live');

    const day6State = createEngineTestState({ day: 6, flags: { open: true } });
    const genDay6 = evaluateBeatGraph({
      state: day6State,
      ledger: genDay5.nextLedger,
      beats,
      beatPressure: 'generous',
    });
    expect(genDay6.nextLedger.records.b_close?.status).toBe('closed');
  });
});

describe('evaluateBeatGraph lifecycle', () => {
  it('short-circuits in 0ms as a pure no-op when capabilities.beats === false', () => {
    const state = createEngineTestState({ beatsEnabled: false, flags: { ready: true } });
    const beats: BeatDefinition[] = [
      {
        id: 'gate_main',
        class: 'gate',
        priority: 10,
        when: { flag: 'ready' },
        on_entry: [{ set: { entered: true } }],
        nudge: 'Act now!',
      },
    ];
    const ledger = createInitialBeatLedger(beats);

    const res = evaluateBeatGraph({ state, ledger, beats });
    expect(res.nextState).toBe(state);
    expect(res.nextLedger).toBe(ledger);
    expect(res.transitions).toEqual([]);
    expect(res.liveNudges).toEqual([]);
    expect(res.auditEntries).toEqual([]);
    expect(res.changedPaths.size).toBe(0);
  });

  it('adapts adaptable beat when default NPC is dead, interpolates templates, and resolves as adapted', () => {
    const state = createEngineTestState({ ariaStatus: 'dead', flags: { start: true } });
    const beats: BeatDefinition[] = [
      {
        id: 'escort_mission',
        class: 'gate',
        flexibility: 'adaptable',
        priority: 20,
        roles: {
          guide: {
            default: 'aria',
            fallbackQuery: {
              collection: 'characters',
              where: { traits: 'guide' },
            },
          },
        },
        when: { flag: 'start' },
        until: { flag: 'arrived' },
        nudge: 'Follow {{roles.guide.name}} ({{roles.guide.id}}) across the plaza.',
        on_resolve: [
          {
            chronicle: {
              category: 'quest',
              title: 'Guided by {{roles.guide.name}}',
              summary: '{{roles.guide.name}} safely escorted the party.',
            },
          },
        ],
      },
    ];

    const ledger = createInitialBeatLedger(beats);
    const enterRes = evaluateBeatGraph({ state, ledger, beats });

    expect(enterRes.nextLedger.records.escort_mission?.status).toBe('live');
    expect(enterRes.nextLedger.records.escort_mission?.adapted).toBe(true);
    expect(enterRes.nextLedger.records.escort_mission?.boundRoles.guide).toEqual({
      roleKey: 'guide',
      entityId: 'cora',
      displayName: 'Cora Vale',
      adapted: true,
      adaptedFrom: 'aria',
      adaptedTo: 'cora',
    });
    expect(enterRes.liveNudges).toEqual([
      {
        beatId: 'escort_mission',
        class: 'gate',
        text: 'Follow Cora Vale (cora) across the plaza.',
      },
    ]);

    const arrivedState: WorldState = {
      ...enterRes.nextState,
      meta: { ...enterRes.nextState.meta, turn: 2 },
      flags: { ...enterRes.nextState.flags, arrived: true },
    };
    const resolveRes = evaluateBeatGraph({
      state: arrivedState,
      ledger: enterRes.nextLedger,
      beats,
    });

    expect(resolveRes.nextLedger.records.escort_mission?.status).toBe('adapted');
    expect(resolveRes.transitions).toEqual([
      {
        beatId: 'escort_mission',
        from: 'live',
        to: 'adapted',
        reason: 'until predicate satisfied (adapted)',
      },
    ]);
    expect(resolveRes.nextState.chronicle.events[0]?.title).toBe('Guided by Cora Vale');
    expect(resolveRes.nextState.chronicle.events[0]?.involvedEntityIds).toEqual(['cora']);
  });

  it('short-circuits strict beats when a required role is unavailable or missing', () => {
    const state = createEngineTestState({ ariaStatus: 'dead', flags: { start: true } });
    const beats: BeatDefinition[] = [
      {
        id: 'strict_confrontation',
        class: 'gate',
        flexibility: 'strict',
        priority: 30,
        roles: {
          rival: {
            default: 'aria',
            fallbackQuery: {
              collection: 'characters',
              where: { traits: 'guide' },
            },
          },
        },
        when: { flag: 'start' },
        on_short_circuit: [{ set: { confrontation_skipped: true } }],
      },
    ];
    const ledger = createInitialBeatLedger(beats);

    const res = evaluateBeatGraph({ state, ledger, beats });
    expect(res.nextLedger.records.strict_confrontation?.status).toBe('short_circuited');
    expect(res.nextState.flags.confrontation_skipped).toBe(true);
    expect(res.nextLedger.liveGateId).toBeNull();
  });

  it('handles impossible_when and eligibility loss (on_abort) on live beats', () => {
    const beats: BeatDefinition[] = [
      {
        id: 'ambush_gate',
        class: 'gate',
        priority: 15,
        when: { flag: 'in_danger' },
        impossible_when: { flag: 'enemies_defeated' },
        on_abort: [{ set: { ambush_aborted: true }, increment: { abort_count: 1 } }],
        on_short_circuit: [{ set: { ambush_impossible: true } }],
      },
    ];

    // Enter live
    const state1 = createEngineTestState({ flags: { in_danger: true } });
    const res1 = evaluateBeatGraph({
      state: state1,
      ledger: createInitialBeatLedger(beats),
      beats,
    });
    expect(res1.nextLedger.records.ambush_gate?.status).toBe('live');

    // Lose eligibility while live -> dormant + on_abort
    const state2 = createEngineTestState({ flags: { in_danger: false }, turn: 2 });
    const res2 = evaluateBeatGraph({
      state: state2,
      ledger: res1.nextLedger,
      beats,
    });
    expect(res2.nextLedger.records.ambush_gate?.status).toBe('dormant');
    expect(res2.nextLedger.liveGateId).toBeNull();
    expect(res2.nextState.flags.ambush_aborted).toBe(true);
    expect(res2.nextState.counters.abort_count).toBe(1);

    // impossible_when triggers short_circuited
    const state3 = createEngineTestState({
      flags: { in_danger: true, enemies_defeated: true },
      turn: 3,
    });
    const res3 = evaluateBeatGraph({
      state: state3,
      ledger: res2.nextLedger,
      beats,
    });
    expect(res3.nextLedger.records.ambush_gate?.status).toBe('short_circuited');
    expect(res3.nextState.flags.ambush_impossible).toBe(true);
  });

  it('enforces BR-3 0..1 gate selection tie-breaking, 0..N nudges/ambient, and one-time atomic on_entry', () => {
    const beats: BeatDefinition[] = [
      {
        id: 'gate_b',
        class: 'gate',
        priority: 50,
        when: { flag: 'open' },
        until: { flag: 'b_done' },
        nudge: 'Gate B nudge',
        on_entry: [
          { set: { gate_b_entered: true } },
          { increment: { gate_b_entries: 1 } },
          {
            entity_patch: {
              collection: 'threats',
              entityId: 'blight',
              patch: { progress: 25 },
            },
          },
          { op: 'set', path: 'scene.mood', value: 'tense' },
          { inject: 'lore/gate_b.md' },
          { script: 'on_gate_b_start' },
        ],
      },
      {
        id: 'gate_a',
        class: 'gate',
        priority: 50, // same priority as gate_b -> 'gate_a' < 'gate_b' wins tie-break!
        when: { flag: 'open' },
        until: { flag: 'a_done' },
        nudge: 'Gate A nudge',
        on_entry: [{ increment: { gate_a_entries: 1 } }],
      },
      {
        id: 'gate_high',
        class: 'gate',
        priority: 100,
        when: { flag: 'urgent' },
        until: { flag: 'high_done' },
        nudge: 'Urgent gate nudge',
      },
      {
        id: 'nudge_1',
        class: 'nudge',
        priority: 10,
        when: { flag: 'open' },
        nudge: 'Side nudge 1',
      },
      {
        id: 'nudge_2',
        class: 'nudge',
        priority: 5,
        when: { flag: 'open' },
        nudge: 'Side nudge 2',
      },
      {
        id: 'ambient_1',
        class: 'ambient',
        priority: 1,
        when: { flag: 'open' },
        lore: 'Wind blows through the plaza.',
        nudge: 'Atmosphere note',
      },
    ];

    const state1 = createEngineTestState({ flags: { open: true } });
    const snapshotBefore = JSON.stringify(state1);
    const ledger0 = createInitialBeatLedger(beats);
    const ledgerSnapshot = JSON.stringify(ledger0);

    const res1 = evaluateBeatGraph({ state: state1, ledger: ledger0, beats });

    // Input state & ledger must remain completely unmutated
    expect(JSON.stringify(state1)).toBe(snapshotBefore);
    expect(JSON.stringify(ledger0)).toBe(ledgerSnapshot);

    // gate_a wins tie-break over gate_b; gate_b remains eligible; both nudges & ambient live
    expect(res1.nextLedger.liveGateId).toBe('gate_a');
    expect(res1.nextLedger.records.gate_a?.status).toBe('live');
    expect(res1.nextLedger.records.gate_b?.status).toBe('eligible');
    expect(res1.nextState.counters.gate_a_entries).toBe(1);
    expect(res1.nextLedger.liveNudgeIds).toEqual(['nudge_1', 'nudge_2']);
    expect(res1.nextLedger.activeAmbientIds).toEqual(['ambient_1']);
    expect(res1.liveNudges).toEqual([
      { beatId: 'gate_a', class: 'gate', text: 'Gate A nudge' },
      { beatId: 'nudge_1', class: 'nudge', text: 'Side nudge 1' },
      { beatId: 'nudge_2', class: 'nudge', text: 'Side nudge 2' },
    ]);
    expect(res1.activeAmbient).toEqual([
      {
        beatId: 'ambient_1',
        lore: 'Wind blows through the plaza.',
        nudge: 'Atmosphere note',
      },
    ]);
    expect(res1.auditEntries.every((e) => e.source === 'beat')).toBe(true);

    // Higher-priority gate_high preempts gate_a -> gate_a returns to eligible
    const state2: WorldState = {
      ...res1.nextState,
      meta: { ...res1.nextState.meta, turn: 2 },
      flags: { ...res1.nextState.flags, urgent: true },
    };
    const res2 = evaluateBeatGraph({ state: state2, ledger: res1.nextLedger, beats });
    expect(res2.nextLedger.liveGateId).toBe('gate_high');
    expect(res2.nextLedger.records.gate_high?.status).toBe('live');
    expect(res2.nextLedger.records.gate_a?.status).toBe('eligible');

    // gate_high resolves -> gate_a re-enters live WITHOUT firing on_entry a second time!
    const state3: WorldState = {
      ...res2.nextState,
      meta: { ...res2.nextState.meta, turn: 3 },
      flags: { ...res2.nextState.flags, high_done: true },
    };
    const res3 = evaluateBeatGraph({ state: state3, ledger: res2.nextLedger, beats });
    expect(res3.nextLedger.records.gate_high?.status).toBe('resolved');
    expect(res3.nextLedger.liveGateId).toBe('gate_a');
    expect(res3.nextState.counters.gate_a_entries).toBe(1);

    // gate_a resolves -> gate_b becomes live and triggers its on_entry effects atomically
    const state4: WorldState = {
      ...res3.nextState,
      meta: { ...res3.nextState.meta, turn: 4 },
      flags: { ...res3.nextState.flags, a_done: true },
    };
    const res4 = evaluateBeatGraph({ state: state4, ledger: res3.nextLedger, beats });
    expect(res4.nextLedger.records.gate_a?.status).toBe('resolved');
    expect(res4.nextLedger.liveGateId).toBe('gate_b');
    expect(res4.nextState.flags.gate_b_entered).toBe(true);
    expect(res4.nextState.counters.gate_b_entries).toBe(1);
    expect(res4.nextState.entities.threats.blight?.progress).toBe(25);
    expect(res4.nextState.scene.mood).toBe('tense');
    expect(res4.injectedLorePaths).toEqual(['lore/gate_b.md']);
    expect(res4.triggeredScripts).toEqual(['on_gate_b_start']);
  });

  it('rolls back failed on_entry PatchBatch atomically and records warnings', () => {
    const beats: BeatDefinition[] = [
      {
        id: 'bad_entry',
        class: 'gate',
        priority: 10,
        when: { flag: 'start' },
        on_entry: [
          { set: { partial_flag: true } },
          { set: { 'scene.nonexistentField': 'bad' } },
        ],
      },
    ];

    const state = createEngineTestState({ flags: { start: true } });
    const res = evaluateBeatGraph({
      state,
      ledger: createInitialBeatLedger(beats),
      beats,
    });

    expect(res.nextState.flags.partial_flag).toBeUndefined();
    expect(res.warnings.length).toBeGreaterThan(0);
  });

  it('supports requires + requiresPolicy and DependencyIndex dirty-ID pruning', () => {
    const beats: BeatDefinition[] = [
      {
        id: 'step_1',
        class: 'gate',
        priority: 10,
        when: { flag: 'start' },
        until: { flag: 'step_1_done' },
        on_resolve: [{ set: { unlocked_step_2: true } }],
      },
      {
        id: 'step_2',
        class: 'gate',
        priority: 10,
        requires: ['step_1'],
        requiresPolicy: 'terminal_completed',
        when: { flag: 'unlocked_step_2' },
      },
      {
        id: 'step_3_any',
        class: 'nudge',
        priority: 5,
        requires: ['step_1'],
        requiresPolicy: 'any_terminal',
        when: { flag: 'start' },
      },
    ];

    const index = buildBeatDependencyIndex(beats);
    const ledger0 = createInitialBeatLedger(beats);
    const state1 = createEngineTestState({ flags: { start: true } });

    const res1 = evaluateBeatGraph({
      state: state1,
      ledger: ledger0,
      beats,
      dependencyIndex: index,
      changedPaths: new Set(['flags.start']),
    });
    expect(res1.nextLedger.records.step_1?.status).toBe('live');
    expect(res1.nextLedger.records.step_2?.status).toBe('dormant');
    expect(res1.nextLedger.records.step_3_any?.status).toBe('dormant');

    // Step 1 resolves -> on_resolve sets flags.unlocked_step_2, dirties step_2 & step_3_any in same pass!
    const state2: WorldState = {
      ...res1.nextState,
      meta: { ...res1.nextState.meta, turn: 2 },
      flags: { ...res1.nextState.flags, step_1_done: true },
    };
    const res2 = evaluateBeatGraph({
      state: state2,
      ledger: res1.nextLedger,
      beats,
      dependencyIndex: index,
      changedPaths: new Set(['flags.step_1_done']),
    });
    expect(res2.nextLedger.records.step_1?.status).toBe('resolved');
    expect(res2.nextLedger.records.step_2?.status).toBe('live');
    expect(res2.nextLedger.records.step_3_any?.status).toBe('live');
  });

  it('supports Director forceBeatTransition with user_director source and BR-9 monotonicity', () => {
    const beats: BeatDefinition[] = [
      {
        id: 'canon_gate',
        class: 'gate',
        priority: 10,
        when: { flag: 'open' },
        on_resolve: [{ set: { canon_resolved_by_director: true } }],
      },
      {
        id: 'side_nudge',
        class: 'nudge',
        priority: 5,
        when: { flag: 'open' },
      },
    ];

    const state = createEngineTestState({ flags: { open: true } });
    const evalRes = evaluateBeatGraph({
      state,
      ledger: createInitialBeatLedger(beats),
      beats,
    });
    expect(evalRes.nextLedger.liveGateId).toBe('canon_gate');

    // Force defer on side_nudge
    const deferRes = forceBeatTransition(
      evalRes.nextLedger,
      evalRes.nextState,
      'side_nudge',
      'deferred'
    );
    expect(isOk(deferRes)).toBe(true);
    if (isOk(deferRes)) {
      expect(deferRes.value.nextLedger.records.side_nudge?.status).toBe('deferred');
      expect(deferRes.value.nextLedger.liveNudgeIds).toEqual([]);
      expect(deferRes.value.auditEntries[0]?.source).toBe('user_director');
    }

    // Force resolve on canon_gate with beats options so on_resolve runs as user_director
    const ledgerAfterDefer = isOk(deferRes) ? deferRes.value.nextLedger : evalRes.nextLedger;
    const stateAfterDefer = isOk(deferRes) ? deferRes.value.nextState : evalRes.nextState;
    const resolveRes = forceBeatTransition(
      ledgerAfterDefer,
      stateAfterDefer,
      'canon_gate',
      'resolved',
      { beats }
    );
    expect(isOk(resolveRes)).toBe(true);
    if (isOk(resolveRes)) {
      expect(resolveRes.value.nextLedger.records.canon_gate?.status).toBe('resolved');
      expect(resolveRes.value.nextLedger.liveGateId).toBeNull();
      expect(resolveRes.value.nextState.flags.canon_resolved_by_director).toBe(true);
      expect(resolveRes.value.auditEntries.every((e) => e.source === 'user_director')).toBe(true);

      // Attempting to force a terminal beat back to deferred or short_circuited fails monotonically (BR-9)
      const reopenErr = forceBeatTransition(
        resolveRes.value.nextLedger,
        resolveRes.value.nextState,
        'canon_gate',
        'deferred'
      );
      expect(isErr(reopenErr)).toBe(true);
      if (isErr(reopenErr)) {
        expect(reopenErr.error[0]?.code).toBe('ILLEGAL_BEAT_TRANSITION');
      }
    }

    // Missing beat fails cleanly
    const missingErr = forceBeatTransition(evalRes.nextLedger, evalRes.nextState, 'missing', 'resolved');
    expect(isErr(missingErr)).toBe(true);
    if (isErr(missingErr)) {
      expect(missingErr.error[0]?.code).toBe('BEAT_NOT_FOUND');
    }
  });
});
