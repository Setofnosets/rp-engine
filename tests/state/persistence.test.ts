/// <reference types="node" />
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ControlRoomLayer } from '../../src/config/control-room-config.js';
import { type UserPersonaPreset } from '../../src/config/persona-preset.js';
import { nextInt } from '../../src/core/prng.js';
import { isErr, isOk } from '../../src/core/result.js';
import { STOCK_TACTICAL_RPG_PACK } from '../../src/schema/stock-system-packs.js';
import { type GameSystemModule } from '../../src/schema/tracker-module.js';
import { type AuditEntry } from '../../src/state/audit-log.js';
import { type PatchBatch } from '../../src/state/patch.js';
import {
  type EventLogRecord,
  appendAuditRecords,
  appendEventRecord,
  branchSave,
  formatCheckpointFilename,
  initSaveDirectory,
  loadSessionSave,
  saveActivePersonaAtomic,
  saveCheckpointAtomic,
  saveControlRoomLayerAtomic,
  saveSwipeTreeAtomic,
} from '../../src/state/persistence.js';
import { applyPatchBatch } from '../../src/state/reducer.js';
import { replayFromEvents } from '../../src/state/replay.js';
import {
  type StateCheckpoint,
  appendMessageTurn,
  computeStateHash,
  createSwipeTree,
  getLinearTranscript,
} from '../../src/state/swipe-tree.js';
import { type WorldState, cloneWorldState, createWorldState } from '../../src/state/world-state.js';

function makeInitialSimulationState(sessionId = 'campaign-30-turns'): WorldState {
  return createWorldState({
    sessionId,
    capabilities: {
      ...STOCK_TACTICAL_RPG_PACK.capabilities,
      spatialMode: 'emergent',
      factions: true,
      relationships: true,
      chronicle: true,
    },
    rngSeed: 'deterministic-campaign-seed',
    turn: 0,
    clocks: {
      turn: 0,
      storyTurn: 0,
      day: 1,
      inGameDate: '2026-07-01',
      slot: 'morning',
      timers: {
        patrol: { current: 0, max: 4, tickOn: 'slot', repeat: true },
      },
    },
    player: {
      id: 'player',
      name: 'Rowan',
      characterId: 'rowan',
      inventory: {
        items: { torch: 3, ration: 5 },
        currency: { gold: 25 },
      },
      customFields: { composure: 10 },
      sections: { sec_appearance: 'Weathered cloak.' },
    },
    scene: {
      location: 'Silvergate Outpost',
      mood: 'watchful',
      pacing: 'measured',
      presentCharacterIds: ['rowan', 'vesper'],
    },
    flags: { outpost_alert: false },
    counters: { supplies: 10, reputation: 0 },
    customFields: { threat_level: 1 },
    relations: {
      player: {
        vesper: { affinity: 5, maxAffinity: 100, label: 'acquaintance', tags: ['scout'] },
      },
    },
    characters: [
      {
        id: 'rowan',
        name: 'Rowan',
        status: 'active',
        presentInScene: true,
        locationId: null,
        formId: null,
        formGroup: null,
        sections: { sec_appearance: 'Weathered cloak.' },
        customFields: {},
        progression: { level: 1, xp: 0, className: 'Warden' },
        resources: { hp: { current: 20, max: 20 } },
        abilities: ['Track'],
        goals: ['Patrol the pass'],
        agenda: 'Guard the border',
        allegiance: 'hero',
        mood: 'steady',
        traits: ['vigilant'],
      },
      {
        id: 'vesper',
        name: 'Vesper',
        status: 'active',
        presentInScene: true,
        locationId: null,
        formId: null,
        formGroup: null,
        sections: { sec_personality: 'Dry-witted scout.' },
        customFields: {},
        abilities: ['Recon'],
        goals: ['Map the valley'],
        agenda: 'Report sightings',
        allegiance: 'neutral',
        mood: 'focused',
        traits: ['sharp-eyed'],
      },
    ],
  });
}

