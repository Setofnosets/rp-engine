import { ValidationError, formatValidationErrors, validationError } from '../core/errors.js';
import { Result, err, ok } from '../core/result.js';
import { extractAndRepairJsonDetailed, validateAgainstJsonSchema } from './json-repair.js';
import {
  AgentRole,
  ChatMessage,
  GatewayGenerateTextRequest,
  GatewayStructuredOutput,
  GatewayStructuredRequest,
  ModelProvider,
  ProviderFailure,
  ProviderKind,
  RoleConnectionConfig,
  StreamChunk,
} from './types.js';

/**
 * Configuration options for {@link ModelGateway}.
 */
export interface ModelGatewayOptions {
  readonly connections?:
    | ReadonlyMap<AgentRole, RoleConnectionConfig>
    | Partial<Record<AgentRole, RoleConnectionConfig>>;
  readonly defaultConnection?: Omit<RoleConnectionConfig, 'role'> & { readonly role?: AgentRole };
  readonly providers?:
    | ReadonlyMap<ProviderKind, ModelProvider>
    | Partial<Record<ProviderKind, ModelProvider>>;
  readonly maxRetries?: number;
  readonly baseRetryDelayMs?: number;
  readonly defaultMaxRepairAttempts?: number;
  readonly fetchImpl?: typeof fetch;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.name === 'AbortError';
}

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.name === 'TimeoutError';
}

function extractTextFromChoiceContainer(choice: unknown, field: 'message' | 'delta'): string | undefined {
  if (!isPlainRecord(choice)) {
    return undefined;
  }
  const container = choice[field];
  if (!isPlainRecord(container)) {
    return undefined;
  }
  const content = container.content;
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (isPlainRecord(part) && typeof part.text === 'string') {
        parts.push(part.text);
      }
    }
    if (parts.length > 0) {
      return parts.join('');
    }
  }
  return undefined;
}

function extractOpenAIMessageContent(payload: unknown): string | undefined {
  if (!isPlainRecord(payload) || !Array.isArray(payload.choices) || payload.choices.length === 0) {
    return undefined;
  }
  return extractTextFromChoiceContainer(payload.choices[0], 'message');
}

function extractOpenAIStreamDelta(payload: unknown): string | undefined {
  if (!isPlainRecord(payload) || !Array.isArray(payload.choices) || payload.choices.length === 0) {
    return undefined;
  }
  const firstChoice = payload.choices[0];
  return (
    extractTextFromChoiceContainer(firstChoice, 'delta') ??
    extractTextFromChoiceContainer(firstChoice, 'message')
  );
}

interface CombinedSignalHandle {
  readonly signal: AbortSignal | undefined;
  readonly isTimedOut: () => boolean;
  readonly cleanup: () => void;
}

function createCombinedSignal(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number | undefined
): CombinedSignalHandle {
  if (timeoutMs === undefined || timeoutMs <= 0) {
    return {
      signal: callerSignal,
      isTimedOut: () => false,
      cleanup: () => {},
    };
  }

  const controller = new AbortController();
  let timedOut = false;

  const onCallerAbort = (): void => {
    controller.abort(callerSignal?.reason);
  };

  if (callerSignal !== undefined) {
    if (callerSignal.aborted) {
      controller.abort(callerSignal.reason);
    } else {
      callerSignal.addEventListener('abort', onCallerAbort, { once: true });
    }
  }

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException(`Request timed out after ${timeoutMs}ms`, 'TimeoutError'));
  }, timeoutMs);

  return {
    signal: controller.signal,
    isTimedOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onCallerAbort);
    },
  };
}

function classifyHttpFailure(status: number, bodyText: string): ProviderFailure {
  const retryable = status === 429 || (status >= 500 && status <= 599);
  const code = status === 429 ? 'RATE_LIMITED' : `HTTP_${status}`;
  const detail = bodyText.trim();
  const message =
    detail.length > 0 ? `Provider returned HTTP ${status}: ${detail}` : `Provider returned HTTP ${status}`;
  return {
    code,
    message,
    status,
    retryable,
  };
}

