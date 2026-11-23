import { getSafeOwn, isSafePropertyKey, setSafeOwn } from './bridge-client.js';
import { escapeHtml } from './hud-panel.js';

export const STOCK_PACK_IDS = Object.freeze([
  'stock-freeform',
  'stock-slice-of-life',
  'stock-tactical-rpg',
  'stock-living-world',
]);

export const SELECTIVE_PAYLOAD_GROUPS = Object.freeze([
  { id: 'capabilities', label: 'Capabilities' },
  { id: 'characterSections', label: 'Character Sheet Sections' },
  { id: 'gameSystems', label: 'Game System Modules' },
  { id: 'promptSections', label: 'Prompt Sections & Order' },
  { id: 'combatRules', label: 'Combat Rules' },
  { id: 'tuningDials', label: 'Tuning Dials' },
]);

export const DIFF_BADGES = Object.freeze([
  'matches_stock',
  'from_cartridge',
  'user_customized',
]);

const VALID_BADGE_SET = new Set(DIFF_BADGES);
const VALID_GROUP_SET = new Set(SELECTIVE_PAYLOAD_GROUPS.map((g) => g.id));
const VALID_EFFECT_OWNERS = new Set(['engine', 'tracker', 'hybrid']);

function normalizeBadge(badge) {
  return typeof badge === 'string' && VALID_BADGE_SET.has(badge) ? badge : 'matches_stock';
}

function formatBadgeLabel(badge) {
  switch (badge) {
    case 'from_cartridge':
      return 'From Cartridge';
    case 'user_customized':
      return 'User Customized';
    case 'matches_stock':
    default:
      return 'Matches Stock';
  }
}

/**
 * Build a pure Control Room view-model from daemon `listSystemPacks()` + `getSessionState()`.
 *
 * @param {{
 *   systemPacks?: any[];
 *   sessionState?: any;
 *   selectedGroups?: string[];
 *   wizardRequest?: { description?: string; effectOwner?: string; target?: string };
 *   wizardDraft?: any;
 * }} [input]
 */
export function buildControlRoomViewModel(input = {}) {
  const sessionState = input.sessionState ?? {};
  const config = sessionState.config ?? {};
  const diffReport = sessionState.diffReport ?? {};
  const activePackId = typeof config.packId === 'string' ? config.packId : 'stock-freeform';
  const overallBadge = normalizeBadge(diffReport.overallBadge);

  const packsSource = Array.isArray(input.systemPacks) ? input.systemPacks : [];
  const packMap = new Map();
  for (const p of packsSource) {
    if (p && typeof p.id === 'string' && isSafePropertyKey(p.id)) {
      packMap.set(p.id, p);
    }
  }
  for (const stockId of STOCK_PACK_IDS) {
    if (!packMap.has(stockId)) {
      packMap.set(stockId, { id: stockId, name: stockId, description: '' });
    }
  }

  const systemPacks = Array.from(packMap.values()).map((pack) => ({
    id: pack.id,
    name: pack.name ?? pack.id,
    description: pack.description ?? '',
    isActive: pack.id === activePackId,
    isStock: STOCK_PACK_IDS.includes(pack.id),
  }));

  const selectedGroupSet = new Set(
    Array.isArray(input.selectedGroups) && input.selectedGroups.length > 0
      ? input.selectedGroups.filter((g) => VALID_GROUP_SET.has(g))
      : SELECTIVE_PAYLOAD_GROUPS.map((g) => g.id)
  );

  const selectiveGroups = SELECTIVE_PAYLOAD_GROUPS.map((group) => {
    const badge = normalizeBadge(getSafeOwn(diffReport.groupBadges, group.id));
    return {
      id: group.id,
      label: group.label,
      selected: selectedGroupSet.has(group.id),
      badge,
      badgeLabel: formatBadgeLabel(badge),
    };
  });

  const modules = Array.isArray(config.gameSystems)
    ? config.gameSystems.map((mod) => {
        const diffEntry = getSafeOwn(diffReport.gameSystems, mod.id);
        const badge = normalizeBadge(
          diffEntry && typeof diffEntry === 'object' ? diffEntry.badge : undefined
        );
        return {
          id: mod.id,
          name: mod.name ?? mod.id,
          description: mod.description ?? '',
          enabled: mod.enabled !== false,
          effectOwner: mod.effectOwner ?? 'tracker',
          cadence: mod.cadence ?? 'every_turn',
          widget: mod.ui?.widget ?? 'card',
          badge,
          badgeLabel: formatBadgeLabel(badge),
        };
      })
    : [];

  const pcSections = Array.isArray(config.pcCoreSections)
    ? config.pcCoreSections.map((sec) => ({ ...sec }))
    : [];
  const npcSections = Array.isArray(config.npcCoreSections)
    ? config.npcCoreSections.map((sec) => ({ ...sec }))
    : [];

  const order = Array.isArray(config.syspromptSectionOrder) ? config.syspromptSectionOrder : [];
  const sectionIds = new Set(order);
  if (diffReport.promptSections && typeof diffReport.promptSections === 'object') {
    for (const key of Object.keys(diffReport.promptSections)) {
      if (isSafePropertyKey(key)) {
        sectionIds.add(key);
      }
    }
  }
  const promptSections = Array.from(sectionIds).map((secId) => {
    const diffEntry = getSafeOwn(diffReport.promptSections, secId);
    const badge = normalizeBadge(
      diffEntry && typeof diffEntry === 'object' ? diffEntry.badge : undefined
    );
    const unlocked =
      Boolean(getSafeOwn(config.unlockedPromptSections, secId)) ||
      Boolean(diffEntry && typeof diffEntry === 'object' && diffEntry.unlocked);
    const text = getSafeOwn(config.basePrompts, secId);
    return {
      sectionId: secId,
      badge,
      badgeLabel: formatBadgeLabel(badge),
      unlocked,
      text: typeof text === 'string' ? text : '',
    };
  });

  const wizardReq = input.wizardRequest ?? {};
  const wizard = {
    description: typeof wizardReq.description === 'string' ? wizardReq.description : '',
    effectOwner:
      typeof wizardReq.effectOwner === 'string' && VALID_EFFECT_OWNERS.has(wizardReq.effectOwner)
        ? wizardReq.effectOwner
        : 'hybrid',
    target: typeof wizardReq.target === 'string' ? wizardReq.target : 'global',
    draft: input.wizardDraft ?? null,
  };

  return {
    activePackId,
    overallBadge,
    overallBadgeLabel: formatBadgeLabel(overallBadge),
    systemPacks,
    selectiveGroups,
    modules,
    pcSections,
    npcSections,
    promptSections,
    tuningDials: config.tuningDials ?? {},
    wizard,
  };
}