function makeTurnPatchBatch(turn: number, roll: number): PatchBatch {
  const ops: PatchBatch['operations'][number][] = [
    { op: 'increment', path: 'counters.reputation', delta: roll % 3 === 0 ? 2 : 1 },
    { op: 'increment', path: 'player.inventory.currency.gold', delta: roll },
    { op: 'set', path: 'flags.outpost_alert', value: roll >= 15 },
    {
      op: 'clock_advance',
      mechanicalTurns: 1,
      storySlots: turn % 2 === 0 ? 1 : 0,
    },
  ];
  if (turn % 5 === 0) {
    ops.push({
      op: 'chronicle_append',
      entry: {
        title: `Milestone Turn ${turn}`,
        category: 'event',
        summary: `Scouted sector ${turn} with roll ${roll}.`,
        locationId: null,
        involvedEntityIds: ['rowan', 'vesper'],
        keywords: [`turn-${turn}`],
      },
    });
  }
  return {
    eventId: `evt-turn-${String(turn).padStart(2, '0')}`,
    source: 'engine',
    operations: ops,
    reason: `Turn ${turn} resolution`,
  };
}

describe('Persistence, Crash Recovery, Branching & 30-Turn Replay', () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rp-engine-persist-'));
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('runs 30 turns with periodic checkpoints (0, 25), atomic writes, and byte-identical replayFromEvents', async () => {
    const saveDir = path.join(tempRoot, 'session-main');
    const checkpointInterval = 25;
    let currentState = makeInitialSimulationState('session-main');
    const initialStateSnapshot = cloneWorldState(currentState);

    const initCp: StateCheckpoint = {
      checkpointId: 'cp-turn-0',
      turn: 0,
      worldState: initialStateSnapshot,
      beatLedger: {},
      rngState: initialStateSnapshot.meta.rngState,
      stateHash: computeStateHash(initialStateSnapshot),
    };
    let swipeTree = createSwipeTree(initCp);

    const initRes = await initSaveDirectory(
      saveDir,
      {
        sessionId: 'session-main',
        cartridgeId: 'cartridge-borderlands',
        systemPackId: 'tactical-rpg',
        checkpointInterval,
      },
      {
        worldState: initialStateSnapshot,
        beatLedger: {},
        swipeTree,
      }
    );
    expect(isOk(initRes)).toBe(true);

    let parentMsgId: string | null = null;
    let auditSeq = 1;
    let snapshotAt25: WorldState | undefined;

    for (let turn = 1; turn <= 30; turn += 1) {
      const rngBefore = currentState.meta.rngState;
      const draw = nextInt(rngBefore, 1, 20);
      const rngAfter = draw.nextState;

      const batch = makeTurnPatchBatch(turn, draw.value);
      const applied = applyPatchBatch(currentState, batch, { auditSeqStart: auditSeq });
      expect(isOk(applied)).toBe(true);
      if (!applied.ok) return;

      auditSeq += applied.value.auditEntries.length;
      const nextState = applied.value.nextState;
      nextState.meta.rngState = rngAfter;

      const postStateHash = computeStateHash(nextState);
      const eventRecord: EventLogRecord = {
        turn,
        batch,
        postStateHash,
        rngBefore,
        rngAfter,
      };

      const appendEvRes = await appendEventRecord(saveDir, eventRecord);
      expect(isOk(appendEvRes)).toBe(true);

      const appendAuditRes = await appendAuditRecords(saveDir, applied.value.auditEntries);
      expect(isOk(appendAuditRes)).toBe(true);

      if (turn % checkpointInterval === 0) {
        const cpRes = await saveCheckpointAtomic(saveDir, turn, nextState);
        expect(isOk(cpRes)).toBe(true);
        if (turn === 25) {
          snapshotAt25 = cloneWorldState(nextState);
        }
      }

      if (turn <= 5 || turn === 15 || turn === 25 || turn === 30) {
        const msgId = `msg-turn-${turn}`;
        const cp: StateCheckpoint = {
          checkpointId: `cp-${turn}`,
          turn,
          worldState: nextState,
          beatLedger: {},
          rngState: nextState.meta.rngState,
          stateHash: postStateHash,
        };
        const appendMsgRes = appendMessageTurn(swipeTree, {
          messageId: msgId,
          parentMessageId: parentMsgId,
          role: turn % 2 === 1 ? 'user' : 'assistant',
          content: `Turn ${turn} narrative content (roll=${draw.value})`,
          checkpoint: cp,
        });
        expect(isOk(appendMsgRes)).toBe(true);
        if (appendMsgRes.ok) {
          swipeTree = appendMsgRes.value;
          parentMsgId = msgId;
        }
      }

      currentState = nextState;
    }

    const saveTreeRes = await saveSwipeTreeAtomic(saveDir, swipeTree);
    expect(isOk(saveTreeRes)).toBe(true);

    // Verify periodic checkpoint files and zero leftover .tmp files
    const checkpointEntries = await fs.readdir(path.join(saveDir, 'checkpoints'));
    expect(checkpointEntries.sort()).toEqual([
      formatCheckpointFilename(0),
      formatCheckpointFilename(25),
    ]);

    // Write a stale .tmp file in checkpoints to confirm loadSessionSave ignores incomplete atomic writes
    await fs.writeFile(
      path.join(saveDir, 'checkpoints', 'turn-00030.snapshot.json.tmp'),
      '{"corrupted_half_written":',
      'utf8'
    );

    const loadedRes = await loadSessionSave(saveDir);
    expect(isOk(loadedRes)).toBe(true);
    if (!loadedRes.ok) return;

    const loaded = loadedRes.value;
    expect(loaded.manifest.sessionId).toBe('session-main');
    expect(loaded.manifest.currentTurn).toBe(30);
    expect(loaded.manifest.checkpointInterval).toBe(25);
    expect(loaded.checkpoints.map((c) => c.turn)).toEqual([0, 25]);
    expect(loaded.latestCheckpoint?.turn).toBe(25);
    expect(loaded.events).toHaveLength(30);
    expect(loaded.auditEntries.length).toBeGreaterThanOrEqual(90);
    expect(loaded.recoveredPartialLines).toEqual({ events: false, audit: false });
    expect(loaded.swipeTree?.activeLeafMessageId).toBe('msg-turn-30');

    const transcriptRaw = await fs.readFile(path.join(saveDir, 'transcript.json'), 'utf8');
    const parsedTranscript = JSON.parse(transcriptRaw) as {
      activeLeafMessageId: string;
      messages: Array<{ messageId: string }>;
    };
    expect(parsedTranscript.activeLeafMessageId).toBe('msg-turn-30');
    expect(parsedTranscript.messages).toEqual(getLinearTranscript(swipeTree));

    // Full 30-turn replay from turn 0 snapshot must be byte-identical to live final WorldState
    const fullReplayRes = replayFromEvents(loaded.checkpoints[0]!.worldState, loaded.events);
    expect(isOk(fullReplayRes)).toBe(true);
    if (!fullReplayRes.ok) return;

    expect(fullReplayRes.value.verifiedHashes).toBe(true);
    expect(fullReplayRes.value.replayedCount).toBe(30);
    expect(JSON.stringify(fullReplayRes.value.finalState)).toBe(JSON.stringify(currentState));

    // Partial replay from checkpoint 25 + events 26..30 must also be byte-identical
    expect(snapshotAt25).toBeDefined();
    const tailEvents = loaded.events.filter((e) => e.turn > 25);
    const tailReplayRes = replayFromEvents(loaded.checkpoints[1]!.worldState, tailEvents);
    expect(isOk(tailReplayRes)).toBe(true);
    if (tailReplayRes.ok) {
      expect(tailReplayRes.value.replayedCount).toBe(5);
      expect(JSON.stringify(tailReplayRes.value.finalState)).toBe(JSON.stringify(currentState));
    }

    // branchSave at turn 15 (no periodic checkpoint at 15 in source, so must replay & materialize turn 15)
    const branchDir = path.join(tempRoot, 'session-branch-15');
    const branchRes = await branchSave(saveDir, 15, branchDir, 'session-branch-15');
    expect(isOk(branchRes)).toBe(true);
    if (!branchRes.ok) return;

    expect(branchRes.value.sessionId).toBe('session-branch-15');
    expect(branchRes.value.parentSaveId).toBe('session-main');
    expect(branchRes.value.branchAtTurn).toBe(15);
    expect(branchRes.value.currentTurn).toBe(15);

    const loadedBranchRes = await loadSessionSave(branchDir);
    expect(isOk(loadedBranchRes)).toBe(true);
    if (!loadedBranchRes.ok) return;

    const branchSaveData = loadedBranchRes.value;
    expect(branchSaveData.checkpoints.map((c) => c.turn)).toEqual([0, 15]);
    expect(branchSaveData.events).toHaveLength(15);
    expect(branchSaveData.events.every((e) => e.turn <= 15)).toBe(true);
    expect(branchSaveData.auditEntries.every((a) => a.turn <= 15)).toBe(true);
    expect(branchSaveData.swipeTree?.activeLeafMessageId).toBe('msg-turn-15');

    const target15Replay = replayFromEvents(loaded.checkpoints[0]!.worldState, loaded.events, {
      targetTurn: 15,
    });
    expect(isOk(target15Replay)).toBe(true);
    if (target15Replay.ok) {
      expect(target15Replay.value.replayedCount).toBe(15);
      expect(JSON.stringify(branchSaveData.latestCheckpoint?.worldState)).toBe(
        JSON.stringify(target15Replay.value.finalState)
      );
    }

    // Out-of-range branch turn fails cleanly
    expect(isErr(await branchSave(saveDir, 50, path.join(tempRoot, 'bad-branch'), 'bad'))).toBe(
      true
    );
    expect(isErr(await branchSave(saveDir, -1, path.join(tempRoot, 'bad-branch2'), 'bad'))).toBe(
      true
    );
  });

  it('recovers cleanly from crash-truncated trailing JSONL lines and rejects mid-file corruption', async () => {
    const saveDir = path.join(tempRoot, 'crash-recovery');
    const ws0 = makeInitialSimulationState('crash-recovery');
    await initSaveDirectory(
      saveDir,
      {
        sessionId: 'crash-recovery',
        cartridgeId: 'c1',
        systemPackId: 'p1',
      },
      { worldState: ws0 }
    );

    const rng1 = nextInt(ws0.meta.rngState, 1, 10);
    const batch1 = makeTurnPatchBatch(1, rng1.value);
    const res1 = applyPatchBatch(ws0, batch1);
    expect(isOk(res1)).toBe(true);
    if (!res1.ok) return;
    res1.value.nextState.meta.rngState = rng1.nextState;

    await appendEventRecord(saveDir, {
      turn: 1,
      batch: batch1,
      postStateHash: computeStateHash(res1.value.nextState),
      rngBefore: ws0.meta.rngState,
      rngAfter: rng1.nextState,
    });
    await appendAuditRecords(saveDir, res1.value.auditEntries);

    const rng2 = nextInt(rng1.nextState, 1, 10);
    const batch2 = makeTurnPatchBatch(2, rng2.value);
    const res2 = applyPatchBatch(res1.value.nextState, batch2);
    expect(isOk(res2)).toBe(true);
    if (!res2.ok) return;
    res2.value.nextState.meta.rngState = rng2.nextState;

    await appendEventRecord(saveDir, {
      turn: 2,
      batch: batch2,
      postStateHash: computeStateHash(res2.value.nextState),
      rngBefore: rng1.nextState,
      rngAfter: rng2.nextState,
    });
    await appendAuditRecords(saveDir, res2.value.auditEntries);

    // Simulate power-loss mid-write on turn 3 (partial JSON line without trailing newline)
    await fs.appendFile(
      path.join(saveDir, 'events.jsonl'),
      '{"turn":3,"batch":{"eventId":"evt-turn-03"',
      'utf8'
    );
    await fs.appendFile(path.join(saveDir, 'audit.jsonl'), '{"turn":3,"storyTurn":3,"op":', 'utf8');

    const recoveredRes = await loadSessionSave(saveDir);
    expect(isOk(recoveredRes)).toBe(true);
    if (!recoveredRes.ok) return;

    expect(recoveredRes.value.events).toHaveLength(2);
    expect(recoveredRes.value.recoveredPartialLines).toEqual({ events: true, audit: true });

    // Resuming appends after crash cleanly truncates partial tail before writing turn 3
    const rng3 = nextInt(rng2.nextState, 1, 10);
    const batch3 = makeTurnPatchBatch(3, rng3.value);
    const res3 = applyPatchBatch(res2.value.nextState, batch3);
    expect(isOk(res3)).toBe(true);
    if (!res3.ok) return;
    res3.value.nextState.meta.rngState = rng3.nextState;

    await appendEventRecord(saveDir, {
      turn: 3,
      batch: batch3,
      postStateHash: computeStateHash(res3.value.nextState),
      rngBefore: rng2.nextState,
      rngAfter: rng3.nextState,
    });
    const extraAudit: AuditEntry = {
      turn: 3,
      storyTurn: 3,
      timestampSeq: 99,
      source: 'engine',
      eventId: 'evt-turn-03',
      op: 'set',
      path: 'flags.outpost_alert',
      oldValue: undefined,
      newValue: false,
      status: 'committed',
    };
    await appendAuditRecords(saveDir, [extraAudit]);

    const afterResumeRes = await loadSessionSave(saveDir);
    expect(isOk(afterResumeRes)).toBe(true);
    if (!afterResumeRes.ok) return;
    expect(afterResumeRes.value.events).toHaveLength(3);
    expect(afterResumeRes.value.recoveredPartialLines).toEqual({ events: false, audit: false });

    // Mid-file corruption (non-trailing line) must fail loudly instead of silently skipping
    const midCorruptDir = path.join(tempRoot, 'mid-corrupt');
    await initSaveDirectory(midCorruptDir, {
      sessionId: 'mid-corrupt',
      cartridgeId: 'c1',
      systemPackId: 'p1',
    });
    await fs.writeFile(
      path.join(midCorruptDir, 'events.jsonl'),
      '{"corrupted_mid_line":\n' +
        JSON.stringify({
          turn: 1,
          batch: batch1,
          postStateHash: computeStateHash(res1.value.nextState),
          rngBefore: ws0.meta.rngState,
          rngAfter: rng1.nextState,
        }) +
        '\n',
      'utf8'
    );
    const midCorruptLoad = await loadSessionSave(midCorruptDir);
    expect(isErr(midCorruptLoad)).toBe(true);
  });

  it('rejects tampered postStateHash or tampered rngBefore during replayFromEvents', () => {
    const ws0 = makeInitialSimulationState('tamper-check');
    const rngBefore = ws0.meta.rngState;
    const draw = nextInt(rngBefore, 1, 20);
    const batch = makeTurnPatchBatch(1, draw.value);
    const applied = applyPatchBatch(ws0, batch);
    expect(isOk(applied)).toBe(true);
    if (!applied.ok) return;

    applied.value.nextState.meta.rngState = draw.nextState;
    const validHash = computeStateHash(applied.value.nextState);

    const tamperedHash = replayFromEvents(ws0, [
      {
        turn: 1,
        batch,
        postStateHash: '0000000000000000',
        rngBefore,
        rngAfter: draw.nextState,
      },
    ]);
    expect(isErr(tamperedHash)).toBe(true);
    if (!tamperedHash.ok) {
      expect(tamperedHash.error[0]?.code).toBe('STATE_HASH_MISMATCH');
    }

    const wrongRngBefore = nextInt(draw.nextState, 1, 20).nextState;
    const tamperedRng = replayFromEvents(ws0, [
      {
        turn: 1,
        batch,
        postStateHash: validHash,
        rngBefore: wrongRngBefore,
        rngAfter: draw.nextState,
      },
    ]);
    expect(isErr(tamperedRng)).toBe(true);
    if (!tamperedRng.ok) {
      expect(tamperedRng.error[0]?.code).toBe('RNG_CHAIN_MISMATCH');
    }
  });

  it('migrates legacy v1 checkpoint snapshots automatically on loadSessionSave', async () => {
    const legacyDir = path.join(tempRoot, 'legacy-v1-save');
    await initSaveDirectory(legacyDir, {
      sessionId: 'legacy-v1-save',
      cartridgeId: 'c-legacy',
      systemPackId: 'freeform',
      schemaVersion: 1,
      currentTurn: 2,
    });

    const v1SnapshotPayload = {
      turn: 2,
      beatLedger: {},
      stateHash: 'legacy-hash-v1',
      worldState: {
        schemaVersion: 1,
        sessionId: 'legacy-v1-save',
        turn: 2,
        flags: { door_unlocked: true },
        counters: { coins: 12 },
        custom_fields: { mood: 'hopeful' },
        characters: [{ id: 'npc_1', name: 'Mara' }],
      },
    };
    await fs.writeFile(
      path.join(legacyDir, 'checkpoints', formatCheckpointFilename(2)),
      JSON.stringify(v1SnapshotPayload, null, 2),
      'utf8'
    );

    const loaded = await loadSessionSave(legacyDir);
    expect(isOk(loaded)).toBe(true);
    if (!loaded.ok) return;

    expect(loaded.value.latestCheckpoint?.turn).toBe(2);
    expect(loaded.value.latestCheckpoint?.worldState.schemaVersion).toBe(2);
    expect(loaded.value.latestCheckpoint?.worldState.flags['door_unlocked']).toBe(true);
    expect(loaded.value.latestCheckpoint?.worldState.entities.characters['npc_1']?.name).toBe(
      'Mara'
    );
    expect(loaded.value.latestCheckpoint?.combatState).toBeUndefined();
    expect(loaded.value.userControlRoomLayer).toBeNull();
    expect(loaded.value.activePersona).toBeNull();
  });

  it('persists and reloads userControlRoomLayer (generation & custom GameSystemModule), activePersona, and checkpoint combatState', async () => {
    const saveDir = path.join(tempRoot, 'extended-session');
    const ws0 = makeInitialSimulationState('extended-session');

    const customModule: GameSystemModule = {
      id: 'sanity_meter',
      name: 'Sanity Meter',
      description: 'Tracks eldritch dread.',
      enabled: true,
      scope: 'session',
      target: 'player',
      effectOwner: 'tracker',
      cadence: 'every_turn',
      fields: {
        sanity: {
          type: 'meter',
          min: 0,
          max: 100,
          default: 85,
          writableByTracker: true,
          confirmPolicy: 'auto',
        },
      },
      trackerInstruction: 'Adjust sanity when encountering eldritch phenomena.',
      narratorRule: 'Reflect low sanity in sensory descriptions.',
      ui: { widget: 'bar', order: 1 },
    };

    const userLayer: ControlRoomLayer = {
      capabilities: {
        combatMode: 'tactical_grid',
        beats: true,
      },
      gameSystems: [customModule],
      tuningDials: {
        beatPressure: 'harsh',
        narrativePacing: 'slow_burn',
        cyoaEnabled: true,
      },
      generation: {
        presetName: 'Gritty Noir',
        sourceFormat: 'st_chat_completion',
        temperature: 0.72,
        topP: 0.92,
        topK: 40,
        minP: 0.05,
        repetitionPenalty: 1.12,
        stopSequences: ['\nUser:', '<|im_end|>'],
        stFormatTemplates: {
          scenarioFormat: '[Scenario: {{scenario}}]',
        },
      },
    };

    const activePersona: UserPersonaPreset = {
      id: 'persona-kestrel',
      name: 'Kestrel',
      description: 'Ex-cartographer carrying a brass astrolabe.',
      characterId: 'rowan',
      sections: {
        sec_appearance: 'Ink-stained gloves and a hooded oilcloth coat.',
      },
      customFields: {
        reputation_guild: 3,
      },
      resources: {
        hp: { current: 18, max: 20 },
      },
      progression: {
        level: 3,
        xp: 450,
        className: 'Surveyor',
      },
    };

    const initialCombatState: Record<string, unknown> = {
      active: true,
      round: 2,
      turnOrder: ['rowan', 'vesper'],
      activeActorId: 'rowan',
      grid: { width: 8, height: 8 },
    };

    const initRes = await initSaveDirectory(
      saveDir,
      {
        sessionId: 'extended-session',
        cartridgeId: 'cart-noir',
        systemPackId: 'tactical-rpg',
      },
      {
        worldState: ws0,
        combatState: initialCombatState,
        userControlRoomLayer: userLayer,
        activePersona,
      }
    );
    expect(isOk(initRes)).toBe(true);

    // Save a subsequent checkpoint with updated combatState and verify atomic overwrite
    const nextCombatState: Record<string, unknown> = {
      active: false,
      round: 4,
      winnerTeam: 'player',
    };
    const cp1Res = await saveCheckpointAtomic(saveDir, 1, ws0, { beat1: true }, nextCombatState);
    expect(isOk(cp1Res)).toBe(true);
    if (cp1Res.ok) {
      expect(cp1Res.value.snapshot.combatState).toEqual(nextCombatState);
      expect(cp1Res.value.snapshot.stateHash).toBe(
        computeStateHash(ws0, { beat1: true }, nextCombatState)
      );
    }

    const loadedRes = await loadSessionSave(saveDir);
    expect(isOk(loadedRes)).toBe(true);
    if (!loadedRes.ok) return;

    expect(loadedRes.value.userControlRoomLayer).toEqual(userLayer);
    expect(loadedRes.value.activePersona).toEqual(activePersona);
    expect(loadedRes.value.checkpoints[0]?.combatState).toEqual(initialCombatState);
    expect(loadedRes.value.latestCheckpoint?.turn).toBe(1);
    expect(loadedRes.value.latestCheckpoint?.combatState).toEqual(nextCombatState);

    // Clear activePersona cleanly via saveActivePersonaAtomic(dir, null) and verify reload
    const clearRes = await saveActivePersonaAtomic(saveDir, null);
    expect(isOk(clearRes)).toBe(true);

    const updatedLayer: ControlRoomLayer = {
      ...userLayer,
      generation: {
        ...userLayer.generation,
        temperature: 0.55,
      },
    };
    const updateLayerRes = await saveControlRoomLayerAtomic(saveDir, updatedLayer);
    expect(isOk(updateLayerRes)).toBe(true);

    const dirFiles = await fs.readdir(saveDir);
    expect(dirFiles.some((f) => f.endsWith('.tmp'))).toBe(false);

    const reloadedRes = await loadSessionSave(saveDir);
    expect(isOk(reloadedRes)).toBe(true);
    if (!reloadedRes.ok) return;
    expect(reloadedRes.value.activePersona).toBeNull();
    expect(reloadedRes.value.userControlRoomLayer?.generation?.temperature).toBe(0.55);
  });

  it('preserves control-room.json, persona.json, and checkpoint combatState across branchSave', async () => {
    const sourceDir = path.join(tempRoot, 'branch-source');
    const targetDir = path.join(tempRoot, 'branch-target');
    const ws0 = makeInitialSimulationState('branch-source');

    const userLayer: ControlRoomLayer = {
      generation: {
        presetName: 'Branch Preset',
        temperature: 0.65,
      },
      basePrompts: {
        system: 'Custom branch system prompt',
      },
      unlockedPromptSections: {
        system: true,
      },
    };
    const persona: UserPersonaPreset = {
      id: 'persona-branch',
      name: 'Lyra',
      description: 'Alchemist',
    };
    const combat0: Record<string, unknown> = {
      active: true,
      round: 1,
      combatants: { rowan: { hp: 20 } },
    };

    const initRes = await initSaveDirectory(
      sourceDir,
      {
        sessionId: 'branch-source',
        cartridgeId: 'c1',
        systemPackId: 'p1',
      },
      {
        worldState: ws0,
        combatState: combat0,
        userControlRoomLayer: userLayer,
        activePersona: persona,
      }
    );
    expect(isOk(initRes)).toBe(true);

    const rng1 = nextInt(ws0.meta.rngState, 1, 20);
    const batch1 = makeTurnPatchBatch(1, rng1.value);
    const applied1 = applyPatchBatch(ws0, batch1);
    expect(isOk(applied1)).toBe(true);
    if (!applied1.ok) return;
    applied1.value.nextState.meta.rngState = rng1.nextState;

    await appendEventRecord(sourceDir, {
      turn: 1,
      batch: batch1,
      postStateHash: computeStateHash(applied1.value.nextState),
      rngBefore: ws0.meta.rngState,
      rngAfter: rng1.nextState,
    });
    await appendAuditRecords(sourceDir, applied1.value.auditEntries);

    const branchRes = await branchSave(sourceDir, 1, targetDir, 'branch-target');
    expect(isOk(branchRes)).toBe(true);

    const loadedBranch = await loadSessionSave(targetDir);
    expect(isOk(loadedBranch)).toBe(true);
    if (!loadedBranch.ok) return;

    expect(loadedBranch.value.userControlRoomLayer).toEqual(userLayer);
    expect(loadedBranch.value.activePersona).toEqual(persona);
    expect(loadedBranch.value.checkpoints[0]?.combatState).toEqual(combat0);
    expect(loadedBranch.value.latestCheckpoint?.turn).toBe(1);
    expect(loadedBranch.value.latestCheckpoint?.combatState).toEqual(combat0);
  });

  it('loads legacy save directories without control-room.json, persona.json, or combatState cleanly', async () => {
    const legacyDir = path.join(tempRoot, 'legacy-no-extensions');
    const ws0 = makeInitialSimulationState('legacy-no-extensions');

    await initSaveDirectory(
      legacyDir,
      {
        sessionId: 'legacy-no-extensions',
        cartridgeId: 'c-old',
        systemPackId: 'freeform',
      },
      {
        worldState: ws0,
      }
    );

    // Ensure control-room.json and persona.json do not exist
    await expect(fs.access(path.join(legacyDir, 'control-room.json'))).rejects.toThrow();
    await expect(fs.access(path.join(legacyDir, 'persona.json'))).rejects.toThrow();

    const loaded = await loadSessionSave(legacyDir);
    expect(isOk(loaded)).toBe(true);
    if (!loaded.ok) return;

    expect(loaded.value.userControlRoomLayer).toBeNull();
    expect(loaded.value.activePersona).toBeNull();
    expect(loaded.value.latestCheckpoint?.combatState).toBeUndefined();

    // Branching a legacy save should not fail or invent control-room.json / persona.json
    const branchedLegacyDir = path.join(tempRoot, 'legacy-branched');
    const branchRes = await branchSave(legacyDir, 0, branchedLegacyDir, 'legacy-branched');
    expect(isOk(branchRes)).toBe(true);
    await expect(fs.access(path.join(branchedLegacyDir, 'control-room.json'))).rejects.toThrow();
    await expect(fs.access(path.join(branchedLegacyDir, 'persona.json'))).rejects.toThrow();
  });

  it('rejects unsafe prototype-polluting keys (__proto__) and corrupt control-room.json / persona.json', async () => {
    const saveDir = path.join(tempRoot, 'unsafe-keys');
    const ws0 = makeInitialSimulationState('unsafe-keys');

    await initSaveDirectory(
      saveDir,
      {
        sessionId: 'unsafe-keys',
        cartridgeId: 'c1',
        systemPackId: 'p1',
      },
      { worldState: ws0 }
    );

    // In-memory rejection for __proto__ via defineProperty
    const pollutedLayer: Record<string, unknown> = {
      generation: { temperature: 0.7 },
    };
    Object.defineProperty(pollutedLayer, '__proto__', {
      value: { polluted: true },
      enumerable: true,
      configurable: true,
    });
    const saveLayerErr = await saveControlRoomLayerAtomic(
      saveDir,
      pollutedLayer as unknown as ControlRoomLayer
    );
    expect(isErr(saveLayerErr)).toBe(true);
    if (!saveLayerErr.ok) {
      expect(saveLayerErr.error[0]?.code).toBe('UNSAFE_KEY');
    }

    const pollutedPersona: Record<string, unknown> = {
      id: 'p1',
      name: 'Hero',
      description: 'Test',
    };
    Object.defineProperty(pollutedPersona, '__proto__', {
      value: { admin: true },
      enumerable: true,
      configurable: true,
    });
    const savePersonaErr = await saveActivePersonaAtomic(
      saveDir,
      pollutedPersona as unknown as UserPersonaPreset
    );
    expect(isErr(savePersonaErr)).toBe(true);
    if (!savePersonaErr.ok) {
      expect(savePersonaErr.error[0]?.code).toBe('UNSAFE_KEY');
    }

    // Disk rejection for __proto__ in control-room.json
    await fs.writeFile(
      path.join(saveDir, 'control-room.json'),
      '{"__proto__":{"polluted":true},"generation":{"temperature":0.8}}',
      'utf8'
    );
    const loadControlRoomErr = await loadSessionSave(saveDir);
    expect(isErr(loadControlRoomErr)).toBe(true);
    if (!loadControlRoomErr.ok) {
      expect(loadControlRoomErr.error[0]?.code).toBe('UNSAFE_KEY');
    }

    // Remove bad control-room.json, test __proto__ in persona.json
    await fs.rm(path.join(saveDir, 'control-room.json'));
    await fs.writeFile(
      path.join(saveDir, 'persona.json'),
      '{"id":"p1","name":"Hero","description":"Desc","__proto__":{"polluted":true}}',
      'utf8'
    );
    const loadPersonaErr = await loadSessionSave(saveDir);
    expect(isErr(loadPersonaErr)).toBe(true);
    if (!loadPersonaErr.ok) {
      expect(loadPersonaErr.error[0]?.code).toBe('UNSAFE_KEY');
    }

    // Corrupt JSON in persona.json returns structured INVALID_JSON error
    await fs.writeFile(path.join(saveDir, 'persona.json'), '{"id":', 'utf8');
    const corruptPersonaErr = await loadSessionSave(saveDir);
    expect(isErr(corruptPersonaErr)).toBe(true);
    if (!corruptPersonaErr.ok) {
      expect(corruptPersonaErr.error[0]?.code).toBe('INVALID_JSON');
    }
  });
});
