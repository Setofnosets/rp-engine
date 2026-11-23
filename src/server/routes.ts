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
import { parseAndValidateSystemPack } from '../cartridge/system-pack-schema.js';
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
import type { SectionTokenBudgets } from '../context/tokenizer-budget.js';
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
import { getLinearTranscript } from '../state/swipe-tree.js';
import {
  GameSystemWizard,
  type WizardGenerateRequest,
} from '../wizard/game-system-wizard.js';
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
}

export interface DaemonRegistryOptions {
  readonly gateway?: ModelGateway;
  readonly sseHub?: SessionSseHub;
  readonly dataDir?: string;
}

/**
 * Central in-memory registry for daemon sessions, system packs, cartridges,
 * model gateway, Game System Wizard, SSE hub, and per-session async mutexes.
 */
export class DaemonRegistry {
  readonly sessions = new Map<string, SessionRuntime>();
  readonly systemPacks = new Map<string, SystemPack>();
  readonly cartridges = new Map<string, CartridgeBundle>();
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
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
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
          'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
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
