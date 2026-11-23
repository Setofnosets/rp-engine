import { describe, expect, it } from 'vitest';
import { isErr, isOk } from '../../src/core/result.js';
import {
  type CompiledFieldPolicy,
  type CompiledTrackerSchema,
  compileActiveTrackerSchema,
} from '../../src/schema/dynamic-schema-compiler.js';
import { STOCK_TACTICAL_RPG_PACK } from '../../src/schema/stock-system-packs.js';
import type { GameSystemModule } from '../../src/schema/tracker-module.js';
import { appendAuditEntries, createAuditLog, queryAuditLog } from '../../src/state/audit-log.js';
import { type FormDefinition, buildFormIndex } from '../../src/state/forms.js';
import { type PatchBatch } from '../../src/state/patch.js';
import { applyPatchBatch } from '../../src/state/reducer.js';
import {
  type WorldState,
  cloneWorldState,
  createWorldState,
  validateWorldState,
} from '../../src/state/world-state.js';

function makeTestState(): WorldState {
  return createWorldState({
    sessionId: 'reducer-test-session',
    capabilities: {
      ...STOCK_TACTICAL_RPG_PACK.capabilities,
      spatialMode: 'emergent',
      factions: true,
      relationships: true,
      chronicle: true,
    },
    turn: 1,
    clocks: {
      turn: 1,
      storyTurn: 1,
      day: 1,
      inGameDate: '2026-06-15',
      slot: 'morning',
      timers: {
        ritual: { current: 1, max: 3, tickOn: 'slot' },
      },
    },
    player: {
      id: 'player',
      name: 'Elena',
      characterId: 'elena',
      locationId: 'courtyard',
      inventory: {
        items: { ration: 2 },
        currency: { gold: 10 },
      },
      customFields: {
        reputation: 5,
      },
      sections: {
        sec_appearance: 'Travel-worn cloak.',
        sec_inventory_notes: ['Silver locket'],
      },
    },
    scene: {
      location: 'Outer Courtyard',
      locationId: 'courtyard',
      mood: 'tense',
      pacing: 'measured',
      presentCharacterIds: ['elena', 'castellan'],
    },
    flags: {
      met_castellan: false,
    },
    counters: {
      clues: 1,
    },
    customFields: {
      sanity: 80,
      alert_level: 'low',
    },
    relations: {
      player: {
        castellan: { affinity: 10, maxAffinity: 100, label: 'wary', tags: ['noble'] },
      },
    },
    characters: [
      {
        id: 'elena',
        name: 'Elena',
        status: 'active',
        presentInScene: true,
        locationId: 'courtyard',
        formId: 'elena_human',
        formGroup: 'elena_forms',
        sections: { sec_appearance: 'Travel-worn cloak.' },
        customFields: { stress: 15 },
        progression: { level: 2, xp: 100, className: 'Rogue' },
        resources: {
          hp: { current: 18, max: 20 },
          willpower: { current: 8, max: 10 },
        },
        abilities: ['Lockpick'],
        goals: ['Infiltrate keep'],
        agenda: 'Observe guards',
        allegiance: 'hero',
        mood: 'focused',
        traits: ['nimble'],
      },
      {
        id: 'castellan',
        name: 'Castellan Vance',
        status: 'active',
        presentInScene: true,
        locationId: 'courtyard',
        formId: null,
        formGroup: null,
        sections: { sec_personality: 'Stern and calculating.' },
        customFields: { suspicion: 25 },
        abilities: ['Command'],
        goals: ['Guard the keep'],
        agenda: 'Question visitors',
        allegiance: 'neutral',
        mood: 'suspicious',
        traits: ['vigilant'],
      },
    ],
    factions: [
      {
        id: 'iron_guard',
        name: 'Iron Guard',
        side: 'neutral',
        status: 'active',
        influence: 60,
        headquartersLocationId: 'courtyard',
        goals: ['Hold the border'],
      },
    ],
    threats: [
      {
        id: 'blight',
        name: 'Ash Blight',
        rank: 'main',
        status: 'active',
        stage: 1,
        progress: 20,
        locationId: 'courtyard',
        sourceFactionId: null,
        agenda: 'Spread through the valley',
      },
    ],
    locations: [
      {
        id: 'courtyard',
        name: 'Outer Courtyard',
        kind: 'landmark',
        status: 'normal',
        controllingFactionId: 'iron_guard',
        connectedLocations: [],
        discovered: true,
        tags: ['fortress'],
        notes: 'Flagstone entry yard',
      },
    ],
  });
}

