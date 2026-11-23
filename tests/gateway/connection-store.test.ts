import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isErr, isOk } from '../../src/core/result.js';
import {
  type ConnectionProfile,
  type ConnectionsFileDocument,
  activateNamedProfile,
  applyConnectionsFileToGateway,
  deleteNamedProfile,
  loadConnectionsFile,
  parseConnectionsDocument,
  saveConnectionsFile,
  saveNamedProfile,
  snapshotGatewayToConnectionsDoc,
} from '../../src/gateway/connection-store.js';
import { ModelGateway } from '../../src/gateway/model-gateway.js';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'referee-conn-store-'));
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

describe('ConnectionStore parsing and legacy compatibility', () => {
  it('parses versioned ConnectionsFileDocument with full sampling parameters and profiles', () => {
    const raw = JSON.stringify({
      version: 1,
      activeProfile: 'local-ollama',
      defaultConnection: {
        provider: 'ollama',
        baseUrl: 'http://localhost:11434',
        model: 'llama3.1:8b',
        temperature: 0.7,
        maxTokens: 1024,
        maxContextTokens: 16384,
        topP: 0.9,
        topK: 40,
        minP: 0.05,
        topA: 0.1,
        typicalP: 0.95,
        tfs: 0.9,
        frequencyPenalty: 0.2,
        presencePenalty: 0.1,
        repetitionPenalty: 1.05,
        stopSequences: ['###', 'User:'],
        seed: 123,
        supportsJsonSchema: true,
        timeoutMs: 30000,
      },
      connections: {
        narrator: {
          provider: 'anthropic',
          baseUrl: 'https://api.anthropic.com',
          apiKey: 'sk-ant-test',
          model: 'claude-3-7-sonnet-latest',
          temperature: 0.85,
        },
      },
      profiles: {
        'local-ollama': {
          defaultConnection: {
            provider: 'ollama',
            baseUrl: 'http://localhost:11434',
            model: 'llama3.1:8b',
          },
        },
      },
    });

    const res = parseConnectionsDocument(raw);
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value.version).toBe(1);
      expect(res.value.activeProfile).toBe('local-ollama');
      expect(res.value.defaultConnection?.minP).toBe(0.05);
      expect(res.value.defaultConnection?.stopSequences).toEqual(['###', 'User:']);
      expect(res.value.connections?.narrator?.provider).toBe('anthropic');
      expect(res.value.profiles?.['local-ollama']?.defaultConnection?.model).toBe('llama3.1:8b');
    }
  });

  it('parses legacy referee.connections.json without version, profiles, or explicit provider', () => {
    const legacyRaw = JSON.stringify({
      defaultConnection: {
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o-mini',
        apiKey: 'sk-legacy',
        temperature: 0.6,
        maxTokens: 800,
      },
      connections: {
        intent_parser: {
          baseUrl: 'http://127.0.0.1:11434/v1',
          model: 'qwen2.5:7b',
        },
      },
    });

    const res = parseConnectionsDocument(legacyRaw);
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value.version).toBe(1);
      expect(res.value.activeProfile).toBeUndefined();
      expect(res.value.profiles).toBeUndefined();
      expect(res.value.defaultConnection).toEqual({
        provider: 'openai_compatible',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o-mini',
        apiKey: 'sk-legacy',
        temperature: 0.6,
        maxTokens: 800,
      });
      expect(res.value.connections?.intent_parser).toEqual({
        provider: 'openai_compatible',
        baseUrl: 'http://127.0.0.1:11434/v1',
        model: 'qwen2.5:7b',
      });
    }
  });

  it('rejects prototype-polluting keys and invalid schemas without polluting Object.prototype', () => {
    const pollutedRoot = '{"version":1,"__proto__":{"polluted":true}}';
    const rootRes = parseConnectionsDocument(pollutedRoot);
    expect(isErr(rootRes)).toBe(true);
    if (isErr(rootRes)) {
      expect(rootRes.error[0]?.code).toBe('UNSAFE_KEY');
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();

    const pollutedProfile =
      '{"version":1,"profiles":{"constructor":{"defaultConnection":{"baseUrl":"http://x","model":"y"}}}}';
    const profileRes = parseConnectionsDocument(pollutedProfile);
    expect(isErr(profileRes)).toBe(true);
    if (isErr(profileRes)) {
      expect(profileRes.error[0]?.code).toBe('UNSAFE_KEY');
    }

    const badVersion = parseConnectionsDocument('{"version":2}');
    expect(isErr(badVersion)).toBe(true);
    if (isErr(badVersion)) {
      expect(badVersion.error[0]?.code).toBe('UNSUPPORTED_VERSION');
    }

    const badRole = parseConnectionsDocument(
      '{"version":1,"connections":{"unknown_role":{"baseUrl":"http://x","model":"y"}}}'
    );
    expect(isErr(badRole)).toBe(true);
    if (isErr(badRole)) {
      expect(badRole.error[0]?.code).toBe('INVALID_ROLE');
    }
  });
});

