import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMockModelGateway } from '../../src/gateway/mock-provider.js';
import { RefereeDaemon } from '../../src/server/daemon.js';
import type { SystemPack } from '../../src/schema/tracker-module.js';
import {
  RefereeBridgeClient,
  RefereeBridgeError,
  isSafePropertyKey,
} from '../../clients/st-bridge/bridge-client.js';
import {
  buildApplyWizardModulePayload,
  buildControlRoomViewModel,
  buildModuleTogglePayload,
  buildPromptSectionPayload,
  buildSwitchPackPayload,
  buildWizardGenerateRequest,
  renderControlRoomModalHtml,
} from '../../clients/st-bridge/control-room-modal.js';
import { DirectorBarState, renderDirectorBarHtml } from '../../clients/st-bridge/director-bar.js';
import { renderHudStateHtml } from '../../clients/st-bridge/hud-panel.js';
import {
  REFEREE_CONTEXT_TAG,
  dispose,
  getBridgeRuntime,
  initialize,
  refereeGenerateInterceptor,
} from '../../clients/st-bridge/index.js';

interface MockStMessage {
  name?: string;
  is_user?: boolean;
  is_system?: boolean;
  role?: string;
  mes: string;
  content?: string;
  swipe_id?: number;
  swipes?: string[];
  extra?: Record<string, unknown>;
}

type EventHandler = (...args: unknown[]) => unknown;

interface MockEventEmitter {
  on(event: string, handler: EventHandler): void;
  off(event: string, handler: EventHandler): void;
  emitAsync(event: string, ...args: unknown[]): Promise<void>;
  listenerCount(event: string): number;
}

function createMockEventEmitter(): MockEventEmitter {
  const listeners = new Map<string, Set<EventHandler>>();
  return {
    on(event: string, handler: EventHandler): void {
      let set = listeners.get(event);
      if (set === undefined) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(handler);
    },
    off(event: string, handler: EventHandler): void {
      const set = listeners.get(event);
      if (set !== undefined) {
        set.delete(handler);
      }
    },
    async emitAsync(event: string, ...args: unknown[]): Promise<void> {
      const set = listeners.get(event);
      if (set === undefined) {
        return;
      }
      const promises: Promise<unknown>[] = [];
      for (const handler of Array.from(set)) {
        const res = handler(...args);
        promises.push(Promise.resolve(res));
      }
      await Promise.all(promises);
    },
    listenerCount(event: string): number {
      return listeners.get(event)?.size ?? 0;
    },
  };
}

interface MockStContext {
  chat: MockStMessage[];
  chatMetadata: Record<string, unknown>;
  eventSource: MockEventEmitter;
  event_types: Record<string, string>;
  saveMetadataDebounced: () => void;
  saveCount: number;
}

function createMockStContext(): MockStContext {
  const eventSource = createMockEventEmitter();
  const ctx: MockStContext = {
    chat: [],
    chatMetadata: {},
    eventSource,
    event_types: {
      MESSAGE_RECEIVED: 'MESSAGE_RECEIVED',
      CHARACTER_MESSAGE_RENDERED: 'CHARACTER_MESSAGE_RENDERED',
      MESSAGE_SWIPED: 'MESSAGE_SWIPED',
      MESSAGE_EDITED: 'MESSAGE_EDITED',
      CHAT_CHANGED: 'CHAT_CHANGED',
    },
    saveCount: 0,
    saveMetadataDebounced(): void {
      ctx.saveCount += 1;
    },
  };
  return ctx;
}

