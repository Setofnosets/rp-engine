import {
  RefereeBridgeClient,
  RefereeBridgeError,
  getSafeOwn,
  isSafePropertyKey,
  setSafeOwn,
} from './bridge-client.js';
import { DirectorBarState } from './director-bar.js';
import { bindHudPanelDom, renderHudPanel, renderHudStateHtml } from './hud-panel.js';
import {
  bindControlRoomModalDom,
  buildControlRoomViewModel,
  extractActiveSillyTavernPersona,
  extractActiveSillyTavernPreset,
  renderControlRoomModalHtml,
} from './control-room-modal.js';

export const REFEREE_CONTEXT_TAG = '[REFEREE_CONTEXT]';

export const DEFAULT_EVENT_NAMES = Object.freeze({
  MESSAGE_RECEIVED: 'MESSAGE_RECEIVED',
  CHARACTER_MESSAGE_RENDERED: 'CHARACTER_MESSAGE_RENDERED',
  MESSAGE_SWIPED: 'MESSAGE_SWIPED',
  MESSAGE_EDITED: 'MESSAGE_EDITED',
  CHAT_CHANGED: 'CHAT_CHANGED',
});

/**
 * Safely retrieve the active SillyTavern context if present.
 * @returns {any | null}
 */
export function getSillyTavernContext() {
  const st = globalThis.SillyTavern;
  if (st && typeof st.getContext === 'function') {
    return st.getContext();
  }
  return null;
}

/**
 * Determine if a SillyTavern chat message is an injected `[REFEREE_CONTEXT]` block.
 * @param {any} msg
 * @returns {boolean}
 */
export function isRefereeContextMessage(msg) {
  if (!msg || typeof msg !== 'object') {
    return false;
  }
  if (msg.extra && typeof msg.extra === 'object' && msg.extra.referee_context === true) {
    return true;
  }
  if (typeof msg.mes === 'string' && msg.mes.includes(REFEREE_CONTEXT_TAG)) {
    return true;
  }
  if (typeof msg.content === 'string' && msg.content.includes(REFEREE_CONTEXT_TAG)) {
    return true;
  }
  return false;
}

function getMessageText(msg) {
  if (!msg || typeof msg !== 'object') {
    return '';
  }
  if (typeof msg.mes === 'string') return msg.mes;
  if (typeof msg.content === 'string') return msg.content;
  return '';
}

function isUserMessage(msg) {
  if (!msg || typeof msg !== 'object') return false;
  return msg.is_user === true || msg.role === 'user';
}

function isAssistantMessage(msg) {
  if (!msg || typeof msg !== 'object') return false;
  if (isRefereeContextMessage(msg)) return false;
  if (isUserMessage(msg)) return false;
  if (msg.is_system === true || msg.role === 'system') return false;
  return true;
}

function readMetadataSessionId(ctx) {
  const ref = ctx?.chatMetadata?.referee;
  if (!ref || typeof ref !== 'object') {
    return null;
  }
  const raw =
    (typeof ref.refereeSessionId === 'string' && ref.refereeSessionId.trim()) ||
    (typeof ref.sessionId === 'string' && ref.sessionId.trim()) ||
    null;
  if (raw && isSafePropertyKey(raw)) {
    return raw;
  }
  return null;
}

function writeMetadataSessionId(ctx, sessionId) {
  if (!ctx || typeof ctx !== 'object') return;
  if (!ctx.chatMetadata || typeof ctx.chatMetadata !== 'object') {
    ctx.chatMetadata = {};
  }
  // Store ONLY { refereeSessionId } in chatMetadata.referee
  ctx.chatMetadata.referee = { refereeSessionId: sessionId };
  if (typeof ctx.saveMetadataDebounced === 'function') {
    ctx.saveMetadataDebounced();
  } else if (typeof ctx.saveMetadata === 'function') {
    ctx.saveMetadata();
  }
}

/**
 * Strip all prior `[REFEREE_CONTEXT]` messages from `chat` in place.
 * @param {any[]} chat
 */
