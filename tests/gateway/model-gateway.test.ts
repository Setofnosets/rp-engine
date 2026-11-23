import { describe, expect, it, vi } from 'vitest';
import { isErr, isOk } from '../../src/core/result.js';
import { MockModelProvider, createMockModelGateway } from '../../src/gateway/mock-provider.js';
import {
  AnthropicProvider,
  ModelGateway,
  OllamaProvider,
  OpenAICompatibleProvider,
} from '../../src/gateway/model-gateway.js';
import type { ChatMessage, RoleConnectionConfig, StreamChunk } from '../../src/gateway/types.js';

describe('ModelGateway per-role routing and configuration', () => {
  it('routes requests to per-role connections and falls back to defaultConnection', async () => {
    const mockProvider = new MockModelProvider({
      handlers: {
        narrator: 'The tavern hearth crackles.',
        combat_agent: '{"hit": true, "damage": 8}',
        storyline_planner: 'Plan the harbor ambush.',
      },
    });

    const roleConnections: Partial<Record<'narrator' | 'combat_agent', RoleConnectionConfig>> = {
      narrator: {
        role: 'narrator',
        provider: 'mock',
        baseUrl: 'mock://narrator',
        model: 'story-large-70b',
        temperature: 0.8,
      },
      combat_agent: {
        role: 'combat_agent',
        provider: 'mock',
        baseUrl: 'mock://combat',
        model: 'tactical-fast-8b',
        temperature: 0.1,
      },
    };

    const gateway = new ModelGateway({
      connections: roleConnections,
      defaultConnection: {
        provider: 'mock',
        baseUrl: 'mock://default',
        model: 'balanced-default',
      },
      providers: { mock: mockProvider },
    });

    // Mutating the caller-provided connections map after construction must not affect the gateway.
    delete roleConnections.narrator;

    const narratorRes = await gateway.generateText({
      role: 'narrator',
      messages: [{ role: 'user', content: 'Describe the room.' }],
    });
    expect(isOk(narratorRes)).toBe(true);
    if (isOk(narratorRes)) {
      expect(narratorRes.value).toBe('The tavern hearth crackles.');
    }

    const plannerRes = await gateway.generateText({
      role: 'storyline_planner',
      messages: [{ role: 'user', content: 'Next beat?' }],
    });
    expect(isOk(plannerRes)).toBe(true);
    if (isOk(plannerRes)) {
      expect(plannerRes.value).toBe('Plan the harbor ambush.');
    }

    const calls = mockProvider.recordedCalls;
    expect(calls).toHaveLength(2);
    expect(calls[0]?.config.model).toBe('story-large-70b');
    expect(calls[0]?.config.role).toBe('narrator');
    expect(calls[1]?.config.model).toBe('balanced-default');
    expect(calls[1]?.config.role).toBe('storyline_planner');
  });

  it('returns clear ValidationError when role config or provider is missing', async () => {
    const gatewayNoDefault = new ModelGateway({
      connections: {
        narrator: {
          role: 'narrator',
          provider: 'mock',
          baseUrl: 'mock://unregistered',
          model: 'unregistered-test',
        },
      },
    });

    const missingRoleRes = await gatewayNoDefault.generateText({
      role: 'state_tracker',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(isErr(missingRoleRes)).toBe(true);
    if (isErr(missingRoleRes)) {
      expect(missingRoleRes.error[0]?.code).toBe('MISSING_ROLE_CONFIG');
    }

    const missingProviderRes = await gatewayNoDefault.generateText({
      role: 'narrator',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(isErr(missingProviderRes)).toBe(true);
    if (isErr(missingProviderRes)) {
      expect(missingProviderRes.error[0]?.code).toBe('UNSUPPORTED_PROVIDER');
    }
  });
});

describe('ModelGateway retry logic and cancellation', () => {
  it('retries 429 and 5xx failures up to maxRetries and succeeds on recovery', async () => {
    const gateway = createMockModelGateway(
      {
        intent_parser: [
          { kind: 'error', status: 429, message: 'Rate limited' },
          { kind: 'error', status: 503, message: 'Upstream unavailable' },
          'Recovered intent',
        ],
      },
      { maxRetries: 2, baseRetryDelayMs: 1 }
    );

    const res = await gateway.generateText({
      role: 'intent_parser',
      messages: [{ role: 'user', content: 'Look around' }],
    });

    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value).toBe('Recovered intent');
    }
    expect(gateway.mockProvider.recordedCalls).toHaveLength(3);
  });

  it('returns an Err once maxRetries are exhausted on persistent 5xx errors', async () => {
    const gateway = createMockModelGateway(
      {
        combat_agent: { kind: 'error', status: 502, message: 'Bad Gateway' },
      },
      { maxRetries: 2, baseRetryDelayMs: 1 }
    );

    const res = await gateway.generateText({
      role: 'combat_agent',
      messages: [{ role: 'user', content: 'Attack goblin' }],
    });

    expect(isErr(res)).toBe(true);
    if (isErr(res)) {
      expect(res.error[0]?.code).toBe('HTTP_502');
      expect(res.error[0]?.message).toContain('[HTTP 502] Bad Gateway');
    }
    expect(gateway.mockProvider.recordedCalls).toHaveLength(3);
  });

  it('skips retries on 4xx client errors (other than 429) and AbortError', async () => {
    const gateway = createMockModelGateway(
      {
        narrator: [{ kind: 'error', status: 400, message: 'Invalid prompt' }, 'Should not reach'],
        cast_director: [
          { kind: 'error', code: 'ABORTED', message: 'Aborted by caller', isAbort: true },
          'Should not reach',
        ],
      },
      { maxRetries: 3, baseRetryDelayMs: 1 }
    );

    const badReqRes = await gateway.generateText({
      role: 'narrator',
      messages: [{ role: 'user', content: 'bad' }],
    });
    expect(isErr(badReqRes)).toBe(true);
    if (isErr(badReqRes)) {
      expect(badReqRes.error[0]?.code).toBe('HTTP_400');
    }
    expect(gateway.mockProvider.getCallsForRole('narrator')).toHaveLength(1);

    const abortErrRes = await gateway.generateText({
      role: 'cast_director',
      messages: [{ role: 'user', content: 'cast' }],
    });
    expect(isErr(abortErrRes)).toBe(true);
    if (isErr(abortErrRes)) {
      expect(abortErrRes.error[0]?.code).toBe('ABORTED');
    }
    expect(gateway.mockProvider.getCallsForRole('cast_director')).toHaveLength(1);
  });

  it('handles pre-aborted AbortSignal, mid-flight abort, and abort during retry backoff', async () => {
    const preAbortedController = new AbortController();
    preAbortedController.abort();

    const gateway = createMockModelGateway(
      {
        narrator: 'Never invoked',
        chronicle_router: { kind: 'text', text: 'Slow output', delayMs: 200 },
        state_tracker: [
          { kind: 'error', status: 429, message: 'Rate limited' },
          'Should not retry after abort',
        ],
      },
      { maxRetries: 2, baseRetryDelayMs: 100 }
    );

    const preRes = await gateway.generateText({
      role: 'narrator',
      messages: [{ role: 'user', content: 'hi' }],
      signal: preAbortedController.signal,
    });
    expect(isErr(preRes)).toBe(true);
    if (isErr(preRes)) {
      expect(preRes.error[0]?.code).toBe('ABORTED');
    }
    expect(gateway.mockProvider.getCallsForRole('narrator')).toHaveLength(0);

    // Mid-flight cancellation
    const midController = new AbortController();
    setTimeout(() => midController.abort(), 10);
    const midRes = await gateway.generateText({
      role: 'chronicle_router',
      messages: [{ role: 'user', content: 'summarize' }],
      signal: midController.signal,
    });
    expect(isErr(midRes)).toBe(true);
    if (isErr(midRes)) {
      expect(midRes.error[0]?.code).toBe('ABORTED');
    }

    // Abort during retry backoff window
    const backoffController = new AbortController();
    setTimeout(() => backoffController.abort(), 15);
    const backoffRes = await gateway.generateText({
      role: 'state_tracker',
      messages: [{ role: 'user', content: 'update' }],
      signal: backoffController.signal,
    });
    expect(isErr(backoffRes)).toBe(true);
    if (isErr(backoffRes)) {
      expect(backoffRes.error[0]?.code).toBe('ABORTED');
    }
    expect(gateway.mockProvider.getCallsForRole('state_tracker')).toHaveLength(1);
  });

  it('simulates request timeout both explicitly and via config.timeoutMs', async () => {
    const gateway = createMockModelGateway(
      {
        narrator: { kind: 'timeout', message: 'Upstream timed out' },
        game_system_wizard: { kind: 'text', text: 'Too slow', delayMs: 200 },
      },
      {
        connections: {
          game_system_wizard: {
            role: 'game_system_wizard',
            provider: 'mock',
            baseUrl: 'mock://local',
            model: 'mock-wizard',
            timeoutMs: 15,
          },
        },
        maxRetries: 2,
        baseRetryDelayMs: 1,
      }
    );

    const explicitTimeout = await gateway.generateText({
      role: 'narrator',
      messages: [{ role: 'user', content: 'go' }],
    });
    expect(isErr(explicitTimeout)).toBe(true);
    if (isErr(explicitTimeout)) {
      expect(explicitTimeout.error[0]?.code).toBe('TIMEOUT');
    }

    const configTimeout = await gateway.generateText({
      role: 'game_system_wizard',
      messages: [{ role: 'user', content: 'generate rules' }],
    });
    expect(isErr(configTimeout)).toBe(true);
    if (isErr(configTimeout)) {
      expect(configTimeout.error[0]?.code).toBe('TIMEOUT');
    }
  });
});

describe('ModelGateway streaming via MockModelProvider', () => {
  it('streams chunks deterministically and retries pre-chunk 5xx errors', async () => {
    const gateway = createMockModelGateway(
      {
        narrator: [
          { kind: 'error', status: 503, message: 'Temporary outage' },
          { kind: 'stream', chunks: ['The ', 'gate ', 'creaks ', 'open.'] },
        ],
      },
      { maxRetries: 1, baseRetryDelayMs: 1 }
    );

    const received: StreamChunk[] = [];
    for await (const item of gateway.streamText({
      role: 'narrator',
      messages: [{ role: 'user', content: 'Open the gate.' }],
    })) {
      expect(isOk(item)).toBe(true);
      if (isOk(item)) {
        received.push(item.value);
      }
    }

    expect(received).toEqual([
      { text: 'The ', done: false },
      { text: 'gate ', done: false },
      { text: 'creaks ', done: false },
      { text: 'open.', done: false },
      { text: '', done: true },
    ]);
    expect(gateway.mockProvider.recordedCalls).toHaveLength(2);
  });

  it('does not retry mid-stream failures and respects AbortSignal during streaming', async () => {
    const gateway = createMockModelGateway(
      {
        narrator: {
          kind: 'stream',
          chunks: ['Part 1 ', 'Part 2 ', 'Part 3'],
          failAfterChunks: 1,
          failure: { status: 500, message: 'Mid-stream crash' },
        },
        storyline_planner: {
          kind: 'stream',
          chunks: ['Step 1 ', 'Step 2 ', 'Step 3'],
          delayMs: 25,
        },
      },
      { maxRetries: 2, baseRetryDelayMs: 1 }
    );

    const chunksBeforeErr: string[] = [];
    let streamErrCode: string | undefined;
    for await (const item of gateway.streamText({
      role: 'narrator',
      messages: [{ role: 'user', content: 'Narrate' }],
    })) {
      if (isOk(item)) {
        chunksBeforeErr.push(item.value.text);
      } else {
        streamErrCode = item.error[0]?.code;
      }
    }

    expect(chunksBeforeErr).toEqual(['Part 1 ']);
    expect(streamErrCode).toBe('HTTP_500');
    expect(gateway.mockProvider.getCallsForRole('narrator')).toHaveLength(1);

    const abortController = new AbortController();
    const abortedChunks: string[] = [];
    let abortCode: string | undefined;
    for await (const item of gateway.streamText({
      role: 'storyline_planner',
      messages: [{ role: 'user', content: 'Plan' }],
      signal: abortController.signal,
    })) {
      if (isOk(item)) {
        abortedChunks.push(item.value.text);
        abortController.abort();
      } else {
        abortCode = item.error[0]?.code;
      }
    }
    expect(abortedChunks).toEqual(['Step 1 ']);
    expect(abortCode).toBe('ABORTED');
  });
});

describe('ModelGateway.generateStructured', () => {
  const actionSchema: Record<string, unknown> = {
    type: 'object',
    required: ['action', 'target', 'power'],
    additionalProperties: false,
    properties: {
      action: { type: 'string', enum: ['strike', 'cast', 'dodge'] },
      target: { type: 'string', minLength: 1 },
      power: { type: 'integer', minimum: 1, maximum: 10 },
    },
  };

  it('returns repaired: false on clean JSON and repaired: true after deterministic JSON repair', async () => {
    const gateway = createMockModelGateway({
      intent_parser: [
        '{"action": "strike", "target": "goblin", "power": 5}',
        '<think>choosing action</think>\n```json\n{"action": "cast", "target": "orc", "power": 9,}\n```',
      ],
    });

    const cleanRes = await gateway.generateStructured<{ action: string; target: string; power: number }>({
      role: 'intent_parser',
      messages: [{ role: 'user', content: 'hit goblin' }],
      schema: actionSchema,
    });
    expect(isOk(cleanRes)).toBe(true);
    if (isOk(cleanRes)) {
      expect(cleanRes.value).toEqual({
        data: { action: 'strike', target: 'goblin', power: 5 },
        rawText: '{"action": "strike", "target": "goblin", "power": 5}',
        repaired: false,
      });
    }

    const dirtyRes = await gateway.generateStructured<{ action: string; target: string; power: number }>({
      role: 'intent_parser',
      messages: [{ role: 'user', content: 'cast at orc' }],
      schema: actionSchema,
    });
    expect(isOk(dirtyRes)).toBe(true);
    if (isOk(dirtyRes)) {
      expect(dirtyRes.value.repaired).toBe(true);
      expect(dirtyRes.value.data).toEqual({ action: 'cast', target: 'orc', power: 9 });
    }
  });

  it('performs LLM repair retries when maxRepairAttempts > 0 and fails cleanly when exhausted', async () => {
    const gateway = createMockModelGateway({
      state_tracker: [
        '{"action": "fly", "target": "", "power": 99}',
        '{"action": "dodge", "target": "arrow", "power": 3}',
      ],
      combat_agent: ['not json', 'still bad'],
    });

    const initialMessages: ChatMessage[] = [{ role: 'user', content: 'Evade the arrow!' }];
    const repairedRes = await gateway.generateStructured<{ action: string; target: string; power: number }>({
      role: 'state_tracker',
      messages: initialMessages,
      schema: actionSchema,
      schemaName: 'combat_action',
      maxRepairAttempts: 2,
    });

    expect(isOk(repairedRes)).toBe(true);
    if (isOk(repairedRes)) {
      expect(repairedRes.value).toEqual({
        data: { action: 'dodge', target: 'arrow', power: 3 },
        rawText: '{"action": "dodge", "target": "arrow", "power": 3}',
        repaired: true,
      });
    }

    const trackerCalls = gateway.mockProvider.getCallsForRole('state_tracker');
    expect(trackerCalls).toHaveLength(2);
    expect(trackerCalls[1]?.messages).toHaveLength(3);
    expect(trackerCalls[1]?.messages[1]?.role).toBe('assistant');
    expect(trackerCalls[1]?.messages[2]?.content).toContain('Validation errors:');
    // Original messages array must not have been mutated.
    expect(initialMessages).toHaveLength(1);

    const exhaustedRes = await gateway.generateStructured({
      role: 'combat_agent',
      messages: [{ role: 'user', content: 'Attack' }],
      schema: actionSchema,
      maxRepairAttempts: 1,
    });
    expect(isErr(exhaustedRes)).toBe(true);
    if (isErr(exhaustedRes)) {
      expect(exhaustedRes.error[0]?.code).toBe('INVALID_JSON');
    }
    expect(gateway.mockProvider.getCallsForRole('combat_agent')).toHaveLength(2);
  });
});

describe('OpenAICompatibleProvider with fetch', () => {
  it('sends OpenAI-compatible payloads, handles 429 retries, and parses SSE streams', async () => {
    const encoder = new TextEncoder();
    const fetchMock = vi
      .fn<typeof fetch>()
      // 1st call: 429 rate limit
      .mockResolvedValueOnce(new Response('rate limit exceeded', { status: 429 }))
      // 2nd call: structured JSON success
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"ok": true}' } }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
      // 3rd call: SSE stream split across arbitrary byte boundaries
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                encoder.encode('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\ndata: {"choices":')
              );
              controller.enqueue(
                encoder.encode('[{"delta":{"content":"lo!"}}]}\n\ndata: [DONE]\n\n')
              );
              controller.close();
            },
          }),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
        )
      );

    const provider = new OpenAICompatibleProvider(fetchMock);
    const gateway = new ModelGateway({
      connections: {
        intent_parser: {
          role: 'intent_parser',
          provider: 'openai_compatible',
          baseUrl: 'https://llm.example.test/v1/',
          apiKey: 'secret-key',
          model: 'gpt-test',
          supportsJsonSchema: true,
        },
        narrator: {
          role: 'narrator',
          provider: 'openai_compatible',
          baseUrl: 'https://llm.example.test/v1/chat/completions',
          model: 'gpt-stream',
        },
      },
      providers: { openai_compatible: provider },
      maxRetries: 1,
      baseRetryDelayMs: 1,
    });

    const structuredRes = await gateway.generateStructured<{ ok: boolean }>({
      role: 'intent_parser',
      messages: [{ role: 'user', content: 'Ping' }],
      schema: {
        type: 'object',
        required: ['ok'],
        properties: { ok: { type: 'boolean' } },
      },
      schemaName: 'ping_schema',
    });

    expect(isOk(structuredRes)).toBe(true);
    if (isOk(structuredRes)) {
      expect(structuredRes.value).toEqual({
        data: { ok: true },
        rawText: '{"ok": true}',
        repaired: false,
      });
    }

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [reqUrl, reqInit] = fetchMock.mock.calls[1] ?? [];
    expect(reqUrl).toBe('https://llm.example.test/v1/chat/completions');
    expect((reqInit?.headers as Record<string, string>)?.Authorization).toBe('Bearer secret-key');
    const parsedBody = JSON.parse(String(reqInit?.body)) as Record<string, unknown>;
    expect(parsedBody.response_format).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'ping_schema',
        strict: true,
        schema: {
          type: 'object',
          required: ['ok'],
          properties: { ok: { type: 'boolean' } },
        },
      },
    });

    const streamChunks: string[] = [];
    for await (const item of gateway.streamText({
      role: 'narrator',
      messages: [{ role: 'user', content: 'Greet' }],
    })) {
      expect(isOk(item)).toBe(true);
      if (isOk(item) && item.value.text.length > 0) {
        streamChunks.push(item.value.text);
      }
    }
    expect(streamChunks).toEqual(['Hel', 'lo!']);
    expect(fetchMock.mock.calls[2]?.[0]).toBe('https://llm.example.test/v1/chat/completions');
  });

  it('merges connection SamplingParameters with request overrides and applies threshold guards', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

    const gateway = new ModelGateway({
      fetchImpl: fetchMock,
      connections: {
        narrator: {
          role: 'narrator',
          provider: 'openai_compatible',
          baseUrl: 'https://llm.example.test/v1',
          model: 'story-70b',
          temperature: 0.7,
          maxTokens: 512,
          topP: 0.9,
          topK: 40,
          minP: 0.05,
          topA: 0.2,
          typicalP: 0.95,
          tfs: 0.9,
          frequencyPenalty: 0.3,
          presencePenalty: 0.2,
          repetitionPenalty: 1.1,
          stopSequences: ['###', 'END'],
          seed: 42,
        },
      },
    });

    // 1. Connection defaults forwarded cleanly
    const defaultRes = await gateway.generateText({
      role: 'narrator',
      messages: [{ role: 'user', content: 'Hello' }],
    });
    expect(isOk(defaultRes)).toBe(true);

    const body1 = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body1).toMatchObject({
      model: 'story-70b',
      temperature: 0.7,
      max_tokens: 512,
      top_p: 0.9,
      top_k: 40,
      min_p: 0.05,
      top_a: 0.2,
      typical_p: 0.95,
      tfs: 0.9,
      frequency_penalty: 0.3,
      presence_penalty: 0.2,
      repetition_penalty: 1.1,
      stop: ['###', 'END'],
      seed: 42,
    });

    // 2. Request overrides take precedence and threshold guards omit disabled params (0 / 1 / [])
    const overrideRes = await gateway.generateText({
      role: 'narrator',
      messages: [{ role: 'user', content: 'Override' }],
      temperature: 0.2,
      topK: 0,
      minP: 0,
      topA: 0,
      typicalP: 1,
      tfs: 1,
      stopSequences: [],
      seed: 99,
    });
    expect(isOk(overrideRes)).toBe(true);

    const body2 = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as Record<string, unknown>;
    expect(body2.temperature).toBe(0.2);
    expect(body2.seed).toBe(99);
    expect(body2.top_p).toBe(0.9);
    expect(body2).not.toHaveProperty('top_k');
    expect(body2).not.toHaveProperty('min_p');
    expect(body2).not.toHaveProperty('top_a');
    expect(body2).not.toHaveProperty('typical_p');
    expect(body2).not.toHaveProperty('tfs');
    expect(body2).not.toHaveProperty('stop');
  });
});

