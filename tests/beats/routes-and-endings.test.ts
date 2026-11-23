import { describe, expect, it } from 'vitest';
import { evaluateBeatGraph } from '../../src/beats/beat-engine.js';
import { type BeatDefinition, createInitialBeatLedger } from '../../src/beats/beat-ledger.js';
import {
  type EndingDefinition,
  type RouteDefinition,
  chooseEndingBranch,
  evaluateEndings,
  evaluateRoutes,
  filterBeatsForActiveRoutes,
  getLockedRoutesByGroup,
  validateRoutesAndEndings,
} from '../../src/beats/routes-and-endings.js';
import { isErr, isOk } from '../../src/core/result.js';
import { appendAuditEntries, createAuditLog, queryAuditLog } from '../../src/state/audit-log.js';
import { type WorldState, createWorldState } from '../../src/state/world-state.js';

function createTestWorldState(overrides?: {
  beatsEnabled?: boolean;
  day?: number;
  turn?: number;
  flags?: Record<string, boolean>;
  counters?: Record<string, number>;
  endingStatus?: WorldState['meta']['endingStatus'];
  activeEndingId?: string | null;
  arc?: WorldState['meta']['arc'];
}): WorldState {
  return createWorldState({
    sessionId: 'routes-endings-test',
    turn: overrides?.turn ?? 2,
    arc: overrides?.arc ?? 'season',
    endingStatus: overrides?.endingStatus ?? 'none',
    activeEndingId: overrides?.activeEndingId ?? null,
    capabilities: {
      spatialMode: 'scene_only',
      combatMode: 'disabled',
      progression: 'disabled',
      clocks: 'full_sim',
      factions: true,
      beats: overrides?.beatsEnabled ?? true,
      relationships: true,
      chronicle: true,
    },
    clocks: {
      turn: overrides?.turn ?? 2,
      storyTurn: overrides?.turn ?? 2,
      day: overrides?.day ?? 2,
      slot: 'evening',
    },
    flags: overrides?.flags ?? {},
    counters: overrides?.counters ?? {},
  });
}

describe('validateRoutesAndEndings', () => {
  const validRoutes: RouteDefinition[] = [
    {
      id: 'loyal',
      lock: 'route_loyal',
      priority: 2,
      when: { flag: 'oath_sworn' },
      announce: 'Loyal route locked.',
    },
    {
      id: 'betrayal',
      lock: 'route_betrayal',
      priority: 1,
      when: { flag: 'archive_betrayal' },
    },
  ];

  const validEndings: EndingDefinition[] = [
    {
      id: 'true-ending',
      route: 'loyal',
      priority: 10,
      when: { flag: 'victory' },
      epilogue: { promptPath: 'epilogues/true.md', template: 'Peace returns.' },
      mark: 'ending_true',
      branches: [
        {
          id: 'new-season',
          label: 'Begin Season 2',
          targetArc: 'season',
          patch: { season_started: true },
        },
      ],
    },
  ];

  it('accepts valid routes, endings, and branches', () => {
    const res = validateRoutesAndEndings(validRoutes, validEndings);
    expect(isOk(res)).toBe(true);
  });

  it('supports external routeDefs lookup when routes subset is passed', () => {
    const res = validateRoutesAndEndings([], validEndings, validRoutes);
    expect(isOk(res)).toBe(true);
  });

  it('rejects duplicate route IDs, duplicate ending IDs, and duplicate branch IDs', () => {
    const dupRoutes: RouteDefinition[] = [
      validRoutes[0]!,
      { ...validRoutes[1]!, id: 'loyal' },
    ];
    const dupEndings: EndingDefinition[] = [
      {
        ...validEndings[0]!,
        branches: [
          { id: 'dup-branch', label: 'First' },
          { id: 'dup-branch', label: 'Second' },
        ],
      },
      { ...validEndings[0]!, mark: 'ending_other' },
    ];

    const res = validateRoutesAndEndings(dupRoutes, dupEndings);
    expect(isErr(res)).toBe(true);
    if (!res.ok) {
      const codes = res.error.map((e) => e.code);
      expect(codes).toContain('DUPLICATE_ID');
      expect(codes).toContain('DUPLICATE_BRANCH_ID');
    }
  });

  it('rejects empty lock/mark flags, invalid predicates, and unknown route references', () => {
    const badRoutes: RouteDefinition[] = [
      {
        id: 'bad',
        lock: '   ',
        priority: 1,
        when: { counter: 'trust', op: 'invalid_op' as unknown as '==', value: 1 },
      },
    ];
    const badEndings: EndingDefinition[] = [
      {
        id: 'bad-ending',
        route: 'nonexistent_route',
        when: { flag: '' },
        epilogue: {},
        mark: '',
        branches: [
          {
            id: 'b1',
            label: 'Bad Branch',
            activateRoute: 'missing_post_route',
          },
        ],
      },
    ];

    const res = validateRoutesAndEndings(badRoutes, badEndings);
    expect(isErr(res)).toBe(true);
    if (!res.ok) {
      const codes = res.error.map((e) => e.code);
      expect(codes).toContain('REQUIRED');
      expect(codes).toContain('INVALID_COMPARISON_OP');
      expect(codes).toContain('INVALID_FLAG_NAME');
      expect(codes).toContain('UNKNOWN_ROUTE_REF');
    }
  });

  it('rejects prototype pollution keys in route/ending identifiers and branch patches', () => {
    const unsafePatch = JSON.parse('{"__proto__": {"polluted": true}}') as Record<string, unknown>;
    const unsafeRoutes: RouteDefinition[] = [
      {
        id: 'constructor',
        lock: 'prototype',
        priority: 1,
        when: { flag: 'ok' },
      },
    ];
    const unsafeEndings: EndingDefinition[] = [
      {
        id: 'e1',
        when: { flag: 'ok' },
        epilogue: { template: 'Done' },
        mark: 'constructor',
        branches: [
          {
            id: 'b1',
            label: 'Unsafe',
            patch: unsafePatch,
          },
        ],
      },
    ];

    const res = validateRoutesAndEndings(unsafeRoutes, unsafeEndings);
    expect(isErr(res)).toBe(true);
    if (!res.ok) {
      expect(res.error.some((e) => e.code === 'UNSAFE_PROPERTY_KEY')).toBe(true);
    }
  });
});

