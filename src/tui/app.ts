import type { BeatLedgerState } from '../beats/beat-ledger.js';
import type { CartridgeBundle } from '../cartridge/cartridge-schema.js';
import type { CombatState } from '../combat/action-validator.js';
import {
  type ControlRoomLayer,
  type ResolvedControlRoomConfig,
  cloneControlRoomLayer,
} from '../config/control-room-config.js';
import { type ControlRoomDiffReport, computeControlRoomDiffReport } from '../config/prompt-diff.js';
import { formatValidationErrors } from '../core/errors.js';
import type { ModelGateway } from '../gateway/model-gateway.js';
import type { AgentRole } from '../gateway/types.js';
import type { DirectorSteeringInput } from '../runtime/director-steering.js';
import type { SessionRuntimeEvent } from '../runtime/event-bus.js';
import type { SessionRuntime } from '../runtime/session-runtime.js';
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
import { GameSystemWizard, type WizardGeneratedSystem } from '../wizard/game-system-wizard.js';
import { renderAuditAndChroniclePane } from './panes/audit-and-chronicle-pane.js';
import { type ChatPaneMessage, renderChatPane } from './panes/chat-pane.js';
import { renderCombatGridPane } from './panes/combat-grid-pane.js';
import { renderControlRoomPane } from './panes/control-room-pane.js';
import { renderDynamicHudPane } from './panes/dynamic-hud-pane.js';
import {
  getSafeOwn,
  isSafeRecordKey,
  setSafeOwn,
  truncateLine,
  wrapText,
} from './panes/layout-helpers.js';

export type TuiViewMode = 'play' | 'control_room' | 'combat' | 'audit' | 'chronicle';

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

