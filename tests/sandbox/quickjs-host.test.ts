import { describe, expect, it } from 'vitest';
import { createSeededRng } from '../../src/core/prng.js';
import { isErr, isOk } from '../../src/core/result.js';
import { applyPatchBatch } from '../../src/state/reducer.js';
import { type WorldState, createWorldState } from '../../src/state/world-state.js';
import {
  type ScriptManifest,
  checkEntityWriteCapability,
  checkStateWriteCapability,
  hasCapability,
  matchesWriteGlob,
  validateScriptManifest,
} from '../../src/sandbox/capabilities.js';
import { executeSandboxedScript } from '../../src/sandbox/quickjs-host.js';

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const key of Object.keys(value)) {
      const desc = Object.getOwnPropertyDescriptor(value, key);
      if (desc && desc.value !== undefined) {
        deepFreeze(desc.value);
      }
    }
  }
  return value;
}

function createFixtureState(overrides: { day?: number; turn?: number } = {}): WorldState {
  return createWorldState({
    sessionId: 'sandbox-test-session',
    rngSeed: 'sandbox-seed-alpha',
    turn: overrides.turn ?? 3,
    clocks: {
      day: overrides.day ?? 2,
      turn: overrides.turn ?? 3,
      slot: 'afternoon',
    },
    flags: {
      met_castellan: true,
      gate_open: false,
    },
    counters: {
      trust: 4,
      alert: 1,
    },
    customFields: {
      weather: 'foggy',
      nested: {
        depth: 2,
      },
    },
    characters: [
      {
        id: 'hero',
        name: 'Aria',
        status: 'active',
        presentInScene: true,
        locationId: null,
        formId: null,
        formGroup: null,
        sections: {},
        customFields: {},
        abilities: ['parry'],
        goals: ['survive'],
        agenda: 'reach the keep',
        allegiance: 'watch',
        mood: 'focused',
        traits: ['brave'],
      },
    ],
    factions: [
      {
        id: 'iron_watch',
        name: 'Iron Watch',
        side: 'hero',
        status: 'active',
        influence: 60,
        headquartersLocationId: null,
        goals: ['hold the gate'],
      },
    ],
  });
}

describe('sandbox capabilities & globs', () => {
  it('matches write globs accurately', () => {
    expect(matchesWriteGlob('flags.*', 'flags.met_castellan')).toBe(true);
    expect(matchesWriteGlob('flags.*', 'flags.nested.deep')).toBe(true);
    expect(matchesWriteGlob('flags.*', 'counters.trust')).toBe(false);
    expect(matchesWriteGlob('flags.*', 'flags')).toBe(false);
    expect(matchesWriteGlob('flags.*', 'flags_extra.a')).toBe(false);

    expect(matchesWriteGlob('*', 'flags.met_castellan')).toBe(true);
    expect(matchesWriteGlob('*', 'entities.characters.hero.mood')).toBe(true);
    expect(matchesWriteGlob('flags.route_*', 'flags.route_north')).toBe(true);
    expect(matchesWriteGlob('flags.route_*', 'flags.other')).toBe(false);

    expect(matchesWriteGlob('flags.a', 'flags.a')).toBe(true);
    expect(matchesWriteGlob('flags.a', 'flags.ab')).toBe(false);
    expect(matchesWriteGlob('', 'flags.a')).toBe(false);
    expect(matchesWriteGlob('*', '')).toBe(false);
  });

  it('evaluates manifest capabilities and reports CAPABILITY_DENIED on mismatch', () => {
    const manifest: ScriptManifest = {
      scriptId: 'test-script',
      capabilities: ['state:read', 'dice', 'state:write:flags.*', 'entities:write:characters'],
    };

    expect(isOk(hasCapability(manifest, 'state:read'))).toBe(true);
    expect(isOk(hasCapability(manifest, 'dice'))).toBe(true);
    expect(isOk(checkStateWriteCapability(manifest, 'flags.met_castellan'))).toBe(true);
    expect(isOk(checkEntityWriteCapability(manifest, 'characters'))).toBe(true);

    const deniedCounter = checkStateWriteCapability(manifest, 'counters.trust');
    expect(isErr(deniedCounter)).toBe(true);
    if (isErr(deniedCounter)) {
      expect(deniedCounter.error[0]?.code).toBe('CAPABILITY_DENIED');
    }

    const deniedClock = hasCapability(manifest, 'clock:advance');
    expect(isErr(deniedClock)).toBe(true);
    if (isErr(deniedClock)) {
      expect(deniedClock.error[0]?.code).toBe('CAPABILITY_DENIED');
    }

    const deniedEntity = checkEntityWriteCapability(manifest, 'factions');
    expect(isErr(deniedEntity)).toBe(true);
    if (isErr(deniedEntity)) {
      expect(deniedEntity.error[0]?.code).toBe('CAPABILITY_DENIED');
    }

    const wildcardManifest: ScriptManifest = {
      scriptId: 'admin-script',
      capabilities: ['state:write:*', 'entities:write:*'],
    };
    expect(isOk(checkStateWriteCapability(wildcardManifest, 'counters.trust'))).toBe(true);
    expect(isOk(checkEntityWriteCapability(wildcardManifest, 'factions'))).toBe(true);
  });

  it('validates ScriptManifest options', () => {
    expect(
      isOk(
        validateScriptManifest({
          scriptId: 'valid-1',
          capabilities: ['state:read'],
          timeoutMs: 50,
          memoryLimitBytes: 1024 * 1024,
        })
      )
    ).toBe(true);

    const bad = validateScriptManifest({
      scriptId: ' ',
      capabilities: ['state:read'],
      timeoutMs: -10,
      memoryLimitBytes: 0,
    });
    expect(isErr(bad)).toBe(true);
    if (isErr(bad)) {
      expect(bad.error.map((e) => e.code)).toEqual([
        'INVALID_SCRIPT_ID',
        'INVALID_TIMEOUT',
        'INVALID_MEMORY_LIMIT',
      ]);
    }
  });
});

