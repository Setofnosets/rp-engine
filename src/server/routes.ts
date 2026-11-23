import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  type ActiveAmbientEntry,
  type LiveNudgeEntry,
  buildBeatDependencyIndex,
  evaluateBeatGraph,
} from '../beats/beat-engine.js';
import { filterBeatsForActiveRoutes } from '../beats/routes-and-endings.js';
import {
  type CartridgeBundle,
  validateCartridgeStructure,
} from '../cartridge/cartridge-schema.js';
import { importMultihogCartridge } from '../cartridge/importers/multihog-importer.js';
import { importSillyTavernCard } from '../cartridge/importers/st-card-importer.js';
import { importSillyTavernPreset } from '../cartridge/importers/st-preset-importer.js';
import {
  exportToSillyTavernChatCompletionPreset,
  exportToSillyTavernTextCompletionPreset,
} from '../cartridge/exporters/st-preset-exporter.js';
import { parseAndValidateSystemPack } from '../cartridge/system-pack-schema.js';
import type { ProposedCombatAction } from '../combat/action-validator.js';
import {
  type ControlRoomLayer,
  type GameSystemModuleOverride,
  type PayloadGroupId,
  applySheetPreset,
  cloneCapabilitiesPartial,
  cloneCombatRulesPartial,
  cloneControlRoomLayer,
  cloneCustomPromptBlocks,
  cloneGameSystemModuleOverride,
  cloneGenerationPresetConfig,
  cloneResolvedControlRoomConfig,
  cloneTokenBudgetsPartial,
  cloneTuningDialsPartial,
} from '../config/control-room-config.js';
import {
  type UserPersonaPreset,
  cloneUserPersonaPreset,
  validateUserPersonaPreset,
} from '../config/persona-preset.js';
import { computeControlRoomDiffReport } from '../config/prompt-diff.js';
import {
  type CardPersonaInput,
  type InjectedScriptPrompt,
  compileNarratorPrompt,
} from '../context/prompt-compiler.js';
import type { SectionTokenBudgets } from '../context/tokenizer-budget.js';
import { RefereeError, type ValidationError, validationError } from '../core/errors.js';
import { ErrorAccumulator, type Result, err, ok } from '../core/result.js';
import {
  type ConnectionProfile,
  type ConnectionsFileDocument,
  activateNamedProfile,
  applyConnectionsFileToGateway,
  deleteNamedProfile,
  loadConnectionsFile,
  saveConnectionsFile,
  saveNamedProfile,
  snapshotGatewayToConnectionsDoc,
} from '../gateway/connection-store.js';
import { ModelGateway } from '../gateway/model-gateway.js';
import {
  AGENT_ROLES,
  type AgentRole,
  type ChatMessage,
  type GatewayGenerateTextRequest,
  type GatewayStructuredOutput,
  type GatewayStructuredRequest,
  PROVIDER_KINDS,
  type ProviderKind,
  type RoleConnectionConfig,
  type StreamChunk,
} from '../gateway/types.js';
import { type DirectorSteeringInput, applyDirectorSteering } from '../runtime/director-steering.js';
import { SessionRuntime, type StartCombatOptions } from '../runtime/session-runtime.js';
import { cloneCharacterSections } from '../schema/character-sections.js';
import { cloneSystemPack } from '../schema/dynamic-schema-compiler.js';
import {
  STOCK_FREEFORM_PACK,
  STOCK_SYSTEM_PACKS,
  getStockSystemPack,
} from '../schema/stock-system-packs.js';
import { type SystemPack, cloneGameSystemModule } from '../schema/tracker-module.js';
import { type AuditLogFilter, createAuditLog, queryAuditLog } from '../state/audit-log.js';
import { PATCH_SOURCES, type PatchSource } from '../state/patch.js';
import { branchSave, loadSessionSave } from '../state/persistence.js';
import { getLinearTranscript } from '../state/swipe-tree.js';
import { CHARACTER_STATUSES, type CharacterEntity, type CharacterStatus } from '../state/world-state.js';
import {
  RefereeDataStore,
  type SaveControlRoomPresetInput,
  type SavedControlRoomPreset,
  validateSafeStorageId,
} from '../storage/data-store.js';
import {
  GameSystemWizard,
  type WizardGenerateRequest,
} from '../wizard/game-system-wizard.js';
import type { SettingCharacterFilter } from '../world/character-inspector.js';
import { SessionSseHub } from './ws-stream.js';

const MAX_JSON_BODY_BYTES = 1_048_576; // 1 MB
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
const VALID_PATCH_SOURCES: ReadonlySet<string> = new Set(PATCH_SOURCES);
const VALID_PAYLOAD_GROUPS: ReadonlySet<string> = new Set([
  'capabilities',
  'characterSections',
  'gameSystems',
  'promptSections',
  'combatRules',
  'tuningDials',
  'generation',
]);
const VALID_AGENT_ROLES: ReadonlySet<string> = new Set(AGENT_ROLES);
const VALID_PROVIDER_KINDS: ReadonlySet<string> = new Set(PROVIDER_KINDS);
const VALID_CHARACTER_STATUSES: ReadonlySet<string> = new Set(CHARACTER_STATUSES);
const NUMERIC_SAMPLING_FIELDS = [
  'timeoutMs',
  'temperature',
  'maxTokens',
  'maxContextTokens',
  'topP',
  'topK',
  'minP',
  'topA',
  'typicalP',
  'tfs',
  'frequencyPenalty',
  'presencePenalty',
  'repetitionPenalty',
  'seed',
] as const;

function isSafeKey(key: string): boolean {
  return key.length > 0 && !FORBIDDEN_KEYS.has(key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

function getOwn(obj: Record<string, unknown>, key: string): unknown {
  if (!isSafeKey(key) || !Object.hasOwn(obj, key)) {
    return undefined;
  }
  return Object.getOwnPropertyDescriptor(obj, key)?.value;
}

function setOwn(obj: Record<string, unknown>, key: string, value: unknown): void {
  if (!isSafeKey(key)) {
    return;
  }
  Object.defineProperty(obj, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function compareStringsDeterministic(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function scanUnsafeKeys(value: unknown, acc: ErrorAccumulator): void {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      scanUnsafeKeys(value[i], acc.scope(`[${i}]`));
    }
    return;
  }
  if (value === null || typeof value !== 'object' || !isPlainObject(value)) {
    return;
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      acc.add(key, 'UNSAFE_PROPERTY_KEY', `Forbidden prototype property key "${key}"`);
      continue;
    }
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (desc !== undefined) {
      scanUnsafeKeys(desc.value, acc.scope(key));
    }
  }
}

function sanitizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeJsonValue);
  }
  if (value !== null && typeof value === 'object' && isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.getOwnPropertyNames(value)) {
      if (FORBIDDEN_KEYS.has(key)) {
        continue;
      }
      const desc = Object.getOwnPropertyDescriptor(value, key);
      if (desc !== undefined) {
        setOwn(out, key, sanitizeJsonValue(desc.value));
      }
    }
    return out;
  }
  return value;
}

/**
 * Per-session gateway wrapper allowing `POST /api/sessions/:id/post-narrate`
 * to inject an external SillyTavern narrator reply for a single serialized turn
 * without bypassing Referee's deterministic pipeline or post-turn tracker agents.
 */
class SessionBridgeGateway extends ModelGateway {
  private readonly inner: ModelGateway;
  private narratorOverride: string | null = null;

  constructor(inner: ModelGateway) {
    super();
    this.inner = inner;
  }

  setNarratorOverride(text: string | null): void {
    this.narratorOverride = text;
  }

  override resolveConnection(role: AgentRole): Result<RoleConnectionConfig, ValidationError[]> {
    return this.inner.resolveConnection(role);
  }

  override async generateText(
    req: GatewayGenerateTextRequest
  ): Promise<Result<string, ValidationError[]>> {
    if (req.role === 'narrator' && this.narratorOverride !== null) {
      return ok(this.narratorOverride);
    }
    return this.inner.generateText(req);
  }

  override async *streamText(
    req: GatewayGenerateTextRequest
  ): AsyncGenerator<Result<StreamChunk, ValidationError[]>> {
    if (req.role === 'narrator' && this.narratorOverride !== null) {
      yield ok({ text: this.narratorOverride, done: false });
      yield ok({ text: '', done: true });
      return;
    }
    yield* this.inner.streamText(req);
  }

  override async generateStructured<T>(
    req: GatewayStructuredRequest
  ): Promise<Result<GatewayStructuredOutput<T>, ValidationError[]>> {
    return this.inner.generateStructured<T>(req);
  }
}

interface SessionRecordMeta {
  cartridge: CartridgeBundle | null;
  basePack: SystemPack;
  bridgeGateway?: SessionBridgeGateway;
}

export interface DaemonRegistryOptions {
  readonly gateway?: ModelGateway;
  readonly sseHub?: SessionSseHub;
  readonly dataDir?: string;
  readonly connectionsPath?: string;
}

/**
 * Central in-memory registry for daemon sessions, system packs, cartridges,
 * presets, personas, model gateway, Game System Wizard, SSE hub, and per-session async mutexes.
 */
export class DaemonRegistry {
  readonly sessions = new Map<string, SessionRuntime>();
  readonly systemPacks = new Map<string, SystemPack>();
  readonly cartridges = new Map<string, CartridgeBundle>();
  readonly presets = new Map<string, SavedControlRoomPreset>();
  readonly personas = new Map<string, UserPersonaPreset>();
  readonly gateway: ModelGateway;
  readonly wizard: GameSystemWizard;
  readonly sseHub: SessionSseHub;
  readonly dataDir: string | undefined;
  readonly connectionsPath: string | undefined;
  readonly dataStore: RefereeDataStore | undefined;

  connectionsDoc: ConnectionsFileDocument = { version: 1 };

  private readonly sessionQueues = new Map<string, Promise<void>>();
  private readonly sessionMeta = new Map<string, SessionRecordMeta>();
  private sessionSeq = 0;
  private initialized = false;

  constructor(options: DaemonRegistryOptions = {}) {
    this.gateway = options.gateway ?? new ModelGateway();
    this.wizard = new GameSystemWizard(this.gateway);
    this.sseHub = options.sseHub ?? new SessionSseHub();
    this.dataDir = options.dataDir;
    this.connectionsPath = options.connectionsPath;
    if (this.dataDir !== undefined) {
      this.dataStore = new RefereeDataStore(this.dataDir);
    }

    for (const [packId, pack] of Object.entries(STOCK_SYSTEM_PACKS)) {
      if (isSafeKey(packId)) {
        this.systemPacks.set(packId, cloneSystemPack(pack));
      }
    }
  }

  /**
   * Initialize the underlying {@link RefereeDataStore} (when configured), load saved
   * connections, and hydrate presets, personas, custom system packs, and cartridges.
   */
  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    if (this.dataStore !== undefined) {
      const initRes = await this.dataStore.init();
      if (!initRes.ok) {
        throw new RefereeError('Failed to initialize RefereeDataStore', {
          code: 'DATA_STORE_INIT_FAILED',
          details: initRes.error,
        });
      }
    }

    const connRes =
      this.connectionsPath !== undefined
        ? await loadConnectionsFile(this.connectionsPath)
        : this.dataStore !== undefined
          ? await this.dataStore.loadConnections()
          : undefined;

    if (connRes !== undefined && connRes.ok) {
      this.connectionsDoc = connRes.value;
      const snap = this.gateway.getConnectionsSnapshot();
      const hasCallerConnections =
        snap.defaultConnection !== undefined || Object.keys(snap.connections).length > 0;
      if (!hasCallerConnections) {
        applyConnectionsFileToGateway(this.gateway, connRes.value);
      }
    }

    if (this.dataStore !== undefined) {
      const [presetsRes, personasRes, packsRes, cartsRes] = await Promise.all([
        this.dataStore.listPresets(),
        this.dataStore.listPersonas(),
        this.dataStore.listSystemPacks(),
        this.dataStore.listCartridges(),
      ]);

      for (const preset of presetsRes.items) {
        this.presets.set(preset.id, preset);
      }
      for (const persona of personasRes.items) {
        this.personas.set(persona.id, cloneUserPersonaPreset(persona));
      }
      for (const pack of packsRes.items) {
        this.systemPacks.set(pack.id, cloneSystemPack(pack));
      }
      for (const cart of cartsRes.items) {
        this.cartridges.set(cart.card.id, cart);
      }
    }

    this.initialized = true;
  }

  /**
   * Persist `this.connectionsDoc` to `connectionsPath` or `dataStore` when configured.
   */
  async persistConnectionsDoc(): Promise<Result<void, ValidationError[]>> {
    if (this.connectionsPath !== undefined) {
      return saveConnectionsFile(this.connectionsPath, this.connectionsDoc);
    }
    if (this.dataStore !== undefined) {
      return this.dataStore.saveConnections(this.connectionsDoc);
    }
    return ok();
  }

  /**
   * Allocate a deterministic, collision-free session identifier without `Math.random()`.
   */
  allocateSessionId(): string {
    while (true) {
      this.sessionSeq += 1;
      const candidate = `session-${this.sessionSeq}`;
      if (!this.sessions.has(candidate)) {
        return candidate;
      }
    }
  }

  /**
   * Register a pre-constructed {@link SessionRuntime} with the registry and SSE hub.
   */
  registerSession(
    runtime: SessionRuntime,
    meta?: { cartridge?: CartridgeBundle | null; basePack?: SystemPack; bridgeGateway?: SessionBridgeGateway }
  ): void {
    this.sessions.set(runtime.sessionId, runtime);
    this.sseHub.attachSession(runtime.sessionId, runtime.eventBus);
    const config = runtime.getConfig();
    const resolvedBasePack =
      meta?.basePack ??
      this.systemPacks.get(config.packId) ??
      getStockSystemPack(config.packId) ??
      cloneSystemPack(STOCK_FREEFORM_PACK);
    this.sessionMeta.set(runtime.sessionId, {
      cartridge: meta?.cartridge ?? null,
      basePack: cloneSystemPack(resolvedBasePack),
      ...(meta?.bridgeGateway !== undefined ? { bridgeGateway: meta.bridgeGateway } : {}),
    });
  }

  /**
   * Execute `task` under an exclusive FIFO async mutex for `sessionId`.
   */
  async withSessionLock<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.sessionQueues.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = previous.then(() => current);
    this.sessionQueues.set(sessionId, chained);

    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.sessionQueues.get(sessionId) === chained) {
        this.sessionQueues.delete(sessionId);
      }
    }
  }

  getSessionMeta(sessionId: string, runtime: SessionRuntime): SessionRecordMeta {
    const existing = this.sessionMeta.get(sessionId);
    if (existing !== undefined) {
      return existing;
    }
    const config = runtime.getConfig();
    const fallbackPack =
      this.systemPacks.get(config.packId) ??
      getStockSystemPack(config.packId) ??
      cloneSystemPack(STOCK_FREEFORM_PACK);
    const created: SessionRecordMeta = {
      cartridge: null,
      basePack: cloneSystemPack(fallbackPack),
    };
    this.sessionMeta.set(sessionId, created);
    return created;
  }
}

type ParsedBodyResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly status: number; readonly errors: ValidationError[] };

/**
 * Parse a JSON HTTP request body up to `maxBytes` (default 1 MB), rejecting
 * oversized payloads (`413`), malformed JSON (`400`), and prototype pollution keys (`400`).
 */
export async function readJsonBody(
  req: IncomingMessage,
  maxBytes = MAX_JSON_BODY_BYTES
): Promise<ParsedBodyResult> {
  return new Promise<ParsedBodyResult>((resolve) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    const finish = (result: ParsedBodyResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
      resolve(result);
    };

    const onData = (chunk: Buffer | string): void => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buf.length;
      if (totalBytes > maxBytes) {
        req.pause();
        finish({
          ok: false,
          status: 413,
          errors: [
            validationError(
              'body',
              'PAYLOAD_TOO_LARGE',
              `Request JSON body exceeds ${maxBytes} byte limit`
            ),
          ],
        });
        return;
      }
      chunks.push(buf);
    };

    const onEnd = (): void => {
      const rawText = Buffer.concat(chunks).toString('utf8').trim();
      if (rawText.length === 0) {
        finish({ ok: true, value: undefined });
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawText) as unknown;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Malformed JSON';
        finish({
          ok: false,
          status: 400,
          errors: [validationError('body', 'INVALID_JSON', `Invalid JSON body: ${message}`)],
        });
        return;
      }

      const acc = new ErrorAccumulator('body');
      scanUnsafeKeys(parsed, acc);
      if (acc.hasErrors()) {
        finish({ ok: false, status: 400, errors: [...acc.errors] });
        return;
      }

      finish({ ok: true, value: sanitizeJsonValue(parsed) });
    };

    const onError = (error: Error): void => {
      finish({
        ok: false,
        status: 400,
        errors: [validationError('body', 'STREAM_ERROR', error.message)],
      });
    };

    const onAborted = (): void => {
      finish({
        ok: false,
        status: 400,
        errors: [validationError('body', 'REQUEST_ABORTED', 'Request stream was aborted')],
      });
    };

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.writableEnded || res.destroyed) {
    return;
  }
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(body, 'utf8')),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });
  res.end(body);
}