function classifyCaughtProviderError(
  caught: unknown,
  callerSignal?: AbortSignal,
  isTimedOut?: () => boolean
): ProviderFailure {
  if (callerSignal?.aborted || isAbortError(caught)) {
    return {
      code: 'ABORTED',
      message: caught instanceof Error && caught.message.length > 0 ? caught.message : 'Request was aborted',
      isAbort: true,
      retryable: false,
    };
  }
  if (isTimedOut?.() || isTimeoutError(caught)) {
    return {
      code: 'TIMEOUT',
      message: caught instanceof Error && caught.message.length > 0 ? caught.message : 'Request timed out',
      retryable: false,
    };
  }
  return {
    code: 'NETWORK_ERROR',
    message: caught instanceof Error ? caught.message : String(caught),
    retryable: true,
  };
}

function sleepWithAbort(delayMs: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) {
    return Promise.resolve(false);
  }
  if (delayMs <= 0) {
    return Promise.resolve().then(() => !signal?.aborted);
  }
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, delayMs);

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Built-in provider targeting OpenAI-compatible `/chat/completions` endpoints via native `fetch`.
 */
export class OpenAICompatibleProvider implements ModelProvider {
  readonly kind = 'openai_compatible' as const;
  private readonly customFetch: typeof fetch | undefined;

  constructor(fetchImpl?: typeof fetch) {
    this.customFetch = fetchImpl;
  }

  private invokeFetch(url: string, init: RequestInit): Promise<Response> {
    if (this.customFetch !== undefined) {
      return this.customFetch(url, init);
    }
    if (typeof globalThis.fetch !== 'function') {
      throw new Error('Global fetch is unavailable in the current runtime');
    }
    return globalThis.fetch(url, init);
  }

  private buildEndpointUrl(baseUrl: string): string {
    const normalized = baseUrl.replace(/\/+$/, '');
    if (normalized.endsWith('/chat/completions')) {
      return normalized;
    }
    return `${normalized}/chat/completions`;
  }