export function stripRefereeContextMessages(chat) {
  if (!Array.isArray(chat)) {
    return;
  }
  for (let i = chat.length - 1; i >= 0; i -= 1) {
    if (isRefereeContextMessage(chat[i])) {
      chat.splice(i, 1);
    }
  }
}

/**
 * Build recentTranscript and latestInput from a stripped SillyTavern `chat` array.
 * @param {any[]} chat
 */
function extractPromptTranscript(chat) {
  if (!Array.isArray(chat) || chat.length === 0) {
    return { latestInput: '', recentTranscript: [] };
  }

  let latestInput = '';
  let latestUserIdx = -1;
  for (let i = chat.length - 1; i >= 0; i -= 1) {
    if (isUserMessage(chat[i])) {
      latestUserIdx = i;
      latestInput = getMessageText(chat[i]);
      break;
    }
  }

  const recentTranscript = [];
  for (let i = 0; i < chat.length; i += 1) {
    if (i === latestUserIdx) continue;
    const msg = chat[i];
    if (!msg || typeof msg !== 'object' || isRefereeContextMessage(msg)) continue;
    const content = getMessageText(msg);
    if (!content) continue;
    const role = isUserMessage(msg)
      ? 'user'
      : msg.is_system === true || msg.role === 'system'
        ? 'system'
        : 'assistant';
    recentTranscript.push({ role, content });
  }

  return { latestInput, recentTranscript };
}

class BridgeRuntime {
  constructor() {
    this.client = new RefereeBridgeClient();
    this.directorBar = new DirectorBarState();
    this.activeSessionId = null;
    this.sessionOptions = {};
    this.onStateUpdated = null;
    this.hudContainer = null;
    this.unsubscribeFns = [];
    this.messageIdMap = new Map();
    this.lastNarratedKeys = new Map();
    this.pendingCreatePromise = null;
    this.initialized = false;
  }

  resetEphemeralMaps() {
    this.messageIdMap.clear();
    this.lastNarratedKeys.clear();
  }

  getMessageMap(sessionId) {
    let map = this.messageIdMap.get(sessionId);
    if (!map) {
      map = new Map();
      this.messageIdMap.set(sessionId, map);
    }
    return map;
  }

  async ensureSession(ctx) {
    const metaId = readMetadataSessionId(ctx);
    if (metaId) {
      this.activeSessionId = metaId;
      writeMetadataSessionId(ctx, metaId);
      return metaId;
    }

    if (this.activeSessionId) {
      writeMetadataSessionId(ctx, this.activeSessionId);
      return this.activeSessionId;
    }

    if (this.pendingCreatePromise) {
      return this.pendingCreatePromise;
    }

    this.pendingCreatePromise = (async () => {
      const created = await this.client.createSession(this.sessionOptions);
      const sessionId = created.sessionId;
      this.activeSessionId = sessionId;
      writeMetadataSessionId(ctx, sessionId);
      return sessionId;
    })();

    try {
      return await this.pendingCreatePromise;
    } finally {
      this.pendingCreatePromise = null;
    }
  }

  async notifyStateUpdated(sessionId) {
    if (!sessionId) return null;
    if (typeof this.onStateUpdated !== 'function' && !this.hudContainer) {
      return null;
    }
    const statePayload = await this.client.getSessionState(sessionId);
    if (this.hudContainer) {
      bindHudPanelDom(this.hudContainer, statePayload, {
        onAcceptAll: () => void this.client.confirmPatch(sessionId, 'accept_all').then(() => this.notifyStateUpdated(sessionId)),
        onRejectAll: () => void this.client.confirmPatch(sessionId, 'reject_all').then(() => this.notifyStateUpdated(sessionId)),
        onAcceptIndex: (idx) =>
          void this.client
            .confirmPatch(sessionId, { acceptIndices: [idx] })
            .then(() => this.notifyStateUpdated(sessionId)),
      });
    }
    if (typeof this.onStateUpdated === 'function') {
      this.onStateUpdated(statePayload);
    }
    return statePayload;
  }

