import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BeatLedgerState } from '../beats/beat-ledger.js';
import type { BeatStatus } from '../beats/predicate-ast.js';
import {
  type CartridgeBundle,
  isPlainObject,
  isUnsafeRecordKey,
  scanObjectForUnsafeKeys,
  validateCartridgeStructure,
} from '../cartridge/cartridge-schema.js';
import { loadCartridgeFromDirectory } from '../cartridge/loader.js';
import {
  type StaticAnalysisReport,
  analyzeCartridgeGraph,
  detectBeatCycles,
  validateCrossFileReferences,
} from '../cartridge/static-analyzer.js';
import {
  type CombatActionPreviewResult,
  previewCombatAction,
} from '../combat/action-preview.js';
import type {
  CombatState,
  CombatantState,
  ProposedCombatAction,
} from '../combat/action-validator.js';
import type { TerrainTheme } from '../combat/grid-types.js';
import type { TraditionalTurnStyle } from '../combat/traditional-theater.js';
import { type ValidationError, formatValidationErrors, validationError } from '../core/errors.js';
import { ErrorAccumulator, type Result, err, ok } from '../core/result.js';
import { MockModelProvider, createMockModelGateway } from '../gateway/mock-provider.js';
import type { DirectorSteeringInput } from '../runtime/director-steering.js';
import { SessionRuntime, type TurnExecutionResult } from '../runtime/session-runtime.js';
import type { SystemPack } from '../schema/tracker-module.js';
import type { WorldState } from '../state/world-state.js';
import type { DowntimeActivity, DowntimeOptions, TravelOptions } from '../world/flow-hooks.js';

export type SimEventStep =
  | {
      type: 'turn';
      text: string;
      combatActions?: ProposedCombatAction[];
      directorSteering?: DirectorSteeringInput;
      mockNarratorReply?: string;
      mockTrackerJson?: Record<string, unknown>;
    }
  | {
      type: 'start_combat';
      participants: CombatantState[];
      mode?: 'tactical_grid' | 'traditional';
      turnStyle?: TraditionalTurnStyle;
      theme?: TerrainTheme;
      gridSize?: { width: number; height: number };
      xpAwardOnVictory?: number;
    }
  | {
      type: 'preview';
      actorId?: string;
      action: ProposedCombatAction;
      expectLegal?: boolean;
    }
  | {
      type: 'travel';
      targetLocationId: string;
      options?: TravelOptions;
    }
  | {
      type: 'downtime';
      activity: DowntimeActivity;
      options?: DowntimeOptions;
    }
  | {
      type: 'takeover';
      canonCharacterId: string;
      name?: string;
    }
  | {
      type: 'clone';
      newSessionId?: string;
    }
  | {
      type: 'choose_branch';
      branchId: string;
    }
  | {
      type: 'confirm_patches';
      decision: 'accept_all' | 'reject_all';
    };

export interface SimExpectations {
  flags?: Record<string, boolean>;
  counters?: Record<string, number>;
  beatStatuses?: Record<string, BeatStatus>;
  activeEndingId?: string | null;
  endingStatus?: WorldState['meta']['endingStatus'];
  arc?: WorldState['meta']['arc'];
  factionInfluenceMin?: Record<string, number>;
  sceneLocation?: string;
  canonCharacterId?: string | null;
  playerFormId?: string | null;
  characterForms?: Record<string, string | null>;
  day?: number;
  combatActive?: boolean;
  combatTurnStyle?: TraditionalTurnStyle;
  combatSummonCountMin?: number;
  combatTransformedActorIds?: string[];
  previewCountMin?: number;
}

export interface SimValidateSuccess {
  report: StaticAnalysisReport;
  bundle: CartridgeBundle;
}

export interface SimPlaythroughParams {
  cartridgeDir: string;
  events: readonly SimEventStep[];
  expectations?: SimExpectations;
  seed?: string | number;
  systemPack?: SystemPack;
}

export interface SimPlaythroughSuccess {
  finalState: WorldState;
  finalBeatLedger: BeatLedgerState;
  finalCombatState: CombatState | null;
  turnResults: TurnExecutionResult[];
  previews: CombatActionPreviewResult[];
  failedAssertions: string[];
}