  private buildHeaders(config: RoleConnectionConfig): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (config.apiKey !== undefined && config.apiKey.length > 0) {
      headers.Authorization = `Bearer ${config.apiKey}`;
    }
    return headers;
  }

  private buildRequestBody(
    config: RoleConnectionConfig,
    req: GatewayGenerateTextRequest | GatewayStructuredRequest,
    stream: boolean,
    structuredReq?: GatewayStructuredRequest
  ): Record<string, unknown> {
    const temperature = req.temperature ?? config.temperature;
    const maxTokens = req.maxTokens ?? config.maxTokens;

    const body: Record<string, unknown> = {
      model: config.model,
      messages: req.messages.map((msg) =>
        msg.name !== undefined
          ? { role: msg.role, content: msg.content, name: msg.name }
          : { role: msg.role, content: msg.content }
      ),
      stream,
    };

    if (temperature !== undefined) {
      body.temperature = temperature;
    }
    if (maxTokens !== undefined) {
      body.max_tokens = maxTokens;
    }

    if (structuredReq !== undefined && config.supportsJsonSchema === true) {
      body.response_format = {
        type: 'json_schema',
        json_schema: {
          name: structuredReq.schemaName ?? 'structured_output',
          strict: true,
          schema: structuredReq.schema,
        },
      };
    }

    return body;
  }

  private async executeCompletion(
    config: RoleConnectionConfig,
    req: GatewayGenerateTextRequest | GatewayStructuredRequest,
    structuredReq?: GatewayStructuredRequest
  ): Promise<Result<string, ProviderFailure>> {
    if (req.signal?.aborted) {
      return err({ code: 'ABORTED', message: 'Request was aborted', isAbort: true, retryable: false });
    }

    const signalHandle = createCombinedSignal(req.signal, config.timeoutMs);
    try {
      const response = await this.invokeFetch(this.buildEndpointUrl(config.baseUrl), {
        method: 'POST',
        headers: this.buildHeaders(config),
        body: JSON.stringify(this.buildRequestBody(config, req, false, structuredReq)),
        signal: signalHandle.signal,
      });

      if (!response.ok) {
        const bodyText = await response.text().catch(() => '');
        return err(classifyHttpFailure(response.status, bodyText));
      }

      let payload: unknown;
      try {
        payload = (await response.json()) as unknown;
      } catch (caught) {
        return err({
          code: 'INVALID_PROVIDER_RESPONSE',
          message: `Failed to decode provider JSON response: ${caught instanceof Error ? caught.message : String(caught)}`,
          retryable: false,
        });
      }

      const content = extractOpenAIMessageContent(payload);
      if (content === undefined) {
        return err({
          code: 'INVALID_PROVIDER_RESPONSE',
          message: 'Provider response did not include choices[0].message.content',
          retryable: false,
        });
      }

      return ok(content);
    } catch (caught) {
      return err(classifyCaughtProviderError(caught, req.signal, signalHandle.isTimedOut));
    } finally {
      signalHandle.cleanup();
    }
  }

  async generateText(
    config: RoleConnectionConfig,
    req: GatewayGenerateTextRequest
  ): Promise<Result<string, ProviderFailure>> {
    return this.executeCompletion(config, req);
  }

  async generateStructuredRaw(
    config: RoleConnectionConfig,
    req: GatewayStructuredRequest
  ): Promise<Result<string, ProviderFailure>> {
    return this.executeCompletion(config, req, req);
  }

  async *streamText(
    config: RoleConnectionConfig,
    req: GatewayGenerateTextRequest
  ): AsyncIterable<Result<StreamChunk, ProviderFailure>> {
    if (req.signal?.aborted) {
      yield err({ code: 'ABORTED', message: 'Request was aborted', isAbort: true, retryable: false });
      return;
    }

    const signalHandle = createCombinedSignal(req.signal, config.timeoutMs);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

    try {
      const response = await this.invokeFetch(this.buildEndpointUrl(config.baseUrl), {
        method: 'POST',
        headers: this.buildHeaders(config),
        body: JSON.stringify(this.buildRequestBody(config, req, true)),
        signal: signalHandle.signal,
      });

      if (!response.ok) {
        const bodyText = await response.text().catch(() => '');
        yield err(classifyHttpFailure(response.status, bodyText));
        return;
      }

      if (response.body === null) {
        yield err({
          code: 'EMPTY_RESPONSE_BODY',
          message: 'Streaming response did not include a readable body',
          retryable: false,
        });
        return;
      }

      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let lineBuffer = '';
      let emittedDone = false;

      while (true) {
        if (req.signal?.aborted) {
          yield err({ code: 'ABORTED', message: 'Request was aborted', isAbort: true, retryable: false });
          return;
        }

        const { value, done } = await reader.read();
        if (done) {
          break;
        }

        lineBuffer += decoder.decode(value, { stream: true });
        const lines = lineBuffer.split(/\r?\n/);
        lineBuffer = lines.pop() ?? '';

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (line.length === 0 || line.startsWith(':')) {
            continue;
          }
          if (!line.startsWith('data:')) {
            continue;
          }
          const payloadText = line.slice(5).trim();
          if (payloadText === '[DONE]') {
            emittedDone = true;
            yield ok({ text: '', done: true });
            return;
          }

          let parsedChunk: unknown;
          try {
            parsedChunk = JSON.parse(payloadText) as unknown;
          } catch (caught) {
            yield err({
              code: 'INVALID_STREAM_PAYLOAD',
              message: `Malformed SSE JSON chunk: ${caught instanceof Error ? caught.message : String(caught)}`,
              retryable: false,
            });
            return;
          }

          const delta = extractOpenAIStreamDelta(parsedChunk);
          if (delta !== undefined && delta.length > 0) {
            yield ok({ text: delta, done: false });
          }
        }
      }

      const trailing = (lineBuffer + decoder.decode()).trim();
      if (trailing.startsWith('data:')) {
        const payloadText = trailing.slice(5).trim();
        if (payloadText === '[DONE]') {
          emittedDone = true;
          yield ok({ text: '', done: true });
          return;
        }
        if (payloadText.length > 0) {
          let parsedChunk: unknown;
          try {
            parsedChunk = JSON.parse(payloadText) as unknown;
          } catch (caught) {
            yield err({
              code: 'INVALID_STREAM_PAYLOAD',
              message: `Malformed trailing SSE JSON chunk: ${caught instanceof Error ? caught.message : String(caught)}`,
              retryable: false,
            });
            return;
          }
          const delta = extractOpenAIStreamDelta(parsedChunk);
          if (delta !== undefined && delta.length > 0) {
            yield ok({ text: delta, done: false });
          }
        }
      }

      if (!emittedDone) {
        yield ok({ text: '', done: true });
      }
    } catch (caught) {
      yield err(classifyCaughtProviderError(caught, req.signal, signalHandle.isTimedOut));
    } finally {
      if (reader !== undefined) {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      signalHandle.cleanup();
    }
  }
}

