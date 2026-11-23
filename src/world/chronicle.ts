import { type ValidationError, validationError } from '../core/errors.js';
import { ErrorAccumulator, type Result, err, ok } from '../core/result.js';
import { slugifyLocationName } from '../state/spatial-topology.js';
import {
  CHRONICLE_CATEGORIES,
  type ChronicleEntry,
  type WorldState,
} from '../state/world-state.js';

/**
 * Query parameters used by {@link getRelevantChronicleEntries} to retrieve episodic memories.
 */
export interface ChronicleQueryOptions {
  presentCharacterIds?: readonly string[];
  currentLocationId?: string | null;
  currentLocationName?: string;
  recentTranscriptLines?: readonly string[];
  maxEntries?: number;
}

/**
 * Scored memory record returned by {@link getRelevantChronicleEntries}.
 */
export interface ScoredChronicleEntry {
  entry: ChronicleEntry;
  score: number;
}

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
const VALID_CATEGORIES: ReadonlySet<string> = new Set(CHRONICLE_CATEGORIES);

function isSafeKey(key: string): boolean {
  return key.length > 0 && !FORBIDDEN_KEYS.has(key);
}

function getOwn<T>(record: Record<string, T>, key: string): T | undefined {
  if (!isSafeKey(key) || !Object.hasOwn(record, key)) {
    return undefined;
  }
  return Object.getOwnPropertyDescriptor(record, key)?.value as T | undefined;
}

function cloneEntry(entry: ChronicleEntry): ChronicleEntry {
  return {
    id: entry.id,
    turn: entry.turn,
    day: entry.day,
    date: entry.date,
    title: entry.title,
    category: entry.category,
    summary: entry.summary,
    locationId: entry.locationId,
    involvedEntityIds: [...entry.involvedEntityIds],
    keywords: [...entry.keywords],
  };
}

function deduplicateStringsPreserveOrder(values: readonly string[], caseInsensitive: boolean): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const raw of values) {
    if (typeof raw !== 'string') {
      continue;
    }
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const key = caseInsensitive ? trimmed.toLowerCase() : trimmed;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(trimmed);
  }

  return result;
}

function mergeChronicleSummaries(existingSummary: string, incomingSummary: string): string {
  const existingTrimmed = existingSummary.trim();
  const incomingTrimmed = incomingSummary.trim();

  if (existingTrimmed.length === 0) {
    return incomingTrimmed;
  }
  if (incomingTrimmed.length === 0) {
    return existingTrimmed;
  }

  const existingLower = existingTrimmed.toLowerCase();
  const incomingLower = incomingTrimmed.toLowerCase();
  if (existingLower.includes(incomingLower)) {
    return existingTrimmed;
  }
  if (incomingLower.includes(existingLower)) {
    return incomingTrimmed;
  }

  return `${existingTrimmed}\n${incomingTrimmed}`;
}

/**
 * Validate an incoming chronicle entry payload using {@link ErrorAccumulator}.
 */
export function validateChronicleEntryInput(
  incoming: Omit<ChronicleEntry, 'id'> & { id?: string }
): Result<Omit<ChronicleEntry, 'id'> & { id?: string }, ValidationError[]> {
  const acc = new ErrorAccumulator('chronicleEntry');

  if (typeof incoming !== 'object' || incoming === null) {
    return err([
      validationError('chronicleEntry', 'INVALID_TYPE', 'Chronicle entry must be an object'),
    ]);
  }
  if (typeof incoming.title !== 'string' || incoming.title.trim().length === 0) {
    acc.add('title', 'REQUIRED', 'Chronicle entry title must be a non-empty string');
  }
  if (typeof incoming.category !== 'string' || !VALID_CATEGORIES.has(incoming.category)) {
    acc.add('category', 'INVALID_ENUM', `Invalid ChronicleCategory "${String(incoming.category)}"`);
  }
  if (typeof incoming.summary !== 'string') {
    acc.add('summary', 'INVALID_TYPE', 'Chronicle entry summary must be a string');
  }
  if (typeof incoming.turn !== 'number' || !Number.isInteger(incoming.turn) || incoming.turn < 0) {
    acc.add('turn', 'INVALID_INTEGER', 'turn must be a non-negative integer');
  }
  if (typeof incoming.day !== 'number' || !Number.isInteger(incoming.day) || incoming.day < 0) {
    acc.add('day', 'INVALID_INTEGER', 'day must be a non-negative integer');
  }
  if (incoming.date !== null && typeof incoming.date !== 'string') {
    acc.add('date', 'INVALID_TYPE', 'date must be a string or null');
  }
  if (incoming.locationId !== null && typeof incoming.locationId !== 'string') {
    acc.add('locationId', 'INVALID_TYPE', 'locationId must be a string or null');
  }
  if (
    !Array.isArray(incoming.involvedEntityIds) ||
    !incoming.involvedEntityIds.every((id) => typeof id === 'string')
  ) {
    acc.add('involvedEntityIds', 'INVALID_TYPE', 'involvedEntityIds must be string[]');
  }
  if (!Array.isArray(incoming.keywords) || !incoming.keywords.every((kw) => typeof kw === 'string')) {
    acc.add('keywords', 'INVALID_TYPE', 'keywords must be string[]');
  }

  if (acc.hasErrors()) {
    return err([...acc.errors]);
  }
  return ok(incoming);
}

