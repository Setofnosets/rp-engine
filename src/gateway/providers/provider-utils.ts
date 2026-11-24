import { Result, err, ok } from '../../core/result.js';
import type {
  GatewayGenerateTextRequest,
  GatewayStructuredRequest,
  ProviderFailure,
  RoleConnectionConfig,
  SamplerPreset,
} from '../types.js';

/**
 * Narrow unknown values to plain non-array JSON objects.
 */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Normalize `-0` to `+0` for deterministic serialization and comparisons.
 */
export function normalizeNumber(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

function normalizeOptionalNumber(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) {
    return undefined;
  }
  return normalizeNumber(value);
}

/**
 * Resolved sampler settings merged from preset, role config, and per-request overrides.
 */
export interface ResolvedSampler {
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly maxContextTokens?: number;
  readonly topP?: number;
  readonly topK?: number;
  readonly minP?: number;
  readonly topA?: number;
  readonly typicalP?: number;
  readonly tfs?: number;
  readonly frequencyPenalty?: number;
  readonly presencePenalty?: number;
  readonly repetitionPenalty?: number;
  readonly stop?: readonly string[];
  readonly seed?: number;
}

/**
 * Merge sampler settings with deterministic precedence:
 * `config.sampler` < `config` top-level fields < `req.sampler` < `req` top-level fields.
 */
