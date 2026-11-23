import { Result, err, ok } from '../core/result.js';
import { ModelGateway, ModelGatewayOptions } from './model-gateway.js';
import {
  AgentRole,
  ChatMessage,
  GatewayGenerateTextRequest,
  GatewayStructuredRequest,
  ModelProvider,
  ProviderFailure,
  RoleConnectionConfig,
  StreamChunk,
} from './types.js';

/**
 * Method name recorded in {@link RecordedMockCall}.
 */
export type MockCallMethod = 'generateText' | 'streamText' | 'generateStructuredRaw';

/**
 * Error specification used by {@link MockModelProvider} to simulate provider failures.
 */
export interface MockErrorSpec {
  readonly code?: string;
  readonly message: string;
  readonly status?: number;
  readonly retryable?: boolean;
  readonly isAbort?: boolean;
  readonly delayMs?: number;
}

/**
 * Declarative mock response options supported by {@link MockModelProvider}.
 */
export type MockResponseSpec =
  | string
  | {
      readonly kind: 'text';
      readonly text: string;
      readonly chunks?: readonly string[];
      readonly delayMs?: number;
    }
  | {
      readonly kind: 'json';
      readonly value: unknown;
      readonly chunks?: readonly string[];
      readonly delayMs?: number;
    }
  | {
      readonly kind: 'stream';
      readonly chunks: readonly string[];
      readonly delayMs?: number;
      readonly failAfterChunks?: number;
      readonly failure?: MockErrorSpec;
    }
  | ({ readonly kind: 'error' } & MockErrorSpec)
  | {
      readonly kind: 'timeout';
      readonly message?: string;
      readonly delayMs?: number;
    };

/**
 * Invocation context passed to dynamic {@link MockRoleHandler} callbacks.
 */
export interface MockCallContext {
  readonly callIndex: number;
  readonly method: MockCallMethod;
  readonly role: AgentRole;
  readonly config: RoleConnectionConfig;
  readonly request: GatewayGenerateTextRequest | GatewayStructuredRequest;
}

/**
 * Dynamic handler returning a mock response synchronously or asynchronously.
 */
export type MockRoleHandler = (ctx: MockCallContext) => MockResponseSpec | Promise<MockResponseSpec>;

/**
 * Either a static {@link MockResponseSpec} or a dynamic {@link MockRoleHandler}.
 */
export type MockRoleInput = MockResponseSpec | MockRoleHandler;

/**
 * Per-role initial response configuration accepted by {@link MockModelProvider} and {@link createMockModelGateway}.
 */
export type MockHandlersMap = Partial<Record<AgentRole, MockRoleInput | readonly MockRoleInput[]>>;

/**
 * Recorded invocation snapshot exposed via {@link MockModelProvider.recordedCalls}.
 */
export interface RecordedMockCall {
  readonly callIndex: number;
  readonly method: MockCallMethod;
  readonly role: AgentRole;
  readonly config: RoleConnectionConfig;
  readonly messages: readonly ChatMessage[];
  readonly schema?: Record<string, unknown>;
  readonly schemaName?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
}

/**
 * Construction options for {@link MockModelProvider}.
 */
export interface MockModelProviderOptions {
  readonly handlers?: MockHandlersMap;
  readonly defaultHandler?: MockRoleInput;
  readonly defaultChunkSize?: number;
}

/**
 * {@link ModelGateway} specialization returned by {@link createMockModelGateway}
 * exposing the backing {@link MockModelProvider}.
 */
export class MockModelGateway extends ModelGateway {
  readonly mockProvider: MockModelProvider;

  constructor(mockProvider: MockModelProvider, options: Omit<ModelGatewayOptions, 'providers'> & { readonly providers?: ModelGatewayOptions['providers'] } = {}) {
    const mergedProviders = new Map(
      options.providers instanceof Map
        ? options.providers.entries()
        : options.providers !== undefined
          ? (Object.entries(options.providers).filter((entry): entry is [RoleConnectionConfig['provider'], ModelProvider] => entry[1] !== undefined))
          : []
    );
    mergedProviders.set('mock', mockProvider);

    super({
      ...options,
      providers: mergedProviders,
      defaultConnection: options.defaultConnection ?? {
        provider: 'mock',
        baseUrl: 'mock://local',
        model: 'mock-model',
        supportsJsonSchema: true,
      },
    });
    this.mockProvider = mockProvider;
  }
}

