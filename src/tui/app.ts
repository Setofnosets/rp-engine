import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { BeatLedgerState } from '../beats/beat-ledger.js';
import type { CartridgeBundle } from '../cartridge/cartridge-schema.js';
import {
  exportToSillyTavernChatCompletionPreset,
  exportToSillyTavernTextCompletionPreset,
} from '../cartridge/exporters/st-preset-exporter.js';
import { importSillyTavernPreset } from '../cartridge/importers/st-preset-importer.js';
import type { CombatState, CombatantState } from '../combat/action-validator.js';
import {
  type ControlRoomLayer,
  type GenerationPresetConfig,
  type ResolvedControlRoomConfig,
  applySheetPreset,
  cloneCapabilitiesPartial,
  cloneCombatRulesPartial,
  cloneControlRoomLayer,
  cloneCustomPromptBlocks,
  cloneGameSystemModuleOverride,
  cloneGameSystemOverrides,
  cloneGenerationPresetConfig,
  cloneStringRecord,
  cloneBooleanRecord,
  cloneTokenBudgetsPartial,
  cloneTuningDialsPartial,
  setGenerationPreset,
} from '../config/control-room-config.js';
import {
  type UserPersonaPreset,
  cloneUserPersonaPreset,
  validateUserPersonaPreset,
} from '../config/persona-preset.js';
import { type ControlRoomDiffReport, computeControlRoomDiffReport } from '../config/prompt-diff.js';
import { formatValidationErrors } from '../core/errors.js';
import {
  type ConnectionsFileDocument,
  activateNamedProfile,
  loadConnectionsFile,
  saveConnectionsFile,
  saveNamedProfile,
  snapshotGatewayToConnectionsDoc,
} from '../gateway/connection-store.js';
import type { ModelGateway } from '../gateway/model-gateway.js';
import { AGENT_ROLES, type AgentRole, type RoleConnectionConfig } from '../gateway/types.js';
import type { DirectorSteeringInput } from '../runtime/director-steering.js';
import type { SessionRuntimeEvent } from '../runtime/event-bus.js';
import type { SessionRuntime } from '../runtime/session-runtime.js';
import {
  SHEET_PRESETS,
  type SheetPresetId,
  cloneCharacterSections,
} from '../schema/character-sections.js';
import { STOCK_FREEFORM_PACK, getStockSystemPack } from '../schema/stock-system-packs.js';
import {
  type GameSystemModule,
  type SystemCapabilities,
  type SystemPack,
  cloneGameSystemModule,
} from '../schema/tracker-module.js';
import type { AuditEntry } from '../state/audit-log.js';
import type { PatchOperation } from '../state/patch.js';
import {
  type SwipeTreeState,
  type TranscriptMessageNode,
  getLinearTranscript,
} from '../state/swipe-tree.js';
import type { WorldState } from '../state/world-state.js';
import {
  type RefereeDataStore,
  type SaveControlRoomPresetInput,
  type SavedControlRoomPreset,
  validateSafeStorageId,
} from '../storage/data-store.js';
import { GameSystemWizard, type WizardGeneratedSystem } from '../wizard/game-system-wizard.js';
import type {
  CharacterDossier,
  SettingCharacterSummary,
  SettingRosterInspection,
} from '../world/character-inspector.js';
import { renderAuditAndChroniclePane } from './panes/audit-and-chronicle-pane.js';
import { type ChatPaneMessage, renderChatPane } from './panes/chat-pane.js';
import { renderCombatGridPane } from './panes/combat-grid-pane.js';
import { renderControlRoomPane } from './panes/control-room-pane.js';
import { renderDynamicHudPane } from './panes/dynamic-hud-pane.js';
import {
  compareStringsDeterministic,
  getSafeOwn,
  isSafeRecordKey,
  setSafeOwn,
  truncateLine,
  wrapText,
} from './panes/layout-helpers.js';

export type TuiViewMode = 'play' | 'control_room' | 'combat' | 'audit' | 'chronicle' | 'output';

export interface TuiRenderOptions {
  readonly hidePromptLine?: boolean;
}

export interface TuiViewport {
  readonly width: number;
  readonly height: number;
}

export interface TuiHandleInputResult {
  readonly outputLines: string[];
  readonly shouldExit: boolean;
}

export interface TuiControllerOptions {
  readonly runtime?: SessionRuntime;
  readonly gateway?: ModelGateway;
  readonly wizard?: GameSystemWizard;
  readonly basePack?: SystemPack;
  readonly cartridge?: CartridgeBundle | null;
  readonly daemonUrl?: string;
  readonly sessionId?: string;
  readonly initialViewMode?: TuiViewMode;
  readonly customPacks?: Readonly<Record<string, SystemPack>>;
  readonly dataStore?: RefereeDataStore;
  readonly connectionsPath?: string;
}

interface DaemonStateSnapshot {
  state: WorldState;
  beatLedger: BeatLedgerState;
  combatState: CombatState | null;
  config: ResolvedControlRoomConfig;
  pendingConfirmations: readonly PatchOperation[];
  diffReport?: ControlRoomDiffReport;
  swipeTree: SwipeTreeState;
  auditLog: readonly AuditEntry[];
}

const DEFAULT_VIEWPORT: TuiViewport = { width: 80, height: 24 };

export const GAMEPLAY_SLASH_COMMANDS: ReadonlySet<string> = new Set([
  '/travel',
  '/rest',
  '/play-as',
  '/move',
  '/attack',
  '/skill',
  '/defend',
  '/end-turn',
]);

const VALID_AGENT_ROLES: ReadonlySet<string> = new Set<string>(AGENT_ROLES);

const BOOLEAN_CAPABILITY_KEYS = new Set<keyof SystemCapabilities>([
  'factions',
  'beats',
  'relationships',
  'chronicle',
]);

function parseCommandArgs(raw: string): string[] {
  const args: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i] as string;
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        args.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) {
    args.push(current);
  }
  return args;
}

function mergeControlRoomLayerOverlay(
  current: Readonly<ControlRoomLayer>,
  incoming: Readonly<ControlRoomLayer>
): ControlRoomLayer {
  const next = cloneControlRoomLayer(current);

  if (incoming.capabilities !== undefined) {
    next.capabilities = {
      ...(next.capabilities ?? {}),
      ...cloneCapabilitiesPartial(incoming.capabilities),
    };
  }
  if (incoming.pcCoreSections !== undefined) {
    next.pcCoreSections = cloneCharacterSections(incoming.pcCoreSections);
  }
  if (incoming.npcCoreSections !== undefined) {
    next.npcCoreSections = cloneCharacterSections(incoming.npcCoreSections);
  }
  if (incoming.sectionConfirmPolicies !== undefined) {
    next.sectionConfirmPolicies = {
      ...(next.sectionConfirmPolicies ?? {}),
      ...(incoming.sectionConfirmPolicies.pc !== undefined
        ? { pc: { ...(next.sectionConfirmPolicies?.pc ?? {}), ...incoming.sectionConfirmPolicies.pc } }
        : {}),
      ...(incoming.sectionConfirmPolicies.npc !== undefined
        ? { npc: { ...(next.sectionConfirmPolicies?.npc ?? {}), ...incoming.sectionConfirmPolicies.npc } }
        : {}),
    };
  }
  if (incoming.gameSystems !== undefined) {
    next.gameSystems = incoming.gameSystems.map(cloneGameSystemModule);
  }
  if (incoming.gameSystemOverrides !== undefined) {
    const baseOverrides = next.gameSystemOverrides
      ? cloneGameSystemOverrides(next.gameSystemOverrides)
      : {};
    for (const [modId, modOverride] of Object.entries(incoming.gameSystemOverrides)) {
      if (!isSafeRecordKey(modId)) {
        continue;
      }
      const prev = getSafeOwn(baseOverrides, modId);
      setSafeOwn(
        baseOverrides,
        modId,
        prev !== undefined
          ? { ...prev, ...cloneGameSystemModuleOverride(modOverride) }
          : cloneGameSystemModuleOverride(modOverride)
      );
    }
    next.gameSystemOverrides = baseOverrides;
  }
  if (incoming.blockOrder !== undefined) {
    next.blockOrder = [...incoming.blockOrder];
  }
  if (incoming.syspromptSectionOrder !== undefined) {
    next.syspromptSectionOrder = [...incoming.syspromptSectionOrder];
  }
  if (incoming.basePrompts !== undefined) {
    next.basePrompts = {
      ...(next.basePrompts ? cloneStringRecord(next.basePrompts) : {}),
      ...cloneStringRecord(incoming.basePrompts),
    };
  }
  if (incoming.unlockedPromptSections !== undefined) {
    next.unlockedPromptSections = {
      ...(next.unlockedPromptSections ? cloneBooleanRecord(next.unlockedPromptSections) : {}),
      ...cloneBooleanRecord(incoming.unlockedPromptSections),
    };
  }
  if (incoming.customPromptBlocks !== undefined) {
    next.customPromptBlocks = {
      ...(next.customPromptBlocks ? cloneCustomPromptBlocks(next.customPromptBlocks) : {}),
      ...cloneCustomPromptBlocks(incoming.customPromptBlocks),
    };
  }
  if (incoming.combatRules !== undefined) {
    const patchRules = cloneCombatRulesPartial(incoming.combatRules);
    next.combatRules = {
      ...(next.combatRules ?? {}),
      ...patchRules,
    };
  }
  if (incoming.tuningDials !== undefined) {
    next.tuningDials = {
      ...(next.tuningDials ?? {}),
      ...cloneTuningDialsPartial(incoming.tuningDials),
    };
  }
  if (incoming.generation !== undefined) {
    next.generation = cloneGenerationPresetConfig({
      ...(next.generation ?? {}),
      ...incoming.generation,
      ...(incoming.generation.stFormatTemplates !== undefined ||
      next.generation?.stFormatTemplates !== undefined
        ? {
            stFormatTemplates: {
              ...(next.generation?.stFormatTemplates ?? {}),
              ...(incoming.generation.stFormatTemplates ?? {}),
            },
          }
        : {}),
    });
  }
  if (incoming.tokenBudgets !== undefined) {
    next.tokenBudgets = {
      ...(next.tokenBudgets ?? {}),
      ...cloneTokenBudgetsPartial(incoming.tokenBudgets),
    };
  }
  return next;
}

function formatCharacterSummaryLine(c: SettingCharacterSummary, tag: string): string {
  const allegiance = c.allegianceName ?? (c.allegiance.trim().length > 0 ? c.allegiance : 'none');
  const affinity =
    c.playerAffinity !== null
      ? ` | aff=${c.playerAffinity.affinity}/${c.playerAffinity.maxAffinity} (${c.playerAffinity.label})`
      : '';
  const pcBadge = c.isPlayer ? ' [PC]' : '';
  return `  ${tag} ${c.name} (${c.id})${pcBadge} | mood=${c.mood} | allegiance=${allegiance}${affinity}`;
}

function formatSettingRosterLines(roster: SettingRosterInspection): string[] {
  const lines: string[] = [
    `Setting Cast (${roster.totalCharacters} total: ${roster.presentCount} present, ${roster.offscreenCount} offscreen, ${roster.inactiveCount} inactive) @ ${roster.activeSceneLocation || 'Scene'}`,
  ];

  if (roster.characters.length === 0) {
    lines.push('  (No characters in setting)');
    return lines;
  }

  const hereChars = roster.characters.filter(
    (c) => c.presence === 'player' || c.presence === 'in_scene'
  );
  const pinnedChars = roster.characters.filter((c) => c.presence === 'in_scene_pinned');
  const offscreenChars = roster.characters.filter(
    (c) => c.presence === 'offscreen_located' || c.presence === 'offscreen_unlocated'
  );
  const inactiveChars = roster.characters.filter((c) => c.presence === 'inactive');

  for (const c of hereChars) {
    lines.push(formatCharacterSummaryLine(c, '[HERE]'));
  }
  for (const c of pinnedChars) {
    lines.push(formatCharacterSummaryLine(c, '[PINNED]'));
  }
  for (const c of offscreenChars) {
    const loc = c.locationName ?? c.locationId ?? 'Unknown';
    lines.push(formatCharacterSummaryLine(c, `[OFFSCREEN @ ${loc}]`));
  }
  for (const c of inactiveChars) {
    lines.push(formatCharacterSummaryLine(c, `[INACTIVE: ${c.status}]`));
  }

  return lines;
}

function formatDossierLines(d: CharacterDossier): string[] {
  const lines: string[] = [
    `Dossier: ${d.summary.name} (${d.summary.id})${d.summary.isPlayer ? ' [PC]' : ''}`,
    `  Status: ${d.summary.status} | Presence: ${d.summary.presence}${d.summary.locationName ? ` @ ${d.summary.locationName}` : ''}`,
    `  Forms: active=${d.forms.activeFormId ?? 'none'} | group=${d.forms.formGroup ?? 'none'}${
      d.forms.availableForms.length > 0
        ? ` | available=${d.forms.availableForms.map((f) => f.id).join(', ')}`
        : ''
    }`,
    `  Agency: mood=${d.agency.mood} | allegiance=${d.agency.allegianceName ?? (d.agency.allegiance || 'none')}`,
  ];

  if (d.agency.agenda.trim().length > 0) {
    lines.push(`  Agenda: ${d.agency.agenda}`);
  }
  if (d.agency.goals.length > 0) {
    lines.push(`  Goals: ${d.agency.goals.join('; ')}`);
  }
  if (d.agency.traits.length > 0) {
    lines.push(`  Traits: ${d.agency.traits.join(', ')}`);
  }
  if (d.agency.abilities.length > 0) {
    lines.push(`  Abilities: ${d.agency.abilities.join(', ')}`);
  }
  if (d.progression !== undefined) {
    const cls = d.progression.className ? ` ${d.progression.className}` : '';
    lines.push(`  Progression: Lv ${d.progression.level}${cls} (XP ${d.progression.xp})`);
  }
  if (d.resources !== undefined) {
    const resParts = Object.keys(d.resources)
      .filter(isSafeRecordKey)
      .sort(compareStringsDeterministic)
      .map((k) => {
        const pool = getSafeOwn(d.resources, k);
        return pool !== undefined ? `${k}=${pool.current}/${pool.max}` : '';
      })
      .filter((s) => s.length > 0);
    if (resParts.length > 0) {
      lines.push(`  Resources: ${resParts.join(' | ')}`);
    }
  }

  const visibleSections = d.sections.filter((s) => s.populated || !s.hiddenUntilSet);
  if (visibleSections.length > 0) {
    lines.push('  Sheet Sections:');
    for (const sec of visibleSections) {
      const valStr =
        sec.value === null
          ? '(empty)'
          : Array.isArray(sec.value)
            ? sec.value.join(', ') || '(empty)'
            : sec.value || '(empty)';
      lines.push(`    ${sec.name} (${sec.id}): ${valStr}`);
    }
  }

  if (d.customFields.length > 0) {
    lines.push('  Custom Fields:');
    for (const cf of d.customFields) {
      lines.push(`    ${cf.moduleName}.${cf.fieldId}: ${JSON.stringify(cf.value)}`);
    }
  }

  const outKeys = Object.keys(d.relations.outgoing).filter(isSafeRecordKey).sort(compareStringsDeterministic);
  const inKeys = Object.keys(d.relations.incoming).filter(isSafeRecordKey).sort(compareStringsDeterministic);
  if (outKeys.length > 0 || inKeys.length > 0) {
    lines.push('  Relations:');
    for (const peerId of outKeys) {
      const rel = getSafeOwn(d.relations.outgoing, peerId);
      if (rel !== undefined) {
        lines.push(`    -> ${peerId}: ${rel.affinity}/${rel.maxAffinity} (${rel.label})`);
      }
    }
    for (const srcId of inKeys) {
      const rel = getSafeOwn(d.relations.incoming, srcId);
      if (rel !== undefined) {
        lines.push(`    <- ${srcId}: ${rel.affinity}/${rel.maxAffinity} (${rel.label})`);
      }
    }
  }

  return lines;
}

