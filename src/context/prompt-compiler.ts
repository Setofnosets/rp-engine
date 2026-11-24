import type { ActiveAmbientEntry, LiveNudgeEntry } from '../beats/beat-engine.js';
import type { NarrativePacing, ResolvedControlRoomConfig } from '../config/control-room-config.js';
import { type ValidationError, validationError } from '../core/errors.js';
import { ErrorAccumulator, type Result, err, ok } from '../core/result.js';
import type { ChatMessage } from '../gateway/types.js';
import type { FormDefinition } from '../state/forms.js';
import type { CharacterCardLoreEntry, CharacterCardSheet } from '../state/character-card-sheet.js';
import type { CharacterEntity, WorldState } from '../state/world-state.js';
import { computeLocationCast } from '../world/cast-presence.js';
import { getRelevantChronicleEntries } from '../world/chronicle.js';
import {
  compareStringsDeterministic,
  getActiveGameSystemModules,
  getOwnSafe,
  isModuleCategoryExplicitlyDisabled,
  isSafeRecordKey,
  renderWorldStateBlockWithStats,
  resolveEffectiveCapabilities,
  setOwnSafe,
} from './state-renderer.js';
import {
  DEFAULT_TOKEN_BUDGETS,
  type SectionTokenBudgets,
  clipTextToTokenBudget,
  estimateTokens,
  fitItemsToBudget,
  validateTokenBudgets,
} from './tokenizer-budget.js';

/**
 * Character/scenario card metadata injected into the narrator prompt.
 */
export interface CardPersonaInput {
  name: string;
  description: string;
  scenario?: string;
  systemPrompt?: string;
}

/**
 * Prompt injection emitted by sandboxed scripts targeting a named section.
 */
export interface InjectedScriptPrompt {
  section: string;
  text: string;
}

/**
 * Full input payload accepted by {@link compileNarratorPrompt}.
 */
export interface CompilePromptInput {
  state: WorldState;
  config: ResolvedControlRoomConfig;
  cardPersona: CardPersonaInput;
  liveNudges?: readonly LiveNudgeEntry[];
  activeAmbient?: readonly ActiveAmbientEntry[];
  loreContents?: ReadonlyMap<string, string> | Readonly<Record<string, string>>;
  injectedScriptPrompts?: readonly InjectedScriptPrompt[];
  recentTranscript: readonly ChatMessage[];
  latestInput: string;
  budgets?: Partial<SectionTokenBudgets>;
  formDefinitions?: readonly FormDefinition[];
}

/**
 * Compiled narrator prompt payload with per-section breakdown and budget accounting.
 */
export interface CompiledPromptResult {
  messages: ChatMessage[];
  renderedSections: Record<string, string>;
  tokenBreakdown: Record<string, number>;
  totalEstimatedTokens: number;
  droppedItemsCount: number;
}

const COMBAT_MODULE_IDS = new Set(['combat', 'tactical_combat']);
const CHRONICLE_MODULE_IDS = new Set(['chronicle', 'episodic_chronicle']);

const BUILTIN_SECTION_IDS = new Set([
  'system',
  'narrative_pacing',
  'game_system_rules',
  'persona',
  'card',
  'state',
  'combat_outcome',
  'plot',
  'world',
  'transcript_window',
  'latest_input',
]);

const CYOA_PROMPT_INSTRUCTION =
  'At the end of your response, provide 2-4 concise, distinct player action choices (CYOA options) grounded in the current scene.';

function resolveBudgetsSafe(partial?: Partial<SectionTokenBudgets>): SectionTokenBudgets {
  const clampBudget = (value: number | undefined, fallback: number): number => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      return fallback;
    }
    return Math.floor(value);
  };

  const resolved: SectionTokenBudgets = {
    state: clampBudget(partial?.state, DEFAULT_TOKEN_BUDGETS.state),
    combatOutcome: clampBudget(partial?.combatOutcome, DEFAULT_TOKEN_BUDGETS.combatOutcome),
    plot: clampBudget(partial?.plot, DEFAULT_TOKEN_BUDGETS.plot),
    world: clampBudget(partial?.world, DEFAULT_TOKEN_BUDGETS.world),
    totalMaxTokens: clampBudget(partial?.totalMaxTokens, DEFAULT_TOKEN_BUDGETS.totalMaxTokens),
  };

  if (partial?.system !== undefined) {
    resolved.system = clampBudget(partial.system, 0);
  }
  if (partial?.card !== undefined) {
    resolved.card = clampBudget(partial.card, 0);
  }

  return resolved;
}

function isSectionUnlocked(config: ResolvedControlRoomConfig, sectionId: string): boolean {
  return (
    isSafeRecordKey(sectionId) &&
    getOwnSafe(config.unlockedPromptSections, sectionId) === true &&
    Object.hasOwn(config.basePrompts, sectionId)
  );
}

function buildCoreRefereeSystemPrompt(
  cyoaEnabled: boolean,
  hasMechanicalCombatOrProgression: boolean
): string {
  const lines = [
    'You are the Narrator for an interactive story mediated by the deterministic Referee engine.',
    'Dramatize the authoritative world state and character reactions in vivid, grounded prose.',
    hasMechanicalCombatOrProgression
      ? 'Dramatize any [COMBAT_OUTCOME] events faithfully; never arbitrate mechanics, roll dice, override engine rulings, or invent HP, XP, resource, relationship, inventory, or stat deltas.'
      : 'Never arbitrate hidden state mutations or invent unauthorized state deltas; reflect relationships, mood, and setting grounded in the canon.',
    'Treat [STATE] and [PLOT] directives as binding canon.',
  ];
  if (cyoaEnabled) {
    lines.push(CYOA_PROMPT_INSTRUCTION);
  }
  return lines.join('\n');
}