describe('§6.15 Crimson Keep worked example', () => {
  const routes: RouteDefinition[] = [
    {
      id: 'loyal',
      lock: 'route_loyal',
      priority: 2,
      when: {
        all: [
          { clock: 'day', op: '>=', value: 2 },
          { flag: 'archive_discovered' },
          { counter: 'trust', op: '>=', value: 3 },
        ],
      },
      announce: 'You pledge your steel to the Keep.',
    },
    {
      id: 'betrayal',
      lock: 'route_betrayal',
      priority: 1,
      when: {
        all: [
          { clock: 'day', op: '>=', value: 2 },
          { flag: 'archive_discovered' },
          { counter: 'trust', op: '<', value: 3 },
        ],
      },
      announce: 'The Crimson Archive reveals the Warden’s lie — betrayal path locked.',
    },
  ];

  const beats: BeatDefinition[] = [
    {
      id: 'discover-archive',
      class: 'gate',
      priority: 10,
      when: { clock: 'day', op: '>=', value: 2 },
      until: { flag: 'archive_discovered' },
      nudge: 'Search the Crimson Archive.',
    },
    {
      id: 'betrayal-contact',
      route: 'betrayal',
      class: 'nudge',
      priority: 5,
      when: { flag: 'archive_discovered' },
      nudge: 'Meet the Whisperer beneath the Keep.',
    },
    {
      id: 'loyal-oath',
      route: 'loyal',
      class: 'nudge',
      priority: 5,
      when: { flag: 'archive_discovered' },
      nudge: 'Report your findings to the Warden.',
    },
  ];

  const endings: EndingDefinition[] = [
    {
      id: 'true-ending',
      route: 'loyal',
      priority: 2,
      when: { flag: 'keep_saved' },
      epilogue: { template: 'The Crimson Keep stands unbroken.' },
      mark: 'ending_true',
    },
    {
      id: 'betrayal-ending',
      route: 'betrayal',
      priority: 1,
      when: { flag: 'keep_fallen' },
      epilogue: { template: 'The Keep burns from within.' },
      mark: 'ending_betrayal',
    },
  ];

  it('locks route_betrayal on Day 2 with trust < 3, activates betrayal beats, blocks true-ending, and logs exact audit cause', () => {
    const initialState = createTestWorldState({
      day: 2,
      turn: 5,
      flags: { archive_discovered: true },
      counters: { trust: 2 },
    });
    const ledger = createInitialBeatLedger(beats);

    // Pre-lock: only route-less beats are active by default (requireRouteLocked: true)
    const preLockBeats = filterBeatsForActiveRoutes(beats, initialState, routes);
    expect(preLockBeats.map((b) => b.id)).toEqual(['discover-archive']);

    // Evaluate routes: loyal (priority 2) fails trust >= 3, betrayal (priority 1) matches
    const routeEval = evaluateRoutes({
      state: initialState,
      ledger,
      routes,
    });

    // Immutability check on input state
    expect(initialState.flags['route_betrayal']).toBeUndefined();

    expect(routeEval.warnings).toEqual([]);
    expect(routeEval.newlyLockedRoutes.map((r) => r.id)).toEqual(['betrayal']);
    expect(routeEval.announcements).toEqual([
      'The Crimson Archive reveals the Warden’s lie — betrayal path locked.',
    ]);
    expect(routeEval.nextState.flags['route_betrayal']).toBe(true);
    expect(routeEval.nextState.flags['route_loyal']).toBeUndefined();
    expect(routeEval.changedPaths.has('flags.route_betrayal')).toBe(true);

    // Queryable audit entries show exact cause
    const log = appendAuditEntries(createAuditLog(), routeEval.auditEntries);
    const routeAudit = queryAuditLog(log, { pathPrefix: 'flags.route_' });
    expect(routeAudit).toHaveLength(1);
    expect(routeAudit[0]).toMatchObject({
      op: 'route_lock',
      path: 'flags.route_betrayal',
      oldValue: undefined,
      newValue: true,
      status: 'committed',
      turn: 5,
    });
    expect(routeAudit[0]?.reason).toContain('betrayal');

    const lockedMap = getLockedRoutesByGroup(routeEval.nextState, routes);
    expect(lockedMap.get('default')?.id).toBe('betrayal');

    // Betrayal beats activate while loyal beats remain excluded
    const activeBeats = filterBeatsForActiveRoutes(beats, routeEval.nextState, routes);
    expect(activeBeats.map((b) => b.id)).toEqual(['discover-archive', 'betrayal-contact']);

    // Even with requireRouteLocked: false, loyal-oath is excluded because default group locked betrayal
    const permissiveAfterLock = filterBeatsForActiveRoutes(beats, routeEval.nextState, routes, {
      requireRouteLocked: false,
    });
    expect(permissiveAfterLock.map((b) => b.id)).toEqual(['discover-archive', 'betrayal-contact']);

    // Evaluate beat graph on filtered beats -> betrayal-contact activates live
    const graphRes = evaluateBeatGraph({
      state: routeEval.nextState,
      ledger,
      beats: activeBeats,
    });
    expect(graphRes.nextLedger.records['betrayal-contact']?.status).toBe('live');
    expect(graphRes.nextLedger.records['loyal-oath']?.status).toBe('dormant');

    // Even if keep_saved is true, true-ending (route: 'loyal') cannot fire
    const stateWithKeepSaved = createTestWorldState({
      day: 3,
      turn: 6,
      flags: {
        ...routeEval.nextState.flags,
        keep_saved: true,
      },
      counters: { trust: 5 },
    });
    const blockedEndingRes = evaluateEndings({
      state: stateWithKeepSaved,
      ledger: graphRes.nextLedger,
      endings,
      routes,
    });
    expect(blockedEndingRes.triggeredEnding).toBeNull();
    expect(blockedEndingRes.nextState.meta.endingStatus).toBe('none');

    // Betrayal ending triggers when its condition holds
    const stateWithKeepFallen = createTestWorldState({
      day: 3,
      turn: 7,
      flags: {
        ...routeEval.nextState.flags,
        keep_fallen: true,
      },
      counters: { trust: 2 },
    });
    const betrayalEndingRes = evaluateEndings({
      state: stateWithKeepFallen,
      ledger: graphRes.nextLedger,
      endings,
      routes,
    });
    expect(betrayalEndingRes.triggeredEnding?.id).toBe('betrayal-ending');
    expect(betrayalEndingRes.nextState.meta.endingStatus).toBe('epilogue');
    expect(betrayalEndingRes.nextState.flags['ending_betrayal']).toBe(true);
  });
});

