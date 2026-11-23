import { describe, expect, it } from 'vitest';
import {
  STOCK_LIVING_WORLD_PACK,
  STOCK_SLICE_OF_LIFE_PACK,
} from '../../src/schema/stock-system-packs.js';
import type { FormDefinition } from '../../src/state/forms.js';
import {
  type CharacterEntity,
  type WorldState,
  createWorldState,
} from '../../src/state/world-state.js';
import { computeLocationCast } from '../../src/world/cast-presence.js';

function makeCharacter(
  id: string,
  overrides: Partial<CharacterEntity> = {}
): CharacterEntity {
  return {
    id,
    name: id,
    status: 'active',
    presentInScene: false,
    locationId: null,
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
    ...overrides,
  };
}

describe('computeLocationCast', () => {
  it('Tier 0 (scene_only): selects presentInScene or pinned active NPCs and excludes player & non-active statuses', () => {
    const state: WorldState = createWorldState({
      sessionId: 'tier0-cast',
      capabilities: STOCK_SLICE_OF_LIFE_PACK.capabilities,
      player: {
        id: 'player',
        name: 'Elena',
        characterId: 'elena',
      },
      scene: {
        location: 'Corner Coffee Shop',
        locationId: null,
        pinnedCharacterIds: ['pinned_friend', 'elena', 'missing_pal'],
      },
      characters: [
        makeCharacter('elena', { name: 'Elena', presentInScene: true }),
        makeCharacter('barista_marcus', { name: 'Marcus', presentInScene: true }),
        makeCharacter('pinned_friend', { name: 'Sam', presentInScene: false }),
        makeCharacter('unseen_stranger', { name: 'Stranger', presentInScene: false }),
        makeCharacter('dead_npc', { status: 'dead', presentInScene: true }),
        makeCharacter('captured_npc', { status: 'captured', presentInScene: true }),
        makeCharacter('imprisoned_npc', { status: 'imprisoned', presentInScene: true }),
        makeCharacter('missing_pal', { status: 'missing', presentInScene: false }),
        makeCharacter('retired_mentor', { status: 'retired', presentInScene: true }),
        makeCharacter('lost_traveler', { status: 'lost', presentInScene: true }),
      ],
    });

    const result = computeLocationCast(state);

    expect(result.excludedPlayerCharacterId).toBe('elena');
    expect(result.presentCharacterIds).toEqual(['pinned_friend', 'barista_marcus']);
    expect(result.presentCharacters.map((c) => c.id)).toEqual(['pinned_friend', 'barista_marcus']);
    expect(result.activeThreatsHere).toEqual([]);
  });

  it('Tier 2 (authored_graph): selects by scene.locationId or pins, links active threats by location or faction HQ, and avoids null === null', () => {
    const state = createWorldState({
      sessionId: 'tier2-cast',
      capabilities: STOCK_LIVING_WORLD_PACK.capabilities,
      player: {
        id: 'player',
        name: 'Hero',
        characterId: 'player_hero',
        locationId: 'harbor',
      },
      scene: {
        location: 'Harbor District',
        locationId: 'harbor',
        pinnedCharacterIds: ['offsite_ally'],
      },
      locations: [
        {
          id: 'harbor',
          name: 'Harbor District',
          kind: 'district',
          status: 'contested',
          controllingFactionId: 'syndicate',
          connectedLocations: ['plaza'],
          discovered: true,
          tags: ['docks'],
          notes: '',
        },
        {
          id: 'plaza',
          name: 'Central Plaza',
          kind: 'district',
          status: 'normal',
          controllingFactionId: 'vanguard',
          connectedLocations: ['harbor'],
          discovered: true,
          tags: ['hub'],
          notes: '',
        },
      ],
      factions: [
        {
          id: 'syndicate',
          name: 'Obsidian Syndicate',
          side: 'villain',
          status: 'active',
          influence: 75,
          headquartersLocationId: 'harbor',
          goals: ['Control shipping'],
        },
        {
          id: 'crimson_cult',
          name: 'Crimson Cult',
          side: 'villain',
          status: 'active',
          influence: 50,
          headquartersLocationId: 'plaza',
          goals: ['Ritual'],
        },
      ],
      threats: [
        {
          id: 'direct_threat',
          name: 'Dockside Kraken',
          rank: 'main',
          status: 'active',
          stage: 2,
          progress: 50,
          locationId: 'harbor',
          sourceFactionId: null,
          agenda: 'Sink ships',
        },
        {
          id: 'hq_linked_threat',
          name: 'Syndicate Enforcers',
          rank: 'secondary',
          status: 'active',
          stage: 1,
          progress: 30,
          locationId: null,
          sourceFactionId: 'syndicate',
          agenda: 'Extort merchants',
        },
        {
          id: 'contained_threat',
          name: 'Sealed Demon',
          rank: 'secondary',
          status: 'contained',
          stage: 1,
          progress: 25,
          locationId: 'harbor',
          sourceFactionId: null,
          agenda: 'Escape seal',
        },
        {
          id: 'distant_threat',
          name: 'Cultists at Plaza',
          rank: 'secondary',
          status: 'active',
          stage: 1,
          progress: 20,
          locationId: 'plaza',
          sourceFactionId: 'crimson_cult',
          agenda: 'Recruit',
        },
      ],
      characters: [
        makeCharacter('player_hero', { locationId: 'harbor', presentInScene: true }),
        makeCharacter('dockmaster', { locationId: 'harbor', presentInScene: false }),
        makeCharacter('harbor_agent', {
          status: 'offscreen',
          locationId: 'harbor',
          presentInScene: false,
        }),
        makeCharacter('offsite_ally', { locationId: 'plaza', presentInScene: false }),
        makeCharacter('plaza_guard', { locationId: 'plaza', presentInScene: true }),
        makeCharacter('dead_dockhand', { status: 'dead', locationId: 'harbor' }),
      ],
    });

    const result = computeLocationCast(state);

    expect(result.excludedPlayerCharacterId).toBe('player_hero');
    expect(result.presentCharacterIds).toEqual(['offsite_ally', 'dockmaster', 'harbor_agent']);
    expect(result.activeThreatsHere.map((t) => t.id)).toEqual([
      'direct_threat',
      'hq_linked_threat',
    ]);

    // Verify null scene.locationId never matches locationId: null characters in Tier 1/2
    const unplacedState = createWorldState({
      sessionId: 'emergent-null-loc',
      capabilities: { ...STOCK_LIVING_WORLD_PACK.capabilities, spatialMode: 'emergent' },
      player: { characterId: null },
      scene: { location: 'Limbo', locationId: null, pinnedCharacterIds: ['pinned_npc'] },
      characters: [
        makeCharacter('unplaced_npc', { locationId: null, presentInScene: true }),
        makeCharacter('pinned_npc', { locationId: null, presentInScene: false }),
      ],
    });
    const unplacedResult = computeLocationCast(unplacedState);
    expect(unplacedResult.excludedPlayerCharacterId).toBeNull();
    expect(unplacedResult.presentCharacterIds).toEqual(['pinned_npc']);

    // Verify immutability: mutating returned objects does not affect input state
    result.presentCharacters[0]!.name = 'Mutated Name';
    expect(state.entities.characters['offsite_ally']?.name).toBe('offsite_ally');
  });

  it('enforces formGroup exclusivity via selectExclusiveCast and prefers pinnedCharacterIds', () => {
    const forms: FormDefinition[] = [
      {
        id: 'leila_civilian',
        formGroup: 'leila_renya',
        characterId: 'leila_civ',
        displayName: 'Leila Renya',
      },
      {
        id: 'leila_eclipse',
        formGroup: 'leila_renya',
        characterId: 'leila_vigilante',
        displayName: 'Eclipse',
      },
    ];

    // Without pin: lexicographically lowest id ('leila_civ') wins formGroup 'leila_renya'
    const unpinnedState = createWorldState({
      sessionId: 'form-unpinned',
      capabilities: STOCK_SLICE_OF_LIFE_PACK.capabilities,
      characters: [
        makeCharacter('leila_vigilante', {
          presentInScene: true,
          formId: 'leila_eclipse',
          formGroup: null, // resolved via formDefinitions
        }),
        makeCharacter('leila_civ', {
          presentInScene: true,
          formId: 'leila_civilian',
          formGroup: null, // resolved via formDefinitions
        }),
        makeCharacter('kestrel_b', { presentInScene: true, formGroup: 'kestrel' }),
        makeCharacter('kestrel_a', { presentInScene: true, formGroup: 'kestrel' }),
        makeCharacter('neutral_npc', { presentInScene: true, formGroup: null }),
      ],
    });

    const unpinnedCast = computeLocationCast(unpinnedState, forms);
    expect(unpinnedCast.presentCharacterIds).toEqual(['kestrel_a', 'leila_civ', 'neutral_npc']);

    // With pin: pinned form wins the formGroup over lexicographically lower id
    const pinnedState = createWorldState({
      sessionId: 'form-pinned',
      capabilities: STOCK_SLICE_OF_LIFE_PACK.capabilities,
      scene: {
        location: 'Rooftop',
        pinnedCharacterIds: ['leila_vigilante', 'kestrel_b'],
      },
      characters: Object.values(unpinnedState.entities.characters),
    });

    const pinnedCast = computeLocationCast(pinnedState, forms);
    expect(pinnedCast.presentCharacterIds).toEqual([
      'leila_vigilante',
      'kestrel_b',
      'neutral_npc',
    ]);
  });
});