  async resolveAssistantMessageId(sessionId, messageIndex, ctx) {
    const msgMap = this.getMessageMap(sessionId);
    const cached = msgMap.get(messageIndex);
    if (typeof cached === 'string' && cached.length > 0) {
      return { assistantMessageId: cached, sessionState: null };
    }

    const msg = Array.isArray(ctx?.chat) ? ctx.chat[messageIndex] : null;
    if (msg?.extra && typeof msg.extra.refereeMessageId === 'string') {
      return { assistantMessageId: msg.extra.refereeMessageId, sessionState: null };
    }

    const sessionState = await this.client.getSessionState(sessionId);
    const swipeTree = sessionState?.swipeTree;
    if (swipeTree && typeof swipeTree === 'object') {
      // Match the Nth assistant message in ST chat against assistant nodes in linear swipeTree order
      const assistantNodes = [];
      let cursor = swipeTree.activeLeafMessageId;
      const visited = new Set();
      while (typeof cursor === 'string' && !visited.has(cursor)) {
        visited.add(cursor);
        const node = getSafeOwn(swipeTree.nodes, cursor);
        if (!node || typeof node !== 'object') break;
        if (node.role === 'assistant') {
          assistantNodes.push(node.messageId);
        }
        cursor = node.parentMessageId;
      }
      assistantNodes.reverse();

      if (Array.isArray(ctx?.chat)) {
        let assistantOrdinal = -1;
        for (let i = 0; i <= messageIndex && i < ctx.chat.length; i += 1) {
          if (isAssistantMessage(ctx.chat[i])) {
            assistantOrdinal += 1;
          }
        }
        if (assistantOrdinal >= 0 && assistantOrdinal < assistantNodes.length) {
          const matchedId = assistantNodes[assistantOrdinal];
          msgMap.set(messageIndex, matchedId);
          return { assistantMessageId: matchedId, sessionState };
        }
      }

      if (typeof swipeTree.activeLeafMessageId === 'string') {
        const leafNode = getSafeOwn(swipeTree.nodes, swipeTree.activeLeafMessageId);
        if (leafNode && leafNode.role === 'assistant') {
          return { assistantMessageId: swipeTree.activeLeafMessageId, sessionState };
        }
      }
    }

    return { assistantMessageId: null, sessionState };
  }
}

const runtime = new BridgeRuntime();

/**
 * Return the active bridge runtime (for UI controllers and testing).
 * @returns {BridgeRuntime}
 */
export function getBridgeRuntime() {
  return runtime;
}

/**
 * SillyTavern `generate_interceptor` entrypoint.
 * Strips prior `[REFEREE_CONTEXT]` messages from `chat`, calls `POST /api/sessions/:id/compile-prompt`,
 * and splices `[STATE]` / `[COMBAT_OUTCOME]` / `[PLOT]` / `[WORLD]` cleanly into `chat`.
 *
 * @param {any[]} chat
 * @param {number} [_contextSize]
 * @param {(reason?: unknown) => void} [_abort]
 * @param {string} [_type]
 */
export async function refereeGenerateInterceptor(chat, _contextSize, _abort, _type) {
  if (!Array.isArray(chat)) {
    return;
  }

  stripRefereeContextMessages(chat);

  const ctx = getSillyTavernContext();
  const sessionId = await runtime.ensureSession(ctx);
  const { latestInput, recentTranscript } = extractPromptTranscript(chat);

  const steering = runtime.directorBar.buildDirectorSteeringPayload();
  const hasSteering = Object.keys(steering).length > 0;

  const compilePayload = {
    latestInput,
    recentTranscript,
    ...(hasSteering ? { directorSteering: steering } : {}),
  };

  const compiled = await runtime.client.compilePrompt(sessionId, compilePayload);
  const sections = compiled?.sections ?? {};
  const orderedBlocks = [
    sections.state,
    sections.combatOutcome,
    sections.plot,
    sections.world,
  ]
    .filter((s) => typeof s === 'string' && s.trim().length > 0)
    .map((s) => s.trim());

  if (orderedBlocks.length === 0) {
    return compiled;
  }

  const content = `${REFEREE_CONTEXT_TAG}\n${orderedBlocks.join('\n\n')}`;
  const injectedMsg = {
    name: 'Referee',
    is_user: false,
    is_system: true,
    role: 'system',
    mes: content,
    content,
    extra: { referee_context: true },
  };

  if (chat.length > 0 && isUserMessage(chat[chat.length - 1])) {
    chat.splice(chat.length - 1, 0, injectedMsg);
  } else {
    chat.push(injectedMsg);
  }

  return compiled;
}

