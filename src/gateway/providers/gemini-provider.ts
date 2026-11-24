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

const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

function extractGeminiCandidateText(payload: unknown): string | undefined {
  if (!isPlainRecord(payload) || !Array.isArray(payload.candidates) || payload.candidates.length === 0) {
    return undefined;
  }

  const firstCandidate = payload.candidates[0];
  if (!isPlainRecord(firstCandidate) || !isPlainRecord(firstCandidate.content)) {
    return undefined;
  }

  const parts = firstCandidate.content.parts;
  if (!Array.isArray(parts)) {
    return undefined;
  }

  const textParts: string[] = [];
  for (const part of parts) {
    if (isPlainRecord(part) && part.thought !== true && typeof part.text === 'string') {
      textParts.push(part.text);
    }
  }

  if (textParts.length === 0) {
    return undefined;
  }

  return separateThinkingTags(textParts.join('')).text;
}

/**
 * Native provider targeting Google Gemini REST API (`generateContent` and `streamGenerateContent?alt=sse`).
 */
export class GeminiProvider implements ModelProvider {
  readonly kind = 'gemini' as const;
  private readonly customFetch: typeof fetch | undefined;

  constructor(fetchImpl?: typeof fetch) {
    this.customFetch = fetchImpl;
  }

  private buildEndpointUrl(config: RoleConnectionConfig, stream: boolean): string {
    const raw = config.baseUrl.trim().length > 0 ? config.baseUrl.trim() : DEFAULT_GEMINI_BASE_URL;
    const normalized = raw.replace(/\/+$/, '');
    const action = stream ? 'streamGenerateContent' : 'generateContent';
    const encodedModel = encodeURIComponent(config.model);

    let endpoint: string;
    if (normalized.endsWith(':generateContent') || normalized.endsWith(':streamGenerateContent')) {
      endpoint = normalized;
    } else if (
      normalized.endsWith(`/models/${config.model}`) ||
      normalized.endsWith(`/models/${encodedModel}`)
    ) {
      endpoint = `${normalized}:${action}`;
    } else if (/\/v\d+(?:beta\d*)?$/i.test(normalized)) {
      endpoint = `${normalized}/models/${encodedModel}:${action}`;
    } else {
      endpoint = `${normalized}/v1beta/models/${encodedModel}:${action}`;
    }

    if (stream && !endpoint.includes('alt=sse')) {
      const separator = endpoint.includes('?') ? '&' : '?';
      return `${endpoint}${separator}alt=sse`;
    }
    return endpoint;
  }

  private buildHeaders(config: RoleConnectionConfig): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (config.apiKey !== undefined && config.apiKey.length > 0) {
      headers['x-goog-api-key'] = config.apiKey;
    }
    return headers;
  }

  private buildRequestBody(
    config: RoleConnectionConfig,
    req: GatewayGenerateTextRequest | GatewayStructuredRequest,
    structuredReq?: GatewayStructuredRequest
  ): Record<string, unknown> {
    const sampler = resolveEffectiveSampler(config, req);

    const systemTexts: string[] = [];
    const contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = [];

    for (const msg of req.messages) {
      if (msg.role === 'system') {
        if (msg.content.length > 0) {
          systemTexts.push(msg.content);
        }
      } else {
        contents.push({
          role: msg.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: msg.content }],
        });
      }
    }

    const generationConfig: Record<string, unknown> = {};
    if (sampler.temperature !== undefined) {
      generationConfig.temperature = sampler.temperature;
    }
    if (sampler.topP !== undefined) {
      generationConfig.topP = sampler.topP;
    }
    if (sampler.topK !== undefined) {
      generationConfig.topK = sampler.topK;
    }
    if (sampler.maxTokens !== undefined) {
      generationConfig.maxOutputTokens = sampler.maxTokens;
    }
    if (sampler.stop !== undefined && sampler.stop.length > 0) {
      generationConfig.stopSequences = [...sampler.stop];
    }
    if (sampler.seed !== undefined) {
      generationConfig.seed = sampler.seed;
    }
    if (sampler.presencePenalty !== undefined) {
      generationConfig.presencePenalty = sampler.presencePenalty;
    }
    if (sampler.frequencyPenalty !== undefined) {
      generationConfig.frequencyPenalty = sampler.frequencyPenalty;
    }

    if (structuredReq !== undefined) {
      generationConfig.responseMimeType = 'application/json';
      generationConfig.responseSchema = structuredReq.schema;
    }

    const body: Record<string, unknown> = {
      contents,
    };

    if (systemTexts.length > 0) {
      body.systemInstruction = {
        parts: [{ text: systemTexts.join('\n\n') }],
      };
    }

    if (Object.keys(generationConfig).length > 0) {
      body.generationConfig = generationConfig;
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
      const response = await invokeFetch(this.customFetch, this.buildEndpointUrl(config, false), {
        method: 'POST',
        headers: this.buildHeaders(config),
        body: JSON.stringify(this.buildRequestBody(config, req, structuredReq)),
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
          message: `Failed to decode Gemini JSON response: ${caught instanceof Error ? caught.message : String(caught)}`,
          retryable: false,
        });
      }

      const content = extractGeminiCandidateText(payload);
      if (content === undefined) {
        return err({
          code: 'INVALID_PROVIDER_RESPONSE',
          message: 'Gemini response did not include candidates[0].content.parts text',
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
      const response = await invokeFetch(this.customFetch, this.buildEndpointUrl(config, true), {
        method: 'POST',
        headers: this.buildHeaders(config),
        body: JSON.stringify(this.buildRequestBody(config, req)),
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

        const { data } = frameResult.value;
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
            message: `Malformed Gemini SSE JSON chunk: ${caught instanceof Error ? caught.message : String(caught)}`,
            retryable: false,
          });
          return;
        }

        const chunkText = extractGeminiCandidateText(parsed);
        if (chunkText !== undefined && chunkText.length > 0) {
          const visible = thinkingFilter.push(chunkText);
          if (visible.length > 0) {
            yield ok({ text: visible, done: false });
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
