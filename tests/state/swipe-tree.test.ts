import { describe, expect, it } from 'vitest';
import { RefereeError } from '../../src/core/errors.js';
import { createSeededRng, nextInt } from '../../src/core/prng.js';
import { isErr, isOk } from '../../src/core/result.js';
import { STOCK_SLICE_OF_LIFE_PACK } from '../../src/schema/stock-system-packs.js';
import { migrateWorldStateDocument } from '../../src/state/migrations.js';
import { type PatchBatch } from '../../src/state/patch.js';
import { applyPatchBatch } from '../../src/state/reducer.js';
import {
  type StateCheckpoint,
  activateSwipeVariant,
  appendMessageTurn,
  computeStateHash,
  createSwipeTree,
  getLinearTranscript,
  recordSwipeVariant,
  rollbackForSwipe,
  validateSwipeTreeState,
} from '../../src/state/swipe-tree.js';
import {
  WORLD_STATE_SCHEMA_VERSION,
  type WorldState,
  createWorldState,
  validateWorldState,
} from '../../src/state/world-state.js';

function makeCheckpoint(
  checkpointId: string,
  worldState: WorldState,
  beatLedger: Record<string, unknown> = {}
): StateCheckpoint {
  return {
    checkpointId,
    turn: worldState.meta.turn,
    worldState,
    beatLedger,
    rngState: worldState.meta.rngState,
    stateHash: computeStateHash(worldState, beatLedger),
  };
}

function makeBaseWorldState(): WorldState {
  return createWorldState({
    sessionId: 'swipe-test-session',
    capabilities: STOCK_SLICE_OF_LIFE_PACK.capabilities,
    rngSeed: 'swipe-seed-1',
    counters: { trust: 0 },
    flags: { met_alice: true },
    characters: [
      {
        id: 'alice',
        name: 'Alice',
        status: 'active',
        presentInScene: true,
        locationId: null,
        formId: null,
        formGroup: null,
        sections: { sec_personality: 'Curious and cautious.' },
        customFields: {},
        abilities: [],
        goals: [],
        agenda: 'Observe',
        allegiance: 'neutral',
        mood: 'curious',
        traits: ['observant'],
      },
    ],
  });
}

describe('computeStateHash', () => {
  it('is deterministic across object key order, -0/+0, and omitted vs default beatLedger', () => {
    const wsA = makeBaseWorldState();
    const wsB = makeBaseWorldState();

    expect(computeStateHash(wsA)).toBe(computeStateHash(wsB));
    expect(computeStateHash(wsA)).toBe(computeStateHash(wsA, {}));

    const ledger1 = { b: 2, a: { z: 0, y: 'ok' }, ignored: undefined };
    const ledger2 = { a: { y: 'ok', z: -0 }, b: 2 };
    expect(computeStateHash(wsA, ledger1)).toBe(computeStateHash(wsB, ledger2));

    const mutated = createWorldState({
      sessionId: 'swipe-test-session',
      capabilities: STOCK_SLICE_OF_LIFE_PACK.capabilities,
      rngSeed: 'swipe-seed-1',
      counters: { trust: 1 },
    });
    expect(computeStateHash(mutated)).not.toBe(computeStateHash(wsA));
  });

  it('rejects circular references deterministically', () => {
    const ws = makeBaseWorldState();
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;

    expect(() => computeStateHash(ws, circular)).toThrow(RefereeError);
  });

  it('preserves legacy hashes when combatState is undefined or null and hashes non-null combatState deterministically', () => {
    const ws = makeBaseWorldState();
    const ledger = { beat_intro: 'open' };
    const legacyHash = computeStateHash(ws, ledger);

    expect(computeStateHash(ws, ledger, undefined)).toBe(legacyHash);
    expect(computeStateHash(ws, ledger, null)).toBe(legacyHash);

    const combatA = { active: true, round: 2, turnOrder: ['alice', 'goblin'], offset: 0 };
    const combatB = { offset: -0, turnOrder: ['alice', 'goblin'], round: 2, active: true };
    const combatHashA = computeStateHash(ws, ledger, combatA);
    const combatHashB = computeStateHash(ws, ledger, combatB);

    expect(combatHashA).toBe(combatHashB);
    expect(combatHashA).not.toBe(legacyHash);

    const combatDifferent = { active: true, round: 3, turnOrder: ['alice', 'goblin'], offset: 0 };
    expect(computeStateHash(ws, ledger, combatDifferent)).not.toBe(combatHashA);
  });
});