describe('Route priority tie-breaking and first-lock-wins', () => {
  it('breaks equal priority ties by left-to-right declaration order and enforces first-lock-wins per group', () => {
    const routes: RouteDefinition[] = [
      {
        id: 'route-high-later',
        lock: 'route_high_later',
        priority: 10,
        when: { flag: 'trigger_high' },
      },
      {
        id: 'route-first-declared',
        lock: 'route_first',
        priority: 5,
        when: { flag: 'trigger_tie' },
        announce: 'First declared won tie.',
      },
      {
        id: 'route-second-declared',
        lock: 'route_second',
        priority: 5,
        when: { flag: 'trigger_tie' },
        announce: 'Second declared should not win.',
      },
      {
        id: 'romance-aria',
        group: 'romance',
        lock: 'route_romance_aria',
        priority: 1,
        when: { flag: 'aria_kiss' },
      },
    ];

    const state1 = createTestWorldState({
      flags: { trigger_tie: true, aria_kiss: true },
    });
    const ledger = createInitialBeatLedger([]);

    const res1 = evaluateRoutes({ state: state1, ledger, routes });
    expect(res1.newlyLockedRoutes.map((r) => r.id)).toEqual([
      'route-first-declared',
      'romance-aria',
    ]);
    expect(res1.nextState.flags['route_first']).toBe(true);
    expect(res1.nextState.flags['route_second']).toBeUndefined();
    expect(res1.nextState.flags['route_romance_aria']).toBe(true);

    // On a later turn, even if a higher-priority route in 'default' matches, first lock wins!
    const state2 = createTestWorldState({
      turn: 4,
      flags: {
        ...res1.nextState.flags,
        trigger_high: true,
      },
    });
    const res2 = evaluateRoutes({ state: state2, ledger, routes });
    expect(res2.newlyLockedRoutes).toEqual([]);
    expect(res2.nextState.flags['route_high_later']).toBeUndefined();
    expect(res2.auditEntries).toEqual([]);

    // If the group lock is cleared externally, the group can lock again
    const stateCleared = createTestWorldState({
      turn: 5,
      flags: {
        ...state2.flags,
        route_first: false,
      },
    });
    const res3 = evaluateRoutes({ state: stateCleared, ledger, routes });
    expect(res3.newlyLockedRoutes.map((r) => r.id)).toEqual(['route-high-later']);
    expect(res3.nextState.flags['route_high_later']).toBe(true);
  });
});