function sendErrors(res: ServerResponse, status: number, errors: readonly ValidationError[]): void {
  sendJson(res, status, {
    ok: false,
    errors,
  });
}

function decodeSessionId(rawId: string): Result<string, ValidationError[]> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawId);
  } catch {
    return err([validationError('sessionId', 'INVALID_URI', 'Malformed session ID in path')]);
  }
  if (!isSafeKey(decoded) || decoded.trim().length === 0) {
    return err([
      validationError('sessionId', 'INVALID_SESSION_ID', `Invalid session ID "${decoded}"`),
    ]);
  }
  return ok(decoded);
}

function getSessionOrNotFound(
  registry: DaemonRegistry,
  rawSessionId: string,
  res: ServerResponse
): SessionRuntime | null {
  const idRes = decodeSessionId(rawSessionId);
  if (!idRes.ok) {
    sendErrors(res, 400, idRes.error);
    return null;
  }
  const runtime = registry.sessions.get(idRes.value);
  if (runtime === undefined) {
    sendErrors(res, 404, [
      validationError('sessionId', 'SESSION_NOT_FOUND', `Session "${idRes.value}" was not found`),
    ]);
    return null;
  }
  return runtime;
}

function mergeStringRecord(
  base: Record<string, string> | undefined,
  incoming: Record<string, string>
): Record<string, string> {
  const merged: Record<string, string> = {};
  if (base !== undefined) {
    for (const [k, v] of Object.entries(base)) {
      if (isSafeKey(k)) {
        setOwn(merged, k, v);
      }
    }
  }
  for (const [k, v] of Object.entries(incoming)) {
    if (isSafeKey(k)) {
      setOwn(merged, k, v);
    }
  }
  return merged;
}

function mergeBooleanRecord(
  base: Record<string, boolean> | undefined,
  incoming: Record<string, boolean>
): Record<string, boolean> {
  const merged: Record<string, boolean> = {};
  if (base !== undefined) {
    for (const [k, v] of Object.entries(base)) {
      if (isSafeKey(k)) {
        setOwn(merged, k, v);
      }
    }
  }
  for (const [k, v] of Object.entries(incoming)) {
    if (isSafeKey(k)) {
      setOwn(merged, k, v);
    }
  }
  return merged;
}

function mergeModuleOverride(
  existing: GameSystemModuleOverride | undefined,
  incoming: GameSystemModuleOverride
): GameSystemModuleOverride {
  if (existing === undefined) {
    return cloneGameSystemModuleOverride(incoming);
  }
  const merged = cloneGameSystemModuleOverride(existing);
  const patch = cloneGameSystemModuleOverride(incoming);
  if (patch.name !== undefined) merged.name = patch.name;
  if (patch.description !== undefined) merged.description = patch.description;
  if (patch.enabled !== undefined) merged.enabled = patch.enabled;
  if (patch.scope !== undefined) merged.scope = patch.scope;
  if (patch.target !== undefined) merged.target = patch.target;
  if (patch.effectOwner !== undefined) merged.effectOwner = patch.effectOwner;
  if (patch.cadence !== undefined) merged.cadence = patch.cadence;
  if (patch.fields !== undefined) {
    merged.fields = { ...(merged.fields ?? {}), ...patch.fields };
  }
  if (patch.fieldConfirmPolicies !== undefined) {
    merged.fieldConfirmPolicies = {
      ...(merged.fieldConfirmPolicies ?? {}),
      ...patch.fieldConfirmPolicies,
    };
  }
  if (patch.trackerInstruction !== undefined) merged.trackerInstruction = patch.trackerInstruction;
  if (patch.narratorRule !== undefined) merged.narratorRule = patch.narratorRule;
  if (patch.ui !== undefined) {
    merged.ui = { ...(merged.ui ?? {}), ...patch.ui };
  }
  if (patch.createIfMissing !== undefined) merged.createIfMissing = patch.createIfMissing;
  return merged;
}