/**
 * Per-role model gateway supporting provider routing, bounded retries, streaming,
 * and schema-validated structured JSON generation with automated repair.
 */
export class ModelGateway {
  private readonly connections: Map<AgentRole, RoleConnectionConfig>;
  private defaultConnection: (Omit<RoleConnectionConfig, 'role'> & { readonly role?: AgentRole }) | undefined;
  private readonly providers: Map<ProviderKind, ModelProvider>;
  private readonly maxRetries: number;
  private readonly baseRetryDelayMs: number;
  private readonly defaultMaxRepairAttempts: number;

  constructor(options: ModelGatewayOptions = {}) {
    this.connections = new Map<AgentRole, RoleConnectionConfig>();
    if (options.connections !== undefined) {
      if (options.connections instanceof Map) {
        for (const [role, config] of options.connections.entries()) {
          this.connections.set(role, { ...config, role });
        }
      } else {
        for (const [roleKey, config] of Object.entries(options.connections)) {
          if (config !== undefined) {
            const role = roleKey as AgentRole;
            this.connections.set(role, { ...config, role });
          }
        }
      }
    }

    this.defaultConnection = options.defaultConnection !== undefined ? { ...options.defaultConnection } : undefined;

    this.providers = new Map<ProviderKind, ModelProvider>([
      ['openai_compatible', new OpenAICompatibleProvider(options.fetchImpl)],
    ]);

    if (options.providers !== undefined) {
      if (options.providers instanceof Map) {
        for (const [kind, provider] of options.providers.entries()) {
          this.providers.set(kind, provider);
        }
      } else {
        for (const [kindKey, provider] of Object.entries(options.providers)) {
          if (provider !== undefined) {
            this.providers.set(kindKey as ProviderKind, provider);
          }
        }
      }
    }

    this.maxRetries = Math.max(0, options.maxRetries ?? 2);
    this.baseRetryDelayMs = Math.max(0, options.baseRetryDelayMs ?? 50);
    this.defaultMaxRepairAttempts = Math.max(0, options.defaultMaxRepairAttempts ?? 0);
  }

  /**
   * Update the fallback default connection at runtime.
   */
  setDefaultConnection(
    config: (Omit<RoleConnectionConfig, 'role'> & { readonly role?: AgentRole }) | undefined
  ): void {
    this.defaultConnection = config !== undefined ? { ...config } : undefined;
  }

  /**
   * Set or update the connection profile for a specific {@link AgentRole} at runtime.
   */
  setRoleConnection(role: AgentRole, config: Omit<RoleConnectionConfig, 'role'>): void {
    this.connections.set(role, { ...config, role });
  }

  /**
   * Return a snapshot of the configured default and per-role connections.
   */
  getConnectionsSnapshot(): {
    readonly defaultConnection?: Omit<RoleConnectionConfig, 'role'> & { readonly role?: AgentRole };
    readonly connections: Partial<Record<AgentRole, RoleConnectionConfig>>;
  } {
    const connections: Partial<Record<AgentRole, RoleConnectionConfig>> = {};
    for (const [role, cfg] of this.connections.entries()) {
      connections[role] = { ...cfg };
    }
    return {
      ...(this.defaultConnection !== undefined
        ? { defaultConnection: { ...this.defaultConnection } }
        : {}),
      connections,
    };
  }

