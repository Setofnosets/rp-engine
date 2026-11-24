import { existsSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { validateCartridgeStructure } from '../../src/cartridge/cartridge-schema.js';
import {
  exportCartridgeToSillyTavernV2,
  exportCartridgeToSillyTavernV2Json,
} from '../../src/cartridge/exporters/st-lossy-exporter.js';
import {
  exportSystemPackToControlRoomLayer,
  exportSystemPackToJson,
} from '../../src/cartridge/exporters/system-pack-exporter.js';
import { importMultihogCartridge } from '../../src/cartridge/importers/multihog-importer.js';
import {
  importNeoTerraSeasonFromData,
  importNeoTerraSeasonFromDirectory,
} from '../../src/cartridge/importers/neoterra-importer.js';
import {
  extractCharaJsonFromPng,
  importSillyTavernCard,
} from '../../src/cartridge/importers/st-card-importer.js';
import {
  analyzeCartridgeGraph,
  detectBeatCycles,
  validateCrossFileReferences,
} from '../../src/cartridge/static-analyzer.js';
import { loadSystemPackFromJson } from '../../src/cartridge/system-pack-schema.js';
import { isErr, isOk } from '../../src/core/result.js';
import { STOCK_TACTICAL_RPG_PACK } from '../../src/schema/stock-system-packs.js';

const NEOTERRA_DATA_DIR =
  'C:\\Users\\locua\\OneDrive\\Escritorio\\KI\\extensions\\NeoTerra-Framework\\data';

function createPngChunk(type: string, data: Buffer): Buffer {
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4); // CRC not validated by text chunk scanner, zero-filled for synthetic test PNG
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function buildSyntheticPng(chunks: Array<{ type: string; data: Buffer }>): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(1, 0); // width = 1
  ihdrData.writeUInt32BE(1, 4); // height = 1
  ihdrData.writeUInt8(8, 8); // bit depth
  ihdrData.writeUInt8(6, 9); // color type RGBA

  const buffers: Buffer[] = [signature, createPngChunk('IHDR', ihdrData)];
  for (const ch of chunks) {
    buffers.push(createPngChunk(ch.type, ch.data));
  }
  buffers.push(createPngChunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(buffers);
}

function makeTextChunkData(keyword: string, text: string): Buffer {
  return Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0x00]), Buffer.from(text, 'utf8')]);
}

function makeItxtChunkData(keyword: string, text: string, compressed: boolean): Buffer {
  const payload = compressed ? deflateSync(Buffer.from(text, 'utf8')) : Buffer.from(text, 'utf8');
  return Buffer.concat([
    Buffer.from(keyword, 'latin1'),
    Buffer.from([0x00, compressed ? 1 : 0, 0x00, 0x00, 0x00]),
    payload,
  ]);
}