globalThis.refereeGenerateInterceptor = refereeGenerateInterceptor;

async function handleAssistantRendered(arg) {
  const ctx = getSillyTavernContext();
  if (!ctx || !Array.isArray(ctx.chat)) {
    return null;
  }

  const messageIndex =
    typeof arg === 'number'
      ? arg
      : typeof arg?.messageIndex === 'number'
        ? arg.messageIndex
        : ctx.chat.length - 1;

  if (messageIndex < 0 || messageIndex >= ctx.chat.length) {
    return null;
  }

  const assistantMsg = ctx.chat[messageIndex];
  if (!isAssistantMessage(assistantMsg)) {
    return null;
  }

  const narratorText = getMessageText(assistantMsg);
  const swipeId = typeof assistantMsg.swipe_id === 'number' ? assistantMsg.swipe_id : 0;

  let userText = '';
  for (let i = messageIndex - 1; i >= 0; i -= 1) {
    if (isUserMessage(ctx.chat[i])) {
      userText = getMessageText(ctx.chat[i]);
      break;
    }
  }

  const sessionId = await runtime.ensureSession(ctx);
  const dedupKey = `${sessionId}:${messageIndex}:${swipeId}:${narratorText}`;
  if (runtime.lastNarratedKeys.get(messageIndex) === dedupKey) {
    return null;
  }
  runtime.lastNarratedKeys.set(messageIndex, dedupKey);

  const steering = runtime.directorBar.buildDirectorSteeringPayload();
  const hasSteering = Object.keys(steering).length > 0;

  const result = await runtime.client.postNarrate(sessionId, {
    userText,
    narratorText,
    ...(hasSteering ? { directorSteering: steering } : {}),
  });

  if (typeof result?.assistantMessageId === 'string') {
    runtime.getMessageMap(sessionId).set(messageIndex, result.assistantMessageId);
  }

  runtime.directorBar.resetTurnOverrides();
  await runtime.notifyStateUpdated(sessionId);
  return result;
}

async function handleMessageSwiped(arg, defaultAction) {
  const ctx = getSillyTavernContext();
  if (!ctx || !Array.isArray(ctx.chat)) {
    return null;
  }

  const messageIndex =
    typeof arg === 'number'
      ? arg
      : typeof arg?.messageIndex === 'number'
        ? arg.messageIndex
        : ctx.chat.length - 1;

  if (messageIndex < 0 || messageIndex >= ctx.chat.length) {
    return null;
  }

  const msg = ctx.chat[messageIndex];
  if (!isAssistantMessage(msg)) {
    return null;
  }

  const sessionId = await runtime.ensureSession(ctx);
  const resolved = await runtime.resolveAssistantMessageId(sessionId, messageIndex, ctx);
  const assistantMessageId = resolved.assistantMessageId;
  if (!assistantMessageId) {
    return null;
  }

  const sessionState = resolved.sessionState ?? (await runtime.client.getSessionState(sessionId));
  const node = getSafeOwn(sessionState?.swipeTree?.nodes, assistantMessageId);
  const existingSwipes = Array.isArray(node?.swipes) ? node.swipes : [];

  const requestedSwipeIndex =
    typeof arg?.swipeIndex === 'number'
      ? arg.swipeIndex
      : typeof msg.swipe_id === 'number'
        ? msg.swipe_id
        : 0;

  let action = defaultAction;
  if (arg && typeof arg === 'object' && (arg.action === 'switch' || arg.action === 'regenerate')) {
    action = arg.action;
  } else if (!action) {
    const existsInDaemon = existingSwipes.some((s) => s?.swipeIndex === requestedSwipeIndex);
    action = existsInDaemon ? 'switch' : 'regenerate';
  }

  if (action === 'switch') {
    const res = await runtime.client.swipe(sessionId, {
      action: 'switch',
      assistantMessageId,
      swipeIndex: requestedSwipeIndex,
    });
    await runtime.notifyStateUpdated(sessionId);
    return res;
  }

  const steering = runtime.directorBar.buildDirectorSteeringPayload();
  const hasSteering = Object.keys(steering).length > 0;
  const res = await runtime.client.swipe(sessionId, {
    action: 'regenerate',
    assistantMessageId,
    ...(hasSteering ? { directorSteering: steering } : {}),
  });
  runtime.directorBar.resetTurnOverrides();
  await runtime.notifyStateUpdated(sessionId);
  return res;
}