  /**
   * Resolve the effective connection config for a given {@link AgentRole}.
   */
  resolveConnection(role: AgentRole): Result<RoleConnectionConfig, ValidationError[]> {
    const specific = this.connections.get(role);
    if (specific !== undefined) {
      return ok({ ...specific });
    }
    if (this.defaultConnection !== undefined) {
      return ok({ ...this.defaultConnection, role });
    }
    return err([
      validationError('role', 'MISSING_ROLE_CONFIG', `No model connection configured for role '${role}'`),
    ]);
  }

  private resolveRoute(
    role: AgentRole
  ): Result<{ readonly config: RoleConnectionConfig; readonly provider: ModelProvider }, ValidationError[]> {
    const connResult = this.resolveConnection(role);
    if (!connResult.ok) {
      return connResult;
    }
    const config = connResult.value;
    const provider = this.providers.get(config.provider);
    if (provider === undefined) {
      return err([
        validationError(
          'provider',
          'UNSUPPORTED_PROVIDER',
          `No provider registered for '${config.provider}' (role '${role}')`
        ),
      ]);
    }
    return ok({ config, provider });
  }

  private isRetryableFailure(failure: ProviderFailure, signal?: AbortSignal): boolean {
    if (signal?.aborted || failure.isAbort) {
      return false;
    }
    if (failure.status !== undefined) {
      return failure.status === 429 || (failure.status >= 500 && failure.status <= 599);
    }
    return failure.retryable === true;
  }

  private toValidationErrors(failure: ProviderFailure): ValidationError[] {
    const message =
      failure.status !== undefined ? `[HTTP ${failure.status}] ${failure.message}` : failure.message;
    return [validationError('', failure.code, message)];
  }

  private async executeWithRetries<T>(
    signal: AbortSignal | undefined,
    operation: () => Promise<Result<T, ProviderFailure>>
  ): Promise<Result<T, ValidationError[]>> {
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      if (signal?.aborted) {
        return err([validationError('', 'ABORTED', 'Request was aborted')]);
      }

      let outcome: Result<T, ProviderFailure>;
      try {
        outcome = await operation();
      } catch (caught) {
        outcome = err(classifyCaughtProviderError(caught, signal));
      }

      if (outcome.ok) {
        return outcome;
      }

      const failure = outcome.error;
      if (attempt < this.maxRetries && this.isRetryableFailure(failure, signal)) {
        const delayMs = this.baseRetryDelayMs * 2 ** attempt;
        const completedWait = await sleepWithAbort(delayMs, signal);
        if (!completedWait) {
          return err([validationError('', 'ABORTED', 'Request was aborted during retry backoff')]);
        }
        continue;
      }

      return err(this.toValidationErrors(failure));
    }