describe('PR-5.2 SillyTavern Card Importer & Lossy Exporter', () => {
  it('extracts base64 chara tEXt chunk from synthetic PNG and imports valid Tier 0 CartridgeBundle', () => {
    const v2Card = {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: 'Elena Vance',
        description: 'A sharp-eyed archivist at the Midnight Library.',
        personality: 'Composed, inquisitive, guarded',
        scenario: 'Late night rain taps against the tall arched windows.',
        first_mes: 'She sets down a brass lantern. "You are here past closing."',
        creator: 'ArchivistTest',
        character_version: '1.2.0',
        character_book: {
          name: 'Library Lore',
          entries: [
            {
              id: 1,
              keys: ['lantern', 'brass lantern'],
              content: 'The brass lantern reveals invisible ink on ledger margins.',
              enabled: true,
              insertion_order: 25,
            },
            {
              id: 2,
              keys: ['vault'],
              content: 'Disabled vault entry should be ignored.',
              enabled: false,
              insertion_order: 5,
            },
          ],
        },
      },
    };

    const base64Json = Buffer.from(JSON.stringify(v2Card), 'utf8').toString('base64');
    const pngBuffer = buildSyntheticPng([
      { type: 'tEXt', data: makeTextChunkData('chara', base64Json) },
    ]);

    const extracted = extractCharaJsonFromPng(pngBuffer);
    expect(isOk(extracted)).toBe(true);

    const imported = importSillyTavernCard(pngBuffer);
    expect(isOk(imported)).toBe(true);
    if (!imported.ok) return;

    const bundle = imported.value;
    expect(bundle.card.recommendedSystemPack).toBe('stock-slice-of-life');
    expect(bundle.card.persona.name).toBe('Elena Vance');
    expect(bundle.card.persona.description).toContain('Midnight Library');
    expect(bundle.card.persona.description).toContain('Composed, inquisitive, guarded');
    expect(bundle.initialEntities?.characters?.['elena_vance']).toEqual({
      id: 'elena_vance',
      name: 'Elena Vance',
      status: 'active',
      presentInScene: true,
      locationId: null,
      formId: null,
      formGroup: null,
      sections: {
        sec_personality: 'Composed, inquisitive, guarded',
        sec_background: 'A sharp-eyed archivist at the Midnight Library.',
      },
      customFields: {},
      abilities: [],
      goals: [],
      agenda: '',
      allegiance: '',
      mood: 'neutral',
      traits: [],
    });
    expect(bundle.beats).toHaveLength(1);
    expect(bundle.beats[0]!.class).toBe('ambient');
    expect(bundle.beats[0]!.priority).toBe(25);
    expect(bundle.beats[0]!.when).toEqual({ mentions: ['lantern', 'brass lantern'] });

    const validated = validateCartridgeStructure(bundle);
    expect(isOk(validated)).toBe(true);
    const graph = analyzeCartridgeGraph(bundle);
    expect(graph.ok).toBe(true);
    expect(graph.deadlockStatesDetected).toBe(false);
  });

  it('prefers ccv3 iTXt chunk over chara tEXt chunk and supports compressed iTXt', () => {
    const v2Fallback = {
      spec: 'chara_card_v2',
      data: { name: 'Old Name', description: 'Old desc' },
    };
    const v3Preferred = {
      spec: 'chara_card_v3',
      spec_version: '3.0',
      data: {
        name: 'Preferred V3 Heroine',
        description: 'V3 description with UTF-8 accents: café.',
        lorebook: {
          entries: {
            '0': {
              keys: ['café'],
              content: 'A cozy corner café.',
              enabled: true,
            },
          },
        },
      },
    };

    const pngBuffer = buildSyntheticPng([
      {
        type: 'tEXt',
        data: makeTextChunkData('chara', Buffer.from(JSON.stringify(v2Fallback)).toString('base64')),
      },
      {
        type: 'iTXt',
        data: makeItxtChunkData(
          'ccv3',
          Buffer.from(JSON.stringify(v3Preferred), 'utf8').toString('base64'),
          true
        ),
      },
    ]);

    const imported = importSillyTavernCard(pngBuffer, {
      recommendedSystemPack: 'stock-freeform',
    });
    expect(isOk(imported)).toBe(true);
    if (!imported.ok) return;

    expect(imported.value.card.persona.name).toBe('Preferred V3 Heroine');
    expect(imported.value.card.recommendedSystemPack).toBe('stock-freeform');
    const seededHeroine = imported.value.initialEntities?.characters?.['preferred_v3_heroine'];
    expect(seededHeroine).toBeDefined();
    expect(seededHeroine?.presentInScene).toBe(true);
    expect(seededHeroine?.status).toBe('active');
    expect(seededHeroine?.sections['sec_personality']).toBeUndefined();
    expect(seededHeroine?.sections['sec_background']).toBe('V3 description with UTF-8 accents: café.');
    expect(imported.value.beats).toHaveLength(1);
    expect(imported.value.beats[0]!.priority).toBe(10);
    expect(imported.value.beats[0]!.when).toEqual({ mentions: ['café'] });
  });

  it('rejects prototype pollution keys and exports/round-trips ST V2 cleanly', () => {
    const pollutedJson = '{"name":"Evil","__proto__":{"polluted":true}}';
    const badRes = importSillyTavernCard(pollutedJson);
    expect(isErr(badRes)).toBe(true);

    const v1Card = {
      name: 'Kael',
      description: 'Wandering smith.',
      first_mes: 'Sparks fly off the anvil.',
      character_book: {
        entries: [
          { keys: ['forge', 'anvil'], content: 'The forge burns with blue embers.', insertion_order: 40 },
        ],
      },
    };
    const imported = importSillyTavernCard(v1Card);
    expect(isOk(imported)).toBe(true);
    if (!imported.ok) return;

    const exported = exportCartridgeToSillyTavernV2(imported.value);
    expect(exported.spec).toBe('chara_card_v2');
    expect(exported.data.name).toBe('Kael');
    expect(exported.data.character_book?.entries).toHaveLength(1);
    expect(exported.data.character_book?.entries[0]?.keys).toEqual(['forge', 'anvil']);

    const exportedJson = exportCartridgeToSillyTavernV2Json(imported.value);
    const roundTripped = importSillyTavernCard(exportedJson);
    expect(isOk(roundTripped)).toBe(true);
    if (!roundTripped.ok) return;
    expect(roundTripped.value.beats).toHaveLength(1);
    expect(roundTripped.value.beats[0]!.when).toEqual({ mentions: ['forge', 'anvil'] });
  });

  it('rejects invalid PNG signatures, missing chara chunks, and truncated PNG chunks', () => {
    const notPng = Buffer.from('NOT_A_PNG_FILE', 'utf8');
    const badSig = extractCharaJsonFromPng(notPng);
    expect(isErr(badSig)).toBe(true);
    if (badSig.ok) return;
    expect(badSig.error[0]?.code).toBe('INVALID_PNG_SIGNATURE');

    const emptyChunksPng = buildSyntheticPng([]);
    const missingChunk = extractCharaJsonFromPng(emptyChunksPng);
    expect(isErr(missingChunk)).toBe(true);
    if (missingChunk.ok) return;
    expect(missingChunk.error[0]?.code).toBe('MISSING_CHARA_CHUNK');

    const truncatedPng = emptyChunksPng.subarray(0, emptyChunksPng.length - 5);
    const truncRes = extractCharaJsonFromPng(truncatedPng);
    expect(isErr(truncRes)).toBe(true);
    if (truncRes.ok) return;
    expect(truncRes.error[0]?.code).toBe('TRUNCATED_PNG_CHUNK');
  });

  it('sanitizes unsafe character slugs to safe fallback IDs and bounds oversized sec_background', () => {
    const unsafeNameCard = {
      name: 'constructor',
      description: 'X'.repeat(1500),
      personality: '   ',
    };
    const res = importSillyTavernCard(unsafeNameCard);
    expect(isOk(res)).toBe(true);
    if (!res.ok) return;

    const characters = res.value.initialEntities?.characters ?? {};
    expect(Object.hasOwn(characters, 'constructor')).toBe(false);
    expect(Object.hasOwn(characters, '__proto__')).toBe(false);
    expect(Object.hasOwn(characters, 'prototype')).toBe(false);

    const fallbackId = res.value.card.id;
    expect(fallbackId).toBe('imported-st-card');
    const seeded = characters[fallbackId];
    expect(seeded).toBeDefined();
    expect(seeded?.id).toBe(fallbackId);
    expect(seeded?.name).toBe('constructor');
    expect(seeded?.presentInScene).toBe(true);
    expect(seeded?.status).toBe('active');
    expect(seeded?.sections['sec_personality']).toBeUndefined();
    const bg = seeded?.sections['sec_background'];
    expect(typeof bg).toBe('string');
    expect((bg as string).length).toBeLessThanOrEqual(1200);
    expect((bg as string).endsWith('...')).toBe(true);
    expect(isOk(validateCartridgeStructure(res.value))).toBe(true);

    const emptyDescCard = {
      name: '__proto__',
      description: '   ',
    };
    const protoRes = importSillyTavernCard(emptyDescCard);
    expect(isOk(protoRes)).toBe(true);
    if (!protoRes.ok) return;
    const protoChars = protoRes.value.initialEntities?.characters ?? {};
    expect(Object.hasOwn(protoChars, '__proto__')).toBe(false);
    expect(protoChars[protoRes.value.card.id]?.sections).toEqual({});
  });
});

