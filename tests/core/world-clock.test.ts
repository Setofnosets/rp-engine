import { describe, expect, it } from 'vitest';
import { isErr, isOk } from '../../src/core/result.js';
import {
  DEFAULT_TIME_SLOTS,
  type WorldClockState,
  addDays,
  advanceClock,
  createWorldClock,
  diffDays,
  formatClockDisplay,
  formatIsoDate,
  holdClock,
  parseIsoDate,
  releaseClock,
  validateWorldClock,
} from '../../src/core/world-clock.js';

describe('DEFAULT_TIME_SLOTS and createWorldClock', () => {
  it('exposes the default four time slots in chronological order and frozen', () => {
    expect(DEFAULT_TIME_SLOTS).toEqual(['morning', 'afternoon', 'evening', 'night']);
    expect(Object.isFrozen(DEFAULT_TIME_SLOTS)).toBe(true);
  });

  it('creates default world clock state cleanly', () => {
    const clock = createWorldClock();
    expect(clock).toEqual({
      turn: 0,
      storyTurn: 0,
      day: 1,
      inGameDate: null,
      slot: 'morning',
      slotsPerDay: ['morning', 'afternoon', 'evening', 'night'],
      held: false,
      holdReason: null,
      timers: {},
    });
  });

  it('respects custom initialization options and isolates mutable inputs', () => {
    const customSlots = ['dawn', 'noon', 'dusk'];
    const timers = {
      torch: { current: 1, max: 4, tickOn: 'slot' as const },
    };
    const clock = createWorldClock({
      turn: 5,
      storyTurn: 3,
      day: 2,
      inGameDate: '2024-02-29',
      slot: 'noon',
      slotsPerDay: customSlots,
      held: true,
      holdReason: 'combat',
      timers,
    });

    // Mutate caller inputs after construction to verify isolation
    customSlots.push('midnight');
    timers.torch.current = 99;

    expect(clock.turn).toBe(5);
    expect(clock.storyTurn).toBe(3);
    expect(clock.day).toBe(2);
    expect(clock.inGameDate).toBe('2024-02-29');
    expect(clock.slot).toBe('noon');
    expect(clock.slotsPerDay).toEqual(['dawn', 'noon', 'dusk']);
    expect(clock.held).toBe(true);
    expect(clock.holdReason).toBe('combat');
    expect(clock.timers.torch?.current).toBe(1);
  });

  it('normalizes invalid or out-of-range createWorldClock options safely', () => {
    const clock = createWorldClock({
      turn: -3,
      storyTurn: 1.5,
      day: 0,
      inGameDate: '2026-02-30',
      slot: 'nonexistent',
      slotsPerDay: [],
      held: false,
      holdReason: 'ignored-when-unheld',
    });

    expect(clock.turn).toBe(0);
    expect(clock.storyTurn).toBe(0);
    expect(clock.day).toBe(1);
    expect(clock.inGameDate).toBeNull();
    expect(clock.slot).toBe('morning');
    expect(clock.slotsPerDay).toEqual(['morning', 'afternoon', 'evening', 'night']);
    expect(clock.held).toBe(false);
    expect(clock.holdReason).toBeNull();

    const heldNoReason = createWorldClock({ held: true });
    expect(heldNoReason.held).toBe(true);
    expect(heldNoReason.holdReason).toBeNull();
  });
});

