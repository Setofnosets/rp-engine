import { describe, expect, it } from 'vitest';
import { evaluatePredicate } from '../../src/beats/predicate-evaluator.js';
import { isErr, isOk } from '../../src/core/result.js';
import { migrateWorldStateDocument } from '../../src/state/migrations.js';
import { applyPatchBatch } from '../../src/state/reducer.js';
import {
  type LocationEntity,
  projectPlayerVisibleLocations,
  validateTravelTarget,
} from '../../src/state/spatial-topology.js';
import { createWorldState } from '../../src/state/world-state.js';

function makeTestLocations(): Record<string, LocationEntity> {
  return {
    'gate-hall': {
      id: 'gate-hall',
      name: 'Gate Hall',
      kind: 'dungeon_room',
      status: 'normal',
      controllingFactionId: null,
      connectedLocations: ['open-corridor', 'locked-vault', 'secret-shrine'],
      discovered: true,
      discoveryState: 'visited',
      tags: ['indoor'],
      notes: '',
      geometry: {
        x: 10,
        y: 20,
        districtId: 'outer-ward',
        regionId: 'crimson-keep',
      },
      connectionsMeta: {
        'open-corridor': { state: 'open' },
        'locked-vault': { state: 'locked', keyItemId: 'iron-key' },
        'secret-shrine': { state: 'secret' },
      },
      hiddenAssets: {
        'spike-trap': {
          id: 'spike-trap',
          kind: 'trap',
          name: 'Floor Spikes',
          knowledgeTier: 'unrevealed',
          canonStatus: 'intact',
          canonLocked: false,
        },
        'wall-lever': {
          id: 'wall-lever',
          kind: 'clue',
          name: 'Hidden Lever',
          knowledgeTier: 'known',
          canonStatus: 'cleared',
          canonLocked: true,
        },
      },
    },
    'open-corridor': {
      id: 'open-corridor',
      name: 'Open Corridor',
      kind: 'dungeon_room',
      status: 'normal',
      controllingFactionId: null,
      connectedLocations: ['gate-hall'],
      discovered: false,
      discoveryState: 'rumored',
      tags: [],
      notes: '',
      geometry: { x: 15, y: 20, districtId: 'outer-ward' },
    },
    'locked-vault': {
      id: 'locked-vault',
      name: 'Locked Vault',
      kind: 'vault',
      status: 'locked',
      controllingFactionId: null,
      connectedLocations: ['gate-hall'],
      discovered: false,
      discoveryState: 'unknown',
      tags: [],
      notes: '',
    },
    'secret-shrine': {
      id: 'secret-shrine',
      name: 'Secret Shrine',
      kind: 'shrine',
      status: 'normal',
      controllingFactionId: null,
      connectedLocations: ['gate-hall'],
      discovered: false,
      discoveryState: 'unknown',
      tags: [],
      notes: '',
    },
  };
}

function makeAuthoredState() {
  const base = createWorldState();
  return createWorldState({
    capabilities: { ...base.capabilities, spatialMode: 'authored_graph' },
    locations: makeTestLocations(),
    scene: { ...base.scene, locationId: 'gate-hall', location: 'Gate Hall' },
    player: { ...base.player, locationId: 'gate-hall' },
  });
}

