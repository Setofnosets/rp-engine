import { describe, expect, it } from 'vitest';
import {
  type BeatRoleSpec,
  bindBeatRoles,
  interpolateBeatTemplate,
} from '../../src/beats/role-binder.js';
import { type WorldState, createWorldState } from '../../src/state/world-state.js';

function createRoleTestState(): WorldState {
  return createWorldState({
    sessionId: 'role-test-session',
    capabilities: {
      spatialMode: 'authored_graph',
      combatMode: 'disabled',
      progression: 'rpg_levels',
      clocks: 'full_sim',
      factions: true,
      beats: true,
      relationships: true,
      chronicle: true,
    },
    scene: {
      location: 'Central Plaza',
      locationId: 'central-plaza',
      presentCharacterIds: ['bren'],
    },
    locations: {
      'central-plaza': {
        id: 'central-plaza',
        name: 'Central Plaza',
        kind: 'district',
        status: 'normal',
        controllingFactionId: 'vanguard',
        connectedLocations: ['harbor-district'],
        discovered: true,
        tags: ['hub'],
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
        tags: ['docks'],
        notes: '',
      },
      'ruined-keep': {
        id: 'ruined-keep',
        name: 'Ruined Keep',
        kind: 'dungeon',
        status: 'destroyed',
        controllingFactionId: null,
        connectedLocations: [],
        discovered: false,
        tags: [],
        notes: '',
      },
    },
    factions: {
      vanguard: {
        id: 'vanguard',
        name: 'The Vanguard',
        side: 'hero',
        status: 'active',
        influence: 70,
        headquartersLocationId: 'central-plaza',
        goals: ['protect'],
      },
      syndicate: {
        id: 'syndicate',
        name: 'Iron Syndicate',
        side: 'villain',
        status: 'underground',
        influence: 45,
        headquartersLocationId: 'harbor-district',
        goals: ['smuggle'],
      },
      old_order: {
        id: 'old_order',
        name: 'Old Order',
        side: 'neutral',
        status: 'disbanded',
        influence: 0,
        headquartersLocationId: null,
        goals: [],
      },
    },
    characters: {
      aria: {
        id: 'aria',
        name: 'Aria Voss',
        status: 'dead',
        presentInScene: false,
        locationId: 'harbor-district',
        formId: null,
        formGroup: null,
        sections: {},
        customFields: { rank: 3 },
        progression: { level: 6, xp: 1000 },
        abilities: [],
        goals: [],
        agenda: 'guard',
        allegiance: 'vanguard',
        mood: 'grim',
        traits: ['stealthy', 'courier'],
      },
      adam: {
        id: 'adam',
        name: 'Adam Rook',
        status: 'active',
        presentInScene: false,
        locationId: 'harbor-district',
        formId: null,
        formGroup: null,
        sections: {},
        customFields: { rank: 2 },
        progression: { level: 4, xp: 400 },
        abilities: [],
        goals: [],
        agenda: 'patrol',
        allegiance: 'vanguard',
        mood: 'alert',
        traits: ['stealthy', 'courier'],
      },
      bren: {
        id: 'bren',
        name: 'Bren Hale',
        status: 'active',
        presentInScene: true,
        locationId: 'central-plaza',
        formId: null,
        formGroup: null,
        sections: {},
        customFields: { rank: 1 },
        progression: { level: 3, xp: 250 },
        abilities: [],
        goals: [],
        agenda: 'scout',
        allegiance: 'vanguard',
        mood: 'eager',
        traits: ['courier'],
      },
      cora: {
        id: 'cora',
        name: 'Cora Vale',
        status: 'active',
        presentInScene: false,
        locationId: 'central-plaza',
        formId: null,
        formGroup: null,
        sections: {},
        customFields: { rank: 4 },
        progression: { level: 5, xp: 800 },
        abilities: [],
        goals: [],
        agenda: 'intel',
        allegiance: 'vanguard',
        mood: 'calm',
        traits: ['stealthy', 'courier'],
      },
      dax: {
        id: 'dax',
        name: 'Dax Mercer',
        status: 'active',
        presentInScene: false,
        locationId: 'central-plaza',
        formId: null,
        formGroup: null,
        sections: {},
        customFields: { rank: 4 },
        progression: { level: 5, xp: 800 },
        abilities: [],
        goals: [],
        agenda: 'intel',
        allegiance: 'vanguard',
        mood: 'calm',
        traits: ['stealthy', 'courier'],
      },
      elena: {
        id: 'elena',
        name: 'Elena $Price',
        status: 'active',
        presentInScene: true,
        locationId: 'central-plaza',
        formId: null,
        formGroup: null,
        sections: {},
        customFields: { rank: 5 },
        progression: { level: 7, xp: 1500 },
        abilities: [],
        goals: [],
        agenda: 'lead',
        allegiance: 'vanguard',
        mood: 'resolute',
        traits: ['commander'],
      },
      finn: {
        id: 'finn',
        name: 'Finn',
        status: 'captured',
        presentInScene: false,
        locationId: 'harbor-district',
        formId: null,
        formGroup: null,
        sections: {},
        customFields: {},
        progression: { level: 4, xp: 350 },
        abilities: [],
        goals: [],
        agenda: 'escape',
        allegiance: 'vanguard',
        mood: 'nervous',
        traits: ['stealthy', 'courier'],
      },
    },
  });
}

