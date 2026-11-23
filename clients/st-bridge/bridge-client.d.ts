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
  getConnections(options?: {
    redact?: boolean;
    redactApiKeys?: boolean;
  }): Promise<Record<string, unknown>>;
  updateConnections(payload: Record<string, unknown>): Promise<Record<string, unknown>>;
  saveConnectionProfile(
    name: string,
    payload?: Record<string, unknown>
  ): Promise<Record<string, unknown>>;
  activateConnectionProfile(name: string): Promise<Record<string, unknown>>;
  listPresets(): Promise<Record<string, unknown>>;
  importPreset(payload: Record<string, unknown>): Promise<Record<string, unknown>>;
  exportSessionPreset(
    sessionId: string,
    format?: 'st_chat' | 'st_text' | 'referee'
  ): Promise<Record<string, unknown>>;
  applyPreset(sessionId: string, payload: Record<string, unknown>): Promise<Record<string, unknown>>;
  listPersonas(): Promise<Record<string, unknown>>;
  savePersona(persona: Record<string, unknown>): Promise<Record<string, unknown>>;
  applySessionPersona(
    sessionId: string,
    payload: Record<string, unknown>
  ): Promise<Record<string, unknown>>;
  getSettingCharacters(
    sessionId: string,
    filter?: {
      locationId?: string;
      status?: string;
      allegiance?: string;
      formGroup?: string;
      presentOnly?: boolean;
      includePlayer?: boolean;
      query?: string;
    }
  ): Promise<Record<string, unknown>>;
  getCharacterDossier(sessionId: string, charId: string): Promise<Record<string, unknown>>;
  upsertCharacter(
    sessionId: string,
    payload: Record<string, unknown>
  ): Promise<Record<string, unknown>>;
  startCombat(sessionId: string, payload: Record<string, unknown>): Promise<Record<string, unknown>>;
}