export type ParsedSimCliCommand =
  | {
      command: 'validate';
      cartridgeDir: string;
    }
  | {
      command: 'run';
      cartridgeDir: string;
      eventsPath: string;
      seed?: string;
      assertPath?: string;
    };

export interface SimCliIo {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

function getSafeOwn<T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  if (record === undefined || key.length === 0 || isUnsafeRecordKey(key)) {
    return undefined;
  }
  if (!Object.hasOwn(record, key)) {
    return undefined;
  }
  return Object.getOwnPropertyDescriptor(record, key)?.value as T | undefined;
}

function setSafeOwn<T>(record: Record<string, T>, key: string, value: T): void {
  if (key.length === 0 || isUnsafeRecordKey(key)) {
    return;
  }
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
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
        setSafeOwn(out, key, sanitizeJsonValue(desc.value));
      }
    }
    return out;
  }
  return value;
}

function deduplicateValidationErrors(errors: readonly ValidationError[]): ValidationError[] {
  const seen = new Set<string>();
  const unique: ValidationError[] = [];
  for (const item of errors) {
    const sig = `${item.path}\u0000${item.code}\u0000${item.message}`;
    if (!seen.has(sig)) {
      seen.add(sig);
      unique.push(item);
    }
  }
  return unique;
}

/**
 * Load and statically validate a cartridge directory, checking structure, beat DAG cycles,
 * cross-file references, and reachability/deadlock properties.
 */
export async function runSimValidateCommand(
  cartridgeDir: string
): Promise<Result<SimValidateSuccess, ValidationError[]>> {
  const loadRes = await loadCartridgeFromDirectory(cartridgeDir);
  if (!loadRes.ok) {
    return err(loadRes.error);
  }

  const bundle = loadRes.value;
  const collectedErrors: ValidationError[] = [];

  const structRes = validateCartridgeStructure(bundle);
  if (!structRes.ok) {
    collectedErrors.push(...structRes.error);
  }

  const cycleErrors = detectBeatCycles(bundle.beats);
  collectedErrors.push(...cycleErrors);

  const refErrors = validateCrossFileReferences(bundle);
  collectedErrors.push(...refErrors);

  const report = analyzeCartridgeGraph(bundle, { maxExploreStates: 4096 });
  if (!report.ok) {
    collectedErrors.push(...report.errors);
  }

  const deduped = deduplicateValidationErrors(collectedErrors);
  if (deduped.length > 0) {
    return err(deduped);
  }

  return ok({ report, bundle });
}