/**
 * Build a `PATCH /api/sessions/:id/control-room` payload for switching packs (optionally selective).
 *
 * @param {string} systemPackId
 * @param {string[]} [selectedGroups]
 * @returns {Record<string, unknown>}
 */
export function buildSwitchPackPayload(systemPackId, selectedGroups) {
  if (typeof systemPackId !== 'string' || !isSafePropertyKey(systemPackId.trim())) {
    throw new Error('systemPackId must be a safe non-empty string');
  }
  /** @type {Record<string, unknown>} */
  const payload = { systemPackId: systemPackId.trim() };
  if (Array.isArray(selectedGroups) && selectedGroups.length > 0) {
    payload.selectedGroups = selectedGroups.filter((g) => VALID_GROUP_SET.has(g));
  }
  return payload;
}

/**
 * Build a `PATCH /api/sessions/:id/control-room` payload toggling a single Game System module.
 *
 * @param {string} moduleId
 * @param {boolean} enabled
 * @returns {Record<string, unknown>}
 */
export function buildModuleTogglePayload(moduleId, enabled) {
  if (typeof moduleId !== 'string' || !isSafePropertyKey(moduleId.trim())) {
    throw new Error('moduleId must be a safe non-empty string');
  }
  const overrides = {};
  setSafeOwn(overrides, moduleId.trim(), { enabled: Boolean(enabled) });
  return { gameSystemOverrides: overrides };
}

/**
 * Build a `PATCH /api/sessions/:id/control-room` payload updating PC or NPC sheet sections.
 *
 * @param {'pc' | 'npc'} target
 * @param {Array<Record<string, unknown>>} sections
 * @returns {Record<string, unknown>}
 */
export function buildSheetSectionsPayload(target, sections) {
  if (target !== 'pc' && target !== 'npc') {
    throw new Error('target must be "pc" or "npc"');
  }
  const cloned = Array.isArray(sections) ? sections.map((s) => ({ ...s })) : [];
  return target === 'pc' ? { pcCoreSections: cloned } : { npcCoreSections: cloned };
}

/**
 * Build a `PATCH /api/sessions/:id/control-room` payload editing a prompt section override.
 *
 * @param {string} sectionId
 * @param {string} text
 * @param {boolean} [unlocked]
 * @returns {Record<string, unknown>}
 */
