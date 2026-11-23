import { readFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import type { CartridgeBundle } from '../cartridge/cartridge-schema.js';
import { importSillyTavernCard } from '../cartridge/importers/st-card-importer.js';
import {
  type SillyTavernPresetImportResult,
  importSillyTavernPreset,
} from '../cartridge/importers/st-preset-importer.js';
import { loadCartridgeFromDirectory } from '../cartridge/loader.js';
import { type ControlRoomLayer } from '../config/control-room-config.js';
import { type UserPersonaPreset, validateUserPersonaPreset } from '../config/persona-preset.js';
import { type ValidationError, formatValidationErrors, validationError } from '../core/errors.js';
import { ErrorAccumulator, type Result, err, ok } from '../core/result.js';
import {
  type ConnectionsFileDocument,
  applyConnectionsFileToGateway,
  loadConnectionsFile,
  saveConnectionsFile,
  snapshotGatewayToConnectionsDoc,
} from '../gateway/connection-store.js';
import { ModelGateway } from '../gateway/model-gateway.js';
import type { AgentRole } from '../gateway/types.js';
import { SessionRuntime } from '../runtime/session-runtime.js';
import { STOCK_FREEFORM_PACK, getStockSystemPack } from '../schema/stock-system-packs.js';
import type { SystemPack } from '../schema/tracker-module.js';
import { RefereeDaemon } from '../server/daemon.js';
import { loadSessionSave } from '../state/persistence.js';
import { RefereeDataStore } from '../storage/data-store.js';
import { TuiController, type TuiViewport } from '../tui/app.js';
import { runSimCli } from './sim-cli.js';

export interface CliConnectionOptions {
  readonly baseUrl?: string;
  readonly model?: string;
  readonly apiKey?: string;
  readonly trackerModel?: string;
  readonly connectionsPath?: string;
  readonly dataDir?: string;
}

export type ParsedMainCliCommand =
  | {
      readonly command: 'help';
    }
  | {
      readonly command: 'sim';
      readonly simArgs: readonly string[];
    }
  | ({
      readonly command: 'daemon';
      readonly host: string;
      readonly port: number;
      readonly dataDir?: string;
      readonly saveDirPath?: string;
      readonly resumePath?: string;
      readonly presetPath?: string;
      readonly personaPath?: string;
    } & CliConnectionOptions)
  | ({
      readonly command: 'play';
      readonly freeform: boolean;
      readonly cardPath?: string;
      readonly cartridgePath?: string;
      readonly packId?: string;
      readonly daemon: boolean;
      readonly port: number;
      readonly seed?: string;
      readonly dataDir?: string;
      readonly saveDirPath?: string;
      readonly resumePath?: string;
      readonly presetPath?: string;
      readonly personaPath?: string;
    } & CliConnectionOptions);

export interface MainCliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export interface PlaySessionInputs {
  readonly cartridge: CartridgeBundle | null;
  readonly systemPack: SystemPack | undefined;
}

function parsePortOption(raw: string | undefined, flag: string): Result<number, ValidationError[]> {
  if (raw === undefined || raw.trim().length === 0) {
    return err([validationError(flag, 'REQUIRED', `${flag} requires a numeric port`)]);
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    return err([validationError(flag, 'INVALID_PORT', `${flag} must be an integer between 0 and 65535`)]);
  }
  return ok(port);
}

function readFlagValue(
  argv: readonly string[],
  index: number,
  flag: string,
  acc: ErrorAccumulator,
  requiredMessage: string
): { value: string | undefined; nextIndex: number } {
  const val = argv[index + 1];
  if (val === undefined || val.startsWith('--')) {
    acc.add(flag, 'REQUIRED', requiredMessage);
    return { value: undefined, nextIndex: index };
  }
  if (val.includes('\0')) {
    acc.add(flag, 'INVALID_PATH', `${flag} must not contain NUL bytes`);
    return { value: undefined, nextIndex: index + 1 };
  }
  return { value: val, nextIndex: index + 1 };
}

/**
 * Parse CLI arguments for `referee play`, `referee sim`, and `referee daemon`.
 */
export function parseMainCliArgs(
  argv: readonly string[]
): Result<ParsedMainCliCommand, ValidationError[]> {
  if (argv.length === 0) {
    return ok({ command: 'play', freeform: false, daemon: false, port: 4120 });
  }

  const first = argv[0];
  if (first === '--help' || first === '-h' || first === 'help') {
    return ok({ command: 'help' });
  }

  if (first === 'sim') {
    return ok({ command: 'sim', simArgs: argv.slice(1) });
  }

  if (first === 'daemon') {
    let host = '127.0.0.1';
    let port = 4120;
    let dataDir: string | undefined;
    let saveDirPath: string | undefined;
    let resumePath: string | undefined;
    let presetPath: string | undefined;
    let personaPath: string | undefined;
    let baseUrl: string | undefined;
    let model: string | undefined;
    let apiKey: string | undefined;
    let trackerModel: string | undefined;
    let connectionsPath: string | undefined;
    const acc = new ErrorAccumulator('daemon');

    for (let i = 1; i < argv.length; i += 1) {
      const token = argv[i];
      if (token === '--help' || token === '-h') {
        return ok({ command: 'help' });
      }
      if (token === '--host') {
        const res = readFlagValue(argv, i, '--host', acc, '--host requires a hostname or IP');
        if (res.value !== undefined) host = res.value;
        i = res.nextIndex;
      } else if (token === '--port') {
        const portRes = parsePortOption(argv[i + 1], '--port');
        if (!portRes.ok) {
          acc.addAll(portRes.error);
        } else {
          port = portRes.value;
          i += 1;
        }
      } else if (token === '--data-dir') {
        const res = readFlagValue(argv, i, '--data-dir', acc, '--data-dir requires a directory path');
        if (res.value !== undefined) dataDir = res.value;
        i = res.nextIndex;
      } else if (token === '--save-dir') {
        const res = readFlagValue(argv, i, '--save-dir', acc, '--save-dir requires a directory path');
        if (res.value !== undefined) saveDirPath = res.value;
        i = res.nextIndex;
      } else if (token === '--resume') {
        const res = readFlagValue(argv, i, '--resume', acc, '--resume requires a save directory path');
        if (res.value !== undefined) resumePath = res.value;
        i = res.nextIndex;
      } else if (token === '--preset') {
        const res = readFlagValue(argv, i, '--preset', acc, '--preset requires a preset JSON path');
        if (res.value !== undefined) presetPath = res.value;
        i = res.nextIndex;
      } else if (token === '--persona') {
        const res = readFlagValue(argv, i, '--persona', acc, '--persona requires a persona JSON path');
        if (res.value !== undefined) personaPath = res.value;
        i = res.nextIndex;
      } else if (token === '--base-url') {
        const res = readFlagValue(argv, i, '--base-url', acc, '--base-url requires an endpoint URL');
        if (res.value !== undefined) baseUrl = res.value;
        i = res.nextIndex;
      } else if (token === '--model') {
        const res = readFlagValue(argv, i, '--model', acc, '--model requires a model identifier');
        if (res.value !== undefined) model = res.value;
        i = res.nextIndex;
      } else if (token === '--api-key') {
        const res = readFlagValue(argv, i, '--api-key', acc, '--api-key requires an API key value');
        if (res.value !== undefined) apiKey = res.value;
        i = res.nextIndex;
      } else if (token === '--tracker-model') {
        const res = readFlagValue(argv, i, '--tracker-model', acc, '--tracker-model requires a model identifier');
        if (res.value !== undefined) trackerModel = res.value;
        i = res.nextIndex;
      } else if (token === '--connections') {
        const res = readFlagValue(argv, i, '--connections', acc, '--connections requires a JSON file path');
        if (res.value !== undefined) connectionsPath = res.value;
        i = res.nextIndex;
      } else {
        acc.add(String(token), 'UNKNOWN_FLAG', `Unknown daemon option "${String(token)}"`);
      }
    }

    if (acc.hasErrors()) {
      return err([...acc.errors]);
    }
    return ok({
      command: 'daemon',
      host,
      port,
      ...(dataDir !== undefined ? { dataDir } : {}),
      ...(saveDirPath !== undefined ? { saveDirPath } : {}),
      ...(resumePath !== undefined ? { resumePath } : {}),
      ...(presetPath !== undefined ? { presetPath } : {}),
      ...(personaPath !== undefined ? { personaPath } : {}),
      ...(baseUrl !== undefined ? { baseUrl } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(apiKey !== undefined ? { apiKey } : {}),
      ...(trackerModel !== undefined ? { trackerModel } : {}),
      ...(connectionsPath !== undefined ? { connectionsPath } : {}),
    });
  }

  const startIdx = first === 'play' ? 1 : 0;
  let freeform = false;
  let cardPath: string | undefined;
  let cartridgePath: string | undefined;
  let packId: string | undefined;
  let daemon = false;
  let port = 4120;
  let seed: string | undefined;
  let dataDir: string | undefined;
  let saveDirPath: string | undefined;
  let resumePath: string | undefined;
  let presetPath: string | undefined;
  let personaPath: string | undefined;
  let baseUrl: string | undefined;
  let model: string | undefined;
  let apiKey: string | undefined;
  let trackerModel: string | undefined;
  let connectionsPath: string | undefined;
  const acc = new ErrorAccumulator('play');

  for (let i = startIdx; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--help' || token === '-h') {
      return ok({ command: 'help' });
    }
    if (token === '--freeform') {
      freeform = true;
    } else if (token === '--daemon') {
      daemon = true;
    } else if (token === '--card') {
      const res = readFlagValue(argv, i, '--card', acc, '--card requires a file path');
      if (res.value !== undefined) cardPath = res.value;
      i = res.nextIndex;
    } else if (token === '--cartridge') {
      const res = readFlagValue(argv, i, '--cartridge', acc, '--cartridge requires a directory path');
      if (res.value !== undefined) cartridgePath = res.value;
      i = res.nextIndex;
    } else if (token === '--pack') {
      const res = readFlagValue(argv, i, '--pack', acc, '--pack requires a System Pack ID');
      if (res.value !== undefined) packId = res.value;
      i = res.nextIndex;
    } else if (token === '--port') {
      const portRes = parsePortOption(argv[i + 1], '--port');
      if (!portRes.ok) {
        acc.addAll(portRes.error);
      } else {
        port = portRes.value;
        i += 1;
      }
    } else if (token === '--seed') {
      const res = readFlagValue(argv, i, '--seed', acc, '--seed requires a seed string');
      if (res.value !== undefined) seed = res.value;
      i = res.nextIndex;
    } else if (token === '--data-dir') {
      const res = readFlagValue(argv, i, '--data-dir', acc, '--data-dir requires a directory path');
      if (res.value !== undefined) dataDir = res.value;
      i = res.nextIndex;
    } else if (token === '--save-dir') {
      const res = readFlagValue(argv, i, '--save-dir', acc, '--save-dir requires a directory path');
      if (res.value !== undefined) saveDirPath = res.value;
      i = res.nextIndex;
    } else if (token === '--resume') {
      const res = readFlagValue(argv, i, '--resume', acc, '--resume requires a save directory path');
      if (res.value !== undefined) resumePath = res.value;
      i = res.nextIndex;
    } else if (token === '--preset') {
      const res = readFlagValue(argv, i, '--preset', acc, '--preset requires a preset JSON path');
      if (res.value !== undefined) presetPath = res.value;
      i = res.nextIndex;
    } else if (token === '--persona') {
      const res = readFlagValue(argv, i, '--persona', acc, '--persona requires a persona JSON path');
      if (res.value !== undefined) personaPath = res.value;
      i = res.nextIndex;
    } else if (token === '--base-url') {
      const res = readFlagValue(argv, i, '--base-url', acc, '--base-url requires an endpoint URL');
      if (res.value !== undefined) baseUrl = res.value;
      i = res.nextIndex;
    } else if (token === '--model') {
      const res = readFlagValue(argv, i, '--model', acc, '--model requires a model identifier');
      if (res.value !== undefined) model = res.value;
      i = res.nextIndex;
    } else if (token === '--api-key') {
      const res = readFlagValue(argv, i, '--api-key', acc, '--api-key requires an API key value');
      if (res.value !== undefined) apiKey = res.value;
      i = res.nextIndex;
    } else if (token === '--tracker-model') {
      const res = readFlagValue(argv, i, '--tracker-model', acc, '--tracker-model requires a model identifier');
      if (res.value !== undefined) trackerModel = res.value;
      i = res.nextIndex;
    } else if (token === '--connections') {
      const res = readFlagValue(argv, i, '--connections', acc, '--connections requires a JSON file path');
      if (res.value !== undefined) connectionsPath = res.value;
      i = res.nextIndex;
    } else {
      acc.add(String(token), 'UNKNOWN_FLAG', `Unknown play option "${String(token)}"`);
    }
  }

  if (cardPath !== undefined && cartridgePath !== undefined) {
    acc.add('--card', 'CONFLICTING_FLAGS', '--card and --cartridge cannot be used together');
  }

  if (acc.hasErrors()) {
    return err([...acc.errors]);
  }

  return ok({
    command: 'play',
    freeform,
    ...(cardPath !== undefined ? { cardPath } : {}),
    ...(cartridgePath !== undefined ? { cartridgePath } : {}),
    ...(packId !== undefined ? { packId } : {}),
    daemon,
    port,
    ...(seed !== undefined ? { seed } : {}),
    ...(dataDir !== undefined ? { dataDir } : {}),
    ...(saveDirPath !== undefined ? { saveDirPath } : {}),
    ...(resumePath !== undefined ? { resumePath } : {}),
    ...(presetPath !== undefined ? { presetPath } : {}),
    ...(personaPath !== undefined ? { personaPath } : {}),
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(trackerModel !== undefined ? { trackerModel } : {}),
    ...(connectionsPath !== undefined ? { connectionsPath } : {}),
  });
}

export function formatMainHelpText(): string {
  return [
    'Referee Engine CLI / Native TUI',
    '',
    'Usage:',
    '  referee play [--freeform] [--card <path>] [--cartridge <path>] [--pack <id>] [--save-dir <path>] [--resume <path>] [--preset <path>] [--persona <path>] [--data-dir <path>] [--base-url <url>] [--model <id>] [--api-key <key>] [--tracker-model <id>] [--connections <json>] [--daemon] [--port <n>] [--seed <seed>]',
    '  referee sim <validate|run> ...',
    '  referee daemon [--host <host>] [--port <n>] [--data-dir <path>] [--save-dir <path>] [--resume <path>] [--preset <path>] [--persona <path>] [--base-url <url>] [--model <id>] [--api-key <key>] [--tracker-model <id>] [--connections <json>]',
  ].join('\n');
}

/**
 * Load optional SillyTavern card or Cartridge directory plus resolved System Pack for `referee play`.
 */
export async function loadPlaySessionInputs(options: {
  readonly freeform: boolean;
  readonly cardPath?: string;
  readonly cartridgePath?: string;
  readonly packId?: string;
}): Promise<Result<PlaySessionInputs, ValidationError[]>> {
  let systemPack: SystemPack | undefined;
  const effectivePackId = options.freeform && options.packId === undefined
    ? 'stock-freeform'
    : options.packId;

  if (effectivePackId !== undefined) {
    const found = getStockSystemPack(effectivePackId);
    if (found === undefined) {
      return err([
        validationError('--pack', 'UNKNOWN_PACK', `Unknown System Pack "${effectivePackId}"`),
      ]);
    }
    systemPack = found;
  } else if (options.freeform) {
    systemPack = STOCK_FREEFORM_PACK;
  }

  let cartridge: CartridgeBundle | null = null;
  if (options.cardPath !== undefined) {
    let rawBytes: Buffer;
    try {
      rawBytes = await readFile(options.cardPath);
    } catch (caught) {
      const msg = caught instanceof Error ? caught.message : 'Unable to read card file';
      return err([validationError('--card', 'READ_FAILED', msg)]);
    }
    const cardRes = importSillyTavernCard(
      rawBytes,
      effectivePackId !== undefined ? { recommendedSystemPack: effectivePackId } : {}
    );
    if (!cardRes.ok) {
      return err(cardRes.error);
    }
    cartridge = cardRes.value;
  } else if (options.cartridgePath !== undefined) {
    const cartRes = await loadCartridgeFromDirectory(options.cartridgePath);
    if (!cartRes.ok) {
      return err(cartRes.error);
    }
    cartridge = cartRes.value;
  }

  return ok({ cartridge, systemPack });
}

export function getTerminalViewport(
  stream: { readonly columns?: number; readonly rows?: number } = process.stdout
): TuiViewport {
  const width =
    typeof stream.columns === 'number' && Number.isFinite(stream.columns) && stream.columns > 0
      ? stream.columns
      : 80;
  const height =
    typeof stream.rows === 'number' && Number.isFinite(stream.rows) && stream.rows > 0
      ? stream.rows
      : 24;
  return { width, height };
}

async function runInteractiveTuiLoop(
  controller: TuiController,
  io: MainCliIo
): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const isTty = Boolean(process.stdout.isTTY);

  const draw = (): void => {
    const viewport = getTerminalViewport();
    if (isTty) {
      // Reserve 1 terminal row for readline's `> ` prompt so the top header stays visible.
      const ttyViewport: TuiViewport = {
        width: viewport.width,
        height: Math.max(8, viewport.height - 1),
      };
      const frame = controller.renderScreen(ttyViewport, { hidePromptLine: true });
      process.stdout.write(`\x1b[2J\x1b[H${frame}\n`);
    } else {
      const frame = controller.renderScreen(viewport);
      io.stdout(frame);
    }
  };

  draw();
  try {
    while (true) {
      let line: string;
      try {
        line = await rl.question('> ');
      } catch {
        break;
      }

      let res: { readonly outputLines: readonly string[]; readonly shouldExit: boolean };
      try {
        res = await controller.handleInput(line);
      } catch (caught) {
        const msg = caught instanceof Error ? caught.message : String(caught);
        if (isTty) {
          controller.showErrorMessage(msg);
          draw();
        } else {
          io.stderr(`Error: ${msg}`);
        }
        continue;
      }

      if (!isTty || res.shouldExit) {
        for (const outLine of res.outputLines) {
          io.stdout(outLine);
        }
      }
      if (res.shouldExit) {
        break;
      }
      draw();
    }
  } finally {
    rl.close();
    controller.dispose();
  }
}

