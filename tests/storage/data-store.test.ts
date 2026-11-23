import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CartridgeBundle } from '../../src/cartridge/cartridge-schema.js';
import type { UserPersonaPreset } from '../../src/config/persona-preset.js';
import { isErr, isOk } from '../../src/core/result.js';
import type { ConnectionsFileDocument } from '../../src/gateway/connection-store.js';
import { STOCK_FREEFORM_PACK } from '../../src/schema/stock-system-packs.js';
import type { SystemPack } from '../../src/schema/tracker-module.js';
import {
  RefereeDataStore,
  type SaveControlRoomPresetInput,
  type SavedControlRoomPreset,
  validateSafeStorageId,
} from '../../src/storage/data-store.js';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'referee-data-store-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

function makePreset(
  overrides: Partial<SaveControlRoomPresetInput> = {}
): SaveControlRoomPresetInput {
  return {
    id: 'storyteller-balanced',
    name: 'Storyteller Balanced',
    description: 'Balanced narrative preset',
    sourceFormat: 'referee',
    layer: {
      tuningDials: {
        beatPressure: 'standard',
        narrativePacing: 'balanced',
        cyoaEnabled: true,
      },
      generation: {
        presetName: 'Balanced',
        sourceFormat: 'referee',
        temperature: 0.75,
        maxTokens: 1024,
        stopSequences: ['\nUser:'],
      },
    },
    ...overrides,
  };
}

function makePersona(overrides: Partial<UserPersonaPreset> = {}): UserPersonaPreset {
  return {
    id: 'kael-traveler',
    name: 'Kael',
    description: 'A weary courier carrying sealed letters.',
    sections: {
      appearance: 'Weathered cloak and ink-stained gloves.',
      traits: ['observant', 'guarded'],
    },
    resources: {
      stamina: { current: 8, max: 10 },
    },
    progression: {
      level: 2,
      xp: 120,
      className: 'Courier',
      attributes: { agility: 14 },
    },
    ...overrides,
  };
}

function makeSystemPack(id = 'custom-noir-pack'): SystemPack {
  return {
    ...STOCK_FREEFORM_PACK,
    id,
    name: 'Noir Investigation Pack',
    description: 'Custom noir mystery rules.',
  };
}

function makeCartridgeBundle(id = 'harbor-mystery'): CartridgeBundle {
  return {
    rootDir: null,
    card: {
      spec: 'cartridge/0.1',
      id,
      version: '1.0.0',
      title: 'Harbor Mystery',
      author: 'Referee Test',
      description: 'Foggy docks investigation.',
      persona: {
        name: 'Inspector Vance',
        description: 'A sharp-eyed harbor detective.',
        firstMessage: 'The fog rolls off Pier 4.',
      },
    },
    beats: [],
    routes: [],
    endings: [],
    loreFiles: {
      'lore/docks.md': 'Pier 4 has been abandoned since winter.',
    },
    endingPromptFiles: {},
    scriptFiles: {},
  };
}

describe('validateSafeStorageId', () => {
  it('accepts valid single-segment identifiers', () => {
    expect(isOk(validateSafeStorageId('my-preset_01'))).toBe(true);
    expect(isOk(validateSafeStorageId('session_alpha'))).toBe(true);
    expect(isOk(validateSafeStorageId('CrimsonKeep'))).toBe(true);
  });

  it('rejects empty, whitespace, traversal, Windows reserved chars, NUL bytes, and prototype-pollution keys', () => {
    const invalidIds = [
      '',
      '   ',
      '\t\n',
      ' leading',
      'trailing ',
      '.',
      '..',
      '../evil',
      '..\\evil',
      'a/b',
      'a\\b',
      'foo.bar',
      'foo..bar',
      'bad\0id',
      'bad\nid',
      'bad<id',
      'bad>id',
      'bad:id',
      'bad"id',
      'bad|id',
      'bad?id',
      'bad*id',
      '__proto__',
      'constructor',
      'prototype',
    ];

    for (const id of invalidIds) {
      const res = validateSafeStorageId(id);
      expect(isErr(res), `expected "${id}" to be rejected`).toBe(true);
    }
  });
});

