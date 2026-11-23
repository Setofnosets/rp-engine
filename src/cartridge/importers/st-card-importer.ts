import { inflateSync } from 'node:zlib';
import type { BeatDefinition } from '../../beats/beat-ledger.js';
import type { PredicateAst } from '../../beats/predicate-ast.js';
import { type ValidationError, validationError } from '../../core/errors.js';
import { ErrorAccumulator, type Result, err, ok } from '../../core/result.js';
import type { CharacterEntity } from '../../state/world-state.js';
import {
  type CartridgeBundle,
  isPlainObject,
  isUnsafeRecordKey,
  scanObjectForUnsafeKeys,
  setSafeProperty,
  validateCartridgeStructure,
} from '../cartridge-schema.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const DEFAULT_RECOMMENDED_SYSTEM_PACK = 'stock-slice-of-life';
const MAX_SEEDED_BACKGROUND_CHARS = 1200;

function sanitizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeJsonValue);
  }
  if (value !== null && typeof value === 'object' && isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.getOwnPropertyNames(value)) {
      if (isUnsafeRecordKey(key)) {
        continue;
      }
      const desc = Object.getOwnPropertyDescriptor(value, key);
      if (desc !== undefined) {
        setSafeProperty(out, key, sanitizeJsonValue(desc.value));
      }
    }
    return out;
  }
  return value;
}

function getOwnString(obj: Record<string, unknown>, key: string): string | undefined {
  if (isUnsafeRecordKey(key) || !Object.hasOwn(obj, key)) {
    return undefined;
  }
  const val = Object.getOwnPropertyDescriptor(obj, key)?.value;
  return typeof val === 'string' ? val : undefined;
}

function getOwnValue(obj: Record<string, unknown>, key: string): unknown {
  if (isUnsafeRecordKey(key) || !Object.hasOwn(obj, key)) {
    return undefined;
  }
  return Object.getOwnPropertyDescriptor(obj, key)?.value;
}

function slugifyId(raw: string, fallback: string): string {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length === 0 || isUnsafeRecordKey(slug)) {
    return fallback;
  }
  return slug;
}

function slugifyCharacterId(raw: string, fallback: string): string {
  const trimmedLower = raw.trim().toLowerCase();
  const safeFallback =
    fallback.trim().length > 0 && !isUnsafeRecordKey(fallback.trim())
      ? fallback.trim()
      : 'character';
  if (isUnsafeRecordKey(trimmedLower)) {
    return safeFallback;
  }
  const slug = trimmedLower.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (slug.length === 0 || isUnsafeRecordKey(slug)) {
    return safeFallback;
  }
  return slug;
}

function buildBackgroundSummary(rawDescription: string): string {
  const trimmed = rawDescription.trim();
  if (trimmed.length <= MAX_SEEDED_BACKGROUND_CHARS) {
    return trimmed;
  }
  return `${trimmed.slice(0, MAX_SEEDED_BACKGROUND_CHARS - 3).trimEnd()}...`;
}

function decodeBase64OrJsonString(rawText: string): Result<unknown, ValidationError[]> {
  const trimmed = rawText.trim();
  if (trimmed.length === 0) {
    return err([validationError('', 'EMPTY_PAYLOAD', 'Card text payload is empty')]);
  }

  const tryParseJson = (candidate: string): { ok: true; value: unknown } | { ok: false } => {
    try {
      return { ok: true, value: JSON.parse(candidate) as unknown };
    } catch {
      return { ok: false };
    }
  };

  if (trimmed.startsWith('{')) {
    const direct = tryParseJson(trimmed);
    if (direct.ok) {
      return ok(direct.value);
    }
  }

  const decoded = Buffer.from(trimmed, 'base64').toString('utf8').trim();
  const fromBase64 = tryParseJson(decoded);
  if (fromBase64.ok) {
    return ok(fromBase64.value);
  }

  const directFallback = tryParseJson(trimmed);
  if (directFallback.ok) {
    return ok(directFallback.value);
  }

  return err([
    validationError(
      '',
      'INVALID_JSON',
      'Failed to decode SillyTavern card JSON from base64 or UTF-8 text'
    ),
  ]);
}

