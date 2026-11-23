import { readFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import type { CartridgeBundle } from '../cartridge/cartridge-schema.js';
import { importSillyTavernCard } from '../cartridge/importers/st-card-importer.js';
import { loadCartridgeFromDirectory } from '../cartridge/loader.js';
import { type ValidationError, formatValidationErrors, validationError } from '../core/errors.js';
import { ErrorAccumulator, type Result, err, ok } from '../core/result.js';
import { ModelGateway } from '../gateway/model-gateway.js';
import type { AgentRole, RoleConnectionConfig } from '../gateway/types.js';
import { SessionRuntime } from '../runtime/session-runtime.js';
import { STOCK_FREEFORM_PACK, getStockSystemPack } from '../schema/stock-system-packs.js';
import type { SystemPack } from '../schema/tracker-module.js';
import { RefereeDaemon } from '../server/daemon.js';
import { TuiController, type TuiViewport } from '../tui/app.js';
import { runSimCli } from './sim-cli.js';

export interface CliConnectionOptions {
  readonly baseUrl?: string;
  readonly model?: string;
  readonly apiKey?: string;
  readonly trackerModel?: string;
  readonly connectionsPath?: string;
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
    let baseUrl: string | undefined;
    let model: string | undefined;
    let apiKey: string | undefined;
    let trackerModel: string | undefined;
    let connectionsPath: string | undefined;
    const acc = new ErrorAccumulator('daemon');

    for (let i = 1; i < argv.length; i += 1) {
      const token = argv[i];
      if (token === '--host') {
        const val = argv[i + 1];
        if (val === undefined || val.startsWith('--')) {
          acc.add('--host', 'REQUIRED', '--host requires a hostname or IP');
        } else {
          host = val;
          i += 1;
        }
      } else if (token === '--port') {
        const portRes = parsePortOption(argv[i + 1], '--port');
        if (!portRes.ok) {
          acc.addAll(portRes.error);
        } else {
          port = portRes.value;
          i += 1;
        }
      } else if (token === '--data-dir') {
        const val = argv[i + 1];
        if (val === undefined || val.startsWith('--')) {
          acc.add('--data-dir', 'REQUIRED', '--data-dir requires a directory path');
        } else {
          dataDir = val;
          i += 1;
        }
      } else if (token === '--base-url') {
        const val = argv[i + 1];
        if (val === undefined || val.startsWith('--')) {
          acc.add('--base-url', 'REQUIRED', '--base-url requires an endpoint URL');
        } else {
          baseUrl = val;
          i += 1;
        }
      } else if (token === '--model') {
        const val = argv[i + 1];
        if (val === undefined || val.startsWith('--')) {
          acc.add('--model', 'REQUIRED', '--model requires a model identifier');
        } else {
          model = val;
          i += 1;
        }
      } else if (token === '--api-key') {
        const val = argv[i + 1];
        if (val === undefined || val.startsWith('--')) {
          acc.add('--api-key', 'REQUIRED', '--api-key requires an API key value');
        } else {
          apiKey = val;
          i += 1;
        }
      } else if (token === '--tracker-model') {
        const val = argv[i + 1];
        if (val === undefined || val.startsWith('--')) {
          acc.add('--tracker-model', 'REQUIRED', '--tracker-model requires a model identifier');
        } else {
          trackerModel = val;
          i += 1;
        }
      } else if (token === '--connections') {
        const val = argv[i + 1];
        if (val === undefined || val.startsWith('--')) {
          acc.add('--connections', 'REQUIRED', '--connections requires a JSON file path');
        } else {
          connectionsPath = val;
          i += 1;
        }
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
      const val = argv[i + 1];
      if (val === undefined || val.startsWith('--')) {
        acc.add('--card', 'REQUIRED', '--card requires a file path');
      } else {
        cardPath = val;
        i += 1;
      }
    } else if (token === '--cartridge') {
      const val = argv[i + 1];
      if (val === undefined || val.startsWith('--')) {
        acc.add('--cartridge', 'REQUIRED', '--cartridge requires a directory path');
      } else {
        cartridgePath = val;
        i += 1;
      }
    } else if (token === '--pack') {
      const val = argv[i + 1];
      if (val === undefined || val.startsWith('--')) {
        acc.add('--pack', 'REQUIRED', '--pack requires a System Pack ID');
      } else {
        packId = val;
        i += 1;
      }
    } else if (token === '--port') {
      const portRes = parsePortOption(argv[i + 1], '--port');
      if (!portRes.ok) {
        acc.addAll(portRes.error);
      } else {
        port = portRes.value;
        i += 1;
      }
    } else if (token === '--seed') {
      const val = argv[i + 1];
      if (val === undefined || val.startsWith('--')) {
        acc.add('--seed', 'REQUIRED', '--seed requires a seed string');
      } else {
        seed = val;
        i += 1;
      }
    } else if (token === '--base-url') {
      const val = argv[i + 1];
      if (val === undefined || val.startsWith('--')) {
        acc.add('--base-url', 'REQUIRED', '--base-url requires an endpoint URL');
      } else {
        baseUrl = val;
        i += 1;
      }
    } else if (token === '--model') {
      const val = argv[i + 1];
      if (val === undefined || val.startsWith('--')) {
        acc.add('--model', 'REQUIRED', '--model requires a model identifier');
      } else {
        model = val;
        i += 1;
      }
    } else if (token === '--api-key') {
      const val = argv[i + 1];
      if (val === undefined || val.startsWith('--')) {
        acc.add('--api-key', 'REQUIRED', '--api-key requires an API key value');
      } else {
        apiKey = val;
        i += 1;
      }
    } else if (token === '--tracker-model') {
      const val = argv[i + 1];
      if (val === undefined || val.startsWith('--')) {
        acc.add('--tracker-model', 'REQUIRED', '--tracker-model requires a model identifier');
      } else {
        trackerModel = val;
        i += 1;
      }
    } else if (token === '--connections') {
      const val = argv[i + 1];
      if (val === undefined || val.startsWith('--')) {
        acc.add('--connections', 'REQUIRED', '--connections requires a JSON file path');
      } else {
        connectionsPath = val;
        i += 1;
      }
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
    '  referee play [--freeform] [--card <path>] [--cartridge <path>] [--pack <id>] [--base-url <url>] [--model <id>] [--api-key <key>] [--tracker-model <id>] [--connections <json>] [--daemon] [--port <n>] [--seed <seed>]',
    '  referee sim <validate|run> ...',
    '  referee daemon [--host <host>] [--port <n>] [--data-dir <path>] [--base-url <url>] [--model <id>] [--api-key <key>] [--tracker-model <id>] [--connections <json>]',
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

  const draw = (): void => {
    const viewport = getTerminalViewport();
    const frame = controller.renderScreen(viewport);
    if (process.stdout.isTTY) {
      process.stdout.write(`\x1b[2J\x1b[H${frame}\n`);
    } else {
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
      const res = await controller.handleInput(line);
      for (const outLine of res.outputLines) {
        io.stdout(outLine);
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

const VALID_AGENT_ROLES: ReadonlySet<AgentRole> = new Set<AgentRole>([
  'narrator',
  'intent_parser',
  'combat_agent',
  'state_tracker',
  'storyline_planner',
  'cast_director',
  'chronicle_router',
  'game_system_wizard',
]);

/**
 * Construct a {@link ModelGateway} from optional `referee.connections.json`,
 * environment variables (`REFEREE_BASE_URL` / `OPENAI_BASE_URL`, `REFEREE_MODEL` / `OPENAI_MODEL`,
 * `REFEREE_API_KEY` / `OPENAI_API_KEY`, `REFEREE_TRACKER_MODEL`), and CLI flags.
 */
export async function buildCliModelGateway(
  options: CliConnectionOptions = {},
  env: NodeJS.ProcessEnv = process.env
): Promise<Result<ModelGateway, ValidationError[]>> {
  const gateway = new ModelGateway();

  // 1. Load JSON file if --connections was given or ./referee.connections.json exists
  const filePath = options.connectionsPath ?? path.resolve('referee.connections.json');
  let rawJsonText: string | undefined;
  try {
    rawJsonText = await readFile(filePath, 'utf-8');
  } catch (caught) {
    if (options.connectionsPath !== undefined) {
      const msg = caught instanceof Error ? caught.message : 'Unable to read connections file';
      return err([validationError('--connections', 'READ_FAILED', msg)]);
    }
  }

  if (rawJsonText !== undefined) {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawJsonText) as unknown;
    } catch (caught) {
      const msg = caught instanceof Error ? caught.message : 'Invalid JSON';
      return err([validationError('--connections', 'INVALID_JSON', msg)]);
    }
    if (typeof parsedJson === 'object' && parsedJson !== null && !Array.isArray(parsedJson)) {
      const root = parsedJson as Record<string, unknown>;
      const def = root.defaultConnection;
      if (typeof def === 'object' && def !== null && !Array.isArray(def)) {
        const d = def as Record<string, unknown>;
        if (typeof d.baseUrl === 'string' && typeof d.model === 'string') {
          gateway.setDefaultConnection({
            provider: 'openai_compatible',
            baseUrl: d.baseUrl,
            model: d.model,
            ...(typeof d.apiKey === 'string' ? { apiKey: d.apiKey } : {}),
            ...(typeof d.temperature === 'number' ? { temperature: d.temperature } : {}),
            ...(typeof d.maxTokens === 'number' ? { maxTokens: d.maxTokens } : {}),
          });
        }
      }
      const conns = root.connections;
      if (typeof conns === 'object' && conns !== null && !Array.isArray(conns)) {
        const cMap = conns as Record<string, unknown>;
        for (const role of VALID_AGENT_ROLES) {
          const entry = cMap[role];
          if (typeof entry === 'object' && entry !== null && !Array.isArray(entry)) {
            const e = entry as Record<string, unknown>;
            if (typeof e.baseUrl === 'string' && typeof e.model === 'string') {
              const roleCfg: Omit<RoleConnectionConfig, 'role'> = {
                provider: 'openai_compatible',
                baseUrl: e.baseUrl,
                model: e.model,
                ...(typeof e.apiKey === 'string' ? { apiKey: e.apiKey } : {}),
                ...(typeof e.temperature === 'number' ? { temperature: e.temperature } : {}),
                ...(typeof e.maxTokens === 'number' ? { maxTokens: e.maxTokens } : {}),
              };
              gateway.setRoleConnection(role, roleCfg);
            }
          }
        }
      }
    }
  }

  // 2. Environment variables + CLI flag overrides
  const existingDefault = gateway.getConnectionsSnapshot().defaultConnection;
  const baseUrl =
    options.baseUrl ??
    env.REFEREE_BASE_URL ??
    env.OPENAI_BASE_URL ??
    existingDefault?.baseUrl;
  const model =
    options.model ??
    env.REFEREE_MODEL ??
    env.OPENAI_MODEL ??
    existingDefault?.model;
  const apiKey =
    options.apiKey ??
    env.REFEREE_API_KEY ??
    env.OPENAI_API_KEY ??
    existingDefault?.apiKey;

  if (baseUrl !== undefined && model !== undefined) {
    gateway.setDefaultConnection({
      provider: 'openai_compatible',
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
      gateway.setRoleConnection(r, {
        provider: 'openai_compatible',
        baseUrl,
        model: trackerModel,
        ...(apiKey !== undefined ? { apiKey } : {}),
      });
    }
  }

  return ok(gateway);
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
    });
    const info = await daemon.start();
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

  const inputsRes = await loadPlaySessionInputs({
    freeform: cmd.freeform,
    ...(cmd.cardPath !== undefined ? { cardPath: cmd.cardPath } : {}),
    ...(cmd.cartridgePath !== undefined ? { cartridgePath: cmd.cartridgePath } : {}),
    ...(cmd.packId !== undefined ? { packId: cmd.packId } : {}),
  });
  if (!inputsRes.ok) {
    io.stderr(formatValidationErrors(inputsRes.error));
    return 1;
  }

  const { cartridge, systemPack } = inputsRes.value;

  if (cmd.daemon) {
    const daemon = new RefereeDaemon({
      host: '127.0.0.1',
      port: cmd.port,
      gateway,
    });
    const info = await daemon.start();
    const registry = daemon.getRegistry();

    let cartridgeId: string | undefined;
    if (cartridge !== null) {
      registry.cartridges.set(cartridge.card.id, cartridge);
      cartridgeId = cartridge.card.id;
    }

    const controller = new TuiController({
      daemonUrl: info.url,
      cartridge,
      ...(systemPack !== undefined ? { basePack: systemPack } : {}),
    });
    try {
      await controller.connectDaemonSession({
        ...(systemPack !== undefined ? { systemPackId: systemPack.id } : {}),
        ...(cartridgeId !== undefined ? { cartridgeId } : {}),
        ...(cmd.seed !== undefined ? { seed: cmd.seed } : {}),
      });
      await runInteractiveTuiLoop(controller, io);
    } finally {
      await daemon.stop();
    }
    return 0;
  }

  const runtime = new SessionRuntime({
    sessionId: 'cli-session-1',
    gateway,
    cartridge,
    ...(systemPack !== undefined ? { systemPack } : {}),
    ...(cmd.seed !== undefined ? { seed: cmd.seed } : {}),
  });

  const controller = new TuiController({
    runtime,
    gateway,
    cartridge,
    ...(systemPack !== undefined ? { basePack: systemPack } : {}),
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