describe('ISO calendar helpers', () => {
  it('parses valid dates including leap days and rejects invalid calendar dates', () => {
    const leap = parseIsoDate('2024-02-29');
    expect(leap).toBeInstanceOf(Date);
    expect(leap?.getUTCHours()).toBe(0);
    expect(formatIsoDate(leap)).toBe('2024-02-29');

    // Century leap-year rules: 2000 is leap, 2100 and 2025 are not
    expect(parseIsoDate('2000-02-29')).not.toBeNull();
    expect(parseIsoDate('2100-02-29')).toBeNull();
    expect(parseIsoDate('2025-02-29')).toBeNull();

    // Impossible calendar dates and malformed strings
    expect(parseIsoDate('2026-02-30')).toBeNull();
    expect(parseIsoDate('2026-13-01')).toBeNull();
    expect(parseIsoDate('2026-00-10')).toBeNull();
    expect(parseIsoDate('2026-04-31')).toBeNull();
    expect(parseIsoDate('2026-2-01')).toBeNull();
    expect(parseIsoDate('not-a-date')).toBeNull();
    expect(parseIsoDate(null)).toBeNull();
    expect(parseIsoDate(12345)).toBeNull();
  });

  it('formats valid UTC dates and returns null for invalid or out-of-range Date objects', () => {
    expect(formatIsoDate(new Date('2026-03-05T15:30:00Z'))).toBe('2026-03-05');
    expect(formatIsoDate(new Date(Date.UTC(50, 0, 1)))).toBe('1950-01-01');
    const year50 = new Date(0);
    year50.setUTCFullYear(50, 0, 1);
    expect(formatIsoDate(year50)).toBe('0050-01-01');

    expect(formatIsoDate(new Date('invalid'))).toBeNull();
    expect(formatIsoDate('2026-03-05')).toBeNull();

    const negativeYear = new Date(0);
    negativeYear.setUTCFullYear(-1, 0, 1);
    expect(formatIsoDate(negativeYear)).toBeNull();

    const overflowYear = new Date(0);
    overflowYear.setUTCFullYear(10000, 0, 1);
    expect(formatIsoDate(overflowYear)).toBeNull();
  });

  it('adds positive, zero, and negative days across leap years, months, and years', () => {
    // Forward across month, year, and leap day boundaries
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDays('2024-02-29', 1)).toBe('2024-03-01');
    expect(addDays('2025-02-28', 1)).toBe('2025-03-01');
    expect(addDays('2026-03-31', 1)).toBe('2026-04-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-05-10', 0)).toBe('2026-05-10');

    // Negative days across leap-year, year, and 4-digit ISO boundaries
    expect(addDays('2024-03-01', -1)).toBe('2024-02-29');
    expect(addDays('2025-03-01', -1)).toBe('2025-02-28');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDays('2026-03-05', -5)).toBe('2026-02-28');
    expect(addDays('2024-02-29', 365)).toBe('2025-02-28');
    expect(addDays('2024-02-29', 1461)).toBe('2028-02-29');
    expect(addDays('0000-01-01', -1)).toBeNull();
    expect(addDays('9999-12-31', 1)).toBeNull();

    // Invalid inputs return null
    expect(addDays(null, 5)).toBeNull();
    expect(addDays(undefined, 5)).toBeNull();
    expect(addDays('2026-02-30', 1)).toBeNull();
    expect(addDays('2026-02-28', 1.5)).toBeNull();
    expect(addDays('2026-02-28', Number.NaN)).toBeNull();
  });

  it('computes signed day differences accurately across leap years and rejects invalid dates', () => {
    expect(diffDays('2026-03-05', '2026-03-05')).toBe(0);
    expect(Object.is(diffDays('2026-03-05', '2026-03-05'), 0)).toBe(true);
    expect(diffDays('2026-03-05', '2026-02-28')).toBe(-5);
    expect(diffDays('2024-02-28', '2024-03-01')).toBe(2);
    expect(diffDays('2025-02-28', '2025-03-01')).toBe(1);
    expect(diffDays('2025-12-30', '2026-01-02')).toBe(3);

    expect(diffDays('2026-02-30', '2026-03-01')).toBeNull();
    expect(diffDays('2026-03-01', '2026-13-01')).toBeNull();
  });
});

