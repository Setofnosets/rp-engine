import type { AuditEntry } from '../../state/audit-log.js';
import type { ChronicleEntry } from '../../state/world-state.js';
import { truncateLine, wrapText } from './layout-helpers.js';

export interface RenderAuditAndChroniclePaneParams {
  readonly auditEntries: readonly AuditEntry[];
  readonly chronicleEvents: readonly ChronicleEntry[];
  readonly filter?: string;
  readonly mode: 'audit' | 'chronicle';
  readonly width: number;
}

function matchesAuditFilter(entry: AuditEntry, filterLower: string): boolean {
  if (filterLower.length === 0) {
    return true;
  }
  const haystack = [
    String(entry.turn),
    entry.source,
    entry.op,
    entry.path,
    entry.status,
    entry.reason ?? '',
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(filterLower);
}

function matchesChronicleFilter(entry: ChronicleEntry, filterLower: string): boolean {
  if (filterLower.length === 0) {
    return true;
  }
  const haystack = [
    String(entry.turn),
    String(entry.day),
    entry.category,
    entry.title,
    entry.summary,
    entry.date ?? '',
    ...entry.keywords,
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(filterLower);
}

/**
 * Render either the immutable patch Audit Log or the episodic Chronicle timeline,
 * supporting optional case-insensitive filtering and clean line wrapping to `width`.
 */
export function renderAuditAndChroniclePane(
  params: RenderAuditAndChroniclePaneParams
): string[] {
  const width = Math.max(1, Math.floor(params.width));
  const rawFilter = params.filter?.trim() ?? '';
  const filterLower = rawFilter.toLowerCase();
  const filterLabel = rawFilter.length > 0 ? ` (filter: "${rawFilter}")` : '';
  const lines: string[] = [];

  if (params.mode === 'audit') {
    const filtered = params.auditEntries.filter((entry) => matchesAuditFilter(entry, filterLower));
    lines.push(
      truncateLine(`AUDIT LOG${filterLabel} [${filtered.length}/${params.auditEntries.length}]`, width)
    );
    if (filtered.length === 0) {
      lines.push(truncateLine('(No matching audit entries)', width));
      return lines;
    }

    for (const entry of filtered) {
      const valText = entry.newValue === undefined ? 'undefined' : JSON.stringify(entry.newValue);
      const summary = `T${entry.turn} [${entry.status}] (${entry.source}) ${entry.op} ${entry.path} = ${valText}`;
      for (const wrapped of wrapText(summary, width)) {
        lines.push(wrapped);
      }
    }
    return lines;
  }

  const filtered = params.chronicleEvents.filter((entry) =>
    matchesChronicleFilter(entry, filterLower)
  );
  lines.push(
    truncateLine(`CHRONICLE${filterLabel} [${filtered.length}/${params.chronicleEvents.length}]`, width)
  );
  if (filtered.length === 0) {
    lines.push(truncateLine('(No matching chronicle events)', width));
    return lines;
  }

  for (const ev of filtered) {
    const datePart = ev.date !== null ? `${ev.date} ` : '';
    const summary = `Day ${ev.day} ${datePart}(T${ev.turn}) [${ev.category}] ${ev.title}: ${ev.summary}`;
    for (const wrapped of wrapText(summary, width)) {
      lines.push(wrapped);
    }
  }
  return lines;
}