function buildNarrativePacingInstruction(pacing: NarrativePacing): string {
  switch (pacing) {
    case 'slow_burn':
      return 'Narrative Pacing (slow_burn): Linger on sensory atmosphere, character interiority, subtext, and unhurried dialogue; let moments breathe without rushing plot beats.';
    case 'balanced':
      return 'Narrative Pacing (balanced): Balance character moments, environmental texture, and steady dramatic momentum.';
    case 'fast_forward':
      return 'Narrative Pacing (fast_forward): Keep prose brisk and decisive; condense routine transitions and drive forward toward key turning points.';
  }
}

function buildGameSystemRulesSection(
  config: ResolvedControlRoomConfig,
  effectiveCapabilities: ReturnType<typeof resolveEffectiveCapabilities>
): string {
  const activeModules = getActiveGameSystemModules(config, effectiveCapabilities);
  const rules: string[] = [];

  for (const mod of activeModules) {
    const rule = mod.narratorRule.trim();
    if (rule.length > 0) {
      rules.push(`- [${mod.name}] ${rule}`);
    }
  }

  const combatEnabled =
    effectiveCapabilities.combatMode !== 'disabled' &&
    !isModuleCategoryExplicitlyDisabled(config, COMBAT_MODULE_IDS);
  if (combatEnabled) {
    const customRuleKeys = Object.keys(config.combatRules.customRules)
      .filter(isSafeRecordKey)
      .sort(compareStringsDeterministic);
    for (const ruleKey of customRuleKeys) {
      const ruleText = getOwnSafe(config.combatRules.customRules, ruleKey);
      if (typeof ruleText === 'string' && ruleText.trim().length > 0) {
        rules.push(`- [Combat Rule · ${ruleKey}] ${ruleText.trim()}`);
      }
    }
  }

  if (rules.length === 0) {
    return '';
  }

  return `[GAME_SYSTEM_RULES]\n${rules.join('\n')}`;
}

interface ScopedCastCards {
  playerPersonaCard: CharacterCardSheet | null;
  presentCharacters: Array<{ id: string; entity: CharacterEntity; isPlayerCanon: boolean }>;
  offscreenCharacters: Array<{ id: string; entity: CharacterEntity }>;
}

function collectScopedCastCards(state: WorldState): ScopedCastCards {
  const presentIdSet = new Set<string>();
  for (const id of state.scene.presentCharacterIds) {
    if (isSafeRecordKey(id) && getOwnSafe(state.entities.characters, id) !== undefined) {
      presentIdSet.add(id);
    }
  }
  const canonId = state.player.canonCharacterId;
  if (typeof canonId === 'string' && isSafeRecordKey(canonId) && getOwnSafe(state.entities.characters, canonId) !== undefined) {
    presentIdSet.add(canonId);
  }

  const presentCharacters: Array<{ id: string; entity: CharacterEntity; isPlayerCanon: boolean }> = [];
  const offscreenCharacters: Array<{ id: string; entity: CharacterEntity }> = [];

  for (const id of Object.keys(state.entities.characters)
    .filter(isSafeRecordKey)
    .sort(compareStringsDeterministic)) {
    const entity = getOwnSafe(state.entities.characters, id);
    if (entity === undefined) {
      continue;
    }
    if (presentIdSet.has(id)) {
      presentCharacters.push({ id, entity, isPlayerCanon: id === canonId });
    } else {
      offscreenCharacters.push({ id, entity });
    }
  }

  return {
    playerPersonaCard: state.player.personaCard ?? null,
    presentCharacters,
    offscreenCharacters,
  };
}

function resolveActiveFormSummary(
  entity: CharacterEntity,
  formDefinitions?: readonly FormDefinition[]
): string | undefined {
  if (typeof entity.formId !== 'string' || entity.formId.trim().length === 0) {
    return undefined;
  }
  const formId = entity.formId.trim();
  const def = formDefinitions?.find((f) => f.id === formId);
  if (def !== undefined) {
    const traits = (def.traits ?? []).filter((t) => t.trim().length > 0);
    return traits.length > 0 ? `${def.displayName} (${traits.join(', ')})` : def.displayName;
  }
  return formId;
}

function formatCardSheetLines(
  header: string,
  sheet: CharacterCardSheet,
  activeFormSummary?: string
): string[] {
  const lines: string[] = [header];
  if (sheet.name.trim().length > 0) {
    lines.push(`Name: ${sheet.name.trim()}`);
  }
  if (activeFormSummary !== undefined && activeFormSummary.trim().length > 0) {
    lines.push(`Active Form: ${activeFormSummary.trim()}`);
  }
  if (sheet.description.trim().length > 0) {
    lines.push(`Description: ${sheet.description.trim()}`);
  }
  if (sheet.personality.trim().length > 0) {
    lines.push(`Personality: ${sheet.personality.trim()}`);
  }
  if (sheet.scenario.trim().length > 0) {
    lines.push(`Scenario: ${sheet.scenario.trim()}`);
  }
  if (sheet.mesExample.trim().length > 0) {
    lines.push(`Example Dialogue: ${sheet.mesExample.trim()}`);
  }
  if (sheet.systemPrompt.trim().length > 0) {
    lines.push(`Card Instructions: ${sheet.systemPrompt.trim()}`);
  }
  return lines;
}