export function buildPromptSectionPayload(sectionId, text, unlocked = true) {
  if (typeof sectionId !== 'string' || !isSafePropertyKey(sectionId.trim())) {
    throw new Error('sectionId must be a safe non-empty string');
  }
  const cleanId = sectionId.trim();
  const basePrompts = {};
  setSafeOwn(basePrompts, cleanId, typeof text === 'string' ? text : '');
  const unlockedPromptSections = {};
  setSafeOwn(unlockedPromptSections, cleanId, Boolean(unlocked));
  return { basePrompts, unlockedPromptSections };
}

/**
 * Build a `PATCH /api/sessions/:id/control-room` payload updating tuning dials.
 *
 * @param {Record<string, unknown>} tuningDials
 * @returns {Record<string, unknown>}
 */
export function buildTuningDialsPayload(tuningDials) {
  return {
    tuningDials: tuningDials && typeof tuningDials === 'object' ? { ...tuningDials } : {},
  };
}

/**
 * Build a `POST /api/wizard/generate` request payload.
 *
 * @param {{
 *   description: string;
 *   effectOwner?: 'engine' | 'tracker' | 'hybrid';
 *   target?: 'global' | 'player' | 'npc' | 'location';
 *   loreContext?: string;
 *   previousDraft?: Record<string, unknown>;
 *   refinementFeedback?: string;
 * }} params
 * @returns {Record<string, unknown>}
 */
export function buildWizardGenerateRequest(params) {
  const description = typeof params?.description === 'string' ? params.description.trim() : '';
  if (!description && !params?.previousDraft) {
    throw new Error('Wizard description is required when previousDraft is omitted');
  }
  const effectOwner =
    typeof params?.effectOwner === 'string' && VALID_EFFECT_OWNERS.has(params.effectOwner)
      ? params.effectOwner
      : 'hybrid';

  /** @type {Record<string, unknown>} */
  const req = {
    description,
    effectOwner,
  };
  if (typeof params?.target === 'string' && params.target.length > 0) {
    req.target = params.target;
  }
  if (typeof params?.loreContext === 'string' && params.loreContext.length > 0) {
    req.loreContext = params.loreContext;
  }
  if (params?.previousDraft && typeof params.previousDraft === 'object') {
    req.previousDraft = params.previousDraft;
  }
  if (typeof params?.refinementFeedback === 'string' && params.refinementFeedback.length > 0) {
    req.refinementFeedback = params.refinementFeedback;
  }
  return req;
}

/**
 * Build a `PATCH /api/sessions/:id/control-room` payload that installs a Wizard-generated
 * module into the active session using `createIfMissing: true`.
 *
 * @param {{ module?: Record<string, any> } | Record<string, any>} wizardResult
 * @returns {Record<string, unknown>}
 */
export function buildApplyWizardModulePayload(wizardResult) {
  const mod = wizardResult?.module ?? wizardResult;
  if (!mod || typeof mod !== 'object' || typeof mod.id !== 'string' || !isSafePropertyKey(mod.id)) {
    throw new Error('Wizard result must contain a valid module with a safe id');
  }

  const override = {
    name: mod.name,
    ...(mod.description !== undefined ? { description: mod.description } : {}),
    enabled: mod.enabled !== false,
    scope: mod.scope ?? 'session',
    target: mod.target ?? 'global',
    effectOwner: mod.effectOwner ?? 'hybrid',
    cadence: mod.cadence ?? 'every_turn',
    fields: mod.fields ?? {},
    trackerInstruction: mod.trackerInstruction ?? '',
    narratorRule: mod.narratorRule ?? '',
    ui: mod.ui ?? { widget: 'card', order: 10 },
    createIfMissing: true,
  };

  const gameSystemOverrides = {};
  setSafeOwn(gameSystemOverrides, mod.id, override);
  return { gameSystemOverrides };
}

/**
 * Render the Control Room Modal + Game System Wizard Drawer HTML from a view-model.
 *
 * @param {ReturnType<typeof buildControlRoomViewModel>} viewModel
 * @returns {string}
 */