describe('bindBeatRoles', () => {
  it('returns empty bindings when roles are undefined or empty', () => {
    const state = createRoleTestState();
    expect(bindBeatRoles(undefined, state)).toEqual({ ok: true, bindings: {} });
    expect(bindBeatRoles({}, state)).toEqual({ ok: true, bindings: {} });
  });

  it('binds usable default characters, factions, and locations without adaptation', () => {
    const state = createRoleTestState();
    const roles: Record<string, BeatRoleSpec> = {
      commander: { default: 'elena' },
      sponsor: { default: 'vanguard' },
      meetup: { default: 'central-plaza' },
    };

    const res = bindBeatRoles(roles, state);
    expect(res.ok).toBe(true);
    expect(res.missingStrictRole).toBeUndefined();
    expect(res.bindings).toEqual({
      commander: {
        roleKey: 'commander',
        entityId: 'elena',
        displayName: 'Elena $Price',
        adapted: false,
      },
      meetup: {
        roleKey: 'meetup',
        entityId: 'central-plaza',
        displayName: 'Central Plaza',
        adapted: false,
      },
      sponsor: {
        roleKey: 'sponsor',
        entityId: 'vanguard',
        displayName: 'The Vanguard',
        adapted: false,
      },
    });
  });

  it('prefers in-scene/same-location active fallback candidates first, breaking ties lexicographically by id', () => {
    const state = createRoleTestState();
    // aria is dead; adam is active in harbor-district (id 'adam' < 'cora' < 'dax'),
    // while cora and dax are active in central-plaza (same location as scene).
    // cora should win over adam (same location first) and over dax ('cora' < 'dax').
    const roles: Record<string, BeatRoleSpec> = {
      messenger: {
        default: 'aria',
        fallbackQuery: {
          collection: 'characters',
          where: {
            allegiance: 'vanguard',
            traits: 'stealthy',
            'progression.level': { op: '>=', value: 4 },
          },
        },
      },
    };

    const res = bindBeatRoles(roles, state);
    expect(res.ok).toBe(true);
    expect(res.bindings.messenger).toEqual({
      roleKey: 'messenger',
      entityId: 'cora',
      displayName: 'Cora Vale',
      adapted: true,
      adaptedFrom: 'aria',
      adaptedTo: 'cora',
    });
  });

  it('falls back to matching entities outside the current scene when none are local', () => {
    const state = createRoleTestState();
    state.scene.locationId = 'unknown-zone';
    state.scene.presentCharacterIds = [];

    const roles: Record<string, BeatRoleSpec> = {
      messenger: {
        default: 'aria',
        fallbackQuery: {
          collection: 'characters',
          where: {
            traits: 'stealthy',
          },
        },
      },
    };

    const res = bindBeatRoles(roles, state);
    expect(res.ok).toBe(true);
    // finn is captured (unusable), adam < cora < dax lexicographically
    expect(res.bindings.messenger?.entityId).toBe('adam');
    expect(res.bindings.messenger?.adapted).toBe(true);
    expect(res.bindings.messenger?.adaptedFrom).toBe('aria');
    expect(res.bindings.messenger?.adaptedTo).toBe('adam');
  });

  it('supports faction and location fallback queries and rejects disbanded/destroyed entities', () => {
    const state = createRoleTestState();
    const roles: Record<string, BeatRoleSpec> = {
      faction: {
        default: 'old_order',
        fallbackQuery: {
          collection: 'factions',
          where: { influence: { op: '>=', value: 40 } },
        },
      },
      place: {
        default: 'ruined-keep',
        fallbackQuery: {
          collection: 'locations',
          where: { tags: 'docks' },
        },
      },
    };

    const res = bindBeatRoles(roles, state);
    expect(res.ok).toBe(true);
    expect(res.bindings.faction).toEqual({
      roleKey: 'faction',
      entityId: 'vanguard',
      displayName: 'The Vanguard',
      adapted: true,
      adaptedFrom: 'old_order',
      adaptedTo: 'vanguard',
    });
    expect(res.bindings.place).toEqual({
      roleKey: 'place',
      entityId: 'harbor-district',
      displayName: 'Harbor District',
      adapted: true,
      adaptedFrom: 'ruined-keep',
      adaptedTo: 'harbor-district',
    });
  });

  it('fails when default is unavailable and no fallback exists, no match exists, or allowFallback is false', () => {
    const state = createRoleTestState();

    const noFallback = bindBeatRoles({ guide: { default: 'aria' } }, state);
    expect(noFallback).toEqual({ ok: false, bindings: {}, missingStrictRole: 'guide' });

    const noMatch = bindBeatRoles(
      {
        guide: {
          default: 'aria',
          fallbackQuery: {
            collection: 'characters',
            where: { traits: 'nonexistent_trait' },
          },
        },
      },
      state
    );
    expect(noMatch).toEqual({ ok: false, bindings: {}, missingStrictRole: 'guide' });

    const strictDisallowed = bindBeatRoles(
      {
        guide: {
          default: 'aria',
          fallbackQuery: {
            collection: 'characters',
            where: { allegiance: 'vanguard' },
          },
        },
      },
      state,
      { allowFallback: false }
    );
    expect(strictDisallowed).toEqual({ ok: false, bindings: {}, missingStrictRole: 'guide' });
  });

  it('guards against prototype pollution keys in role names, defaults, and where clauses', () => {
    const state = createRoleTestState();
    const craftedRoles = JSON.parse(
      '{"__proto__":{"default":"elena"},"guide":{"default":"constructor"}}'
    ) as Record<string, BeatRoleSpec>;

    const res = bindBeatRoles(craftedRoles, state);
    expect(res.ok).toBe(false);
    expect(res.missingStrictRole).toBe('guide');

    const unsafeWhere = JSON.parse(
      '{"guide":{"default":"aria","fallbackQuery":{"collection":"characters","where":{"__proto__":"polluted"}}}}'
    ) as Record<string, BeatRoleSpec>;
    const unsafeRes = bindBeatRoles(unsafeWhere, state);
    expect(unsafeRes.ok).toBe(false);
  });
});

describe('interpolateBeatTemplate', () => {
  it('interpolates {{roles.<key>.name}} and {{roles.<key>.id}} safely without regex/dollar bugs', () => {
    const state = createRoleTestState();
    const bindRes = bindBeatRoles(
      {
        leader: { default: 'elena' },
        scout: {
          default: 'aria',
          fallbackQuery: { collection: 'characters', where: { traits: 'stealthy' } },
        },
      },
      state
    );
    expect(bindRes.ok).toBe(true);

    const rendered = interpolateBeatTemplate(
      'Meet {{roles.leader.name}} ({{roles.leader.id}}) with {{roles.scout.name}} ({{roles.scout.id}}). Unknown: {{roles.missing.name}} {{roles.__proto__.id}}',
      bindRes.bindings
    );
    expect(rendered).toBe(
      'Meet Elena $Price (elena) with Cora Vale (cora). Unknown: {{roles.missing.name}} {{roles.__proto__.id}}'
    );
  });
});
