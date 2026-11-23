export function escapeHtml(raw: unknown): string;

export interface HudDomHandlers {
  onAcceptAll?: () => void;
  onRejectAll?: () => void;
  onAcceptIndex?: (idx: number) => void;
  settingRoster?: Record<string, unknown>;
}

export interface RenderHudOptions {
  settingRoster?: Record<string, unknown>;
}

export function renderHudStateHtml(
  sessionState: Record<string, unknown> | null | undefined,
  options?: RenderHudOptions
): string;

export function renderHudPanel(
  sessionState: Record<string, unknown> | null | undefined,
  options?: RenderHudOptions
): string;

export function bindHudPanelDom(
  container: Record<string, unknown>,
  sessionState: Record<string, unknown>,
  handlers?: HudDomHandlers
): () => void;
