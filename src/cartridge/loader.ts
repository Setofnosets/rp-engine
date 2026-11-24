import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { BeatDefinition } from '../beats/beat-ledger.js';
import type { EndingDefinition, RouteDefinition } from '../beats/routes-and-endings.js';
import type { ControlRoomLayer } from '../config/control-room-config.js';
import { type ValidationError, validationError } from '../core/errors.js';
import { ErrorAccumulator, type Result, err, ok } from '../core/result.js';
import { getStockSystemPack } from '../schema/stock-system-packs.js';
import type { SystemPack } from '../schema/tracker-module.js';
import type { FormTransitionRule } from '../state/forms.js';
import type { WorldState } from '../state/world-state.js';
import type { AgendaConfig } from '../world/agendas.js';
import {
  type CartridgeBundle,
  type CartridgeCardSpec,
  type CartridgeCombatConfig,
  type CartridgeInitialEntities,
  getSafeProperty,
  isPlainObject,
  isUnsafeRecordKey,
  scanObjectForUnsafeKeys,
  setSafeProperty,
  validateCartridgeStructure,
} from './cartridge-schema.js';
import { parseAndValidateSystemPack } from './system-pack-schema.js';

function compareStringsDeterministic(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

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

function normalizeRelativeRefPath(rawPath: string): string | null {
  const trimmed = rawPath.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.startsWith('/') || /^[a-zA-Z]:/.test(trimmed)) {
    return null;
  }
  const segments = trimmed.split('/');
  for (const seg of segments) {
    if (seg === '..' || seg === '.' || seg.length === 0 || isUnsafeRecordKey(seg)) {
      return null;
    }
  }
  return trimmed;
}

function hasResolvedFile(
  files: Readonly<Record<string, string>>,
  refPath: string,
  defaultDirPrefix: string
): boolean {
  const normalized = normalizeRelativeRefPath(refPath);
  if (normalized === null) {
    return false;
  }
  if (getSafeProperty(files, normalized) !== undefined) {
    return true;
  }
  if (!normalized.startsWith(`${defaultDirPrefix}/`)) {
    if (getSafeProperty(files, `${defaultDirPrefix}/${normalized}`) !== undefined) {
      return true;
    }
  }
  return false;
}

function hasResolvedScriptFile(
  scriptFiles: Readonly<Record<string, string>>,
  scriptRef: string
): boolean {
  const normalized = normalizeRelativeRefPath(scriptRef);
  if (normalized === null) {
    return false;
  }
  const candidates = new Set<string>([normalized]);
  if (!normalized.endsWith('.js')) {
    candidates.add(`${normalized}.js`);
  }
  if (!normalized.startsWith('scripts/')) {
    candidates.add(`scripts/${normalized}`);
    if (!normalized.endsWith('.js')) {
      candidates.add(`scripts/${normalized}.js`);
    }
  }
  for (const candidate of candidates) {
    if (getSafeProperty(scriptFiles, candidate) !== undefined) {
      return true;
    }
  }
  return false;
}

function isEnoentError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

async function readOptionalJsonFile(
  filePath: string,
  fieldPath: string,
  acc: ErrorAccumulator
): Promise<{ found: boolean; value: unknown }> {
  let rawText: string;
  try {
    rawText = await readFile(filePath, 'utf8');
  } catch (error) {
    if (isEnoentError(error)) {
      return { found: false, value: undefined };
    }
    const message = error instanceof Error ? error.message : 'Unable to read file';
    acc.add(fieldPath, 'FILE_READ_ERROR', `Failed to read "${filePath}": ${message}`);
    return { found: false, value: undefined };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Malformed JSON';
    acc.add(fieldPath, 'INVALID_JSON', `Invalid JSON in "${filePath}": ${message}`);
    return { found: true, value: undefined };
  }

  scanObjectForUnsafeKeys(parsed, acc.scope(fieldPath));
  return { found: true, value: sanitizeJsonValue(parsed) };
}