export function resolveEffectiveSampler(
  config: RoleConnectionConfig,
  req?: Pick<
    GatewayGenerateTextRequest | GatewayStructuredRequest,
    | 'temperature'
    | 'maxTokens'
    | 'maxContextTokens'
    | 'topP'
    | 'topK'
    | 'minP'
    | 'topA'
    | 'typicalP'
    | 'tfs'
    | 'frequencyPenalty'
    | 'presencePenalty'
    | 'repetitionPenalty'
    | 'stopSequences'
    | 'seed'
    | 'sampler'
  >
): ResolvedSampler {
  const cfgSampler = config.sampler;
  const reqSampler = req?.sampler;

  const temperature = normalizeOptionalNumber(
    req?.temperature ?? reqSampler?.temperature ?? config.temperature ?? cfgSampler?.temperature
  );
  const maxTokens = normalizeOptionalNumber(
    req?.maxTokens ?? reqSampler?.maxTokens ?? config.maxTokens ?? cfgSampler?.maxTokens
  );
  const maxContextTokens = normalizeOptionalNumber(
    req?.maxContextTokens ?? config.maxContextTokens
  );
  const topP = normalizeOptionalNumber(
    req?.topP ?? reqSampler?.topP ?? config.topP ?? cfgSampler?.topP
  );
  const topK = normalizeOptionalNumber(
    req?.topK ?? reqSampler?.topK ?? config.topK ?? cfgSampler?.topK
  );
  const minP = normalizeOptionalNumber(
    req?.minP ?? reqSampler?.minP ?? config.minP ?? cfgSampler?.minP
  );
  const topA = normalizeOptionalNumber(req?.topA ?? config.topA);
  const typicalP = normalizeOptionalNumber(req?.typicalP ?? config.typicalP);
  const tfs = normalizeOptionalNumber(req?.tfs ?? config.tfs);
  const frequencyPenalty = normalizeOptionalNumber(
    req?.frequencyPenalty ??
      reqSampler?.frequencyPenalty ??
      config.frequencyPenalty ??
      cfgSampler?.frequencyPenalty
  );
  const presencePenalty = normalizeOptionalNumber(
    req?.presencePenalty ??
      reqSampler?.presencePenalty ??
      config.presencePenalty ??
      cfgSampler?.presencePenalty
  );
  const repetitionPenalty = normalizeOptionalNumber(
    req?.repetitionPenalty ??
      reqSampler?.repetitionPenalty ??
      config.repetitionPenalty ??
      cfgSampler?.repetitionPenalty
  );
  const seed = normalizeOptionalNumber(
    req?.seed ?? reqSampler?.seed ?? config.seed ?? cfgSampler?.seed
  );
  const rawStop =
    req?.stopSequences ?? reqSampler?.stop ?? config.stopSequences ?? cfgSampler?.stop;
  const stop = rawStop !== undefined ? [...rawStop] : undefined;

  return {
    ...(temperature !== undefined ? { temperature } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(maxContextTokens !== undefined ? { maxContextTokens } : {}),
    ...(topP !== undefined ? { topP } : {}),
    ...(topK !== undefined ? { topK } : {}),
    ...(minP !== undefined ? { minP } : {}),
    ...(topA !== undefined ? { topA } : {}),
    ...(typicalP !== undefined ? { typicalP } : {}),
    ...(tfs !== undefined ? { tfs } : {}),
    ...(frequencyPenalty !== undefined ? { frequencyPenalty } : {}),
    ...(presencePenalty !== undefined ? { presencePenalty } : {}),
    ...(repetitionPenalty !== undefined ? { repetitionPenalty } : {}),
    ...(stop !== undefined && stop.length > 0 ? { stop } : {}),
    ...(seed !== undefined ? { seed } : {}),
  };
}

/**
 * Create a defensive, `-0`-normalized copy of a partial {@link SamplerPreset}.
 */
export function clonePartialSampler(sampler: Partial<SamplerPreset>): Partial<SamplerPreset> {
  const temperature = normalizeOptionalNumber(sampler.temperature);
  const topP = normalizeOptionalNumber(sampler.topP);
  const topK = normalizeOptionalNumber(sampler.topK);
  const minP = normalizeOptionalNumber(sampler.minP);
  const repetitionPenalty = normalizeOptionalNumber(sampler.repetitionPenalty);
  const frequencyPenalty = normalizeOptionalNumber(sampler.frequencyPenalty);
  const presencePenalty = normalizeOptionalNumber(sampler.presencePenalty);
  const maxTokens = normalizeOptionalNumber(sampler.maxTokens);
  const seed = normalizeOptionalNumber(sampler.seed);

  return {
    ...(sampler.id !== undefined ? { id: sampler.id } : {}),
    ...(sampler.name !== undefined ? { name: sampler.name } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(topP !== undefined ? { topP } : {}),
    ...(topK !== undefined ? { topK } : {}),
    ...(minP !== undefined ? { minP } : {}),
    ...(repetitionPenalty !== undefined ? { repetitionPenalty } : {}),
    ...(frequencyPenalty !== undefined ? { frequencyPenalty } : {}),
    ...(presencePenalty !== undefined ? { presencePenalty } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(sampler.stop !== undefined ? { stop: [...sampler.stop] } : {}),
    ...(seed !== undefined ? { seed } : {}),
  };
}

/**
 * Invoke either a custom `fetchImpl` or `globalThis.fetch`.
 */
export function invokeFetch(
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

/**
 * Handle for a combined caller `AbortSignal` and per-request timeout timer.
 */
export interface CombinedSignalHandle {
  readonly signal: AbortSignal | undefined;
  readonly isTimedOut: () => boolean;
  readonly cleanup: () => void;
}

/**
 * Combine an optional caller `AbortSignal` with an optional `timeoutMs`.
 */
export function createCombinedSignal(
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

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === 'TimeoutError';
}

/**
 * Map an HTTP status code and response body into a {@link ProviderFailure}.
 */
export function classifyHttpFailure(status: number, bodyText: string): ProviderFailure {
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

/**
 * Map a thrown fetch/stream exception into a {@link ProviderFailure}.
 */
export function classifyCaughtProviderError(
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

/**
 * Sleep for `delayMs` while aborting immediately if `signal` fires.
 */
export function sleepWithAbort(delayMs: number, signal?: AbortSignal): Promise<boolean> {
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
 * A parsed Server-Sent Events (SSE) frame.
 */
export interface SseEventFrame {
  readonly event?: string;
  readonly data: string;
}

/**
 * Stream and parse SSE frames from a `Response` body with abort/cleanup guarantees.
 */
export async function* readSseEvents(
  response: Response,
  callerSignal: AbortSignal | undefined,
  isTimedOut: () => boolean
): AsyncGenerator<Result<SseEventFrame, ProviderFailure>> {
  if (response.body === null) {
    yield err({
      code: 'EMPTY_RESPONSE_BODY',
      message: 'Streaming response did not include a readable body',
      retryable: false,
    });
    return;
  }

  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let lineBuffer = '';
    let currentEvent: string | undefined;
    let dataLines: string[] = [];

    const flushEvent = (): SseEventFrame | undefined => {
      if (dataLines.length === 0) {
        currentEvent = undefined;
        return undefined;
      }
      const frame: SseEventFrame =
        currentEvent !== undefined
          ? { event: currentEvent, data: dataLines.join('\n') }
          : { data: dataLines.join('\n') };
      currentEvent = undefined;
      dataLines = [];
      return frame;
    };

    const processLine = (rawLine: string): SseEventFrame | undefined => {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (line.length === 0) {
        return flushEvent();
      }
      if (line.startsWith(':')) {
        return undefined;
      }
      if (line.startsWith('event:')) {
        currentEvent = line.slice(6).trim();
        return undefined;
      }
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
      return undefined;
    };

    while (true) {
      if (callerSignal?.aborted) {
        yield err({ code: 'ABORTED', message: 'Request was aborted', isAbort: true, retryable: false });
        return;
      }

      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      lineBuffer += decoder.decode(value, { stream: true });
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() ?? '';

      for (const rawLine of lines) {
        const frame = processLine(rawLine);
        if (frame !== undefined) {
          yield ok(frame);
        }
      }
    }

    const trailing = lineBuffer + decoder.decode();
    if (trailing.length > 0) {
      for (const rawLine of trailing.split('\n')) {
        const frame = processLine(rawLine);
        if (frame !== undefined) {
          yield ok(frame);
        }
      }
    }

    const finalFrame = flushEvent();
    if (finalFrame !== undefined) {
      yield ok(finalFrame);
    }
  } catch (caught) {
    yield err(classifyCaughtProviderError(caught, callerSignal, isTimedOut));
  } finally {
    if (reader !== undefined) {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}

/**
 * Stream newline-delimited JSON lines from a `Response` body with abort/cleanup guarantees.
 */
export async function* readNdjsonLines(
  response: Response,
  callerSignal: AbortSignal | undefined,
  isTimedOut: () => boolean
): AsyncGenerator<Result<string, ProviderFailure>> {
  if (response.body === null) {
    yield err({
      code: 'EMPTY_RESPONSE_BODY',
      message: 'Streaming response did not include a readable body',
      retryable: false,
    });
    return;
  }

  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let lineBuffer = '';

    while (true) {
      if (callerSignal?.aborted) {
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
        const trimmed = rawLine.trim();
        if (trimmed.length > 0) {
          yield ok(trimmed);
        }
      }
    }

    const trailing = (lineBuffer + decoder.decode()).trim();
    if (trailing.length > 0) {
      yield ok(trailing);
    }
  } catch (caught) {
    yield err(classifyCaughtProviderError(caught, callerSignal, isTimedOut));
  } finally {
    if (reader !== undefined) {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}

/**
 * Result of separating `<think>...</think>` blocks from visible output text.
 */
export interface SeparatedThinkingText {
  readonly text: string;
  readonly thinking: string;
}

/**
 * Separate `<think>...</think>` reasoning blocks from visible text.
 */
export function separateThinkingTags(input: string): SeparatedThinkingText {
  const thinkingParts: string[] = [];
  const stripped = input.replace(/<think>([\s\S]*?)<\/think>/gi, (_match, inner: string) => {
    const trimmed = inner.trim();
    if (trimmed.length > 0) {
      thinkingParts.push(trimmed);
    }
    return '';
  });

  return {
    text: thinkingParts.length > 0 ? stripped.trimStart() : stripped,
    thinking: thinkingParts.join('\n\n'),
  };
}

/**
 * Stateful streaming filter that strips `<think>...</think>` blocks across arbitrary chunk boundaries.
 */
export interface ThinkingStreamFilter {
  push(chunk: string): string;
  flush(): string;
}

const OPEN_THINK_TAG = '<think>';
const CLOSE_THINK_TAG = '</think>';

/**
 * Create a streaming `<think>...</think>` filter safe against split tag boundaries.
 */
export function createThinkingStreamFilter(): ThinkingStreamFilter {
  let inThinking = false;
  let buffer = '';

  const findTrailingPartialPrefixLength = (text: string, tag: string): number => {
    const lower = text.toLowerCase();
    const maxLen = Math.min(lower.length, tag.length - 1);
    for (let len = maxLen; len >= 1; len -= 1) {
      if (lower.endsWith(tag.slice(0, len))) {
        return len;
      }
    }
    return 0;
  };

  const drain = (isFinal: boolean): string => {
    let output = '';
    while (buffer.length > 0) {
      const lower = buffer.toLowerCase();
      if (!inThinking) {
        const openIdx = lower.indexOf(OPEN_THINK_TAG);
        if (openIdx !== -1) {
          output += buffer.slice(0, openIdx);
          buffer = buffer.slice(openIdx + OPEN_THINK_TAG.length);
          inThinking = true;
          continue;
        }
        if (isFinal) {
          output += buffer;
          buffer = '';
        } else {
          const keepLen = findTrailingPartialPrefixLength(buffer, OPEN_THINK_TAG);
          if (keepLen > 0) {
            output += buffer.slice(0, buffer.length - keepLen);
            buffer = buffer.slice(buffer.length - keepLen);
          } else {
            output += buffer;
            buffer = '';
          }
        }
        break;
      }

      const closeIdx = lower.indexOf(CLOSE_THINK_TAG);
      if (closeIdx !== -1) {
        buffer = buffer.slice(closeIdx + CLOSE_THINK_TAG.length);
        inThinking = false;
        continue;
      }

      if (isFinal) {
        buffer = '';
      } else {
        const keepLen = findTrailingPartialPrefixLength(buffer, CLOSE_THINK_TAG);
        buffer = keepLen > 0 ? buffer.slice(buffer.length - keepLen) : '';
      }
      break;
    }
    return output;
  };

  return {
    push(chunk: string): string {
      if (chunk.length === 0) {
        return '';
      }
      buffer += chunk;
      return drain(false);
    },
    flush(): string {
      return drain(true);
    },
  };
}