function evaluateSimExpectations(
  expectations: SimExpectations | undefined,
  finalState: WorldState,
  finalBeatLedger: BeatLedgerState,
  finalCombatState: CombatState | null,
  previews: readonly CombatActionPreviewResult[]
): string[] {
  const failures: string[] = [];
  if (expectations === undefined) {
    return failures;
  }

  if (expectations.flags !== undefined) {
    for (const key of Object.keys(expectations.flags)) {
      if (isUnsafeRecordKey(key)) {
        failures.push(`Unsafe flag key "${key}" in expectations`);
        continue;
      }
      const expected = getSafeOwn(expectations.flags, key);
      if (expected === undefined) {
        continue;
      }
      const actual = getSafeOwn(finalState.flags, key) ?? false;
      if (actual !== expected) {
        failures.push(`Flag "${key}": expected ${String(expected)}, got ${String(actual)}`);
      }
    }
  }

  if (expectations.counters !== undefined) {
    for (const key of Object.keys(expectations.counters)) {
      if (isUnsafeRecordKey(key)) {
        failures.push(`Unsafe counter key "${key}" in expectations`);
        continue;
      }
      const expected = getSafeOwn(expectations.counters, key);
      if (expected === undefined) {
        continue;
      }
      const actual = getSafeOwn(finalState.counters, key);
      if (actual !== expected) {
        failures.push(`Counter "${key}": expected ${String(expected)}, got ${String(actual)}`);
      }
    }
  }

  if (expectations.beatStatuses !== undefined) {
    for (const beatId of Object.keys(expectations.beatStatuses)) {
      if (isUnsafeRecordKey(beatId)) {
        failures.push(`Unsafe beatId "${beatId}" in expectations`);
        continue;
      }
      const expected = getSafeOwn(expectations.beatStatuses, beatId);
      if (expected === undefined) {
        continue;
      }
      const rec = getSafeOwn(finalBeatLedger.records, beatId);
      const actual = rec?.status;
      if (actual !== expected) {
        failures.push(
          `Beat "${beatId}" status: expected "${expected}", got "${String(actual)}"`
        );
      }
    }
  }

  if (expectations.activeEndingId !== undefined) {
    if (finalState.meta.activeEndingId !== expectations.activeEndingId) {
      failures.push(
        `meta.activeEndingId: expected ${String(expectations.activeEndingId)}, got ${String(finalState.meta.activeEndingId)}`
      );
    }
  }

  if (expectations.endingStatus !== undefined) {
    if (finalState.meta.endingStatus !== expectations.endingStatus) {
      failures.push(
        `meta.endingStatus: expected "${expectations.endingStatus}", got "${finalState.meta.endingStatus}"`
      );
    }
  }

  if (expectations.arc !== undefined) {
    if (finalState.meta.arc !== expectations.arc) {
      failures.push(`meta.arc: expected "${expectations.arc}", got "${finalState.meta.arc}"`);
    }
  }

  if (expectations.factionInfluenceMin !== undefined) {
    for (const factionId of Object.keys(expectations.factionInfluenceMin)) {
      if (isUnsafeRecordKey(factionId)) {
        failures.push(`Unsafe factionId "${factionId}" in expectations`);
        continue;
      }
      const minVal = getSafeOwn(expectations.factionInfluenceMin, factionId);
      if (minVal === undefined) {
        continue;
      }
      const faction = getSafeOwn(finalState.entities.factions, factionId);
      if (faction === undefined) {
        failures.push(`Faction "${factionId}": missing from finalState.entities.factions`);
      } else if (faction.influence < minVal) {
        failures.push(
          `Faction "${factionId}" influence: expected >= ${String(minVal)}, got ${String(faction.influence)}`
        );
      }
    }
  }

  if (expectations.sceneLocation !== undefined) {
    if (finalState.scene.location !== expectations.sceneLocation) {
      failures.push(
        `scene.location: expected "${expectations.sceneLocation}", got "${finalState.scene.location}"`
      );
    }
  }

  if (expectations.canonCharacterId !== undefined) {
    if (finalState.player.canonCharacterId !== expectations.canonCharacterId) {
      failures.push(
        `player.canonCharacterId: expected ${String(expectations.canonCharacterId)}, got ${String(finalState.player.canonCharacterId)}`
      );
    }
  }

  if (expectations.playerFormId !== undefined) {
    const canonId = finalState.player.canonCharacterId ?? finalState.player.characterId;
    const actualFormId =
      canonId !== null && canonId !== undefined
        ? getSafeOwn(finalState.entities.characters, canonId)?.formId ?? null
        : null;
    if (actualFormId !== expectations.playerFormId) {
      failures.push(
        `playerFormId: expected ${String(expectations.playerFormId)}, got ${String(actualFormId)}`
      );
    }
  }

  if (expectations.characterForms !== undefined) {
    for (const charId of Object.keys(expectations.characterForms)) {
      if (isUnsafeRecordKey(charId)) {
        failures.push(`Unsafe characterId "${charId}" in expectations.characterForms`);
        continue;
      }
      const expected = getSafeOwn(expectations.characterForms, charId);
      const actual = getSafeOwn(finalState.entities.characters, charId)?.formId ?? null;
      if (actual !== expected) {
        failures.push(
          `Character "${charId}" formId: expected ${String(expected)}, got ${String(actual)}`
        );
      }
    }
  }

  if (expectations.day !== undefined) {
    if (finalState.clocks.day !== expectations.day) {
      failures.push(`clocks.day: expected ${String(expectations.day)}, got ${String(finalState.clocks.day)}`);
    }
  }

  if (expectations.combatActive !== undefined) {
    const isActive = Boolean(finalCombatState?.active);
    if (isActive !== expectations.combatActive) {
      failures.push(
        `combatActive: expected ${String(expectations.combatActive)}, got ${String(isActive)}`
      );
    }
  }

  if (expectations.combatTurnStyle !== undefined) {
    if (finalCombatState?.turnStyle !== expectations.combatTurnStyle) {
      failures.push(
        `combatTurnStyle: expected "${expectations.combatTurnStyle}", got "${String(finalCombatState?.turnStyle)}"`
      );
    }
  }

  if (expectations.combatSummonCountMin !== undefined) {
    const summonCount = finalCombatState
      ? Object.values(finalCombatState.combatants).filter((c) => c.isSummon === true && c.alive).length
      : 0;
    if (summonCount < expectations.combatSummonCountMin) {
      failures.push(
        `combatSummonCountMin: expected >= ${String(expectations.combatSummonCountMin)}, got ${String(summonCount)}`
      );
    }
  }

  if (expectations.combatTransformedActorIds !== undefined) {
    for (const actorId of expectations.combatTransformedActorIds) {
      const actor = finalCombatState ? getSafeOwn(finalCombatState.combatants, actorId) : undefined;
      if (!actor || actor.activeTransform === undefined) {
        failures.push(`combatTransformedActorIds: actor "${actorId}" has no activeTransform`);
      }
    }
  }

  if (expectations.previewCountMin !== undefined) {
    if (previews.length < expectations.previewCountMin) {
      failures.push(
        `previewCountMin: expected >= ${String(expectations.previewCountMin)}, got ${String(previews.length)}`
      );
    }
  }

  return failures;
}

