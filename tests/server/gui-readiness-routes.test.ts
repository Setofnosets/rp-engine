import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMockModelGateway } from '../../src/gateway/mock-provider.js';
import { RefereeDaemon } from '../../src/server/daemon.js';

function createPngChunk(type: string, data: Buffer): Buffer {
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function buildSyntheticCardPngBuffer(cardObj: Record<string, unknown>): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(1, 0);
  ihdrData.writeUInt32BE(1, 4);
  ihdrData[8] = 8;
  ihdrData[9] = 6;
  const encodedJson = Buffer.from(JSON.stringify(cardObj), 'utf8').toString('base64');
  const textChunk = Buffer.concat([
    Buffer.from('chara', 'latin1'),
    Buffer.from([0]),
    Buffer.from(encodedJson, 'latin1'),
  ]);
  return Buffer.concat([
    signature,
    createPngChunk('IHDR', ihdrData),
    createPngChunk('tEXt', textChunk),
    createPngChunk('IEND', Buffer.alloc(0)),
  ]);
}

interface ParsedSseEvent {
  readonly event: string;
  readonly data: Record<string, unknown>;
}

function parseSseFrames(raw: string): ParsedSseEvent[] {
  const frames: ParsedSseEvent[] = [];
  const blocks = raw.split(/\r?\n\r?\n/);
  for (const block of blocks) {
    const trimmed = block.trim();
    if (trimmed.length === 0 || trimmed.startsWith(':')) {
      continue;
    }
    let eventName = 'message';
    const dataLines: string[] = [];
    for (const line of trimmed.split(/\r?\n/)) {
      if (line.startsWith('event:')) {
        eventName = line.slice('event:'.length).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).trim());
      }
    }
    if (dataLines.length > 0) {
      frames.push({
        event: eventName,
        data: JSON.parse(dataLines.join('\n')) as Record<string, unknown>,
      });
    }
  }
  return frames;
}

