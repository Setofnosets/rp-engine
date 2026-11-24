import { Result, err, ok } from '../../core/result.js';
import type {
  GatewayGenerateTextRequest,
  GatewayStructuredRequest,
  ModelProvider,
  ProviderFailure,
  RoleConnectionConfig,
  StreamChunk,
} from '../types.js';
import {
  classifyCaughtProviderError,
  classifyHttpFailure,
  createCombinedSignal,
  createThinkingStreamFilter,
  invokeFetch,
  isPlainRecord,
  readNdjsonLines,
  resolveEffectiveSampler,
  separateThinkingTags,
} from './provider-utils.js';

const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434';

function resolveOllamaEndpoint(baseUrl: string): { readonly url: string; readonly nativeApiChat: boolean } {
  const raw = baseUrl.trim().length > 0 ? baseUrl.trim() : DEFAULT_OLLAMA_BASE_URL;
  const normalized = raw.replace(/\/+$/, '');
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

function extractOllamaMessageContent(payload: unknown): string | undefined {
  if (!isPlainRecord(payload) || !isPlainRecord(payload.message)) {
    return undefined;
  }
  const content = payload.message.content;
  if (typeof content !== 'string') {
    return undefined;
  }
  return separateThinkingTags(content).text;
}

/**
 * Native provider for local/self-hosted Ollama `/api/chat` endpoints (and `/v1` OpenAI-compatible URLs).
 */
export class OllamaProvider implements ModelProvider {
  readonly kind = 'ollama' as const;
  private readonly customFetch: typeof fetch | undefined;
  private readonly openAiFallback: ModelProvider | undefined;

  constructor(fetchImpl?: typeof fetch, openAiFallback?: ModelProvider) {
    this.customFetch = fetchImpl;
    this.openAiFallback = openAiFallback;
  }

  private buildEndpointUrl(baseUrl: string): string {
    return resolveOllamaEndpoint(baseUrl).url;
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
    const options: Record<string, unknown> = {};

    if (sampler.temperature !== undefined) {
      options.temperature = sampler.temperature;
    }
    if (sampler.maxTokens !== undefined) {
      options.num_predict = sampler.maxTokens;
    }
    if (sampler.maxContextTokens !== undefined) {
      options.num_ctx = sampler.maxContextTokens;
    }
    if (sampler.topP !== undefined) {
      options.top_p = sampler.topP;
    }
    if (sampler.topK !== undefined && sampler.topK > 0) {
      options.top_k = sampler.topK;
    }
    if (sampler.minP !== undefined && sampler.minP > 0) {
      options.min_p = sampler.minP;
    }
    if (sampler.typicalP !== undefined && sampler.typicalP < 1) {
      options.typical_p = sampler.typicalP;
    }
    if (sampler.tfs !== undefined && sampler.tfs < 1) {
      options.tfs_z = sampler.tfs;
    }
    if (sampler.frequencyPenalty !== undefined) {
      options.frequency_penalty = sampler.frequencyPenalty;
    }
    if (sampler.presencePenalty !== undefined) {
      options.presence_penalty = sampler.presencePenalty;
    }
    if (sampler.repetitionPenalty !== undefined) {
      options.repeat_penalty = sampler.repetitionPenalty;
    }
    if (sampler.stop !== undefined && sampler.stop.length > 0) {
      options.stop = [...sampler.stop];
    }
    if (sampler.seed !== undefined) {
      options.seed = sampler.seed;
    }

    const body: Record<string, unknown> = {
      model: config.model,
      messages: req.messages.map((msg) => ({
        role: msg.role,
        content: msg.content,
      })),
      stream,
    };

    if (Object.keys(options).length > 0) {
      body.options = options;
    }
    if (structuredReq !== undefined && config.supportsJsonSchema !== false) {
      body.format = structuredReq.schema;
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
          message: `Failed to decode Ollama JSON response: ${caught instanceof Error ? caught.message : String(caught)}`,
          retryable: false,
        });
      }

      const content = extractOllamaMessageContent(payload);
      if (content === undefined) {
        return err({
          code: 'INVALID_PROVIDER_RESPONSE',
          message: 'Ollama response did not include message.content',
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
    const endpoint = resolveOllamaEndpoint(config.baseUrl);
    if (!endpoint.nativeApiChat && this.openAiFallback !== undefined) {
      return this.openAiFallback.generateText({ ...config, baseUrl: endpoint.url }, req);
    }
    return this.executeCompletion(config, req);
  }

  async generateStructuredRaw(
    config: RoleConnectionConfig,
    req: GatewayStructuredRequest
  ): Promise<Result<string, ProviderFailure>> {
    const endpoint = resolveOllamaEndpoint(config.baseUrl);
    if (!endpoint.nativeApiChat && this.openAiFallback !== undefined) {
      return this.openAiFallback.generateStructuredRaw({ ...config, baseUrl: endpoint.url }, req);
    }
    return this.executeCompletion(config, req, req);
  }

  async *streamText(
    config: RoleConnectionConfig,
    req: GatewayGenerateTextRequest
  ): AsyncIterable<Result<StreamChunk, ProviderFailure>> {
    const endpoint = resolveOllamaEndpoint(config.baseUrl);
    if (!endpoint.nativeApiChat && this.openAiFallback !== undefined) {
      yield* this.openAiFallback.streamText({ ...config, baseUrl: endpoint.url }, req);
      return;
    }

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

      const thinkingFilter = createThinkingStreamFilter();
      let emittedDone = false;

      for await (const lineResult of readNdjsonLines(response, req.signal, signalHandle.isTimedOut)) {
        if (!lineResult.ok) {
          yield lineResult;
          return;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(lineResult.value) as unknown;
        } catch (caught) {
          yield err({
            code: 'INVALID_STREAM_PAYLOAD',
            message: `Malformed Ollama NDJSON chunk: ${caught instanceof Error ? caught.message : String(caught)}`,
            retryable: false,
          });
          return;
        }

        if (!isPlainRecord(parsed)) {
          continue;
        }

        if (typeof parsed.error === 'string' && parsed.error.length > 0) {
          yield err({
            code: 'PROVIDER_STREAM_ERROR',
            message: parsed.error,
            retryable: false,
          });
          return;
        }

        if (isPlainRecord(parsed.message) && typeof parsed.message.content === 'string') {
          const visible = thinkingFilter.push(parsed.message.content);
          if (visible.length > 0) {
            yield ok({ text: visible, done: false });
          }
        }

        if (parsed.done === true) {
          const remaining = thinkingFilter.flush();
          if (remaining.length > 0) {
            yield ok({ text: remaining, done: false });
          }
          emittedDone = true;
          yield ok({ text: '', done: true });
          return;
        }
      }

      const remaining = thinkingFilter.flush();
      if (remaining.length > 0) {
        yield ok({ text: remaining, done: false });
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