/**
 * Load and validate a preset file (SillyTavern Chat/Text Completion or Referee ControlRoomLayer)
 * for `--preset <path>`.
 */
export async function loadCliPresetFile(
  presetPath: string
): Promise<Result<SillyTavernPresetImportResult, ValidationError[]>> {
  if (typeof presetPath !== 'string' || presetPath.trim().length === 0 || presetPath.includes('\0')) {
    return err([validationError('--preset', 'INVALID_PATH', '--preset requires a valid file path')]);
  }
  let rawText: string;
  try {
    rawText = await readFile(path.resolve(presetPath), 'utf8');
  } catch (caught) {
    const msg = caught instanceof Error ? caught.message : 'Unable to read preset file';
    return err([validationError('--preset', 'READ_FAILED', msg)]);
  }
  return importSillyTavernPreset(rawText);
}

/**
 * Load and validate a {@link UserPersonaPreset} JSON file for `--persona <path>`.
 */
export async function loadCliPersonaFile(
  personaPath: string
): Promise<Result<UserPersonaPreset, ValidationError[]>> {
  if (
    typeof personaPath !== 'string' ||
    personaPath.trim().length === 0 ||
    personaPath.includes('\0')
  ) {
    return err([
      validationError('--persona', 'INVALID_PATH', '--persona requires a valid file path'),
    ]);
  }
  let rawText: string;
  try {
    rawText = await readFile(path.resolve(personaPath), 'utf8');
  } catch (caught) {
    const msg = caught instanceof Error ? caught.message : 'Unable to read persona file';
    return err([validationError('--persona', 'READ_FAILED', msg)]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText) as unknown;
  } catch (caught) {
    const msg = caught instanceof Error ? caught.message : 'Invalid JSON';
    return err([validationError('--persona', 'INVALID_JSON', msg)]);
  }
  return validateUserPersonaPreset(parsed);
}