const SAMPLING_KEY_ALIASES: Readonly<Record<string, keyof GenerationPresetConfig>> = {
  temp: 'temperature',
  temperature: 'temperature',
  max_tokens: 'maxTokens',
  maxtokens: 'maxTokens',
  max_context: 'maxContextTokens',
  maxcontext: 'maxContextTokens',
  max_context_tokens: 'maxContextTokens',
  maxcontexttokens: 'maxContextTokens',
  top_p: 'topP',
  topp: 'topP',
  top_k: 'topK',
  topk: 'topK',
  min_p: 'minP',
  minp: 'minP',
  top_a: 'topA',
  topa: 'topA',
  typical_p: 'typicalP',
  typicalp: 'typicalP',
  tfs: 'tfs',
  rep_pen: 'repetitionPenalty',
  repetition_penalty: 'repetitionPenalty',
  repetitionpenalty: 'repetitionPenalty',
  freq_pen: 'frequencyPenalty',
  frequency_penalty: 'frequencyPenalty',
  frequencypenalty: 'frequencyPenalty',
  pres_pen: 'presencePenalty',
  presence_penalty: 'presencePenalty',
  presencepenalty: 'presencePenalty',
  seed: 'seed',
};

const INTEGER_SAMPLING_FIELDS: ReadonlySet<string> = new Set([
  'maxTokens',
  'maxContextTokens',
  'topK',
  'seed',
]);

function formatGenerationSummaryLines(gen: GenerationPresetConfig | undefined): string[] {
  if (gen === undefined) {
    return ['Generation Sampling: (using gateway/provider defaults)'];
  }
  const fields: string[] = [];
  if (gen.presetName !== undefined) fields.push(`preset="${gen.presetName}"`);
  if (gen.sourceFormat !== undefined) fields.push(`format=${gen.sourceFormat}`);
  if (gen.temperature !== undefined) fields.push(`temperature=${gen.temperature}`);
  if (gen.maxTokens !== undefined) fields.push(`maxTokens=${gen.maxTokens}`);
  if (gen.maxContextTokens !== undefined) fields.push(`maxContextTokens=${gen.maxContextTokens}`);
  if (gen.topP !== undefined) fields.push(`topP=${gen.topP}`);
  if (gen.topK !== undefined) fields.push(`topK=${gen.topK}`);
  if (gen.minP !== undefined) fields.push(`minP=${gen.minP}`);
  if (gen.topA !== undefined) fields.push(`topA=${gen.topA}`);
  if (gen.typicalP !== undefined) fields.push(`typicalP=${gen.typicalP}`);
  if (gen.tfs !== undefined) fields.push(`tfs=${gen.tfs}`);
  if (gen.repetitionPenalty !== undefined) fields.push(`repetitionPenalty=${gen.repetitionPenalty}`);
  if (gen.frequencyPenalty !== undefined) fields.push(`frequencyPenalty=${gen.frequencyPenalty}`);
  if (gen.presencePenalty !== undefined) fields.push(`presencePenalty=${gen.presencePenalty}`);
  if (gen.seed !== undefined) fields.push(`seed=${gen.seed}`);
  return [
    fields.length > 0
      ? `Generation Sampling: ${fields.join(' | ')}`
      : 'Generation Sampling: (defaults)',
  ];
}

function cloneDirectorSteering(steering: DirectorSteeringInput): DirectorSteeringInput {
  const cloned: {
    clockAction?: DirectorSteeringInput['clockAction'];
    oocNudge?: string | null;
    pinCharacterIds?: readonly string[];
    dismissCharacterIds?: readonly string[];
    beatOverrides?: DirectorSteeringInput['beatOverrides'];
  } = {};

  if (steering.clockAction !== undefined) {
    cloned.clockAction =
      typeof steering.clockAction === 'object'
        ? { advanceSlots: steering.clockAction.advanceSlots }
        : steering.clockAction;
  }
  if (steering.oocNudge !== undefined) {
    cloned.oocNudge = steering.oocNudge;
  }
  if (steering.pinCharacterIds !== undefined) {
    cloned.pinCharacterIds = [...steering.pinCharacterIds];
  }
  if (steering.dismissCharacterIds !== undefined) {
    cloned.dismissCharacterIds = [...steering.dismissCharacterIds];
  }
  if (steering.beatOverrides !== undefined) {
    cloned.beatOverrides = steering.beatOverrides.map((b) => ({ ...b }));
  }

  return cloned;
}

function hasAnySteering(steering: DirectorSteeringInput): boolean {
  return (
    steering.clockAction !== undefined ||
    steering.oocNudge !== undefined ||
    (steering.pinCharacterIds !== undefined && steering.pinCharacterIds.length > 0) ||
    (steering.dismissCharacterIds !== undefined && steering.dismissCharacterIds.length > 0) ||
    (steering.beatOverrides !== undefined && steering.beatOverrides.length > 0)
  );
}

function findActiveAssistantNode(tree: SwipeTreeState): TranscriptMessageNode | null {
  const visited = new Set<string>();
  let currId: string | null = tree.activeLeafMessageId;
  while (currId !== null) {
    if (!isSafeRecordKey(currId) || visited.has(currId)) {
      break;
    }
    visited.add(currId);
    const node = getSafeOwn(tree.nodes, currId);
    if (node === undefined) {
      break;
    }
    if (node.role === 'assistant') {
      return node;
    }
    currId = node.parentMessageId;
  }
  return null;
}

function buildChatMessagesFromTree(tree: SwipeTreeState): ChatPaneMessage[] {
  const linear = getLinearTranscript(tree);
  return linear.map((entry) => {
    const node = getSafeOwn(tree.nodes, entry.messageId);
    const swipeCount = node !== undefined ? node.swipes.length : 1;
    return {
      role: entry.role,
      content: entry.content,
      swipeIndex: entry.swipeIndex,
      swipeCount,
    };
  });
}

function padOrTrimLines(lines: readonly string[], targetCount: number, width: number): string[] {
  const result = lines.slice(0, targetCount).map((line) => truncateLine(line, width));
  while (result.length < targetCount) {
    result.push('');
  }
  return result;
}

function formatHelpLines(): string[] {
  return [
    'Available Slash Commands:',
    '  /travel <place>, /rest, /play-as <id>        Gameplay navigation & roleplay',
    '  /move <x,y>, /attack <id>, /skill <id> [t]   Tactical combat actions',
    '  /defend, /end-turn                           Combat stance & turn end',
    '  /connect <url> <model> [key]                 Set default LLM endpoint & model',
    '  /connect-role <role> <url> <model> [key]     Set role-specific LLM endpoint',
    '  /connections                                 Show configured LLM connections',
    '  /save-connections [profile]                  Persist connections (or named profile)',
    '  /load-connections <profile>                  Activate saved connection profile',
    '  /disconnect-role <role>                      Remove per-role LLM override',
    '  /preset-import <path>                        Import ST Chat/Text or Referee preset',
    '  /preset-export <path> [st_chat|st_text|referee] Export active preset JSON',
    '  /preset <save|load|list> [id]                Save, load, or list presets',
    '  /sheet-preset <id>                           Apply character sheet preset',
    '  /sampling [key=value ...]                    View or update generation sampling',
    '  /persona set <name> | <description>          Set active player persona',
    '  /persona section <secId> <value>             Update player sheet section',
    '  /persona <save|load|list> [id]               Save, load, or list personas',
    '  /characters | /roster | /cast [query]        List setting characters by presence',
    '  /inspect <id|name|player>                    Inspect full character dossier',
    '  /pin <id> | /unpin <id> | /dismiss <id>      Stage character presence steering',
    '  /start-combat [enemyIds...]                  Start combat encounter',
    '  /pack <id>                                   Switch active System Pack live',
    '  /toggle <module|cap>                         Toggle module or capability live',
    '  /wizard <desc>                               Generate & enable tracking module',
    '  /nudge <text>                                Set one-turn Director OOC nudge',
    '  /hold-clock | /release-clock | /advance-slot [n] Control narrative clock',
    '  /swipe-left | /swipe-right | /regenerate     Navigate or regenerate swipes',
    '  /confirm | /reject                           Confirm or reject pending patches',
    '  /hud | /control-room | /combat | /audit | /chronicle Switch TUI view',
    '  /next | /prev | /back                        Page output or return to view',
    '  /help | /quit                                Show help or exit TUI',
  ];
}

/**
 * Headless-testable Native CLI/TUI Controller wrapping either an in-process
 * {@link SessionRuntime} or a {@link RefereeDaemon} HTTP URL, plus Director steering state.
 */
export class TuiController {
  private readonly runtime: SessionRuntime | null;
  private readonly gateway: ModelGateway | null;
  private readonly wizard: GameSystemWizard | null;
  private readonly daemonUrl: string | null;
  private sessionId: string | null;
  private readonly cartridge: CartridgeBundle | null;
  private readonly customPacks: Readonly<Record<string, SystemPack>>;
  private readonly dataStore: RefereeDataStore | null;
  private readonly connectionsPath: string | null;

  private trackedBasePack: SystemPack;
  private viewMode: TuiViewMode;
  private previousViewMode: Exclude<TuiViewMode, 'output'> = 'play';
  private commandOutputTitle = '';
  private commandOutputLines: string[] = [];
  private commandOutputPage = 0;
  private auditFilter: string | undefined;
  private directorSteering: DirectorSteeringInput = {};
  private lastWizardResult: WizardGeneratedSystem | null = null;
  private lastStatusMessage: string | null = null;
  private streamingBuffer = '';
  private cachedSnapshot: DaemonStateSnapshot | null = null;
  private readonly unsubscribeEventBus: (() => void) | null = null;

  private localConnectionsDoc: ConnectionsFileDocument = { version: 1 };
  private readonly localPresets = new Map<string, SavedControlRoomPreset>();
  private readonly localPersonas = new Map<string, UserPersonaPreset>();
  private daemonActivePersona: UserPersonaPreset | null = null;

  constructor(options: TuiControllerOptions) {
    if (options.runtime === undefined && options.daemonUrl === undefined) {
      throw new Error('TuiController requires either runtime or daemonUrl');
    }

    this.runtime = options.runtime ?? null;
    this.gateway = options.gateway ?? null;
    this.daemonUrl = options.daemonUrl ? options.daemonUrl.replace(/\/+$/, '') : null;
    this.sessionId = options.sessionId ?? options.runtime?.sessionId ?? null;
    this.cartridge = options.cartridge ?? null;
    this.customPacks = options.customPacks ?? {};
    this.dataStore = options.dataStore ?? null;
    this.connectionsPath = options.connectionsPath ?? null;
    this.viewMode = options.initialViewMode ?? 'play';
    if (this.viewMode !== 'output') {
      this.previousViewMode = this.viewMode;
    }

    if (options.wizard !== undefined) {
      this.wizard = options.wizard;
    } else if (options.gateway !== undefined) {
      this.wizard = new GameSystemWizard(options.gateway);
    } else {
      this.wizard = null;
    }

    if (options.basePack !== undefined) {
      this.trackedBasePack = options.basePack;
    } else if (this.runtime !== null) {
      const packId = this.runtime.getConfig().packId;
      this.trackedBasePack =
        getSafeOwn(this.customPacks, packId) ??
        getStockSystemPack(packId) ??
        STOCK_FREEFORM_PACK;
    } else {
      this.trackedBasePack = STOCK_FREEFORM_PACK;
    }

    if (this.runtime !== null) {
      this.unsubscribeEventBus = this.runtime.eventBus.on((event: SessionRuntimeEvent) => {
        if (event.type === 'narrator_chunk') {
          this.streamingBuffer += event.text;
          if (event.done) {
            this.streamingBuffer = '';
          }
        } else if (event.type === 'narrator_completed') {
          this.streamingBuffer = '';
        }
      });
    }
  }

  /**
   * Release any internal event bus subscription.
   */
  dispose(): void {
    if (this.unsubscribeEventBus !== null) {
      this.unsubscribeEventBus();
    }
  }

  getViewMode(): TuiViewMode {
    return this.viewMode;
  }

  getDirectorSteering(): DirectorSteeringInput {
    return cloneDirectorSteering(this.directorSteering);
  }