const BOOLEAN_CAPABILITY_KEYS = new Set<keyof SystemCapabilities>([
  'factions',
  'beats',
  'relationships',
  'chronicle',
]);

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
    '  /connect <url> <model> [key]       Set default LLM endpoint & model live',
    '  /connect-role <role> <url> <model> Set role-specific LLM endpoint & model',
    '  /connections                       Show configured LLM connections',
    '  /pack <id>            Switch active System Pack live',
    '  /toggle <module|cap>  Toggle a GameSystemModule or capability live',
    '  /wizard <desc>        Run GameSystemWizard and enable generated module',
    '  /nudge <text>         Set one-turn Director OOC nudge',
    '  /hold-clock           Stage Director clock hold for next turn',
    '  /release-clock        Stage Director clock release for next turn',
    '  /advance-slot [n]     Stage advancing narrative clock by n slots',
    '  /swipe-left           Switch active narrator message to previous swipe',
    '  /swipe-right          Switch active narrator message to next swipe',
    '  /regenerate           Regenerate active narrator message as new swipe',
    '  /confirm              Accept all pending tracker confirmations',
    '  /reject               Reject all pending tracker confirmations',
    '  /hud                  Switch to Play + Dynamic HUD view',
    '  /control-room         Switch to Control Room view',
    '  /combat               Switch to Combat Grid view',
    '  /audit [filter]       Switch to Audit Log view (optional filter)',
    '  /chronicle            Switch to Chronicle view',
    '  /help                 Show this command list',
    '  /quit                 Exit the TUI session',
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

  private trackedBasePack: SystemPack;
  private viewMode: TuiViewMode;
  private auditFilter: string | undefined;
  private directorSteering: DirectorSteeringInput = {};
  private lastWizardResult: WizardGeneratedSystem | null = null;
  private lastStatusMessage: string | null = null;
  private streamingBuffer = '';
  private cachedSnapshot: DaemonStateSnapshot | null = null;
  private readonly unsubscribeEventBus: (() => void) | null = null;

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
    this.viewMode = options.initialViewMode ?? 'play';

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
        }
      );
      this.sessionId = res.sessionId;
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

    switch (command) {
      case '/quit':
      case '/exit':
        this.lastStatusMessage = 'Session closed.';
        return { outputLines: ['Goodbye.'], shouldExit: true };

      case '/help':
        return { outputLines: formatHelpLines(), shouldExit: false };

      case '/hud':
        this.viewMode = 'play';
        this.lastStatusMessage = 'Switched view to Play + Dynamic HUD.';
        return { outputLines: [this.lastStatusMessage], shouldExit: false };

      case '/control-room':
        this.viewMode = 'control_room';
        this.lastStatusMessage = 'Switched view to Control Room.';
        return { outputLines: [this.lastStatusMessage], shouldExit: false };

      case '/combat':
        this.viewMode = 'combat';
        this.lastStatusMessage = 'Switched view to Combat Grid.';
        return { outputLines: [this.lastStatusMessage], shouldExit: false };

      case '/audit':
        this.viewMode = 'audit';
        this.auditFilter = arg.length > 0 ? arg : undefined;
        this.lastStatusMessage =
          this.auditFilter !== undefined
            ? `Switched view to Audit Log (filter: "${this.auditFilter}").`
            : 'Switched view to Audit Log.';
        return { outputLines: [this.lastStatusMessage], shouldExit: false };

      case '/chronicle':
        this.viewMode = 'chronicle';
        this.lastStatusMessage = 'Switched view to Chronicle.';
        return { outputLines: [this.lastStatusMessage], shouldExit: false };

      case '/nudge': {
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
        this.directorSteering = { ...this.directorSteering, clockAction: 'hold' };
        this.lastStatusMessage = 'Staged Director clock action: hold.';
        return { outputLines: [this.lastStatusMessage], shouldExit: false };

      case '/release-clock':
        this.directorSteering = { ...this.directorSteering, clockAction: 'release' };
        this.lastStatusMessage = 'Staged Director clock action: release.';
        return { outputLines: [this.lastStatusMessage], shouldExit: false };

      case '/advance-slot': {
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

      default:
        this.lastStatusMessage = `Unknown command "${command}". Type /help for commands.`;
        return { outputLines: [this.lastStatusMessage], shouldExit: false };
    }
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
      return { outputLines: ['No ModelGateway bound.'], shouldExit: false };
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
    return { outputLines: lines, shouldExit: false };
  }

  /**
   * Render the full terminal frame cleanly bounded to `viewport` (default `80x24` Termux safe).
   * Guarantees every line has `line.length <= viewport.width` and total lines `<= viewport.height`.
   */
  renderScreen(viewport: TuiViewport = DEFAULT_VIEWPORT): string {
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
    if (snap.pendingConfirmations.length > 0) {
      steeringBadges.push(`CONFIRM:${snap.pendingConfirmations.length}`);
    }

    const directorStatus =
      steeringBadges.length > 0 ? `[${steeringBadges.join(' | ')}] ` : '';
    const statusOrHint =
      this.lastStatusMessage ??
      '/hud /control-room /combat /audit /chronicle /pack /toggle /wizard /help';
    const footerLine1 = truncateLine(`Director: ${directorStatus}${statusOrHint}`, width);
    const footerLine2 = truncateLine('> Type action or /command', width);

    const reservedLines = 4; // header + divider + 2 footer lines
    const bodyHeight = Math.max(1, height - reservedLines);
    const bodyLines = this.renderBodyPane(snap, diffReport, width, bodyHeight);
    const boundedBody = padOrTrimLines(bodyLines, bodyHeight, width);

    return [headerLine, dividerLine, ...boundedBody, footerLine1, footerLine2].join('\n');
  }

  private renderBodyPane(
    snap: DaemonStateSnapshot,
    diffReport: ControlRoomDiffReport | undefined,
    width: number,
    bodyHeight: number
  ): string[] {
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
      ...remaining
    } = this.directorSteering;
    this.directorSteering = remaining;
    return steering;
  }

  private async handleTurnInput(text: string): Promise<TuiHandleInputResult> {
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
      this.lastStatusMessage = `Wizard preview generated for "${generated.module.id}" (not enabled).`;
      outputLines.push(this.lastStatusMessage);
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