describe('PR-5.2 Combat-Multihog Importer & SystemPack Exporter', () => {
  it('converts wrapper Multihog cartridge with gameSystems, customFields, and sections into SystemPack', () => {
    const multihogWrapper = {
      format: 'multihog-game-cartridge',
      name: 'Cyberpunk Heist Pack',
      payload: {
        id: 'cyber-heist',
        description: 'High-stakes netrunner and heat tracking.',
        npcCoreSections: [
          {
            id: 'sec_chrome',
            name: 'Installed Chrome',
            description: 'Visible cybernetic augmentations.',
            fieldType: 'bullet_list',
            writableByTracker: true,
          },
        ],
        pcCoreSections: [
          {
            id: 'sec_rig',
            name: 'Deck & Rig',
            description: 'Active cyberdeck loadout.',
            type: 'prose',
          },
        ],
        gameSystems: [
          {
            id: 'heat_tracker',
            name: 'Corporate Heat',
            target: 'global',
            cadence: 'every_turn',
            fields: {
              alert_level: { type: 'meter', min: 0, max: 100, default: 10 },
              lockdown: { type: 'boolean', default: false },
            },
            trackerInstruction: 'Increase alert_level when alarms trigger.',
            narratorRule: 'Escalate security presence at high alert_level.',
          },
        ],
        customFields: [
          {
            key: 'cred_balance',
            target: 'player',
            type: 'counter',
            min: 0,
            default: 500,
          },
          {
            key: 'stance',
            target: 'npc',
            type: 'enum',
            options: ['wary', 'hostile', 'bought'],
            default: 'wary',
          },
        ],
        narrativePacing: { mode: 'fast_forward', enabled: true },
        cyoaConfig: { enabled: true, prompt: 'Offer 3 tactical breach options.' },
        skills: [
          {
            id: 'icebreaker_strike',
            name: 'ICEbreaker Strike',
            category: 'attack',
            actionCost: 'action',
            resourceCosts: { stamina: 10 },
            targeting: { shape: 'single_enemy', minRange: 1, maxRange: 3, requiresLos: true },
            hitResolution: { kind: 'attack_roll', stat: 'dex' },
            effects: [{ type: 'damage', dice: '1d8', flat: 2 }],
          },
        ],
        blockOrder: ['SCENE', 'CHARACTER', 'HEAT', 'CHRONICLE'],
        syspromptSectionOrder: ['system', 'narrative_pacing', 'game_system_rules', 'persona', 'state'],
      },
    };

    const res = importMultihogCartridge(multihogWrapper);
    expect(isOk(res)).toBe(true);
    if (!res.ok) return;

    const { systemPack, combatOverrides, warnings } = res.value;
    expect(warnings).toHaveLength(0);
    expect(systemPack.spec).toBe('system-pack/0.1');
    expect(systemPack.id).toBe('cyber-heist');
    expect(systemPack.name).toBe('Cyberpunk Heist Pack');
    expect(systemPack.npcCoreSections).toHaveLength(1);
    expect(systemPack.npcCoreSections[0]!.fieldType).toBe('bullet_list');
    expect(systemPack.pcCoreSections).toHaveLength(1);
    expect(systemPack.capabilities.combatMode).toBe('tactical_grid');
    expect(combatOverrides?.skills).toHaveLength(1);
    expect(combatOverrides?.skills?.[0]?.id).toBe('icebreaker_strike');

    const json = exportSystemPackToJson(systemPack);
    const reparsed = loadSystemPackFromJson(json);
    expect(isOk(reparsed)).toBe(true);

    const layer = exportSystemPackToControlRoomLayer(STOCK_TACTICAL_RPG_PACK);
    expect(layer.capabilities?.combatMode).toBe('tactical_grid');
    expect(layer.gameSystems?.length).toBe(STOCK_TACTICAL_RPG_PACK.gameSystems.length);
    // Verify mutation isolation
    layer.blockOrder!.push('MUTATED');
    expect(STOCK_TACTICAL_RPG_PACK.blockOrder).not.toContain('MUTATED');
  });

  it('accepts flat Multihog payload and rejects prototype pollution', () => {
    const flatRes = importMultihogCartridge({
      gameSystems: [],
      customFields: {
        sanity: { type: 'meter', min: 0, max: 100, default: 80, target: 'player' },
      },
    });
    expect(isOk(flatRes)).toBe(true);
    if (!flatRes.ok) return;
    expect(flatRes.value.systemPack.gameSystems.some((g) => g.id === 'custom_fields_player')).toBe(true);

    const polluted = JSON.parse('{"__proto__":{"admin":true},"gameSystems":[]}') as unknown;
    const badRes = importMultihogCartridge(polluted);
    expect(isErr(badRes)).toBe(true);
  });
});