/**
 * Execute a deterministic offline playthrough of a cartridge using {@link SessionRuntime}
 * and {@link MockModelGateway}, then verify any provided {@link SimExpectations}.
 */
export async function runSimPlaythroughCommand(
  params: SimPlaythroughParams
): Promise<Result<SimPlaythroughSuccess, ValidationError[]>> {
  const loadRes = await loadCartridgeFromDirectory(params.cartridgeDir);
  if (!loadRes.ok) {
    return err(loadRes.error);
  }

  const bundle = loadRes.value;
  let currentNarratorReply = 'The scene unfolds.';
  let currentTrackerJson: Record<string, unknown> = {};

  const provider = new MockModelProvider({
    handlers: {
      narrator: () => ({
        kind: 'text',
        text: currentNarratorReply,
      }),
      state_tracker: () => ({
        kind: 'json',
        value: currentTrackerJson,
      }),
      chronicle_router: () => ({
        kind: 'json',
        value: {
          shouldRecord: false,
          category: 'event',
          title: 'Scene Milestone',
          summary: 'The scene progresses.',
          keywords: [],
          involvedEntityIds: [],
        },
      }),
      combat_agent: () => ({
        kind: 'json',
        value: {
          actions: [],
        },
      }),
    },
  });

  const gateway = createMockModelGateway(provider);
  const seed = params.seed ?? `sim-${bundle.card.id}`;

  let runtime: SessionRuntime;
  try {
    runtime = new SessionRuntime({
      sessionId: `sim-${bundle.card.id}`,
      cartridge: bundle,
      ...(params.systemPack !== undefined ? { systemPack: params.systemPack } : {}),
      gateway,
      seed,
    });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    return err([validationError('runtime', 'RUNTIME_INIT_ERROR', message)]);
  }

  const turnResults: TurnExecutionResult[] = [];
  const previews: CombatActionPreviewResult[] = [];

  for (let i = 0; i < params.events.length; i += 1) {
    const step = params.events[i];
    if (step === undefined) {
      continue;
    }

    switch (step.type) {
      case 'turn': {
        currentNarratorReply = step.mockNarratorReply ?? 'The scene unfolds.';
        currentTrackerJson = step.mockTrackerJson ?? {};
        const turnRes = await runtime.executeTurn({
          text: step.text,
          ...(step.combatActions !== undefined ? { combatActions: step.combatActions } : {}),
          ...(step.directorSteering !== undefined
            ? { directorSteering: step.directorSteering }
            : {}),
        });
        if (!turnRes.ok) {
          return err(turnRes.error);
        }
        turnResults.push(turnRes.value);
        break;
      }

      case 'start_combat': {
        const combatRes = runtime.startCombat(step.participants, {
          ...(step.mode !== undefined ? { mode: step.mode } : {}),
          ...(step.turnStyle !== undefined ? { turnStyle: step.turnStyle } : {}),
          ...(step.theme !== undefined ? { theme: step.theme } : {}),
          ...(step.gridSize !== undefined ? { gridSize: step.gridSize } : {}),
          ...(step.xpAwardOnVictory !== undefined ? { xpAwardOnVictory: step.xpAwardOnVictory } : {}),
        });
        if (!combatRes.ok) {
          return err(combatRes.error);
        }
        break;
      }

      case 'preview': {
        const combatState = runtime.getCombatState();
        if (combatState === null || !combatState.active) {
          return err([
            validationError(
              `events[${i}]`,
              'NO_ACTIVE_COMBAT',
              'Cannot preview combat action when no combat encounter is active'
            ),
          ]);
        }
        const actorId =
          step.actorId ??
          combatState.initiativeOrder[combatState.turnIndex] ??
          runtime.getState().player.id;
        const previewRes = previewCombatAction(
          combatState,
          actorId,
          step.action,
          runtime.getSkillRegistry(),
          {
            ...(bundle.combat?.summons !== undefined ? { summons: bundle.combat.summons } : {}),
            ...(bundle.combat?.formLoadouts !== undefined
              ? { formLoadouts: bundle.combat.formLoadouts }
              : {}),
            ...(bundle.combat?.effectTemplates !== undefined
              ? { effectTemplates: bundle.combat.effectTemplates }
              : {}),
          }
        );
        previews.push(previewRes);
        if (step.expectLegal !== undefined && previewRes.legal !== step.expectLegal) {
          return err([
            validationError(
              `events[${i}].expectLegal`,
              'PREVIEW_LEGALITY_MISMATCH',
              `Preview legality mismatch: expected ${String(step.expectLegal)}, got ${String(previewRes.legal)}`
            ),
          ]);
        }
        break;
      }

      case 'travel': {
        const travelRes = runtime.travel(step.targetLocationId, step.options);
        if (!travelRes.ok) {
          return err(travelRes.error);
        }
        break;
      }

      case 'downtime': {
        const downtimeRes = runtime.downtime(step.activity, step.options);
        if (!downtimeRes.ok) {
          return err(downtimeRes.error);
        }
        break;
      }

      case 'takeover': {
        const bindRes = runtime.updatePlayerBinding({
          canonCharacterId: step.canonCharacterId,
          ...(step.name !== undefined ? { name: step.name } : {}),
        });
        if (!bindRes.ok) {
          return err(bindRes.error);
        }
        break;
      }

      case 'clone': {
        const clonedRuntime = new SessionRuntime({
          sessionId: step.newSessionId ?? `${runtime.getState().meta.sessionId}-clone-${i}`,
          cartridge: bundle,
          ...(params.systemPack !== undefined ? { systemPack: params.systemPack } : {}),
          gateway,
          seed,
        });
        clonedRuntime.restoreSnapshot({
          state: runtime.getState(),
          beatLedger: runtime.getBeatLedger(),
          swipeTree: runtime.getSwipeTree(),
          combatState: runtime.getCombatState(),
        });
        runtime = clonedRuntime;
        break;
      }

      case 'choose_branch': {
        const branchRes = runtime.choosePostEndingBranch(step.branchId);
        if (!branchRes.ok) {
          return err(branchRes.error);
        }
        break;
      }

      case 'confirm_patches': {
        const confirmRes = runtime.confirmPendingPatches(step.decision);
        if (!confirmRes.ok) {
          return err(confirmRes.error);
        }
        break;
      }

      default: {
        return err([
          validationError(
            `events[${i}].type`,
            'UNKNOWN_EVENT_TYPE',
            `Unsupported SimEventStep type "${String((step as { type?: unknown }).type)}"`
          ),
        ]);
      }
    }
  }

  const finalState = runtime.getState();
  const finalBeatLedger = runtime.getBeatLedger();
  const finalCombatState = runtime.getCombatState();
  const failedAssertions = evaluateSimExpectations(
    params.expectations,
    finalState,
    finalBeatLedger,
    finalCombatState,
    previews
  );

  return ok({
    finalState,
    finalBeatLedger,
    finalCombatState,
    turnResults,
    previews,
    failedAssertions,
  });
}