  getLastWizardResult(): WizardGeneratedSystem | null {
    return this.lastWizardResult;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  /**
   * Initialize or refresh cached state from a remote/local RefereeDaemon HTTP server.
   */
  async connectDaemonSession(params?: {
    systemPackId?: string;
    cartridgeId?: string;
    seed?: string | number;
    saveDir?: string | null;
    userControlRoomLayer?: ControlRoomLayer;
    persona?: UserPersonaPreset | null;
  }): Promise<void> {
    if (this.daemonUrl === null) {
      return;
    }

    if (this.sessionId === null) {
      const res = await this.daemonFetch<{ ok: boolean; sessionId: string }>(
        '/api/sessions',
        'POST',
        {
          ...(params?.systemPackId !== undefined ? { systemPackId: params.systemPackId } : {}),
          ...(params?.cartridgeId !== undefined ? { cartridgeId: params.cartridgeId } : {}),
          ...(params?.seed !== undefined ? { seed: params.seed } : {}),
          ...(params?.saveDir !== undefined ? { saveDir: params.saveDir } : {}),
          ...(params?.userControlRoomLayer !== undefined
            ? { userControlRoomLayer: params.userControlRoomLayer }
            : {}),
          ...(params?.persona !== undefined ? { persona: params.persona } : {}),
        }
      );
      this.sessionId = res.sessionId;
      if (params?.persona !== undefined && params.persona !== null) {
        this.daemonActivePersona = cloneUserPersonaPreset(params.persona);
      }
    }

    await this.refreshFromDaemon();
  }

  /**
   * Refresh cached snapshot from the daemon `/state` and `/audit` endpoints.
   */
  async refreshFromDaemon(): Promise<void> {
    if (this.daemonUrl === null || this.sessionId === null) {
      return;
    }

    const encodedId = encodeURIComponent(this.sessionId);
    const stateRes = await this.daemonFetch<{
      ok: boolean;
      state: WorldState;
      beatLedger: BeatLedgerState;
      combatState: CombatState | null;
      config: ResolvedControlRoomConfig;
      pendingConfirmations: readonly PatchOperation[];
      diffReport?: ControlRoomDiffReport;
      swipeTree: SwipeTreeState;
    }>(`/api/sessions/${encodedId}/state`, 'GET');

    const auditRes = await this.daemonFetch<{
      ok: boolean;
      entries: readonly AuditEntry[];
    }>(`/api/sessions/${encodedId}/audit`, 'GET');

    this.cachedSnapshot = {
      state: stateRes.state,
      beatLedger: stateRes.beatLedger,
      combatState: stateRes.combatState,
      config: stateRes.config,
      pendingConfirmations: stateRes.pendingConfirmations,
      ...(stateRes.diffReport !== undefined ? { diffReport: stateRes.diffReport } : {}),
      swipeTree: stateRes.swipeTree,
      auditLog: auditRes.entries,
    };
  }

  /**
   * Process one line of user input (either a slash command or a narrative turn)
   * and return status/output lines plus whether the controller should exit.
   */
  async handleInput(line: string): Promise<TuiHandleInputResult> {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return { outputLines: [], shouldExit: false };
    }

    if (!trimmed.startsWith('/')) {
      return this.handleTurnInput(trimmed);
    }

    const spaceIdx = trimmed.indexOf(' ');
    const command = (spaceIdx >= 0 ? trimmed.slice(0, spaceIdx) : trimmed).toLowerCase();
    const arg = spaceIdx >= 0 ? trimmed.slice(spaceIdx + 1).trim() : '';

    if (GAMEPLAY_SLASH_COMMANDS.has(command)) {
      return this.handleTurnInput(trimmed);
    }

    if (
      command !== '/next' &&
      command !== '/n' &&
      command !== '/more' &&
      command !== '/prev' &&
      command !== '/p' &&
      command !== '/quit' &&
      command !== '/exit'
    ) {
      this.exitOutputViewIfActive();
    }

    switch (command) {
      case '/quit':
      case '/exit':
        this.lastStatusMessage = 'Session closed.';
        return { outputLines: ['Goodbye.'], shouldExit: true };

      case '/help':
        return this.showCommandOutput(
          'HELP',
          formatHelpLines(),
          'Showing help (/next /prev /hud to return).'
        );

      case '/next':
      case '/n':
      case '/more': {
        if (this.viewMode !== 'output') {
          this.lastStatusMessage = 'Nothing to page. Use /help, /characters, or /inspect first.';
          return { outputLines: [this.lastStatusMessage], shouldExit: false };
        }
        this.commandOutputPage += 1;
        this.lastStatusMessage = `Viewing ${this.commandOutputTitle} (page ${this.commandOutputPage + 1}).`;
        return { outputLines: [this.lastStatusMessage], shouldExit: false };
      }

      case '/prev':
      case '/p': {
        if (this.viewMode !== 'output') {
          this.lastStatusMessage = 'Nothing to page. Use /help, /characters, or /inspect first.';
          return { outputLines: [this.lastStatusMessage], shouldExit: false };
        }
        this.commandOutputPage = Math.max(0, this.commandOutputPage - 1);
        this.lastStatusMessage = `Viewing ${this.commandOutputTitle} (page ${this.commandOutputPage + 1}).`;
        return { outputLines: [this.lastStatusMessage], shouldExit: false };
      }

      case '/back':
      case '/close': {
        this.viewMode = this.previousViewMode;
        this.lastStatusMessage = `Returned to ${this.viewMode} view.`;
        return { outputLines: [this.lastStatusMessage], shouldExit: false };
      }

      case '/hud':
        this.viewMode = 'play';
        this.previousViewMode = 'play';
        this.lastStatusMessage = 'Switched view to Play + Dynamic HUD.';
        return { outputLines: [this.lastStatusMessage], shouldExit: false };

      case '/control-room':
        this.viewMode = 'control_room';
        this.previousViewMode = 'control_room';
        this.lastStatusMessage = 'Switched view to Control Room.';
        return { outputLines: [this.lastStatusMessage], shouldExit: false };

      case '/combat':
        this.viewMode = 'combat';
        this.previousViewMode = 'combat';
        this.lastStatusMessage = 'Switched view to Combat Grid.';
        return { outputLines: [this.lastStatusMessage], shouldExit: false };

      case '/audit':
        this.viewMode = 'audit';
        this.previousViewMode = 'audit';
        this.auditFilter = arg.length > 0 ? arg : undefined;
        this.lastStatusMessage =
          this.auditFilter !== undefined
            ? `Switched view to Audit Log (filter: "${this.auditFilter}").`
            : 'Switched view to Audit Log.';
        return { outputLines: [this.lastStatusMessage], shouldExit: false };

      case '/chronicle':
        this.viewMode = 'chronicle';
        this.previousViewMode = 'chronicle';
        this.lastStatusMessage = 'Switched view to Chronicle.';
        return { outputLines: [this.lastStatusMessage], shouldExit: false };

      case '/nudge': {
        this.exitOutputViewIfActive();
        if (arg.length === 0) {
          const { oocNudge: _removed, ...rest } = this.directorSteering;
          this.directorSteering = rest;
          this.lastStatusMessage = 'Cleared one-turn OOC nudge.';
        } else {
          this.directorSteering = { ...this.directorSteering, oocNudge: arg };
          this.lastStatusMessage = `Staged one-turn OOC nudge: "${arg}"`;
        }
        return { outputLines: [this.lastStatusMessage], shouldExit: false };
      }

      case '/hold-clock':
        this.exitOutputViewIfActive();
        this.directorSteering = { ...this.directorSteering, clockAction: 'hold' };
        this.lastStatusMessage = 'Staged Director clock action: hold.';
        return { outputLines: [this.lastStatusMessage], shouldExit: false };

      case '/release-clock':
        this.exitOutputViewIfActive();
        this.directorSteering = { ...this.directorSteering, clockAction: 'release' };
        this.lastStatusMessage = 'Staged Director clock action: release.';
        return { outputLines: [this.lastStatusMessage], shouldExit: false };

      case '/advance-slot': {
        this.exitOutputViewIfActive();
        let slots = 1;
        if (arg.length > 0) {
          const parsed = Number(arg);
          if (!Number.isInteger(parsed) || parsed < 1) {
            this.lastStatusMessage = 'Invalid slot count: expected a positive integer.';
            return { outputLines: [this.lastStatusMessage], shouldExit: false };
          }
          slots = parsed;
        }
        this.directorSteering = {
          ...this.directorSteering,
          clockAction: { advanceSlots: slots },
        };
        this.lastStatusMessage = `Staged Director clock advance: +${slots} slot(s).`;
        return { outputLines: [this.lastStatusMessage], shouldExit: false };
      }

      case '/pin':
        return this.handlePinCommand(arg);

      case '/unpin':
        return this.handleUnpinCommand(arg);

      case '/dismiss':
        return this.handleDismissCommand(arg);

      case '/characters':
      case '/roster':
      case '/cast':
        return this.handleCharactersCommand(arg);

      case '/inspect':
        return this.handleInspectCommand(arg);

      case '/start-combat':
        return this.handleStartCombatCommand(arg);

      case '/pack':
        return this.handlePackCommand(arg);

      case '/toggle':
        return this.handleToggleCommand(arg);

      case '/wizard':
        return this.handleWizardCommand(arg);

      case '/swipe-left':
        return this.handleSwipeStep(-1);

      case '/swipe-right':
        return this.handleSwipeStep(1);

      case '/regenerate':
        return this.handleRegenerate();

      case '/confirm':
        return this.handleConfirmCommand('accept_all');

      case '/reject':
        return this.handleConfirmCommand('reject_all');

      case '/connect':
        return this.handleConnectCommand(arg);

      case '/connect-role':
        return this.handleConnectRoleCommand(arg);

      case '/connections':
        return this.handleListConnectionsCommand();

      case '/preview':
        return this.handlePreviewCommand(arg);

      case '/travel-to':
        return this.handleTravelCommand(arg);

      case '/downtime':
        return this.handleDowntimeCommand(arg);

      case '/news':
        return this.handleNewsCommand();

      case '/clone':
        return this.handleCloneCommand(arg);

      case '/takeover':
        return this.handleTakeoverCommand(arg);

      case '/save-connections':
        return this.handleSaveConnectionsCommand(arg);

      case '/load-connections':
        return this.handleLoadConnectionsCommand(arg);

      case '/disconnect-role':
        return this.handleDisconnectRoleCommand(arg);

      case '/preset-import':
        return this.handlePresetImportCommand(arg);

      case '/preset-export':
        return this.handlePresetExportCommand(arg);

      case '/preset':
        return this.handlePresetCommand(arg);

      case '/sheet-preset':
        return this.handleSheetPresetCommand(arg);

      case '/sampling':
        return this.handleSamplingCommand(arg);

      case '/persona':
        return this.handlePersonaCommand(arg);

      default:
        this.lastStatusMessage = `Unknown command "${command}". Type /help for commands.`;
        return { outputLines: [this.lastStatusMessage], shouldExit: false };
    }
  }

  private async handlePreviewCommand(arg: string): Promise<TuiHandleInputResult> {
    const tokens = arg.split(/\s+/).filter((t) => t.length > 0);
    const skillId = tokens[0];
    if (skillId === undefined) {
      this.lastStatusMessage = 'Usage: /preview <skillId> [targetId]';
      return { outputLines: [this.lastStatusMessage], shouldExit: false };
    }
    const targetId = tokens[1];
    if (this.daemonUrl !== null && this.sessionId !== null) {
      try {
        const res = await this.daemonFetch<{ ok?: boolean; preview?: Record<string, unknown> }>(
          `/api/sessions/${encodeURIComponent(this.sessionId)}/combat/preview`,
          'POST',
          { skillId, ...(targetId !== undefined ? { targetId } : {}) }
        );
        const summary = JSON.stringify(res.preview ?? res);
        this.lastStatusMessage = `Preview [${skillId}]: ${summary}`;
        return { outputLines: [this.lastStatusMessage], shouldExit: false };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.lastStatusMessage = `Preview failed: ${msg}`;
        return { outputLines: [this.lastStatusMessage], shouldExit: false };
      }
    }
    const snap = this.getSnapshot();
    const combat = snap.combatState;
    if (combat === null || !combat.active) {
      this.lastStatusMessage = `Preview [${skillId}]: No active combat.`;
      return { outputLines: [this.lastStatusMessage], shouldExit: false };
    }
    const targetLabel = targetId ?? 'auto';
    this.lastStatusMessage = `Preview [${skillId} -> ${targetLabel}]: Round ${combat.round}, Mode ${combat.mode}`;
    return { outputLines: [this.lastStatusMessage], shouldExit: false };
  }

  private async handleTravelCommand(arg: string): Promise<TuiHandleInputResult> {
    const locationId = arg.trim();
    if (locationId.length === 0) {
      this.lastStatusMessage = 'Usage: /travel-to <locationId>';
      return { outputLines: [this.lastStatusMessage], shouldExit: false };
    }
    if (this.daemonUrl !== null && this.sessionId !== null) {
      try {
        await this.daemonFetch(
          `/api/sessions/${encodeURIComponent(this.sessionId)}/travel`,
          'POST',
          { targetLocationId: locationId }
        );
        await this.refreshFromDaemon();
        this.lastStatusMessage = `Traveled to "${locationId}".`;
        return { outputLines: [this.lastStatusMessage], shouldExit: false };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.lastStatusMessage = `Travel failed: ${msg}`;
        return { outputLines: [this.lastStatusMessage], shouldExit: false };
      }
    }
    this.lastStatusMessage = `Travel queued for "${locationId}" (local runtime).`;
    return { outputLines: [this.lastStatusMessage], shouldExit: false };
  }

  private async handleDowntimeCommand(arg: string): Promise<TuiHandleInputResult> {
    const activity = arg.trim();
    if (activity.length === 0) {
      this.lastStatusMessage = 'Usage: /downtime <activity>';
      return { outputLines: [this.lastStatusMessage], shouldExit: false };
    }
    if (this.daemonUrl !== null && this.sessionId !== null) {
      try {
        await this.daemonFetch(
          `/api/sessions/${encodeURIComponent(this.sessionId)}/downtime`,
          'POST',
          { activity }
        );
        await this.refreshFromDaemon();
        this.lastStatusMessage = `Downtime "${activity}" completed.`;
        return { outputLines: [this.lastStatusMessage], shouldExit: false };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.lastStatusMessage = `Downtime failed: ${msg}`;
        return { outputLines: [this.lastStatusMessage], shouldExit: false };
      }
    }
    this.lastStatusMessage = `Downtime "${activity}" queued (local runtime).`;
    return { outputLines: [this.lastStatusMessage], shouldExit: false };
  }

  private handleNewsCommand(): TuiHandleInputResult {
    const snap = this.getSnapshot();
    const editions = snap.state.chronicle.digestEditions;
    if (editions === undefined || editions.length === 0) {
      this.lastStatusMessage = 'No digest news editions available yet.';
      return { outputLines: [this.lastStatusMessage], shouldExit: false };
    }
    const latest = editions[editions.length - 1];
    if (latest === undefined) {
      this.lastStatusMessage = 'No digest news editions available yet.';
      return { outputLines: [this.lastStatusMessage], shouldExit: false };
    }
    const lines = [
      `=== ${latest.masthead} (Day ${latest.day}) ===`,
      ...latest.headlines.map((h) => `- ${h}`),
    ];
    this.lastStatusMessage = `Displayed ${latest.masthead} (Day ${latest.day}).`;
    return { outputLines: lines, shouldExit: false };
  }

  private async handleCloneCommand(arg: string): Promise<TuiHandleInputResult> {
    const label = arg.trim();
    if (this.daemonUrl !== null && this.sessionId !== null) {
      try {
        const res = await this.daemonFetch<{ sessionId?: string }>(
          `/api/sessions/${encodeURIComponent(this.sessionId)}/clone`,
          'POST',
          label.length > 0 ? { label } : {}
        );
        const clonedId = res.sessionId ?? 'unknown';
        this.lastStatusMessage = `Cloned session -> ${clonedId}`;
        return { outputLines: [this.lastStatusMessage], shouldExit: false };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.lastStatusMessage = `Clone failed: ${msg}`;
        return { outputLines: [this.lastStatusMessage], shouldExit: false };
      }
    }
    this.lastStatusMessage = `Cloned session "${this.sessionId}"${label.length > 0 ? ` (${label})` : ''}.`;
    return { outputLines: [this.lastStatusMessage], shouldExit: false };
  }