function makeCompiledSchema(): CompiledTrackerSchema {
  const customModule: GameSystemModule = {
    id: 'psyche',
    name: 'Psyche & Alert',
    enabled: true,
    scope: 'session',
    target: 'global',
    effectOwner: 'hybrid',
    cadence: 'every_turn',
    fields: {
      sanity: {
        type: 'meter',
        min: 0,
        max: 100,
        default: 80,
        writableByTracker: true,
        confirmPolicy: 'auto',
      },
      alert_level: {
        type: 'enum',
        options: ['low', 'guarded', 'high'],
        default: 'low',
        writableByTracker: true,
        confirmPolicy: 'auto',
      },
      secret_verdict: {
        type: 'string',
        maxLength: 20,
        default: '',
        writableByTracker: true,
        confirmPolicy: 'always_confirm',
      },
      rumor_tags: {
        type: 'string_list',
        maxItems: 2,
        default: [],
        writableByTracker: true,
        confirmPolicy: 'auto',
      },
      pact_sealed: {
        type: 'boolean',
        default: false,
        writableByTracker: true,
        confirmPolicy: 'batch_confirm',
      },
      forbidden_seal: {
        type: 'counter',
        min: 0,
        max: 5,
        default: 0,
        writableByTracker: false,
        confirmPolicy: 'locked',
      },
    },
    trackerInstruction: 'Track sanity and alert.',
    narratorRule: 'Respect sanity state.',
    ui: { widget: 'bar', order: 1 },
  };

  return compileActiveTrackerSchema(
    {
      capabilities: STOCK_TACTICAL_RPG_PACK.capabilities,
      pcCoreSections: [
        {
          id: 'sec_appearance',
          name: 'Appearance',
          description: 'Visible look',
          icon: 'user',
          color: '#64748b',
          fieldType: 'prose',
          writableByTracker: true,
          confirmPolicy: 'auto',
          cadence: 'every_turn',
        },
      ],
      npcCoreSections: [
        {
          id: 'sec_personality',
          name: 'Personality',
          description: 'Core personality',
          icon: 'brain',
          color: '#64748b',
          fieldType: 'prose',
          writableByTracker: false,
          confirmPolicy: 'locked',
          cadence: 'manual_only',
        },
      ],
      gameSystems: [customModule],
      blockOrder: ['scene'],
      syspromptSectionOrder: ['scene'],
    },
    { turn: 1, clockAdvancedThisTurn: false, combatEndedThisTurn: false }
  );
}

