import { getSafeOwn, isSafePropertyKey } from './bridge-client.js';

/**
 * Escape HTML special characters for safe template rendering.
 * @param {unknown} raw
 * @returns {string}
 */
export function escapeHtml(raw) {
  const str = raw === null || raw === undefined ? '' : String(raw);
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeEntries(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return [];
  }
  const out = [];
  for (const key of Object.keys(record)) {
    if (isSafePropertyKey(key) && Object.hasOwn(record, key)) {
      out.push([key, Object.getOwnPropertyDescriptor(record, key)?.value]);
    }
  }
  return out;
}

function clampPercent(value, min, max) {
  const num = typeof value === 'number' && Number.isFinite(value) ? value : min;
  const span = max - min;
  if (!Number.isFinite(span) || span <= 0) {
    return 0;
  }
  const pct = ((num - min) / span) * 100;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

function resolveFieldValue(mod, fieldKey, fieldSpec, state) {
  if (!state || typeof state !== 'object') {
    return fieldSpec?.default;
  }

  if (mod.target === 'player') {
    const pCustom = getSafeOwn(state.player?.customFields, fieldKey);
    if (pCustom !== undefined) return pCustom;

    const pResource = getSafeOwn(state.player?.resources, fieldKey);
    if (pResource && typeof pResource === 'object' && Object.hasOwn(pResource, 'current')) {
      return pResource.current;
    }

    const pProg = getSafeOwn(state.player?.progression, fieldKey);
    if (pProg !== undefined) return pProg;
  }

  const globalCustom = getSafeOwn(state.customFields, fieldKey);
  if (globalCustom !== undefined) return globalCustom;

  const sceneVal = getSafeOwn(state.scene, fieldKey);
  if (sceneVal !== undefined) return sceneVal;

  const counterVal = getSafeOwn(state.counters, fieldKey);
  if (counterVal !== undefined) return counterVal;

  const flagVal = getSafeOwn(state.flags, fieldKey);
  if (flagVal !== undefined) return flagVal;

  if (fieldKey === 'time_of_day' && state.clocks?.slot !== undefined) {
    return state.clocks.slot;
  }

  return fieldSpec?.default;
}

function renderDualClockWidget(state, clocksMode) {
  if (clocksMode === 'disabled' || !state?.clocks) {
    return '';
  }
  const clocks = state.clocks;
  const heldBadge = clocks.held
    ? `<span class="referee-bridge-badge referee-bridge-badge--user_customized">HELD${
        clocks.holdReason ? `: ${escapeHtml(clocks.holdReason)}` : ''
      }</span>`
    : '<span class="referee-bridge-badge referee-bridge-badge--matches_stock">ACTIVE</span>';

  const dateLine = clocks.inGameDate
    ? `<div>Date: <strong>${escapeHtml(clocks.inGameDate)}</strong></div>`
    : '';

  const simDetails =
    clocksMode === 'full_sim'
      ? `<div>Turn: <strong>${escapeHtml(clocks.turn ?? 0)}</strong> · Story Turn: <strong>${escapeHtml(
          clocks.storyTurn ?? 0
        )}</strong></div>`
      : '';

  const timersEntries = clocksMode === 'full_sim' ? safeEntries(clocks.timers) : [];
  const timersHtml =
    timersEntries.length > 0
      ? `<div class="referee-bridge-tags">${timersEntries
          .map(
            ([id, timer]) =>
              `<span class="referee-bridge-tag">${escapeHtml(id)}: ${escapeHtml(
                timer?.current ?? 0
              )}/${escapeHtml(timer?.max ?? 0)}</span>`
          )
          .join('')}</div>`
      : '';

  return `<section class="referee-bridge-widget" data-widget="dual-clock">
    <div class="referee-bridge-widget-title">Dual Clock ${heldBadge}</div>
    <div>Day <strong>${escapeHtml(clocks.day ?? 1)}</strong> · Slot <strong>${escapeHtml(
    clocks.slot ?? 'morning'
  )}</strong></div>
    ${dateLine}
    ${simDetails}
    ${timersHtml}
  </section>`;
}

function renderSceneCastWidget(state) {
  const scene = state?.scene;
  if (!scene) {
    return '';
  }
  const chars = state?.entities?.characters ?? {};
  const presentIds = Array.isArray(scene.presentCharacterIds) ? scene.presentCharacterIds : [];
  const pinnedSet = new Set(Array.isArray(scene.pinnedCharacterIds) ? scene.pinnedCharacterIds : []);

  const castChips =
    presentIds.length > 0
      ? presentIds
          .map((id) => {
            const charEntity = getSafeOwn(chars, id);
            const displayName =
              charEntity && typeof charEntity === 'object' && typeof charEntity.name === 'string'
                ? charEntity.name
                : id;
            const pinnedClass = pinnedSet.has(id) ? ' referee-bridge-tag--pinned' : '';
            const pinMark = pinnedSet.has(id) ? ' [pinned]' : '';
            return `<span class="referee-bridge-tag${pinnedClass}" data-character-id="${escapeHtml(
              id
            )}">${escapeHtml(displayName)}${escapeHtml(pinMark)}</span>`;
          })
          .join('')
      : '<span class="referee-bridge-tag">Solo / None listed</span>';

  return `<section class="referee-bridge-widget" data-widget="scene-cast">
    <div class="referee-bridge-widget-title">Scene &amp; Cast</div>
    <div>Location: <strong>${escapeHtml(scene.location || 'Unknown')}</strong></div>
    <div>Mood: <strong>${escapeHtml(scene.mood || 'neutral')}</strong></div>
    <div class="referee-bridge-tags" style="margin-top:4px">${castChips}</div>
  </section>`;
}

function renderRelationshipBars(state) {
  const relations = safeEntries(state?.relations);
  if (relations.length === 0) {
    return '<div class="referee-bridge-tags"><span class="referee-bridge-tag">No affinity shifts yet</span></div>';
  }
  const chars = state?.entities?.characters ?? {};
  const rows = [];
  for (const [sourceId, targets] of relations) {
    for (const [targetId, rel] of safeEntries(targets)) {
      if (!rel || typeof rel !== 'object') continue;
      const targetEntity = getSafeOwn(chars, targetId);
      const targetName =
        targetEntity && typeof targetEntity === 'object' && typeof targetEntity.name === 'string'
          ? targetEntity.name
          : targetId;
      const maxAff = typeof rel.maxAffinity === 'number' && rel.maxAffinity > 0 ? rel.maxAffinity : 100;
      const affinity = typeof rel.affinity === 'number' ? rel.affinity : 0;
      const pct = clampPercent(affinity, 0, maxAff);
      const labelText = typeof rel.label === 'string' && rel.label.length > 0 ? ` (${rel.label})` : '';
      rows.push(`<div class="referee-bridge-meter-row" data-relation="${escapeHtml(
        `${sourceId}:${targetId}`
      )}">
        <div class="referee-bridge-meter-label">
          <span>${escapeHtml(targetName)}${escapeHtml(labelText)}</span>
          <span>${escapeHtml(affinity)}/${escapeHtml(maxAff)}</span>
        </div>
        <div class="referee-bridge-meter-track">
          <div class="referee-bridge-meter-fill" style="width:${pct}%"></div>
        </div>
      </div>`);
    }
  }
  return rows.length > 0
    ? rows.join('')
    : '<div class="referee-bridge-tags"><span class="referee-bridge-tag">No affinity shifts yet</span></div>';
}

function renderSingleGameSystem(mod, state, capabilities) {
  const widgetType = mod.ui?.widget ?? 'card';
  if (widgetType === 'hidden' || mod.enabled === false) {
    return '';
  }

  const combatDisabled = !capabilities?.combatMode || capabilities.combatMode === 'disabled';
  const progressionDisabled = !capabilities?.progression || capabilities.progression === 'disabled';
  if (combatDisabled && (mod.id === 'tactical_combat' || mod.id === 'combat')) {
    return '';
  }
  if (progressionDisabled && mod.id === 'rpg_progression') {
    return '';
  }

  const fieldEntries = safeEntries(mod.fields);
  let bodyHtml = '';

  if (mod.id === 'relationship_affinity' && fieldEntries.length === 0) {
    if (capabilities?.relationships === false) {
      return '';
    }
    bodyHtml = renderRelationshipBars(state);
  } else if (widgetType === 'bar') {
    const bars = [];
    for (const [fieldKey, spec] of fieldEntries) {
      if (!spec || typeof spec !== 'object') continue;
      const val = resolveFieldValue(mod, fieldKey, spec, state);
      if (spec.type === 'meter' || spec.type === 'counter') {
        const min = typeof spec.min === 'number' ? spec.min : 0;
        const max = typeof spec.max === 'number' ? spec.max : 100;
        const pct = clampPercent(val, min, max);
        bars.push(`<div class="referee-bridge-meter-row" data-field="${escapeHtml(fieldKey)}">
          <div class="referee-bridge-meter-label">
            <span>${escapeHtml(fieldKey)}</span>
            <span>${escapeHtml(val ?? min)} / ${escapeHtml(max)}</span>
          </div>
          <div class="referee-bridge-meter-track">
            <div class="referee-bridge-meter-fill" style="width:${pct}%"></div>
          </div>
        </div>`);
      } else {
        bars.push(`<div>${escapeHtml(fieldKey)}: <strong>${escapeHtml(val)}</strong></div>`);
      }
    }
    bodyHtml = bars.join('');
  } else if (widgetType === 'badge') {
    const badges = fieldEntries.map(([fieldKey, spec]) => {
      const val = resolveFieldValue(mod, fieldKey, spec, state);
      return `<span class="referee-bridge-badge" data-field="${escapeHtml(fieldKey)}">${escapeHtml(
        fieldKey
      )}: ${escapeHtml(val)}</span>`;
    });
    bodyHtml = `<div class="referee-bridge-tags">${badges.join('')}</div>`;
  } else if (widgetType === 'tags') {
    const tags = [];
    for (const [fieldKey, spec] of fieldEntries) {
      const val = resolveFieldValue(mod, fieldKey, spec, state);
      if (Array.isArray(val)) {
        for (const item of val) {
          tags.push(`<span class="referee-bridge-tag">${escapeHtml(item)}</span>`);
        }
      } else {
        tags.push(
          `<span class="referee-bridge-tag" data-field="${escapeHtml(fieldKey)}">${escapeHtml(
            fieldKey
          )}: ${escapeHtml(val)}</span>`
        );
      }
    }
    bodyHtml = `<div class="referee-bridge-tags">${tags.join('')}</div>`;
  } else {
    const rows = fieldEntries.map(([fieldKey, spec]) => {
      const val = resolveFieldValue(mod, fieldKey, spec, state);
      const formatted = Array.isArray(val) ? val.join(', ') : val;
      return `<div data-field="${escapeHtml(fieldKey)}">${escapeHtml(fieldKey)}: <strong>${escapeHtml(
        formatted
      )}</strong></div>`;
    });
    bodyHtml = rows.join('');
  }

  return `<section class="referee-bridge-widget" data-widget="game-system" data-module-id="${escapeHtml(
    mod.id
  )}" data-widget-type="${escapeHtml(widgetType)}">
    <div class="referee-bridge-widget-title">${escapeHtml(mod.name || mod.id)}</div>
    ${bodyHtml || '<div><em>No fields</em></div>'}
  </section>`;
}

function renderCombatWidget(combatState, combatMode) {
  if (!combatMode || combatMode === 'disabled' || !combatState) {
    return '';
  }
  const round = combatState.round ?? 1;
  const activeId =
    combatState.initiativeOrder?.[combatState.turnIndex] ?? combatState.activeCombatantId ?? 'none';
  return `<section class="referee-bridge-widget" data-widget="combat-panel">
    <div class="referee-bridge-widget-title">Combat (${escapeHtml(combatMode)})</div>
    <div>Round <strong>${escapeHtml(round)}</strong> · Active: <strong>${escapeHtml(activeId)}</strong></div>
  </section>`;
}

function buildSettingRosterEntries(state, settingRoster) {
  if (settingRoster && Array.isArray(settingRoster.characters)) {
    return settingRoster.characters
      .filter((entry) => entry && typeof entry === 'object')
      .map((entry) => ({
        id: typeof entry.id === 'string' ? entry.id : '',
        name: typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : String(entry.id ?? ''),
        isPlayer: entry.isPlayer === true || entry.presence === 'player',
        status: typeof entry.status === 'string' && entry.status.length > 0 ? entry.status : 'active',
        presentInScene:
          entry.presentInScene === true ||
          entry.presence === 'in_scene' ||
          entry.presence === 'in_scene_pinned' ||
          entry.presence === 'player',
        isPinned: entry.isPinned === true || entry.presence === 'in_scene_pinned',
        locationName:
          typeof entry.locationName === 'string' && entry.locationName.length > 0
            ? entry.locationName
            : typeof entry.locationId === 'string' && entry.locationId.length > 0
              ? entry.locationId
              : null,
        mood: typeof entry.mood === 'string' ? entry.mood : '',
        allegiance:
          typeof entry.allegianceName === 'string' && entry.allegianceName.length > 0
            ? entry.allegianceName
            : typeof entry.allegiance === 'string'
              ? entry.allegiance
              : '',
      }));
  }

  const chars = state?.entities?.characters;
  const locations = state?.entities?.locations ?? {};
  const presentSet = new Set(
    Array.isArray(state?.scene?.presentCharacterIds) ? state.scene.presentCharacterIds : []
  );
  const pinnedSet = new Set(
    Array.isArray(state?.scene?.pinnedCharacterIds) ? state.scene.pinnedCharacterIds : []
  );

  const entries = [];
  for (const [id, char] of safeEntries(chars)) {
    if (!char || typeof char !== 'object') continue;
    const status = typeof char.status === 'string' && char.status.length > 0 ? char.status : 'active';
    const isPinned = pinnedSet.has(id);
    const presentInScene =
      status === 'active' && (char.presentInScene === true || presentSet.has(id) || isPinned);
    const locationId = typeof char.locationId === 'string' && char.locationId.length > 0 ? char.locationId : null;
    const locEntity = locationId ? getSafeOwn(locations, locationId) : null;
    const locationName =
      locEntity && typeof locEntity === 'object' && typeof locEntity.name === 'string' && locEntity.name.length > 0
        ? locEntity.name
        : locationId;
    entries.push({
      id,
      name: typeof char.name === 'string' && char.name.length > 0 ? char.name : id,
      isPlayer: false,
      status,
      presentInScene,
      isPinned,
      locationName,
      mood: typeof char.mood === 'string' ? char.mood : '',
      allegiance: typeof char.allegiance === 'string' ? char.allegiance : '',
    });
  }
  return entries;
}

function renderSettingRosterWidget(state, settingRoster) {
  const entries = buildSettingRosterEntries(state, settingRoster);
  if (entries.length === 0 && !settingRoster) {
    return '';
  }

  const presentEntries = entries.filter((e) => e.status === 'active' && e.presentInScene);
  const offscreenEntries = entries.filter((e) => e.status !== 'active' || !e.presentInScene);

  const renderPresentItem = (entry) => {
    const badges = ['<span class="referee-bridge-badge">[HERE]</span>'];
    if (entry.isPinned) {
      badges.push('<span class="referee-bridge-badge referee-bridge-tag--pinned">[PINNED]</span>');
    }
    const metaParts = [entry.mood, entry.allegiance].filter((v) => typeof v === 'string' && v.length > 0);
    const metaSuffix = metaParts.length > 0 ? ` <small>(${escapeHtml(metaParts.join(' · '))})</small>` : '';
    return `<div class="referee-bridge-roster-item" data-roster-presence="present" data-character-id="${escapeHtml(
      entry.id
    )}">${badges.join(' ')} <strong>${escapeHtml(entry.name)}</strong>${metaSuffix}</div>`;
  };

  const renderOffscreenItem = (entry) => {
    const locBadge = entry.locationName
      ? `<span class="referee-bridge-tag">@ ${escapeHtml(entry.locationName)}</span>`
      : '<span class="referee-bridge-tag">@ off-screen</span>';
    const statusBadge =
      entry.status !== 'active'
        ? ` <span class="referee-bridge-badge">[${escapeHtml(entry.status)}]</span>`
        : '';
    return `<div class="referee-bridge-roster-item" data-roster-presence="offscreen" data-character-id="${escapeHtml(
      entry.id
    )}">${locBadge}${statusBadge} <span>${escapeHtml(entry.name)}</span></div>`;
  };

  const presentHtml =
    presentEntries.length > 0
      ? `<div data-roster-group="present">${presentEntries.map(renderPresentItem).join('')}</div>`
      : '';
  const offscreenHtml =
    offscreenEntries.length > 0
      ? `<div data-roster-group="offscreen" style="margin-top:4px">${offscreenEntries
          .map(renderOffscreenItem)
          .join('')}</div>`
      : '';

  return `<details class="referee-bridge-widget" data-widget="setting-roster" open>
    <summary class="referee-bridge-widget-title">Setting Roster (${presentEntries.length} here · ${offscreenEntries.length} off-screen)</summary>
    ${presentHtml || offscreenHtml ? `${presentHtml}${offscreenHtml}` : '<div><em>No characters in setting</em></div>'}
  </details>`;
}

function renderActiveGateBeatWidget(beatLedger, beatsEnabled) {
  if (!beatsEnabled || !beatLedger) {
    return '';
  }
  const liveGateId = beatLedger.liveGateId ?? null;
  const gateRecord = liveGateId ? getSafeOwn(beatLedger.records, liveGateId) : null;
  const gateStatus =
    gateRecord && typeof gateRecord === 'object' && typeof gateRecord.status === 'string'
      ? gateRecord.status
      : 'idle';
  const nudgeCount = Array.isArray(beatLedger.liveNudgeIds) ? beatLedger.liveNudgeIds.length : 0;

  return `<section class="referee-bridge-widget" data-widget="active-gate-beat">
    <div class="referee-bridge-widget-title">Active Gate Beat</div>
    <div>Gate: <strong>${escapeHtml(liveGateId || 'None')}</strong> (${escapeHtml(gateStatus)})</div>
    <div>Live Nudges: <strong>${escapeHtml(nudgeCount)}</strong></div>
  </section>`;
}

function renderFactionsThreatsWidget(state, factionsEnabled) {
  if (!factionsEnabled || !state?.entities) {
    return '';
  }
  const factions = safeEntries(state.entities.factions);
  const threats = safeEntries(state.entities.threats);

  const factionRows = factions.map(([id, fac]) => {
    const inf = typeof fac?.influence === 'number' ? fac.influence : 0;
    const pct = clampPercent(inf, 0, 100);
    return `<div class="referee-bridge-meter-row" data-faction-id="${escapeHtml(id)}">
      <div class="referee-bridge-meter-label">
        <span>${escapeHtml(fac?.name || id)} (${escapeHtml(fac?.side || 'neutral')})</span>
        <span>${escapeHtml(inf)}%</span>
      </div>
      <div class="referee-bridge-meter-track">
        <div class="referee-bridge-meter-fill" style="width:${pct}%"></div>
      </div>
    </div>`;
  });

  const threatRows = threats.map(([id, thr]) => {
    const prog = typeof thr?.progress === 'number' ? thr.progress : 0;
    const pct = clampPercent(prog, 0, 100);
    return `<div class="referee-bridge-meter-row" data-threat-id="${escapeHtml(id)}">
      <div class="referee-bridge-meter-label">
        <span>Threat: ${escapeHtml(thr?.name || id)} (Stage ${escapeHtml(thr?.stage ?? 0)})</span>
        <span>${escapeHtml(prog)}%</span>
      </div>
      <div class="referee-bridge-meter-track">
        <div class="referee-bridge-meter-fill" style="width:${pct}%"></div>
      </div>
    </div>`;
  });

  const combined = [...factionRows, ...threatRows].join('');
  return `<section class="referee-bridge-widget" data-widget="factions-threats">
    <div class="referee-bridge-widget-title">Factions &amp; Threats</div>
    ${combined || '<div><em>No active factions or threats</em></div>'}
  </section>`;
}

function renderPendingConfirmationsToast(pendingConfirmations) {
  if (!Array.isArray(pendingConfirmations) || pendingConfirmations.length === 0) {
    return '';
  }

  const itemsHtml = pendingConfirmations
    .map((op, index) => {
      const targetLabel =
        op?.path ??
        (op?.fieldId ? `${op.op}:${op.fieldId}` : op?.sectionId ? `${op.op}:${op.sectionId}` : op?.op ?? 'patch');
      const valueText = op?.value !== undefined ? ` = ${JSON.stringify(op.value)}` : '';
      return `<li data-pending-index="${index}">
        <span>${escapeHtml(targetLabel)}${escapeHtml(valueText)}</span>
        <button type="button" class="referee-bridge-btn" data-action="confirm-accept-index" data-index="${index}">Accept</button>
      </li>`;
    })
    .join('');

  return `<aside class="referee-bridge-toast" data-widget="pending-confirmations">
    <div><strong>Pending Confirmations (${pendingConfirmations.length})</strong></div>
    <ul>${itemsHtml}</ul>
    <div class="referee-bridge-actions">
      <button type="button" class="referee-bridge-btn referee-bridge-btn--primary" data-action="confirm-accept-all">Accept All</button>
      <button type="button" class="referee-bridge-btn" data-action="confirm-reject-all">Reject All</button>
    </div>
  </aside>`;
}

/**
 * Render the Referee HUD panel HTML strictly scoped to enabled SystemPack capabilities and modules.
 * Completely omits RPG/combat/faction panels when disabled (e.g., `stock-slice-of-life` or `stock-freeform`).
 *
 * @param {any} sessionState
 * @param {{ settingRoster?: any }} [options]
 * @returns {string}
 */
export function renderHudStateHtml(sessionState, options = {}) {
  if (!sessionState || typeof sessionState !== 'object') {
    return '<div class="referee-bridge-root" data-referee-hud="empty"><em>No active Referee session</em></div>';
  }

  const state = sessionState.state ?? sessionState;
  const config = sessionState.config ?? {};
  const capabilities = config.capabilities ?? state?.capabilities ?? {};
  const packId = config.packId ?? '';
  const packName = config.packName ?? packId ?? 'Referee Session';
  const turn = state?.meta?.turn ?? 0;

  const clocksMode = capabilities.clocks ?? 'disabled';
  const factionsEnabled = capabilities.factions === true;
  const beatsEnabled = capabilities.beats === true;
  const combatMode = capabilities.combatMode ?? 'disabled';

  const modules = Array.isArray(config.gameSystems)
    ? [...config.gameSystems].sort((a, b) => (a?.ui?.order ?? 0) - (b?.ui?.order ?? 0))
    : [];

  const widgets = [];
  const clockHtml = renderDualClockWidget(state, clocksMode);
  if (clockHtml) widgets.push(clockHtml);

  const sceneHtml = renderSceneCastWidget(state);
  if (sceneHtml) widgets.push(sceneHtml);

  const settingRoster = options?.settingRoster ?? sessionState.settingRoster;
  const rosterHtml = renderSettingRosterWidget(state, settingRoster);
  if (rosterHtml) widgets.push(rosterHtml);

  for (const mod of modules) {
    if (!mod || typeof mod !== 'object') continue;
    const modHtml = renderSingleGameSystem(mod, state, capabilities);
    if (modHtml) widgets.push(modHtml);
  }

  const combatHtml = renderCombatWidget(sessionState.combatState, combatMode);
  if (combatHtml) widgets.push(combatHtml);

  const beatHtml = renderActiveGateBeatWidget(sessionState.beatLedger, beatsEnabled);
  if (beatHtml) widgets.push(beatHtml);

  const factionHtml = renderFactionsThreatsWidget(state, factionsEnabled);
  if (factionHtml) widgets.push(factionHtml);

  const toastHtml = renderPendingConfirmationsToast(sessionState.pendingConfirmations);

  return `<div class="referee-bridge-root" data-referee-hud="active" data-pack-id="${escapeHtml(packId)}">
    <div class="referee-bridge-header">
      <span class="referee-bridge-title">${escapeHtml(packName)}</span>
      <span class="referee-bridge-pill">Turn ${escapeHtml(turn)}</span>
    </div>
    <div class="referee-bridge-hud-grid">
      ${widgets.join('\n')}
    </div>
    ${toastHtml}
  </div>`;
}

/**
 * Alias for `renderHudStateHtml` supporting `{ settingRoster }` options.
 *
 * @param {any} sessionState
 * @param {{ settingRoster?: any }} [options]
 * @returns {string}
 */
export function renderHudPanel(sessionState, options = {}) {
  return renderHudStateHtml(sessionState, options);
}

/**
 * Optional DOM binder for mounting the HUD panel into a container element.
 *
 * @param {HTMLElement} container
 * @param {any} sessionState
 * @param {{ onAcceptAll?: () => void; onRejectAll?: () => void; onAcceptIndex?: (idx: number) => void; settingRoster?: any }} [handlers]
 * @returns {() => void}
 */
export function bindHudPanelDom(container, sessionState, handlers = {}) {
  if (!container || typeof container !== 'object') {
    return () => {};
  }
  container.innerHTML = renderHudStateHtml(sessionState, {
    settingRoster: handlers?.settingRoster,
  });

  const onClick = (event) => {
    const target = event?.target?.closest?.('[data-action]');
    if (!target) return;
    const action = target.getAttribute('data-action');
    if (action === 'confirm-accept-all' && typeof handlers.onAcceptAll === 'function') {
      handlers.onAcceptAll();
    } else if (action === 'confirm-reject-all' && typeof handlers.onRejectAll === 'function') {
      handlers.onRejectAll();
    } else if (action === 'confirm-accept-index' && typeof handlers.onAcceptIndex === 'function') {
      const idx = Number(target.getAttribute('data-index'));
      if (Number.isInteger(idx) && idx >= 0) {
        handlers.onAcceptIndex(idx);
      }
    }
  };

  if (typeof container.addEventListener === 'function') {
    container.addEventListener('click', onClick);
    return () => {
      if (typeof container.removeEventListener === 'function') {
        container.removeEventListener('click', onClick);
      }
    };
  }
  return () => {};
}
