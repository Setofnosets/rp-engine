import { describe, expect, it } from 'vitest';
import {
  type ResolvedControlRoomConfig,
  resolveEffectiveControlRoomConfig,
} from '../../src/config/control-room-config.js';
import {
  STOCK_LIVING_WORLD_PACK,
  STOCK_SLICE_OF_LIFE_PACK,
  STOCK_TACTICAL_RPG_PACK,
} from '../../src/schema/stock-system-packs.js';
import type { FormDefinition } from '../../src/state/forms.js';
import {
  type CharacterEntity,
  type WorldState,
  createWorldState,
} from '../../src/state/world-state.js';
import {
  inspectCharacterDossier,
  inspectSettingCharacters,
} from '../../src/world/character-inspector.js';

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
    allegiance: '',
    mood: 'neutral',
    traits: [],
    ...overrides,
  };
}

describe('character-inspector', () => {
  it('Tier 0 (scene_only): classifies player, pinned, in-scene, offscreen, and inactive characters and groups byLocation', () => {
    const config = resolveEffectiveControlRoomConfig(STOCK_SLICE_OF_LIFE_PACK);
    const state = createWorldState({
      sessionId: 'tier0-inspector',
      capabilities: config.capabilities,
      player: {
        id: 'player',
        name: 'Elena',
        characterId: null,
        sections: {
          sec_species: 'Human',
          sec_body: 'Warm brown eyes and a messy bun.',
        },
      },
      scene: {
        location: 'Corner Coffee Shop',
        locationId: null,
        pinnedCharacterIds: ['sam_pinned'],
      },
      characters: [
        makeCharacter('marcus', {
          name: 'Marcus',
          presentInScene: true,
          mood: 'cheerful',
          sections: { sec_species: 'Human' },
        }),
        makeCharacter('sam_pinned', {
          name: 'Sam',
          presentInScene: false,
          mood: 'focused',
        }),
        makeCharacter('stranger', {
          name: 'Quiet Stranger',
          presentInScene: false,
        }),
        makeCharacter('distant_friend', {
          name: 'Distant Friend',
          presentInScene: false,
          locationId: 'downtown',
        }),
        makeCharacter('fallen_npc', {
          name: 'Fallen',
          status: 'dead',
          presentInScene: true,
        }),
      ],
      relations: {
        player: {
          marcus: {
            affinity: 45,
            maxAffinity: 100,
            label: 'Friend',
            tags: ['barista', 'trusted'],
          },
        },
        sam_pinned: {
          player: {
            affinity: 70,
            maxAffinity: 100,
            label: 'Confidant',
            tags: ['close'],
          },
        },
      },
    });

    const roster = inspectSettingCharacters(state, config);

    expect(roster.spatialMode).toBe('scene_only');
    expect(roster.activeSceneLocation).toBe('Corner Coffee Shop');
    expect(roster.activeSceneLocationId).toBeNull();
    expect(roster.totalCharacters).toBe(6);
    expect(roster.presentCount).toBe(3); // player + sam_pinned + marcus
    expect(roster.offscreenCount).toBe(2); // distant_friend + stranger
    expect(roster.inactiveCount).toBe(1); // fallen_npc

    const byId = new Map(roster.characters.map((c) => [c.id, c]));
    expect(byId.get('player')).toMatchObject({
      id: 'player',
      name: 'Elena',
      isPlayer: true,
      presence: 'player',
      presentInScene: true,
      locationId: null,
      locationName: 'Corner Coffee Shop',
      playerAffinity: null,
      populatedSectionCount: 2,
      totalSectionCount: config.pcCoreSections.length,
    });
    expect(byId.get('sam_pinned')).toMatchObject({
      presence: 'in_scene_pinned',
      presentInScene: true,
      isPinned: true,
      locationName: 'Corner Coffee Shop',
      playerAffinity: { affinity: 70, maxAffinity: 100, label: 'Confidant' },
    });
    expect(byId.get('marcus')).toMatchObject({
      presence: 'in_scene',
      presentInScene: true,
      isPinned: false,
      locationName: 'Corner Coffee Shop',
      playerAffinity: { affinity: 45, maxAffinity: 100, label: 'Friend' },
      populatedSectionCount: 1,
      totalSectionCount: config.npcCoreSections.length,
    });
    expect(byId.get('distant_friend')).toMatchObject({
      presence: 'offscreen_located',
      presentInScene: false,
      locationId: 'downtown',
      locationName: 'downtown',
    });
    expect(byId.get('stranger')).toMatchObject({
      presence: 'offscreen_unlocated',
      presentInScene: false,
      locationId: null,
      locationName: null,
    });
    expect(byId.get('fallen_npc')).toMatchObject({
      presence: 'inactive',
      presentInScene: false,
      status: 'dead',
    });

    expect(roster.byLocation['Corner Coffee Shop']?.map((c) => c.id)).toEqual([
      'player',
      'sam_pinned',
      'marcus',
    ]);
    expect(roster.byLocation['downtown']?.map((c) => c.id)).toEqual(['distant_friend']);
    expect(roster.byLocation['unlocated']?.map((c) => c.id)).toEqual(['stranger', 'fallen_npc']);
  });

  it('Tier 1 (emergent) & Tier 2 (authored_graph): resolves locationName, faction allegianceName, and null-location isolation', () => {
    const emergentConfig = resolveEffectiveControlRoomConfig(STOCK_TACTICAL_RPG_PACK);
    const emergentState = createWorldState({
      sessionId: 'tier1-emergent',
      capabilities: emergentConfig.capabilities,
      player: {
        id: 'player',
        name: 'Aria',
        characterId: null,
        locationId: 'watchtower',
      },
      scene: {
        location: 'Old Watchtower',
        locationId: 'watchtower',
      },
      locations: [
        {
          id: 'watchtower',
          name: 'Old Watchtower',
          kind: 'landmark',
          status: 'normal',
          controllingFactionId: null,
          connectedLocations: [],
          discovered: true,
          tags: ['ruins'],
          notes: '',
        },
      ],
      characters: [
        makeCharacter('scout', { locationId: 'watchtower', presentInScene: false }),
        makeCharacter('unplaced', { locationId: null, presentInScene: true }),
      ],
    });

    const emergentRoster = inspectSettingCharacters(emergentState, emergentConfig);
    expect(emergentRoster.spatialMode).toBe('emergent');
    expect(emergentRoster.presentCount).toBe(2); // player + scout
    expect(emergentRoster.offscreenCount).toBe(1); // unplaced (null locationId does not match watchtower)
    expect(emergentRoster.characters.find((c) => c.id === 'scout')).toMatchObject({
      presence: 'in_scene',
      locationName: 'Old Watchtower',
    });
    expect(emergentRoster.characters.find((c) => c.id === 'unplaced')).toMatchObject({
      presence: 'offscreen_unlocated',
      presentInScene: false,
      locationName: null,
    });

    const graphConfig = resolveEffectiveControlRoomConfig(STOCK_LIVING_WORLD_PACK);
    const graphState = createWorldState({
      sessionId: 'tier2-graph',
      capabilities: graphConfig.capabilities,
      player: {
        id: 'player',
        name: 'Kael',
        characterId: 'kael',
        locationId: 'harbor',
      },
      scene: {
        location: 'Harbor District',
        locationId: 'harbor',
        pinnedCharacterIds: ['plaza_envoy'],
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
          id: 'vanguard',
          name: 'Civic Vanguard',
          side: 'hero',
          status: 'active',
          influence: 60,
          headquartersLocationId: 'plaza',
          goals: ['Maintain order'],
        },
      ],
      characters: [
        makeCharacter('kael', {
          name: 'Kael',
          locationId: 'harbor',
          allegiance: 'vanguard',
          mood: 'alert',
        }),
        makeCharacter('dock_boss', {
          name: 'Vex',
          locationId: 'harbor',
          allegiance: 'syndicate',
        }),
        makeCharacter('plaza_envoy', {
          name: 'Lyra',
          locationId: 'plaza',
          allegiance: 'vanguard',
        }),
        makeCharacter('prisoner', {
          name: 'Captured Spy',
          status: 'captured',
          locationId: 'harbor',
        }),
      ],
    });

    const graphRoster = inspectSettingCharacters(graphState, graphConfig);
    expect(graphRoster.spatialMode).toBe('authored_graph');
    // kael is linked to player so there are 4 total entries, not 5
    expect(graphRoster.totalCharacters).toBe(4);
    expect(graphRoster.presentCount).toBe(3); // kael (player), plaza_envoy (pinned), dock_boss (harbor)
    expect(graphRoster.inactiveCount).toBe(1); // prisoner

    const kaelSummary = graphRoster.characters.find((c) => c.id === 'kael');
    expect(kaelSummary).toMatchObject({
      isPlayer: true,
      presence: 'player',
      locationId: 'harbor',
      locationName: 'Harbor District',
      allegiance: 'vanguard',
      allegianceName: 'Civic Vanguard',
    });
    expect(graphRoster.characters.find((c) => c.id === 'dock_boss')).toMatchObject({
      presence: 'in_scene',
      locationName: 'Harbor District',
      allegianceName: 'Obsidian Syndicate',
    });
    expect(graphRoster.characters.find((c) => c.id === 'plaza_envoy')).toMatchObject({
      presence: 'in_scene_pinned',
      locationId: 'plaza',
      locationName: 'Central Plaza',
    });
  });

  it('handles multi-form exclusivity, sibling characters, and activeFormName resolution', () => {
    const config = resolveEffectiveControlRoomConfig(STOCK_SLICE_OF_LIFE_PACK);
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
      {
        id: 'solo_base',
        formGroup: 'solo_group',
        characterId: 'solo_morpher',
        displayName: 'Solo Base',
        legalTargets: ['solo_prime'],
      },
      {
        id: 'solo_prime',
        formGroup: 'solo_group',
        characterId: 'solo_morpher',
        displayName: 'Solo Prime',
        legalTargets: ['solo_base'],
      },
    ];

    const state = createWorldState({
      sessionId: 'forms-test',
      capabilities: config.capabilities,
      scene: {
        location: 'Rooftop',
        pinnedCharacterIds: ['leila_vigilante'],
      },
      characters: [
        makeCharacter('leila_civ', {
          name: 'Leila Renya',
          presentInScene: true,
          formId: 'leila_civilian',
          formGroup: null,
        }),
        makeCharacter('leila_vigilante', {
          name: 'Eclipse',
          presentInScene: true,
          formId: 'leila_eclipse',
          formGroup: null,
        }),
        makeCharacter('solo_morpher', {
          name: 'Solo Prime',
          presentInScene: true,
          formId: 'solo_prime',
          formGroup: 'solo_group',
        }),
      ],
    });

    const roster = inspectSettingCharacters(state, config, { formDefinitions: forms });
    const leilaCiv = roster.characters.find((c) => c.id === 'leila_civ');
    const leilaVig = roster.characters.find((c) => c.id === 'leila_vigilante');

    expect(leilaVig).toMatchObject({
      presence: 'in_scene_pinned',
      presentInScene: true,
      activeFormId: 'leila_eclipse',
      activeFormName: 'Eclipse',
      formGroup: 'leila_renya',
    });
    // Suppressed from scene cast by formGroup exclusivity
    expect(leilaCiv).toMatchObject({
      presence: 'offscreen_unlocated',
      presentInScene: false,
      activeFormId: 'leila_civilian',
      activeFormName: 'Leila Renya',
      formGroup: 'leila_renya',
    });

    const civDossier = inspectCharacterDossier(state, config, 'leila_civ', {
      formDefinitions: forms,
    });
    expect(civDossier).not.toBeNull();
    expect(civDossier!.forms).toMatchObject({
      activeFormId: 'leila_civilian',
      formGroup: 'leila_renya',
      siblingCharacterIdsInGroup: ['leila_vigilante'],
      exclusiveActiveCharacterId: 'leila_vigilante',
    });
    expect(civDossier!.forms.availableForms.map((f) => f.id)).toEqual(['leila_civilian']);

    const soloDossier = inspectCharacterDossier(state, config, 'solo_morpher', {
      formDefinitions: forms,
    });
    expect(soloDossier!.forms).toMatchObject({
      activeFormId: 'solo_prime',
      formGroup: 'solo_group',
      siblingCharacterIdsInGroup: [],
      exclusiveActiveCharacterId: 'solo_morpher',
    });
    expect(soloDossier!.forms.availableForms.map((f) => f.id)).toEqual([
      'solo_base',
      'solo_prime',
    ]);
  });

  it('supports filtering by locationId, status, allegiance, formGroup, presentOnly, includePlayer, and query', () => {
    const config = resolveEffectiveControlRoomConfig(STOCK_LIVING_WORLD_PACK);
    const state = createWorldState({
      sessionId: 'filter-test',
      capabilities: config.capabilities,
      player: {
        id: 'player',
        name: 'Raven',
        characterId: null,
        locationId: 'harbor',
      },
      scene: {
        location: 'Harbor',
        locationId: 'harbor',
      },
      locations: [
        {
          id: 'harbor',
          name: 'Harbor',
          kind: 'district',
          status: 'normal',
          controllingFactionId: null,
          connectedLocations: ['plaza'],
          discovered: true,
          tags: [],
          notes: '',
        },
        {
          id: 'plaza',
          name: 'Plaza',
          kind: 'district',
          status: 'normal',
          controllingFactionId: null,
          connectedLocations: ['harbor'],
          discovered: true,
          tags: [],
          notes: '',
        },
      ],
      characters: [
        makeCharacter('npc_alpha', {
          name: 'Alpha Guard',
          locationId: 'harbor',
          allegiance: 'vanguard',
          traits: ['stoic', 'loyal'],
          formGroup: 'alpha_form',
        }),
        makeCharacter('npc_beta', {
          name: 'Beta Smuggler',
          locationId: 'plaza',
          allegiance: 'syndicate',
          traits: ['cunning', 'nimble'],
        }),
        makeCharacter('npc_gamma', {
          name: 'Gamma Fallen',
          status: 'missing',
          locationId: 'plaza',
          allegiance: 'syndicate',
          traits: ['elusive'],
        }),
      ],
    });

    expect(
      inspectSettingCharacters(state, config, {
        filter: { locationId: 'plaza' },
      }).characters.map((c) => c.id)
    ).toEqual(['npc_beta', 'npc_gamma']);

    expect(
      inspectSettingCharacters(state, config, {
        filter: { status: 'missing' },
      }).characters.map((c) => c.id)
    ).toEqual(['npc_gamma']);

    expect(
      inspectSettingCharacters(state, config, {
        filter: { allegiance: 'syndicate' },
      }).characters.map((c) => c.id)
    ).toEqual(['npc_beta', 'npc_gamma']);

    expect(
      inspectSettingCharacters(state, config, {
        filter: { formGroup: 'alpha_form' },
      }).characters.map((c) => c.id)
    ).toEqual(['npc_alpha']);

    expect(
      inspectSettingCharacters(state, config, {
        filter: { presentOnly: true, includePlayer: false },
      }).characters.map((c) => c.id)
    ).toEqual(['npc_alpha']);

    // Query matching id, name, traits, and allegiance (case-insensitive)
    expect(
      inspectSettingCharacters(state, config, { filter: { query: 'CUNNING' } }).characters.map(
        (c) => c.id
      )
    ).toEqual(['npc_beta']);
    expect(
      inspectSettingCharacters(state, config, { filter: { query: 'SYNDI' } }).characters.map(
        (c) => c.id
      )
    ).toEqual(['npc_beta', 'npc_gamma']);
    expect(
      inspectSettingCharacters(state, config, { filter: { query: 'raven' } }).characters.map(
        (c) => c.id
      )
    ).toEqual(['player']);
    expect(
      inspectSettingCharacters(state, config, { filter: { query: 'npc_alpha' } }).characters.map(
        (c) => c.id
      )
    ).toEqual(['npc_alpha']);
  });

  it('inspects player + linked character dossier and NPC dossier with sections, customFields, and bilateral relations', () => {
    const config: ResolvedControlRoomConfig = resolveEffectiveControlRoomConfig(
      STOCK_TACTICAL_RPG_PACK,
      {
        gameSystemOverrides: {
          player_heat: {
            name: 'Wanted Heat',
            enabled: true,
            target: 'player',
            createIfMissing: true,
            fields: {
              heat_level: {
                type: 'meter',
                min: 0,
                max: 100,
                default: 0,
                writableByTracker: true,
              },
            },
          },
          npc_trust_module: {
            name: 'NPC Social Signals',
            enabled: true,
            target: 'npc',
            createIfMissing: true,
            fields: {
              suspicion: {
                type: 'counter',
                min: 0,
                max: 10,
                default: 2,
                writableByTracker: true,
              },
              secret_known: {
                type: 'boolean',
                default: false,
                writableByTracker: true,
              },
            },
          },
          disabled_npc_module: {
            name: 'Disabled Module',
            enabled: false,
            target: 'npc',
            createIfMissing: true,
            fields: {
              ignored_field: {
                type: 'string',
                default: 'nope',
                writableByTracker: true,
              },
            },
          },
        },
      }
    );

    const state = createWorldState({
      sessionId: 'dossier-full',
      capabilities: config.capabilities,
      player: {
        id: 'player',
        name: 'Cassian',
        characterId: 'cassian',
        locationId: 'citadel',
        progression: {
          level: 5,
          xp: 2400,
          className: 'Spellblade',
          attributes: { str: 14, int: 18 },
        },
        resources: {
          hp: { current: 32, max: 40 },
          willpower: { current: 9, max: 12 },
        },
        sections: {
          sec_species: 'Half-Elf',
          sec_equipment: 'Runed coat and twin foci.',
        },
        customFields: {
          heat_level: 35,
        },
      },
      scene: {
        location: 'Obsidian Citadel',
        locationId: 'citadel',
      },
      locations: [
        {
          id: 'citadel',
          name: 'Obsidian Citadel',
          kind: 'stronghold',
          status: 'normal',
          controllingFactionId: 'order',
          connectedLocations: [],
          discovered: true,
          tags: [],
          notes: '',
        },
      ],
      factions: [
        {
          id: 'order',
          name: 'Silver Order',
          side: 'hero',
          status: 'active',
          influence: 80,
          headquartersLocationId: 'citadel',
          goals: ['Defend the realm'],
        },
      ],
      characters: [
        makeCharacter('cassian', {
          name: 'Cassian Vale',
          locationId: 'citadel',
          allegiance: 'order',
          mood: 'vigilant',
          agenda: 'Uncover the traitor',
          goals: ['Protect the archive'],
          traits: ['analytical', 'stubborn'],
          abilities: ['Arcane Parry'],
          sections: {
            sec_background: 'Former archivist turned sentinel.',
            sec_equipment: 'Old cloak (should be overridden by player.sections)',
          },
          corruption: {
            stage: 1,
            progress: 20,
            source: 'void-relic',
          },
        }),
        makeCharacter('warden_sera', {
          name: 'Warden Sera',
          locationId: 'citadel',
          allegiance: 'order',
          mood: 'guarded',
          agenda: 'Audit citadel defenses',
          goals: ['Secure the vault', 'Test Cassian'],
          traits: ['stern', 'observant'],
          abilities: ['Shield Bash'],
          sections: {
            sec_species: 'Human',
            sec_strengths: ['Tactical foresight', 'Unwavering discipline'],
            sec_combat_profile: 'AC 18, HP 55, Longsword +7',
          },
          customFields: {
            npc_trust_module: {
              suspicion: 6,
            },
          },
        }),
      ],
      relations: {
        player: {
          warden_sera: {
            affinity: 30,
            maxAffinity: 100,
            label: 'Wary Ally',
            tags: ['mentor'],
          },
        },
        warden_sera: {
          cassian: {
            affinity: 25,
            maxAffinity: 100,
            label: 'Promising Initiate',
            tags: ['watchful'],
          },
        },
      },
    });

    // Player lookup by 'player', characterId, and case-insensitive name
    const byKeyword = inspectCharacterDossier(state, config, 'player');
    const byLinkedId = inspectCharacterDossier(state, config, 'cassian');
    const byName = inspectCharacterDossier(state, config, 'CASSIAN');

    expect(byKeyword).not.toBeNull();
    expect(byLinkedId).toEqual(byKeyword);
    expect(byName).toEqual(byKeyword);

    expect(byKeyword!.summary).toMatchObject({
      id: 'cassian',
      name: 'Cassian',
      isPlayer: true,
      presence: 'player',
      allegianceName: 'Silver Order',
      populatedSectionCount: 3, // sec_species, sec_equipment, sec_background
    });
    expect(byKeyword!.agency).toEqual({
      mood: 'vigilant',
      allegiance: 'order',
      allegianceName: 'Silver Order',
      agenda: 'Uncover the traitor',
      goals: ['Protect the archive'],
      traits: ['analytical', 'stubborn'],
      abilities: ['Arcane Parry'],
    });
    expect(byKeyword!.progression).toMatchObject({ level: 5, xp: 2400, className: 'Spellblade' });
    expect(byKeyword!.resources?.['hp']).toEqual({ current: 32, max: 40 });
    expect(byKeyword!.corruption).toEqual({ stage: 1, progress: 20, source: 'void-relic' });

    const equipSec = byKeyword!.sections.find((s) => s.id === 'sec_equipment');
    expect(equipSec).toMatchObject({
      value: 'Runed coat and twin foci.',
      populated: true,
    });
    const bgSec = byKeyword!.sections.find((s) => s.id === 'sec_background');
    expect(bgSec).toMatchObject({
      value: 'Former archivist turned sentinel.',
      populated: true,
      writableByTracker: false,
      confirmPolicy: 'locked',
    });

    const heatField = byKeyword!.customFields.find((f) => f.fieldId === 'heat_level');
    expect(heatField).toMatchObject({
      moduleId: 'player_heat',
      moduleName: 'Wanted Heat',
      value: 35,
    });

    expect(byKeyword!.relations.outgoing['warden_sera']).toMatchObject({
      affinity: 30,
      label: 'Wary Ally',
    });
    expect(byKeyword!.relations.incoming['warden_sera']).toMatchObject({
      affinity: 25,
      label: 'Promising Initiate',
    });

    // NPC dossier inspection by case-insensitive name
    const npcDossier = inspectCharacterDossier(state, config, 'warden sera');
    expect(npcDossier).not.toBeNull();
    expect(npcDossier!.summary).toMatchObject({
      id: 'warden_sera',
      isPlayer: false,
      populatedSectionCount: 3,
      totalSectionCount: config.npcCoreSections.length,
    });

    const combatSec = npcDossier!.sections.find((s) => s.id === 'sec_combat_profile');
    expect(combatSec).toMatchObject({
      hiddenUntilSet: true,
      populated: true,
      value: 'AC 18, HP 55, Longsword +7',
    });
    const bodySec = npcDossier!.sections.find((s) => s.id === 'sec_body');
    expect(bodySec).toMatchObject({
      value: null,
      populated: false,
      confirmPolicy: 'auto',
    });

    // Custom fields include enabled NPC module (nested + default fallback) and exclude disabled module
    expect(npcDossier!.customFields.map((f) => f.fieldId)).toEqual([
      'secret_known',
      'suspicion',
    ]);
    expect(npcDossier!.customFields.find((f) => f.fieldId === 'suspicion')?.value).toBe(6);
    expect(npcDossier!.customFields.find((f) => f.fieldId === 'secret_known')?.value).toBe(false);

    expect(npcDossier!.relations.outgoing['cassian']).toMatchObject({
      affinity: 25,
      label: 'Promising Initiate',
    });
    expect(npcDossier!.relations.incoming['player']).toMatchObject({
      affinity: 30,
      label: 'Wary Ally',
    });

    // Immutability check
    npcDossier!.agency.goals.push('Injected Goal');
    expect(state.entities.characters['warden_sera']?.goals).toEqual([
      'Secure the vault',
      'Test Cassian',
    ]);
  });

  it('handles unknown queries and prototype-pollution keys safely', () => {
    const config = resolveEffectiveControlRoomConfig(STOCK_SLICE_OF_LIFE_PACK);
    const state = createWorldState({
      sessionId: 'safety-test',
      capabilities: config.capabilities,
      characters: [makeCharacter('alice', { name: 'Alice', presentInScene: true })],
    });

    // Simulate tampered unsafe keys in runtime JSON input
    Object.defineProperty(state.entities.characters, '__proto__', {
      value: makeCharacter('__proto__', { name: 'Polluter', presentInScene: true }),
      enumerable: true,
      configurable: true,
    });

    expect(inspectCharacterDossier(state, config, 'nonexistent')).toBeNull();
    expect(inspectCharacterDossier(state, config, '   ')).toBeNull();
    expect(inspectCharacterDossier(state, config, '__proto__')).toBeNull();
    expect(inspectCharacterDossier(state, config, 'constructor')).toBeNull();
    expect(inspectCharacterDossier(state, config, 'prototype')).toBeNull();

    const roster = inspectSettingCharacters(state, config);
    expect(roster.characters.map((c) => c.id)).toEqual(['player', 'alice']);
    expect(Object.hasOwn(roster.byLocation, '__proto__')).toBe(false);

    // Unlinked player dossier
    const unlinkedPlayer = inspectCharacterDossier(state, config, 'PLAYER');
    expect(unlinkedPlayer).not.toBeNull();
    expect(unlinkedPlayer!.summary.isPlayer).toBe(true);
    expect(unlinkedPlayer!.agency.goals).toEqual([]);

    // includePlayer: false excludes linked player character too
    const linkedState = createWorldState({
      sessionId: 'linked-exclude-test',
      capabilities: config.capabilities,
      player: { id: 'player', name: 'Alice', characterId: 'alice' },
      characters: [
        makeCharacter('alice', { name: 'Alice', presentInScene: true }),
        makeCharacter('bob', { name: 'Bob', presentInScene: true }),
      ],
    });
    const npcsOnly = inspectSettingCharacters(linkedState, config, {
      filter: { includePlayer: false },
    });
    expect(npcsOnly.characters.map((c) => c.id)).toEqual(['bob']);
  });
});
