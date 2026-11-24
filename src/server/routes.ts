import type { IncomingMessage, ServerResponse } from 'node:http';
import * as path from 'node:path';
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
import { parseAndValidateSystemPack } from '../cartridge/system-pack-schema.js';
import {
  computeReachableTilesPreview,
  previewCombatAction,
} from '../combat/action-preview.js';
import type { ProposedCombatAction } from '../combat/action-validator.js';
import {
  type ControlRoomLayer,
  type GameSystemModuleOverride,
  type PayloadGroupId,
  cloneCapabilitiesPartial,
  cloneCombatRulesPartial,
  cloneControlRoomLayer,
  cloneGameSystemModuleOverride,
  cloneTuningDialsPartial,
} from '../config/control-room-config.js';
import { computeControlRoomDiffReport } from '../config/prompt-diff.js';
import {
  type CardPersonaInput,
  type InjectedScriptPrompt,
  compileNarratorPrompt,
} from '../context/prompt-compiler.js';
import {
  DEFAULT_TOKEN_BUDGETS,
  type SectionTokenBudgets,
  inspectContextBudget,
} from '../context/tokenizer-budget.js';
import { RefereeError, type ValidationError, validationError } from '../core/errors.js';
import { ErrorAccumulator, type Result, err, ok } from '../core/result.js';
import { ModelGateway } from '../gateway/model-gateway.js';
import type {
  AgentRole,
  ChatMessage,
  GatewayGenerateTextRequest,
  GatewayStructuredOutput,
  GatewayStructuredRequest,
  RoleConnectionConfig,
  StreamChunk,
} from '../gateway/types.js';
import { type DirectorSteeringInput, applyDirectorSteering } from '../runtime/director-steering.js';
import { SessionRuntime } from '../runtime/session-runtime.js';
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
import {
  type SessionLineage,
  cloneSessionStack,
  deleteSavedSession,
  listSavedSessions,
  loadSessionSave,
} from '../state/persistence.js';
import { getLinearTranscript } from '../state/swipe-tree.js';
import type { CharacterEntity } from '../state/world-state.js';
import {
  GameSystemWizard,
  type WizardGenerateRequest,
} from '../wizard/game-system-wizard.js';
import type {
  DowntimeActivity,
  DowntimeOptions,
  TravelOptions,
} from '../world/flow-hooks.js';
import {
  normalizeRelativeAssetPath,
  serveBufferAsset,
  serveSafeBinaryAsset,
} from './asset-handler.js';
import { SessionSseHub } from './ws-stream.js';

const MAX_JSON_BODY_BYTES = 1_048_576; // 1 MB
const MAX_BINARY_BODY_BYTES = 10_485_760; // 10 MB
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
const VALID_PATCH_SOURCES: ReadonlySet<string> = new Set(PATCH_SOURCES);
const VALID_PAYLOAD_GROUPS: ReadonlySet<string> = new Set([
  'capabilities',
  'characterSections',
  'gameSystems',
  'promptSections',
  'combatRules',
  'tuningDials',
]);

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
  lineage?: SessionLineage | null;
  updatedAt?: string;
}

export interface ImportedCardRecord {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly recommendedSystemPack?: string;
  readonly portraitPath: string | null;
  readonly portraitBytes: Uint8Array | null;
  readonly cartridge: CartridgeBundle;
}

export interface DaemonRegistryOptions {
  readonly gateway?: ModelGateway;
  readonly sseHub?: SessionSseHub;
  readonly dataDir?: string;
}

/**
 * Central in-memory registry for daemon sessions, system packs, cartridges,
 * imported character cards, model gateway, Game System Wizard, SSE hub, and per-session async mutexes.
 */
export class DaemonRegistry {
  readonly sessions = new Map<string, SessionRuntime>();
  readonly systemPacks = new Map<string, SystemPack>();
  readonly cartridges = new Map<string, CartridgeBundle>();
  readonly cards = new Map<string, ImportedCardRecord>();
  readonly gateway: ModelGateway;
  readonly wizard: GameSystemWizard;
  readonly sseHub: SessionSseHub;
  readonly dataDir: string | undefined;

  private readonly sessionQueues = new Map<string, Promise<void>>();
  private readonly sessionMeta = new Map<string, SessionRecordMeta>();
  private sessionSeq = 0;