describe('advanceClock and slot wrap-around', () => {
  it('defaults to advancing mechanical turn by 1 and storySlots by 0', () => {
    const start = createWorldClock({ inGameDate: '2026-03-15', slot: 'morning' });
    const res = advanceClock(start);

    expect(res.daysElapsed).toBe(0);
    expect(res.slotsElapsed).toBe(0);
    expect(res.expiredTimers).toEqual([]);
    expect(res.nextClock.turn).toBe(1);
    expect(res.nextClock.storyTurn).toBe(0);
    expect(res.nextClock.day).toBe(1);
    expect(res.nextClock.inGameDate).toBe('2026-03-15');
    expect(res.nextClock.slot).toBe('morning');
    // Original state unchanged
    expect(start.turn).toBe(0);

    // Negative or non-integer mechanicalTurns/storySlots normalize to 0 instead of reversing time
    const noBackward = advanceClock(start, { mechanicalTurns: -2, storySlots: -3 });
    expect(noBackward.nextClock.turn).toBe(0);
    expect(noBackward.nextClock.storyTurn).toBe(0);
    expect(noBackward.slotsElapsed).toBe(0);
    expect(noBackward.daysElapsed).toBe(0);
    expect(noBackward.nextClock.slot).toBe('morning');
  });

  it('wraps slots around slotsPerDay and advances day and inGameDate across month/year/leap boundaries', () => {
    // 2024-02-28 night + 1 slot -> 2024-02-29 morning (leap day)
    const leapEve = createWorldClock({
      day: 1,
      inGameDate: '2024-02-28',
      slot: 'night',
    });
    const toLeapDay = advanceClock(leapEve, { mechanicalTurns: 1, storySlots: 1 });
    expect(toLeapDay.daysElapsed).toBe(1);
    expect(toLeapDay.slotsElapsed).toBe(1);
    expect(toLeapDay.nextClock.day).toBe(2);
    expect(toLeapDay.nextClock.inGameDate).toBe('2024-02-29');
    expect(toLeapDay.nextClock.slot).toBe('morning');
    expect(toLeapDay.nextClock.turn).toBe(1);
    expect(toLeapDay.nextClock.storyTurn).toBe(1);

    // 2024-02-29 evening + 2 slots -> wraps past night into 2024-03-01 morning
    const toMarch = advanceClock(
      createWorldClock({ day: 2, inGameDate: '2024-02-29', slot: 'evening' }),
      { storySlots: 2 }
    );
    expect(toMarch.daysElapsed).toBe(1);
    expect(toMarch.nextClock.day).toBe(3);
    expect(toMarch.nextClock.inGameDate).toBe('2024-03-01');
    expect(toMarch.nextClock.slot).toBe('morning');

    // 2025-12-31 afternoon + 7 slots -> (1 + 7) = 8 -> 2 days elapsed, slot index 0 -> 2026-01-02 morning
    const yearRoll = advanceClock(
      createWorldClock({ day: 10, inGameDate: '2025-12-31', slot: 'afternoon' }),
      { mechanicalTurns: 2, storySlots: 7 }
    );
    expect(yearRoll.daysElapsed).toBe(2);
    expect(yearRoll.slotsElapsed).toBe(7);
    expect(yearRoll.nextClock.turn).toBe(2);
    expect(yearRoll.nextClock.storyTurn).toBe(7);
    expect(yearRoll.nextClock.day).toBe(12);
    expect(yearRoll.nextClock.inGameDate).toBe('2026-01-02');
    expect(yearRoll.nextClock.slot).toBe('morning');
  });

  it('handles null inGameDate, custom slotsPerDay, and unknown current slot fallback', () => {
    const noDate = createWorldClock({
      day: 1,
      inGameDate: null,
      slot: 'dusk',
      slotsPerDay: ['dawn', 'dusk'],
    });
    const next = advanceClock(noDate, { storySlots: 3 });
    // Starting at 'dusk' (index 1 of 2): +1 -> dawn (day 2), +2 -> dusk (day 2), +3 -> dawn (day 3)
    expect(next.daysElapsed).toBe(2);
    expect(next.nextClock.day).toBe(3);
    expect(next.nextClock.inGameDate).toBeNull();
    expect(next.nextClock.slot).toBe('dawn');

    // Empty slotsPerDay on hand-crafted clock falls back to DEFAULT_TIME_SLOTS without dividing by zero
    const emptySlotsClock: WorldClockState = {
      ...createWorldClock({ inGameDate: '2026-01-10', slot: 'morning' }),
      slotsPerDay: [],
    };
    const emptyRecovered = advanceClock(emptySlotsClock, { storySlots: 1 });
    expect(emptyRecovered.nextClock.slotsPerDay).toEqual(DEFAULT_TIME_SLOTS);
    expect(emptyRecovered.nextClock.slot).toBe('afternoon');

    // Hand-crafted invalid slot falls back to index 0 on advance
    const unknownSlotClock: WorldClockState = {
      ...createWorldClock({ inGameDate: '2026-01-10' }),
      slot: 'twilight',
    };
    const recovered = advanceClock(unknownSlotClock, { storySlots: 1 });
    expect(recovered.nextClock.slot).toBe('afternoon');

    // Hand-crafted malformed date is preserved rather than erased
    const malformedDateClock: WorldClockState = {
      ...createWorldClock({ slot: 'night' }),
      inGameDate: '2026-02-30',
    };
    const keptMalformed = advanceClock(malformedDateClock, { storySlots: 1 });
    expect(keptMalformed.daysElapsed).toBe(1);
    expect(keptMalformed.nextClock.inGameDate).toBe('2026-02-30');
  });

  it('maintains determinism over 200 consecutive single-slot steps', () => {
    let clock = createWorldClock({ inGameDate: '2026-01-01', slot: 'morning' });
    for (let i = 0; i < 200; i += 1) {
      clock = advanceClock(clock, { mechanicalTurns: 1, storySlots: 1 }).nextClock;
    }
    expect(clock.turn).toBe(200);
    expect(clock.storyTurn).toBe(200);
    expect(clock.day).toBe(51); // 1 + 200/4
    expect(clock.slot).toBe('morning');
    expect(clock.inGameDate).toBe(addDays('2026-01-01', 50));
  });
});