describe('OllamaProvider via ModelGateway', () => {
  it('normalizes OpenAI-compatible /v1/chat/completions URLs and streams SSE', async () => {
    const encoder = new TextEncoder();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ choices: [{ message: { content: 'Ollama OpenAI reply' } }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Chunk1 "}}]}\n\n'));
              controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Chunk2"}}]}\n\n'));
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              controller.close();
            },
          }),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
        )
      );

    const gateway = new ModelGateway({
      fetchImpl: fetchMock,
      connections: {
        narrator: {
          role: 'narrator',
          provider: 'ollama',
          baseUrl: 'http://localhost:11434',
          model: 'llama3.1:8b',
          temperature: 0.6,
        },
        intent_parser: {
          role: 'intent_parser',
          provider: 'ollama',
          baseUrl: 'http://localhost:11434/v1/',
          model: 'qwen2.5:7b',
        },
      },
    });

    const textRes = await gateway.generateText({
      role: 'narrator',
      messages: [{ role: 'user', content: 'Hi' }],
    });
    expect(isOk(textRes)).toBe(true);
    if (isOk(textRes)) {
      expect(textRes.value).toBe('Ollama OpenAI reply');
    }
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://localhost:11434/v1/chat/completions');

    const chunks: string[] = [];
    for await (const item of gateway.streamText({
      role: 'intent_parser',
      messages: [{ role: 'user', content: 'Stream' }],
    })) {
      expect(isOk(item)).toBe(true);
      if (isOk(item) && item.value.text.length > 0) {
        chunks.push(item.value.text);
      }
    }
    expect(chunks).toEqual(['Chunk1 ', 'Chunk2']);
    expect(fetchMock.mock.calls[1]?.[0]).toBe('http://localhost:11434/v1/chat/completions');
  });

  it('supports native /api/chat fallback with Ollama options, format, and NDJSON streaming', async () => {
    const encoder = new TextEncoder();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            model: 'llama3.1',
            message: { role: 'assistant', content: '{"ok":true}' },
            done: true,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                encoder.encode('{"message":{"role":"assistant","content":"Hel"},"done":false}\n')
              );
              controller.enqueue(
                encoder.encode('{"message":{"role":"assistant","content":"lo"},"done":true}\n')
              );
              controller.close();
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } }
        )
      );

    const provider = new OllamaProvider(fetchMock);
    const gateway = new ModelGateway({
      providers: { ollama: provider },
      connections: {
        narrator: {
          role: 'narrator',
          provider: 'ollama',
          baseUrl: 'http://localhost:11434/api/chat/',
          model: 'llama3.1',
          supportsJsonSchema: true,
          temperature: 0.5,
          maxTokens: 300,
          maxContextTokens: 8192,
          topK: 30,
          repetitionPenalty: 1.15,
          tfs: 0.95,
          stopSequences: ['STOP'],
          seed: 7,
        },
      },
    });

    const structuredRes = await gateway.generateStructured<{ ok: boolean }>({
      role: 'narrator',
      messages: [{ role: 'user', content: 'Check' }],
      schema: {
        type: 'object',
        required: ['ok'],
        properties: { ok: { type: 'boolean' } },
      },
    });
    expect(isOk(structuredRes)).toBe(true);
    if (isOk(structuredRes)) {
      expect(structuredRes.value.data).toEqual({ ok: true });
    }

    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://localhost:11434/api/chat');
    const nativeBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(nativeBody.options).toEqual({
      temperature: 0.5,
      num_predict: 300,
      num_ctx: 8192,
      top_k: 30,
      tfs_z: 0.95,
      repeat_penalty: 1.15,
      stop: ['STOP'],
      seed: 7,
    });
    expect(nativeBody.format).toEqual({
      type: 'object',
      required: ['ok'],
      properties: { ok: { type: 'boolean' } },
    });

    const streamed: StreamChunk[] = [];
    for await (const chunk of gateway.streamText({
      role: 'narrator',
      messages: [{ role: 'user', content: 'Greet' }],
    })) {
      expect(isOk(chunk)).toBe(true);
      if (isOk(chunk)) {
        streamed.push(chunk.value);
      }
    }
    expect(streamed).toEqual([
      { text: 'Hel', done: false },
      { text: 'lo', done: false },
      { text: '', done: true },
    ]);
  });
});

