export function escapeHtml(raw: unknown): string;

export interface HudDomHandlers {
  onAcceptAll?: () => void;
  onRejectAll?: () => void;
  onAcceptIndex?: (idx: number) => void;
}

export function renderHudStateHtml(sessionState: Record<string, unknown> | null | undefined): string;

export function bindHudPanelDom(
  container: Record<string, unknown>,
  sessionState: Record<string, unknown>,
  handlers?: HudDomHandlers
): () => void;