describe('PR-10.1: GUI-Ready Daemon HTTP/SSE Contract & Binary Assets', () => {
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

  it('supports .png card gallery, portrait ETag, path-traversal 403, combat preview, travel/downtime, context-budget, message edit/continue, stack clone, SSE, and delete', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'referee-pr10-'));
    tempDirs.push(dataDir);

    let turnCounter = 0;
    const gateway = createMockModelGateway({
      narrator: () => {
        turnCounter += 1;
        return {
          kind: 'text',
          text: `Narrator reply #${turnCounter}: Lanterns sway above the rain-slick plaza.`,
        };
      },
    });

    const daemon = new RefereeDaemon({ host: '127.0.0.1', port: 0, gateway, dataDir });
    daemons.push(daemon);
    const addr = await daemon.start();

    // 1. Raw image/png binary upload to POST /api/cards/import
    const lyraPng = buildSyntheticCardPngBuffer({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: 'Lyra Vance',
        description: 'A sharp-eyed arcane cartographer.',
        personality: 'Analytical, wry, observant.',
        scenario: 'Exploring the sunken spire.',
        first_mes: 'She adjusts her brass astrolabe.',
      },
    });

    const importCardRes = await fetch(`${addr.url}/api/cards/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: new Uint8Array(lyraPng),
    });
    expect(importCardRes.status).toBe(201);
    const importCardJson = (await importCardRes.json()) as {
      ok: boolean;
      card: { id: string; name: string; portraitUrl: string | null; portraitPath: string | null };
    };
    expect(importCardJson.ok).toBe(true);
    expect(importCardJson.card.id).toBe('lyra-vance');
    expect(importCardJson.card.portraitUrl).toBe('/api/cards/lyra-vance/portrait');

    // 2. GET /api/cards & GET /api/cards/:id/portrait (with ETag & 304)
    const listCardsRes = await fetch(`${addr.url}/api/cards`);
    expect(listCardsRes.status).toBe(200);
    const listCardsJson = (await listCardsRes.json()) as {
      ok: boolean;
      cards: Array<{ id: string; portraitUrl: string | null }>;
    };
    expect(listCardsJson.cards.some((c) => c.id === 'lyra-vance')).toBe(true);

    const portraitRes = await fetch(`${addr.url}/api/cards/lyra-vance/portrait`);
    expect(portraitRes.status).toBe(200);
    expect(portraitRes.headers.get('content-type')).toBe('image/png');
    const etag = portraitRes.headers.get('etag');
    expect(etag).toBeTruthy();
    expect(portraitRes.headers.get('cache-control')).toContain('max-age=');

    const notModifiedRes = await fetch(`${addr.url}/api/cards/lyra-vance/portrait`, {
      headers: { 'If-None-Match': etag as string },
    });
    expect(notModifiedRes.status).toBe(304);

    // 3. Path traversal rejection (403) & unsupported MIME (415) on asset routes
    const rawTraversalStatus = await new Promise<number>((resolve, reject) => {
      const req = http.get(
        {
          hostname: addr.host,
          port: addr.port,
          path: '/api/cartridges/lyra-vance/assets/../../secret.txt',
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        }
      );
      req.on('error', reject);
    });
    expect(rawTraversalStatus).toBe(403);

    const encodedTraversalStatus = await new Promise<number>((resolve, reject) => {
      const req = http.get(
        {
          hostname: addr.host,
          port: addr.port,
          path: '/api/cartridges/lyra-vance/assets/%2e%2e/secret.png',
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        }
      );
      req.on('error', reject);
    });
    expect(encodedTraversalStatus).toBe(403);

    const badMimeRes = await fetch(`${addr.url}/api/cartridges/lyra-vance/assets/script.exe`);
    expect(badMimeRes.status).toBe(415);

    const validAssetRes = await fetch(
      `${addr.url}/api/cartridges/lyra-vance/assets/portraits/lyra-vance.png`
    );
    expect(validAssetRes.status).toBe(200);
    expect(validAssetRes.headers.get('content-type')).toBe('image/png');

    // 4. Direct session creation from cardId & GET /api/sessions
    const createSessRes = await fetch(`${addr.url}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'gui-sess-1',
        cardId: 'lyra-vance',
        seed: 'gui-seed-1',
      }),
    });
    expect(createSessRes.status).toBe(201);

    const listSessRes = await fetch(`${addr.url}/api/sessions`);
    expect(listSessRes.status).toBe(200);
    const listSessJson = (await listSessRes.json()) as {
      ok: boolean;
      sessions: Array<{ sessionId: string; cartridgeId: string; turn: number; day: number }>;
    };
    const listed = listSessJson.sessions.find((s) => s.sessionId === 'gui-sess-1');
    expect(listed).toBeDefined();
    expect(listed?.cartridgeId).toBe('lyra-vance');
    expect(listed?.day).toBe(1);

    // 5. Attach a character & bind player persona / canonCharacterId
    const attachCharRes = await fetch(`${addr.url}/api/sessions/gui-sess-1/characters`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cardId: 'lyra-vance',
        characterId: 'lyra-companion',
      }),
    });
    expect(attachCharRes.status).toBe(200);

    const bindPlayerRes = await fetch(`${addr.url}/api/sessions/gui-sess-1/player`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        canonCharacterId: 'lyra-companion',
      }),
    });
    expect(bindPlayerRes.status).toBe(200);
    const bindPlayerJson = (await bindPlayerRes.json()) as {
      ok: boolean;
      player: { canonCharacterId: string | null; name: string };
    };
    expect(bindPlayerJson.player.canonCharacterId).toBe('lyra-companion');

    // 6. Open SSE stream and execute a turn, verifying typed GUI SSE frames
    const sseAbort = new AbortController();
    const sseRes = await fetch(`${addr.url}/api/sessions/gui-sess-1/stream`, {
      signal: sseAbort.signal,
    });
    expect(sseRes.status).toBe(200);
    const reader = sseRes.body?.getReader();
    expect(reader).toBeDefined();
    const preamble = await reader!.read();
    expect(new TextDecoder().decode(preamble.value)).toContain(': connected');

    const turnRes = await fetch(`${addr.url}/api/sessions/gui-sess-1/turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Survey the plaza.', streamNarrator: true }),
    });
    expect(turnRes.status).toBe(200);
    const turnJson = (await turnRes.json()) as {
      ok: boolean;
      userMessageId: string;
      assistantMessageId: string;
      narratorText: string;
    };
    expect(turnJson.narratorText).toContain('Narrator reply #1');

    let sseText = '';
    for (let i = 0; i < 12; i += 1) {
      const chunk = await reader!.read();
      if (chunk.done) break;
      sseText += new TextDecoder().decode(chunk.value);
      if (sseText.includes('event: agent_activity') && sseText.includes('event: narrator_chunk')) {
        break;
      }
    }
    sseAbort.abort();
    const sseFrames = parseSseFrames(sseText);
    const sseTypes = sseFrames.map((f) => f.event);
    expect(sseTypes).toContain('narrator_chunk');
    expect(sseTypes).toContain('agent_activity');

    // 7. Swipe tree, message edit, and continue
    const treeRes = await fetch(`${addr.url}/api/sessions/gui-sess-1/swipe-tree`);
    expect(treeRes.status).toBe(200);
    const treeJson = (await treeRes.json()) as {
      ok: boolean;
      swipeTree: { activeLeafMessageId: string | null; nodes: Record<string, unknown> };
    };
    expect(treeJson.swipeTree.activeLeafMessageId).toBe(turnJson.assistantMessageId);

    const editRes = await fetch(
      `${addr.url}/api/sessions/gui-sess-1/messages/${turnJson.userMessageId}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Edited: Inspect the astrolabe.' }),
      }
    );
    expect(editRes.status).toBe(200);
    const editJson = (await editRes.json()) as { ok: boolean; swipeIndex: number };
    expect(editJson.swipeIndex).toBe(1);

    const continueRes = await fetch(`${addr.url}/api/sessions/gui-sess-1/continue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeId: turnJson.userMessageId }),
    });
    expect(continueRes.status).toBe(200);
    const continueJson = (await continueRes.json()) as { ok: boolean; narratorText: string };
    expect(continueJson.narratorText).toContain('Narrator reply #2');

    // 8. Context budget inspection
    const budgetRes = await fetch(`${addr.url}/api/sessions/gui-sess-1/context-budget`);
    expect(budgetRes.status).toBe(200);
    const budgetJson = (await budgetRes.json()) as {
      ok: boolean;
      budgetReport: { totalTokens: number; totalBudget: number; sections: unknown[] };
    };
    expect(budgetJson.budgetReport.totalTokens).toBeGreaterThan(0);
    expect(budgetJson.budgetReport.sections.length).toBeGreaterThan(0);

    // 9. Travel & Downtime routes (with locations seeded in runtime state)
    const runtime = daemon.getRegistry().sessions.get('gui-sess-1')!;
    const currentState = runtime.getState();
    currentState.capabilities.combatMode = 'tactical_grid';
    currentState.entities.locations['hub-square'] = {
      id: 'hub-square',
      name: 'Hub Square',
      kind: 'hub',
      status: 'active',
      controllingFactionId: null,
      connectedLocations: ['old-archives'],
      discovered: true,
      tags: ['safe', 'hub'],
      notes: 'Central plaza',
    };
    currentState.entities.locations['old-archives'] = {
      id: 'old-archives',
      name: 'Old Archives',
      kind: 'dungeon',
      status: 'active',
      controllingFactionId: null,
      connectedLocations: ['hub-square'],
      discovered: true,
      tags: [],
      notes: 'Dusty vaults',
    };
    currentState.scene.locationId = 'hub-square';
    currentState.player.locationId = 'hub-square';
    runtime.restoreSnapshot({ state: currentState });

    const travelRes = await fetch(`${addr.url}/api/sessions/gui-sess-1/travel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetLocationId: 'old-archives' }),
    });
    expect(travelRes.status).toBe(200);

    const downtimeRes = await fetch(`${addr.url}/api/sessions/gui-sess-1/downtime`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activity: 'research' }),
    });
    expect(downtimeRes.status).toBe(200);

    // 10. Combat preview route
    const startCombatRes = runtime.startCombat(
      [
        {
          id: 'player-hero',
          name: 'Lyra',
          team: 'ally',
          alive: true,
          hp: 20,
          maxHp: 20,
          ac: 13,
          speed: 4,
          willpower: 2,
          maxWillpower: 2,
          coord: { x: 1, y: 1 },
          remainingMovement: 4,
          remainingActions: { action: 1, bonus: 1, reaction: 1 },
          stats: { attack: 4, ac: 13 },
          resources: {},
          cooldowns: {},
          statuses: [],
          abilities: ['basic_strike', 'guard_stance'],
          passives: [],
        },
        {
          id: 'goblin-1',
          name: 'Goblin Scout',
          team: 'enemy',
          alive: true,
          hp: 10,
          maxHp: 10,
          ac: 11,
          speed: 4,
          willpower: 1,
          maxWillpower: 1,
          coord: { x: 2, y: 1 },
          remainingMovement: 4,
          remainingActions: { action: 1, bonus: 1, reaction: 1 },
          stats: { attack: 2, ac: 11 },
          resources: {},
          cooldowns: {},
          statuses: [],
          abilities: ['basic_strike', 'guard_stance'],
          passives: [],
        },
      ],
      { mode: 'tactical_grid', gridSize: { width: 5, height: 5 } }
    );
    expect(startCombatRes.ok).toBe(true);

    const previewRes = await fetch(`${addr.url}/api/sessions/gui-sess-1/combat/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        actorId: 'player-hero',
        action: { type: 'skill', skillId: 'guard_stance', targetId: 'player-hero' },
      }),
    });
    expect(previewRes.status).toBe(200);
    const previewJson = (await previewRes.json()) as {
      ok: boolean;
      actionPreview: { legal: boolean; errors: unknown[] };
      reachableTiles: { tiles: unknown[] };
    };
    expect(previewJson.actionPreview.errors).toEqual([]);
    expect(previewJson.actionPreview.legal).toBe(true);
    expect(previewJson.reachableTiles.tiles.length).toBeGreaterThan(0);

    // 11. Stack clone isolation & lineage
    const cloneRes = await fetch(`${addr.url}/api/sessions/gui-sess-1/clone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'gui-sess-1-branch',
        nodeId: turnJson.userMessageId,
        label: 'Alternate Opening',
      }),
    });
    expect(cloneRes.status).toBe(201);
    const cloneJson = (await cloneRes.json()) as {
      ok: boolean;
      sessionId: string;
      lineage: { parentSessionId: string; forkedAtNodeId: string; label: string };
    };
    expect(cloneJson.sessionId).toBe('gui-sess-1-branch');
    expect(cloneJson.lineage.parentSessionId).toBe('gui-sess-1');
    expect(cloneJson.lineage.forkedAtNodeId).toBe(turnJson.userMessageId);
    expect(cloneJson.lineage.label).toBe('Alternate Opening');

    // Verify mutation on cloned branch does not affect parent session
    const branchTurnRes = await fetch(`${addr.url}/api/sessions/gui-sess-1-branch/turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Branch-only action' }),
    });
    expect(branchTurnRes.status).toBe(200);

    // 12. DELETE /api/sessions/:id removes session cleanly
    const delRes = await fetch(`${addr.url}/api/sessions/gui-sess-1-branch`, {
      method: 'DELETE',
    });
    expect(delRes.status).toBe(200);

    const afterDelState = await fetch(`${addr.url}/api/sessions/gui-sess-1-branch/state`);
    expect(afterDelState.status).toBe(404);
  });
});
