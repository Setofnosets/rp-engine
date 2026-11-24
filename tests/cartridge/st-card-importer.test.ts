import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { validateCartridgeStructure } from '../../src/cartridge/cartridge-schema.js';
import { exportCartridgeToPngCard } from '../../src/cartridge/exporters/st-lossy-exporter.js';
import {
  extractCharaJsonFromPng,
  importPngAsCartridge,
  importPngAsCharacterEntity,
  importPngAsPlayerPersona,
  importSillyTavernCard,
} from '../../src/cartridge/importers/st-card-importer.js';
import { loadCartridgeFromDirectory } from '../../src/cartridge/loader.js';
import {
  PNG_SIGNATURE,
  computePngChunkCrc,
  embedCharaJsonInPng,
} from '../../src/cartridge/png-card-codec.js';
import { isErr, isOk } from '../../src/core/result.js';
import {
  cloneWorldState,
  createWorldState,
  validateWorldState,
} from '../../src/state/world-state.js';

function makeChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.allocUnsafe(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.allocUnsafe(4);
  crc.writeUInt32BE(computePngChunkCrc(type, data), 0);
  return Buffer.concat([len, Buffer.from(type, 'ascii'), data, crc]);
}

function createSamplePng(): Buffer {
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(1, 0);
  ihdrData.writeUInt32BE(1, 4);
  ihdrData.writeUInt8(8, 8);
  ihdrData.writeUInt8(6, 9);
  const idatData = deflateSync(Buffer.from([0, 10, 20, 30, 255]));
  return Buffer.concat([
    PNG_SIGNATURE,
    makeChunk('IHDR', ihdrData),
    makeChunk('IDAT', idatData),
    makeChunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('PR-7.1 SillyTavern PNG Card Workflows & Binary Asset Store', () => {
  const v3Card = {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      name: 'Kaelen Voss',
      description: 'A former clockwork artificer.',
      personality: 'Dry-witted, loyal',
      scenario: 'Workshop above the canal.',
      first_mes: 'He wipes grease from his goggles.',
      alternate_greetings: ['"Back so soon?"'],
      mes_example: '<START>\n{{user}}: Need a gear.\n{{char}}: Brass or steel?',
      creator_notes: 'Keep pacing brisk.',
      system_prompt: 'Stay grounded in steampunk detail.',
      post_history_instructions: 'Never skip sensory cues.',
      tags: ['artificer', 'canal'],
      creator: 'TestSuite',
      character_version: '2.1.0',
      character_book: {
        entries: [
          {
            id: 7,
            keys: ['automaton', 'clockwork'],
            secondary_keys: ['spring'],
            content: 'Mainspring automatons require winding every twelve hours.',
            constant: false,
            insertion_order: 30,
            enabled: true,
            name: 'Clockwork Lore',
          },
        ],
      },
    },
  };

  it('imports PNG via importPngAsCartridge preserving raw portrait bytes and CharacterCardSheet', () => {
    const basePng = createSamplePng();
    const embedded = embedCharaJsonInPng(basePng, v3Card, 'ccv3', { chunkType: 'zTXt' });
    expect(isOk(embedded)).toBe(true);
    if (!embedded.ok) return;

    const res = importPngAsCartridge(embedded.value, {
      recommendedSystemPack: 'stock-freeform',
    });
    expect(isOk(res)).toBe(true);
    if (!res.ok) return;

    const bundle = res.value;
    expect(bundle.card.id).toBe('kaelen-voss');
    expect(bundle.card.recommendedSystemPack).toBe('stock-freeform');
    expect(bundle.binaryAssets?.['assets/portraits/kaelen-voss.png']).toBeInstanceOf(Uint8Array);
    expect(
      Buffer.from(bundle.binaryAssets!['assets/portraits/kaelen-voss.png']!).equals(embedded.value)
    ).toBe(true);

    const entity = bundle.initialEntities?.characters?.['kaelen-voss'];
    expect(entity).toBeDefined();
    expect(entity?.portraitAsset).toBe('assets/portraits/kaelen-voss.png');
    expect(entity?.cardSheet?.sourceSpec).toBe('v3');
    expect(entity?.cardSheet?.personality).toBe('Dry-witted, loyal');
    expect(entity?.cardSheet?.alternateGreetings).toEqual(['"Back so soon?"']);
    expect(entity?.cardSheet?.embeddedLoreEntries).toHaveLength(1);
    expect(entity?.cardSheet?.embeddedLoreEntries[0]?.secondaryKeys).toEqual(['spring']);

    // Backward-compatible importSillyTavernCard also retains portrait bytes
    const legacyRes = importSillyTavernCard(embedded.value);
    expect(isOk(legacyRes)).toBe(true);
    if (legacyRes.ok) {
      expect(legacyRes.value.binaryAssets?.['assets/portraits/kaelen-voss.png']).toBeDefined();
    }
    expect(isOk(extractCharaJsonFromPng(embedded.value))).toBe(true);
  });

  it('imports PNG as a drop-in CharacterEntity and binds cleanly into WorldState without storing bytes in WorldState', () => {
    const basePng = createSamplePng();
    const embedded = embedCharaJsonInPng(basePng, v3Card, 'chara', { chunkType: 'iTXt' });
    expect(isOk(embedded)).toBe(true);
    if (!embedded.ok) return;

    const charRes = importPngAsCharacterEntity(embedded.value, {
      id: 'npc-kaelen',
      locationId: 'canal-workshop',
      presentInScene: true,
    });
    expect(isOk(charRes)).toBe(true);
    if (!charRes.ok) return;

    const { entity, portraitAssetPath, portraitBytes } = charRes.value;
    expect(entity.id).toBe('npc-kaelen');
    expect(portraitAssetPath).toBe('assets/portraits/npc-kaelen.png');
    expect(Buffer.from(portraitBytes).equals(embedded.value)).toBe(true);

    const state = createWorldState({
      sessionId: 'sess-7-1',
      characters: { [entity.id]: entity },
    });
    const validated = validateWorldState(state);
    expect(isOk(validated)).toBe(true);
    const cloned = cloneWorldState(state);
    expect(cloned.entities.characters['npc-kaelen']?.cardSheet?.name).toBe('Kaelen Voss');
    expect(cloned.entities.characters['npc-kaelen']?.cardSheet).not.toBe(entity.cardSheet);
    expect(JSON.stringify(cloned)).not.toContain('Buffer');
  });

  it('imports PNG as player personaCard + portraitAsset on WorldState.player', () => {
    const basePng = createSamplePng();
    const embedded = embedCharaJsonInPng(basePng, v3Card, 'ccv3', { chunkType: 'tEXt' });
    expect(isOk(embedded)).toBe(true);
    if (!embedded.ok) return;

    const personaRes = importPngAsPlayerPersona(embedded.value);
    expect(isOk(personaRes)).toBe(true);
    if (!personaRes.ok) return;

    const state = createWorldState({
      sessionId: 'sess-persona',
      player: {
        name: personaRes.value.name,
        personaCard: personaRes.value.personaCard,
        portraitAsset: personaRes.value.portraitAssetPath,
      },
    });
    const validated = validateWorldState(state);
    expect(isOk(validated)).toBe(true);
    if (!validated.ok) return;
    expect(validated.value.state.player.personaCard?.name).toBe('Kaelen Voss');
    expect(validated.value.state.player.portraitAsset).toBe('assets/portraits/kaelen-voss.png');
  });

  it('round-trips CartridgeBundle back to a valid PNG card via exportCartridgeToPngCard', () => {
    const basePng = createSamplePng();
    const embedded = embedCharaJsonInPng(basePng, v3Card, 'ccv3');
    expect(isOk(embedded)).toBe(true);
    if (!embedded.ok) return;

    const imported = importPngAsCartridge(embedded.value);
    expect(isOk(imported)).toBe(true);
    if (!imported.ok) return;

    const exportedPng = exportCartridgeToPngCard(imported.value, basePng, {
      keyword: 'ccv3',
      chunkType: 'iTXt',
    });
    expect(isOk(exportedPng)).toBe(true);
    if (!exportedPng.ok) return;

    const reimported = importPngAsCartridge(exportedPng.value);
    expect(isOk(reimported)).toBe(true);
    if (!reimported.ok) return;

    expect(reimported.value.card.persona.name).toBe('Kaelen Voss');
    expect(reimported.value.card.persona.scenario).toBe('Workshop above the canal.');
    expect(reimported.value.card.persona.firstMessage).toBe('He wipes grease from his goggles.');
    expect(reimported.value.beats.length).toBeGreaterThanOrEqual(1);
  });

  it('loads binary assets under assets/ in loadCartridgeFromDirectory and rejects unsafe binaryAssets paths', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'rp-engine-pr71-'));
    try {
      await mkdir(path.join(tmpDir, 'assets', 'portraits'), { recursive: true });
      await mkdir(path.join(tmpDir, 'assets', 'endings'), { recursive: true });
      const samplePng = createSamplePng();

      await writeFile(
        path.join(tmpDir, 'card.json'),
        JSON.stringify({
          spec: 'cartridge/0.1',
          id: 'asset-test',
          version: '1.0.0',
          title: 'Asset Test',
          description: 'Tests binary asset loading',
          persona: { name: 'Tester', description: 'Desc' },
        }),
        'utf8'
      );
      await writeFile(path.join(tmpDir, 'assets', 'portraits', 'hero.png'), samplePng);
      await writeFile(path.join(tmpDir, 'assets', 'endings', 'true.md'), '# Ending', 'utf8');

      const loaded = await loadCartridgeFromDirectory(tmpDir);
      expect(isOk(loaded)).toBe(true);
      if (!loaded.ok) return;

      expect(loaded.value.binaryAssets?.['assets/portraits/hero.png']).toBeInstanceOf(Uint8Array);
      expect(
        Buffer.from(loaded.value.binaryAssets!['assets/portraits/hero.png']!).equals(samplePng)
      ).toBe(true);
      expect(loaded.value.binaryAssets?.['assets/endings/true.md']).toBeUndefined();
      expect(loaded.value.endingPromptFiles['assets/endings/true.md']).toBe('# Ending');

      const badBundle = {
        ...loaded.value,
        binaryAssets: {
          'assets/../escape.png': new Uint8Array([1, 2, 3]),
        },
      };
      expect(isErr(validateCartridgeStructure(badBundle))).toBe(true);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