function mergeControlRoomLayers(
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
        ? {
            pc: {
              ...(next.sectionConfirmPolicies?.pc ?? {}),
              ...incoming.sectionConfirmPolicies.pc,
            },
          }
        : {}),
      ...(incoming.sectionConfirmPolicies.npc !== undefined
        ? {
            npc: {
              ...(next.sectionConfirmPolicies?.npc ?? {}),
              ...incoming.sectionConfirmPolicies.npc,
            },
          }
        : {}),
    };
  }
  if (incoming.gameSystems !== undefined) {
    next.gameSystems = incoming.gameSystems.map(cloneGameSystemModule);
  }
  if (incoming.gameSystemOverrides !== undefined) {
    const mergedOverrides: Record<string, GameSystemModuleOverride> = {};
    if (next.gameSystemOverrides !== undefined) {
      for (const [k, v] of Object.entries(next.gameSystemOverrides)) {
        if (isSafeKey(k)) {
          setOwn(mergedOverrides, k, cloneGameSystemModuleOverride(v));
        }
      }
    }
    for (const [moduleId, modOverride] of Object.entries(incoming.gameSystemOverrides)) {
      if (isSafeKey(moduleId)) {
        const prev = getOwn(mergedOverrides, moduleId) as GameSystemModuleOverride | undefined;
        setOwn(mergedOverrides, moduleId, mergeModuleOverride(prev, modOverride));
      }
    }
    next.gameSystemOverrides = mergedOverrides;
  }
  if (incoming.blockOrder !== undefined) {
    next.blockOrder = [...incoming.blockOrder];
  }
  if (incoming.syspromptSectionOrder !== undefined) {
    next.syspromptSectionOrder = [...incoming.syspromptSectionOrder];
  }
  if (incoming.basePrompts !== undefined) {
    next.basePrompts = mergeStringRecord(next.basePrompts, incoming.basePrompts);
  }
  if (incoming.unlockedPromptSections !== undefined) {
    next.unlockedPromptSections = mergeBooleanRecord(
      next.unlockedPromptSections,
      incoming.unlockedPromptSections
    );
  }
  if (incoming.customPromptBlocks !== undefined) {
    next.customPromptBlocks = cloneCustomPromptBlocks(incoming.customPromptBlocks);
  }
  if (incoming.combatRules !== undefined) {
    const patchRules = cloneCombatRulesPartial(incoming.combatRules);
    next.combatRules = {
      ...(next.combatRules ?? {}),
      ...patchRules,
      ...(patchRules.customRules !== undefined
        ? {
            customRules: mergeStringRecord(next.combatRules?.customRules, patchRules.customRules),
          }
        : {}),
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
      ...(incoming.generation.stFormatTemplates !== undefined || next.generation?.stFormatTemplates !== undefined
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

function stripDataUriBase64Prefix(raw: string): string {
  const trimmed = raw.trim();
  const commaIdx = trimmed.indexOf(',');
  if (trimmed.startsWith('data:') && commaIdx !== -1) {
    return trimmed.slice(commaIdx + 1).trim();
  }
  return trimmed;
}

function isMultihogPayload(body: Record<string, unknown>): boolean {
  const format = getOwn(body, 'format');
  const type = getOwn(body, 'type');
  if (format === 'multihog-game-cartridge' || type === 'multihog') {
    return true;
  }
  if (isPlainObject(getOwn(body, 'multihog'))) {
    return true;
  }
  const hasStCardMarkers =
    getOwn(body, 'spec') === 'chara_card_v2' ||
    getOwn(body, 'spec') === 'chara_card_v3' ||
    getOwn(body, 'first_mes') !== undefined ||
    getOwn(body, 'card') !== undefined ||
    getOwn(body, 'stCard') !== undefined ||
    getOwn(body, 'pngBase64') !== undefined ||
    getOwn(body, 'base64') !== undefined;
  if (hasStCardMarkers) {
    return false;
  }
  return (
    isPlainObject(getOwn(body, 'payload')) ||
    Array.isArray(getOwn(body, 'gameSystems')) ||
    isPlainObject(getOwn(body, 'customFields'))
  );
}

async function handleSystemPacksPost(
  registry: DaemonRegistry,
  body: unknown,
  res: ServerResponse
): Promise<void> {
  if (!isPlainObject(body)) {
    sendErrors(res, 400, [
      validationError('body', 'INVALID_TYPE', 'Request body must be a SystemPack JSON object'),
    ]);
    return;
  }
  const candidate = isPlainObject(getOwn(body, 'systemPack')) ? getOwn(body, 'systemPack') : body;
  const parsed = parseAndValidateSystemPack(candidate);
  if (!parsed.ok) {
    sendErrors(res, 400, parsed.error);
    return;
  }
  let stored = cloneSystemPack(parsed.value);
  if (registry.dataStore !== undefined) {
    const saveRes = await registry.dataStore.saveSystemPack(stored);
    if (!saveRes.ok) {
      sendErrors(res, 400, saveRes.error);
      return;
    }
    stored = cloneSystemPack(saveRes.value);
  }
  registry.systemPacks.set(stored.id, stored);
  sendJson(res, 201, {
    ok: true,
    systemPack: cloneSystemPack(stored),
  });
}

async function persistCartridgeIfConfigured(
  registry: DaemonRegistry,
  bundle: CartridgeBundle
): Promise<Result<CartridgeBundle, ValidationError[]>> {
  if (registry.dataStore === undefined) {
    return ok(bundle);
  }
  return registry.dataStore.saveCartridgeBundle(bundle);
}

async function handleCartridgeImport(
  registry: DaemonRegistry,
  body: unknown,
  res: ServerResponse
): Promise<void> {
  if (typeof body === 'string') {
    const stRes = importSillyTavernCard(body);
    if (!stRes.ok) {
      sendErrors(res, 400, stRes.error);
      return;
    }
    const saveRes = await persistCartridgeIfConfigured(registry, stRes.value);
    if (!saveRes.ok) {
      sendErrors(res, 400, saveRes.error);
      return;
    }
    registry.cartridges.set(saveRes.value.card.id, saveRes.value);
    sendJson(res, 201, {
      ok: true,
      kind: 'st_card',
      cartridgeId: saveRes.value.card.id,
      cartridge: saveRes.value,
    });
    return;
  }

  if (!isPlainObject(body)) {
    sendErrors(res, 400, [
      validationError('body', 'INVALID_TYPE', 'Cartridge import body must be a JSON object or string'),
    ]);
    return;
  }

  const recommendedSystemPackRaw =
    getOwn(body, 'recommendedSystemPack') ?? getOwn(body, 'systemPackId');
  const recommendedSystemPack =
    typeof recommendedSystemPackRaw === 'string' && recommendedSystemPackRaw.trim().length > 0
      ? recommendedSystemPackRaw.trim()
      : undefined;

  if (isMultihogPayload(body)) {
    const multihogInput = isPlainObject(getOwn(body, 'multihog')) ? getOwn(body, 'multihog') : body;
    const explicitId = typeof getOwn(body, 'id') === 'string' ? (getOwn(body, 'id') as string) : undefined;
    const explicitName =
      typeof getOwn(body, 'name') === 'string' ? (getOwn(body, 'name') as string) : undefined;

    const multihogRes = importMultihogCartridge(multihogInput, {
      ...(explicitId !== undefined ? { id: explicitId } : {}),
      ...(explicitName !== undefined ? { name: explicitName } : {}),
    });
    if (!multihogRes.ok) {
      sendErrors(res, 400, multihogRes.error);
      return;
    }

    const { systemPack, combatOverrides, warnings } = multihogRes.value;
    let storedPack = cloneSystemPack(systemPack);
    if (registry.dataStore !== undefined) {
      const packSaveRes = await registry.dataStore.saveSystemPack(storedPack);
      if (!packSaveRes.ok) {
        sendErrors(res, 400, packSaveRes.error);
        return;
      }
      storedPack = cloneSystemPack(packSaveRes.value);
    }
    registry.systemPacks.set(storedPack.id, storedPack);

    const bundleCandidate: CartridgeBundle = {
      rootDir: null,
      card: {
        spec: 'cartridge/0.1',
        id: storedPack.id,
        version: '1.0.0',
        title: storedPack.name,
        description: storedPack.description,
        recommendedSystemPack: storedPack.id,
        persona: {
          name: storedPack.name,
          description: storedPack.description,
        },
      },
      ...(combatOverrides !== undefined ? { combat: combatOverrides } : {}),
      beats: [],
      routes: [],
      endings: [],
      loreFiles: {},
      endingPromptFiles: {},
      scriptFiles: {},
    };
    const validatedBundle = validateCartridgeStructure(bundleCandidate);
    if (!validatedBundle.ok) {
      sendErrors(res, 400, validatedBundle.error);
      return;
    }
    const cartSaveRes = await persistCartridgeIfConfigured(registry, validatedBundle.value);
    if (!cartSaveRes.ok) {
      sendErrors(res, 400, cartSaveRes.error);
      return;
    }
    registry.cartridges.set(cartSaveRes.value.card.id, cartSaveRes.value);

    sendJson(res, 201, {
      ok: true,
      kind: 'multihog',
      systemPack: cloneSystemPack(storedPack),
      cartridgeId: cartSaveRes.value.card.id,
      cartridge: cartSaveRes.value,
      warnings,
    });
    return;
  }

  // Native cartridge/0.1 bundle
  const maybeCard = getOwn(body, 'card');
  if (isPlainObject(maybeCard) && getOwn(maybeCard, 'spec') === 'cartridge/0.1') {
    const validated = validateCartridgeStructure(body as unknown as CartridgeBundle);
    if (!validated.ok) {
      sendErrors(res, 400, validated.error);
      return;
    }
    const cartSaveRes = await persistCartridgeIfConfigured(registry, validated.value);
    if (!cartSaveRes.ok) {
      sendErrors(res, 400, cartSaveRes.error);
      return;
    }
    registry.cartridges.set(cartSaveRes.value.card.id, cartSaveRes.value);
    sendJson(res, 201, {
      ok: true,
      kind: 'cartridge',
      cartridgeId: cartSaveRes.value.card.id,
      cartridge: cartSaveRes.value,
    });
    return;
  }

  // Base64 PNG payload
  const pngBase64Raw = getOwn(body, 'pngBase64') ?? getOwn(body, 'base64');
  const pngTypeData = getOwn(body, 'type') === 'png' ? getOwn(body, 'data') : undefined;
  const base64Str = typeof pngBase64Raw === 'string' ? pngBase64Raw : typeof pngTypeData === 'string' ? pngTypeData : undefined;
  if (base64Str !== undefined) {
    const cleanB64 = stripDataUriBase64Prefix(base64Str);
    const buf = Buffer.from(cleanB64, 'base64');
    const stRes = importSillyTavernCard(buf, {
      ...(recommendedSystemPack !== undefined ? { recommendedSystemPack } : {}),
    });
    if (!stRes.ok) {
      sendErrors(res, 400, stRes.error);
      return;
    }
    const cartSaveRes = await persistCartridgeIfConfigured(registry, stRes.value);
    if (!cartSaveRes.ok) {
      sendErrors(res, 400, cartSaveRes.error);
      return;
    }
    registry.cartridges.set(cartSaveRes.value.card.id, cartSaveRes.value);
    sendJson(res, 201, {
      ok: true,
      kind: 'st_card',
      cartridgeId: cartSaveRes.value.card.id,
      cartridge: cartSaveRes.value,
    });
    return;
  }

  // SillyTavern JSON card payload (wrapped or direct)
  const stCandidate =
    getOwn(body, 'card') ??
    getOwn(body, 'stCard') ??
    getOwn(body, 'json') ??
    getOwn(body, 'rawText') ??
    body;

  const stInput: string | Record<string, unknown> | null =
    typeof stCandidate === 'string'
      ? stCandidate
      : isPlainObject(stCandidate)
        ? stCandidate
        : null;

  if (stInput === null) {
    sendErrors(res, 400, [
      validationError(
        'body',
        'INVALID_TYPE',
        'Cartridge import payload must be a SillyTavern JSON card, base64 PNG, or Multihog payload'
      ),
    ]);
    return;
  }

  const stRes = importSillyTavernCard(stInput, {
    ...(recommendedSystemPack !== undefined ? { recommendedSystemPack } : {}),
  });
  if (!stRes.ok) {
    sendErrors(res, 400, stRes.error);
    return;
  }

  const cartSaveRes = await persistCartridgeIfConfigured(registry, stRes.value);
  if (!cartSaveRes.ok) {
    sendErrors(res, 400, cartSaveRes.error);
    return;
  }
  registry.cartridges.set(cartSaveRes.value.card.id, cartSaveRes.value);
  sendJson(res, 201, {
    ok: true,
    kind: 'st_card',
    cartridgeId: cartSaveRes.value.card.id,
    cartridge: cartSaveRes.value,
  });
}

async function handleCreateSession(
  registry: DaemonRegistry,
  body: unknown,
  res: ServerResponse
): Promise<void> {
  if (body !== undefined && !isPlainObject(body)) {
    sendErrors(res, 400, [
      validationError('body', 'INVALID_TYPE', 'Session creation payload must be a plain object'),
    ]);
    return;
  }
  const payload = body ?? {};

  const rawSessionId = getOwn(payload, 'sessionId');
  let sessionId: string;
  if (rawSessionId !== undefined) {
    if (typeof rawSessionId !== 'string' || !isSafeKey(rawSessionId) || rawSessionId.trim().length === 0) {
      sendErrors(res, 400, [
        validationError('sessionId', 'INVALID_SESSION_ID', 'sessionId must be a safe non-empty string'),
      ]);
      return;
    }
    sessionId = rawSessionId.trim();
    if (registry.sessions.has(sessionId)) {
      sendErrors(res, 409, [
        validationError('sessionId', 'SESSION_EXISTS', `Session "${sessionId}" already exists`),
      ]);
      return;
    }
  } else {
    sessionId = registry.allocateSessionId();
  }

  let cartridge: CartridgeBundle | null = null;
  const cartridgeIdRaw = getOwn(payload, 'cartridgeId');
  if (cartridgeIdRaw !== undefined && cartridgeIdRaw !== null) {
    if (typeof cartridgeIdRaw !== 'string' || !isSafeKey(cartridgeIdRaw)) {
      sendErrors(res, 400, [
        validationError('cartridgeId', 'INVALID_TYPE', 'cartridgeId must be a non-empty string'),
      ]);
      return;
    }
    const found = registry.cartridges.get(cartridgeIdRaw);
    if (found === undefined) {
      sendErrors(res, 404, [
        validationError('cartridgeId', 'CARTRIDGE_NOT_FOUND', `Cartridge "${cartridgeIdRaw}" was not found`),
      ]);
      return;
    }
    cartridge = found;
  }

  let systemPack: SystemPack | undefined;
  const systemPackIdRaw = getOwn(payload, 'systemPackId');
  if (systemPackIdRaw !== undefined && systemPackIdRaw !== null) {
    if (typeof systemPackIdRaw !== 'string' || !isSafeKey(systemPackIdRaw)) {
      sendErrors(res, 400, [
        validationError('systemPackId', 'INVALID_TYPE', 'systemPackId must be a non-empty string'),
      ]);
      return;
    }
    const foundPack = registry.systemPacks.get(systemPackIdRaw) ?? getStockSystemPack(systemPackIdRaw);
    if (foundPack === undefined) {
      sendErrors(res, 404, [
        validationError('systemPackId', 'SYSTEM_PACK_NOT_FOUND', `SystemPack "${systemPackIdRaw}" was not found`),
      ]);
      return;
    }
    systemPack = cloneSystemPack(foundPack);
  } else if (cartridge !== null && cartridge.card.recommendedSystemPack !== undefined) {
    const recId = cartridge.card.recommendedSystemPack;
    const customPack = registry.systemPacks.get(recId);
    if (customPack !== undefined) {
      systemPack = cloneSystemPack(customPack);
    }
  }

  const seedRaw = getOwn(payload, 'seed');
  let seed: string | number | undefined;
  if (seedRaw !== undefined) {
    if (typeof seedRaw === 'string' || (typeof seedRaw === 'number' && Number.isFinite(seedRaw))) {
      seed = seedRaw;
    } else {
      sendErrors(res, 400, [
        validationError('seed', 'INVALID_TYPE', 'seed must be a string or finite number'),
      ]);
      return;
    }
  }

  const saveDirRaw = getOwn(payload, 'saveDir');
  let saveDir: string | null | undefined;
  if (saveDirRaw !== undefined) {
    if (saveDirRaw === null || typeof saveDirRaw === 'string') {
      saveDir = saveDirRaw;
    } else {
      sendErrors(res, 400, [
        validationError('saveDir', 'INVALID_TYPE', 'saveDir must be a string or null'),
      ]);
      return;
    }
  } else if (registry.dataStore !== undefined) {
    const saveDirRes = registry.dataStore.getSessionSaveDir(sessionId);
    if (!saveDirRes.ok) {
      sendErrors(res, 400, saveDirRes.error);
      return;
    }
    saveDir = saveDirRes.value;
  }

  let userPersona: UserPersonaPreset | undefined;
  const personaIdRaw = getOwn(payload, 'personaId');
  const personaRaw = getOwn(payload, 'persona');
  if (personaIdRaw !== undefined && personaIdRaw !== null) {
    if (typeof personaIdRaw !== 'string' || !isSafeKey(personaIdRaw)) {
      sendErrors(res, 400, [
        validationError('personaId', 'INVALID_TYPE', 'personaId must be a non-empty string'),
      ]);
      return;
    }
    const foundPersona = registry.personas.get(personaIdRaw);
    if (foundPersona === undefined) {
      sendErrors(res, 404, [
        validationError('personaId', 'PERSONA_NOT_FOUND', `Persona "${personaIdRaw}" was not found`),
      ]);
      return;
    }
    userPersona = cloneUserPersonaPreset(foundPersona);
  } else if (personaRaw !== undefined && personaRaw !== null) {
    const personaRes = validateUserPersonaPreset(personaRaw);
    if (!personaRes.ok) {
      sendErrors(res, 400, personaRes.error);
      return;
    }
    userPersona = personaRes.value;
  }

  const layerRaw = getOwn(payload, 'userControlRoomLayer');
  let userControlRoomLayer: ControlRoomLayer | undefined;
  if (layerRaw !== undefined) {
    if (!isPlainObject(layerRaw)) {
      sendErrors(res, 400, [
        validationError('userControlRoomLayer', 'INVALID_TYPE', 'userControlRoomLayer must be an object'),
      ]);
      return;
    }
    userControlRoomLayer = cloneControlRoomLayer(layerRaw as ControlRoomLayer);
  }

  const boundaryRaw = getOwn(payload, 'useBoundaryLlmAgents');
  let useBoundaryLlmAgents:
    | { intentParser?: boolean; castDirector?: boolean; storylinePlanner?: boolean }
    | undefined;
  if (boundaryRaw !== undefined) {
    if (!isPlainObject(boundaryRaw)) {
      sendErrors(res, 400, [
        validationError('useBoundaryLlmAgents', 'INVALID_TYPE', 'useBoundaryLlmAgents must be an object'),
      ]);
      return;
    }
    useBoundaryLlmAgents = {
      intentParser: getOwn(boundaryRaw, 'intentParser') === true,
      castDirector: getOwn(boundaryRaw, 'castDirector') === true,
      storylinePlanner: getOwn(boundaryRaw, 'storylinePlanner') === true,
    };
  }

  const bridgeGateway = new SessionBridgeGateway(registry.gateway);

  let runtime: SessionRuntime;
  try {
    runtime = new SessionRuntime({
      sessionId,
      cartridge,
      ...(systemPack !== undefined ? { systemPack } : {}),
      ...(userControlRoomLayer !== undefined ? { userControlRoomLayer } : {}),
      ...(userPersona !== undefined ? { userPersona } : {}),
      gateway: bridgeGateway,
      ...(seed !== undefined ? { seed } : {}),
      ...(saveDir !== undefined ? { saveDir } : {}),
      ...(useBoundaryLlmAgents !== undefined ? { useBoundaryLlmAgents } : {}),
    });
  } catch (caught) {
    if (caught instanceof RefereeError && Array.isArray(caught.details)) {
      sendErrors(res, 400, caught.details as ValidationError[]);
      return;
    }
    const message = caught instanceof Error ? caught.message : 'Failed to create session';
    sendErrors(res, 400, [validationError('session', 'SESSION_INIT_FAILED', message)]);
    return;
  }

  const resolvedConfig = runtime.getConfig();
  const basePack =
    systemPack ??
    registry.systemPacks.get(resolvedConfig.packId) ??
    getStockSystemPack(resolvedConfig.packId) ??
    cloneSystemPack(STOCK_FREEFORM_PACK);

  registry.registerSession(runtime, {
    cartridge,
    basePack,
    bridgeGateway,
  });

  sendJson(res, 201, {
    ok: true,
    sessionId: runtime.sessionId,
    state: runtime.getState(),
    config: resolvedConfig,
    beatLedger: runtime.getBeatLedger(),
    combatState: runtime.getCombatState(),
    swipeTree: runtime.getSwipeTree(),
  });
}

async function handleGetSessionState(
  registry: DaemonRegistry,
  runtime: SessionRuntime,
  res: ServerResponse
): Promise<void> {
  await registry.withSessionLock(runtime.sessionId, async () => {
    const config = runtime.getConfig();
    const meta = registry.getSessionMeta(runtime.sessionId, runtime);
    const diffReport = computeControlRoomDiffReport(
      config,
      meta.basePack,
      meta.cartridge?.systemOverrides
    );

    sendJson(res, 200, {
      ok: true,
      sessionId: runtime.sessionId,
      state: runtime.getState(),
      beatLedger: runtime.getBeatLedger(),
      combatState: runtime.getCombatState(),
      config,
      pendingConfirmations: runtime.getPendingConfirmations(),
      diffReport,
      swipeTree: runtime.getSwipeTree(),
    });
  });
}

async function handlePatchControlRoom(
  registry: DaemonRegistry,
  runtime: SessionRuntime,
  body: unknown,
  res: ServerResponse
): Promise<void> {
  if (!isPlainObject(body)) {
    sendErrors(res, 400, [
      validationError('body', 'INVALID_TYPE', 'Control room patch body must be a JSON object'),
    ]);
    return;
  }

  await registry.withSessionLock(runtime.sessionId, async () => {
    const meta = registry.getSessionMeta(runtime.sessionId, runtime);

    const selectedGroupsRaw = getOwn(body, 'selectedGroups');
    let selectedGroups: PayloadGroupId[] | undefined;
    if (selectedGroupsRaw !== undefined) {
      if (!Array.isArray(selectedGroupsRaw)) {
        sendErrors(res, 400, [
          validationError('selectedGroups', 'INVALID_TYPE', 'selectedGroups must be an array'),
        ]);
        return;
      }
      const parsedGroups: PayloadGroupId[] = [];
      for (let i = 0; i < selectedGroupsRaw.length; i += 1) {
        const g = selectedGroupsRaw[i];
        if (typeof g !== 'string' || !VALID_PAYLOAD_GROUPS.has(g)) {
          sendErrors(res, 400, [
            validationError(
              `selectedGroups[${i}]`,
              'INVALID_PAYLOAD_GROUP',
              `Invalid payload group "${String(g)}"`
            ),
          ]);
          return;
        }
        parsedGroups.push(g as PayloadGroupId);
      }
      selectedGroups = parsedGroups;
    }

    const systemPackIdRaw = getOwn(body, 'systemPackId');
    const systemPackRaw = getOwn(body, 'systemPack');

    if (systemPackIdRaw !== undefined || systemPackRaw !== undefined) {
      let targetPack: SystemPack | undefined;
      if (systemPackIdRaw !== undefined) {
        if (typeof systemPackIdRaw !== 'string' || !isSafeKey(systemPackIdRaw)) {
          sendErrors(res, 400, [
            validationError('systemPackId', 'INVALID_TYPE', 'systemPackId must be a non-empty string'),
          ]);
          return;
        }
        const found =
          registry.systemPacks.get(systemPackIdRaw) ?? getStockSystemPack(systemPackIdRaw);
        if (found === undefined) {
          sendErrors(res, 404, [
            validationError(
              'systemPackId',
              'SYSTEM_PACK_NOT_FOUND',
              `SystemPack "${systemPackIdRaw}" was not found`
            ),
          ]);
          return;
        }
        targetPack = cloneSystemPack(found);
      } else if (isPlainObject(systemPackRaw)) {
        const packRes = parseAndValidateSystemPack(systemPackRaw);
        if (!packRes.ok) {
          sendErrors(res, 400, packRes.error);
          return;
        }
        targetPack = packRes.value;
      } else {
        sendErrors(res, 400, [
          validationError('systemPack', 'INVALID_TYPE', 'systemPack must be a plain object'),
        ]);
        return;
      }

      const switchRes = runtime.switchSystemPack(targetPack, selectedGroups);
      if (!switchRes.ok) {
        sendErrors(res, 400, switchRes.error);
        return;
      }
      if (selectedGroups === undefined) {
        meta.basePack = cloneSystemPack(targetPack);
      }

      const diffReport = computeControlRoomDiffReport(
        switchRes.value,
        meta.basePack,
        meta.cartridge?.systemOverrides
      );
      sendJson(res, 200, {
        ok: true,
        config: switchRes.value,
        state: runtime.getState(),
        diffReport,
      });
      return;
    }

    const replace = getOwn(body, 'replace') === true;
    const rawLayerCandidate = getOwn(body, 'layer') ?? getOwn(body, 'userControlRoomLayer') ?? body;
    if (!isPlainObject(rawLayerCandidate)) {
      sendErrors(res, 400, [
        validationError('layer', 'INVALID_TYPE', 'Control room layer must be a plain object'),
      ]);
      return;
    }

    const incomingLayer = cloneControlRoomLayer(rawLayerCandidate as ControlRoomLayer);
    const updateRes = runtime.updateControlRoom((currentLayer) =>
      replace ? incomingLayer : mergeControlRoomLayers(currentLayer, incomingLayer)
    );
    if (!updateRes.ok) {
      sendErrors(res, 400, updateRes.error);
      return;
    }

    const diffReport = computeControlRoomDiffReport(
      updateRes.value,
      meta.basePack,
      meta.cartridge?.systemOverrides
    );
    sendJson(res, 200, {
      ok: true,
      config: updateRes.value,
      state: runtime.getState(),
      diffReport,
    });
  });
}

async function handleWizardGenerate(
  registry: DaemonRegistry,
  body: unknown,
  res: ServerResponse
): Promise<void> {
  if (!isPlainObject(body)) {
    sendErrors(res, 400, [
      validationError('body', 'INVALID_TYPE', 'Wizard generate payload must be a JSON object'),
    ]);
    return;
  }

  const descriptionRaw = getOwn(body, 'description');
  const previousDraftRaw = getOwn(body, 'previousDraft');
  if (typeof descriptionRaw !== 'string' && previousDraftRaw === undefined) {
    sendErrors(res, 400, [
      validationError(
        'description',
        'REQUIRED',
        'description must be a string when previousDraft is omitted'
      ),
    ]);
    return;
  }

  const req: WizardGenerateRequest = {
    description: typeof descriptionRaw === 'string' ? descriptionRaw : '',
    ...(typeof getOwn(body, 'effectOwner') === 'string'
      ? { effectOwner: getOwn(body, 'effectOwner') as WizardGenerateRequest['effectOwner'] }
      : {}),
    ...(typeof getOwn(body, 'target') === 'string'
      ? { target: getOwn(body, 'target') as WizardGenerateRequest['target'] }
      : {}),
    ...(typeof getOwn(body, 'loreContext') === 'string'
      ? { loreContext: getOwn(body, 'loreContext') as string }
      : {}),
    ...(isPlainObject(previousDraftRaw)
      ? { previousDraft: previousDraftRaw as unknown as WizardGenerateRequest['previousDraft'] }
      : {}),
    ...(typeof getOwn(body, 'refinementFeedback') === 'string'
      ? { refinementFeedback: getOwn(body, 'refinementFeedback') as string }
      : {}),
    ...(typeof getOwn(body, 'customSystemPrompt') === 'string'
      ? { customSystemPrompt: getOwn(body, 'customSystemPrompt') as string }
      : {}),
  };

  const genRes = await registry.wizard.generateSystem(req);
  if (!genRes.ok) {
    sendErrors(res, 400, genRes.error);
    return;
  }

  sendJson(res, 200, {
    ok: true,
    module: genRes.value.module,
    clockTriggers: genRes.value.clockTriggers,
    suggestedBeats: genRes.value.suggestedBeats,
    previewCard: genRes.value.previewCard,
    previewSummary: registry.wizard.renderPreviewSummary(genRes.value),
    rawText: genRes.value.rawText,
  });
}

async function handleExecuteTurn(
  registry: DaemonRegistry,
  runtime: SessionRuntime,
  body: unknown,
  res: ServerResponse
): Promise<void> {
  if (!isPlainObject(body)) {
    sendErrors(res, 400, [
      validationError('body', 'INVALID_TYPE', 'Turn payload must be a JSON object'),
    ]);
    return;
  }

  const text = getOwn(body, 'text');
  if (typeof text !== 'string') {
    sendErrors(res, 400, [validationError('text', 'INVALID_TYPE', 'text must be a string')]);
    return;
  }

  const combatActionsRaw = getOwn(body, 'combatActions');
  if (combatActionsRaw !== undefined && !Array.isArray(combatActionsRaw)) {
    sendErrors(res, 400, [
      validationError('combatActions', 'INVALID_TYPE', 'combatActions must be an array'),
    ]);
    return;
  }

  const steeringRaw = getOwn(body, 'directorSteering');
  if (steeringRaw !== undefined && !isPlainObject(steeringRaw)) {
    sendErrors(res, 400, [
      validationError('directorSteering', 'INVALID_TYPE', 'directorSteering must be an object'),
    ]);
    return;
  }

  const streamNarrator = getOwn(body, 'streamNarrator') === true;

  await registry.withSessionLock(runtime.sessionId, async () => {
    const turnRes = await runtime.executeTurn({
      text,
      ...(combatActionsRaw !== undefined
        ? { combatActions: combatActionsRaw as readonly ProposedCombatAction[] }
        : {}),
      ...(steeringRaw !== undefined
        ? { directorSteering: steeringRaw as unknown as DirectorSteeringInput }
        : {}),
      streamNarrator,
    });

    if (!turnRes.ok) {
      sendErrors(res, 400, turnRes.error);
      return;
    }

    sendJson(res, 200, {
      ok: true,
      ...turnRes.value,
    });
  });
}

async function handleSwipe(
  registry: DaemonRegistry,
  runtime: SessionRuntime,
  body: unknown,
  res: ServerResponse
): Promise<void> {
  if (!isPlainObject(body)) {
    sendErrors(res, 400, [
      validationError('body', 'INVALID_TYPE', 'Swipe payload must be a JSON object'),
    ]);
    return;
  }

  const action = getOwn(body, 'action');
  const assistantMessageId = getOwn(body, 'assistantMessageId');
  if (typeof assistantMessageId !== 'string' || assistantMessageId.trim().length === 0) {
    sendErrors(res, 400, [
      validationError('assistantMessageId', 'REQUIRED', 'assistantMessageId must be a non-empty string'),
    ]);
    return;
  }

  if (action === 'regenerate') {
    const steeringRaw = getOwn(body, 'directorSteering');
    if (steeringRaw !== undefined && !isPlainObject(steeringRaw)) {
      sendErrors(res, 400, [
        validationError('directorSteering', 'INVALID_TYPE', 'directorSteering must be an object'),
      ]);
      return;
    }
    const streamNarrator = getOwn(body, 'streamNarrator') === true;

    await registry.withSessionLock(runtime.sessionId, async () => {
      const regenRes = await runtime.regenerateTurn(assistantMessageId, {
        ...(steeringRaw !== undefined
          ? { directorSteering: steeringRaw as unknown as DirectorSteeringInput }
          : {}),
        streamNarrator,
      });
      if (!regenRes.ok) {
        sendErrors(res, 400, regenRes.error);
        return;
      }
      sendJson(res, 200, {
        ok: true,
        action: 'regenerate',
        ...regenRes.value,
      });
    });
    return;
  }

  if (action === 'switch') {
    const swipeIndex = getOwn(body, 'swipeIndex');
    if (typeof swipeIndex !== 'number' || !Number.isInteger(swipeIndex) || swipeIndex < 0) {
      sendErrors(res, 400, [
        validationError('swipeIndex', 'INVALID_INTEGER', 'swipeIndex must be a non-negative integer'),
      ]);
      return;
    }

    await registry.withSessionLock(runtime.sessionId, async () => {
      const switchRes = runtime.switchSwipe(assistantMessageId, swipeIndex);
      if (!switchRes.ok) {
        sendErrors(res, 400, switchRes.error);
        return;
      }
      sendJson(res, 200, {
        ok: true,
        action: 'switch',
        assistantMessageId,
        swipeIndex,
        ...switchRes.value,
      });
    });
    return;
  }

  sendErrors(res, 400, [
    validationError('action', 'INVALID_ACTION', 'action must be "regenerate" or "switch"'),
  ]);
}

async function handleConfirmPatch(
  registry: DaemonRegistry,
  runtime: SessionRuntime,
  body: unknown,
  res: ServerResponse
): Promise<void> {
  if (body === undefined) {
    sendErrors(res, 400, [
      validationError('decision', 'REQUIRED', 'decision is required'),
    ]);
    return;
  }

  let decision: 'accept_all' | 'reject_all' | { readonly acceptIndices: readonly number[] };
  if (body === 'accept_all' || body === 'reject_all') {
    decision = body;
  } else if (isPlainObject(body)) {
    const rawDecision = getOwn(body, 'decision') ?? getOwn(body, 'action');
    if (rawDecision === 'accept_all' || rawDecision === 'reject_all') {
      decision = rawDecision;
    } else if (isPlainObject(rawDecision) && Array.isArray(getOwn(rawDecision, 'acceptIndices'))) {
      decision = { acceptIndices: getOwn(rawDecision, 'acceptIndices') as number[] };
    } else if (Array.isArray(getOwn(body, 'acceptIndices'))) {
      decision = { acceptIndices: getOwn(body, 'acceptIndices') as number[] };
    } else {
      sendErrors(res, 400, [
        validationError(
          'decision',
          'INVALID_DECISION',
          'decision must be "accept_all", "reject_all", or { acceptIndices }'
        ),
      ]);
      return;
    }
  } else {
    sendErrors(res, 400, [
      validationError('body', 'INVALID_TYPE', 'Confirm patch payload must be a JSON object'),
    ]);
    return;
  }

  await registry.withSessionLock(runtime.sessionId, async () => {
    const confirmRes = runtime.confirmPendingPatches(decision);
    if (!confirmRes.ok) {
      sendErrors(res, 400, confirmRes.error);
      return;
    }
    sendJson(res, 200, {
      ok: true,
      ...confirmRes.value,
    });
  });
}

async function handleCompilePrompt(
  registry: DaemonRegistry,
  runtime: SessionRuntime,
  body: unknown,
  res: ServerResponse
): Promise<void> {
  if (body !== undefined && !isPlainObject(body)) {
    sendErrors(res, 400, [
      validationError('body', 'INVALID_TYPE', 'compile-prompt payload must be a JSON object'),
    ]);
    return;
  }
  const payload = body ?? {};

  const latestInputRaw = getOwn(payload, 'latestInput') ?? getOwn(payload, 'text') ?? '';
  if (typeof latestInputRaw !== 'string') {
    sendErrors(res, 400, [
      validationError('latestInput', 'INVALID_TYPE', 'latestInput must be a string'),
    ]);
    return;
  }

  const steeringRaw = getOwn(payload, 'directorSteering');
  if (steeringRaw !== undefined && !isPlainObject(steeringRaw)) {
    sendErrors(res, 400, [
      validationError('directorSteering', 'INVALID_TYPE', 'directorSteering must be an object'),
    ]);
    return;
  }

  const recentTranscriptRaw = getOwn(payload, 'recentTranscript');
  if (recentTranscriptRaw !== undefined && !Array.isArray(recentTranscriptRaw)) {
    sendErrors(res, 400, [
      validationError('recentTranscript', 'INVALID_TYPE', 'recentTranscript must be an array'),
    ]);
    return;
  }

  const budgetsRaw = getOwn(payload, 'budgets');
  if (budgetsRaw !== undefined && !isPlainObject(budgetsRaw)) {
    sendErrors(res, 400, [
      validationError('budgets', 'INVALID_TYPE', 'budgets must be an object'),
    ]);
    return;
  }

  await registry.withSessionLock(runtime.sessionId, async () => {
    const meta = registry.getSessionMeta(runtime.sessionId, runtime);
    let workingState = runtime.getState();
    let workingLedger = runtime.getBeatLedger();
    const config = runtime.getConfig();

    if (steeringRaw !== undefined) {
      const steerRes = applyDirectorSteering({
        state: workingState,
        ledger: workingLedger,
        steering: steeringRaw as unknown as DirectorSteeringInput,
        beats: meta.cartridge?.beats,
      });
      if (!steerRes.ok) {
        sendErrors(res, 400, steerRes.error);
        return;
      }
      workingState = steerRes.value.nextState;
      workingLedger = steerRes.value.nextLedger;
    }

    const recentTranscript: ChatMessage[] =
      recentTranscriptRaw !== undefined
        ? (recentTranscriptRaw as ChatMessage[])
        : getLinearTranscript(runtime.getSwipeTree(), 30).map((m) => ({
            role: m.role as ChatMessage['role'],
            content: m.content,
          }));

    let liveNudges: LiveNudgeEntry[] = [];
    let activeAmbient: ActiveAmbientEntry[] = [];
    if (workingState.capabilities.beats && meta.cartridge !== null && meta.cartridge.beats.length > 0) {
      const activeBeats = filterBeatsForActiveRoutes(
        meta.cartridge.beats,
        workingState,
        meta.cartridge.routes,
        { requireRouteLocked: true }
      );
      const beatRes = evaluateBeatGraph({
        state: workingState,
        ledger: workingLedger,
        beats: activeBeats,
        dependencyIndex: buildBeatDependencyIndex(meta.cartridge.beats),
        recentTranscriptLines: [...recentTranscript.map((m) => m.content), latestInputRaw],
        beatPressure: config.tuningDials.beatPressure,
      });
      liveNudges = beatRes.liveNudges;
      activeAmbient = beatRes.activeAmbient;
    }

    const cardPersona: CardPersonaInput =
      meta.cartridge !== null
        ? {
            name: meta.cartridge.card.persona.name,
            description: meta.cartridge.card.persona.description,
            ...(meta.cartridge.card.persona.scenario !== undefined
              ? { scenario: meta.cartridge.card.persona.scenario }
              : {}),
            ...(meta.cartridge.card.persona.systemPrompt !== undefined
              ? { systemPrompt: meta.cartridge.card.persona.systemPrompt }
              : {}),
          }
        : {
            name: config.packName,
            description: meta.basePack.description,
          };

    const activePersona = runtime.getActivePersona();
    const injectedScriptPromptsRaw = getOwn(payload, 'injectedScriptPrompts');
    const compiledPrompt = compileNarratorPrompt({
      state: workingState,
      config,
      cardPersona,
      ...(activePersona !== null
        ? { userPersona: { name: activePersona.name, description: activePersona.description } }
        : {}),
      liveNudges,
      activeAmbient,
      loreContents: meta.cartridge?.loreFiles,
      ...(Array.isArray(injectedScriptPromptsRaw)
        ? { injectedScriptPrompts: injectedScriptPromptsRaw as InjectedScriptPrompt[] }
        : {}),
      recentTranscript,
      latestInput: latestInputRaw,
      ...(budgetsRaw !== undefined ? { budgets: budgetsRaw as Partial<SectionTokenBudgets> } : {}),
      formDefinitions: meta.cartridge?.initialEntities?.forms,
    });

    sendJson(res, 200, {
      ok: true,
      sections: {
        state: getOwn(compiledPrompt.renderedSections as Record<string, unknown>, 'state') ?? '',
        combatOutcome:
          getOwn(compiledPrompt.renderedSections as Record<string, unknown>, 'combat_outcome') ?? '',
        plot: getOwn(compiledPrompt.renderedSections as Record<string, unknown>, 'plot') ?? '',
        world: getOwn(compiledPrompt.renderedSections as Record<string, unknown>, 'world') ?? '',
      },
      compiledPrompt,
      state: workingState,
      beatLedger: workingLedger,
    });
  });
}

async function handlePostNarrate(
  registry: DaemonRegistry,
  runtime: SessionRuntime,
  body: unknown,
  res: ServerResponse
): Promise<void> {
  if (!isPlainObject(body)) {
    sendErrors(res, 400, [
      validationError('body', 'INVALID_TYPE', 'post-narrate payload must be a JSON object'),
    ]);
    return;
  }

  const narratorTextRaw =
    getOwn(body, 'narratorText') ?? getOwn(body, 'assistantText') ?? getOwn(body, 'reply');
  if (typeof narratorTextRaw !== 'string') {
    sendErrors(res, 400, [
      validationError('narratorText', 'INVALID_TYPE', 'narratorText must be a string'),
    ]);
    return;
  }

  const userTextRaw = getOwn(body, 'userText') ?? getOwn(body, 'text') ?? getOwn(body, 'input') ?? '';
  if (typeof userTextRaw !== 'string') {
    sendErrors(res, 400, [
      validationError('userText', 'INVALID_TYPE', 'userText must be a string'),
    ]);
    return;
  }

  const combatActionsRaw = getOwn(body, 'combatActions');
  if (combatActionsRaw !== undefined && !Array.isArray(combatActionsRaw)) {
    sendErrors(res, 400, [
      validationError('combatActions', 'INVALID_TYPE', 'combatActions must be an array'),
    ]);
    return;
  }

  const steeringRaw = getOwn(body, 'directorSteering');
  if (steeringRaw !== undefined && !isPlainObject(steeringRaw)) {
    sendErrors(res, 400, [
      validationError('directorSteering', 'INVALID_TYPE', 'directorSteering must be an object'),
    ]);
    return;
  }

  await registry.withSessionLock(runtime.sessionId, async () => {
    const meta = registry.getSessionMeta(runtime.sessionId, runtime);
    if (meta.bridgeGateway === undefined) {
      sendErrors(res, 400, [
        validationError(
          'session',
          'BRIDGE_GATEWAY_UNAVAILABLE',
          'Session was not created with a bridge-capable gateway override'
        ),
      ]);
      return;
    }

    meta.bridgeGateway.setNarratorOverride(narratorTextRaw);
    try {
      const turnRes = await runtime.executeTurn({
        text: userTextRaw,
        ...(combatActionsRaw !== undefined
          ? { combatActions: combatActionsRaw as readonly ProposedCombatAction[] }
          : {}),
        ...(steeringRaw !== undefined
          ? { directorSteering: steeringRaw as unknown as DirectorSteeringInput }
          : {}),
        streamNarrator: false,
      });

      if (!turnRes.ok) {
        sendErrors(res, 400, turnRes.error);
        return;
      }

      sendJson(res, 200, {
        ok: true,
        ...turnRes.value,
      });
    } finally {
      meta.bridgeGateway.setNarratorOverride(null);
    }
  });
}

async function handleGetAudit(
  registry: DaemonRegistry,
  runtime: SessionRuntime,
  url: URL,
  res: ServerResponse
): Promise<void> {
  const filter: AuditLogFilter = {};

  const turnParam = url.searchParams.get('turn');
  if (turnParam !== null && turnParam.length > 0) {
    const parsedTurn = Number(turnParam);
    if (!Number.isInteger(parsedTurn) || parsedTurn < 0) {
      sendErrors(res, 400, [
        validationError('turn', 'INVALID_INTEGER', 'Query parameter "turn" must be a non-negative integer'),
      ]);
      return;
    }
    filter.turn = parsedTurn;
  }

  const pathPrefixParam = url.searchParams.get('pathPrefix');
  if (pathPrefixParam !== null && pathPrefixParam.length > 0) {
    filter.pathPrefix = pathPrefixParam;
  }

  const sourceParam = url.searchParams.get('source');
  if (sourceParam !== null && sourceParam.length > 0) {
    if (!VALID_PATCH_SOURCES.has(sourceParam)) {
      sendErrors(res, 400, [
        validationError('source', 'INVALID_ENUM', `Invalid audit source "${sourceParam}"`),
      ]);
      return;
    }
    filter.source = sourceParam as PatchSource;
  }

  await registry.withSessionLock(runtime.sessionId, async () => {
    const log = createAuditLog(runtime.getAuditLog());
    const entries = queryAuditLog(log, filter);
    sendJson(res, 200, {
      ok: true,
      sessionId: runtime.sessionId,
      entries,
    });
  });
}

async function handleGetChronicle(
  registry: DaemonRegistry,
  runtime: SessionRuntime,
  res: ServerResponse
): Promise<void> {
  await registry.withSessionLock(runtime.sessionId, async () => {
    const state = runtime.getState();
    sendJson(res, 200, {
      ok: true,
      sessionId: runtime.sessionId,
      events: state.chronicle.events,
    });
  });
}

function decodePathParam(rawValue: string, field: string): Result<string, ValidationError[]> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawValue);
  } catch {
    return err([validationError(field, 'INVALID_URI', `Malformed ${field} in path`)]);
  }
  if (!isSafeKey(decoded) || decoded.trim().length === 0) {
    return err([validationError(field, 'INVALID_ID', `Invalid ${field} "${decoded}"`)]);
  }
  return ok(decoded);
}

