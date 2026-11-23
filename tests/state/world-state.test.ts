import { describe, expect, it } from 'vitest';
import { createQueuedRng } from '../../src/core/prng.js';
import { isErr, isOk } from '../../src/core/result.js';
import {
  STOCK_FREEFORM_PACK,
  STOCK_LIVING_WORLD_PACK,
  STOCK_SLICE_OF_LIFE_PACK,
  STOCK_TACTICAL_RPG_PACK,
} from '../../src/schema/stock-system-packs.js';
import { applyFormProfileOverlay, buildFormIndex } from '../../src/state/forms.js';
import {
  WORLD_STATE_SCHEMA_VERSION,
  type WorldState,
  cloneWorldState,
  createWorldState,
  validateWorldState,
} from '../../src/state/world-state.js';

describe('createWorldState', () => {
  it('supports Tier 0 Slice-of-Life card with zero locations and zero RPG stats', () => {
    const state = createWorldState({
      sessionId: 'sol-chat-1',
      capabilities: STOCK_SLICE_OF_LIFE_PACK.capabilities,
      player: {
        name: 'Elena',
        sections: {
          sec_personality: 'Warm, anxious perfectionist.',
        },
      },
      scene: {
        location: 'Corner Coffee Shop',
        mood: 'cozy',
      },
      characters: [
        {
          id: 'marcus',
          name: 'Marcus',
          status: 'active',
          presentInScene: true,
          locationId: null,
          formId: null,
          formGroup: null,
          sections: { sec_personality: 'Easygoing barista.' },
          customFields: {},
          abilities: [],
          goals: ['Finish art school portfolio'],
          agenda: 'Chat with Elena during morning shift',
          allegiance: 'neutral',
          mood: 'cheerful',
          traits: ['patient', 'artistic'],
        },
      ],
    });

    expect(state.schemaVersion).toBe(WORLD_STATE_SCHEMA_VERSION);
    expect(state.capabilities.spatialMode).toBe('scene_only');
    expect(state.player.progression).toBeUndefined();
    expect(state.player.resources).toBeUndefined();
    expect(state.scene.location).toBe('Corner Coffee Shop');
    expect(state.scene.locationId).toBeNull();
    expect(state.scene.presentCharacterIds).toEqual(['marcus']);
    expect(state.entities.locations).toEqual({});
    expect(state.entities.characters['marcus']?.progression).toBeUndefined();
    expect(state.entities.characters['marcus']?.resources).toBeUndefined();

    const validation = validateWorldState(state);
    expect(isOk(validation)).toBe(true);
    if (validation.ok) {
      expect(validation.value.warnings).toEqual([]);
    }
  });

  it('seeds opt-in RPG progression and resource pools when capabilities enable them', () => {
    const rpgState = createWorldState({
      sessionId: 'rpg-session-1',
      capabilities: STOCK_TACTICAL_RPG_PACK.capabilities,
      scene: { location: 'Forest Clearing' },
    });

    expect(rpgState.player.progression).toEqual({ level: 1, xp: 0 });
    expect(rpgState.player.resources).toEqual({
      hp: { current: 20, max: 20 },
      willpower: { current: 10, max: 10 },
      stamina: { current: 100, max: 100 },
    });

    const freeformState = createWorldState({
      sessionId: 'freeform-1',
      capabilities: STOCK_FREEFORM_PACK.capabilities,
    });
    expect(freeformState.player.progression).toBeUndefined();
    expect(freeformState.player.resources).toBeUndefined();
  });

  it('produces identical deterministic WorldState documents for identical inputs', () => {
    const opts = {
      sessionId: 'deterministic-seed',
      capabilities: STOCK_LIVING_WORLD_PACK.capabilities,
      rngSeed: 'fixed-campaign-seed',
      locations: [
        {
          id: 'plaza',
          name: 'Central Plaza',
          kind: 'district',
          status: 'normal',
          controllingFactionId: 'vanguard',
          connectedLocations: [],
          discovered: true,
          tags: ['hub'],
          notes: '',
        },
      ],
      factions: [
        {
          id: 'vanguard',
          name: 'Vanguard',
          side: 'hero' as const,
          status: 'active' as const,
          influence: 65,
          headquartersLocationId: 'plaza',
          goals: ['Maintain order'],
        },
      ],
      scene: { locationId: 'plaza' },
    };

    const a = createWorldState(opts);
    const b = createWorldState(opts);
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));

    const c = createWorldState({ ...opts, rngSeed: 'different-seed' });
    expect(c.meta.rngState).not.toEqual(a.meta.rngState);
  });
});

