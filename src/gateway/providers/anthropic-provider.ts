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
  readSseEvents,
  resolveEffectiveSampler,
  separateThinkingTags,
} from './provider-utils.js';

const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_ANTHROPIC_MAX_TOKENS = 4096;

function extractAnthropicTextContent(payload: unknown): string | undefined {
  if (!isPlainRecord(payload) || !Array.isArray(payload.content)) {
    return undefined;
  }

  const parts: string[] = [];
  for (const block of payload.content) {
    if (isPlainRecord(block) && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }

  if (parts.length === 0) {
    return undefined;
  }

  return separateThinkingTags(parts.join('')).text;
}

/**
 * Native provider targeting Anthropic's Messages API (`/v1/messages`) via `fetch`.
 */
export class AnthropicProvider implements ModelProvider {
  readonly kind = 'anthropic' as const;
  private readonly customFetch: typeof fetch | undefined;

  constructor(fetchImpl?: typeof fetch) {
    this.customFetch = fetchImpl;
  }

  private buildEndpointUrl(baseUrl: string): string {
    const raw = baseUrl.trim().length > 0 ? baseUrl.trim() : DEFAULT_ANTHROPIC_BASE_URL;
    const normalized = raw.replace(/\/+$/, '');
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
      'anthropic-version': ANTHROPIC_VERSION,
    };
    if (config.apiKey !== undefined && config.apiKey.length > 0) {
      headers['x-api-key'] = config.apiKey;
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
    const enablePromptCache = req.enablePromptCache ?? config.enablePromptCache ?? false;

    const systemTexts: string[] = [];
    const conversationMessages: Array<{
      role: 'user' | 'assistant';
      content: string | Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }>;
    }> = [];

    for (const msg of req.messages) {
      if (msg.role === 'system') {
        if (msg.content.length > 0) {
          systemTexts.push(msg.content);
        }
      } else {
        conversationMessages.push({
          role: msg.role,
          content: msg.content,
        });
      }
    }

    if (structuredReq !== undefined) {
      const schemaName = structuredReq.schemaName ?? 'structured_output';
      systemTexts.push(
        `Respond ONLY with valid JSON conforming to schema '${schemaName}': ${JSON.stringify(structuredReq.schema)}`
      );
    }

    if (enablePromptCache && systemTexts.length === 0 && conversationMessages.length > 0) {
      const first = conversationMessages[0];
      if (first !== undefined && typeof first.content === 'string') {
        conversationMessages[0] = {
          role: first.role,
          content: [{ type: 'text', text: first.content, cache_control: { type: 'ephemeral' } }],
        };
      }
    }

    const body: Record<string, unknown> = {
      model: config.model,
      max_tokens: sampler.maxTokens ?? DEFAULT_ANTHROPIC_MAX_TOKENS,
      messages: conversationMessages,
      stream,
    };

    if (systemTexts.length > 0) {
      if (enablePromptCache) {
        body.system = systemTexts.map((text, index) =>
          index === systemTexts.length - 1
            ? { type: 'text', text, cache_control: { type: 'ephemeral' } }
            : { type: 'text', text }
        );
      } else {
        body.system = systemTexts.join('\n\n');
      }
    }

    if (sampler.temperature !== undefined) {
      body.temperature = sampler.temperature;
    }
    if (sampler.topP !== undefined) {
      body.top_p = sampler.topP;
    }
    if (sampler.topK !== undefined) {
      body.top_k = sampler.topK;
    }
    if (sampler.stop !== undefined && sampler.stop.length > 0) {
      body.stop_sequences = [...sampler.stop];
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
          message: `Failed to decode Anthropic JSON response: ${caught instanceof Error ? caught.message : String(caught)}`,
          retryable: false,
        });
      }

      const content = extractAnthropicTextContent(payload);
      if (content === undefined) {
        return err({
          code: 'INVALID_PROVIDER_RESPONSE',
          message: 'Anthropic response did not include any text content blocks',
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

      const thinkingFilter = createThinkingStreamFilter();
      let emittedDone = false;

      for await (const frameResult of readSseEvents(response, req.signal, signalHandle.isTimedOut)) {
        if (!frameResult.ok) {
          yield frameResult;
          return;
        }

        const { event, data } = frameResult.value;
        if (data === '[DONE]') {
          const remaining = thinkingFilter.flush();
          if (remaining.length > 0) {
            yield ok({ text: remaining, done: false });
          }
          emittedDone = true;
          yield ok({ text: '', done: true });
          return;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(data) as unknown;
        } catch (caught) {
          yield err({
            code: 'INVALID_STREAM_PAYLOAD',
            message: `Malformed Anthropic SSE JSON chunk: ${caught instanceof Error ? caught.message : String(caught)}`,
            retryable: false,
          });
          return;
        }

        if (!isPlainRecord(parsed)) {
          continue;
        }

        const eventType = typeof parsed.type === 'string' ? parsed.type : event;

        if (eventType === 'error') {
          const errObj = isPlainRecord(parsed.error) ? parsed.error : undefined;
          const message =
            errObj !== undefined && typeof errObj.message === 'string'
              ? errObj.message
              : 'Anthropic stream returned an error event';
          yield err({
            code: 'PROVIDER_STREAM_ERROR',
            message,
            retryable: false,
          });
          return;
        }

        if (eventType === 'message_stop') {
          const remaining = thinkingFilter.flush();
          if (remaining.length > 0) {
            yield ok({ text: remaining, done: false });
          }
          emittedDone = true;
          yield ok({ text: '', done: true });
          return;
        }

        if (eventType === 'content_block_delta' && isPlainRecord(parsed.delta)) {
          if (parsed.delta.type === 'text_delta' && typeof parsed.delta.text === 'string') {
            const visible = thinkingFilter.push(parsed.delta.text);
            if (visible.length > 0) {
              yield ok({ text: visible, done: false });
            }
          }
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