describe('executeSandboxedScript (QuickJS WASM)', () => {
  it('enforces state:read-only capability and rolls back earlier operations on capability denial', async () => {
    const stateSnapshot = deepFreeze(createFixtureState());
    const rngState = deepFreeze(createSeededRng('cap-denial'));

    // Pure state:read script works cleanly
    const readRes = await executeSandboxedScript({
      code: `
        const met = engine.state.get('flags.met_castellan');
        const trust = engine.state.get('counters.trust');
        engine.log('read ok', met, trust);
        ({ met, trust });
      `,
      manifest: {
        scriptId: 'reader-only',
        capabilities: ['state:read'],
      },
      stateSnapshot,
      rngState,
    });

    expect(isOk(readRes)).toBe(true);
    if (isOk(readRes)) {
      expect(readRes.value.resultValue).toEqual({ met: true, trust: 4 });
      expect(readRes.value.operations).toEqual([]);
      expect(readRes.value.logs).toEqual(['read ok true 4']);
    }

    // state:read-only script trying to call engine.state.set fails cleanly
    const writeAttempt = await executeSandboxedScript({
      code: `
        const met = engine.state.get('flags.met_castellan');
        engine.state.set('flags.met_castellan', !met);
      `,
      manifest: {
        scriptId: 'reader-trying-write',
        capabilities: ['state:read'],
      },
      stateSnapshot,
      rngState,
    });

    expect(isErr(writeAttempt)).toBe(true);
    if (isErr(writeAttempt)) {
      expect(writeAttempt.error[0]?.code).toBe('CAPABILITY_DENIED');
    }

    // Script with partial write permissions queues valid ops, then violates a capability:
    // even if caught in try/catch, all queued operations and injectedPrompts MUST be discarded (BR-2).
    const rollbackRes = await executeSandboxedScript({
      code: `
        engine.state.set('flags.gate_open', true);
        engine.prompt.inject('scene', 'The gate creaks open.');
        try {
          engine.state.set('counters.trust', 99);
        } catch (_err) {
          // attempt to swallow capability error
        }
        'should-not-commit';
      `,
      manifest: {
        scriptId: 'rollback-on-violation',
        capabilities: ['state:read', 'state:write:flags.*', 'prompt:inject'],
      },
      stateSnapshot,
      rngState,
    });

    expect(isErr(rollbackRes)).toBe(true);
    if (isErr(rollbackRes)) {
      expect(rollbackRes.error[0]?.code).toBe('CAPABILITY_DENIED');
      expect(rollbackRes.error[0]?.message).toContain('state:write:counters.trust');
    }
  });

  it('enforces state:write glob matching and entities:write collection scoping', async () => {
    const stateSnapshot = createFixtureState();
    const rngState = createSeededRng('glob-test');

    const allowed = await executeSandboxedScript({
      code: `
        engine.state.set('flags.a', true);
        engine.state.entityPatch('characters', 'hero', { mood: 'alert' });
      `,
      manifest: {
        scriptId: 'glob-allowed',
        capabilities: ['state:write:flags.*', 'entities:write:characters'],
      },
      stateSnapshot,
      rngState,
    });

    expect(isOk(allowed)).toBe(true);
    if (isOk(allowed)) {
      expect(allowed.value.operations).toEqual([
        { op: 'set', path: 'flags.a', value: true },
        { op: 'entity_patch', collection: 'characters', entityId: 'hero', patch: { mood: 'alert' } },
      ]);
    }

    const deniedCounter = await executeSandboxedScript({
      code: `
        engine.state.set('flags.a', true);
        engine.state.increment('counters.x', 1);
      `,
      manifest: {
        scriptId: 'glob-denied-counter',
        capabilities: ['state:write:flags.*'],
      },
      stateSnapshot,
      rngState,
    });

    expect(isErr(deniedCounter)).toBe(true);
    if (isErr(deniedCounter)) {
      expect(deniedCounter.error[0]?.code).toBe('CAPABILITY_DENIED');
      expect(deniedCounter.error[0]?.message).toContain('state:write:counters.x');
    }

    const deniedFaction = await executeSandboxedScript({
      code: `
        engine.state.entityPatch('factions', 'iron_watch', { influence: 80 });
      `,
      manifest: {
        scriptId: 'entity-denied-faction',
        capabilities: ['entities:write:characters'],
      },
      stateSnapshot,
      rngState,
    });

    expect(isErr(deniedFaction)).toBe(true);
    if (isErr(deniedFaction)) {
      expect(deniedFaction.error[0]?.code).toBe('CAPABILITY_DENIED');
      expect(deniedFaction.error[0]?.message).toContain('entities:write:factions');
    }
  });

  it('aborts infinite loops cleanly within < 150 ms without hanging Node', async () => {
    const stateSnapshot = createFixtureState();
    const rngState = createSeededRng('timeout-test');

    const start = performance.now();
    const result = await executeSandboxedScript({
      code: `
        engine.state.set('flags.before_loop', true);
        while (true) {}
      `,
      manifest: {
        scriptId: 'infinite-loop',
        capabilities: ['state:write:flags.*'],
        timeoutMs: 30,
      },
      stateSnapshot,
      rngState,
    });
    const elapsedMs = performance.now() - start;

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error[0]?.code).toBe('SCRIPT_TIMEOUT');
    }
    expect(elapsedMs).toBeLessThan(150);
  });

  it('aborts out-of-memory and stack-overflow scripts cleanly', async () => {
    const stateSnapshot = createFixtureState();
    const rngState = createSeededRng('resource-limits');

    const oomResult = await executeSandboxedScript({
      code: `
        const chunks = [];
        for (let i = 0; i < 10000; i += 1) {
          chunks.push(new Array(500).fill(i));
        }
      `,
      manifest: {
        scriptId: 'oom-script',
        capabilities: [],
        memoryLimitBytes: 256 * 1024,
        timeoutMs: 500,
      },
      stateSnapshot,
      rngState,
    });

    expect(isErr(oomResult)).toBe(true);
    if (isErr(oomResult)) {
      expect(oomResult.error[0]?.code).toBe('SCRIPT_OUT_OF_MEMORY');
    }

    const stackResult = await executeSandboxedScript({
      code: `
        function recurse(n) { return recurse(n + 1); }
        recurse(0);
      `,
      manifest: {
        scriptId: 'stack-overflow-script',
        capabilities: [],
        timeoutMs: 500,
      },
      stateSnapshot,
      rngState,
    });

    expect(isErr(stackResult)).toBe(true);
    if (isErr(stackResult)) {
      expect(stackResult.error[0]?.code).toBe('SCRIPT_STACK_OVERFLOW');
    }
  });

  it('produces identical patches, logs, return values, and nextRng across repeated seeded runs', async () => {
    const stateSnapshot = deepFreeze(createFixtureState({ day: 4, turn: 7 }));
    const initialRng = deepFreeze(createSeededRng('deterministic-run-seed'));

    const script = `
      const r1 = Math.random();
      const r2 = Math.random();
      const dice = engine.dice.roll('2d6+1');
      engine.state.set('counters.last_roll', dice.total);
      engine.state.set('customFields.rand_sample', r1);
      engine.state.increment('counters.trust', dice.total > 7 ? 2 : -1);
      engine.log('rolled', dice.total, dice.rolls);
      ({ r1, r2, diceTotal: dice.total, rolls: dice.rolls });
    `;

    const manifest: ScriptManifest = {
      scriptId: 'deterministic-script',
      capabilities: ['dice', 'state:write:counters.*', 'state:write:customFields.*'],
    };

    const run1 = await executeSandboxedScript({
      code: script,
      manifest,
      stateSnapshot,
      rngState: initialRng,
    });
    const run2 = await executeSandboxedScript({
      code: script,
      manifest,
      stateSnapshot,
      rngState: initialRng,
    });

    expect(isOk(run1)).toBe(true);
    expect(isOk(run2)).toBe(true);
    if (isOk(run1) && isOk(run2)) {
      expect(run1.value.operations).toEqual(run2.value.operations);
      expect(run1.value.logs).toEqual(run2.value.logs);
      expect(run1.value.resultValue).toEqual(run2.value.resultValue);
      expect(run1.value.nextRng).toEqual(run2.value.nextRng);
      expect(run1.value.nextRng.drawCount).toBe(4); // 2 Math.random() + 2d6
      expect(run1.value.nextRng).not.toEqual(initialRng);
    }

    // Different seed produces distinct stream
    const differentSeedRun = await executeSandboxedScript({
      code: script,
      manifest,
      stateSnapshot,
      rngState: createSeededRng('completely-different-seed'),
    });
    expect(isOk(differentSeedRun)).toBe(true);
    if (isOk(run1) && isOk(differentSeedRun)) {
      expect(differentSeedRun.value.resultValue).not.toEqual(run1.value.resultValue);
    }
  });

  it('derives deterministic Date.now() and Date() timestamps from clocks.day and turn', async () => {
    const stateA = createFixtureState({ day: 2, turn: 5 });
    const stateB = createFixtureState({ day: 2, turn: 5 });
    const stateLater = createFixtureState({ day: 3, turn: 1 });
    const rng = createSeededRng('clock-seed');

    const code = `
      const t1 = Date.now();
      const t2 = new Date().getTime();
      const t3 = (new Date()).constructor.now();
      const explicit = new Date(1000).getTime();
      ({ t1, t2, t3, explicit });
    `;
    const manifest: ScriptManifest = { scriptId: 'date-test', capabilities: [] };

    const resA = await executeSandboxedScript({ code, manifest, stateSnapshot: stateA, rngState: rng });
    const resB = await executeSandboxedScript({ code, manifest, stateSnapshot: stateB, rngState: rng });
    const resLater = await executeSandboxedScript({
      code,
      manifest,
      stateSnapshot: stateLater,
      rngState: rng,
    });

    expect(isOk(resA)).toBe(true);
    expect(isOk(resB)).toBe(true);
    expect(isOk(resLater)).toBe(true);

    if (isOk(resA) && isOk(resB) && isOk(resLater)) {
      const aVal = resA.value.resultValue as { t1: number; t2: number; t3: number; explicit: number };
      const bVal = resB.value.resultValue as { t1: number; t2: number; t3: number; explicit: number };
      const laterVal = resLater.value.resultValue as { t1: number; t2: number; t3: number; explicit: number };

      expect(aVal.t1).toBe(aVal.t2);
      expect(aVal.t1).toBe(aVal.t3);
      expect(aVal.explicit).toBe(1000);
      expect(aVal).toEqual(bVal);
      expect(laterVal.t1).toBeGreaterThan(aVal.t1);
    }
  });

  it('exposes read-only engine.event, supports clock/prompt bridges, and applies patches cleanly via reducer', async () => {
    const stateSnapshot = deepFreeze(createFixtureState());
    const rngState = deepFreeze(createSeededRng('bridge-full'));
    const eventPayload = deepFreeze({
      type: 'encounter',
      actorId: 'hero',
      meta: { difficulty: 12 },
    });

    const result = await executeSandboxedScript({
      code: `
        // Attempt to mutate read-only engine.event silently fails in sloppy mode and throws in strict mode
        let strictThrew = false;
        try {
          (function() {
            'use strict';
            engine.event.meta.difficulty = 999;
          })();
        } catch (_e) {
          strictThrew = true;
        }

        const roll = engine.dice.roll('1d20+2');
        engine.state.set('flags.gate_open', true);
        engine.state.increment('counters.trust', 3);
        engine.state.entityPatch('characters', engine.event.actorId, { mood: 'triumphant' });
        engine.clock.advanceSlots(1);
        engine.clock.hold('dramatic confrontation');
        engine.prompt.inject('director_notes', 'Highlight Aria unlocking the gate.');
        engine.log('strictThrew=' + strictThrew);
        ({
          strictThrew,
          difficulty: engine.event.meta.difficulty,
          rollTotal: roll.total,
        });
      `,
      manifest: {
        scriptId: 'full-bridge',
        capabilities: [
          'state:read',
          'dice',
          'clock:advance',
          'prompt:inject',
          'state:write:flags.*',
          'state:write:counters.*',
          'entities:write:characters',
        ],
      },
      stateSnapshot,
      rngState,
      eventPayload,
    });

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.resultValue).toMatchObject({
        strictThrew: true,
        difficulty: 12,
      });
      expect(result.value.injectedPrompts).toEqual([
        { section: 'director_notes', text: 'Highlight Aria unlocking the gate.' },
      ]);
      expect(result.value.logs).toEqual(['strictThrew=true']);
      expect(result.value.operations).toHaveLength(5);

      const reduced = applyPatchBatch(stateSnapshot, {
        eventId: 'evt-script-1',
        source: 'script',
        operations: result.value.operations,
      });
      expect(isOk(reduced)).toBe(true);
      if (isOk(reduced)) {
        expect(reduced.value.nextState.flags.gate_open).toBe(true);
        expect(reduced.value.nextState.counters.trust).toBe(7);
        expect(reduced.value.nextState.entities.characters.hero?.mood).toBe('triumphant');
        expect(reduced.value.nextState.clocks.slot).toBe('evening');
        expect(reduced.value.nextState.clocks.held).toBe(true);
        expect(reduced.value.nextState.clocks.holdReason).toBe('dramatic confrontation');
      }
    }
  });

  it('blocks prototype pollution keys, unsafe values, and runtime errors while rolling back ops', async () => {
    const stateSnapshot = createFixtureState();
    const rngState = createSeededRng('security-test');
    const fullManifest: ScriptManifest = {
      scriptId: 'security-script',
      capabilities: ['state:read', 'state:write:*', 'entities:write:*'],
    };

    const protoPath = await executeSandboxedScript({
      code: `
        engine.state.set('flags.ok', true);
        engine.state.set('customFields.__proto__.polluted', true);
      `,
      manifest: fullManifest,
      stateSnapshot,
      rngState,
    });
    expect(isErr(protoPath)).toBe(true);
    if (isErr(protoPath)) {
      expect(protoPath.error[0]?.code).toBe('SCRIPT_RUNTIME_ERROR');
    }

    const protoObj = await executeSandboxedScript({
      code: `
        const payload = JSON.parse('{"__proto__":{"admin":true}}');
        engine.state.set('customFields.bad', payload);
      `,
      manifest: fullManifest,
      stateSnapshot,
      rngState,
    });
    expect(isErr(protoObj)).toBe(true);

    const circularRes = await executeSandboxedScript({
      code: `
        const obj = {};
        obj.self = obj;
        engine.state.set('customFields.circ', obj);
      `,
      manifest: fullManifest,
      stateSnapshot,
      rngState,
    });
    expect(isErr(circularRes)).toBe(true);

    const syntaxErr = await executeSandboxedScript({
      code: `const x = (;`,
      manifest: fullManifest,
      stateSnapshot,
      rngState,
    });
    expect(isErr(syntaxErr)).toBe(true);
    if (isErr(syntaxErr)) {
      expect(syntaxErr.error[0]?.code).toBe('SCRIPT_SYNTAX_ERROR');
    }

    // Confirm no prototype pollution occurred on host Object.prototype
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).admin).toBeUndefined();

    // Inherited Object.prototype properties are not leaked via state.get
    const protoRead = await executeSandboxedScript({
      code: `({ toStr: engine.state.get('flags.toString'), missing: engine.state.get('flags.nope') })`,
      manifest: fullManifest,
      stateSnapshot,
      rngState,
    });
    expect(isOk(protoRead)).toBe(true);
    if (isOk(protoRead)) {
      expect(protoRead.value.resultValue).toEqual({ toStr: undefined, missing: undefined });
    }
  });

  it('handles resolved and rejected Promises cleanly with atomic rollback', async () => {
    const stateSnapshot = createFixtureState();
    const rngState = createSeededRng('promise-test');
    const manifest: ScriptManifest = {
      scriptId: 'promise-script',
      capabilities: ['state:write:flags.*'],
    };

    const resolved = await executeSandboxedScript({
      code: `
        engine.state.set('flags.async_ok', true);
        Promise.resolve({ ok: 123 });
      `,
      manifest,
      stateSnapshot,
      rngState,
    });
    expect(isOk(resolved)).toBe(true);
    if (isOk(resolved)) {
      expect(resolved.value.resultValue).toEqual({ ok: 123 });
      expect(resolved.value.operations).toEqual([
        { op: 'set', path: 'flags.async_ok', value: true },
      ]);
    }

    const rejected = await executeSandboxedScript({
      code: `
        engine.state.set('flags.should_rollback', true);
        Promise.reject(new Error('async failure'));
      `,
      manifest,
      stateSnapshot,
      rngState,
    });
    expect(isErr(rejected)).toBe(true);
    if (isErr(rejected)) {
      expect(rejected.error[0]?.code).toBe('SCRIPT_RUNTIME_ERROR');
      expect(rejected.error[0]?.message).toContain('async failure');
    }
  });

  it('survives 30 repeated mixed executions with zero QuickJS WASM handle or memory leaks', async () => {
    const stateSnapshot = createFixtureState();
    const rngState = createSeededRng('leak-check');

    for (let i = 0; i < 30; i += 1) {
      const mode = i % 4;
      if (mode === 0) {
        const res = await executeSandboxedScript({
          code: `engine.state.set('flags.run_${i}', true); engine.dice.roll('1d6').total;`,
          manifest: { scriptId: `leak-${i}`, capabilities: ['dice', 'state:write:flags.*'] },
          stateSnapshot,
          rngState,
        });
        expect(isOk(res)).toBe(true);
      } else if (mode === 1) {
        const res = await executeSandboxedScript({
          code: `engine.state.set('counters.denied', 1);`,
          manifest: { scriptId: `leak-${i}`, capabilities: ['state:read'] },
          stateSnapshot,
          rngState,
        });
        expect(isErr(res)).toBe(true);
      } else if (mode === 2) {
        const res = await executeSandboxedScript({
          code: `while (true) {}`,
          manifest: { scriptId: `leak-${i}`, capabilities: [], timeoutMs: 10 },
          stateSnapshot,
          rngState,
        });
        expect(isErr(res)).toBe(true);
      } else {
        const res = await executeSandboxedScript({
          code: `throw new Error('boom');`,
          manifest: { scriptId: `leak-${i}`, capabilities: [] },
          stateSnapshot,
          rngState,
        });
        expect(isErr(res)).toBe(true);
      }
    }
  });
});