describe('RefereeDataStore initialization and connections', () => {
  it('initializes all standard subdirectories under dataDir', async () => {
    const rootDir = path.join(await makeTempDir(), 'data');
    const store = new RefereeDataStore(rootDir);

    const initRes = await store.init();
    expect(isOk(initRes)).toBe(true);

    for (const sub of ['presets', 'personas', 'system-packs', 'cartridges', 'saves']) {
      const stat = await fs.stat(path.join(rootDir, sub));
      expect(stat.isDirectory()).toBe(true);
    }
  });

  it('returns empty resilient lists when directories do not exist yet', async () => {
    const rootDir = path.join(await makeTempDir(), 'uninitialized-data');
    const store = new RefereeDataStore(rootDir);

    expect(await store.listPresets()).toEqual({ items: [], warnings: [] });
    expect(await store.listPersonas()).toEqual({ items: [], warnings: [] });
    expect(await store.listSystemPacks()).toEqual({ items: [], warnings: [] });
    expect(await store.listCartridges()).toEqual({ items: [], warnings: [] });
    expect(await store.listSavedSessionIds()).toEqual({ items: [], warnings: [] });
  });

  it('round-trips and atomically overwrites connections.json via connection-store', async () => {
    const rootDir = await makeTempDir();
    const store = new RefereeDataStore(rootDir);
    await store.init();

    expect(store.getConnectionsPath()).toBe(path.join(path.resolve(rootDir), 'connections.json'));
    const missingRes = await store.loadConnections();
    expect(isErr(missingRes)).toBe(true);

    const docV1: ConnectionsFileDocument = {
      version: 1,
      activeProfile: 'local',
      defaultConnection: {
        provider: 'ollama',
        baseUrl: 'http://127.0.0.1:11434',
        model: 'llama3.2',
      },
      profiles: {
        local: {
          defaultConnection: {
            provider: 'ollama',
            baseUrl: 'http://127.0.0.1:11434',
            model: 'llama3.2',
          },
        },
      },
    };

    const saveV1 = await store.saveConnections(docV1);
    expect(isOk(saveV1)).toBe(true);

    const loadedV1 = await store.loadConnections();
    expect(isOk(loadedV1)).toBe(true);
    if (loadedV1.ok) {
      expect(loadedV1.value.defaultConnection?.model).toBe('llama3.2');
    }

    const docV2: ConnectionsFileDocument = {
      ...docV1,
      defaultConnection: {
        provider: 'openai_compatible',
        baseUrl: 'https://api.example.com/v1',
        model: 'gpt-4o-mini',
        apiKey: 'secret-key',
      },
    };
    expect(isOk(await store.saveConnections(docV2))).toBe(true);

    const loadedV2 = await store.loadConnections();
    expect(isOk(loadedV2)).toBe(true);
    if (loadedV2.ok) {
      expect(loadedV2.value.defaultConnection?.model).toBe('gpt-4o-mini');
      expect(loadedV2.value.defaultConnection?.apiKey).toBe('secret-key');
    }
  });
});