describe('Swipe-Coupled Message Tree', () => {
  it('rolls back trust 0 -> 2 in Swipe A back to trust 0 before Swipe B, and restores trust 2 on switch back', () => {
    const initialWorld = makeBaseWorldState();
    const cp0 = makeCheckpoint('cp-0', initialWorld, { beat_intro: 'open' });
    let tree = createSwipeTree(cp0);

    // User turn 1 (trust remains 0)
    const u1Res = appendMessageTurn(tree, {
      messageId: 'msg-u1',
      parentMessageId: null,
      role: 'user',
      content: 'I offer Alice a warm lantern.',
      checkpoint: cp0,
    });
    expect(isOk(u1Res)).toBe(true);
    if (!u1Res.ok) return;
    tree = u1Res.value;

    // Assistant Swipe A: trust 0 -> 2, clock advances to turn 1
    const batchA: PatchBatch = {
      eventId: 'evt-swipe-a',
      source: 'engine',
      operations: [
        { op: 'increment', path: 'counters.trust', delta: 2 },
        { op: 'clock_advance', mechanicalTurns: 1 },
      ],
    };
    const appliedA = applyPatchBatch(initialWorld, batchA);
    expect(isOk(appliedA)).toBe(true);
    if (!appliedA.ok) return;
    expect(appliedA.value.nextState.counters['trust']).toBe(2);

    const cpSwipeA = makeCheckpoint('cp-a1-s0', appliedA.value.nextState, {
      beat_intro: 'warm_welcome',
    });
    const a1Res = appendMessageTurn(tree, {
      messageId: 'msg-a1',
      parentMessageId: 'msg-u1',
      role: 'assistant',
      content: 'Alice smiles and accepts the lantern gratefully.',
      checkpoint: cpSwipeA,
    });
    expect(isOk(a1Res)).toBe(true);
    if (!a1Res.ok) return;
    tree = a1Res.value;

    // Rollback before regenerating Swipe B: MUST restore pre-turn trust: 0 (never 2!)
    const rollbackRes = rollbackForSwipe(tree, 'msg-a1');
    expect(isOk(rollbackRes)).toBe(true);
    if (!rollbackRes.ok) return;

    expect(rollbackRes.value.parentMessageId).toBe('msg-u1');
    expect(rollbackRes.value.restoredCheckpoint.worldState.counters['trust']).toBe(0);
    expect(rollbackRes.value.restoredCheckpoint.worldState.meta.turn).toBe(0);
    expect(rollbackRes.value.restoredCheckpoint.beatLedger).toEqual({ beat_intro: 'open' });

    // Mutate restored checkpoint externally to verify tree isolation
    rollbackRes.value.restoredCheckpoint.worldState.counters['trust'] = 999;

    // Re-roll back cleanly to confirm internal state was never mutated
    const rollbackAgain = rollbackForSwipe(tree, 'msg-a1');
    expect(isOk(rollbackAgain)).toBe(true);
    if (!rollbackAgain.ok) return;
    expect(rollbackAgain.value.restoredCheckpoint.worldState.counters['trust']).toBe(0);

    // Apply Swipe B from restored pre-turn checkpoint (trust: 0 -> 1, RNG stepped)
    const steppedRng = nextInt(rollbackAgain.value.restoredCheckpoint.rngState, 1, 20);
    const batchB: PatchBatch = {
      eventId: 'evt-swipe-b',
      source: 'engine',
      operations: [
        { op: 'increment', path: 'counters.trust', delta: 1 },
        { op: 'clock_advance', mechanicalTurns: 1 },
      ],
    };
    const appliedB = applyPatchBatch(rollbackAgain.value.restoredCheckpoint.worldState, batchB);
    expect(isOk(appliedB)).toBe(true);
    if (!appliedB.ok) return;
    const stateB = {
      ...appliedB.value.nextState,
      meta: { ...appliedB.value.nextState.meta, rngState: steppedRng.nextState },
    };
    expect(stateB.counters['trust']).toBe(1);

    const cpSwipeB = makeCheckpoint('cp-a1-s1', stateB, { beat_intro: 'guarded' });
    const recordRes = recordSwipeVariant(tree, 'msg-a1', {
      content: 'Alice nods cautiously and keeps her distance.',
      checkpoint: cpSwipeB,
      createdAtSeq: 2,
    });
    expect(isOk(recordRes)).toBe(true);
    if (!recordRes.ok) return;

    expect(recordRes.value.newSwipeIndex).toBe(1);
    tree = recordRes.value.nextTree;
    expect(tree.nodes['msg-a1']?.activeSwipeIndex).toBe(1);
    expect(getLinearTranscript(tree)).toEqual([
      {
        messageId: 'msg-u1',
        role: 'user',
        content: 'I offer Alice a warm lantern.',
        swipeIndex: 0,
      },
      {
        messageId: 'msg-a1',
        role: 'assistant',
        content: 'Alice nods cautiously and keeps her distance.',
        swipeIndex: 1,
      },
    ]);

    // Switch back to Swipe A (index 0): MUST restore trust: 2 and Swipe A's beatLedger
    const switchBackRes = activateSwipeVariant(tree, 'msg-a1', 0);
    expect(isOk(switchBackRes)).toBe(true);
    if (!switchBackRes.ok) return;

    tree = switchBackRes.value.nextTree;
    expect(switchBackRes.value.restoredCheckpoint.worldState.counters['trust']).toBe(2);
    expect(switchBackRes.value.restoredCheckpoint.beatLedger).toEqual({
      beat_intro: 'warm_welcome',
    });
    expect(getLinearTranscript(tree)[1]).toEqual({
      messageId: 'msg-a1',
      role: 'assistant',
      content: 'Alice smiles and accepts the lantern gratefully.',
      swipeIndex: 0,
    });
  });

  it('supports root assistant swipe rollback via initial checkpoint and limits transcript history', () => {
    const ws0 = makeBaseWorldState();
    const cpInit = makeCheckpoint('cp-init', ws0);
    let tree = createSwipeTree(cpInit);

    const ws1Res = applyPatchBatch(ws0, {
      eventId: 'evt-greet',
      source: 'engine',
      operations: [{ op: 'set', path: 'flags.greeted', value: true }],
    });
    expect(isOk(ws1Res)).toBe(true);
    if (!ws1Res.ok) return;

    const cpGreeting = makeCheckpoint('cp-greet', ws1Res.value.nextState);
    const a0 = appendMessageTurn(tree, {
      messageId: 'msg-0',
      parentMessageId: null,
      role: 'assistant',
      content: 'Welcome to the tavern.',
      checkpoint: cpGreeting,
    });
    expect(isOk(a0)).toBe(true);
    if (!a0.ok) return;
    tree = a0.value;

    const rbRoot = rollbackForSwipe(tree, 'msg-0');
    expect(isOk(rbRoot)).toBe(true);
    if (rbRoot.ok) {
      expect(rbRoot.value.parentMessageId).toBeNull();
      expect(rbRoot.value.restoredCheckpoint.checkpointId).toBe('cp-init');
      expect(rbRoot.value.restoredCheckpoint.worldState.flags['greeted']).toBeUndefined();
    }

    const u1 = appendMessageTurn(tree, {
      messageId: 'msg-1',
      parentMessageId: 'msg-0',
      role: 'user',
      content: 'Hello!',
      checkpoint: cpGreeting,
    });
    expect(isOk(u1)).toBe(true);
    if (!u1.ok) return;
    tree = u1.value;

    const u2 = appendMessageTurn(tree, {
      messageId: 'msg-2',
      parentMessageId: 'msg-1',
      role: 'system',
      content: 'Rain begins to fall.',
      checkpoint: cpGreeting,
    });
    expect(isOk(u2)).toBe(true);
    if (!u2.ok) return;
    tree = u2.value;

    expect(getLinearTranscript(tree, 2).map((e) => e.messageId)).toEqual(['msg-1', 'msg-2']);
    expect(getLinearTranscript(tree, 0)).toEqual([]);

    const validated = validateSwipeTreeState(JSON.parse(JSON.stringify(tree)));
    expect(isOk(validated)).toBe(true);
  });

  it('rejects prototype-polluting keys, duplicate IDs, missing parents, and invalid swipe indices', () => {
    const ws = makeBaseWorldState();
    const cp = makeCheckpoint('cp-0', ws);
    const tree = createSwipeTree();

    const unsafeId = appendMessageTurn(tree, {
      messageId: '__proto__',
      parentMessageId: null,
      role: 'user',
      content: 'bad',
      checkpoint: cp,
    });
    expect(isErr(unsafeId)).toBe(true);

    const missingParent = appendMessageTurn(tree, {
      messageId: 'msg-1',
      parentMessageId: 'non-existent',
      role: 'user',
      content: 'hi',
      checkpoint: cp,
    });
    expect(isErr(missingParent)).toBe(true);

    const okTurn = appendMessageTurn(tree, {
      messageId: 'msg-1',
      parentMessageId: null,
      role: 'assistant',
      content: 'hi',
      checkpoint: cp,
    });
    expect(isOk(okTurn)).toBe(true);
    if (!okTurn.ok) return;

    // No unreferenced initial checkpoint when createSwipeTree() was called without initialCheckpoint
    expect(isErr(rollbackForSwipe(okTurn.value, 'msg-1'))).toBe(true);
    expect(isErr(rollbackForSwipe(okTurn.value, 'missing-node'))).toBe(true);
    expect(isErr(activateSwipeVariant(okTurn.value, 'msg-1', 1))).toBe(true);
    expect(isErr(activateSwipeVariant(okTurn.value, 'msg-1', -1))).toBe(true);
    expect(isErr(activateSwipeVariant(okTurn.value, 'constructor', 0))).toBe(true);

    // Duplicate message ID
    expect(
      isErr(
        appendMessageTurn(okTurn.value, {
          messageId: 'msg-1',
          parentMessageId: null,
          role: 'user',
          content: 'dup',
          checkpoint: cp,
        })
      )
    ).toBe(true);

    // Checkpoint ID conflict with different stateHash
    const alteredWs = createWorldState({
      sessionId: 'swipe-test-session',
      capabilities: STOCK_SLICE_OF_LIFE_PACK.capabilities,
      rngSeed: 'swipe-seed-1',
      counters: { trust: 99 },
    });
    const conflictingCp: StateCheckpoint = {
      ...cp,
      worldState: alteredWs,
      stateHash: computeStateHash(alteredWs),
    };
    expect(
      isErr(
        recordSwipeVariant(okTurn.value, 'msg-1', {
          content: 'conflict',
          checkpoint: conflictingCp,
          createdAtSeq: 2,
        })
      )
    ).toBe(true);
  });

  it('preserves, isolates, and validates combatState across checkpoints, rollbacks, and swipe switches', () => {
    const ws0 = makeBaseWorldState();
    const combatInitial = { active: false, round: 0, participants: [] as string[] };
    const cp0: StateCheckpoint = {
      checkpointId: 'cp-combat-0',
      turn: 0,
      worldState: ws0,
      beatLedger: {},
      rngState: ws0.meta.rngState,
      combatState: combatInitial,
      stateHash: computeStateHash(ws0, {}, combatInitial),
    };

    let tree = createSwipeTree(cp0);
    const u1 = appendMessageTurn(tree, {
      messageId: 'msg-u1',
      parentMessageId: null,
      role: 'user',
      content: 'Draw sword.',
      checkpoint: cp0,
    });
    expect(isOk(u1)).toBe(true);
    if (!u1.ok) return;
    tree = u1.value;

    // External mutation of input combatState must not affect stored checkpoint
    combatInitial.round = 99;
    expect(tree.checkpoints['cp-combat-0']?.combatState).toEqual({
      active: false,
      round: 0,
      participants: [],
    });

    const combatSwipeA = { active: true, round: 1, participants: ['alice', 'bandit'] };
    const cpA: StateCheckpoint = {
      checkpointId: 'cp-combat-a',
      turn: 1,
      worldState: ws0,
      beatLedger: {},
      rngState: ws0.meta.rngState,
      combatState: combatSwipeA,
      stateHash: computeStateHash(ws0, {}, combatSwipeA),
    };
    const a1 = appendMessageTurn(tree, {
      messageId: 'msg-a1',
      parentMessageId: 'msg-u1',
      role: 'assistant',
      content: 'Combat begins!',
      checkpoint: cpA,
    });
    expect(isOk(a1)).toBe(true);
    if (!a1.ok) return;
    tree = a1.value;

    const rb = rollbackForSwipe(tree, 'msg-a1');
    expect(isOk(rb)).toBe(true);
    if (rb.ok) {
      expect(rb.value.restoredCheckpoint.combatState).toEqual({
        active: false,
        round: 0,
        participants: [],
      });
    }

    const cpB: StateCheckpoint = {
      checkpointId: 'cp-combat-b',
      turn: 1,
      worldState: ws0,
      beatLedger: {},
      rngState: ws0.meta.rngState,
      combatState: null,
      stateHash: computeStateHash(ws0, {}, null),
    };
    const swB = recordSwipeVariant(tree, 'msg-a1', {
      content: 'You negotiate instead.',
      checkpoint: cpB,
      createdAtSeq: 2,
    });
    expect(isOk(swB)).toBe(true);
    if (!swB.ok) return;
    tree = swB.value.nextTree;

    const backToA = activateSwipeVariant(tree, 'msg-a1', 0);
    expect(isOk(backToA)).toBe(true);
    if (backToA.ok) {
      expect(backToA.value.restoredCheckpoint.combatState).toEqual(combatSwipeA);
    }

    const validated = validateSwipeTreeState(JSON.parse(JSON.stringify(tree)));
    expect(isOk(validated)).toBe(true);
    if (validated.ok) {
      expect(validated.value.checkpoints['cp-combat-a']?.combatState).toEqual(combatSwipeA);
      expect(validated.value.checkpoints['cp-combat-b']?.combatState).toBeNull();
    }

    // Rejects prototype pollution or non-JSON-safe values inside combatState
    const pollutedCombat = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
    const badProtoCp: StateCheckpoint = {
      ...cp0,
      checkpointId: 'cp-bad-proto',
      combatState: pollutedCombat,
    };
    expect(
      isErr(
        appendMessageTurn(tree, {
          messageId: 'msg-bad-proto',
          parentMessageId: 'msg-u1',
          role: 'user',
          content: 'bad',
          checkpoint: badProtoCp,
        })
      )
    ).toBe(true);

    const badNanCp: StateCheckpoint = {
      ...cp0,
      checkpointId: 'cp-bad-nan',
      combatState: { round: Number.NaN },
    };
    expect(
      isErr(
        appendMessageTurn(tree, {
          messageId: 'msg-bad-nan',
          parentMessageId: 'msg-u1',
          role: 'user',
          content: 'bad',
          checkpoint: badNanCp,
        })
      )
    ).toBe(true);
  });
});

