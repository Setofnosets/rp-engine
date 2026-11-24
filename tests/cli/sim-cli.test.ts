import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseSimCliArgs,
  runSimCli,
  runSimPlaythroughCommand,
  runSimValidateCommand,
} from '../../src/cli/sim-cli.js';
import { isErr, isOk } from '../../src/core/result.js';
import { STOCK_SLICE_OF_LIFE_PACK } from '../../src/schema/stock-system-packs.js';
import type { GameSystemModule } from '../../src/schema/tracker-module.js';

const CAFE_DIR = path.resolve(process.cwd(), 'cartridges', 'slice-of-life-cafe');
const NEOTERRA_DIR = path.resolve(process.cwd(), 'cartridges', 'neoterra-s1');

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe('sim-cli unit & CLI integration tests', () => {
  it('parses valid validate/run CLI args and rejects invalid arguments', () => {
    const valArgs = parseSimCliArgs(['validate', '--cartridge', './cartridges/crimson-keep']);
    expect(isOk(valArgs)).toBe(true);
    if (valArgs.ok) {
      expect(valArgs.value).toEqual({
        command: 'validate',
        cartridgeDir: './cartridges/crimson-keep',
      });
    }

    const runArgs = parseSimCliArgs([
      'run',
      '--cartridge',
      './cartridges/neoterra-s1',
      '--events',
      './events.jsonl',
      '--seed',
      'seed-42',
      '--assert',
      './assert.json',
    ]);
    expect(isOk(runArgs)).toBe(true);
    if (runArgs.ok) {
      expect(runArgs.value).toEqual({
        command: 'run',
        cartridgeDir: './cartridges/neoterra-s1',
        eventsPath: './events.jsonl',
        seed: 'seed-42',
        assertPath: './assert.json',
      });
    }

    expect(isErr(parseSimCliArgs([]))).toBe(true);
    expect(isErr(parseSimCliArgs(['unknown', '--cartridge', './c']))).toBe(true);
    expect(isErr(parseSimCliArgs(['validate']))).toBe(true);
    expect(isErr(parseSimCliArgs(['validate', '--cartridge', './c', '--seed', '1']))).toBe(true);
    expect(isErr(parseSimCliArgs(['run', '--cartridge', './c']))).toBe(true);
    expect(isErr(parseSimCliArgs(['run', '--cartridge', './c', '--events', '--seed', '1']))).toBe(true);
    expect(isErr(parseSimCliArgs(['run', '--cartridge', './c', '--events', 'e.jsonl', '--bogus']))).toBe(true);
  });

  it('runSimValidateCommand reports errors on broken or cyclic cartridge directories', async () => {
    const dir = await makeTempDir('sim-broken-');
    await writeFile(
      path.join(dir, 'card.json'),
      JSON.stringify({
        spec: 'cartridge/0.1',
        id: 'broken-cycle',
        version: '1.0.0',
        title: 'Broken Cycle',
        description: 'Broken',
        recommendedSystemPack: 'stock-tactical-rpg',
        persona: { name: 'Guide', description: 'Guide' },
      }),
      'utf8'
    );
    await writeFile(
      path.join(dir, 'beats.json'),
      JSON.stringify([
        { id: 'a', class: 'gate', priority: 10, requires: ['b'], when: { flag: 'go' } },
        { id: 'b', class: 'gate', priority: 5, requires: ['a'], when: { flag: 'go' } },
      ]),
      'utf8'
    );

    const res = await runSimValidateCommand(dir);
    expect(isErr(res)).toBe(true);
    if (!res.ok) {
      expect(res.error.some((e) => e.code === 'BEAT_CYCLE_DETECTED')).toBe(true);
    }
  });

  it('supports confirm_patches (accept_all & reject_all) and reports mismatched expectations', async () => {
    const confirmModule: GameSystemModule = {
      id: 'confirm_test_mod',
      name: 'Confirm Test',
      description: 'Test confirm_policy',
      enabled: true,
      scope: 'session',
      target: 'player',
      effectOwner: 'tracker',
      cadence: 'every_turn',
      fields: {
        caffeine_count: {
          type: 'counter',
          min: 0,
          default: 0,
          writableByTracker: true,
          confirmPolicy: 'always_confirm',
          description: 'Coffee cups consumed',
        },
      },
      trackerInstruction: 'Track caffeine_count.',
      narratorRule: '',
      ui: { widget: 'badge', order: 10 },
    };

    const customPack = {
      ...STOCK_SLICE_OF_LIFE_PACK,
      gameSystems: [...STOCK_SLICE_OF_LIFE_PACK.gameSystems, confirmModule],
    };

    const acceptedRes = await runSimPlaythroughCommand({
      cartridgeDir: CAFE_DIR,
      systemPack: customPack,
      seed: 'confirm-seed',
      events: [
        {
          type: 'turn',
          text: 'I order an espresso.',
          mockTrackerJson: {
            player_custom_fields: { caffeine_count: 2 },
          },
        },
        {
          type: 'confirm_patches',
          decision: 'accept_all',
        },
      ],
      expectations: {
        flags: { non_existent_flag: true },
        counters: { missing_counter: 5 },
        sceneLocation: 'Wrong Place',
        activeEndingId: 'fake-ending',
      },
    });

    expect(isOk(acceptedRes)).toBe(true);
    if (!acceptedRes.ok) return;

    expect(acceptedRes.value.finalState.player.customFields['caffeine_count']).toBe(2);
    expect(acceptedRes.value.failedAssertions).toHaveLength(4);

    const rejectedRes = await runSimPlaythroughCommand({
      cartridgeDir: CAFE_DIR,
      systemPack: customPack,
      seed: 'confirm-seed',
      events: [
        {
          type: 'turn',
          text: 'I order an espresso.',
          mockTrackerJson: {
            player_custom_fields: { caffeine_count: 2 },
          },
        },
        {
          type: 'confirm_patches',
          decision: 'reject_all',
        },
      ],
    });
    expect(isOk(rejectedRes)).toBe(true);
    if (rejectedRes.ok) {
      expect(rejectedRes.value.finalState.player.customFields['caffeine_count']).toBeUndefined();
    }
  });

  it('runSimCli executes JSONL events + expectations JSON and rejects prototype pollution', async () => {
    const dir = await makeTempDir('sim-cli-run-');
    const eventsPath = path.join(dir, 'events.jsonl');
    const assertPassPath = path.join(dir, 'assert-pass.json');
    const assertFailPath = path.join(dir, 'assert-fail.json');
    const pollutedEventsPath = path.join(dir, 'polluted.jsonl');

    await writeFile(
      eventsPath,
      [
        JSON.stringify({ type: 'turn', text: '/travel clarity-hq' }),
        JSON.stringify({
          type: 'turn',
          text: 'Colorgarde intercepts the Clarity arms shipment and brings Claire Atropos down.',
          directorSteering: {
            beatOverrides: [
              { beatId: 's1.opening.arms-deal', status: 'resolved' },
              { beatId: 's1.opening.beast-rumors', status: 'resolved' },
              { beatId: 's1.escalation.first-conversion', status: 'resolved' },
              { beatId: 's1.climax.claire-confrontation', status: 'resolved' },
              { beatId: 's1.resolution.clarity-falls', status: 'resolved' },
            ],
          },
        }),
      ].join('\n'),
      'utf8'
    );

    await writeFile(
      assertPassPath,
      JSON.stringify({
        flags: { ending_s1_resolution: true },
        activeEndingId: 's1.ending.resolution',
        endingStatus: 'epilogue',
        sceneLocation: 'Clarity Incorporated HQ',
      }),
      'utf8'
    );

    await writeFile(
      assertFailPath,
      JSON.stringify({
        activeEndingId: 's1.ending.villain-victory',
      }),
      'utf8'
    );

    await writeFile(
      pollutedEventsPath,
      '{"type":"turn","text":"hi","__proto__":{"polluted":true}}\n',
      'utf8'
    );

    const out: string[] = [];
    const errOut: string[] = [];
    const passCode = await runSimCli(
      [
        'run',
        '--cartridge',
        NEOTERRA_DIR,
        '--events',
        eventsPath,
        '--seed',
        'cli-seed-1',
        '--assert',
        assertPassPath,
      ],
      { stdout: (s) => out.push(s), stderr: (s) => errOut.push(s) }
    );
    expect(passCode).toBe(0);
    expect(errOut).toEqual([]);
    const summary = JSON.parse(out[0] ?? '{}') as { ok?: boolean; activeEndingId?: string };
    expect(summary.ok).toBe(true);
    expect(summary.activeEndingId).toBe('s1.ending.resolution');

    const failErr: string[] = [];
    const failCode = await runSimCli(
      [
        'run',
        '--cartridge',
        NEOTERRA_DIR,
        '--events',
        eventsPath,
        '--seed',
        'cli-seed-1',
        '--assert',
        assertFailPath,
      ],
      { stdout: () => {}, stderr: (s) => failErr.push(s) }
    );
    expect(failCode).toBe(1);
    expect(failErr[0]).toContain('Assertion failures');

    const pollutedErr: string[] = [];
    const pollutedCode = await runSimCli(
      ['run', '--cartridge', NEOTERRA_DIR, '--events', pollutedEventsPath],
      { stdout: () => {}, stderr: (s) => pollutedErr.push(s) }
    );
    expect(pollutedCode).toBe(1);
    expect(pollutedErr[0]).toContain('UNSAFE_PROPERTY_KEY');
  });
});
