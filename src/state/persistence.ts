/// <reference types="node" />
import type { Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { type ControlRoomLayer, cloneControlRoomLayer } from '../config/control-room-config.js';
import { type UserPersonaPreset, validateUserPersonaPreset } from '../config/persona-preset.js';
import { type ValidationError, validationError } from '../core/errors.js';
import { ErrorAccumulator, type Result, err, ok } from '../core/result.js';
import {
  type CharacterSectionDef,
  validateCharacterSectionList,
} from '../schema/character-sections.js';
import {
  type ConfirmPolicy,
  type GameSystemModule,
  validateConfirmPolicy,
  validateGameSystemModule,
} from '../schema/tracker-module.js';
import type { AuditEntry } from './audit-log.js';
import { CURRENT_STATE_SCHEMA_VERSION, migrateWorldStateDocument } from './migrations.js';
import { PATCH_SOURCES } from './patch.js';
import { type EventLogRecord, replayFromEvents } from './replay.js';
import {
  type StateCheckpoint,
  type SwipeTreeState,
  type TranscriptMessageNode,
  computeStateHash,
  getLinearTranscript,
  validateSwipeTreeState,
} from './swipe-tree.js';
import { type WorldState, validateWorldState } from './world-state.js';

export type { EventLogRecord } from './replay.js';

export interface SaveManifest {
  sessionId: string;
  cartridgeId: string;
  systemPackId: string;
  schemaVersion: number;
  currentTurn: number;
  parentSaveId: string | null;
  branchAtTurn: number | null;
  checkpointInterval: number;
}

export interface InitSaveManifestInput {
  sessionId: string;
  cartridgeId: string;
  systemPackId: string;
  schemaVersion?: number;
  currentTurn?: number;
  parentSaveId?: string | null;
  branchAtTurn?: number | null;
  checkpointInterval?: number;
}

export interface InitSaveOptions {
  worldState?: WorldState;
  beatLedger?: Record<string, unknown>;
  combatState?: Record<string, unknown> | null;
  swipeTree?: SwipeTreeState;
  userControlRoomLayer?: ControlRoomLayer;
  activePersona?: UserPersonaPreset | null;
}

export interface CheckpointSnapshot {
  turn: number;
  worldState: WorldState;
  beatLedger: Record<string, unknown>;
  stateHash: string;
  combatState?: Record<string, unknown> | null;
}

export interface LoadedSessionSave {
  manifest: SaveManifest;
  latestCheckpoint: CheckpointSnapshot | null;
  checkpoints: CheckpointSnapshot[];
  events: EventLogRecord[];
  auditEntries: AuditEntry[];
  swipeTree: SwipeTreeState | null;
  userControlRoomLayer?: ControlRoomLayer | null;
  activePersona?: UserPersonaPreset | null;
  recoveredPartialLines: {
    events: boolean;
    audit: boolean;
  };
}

const DEFAULT_CHECKPOINT_INTERVAL = 25;
const CHECKPOINT_FILENAME_PATTERN = /^turn-(\d+)\.snapshot\.json$/;
const VALID_PATCH_SOURCES: ReadonlySet<string> = new Set(PATCH_SOURCES);
const VALID_AUDIT_STATUSES: ReadonlySet<string> = new Set([
  'committed',
  'rejected',
  'pending_confirmation',
]);
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

function isSafeKey(key: string): boolean {
  return key.length > 0 && !FORBIDDEN_KEYS.has(key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

function getOwn(obj: Record<string, unknown>, key: string): unknown {
  if (!isSafeKey(key) || !Object.hasOwn(obj, key)) {
    return undefined;
  }
  return Object.getOwnPropertyDescriptor(obj, key)?.value;
}

function setOwn<T>(obj: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(obj, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function containsForbiddenKeys(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsForbiddenKeys);
  }
  if (value !== null && typeof value === 'object') {
    for (const key of Object.getOwnPropertyNames(value)) {
      if (!isSafeKey(key)) {
        return true;
      }
      const child = Object.getOwnPropertyDescriptor(value, key)?.value;
      if (containsForbiddenKeys(child)) {
        return true;
      }
    }
  }
  return false;
}

function cloneJsonSafeValue(value: unknown, pathLabel: string): Result<unknown, ValidationError[]> {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return ok(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return err([
        validationError(pathLabel, 'INVALID_NUMBER', `${pathLabel} must be a finite JSON-safe number`),
      ]);
    }
    return ok(value === 0 ? 0 : value);
  }
  if (Array.isArray(value)) {
    const arr: unknown[] = [];
    for (let i = 0; i < value.length; i += 1) {
      const rawItem = value[i];
      if (rawItem === undefined) {
        return err([
          validationError(`${pathLabel}[${i}]`, 'INVALID_TYPE', `${pathLabel}[${i}] must be JSON-safe`),
        ]);
      }
      const itemRes = cloneJsonSafeValue(rawItem, `${pathLabel}[${i}]`);
      if (!itemRes.ok) {
        return itemRes;
      }
      arr.push(itemRes.value);
    }
    return ok(arr);
  }
  if (typeof value === 'object') {
    if (!isPlainObject(value)) {
      return err([
        validationError(pathLabel, 'INVALID_TYPE', `${pathLabel} must be a plain JSON-safe object`),
      ]);
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.getOwnPropertyNames(value)) {
      if (!isSafeKey(key)) {
        return err([
          validationError(`${pathLabel}.${key}`, 'UNSAFE_KEY', `Forbidden key "${key}" at ${pathLabel}`),
        ]);
      }
      const rawChild = Object.getOwnPropertyDescriptor(value, key)?.value;
      if (rawChild === undefined) {
        continue;
      }
      const childRes = cloneJsonSafeValue(rawChild, `${pathLabel}.${key}`);
      if (!childRes.ok) {
        return childRes;
      }
      setOwn(out, key, childRes.value);
    }
    return ok(out);
  }
  return err([
    validationError(
      pathLabel,
      'INVALID_TYPE',
      `${pathLabel} must be a JSON-safe value (got ${typeof value})`
    ),
  ]);
}

function validateCombatStateField(
  combatState: unknown,
  pathLabel: string
): Result<Record<string, unknown> | null | undefined, ValidationError[]> {
  if (combatState === undefined) {
    return ok(undefined);
  }
  if (combatState === null) {
    return ok(null);
  }
  if (!isPlainObject(combatState)) {
    return err([
      validationError(
        pathLabel,
        'INVALID_TYPE',
        `${pathLabel} must be a safe plain object, null, or undefined`
      ),
    ]);
  }
  const cloned = cloneJsonSafeValue(combatState, pathLabel);
  if (!cloned.ok) {
    return cloned;
  }
  return ok(cloned.value as Record<string, unknown>);
}

const GENERATION_NUMERIC_FIELD_KEYS = [
  'temperature',
  'maxTokens',
  'maxContextTokens',
  'topP',
  'topK',
  'minP',
  'topA',
  'typicalP',
  'tfs',
  'frequencyPenalty',
  'presencePenalty',
  'repetitionPenalty',
  'seed',
] as const;

const TOKEN_BUDGET_FIELD_KEYS = [
  'system',
  'card',
  'state',
  'combatOutcome',
  'plot',
  'world',
  'totalMaxTokens',
] as const;

function validateControlRoomLayer(
  raw: unknown,
  pathLabel: string
): Result<ControlRoomLayer, ValidationError[]> {
  if (!isPlainObject(raw)) {
    return err([validationError(pathLabel, 'INVALID_TYPE', `${pathLabel} must be a plain object`)]);
  }
  if (containsForbiddenKeys(raw)) {
    return err([
      validationError(
        pathLabel,
        'UNSAFE_KEY',
        `${pathLabel} contains forbidden prototype-polluting keys`
      ),
    ]);
  }

  const acc = new ErrorAccumulator(pathLabel);

  const capabilities = getOwn(raw, 'capabilities');
  if (capabilities !== undefined) {
    if (!isPlainObject(capabilities)) {
      acc.add('capabilities', 'INVALID_TYPE', 'capabilities must be a plain object');
    } else {
      for (const boolKey of ['factions', 'beats', 'relationships', 'chronicle'] as const) {
        const val = getOwn(capabilities, boolKey);
        if (val !== undefined && typeof val !== 'boolean') {
          acc.add(`capabilities.${boolKey}`, 'INVALID_TYPE', `${boolKey} must be a boolean`);
        }
      }
      for (const strKey of ['spatialMode', 'combatMode', 'progression', 'clocks'] as const) {
        const val = getOwn(capabilities, strKey);
        if (val !== undefined && typeof val !== 'string') {
          acc.add(`capabilities.${strKey}`, 'INVALID_TYPE', `${strKey} must be a string`);
        }
      }
    }
  }

  const pcCoreSections = getOwn(raw, 'pcCoreSections');
  if (pcCoreSections !== undefined) {
    acc.absorb(
      validateCharacterSectionList(pcCoreSections as CharacterSectionDef[], 'pcCoreSections')
    );
  }

  const npcCoreSections = getOwn(raw, 'npcCoreSections');
  if (npcCoreSections !== undefined) {
    acc.absorb(
      validateCharacterSectionList(npcCoreSections as CharacterSectionDef[], 'npcCoreSections')
    );
  }

  const sectionConfirmPolicies = getOwn(raw, 'sectionConfirmPolicies');
  if (sectionConfirmPolicies !== undefined) {
    if (!isPlainObject(sectionConfirmPolicies)) {
      acc.add(
        'sectionConfirmPolicies',
        'INVALID_TYPE',
        'sectionConfirmPolicies must be a plain object'
      );
    } else {
      for (const target of ['pc', 'npc'] as const) {
        const targetMap = getOwn(sectionConfirmPolicies, target);
        if (targetMap !== undefined) {
          if (!isPlainObject(targetMap)) {
            acc.add(
              `sectionConfirmPolicies.${target}`,
              'INVALID_TYPE',
              `sectionConfirmPolicies.${target} must be a plain object`
            );
          } else {
            for (const secKey of Object.keys(targetMap)) {
              const policy = getOwn(targetMap, secKey);
              if (policy !== undefined) {
                acc.absorb(
                  validateConfirmPolicy(
                    policy as ConfirmPolicy,
                    `sectionConfirmPolicies.${target}.${secKey}`
                  )
                );
              }
            }
          }
        }
      }
    }
  }

  const gameSystems = getOwn(raw, 'gameSystems');
  if (gameSystems !== undefined) {
    if (!Array.isArray(gameSystems)) {
      acc.add('gameSystems', 'INVALID_TYPE', 'gameSystems must be an array');
    } else {
      for (let i = 0; i < gameSystems.length; i += 1) {
        acc.absorb(
          validateGameSystemModule(gameSystems[i] as GameSystemModule, `gameSystems[${i}]`)
        );
      }
    }
  }

  const gameSystemOverrides = getOwn(raw, 'gameSystemOverrides');
  if (gameSystemOverrides !== undefined) {
    if (!isPlainObject(gameSystemOverrides)) {
      acc.add('gameSystemOverrides', 'INVALID_TYPE', 'gameSystemOverrides must be a plain object');
    } else {
      for (const modId of Object.keys(gameSystemOverrides)) {
        const modOverride = getOwn(gameSystemOverrides, modId);
        if (modOverride !== undefined) {
          if (!isPlainObject(modOverride)) {
            acc.add(
              `gameSystemOverrides.${modId}`,
              'INVALID_TYPE',
              'GameSystemModuleOverride must be a plain object'
            );
            continue;
          }
          const fields = getOwn(modOverride, 'fields');
          if (fields !== undefined && !isPlainObject(fields)) {
            acc.add(
              `gameSystemOverrides.${modId}.fields`,
              'INVALID_TYPE',
              'fields must be a plain object'
            );
          }
          const fieldConfirmPolicies = getOwn(modOverride, 'fieldConfirmPolicies');
          if (fieldConfirmPolicies !== undefined && !isPlainObject(fieldConfirmPolicies)) {
            acc.add(
              `gameSystemOverrides.${modId}.fieldConfirmPolicies`,
              'INVALID_TYPE',
              'fieldConfirmPolicies must be a plain object'
            );
          }
          const ui = getOwn(modOverride, 'ui');
          if (ui !== undefined && !isPlainObject(ui)) {
            acc.add(
              `gameSystemOverrides.${modId}.ui`,
              'INVALID_TYPE',
              'ui must be a plain object'
            );
          }
        }
      }
    }
  }

  for (const listKey of ['blockOrder', 'syspromptSectionOrder'] as const) {
    const listVal = getOwn(raw, listKey);
    if (listVal !== undefined) {
      if (!Array.isArray(listVal) || !listVal.every((item) => typeof item === 'string')) {
        acc.add(listKey, 'INVALID_TYPE', `${listKey} must be an array of strings`);
      }
    }
  }

  const basePrompts = getOwn(raw, 'basePrompts');
  if (basePrompts !== undefined) {
    if (!isPlainObject(basePrompts)) {
      acc.add('basePrompts', 'INVALID_TYPE', 'basePrompts must be a plain object');
    } else {
      for (const key of Object.keys(basePrompts)) {
        const val = getOwn(basePrompts, key);
        if (val !== undefined && typeof val !== 'string') {
          acc.add(`basePrompts.${key}`, 'INVALID_TYPE', `basePrompts.${key} must be a string`);
        }
      }
    }
  }

  const unlockedPromptSections = getOwn(raw, 'unlockedPromptSections');
  if (unlockedPromptSections !== undefined) {
    if (!isPlainObject(unlockedPromptSections)) {
      acc.add(
        'unlockedPromptSections',
        'INVALID_TYPE',
        'unlockedPromptSections must be a plain object'
      );
    } else {
      for (const key of Object.keys(unlockedPromptSections)) {
        const val = getOwn(unlockedPromptSections, key);
        if (val !== undefined && typeof val !== 'boolean') {
          acc.add(
            `unlockedPromptSections.${key}`,
            'INVALID_TYPE',
            `unlockedPromptSections.${key} must be a boolean`
          );
        }
      }
    }
  }

  const customPromptBlocks = getOwn(raw, 'customPromptBlocks');
  if (customPromptBlocks !== undefined) {
    if (!isPlainObject(customPromptBlocks)) {
      acc.add('customPromptBlocks', 'INVALID_TYPE', 'customPromptBlocks must be a plain object');
    } else {
      for (const blockKey of Object.keys(customPromptBlocks)) {
        const block = getOwn(customPromptBlocks, blockKey);
        if (!isPlainObject(block)) {
          acc.add(
            `customPromptBlocks.${blockKey}`,
            'INVALID_TYPE',
            'CustomPromptBlockSpec must be a plain object'
          );
          continue;
        }
        if (typeof getOwn(block, 'id') !== 'string') {
          acc.add(`customPromptBlocks.${blockKey}.id`, 'INVALID_TYPE', 'id must be a string');
        }
        if (typeof getOwn(block, 'name') !== 'string') {
          acc.add(`customPromptBlocks.${blockKey}.name`, 'INVALID_TYPE', 'name must be a string');
        }
        const role = getOwn(block, 'role');
        if (role !== 'system' && role !== 'user' && role !== 'assistant') {
          acc.add(
            `customPromptBlocks.${blockKey}.role`,
            'INVALID_ENUM',
            'role must be system, user, or assistant'
          );
        }
      }
    }
  }

  const combatRules = getOwn(raw, 'combatRules');
  if (combatRules !== undefined) {
    if (!isPlainObject(combatRules)) {
      acc.add('combatRules', 'INVALID_TYPE', 'combatRules must be a plain object');
    } else {
      const customRules = getOwn(combatRules, 'customRules');
      if (customRules !== undefined && !isPlainObject(customRules)) {
        acc.add('combatRules.customRules', 'INVALID_TYPE', 'customRules must be a plain object');
      }
      const skillOverrides = getOwn(combatRules, 'skillOverrides');
      if (skillOverrides !== undefined && !isPlainObject(skillOverrides)) {
        acc.add(
          'combatRules.skillOverrides',
          'INVALID_TYPE',
          'skillOverrides must be a plain object'
        );
      }
    }
  }

  const tuningDials = getOwn(raw, 'tuningDials');
  if (tuningDials !== undefined && !isPlainObject(tuningDials)) {
    acc.add('tuningDials', 'INVALID_TYPE', 'tuningDials must be a plain object');
  }

  const generation = getOwn(raw, 'generation');
  if (generation !== undefined) {
    if (!isPlainObject(generation)) {
      acc.add('generation', 'INVALID_TYPE', 'generation must be a plain object');
    } else {
      for (const numKey of GENERATION_NUMERIC_FIELD_KEYS) {
        const val = getOwn(generation, numKey);
        if (val !== undefined && (typeof val !== 'number' || !Number.isFinite(val))) {
          acc.add(
            `generation.${numKey}`,
            'INVALID_NUMBER',
            `generation.${numKey} must be a finite number`
          );
        }
      }
      const stopSequences = getOwn(generation, 'stopSequences');
      if (
        stopSequences !== undefined &&
        (!Array.isArray(stopSequences) || !stopSequences.every((s) => typeof s === 'string'))
      ) {
        acc.add(
          'generation.stopSequences',
          'INVALID_TYPE',
          'generation.stopSequences must be an array of strings'
        );
      }
      const stFormatTemplates = getOwn(generation, 'stFormatTemplates');
      if (stFormatTemplates !== undefined && !isPlainObject(stFormatTemplates)) {
        acc.add(
          'generation.stFormatTemplates',
          'INVALID_TYPE',
          'generation.stFormatTemplates must be a plain object'
        );
      }
      const presetName = getOwn(generation, 'presetName');
      if (presetName !== undefined && typeof presetName !== 'string') {
        acc.add('generation.presetName', 'INVALID_TYPE', 'generation.presetName must be a string');
      }
      const sourceFormat = getOwn(generation, 'sourceFormat');
      if (
        sourceFormat !== undefined &&
        sourceFormat !== 'st_chat_completion' &&
        sourceFormat !== 'st_text_completion' &&
        sourceFormat !== 'referee'
      ) {
        acc.add(
          'generation.sourceFormat',
          'INVALID_ENUM',
          'generation.sourceFormat must be st_chat_completion, st_text_completion, or referee'
        );
      }
    }
  }

  const tokenBudgets = getOwn(raw, 'tokenBudgets');
  if (tokenBudgets !== undefined) {
    if (!isPlainObject(tokenBudgets)) {
      acc.add('tokenBudgets', 'INVALID_TYPE', 'tokenBudgets must be a plain object');
    } else {
      for (const budgetKey of TOKEN_BUDGET_FIELD_KEYS) {
        const val = getOwn(tokenBudgets, budgetKey);
        if (val !== undefined && (typeof val !== 'number' || !Number.isFinite(val))) {
          acc.add(
            `tokenBudgets.${budgetKey}`,
            'INVALID_NUMBER',
            `tokenBudgets.${budgetKey} must be a finite number`
          );
        }
      }
    }
  }

  if (acc.hasErrors()) {
    return err([...acc.errors]);
  }

  return ok(cloneControlRoomLayer(raw as ControlRoomLayer));
}

function parseJsonSafe(rawText: string, pathLabel: string): Result<unknown, ValidationError[]> {
  try {
    const parsed: unknown = JSON.parse(rawText);
    if (containsForbiddenKeys(parsed)) {
      return err([
        validationError(pathLabel, 'UNSAFE_KEY', `Forbidden prototype-polluting key in ${pathLabel}`),
      ]);
    }
    return ok(parsed);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return err([
      validationError(pathLabel, 'INVALID_JSON', `Failed to parse JSON in ${pathLabel}: ${msg}`),
    ]);
  }
}

export function formatCheckpointFilename(turn: number): string {
  return `turn-${String(turn).padStart(5, '0')}.snapshot.json`;
}

async function atomicWriteText(targetPath: string, content: string): Promise<void> {
  const parentDir = path.dirname(targetPath);
  await fs.mkdir(parentDir, { recursive: true });
  const tmpPath = `${targetPath}.tmp`;
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(tmpPath, 'w');
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(tmpPath, targetPath);
  } catch (error) {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
    await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function atomicWriteJson(targetPath: string, payload: unknown): Promise<void> {
  await atomicWriteText(targetPath, `${JSON.stringify(payload, null, 2)}\n`);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function sanitizeTrailingPartialLineBeforeAppend(filePath: string): Promise<void> {
  if (!(await fileExists(filePath))) {
    return;
  }
  const rawBuffer = await fs.readFile(filePath);
  if (rawBuffer.length === 0) {
    return;
  }
  if (rawBuffer[rawBuffer.length - 1] === 0x0a) {
    return;
  }
  const lastNewlineIdx = rawBuffer.lastIndexOf(0x0a);
  const trailingText = rawBuffer.subarray(lastNewlineIdx + 1).toString('utf8').trim();
  if (trailingText.length === 0) {
    return;
  }
  const parsedTrailing = parseJsonSafe(trailingText, filePath);
  if (parsedTrailing.ok) {
    // Valid JSON line without trailing newline: add newline before appending next record.
    const handle = await fs.open(filePath, 'a');
    try {
      await handle.write('\n', undefined, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    return;
  }
  // Truncate incomplete trailing crash line back to the last complete newline boundary.
  await fs.truncate(filePath, lastNewlineIdx + 1);
}

async function appendJsonLines(filePath: string, lines: readonly string[]): Promise<void> {
  if (lines.length === 0) {
    return;
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await sanitizeTrailingPartialLineBeforeAppend(filePath);
  const payload = `${lines.join('\n')}\n`;
  const handle = await fs.open(filePath, 'a');
  try {
    await handle.write(payload, undefined, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function validateManifestObject(raw: unknown): Result<SaveManifest, ValidationError[]> {
  if (!isPlainObject(raw)) {
    return err([validationError('manifest', 'INVALID_TYPE', 'manifest.json must be a plain object')]);
  }
  const sessionId = getOwn(raw, 'sessionId');
  const cartridgeId = getOwn(raw, 'cartridgeId');
  const systemPackId = getOwn(raw, 'systemPackId');
  const schemaVersion = getOwn(raw, 'schemaVersion');
  const currentTurn = getOwn(raw, 'currentTurn');
  const parentSaveId = getOwn(raw, 'parentSaveId');
  const branchAtTurn = getOwn(raw, 'branchAtTurn');
  const checkpointInterval = getOwn(raw, 'checkpointInterval');

  if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
    return err([
      validationError('manifest.sessionId', 'REQUIRED', 'sessionId must be a non-empty string'),
    ]);
  }
  if (typeof cartridgeId !== 'string' || cartridgeId.trim().length === 0) {
    return err([
      validationError('manifest.cartridgeId', 'REQUIRED', 'cartridgeId must be a non-empty string'),
    ]);
  }
  if (typeof systemPackId !== 'string' || systemPackId.trim().length === 0) {
    return err([
      validationError('manifest.systemPackId', 'REQUIRED', 'systemPackId must be a non-empty string'),
    ]);
  }
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion) || schemaVersion < 1) {
    return err([
      validationError(
        'manifest.schemaVersion',
        'INVALID_SCHEMA_VERSION',
        'schemaVersion must be a positive integer'
      ),
    ]);
  }
  if (typeof currentTurn !== 'number' || !Number.isInteger(currentTurn) || currentTurn < 0) {
    return err([
      validationError(
        'manifest.currentTurn',
        'INVALID_TURN',
        'currentTurn must be a non-negative integer'
      ),
    ]);
  }
  if (parentSaveId !== null && typeof parentSaveId !== 'string') {
    return err([
      validationError(
        'manifest.parentSaveId',
        'INVALID_TYPE',
        'parentSaveId must be a string or null'
      ),
    ]);
  }
  if (
    branchAtTurn !== null &&
    (typeof branchAtTurn !== 'number' || !Number.isInteger(branchAtTurn) || branchAtTurn < 0)
  ) {
    return err([
      validationError(
        'manifest.branchAtTurn',
        'INVALID_TURN',
        'branchAtTurn must be a non-negative integer or null'
      ),
    ]);
  }
  if (
    typeof checkpointInterval !== 'number' ||
    !Number.isInteger(checkpointInterval) ||
    checkpointInterval < 1
  ) {
    return err([
      validationError(
        'manifest.checkpointInterval',
        'INVALID_INTERVAL',
        'checkpointInterval must be an integer >= 1'
      ),
    ]);
  }

  return ok({
    sessionId,
    cartridgeId,
    systemPackId,
    schemaVersion,
    currentTurn,
    parentSaveId,
    branchAtTurn,
    checkpointInterval,
  });
}

function validateEventLogRecord(
  raw: unknown,
  pathLabel: string
): Result<EventLogRecord, ValidationError[]> {
  if (!isPlainObject(raw)) {
    return err([validationError(pathLabel, 'INVALID_TYPE', `${pathLabel} must be an object`)]);
  }
  const turn = getOwn(raw, 'turn');
  const batch = getOwn(raw, 'batch');
  const postStateHash = getOwn(raw, 'postStateHash');
  const rngBefore = getOwn(raw, 'rngBefore');
  const rngAfter = getOwn(raw, 'rngAfter');

  if (typeof turn !== 'number' || !Number.isInteger(turn) || turn < 0) {
    return err([
      validationError(`${pathLabel}.turn`, 'INVALID_TURN', 'turn must be a non-negative integer'),
    ]);
  }
  if (!isPlainObject(batch)) {
    return err([validationError(`${pathLabel}.batch`, 'INVALID_TYPE', 'batch must be an object')]);
  }
  if (typeof batch.eventId !== 'string' || batch.eventId.trim().length === 0) {
    return err([
      validationError(
        `${pathLabel}.batch.eventId`,
        'REQUIRED',
        'batch.eventId must be a non-empty string'
      ),
    ]);
  }
  if (typeof batch.source !== 'string' || !VALID_PATCH_SOURCES.has(batch.source)) {
    return err([
      validationError(
        `${pathLabel}.batch.source`,
        'INVALID_ENUM',
        `Invalid batch.source "${String(batch.source)}"`
      ),
    ]);
  }
  if (!Array.isArray(batch.operations)) {
    return err([
      validationError(
        `${pathLabel}.batch.operations`,
        'INVALID_TYPE',
        'batch.operations must be an array'
      ),
    ]);
  }
  if (typeof postStateHash !== 'string' || postStateHash.trim().length === 0) {
    return err([
      validationError(
        `${pathLabel}.postStateHash`,
        'REQUIRED',
        'postStateHash must be a non-empty string'
      ),
    ]);
  }
  if (!isPlainObject(rngBefore) || (rngBefore.type !== 'xoshiro128**' && rngBefore.type !== 'queued')) {
    return err([
      validationError(`${pathLabel}.rngBefore`, 'INVALID_RNG_STATE', 'Invalid rngBefore'),
    ]);
  }
  if (!isPlainObject(rngAfter) || (rngAfter.type !== 'xoshiro128**' && rngAfter.type !== 'queued')) {
    return err([
      validationError(`${pathLabel}.rngAfter`, 'INVALID_RNG_STATE', 'Invalid rngAfter'),
    ]);
  }

  return ok(raw as unknown as EventLogRecord);
}

function validateAuditEntry(raw: unknown, pathLabel: string): Result<AuditEntry, ValidationError[]> {
  if (!isPlainObject(raw)) {
    return err([validationError(pathLabel, 'INVALID_TYPE', `${pathLabel} must be an object`)]);
  }
  const turn = getOwn(raw, 'turn');
  const storyTurn = getOwn(raw, 'storyTurn');
  const timestampSeq = getOwn(raw, 'timestampSeq');
  const source = getOwn(raw, 'source');
  const eventId = getOwn(raw, 'eventId');
  const op = getOwn(raw, 'op');
  const entryPath = getOwn(raw, 'path');
  const status = getOwn(raw, 'status');
  const reason = getOwn(raw, 'reason');

  if (typeof turn !== 'number' || !Number.isInteger(turn) || turn < 0) {
    return err([validationError(`${pathLabel}.turn`, 'INVALID_TURN', 'turn must be integer >= 0')]);
  }
  if (typeof storyTurn !== 'number' || !Number.isInteger(storyTurn) || storyTurn < 0) {
    return err([
      validationError(`${pathLabel}.storyTurn`, 'INVALID_TURN', 'storyTurn must be integer >= 0'),
    ]);
  }
  if (typeof timestampSeq !== 'number' || !Number.isFinite(timestampSeq) || timestampSeq < 0) {
    return err([
      validationError(
        `${pathLabel}.timestampSeq`,
        'INVALID_NUMBER',
        'timestampSeq must be finite >= 0'
      ),
    ]);
  }
  if (typeof source !== 'string' || !VALID_PATCH_SOURCES.has(source)) {
    return err([
      validationError(`${pathLabel}.source`, 'INVALID_ENUM', `Invalid source "${String(source)}"`),
    ]);
  }
  if (typeof eventId !== 'string' || eventId.trim().length === 0) {
    return err([
      validationError(`${pathLabel}.eventId`, 'REQUIRED', 'eventId must be a non-empty string'),
    ]);
  }
  if (typeof op !== 'string' || op.length === 0) {
    return err([validationError(`${pathLabel}.op`, 'REQUIRED', 'op must be a non-empty string')]);
  }
  if (typeof entryPath !== 'string') {
    return err([validationError(`${pathLabel}.path`, 'INVALID_TYPE', 'path must be a string')]);
  }
  if (typeof status !== 'string' || !VALID_AUDIT_STATUSES.has(status)) {
    return err([
      validationError(`${pathLabel}.status`, 'INVALID_ENUM', `Invalid status "${String(status)}"`),
    ]);
  }
  if (reason !== undefined && typeof reason !== 'string') {
    return err([validationError(`${pathLabel}.reason`, 'INVALID_TYPE', 'reason must be a string')]);
  }

  return ok(raw as unknown as AuditEntry);
}

async function readJsonlWithTailRecovery<T>(
  filePath: string,
  label: string,
  validateRecord: (raw: unknown, pathLabel: string) => Result<T, ValidationError[]>
): Promise<Result<{ records: T[]; recoveredPartialLine: boolean }, ValidationError[]>> {
  if (!(await fileExists(filePath))) {
    return ok({ records: [], recoveredPartialLine: false });
  }

  const content = await fs.readFile(filePath, 'utf8');
  if (content.trim().length === 0) {
    return ok({ records: [], recoveredPartialLine: false });
  }

  const endsWithNewline = content.endsWith('\n');
  const rawLines = content.split(/\r?\n/);
  const nonEmptyLines: Array<{ text: string; lineNo: number }> = [];
  for (let i = 0; i < rawLines.length; i += 1) {
    const line = rawLines[i];
    if (line !== undefined && line.trim().length > 0) {
      nonEmptyLines.push({ text: line, lineNo: i + 1 });
    }
  }

  const records: T[] = [];
  let recoveredPartialLine = false;

  for (let i = 0; i < nonEmptyLines.length; i += 1) {
    const entry = nonEmptyLines[i];
    if (!entry) {
      continue;
    }
    const isLastLine = i === nonEmptyLines.length - 1;
    const lineLabel = `${label}[line ${entry.lineNo}]`;
    const parsed = parseJsonSafe(entry.text, lineLabel);

    if (!parsed.ok) {
      if (isLastLine) {
        recoveredPartialLine = true;
        break;
      }
      return err(parsed.error);
    }

    const validated = validateRecord(parsed.value, lineLabel);
    if (!validated.ok) {
      if (isLastLine && !endsWithNewline) {
        recoveredPartialLine = true;
        break;
      }
      return err(validated.error);
    }

    records.push(validated.value);
  }

  return ok({ records, recoveredPartialLine });
}

async function maybeUpdateManifestTurn(saveDir: string, turn: number): Promise<void> {
  const manifestPath = path.join(saveDir, 'manifest.json');
  if (!(await fileExists(manifestPath))) {
    return;
  }
  const rawText = await fs.readFile(manifestPath, 'utf8');
  const parsed = parseJsonSafe(rawText, 'manifest.json');
  if (!parsed.ok) {
    return;
  }
  const validated = validateManifestObject(parsed.value);
  if (!validated.ok) {
    return;
  }
  if (turn > validated.value.currentTurn) {
    const updated: SaveManifest = {
      ...validated.value,
      currentTurn: turn,
    };
    await atomicWriteJson(manifestPath, updated);
  }
}

/**
 * Initialize a session save directory layout (`manifest.json`, `checkpoints/`,
 * `events.jsonl`, `audit.jsonl`, and optional initial checkpoint / swipe tree).
 */
export async function initSaveDirectory(
  saveDir: string,
  manifestInput: InitSaveManifestInput,
  initialOptions?: InitSaveOptions
): Promise<Result<SaveManifest, ValidationError[]>> {
  if (typeof saveDir !== 'string' || saveDir.trim().length === 0) {
    return err([validationError('saveDir', 'REQUIRED', 'saveDir must be a non-empty string')]);
  }

  const candidateManifest: SaveManifest = {
    sessionId: manifestInput.sessionId,
    cartridgeId: manifestInput.cartridgeId,
    systemPackId: manifestInput.systemPackId,
    schemaVersion: manifestInput.schemaVersion ?? CURRENT_STATE_SCHEMA_VERSION,
    currentTurn: manifestInput.currentTurn ?? 0,
    parentSaveId: manifestInput.parentSaveId ?? null,
    branchAtTurn: manifestInput.branchAtTurn ?? null,
    checkpointInterval: manifestInput.checkpointInterval ?? DEFAULT_CHECKPOINT_INTERVAL,
  };

  const manifestValidation = validateManifestObject(candidateManifest);
  if (!manifestValidation.ok) {
    return err(manifestValidation.error);
  }
  const manifest = manifestValidation.value;

  const checkpointsDir = path.join(saveDir, 'checkpoints');
  await fs.mkdir(checkpointsDir, { recursive: true });
  await atomicWriteJson(path.join(saveDir, 'manifest.json'), manifest);

  const eventsPath = path.join(saveDir, 'events.jsonl');
  if (!(await fileExists(eventsPath))) {
    await atomicWriteText(eventsPath, '');
  }
  const auditPath = path.join(saveDir, 'audit.jsonl');
  if (!(await fileExists(auditPath))) {
    await atomicWriteText(auditPath, '');
  }

  if (initialOptions?.worldState !== undefined) {
    const cpRes = await saveCheckpointAtomic(
      saveDir,
      manifest.currentTurn,
      initialOptions.worldState,
      initialOptions.beatLedger ?? {},
      initialOptions.combatState
    );
    if (!cpRes.ok) {
      return err(cpRes.error);
    }
  }

  if (initialOptions?.swipeTree !== undefined) {
    const treeRes = await saveSwipeTreeAtomic(saveDir, initialOptions.swipeTree);
    if (!treeRes.ok) {
      return err(treeRes.error);
    }
  }

  if (initialOptions?.userControlRoomLayer !== undefined) {
    const crRes = await saveControlRoomLayerAtomic(saveDir, initialOptions.userControlRoomLayer);
    if (!crRes.ok) {
      return err(crRes.error);
    }
  }

  if (initialOptions?.activePersona !== undefined) {
    const personaRes = await saveActivePersonaAtomic(saveDir, initialOptions.activePersona);
    if (!personaRes.ok) {
      return err(personaRes.error);
    }
  }

  return ok(manifest);
}

/**
 * Atomically write a turn snapshot (`checkpoints/turn-XXXXX.snapshot.json`) using
 * `.tmp` + `fs.rename` so crashes never leave half-written snapshots.
 */
export async function saveCheckpointAtomic(
  saveDir: string,
  turn: number,
  worldState: WorldState,
  beatLedger: Record<string, unknown> = {},
  combatState?: Record<string, unknown> | null
): Promise<Result<{ path: string; snapshot: CheckpointSnapshot }, ValidationError[]>> {
  if (typeof saveDir !== 'string' || saveDir.trim().length === 0) {
    return err([validationError('saveDir', 'REQUIRED', 'saveDir must be a non-empty string')]);
  }
  if (typeof turn !== 'number' || !Number.isInteger(turn) || turn < 0) {
    return err([validationError('turn', 'INVALID_TURN', 'turn must be a non-negative integer')]);
  }
  if (!isPlainObject(beatLedger) || containsForbiddenKeys(beatLedger)) {
    return err([
      validationError('beatLedger', 'INVALID_TYPE', 'beatLedger must be a safe plain object'),
    ]);
  }

  const combatRes = validateCombatStateField(combatState, 'combatState');
  if (!combatRes.ok) {
    return err(combatRes.error);
  }
  const validatedCombatState = combatRes.value;

  const wsValidation = validateWorldState(worldState);
  if (!wsValidation.ok) {
    return err(wsValidation.error);
  }

  const validState = wsValidation.value.state;
  const stateHash = computeStateHash(validState, beatLedger, validatedCombatState);
  const snapshot: CheckpointSnapshot = {
    turn,
    worldState: validState,
    beatLedger,
    stateHash,
    ...(validatedCombatState !== undefined ? { combatState: validatedCombatState } : {}),
  };

  const targetPath = path.join(saveDir, 'checkpoints', formatCheckpointFilename(turn));
  await atomicWriteJson(targetPath, snapshot);
  await maybeUpdateManifestTurn(saveDir, turn);

  return ok({ path: targetPath, snapshot });
}

/**
 * Atomically persist the session's user {@link ControlRoomLayer} to `control-room.json`
 * via `.tmp` + `fsync` + `rename`, rejecting prototype-polluting keys or invalid structures.
 */
export async function saveControlRoomLayerAtomic(
  saveDir: string,
  layer: ControlRoomLayer
): Promise<Result<void, ValidationError[]>> {
  if (typeof saveDir !== 'string' || saveDir.trim().length === 0) {
    return err([validationError('saveDir', 'REQUIRED', 'saveDir must be a non-empty string')]);
  }
  const validated = validateControlRoomLayer(layer, 'layer');
  if (!validated.ok) {
    return err(validated.error);
  }
  await atomicWriteJson(path.join(saveDir, 'control-room.json'), validated.value);
  return ok(undefined);
}

/**
 * Atomically persist the session's active {@link UserPersonaPreset} (or `null` when cleared)
 * to `persona.json` via `.tmp` + `fsync` + `rename`.
 */
export async function saveActivePersonaAtomic(
  saveDir: string,
  persona: UserPersonaPreset | null
): Promise<Result<void, ValidationError[]>> {
  if (typeof saveDir !== 'string' || saveDir.trim().length === 0) {
    return err([validationError('saveDir', 'REQUIRED', 'saveDir must be a non-empty string')]);
  }
  if (persona === null) {
    await atomicWriteJson(path.join(saveDir, 'persona.json'), null);
    return ok(undefined);
  }
  if (containsForbiddenKeys(persona)) {
    return err([
      validationError(
        'persona',
        'UNSAFE_KEY',
        'UserPersonaPreset contains forbidden prototype-polluting keys'
      ),
    ]);
  }
  const validated = validateUserPersonaPreset(persona);
  if (!validated.ok) {
    return err(validated.error);
  }
  await atomicWriteJson(path.join(saveDir, 'persona.json'), validated.value);
  return ok(undefined);
}

/**
 * Append a single {@link EventLogRecord} JSON line to `events.jsonl` and sync to disk.
 */
export async function appendEventRecord(
  saveDir: string,
  record: EventLogRecord
): Promise<Result<void, ValidationError[]>> {
  if (typeof saveDir !== 'string' || saveDir.trim().length === 0) {
    return err([validationError('saveDir', 'REQUIRED', 'saveDir must be a non-empty string')]);
  }
  if (containsForbiddenKeys(record)) {
    return err([
      validationError('record', 'UNSAFE_KEY', 'EventLogRecord contains forbidden keys'),
    ]);
  }
  const validated = validateEventLogRecord(record, 'record');
  if (!validated.ok) {
    return err(validated.error);
  }

  const eventsPath = path.join(saveDir, 'events.jsonl');
  await appendJsonLines(eventsPath, [JSON.stringify(validated.value)]);
  await maybeUpdateManifestTurn(saveDir, validated.value.turn);
  return ok(undefined);
}

/**
 * Append one or more {@link AuditEntry} records to `audit.jsonl` and sync to disk.
 */
export async function appendAuditRecords(
  saveDir: string,
  entries: readonly AuditEntry[]
): Promise<Result<void, ValidationError[]>> {
  if (typeof saveDir !== 'string' || saveDir.trim().length === 0) {
    return err([validationError('saveDir', 'REQUIRED', 'saveDir must be a non-empty string')]);
  }
  if (!Array.isArray(entries)) {
    return err([validationError('entries', 'INVALID_TYPE', 'entries must be an array')]);
  }
  if (entries.length === 0) {
    return ok(undefined);
  }

  const lines: string[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (containsForbiddenKeys(entry)) {
      return err([
        validationError(`entries[${i}]`, 'UNSAFE_KEY', `AuditEntry[${i}] contains forbidden keys`),
      ]);
    }
    const validated = validateAuditEntry(entry, `entries[${i}]`);
    if (!validated.ok) {
      return err(validated.error);
    }
    lines.push(JSON.stringify(validated.value));
  }

  const auditPath = path.join(saveDir, 'audit.jsonl');
  await appendJsonLines(auditPath, lines);
  return ok(undefined);
}

/**
 * Atomically persist `swipe-tree.json` and derived `transcript.json` via `.tmp` + `rename`.
 */
export async function saveSwipeTreeAtomic(
  saveDir: string,
  tree: SwipeTreeState
): Promise<Result<void, ValidationError[]>> {
  if (typeof saveDir !== 'string' || saveDir.trim().length === 0) {
    return err([validationError('saveDir', 'REQUIRED', 'saveDir must be a non-empty string')]);
  }
  const validated = validateSwipeTreeState(tree);
  if (!validated.ok) {
    return err(validated.error);
  }

  const validTree = validated.value;
  await atomicWriteJson(path.join(saveDir, 'swipe-tree.json'), validTree);
  await atomicWriteJson(path.join(saveDir, 'transcript.json'), {
    activeLeafMessageId: validTree.activeLeafMessageId,
    messages: getLinearTranscript(validTree),
  });
  return ok(undefined);
}

function migrateCheckpointWorldStatesInTree(
  rawTree: unknown
): Result<unknown, ValidationError[]> {
  if (!isPlainObject(rawTree)) {
    return err([validationError('swipeTree', 'INVALID_TYPE', 'swipe-tree.json must be an object')]);
  }
  const rawCheckpoints = getOwn(rawTree, 'checkpoints');
  if (!isPlainObject(rawCheckpoints)) {
    return ok(rawTree);
  }

  const migratedCheckpoints: Record<string, unknown> = {};
  for (const cpId of Object.keys(rawCheckpoints)) {
    if (!isSafeKey(cpId)) {
      return err([
        validationError(`checkpoints.${cpId}`, 'UNSAFE_KEY', `Forbidden checkpoint key "${cpId}"`),
      ]);
    }
    const rawCp = getOwn(rawCheckpoints, cpId);
    if (!isPlainObject(rawCp)) {
      setOwn(migratedCheckpoints, cpId, rawCp);
      continue;
    }
    const rawWs = getOwn(rawCp, 'worldState');
    const migratedWs = migrateWorldStateDocument(rawWs);
    if (!migratedWs.ok) {
      return err(migratedWs.error);
    }
    setOwn(migratedCheckpoints, cpId, {
      ...rawCp,
      worldState: migratedWs.value.worldState,
    });
  }

  return ok({
    ...rawTree,
    checkpoints: migratedCheckpoints,
  });
}

/**
 * Load a session save directory, migrating legacy snapshots to v2 and recovering
 * cleanly from truncated trailing JSONL lines caused by mid-write crashes.
 */
export async function loadSessionSave(
  saveDir: string
): Promise<Result<LoadedSessionSave, ValidationError[]>> {
  if (typeof saveDir !== 'string' || saveDir.trim().length === 0) {
    return err([validationError('saveDir', 'REQUIRED', 'saveDir must be a non-empty string')]);
  }

  const manifestPath = path.join(saveDir, 'manifest.json');
  if (!(await fileExists(manifestPath))) {
    return err([
      validationError('manifest.json', 'MISSING_MANIFEST', `manifest.json not found in "${saveDir}"`),
    ]);
  }

  const manifestText = await fs.readFile(manifestPath, 'utf8');
  const parsedManifest = parseJsonSafe(manifestText, 'manifest.json');
  if (!parsedManifest.ok) {
    return err(parsedManifest.error);
  }
  const manifestRes = validateManifestObject(parsedManifest.value);
  if (!manifestRes.ok) {
    return err(manifestRes.error);
  }
  const manifest = manifestRes.value;

  // Load checkpoints (ignoring leftover *.tmp files)
  const checkpointsDir = path.join(saveDir, 'checkpoints');
  const checkpoints: CheckpointSnapshot[] = [];
  if (await fileExists(checkpointsDir)) {
    const dirEntries = await fs.readdir(checkpointsDir, { withFileTypes: true });
    const snapshotFiles = dirEntries
      .filter((d: Dirent) => d.isFile() && CHECKPOINT_FILENAME_PATTERN.test(d.name))
      .map((d: Dirent) => d.name)
      .sort();

    for (const fileName of snapshotFiles) {
      const filePath = path.join(checkpointsDir, fileName);
      const text = await fs.readFile(filePath, 'utf8');
      const parsed = parseJsonSafe(text, fileName);
      if (!parsed.ok) {
        return err(parsed.error);
      }
      if (!isPlainObject(parsed.value)) {
        return err([
          validationError(fileName, 'INVALID_TYPE', `${fileName} must be a JSON object`),
        ]);
      }
      const turn = getOwn(parsed.value, 'turn');
      const rawWorldState = getOwn(parsed.value, 'worldState');
      const rawBeatLedger = getOwn(parsed.value, 'beatLedger') ?? {};
      const stateHash = getOwn(parsed.value, 'stateHash');
      const rawCombatState = getOwn(parsed.value, 'combatState');

      if (typeof turn !== 'number' || !Number.isInteger(turn) || turn < 0) {
        return err([
          validationError(`${fileName}.turn`, 'INVALID_TURN', 'Snapshot turn must be integer >= 0'),
        ]);
      }
      if (!isPlainObject(rawBeatLedger)) {
        return err([
          validationError(
            `${fileName}.beatLedger`,
            'INVALID_TYPE',
            'Snapshot beatLedger must be a plain object'
          ),
        ]);
      }
      if (typeof stateHash !== 'string' || stateHash.trim().length === 0) {
        return err([
          validationError(
            `${fileName}.stateHash`,
            'REQUIRED',
            'Snapshot stateHash must be a non-empty string'
          ),
        ]);
      }
      if (
        rawCombatState !== undefined &&
        rawCombatState !== null &&
        !isPlainObject(rawCombatState)
      ) {
        return err([
          validationError(
            `${fileName}.combatState`,
            'INVALID_TYPE',
            'Snapshot combatState must be a plain object or null'
          ),
        ]);
      }

      const migratedWs = migrateWorldStateDocument(rawWorldState);
      if (!migratedWs.ok) {
        return err(migratedWs.error);
      }

      checkpoints.push({
        turn,
        worldState: migratedWs.value.worldState,
        beatLedger: rawBeatLedger,
        stateHash,
        ...(rawCombatState !== undefined
          ? { combatState: rawCombatState as Record<string, unknown> | null }
          : {}),
      });
    }
  }

  checkpoints.sort((a, b) => a.turn - b.turn);
  const latestCheckpoint = checkpoints.length > 0 ? (checkpoints[checkpoints.length - 1] ?? null) : null;

  // Load events.jsonl
  const eventsRes = await readJsonlWithTailRecovery(
    path.join(saveDir, 'events.jsonl'),
    'events.jsonl',
    validateEventLogRecord
  );
  if (!eventsRes.ok) {
    return err(eventsRes.error);
  }

  // Load audit.jsonl
  const auditRes = await readJsonlWithTailRecovery(
    path.join(saveDir, 'audit.jsonl'),
    'audit.jsonl',
    validateAuditEntry
  );
  if (!auditRes.ok) {
    return err(auditRes.error);
  }

  // Load swipe-tree.json if present
  let swipeTree: SwipeTreeState | null = null;
  const swipeTreePath = path.join(saveDir, 'swipe-tree.json');
  if (await fileExists(swipeTreePath)) {
    const rawTreeText = await fs.readFile(swipeTreePath, 'utf8');
    const parsedTree = parseJsonSafe(rawTreeText, 'swipe-tree.json');
    if (!parsedTree.ok) {
      return err(parsedTree.error);
    }
    const migratedTree = migrateCheckpointWorldStatesInTree(parsedTree.value);
    if (!migratedTree.ok) {
      return err(migratedTree.error);
    }
    const validatedTree = validateSwipeTreeState(migratedTree.value);
    if (!validatedTree.ok) {
      return err(validatedTree.error);
    }
    swipeTree = validatedTree.value;
  }

  // Load control-room.json if present (legacy saves without it load with null)
  let userControlRoomLayer: ControlRoomLayer | null = null;
  const controlRoomPath = path.join(saveDir, 'control-room.json');
  if (await fileExists(controlRoomPath)) {
    const rawControlRoomText = await fs.readFile(controlRoomPath, 'utf8');
    const parsedControlRoom = parseJsonSafe(rawControlRoomText, 'control-room.json');
    if (!parsedControlRoom.ok) {
      return err(parsedControlRoom.error);
    }
    const validatedControlRoom = validateControlRoomLayer(
      parsedControlRoom.value,
      'control-room.json'
    );
    if (!validatedControlRoom.ok) {
      return err(validatedControlRoom.error);
    }
    userControlRoomLayer = validatedControlRoom.value;
  }

  // Load persona.json if present (legacy saves without it load with null)
  let activePersona: UserPersonaPreset | null = null;
  const personaPath = path.join(saveDir, 'persona.json');
  if (await fileExists(personaPath)) {
    const rawPersonaText = await fs.readFile(personaPath, 'utf8');
    const parsedPersona = parseJsonSafe(rawPersonaText, 'persona.json');
    if (!parsedPersona.ok) {
      return err(parsedPersona.error);
    }
    if (parsedPersona.value !== null) {
      const validatedPersona = validateUserPersonaPreset(parsedPersona.value);
      if (!validatedPersona.ok) {
        return err(validatedPersona.error);
      }
      activePersona = validatedPersona.value;
    }
  }

  return ok({
    manifest,
    latestCheckpoint,
    checkpoints,
    events: eventsRes.value.records,
    auditEntries: auditRes.value.records,
    swipeTree,
    userControlRoomLayer,
    activePersona,
    recoveredPartialLines: {
      events: eventsRes.value.recoveredPartialLine,
      audit: auditRes.value.recoveredPartialLine,
    },
  });
}

function pruneSwipeTreeAtTurn(tree: SwipeTreeState, atTurn: number): SwipeTreeState {
  const validCheckpointIds = new Set<string>();
  const nextCheckpoints: Record<string, StateCheckpoint> = {};

  for (const cpId of Object.keys(tree.checkpoints)) {
    const cp = getOwn(tree.checkpoints as Record<string, unknown>, cpId) as StateCheckpoint | undefined;
    if (cp && cp.turn <= atTurn) {
      validCheckpointIds.add(cpId);
      setOwn(nextCheckpoints, cpId, cp);
    }
  }

  const nextNodes: Record<string, TranscriptMessageNode> = {};
  for (const nodeId of Object.keys(tree.nodes)) {
    const node = getOwn(tree.nodes as Record<string, unknown>, nodeId) as
      | TranscriptMessageNode
      | undefined;
    if (!node) {
      continue;
    }
    const keptSwipes = node.swipes
      .filter((s) => validCheckpointIds.has(s.stateCheckpointId))
      .map((s, idx) => ({ ...s, swipeIndex: idx }));
    if (keptSwipes.length === 0) {
      continue;
    }
    const activeSwipeIndex =
      node.activeSwipeIndex < keptSwipes.length ? node.activeSwipeIndex : keptSwipes.length - 1;
    setOwn(nextNodes, nodeId, {
      messageId: node.messageId,
      parentMessageId: node.parentMessageId,
      role: node.role,
      swipes: keptSwipes,
      activeSwipeIndex,
    });
  }

  // Ensure no node references a pruned parentMessageId (transitively)
  let removed = true;
  while (removed) {
    removed = false;
    for (const nodeId of Object.keys(nextNodes)) {
      const node = getOwn(nextNodes as Record<string, unknown>, nodeId) as
        | TranscriptMessageNode
        | undefined;
      if (node && node.parentMessageId !== null && !Object.hasOwn(nextNodes, node.parentMessageId)) {
        Reflect.deleteProperty(nextNodes, nodeId);
        removed = true;
      }
    }
  }

  let nextLeaf: string | null = tree.activeLeafMessageId;
  const visited = new Set<string>();
  while (nextLeaf !== null && !Object.hasOwn(nextNodes, nextLeaf)) {
    if (visited.has(nextLeaf)) {
      nextLeaf = null;
      break;
    }
    visited.add(nextLeaf);
    const originalNode = getOwn(tree.nodes as Record<string, unknown>, nextLeaf) as
      | TranscriptMessageNode
      | undefined;
    nextLeaf = originalNode ? originalNode.parentMessageId : null;
  }

  return {
    nodes: nextNodes,
    activeLeafMessageId: nextLeaf,
    checkpoints: nextCheckpoints,
  };
}

/**
 * Fork a save directory at `atTurn` into `targetDir` with `newSessionId`, setting
 * `parentSaveId` and `branchAtTurn` in the target manifest, trimming `events.jsonl`
 * and `audit.jsonl` to `turn <= atTurn`, and materializing a checkpoint at `atTurn`.
 */
export async function branchSave(
  sourceDir: string,
  atTurn: number,
  targetDir: string,
  newSessionId: string
): Promise<Result<SaveManifest, ValidationError[]>> {
  if (typeof sourceDir !== 'string' || sourceDir.trim().length === 0) {
    return err([validationError('sourceDir', 'REQUIRED', 'sourceDir must be a non-empty string')]);
  }
  if (typeof targetDir !== 'string' || targetDir.trim().length === 0) {
    return err([validationError('targetDir', 'REQUIRED', 'targetDir must be a non-empty string')]);
  }
  if (path.resolve(sourceDir) === path.resolve(targetDir)) {
    return err([
      validationError('targetDir', 'SAME_DIRECTORY', 'targetDir must differ from sourceDir'),
    ]);
  }
  if (typeof atTurn !== 'number' || !Number.isInteger(atTurn) || atTurn < 0) {
    return err([validationError('atTurn', 'INVALID_TURN', 'atTurn must be a non-negative integer')]);
  }
  if (typeof newSessionId !== 'string' || newSessionId.trim().length === 0) {
    return err([
      validationError('newSessionId', 'REQUIRED', 'newSessionId must be a non-empty string'),
    ]);
  }

  const loadedRes = await loadSessionSave(sourceDir);
  if (!loadedRes.ok) {
    return err(loadedRes.error);
  }
  const loaded = loadedRes.value;

  const maxCheckpointTurn = loaded.checkpoints.reduce((max, cp) => Math.max(max, cp.turn), 0);
  const maxEventTurn = loaded.events.reduce((max, ev) => Math.max(max, ev.turn), 0);
  const maxAvailableTurn = Math.max(maxCheckpointTurn, maxEventTurn, loaded.manifest.currentTurn);

  if (atTurn > maxAvailableTurn) {
    return err([
      validationError(
        'atTurn',
        'BRANCH_TURN_OUT_OF_RANGE',
        `Cannot branch at turn ${atTurn}; source save max turn is ${maxAvailableTurn}`
      ),
    ]);
  }

  const checkpointsUpToTurn = loaded.checkpoints.filter((cp) => cp.turn <= atTurn);
  const baseCheckpoint =
    checkpointsUpToTurn.length > 0
      ? checkpointsUpToTurn[checkpointsUpToTurn.length - 1]
      : undefined;

  if (!baseCheckpoint) {
    return err([
      validationError(
        'atTurn',
        'MISSING_BASE_CHECKPOINT',
        `No checkpoint found at or before turn ${atTurn} in "${sourceDir}"`
      ),
    ]);
  }

  const eventsUpToTurn = loaded.events.filter((ev) => ev.turn <= atTurn);
  const auditUpToTurn = loaded.auditEntries.filter((entry) => entry.turn <= atTurn);

  let branchSnapshotState: WorldState | undefined;
  let branchBeatLedger: Record<string, unknown> = {};
  let branchCombatState: Record<string, unknown> | null | undefined;

  if (baseCheckpoint.turn === atTurn) {
    branchSnapshotState = baseCheckpoint.worldState;
    branchBeatLedger = baseCheckpoint.beatLedger;
    branchCombatState = baseCheckpoint.combatState;
  } else {
    const deltaEvents = eventsUpToTurn.filter((ev) => ev.turn > baseCheckpoint.turn);
    const replayRes = replayFromEvents(baseCheckpoint.worldState, deltaEvents, {
      targetTurn: atTurn,
    });
    if (!replayRes.ok) {
      return err(replayRes.error);
    }
    branchSnapshotState = replayRes.value.finalState;
    branchBeatLedger = baseCheckpoint.beatLedger;
    branchCombatState = baseCheckpoint.combatState;
  }

  const initRes = await initSaveDirectory(targetDir, {
    sessionId: newSessionId,
    cartridgeId: loaded.manifest.cartridgeId,
    systemPackId: loaded.manifest.systemPackId,
    schemaVersion: CURRENT_STATE_SCHEMA_VERSION,
    currentTurn: atTurn,
    parentSaveId: loaded.manifest.sessionId,
    branchAtTurn: atTurn,
    checkpointInterval: loaded.manifest.checkpointInterval,
  });
  if (!initRes.ok) {
    return err(initRes.error);
  }

  for (const cp of checkpointsUpToTurn) {
    const cpSaveRes = await saveCheckpointAtomic(
      targetDir,
      cp.turn,
      cp.worldState,
      cp.beatLedger,
      cp.combatState
    );
    if (!cpSaveRes.ok) {
      return err(cpSaveRes.error);
    }
  }

  if (baseCheckpoint.turn !== atTurn && branchSnapshotState !== undefined) {
    const branchCpRes = await saveCheckpointAtomic(
      targetDir,
      atTurn,
      branchSnapshotState,
      branchBeatLedger,
      branchCombatState
    );
    if (!branchCpRes.ok) {
      return err(branchCpRes.error);
    }
  }

  const eventsText =
    eventsUpToTurn.length > 0
      ? `${eventsUpToTurn.map((e) => JSON.stringify(e)).join('\n')}\n`
      : '';
  await atomicWriteText(path.join(targetDir, 'events.jsonl'), eventsText);

  const auditText =
    auditUpToTurn.length > 0
      ? `${auditUpToTurn.map((a) => JSON.stringify(a)).join('\n')}\n`
      : '';
  await atomicWriteText(path.join(targetDir, 'audit.jsonl'), auditText);

  if (loaded.swipeTree !== null) {
    const prunedTree = pruneSwipeTreeAtTurn(loaded.swipeTree, atTurn);
    const treeRes = await saveSwipeTreeAtomic(targetDir, prunedTree);
    if (!treeRes.ok) {
      return err(treeRes.error);
    }
  }

  if (loaded.userControlRoomLayer !== null && loaded.userControlRoomLayer !== undefined) {
    const crRes = await saveControlRoomLayerAtomic(targetDir, loaded.userControlRoomLayer);
    if (!crRes.ok) {
      return err(crRes.error);
    }
  }

  if (await fileExists(path.join(sourceDir, 'persona.json'))) {
    const personaRes = await saveActivePersonaAtomic(targetDir, loaded.activePersona ?? null);
    if (!personaRes.ok) {
      return err(personaRes.error);
    }
  }

  return ok(initRes.value);
}
