import { getSafeOwn, isSafePropertyKey, setSafeOwn } from './bridge-client.js';
import { escapeHtml } from './hud-panel.js';

export const STOCK_PACK_IDS = Object.freeze([
  'stock-freeform',
  'stock-slice-of-life',
  'stock-tactical-rpg',
  'stock-living-world',
]);

export const SHEET_PRESET_IDS = Object.freeze([
  'realistic-modern',
  'dnd-adventurer',
  'superhero-dossier',
  'intimate-profile',
]);

export const SHEET_PRESETS = Object.freeze([
  { id: 'realistic-modern', label: 'Realistic Modern' },
  { id: 'dnd-adventurer', label: 'D&D Adventurer' },
  { id: 'superhero-dossier', label: 'Superhero Dossier' },
  { id: 'intimate-profile', label: 'Intimate Profile' },
]);

export const CONNECTION_PROVIDERS = Object.freeze([
  'openai_compatible',
  'ollama',
  'anthropic',
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
const VALID_SHEET_PRESET_SET = new Set(SHEET_PRESET_IDS);
const VALID_PROVIDER_SET = new Set(CONNECTION_PROVIDERS);
const TEXT_COMPLETION_APIS = new Set(['textgenerationwebui', 'kobold', 'koboldhorde', 'novel']);

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasSafeKeys(obj) {
  return isPlainRecord(obj) && Object.keys(obj).some((k) => isSafePropertyKey(k));
}

function sanitizeJsonCopy(value) {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeJsonCopy(item));
  }
  if (isPlainRecord(value)) {
    const out = {};
    for (const key of Object.keys(value)) {
      if (!isSafePropertyKey(key)) continue;
      const val = getSafeOwn(value, key);
      if (val !== undefined) {
        setSafeOwn(out, key, sanitizeJsonCopy(val));
      }
    }
    return out;
  }
  return value;
}

function firstFiniteNumber(obj, keys) {
  for (const key of keys) {
    const val = getSafeOwn(obj, key);
    if (typeof val === 'number' && Number.isFinite(val)) {
      return val;
    }
  }
  return undefined;
}

function firstNonEmptyString(obj, keys) {
  for (const key of keys) {
    const val = getSafeOwn(obj, key);
    if (typeof val === 'string' && val.trim().length > 0) {
      return val.trim();
    }
  }
  return undefined;
}

function extractStringList(obj, keys) {
  for (const key of keys) {
    const val = getSafeOwn(obj, key);
    if (Array.isArray(val) && val.every((item) => typeof item === 'string')) {
      return [...val];
    }
  }
  return undefined;
}

function slugifyPersonaId(name) {
  const slug = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? `st-${slug}` : 'st-player';
}

/**
 * Extract and normalize the active SillyTavern preset settings from a SillyTavern context
 * into a clean payload ready for `RefereeBridgeClient.importPreset({ preset, sessionId })`.
 *
 * Reads `ctx.chatCompletionSettings` (or `ctx.oai_settings`) and falls back to
 * `ctx.textgenerationwebui_settings` / `ctx.kai_settings` when Chat Completion settings are absent.
 *
 * @param {any} ctx
 * @returns {Record<string, unknown> | null}
 */