function buildCardSection(
  cardPersona: CardPersonaInput,
  state?: WorldState,
  formDefinitions?: readonly FormDefinition[]
): string {
  const lines: string[] = [];
  if (cardPersona.name.trim().length > 0) {
    lines.push(`Name: ${cardPersona.name.trim()}`);
  }
  if (cardPersona.description.trim().length > 0) {
    lines.push(`Description: ${cardPersona.description.trim()}`);
  }
  if (typeof cardPersona.scenario === 'string' && cardPersona.scenario.trim().length > 0) {
    lines.push(`Scenario: ${cardPersona.scenario.trim()}`);
  }
  if (typeof cardPersona.systemPrompt === 'string' && cardPersona.systemPrompt.trim().length > 0) {
    lines.push(`Card Instructions: ${cardPersona.systemPrompt.trim()}`);
  }

  if (state !== undefined) {
    const scoped = collectScopedCastCards(state);
    if (scoped.playerPersonaCard !== null) {
      lines.push(...formatCardSheetLines('[PLAYER PERSONA CARD]', scoped.playerPersonaCard));
    }
    for (const { entity, isPlayerCanon } of scoped.presentCharacters) {
      if (entity.cardSheet !== undefined) {
        const header = isPlayerCanon
          ? `[PLAYER CANON CARD: ${entity.name}]`
          : `[SCENE CAST CARD: ${entity.name}]`;
        const formSummary = resolveActiveFormSummary(entity, formDefinitions);
        lines.push(...formatCardSheetLines(header, entity.cardSheet, formSummary));
      }
    }
    if (scoped.offscreenCharacters.length > 0) {
      lines.push('[OFF-SCREEN ROSTER]');
      for (const { entity } of scoped.offscreenCharacters) {
        const loc = typeof entity.locationId === 'string' && entity.locationId.trim().length > 0
          ? entity.locationId.trim()
          : 'unknown';
        lines.push(`- ${entity.name} (${entity.status}) @ ${loc}`);
      }
    }
  }

  if (lines.length === 0) {
    return '';
  }
  return `[CARD]\n${lines.join('\n')}`;
}

function lookupLoreContent(
  loreContents: ReadonlyMap<string, string> | Readonly<Record<string, string>> | undefined,
  key: string | undefined
): string | undefined {
  if (loreContents === undefined || typeof key !== 'string') {
    return undefined;
  }
  const trimmedKey = key.trim();
  if (trimmedKey.length === 0) {
    return undefined;
  }
  if (loreContents instanceof Map) {
    const mapRef = loreContents as ReadonlyMap<string, string>;
    const val = mapRef.get(trimmedKey) ?? mapRef.get(key);
    return typeof val === 'string' && val.trim().length > 0 ? val.trim() : undefined;
  }
  const rec = loreContents as Readonly<Record<string, string>>;
  const val = getOwnSafe(rec, trimmedKey) ?? getOwnSafe(rec, key);
  return typeof val === 'string' && val.trim().length > 0 ? val.trim() : undefined;
}

function buildBudgetedBlock(
  header: string,
  items: readonly { text: string }[],
  maxTokens: number
): { text: string; droppedCount: number } {
  if (items.length === 0 || maxTokens <= 0) {
    return { text: '', droppedCount: items.length };
  }

  const headerTokens = estimateTokens(header);
  const bodyBudget = Math.max(0, maxTokens - headerTokens);
  if (bodyBudget <= 0) {
    return { text: '', droppedCount: items.length };
  }

  const fitted = fitItemsToBudget(items, bodyBudget);
  if (fitted.included.length === 0) {
    return { text: '', droppedCount: fitted.droppedCount };
  }

  let droppedCount = fitted.droppedCount;
  const selected = [...fitted.included];

  while (selected.length > 1) {
    const combined = `${header}\n${selected.map((item) => item.text).join('\n')}`;
    if (estimateTokens(combined) <= maxTokens) {
      return { text: combined, droppedCount };
    }
    selected.pop();
    droppedCount += 1;
  }

  const singleCombined = `${header}\n${selected.map((item) => item.text).join('\n')}`;
  if (estimateTokens(singleCombined) <= maxTokens) {
    return { text: singleCombined, droppedCount };
  }

  const clippedBody = clipTextToTokenBudget(selected[0]?.text ?? '', bodyBudget);
  if (clippedBody.length === 0) {
    return { text: '', droppedCount: droppedCount + 1 };
  }
  const finalCombined = `${header}\n${clippedBody}`;
  return {
    text: estimateTokens(finalCombined) <= maxTokens ? finalCombined : clipTextToTokenBudget(finalCombined, maxTokens),
    droppedCount,
  };
}

function collectInjectedPromptsBySection(
  injectedScriptPrompts?: readonly InjectedScriptPrompt[]
): { bySection: Map<string, string[]>; extraSections: string[] } {
  const bySection = new Map<string, string[]>();
  const extraSections: string[] = [];

  if (injectedScriptPrompts === undefined) {
    return { bySection, extraSections };
  }

  for (const entry of injectedScriptPrompts) {
    if (
      entry === undefined ||
      typeof entry.section !== 'string' ||
      typeof entry.text !== 'string' ||
      !isSafeRecordKey(entry.section)
    ) {
      continue;
    }
    const sectionId = entry.section.trim();
    const text = entry.text.trim();
    if (sectionId.length === 0 || text.length === 0 || !isSafeRecordKey(sectionId)) {
      continue;
    }
    let list = bySection.get(sectionId);
    if (list === undefined) {
      list = [];
      bySection.set(sectionId, list);
      extraSections.push(sectionId);
    }
    list.push(text);
  }

  return { bySection, extraSections };
}