async function handleChatChanged() {
  const ctx = getSillyTavernContext();
  runtime.resetEphemeralMaps();
  const metaSessionId = readMetadataSessionId(ctx);
  runtime.activeSessionId = metaSessionId;
  if (metaSessionId) {
    writeMetadataSessionId(ctx, metaSessionId);
    await runtime.notifyStateUpdated(metaSessionId);
  }
  return metaSessionId;
}

function subscribeEvent(eventSource, eventName, listener) {
  if (!eventSource || typeof eventSource.on !== 'function' || !eventName) {
    return () => {};
  }
  eventSource.on(eventName, listener);
  return () => {
    if (typeof eventSource.off === 'function') {
      eventSource.off(eventName, listener);
    } else if (typeof eventSource.removeListener === 'function') {
      eventSource.removeListener(eventName, listener);
    }
  };
}

/**
 * Unregister all SillyTavern event hooks and reset active bridge listeners.
 */
export function dispose() {
  while (runtime.unsubscribeFns.length > 0) {
    const unsub = runtime.unsubscribeFns.pop();
    if (typeof unsub === 'function') {
      try {
        unsub();
      } catch {
        // Ignore teardown errors when host context is already destroyed
      }
    }
  }
  runtime.resetEphemeralMaps();
  runtime.activeSessionId = null;
  runtime.hudContainer = null;
  runtime.onStateUpdated = null;
  runtime.initialized = false;
}

/**
 * Initialize the SillyTavern bridge extension hooks (`MESSAGE_RECEIVED`,
 * `CHARACTER_MESSAGE_RENDERED`, `MESSAGE_SWIPED`, `MESSAGE_EDITED`, `CHAT_CHANGED`).
 * Safe to invoke in headless Node tests with mocked `globalThis.SillyTavern.getContext()`.
 *
 * @param {{
 *   baseUrl?: string;
 *   fetchImpl?: typeof globalThis.fetch;
 *   client?: RefereeBridgeClient;
 *   directorBar?: DirectorBarState;
 *   sessionOptions?: Record<string, unknown>;
 *   hudContainer?: HTMLElement | null;
 *   onStateUpdated?: (statePayload: any) => void;
 * }} [options]
 */