/**
 * Parse CLI arguments for `referee sim` (`validate` and `run` subcommands).
 */
export function parseSimCliArgs(
  argv: readonly string[]
): Result<ParsedSimCliCommand, ValidationError[]> {
  if (argv.length === 0) {
    return err([
      validationError(
        'argv',
        'MISSING_SUBCOMMAND',
        'Expected subcommand "validate" or "run"'
      ),
    ]);
  }

  const subcommand = argv[0];
  if (subcommand !== 'validate' && subcommand !== 'run') {
    return err([
      validationError(
        'argv[0]',
        'UNKNOWN_SUBCOMMAND',
        `Unknown subcommand "${String(subcommand)}"; expected "validate" or "run"`
      ),
    ]);
  }

  let cartridgeDir: string | undefined;
  let eventsPath: string | undefined;
  let seed: string | undefined;
  let assertPath: string | undefined;

  for (let i = 1; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--cartridge') {
      const val = argv[i + 1];
      if (typeof val !== 'string' || val.trim().length === 0 || val.startsWith('--')) {
        return err([validationError('--cartridge', 'MISSING_VALUE', '--cartridge requires a path')]);
      }
      cartridgeDir = val;
      i += 1;
      continue;
    }

    if (flag === '--events') {
      const val = argv[i + 1];
      if (typeof val !== 'string' || val.trim().length === 0 || val.startsWith('--')) {
        return err([validationError('--events', 'MISSING_VALUE', '--events requires a file path')]);
      }
      eventsPath = val;
      i += 1;
      continue;
    }

    if (flag === '--seed') {
      const val = argv[i + 1];
      if (typeof val !== 'string' || val.trim().length === 0 || val.startsWith('--')) {
        return err([validationError('--seed', 'MISSING_VALUE', '--seed requires a value')]);
      }
      seed = val;
      i += 1;
      continue;
    }

    if (flag === '--assert') {
      const val = argv[i + 1];
      if (typeof val !== 'string' || val.trim().length === 0 || val.startsWith('--')) {
        return err([validationError('--assert', 'MISSING_VALUE', '--assert requires a file path')]);
      }
      assertPath = val;
      i += 1;
      continue;
    }

    return err([
      validationError(`argv[${i}]`, 'UNKNOWN_FLAG', `Unknown CLI argument "${String(flag)}"`),
    ]);
  }

  if (cartridgeDir === undefined) {
    return err([
      validationError('--cartridge', 'REQUIRED', 'Missing required --cartridge <path> argument'),
    ]);
  }

  if (subcommand === 'validate') {
    if (eventsPath !== undefined || seed !== undefined || assertPath !== undefined) {
      return err([
        validationError(
          'argv',
          'UNEXPECTED_FLAGS',
          'validate subcommand accepts only --cartridge <path>'
        ),
      ]);
    }
    return ok({
      command: 'validate',
      cartridgeDir,
    });
  }

  if (eventsPath === undefined) {
    return err([
      validationError('--events', 'REQUIRED', 'run subcommand requires --events <events.jsonl>'),
    ]);
  }

  return ok({
    command: 'run',
    cartridgeDir,
    eventsPath,
    ...(seed !== undefined ? { seed } : {}),
    ...(assertPath !== undefined ? { assertPath } : {}),
  });
}

