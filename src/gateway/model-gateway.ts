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
  SamplingParameters,
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

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

function isSafeKey(key: string): boolean {
  return key.length > 0 && !FORBIDDEN_KEYS.has(key);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteOrUndefined(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) ? value : undefined;
}

function resolveSamplingParameters(
  config: RoleConnectionConfig,
  req: SamplingParameters
): SamplingParameters {
  const stopSequences = req.stopSequences ?? config.stopSequences;
  return {
    temperature: finiteOrUndefined(req.temperature ?? config.temperature),
    maxTokens: finiteOrUndefined(req.maxTokens ?? config.maxTokens),
    maxContextTokens: finiteOrUndefined(req.maxContextTokens ?? config.maxContextTokens),
    topP: finiteOrUndefined(req.topP ?? config.topP),
    topK: finiteOrUndefined(req.topK ?? config.topK),
    minP: finiteOrUndefined(req.minP ?? config.minP),
    topA: finiteOrUndefined(req.topA ?? config.topA),
    typicalP: finiteOrUndefined(req.typicalP ?? config.typicalP),
    tfs: finiteOrUndefined(req.tfs ?? config.tfs),
    frequencyPenalty: finiteOrUndefined(req.frequencyPenalty ?? config.frequencyPenalty),
    presencePenalty: finiteOrUndefined(req.presencePenalty ?? config.presencePenalty),
    repetitionPenalty: finiteOrUndefined(req.repetitionPenalty ?? config.repetitionPenalty),
    stopSequences: stopSequences !== undefined ? [...stopSequences] : undefined,
    seed: finiteOrUndefined(req.seed ?? config.seed),
  };
}

function cloneConnectionFields<T extends Omit<RoleConnectionConfig, 'role'> & { readonly role?: AgentRole }>(
  config: T,
  redactApiKeys = false
): T {
  const copy = {
    ...config,
    ...(config.stopSequences !== undefined ? { stopSequences: [...config.stopSequences] } : {}),
  };
  if (redactApiKeys && copy.apiKey !== undefined && copy.apiKey.length > 0) {
    return { ...copy, apiKey: '***' };
  }
  return copy;
}

function serializeChatMessages(
  messages: readonly ChatMessage[]
): Array<{ role: ChatMessage['role']; content: string; name?: string }> {
  return messages.map((msg) =>
    msg.name !== undefined
      ? { role: msg.role, content: msg.content, name: msg.name }
      : { role: msg.role, content: msg.content }
  );
}

function invokeFetchImpl(
  customFetch: typeof fetch | undefined,
  url: string,
  init: RequestInit
): Promise<Response> {
  if (customFetch !== undefined) {
    return customFetch(url, init);
  }
  if (typeof globalThis.fetch !== 'function') {
    throw new Error('Global fetch is unavailable in the current runtime');
  }
  return globalThis.fetch(url, init);
}

function buildBearerHeaders(config: RoleConnectionConfig): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (config.apiKey !== undefined && config.apiKey.length > 0) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }
  return headers;
}