describe('PR-5.2 NeoTerra Season Importer', () => {
  it('translates synthetic NeoTerra season covering all predicate kinds and postVictory routes cleanly', () => {
    const syntheticData = {
      factions: {
        factions: [
          {
            id: 'clarity',
            name: 'Clarity Inc',
            side: 'villain',
            influence: 80,
            headquartersLocationId: 'clarity-hq',
            goals: ['Dominate'],
          },
          {
            id: 'petrabyte',
            name: 'PetraByte',
            side: 'hero',
            influence: 60,
            headquartersLocationId: 'petrabyte-tower',
            goals: ['Protect'],
          },
        ],
      },
      locations: {
        locations: [
          {
            id: 'petrabyte-tower',
            name: 'PetraByte Tower',
            kind: 'base',
            factionId: 'petrabyte',
            connections: ['clarity-hq'],
            tags: ['downtown'],
            description: 'Hero tower.',
          },
          {
            id: 'clarity-hq',
            name: 'Clarity HQ',
            kind: 'base',
            factionId: 'clarity',
            connections: ['petrabyte-tower'],
            tags: ['downtown'],
            description: 'Villain tower.',
          },
        ],
      },
      agendas: {
        defaults: {
          factionInfluencePerDay: 0.5,
          mainThreatProgressPerDay: 1.0,
          secondaryThreatProgressPerDay: 0.5,
          maxFactionDeltaPerTick: 5,
          maxNpcMovesPerTick: 2,
          maxDaysPerTick: 14,
          rumorsPerTick: 2,
          rumorTemplates: ['Word in {location}: {faction} moves.'],
        },
      },
      characters: {
        index: {
          entries: [
            {
              id: 'hero.vaiva',
              cardPath: 'Chars/S1/Vaiva.json',
              displayName: 'Vaiva',
              side: 'hero',
              formGroup: 'group.vaiva',
            },
            {
              id: 'hero.vaiva.alt',
              cardPath: 'Chars/S1/VaivaAlt.json',
              displayName: 'Light Shade',
              side: 'villain',
              formGroup: 'group.vaiva',
            },
          ],
        },
        profiles: {
          'hero.vaiva': {
            name: 'Vaiva',
            species: 'Metahuman',
            appearance: 'Radiant prism armor.',
            traits: ['Resolute'],
          },
        },
      },
      formGroups: {
        groups: [
          {
            id: 'group.vaiva',
            seasonId: 'test-s1',
            base: 'S1/Vaiva.json',
            members: ['S1/Vaiva.json', 'S1/VaivaAlt.json'],
          },
        ],
      },
      season: {
        id: 'test-s1',
        title: 'Test Season 1',
        anchorDate: '2037-03-01',
        premise: 'A test NeoTerra arc.',
        toneNotes: 'Heroic melodrama.',
        startLocationId: 'petrabyte-tower',
        defaultPlayerCharacterId: 'hero.vaiva',
        roster: [
          { characterId: 'hero.vaiva', formId: 'hero.vaiva', locationId: 'petrabyte-tower' },
        ],
        factions: [{ id: 'clarity', influence: 85, status: 'dominant' }],
        threats: [
          {
            id: 'threat.main',
            name: 'Clarity Escalation',
            rank: 'main',
            sourceFactionId: 'clarity',
            agenda: 'Convert city',
            stages: ['Stage 0', 'Stage 1', 'Stage 2'],
            progress: 10,
            locationId: 'clarity-hq',
          },
        ],
        canonBeats: [
          {
            id: 'beat.opening',
            order: 10,
            title: 'Opening Skirmish',
            description: 'Interrupt Clarity.',
            act: 'opening',
            conditions: { turnRange: [0, 10], locationIds: ['clarity-hq'], actorIds: ['hero.vaiva'] },
            completion: {
              predicates: [
                { kind: 'event-tag', tag: 'skirmish' },
                { kind: 'threat-stage', threatId: 'threat.main', stage: 1 },
                { kind: 'relationship-affinity', fromId: 'hero.vaiva', toId: 'clarity', op: '>=', value: -50 },
                { kind: 'flag', flag: 'city.alerted', value: true },
              ],
            },
            flexibility: 'strict',
            deadlineTurns: 10,
            deadlineConsequence: 'Clarity escalates.',
          },
          {
            id: 'beat.resolution',
            order: 20,
            title: 'Final Showdown',
            description: 'Reclaim HQ or transform.',
            act: 'resolution',
            conditions: { requiresBeats: ['beat.opening'] },
            completion: {
              predicates: [
                { kind: 'beat-resolved', beatId: 'beat.opening' },
                { kind: 'location-control', locationId: 'clarity-hq', factionId: 'petrabyte' },
                { kind: 'form-active', characterId: 'hero.vaiva', formId: 'hero.vaiva.alt' },
                { kind: 'character-status', characterId: 'hero.vaiva', statuses: ['active', 'corrupted'] },
              ],
            },
            flexibility: 'adaptable',
            deadlineTurns: 50,
          },
        ],
        finalDeadline: { turns: 50 },
        postVictory: {
          resistance: {
            title: 'Underground Resistance',
            beats: [
              {
                id: 'post.res.1',
                order: 100,
                title: 'Gather Allies',
                description: 'Rally survivors.',
                completion: { predicates: [{ kind: 'event-tag', tag: 'rally' }] },
                flexibility: 'adaptable',
                deadlineTurns: 15,
              },
            ],
          },
          'join-villain': {
            title: 'Join Clarity',
            beats: [
              {
                id: 'post.join.1',
                order: 100,
                title: 'Swear Loyalty',
                description: 'Serve the new order.',
                completion: { predicates: [{ kind: 'flag', flag: 'joined', value: true }] },
                flexibility: 'adaptable',
                deadlineTurns: 15,
              },
            ],
          },
        },
      },
    };

    const res = importNeoTerraSeasonFromData(syntheticData);
    expect(isOk(res)).toBe(true);
    if (!res.ok) return;

    const bundle = res.value;
    expect(bundle.card.recommendedSystemPack).toBe('stock-living-world');
    expect(bundle.routes).toHaveLength(2);
    expect(bundle.endings).toHaveLength(4);
    expect(detectBeatCycles(bundle.beats)).toHaveLength(0);
    expect(validateCrossFileReferences(bundle)).toHaveLength(0);

    const analysis = analyzeCartridgeGraph(bundle, { maxExploreStates: 2048 });
    expect(analysis.ok).toBe(true);
    expect(analysis.deadlockStatesDetected).toBe(false);
    expect(analysis.unreachableBeatIds).toHaveLength(0);
    expect(analysis.unreachableEndingIds).toHaveLength(0);
  });

  const hasNeoTerraDir = existsSync(NEOTERRA_DATA_DIR);

  it('rejects unsafe seasonId path traversal in importNeoTerraSeasonFromDirectory', async () => {
    const res = await importNeoTerraSeasonFromDirectory(NEOTERRA_DATA_DIR, '../factions');
    expect(isErr(res)).toBe(true);
    if (res.ok) return;
    expect(res.error[0]?.code).toBe('INVALID_SEASON_ID');
  });

  it.skipIf(!hasNeoTerraDir)(
    'imports real NeoTerra s1 and s1dark seasons from disk and passes validation + graph checks',
    async () => {
      for (const seasonId of ['s1', 's1dark']) {
        const res = await importNeoTerraSeasonFromDirectory(NEOTERRA_DATA_DIR, seasonId);
        expect(isOk(res)).toBe(true);
        if (!res.ok) continue;

        const bundle = res.value;
        expect(bundle.card.recommendedSystemPack).toBe('stock-living-world');
        expect(detectBeatCycles(bundle.beats)).toHaveLength(0);
        expect(validateCrossFileReferences(bundle)).toHaveLength(0);

        const validated = validateCartridgeStructure(bundle);
        expect(isOk(validated)).toBe(true);

        const analysis = analyzeCartridgeGraph(bundle, { maxExploreStates: 4096 });
        expect(analysis.errors).toEqual([]);
        expect(analysis.ok).toBe(true);
        expect(analysis.deadlockStatesDetected).toBe(false);

        if (seasonId === 's1') {
          const vaiva = bundle.initialEntities?.characters?.['s1.vaiva.colorgarde'];
          expect(vaiva).toBeDefined();
          expect(vaiva?.cardSheet).toBeDefined();
          expect(vaiva?.cardSheet?.description).toContain('Colorgarde');
          expect(vaiva?.cardSheet?.firstMes).toContain('Colorgarde');
          expect(vaiva?.cardSheet?.mesExample).toContain('PetraByte');
          expect(vaiva?.cardSheet?.portraitAssetPath).toContain('Vaiva');
          expect(vaiva?.sections['sec_body']).toBeDefined();
          expect(vaiva?.sections['sec_superpowers']).toBeDefined();

          const atroposCouple = bundle.initialEntities?.characters?.['s1.atropos.couple'];
          expect(atroposCouple?.cardSheet?.name).toBe('Atropos couple');

          const plaza = bundle.initialEntities?.locations?.['central-plaza'];
          expect(plaza?.geometry).toEqual({
            x: 995,
            y: 698,
            districtId: 'downtown',
            regionId: 'region:center',
            mapRef: { layer: 'keyLocation', id: 'key:city-core' },
          });
          expect(plaza?.mapAssets?.imagePath).toBe('NeoTerra.png');
          expect(plaza?.connectionsMeta?.['petrabyte-tower']?.travelModes).toEqual(['walk']);

          const formRuleIds = (bundle.initialEntities?.formRules ?? []).map((r) => r.id);
          expect(formRuleIds).toEqual(
            expect.arrayContaining([
              'rule.s1.vaiva.corrupted',
              'rule.s1.aurelia.corrupted',
              'rule.s1.tindur.corrupted',
              'rule.s1.claire.cleansed',
              'rule.s1.claire.cleansed.reverse',
              'rule.s1.vaiva.blazing-prism',
            ])
          );

          expect(Object.keys(bundle.loreFiles)).toEqual(
            expect.arrayContaining(['lore/season-overview.md', 'lore/districts.md'])
          );
          expect(bundle.beats.some((b) => b.class === 'ambient' && b.lore?.startsWith('lore/lorebooks/'))).toBe(true);
        }
      }
    }
  );
});