describe('PR-7.2: Spatial Geometry, Connection Gating & Fog-of-War', () => {
  it('gates travel across locked, blocked, destroyed, and secret connections', () => {
    const locations = makeTestLocations();

    const okRes = validateTravelTarget('authored_graph', locations, 'gate-hall', 'open-corridor');
    expect(isOk(okRes)).toBe(true);

    for (const blockedTarget of ['locked-vault', 'secret-shrine']) {
      const res = validateTravelTarget('authored_graph', locations, 'gate-hall', blockedTarget);
      expect(isErr(res)).toBe(true);
      if (isErr(res)) {
        expect(res.error[0]?.code).toBe('CONNECTION_BLOCKED');
      }
    }
  });

  it('redacts unrevealed hiddenAssets and secret connections in projectPlayerVisibleLocations', () => {
    const locations = makeTestLocations();
    const projected = projectPlayerVisibleLocations(locations);

    const gate = projected['gate-hall'];
    expect(gate).toBeDefined();
    expect(gate?.connectedLocations).toEqual(['open-corridor', 'locked-vault']);
    expect(gate?.connectionsMeta?.['secret-shrine']).toBeUndefined();
    expect(gate?.hiddenAssets?.['spike-trap']).toBeUndefined();
    expect(gate?.hiddenAssets?.['wall-lever']).toBeDefined();

    // Original is not mutated
    expect(locations['gate-hall']?.connectedLocations).toContain('secret-shrine');
    expect(locations['gate-hall']?.hiddenAssets?.['spike-trap']).toBeDefined();
  });

  it('syncs discovered <-> discoveryState on patch and sets visited on travel_to', () => {
    const state = makeAuthoredState();

    const patchRes = applyPatchBatch(state, {
      eventId: 'evt-1',
      source: 'engine',
      operations: [
        { op: 'set', path: 'entities.locations.locked-vault.discoveryState', value: 'discovered' },
      ],
    });
    expect(isOk(patchRes)).toBe(true);
    if (isOk(patchRes)) {
      expect(patchRes.value.nextState.entities.locations['locked-vault']?.discovered).toBe(true);
    }

    const hideRes = applyPatchBatch(state, {
      eventId: 'evt-2',
      source: 'engine',
      operations: [
        { op: 'set', path: 'entities.locations.gate-hall.discovered', value: false },
      ],
    });
    expect(isOk(hideRes)).toBe(true);
    if (isOk(hideRes)) {
      const dest = hideRes.value.nextState.entities.locations['gate-hall'];
      expect(dest?.discovered).toBe(false);
      expect(dest?.discoveryState).toBe('unknown');
    }
  });

  it('enforces play-canon lock immutability on hiddenAssets', () => {
    const state = makeAuthoredState();

    const revertRes = applyPatchBatch(state, {
      eventId: 'evt-3',
      source: 'engine',
      operations: [
        {
          op: 'set',
          path: 'entities.locations.gate-hall.hiddenAssets',
          value: {
            'wall-lever': {
              id: 'wall-lever',
              kind: 'clue',
              name: 'Hidden Lever',
              knowledgeTier: 'known',
              canonStatus: 'intact',
              canonLocked: true,
            },
          },
        },
      ],
    });

    expect(isErr(revertRes)).toBe(true);
    if (isErr(revertRes)) {
      expect(revertRes.error[0]?.code).toBe('CANON_LOCKED');
    }
  });

  it('backfills discoveryState from discovered during migration', () => {
    const legacy = {
      schemaVersion: 1,
      entities: {
        locations: {
          tavern: {
            id: 'tavern',
            name: 'Tavern',
            kind: 'emergent',
            status: 'normal',
            controllingFactionId: null,
            connectedLocations: [],
            discovered: true,
            tags: [],
            notes: '',
          },
        },
      },
    };

    const migrated = migrateWorldStateDocument(legacy);
    expect(isOk(migrated)).toBe(true);
    if (isOk(migrated)) {
      const locs = migrated.value.worldState.entities.locations;
      expect(locs.tavern?.discoveryState).toBe('discovered');
    }
  });

  it('evaluates { at } predicate with discoveryState and districtId', () => {
    const state = makeAuthoredState();
    const ctx = {
      state,
      beatStatuses: {},
      activeForms: {},
    };

    expect(
      evaluatePredicate({ at: 'gate-hall', discoveryState: 'visited', districtId: 'outer-ward' }, ctx)
    ).toBe(true);
    expect(
      evaluatePredicate({ at: 'gate-hall', discoveryState: 'rumored', districtId: 'outer-ward' }, ctx)
    ).toBe(false);
    expect(
      evaluatePredicate({ at: 'gate-hall', districtId: 'inner-ward' }, ctx)
    ).toBe(false);
  });
});