describe('cloneWorldState', () => {
  it('deep-clones nested arrays, entities, clocks, and customFields without sharing references', () => {
    const original = createWorldState({
      sessionId: 'clone-test',
      capabilities: STOCK_TACTICAL_RPG_PACK.capabilities,
      flags: { metBartender: true },
      counters: { rep: 3 },
      customFields: { nested: { items: ['key'] } },
      clocks: {
        inGameDate: '2026-05-01',
        timers: { torch: { current: 1, max: 5, tickOn: 'slot' } },
      },
      relations: {
        player: {
          aria: { affinity: 15, maxAffinity: 100, label: 'ally', tags: ['trusted'] },
        },
      },
      characters: [
        {
          id: 'aria',
          name: 'Aria',
          status: 'active',
          presentInScene: true,
          locationId: null,
          formId: null,
          formGroup: null,
          sections: { sec_strengths: ['Archery'] },
          customFields: { note: 'v1' },
          resources: { hp: { current: 18, max: 20 } },
          abilities: ['Precise Shot'],
          goals: ['Find the relic'],
          agenda: 'Scout ahead',
          allegiance: 'hero',
          mood: 'alert',
          traits: ['calm'],
        },
      ],
    });

    const cloned = cloneWorldState(original);
    cloned.flags['metBartender'] = false;
    cloned.counters['rep'] = 99;
    (cloned.customFields['nested'] as { items: string[] }).items.push('sword');
    cloned.clocks.timers['torch']!.current = 5;
    cloned.relations['player']!['aria']!.tags.push('mutated');
    cloned.entities.characters['aria']!.resources!.hp!.current = 0;
    (cloned.entities.characters['aria']!.sections['sec_strengths'] as string[]).push('Stealth');

    expect(original.flags['metBartender']).toBe(true);
    expect(original.counters['rep']).toBe(3);
    expect((original.customFields['nested'] as { items: string[] }).items).toEqual(['key']);
    expect(original.clocks.timers['torch']?.current).toBe(1);
    expect(original.relations['player']?.['aria']?.tags).toEqual(['trusted']);
    expect(original.entities.characters['aria']?.resources?.hp?.current).toBe(18);
    expect(original.entities.characters['aria']?.sections['sec_strengths']).toEqual(['Archery']);
  });
});