/**
 * Construct a {@link ModelGateway} from optional `referee.connections.json` (or `<dataDir>/connections.json`),
 * environment variables (`REFEREE_BASE_URL` / `OPENAI_BASE_URL`, `REFEREE_MODEL` / `OPENAI_MODEL`,
 * `REFEREE_API_KEY` / `OPENAI_API_KEY`, `REFEREE_TRACKER_MODEL`), and CLI flags,
 * preserving `provider`, `SamplingParameters`, `timeoutMs`, `supportsJsonSchema`, and `activeProfile`.
 */
export async function buildCliModelGateway(
  options: CliConnectionOptions = {},
  env: NodeJS.ProcessEnv = process.env
): Promise<Result<ModelGateway, ValidationError[]>> {
  const gateway = new ModelGateway();

  // 1. Load versioned or legacy connections file via connection-store.ts
  const explicitPath = options.connectionsPath;
  const candidatePaths: Array<{ filePath: string; required: boolean }> =
    explicitPath !== undefined
      ? [{ filePath: explicitPath, required: true }]
      : [
          { filePath: path.resolve('referee.connections.json'), required: false },
          ...(options.dataDir !== undefined
            ? [{ filePath: new RefereeDataStore(options.dataDir).getConnectionsPath(), required: false }]
            : []),
        ];

  let loadedDoc: ConnectionsFileDocument | undefined;
  for (const candidate of candidatePaths) {
    const loadRes = await loadConnectionsFile(candidate.filePath);
    if (loadRes.ok) {
      loadedDoc = loadRes.value;
      applyConnectionsFileToGateway(gateway, loadedDoc);
      break;
    }
    const isNotFoundOnly = loadRes.error.every((e) => e.code === 'NOT_FOUND');
    if (candidate.required || !isNotFoundOnly) {
      return err(
        loadRes.error.map((e) => validationError('--connections', e.code, e.message))
      );
    }
  }

  // 2. Environment variables + CLI flag overrides (preserving provider, sampling, timeout, etc.)
  const existingDefault = gateway.getConnectionsSnapshot().defaultConnection;
  const overrideBaseUrl = options.baseUrl ?? env.REFEREE_BASE_URL ?? env.OPENAI_BASE_URL;
  const overrideModel = options.model ?? env.REFEREE_MODEL ?? env.OPENAI_MODEL;
  const overrideApiKey = options.apiKey ?? env.REFEREE_API_KEY ?? env.OPENAI_API_KEY;
  const hasDefaultOverride =
    overrideBaseUrl !== undefined || overrideModel !== undefined || overrideApiKey !== undefined;

  const baseUrl = overrideBaseUrl ?? existingDefault?.baseUrl;
  const model = overrideModel ?? existingDefault?.model;
  const apiKey = overrideApiKey ?? existingDefault?.apiKey;

  if (hasDefaultOverride && baseUrl !== undefined && model !== undefined) {
    const { role: _ignoredRole, ...preservedFields } = existingDefault ?? {
      provider: 'openai_compatible' as const,
      baseUrl,
      model,
    };
    gateway.setDefaultConnection({
      ...preservedFields,
      provider: existingDefault?.provider ?? 'openai_compatible',
      baseUrl,
      model,
      ...(apiKey !== undefined ? { apiKey } : {}),
    });
  }

  const trackerModel = options.trackerModel ?? env.REFEREE_TRACKER_MODEL;
  if (trackerModel !== undefined && baseUrl !== undefined) {
    const trackerRoles: readonly AgentRole[] = [
      'state_tracker',
      'intent_parser',
      'cast_director',
      'storyline_planner',
      'chronicle_router',
    ];
    for (const r of trackerRoles) {
      const existingRole = gateway.getConnectionsSnapshot().connections[r];
      const { role: _ignoredRole, ...preservedRoleFields } = existingRole ??
        existingDefault ?? {
          provider: 'openai_compatible' as const,
          baseUrl,
          model: trackerModel,
        };
      gateway.setRoleConnection(r, {
        ...preservedRoleFields,
        provider: existingRole?.provider ?? existingDefault?.provider ?? 'openai_compatible',
        baseUrl: existingRole?.baseUrl ?? baseUrl,
        model: trackerModel,
        ...(apiKey !== undefined ? { apiKey } : {}),
      });
    }
  }

  return ok(gateway);
}