function buildEffectiveSectionOrder(
  baseOrder: readonly string[],
  options: {
    includePlotFallback: boolean;
    includeCyoaExtraSection: boolean;
    extraScriptSections: readonly string[];
    hasTranscript: boolean;
  }
): string[] {
  const order: string[] = [];
  const seen = new Set<string>();

  const pushUnique = (sectionId: string): void => {
    if (!isSafeRecordKey(sectionId) || seen.has(sectionId)) {
      return;
    }
    seen.add(sectionId);
    order.push(sectionId);
  };

  for (const raw of baseOrder) {
    if (typeof raw === 'string' && raw.trim().length > 0) {
      pushUnique(raw.trim());
    }
  }

  const insertBeforeAnchor = (sectionId: string, anchors: readonly string[]): void => {
    if (seen.has(sectionId) || !isSafeRecordKey(sectionId)) {
      return;
    }
    for (const anchor of anchors) {
      const idx = order.indexOf(anchor);
      if (idx !== -1) {
        order.splice(idx, 0, sectionId);
        seen.add(sectionId);
        return;
      }
    }
    order.push(sectionId);
    seen.add(sectionId);
  };

  if (options.includePlotFallback && !seen.has('plot')) {
    insertBeforeAnchor('plot', ['world', 'transcript_window', 'latest_input']);
  }

  if (options.includeCyoaExtraSection && !seen.has('cyoa')) {
    insertBeforeAnchor('cyoa', ['transcript_window', 'latest_input']);
  }

  for (const scriptSection of options.extraScriptSections) {
    if (
      scriptSection !== 'transcript_window' &&
      scriptSection !== 'latest_input' &&
      !seen.has(scriptSection)
    ) {
      insertBeforeAnchor(scriptSection, ['transcript_window', 'latest_input']);
    }
  }

  if (options.hasTranscript && !seen.has('transcript_window')) {
    insertBeforeAnchor('transcript_window', ['latest_input']);
  }

  if (!seen.has('latest_input')) {
    pushUnique('latest_input');
  }

  return order;
}

function appendScriptTexts(baseText: string, additions: readonly string[] | undefined): string {
  if (additions === undefined || additions.length === 0) {
    return baseText;
  }
  const extra = additions.join('\n');
  if (baseText.trim().length === 0) {
    return extra;
  }
  return `${baseText}\n${extra}`;
}

function countMergedSystemTokens(
  effectiveOrder: readonly string[],
  sectionTexts: ReadonlyMap<string, string>
): number {
  let total = 0;
  let buffer: string[] = [];

  const flush = (): void => {
    if (buffer.length > 0) {
      total += estimateTokens(buffer.join('\n\n'));
      buffer = [];
    }
  };

  for (const sectionId of effectiveOrder) {
    if (sectionId === 'transcript_window' || sectionId === 'latest_input') {
      flush();
      continue;
    }
    const text = sectionTexts.get(sectionId);
    if (text !== undefined && text.trim().length > 0) {
      buffer.push(text);
    }
  }
  flush();
  return total;
}

/**
 * Validate a {@link CompilePromptInput} payload using {@link Result} and {@link ErrorAccumulator}.
 */
export function validateCompilePromptInput(
  input: CompilePromptInput,
  basePath = 'compilePromptInput'
): Result<CompilePromptInput, ValidationError[]> {
  const acc = new ErrorAccumulator(basePath);

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return err([validationError(basePath, 'INVALID_TYPE', 'CompilePromptInput must be an object')]);
  }
  if (typeof input.state !== 'object' || input.state === null) {
    acc.add('state', 'REQUIRED', 'state is required');
  }
  if (typeof input.config !== 'object' || input.config === null) {
    acc.add('config', 'REQUIRED', 'config is required');
  }
  if (typeof input.cardPersona !== 'object' || input.cardPersona === null) {
    acc.add('cardPersona', 'REQUIRED', 'cardPersona is required');
  } else {
    if (typeof input.cardPersona.name !== 'string') {
      acc.add('cardPersona.name', 'INVALID_TYPE', 'cardPersona.name must be a string');
    }
    if (typeof input.cardPersona.description !== 'string') {
      acc.add('cardPersona.description', 'INVALID_TYPE', 'cardPersona.description must be a string');
    }
  }
  if (!Array.isArray(input.recentTranscript)) {
    acc.add('recentTranscript', 'INVALID_TYPE', 'recentTranscript must be an array');
  }
  if (typeof input.latestInput !== 'string') {
    acc.add('latestInput', 'INVALID_TYPE', 'latestInput must be a string');
  }
  if (input.budgets !== undefined) {
    acc.absorb(validateTokenBudgets(input.budgets, 'budgets'));
  }

  return acc.toResult(input);
}