function parseConnectionConfigObject(
  raw: unknown,
  acc: ErrorAccumulator
): Omit<RoleConnectionConfig, 'role'> | undefined {
  if (!isPlainObject(raw)) {
    acc.add('', 'INVALID_TYPE', 'Connection configuration must be a plain object');
    return undefined;
  }

  const rawProvider = getOwn(raw, 'provider');
  let provider: ProviderKind = 'openai_compatible';
  if (rawProvider !== undefined) {
    if (typeof rawProvider !== 'string' || !VALID_PROVIDER_KINDS.has(rawProvider)) {
      acc.add(
        'provider',
        'INVALID_PROVIDER',
        `provider must be one of: ${PROVIDER_KINDS.join(', ')}`
      );
    } else {
      provider = rawProvider as ProviderKind;
    }
  }

  const rawBaseUrl = getOwn(raw, 'baseUrl');
  if (typeof rawBaseUrl !== 'string' || rawBaseUrl.trim().length === 0) {
    acc.add('baseUrl', 'REQUIRED', 'baseUrl must be a non-empty string');
  }

  const rawModel = getOwn(raw, 'model');
  if (typeof rawModel !== 'string' || rawModel.trim().length === 0) {
    acc.add('model', 'REQUIRED', 'model must be a non-empty string');
  }

  const rawApiKey = getOwn(raw, 'apiKey');
  if (rawApiKey !== undefined && typeof rawApiKey !== 'string') {
    acc.add('apiKey', 'INVALID_TYPE', 'apiKey must be a string');
  }

  const rawSupportsJsonSchema = getOwn(raw, 'supportsJsonSchema');
  if (rawSupportsJsonSchema !== undefined && typeof rawSupportsJsonSchema !== 'boolean') {
    acc.add('supportsJsonSchema', 'INVALID_TYPE', 'supportsJsonSchema must be a boolean');
  }

  const numericValues: Record<string, number> = {};
  for (const field of NUMERIC_SAMPLING_FIELDS) {
    const rawVal = getOwn(raw, field);
    if (rawVal !== undefined) {
      if (typeof rawVal !== 'number' || !Number.isFinite(rawVal)) {
        acc.add(field, 'INVALID_TYPE', `${field} must be a finite number`);
      } else {
        setOwn(numericValues, field, rawVal);
      }
    }
  }

  const rawStopSequences = getOwn(raw, 'stopSequences');
  let stopSequences: string[] | undefined;
  if (rawStopSequences !== undefined) {
    if (
      !Array.isArray(rawStopSequences) ||
      !rawStopSequences.every((item) => typeof item === 'string')
    ) {
      acc.add('stopSequences', 'INVALID_TYPE', 'stopSequences must be an array of strings');
    } else {
      stopSequences = [...rawStopSequences];
    }
  }

  if (
    typeof rawBaseUrl !== 'string' ||
    rawBaseUrl.trim().length === 0 ||
    typeof rawModel !== 'string' ||
    rawModel.trim().length === 0
  ) {
    return undefined;
  }

  return {
    provider,
    baseUrl: rawBaseUrl,
    model: rawModel,
    ...(typeof rawApiKey === 'string' ? { apiKey: rawApiKey } : {}),
    ...(typeof rawSupportsJsonSchema === 'boolean'
      ? { supportsJsonSchema: rawSupportsJsonSchema }
      : {}),
    ...numericValues,
    ...(stopSequences !== undefined ? { stopSequences } : {}),
  };
}