describe('AnthropicProvider via ModelGateway', () => {
  it('sends /v1/messages with x-api-key, anthropic-version, extracted system prompt, and SSE deltas', async () => {
    const encoder = new TextEncoder();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'internal' },
              { type: 'text', text: 'First ' },
              { type: 'text', text: 'reply.' },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_2"}}\n\n' +
                    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Streamed "}}\n\n'
                )
              );
              controller.enqueue(
                encoder.encode(
                  'event: ping\ndata: {"type":"ping"}\n\n' +
                    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"text"}}\n\n' +
                    'event: message_stop\ndata: {"type":"message_stop"}\n\n'
                )
              );
              controller.close();
            },
          }),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
        )
      );

    const provider = new AnthropicProvider(fetchMock);
    const gateway = new ModelGateway({
      providers: { anthropic: provider },
      connections: {
        narrator: {
          role: 'narrator',
          provider: 'anthropic',
          baseUrl: 'https://api.anthropic.com',
          apiKey: 'sk-ant-secret',
          model: 'claude-3-7-sonnet-latest',
          temperature: 0.75,
          topP: 0.92,
          topK: 25,
          stopSequences: ['Human:'],
        },
      },
    });

    const res = await gateway.generateText({
      role: 'narrator',
      messages: [
        { role: 'system', content: 'You are a narrator.' },
        { role: 'system', content: 'Stay concise.' },
        { role: 'user', content: 'Open the door.' },
      ],
    });
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value).toBe('First reply.');
    }

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init?.headers).toEqual({
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': 'sk-ant-secret',
    });

    const parsedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(parsedBody).toEqual({
      model: 'claude-3-7-sonnet-latest',
      max_tokens: 1024,
      system: 'You are a narrator.\n\nStay concise.',
      messages: [{ role: 'user', content: 'Open the door.' }],
      stream: false,
      temperature: 0.75,
      top_p: 0.92,
      top_k: 25,
      stop_sequences: ['Human:'],
    });

    const chunks: StreamChunk[] = [];
    for await (const item of gateway.streamText({
      role: 'narrator',
      messages: [{ role: 'user', content: 'Continue' }],
      maxTokens: 2048,
    })) {
      expect(isOk(item)).toBe(true);
      if (isOk(item)) {
        chunks.push(item.value);
      }
    }
    expect(chunks).toEqual([
      { text: 'Streamed ', done: false },
      { text: 'text', done: false },
      { text: '', done: true },
    ]);

    const streamBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as Record<string, unknown>;
    expect(streamBody.max_tokens).toBe(2048);
    expect(streamBody.stream).toBe(true);
  });
});

