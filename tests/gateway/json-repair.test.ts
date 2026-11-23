import { describe, expect, it } from 'vitest';
import { isErr, isOk } from '../../src/core/result.js';
import {
  extractAndRepairJson,
  extractAndRepairJsonDetailed,
  removeTrailingCommasOutsideStrings,
  validateAgainstJsonSchema,
} from '../../src/gateway/json-repair.js';

describe('extractAndRepairJson', () => {
  it('parses clean JSON objects, arrays, and primitives without marking repaired', () => {
    const objRes = extractAndRepairJsonDetailed('  {"hp": 25, "alive": true}  ');
    expect(isOk(objRes)).toBe(true);
    if (isOk(objRes)) {
      expect(objRes.value).toEqual({ value: { hp: 25, alive: true }, repaired: false });
    }

    const arrRes = extractAndRepairJson('[1, "two", null]');
    expect(isOk(arrRes)).toBe(true);
    if (isOk(arrRes)) {
      expect(arrRes.value).toEqual([1, 'two', null]);
    }
  });

  it('strips case-insensitive, multiple, nested, and prefilled <think>/<reasoning> blocks', () => {
    const multipleBlocks = [
      '<THINK>First thought with decoy {"wrong": 1}</think>',
      '  <Reasoning>Second thought with [99, 100]</REASONING>',
      '{"status": "ready"}',
    ].join('\n');

    const resMulti = extractAndRepairJsonDetailed(multipleBlocks);
    expect(isOk(resMulti)).toBe(true);
    if (isOk(resMulti)) {
      expect(resMulti.value).toEqual({ value: { status: 'ready' }, repaired: true });
    }

    const nestedBlocks = '<think>outer <think>inner</think> still thinking</think>{"nested": true}';
    const resNested = extractAndRepairJson(nestedBlocks);
    expect(isOk(resNested)).toBe(true);
    if (isOk(resNested)) {
      expect(resNested.value).toEqual({ nested: true });
    }

    // Chat template prefilled <think> without opening tag, ending with </think>.
    const prefilledThink = 'Analyzing hero state {draft}\n</think>\n{"hp": 12}';
    const resPrefilled = extractAndRepairJson(prefilledThink);
    expect(isOk(resPrefilled)).toBe(true);
    if (isOk(resPrefilled)) {
      expect(resPrefilled.value).toEqual({ hp: 12 });
    }
  });

  it('safely rejects unclosed leading <think> or <reasoning> tags without leaking draft JSON', () => {
    const unclosedWithDraft = '<think>Let me reconsider {"hp": 999} wait I am not done...';
    const res = extractAndRepairJson(unclosedWithDraft);
    expect(isErr(res)).toBe(true);
    if (isErr(res)) {
      expect(res.error[0]?.code).toBe('UNCLOSED_THINK_BLOCK');
    }

    const unclosedReasoning = '<REASONING>Still thinking about the turn';
    const res2 = extractAndRepairJson(unclosedReasoning);
    expect(isErr(res2)).toBe(true);
    if (isErr(res2)) {
      expect(res2.error[0]?.code).toBe('UNCLOSED_THINK_BLOCK');
    }
  });

  it('preserves <think> and </think> literals inside valid JSON strings and fenced JSON', () => {
    const directLiteral = '{"note": "keep <think> and </think> intact"}';
    const resDirect = extractAndRepairJsonDetailed(directLiteral);
    expect(isOk(resDirect)).toBe(true);
    if (isOk(resDirect)) {
      expect(resDirect.value).toEqual({
        value: { note: 'keep <think> and </think> intact' },
        repaired: false,
      });
    }

    const fencedLiteral = 'Here is the payload:\n```json\n{"note": "</think>"}\n```';
    const resFenced = extractAndRepairJson(fencedLiteral);
    expect(isOk(resFenced)).toBe(true);
    if (isOk(resFenced)) {
      expect(resFenced.value).toEqual({ note: '</think>' });
    }
  });

  it('extracts JSON from markdown code fences with surrounding prose', () => {
    const jsonFence = [
      'Certainly! Here is the structured update:',
      '```JSON',
      '{',
      '  "actor": "Kael",',
      '  "damage": 7,',
      '}',
      '```',
      'Let me know if you need anything else.',
    ].join('\n');

    const res1 = extractAndRepairJsonDetailed(jsonFence);
    expect(isOk(res1)).toBe(true);
    if (isOk(res1)) {
      expect(res1.value).toEqual({
        value: { actor: 'Kael', damage: 7 },
        repaired: true,
      });
    }

    const plainFence = 'Output:\n```\n["sword", "shield"]\n```';
    const res2 = extractAndRepairJson(plainFence);
    expect(isOk(res2)).toBe(true);
    if (isOk(res2)) {
      expect(res2.value).toEqual(['sword', 'shield']);
    }

    const multiFence = [
      'Example syntax:',
      '```txt',
      'not valid json here',
      '```',
      'Actual output:',
      '```json',
      '{"ok": true}',
      '```',
    ].join('\n');
    const res3 = extractAndRepairJson(multiFence);
    expect(isOk(res3)).toBe(true);
    if (isOk(res3)) {
      expect(res3.value).toEqual({ ok: true });
    }
  });

  it('extracts outermost balanced {...} or [...] spans while ignoring prose braces/brackets', () => {
    const withProseTags =
      '[Note] Here is the payload: {"msg": "keep {braces} and [brackets] and \\"}quote\\"", "items": [1, 2]} (ignore {trailing} [tags])';
    const res = extractAndRepairJsonDetailed(withProseTags);
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value).toEqual({
        value: {
          msg: 'keep {braces} and [brackets] and "}quote"',
          items: [1, 2],
        },
        repaired: true,
      });
    }

    const arrayInProse = 'Result list: [{"id": 1}, {"id": 2}] — done.';
    const arrRes = extractAndRepairJson(arrayInProse);
    expect(isOk(arrRes)).toBe(true);
    if (isOk(arrRes)) {
      expect(arrRes.value).toEqual([{ id: 1 }, { id: 2 }]);
    }
  });

  it('removes trailing commas outside string literals without altering commas inside strings', () => {
    const raw = `{
      "keepCommaBrace": "hello, }",
      "keepCommaBracket": "items, ]",
      "escapedQuote": "end \\\\\\", ] still inside string",
      "tags": [
        "fire",
        "ice",
      ],
      "nested": {
        "power": 10,
      },
    }`;

    const cleaned = removeTrailingCommasOutsideStrings(raw);
    expect(cleaned).toContain('"hello, }"');
    expect(cleaned).toContain('"items, ]"');
    expect(cleaned).toContain('"end \\\\\\", ] still inside string"');

    const res = extractAndRepairJsonDetailed(raw);
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value.repaired).toBe(true);
      expect(res.value.value).toEqual({
        keepCommaBrace: 'hello, }',
        keepCommaBracket: 'items, ]',
        escapedQuote: 'end \\", ] still inside string',
        tags: ['fire', 'ice'],
        nested: { power: 10 },
      });
    }
  });

  it('rejects empty, truncated, and non-JSON text with clear ValidationError diagnostics', () => {
    const emptyRes = extractAndRepairJson('   \n\t  ');
    expect(isErr(emptyRes)).toBe(true);
    if (isErr(emptyRes)) {
      expect(emptyRes.error[0]?.code).toBe('EMPTY_JSON_INPUT');
    }

    const thinkOnlyRes = extractAndRepairJson('<think>only thoughts</think>');
    expect(isErr(thinkOnlyRes)).toBe(true);
    if (isErr(thinkOnlyRes)) {
      expect(thinkOnlyRes.error[0]?.code).toBe('EMPTY_JSON_INPUT');
    }

    const truncatedObj = 'Here is JSON:\n```json\n{"hp": 10, "items": ["potion",';
    const truncRes1 = extractAndRepairJson(truncatedObj);
    expect(isErr(truncRes1)).toBe(true);
    if (isErr(truncRes1)) {
      expect(truncRes1.error[0]?.code).toBe('TRUNCATED_JSON');
      expect(truncRes1.error[0]?.message).toContain('truncated');
    }

    const truncatedStr = '{"name": "Aria';
    const truncRes2 = extractAndRepairJson(truncatedStr);
    expect(isErr(truncRes2)).toBe(true);
    if (isErr(truncRes2)) {
      expect(truncRes2.error[0]?.code).toBe('TRUNCATED_JSON');
    }

    const proseOnly = 'Sorry, I cannot provide structured data right now.';
    const proseRes = extractAndRepairJson(proseOnly);
    expect(isErr(proseRes)).toBe(true);
    if (isErr(proseRes)) {
      expect(proseRes.error[0]?.code).toBe('INVALID_JSON');
    }
  });
});