describe('Villain Victory ending & post-ending resistance branch', () => {
  const routes: RouteDefinition[] = [
    {
      id: 'villain',
      lock: 'route_villain',
      priority: 3,
      when: { flag: 'sided_with_malakor' },
    },
    {
      id: 'loyal',
      lock: 'route_loyal',
      priority: 2,
      when: { flag: 'oath_kept' },
    },
    {
      id: 'resistance',
      group: 'post_victory',
      lock: 'route_resistance',
      priority: 1,
      when: { flag: 'ending_villain_victory' },
      announce: 'The underground resistance rises.',
    },
  ];

  const villainVictoryEnding: EndingDefinition = {
    id: 'villain-victory',
    route: 'villain',
    priority: 10,
    when: {
      all: [{ flag: 'citadel_captured' }, { counter: 'malakor_favor', op: '>=', value: 5 }],
    },
    epilogue: {
      promptPath: 'epilogues/villain_victory.md',
      template: 'Malakor takes the throne.',
    },
    mark: 'ending_villain_victory',
    branches: [
      {
        id: 'secret-resistance',
        label: 'Spark the Underground Resistance',
        activateRoute: 'resistance',
        routeGroup: 'default',
        targetArc: 'post-victory',
        patch: {
          'counters.malakor_favor': 0,
          resistance_cells: 3,
          rebellion_active: true,
          scene: { mood: 'defiant' },
        },
      },
      {
        id: 'new-dawn',
        label: 'Start a New Season',
        targetArc: 'season',
      },
    ],
  };

  it('triggers Villain Victory atomically, caches epilogue state against re-firing, and transitions into resistance post-victory branch', () => {
    const initialState = createTestWorldState({
      turn: 12,
      flags: {
        route_villain: true,
        citadel_captured: true,
      },
      counters: {
        malakor_favor: 6,
      },
    });
    const ledger = createInitialBeatLedger([]);

    const endingRes = evaluateEndings({
      state: initialState,
      ledger,
      endings: [villainVictoryEnding],
      routes,
    });

    expect(endingRes.triggeredEnding?.id).toBe('villain-victory');
    expect(endingRes.nextState.meta.endingStatus).toBe('epilogue');
    expect(endingRes.nextState.meta.activeEndingId).toBe('villain-victory');
    expect(endingRes.nextState.flags['ending_villain_victory']).toBe(true);
    expect(endingRes.changedPaths.has('meta.endingStatus')).toBe(true);
    expect(endingRes.changedPaths.has('meta.activeEndingId')).toBe(true);
    expect(endingRes.changedPaths.has('flags.ending_villain_victory')).toBe(true);
    expect(endingRes.auditEntries).toHaveLength(3);

    // Input state remains unmutated
    expect(initialState.meta.endingStatus).toBe('none');
    expect(initialState.flags['ending_villain_victory']).toBeUndefined();

    // Calling evaluateEndings again is a cached no-op because endingStatus !== 'none'
    const secondEndingRes = evaluateEndings({
      state: endingRes.nextState,
      ledger,
      endings: [villainVictoryEnding],
      routes,
    });
    expect(secondEndingRes.triggeredEnding).toBeNull();
    expect(secondEndingRes.auditEntries).toEqual([]);
    expect(secondEndingRes.nextState).toBe(endingRes.nextState);

    // Choose the post-ending 'resistance' branch
    const branchRes = chooseEndingBranch({
      state: endingRes.nextState,
      ending: villainVictoryEnding,
      branchId: 'secret-resistance',
      routes,
    });
    expect(isOk(branchRes)).toBe(true);
    if (!branchRes.ok) {
      return;
    }

    const postState = branchRes.value.nextState;
    expect(branchRes.value.branch.id).toBe('secret-resistance');
    expect(postState.meta.arc).toBe('post-victory');
    expect(postState.meta.endingStatus).toBe('continued');
    expect(postState.meta.activeEndingId).toBe('villain-victory');
    // Competing lock in 'default' cleared, post-victory route locked
    expect(postState.flags['route_villain']).toBe(false);
    expect(postState.flags['route_resistance']).toBe(true);
    // Branch patches applied
    expect(postState.counters['malakor_favor']).toBe(0);
    expect(postState.counters['resistance_cells']).toBe(3);
    expect(postState.flags['rebellion_active']).toBe(true);
    expect(postState.scene.mood).toBe('defiant');

    // Resistance beats now activate via filterBeatsForActiveRoutes
    const postBeats: BeatDefinition[] = [
      {
        id: 'villain-purge',
        route: 'villain',
        class: 'nudge',
        priority: 5,
        when: { flag: 'citadel_captured' },
      },
      {
        id: 'resistance-rally',
        route: 'resistance',
        class: 'gate',
        priority: 10,
        when: { flag: 'rebellion_active' },
      },
    ];
    const filteredPostBeats = filterBeatsForActiveRoutes(postBeats, postState, routes);
    expect(filteredPostBeats.map((b) => b.id)).toEqual(['resistance-rally']);
  });

  it('does not evaluate endings when capabilities.beats is false', () => {
    const disabledState = createTestWorldState({
      beatsEnabled: false,
      flags: { route_villain: true, citadel_captured: true },
      counters: { malakor_favor: 8 },
    });
    const res = evaluateEndings({
      state: disabledState,
      ledger: createInitialBeatLedger([]),
      endings: [villainVictoryEnding],
      routes,
    });
    expect(res.triggeredEnding).toBeNull();
    expect(res.nextState).toBe(disabledState);
    expect(res.auditEntries).toEqual([]);
  });

  it('returns validation errors on unknown branchId or unknown activateRoute without mutating state', () => {
    const epilogueState = createTestWorldState({
      endingStatus: 'epilogue',
      activeEndingId: 'villain-victory',
    });

    const missingBranch = chooseEndingBranch({
      state: epilogueState,
      ending: villainVictoryEnding,
      branchId: 'does-not-exist',
      routes,
    });
    expect(isErr(missingBranch)).toBe(true);
    if (!missingBranch.ok) {
      expect(missingBranch.error[0]?.code).toBe('UNKNOWN_BRANCH');
    }

    const missingRoute = chooseEndingBranch({
      state: epilogueState,
      ending: villainVictoryEnding,
      branchId: 'secret-resistance',
      routes: [],
    });
    expect(isErr(missingRoute)).toBe(true);
    if (!missingRoute.ok) {
      expect(missingRoute.error[0]?.code).toBe('UNKNOWN_ROUTE_REF');
    }
  });

  it('supports branch.patch customFields objects, targetArc season, and preserves unrelated route groups', () => {
    const epilogueWithRomance = createTestWorldState({
      endingStatus: 'epilogue',
      activeEndingId: 'villain-victory',
      flags: {
        route_villain: true,
        route_romance_aria: true,
      },
    });

    const extendedRoutes: RouteDefinition[] = [
      ...routes,
      {
        id: 'romance-aria',
        group: 'romance',
        lock: 'route_romance_aria',
        priority: 1,
        when: { flag: 'aria_kiss' },
      },
    ];

    const branchEnding: EndingDefinition = {
      ...villainVictoryEnding,
      branches: [
        {
          id: 'season-two',
          label: 'Season Two',
          activateRoute: 'resistance',
          targetArc: 'season',
          patch: {
            customFields: {
              campaignMetadata: { chapter: 2, faction: 'rebels' },
            },
          },
        },
      ],
    };

    const res = chooseEndingBranch({
      state: epilogueWithRomance,
      ending: branchEnding,
      branchId: 'season-two',
      routes: extendedRoutes,
    });
    expect(isOk(res)).toBe(true);
    if (res.ok) {
      expect(res.value.nextState.meta.arc).toBe('season');
      expect(res.value.nextState.meta.endingStatus).toBe('continued');
      expect(res.value.nextState.flags['route_villain']).toBe(false);
      expect(res.value.nextState.flags['route_resistance']).toBe(true);
      expect(res.value.nextState.flags['route_romance_aria']).toBe(true);
      expect(res.value.nextState.customFields['campaignMetadata']).toEqual({
        chapter: 2,
        faction: 'rebels',
      });
    }
  });
});

