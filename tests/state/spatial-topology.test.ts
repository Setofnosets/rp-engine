import { describe, expect, it } from 'vitest';
import { isErr, isOk } from '../../src/core/result.js';
import {
  type LocationEntity,
  matchesLocationPredicate,
  registerOrResolveEmergentLocation,
  slugifyLocationName,
  validateTravelTarget,
} from '../../src/state/spatial-topology.js';

function makeAuthoredLocations(): Record<string, LocationEntity> {
  return {
    'central-plaza': {
      id: 'central-plaza',
      name: 'Central Plaza',
      kind: 'district',
      status: 'normal',
      controllingFactionId: 'vanguard',
      connectedLocations: ['harbor-district', 'archive-tower'],
      discovered: true,
      tags: ['public', 'outdoor', 'hub'],
      notes: 'Main city square',
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
      notes: 'Foggy piers',
    },
    'archive-tower': {
      id: 'archive-tower',
      name: 'Archive Tower',
      kind: 'facility',
      status: 'locked',
      controllingFactionId: null,
      connectedLocations: ['central-plaza', 'obsidian-vault'],
      discovered: false,
      tags: ['indoor', 'restricted'],
      notes: 'Restricted library',
    },
    'obsidian-vault': {
      id: 'obsidian-vault',
      name: 'Obsidian Vault',
      kind: 'hideout',
      status: 'normal',
      controllingFactionId: 'syndicate',
      connectedLocations: ['archive-tower'],
      discovered: false,
      tags: ['underground'],
      notes: 'Deep vault',
    },
  };
}

describe('slugifyLocationName', () => {
  it('generates deterministic kebab-case slugs from location names', () => {
    expect(slugifyLocationName('Central Plaza')).toBe('central-plaza');
    expect(slugifyLocationName("  O'Connor's Café René! ")).toBe('oconnors-cafe-rene');
    expect(slugifyLocationName('Sector 7G — Dockyard')).toBe('sector-7g-dockyard');
    expect(slugifyLocationName('   ')).toBe('location');
  });

  it('produces deterministic distinct fallback hashes for non-Latin names', () => {
    const tokyoA = slugifyLocationName('東京');
    const tokyoB = slugifyLocationName('東京');
    const osaka = slugifyLocationName('大阪');

    expect(tokyoA).toBe(tokyoB);
    expect(tokyoA).toMatch(/^loc-[0-9a-f]{8}$/);
    expect(tokyoA).not.toBe(osaka);
  });
});

describe('registerOrResolveEmergentLocation (Tier 1)', () => {
  it('creates a newly discovered location node and bidirectional link without mutating inputs', () => {
    const initial: Record<string, LocationEntity> = {
      'town-square': {
        id: 'town-square',
        name: 'Town Square',
        kind: 'emergent',
        status: 'normal',
        controllingFactionId: null,
        connectedLocations: [],
        discovered: true,
        tags: [],
        notes: '',
      },
    };

    const res = registerOrResolveEmergentLocation(initial, 'The Rusty Tavern', 'town-square');

    expect(res.created).toBe(true);
    expect(res.locationId).toBe('the-rusty-tavern');
    expect(res.nextLocations['the-rusty-tavern']).toEqual({
      id: 'the-rusty-tavern',
      name: 'The Rusty Tavern',
      kind: 'emergent',
      status: 'normal',
      controllingFactionId: null,
      connectedLocations: ['town-square'],
      discovered: true,
      tags: [],
      notes: '',
    });
    expect(res.nextLocations['town-square']?.connectedLocations).toEqual(['the-rusty-tavern']);

    // Input remains unmutated
    expect(initial['the-rusty-tavern']).toBeUndefined();
    expect(initial['town-square']?.connectedLocations).toEqual([]);
  });

  it('resolves existing emergent nodes by id, case-insensitive name, or slug and links missing edges', () => {
    const step1 = registerOrResolveEmergentLocation({}, 'Town Square', null);
    expect(step1.created).toBe(true);
    expect(step1.locationId).toBe('town-square');

    const step2 = registerOrResolveEmergentLocation(step1.nextLocations, 'Dark Alley', 'town-square');
    expect(step2.created).toBe(true);

    const step3 = registerOrResolveEmergentLocation(step2.nextLocations, 'Shadow Market', 'dark-alley');
    expect(step3.created).toBe(true);

    // Loop back from Shadow Market to existing Town Square (via mixed-case name)
    const step4 = registerOrResolveEmergentLocation(
      step3.nextLocations,
      '  town square ',
      'shadow-market'
    );
    expect(step4.created).toBe(false);
    expect(step4.locationId).toBe('town-square');
    expect(step4.nextLocations['town-square']?.connectedLocations).toEqual([
      'dark-alley',
      'shadow-market',
    ]);
    expect(step4.nextLocations['shadow-market']?.connectedLocations).toEqual([
      'dark-alley',
      'town-square',
    ]);

    // Repeat resolution should not duplicate edges or add self-loops
    const step5 = registerOrResolveEmergentLocation(step4.nextLocations, 'town-square', 'town-square');
    expect(step5.created).toBe(false);
    expect(step5.nextLocations['town-square']?.connectedLocations).toEqual([
      'dark-alley',
      'shadow-market',
    ]);
  });
});

