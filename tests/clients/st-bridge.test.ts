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
  SHEET_PRESET_IDS,
  bindControlRoomModalDom,
  buildApplySheetPresetPayload,
  buildApplyWizardModulePayload,
  buildConnectionsUpdatePayload,
  buildControlRoomViewModel,
  buildModuleTogglePayload,
  buildPromptSectionPayload,
  buildSwitchPackPayload,
  buildWizardGenerateRequest,
  renderControlRoomModalHtml,
} from '../../clients/st-bridge/control-room-modal.js';
import { DirectorBarState, renderDirectorBarHtml } from '../../clients/st-bridge/director-bar.js';
import { renderHudPanel, renderHudStateHtml } from '../../clients/st-bridge/hud-panel.js';
import {
  REFEREE_CONTEXT_TAG,
  createControlRoomBridgeHandlers,
  dispose,
  extractActiveSillyTavernPersona,
  extractActiveSillyTavernPreset,
  getBridgeRuntime,
  initialize,
  refereeGenerateInterceptor,
  syncActiveSillyTavernPersona,
  syncActiveSillyTavernPreset,
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

  it('7. PR-10.2: RefereeBridgeClient new endpoints and HUD parity (Traditional Theater, hazards, discoveryState, newsroom)', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const client = new RefereeBridgeClient({
      baseUrl: 'http://127.0.0.1:4120',
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), method: init?.method ?? 'GET' });
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    await client.previewCombat('s1', { skillId: 'slash' });
    await client.travel('s1', { destinationId: 'loc_2' });
    await client.downtime('s1', { activity: 'rest' });
    await client.cloneSession('s1', { label: 'alt' });
    await client.listSessions();
    await client.getContextBudget('s1');
    await client.importCard({ path: 'card.png' });
    await client.bindPlayer('s1', { canonCharacterId: 'char_1' });

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST http://127.0.0.1:4120/api/sessions/s1/combat/preview',
      'POST http://127.0.0.1:4120/api/sessions/s1/travel',
      'POST http://127.0.0.1:4120/api/sessions/s1/downtime',
      'POST http://127.0.0.1:4120/api/sessions/s1/clone',
      'GET http://127.0.0.1:4120/api/sessions',
      'GET http://127.0.0.1:4120/api/sessions/s1/context-budget',
      'POST http://127.0.0.1:4120/api/cards/import',
      'POST http://127.0.0.1:4120/api/sessions/s1/player/bind',
    ]);

    const html = renderHudStateHtml({
      config: {
        packId: 'stock-rpg-full',
        packName: 'Full RPG',
        capabilities: { combatMode: 'traditional' },
        gameSystems: [],
      },
      state: {
        meta: { turn: 2 },
        scene: { location: 'Keep', locationId: 'loc_keep', mood: 'alert' },
        entities: {
          locations: { loc_keep: { discoveryState: 'visited' } },
        },
        chronicle: {
          digestEditions: [
            {
              id: 'ed-1',
              day: 4,
              masthead: 'The <script>Daily</script>',
              headlines: ['Dragon Sighted', '<b>Alert</b>'],
            },
          ],
        },
      },
      combatState: {
        mode: 'traditional',
        turnStyle: 'phased',
        round: 1,
        activeCombatantId: 'c1',
        combatants: {
          c1: {
            id: 'c1',
            name: 'Aria',
            formationRow: 'back',
            isSummon: true,
            activeTransform: { loadoutId: 'phoenix' },
            hp: 12,
            maxHp: 20,
            willpower: 3,
            maxWillpower: 5,
          },
        },
        grid: {
          tiles: [[{ hazard: 'fire' }, { hazard: 'sanctuary' }]],
        },
      },
    });

    expect(html).toContain('visited');
    expect(html).toContain('phased');
    expect(html).toContain('BACK');
    expect(html).toContain('SUMMON');
    expect(html).toContain('FORM:phoenix');
    expect(html).toContain('WP 3/5');
    expect(html).toContain('(0,0)=fire');
    expect(html).toContain('(1,0)=sanctuary');
    expect(html).toContain('The &lt;script&gt;Daily&lt;/script&gt;');
    expect(html).toContain('&lt;b&gt;Alert&lt;/b&gt;');
    expect(html).not.toContain('<script>');
  });

  it('8. Wave 5 RefereeBridgeClient methods hit exact URLs, HTTP methods, query params, and payloads', async () => {
    interface RecordedCall {
      url: string;
      method: string;
      body: unknown;
    }
    const calls: RecordedCall[] = [];
    const spyFetch: typeof globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ url, method, body });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const client = new RefereeBridgeClient({ baseUrl: 'http://127.0.0.1:4120/', fetchImpl: spyFetch });

    await client.getConnections();
    await client.getConnections({ redact: true });
    await client.updateConnections({
      defaultConnection: {
        provider: 'ollama',
        baseUrl: 'http://127.0.0.1:11434',
        model: 'llama3.1:8b',
        temperature: 0.7,
        maxTokens: 512,
      },
    });
    await client.saveConnectionProfile('Local Ollama', {
      defaultConnection: { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'llama3.1:8b' },
      activate: true,
    });
    await client.activateConnectionProfile('Local Ollama');

    await client.listPresets();
    await client.importPreset({ preset: { temperature: 0.8 }, sessionId: 'sess/1' });
    await client.exportSessionPreset('sess/1', 'st_chat');
    await client.applyPreset('sess/1', { sheetPresetId: 'dnd-adventurer' });

    await client.listPersonas();
    await client.savePersona({ id: 'hero-1', name: 'Aria', description: 'Scout' });
    await client.applySessionPersona('sess/1', { personaId: 'hero-1' });

    await client.getSettingCharacters('sess/1', {
      locationId: 'tavern',
      status: 'active',
      allegiance: 'guild',
      formGroup: 'lycan',
      presentOnly: true,
      includePlayer: false,
      query: 'aria',
    });
    await client.getCharacterDossier('sess/1', 'npc/elena');
    await client.upsertCharacter('sess/1', { characterId: 'npc_2', name: 'Marcus' });
    await client.startCombat('sess/1', {
      participants: [{ id: 'player', name: 'Aria', team: 'ally', hp: 20, maxHp: 20 }],
    });

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET http://127.0.0.1:4120/api/connections',
      'GET http://127.0.0.1:4120/api/connections?redact=true',
      'PUT http://127.0.0.1:4120/api/connections',
      'POST http://127.0.0.1:4120/api/connections/profiles',
      'POST http://127.0.0.1:4120/api/connections/profiles/Local%20Ollama/activate',
      'GET http://127.0.0.1:4120/api/presets',
      'POST http://127.0.0.1:4120/api/presets/import',
      'GET http://127.0.0.1:4120/api/sessions/sess%2F1/preset/export?format=st_chat',
      'POST http://127.0.0.1:4120/api/sessions/sess%2F1/control-room/apply-preset',
      'GET http://127.0.0.1:4120/api/personas',
      'POST http://127.0.0.1:4120/api/personas',
      'PUT http://127.0.0.1:4120/api/sessions/sess%2F1/persona',
      'GET http://127.0.0.1:4120/api/sessions/sess%2F1/characters?locationId=tavern&status=active&allegiance=guild&formGroup=lycan&presentOnly=true&includePlayer=false&query=aria',
      'GET http://127.0.0.1:4120/api/sessions/sess%2F1/characters/npc%2Felena',
      'POST http://127.0.0.1:4120/api/sessions/sess%2F1/characters',
      'POST http://127.0.0.1:4120/api/sessions/sess%2F1/combat/start',
    ]);

    expect(calls[3]?.body).toMatchObject({ name: 'Local Ollama', activate: true });
    expect(calls[8]?.body).toEqual({ sheetPresetId: 'dnd-adventurer' });
    expect(calls[14]?.body).toEqual({ characterId: 'npc_2', name: 'Marcus' });

    // Prototype pollution guards on IDs / profile names
    await expect(client.activateConnectionProfile('__proto__')).rejects.toBeInstanceOf(RefereeBridgeError);
    await expect(client.getCharacterDossier('sess-1', 'constructor')).rejects.toBeInstanceOf(
      RefereeBridgeError
    );
  });

  it('8. extractActiveSillyTavernPreset & extractActiveSillyTavernPersona normalize ST contexts and sync with live daemon', async () => {
    const { url } = await bootTestDaemon();
    const client = new RefereeBridgeClient({ baseUrl: url });

    // Chat Completion ST context (including oai_settings fallback and unsafe key filtering)
    const chatCtx = {
      name1: 'Lyra Thorne',
      powerUserSettings: {
        persona_description: 'Clockwork navigator from the upper spires.',
      },
      oai_settings: {
        preset_name: 'Storyteller Chat',
        temperature: 0.82,
        openai_max_tokens: 450,
        openai_max_context: 12000,
        top_p: 0.92,
        prompts: [
          { identifier: 'main', name: 'Main Prompt', role: 'system', content: 'Narrate vividly.' },
          { identifier: 'personaDescription', marker: true },
          { identifier: 'charDescription', marker: true },
          { identifier: 'chatHistory', marker: true },
        ],
        prompt_order: [
          {
            character_id: 100001,
            order: [
              { identifier: 'main', enabled: true },
              { identifier: 'personaDescription', enabled: true },
              { identifier: 'charDescription', enabled: true },
              { identifier: 'chatHistory', enabled: true },
            ],
          },
        ],
      },
    };

    const chatPreset = extractActiveSillyTavernPreset(chatCtx);
    expect(chatPreset).not.toBeNull();
    expect(chatPreset?.['name']).toBe('Storyteller Chat');
    expect(chatPreset?.['temperature']).toBe(0.82);
    expect(chatPreset?.['openai_max_tokens']).toBe(450);
    expect(chatPreset?.['openai_max_context']).toBe(12000);
    expect(Array.isArray(chatPreset?.['prompts'])).toBe(true);

    const persona = extractActiveSillyTavernPersona(chatCtx);
    expect(persona).toEqual({
      id: 'st-lyra-thorne',
      name: 'Lyra Thorne',
      description: 'Clockwork navigator from the upper spires.',
    });

    // Text Completion ST context fallback when Chat Completion settings are absent
    const textCtx = {
      textgenerationwebui_settings: {
        preset_name: 'Kobold Classic',
        temp: 0.65,
        amount_gen: 320,
        max_context: 8192,
        rep_pen: 1.12,
        story_string: '{{system}}\n{{persona}}\n{{description}}',
        input_sequence: '### Instruction:',
        output_sequence: '### Response:',
      },
    };
    const textPreset = extractActiveSillyTavernPreset(textCtx);
    expect(textPreset).not.toBeNull();
    expect(textPreset?.['name']).toBe('Kobold Classic');
    expect(textPreset?.['temp']).toBe(0.65);
    expect(textPreset?.['amount_gen']).toBe(320);
    expect(textPreset?.['rep_pen']).toBe(1.12);
    expect(textPreset?.['story_string']).toBe('{{system}}\n{{persona}}\n{{description}}');

    // Default persona fallback when fields are missing
    expect(extractActiveSillyTavernPersona({})).toEqual({
      id: 'st-player',
      name: 'Player',
      description: '',
    });
    expect(extractActiveSillyTavernPreset(null)).toBeNull();

    // Sync active ST preset & persona into a live daemon session
    const stCtx = createMockStContext() as MockStContext & Record<string, unknown>;
    stCtx['name1'] = chatCtx.name1;
    stCtx['powerUserSettings'] = chatCtx.powerUserSettings;
    stCtx['chatCompletionSettings'] = chatCtx.oai_settings;
    (globalThis as Record<string, unknown>)['SillyTavern'] = {
      getContext: () => stCtx,
    };

    await client.createSession({
      sessionId: 'st-sync-live',
      systemPackId: 'stock-slice-of-life',
      seed: 'sync-seed',
    });
    stCtx.chatMetadata['referee'] = { refereeSessionId: 'st-sync-live' };
    initialize({ client });

    const presetSyncRes = (await syncActiveSillyTavernPreset({ ctx: stCtx })) as {
      ok: boolean;
      format: string;
      generation: { temperature?: number; presetName?: string };
    };
    expect(presetSyncRes.ok).toBe(true);
    expect(presetSyncRes.format).toBe('st_chat_completion');
    expect(presetSyncRes.generation.temperature).toBe(0.82);

    const personaSyncRes = (await syncActiveSillyTavernPersona({
      ctx: stCtx,
      savePreset: true,
    })) as {
      ok: boolean;
      activePersona: { id: string; name: string; description: string };
    };
    expect(personaSyncRes.ok).toBe(true);
    expect(personaSyncRes.activePersona.name).toBe('Lyra Thorne');

    const compiled = (await client.compilePrompt('st-sync-live', {
      latestInput: 'I check the brass astrolabe.',
    })) as { ok: boolean; compiledPrompt: { messages: Array<{ content: string }> } };
    expect(compiled.ok).toBe(true);
    const joined = compiled.compiledPrompt.messages.map((m) => m.content).join('\n');
    expect(joined).toContain('[PERSONA]');
    expect(joined).toContain('Lyra Thorne');
    expect(joined).toContain('Clockwork navigator from the upper spires.');
  });

  it('9. hud-panel.js renders active combatant from initiativeOrder[turnIndex] and Setting Roster widget', () => {
    const html = renderHudPanel(
      {
        config: {
          packId: 'stock-tactical-rpg',
          packName: 'Tactical RPG',
          capabilities: { clocks: 'full_sim', combatMode: 'tactical', factions: false, beats: false },
          gameSystems: [],
        },
        combatState: {
          round: 2,
          turnIndex: 1,
          initiativeOrder: ['player', 'bandit_captain'],
        },
        state: {
          meta: { turn: 4 },
          clocks: { day: 1, slot: 'evening', turn: 4, storyTurn: 4, held: false },
          scene: {
            location: 'Old Bridge',
            mood: 'tense',
            presentCharacterIds: ['elena'],
            pinnedCharacterIds: ['elena'],
          },
          entities: {
            characters: {
              elena: { name: 'Elena <Vance>', status: 'active', presentInScene: true, mood: 'alert' },
              marcus: {
                name: 'Marcus',
                status: 'active',
                presentInScene: false,
                locationId: 'watchtower',
              },
              ghost: {
                name: 'Fallen <Scout>',
                status: 'dead',
                presentInScene: false,
                locationId: 'ravine',
              },
            },
            locations: {
              watchtower: { name: 'North Watchtower' },
              ravine: { name: '<Ravine>' },
            },
            factions: {},
            threats: {},
          },
        },
      },
      {
        settingRoster: {
          characters: [
            {
              id: 'elena',
              name: 'Elena <Vance>',
              status: 'active',
              presentInScene: true,
              isPinned: true,
              mood: 'alert',
              allegianceName: 'Archive',
            },
            {
              id: 'marcus',
              name: 'Marcus',
              status: 'active',
              presentInScene: false,
              isPinned: false,
              locationName: 'North Watchtower',
            },
            {
              id: 'ghost',
              name: 'Fallen <Scout>',
              status: 'dead',
              presentInScene: false,
              isPinned: false,
              locationName: '<Ravine>',
            },
          ],
        },
      }
    );

    // Active combatant computed from initiativeOrder[turnIndex]
    expect(html).toContain('data-widget="combat-panel"');
    expect(html).toContain('Round <strong>2</strong> · Active: <strong>bandit_captain</strong>');

    // Setting Roster widget renders present ([HERE] / [PINNED]) vs off-screen (@ location / status)
    expect(html).toContain('data-widget="setting-roster"');
    expect(html).toContain('Setting Roster (1 here · 2 off-screen)');
    expect(html).toContain('[HERE]');
    expect(html).toContain('[PINNED]');
    expect(html).toContain('Elena &lt;Vance&gt;');
    expect(html).toContain('@ North Watchtower');
    expect(html).toContain('@ &lt;Ravine&gt;');
    expect(html).toContain('[dead]');
    expect(html).not.toContain('<Vance>');
    expect(html).not.toContain('<Ravine>');

    // Also works when settingRoster is omitted (derived directly from state.entities.characters)
    const derivedHtml = renderHudStateHtml({
      config: { packId: 'stock-freeform', capabilities: {} },
      state: {
        meta: { turn: 1 },
        scene: { location: 'Square', mood: 'calm', presentCharacterIds: ['elena'], pinnedCharacterIds: [] },
        entities: {
          characters: {
            elena: { name: 'Elena', status: 'active', presentInScene: true },
            bryn: { name: 'Bryn', status: 'active', presentInScene: false, locationId: 'dock' },
          },
          locations: { dock: { name: 'Harbor Dock' } },
        },
      },
    });
    expect(derivedHtml).toContain('data-widget="setting-roster"');
    expect(derivedHtml).toContain('[HERE]');
    expect(derivedHtml).toContain('@ Harbor Dock');
  });

  it('10. control-room-modal.js exposes and triggers ST Preset sync, ST Persona sync, Sheet Preset, and Backend Connections updates', async () => {
    const { url } = await bootTestDaemon();
    const client = new RefereeBridgeClient({ baseUrl: url });

    await client.createSession({
      sessionId: 'st-modal-wave5',
      systemPackId: 'stock-tactical-rpg',
      seed: 'modal-seed',
    });

    const initialState = await client.getSessionState('st-modal-wave5');
    const initialConnections = await client.getConnections({ redact: true });

    const vm = buildControlRoomViewModel({
      sessionId: 'st-modal-wave5',
      sessionState: initialState,
      connections: initialConnections,
    });

    const html = renderControlRoomModalHtml(vm);
    expect(html).toContain('data-cr-action="sync-st-preset"');
    expect(html).toContain('data-cr-action="sync-st-persona"');
    expect(html).toContain('data-cr-input="sheet-preset"');
    expect(html).toContain('data-cr-action="apply-sheet-preset"');
    for (const presetId of SHEET_PRESET_IDS) {
      expect(html).toContain(presetId);
    }
    expect(html).toContain('data-cr-panel="connections"');
    expect(html).toContain('data-conn-input="provider"');
    expect(html).toContain('data-conn-input="baseUrl"');
    expect(html).toContain('data-conn-input="model"');
    expect(html).toContain('data-conn-input="temperature"');
    expect(html).toContain('data-conn-input="maxTokens"');
    expect(html).toContain('data-cr-action="update-connections"');
    expect(html).toContain('data-cr-action="save-connection-profile"');

    // Verify payload builders
    expect(buildApplySheetPresetPayload('superhero-dossier', 'pc')).toEqual({
      sheetPresetId: 'superhero-dossier',
      target: 'pc',
    });
    expect(
      buildConnectionsUpdatePayload({
        provider: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        model: 'claude-3-5-sonnet-latest',
        temperature: '0.6',
        maxTokens: '1024',
      })
    ).toEqual({
      defaultConnection: {
        provider: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        model: 'claude-3-5-sonnet-latest',
        temperature: 0.6,
        maxTokens: 1024,
      },
    });

    // Mock lightweight DOM container to test bindControlRoomModalDom end-to-end against live daemon
    const fieldValues: Record<string, string> = {
      '[data-cr-input="sheet-preset"]': 'dnd-adventurer',
      '[data-conn-input="provider"]': 'ollama',
      '[data-conn-input="baseUrl"]': 'http://127.0.0.1:11434',
      '[data-conn-input="model"]': 'mistral:7b',
      '[data-conn-input="temperature"]': '0.75',
      '[data-conn-input="maxTokens"]': '700',
      '[data-conn-input="profileName"]': 'LocalMistral',
    };
    const clickListeners: Array<(ev: unknown) => void> = [];
    const mockContainer = {
      innerHTML: '',
      querySelector(selector: string) {
        if (Object.hasOwn(fieldValues, selector)) {
          return { value: fieldValues[selector] };
        }
        return null;
      },
      querySelectorAll() {
        return [];
      },
      addEventListener(type: string, fn: (ev: unknown) => void) {
        if (type === 'click') clickListeners.push(fn);
      },
      removeEventListener(type: string, fn: (ev: unknown) => void) {
        if (type === 'click') {
          const idx = clickListeners.indexOf(fn);
          if (idx >= 0) clickListeners.splice(idx, 1);
        }
      },
    };

    const stCtx = {
      name1: 'Kaelen',
      powerUserSettings: { persona_description: 'Wandering cartographer.' },
      chatCompletionSettings: {
        preset_name: 'Modal Chat Preset',
        temperature: 0.9,
        openai_max_tokens: 600,
        openai_max_context: 8192,
      },
    };

    const completedActions: Array<{ action: string; res: unknown }> = [];
    let pendingWaiters: Array<() => void> = [];
    const waitForAction = (expectedAction: string) =>
      new Promise<void>((resolve) => {
        const check = () => {
          if (completedActions.some((a) => a.action === expectedAction)) {
            resolve();
          } else {
            pendingWaiters.push(check);
          }
        };
        check();
      });

    const baseHandlers = createControlRoomBridgeHandlers({
      client,
      sessionId: 'st-modal-wave5',
      ctx: stCtx,
    });
    const unbind = bindControlRoomModalDom(mockContainer as unknown as Record<string, unknown>, vm, {
      ...baseHandlers,
      onResult: (res: unknown, action: string) => {
        completedActions.push({ action, res });
        const waiters = pendingWaiters;
        pendingWaiters = [];
        for (const w of waiters) w();
      },
    });

    const triggerAction = (action: string) => {
      const event = {
        target: {
          closest(sel: string) {
            if (sel === '[data-cr-action]') {
              return { getAttribute: (attr: string) => (attr === 'data-cr-action' ? action : null) };
            }
            return null;
          },
        },
      };
      for (const listener of clickListeners) {
        listener(event);
      }
    };

    // 1) Sync ST Preset
    const p1 = waitForAction('sync-st-preset');
    triggerAction('sync-st-preset');
    await p1;

    // 2) Sync ST Persona
    const p2 = waitForAction('sync-st-persona');
    triggerAction('sync-st-persona');
    await p2;

    // 3) Apply Sheet Preset
    const p3 = waitForAction('apply-sheet-preset');
    triggerAction('apply-sheet-preset');
    await p3;

    // 4) Update Backend Connections & Save Profile
    const p4 = waitForAction('update-connections');
    triggerAction('update-connections');
    await p4;

    const p5 = waitForAction('save-connection-profile');
    triggerAction('save-connection-profile');
    await p5;

    unbind();
    expect(clickListeners).toHaveLength(0);

    // Verify all mutations landed in live daemon
    const updatedState = (await client.getSessionState('st-modal-wave5')) as {
      config: {
        generation: { presetName?: string; temperature?: number };
        pcCoreSections: Array<{ id: string }>;
      };
      state: { player: { name: string } };
    };
    expect(updatedState.config.generation.presetName).toBe('Modal Chat Preset');
    expect(updatedState.config.generation.temperature).toBe(0.9);
    expect(updatedState.state.player.name).toBe('Kaelen');
    expect(updatedState.config.pcCoreSections.some((s) => s.id === 'sec_combat_profile')).toBe(
      true
    );

    const connSnap = (await client.getConnections()) as {
      defaultConnection: { provider: string; baseUrl: string; model: string; temperature: number; maxTokens: number };
      activeProfile: string | null;
      profiles: Record<string, unknown>;
    };
    expect(connSnap.defaultConnection.provider).toBe('ollama');
    expect(connSnap.defaultConnection.baseUrl).toBe('http://127.0.0.1:11434');
    expect(connSnap.defaultConnection.model).toBe('mistral:7b');
    expect(connSnap.defaultConnection.temperature).toBe(0.75);
    expect(connSnap.defaultConnection.maxTokens).toBe(700);
    expect(connSnap.activeProfile).toBe('LocalMistral');
    expect(Object.hasOwn(connSnap.profiles, 'LocalMistral')).toBe(true);

    // Live daemon Wave 5 endpoints round-trip for characters & combat start
    await client.upsertCharacter('st-modal-wave5', {
      characterId: 'guard_1',
      name: 'Captain Rowan',
      presentInScene: true,
      mood: 'vigilant',
    });
    const rosterRes = (await client.getSettingCharacters('st-modal-wave5', {
      includePlayer: false,
      query: 'Rowan',
    })) as {
      ok: boolean;
      characters: Array<{ id: string; name: string }>;
    };
    expect(rosterRes.ok).toBe(true);
    expect(rosterRes.characters.some((c) => c.id === 'guard_1')).toBe(true);

    const dossierRes = (await client.getCharacterDossier('st-modal-wave5', 'guard_1')) as {
      ok: boolean;
      dossier: { summary: { name: string } };
    };
    expect(dossierRes.ok).toBe(true);
    expect(dossierRes.dossier.summary.name).toBe('Captain Rowan');

    const combatRes = (await client.startCombat('st-modal-wave5', {
      participants: [
        { id: 'player', name: 'Kaelen', team: 'ally', hp: 20, maxHp: 20 },
        { id: 'guard_1', name: 'Captain Rowan', team: 'enemy', hp: 18, maxHp: 18 },
      ],
    })) as { ok: boolean; combatState: { initiativeOrder: string[]; turnIndex: number } };
    expect(combatRes.ok).toBe(true);
    expect(combatRes.combatState.initiativeOrder.length).toBe(2);

    const exportedPreset = (await client.exportSessionPreset('st-modal-wave5', 'st_chat')) as {
      ok: boolean;
      format: string;
      preset: { temperature?: number };
    };
    expect(exportedPreset.ok).toBe(true);
    expect(exportedPreset.format).toBe('st_chat');
    expect(exportedPreset.preset.temperature).toBe(0.9);
  });
});