describe('validateAgainstJsonSchema', () => {
  const characterSchema: Record<string, unknown> = {
    type: 'object',
    required: ['name', 'level', 'class', 'inventory'],
    additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 2, maxLength: 20 },
      level: { type: 'integer', minimum: 1, maximum: 20 },
      class: { type: 'string', enum: ['warrior', 'mage', 'rogue'] },
      nickname: { type: ['string', 'null'] },
      inventory: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'qty'],
          additionalProperties: false,
          properties: {
            id: { type: 'string', minLength: 1 },
            qty: { type: 'integer', minimum: 1, maximum: 99 },
          },
        },
      },
      focus: {
        anyOf: [
          { type: 'string', minLength: 3 },
          { type: 'integer', minimum: 0 },
        ],
      },
    },
  };

  it('accepts valid payloads including union types, boundaries, and anyOf variants', () => {
    const validPayload = {
      name: 'Lyra',
      level: 1,
      class: 'mage',
      nickname: null,
      inventory: [{ id: 'mana_potion', qty: 99 }],
      focus: 0,
    };

    const res = validateAgainstJsonSchema(validPayload, characterSchema);
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value).toEqual(validPayload);
    }

    const resStringFocus = validateAgainstJsonSchema(
      { ...validPayload, level: 20, focus: 'arcane' },
      characterSchema
    );
    expect(isOk(resStringFocus)).toBe(true);
  });

  it('reports detailed path-scoped errors for type, bounds, enum, required, items, anyOf, and additionalProperties', () => {
    const invalidPayload = {
      name: 'A',
      level: 1.5,
      class: 'bard',
      nickname: 42,
      inventory: [{ id: '', qty: 100, rogueField: true }],
      focus: false,
      extraTop: 'disallowed',
    };

    const res = validateAgainstJsonSchema(invalidPayload, characterSchema, 'character');
    expect(isErr(res)).toBe(true);
    if (isErr(res)) {
      const codesByPath = res.error.map((e) => `${e.path}:${e.code}`);
      expect(codesByPath).toContain('character.name:MIN_LENGTH');
      expect(codesByPath).toContain('character.level:TYPE_MISMATCH');
      expect(codesByPath).toContain('character.class:ENUM_MISMATCH');
      expect(codesByPath).toContain('character.nickname:TYPE_MISMATCH');
      expect(codesByPath).toContain('character.inventory[0].id:MIN_LENGTH');
      expect(codesByPath).toContain('character.inventory[0].qty:MAXIMUM');
      expect(codesByPath).toContain('character.inventory[0].rogueField:ADDITIONAL_PROPERTY');
      expect(codesByPath).toContain('character.focus:ANY_OF_MISMATCH');
      expect(codesByPath).toContain('character.extraTop:ADDITIONAL_PROPERTY');
    }
  });

  it('checks missing required keys, maxLength with Unicode code points, minimum, and schema-valued additionalProperties', () => {
    const schema: Record<string, unknown> = {
      type: 'object',
      required: ['title', 'score'],
      properties: {
        title: { type: 'string', maxLength: 3 },
        score: { type: 'number', minimum: 0, maximum: 10 },
      },
      additionalProperties: { type: 'integer', minimum: 1 },
    };

    // 3 surrogate-pair emoji code points fit maxLength: 3 even though UTF-16 length is 6
    const okEmoji = validateAgainstJsonSchema(
      { title: '😀😎🔥', score: 0, bonus: 2 },
      schema
    );
    expect(isOk(okEmoji)).toBe(true);

    const invalid = validateAgainstJsonSchema(
      { title: 'abcd', extraBad: 0 },
      schema
    );
    expect(isErr(invalid)).toBe(true);
    if (isErr(invalid)) {
      expect(invalid.error).toEqual([
        expect.objectContaining({ path: 'score', code: 'REQUIRED_PROPERTY' }),
        expect.objectContaining({ path: 'title', code: 'MAX_LENGTH' }),
        expect.objectContaining({ path: 'extraBad', code: 'MINIMUM' }),
      ]);
    }
  });

  it('rejects arrays and null when object type is required, and rejects NaN for number type', () => {
    expect(isErr(validateAgainstJsonSchema([], { type: 'object' }))).toBe(true);
    expect(isErr(validateAgainstJsonSchema(null, { type: 'object' }))).toBe(true);
    expect(isErr(validateAgainstJsonSchema(Number.NaN, { type: 'number' }))).toBe(true);
    expect(isOk(validateAgainstJsonSchema({ a: 1 }, { type: 'object' }))).toBe(true);
  });
});