describe('validateTravelTarget across all 3 spatial tiers', () => {
  it('Tier 0 (scene_only) accepts any non-empty targetName with null targetId', () => {
    const res = validateTravelTarget('scene_only', {}, null, '  Rooftop Diner  ');
    expect(isOk(res)).toBe(true);
    if (res.ok) {
      expect(res.value).toEqual({ targetId: null, targetName: 'Rooftop Diner' });
    }

    const emptyRes = validateTravelTarget('scene_only', {}, null, '   ');
    expect(isErr(emptyRes)).toBe(true);
  });

  it('Tier 1 (emergent) resolves existing nodes and permits new names', () => {
    const locations = makeAuthoredLocations();

    const existing = validateTravelTarget('emergent', locations, 'harbor-district', 'Obsidian Vault');
    expect(isOk(existing)).toBe(true);
    if (existing.ok) {
      expect(existing.value).toEqual({ targetId: 'obsidian-vault', targetName: 'Obsidian Vault' });
    }

    const novel = validateTravelTarget('emergent', locations, 'harbor-district', 'Secret Sewer');
    expect(isOk(novel)).toBe(true);
    if (novel.ok) {
      expect(novel.value).toEqual({ targetId: null, targetName: 'Secret Sewer' });
    }
  });

  it('Tier 2 (authored_graph) enforces existence and connectedLocations adjacency', () => {
    const locations = makeAuthoredLocations();

    // Adjacent move by id or name succeeds
    const validById = validateTravelTarget(
      'authored_graph',
      locations,
      'central-plaza',
      'harbor-district'
    );
    expect(isOk(validById)).toBe(true);
    if (validById.ok) {
      expect(validById.value).toEqual({ targetId: 'harbor-district', targetName: 'Harbor District' });
    }

    const validByName = validateTravelTarget(
      'authored_graph',
      locations,
      'central-plaza',
      'archive tower'
    );
    expect(isOk(validByName)).toBe(true);

    // Non-adjacent target fails
    const unreachable = validateTravelTarget(
      'authored_graph',
      locations,
      'central-plaza',
      'obsidian-vault'
    );
    expect(isErr(unreachable)).toBe(true);
    if (!unreachable.ok) {
      expect(unreachable.error[0]?.code).toBe('UNREACHABLE_LOCATION');
    }

    // Unknown target fails
    const unknownTarget = validateTravelTarget(
      'authored_graph',
      locations,
      'central-plaza',
      'Uncharted Island'
    );
    expect(isErr(unknownTarget)).toBe(true);
    if (!unknownTarget.ok) {
      expect(unknownTarget.error[0]?.code).toBe('UNKNOWN_LOCATION');
    }

    // Unknown origin fails
    const unknownOrigin = validateTravelTarget(
      'authored_graph',
      locations,
      'ghost-node',
      'central-plaza'
    );
    expect(isErr(unknownOrigin)).toBe(true);
    if (!unknownOrigin.ok) {
      expect(unknownOrigin.error[0]?.code).toBe('UNKNOWN_ORIGIN_LOCATION');
    }

    // Null fromLocationId allows initial placement at any authored node
    const initialPlacement = validateTravelTarget(
      'authored_graph',
      locations,
      null,
      'obsidian-vault'
    );
    expect(isOk(initialPlacement)).toBe(true);
  });
});

describe('matchesLocationPredicate', () => {
  it('performs normalized case-insensitive token/substring matching in Tier 0', () => {
    const scene = { location: 'The Quiet Café (Corner Booth)', locationId: null };

    expect(matchesLocationPredicate('scene_only', scene, {}, 'quiet')).toBe(true);
    expect(matchesLocationPredicate('scene_only', scene, {}, 'cafe')).toBe(true);
    expect(matchesLocationPredicate('scene_only', scene, {}, 'QUIET BOOTH')).toBe(true);
    expect(matchesLocationPredicate('scene_only', scene, {}, 'noisy tavern')).toBe(false);
    expect(matchesLocationPredicate('scene_only', scene, {}, '')).toBe(false);
  });

  it('matches locationId or location tags in Tier 1 and Tier 2 without substring matching scene.location', () => {
    const locations = makeAuthoredLocations();
    const scene = { location: 'Foggy Waterfront Piers', locationId: 'harbor-district' };

    expect(matchesLocationPredicate('authored_graph', scene, locations, 'harbor-district')).toBe(true);
    expect(matchesLocationPredicate('emergent', scene, locations, 'SMUGGLING')).toBe(true);
    expect(matchesLocationPredicate('authored_graph', scene, locations, 'docks')).toBe(true);
    // Should NOT match raw prose substring in Tier 1/2 when not an id or tag
    expect(matchesLocationPredicate('authored_graph', scene, locations, 'waterfront')).toBe(false);
    expect(
      matchesLocationPredicate('authored_graph', { location: 'Nowhere', locationId: null }, locations, 'docks')
    ).toBe(false);
  });
});