function applySectionBudget(
  sectionId: string,
  text: string,
  budgets: SectionTokenBudgets
): string {
  switch (sectionId) {
    case 'system':
      return budgets.system !== undefined ? clipTextToTokenBudget(text, budgets.system) : text;
    case 'card':
      return budgets.card !== undefined ? clipTextToTokenBudget(text, budgets.card) : text;
    case 'state':
      return clipTextToTokenBudget(text, budgets.state);
    case 'combat_outcome':
      return clipTextToTokenBudget(text, budgets.combatOutcome);
    case 'plot':
      return clipTextToTokenBudget(text, budgets.plot);
    case 'world':
      return clipTextToTokenBudget(text, budgets.world);
    default:
      return text;
  }
}

function renderStateSection(
  input: CompilePromptInput,
  budgets: SectionTokenBudgets,
  scriptAddons: readonly string[] | undefined
): { text: string; droppedCount: number } {
  const header = '[STATE]';
  const headerTokens = estimateTokens(header);
  const scriptAddonText =
    scriptAddons !== undefined && scriptAddons.length > 0 ? scriptAddons.join('\n') : '';
  const scriptAddonTokens = scriptAddonText.length > 0 ? estimateTokens(scriptAddonText) : 0;

  if (budgets.state <= 0) {
    return { text: '', droppedCount: 0 };
  }

  const bodyBudget = Math.max(0, budgets.state - headerTokens - scriptAddonTokens);
  const stateBody = renderWorldStateBlockWithStats({
    state: input.state,
    config: input.config,
    maxTokens: bodyBudget,
    formDefinitions: input.formDefinitions,
  });

  const parts = [stateBody.text, scriptAddonText].filter((p) => p.trim().length > 0);
  if (parts.length === 0) {
    return { text: '', droppedCount: stateBody.droppedCount };
  }

  let fullState = `${header}\n${parts.join('\n')}`;
  if (estimateTokens(fullState) > budgets.state) {
    fullState = clipTextToTokenBudget(fullState, budgets.state);
  }
  return { text: fullState, droppedCount: stateBody.droppedCount };
}

function renderCombatOutcomeSection(
  input: CompilePromptInput,
  effectiveCapabilities: ReturnType<typeof resolveEffectiveCapabilities>,
  budgets: SectionTokenBudgets,
  scriptAddons: readonly string[] | undefined
): { text: string; droppedCount: number } {
  const combatEnabled =
    effectiveCapabilities.combatMode !== 'disabled' &&
    !isModuleCategoryExplicitlyDisabled(input.config, COMBAT_MODULE_IDS);
  if (!combatEnabled) {
    return { text: '', droppedCount: 0 };
  }

  const outcomes = input.state.turnEvents.combatOutcomes
    .filter((o): o is string => typeof o === 'string' && o.trim().length > 0)
    .map((o) => ({ text: `- ${o.trim()}` }));
  if (scriptAddons !== undefined) {
    for (const txt of scriptAddons) {
      outcomes.push({ text: txt });
    }
  }
  if (outcomes.length === 0) {
    return { text: '', droppedCount: 0 };
  }
  return buildBudgetedBlock('[COMBAT_OUTCOME]', outcomes, budgets.combatOutcome);
}

function renderPlotSection(
  input: CompilePromptInput,
  effectiveCapabilities: ReturnType<typeof resolveEffectiveCapabilities>,
  budgets: SectionTokenBudgets,
  directorNudgeText: string,
  scriptAddons: readonly string[] | undefined
): { text: string; droppedCount: number } {
  const plotItems: Array<{ text: string }> = [];
  const gates: Array<{ text: string }> = [];
  const nudges: Array<{ text: string }> = [];

  if (effectiveCapabilities.beats && input.liveNudges !== undefined) {
    for (const entry of input.liveNudges) {
      const txt = entry.text.trim();
      if (txt.length === 0) {
        continue;
      }
      if (entry.class === 'gate') {
        gates.push({ text: `- [Gate · ${entry.beatId}] ${txt}` });
      } else {
        nudges.push({ text: `- [Nudge · ${entry.beatId}] ${txt}` });
      }
    }
  }

  // Gate first, then Director Bar steering directive, then priority-ordered Nudges
  for (const g of gates) {
    plotItems.push(g);
  }
  if (directorNudgeText.length > 0) {
    plotItems.push({ text: `- [Director Nudge] ${directorNudgeText}` });
  }
  for (const n of nudges) {
    plotItems.push(n);
  }
  if (scriptAddons !== undefined) {
    for (const txt of scriptAddons) {
      plotItems.push({ text: txt });
    }
  }
  if (plotItems.length === 0) {
    return { text: '', droppedCount: 0 };
  }
  return buildBudgetedBlock('[PLOT]', plotItems, budgets.plot);
}

