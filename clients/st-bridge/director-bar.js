import { escapeHtml } from './hud-panel.js';

const VALID_BEAT_STATUSES = new Set(['resolved', 'deferred', 'short_circuited']);
const VALID_CLOCK_MODES = new Set(['auto', 'hold', 'release', 'rest_to_morning']);

/**
 * Controller holding transient Director Steering Bar state and compiling valid
 * `DirectorSteeringInput` payloads for `/compile-prompt` and `/post-narrate`.
 */
export class DirectorBarState {
  /**
   * @param {{
   *   holdClock?: boolean;
   *   clockActionMode?: 'auto' | 'hold' | 'release' | 'rest_to_morning';
   *   advanceSlots?: number;
   *   oocNudge?: string;
   *   pinCharacterIds?: string[];
   *   dismissCharacterIds?: string[];
   *   beatOverrides?: Array<{ beatId: string; status: 'resolved' | 'deferred' | 'short_circuited'; reason?: string }>;
   * }} [initial]
   */
  constructor(initial = {}) {
    this.holdClock = initial.holdClock === true;
    this.clockActionMode =
      typeof initial.clockActionMode === 'string' && VALID_CLOCK_MODES.has(initial.clockActionMode)
        ? initial.clockActionMode
        : this.holdClock
          ? 'hold'
          : 'auto';
    this.advanceSlots =
      typeof initial.advanceSlots === 'number' &&
      Number.isInteger(initial.advanceSlots) &&
      initial.advanceSlots >= 0
        ? initial.advanceSlots
        : 0;
    this.oocNudge = typeof initial.oocNudge === 'string' ? initial.oocNudge : '';
    this.pinCharacterIds = Array.isArray(initial.pinCharacterIds)
      ? initial.pinCharacterIds.filter((id) => typeof id === 'string' && id.trim().length > 0)
      : [];
    this.dismissCharacterIds = Array.isArray(initial.dismissCharacterIds)
      ? initial.dismissCharacterIds.filter((id) => typeof id === 'string' && id.trim().length > 0)
      : [];
    this.beatOverrides = [];
    if (Array.isArray(initial.beatOverrides)) {
      for (const entry of initial.beatOverrides) {
        if (entry && typeof entry.beatId === 'string' && VALID_BEAT_STATUSES.has(entry.status)) {
          this.beatOverrides.push({
            beatId: entry.beatId.trim(),
            status: entry.status,
            ...(typeof entry.reason === 'string' && entry.reason.trim().length > 0
              ? { reason: entry.reason.trim() }
              : {}),
          });
        }
      }
    }
  }

  /**
   * @param {boolean} held
   */
  setHoldClock(held) {
    this.holdClock = Boolean(held);
    this.clockActionMode = this.holdClock ? 'hold' : 'release';
    if (this.holdClock) {
      this.advanceSlots = 0;
    }
  }

  /**
   * @param {'auto' | 'hold' | 'release' | 'rest_to_morning'} mode
   */
  setClockActionMode(mode) {
    if (!VALID_CLOCK_MODES.has(mode)) {
      throw new Error(`Invalid clockActionMode "${String(mode)}"`);
    }
    this.clockActionMode = mode;
    this.holdClock = mode === 'hold';
    if (mode !== 'auto') {
      this.advanceSlots = 0;
    }
  }

  /**
   * @param {number} slots
   */
  setAdvanceSlots(slots) {
    if (typeof slots !== 'number' || !Number.isInteger(slots) || slots < 0) {
      throw new Error('advanceSlots must be a non-negative integer');
    }
    this.advanceSlots = slots;
    if (slots > 0) {
      this.holdClock = false;
      this.clockActionMode = 'auto';
    }
  }

  /**
   * @param {string} text
   */
  setOocNudge(text) {
    this.oocNudge = typeof text === 'string' ? text : '';
  }

  /**
   * @param {string} characterId
   */
  pinCharacter(characterId) {
    const id = typeof characterId === 'string' ? characterId.trim() : '';
    if (!id) return;
    if (!this.pinCharacterIds.includes(id)) {
      this.pinCharacterIds.push(id);
    }
    this.dismissCharacterIds = this.dismissCharacterIds.filter((c) => c !== id);
  }

  /**
   * @param {string} characterId
   */
  unpinCharacter(characterId) {
    this.pinCharacterIds = this.pinCharacterIds.filter((c) => c !== characterId);
  }