describe('Time Hold mechanics', () => {
  it('freezes storyTurn, day, inGameDate, and slot while mechanical turn continues advancing', () => {
    const initial = createWorldClock({
      turn: 3,
      storyTurn: 3,
      day: 4,
      inGameDate: '2026-06-15',
      slot: 'evening',
      timers: {
        turnCooldown: { current: 0, max: 2, tickOn: 'turn' },
        torchBurn: { current: 1, max: 3, tickOn: 'slot' },
        rentDue: { current: 0, max: 1, tickOn: 'day' },
      },
    });

    const held = holdClock(initial, 'combat');
    expect(held.held).toBe(true);
    expect(held.holdReason).toBe('combat');
    expect(initial.held).toBe(false);

    // Mutating original timer after holdClock/releaseClock cannot leak into held/released snapshots
    const releasedCheck = releaseClock(held);
    initial.timers.turnCooldown!.current = 99;
    expect(held.timers.turnCooldown?.current).toBe(0);
    expect(releasedCheck.timers.turnCooldown?.current).toBe(0);
    initial.timers.turnCooldown!.current = 0;

    const step1 = advanceClock(held, { mechanicalTurns: 1, storySlots: 5 });
    expect(step1.daysElapsed).toBe(0);
    expect(step1.slotsElapsed).toBe(0);
    expect(step1.nextClock.turn).toBe(4);
    expect(step1.nextClock.storyTurn).toBe(3);
    expect(step1.nextClock.day).toBe(4);
    expect(step1.nextClock.inGameDate).toBe('2026-06-15');
    expect(step1.nextClock.slot).toBe('evening');
    // Only turn timer advanced
    expect(step1.nextClock.timers.turnCooldown?.current).toBe(1);
    expect(step1.nextClock.timers.torchBurn?.current).toBe(1);
    expect(step1.nextClock.timers.rentDue?.current).toBe(0);
    expect(step1.expiredTimers).toEqual([]);

    const step2 = advanceClock(step1.nextClock, { mechanicalTurns: 1, storySlots: 4 });
    expect(step2.nextClock.turn).toBe(5);
    expect(step2.nextClock.storyTurn).toBe(3);
    expect(step2.expiredTimers).toEqual(['turnCooldown']);

    // Release resumes story time progression
    const released = releaseClock(step2.nextClock);
    expect(released.held).toBe(false);
    expect(released.holdReason).toBeNull();

    const step3 = advanceClock(released, { mechanicalTurns: 1, storySlots: 2 });
    expect(step3.daysElapsed).toBe(1);
    expect(step3.slotsElapsed).toBe(2);
    expect(step3.nextClock.turn).toBe(6);
    expect(step3.nextClock.storyTurn).toBe(5);
    expect(step3.nextClock.day).toBe(5);
    expect(step3.nextClock.inGameDate).toBe('2026-06-16');
    expect(step3.nextClock.slot).toBe('morning');
    expect(step3.expiredTimers).toEqual(['torchBurn', 'rentDue']);
  });

  it('allows forceIgnoreHold to advance narrative time without releasing the hold flag', () => {
    const held = holdClock(
      createWorldClock({
        turn: 10,
        storyTurn: 5,
        day: 2,
        inGameDate: '2026-08-01',
        slot: 'night',
      }),
      'director-hold'
    );

    const forced = advanceClock(held, {
      mechanicalTurns: 1,
      storySlots: 1,
      forceIgnoreHold: true,
    });

    expect(forced.daysElapsed).toBe(1);
    expect(forced.slotsElapsed).toBe(1);
    expect(forced.nextClock.turn).toBe(11);
    expect(forced.nextClock.storyTurn).toBe(6);
    expect(forced.nextClock.day).toBe(3);
    expect(forced.nextClock.inGameDate).toBe('2026-08-02');
    expect(forced.nextClock.slot).toBe('morning');
    expect(forced.nextClock.held).toBe(true);
    expect(forced.nextClock.holdReason).toBe('director-hold');
  });
});

