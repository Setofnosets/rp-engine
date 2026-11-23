import { type ValidationError } from './errors.js';
import { ErrorAccumulator, type Result } from './result.js';

/**
 * Default ordered time-of-day slots representing a single narrative day.
 */
export const DEFAULT_TIME_SLOTS = Object.freeze([
  'morning',
  'afternoon',
  'evening',
  'night',
] as const);

/**
 * Named countdown or progress timer attached to a {@link WorldClockState}.
 */
export interface ClockTimer {
  current: number;
  max: number;
  tickOn: 'turn' | 'slot' | 'day';
  repeat?: boolean;
}

/**
 * Immutable snapshot of the dual world clock (mechanical turn vs. narrative time).
 */
export interface WorldClockState {
  turn: number;
  storyTurn: number;
  day: number;
  inGameDate: string | null;
  slot: string;
  slotsPerDay: readonly string[];
  held: boolean;
  holdReason: string | null;
  timers: Record<string, ClockTimer>;
}

/**
 * Options for initializing a {@link WorldClockState} via {@link createWorldClock}.
 */
export interface CreateWorldClockOptions {
  turn?: number;
  storyTurn?: number;
  day?: number;
  inGameDate?: string | null;
  slot?: string;
  slotsPerDay?: readonly string[];
  held?: boolean;
  holdReason?: string | null;
  timers?: Record<string, ClockTimer>;
}

/**
 * Options controlling how {@link advanceClock} steps mechanical and story time.
 */
export interface AdvanceClockOptions {
  mechanicalTurns?: number;
  storySlots?: number;
  forceIgnoreHold?: boolean;
}

/**
 * Output of {@link advanceClock} containing the next state and elapsed deltas.
 */
export interface AdvanceClockResult {
  nextClock: WorldClockState;
  daysElapsed: number;
  slotsElapsed: number;
  expiredTimers: string[];
}

/**
 * Display formatting preferences for {@link formatClockDisplay}.
 */