function parsePngTextChunk(data: Buffer): { keyword: string; text: string } | null {
  const nullIdx = data.indexOf(0x00);
  if (nullIdx <= 0) {
    return null;
  }
  const keyword = data.subarray(0, nullIdx).toString('latin1');
  const text = data.subarray(nullIdx + 1).toString('utf8');
  return { keyword, text };
}

function parsePngItxtChunk(data: Buffer): Result<{ keyword: string; text: string } | null, ValidationError[]> {
  const keywordEnd = data.indexOf(0x00);
  if (keywordEnd <= 0 || keywordEnd + 2 >= data.length) {
    return ok(null);
  }
  const keyword = data.subarray(0, keywordEnd).toString('latin1');
  const compressionFlag = data.readUInt8(keywordEnd + 1);
  const compressionMethod = data.readUInt8(keywordEnd + 2);

  let pos = keywordEnd + 3;
  const langEnd = data.indexOf(0x00, pos);
  if (langEnd === -1) {
    return ok(null);
  }
  pos = langEnd + 1;

  const transEnd = data.indexOf(0x00, pos);
  if (transEnd === -1) {
    return ok(null);
  }
  pos = transEnd + 1;

  const textBytes = data.subarray(pos);
  if (compressionFlag === 1) {
    if (compressionMethod !== 0) {
      return err([
        validationError(
          '',
          'UNSUPPORTED_COMPRESSION',
          `Unsupported iTXt compression method ${compressionMethod}`
        ),
      ]);
    }
    try {
      const inflated = inflateSync(textBytes);
      return ok({ keyword, text: inflated.toString('utf8') });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'zlib inflate failed';
      return err([
        validationError('', 'DECOMPRESSION_FAILED', `Failed to decompress PNG iTXt chunk: ${message}`),
      ]);
    }
  }

  return ok({ keyword, text: textBytes.toString('utf8') });
}

/**
 * Pure Node `Buffer` PNG chunk reader that locates SillyTavern `ccv3` (preferred V3)
 * or `chara` (V2) `tEXt`/`iTXt` chunks and decodes the embedded UTF-8 JSON payload.
 */
export function extractCharaJsonFromPng(pngBuffer: Buffer): Result<unknown, ValidationError[]> {
  if (!Buffer.isBuffer(pngBuffer)) {
    return err([validationError('', 'INVALID_TYPE', 'PNG input must be a Node Buffer')]);
  }
  if (pngBuffer.length < PNG_SIGNATURE.length || !pngBuffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return err([validationError('', 'INVALID_PNG_SIGNATURE', 'Buffer does not start with a valid PNG signature')]);
  }

  let offset = 8;
  let ccv3Text: string | undefined;
  let charaText: string | undefined;
  let sawIend = false;

  while (offset + 12 <= pngBuffer.length) {
    const length = pngBuffer.readUInt32BE(offset);
    const chunkType = pngBuffer.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const crcEnd = dataEnd + 4;

    if (crcEnd > pngBuffer.length) {
      return err([
        validationError('', 'TRUNCATED_PNG_CHUNK', `PNG chunk "${chunkType}" at offset ${offset} exceeds buffer length`),
      ]);
    }

    const data = pngBuffer.subarray(dataStart, dataEnd);
    if (chunkType === 'tEXt') {
      const parsed = parsePngTextChunk(data);
      if (parsed) {
        if (parsed.keyword === 'ccv3' && ccv3Text === undefined) {
          ccv3Text = parsed.text;
        } else if (parsed.keyword === 'chara' && charaText === undefined) {
          charaText = parsed.text;
        }
      }
    } else if (chunkType === 'iTXt') {
      const itxtRes = parsePngItxtChunk(data);
      if (!itxtRes.ok) {
        return itxtRes;
      }
      if (itxtRes.value) {
        if (itxtRes.value.keyword === 'ccv3' && ccv3Text === undefined) {
          ccv3Text = itxtRes.value.text;
        } else if (itxtRes.value.keyword === 'chara' && charaText === undefined) {
          charaText = itxtRes.value.text;
        }
      }
    } else if (chunkType === 'IEND') {
      sawIend = true;
      break;
    }

    offset = crcEnd;
  }

  if (!sawIend && offset < pngBuffer.length) {
    return err([
      validationError('', 'TRUNCATED_PNG_CHUNK', `Truncated PNG chunk header at offset ${offset}`),
    ]);
  }

  const chosen = ccv3Text ?? charaText;
  if (chosen === undefined) {
    return err([
      validationError(
        '',
        'MISSING_CHARA_CHUNK',
        'PNG image does not contain a "ccv3" or "chara" metadata chunk'
      ),
    ]);
  }

  const decoded = decodeBase64OrJsonString(chosen);
  if (!decoded.ok) {
    return decoded;
  }

  const acc = new ErrorAccumulator();
  scanObjectForUnsafeKeys(decoded.value, acc);
  if (acc.hasErrors()) {
    return err([...acc.errors]);
  }

  return ok(sanitizeJsonValue(decoded.value));
}

