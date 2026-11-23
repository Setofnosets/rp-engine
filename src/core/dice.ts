import { ValidationError } from './errors.js';
import { RngState, nextInt } from './prng.js';
import { ErrorAccumulator, Result, err, ok } from './result.js';

/**
 * Keep strategy applied to rolled dice before summing.
 */
export type KeepMode = 'highest' | 'lowest' | 'none';

/**
 * Structured representation of a validated dice expression.
 */
export interface ParsedDice {
  readonly notation: string;
  readonly diceCount: number;
  readonly sides: number;
  readonly modifier: number;
  readonly keepMode: KeepMode;
  readonly keepCount?: number;
}

/**
 * Full deterministic audit trace for a single {@link rollDice} invocation.
 */
export interface DiceRollTrace {
  readonly notation: string;
  readonly diceCount: number;
  readonly sides: number;
  readonly modifier: number;
  readonly keepMode: KeepMode;
  readonly keepCount?: number;
  readonly rawRolls: number[];
  readonly keptRolls: number[];
  readonly total: number;
  readonly seedBefore: RngState;
  readonly seedAfter: RngState;
}

/**
 * Result payload returned by {@link rollDice}.
 */
export interface DiceRollOutcome {
  readonly trace: DiceRollTrace;
  readonly total: number;
  readonly rolls: number[];
  readonly modifier: number;
  readonly nextState: RngState;
}

const MAX_DICE_COUNT = 10_000;
const MAX_DICE_SIDES = 1_000_000;
const DICE_NOTATION_PATTERN = /^(?:(\d+))?d(\d+)(?:(kh|kl)(\d+))?(?:\s*([+-])\s*(\d+))?$/i;

/**
 * Parse and validate standard tabletop dice notation such as `NdM`, `d20`,
 * `NdM+K`, `NdM-K`, `2d20kh1`, `2d20kl1`, `4d6kh3+2`, or `1d100`.
 */
export function parseDiceNotation(notation: string): Result<ParsedDice, ValidationError[]> {
  const acc = new ErrorAccumulator();

  if (typeof notation !== 'string') {
    acc.add('notation', 'INVALID_TYPE', 'Dice notation must be a string');
    return err([...acc.errors]);
  }

  const trimmed = notation.trim();
  if (trimmed.length === 0) {
    acc.add('notation', 'EMPTY_NOTATION', 'Dice notation cannot be empty');
    return err([...acc.errors]);
  }

  const match = DICE_NOTATION_PATTERN.exec(trimmed);
  if (match === null) {
    acc.add(
      'notation',
      'INVALID_NOTATION',
      `Invalid dice notation "${trimmed}". Expected format like "NdM", "d20", "NdM+K", "2d20kh1", or "2d20kl1"`
    );
    return err([...acc.errors]);
  }

  const [, rawCount, rawSides, rawKeepOp, rawKeepCount, rawSign, rawModifier] = match;

  const diceCount = rawCount === undefined ? 1 : Number.parseInt(rawCount, 10);
  const sides = Number.parseInt(rawSides ?? '', 10);

  if (!Number.isSafeInteger(diceCount) || diceCount < 1) {
    acc.add('diceCount', 'INVALID_DICE_COUNT', `Dice count must be at least 1; received ${diceCount}`);
  } else if (diceCount > MAX_DICE_COUNT) {
    acc.add(
      'diceCount',
      'DICE_COUNT_TOO_LARGE',
      `Dice count ${diceCount} exceeds maximum supported limit of ${MAX_DICE_COUNT}`
    );
  }

  if (!Number.isSafeInteger(sides) || sides < 2) {
    acc.add('sides', 'INVALID_SIDES', `Die sides must be at least 2; received ${sides}`);
  } else if (sides > MAX_DICE_SIDES) {
    acc.add(
      'sides',
      'SIDES_TOO_LARGE',
      `Die sides ${sides} exceeds maximum supported limit of ${MAX_DICE_SIDES}`
    );
  }

  let keepMode: KeepMode = 'none';
  let keepCount: number | undefined;
  if (rawKeepOp !== undefined && rawKeepCount !== undefined) {
    keepMode = rawKeepOp.toLowerCase() === 'kh' ? 'highest' : 'lowest';
    keepCount = Number.parseInt(rawKeepCount, 10);
    if (!Number.isSafeInteger(keepCount) || keepCount < 1) {
      acc.add('keepCount', 'INVALID_KEEP_COUNT', `Keep count must be at least 1; received ${keepCount}`);
    } else if (Number.isSafeInteger(diceCount) && diceCount >= 1 && keepCount > diceCount) {
      acc.add(
        'keepCount',
        'KEEP_COUNT_EXCEEDS_DICE',
        `Cannot keep ${keepCount} dice when rolling only ${diceCount}`
      );
    }
  }

  let modifier = 0;
  if (rawSign !== undefined && rawModifier !== undefined) {
    const magnitude = Number.parseInt(rawModifier, 10);
    const signed = rawSign === '-' ? -magnitude : magnitude;
    modifier = signed === 0 ? 0 : signed;
    if (!Number.isSafeInteger(modifier)) {
      acc.add('modifier', 'INVALID_MODIFIER', `Modifier is out of safe integer range: ${rawSign}${rawModifier}`);
    }
  }

  if (acc.hasErrors()) {
    return err([...acc.errors]);
  }

  const parsed: ParsedDice = {
    notation: trimmed,
    diceCount,
    sides,
    modifier,
    keepMode,
    ...(keepCount !== undefined ? { keepCount } : {}),
  };

  return ok(parsed);
}

function selectKeptRolls(rawRolls: readonly number[], keepMode: KeepMode, keepCount?: number): number[] {
  if (keepMode === 'none') {
    return [...rawRolls];
  }

  const count = keepCount ?? rawRolls.length;
  const sorted = [...rawRolls];
  if (keepMode === 'highest') {
    sorted.sort((a, b) => b - a);
  } else {
    sorted.sort((a, b) => a - b);
  }
  return sorted.slice(0, count);
}

/**
 * Roll dice deterministically using `state` without mutating `state`.
 */
export function rollDice(
  notation: string,
  state: RngState
): Result<DiceRollOutcome, ValidationError[]> {
  const parsedResult = parseDiceNotation(notation);
  if (!parsedResult.ok) {
    return parsedResult;
  }

  const parsed = parsedResult.value;
  const rawRolls: number[] = [];
  let currentState = state;

  for (let i = 0; i < parsed.diceCount; i++) {
    const step = nextInt(currentState, 1, parsed.sides);
    rawRolls.push(step.value);
    currentState = step.nextState;
  }

  const keptRolls = selectKeptRolls(rawRolls, parsed.keepMode, parsed.keepCount);
  let rollSum = 0;
  for (const roll of keptRolls) {
    rollSum += roll;
  }
  const total = rollSum + parsed.modifier;

  const trace: DiceRollTrace = {
    notation: parsed.notation,
    diceCount: parsed.diceCount,
    sides: parsed.sides,
    modifier: parsed.modifier,
    keepMode: parsed.keepMode,
    ...(parsed.keepCount !== undefined ? { keepCount: parsed.keepCount } : {}),
    rawRolls,
    keptRolls,
    total,
    seedBefore: state,
    seedAfter: currentState,
  };

  return ok({
    trace,
    total,
    rolls: [...keptRolls],
    modifier: parsed.modifier,
    nextState: currentState,
  });
}