describe('RefereeDataStore CRUD round-trips and atomic overwrites', () => {
  it('performs full CRUD round-trip and atomic overwrite for presets', async () => {
    const rootDir = await makeTempDir();
    const store = new RefereeDataStore(rootDir);
    await store.init();

    const save1 = await store.savePreset(makePreset({ id: 'preset-b', name: 'Preset B' }));
    const save2 = await store.savePreset(
      makePreset({
        id: 'preset-a',
        name: 'Preset A',
        sourceFormat: 'st_chat_completion',
        updatedAt: '2026-01-15T12:00:00.000Z',
      })
    );
    expect(isOk(save1)).toBe(true);
    expect(isOk(save2)).toBe(true);
    if (save1.ok) {
      expect(Number.isNaN(Date.parse(save1.value.updatedAt))).toBe(false);
    }
    if (save2.ok) {
      expect(save2.value.updatedAt).toBe('2026-01-15T12:00:00.000Z');
    }

    // Overwrite preset-a atomically
    const overwrite = await store.savePreset(
      makePreset({
        id: 'preset-a',
        name: 'Preset A Updated',
        sourceFormat: 'st_text_completion',
        updatedAt: '2026-02-01T00:00:00.000Z',
      })
    );
    expect(isOk(overwrite)).toBe(true);

    const getRes = await store.getPreset('preset-a');
    expect(isOk(getRes)).toBe(true);
    if (getRes.ok) {
      const preset: SavedControlRoomPreset = getRes.value;
      expect(preset.name).toBe('Preset A Updated');
      expect(preset.sourceFormat).toBe('st_text_completion');
      expect(preset.updatedAt).toBe('2026-02-01T00:00:00.000Z');
    }

    const listRes = await store.listPresets();
    expect(listRes.warnings).toEqual([]);
    expect(listRes.items.map((p) => p.id)).toEqual(['preset-a', 'preset-b']);

    // No temp files remain
    const files = await fs.readdir(path.join(rootDir, 'presets'));
    expect(files.sort()).toEqual(['preset-a.json', 'preset-b.json']);

    expect(isOk(await store.deletePreset('preset-a'))).toBe(true);
    const afterDeleteGet = await store.getPreset('preset-a');
    expect(isErr(afterDeleteGet)).toBe(true);
    if (!afterDeleteGet.ok) {
      expect(afterDeleteGet.error[0]?.code).toBe('NOT_FOUND');
    }

    const afterDeleteList = await store.listPresets();
    expect(afterDeleteList.items.map((p) => p.id)).toEqual(['preset-b']);
  });

  it('performs full CRUD round-trip and atomic overwrite for personas', async () => {
    const rootDir = await makeTempDir();
    const store = new RefereeDataStore(rootDir);
    await store.init();

    const save1 = await store.savePersona(makePersona({ id: 'persona-1' }));
    expect(isOk(save1)).toBe(true);
    if (save1.ok) {
      expect(typeof save1.value.updatedAt).toBe('string');
    }

    const save2 = await store.savePersona(
      makePersona({
        id: 'persona-1',
        name: 'Kael the Bold',
        updatedAt: '2026-03-10T08:30:00.000Z',
      })
    );
    expect(isOk(save2)).toBe(true);

    const getRes = await store.getPersona('persona-1');
    expect(isOk(getRes)).toBe(true);
    if (getRes.ok) {
      expect(getRes.value.name).toBe('Kael the Bold');
      expect(getRes.value.updatedAt).toBe('2026-03-10T08:30:00.000Z');
    }

    const listRes = await store.listPersonas();
    expect(listRes.warnings).toEqual([]);
    expect(listRes.items).toHaveLength(1);

    expect(isOk(await store.deletePersona('persona-1'))).toBe(true);
    expect(isErr(await store.getPersona('persona-1'))).toBe(true);
    expect((await store.listPersonas()).items).toEqual([]);
  });

  it('performs full CRUD round-trip and atomic overwrite for system packs', async () => {
    const rootDir = await makeTempDir();
    const store = new RefereeDataStore(rootDir);
    await store.init();

    const pack1 = makeSystemPack('noir-pack');
    expect(isOk(await store.saveSystemPack(pack1))).toBe(true);

    const pack2: SystemPack = { ...pack1, name: 'Noir Pack v2' };
    expect(isOk(await store.saveSystemPack(pack2))).toBe(true);

    const getRes = await store.getSystemPack('noir-pack');
    expect(isOk(getRes)).toBe(true);
    if (getRes.ok) {
      expect(getRes.value.name).toBe('Noir Pack v2');
    }

    const listRes = await store.listSystemPacks();
    expect(listRes.warnings).toEqual([]);
    expect(listRes.items.map((p) => p.id)).toEqual(['noir-pack']);

    expect(isOk(await store.deleteSystemPack('noir-pack'))).toBe(true);
    expect(isErr(await store.getSystemPack('noir-pack'))).toBe(true);
  });

  it('performs full CRUD round-trip and atomic overwrite for cartridge bundles', async () => {
    const rootDir = await makeTempDir();
    const store = new RefereeDataStore(rootDir);
    await store.init();

    const bundle1 = makeCartridgeBundle('harbor-mystery');
    expect(isOk(await store.saveCartridgeBundle(bundle1))).toBe(true);

    const files = await fs.readdir(path.join(rootDir, 'cartridges'));
    expect(files).toEqual(['harbor-mystery.bundle.json']);

    const bundle2: CartridgeBundle = {
      ...bundle1,
      card: { ...bundle1.card, version: '1.1.0', title: 'Harbor Mystery Director Cut' },
    };
    expect(isOk(await store.saveCartridgeBundle(bundle2))).toBe(true);

    const getRes = await store.getCartridgeBundle('harbor-mystery');
    expect(isOk(getRes)).toBe(true);
    if (getRes.ok) {
      expect(getRes.value.card.title).toBe('Harbor Mystery Director Cut');
      expect(getRes.value.loreFiles['lore/docks.md']).toBe(
        'Pier 4 has been abandoned since winter.'
      );
    }

    const listRes = await store.listCartridges();
    expect(listRes.warnings).toEqual([]);
    expect(listRes.items.map((c) => c.card.id)).toEqual(['harbor-mystery']);

    expect(isOk(await store.deleteCartridgeBundle('harbor-mystery'))).toBe(true);
    expect(isErr(await store.getCartridgeBundle('harbor-mystery'))).toBe(true);
  });

  it('discovers saved session directories and resolves contained save paths', async () => {
    const rootDir = await makeTempDir();
    const store = new RefereeDataStore(rootDir);
    await store.init();

    const dirRes = store.getSessionSaveDir('campaign-01');
    expect(isOk(dirRes)).toBe(true);
    if (dirRes.ok) {
      expect(dirRes.value).toBe(path.join(path.resolve(rootDir), 'saves', 'campaign-01'));
    }

    await fs.mkdir(path.join(rootDir, 'saves', 'session-b'), { recursive: true });
    await fs.mkdir(path.join(rootDir, 'saves', 'session-a'), { recursive: true });
    await fs.mkdir(path.join(rootDir, 'saves', 'bad.session'), { recursive: true });
    await fs.writeFile(path.join(rootDir, 'saves', 'stray-file.txt'), 'ignore', 'utf8');

    const listed = await store.listSavedSessionIds();
    expect(listed.items).toEqual(['session-a', 'session-b']);
    expect(listed.warnings.length).toBeGreaterThan(0);
  });
});