function splitDeterministicChunks(text: string, chunkSize: number): string[] {
  if (text.length === 0) {
    return [];
  }
  const size = Math.max(1, chunkSize);
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks;
}

function toProviderFailure(spec: MockErrorSpec): ProviderFailure {
  const status = spec.status;
  const retryable =
    spec.retryable ?? (status !== undefined ? status === 429 || (status >= 500 && status <= 599) : false);
  const code =
    spec.code ??
    (spec.isAbort
      ? 'ABORTED'
      : status === 429
        ? 'RATE_LIMITED'
        : status !== undefined
          ? `HTTP_${status}`
          : 'MOCK_ERROR');

  return {
    code,
    message: spec.message,
    status,
    retryable,
    isAbort: spec.isAbort,
  };
}

async function waitDelayWithSignals(
  delayMs: number | undefined,
  callerSignal: AbortSignal | undefined,
  timeoutMs: number | undefined
): Promise<'completed' | 'aborted' | 'timed_out'> {
  if (callerSignal?.aborted) {
    return 'aborted';
  }
  const hasTimeout = timeoutMs !== undefined && timeoutMs > 0;
  const effectiveDelay = delayMs ?? 0;

  if (effectiveDelay <= 0) {
    return 'completed';
  }

  return new Promise<'completed' | 'aborted' | 'timed_out'>((resolve) => {
    let settled = false;
    let delayTimer: ReturnType<typeof setTimeout> | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (): void => {
      if (delayTimer !== undefined) {
        clearTimeout(delayTimer);
      }
      if (timeoutTimer !== undefined) {
        clearTimeout(timeoutTimer);
      }
      callerSignal?.removeEventListener('abort', onAbort);
    };

    const onAbort = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve('aborted');
    };

    callerSignal?.addEventListener('abort', onAbort, { once: true });

    delayTimer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve('completed');
    }, effectiveDelay);

    if (hasTimeout) {
      timeoutTimer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve('timed_out');
      }, timeoutMs);
    }
  });
}

function toMockHandler(input: MockRoleInput): MockRoleHandler {
  if (typeof input === 'function') {
    return input;
  }
  return () => input;
}

/**
 * Deterministic offline {@link ModelProvider} supporting per-role FIFO queues,
 * persistent handlers, simulated stream chunks, error/timeout simulation, and call inspection.
 */
export class MockModelProvider implements ModelProvider {
  readonly kind = 'mock' as const;
  private readonly queues = new Map<AgentRole, MockRoleInput[]>();
  private readonly handlers = new Map<AgentRole, MockRoleHandler>();
  private defaultHandler: MockRoleHandler | undefined;
  private readonly calls: RecordedMockCall[] = [];
  private readonly defaultChunkSize: number;

  constructor(options: MockModelProviderOptions = {}) {
    this.defaultChunkSize = Math.max(1, options.defaultChunkSize ?? 8);
    if (options.defaultHandler !== undefined) {
      this.defaultHandler = toMockHandler(options.defaultHandler);
    }
    if (options.handlers !== undefined) {
      for (const [roleKey, entry] of Object.entries(options.handlers)) {
        if (entry === undefined) {
          continue;
        }
        const role = roleKey as AgentRole;
        if (Array.isArray(entry)) {
          this.enqueue(role, ...(entry as readonly MockRoleInput[]));
        } else {
          this.setHandler(role, toMockHandler(entry as MockRoleInput));
        }
      }
    }
  }

  /**
   * Append one or more mock responses to a role's FIFO queue.
   */
  enqueue(role: AgentRole, ...responses: readonly MockRoleInput[]): this {
    const queue = this.queues.get(role) ?? [];
    queue.push(...responses);
    this.queues.set(role, queue);
    return this;
  }

  /**
   * Register a persistent fallback handler for a specific role.
   */
  setHandler(role: AgentRole, handler: MockRoleInput): this {
    this.handlers.set(role, toMockHandler(handler));
    return this;
  }

  /**
   * Register a persistent fallback handler used when no role-specific entry exists.
   */
  setDefaultHandler(handler: MockRoleInput): this {
    this.defaultHandler = toMockHandler(handler);
    return this;
  }

  /**
   * Return a snapshot of all recorded calls in invocation order.
   */
  get recordedCalls(): readonly RecordedMockCall[] {
    return [...this.calls];
  }

  /**
   * Return all recorded calls targeting the given {@link AgentRole}.
   */
  getCallsForRole(role: AgentRole): readonly RecordedMockCall[] {
    return this.calls.filter((call) => call.role === role);
  }

