import { ValidationError, formatValidationErrors, validationError } from '../core/errors.js';
import { Result, err, ok } from '../core/result.js';
import { extractAndRepairJsonDetailed, validateAgainstJsonSchema } from './json-repair.js';
import { AnthropicProvider } from './providers/anthropic-provider.js';
import { GeminiProvider } from './providers/gemini-provider.js';
import { OllamaProvider } from './providers/ollama-provider.js';
import {
  classifyCaughtProviderError,
  classifyHttpFailure,
  clonePartialSampler,
  createCombinedSignal,
  invokeFetch,
  isPlainRecord,
  readSseEvents,
  resolveEffectiveSampler,
  sleepWithAbort,
} from './providers/provider-utils.js';
import {
  AgentRole,
  ChatMessage,
  ConnectionPreset,
  GatewayGenerateTextRequest,
  GatewayStructuredOutput,
  GatewayStructuredRequest,
  ModelProvider,
  ProviderFailure,
  ProviderKind,
  RoleConnectionConfig,
  SamplerPreset,
  StreamChunk,
} from './types.js';

export { AnthropicProvider, GeminiProvider, OllamaProvider };

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
  readonly connectionPresets?: readonly ConnectionPreset[];
  readonly samplerPresets?: readonly SamplerPreset[];
  readonly maxRetries?: number;
  readonly baseRetryDelayMs?: number;
  readonly defaultMaxRepairAttempts?: number;
  readonly fetchImpl?: typeof fetch;
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

function cloneSamplerPreset(preset: SamplerPreset): SamplerPreset {
  const normalized = clonePartialSampler(preset);
  return {
    ...normalized,
    id: preset.id,
    name: preset.name,
  };
}

function cloneConnectionPreset(preset: ConnectionPreset): ConnectionPreset {
  return { ...preset };
}