function evaluateEmbeddedCardLorebooks(
  state: WorldState,
  recentTranscript: readonly ChatMessage[],
  latestInput: string
): Array<{ text: string }> {
  const scoped = collectScopedCastCards(state);
  const sheets: CharacterCardSheet[] = [];
  if (scoped.playerPersonaCard !== null) {
    sheets.push(scoped.playerPersonaCard);
  }
  for (const { entity } of scoped.presentCharacters) {
    if (entity.cardSheet !== undefined) {
      sheets.push(entity.cardSheet);
    }
  }
  if (sheets.length === 0) {
    return [];
  }

  const corpus = [...recentTranscript.map((m) => m.content), latestInput]
    .join('\n')
    .toLowerCase();

  const activated: Array<{ entry: CharacterCardLoreEntry; sheetName: string }> = [];
  for (const sheet of sheets) {
    for (const entry of sheet.embeddedLoreEntries) {
      if (!entry.enabled || entry.content.trim().length === 0) {
        continue;
      }
      if (!entry.constant) {
        const primaryKeys = entry.keys
          .map((k) => k.trim().toLowerCase())
          .filter((k) => k.length > 0);
        if (primaryKeys.length === 0 || !primaryKeys.some((k) => corpus.includes(k))) {
          continue;
        }
        const secondaryKeys = entry.secondaryKeys
          .map((k) => k.trim().toLowerCase())
          .filter((k) => k.length > 0);
        if (secondaryKeys.length > 0 && !secondaryKeys.some((k) => corpus.includes(k))) {
          continue;
        }
      }
      activated.push({ entry, sheetName: sheet.name });
    }
  }

  activated.sort(
    (a, b) =>
      a.entry.insertionOrder - b.entry.insertionOrder ||
      compareStringsDeterministic(a.entry.name ?? '', b.entry.name ?? '') ||
      compareStringsDeterministic(a.entry.content, b.entry.content)
  );

  return activated.map(({ entry, sheetName }) => {
    const label =
      typeof entry.name === 'string' && entry.name.trim().length > 0
        ? `${sheetName} · ${entry.name.trim()}`
        : sheetName;
    return { text: `- [Card Lore · ${label}] ${entry.content.trim()}` };
  });
}

function renderWorldSection(
  input: CompilePromptInput,
  effectiveCapabilities: ReturnType<typeof resolveEffectiveCapabilities>,
  budgets: SectionTokenBudgets,
  scriptAddons: readonly string[] | undefined
): { text: string; droppedCount: number } {
  const worldItems: Array<{ text: string }> = [];

  if (effectiveCapabilities.beats && input.activeAmbient !== undefined) {
    for (const amb of input.activeAmbient) {
      const resolvedLore =
        lookupLoreContent(input.loreContents, amb.lore) ??
        lookupLoreContent(input.loreContents, amb.beatId) ??
        (typeof amb.lore === 'string' && amb.lore.trim().length > 0
          ? amb.lore.trim()
          : undefined);
      const resolvedNudge =
        typeof amb.nudge === 'string' && amb.nudge.trim().length > 0
          ? amb.nudge.trim()
          : undefined;

      const parts: string[] = [];
      if (resolvedLore !== undefined) {
        parts.push(resolvedLore);
      }
      if (resolvedNudge !== undefined && resolvedNudge !== resolvedLore) {
        parts.push(resolvedNudge);
      }
      if (parts.length > 0) {
        worldItems.push({ text: `- [${amb.beatId}] ${parts.join(' — ')}` });
      }
    }
  }

  const chronicleEnabled =
    effectiveCapabilities.chronicle &&
    !isModuleCategoryExplicitlyDisabled(input.config, CHRONICLE_MODULE_IDS);
  if (chronicleEnabled) {
    const cast = computeLocationCast(
      { ...input.state, capabilities: effectiveCapabilities },
      input.formDefinitions
    );
    const transcriptLines = [
      ...input.recentTranscript.map((m) => m.content),
      input.latestInput,
    ];
    const memories = getRelevantChronicleEntries(input.state, {
      presentCharacterIds: cast.presentCharacterIds,
      currentLocationId: input.state.scene.locationId,
      currentLocationName: input.state.scene.location,
      recentTranscriptLines: transcriptLines,
      maxEntries: 8,
    });
    for (const scored of memories) {
      const e = scored.entry;
      worldItems.push({
        text: `- [Memory · Day ${e.day}] ${e.title}: ${e.summary}`,
      });
    }
  }

  if (scriptAddons !== undefined) {
    for (const txt of scriptAddons) {
      worldItems.push({ text: txt });
    }
  }

  const cardLoreItems = evaluateEmbeddedCardLorebooks(
    input.state,
    input.recentTranscript,
    input.latestInput
  );
  for (const item of cardLoreItems) {
    worldItems.push(item);
  }

  if (worldItems.length === 0) {
    return { text: '', droppedCount: 0 };
  }
  return buildBudgetedBlock('[WORLD]', worldItems, budgets.world);
}

function shedExcessSystemTokens(
  effectiveOrder: readonly string[],
  sectionTexts: Map<string, string>,
  totalMaxTokens: number,
  latestInputTokens: number
): { systemTokens: number; shedDroppedCount: number } {
  const shedPriorityOrder = [
    'world',
    'plot',
    'combat_outcome',
    'game_system_rules',
    'card',
    'narrative_pacing',
    'persona',
    'cyoa',
    'state',
    'system',
  ];

  // Append any custom/script sections so they can also be shed if totalMaxTokens is ultra-tight
  const customKeys = effectiveOrder
    .filter(
      (id) =>
        id !== 'transcript_window' &&
        id !== 'latest_input' &&
        !shedPriorityOrder.includes(id)
    )
    .reverse();

  let systemTokens = countMergedSystemTokens(effectiveOrder, sectionTexts);
  if (systemTokens + latestInputTokens <= totalMaxTokens) {
    return { systemTokens, shedDroppedCount: 0 };
  }

  const allowedSystemTokens = Math.max(0, totalMaxTokens - latestInputTokens);
  let shedDroppedCount = 0;

  for (const shedKey of [...customKeys, ...shedPriorityOrder]) {
    if (systemTokens <= allowedSystemTokens) {
      break;
    }
    const existing = sectionTexts.get(shedKey);
    if (existing === undefined) {
      continue;
    }
    const excess = systemTokens - allowedSystemTokens;
    const currentTokens = estimateTokens(existing);
    const targetTokens = Math.max(0, currentTokens - excess);
    if (targetTokens <= 0) {
      sectionTexts.delete(shedKey);
      shedDroppedCount += 1;
    } else {
      const clipped = clipTextToTokenBudget(existing, targetTokens);
      if (clipped.trim().length === 0) {
        sectionTexts.delete(shedKey);
        shedDroppedCount += 1;
      } else {
        sectionTexts.set(shedKey, clipped);
      }
    }
    systemTokens = countMergedSystemTokens(effectiveOrder, sectionTexts);
  }

  return { systemTokens, shedDroppedCount };
}