export interface ClockDisplayPreferences {
  use24hTime?: boolean;
  useDdMmYyFormat?: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const SLOT_CLOCK_LABELS: Readonly<Record<string, { h24: string; h12: string }>> = {
  dawn: { h24: '06:00', h12: '06:00 AM' },
  morning: { h24: '08:00', h12: '08:00 AM' },
  midday: { h24: '12:00', h12: '12:00 PM' },
  noon: { h24: '12:00', h12: '12:00 PM' },
  afternoon: { h24: '14:00', h12: '02:00 PM' },
  dusk: { h24: '18:00', h12: '06:00 PM' },
  evening: { h24: '19:00', h12: '07:00 PM' },
  night: { h24: '22:00', h12: '10:00 PM' },
  midnight: { h24: '00:00', h12: '12:00 AM' },
};

function cloneTimers(timers: Record<string, ClockTimer>): Record<string, ClockTimer> {
  const cloned: Record<string, ClockTimer> = {};
  for (const [id, timer] of Object.entries(timers)) {
    cloned[id] = { ...timer };
  }
  return cloned;
}

function normalizeSlots(slots?: readonly string[]): readonly string[] {
  if (slots && slots.length > 0) {
    return Object.freeze([...slots]);
  }
  return Object.freeze([...DEFAULT_TIME_SLOTS]);
}

function normalizeNonNegativeInt(value: number, fallback = 0): number {
  if (!Number.isInteger(value) || value < 0) {
    return fallback;
  }
  return value === 0 ? 0 : value;
}

/**
 * Create an initial {@link WorldClockState} with safe defaults and isolated copies.
 */
export function createWorldClock(options: CreateWorldClockOptions = {}): WorldClockState {
  const slotsPerDay = normalizeSlots(options.slotsPerDay);
  const defaultSlot = slotsPerDay[0] as string;
  const slot =
    options.slot !== undefined && slotsPerDay.includes(options.slot)
      ? options.slot
      : defaultSlot;

  const parsedDate =
    typeof options.inGameDate === 'string' ? parseIsoDate(options.inGameDate) : null;
  const inGameDate = parsedDate !== null ? formatIsoDate(parsedDate) : null;

  const turn =
    options.turn !== undefined ? normalizeNonNegativeInt(options.turn, 0) : 0;
  const storyTurn =
    options.storyTurn !== undefined ? normalizeNonNegativeInt(options.storyTurn, 0) : 0;
  const day =
    options.day !== undefined && Number.isInteger(options.day) && options.day >= 1
      ? options.day
      : 1;

  const held = options.held === true;
  const holdReason =
    held && typeof options.holdReason === 'string' ? options.holdReason : null;

  return {
    turn,
    storyTurn,
    day,
    inGameDate,
    slot,
    slotsPerDay,
    held,
    holdReason,
    timers: options.timers ? cloneTimers(options.timers) : {},
  };
}

/**
 * Parse a `YYYY-MM-DD` calendar date string into a UTC-midnight `Date`.
 * Rejects malformed formats and non-existent calendar dates (e.g. `2026-02-30` or `2025-02-29`).
 */
export function parseIsoDate(value: unknown): Date | null {
  if (typeof value !== 'string') {
    return null;
  }
  const match = ISO_DATE_PATTERN.exec(value);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return date;
}

/**
 * Format a `Date` instance as `YYYY-MM-DD` in UTC, or `null` if invalid or out of 4-digit year range.
 */
export function formatIsoDate(date: unknown): string | null {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return null;
  }
  const yearNum = date.getUTCFullYear();
  if (yearNum < 0 || yearNum > 9999) {
    return null;
  }
  const year = String(yearNum).padStart(4, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Add an integer number of days (positive, zero, or negative) to an ISO `YYYY-MM-DD` date.
 * Returns `null` when the date is `null`/`undefined`/invalid or when `days` is not an integer.
 */
export function addDays(isoDate: string | null | undefined, days: number): string | null {
  if (isoDate === null || isoDate === undefined) {
    return null;
  }
  const parsed = parseIsoDate(isoDate);
  if (!parsed || !Number.isInteger(days)) {
    return null;
  }
  const next = new Date(parsed.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return formatIsoDate(next);
}

/**
 * Compute the signed integer number of days between two ISO dates (`toIso - fromIso`).
 * Returns `null` if either date string is invalid.
 */
export function diffDays(fromIso: string, toIso: string): number | null {
  const from = parseIsoDate(fromIso);
  const to = parseIsoDate(toIso);
  if (!from || !to) {
    return null;
  }
  const diff = Math.round((to.getTime() - from.getTime()) / DAY_MS);
  return diff === 0 ? 0 : diff;
}

/**
 * Return a new {@link WorldClockState} with narrative time held and `holdReason` recorded.
 */
export function holdClock(clock: WorldClockState, reason: string): WorldClockState {
  return {
    ...clock,
    slotsPerDay: normalizeSlots(clock.slotsPerDay),
    held: true,
    holdReason: reason,
    timers: cloneTimers(clock.timers),
  };
}

/**
 * Return a new {@link WorldClockState} with narrative time released.
 */
export function releaseClock(clock: WorldClockState): WorldClockState {
  return {
    ...clock,
    slotsPerDay: normalizeSlots(clock.slotsPerDay),
    held: false,
    holdReason: null,
    timers: cloneTimers(clock.timers),
  };
}

/**
 * Advance the world clock deterministically without mutating the input state.
 *
 * - `turn` always advances by `mechanicalTurns ?? 1` (even when held).
 * - When `!clock.held || forceIgnoreHold`, `storyTurn` advances by `storySlots ?? 0`,
 *   `slot` wraps around `slotsPerDay`, and `day` / `inGameDate` increment by `daysElapsed`.
 * - Timers tick according to their `tickOn` boundary (`turn`, `slot`, or `day`) and are
 *   reported in `expiredTimers` when `current >= max`.
 */
export function advanceClock(
  clock: WorldClockState,
  options: AdvanceClockOptions = {}
): AdvanceClockResult {
  const mechanicalTurns = normalizeNonNegativeInt(options.mechanicalTurns ?? 1, 0);
  const forceIgnoreHold = options.forceIgnoreHold === true;
  const freezeStoryTime = clock.held && !forceIgnoreHold;

  const slotsPerDay = normalizeSlots(clock.slotsPerDay);
  const nextTurn = clock.turn + mechanicalTurns;

  let nextStoryTurn = clock.storyTurn;
  let nextDay = clock.day;
  let nextInGameDate = clock.inGameDate;
  let nextSlot = clock.slot;
  let slotsElapsed = 0;
  let daysElapsed = 0;

  if (!freezeStoryTime) {
    slotsElapsed = normalizeNonNegativeInt(options.storySlots ?? 0, 0);
    nextStoryTurn = clock.storyTurn + slotsElapsed;

    if (slotsElapsed > 0) {
      const currentIndex = slotsPerDay.indexOf(clock.slot);
      const startIndex = currentIndex >= 0 ? currentIndex : 0;
      const totalIndex = startIndex + slotsElapsed;
      daysElapsed = Math.floor(totalIndex / slotsPerDay.length);
      const wrappedIndex = totalIndex % slotsPerDay.length;
      nextSlot = slotsPerDay[wrappedIndex] as string;

      if (daysElapsed > 0) {
        nextDay = clock.day + daysElapsed;
        if (clock.inGameDate !== null && parseIsoDate(clock.inGameDate) !== null) {
          nextInGameDate = addDays(clock.inGameDate, daysElapsed);
        }
      }
    }
  }

  const nextTimers: Record<string, ClockTimer> = {};
  const expiredTimers: string[] = [];

  for (const [id, timer] of Object.entries(clock.timers)) {
    let delta = 0;
    if (timer.tickOn === 'turn') {
      delta = mechanicalTurns;
    } else if (timer.tickOn === 'slot') {
      delta = slotsElapsed;
    } else {
      delta = daysElapsed;
    }

    let nextCurrent = timer.current;
    if (delta > 0) {
      if (timer.repeat) {
        const advanced = timer.current + delta;
        if (advanced >= timer.max) {
          expiredTimers.push(id);
          nextCurrent = timer.max > 0 ? advanced % timer.max : 0;
        } else {
          nextCurrent = advanced;
        }
      } else if (timer.current < timer.max) {
        const advanced = timer.current + delta;
        if (advanced >= timer.max) {
          expiredTimers.push(id);
          nextCurrent = timer.max;
        } else {
          nextCurrent = advanced;
        }
      }
    }

    nextTimers[id] = {
      ...timer,
      current: nextCurrent,
    };
  }

  const nextClock: WorldClockState = {
    ...clock,
    turn: nextTurn,
    storyTurn: nextStoryTurn,
    day: nextDay,
    inGameDate: nextInGameDate,
    slot: nextSlot,
    slotsPerDay,
    timers: nextTimers,
  };

  return {
    nextClock,
    daysElapsed,
    slotsElapsed,
    expiredTimers,
  };
}

/**
 * Format a {@link WorldClockState} for human-readable UI or prompt rendering.
 *
 * - `useDdMmYyFormat`: renders valid ISO dates as `DD/MM/YYYY` instead of `YYYY-MM-DD`.
 * - `use24hTime`: `true` maps standard slots to `HH:MM` (24h), `false` maps them to
 *   `HH:MM AM/PM` (12h), and `undefined` preserves the slot name directly.
 */
export function formatClockDisplay(
  clock: WorldClockState,
  prefs: ClockDisplayPreferences = {}
): string {
  let dateLabel: string;
  if (clock.inGameDate !== null) {
    const parsed = parseIsoDate(clock.inGameDate);
    if (parsed !== null && prefs.useDdMmYyFormat) {
      const dd = String(parsed.getUTCDate()).padStart(2, '0');
      const mm = String(parsed.getUTCMonth() + 1).padStart(2, '0');
      const yyyy = String(parsed.getUTCFullYear()).padStart(4, '0');
      dateLabel = `${dd}/${mm}/${yyyy}`;
    } else {
      dateLabel = clock.inGameDate;
    }
  } else {
    dateLabel = `Day ${clock.day}`;
  }

  let timeLabel = clock.slot;
  if (prefs.use24hTime !== undefined) {
    const mapped = SLOT_CLOCK_LABELS[clock.slot.toLowerCase()];
    if (mapped) {
      timeLabel = prefs.use24hTime ? mapped.h24 : mapped.h12;
    }
  }

  const holdSuffix = clock.held
    ? clock.holdReason
      ? ` · HELD (${clock.holdReason})`
      : ' · HELD'
    : '';

  return `${dateLabel} · ${timeLabel}${holdSuffix}`;
}

/**
 * Validate invariants of a {@link WorldClockState}, accumulating structured diagnostics.
 */
export function validateWorldClock(
  clock: WorldClockState
): Result<WorldClockState, ValidationError[]> {
  const acc = new ErrorAccumulator();

  if (!Number.isInteger(clock.turn) || clock.turn < 0) {
    acc.add('turn', 'INVALID_TURN', 'Mechanical turn must be a non-negative integer');
  }
  if (!Number.isInteger(clock.storyTurn) || clock.storyTurn < 0) {
    acc.add('storyTurn', 'INVALID_STORY_TURN', 'Story turn must be a non-negative integer');
  }
  if (!Number.isInteger(clock.day) || clock.day < 1) {
    acc.add('day', 'INVALID_DAY', 'Day must be an integer >= 1');
  }
  if (clock.inGameDate !== null && parseIsoDate(clock.inGameDate) === null) {
    acc.add('inGameDate', 'INVALID_DATE', `Invalid ISO date: ${clock.inGameDate}`);
  }
  if (clock.slotsPerDay.length === 0) {
    acc.add('slotsPerDay', 'EMPTY_SLOTS', 'slotsPerDay must contain at least one slot');
  } else if (!clock.slotsPerDay.includes(clock.slot)) {
    acc.add('slot', 'UNKNOWN_SLOT', `Slot "${clock.slot}" is not in slotsPerDay`);
  }

  for (const [id, timer] of Object.entries(clock.timers)) {
    const timerScope = acc.scope('timers').scope(id);
    if (!Number.isFinite(timer.current) || timer.current < 0) {
      timerScope.add('current', 'INVALID_TIMER_CURRENT', 'Timer current must be >= 0');
    }
    if (!Number.isFinite(timer.max) || timer.max <= 0) {
      timerScope.add('max', 'INVALID_TIMER_MAX', 'Timer max must be > 0');
    }
  }

  return acc.toResult(clock);
}