  private async handleTakeoverCommand(arg: string): Promise<TuiHandleInputResult> {
    const target = arg.trim();
    if (target.length === 0) {
      this.lastStatusMessage = 'Usage: /takeover <characterId|persona.png>';
      return { outputLines: [this.lastStatusMessage], shouldExit: false };
    }
    if (target.toLowerCase().endsWith('.png')) {
      if (this.daemonUrl !== null) {
        try {
          await this.daemonFetch('/api/cards/import', 'POST', { path: target });
          this.lastStatusMessage = `Imported persona card "${target}".`;
          return { outputLines: [this.lastStatusMessage], shouldExit: false };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          this.lastStatusMessage = `Card import failed: ${msg}`;
          return { outputLines: [this.lastStatusMessage], shouldExit: false };
        }
      }
      this.lastStatusMessage = `Persona card "${target}" staged for takeover.`;
      return { outputLines: [this.lastStatusMessage], shouldExit: false };
    }
    if (this.daemonUrl !== null && this.sessionId !== null) {
      try {
        await this.daemonFetch(
          `/api/sessions/${encodeURIComponent(this.sessionId)}/player/bind`,
          'POST',
          { canonCharacterId: target }
        );
        await this.refreshFromDaemon();
        this.lastStatusMessage = `Bound player POV to "${target}".`;
        return { outputLines: [this.lastStatusMessage], shouldExit: false };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.lastStatusMessage = `Takeover failed: ${msg}`;
        return { outputLines: [this.lastStatusMessage], shouldExit: false };
      }
    }
    this.lastStatusMessage = `Player POV set to "${target}" (local runtime).`;
    return { outputLines: [this.lastStatusMessage], shouldExit: false };
  }

  private async handleConnectCommand(arg: string): Promise<TuiHandleInputResult> {
    const tokens = arg.split(/\s+/).filter((t) => t.length > 0);
    if (tokens.length < 2) {
      this.lastStatusMessage = 'Usage: /connect <baseUrl> <model> [apiKey]';
      return { outputLines: [this.lastStatusMessage], shouldExit: false };
    }
    const baseUrl = tokens[0] as string;
    const model = tokens[1] as string;
    const apiKey = tokens[2];
    const conn = {
      provider: 'openai_compatible' as const,
      baseUrl,
      model,
      ...(apiKey !== undefined ? { apiKey } : {}),
    };

    if (this.daemonUrl !== null) {
      await this.daemonFetch('/api/connections', 'PUT', { defaultConnection: conn });
    } else if (this.gateway !== null) {
      this.gateway.setDefaultConnection(conn);
    } else {
      this.lastStatusMessage = 'No ModelGateway bound to TUI controller.';
      return { outputLines: [this.lastStatusMessage], shouldExit: false };
    }

    this.lastStatusMessage = `Configured default connection: ${baseUrl} (model: ${model})`;
    return { outputLines: [this.lastStatusMessage], shouldExit: false };
  }

  private async handleConnectRoleCommand(arg: string): Promise<TuiHandleInputResult> {
    const tokens = arg.split(/\s+/).filter((t) => t.length > 0);
    if (tokens.length < 3) {
      this.lastStatusMessage = 'Usage: /connect-role <role> <baseUrl> <model> [apiKey]';
      return { outputLines: [this.lastStatusMessage], shouldExit: false };
    }
    const role = tokens[0] as AgentRole;
    const baseUrl = tokens[1] as string;
    const model = tokens[2] as string;
    const apiKey = tokens[3];
    const conn = {
      role,
      provider: 'openai_compatible' as const,
      baseUrl,
      model,
      ...(apiKey !== undefined ? { apiKey } : {}),
    };

    if (this.daemonUrl !== null) {
      await this.daemonFetch('/api/connections', 'PUT', {
        connections: { [role]: conn },
      });
    } else if (this.gateway !== null) {
      this.gateway.setRoleConnection(role, conn);
    } else {
      this.lastStatusMessage = 'No ModelGateway bound to TUI controller.';
      return { outputLines: [this.lastStatusMessage], shouldExit: false };
    }

    this.lastStatusMessage = `Configured role "${role}" connection: ${baseUrl} (model: ${model})`;
    return { outputLines: [this.lastStatusMessage], shouldExit: false };
  }

  private async handleListConnectionsCommand(): Promise<TuiHandleInputResult> {
    let snap: {
      defaultConnection?: { baseUrl: string; model: string };
      connections: Record<string, { baseUrl: string; model: string } | undefined>;
    };
    if (this.daemonUrl !== null) {
      snap = await this.daemonFetch('/api/connections', 'GET');
    } else if (this.gateway !== null) {
      snap = this.gateway.getConnectionsSnapshot();
    } else {
      this.lastStatusMessage = 'No ModelGateway bound.';
      return { outputLines: [this.lastStatusMessage], shouldExit: false };
    }

    const lines: string[] = ['Configured LLM Connections:'];
    if (snap.defaultConnection !== undefined) {
      lines.push(`  default: ${snap.defaultConnection.baseUrl} (${snap.defaultConnection.model})`);
    } else {
      lines.push('  default: (not configured)');
    }
    for (const [role, cfg] of Object.entries(snap.connections)) {
      if (cfg !== undefined) {
        lines.push(`  ${role}: ${cfg.baseUrl} (${cfg.model})`);
      }
    }
    return this.showCommandOutput('CONNECTIONS', lines, 'Listed configured LLM connections.');
  }

  private async loadLocalConnectionsDoc(): Promise<ConnectionsFileDocument> {
    if (this.connectionsPath !== null) {
      const res = await loadConnectionsFile(this.connectionsPath);
      if (res.ok) {
        this.localConnectionsDoc = res.value;
        return res.value;
      }
      if (res.error.every((e) => e.code === 'NOT_FOUND')) {
        return this.localConnectionsDoc;
      }
      throw new Error(formatValidationErrors(res.error));
    }
    if (this.dataStore !== null) {
      const res = await this.dataStore.loadConnections();
      if (res.ok) {
        this.localConnectionsDoc = res.value;
        return res.value;
      }
      if (res.error.every((e) => e.code === 'NOT_FOUND')) {
        return this.localConnectionsDoc;
      }
      throw new Error(formatValidationErrors(res.error));
    }
    return this.localConnectionsDoc;
  }

  private async saveLocalConnectionsDoc(doc: ConnectionsFileDocument): Promise<void> {
    this.localConnectionsDoc = doc;
    if (this.connectionsPath !== null) {
      const res = await saveConnectionsFile(this.connectionsPath, doc);
      if (!res.ok) {
        throw new Error(formatValidationErrors(res.error));
      }
      return;
    }
    if (this.dataStore !== null) {
      const res = await this.dataStore.saveConnections(doc);
      if (!res.ok) {
        throw new Error(formatValidationErrors(res.error));
      }
    }
  }

  private async handleSaveConnectionsCommand(arg: string): Promise<TuiHandleInputResult> {
    const profileName = arg.trim();
    if (profileName.length > 0 && !isSafeRecordKey(profileName)) {
      this.lastStatusMessage = `Invalid profile name "${profileName}".`;
      return { outputLines: [this.lastStatusMessage], shouldExit: false };
    }

    if (this.daemonUrl !== null) {
      const snap = await this.daemonFetch<{
        ok: boolean;
        defaultConnection?: Omit<RoleConnectionConfig, 'role'>;
        connections?: Partial<Record<AgentRole, Omit<RoleConnectionConfig, 'role'>>>;
      }>('/api/connections', 'GET');

      if (profileName.length > 0) {
        await this.daemonFetch('/api/connections/profiles', 'POST', {
          name: profileName,
          ...(snap.defaultConnection !== undefined
            ? { defaultConnection: snap.defaultConnection }
            : {}),
          ...(snap.connections !== undefined ? { connections: snap.connections } : {}),
          activate: true,
        });
        this.lastStatusMessage = `Saved and activated connection profile "${profileName}".`;
      } else {
        await this.daemonFetch('/api/connections', 'PUT', {
          ...(snap.defaultConnection !== undefined
            ? { defaultConnection: snap.defaultConnection }
            : {}),
          connections: snap.connections ?? {},
        });
        this.lastStatusMessage = 'Saved active LLM connections.';
      }
      return { outputLines: [this.lastStatusMessage], shouldExit: false };
    }

    if (this.gateway === null) {
      this.lastStatusMessage = 'No ModelGateway bound to TUI controller.';
      return { outputLines: [this.lastStatusMessage], shouldExit: false };
    }

    try {
      const existingDoc = await this.loadLocalConnectionsDoc();
      let nextDoc = snapshotGatewayToConnectionsDoc(this.gateway, existingDoc);

      if (profileName.length > 0) {
        const savedRes = saveNamedProfile(nextDoc, profileName, {
          ...(nextDoc.defaultConnection !== undefined
            ? { defaultConnection: nextDoc.defaultConnection }
            : {}),
          ...(nextDoc.connections !== undefined ? { connections: nextDoc.connections } : {}),
        });
        if (!savedRes.ok) {
          this.lastStatusMessage = `Failed to save profile: ${formatValidationErrors(savedRes.error)}`;
          return { outputLines: [this.lastStatusMessage], shouldExit: false };
        }
        const actRes = activateNamedProfile(savedRes.value, profileName, this.gateway);
        if (!actRes.ok) {
          this.lastStatusMessage = `Failed to activate profile: ${formatValidationErrors(actRes.error)}`;
          return { outputLines: [this.lastStatusMessage], shouldExit: false };
        }
        nextDoc = actRes.value;
      }

      await this.saveLocalConnectionsDoc(nextDoc);
      this.lastStatusMessage =
        profileName.length > 0
          ? `Saved and activated connection profile "${profileName}".`
          : 'Saved active LLM connections.';
      return { outputLines: [this.lastStatusMessage], shouldExit: false };
    } catch (caught) {
      const msg = caught instanceof Error ? caught.message : 'Unable to save connections';
      this.lastStatusMessage = `Failed to save connections: ${msg}`;
      return { outputLines: [this.lastStatusMessage], shouldExit: false };
    }
  }

  private async handleLoadConnectionsCommand(arg: string): Promise<TuiHandleInputResult> {
    const profileName = arg.trim();
    if (profileName.length === 0 || !isSafeRecordKey(profileName)) {
      this.lastStatusMessage = 'Usage: /load-connections <profileName>';
      return { outputLines: [this.lastStatusMessage], shouldExit: false };
    }

    if (this.daemonUrl !== null) {
      await this.daemonFetch(
        `/api/connections/profiles/${encodeURIComponent(profileName)}/activate`,
        'POST',
        {}
      );
      this.lastStatusMessage = `Loaded connection profile "${profileName}".`;
      return { outputLines: [this.lastStatusMessage], shouldExit: false };
    }

    if (this.gateway === null) {
      this.lastStatusMessage = 'No ModelGateway bound to TUI controller.';
      return { outputLines: [this.lastStatusMessage], shouldExit: false };
    }

    try {
      const doc = await this.loadLocalConnectionsDoc();
      const actRes = activateNamedProfile(doc, profileName, this.gateway);
      if (!actRes.ok) {
        this.lastStatusMessage = `Failed to load profile: ${formatValidationErrors(actRes.error)}`;
        return { outputLines: [this.lastStatusMessage], shouldExit: false };
      }
      await this.saveLocalConnectionsDoc(actRes.value);
      this.lastStatusMessage = `Loaded connection profile "${profileName}".`;
      return { outputLines: [this.lastStatusMessage], shouldExit: false };
    } catch (caught) {
      const msg = caught instanceof Error ? caught.message : 'Unable to load connections';
      this.lastStatusMessage = `Failed to load connections: ${msg}`;
      return { outputLines: [this.lastStatusMessage], shouldExit: false };
    }
  }

  private async handleDisconnectRoleCommand(arg: string): Promise<TuiHandleInputResult> {
    const role = arg.trim();
    if (role.length === 0) {
      this.lastStatusMessage = 'Usage: /disconnect-role <role>';
      return { outputLines: [this.lastStatusMessage], shouldExit: false };
    }
    if (!isSafeRecordKey(role) || !VALID_AGENT_ROLES.has(role)) {
      this.lastStatusMessage = `Unknown agent role "${role}". Valid roles: ${AGENT_ROLES.join(', ')}`;
      return { outputLines: [this.lastStatusMessage], shouldExit: false };
    }

    if (this.daemonUrl !== null) {
      const connectionsPatch: Record<string, null> = {};
      setSafeOwn(connectionsPatch, role, null);
      await this.daemonFetch('/api/connections', 'PUT', {
        connections: connectionsPatch,
      });
    } else if (this.gateway !== null) {
      this.gateway.removeRoleConnection(role as AgentRole);
    } else {
      this.lastStatusMessage = 'No ModelGateway bound to TUI controller.';
      return { outputLines: [this.lastStatusMessage], shouldExit: false };
    }

    this.lastStatusMessage = `Removed connection override for role "${role}".`;
    return { outputLines: [this.lastStatusMessage], shouldExit: false };
  }

  private async handlePresetImportCommand(arg: string): Promise<TuiHandleInputResult> {
    const tokens = parseCommandArgs(arg);
    if (tokens.length !== 1) {
      this.lastStatusMessage = 'Usage: /preset-import <path>';
      return { outputLines: [this.lastStatusMessage], shouldExit: false };
    }
    const rawPath = tokens[0] as string;
    if (rawPath.trim().length === 0 || rawPath.includes('\0')) {
      this.lastStatusMessage = 'Invalid preset file path.';
      return { outputLines: [this.lastStatusMessage], shouldExit: false };
    }

    const resolvedPath = path.resolve(rawPath);
    let rawText: string;
    try {
      rawText = await fs.readFile(resolvedPath, 'utf8');
    } catch (caught) {
      const msg = caught instanceof Error ? caught.message : 'Unable to read preset file';
      this.lastStatusMessage = `Preset import failed: ${msg}`;
      return { outputLines: [this.lastStatusMessage], shouldExit: false };
    }

    const importRes = importSillyTavernPreset(rawText);
    if (!importRes.ok) {
      this.lastStatusMessage = `Preset import failed: ${formatValidationErrors(importRes.error)}`;
      return { outputLines: [this.lastStatusMessage], shouldExit: false };
    }

    const imported = importRes.value;
    if (this.runtime !== null) {
      const upRes = this.runtime.updateControlRoom((currentLayer) =>
        mergeControlRoomLayerOverlay(currentLayer, imported.layer)
      );
      if (!upRes.ok) {
        this.lastStatusMessage = `Preset apply failed: ${formatValidationErrors(upRes.error)}`;
        return { outputLines: [this.lastStatusMessage], shouldExit: false };
      }
    } else {
      const sessionId = this.requireDaemonSessionId();
      await this.daemonFetch('/api/presets/import', 'POST', {
        preset: rawText,
        sessionId,
      });
      await this.refreshFromDaemon();
    }

    this.lastStatusMessage = `Imported preset "${imported.presetName}" (format: ${imported.format}, warnings: ${imported.warnings.length}).`;
    const lines = [this.lastStatusMessage];
    for (const w of imported.warnings) {
      lines.push(`  [warning] ${w.path ? `${w.path}: ` : ''}${w.message}`);
    }
    return { outputLines: lines, shouldExit: false };
  }