export function initialize(options = {}) {
  dispose();

  runtime.client =
    options.client ??
    new RefereeBridgeClient({
      ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    });
  runtime.directorBar = options.directorBar ?? new DirectorBarState();
  runtime.sessionOptions = options.sessionOptions ? { ...options.sessionOptions } : {};
  runtime.hudContainer = options.hudContainer ?? null;
  runtime.onStateUpdated = typeof options.onStateUpdated === 'function' ? options.onStateUpdated : null;

  globalThis.refereeGenerateInterceptor = refereeGenerateInterceptor;

  const ctx = getSillyTavernContext();
  if (ctx) {
    const metaSessionId = readMetadataSessionId(ctx);
    if (metaSessionId) {
      runtime.activeSessionId = metaSessionId;
      writeMetadataSessionId(ctx, metaSessionId);
    }

    const events = ctx.event_types ?? DEFAULT_EVENT_NAMES;
    const eventSource = ctx.eventSource;

    const msgReceivedEv = events.MESSAGE_RECEIVED ?? DEFAULT_EVENT_NAMES.MESSAGE_RECEIVED;
    const charRenderedEv =
      events.CHARACTER_MESSAGE_RENDERED ?? DEFAULT_EVENT_NAMES.CHARACTER_MESSAGE_RENDERED;
    const msgSwipedEv = events.MESSAGE_SWIPED ?? DEFAULT_EVENT_NAMES.MESSAGE_SWIPED;
    const msgEditedEv = events.MESSAGE_EDITED ?? DEFAULT_EVENT_NAMES.MESSAGE_EDITED;
    const chatChangedEv = events.CHAT_CHANGED ?? DEFAULT_EVENT_NAMES.CHAT_CHANGED;

    runtime.unsubscribeFns.push(
      subscribeEvent(eventSource, msgReceivedEv, (arg) => handleAssistantRendered(arg)),
      subscribeEvent(eventSource, charRenderedEv, (arg) => handleAssistantRendered(arg)),
      subscribeEvent(eventSource, msgSwipedEv, (arg) => handleMessageSwiped(arg)),
      subscribeEvent(eventSource, msgEditedEv, (arg) => handleMessageSwiped(arg, 'regenerate')),
      subscribeEvent(eventSource, chatChangedEv, () => handleChatChanged())
    );
  }

  runtime.initialized = true;
  return runtime;
}

/**
 * Extract the active SillyTavern preset from `ctx` (or `getSillyTavernContext()`) and import/apply
 * it into the active Referee session.
 *
 * @param {{
 *   ctx?: any;
 *   client?: RefereeBridgeClient;
 *   sessionId?: string | null;
 *   presetName?: string;
 * }} [options]
 */
export async function syncActiveSillyTavernPreset(options = {}) {
  const ctx = options.ctx ?? getSillyTavernContext();
  const client = options.client ?? runtime.client;
  const preset = extractActiveSillyTavernPreset(ctx);
  if (!preset) {
    throw new RefereeBridgeError('No active SillyTavern preset settings found in context', {
      status: 0,
    });
  }

  const sessionId =
    typeof options.sessionId === 'string' && options.sessionId.trim().length > 0
      ? options.sessionId.trim()
      : ctx
        ? await runtime.ensureSession(ctx)
        : runtime.activeSessionId;

  const payload = {
    preset,
    ...(sessionId ? { sessionId } : {}),
    ...(typeof options.presetName === 'string' && options.presetName.trim().length > 0
      ? { name: options.presetName.trim() }
      : {}),
  };

  const result = await client.importPreset(payload);
  if (sessionId && client === runtime.client) {
    await runtime.notifyStateUpdated(sessionId);
  }
  return result;
}

/**
 * Extract the active SillyTavern persona from `ctx` (or `getSillyTavernContext()`) and apply
 * it into the active Referee session.
 *
 * @param {{
 *   ctx?: any;
 *   client?: RefereeBridgeClient;
 *   sessionId?: string | null;
 *   savePreset?: boolean;
 * }} [options]
 */
export async function syncActiveSillyTavernPersona(options = {}) {
  const ctx = options.ctx ?? getSillyTavernContext();
  const client = options.client ?? runtime.client;
  const persona = extractActiveSillyTavernPersona(ctx);

  const sessionId =
    typeof options.sessionId === 'string' && options.sessionId.trim().length > 0
      ? options.sessionId.trim()
      : ctx
        ? await runtime.ensureSession(ctx)
        : runtime.activeSessionId;

  if (!sessionId) {
    throw new RefereeBridgeError('No active Referee sessionId to apply SillyTavern persona to', {
      status: 0,
    });
  }

  if (options.savePreset === true) {
    await client.savePersona(persona);
  }

  const result = await client.applySessionPersona(sessionId, { persona });
  if (client === runtime.client) {
    await runtime.notifyStateUpdated(sessionId);
  }
  return result;
}

/**
 * Create Control Room modal DOM handlers wired to the active bridge client & session.
 *
 * @param {{
 *   client?: RefereeBridgeClient;
 *   sessionId?: string | null;
 *   ctx?: any;
 *   onUpdated?: (result: unknown, action: string) => void;
 *   onError?: (err: unknown, action: string) => void;
 * }} [options]
 */