function cloneRoleConnectionConfig(
  config: Omit<RoleConnectionConfig, 'role'> & { readonly role?: AgentRole }
): Omit<RoleConnectionConfig, 'role'> & { readonly role?: AgentRole } {
  return {
    ...config,
    ...(config.sampler !== undefined ? { sampler: clonePartialSampler(config.sampler) } : {}),
  };
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
    const sampler = resolveEffectiveSampler(config, req);

    const body: Record<string, unknown> = {
      model: config.model,
      messages: req.messages.map((msg) =>
        msg.name !== undefined
          ? { role: msg.role, content: msg.content, name: msg.name }
          : { role: msg.role, content: msg.content }
      ),
      stream,
    };

    if (sampler.temperature !== undefined) {
      body.temperature = sampler.temperature;
    }
    if (sampler.topP !== undefined) {
      body.top_p = sampler.topP;
    }
    if (sampler.frequencyPenalty !== undefined) {
      body.frequency_penalty = sampler.frequencyPenalty;
    }
    if (sampler.presencePenalty !== undefined) {
      body.presence_penalty = sampler.presencePenalty;
    }
    if (sampler.maxTokens !== undefined) {
      body.max_tokens = sampler.maxTokens;
    }
    if (sampler.stop !== undefined && sampler.stop.length > 0) {
      body.stop = [...sampler.stop];
    }
    if (sampler.seed !== undefined) {
      body.seed = sampler.seed;
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
      const response = await invokeFetch(this.customFetch, this.buildEndpointUrl(config.baseUrl), {
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
    try {
      const response = await invokeFetch(this.customFetch, this.buildEndpointUrl(config.baseUrl), {
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

      let emittedDone = false;
      for await (const frameResult of readSseEvents(response, req.signal, signalHandle.isTimedOut)) {
        if (!frameResult.ok) {
          yield frameResult;
          return;
        }

        const payloadText = frameResult.value.data.trim();
        if (payloadText.length === 0) {
          continue;
        }
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

      if (!emittedDone) {
        yield ok({ text: '', done: true });
      }
    } catch (caught) {
      yield err(classifyCaughtProviderError(caught, req.signal, signalHandle.isTimedOut));
    } finally {
      signalHandle.cleanup();
    }
  }
}

/**
 * Per-role model gateway supporting provider routing, presets, bounded retries, streaming,
 * and schema-validated structured JSON generation with automated repair.
 */
export class ModelGateway {
  private readonly connections: Map<AgentRole, RoleConnectionConfig>;
  private defaultConnection: (Omit<RoleConnectionConfig, 'role'> & { readonly role?: AgentRole }) | undefined;
  private readonly providers: Map<ProviderKind, ModelProvider>;
  private readonly connectionPresets: Map<string, ConnectionPreset>;
  private readonly samplerPresets: Map<string, SamplerPreset>;
  private readonly maxRetries: number;
  private readonly baseRetryDelayMs: number;
  private readonly defaultMaxRepairAttempts: number;

  constructor(options: ModelGatewayOptions = {}) {
    this.connections = new Map<AgentRole, RoleConnectionConfig>();
    if (options.connections !== undefined) {
      if (options.connections instanceof Map) {
        for (const [role, config] of options.connections.entries()) {
          this.connections.set(role, { ...cloneRoleConnectionConfig(config), role });
        }
      } else {
        for (const [roleKey, config] of Object.entries(options.connections)) {
          if (config !== undefined) {
            const role = roleKey as AgentRole;
            this.connections.set(role, { ...cloneRoleConnectionConfig(config), role });
          }
        }
      }
    }

    this.defaultConnection =
      options.defaultConnection !== undefined
        ? cloneRoleConnectionConfig(options.defaultConnection)
        : undefined;

    const openAiProvider = new OpenAICompatibleProvider(options.fetchImpl);
    this.providers = new Map<ProviderKind, ModelProvider>([
      ['openai_compatible', openAiProvider],
      ['openai', openAiProvider],
      ['anthropic', new AnthropicProvider(options.fetchImpl)],
      ['gemini', new GeminiProvider(options.fetchImpl)],
      ['ollama', new OllamaProvider(options.fetchImpl, openAiProvider)],
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

    this.connectionPresets = new Map<string, ConnectionPreset>();
    if (options.connectionPresets !== undefined) {
      for (const preset of options.connectionPresets) {
        this.connectionPresets.set(preset.id, cloneConnectionPreset(preset));
      }
    }

    this.samplerPresets = new Map<string, SamplerPreset>();
    if (options.samplerPresets !== undefined) {
      for (const preset of options.samplerPresets) {
        this.samplerPresets.set(preset.id, cloneSamplerPreset(preset));
      }
    }

    this.maxRetries = Math.max(0, options.maxRetries ?? 2);
    this.baseRetryDelayMs = Math.max(0, options.baseRetryDelayMs ?? 50);
    this.defaultMaxRepairAttempts = Math.max(0, options.defaultMaxRepairAttempts ?? 0);
  }

  /**
   * Register or update a reusable {@link SamplerPreset}.
   */
  registerSamplerPreset(preset: SamplerPreset): void {
    this.samplerPresets.set(preset.id, cloneSamplerPreset(preset));
  }

  /**
   * Look up a registered {@link SamplerPreset} by ID.
   */
  getSamplerPreset(id: string): SamplerPreset | undefined {
    const preset = this.samplerPresets.get(id);
    return preset !== undefined ? cloneSamplerPreset(preset) : undefined;
  }

  /**
   * Return all registered {@link SamplerPreset} definitions.
   */
  listSamplerPresets(): SamplerPreset[] {
    return Array.from(this.samplerPresets.values(), cloneSamplerPreset);
  }

  /**
   * Register or update a reusable {@link ConnectionPreset}.
   */
  registerConnectionPreset(preset: ConnectionPreset): void {
    this.connectionPresets.set(preset.id, cloneConnectionPreset(preset));
  }

  /**
   * Look up a registered {@link ConnectionPreset} by ID.
   */
  getConnectionPreset(id: string): ConnectionPreset | undefined {
    const preset = this.connectionPresets.get(id);
    return preset !== undefined ? cloneConnectionPreset(preset) : undefined;
  }

  /**
   * Return all registered {@link ConnectionPreset} definitions.
   */
  listConnectionPresets(): ConnectionPreset[] {
    return Array.from(this.connectionPresets.values(), cloneConnectionPreset);
  }

  /**
   * Bind a registered {@link ConnectionPreset} to a specific {@link AgentRole}.
   */
  applyConnectionPreset(
    role: AgentRole,
    presetId: string,
    env: Readonly<Record<string, string | undefined>> = typeof process !== 'undefined' ? process.env : {}
  ): Result<RoleConnectionConfig, ValidationError[]> {
    const preset = this.connectionPresets.get(presetId);
    if (preset === undefined) {
      return err([
        validationError('presetId', 'UNKNOWN_CONNECTION_PRESET', `Unknown connection preset '${presetId}'`),
      ]);
    }

    const resolvedApiKey =
      preset.apiKey !== undefined && preset.apiKey.length > 0
        ? preset.apiKey
        : preset.apiKeyEnv !== undefined &&
            preset.apiKeyEnv.length > 0 &&
            Object.hasOwn(env, preset.apiKeyEnv)
          ? env[preset.apiKeyEnv]
          : undefined;

    const config: Omit<RoleConnectionConfig, 'role'> = {
      provider: preset.provider,
      baseUrl: preset.baseUrl,
      model: preset.model,
      ...(resolvedApiKey !== undefined && resolvedApiKey.length > 0 ? { apiKey: resolvedApiKey } : {}),
      ...(preset.samplerPresetId !== undefined ? { samplerPresetId: preset.samplerPresetId } : {}),
      ...(preset.enablePromptCache !== undefined ? { enablePromptCache: preset.enablePromptCache } : {}),
      ...(preset.timeoutMs !== undefined ? { timeoutMs: preset.timeoutMs } : {}),
      ...(preset.supportsJsonSchema !== undefined ? { supportsJsonSchema: preset.supportsJsonSchema } : {}),
    };

    this.setRoleConnection(role, config);
    return this.resolveConnection(role);
  }

  /**
   * Attach a registered {@link SamplerPreset} to an existing {@link AgentRole} connection.
   */
  applySamplerPreset(role: AgentRole, samplerPresetId: string): Result<RoleConnectionConfig, ValidationError[]> {
    const preset = this.samplerPresets.get(samplerPresetId);
    if (preset === undefined) {
      return err([
        validationError(
          'samplerPresetId',
          'UNKNOWN_SAMPLER_PRESET',
          `Unknown sampler preset '${samplerPresetId}'`
        ),
      ]);
    }

    const existing = this.connections.get(role) ?? this.defaultConnection;
    if (existing === undefined) {
      return err([
        validationError('role', 'MISSING_ROLE_CONFIG', `No model connection configured for role '${role}'`),
      ]);
    }

    this.setRoleConnection(role, {
      ...existing,
      samplerPresetId,
    });
    return this.resolveConnection(role);
  }

  /**
   * Update the fallback default connection at runtime.
   */
  setDefaultConnection(
    config: (Omit<RoleConnectionConfig, 'role'> & { readonly role?: AgentRole }) | undefined
  ): void {
    this.defaultConnection = config !== undefined ? cloneRoleConnectionConfig(config) : undefined;
  }

  /**
   * Set or update the connection profile for a specific {@link AgentRole} at runtime.
   */
  setRoleConnection(role: AgentRole, config: Omit<RoleConnectionConfig, 'role'>): void {
    this.connections.set(role, { ...cloneRoleConnectionConfig(config), role });
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
      connections[role] = { ...cloneRoleConnectionConfig(cfg), role };
    }
    return {
      ...(this.defaultConnection !== undefined
        ? { defaultConnection: cloneRoleConnectionConfig(this.defaultConnection) }
        : {}),
      connections,
    };
  }

  private hydrateConnectionSampler(config: RoleConnectionConfig): RoleConnectionConfig {
    const preset =
      config.samplerPresetId !== undefined ? this.samplerPresets.get(config.samplerPresetId) : undefined;
    if (preset === undefined && config.sampler === undefined) {
      return { ...config };
    }

    const mergedSampler = clonePartialSampler({
      ...(preset !== undefined ? clonePartialSampler(preset) : {}),
      ...(config.sampler !== undefined ? clonePartialSampler(config.sampler) : {}),
    });

    return {
      ...config,
      sampler: mergedSampler,
    };
  }

  /**
   * Resolve the effective connection config for a given {@link AgentRole}.
   */
  resolveConnection(role: AgentRole): Result<RoleConnectionConfig, ValidationError[]> {
    const specific = this.connections.get(role);
    if (specific !== undefined) {
      return ok(this.hydrateConnectionSampler({ ...specific, role }));
    }
    if (this.defaultConnection !== undefined) {
      return ok(this.hydrateConnectionSampler({ ...this.defaultConnection, role }));
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