function redactConnectionForDisplay(
  conn: Omit<RoleConnectionConfig, 'role'>,
  redact: boolean
): Omit<RoleConnectionConfig, 'role'> {
  const copy: Omit<RoleConnectionConfig, 'role'> = {
    ...conn,
    ...(conn.stopSequences !== undefined ? { stopSequences: [...conn.stopSequences] } : {}),
  };
  if (redact && copy.apiKey !== undefined && copy.apiKey.length > 0) {
    return { ...copy, apiKey: '***' };
  }
  return copy;
}

function redactProfilesForDisplay(
  profiles: Record<string, ConnectionProfile> | undefined,
  redact: boolean
): Record<string, ConnectionProfile> {
  const out: Record<string, ConnectionProfile> = {};
  if (profiles === undefined) {
    return out;
  }
  const names = Object.keys(profiles).sort(compareStringsDeterministic);
  for (const name of names) {
    if (!isSafeKey(name)) {
      continue;
    }
    const profile = getOwn(profiles as Record<string, unknown>, name) as
      | ConnectionProfile
      | undefined;
    if (profile === undefined) {
      continue;
    }
    let nextConns: Partial<Record<AgentRole, Omit<RoleConnectionConfig, 'role'>>> | undefined;
    if (profile.connections !== undefined) {
      nextConns = {};
      for (const roleKey of Object.keys(profile.connections).sort(compareStringsDeterministic)) {
        if (!isSafeKey(roleKey) || !VALID_AGENT_ROLES.has(roleKey)) {
          continue;
        }
        const cfg = getOwn(profile.connections as Record<string, unknown>, roleKey) as
          | Omit<RoleConnectionConfig, 'role'>
          | undefined;
        if (cfg !== undefined) {
          setOwn(
            nextConns as Record<string, unknown>,
            roleKey,
            redactConnectionForDisplay(cfg, redact)
          );
        }
      }
    }
    setOwn(out, name, {
      ...(profile.defaultConnection !== undefined
        ? { defaultConnection: redactConnectionForDisplay(profile.defaultConnection, redact) }
        : {}),
      ...(nextConns !== undefined ? { connections: nextConns } : {}),
    });
  }
  return out;
}

async function handleGetConnections(
  registry: DaemonRegistry,
  url: URL,
  res: ServerResponse
): Promise<void> {
  const redact = url.searchParams.get('redact') === 'true';
  const snap = registry.gateway.getConnectionsSnapshot({ redactApiKeys: redact });
  const profiles = redactProfilesForDisplay(registry.connectionsDoc.profiles, redact);
  sendJson(res, 200, {
    ok: true,
    ...snap,
    activeProfile: registry.connectionsDoc.activeProfile ?? null,
    profiles,
  });
}

async function handlePutConnections(
  registry: DaemonRegistry,
  body: unknown,
  res: ServerResponse
): Promise<void> {
  if (!isPlainObject(body)) {
    sendErrors(res, 400, [
      validationError('body', 'INVALID_TYPE', 'Request body must be a JSON object'),
    ]);
    return;
  }

  const acc = new ErrorAccumulator('body');
  let nextDefaultAction: 'keep' | 'clear' | Omit<RoleConnectionConfig, 'role'> = 'keep';
  const rawDefault = getOwn(body, 'defaultConnection');
  if (rawDefault === null) {
    nextDefaultAction = 'clear';
  } else if (rawDefault !== undefined) {
    const parsedDefault = parseConnectionConfigObject(rawDefault, acc.scope('defaultConnection'));
    if (parsedDefault !== undefined) {
      nextDefaultAction = parsedDefault;
    }
  }

  const roleUpdates = new Map<AgentRole, Omit<RoleConnectionConfig, 'role'> | null>();
  const rawConns = getOwn(body, 'connections');
  if (rawConns !== undefined) {
    if (!isPlainObject(rawConns)) {
      acc.add('connections', 'INVALID_TYPE', 'connections must be a plain object');
    } else {
      for (const roleKey of Object.keys(rawConns).sort(compareStringsDeterministic)) {
        if (!isSafeKey(roleKey)) {
          acc.add(`connections.${roleKey}`, 'UNSAFE_KEY', `Forbidden key "${roleKey}"`);
          continue;
        }
        if (!VALID_AGENT_ROLES.has(roleKey)) {
          acc.add(`connections.${roleKey}`, 'INVALID_ROLE', `Unknown agent role "${roleKey}"`);
          continue;
        }
        const cfg = getOwn(rawConns, roleKey);
        if (cfg === null) {
          roleUpdates.set(roleKey as AgentRole, null);
        } else {
          const parsedRole = parseConnectionConfigObject(cfg, acc.scope(`connections.${roleKey}`));
          if (parsedRole !== undefined) {
            roleUpdates.set(roleKey as AgentRole, parsedRole);
          }
        }
      }
    }
  }

  if (acc.hasErrors()) {
    sendErrors(res, 400, [...acc.errors]);
    return;
  }

  if (nextDefaultAction === 'clear') {
    registry.gateway.setDefaultConnection(undefined);
  } else if (nextDefaultAction !== 'keep') {
    registry.gateway.setDefaultConnection(nextDefaultAction);
  }

  for (const [role, cfg] of roleUpdates.entries()) {
    if (cfg === null) {
      registry.gateway.removeRoleConnection(role);
    } else {
      registry.gateway.setRoleConnection(role, cfg);
    }
  }

  registry.connectionsDoc = snapshotGatewayToConnectionsDoc(
    registry.gateway,
    registry.connectionsDoc
  );
  const saveRes = await registry.persistConnectionsDoc();
  if (!saveRes.ok) {
    sendErrors(res, 500, saveRes.error);
    return;
  }

  sendJson(res, 200, {
    ok: true,
    ...registry.gateway.getConnectionsSnapshot(),
    activeProfile: registry.connectionsDoc.activeProfile ?? null,
    profiles: redactProfilesForDisplay(registry.connectionsDoc.profiles, false),
  });
}

async function handlePostConnectionProfile(
  registry: DaemonRegistry,
  body: unknown,
  res: ServerResponse
): Promise<void> {
  if (!isPlainObject(body)) {
    sendErrors(res, 400, [
      validationError('body', 'INVALID_TYPE', 'Profile payload must be a JSON object'),
    ]);
    return;
  }

  const nameRaw = getOwn(body, 'name');
  if (typeof nameRaw !== 'string' || nameRaw.trim().length === 0) {
    sendErrors(res, 400, [
      validationError('name', 'REQUIRED', 'Profile name must be a non-empty string'),
    ]);
    return;
  }
  const name = nameRaw.trim();
  const profileInput: Record<string, unknown> = {};
  const defaultConn = getOwn(body, 'defaultConnection');
  if (defaultConn !== undefined) {
    setOwn(profileInput, 'defaultConnection', defaultConn);
  }
  const conns = getOwn(body, 'connections');
  if (conns !== undefined) {
    setOwn(profileInput, 'connections', conns);
  }

  const savedRes = saveNamedProfile(
    registry.connectionsDoc,
    name,
    profileInput as ConnectionProfile
  );
  if (!savedRes.ok) {
    sendErrors(res, 400, savedRes.error);
    return;
  }

  let nextDoc = savedRes.value;
  if (getOwn(body, 'activate') === true) {
    const actRes = activateNamedProfile(nextDoc, name, registry.gateway);
    if (!actRes.ok) {
      sendErrors(res, 400, actRes.error);
      return;
    }
    nextDoc = actRes.value;
  }

  registry.connectionsDoc = nextDoc;
  const persistRes = await registry.persistConnectionsDoc();
  if (!persistRes.ok) {
    sendErrors(res, 500, persistRes.error);
    return;
  }

  sendJson(res, 201, {
    ok: true,
    name,
    activeProfile: nextDoc.activeProfile ?? null,
    profiles: redactProfilesForDisplay(nextDoc.profiles, false),
    ...registry.gateway.getConnectionsSnapshot(),
  });
}

async function handleActivateConnectionProfile(
  registry: DaemonRegistry,
  rawName: string,
  res: ServerResponse
): Promise<void> {
  const nameRes = decodePathParam(rawName, 'name');
  if (!nameRes.ok) {
    sendErrors(res, 400, nameRes.error);
    return;
  }

  const actRes = activateNamedProfile(registry.connectionsDoc, nameRes.value, registry.gateway);
  if (!actRes.ok) {
    const status = actRes.error.some((e) => e.code === 'PROFILE_NOT_FOUND') ? 404 : 400;
    sendErrors(res, status, actRes.error);
    return;
  }

  registry.connectionsDoc = actRes.value;
  const persistRes = await registry.persistConnectionsDoc();
  if (!persistRes.ok) {
    sendErrors(res, 500, persistRes.error);
    return;
  }

  sendJson(res, 200, {
    ok: true,
    activeProfile: actRes.value.activeProfile ?? null,
    ...registry.gateway.getConnectionsSnapshot(),
  });
}

async function handleDeleteConnectionProfile(
  registry: DaemonRegistry,
  rawName: string,
  res: ServerResponse
): Promise<void> {
  const nameRes = decodePathParam(rawName, 'name');
  if (!nameRes.ok) {
    sendErrors(res, 400, nameRes.error);
    return;
  }

  const delRes = deleteNamedProfile(registry.connectionsDoc, nameRes.value);
  if (!delRes.ok) {
    const status = delRes.error.some((e) => e.code === 'PROFILE_NOT_FOUND') ? 404 : 400;
    sendErrors(res, status, delRes.error);
    return;
  }

  registry.connectionsDoc = delRes.value;
  const persistRes = await registry.persistConnectionsDoc();
  if (!persistRes.ok) {
    sendErrors(res, 500, persistRes.error);
    return;
  }

  sendJson(res, 200, {
    ok: true,
    deleted: nameRes.value,
    activeProfile: delRes.value.activeProfile ?? null,
    profiles: redactProfilesForDisplay(delRes.value.profiles, false),
  });
}

function slugifyPresetId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'imported-preset';
}

async function savePresetInRegistryAndStore(
  registry: DaemonRegistry,
  input: SaveControlRoomPresetInput
): Promise<Result<SavedControlRoomPreset, ValidationError[]>> {
  const idCheck = validateSafeStorageId(input.id);
  if (!idCheck.ok) {
    return idCheck;
  }
  if (typeof input.name !== 'string' || input.name.trim().length === 0) {
    return err([validationError('name', 'REQUIRED', 'Preset name must be a non-empty string')]);
  }
  if (!isPlainObject(input.layer)) {
    return err([validationError('layer', 'INVALID_TYPE', 'Preset layer must be a plain object')]);
  }

  if (registry.dataStore !== undefined) {
    const saveRes = await registry.dataStore.savePreset(input);
    if (!saveRes.ok) {
      return saveRes;
    }
    registry.presets.set(saveRes.value.id, saveRes.value);
    return ok(saveRes.value);
  }

  const saved: SavedControlRoomPreset = {
    id: idCheck.value,
    name: input.name.trim(),
    ...(typeof input.description === 'string' ? { description: input.description } : {}),
    sourceFormat: input.sourceFormat ?? 'referee',
    layer: cloneControlRoomLayer(input.layer),
    updatedAt: input.updatedAt ?? new Date().toISOString(),
  };
  registry.presets.set(saved.id, saved);
  return ok(saved);
}

async function handleGetPresets(registry: DaemonRegistry, res: ServerResponse): Promise<void> {
  const presets = Array.from(registry.presets.values()).sort((a, b) =>
    compareStringsDeterministic(a.id, b.id)
  );
  sendJson(res, 200, { ok: true, presets });
}