describe('validateWorldState', () => {
  it('safely defaults missing keys and emits BR-8 warnings without mutating input', () => {
    const partialPayload = {
      schemaVersion: 2,
      capabilities: STOCK_SLICE_OF_LIFE_PACK.capabilities,
      meta: {
        sessionId: 'legacy-save',
        turn: 4,
      },
      entities: {
        characters: {
          npc1: {
            id: 'npc1',
            name: 'Sam',
            status: 'active',
          },
        },
      },
    };
    const snapshotBefore = JSON.stringify(partialPayload);

    const res = validateWorldState(partialPayload);
    expect(isOk(res)).toBe(true);
    if (res.ok) {
      expect(res.value.warnings.length).toBeGreaterThan(0);
      expect(res.value.warnings.every((w) => w.code === 'MISSING_KEY_DEFAULTED')).toBe(true);
      expect(res.value.state.flags).toEqual({});
      expect(res.value.state.counters).toEqual({});
      expect(res.value.state.chronicle).toEqual({ events: [] });
      expect(res.value.state.turnEvents).toEqual({
        combatOutcomes: [],
        rumors: [],
        systemNotices: [],
      });
      expect(res.value.state.entities.characters['npc1']?.abilities).toEqual([]);
      expect(res.value.state.entities.characters['npc1']?.sections).toEqual({});
    }

    expect(JSON.stringify(partialPayload)).toBe(snapshotBefore);
  });

  it('enforces Tier 2 spatial cross-references for locationId, headquartersLocationId, and connectedLocations', () => {
    const base = createWorldState({
      sessionId: 'tier2-strict',
      capabilities: STOCK_LIVING_WORLD_PACK.capabilities,
      locations: [
        {
          id: 'hq',
          name: 'Vanguard HQ',
          kind: 'base',
          status: 'normal',
          controllingFactionId: 'vanguard',
          connectedLocations: ['docks'],
          discovered: true,
          tags: ['base'],
          notes: '',
        },
        {
          id: 'docks',
          name: 'Harbor Docks',
          kind: 'district',
          status: 'contested',
          controllingFactionId: null,
          connectedLocations: ['hq'],
          discovered: true,
          tags: ['waterfront'],
          notes: '',
        },
      ],
      factions: [
        {
          id: 'vanguard',
          name: 'Vanguard',
          side: 'hero',
          status: 'active',
          influence: 70,
          headquartersLocationId: 'hq',
          goals: ['Defend city'],
        },
      ],
      threats: [
        {
          id: 'threat1',
          name: 'Dockside Smugglers',
          rank: 'secondary',
          status: 'active',
          stage: 1,
          progress: 40,
          locationId: 'docks',
          sourceFactionId: null,
          agenda: 'Smuggle weapons',
        },
      ],
      characters: [
        {
          id: 'captain',
          name: 'Captain',
          status: 'active',
          presentInScene: true,
          locationId: 'hq',
          formId: null,
          formGroup: null,
          sections: {},
          customFields: {},
          abilities: [],
          goals: [],
          agenda: '',
          allegiance: 'hero',
          mood: 'steady',
          traits: [],
        },
      ],
      scene: { locationId: 'hq' },
      player: { locationId: 'hq' },
    });

    expect(isOk(validateWorldState(base))).toBe(true);

    // Corrupt multiple Tier 2 references
    const broken: WorldState = cloneWorldState(base);
    broken.player.locationId = 'missing-player-loc';
    broken.scene.locationId = 'missing-scene-loc';
    broken.entities.characters['captain']!.locationId = 'missing-char-loc';
    broken.entities.factions['vanguard']!.headquartersLocationId = 'missing-hq';
    broken.entities.threats['threat1']!.locationId = 'missing-threat-loc';
    broken.chronicle.events.push({
      id: 'ev1',
      turn: 1,
      day: 1,
      date: null,
      title: 'Skirmish',
      category: 'event',
      summary: 'Dockside clash',
      locationId: 'missing-chronicle-loc',
      involvedEntityIds: ['captain'],
      keywords: ['docks'],
    });
    broken.entities.locations['hq']!.connectedLocations.push('hq', 'missing-neighbor');

    const res = validateWorldState(broken);
    expect(isErr(res)).toBe(true);
    if (!res.ok) {
      const paths = res.error.map((e) => e.path);
      expect(paths).toContain('player.locationId');
      expect(paths).toContain('scene.locationId');
      expect(paths).toContain('entities.characters.captain.locationId');
      expect(paths).toContain('entities.factions.vanguard.headquartersLocationId');
      expect(paths).toContain('entities.threats.threat1.locationId');
      expect(paths).toContain('chronicle.events[0].locationId');
      expect(paths).toContain('entities.locations.hq.connectedLocations');
    }
  });

  it('omits location graph requirements in Tier 0 (scene_only) and rejects structural/schema errors', () => {
    const tier0 = createWorldState({
      sessionId: 'tier0-ok',
      capabilities: STOCK_SLICE_OF_LIFE_PACK.capabilities,
      factions: [
        {
          id: 'club',
          name: 'Drama Club',
          side: 'independent',
          status: 'active',
          influence: 20,
          headquartersLocationId: 'untracked-room',
          goals: [],
        },
      ],
      scene: { location: 'School Courtyard', locationId: null },
    });
    expect(isOk(validateWorldState(tier0))).toBe(true);

    // Structural errors must still fail
    expect(isErr(validateWorldState(null))).toBe(true);
    expect(isErr(validateWorldState({ ...tier0, schemaVersion: 1 }))).toBe(true);

    const badChar = cloneWorldState(tier0);
    badChar.entities.characters['bad'] = {
      id: 'wrong-id',
      name: 'Bad',
      status: 'bogus' as never,
      presentInScene: false,
      locationId: null,
      formId: null,
      formGroup: null,
      sections: {},
      customFields: {},
      resources: { hp: { current: 50, max: 10 } },
      abilities: [],
      goals: [],
      agenda: '',
      allegiance: 'neutral',
      mood: 'neutral',
      traits: [],
    };
    const badRes = validateWorldState(badChar);
    expect(isErr(badRes)).toBe(true);
    if (!badRes.ok) {
      expect(badRes.error.some((e) => e.code === 'ID_MISMATCH')).toBe(true);
      expect(badRes.error.some((e) => e.code === 'INVALID_ENUM')).toBe(true);
      expect(badRes.error.some((e) => e.code === 'OUT_OF_RANGE')).toBe(true);
    }

    // Queued RNG validation and invalid timer repeat rejection
    const queuedState = createWorldState({
      sessionId: 'queued-rng',
      capabilities: STOCK_FREEFORM_PACK.capabilities,
      rngState: createQueuedRng([0.25, 0.75], 'fallback-seed'),
    });
    expect(isOk(validateWorldState(queuedState))).toBe(true);

    const invalidTimerState = cloneWorldState(queuedState) as unknown as Record<string, unknown>;
    (invalidTimerState['clocks'] as Record<string, unknown>)['timers'] = {
      bomb: { current: 1, max: 3, tickOn: 'turn', repeat: 'yes' },
    };
    const invalidTimerRes = validateWorldState(invalidTimerState);
    expect(isErr(invalidTimerRes)).toBe(true);
    if (!invalidTimerRes.ok) {
      expect(invalidTimerRes.error.some((e) => e.path === 'clocks.timers.bomb.repeat')).toBe(true);
    }
  });

  it('integrates form profile overlay cleanly without corrupting WorldState relations or stats', () => {
    const formIndex = buildFormIndex([
      {
        id: 'hero_civ',
        formGroup: 'hero_group',
        characterId: 'hero',
        displayName: 'Alex Mercer',
        abilities: ['Stealth'],
        traits: ['quiet'],
      },
      {
        id: 'hero_cape',
        formGroup: 'hero_group',
        characterId: 'hero',
        displayName: 'Solaris',
        abilities: ['Solar Flare'],
        traits: ['radiant'],
      },
    ]);

    const state = createWorldState({
      sessionId: 'form-integration',
      capabilities: STOCK_TACTICAL_RPG_PACK.capabilities,
      relations: {
        player: {
          hero: { affinity: 45, maxAffinity: 100, label: 'confidant', tags: ['ally'] },
        },
      },
      characters: [
        {
          id: 'hero',
          name: 'Alex Mercer',
          status: 'active',
          presentInScene: true,
          locationId: null,
          formId: 'hero_civ',
          formGroup: 'hero_group',
          sections: { sec_body: 'Plain jacket' },
          customFields: {},
          progression: { level: 3, xp: 400 },
          resources: { hp: { current: 19, max: 30 } },
          corruption: { stage: 0, progress: 0, source: null },
          abilities: ['Stealth'],
          goals: ['Protect district'],
          agenda: 'Patrol',
          allegiance: 'hero',
          mood: 'determined',
          traits: ['quiet'],
        },
      ],
    });

    const next = cloneWorldState(state);
    next.entities.characters['hero'] = applyFormProfileOverlay(
      next.entities.characters['hero']!,
      'hero_cape',
      formIndex
    );

    expect(isOk(validateWorldState(next))).toBe(true);
    expect(next.entities.characters['hero']?.name).toBe('Solaris');
    expect(next.entities.characters['hero']?.resources?.hp).toEqual({ current: 19, max: 30 });
    expect(next.entities.characters['hero']?.progression).toEqual({ level: 3, xp: 400 });
    expect(next.relations['player']?.['hero']?.affinity).toBe(45);
  });
});