export function renderControlRoomModalHtml(viewModel) {
  const vm = viewModel ?? buildControlRoomViewModel();

  const packButtons = vm.systemPacks
    .map(
      (p) => `<label class="referee-bridge-section-card" data-pack-id="${escapeHtml(p.id)}">
        <input type="radio" name="referee-system-pack" value="${escapeHtml(p.id)}" ${
        p.isActive ? 'checked' : ''
      } data-cr-action="select-pack" />
        <strong>${escapeHtml(p.name)}</strong>
        <div><small>${escapeHtml(p.description || p.id)}</small></div>
      </label>`
    )
    .join('');

  const groupCheckboxes = vm.selectiveGroups
    .map(
      (g) => `<label class="referee-bridge-section-card" data-group-id="${escapeHtml(g.id)}">
        <input type="checkbox" value="${escapeHtml(g.id)}" ${
        g.selected ? 'checked' : ''
      } data-cr-action="toggle-group" />
        <span>${escapeHtml(g.label)}</span>
        <span class="referee-bridge-badge referee-bridge-badge--${escapeHtml(
          g.badge
        )}" data-badge="${escapeHtml(g.badge)}">${escapeHtml(g.badgeLabel)}</span>
      </label>`
    )
    .join('');

  const moduleRows = vm.modules
    .map(
      (m) => `<div class="referee-bridge-section-card" data-module-id="${escapeHtml(m.id)}">
        <label>
          <input type="checkbox" ${m.enabled ? 'checked' : ''} data-cr-action="toggle-module" data-module-id="${escapeHtml(
        m.id
      )}" />
          <strong>${escapeHtml(m.name)}</strong>
        </label>
        <span class="referee-bridge-badge referee-bridge-badge--${escapeHtml(
          m.badge
        )}" data-badge="${escapeHtml(m.badge)}">${escapeHtml(m.badgeLabel)}</span>
        <span class="referee-bridge-pill">${escapeHtml(m.effectOwner)}</span>
      </div>`
    )
    .join('');

  const renderSectionList = (sections, target) =>
    sections
      .map(
        (s) => `<div class="referee-bridge-section-card" data-sheet-target="${escapeHtml(
          target
        )}" data-section-id="${escapeHtml(s.id)}">
          <strong>${escapeHtml(s.name || s.id)}</strong> (${escapeHtml(s.fieldType || 'prose')})
          <input type="text" class="referee-bridge-input" data-cr-sheet-name="${escapeHtml(
            s.id
          )}" value="${escapeHtml(s.name || s.id)}" />
        </div>`
      )
      .join('');

  const promptRows = vm.promptSections
    .map(
      (sec) => `<div class="referee-bridge-section-card" data-prompt-section-id="${escapeHtml(
        sec.sectionId
      )}">
        <div>
          <strong>${escapeHtml(sec.sectionId)}</strong>
          <span class="referee-bridge-badge referee-bridge-badge--${escapeHtml(
            sec.badge
          )}" data-badge="${escapeHtml(sec.badge)}">${escapeHtml(sec.badgeLabel)}</span>
          <label><input type="checkbox" ${
            sec.unlocked ? 'checked' : ''
          } data-cr-action="toggle-prompt-unlock" data-section-id="${escapeHtml(
        sec.sectionId
      )}" /> Unlocked</label>
        </div>
        <textarea class="referee-bridge-textarea" rows="2" data-cr-prompt-text="${escapeHtml(
          sec.sectionId
        )}" ${sec.unlocked ? '' : 'readonly'}>${escapeHtml(sec.text)}</textarea>
      </div>`
    )
    .join('');

  const wizardDraftHtml = vm.wizard.draft
    ? `<div class="referee-bridge-section-card" data-wizard-preview="true">
        <div><strong>Preview: ${escapeHtml(vm.wizard.draft.module?.name ?? vm.wizard.draft.module?.id ?? 'Draft')}</strong></div>
        <pre>${escapeHtml(vm.wizard.draft.previewSummary ?? JSON.stringify(vm.wizard.draft.previewCard ?? {}, null, 2))}</pre>
        <button type="button" class="referee-bridge-btn referee-bridge-btn--primary" data-cr-action="wizard-apply">Apply Module to Session</button>
      </div>`
    : '';

  return `<div class="referee-bridge-modal" data-referee-control-room="true">
    <div class="referee-bridge-header">
      <span class="referee-bridge-title">Referee Control Room</span>
      <span class="referee-bridge-badge referee-bridge-badge--${escapeHtml(
        vm.overallBadge
      )}" data-overall-badge="${escapeHtml(vm.overallBadge)}">${escapeHtml(
    vm.overallBadgeLabel
  )}</span>
    </div>

    <section class="referee-bridge-section-card" data-cr-panel="system-packs">
      <div class="referee-bridge-widget-title">System Pack &amp; Selective Group Picker</div>
      <div class="referee-bridge-pack-list">${packButtons}</div>
      <div class="referee-bridge-widget-title" style="margin-top:8px">Selective Groups</div>
      <div class="referee-bridge-group-list">${groupCheckboxes}</div>
      <div class="referee-bridge-actions">
        <button type="button" class="referee-bridge-btn referee-bridge-btn--primary" data-cr-action="apply-pack">Apply System Pack</button>
      </div>
    </section>

    <section class="referee-bridge-section-card" data-cr-panel="modules">
      <div class="referee-bridge-widget-title">Game System Modules</div>
      ${moduleRows || '<div><em>No modules</em></div>'}
    </section>

    <section class="referee-bridge-section-card" data-cr-panel="sheet-sections">
      <div class="referee-bridge-widget-title">Character Sheet Sections</div>
      <div><small>PC Sections</small></div>
      ${renderSectionList(vm.pcSections, 'pc') || '<div><em>None</em></div>'}
      <div style="margin-top:6px"><small>NPC Sections</small></div>
      ${renderSectionList(vm.npcSections, 'npc') || '<div><em>None</em></div>'}
    </section>

    <section class="referee-bridge-section-card" data-cr-panel="prompt-sections">
      <div class="referee-bridge-widget-title">Prompt Sections &amp; Diff Badges</div>
      ${promptRows}
    </section>

    <section class="referee-bridge-wizard-drawer" data-cr-panel="wizard-drawer">
      <div class="referee-bridge-widget-title">Game System Wizard</div>
      <div class="referee-bridge-actions">
        <textarea class="referee-bridge-textarea" rows="2" style="flex:1" data-wizard-input="description" placeholder="Describe a custom game system (e.g., Sanity meter or Ward integrity)...">${escapeHtml(
          vm.wizard.description
        )}</textarea>
        <select class="referee-bridge-select" data-wizard-input="effectOwner">
          <option value="hybrid" ${vm.wizard.effectOwner === 'hybrid' ? 'selected' : ''}>hybrid</option>
          <option value="tracker" ${vm.wizard.effectOwner === 'tracker' ? 'selected' : ''}>tracker</option>
          <option value="engine" ${vm.wizard.effectOwner === 'engine' ? 'selected' : ''}>engine</option>
        </select>
        <button type="button" class="referee-bridge-btn referee-bridge-btn--primary" data-cr-action="wizard-generate">Generate Preview</button>
      </div>
      ${wizardDraftHtml}
    </section>
  </div>`;
}