  private async handlePresetExportCommand(arg: string): Promise<TuiHandleInputResult> {
    const tokens = parseCommandArgs(arg);
    if (tokens.length < 1 || tokens.length > 2) {
      this.lastStatusMessage = 'Usage: /preset-export <path> [st_chat|st_text|referee]';
      return { outputLines: [this.lastStatusMessage], shouldExit: false };
    }
    const rawPath = tokens[0] as string;
    const format = (tokens[1] ?? 'referee').toLowerCase();
    if (rawPath.trim().length === 0 || rawPath.includes('\0')) {
      this.lastStatusMessage = 'Invalid export file path.';
      return { outputLines: [this.lastStatusMessage], shouldExit: false };
    }
    if (format !== 'st_chat' && format !== 'st_text' && format !== 'referee') {
      this.lastStatusMessage = `Unsupported export format "${format}". Expected st_chat, st_text, or referee.`;
      return { outputLines: [this.lastStatusMessage], shouldExit: false };
    }

    let exportedPayload: unknown;
    if (this.runtime !== null) {
      const config = this.runtime.getConfig();
      if (format === 'st_chat') {
        exportedPayload = exportToSillyTavernChatCompletionPreset(config);
      } else if (format === 'st_text') {
        exportedPayload = exportToSillyTavernTextCompletionPreset(config);
      } else {
        exportedPayload = cloneControlRoomLayer(config);
      }
    } else {
      const encodedId = encodeURIComponent(this.requireDaemonSessionId());
      const res = await this.daemonFetch<{ ok: boolean; preset: unknown }>(
        `/api/sessions/${encodedId}/preset/export?format=${encodeURIComponent(format)}`,
        'GET'
      );
      exportedPayload = res.preset;
    }

    const resolvedPath = path.resolve(rawPath);
    try {
      await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
      await fs.writeFile(resolvedPath, `${JSON.stringify(exportedPayload, null, 2)}\n`, 'utf8');
    } catch (caught) {
      const msg = caught instanceof Error ? caught.message : 'Unable to write preset file';
      this.lastStatusMessage = `Preset export failed: ${msg}`;
      return { outputLines: [this.lastStatusMessage], shouldExit: false };
    }

    this.lastStatusMessage = `Exported preset (${format}) to ${resolvedPath}.`;
    return { outputLines: [this.lastStatusMessage], shouldExit: false };
  }

  private async handlePresetCommand(arg: string): Promise<TuiHandleInputResult> {
    const tokens = parseCommandArgs(arg);
    const sub = (tokens[0] ?? '').toLowerCase();

    if (sub === 'list') {
      let presets: SavedControlRoomPreset[];
      if (this.daemonUrl !== null) {
        const res = await this.daemonFetch<{ ok: boolean; presets: SavedControlRoomPreset[] }>(
          '/api/presets',
          'GET'
        );
        presets = res.presets;
      } else if (this.dataStore !== null) {
        presets = (await this.dataStore.listPresets()).items;
      } else {
        presets = [...this.localPresets.values()].sort((a, b) =>
          compareStringsDeterministic(a.id, b.id)
        );
      }

      if (presets.length === 0) {
        this.lastStatusMessage = 'No saved Control Room presets.';
        return { outputLines: [this.lastStatusMessage], shouldExit: false };
      }
      const lines = ['Saved Control Room Presets:'];
      for (const p of presets) {
        lines.push(`  ${p.id}: ${p.name} (${p.sourceFormat})`);
      }
      return this.showCommandOutput('SAVED PRESETS', lines, `Listed ${presets.length} preset(s).`);
    }

    if (sub === 'save') {
      const id = tokens[1] ?? '';
      const idCheck = validateSafeStorageId(id);
      if (!idCheck.ok) {
        this.lastStatusMessage =
          tokens.length < 2
            ? 'Usage: /preset save <id>'
            : `Invalid preset ID: ${formatValidationErrors(idCheck.error)}`;
        return { outputLines: [this.lastStatusMessage], shouldExit: false };
      }

      const snap = this.getSnapshot();
      const input: SaveControlRoomPresetInput = {
        id: idCheck.value,
        name: snap.config.generation?.presetName ?? idCheck.value,
        sourceFormat: snap.config.generation?.sourceFormat ?? 'referee',
        layer: cloneControlRoomLayer(snap.config),
      };

      if (this.daemonUrl !== null) {
        await this.daemonFetch('/api/presets', 'POST', input);
      } else if (this.dataStore !== null) {
        const saveRes = await this.dataStore.savePreset(input);
        if (!saveRes.ok) {
          this.lastStatusMessage = `Failed to save preset: ${formatValidationErrors(saveRes.error)}`;
          return { outputLines: [this.lastStatusMessage], shouldExit: false };
        }
      } else {
        this.localPresets.set(input.id, {
          ...input,
          updatedAt: new Date().toISOString(),
        });
      }

      this.lastStatusMessage = `Saved Control Room preset "${idCheck.value}".`;
      return { outputLines: [this.lastStatusMessage], shouldExit: false };
    }

    if (sub === 'load') {
      const id = tokens[1] ?? '';
      const idCheck = validateSafeStorageId(id);
      if (!idCheck.ok) {
        this.lastStatusMessage =
          tokens.length < 2
            ? 'Usage: /preset load <id>'
            : `Invalid preset ID: ${formatValidationErrors(idCheck.error)}`;
        return { outputLines: [this.lastStatusMessage], shouldExit: false };
      }

      if (this.daemonUrl !== null) {
        const encodedId = encodeURIComponent(this.requireDaemonSessionId());
        await this.daemonFetch(`/api/sessions/${encodedId}/control-room/apply-preset`, 'POST', {
          presetId: idCheck.value,
        });
        await this.refreshFromDaemon();
      } else if (this.runtime !== null) {
        let loaded: SavedControlRoomPreset | undefined;
        if (this.dataStore !== null) {
          const getRes = await this.dataStore.getPreset(idCheck.value);
          if (!getRes.ok) {
            this.lastStatusMessage = `Failed to load preset: ${formatValidationErrors(getRes.error)}`;
            return { outputLines: [this.lastStatusMessage], shouldExit: false };
          }
          loaded = getRes.value;
        } else {
          loaded = this.localPresets.get(idCheck.value);
          if (loaded === undefined) {
            this.lastStatusMessage = `Preset "${idCheck.value}" not found.`;
            return { outputLines: [this.lastStatusMessage], shouldExit: false };
          }
        }
        const upRes = this.runtime.updateControlRoom((currentLayer) =>
          mergeControlRoomLayerOverlay(currentLayer, loaded.layer)
        );
        if (!upRes.ok) {
          this.lastStatusMessage = `Failed to apply preset: ${formatValidationErrors(upRes.error)}`;
          return { outputLines: [this.lastStatusMessage], shouldExit: false };
        }
      }

      this.lastStatusMessage = `Loaded Control Room preset "${idCheck.value}".`;
      return { outputLines: [this.lastStatusMessage], shouldExit: false };
    }

    this.lastStatusMessage = 'Usage: /preset <save <id>|load <id>|list>';
    return { outputLines: [this.lastStatusMessage], shouldExit: false };
  }

  private async handleSheetPresetCommand(arg: string): Promise<TuiHandleInputResult> {
    const id = arg.trim();
    if (id.length === 0 || !isSafeRecordKey(id) || !Object.hasOwn(SHEET_PRESETS, id)) {
      this.lastStatusMessage = `Usage: /sheet-preset <${Object.keys(SHEET_PRESETS).join('|')}>`;
      return { outputLines: [this.lastStatusMessage], shouldExit: false };
    }

    const presetId = id as SheetPresetId;
    if (this.runtime !== null) {
      const upRes = this.runtime.updateControlRoom((currentLayer) =>
        applySheetPreset(currentLayer, presetId, 'both')
      );
      if (!upRes.ok) {
        this.lastStatusMessage = `Failed to apply sheet preset: ${formatValidationErrors(upRes.error)}`;
        return { outputLines: [this.lastStatusMessage], shouldExit: false };
      }
    } else {
      const encodedId = encodeURIComponent(this.requireDaemonSessionId());
      await this.daemonFetch(`/api/sessions/${encodedId}/control-room/apply-preset`, 'POST', {
        sheetPresetId: presetId,
        target: 'both',
      });
      await this.refreshFromDaemon();
    }

    this.lastStatusMessage = `Applied sheet preset "${presetId}" (${SHEET_PRESETS[presetId].name}).`;
    return { outputLines: [this.lastStatusMessage], shouldExit: false };
  }

  private async handleSamplingCommand(arg: string): Promise<TuiHandleInputResult> {
    if (arg.length === 0) {
      const snap = this.getSnapshot();
      const lines = formatGenerationSummaryLines(snap.config.generation);
      return this.showCommandOutput(
        'SAMPLING',
        lines,
        lines[0] ?? 'Generation Sampling'
      );
    }

    this.exitOutputViewIfActive();

    const tokens = arg.split(/\s+/).filter((t) => t.length > 0);
    const patch: Record<string, number> = {};

    for (const token of tokens) {
      const eqIdx = token.indexOf('=');
      if (eqIdx <= 0 || eqIdx === token.length - 1) {
        this.lastStatusMessage = `Invalid sampling assignment "${token}". Expected key=value.`;
        return { outputLines: [this.lastStatusMessage], shouldExit: false };
      }
      const rawKey = token.slice(0, eqIdx).trim().toLowerCase();
      const rawVal = token.slice(eqIdx + 1).trim();
      if (!isSafeRecordKey(rawKey) || !Object.hasOwn(SAMPLING_KEY_ALIASES, rawKey)) {
        this.lastStatusMessage = `Unknown sampling parameter "${rawKey}".`;
        return { outputLines: [this.lastStatusMessage], shouldExit: false };
      }
      const canonicalKey = SAMPLING_KEY_ALIASES[rawKey] as string;
      const numVal = Number(rawVal);
      if (!Number.isFinite(numVal)) {
        this.lastStatusMessage = `Invalid numeric value "${rawVal}" for "${rawKey}".`;
        return { outputLines: [this.lastStatusMessage], shouldExit: false };
      }
      if (INTEGER_SAMPLING_FIELDS.has(canonicalKey) && !Number.isInteger(numVal)) {
        this.lastStatusMessage = `Parameter "${canonicalKey}" must be an integer.`;
        return { outputLines: [this.lastStatusMessage], shouldExit: false };
      }
      setSafeOwn(patch, canonicalKey, numVal);
    }

    const genPatch = patch as Partial<GenerationPresetConfig>;
    if (this.runtime !== null) {
      const upRes = this.runtime.updateControlRoom((currentLayer) =>
        setGenerationPreset(currentLayer, genPatch)
      );
      if (!upRes.ok) {
        this.lastStatusMessage = `Sampling update failed: ${formatValidationErrors(upRes.error)}`;
        return { outputLines: [this.lastStatusMessage], shouldExit: false };
      }
    } else {
      const encodedId = encodeURIComponent(this.requireDaemonSessionId());
      await this.daemonFetch(`/api/sessions/${encodedId}/control-room`, 'PATCH', {
        layer: { generation: genPatch },
      });
      await this.refreshFromDaemon();
    }

    const updatedSummary = formatGenerationSummaryLines(this.getSnapshot().config.generation);
    this.lastStatusMessage = `Updated sampling: ${updatedSummary[0]}`;
    return { outputLines: updatedSummary, shouldExit: false };
  }

