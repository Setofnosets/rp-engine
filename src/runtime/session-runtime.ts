import { parsePlayerIntent, type ParsedPlayerIntent } from '../agents/intent-parser.js';
import { runAuditorPass } from '../agents/auditor-agent.js';
import { proposeNpcCombatActions } from '../agents/combat-agent.js';
import { runCastDirector } from '../agents/cast-director-agent.js';
import { runChronicleRouter } from '../agents/chronicle-router-agent.js';
import { runDynamicStateTracker } from '../agents/dynamic-state-tracker.js';
import { runStorylinePlanner } from '../agents/storyline-agent.js';
import {
  type ActiveAmbientEntry,
  type LiveNudgeEntry,
  buildBeatDependencyIndex,
  evaluateBeatGraph,
} from '../beats/beat-engine.js';
import {
  type BeatDefinition,
  type BeatLedgerState,
  type BeatRuntimeRecord,
  cloneBeatLedger,
  createInitialBeatLedger,
  createInitialBeatRecord,
} from '../beats/beat-ledger.js';
import type { DependencyIndex } from '../beats/dependency-compiler.js';
import {
  type ChooseEndingBranchResult,
  type EndingDefinition,
  type RouteDefinition,
  chooseEndingBranch,
  evaluateEndings,
  evaluateRoutes,
  filterBeatsForActiveRoutes,
} from '../beats/routes-and-endings.js';
import type { CartridgeBundle } from '../cartridge/cartridge-schema.js';
import { resolveEffectivePackForCartridge } from '../cartridge/loader.js';
import {
  type CombatState,
  type CombatantState,
  type ProposedCombatAction,
  getSafeCombatant,
  getSafeCombatantIds,
  isSafeKey as isSafeCombatKey,
} from '../combat/action-validator.js';
import {
  resolveCombatTurn,
  startCombatEncounter,
} from '../combat/combat-resolver.js';
import type { TerrainTheme } from '../combat/grid-types.js';
import { SkillRegistry } from '../combat/skill-registry.js';
import {
  type ControlRoomLayer,
  type PayloadGroupId,
  type ResolvedControlRoomConfig,
  cloneControlRoomLayer,
  cloneResolvedControlRoomConfig,
  createEmptyControlRoomLayer,
  resolveEffectiveControlRoomConfig,
} from '../config/control-room-config.js';
import {
  applySelectivePayloadGroups,
  createPayloadBundleFromSystemPack,
} from '../config/selective-loader.js';
import {
  type CompiledPromptResult,
  type InjectedScriptPrompt,
  compileNarratorPrompt,
} from '../context/prompt-compiler.js';
import { RefereeError, type ValidationError, validationError } from '../core/errors.js';
import type { RngState } from '../core/prng.js';
import { type Result, err, ok } from '../core/result.js';
import type { ModelGateway } from '../gateway/model-gateway.js';
import type { ChatMessage } from '../gateway/types.js';
import { executeSandboxedScript } from '../sandbox/quickjs-host.js';
import {
  type CadenceContext,
  type CompiledTrackerSchema,
  compileActiveTrackerSchema,
} from '../schema/dynamic-schema-compiler.js';
import { STOCK_FREEFORM_PACK } from '../schema/stock-system-packs.js';
import { parseAndValidateSystemPack } from '../cartridge/system-pack-schema.js';
import {
  type SystemPack,
  cloneSystemCapabilities,
  validateSystemCapabilities,
} from '../schema/tracker-module.js';
import type { AuditEntry } from '../state/audit-log.js';
import {
  type FormDefinition,
  type FormIndex,
  type FormTransitionRule,
  buildFormIndex,
  buildFormRuleDependencyIndex,
} from '../state/forms.js';
import type { PatchBatch, PatchOperation } from '../state/patch.js';
import {
  appendAuditRecords,
  appendEventRecord,
  initSaveDirectory,
  saveCheckpointAtomic,
  saveSwipeTreeAtomic,
} from '../state/persistence.js';
import { applyPatchBatch } from '../state/reducer.js';
import type { EventLogRecord } from '../state/replay.js';
import { validateTravelTarget } from '../state/spatial-topology.js';
import {
  type StateCheckpoint,
  type SwipeTreeState,
  type TranscriptMessageNode,
  activateSwipeVariant,
  appendMessageTurn,
  computeStateHash,
  createSwipeTree,
  editMessageNode,
  getLinearTranscript,
  prepareContinueFromNode,
  recordSwipeVariant,
  rollbackForSwipe,
  validateSwipeTreeState,
} from '../state/swipe-tree.js';
import {
  type CharacterEntity,
  type CreateWorldStateOptions,
  type WorldState,
  bindPlayerToCanonCharacter,
  cloneWorldState,
  createWorldState,
} from '../state/world-state.js';
import { type AgendaConfig, DEFAULT_AGENDA_CONFIG, runAgendaTick } from '../world/agendas.js';
import { computeLocationCast } from '../world/cast-presence.js';
import {
  type DigestFlowConfig,
  type DowntimeActivity,
  type DowntimeExecutionResult,
  type DowntimeOptions,
  type TravelExecutionResult,
  type TravelOptions,
  evaluateDigestFlow,
  executeDowntime,
  executeTravel,
} from '../world/flow-hooks.js';
import { type DirectorSteeringInput, applyDirectorSteering } from './director-steering.js';
import { SessionEventBus } from './event-bus.js';

export interface SessionRuntimeOptions {
  readonly sessionId: string;
  readonly cartridge?: CartridgeBundle | null;
  readonly systemPack?: SystemPack;
  readonly userControlRoomLayer?: ControlRoomLayer;
  readonly gateway: ModelGateway;
  readonly seed?: string | number;
  readonly saveDir?: string | null;
  readonly skillRegistry?: SkillRegistry;
  readonly formRules?: readonly FormTransitionRule[];
  readonly digestConfig?: DigestFlowConfig | false;
  readonly auditorLlmCadenceTurns?: number;
  readonly useBoundaryLlmAgents?: {
    readonly intentParser?: boolean;
    readonly castDirector?: boolean;
    readonly storylinePlanner?: boolean;
    readonly auditor?: boolean;
  };
}

export interface PlayerTurnInput {
  readonly text: string;
  readonly combatActions?: readonly ProposedCombatAction[];
  readonly directorSteering?: DirectorSteeringInput;
  readonly streamNarrator?: boolean;
  readonly signal?: AbortSignal;
}

export interface TurnExecutionResult {
  readonly turn: number;
  readonly userMessageId: string;
  readonly assistantMessageId: string;
  readonly swipeIndex: number;
  readonly narratorText: string;
  readonly state: WorldState;
  readonly beatLedger: BeatLedgerState;
  readonly combatState: CombatState | null;
  readonly compiledPrompt: CompiledPromptResult;
  readonly auditEntries: AuditEntry[];
  readonly pendingConfirmations: PatchOperation[];
  readonly triggeredEnding: EndingDefinition | null;
  readonly trackerSkippedByCadence: boolean;
  readonly warnings: ValidationError[];
}

export interface StartCombatOptions {
  readonly mode?: 'tactical_grid' | 'traditional';
  readonly turnStyle?: 'initiative' | 'phased';
  readonly theme?: TerrainTheme;
  readonly gridSize?: { readonly width: number; readonly height: number };
  readonly xpAwardOnVictory?: number;
}

export interface RegenerateTurnOptions {
  readonly directorSteering?: DirectorSteeringInput;
  readonly streamNarrator?: boolean;
  readonly signal?: AbortSignal;
}

interface TurnMetaSnapshot {
  readonly liveNudges: LiveNudgeEntry[];
  readonly activeAmbient: ActiveAmbientEntry[];
  readonly injectedPrompts: InjectedScriptPrompt[];
  readonly triggeredEnding: EndingDefinition | null;
  readonly clockAdvancedThisTurn: boolean;
  readonly combatEndedThisTurn: boolean;
}

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
const CHECKPOINT_INTERVAL = 25;
const DEFAULT_VICTORY_XP = 100;

function isSafeKey(key: string): boolean {
  return key.length > 0 && !FORBIDDEN_KEYS.has(key);
}

function getOwn<T>(record: Record<string, T>, key: string): T | undefined {
  if (!isSafeKey(key) || !Object.hasOwn(record, key)) {
    return undefined;
  }
  return Object.getOwnPropertyDescriptor(record, key)?.value as T | undefined;
}

