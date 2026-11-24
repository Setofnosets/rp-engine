import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import type { CombatantState } from '../../src/combat/action-validator.js';
import {
  MockModelProvider,
  PNG_SIGNATURE,
  RefereeDaemon,
  SessionRuntime,
  computePngChunkCrc,
  createMockModelGateway,
  embedCharaJsonInPng,
  extractCharaJsonFromPngBuffer,
  importSillyTavernCard,
  isOk,
  runDeterministicStateAudit,
  runSimPlaythroughCommand,
  runSimValidateCommand,
} from '../../src/index.js';

const CRIMSON_KEEP_DIR = path.resolve(process.cwd(), 'cartridges', 'crimson-keep');
const NEOTERRA_S1_DIR = path.resolve(process.cwd(), 'cartridges', 'neoterra-s1');

function makeChunkWithCrc(type: string, data: Buffer): Buffer {
  const len = Buffer.allocUnsafe(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.allocUnsafe(4);
  crc.writeUInt32BE(computePngChunkCrc(type, data), 0);
  return Buffer.concat([len, Buffer.from(type, 'ascii'), data, crc]);
}

function buildTestPngBuffer(): Buffer {
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(2, 0);
  ihdrData.writeUInt32BE(2, 4);
  ihdrData[8] = 8;
  ihdrData[9] = 6;
  const idatData = deflateSync(Buffer.from([0, 255, 0, 0, 255, 0, 255, 0, 255]));
  return Buffer.concat([
    PNG_SIGNATURE,
    makeChunkWithCrc('IHDR', ihdrData),
    makeChunkWithCrc('IDAT', idatData),
    makeChunkWithCrc('IEND', Buffer.alloc(0)),
  ]);
}

function makePlayerCombatant(): CombatantState {
  return {
    id: 'player',
    name: 'Warden',
    team: 'ally',
    coord: { x: 1, y: 1 },
    alive: true,
    hp: 40,
    maxHp: 40,
    ac: 14,
    speed: 6,
    remainingMovement: 6,
    remainingActions: { action: 1, bonus: 1, reaction: 1 },
    resources: { stamina: 20 },
    cooldowns: {},
    stats: { str: 10, dex: 4, initiative: 100 },
    statuses: [],
    abilities: [
      'basic_strike',
      'conjure_ember_hound',
      'blood_eclipse_avatar',
      'crimson_ignis_field',
    ],
    passives: [],
    willpower: 5,
    maxWillpower: 10,
  };
}

function makeEnemyCombatant(): CombatantState {
  return {
    id: 'captain_varek',
    name: 'Captain Varek',
    team: 'enemy',
    coord: { x: 3, y: 1 },
    alive: true,
    hp: 45,
    maxHp: 45,
    ac: 12,
    speed: 4,
    remainingMovement: 4,
    remainingActions: { action: 1, bonus: 1, reaction: 1 },
    resources: { stamina: 10 },
    cooldowns: {},
    stats: { str: 3, dex: 1, initiative: 1 },
    statuses: [],
    abilities: ['basic_strike'],
    passives: [],
    willpower: 2,
    maxWillpower: 10,
  };
}

describe('PR-10.3 Pre-GUI End-to-End Regression Gate', () => {
  const tempDirs: string[] = [];
  const daemons: RefereeDaemon[] = [];

  afterEach(async () => {
    while (daemons.length > 0) {
      const d = daemons.pop();
      if (d !== undefined) {
        await d.stop();
      }
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir !== undefined) {
        await fs.rm(dir, { recursive: true, force: true });
      }
    }
  });

  it('a) supports direct .png character card 1-on-1 play + lossless tEXt/zTXt/iTXt round-trip', async () => {
    const cardPayload = {
      spec: 'chara_card_v3',
      spec_version: '3.0',
      data: {
        name: 'Seraphina Vale',
        description: 'Clockwork archivist with UTF-8 sigil ★',
        personality: 'Witty, precise',
        scenario: 'Midnight tea inside the brass observatory.',
        first_mes: '"Mind the astrolabe—it still ticks backwards."',
        character_book: {
          entries: [
            {
              keys: ['astrolabe'],
              secondary_keys: [],
              content: 'The brass astrolabe measures temporal drift.',
              constant: false,
              insertion_order: 10,
              enabled: true,
            },
          ],
        },
      },
    };

    const basePng = buildTestPngBuffer();
    for (const chunkType of ['tEXt', 'zTXt', 'iTXt'] as const) {
      const embedded = embedCharaJsonInPng(basePng, cardPayload, 'ccv3', {
        chunkType,
        compressed: chunkType === 'iTXt',
      });
      expect(isOk(embedded)).toBe(true);
      if (!embedded.ok) return;

      const extracted = extractCharaJsonFromPngBuffer(embedded.value);
      expect(isOk(extracted)).toBe(true);
      if (!extracted.ok) return;
      expect(extracted.value).toEqual(cardPayload);
    }

    const pngWithCard = embedCharaJsonInPng(basePng, cardPayload, 'ccv3', { chunkType: 'tEXt' });
    expect(isOk(pngWithCard)).toBe(true);
    if (!pngWithCard.ok) return;

    const imported = importSillyTavernCard(pngWithCard.value);
    expect(isOk(imported)).toBe(true);
    if (!imported.ok) return;

    const gateway = createMockModelGateway(
      new MockModelProvider({
        handlers: {
          narrator: () => ({
            kind: 'text',
            text: 'Seraphina taps the spinning brass astrolabe.',
          }),
          state_tracker: () => ({ kind: 'json', value: {} }),
          chronicle_router: () => ({
            kind: 'json',
            value: {
              shouldRecord: false,
              category: 'event',
              title: 'Scene',
              summary: 'Scene',
              keywords: [],
              involvedEntityIds: [],
            },
          }),
          combat_agent: () => ({ kind: 'json', value: { actions: [] } }),
        },
      })
    );

    const runtime = new SessionRuntime({
      sessionId: 'gate-png-1v1',
      cartridge: imported.value,
      gateway,
      seed: 'png-gate-seed',
    });

    const turnRes = await runtime.executeTurn({
      text: 'I inspect the astrolabe on her desk.',
    });
    expect(isOk(turnRes)).toBe(true);
    if (!turnRes.ok) return;
    expect(turnRes.value.narratorText).toContain('astrolabe');
    expect(Object.keys(imported.value.loreFiles).length).toBeGreaterThan(0);
  });

  it('b) runs crimson-keep Tactical Grid + Traditional Theater combat with previews, summons, transforms, and terrain hazards', async () => {
    const valRes = await runSimValidateCommand(CRIMSON_KEEP_DIR);
    expect(isOk(valRes)).toBe(true);
    if (!valRes.ok) return;
    expect(valRes.value.report.ok).toBe(true);

    // Tactical Grid encounter: preview + summon + transform + modify_terrain
    const gridSim = await runSimPlaythroughCommand({
      cartridgeDir: CRIMSON_KEEP_DIR,
      seed: 'gate-crimson-grid',
      events: [
        {
          type: 'start_combat',
          mode: 'tactical_grid',
          gridSize: { width: 6, height: 6 },
          participants: [makePlayerCombatant(), makeEnemyCombatant()],
        },
        {
          type: 'preview',
          actorId: 'player',
          action: { type: 'skill', skillId: 'conjure_ember_hound', targetId: 'player' },
          expectLegal: true,
        },
        {
          type: 'preview',
          actorId: 'player',
          action: { type: 'skill', skillId: 'blood_eclipse_avatar', targetId: 'player' },
          expectLegal: true,
        },
        {
          type: 'preview',
          actorId: 'player',
          action: {
            type: 'skill',
            skillId: 'crimson_ignis_field',
            targetCoord: { x: 3, y: 1 },
          },
          expectLegal: true,
        },
        {
          type: 'turn',
          text: 'I assume the Blood Eclipse Avatar form and ignite the flagstones!',
          combatActions: [
            { type: 'skill', skillId: 'blood_eclipse_avatar', targetId: 'player' },
            {
              type: 'skill',
              skillId: 'crimson_ignis_field',
              targetCoord: { x: 3, y: 1 },
            },
          ],
          mockNarratorReply: 'Crimson armor manifests as searing fire erupts across the stone tiles.',
        },
        {
          type: 'turn',
          text: 'I conjure an Ember Hound!',
          combatActions: [{ type: 'skill', skillId: 'conjure_ember_hound', targetId: 'player' }],
          mockNarratorReply: 'An Ember Hound leaps from the hearth.',
        },
      ],
      expectations: {
        combatActive: true,
        combatSummonCountMin: 1,
        combatTransformedActorIds: ['player'],
        previewCountMin: 3,
      },
    });

    expect(isOk(gridSim)).toBe(true);
    if (!gridSim.ok) return;
    expect(gridSim.value.failedAssertions).toEqual([]);
    expect(gridSim.value.previews[2]?.terrainModificationFootprint.length).toBeGreaterThan(0);
    const hazardTile = gridSim.value.finalCombatState?.grid?.tiles.find(
      (t) => t.x === 3 && t.y === 1
    );
    expect(hazardTile?.hazard).toBe('fire');

    // Traditional Theater encounter with phased turnStyle
    const tradSim = await runSimPlaythroughCommand({
      cartridgeDir: CRIMSON_KEEP_DIR,
      seed: 'gate-crimson-trad',
      events: [
        {
          type: 'start_combat',
          mode: 'traditional',
          turnStyle: 'phased',
          participants: [makePlayerCombatant(), makeEnemyCombatant()],
        },
        {
          type: 'preview',
          actorId: 'player',
          action: { type: 'skill', skillId: 'basic_strike', targetId: 'captain_varek' },
          expectLegal: true,
        },
        {
          type: 'turn',
          text: 'I strike Varek in traditional theater combat.',
          combatActions: [{ type: 'skill', skillId: 'basic_strike', targetId: 'captain_varek' }],
          mockNarratorReply: 'Your blade rings against Varek’s guard.',
        },
      ],
      expectations: {
        combatActive: true,
        combatTurnStyle: 'phased',
        previewCountMin: 1,
      },
    });

    expect(isOk(tradSim)).toBe(true);
    if (!tradSim.ok) return;
    expect(tradSim.value.failedAssertions).toEqual([]);
  });

  it('c) validates neoterra-s1 takeover, travel/downtime/clone, Auditor, and daemon HTTP/SSE APIs', async () => {
    const valRes = await runSimValidateCommand(NEOTERRA_S1_DIR);
    if (!valRes.ok) {
      throw new Error(JSON.stringify(valRes.error, null, 2));
    }
    expect(isOk(valRes)).toBe(true);
    expect(valRes.value.report.ok).toBe(true);
    expect(valRes.value.bundle.initialEntities?.formRules?.length).toBeGreaterThan(0);

    // Scripted sim-cli playthrough: takeover -> travel -> downtime -> clone
    const neoSim = await runSimPlaythroughCommand({
      cartridgeDir: NEOTERRA_S1_DIR,
      seed: 'gate-neoterra-s1',
      events: [
        {
          type: 'takeover',
          canonCharacterId: 's1.vaiva.colorgarde',
        },
        {
          type: 'downtime',
          activity: 'recover',
          options: { slots: 1, requireSafehouseTag: false },
        },
        {
          type: 'clone',
          newSessionId: 'gate-neoterra-cloned',
        },
        {
          type: 'turn',
          text: 'Vaiva surveys the NeoTerra skyline.',
          mockNarratorReply: 'Neon light reflects off Vaiva’s visor.',
        },
      ],
      expectations: {
        canonCharacterId: 's1.vaiva.colorgarde',
      },
    });
    expect(isOk(neoSim)).toBe(true);
    if (!neoSim.ok) return;
    expect(neoSim.value.failedAssertions).toEqual([]);

    const audit = runDeterministicStateAudit(neoSim.value.finalState);
    expect(audit.findings.filter((f) => f.severity === 'error')).toEqual([]);

    // Daemon HTTP/SSE APIs: listSessions, cloneSession, combat/preview, binary asset fetch
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'referee-pre-gui-gate-'));
    tempDirs.push(dataDir);

    const daemon = new RefereeDaemon({
      dataDir,
      host: '127.0.0.1',
      port: 0,
      gateway: createMockModelGateway(
        new MockModelProvider({
          handlers: {
            narrator: () => ({ kind: 'text', text: 'Daemon gate reply.' }),
            state_tracker: () => ({ kind: 'json', value: {} }),
            chronicle_router: () => ({
              kind: 'json',
              value: {
                shouldRecord: false,
                category: 'event',
                title: 'Event',
                summary: 'Event',
                keywords: [],
                involvedEntityIds: [],
              },
            }),
            combat_agent: () => ({ kind: 'json', value: { actions: [] } }),
          },
        })
      ),
    });
    daemons.push(daemon);
    const addr = await daemon.start();

    // Import a .png card for binary portrait fetch + ETag check
    const cardPng = embedCharaJsonInPng(buildTestPngBuffer(), {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: 'Gate Heroine',
        description: 'Pre-GUI gate test heroine.',
        first_mes: 'Ready.',
      },
    });
    expect(isOk(cardPng)).toBe(true);
    if (!cardPng.ok) return;

    const importRes = await fetch(`${addr.url}/api/cards/import`, {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: new Uint8Array(cardPng.value),
    });
    expect(importRes.status).toBe(201);
    const importJson = (await importRes.json()) as { card: { id: string; portraitUrl: string } };
    const portraitRes = await fetch(`${addr.url}${importJson.card.portraitUrl}`);
    expect(portraitRes.status).toBe(200);
    expect(portraitRes.headers.get('etag')).toBeTruthy();

    // Create session from crimson-keep, listSessions, cloneSession, combat/preview
    const createSessRes = await fetch(`${addr.url}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'gate-sess-1',
        systemPackId: 'stock-tactical-rpg',
      }),
    });
    expect(createSessRes.status).toBe(201);

    const listRes = await fetch(`${addr.url}/api/sessions`);
    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json()) as { sessions: Array<{ sessionId: string }> };
    expect(listJson.sessions.some((s) => s.sessionId === 'gate-sess-1')).toBe(true);

    const turnHttpRes = await fetch(`${addr.url}/api/sessions/gate-sess-1/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'I step into the gatehouse.' }),
    });
    expect(turnHttpRes.status).toBe(200);
    const turnHttpJson = (await turnHttpRes.json()) as { userMessageId: string };

    const cloneRes = await fetch(`${addr.url}/api/sessions/gate-sess-1/clone`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'gate-sess-clone',
        nodeId: turnHttpJson.userMessageId,
      }),
    });
    expect(cloneRes.status).toBe(201);

    const clonedRuntime = daemon.getRegistry().sessions.get('gate-sess-clone');
    expect(clonedRuntime).toBeDefined();
    if (!clonedRuntime) return;
    const combatStart = clonedRuntime.startCombat(
      [makePlayerCombatant(), makeEnemyCombatant()],
      { mode: 'tactical_grid' }
    );
    expect(isOk(combatStart)).toBe(true);

    const previewRes = await fetch(`${addr.url}/api/sessions/gate-sess-clone/combat/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actorId: 'player',
        action: { type: 'move', to: { x: 2, y: 1 } },
      }),
    });
    expect(previewRes.status).toBe(200);
    const previewJson = (await previewRes.json()) as { actionPreview?: { legal: boolean } };
    expect(previewJson.actionPreview?.legal).toBe(true);
  });
});
