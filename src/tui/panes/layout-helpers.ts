/**
 * Shared pure-text layout, wrapping, meter formatting, and prototype-safe record helpers
 * for zero-dependency ANSI/readline TUI panes (Desktop and 80x24 Termux safe).
 */

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

export function isSafeRecordKey(key: string): boolean {
  return key.length > 0 && !FORBIDDEN_KEYS.has(key);
}

export function getSafeOwn<T>(
  record: Readonly<Record<string, T>> | undefined,
  key: string
): T | undefined {
  if (record === undefined || !isSafeRecordKey(key) || !Object.hasOwn(record, key)) {
    return undefined;
  }
  return Object.getOwnPropertyDescriptor(record, key)?.value as T | undefined;
}

export function setSafeOwn<T>(record: Record<string, T>, key: string, value: T): void {
  if (!isSafeRecordKey(key)) {
    return;
  }
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

export function compareStringsDeterministic(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

/**
 * Normalize line endings and clamp any single line cleanly to `width` characters.
 */
export function truncateLine(line: string, width: number): string {
  const safeWidth = Math.max(1, Math.floor(width));
  const sanitized = line.replace(/[\r\n\t]+/g, ' ');
  if (sanitized.length <= safeWidth) {
    return sanitized;
  }
  if (safeWidth <= 3) {
    return sanitized.slice(0, safeWidth);
  }
  return `${sanitized.slice(0, safeWidth - 3)}...`;
}

/**
 * Word-wrap multiline text so every output line has `line.length <= width`.
 * Long unbroken tokens are hard-wrapped cleanly to prevent viewport overflow.
 */
export function wrapText(text: string, width: number): string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  const normalized = text.replace(/\r\n?/g, '\n');
  const paragraphs = normalized.split('\n');
  const lines: string[] = [];

  for (const paragraph of paragraphs) {
    const cleaned = paragraph.replace(/\t/g, '  ').trimEnd();
    if (cleaned.length === 0) {
      lines.push('');
      continue;
    }

    const words = cleaned.split(/\s+/).filter((w) => w.length > 0);
    if (words.length === 0) {
      lines.push('');
      continue;
    }

    let current = '';
    for (const word of words) {
      if (word.length > safeWidth) {
        if (current.length > 0) {
          lines.push(current);
          current = '';
        }
        for (let i = 0; i < word.length; i += safeWidth) {
          const chunk = word.slice(i, i + safeWidth);
          if (chunk.length === safeWidth) {
            lines.push(chunk);
          } else {
            current = chunk;
          }
        }
        continue;
      }

      if (current.length === 0) {
        current = word;
      } else if (current.length + 1 + word.length <= safeWidth) {
        current = `${current} ${word}`;
      } else {
        lines.push(current);
        current = word;
      }
    }

    if (current.length > 0) {
      lines.push(current);
    }
  }

  return lines.length > 0 ? lines : [''];
}

/**
 * Render an ASCII bar meter (`Label [####....] 40/100`) fitted within `width`.
 */
export function renderMeterBar(
  label: string,
  current: number,
  max: number,
  width: number,
  min = 0
): string {
  const safeWidth = Math.max(1, Math.floor(width));
  const span = max - min;
  const ratio =
    span > 0 ? Math.max(0, Math.min(1, (current - min) / span)) : current > min ? 1 : 0;
  const numericSuffix = `${Math.round(current * 100) / 100}/${Math.round(max * 100) / 100}`;
  const barSlots = Math.max(4, Math.min(12, safeWidth - label.length - numericSuffix.length - 5));

  if (label.length + numericSuffix.length + 9 > safeWidth) {
    return truncateLine(`${label}: ${numericSuffix}`, safeWidth);
  }

  const filled = Math.round(ratio * barSlots);
  const empty = Math.max(0, barSlots - filled);
  const bar = `${'#'.repeat(filled)}${'.'.repeat(empty)}`;
  return truncateLine(`${label} [${bar}] ${numericSuffix}`, safeWidth);
}
