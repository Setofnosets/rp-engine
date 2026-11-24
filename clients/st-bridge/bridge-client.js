/**
 * Stateless HTTP client SDK for the Referee Engine localhost daemon (`PR-6.1` API).
 * Performs zero localStorage persistence or client-side WAL caching.
 */

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Check whether a property key is safe against prototype pollution.
 * @param {string} key
 * @returns {boolean}
 */
export function isSafePropertyKey(key) {
  return typeof key === 'string' && key.length > 0 && !FORBIDDEN_KEYS.has(key);
}

/**
 * Read an own property safely without prototype chain lookup.
 * @param {Record<string, unknown> | null | undefined} obj
 * @param {string} key
 * @returns {unknown}
 */
export function getSafeOwn(obj, key) {
  if (obj === null || obj === undefined || typeof obj !== 'object' || !isSafePropertyKey(key)) {
    return undefined;
  }
  if (!Object.hasOwn(obj, key)) {
    return undefined;
  }
  return Object.getOwnPropertyDescriptor(obj, key)?.value;
}

/**
 * Define an own enumerable data property safely.
 * @param {Record<string, unknown>} obj
 * @param {string} key
 * @param {unknown} value
 */
export function setSafeOwn(obj, key, value) {
  if (!isSafePropertyKey(key)) {
    return;
  }
  Object.defineProperty(obj, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/**
 * Error raised when a Referee Daemon HTTP request fails or returns `ok: false`.
 */
export class RefereeBridgeError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number; errors?: unknown[]; payload?: unknown }} [details]
   */
  constructor(message, details = {}) {
    super(message);
    this.name = 'RefereeBridgeError';
    this.status = details.status ?? 0;
    this.errors = Array.isArray(details.errors) ? details.errors : [];
    this.payload = details.payload;
  }
}

function assertValidSessionId(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.trim().length === 0 || !isSafePropertyKey(sessionId.trim())) {
    throw new RefereeBridgeError('sessionId must be a safe non-empty string', { status: 0 });
  }
  return sessionId.trim();
}

function normalizeBaseUrl(rawUrl) {
  const url = typeof rawUrl === 'string' && rawUrl.trim().length > 0
    ? rawUrl.trim()
    : 'http://127.0.0.1:4120';
  return url.replace(/\/+$/, '');
}

/**
 * HTTP client communicating directly with the Referee Daemon.
 */