describe('Transcript mentions, ending priority tie-breaking, and pre-lock beat filtering', () => {
  it('breaks ending priority ties left-to-right and evaluates transcript mentions', () => {
    const routes: RouteDefinition[] = [
      {
        id: 'whispered-pact',
        lock: 'route_whispered_pact',
        priority: 1,
        when: { mentions: ['blood seal'] },
      },
    ];

    const endings: EndingDefinition[] = [
      {
        id: 'ending-low',
        priority: 1,
        when: { flag: 'game_over' },
        epilogue: { template: 'Low' },
        mark: 'ending_low',
      },
      {
        id: 'ending-tie-first',
        priority: 5,
        when: { flag: 'game_over' },
        epilogue: { template: 'Tie First' },
        mark: 'ending_tie_first',
      },
      {
        id: 'ending-tie-second',
        priority: 5,
        when: { flag: 'game_over' },
        epilogue: { template: 'Tie Second' },
        mark: 'ending_tie_second',
      },
    ];

    const state = createTestWorldState({
      flags: { game_over: true },
    });
    const ledger = createInitialBeatLedger([]);

    const routeRes = evaluateRoutes({
      state,
      ledger,
      routes,
      recentTranscriptLines: ['She breaks the blood seal in silence.'],
    });
    expect(routeRes.newlyLockedRoutes.map((r) => r.id)).toEqual(['whispered-pact']);

    const endingRes = evaluateEndings({
      state: routeRes.nextState,
      ledger,
      endings,
      routes,
    });
    expect(endingRes.triggeredEnding?.id).toBe('ending-tie-first');
  });

  it('handles requireRouteLocked: false pre-lock and drops beats referencing unknown routes', () => {
    const routes: RouteDefinition[] = [
      { id: 'loyal', lock: 'route_loyal', priority: 2, when: { flag: 'a' } },
      { id: 'betrayal', lock: 'route_betrayal', priority: 1, when: { flag: 'b' } },
    ];
    const beats: BeatDefinition[] = [
      { id: 'common', class: 'ambient', priority: 1, when: { flag: 'ok' } },
      { id: 'loyal-beat', route: 'loyal', class: 'nudge', priority: 2, when: { flag: 'ok' } },
      { id: 'unknown-beat', route: 'ghost', class: 'nudge', priority: 2, when: { flag: 'ok' } },
    ];
    const unlockedState = createTestWorldState();

    expect(filterBeatsForActiveRoutes(beats, unlockedState, routes).map((b) => b.id)).toEqual([
      'common',
    ]);
    expect(
      filterBeatsForActiveRoutes(beats, unlockedState, routes, { requireRouteLocked: false }).map(
        (b) => b.id
      )
    ).toEqual(['common', 'loyal-beat']);
  });
});