describe('PR-6.2: SillyTavern Bridge Extension (referee-st-bridge)', () => {
  const activeDaemons: RefereeDaemon[] = [];
  let originalSillyTavern: unknown;

  beforeEach(() => {
    originalSillyTavern = (globalThis as Record<string, unknown>)['SillyTavern'];
  });

  afterEach(async () => {
    dispose();
    if (originalSillyTavern === undefined) {
      delete (globalThis as Record<string, unknown>)['SillyTavern'];
    } else {
      (globalThis as Record<string, unknown>)['SillyTavern'] = originalSillyTavern;
    }
    while (activeDaemons.length > 0) {
      const d = activeDaemons.pop();
      if (d !== undefined) {
        await d.stop();
      }
    }
  });

  async function bootTestDaemon(): Promise<{ daemon: RefereeDaemon; url: string }> {
    let narratorCalls = 0;
    const gateway = createMockModelGateway({
      narrator: () => {
        narratorCalls += 1;
        return {
          kind: 'text',
          text: `Daemon regenerated narrator reply #${narratorCalls}.`,
        };
      },
      state_tracker: {
        kind: 'json',
        value: {
          scene: {
            location: 'Lantern Courtyard',
            mood: 'mysterious',
          },
        },
      },
      chronicle_router: {
        kind: 'json',
        value: {
          shouldRecord: true,
          category: 'event',
          title: 'Courtyard Cipher',
          summary: 'The lantern revealed a cipher on the flagstones.',
          keywords: ['lantern', 'cipher'],
          involvedEntityIds: [],
        },
      },
      game_system_wizard: {
        kind: 'json',
        value: {
          module: {
            id: 'ward_resonance',
            name: 'Ward Resonance',
            description: 'Tracks magical ward stability across turns.',
            enabled: true,
            scope: 'session',
            target: 'global',
            effectOwner: 'hybrid',
            cadence: 'every_turn',
            fields: {
              resonance: {
                type: 'meter',
                min: 0,
                max: 100,
                default: 80,
                writableByTracker: true,
                confirmPolicy: 'auto',
                description: 'Current ward resonance percentage',
              },
            },
            trackerInstruction: 'Adjust resonance when wards pulse or fracture.',
            narratorRule: 'Describe harmonic chimes matching the resonance level.',
            ui: { widget: 'bar', order: 10 },
          },
          clockTriggers: [{ on: 'slot', op: 'increment', field: 'resonance', value: -5 }],
          suggestedBeats: [],
          previewCard: { title: 'Ward Resonance', resonance: 80 },
        },
      },
    });

    const daemon = new RefereeDaemon({
      host: '127.0.0.1',
      port: 0,
      gateway,
    });
    activeDaemons.push(daemon);
    const info = await daemon.start();
    return { daemon, url: info.url };
  }

  it('1. refereeGenerateInterceptor injects [STATE] and [PLOT] cleanly without duplicating tagged messages across repeated runs', async () => {
    const { url } = await bootTestDaemon();
    const ctx = createMockStContext();
    (globalThis as Record<string, unknown>)['SillyTavern'] = {
      getContext: () => ctx,
    };

    const client = new RefereeBridgeClient({ baseUrl: url });
    const importRes = await client.importCartridge({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: 'Elena Vance',
        description: 'Archivist of the Lantern Courtyard.',
        scenario: 'Rain falls over the library flagstones.',
      },
    });
    const sessRes = await client.createSession({
      sessionId: 'st-intercept-sess',
      cartridgeId: importRes.cartridgeId,
      systemPackId: 'stock-slice-of-life',
      seed: 'st-seed-1',
    });
    ctx.chatMetadata['referee'] = { refereeSessionId: sessRes.sessionId };

    const directorBar = new DirectorBarState({
      oocNudge: 'Highlight the cold lantern glow.',
    });
    initialize({ client, directorBar });

    const promptChat: MockStMessage[] = [
      { is_user: false, mes: 'Welcome to the courtyard.' },
      {
        is_user: false,
        is_system: true,
        mes: `${REFEREE_CONTEXT_TAG}\n[STATE]\nSTALE STATE FROM PREVIOUS TURN`,
        extra: { referee_context: true },
      },
      { is_user: true, mes: 'I raise the brass lantern toward the archway.' },
    ];

    // Run twice back-to-back to ensure zero duplication
    await refereeGenerateInterceptor(promptChat, 4096, () => {}, 'normal');
    await refereeGenerateInterceptor(promptChat, 4096, () => {}, 'normal');

    const taggedMessages = promptChat.filter(
      (m) => m.mes.includes(REFEREE_CONTEXT_TAG) || m.extra?.['referee_context'] === true
    );
    expect(taggedMessages).toHaveLength(1);
    const injected = taggedMessages[0]!;
    expect(injected.mes).toContain('[STATE]');
    expect(injected.mes).toContain('[PLOT]');
    expect(injected.mes).toContain('Highlight the cold lantern glow.');
    expect(injected.mes).not.toContain('STALE STATE FROM PREVIOUS TURN');

    // Injected block is spliced right before the final user message
    expect(promptChat[promptChat.length - 1]?.is_user).toBe(true);
    expect(promptChat[promptChat.length - 2]).toBe(injected);
    // Stores ONLY { refereeSessionId } in chatMetadata.referee
    expect(ctx.chatMetadata['referee']).toEqual({ refereeSessionId: 'st-intercept-sess' });
  });

  it('2. CHARACTER_MESSAGE_RENDERED triggers postNarrate and updates state in the daemon', async () => {
    const { url } = await bootTestDaemon();
    const ctx = createMockStContext();
    (globalThis as Record<string, unknown>)['SillyTavern'] = {
      getContext: () => ctx,
    };

    const client = new RefereeBridgeClient({ baseUrl: url });
    const created = await client.createSession({
      sessionId: 'st-post-narrate-sess',
      systemPackId: 'stock-slice-of-life',
      seed: 'st-seed-2',
    });
    ctx.chatMetadata['referee'] = { refereeSessionId: created.sessionId };

    const stateSnapshots: Array<{ state: { meta: { turn: number }; scene: { location: string } } }> = [];
    initialize({
      client,
      onStateUpdated: (payload: Record<string, unknown>) => {
        stateSnapshots.push(
          payload as { state: { meta: { turn: number }; scene: { location: string } } }
        );
      },
    });

    ctx.chat.push(
      { is_user: true, mes: 'I step out into the Lantern Courtyard.' },
      { is_user: false, mes: 'Mist curls around the mossy steps of the courtyard.', swipe_id: 0 }
    );

    await ctx.eventSource.emitAsync('CHARACTER_MESSAGE_RENDERED', 1);

    const daemonState = (await client.getSessionState('st-post-narrate-sess')) as {
      state: { meta: { turn: number }; scene: { location: string; mood: string } };
      auditEntries?: unknown[];
    };
    expect(daemonState.state.meta.turn).toBe(1);
    expect(daemonState.state.scene.location).toBe('Lantern Courtyard');
    expect(daemonState.state.scene.mood).toBe('mysterious');
    expect(stateSnapshots.length).toBe(1);
    expect(stateSnapshots[0]?.state.meta.turn).toBe(1);

    const auditRes = (await client.getAudit('st-post-narrate-sess', {
      turn: 1,
      source: 'tracker',
    })) as { ok: boolean; entries: Array<{ path: string }> };
    expect(auditRes.ok).toBe(true);
    expect(auditRes.entries.some((e) => e.path === 'scene.location')).toBe(true);
  });

  it('3. MESSAGE_SWIPED triggers daemon swipe synchronization (regenerate & switch) and CHAT_CHANGED rebinds sessionId', async () => {
    const { url } = await bootTestDaemon();
    const ctx = createMockStContext();
    (globalThis as Record<string, unknown>)['SillyTavern'] = {
      getContext: () => ctx,
    };

    const client = new RefereeBridgeClient({ baseUrl: url });
    await client.createSession({
      sessionId: 'st-swipe-sess',
      systemPackId: 'stock-slice-of-life',
      seed: 'st-seed-3',
    });
    ctx.chatMetadata['referee'] = { refereeSessionId: 'st-swipe-sess' };

    initialize({ client });

    // Turn 1 via CHARACTER_MESSAGE_RENDERED
    ctx.chat.push(
      { is_user: true, mes: 'Examine the flagstones.' },
      {
        is_user: false,
        mes: 'Original ST reply.',
        swipe_id: 0,
        swipes: ['Original ST reply.'],
      }
    );
    await ctx.eventSource.emitAsync('CHARACTER_MESSAGE_RENDERED', 1);

    // Swipe right beyond existing daemon swipes -> triggers regenerate
    ctx.chat[1]!.swipe_id = 1;
    await ctx.eventSource.emitAsync('MESSAGE_SWIPED', 1);

    let stateAfterRegen = (await client.getSessionState('st-swipe-sess')) as {
      swipeTree: {
        activeLeafMessageId: string;
        nodes: Record<string, { activeSwipeIndex: number; swipes: Array<{ content: string }> }>;
      };
    };
    const msgId = stateAfterRegen.swipeTree.activeLeafMessageId;
    const nodeAfterRegen = stateAfterRegen.swipeTree.nodes[msgId];
    expect(nodeAfterRegen?.swipes).toHaveLength(2);
    expect(nodeAfterRegen?.activeSwipeIndex).toBe(1);
    expect(nodeAfterRegen?.swipes[1]?.content).toContain('Daemon regenerated narrator reply #1');

    // Swipe back left to index 0 -> triggers switch
    ctx.chat[1]!.swipe_id = 0;
    await ctx.eventSource.emitAsync('MESSAGE_SWIPED', 1);

    stateAfterRegen = (await client.getSessionState('st-swipe-sess')) as typeof stateAfterRegen;
    const nodeAfterSwitch = stateAfterRegen.swipeTree.nodes[msgId];
    expect(nodeAfterSwitch?.activeSwipeIndex).toBe(0);
    expect(nodeAfterSwitch?.swipes[0]?.content).toBe('Original ST reply.');

    // CHAT_CHANGED rebinds chatMetadata.referee sessionId
    ctx.chatMetadata = { referee: { sessionId: 'other-chat-session' } };
    await ctx.eventSource.emitAsync('CHAT_CHANGED');
    expect(getBridgeRuntime().activeSessionId).toBe('other-chat-session');
    expect(ctx.chatMetadata['referee']).toEqual({ refereeSessionId: 'other-chat-session' });
  });

  it('4. renderHudStateHtml hides RPG/faction panels under stock-slice-of-life and renders dynamic Game System bars when enabled', async () => {
    const { url } = await bootTestDaemon();
    const client = new RefereeBridgeClient({ baseUrl: url });
    await client.createSession({
      sessionId: 'st-hud-sess',
      systemPackId: 'stock-slice-of-life',
      seed: 'st-seed-4',
    });

    const sliceState = await client.getSessionState('st-hud-sess');
    const sliceHtml = renderHudStateHtml(sliceState);

    expect(sliceHtml).toContain('data-widget="dual-clock"');
    expect(sliceHtml).toContain('data-widget="scene-cast"');
    expect(sliceHtml).not.toContain('data-widget="factions-threats"');
    expect(sliceHtml).not.toContain('data-widget="combat-panel"');
    expect(sliceHtml).not.toContain('data-widget="active-gate-beat"');
    expect(sliceHtml).not.toContain('data-module-id="tactical_combat"');
    expect(sliceHtml).not.toContain('data-module-id="rpg_progression"');

    // Generate & install a custom meter module via Wizard -> PATCH /control-room
    const wizardRes = await client.generateWizardSystem(
      buildWizardGenerateRequest({
        description: 'Track ward resonance stability.',
        effectOwner: 'hybrid',
      })
    );
    await client.patchControlRoom('st-hud-sess', buildApplyWizardModulePayload(wizardRes));

    const updatedState = await client.getSessionState('st-hud-sess');
    const updatedHtml = renderHudStateHtml(updatedState);
    expect(updatedHtml).toContain('data-module-id="ward_resonance"');
    expect(updatedHtml).toContain('data-widget-type="bar"');
    expect(updatedHtml).toContain('referee-bridge-meter-fill');
    expect(updatedHtml).toContain('80 / 100');

    // Switch to stock-living-world -> faction/threat and active-gate-beat panels appear
    await client.patchControlRoom('st-hud-sess', buildSwitchPackPayload('stock-living-world'));
    const livingState = await client.getSessionState('st-hud-sess');
    const livingHtml = renderHudStateHtml(livingState);
    expect(livingHtml).toContain('data-widget="factions-threats"');
    expect(livingHtml).toContain('data-widget="active-gate-beat"');
  });

  it('5. DirectorBarState and control-room-modal helpers build valid payloads for the live daemon', async () => {
    const { url } = await bootTestDaemon();
    const client = new RefereeBridgeClient({ baseUrl: url });

    const health = (await client.health()) as { ok: boolean; sessions: number };
    expect(health.ok).toBe(true);

    const packsRes = (await client.listSystemPacks()) as unknown as {
      ok: boolean;
      systemPacks: SystemPack[];
    };
    expect(packsRes.systemPacks.length).toBeGreaterThanOrEqual(4);

    const cardImport = (await client.importCartridge({
      rootDir: null,
      card: {
        spec: 'cartridge/0.1',
        id: 'lantern-courtyard-pack',
        version: '1.0.0',
        title: 'Lantern Courtyard',
        description: 'A rain-slicked courtyard mystery.',
        persona: {
          name: 'Elena Vance',
          description: 'Archivist of the Lantern Courtyard.',
        },
      },
      initialEntities: {
        characters: {
          elena: {
            id: 'elena',
            name: 'Elena Vance',
            status: 'active',
            presentInScene: false,
            locationId: null,
            formId: null,
            formGroup: null,
            sections: {},
            customFields: {},
            abilities: [],
            goals: [],
            agenda: 'Protect the archive.',
            allegiance: 'Archive',
            mood: 'calm',
            traits: ['observant'],
          },
        },
      },
      beats: [
        {
          id: 'beat_intro',
          class: 'nudge',
          priority: 50,
          when: { clock: 'turn', op: '>=', value: 0 },
          nudge: 'Introduce the brass lantern.',
        },
      ],
      routes: [],
      endings: [],
      loreFiles: {},
      endingPromptFiles: {},
      scriptFiles: {},
    })) as { cartridgeId: string };

    await client.createSession({
      sessionId: 'st-cr-sess',
      cartridgeId: cardImport.cartridgeId,
      systemPackId: 'stock-tactical-rpg',
      seed: 'st-seed-5',
    });

    // Selective group pack switch: keep tuningDials/promptSections while switching capabilities & gameSystems
    await client.patchControlRoom(
      'st-cr-sess',
      buildSwitchPackPayload('stock-slice-of-life', ['capabilities', 'gameSystems'])
    );
    // Toggle module & edit prompt section
    await client.patchControlRoom('st-cr-sess', buildModuleTogglePayload('relationship_affinity', false));
    await client.patchControlRoom(
      'st-cr-sess',
      buildPromptSectionPayload('narrative_pacing', 'Linger on subtle sensory details.', true)
    );

    const wizardDraft = await client.generateWizardSystem(
      buildWizardGenerateRequest({ description: 'Ward resonance meter', effectOwner: 'hybrid' })
    );
    await client.patchControlRoom('st-cr-sess', buildApplyWizardModulePayload(wizardDraft));

    const sessionState = (await client.getSessionState('st-cr-sess')) as {
      diffReport: { overallBadge: string };
      config: { gameSystems: Array<{ id: string; enabled: boolean }> };
    };
    expect(sessionState.diffReport.overallBadge).toBe('user_customized');
    expect(
      sessionState.config.gameSystems.find((m) => m.id === 'relationship_affinity')?.enabled
    ).toBe(false);
    expect(sessionState.config.gameSystems.some((m) => m.id === 'ward_resonance')).toBe(true);

    const vm = buildControlRoomViewModel({
      systemPacks: packsRes.systemPacks,
      sessionState,
      selectedGroups: ['capabilities', 'gameSystems'],
      wizardRequest: { description: 'Ward resonance meter', effectOwner: 'hybrid' },
      wizardDraft,
    });
    const modalHtml = renderControlRoomModalHtml(vm);
    expect(modalHtml).toContain('data-overall-badge="user_customized"');
    expect(modalHtml).toContain('data-wizard-preview="true"');
    expect(modalHtml).toContain('stock-slice-of-life');
    expect(modalHtml).toContain('stock-living-world');

    // DirectorBarState builds valid DirectorSteeringInput accepted by /compile-prompt and /post-narrate
    const director = new DirectorBarState();
    director.setHoldClock(true);
    director.setOocNudge('Keep the storm tension building.');
    director.pinCharacter('elena');
    director.addBeatOverride('beat_intro', 'deferred', 'Wait for dawn');

    const steeringPayload = director.buildDirectorSteeringPayload();
    expect(steeringPayload).toEqual({
      clockAction: 'hold',
      oocNudge: 'Keep the storm tension building.',
      pinCharacterIds: ['elena'],
      beatOverrides: [{ beatId: 'beat_intro', status: 'deferred', reason: 'Wait for dawn' }],
    });

    const barHtml = renderDirectorBarHtml(director, {
      availableCharacters: [{ id: 'elena', name: 'Elena Vance' }],
    });
    expect(barHtml).toContain('Clock Held');
    expect(barHtml).toContain('Keep the storm tension building.');

    const compileRes = (await client.compilePrompt('st-cr-sess', {
      latestInput: 'I wait under the eaves.',
      directorSteering: steeringPayload,
    })) as { ok: boolean; sections: { plot: string }; state: { clocks: { held: boolean } } };
    expect(compileRes.ok).toBe(true);
    expect(compileRes.sections.plot).toContain('Keep the storm tension building.');
    expect(compileRes.state.clocks.held).toBe(true);

    const postRes = (await client.postNarrate('st-cr-sess', {
      userText: 'I wait under the eaves.',
      narratorText: 'Thunder rolls overhead while the clock stays frozen.',
      directorSteering: steeringPayload,
    })) as { ok: boolean; turn: number; pendingConfirmations: unknown[] };
    expect(postRes.ok).toBe(true);
    expect(postRes.turn).toBe(1);

    const chronicleRes = (await client.getChronicle('st-cr-sess')) as { ok: boolean; events: unknown[] };
    expect(chronicleRes.ok).toBe(true);

    // Confirm patch path works cleanly
    const confirmRes = (await client.confirmPatch('st-cr-sess', 'accept_all')) as { ok: boolean };
    expect(confirmRes.ok).toBe(true);

    // Prototype pollution guard check on sessionId and payload builders
    await expect(client.getSessionState('__proto__')).rejects.toBeInstanceOf(RefereeBridgeError);
    expect(isSafePropertyKey('__proto__')).toBe(false);
    expect(isSafePropertyKey('constructor')).toBe(false);
    expect(isSafePropertyKey('prototype')).toBe(false);
    expect(() => buildModuleTogglePayload('__proto__', true)).toThrow();
    expect(() => buildSwitchPackPayload('constructor')).toThrow();
    expect(() => buildApplyWizardModulePayload({ module: { id: 'prototype' } })).toThrow();
  });

  it('6. handles auto-session creation in chatMetadata, pending confirmation toasts, XSS escaping, and stock-freeform hiding', async () => {
    const { url } = await bootTestDaemon();
    const ctx = createMockStContext();
    (globalThis as Record<string, unknown>)['SillyTavern'] = {
      getContext: () => ctx,
    };

    const client = new RefereeBridgeClient({ baseUrl: url });
    initialize({
      client,
      sessionOptions: { systemPackId: 'stock-freeform', seed: 'auto-seed-6' },
    });

    // No pre-existing chatMetadata.referee -> interceptor creates session & stores ONLY { refereeSessionId }
    const chat: MockStMessage[] = [{ is_user: true, mes: 'Hello <script>alert(1)</script>.' }];
    await refereeGenerateInterceptor(chat, 2048, () => {}, 'normal');

    const refMeta = ctx.chatMetadata['referee'] as Record<string, unknown>;
    expect(Object.keys(refMeta)).toEqual(['refereeSessionId']);
    const autoSessionId = String(refMeta['refereeSessionId']);
    expect(autoSessionId.length).toBeGreaterThan(0);

    // Freeform HUD hides RPG/combat/faction/clock/beat panels and escapes HTML
    const freeformState = await client.getSessionState(autoSessionId);
    const augmentedState = {
      ...freeformState,
      state: {
        ...(freeformState['state'] as Record<string, unknown>),
        scene: {
          location: 'Cafe <script>xss</script>',
          mood: 'calm',
          presentCharacterIds: ['npc_1'],
          pinnedCharacterIds: [],
        },
        entities: {
          characters: {
            npc_1: { name: '<b>Bob</b>' },
          },
          factions: {},
          threats: {},
          locations: {},
        },
      },
      pendingConfirmations: [{ op: 'set', path: 'scene.mood', value: 'warm' }],
    };

    const html = renderHudStateHtml(augmentedState);
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>Bob</b>');
    expect(html).toContain('&lt;script&gt;xss&lt;/script&gt;');
    expect(html).toContain('&lt;b&gt;Bob&lt;/b&gt;');
    expect(html).not.toContain('data-widget="dual-clock"');
    expect(html).not.toContain('data-widget="factions-threats"');
    expect(html).not.toContain('data-widget="combat-panel"');
    expect(html).not.toContain('data-widget="active-gate-beat"');
    expect(html).toContain('data-widget="pending-confirmations"');
    expect(html).toContain('data-action="confirm-accept-all"');
    expect(html).toContain('data-action="confirm-reject-all"');
    expect(html).toContain('data-action="confirm-accept-index"');

    // DirectorBarState advanceSlots and resetTurnOverrides
    const dir = new DirectorBarState();
    dir.setHoldClock(true);
    dir.setAdvanceSlots(2);
    expect(dir.holdClock).toBe(false);
    expect(dir.buildDirectorSteeringPayload()).toEqual({ clockAction: { advanceSlots: 2 } });
    dir.setOocNudge('One-turn cue');
    dir.resetTurnOverrides();
    expect(dir.buildDirectorSteeringPayload()).toEqual({});
  });
});