export class RefereeBridgeClient {
  /**
   * @param {{ baseUrl?: string; fetchImpl?: typeof globalThis.fetch }} [options]
   */
  constructor(options = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  /**
   * Execute an HTTP JSON request against the daemon.
   * @param {string} method
   * @param {string} path
   * @param {unknown} [body]
   * @returns {Promise<any>}
   */
  async _request(method, path, body) {
    if (typeof this.fetchImpl !== 'function') {
      throw new RefereeBridgeError('No fetch implementation available for RefereeBridgeClient');
    }

    const url = `${this.baseUrl}${path}`;
    const init = {
      method,
      headers: /** @type {Record<string, string>} */ ({}),
    };

    if (body !== undefined) {
      setSafeOwn(init.headers, 'Content-Type', 'application/json');
      init.body = JSON.stringify(body);
    }

    const response = await this.fetchImpl.call(globalThis, url, init);
    const rawText = await response.text();

    /** @type {any} */
    let parsed = null;
    if (rawText.trim().length > 0) {
      try {
        parsed = JSON.parse(rawText);
      } catch {
        throw new RefereeBridgeError(
          `Referee daemon returned non-JSON response (${response.status})`,
          { status: response.status, payload: rawText }
        );
      }
    }

    if (!response.ok || (parsed !== null && typeof parsed === 'object' && parsed.ok === false)) {
      const errors = parsed && Array.isArray(parsed.errors) ? parsed.errors : [];
      const firstMsg =
        errors.length > 0 && typeof errors[0]?.message === 'string'
          ? errors[0].message
          : `HTTP ${response.status} from ${method} ${path}`;
      throw new RefereeBridgeError(firstMsg, {
        status: response.status,
        errors,
        payload: parsed,
      });
    }

    return parsed;
  }

  /**
   * GET /api/health
   */
  async health() {
    return this._request('GET', '/api/health');
  }

  /**
   * GET /api/system-packs
   */
  async listSystemPacks() {
    return this._request('GET', '/api/system-packs');
  }

  /**
   * POST /api/system-packs
   * @param {Record<string, unknown>} systemPack
   */
  async registerSystemPack(systemPack) {
    return this._request('POST', '/api/system-packs', systemPack);
  }

  /**
   * GET /api/cartridges
   */
  async listCartridges() {
    return this._request('GET', '/api/cartridges');
  }

  /**
   * POST /api/cartridges/import
   * @param {Record<string, unknown> | string} payload
   */
  async importCartridge(payload) {
    return this._request('POST', '/api/cartridges/import', payload);
  }

  /**
   * POST /api/sessions
   * @param {Record<string, unknown>} [params]
   */
  async createSession(params = {}) {
    return this._request('POST', '/api/sessions', params);
  }

  /**
   * GET /api/sessions/:id/state
   * @param {string} sessionId
   */
  async getSessionState(sessionId) {
    const id = assertValidSessionId(sessionId);
    return this._request('GET', `/api/sessions/${encodeURIComponent(id)}/state`);
  }

  /**
   * PATCH /api/sessions/:id/control-room
   * @param {string} sessionId
   * @param {Record<string, unknown>} layerOrPack
   */
  async patchControlRoom(sessionId, layerOrPack) {
    const id = assertValidSessionId(sessionId);
    return this._request('PATCH', `/api/sessions/${encodeURIComponent(id)}/control-room`, layerOrPack);
  }

  /**
   * POST /api/wizard/generate
   * @param {Record<string, unknown>} req
   */
  async generateWizardSystem(req) {
    return this._request('POST', '/api/wizard/generate', req);
  }

  /**
   * POST /api/sessions/:id/compile-prompt
   * @param {string} sessionId
   * @param {Record<string, unknown>} [payload]
   */
  async compilePrompt(sessionId, payload = {}) {
    const id = assertValidSessionId(sessionId);
    return this._request('POST', `/api/sessions/${encodeURIComponent(id)}/compile-prompt`, payload);
  }

  /**
   * POST /api/sessions/:id/post-narrate
   * @param {string} sessionId
   * @param {Record<string, unknown>} payload
   */
  async postNarrate(sessionId, payload) {
    const id = assertValidSessionId(sessionId);
    return this._request('POST', `/api/sessions/${encodeURIComponent(id)}/post-narrate`, payload);
  }

  /**
   * POST /api/sessions/:id/swipe
   * @param {string} sessionId
   * @param {Record<string, unknown>} payload
   */
  async swipe(sessionId, payload) {
    const id = assertValidSessionId(sessionId);
    return this._request('POST', `/api/sessions/${encodeURIComponent(id)}/swipe`, payload);
  }

  /**
   * POST /api/sessions/:id/confirm-patch
   * @param {string} sessionId
   * @param {'accept_all' | 'reject_all' | { acceptIndices: number[] } | Record<string, unknown>} decision
   */
  async confirmPatch(sessionId, decision) {
    const id = assertValidSessionId(sessionId);
    const body = typeof decision === 'string' ? { decision } : decision;
    return this._request('POST', `/api/sessions/${encodeURIComponent(id)}/confirm-patch`, body);
  }

  /**
   * GET /api/sessions/:id/audit
   * @param {string} sessionId
   * @param {{ turn?: number; pathPrefix?: string; source?: string }} [query]
   */
  async getAudit(sessionId, query = {}) {
    const id = assertValidSessionId(sessionId);
    const params = new URLSearchParams();
    if (query && typeof query === 'object') {
      if (query.turn !== undefined && Number.isInteger(query.turn) && query.turn >= 0) {
        params.set('turn', String(query.turn));
      }
      if (typeof query.pathPrefix === 'string' && query.pathPrefix.length > 0) {
        params.set('pathPrefix', query.pathPrefix);
      }
      if (typeof query.source === 'string' && query.source.length > 0) {
        params.set('source', query.source);
      }
    }
    const qs = params.toString();
    const suffix = qs.length > 0 ? `?${qs}` : '';
    return this._request('GET', `/api/sessions/${encodeURIComponent(id)}/audit${suffix}`);
  }

  /**
   * GET /api/sessions/:id/chronicle
   * @param {string} sessionId
   */
  async getChronicle(sessionId) {
    const id = assertValidSessionId(sessionId);
    return this._request('GET', `/api/sessions/${encodeURIComponent(id)}/chronicle`);
  }

  /**
   * POST /api/sessions/:id/combat/preview
   * @param {string} sessionId
   * @param {Record<string, unknown>} payload
   */
  async previewCombat(sessionId, payload) {
    const id = assertValidSessionId(sessionId);
    return this._request('POST', `/api/sessions/${encodeURIComponent(id)}/combat/preview`, payload);
  }

  /**
   * POST /api/sessions/:id/travel
   * @param {string} sessionId
   * @param {Record<string, unknown>} payload
   */
  async travel(sessionId, payload) {
    const id = assertValidSessionId(sessionId);
    return this._request('POST', `/api/sessions/${encodeURIComponent(id)}/travel`, payload);
  }

  /**
   * POST /api/sessions/:id/downtime
   * @param {string} sessionId
   * @param {Record<string, unknown>} payload
   */
  async downtime(sessionId, payload) {
    const id = assertValidSessionId(sessionId);
    return this._request('POST', `/api/sessions/${encodeURIComponent(id)}/downtime`, payload);
  }

  /**
   * POST /api/sessions/:id/clone
   * @param {string} sessionId
   * @param {Record<string, unknown>} [payload]
   */
  async cloneSession(sessionId, payload = {}) {
    const id = assertValidSessionId(sessionId);
    return this._request('POST', `/api/sessions/${encodeURIComponent(id)}/clone`, payload);
  }

  /**
   * GET /api/sessions
   */
  async listSessions() {
    return this._request('GET', '/api/sessions');
  }

  /**
   * GET /api/sessions/:id/context-budget
   * @param {string} sessionId
   */
  async getContextBudget(sessionId) {
    const id = assertValidSessionId(sessionId);
    return this._request('GET', `/api/sessions/${encodeURIComponent(id)}/context-budget`);
  }

  /**
   * POST /api/cards/import
   * @param {Record<string, unknown>} payload
   */
  async importCard(payload) {
    return this._request('POST', '/api/cards/import', payload);
  }

  /**
   * POST /api/sessions/:id/player/bind
   * @param {string} sessionId
   * @param {Record<string, unknown>} payload
   */
  async bindPlayer(sessionId, payload) {
    const id = assertValidSessionId(sessionId);
    return this._request('POST', `/api/sessions/${encodeURIComponent(id)}/player/bind`, payload);
  }
}
