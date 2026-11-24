import type { BeatDefinition } from '../../beats/beat-ledger.js';
import type { PredicateAst } from '../../beats/predicate-ast.js';
import { type ValidationError, validationError } from '../../core/errors.js';
import { ErrorAccumulator, type Result, err, ok } from '../../core/result.js';
import {
  type CharacterCardLoreEntry,
  type CharacterCardSheet,
  type CharacterCardSourceSpec,
  cloneCharacterCardSheet,
} from '../../state/character-card-sheet.js';
import type { CharacterEntity, CharacterStatus } from '../../state/world-state.js';
import {
  type CartridgeBundle,
  isPlainObject,
  isUnsafeRecordKey,
  scanObjectForUnsafeKeys,
  setSafeProperty,
  validateCartridgeStructure,
} from '../cartridge-schema.js';
import {
  PNG_SIGNATURE,
  extractCharaJsonFromPngBuffer,
} from '../png-card-codec.js';
const DEFAULT_RECOMMENDED_SYSTEM_PACK = 'stock-slice-of-life';

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

/**
 * Pure Node `Buffer` PNG chunk reader that locates SillyTavern `ccv3` (preferred V3)
 * or `chara` (V2) `tEXt`/`zTXt`/`iTXt` chunks and decodes the embedded UTF-8 JSON payload.
 */
export function extractCharaJsonFromPng(pngBuffer: Buffer): Result<unknown, ValidationError[]> {
  return extractCharaJsonFromPngBuffer(pngBuffer);
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

function extractStringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      out.push(item);
    }
  }
  return out;
}

function extractEmbeddedLoreEntries(bookRaw: unknown): CharacterCardLoreEntry[] {
  let entries: Record<string, unknown>[] = [];
  if (isPlainObject(bookRaw)) {
    entries = extractRawEntriesList(bookRaw);
  } else if (Array.isArray(bookRaw)) {
    entries = bookRaw.filter((e): e is Record<string, unknown> => isPlainObject(e));
  }

  const out: CharacterCardLoreEntry[] = [];
  for (const entry of entries) {
    const rawSecondary = getOwnValue(entry, 'secondary_keys') ?? getOwnValue(entry, 'secondaryKeys');
    const secondaryKeys = Array.isArray(rawSecondary)
      ? rawSecondary.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).map((s) => s.trim())
      : [];
    const content = getOwnString(entry, 'content') ?? '';
    const constant = getOwnValue(entry, 'constant') === true;
    const enabled = getOwnValue(entry, 'enabled') !== false;
    const rawName = getOwnString(entry, 'name') ?? getOwnString(entry, 'comment');
    const rawId = getOwnValue(entry, 'id');
    const item: CharacterCardLoreEntry = {
      keys: extractKeysArray(entry),
      secondaryKeys,
      content,
      constant,
      insertionOrder: resolveInsertionOrder(entry),
      enabled,
    };
    if (rawName !== undefined && rawName.length > 0) {
      item.name = rawName;
    }
    if (typeof rawId === 'string' || (typeof rawId === 'number' && Number.isFinite(rawId))) {
      item.id = rawId;
    }
    out.push(item);
  }
  return out;
}

interface ParsedStCardContext {
  sourceSpec: CharacterCardSourceSpec;
  cardId: string;
  name: string;
  rawDescription: string;
  personality: string;
  scenario: string;
  firstMessage: string;
  alternateGreetings: string[];
  mesExample: string;
  creatorNotes: string;
  systemPrompt: string;
  postHistory: string;
  tags: string[];
  creator?: string;
  characterVersion: string;
  cardSheet: CharacterCardSheet;
  portraitBytes?: Uint8Array;
  portraitAssetPath: string;
}

