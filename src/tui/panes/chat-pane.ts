import { truncateLine, wrapText } from './layout-helpers.js';

export interface ChatPaneMessage {
  readonly role: string;
  readonly content: string;
  readonly swipeIndex?: number;
  readonly swipeCount?: number;
}

export interface RenderChatPaneParams {
  readonly messages: ReadonlyArray<ChatPaneMessage>;
  readonly streamingBuffer?: string;
  readonly width: number;
  readonly maxLines: number;
}

function formatRoleLabel(role: string): string {
  switch (role.toLowerCase()) {
    case 'user':
      return 'Player';
    case 'assistant':
      return 'Narrator';
    case 'system':
      return 'System';
    default:
      return role.trim().length > 0 ? role.trim() : 'Message';
  }
}

/**
 * Render transcript messages and optional streaming buffer wrapped cleanly to `width`
 * and bounded to the most recent `maxLines` lines for Desktop and 80x24 Termux viewports.
 */
export function renderChatPane(params: RenderChatPaneParams): string[] {
  const width = Math.max(1, Math.floor(params.width));
  const maxLines = Math.max(0, Math.floor(params.maxLines));
  if (maxLines === 0) {
    return [];
  }

  const lines: string[] = [];
  const hasStreaming = params.streamingBuffer !== undefined && params.streamingBuffer.length > 0;

  if (params.messages.length === 0 && !hasStreaming) {
    const emptyLines = wrapText('(No messages yet. Type an action or /help for commands.)', width);
    return emptyLines.slice(0, maxLines);
  }

  for (let i = 0; i < params.messages.length; i += 1) {
    const msg = params.messages[i];
    if (msg === undefined) {
      continue;
    }

    const roleLabel = formatRoleLabel(msg.role);
    const swipeBadge =
      msg.swipeCount !== undefined && msg.swipeCount > 1
        ? ` [${(msg.swipeIndex ?? 0) + 1}/${msg.swipeCount}]`
        : '';
    const header = truncateLine(`[${roleLabel}]${swipeBadge}`, width);
    lines.push(header);

    const bodyLines = wrapText(msg.content, width);
    for (const bodyLine of bodyLines) {
      lines.push(truncateLine(bodyLine, width));
    }

    if (i < params.messages.length - 1 || hasStreaming) {
      lines.push('');
    }
  }

  if (hasStreaming && params.streamingBuffer !== undefined) {
    lines.push(truncateLine('[Narrator] (streaming)', width));
    const streamLines = wrapText(params.streamingBuffer, width);
    for (const streamLine of streamLines) {
      lines.push(truncateLine(streamLine, width));
    }
  }

  if (lines.length > maxLines) {
    return lines.slice(lines.length - maxLines);
  }
  return lines;
}