describe('RefereeDataStore corrupt file resilience and security hardening', () => {
  it('skips corrupt JSON, invalid schemas, mismatched IDs, and leftover .tmp files when listing', async () => {
    const rootDir = await makeTempDir();
    const store = new RefereeDataStore(rootDir);
    await store.init();

    await store.savePreset(makePreset({ id: 'valid-preset' }));
    await fs.writeFile(path.join(rootDir, 'presets', 'corrupt.json'), '{ not valid json', 'utf8');
    await fs.writeFile(
      path.join(rootDir, 'presets', 'wrong-id.json'),
      JSON.stringify(makePreset({ id: 'other-id', updatedAt: '2026-01-01T00:00:00.000Z' })),
      'utf8'
    );
    await fs.writeFile(
      path.join(rootDir, 'presets', 'polluted.json'),
      '{"id":"polluted","name":"Evil","sourceFormat":"referee","layer":{},"updatedAt":"2026-01-01T00:00:00.000Z","__proto__":{"polluted":true}}',
      'utf8'
    );
    await fs.writeFile(
      path.join(rootDir, 'presets', 'valid-preset.json.tmp'),
      'partial write',
      'utf8'
    );

    const listPresets = await store.listPresets();
    expect(listPresets.items.map((p) => p.id)).toEqual(['valid-preset']);
    expect(listPresets.warnings.length).toBe(3);

    // Same resilience for cartridges
    await store.saveCartridgeBundle(makeCartridgeBundle('valid-cart'));
    await fs.writeFile(
      path.join(rootDir, 'cartridges', 'broken.bundle.json'),
      '{ broken',
      'utf8'
    );
    await fs.writeFile(
      path.join(rootDir, 'cartridges', 'broken.bundle.json.tmp'),
      'leftover tmp',
      'utf8'
    );

    const listCarts = await store.listCartridges();
    expect(listCarts.items.map((c) => c.card.id)).toEqual(['valid-cart']);
    expect(listCarts.warnings.length).toBe(1);
  });

  it('rejects path-traversal and prototype-pollution IDs across all operations', async () => {
    const rootDir = await makeTempDir();
    const store = new RefereeDataStore(rootDir);
    await store.init();

    const dangerousIds = ['../evil', 'a/b', 'a\\b', '__proto__', 'constructor', 'prototype'];

    for (const id of dangerousIds) {
      expect(isErr(await store.getPreset(id))).toBe(true);
      expect(isErr(await store.deletePreset(id))).toBe(true);
      expect(isErr(await store.savePreset(makePreset({ id })))).toBe(true);

      expect(isErr(await store.getPersona(id))).toBe(true);
      expect(isErr(await store.deletePersona(id))).toBe(true);
      expect(isErr(await store.savePersona(makePersona({ id })))).toBe(true);

      expect(isErr(await store.getSystemPack(id))).toBe(true);
      expect(isErr(await store.deleteSystemPack(id))).toBe(true);
      expect(isErr(await store.saveSystemPack(makeSystemPack(id)))).toBe(true);

      expect(isErr(await store.getCartridgeBundle(id))).toBe(true);
      expect(isErr(await store.deleteCartridgeBundle(id))).toBe(true);
      expect(isErr(await store.saveCartridgeBundle(makeCartridgeBundle(id)))).toBe(true);

      expect(isErr(store.getSessionSaveDir(id))).toBe(true);
    }

    // Verify prototype-polluting nested payloads are rejected before write
    const pollutedPreset = JSON.parse(
      '{"id":"evil","name":"Evil","sourceFormat":"referee","layer":{"__proto__":{"x":1}},"updatedAt":"2026-01-01T00:00:00.000Z"}'
    ) as SaveControlRoomPresetInput;
    expect(isErr(await store.savePreset(pollutedPreset))).toBe(true);
    expect(Object.prototype).not.toHaveProperty('x');
  });

  it('cleans up temp files when atomic write fails (e.g., target path is an existing directory)', async () => {
    const rootDir = await makeTempDir();
    const store = new RefereeDataStore(rootDir);
    await store.init();

    // Make presets/colliding.json a directory so fs.rename(tmp, target) fails
    const collidingPath = path.join(rootDir, 'presets', 'colliding.json');
    await fs.mkdir(collidingPath, { recursive: true });

    const writeRes = await store.savePreset(makePreset({ id: 'colliding' }));
    expect(isErr(writeRes)).toBe(true);
    if (!writeRes.ok) {
      expect(writeRes.error[0]?.code).toBe('FILE_WRITE_ERROR');
    }

    const entries = await fs.readdir(path.join(rootDir, 'presets'));
    expect(entries).toEqual(['colliding.json']);
  });
});