/**
 * Insert or accumulate a chronicle entry without mutating the input array or entries.
 *
 * When an existing entry matches `incoming.title` case-insensitively (Multihog chronicle
 * accumulation semantics), its `involvedEntityIds`, `keywords`, and `summary` accumulate in place
 * while preserving the original entry `id`. Otherwise, a new entry is appended with a
 * deterministic `id`.
 */
export function upsertChronicleEntry(
  events: readonly ChronicleEntry[],
  incoming: Omit<ChronicleEntry, 'id'> & { id?: string }
): ChronicleEntry[] {
  const nextEvents = events.map(cloneEntry);
  const trimmedTitle = incoming.title.trim();
  const normalizedTitle = trimmedTitle.toLowerCase();

  const existingIdx =
    normalizedTitle.length > 0
      ? nextEvents.findIndex((evt) => evt.title.trim().toLowerCase() === normalizedTitle)
      : -1;

  if (existingIdx >= 0) {
    const existing = nextEvents[existingIdx]!;
    const useIncomingTimeline = incoming.turn >= existing.turn;

    const updated: ChronicleEntry = {
      id: existing.id,
      turn: Math.max(existing.turn, incoming.turn),
      day: useIncomingTimeline ? Math.max(existing.day, incoming.day) : existing.day,
      date: useIncomingTimeline ? (incoming.date ?? existing.date) : existing.date,
      title: existing.title.trim().length > 0 ? existing.title.trim() : trimmedTitle,
      category: useIncomingTimeline ? incoming.category : existing.category,
      summary: mergeChronicleSummaries(existing.summary, incoming.summary),
      locationId: incoming.locationId ?? existing.locationId,
      involvedEntityIds: deduplicateStringsPreserveOrder(
        [...existing.involvedEntityIds, ...incoming.involvedEntityIds],
        false
      ),
      keywords: deduplicateStringsPreserveOrder([...existing.keywords, ...incoming.keywords], true),
    };

    nextEvents[existingIdx] = updated;
    return nextEvents;
  }

  const baseId =
    typeof incoming.id === 'string' && incoming.id.trim().length > 0
      ? incoming.id.trim()
      : `chronicle-${incoming.turn}-${slugifyLocationName(trimmedTitle)}`;

  const existingIds = new Set(nextEvents.map((e) => e.id));
  let uniqueId = baseId;
  let suffix = 2;
  while (existingIds.has(uniqueId)) {
    uniqueId = `${baseId}-${suffix}`;
    suffix += 1;
  }

  nextEvents.push({
    id: uniqueId,
    turn: incoming.turn,
    day: incoming.day,
    date: incoming.date,
    title: trimmedTitle,
    category: incoming.category,
    summary: incoming.summary.trim(),
    locationId: incoming.locationId,
    involvedEntityIds: deduplicateStringsPreserveOrder(incoming.involvedEntityIds, false),
    keywords: deduplicateStringsPreserveOrder(incoming.keywords, true),
  });

  return nextEvents;
}

function normalizeSearchText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function extractTokens(normalizedText: string): string[] {
  return normalizedText.match(/[\p{L}\p{N}]+/gu) ?? [];
}

function buildTranscriptMatcher(lines: readonly string[]): (term: string) => boolean {
  const joined = normalizeSearchText(lines.join('\n'));
  if (joined.trim().length === 0) {
    return () => false;
  }

  const rawTokens = extractTokens(joined);
  const tokenSet = new Set(rawTokens);
  const spaceJoined = rawTokens.join(' ');

  return (term: string): boolean => {
    const normalizedTerm = normalizeSearchText(term).trim();
    if (normalizedTerm.length === 0) {
      return false;
    }
    const termTokens = extractTokens(normalizedTerm);
    if (termTokens.length === 0) {
      return false;
    }
    if (termTokens.length === 1) {
      return tokenSet.has(termTokens[0]!);
    }
    const phrase = termTokens.join(' ');
    if (spaceJoined === phrase) {
      return true;
    }
    return ` ${spaceJoined} `.includes(` ${phrase} `);
  };
}

function resolveEntityNames(state: WorldState, entityId: string): string[] {
  if (!isSafeKey(entityId)) {
    return [];
  }
  const names: string[] = [];
  const char = getOwn(state.entities.characters, entityId);
  if (char?.name) {
    names.push(char.name);
  }
  const faction = getOwn(state.entities.factions, entityId);
  if (faction?.name) {
    names.push(faction.name);
  }
  const threat = getOwn(state.entities.threats, entityId);
  if (threat?.name) {
    names.push(threat.name);
  }
  const location = getOwn(state.entities.locations, entityId);
  if (location?.name) {
    names.push(location.name);
  }
  return names;
}

/**
 * Score and retrieve relevant historical memories from `state.chronicle.events`.
 *
 * Matches against involved entities (`presentCharacterIds` or transcript entity mentions),
 * current location (`currentLocationId` / `currentLocationName`), and keyword mentions in
 * `recentTranscriptLines`. Results are sorted deterministically by `score` descending, then
 * `turn` descending, then `id` ascending.
 */