describe('migrateWorldStateDocument', () => {
  it('migrates legacy v1 shapes into validated v2 WorldState without mutating input', () => {
    const legacyV1 = {
      schemaVersion: 1,
      sessionId: 'v1-legacy-run',
      turn: 7,
      rngState: createSeededRng('v1-seed'),
      playerName: 'Kael',
      player: {
        name: 'Kael',
        inventory: ['potion', 'key', 'potion'],
        progression: { level: 3, xp: 250, class: 'Ranger' },
        resources: { hp: 30 },
        custom_fields: { origin: 'borderlands' },
      },
      scene: {
        location: 'Old Watchtower',
        presentCharacters: ['lyra'],
      },
      worldClock: {
        turn: 7,
        day: 2,
        date: '2026-03-10',
        slot: 'evening',
      },
      flags: { gate_open: true },
      counters: { renown: 4 },
      custom_fields: { weather: 'fog' },
      relations: {
        player: {
          lyra: 35,
        },
      },
      characters: [
        {
          id: 'lyra',
          name: 'Lyra',
          presentInScene: true,
          custom_fields: { moodNote: 'alert' },
          resources: { hp: 22 },
          progression: { level: 2, xp: 100, class: 'Scout' },
        },
      ],
      chronicle: [
        {
          id: 'ev-1',
          turn: 3,
          day: 1,
          date: '2026-03-09',
          title: 'Arrived at Watchtower',
          category: 'event',
          summary: 'Reached the perimeter.',
          locationId: null,
          involvedEntityIds: ['lyra'],
          keywords: ['arrival'],
        },
      ],
    };
    const beforeSnapshot = JSON.stringify(legacyV1);

    const migrated = migrateWorldStateDocument(legacyV1);
    expect(isOk(migrated)).toBe(true);
    if (!migrated.ok) return;

    expect(migrated.value.migratedFromVersion).toBe(1);
    const ws = migrated.value.worldState;
    expect(ws.schemaVersion).toBe(WORLD_STATE_SCHEMA_VERSION);
    expect(ws.meta.sessionId).toBe('v1-legacy-run');
    expect(ws.meta.turn).toBe(7);
    expect(ws.player.name).toBe('Kael');
    expect(ws.player.inventory.items).toEqual({ potion: 2, key: 1 });
    expect(ws.player.progression?.className).toBe('Ranger');
    expect(ws.player.resources?.['hp']).toEqual({ current: 30, max: 30 });
    expect(ws.player.customFields).toEqual({ origin: 'borderlands' });
    expect(ws.customFields).toEqual({ weather: 'fog' });
    expect(ws.clocks.inGameDate).toBe('2026-03-10');
    expect(ws.clocks.slot).toBe('evening');
    expect(ws.relations['player']?.['lyra']?.affinity).toBe(35);
    expect(ws.entities.characters['lyra']?.customFields).toEqual({ moodNote: 'alert' });
    expect(ws.entities.characters['lyra']?.progression?.className).toBe('Scout');
    expect(ws.chronicle.events).toHaveLength(1);
    expect(isOk(validateWorldState(ws))).toBe(true);
    expect(JSON.stringify(legacyV1)).toBe(beforeSnapshot);
  });

  it('passes through valid v2 documents and rejects unsupported versions or unsafe keys', () => {
    const v2 = makeBaseWorldState();
    const resV2 = migrateWorldStateDocument(v2);
    expect(isOk(resV2)).toBe(true);
    if (resV2.ok) {
      expect(resV2.value.migratedFromVersion).toBe(2);
      expect(resV2.value.worldState).toEqual(v2);
    }

    expect(isErr(migrateWorldStateDocument(null))).toBe(true);
    expect(isErr(migrateWorldStateDocument({ schemaVersion: 0 }))).toBe(true);
    expect(isErr(migrateWorldStateDocument({ schemaVersion: 99 }))).toBe(true);

    const polluted = JSON.parse('{"schemaVersion":1,"flags":{"__proto__":true}}') as unknown;
    expect(isErr(migrateWorldStateDocument(polluted))).toBe(true);

    // Array character missing required id should fail validation rather than silently dropping
    expect(
      isErr(
        migrateWorldStateDocument({
          schemaVersion: 1,
          characters: [{ name: 'Nameless' }],
        })
      )
    ).toBe(true);
  });
});