function buildOpenAICompatibleRequestBody(
  config: RoleConnectionConfig,
  req: GatewayGenerateTextRequest | GatewayStructuredRequest,
  stream: boolean,
  structuredReq?: GatewayStructuredRequest
): Record<string, unknown> {
  const sampling = resolveSamplingParameters(config, req);

  const body: Record<string, unknown> = {
    model: config.model,
    messages: serializeChatMessages(req.messages),
    stream,
  };

  if (sampling.temperature !== undefined) {
    body.temperature = sampling.temperature;
  }
  if (sampling.maxTokens !== undefined) {
    body.max_tokens = sampling.maxTokens;
  }
  if (sampling.topP !== undefined) {
    body.top_p = sampling.topP;
  }
  if (sampling.topK !== undefined && sampling.topK > 0) {
    body.top_k = sampling.topK;
  }
  if (sampling.minP !== undefined && sampling.minP > 0) {
    body.min_p = sampling.minP;
  }
  if (sampling.topA !== undefined && sampling.topA > 0) {
    body.top_a = sampling.topA;
  }
  if (sampling.typicalP !== undefined && sampling.typicalP < 1) {
    body.typical_p = sampling.typicalP;
  }
  if (sampling.tfs !== undefined && sampling.tfs < 1) {
    body.tfs = sampling.tfs;
  }
  if (sampling.frequencyPenalty !== undefined) {
    body.frequency_penalty = sampling.frequencyPenalty;
  }
  if (sampling.presencePenalty !== undefined) {
    body.presence_penalty = sampling.presencePenalty;
  }
  if (sampling.repetitionPenalty !== undefined) {
    body.repetition_penalty = sampling.repetitionPenalty;
  }
  if (sampling.stopSequences !== undefined && sampling.stopSequences.length > 0) {
    body.stop = [...sampling.stopSequences];
  }
  if (sampling.seed !== undefined) {
    body.seed = sampling.seed;
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

interface ParsedStreamLineResult {
  readonly text?: string;
  readonly done?: boolean;
  readonly error?: ProviderFailure;
}

async function executeJsonCompletion(
  customFetch: typeof fetch | undefined,
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  config: RoleConnectionConfig,
  req: GatewayGenerateTextRequest | GatewayStructuredRequest,
  extractContent: (payload: unknown) => string | undefined,
  missingContentMessage: string
): Promise<Result<string, ProviderFailure>> {
  if (req.signal?.aborted) {
    return err({ code: 'ABORTED', message: 'Request was aborted', isAbort: true, retryable: false });
  }

  const signalHandle = createCombinedSignal(req.signal, config.timeoutMs);
  try {
    const response = await invokeFetchImpl(customFetch, url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
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

    const content = extractContent(payload);
    if (content === undefined) {
      return err({
        code: 'INVALID_PROVIDER_RESPONSE',
        message: missingContentMessage,
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

async function* executeLineStream(
  customFetch: typeof fetch | undefined,
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  config: RoleConnectionConfig,
  req: GatewayGenerateTextRequest,
  parseLine: (trimmedLine: string) => ParsedStreamLineResult
): AsyncIterable<Result<StreamChunk, ProviderFailure>> {
  if (req.signal?.aborted) {
    yield err({ code: 'ABORTED', message: 'Request was aborted', isAbort: true, retryable: false });
    return;
  }

  const signalHandle = createCombinedSignal(req.signal, config.timeoutMs);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  try {
    const response = await invokeFetchImpl(customFetch, url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
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
        if (line.length === 0) {
          continue;
        }
        const parsed = parseLine(line);
        if (parsed.error !== undefined) {
          yield err(parsed.error);
          return;
        }
        if (parsed.text !== undefined && parsed.text.length > 0) {
          yield ok({ text: parsed.text, done: false });
        }
        if (parsed.done === true) {
          emittedDone = true;
          yield ok({ text: '', done: true });
          return;
        }
      }
    }

    const trailing = (lineBuffer + decoder.decode()).trim();
    if (trailing.length > 0) {
      const parsed = parseLine(trailing);
      if (parsed.error !== undefined) {
        yield err(parsed.error);
        return;
      }
      if (parsed.text !== undefined && parsed.text.length > 0) {
        yield ok({ text: parsed.text, done: false });
      }
      if (parsed.done === true) {
        emittedDone = true;
        yield ok({ text: '', done: true });
        return;
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

function parseOpenAISseLine(trimmedLine: string): ParsedStreamLineResult {
  if (trimmedLine.startsWith(':') || !trimmedLine.startsWith('data:')) {
    return {};
  }
  const payloadText = trimmedLine.slice(5).trim();
  if (payloadText === '[DONE]') {
    return { done: true };
  }
  if (payloadText.length === 0) {
    return {};
  }

  let parsedChunk: unknown;
  try {
    parsedChunk = JSON.parse(payloadText) as unknown;
  } catch (caught) {
    return {
      error: {
        code: 'INVALID_STREAM_PAYLOAD',
        message: `Malformed SSE JSON chunk: ${caught instanceof Error ? caught.message : String(caught)}`,
        retryable: false,
      },
    };
  }

  const delta = extractOpenAIStreamDelta(parsedChunk);
  return delta !== undefined && delta.length > 0 ? { text: delta } : {};
}

function extractOllamaMessageContent(payload: unknown): string | undefined {
  if (isPlainRecord(payload) && isPlainRecord(payload.message) && typeof payload.message.content === 'string') {
    return payload.message.content;
  }
  return extractOpenAIMessageContent(payload);
}

function parseOllamaNativeLine(trimmedLine: string): ParsedStreamLineResult {
  if (trimmedLine.startsWith(':')) {
    return {};
  }
  const payloadText = trimmedLine.startsWith('data:') ? trimmedLine.slice(5).trim() : trimmedLine;
  if (payloadText === '[DONE]') {
    return { done: true };
  }
  if (payloadText.length === 0) {
    return {};
  }

  let parsedChunk: unknown;
  try {
    parsedChunk = JSON.parse(payloadText) as unknown;
  } catch (caught) {
    return {
      error: {
        code: 'INVALID_STREAM_PAYLOAD',
        message: `Malformed Ollama stream JSON chunk: ${caught instanceof Error ? caught.message : String(caught)}`,
        retryable: false,
      },
    };
  }

  if (isPlainRecord(parsedChunk) && typeof parsedChunk.error === 'string') {
    return {
      error: {
        code: 'PROVIDER_STREAM_ERROR',
        message: parsedChunk.error,
        retryable: false,
      },
    };
  }

  let delta: string | undefined;
  if (
    isPlainRecord(parsedChunk) &&
    isPlainRecord(parsedChunk.message) &&
    typeof parsedChunk.message.content === 'string'
  ) {
    delta = parsedChunk.message.content;
  } else {
    delta = extractOpenAIStreamDelta(parsedChunk);
  }

  const done = isPlainRecord(parsedChunk) && parsedChunk.done === true;
  return {
    ...(delta !== undefined && delta.length > 0 ? { text: delta } : {}),
    ...(done ? { done: true } : {}),
  };
}

function extractAnthropicMessageContent(payload: unknown): string | undefined {
  if (!isPlainRecord(payload) || !Array.isArray(payload.content)) {
    return undefined;
  }
  const parts: string[] = [];
  for (const block of payload.content) {
    if (isPlainRecord(block) && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.length > 0 ? parts.join('') : undefined;
}

function parseAnthropicSseLine(trimmedLine: string): ParsedStreamLineResult {
  if (trimmedLine.startsWith(':') || !trimmedLine.startsWith('data:')) {
    return {};
  }
  const payloadText = trimmedLine.slice(5).trim();
  if (payloadText === '[DONE]') {
    return { done: true };
  }
  if (payloadText.length === 0) {
    return {};
  }

  let parsedChunk: unknown;
  try {
    parsedChunk = JSON.parse(payloadText) as unknown;
  } catch (caught) {
    return {
      error: {
        code: 'INVALID_STREAM_PAYLOAD',
        message: `Malformed Anthropic SSE JSON chunk: ${caught instanceof Error ? caught.message : String(caught)}`,
        retryable: false,
      },
    };
  }

  if (!isPlainRecord(parsedChunk)) {
    return {};
  }

  if (parsedChunk.type === 'message_stop') {
    return { done: true };
  }

  if (parsedChunk.type === 'error') {
    const errRecord = isPlainRecord(parsedChunk.error) ? parsedChunk.error : undefined;
    const message =
      errRecord !== undefined && typeof errRecord.message === 'string'
        ? errRecord.message
        : 'Anthropic stream returned an error event';
    return {
      error: {
        code: 'PROVIDER_STREAM_ERROR',
        message,
        retryable: false,
      },
    };
  }

  if (parsedChunk.type === 'content_block_delta' && isPlainRecord(parsedChunk.delta)) {
    const delta = parsedChunk.delta;
    if (
      (delta.type === undefined || delta.type === 'text_delta') &&
      typeof delta.text === 'string' &&
      delta.text.length > 0
    ) {
      return { text: delta.text };
    }
  }

  return {};
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

  private buildRequestBody(
    config: RoleConnectionConfig,
    req: GatewayGenerateTextRequest | GatewayStructuredRequest,
    stream: boolean,
    structuredReq?: GatewayStructuredRequest
  ): Record<string, unknown> {
    return buildOpenAICompatibleRequestBody(config, req, stream, structuredReq);
  }

  async generateText(
    config: RoleConnectionConfig,
    req: GatewayGenerateTextRequest
  ): Promise<Result<string, ProviderFailure>> {
    return executeJsonCompletion(
      this.customFetch,
      this.buildEndpointUrl(config.baseUrl),
      buildBearerHeaders(config),
      this.buildRequestBody(config, req, false),
      config,
      req,
      extractOpenAIMessageContent,
      'Provider response did not include choices[0].message.content'
    );
  }

  async generateStructuredRaw(
    config: RoleConnectionConfig,
    req: GatewayStructuredRequest
  ): Promise<Result<string, ProviderFailure>> {
    return executeJsonCompletion(
      this.customFetch,
      this.buildEndpointUrl(config.baseUrl),
      buildBearerHeaders(config),
      this.buildRequestBody(config, req, false, req),
      config,
      req,
      extractOpenAIMessageContent,
      'Provider response did not include choices[0].message.content'
    );
  }

  streamText(
    config: RoleConnectionConfig,
    req: GatewayGenerateTextRequest
  ): AsyncIterable<Result<StreamChunk, ProviderFailure>> {
    return executeLineStream(
      this.customFetch,
      this.buildEndpointUrl(config.baseUrl),
      buildBearerHeaders(config),
      this.buildRequestBody(config, req, true),
      config,
      req,
      parseOpenAISseLine
    );
  }
}

/**
 * Built-in provider for Ollama instances supporting both OpenAI-compatible `/v1/chat/completions`
 * normalization and native `/api/chat` when the configured endpoint targets `/api/chat`.
 */
export class OllamaProvider implements ModelProvider {
  readonly kind = 'ollama' as const;
  private readonly customFetch: typeof fetch | undefined;

  constructor(fetchImpl?: typeof fetch) {
    this.customFetch = fetchImpl;
  }

  private resolveEndpoint(baseUrl: string): { readonly url: string; readonly nativeApiChat: boolean } {
    const normalized = baseUrl.replace(/\/+$/, '');
    if (normalized.endsWith('/api/chat')) {
      return { url: normalized, nativeApiChat: true };
    }
    if (normalized.endsWith('/v1/chat/completions') || normalized.endsWith('/chat/completions')) {
      return { url: normalized, nativeApiChat: false };
    }
    if (normalized.endsWith('/v1')) {
      return { url: `${normalized}/chat/completions`, nativeApiChat: false };
    }
    return { url: `${normalized}/v1/chat/completions`, nativeApiChat: false };
  }

  private buildNativeRequestBody(
    config: RoleConnectionConfig,
    req: GatewayGenerateTextRequest | GatewayStructuredRequest,
    stream: boolean,
    structuredReq?: GatewayStructuredRequest
  ): Record<string, unknown> {
    const sampling = resolveSamplingParameters(config, req);
    const options: Record<string, unknown> = {};

    if (sampling.temperature !== undefined) {
      options.temperature = sampling.temperature;
    }
    if (sampling.maxTokens !== undefined) {
      options.num_predict = sampling.maxTokens;
    }
    if (sampling.maxContextTokens !== undefined) {
      options.num_ctx = sampling.maxContextTokens;
    }
    if (sampling.topP !== undefined) {
      options.top_p = sampling.topP;
    }
    if (sampling.topK !== undefined && sampling.topK > 0) {
      options.top_k = sampling.topK;
    }
    if (sampling.minP !== undefined && sampling.minP > 0) {
      options.min_p = sampling.minP;
    }
    if (sampling.typicalP !== undefined && sampling.typicalP < 1) {
      options.typical_p = sampling.typicalP;
    }
    if (sampling.tfs !== undefined && sampling.tfs < 1) {
      options.tfs_z = sampling.tfs;
    }
    if (sampling.frequencyPenalty !== undefined) {
      options.frequency_penalty = sampling.frequencyPenalty;
    }
    if (sampling.presencePenalty !== undefined) {
      options.presence_penalty = sampling.presencePenalty;
    }
    if (sampling.repetitionPenalty !== undefined) {
      options.repeat_penalty = sampling.repetitionPenalty;
    }
    if (sampling.stopSequences !== undefined && sampling.stopSequences.length > 0) {
      options.stop = [...sampling.stopSequences];
    }
    if (sampling.seed !== undefined) {
      options.seed = sampling.seed;
    }

    const body: Record<string, unknown> = {
      model: config.model,
      messages: serializeChatMessages(req.messages),
      stream,
    };

    if (Object.keys(options).length > 0) {
      body.options = options;
    }
    if (structuredReq !== undefined && config.supportsJsonSchema === true) {
      body.format = structuredReq.schema;
    }

    return body;
  }

  async generateText(
    config: RoleConnectionConfig,
    req: GatewayGenerateTextRequest
  ): Promise<Result<string, ProviderFailure>> {
    const { url, nativeApiChat } = this.resolveEndpoint(config.baseUrl);
    const body = nativeApiChat
      ? this.buildNativeRequestBody(config, req, false)
      : buildOpenAICompatibleRequestBody(config, req, false);
    return executeJsonCompletion(
      this.customFetch,
      url,
      buildBearerHeaders(config),
      body,
      config,
      req,
      nativeApiChat ? extractOllamaMessageContent : extractOpenAIMessageContent,
      nativeApiChat
        ? 'Ollama response did not include message.content'
        : 'Provider response did not include choices[0].message.content'
    );
  }

  async generateStructuredRaw(
    config: RoleConnectionConfig,
    req: GatewayStructuredRequest
  ): Promise<Result<string, ProviderFailure>> {
    const { url, nativeApiChat } = this.resolveEndpoint(config.baseUrl);
    const body = nativeApiChat
      ? this.buildNativeRequestBody(config, req, false, req)
      : buildOpenAICompatibleRequestBody(config, req, false, req);
    return executeJsonCompletion(
      this.customFetch,
      url,
      buildBearerHeaders(config),
      body,
      config,
      req,
      nativeApiChat ? extractOllamaMessageContent : extractOpenAIMessageContent,
      nativeApiChat
        ? 'Ollama response did not include message.content'
        : 'Provider response did not include choices[0].message.content'
    );
  }

  streamText(
    config: RoleConnectionConfig,
    req: GatewayGenerateTextRequest
  ): AsyncIterable<Result<StreamChunk, ProviderFailure>> {
    const { url, nativeApiChat } = this.resolveEndpoint(config.baseUrl);
    const body = nativeApiChat
      ? this.buildNativeRequestBody(config, req, true)
      : buildOpenAICompatibleRequestBody(config, req, true);
    return executeLineStream(
      this.customFetch,
      url,
      buildBearerHeaders(config),
      body,
      config,
      req,
      nativeApiChat ? parseOllamaNativeLine : parseOpenAISseLine
    );
  }
}

/**
 * Built-in provider targeting Anthropic's `/v1/messages` API via native `fetch`.
 */
export class AnthropicProvider implements ModelProvider {
  readonly kind = 'anthropic' as const;
  private readonly customFetch: typeof fetch | undefined;

  constructor(fetchImpl?: typeof fetch) {
    this.customFetch = fetchImpl;
  }

  private buildEndpointUrl(baseUrl: string): string {
    const normalized = baseUrl.replace(/\/+$/, '');
    if (normalized.endsWith('/v1/messages') || normalized.endsWith('/messages')) {
      return normalized;
    }
    if (normalized.endsWith('/v1')) {
      return `${normalized}/messages`;
    }
    return `${normalized}/v1/messages`;
  }

  private buildHeaders(config: RoleConnectionConfig): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    };
    if (config.apiKey !== undefined && config.apiKey.length > 0) {
      headers['x-api-key'] = config.apiKey;
    }
    return headers;
  }

  private buildRequestBody(
    config: RoleConnectionConfig,
    req: GatewayGenerateTextRequest | GatewayStructuredRequest,
    stream: boolean
  ): Record<string, unknown> {
    const sampling = resolveSamplingParameters(config, req);
    const systemParts: string[] = [];
    const conversationMessages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

    for (const msg of req.messages) {
      if (msg.role === 'system') {
        if (msg.content.length > 0) {
          systemParts.push(msg.content);
        }
      } else {
        conversationMessages.push({ role: msg.role, content: msg.content });
      }
    }

    const body: Record<string, unknown> = {
      model: config.model,
      max_tokens: sampling.maxTokens ?? 1024,
      messages: conversationMessages,
      stream,
    };

    if (systemParts.length > 0) {
      body.system = systemParts.join('\n\n');
    }
    if (sampling.temperature !== undefined) {
      body.temperature = sampling.temperature;
    }
    if (sampling.topP !== undefined) {
      body.top_p = sampling.topP;
    }
    if (sampling.topK !== undefined && sampling.topK > 0) {
      body.top_k = sampling.topK;
    }
    if (sampling.stopSequences !== undefined && sampling.stopSequences.length > 0) {
      body.stop_sequences = [...sampling.stopSequences];
    }

    return body;
  }

  async generateText(
    config: RoleConnectionConfig,
    req: GatewayGenerateTextRequest
  ): Promise<Result<string, ProviderFailure>> {
    return executeJsonCompletion(
      this.customFetch,
      this.buildEndpointUrl(config.baseUrl),
      this.buildHeaders(config),
      this.buildRequestBody(config, req, false),
      config,
      req,
      extractAnthropicMessageContent,
      'Anthropic response did not include content text blocks'
    );
  }

  async generateStructuredRaw(
    config: RoleConnectionConfig,
    req: GatewayStructuredRequest
  ): Promise<Result<string, ProviderFailure>> {
    return executeJsonCompletion(
      this.customFetch,
      this.buildEndpointUrl(config.baseUrl),
      this.buildHeaders(config),
      this.buildRequestBody(config, req, false),
      config,
      req,
      extractAnthropicMessageContent,
      'Anthropic response did not include content text blocks'
    );
  }

  streamText(
    config: RoleConnectionConfig,
    req: GatewayGenerateTextRequest
  ): AsyncIterable<Result<StreamChunk, ProviderFailure>> {
    return executeLineStream(
      this.customFetch,
      this.buildEndpointUrl(config.baseUrl),
      this.buildHeaders(config),
      this.buildRequestBody(config, req, true),
      config,
      req,
      parseAnthropicSseLine
    );
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
          if (isSafeKey(role)) {
            this.connections.set(role, cloneConnectionFields({ ...config, role }));
          }
        }
      } else {
        for (const [roleKey, config] of Object.entries(options.connections)) {
          if (config !== undefined && isSafeKey(roleKey)) {
            const role = roleKey as AgentRole;
            this.connections.set(role, cloneConnectionFields({ ...config, role }));
          }
        }
      }
    }

    this.defaultConnection =
      options.defaultConnection !== undefined ? cloneConnectionFields(options.defaultConnection) : undefined;

    this.providers = new Map<ProviderKind, ModelProvider>([
      ['openai_compatible', new OpenAICompatibleProvider(options.fetchImpl)],
      ['ollama', new OllamaProvider(options.fetchImpl)],
      ['anthropic', new AnthropicProvider(options.fetchImpl)],
    ]);

    if (options.providers !== undefined) {
      if (options.providers instanceof Map) {
        for (const [kind, provider] of options.providers.entries()) {
          this.providers.set(kind, provider);
        }
      } else {
        for (const [kindKey, provider] of Object.entries(options.providers)) {
          if (provider !== undefined && isSafeKey(kindKey)) {
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
    this.defaultConnection = config !== undefined ? cloneConnectionFields(config) : undefined;
  }

  /**
   * Set or update the connection profile for a specific {@link AgentRole} at runtime.
   */
  setRoleConnection(role: AgentRole, config: Omit<RoleConnectionConfig, 'role'>): void {
    if (!isSafeKey(role)) {
      return;
    }
    this.connections.set(role, cloneConnectionFields({ ...config, role }));
  }

  /**
   * Remove a specific {@link AgentRole} override, returning `true` if it was present.
   */
  removeRoleConnection(role: AgentRole): boolean {
    return this.connections.delete(role);
  }

  /**
   * Remove all per-role connection overrides (preserving any default connection).
   */
  clearRoleConnections(): void {
    this.connections.clear();
  }

  /**
   * Return a snapshot of the configured default and per-role connections.
   */
  getConnectionsSnapshot(options?: { readonly redactApiKeys?: boolean }): {
    readonly defaultConnection?: Omit<RoleConnectionConfig, 'role'> & { readonly role?: AgentRole };
    readonly connections: Partial<Record<AgentRole, RoleConnectionConfig>>;
  } {
    const redact = options?.redactApiKeys === true;
    const connections: Partial<Record<AgentRole, RoleConnectionConfig>> = {};
    for (const [role, cfg] of this.connections.entries()) {
      if (isSafeKey(role)) {
        Object.defineProperty(connections, role, {
          value: cloneConnectionFields(cfg, redact),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
    }
    return {
      ...(this.defaultConnection !== undefined
        ? { defaultConnection: cloneConnectionFields(this.defaultConnection, redact) }
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
      return ok(cloneConnectionFields(specific));
    }
    if (this.defaultConnection !== undefined) {
      return ok(cloneConnectionFields({ ...this.defaultConnection, role }));
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
