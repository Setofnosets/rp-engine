import type { Result } from '../core/result.js';

/**
 * Logical agent role identifier used by {@link ModelGateway} for per-role model routing.
 */
export type AgentRole =
  | 'narrator'
  | 'intent_parser'
  | 'combat_agent'
  | 'state_tracker'
  | 'storyline_planner'
  | 'cast_director'
  | 'chronicle_router'
  | 'game_system_wizard';

/**
 * Supported backend provider kinds.
 */
export type ProviderKind =
  | 'openai_compatible'
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'ollama'
  | 'mock';

/**
 * Reusable sampler configuration preset assignable to roles or connections.
 */
export interface SamplerPreset {
  readonly id: string;
  readonly name: string;
  readonly temperature?: number;
  readonly topP?: number;
  readonly topK?: number;
  readonly minP?: number;
  readonly repetitionPenalty?: number;
  readonly frequencyPenalty?: number;
  readonly presencePenalty?: number;
  readonly maxTokens?: number;
  readonly stop?: readonly string[];
  readonly seed?: number;
}

/**
 * Reusable connection preset for cloud or local model endpoints.
 */
export interface ConnectionPreset {
  readonly id: string;
  readonly name: string;
  readonly provider: ProviderKind;
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKeyEnv?: string;
  readonly apiKey?: string;
  readonly samplerPresetId?: string;
  readonly enablePromptCache?: boolean;
  readonly timeoutMs?: number;
  readonly supportsJsonSchema?: boolean;
}

/**
 * Connection and inference configuration bound to an {@link AgentRole}.
 */
export interface RoleConnectionConfig {
  readonly role: AgentRole;
  readonly provider: ProviderKind;
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly model: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly timeoutMs?: number;
  readonly supportsJsonSchema?: boolean;
  readonly sampler?: Partial<SamplerPreset>;
  readonly samplerPresetId?: string;
  readonly enablePromptCache?: boolean;
}

/**
 * A single conversational message sent to a model provider.
 */
export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
  readonly name?: string;
}

/**
 * Request payload for free-form or streamed text generation.
 */
export interface GatewayGenerateTextRequest {
  readonly role: AgentRole;
  readonly messages: readonly ChatMessage[];
  readonly signal?: AbortSignal;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly sampler?: Partial<SamplerPreset>;
  readonly enablePromptCache?: boolean;
}

/**
 * Request payload for schema-validated structured JSON generation.
 */
export interface GatewayStructuredRequest {
  readonly role: AgentRole;
  readonly messages: readonly ChatMessage[];
  readonly schema: Record<string, unknown>;
  readonly schemaName?: string;
  readonly signal?: AbortSignal;
  readonly maxRepairAttempts?: number;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly sampler?: Partial<SamplerPreset>;
  readonly enablePromptCache?: boolean;
}

/**
 * Incremental text chunk yielded by streaming text generation.
 */
export interface StreamChunk {
  readonly text: string;
  readonly done: boolean;
}

/**
 * Normalized failure returned by a {@link ModelProvider}.
 */
export interface ProviderFailure {
  readonly code: string;
  readonly message: string;
  readonly status?: number;
  readonly retryable?: boolean;
  readonly isAbort?: boolean;
  readonly details?: unknown;
}

/**
 * Successful output of {@link ModelGateway.generateStructured}.
 */
export interface GatewayStructuredOutput<T> {
  readonly data: T;
  readonly rawText: string;
  readonly repaired: boolean;
}

/**
 * Provider adapter interface implemented by real HTTP backends and mock test providers.
 */
export interface ModelProvider {
  readonly kind?: ProviderKind;
  generateText(
    config: RoleConnectionConfig,
    req: GatewayGenerateTextRequest
  ): Promise<Result<string, ProviderFailure>>;
  streamText(
    config: RoleConnectionConfig,
    req: GatewayGenerateTextRequest
  ): AsyncIterable<Result<StreamChunk, ProviderFailure>>;
  generateStructuredRaw(
    config: RoleConnectionConfig,
    req: GatewayStructuredRequest
  ): Promise<Result<string, ProviderFailure>>;
}