function fitRecentTranscriptWindow(
  recentTranscript: readonly ChatMessage[],
  remainingForTranscript: number
): { included: ChatMessage[]; usedTokens: number; droppedCount: number } {
  const reversed: ChatMessage[] = [];
  let usedTokens = 0;
  let droppedCount = 0;

  for (let i = recentTranscript.length - 1; i >= 0; i -= 1) {
    const msg = recentTranscript[i];
    if (msg === undefined) {
      continue;
    }
    const cost = estimateTokens(msg.content);
    if (usedTokens + cost <= remainingForTranscript) {
      reversed.push({
        role: msg.role,
        content: msg.content,
        ...(msg.name !== undefined ? { name: msg.name } : {}),
      });
      usedTokens += cost;
    } else {
      droppedCount += i + 1;
      break;
    }
  }

  return {
    included: reversed.reverse(),
    usedTokens,
    droppedCount,
  };
}

/**
 * Compile the narrator LLM prompt payload from WorldState, ResolvedControlRoomConfig,
 * beat nudges/ambient lore, episodic Chronicle memories, script injections, and recent
 * transcript messages under strict deterministic token budgets.
 */
export function compileNarratorPrompt(input: CompilePromptInput): CompiledPromptResult {
  const { state, config } = input;
  const budgets = resolveBudgetsSafe(input.budgets);
  const effectiveCapabilities = resolveEffectiveCapabilities(
    state.capabilities,
    config.capabilities
  );

  let droppedItemsCount = 0;

  const { bySection: scriptBySection, extraSections: extraScriptSections } =
    collectInjectedPromptsBySection(input.injectedScriptPrompts);

  const systemUnlocked = isSectionUnlocked(config, 'system');
  const cyoaEnabled = config.tuningDials.cyoaEnabled === true;
  const includeCyoaExtraSection = systemUnlocked && cyoaEnabled;

  const directorNudgeText =
    typeof state.scene.directorNudge === 'string' ? state.scene.directorNudge.trim() : '';
  const hasBeatsNudges =
    effectiveCapabilities.beats &&
    input.liveNudges !== undefined &&
    input.liveNudges.some((n) => n.text.trim().length > 0);
  const includePlotFallback =
    directorNudgeText.length > 0 || hasBeatsNudges || scriptBySection.has('plot');

  const effectiveOrder = buildEffectiveSectionOrder(config.syspromptSectionOrder, {
    includePlotFallback,
    includeCyoaExtraSection,
    extraScriptSections,
    hasTranscript: input.recentTranscript.length > 0,
  });

  const hasCardSlot = effectiveOrder.includes('card');
  const sectionTexts = new Map<string, string>();

  for (const sectionId of effectiveOrder) {
    if (sectionId === 'transcript_window' || sectionId === 'latest_input') {
      continue;
    }

    if (sectionId === 'cyoa' && includeCyoaExtraSection) {
      sectionTexts.set(
        'cyoa',
        appendScriptTexts(CYOA_PROMPT_INSTRUCTION, scriptBySection.get('cyoa'))
      );
      continue;
    }

    if (!BUILTIN_SECTION_IDS.has(sectionId)) {
      const unlockedFlag = getOwnSafe(config.unlockedPromptSections, sectionId);
      const customBase =
        unlockedFlag !== false && Object.hasOwn(config.basePrompts, sectionId)
          ? (getOwnSafe(config.basePrompts, sectionId) ?? '')
          : '';
      const combined = appendScriptTexts(customBase, scriptBySection.get(sectionId));
      if (combined.trim().length > 0) {
        sectionTexts.set(sectionId, combined);
      }
      continue;
    }

    if (isSectionUnlocked(config, sectionId)) {
      const overrideText = applySectionBudget(
        sectionId,
        appendScriptTexts(
          getOwnSafe(config.basePrompts, sectionId) ?? '',
          scriptBySection.get(sectionId)
        ),
        budgets
      );
      if (overrideText.trim().length > 0) {
        sectionTexts.set(sectionId, overrideText);
      }
      continue;
    }

    switch (sectionId) {
      case 'system': {
        const hasMechanical =
          effectiveCapabilities.combatMode !== 'disabled' ||
          effectiveCapabilities.progression !== 'disabled';
        const sysText = applySectionBudget(
          'system',
          appendScriptTexts(
            buildCoreRefereeSystemPrompt(cyoaEnabled, hasMechanical),
            scriptBySection.get('system')
          ),
          budgets
        );
        if (sysText.trim().length > 0) {
          sectionTexts.set('system', sysText);
        }
        break;
      }

      case 'narrative_pacing': {
        const pacingText = appendScriptTexts(
          buildNarrativePacingInstruction(config.tuningDials.narrativePacing),
          scriptBySection.get('narrative_pacing')
        );
        if (pacingText.trim().length > 0) {
          sectionTexts.set('narrative_pacing', pacingText);
        }
        break;
      }

      case 'game_system_rules': {
        const rulesText = appendScriptTexts(
          buildGameSystemRulesSection(config, effectiveCapabilities),
          scriptBySection.get('game_system_rules')
        );
        if (rulesText.trim().length > 0) {
          sectionTexts.set('game_system_rules', rulesText);
        }
        break;
      }

      case 'persona': {
        const basePersona = !hasCardSlot
          ? buildCardSection(input.cardPersona, input.state, input.formDefinitions)
          : '';
        const personaText = applySectionBudget(
          !hasCardSlot ? 'card' : 'persona',
          appendScriptTexts(basePersona, scriptBySection.get('persona')),
          budgets
        );
        if (personaText.trim().length > 0) {
          sectionTexts.set('persona', personaText);
        }
        break;
      }

      case 'card': {
        const cardText = applySectionBudget(
          'card',
          appendScriptTexts(
            buildCardSection(input.cardPersona, input.state, input.formDefinitions),
            scriptBySection.get('card')
          ),
          budgets
        );
        if (cardText.trim().length > 0) {
          sectionTexts.set('card', cardText);
        }
        break;
      }

      case 'state': {
        const stateRes = renderStateSection(input, budgets, scriptBySection.get('state'));
        droppedItemsCount += stateRes.droppedCount;
        if (stateRes.text.trim().length > 0) {
          sectionTexts.set('state', stateRes.text);
        }
        break;
      }

      case 'combat_outcome': {
        const combatRes = renderCombatOutcomeSection(
          input,
          effectiveCapabilities,
          budgets,
          scriptBySection.get('combat_outcome')
        );
        droppedItemsCount += combatRes.droppedCount;
        if (combatRes.text.trim().length > 0) {
          sectionTexts.set('combat_outcome', combatRes.text);
        }
        break;
      }

      case 'plot': {
        const plotRes = renderPlotSection(
          input,
          effectiveCapabilities,
          budgets,
          directorNudgeText,
          scriptBySection.get('plot')
        );
        droppedItemsCount += plotRes.droppedCount;
        if (plotRes.text.trim().length > 0) {
          sectionTexts.set('plot', plotRes.text);
        }
        break;
      }

      case 'world': {
        const worldRes = renderWorldSection(
          input,
          effectiveCapabilities,
          budgets,
          scriptBySection.get('world')
        );
        droppedItemsCount += worldRes.droppedCount;
        if (worldRes.text.trim().length > 0) {
          sectionTexts.set('world', worldRes.text);
        }
        break;
      }
    }
  }

  const latestInputTokens = estimateTokens(input.latestInput);
  const shedResult = shedExcessSystemTokens(
    effectiveOrder,
    sectionTexts,
    budgets.totalMaxTokens,
    latestInputTokens
  );
  droppedItemsCount += shedResult.shedDroppedCount;

  const remainingForTranscript = Math.max(
    0,
    budgets.totalMaxTokens - shedResult.systemTokens - latestInputTokens
  );
  const transcriptFit = fitRecentTranscriptWindow(input.recentTranscript, remainingForTranscript);
  droppedItemsCount += transcriptFit.droppedCount;

  const messages: ChatMessage[] = [];
  let systemBuffer: string[] = [];

  const flushSystemBuffer = (): void => {
    if (systemBuffer.length > 0) {
      messages.push({
        role: 'system',
        content: systemBuffer.join('\n\n'),
      });
      systemBuffer = [];
    }
  };

  const renderedSections: Record<string, string> = {};
  const tokenBreakdown: Record<string, number> = {};
  for (const builtinId of BUILTIN_SECTION_IDS) {
    setOwnSafe(tokenBreakdown, builtinId, 0);
  }

  for (const sectionId of effectiveOrder) {
    if (sectionId === 'transcript_window') {
      flushSystemBuffer();
      for (const msg of transcriptFit.included) {
        messages.push(msg);
      }
      if (transcriptFit.included.length > 0) {
        setOwnSafe(
          renderedSections,
          'transcript_window',
          transcriptFit.included.map((m) => `${m.role}: ${m.content}`).join('\n')
        );
      }
      setOwnSafe(tokenBreakdown, 'transcript_window', transcriptFit.usedTokens);
      continue;
    }

    if (sectionId === 'latest_input') {
      flushSystemBuffer();
      messages.push({
        role: 'user',
        content: input.latestInput,
      });
      if (input.latestInput.length > 0) {
        setOwnSafe(renderedSections, 'latest_input', input.latestInput);
      }
      setOwnSafe(tokenBreakdown, 'latest_input', latestInputTokens);
      continue;
    }

    const sectionText = sectionTexts.get(sectionId);
    if (sectionText !== undefined && sectionText.trim().length > 0) {
      systemBuffer.push(sectionText);
      setOwnSafe(renderedSections, sectionId, sectionText);
      setOwnSafe(tokenBreakdown, sectionId, estimateTokens(sectionText));
    } else {
      setOwnSafe(tokenBreakdown, sectionId, 0);
    }
  }
  flushSystemBuffer();

  const totalEstimatedTokens = messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);

  return {
    messages,
    renderedSections,
    tokenBreakdown,
    totalEstimatedTokens,
    droppedItemsCount,
  };
}