  private async handlePersonaCommand(arg: string): Promise<TuiHandleInputResult> {
    const trimmed = arg.trim();
    if (trimmed.length === 0) {
      this.lastStatusMessage =
        'Usage: /persona <set <name> | <desc> | section <secId> <value> | save <id> | load <id> | list>';
      return { outputLines: [this.lastStatusMessage], shouldExit: false };
    }

    const firstSpace = trimmed.indexOf(' ');
    const sub = (firstSpace >= 0 ? trimmed.slice(0, firstSpace) : trimmed).toLowerCase();
    const rest = firstSpace >= 0 ? trimmed.slice(firstSpace + 1).trim() : '';

    if (sub === 'list') {
      let personas: UserPersonaPreset[];
      if (this.daemonUrl !== null) {
        const res = await this.daemonFetch<{ ok: boolean; personas: UserPersonaPreset[] }>(
          '/api/personas',
          'GET'
        );
        personas = res.personas;
      } else if (this.dataStore !== null) {
        personas = (await this.dataStore.listPersonas()).items;
      } else {
        personas = [...this.localPersonas.values()].sort((a, b) =>
          compareStringsDeterministic(a.id, b.id)
        );
      }

      if (personas.length === 0) {
        this.lastStatusMessage = 'No saved personas.';
        return { outputLines: [this.lastStatusMessage], shouldExit: false };
      }
      const lines = ['Saved Personas:'];
      for (const p of personas) {
        lines.push(`  ${p.id}: ${p.name}${p.description ? ` - ${p.description}` : ''}`);
      }
      return this.showCommandOutput('SAVED PERSONAS', lines, `Listed ${personas.length} persona(s).`);
    }

    if (sub === 'set') {
      if (rest.length === 0) {
        this.lastStatusMessage = 'Usage: /persona set <name> | <description>';
        return { outputLines: [this.lastStatusMessage], shouldExit: false };
      }
      const pipeIdx = rest.indexOf('|');
      const name = (pipeIdx >= 0 ? rest.slice(0, pipeIdx) : rest).trim();
      const description = pipeIdx >= 0 ? rest.slice(pipeIdx + 1).trim() : '';
      if (name.length === 0) {
        this.lastStatusMessage = 'Usage: /persona set <name> | <description>';
        return { outputLines: [this.lastStatusMessage], shouldExit: false };
      }

      const prev =
        this.runtime !== null ? this.runtime.getActivePersona() : this.daemonActivePersona;
      const nextPersona: UserPersonaPreset = {
        id: prev?.id ?? 'active-persona',
        name,
        description,
        ...(prev?.characterId !== undefined ? { characterId: prev.characterId } : {}),
        ...(prev?.sections !== undefined ? { sections: prev.sections } : {}),
        ...(prev?.customFields !== undefined ? { customFields: prev.customFields } : {}),
        ...(prev?.resources !== undefined ? { resources: prev.resources } : {}),
        ...(prev?.progression !== undefined ? { progression: prev.progression } : {}),
      };

      if (this.runtime !== null) {
        const res = await this.runtime.applyUserPersona(nextPersona);
        if (!res.ok) {
          this.lastStatusMessage = `Failed to apply persona: ${formatValidationErrors(res.error)}`;
          return { outputLines: [this.lastStatusMessage], shouldExit: false };
        }
      } else {
        const encodedId = encodeURIComponent(this.requireDaemonSessionId());
        await this.daemonFetch(`/api/sessions/${encodedId}/persona`, 'PUT', {
          persona: nextPersona,
        });
        this.daemonActivePersona = cloneUserPersonaPreset(nextPersona);
        await this.refreshFromDaemon();
      }

      this.lastStatusMessage = `Active persona set to "${name}".`;
      return { outputLines: [this.lastStatusMessage], shouldExit: false };
    }

    if (sub === 'section') {
      const secSpace = rest.indexOf(' ');
      if (secSpace <= 0) {
        this.lastStatusMessage = 'Usage: /persona section <secId> <value>';
        return { outputLines: [this.lastStatusMessage], shouldExit: false };
      }
      const secId = rest.slice(0, secSpace).trim();
      const value = rest.slice(secSpace + 1).trim();
      if (!isSafeRecordKey(secId) || value.length === 0) {
        this.lastStatusMessage = 'Usage: /persona section <secId> <value>';
        return { outputLines: [this.lastStatusMessage], shouldExit: false };
      }

      if (this.runtime !== null) {
        const sectionsPatch: Record<string, string> = {};
        setSafeOwn(sectionsPatch, secId, value);
        const res = await this.runtime.updatePlayerProfile({ sections: sectionsPatch });
        if (!res.ok) {
          this.lastStatusMessage = `Failed to update section: ${formatValidationErrors(res.error)}`;
          return { outputLines: [this.lastStatusMessage], shouldExit: false };
        }
      } else {
        const snap = this.getSnapshot();
        const base =
          this.daemonActivePersona !== null
            ? cloneUserPersonaPreset(this.daemonActivePersona)
            : {
                id: `profile-${this.requireDaemonSessionId()}`,
                name: snap.state.player.name,
                description: '',
                sections: { ...snap.state.player.sections },
              };
        const nextSections: Record<string, string | string[]> = {};
        if (base.sections !== undefined) {
          for (const [k, v] of Object.entries(base.sections)) {
            if (isSafeRecordKey(k)) {
              setSafeOwn(nextSections, k, Array.isArray(v) ? [...v] : v);
            }
          }
        }
        setSafeOwn(nextSections, secId, value);
        const nextPersona: UserPersonaPreset = { ...base, sections: nextSections };
        const encodedId = encodeURIComponent(this.requireDaemonSessionId());
        await this.daemonFetch(`/api/sessions/${encodedId}/persona`, 'PUT', {
          persona: nextPersona,
        });
        this.daemonActivePersona = cloneUserPersonaPreset(nextPersona);
        await this.refreshFromDaemon();
      }

      this.lastStatusMessage = `Updated persona section "${secId}".`;
      return { outputLines: [this.lastStatusMessage], shouldExit: false };
    }

    if (sub === 'save') {
      const idCheck = validateSafeStorageId(rest);
      if (!idCheck.ok) {
        this.lastStatusMessage =
          rest.length === 0
            ? 'Usage: /persona save <id>'
            : `Invalid persona ID: ${formatValidationErrors(idCheck.error)}`;
        return { outputLines: [this.lastStatusMessage], shouldExit: false };
      }

      const snap = this.getSnapshot();
      const base =
        this.runtime !== null ? this.runtime.getActivePersona() : this.daemonActivePersona;
      const candidate: UserPersonaPreset = {
        id: idCheck.value,
        name: base?.name ?? snap.state.player.name,
        description: base?.description ?? '',
        ...(base?.characterId !== undefined
          ? { characterId: base.characterId }
          : snap.state.player.characterId !== null
            ? { characterId: snap.state.player.characterId }
            : {}),
        sections: base?.sections ?? snap.state.player.sections,
        customFields: base?.customFields ?? snap.state.player.customFields,
        ...(base?.resources !== undefined ? { resources: base.resources } : {}),
        ...(base?.progression !== undefined ? { progression: base.progression } : {}),
        updatedAt: new Date().toISOString(),
      };

      const validated = validateUserPersonaPreset(candidate);
      if (!validated.ok) {
        this.lastStatusMessage = `Invalid persona: ${formatValidationErrors(validated.error)}`;
        return { outputLines: [this.lastStatusMessage], shouldExit: false };
      }

      if (this.daemonUrl !== null) {
        await this.daemonFetch('/api/personas', 'POST', validated.value);
      } else if (this.dataStore !== null) {
        const saveRes = await this.dataStore.savePersona(validated.value);
        if (!saveRes.ok) {
          this.lastStatusMessage = `Failed to save persona: ${formatValidationErrors(saveRes.error)}`;
          return { outputLines: [this.lastStatusMessage], shouldExit: false };
        }
      } else {
        this.localPersonas.set(validated.value.id, cloneUserPersonaPreset(validated.value));
      }

      this.lastStatusMessage = `Saved persona "${idCheck.value}".`;
      return { outputLines: [this.lastStatusMessage], shouldExit: false };
    }

    if (sub === 'load') {
      const idCheck = validateSafeStorageId(rest);
      if (!idCheck.ok) {
        this.lastStatusMessage =
          rest.length === 0
            ? 'Usage: /persona load <id>'
            : `Invalid persona ID: ${formatValidationErrors(idCheck.error)}`;
        return { outputLines: [this.lastStatusMessage], shouldExit: false };
      }

      if (this.daemonUrl !== null) {
        const encodedId = encodeURIComponent(this.requireDaemonSessionId());
        const putRes = await this.daemonFetch<{
          ok: boolean;
          activePersona: UserPersonaPreset | null;
        }>(`/api/sessions/${encodedId}/persona`, 'PUT', { personaId: idCheck.value });
        this.daemonActivePersona = putRes.activePersona
          ? cloneUserPersonaPreset(putRes.activePersona)
          : null;
        await this.refreshFromDaemon();
      } else if (this.runtime !== null) {
        let persona: UserPersonaPreset | undefined;
        if (this.dataStore !== null) {
          const getRes = await this.dataStore.getPersona(idCheck.value);
          if (!getRes.ok) {
            this.lastStatusMessage = `Failed to load persona: ${formatValidationErrors(getRes.error)}`;
            return { outputLines: [this.lastStatusMessage], shouldExit: false };
          }
          persona = getRes.value;
        } else {
          persona = this.localPersonas.get(idCheck.value);
          if (persona === undefined) {
            this.lastStatusMessage = `Persona "${idCheck.value}" not found.`;
            return { outputLines: [this.lastStatusMessage], shouldExit: false };
          }
        }
        const applyRes = await this.runtime.applyUserPersona(persona);
        if (!applyRes.ok) {
          this.lastStatusMessage = `Failed to apply persona: ${formatValidationErrors(applyRes.error)}`;
          return { outputLines: [this.lastStatusMessage], shouldExit: false };
        }
      }

      this.lastStatusMessage = `Loaded persona "${idCheck.value}".`;
      return { outputLines: [this.lastStatusMessage], shouldExit: false };
    }

    this.lastStatusMessage =
      'Usage: /persona <set <name> | <desc> | section <secId> <value> | save <id> | load <id> | list>';
    return { outputLines: [this.lastStatusMessage], shouldExit: false };
  }

  private async handleCharactersCommand(arg: string): Promise<TuiHandleInputResult> {
    let roster: SettingRosterInspection;
    if (this.runtime !== null) {
      roster = this.runtime.inspectSettingCharacters(arg.length > 0 ? { query: arg } : undefined);
    } else {
      const encodedId = encodeURIComponent(this.requireDaemonSessionId());
      const queryStr = arg.length > 0 ? `?query=${encodeURIComponent(arg)}` : '';
      roster = await this.daemonFetch<SettingRosterInspection & { ok: boolean }>(
        `/api/sessions/${encodedId}/characters${queryStr}`,
        'GET'
      );
    }

    return this.showCommandOutput(
      'SETTING CHARACTERS',
      formatSettingRosterLines(roster),
      `Cast: ${roster.totalCharacters} character(s) (${roster.presentCount} present).`
    );
  }

  private async handleInspectCommand(arg: string): Promise<TuiHandleInputResult> {
    if (arg.trim().length === 0) {
      this.lastStatusMessage = 'Usage: /inspect <id|name|player>';
      return { outputLines: [this.lastStatusMessage], shouldExit: false };
    }

    let dossier: CharacterDossier | null = null;
    if (this.runtime !== null) {
      dossier = this.runtime.inspectCharacterDossier(arg.trim());
    } else {
      const encodedId = encodeURIComponent(this.requireDaemonSessionId());
      try {
        const res = await this.daemonFetch<{ ok: boolean; dossier: CharacterDossier }>(
          `/api/sessions/${encodedId}/characters/${encodeURIComponent(arg.trim())}`,
          'GET'
        );
        dossier = res.dossier;
      } catch (caught) {
        const msg = caught instanceof Error ? caught.message : 'Character not found';
        this.lastStatusMessage = msg;
        return { outputLines: [msg], shouldExit: false };
      }
    }

    if (dossier === null) {
      this.lastStatusMessage = `Character "${arg.trim()}" not found.`;
      return { outputLines: [this.lastStatusMessage], shouldExit: false };
    }

    return this.showCommandOutput(
      `DOSSIER: ${dossier.summary.name}`,
      formatDossierLines(dossier),
      `Inspected character "${dossier.summary.name}" (${dossier.summary.id}).`
    );
  }

  private handlePinCommand(arg: string): TuiHandleInputResult {
    const id = arg.trim();
    if (id.length === 0 || /\s/.test(id) || !isSafeRecordKey(id)) {
      this.lastStatusMessage = 'Usage: /pin <characterId>';
      return { outputLines: [this.lastStatusMessage], shouldExit: false };
    }

    const nextPins = [...(this.directorSteering.pinCharacterIds ?? [])];
    if (!nextPins.includes(id)) {
      nextPins.push(id);
    }
    const nextDismiss = (this.directorSteering.dismissCharacterIds ?? []).filter((d) => d !== id);

    this.directorSteering = {
      ...this.directorSteering,
      pinCharacterIds: nextPins,
      ...(nextDismiss.length > 0 ? { dismissCharacterIds: nextDismiss } : {}),
    };
    if (nextDismiss.length === 0) {
      const { dismissCharacterIds: _removed, ...rest } = this.directorSteering;
      this.directorSteering = rest;
    }

    this.lastStatusMessage = `Staged Director pin for character "${id}".`;
    return { outputLines: [this.lastStatusMessage], shouldExit: false };
  }

  private handleUnpinCommand(arg: string): TuiHandleInputResult {
    const id = arg.trim();
    if (id.length === 0 || /\s/.test(id) || !isSafeRecordKey(id)) {
      this.lastStatusMessage = 'Usage: /unpin <characterId>';
      return { outputLines: [this.lastStatusMessage], shouldExit: false };
    }

    const currentPins = this.directorSteering.pinCharacterIds ?? [];
    const wasStaged = currentPins.includes(id);
    const nextPins = currentPins.filter((p) => p !== id);
    const snap = this.getSnapshot();
    const isCurrentlyPinned = snap.state.scene.pinnedCharacterIds.includes(id);

    const { pinCharacterIds: _removedPins, ...baseSteering } = this.directorSteering;
    const nextSteering: DirectorSteeringInput = {
      ...baseSteering,
      ...(nextPins.length > 0 ? { pinCharacterIds: nextPins } : {}),
    };

    if (isCurrentlyPinned) {
      const nextDismiss = [...(nextSteering.dismissCharacterIds ?? [])];
      if (!nextDismiss.includes(id)) {
        nextDismiss.push(id);
      }
      this.directorSteering = { ...nextSteering, dismissCharacterIds: nextDismiss };
      this.lastStatusMessage = `Staged unpin/dismiss for character "${id}".`;
      return { outputLines: [this.lastStatusMessage], shouldExit: false };
    }

    this.directorSteering = nextSteering;
    this.lastStatusMessage = wasStaged
      ? `Removed staged pin for character "${id}".`
      : `Character "${id}" is not currently pinned.`;
    return { outputLines: [this.lastStatusMessage], shouldExit: false };
  }

  private handleDismissCommand(arg: string): TuiHandleInputResult {
    const id = arg.trim();
    if (id.length === 0 || /\s/.test(id) || !isSafeRecordKey(id)) {
      this.lastStatusMessage = 'Usage: /dismiss <characterId>';
      return { outputLines: [this.lastStatusMessage], shouldExit: false };
    }

    const nextDismiss = [...(this.directorSteering.dismissCharacterIds ?? [])];
    if (!nextDismiss.includes(id)) {
      nextDismiss.push(id);
    }
    const nextPins = (this.directorSteering.pinCharacterIds ?? []).filter((p) => p !== id);

    const { pinCharacterIds: _removedPins, ...baseSteering } = this.directorSteering;
    this.directorSteering = {
      ...baseSteering,
      ...(nextPins.length > 0 ? { pinCharacterIds: nextPins } : {}),
      dismissCharacterIds: nextDismiss,
    };

    this.lastStatusMessage = `Staged Director dismiss for character "${id}".`;
    return { outputLines: [this.lastStatusMessage], shouldExit: false };
  }

  private async handleStartCombatCommand(arg: string): Promise<TuiHandleInputResult> {
    const snap = this.getSnapshot();
    if (snap.config.capabilities.combatMode === 'disabled') {
      this.lastStatusMessage =
        'Combat is disabled in the current System Pack (capabilities.combatMode="disabled").';
      return { outputLines: [this.lastStatusMessage], shouldExit: false };
    }

    const requestedIds = arg.split(/\s+/).filter((t) => t.length > 0);
    for (const id of requestedIds) {
      if (!isSafeRecordKey(id)) {
        this.lastStatusMessage = `Invalid enemy ID "${id}".`;
        return { outputLines: [this.lastStatusMessage], shouldExit: false };
      }
    }

    const state = snap.state;
    const linkedChar =
      state.player.characterId !== null
        ? getSafeOwn(state.entities.characters, state.player.characterId)
        : undefined;
    const playerHpPool = state.player.resources?.['hp'] ?? linkedChar?.resources?.['hp'];
    const playerCombatant: CombatantState = {
      id: state.player.characterId ?? state.player.id ?? 'player',
      name: linkedChar?.name ?? (state.player.name || 'Player'),
      team: 'ally',
      coord: { x: 1, y: 1 },
      alive: true,
      hp: playerHpPool?.current ?? 30,
      maxHp: playerHpPool?.max ?? 30,
      ac: 12,
      speed: 6,
      remainingMovement: 6,
      remainingActions: { action: 1, bonus: 1, reaction: 1 },
      resources: {},
      cooldowns: {},
      stats: {
        str: 3,
        dex: 2,
        initiative: 12,
        ...(state.player.progression?.attributes ?? linkedChar?.progression?.attributes ?? {}),
      },
      statuses: [],
      abilities:
        linkedChar !== undefined && linkedChar.abilities.length > 0
          ? [...linkedChar.abilities]
          : ['basic_strike'],
      passives: [],
      willpower: 10,
      maxWillpower: 10,
    };

    const participants: CombatantState[] = [playerCombatant];
    const enemyTargets = requestedIds.length > 0 ? requestedIds : ['enemy_1'];

    for (let i = 0; i < enemyTargets.length; i += 1) {
      const targetId = enemyTargets[i] as string;
      const char = getSafeOwn(state.entities.characters, targetId);
      const hpPool = char?.resources?.['hp'];
      participants.push({
        id: char?.id ?? targetId,
        name: char?.name ?? (requestedIds.length > 0 ? targetId : 'Opponent'),
        team: 'enemy',
        coord: { x: 3 + (i % 3), y: 1 + Math.floor(i / 3) },
        alive: true,
        hp: hpPool?.current ?? 20,
        maxHp: hpPool?.max ?? 20,
        ac: 11,
        speed: 6,
        remainingMovement: 6,
        remainingActions: { action: 1, bonus: 1, reaction: 1 },
        resources: {},
        cooldowns: {},
        stats: {
          str: 2,
          dex: 2,
          initiative: 10,
          ...(char?.progression?.attributes ?? {}),
        },
        statuses: [],
        abilities:
          char !== undefined && char.abilities.length > 0
            ? [...char.abilities]
            : ['basic_strike'],
        passives: [],
        willpower: 8,
        maxWillpower: 8,
      });
    }

    let combatState: CombatState;
    if (this.runtime !== null) {
      const res = this.runtime.startCombat(participants);
      if (!res.ok) {
        this.lastStatusMessage = `Failed to start combat: ${formatValidationErrors(res.error)}`;
        return { outputLines: [this.lastStatusMessage], shouldExit: false };
      }
      combatState = res.value.combatState;
    } else {
      const encodedId = encodeURIComponent(this.requireDaemonSessionId());
      const res = await this.daemonFetch<{ ok: boolean; combatState: CombatState }>(
        `/api/sessions/${encodedId}/combat/start`,
        'POST',
        { participants }
      );
      combatState = res.combatState;
      await this.refreshFromDaemon();
    }

    this.lastStatusMessage = `Started combat (${combatState.mode}, round ${combatState.round}, ${participants.length} combatants).`;
    return { outputLines: [this.lastStatusMessage], shouldExit: false };
  }

