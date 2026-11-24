import { describe, expect, it, vi } from 'vitest';
import { isErr, isOk } from '../../src/core/result.js';
import { ModelGateway } from '../../src/gateway/model-gateway.js';
import type { ConnectionPreset, SamplerPreset, StreamChunk } from '../../src/gateway/types.js';

function createByteStream(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

describe('AnthropicProvider via ModelGateway', () => {
  it('sends Anthropic headers, prompt-cache blocks, sampler params, and separates thinking blocks', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'msg_1',
            type: 'message',
            content: [
              { type: 'thinking', thinking: 'Internal reasoning that should not appear.' },
              { type: 'text', text: '<think>inline thought</think>The lantern flickers in the fog.' },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

    const gateway = new ModelGateway({
      fetchImpl: fetchMock,
      connections: {
        narrator: {
          role: 'narrator',
          provider: 'anthropic',
          baseUrl: 'https://api.anthropic.com',
          apiKey: 'sk-ant-test',
          model: 'claude-sonnet-4-5',
          enablePromptCache: true,
          sampler: {
            temperature: 0.7,
            topP: 0.92,
            topK: 40,
            maxTokens: 1024,
            stop: ['</scene>'],
          },
        },
      },
    });

    const res = await gateway.generateText({
      role: 'narrator',
      messages: [
        { role: 'system', content: 'You are a dark-fantasy narrator.' },
        { role: 'user', content: 'Describe the harbor.' },
      ],
    });

    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value).toBe('The lantern flickers in the fog.');
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    const headers = init?.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');

    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body.model).toBe('claude-sonnet-4-5');
    expect(body.max_tokens).toBe(1024);
    expect(body.temperature).toBe(0.7);
    expect(body.top_p).toBe(0.92);
    expect(body.top_k).toBe(40);
    expect(body.stop_sequences).toEqual(['</scene>']);
    expect(body.system).toEqual([
      {
        type: 'text',
        text: 'You are a dark-fantasy narrator.',
        cache_control: { type: 'ephemeral' },
      },
    ]);
    expect(body.messages).toEqual([{ role: 'user', content: 'Describe the harbor.' }]);
  });

  it('streams Anthropic content_block_delta text while filtering thinking deltas and inline <think> tags', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        createByteStream([
          'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"secret"}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"<thi"}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"nk>hmm</think>Hello "}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"world!"}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ]),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
      )
    );

    const gateway = new ModelGateway({
      fetchImpl: fetchMock,
      connections: {
        narrator: {
          role: 'narrator',
          provider: 'anthropic',
          baseUrl: 'https://api.anthropic.com/v1',
          apiKey: 'sk-ant-test',
          model: 'claude-sonnet-4-5',
        },
      },
    });

    const chunks: StreamChunk[] = [];
    for await (const item of gateway.streamText({
      role: 'narrator',
      messages: [{ role: 'user', content: 'Say hello.' }],
    })) {
      expect(isOk(item)).toBe(true);
      if (isOk(item)) {
        chunks.push(item.value);
      }
    }

    expect(chunks).toEqual([
      { text: 'Hello ', done: false },
      { text: 'world!', done: false },
      { text: '', done: true },
    ]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.anthropic.com/v1/messages');
  });

  it('retries 429 failures, repairs structured JSON, and propagates AbortSignal', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            content: [
              { type: 'thinking', thinking: 'Checking schema' },
              { type: 'text', text: '```json\n{"action": "strike", "power": 7,}\n```' },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

    const gateway = new ModelGateway({
      fetchImpl: fetchMock,
      maxRetries: 1,
      baseRetryDelayMs: 1,
      connections: {
        intent_parser: {
          role: 'intent_parser',
          provider: 'anthropic',
          baseUrl: 'https://api.anthropic.com',
          apiKey: 'sk-ant-test',
          model: 'claude-haiku',
        },
      },
    });

    const structuredRes = await gateway.generateStructured<{ action: string; power: number }>({
      role: 'intent_parser',
      messages: [{ role: 'user', content: 'Attack!' }],
      schema: {
        type: 'object',
        required: ['action', 'power'],
        properties: {
          action: { type: 'string' },
          power: { type: 'integer' },
        },
      },
      schemaName: 'action_schema',
    });

    expect(isOk(structuredRes)).toBe(true);
    if (isOk(structuredRes)) {
      expect(structuredRes.value.data).toEqual({ action: 'strike', power: 7 });
      expect(structuredRes.value.repaired).toBe(true);
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const controller = new AbortController();
    controller.abort();
    const abortedRes = await gateway.generateText({
      role: 'intent_parser',
      messages: [{ role: 'user', content: 'Never sent' }],
      signal: controller.signal,
    });
    expect(isErr(abortedRes)).toBe(true);
    if (isErr(abortedRes)) {
      expect(abortedRes.error[0]?.code).toBe('ABORTED');
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('GeminiProvider via ModelGateway', () => {
  it('sends systemInstruction, generationConfig, responseSchema, and handles batch + SSE streaming', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      // 1st call: structured generateContent
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    { thought: true, text: 'reasoning' },
                    { text: '{"intent": "inspect", "target": "altar",}' },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
      // 2nd call: SSE streamGenerateContent
      .mockResolvedValueOnce(
        new Response(
          createByteStream([
            'data: {"candidates":[{"content":{"parts":[{"thought":true,"text":"plan"}]}}]}\n\n',
            'data: {"candidates":[{"content":{"parts":[{"text":"Stone "}]}}]}\n\n',
            'data: {"candidates":[{"content":{"parts":[{"text":"runes glow."}]}}]}\n\n',
          ]),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
        )
      );

    const gateway = new ModelGateway({
      fetchImpl: fetchMock,
      connections: {
        state_tracker: {
          role: 'state_tracker',
          provider: 'gemini',
          baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
          apiKey: 'gem-key',
          model: 'gemini-2.5-flash',
          sampler: {
            temperature: 0.2,
            topP: 0.85,
            topK: 32,
            maxTokens: 512,
            seed: 42,
            stop: ['END'],
          },
        },
      },
    });

    const schema = {
      type: 'object',
      required: ['intent', 'target'],
      properties: {
        intent: { type: 'string' },
        target: { type: 'string' },
      },
    };

    const structuredRes = await gateway.generateStructured<{ intent: string; target: string }>({
      role: 'state_tracker',
      messages: [
        { role: 'system', content: 'Extract structured intent.' },
        { role: 'user', content: 'Examine the altar.' },
        { role: 'assistant', content: 'Checking...' },
      ],
      schema,
    });

    expect(isOk(structuredRes)).toBe(true);
    if (isOk(structuredRes)) {
      expect(structuredRes.value.data).toEqual({ intent: 'inspect', target: 'altar' });
      expect(structuredRes.value.repaired).toBe(true);
    }

    const [batchUrl, batchInit] = fetchMock.mock.calls[0] ?? [];
    expect(batchUrl).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent'
    );
    expect((batchInit?.headers as Record<string, string>)['x-goog-api-key']).toBe('gem-key');
    const batchBody = JSON.parse(String(batchInit?.body)) as Record<string, unknown>;
    expect(batchBody.systemInstruction).toEqual({
      parts: [{ text: 'Extract structured intent.' }],
    });
    expect(batchBody.contents).toEqual([
      { role: 'user', parts: [{ text: 'Examine the altar.' }] },
      { role: 'model', parts: [{ text: 'Checking...' }] },
    ]);
    expect(batchBody.generationConfig).toEqual({
      temperature: 0.2,
      topP: 0.85,
      topK: 32,
      maxOutputTokens: 512,
      stopSequences: ['END'],
      seed: 42,
      responseMimeType: 'application/json',
      responseSchema: schema,
    });

    const streamedText: string[] = [];
    for await (const item of gateway.streamText({
      role: 'state_tracker',
      messages: [{ role: 'user', content: 'Describe the altar.' }],
    })) {
      expect(isOk(item)).toBe(true);
      if (isOk(item) && item.value.text.length > 0) {
        streamedText.push(item.value.text);
      }
    }

    expect(streamedText).toEqual(['Stone ', 'runes glow.']);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse'
    );
  });

  it('retries 503 errors on Gemini and aborts cleanly when signal fires mid-flight', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('service unavailable', { status: 503 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: 'Recovered Gemini text' }] } }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
      .mockImplementationOnce((_url, init) => {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) {
            reject(new DOMException('Aborted', 'AbortError'));
            return;
          }
          signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        });
      });

    const gateway = new ModelGateway({
      fetchImpl: fetchMock,
      maxRetries: 1,
      baseRetryDelayMs: 1,
      connections: {
        storyline_planner: {
          role: 'storyline_planner',
          provider: 'gemini',
          baseUrl: 'https://generativelanguage.googleapis.com',
          apiKey: 'gem-key',
          model: 'gemini-2.5-pro',
        },
      },
    });

    const okRes = await gateway.generateText({
      role: 'storyline_planner',
      messages: [{ role: 'user', content: 'Plan beat.' }],
    });
    expect(isOk(okRes)).toBe(true);
    if (isOk(okRes)) {
      expect(okRes.value).toBe('Recovered Gemini text');
    }

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    const abortRes = await gateway.generateText({
      role: 'storyline_planner',
      messages: [{ role: 'user', content: 'Slow beat.' }],
      signal: controller.signal,
    });
    expect(isErr(abortRes)).toBe(true);
    if (isErr(abortRes)) {
      expect(abortRes.error[0]?.code).toBe('ABORTED');
    }
  });
});