function setOwn<T>(record: Record<string, T>, key: string, value: T): void {
  if (!isSafeKey(key)) {
    return;
  }
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

function cloneRngState(rng: RngState): RngState {
  if (rng.type === 'queued') {
    return {
      type: 'queued',
      queue: [...rng.queue],
      cursor: rng.cursor,
      fallback: { ...rng.fallback },
      drawCount: rng.drawCount,
    };
  }
  return { ...rng };
}

function cloneCombatStateSnapshot(state: CombatState): CombatState {
  const combatants: Record<string, CombatantState> = {};
  for (const id of getSafeCombatantIds(state)) {
    const c = getSafeCombatant(state, id);
    if (c !== undefined) {
      const resources: Record<string, number> = {};
      for (const [k, v] of Object.entries(c.resources)) {
        if (isSafeCombatKey(k)) {
          setOwn(resources, k, v);
        }
      }
      const cooldowns: Record<string, number> = {};
      for (const [k, v] of Object.entries(c.cooldowns)) {
        if (isSafeCombatKey(k)) {
          setOwn(cooldowns, k, v);
        }
      }
      const stats: Record<string, number> = {};
      for (const [k, v] of Object.entries(c.stats)) {
        if (isSafeCombatKey(k)) {
          setOwn(stats, k, v);
        }
      }
      setOwn(combatants, id, {
        ...c,
        coord: { x: c.coord.x, y: c.coord.y },
        remainingActions: { ...c.remainingActions },
        resources,
        cooldowns,
        stats,
        statuses: c.statuses.map((s) => ({
          ...s,
          ...(s.statModifiers !== undefined ? { statModifiers: { ...s.statModifiers } } : {}),
        })),
        abilities: [...c.abilities],
        passives: c.passives.map((p) => ({
          ...p,
          ...(p.condition !== undefined ? { condition: { ...p.condition } } : {}),
          effect: { ...p.effect },
        })),
      });
    }
  }

  const triggerCountsThisTurn: Record<string, Record<string, number>> = {};
  for (const actorId of Object.keys(state.triggerCountsThisTurn)) {
    if (!isSafeCombatKey(actorId)) {
      continue;
    }
    const inner = getOwn(state.triggerCountsThisTurn, actorId);
    if (inner !== undefined && isPlainObject(inner)) {
      const innerCopy: Record<string, number> = {};
      for (const [k, v] of Object.entries(inner)) {
        if (isSafeCombatKey(k) && typeof v === 'number') {
          setOwn(innerCopy, k, v);
        }
      }
      setOwn(triggerCountsThisTurn, actorId, innerCopy);
    }
  }

  return {
    active: state.active,
    mode: state.mode,
    ...(state.turnStyle !== undefined ? { turnStyle: state.turnStyle } : {}),
    round: state.round,
    turnIndex: state.turnIndex,
    initiativeOrder: [...state.initiativeOrder],
    grid:
      state.grid === null
        ? null
        : {
            width: state.grid.width,
            height: state.grid.height,
            theme: state.grid.theme,
            tiles: state.grid.tiles.map((t) => ({ ...t })),
          },
    combatants,
    triggerCountsThisTurn,
    ...(state.encounterActionPending !== undefined
      ? { encounterActionPending: state.encounterActionPending }
      : {}),
  };
}

function serializeBeatLedger(ledger: BeatLedgerState): Record<string, unknown> {
  const cloned = cloneBeatLedger(ledger);
  const recordsObj: Record<string, unknown> = {};
  for (const id of Object.keys(cloned.records)) {
    const rec = getOwn(cloned.records, id);
    if (rec !== undefined) {
      setOwn(recordsObj, id, rec);
    }
  }
  const out: Record<string, unknown> = {};
  setOwn(out, 'records', recordsObj);
  setOwn(out, 'liveGateId', cloned.liveGateId);
  setOwn(out, 'liveNudgeIds', [...cloned.liveNudgeIds]);
  setOwn(out, 'activeAmbientIds', [...cloned.activeAmbientIds]);
  return out;
}

function deserializeBeatLedger(
  raw: Record<string, unknown>,
  beats: readonly BeatDefinition[]
): BeatLedgerState {
  const fallback = createInitialBeatLedger(beats);
  const rawRecords = Object.hasOwn(raw, 'records')
    ? Object.getOwnPropertyDescriptor(raw, 'records')?.value
    : undefined;
  const records: Record<string, BeatRuntimeRecord> = {};

  if (isPlainObject(rawRecords)) {
    for (const id of Object.keys(rawRecords)) {
      if (!isSafeKey(id)) {
        continue;
      }
      const val = Object.getOwnPropertyDescriptor(rawRecords, id)?.value;
      if (isPlainObject(val) && typeof val['status'] === 'string') {
        const template = createInitialBeatRecord(id);
        const rec: BeatRuntimeRecord = {
          id,
          status: val['status'] as BeatRuntimeRecord['status'],
          boundRoles: isPlainObject(val['boundRoles'])
            ? (val['boundRoles'] as BeatRuntimeRecord['boundRoles'])
            : template.boundRoles,
          adapted: typeof val['adapted'] === 'boolean' ? val['adapted'] : template.adapted,
          deadlineFired:
            typeof val['deadlineFired'] === 'boolean' ? val['deadlineFired'] : template.deadlineFired,
          entryEffectsFired:
            typeof val['entryEffectsFired'] === 'boolean'
              ? val['entryEffectsFired']
              : template.entryEffectsFired,
          lastTransitionTurn:
            typeof val['lastTransitionTurn'] === 'number' && Number.isInteger(val['lastTransitionTurn'])
              ? val['lastTransitionTurn']
              : template.lastTransitionTurn,
        };
        setOwn(records, id, rec);
      }
    }
  }

  for (const id of Object.keys(fallback.records)) {
    if (!Object.hasOwn(records, id)) {
      const defRec = getOwn(fallback.records, id);
      if (defRec !== undefined) {
        setOwn(records, id, defRec);
      }
    }
  }

  const rawLiveGate = Object.hasOwn(raw, 'liveGateId')
    ? Object.getOwnPropertyDescriptor(raw, 'liveGateId')?.value
    : null;
  const rawLiveNudges = Object.hasOwn(raw, 'liveNudgeIds')
    ? Object.getOwnPropertyDescriptor(raw, 'liveNudgeIds')?.value
    : [];
  const rawActiveAmbient = Object.hasOwn(raw, 'activeAmbientIds')
    ? Object.getOwnPropertyDescriptor(raw, 'activeAmbientIds')?.value
    : [];

  return cloneBeatLedger({
    records,
    liveGateId: typeof rawLiveGate === 'string' ? rawLiveGate : null,
    liveNudgeIds: Array.isArray(rawLiveNudges)
      ? rawLiveNudges.filter((x): x is string => typeof x === 'string')
      : [],
    activeAmbientIds: Array.isArray(rawActiveAmbient)
      ? rawActiveAmbient.filter((x): x is string => typeof x === 'string')
      : [],
  });
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

function computeSlotsToMorning(state: WorldState): number {
  const slotsPerDay = state.clocks.slotsPerDay;
  if (slotsPerDay.length === 0) {
    return 1;
  }
  const morningIdxRaw = slotsPerDay.indexOf('morning');
  const morningIdx = morningIdxRaw >= 0 ? morningIdxRaw : 0;
  const currIdxRaw = slotsPerDay.indexOf(state.clocks.slot);
  const currIdx = currIdxRaw >= 0 ? currIdxRaw : 0;
  const len = slotsPerDay.length;
  const diff = (morningIdx - currIdx + len) % len;
  return diff === 0 ? len : diff;
}

function cloneOperation(op: PatchOperation): PatchOperation {
  return JSON.parse(JSON.stringify(op)) as PatchOperation;
}

function resolveTranscriptEndingAt(
  tree: SwipeTreeState,
  leafMessageId: string | null,
  limit: number
): ChatMessage[] {
  if (leafMessageId === null || limit <= 0) {
    return [];
  }
  const subTree: SwipeTreeState = {
    nodes: tree.nodes,
    activeLeafMessageId: leafMessageId,
    checkpoints: tree.checkpoints,
  };
  return getLinearTranscript(subTree, limit).map((entry) => ({
    role: entry.role as ChatMessage['role'],
    content: entry.content,
  }));
}

function buildInitialWorldStateOptions(
  options: SessionRuntimeOptions,
  config: ResolvedControlRoomConfig
): CreateWorldStateOptions {
  const init = options.cartridge?.initialState;
  const initEnt = options.cartridge?.initialEntities;

  const mergeCollection = <T>(
    a: Record<string, T> | undefined,
    b: Record<string, T> | undefined
  ): Record<string, T> | undefined => {
    if (a === undefined && b === undefined) {
      return undefined;
    }
    const merged: Record<string, T> = {};
    if (a !== undefined) {
      for (const [k, v] of Object.entries(a)) {
        if (isSafeKey(k)) {
          setOwn(merged, k, v);
        }
      }
    }
    if (b !== undefined) {
      for (const [k, v] of Object.entries(b)) {
        if (isSafeKey(k)) {
          setOwn(merged, k, v);
        }
      }
    }
    return merged;
  };

  const turn = init?.meta?.turn ?? init?.clocks?.turn ?? 0;

  return {
    sessionId: options.sessionId,
    capabilities: config.capabilities,
    rngSeed: options.seed ?? options.sessionId,
    turn,
    ...(init?.meta?.rngState !== undefined ? { rngState: init.meta.rngState } : {}),
    ...(init?.meta?.arc !== undefined ? { arc: init.meta.arc } : {}),
    ...(init?.meta?.endingStatus !== undefined ? { endingStatus: init.meta.endingStatus } : {}),
    ...(init?.meta?.activeEndingId !== undefined ? { activeEndingId: init.meta.activeEndingId } : {}),
    ...(init?.player !== undefined ? { player: init.player } : {}),
    ...(init?.scene !== undefined ? { scene: init.scene } : {}),
    ...(init?.flags !== undefined ? { flags: init.flags } : {}),
    ...(init?.counters !== undefined ? { counters: init.counters } : {}),
    ...(init?.customFields !== undefined ? { customFields: init.customFields } : {}),
    ...(init?.clocks !== undefined ? { clocks: init.clocks } : {}),
    ...(init?.relations !== undefined ? { relations: init.relations } : {}),
    ...(mergeCollection(init?.entities?.characters, initEnt?.characters) !== undefined
      ? { characters: mergeCollection(init?.entities?.characters, initEnt?.characters) }
      : {}),
    ...(mergeCollection(init?.entities?.factions, initEnt?.factions) !== undefined
      ? { factions: mergeCollection(init?.entities?.factions, initEnt?.factions) }
      : {}),
    ...(mergeCollection(init?.entities?.threats, initEnt?.threats) !== undefined
      ? { threats: mergeCollection(init?.entities?.threats, initEnt?.threats) }
      : {}),
    ...(mergeCollection(init?.entities?.locations, initEnt?.locations) !== undefined
      ? { locations: mergeCollection(init?.entities?.locations, initEnt?.locations) }
      : {}),
    ...(init?.chronicle?.events !== undefined ? { chronicleEvents: init.chronicle.events } : {}),
    ...(init?.turnEvents !== undefined ? { turnEvents: init.turnEvents } : {}),
  };
}

/**
 * Unified Referee Session Turn Runtime orchestrating the 9-step deterministic turn loop,
 * swipe rollback, Director Steering Bar, combat loop, boundary agents, and persistence.
 */
export class SessionRuntime {
  public readonly sessionId: string;
  public readonly eventBus: SessionEventBus;

  private readonly cartridge: CartridgeBundle | null;
  private readonly gateway: ModelGateway;
  private readonly saveDir: string | null;
  private readonly skillRegistry: SkillRegistry;
  private readonly useBoundaryLlmAgents: {
    readonly intentParser: boolean;
    readonly castDirector: boolean;
    readonly storylinePlanner: boolean;
    readonly auditor: boolean;
  };
  private readonly digestConfig: DigestFlowConfig | false;
  private readonly auditorLlmCadenceTurns: number;

  private basePack: SystemPack;
  private userLayer: ControlRoomLayer;
  private config: ResolvedControlRoomConfig;
  private fullCompiledSchema: CompiledTrackerSchema;

  private readonly beats: readonly BeatDefinition[];
  private readonly routes: readonly RouteDefinition[];
  private readonly endings: readonly EndingDefinition[];
  private readonly dependencyIndex: DependencyIndex;
  private readonly agendaConfig: AgendaConfig;
  private readonly formDefinitions: readonly FormDefinition[];
  private readonly formIndex: FormIndex | undefined;
  private readonly formRules: readonly FormTransitionRule[];
  private readonly formRuleDependencyIndex: DependencyIndex | undefined;

  private state: WorldState;
  private beatLedger: BeatLedgerState;
  private swipeTree: SwipeTreeState;
  private combatState: CombatState | null = null;
  private pendingConfirmations: PatchOperation[] = [];
  private readonly auditLog: AuditEntry[] = [];

  private readonly initialCheckpoint: StateCheckpoint;
  private readonly initialSwipeTree: SwipeTreeState;
  private saveInitialized = false;

  private auditSeq = 1;
  private msgSeq = 0;
  private checkpointSeq = 0;
  private xpAwardOnVictory = DEFAULT_VICTORY_XP;

  private readonly turnMetaByUserMessageId = new Map<string, TurnMetaSnapshot>();

  constructor(options: SessionRuntimeOptions) {
    if (typeof options.sessionId !== 'string' || options.sessionId.trim().length === 0) {
      throw new RefereeError('sessionId must be a non-empty string', {
        code: 'INVALID_SESSION_ID',
      });
    }

    this.sessionId = options.sessionId;
    this.cartridge = options.cartridge ?? null;
    this.gateway = options.gateway;
    this.saveDir = options.saveDir ?? null;
    this.eventBus = new SessionEventBus();
    this.useBoundaryLlmAgents = {
      intentParser: options.useBoundaryLlmAgents?.intentParser === true,
      castDirector: options.useBoundaryLlmAgents?.castDirector === true,
      storylinePlanner: options.useBoundaryLlmAgents?.storylinePlanner === true,
      auditor: options.useBoundaryLlmAgents?.auditor === true,
    };
    this.digestConfig = options.digestConfig ?? {};
    this.auditorLlmCadenceTurns =
      options.auditorLlmCadenceTurns !== undefined &&
      Number.isInteger(options.auditorLlmCadenceTurns) &&
      options.auditorLlmCadenceTurns >= 1
        ? options.auditorLlmCadenceTurns
        : 5;

    if (this.cartridge !== null) {
      const packRes = resolveEffectivePackForCartridge(this.cartridge, options.systemPack);
      if (!packRes.ok) {
        throw new RefereeError('Failed to resolve SystemPack for cartridge', {
          code: 'INVALID_SYSTEM_PACK',
          details: packRes.error,
        });
      }
      this.basePack = packRes.value;
    } else if (options.systemPack !== undefined) {
      const packRes = parseAndValidateSystemPack(options.systemPack);
      if (!packRes.ok) {
        throw new RefereeError('Invalid SystemPack provided to SessionRuntime', {
          code: 'INVALID_SYSTEM_PACK',
          details: packRes.error,
        });
      }
      this.basePack = packRes.value;
    } else {
      this.basePack = STOCK_FREEFORM_PACK;
    }

    this.userLayer = options.userControlRoomLayer
      ? cloneControlRoomLayer(options.userControlRoomLayer)
      : createEmptyControlRoomLayer();

    this.config = resolveEffectiveControlRoomConfig(
      this.basePack,
      this.cartridge?.systemOverrides,
      this.userLayer
    );
    this.fullCompiledSchema = compileActiveTrackerSchema(this.config, {
      turn: 0,
      clockAdvancedThisTurn: true,
      combatEndedThisTurn: true,
      manualTrigger: true,
    });

    if (options.skillRegistry !== undefined) {
      this.skillRegistry = options.skillRegistry;
    } else {
      const registry = SkillRegistry.createDefaultSkillCatalog();
      if (this.cartridge?.combat?.skills !== undefined) {
        for (const skill of this.cartridge.combat.skills) {
          if (registry.get(skill.id) === undefined) {
            const regRes = registry.register(skill);
            if (!regRes.ok) {
              throw new RefereeError(`Invalid cartridge skill "${skill.id}"`, {
                code: 'INVALID_SKILL_DEFINITION',
                details: regRes.error,
              });
            }
          }
        }
      }
      this.skillRegistry = registry;
    }

    this.beats = this.cartridge?.beats ?? [];
    this.routes = this.cartridge?.routes ?? [];
    this.endings = this.cartridge?.endings ?? [];
    this.dependencyIndex = buildBeatDependencyIndex(this.beats);
    this.agendaConfig = this.cartridge?.agendas ?? DEFAULT_AGENDA_CONFIG;
    this.formDefinitions = this.cartridge?.initialEntities?.forms ?? [];
    this.formIndex =
      this.formDefinitions.length > 0 ? buildFormIndex(this.formDefinitions) : undefined;
    this.formRules = options.formRules ? [...options.formRules] : [];
    this.formRuleDependencyIndex =
      this.formRules.length > 0 ? buildFormRuleDependencyIndex(this.formRules) : undefined;

    const initialWorld = createWorldState(buildInitialWorldStateOptions(options, this.config));
    if (this.cartridge?.initialState?.scene?.presentCharacterIds === undefined) {
      const cast = computeLocationCast(initialWorld, this.formDefinitions);
      initialWorld.scene.presentCharacterIds = cast.presentCharacterIds;
    }

    this.state = initialWorld;
    this.beatLedger = createInitialBeatLedger(this.beats);

    const serializedLedger = serializeBeatLedger(this.beatLedger);
    const cp0: StateCheckpoint = {
      checkpointId: 'cp-turn-0',
      turn: this.state.meta.turn,
      worldState: cloneWorldState(this.state),
      beatLedger: serializedLedger,
      rngState: cloneRngState(this.state.meta.rngState),
      stateHash: computeStateHash(this.state, serializedLedger),
    };
    this.initialCheckpoint = cp0;
    this.swipeTree = createSwipeTree(cp0);
    this.initialSwipeTree = createSwipeTree(cp0);
  }

  getState(): WorldState {
    return cloneWorldState(this.state);
  }

  getBeatLedger(): BeatLedgerState {
    return cloneBeatLedger(this.beatLedger);
  }

  getCombatState(): CombatState | null {
    return this.combatState ? cloneCombatStateSnapshot(this.combatState) : null;
  }

  getSwipeTree(): SwipeTreeState {
    const cloned = validateSwipeTreeState(this.swipeTree);
    return cloned.ok ? cloned.value : this.swipeTree;
  }

  getConfig(): ResolvedControlRoomConfig {
    return cloneResolvedControlRoomConfig(this.config);
  }

  getPendingConfirmations(): readonly PatchOperation[] {
    return this.pendingConfirmations.map(cloneOperation);
  }

  getAuditLog(): readonly AuditEntry[] {
    return [...this.auditLog];
  }

  getSaveDir(): string | null {
    return this.saveDir;
  }

  getSkillRegistry(): SkillRegistry {
    return this.skillRegistry;
  }

  /**
   * Restore internal runtime snapshots (used when hydrating a cloned or loaded session).
   */
  restoreSnapshot(snapshot: {
    readonly state: WorldState;
    readonly beatLedger?: Record<string, unknown> | BeatLedgerState;
    readonly swipeTree?: SwipeTreeState | null;
    readonly combatState?: CombatState | null;
  }): void {
    this.state = cloneWorldState(snapshot.state);
    if (snapshot.beatLedger !== undefined) {
      this.beatLedger = deserializeBeatLedger(snapshot.beatLedger as Record<string, unknown>, this.beats);
    }
    if (snapshot.swipeTree !== undefined && snapshot.swipeTree !== null) {
      const validated = validateSwipeTreeState(snapshot.swipeTree);
      if (validated.ok) {
        this.swipeTree = validated.value;
      }
    }
    if (snapshot.combatState !== undefined) {
      this.combatState = snapshot.combatState ? cloneCombatStateSnapshot(snapshot.combatState) : null;
    }
  }

  /**
   * Attach or update a character entity in the active session's world state and
   * add it to `scene.presentCharacterIds` if located in the current scene.
   */
  attachCharacterEntity(character: CharacterEntity): Result<WorldState, ValidationError[]> {
    if (!isSafeKey(character.id)) {
      return err([
        validationError('character.id', 'UNSAFE_KEY', `Unsafe character id "${character.id}"`),
      ]);
    }
    const nextState = cloneWorldState(this.state);
    setOwn(nextState.entities.characters, character.id, character);
    if (
      (character.locationId === null || character.locationId === nextState.scene.locationId) &&
      !nextState.scene.presentCharacterIds.includes(character.id)
    ) {
      nextState.scene.presentCharacterIds.push(character.id);
    }
    this.state = nextState;
    return ok(cloneWorldState(this.state));
  }

  /**
   * Bind the player to a canon character or custom persona overlay.
   */
  updatePlayerBinding(options: {
    readonly canonCharacterId?: string;
    readonly name?: string;
    readonly avatarAssetPath?: string | null;
    readonly sections?: Record<string, string>;
  }): Result<WorldState, ValidationError[]> {
    let nextState = cloneWorldState(this.state);
    if (options.canonCharacterId !== undefined) {
      try {
        nextState = bindPlayerToCanonCharacter(nextState, options.canonCharacterId, this.formIndex);
      } catch (caught) {
        const msg = caught instanceof Error ? caught.message : String(caught);
        return err([validationError('canonCharacterId', 'BIND_FAILED', msg)]);
      }
    }
    if (options.name !== undefined && options.name.trim().length > 0) {
      nextState.player.name = options.name.trim();
    }
    if (options.avatarAssetPath !== undefined) {
      nextState.player.portraitAsset = options.avatarAssetPath;
    }
    if (options.sections !== undefined) {
      for (const [k, v] of Object.entries(options.sections)) {
        if (isSafeKey(k) && typeof v === 'string') {
          setOwn(nextState.player.sections, k, v);
        }
      }
    }
    this.state = nextState;
    return ok(cloneWorldState(this.state));
  }

  /**
   * Initialize a tactical or traditional combat encounter and hold narrative fiction time.
   */
  startCombat(
    participants: readonly CombatantState[],
    options: StartCombatOptions = {}
  ): Result<{ combatState: CombatState; state: WorldState; auditEntries: AuditEntry[] }, ValidationError[]> {
    if (this.state.capabilities.combatMode === 'disabled') {
      return err([
        validationError(
          'capabilities.combatMode',
          'COMBAT_DISABLED',
          'Cannot start combat when capabilities.combatMode is disabled'
        ),
      ]);
    }
    if (this.combatState?.active) {
      return err([
        validationError('combatState', 'COMBAT_ALREADY_ACTIVE', 'A combat encounter is already active'),
      ]);
    }

    const mode =
      options.mode ??
      (this.state.capabilities.combatMode === 'tactical_grid' ? 'tactical_grid' : 'traditional');

    let startRes: ReturnType<typeof startCombatEncounter>;
    try {
      startRes = startCombatEncounter({
        worldState: this.state,
        participants,
        mode,
        ...(options.theme !== undefined ? { theme: options.theme } : {}),
        ...(options.gridSize !== undefined ? { gridSize: options.gridSize } : {}),
        rng: this.state.meta.rngState,
      });
    } catch (caught) {
      if (caught instanceof RefereeError) {
        return err([validationError('combat', caught.code, caught.message)]);
      }
      throw caught;
    }

    if (mode === 'traditional' && options.turnStyle !== undefined) {
      startRes.combatState.turnStyle = options.turnStyle;
    }

    const batchRes = applyPatchBatch(
      this.state,
      {
        eventId: `combat:start:t${this.state.meta.turn}:s${this.auditSeq}`,
        source: 'combat',
        operations: startRes.worldPatches,
        reason: 'Start combat encounter',
      },
      {
        compiledSchema: this.fullCompiledSchema,
        formIndex: this.formIndex,
        auditSeqStart: this.auditSeq,
      }
    );
    if (!batchRes.ok) {
      return err(batchRes.error);
    }

    this.state = batchRes.value.nextState;
    this.state.meta.rngState = cloneRngState(startRes.nextRng);
    this.combatState = startRes.combatState;
    this.xpAwardOnVictory = options.xpAwardOnVictory ?? DEFAULT_VICTORY_XP;
    this.auditSeq += batchRes.value.auditEntries.length;
    this.auditLog.push(...batchRes.value.auditEntries);

    return ok({
      combatState: cloneCombatStateSnapshot(this.combatState),
      state: cloneWorldState(this.state),
      auditEntries: batchRes.value.auditEntries,
    });
  }

  /**
   * Execute a deterministic living-world travel transition to `targetLocationId`.
   */
  travel(
    targetLocationId: string,
    options: TravelOptions = {}
  ): Result<
    TravelExecutionResult & { readonly state: WorldState; readonly auditEntries: AuditEntry[] },
    ValidationError[]
  > {
    if (this.combatState?.active) {
      return err([
        validationError('combatState', 'COMBAT_ACTIVE', 'Cannot travel while combat is active'),
      ]);
    }

    const travelRes = executeTravel(this.state, targetLocationId, options);
    if (!travelRes.ok) {
      return err(travelRes.error);
    }

    const batchRes = applyPatchBatch(
      this.state,
      {
        eventId: `travel:t${this.state.meta.turn}:s${this.auditSeq}`,
        source: 'engine',
        operations: travelRes.value.patches,
        reason: `Travel to ${travelRes.value.arrivalSummary.targetLocationName}`,
      },
      {
        compiledSchema: this.fullCompiledSchema,
        formIndex: this.formIndex,
        formRules: this.formRules,
        auditSeqStart: this.auditSeq,
      }
    );
    if (!batchRes.ok) {
      return err(batchRes.error);
    }

    let nextState = batchRes.value.nextState;
    nextState.meta.rngState = cloneRngState(travelRes.value.nextRng);
    const totalAuditEntries = [...batchRes.value.auditEntries];
    let nextAuditSeq = this.auditSeq + batchRes.value.auditEntries.length;

    const cast = computeLocationCast(nextState, this.formDefinitions);
    if (!arraysEqual(cast.presentCharacterIds, nextState.scene.presentCharacterIds)) {
      const castBatchRes = applyPatchBatch(
        nextState,
        {
          eventId: `travel:t${this.state.meta.turn}:cast_sync:s${nextAuditSeq}`,
          source: 'engine',
          operations: [
            {
              op: 'set',
              path: 'scene.presentCharacterIds',
              value: cast.presentCharacterIds,
            },
          ],
          reason: 'Sync scene.presentCharacterIds after travel',
        },
        {
          compiledSchema: this.fullCompiledSchema,
          formIndex: this.formIndex,
          auditSeqStart: nextAuditSeq,
        }
      );
      if (castBatchRes.ok) {
        nextState = castBatchRes.value.nextState;
        totalAuditEntries.push(...castBatchRes.value.auditEntries);
        nextAuditSeq += castBatchRes.value.auditEntries.length;
      }
    }

    this.state = nextState;
    this.auditSeq = nextAuditSeq;
    this.auditLog.push(...totalAuditEntries);

    return ok({
      ...travelRes.value,
      state: cloneWorldState(this.state),
      auditEntries: totalAuditEntries,
    });
  }

  /**
   * Execute a deterministic safehouse/hub downtime activity (`recover`, `train`, `research`,
   * `patrol`, or `socialize`).
   */
  downtime(
    activity: DowntimeActivity,
    options: DowntimeOptions = {}
  ): Result<
    DowntimeExecutionResult & { readonly state: WorldState; readonly auditEntries: AuditEntry[] },
    ValidationError[]
  > {
    if (this.combatState?.active) {
      return err([
        validationError('combatState', 'COMBAT_ACTIVE', 'Cannot perform downtime while combat is active'),
      ]);
    }

    const downtimeRes = executeDowntime(this.state, activity, options);
    if (!downtimeRes.ok) {
      return err(downtimeRes.error);
    }

    const batchRes = applyPatchBatch(
      this.state,
      {
        eventId: `downtime:${activity}:t${this.state.meta.turn}:s${this.auditSeq}`,
        source: 'engine',
        operations: downtimeRes.value.patches,
        reason: `Downtime activity: ${activity}`,
      },
      {
        compiledSchema: this.fullCompiledSchema,
        formIndex: this.formIndex,
        formRules: this.formRules,
        auditSeqStart: this.auditSeq,
      }
    );
    if (!batchRes.ok) {
      return err(batchRes.error);
    }

    this.state = batchRes.value.nextState;
    this.auditSeq += batchRes.value.auditEntries.length;
    this.auditLog.push(...batchRes.value.auditEntries);

    return ok({
      ...downtimeRes.value,
      state: cloneWorldState(this.state),
      auditEntries: batchRes.value.auditEntries,
    });
  }

  /**
   * Execute a full 9-step Referee turn: steering, intent parsing, deterministic action & combat,
   * clock & agendas, beats/routes/scripts/endings, prompt compilation, narration, post-turn agents,
   * swipe tree checkpointing, and optional disk persistence.
   */
  async executeTurn(
    input: PlayerTurnInput
  ): Promise<Result<TurnExecutionResult, ValidationError[]>> {
    if (typeof input?.text !== 'string') {
      return err([validationError('input.text', 'INVALID_TYPE', 'PlayerTurnInput.text must be a string')]);
    }

    let workingState = cloneWorldState(this.state);
    let workingLedger = cloneBeatLedger(this.beatLedger);
    let workingCombatState = this.combatState ? cloneCombatStateSnapshot(this.combatState) : null;
    let workingAuditSeq = this.auditSeq;

    const turnAuditEntries: AuditEntry[] = [];
    const turnChangedPaths = new Set<string>();
    const turnWarnings: ValidationError[] = [];
    const turnEventRecords: EventLogRecord[] = [];
    const turnInjectedPrompts: InjectedScriptPrompt[] = [];
    const turnPendingConfirmations: PatchOperation[] = [];
    let totalDaysElapsed = 0;
    let totalSlotsElapsed = 0;
    let combatEndedThisTurn = false;
    let storySlotsToAdvance = 0;
    let triggeredEnding: EndingDefinition | null = null;
    let latestLiveNudges: LiveNudgeEntry[] = [];
    let latestActiveAmbient: ActiveAmbientEntry[] = [];

    const nextTurnNumber = workingState.meta.turn + 1;

    const commitWorkingBatch = (
      batch: PatchBatch,
      compiledSchema?: CompiledTrackerSchema
    ): Result<
      {
        nextState: WorldState;
        changedPaths: Set<string>;
        appliedCount: number;
        daysElapsed: number;
        slotsElapsed: number;
        expiredTimers: string[];
      },
      ValidationError[]
    > => {
      const rngBefore = cloneRngState(workingState.meta.rngState);
      const res = applyPatchBatch(workingState, batch, {
        compiledSchema: compiledSchema ?? this.fullCompiledSchema,
        formIndex: this.formIndex,
        auditSeqStart: workingAuditSeq,
      });
      if (!res.ok) {
        return err(res.error);
      }

      workingState = res.value.nextState;
      workingAuditSeq += res.value.auditEntries.length;
      turnAuditEntries.push(...res.value.auditEntries);
      for (const p of res.value.changedPaths) {
        turnChangedPaths.add(p);
      }
      totalDaysElapsed += res.value.daysElapsed;
      totalSlotsElapsed += res.value.slotsElapsed;

      if (res.value.pendingConfirmations.length > 0) {
        turnPendingConfirmations.push(...res.value.pendingConfirmations);
      }

      turnEventRecords.push({
        turn: workingState.meta.turn,
        batch,
        postStateHash: computeStateHash(workingState, serializeBeatLedger(workingLedger)),
        rngBefore,
        rngAfter: cloneRngState(workingState.meta.rngState),
      });

      const appliedCount = res.value.auditEntries.filter((e) => e.status === 'committed').length;
      return ok({
        nextState: workingState,
        changedPaths: res.value.changedPaths,
        appliedCount,
        daysElapsed: res.value.daysElapsed,
        slotsElapsed: res.value.slotsElapsed,
        expiredTimers: res.value.expiredTimers,
      });
    };

    const runScriptEffects = async (scriptIds: readonly string[]): Promise<void> => {
      for (const scriptId of scriptIds) {
        const manifest = this.cartridge?.card.scripts?.find((s) => s.scriptId === scriptId);
        const code = this.resolveScriptCode(scriptId);
        if (manifest === undefined || code === undefined) {
          turnWarnings.push(
            validationError(
              `scripts.${scriptId}`,
              'MISSING_SCRIPT',
              `Triggered script "${scriptId}" missing manifest or source in cartridge`
            )
          );
          continue;
        }

        const scriptRes = await executeSandboxedScript({
          code,
          manifest,
          stateSnapshot: workingState,
          rngState: workingState.meta.rngState,
          eventPayload: { turn: workingState.meta.turn, scriptId },
        });
        if (!scriptRes.ok) {
          turnWarnings.push(...scriptRes.error);
          continue;
        }

        workingState.meta.rngState = cloneRngState(scriptRes.value.nextRng);
        if (scriptRes.value.operations.length > 0) {
          const applyRes = commitWorkingBatch({
            eventId: `script:${scriptId}:t${workingState.meta.turn}:s${workingAuditSeq}`,
            source: 'script',
            operations: scriptRes.value.operations,
            reason: `Sandboxed script "${scriptId}"`,
          });
          if (!applyRes.ok) {
            turnWarnings.push(...applyRes.error);
          }
        }
        for (const injected of scriptRes.value.injectedPrompts) {
          turnInjectedPrompts.push({ section: injected.section, text: injected.text });
        }
      }
    };

    const evaluateNarrativeGraph = async (
      recentTranscriptLines: readonly string[],
      changedPathsForEval?: ReadonlySet<string>
    ): Promise<void> => {
      if (!workingState.capabilities.beats) {
        return;
      }

      const routeRes = evaluateRoutes({
        state: workingState,
        ledger: workingLedger,
        routes: this.routes,
        recentTranscriptLines,
        reducerOptions: {
          compiledSchema: this.fullCompiledSchema,
          formIndex: this.formIndex,
          auditSeqStart: workingAuditSeq,
        },
      });
      workingState = routeRes.nextState;
      turnAuditEntries.push(...routeRes.auditEntries);
      workingAuditSeq += routeRes.auditEntries.length;
      for (const p of routeRes.changedPaths) {
        turnChangedPaths.add(p);
      }
      turnWarnings.push(...routeRes.warnings);

      for (const route of routeRes.newlyLockedRoutes) {
        this.eventBus.emit({
          type: 'route_locked',
          turn: workingState.meta.turn,
          routeId: route.id,
          lockFlag: route.lock,
          ...(route.announce !== undefined ? { announce: route.announce } : {}),
        });
      }

      const activeBeats = filterBeatsForActiveRoutes(this.beats, workingState, this.routes, {
        requireRouteLocked: true,
      });

      const useFullEval =
        workingState.meta.turn <= 1 ||
        routeRes.newlyLockedRoutes.length > 0 ||
        changedPathsForEval === undefined;

      const beatRes = evaluateBeatGraph({
        state: workingState,
        ledger: workingLedger,
        beats: activeBeats,
        ...(useFullEval
          ? {}
          : {
              dependencyIndex: this.dependencyIndex,
              changedPaths: changedPathsForEval,
            }),
        ...(this.formRules.length > 0 && this.formIndex !== undefined
          ? {
              formRules: this.formRules,
              formIndex: this.formIndex,
              ...(useFullEval || this.formRuleDependencyIndex === undefined
                ? {}
                : { formRuleDependencyIndex: this.formRuleDependencyIndex }),
            }
          : {}),
        recentTranscriptLines,
        beatPressure: this.config.tuningDials.beatPressure,
        reducerOptions: {
          compiledSchema: this.fullCompiledSchema,
          formIndex: this.formIndex,
          ...(this.formRules.length > 0 ? { formRules: this.formRules } : {}),
          auditSeqStart: workingAuditSeq,
        },
      });

      workingState = beatRes.nextState;
      workingLedger = beatRes.nextLedger;
      turnAuditEntries.push(...beatRes.auditEntries);
      workingAuditSeq += beatRes.auditEntries.length;
      for (const p of beatRes.changedPaths) {
        turnChangedPaths.add(p);
      }
      turnWarnings.push(...beatRes.warnings);
      latestLiveNudges = beatRes.liveNudges;
      latestActiveAmbient = beatRes.activeAmbient;

      this.eventBus.emit({
        type: 'beats_evaluated',
        turn: workingState.meta.turn,
        transitionCount: beatRes.transitions.length,
        triggeredScripts: beatRes.triggeredScripts,
      });

      if (beatRes.triggeredScripts.length > 0) {
        await runScriptEffects(beatRes.triggeredScripts);
      }

      if (beatRes.changedPaths.size > 0 || beatRes.triggeredScripts.length > 0) {
        const postBeatRouteRes = evaluateRoutes({
          state: workingState,
          ledger: workingLedger,
          routes: this.routes,
          recentTranscriptLines,
          reducerOptions: {
            compiledSchema: this.fullCompiledSchema,
            formIndex: this.formIndex,
            auditSeqStart: workingAuditSeq,
          },
        });
        workingState = postBeatRouteRes.nextState;
        turnAuditEntries.push(...postBeatRouteRes.auditEntries);
        workingAuditSeq += postBeatRouteRes.auditEntries.length;
        for (const p of postBeatRouteRes.changedPaths) {
          turnChangedPaths.add(p);
        }
        turnWarnings.push(...postBeatRouteRes.warnings);

        for (const route of postBeatRouteRes.newlyLockedRoutes) {
          this.eventBus.emit({
            type: 'route_locked',
            turn: workingState.meta.turn,
            routeId: route.id,
            lockFlag: route.lock,
            ...(route.announce !== undefined ? { announce: route.announce } : {}),
          });
        }
      }

      const endingRes = evaluateEndings({
        state: workingState,
        ledger: workingLedger,
        endings: this.endings,
        routes: this.routes,
        recentTranscriptLines,
        reducerOptions: {
          compiledSchema: this.fullCompiledSchema,
          formIndex: this.formIndex,
          auditSeqStart: workingAuditSeq,
        },
      });

      workingState = endingRes.nextState;
      turnAuditEntries.push(...endingRes.auditEntries);
      workingAuditSeq += endingRes.auditEntries.length;
      for (const p of endingRes.changedPaths) {
        turnChangedPaths.add(p);
      }
      turnWarnings.push(...endingRes.warnings);

      if (endingRes.triggeredEnding !== null && triggeredEnding === null) {
        triggeredEnding = endingRes.triggeredEnding;
        this.eventBus.emit({
          type: 'ending_triggered',
          turn: workingState.meta.turn,
          endingId: triggeredEnding.id,
          mark: triggeredEnding.mark,
        });
      }
    };

    this.eventBus.emit({
      type: 'turn_started',
      turn: nextTurnNumber,
      input: input.text,
    });

    // Step 1: Clear transient turnEvents & scene.directorNudge, apply steering, parse intent.
    const clearOps: PatchOperation[] = [];
    if (workingState.turnEvents.combatOutcomes.length > 0) {
      clearOps.push({ op: 'set', path: 'turnEvents.combatOutcomes', value: [] });
    }
    if (workingState.turnEvents.rumors.length > 0) {
      clearOps.push({ op: 'set', path: 'turnEvents.rumors', value: [] });
    }
    if (workingState.turnEvents.systemNotices.length > 0) {
      clearOps.push({ op: 'set', path: 'turnEvents.systemNotices', value: [] });
    }
    if (workingState.scene.directorNudge !== null) {
      clearOps.push({ op: 'set', path: 'scene.directorNudge', value: null });
    }
    if (clearOps.length > 0) {
      const clearRes = commitWorkingBatch({
        eventId: `turn:${nextTurnNumber}:clear_transient`,
        source: 'engine',
        operations: clearOps,
        reason: 'Clear previous turn transient events and director nudge',
      });
      if (!clearRes.ok) {
        return clearRes;
      }
    }

    if (input.directorSteering !== undefined) {
      const steerRes = applyDirectorSteering({
        state: workingState,
        ledger: workingLedger,
        steering: input.directorSteering,
        beats: this.beats,
        reducerOptions: {
          compiledSchema: this.fullCompiledSchema,
          formIndex: this.formIndex,
          auditSeqStart: workingAuditSeq,
        },
      });
      if (!steerRes.ok) {
        return err(steerRes.error);
      }
      workingState = steerRes.value.nextState;
      workingLedger = steerRes.value.nextLedger;
      turnAuditEntries.push(...steerRes.value.auditEntries);
      workingAuditSeq += steerRes.value.auditEntries.length;
      for (const p of steerRes.value.changedPaths) {
        turnChangedPaths.add(p);
      }
      totalDaysElapsed += steerRes.value.daysElapsed;
      totalSlotsElapsed += steerRes.value.slotsElapsed;

      if (steerRes.value.triggeredScripts.length > 0) {
        await runScriptEffects(steerRes.value.triggeredScripts);
      }
    }

    const inCombat = workingCombatState?.active === true;
    const availableLocationIds = Object.keys(workingState.entities.locations)
      .filter(isSafeKey)
      .sort();
    const availableSkillIds = this.skillRegistry.list().map((s) => s.id);

    const intentRes = await parsePlayerIntent({
      input: input.text,
      state: workingState,
      inCombat,
      gateway: this.gateway,
      allowLlmFallback: this.useBoundaryLlmAgents.intentParser,
      availableLocationIds,
      availableSkillIds,
      signal: input.signal,
    });
    turnWarnings.push(...intentRes.warnings);

    this.eventBus.emit({
      type: 'intent_parsed',
      turn: nextTurnNumber,
      intentKind: intentRes.intent.kind,
      usedLlm: intentRes.usedLlm,
    });

    // Step 2 & Step 3: Resolve deterministic action and commit atomically.
    const actionResolution = await this.resolveDeterministicAction({
      intent: intentRes.intent,
      explicitCombatActions: input.combatActions,
      workingState,
      workingCombatState,
      nextTurnNumber,
      signal: input.signal,
      commitBatch: commitWorkingBatch,
    });

    if (!actionResolution.ok) {
      return actionResolution;
    }

    workingState = actionResolution.value.workingState;
    workingCombatState = actionResolution.value.workingCombatState;
    storySlotsToAdvance += actionResolution.value.storySlotsToAdvance;
    if (actionResolution.value.combatEndedThisTurn) {
      combatEndedThisTurn = true;
    }
    turnWarnings.push(...actionResolution.value.warnings);

    this.eventBus.emit({
      type: 'action_resolved',
      turn: nextTurnNumber,
      changedPaths: [...turnChangedPaths],
      combatActive: workingCombatState?.active === true,
    });

    // Step 4: Advance Dual World Clock, tick off-screen agendas if days elapsed, sync location cast.
    const effectiveStorySlots =
      workingState.capabilities.clocks === 'disabled' ? 0 : storySlotsToAdvance;

    const clockRes = commitWorkingBatch({
      eventId: `turn:${nextTurnNumber}:clock_advance`,
      source: 'engine',
      operations: [
        {
          op: 'clock_advance',
          mechanicalTurns: 1,
          storySlots: effectiveStorySlots,
        },
      ],
      reason: 'Advance turn clock',
    });
    if (!clockRes.ok) {
      return clockRes;
    }

    this.eventBus.emit({
      type: 'clock_advanced',
      turn: workingState.meta.turn,
      day: workingState.clocks.day,
      slot: workingState.clocks.slot,
      daysElapsed: clockRes.value.daysElapsed,
      slotsElapsed: clockRes.value.slotsElapsed,
      expiredTimers: clockRes.value.expiredTimers,
    });

    if (totalDaysElapsed > 0 && workingState.capabilities.factions) {
      const agendaRes = runAgendaTick(
        workingState,
        this.agendaConfig,
        totalDaysElapsed,
        workingState.meta.rngState
      );
      if (agendaRes.operations.length > 0) {
        const agendaCommit = commitWorkingBatch({
          eventId: `turn:${workingState.meta.turn}:agendas`,
          source: 'agenda',
          operations: agendaRes.operations,
          reason: `Off-screen agenda tick (${totalDaysElapsed} day(s))`,
        });
        if (!agendaCommit.ok) {
          return agendaCommit;
        }
      }
      workingState.meta.rngState = cloneRngState(agendaRes.nextRng);
      this.eventBus.emit({
        type: 'agendas_ticked',
        turn: workingState.meta.turn,
        daysElapsed: totalDaysElapsed,
        rumors: agendaRes.generatedRumors,
      });
    }

    if (this.digestConfig !== false && workingState.capabilities.clocks !== 'disabled') {
      const digestRes = evaluateDigestFlow(workingState, this.digestConfig);
      if (digestRes.published && digestRes.edition !== null && digestRes.patches.length > 0) {
        const digestCommit = commitWorkingBatch({
          eventId: `turn:${workingState.meta.turn}:digest:${digestRes.edition.id}`,
          source: 'engine',
          operations: digestRes.patches,
          reason: `Newsroom digest published for Day ${digestRes.edition.day}`,
        });
        if (!digestCommit.ok) {
          return digestCommit;
        }
        this.eventBus.emit({
          type: 'digest_published',
          turn: workingState.meta.turn,
          editionId: digestRes.edition.id,
          day: digestRes.edition.day,
          masthead: digestRes.edition.masthead,
          headlineCount: digestRes.edition.headlines.length,
        });
      }
    }

    const castAfterClock = computeLocationCast(workingState, this.formDefinitions);
    if (!arraysEqual(castAfterClock.presentCharacterIds, workingState.scene.presentCharacterIds)) {
      const castSyncRes = commitWorkingBatch({
        eventId: `turn:${workingState.meta.turn}:cast_sync`,
        source: 'engine',
        operations: [
          {
            op: 'set',
            path: 'scene.presentCharacterIds',
            value: castAfterClock.presentCharacterIds,
          },
        ],
        reason: 'Sync scene.presentCharacterIds from location cast',
      });
      if (!castSyncRes.ok) {
        return castSyncRes;
      }
    }

    // Step 5: Beats, routes, sandboxed scripts & endings.
    const priorTranscript = getLinearTranscript(this.swipeTree, 30);
    const recentTranscriptLines = [...priorTranscript.map((m) => m.content), input.text];

    await evaluateNarrativeGraph(recentTranscriptLines, turnChangedPaths);

    // Pre-narration checkpoint (stored on userMessageNode so swipe rollback restores exact pre-response state)
    const preResponseState = cloneWorldState(workingState);
    const preResponseLedger = cloneBeatLedger(workingLedger);
    const clockAdvancedThisTurn = totalSlotsElapsed > 0 || totalDaysElapsed > 0;

    // Step 6 & Step 7 & Step 8: Compile prompt, generate narrator reply, run post-turn agents.
    const userMessageId = this.allocateMessageId(workingState.meta.turn, 'user');
    const assistantMessageId = this.allocateMessageId(workingState.meta.turn, 'assistant');

    const recentChatMessages: ChatMessage[] = priorTranscript.map((m) => ({
      role: m.role as ChatMessage['role'],
      content: m.content,
    }));

    const turnMetaSnapshot: TurnMetaSnapshot = {
      liveNudges: latestLiveNudges,
      activeAmbient: latestActiveAmbient,
      injectedPrompts: turnInjectedPrompts.map((p) => ({ section: p.section, text: p.text })),
      triggeredEnding,
      clockAdvancedThisTurn,
      combatEndedThisTurn,
    };

    const narrationPhaseRes = await this.runNarrationAndPostTurnAgents({
      workingState,
      workingLedger,
      workingAuditSeq,
      latestInput: input.text,
      recentTranscript: recentChatMessages,
      assistantMessageId,
      swipeIndex: 0,
      turnMeta: turnMetaSnapshot,
      streamNarrator: input.streamNarrator === true,
      signal: input.signal,
      turnAuditEntries,
      turnChangedPaths,
      turnWarnings,
      turnEventRecords,
      turnPendingConfirmations,
    });

    if (!narrationPhaseRes.ok) {
      return narrationPhaseRes;
    }

    workingState = narrationPhaseRes.value.workingState;
    workingLedger = narrationPhaseRes.value.workingLedger;
    workingAuditSeq = narrationPhaseRes.value.workingAuditSeq;
    const narratorText = narrationPhaseRes.value.narratorText;
    const compiledPrompt = narrationPhaseRes.value.compiledPrompt;
    const trackerSkippedByCadence = narrationPhaseRes.value.trackerSkippedByCadence;

    if (
      narrationPhaseRes.value.postTurnChangedPaths.size > 0 &&
      (workingState.capabilities.beats ||
        (this.formRules.length > 0 && this.formIndex !== undefined))
    ) {
      const postTranscriptLines = [...recentTranscriptLines, narratorText];
      await evaluateNarrativeGraph(postTranscriptLines, narrationPhaseRes.value.postTurnChangedPaths);
    }

    // Step 9: Record user & assistant message nodes in SwipeTreeState and persist if saveDir is set.
    const userSerializedLedger = serializeBeatLedger(preResponseLedger);
    const userCheckpoint: StateCheckpoint = {
      checkpointId: this.allocateCheckpointId(preResponseState.meta.turn, 'user'),
      turn: preResponseState.meta.turn,
      worldState: preResponseState,
      beatLedger: userSerializedLedger,
      rngState: cloneRngState(preResponseState.meta.rngState),
      stateHash: computeStateHash(preResponseState, userSerializedLedger),
    };

    const treeAfterUserRes = appendMessageTurn(this.swipeTree, {
      messageId: userMessageId,
      parentMessageId: this.swipeTree.activeLeafMessageId,
      role: 'user',
      content: input.text,
      checkpoint: userCheckpoint,
    });
    if (!treeAfterUserRes.ok) {
      return err(treeAfterUserRes.error);
    }

    const postSerializedLedger = serializeBeatLedger(workingLedger);
    const assistantCheckpoint: StateCheckpoint = {
      checkpointId: this.allocateCheckpointId(workingState.meta.turn, 'assistant'),
      turn: workingState.meta.turn,
      worldState: cloneWorldState(workingState),
      beatLedger: postSerializedLedger,
      rngState: cloneRngState(workingState.meta.rngState),
      stateHash: computeStateHash(workingState, postSerializedLedger),
    };

    const treeAfterAssistantRes = appendMessageTurn(treeAfterUserRes.value, {
      messageId: assistantMessageId,
      parentMessageId: userMessageId,
      role: 'assistant',
      content: narratorText,
      checkpoint: assistantCheckpoint,
    });
    if (!treeAfterAssistantRes.ok) {
      return err(treeAfterAssistantRes.error);
    }

    const nextTree = treeAfterAssistantRes.value;

    if (this.saveDir !== null) {
      const persistRes = await this.persistTurnToDisk({
        turn: workingState.meta.turn,
        worldState: workingState,
        beatLedger: workingLedger,
        swipeTree: nextTree,
        eventRecords: turnEventRecords,
        auditEntries: turnAuditEntries,
      });
      if (!persistRes.ok) {
        return persistRes;
      }
    }

    // Commit all working state to runtime fields now that the turn succeeded.
    this.state = workingState;
    this.beatLedger = workingLedger;
    this.combatState = workingCombatState;
    this.swipeTree = nextTree;
    this.auditSeq = workingAuditSeq;
    this.auditLog.push(...turnAuditEntries);
    if (turnPendingConfirmations.length > 0) {
      this.pendingConfirmations.push(...turnPendingConfirmations);
    }
    this.turnMetaByUserMessageId.set(userMessageId, turnMetaSnapshot);

    return ok({
      turn: workingState.meta.turn,
      userMessageId,
      assistantMessageId,
      swipeIndex: 0,
      narratorText,
      state: cloneWorldState(this.state),
      beatLedger: cloneBeatLedger(this.beatLedger),
      combatState: this.combatState ? cloneCombatStateSnapshot(this.combatState) : null,
      compiledPrompt,
      auditEntries: turnAuditEntries,
      pendingConfirmations: turnPendingConfirmations.map(cloneOperation),
      triggeredEnding,
      trackerSkippedByCadence,
      warnings: turnWarnings,
    });
  }

  /**
   * Roll back to the exact pre-response state before `assistantMessageId`, re-run narration
   * and post-turn boundary agents, and record the new swipe variant on that message node.
   */
  async regenerateTurn(
    assistantMessageId: string,
    options: RegenerateTurnOptions = {}
  ): Promise<Result<TurnExecutionResult, ValidationError[]>> {
    const rollbackRes = rollbackForSwipe(this.swipeTree, assistantMessageId);
    if (!rollbackRes.ok) {
      return err(rollbackRes.error);
    }

    const { restoredCheckpoint, parentMessageId } = rollbackRes.value;

    let workingState = cloneWorldState(restoredCheckpoint.worldState);
    workingState.meta.rngState = cloneRngState(restoredCheckpoint.rngState);
    let workingLedger = deserializeBeatLedger(restoredCheckpoint.beatLedger, this.beats);
    let workingAuditSeq = this.auditSeq;

    const turnAuditEntries: AuditEntry[] = [];
    const turnChangedPaths = new Set<string>();
    const turnWarnings: ValidationError[] = [];
    const turnEventRecords: EventLogRecord[] = [];
    const turnPendingConfirmations: PatchOperation[] = [];

    this.eventBus.emit({
      type: 'swipe_rolled_back',
      assistantMessageId,
      restoredTurn: workingState.meta.turn,
    });

    if (options.directorSteering !== undefined) {
      const steerRes = applyDirectorSteering({
        state: workingState,
        ledger: workingLedger,
        steering: options.directorSteering,
        beats: this.beats,
        reducerOptions: {
          compiledSchema: this.fullCompiledSchema,
          formIndex: this.formIndex,
          auditSeqStart: workingAuditSeq,
        },
      });
      if (!steerRes.ok) {
        return err(steerRes.error);
      }
      workingState = steerRes.value.nextState;
      workingLedger = steerRes.value.nextLedger;
      turnAuditEntries.push(...steerRes.value.auditEntries);
      workingAuditSeq += steerRes.value.auditEntries.length;
      for (const p of steerRes.value.changedPaths) {
        turnChangedPaths.add(p);
      }
    }

    let userInputText = '';
    let transcriptBeforeUser: ChatMessage[] = [];
    let cachedMeta: TurnMetaSnapshot | undefined;

    if (parentMessageId !== null) {
      const parentNode = getOwn(this.swipeTree.nodes, parentMessageId) as
        | TranscriptMessageNode
        | undefined;
      if (parentNode !== undefined) {
        const activeUserSwipe = parentNode.swipes[parentNode.activeSwipeIndex];
        userInputText = activeUserSwipe?.content ?? '';
        transcriptBeforeUser = resolveTranscriptEndingAt(
          this.swipeTree,
          parentNode.parentMessageId,
          30
        );
      }
      cachedMeta = this.turnMetaByUserMessageId.get(parentMessageId);
    }

    const targetNode = getOwn(this.swipeTree.nodes, assistantMessageId);
    const nextSwipeIndex = targetNode !== undefined ? targetNode.swipes.length : 1;

    const turnMeta: TurnMetaSnapshot = cachedMeta ?? {
      liveNudges: [],
      activeAmbient: [],
      injectedPrompts: [],
      triggeredEnding: null,
      clockAdvancedThisTurn: false,
      combatEndedThisTurn: false,
    };

    const narrationPhaseRes = await this.runNarrationAndPostTurnAgents({
      workingState,
      workingLedger,
      workingAuditSeq,
      latestInput: userInputText,
      recentTranscript: transcriptBeforeUser,
      assistantMessageId,
      swipeIndex: nextSwipeIndex,
      turnMeta,
      streamNarrator: options.streamNarrator === true,
      signal: options.signal,
      turnAuditEntries,
      turnChangedPaths,
      turnWarnings,
      turnEventRecords,
      turnPendingConfirmations,
    });

    if (!narrationPhaseRes.ok) {
      return narrationPhaseRes;
    }

    workingState = narrationPhaseRes.value.workingState;
    workingLedger = narrationPhaseRes.value.workingLedger;
    workingAuditSeq = narrationPhaseRes.value.workingAuditSeq;
    const narratorText = narrationPhaseRes.value.narratorText;
    const compiledPrompt = narrationPhaseRes.value.compiledPrompt;
    const trackerSkippedByCadence = narrationPhaseRes.value.trackerSkippedByCadence;

    if (narrationPhaseRes.value.postTurnChangedPaths.size > 0 && workingState.capabilities.beats) {
      const recentLines = [
        ...transcriptBeforeUser.map((m) => m.content),
        userInputText,
        narratorText,
      ];
      const routeRes = evaluateRoutes({
        state: workingState,
        ledger: workingLedger,
        routes: this.routes,
        recentTranscriptLines: recentLines,
        reducerOptions: {
          compiledSchema: this.fullCompiledSchema,
          formIndex: this.formIndex,
          auditSeqStart: workingAuditSeq,
        },
      });
      workingState = routeRes.nextState;
      turnAuditEntries.push(...routeRes.auditEntries);
      workingAuditSeq += routeRes.auditEntries.length;
      turnWarnings.push(...routeRes.warnings);

      const activeBeats = filterBeatsForActiveRoutes(this.beats, workingState, this.routes, {
        requireRouteLocked: true,
      });
      const beatRes = evaluateBeatGraph({
        state: workingState,
        ledger: workingLedger,
        beats: activeBeats,
        dependencyIndex: this.dependencyIndex,
        changedPaths: narrationPhaseRes.value.postTurnChangedPaths,
        recentTranscriptLines: recentLines,
        beatPressure: this.config.tuningDials.beatPressure,
        reducerOptions: {
          compiledSchema: this.fullCompiledSchema,
          formIndex: this.formIndex,
          auditSeqStart: workingAuditSeq,
        },
      });
      workingState = beatRes.nextState;
      workingLedger = beatRes.nextLedger;
      turnAuditEntries.push(...beatRes.auditEntries);
      workingAuditSeq += beatRes.auditEntries.length;
      turnWarnings.push(...beatRes.warnings);
    }

    const postSerializedLedger = serializeBeatLedger(workingLedger);
    const variantCheckpoint: StateCheckpoint = {
      checkpointId: this.allocateCheckpointId(workingState.meta.turn, `swipe-${nextSwipeIndex}`),
      turn: workingState.meta.turn,
      worldState: cloneWorldState(workingState),
      beatLedger: postSerializedLedger,
      rngState: cloneRngState(workingState.meta.rngState),
      stateHash: computeStateHash(workingState, postSerializedLedger),
    };

    const recordRes = recordSwipeVariant(this.swipeTree, assistantMessageId, {
      content: narratorText,
      checkpoint: variantCheckpoint,
      createdAtSeq: workingAuditSeq,
    });
    if (!recordRes.ok) {
      return err(recordRes.error);
    }

    const nextTree = recordRes.value.nextTree;

    if (this.saveDir !== null) {
      const persistRes = await this.persistTurnToDisk({
        turn: workingState.meta.turn,
        worldState: workingState,
        beatLedger: workingLedger,
        swipeTree: nextTree,
        eventRecords: turnEventRecords,
        auditEntries: turnAuditEntries,
      });
      if (!persistRes.ok) {
        return persistRes;
      }
    }

    this.state = workingState;
    this.beatLedger = workingLedger;
    this.swipeTree = nextTree;
    this.auditSeq = workingAuditSeq;
    this.auditLog.push(...turnAuditEntries);
    if (turnPendingConfirmations.length > 0) {
      this.pendingConfirmations.push(...turnPendingConfirmations);
    }

    return ok({
      turn: workingState.meta.turn,
      userMessageId: parentMessageId ?? '',
      assistantMessageId,
      swipeIndex: recordRes.value.newSwipeIndex,
      narratorText,
      state: cloneWorldState(this.state),
      beatLedger: cloneBeatLedger(this.beatLedger),
      combatState: this.combatState ? cloneCombatStateSnapshot(this.combatState) : null,
      compiledPrompt,
      auditEntries: turnAuditEntries,
      pendingConfirmations: turnPendingConfirmations.map(cloneOperation),
      triggeredEnding: turnMeta.triggeredEnding,
      trackerSkippedByCadence,
      warnings: turnWarnings,
    });
  }

  /**
   * Edit a message node's content, recording a new swipe variant at `nodeId` and rewinding
   * the active leaf to `nodeId` while restoring its checkpointed state.
   */
  async editMessage(
    nodeId: string,
    newContent: string
  ): Promise<
    Result<
      {
        readonly nodeId: string;
        readonly swipeIndex: number;
        readonly content: string;
        readonly state: WorldState;
        readonly swipeTree: SwipeTreeState;
      },
      ValidationError[]
    >
  > {
    const editRes = editMessageNode(this.swipeTree, nodeId, newContent);
    if (!editRes.ok) {
      return err(editRes.error);
    }

    const { nextTree, restoredCheckpoint, swipeIndex } = editRes.value;
    const restoredState = cloneWorldState(restoredCheckpoint.worldState);
    restoredState.meta.rngState = cloneRngState(restoredCheckpoint.rngState);
    const restoredLedger = deserializeBeatLedger(restoredCheckpoint.beatLedger, this.beats);

    if (this.saveDir !== null) {
      const saveRes = await saveSwipeTreeAtomic(this.saveDir, nextTree);
      if (!saveRes.ok) {
        return err(saveRes.error);
      }
    }

    this.state = restoredState;
    this.beatLedger = restoredLedger;
    this.swipeTree = nextTree;

    this.eventBus.emit({
      type: 'swipe_switched',
      assistantMessageId: nodeId,
      swipeIndex,
      restoredTurn: restoredState.meta.turn,
    });

    return ok({
      nodeId,
      swipeIndex,
      content: newContent,
      state: cloneWorldState(this.state),
      swipeTree: this.getSwipeTree(),
    });
  }

  /**
   * Continue assistant narration from `options.nodeId` (or the current `activeLeafMessageId`),
   * restoring that node's checkpoint and appending a new assistant message node.
   */
  async continueFromNode(
    options: RegenerateTurnOptions & { readonly nodeId?: string } = {}
  ): Promise<Result<TurnExecutionResult, ValidationError[]>> {
    const prepRes = prepareContinueFromNode(this.swipeTree, options.nodeId);
    if (!prepRes.ok) {
      return err(prepRes.error);
    }

    const { nextTree: rewoundTree, targetNodeId, role, content, restoredCheckpoint } = prepRes.value;
    let workingState = cloneWorldState(restoredCheckpoint.worldState);
    workingState.meta.rngState = cloneRngState(restoredCheckpoint.rngState);
    let workingLedger = deserializeBeatLedger(restoredCheckpoint.beatLedger, this.beats);
    let workingAuditSeq = this.auditSeq;

    const turnAuditEntries: AuditEntry[] = [];
    const turnChangedPaths = new Set<string>();
    const turnWarnings: ValidationError[] = [];
    const turnEventRecords: EventLogRecord[] = [];
    const turnPendingConfirmations: PatchOperation[] = [];

    if (options.directorSteering !== undefined) {
      const steerRes = applyDirectorSteering({
        state: workingState,
        ledger: workingLedger,
        steering: options.directorSteering,
        beats: this.beats,
        reducerOptions: {
          compiledSchema: this.fullCompiledSchema,
          formIndex: this.formIndex,
          auditSeqStart: workingAuditSeq,
        },
      });
      if (!steerRes.ok) {
        return err(steerRes.error);
      }
      workingState = steerRes.value.nextState;
      workingLedger = steerRes.value.nextLedger;
      turnAuditEntries.push(...steerRes.value.auditEntries);
      workingAuditSeq += steerRes.value.auditEntries.length;
      for (const p of steerRes.value.changedPaths) {
        turnChangedPaths.add(p);
      }
    }

    const assistantMessageId = this.allocateMessageId(workingState.meta.turn, 'assistant');
    const recentTranscript = resolveTranscriptEndingAt(rewoundTree, targetNodeId, 30);
    const latestInput = role === 'user' ? content : '';

    const turnMeta: TurnMetaSnapshot = {
      liveNudges: [],
      activeAmbient: [],
      injectedPrompts: [],
      triggeredEnding: null,
      clockAdvancedThisTurn: false,
      combatEndedThisTurn: false,
    };

    const narrationPhaseRes = await this.runNarrationAndPostTurnAgents({
      workingState,
      workingLedger,
      workingAuditSeq,
      latestInput,
      recentTranscript,
      assistantMessageId,
      swipeIndex: 0,
      turnMeta,
      streamNarrator: options.streamNarrator === true,
      signal: options.signal,
      turnAuditEntries,
      turnChangedPaths,
      turnWarnings,
      turnEventRecords,
      turnPendingConfirmations,
    });

    if (!narrationPhaseRes.ok) {
      return narrationPhaseRes;
    }

    workingState = narrationPhaseRes.value.workingState;
    workingLedger = narrationPhaseRes.value.workingLedger;
    workingAuditSeq = narrationPhaseRes.value.workingAuditSeq;
    const narratorText = narrationPhaseRes.value.narratorText;
    const compiledPrompt = narrationPhaseRes.value.compiledPrompt;
    const trackerSkippedByCadence = narrationPhaseRes.value.trackerSkippedByCadence;

    const postSerializedLedger = serializeBeatLedger(workingLedger);
    const assistantCheckpoint: StateCheckpoint = {
      checkpointId: this.allocateCheckpointId(workingState.meta.turn, 'continue'),
      turn: workingState.meta.turn,
      worldState: cloneWorldState(workingState),
      beatLedger: postSerializedLedger,
      rngState: cloneRngState(workingState.meta.rngState),
      stateHash: computeStateHash(workingState, postSerializedLedger),
    };

    const appendedRes = appendMessageTurn(rewoundTree, {
      messageId: assistantMessageId,
      parentMessageId: targetNodeId,
      role: 'assistant',
      content: narratorText,
      checkpoint: assistantCheckpoint,
      createdAtSeq: workingAuditSeq,
    });
    if (!appendedRes.ok) {
      return err(appendedRes.error);
    }

    const nextTree = appendedRes.value;

    if (this.saveDir !== null) {
      const persistRes = await this.persistTurnToDisk({
        turn: workingState.meta.turn,
        worldState: workingState,
        beatLedger: workingLedger,
        swipeTree: nextTree,
        eventRecords: turnEventRecords,
        auditEntries: turnAuditEntries,
      });
      if (!persistRes.ok) {
        return persistRes;
      }
    }

    this.state = workingState;
    this.beatLedger = workingLedger;
    this.swipeTree = nextTree;
    this.auditSeq = workingAuditSeq;
    this.auditLog.push(...turnAuditEntries);
    if (turnPendingConfirmations.length > 0) {
      this.pendingConfirmations.push(...turnPendingConfirmations);
    }

    return ok({
      turn: workingState.meta.turn,
      userMessageId: role === 'user' ? targetNodeId : '',
      assistantMessageId,
      swipeIndex: 0,
      narratorText,
      state: cloneWorldState(this.state),
      beatLedger: cloneBeatLedger(this.beatLedger),
      combatState: this.combatState ? cloneCombatStateSnapshot(this.combatState) : null,
      compiledPrompt,
      auditEntries: turnAuditEntries,
      pendingConfirmations: turnPendingConfirmations.map(cloneOperation),
      triggeredEnding: null,
      trackerSkippedByCadence,
      warnings: turnWarnings,
    });
  }

  /**
   * Activate an existing swipe variant on `assistantMessageId` and restore `WorldState`,
   * `BeatLedgerState`, and `rngState` from its coupled checkpoint.
   */
  switchSwipe(
    assistantMessageId: string,
    swipeIndex: number
  ): Result<{ state: WorldState; beatLedger: BeatLedgerState; content: string }, ValidationError[]> {
    const activateRes = activateSwipeVariant(this.swipeTree, assistantMessageId, swipeIndex);
    if (!activateRes.ok) {
      return err(activateRes.error);
    }

    const { nextTree, restoredCheckpoint } = activateRes.value;
    const restoredState = cloneWorldState(restoredCheckpoint.worldState);
    restoredState.meta.rngState = cloneRngState(restoredCheckpoint.rngState);
    const restoredLedger = deserializeBeatLedger(restoredCheckpoint.beatLedger, this.beats);

    const node = getOwn(nextTree.nodes, assistantMessageId);
    const content = node?.swipes[swipeIndex]?.content ?? '';

    this.swipeTree = nextTree;
    this.state = restoredState;
    this.beatLedger = restoredLedger;
    this.pendingConfirmations = [];

    this.eventBus.emit({
      type: 'swipe_switched',
      assistantMessageId,
      swipeIndex,
      restoredTurn: this.state.meta.turn,
    });

    return ok({
      state: cloneWorldState(this.state),
      beatLedger: cloneBeatLedger(this.beatLedger),
      content,
    });
  }

  /**
   * Resolve queued tracker patches awaiting confirmation (`always_confirm` or `batch_confirm`).
   */
  confirmPendingPatches(
    decision: 'accept_all' | 'reject_all' | { readonly acceptIndices: readonly number[] }
  ): Result<{ state: WorldState; appliedCount: number }, ValidationError[]> {
    if (decision === 'reject_all') {
      this.pendingConfirmations = [];
      return ok({ state: cloneWorldState(this.state), appliedCount: 0 });
    }

    let opsToApply: PatchOperation[];
    if (decision === 'accept_all') {
      opsToApply = this.pendingConfirmations.map(cloneOperation);
    } else if (
      typeof decision === 'object' &&
      decision !== null &&
      Array.isArray(decision.acceptIndices)
    ) {
      const seen = new Set<number>();
      const validIndices: number[] = [];
      for (let i = 0; i < decision.acceptIndices.length; i += 1) {
        const idx = decision.acceptIndices[i];
        if (
          typeof idx !== 'number' ||
          !Number.isInteger(idx) ||
          idx < 0 ||
          idx >= this.pendingConfirmations.length
        ) {
          return err([
            validationError(
              `acceptIndices[${i}]`,
              'INVALID_INDEX',
              `Pending confirmation index ${String(idx)} is out of bounds`
            ),
          ]);
        }
        if (!seen.has(idx)) {
          seen.add(idx);
          validIndices.push(idx);
        }
      }
      validIndices.sort((a, b) => a - b);
      opsToApply = validIndices.map((idx) =>
        cloneOperation(this.pendingConfirmations[idx] as PatchOperation)
      );
    } else {
      return err([
        validationError(
          'decision',
          'INVALID_DECISION',
          'decision must be "accept_all", "reject_all", or { acceptIndices }'
        ),
      ]);
    }

    if (opsToApply.length === 0) {
      this.pendingConfirmations = [];
      return ok({ state: cloneWorldState(this.state), appliedCount: 0 });
    }

    const batchRes = applyPatchBatch(
      this.state,
      {
        eventId: `confirm:t${this.state.meta.turn}:s${this.auditSeq}`,
        source: 'user_director',
        operations: opsToApply,
        reason: 'User confirmed pending tracker patches',
      },
      {
        compiledSchema: this.fullCompiledSchema,
        formIndex: this.formIndex,
        auditSeqStart: this.auditSeq,
      }
    );

    if (!batchRes.ok) {
      return err(batchRes.error);
    }

    this.state = batchRes.value.nextState;
    this.auditSeq += batchRes.value.auditEntries.length;
    this.auditLog.push(...batchRes.value.auditEntries);
    this.pendingConfirmations = [];

    return ok({
      state: cloneWorldState(this.state),
      appliedCount: opsToApply.length,
    });
  }

  /**
   * Select a post-ending branch option (`ending.branches`) to continue into post-victory or a new season.
   */
  choosePostEndingBranch(
    branchId: string
  ): Result<ChooseEndingBranchResult, ValidationError[]> {
    const activeEndingId = this.state.meta.activeEndingId;
    if (activeEndingId === null) {
      return err([
        validationError('activeEndingId', 'NO_ACTIVE_ENDING', 'No active ending is currently set'),
      ]);
    }

    const ending = this.endings.find((e) => e.id === activeEndingId);
    if (!ending) {
      return err([
        validationError(
          'activeEndingId',
          'UNKNOWN_ENDING',
          `Active ending "${activeEndingId}" not found in cartridge endings`
        ),
      ]);
    }

    const branchRes = chooseEndingBranch({
      state: this.state,
      ending,
      branchId,
      routes: this.routes,
      reducerOptions: {
        compiledSchema: this.fullCompiledSchema,
        formIndex: this.formIndex,
        auditSeqStart: this.auditSeq,
      },
    });
    if (!branchRes.ok) {
      return branchRes;
    }

    this.state = branchRes.value.nextState;
    this.auditSeq += branchRes.value.auditEntries.length;
    this.auditLog.push(...branchRes.value.auditEntries);

    return ok(branchRes.value);
  }

  /**
   * Update the user Control Room override layer and recompile active capabilities/schema.
   */
  updateControlRoom(
    updater: (currentLayer: Readonly<ControlRoomLayer>) => ControlRoomLayer
  ): Result<ResolvedControlRoomConfig, ValidationError[]> {
    const draftLayer = cloneControlRoomLayer(updater(cloneControlRoomLayer(this.userLayer)));
    const nextConfig = resolveEffectiveControlRoomConfig(
      this.basePack,
      this.cartridge?.systemOverrides,
      draftLayer
    );

    const capCheck = validateSystemCapabilities(nextConfig.capabilities, 'capabilities');
    if (!capCheck.ok) {
      return err(capCheck.error);
    }

    this.userLayer = draftLayer;
    this.config = nextConfig;
    this.state.capabilities = cloneSystemCapabilities(nextConfig.capabilities);
    this.fullCompiledSchema = compileActiveTrackerSchema(this.config, {
      turn: this.state.meta.turn,
      clockAdvancedThisTurn: true,
      combatEndedThisTurn: true,
      manualTrigger: true,
    });

    return ok(cloneResolvedControlRoomConfig(this.config));
  }

  /**
   * Switch the active {@link SystemPack} wholesale or import only selected {@link PayloadGroupId}s
   * into the user Control Room layer.
   */
  switchSystemPack(
    pack: SystemPack,
    selectedGroups?: readonly PayloadGroupId[]
  ): Result<ResolvedControlRoomConfig, ValidationError[]> {
    const validatedPack = parseAndValidateSystemPack(pack);
    if (!validatedPack.ok) {
      return err(validatedPack.error);
    }

    if (selectedGroups === undefined) {
      this.basePack = validatedPack.value;
      this.config = resolveEffectiveControlRoomConfig(
        this.basePack,
        this.cartridge?.systemOverrides,
        this.userLayer
      );
    } else {
      const incomingBundle = createPayloadBundleFromSystemPack(validatedPack.value);
      this.userLayer = applySelectivePayloadGroups(this.userLayer, incomingBundle, selectedGroups);
      this.config = resolveEffectiveControlRoomConfig(
        this.basePack,
        this.cartridge?.systemOverrides,
        this.userLayer
      );
    }

    this.state.capabilities = cloneSystemCapabilities(this.config.capabilities);
    this.fullCompiledSchema = compileActiveTrackerSchema(this.config, {
      turn: this.state.meta.turn,
      clockAdvancedThisTurn: true,
      combatEndedThisTurn: true,
      manualTrigger: true,
    });

    return ok(cloneResolvedControlRoomConfig(this.config));
  }

  private getCardPersona(): {
    name: string;
    description: string;
    scenario?: string;
    systemPrompt?: string;
  } {
    if (this.cartridge !== null) {
      const p = this.cartridge.card.persona;
      return {
        name: p.name,
        description: p.description,
        ...(p.scenario !== undefined ? { scenario: p.scenario } : {}),
        ...(p.systemPrompt !== undefined ? { systemPrompt: p.systemPrompt } : {}),
      };
    }
    return {
      name: this.config.packName,
      description: this.basePack.description,
    };
  }

  private resolveScriptCode(scriptId: string): string | undefined {
    const scripts = this.cartridge?.scriptFiles;
    if (scripts === undefined || !isSafeKey(scriptId)) {
      return undefined;
    }
    const candidates = [
      scriptId,
      `scripts/${scriptId}.js`,
      `${scriptId}.js`,
      `scripts/${scriptId}`,
    ];
    for (const key of candidates) {
      const found = getOwn(scripts, key);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }

  private resolveEpiloguePrompt(ending: EndingDefinition): string | null {
    const parts: string[] = [];
    if (typeof ending.epilogue.promptPath === 'string' && ending.epilogue.promptPath.trim().length > 0) {
      const refPath = ending.epilogue.promptPath.trim();
      const endingFiles = this.cartridge?.endingPromptFiles;
      const loreFiles = this.cartridge?.loreFiles;
      const fileContent =
        (endingFiles !== undefined ? getOwn(endingFiles, refPath) : undefined) ??
        (endingFiles !== undefined ? getOwn(endingFiles, `endings/${refPath}`) : undefined) ??
        (loreFiles !== undefined ? getOwn(loreFiles, refPath) : undefined);
      if (fileContent !== undefined && fileContent.trim().length > 0) {
        parts.push(fileContent.trim());
      }
    }
    if (typeof ending.epilogue.template === 'string' && ending.epilogue.template.trim().length > 0) {
      parts.push(ending.epilogue.template.trim());
    }
    if (parts.length === 0) {
      return null;
    }
    return `[EPILOGUE · ${ending.id}] ${parts.join('\n')}`;
  }

  private allocateMessageId(turn: number, role: 'user' | 'assistant'): string {
    while (true) {
      this.msgSeq += 1;
      const candidate = `msg-t${turn}-${role}-${this.msgSeq}`;
      if (!Object.hasOwn(this.swipeTree.nodes, candidate)) {
        return candidate;
      }
    }
  }

  private allocateCheckpointId(turn: number, tag: string): string {
    while (true) {
      this.checkpointSeq += 1;
      const candidate = `cp-t${turn}-${tag}-${this.checkpointSeq}`;
      if (!Object.hasOwn(this.swipeTree.checkpoints, candidate)) {
        return candidate;
      }
    }
  }

  private async resolveDeterministicAction(params: {
    readonly intent: ParsedPlayerIntent;
    readonly explicitCombatActions?: readonly ProposedCombatAction[];
    workingState: WorldState;
    workingCombatState: CombatState | null;
    readonly nextTurnNumber: number;
    readonly signal?: AbortSignal;
    readonly commitBatch: (
      batch: PatchBatch,
      compiledSchema?: CompiledTrackerSchema
    ) => Result<
      {
        nextState: WorldState;
        changedPaths: Set<string>;
        appliedCount: number;
        daysElapsed: number;
        slotsElapsed: number;
        expiredTimers: string[];
      },
      ValidationError[]
    >;
  }): Promise<
    Result<
      {
        workingState: WorldState;
        workingCombatState: CombatState | null;
        storySlotsToAdvance: number;
        combatEndedThisTurn: boolean;
        warnings: ValidationError[];
      },
      ValidationError[]
    >
  > {
    let workingState = params.workingState;
    let workingCombatState = params.workingCombatState;
    let storySlotsToAdvance = 0;
    let combatEndedThisTurn = false;
    const warnings: ValidationError[] = [];

    const { intent, explicitCombatActions } = params;
    let playerCombatActions: readonly ProposedCombatAction[] | undefined = explicitCombatActions;

    if (intent.kind === 'command') {
      switch (intent.command) {
        case 'travel': {
          const target = String(intent.args['locationId'] ?? '');
          const travelRes = validateTravelTarget(
            workingState.capabilities.spatialMode,
            workingState.entities.locations,
            workingState.scene.locationId,
            target
          );
          if (!travelRes.ok) {
            return err(travelRes.error);
          }

          const ops: PatchOperation[] =
            workingState.capabilities.spatialMode === 'scene_only'
              ? [{ op: 'set', path: 'scene.location', value: travelRes.value.targetName }]
              : [{ op: 'emergent_location_visit', locationName: travelRes.value.targetName }];

          const commitRes = params.commitBatch({
            eventId: `turn:${params.nextTurnNumber}:travel`,
            source: 'player',
            operations: ops,
            reason: `Player travel to "${travelRes.value.targetName}"`,
          });
          if (!commitRes.ok) {
            return commitRes;
          }
          workingState = commitRes.value.nextState;
          storySlotsToAdvance += 1;
          break;
        }

        case 'rest': {
          const slotLower = workingState.clocks.slot.toLowerCase();
          if (
            slotLower === 'evening' ||
            slotLower === 'night' ||
            slotLower === 'dusk' ||
            slotLower === 'midnight'
          ) {
            storySlotsToAdvance += computeSlotsToMorning(workingState);
          } else {
            storySlotsToAdvance += 1;
          }

          const healOps: PatchOperation[] = [];
          const healResources = (
            prefix: string,
            resources: Record<string, { current: number; max: number }> | undefined
          ): void => {
            if (resources === undefined) {
              return;
            }
            for (const key of Object.keys(resources)) {
              if (!isSafeKey(key)) {
                continue;
              }
              const pool = getOwn(resources, key);
              if (pool === undefined || pool.current >= pool.max) {
                continue;
              }
              const amount =
                key === 'stamina' || key === 'mana'
                  ? pool.max - pool.current
                  : Math.max(1, Math.floor(pool.max * 0.25));
              const nextVal = Math.min(pool.max, pool.current + amount);
              if (nextVal > pool.current) {
                healOps.push({
                  op: 'set',
                  path: `${prefix}.resources.${key}.current`,
                  value: nextVal,
                });
              }
            }
          };

          if (workingState.capabilities.combatMode !== 'disabled') {
            healResources('player', workingState.player.resources);
            if (
              workingState.player.characterId !== null &&
              Object.hasOwn(workingState.entities.characters, workingState.player.characterId)
            ) {
              const pc = getOwn(workingState.entities.characters, workingState.player.characterId);
              healResources(
                `entities.characters.${workingState.player.characterId}`,
                pc?.resources
              );
            }
          }

          if (healOps.length > 0) {
            const healRes = params.commitBatch({
              eventId: `turn:${params.nextTurnNumber}:rest_heal`,
              source: 'player',
              operations: healOps,
              reason: 'Minor rest resource recovery',
            });
            if (!healRes.ok) {
              return healRes;
            }
            workingState = healRes.value.nextState;
          }
          break;
        }

        case 'hold_clock': {
          const reason =
            typeof intent.args['reason'] === 'string' && intent.args['reason'].trim().length > 0
              ? intent.args['reason'].trim()
              : 'Player held clock';
          const holdRes = params.commitBatch({
            eventId: `turn:${params.nextTurnNumber}:hold_clock`,
            source: 'player',
            operations: [{ op: 'clock_hold', reason }],
            reason,
          });
          if (!holdRes.ok) {
            return holdRes;
          }
          workingState = holdRes.value.nextState;
          break;
        }

        case 'release_clock': {
          const releaseRes = params.commitBatch({
            eventId: `turn:${params.nextTurnNumber}:release_clock`,
            source: 'player',
            operations: [{ op: 'clock_release' }],
            reason: 'Player released clock hold',
          });
          if (!releaseRes.ok) {
            return releaseRes;
          }
          workingState = releaseRes.value.nextState;
          break;
        }

        case 'play_as': {
          const charId = String(intent.args['characterId'] ?? '');
          if (!isSafeKey(charId) || !Object.hasOwn(workingState.entities.characters, charId)) {
            return err([
              validationError(
                'characterId',
                'UNRESOLVED_CHARACTER',
                `Character "${charId}" does not exist`
              ),
            ]);
          }
          const targetChar = getOwn(workingState.entities.characters, charId);
          const ops: PatchOperation[] = [
            { op: 'set', path: 'player.characterId', value: charId },
          ];
          if (targetChar !== undefined && targetChar.locationId !== null) {
            ops.push({ op: 'set', path: 'player.locationId', value: targetChar.locationId });
            ops.push({ op: 'set', path: 'scene.locationId', value: targetChar.locationId });
            const loc = getOwn(workingState.entities.locations, targetChar.locationId);
            if (loc !== undefined) {
              ops.push({ op: 'set', path: 'scene.location', value: loc.name });
            }
          }
          const playAsRes = params.commitBatch({
            eventId: `turn:${params.nextTurnNumber}:play_as:${charId}`,
            source: 'player',
            operations: ops,
            reason: `Switch player control to "${charId}"`,
          });
          if (!playAsRes.ok) {
            return playAsRes;
          }
          workingState = playAsRes.value.nextState;
          break;
        }

        case 'move':
          if (playerCombatActions === undefined) {
            playerCombatActions = [
              {
                type: 'move',
                to: { x: Number(intent.args['x']), y: Number(intent.args['y']) },
              },
            ];
          }
          break;

        case 'attack':
          if (playerCombatActions === undefined) {
            playerCombatActions = [
              {
                type: 'skill',
                skillId: 'basic_strike',
                targetId: String(intent.args['targetId'] ?? ''),
              },
            ];
          }
          break;

        case 'skill':
          if (playerCombatActions === undefined) {
            const targetId = intent.args['targetId'];
            playerCombatActions = [
              {
                type: 'skill',
                skillId: String(intent.args['skillId'] ?? ''),
                ...(typeof targetId === 'string' && targetId.length > 0 ? { targetId } : {}),
              },
            ];
          }
          break;

        case 'defend':
          if (playerCombatActions === undefined) {
            playerCombatActions = [{ type: 'defend' }];
          }
          break;

        case 'end_turn':
          if (playerCombatActions === undefined) {
            playerCombatActions = [{ type: 'end_turn' }];
          }
          break;
      }
    } else if (intent.kind === 'combat_actions' && playerCombatActions === undefined) {
      playerCombatActions = intent.actions;
    }

    if (workingCombatState?.active && playerCombatActions !== undefined) {
      const currentActorId = workingCombatState.initiativeOrder[workingCombatState.turnIndex];
      const currentActor =
        currentActorId !== undefined ? getSafeCombatant(workingCombatState, currentActorId) : undefined;

      let playerActorId =
        currentActor !== undefined && currentActor.team === 'ally' && currentActor.alive
          ? currentActor.id
          : workingState.player.characterId;

      if (
        playerActorId === null ||
        getSafeCombatant(workingCombatState, playerActorId) === undefined
      ) {
        playerActorId =
          workingCombatState.initiativeOrder.find((id) => {
            const c = workingCombatState ? getSafeCombatant(workingCombatState, id) : undefined;
            return c !== undefined && c.team === 'ally' && c.alive;
          }) ?? currentActorId ?? 'player';
      }

      const playerTurnRes = resolveCombatTurn({
        combatState: workingCombatState,
        worldState: workingState,
        actorId: playerActorId,
        proposedActions: playerCombatActions,
        registry: this.skillRegistry,
        rng: workingState.meta.rngState,
        xpAwardOnVictory: this.xpAwardOnVictory,
        ...(this.cartridge?.combat?.summons !== undefined
          ? { summons: this.cartridge.combat.summons }
          : {}),
        ...(this.cartridge?.combat?.formLoadouts !== undefined
          ? { formLoadouts: this.cartridge.combat.formLoadouts }
          : {}),
        ...(this.cartridge?.combat?.effectTemplates !== undefined
          ? { effectTemplates: this.cartridge.combat.effectTemplates }
          : {}),
      });

      workingCombatState = playerTurnRes.nextCombatState;
      workingState.meta.rngState = cloneRngState(playerTurnRes.nextRng);

      if (playerTurnRes.worldPatches.length > 0) {
        const combatCommit = params.commitBatch({
          eventId: `turn:${params.nextTurnNumber}:combat:${playerActorId}`,
          source: 'combat',
          operations: playerTurnRes.worldPatches,
          reason: playerTurnRes.outcomeSummary.summaryText,
        });
        if (!combatCommit.ok) {
          return combatCommit;
        }
        workingState = combatCommit.value.nextState;
      }

      if (playerTurnRes.outcomeSummary.encounterEnded) {
        combatEndedThisTurn = true;
      }

      // Loop subsequent NPC / enemy turns in initiative order until it is an ally/player turn or encounter ends.
      const maxNpcSteps = workingCombatState.initiativeOrder.length * 2 + 4;
      let npcStep = 0;
      const hasCombatAgent = this.gateway.resolveConnection('combat_agent').ok;

      while (workingCombatState.active && npcStep < maxNpcSteps) {
        npcStep += 1;
        const nextActorId = workingCombatState.initiativeOrder[workingCombatState.turnIndex];
        if (nextActorId === undefined) {
          break;
        }
        const nextActor = getSafeCombatant(workingCombatState, nextActorId);
        if (nextActor === undefined || !nextActor.alive || nextActor.team === 'ally') {
          break;
        }

        let npcProposed: ProposedCombatAction[] = [];
        if (hasCombatAgent) {
          const agentRes = await proposeNpcCombatActions({
            combatState: workingCombatState,
            actorId: nextActorId,
            registry: this.skillRegistry,
            gateway: this.gateway,
            signal: params.signal,
          });
          warnings.push(...agentRes.warnings);
          npcProposed = agentRes.proposedActions;
        }

        const npcTurnRes = resolveCombatTurn({
          combatState: workingCombatState,
          worldState: workingState,
          actorId: nextActorId,
          proposedActions: npcProposed,
          registry: this.skillRegistry,
          rng: workingState.meta.rngState,
          xpAwardOnVictory: this.xpAwardOnVictory,
          ...(this.cartridge?.combat?.summons !== undefined
            ? { summons: this.cartridge.combat.summons }
            : {}),
          ...(this.cartridge?.combat?.formLoadouts !== undefined
            ? { formLoadouts: this.cartridge.combat.formLoadouts }
            : {}),
          ...(this.cartridge?.combat?.effectTemplates !== undefined
            ? { effectTemplates: this.cartridge.combat.effectTemplates }
            : {}),
        });

        workingCombatState = npcTurnRes.nextCombatState;
        workingState.meta.rngState = cloneRngState(npcTurnRes.nextRng);

        if (npcTurnRes.worldPatches.length > 0) {
          const npcCommit = params.commitBatch({
            eventId: `turn:${params.nextTurnNumber}:combat:${nextActorId}:npc${npcStep}`,
            source: 'combat',
            operations: npcTurnRes.worldPatches,
            reason: npcTurnRes.outcomeSummary.summaryText,
          });
          if (!npcCommit.ok) {
            return npcCommit;
          }
          workingState = npcCommit.value.nextState;
        }

        if (npcTurnRes.outcomeSummary.encounterEnded) {
          combatEndedThisTurn = true;
          break;
        }
      }
    }

    return ok({
      workingState,
      workingCombatState,
      storySlotsToAdvance,
      combatEndedThisTurn,
      warnings,
    });
  }

  private async runNarrationAndPostTurnAgents(params: {
    workingState: WorldState;
    workingLedger: BeatLedgerState;
    workingAuditSeq: number;
    readonly latestInput: string;
    readonly recentTranscript: readonly ChatMessage[];
    readonly assistantMessageId: string;
    readonly swipeIndex: number;
    readonly turnMeta: TurnMetaSnapshot;
    readonly streamNarrator: boolean;
    readonly signal?: AbortSignal;
    readonly turnAuditEntries: AuditEntry[];
    readonly turnChangedPaths: Set<string>;
    readonly turnWarnings: ValidationError[];
    readonly turnEventRecords: EventLogRecord[];
    readonly turnPendingConfirmations: PatchOperation[];
  }): Promise<
    Result<
      {
        workingState: WorldState;
        workingLedger: BeatLedgerState;
        workingAuditSeq: number;
        narratorText: string;
        compiledPrompt: CompiledPromptResult;
        trackerSkippedByCadence: boolean;
        postTurnChangedPaths: Set<string>;
      },
      ValidationError[]
    >
  > {
    let workingState = params.workingState;
    const workingLedger = params.workingLedger;
    let workingAuditSeq = params.workingAuditSeq;

    const injectedPrompts: InjectedScriptPrompt[] = params.turnMeta.injectedPrompts.map((p) => ({
      section: p.section,
      text: p.text,
    }));

    if (params.turnMeta.triggeredEnding !== null) {
      const epilogueText = this.resolveEpiloguePrompt(params.turnMeta.triggeredEnding);
      if (epilogueText !== null) {
        injectedPrompts.push({ section: 'plot', text: epilogueText });
      }
    }

    // Step 6: Compile prompt
    const compiledPrompt = compileNarratorPrompt({
      state: workingState,
      config: this.config,
      cardPersona: this.getCardPersona(),
      liveNudges: params.turnMeta.liveNudges,
      activeAmbient: params.turnMeta.activeAmbient,
      loreContents: this.cartridge?.loreFiles,
      injectedScriptPrompts: injectedPrompts,
      recentTranscript: params.recentTranscript,
      latestInput: params.latestInput,
      formDefinitions: this.formDefinitions,
    });

    this.eventBus.emit({
      type: 'prompt_compiled',
      turn: workingState.meta.turn,
      totalEstimatedTokens: compiledPrompt.totalEstimatedTokens,
      droppedItemsCount: compiledPrompt.droppedItemsCount,
    });

    // Step 7: Generate narrator reply
    let narratorText = '';
    if (params.streamNarrator) {
      const chunks: string[] = [];
      for await (const chunkRes of this.gateway.streamText({
        role: 'narrator',
        messages: compiledPrompt.messages,
        signal: params.signal,
      })) {
        if (!chunkRes.ok) {
          return err(chunkRes.error);
        }
        if (chunkRes.value.text.length > 0) {
          chunks.push(chunkRes.value.text);
        }
        this.eventBus.emit({
          type: 'narrator_chunk',
          turn: workingState.meta.turn,
          text: chunkRes.value.text,
          done: chunkRes.value.done,
        });
      }
      narratorText = chunks.join('');
    } else {
      const genRes = await this.gateway.generateText({
        role: 'narrator',
        messages: compiledPrompt.messages,
        signal: params.signal,
      });
      if (!genRes.ok) {
        return err(genRes.error);
      }
      narratorText = genRes.value;
    }

    this.eventBus.emit({
      type: 'narrator_completed',
      turn: workingState.meta.turn,
      messageId: params.assistantMessageId,
      swipeIndex: params.swipeIndex,
      text: narratorText,
    });

    // Step 8: Post-turn boundary agents
    const turnContext: CadenceContext = {
      turn: workingState.meta.turn,
      clockAdvancedThisTurn: params.turnMeta.clockAdvancedThisTurn,
      combatEndedThisTurn: params.turnMeta.combatEndedThisTurn,
    };
    const recentExchangeText = `Player: ${params.latestInput}\nNarrator: ${narratorText}`;
    const postTurnChangedPaths = new Set<string>();

    const applyAgentBatch = (
      batch: PatchBatch,
      schemaForBatch: CompiledTrackerSchema
    ): number => {
      const rngBefore = cloneRngState(workingState.meta.rngState);
      const res = applyPatchBatch(workingState, batch, {
        compiledSchema: schemaForBatch,
        formIndex: this.formIndex,
        auditSeqStart: workingAuditSeq,
      });
      if (!res.ok) {
        params.turnWarnings.push(...res.error);
        return 0;
      }

      workingState = res.value.nextState;
      workingAuditSeq += res.value.auditEntries.length;
      params.turnAuditEntries.push(...res.value.auditEntries);
      for (const p of res.value.changedPaths) {
        params.turnChangedPaths.add(p);
        postTurnChangedPaths.add(p);
      }
      if (res.value.pendingConfirmations.length > 0) {
        params.turnPendingConfirmations.push(...res.value.pendingConfirmations);
        this.eventBus.emit({
          type: 'confirmations_queued',
          turn: workingState.meta.turn,
          count: res.value.pendingConfirmations.length,
        });
      }

      params.turnEventRecords.push({
        turn: workingState.meta.turn,
        batch,
        postStateHash: computeStateHash(workingState, serializeBeatLedger(workingLedger)),
        rngBefore,
        rngAfter: cloneRngState(workingState.meta.rngState),
      });

      return res.value.auditEntries.filter((e) => e.status === 'committed').length;
    };

    const trackerRes = await runDynamicStateTracker({
      state: workingState,
      config: this.config,
      gateway: this.gateway,
      turnContext,
      recentExchangeText,
      latestNarratorReply: narratorText,
      signal: params.signal,
    });
    params.turnWarnings.push(...trackerRes.warnings);

    let trackerAppliedOps = 0;
    if (
      !trackerRes.skippedByCadence &&
      trackerRes.proposedBatch !== null &&
      trackerRes.proposedBatch.operations.length > 0
    ) {
      trackerAppliedOps = applyAgentBatch(trackerRes.proposedBatch, trackerRes.compiledSchema);
    }

    this.eventBus.emit({
      type: 'tracker_completed',
      turn: workingState.meta.turn,
      skippedByCadence: trackerRes.skippedByCadence,
      appliedOpsCount: trackerAppliedOps,
    });

    const useCastLlm =
      this.useBoundaryLlmAgents.castDirector &&
      this.gateway.resolveConnection('cast_director').ok;
    const castRes = await runCastDirector({
      state: workingState,
      formDefinitions: this.formDefinitions,
      gateway: this.gateway,
      useLlmPass: useCastLlm,
      recentExchangeText,
      signal: params.signal,
    });
    params.turnWarnings.push(...castRes.warnings);
    if (castRes.proposedBatch !== null && castRes.proposedBatch.operations.length > 0) {
      applyAgentBatch(castRes.proposedBatch, this.fullCompiledSchema);
    }

    const useStorylineLlm =
      workingState.capabilities.beats &&
      this.useBoundaryLlmAgents.storylinePlanner &&
      this.gateway.resolveConnection('storyline_planner').ok;
    const storylineRes = await runStorylinePlanner({
      state: workingState,
      ledger: workingLedger,
      beats: this.beats,
      gateway: this.gateway,
      useLlmPass: useStorylineLlm,
      recentExchangeText,
      signal: params.signal,
    });
    params.turnWarnings.push(...storylineRes.warnings);
    if (storylineRes.proposedBatch !== null && storylineRes.proposedBatch.operations.length > 0) {
      applyAgentBatch(storylineRes.proposedBatch, this.fullCompiledSchema);
    }

    const chronicleRes = await runChronicleRouter({
      state: workingState,
      config: this.config,
      turnContext,
      recentExchangeText,
      gateway: this.gateway,
      signal: params.signal,
    });
    params.turnWarnings.push(...chronicleRes.warnings);
    if (
      !chronicleRes.skippedByCadence &&
      chronicleRes.proposedBatch !== null &&
      chronicleRes.proposedBatch.operations.length > 0
    ) {
      applyAgentBatch(chronicleRes.proposedBatch, this.fullCompiledSchema);
    }

    const auditorRes = await runAuditorPass({
      state: workingState,
      formIndex: this.formIndex,
      gateway: this.gateway,
      useLlmPass: this.useBoundaryLlmAgents.auditor,
      llmCadenceTurns: this.auditorLlmCadenceTurns,
      recentExchangeText,
      signal: params.signal,
    });
    params.turnWarnings.push(...auditorRes.warnings);
    if (auditorRes.proposedBatch !== null && auditorRes.proposedBatch.operations.length > 0) {
      applyAgentBatch(auditorRes.proposedBatch, this.fullCompiledSchema);
    }
    if (auditorRes.findings.length > 0 || !auditorRes.skippedLlmByCadence) {
      this.eventBus.emit({
        type: 'auditor_completed',
        turn: workingState.meta.turn,
        findingsCount: auditorRes.findings.length,
        autoCorrectedCount: auditorRes.correctivePatches.length,
        skippedLlmByCadence: auditorRes.skippedLlmByCadence,
      });
    }

    return ok({
      workingState,
      workingLedger,
      workingAuditSeq,
      narratorText,
      compiledPrompt,
      trackerSkippedByCadence: trackerRes.skippedByCadence,
      postTurnChangedPaths,
    });
  }

  private async persistTurnToDisk(params: {
    readonly turn: number;
    readonly worldState: WorldState;
    readonly beatLedger: BeatLedgerState;
    readonly swipeTree: SwipeTreeState;
    readonly eventRecords: readonly EventLogRecord[];
    readonly auditEntries: readonly AuditEntry[];
  }): Promise<Result<void, ValidationError[]>> {
    if (this.saveDir === null) {
      return ok(undefined);
    }

    if (!this.saveInitialized) {
      const initRes = await initSaveDirectory(
        this.saveDir,
        {
          sessionId: this.sessionId,
          cartridgeId: this.cartridge?.card.id ?? 'freeform',
          systemPackId: this.config.packId,
          currentTurn: this.initialCheckpoint.turn,
        },
        {
          worldState: this.initialCheckpoint.worldState,
          beatLedger: this.initialCheckpoint.beatLedger,
          swipeTree: this.initialSwipeTree,
        }
      );
      if (!initRes.ok) {
        return err(initRes.error);
      }
      this.saveInitialized = true;
    }

    for (const record of params.eventRecords) {
      const evRes = await appendEventRecord(this.saveDir, record);
      if (!evRes.ok) {
        return evRes;
      }
    }

    if (params.auditEntries.length > 0) {
      const audRes = await appendAuditRecords(this.saveDir, params.auditEntries);
      if (!audRes.ok) {
        return audRes;
      }
    }

    const treeRes = await saveSwipeTreeAtomic(this.saveDir, params.swipeTree);
    if (!treeRes.ok) {
      return treeRes;
    }

    if (params.turn === 0 || params.turn % CHECKPOINT_INTERVAL === 0) {
      const cpRes = await saveCheckpointAtomic(
        this.saveDir,
        params.turn,
        params.worldState,
        serializeBeatLedger(params.beatLedger)
      );
      if (!cpRes.ok) {
        return err(cpRes.error);
      }
    }

    this.eventBus.emit({
      type: 'turn_saved',
      turn: params.turn,
      saveDir: this.saveDir,
    });

    return ok(undefined);
  }
}