describe('ConnectionStore disk persistence (loadConnectionsFile / saveConnectionsFile)', () => {
  it('saves atomically without leaving .tmp files and loads cleanly', async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, 'nested', 'referee.connections.json');

    const doc: ConnectionsFileDocument = {
      version: 1,
      activeProfile: 'cloud',
      defaultConnection: {
        provider: 'openai_compatible',
        baseUrl: 'https://api.example.test/v1',
        apiKey: 'secret-token',
        model: 'gpt-test',
        temperature: 0.7,
        seed: 7,
      },
      connections: {
        combat_agent: {
          provider: 'anthropic',
          baseUrl: 'https://api.anthropic.com',
          apiKey: 'ant-token',
          model: 'claude-haiku',
          maxTokens: 512,
        },
      },
      profiles: {
        cloud: {
          defaultConnection: {
            provider: 'openai_compatible',
            baseUrl: 'https://api.example.test/v1',
            apiKey: 'secret-token',
            model: 'gpt-test',
          },
        },
      },
    };

    const saveRes = await saveConnectionsFile(filePath, doc);
    expect(isOk(saveRes)).toBe(true);

    const filesInDir = await fs.readdir(path.dirname(filePath));
    expect(filesInDir).toEqual(['referee.connections.json']);

    const loadRes = await loadConnectionsFile(filePath);
    expect(isOk(loadRes)).toBe(true);
    if (isOk(loadRes)) {
      expect(loadRes.value.version).toBe(1);
      expect(loadRes.value.activeProfile).toBe('cloud');
      expect(loadRes.value.defaultConnection?.apiKey).toBe('secret-token');
      expect(loadRes.value.connections?.combat_agent?.model).toBe('claude-haiku');
      expect(loadRes.value.profiles?.cloud?.defaultConnection?.model).toBe('gpt-test');
    }

    const missingRes = await loadConnectionsFile(path.join(dir, 'does-not-exist.json'));
    expect(isErr(missingRes)).toBe(true);
    if (isErr(missingRes)) {
      expect(missingRes.error[0]?.code).toBe('NOT_FOUND');
    }
  });
});

