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

function assertValidSafeId(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0 || !isSafePropertyKey(value.trim())) {
    throw new RefereeBridgeError(`${label} must be a safe non-empty string`, { status: 0 });
  }
  return value.trim();
}

function assertValidSessionId(sessionId) {
  return assertValidSafeId(sessionId, 'sessionId');
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
   * GET /api/connections
   * @param {{ redact?: boolean; redactApiKeys?: boolean }} [options]
   */
  async getConnections(options = {}) {
    const redact = options?.redact === true || options?.redactApiKeys === true;
    const suffix = redact ? '?redact=true' : '';
    return this._request('GET', `/api/connections${suffix}`);
  }

  /**
   * PUT /api/connections
   * @param {Record<string, unknown>} payload
   */
  async updateConnections(payload) {
    return this._request('PUT', '/api/connections', payload ?? {});
  }

  /**
   * POST /api/connections/profiles
   * @param {string} name
   * @param {Record<string, unknown>} [payload]
   */
  async saveConnectionProfile(name, payload = {}) {
    const profileName = assertValidSafeId(name, 'profile name');
    const body = payload && typeof payload === 'object' ? { ...payload } : {};
    setSafeOwn(body, 'name', profileName);
    return this._request('POST', '/api/connections/profiles', body);
  }

  /**
   * POST /api/connections/profiles/:name/activate
   * @param {string} name
   */
  async activateConnectionProfile(name) {
    const profileName = assertValidSafeId(name, 'profile name');
    return this._request(
      'POST',
      `/api/connections/profiles/${encodeURIComponent(profileName)}/activate`
    );
  }

  /**
   * GET /api/presets
   */
  async listPresets() {
    return this._request('GET', '/api/presets');
  }

  /**
   * POST /api/presets/import
   * @param {Record<string, unknown>} payload
   */
  async importPreset(payload) {
    return this._request('POST', '/api/presets/import', payload);
  }

  /**
   * GET /api/sessions/:id/preset/export?format=...
   * @param {string} sessionId
   * @param {'st_chat' | 'st_text' | 'referee'} [format]
   */
  async exportSessionPreset(sessionId, format = 'referee') {
    const id = assertValidSessionId(sessionId);
    const params = new URLSearchParams();
    if (typeof format === 'string' && format.trim().length > 0) {
      params.set('format', format.trim());
    }
    const qs = params.toString();
    const suffix = qs.length > 0 ? `?${qs}` : '';
    return this._request('GET', `/api/sessions/${encodeURIComponent(id)}/preset/export${suffix}`);
  }

  /**
   * POST /api/sessions/:id/control-room/apply-preset
   * @param {string} sessionId
   * @param {Record<string, unknown>} payload
   */
  async applyPreset(sessionId, payload) {
    const id = assertValidSessionId(sessionId);
    return this._request(
      'POST',
      `/api/sessions/${encodeURIComponent(id)}/control-room/apply-preset`,
      payload
    );
  }

  /**
   * GET /api/personas
   */
  async listPersonas() {
    return this._request('GET', '/api/personas');
  }

  /**
   * POST /api/personas
   * @param {Record<string, unknown>} persona
   */
  async savePersona(persona) {
    return this._request('POST', '/api/personas', persona);
  }

  /**
   * PUT /api/sessions/:id/persona
   * @param {string} sessionId
   * @param {Record<string, unknown>} payload
   */
  async applySessionPersona(sessionId, payload) {
    const id = assertValidSessionId(sessionId);
    return this._request('PUT', `/api/sessions/${encodeURIComponent(id)}/persona`, payload);
  }

  /**
   * GET /api/sessions/:id/characters
   * @param {string} sessionId
   * @param {{
   *   locationId?: string;
   *   status?: string;
   *   allegiance?: string;
   *   formGroup?: string;
   *   presentOnly?: boolean;
   *   includePlayer?: boolean;
   *   query?: string;
   * }} [filter]
   */
  async getSettingCharacters(sessionId, filter = {}) {
    const id = assertValidSessionId(sessionId);
    const params = new URLSearchParams();
    if (filter && typeof filter === 'object') {
      if (typeof filter.locationId === 'string' && filter.locationId.length > 0) {
        params.set('locationId', filter.locationId);
      }
      if (typeof filter.status === 'string' && filter.status.length > 0) {
        params.set('status', filter.status);
      }
      if (typeof filter.allegiance === 'string' && filter.allegiance.length > 0) {
        params.set('allegiance', filter.allegiance);
      }
      if (typeof filter.formGroup === 'string' && filter.formGroup.length > 0) {
        params.set('formGroup', filter.formGroup);
      }
      if (typeof filter.presentOnly === 'boolean') {
        params.set('presentOnly', String(filter.presentOnly));
      }
      if (typeof filter.includePlayer === 'boolean') {
        params.set('includePlayer', String(filter.includePlayer));
      }
      if (typeof filter.query === 'string' && filter.query.length > 0) {
        params.set('query', filter.query);
      }
    }
    const qs = params.toString();
    const suffix = qs.length > 0 ? `?${qs}` : '';
    return this._request('GET', `/api/sessions/${encodeURIComponent(id)}/characters${suffix}`);
  }

  /**
   * GET /api/sessions/:id/characters/:charId
   * @param {string} sessionId
   * @param {string} charId
   */
  async getCharacterDossier(sessionId, charId) {
    const id = assertValidSessionId(sessionId);
    const cid = assertValidSafeId(charId, 'charId');
    return this._request(
      'GET',
      `/api/sessions/${encodeURIComponent(id)}/characters/${encodeURIComponent(cid)}`
    );
  }

  /**
   * POST /api/sessions/:id/characters
   * @param {string} sessionId
   * @param {Record<string, unknown>} payload
   */
  async upsertCharacter(sessionId, payload) {
    const id = assertValidSessionId(sessionId);
    return this._request('POST', `/api/sessions/${encodeURIComponent(id)}/characters`, payload);
  }

  /**
   * POST /api/sessions/:id/combat/start
   * @param {string} sessionId
   * @param {Record<string, unknown>} payload
   */
  async startCombat(sessionId, payload) {
    const id = assertValidSessionId(sessionId);
    return this._request('POST', `/api/sessions/${encodeURIComponent(id)}/combat/start`, payload);
  }
}