function extractRawEntriesList(bookObj: Record<string, unknown>): Record<string, unknown>[] {
  const rawEntries = getOwnValue(bookObj, 'entries');
  if (Array.isArray(rawEntries)) {
    return rawEntries.filter((e): e is Record<string, unknown> => isPlainObject(e));
  }
  if (isPlainObject(rawEntries)) {
    const keys = Object.keys(rawEntries)
      .filter((k) => !isUnsafeRecordKey(k))
      .sort((a, b) => {
        const na = Number(a);
        const nb = Number(b);
        if (Number.isFinite(na) && Number.isFinite(nb)) {
          return na - nb;
        }
        return a < b ? -1 : a > b ? 1 : 0;
      });
    const list: Record<string, unknown>[] = [];
    for (const k of keys) {
      const val = getOwnValue(rawEntries, k);
      if (isPlainObject(val)) {
        list.push(val);
      }
    }
    return list;
  }
  return [];
}

function extractKeysArray(entry: Record<string, unknown>): string[] {
  const rawKeys = getOwnValue(entry, 'keys') ?? getOwnValue(entry, 'key');
  if (!Array.isArray(rawKeys)) {
    return [];
  }
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const item of rawKeys) {
    if (typeof item === 'string') {
      const trimmed = item.trim();
      if (trimmed.length > 0 && !seen.has(trimmed)) {
        seen.add(trimmed);
        cleaned.push(trimmed);
      }
    }
  }
  return cleaned;
}

function resolveInsertionOrder(entry: Record<string, unknown>): number {
  const orderVal =
    getOwnValue(entry, 'insertion_order') ??
    getOwnValue(entry, 'order') ??
    getOwnValue(entry, 'priority');
  if (typeof orderVal === 'number' && Number.isFinite(orderVal)) {
    return Math.round(orderVal);
  }
  return 10;
}

function mapCharacterBookToBeatsAndLore(
  bookRaw: unknown,
  beatsOut: BeatDefinition[],
  loreFilesOut: Record<string, string>
): void {
  let entries: Record<string, unknown>[] = [];
  if (isPlainObject(bookRaw)) {
    entries = extractRawEntriesList(bookRaw);
  } else if (Array.isArray(bookRaw)) {
    entries = bookRaw.filter((e): e is Record<string, unknown> => isPlainObject(e));
  }

  const usedBeatIds = new Set<string>();
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (!entry) {
      continue;
    }
    const enabled = getOwnValue(entry, 'enabled');
    if (enabled === false) {
      continue;
    }

    const content = getOwnString(entry, 'content') ?? '';
    if (content.trim().length === 0) {
      continue;
    }

    const keys = extractKeysArray(entry);
    const isConstant = getOwnValue(entry, 'constant') === true;
    const rawName = getOwnString(entry, 'name') ?? getOwnString(entry, 'comment') ?? `lore-${i + 1}`;
    const rawId = getOwnValue(entry, 'id');
    const baseSlug =
      typeof rawId === 'number' || typeof rawId === 'string'
        ? slugifyId(`${String(rawId)}-${rawName}`, `lore-${i + 1}`)
        : slugifyId(rawName, `lore-${i + 1}`);

    let beatId = `st-lore.${baseSlug}`;
    if (usedBeatIds.has(beatId) || isUnsafeRecordKey(beatId)) {
      beatId = `st-lore.${baseSlug}-${i + 1}`;
    }
    usedBeatIds.add(beatId);

    const lorePath = `lore/${baseSlug}-${i + 1}.md`;
    setSafeProperty(loreFilesOut, lorePath, content);

    if (keys.length === 0 && !isConstant) {
      continue;
    }

    const when: PredicateAst =
      keys.length > 0 ? { mentions: keys } : { clock: 'turn', op: '>=', value: 0 };

    beatsOut.push({
      id: beatId,
      class: 'ambient',
      flexibility: 'optional',
      priority: resolveInsertionOrder(entry),
      when,
      lore: lorePath,
      nudge: content,
      once: false,
    });
  }
}