  /**
   * Display an unexpected runtime/network error cleanly in the TUI `'output'` pane.
   */
  showErrorMessage(message: string): void {
    const lines = message.trim().length > 0 ? message.split('\n') : ['Unknown error'];
    this.showCommandOutput('ERROR', lines, `Error: ${lines[0] ?? 'Unknown error'}`);
  }

  private showCommandOutput(
    title: string,
    lines: readonly string[],
    statusMessage?: string
  ): TuiHandleInputResult {
    if (this.viewMode !== 'output') {
      this.previousViewMode = this.viewMode;
    }
    this.viewMode = 'output';
    this.commandOutputTitle = title;
    this.commandOutputLines = [...lines];
    this.commandOutputPage = 0;
    this.lastStatusMessage = statusMessage ?? `${title} (/next /prev /hud to return).`;
    return { outputLines: [...lines], shouldExit: false };
  }

  private exitOutputViewIfActive(): void {
    if (this.viewMode === 'output') {
      this.viewMode = this.previousViewMode;
    }
  }

  private renderCommandOutputPane(width: number, bodyHeight: number): string[] {
    const wrapped: string[] = [];
    for (const line of this.commandOutputLines) {
      if (line.length === 0) {
        wrapped.push('');
      } else {
        wrapped.push(...wrapText(line, width));
      }
    }
    if (wrapped.length === 0) {
      wrapped.push('(no output)');
    }

    const pageSize = Math.max(1, bodyHeight - 1);
    const totalPages = Math.max(1, Math.ceil(wrapped.length / pageSize));
    const page = Math.max(0, Math.min(this.commandOutputPage, totalPages - 1));
    this.commandOutputPage = page;

    const start = page * pageSize;
    const slice = wrapped.slice(start, start + pageSize);
    const header = truncateLine(
      `[ ${this.commandOutputTitle || 'OUTPUT'} | Page ${page + 1}/${totalPages} | /next /prev /hud ]`,
      width
    );
    return [header, ...slice];
  }

  /**
   * Render the full terminal frame cleanly bounded to `viewport` (default `80x24` Termux safe).
   * Guarantees every line has `line.length <= viewport.width` and total lines `<= viewport.height`.
   */
  renderScreen(
    viewport: TuiViewport = DEFAULT_VIEWPORT,
    options: TuiRenderOptions = {}
  ): string {
    const width = Math.max(20, Math.floor(viewport.width));
    const height = Math.max(8, Math.floor(viewport.height));

    const snap = this.getSnapshot();
    const diffReport = snap.diffReport;

    const headerText = `REFEREE | Pack: ${snap.config.packId} | View: ${this.viewMode} | Turn: ${snap.state.meta.turn}`;
    const headerLine = truncateLine(headerText, width);
    const dividerLine = '-'.repeat(width);

    const steeringBadges: string[] = [];
    if (snap.state.clocks.held && snap.config.capabilities.clocks !== 'disabled') {
      steeringBadges.push('CLOCK:HELD');
    }
    if (this.directorSteering.clockAction !== undefined) {
      const act =
        typeof this.directorSteering.clockAction === 'string'
          ? this.directorSteering.clockAction
          : `+${this.directorSteering.clockAction.advanceSlots}slot`;
      steeringBadges.push(`STAGE:${act}`);
    }
    if (
      typeof this.directorSteering.oocNudge === 'string' &&
      this.directorSteering.oocNudge.length > 0
    ) {
      steeringBadges.push('NUDGE');
    }
    if (
      this.directorSteering.pinCharacterIds !== undefined &&
      this.directorSteering.pinCharacterIds.length > 0
    ) {
      steeringBadges.push(`PIN:${this.directorSteering.pinCharacterIds.length}`);
    }
    if (
      this.directorSteering.dismissCharacterIds !== undefined &&
      this.directorSteering.dismissCharacterIds.length > 0
    ) {
      steeringBadges.push(`DISMISS:${this.directorSteering.dismissCharacterIds.length}`);
    }
    if (snap.pendingConfirmations.length > 0) {
      steeringBadges.push(`CONFIRM:${snap.pendingConfirmations.length}`);
    }

    const directorStatus =
      steeringBadges.length > 0 ? `[${steeringBadges.join(' | ')}] ` : '';
    const statusOrHint =
      this.lastStatusMessage ??
      '/hud /control-room /combat /audit /chronicle /pack /toggle /wizard /help';

    let footerLines: string[];
    if (options.hidePromptLine === true) {
      const wrappedStatus = wrapText(`Director: ${directorStatus}${statusOrHint}`, width);
      footerLines = wrappedStatus.slice(0, 2).map((line) => truncateLine(line, width));
      if (footerLines.length === 0) {
        footerLines = [truncateLine(`Director: ${directorStatus}${statusOrHint}`, width)];
      }
    } else {
      const footerLine1 = truncateLine(`Director: ${directorStatus}${statusOrHint}`, width);
      const footerLine2 = truncateLine('> Type action or /command', width);
      footerLines = [footerLine1, footerLine2];
    }

    const reservedLines = 2 + footerLines.length; // header + divider + footerLines
    const bodyHeight = Math.max(1, height - reservedLines);
    const bodyLines = this.renderBodyPane(snap, diffReport, width, bodyHeight);
    const boundedBody = padOrTrimLines(bodyLines, bodyHeight, width);

    return [headerLine, dividerLine, ...boundedBody, ...footerLines].join('\n');
  }

  private renderBodyPane(
    snap: DaemonStateSnapshot,
    diffReport: ControlRoomDiffReport | undefined,
    width: number,
    bodyHeight: number
  ): string[] {
    if (this.viewMode === 'output') {
      return this.renderCommandOutputPane(width, bodyHeight);
    }

    if (this.viewMode === 'control_room') {
      return renderControlRoomPane({
        config: snap.config,
        ...(diffReport !== undefined ? { diffReport } : {}),
        width,
      });
    }

    if (this.viewMode === 'combat') {
      if (snap.combatState === null) {
        return [truncateLine('No active combat encounter.', width)];
      }
      return renderCombatGridPane(snap.combatState, width);
    }

    if (this.viewMode === 'audit') {
      const lines = renderAuditAndChroniclePane({
        auditEntries: snap.auditLog,
        chronicleEvents: snap.state.chronicle.events,
        ...(this.auditFilter !== undefined ? { filter: this.auditFilter } : {}),
        mode: 'audit',
        width,
      });
      if (lines.length > bodyHeight && bodyHeight > 1) {
        return [lines[0] ?? '', ...lines.slice(lines.length - (bodyHeight - 1))];
      }
      return lines;
    }

    if (this.viewMode === 'chronicle') {
      const lines = renderAuditAndChroniclePane({
        auditEntries: snap.auditLog,
        chronicleEvents: snap.state.chronicle.events,
        mode: 'chronicle',
        width,
      });
      if (lines.length > bodyHeight && bodyHeight > 1) {
        return [lines[0] ?? '', ...lines.slice(lines.length - (bodyHeight - 1))];
      }
      return lines;
    }

    // Play mode: stacked HUD + Chat for 80x24 Termux, or side-by-side when wide (>= 110 cols)
    const messages = buildChatMessagesFromTree(snap.swipeTree);
    const hudLines = renderDynamicHudPane({
      state: snap.state,
      config: snap.config,
      beatLedger: snap.beatLedger,
      pendingConfirmationsCount: snap.pendingConfirmations.length,
      width: width >= 110 ? Math.max(30, Math.floor(width * 0.35)) : width,
    });

    if (width >= 110 && bodyHeight >= 6) {
      const hudWidth = Math.max(30, Math.floor(width * 0.35));
      const chatWidth = Math.max(20, width - hudWidth - 3);
      const chatLines = renderChatPane({
        messages,
        ...(this.streamingBuffer.length > 0 ? { streamingBuffer: this.streamingBuffer } : {}),
        width: chatWidth,
        maxLines: bodyHeight,
      });

      const merged: string[] = [];
      for (let i = 0; i < bodyHeight; i += 1) {
        const left = (chatLines[i] ?? '').padEnd(chatWidth, ' ');
        const right = truncateLine(hudLines[i] ?? '', hudWidth);
        merged.push(truncateLine(`${left} | ${right}`, width));
      }
      return merged;
    }

    const maxHudLines = Math.max(1, Math.min(hudLines.length, Math.floor(bodyHeight * 0.45)));
    const visibleHud = hudLines.slice(0, maxHudLines);
    const showDivider = bodyHeight >= visibleHud.length + 3;
    const chatMaxLines = Math.max(
      1,
      bodyHeight - visibleHud.length - (showDivider ? 1 : 0)
    );
    const chatLines = renderChatPane({
      messages,
      ...(this.streamingBuffer.length > 0 ? { streamingBuffer: this.streamingBuffer } : {}),
      width,
      maxLines: chatMaxLines,
    });

    return showDivider
      ? [...visibleHud, '-'.repeat(width), ...chatLines]
      : [...visibleHud, ...chatLines];
  }

  private getSnapshot(): DaemonStateSnapshot {
    if (this.runtime !== null) {
      const config = this.runtime.getConfig();
      const diffReport = computeControlRoomDiffReport(
        config,
        this.trackedBasePack,
        this.cartridge?.systemOverrides
      );
      return {
        state: this.runtime.getState(),
        beatLedger: this.runtime.getBeatLedger(),
        combatState: this.runtime.getCombatState(),
        config,
        pendingConfirmations: this.runtime.getPendingConfirmations(),
        diffReport,
        swipeTree: this.runtime.getSwipeTree(),
        auditLog: this.runtime.getAuditLog(),
      };
    }

    if (this.cachedSnapshot !== null) {
      return this.cachedSnapshot;
    }

    throw new Error('Daemon snapshot not loaded. Call connectDaemonSession() first.');
  }

  private consumeStagedSteering(): DirectorSteeringInput | undefined {
    if (!hasAnySteering(this.directorSteering)) {
      return undefined;
    }
    const steering = cloneDirectorSteering(this.directorSteering);
    const {
      oocNudge: _clearedNudge,
      clockAction: _clearedClock,
      pinCharacterIds: _clearedPins,
      dismissCharacterIds: _clearedDismiss,
      ...remaining
    } = this.directorSteering;
    this.directorSteering = remaining;
    return steering;
  }

  private async handleTurnInput(text: string): Promise<TuiHandleInputResult> {
    this.exitOutputViewIfActive();
    const steering = this.consumeStagedSteering();

    if (this.runtime !== null) {
      const res = await this.runtime.executeTurn({
        text,
        ...(steering !== undefined ? { directorSteering: steering } : {}),
      });
      if (!res.ok) {
        const msg = formatValidationErrors(res.error);
        this.lastStatusMessage = `Turn failed: ${msg}`;
        return { outputLines: [this.lastStatusMessage], shouldExit: false };
      }
      this.lastStatusMessage = `Turn ${res.value.turn} complete.`;
      return {
        outputLines: wrapText(res.value.narratorText, 80),
        shouldExit: false,
      };
    }

    const encodedId = encodeURIComponent(this.requireDaemonSessionId());
    const turnRes = await this.daemonFetch<{
      ok: boolean;
      turn: number;
      narratorText: string;
    }>(`/api/sessions/${encodedId}/turn`, 'POST', {
      text,
      ...(steering !== undefined ? { directorSteering: steering } : {}),
    });
    await this.refreshFromDaemon();
    this.lastStatusMessage = `Turn ${turnRes.turn} complete.`;
    return {
      outputLines: wrapText(turnRes.narratorText, 80),
      shouldExit: false,
    };
  }

  private async handlePackCommand(packId: string): Promise<TuiHandleInputResult> {
    if (packId.length === 0 || !isSafeRecordKey(packId)) {
      this.lastStatusMessage = 'Usage: /pack <system-pack-id>';
      return { outputLines: [this.lastStatusMessage], shouldExit: false };
    }

    if (this.runtime !== null) {
      const pack = getSafeOwn(this.customPacks, packId) ?? getStockSystemPack(packId);
      if (pack === undefined) {
        this.lastStatusMessage = `Unknown System Pack "${packId}".`;
        return { outputLines: [this.lastStatusMessage], shouldExit: false };
      }
      const res = this.runtime.switchSystemPack(pack);
      if (!res.ok) {
        this.lastStatusMessage = `Failed to switch pack: ${formatValidationErrors(res.error)}`;
        return { outputLines: [this.lastStatusMessage], shouldExit: false };
      }
      this.trackedBasePack = pack;
      this.lastStatusMessage = `Switched System Pack to "${res.value.packName}" (${res.value.packId}).`;
      return { outputLines: [this.lastStatusMessage], shouldExit: false };
    }

    const encodedId = encodeURIComponent(this.requireDaemonSessionId());
    const patchRes = await this.daemonFetch<{
      ok: boolean;
      config: ResolvedControlRoomConfig;
    }>(`/api/sessions/${encodedId}/control-room`, 'PATCH', {
      systemPackId: packId,
    });
    await this.refreshFromDaemon();
    this.lastStatusMessage = `Switched System Pack to "${patchRes.config.packName}" (${patchRes.config.packId}).`;
    return { outputLines: [this.lastStatusMessage], shouldExit: false };
  }