/**
 * Optional DOM binder for the Control Room Modal.
 *
 * @param {HTMLElement} container
 * @param {ReturnType<typeof buildControlRoomViewModel>} viewModel
 * @param {{
 *   onApplyPack?: (payload: Record<string, unknown>) => void;
 *   onToggleModule?: (payload: Record<string, unknown>) => void;
 *   onWizardGenerate?: (req: Record<string, unknown>) => void;
 *   onWizardApply?: (payload: Record<string, unknown>) => void;
 * }} [handlers]
 * @returns {() => void}
 */
export function bindControlRoomModalDom(container, viewModel, handlers = {}) {
  if (!container || typeof container !== 'object') {
    return () => {};
  }
  container.innerHTML = renderControlRoomModalHtml(viewModel);

  const onClick = (event) => {
    const target = event?.target?.closest?.('[data-cr-action]');
    if (!target) return;
    const action = target.getAttribute('data-cr-action');

    if (action === 'apply-pack' && typeof handlers.onApplyPack === 'function') {
      const checkedPack = container.querySelector?.('input[name="referee-system-pack"]:checked');
      const packId = checkedPack?.value ?? viewModel.activePackId;
      const groupNodes = container.querySelectorAll?.('[data-cr-action="toggle-group"]:checked') ?? [];
      const selectedGroups = Array.from(groupNodes).map((n) => n.value);
      handlers.onApplyPack(buildSwitchPackPayload(packId, selectedGroups));
    } else if (action === 'toggle-module' && typeof handlers.onToggleModule === 'function') {
      const modId = target.getAttribute('data-module-id');
      if (modId) {
        handlers.onToggleModule(buildModuleTogglePayload(modId, Boolean(target.checked)));
      }
    } else if (action === 'wizard-generate' && typeof handlers.onWizardGenerate === 'function') {
      const descEl = container.querySelector?.('[data-wizard-input="description"]');
      const ownerEl = container.querySelector?.('[data-wizard-input="effectOwner"]');
      const req = buildWizardGenerateRequest({
        description: descEl?.value ?? '',
        effectOwner: ownerEl?.value ?? 'hybrid',
      });
      handlers.onWizardGenerate(req);
    } else if (
      action === 'wizard-apply' &&
      viewModel.wizard?.draft &&
      typeof handlers.onWizardApply === 'function'
    ) {
      handlers.onWizardApply(buildApplyWizardModulePayload(viewModel.wizard.draft));
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