describe('ModelGateway role removal and snapshot redaction', () => {
  it('supports removeRoleConnection, clearRoleConnections, and redacted/unredacted snapshots', () => {
    const gateway = new ModelGateway({
      defaultConnection: {
        provider: 'openai_compatible',
        baseUrl: 'https://default.test/v1',
        apiKey: 'default-secret',
        model: 'default-model',
        temperature: 0.6,
        topK: 40,
        stopSequences: ['END'],
      },
      connections: {
        narrator: {
          role: 'narrator',
          provider: 'anthropic',
          baseUrl: 'https://api.anthropic.com',
          apiKey: 'narrator-secret',
          model: 'claude-sonnet',
          maxContextTokens: 16384,
          supportsJsonSchema: false,
        },
        intent_parser: {
          role: 'intent_parser',
          provider: 'ollama',
          baseUrl: 'http://localhost:11434',
          model: 'llama3',
        },
      },
    });

    // Backward-compatible unredacted snapshot preserves all fields including secrets
    const unredacted = gateway.getConnectionsSnapshot();
    expect(unredacted.defaultConnection?.apiKey).toBe('default-secret');
    expect(unredacted.defaultConnection?.topK).toBe(40);
    expect(unredacted.defaultConnection?.stopSequences).toEqual(['END']);
    expect(unredacted.connections.narrator?.apiKey).toBe('narrator-secret');
    expect(unredacted.connections.narrator?.maxContextTokens).toBe(16384);
    expect(unredacted.connections.intent_parser?.apiKey).toBeUndefined();

    // Redacted snapshot replaces non-empty apiKeys with '***' without altering internal state
    const redacted = gateway.getConnectionsSnapshot({ redactApiKeys: true });
    expect(redacted.defaultConnection?.apiKey).toBe('***');
    expect(redacted.connections.narrator?.apiKey).toBe('***');
    expect(redacted.connections.intent_parser?.apiKey).toBeUndefined();
    expect(gateway.getConnectionsSnapshot().connections.narrator?.apiKey).toBe('narrator-secret');

    // removeRoleConnection returns true when present and false when absent
    expect(gateway.removeRoleConnection('narrator')).toBe(true);
    expect(gateway.removeRoleConnection('narrator')).toBe(false);

    // Removed role falls back to defaultConnection
    const resolvedAfterRemove = gateway.resolveConnection('narrator');
    expect(isOk(resolvedAfterRemove)).toBe(true);
    if (isOk(resolvedAfterRemove)) {
      expect(resolvedAfterRemove.value.model).toBe('default-model');
    }

    // clearRoleConnections clears remaining per-role overrides while keeping defaultConnection
    gateway.clearRoleConnections();
    const afterClear = gateway.getConnectionsSnapshot();
    expect(Object.keys(afterClear.connections)).toHaveLength(0);
    expect(afterClear.defaultConnection?.model).toBe('default-model');
  });
});