describe('OllamaProvider and Gateway Presets', () => {
  it('routes native Ollama /api/chat with sampler options, structured format, and NDJSON streaming', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            message: { role: 'assistant', content: '<think>local</think>{"ok": true,}' },
            done: true,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          createByteStream([
            '{"message":{"content":"<think>draft</think>Ash "},"done":false}\n',
            '{"message":{"content":"falls."},"done":false}\n',
            '{"message":{"content":""},"done":true}\n',
          ]),
          { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } }
        )
      );

    const samplerPreset: SamplerPreset = {
      id: 'local-creative',
      name: 'Local Creative',
      temperature: 0.75,
      topP: 0.9,
      topK: 50,
      minP: 0.05,
      repetitionPenalty: 1.12,
      maxTokens: 768,
      seed: -0,
    };

    const connectionPreset: ConnectionPreset = {
      id: 'ollama-qwen',
      name: 'Ollama Qwen3',
      provider: 'ollama',
      baseUrl: 'http://localhost:11434/api/chat',
      model: 'qwen3:8b',
      samplerPresetId: 'local-creative',
    };

    const gateway = new ModelGateway({
      fetchImpl: fetchMock,
      samplerPresets: [samplerPreset],
      connectionPresets: [connectionPreset],
    });

    // Mutate caller preset objects to verify defensive copying.
    (samplerPreset as { temperature: number }).temperature = 99;

    const applied = gateway.applyConnectionPreset('combat_agent', 'ollama-qwen');
    expect(isOk(applied)).toBe(true);
    if (isOk(applied)) {
      expect(applied.value.sampler?.temperature).toBe(0.75);
      expect(Object.is(applied.value.sampler?.seed, -0)).toBe(false);
      expect(applied.value.sampler?.seed).toBe(0);
    }

    const structuredRes = await gateway.generateStructured<{ ok: boolean }>({
      role: 'combat_agent',
      messages: [{ role: 'user', content: 'Check status' }],
      schema: {
        type: 'object',
        required: ['ok'],
        properties: { ok: { type: 'boolean' } },
      },
      sampler: { temperature: 0.1 },
    });

    expect(isOk(structuredRes)).toBe(true);
    if (isOk(structuredRes)) {
      expect(structuredRes.value.data).toEqual({ ok: true });
      expect(structuredRes.value.repaired).toBe(true);
    }

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('http://localhost:11434/api/chat');
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body.options).toEqual({
      temperature: 0.1,
      top_p: 0.9,
      top_k: 50,
      min_p: 0.05,
      repeat_penalty: 1.12,
      num_predict: 768,
      seed: 0,
    });
    expect(body.format).toEqual({
      type: 'object',
      required: ['ok'],
      properties: { ok: { type: 'boolean' } },
    });

    const streamed: string[] = [];
    for await (const chunk of gateway.streamText({
      role: 'combat_agent',
      messages: [{ role: 'user', content: 'Describe ash' }],
    })) {
      expect(isOk(chunk)).toBe(true);
      if (isOk(chunk) && chunk.value.text.length > 0) {
        streamed.push(chunk.value.text);
      }
    }
    expect(streamed).toEqual(['Ash ', 'falls.']);
  });

  it('resolves apiKeyEnv from ConnectionPreset and validates unknown preset IDs', async () => {
    const gateway = new ModelGateway();
    gateway.registerConnectionPreset({
      id: 'claude-prod',
      name: 'Claude Prod',
      provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-sonnet-4-5',
      apiKeyEnv: 'ANTHROPIC_API_KEY',
      enablePromptCache: true,
    });
    gateway.registerSamplerPreset({
      id: 'strict-json',
      name: 'Strict JSON',
      temperature: 0,
      topP: 1,
    });

    const applied = gateway.applyConnectionPreset('narrator', 'claude-prod', {
      ANTHROPIC_API_KEY: 'env-secret-key',
    });
    expect(isOk(applied)).toBe(true);
    if (isOk(applied)) {
      expect(applied.value.apiKey).toBe('env-secret-key');
      expect(applied.value.enablePromptCache).toBe(true);
    }

    const appliedSampler = gateway.applySamplerPreset('narrator', 'strict-json');
    expect(isOk(appliedSampler)).toBe(true);
    if (isOk(appliedSampler)) {
      expect(appliedSampler.value.sampler?.temperature).toBe(0);
    }

    const badConn = gateway.applyConnectionPreset('narrator', 'does-not-exist');
    expect(isErr(badConn)).toBe(true);
    if (isErr(badConn)) {
      expect(badConn.error[0]?.code).toBe('UNKNOWN_CONNECTION_PRESET');
    }

    const badSampler = gateway.applySamplerPreset('narrator', 'does-not-exist');
    expect(isErr(badSampler)).toBe(true);
    if (isErr(badSampler)) {
      expect(badSampler.error[0]?.code).toBe('UNKNOWN_SAMPLER_PRESET');
    }

    expect(gateway.listConnectionPresets()).toHaveLength(1);
    expect(gateway.listSamplerPresets()).toHaveLength(1);
  });
});
