import type { RefereeBridgeClient } from './bridge-client.js';
import type { DirectorBarState } from './director-bar.js';

export const REFEREE_CONTEXT_TAG: '[REFEREE_CONTEXT]';

export const DEFAULT_EVENT_NAMES: Readonly<{
  MESSAGE_RECEIVED: string;
  CHARACTER_MESSAGE_RENDERED: string;
  MESSAGE_SWIPED: string;
  MESSAGE_EDITED: string;
  CHAT_CHANGED: string;
}>;

export interface BridgeRuntimeState {
  client: RefereeBridgeClient;
  directorBar: DirectorBarState;
  activeSessionId: string | null;
  initialized: boolean;
}

export interface BridgeInitializeOptions {
  baseUrl?: string;
  fetchImpl?: typeof globalThis.fetch;
  client?: RefereeBridgeClient;
  directorBar?: DirectorBarState;
  sessionOptions?: Record<string, unknown>;
  hudContainer?: Record<string, unknown> | null;
  onStateUpdated?: (statePayload: Record<string, unknown>) => void;
}

export function getSillyTavernContext(): Record<string, unknown> | null;
export function isRefereeContextMessage(msg: unknown): boolean;
export function stripRefereeContextMessages(chat: unknown[]): void;
export function getBridgeRuntime(): BridgeRuntimeState;
export function refereeGenerateInterceptor(
  chat: unknown[],
  contextSize?: number,
  abort?: (reason?: unknown) => void,
  type?: string
): Promise<Record<string, unknown> | undefined>;
export function initialize(options?: BridgeInitializeOptions): BridgeRuntimeState;
export function dispose(): void;

export {
  RefereeBridgeClient,
  DirectorBarState,
};
export { renderHudStateHtml, bindHudPanelDom } from './hud-panel.js';
export { buildControlRoomViewModel, renderControlRoomModalHtml } from './control-room-modal.js';