describe('Countdown timers', () => {
  it('ticks and expires one-shot timers on turn, slot, and day boundaries without re-firing', () => {
    const start = createWorldClock({
      slot: 'evening',
      timers: {
        bleed: { current: 0, max: 2, tickOn: 'turn' },
        spell: { current: 0, max: 3, tickOn: 'slot' },
        courier: { current: 0, max: 1, tickOn: 'day' },
      },
    });

    // Advance 1 turn and 1 slot (evening -> night): bleed=1/2, spell=1/3, courier=0/1
    const r1 = advanceClock(start, { mechanicalTurns: 1, storySlots: 1 });
    expect(r1.expiredTimers).toEqual([]);
    expect(r1.nextClock.timers).toEqual({
      bleed: { current: 1, max: 2, tickOn: 'turn' },
      spell: { current: 1, max: 3, tickOn: 'slot' },
      courier: { current: 0, max: 1, tickOn: 'day' },
    });

    // Advance 1 turn and 2 slots (night -> morning -> afternoon): bleed=2/2 (expired), spell=3/3 (expired), courier=1/1 (expired)
    const r2 = advanceClock(r1.nextClock, { mechanicalTurns: 1, storySlots: 2 });
    expect(r2.daysElapsed).toBe(1);
    expect(r2.expiredTimers).toEqual(['bleed', 'spell', 'courier']);
    expect(r2.nextClock.timers).toEqual({
      bleed: { current: 2, max: 2, tickOn: 'turn' },
      spell: { current: 3, max: 3, tickOn: 'slot' },
      courier: { current: 1, max: 1, tickOn: 'day' },
    });

    // Subsequent advance must NOT re-fire non-repeating already-expired timers
    const r3 = advanceClock(r2.nextClock, { mechanicalTurns: 2, storySlots: 4 });
    expect(r3.expiredTimers).toEqual([]);
    expect(r3.nextClock.timers.bleed?.current).toBe(2);
    expect(r3.nextClock.timers.spell?.current).toBe(3);
    expect(r3.nextClock.timers.courier?.current).toBe(1);

    // Original clock timers untouched
    expect(start.timers.bleed?.current).toBe(0);
  });

  it('resets repeating timers with remainder carry-over and safely handles zero-delta or max<=0 edge cases', () => {
    const start = createWorldClock({
      timers: {
        patrol: { current: 1, max: 3, tickOn: 'slot', repeat: true },
        heartbeat: { current: 0, max: 2, tickOn: 'turn', repeat: true },
        degenerateRepeat: { current: 0, max: 0, tickOn: 'turn', repeat: true },
      },
    });

    // 0 mechanical turns, 1 slot: patrol=2/3 (not expired), heartbeat=0/2, degenerateRepeat=0
    const r1 = advanceClock(start, { mechanicalTurns: 0, storySlots: 1 });
    expect(r1.expiredTimers).toEqual([]);
    expect(r1.nextClock.timers.patrol?.current).toBe(2);
    expect(r1.nextClock.timers.heartbeat?.current).toBe(0);

    // +3 slots: patrol=2+3=5 >= 3 -> expires, carries remainder 5 % 3 = 2
    // +1 mechanicalTurn: heartbeat=1/2, degenerateRepeat advances by 1 >= 0 -> expires, clamped to 0
    const r2 = advanceClock(r1.nextClock, { mechanicalTurns: 1, storySlots: 3 });
    expect(r2.expiredTimers).toEqual(['patrol', 'degenerateRepeat']);
    expect(r2.nextClock.timers.patrol?.current).toBe(2);
    expect(r2.nextClock.timers.heartbeat?.current).toBe(1);
    expect(r2.nextClock.timers.degenerateRepeat?.current).toBe(0);

    // +1 mechanicalTurn: heartbeat=2 >= 2 -> expires and resets to 0
    const r3 = advanceClock(r2.nextClock, { mechanicalTurns: 1, storySlots: 0 });
    expect(r3.expiredTimers).toEqual(['heartbeat', 'degenerateRepeat']);
    expect(r3.nextClock.timers.heartbeat?.current).toBe(0);
  });
});