async function collectFilesWithExtension(
  rootDir: string,
  subDirRelative: string,
  extension: string,
  acc: ErrorAccumulator,
  errorScope: string
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const startDir = path.join(rootDir, ...subDirRelative.split('/'));

  const walk = async (currentAbsDir: string, currentRelDir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(currentAbsDir, { withFileTypes: true });
    } catch (error) {
      if (isEnoentError(error)) {
        return;
      }
      const message = error instanceof Error ? error.message : 'Unable to read directory';
      acc.add(errorScope, 'DIRECTORY_READ_ERROR', `Failed to read "${currentAbsDir}": ${message}`);
      return;
    }

    const sortedEntries = [...entries].sort((a, b) =>
      compareStringsDeterministic(a.name, b.name)
    );

    for (const entry of sortedEntries) {
      if (isUnsafeRecordKey(entry.name)) {
        acc.add(
          `${errorScope}.${entry.name}`,
          'UNSAFE_PROPERTY_KEY',
          `Forbidden filename "${entry.name}"`
        );
        continue;
      }
      const absPath = path.join(currentAbsDir, entry.name);
      const relPath = `${currentRelDir}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(absPath, relPath);
      } else if (entry.isFile() && entry.name.endsWith(extension)) {
        try {
          const content = await readFile(absPath, 'utf8');
          setSafeProperty(result, relPath, content);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unable to read file';
          acc.add(relPath, 'FILE_READ_ERROR', `Failed to read "${absPath}": ${message}`);
        }
      }
    }
  };

  await walk(startDir, subDirRelative);
  return result;
}

async function collectBinaryAssets(
  rootDir: string,
  acc: ErrorAccumulator
): Promise<Record<string, Uint8Array>> {
  const result: Record<string, Uint8Array> = {};
  const startDir = path.join(rootDir, 'assets');

  const walk = async (currentAbsDir: string, currentRelDir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(currentAbsDir, { withFileTypes: true });
    } catch (error) {
      if (isEnoentError(error)) {
        return;
      }
      const message = error instanceof Error ? error.message : 'Unable to read directory';
      acc.add('binaryAssets', 'DIRECTORY_READ_ERROR', `Failed to read "${currentAbsDir}": ${message}`);
      return;
    }

    const sortedEntries = [...entries].sort((a, b) =>
      compareStringsDeterministic(a.name, b.name)
    );

    for (const entry of sortedEntries) {
      if (isUnsafeRecordKey(entry.name)) {
        acc.add(
          `binaryAssets.${entry.name}`,
          'UNSAFE_PROPERTY_KEY',
          `Forbidden filename "${entry.name}"`
        );
        continue;
      }
      const absPath = path.join(currentAbsDir, entry.name);
      const relPath = `${currentRelDir}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(absPath, relPath);
      } else if (entry.isFile()) {
        if (currentRelDir === 'assets/endings' && entry.name.endsWith('.md')) {
          continue;
        }
        try {
          const bytes = await readFile(absPath);
          setSafeProperty(result, relPath, new Uint8Array(bytes));
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unable to read file';
          acc.add(relPath, 'FILE_READ_ERROR', `Failed to read "${absPath}": ${message}`);
        }
      }
    }
  };

  await walk(startDir, 'assets');
  return result;
}

async function tryLoadExplicitRelativeMarkdown(
  rootDir: string,
  refPath: string,
  files: Record<string, string>,
  defaultDirPrefix: string,
  acc: ErrorAccumulator,
  errorPath: string,
  errorCode: string
): Promise<void> {
  const normalized = normalizeRelativeRefPath(refPath);
  if (normalized === null) {
    acc.add(errorPath, 'UNSAFE_FILE_PATH', `Invalid or unsafe file reference "${refPath}"`);
    return;
  }

  if (hasResolvedFile(files, normalized, defaultDirPrefix)) {
    return;
  }

  // Also check if the exact relative path exists directly under rootDir (e.g. epilogues/true.md).
  const resolvedAbs = path.resolve(rootDir, ...normalized.split('/'));
  const rootAbs = path.resolve(rootDir);
  const rootPrefix = rootAbs.endsWith(path.sep) ? rootAbs : `${rootAbs}${path.sep}`;
  if (!resolvedAbs.startsWith(rootPrefix)) {
    acc.add(errorPath, 'UNSAFE_FILE_PATH', `Path "${refPath}" escapes cartridge directory`);
    return;
  }

  try {
    const content = await readFile(resolvedAbs, 'utf8');
    setSafeProperty(files, normalized, content);
  } catch (error) {
    if (isEnoentError(error)) {
      acc.add(errorPath, errorCode, `Referenced file "${refPath}" does not exist`);
    } else {
      const message = error instanceof Error ? error.message : 'Unable to read file';
      acc.add(errorPath, 'FILE_READ_ERROR', `Failed to read "${refPath}": ${message}`);
    }
  }
}