async function handlePostPreset(
  registry: DaemonRegistry,
  body: unknown,
  res: ServerResponse
): Promise<void> {
  if (!isPlainObject(body)) {
    sendErrors(res, 400, [
      validationError('body', 'INVALID_TYPE', 'Preset payload must be a JSON object'),
    ]);
    return;
  }

  const saveRes = await savePresetInRegistryAndStore(
    registry,
    body as unknown as SaveControlRoomPresetInput
  );
  if (!saveRes.ok) {
    sendErrors(res, 400, saveRes.error);
    return;
  }

  sendJson(res, 201, { ok: true, preset: saveRes.value });
}

async function handleDeletePreset(
  registry: DaemonRegistry,
  rawId: string,
  res: ServerResponse
): Promise<void> {
  const pathRes = decodePathParam(rawId, 'id');
  if (!pathRes.ok) {
    sendErrors(res, 400, pathRes.error);
    return;
  }
  const idRes = validateSafeStorageId(pathRes.value);
  if (!idRes.ok) {
    sendErrors(res, 400, idRes.error);
    return;
  }

  if (registry.dataStore !== undefined) {
    const delRes = await registry.dataStore.deletePreset(idRes.value);
    if (!delRes.ok) {
      const status = delRes.error.some((e) => e.code === 'FILE_NOT_FOUND') ? 404 : 400;
      sendErrors(res, status, delRes.error);
      return;
    }
  } else if (!registry.presets.has(idRes.value)) {
    sendErrors(res, 404, [
      validationError('id', 'PRESET_NOT_FOUND', `Preset "${idRes.value}" was not found`),
    ]);
    return;
  }

  registry.presets.delete(idRes.value);
  sendJson(res, 200, { ok: true, deleted: idRes.value });
}

async function handleImportPreset(
  registry: DaemonRegistry,
  body: unknown,
  res: ServerResponse
): Promise<void> {
  if (!isPlainObject(body)) {
    sendErrors(res, 400, [
      validationError('body', 'INVALID_TYPE', 'Preset import payload must be a JSON object'),
    ]);
    return;
  }

  const rawPreset = getOwn(body, 'preset') ?? body;
  if (typeof rawPreset !== 'string' && !isPlainObject(rawPreset)) {
    sendErrors(res, 400, [
      validationError('preset', 'INVALID_TYPE', 'preset must be a JSON object or string'),
    ]);
    return;
  }

  const rawOptions = getOwn(body, 'options');
  const explicitNameRaw = getOwn(body, 'name');
  const explicitName =
    typeof explicitNameRaw === 'string' && explicitNameRaw.trim().length > 0
      ? explicitNameRaw.trim()
      : undefined;

  const importOptions = {
    ...(isPlainObject(rawOptions) ? rawOptions : {}),
    ...(explicitName !== undefined ? { presetName: explicitName } : {}),
  };

  const importRes = importSillyTavernPreset(rawPreset, importOptions);
  if (!importRes.ok) {
    sendErrors(res, 400, importRes.error);
    return;
  }

  const explicitIdRaw = getOwn(body, 'id');
  let presetId: string;
  if (explicitIdRaw !== undefined) {
    if (typeof explicitIdRaw !== 'string') {
      sendErrors(res, 400, [validationError('id', 'INVALID_TYPE', 'id must be a string')]);
      return;
    }
    const idCheck = validateSafeStorageId(explicitIdRaw);
    if (!idCheck.ok) {
      sendErrors(res, 400, idCheck.error);
      return;
    }
    presetId = idCheck.value;
  } else {
    presetId = slugifyPresetId(explicitName ?? importRes.value.presetName);
  }

  const sessionIdRaw = getOwn(body, 'sessionId');
  let targetRuntime: SessionRuntime | undefined;
  if (sessionIdRaw !== undefined && sessionIdRaw !== null) {
    if (typeof sessionIdRaw !== 'string' || !isSafeKey(sessionIdRaw)) {
      sendErrors(res, 400, [
        validationError('sessionId', 'INVALID_SESSION_ID', 'sessionId must be a safe string'),
      ]);
      return;
    }
    targetRuntime = registry.sessions.get(sessionIdRaw);
    if (targetRuntime === undefined) {
      sendErrors(res, 404, [
        validationError('sessionId', 'SESSION_NOT_FOUND', `Session "${sessionIdRaw}" was not found`),
      ]);
      return;
    }
  }

  const saveRes = await savePresetInRegistryAndStore(registry, {
    id: presetId,
    name: explicitName ?? importRes.value.presetName,
    sourceFormat: importRes.value.format,
    layer: importRes.value.layer,
  });
  if (!saveRes.ok) {
    sendErrors(res, 400, saveRes.error);
    return;
  }

  if (targetRuntime !== undefined) {
    const applyRes = await registry.withSessionLock(targetRuntime.sessionId, async () =>
      targetRuntime.updateControlRoomLayer((current) =>
        mergeControlRoomLayers(current, importRes.value.layer)
      )
    );
    if (!applyRes.ok) {
      sendErrors(res, 400, applyRes.error);
      return;
    }
  }

  sendJson(res, 201, {
    ok: true,
    presetId: saveRes.value.id,
    format: importRes.value.format,
    layer: importRes.value.layer,
    generation: importRes.value.generation,
    tokenBudgets: importRes.value.tokenBudgets,
    warnings: importRes.value.warnings,
  });
}

async function handleApplySessionPreset(
  registry: DaemonRegistry,
  runtime: SessionRuntime,
  body: unknown,
  res: ServerResponse
): Promise<void> {
  if (!isPlainObject(body)) {
    sendErrors(res, 400, [
      validationError('body', 'INVALID_TYPE', 'apply-preset payload must be a JSON object'),
    ]);
    return;
  }

  const presetIdRaw = getOwn(body, 'presetId');
  let savedPreset: SavedControlRoomPreset | undefined;
  if (presetIdRaw !== undefined && presetIdRaw !== null) {
    if (typeof presetIdRaw !== 'string' || !isSafeKey(presetIdRaw)) {
      sendErrors(res, 400, [
        validationError('presetId', 'INVALID_TYPE', 'presetId must be a non-empty string'),
      ]);
      return;
    }
    savedPreset = registry.presets.get(presetIdRaw);
    if (savedPreset === undefined) {
      sendErrors(res, 404, [
        validationError('presetId', 'PRESET_NOT_FOUND', `Preset "${presetIdRaw}" was not found`),
      ]);
      return;
    }
  }

  const sheetPresetIdRaw = getOwn(body, 'sheetPresetId');
  let sheetPresetId: string | undefined;
  if (sheetPresetIdRaw !== undefined && sheetPresetIdRaw !== null) {
    if (typeof sheetPresetIdRaw !== 'string' || sheetPresetIdRaw.trim().length === 0) {
      sendErrors(res, 400, [
        validationError('sheetPresetId', 'INVALID_TYPE', 'sheetPresetId must be a non-empty string'),
      ]);
      return;
    }
    sheetPresetId = sheetPresetIdRaw.trim();
  }

  const targetRaw = getOwn(body, 'target');
  let target: 'pc' | 'npc' | 'both' = 'both';
  if (targetRaw !== undefined) {
    if (targetRaw !== 'pc' && targetRaw !== 'npc' && targetRaw !== 'both') {
      sendErrors(res, 400, [
        validationError('target', 'INVALID_ENUM', 'target must be "pc", "npc", or "both"'),
      ]);
      return;
    }
    target = targetRaw;
  }

  if (savedPreset === undefined && sheetPresetId === undefined) {
    sendErrors(res, 400, [
      validationError('body', 'REQUIRED', 'At least one of presetId or sheetPresetId is required'),
    ]);
    return;
  }

  await registry.withSessionLock(runtime.sessionId, async () => {
    const meta = registry.getSessionMeta(runtime.sessionId, runtime);
    const updateRes = await runtime.updateControlRoomLayer((current) => {
      let next =
        savedPreset !== undefined
          ? mergeControlRoomLayers(current, savedPreset.layer)
          : cloneControlRoomLayer(current);
      if (sheetPresetId !== undefined) {
        next = applySheetPreset(next, sheetPresetId, target);
      }
      return next;
    });

    if (!updateRes.ok) {
      sendErrors(res, 400, updateRes.error);
      return;
    }

    const diffReport = computeControlRoomDiffReport(
      updateRes.value,
      meta.basePack,
      meta.cartridge?.systemOverrides
    );

    sendJson(res, 200, {
      ok: true,
      config: updateRes.value,
      state: runtime.getState(),
      diffReport,
    });
  });
}

async function handleExportSessionPreset(
  registry: DaemonRegistry,
  runtime: SessionRuntime,
  url: URL,
  res: ServerResponse
): Promise<void> {
  const format = url.searchParams.get('format') ?? 'referee';
  if (format !== 'st_chat' && format !== 'st_text' && format !== 'referee') {
    sendErrors(res, 400, [
      validationError('format', 'INVALID_FORMAT', 'format must be st_chat, st_text, or referee'),
    ]);
    return;
  }

  await registry.withSessionLock(runtime.sessionId, async () => {
    const config = runtime.getConfig();
    if (format === 'st_chat') {
      sendJson(res, 200, {
        ok: true,
        format,
        preset: exportToSillyTavernChatCompletionPreset(config),
      });
      return;
    }
    if (format === 'st_text') {
      sendJson(res, 200, {
        ok: true,
        format,
        preset: exportToSillyTavernTextCompletionPreset(config),
      });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      format: 'referee',
      preset: cloneResolvedControlRoomConfig(config),
    });
  });
}

async function handleGetPersonas(registry: DaemonRegistry, res: ServerResponse): Promise<void> {
  const personas = Array.from(registry.personas.values())
    .sort((a, b) => compareStringsDeterministic(a.id, b.id))
    .map(cloneUserPersonaPreset);
  sendJson(res, 200, { ok: true, personas });
}

async function handlePostPersona(
  registry: DaemonRegistry,
  body: unknown,
  res: ServerResponse
): Promise<void> {
  if (!isPlainObject(body)) {
    sendErrors(res, 400, [
      validationError('body', 'INVALID_TYPE', 'Persona payload must be a JSON object'),
    ]);
    return;
  }

  const rawId = getOwn(body, 'id');
  if (typeof rawId !== 'string') {
    sendErrors(res, 400, [validationError('id', 'REQUIRED', 'Persona id must be a string')]);
    return;
  }
  const idCheck = validateSafeStorageId(rawId);
  if (!idCheck.ok) {
    sendErrors(res, 400, idCheck.error);
    return;
  }

  const candidate: UserPersonaPreset = {
    ...(body as unknown as UserPersonaPreset),
    updatedAt:
      typeof getOwn(body, 'updatedAt') === 'string'
        ? (getOwn(body, 'updatedAt') as string)
        : new Date().toISOString(),
  };

  const validated = validateUserPersonaPreset(candidate);
  if (!validated.ok) {
    sendErrors(res, 400, validated.error);
    return;
  }

  let saved = cloneUserPersonaPreset(validated.value);
  if (registry.dataStore !== undefined) {
    const saveRes = await registry.dataStore.savePersona(saved);
    if (!saveRes.ok) {
      sendErrors(res, 400, saveRes.error);
      return;
    }
    saved = cloneUserPersonaPreset(saveRes.value);
  }

  registry.personas.set(saved.id, cloneUserPersonaPreset(saved));
  sendJson(res, 201, { ok: true, persona: saved });
}

async function handleDeletePersona(
  registry: DaemonRegistry,
  rawId: string,
  res: ServerResponse
): Promise<void> {
  const pathRes = decodePathParam(rawId, 'id');
  if (!pathRes.ok) {
    sendErrors(res, 400, pathRes.error);
    return;
  }
  const idRes = validateSafeStorageId(pathRes.value);
  if (!idRes.ok) {
    sendErrors(res, 400, idRes.error);
    return;
  }

  if (registry.dataStore !== undefined) {
    const delRes = await registry.dataStore.deletePersona(idRes.value);
    if (!delRes.ok) {
      const status = delRes.error.some((e) => e.code === 'FILE_NOT_FOUND') ? 404 : 400;
      sendErrors(res, status, delRes.error);
      return;
    }
  } else if (!registry.personas.has(idRes.value)) {
    sendErrors(res, 404, [
      validationError('id', 'PERSONA_NOT_FOUND', `Persona "${idRes.value}" was not found`),
    ]);
    return;
  }

  registry.personas.delete(idRes.value);
  sendJson(res, 200, { ok: true, deleted: idRes.value });
}

async function handlePutSessionPersona(
  registry: DaemonRegistry,
  runtime: SessionRuntime,
  body: unknown,
  res: ServerResponse
): Promise<void> {
  if (!isPlainObject(body)) {
    sendErrors(res, 400, [
      validationError('body', 'INVALID_TYPE', 'Persona payload must be a JSON object'),
    ]);
    return;
  }

  let targetPersona: UserPersonaPreset | null;
  if (Object.hasOwn(body, 'personaId')) {
    const personaIdRaw = getOwn(body, 'personaId');
    if (personaIdRaw === null) {
      targetPersona = null;
    } else if (typeof personaIdRaw === 'string' && isSafeKey(personaIdRaw)) {
      const found = registry.personas.get(personaIdRaw);
      if (found === undefined) {
        sendErrors(res, 404, [
          validationError('personaId', 'PERSONA_NOT_FOUND', `Persona "${personaIdRaw}" was not found`),
        ]);
        return;
      }
      targetPersona = cloneUserPersonaPreset(found);
    } else {
      sendErrors(res, 400, [
        validationError('personaId', 'INVALID_TYPE', 'personaId must be a string or null'),
      ]);
      return;
    }
  } else if (Object.hasOwn(body, 'persona')) {
    const personaRaw = getOwn(body, 'persona');
    if (personaRaw === null) {
      targetPersona = null;
    } else if (isPlainObject(personaRaw)) {
      targetPersona = personaRaw as unknown as UserPersonaPreset;
    } else {
      sendErrors(res, 400, [
        validationError('persona', 'INVALID_TYPE', 'persona must be an object or null'),
      ]);
      return;
    }
  } else {
    sendErrors(res, 400, [
      validationError('body', 'REQUIRED', 'Either personaId or persona is required'),
    ]);
    return;
  }

  await registry.withSessionLock(runtime.sessionId, async () => {
    const applyRes = await runtime.applyUserPersona(targetPersona);
    if (!applyRes.ok) {
      sendErrors(res, 400, applyRes.error);
      return;
    }
    sendJson(res, 200, {
      ok: true,
      activePersona: runtime.getActivePersona(),
      state: applyRes.value,
    });
  });
}

async function handleGetSessionCharacters(
  registry: DaemonRegistry,
  runtime: SessionRuntime,
  url: URL,
  res: ServerResponse
): Promise<void> {
  const filter: SettingCharacterFilter = {};

  const locationId = url.searchParams.get('locationId');
  if (locationId !== null && locationId.length > 0) {
    filter.locationId = locationId;
  }

  const statusParam = url.searchParams.get('status');
  if (statusParam !== null && statusParam.length > 0) {
    if (!VALID_CHARACTER_STATUSES.has(statusParam)) {
      sendErrors(res, 400, [
        validationError('status', 'INVALID_ENUM', `Invalid character status "${statusParam}"`),
      ]);
      return;
    }
    filter.status = statusParam as CharacterStatus;
  }

  const allegiance = url.searchParams.get('allegiance');
  if (allegiance !== null && allegiance.length > 0) {
    filter.allegiance = allegiance;
  }

  const formGroup = url.searchParams.get('formGroup');
  if (formGroup !== null && formGroup.length > 0) {
    filter.formGroup = formGroup;
  }

  if (url.searchParams.get('presentOnly') === 'true') {
    filter.presentOnly = true;
  }
  filter.includePlayer = url.searchParams.get('includePlayer') !== 'false';

  const query = url.searchParams.get('query');
  if (query !== null && query.length > 0) {
    filter.query = query;
  }

  await registry.withSessionLock(runtime.sessionId, async () => {
    const inspection = runtime.inspectSettingCharacters(filter);
    sendJson(res, 200, {
      ok: true,
      ...inspection,
    });
  });
}