describe('ConnectionStore gateway integration and named profile helpers', () => {
  it('applies documents to ModelGateway and snapshots gateway state while preserving profiles', () => {
    const gateway = new ModelGateway({
      connections: {
        state_tracker: {
          role: 'state_tracker',
          provider: 'mock',
          baseUrl: 'mock://stale',
          model: 'stale-model',
        },
      },
    });

    const initialDoc: ConnectionsFileDocument = {
      version: 1,
      activeProfile: 'work',
      defaultConnection: {
        provider: 'openai_compatible',
        baseUrl: 'https://work.test/v1',
        apiKey: 'work-key',
        model: 'work-default',
        topP: 0.9,
      },
      connections: {
        narrator: {
          provider: 'anthropic',
          baseUrl: 'https://api.anthropic.com',
          apiKey: 'ant-key',
          model: 'claude-narrator',
          maxTokens: 2048,
        },
      },
      profiles: {
        work: {
          defaultConnection: {
            provider: 'openai_compatible',
            baseUrl: 'https://work.test/v1',
            model: 'work-default',
          },
        },
      },
    };

    applyConnectionsFileToGateway(gateway, initialDoc);

    // Previous role override (state_tracker) was cleared by applyConnectionsFileToGateway
    const snapAfterApply = gateway.getConnectionsSnapshot();
    expect(snapAfterApply.connections.state_tracker).toBeUndefined();
    expect(snapAfterApply.connections.narrator?.model).toBe('claude-narrator');
    expect(snapAfterApply.defaultConnection?.apiKey).toBe('work-key');

    // Modify gateway at runtime and snapshot back while preserving existing profiles & activeProfile
    gateway.setRoleConnection('intent_parser', {
      provider: 'ollama',
      baseUrl: 'http://localhost:11434',
      model: 'qwen2.5:7b',
      seed: 101,
    });

    const snappedDoc = snapshotGatewayToConnectionsDoc(gateway, initialDoc);
    expect(snappedDoc.version).toBe(1);
    expect(snappedDoc.activeProfile).toBe('work');
    expect(snappedDoc.profiles?.work?.defaultConnection?.model).toBe('work-default');
    expect(snappedDoc.defaultConnection?.apiKey).toBe('work-key');
    expect(snappedDoc.connections?.intent_parser).toEqual({
      provider: 'ollama',
      baseUrl: 'http://localhost:11434',
      model: 'qwen2.5:7b',
      seed: 101,
    });
    // Role key must not leak onto stored Omit<RoleConnectionConfig, 'role'> entries
    expect('role' in (snappedDoc.connections?.intent_parser ?? {})).toBe(false);
  });

  it('saves, activates, and deletes named profiles immutably with safety guards', () => {
    const gateway = new ModelGateway();
    const baseDoc: ConnectionsFileDocument = { version: 1 };

    const localProfile: ConnectionProfile = {
      defaultConnection: {
        provider: 'ollama',
        baseUrl: 'http://localhost:11434',
        model: 'llama3.1:8b',
        maxContextTokens: 8192,
      },
      connections: {
        narrator: {
          provider: 'ollama',
          baseUrl: 'http://localhost:11434/api/chat',
          model: 'mistral-nemo',
          temperature: 0.85,
        },
      },
    };

    const cloudProfile: ConnectionProfile = {
      defaultConnection: {
        provider: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'sk-ant',
        model: 'claude-3-7-sonnet-latest',
      },
    };

    const saved1 = saveNamedProfile(baseDoc, 'local', localProfile);
    expect(isOk(saved1)).toBe(true);
    if (!isOk(saved1)) return;
    // Original doc remains unmutated
    expect(baseDoc.profiles).toBeUndefined();

    const saved2 = saveNamedProfile(saved1.value, 'cloud', cloudProfile);
    expect(isOk(saved2)).toBe(true);
    if (!isOk(saved2)) return;

    // Unsafe profile names are rejected
    const unsafeSave = saveNamedProfile(saved2.value, '__proto__', cloudProfile);
    expect(isErr(unsafeSave)).toBe(true);
    if (isErr(unsafeSave)) {
      expect(unsafeSave.error[0]?.code).toBe('UNSAFE_KEY');
    }

    // Activate 'local' and verify gateway updates
    const activatedLocal = activateNamedProfile(saved2.value, 'local', gateway);
    expect(isOk(activatedLocal)).toBe(true);
    if (!isOk(activatedLocal)) return;
    expect(activatedLocal.value.activeProfile).toBe('local');
    expect(gateway.getConnectionsSnapshot().defaultConnection?.model).toBe('llama3.1:8b');
    expect(gateway.getConnectionsSnapshot().connections.narrator?.model).toBe('mistral-nemo');

    // Activate 'cloud' and verify previous 'local' role overrides are cleared
    const activatedCloud = activateNamedProfile(activatedLocal.value, 'cloud', gateway);
    expect(isOk(activatedCloud)).toBe(true);
    if (!isOk(activatedCloud)) return;
    expect(activatedCloud.value.activeProfile).toBe('cloud');
    expect(gateway.getConnectionsSnapshot().defaultConnection?.provider).toBe('anthropic');
    expect(gateway.getConnectionsSnapshot().connections.narrator).toBeUndefined();

    // Deleting a non-active profile preserves activeProfile
    const deletedLocal = deleteNamedProfile(activatedCloud.value, 'local');
    expect(isOk(deletedLocal)).toBe(true);
    if (!isOk(deletedLocal)) return;
    expect(deletedLocal.value.activeProfile).toBe('cloud');
    expect(deletedLocal.value.profiles?.local).toBeUndefined();
    expect(deletedLocal.value.profiles?.cloud).toBeDefined();

    // Deleting the active profile clears activeProfile
    const deletedCloud = deleteNamedProfile(deletedLocal.value, 'cloud');
    expect(isOk(deletedCloud)).toBe(true);
    if (!isOk(deletedCloud)) return;
    expect(deletedCloud.value.activeProfile).toBeUndefined();
    expect(deletedCloud.value.profiles).toEqual({});

    // Activating or deleting missing profile returns PROFILE_NOT_FOUND
    const missingAct = activateNamedProfile(deletedCloud.value, 'missing', gateway);
    expect(isErr(missingAct)).toBe(true);
    if (isErr(missingAct)) {
      expect(missingAct.error[0]?.code).toBe('PROFILE_NOT_FOUND');
    }
  });
});