  constructor(options: DaemonRegistryOptions = {}) {
    this.gateway = options.gateway ?? new ModelGateway();
    this.wizard = new GameSystemWizard(this.gateway);
    this.sseHub = options.sseHub ?? new SessionSseHub();
    this.dataDir = options.dataDir;

    for (const [packId, pack] of Object.entries(STOCK_SYSTEM_PACKS)) {
      if (isSafeKey(packId)) {
        this.systemPacks.set(packId, cloneSystemPack(pack));
      }
    }
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
    meta?: {
      cartridge?: CartridgeBundle | null;
      basePack?: SystemPack;
      bridgeGateway?: SessionBridgeGateway;
      lineage?: SessionLineage | null;
    }
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
      ...(meta?.lineage !== undefined ? { lineage: meta.lineage } : {}),
      updatedAt: new Date().toISOString(),
    });
  }

  /**
   * Unregister a session from the in-memory registry and close its SSE streams.
   */
  unregisterSession(sessionId: string): boolean {
    const existed = this.sessions.delete(sessionId);
    this.sessionMeta.delete(sessionId);
    this.sessionQueues.delete(sessionId);
    this.sseHub.detachSession(sessionId);
    return existed;
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

type ParsedBinaryResult =
  | { readonly ok: true; readonly buffer: Buffer }
  | { readonly ok: false; readonly status: number; readonly errors: ValidationError[] };

/**
 * Read a raw binary HTTP request body up to `maxBytes` (default 10 MB),
 * rejecting oversized payloads (`413`).
 */
export async function readBinaryBody(
  req: IncomingMessage,
  maxBytes = MAX_BINARY_BODY_BYTES
): Promise<ParsedBinaryResult> {
  return new Promise<ParsedBinaryResult>((resolve) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    const finish = (result: ParsedBinaryResult): void => {
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
              `Request binary body exceeds ${maxBytes} byte limit`
            ),
          ],
        });
        return;
      }
      chunks.push(buf);
    };

    const onEnd = (): void => {
      finish({ ok: true, buffer: Buffer.concat(chunks) });
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
  const stored = cloneSystemPack(parsed.value);
  registry.systemPacks.set(stored.id, stored);
  sendJson(res, 201, {
    ok: true,
    systemPack: cloneSystemPack(stored),
  });
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
    registry.cartridges.set(stRes.value.card.id, stRes.value);
    sendJson(res, 201, {
      ok: true,
      kind: 'st_card',
      cartridgeId: stRes.value.card.id,
      cartridge: stRes.value,
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
    registry.systemPacks.set(systemPack.id, cloneSystemPack(systemPack));

    const bundleCandidate: CartridgeBundle = {
      rootDir: null,
      card: {
        spec: 'cartridge/0.1',
        id: systemPack.id,
        version: '1.0.0',
        title: systemPack.name,
        description: systemPack.description,
        recommendedSystemPack: systemPack.id,
        persona: {
          name: systemPack.name,
          description: systemPack.description,
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
    registry.cartridges.set(validatedBundle.value.card.id, validatedBundle.value);

    sendJson(res, 201, {
      ok: true,
      kind: 'multihog',
      systemPack: cloneSystemPack(systemPack),
      cartridgeId: validatedBundle.value.card.id,
      cartridge: validatedBundle.value,
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
    registry.cartridges.set(validated.value.card.id, validated.value);
    sendJson(res, 201, {
      ok: true,
      kind: 'cartridge',
      cartridgeId: validated.value.card.id,
      cartridge: validated.value,
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
    registry.cartridges.set(stRes.value.card.id, stRes.value);
    sendJson(res, 201, {
      ok: true,
      kind: 'st_card',
      cartridgeId: stRes.value.card.id,
      cartridge: stRes.value,
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

  registry.cartridges.set(stRes.value.card.id, stRes.value);
  sendJson(res, 201, {
    ok: true,
    kind: 'st_card',
    cartridgeId: stRes.value.card.id,
    cartridge: stRes.value,
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
  const cartridgeIdRaw = getOwn(payload, 'cartridgeId') ?? getOwn(payload, 'cardId');
  if (cartridgeIdRaw !== undefined && cartridgeIdRaw !== null) {
    if (typeof cartridgeIdRaw !== 'string' || !isSafeKey(cartridgeIdRaw)) {
      sendErrors(res, 400, [
        validationError('cartridgeId', 'INVALID_TYPE', 'cartridgeId must be a non-empty string'),
      ]);
      return;
    }
    const found =
      registry.cartridges.get(cartridgeIdRaw) ?? registry.cards.get(cartridgeIdRaw)?.cartridge;
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
  } else if (registry.dataDir !== undefined) {
    saveDir = path.join(registry.dataDir, 'sessions', sessionId);
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

    const injectedScriptPromptsRaw = getOwn(payload, 'injectedScriptPrompts');
    const compiledPrompt = compileNarratorPrompt({
      state: workingState,
      config,
      cardPersona,
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

function findPortraitFromCartridge(
  cartridge: CartridgeBundle
): { readonly portraitPath: string | null; readonly portraitBytes: Uint8Array | null } {
  const charsObj = cartridge.initialState?.entities?.characters;
  const firstCharKey = charsObj ? Object.keys(charsObj).find(isSafeKey) : undefined;
  const firstChar = firstCharKey
    ? (getOwn(charsObj as Record<string, unknown>, firstCharKey) as CharacterEntity | undefined)
    : undefined;
  const avatarPath = firstChar?.portraitAsset ?? null;
  if (cartridge.binaryAssets !== undefined) {
    if (avatarPath !== null && isSafeKey(avatarPath) && Object.hasOwn(cartridge.binaryAssets, avatarPath)) {
      const bytes = Object.getOwnPropertyDescriptor(cartridge.binaryAssets, avatarPath)?.value as
        | Uint8Array
        | undefined;
      if (bytes !== undefined) {
        return { portraitPath: avatarPath, portraitBytes: bytes };
      }
    }
    for (const key of Object.keys(cartridge.binaryAssets)) {
      if (isSafeKey(key) && key.startsWith('assets/portraits/')) {
        const bytes = Object.getOwnPropertyDescriptor(cartridge.binaryAssets, key)?.value as
          | Uint8Array
          | undefined;
        if (bytes !== undefined) {
          return { portraitPath: key, portraitBytes: bytes };
        }
      }
    }
  }
  return { portraitPath: avatarPath, portraitBytes: null };
}

function registerCardFromBundle(registry: DaemonRegistry, bundle: CartridgeBundle): ImportedCardRecord {
  registry.cartridges.set(bundle.card.id, bundle);
  const { portraitPath, portraitBytes } = findPortraitFromCartridge(bundle);
  const record: ImportedCardRecord = {
    id: bundle.card.id,
    name: bundle.card.persona.name || bundle.card.title,
    description: bundle.card.description,
    tags: [],
    ...(bundle.card.recommendedSystemPack !== undefined
      ? { recommendedSystemPack: bundle.card.recommendedSystemPack }
      : {}),
    portraitPath,
    portraitBytes,
    cartridge: bundle,
  };
  registry.cards.set(record.id, record);
  return record;
}

async function handleListSessions(registry: DaemonRegistry, res: ServerResponse): Promise<void> {
  const byId = new Map<
    string,
    {
      readonly sessionId: string;
      readonly title: string;
      readonly cartridgeId: string;
      readonly systemPackId: string;
      readonly turn: number;
      readonly day: number;
      readonly portraitPath: string | null;
      readonly updatedAt: string;
      readonly active: boolean;
      readonly lineage: SessionLineage | null;
    }
  >();

  if (registry.dataDir !== undefined) {
    const savedRes = await listSavedSessions(path.join(registry.dataDir, 'sessions'));
    if (savedRes.ok) {
      for (const s of savedRes.value) {
        byId.set(s.sessionId, {
          ...s,
          active: registry.sessions.has(s.sessionId),
        });
      }
    }
  }

  for (const [sessionId, runtime] of registry.sessions.entries()) {
    const state = runtime.getState();
    const config = runtime.getConfig();
    const meta = registry.getSessionMeta(sessionId, runtime);
    byId.set(sessionId, {
      sessionId,
      title: meta.cartridge?.card.title ?? config.packName,
      cartridgeId: meta.cartridge?.card.id ?? 'freeform',
      systemPackId: config.packId,
      turn: state.meta.turn,
      day: state.clocks.day,
      portraitPath: state.player.portraitAsset ?? (meta.cartridge ? findPortraitFromCartridge(meta.cartridge).portraitPath : null),
      updatedAt: meta.updatedAt ?? new Date(0).toISOString(),
      active: true,
      lineage: meta.lineage ?? null,
    });
  }

  const sessions = Array.from(byId.values()).sort((a, b) =>
    compareStringsDeterministic(a.sessionId, b.sessionId)
  );
  sendJson(res, 200, { ok: true, sessions });
}

async function handleDeleteSession(
  registry: DaemonRegistry,
  sessionId: string,
  res: ServerResponse
): Promise<void> {
  if (!isSafeKey(sessionId) || sessionId.includes('/') || sessionId.includes('\\') || sessionId.includes('..')) {
    sendErrors(res, 400, [
      validationError('sessionId', 'INVALID_SESSION_ID', `Invalid sessionId "${sessionId}"`),
    ]);
    return;
  }

  const hadActive = registry.unregisterSession(sessionId);
  let deletedFromDisk = false;
  if (registry.dataDir !== undefined) {
    const delRes = await deleteSavedSession(path.join(registry.dataDir, 'sessions'), sessionId);
    if (!delRes.ok) {
      sendErrors(res, 400, delRes.error);
      return;
    }
    deletedFromDisk = delRes.value.deleted;
  }

  if (!hadActive && !deletedFromDisk) {
    sendErrors(res, 404, [
      validationError('sessionId', 'SESSION_NOT_FOUND', `Session "${sessionId}" was not found`),
    ]);
    return;
  }

  sendJson(res, 200, { ok: true, deleted: true, sessionId });
}

async function handleCloneSession(
  registry: DaemonRegistry,
  runtime: SessionRuntime,
  body: unknown,
  res: ServerResponse
): Promise<void> {
  if (body !== undefined && !isPlainObject(body)) {
    sendErrors(res, 400, [
      validationError('body', 'INVALID_TYPE', 'Clone payload must be a JSON object'),
    ]);
    return;
  }
  const payload = body ?? {};

  const rawNewId = getOwn(payload, 'sessionId');
  let newSessionId: string;
  if (rawNewId !== undefined) {
    if (typeof rawNewId !== 'string' || !isSafeKey(rawNewId) || rawNewId.trim().length === 0) {
      sendErrors(res, 400, [
        validationError('sessionId', 'INVALID_SESSION_ID', 'sessionId must be a safe non-empty string'),
      ]);
      return;
    }
    newSessionId = rawNewId.trim();
    if (registry.sessions.has(newSessionId)) {
      sendErrors(res, 409, [
        validationError('sessionId', 'SESSION_EXISTS', `Session "${newSessionId}" already exists`),
      ]);
      return;
    }
  } else {
    newSessionId = registry.allocateSessionId();
  }

  const nodeIdRaw = getOwn(payload, 'nodeId');
  if (nodeIdRaw !== undefined && nodeIdRaw !== null && (typeof nodeIdRaw !== 'string' || !isSafeKey(nodeIdRaw))) {
    sendErrors(res, 400, [validationError('nodeId', 'INVALID_TYPE', 'nodeId must be a safe string')]);
    return;
  }
  const nodeId = typeof nodeIdRaw === 'string' ? nodeIdRaw : null;

  const labelRaw = getOwn(payload, 'label');
  if (labelRaw !== undefined && labelRaw !== null && typeof labelRaw !== 'string') {
    sendErrors(res, 400, [validationError('label', 'INVALID_TYPE', 'label must be a string or null')]);
    return;
  }
  const label = typeof labelRaw === 'string' ? labelRaw : null;

  await registry.withSessionLock(runtime.sessionId, async () => {
    const meta = registry.getSessionMeta(runtime.sessionId, runtime);
    const sourceSaveDir = runtime.getSaveDir();
    let targetSaveDir: string | null = null;
    let clonedState = runtime.getState();
    let clonedLedger: Record<string, unknown> | ReturnType<SessionRuntime['getBeatLedger']> =
      runtime.getBeatLedger();
    let clonedTree = runtime.getSwipeTree();
    let lineage: SessionLineage = {
      parentSessionId: runtime.sessionId,
      forkedAtNodeId: nodeId ?? clonedTree.activeLeafMessageId,
      label,
    };

    if (sourceSaveDir !== null && registry.dataDir !== undefined) {
      targetSaveDir = path.join(registry.dataDir, 'sessions', newSessionId);
      const cloneRes = await cloneSessionStack({
        sourceDir: sourceSaveDir,
        targetDir: targetSaveDir,
        newSessionId,
        nodeId,
        label,
      });
      if (!cloneRes.ok) {
        sendErrors(res, 400, cloneRes.error);
        return;
      }
      lineage = cloneRes.value.lineage;
      if (cloneRes.value.swipeTree !== null) {
        clonedTree = cloneRes.value.swipeTree;
      }
      const loadedClone = await loadSessionSave(targetSaveDir);
      if (loadedClone.ok && loadedClone.value.latestCheckpoint !== null) {
        clonedState = loadedClone.value.latestCheckpoint.worldState;
        clonedLedger = loadedClone.value.latestCheckpoint.beatLedger;
      }
    } else if (nodeId !== null) {
      const targetNode = getOwn(clonedTree.nodes as Record<string, unknown>, nodeId) as
        | { activeSwipeIndex: number; swipes: Array<{ stateCheckpointId: string }> }
        | undefined;
      if (!targetNode) {
        sendErrors(res, 404, [
          validationError('nodeId', 'NOT_FOUND', `Message node "${nodeId}" not found`),
        ]);
        return;
      }
      const activeSwipe = targetNode.swipes[targetNode.activeSwipeIndex] ?? targetNode.swipes[0];
      const cp = activeSwipe
        ? (getOwn(clonedTree.checkpoints as Record<string, unknown>, activeSwipe.stateCheckpointId) as
            | { worldState: typeof clonedState; beatLedger: Record<string, unknown> }
            | undefined)
        : undefined;
      if (cp) {
        clonedState = cp.worldState;
        clonedLedger = cp.beatLedger;
      }
      clonedTree = {
        ...clonedTree,
        activeLeafMessageId: nodeId,
      };
    }

    const bridgeGateway = new SessionBridgeGateway(registry.gateway);
    const clonedRuntime = new SessionRuntime({
      sessionId: newSessionId,
      cartridge: meta.cartridge,
      systemPack: cloneSystemPack(meta.basePack),
      gateway: bridgeGateway,
      ...(targetSaveDir !== null ? { saveDir: targetSaveDir } : {}),
    });
    clonedRuntime.restoreSnapshot({
      state: clonedState,
      beatLedger: clonedLedger,
      swipeTree: clonedTree,
      combatState: nodeId === null ? runtime.getCombatState() : null,
    });

    registry.registerSession(clonedRuntime, {
      cartridge: meta.cartridge,
      basePack: meta.basePack,
      bridgeGateway,
      lineage,
    });

    sendJson(res, 201, {
      ok: true,
      sessionId: newSessionId,
      lineage,
      state: clonedRuntime.getState(),
      swipeTree: clonedRuntime.getSwipeTree(),
    });
  });
}

async function handleGetSwipeTree(
  registry: DaemonRegistry,
  runtime: SessionRuntime,
  res: ServerResponse
): Promise<void> {
  await registry.withSessionLock(runtime.sessionId, async () => {
    sendJson(res, 200, {
      ok: true,
      sessionId: runtime.sessionId,
      swipeTree: runtime.getSwipeTree(),
    });
  });
}

async function handleEditMessage(
  registry: DaemonRegistry,
  runtime: SessionRuntime,
  nodeId: string,
  body: unknown,
  res: ServerResponse
): Promise<void> {
  if (!isSafeKey(nodeId)) {
    sendErrors(res, 400, [validationError('nodeId', 'UNSAFE_KEY', 'nodeId must be a safe string')]);
    return;
  }
  if (!isPlainObject(body)) {
    sendErrors(res, 400, [
      validationError('body', 'INVALID_TYPE', 'Edit message payload must be a JSON object'),
    ]);
    return;
  }
  const content = getOwn(body, 'content') ?? getOwn(body, 'newContent');
  if (typeof content !== 'string') {
    sendErrors(res, 400, [
      validationError('content', 'INVALID_TYPE', 'content must be a string'),
    ]);
    return;
  }

  await registry.withSessionLock(runtime.sessionId, async () => {
    const editRes = await runtime.editMessage(nodeId, content);
    if (!editRes.ok) {
      const notFound = editRes.error.some((e) => e.code === 'NOT_FOUND');
      sendErrors(res, notFound ? 404 : 400, editRes.error);
      return;
    }

    registry.sseHub.emitTypedEvent(runtime.sessionId, {
      type: 'state_patched',
      sessionId: runtime.sessionId,
      turn: editRes.value.state.meta.turn,
      changedPaths: [`swipeTree.nodes.${nodeId}`],
      source: 'user',
    });

    sendJson(res, 200, {
      ok: true,
      sessionId: runtime.sessionId,
      ...editRes.value,
    });
  });
}

async function handleContinueSession(
  registry: DaemonRegistry,
  runtime: SessionRuntime,
  body: unknown,
  res: ServerResponse
): Promise<void> {
  if (body !== undefined && !isPlainObject(body)) {
    sendErrors(res, 400, [
      validationError('body', 'INVALID_TYPE', 'Continue payload must be a JSON object'),
    ]);
    return;
  }
  const payload = body ?? {};
  const nodeIdRaw = getOwn(payload, 'nodeId');
  if (nodeIdRaw !== undefined && (typeof nodeIdRaw !== 'string' || !isSafeKey(nodeIdRaw))) {
    sendErrors(res, 400, [validationError('nodeId', 'INVALID_TYPE', 'nodeId must be a safe string')]);
    return;
  }
  const steeringRaw = getOwn(payload, 'directorSteering');
  if (steeringRaw !== undefined && !isPlainObject(steeringRaw)) {
    sendErrors(res, 400, [
      validationError('directorSteering', 'INVALID_TYPE', 'directorSteering must be an object'),
    ]);
    return;
  }
  const streamNarrator = getOwn(payload, 'streamNarrator') === true;

  await registry.withSessionLock(runtime.sessionId, async () => {
    const result = await runtime.continueFromNode({
      ...(typeof nodeIdRaw === 'string' ? { nodeId: nodeIdRaw } : {}),
      ...(steeringRaw !== undefined
        ? { directorSteering: steeringRaw as unknown as DirectorSteeringInput }
        : {}),
      streamNarrator,
    });
    if (!result.ok) {
      const notFound = result.error.some((e) => e.code === 'NOT_FOUND');
      sendErrors(res, notFound ? 404 : 400, result.error);
      return;
    }
    sendJson(res, 200, { ok: true, ...result.value });
  });
}

async function handleCardImport(
  registry: DaemonRegistry,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const contentType = (req.headers['content-type'] ?? '').toLowerCase();
  if (contentType.includes('image/png') || contentType.includes('application/octet-stream')) {
    const binRes = await readBinaryBody(req, MAX_BINARY_BODY_BYTES);
    if (!binRes.ok) {
      sendErrors(res, binRes.status, binRes.errors);
      return;
    }
    const imported = importSillyTavernCard(binRes.buffer);
    if (!imported.ok) {
      sendErrors(res, 400, imported.error);
      return;
    }
    const record = registerCardFromBundle(registry, imported.value);
    sendJson(res, 201, {
      ok: true,
      card: {
        id: record.id,
        name: record.name,
        description: record.description,
        tags: record.tags,
        ...(record.recommendedSystemPack !== undefined
          ? { recommendedSystemPack: record.recommendedSystemPack }
          : {}),
        portraitPath: record.portraitPath,
        portraitUrl: record.portraitBytes !== null ? `/api/cards/${record.id}/portrait` : null,
      },
      cartridge: record.cartridge,
    });
    return;
  }

  const parsed = await readJsonBody(req);
  if (!parsed.ok) {
    sendErrors(res, parsed.status, parsed.errors);
    return;
  }
  if (!isPlainObject(parsed.value)) {
    sendErrors(res, 400, [
      validationError('body', 'INVALID_TYPE', 'Card import payload must be a PNG or JSON object'),
    ]);
    return;
  }

  const pngBase64 = getOwn(parsed.value, 'pngBase64');
  const cardPayload = getOwn(parsed.value, 'card') ?? parsed.value;
  let imported;
  if (typeof pngBase64 === 'string' && pngBase64.trim().length > 0) {
    const stripped = pngBase64.replace(/^data:[^;]+;base64,/i, '').trim();
    const pngBuffer = Buffer.from(stripped, 'base64');
    imported = importSillyTavernCard(pngBuffer);
  } else {
    imported = importSillyTavernCard(cardPayload as Record<string, unknown>);
  }
  if (!imported.ok) {
    sendErrors(res, 400, imported.error);
    return;
  }

  const record = registerCardFromBundle(registry, imported.value);
  sendJson(res, 201, {
    ok: true,
    card: {
      id: record.id,
      name: record.name,
      description: record.description,
      tags: record.tags,
      ...(record.recommendedSystemPack !== undefined
        ? { recommendedSystemPack: record.recommendedSystemPack }
        : {}),
      portraitPath: record.portraitPath,
      portraitUrl: record.portraitBytes !== null ? `/api/cards/${record.id}/portrait` : null,
    },
    cartridge: record.cartridge,
  });
}

async function handleListCards(registry: DaemonRegistry, res: ServerResponse): Promise<void> {
  const cards = Array.from(registry.cards.values())
    .sort((a, b) => compareStringsDeterministic(a.id, b.id))
    .map((record) => ({
      id: record.id,
      name: record.name,
      description: record.description,
      tags: record.tags,
      ...(record.recommendedSystemPack !== undefined
        ? { recommendedSystemPack: record.recommendedSystemPack }
        : {}),
      portraitPath: record.portraitPath,
      portraitUrl: record.portraitBytes !== null ? `/api/cards/${record.id}/portrait` : null,
    }));
  sendJson(res, 200, { ok: true, cards });
}

async function handleGetCardPortrait(
  registry: DaemonRegistry,
  cardId: string,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  if (!isSafeKey(cardId)) {
    sendErrors(res, 400, [validationError('cardId', 'UNSAFE_KEY', 'Invalid cardId')]);
    return;
  }
  const card = registry.cards.get(cardId);
  const portraitBytes =
    card?.portraitBytes ??
    (registry.cartridges.has(cardId)
      ? findPortraitFromCartridge(registry.cartridges.get(cardId) as CartridgeBundle).portraitBytes
      : null);

  if (portraitBytes === null) {
    sendErrors(res, 404, [
      validationError('cardId', 'PORTRAIT_NOT_FOUND', `Portrait for card "${cardId}" was not found`),
    ]);
    return;
  }

  serveBufferAsset(req, res, portraitBytes, 'image/png');
}

async function handleAttachSessionCharacter(
  registry: DaemonRegistry,
  runtime: SessionRuntime,
  body: unknown,
  res: ServerResponse
): Promise<void> {
  if (!isPlainObject(body)) {
    sendErrors(res, 400, [
      validationError('body', 'INVALID_TYPE', 'Character attach payload must be a JSON object'),
    ]);
    return;
  }

  const cardIdRaw = getOwn(body, 'cardId');
  const charIdOverride = getOwn(body, 'characterId');
  const locationIdOverride = getOwn(body, 'locationId');
  const rawCharacter = getOwn(body, 'character');

  let characterEntity: CharacterEntity | null = null;

  if (typeof cardIdRaw === 'string' && isSafeKey(cardIdRaw)) {
    const cartridge = registry.cards.get(cardIdRaw)?.cartridge ?? registry.cartridges.get(cardIdRaw);
    if (!cartridge) {
      sendErrors(res, 404, [
        validationError('cardId', 'CARD_NOT_FOUND', `Card "${cardIdRaw}" was not found`),
      ]);
      return;
    }
    const charsObj = cartridge.initialState?.entities?.characters;
    const firstKey = charsObj ? Object.keys(charsObj).find(isSafeKey) : undefined;
    const baseChar = firstKey
      ? (getOwn(charsObj as Record<string, unknown>, firstKey) as CharacterEntity | undefined)
      : undefined;
    const targetId =
      typeof charIdOverride === 'string' && isSafeKey(charIdOverride)
        ? charIdOverride
        : (baseChar?.id ?? cartridge.card.id);
    const currentState = runtime.getState();
    const targetLoc =
      typeof locationIdOverride === 'string'
        ? locationIdOverride
        : (baseChar?.locationId ?? currentState.scene.locationId);

    const { portraitPath } = findPortraitFromCartridge(cartridge);
    characterEntity = baseChar
      ? {
          ...baseChar,
          id: targetId,
          locationId: targetLoc,
          ...(portraitPath !== null ? { portraitAsset: portraitPath } : {}),
        }
      : {
          id: targetId,
          name: cartridge.card.persona.name || cartridge.card.title,
          status: 'active',
          presentInScene: targetLoc === null || targetLoc === currentState.scene.locationId,
          locationId: targetLoc,
          formId: null,
          formGroup: null,
          sections: {
            identity: cartridge.card.description,
          },
          customFields: {},
          abilities: [],
          goals: [],
          agenda: '',
          allegiance: '',
          mood: 'neutral',
          traits: [],
          ...(portraitPath !== null ? { portraitAsset: portraitPath } : {}),
        };
  } else if (isPlainObject(rawCharacter)) {
    const id = getOwn(rawCharacter, 'id');
    const name = getOwn(rawCharacter, 'name');
    if (typeof id !== 'string' || !isSafeKey(id) || typeof name !== 'string') {
      sendErrors(res, 400, [
        validationError('character', 'INVALID_CHARACTER', 'character must include safe id and name'),
      ]);
      return;
    }
    characterEntity = rawCharacter as unknown as CharacterEntity;
  } else {
    sendErrors(res, 400, [
      validationError('body', 'REQUIRED', 'Provide either cardId or character object'),
    ]);
    return;
  }

  await registry.withSessionLock(runtime.sessionId, async () => {
    const attachRes = runtime.attachCharacterEntity(characterEntity as CharacterEntity);
    if (!attachRes.ok) {
      sendErrors(res, 400, attachRes.error);
      return;
    }

    registry.sseHub.emitTypedEvent(runtime.sessionId, {
      type: 'state_patched',
      sessionId: runtime.sessionId,
      turn: attachRes.value.meta.turn,
      changedPaths: [`entities.characters.${(characterEntity as CharacterEntity).id}`],
      source: 'user',
    });

    sendJson(res, 200, {
      ok: true,
      characterId: (characterEntity as CharacterEntity).id,
      state: attachRes.value,
    });
  });
}

async function handlePatchPlayer(
  registry: DaemonRegistry,
  runtime: SessionRuntime,
  body: unknown,
  res: ServerResponse
): Promise<void> {
  if (!isPlainObject(body)) {
    sendErrors(res, 400, [
      validationError('body', 'INVALID_TYPE', 'Player binding payload must be a JSON object'),
    ]);
    return;
  }

  const canonCharacterId = getOwn(body, 'canonCharacterId');
  const cardId = getOwn(body, 'cardId');
  let name = getOwn(body, 'name');
  let avatarAssetPath = getOwn(body, 'avatarAssetPath');
  let sections = getOwn(body, 'sections');

  if (canonCharacterId !== undefined && (typeof canonCharacterId !== 'string' || !isSafeKey(canonCharacterId))) {
    sendErrors(res, 400, [
      validationError('canonCharacterId', 'INVALID_TYPE', 'canonCharacterId must be a safe string'),
    ]);
    return;
  }

  if (typeof cardId === 'string' && isSafeKey(cardId)) {
    const card = registry.cards.get(cardId);
    const cartridge = card?.cartridge ?? registry.cartridges.get(cardId);
    if (!cartridge) {
      sendErrors(res, 404, [
        validationError('cardId', 'CARD_NOT_FOUND', `Card "${cardId}" was not found`),
      ]);
      return;
    }
    if (name === undefined) {
      name = cartridge.card.persona.name || cartridge.card.title;
    }
    if (avatarAssetPath === undefined) {
      avatarAssetPath = card?.portraitPath ?? findPortraitFromCartridge(cartridge).portraitPath ?? `/api/cards/${cardId}/portrait`;
    }
    if (sections === undefined && cartridge.card.description.length > 0) {
      sections = { identity: cartridge.card.description };
    }
  }

  await registry.withSessionLock(runtime.sessionId, async () => {
    const bindRes = runtime.updatePlayerBinding({
      ...(typeof canonCharacterId === 'string' ? { canonCharacterId } : {}),
      ...(typeof name === 'string' ? { name } : {}),
      ...(avatarAssetPath === null || typeof avatarAssetPath === 'string'
        ? { avatarAssetPath }
        : {}),
      ...(isPlainObject(sections) ? { sections: sections as Record<string, string> } : {}),
    });
    if (!bindRes.ok) {
      sendErrors(res, 400, bindRes.error);
      return;
    }

    registry.sseHub.emitTypedEvent(runtime.sessionId, {
      type: 'state_patched',
      sessionId: runtime.sessionId,
      turn: bindRes.value.meta.turn,
      changedPaths: ['player'],
      source: 'user',
    });

    sendJson(res, 200, {
      ok: true,
      player: bindRes.value.player,
      state: bindRes.value,
    });
  });
}

async function handleServeCartridgeAsset(
  registry: DaemonRegistry,
  cartridgeId: string,
  relPath: string,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  if (!isSafeKey(cartridgeId)) {
    sendErrors(res, 400, [validationError('cartridgeId', 'UNSAFE_KEY', 'Invalid cartridgeId')]);
    return;
  }
  const normRes = normalizeRelativeAssetPath(relPath);
  if (!normRes.ok) {
    sendErrors(res, normRes.error.status, normRes.error.errors);
    return;
  }
  const cartridge = registry.cartridges.get(cartridgeId) ?? registry.cards.get(cartridgeId)?.cartridge;
  if (!cartridge) {
    sendErrors(res, 404, [
      validationError('cartridgeId', 'NOT_FOUND', `Cartridge "${cartridgeId}" was not found`),
    ]);
    return;
  }

  const normalizedRel = normRes.value.normalizedRelPath;
  let inMemoryBuffer: Uint8Array | undefined;
  if (cartridge.binaryAssets !== undefined) {
    const candidates = [normalizedRel, `assets/${normalizedRel}`];
    for (const candidate of candidates) {
      if (isSafeKey(candidate) && Object.hasOwn(cartridge.binaryAssets, candidate)) {
        inMemoryBuffer = Object.getOwnPropertyDescriptor(cartridge.binaryAssets, candidate)?.value as
          | Uint8Array
          | undefined;
        if (inMemoryBuffer !== undefined) {
          break;
        }
      }
    }
  }

  const rootDir =
    registry.dataDir !== undefined
      ? path.join(registry.dataDir, 'cartridges', cartridgeId, 'assets')
      : undefined;

  const serveRes = await serveSafeBinaryAsset(req, res, {
    ...(rootDir !== undefined ? { rootDir } : {}),
    relPath,
    ...(inMemoryBuffer !== undefined ? { inMemoryBuffer } : {}),
  });
  if (!serveRes.ok) {
    sendErrors(res, serveRes.error.status, serveRes.error.errors);
  }
}

async function handleServeSessionAsset(
  registry: DaemonRegistry,
  runtime: SessionRuntime,
  relPath: string,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const normRes = normalizeRelativeAssetPath(relPath);
  if (!normRes.ok) {
    sendErrors(res, normRes.error.status, normRes.error.errors);
    return;
  }

  const meta = registry.getSessionMeta(runtime.sessionId, runtime);
  const normalizedRel = normRes.value.normalizedRelPath;
  let inMemoryBuffer: Uint8Array | undefined;
  if (meta.cartridge?.binaryAssets !== undefined) {
    const candidates = [normalizedRel, `assets/${normalizedRel}`];
    for (const candidate of candidates) {
      if (isSafeKey(candidate) && Object.hasOwn(meta.cartridge.binaryAssets, candidate)) {
        inMemoryBuffer = Object.getOwnPropertyDescriptor(meta.cartridge.binaryAssets, candidate)
          ?.value as Uint8Array | undefined;
        if (inMemoryBuffer !== undefined) {
          break;
        }
      }
    }
  }

  const saveDir = runtime.getSaveDir();
  const rootDir = saveDir !== null ? path.join(saveDir, 'assets') : undefined;

  const serveRes = await serveSafeBinaryAsset(req, res, {
    ...(rootDir !== undefined ? { rootDir } : {}),
    relPath,
    ...(inMemoryBuffer !== undefined ? { inMemoryBuffer } : {}),
  });
  if (!serveRes.ok) {
    sendErrors(res, serveRes.error.status, serveRes.error.errors);
  }
}

async function handleCombatPreview(
  registry: DaemonRegistry,
  runtime: SessionRuntime,
  body: unknown,
  res: ServerResponse
): Promise<void> {
  if (body !== undefined && !isPlainObject(body)) {
    sendErrors(res, 400, [
      validationError('body', 'INVALID_TYPE', 'Combat preview payload must be a JSON object'),
    ]);
    return;
  }
  const payload = body ?? {};
  const actionRaw = getOwn(payload, 'action');
  const actorIdRaw = getOwn(payload, 'actorId');
  const includeReachableTiles = getOwn(payload, 'includeReachableTiles') !== false;

  await registry.withSessionLock(runtime.sessionId, async () => {
    const combatState = runtime.getCombatState();
    if (combatState === null || !combatState.active) {
      sendErrors(res, 400, [
        validationError('combatState', 'NO_ACTIVE_COMBAT', 'Session has no active combat encounter'),
      ]);
      return;
    }

    const action = isPlainObject(actionRaw) ? (actionRaw as unknown as ProposedCombatAction) : undefined;
    const activeInitiativeId = combatState.initiativeOrder[combatState.turnIndex];
    const resolvedActorId =
      typeof actorIdRaw === 'string' && isSafeKey(actorIdRaw)
        ? actorIdRaw
        : (activeInitiativeId ?? 'player');

    const actionPreview =
      action !== undefined
        ? previewCombatAction(combatState, resolvedActorId, action, runtime.getSkillRegistry())
        : null;

    const reachableTiles = includeReachableTiles
      ? computeReachableTilesPreview(combatState, resolvedActorId)
      : null;

    sendJson(res, 200, {
      ok: true,
      actorId: resolvedActorId,
      actionPreview,
      reachableTiles,
    });
  });
}

async function handleTravel(
  registry: DaemonRegistry,
  runtime: SessionRuntime,
  body: unknown,
  res: ServerResponse
): Promise<void> {
  if (!isPlainObject(body)) {
    sendErrors(res, 400, [
      validationError('body', 'INVALID_TYPE', 'Travel payload must be a JSON object'),
    ]);
    return;
  }
  const targetLocationId = getOwn(body, 'targetLocationId');
  if (typeof targetLocationId !== 'string' || !isSafeKey(targetLocationId)) {
    sendErrors(res, 400, [
      validationError('targetLocationId', 'REQUIRED', 'targetLocationId must be a safe string'),
    ]);
    return;
  }

  await registry.withSessionLock(runtime.sessionId, async () => {
    const travelRes = runtime.travel(targetLocationId, body as unknown as TravelOptions);
    if (!travelRes.ok) {
      sendErrors(res, 400, travelRes.error);
      return;
    }

    registry.sseHub.emitTypedEvent(runtime.sessionId, {
      type: 'state_patched',
      sessionId: runtime.sessionId,
      turn: travelRes.value.state.meta.turn,
      changedPaths: ['scene.locationId', 'player.locationId', 'clock'],
      source: 'engine',
    });

    sendJson(res, 200, { ok: true, ...travelRes.value });
  });
}

async function handleDowntime(
  registry: DaemonRegistry,
  runtime: SessionRuntime,
  body: unknown,
  res: ServerResponse
): Promise<void> {
  if (!isPlainObject(body)) {
    sendErrors(res, 400, [
      validationError('body', 'INVALID_TYPE', 'Downtime payload must be a JSON object'),
    ]);
    return;
  }
  const activity = getOwn(body, 'activity');
  if (typeof activity !== 'string' || activity.trim().length === 0) {
    sendErrors(res, 400, [
      validationError('activity', 'REQUIRED', 'activity must be a non-empty string'),
    ]);
    return;
  }

  await registry.withSessionLock(runtime.sessionId, async () => {
    const downtimeRes = runtime.downtime(
      activity as DowntimeActivity,
      body as unknown as DowntimeOptions
    );
    if (!downtimeRes.ok) {
      sendErrors(res, 400, downtimeRes.error);
      return;
    }

    registry.sseHub.emitTypedEvent(runtime.sessionId, {
      type: 'state_patched',
      sessionId: runtime.sessionId,
      turn: downtimeRes.value.state.meta.turn,
      changedPaths: ['clock', 'player'],
      source: 'engine',
    });

    sendJson(res, 200, { ok: true, ...downtimeRes.value });
  });
}

async function handleGetContextBudget(
  registry: DaemonRegistry,
  runtime: SessionRuntime,
  res: ServerResponse
): Promise<void> {
  await registry.withSessionLock(runtime.sessionId, async () => {
    const meta = registry.getSessionMeta(runtime.sessionId, runtime);
    const state = runtime.getState();
    const config = runtime.getConfig();
    const recentTranscript = getLinearTranscript(runtime.getSwipeTree(), 30).map((m) => ({
      role: m.role as ChatMessage['role'],
      content: m.content,
    }));

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

    const compiledPrompt = compileNarratorPrompt({
      state,
      config,
      cardPersona,
      loreContents: meta.cartridge?.loreFiles,
      recentTranscript,
      latestInput: '',
      formDefinitions: meta.cartridge?.initialEntities?.forms,
    });

    const sectionInputs: Record<string, string> = {};
    for (const [k, v] of Object.entries(compiledPrompt.renderedSections)) {
      if (isSafeKey(k) && typeof v === 'string') {
        setOwn(sectionInputs, k, v);
      }
    }

    const budgetReport = inspectContextBudget(sectionInputs, {
      ...DEFAULT_TOKEN_BUDGETS,
    });

    sendJson(res, 200, {
      ok: true,
      sessionId: runtime.sessionId,
      budgetReport,
      compiledPrompt,
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

      const rawUrlPath = (req.url ?? '/').split('?')[0] ?? '/';
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const rawPath = url.pathname;
      const pathname = rawPath.length > 1 && rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath;
      const segments = pathname.split('/').filter((s) => s.length > 0);

      // Wildcard binary asset routes (matched against rawUrlPath before URL dot-segment normalization)
      if (method === 'GET') {
        const cartridgeAssetMatch = /^\/api\/cartridges\/([^/]+)\/assets\/(.*)$/.exec(rawUrlPath);
        if (cartridgeAssetMatch !== null) {
          const cartridgeId = decodeURIComponent(cartridgeAssetMatch[1] ?? '');
          const relPath = cartridgeAssetMatch[2] ?? '';
          await handleServeCartridgeAsset(registry, cartridgeId, relPath, req, res);
          return;
        }

        const sessionAssetMatch = /^\/api\/sessions\/([^/]+)\/assets\/(.*)$/.exec(rawUrlPath);
        if (sessionAssetMatch !== null) {
          const rawSessionId = decodeURIComponent(sessionAssetMatch[1] ?? '');
          const relPath = sessionAssetMatch[2] ?? '';
          const runtime = getSessionOrNotFound(registry, rawSessionId, res);
          if (runtime === null) {
            return;
          }
          await handleServeSessionAsset(registry, runtime, relPath, req, res);
          return;
        }
      }

      // GET /api/health
      if (method === 'GET' && pathname === '/api/health') {
        sendJson(res, 200, { ok: true, sessions: registry.sessions.size });
        return;
      }

      // GET /api/connections
      if (method === 'GET' && pathname === '/api/connections') {
        const snap = registry.gateway.getConnectionsSnapshot();
        sendJson(res, 200, { ok: true, ...snap });
        return;
      }

      // PUT /api/connections
      if (method === 'PUT' && pathname === '/api/connections') {
        const parsed = await readJsonBody(req);
        if (!parsed.ok) {
          sendErrors(res, parsed.status, parsed.errors);
          return;
        }
        if (!isPlainObject(parsed.value)) {
          sendErrors(res, 400, [
            validationError('body', 'INVALID_TYPE', 'Request body must be a JSON object'),
          ]);
          return;
        }
        const rawDefault = getOwn(parsed.value, 'defaultConnection');
        if (isPlainObject(rawDefault)) {
          const baseUrl = getOwn(rawDefault, 'baseUrl');
          const model = getOwn(rawDefault, 'model');
          const apiKey = getOwn(rawDefault, 'apiKey');
          const provider = getOwn(rawDefault, 'provider');
          if (typeof baseUrl === 'string' && typeof model === 'string') {
            registry.gateway.setDefaultConnection({
              provider:
                provider === 'ollama' || provider === 'anthropic' || provider === 'mock'
                  ? provider
                  : 'openai_compatible',
              baseUrl,
              model,
              ...(typeof apiKey === 'string' ? { apiKey } : {}),
            });
          }
        }
        const rawConns = getOwn(parsed.value, 'connections');
        if (isPlainObject(rawConns)) {
          for (const roleKey of Object.keys(rawConns)) {
            if (!isSafeKey(roleKey)) continue;
            const cfg = getOwn(rawConns, roleKey);
            if (isPlainObject(cfg)) {
              const baseUrl = getOwn(cfg, 'baseUrl');
              const model = getOwn(cfg, 'model');
              const apiKey = getOwn(cfg, 'apiKey');
              const provider = getOwn(cfg, 'provider');
              if (typeof baseUrl === 'string' && typeof model === 'string') {
                registry.gateway.setRoleConnection(roleKey as AgentRole, {
                  provider:
                    provider === 'ollama' || provider === 'anthropic' || provider === 'mock'
                      ? provider
                      : 'openai_compatible',
                  baseUrl,
                  model,
                  ...(typeof apiKey === 'string' ? { apiKey } : {}),
                });
              }
            }
          }
        }
        sendJson(res, 200, { ok: true, ...registry.gateway.getConnectionsSnapshot() });
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

      // GET /api/cards
      if (method === 'GET' && pathname === '/api/cards') {
        await handleListCards(registry, res);
        return;
      }

      // POST /api/cards/import
      if (method === 'POST' && pathname === '/api/cards/import') {
        await handleCardImport(registry, req, res);
        return;
      }

      // GET /api/cards/:id/portrait
      if (
        method === 'GET' &&
        segments.length === 4 &&
        segments[0] === 'api' &&
        segments[1] === 'cards' &&
        segments[3] === 'portrait'
      ) {
        const cardId = segments[2] as string;
        await handleGetCardPortrait(registry, cardId, req, res);
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

      // DELETE /api/sessions/:id
      if (method === 'DELETE' && segments.length === 3 && segments[0] === 'api' && segments[1] === 'sessions') {
        const rawSessionId = segments[2] as string;
        await handleDeleteSession(registry, rawSessionId, res);
        return;
      }

      // Session-scoped nested routes: /api/sessions/:id/messages/:nodeId & /api/sessions/:id/combat/preview
      if (segments.length === 5 && segments[0] === 'api' && segments[1] === 'sessions') {
        const rawSessionId = segments[2] as string;
        const runtime = getSessionOrNotFound(registry, rawSessionId, res);
        if (runtime === null) {
          return;
        }

        if (method === 'PATCH' && segments[3] === 'messages') {
          const nodeId = segments[4] as string;
          const parsed = await readJsonBody(req);
          if (!parsed.ok) {
            sendErrors(res, parsed.status, parsed.errors);
            return;
          }
          await handleEditMessage(registry, runtime, nodeId, parsed.value, res);
          return;
        }

        if (method === 'POST' && segments[3] === 'combat' && segments[4] === 'preview') {
          const parsed = await readJsonBody(req);
          if (!parsed.ok) {
            sendErrors(res, parsed.status, parsed.errors);
            return;
          }
          await handleCombatPreview(registry, runtime, parsed.value, res);
          return;
        }
      }

      // Session-scoped routes: /api/sessions/:id/:subroute
      if (segments.length === 4 && segments[0] === 'api' && segments[1] === 'sessions') {
        const rawSessionId = segments[2] as string;
        const subroute = segments[3] as string;
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

        if (method === 'POST' && subroute === 'clone') {
          const parsed = await readJsonBody(req);
          if (!parsed.ok) {
            sendErrors(res, parsed.status, parsed.errors);
            return;
          }
          await handleCloneSession(registry, runtime, parsed.value, res);
          return;
        }

        if (method === 'GET' && subroute === 'swipe-tree') {
          await handleGetSwipeTree(registry, runtime, res);
          return;
        }

        if (method === 'POST' && subroute === 'continue') {
          const parsed = await readJsonBody(req);
          if (!parsed.ok) {
            sendErrors(res, parsed.status, parsed.errors);
            return;
          }
          await handleContinueSession(registry, runtime, parsed.value, res);
          return;
        }

        if (method === 'POST' && subroute === 'characters') {
          const parsed = await readJsonBody(req);
          if (!parsed.ok) {
            sendErrors(res, parsed.status, parsed.errors);
            return;
          }
          await handleAttachSessionCharacter(registry, runtime, parsed.value, res);
          return;
        }

        if (method === 'PATCH' && subroute === 'player') {
          const parsed = await readJsonBody(req);
          if (!parsed.ok) {
            sendErrors(res, parsed.status, parsed.errors);
            return;
          }
          await handlePatchPlayer(registry, runtime, parsed.value, res);
          return;
        }

        if (method === 'POST' && subroute === 'travel') {
          const parsed = await readJsonBody(req);
          if (!parsed.ok) {
            sendErrors(res, parsed.status, parsed.errors);
            return;
          }
          await handleTravel(registry, runtime, parsed.value, res);
          return;
        }

        if (method === 'POST' && subroute === 'downtime') {
          const parsed = await readJsonBody(req);
          if (!parsed.ok) {
            sendErrors(res, parsed.status, parsed.errors);
            return;
          }
          await handleDowntime(registry, runtime, parsed.value, res);
          return;
        }

        if (method === 'GET' && subroute === 'context-budget') {
          await handleGetContextBudget(registry, runtime, res);
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