async function handleGetSessionCharacterDossier(
  registry: DaemonRegistry,
  runtime: SessionRuntime,
  rawCharId: string,
  res: ServerResponse
): Promise<void> {
  const charIdRes = decodePathParam(rawCharId, 'charId');
  if (!charIdRes.ok) {
    sendErrors(res, 400, charIdRes.error);
    return;
  }

  await registry.withSessionLock(runtime.sessionId, async () => {
    const dossier = runtime.inspectCharacterDossier(charIdRes.value);
    if (dossier === null) {
      sendErrors(res, 404, [
        validationError(
          'charId',
          'CHARACTER_NOT_FOUND',
          `Character "${charIdRes.value}" was not found`
        ),
      ]);
      return;
    }
    sendJson(res, 200, { ok: true, dossier });
  });
}

async function handlePostSessionCharacter(
  registry: DaemonRegistry,
  runtime: SessionRuntime,
  body: unknown,
  res: ServerResponse
): Promise<void> {
  if (!isPlainObject(body)) {
    sendErrors(res, 400, [
      validationError('body', 'INVALID_TYPE', 'Character payload must be a JSON object'),
    ]);
    return;
  }

  const nestedChar = getOwn(body, 'character');
  if (nestedChar !== undefined && !isPlainObject(nestedChar)) {
    sendErrors(res, 400, [
      validationError('character', 'INVALID_TYPE', 'character must be a plain object'),
    ]);
    return;
  }

  const charSource = (isPlainObject(nestedChar) ? nestedChar : body) as Record<string, unknown>;
  const rawId = getOwn(body, 'characterId') ?? getOwn(body, 'id') ?? getOwn(charSource, 'id');
  if (typeof rawId !== 'string' || !isSafeKey(rawId) || rawId.trim().length === 0) {
    sendErrors(res, 400, [
      validationError('characterId', 'REQUIRED', 'characterId (or id) must be a safe non-empty string'),
    ]);
    return;
  }
  const characterId = rawId.trim();

  const rawName = getOwn(charSource, 'name');
  if (typeof rawName !== 'string' || rawName.trim().length === 0) {
    sendErrors(res, 400, [
      validationError('name', 'REQUIRED', 'Character name must be a non-empty string'),
    ]);
    return;
  }

  const { id: _ignoredId, characterId: _ignoredCharId, ...charFields } = charSource;

  await registry.withSessionLock(runtime.sessionId, async () => {
    const upsertRes = runtime.upsertCharacter(
      characterId,
      charFields as Partial<Omit<CharacterEntity, 'id'>> & { name: string }
    );
    if (!upsertRes.ok) {
      sendErrors(res, 400, upsertRes.error);
      return;
    }
    sendJson(res, 201, {
      ok: true,
      characterId,
      state: upsertRes.value,
      dossier: runtime.inspectCharacterDossier(characterId),
    });
  });
}

async function handlePatchSessionCharacter(
  registry: DaemonRegistry,
  runtime: SessionRuntime,
  rawCharId: string,
  body: unknown,
  res: ServerResponse
): Promise<void> {
  const charIdRes = decodePathParam(rawCharId, 'charId');
  if (!charIdRes.ok) {
    sendErrors(res, 400, charIdRes.error);
    return;
  }
  if (!isPlainObject(body)) {
    sendErrors(res, 400, [
      validationError('body', 'INVALID_TYPE', 'Character patch payload must be a JSON object'),
    ]);
    return;
  }

  const nestedChar = getOwn(body, 'character');
  if (nestedChar !== undefined && !isPlainObject(nestedChar)) {
    sendErrors(res, 400, [
      validationError('character', 'INVALID_TYPE', 'character must be a plain object'),
    ]);
    return;
  }
  const charSource = (isPlainObject(nestedChar) ? nestedChar : body) as Record<string, unknown>;
  const { id: _ignoredId, characterId: _ignoredCharId, ...charFields } = charSource;

  await registry.withSessionLock(runtime.sessionId, async () => {
    const existing = getOwn(
      runtime.getState().entities.characters as Record<string, unknown>,
      charIdRes.value
    ) as CharacterEntity | undefined;
    const rawName = getOwn(charFields, 'name');
    const resolvedName =
      typeof rawName === 'string' && rawName.trim().length > 0 ? rawName : existing?.name;

    if (resolvedName === undefined || resolvedName.trim().length === 0) {
      sendErrors(res, 400, [
        validationError('name', 'REQUIRED', 'Character name must be a non-empty string'),
      ]);
      return;
    }

    const upsertRes = runtime.upsertCharacter(charIdRes.value, {
      ...(charFields as Partial<Omit<CharacterEntity, 'id'>>),
      name: resolvedName,
    });
    if (!upsertRes.ok) {
      sendErrors(res, 400, upsertRes.error);
      return;
    }
    sendJson(res, 200, {
      ok: true,
      characterId: charIdRes.value,
      state: upsertRes.value,
      dossier: runtime.inspectCharacterDossier(charIdRes.value),
    });
  });
}

async function handleListSessions(registry: DaemonRegistry, res: ServerResponse): Promise<void> {
  const activeSessions = Array.from(registry.sessions.values())
    .sort((a, b) => compareStringsDeterministic(a.sessionId, b.sessionId))
    .map((runtime) => {
      const state = runtime.getState();
      const config = runtime.getConfig();
      const meta = registry.getSessionMeta(runtime.sessionId, runtime);
      return {
        sessionId: runtime.sessionId,
        turn: state.meta.turn,
        packId: config.packId,
        cartridgeId: meta.cartridge?.card.id ?? null,
      };
    });

  let savedSessionIds: string[] = [];
  if (registry.dataStore !== undefined) {
    const listed = await registry.dataStore.listSavedSessionIds();
    savedSessionIds = listed.items;
  }

  sendJson(res, 200, {
    ok: true,
    activeSessions,
    savedSessionIds,
  });
}

async function resolveSaveDirForSession(
  registry: DaemonRegistry,
  sessionId: string,
  explicitSaveDir: unknown
): Promise<Result<string, ValidationError[]>> {
  if (explicitSaveDir !== undefined) {
    if (typeof explicitSaveDir !== 'string' || explicitSaveDir.trim().length === 0) {
      return err([
        validationError('saveDir', 'INVALID_TYPE', 'saveDir must be a non-empty string'),
      ]);
    }
    return ok(explicitSaveDir);
  }
  if (registry.dataStore !== undefined) {
    return registry.dataStore.getSessionSaveDir(sessionId);
  }
  return err([
    validationError('saveDir', 'SAVE_DIR_REQUIRED', 'saveDir is required when dataDir is not configured'),
  ]);
}

async function resumeSessionFromDir(
  registry: DaemonRegistry,
  sessionId: string,
  saveDir: string,
  options?: { cartridgeId?: string; systemPackId?: string }
): Promise<Result<{ runtime: SessionRuntime; cartridge: CartridgeBundle | null; basePack: SystemPack }, { status: number; errors: ValidationError[] }>> {
  const loadedRes = await loadSessionSave(saveDir);
  if (!loadedRes.ok) {
    const status = loadedRes.error.some((e) => e.code === 'FILE_NOT_FOUND' || e.code === 'SAVE_NOT_FOUND')
      ? 404
      : 400;
    return err({ status, errors: loadedRes.error });
  }
  const manifest = loadedRes.value.manifest;

  const targetCartridgeId = options?.cartridgeId ?? (manifest.cartridgeId !== 'freeform' ? manifest.cartridgeId : undefined);
  let cartridge: CartridgeBundle | null = null;
  if (targetCartridgeId !== undefined) {
    const foundCart = registry.cartridges.get(targetCartridgeId);
    if (foundCart === undefined) {
      return err({
        status: 404,
        errors: [
          validationError(
            'cartridgeId',
            'CARTRIDGE_NOT_FOUND',
            `Cartridge "${targetCartridgeId}" was not found`
          ),
        ],
      });
    }
    cartridge = foundCart;
  }

  const targetPackId = options?.systemPackId ?? manifest.systemPackId;
  const foundPack = registry.systemPacks.get(targetPackId) ?? getStockSystemPack(targetPackId);
  const systemPack = foundPack !== undefined ? cloneSystemPack(foundPack) : undefined;

  const bridgeGateway = new SessionBridgeGateway(registry.gateway);
  const runtimeRes = await SessionRuntime.fromSaveDirectory(saveDir, {
    sessionId,
    cartridge,
    ...(systemPack !== undefined ? { systemPack } : {}),
    gateway: bridgeGateway,
  });
  if (!runtimeRes.ok) {
    return err({ status: 400, errors: runtimeRes.error });
  }

  const runtime = runtimeRes.value;
  const resolvedPack =
    systemPack ??
    registry.systemPacks.get(runtime.getConfig().packId) ??
    getStockSystemPack(runtime.getConfig().packId) ??
    cloneSystemPack(STOCK_FREEFORM_PACK);

  registry.registerSession(runtime, {
    cartridge,
    basePack: resolvedPack,
    bridgeGateway,
  });

  return ok({ runtime, cartridge, basePack: resolvedPack });
}

async function handleResumeSession(
  registry: DaemonRegistry,
  rawSessionId: string,
  body: unknown,
  res: ServerResponse
): Promise<void> {
  const idRes = decodeSessionId(rawSessionId);
  if (!idRes.ok) {
    sendErrors(res, 400, idRes.error);
    return;
  }
  const sessionId = idRes.value;

  if (registry.sessions.has(sessionId)) {
    sendErrors(res, 409, [
      validationError('sessionId', 'SESSION_EXISTS', `Session "${sessionId}" is already active`),
    ]);
    return;
  }

  if (body !== undefined && !isPlainObject(body)) {
    sendErrors(res, 400, [
      validationError('body', 'INVALID_TYPE', 'Resume payload must be a JSON object'),
    ]);
    return;
  }
  const payload = body ?? {};
  const saveDirRes = await resolveSaveDirForSession(registry, sessionId, getOwn(payload, 'saveDir'));
  if (!saveDirRes.ok) {
    sendErrors(res, 400, saveDirRes.error);
    return;
  }

  const cartridgeIdRaw = getOwn(payload, 'cartridgeId');
  const systemPackIdRaw = getOwn(payload, 'systemPackId');
  const resumed = await resumeSessionFromDir(registry, sessionId, saveDirRes.value, {
    ...(typeof cartridgeIdRaw === 'string' ? { cartridgeId: cartridgeIdRaw } : {}),
    ...(typeof systemPackIdRaw === 'string' ? { systemPackId: systemPackIdRaw } : {}),
  });

  if (!resumed.ok) {
    sendErrors(res, resumed.error.status, resumed.error.errors);
    return;
  }

  const runtime = resumed.value.runtime;
  sendJson(res, 200, {
    ok: true,
    sessionId: runtime.sessionId,
    state: runtime.getState(),
    config: runtime.getConfig(),
    beatLedger: runtime.getBeatLedger(),
    combatState: runtime.getCombatState(),
    swipeTree: runtime.getSwipeTree(),
  });
}

async function handleBranchSession(
  registry: DaemonRegistry,
  rawSessionId: string,
  body: unknown,
  res: ServerResponse
): Promise<void> {
  const sourceIdRes = decodeSessionId(rawSessionId);
  if (!sourceIdRes.ok) {
    sendErrors(res, 400, sourceIdRes.error);
    return;
  }
  const sourceSessionId = sourceIdRes.value;

  if (!isPlainObject(body)) {
    sendErrors(res, 400, [
      validationError('body', 'INVALID_TYPE', 'Branch payload must be a JSON object'),
    ]);
    return;
  }

  const targetSessionIdRaw = getOwn(body, 'targetSessionId');
  if (typeof targetSessionIdRaw !== 'string') {
    sendErrors(res, 400, [
      validationError('targetSessionId', 'REQUIRED', 'targetSessionId must be a string'),
    ]);
    return;
  }
  const targetIdCheck = validateSafeStorageId(targetSessionIdRaw);
  if (!targetIdCheck.ok) {
    sendErrors(res, 400, targetIdCheck.error);
    return;
  }
  const targetSessionId = targetIdCheck.value;

  if (registry.sessions.has(targetSessionId)) {
    sendErrors(res, 409, [
      validationError('targetSessionId', 'SESSION_EXISTS', `Session "${targetSessionId}" is already active`),
    ]);
    return;
  }

  const sourceDirRes = await resolveSaveDirForSession(
    registry,
    sourceSessionId,
    getOwn(body, 'sourceSaveDir')
  );
  if (!sourceDirRes.ok) {
    sendErrors(res, 400, sourceDirRes.error);
    return;
  }

  const targetDirRes = await resolveSaveDirForSession(
    registry,
    targetSessionId,
    getOwn(body, 'targetSaveDir')
  );
  if (!targetDirRes.ok) {
    sendErrors(res, 400, targetDirRes.error);
    return;
  }

  const activeSource = registry.sessions.get(sourceSessionId);
  if (activeSource !== undefined) {
    await registry.withSessionLock(sourceSessionId, async () => {
      await activeSource.flushPendingSaves();
    });
  }

  const branchAtTurnRaw = getOwn(body, 'branchAtTurn');
  let branchAtTurn: number;
  if (branchAtTurnRaw !== undefined) {
    if (typeof branchAtTurnRaw !== 'number' || !Number.isInteger(branchAtTurnRaw) || branchAtTurnRaw < 0) {
      sendErrors(res, 400, [
        validationError('branchAtTurn', 'INVALID_INTEGER', 'branchAtTurn must be a non-negative integer'),
      ]);
      return;
    }
    branchAtTurn = branchAtTurnRaw;
  } else if (activeSource !== undefined) {
    branchAtTurn = activeSource.getState().meta.turn;
  } else {
    const loadedRes = await loadSessionSave(sourceDirRes.value);
    if (!loadedRes.ok) {
      sendErrors(res, 404, loadedRes.error);
      return;
    }
    branchAtTurn = loadedRes.value.manifest.currentTurn;
  }

  const branchRes = await branchSave(
    sourceDirRes.value,
    branchAtTurn,
    targetDirRes.value,
    targetSessionId
  );
  if (!branchRes.ok) {
    sendErrors(res, 400, branchRes.error);
    return;
  }

  let loadedSession: { sessionId: string; state: unknown; config: unknown } | undefined;
  if (getOwn(body, 'load') === true || getOwn(body, 'resume') === true) {
    const resumed = await resumeSessionFromDir(registry, targetSessionId, targetDirRes.value);
    if (!resumed.ok) {
      sendErrors(res, resumed.error.status, resumed.error.errors);
      return;
    }
    loadedSession = {
      sessionId: resumed.value.runtime.sessionId,
      state: resumed.value.runtime.getState(),
      config: resumed.value.runtime.getConfig(),
    };
  }

  sendJson(res, 201, {
    ok: true,
    sourceSessionId,
    targetSessionId,
    branchAtTurn,
    manifest: branchRes.value,
    ...(loadedSession !== undefined ? { session: loadedSession } : {}),
  });
}

