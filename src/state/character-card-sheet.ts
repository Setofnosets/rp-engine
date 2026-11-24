import { type ValidationError, validationError } from '../core/errors.js';
import { ErrorAccumulator, type Result, err, ok } from '../core/result.js';

export type CharacterCardSourceSpec = 'v2' | 'v3';

export interface CharacterCardLoreEntry {
  keys: string[];
  secondaryKeys: string[];
  content: string;
  constant: boolean;
  insertionOrder: number;
  enabled: boolean;
  name?: string;
  id?: string | number;
}

export interface CharacterCardSheet {
  sourceSpec: CharacterCardSourceSpec;
  name: string;
  description: string;
  personality: string;
  scenario: string;
  firstMes: string;
  alternateGreetings: string[];
  mesExample: string;
  creatorNotes: string;
  systemPrompt: string;
  postHistoryInstructions: string;
  tags: string[];
  portraitAssetPath: string;
  expressionAssets?: Record<string, string>;
  embeddedLoreEntries: CharacterCardLoreEntry[];
}

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

function isUnsafeKey(key: string): boolean {
  return FORBIDDEN_KEYS.has(key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

function setSafeProp<T>(record: Record<string, T>, key: string, value: T): void {
  if (isUnsafeKey(key)) {
    return;
  }
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function normalizeZero(n: number): number {
  return Object.is(n, -0) ? 0 : n;
}

function scanUnsafeKeys(value: unknown, acc: ErrorAccumulator): void {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      scanUnsafeKeys(value[i], acc.scope(`[${i}]`));
    }
    return;
  }
  if (!isPlainObject(value)) {
    return;
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    if (isUnsafeKey(key)) {
      acc.add(key, 'UNSAFE_PROPERTY_KEY', `Forbidden prototype property key "${key}"`);
      continue;
    }
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (desc !== undefined) {
      scanUnsafeKeys(desc.value, acc.scope(key));
    }
  }
}

function cloneLoreEntry(entry: CharacterCardLoreEntry): CharacterCardLoreEntry {
  const cloned: CharacterCardLoreEntry = {
    keys: [...entry.keys],
    secondaryKeys: [...entry.secondaryKeys],
    content: entry.content,
    constant: entry.constant,
    insertionOrder: normalizeZero(entry.insertionOrder),
    enabled: entry.enabled,
  };
  if (entry.name !== undefined) {
    cloned.name = entry.name;
  }
  if (entry.id !== undefined) {
    cloned.id = typeof entry.id === 'number' ? normalizeZero(entry.id) : entry.id;
  }
  return cloned;
}

/**
 * Deep-clone a {@link CharacterCardSheet}, normalizing `-0` and filtering unsafe keys.
 */
export function cloneCharacterCardSheet(sheet: CharacterCardSheet): CharacterCardSheet {
  const cloned: CharacterCardSheet = {
    sourceSpec: sheet.sourceSpec,
    name: sheet.name,
    description: sheet.description,
    personality: sheet.personality,
    scenario: sheet.scenario,
    firstMes: sheet.firstMes,
    alternateGreetings: [...sheet.alternateGreetings],
    mesExample: sheet.mesExample,
    creatorNotes: sheet.creatorNotes,
    systemPrompt: sheet.systemPrompt,
    postHistoryInstructions: sheet.postHistoryInstructions,
    tags: [...sheet.tags],
    portraitAssetPath: sheet.portraitAssetPath,
    embeddedLoreEntries: sheet.embeddedLoreEntries.map(cloneLoreEntry),
  };

  if (sheet.expressionAssets !== undefined) {
    const expressions: Record<string, string> = {};
    for (const key of Object.getOwnPropertyNames(sheet.expressionAssets)) {
      if (isUnsafeKey(key)) {
        continue;
      }
      const val = Object.getOwnPropertyDescriptor(sheet.expressionAssets, key)?.value;
      if (typeof val === 'string') {
        setSafeProp(expressions, key, val);
      }
    }
    cloned.expressionAssets = expressions;
  }

  return cloned;
}

function readStringField(
  obj: Record<string, unknown>,
  key: string,
  acc: ErrorAccumulator,
  requiredNonEmpty = false
): string {
  const raw = obj[key];
  if (typeof raw !== 'string') {
    acc.add(key, 'INVALID_TYPE', `${key} must be a string`);
    return '';
  }
  if (requiredNonEmpty && raw.trim().length === 0) {
    acc.add(key, 'REQUIRED', `${key} must be a non-empty string`);
  }
  return raw;
}

function readStringArrayField(
  obj: Record<string, unknown>,
  key: string,
  acc: ErrorAccumulator
): string[] {
  const raw = obj[key];
  if (!Array.isArray(raw)) {
    acc.add(key, 'INVALID_TYPE', `${key} must be an array of strings`);
    return [];
  }
  const out: string[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    if (typeof item !== 'string') {
      acc.add(`${key}[${i}]`, 'INVALID_TYPE', `${key}[${i}] must be a string`);
    } else {
      out.push(item);
    }
  }
  return out;
}

/**
 * Validate and normalize an unknown value into a {@link CharacterCardSheet}.
 */
export function validateCharacterCardSheet(
  value: unknown,
  pathPrefix = ''
): Result<CharacterCardSheet, ValidationError[]> {
  if (!isPlainObject(value)) {
    return err([
      validationError(pathPrefix, 'INVALID_TYPE', 'CharacterCardSheet must be a plain object'),
    ]);
  }

  const rootAcc = new ErrorAccumulator();
  const acc = pathPrefix.length > 0 ? rootAcc.scope(pathPrefix) : rootAcc;
  scanUnsafeKeys(value, acc);

  const rawSpec = value['sourceSpec'];
  const sourceSpec: CharacterCardSourceSpec =
    rawSpec === 'v2' || rawSpec === 'v3' ? rawSpec : 'v2';
  if (rawSpec !== 'v2' && rawSpec !== 'v3') {
    acc.add('sourceSpec', 'INVALID_VALUE', 'sourceSpec must be "v2" or "v3"');
  }

  const name = readStringField(value, 'name', acc, true);
  const description = readStringField(value, 'description', acc);
  const personality = readStringField(value, 'personality', acc);
  const scenario = readStringField(value, 'scenario', acc);
  const firstMes = readStringField(value, 'firstMes', acc);
  const alternateGreetings = readStringArrayField(value, 'alternateGreetings', acc);
  const mesExample = readStringField(value, 'mesExample', acc);
  const creatorNotes = readStringField(value, 'creatorNotes', acc);
  const systemPrompt = readStringField(value, 'systemPrompt', acc);
  const postHistoryInstructions = readStringField(value, 'postHistoryInstructions', acc);
  const tags = readStringArrayField(value, 'tags', acc);
  const portraitAssetPath = readStringField(value, 'portraitAssetPath', acc);

  let expressionAssets: Record<string, string> | undefined;
  if (value['expressionAssets'] !== undefined) {
    const rawExpr = value['expressionAssets'];
    if (!isPlainObject(rawExpr)) {
      acc.add('expressionAssets', 'INVALID_TYPE', 'expressionAssets must be a plain object');
    } else {
      const cleaned: Record<string, string> = {};
      for (const key of Object.getOwnPropertyNames(rawExpr)) {
        if (isUnsafeKey(key)) {
          continue;
        }
        const val = Object.getOwnPropertyDescriptor(rawExpr, key)?.value;
        if (typeof val !== 'string') {
          acc.add(
            `expressionAssets.${key}`,
            'INVALID_TYPE',
            `expressionAssets.${key} must be a string`
          );
        } else {
          setSafeProp(cleaned, key, val);
        }
      }
      expressionAssets = cleaned;
    }
  }

  const embeddedLoreEntries: CharacterCardLoreEntry[] = [];
  const rawLore = value['embeddedLoreEntries'];
  if (!Array.isArray(rawLore)) {
    acc.add('embeddedLoreEntries', 'INVALID_TYPE', 'embeddedLoreEntries must be an array');
  } else {
    for (let i = 0; i < rawLore.length; i += 1) {
      const entryRaw = rawLore[i];
      const entryAcc = acc.scope(`embeddedLoreEntries[${i}]`);
      if (!isPlainObject(entryRaw)) {
        entryAcc.add('', 'INVALID_TYPE', 'Lore entry must be a plain object');
        continue;
      }
      const keys = readStringArrayField(entryRaw, 'keys', entryAcc);
      const secondaryKeys = readStringArrayField(entryRaw, 'secondaryKeys', entryAcc);
      const content = readStringField(entryRaw, 'content', entryAcc);
      const constant = entryRaw['constant'];
      if (typeof constant !== 'boolean') {
        entryAcc.add('constant', 'INVALID_TYPE', 'constant must be a boolean');
      }
      const insertionOrder = entryRaw['insertionOrder'];
      if (typeof insertionOrder !== 'number' || !Number.isFinite(insertionOrder)) {
        entryAcc.add('insertionOrder', 'INVALID_TYPE', 'insertionOrder must be a finite number');
      }
      const enabled = entryRaw['enabled'];
      if (typeof enabled !== 'boolean') {
        entryAcc.add('enabled', 'INVALID_TYPE', 'enabled must be a boolean');
      }

      const entry: CharacterCardLoreEntry = {
        keys,
        secondaryKeys,
        content,
        constant: typeof constant === 'boolean' ? constant : false,
        insertionOrder:
          typeof insertionOrder === 'number' && Number.isFinite(insertionOrder)
            ? normalizeZero(insertionOrder)
            : 10,
        enabled: typeof enabled === 'boolean' ? enabled : true,
      };

      if (entryRaw['name'] !== undefined) {
        if (typeof entryRaw['name'] !== 'string') {
          entryAcc.add('name', 'INVALID_TYPE', 'name must be a string');
        } else {
          entry.name = entryRaw['name'];
        }
      }
      if (entryRaw['id'] !== undefined) {
        const idVal = entryRaw['id'];
        if (typeof idVal !== 'string' && (typeof idVal !== 'number' || !Number.isFinite(idVal))) {
          entryAcc.add('id', 'INVALID_TYPE', 'id must be a string or finite number');
        } else {
          entry.id = typeof idVal === 'number' ? normalizeZero(idVal) : idVal;
        }
      }

      embeddedLoreEntries.push(entry);
    }
  }

  if (rootAcc.hasErrors()) {
    return err([...rootAcc.errors]);
  }

  const sheet: CharacterCardSheet = {
    sourceSpec,
    name,
    description,
    personality,
    scenario,
    firstMes,
    alternateGreetings,
    mesExample,
    creatorNotes,
    systemPrompt,
    postHistoryInstructions,
    tags,
    portraitAssetPath,
    embeddedLoreEntries,
    ...(expressionAssets !== undefined ? { expressionAssets } : {}),
  };

  return ok(sheet);
}
