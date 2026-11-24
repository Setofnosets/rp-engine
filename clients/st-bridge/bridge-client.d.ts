export function isSafePropertyKey(key: string): boolean;
export function getSafeOwn(obj: Record<string, unknown> | null | undefined, key: string): unknown;
export function setSafeOwn(obj: Record<string, unknown>, key: string, value: unknown): void;

export class RefereeBridgeError extends Error {
  readonly status: number;
  readonly errors: unknown[];
  readonly payload: unknown;
  constructor(
    message: string,
    details?: { status?: number; errors?: unknown[]; payload?: unknown }
  );
}

export interface RefereeBridgeClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof globalThis.fetch;
}

export class RefereeBridgeClient {
  readonly baseUrl: string;
  constructor(options?: RefereeBridgeClientOptions);
  health(): Promise<Record<string, unknown>>;
  listSystemPacks(): Promise<Record<string, unknown>>;
  registerSystemPack(systemPack: Record<string, unknown>): Promise<Record<string, unknown>>;
  listCartridges(): Promise<Record<string, unknown>>;
  importCartridge(payload: Record<string, unknown> | string): Promise<Record<string, unknown>>;
  createSession(params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  getSessionState(sessionId: string): Promise<Record<string, unknown>>;
  patchControlRoom(
    sessionId: string,
    layerOrPack: Record<string, unknown>
  ): Promise<Record<string, unknown>>;
  generateWizardSystem(req: Record<string, unknown>): Promise<Record<string, unknown>>;
  compilePrompt(
    sessionId: string,
    payload?: Record<string, unknown>
  ): Promise<Record<string, unknown>>;
  postNarrate(
    sessionId: string,
    payload: Record<string, unknown>
  ): Promise<Record<string, unknown>>;
  swipe(sessionId: string, payload: Record<string, unknown>): Promise<Record<string, unknown>>;
  confirmPatch(
    sessionId: string,
    decision:
      | 'accept_all'
      | 'reject_all'
      | { acceptIndices: number[] }
      | Record<string, unknown>
  ): Promise<Record<string, unknown>>;
  getAudit(
    sessionId: string,
    query?: { turn?: number; pathPrefix?: string; source?: string }
  ): Promise<Record<string, unknown>>;
  getChronicle(sessionId: string): Promise<Record<string, unknown>>;
  previewCombat(sessionId: string, payload: Record<string, unknown>): Promise<Record<string, unknown>>;
  travel(sessionId: string, payload: Record<string, unknown>): Promise<Record<string, unknown>>;
  downtime(sessionId: string, payload: Record<string, unknown>): Promise<Record<string, unknown>>;
  cloneSession(
    sessionId: string,
    payload?: Record<string, unknown>
  ): Promise<Record<string, unknown>>;
  listSessions(): Promise<Record<string, unknown>>;
  getContextBudget(sessionId: string): Promise<Record<string, unknown>>;
  importCard(payload: Record<string, unknown>): Promise<Record<string, unknown>>;
  bindPlayer(sessionId: string, payload: Record<string, unknown>): Promise<Record<string, unknown>>;
}
