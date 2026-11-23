import type { PatchSource } from './patch.js';

/**
 * Outcome status recorded for an evaluated {@link PatchOperation}.
 */
export type AuditStatus = 'committed' | 'rejected' | 'pending_confirmation';

/**
 * Single immutable entry in the append-only state mutation audit log.
 */
export interface AuditEntry {
  turn: number;
  storyTurn: number;
  timestampSeq: number;
  source: PatchSource;
  eventId: string;
  op: string;
  path: string;
  oldValue: unknown;
  newValue: unknown;
  status: AuditStatus;
  reason?: string;
}

/**
 * Immutable append-only container of {@link AuditEntry} records.
 */
export interface AuditLog {
  readonly entries: readonly AuditEntry[];
}

/**
 * Filter predicates accepted by {@link queryAuditLog}.
 */
export interface AuditLogFilter {
  turn?: number;
  source?: PatchSource;
  pathPrefix?: string;
  status?: AuditEntry['status'];
  eventId?: string;
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function cloneAuditUnknown(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(cloneAuditUnknown);
  }
  if (value instanceof Date) {
    return new Date(value.getTime());
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.has(key)) {
        continue;
      }
      Object.defineProperty(out, key, {
        value: cloneAuditUnknown(val),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  return value;
}

function cloneAuditEntry(entry: AuditEntry): AuditEntry {
  const cloned: AuditEntry = {
    turn: entry.turn,
    storyTurn: entry.storyTurn,
    timestampSeq: entry.timestampSeq,
    source: entry.source,
    eventId: entry.eventId,
    op: entry.op,
    path: entry.path,
    oldValue: cloneAuditUnknown(entry.oldValue),
    newValue: cloneAuditUnknown(entry.newValue),
    status: entry.status,
  };
  if (entry.reason !== undefined) {
    cloned.reason = entry.reason;
  }
  return Object.freeze(cloned);
}

/**
 * Create a new immutable {@link AuditLog}, optionally seeded with initial {@link AuditEntry} records.
 */
export function createAuditLog(entries: readonly AuditEntry[] = []): AuditLog {
  return Object.freeze({
    entries: Object.freeze(entries.map(cloneAuditEntry)),
  });
}

/**
 * Return a new {@link AuditLog} with `newEntries` appended in order without mutating `log`.
 */
export function appendAuditEntries(
  log: AuditLog,
  newEntries: readonly AuditEntry[]
): AuditLog {
  if (newEntries.length === 0) {
    return log;
  }
  return Object.freeze({
    entries: Object.freeze([...log.entries, ...newEntries.map(cloneAuditEntry)]),
  });
}

/**
 * Query an {@link AuditLog} using optional equality and path-prefix predicates.
 */
export function queryAuditLog(
  log: AuditLog,
  filter: AuditLogFilter = {}
): readonly AuditEntry[] {
  const results: AuditEntry[] = [];
  for (const entry of log.entries) {
    if (filter.turn !== undefined && entry.turn !== filter.turn) {
      continue;
    }
    if (filter.source !== undefined && entry.source !== filter.source) {
      continue;
    }
    if (filter.status !== undefined && entry.status !== filter.status) {
      continue;
    }
    if (filter.eventId !== undefined && entry.eventId !== filter.eventId) {
      continue;
    }
    if (filter.pathPrefix !== undefined && !entry.path.startsWith(filter.pathPrefix)) {
      continue;
    }
    results.push(cloneAuditEntry(entry));
  }
  return Object.freeze(results);
}