async function readEventsJsonlFile(
  filePath: string
): Promise<Result<SimEventStep[], ValidationError[]>> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return err([validationError('--events', 'FILE_READ_ERROR', `Failed to read "${filePath}": ${msg}`)]);
  }

  const events: SimEventStep[] = [];
  const acc = new ErrorAccumulator('events');
  const lines = raw.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i]?.trim() ?? '';
    if (trimmed.length === 0) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Malformed JSON';
      acc.add(`line[${i + 1}]`, 'INVALID_JSON', `Invalid JSON on line ${i + 1}: ${msg}`);
      continue;
    }
    const lineAcc = acc.scope(`line[${i + 1}]`);
    scanObjectForUnsafeKeys(parsed, lineAcc);
    if (!isPlainObject(parsed) || typeof parsed['type'] !== 'string') {
      lineAcc.add('', 'INVALID_EVENT_STEP', `Line ${i + 1} must be a JSON object with string "type"`);
      continue;
    }
    events.push(sanitizeJsonValue(parsed) as SimEventStep);
  }

  if (acc.hasErrors()) {
    return err([...acc.errors]);
  }
  return ok(events);
}

async function readExpectationsFile(
  filePath: string
): Promise<Result<SimExpectations, ValidationError[]>> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return err([validationError('--assert', 'FILE_READ_ERROR', `Failed to read "${filePath}": ${msg}`)]);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Malformed JSON';
    return err([validationError('--assert', 'INVALID_JSON', `Invalid JSON in "${filePath}": ${msg}`)]);
  }

  const acc = new ErrorAccumulator('expectations');
  scanObjectForUnsafeKeys(parsed, acc);
  if (!isPlainObject(parsed)) {
    acc.add('', 'INVALID_TYPE', 'Expectations file must contain a JSON object');
  }
  if (acc.hasErrors()) {
    return err([...acc.errors]);
  }

  return ok(sanitizeJsonValue(parsed) as SimExpectations);
}

