import { ValidationError, validationError } from '../core/errors.js';
import { ErrorAccumulator, Result, err, ok } from '../core/result.js';

/**
 * Detailed outcome produced by {@link extractAndRepairJsonDetailed}.
 */
export interface JsonRepairResult {
  readonly value: unknown;
  readonly repaired: boolean;
}

interface StripThinkingResult {
  readonly text: string;
  readonly stripped: boolean;
  readonly hadUnclosedTag: boolean;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function tryJsonParse(text: string): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (caught) {
    return {
      ok: false,
      error: caught instanceof Error ? caught.message : String(caught),
    };
  }
}

function hasUnclosedFence(text: string): boolean {
  const matches = text.match(/```/g);
  return matches !== null && matches.length % 2 === 1;
}

/**
 * Strip `<think>...</think>` and `<reasoning>...</reasoning>` blocks (case-insensitive),
 * safely handling nested, multiple, or unclosed leading/trailing tags.
 */
function stripThinkingBlocks(input: string): StripThinkingResult {
  const tagPattern = /<\/?(think|reasoning)(?:\s[^>]*)?>/gi;
  const removals: Array<{ readonly start: number; readonly end: number }> = [];
  const tagStack: string[] = [];

  let blockStart = -1;
  let cursor = 0;
  let hadUnclosedTag = false;
  let match: RegExpExecArray | null;

  while ((match = tagPattern.exec(input)) !== null) {
    const rawTag = match[0];
    const tagName = (match[1] ?? '').toLowerCase();
    const isClosing = rawTag.startsWith('</');
    const matchStart = match.index;
    const matchEnd = matchStart + rawTag.length;

    if (!isClosing) {
      if (tagStack.length === 0) {
        blockStart = matchStart;
      }
      tagStack.push(tagName);
      continue;
    }

    if (tagStack.length > 0) {
      if (tagStack[tagStack.length - 1] === tagName) {
        tagStack.pop();
      } else {
        // Mismatched closing tag inside an open block: unwind back to matching tag if present.
        const matchingIdx = tagStack.lastIndexOf(tagName);
        if (matchingIdx !== -1) {
          tagStack.length = matchingIdx;
        }
      }
      if (tagStack.length === 0 && blockStart >= 0) {
        removals.push({ start: blockStart, end: matchEnd });
        cursor = matchEnd;
        blockStart = -1;
      }
      continue;
    }

    // Stray closing tag with no matching opening tag: treat preceding text as
    // an unclosed leading reasoning block unless already inside a fence or JSON value.
    const prefixSinceCursor = input.slice(cursor, matchStart);
    const trimmedPrefix = prefixSinceCursor.trimStart();
    if (
      !trimmedPrefix.startsWith('{') &&
      !trimmedPrefix.startsWith('[') &&
      !hasUnclosedFence(prefixSinceCursor)
    ) {
      removals.push({ start: cursor, end: matchEnd });
      cursor = matchEnd;
    }
  }

  if (tagStack.length > 0 && blockStart >= 0) {
    // Unclosed <think> or <reasoning> tag: drop from opening tag through EOF so
    // incomplete reasoning drafts cannot leak into JSON extraction.
    removals.push({ start: blockStart, end: input.length });
    hadUnclosedTag = true;
  }

  if (removals.length === 0) {
    return { text: input, stripped: false, hadUnclosedTag: false };
  }

  let output = '';
  let pos = 0;
  for (const span of removals) {
    if (span.start > pos) {
      output += input.slice(pos, span.start);
    }
    if (span.end > pos) {
      pos = span.end;
    }
  }
  if (pos < input.length) {
    output += input.slice(pos);
  }

  return { text: output, stripped: true, hadUnclosedTag };
}

/**
 * Remove trailing commas immediately before `}` or `]` outside JSON string literals.
 */
export function removeTrailingCommasOutsideStrings(input: string): string {
  const parts: string[] = [];
  let sliceStart = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input.charAt(i);

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === ',') {
      let lookahead = i + 1;
      while (lookahead < input.length) {
        const ws = input.charAt(lookahead);
        if (ws === ' ' || ws === '\t' || ws === '\n' || ws === '\r') {
          lookahead += 1;
        } else {
          break;
        }
      }
      const nextChar = lookahead < input.length ? input.charAt(lookahead) : '';
      if (nextChar === '}' || nextChar === ']') {
        parts.push(input.slice(sliceStart, i));
        sliceStart = i + 1;
      }
    }
  }

  if (sliceStart === 0) {
    return input;
  }

  parts.push(input.slice(sliceStart));
  return parts.join('');
}

interface FenceCandidate {
  readonly language: string;
  readonly body: string;
}

function extractFencedBlocks(input: string): FenceCandidate[] {
  const results: FenceCandidate[] = [];
  const fencePattern = /```([a-zA-Z0-9_-]*)[^\S\r\n]*(?:\r?\n|\s)([\s\S]*?)```/g;
  let match: RegExpExecArray | null;

  while ((match = fencePattern.exec(input)) !== null) {
    const language = (match[1] ?? '').toLowerCase();
    const body = (match[2] ?? '').trim();
    if (body.length > 0) {
      results.push({ language, body });
    }
  }

  // Prioritize explicit json/jsonc fences before untagged/other fences while keeping relative order.
  const jsonFences = results.filter((item) => item.language === 'json' || item.language === 'jsonc');
  const otherFences = results.filter((item) => item.language !== 'json' && item.language !== 'jsonc');
  return [...jsonFences, ...otherFences];
}

function extractBalancedJsonSpans(input: string): string[] {
  const candidates: string[] = [];
  let i = 0;

  while (i < input.length) {
    const startChar = input.charAt(i);
    if (startChar !== '{' && startChar !== '[') {
      i += 1;
      continue;
    }

    const stack: string[] = [startChar === '{' ? '}' : ']'];
    let inString = false;
    let escaped = false;
    let matchedEnd = -1;

    for (let j = i + 1; j < input.length; j += 1) {
      const ch = input.charAt(j);

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
        continue;
      }

      if (ch === '{') {
        stack.push('}');
        continue;
      }
      if (ch === '[') {
        stack.push(']');
        continue;
      }

      if (ch === '}' || ch === ']') {
        const expected = stack[stack.length - 1];
        if (ch !== expected) {
          break;
        }
        stack.pop();
        if (stack.length === 0) {
          matchedEnd = j;
          break;
        }
      }
    }

    if (matchedEnd !== -1) {
      candidates.push(input.slice(i, matchedEnd + 1));
      i = matchedEnd + 1;
    } else {
      i += 1;
    }
  }

  return candidates;
}

function hasUnclosedJsonStructure(input: string): boolean {
  const trimmed = input.trim();
  const firstObj = trimmed.indexOf('{');
  const firstArr = trimmed.indexOf('[');
  let start = -1;
  if (firstObj !== -1 && firstArr !== -1) {
    start = Math.min(firstObj, firstArr);
  } else {
    start = firstObj !== -1 ? firstObj : firstArr;
  }
  if (start === -1) {
    return false;
  }

  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (let i = start; i < trimmed.length; i += 1) {
    const ch = trimmed.charAt(i);

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      stack.push('}');
    } else if (ch === '[') {
      stack.push(']');
    } else if (ch === '}' || ch === ']') {
      const top = stack[stack.length - 1];
      if (top === ch) {
        stack.pop();
      }
    }
  }

  return inString || stack.length > 0;
}

function tryParseWithCommaRepair(candidate: string): { readonly ok: true; readonly value: unknown; readonly commaRepaired: boolean } | { readonly ok: false; readonly error: string } {
  const direct = tryJsonParse(candidate);
  if (direct.ok) {
    return { ok: true, value: direct.value, commaRepaired: false };
  }

  const withoutTrailingCommas = removeTrailingCommasOutsideStrings(candidate);
  if (withoutTrailingCommas !== candidate) {
    const repairedParse = tryJsonParse(withoutTrailingCommas);
    if (repairedParse.ok) {
      return { ok: true, value: repairedParse.value, commaRepaired: true };
    }
    return { ok: false, error: repairedParse.error };
  }

  return { ok: false, error: direct.error };
}

/**
 * Extract, repair, and parse JSON from raw model text, returning whether repair/extraction
 * transformations were required.
 */
export function extractAndRepairJsonDetailed(rawText: string): Result<JsonRepairResult, ValidationError[]> {
  if (rawText.trim().length === 0) {
    return err([validationError('', 'EMPTY_JSON_INPUT', 'Model output is empty; expected JSON')]);
  }

  // Fast path: raw text is already valid JSON without modifications.
  const directParse = tryJsonParse(rawText);
  if (directParse.ok) {
    return ok({ value: directParse.value, repaired: false });
  }

  const strippedResult = stripThinkingBlocks(rawText);
  const cleaned = strippedResult.text.trim();

  if (cleaned.length === 0) {
    if (strippedResult.hadUnclosedTag) {
      return err([
        validationError(
          '',
          'UNCLOSED_THINK_BLOCK',
          'Model output contained an unclosed thinking/reasoning block with no JSON output'
        ),
      ]);
    }
    return err([
      validationError(
        '',
        'EMPTY_JSON_INPUT',
        'Model output contained no content outside thinking/reasoning blocks'
      ),
    ]);
  }

  // Try direct or trailing-comma-repaired parse on cleaned text.
  const cleanedAttempt = tryParseWithCommaRepair(cleaned);
  if (cleanedAttempt.ok) {
    return ok({
      value: cleanedAttempt.value,
      repaired: strippedResult.stripped || cleanedAttempt.commaRepaired,
    });
  }

  let lastParseError = cleanedAttempt.error;

  // Try extracting from markdown code fences (```json ... ``` or ``` ... ```).
  const fencedBlocks = extractFencedBlocks(cleaned);
  for (const fence of fencedBlocks) {
    const fenceAttempt = tryParseWithCommaRepair(fence.body);
    if (fenceAttempt.ok) {
      return ok({ value: fenceAttempt.value, repaired: true });
    }
    lastParseError = fenceAttempt.error;

    for (const span of extractBalancedJsonSpans(fence.body)) {
      const spanAttempt = tryParseWithCommaRepair(span);
      if (spanAttempt.ok) {
        return ok({ value: spanAttempt.value, repaired: true });
      }
      lastParseError = spanAttempt.error;
    }
  }

  // Fall back to scanning outermost balanced {...} / [...] spans in the cleaned text.
  for (const span of extractBalancedJsonSpans(cleaned)) {
    const spanAttempt = tryParseWithCommaRepair(span);
    if (spanAttempt.ok) {
      return ok({ value: spanAttempt.value, repaired: true });
    }
    lastParseError = spanAttempt.error;
  }

  // Check for truncated JSON inside fences or cleaned body to emit a clear diagnostic.
  const truncationTarget = fencedBlocks[0]?.body ?? cleaned;
  if (hasUnclosedJsonStructure(truncationTarget)) {
    return err([
      validationError(
        '',
        'TRUNCATED_JSON',
        `JSON output appears truncated before closing delimiter: ${lastParseError}`
      ),
    ]);
  }

  return err([
    validationError('', 'INVALID_JSON', `Failed to parse valid JSON from output: ${lastParseError}`),
  ]);
}

/**
 * Strip thinking blocks, extract JSON from fences or balanced delimiters, repair
 * trailing commas outside strings, and parse into an unknown JSON value.
 */
export function extractAndRepairJson(rawText: string): Result<unknown, ValidationError[]> {
  const detailed = extractAndRepairJsonDetailed(rawText);
  if (!detailed.ok) {
    return detailed;
  }
  return ok(detailed.value.value);
}

function getJsonType(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return 'non-finite-number';
    }
    return 'number';
  }
  return typeof value;
}

function matchesExpectedType(value: unknown, expectedType: string): boolean {
  switch (expectedType) {
    case 'null':
      return value === null;
    case 'boolean':
      return typeof value === 'boolean';
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isPlainRecord(value);
    default:
      return false;
  }
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (typeof left !== typeof right || left === null || right === null) {
    return false;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) {
      return false;
    }
    for (let i = 0; i < left.length; i += 1) {
      if (!deepEqual(left[i], right[i])) {
        return false;
      }
    }
    return true;
  }
  if (isPlainRecord(left) && isPlainRecord(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) {
      return false;
    }
    for (const key of leftKeys) {
      if (!Object.prototype.hasOwnProperty.call(right, key)) {
        return false;
      }
      if (!deepEqual(left[key], right[key])) {
        return false;
      }
    }
    return true;
  }
  return false;
}

function validateValueWithAccumulator(
  value: unknown,
  schema: Record<string, unknown>,
  acc: ErrorAccumulator
): void {
  // 1. Validate `type` (string or array of strings).
  if ('type' in schema && schema.type !== undefined) {
    if (typeof schema.type === 'string') {
      if (!matchesExpectedType(value, schema.type)) {
        acc.add(
          '',
          'TYPE_MISMATCH',
          `Expected type '${schema.type}', received '${getJsonType(value)}'`
        );
        return;
      }
    } else if (Array.isArray(schema.type)) {
      const allowedTypes = schema.type.filter((item): item is string => typeof item === 'string');
      const matched = allowedTypes.some((expected) => matchesExpectedType(value, expected));
      if (!matched) {
        acc.add(
          '',
          'TYPE_MISMATCH',
          `Expected one of [${allowedTypes.join(', ')}], received '${getJsonType(value)}'`
        );
        return;
      }
    }
  }

  // 2. Validate `enum`.
  if (Array.isArray(schema.enum)) {
    const matchedEnum = schema.enum.some((candidate) => deepEqual(value, candidate));
    if (!matchedEnum) {
      acc.add('', 'ENUM_MISMATCH', 'Value must match one of the allowed enum values');
    }
  }

  // 3. Validate `anyOf`.
  if (Array.isArray(schema.anyOf)) {
    const subSchemas = schema.anyOf.filter(isPlainRecord);
    if (subSchemas.length > 0) {
      let matchedAny = false;
      for (const subSchema of subSchemas) {
        const branchAcc = new ErrorAccumulator();
        validateValueWithAccumulator(value, subSchema, branchAcc);
        if (!branchAcc.hasErrors()) {
          matchedAny = true;
          break;
        }
      }
      if (!matchedAny) {
        acc.add('', 'ANY_OF_MISMATCH', 'Value did not satisfy any schema branch in anyOf');
      }
    }
  }

  // 4. String bounds (`minLength`, `maxLength`).
  if (typeof value === 'string') {
    const codePointLength = [...value].length;
    if (typeof schema.minLength === 'number' && codePointLength < schema.minLength) {
      acc.add(
        '',
        'MIN_LENGTH',
        `String length ${codePointLength} is less than minimum length ${schema.minLength}`
      );
    }
    if (typeof schema.maxLength === 'number' && codePointLength > schema.maxLength) {
      acc.add(
        '',
        'MAX_LENGTH',
        `String length ${codePointLength} exceeds maximum length ${schema.maxLength}`
      );
    }
  }

  // 5. Numeric bounds (`minimum`, `maximum`).
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      acc.add('', 'MINIMUM', `Value ${value} is less than minimum ${schema.minimum}`);
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      acc.add('', 'MAXIMUM', `Value ${value} exceeds maximum ${schema.maximum}`);
    }
  }

  // 6. Array validation (`items`).
  if (Array.isArray(value)) {
    if (isPlainRecord(schema.items)) {
      const itemSchema = schema.items;
      for (let i = 0; i < value.length; i += 1) {
        validateValueWithAccumulator(value[i], itemSchema, acc.scope(`[${i}]`));
      }
    } else if (Array.isArray(schema.items)) {
      for (let i = 0; i < Math.min(value.length, schema.items.length); i += 1) {
        const tupleSchema = schema.items[i];
        if (isPlainRecord(tupleSchema)) {
          validateValueWithAccumulator(value[i], tupleSchema, acc.scope(`[${i}]`));
        }
      }
    }
  }

  // 7. Object validation (`required`, `properties`, `additionalProperties`).
  if (isPlainRecord(value)) {
    const properties = isPlainRecord(schema.properties) ? schema.properties : undefined;

    if (Array.isArray(schema.required)) {
      for (const reqKey of schema.required) {
        if (typeof reqKey !== 'string') {
          continue;
        }
        if (!Object.prototype.hasOwnProperty.call(value, reqKey) || value[reqKey] === undefined) {
          acc.scope(reqKey).add('', 'REQUIRED_PROPERTY', `Missing required property '${reqKey}'`);
        }
      }
    }

    if (properties !== undefined) {
      for (const [propKey, propSchema] of Object.entries(properties)) {
        if (!Object.prototype.hasOwnProperty.call(value, propKey)) {
          continue;
        }
        const propValue = value[propKey];
        if (propValue === undefined) {
          continue;
        }
        if (isPlainRecord(propSchema)) {
          validateValueWithAccumulator(propValue, propSchema, acc.scope(propKey));
        }
      }
    }

    const additionalProps = schema.additionalProperties;
    if (additionalProps === false || isPlainRecord(additionalProps)) {
      for (const key of Object.keys(value)) {
        const isDeclared =
          properties !== undefined && Object.prototype.hasOwnProperty.call(properties, key);
        if (isDeclared) {
          continue;
        }
        if (additionalProps === false) {
          acc.scope(key).add('', 'ADDITIONAL_PROPERTY', `Additional property '${key}' is not allowed`);
        } else if (isPlainRecord(additionalProps)) {
          validateValueWithAccumulator(value[key], additionalProps, acc.scope(key));
        }
      }
    }
  }
}

/**
 * Validate a parsed JSON value against a subset of JSON Schema (`type`, `properties`,
 * `required`, `additionalProperties`, `items`, `enum`, `minimum`, `maximum`,
 * `minLength`, `maxLength`, `anyOf`).
 */
export function validateAgainstJsonSchema(
  value: unknown,
  schema: Record<string, unknown>,
  path = ''
): Result<unknown, ValidationError[]> {
  const acc = new ErrorAccumulator(path);
  validateValueWithAccumulator(value, schema, acc);
  return acc.toResult(value);
}