    return err([validationError('', 'RETRY_EXHAUSTED', 'Exhausted retry attempts')]);
  }

  /**
   * Generate text for the requested {@link AgentRole} with bounded retries on 429/5xx failures.
   */
  async generateText(req: GatewayGenerateTextRequest): Promise<Result<string, ValidationError[]>> {
    const route = this.resolveRoute(req.role);
    if (!route.ok) {
      return route;
    }
    const { config, provider } = route.value;
    return this.executeWithRetries(req.signal, () => provider.generateText(config, req));
  }

  /**
   * Stream text chunks for the requested {@link AgentRole}, retrying pre-chunk 429/5xx failures.
   */
  async *streamText(
    req: GatewayGenerateTextRequest
  ): AsyncGenerator<Result<StreamChunk, ValidationError[]>> {
    const route = this.resolveRoute(req.role);
    if (!route.ok) {
      yield route;
      return;
    }
    const { config, provider } = route.value;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      if (req.signal?.aborted) {
        yield err([validationError('', 'ABORTED', 'Request was aborted')]);
        return;
      }

      let emittedAnyChunk = false;
      let retryableFailure: ProviderFailure | undefined;

      try {
        for await (const chunkResult of provider.streamText(config, req)) {
          if (chunkResult.ok) {
            emittedAnyChunk = true;
            yield ok(chunkResult.value);
            continue;
          }

          const failure = chunkResult.error;
          if (!emittedAnyChunk && attempt < this.maxRetries && this.isRetryableFailure(failure, req.signal)) {
            retryableFailure = failure;
            break;
          }

          yield err(this.toValidationErrors(failure));
          return;
        }
      } catch (caught) {
        const failure = classifyCaughtProviderError(caught, req.signal);
        if (!emittedAnyChunk && attempt < this.maxRetries && this.isRetryableFailure(failure, req.signal)) {
          retryableFailure = failure;
        } else {
          yield err(this.toValidationErrors(failure));
          return;
        }
      }

      if (retryableFailure !== undefined) {
        const delayMs = this.baseRetryDelayMs * 2 ** attempt;
        const completedWait = await sleepWithAbort(delayMs, req.signal);
        if (!completedWait) {
          yield err([validationError('', 'ABORTED', 'Request was aborted during retry backoff')]);
          return;
        }
        continue;
      }

      return;
    }
  }

  private validateStructuredRawText<T>(
    rawText: string,
    schema: Record<string, unknown>
  ): Result<GatewayStructuredOutput<T>, ValidationError[]> {
    const repairedJson = extractAndRepairJsonDetailed(rawText);
    if (!repairedJson.ok) {
      return repairedJson;
    }

    const schemaResult = validateAgainstJsonSchema(repairedJson.value.value, schema);
    if (!schemaResult.ok) {
      return schemaResult;
    }

    return ok({
      data: schemaResult.value as T,
      rawText,
      repaired: repairedJson.value.repaired,
    });
  }

  /**
   * Generate structured JSON output for the requested {@link AgentRole}, applying
   * deterministic JSON extraction/repair, JSON Schema validation, and optional LLM repair turns.
   */
  async generateStructured<T>(
    req: GatewayStructuredRequest
  ): Promise<Result<GatewayStructuredOutput<T>, ValidationError[]>> {
    const route = this.resolveRoute(req.role);
    if (!route.ok) {
      return route;
    }
    const { config, provider } = route.value;

    const initialRaw = await this.executeWithRetries(req.signal, () =>
      provider.generateStructuredRaw(config, req)
    );
    if (!initialRaw.ok) {
      return initialRaw;
    }

    let lastRawText = initialRaw.value;
    const initialValidated = this.validateStructuredRawText<T>(lastRawText, req.schema);
    if (initialValidated.ok) {
      return initialValidated;
    }

    let lastErrors = initialValidated.error;
    let conversation: ChatMessage[] = [...req.messages];
    const maxRepairAttempts = Math.max(0, req.maxRepairAttempts ?? this.defaultMaxRepairAttempts);

    for (let repairAttempt = 0; repairAttempt < maxRepairAttempts; repairAttempt += 1) {
      if (req.signal?.aborted) {
        return err([validationError('', 'ABORTED', 'Request was aborted')]);
      }

      const repairPrompt: ChatMessage[] = [
        ...conversation,
        { role: 'assistant', content: lastRawText },
        {
          role: 'user',
          content: [
            'Your previous output was invalid. Repair it and respond ONLY with valid JSON conforming to the schema.',
            `Validation errors: ${formatValidationErrors(lastErrors)}`,
            `Schema: ${JSON.stringify(req.schema)}`,
          ].join('\n'),
        },
      ];

      const repairReq: GatewayStructuredRequest = {
        ...req,
        messages: repairPrompt,
      };

      const repairRaw = await this.executeWithRetries(req.signal, () =>
        provider.generateStructuredRaw(config, repairReq)
      );
      if (!repairRaw.ok) {
        return repairRaw;
      }

      lastRawText = repairRaw.value;
      const repairedValidated = this.validateStructuredRawText<T>(lastRawText, req.schema);
      if (repairedValidated.ok) {
        return ok({
          data: repairedValidated.value.data,
          rawText: lastRawText,
          repaired: true,
        });
      }

      lastErrors = repairedValidated.error;
      conversation = repairPrompt;
    }

    return err(lastErrors);
  }
}
