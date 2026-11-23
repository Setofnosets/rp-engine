import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMockModelGateway } from '../../src/gateway/mock-provider.js';
import { RefereeDaemon } from '../../src/server/daemon.js';
import { STOCK_FREEFORM_PACK } from '../../src/schema/stock-system-packs.js';
import type { SystemPack } from '../../src/schema/tracker-module.js';

function createPngChunk(type: string, data: Buffer): Buffer {
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function buildSyntheticCardPngBase64(cardObj: Record<string, unknown>): string {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(1, 0);
  ihdrData.writeUInt32BE(1, 4);
  ihdrData.writeUInt8(8, 8);
  ihdrData.writeUInt8(6, 9);

  const encoded = Buffer.from(JSON.stringify(cardObj), 'utf8').toString('base64');
  const textChunk = Buffer.concat([
    Buffer.from('chara', 'latin1'),
    Buffer.from([0x00]),
    Buffer.from(encoded, 'utf8'),
  ]);

  const png = Buffer.concat([
    signature,
    createPngChunk('IHDR', ihdrData),
    createPngChunk('tEXt', textChunk),
    createPngChunk('IEND', Buffer.alloc(0)),
  ]);
  return png.toString('base64');
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
        eventName = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trim());
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

describe('PR-6.1: Localhost HTTP & SSE Service Daemon', () => {
  const activeDaemons: RefereeDaemon[] = [];

  afterEach(async () => {
    while (activeDaemons.length > 0) {
      const daemon = activeDaemons.pop();
      if (daemon !== undefined) {
        await daemon.stop();
      }
    }
  });

  it('boots on 127.0.0.1:0, serves system packs, imports ST JSON / PNG / Multihog cartridges, runs full session lifecycle & SSE, and stops cleanly', async () => {
    let narratorCallCount = 0;
    const gateway = createMockModelGateway({
      narrator: () => {
        narratorCallCount += 1;
        return {
          kind: 'text',
          text: `Narrator reply #${narratorCallCount}: Rain glistens on the cobblestones.`,
        };
      },
      state_tracker: {
        kind: 'json',
        value: {
          scene: {
            location: 'Midnight Library',
            mood: 'tense',
          },
          custom_fields: {
            milestone_note: 'Entered the library after curfew',
          },
        },
      },
      chronicle_router: {
        kind: 'json',
        value: {
          shouldRecord: true,
          category: 'event',
          title: 'Curfew Arrival',
          summary: 'Arrived at the Midnight Library during the storm.',
          keywords: ['library', 'curfew'],
          involvedEntityIds: [],
        },
      },
      game_system_wizard: {
        kind: 'json',
        value: {
          module: {
            id: 'sanctuary_ward',
            name: 'Sanctuary Ward Integrity',
            description: 'Tracks protective ward stability around the library.',
            enabled: true,
            scope: 'session',
            target: 'global',
            effectOwner: 'hybrid',
            cadence: 'every_turn',
            fields: {
              ward_integrity: {
                type: 'meter',
                min: 0,
                max: 100,
                default: 100,
                writableByTracker: true,
                confirmPolicy: 'auto',
                description: 'Remaining protective ward strength',
              },
            },
            trackerInstruction: 'Adjust ward_integrity when wards are stressed or reinforced.',
            narratorRule: 'Describe ward hum and flickering runes as integrity drops.',
            ui: { widget: 'bar', order: 12 },
          },
          clockTriggers: [
            { on: 'slot', op: 'increment', field: 'ward_integrity', value: -5 },
          ],
          suggestedBeats: [
            {
              id: 'beat_ward_weak',
              class: 'nudge',
              priority: 75,
              when: { field: 'ward_integrity', lte: 30 },
              nudge: 'Warn that the outer runes are fracturing.',
            },
          ],
          previewCard: {
            title: 'Sanctuary Ward',
            ward_integrity: 100,
          },
        },
      },
    });

    const daemon = new RefereeDaemon({
      host: '127.0.0.1',
      port: 0,
      gateway,
    });
    activeDaemons.push(daemon);

    const addr = await daemon.start();
    expect(addr.host).toBe('127.0.0.1');
    expect(addr.port).toBeGreaterThan(0);
    expect(addr.url).toBe(`http://127.0.0.1:${addr.port}`);

    // 1. Health check
    const healthRes = await fetch(`${addr.url}/api/health`);
    expect(healthRes.status).toBe(200);
    const healthJson = (await healthRes.json()) as { ok: boolean; sessions: number };
    expect(healthJson).toEqual({ ok: true, sessions: 0 });

    // 2. System Packs GET & POST
    const packsRes = await fetch(`${addr.url}/api/system-packs`);
    expect(packsRes.status).toBe(200);
    const packsJson = (await packsRes.json()) as { ok: boolean; systemPacks: SystemPack[] };
    expect(packsJson.ok).toBe(true);
    expect(packsJson.systemPacks.map((p) => p.id)).toEqual(
      expect.arrayContaining([
        'stock-freeform',
        'stock-slice-of-life',
        'stock-tactical-rpg',
        'stock-living-world',
      ])
    );

    const customPack: SystemPack = {
      ...STOCK_FREEFORM_PACK,
      id: 'custom-noir-pack',
      name: 'Custom Noir Pack',
      description: 'Custom noir test pack',
    };
    const postPackRes = await fetch(`${addr.url}/api/system-packs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(customPack),
    });
    expect(postPackRes.status).toBe(201);
    const postPackJson = (await postPackRes.json()) as { ok: boolean; systemPack: SystemPack };
    expect(postPackJson.systemPack.id).toBe('custom-noir-pack');

    // 3. Import Cartridges: ST JSON, base64 PNG, and Multihog
    const stImportRes = await fetch(`${addr.url}/api/cartridges/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
          name: 'Elena Vance',
          description: 'Archivist of the Midnight Library.',
          personality: 'Composed, observant',
          scenario: 'A storm rages outside the library.',
          first_mes: 'She sets down her brass lantern.',
          character_book: {
            entries: [
              {
                id: 1,
                keys: ['lantern'],
                content: 'The brass lantern reveals hidden ledger annotations.',
                enabled: true,
                insertion_order: 20,
              },
            ],
          },
        },
      }),
    });
    expect(stImportRes.status).toBe(201);
    const stImportJson = (await stImportRes.json()) as {
      ok: boolean;
      kind: string;
      cartridgeId: string;
    };
    expect(stImportJson.ok).toBe(true);
    expect(stImportJson.kind).toBe('st_card');
    expect(stImportJson.cartridgeId).toBe('elena-vance');

    const pngBase64 = buildSyntheticCardPngBase64({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: 'Marcus Sterling',
        description: 'A weary detective.',
      },
    });
    const pngImportRes = await fetch(`${addr.url}/api/cartridges/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pngBase64 }),
    });
    expect(pngImportRes.status).toBe(201);
    const pngImportJson = (await pngImportRes.json()) as { ok: boolean; cartridgeId: string };
    expect(pngImportJson.cartridgeId).toBe('marcus-sterling');

    const multihogRes = await fetch(`${addr.url}/api/cartridges/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        format: 'multihog-game-cartridge',
        name: 'Alder Creek Mystery',
        payload: {
          customFields: {
            suspicion: {
              type: 'meter',
              min: 0,
              max: 100,
              default: 10,
              writableByTracker: true,
              confirmPolicy: 'auto',
            },
          },
        },
      }),
    });
    expect(multihogRes.status).toBe(201);
    const multihogJson = (await multihogRes.json()) as {
      ok: boolean;
      kind: string;
      systemPack: SystemPack;
    };
    expect(multihogJson.kind).toBe('multihog');
    expect(multihogJson.systemPack.id).toBe('alder-creek-mystery');

    const listCartridgesRes = await fetch(`${addr.url}/api/cartridges`);
    expect(listCartridgesRes.status).toBe(200);
    const listCartridgesJson = (await listCartridgesRes.json()) as {
      ok: boolean;
      cartridges: Array<{ card: { id: string } }>;
    };
    expect(listCartridgesJson.cartridges.map((c) => c.card.id)).toEqual([
      'alder-creek-mystery',
      'elena-vance',
      'marcus-sterling',
    ]);

    // 4. Create Session + check initial state
    const createSessRes = await fetch(`${addr.url}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'sess-demo-1',
        cartridgeId: 'elena-vance',
        seed: 'daemon-seed-42',
        userControlRoomLayer: {
          tuningDials: { narrativePacing: 'slow_burn' },
          gameSystemOverrides: {
            episodic_chronicle: { cadence: 'every_turn' },
          },
        },
      }),
    });
    expect(createSessRes.status).toBe(201);
    const createSessJson = (await createSessRes.json()) as { ok: boolean; sessionId: string };
    expect(createSessJson.sessionId).toBe('sess-demo-1');

    const stateRes = await fetch(`${addr.url}/api/sessions/sess-demo-1/state`);
    expect(stateRes.status).toBe(200);
    const stateJson = (await stateRes.json()) as {
      ok: boolean;
      state: { meta: { turn: number } };
      beatLedger: unknown;
      combatState: unknown;
      config: { tuningDials: { narrativePacing: string } };
      pendingConfirmations: unknown[];
      diffReport: { overallBadge: string };
      swipeTree: { activeLeafMessageId: string | null };
    };
    expect(stateJson.ok).toBe(true);
    expect(stateJson.state.meta.turn).toBe(0);
    expect(stateJson.combatState).toBeNull();
    expect(stateJson.config.tuningDials.narrativePacing).toBe('slow_burn');
    expect(stateJson.diffReport.overallBadge).toBe('user_customized');

    // 5. Open SSE stream before executing a turn
    const sseAbort = new AbortController();
    const sseResponse = await fetch(`${addr.url}/api/sessions/sess-demo-1/stream`, {
      signal: sseAbort.signal,
    });
    expect(sseResponse.status).toBe(200);
    expect(sseResponse.headers.get('content-type')).toContain('text/event-stream');
    const reader = sseResponse.body?.getReader();
    expect(reader).toBeDefined();

    // Read initial ": connected" preamble so connection is guaranteed active in SessionSseHub
    const firstRead = await reader!.read();
    expect(firstRead.done).toBe(false);
    expect(daemon.getRegistry().sseHub.getClientCount('sess-demo-1')).toBe(1);

    // 6. Execute Turn 1 with directorSteering
    const turn1Res = await fetch(`${addr.url}/api/sessions/sess-demo-1/turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'I examine the brass lantern on the desk.',
        directorSteering: {
          oocNudge: 'Highlight the eerie storm shadows.',
          clockAction: 'hold',
        },
      }),
    });
    expect(turn1Res.status).toBe(200);
    const turn1Json = (await turn1Res.json()) as {
      ok: boolean;
      turn: number;
      assistantMessageId: string;
      swipeIndex: number;
      narratorText: string;
      pendingConfirmations: unknown[];
      compiledPrompt: { renderedSections: Record<string, string> };
    };
    expect(turn1Json.ok).toBe(true);
    expect(turn1Json.turn).toBe(1);
    expect(turn1Json.swipeIndex).toBe(0);
    expect(turn1Json.narratorText).toContain('Narrator reply #1');
    expect(turn1Json.compiledPrompt.renderedSections['plot']).toContain(
      'Highlight the eerie storm shadows.'
    );
    // episodic_chronicle.milestone_note has confirmPolicy: 'batch_confirm' so turn 1 queues it
    expect(turn1Json.pendingConfirmations.length).toBeGreaterThanOrEqual(1);

    // Collect SSE frames emitted during Turn 1
    let sseBuffer = new TextDecoder().decode(firstRead.value);
    for (let i = 0; i < 20; i += 1) {
      if (sseBuffer.includes('event: tracker_completed')) {
        break;
      }
      const chunk = await reader!.read();
      if (chunk.done) {
        break;
      }
      sseBuffer += new TextDecoder().decode(chunk.value);
    }
    const sseEvents = parseSseFrames(sseBuffer);
    const sseEventTypes = sseEvents.map((e) => e.event);
    expect(sseEventTypes).toContain('turn_started');
    expect(sseEventTypes).toContain('prompt_compiled');
    expect(sseEventTypes).toContain('narrator_completed');
    expect(sseEventTypes).toContain('tracker_completed');
    expect(sseEventTypes).toContain('confirmations_queued');

    sseAbort.abort();

    // 7. Confirm pending patch
    const confirmRes = await fetch(`${addr.url}/api/sessions/sess-demo-1/confirm-patch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'accept_all' }),
    });
    expect(confirmRes.status).toBe(200);
    const confirmJson = (await confirmRes.json()) as { ok: boolean; appliedCount: number };
    expect(confirmJson.ok).toBe(true);
    expect(confirmJson.appliedCount).toBeGreaterThanOrEqual(1);

    // 8. Live-toggle a Game System module via PATCH /control-room (disable relationship_affinity,
    //    and set episodic_chronicle cadence to every_turn so chronicle_router fires on next turn)
    const patchCrRes = await fetch(`${addr.url}/api/sessions/sess-demo-1/control-room`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        gameSystemOverrides: {
          relationship_affinity: { enabled: false },
          episodic_chronicle: { cadence: 'every_turn' },
        },
      }),
    });
    expect(patchCrRes.status).toBe(200);
    const patchCrJson = (await patchCrRes.json()) as {
      ok: boolean;
      config: {
        gameSystems: Array<{ id: string; enabled: boolean; cadence: unknown }>;
        tuningDials: { narrativePacing: string };
      };
    };
    const relMod = patchCrJson.config.gameSystems.find((m) => m.id === 'relationship_affinity');
    const chronMod = patchCrJson.config.gameSystems.find((m) => m.id === 'episodic_chronicle');
    expect(relMod?.enabled).toBe(false);
    expect(chronMod?.cadence).toBe('every_turn');
    // Previous userControlRoomLayer dial preserved via merge
    expect(patchCrJson.config.tuningDials.narrativePacing).toBe('slow_burn');

    // 9. Game System Wizard generate
    const wizardRes = await fetch(`${addr.url}/api/wizard/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        description: 'Track protective library ward integrity.',
        effectOwner: 'hybrid',
      }),
    });
    expect(wizardRes.status).toBe(200);
    const wizardJson = (await wizardRes.json()) as {
      ok: boolean;
      module: { id: string };
      previewCard: Record<string, unknown>;
      previewSummary: string;
    };
    expect(wizardJson.ok).toBe(true);
    expect(wizardJson.module.id).toBe('sanctuary_ward');
    expect(wizardJson.previewCard['ward_integrity']).toBe(100);
    expect(wizardJson.previewSummary).toContain('Sanctuary Ward Integrity');

    // 10. Swipe regenerate + switch
    const regenRes = await fetch(`${addr.url}/api/sessions/sess-demo-1/swipe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'regenerate',
        assistantMessageId: turn1Json.assistantMessageId,
        directorSteering: {
          oocNudge: 'Emphasize the flicker of candlelight.',
        },
      }),
    });
    expect(regenRes.status).toBe(200);
    const regenJson = (await regenRes.json()) as {
      ok: boolean;
      action: string;
      swipeIndex: number;
      narratorText: string;
    };
    expect(regenJson.action).toBe('regenerate');
    expect(regenJson.swipeIndex).toBe(1);
    expect(regenJson.narratorText).toContain('Narrator reply #2');

    const switchRes = await fetch(`${addr.url}/api/sessions/sess-demo-1/swipe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'switch',
        assistantMessageId: turn1Json.assistantMessageId,
        swipeIndex: 0,
      }),
    });
    expect(switchRes.status).toBe(200);
    const switchJson = (await switchRes.json()) as {
      ok: boolean;
      action: string;
      swipeIndex: number;
      content: string;
    };
    expect(switchJson.action).toBe('switch');
    expect(switchJson.swipeIndex).toBe(0);
    expect(switchJson.content).toContain('Narrator reply #1');

    // 11. ST Bridge compile-prompt (should NOT invoke narrator LLM)
    const callsBeforeCompile = narratorCallCount;
    const compileRes = await fetch(`${addr.url}/api/sessions/sess-demo-1/compile-prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        latestInput: 'I open the leather-bound ledger.',
        directorSteering: {
          oocNudge: 'Reveal a ciphered signature on the page.',
        },
      }),
    });
    expect(compileRes.status).toBe(200);
    const compileJson = (await compileRes.json()) as {
      ok: boolean;
      sections: { state: string; combatOutcome: string; plot: string; world: string };
      compiledPrompt: {
        messages: Array<{ role: string; content: string }>;
        totalEstimatedTokens: number;
      };
    };
    expect(compileJson.ok).toBe(true);
    expect(narratorCallCount).toBe(callsBeforeCompile);
    expect(compileJson.sections.state).toContain('[STATE]');
    expect(compileJson.sections.plot).toContain('[PLOT]');
    expect(compileJson.sections.plot).toContain('Reveal a ciphered signature on the page.');
    expect(compileJson.compiledPrompt.totalEstimatedTokens).toBeGreaterThan(0);

    // 12. ST Bridge post-narrate (injects external narrator text & runs tracker/chronicle without calling narrator LLM)
    const postNarrateRes = await fetch(`${addr.url}/api/sessions/sess-demo-1/post-narrate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userText: 'I open the leather-bound ledger.',
        narratorText: 'External ST Narrator: The ink shimmers beneath the brass lantern.',
      }),
    });
    expect(postNarrateRes.status).toBe(200);
    const postNarrateJson = (await postNarrateRes.json()) as {
      ok: boolean;
      turn: number;
      narratorText: string;
    };
    expect(postNarrateJson.ok).toBe(true);
    expect(postNarrateJson.turn).toBe(2);
    expect(postNarrateJson.narratorText).toBe(
      'External ST Narrator: The ink shimmers beneath the brass lantern.'
    );
    expect(narratorCallCount).toBe(callsBeforeCompile);

    // 13. Audit log with filters
    const auditTurn2Res = await fetch(
      `${addr.url}/api/sessions/sess-demo-1/audit?turn=2&source=tracker`
    );
    expect(auditTurn2Res.status).toBe(200);
    const auditTurn2Json = (await auditTurn2Res.json()) as {
      ok: boolean;
      entries: Array<{ turn: number; source: string; path: string }>;
    };
    expect(auditTurn2Json.ok).toBe(true);
    expect(auditTurn2Json.entries.length).toBeGreaterThan(0);
    expect(auditTurn2Json.entries.every((e) => e.turn === 2 && e.source === 'tracker')).toBe(true);

    const auditPrefixRes = await fetch(
      `${addr.url}/api/sessions/sess-demo-1/audit?pathPrefix=scene.`
    );
    expect(auditPrefixRes.status).toBe(200);
    const auditPrefixJson = (await auditPrefixRes.json()) as {
      ok: boolean;
      entries: Array<{ path: string }>;
    };
    expect(auditPrefixJson.entries.length).toBeGreaterThan(0);
    expect(auditPrefixJson.entries.every((e) => e.path.startsWith('scene.'))).toBe(true);

    // 14. Chronicle events
    const chronicleRes = await fetch(`${addr.url}/api/sessions/sess-demo-1/chronicle`);
    expect(chronicleRes.status).toBe(200);
    const chronicleJson = (await chronicleRes.json()) as {
      ok: boolean;
      events: Array<{ title: string; category: string }>;
    };
    expect(chronicleJson.ok).toBe(true);
    expect(chronicleJson.events.length).toBeGreaterThanOrEqual(1);
    expect(chronicleJson.events[0]?.title).toBe('Curfew Arrival');

    // 15. Clean shutdown
    await daemon.stop();
    await expect(fetch(`${addr.url}/api/health`)).rejects.toThrow();
  });

  it('enforces 1 MB JSON body limit, rejects invalid JSON and prototype pollution, handles 404s, and serializes concurrent session turns', async () => {
    let activeTurns = 0;
    let maxConcurrentTurns = 0;
    const gateway = createMockModelGateway({
      narrator: async () => {
        activeTurns += 1;
        if (activeTurns > maxConcurrentTurns) {
          maxConcurrentTurns = activeTurns;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
        activeTurns -= 1;
        return { kind: 'text', text: 'Sequential turn response.' };
      },
    });

    const daemon = new RefereeDaemon({
      host: '127.0.0.1',
      port: 0,
      gateway,
    });
    activeDaemons.push(daemon);
    const addr = await daemon.start();

    // Invalid JSON -> 400
    const badJsonRes = await fetch(`${addr.url}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"bad": ',
    });
    expect(badJsonRes.status).toBe(400);

    // Prototype pollution key -> 400
    const protoRes = await fetch(`${addr.url}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"__proto__":{"polluted":true}}',
    });
    expect(protoRes.status).toBe(400);

    // Oversized body (> 1 MB) -> 413
    const hugeBody = JSON.stringify({ text: 'a'.repeat(1_050_000) });
    const tooLargeRes = await fetch(`${addr.url}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: hugeBody,
    });
    expect(tooLargeRes.status).toBe(413);

    // Unknown session -> 404
    const missingSessRes = await fetch(`${addr.url}/api/sessions/does-not-exist/state`);
    expect(missingSessRes.status).toBe(404);

    // Switch system pack via PATCH /control-room and verify per-session mutex serialization
    const sessRes = await fetch(`${addr.url}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'concurrent-sess' }),
    });
    expect(sessRes.status).toBe(201);

    const switchPackRes = await fetch(`${addr.url}/api/sessions/concurrent-sess/control-room`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ systemPackId: 'stock-freeform' }),
    });
    expect(switchPackRes.status).toBe(200);

    const [t1, t2, t3] = await Promise.all([
      fetch(`${addr.url}/api/sessions/concurrent-sess/turn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Turn one' }),
      }).then((r) => r.json() as Promise<{ ok: boolean; turn: number }>),
      fetch(`${addr.url}/api/sessions/concurrent-sess/turn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Turn two' }),
      }).then((r) => r.json() as Promise<{ ok: boolean; turn: number }>),
      fetch(`${addr.url}/api/sessions/concurrent-sess/turn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Turn three' }),
      }).then((r) => r.json() as Promise<{ ok: boolean; turn: number }>),
    ]);

    expect(maxConcurrentTurns).toBe(1);
    expect([t1.turn, t2.turn, t3.turn].sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });
});

describe('PR-7.12: Daemon dataDir Wiring & Complete REST API', () => {
  const activeDaemons: RefereeDaemon[] = [];
  const tempDirs: string[] = [];

  async function makeTempDir(prefix: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    while (activeDaemons.length > 0) {
      const daemon = activeDaemons.pop();
      if (daemon !== undefined) {
        await daemon.stop();
      }
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir !== undefined) {
        await fs.rm(dir, { recursive: true, force: true });
      }
    }
  });

  it('persists connections (with sampling params & role removal) and named profiles across daemon restart', async () => {
    const dataDir = await makeTempDir('referee-daemon-conn-');
    const daemon1 = new RefereeDaemon({ host: '127.0.0.1', port: 0, dataDir });
    activeDaemons.push(daemon1);
    const addr1 = await daemon1.start();

    // Update connections with full sampling params + timeoutMs + supportsJsonSchema
    const putRes = await fetch(`${addr1.url}/api/connections`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        defaultConnection: {
          provider: 'openai_compatible',
          baseUrl: 'http://127.0.0.1:8080/v1',
          model: 'default-model',
          apiKey: 'secret-default-key',
          timeoutMs: 15000,
          supportsJsonSchema: true,
          temperature: 0.65,
          maxTokens: 1024,
          topP: 0.92,
          minP: 0.05,
        },
        connections: {
          narrator: {
            provider: 'openai_compatible',
            baseUrl: 'http://127.0.0.1:8080/v1',
            model: 'narrator-model',
            apiKey: 'secret-narrator-key',
            temperature: 0.85,
          },
          state_tracker: {
            provider: 'ollama',
            baseUrl: 'http://127.0.0.1:11434',
            model: 'tracker-model',
          },
        },
      }),
    });
    expect(putRes.status).toBe(200);
    const putJson = (await putRes.json()) as {
      ok: boolean;
      defaultConnection: { model: string; temperature: number; timeoutMs: number; supportsJsonSchema: boolean };
      connections: Record<string, { model: string; temperature?: number }>;
    };
    expect(putJson.defaultConnection.temperature).toBe(0.65);
    expect(putJson.defaultConnection.timeoutMs).toBe(15000);
    expect(putJson.defaultConnection.supportsJsonSchema).toBe(true);
    expect(putJson.connections.narrator?.model).toBe('narrator-model');
    expect(putJson.connections.state_tracker?.model).toBe('tracker-model');

    // Remove state_tracker override with null
    const removeRoleRes = await fetch(`${addr1.url}/api/connections`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        connections: {
          state_tracker: null,
        },
      }),
    });
    expect(removeRoleRes.status).toBe(200);
    const removeRoleJson = (await removeRoleRes.json()) as {
      connections: Record<string, unknown>;
    };
    expect(removeRoleJson.connections.state_tracker).toBeUndefined();

    // Save named profile & activate it
    const saveProfileRes = await fetch(`${addr1.url}/api/connections/profiles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'local-fast',
        defaultConnection: {
          provider: 'ollama',
          baseUrl: 'http://127.0.0.1:11434',
          model: 'llama3.2',
          apiKey: 'profile-secret',
          temperature: 0.5,
        },
      }),
    });
    expect(saveProfileRes.status).toBe(201);

    const activateRes = await fetch(`${addr1.url}/api/connections/profiles/local-fast/activate`, {
      method: 'POST',
    });
    expect(activateRes.status).toBe(200);
    const activateJson = (await activateRes.json()) as {
      activeProfile: string;
      defaultConnection: { model: string };
    };
    expect(activateJson.activeProfile).toBe('local-fast');
    expect(activateJson.defaultConnection.model).toBe('llama3.2');

    // Verify redaction on GET /api/connections?redact=true
    const redactedRes = await fetch(`${addr1.url}/api/connections?redact=true`);
    expect(redactedRes.status).toBe(200);
    const redactedJson = (await redactedRes.json()) as {
      defaultConnection: { apiKey?: string };
      activeProfile: string;
      profiles: Record<string, { defaultConnection?: { apiKey?: string } }>;
    };
    expect(redactedJson.defaultConnection.apiKey).toBe('***');
    expect(redactedJson.profiles['local-fast']?.defaultConnection?.apiKey).toBe('***');

    await daemon1.stop();

    // Restart daemon on same dataDir and verify connections & profiles reloaded
    const daemon2 = new RefereeDaemon({ host: '127.0.0.1', port: 0, dataDir });
    activeDaemons.push(daemon2);
    const addr2 = await daemon2.start();

    const getRes2 = await fetch(`${addr2.url}/api/connections`);
    expect(getRes2.status).toBe(200);
    const getJson2 = (await getRes2.json()) as {
      activeProfile: string;
      defaultConnection: { model: string; temperature: number };
      profiles: Record<string, unknown>;
    };
    expect(getJson2.activeProfile).toBe('local-fast');
    expect(getJson2.defaultConnection.model).toBe('llama3.2');
    expect(getJson2.defaultConnection.temperature).toBe(0.5);
    expect(getJson2.profiles['local-fast']).toBeDefined();

    // Delete profile
    const delRes = await fetch(`${addr2.url}/api/connections/profiles/local-fast`, {
      method: 'DELETE',
    });
    expect(delRes.status).toBe(200);
    const delJson = (await delRes.json()) as {
      deleted: string;
      activeProfile: string | null;
      profiles: Record<string, unknown>;
    };
    expect(delJson.deleted).toBe('local-fast');
    expect(delJson.activeProfile).toBeNull();
    expect(delJson.profiles['local-fast']).toBeUndefined();
  });

  it('supports ST preset import, apply to session, sheetPresetId, export round-trip, and preset deletion', async () => {
    const dataDir = await makeTempDir('referee-daemon-presets-');
    const daemon = new RefereeDaemon({ host: '127.0.0.1', port: 0, dataDir });
    activeDaemons.push(daemon);
    const addr = await daemon.start();

    // Create a session
    const sessRes = await fetch(`${addr.url}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'preset-sess' }),
    });
    expect(sessRes.status).toBe(201);

    // Import ST Chat Completion preset and apply to session
    const importRes = await fetch(`${addr.url}/api/presets/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'noir-chat-preset',
        name: 'Noir Chat Preset',
        sessionId: 'preset-sess',
        preset: {
          temperature: 0.77,
          openai_max_tokens: 600,
          openai_max_context: 8192,
          prompts: [
            {
              identifier: 'main',
              name: 'Main Prompt',
              role: 'system',
              content: 'Write atmospheric noir prose.',
            },
          ],
          prompt_order: [
            {
              character_id: 100000,
              order: [{ identifier: 'main', enabled: true }],
            },
          ],
        },
      }),
    });
    expect(importRes.status).toBe(201);
    const importJson = (await importRes.json()) as {
      ok: boolean;
      presetId: string;
      format: string;
      generation: { temperature?: number; maxTokens?: number };
    };
    expect(importJson.ok).toBe(true);
    expect(importJson.presetId).toBe('noir-chat-preset');
    expect(importJson.format).toBe('st_chat_completion');
    expect(importJson.generation.temperature).toBe(0.77);

    // Verify GET /api/presets lists it
    const listRes = await fetch(`${addr.url}/api/presets`);
    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json()) as { presets: Array<{ id: string }> };
    expect(listJson.presets.map((p) => p.id)).toContain('noir-chat-preset');

    // Apply sheetPresetId + presetId via /control-room/apply-preset
    const applyRes = await fetch(`${addr.url}/api/sessions/preset-sess/control-room/apply-preset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        presetId: 'noir-chat-preset',
        sheetPresetId: 'dnd-adventurer',
        target: 'pc',
      }),
    });
    expect(applyRes.status).toBe(200);
    const applyJson = (await applyRes.json()) as {
      ok: boolean;
      config: { generation?: { temperature?: number }; pcCoreSections: Array<{ id: string }> };
    };
    expect(applyJson.config.generation?.temperature).toBe(0.77);
    expect(applyJson.config.pcCoreSections.length).toBeGreaterThan(0);

    // Export in st_chat, st_text, and referee formats
    const exportChat = await fetch(`${addr.url}/api/sessions/preset-sess/preset/export?format=st_chat`);
    expect(exportChat.status).toBe(200);
    const exportChatJson = (await exportChat.json()) as {
      ok: boolean;
      format: string;
      preset: { temperature?: number; prompts?: unknown[] };
    };
    expect(exportChatJson.format).toBe('st_chat');
    expect(exportChatJson.preset.temperature).toBe(0.77);
    expect(Array.isArray(exportChatJson.preset.prompts)).toBe(true);

    const exportText = await fetch(`${addr.url}/api/sessions/preset-sess/preset/export?format=st_text`);
    expect(exportText.status).toBe(200);
    const exportTextJson = (await exportText.json()) as { format: string; preset: { temp?: number } };
    expect(exportTextJson.format).toBe('st_text');

    const exportRef = await fetch(`${addr.url}/api/sessions/preset-sess/preset/export?format=referee`);
    expect(exportRef.status).toBe(200);
    const exportRefJson = (await exportRef.json()) as { format: string; preset: { packId: string } };
    expect(exportRefJson.format).toBe('referee');
    expect(exportRefJson.preset.packId).toBe('stock-freeform');

    // Delete preset
    const delPresetRes = await fetch(`${addr.url}/api/presets/noir-chat-preset`, { method: 'DELETE' });
    expect(delPresetRes.status).toBe(200);
  });

  it('supports user personas, character roster/dossier/upsert, session resume/branch across restart, and combat start', async () => {
    const dataDir = await makeTempDir('referee-daemon-full-');
    const gateway = createMockModelGateway({
      narrator: { kind: 'text', text: 'The neon sign flickers above the alley.' },
      state_tracker: { kind: 'json', value: { scene: { location: 'Neon Alley', mood: 'gritty' } } },
    });

    const daemon1 = new RefereeDaemon({ host: '127.0.0.1', port: 0, dataDir, gateway });
    activeDaemons.push(daemon1);
    const addr1 = await daemon1.start();

    // 1. Save a persona
    const postPersonaRes = await fetch(`${addr1.url}/api/personas`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'detective-kael',
        name: 'Kael Vance',
        description: 'A cybernetic private investigator.',
      }),
    });
    expect(postPersonaRes.status).toBe(201);

    // 2. Start session with personaId
    const sessRes = await fetch(`${addr1.url}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'noir-run-1',
        systemPackId: 'stock-tactical-rpg',
        personaId: 'detective-kael',
      }),
    });
    expect(sessRes.status).toBe(201);

    // Verify [PERSONA] in compile-prompt
    const compileRes = await fetch(`${addr1.url}/api/sessions/noir-run-1/compile-prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ latestInput: 'Check my trenchcoat.' }),
    });
    expect(compileRes.status).toBe(200);
    const compileJson = (await compileRes.json()) as {
      compiledPrompt: { messages: Array<{ content: string }> };
    };
    const combinedPrompt = compileJson.compiledPrompt.messages.map((m) => m.content).join('\n');
    expect(combinedPrompt).toContain('[PERSONA]');
    expect(combinedPrompt).toContain('Kael Vance');

    // 3. Execute a turn and persist across daemon restart
    const turnRes = await fetch(`${addr1.url}/api/sessions/noir-run-1/turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'I step into the alley.' }),
    });
    expect(turnRes.status).toBe(200);

    await daemon1.stop();

    // 4. Restart daemon on same dataDir, discover saved session, resume & branch
    const daemon2 = new RefereeDaemon({ host: '127.0.0.1', port: 0, dataDir, gateway });
    activeDaemons.push(daemon2);
    const addr2 = await daemon2.start();

    const listSessRes = await fetch(`${addr2.url}/api/sessions`);
    expect(listSessRes.status).toBe(200);
    const listSessJson = (await listSessRes.json()) as {
      activeSessions: unknown[];
      savedSessionIds: string[];
    };
    expect(listSessJson.activeSessions).toEqual([]);
    expect(listSessJson.savedSessionIds).toContain('noir-run-1');

    const resumeRes = await fetch(`${addr2.url}/api/sessions/noir-run-1/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(resumeRes.status).toBe(200);
    const resumeJson = (await resumeRes.json()) as {
      sessionId: string;
      state: { meta: { turn: number } };
    };
    expect(resumeJson.sessionId).toBe('noir-run-1');
    expect(resumeJson.state.meta.turn).toBe(1);

    const branchRes = await fetch(`${addr2.url}/api/sessions/noir-run-1/branch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetSessionId: 'noir-run-branch',
        branchAtTurn: 1,
        load: true,
      }),
    });
    expect(branchRes.status).toBe(201);
    const branchJson = (await branchRes.json()) as {
      ok: boolean;
      targetSessionId: string;
      session: { sessionId: string; state: { meta: { turn: number } } };
    };
    expect(branchJson.ok).toBe(true);
    expect(branchJson.targetSessionId).toBe('noir-run-branch');
    expect(branchJson.session.sessionId).toBe('noir-run-branch');
    expect(branchJson.session.state.meta.turn).toBe(1);

    // 5. Upsert and inspect characters on the resumed session
    const addCharRes = await fetch(`${addr2.url}/api/sessions/noir-run-1/characters`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        characterId: 'npc-lyra',
        name: 'Lyra Chen',
        allegiance: 'syndicate',
        mood: 'guarded',
      }),
    });
    expect(addCharRes.status).toBe(201);

    const patchCharRes = await fetch(`${addr2.url}/api/sessions/noir-run-1/characters/npc-lyra`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mood: 'cooperative' }),
    });
    expect(patchCharRes.status).toBe(200);

    const rosterRes = await fetch(`${addr2.url}/api/sessions/noir-run-1/characters?query=Lyra`);
    expect(rosterRes.status).toBe(200);
    const rosterJson = (await rosterRes.json()) as {
      characters: Array<{ id: string; mood: string }>;
    };
    expect(rosterJson.characters.some((c) => c.id === 'npc-lyra' && c.mood === 'cooperative')).toBe(
      true
    );

    const dossierRes = await fetch(`${addr2.url}/api/sessions/noir-run-1/characters/npc-lyra`);
    expect(dossierRes.status).toBe(200);
    const dossierJson = (await dossierRes.json()) as {
      dossier: { summary: { name: string }; agency: { mood: string } };
    };
    expect(dossierJson.dossier.summary.name).toBe('Lyra Chen');
    expect(dossierJson.dossier.agency.mood).toBe('cooperative');

    const missingDossierRes = await fetch(
      `${addr2.url}/api/sessions/noir-run-1/characters/nonexistent`
    );
    expect(missingDossierRes.status).toBe(404);

    // 6. Start combat on the resumed session
    const combatRes = await fetch(`${addr2.url}/api/sessions/noir-run-1/combat/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        participants: [
          {
            id: 'player',
            name: 'Kael Vance',
            team: 'ally',
            hp: 30,
            maxHp: 30,
            stats: { initiative: 2 },
          },
          {
            id: 'thug-1',
            name: 'Street Enforcer',
            team: 'enemy',
            hp: 18,
            maxHp: 18,
            stats: { initiative: 1 },
          },
        ],
      }),
    });
    expect(combatRes.status).toBe(200);
    const combatJson = (await combatRes.json()) as {
      ok: boolean;
      combatState: { active: boolean; initiativeOrder: string[] };
    };
    expect(combatJson.combatState.active).toBe(true);
    expect(combatJson.combatState.initiativeOrder.length).toBe(2);
  });
});