/**
 * Load a `cartridge/0.1` directory into a validated {@link CartridgeBundle}.
 *
 * Reads required `card.json`, optional `system-overrides.json`, `state.json`, `entities.json`,
 * `agendas.json`, `combat.json`, `beats.json`, `routes.json` (plus optional `endings.json`),
 * and asset files under `lore/*.md`, `scripts/*.js`, and `assets/endings/*.md`, verifying
 * that all referenced lore, script, and ending prompt files exist.
 */
export async function loadCartridgeFromDirectory(
  dirPath: string
): Promise<Result<CartridgeBundle, ValidationError[]>> {
  if (typeof dirPath !== 'string' || dirPath.trim().length === 0) {
    return err([validationError('dirPath', 'REQUIRED', 'dirPath must be a non-empty string')]);
  }

  try {
    const dirStat = await stat(dirPath);
    if (!dirStat.isDirectory()) {
      return err([
        validationError('dirPath', 'NOT_A_DIRECTORY', `"${dirPath}" is not a directory`),
      ]);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to access directory';
    return err([
      validationError(
        'dirPath',
        'DIRECTORY_READ_ERROR',
        `Failed to access cartridge directory "${dirPath}": ${message}`
      ),
    ]);
  }

  const acc = new ErrorAccumulator();

  // 1. Required card.json
  const cardRes = await readOptionalJsonFile(path.join(dirPath, 'card.json'), 'card', acc);
  if (!cardRes.found) {
    if (!acc.hasErrors()) {
      acc.add('card', 'MISSING_CARD_FILE', `Missing required card.json in "${dirPath}"`);
    }
    return err([...acc.errors]);
  }

  // 2. Optional JSON files
  const [
    overridesRes,
    stateRes,
    entitiesRes,
    formRulesRes,
    agendasRes,
    combatRes,
    beatsRes,
    routesRes,
    endingsRes,
  ] = await Promise.all([
    readOptionalJsonFile(path.join(dirPath, 'system-overrides.json'), 'systemOverrides', acc),
    readOptionalJsonFile(path.join(dirPath, 'state.json'), 'initialState', acc),
    readOptionalJsonFile(path.join(dirPath, 'entities.json'), 'initialEntities', acc),
    readOptionalJsonFile(path.join(dirPath, 'form-rules.json'), 'initialEntities.formRules', acc),
    readOptionalJsonFile(path.join(dirPath, 'agendas.json'), 'agendas', acc),
    readOptionalJsonFile(path.join(dirPath, 'combat.json'), 'combat', acc),
    readOptionalJsonFile(path.join(dirPath, 'beats.json'), 'beats', acc),
    readOptionalJsonFile(path.join(dirPath, 'routes.json'), 'routes', acc),
    readOptionalJsonFile(path.join(dirPath, 'endings.json'), 'endings', acc),
  ]);

  // 3. Asset directories (lore/*.md, scripts/*.js, assets/endings/*.md, assets/** binary files)
  const [loreFiles, scriptFiles, endingPromptFiles, binaryAssets] = await Promise.all([
    collectFilesWithExtension(dirPath, 'lore', '.md', acc, 'loreFiles'),
    collectFilesWithExtension(dirPath, 'scripts', '.js', acc, 'scriptFiles'),
    collectFilesWithExtension(dirPath, 'assets/endings', '.md', acc, 'endingPromptFiles'),
    collectBinaryAssets(dirPath, acc),
  ]);

  if (acc.hasErrors()) {
    return err([...acc.errors]);
  }

  let beats: BeatDefinition[] = [];
  if (beatsRes.found) {
    if (Array.isArray(beatsRes.value)) {
      beats = beatsRes.value as BeatDefinition[];
    } else if (isPlainObject(beatsRes.value) && Array.isArray(beatsRes.value['beats'])) {
      beats = beatsRes.value['beats'] as BeatDefinition[];
    } else {
      acc.add('beats', 'INVALID_TYPE', 'beats.json must be an array or { beats: [...] }');
    }
  }

  let routes: RouteDefinition[] = [];
  let endings: EndingDefinition[] = [];
  let endingsFromRoutes = false;

  if (routesRes.found) {
    if (Array.isArray(routesRes.value)) {
      routes = routesRes.value as RouteDefinition[];
    } else if (isPlainObject(routesRes.value)) {
      if (routesRes.value['routes'] !== undefined) {
        if (Array.isArray(routesRes.value['routes'])) {
          routes = routesRes.value['routes'] as RouteDefinition[];
        } else {
          acc.add('routes', 'INVALID_TYPE', 'routes.json "routes" must be an array');
        }
      }
      if (routesRes.value['endings'] !== undefined) {
        if (Array.isArray(routesRes.value['endings'])) {
          endings = routesRes.value['endings'] as EndingDefinition[];
          endingsFromRoutes = true;
        } else {
          acc.add('endings', 'INVALID_TYPE', 'routes.json "endings" must be an array');
        }
      }
    } else {
      acc.add(
        'routes',
        'INVALID_TYPE',
        'routes.json must be an array or { routes: [...], endings?: [...] }'
      );
    }
  }

  if (endingsRes.found) {
    if (endingsFromRoutes) {
      acc.add(
        'endings',
        'DUPLICATE_ENDINGS_SOURCE',
        'Endings cannot be defined in both routes.json and endings.json'
      );
    } else if (Array.isArray(endingsRes.value)) {
      endings = endingsRes.value as EndingDefinition[];
    } else if (isPlainObject(endingsRes.value) && Array.isArray(endingsRes.value['endings'])) {
      endings = endingsRes.value['endings'] as EndingDefinition[];
    } else {
      acc.add('endings', 'INVALID_TYPE', 'endings.json must be an array or { endings: [...] }');
    }
  }

  let initialEntities: CartridgeInitialEntities | undefined = entitiesRes.found
    ? (entitiesRes.value as CartridgeInitialEntities)
    : undefined;

  if (formRulesRes.found) {
    let loadedFormRules: FormTransitionRule[] | undefined;
    if (Array.isArray(formRulesRes.value)) {
      loadedFormRules = formRulesRes.value as FormTransitionRule[];
    } else if (isPlainObject(formRulesRes.value) && Array.isArray(formRulesRes.value['formRules'])) {
      loadedFormRules = formRulesRes.value['formRules'] as FormTransitionRule[];
    } else {
      acc.add(
        'initialEntities.formRules',
        'INVALID_TYPE',
        'form-rules.json must be an array or { formRules: [...] }'
      );
    }

    if (loadedFormRules !== undefined) {
      if (initialEntities !== undefined && initialEntities.formRules !== undefined) {
        acc.add(
          'initialEntities.formRules',
          'DUPLICATE_FORM_RULES_SOURCE',
          'formRules cannot be defined in both entities.json and form-rules.json'
        );
      } else {
        initialEntities = {
          ...(initialEntities ?? {}),
          formRules: loadedFormRules,
        };
      }
    }
  }

  const bundle: CartridgeBundle = {
    rootDir: dirPath,
    card: cardRes.value as CartridgeCardSpec,
    ...(overridesRes.found ? { systemOverrides: overridesRes.value as ControlRoomLayer } : {}),
    ...(stateRes.found ? { initialState: stateRes.value as Partial<WorldState> } : {}),
    ...(initialEntities !== undefined ? { initialEntities } : {}),
    ...(agendasRes.found ? { agendas: agendasRes.value as AgendaConfig } : {}),
    ...(combatRes.found ? { combat: combatRes.value as CartridgeCombatConfig } : {}),
    beats,
    routes,
    endings,
    loreFiles,
    endingPromptFiles,
    scriptFiles,
    ...(Object.keys(binaryAssets).length > 0 ? { binaryAssets } : {}),
  };

  const structRes = validateCartridgeStructure(bundle);
  if (!structRes.ok) {
    acc.addAll(structRes.error);
  }

  // 4. Verify referenced lore, script, and ending prompt files exist on disk / in bundle maps.
  if (bundle.card && Array.isArray(bundle.card.scripts)) {
    for (let i = 0; i < bundle.card.scripts.length; i += 1) {
      const manifest = bundle.card.scripts[i];
      if (!manifest || typeof manifest.scriptId !== 'string') {
        continue;
      }
      if (!hasResolvedScriptFile(scriptFiles, manifest.scriptId)) {
        acc.add(
          `card.scripts[${i}].scriptId`,
          'MISSING_SCRIPT_FILE',
          `Referenced script "${manifest.scriptId}" was not found in scripts/`
        );
      }
    }
  }

  for (let i = 0; i < beats.length; i += 1) {
    const beat = beats[i];
    if (!beat || typeof beat !== 'object') {
      continue;
    }
    if (typeof beat.lore === 'string' && !beat.lore.includes('{{')) {
      await tryLoadExplicitRelativeMarkdown(
        dirPath,
        beat.lore,
        loreFiles,
        'lore',
        acc,
        `beats[${i}].lore`,
        'MISSING_LORE_FILE'
      );
    }

    const hookEffects = [
      { name: 'on_entry', list: beat.on_entry },
      { name: 'on_resolve', list: beat.on_resolve },
      { name: 'on_deadline', list: beat.on_deadline },
      { name: 'on_short_circuit', list: beat.on_short_circuit },
      { name: 'on_abort', list: beat.on_abort },
    ] as const;

    for (const hook of hookEffects) {
      if (!Array.isArray(hook.list)) {
        continue;
      }
      for (let j = 0; j < hook.list.length; j += 1) {
        const eff = hook.list[j];
        if (!eff || typeof eff !== 'object') {
          continue;
        }
        if ('inject' in eff && typeof eff.inject === 'string' && !eff.inject.includes('{{')) {
          await tryLoadExplicitRelativeMarkdown(
            dirPath,
            eff.inject,
            loreFiles,
            'lore',
            acc,
            `beats[${i}].${hook.name}[${j}].inject`,
            'MISSING_LORE_FILE'
          );
        }
        if ('script' in eff && typeof eff.script === 'string' && !eff.script.includes('{{')) {
          if (!hasResolvedScriptFile(scriptFiles, eff.script)) {
            acc.add(
              `beats[${i}].${hook.name}[${j}].script`,
              'MISSING_SCRIPT_FILE',
              `Referenced script "${eff.script}" was not found in scripts/`
            );
          }
        }
      }
    }
  }

  for (let i = 0; i < endings.length; i += 1) {
    const ending = endings[i];
    if (ending && ending.epilogue && typeof ending.epilogue.promptPath === 'string') {
      await tryLoadExplicitRelativeMarkdown(
        dirPath,
        ending.epilogue.promptPath,
        endingPromptFiles,
        'assets/endings',
        acc,
        `endings[${i}].epilogue.promptPath`,
        'MISSING_ENDING_PROMPT_FILE'
      );
    }
  }

  if (acc.hasErrors()) {
    return err([...acc.errors]);
  }

  return ok(bundle);
}

/**
 * Resolve the effective base {@link SystemPack} for a cartridge:
 * uses `explicitPack` if provided, otherwise falls back to
 * `getStockSystemPack(cartridge.card.recommendedSystemPack ?? 'stock-slice-of-life')`.
 */
export function resolveEffectivePackForCartridge(
  cartridge: CartridgeBundle,
  explicitPack?: SystemPack
): Result<SystemPack, ValidationError[]> {
  if (explicitPack !== undefined) {
    return parseAndValidateSystemPack(explicitPack);
  }

  if (!cartridge || typeof cartridge !== 'object' || !cartridge.card) {
    return err([
      validationError('cartridge', 'INVALID_TYPE', 'CartridgeBundle with valid card is required'),
    ]);
  }

  const packId = cartridge.card.recommendedSystemPack ?? 'stock-slice-of-life';
  const stockPack = getStockSystemPack(packId);
  if (!stockPack) {
    return err([
      validationError(
        'card.recommendedSystemPack',
        'UNKNOWN_SYSTEM_PACK',
        `Unknown recommendedSystemPack "${packId}"`
      ),
    ]);
  }

  return ok(stockPack);
}