describe('formatClockDisplay', () => {
  it('formats ISO dates, DD/MM/YYYY preference, 24h vs 12h time, custom slots, and hold markers', () => {
    const clock = createWorldClock({
      day: 3,
      inGameDate: '2026-03-05',
      slot: 'afternoon',
    });

    expect(formatClockDisplay(clock)).toBe('2026-03-05 · afternoon');
    expect(formatClockDisplay(clock, { useDdMmYyFormat: true })).toBe('05/03/2026 · afternoon');
    expect(formatClockDisplay(clock, { use24hTime: true })).toBe('2026-03-05 · 14:00');
    expect(formatClockDisplay(clock, { use24hTime: false })).toBe('2026-03-05 · 02:00 PM');
    expect(
      formatClockDisplay(clock, { useDdMmYyFormat: true, use24hTime: true })
    ).toBe('05/03/2026 · 14:00');

    // Null date falls back to Day N even when useDdMmYyFormat is true
    const noDate = createWorldClock({ day: 7, inGameDate: null, slot: 'morning' });
    expect(formatClockDisplay(noDate, { useDdMmYyFormat: true, use24hTime: false })).toBe(
      'Day 7 · 08:00 AM'
    );

    // Malformed hand-crafted date is preserved rather than crashing
    const badDate: WorldClockState = { ...clock, inGameDate: '2026-02-30' };
    expect(formatClockDisplay(badDate, { useDdMmYyFormat: true })).toBe(
      '2026-02-30 · afternoon'
    );

    // Held with and without reason
    expect(formatClockDisplay(holdClock(clock, 'scene-lock'))).toBe(
      '2026-03-05 · afternoon · HELD (scene-lock)'
    );
    const heldNoReason = createWorldClock({
      inGameDate: '2026-03-05',
      slot: 'custom-watch',
      slotsPerDay: ['custom-watch'],
      held: true,
    });
    expect(formatClockDisplay(heldNoReason, { use24hTime: true })).toBe(
      '2026-03-05 · custom-watch · HELD'
    );
  });
});

describe('validateWorldClock', () => {
  it('returns Ok for valid clock states and structured ValidationErrors for invalid states', () => {
    const valid = createWorldClock({
      inGameDate: '2026-04-01',
      timers: { quest: { current: 1, max: 5, tickOn: 'day' } },
    });
    const okRes = validateWorldClock(valid);
    expect(isOk(okRes)).toBe(true);
    if (isOk(okRes)) {
      expect(okRes.value).toBe(valid);
    }

    const badClock: WorldClockState = {
      turn: -1,
      storyTurn: 1.2,
      day: 0,
      inGameDate: '2026-02-30',
      slot: 'missing',
      slotsPerDay: ['morning'],
      held: false,
      holdReason: null,
      timers: {
        broken: { current: -2, max: 0, tickOn: 'turn' },
      },
    };
    const errRes = validateWorldClock(badClock);
    expect(isErr(errRes)).toBe(true);
    if (isErr(errRes)) {
      expect(errRes.error.map((e) => [e.path, e.code])).toEqual([
        ['turn', 'INVALID_TURN'],
        ['storyTurn', 'INVALID_STORY_TURN'],
        ['day', 'INVALID_DAY'],
        ['inGameDate', 'INVALID_DATE'],
        ['slot', 'UNKNOWN_SLOT'],
        ['timers.broken.current', 'INVALID_TIMER_CURRENT'],
        ['timers.broken.max', 'INVALID_TIMER_MAX'],
      ]);
    }

    const emptySlots: WorldClockState = {
      ...valid,
      slotsPerDay: [],
    };
    const emptySlotsRes = validateWorldClock(emptySlots);
    expect(isErr(emptySlotsRes)).toBe(true);
    if (isErr(emptySlotsRes)) {
      expect(emptySlotsRes.error[0]?.path).toBe('slotsPerDay');
      expect(emptySlotsRes.error[0]?.code).toBe('EMPTY_SLOTS');
    }
  });
});