  private async handleToggleCommand(targetId: string): Promise<TuiHandleInputResult> {
    if (targetId.length === 0) {
      this.lastStatusMessage = 'Usage: /toggle <moduleId|capability>';
      return { outputLines: [this.lastStatusMessage], shouldExit: false };
    }

    const [rawKey, rawExplicitVal] = targetId.split('=');
    const key = rawKey?.trim() ?? '';
    if (!isSafeRecordKey(key)) {
      this.lastStatusMessage = `Invalid toggle target "${targetId}".`;
      return { outputLines: [this.lastStatusMessage], shouldExit: false };
    }

    const snap = this.getSnapshot();
    const matchedModule = snap.config.gameSystems.find((m) => m.id === key);

    if (matchedModule !== undefined) {
      const nextEnabled =
        rawExplicitVal !== undefined
          ? rawExplicitVal.trim().toLowerCase() === 'on' ||
            rawExplicitVal.trim().toLowerCase() === 'true'
          : !matchedModule.enabled;

      const applyToggleLayer = (currentLayer: Readonly<ControlRoomLayer>): ControlRoomLayer => {
        const nextLayer = cloneControlRoomLayer(currentLayer);
        const existingCustom = (nextLayer.gameSystems ?? []).find((m) => m.id === key);
        if (existingCustom !== undefined && nextLayer.gameSystems !== undefined) {
          nextLayer.gameSystems = nextLayer.gameSystems.map((m) =>
            m.id === key ? { ...cloneGameSystemModule(m), enabled: nextEnabled } : m
          );
        } else {
          const overrides = nextLayer.gameSystemOverrides ?? {};
          const prevOverride = getSafeOwn(overrides, key) ?? {};
          setSafeOwn(overrides, key, { ...prevOverride, enabled: nextEnabled });
          nextLayer.gameSystemOverrides = overrides;
        }
        return nextLayer;
      };

      if (this.runtime !== null) {
        const res = this.runtime.updateControlRoom(applyToggleLayer);
        if (!res.ok) {
          this.lastStatusMessage = `Toggle failed: ${formatValidationErrors(res.error)}`;
          return { outputLines: [this.lastStatusMessage], shouldExit: false };
        }
      } else {
        const encodedId = encodeURIComponent(this.requireDaemonSessionId());
        await this.daemonFetch(`/api/sessions/${encodedId}/control-room`, 'PATCH', {
          layer: {
            gameSystemOverrides: (() => {
              const obj: Record<string, { enabled: boolean }> = {};
              setSafeOwn(obj, key, { enabled: nextEnabled });
              return obj;
            })(),
          },
        });
        await this.refreshFromDaemon();
      }

      this.lastStatusMessage = `Toggled module "${key}" -> ${nextEnabled ? 'ON' : 'OFF'}.`;
      return { outputLines: [this.lastStatusMessage], shouldExit: false };
    }

    const capKey = key as keyof SystemCapabilities;
    if (Object.hasOwn(snap.config.capabilities, capKey)) {
      const capPatch: Partial<SystemCapabilities> = {};
      let labelValue: string;

      if (BOOLEAN_CAPABILITY_KEYS.has(capKey)) {
        const currentVal = snap.config.capabilities[capKey] as boolean;
        const nextVal =
          rawExplicitVal !== undefined
            ? rawExplicitVal.trim().toLowerCase() === 'on' ||
              rawExplicitVal.trim().toLowerCase() === 'true'
            : !currentVal;
        setSafeOwn(capPatch as Record<string, unknown>, capKey, nextVal);
        labelValue = nextVal ? 'ON' : 'OFF';
      } else {
        const currentStr = String(snap.config.capabilities[capKey]);
        let nextStr: string;
        if (rawExplicitVal !== undefined && rawExplicitVal.trim().length > 0) {
          nextStr = rawExplicitVal.trim();
        } else if (capKey === 'clocks') {
          nextStr = currentStr === 'disabled' ? 'full_sim' : 'disabled';
        } else if (capKey === 'combatMode') {
          nextStr = currentStr === 'disabled' ? 'tactical_grid' : 'disabled';
        } else if (capKey === 'progression') {
          nextStr = currentStr === 'disabled' ? 'rpg_levels' : 'disabled';
        } else {
          nextStr = currentStr === 'scene_only' ? 'emergent' : 'scene_only';
        }
        setSafeOwn(capPatch as Record<string, unknown>, capKey, nextStr);
        labelValue = nextStr;
      }

      if (this.runtime !== null) {
        const res = this.runtime.updateControlRoom((currentLayer) => {
          const nextLayer = cloneControlRoomLayer(currentLayer);
          nextLayer.capabilities = { ...(nextLayer.capabilities ?? {}), ...capPatch };
          return nextLayer;
        });
        if (!res.ok) {
          this.lastStatusMessage = `Toggle failed: ${formatValidationErrors(res.error)}`;
          return { outputLines: [this.lastStatusMessage], shouldExit: false };
        }
      } else {
        const encodedId = encodeURIComponent(this.requireDaemonSessionId());
        await this.daemonFetch(`/api/sessions/${encodedId}/control-room`, 'PATCH', {
          layer: { capabilities: capPatch },
        });
        await this.refreshFromDaemon();
      }

      this.lastStatusMessage = `Toggled capability "${key}" -> ${labelValue}.`;
      return { outputLines: [this.lastStatusMessage], shouldExit: false };
    }

    this.lastStatusMessage = `Unknown module or capability "${key}".`;
    return { outputLines: [this.lastStatusMessage], shouldExit: false };
  }

  private async handleWizardCommand(rawArg: string): Promise<TuiHandleInputResult> {
    if (rawArg.length === 0) {
      this.lastStatusMessage = 'Usage: /wizard <description of mechanic to track>';
      return { outputLines: [this.lastStatusMessage], shouldExit: false };
    }

    let autoEnable = true;
    let description = rawArg;
    if (rawArg.includes('--no-enable')) {
      autoEnable = false;
      description = rawArg.replace(/--no-enable/g, '').trim();
    }

    if (description.length === 0) {
      this.lastStatusMessage = 'Wizard description cannot be empty.';
      return { outputLines: [this.lastStatusMessage], shouldExit: false };
    }

    let generated: WizardGeneratedSystem;
    let previewSummary: string;

    if (this.wizard !== null) {
      const genRes = await this.wizard.generateSystem({ description });
      if (!genRes.ok) {
        this.lastStatusMessage = `Wizard error: ${formatValidationErrors(genRes.error)}`;
        return { outputLines: [this.lastStatusMessage], shouldExit: false };
      }
      generated = genRes.value;
      previewSummary = this.wizard.renderPreviewSummary(generated);
    } else if (this.daemonUrl !== null) {
      const wizRes = await this.daemonFetch<{
        ok: boolean;
        generated: WizardGeneratedSystem;
        previewSummary: string;
      }>('/api/wizard/generate', 'POST', { description });
      generated = wizRes.generated;
      previewSummary = wizRes.previewSummary;
    } else {
      this.lastStatusMessage = 'Wizard unavailable: no ModelGateway or daemonUrl configured.';
      return { outputLines: [this.lastStatusMessage], shouldExit: false };
    }

    this.lastWizardResult = generated;
    const outputLines = previewSummary.split('\n');

    if (autoEnable) {
      const modToEnable: GameSystemModule = {
        ...cloneGameSystemModule(generated.module),
        enabled: true,
      };
      if (this.runtime !== null) {
        const upRes = this.runtime.updateControlRoom((currentLayer) => {
          const nextLayer = cloneControlRoomLayer(currentLayer);
          const existing = (nextLayer.gameSystems ?? []).filter((m) => m.id !== modToEnable.id);
          nextLayer.gameSystems = [...existing, modToEnable];
          return nextLayer;
        });
        if (!upRes.ok) {
          this.lastStatusMessage = `Generated module "${modToEnable.id}" but failed to enable: ${formatValidationErrors(upRes.error)}`;
          outputLines.push(this.lastStatusMessage);
          return { outputLines, shouldExit: false };
        }
      } else {
        const snap = this.getSnapshot();
        const existingCustom = snap.config.gameSystems.filter((m) => m.id !== modToEnable.id);
        const encodedId = encodeURIComponent(this.requireDaemonSessionId());
        await this.daemonFetch(`/api/sessions/${encodedId}/control-room`, 'PATCH', {
          layer: { gameSystems: [...existingCustom, modToEnable] },
        });
        await this.refreshFromDaemon();
      }
      this.lastStatusMessage = `Wizard generated & enabled module "${modToEnable.id}".`;
      outputLines.push(this.lastStatusMessage);
    } else {
      const msg = `Wizard preview generated for "${generated.module.id}" (not enabled).`;
      outputLines.push(msg);
      return this.showCommandOutput('WIZARD PREVIEW', outputLines, msg);
    }

    return { outputLines, shouldExit: false };
  }

  private async handleSwipeStep(delta: -1 | 1): Promise<TuiHandleInputResult> {
    const snap = this.getSnapshot();
    const node = findActiveAssistantNode(snap.swipeTree);
    if (node === null) {
      this.lastStatusMessage = 'No assistant message available to swipe.';
      return { outputLines: [this.lastStatusMessage], shouldExit: false };
    }

    const nextIndex = node.activeSwipeIndex + delta;
    if (nextIndex < 0 || nextIndex >= node.swipes.length) {
      this.lastStatusMessage = `Cannot swipe ${delta < 0 ? 'left' : 'right'}: at [${node.activeSwipeIndex + 1}/${node.swipes.length}].`;
      return { outputLines: [this.lastStatusMessage], shouldExit: false };
    }

    if (this.runtime !== null) {
      const res = this.runtime.switchSwipe(node.messageId, nextIndex);
      if (!res.ok) {
        this.lastStatusMessage = `Swipe failed: ${formatValidationErrors(res.error)}`;
        return { outputLines: [this.lastStatusMessage], shouldExit: false };
      }
      this.lastStatusMessage = `Switched swipe to [${nextIndex + 1}/${node.swipes.length}].`;
      return {
        outputLines: [this.lastStatusMessage, ...wrapText(res.value.content, 80)],
        shouldExit: false,
      };
    }

    const encodedId = encodeURIComponent(this.requireDaemonSessionId());
    const swipeRes = await this.daemonFetch<{ ok: boolean; content: string }>(
      `/api/sessions/${encodedId}/swipe`,
      'POST',
      {
        action: 'switch',
        assistantMessageId: node.messageId,
        swipeIndex: nextIndex,
      }
    );
    await this.refreshFromDaemon();
    this.lastStatusMessage = `Switched swipe to [${nextIndex + 1}/${node.swipes.length}].`;
    return {
      outputLines: [this.lastStatusMessage, ...wrapText(swipeRes.content, 80)],
      shouldExit: false,
    };
  }

  private async handleRegenerate(): Promise<TuiHandleInputResult> {
    const snap = this.getSnapshot();
    const node = findActiveAssistantNode(snap.swipeTree);
    if (node === null) {
      this.lastStatusMessage = 'No assistant message available to regenerate.';
      return { outputLines: [this.lastStatusMessage], shouldExit: false };
    }

    const steering = this.consumeStagedSteering();

    if (this.runtime !== null) {
      const res = await this.runtime.regenerateTurn(node.messageId, {
        ...(steering !== undefined ? { directorSteering: steering } : {}),
      });
      if (!res.ok) {
        this.lastStatusMessage = `Regenerate failed: ${formatValidationErrors(res.error)}`;
        return { outputLines: [this.lastStatusMessage], shouldExit: false };
      }
      const updatedNode = getSafeOwn(this.runtime.getSwipeTree().nodes, node.messageId);
      const count = updatedNode !== undefined ? updatedNode.swipes.length : res.value.swipeIndex + 1;
      this.lastStatusMessage = `Regenerated swipe [${res.value.swipeIndex + 1}/${count}].`;
      return {
        outputLines: [this.lastStatusMessage, ...wrapText(res.value.narratorText, 80)],
        shouldExit: false,
      };
    }

    const encodedId = encodeURIComponent(this.requireDaemonSessionId());
    const regenRes = await this.daemonFetch<{
      ok: boolean;
      swipeIndex: number;
      narratorText: string;
    }>(`/api/sessions/${encodedId}/swipe`, 'POST', {
      action: 'regenerate',
      assistantMessageId: node.messageId,
      ...(steering !== undefined ? { directorSteering: steering } : {}),
    });
    await this.refreshFromDaemon();
    this.lastStatusMessage = `Regenerated swipe [${regenRes.swipeIndex + 1}].`;
    return {
      outputLines: [this.lastStatusMessage, ...wrapText(regenRes.narratorText, 80)],
      shouldExit: false,
    };
  }

  private async handleConfirmCommand(
    decision: 'accept_all' | 'reject_all'
  ): Promise<TuiHandleInputResult> {
    if (this.runtime !== null) {
      const res = this.runtime.confirmPendingPatches(decision);
      if (!res.ok) {
        this.lastStatusMessage = `Confirmation failed: ${formatValidationErrors(res.error)}`;
        return { outputLines: [this.lastStatusMessage], shouldExit: false };
      }
      this.lastStatusMessage =
        decision === 'accept_all'
          ? `Confirmed ${res.value.appliedCount} pending patch(es).`
          : 'Rejected all pending patches.';
      return { outputLines: [this.lastStatusMessage], shouldExit: false };
    }

    const encodedId = encodeURIComponent(this.requireDaemonSessionId());
    const confRes = await this.daemonFetch<{ ok: boolean; appliedCount: number }>(
      `/api/sessions/${encodedId}/confirm-patch`,
      'POST',
      { decision }
    );
    await this.refreshFromDaemon();
    this.lastStatusMessage =
      decision === 'accept_all'
        ? `Confirmed ${confRes.appliedCount} pending patch(es).`
        : 'Rejected all pending patches.';
    return { outputLines: [this.lastStatusMessage], shouldExit: false };
  }

  private requireDaemonSessionId(): string {
    if (this.sessionId === null) {
      throw new Error('Daemon session is not connected. Call connectDaemonSession() first.');
    }
    return this.sessionId;
  }

  private async daemonFetch<T>(
    endpointPath: string,
    method: 'GET' | 'POST' | 'PATCH' | 'PUT',
    body?: unknown
  ): Promise<T> {
    if (this.daemonUrl === null) {
      throw new Error('daemonUrl is not configured');
    }
    const url = `${this.daemonUrl}${endpointPath}`;
    const response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    const payload = (await response.json()) as {
      ok?: boolean;
      errors?: Array<{ path?: string; code?: string; message?: string }>;
    };
    if (!response.ok || payload.ok === false) {
      const errText = Array.isArray(payload.errors)
        ? payload.errors.map((e) => e.message ?? 'Error').join('; ')
        : `HTTP ${response.status}`;
      throw new Error(`Daemon request failed (${method} ${endpointPath}): ${errText}`);
    }
    return payload as unknown as T;
  }
}