export function createControlRoomBridgeHandlers(options = {}) {
  const client = options.client ?? runtime.client;
  const resolveSession = async () => {
    if (typeof options.sessionId === 'string' && options.sessionId.trim().length > 0) {
      return options.sessionId.trim();
    }
    const ctx = options.ctx ?? getSillyTavernContext();
    if (ctx) {
      return runtime.ensureSession(ctx);
    }
    return runtime.activeSessionId;
  };
  const notifyIfRuntime = async (sessionId, res, action) => {
    if (sessionId && client === runtime.client) {
      await runtime.notifyStateUpdated(sessionId);
    }
    if (typeof options.onUpdated === 'function') {
      options.onUpdated(res, action);
    }
    return res;
  };

  return {
    client,
    sessionId: options.sessionId ?? runtime.activeSessionId,
    stContext: options.ctx,
    onError: options.onError,
    onApplyPack: async (payload) => {
      const sid = await resolveSession();
      if (!sid) return null;
      const res = await client.patchControlRoom(sid, payload);
      return notifyIfRuntime(sid, res, 'apply-pack');
    },
    onToggleModule: async (payload) => {
      const sid = await resolveSession();
      if (!sid) return null;
      const res = await client.patchControlRoom(sid, payload);
      return notifyIfRuntime(sid, res, 'toggle-module');
    },
    onWizardGenerate: async (req) => {
      const res = await client.generateWizardSystem(req);
      if (typeof options.onUpdated === 'function') {
        options.onUpdated(res, 'wizard-generate');
      }
      return res;
    },
    onWizardApply: async (payload) => {
      const sid = await resolveSession();
      if (!sid) return null;
      const res = await client.patchControlRoom(sid, payload);
      return notifyIfRuntime(sid, res, 'wizard-apply');
    },
    onSyncStPreset: async ({ ctx: modalCtx, sessionId: modalSid }) => {
      const sid = modalSid ?? (await resolveSession());
      return syncActiveSillyTavernPreset({
        ctx: modalCtx ?? options.ctx,
        client,
        sessionId: sid,
      });
    },
    onSyncStPersona: async ({ ctx: modalCtx, sessionId: modalSid }) => {
      const sid = modalSid ?? (await resolveSession());
      return syncActiveSillyTavernPersona({
        ctx: modalCtx ?? options.ctx,
        client,
        sessionId: sid,
      });
    },
    onApplySheetPreset: async (payload) => {
      const sid = await resolveSession();
      if (!sid) return null;
      const res = await client.applyPreset(sid, payload);
      return notifyIfRuntime(sid, res, 'apply-sheet-preset');
    },
    onUpdateConnections: async (payload) => {
      const res = await client.updateConnections(payload);
      if (typeof options.onUpdated === 'function') {
        options.onUpdated(res, 'update-connections');
      }
      return res;
    },
    onSaveConnectionProfile: async (name, payload) => {
      const res = await client.saveConnectionProfile(name, { ...payload, activate: true });
      if (typeof options.onUpdated === 'function') {
        options.onUpdated(res, 'save-connection-profile');
      }
      return res;
    },
    onActivateConnectionProfile: async (name) => {
      const res = await client.activateConnectionProfile(name);
      if (typeof options.onUpdated === 'function') {
        options.onUpdated(res, 'activate-connection-profile');
      }
      return res;
    },
  };
}

export {
  RefereeBridgeClient,
  RefereeBridgeError,
  DirectorBarState,
  renderHudStateHtml,
  renderHudPanel,
  bindHudPanelDom,
  buildControlRoomViewModel,
  renderControlRoomModalHtml,
  bindControlRoomModalDom,
  extractActiveSillyTavernPreset,
  extractActiveSillyTavernPersona,
};

// Auto-initialize only in real browser DOM contexts where SillyTavern is already loaded
if (
  typeof globalThis.document !== 'undefined' &&
  typeof globalThis.SillyTavern?.getContext === 'function'
) {
  initialize();
}