export function extractActiveSillyTavernPreset(ctx) {
  if (!ctx || typeof ctx !== 'object') {
    return null;
  }

  const explicitChat = hasSafeKeys(ctx.chatCompletionSettings) ? ctx.chatCompletionSettings : null;
  const oaiChat = hasSafeKeys(ctx.oai_settings) ? ctx.oai_settings : null;
  const textGen = hasSafeKeys(ctx.textgenerationwebui_settings)
    ? ctx.textgenerationwebui_settings
    : hasSafeKeys(ctx.kai_settings)
      ? ctx.kai_settings
      : null;

  const mainApi = typeof ctx.main_api === 'string' ? ctx.main_api.toLowerCase() : '';
  const preferText = !explicitChat && TEXT_COMPLETION_APIS.has(mainApi) && textGen !== null;
  const chatSettings = preferText ? null : explicitChat ?? oaiChat;

  if (chatSettings) {
    /** @type {Record<string, unknown>} */
    const preset = {};
    const name =
      firstNonEmptyString(chatSettings, ['preset_name', 'name', 'preset_settings_openai']) ??
      firstNonEmptyString(ctx, ['preset_name', 'oai_preset_name']) ??
      'SillyTavern Chat Preset';
    setSafeOwn(preset, 'name', name);

    const chatSource =
      firstNonEmptyString(chatSettings, ['chat_completion_source']) ?? 'openai';
    setSafeOwn(preset, 'chat_completion_source', chatSource);

    const numericMappings = [
      ['temperature', ['temperature', 'temp_openai', 'temp']],
      ['openai_max_tokens', ['openai_max_tokens', 'max_tokens']],
      ['openai_max_context', ['openai_max_context', 'max_context']],
      ['top_p', ['top_p', 'top_p_openai']],
      ['top_k', ['top_k', 'top_k_openai']],
      ['min_p', ['min_p', 'min_p_openai']],
      ['top_a', ['top_a', 'top_a_openai']],
      ['typical_p', ['typical_p', 'typical']],
      ['tfs', ['tfs']],
      ['frequency_penalty', ['frequency_penalty', 'freq_pen_openai', 'freq_pen']],
      ['presence_penalty', ['presence_penalty', 'pres_pen_openai', 'pres_pen']],
      ['repetition_penalty', ['repetition_penalty', 'rep_pen_openai', 'rep_pen']],
      ['seed', ['seed']],
    ];
    for (const [targetKey, sourceKeys] of numericMappings) {
      const val = firstFiniteNumber(chatSettings, sourceKeys);
      if (val !== undefined) {
        setSafeOwn(preset, targetKey, val);
      }
    }

    const stop = extractStringList(chatSettings, ['stop', 'custom_stopping_strings']);
    if (stop !== undefined) {
      setSafeOwn(preset, 'stop', stop);
    }

    const templateKeys = [
      'wi_format',
      'scenario_format',
      'personality_format',
      'impersonation_prompt',
      'new_chat_prompt',
      'continue_nudge_prompt',
    ];
    for (const tplKey of templateKeys) {
      const val = getSafeOwn(chatSettings, tplKey);
      if (typeof val === 'string') {
        setSafeOwn(preset, tplKey, val);
      }
    }

    const prompts = getSafeOwn(chatSettings, 'prompts');
    if (Array.isArray(prompts)) {
      setSafeOwn(preset, 'prompts', sanitizeJsonCopy(prompts));
    }
    const promptOrder = getSafeOwn(chatSettings, 'prompt_order');
    if (Array.isArray(promptOrder)) {
      setSafeOwn(preset, 'prompt_order', sanitizeJsonCopy(promptOrder));
    }

    return preset;
  }

  if (textGen) {
    /** @type {Record<string, unknown>} */
    const preset = {};
    const name =
      firstNonEmptyString(textGen, ['preset_name', 'name']) ??
      firstNonEmptyString(ctx, ['preset_name']) ??
      'SillyTavern Text Preset';
    setSafeOwn(preset, 'name', name);

    const numericMappings = [
      ['temp', ['temp', 'temperature']],
      ['amount_gen', ['amount_gen', 'max_length', 'max_tokens']],
      ['max_context', ['max_context', 'max_context_length']],
      ['top_p', ['top_p']],
      ['top_k', ['top_k']],
      ['min_p', ['min_p']],
      ['top_a', ['top_a']],
      ['typical', ['typical', 'typical_p']],
      ['tfs', ['tfs']],
      ['freq_pen', ['freq_pen', 'frequency_penalty']],
      ['pres_pen', ['pres_pen', 'presence_penalty']],
      ['rep_pen', ['rep_pen', 'repetition_penalty']],
      ['seed', ['seed']],
    ];
    for (const [targetKey, sourceKeys] of numericMappings) {
      const val = firstFiniteNumber(textGen, sourceKeys);
      if (val !== undefined) {
        setSafeOwn(preset, targetKey, val);
      }
    }

    const stopSeq = extractStringList(textGen, ['stop_sequence', 'stopping_strings', 'stop']);
    if (stopSeq !== undefined) {
      setSafeOwn(preset, 'stop_sequence', stopSeq);
    }

    const textStringKeys = [
      'story_string',
      'input_sequence',
      'output_sequence',
      'system_sequence',
      'system_prompt',
      'wi_format',
      'scenario_format',
      'personality_format',
      'impersonation_prompt',
      'new_chat_prompt',
      'continue_nudge_prompt',
    ];
    for (const key of textStringKeys) {
      const fromSettings = getSafeOwn(textGen, key);
      if (typeof fromSettings === 'string') {
        setSafeOwn(preset, key, fromSettings);
      }
    }

    const wrap = getSafeOwn(textGen, 'wrap');
    if (typeof wrap === 'boolean') {
      setSafeOwn(preset, 'wrap', wrap);
    }

    // Ensure text-completion preset detection triggers even for minimal settings objects
    const hasMarker =
      getSafeOwn(preset, 'amount_gen') !== undefined ||
      getSafeOwn(preset, 'rep_pen') !== undefined ||
      getSafeOwn(preset, 'story_string') !== undefined ||
      getSafeOwn(preset, 'input_sequence') !== undefined ||
      getSafeOwn(preset, 'output_sequence') !== undefined ||
      getSafeOwn(preset, 'system_sequence') !== undefined ||
      getSafeOwn(preset, 'wrap') !== undefined ||
      getSafeOwn(preset, 'system_prompt') !== undefined;
    if (!hasMarker) {
      setSafeOwn(preset, 'rep_pen', 1);
    }

    return preset;
  }

  return null;
}