function parseStCardContext(
  input: Buffer | string | Record<string, unknown>,
  overrideId?: string
): Result<ParsedStCardContext, ValidationError[]> {
  let rawObject: unknown;
  let portraitBytes: Uint8Array | undefined;

  if (Buffer.isBuffer(input)) {
    if (input.length >= PNG_SIGNATURE.length && input.subarray(0, 8).equals(PNG_SIGNATURE)) {
      const pngRes = extractCharaJsonFromPngBuffer(input);
      if (!pngRes.ok) {
        return pngRes;
      }
      rawObject = pngRes.value;
      portraitBytes = new Uint8Array(input);
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

  const cardId = overrideId ? slugifyId(overrideId, 'imported-st-card') : slugifyId(name, 'imported-st-card');
  const portraitAssetPath = portraitBytes !== undefined ? `assets/portraits/${cardId}.png` : '';
  const sourceSpec: CharacterCardSourceSpec = spec === 'chara_card_v3' ? 'v3' : 'v2';

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
  const alternateGreetings = extractStringList(getOwnValue(cardData, 'alternate_greetings'));
  const tags = extractStringList(getOwnValue(cardData, 'tags'));

  const bookRaw =
    getOwnValue(cardData, 'character_book') ??
    getOwnValue(cardData, 'lorebook') ??
    getOwnValue(sanitizedRoot, 'character_book') ??
    getOwnValue(sanitizedRoot, 'lorebook');

  const embeddedLoreEntries =
    bookRaw !== undefined && bookRaw !== null ? extractEmbeddedLoreEntries(bookRaw) : [];

  const cardSheet: CharacterCardSheet = {
    sourceSpec,
    name,
    description: rawDescription,
    personality,
    scenario,
    firstMes: firstMessage,
    alternateGreetings,
    mesExample,
    creatorNotes,
    systemPrompt,
    postHistoryInstructions: postHistory,
    tags,
    portraitAssetPath,
    embeddedLoreEntries,
  };

  return ok({
    sourceSpec,
    cardId,
    name,
    rawDescription,
    personality,
    scenario,
    firstMessage,
    alternateGreetings,
    mesExample,
    creatorNotes,
    systemPrompt,
    postHistory,
    tags,
    ...(creator !== undefined ? { creator } : {}),
    characterVersion,
    cardSheet,
    ...(portraitBytes !== undefined ? { portraitBytes } : {}),
    portraitAssetPath,
  });
}

function buildBundleFromParsedContext(
  ctx: ParsedStCardContext,
  options: { recommendedSystemPack?: string; includeCardEntity?: boolean } = {}
): Result<CartridgeBundle, ValidationError[]> {
  const personaDescriptionParts: string[] = [];
  if (ctx.rawDescription.trim().length > 0) {
    personaDescriptionParts.push(ctx.rawDescription.trim());
  }
  if (ctx.personality.length > 0) {
    personaDescriptionParts.push(`Personality: ${ctx.personality}`);
  }
  const personaDescription = personaDescriptionParts.join('\n\n');

  const combinedSystemPrompt = [ctx.systemPrompt.trim(), ctx.postHistory]
    .filter((p) => p.length > 0)
    .join('\n\n');

  const loreFiles: Record<string, string> = {};
  const beats: BeatDefinition[] = [];

  if (ctx.mesExample.length > 0) {
    setSafeProperty(loreFiles, 'lore/example-dialogue.md', ctx.mesExample);
  }
  if (ctx.creatorNotes.length > 0) {
    setSafeProperty(loreFiles, 'lore/creator-notes.md', ctx.creatorNotes);
  }

  const validGreetings = ctx.alternateGreetings.filter((g) => g.trim().length > 0);
  if (validGreetings.length > 0) {
    setSafeProperty(
      loreFiles,
      'lore/alternate-greetings.md',
      validGreetings.map((g, idx) => `## Alternate Greeting ${idx + 1}\n\n${g}`).join('\n\n')
    );
  }

  if (ctx.cardSheet.embeddedLoreEntries.length > 0) {
    const rawEntries = ctx.cardSheet.embeddedLoreEntries.map((entry) => ({
      keys: entry.keys,
      secondary_keys: entry.secondaryKeys,
      content: entry.content,
      constant: entry.constant,
      insertion_order: entry.insertionOrder,
      enabled: entry.enabled,
      ...(entry.name !== undefined ? { name: entry.name } : {}),
      ...(entry.id !== undefined ? { id: entry.id } : {}),
    }));
    mapCharacterBookToBeatsAndLore(rawEntries, beats, loreFiles);
  }

  const recommendedSystemPack = options.recommendedSystemPack ?? DEFAULT_RECOMMENDED_SYSTEM_PACK;
  const binaryAssets: Record<string, Uint8Array> = {};
  if (ctx.portraitBytes !== undefined && ctx.portraitAssetPath.length > 0) {
    setSafeProperty(binaryAssets, ctx.portraitAssetPath, ctx.portraitBytes);
  }

  const bundle: CartridgeBundle = {
    rootDir: null,
    card: {
      spec: 'cartridge/0.1',
      id: ctx.cardId,
      version: ctx.characterVersion,
      title: ctx.name,
      ...(ctx.creator !== undefined && ctx.creator.length > 0 ? { author: ctx.creator } : {}),
      description: ctx.rawDescription.trim() || `${ctx.name} (imported SillyTavern card)`,
      recommendedSystemPack,
      persona: {
        name: ctx.name,
        description: personaDescription,
        ...(ctx.scenario.trim().length > 0 ? { scenario: ctx.scenario } : {}),
        ...(ctx.firstMessage.trim().length > 0 ? { firstMessage: ctx.firstMessage } : {}),
        ...(combinedSystemPrompt.length > 0 ? { systemPrompt: combinedSystemPrompt } : {}),
      },
    },
    ...(options.includeCardEntity
      ? {
          initialEntities: {
            characters: {
              [ctx.cardId]: {
                id: ctx.cardId,
                name: ctx.name,
                status: 'active',
                presentInScene: true,
                locationId: null,
                formId: null,
                formGroup: null,
                sections: {},
                customFields: {},
                abilities: [],
                goals: [],
                agenda: '',
                allegiance: '',
                mood: 'neutral',
                traits: [...ctx.tags],
                cardSheet: cloneCharacterCardSheet(ctx.cardSheet),
                ...(ctx.portraitAssetPath.length > 0
                  ? { portraitAsset: ctx.portraitAssetPath }
                  : {}),
              },
            },
          },
        }
      : {}),
    beats,
    routes: [],
    endings: [],
    loreFiles,
    endingPromptFiles: {},
    scriptFiles: {},
    ...(Object.keys(binaryAssets).length > 0 ? { binaryAssets } : {}),
  };

  return validateCartridgeStructure(bundle);
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
  const ctxRes = parseStCardContext(input);
  if (!ctxRes.ok) {
    return ctxRes;
  }
  return buildBundleFromParsedContext(ctxRes.value, options);
}

/**
 * Import a `.png` character card into a 1-on-1 playable {@link CartridgeBundle},
 * retaining the raw portrait PNG bytes under `binaryAssets['assets/portraits/<id>.png']`
 * and a card-backed {@link CharacterEntity} in `initialEntities.characters`.
 */
export function importPngAsCartridge(
  pngBuffer: Buffer,
  options: { recommendedSystemPack?: string } = {}
): Result<CartridgeBundle, ValidationError[]> {
  if (!Buffer.isBuffer(pngBuffer)) {
    return err([validationError('', 'INVALID_TYPE', 'PNG input must be a Node Buffer')]);
  }
  if (pngBuffer.length < PNG_SIGNATURE.length || !pngBuffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return err([
      validationError('', 'INVALID_PNG_SIGNATURE', 'Buffer does not start with a valid PNG signature'),
    ]);
  }
  const ctxRes = parseStCardContext(pngBuffer);
  if (!ctxRes.ok) {
    return ctxRes;
  }
  return buildBundleFromParsedContext(ctxRes.value, {
    ...options,
    includeCardEntity: true,
  });
}

export interface ImportedPngCharacterResult {
  entity: CharacterEntity;
  portraitAssetPath: string;
  portraitBytes: Uint8Array;
}

/**
 * Import a `.png` character card as a drop-in roster {@link CharacterEntity}
 * with `cardSheet` and `portraitAsset`, keeping binary bytes separate from `WorldState`.
 */
export function importPngAsCharacterEntity(
  pngBuffer: Buffer,
  options: {
    id?: string;
    locationId?: string | null;
    presentInScene?: boolean;
    status?: CharacterStatus;
  } = {}
): Result<ImportedPngCharacterResult, ValidationError[]> {
  if (!Buffer.isBuffer(pngBuffer)) {
    return err([validationError('', 'INVALID_TYPE', 'PNG input must be a Node Buffer')]);
  }
  if (pngBuffer.length < PNG_SIGNATURE.length || !pngBuffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return err([
      validationError('', 'INVALID_PNG_SIGNATURE', 'Buffer does not start with a valid PNG signature'),
    ]);
  }

  const ctxRes = parseStCardContext(pngBuffer, options.id);
  if (!ctxRes.ok) {
    return ctxRes;
  }

  const ctx = ctxRes.value;
  const portraitBytes = ctx.portraitBytes ?? new Uint8Array(pngBuffer);
  const entity: CharacterEntity = {
    id: ctx.cardId,
    name: ctx.name,
    status: options.status ?? 'active',
    presentInScene: options.presentInScene ?? true,
    locationId: options.locationId ?? null,
    formId: null,
    formGroup: null,
    sections: {},
    customFields: {},
    abilities: [],
    goals: [],
    agenda: '',
    allegiance: '',
    mood: 'neutral',
    traits: [...ctx.tags],
    cardSheet: cloneCharacterCardSheet(ctx.cardSheet),
    portraitAsset: ctx.portraitAssetPath,
  };

  return ok({
    entity,
    portraitAssetPath: ctx.portraitAssetPath,
    portraitBytes,
  });
}

export interface ImportedPngPlayerPersonaResult {
  name: string;
  personaCard: CharacterCardSheet;
  portraitAssetPath: string;
  portraitBytes: Uint8Array;
}

/**
 * Import a `.png` character card as a player persona (`WorldState.player.personaCard`
 * + `portraitAsset`), keeping raw PNG bytes separate from `WorldState`.
 */
export function importPngAsPlayerPersona(
  pngBuffer: Buffer
): Result<ImportedPngPlayerPersonaResult, ValidationError[]> {
  if (!Buffer.isBuffer(pngBuffer)) {
    return err([validationError('', 'INVALID_TYPE', 'PNG input must be a Node Buffer')]);
  }
  if (pngBuffer.length < PNG_SIGNATURE.length || !pngBuffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return err([
      validationError('', 'INVALID_PNG_SIGNATURE', 'Buffer does not start with a valid PNG signature'),
    ]);
  }

  const ctxRes = parseStCardContext(pngBuffer);
  if (!ctxRes.ok) {
    return ctxRes;
  }

  const ctx = ctxRes.value;
  return ok({
    name: ctx.name,
    personaCard: cloneCharacterCardSheet(ctx.cardSheet),
    portraitAssetPath: ctx.portraitAssetPath,
    portraitBytes: ctx.portraitBytes ?? new Uint8Array(pngBuffer),
  });
}