async function handleStartCombat(
  registry: DaemonRegistry,
  runtime: SessionRuntime,
  body: unknown,
  res: ServerResponse
): Promise<void> {
  if (!isPlainObject(body)) {
    sendErrors(res, 400, [
      validationError('body', 'INVALID_TYPE', 'Combat start payload must be a JSON object'),
    ]);
    return;
  }

  const participantsRaw = getOwn(body, 'participants');
  if (!Array.isArray(participantsRaw) || participantsRaw.length === 0) {
    sendErrors(res, 400, [
      validationError('participants', 'INVALID_TYPE', 'participants must be a non-empty array'),
    ]);
    return;
  }

  const acc = new ErrorAccumulator('participants');
  const normalizedParticipants: Parameters<SessionRuntime['startCombat']>[0] extends readonly (infer T)[]
    ? T[]
    : never[] = [];

  for (let i = 0; i < participantsRaw.length; i += 1) {
    const raw = participantsRaw[i];
    const pAcc = acc.scope(`[${i}]`);
    if (!isPlainObject(raw)) {
      pAcc.add('', 'INVALID_TYPE', 'Participant must be a plain object');
      continue;
    }
    const id = getOwn(raw, 'id');
    const name = getOwn(raw, 'name');
    const team = getOwn(raw, 'team');
    const hp = getOwn(raw, 'hp');
    const maxHp = getOwn(raw, 'maxHp');

    if (typeof id !== 'string' || !isSafeKey(id) || id.trim().length === 0) {
      pAcc.add('id', 'REQUIRED', 'Participant id must be a safe non-empty string');
    }
    if (typeof name !== 'string' || name.trim().length === 0) {
      pAcc.add('name', 'REQUIRED', 'Participant name must be a non-empty string');
    }
    if (team !== 'ally' && team !== 'enemy' && team !== 'neutral') {
      pAcc.add('team', 'INVALID_ENUM', 'Participant team must be "ally", "enemy", or "neutral"');
    }
    if (typeof hp !== 'number' || !Number.isFinite(hp)) {
      pAcc.add('hp', 'INVALID_TYPE', 'Participant hp must be a finite number');
    }
    if (typeof maxHp !== 'number' || !Number.isFinite(maxHp) || maxHp <= 0) {
      pAcc.add('maxHp', 'INVALID_TYPE', 'Participant maxHp must be a positive finite number');
    }

    const rawCoord = getOwn(raw, 'coord');
    const coord =
      isPlainObject(rawCoord) &&
      typeof getOwn(rawCoord, 'x') === 'number' &&
      typeof getOwn(rawCoord, 'y') === 'number'
        ? { x: getOwn(rawCoord, 'x') as number, y: getOwn(rawCoord, 'y') as number }
        : { x: i, y: 0 };

    const rawSpeed = getOwn(raw, 'speed');
    const speed = typeof rawSpeed === 'number' && Number.isFinite(rawSpeed) ? rawSpeed : 30;
    const rawAc = getOwn(raw, 'ac');
    const ac = typeof rawAc === 'number' && Number.isFinite(rawAc) ? rawAc : 10;
    const rawWillpower = getOwn(raw, 'willpower');
    const willpower =
      typeof rawWillpower === 'number' && Number.isFinite(rawWillpower) ? rawWillpower : 10;
    const rawMaxWillpower = getOwn(raw, 'maxWillpower');
    const maxWillpower =
      typeof rawMaxWillpower === 'number' && Number.isFinite(rawMaxWillpower)
        ? rawMaxWillpower
        : willpower;

    const rawRemainingActions = getOwn(raw, 'remainingActions');
    const remainingActions = isPlainObject(rawRemainingActions)
      ? {
          action:
            typeof getOwn(rawRemainingActions, 'action') === 'number'
              ? (getOwn(rawRemainingActions, 'action') as number)
              : 1,
          bonus:
            typeof getOwn(rawRemainingActions, 'bonus') === 'number'
              ? (getOwn(rawRemainingActions, 'bonus') as number)
              : 1,
          reaction:
            typeof getOwn(rawRemainingActions, 'reaction') === 'number'
              ? (getOwn(rawRemainingActions, 'reaction') as number)
              : 1,
        }
      : { action: 1, bonus: 1, reaction: 1 };

    if (!pAcc.hasErrors()) {
      normalizedParticipants.push({
        ...(raw as Record<string, unknown>),
        id: (id as string).trim(),
        name: (name as string).trim(),
        team: team as 'ally' | 'enemy' | 'neutral',
        coord,
        alive: getOwn(raw, 'alive') !== false,
        hp: hp as number,
        maxHp: maxHp as number,
        ac,
        speed,
        remainingMovement:
          typeof getOwn(raw, 'remainingMovement') === 'number'
            ? (getOwn(raw, 'remainingMovement') as number)
            : speed,
        remainingActions,
        resources: isPlainObject(getOwn(raw, 'resources'))
          ? (getOwn(raw, 'resources') as Record<string, number>)
          : {},
        cooldowns: isPlainObject(getOwn(raw, 'cooldowns'))
          ? (getOwn(raw, 'cooldowns') as Record<string, number>)
          : {},
        stats: isPlainObject(getOwn(raw, 'stats'))
          ? (getOwn(raw, 'stats') as Record<string, number>)
          : {},
        statuses: Array.isArray(getOwn(raw, 'statuses')) ? (getOwn(raw, 'statuses') as []) : [],
        abilities: Array.isArray(getOwn(raw, 'abilities'))
          ? (getOwn(raw, 'abilities') as string[])
          : [],
        passives: Array.isArray(getOwn(raw, 'passives')) ? (getOwn(raw, 'passives') as []) : [],
        willpower,
        maxWillpower,
      } as (typeof normalizedParticipants)[number]);
    }
  }

  if (acc.hasErrors()) {
    sendErrors(res, 400, [...acc.errors]);
    return;
  }

  const optionsRaw = getOwn(body, 'options');
  if (optionsRaw !== undefined && !isPlainObject(optionsRaw)) {
    sendErrors(res, 400, [
      validationError('options', 'INVALID_TYPE', 'options must be a plain object'),
    ]);
    return;
  }

  await registry.withSessionLock(runtime.sessionId, async () => {
    const startRes = runtime.startCombat(
      normalizedParticipants,
      (optionsRaw ?? {}) as StartCombatOptions
    );
    if (!startRes.ok) {
      sendErrors(res, 400, startRes.error);
      return;
    }
    sendJson(res, 200, {
      ok: true,
      combatState: startRes.value.combatState,
      state: startRes.value.state,
      auditEntries: startRes.value.auditEntries,
    });
  });
}

/**
 * Create a Node `http.Server` request handler bound to `registry`.
 */
export function createDaemonRequestHandler(
  registry: DaemonRegistry
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const method = (req.method ?? 'GET').toUpperCase();
      if (method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        });
        res.end();
        return;
      }

      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const rawPath = url.pathname;
      const pathname = rawPath.length > 1 && rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath;
      const segments = pathname.split('/').filter((s) => s.length > 0);

      // GET /api/health
      if (method === 'GET' && pathname === '/api/health') {
        sendJson(res, 200, { ok: true, sessions: registry.sessions.size });
        return;
      }

      // GET /api/connections
      if (method === 'GET' && pathname === '/api/connections') {
        await handleGetConnections(registry, url, res);
        return;
      }

      // PUT /api/connections
      if (method === 'PUT' && pathname === '/api/connections') {
        const parsed = await readJsonBody(req);
        if (!parsed.ok) {
          sendErrors(res, parsed.status, parsed.errors);
          return;
        }
        await handlePutConnections(registry, parsed.value, res);
        return;
      }

      // POST /api/connections/profiles
      if (method === 'POST' && pathname === '/api/connections/profiles') {
        const parsed = await readJsonBody(req);
        if (!parsed.ok) {
          sendErrors(res, parsed.status, parsed.errors);
          return;
        }
        await handlePostConnectionProfile(registry, parsed.value, res);
        return;
      }

      // POST /api/connections/profiles/:name/activate
      if (
        method === 'POST' &&
        segments.length === 5 &&
        segments[0] === 'api' &&
        segments[1] === 'connections' &&
        segments[2] === 'profiles' &&
        segments[4] === 'activate'
      ) {
        await handleActivateConnectionProfile(registry, segments[3] as string, res);
        return;
      }

      // DELETE /api/connections/profiles/:name
      if (
        method === 'DELETE' &&
        segments.length === 4 &&
        segments[0] === 'api' &&
        segments[1] === 'connections' &&
        segments[2] === 'profiles'
      ) {
        await handleDeleteConnectionProfile(registry, segments[3] as string, res);
        return;
      }

      // GET /api/presets
      if (method === 'GET' && pathname === '/api/presets') {
        await handleGetPresets(registry, res);
        return;
      }

      // POST /api/presets
      if (method === 'POST' && pathname === '/api/presets') {
        const parsed = await readJsonBody(req);
        if (!parsed.ok) {
          sendErrors(res, parsed.status, parsed.errors);
          return;
        }
        await handlePostPreset(registry, parsed.value, res);
        return;
      }

      // POST /api/presets/import
      if (method === 'POST' && pathname === '/api/presets/import') {
        const parsed = await readJsonBody(req);
        if (!parsed.ok) {
          sendErrors(res, parsed.status, parsed.errors);
          return;
        }
        await handleImportPreset(registry, parsed.value, res);
        return;
      }

      // DELETE /api/presets/:id
      if (
        method === 'DELETE' &&
        segments.length === 3 &&
        segments[0] === 'api' &&
        segments[1] === 'presets'
      ) {
        await handleDeletePreset(registry, segments[2] as string, res);
        return;
      }

      // GET /api/personas
      if (method === 'GET' && pathname === '/api/personas') {
        await handleGetPersonas(registry, res);
        return;
      }

      // POST /api/personas
      if (method === 'POST' && pathname === '/api/personas') {
        const parsed = await readJsonBody(req);
        if (!parsed.ok) {
          sendErrors(res, parsed.status, parsed.errors);
          return;
        }
        await handlePostPersona(registry, parsed.value, res);
        return;
      }

      // DELETE /api/personas/:id
      if (
        method === 'DELETE' &&
        segments.length === 3 &&
        segments[0] === 'api' &&
        segments[1] === 'personas'
      ) {
        await handleDeletePersona(registry, segments[2] as string, res);
        return;
      }

      // GET /api/system-packs
      if (method === 'GET' && pathname === '/api/system-packs') {
        const systemPacks = Array.from(registry.systemPacks.values())
          .sort((a, b) => compareStringsDeterministic(a.id, b.id))
          .map(cloneSystemPack);
        sendJson(res, 200, { ok: true, systemPacks });
        return;
      }

      // POST /api/system-packs
      if (method === 'POST' && pathname === '/api/system-packs') {
        const parsed = await readJsonBody(req);
        if (!parsed.ok) {
          sendErrors(res, parsed.status, parsed.errors);
          return;
        }
        await handleSystemPacksPost(registry, parsed.value, res);
        return;
      }

      // GET /api/cartridges
      if (method === 'GET' && pathname === '/api/cartridges') {
        const cartridges = Array.from(registry.cartridges.values()).sort((a, b) =>
          compareStringsDeterministic(a.card.id, b.card.id)
        );
        sendJson(res, 200, { ok: true, cartridges });
        return;
      }

      // POST /api/cartridges/import
      if (method === 'POST' && pathname === '/api/cartridges/import') {
        const parsed = await readJsonBody(req);
        if (!parsed.ok) {
          sendErrors(res, parsed.status, parsed.errors);
          return;
        }
        await handleCartridgeImport(registry, parsed.value, res);
        return;
      }

      // GET /api/sessions
      if (method === 'GET' && pathname === '/api/sessions') {
        await handleListSessions(registry, res);
        return;
      }

      // POST /api/sessions
      if (method === 'POST' && pathname === '/api/sessions') {
        const parsed = await readJsonBody(req);
        if (!parsed.ok) {
          sendErrors(res, parsed.status, parsed.errors);
          return;
        }
        await handleCreateSession(registry, parsed.value, res);
        return;
      }

      // POST /api/wizard/generate
      if (method === 'POST' && pathname === '/api/wizard/generate') {
        const parsed = await readJsonBody(req);
        if (!parsed.ok) {
          sendErrors(res, parsed.status, parsed.errors);
          return;
        }
        await handleWizardGenerate(registry, parsed.value, res);
        return;
      }

      // Session-scoped routes: /api/sessions/:id/:subroute
      if (segments.length === 4 && segments[0] === 'api' && segments[1] === 'sessions') {
        const rawSessionId = segments[2] as string;
        const subroute = segments[3] as string;

        if (method === 'POST' && subroute === 'resume') {
          const parsed = await readJsonBody(req);
          if (!parsed.ok) {
            sendErrors(res, parsed.status, parsed.errors);
            return;
          }
          await handleResumeSession(registry, rawSessionId, parsed.value, res);
          return;
        }

        if (method === 'POST' && subroute === 'branch') {
          const parsed = await readJsonBody(req);
          if (!parsed.ok) {
            sendErrors(res, parsed.status, parsed.errors);
            return;
          }
          await handleBranchSession(registry, rawSessionId, parsed.value, res);
          return;
        }

        const runtime = getSessionOrNotFound(registry, rawSessionId, res);
        if (runtime === null) {
          return;
        }

        if (method === 'GET' && subroute === 'state') {
          await handleGetSessionState(registry, runtime, res);
          return;
        }

        if (method === 'PATCH' && subroute === 'control-room') {
          const parsed = await readJsonBody(req);
          if (!parsed.ok) {
            sendErrors(res, parsed.status, parsed.errors);
            return;
          }
          await handlePatchControlRoom(registry, runtime, parsed.value, res);
          return;
        }

        if (method === 'PUT' && subroute === 'persona') {
          const parsed = await readJsonBody(req);
          if (!parsed.ok) {
            sendErrors(res, parsed.status, parsed.errors);
            return;
          }
          await handlePutSessionPersona(registry, runtime, parsed.value, res);
          return;
        }

        if (method === 'GET' && subroute === 'characters') {
          await handleGetSessionCharacters(registry, runtime, url, res);
          return;
        }

        if (method === 'POST' && subroute === 'characters') {
          const parsed = await readJsonBody(req);
          if (!parsed.ok) {
            sendErrors(res, parsed.status, parsed.errors);
            return;
          }
          await handlePostSessionCharacter(registry, runtime, parsed.value, res);
          return;
        }

        if (method === 'POST' && subroute === 'turn') {
          const parsed = await readJsonBody(req);
          if (!parsed.ok) {
            sendErrors(res, parsed.status, parsed.errors);
            return;
          }
          await handleExecuteTurn(registry, runtime, parsed.value, res);
          return;
        }

        if (method === 'POST' && subroute === 'swipe') {
          const parsed = await readJsonBody(req);
          if (!parsed.ok) {
            sendErrors(res, parsed.status, parsed.errors);
            return;
          }
          await handleSwipe(registry, runtime, parsed.value, res);
          return;
        }

        if (method === 'POST' && subroute === 'confirm-patch') {
          const parsed = await readJsonBody(req);
          if (!parsed.ok) {
            sendErrors(res, parsed.status, parsed.errors);
            return;
          }
          await handleConfirmPatch(registry, runtime, parsed.value, res);
          return;
        }

        if (method === 'POST' && subroute === 'compile-prompt') {
          const parsed = await readJsonBody(req);
          if (!parsed.ok) {
            sendErrors(res, parsed.status, parsed.errors);
            return;
          }
          await handleCompilePrompt(registry, runtime, parsed.value, res);
          return;
        }

        if (method === 'POST' && subroute === 'post-narrate') {
          const parsed = await readJsonBody(req);
          if (!parsed.ok) {
            sendErrors(res, parsed.status, parsed.errors);
            return;
          }
          await handlePostNarrate(registry, runtime, parsed.value, res);
          return;
        }

        if (method === 'GET' && subroute === 'audit') {
          await handleGetAudit(registry, runtime, url, res);
          return;
        }

        if (method === 'GET' && subroute === 'chronicle') {
          await handleGetChronicle(registry, runtime, res);
          return;
        }

        if (method === 'GET' && subroute === 'stream') {
          registry.sseHub.attachSession(runtime.sessionId, runtime.eventBus);
          registry.sseHub.addClient(runtime.sessionId, res, req);
          return;
        }
      }

      // Nested session-scoped routes: /api/sessions/:id/:group/:action
      if (segments.length === 5 && segments[0] === 'api' && segments[1] === 'sessions') {
        const rawSessionId = segments[2] as string;
        const group = segments[3] as string;
        const action = segments[4] as string;
        const runtime = getSessionOrNotFound(registry, rawSessionId, res);
        if (runtime === null) {
          return;
        }

        if (method === 'POST' && group === 'control-room' && action === 'apply-preset') {
          const parsed = await readJsonBody(req);
          if (!parsed.ok) {
            sendErrors(res, parsed.status, parsed.errors);
            return;
          }
          await handleApplySessionPreset(registry, runtime, parsed.value, res);
          return;
        }

        if (method === 'GET' && group === 'preset' && action === 'export') {
          await handleExportSessionPreset(registry, runtime, url, res);
          return;
        }

        if (method === 'GET' && group === 'characters') {
          await handleGetSessionCharacterDossier(registry, runtime, action, res);
          return;
        }

        if (method === 'PATCH' && group === 'characters') {
          const parsed = await readJsonBody(req);
          if (!parsed.ok) {
            sendErrors(res, parsed.status, parsed.errors);
            return;
          }
          await handlePatchSessionCharacter(registry, runtime, action, parsed.value, res);
          return;
        }

        if (method === 'POST' && group === 'combat' && action === 'start') {
          const parsed = await readJsonBody(req);
          if (!parsed.ok) {
            sendErrors(res, parsed.status, parsed.errors);
            return;
          }
          await handleStartCombat(registry, runtime, parsed.value, res);
          return;
        }
      }

      sendErrors(res, 404, [
        validationError('route', 'NOT_FOUND', `Route ${method} ${pathname} not found`),
      ]);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Unexpected server error';
      sendErrors(res, 500, [validationError('server', 'INTERNAL_ERROR', message)]);
    }
  };
}