export function getRelevantChronicleEntries(
  state: WorldState,
  query: ChronicleQueryOptions = {}
): ScoredChronicleEntry[] {
  const events = state.chronicle.events;
  if (events.length === 0) {
    return [];
  }

  const presentCharacterIds =
    query.presentCharacterIds !== undefined
      ? query.presentCharacterIds
      : state.scene.presentCharacterIds.filter((id) => id !== state.player.characterId);
  const presentSet = new Set(
    presentCharacterIds.map((id) => id.trim()).filter((id) => id.length > 0)
  );

  const currentLocationId =
    query.currentLocationId !== undefined ? query.currentLocationId : state.scene.locationId;
  const resolvedLocationName =
    query.currentLocationName !== undefined
      ? query.currentLocationName
      : currentLocationId !== null &&
          isSafeKey(currentLocationId) &&
          Object.hasOwn(state.entities.locations, currentLocationId)
        ? (getOwn(state.entities.locations, currentLocationId)?.name ?? state.scene.location)
        : state.scene.location;

  const normalizedLocId =
    typeof currentLocationId === 'string' && currentLocationId.trim().length > 0
      ? currentLocationId.trim().toLowerCase()
      : null;
  const normalizedLocName = normalizeSearchText(resolvedLocationName).trim();

  const transcriptLines = query.recentTranscriptLines ?? [];
  const hasTranscript = transcriptLines.some((line) => line.trim().length > 0);
  const transcriptMentions = buildTranscriptMatcher(transcriptLines);

  const scored: ScoredChronicleEntry[] = [];

  for (const entry of events) {
    let score = 0;

    // 1. Involved entities (present in scene or mentioned in recent transcript)
    const uniqueEntityIds = deduplicateStringsPreserveOrder(entry.involvedEntityIds, false);
    for (const entityId of uniqueEntityIds) {
      if (presentSet.has(entityId)) {
        score += 4;
      } else if (hasTranscript) {
        const entityNames = resolveEntityNames(state, entityId);
        const mentioned =
          transcriptMentions(entityId) || entityNames.some((name) => transcriptMentions(name));
        if (mentioned) {
          score += 2;
        }
      }
    }

    // 2. Current location match (ID match, Tier 0/name match, or transcript mention)
    const entryLocId =
      typeof entry.locationId === 'string' && entry.locationId.trim().length > 0
        ? entry.locationId.trim()
        : null;
    const entryLocLower = entryLocId ? entryLocId.toLowerCase() : null;
    const entryLocEntity =
      entryLocId !== null && isSafeKey(entryLocId)
        ? getOwn(state.entities.locations, entryLocId)
        : undefined;
    const entryLocNameNorm = entryLocEntity
      ? normalizeSearchText(entryLocEntity.name).trim()
      : '';

    let matchedCurrentLocation = false;
    if (normalizedLocId !== null && entryLocLower !== null && entryLocLower === normalizedLocId) {
      score += 3;
      matchedCurrentLocation = true;
    } else if (normalizedLocName.length > 0) {
      if (entryLocNameNorm.length > 0 && entryLocNameNorm === normalizedLocName) {
        score += 3;
        matchedCurrentLocation = true;
      } else if (
        entryLocLower !== null &&
        normalizedLocId === null &&
        entryLocLower === slugifyLocationName(normalizedLocName)
      ) {
        score += 3;
        matchedCurrentLocation = true;
      } else if (entryLocLower === null || normalizedLocId === null) {
        const entryLocTextMatcher = buildTranscriptMatcher([
          entry.title,
          entry.summary,
          ...entry.keywords,
        ]);
        if (entryLocTextMatcher(normalizedLocName)) {
          score += 2;
          matchedCurrentLocation = true;
        }
      }
    }

    if (!matchedCurrentLocation && hasTranscript && entryLocNameNorm.length >= 3) {
      if (transcriptMentions(entryLocNameNorm)) {
        score += 1;
      }
    }

    // 3. Keyword mentions in recent transcript lines
    if (hasTranscript) {
      const uniqueKeywords = deduplicateStringsPreserveOrder(entry.keywords, true);
      for (const keyword of uniqueKeywords) {
        if (transcriptMentions(keyword)) {
          score += 2;
        }
      }
    }

    if (score > 0) {
      scored.push({
        entry: cloneEntry(entry),
        score,
      });
    }
  }

  scored.sort((a, b) => {
    if (a.score !== b.score) {
      return b.score - a.score;
    }
    if (a.entry.turn !== b.entry.turn) {
      return b.entry.turn - a.entry.turn;
    }
    if (a.entry.id < b.entry.id) {
      return -1;
    }
    if (a.entry.id > b.entry.id) {
      return 1;
    }
    return 0;
  });

  if (query.maxEntries !== undefined) {
    const limit = Number.isFinite(query.maxEntries)
      ? Math.max(0, Math.floor(query.maxEntries))
      : scored.length;
    return scored.slice(0, limit);
  }

  return scored;
}