/**
 * Import a SillyTavern V1, V2 (`chara_card_v2`), or V3 (`chara_card_v3`) character card
 * from a PNG `Buffer`, JSON string, base64 string, or parsed object into a validated
 * Tier 0 {@link CartridgeBundle}.
 */
export function importSillyTavernCard(
  input: Buffer | string | Record<string, unknown>,
  options: { recommendedSystemPack?: string } = {}
): Result<CartridgeBundle, ValidationError[]> {
  let rawObject: unknown;

  if (Buffer.isBuffer(input)) {
    if (input.length >= PNG_SIGNATURE.length && input.subarray(0, 8).equals(PNG_SIGNATURE)) {
      const pngRes = extractCharaJsonFromPng(input);
      if (!pngRes.ok) {
        return pngRes;
      }
      rawObject = pngRes.value;
    } else {
      const strRes = decodeBase64OrJsonString(input.toString('utf8'));
      if (!strRes.ok) {
        return strRes;
      }
      rawObject = strRes.value;
    }
  } else if (typeof input === 'string') {
    const strRes = decodeBase64OrJsonString(input);
    if (!strRes.ok) {
      return strRes;
    }
    rawObject = strRes.value;
  } else if (isPlainObject(input)) {
    rawObject = input;
  } else {
    return err([
      validationError(
        '',
        'INVALID_TYPE',
        'SillyTavern card input must be a PNG Buffer, JSON/base64 string, or plain object'
      ),
    ]);
  }

  if (!isPlainObject(rawObject)) {
    return err([
      validationError('', 'INVALID_TYPE', 'Decoded SillyTavern card root must be a plain object'),
    ]);
  }

  const acc = new ErrorAccumulator();
  scanObjectForUnsafeKeys(rawObject, acc);
  if (acc.hasErrors()) {
    return err([...acc.errors]);
  }

  const sanitizedRoot = sanitizeJsonValue(rawObject) as Record<string, unknown>;
  const spec = getOwnString(sanitizedRoot, 'spec');
  const nestedData = getOwnValue(sanitizedRoot, 'data');

  let cardData: Record<string, unknown>;
  if (isPlainObject(nestedData)) {
    cardData = nestedData;
  } else if (spec === 'chara_card_v3' || spec === 'chara_card_v2') {
    return err([
      validationError('data', 'INVALID_TYPE', `Card with spec "${spec}" must contain a plain data object`),
    ]);
  } else {
    cardData = sanitizedRoot;
  }

  const name = getOwnString(cardData, 'name')?.trim() ?? '';
  if (name.length === 0) {
    return err([validationError('name', 'REQUIRED', 'SillyTavern card must have a non-empty name')]);
  }

  const rawDescription = getOwnString(cardData, 'description') ?? '';
  const personality = getOwnString(cardData, 'personality')?.trim() ?? '';
  const scenario = getOwnString(cardData, 'scenario') ?? '';
  const firstMessage = getOwnString(cardData, 'first_mes') ?? '';
  const systemPrompt = getOwnString(cardData, 'system_prompt') ?? '';
  const postHistory = getOwnString(cardData, 'post_history_instructions')?.trim() ?? '';
  const creator = getOwnString(cardData, 'creator')?.trim();
  const characterVersion = getOwnString(cardData, 'character_version')?.trim() || '1.0.0';
  const mesExample = getOwnString(cardData, 'mes_example')?.trim() ?? '';
  const creatorNotes = getOwnString(cardData, 'creator_notes')?.trim() ?? '';

  const personaDescriptionParts: string[] = [];
  if (rawDescription.trim().length > 0) {
    personaDescriptionParts.push(rawDescription.trim());
  }
  if (personality.length > 0) {
    personaDescriptionParts.push(`Personality: ${personality}`);
  }
  const personaDescription = personaDescriptionParts.join('\n\n');

  const combinedSystemPrompt = [systemPrompt.trim(), postHistory].filter((p) => p.length > 0).join('\n\n');

  const loreFiles: Record<string, string> = {};
  const beats: BeatDefinition[] = [];

  if (mesExample.length > 0) {
    setSafeProperty(loreFiles, 'lore/example-dialogue.md', mesExample);
  }
  if (creatorNotes.length > 0) {
    setSafeProperty(loreFiles, 'lore/creator-notes.md', creatorNotes);
  }

  const altGreetings = getOwnValue(cardData, 'alternate_greetings');
  if (Array.isArray(altGreetings)) {
    const validGreetings = altGreetings.filter(
      (g): g is string => typeof g === 'string' && g.trim().length > 0
    );
    if (validGreetings.length > 0) {
      setSafeProperty(
        loreFiles,
        'lore/alternate-greetings.md',
        validGreetings.map((g, idx) => `## Alternate Greeting ${idx + 1}\n\n${g}`).join('\n\n')
      );
    }
  }

  const bookRaw =
    getOwnValue(cardData, 'character_book') ??
    getOwnValue(cardData, 'lorebook') ??
    getOwnValue(sanitizedRoot, 'character_book') ??
    getOwnValue(sanitizedRoot, 'lorebook');

  if (bookRaw !== undefined && bookRaw !== null) {
    mapCharacterBookToBeatsAndLore(bookRaw, beats, loreFiles);
  }

  const recommendedSystemPack = options.recommendedSystemPack ?? DEFAULT_RECOMMENDED_SYSTEM_PACK;
  const cardId = slugifyId(name, 'imported-st-card');
  const charId = slugifyCharacterId(name, cardId);

  const seededSections: Record<string, string | string[]> = {};
  if (personality.length > 0) {
    setSafeProperty(seededSections, 'sec_personality', personality);
  }
  const trimmedDescription = rawDescription.trim();
  if (trimmedDescription.length > 0) {
    setSafeProperty(seededSections, 'sec_background', buildBackgroundSummary(trimmedDescription));
  }

  const seededCharacter: CharacterEntity = {
    id: charId,
    name,
    status: 'active',
    presentInScene: true,
    locationId: null,
    formId: null,
    formGroup: null,
    sections: seededSections,
    customFields: {},
    abilities: [],
    goals: [],
    agenda: '',
    allegiance: '',
    mood: 'neutral',
    traits: [],
  };
  const initialCharacters: Record<string, CharacterEntity> = {};
  setSafeProperty(initialCharacters, charId, seededCharacter);

  const bundle: CartridgeBundle = {
    rootDir: null,
    card: {
      spec: 'cartridge/0.1',
      id: cardId,
      version: characterVersion,
      title: name,
      ...(creator !== undefined && creator.length > 0 ? { author: creator } : {}),
      description: trimmedDescription || `${name} (imported SillyTavern card)`,
      recommendedSystemPack,
      persona: {
        name,
        description: personaDescription,
        ...(scenario.trim().length > 0 ? { scenario } : {}),
        ...(firstMessage.trim().length > 0 ? { firstMessage } : {}),
        ...(combinedSystemPrompt.length > 0 ? { systemPrompt: combinedSystemPrompt } : {}),
      },
    },
    initialEntities: {
      characters: initialCharacters,
    },
    beats,
    routes: [],
    endings: [],
    loreFiles,
    endingPromptFiles: {},
    scriptFiles: {},
  };

  return validateCartridgeStructure(bundle);
}