/**
 * CLI entrypoint for `referee sim` supporting `validate` and `run` commands.
 * Returns `0` on success or `1` on validation, runtime, or assertion failures.
 */
export async function runSimCli(
  argv: readonly string[],
  io: SimCliIo = {
    stdout: (s) => process.stdout.write(`${s}\n`),
    stderr: (s) => process.stderr.write(`${s}\n`),
  }
): Promise<number> {
  const parsedArgs = parseSimCliArgs(argv);
  if (!parsedArgs.ok) {
    io.stderr(formatValidationErrors(parsedArgs.error));
    return 1;
  }

  const cmd = parsedArgs.value;
  if (cmd.command === 'validate') {
    const valRes = await runSimValidateCommand(cmd.cartridgeDir);
    if (!valRes.ok) {
      io.stderr(formatValidationErrors(valRes.error));
      return 1;
    }
    const { report, bundle } = valRes.value;
    io.stdout(
      JSON.stringify({
        ok: report.ok,
        cartridgeId: bundle.card.id,
        reachableBeatIds: report.reachableBeatIds,
        unreachableBeatIds: report.unreachableBeatIds,
        reachableEndingIds: report.reachableEndingIds,
        unreachableEndingIds: report.unreachableEndingIds,
        deadlockStatesDetected: report.deadlockStatesDetected,
        warnings: report.warnings,
      })
    );
    return 0;
  }

  const eventsRes = await readEventsJsonlFile(cmd.eventsPath);
  if (!eventsRes.ok) {
    io.stderr(formatValidationErrors(eventsRes.error));
    return 1;
  }

  let expectations: SimExpectations | undefined;
  if (cmd.assertPath !== undefined) {
    const expRes = await readExpectationsFile(cmd.assertPath);
    if (!expRes.ok) {
      io.stderr(formatValidationErrors(expRes.error));
      return 1;
    }
    expectations = expRes.value;
  }

  const playRes = await runSimPlaythroughCommand({
    cartridgeDir: cmd.cartridgeDir,
    events: eventsRes.value,
    ...(expectations !== undefined ? { expectations } : {}),
    ...(cmd.seed !== undefined ? { seed: cmd.seed } : {}),
  });

  if (!playRes.ok) {
    io.stderr(formatValidationErrors(playRes.error));
    return 1;
  }

  const { finalState, turnResults, failedAssertions } = playRes.value;
  if (failedAssertions.length > 0) {
    io.stderr(`Assertion failures (${failedAssertions.length}):\n${failedAssertions.join('\n')}`);
    return 1;
  }

  io.stdout(
    JSON.stringify({
      ok: true,
      turnsExecuted: turnResults.length,
      finalTurn: finalState.meta.turn,
      activeEndingId: finalState.meta.activeEndingId,
      endingStatus: finalState.meta.endingStatus,
      arc: finalState.meta.arc,
      sceneLocation: finalState.scene.location,
    })
  );
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
  void runSimCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