  /**
   * @param {string[]} ids
   */
  setPinnedCharacters(ids) {
    this.pinCharacterIds = Array.isArray(ids)
      ? Array.from(new Set(ids.filter((id) => typeof id === 'string' && id.trim().length > 0)))
      : [];
  }

  /**
   * @param {string} characterId
   */
  dismissCharacter(characterId) {
    const id = typeof characterId === 'string' ? characterId.trim() : '';
    if (!id) return;
    if (!this.dismissCharacterIds.includes(id)) {
      this.dismissCharacterIds.push(id);
    }
    this.pinCharacterIds = this.pinCharacterIds.filter((c) => c !== id);
  }

  /**
   * @param {string} beatId
   * @param {'resolved' | 'deferred' | 'short_circuited'} status
   * @param {string} [reason]
   */
  addBeatOverride(beatId, status, reason) {
    const cleanId = typeof beatId === 'string' ? beatId.trim() : '';
    if (!cleanId) {
      throw new Error('beatId must be a non-empty string');
    }
    if (!VALID_BEAT_STATUSES.has(status)) {
      throw new Error(`Invalid beat override status "${String(status)}"`);
    }
    this.beatOverrides = this.beatOverrides.filter((b) => b.beatId !== cleanId);
    this.beatOverrides.push({
      beatId: cleanId,
      status,
      ...(typeof reason === 'string' && reason.trim().length > 0 ? { reason: reason.trim() } : {}),
    });
  }

  /**
   * @param {string} beatId
   */
  removeBeatOverride(beatId) {
    this.beatOverrides = this.beatOverrides.filter((b) => b.beatId !== beatId);
  }

  clearBeatOverrides() {
    this.beatOverrides = [];
  }

  /**
   * Clear one-turn steering fields after turn submission while preserving sticky clock hold.
   */
  resetTurnOverrides() {
    this.advanceSlots = 0;
    this.oocNudge = '';
    this.beatOverrides = [];
    this.dismissCharacterIds = [];
    if (this.clockActionMode === 'rest_to_morning' || this.clockActionMode === 'release') {
      this.clockActionMode = 'auto';
    }
  }

  /**
   * Compile current Director Bar controls into a daemon-compatible `DirectorSteeringInput`.
   * @returns {Record<string, unknown>}
   */
  buildDirectorSteeringPayload() {
    /** @type {Record<string, unknown>} */
    const payload = {};

    if (this.advanceSlots > 0) {
      payload.clockAction = { advanceSlots: this.advanceSlots };
    } else if (this.holdClock || this.clockActionMode === 'hold') {
      payload.clockAction = 'hold';
    } else if (this.clockActionMode === 'release') {
      payload.clockAction = 'release';
    } else if (this.clockActionMode === 'rest_to_morning') {
      payload.clockAction = 'rest_to_morning';
    }

    const trimmedNudge = this.oocNudge.trim();
    if (trimmedNudge.length > 0) {
      payload.oocNudge = trimmedNudge;
    }

    if (this.pinCharacterIds.length > 0) {
      payload.pinCharacterIds = [...this.pinCharacterIds];
    }

    if (this.dismissCharacterIds.length > 0) {
      payload.dismissCharacterIds = [...this.dismissCharacterIds];
    }

    if (this.beatOverrides.length > 0) {
      payload.beatOverrides = this.beatOverrides.map((entry) => ({
        beatId: entry.beatId,
        status: entry.status,
        ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
      }));
    }

    return payload;
  }
}

/**
 * Pure HTML renderer for the Director Steering Bar.
 *
 * @param {DirectorBarState | Record<string, any>} stateOrController
 * @param {{ availableCharacters?: Array<{ id: string; name?: string }> }} [options]
 * @returns {string}
 */