describe('applyPatchBatch', () => {
  it('enforces all-or-nothing BR-2 rollback when 4 valid ops precede 1 invalid op', () => {
    const initial = makeTestState();
    const snapshotBefore = cloneWorldState(initial);

    const batch: PatchBatch = {
      eventId: 'evt-rollback',
      source: 'engine',
      operations: [
        { op: 'set', path: 'flags.met_castellan', value: true },
        { op: 'increment', path: 'counters.clues', delta: 3 },
        { op: 'set', path: 'scene.mood', value: 'electric' },
        { op: 'custom_field_patch', target: 'global', fieldId: 'sanity', value: 60 },
        {
          op: 'entity_patch',
          collection: 'characters',
          entityId: 'nonexistent_npc',
          patch: { status: 'dead' },
        },
      ],
    };

    const result = applyPatchBatch(initial, batch, { compiledSchema: makeCompiledSchema() });
    expect(isErr(result)).toBe(true);
    if (!result.ok) {
      expect(result.error[0]?.code).toBe('ENTITY_NOT_FOUND');
    }

    // Input state MUST remain completely untouched
    expect(initial).toEqual(snapshotBefore);
  });

  it('rolls back on NaN delta, invalid path, or illegal form transform without mutating input state', () => {
    const initial = makeTestState();
    const snapshot = cloneWorldState(initial);

    const forms: FormDefinition[] = [
      {
        id: 'elena_human',
        formGroup: 'elena_forms',
        characterId: 'elena',
        displayName: 'Elena',
        legalTargets: ['elena_shadow'],
      },
      {
        id: 'elena_shadow',
        formGroup: 'elena_forms',
        characterId: 'elena',
        displayName: 'Shadow Elena',
        legalTargets: ['elena_human'],
      },
      {
        id: 'elena_locked',
        formGroup: 'elena_forms',
        characterId: 'elena',
        displayName: 'Astral Elena',
      },
    ];
    const formIndex = buildFormIndex(forms);

    const nanBatch: PatchBatch = {
      eventId: 'evt-nan',
      source: 'engine',
      operations: [
        { op: 'set', path: 'flags.met_castellan', value: true },
        { op: 'increment', path: 'counters.clues', delta: Number.NaN },
      ],
    };
    expect(isErr(applyPatchBatch(initial, nanBatch))).toBe(true);
    expect(initial).toEqual(snapshot);

    const badPathBatch: PatchBatch = {
      eventId: 'evt-bad-path',
      source: 'engine',
      operations: [
        { op: 'set', path: 'flags.met_castellan', value: true },
        { op: 'set', path: 'scene.doesNotExist', value: 'x' },
      ],
    };
    expect(isErr(applyPatchBatch(initial, badPathBatch))).toBe(true);
    expect(initial).toEqual(snapshot);

    const illegalFormBatch: PatchBatch = {
      eventId: 'evt-bad-form',
      source: 'engine',
      operations: [
        { op: 'set', path: 'flags.met_castellan', value: true },
        { op: 'form_transform', characterId: 'elena', targetFormId: 'elena_locked' },
      ],
    };
    const formErr = applyPatchBatch(initial, illegalFormBatch, { formIndex });
    expect(isErr(formErr)).toBe(true);
    if (!formErr.ok) {
      expect(formErr.error[0]?.code).toBe('ILLEGAL_FORM_TRANSFORM');
    }
    expect(initial).toEqual(snapshot);

    // Legal form transform succeeds and preserves live resources
    const legalFormBatch: PatchBatch = {
      eventId: 'evt-good-form',
      source: 'engine',
      operations: [{ op: 'form_transform', characterId: 'elena', targetFormId: 'elena_shadow' }],
    };
    const formOk = applyPatchBatch(initial, legalFormBatch, { formIndex });
    expect(isOk(formOk)).toBe(true);
    if (formOk.ok) {
      expect(formOk.value.nextState.entities.characters['elena']?.formId).toBe('elena_shadow');
      expect(formOk.value.nextState.entities.characters['elena']?.name).toBe('Shadow Elena');
      expect(formOk.value.nextState.entities.characters['elena']?.resources?.['hp']).toEqual({
        current: 18,
        max: 20,
      });
      expect(formOk.value.changedPaths.has('entities.characters.elena.formId')).toBe(true);
    }
    expect(initial).toEqual(snapshot);
  });

  it('enforces dynamic field bounds clamping (meter 0..100), enum/maxLength/maxItems, and type rejection', () => {
    const initial = makeTestState();
    const compiledSchema = makeCompiledSchema();

    // Meter clamping 150 -> 100 and -30 -> 0
    const clampRes = applyPatchBatch(
      initial,
      {
        eventId: 'evt-clamp',
        source: 'engine',
        operations: [
          { op: 'set', path: 'customFields.sanity', value: 150 },
          { op: 'custom_field_patch', target: 'global', fieldId: 'alert_level', value: 'high' },
          { op: 'set', path: 'customFields.rumor_tags', value: ['a', 'b'] },
        ],
      },
      { compiledSchema }
    );
    expect(isOk(clampRes)).toBe(true);
    if (clampRes.ok) {
      expect(clampRes.value.nextState.customFields['sanity']).toBe(100);
      expect(clampRes.value.nextState.customFields['alert_level']).toBe('high');
      expect(clampRes.value.changedPaths.has('customFields.sanity')).toBe(true);
      expect(clampRes.value.changedPaths.has('customFields.alert_level')).toBe(true);
      expect(clampRes.value.auditEntries[0]?.newValue).toBe(100);

      // Increment past upper bound clamps again
      const incRes = applyPatchBatch(
        clampRes.value.nextState,
        {
          eventId: 'evt-inc-clamp',
          source: 'tracker',
          operations: [{ op: 'increment', path: 'customFields.sanity', delta: -140 }],
        },
        { compiledSchema }
      );
      expect(isOk(incRes)).toBe(true);
      if (incRes.ok) {
        expect(incRes.value.nextState.customFields['sanity']).toBe(0);
      }
    }

    // Type rejection ("bad" on meter)
    const badMeterRes = applyPatchBatch(
      initial,
      {
        eventId: 'evt-bad-meter',
        source: 'tracker',
        operations: [{ op: 'set', path: 'customFields.sanity', value: 'bad' }],
      },
      { compiledSchema }
    );
    expect(isErr(badMeterRes)).toBe(true);

    // Invalid enum option
    const badEnumRes = applyPatchBatch(
      initial,
      {
        eventId: 'evt-bad-enum',
        source: 'tracker',
        operations: [{ op: 'set', path: 'customFields.alert_level', value: 'panic' }],
      },
      { compiledSchema }
    );
    expect(isErr(badEnumRes)).toBe(true);

    // String exceeding maxLength
    const badLengthRes = applyPatchBatch(
      initial,
      {
        eventId: 'evt-bad-len',
        source: 'engine',
        operations: [
          {
            op: 'set',
            path: 'customFields.secret_verdict',
            value: 'this string definitely exceeds twenty characters',
          },
        ],
      },
      { compiledSchema }
    );
    expect(isErr(badLengthRes)).toBe(true);

    // String list exceeding maxItems
    const badItemsRes = applyPatchBatch(
      initial,
      {
        eventId: 'evt-bad-items',
        source: 'tracker',
        operations: [
          { op: 'set', path: 'customFields.rumor_tags', value: ['one', 'two', 'three'] },
        ],
      },
      { compiledSchema }
    );
    expect(isErr(badItemsRes)).toBe(true);

    // Float on integer counter
    const badCounterRes = applyPatchBatch(
      initial,
      {
        eventId: 'evt-bad-counter',
        source: 'engine',
        operations: [{ op: 'set', path: 'customFields.forbidden_seal', value: 1.5 }],
      },
      { compiledSchema }
    );
    expect(isErr(badCounterRes)).toBe(true);
  });

  it('enforces tracker permission gate: blocked on route_lock, hard flags, and locked fields; diverted on always_confirm/batch_confirm; allowed on auto', () => {
    const initial = makeTestState();
    const compiledSchema = makeCompiledSchema();

    const batch: PatchBatch = {
      eventId: 'evt-tracker-gate',
      source: 'tracker',
      operations: [
        // Allowed: auto
        { op: 'set', path: 'customFields.sanity', value: 72 },
        // Allowed: auto section
        { op: 'section_patch', target: 'player', sectionId: 'sec_appearance', value: 'Muddy boots.' },
        // Diverted: always_confirm
        { op: 'custom_field_patch', target: 'global', fieldId: 'secret_verdict', value: 'Guilty' },
        // Diverted: batch_confirm
        { op: 'set', path: 'customFields.pact_sealed', value: true },
        // Rejected: locked field in fieldPolicyMap
        { op: 'set', path: 'customFields.forbidden_seal', value: 3 },
        // Rejected: engine-owned progression/resource locked field
        { op: 'set', path: 'entities.characters.elena.resources.hp.current', value: 20 },
        // Rejected: locked NPC section
        {
          op: 'section_patch',
          target: { characterId: 'castellan' },
          sectionId: 'sec_personality',
          value: 'Friendly now.',
        },
        // Rejected: hard plot guard on route_lock
        { op: 'route_lock', routeId: 'dark_pact', lockFlag: 'route_dark_pact' },
        // Rejected: hard plot guard on flags.route_*
        { op: 'set', path: 'flags.route_secret_ending', value: true },
      ],
    };

    const res = applyPatchBatch(initial, batch, { compiledSchema, auditSeqStart: 10 });
    expect(isOk(res)).toBe(true);
    if (!res.ok) {
      return;
    }

    const out = res.value;
    // Allowed ops committed
    expect(out.nextState.customFields['sanity']).toBe(72);
    expect(out.nextState.player.sections['sec_appearance']).toBe('Muddy boots.');
    expect(out.changedPaths).toEqual(new Set(['customFields.sanity', 'player.sections.sec_appearance']));

    // Pending confirmations diverted without mutating nextState
    expect(out.pendingConfirmations).toHaveLength(2);
    expect(out.nextState.customFields['secret_verdict']).toBeUndefined();
    expect(out.nextState.customFields['pact_sealed']).toBeUndefined();

    // Rejected ops blocked without mutating nextState
    expect(out.rejectedOperations).toHaveLength(5);
    expect(out.nextState.customFields['forbidden_seal']).toBeUndefined();
    expect(out.nextState.entities.characters['elena']?.resources?.['hp']?.current).toBe(18);
    expect(out.nextState.entities.characters['castellan']?.sections['sec_personality']).toBe(
      'Stern and calculating.'
    );
    expect(out.nextState.flags['route_dark_pact']).toBeUndefined();
    expect(out.nextState.flags['route_secret_ending']).toBeUndefined();

    // Audit log reflects all 9 operations with monotonic seq starting at 10
    const log = appendAuditEntries(createAuditLog(), out.auditEntries);
    expect(log.entries.map((e) => e.timestampSeq)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18]);
    expect(queryAuditLog(log, { status: 'committed' })).toHaveLength(2);
    expect(queryAuditLog(log, { status: 'pending_confirmation' })).toHaveLength(2);
    expect(queryAuditLog(log, { status: 'rejected' })).toHaveLength(5);
  });

  it('permits flags.route_* for tracker ONLY when explicitly marked writable in fieldPolicyMap, and allows engine route_lock', () => {
    const initial = makeTestState();
    const compiledSchema = makeCompiledSchema();
    const explicitRoutePolicy: CompiledFieldPolicy = {
      pathPattern: 'flags.route_mercy',
      spec: {
        type: 'boolean',
        default: false,
        writableByTracker: true,
        confirmPolicy: 'auto',
      },
      moduleId: 'routes',
      writableByTracker: true,
      confirmPolicy: 'auto',
    };
    compiledSchema.fieldPolicyMap.set('flags.route_mercy', explicitRoutePolicy);

    const trackerRes = applyPatchBatch(
      initial,
      {
        eventId: 'evt-route-allow',
        source: 'tracker',
        operations: [{ op: 'set', path: 'flags.route_mercy', value: true }],
      },
      { compiledSchema }
    );
    expect(isOk(trackerRes)).toBe(true);
    if (trackerRes.ok) {
      expect(trackerRes.value.nextState.flags['route_mercy']).toBe(true);
      expect(trackerRes.value.rejectedOperations).toHaveLength(0);
    }

    const engineRes = applyPatchBatch(
      initial,
      {
        eventId: 'evt-engine-route',
        source: 'beat',
        operations: [{ op: 'route_lock', routeId: 'mercy_path', lockFlag: 'route_mercy_locked' }],
      },
      { compiledSchema }
    );
    expect(isOk(engineRes)).toBe(true);
    if (engineRes.ok) {
      expect(engineRes.value.nextState.flags['route_mercy_locked']).toBe(true);
      expect(engineRes.value.changedPaths.has('flags.route_mercy_locked')).toBe(true);
    }
  });

  it('handles emergent_location_visit across Tier 0, Tier 1, and Tier 2 spatial modes', () => {
    // Tier 1 emergent
    const t1State = makeTestState();
    const t1Res = applyPatchBatch(t1State, {
      eventId: 'evt-visit-t1',
      source: 'engine',
      operations: [{ op: 'emergent_location_visit', locationName: 'Lantern Alley' }],
    });
    expect(isOk(t1Res)).toBe(true);
    if (t1Res.ok) {
      expect(t1Res.value.nextState.scene.location).toBe('Lantern Alley');
      expect(t1Res.value.nextState.scene.locationId).toBe('lantern-alley');
      expect(t1Res.value.nextState.entities.locations['lantern-alley']?.connectedLocations).toEqual([
        'courtyard',
      ]);
      expect(t1Res.value.changedPaths.has('scene.location')).toBe(true);
      expect(t1Res.value.changedPaths.has('scene.locationId')).toBe(true);
    }

    // Tier 0 scene_only
    const t0State = createWorldState({
      sessionId: 't0',
      scene: { location: 'Cafe' },
    });
    const t0Res = applyPatchBatch(t0State, {
      eventId: 'evt-visit-t0',
      source: 'engine',
      operations: [{ op: 'emergent_location_visit', locationName: 'Bookshop' }],
    });
    expect(isOk(t0Res)).toBe(true);
    if (t0Res.ok) {
      expect(t0Res.value.nextState.scene.location).toBe('Bookshop');
      expect(t0Res.value.nextState.scene.locationId).toBeNull();
      expect(t0Res.value.nextState.entities.locations).toEqual({});
    }

    // Tier 2 authored_graph rejects unreachable/unknown location
    const t2State = createWorldState({
      sessionId: 't2',
      capabilities: { ...STOCK_TACTICAL_RPG_PACK.capabilities, spatialMode: 'authored_graph' },
      locations: [
        {
          id: 'gate',
          name: 'City Gate',
          kind: 'district',
          status: 'normal',
          controllingFactionId: null,
          connectedLocations: ['market'],
          discovered: true,
          tags: [],
          notes: '',
        },
        {
          id: 'market',
          name: 'Market Square',
          kind: 'district',
          status: 'normal',
          controllingFactionId: null,
          connectedLocations: ['gate'],
          discovered: false,
          tags: [],
          notes: '',
        },
      ],
      scene: { locationId: 'gate' },
    });

    const badT2 = applyPatchBatch(t2State, {
      eventId: 'evt-visit-t2-bad',
      source: 'engine',
      operations: [{ op: 'emergent_location_visit', locationName: 'Hidden Citadel' }],
    });
    expect(isErr(badT2)).toBe(true);

    const goodT2 = applyPatchBatch(t2State, {
      eventId: 'evt-visit-t2-ok',
      source: 'engine',
      operations: [{ op: 'emergent_location_visit', locationName: 'market' }],
    });
    expect(isOk(goodT2)).toBe(true);
    if (goodT2.ok) {
      expect(goodT2.value.nextState.scene.locationId).toBe('market');
      expect(goodT2.value.nextState.scene.location).toBe('Market Square');
      expect(goodT2.value.nextState.entities.locations['market']?.discovered).toBe(true);
    }
  });

  it('handles chronicle_append deduplication by title, clock ops, push/remove/clamp, and entity_patch', () => {
    const initial = makeTestState();

    const res1 = applyPatchBatch(initial, {
      eventId: 'evt-multi-1',
      source: 'engine',
      operations: [
        {
          op: 'chronicle_append',
          entry: {
            title: 'Arrival at Keep',
            category: 'event',
            summary: 'Entered the outer courtyard.',
            locationId: 'courtyard',
            involvedEntityIds: ['elena'],
            keywords: ['arrival'],
          },
        },
        { op: 'push', path: 'entities.characters.elena.abilities', value: 'Smoke Bomb' },
        { op: 'remove', path: 'entities.characters.elena.traits', value: 'nimble' },
        { op: 'increment', path: 'entities.characters.elena.resources.hp.current', delta: 10 },
        { op: 'clamp', path: 'counters.clues', min: 0, max: 0 },
        {
          op: 'entity_patch',
          collection: 'characters',
          entityId: 'castellan',
          patch: { status: 'captured', mood: 'furious' },
        },
        { op: 'clock_advance', mechanicalTurns: 1, storySlots: 4 },
      ],
    });

    expect(isOk(res1)).toBe(true);
    if (!res1.ok) {
      return;
    }

    const s1 = res1.value.nextState;
    expect(s1.chronicle.events).toHaveLength(1);
    expect(s1.chronicle.events[0]?.turn).toBe(1);
    expect(s1.chronicle.events[0]?.day).toBe(1);
    expect(s1.chronicle.events[0]?.date).toBe('2026-06-15');
    expect(s1.entities.characters['elena']?.abilities).toEqual(['Lockpick', 'Smoke Bomb']);
    expect(s1.entities.characters['elena']?.traits).toEqual([]);
    // Resource pool current clamped to max=20
    expect(s1.entities.characters['elena']?.resources?.['hp']?.current).toBe(20);
    expect(s1.counters['clues']).toBe(0);
    expect(s1.entities.characters['castellan']?.status).toBe('captured');
    expect(s1.entities.characters['castellan']?.mood).toBe('furious');
    expect(res1.value.changedPaths.has('entities.characters.castellan.status')).toBe(true);
    expect(res1.value.daysElapsed).toBe(1);
    expect(res1.value.slotsElapsed).toBe(4);
    expect(res1.value.expiredTimers).toEqual(['ritual']);
    expect(s1.clocks.day).toBe(2);
    expect(s1.clocks.inGameDate).toBe('2026-06-16');
    expect(s1.meta.turn).toBe(2);
    expect(res1.value.changedPaths.has('clocks.day')).toBe(true);

    // Deduplicate chronicle entry by title & test clock_hold / clock_release
    const res2 = applyPatchBatch(s1, {
      eventId: 'evt-multi-2',
      source: 'engine',
      operations: [
        {
          op: 'chronicle_append',
          entry: {
            title: '  arrival at keep  ',
            category: 'event',
            summary: 'Entered courtyard and captured the Castellan.',
            locationId: 'courtyard',
            involvedEntityIds: ['castellan'],
            keywords: ['siege'],
          },
        },
        { op: 'clock_hold', reason: 'cutscene' },
        { op: 'clock_advance', mechanicalTurns: 1, storySlots: 2 },
        { op: 'clock_release' },
      ],
    });

    expect(isOk(res2)).toBe(true);
    if (!res2.ok) {
      return;
    }

    expect(res2.value.nextState.chronicle.events).toHaveLength(1);
    expect(res2.value.nextState.chronicle.events[0]?.involvedEntityIds).toEqual([
      'elena',
      'castellan',
    ]);
    expect(res2.value.nextState.chronicle.events[0]?.keywords).toEqual(['arrival', 'siege']);
    expect(res2.value.daysElapsed).toBe(0);
    expect(res2.value.slotsElapsed).toBe(0);
    expect(res2.value.nextState.clocks.held).toBe(false);
    expect(res2.value.nextState.clocks.turn).toBe(3);
  });

  it('guards against prototype pollution across paths, dynamic keys, and JSON payloads', () => {
    const initial = makeTestState();

    const maliciousPath = applyPatchBatch(initial, {
      eventId: 'evt-proto-1',
      source: 'engine',
      operations: [{ op: 'set', path: 'flags.__proto__', value: true }],
    });
    expect(isErr(maliciousPath)).toBe(true);

    const maliciousConstructor = applyPatchBatch(initial, {
      eventId: 'evt-proto-2',
      source: 'engine',
      operations: [
        { op: 'custom_field_patch', target: 'global', fieldId: 'constructor', value: 'bad' },
      ],
    });
    expect(isErr(maliciousConstructor)).toBe(true);

    const maliciousJsonPayload = JSON.parse('{"__proto__": {"polluted": true}}') as Record<
      string,
      unknown
    >;
    const maliciousValue = applyPatchBatch(initial, {
      eventId: 'evt-proto-3',
      source: 'engine',
      operations: [{ op: 'set', path: 'customFields.payload', value: maliciousJsonPayload }],
    });
    expect(isErr(maliciousValue)).toBe(true);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('produces valid WorldState outputs, isolates caller payloads, and is 100% deterministic', () => {
    const initial = makeTestState();
    const tags = ['secret', 'coded'];
    const batch: PatchBatch = {
      eventId: 'evt-det',
      source: 'engine',
      operations: [
        { op: 'set', path: 'customFields.dossier', value: { tags } },
        { op: 'set', path: 'relations.player.castellan.affinity', value: 25 },
        { op: 'entity_patch', collection: 'factions', entityId: 'iron_guard', patch: { influence: 150 } },
        { op: 'entity_patch', collection: 'threats', entityId: 'blight', patch: { progress: -10 } },
        {
          op: 'chronicle_append',
          entry: {
            title: 'Keep Secure',
            category: 'world',
            summary: 'Iron Guard reinforced the keep.',
            locationId: 'courtyard',
            involvedEntityIds: ['iron_guard'],
            keywords: ['guard'],
          },
        },
      ],
    };

    const resA = applyPatchBatch(initial, batch, { compiledSchema: makeCompiledSchema() });
    const resB = applyPatchBatch(initial, batch, { compiledSchema: makeCompiledSchema() });
    expect(isOk(resA)).toBe(true);
    expect(isOk(resB)).toBe(true);
    if (!resA.ok || !resB.ok) {
      return;
    }

    expect(resA.value.nextState).toEqual(resB.value.nextState);
    expect(resA.value.auditEntries).toEqual(resB.value.auditEntries);
    expect([...resA.value.changedPaths]).toEqual([...resB.value.changedPaths]);
    expect(resA.value.nextState.entities.factions['iron_guard']?.influence).toBe(100);
    expect(resA.value.nextState.entities.threats['blight']?.progress).toBe(0);

    // Mutate caller payload after commit
    tags.push('mutated-after-commit');
    expect((resA.value.nextState.customFields['dossier'] as { tags: string[] }).tags).toEqual([
      'secret',
      'coded',
    ]);

    // Output WorldState remains valid under strict validateWorldState
    const validated = validateWorldState(resA.value.nextState);
    expect(isOk(validated)).toBe(true);
    if (validated.ok) {
      expect(validated.value.warnings).toEqual([]);
    }
  });
});