  /**
   * Clear recorded call history without resetting queues or handlers.
   */
  clearRecordedCalls(): void {
    this.calls.length = 0;
  }

  /**
   * Clear all queued responses, handlers, default handler, and recorded calls.
   */
  reset(): void {
    this.queues.clear();
    this.handlers.clear();
    this.defaultHandler = undefined;
    this.calls.length = 0;
  }

  private recordCall(
    method: MockCallMethod,
    config: RoleConnectionConfig,
    req: GatewayGenerateTextRequest | GatewayStructuredRequest
  ): MockCallContext {
    const callIndex = this.calls.length;
    const clonedMessages: ChatMessage[] = req.messages.map((m) => ({ ...m }));
    const clonedConfig: RoleConnectionConfig = { ...config };
    const isStructured = 'schema' in req;

    const record: RecordedMockCall = {
      callIndex,
      method,
      role: req.role,
      config: clonedConfig,
      messages: clonedMessages,
      ...(isStructured ? { schema: { ...req.schema } } : {}),
      ...(isStructured && req.schemaName !== undefined ? { schemaName: req.schemaName } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
    };

    this.calls.push(record);

    return {
      callIndex,
      method,
      role: req.role,
      config: clonedConfig,
      request: req,
    };
  }

  private async resolveSpec(ctx: MockCallContext): Promise<Result<MockResponseSpec, ProviderFailure>> {
    const queue = this.queues.get(ctx.role);
    let selected: MockRoleInput | undefined;
    if (queue !== undefined && queue.length > 0) {
      selected = queue.shift();
    } else {
      selected = this.handlers.get(ctx.role) ?? this.defaultHandler;
    }

    if (selected === undefined) {
      return err({
        code: 'MOCK_NO_RESPONSE',
        message: `No mock response queued or handler registered for role '${ctx.role}'`,
        retryable: false,
      });
    }

    try {
      const resolved = typeof selected === 'function' ? await selected(ctx) : selected;
      return ok(resolved);
    } catch (caught) {
      if (ctx.request.signal?.aborted || (caught instanceof Error && caught.name === 'AbortError')) {
        return err({
          code: 'ABORTED',
          message: caught instanceof Error ? caught.message : 'Request was aborted',
          isAbort: true,
          retryable: false,
        });
      }
      return err({
        code: 'MOCK_HANDLER_THREW',
        message: caught instanceof Error ? caught.message : String(caught),
        retryable: false,
      });
    }
  }

  private async executeNonStreaming(
    method: 'generateText' | 'generateStructuredRaw',
    config: RoleConnectionConfig,
    req: GatewayGenerateTextRequest | GatewayStructuredRequest
  ): Promise<Result<string, ProviderFailure>> {
    const ctx = this.recordCall(method, config, req);
    if (req.signal?.aborted) {
      return err({ code: 'ABORTED', message: 'Request was aborted', isAbort: true, retryable: false });
    }

    const specResult = await this.resolveSpec(ctx);
    if (!specResult.ok) {
      return specResult;
    }

    const spec = specResult.value;
    const delayMs = typeof spec === 'string' ? undefined : spec.delayMs;
    const waitStatus = await waitDelayWithSignals(delayMs, req.signal, config.timeoutMs);
    if (waitStatus === 'aborted') {
      return err({ code: 'ABORTED', message: 'Request was aborted', isAbort: true, retryable: false });
    }
    if (waitStatus === 'timed_out') {
      return err({ code: 'TIMEOUT', message: `Request timed out after ${config.timeoutMs}ms`, retryable: false });
    }

    if (typeof spec === 'string') {
      return ok(spec);
    }

    switch (spec.kind) {
      case 'text':
        return ok(spec.text);
      case 'json':
        return ok(JSON.stringify(spec.value));
      case 'stream':
        return ok(spec.chunks.join(''));
      case 'error':
        return err(toProviderFailure(spec));
      case 'timeout':
        return err({
          code: 'TIMEOUT',
          message: spec.message ?? 'Simulated request timeout',
          retryable: false,
        });
    }
  }

  async generateText(
    config: RoleConnectionConfig,
    req: GatewayGenerateTextRequest
  ): Promise<Result<string, ProviderFailure>> {
    return this.executeNonStreaming('generateText', config, req);
  }

  async generateStructuredRaw(
    config: RoleConnectionConfig,
    req: GatewayStructuredRequest
  ): Promise<Result<string, ProviderFailure>> {
    return this.executeNonStreaming('generateStructuredRaw', config, req);
  }

  async *streamText(
    config: RoleConnectionConfig,
    req: GatewayGenerateTextRequest
  ): AsyncIterable<Result<StreamChunk, ProviderFailure>> {
    const ctx = this.recordCall('streamText', config, req);
    if (req.signal?.aborted) {
      yield err({ code: 'ABORTED', message: 'Request was aborted', isAbort: true, retryable: false });
      return;
    }

    const specResult = await this.resolveSpec(ctx);
    if (!specResult.ok) {
      yield specResult;
      return;
    }

    const spec = specResult.value;
    const delayMs = typeof spec === 'string' ? undefined : spec.delayMs;

    if (typeof spec !== 'string' && (spec.kind === 'error' || spec.kind === 'timeout')) {
      const waitStatus = await waitDelayWithSignals(delayMs, req.signal, config.timeoutMs);
      if (waitStatus === 'aborted') {
        yield err({ code: 'ABORTED', message: 'Request was aborted', isAbort: true, retryable: false });
        return;
      }
      if (waitStatus === 'timed_out' || spec.kind === 'timeout') {
        yield err({
          code: 'TIMEOUT',
          message: spec.kind === 'timeout' ? (spec.message ?? 'Simulated request timeout') : `Request timed out after ${config.timeoutMs}ms`,
          retryable: false,
        });
        return;
      }
      yield err(toProviderFailure(spec));
      return;
    }

    let chunks: readonly string[];
    let failAfterChunks: number | undefined;
    let streamFailure: MockErrorSpec | undefined;

    if (typeof spec === 'string') {
      chunks = splitDeterministicChunks(spec, this.defaultChunkSize);
    } else if (spec.kind === 'text') {
      chunks = spec.chunks ?? splitDeterministicChunks(spec.text, this.defaultChunkSize);
    } else if (spec.kind === 'json') {
      chunks = spec.chunks ?? splitDeterministicChunks(JSON.stringify(spec.value), this.defaultChunkSize);
    } else {
      chunks = spec.chunks;
      failAfterChunks = spec.failAfterChunks;
      streamFailure = spec.failure;
    }

    const streamDeadline =
      config.timeoutMs !== undefined && config.timeoutMs > 0
        ? Date.now() + config.timeoutMs
        : undefined;

    for (let i = 0; i < chunks.length; i += 1) {
      if (failAfterChunks !== undefined && i >= failAfterChunks) {
        yield err(
          toProviderFailure(
            streamFailure ?? {
              code: 'MOCK_STREAM_ERROR',
              message: `Simulated mid-stream failure after ${failAfterChunks} chunk(s)`,
              retryable: false,
            }
          )
        );
        return;
      }

      let remainingTimeoutMs: number | undefined;
      if (streamDeadline !== undefined) {
        const remaining = streamDeadline - Date.now();
        if (remaining <= 0) {
          yield err({
            code: 'TIMEOUT',
            message: `Request timed out after ${config.timeoutMs}ms`,
            retryable: false,
          });
          return;
        }
        remainingTimeoutMs = remaining;
      }

      const waitStatus = await waitDelayWithSignals(delayMs, req.signal, remainingTimeoutMs);
      if (waitStatus === 'aborted') {
        yield err({ code: 'ABORTED', message: 'Request was aborted', isAbort: true, retryable: false });
        return;
      }
      if (waitStatus === 'timed_out') {
        yield err({
          code: 'TIMEOUT',
          message: `Request timed out after ${config.timeoutMs}ms`,
          retryable: false,
        });
        return;
      }

      const chunkText = chunks[i] ?? '';
      yield ok({ text: chunkText, done: false });
    }

    if (failAfterChunks !== undefined && chunks.length <= failAfterChunks && streamFailure !== undefined) {
      yield err(toProviderFailure(streamFailure));
      return;
    }

    yield ok({ text: '', done: true });
  }
}

/**
 * Convenience factory constructing a {@link MockModelGateway} backed by a {@link MockModelProvider}.
 */
export function createMockModelGateway(
  handlersOrProvider?: MockModelProvider | MockHandlersMap,
  options: Omit<ModelGatewayOptions, 'providers'> & { readonly providers?: ModelGatewayOptions['providers'] } = {}
): MockModelGateway {
  const provider =
    handlersOrProvider instanceof MockModelProvider
      ? handlersOrProvider
      : new MockModelProvider({ handlers: handlersOrProvider });

  return new MockModelGateway(provider, options);
}