export function renderDirectorBarHtml(stateOrController, options = {}) {
  const ctrl =
    stateOrController instanceof DirectorBarState
      ? stateOrController
      : new DirectorBarState(stateOrController ?? {});

  const holdBtnClass = ctrl.holdClock
    ? 'referee-bridge-btn referee-bridge-btn--active'
    : 'referee-bridge-btn';
  const restBtnClass =
    ctrl.clockActionMode === 'rest_to_morning'
      ? 'referee-bridge-btn referee-bridge-btn--active'
      : 'referee-bridge-btn';

  const pinnedChips = ctrl.pinCharacterIds
    .map(
      (id) =>
        `<span class="referee-bridge-tag referee-bridge-tag--pinned" data-pin-id="${escapeHtml(
          id
        )}">${escapeHtml(id)} <button type="button" class="referee-bridge-btn" data-director-action="unpin" data-character-id="${escapeHtml(
          id
        )}">x</button></span>`
    )
    .join('');

  const availableChars = Array.isArray(options.availableCharacters) ? options.availableCharacters : [];
  const charOptionsHtml = availableChars
    .map(
      (c) =>
        `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name || c.id)}</option>`
    )
    .join('');

  const beatChips = ctrl.beatOverrides
    .map(
      (b) =>
        `<span class="referee-bridge-tag" data-beat-id="${escapeHtml(b.beatId)}">${escapeHtml(
          b.beatId
        )} → ${escapeHtml(b.status)}</span>`
    )
    .join('');

  return `<div class="referee-bridge-director-bar" data-referee-director-bar="true">
    <button type="button" class="${holdBtnClass}" data-director-action="toggle-hold" aria-pressed="${
    ctrl.holdClock ? 'true' : 'false'
  }">${ctrl.holdClock ? 'Clock Held' : 'Hold Clock'}</button>
    <label>Advance Slots:
      <input type="number" min="0" step="1" class="referee-bridge-input" data-director-input="advanceSlots" value="${escapeHtml(
        ctrl.advanceSlots
      )}" style="width:64px" />
    </label>
    <button type="button" class="${restBtnClass}" data-director-action="rest-morning">Rest to Morning</button>
    <label style="flex:1;min-width:180px">OOC Nudge:
      <input type="text" class="referee-bridge-input" data-director-input="oocNudge" value="${escapeHtml(
        ctrl.oocNudge
      )}" placeholder="One-turn director nudge..." style="width:100%" />
    </label>
    ${
      availableChars.length > 0
        ? `<select class="referee-bridge-select" data-director-input="pinSelect">
            <option value="">Pin character...</option>
            ${charOptionsHtml}
          </select>`
        : ''
    }
    <div class="referee-bridge-tags" data-director-pins>${pinnedChips}</div>
    <div class="referee-bridge-tags" data-director-beats>${beatChips}</div>
  </div>`;
}

/**
 * Optional DOM binder connecting a container element to a {@link DirectorBarState} controller.
 *
 * @param {HTMLElement} container
 * @param {DirectorBarState} controller
 * @param {{ availableCharacters?: Array<{ id: string; name?: string }>; onChange?: (payload: Record<string, unknown>) => void }} [options]
 * @returns {() => void}
 */
export function bindDirectorBarDom(container, controller, options = {}) {
  if (!container || typeof container !== 'object') {
    return () => {};
  }

  const rerender = () => {
    container.innerHTML = renderDirectorBarHtml(controller, options);
  };
  rerender();

  const notify = () => {
    if (typeof options.onChange === 'function') {
      options.onChange(controller.buildDirectorSteeringPayload());
    }
  };

  const onClick = (event) => {
    const btn = event?.target?.closest?.('[data-director-action]');
    if (!btn) return;
    const action = btn.getAttribute('data-director-action');
    if (action === 'toggle-hold') {
      controller.setHoldClock(!controller.holdClock);
      rerender();
      notify();
    } else if (action === 'rest-morning') {
      controller.setClockActionMode(
        controller.clockActionMode === 'rest_to_morning' ? 'auto' : 'rest_to_morning'
      );
      rerender();
      notify();
    } else if (action === 'unpin') {
      const charId = btn.getAttribute('data-character-id');
      if (charId) {
        controller.unpinCharacter(charId);
        rerender();
        notify();
      }
    }
  };

  const onInput = (event) => {
    const el = event?.target;
    if (!el || typeof el.getAttribute !== 'function') return;
    const inputKind = el.getAttribute('data-director-input');
    if (inputKind === 'oocNudge') {
      controller.setOocNudge(el.value ?? '');
      notify();
    } else if (inputKind === 'advanceSlots') {
      const n = Number.parseInt(el.value ?? '0', 10);
      controller.setAdvanceSlots(Number.isInteger(n) && n >= 0 ? n : 0);
      notify();
    } else if (inputKind === 'pinSelect' && el.value) {
      controller.pinCharacter(el.value);
      rerender();
      notify();
    }
  };

  if (typeof container.addEventListener === 'function') {
    container.addEventListener('click', onClick);
    container.addEventListener('input', onInput);
    container.addEventListener('change', onInput);
    return () => {
      if (typeof container.removeEventListener === 'function') {
        container.removeEventListener('click', onClick);
        container.removeEventListener('input', onInput);
        container.removeEventListener('change', onInput);
      }
    };
  }

  return () => {};
}