/**
 * Snapshot and atomically persist a CLI {@link ModelGateway}'s connections using `connection-store.ts`.
 */
export async function saveCliModelGatewayConnections(
  filePath: string,
  gateway: ModelGateway,
  existingDoc?: ConnectionsFileDocument
): Promise<Result<ConnectionsFileDocument, ValidationError[]>> {
  let baselineDoc = existingDoc;
  if (baselineDoc === undefined) {
    const loaded = await loadConnectionsFile(filePath);
    if (loaded.ok) {
      baselineDoc = loaded.value;
    }
  }
  const nextDoc = snapshotGatewayToConnectionsDoc(gateway, baselineDoc);
  const saveRes = await saveConnectionsFile(filePath, nextDoc);
  if (!saveRes.ok) {
    return saveRes;
  }
  return ok(nextDoc);
}

/**
 * Execute the Referee CLI command (`play`, `sim`, `daemon`, or `help`).
 */
export async function runMainCli(
  argv: readonly string[],
  io: MainCliIo = {
    stdout: (text) => process.stdout.write(`${text}\n`),
    stderr: (text) => process.stderr.write(`${text}\n`),
  }
): Promise<number> {
  const parsed = parseMainCliArgs(argv);
  if (!parsed.ok) {
    io.stderr(formatValidationErrors(parsed.error));
    return 1;
  }

  const cmd = parsed.value;

  if (cmd.command === 'help') {
    io.stdout(formatMainHelpText());
    return 0;
  }

  if (cmd.command === 'sim') {
    return runSimCli(cmd.simArgs, io);
  }

  let dataStore: RefereeDataStore | undefined;
  if (cmd.dataDir !== undefined) {
    dataStore = new RefereeDataStore(cmd.dataDir);
    const initRes = await dataStore.init();
    if (!initRes.ok) {
      io.stderr(formatValidationErrors(initRes.error));
      return 1;
    }
  }

  let importedPreset: SillyTavernPresetImportResult | undefined;
  if (cmd.presetPath !== undefined) {
    const presetRes = await loadCliPresetFile(cmd.presetPath);
    if (!presetRes.ok) {
      io.stderr(formatValidationErrors(presetRes.error));
      return 1;
    }
    importedPreset = presetRes.value;
  }

  let loadedPersona: UserPersonaPreset | undefined;
  if (cmd.personaPath !== undefined) {
    const personaRes = await loadCliPersonaFile(cmd.personaPath);
    if (!personaRes.ok) {
      io.stderr(formatValidationErrors(personaRes.error));
      return 1;
    }
    loadedPersona = personaRes.value;
  }

  const gatewayRes = await buildCliModelGateway(cmd);
  if (!gatewayRes.ok) {
    io.stderr(formatValidationErrors(gatewayRes.error));
    return 1;
  }
  const gateway = gatewayRes.value;

  if (cmd.command === 'daemon') {
    const daemon = new RefereeDaemon({
      host: cmd.host,
      port: cmd.port,
      gateway,
      ...(cmd.dataDir !== undefined ? { dataDir: cmd.dataDir } : {}),
      ...(cmd.connectionsPath !== undefined ? { connectionsPath: cmd.connectionsPath } : {}),
    });
    const info = await daemon.start();
    const registry = daemon.getRegistry();

    if (importedPreset !== undefined) {
      const presetId = importedPreset.presetName
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'cli-preset';
      registry.presets.set(presetId, {
        id: presetId,
        name: importedPreset.presetName,
        sourceFormat: importedPreset.format,
        layer: importedPreset.layer,
        updatedAt: new Date().toISOString(),
      });
    }
    if (loadedPersona !== undefined) {
      registry.personas.set(loadedPersona.id, loadedPersona);
    }
    if (cmd.resumePath !== undefined) {
      const savePeek = await loadSessionSave(cmd.resumePath);
      if (!savePeek.ok) {
        io.stderr(formatValidationErrors(savePeek.error));
        await daemon.stop();
        return 1;
      }
      const manifestPack =
        registry.systemPacks.get(savePeek.value.manifest.systemPackId) ??
        getStockSystemPack(savePeek.value.manifest.systemPackId);
      const resumed = await SessionRuntime.fromSaveDirectory(cmd.resumePath, {
        sessionId: savePeek.value.manifest.sessionId || 'cli-session-1',
        gateway,
        ...(manifestPack !== undefined ? { systemPack: manifestPack } : {}),
        ...(importedPreset !== undefined ? { overrideUserLayer: importedPreset.layer } : {}),
        ...(loadedPersona !== undefined ? { overrideUserPersona: loadedPersona } : {}),
      });
      if (!resumed.ok) {
        io.stderr(formatValidationErrors(resumed.error));
        await daemon.stop();
        return 1;
      }
      registry.registerSession(resumed.value);
    }

    io.stdout(`RefereeDaemon listening at ${info.url}`);

    await new Promise<void>((resolve) => {
      const shutdown = (): void => {
        process.off('SIGINT', shutdown);
        process.off('SIGTERM', shutdown);
        void daemon.stop().finally(resolve);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    });
    return 0;
  }

  let effectivePackId = cmd.packId;
  let resumeSessionId = 'cli-session-1';
  if (cmd.resumePath !== undefined) {
    const savePeek = await loadSessionSave(cmd.resumePath);
    if (!savePeek.ok) {
      io.stderr(formatValidationErrors(savePeek.error));
      return 1;
    }
    resumeSessionId = savePeek.value.manifest.sessionId || 'cli-session-1';
    if (effectivePackId === undefined && !cmd.freeform) {
      effectivePackId = savePeek.value.manifest.systemPackId;
    }
  }

  let customPackFromStore: SystemPack | undefined;
  if (effectivePackId !== undefined && getStockSystemPack(effectivePackId) === undefined && dataStore !== undefined) {
    const storePackRes = await dataStore.getSystemPack(effectivePackId);
    if (storePackRes.ok) {
      customPackFromStore = storePackRes.value;
    }
  }

  const inputsRes = await loadPlaySessionInputs({
    freeform: cmd.freeform,
    ...(cmd.cardPath !== undefined ? { cardPath: cmd.cardPath } : {}),
    ...(cmd.cartridgePath !== undefined ? { cartridgePath: cmd.cartridgePath } : {}),
    ...(customPackFromStore === undefined && effectivePackId !== undefined
      ? { packId: effectivePackId }
      : {}),
  });
  if (!inputsRes.ok) {
    io.stderr(formatValidationErrors(inputsRes.error));
    return 1;
  }

  const cartridge = inputsRes.value.cartridge;
  const systemPack = customPackFromStore ?? inputsRes.value.systemPack;
  const userControlRoomLayer: ControlRoomLayer | undefined = importedPreset?.layer;

  if (cmd.daemon) {
    const daemon = new RefereeDaemon({
      host: '127.0.0.1',
      port: cmd.port,
      gateway,
      ...(cmd.dataDir !== undefined ? { dataDir: cmd.dataDir } : {}),
      ...(cmd.connectionsPath !== undefined ? { connectionsPath: cmd.connectionsPath } : {}),
    });
    const info = await daemon.start();
    const registry = daemon.getRegistry();

    let cartridgeId: string | undefined;
    if (cartridge !== null) {
      registry.cartridges.set(cartridge.card.id, cartridge);
      cartridgeId = cartridge.card.id;
    }

    let resumedDaemonSessionId: string | undefined;
    if (cmd.resumePath !== undefined) {
      const resumedRes = await SessionRuntime.fromSaveDirectory(cmd.resumePath, {
        sessionId: resumeSessionId,
        gateway,
        cartridge,
        ...(systemPack !== undefined ? { systemPack } : {}),
        ...(cmd.seed !== undefined ? { seed: cmd.seed } : {}),
        ...(userControlRoomLayer !== undefined ? { overrideUserLayer: userControlRoomLayer } : {}),
        ...(loadedPersona !== undefined ? { overrideUserPersona: loadedPersona } : {}),
      });
      if (!resumedRes.ok) {
        io.stderr(formatValidationErrors(resumedRes.error));
        await daemon.stop();
        return 1;
      }
      registry.registerSession(resumedRes.value, {
        cartridge,
        ...(systemPack !== undefined ? { basePack: systemPack } : {}),
      });
      resumedDaemonSessionId = resumedRes.value.sessionId;
    }

    const controller = new TuiController({
      daemonUrl: info.url,
      ...(resumedDaemonSessionId !== undefined ? { sessionId: resumedDaemonSessionId } : {}),
      cartridge,
      ...(systemPack !== undefined ? { basePack: systemPack } : {}),
      ...(dataStore !== undefined ? { dataStore } : {}),
      ...(cmd.connectionsPath !== undefined ? { connectionsPath: cmd.connectionsPath } : {}),
    });
    try {
      await controller.connectDaemonSession({
        ...(systemPack !== undefined ? { systemPackId: systemPack.id } : {}),
        ...(cartridgeId !== undefined ? { cartridgeId } : {}),
        ...(cmd.seed !== undefined ? { seed: cmd.seed } : {}),
        ...(cmd.saveDirPath !== undefined ? { saveDir: cmd.saveDirPath } : {}),
        ...(userControlRoomLayer !== undefined ? { userControlRoomLayer } : {}),
        ...(loadedPersona !== undefined ? { persona: loadedPersona } : {}),
      });
      await runInteractiveTuiLoop(controller, io);
    } finally {
      await daemon.stop();
    }
    return 0;
  }

  let runtime: SessionRuntime;
  if (cmd.resumePath !== undefined) {
    const resumedRes = await SessionRuntime.fromSaveDirectory(cmd.resumePath, {
      sessionId: resumeSessionId,
      gateway,
      cartridge,
      ...(systemPack !== undefined ? { systemPack } : {}),
      ...(cmd.seed !== undefined ? { seed: cmd.seed } : {}),
      ...(userControlRoomLayer !== undefined ? { overrideUserLayer: userControlRoomLayer } : {}),
      ...(loadedPersona !== undefined ? { overrideUserPersona: loadedPersona } : {}),
    });
    if (!resumedRes.ok) {
      io.stderr(formatValidationErrors(resumedRes.error));
      return 1;
    }
    runtime = resumedRes.value;
  } else {
    runtime = new SessionRuntime({
      sessionId: 'cli-session-1',
      gateway,
      cartridge,
      ...(systemPack !== undefined ? { systemPack } : {}),
      ...(cmd.seed !== undefined ? { seed: cmd.seed } : {}),
      ...(cmd.saveDirPath !== undefined ? { saveDir: cmd.saveDirPath } : {}),
      ...(userControlRoomLayer !== undefined ? { userControlRoomLayer } : {}),
      ...(loadedPersona !== undefined ? { userPersona: loadedPersona } : {}),
    });
  }

  const controller = new TuiController({
    runtime,
    gateway,
    cartridge,
    ...(systemPack !== undefined ? { basePack: systemPack } : {}),
    ...(dataStore !== undefined ? { dataStore } : {}),
    ...(cmd.connectionsPath !== undefined ? { connectionsPath: cmd.connectionsPath } : {}),
  });
  await runInteractiveTuiLoop(controller, io);
  return 0;
}

function isInvokedAsMain(): boolean {
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry.length === 0) {
    return false;
  }
  try {
    const currentFile = path.resolve(fileURLToPath(import.meta.url));
    const invokedFile = path.resolve(entry);
    return process.platform === 'win32'
      ? currentFile.toLowerCase() === invokedFile.toLowerCase()
      : currentFile === invokedFile;
  } catch {
    return false;
  }
}

if (isInvokedAsMain()) {
  void runMainCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