/**
 * Extract the active SillyTavern user persona from `ctx`.
 *
 * @param {any} ctx
 * @returns {{ id: string; name: string; description: string }}
 */
export function extractActiveSillyTavernPersona(ctx) {
  const rawName =
    typeof ctx?.name1 === 'string' && ctx.name1.trim().length > 0 ? ctx.name1.trim() : 'Player';
  const rawDesc =
    typeof ctx?.powerUserSettings?.persona_description === 'string'
      ? ctx.powerUserSettings.persona_description
      : typeof ctx?.power_user?.persona_description === 'string'
        ? ctx.power_user.persona_description
        : typeof ctx?.persona_description === 'string'
          ? ctx.persona_description
          : '';
  return {
    id: slugifyPersonaId(rawName),
    name: rawName,
    description: rawDesc,
  };
}

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

  const sessionId =
    typeof input.sessionId === 'string' && input.sessionId.trim().length > 0
      ? input.sessionId.trim()
      : typeof sessionState.sessionId === 'string' && sessionState.sessionId.trim().length > 0
        ? sessionState.sessionId.trim()
        : null;

  const sheetPresetId =
    typeof input.sheetPresetId === 'string' && VALID_SHEET_PRESET_SET.has(input.sheetPresetId)
      ? input.sheetPresetId
      : typeof config.sheetPresetId === 'string' && VALID_SHEET_PRESET_SET.has(config.sheetPresetId)
        ? config.sheetPresetId
        : SHEET_PRESET_IDS[0];
  const sheetPresets = SHEET_PRESETS.map((preset) => ({
    ...preset,
    selected: preset.id === sheetPresetId,
  }));

  const gen = isPlainRecord(config.generation) ? config.generation : {};
  const generation = {
    presetName: typeof gen.presetName === 'string' ? gen.presetName : '',
    sourceFormat: typeof gen.sourceFormat === 'string' ? gen.sourceFormat : '',
    temperature: typeof gen.temperature === 'number' && Number.isFinite(gen.temperature) ? gen.temperature : null,
    maxTokens: typeof gen.maxTokens === 'number' && Number.isFinite(gen.maxTokens) ? gen.maxTokens : null,
    maxContextTokens:
      typeof gen.maxContextTokens === 'number' && Number.isFinite(gen.maxContextTokens)
        ? gen.maxContextTokens
        : null,
  };

  const rawPersona = input.activePersona ?? sessionState.activePersona ?? null;
  const activePersona =
    rawPersona && typeof rawPersona === 'object' && typeof rawPersona.name === 'string'
      ? {
          id: typeof rawPersona.id === 'string' ? rawPersona.id : slugifyPersonaId(rawPersona.name),
          name: rawPersona.name,
          description: typeof rawPersona.description === 'string' ? rawPersona.description : '',
        }
      : null;

  const rawConnections = isPlainRecord(input.connections)
    ? input.connections
    : isPlainRecord(sessionState.connections)
      ? sessionState.connections
      : {};
  const rawDefaultConn = isPlainRecord(rawConnections.defaultConnection)
    ? rawConnections.defaultConnection
    : {};
  const rawProvider = typeof rawDefaultConn.provider === 'string' ? rawDefaultConn.provider : 'openai_compatible';
  const rawProfiles = rawConnections.profiles;
  const profileNames = Array.isArray(rawProfiles)
    ? rawProfiles.filter((name) => typeof name === 'string' && isSafePropertyKey(name))
    : isPlainRecord(rawProfiles)
      ? Object.keys(rawProfiles).filter((name) => isSafePropertyKey(name))
      : [];

  const connections = {
    activeProfile:
      typeof rawConnections.activeProfile === 'string' && rawConnections.activeProfile.trim().length > 0
        ? rawConnections.activeProfile.trim()
        : null,
    profiles: profileNames,
    defaultConnection: {
      provider: VALID_PROVIDER_SET.has(rawProvider) ? rawProvider : 'openai_compatible',
      baseUrl: typeof rawDefaultConn.baseUrl === 'string' ? rawDefaultConn.baseUrl : '',
      model: typeof rawDefaultConn.model === 'string' ? rawDefaultConn.model : '',
      temperature:
        typeof rawDefaultConn.temperature === 'number' && Number.isFinite(rawDefaultConn.temperature)
          ? rawDefaultConn.temperature
          : null,
      maxTokens:
        typeof rawDefaultConn.maxTokens === 'number' && Number.isFinite(rawDefaultConn.maxTokens)
          ? rawDefaultConn.maxTokens
          : null,
    },
  };

  return {
    sessionId,
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
    sheetPresetId,
    sheetPresets,
    generation,
    activePersona,
    connections,
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
 * Build a `POST /api/sessions/:id/control-room/apply-preset` payload for a sheet preset.
 *
 * @param {string} sheetPresetId
 * @param {'pc' | 'npc' | 'both'} [target]
 * @returns {Record<string, unknown>}
 */
export function buildApplySheetPresetPayload(sheetPresetId, target) {
  if (typeof sheetPresetId !== 'string' || !VALID_SHEET_PRESET_SET.has(sheetPresetId.trim())) {
    throw new Error(
      `sheetPresetId must be one of: ${SHEET_PRESET_IDS.join(', ')}`
    );
  }
  /** @type {Record<string, unknown>} */
  const payload = { sheetPresetId: sheetPresetId.trim() };
  if (target === 'pc' || target === 'npc' || target === 'both') {
    payload.target = target;
  }
  return payload;
}

/**
 * Build a `PUT /api/connections` payload from Backend Connections editor fields.
 *
 * @param {{
 *   provider?: string;
 *   baseUrl?: string;
 *   model?: string;
 *   apiKey?: string;
 *   temperature?: number | string | null;
 *   maxTokens?: number | string | null;
 * }} input
 * @returns {Record<string, unknown>}
 */
export function buildConnectionsUpdatePayload(input) {
  const provider =
    typeof input?.provider === 'string' && VALID_PROVIDER_SET.has(input.provider.trim())
      ? input.provider.trim()
      : 'openai_compatible';
  const baseUrl = typeof input?.baseUrl === 'string' ? input.baseUrl.trim() : '';
  const model = typeof input?.model === 'string' ? input.model.trim() : '';
  if (!baseUrl) {
    throw new Error('defaultConnection.baseUrl must be a non-empty string');
  }
  if (!model) {
    throw new Error('defaultConnection.model must be a non-empty string');
  }

  /** @type {Record<string, unknown>} */
  const defaultConnection = {
    provider,
    baseUrl,
    model,
  };

  if (typeof input?.apiKey === 'string' && input.apiKey.length > 0) {
    defaultConnection.apiKey = input.apiKey;
  }

  const parseOptionalNumber = (raw) => {
    if (raw === null || raw === undefined || raw === '') return undefined;
    const num = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(num) ? num : undefined;
  };

  const temperature = parseOptionalNumber(input?.temperature);
  if (temperature !== undefined) {
    defaultConnection.temperature = temperature;
  }
  const maxTokens = parseOptionalNumber(input?.maxTokens);
  if (maxTokens !== undefined) {
    defaultConnection.maxTokens = Math.floor(maxTokens);
  }

  return { defaultConnection };
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

  const sheetPresetsList = Array.isArray(vm.sheetPresets)
    ? vm.sheetPresets
    : SHEET_PRESETS.map((p) => ({ ...p, selected: p.id === SHEET_PRESET_IDS[0] }));
  const sheetPresetOptions = sheetPresetsList
    .map(
      (preset) =>
        `<option value="${escapeHtml(preset.id)}" ${
          preset.selected ? 'selected' : ''
        }>${escapeHtml(preset.label)}</option>`
    )
    .join('');

  const genSummary = vm.generation ?? {};
  const personaSummary = vm.activePersona ?? null;
  const conn = vm.connections ?? {
    activeProfile: null,
    profiles: [],
    defaultConnection: {
      provider: 'openai_compatible',
      baseUrl: '',
      model: '',
      temperature: null,
      maxTokens: null,
    },
  };
  const dc = conn.defaultConnection ?? {};
  const providerOptions = CONNECTION_PROVIDERS.map(
    (prov) =>
      `<option value="${escapeHtml(prov)}" ${
        dc.provider === prov ? 'selected' : ''
      }>${escapeHtml(prov)}</option>`
  ).join('');
  const profileList = Array.isArray(conn.profiles) ? conn.profiles : [];
  const profileSelectorHtml =
    profileList.length > 0
      ? `<div class="referee-bridge-actions" style="margin-top:6px">
          <select class="referee-bridge-select" data-conn-input="activateProfileName">
            ${profileList
              .map(
                (name) =>
                  `<option value="${escapeHtml(name)}" ${
                    conn.activeProfile === name ? 'selected' : ''
                  }>${escapeHtml(name)}</option>`
              )
              .join('')}
          </select>
          <button type="button" class="referee-bridge-btn" data-cr-action="activate-connection-profile">Activate Profile</button>
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

    <section class="referee-bridge-section-card" data-cr-panel="st-sync">
      <div class="referee-bridge-widget-title">SillyTavern Sync &amp; Sheet Preset</div>
      <div class="referee-bridge-actions">
        <button type="button" class="referee-bridge-btn" data-cr-action="sync-st-preset">Sync ST Preset</button>
        <button type="button" class="referee-bridge-btn" data-cr-action="sync-st-persona">Sync ST Persona</button>
      </div>
      <div style="margin-top:6px"><small>Preset: <strong>${escapeHtml(
        genSummary.presetName || 'Default'
      )}</strong>${
    personaSummary ? ` · Persona: <strong>${escapeHtml(personaSummary.name)}</strong>` : ''
  }</small></div>
      <div class="referee-bridge-actions" style="margin-top:6px">
        <select class="referee-bridge-select" data-cr-input="sheet-preset">
          ${sheetPresetOptions}
        </select>
        <button type="button" class="referee-bridge-btn referee-bridge-btn--primary" data-cr-action="apply-sheet-preset">Apply Sheet Preset</button>
      </div>
    </section>

    <section class="referee-bridge-section-card" data-cr-panel="connections">
      <div class="referee-bridge-widget-title">Backend Connections</div>
      <div><small>Active Profile: <strong>${escapeHtml(
        conn.activeProfile || 'none'
      )}</strong></small></div>
      <div class="referee-bridge-actions" style="margin-top:6px">
        <select class="referee-bridge-select" data-conn-input="provider">${providerOptions}</select>
        <input type="text" class="referee-bridge-input" data-conn-input="baseUrl" placeholder="Base URL" value="${escapeHtml(
          dc.baseUrl ?? ''
        )}" />
        <input type="text" class="referee-bridge-input" data-conn-input="model" placeholder="Model" value="${escapeHtml(
          dc.model ?? ''
        )}" />
        <input type="number" step="0.05" class="referee-bridge-input" data-conn-input="temperature" placeholder="Temp" value="${escapeHtml(
          dc.temperature ?? ''
        )}" />
        <input type="number" step="1" class="referee-bridge-input" data-conn-input="maxTokens" placeholder="Max Tokens" value="${escapeHtml(
          dc.maxTokens ?? ''
        )}" />
        <button type="button" class="referee-bridge-btn referee-bridge-btn--primary" data-cr-action="update-connections">Save Connections</button>
      </div>
      <div class="referee-bridge-actions" style="margin-top:6px">
        <input type="text" class="referee-bridge-input" data-conn-input="profileName" placeholder="Profile name..." />
        <button type="button" class="referee-bridge-btn" data-cr-action="save-connection-profile">Save Profile</button>
      </div>
      ${profileSelectorHtml}
    </section>

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
 *   client?: import('./bridge-client.js').RefereeBridgeClient;
 *   sessionId?: string | null;
 *   stContext?: any;
 *   getStContext?: () => any;
 *   onResult?: (res: unknown, action: string) => void;
 *   onError?: (err: unknown, action: string) => void;
 *   onApplyPack?: (payload: Record<string, unknown>) => void;
 *   onToggleModule?: (payload: Record<string, unknown>) => void;
 *   onWizardGenerate?: (req: Record<string, unknown>) => void;
 *   onWizardApply?: (payload: Record<string, unknown>) => void;
 *   onSyncStPreset?: (info: { preset: Record<string, unknown> | null; sessionId: string | null; ctx: any }) => void;
 *   onSyncStPersona?: (info: { persona: { id: string; name: string; description: string }; sessionId: string | null; ctx: any }) => void;
 *   onApplySheetPreset?: (payload: Record<string, unknown>) => void;
 *   onUpdateConnections?: (payload: Record<string, unknown>) => void;
 *   onSaveConnectionProfile?: (name: string, payload: Record<string, unknown>) => void;
 *   onActivateConnectionProfile?: (name: string) => void;
 * }} [handlers]
 * @returns {() => void}
 */
export function bindControlRoomModalDom(container, viewModel, handlers = {}) {
  if (!container || typeof container !== 'object') {
    return () => {};
  }
  container.innerHTML = renderControlRoomModalHtml(viewModel);

  const settlePromise = (maybePromise, action) => {
    if (maybePromise && typeof maybePromise.then === 'function') {
      Promise.resolve(maybePromise).then(
        (res) => {
          if (typeof handlers.onResult === 'function') {
            handlers.onResult(res, action);
          }
        },
        (err) => {
          if (typeof handlers.onError === 'function') {
            handlers.onError(err, action);
          }
        }
      );
    }
  };

  const resolveSessionId = () =>
    typeof handlers.sessionId === 'string' && handlers.sessionId.trim().length > 0
      ? handlers.sessionId.trim()
      : viewModel?.sessionId ?? null;

  const resolveStContext = () =>
    handlers.stContext ??
    (typeof handlers.getStContext === 'function' ? handlers.getStContext() : null) ??
    globalThis.SillyTavern?.getContext?.() ??
    null;

  const readConnectionEditorPayload = () => {
    const providerEl = container.querySelector?.('[data-conn-input="provider"]');
    const baseUrlEl = container.querySelector?.('[data-conn-input="baseUrl"]');
    const modelEl = container.querySelector?.('[data-conn-input="model"]');
    const tempEl = container.querySelector?.('[data-conn-input="temperature"]');
    const maxTokensEl = container.querySelector?.('[data-conn-input="maxTokens"]');
    return buildConnectionsUpdatePayload({
      provider: providerEl?.value ?? 'openai_compatible',
      baseUrl: baseUrlEl?.value ?? '',
      model: modelEl?.value ?? '',
      temperature: tempEl?.value ?? '',
      maxTokens: maxTokensEl?.value ?? '',
    });
  };

  const onClick = (event) => {
    const target = event?.target?.closest?.('[data-cr-action]');
    if (!target) return;
    const action = target.getAttribute('data-cr-action');

    if (action === 'apply-pack' && typeof handlers.onApplyPack === 'function') {
      const checkedPack = container.querySelector?.('input[name="referee-system-pack"]:checked');
      const packId = checkedPack?.value ?? viewModel.activePackId;
      const groupNodes = container.querySelectorAll?.('[data-cr-action="toggle-group"]:checked') ?? [];
      const selectedGroups = Array.from(groupNodes).map((n) => n.value);
      settlePromise(handlers.onApplyPack(buildSwitchPackPayload(packId, selectedGroups)), action);
    } else if (action === 'toggle-module' && typeof handlers.onToggleModule === 'function') {
      const modId = target.getAttribute('data-module-id');
      if (modId) {
        settlePromise(
          handlers.onToggleModule(buildModuleTogglePayload(modId, Boolean(target.checked))),
          action
        );
      }
    } else if (action === 'wizard-generate' && typeof handlers.onWizardGenerate === 'function') {
      const descEl = container.querySelector?.('[data-wizard-input="description"]');
      const ownerEl = container.querySelector?.('[data-wizard-input="effectOwner"]');
      const req = buildWizardGenerateRequest({
        description: descEl?.value ?? '',
        effectOwner: ownerEl?.value ?? 'hybrid',
      });
      settlePromise(handlers.onWizardGenerate(req), action);
    } else if (
      action === 'wizard-apply' &&
      viewModel.wizard?.draft &&
      typeof handlers.onWizardApply === 'function'
    ) {
      settlePromise(
        handlers.onWizardApply(buildApplyWizardModulePayload(viewModel.wizard.draft)),
        action
      );
    } else if (action === 'sync-st-preset') {
      const ctx = resolveStContext();
      const sessionId = resolveSessionId();
      const preset = extractActiveSillyTavernPreset(ctx);
      if (typeof handlers.onSyncStPreset === 'function') {
        settlePromise(handlers.onSyncStPreset({ preset, sessionId, ctx }), action);
      } else if (handlers.client && preset) {
        settlePromise(
          handlers.client.importPreset({
            preset,
            ...(sessionId ? { sessionId } : {}),
          }),
          action
        );
      }
    } else if (action === 'sync-st-persona') {
      const ctx = resolveStContext();
      const sessionId = resolveSessionId();
      const persona = extractActiveSillyTavernPersona(ctx);
      if (typeof handlers.onSyncStPersona === 'function') {
        settlePromise(handlers.onSyncStPersona({ persona, sessionId, ctx }), action);
      } else if (handlers.client && sessionId) {
        settlePromise(handlers.client.applySessionPersona(sessionId, { persona }), action);
      }
    } else if (action === 'apply-sheet-preset') {
      const selectEl = container.querySelector?.('[data-cr-input="sheet-preset"]');
      const sheetPresetId = selectEl?.value ?? viewModel?.sheetPresetId ?? SHEET_PRESET_IDS[0];
      const payload = buildApplySheetPresetPayload(sheetPresetId);
      const sessionId = resolveSessionId();
      if (typeof handlers.onApplySheetPreset === 'function') {
        settlePromise(handlers.onApplySheetPreset(payload), action);
      } else if (handlers.client && sessionId) {
        settlePromise(handlers.client.applyPreset(sessionId, payload), action);
      }
    } else if (action === 'update-connections') {
      const payload = readConnectionEditorPayload();
      if (typeof handlers.onUpdateConnections === 'function') {
        settlePromise(handlers.onUpdateConnections(payload), action);
      } else if (handlers.client) {
        settlePromise(handlers.client.updateConnections(payload), action);
      }
    } else if (action === 'save-connection-profile') {
      const profileNameEl = container.querySelector?.('[data-conn-input="profileName"]');
      const profileName = typeof profileNameEl?.value === 'string' ? profileNameEl.value.trim() : '';
      if (profileName.length > 0 && isSafePropertyKey(profileName)) {
        const payload = readConnectionEditorPayload();
        if (typeof handlers.onSaveConnectionProfile === 'function') {
          settlePromise(handlers.onSaveConnectionProfile(profileName, payload), action);
        } else if (handlers.client) {
          settlePromise(
            handlers.client.saveConnectionProfile(profileName, { ...payload, activate: true }),
            action
          );
        }
      }
    } else if (action === 'activate-connection-profile') {
      const activateEl = container.querySelector?.('[data-conn-input="activateProfileName"]');
      const profileName = typeof activateEl?.value === 'string' ? activateEl.value.trim() : '';
      if (profileName.length > 0 && isSafePropertyKey(profileName)) {
        if (typeof handlers.onActivateConnectionProfile === 'function') {
          settlePromise(handlers.onActivateConnectionProfile(profileName), action);
        } else if (handlers.client) {
          settlePromise(handlers.client.activateConnectionProfile(profileName), action);
        }
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
