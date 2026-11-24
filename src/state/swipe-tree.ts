import { RefereeError, type ValidationError, validationError } from '../core/errors.js';
import type { RngState } from '../core/prng.js';
import { type Result, err, ok } from '../core/result.js';
import { type WorldState, validateWorldState } from './world-state.js';

export interface StateCheckpoint {
  checkpointId: string;
  turn: number;
  worldState: WorldState;
  beatLedger: Record<string, unknown>;
  rngState: RngState;
  stateHash: string;
}

export interface SwipeVariant {
  swipeIndex: number;
  content: string;
  stateCheckpointId: string;
  createdAtSeq: number;
}

export interface TranscriptMessageNode {
  messageId: string;
  parentMessageId: string | null;
  role: 'user' | 'assistant' | 'system';
  swipes: SwipeVariant[];
  activeSwipeIndex: number;
}

export interface SwipeTreeState {
  nodes: Record<string, TranscriptMessageNode>;
  activeLeafMessageId: string | null;
  checkpoints: Record<string, StateCheckpoint>;
}

export interface AppendMessageTurnParams {
  messageId: string;
  parentMessageId: string | null;
  role: 'user' | 'assistant' | 'system';
  content: string;
  checkpoint: StateCheckpoint;
  createdAtSeq?: number;
}

export interface RecordSwipeVariantParams {
  content: string;
  checkpoint: StateCheckpoint;
  createdAtSeq: number;
}

export interface LinearTranscriptEntry {
  messageId: string;
  role: string;
  content: string;
  swipeIndex: number;
}

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
const VALID_ROLES: ReadonlySet<string> = new Set(['user', 'assistant', 'system']);

const UTF8_ENCODER = new TextEncoder();
const FNV_OFFSET_BASIS_64 = 0xcbf29ce484222325n;
const FNV_PRIME_64 = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

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

function getOwn<T>(record: Record<string, T>, key: string): T | undefined {
  if (!isSafeKey(key) || !Object.hasOwn(record, key)) {
    return undefined;
  }
  return Object.getOwnPropertyDescriptor(record, key)?.value as T | undefined;
}

function setOwn<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function compareStringsLex(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

function canonicalSerializeValue(value: unknown, seen: WeakSet<object>): string {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return 'null';
    }
    return JSON.stringify(value === 0 ? 0 : value);
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'bigint') {
    return JSON.stringify(value.toString());
  }
  if (typeof value === 'object') {
    if (seen.has(value)) {
      throw new RefereeError('Circular reference detected while computing state hash', {
        code: 'CIRCULAR_STATE_REFERENCE',
      });
    }
    seen.add(value);
    try {
      if (value instanceof Date) {
        return Number.isFinite(value.getTime()) ? JSON.stringify(value.toISOString()) : 'null';
      }
      if (Array.isArray(value)) {
        const parts: string[] = [];
        for (let i = 0; i < value.length; i += 1) {
          const item = value[i];
          if (item === undefined || typeof item === 'function' || typeof item === 'symbol') {
            parts.push('null');
          } else {
            parts.push(canonicalSerializeValue(item, seen));
          }
        }
        return `[${parts.join(',')}]`;
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).filter(isSafeKey).sort(compareStringsLex);
      const parts: string[] = [];
      for (const key of keys) {
        const propVal = Object.getOwnPropertyDescriptor(record, key)?.value;
        if (
          propVal === undefined ||
          typeof propVal === 'function' ||
          typeof propVal === 'symbol'
        ) {
          continue;
        }
        parts.push(`${JSON.stringify(key)}:${canonicalSerializeValue(propVal, seen)}`);
      }
      return `{${parts.join(',')}}`;
    } finally {
      seen.delete(value);
    }
  }
  return 'null';
}

function fnv1a64Hex(input: string): string {
  const bytes = UTF8_ENCODER.encode(input);
  let hash = FNV_OFFSET_BASIS_64;
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i];
    if (byte !== undefined) {
      hash ^= BigInt(byte);
      hash = (hash * FNV_PRIME_64) & MASK_64;
    }
  }
  return hash.toString(16).padStart(16, '0');
}

/**
 * Compute a pure deterministic 64-bit FNV-1a hash over canonical sorted-key JSON
 * of `worldState` and optional `beatLedger`.
 */
export function computeStateHash(
  worldState: WorldState,
  beatLedger?: Record<string, unknown>
): string {
  const canonicalPayload = {
    beatLedger: beatLedger ?? {},
    worldState,
  };
  const canonicalJson = canonicalSerializeValue(canonicalPayload, new WeakSet<object>());
  return fnv1a64Hex(canonicalJson);
}

function cloneUnknownSafe(value: unknown, path: string): Result<unknown, ValidationError[]> {
  if (Array.isArray(value)) {
    const arr: unknown[] = [];
    for (let i = 0; i < value.length; i += 1) {
      const itemRes = cloneUnknownSafe(value[i], `${path}[${i}]`);
      if (!itemRes.ok) {
        return itemRes;
      }
      arr.push(itemRes.value);
    }
    return ok(arr);
  }
  if (value instanceof Date) {
    return ok(new Date(value.getTime()));
  }
  if (value !== null && typeof value === 'object') {
    if (!isPlainObject(value)) {
      return err([
        validationError(path, 'INVALID_TYPE', `${path} must be a plain JSON-safe object`),
      ]);
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.getOwnPropertyNames(value)) {
      if (!isSafeKey(key)) {
        return err([
          validationError(`${path}.${key}`, 'UNSAFE_KEY', `Forbidden key "${key}" at ${path}`),
        ]);
      }
      const rawChild = Object.getOwnPropertyDescriptor(value, key)?.value;
      const childRes = cloneUnknownSafe(rawChild, `${path}.${key}`);
      if (!childRes.ok) {
        return childRes;
      }
      setOwn(out, key, childRes.value);
    }
    return ok(out);
  }
  return ok(value);
}

function cloneRngState(rngState: RngState): RngState {
  if (rngState.type === 'queued') {
    return {
      type: 'queued',
      queue: [...rngState.queue],
      cursor: rngState.cursor,
      fallback: { ...rngState.fallback },
      drawCount: rngState.drawCount,
    };
  }
  return { ...rngState };
}

function isValidRngState(value: unknown): value is RngState {
  if (!isPlainObject(value)) {
    return false;
  }
  if (value.type === 'xoshiro128**') {
    return (
      typeof value.s0 === 'number' &&
      Number.isInteger(value.s0) &&
      value.s0 >= 0 &&
      typeof value.s1 === 'number' &&
      Number.isInteger(value.s1) &&
      value.s1 >= 0 &&
      typeof value.s2 === 'number' &&
      Number.isInteger(value.s2) &&
      value.s2 >= 0 &&
      typeof value.s3 === 'number' &&
      Number.isInteger(value.s3) &&
      value.s3 >= 0 &&
      (value.s0 | value.s1 | value.s2 | value.s3) !== 0 &&
      typeof value.drawCount === 'number' &&
      Number.isInteger(value.drawCount) &&
      value.drawCount >= 0
    );
  }
  if (value.type === 'queued') {
    return (
      Array.isArray(value.queue) &&
      value.queue.every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1) &&
      typeof value.cursor === 'number' &&
      Number.isInteger(value.cursor) &&
      value.cursor >= 0 &&
      typeof value.drawCount === 'number' &&
      Number.isInteger(value.drawCount) &&
      value.drawCount >= 0 &&
      isValidRngState(value.fallback) &&
      value.fallback.type === 'xoshiro128**'
    );
  }
  return false;
}

function cloneStateCheckpoint(checkpoint: StateCheckpoint): Result<StateCheckpoint, ValidationError[]> {
  if (!isPlainObject(checkpoint)) {
    return err([validationError('checkpoint', 'INVALID_TYPE', 'checkpoint must be a plain object')]);
  }
  if (typeof checkpoint.checkpointId !== 'string' || checkpoint.checkpointId.trim().length === 0) {
    return err([
      validationError(
        'checkpoint.checkpointId',
        'INVALID_ID',
        'checkpointId must be a safe non-empty string'
      ),
    ]);
  }
  if (!isSafeKey(checkpoint.checkpointId)) {
    return err([
      validationError(
        'checkpoint.checkpointId',
        'UNSAFE_KEY',
        `Forbidden checkpointId "${checkpoint.checkpointId}"`
      ),
    ]);
  }
  if (typeof checkpoint.turn !== 'number' || !Number.isInteger(checkpoint.turn) || checkpoint.turn < 0) {
    return err([
      validationError('checkpoint.turn', 'INVALID_TURN', 'checkpoint.turn must be a non-negative integer'),
    ]);
  }
  if (typeof checkpoint.stateHash !== 'string' || checkpoint.stateHash.trim().length === 0) {
    return err([
      validationError('checkpoint.stateHash', 'REQUIRED', 'checkpoint.stateHash must be a non-empty string'),
    ]);
  }
  if (!isPlainObject(checkpoint.beatLedger)) {
    return err([
      validationError('checkpoint.beatLedger', 'INVALID_TYPE', 'checkpoint.beatLedger must be a plain object'),
    ]);
  }
  if (!isPlainObject(checkpoint.worldState)) {
    return err([
      validationError('checkpoint.worldState', 'INVALID_TYPE', 'checkpoint.worldState must be a plain object'),
    ]);
  }
  if (!isValidRngState(checkpoint.rngState)) {
    return err([
      validationError('checkpoint.rngState', 'INVALID_RNG_STATE', 'checkpoint.rngState must be a valid RngState'),
    ]);
  }
  const clonedLedger = cloneUnknownSafe(checkpoint.beatLedger, 'checkpoint.beatLedger');
  if (!clonedLedger.ok) {
    return clonedLedger;
  }

  const wsValidation = validateWorldState(checkpoint.worldState);
  if (!wsValidation.ok) {
    return err(wsValidation.error);
  }

  return ok({
    checkpointId: checkpoint.checkpointId,
    turn: checkpoint.turn,
    worldState: wsValidation.value.state,
    beatLedger: clonedLedger.value as Record<string, unknown>,
    rngState: cloneRngState(checkpoint.rngState),
    stateHash: checkpoint.stateHash,
  });
}

function cloneNode(node: TranscriptMessageNode): TranscriptMessageNode {
  return {
    messageId: node.messageId,
    parentMessageId: node.parentMessageId,
    role: node.role,
    swipes: node.swipes.map((s) => ({ ...s })),
    activeSwipeIndex: node.activeSwipeIndex,
  };
}

function cloneNodesMap(
  nodes: Record<string, TranscriptMessageNode>
): Record<string, TranscriptMessageNode> {
  const out: Record<string, TranscriptMessageNode> = {};
  for (const key of Object.keys(nodes)) {
    if (!isSafeKey(key)) {
      continue;
    }
    const node = getOwn(nodes, key);
    if (node) {
      setOwn(out, key, cloneNode(node));
    }
  }
  return out;
}

function cloneCheckpointsMap(
  checkpoints: Record<string, StateCheckpoint>
): Result<Record<string, StateCheckpoint>, ValidationError[]> {
  const out: Record<string, StateCheckpoint> = {};
  for (const key of Object.keys(checkpoints)) {
    if (!isSafeKey(key)) {
      return err([validationError(`checkpoints.${key}`, 'UNSAFE_KEY', `Forbidden checkpoint key "${key}"`)]);
    }
    const cp = getOwn(checkpoints, key);
    if (cp) {
      const cloned = cloneStateCheckpoint(cp);
      if (!cloned.ok) {
        return cloned;
      }
      setOwn(out, key, cloned.value);
    }
  }
  return ok(out);
}

function computeNextCreatedAtSeq(tree: SwipeTreeState): number {
  let maxSeq = 0;
  for (const key of Object.keys(tree.nodes)) {
    const node = getOwn(tree.nodes, key);
    if (!node) {
      continue;
    }
    for (const swipe of node.swipes) {
      if (swipe.createdAtSeq > maxSeq) {
        maxSeq = swipe.createdAtSeq;
      }
    }
  }
  return maxSeq + 1;
}

function storeCheckpoint(
  checkpoints: Record<string, StateCheckpoint>,
  checkpoint: StateCheckpoint
): Result<void, ValidationError[]> {
  const existing = getOwn(checkpoints, checkpoint.checkpointId);
  if (existing && existing.stateHash !== checkpoint.stateHash) {
    return err([
      validationError(
        'checkpoint.checkpointId',
        'CHECKPOINT_CONFLICT',
        `Checkpoint "${checkpoint.checkpointId}" already exists with a different stateHash`
      ),
    ]);
  }
  setOwn(checkpoints, checkpoint.checkpointId, checkpoint);
  return ok(undefined);
}

/**
 * Create a new {@link SwipeTreeState}, optionally seeded with an initial {@link StateCheckpoint}.
 */
export function createSwipeTree(initialCheckpoint?: StateCheckpoint): SwipeTreeState {
  const checkpoints: Record<string, StateCheckpoint> = {};
  if (initialCheckpoint !== undefined) {
    const cloned = cloneStateCheckpoint(initialCheckpoint);
    if (!cloned.ok) {
      throw new RefereeError('Invalid initialCheckpoint passed to createSwipeTree', {
        code: 'INVALID_INITIAL_CHECKPOINT',
        details: cloned.error,
      });
    }
    setOwn(checkpoints, cloned.value.checkpointId, cloned.value);
  }
  return {
    nodes: {},
    activeLeafMessageId: null,
    checkpoints,
  };
}

/**
 * Append a new message node (user, assistant, or system) onto the swipe tree
 * and advance `activeLeafMessageId` to the newly appended message.
 */
export function appendMessageTurn(
  tree: SwipeTreeState,
  params: AppendMessageTurnParams
): Result<SwipeTreeState, ValidationError[]> {
  const { messageId, parentMessageId, role, content, checkpoint, createdAtSeq } = params;

  if (typeof messageId !== 'string' || messageId.trim().length === 0) {
    return err([validationError('messageId', 'REQUIRED', 'messageId must be a non-empty string')]);
  }
  if (!isSafeKey(messageId)) {
    return err([validationError('messageId', 'UNSAFE_KEY', `Forbidden messageId "${messageId}"`)]);
  }
  if (Object.hasOwn(tree.nodes, messageId)) {
    return err([
      validationError('messageId', 'DUPLICATE_MESSAGE_ID', `Message node already exists: ${messageId}`),
    ]);
  }
  if (parentMessageId !== null) {
    if (typeof parentMessageId !== 'string' || !isSafeKey(parentMessageId)) {
      return err([
        validationError('parentMessageId', 'UNSAFE_KEY', 'parentMessageId must be a safe string or null'),
      ]);
    }
    if (!Object.hasOwn(tree.nodes, parentMessageId)) {
      return err([
        validationError('parentMessageId', 'MISSING_PARENT', `Parent message node not found: ${parentMessageId}`),
      ]);
    }
  }
  if (typeof role !== 'string' || !VALID_ROLES.has(role)) {
    return err([validationError('role', 'INVALID_ENUM', `Invalid message role "${String(role)}"`)]);
  }
  if (typeof content !== 'string') {
    return err([validationError('content', 'INVALID_TYPE', 'content must be a string')]);
  }
  if (
    createdAtSeq !== undefined &&
    (typeof createdAtSeq !== 'number' || !Number.isFinite(createdAtSeq) || createdAtSeq < 0)
  ) {
    return err([
      validationError('createdAtSeq', 'INVALID_NUMBER', 'createdAtSeq must be a finite number >= 0'),
    ]);
  }

  const clonedCheckpointRes = cloneStateCheckpoint(checkpoint);
  if (!clonedCheckpointRes.ok) {
    return clonedCheckpointRes;
  }

  const nextCheckpointsRes = cloneCheckpointsMap(tree.checkpoints);
  if (!nextCheckpointsRes.ok) {
    return nextCheckpointsRes;
  }
  const nextCheckpoints = nextCheckpointsRes.value;
  const storeRes = storeCheckpoint(nextCheckpoints, clonedCheckpointRes.value);
  if (!storeRes.ok) {
    return storeRes;
  }

  const nextNodes = cloneNodesMap(tree.nodes);
  const seq = createdAtSeq ?? computeNextCreatedAtSeq(tree);

  setOwn(nextNodes, messageId, {
    messageId,
    parentMessageId,
    role,
    swipes: [
      {
        swipeIndex: 0,
        content,
        stateCheckpointId: clonedCheckpointRes.value.checkpointId,
        createdAtSeq: seq,
      },
    ],
    activeSwipeIndex: 0,
  });

  return ok({
    nodes: nextNodes,
    activeLeafMessageId: messageId,
    checkpoints: nextCheckpoints,
  });
}

function findUnreferencedInitialCheckpoint(tree: SwipeTreeState): StateCheckpoint | undefined {
  const referencedIds = new Set<string>();
  for (const key of Object.keys(tree.nodes)) {
    const node = getOwn(tree.nodes, key);
    if (!node) {
      continue;
    }
    for (const swipe of node.swipes) {
      referencedIds.add(swipe.stateCheckpointId);
    }
  }

  let candidate: StateCheckpoint | undefined;
  for (const cpId of Object.keys(tree.checkpoints)) {
    if (referencedIds.has(cpId)) {
      continue;
    }
    const cp = getOwn(tree.checkpoints, cpId);
    if (cp && (candidate === undefined || cp.turn < candidate.turn)) {
      candidate = cp;
    }
  }
  return candidate;
}

/**
 * Retrieve the restored pre-turn {@link StateCheckpoint} from `targetAssistantMessageId`'s parent
 * (or the unreferenced initial checkpoint if rolling back a root message), so regenerating a
 * swipe never double-applies the discarded swipe's state changes.
 */
export function rollbackForSwipe(
  tree: SwipeTreeState,
  targetAssistantMessageId: string
): Result<{ restoredCheckpoint: StateCheckpoint; parentMessageId: string | null }, ValidationError[]> {
  if (typeof targetAssistantMessageId !== 'string' || !isSafeKey(targetAssistantMessageId)) {
    return err([
      validationError(
        'targetAssistantMessageId',
        'UNSAFE_KEY',
        'targetAssistantMessageId must be a safe non-empty string'
      ),
    ]);
  }
  const targetNode = getOwn(tree.nodes, targetAssistantMessageId);
  if (!targetNode) {
    return err([
      validationError(
        'targetAssistantMessageId',
        'NOT_FOUND',
        `Message node not found: ${targetAssistantMessageId}`
      ),
    ]);
  }

  const parentId = targetNode.parentMessageId;
  if (parentId === null) {
    const initialCp = findUnreferencedInitialCheckpoint(tree);
    if (!initialCp) {
      return err([
        validationError(
          'parentMessageId',
          'NO_PARENT_CHECKPOINT',
          `Root message "${targetAssistantMessageId}" has no parent or initial checkpoint for rollback`
        ),
      ]);
    }
    const clonedInitial = cloneStateCheckpoint(initialCp);
    if (!clonedInitial.ok) {
      return clonedInitial;
    }
    return ok({
      restoredCheckpoint: clonedInitial.value,
      parentMessageId: null,
    });
  }

  const parentNode = getOwn(tree.nodes, parentId);
  if (!parentNode) {
    return err([
      validationError('parentMessageId', 'MISSING_PARENT', `Parent node not found: ${parentId}`),
    ]);
  }

  const parentActiveSwipe = parentNode.swipes[parentNode.activeSwipeIndex];
  if (!parentActiveSwipe) {
    return err([
      validationError(
        'activeSwipeIndex',
        'MISSING_SWIPE',
        `Parent active swipe index ${parentNode.activeSwipeIndex} not found on "${parentId}"`
      ),
    ]);
  }

  const parentCheckpoint = getOwn(tree.checkpoints, parentActiveSwipe.stateCheckpointId);
  if (!parentCheckpoint) {
    return err([
      validationError(
        'stateCheckpointId',
        'MISSING_CHECKPOINT',
        `Parent checkpoint not found: ${parentActiveSwipe.stateCheckpointId}`
      ),
    ]);
  }

  const clonedParentCp = cloneStateCheckpoint(parentCheckpoint);
  if (!clonedParentCp.ok) {
    return clonedParentCp;
  }

  return ok({
    restoredCheckpoint: clonedParentCp.value,
    parentMessageId: parentId,
  });
}

/**
 * Record a newly generated swipe variant on `targetAssistantMessageId` and make it active.
 */
export function recordSwipeVariant(
  tree: SwipeTreeState,
  targetAssistantMessageId: string,
  params: RecordSwipeVariantParams
): Result<{ nextTree: SwipeTreeState; newSwipeIndex: number }, ValidationError[]> {
  if (typeof targetAssistantMessageId !== 'string' || !isSafeKey(targetAssistantMessageId)) {
    return err([
      validationError(
        'targetAssistantMessageId',
        'UNSAFE_KEY',
        'targetAssistantMessageId must be a safe non-empty string'
      ),
    ]);
  }
  const targetNode = getOwn(tree.nodes, targetAssistantMessageId);
  if (!targetNode) {
    return err([
      validationError(
        'targetAssistantMessageId',
        'NOT_FOUND',
        `Message node not found: ${targetAssistantMessageId}`
      ),
    ]);
  }
  if (typeof params.content !== 'string') {
    return err([validationError('content', 'INVALID_TYPE', 'content must be a string')]);
  }
  if (
    typeof params.createdAtSeq !== 'number' ||
    !Number.isFinite(params.createdAtSeq) ||
    params.createdAtSeq < 0
  ) {
    return err([
      validationError('createdAtSeq', 'INVALID_NUMBER', 'createdAtSeq must be a finite number >= 0'),
    ]);
  }

  const clonedCheckpointRes = cloneStateCheckpoint(params.checkpoint);
  if (!clonedCheckpointRes.ok) {
    return clonedCheckpointRes;
  }

  const nextCheckpointsRes = cloneCheckpointsMap(tree.checkpoints);
  if (!nextCheckpointsRes.ok) {
    return nextCheckpointsRes;
  }
  const nextCheckpoints = nextCheckpointsRes.value;
  const storeRes = storeCheckpoint(nextCheckpoints, clonedCheckpointRes.value);
  if (!storeRes.ok) {
    return storeRes;
  }

  const nextNodes = cloneNodesMap(tree.nodes);
  const clonedTarget = getOwn(nextNodes, targetAssistantMessageId) as TranscriptMessageNode;
  const newSwipeIndex = clonedTarget.swipes.length;

  clonedTarget.swipes.push({
    swipeIndex: newSwipeIndex,
    content: params.content,
    stateCheckpointId: clonedCheckpointRes.value.checkpointId,
    createdAtSeq: params.createdAtSeq,
  });
  clonedTarget.activeSwipeIndex = newSwipeIndex;

  return ok({
    nextTree: {
      nodes: nextNodes,
      activeLeafMessageId: targetAssistantMessageId,
      checkpoints: nextCheckpoints,
    },
    newSwipeIndex,
  });
}

/**
 * Switch the active swipe variant on `messageId` to `swipeIndex` and return the
 * cloned {@link StateCheckpoint} coupled to that variant.
 */
export function activateSwipeVariant(
  tree: SwipeTreeState,
  messageId: string,
  swipeIndex: number
): Result<{ nextTree: SwipeTreeState; restoredCheckpoint: StateCheckpoint }, ValidationError[]> {
  if (typeof messageId !== 'string' || !isSafeKey(messageId)) {
    return err([
      validationError('messageId', 'UNSAFE_KEY', 'messageId must be a safe non-empty string'),
    ]);
  }
  const node = getOwn(tree.nodes, messageId);
  if (!node) {
    return err([validationError('messageId', 'NOT_FOUND', `Message node not found: ${messageId}`)]);
  }
  if (!Number.isInteger(swipeIndex) || swipeIndex < 0 || swipeIndex >= node.swipes.length) {
    return err([
      validationError(
        'swipeIndex',
        'INVALID_SWIPE_INDEX',
        `Invalid swipeIndex ${swipeIndex} for message "${messageId}"`
      ),
    ]);
  }

  const targetSwipe = node.swipes[swipeIndex];
  if (!targetSwipe) {
    return err([
      validationError('swipeIndex', 'MISSING_SWIPE', `Swipe ${swipeIndex} missing on "${messageId}"`),
    ]);
  }

  const checkpoint = getOwn(tree.checkpoints, targetSwipe.stateCheckpointId);
  if (!checkpoint) {
    return err([
      validationError(
        'stateCheckpointId',
        'MISSING_CHECKPOINT',
        `Checkpoint not found for swipe: ${targetSwipe.stateCheckpointId}`
      ),
    ]);
  }

  const nextCheckpointsRes = cloneCheckpointsMap(tree.checkpoints);
  if (!nextCheckpointsRes.ok) {
    return nextCheckpointsRes;
  }
  const clonedCpRes = cloneStateCheckpoint(checkpoint);
  if (!clonedCpRes.ok) {
    return clonedCpRes;
  }

  const nextNodes = cloneNodesMap(tree.nodes);
  const nextTarget = getOwn(nextNodes, messageId) as TranscriptMessageNode;
  nextTarget.activeSwipeIndex = swipeIndex;

  return ok({
    nextTree: {
      nodes: nextNodes,
      activeLeafMessageId: messageId,
      checkpoints: nextCheckpointsRes.value,
    },
    restoredCheckpoint: clonedCpRes.value,
  });
}

/**
 * Edit the text of `nodeId` by appending a new active swipe variant bound to the node's
 * checkpoint and rewinding `activeLeafMessageId` to `nodeId` so subsequent turns fork cleanly.
 */
export function editMessageNode(
  tree: SwipeTreeState,
  nodeId: string,
  newContent: string
): Result<
  { nextTree: SwipeTreeState; restoredCheckpoint: StateCheckpoint; swipeIndex: number },
  ValidationError[]
> {
  if (typeof nodeId !== 'string' || !isSafeKey(nodeId)) {
    return err([
      validationError('nodeId', 'UNSAFE_KEY', 'nodeId must be a safe non-empty string'),
    ]);
  }
  if (typeof newContent !== 'string') {
    return err([validationError('newContent', 'INVALID_TYPE', 'newContent must be a string')]);
  }

  const node = getOwn(tree.nodes, nodeId);
  if (!node) {
    return err([validationError('nodeId', 'NOT_FOUND', `Message node not found: ${nodeId}`)]);
  }

  const activeSwipe = node.swipes[node.activeSwipeIndex] ?? node.swipes[0];
  if (!activeSwipe) {
    return err([
      validationError('swipes', 'MISSING_SWIPE', `Node "${nodeId}" has no swipe variants`),
    ]);
  }

  const checkpoint = getOwn(tree.checkpoints, activeSwipe.stateCheckpointId);
  if (!checkpoint) {
    return err([
      validationError(
        'stateCheckpointId',
        'MISSING_CHECKPOINT',
        `Checkpoint not found for node "${nodeId}": ${activeSwipe.stateCheckpointId}`
      ),
    ]);
  }

  const nextCheckpointsRes = cloneCheckpointsMap(tree.checkpoints);
  if (!nextCheckpointsRes.ok) {
    return nextCheckpointsRes;
  }
  const clonedCpRes = cloneStateCheckpoint(checkpoint);
  if (!clonedCpRes.ok) {
    return clonedCpRes;
  }

  const nextNodes = cloneNodesMap(tree.nodes);
  const clonedTarget = getOwn(nextNodes, nodeId) as TranscriptMessageNode;
  const newSwipeIndex = clonedTarget.swipes.length;
  const maxSeq = clonedTarget.swipes.reduce((max, s) => Math.max(max, s.createdAtSeq), 0);

  clonedTarget.swipes.push({
    swipeIndex: newSwipeIndex,
    content: newContent,
    stateCheckpointId: activeSwipe.stateCheckpointId,
    createdAtSeq: maxSeq + 1,
  });
  clonedTarget.activeSwipeIndex = newSwipeIndex;

  return ok({
    nextTree: {
      nodes: nextNodes,
      activeLeafMessageId: nodeId,
      checkpoints: nextCheckpointsRes.value,
    },
    restoredCheckpoint: clonedCpRes.value,
    swipeIndex: newSwipeIndex,
  });
}

/**
 * Resolve and rewind the active leaf to `nodeId` (or the current `activeLeafMessageId`)
 * so the runtime can continue assistant narration from that exact checkpoint.
 */
export function prepareContinueFromNode(
  tree: SwipeTreeState,
  nodeId?: string
): Result<
  {
    nextTree: SwipeTreeState;
    targetNodeId: string;
    role: TranscriptMessageNode['role'];
    content: string;
    restoredCheckpoint: StateCheckpoint;
  },
  ValidationError[]
> {
  const targetNodeId = nodeId ?? tree.activeLeafMessageId;
  if (targetNodeId === null || typeof targetNodeId !== 'string' || !isSafeKey(targetNodeId)) {
    return err([
      validationError(
        'nodeId',
        targetNodeId === null ? 'NO_ACTIVE_LEAF' : 'UNSAFE_KEY',
        targetNodeId === null
          ? 'Cannot continue from an empty swipe tree'
          : 'nodeId must be a safe non-empty string'
      ),
    ]);
  }

  const node = getOwn(tree.nodes, targetNodeId);
  if (!node) {
    return err([
      validationError('nodeId', 'NOT_FOUND', `Message node not found: ${targetNodeId}`),
    ]);
  }

  const activeSwipe = node.swipes[node.activeSwipeIndex] ?? node.swipes[0];
  if (!activeSwipe) {
    return err([
      validationError('swipes', 'MISSING_SWIPE', `Node "${targetNodeId}" has no swipe variants`),
    ]);
  }

  const checkpoint = getOwn(tree.checkpoints, activeSwipe.stateCheckpointId);
  if (!checkpoint) {
    return err([
      validationError(
        'stateCheckpointId',
        'MISSING_CHECKPOINT',
        `Checkpoint not found for node "${targetNodeId}": ${activeSwipe.stateCheckpointId}`
      ),
    ]);
  }

  const nextCheckpointsRes = cloneCheckpointsMap(tree.checkpoints);
  if (!nextCheckpointsRes.ok) {
    return nextCheckpointsRes;
  }
  const clonedCpRes = cloneStateCheckpoint(checkpoint);
  if (!clonedCpRes.ok) {
    return clonedCpRes;
  }

  const nextNodes = cloneNodesMap(tree.nodes);

  return ok({
    nextTree: {
      nodes: nextNodes,
      activeLeafMessageId: targetNodeId,
      checkpoints: nextCheckpointsRes.value,
    },
    targetNodeId,
    role: node.role,
    content: activeSwipe.content,
    restoredCheckpoint: clonedCpRes.value,
  });
}

/**
 * Walk from root to `activeLeafMessageId` via `parentMessageId` links and return
 * the active linear transcript, optionally truncated to the most recent `limit` messages.
 */
export function getLinearTranscript(
  tree: SwipeTreeState,
  limit?: number
): LinearTranscriptEntry[] {
  if (limit !== undefined && limit <= 0) {
    return [];
  }

  const pathNodes: TranscriptMessageNode[] = [];
  const visited = new Set<string>();
  let currId: string | null = tree.activeLeafMessageId;

  while (currId !== null) {
    if (!isSafeKey(currId) || visited.has(currId)) {
      break;
    }
    visited.add(currId);
    const node = getOwn(tree.nodes, currId);
    if (!node) {
      break;
    }
    pathNodes.push(node);
    currId = node.parentMessageId;
  }

  pathNodes.reverse();

  const entries: LinearTranscriptEntry[] = [];
  for (const node of pathNodes) {
    const activeSwipe = node.swipes[node.activeSwipeIndex] ?? node.swipes[0];
    if (activeSwipe) {
      entries.push({
        messageId: node.messageId,
        role: node.role,
        content: activeSwipe.content,
        swipeIndex: activeSwipe.swipeIndex,
      });
    }
  }

  if (limit !== undefined && entries.length > limit) {
    return entries.slice(entries.length - limit);
  }

  return entries;
}

/**
 * Validate and clone an unknown deserialized {@link SwipeTreeState}.
 */
export function validateSwipeTreeState(raw: unknown): Result<SwipeTreeState, ValidationError[]> {
  if (!isPlainObject(raw)) {
    return err([validationError('', 'INVALID_TYPE', 'SwipeTreeState must be a plain object')]);
  }

  if (!isPlainObject(raw.nodes)) {
    return err([validationError('nodes', 'INVALID_TYPE', 'SwipeTreeState.nodes must be a plain object')]);
  }
  if (!isPlainObject(raw.checkpoints)) {
    return err([
      validationError('checkpoints', 'INVALID_TYPE', 'SwipeTreeState.checkpoints must be a plain object'),
    ]);
  }

  const activeLeaf = raw.activeLeafMessageId;
  if (activeLeaf !== null && (typeof activeLeaf !== 'string' || !isSafeKey(activeLeaf))) {
    return err([
      validationError(
        'activeLeafMessageId',
        'INVALID_TYPE',
        'activeLeafMessageId must be a safe string or null'
      ),
    ]);
  }

  const checkpoints: Record<string, StateCheckpoint> = {};
  for (const cpKey of Object.getOwnPropertyNames(raw.checkpoints)) {
    if (!isSafeKey(cpKey)) {
      return err([
        validationError(`checkpoints.${cpKey}`, 'UNSAFE_KEY', `Forbidden checkpoint key "${cpKey}"`),
      ]);
    }
    const rawCp = Object.getOwnPropertyDescriptor(raw.checkpoints, cpKey)?.value;
    const clonedCp = cloneStateCheckpoint(rawCp as StateCheckpoint);
    if (!clonedCp.ok) {
      return clonedCp;
    }
    if (clonedCp.value.checkpointId !== cpKey) {
      return err([
        validationError(
          `checkpoints.${cpKey}.checkpointId`,
          'ID_MISMATCH',
          `Checkpoint id "${clonedCp.value.checkpointId}" must match key "${cpKey}"`
        ),
      ]);
    }
    setOwn(checkpoints, cpKey, clonedCp.value);
  }

  const nodes: Record<string, TranscriptMessageNode> = {};
  for (const nodeKey of Object.getOwnPropertyNames(raw.nodes)) {
    if (!isSafeKey(nodeKey)) {
      return err([validationError(`nodes.${nodeKey}`, 'UNSAFE_KEY', `Forbidden node key "${nodeKey}"`)]);
    }
    const rawNode = Object.getOwnPropertyDescriptor(raw.nodes, nodeKey)?.value;
    if (!isPlainObject(rawNode)) {
      return err([
        validationError(`nodes.${nodeKey}`, 'INVALID_TYPE', 'TranscriptMessageNode must be a plain object'),
      ]);
    }
    if (rawNode.messageId !== nodeKey) {
      return err([
        validationError(
          `nodes.${nodeKey}.messageId`,
          'ID_MISMATCH',
          `Node messageId "${String(rawNode.messageId)}" must match key "${nodeKey}"`
        ),
      ]);
    }
    const parentId = rawNode.parentMessageId;
    if (parentId !== null && (typeof parentId !== 'string' || !isSafeKey(parentId))) {
      return err([
        validationError(
          `nodes.${nodeKey}.parentMessageId`,
          'INVALID_TYPE',
          'parentMessageId must be a safe string or null'
        ),
      ]);
    }
    if (typeof rawNode.role !== 'string' || !VALID_ROLES.has(rawNode.role)) {
      return err([
        validationError(
          `nodes.${nodeKey}.role`,
          'INVALID_ENUM',
          `Invalid role "${String(rawNode.role)}"`
        ),
      ]);
    }
    if (!Array.isArray(rawNode.swipes) || rawNode.swipes.length === 0) {
      return err([
        validationError(`nodes.${nodeKey}.swipes`, 'INVALID_TYPE', 'swipes must be a non-empty array'),
      ]);
    }

    const swipes: SwipeVariant[] = [];
    for (let i = 0; i < rawNode.swipes.length; i += 1) {
      const rawSwipe = rawNode.swipes[i];
      const swipePath = `nodes.${nodeKey}.swipes[${i}]`;
      if (!isPlainObject(rawSwipe)) {
        return err([validationError(swipePath, 'INVALID_TYPE', 'SwipeVariant must be an object')]);
      }
      if (typeof rawSwipe.swipeIndex !== 'number' || !Number.isInteger(rawSwipe.swipeIndex) || rawSwipe.swipeIndex !== i) {
        return err([
          validationError(`${swipePath}.swipeIndex`, 'INVALID_SWIPE_INDEX', `swipeIndex must equal ${i}`),
        ]);
      }
      if (typeof rawSwipe.content !== 'string') {
        return err([validationError(`${swipePath}.content`, 'INVALID_TYPE', 'content must be a string')]);
      }
      if (
        typeof rawSwipe.stateCheckpointId !== 'string' ||
        !isSafeKey(rawSwipe.stateCheckpointId) ||
        !Object.hasOwn(checkpoints, rawSwipe.stateCheckpointId)
      ) {
        return err([
          validationError(
            `${swipePath}.stateCheckpointId`,
            'MISSING_CHECKPOINT',
            `Unknown or invalid stateCheckpointId "${String(rawSwipe.stateCheckpointId)}"`
          ),
        ]);
      }
      if (
        typeof rawSwipe.createdAtSeq !== 'number' ||
        !Number.isFinite(rawSwipe.createdAtSeq) ||
        rawSwipe.createdAtSeq < 0
      ) {
        return err([
          validationError(
            `${swipePath}.createdAtSeq`,
            'INVALID_NUMBER',
            'createdAtSeq must be a finite number >= 0'
          ),
        ]);
      }
      swipes.push({
        swipeIndex: rawSwipe.swipeIndex,
        content: rawSwipe.content,
        stateCheckpointId: rawSwipe.stateCheckpointId,
        createdAtSeq: rawSwipe.createdAtSeq,
      });
    }

    if (
      typeof rawNode.activeSwipeIndex !== 'number' ||
      !Number.isInteger(rawNode.activeSwipeIndex) ||
      rawNode.activeSwipeIndex < 0 ||
      rawNode.activeSwipeIndex >= swipes.length
    ) {
      return err([
        validationError(
          `nodes.${nodeKey}.activeSwipeIndex`,
          'INVALID_SWIPE_INDEX',
          `activeSwipeIndex must be in [0, ${swipes.length - 1}]`
        ),
      ]);
    }

    setOwn(nodes, nodeKey, {
      messageId: nodeKey,
      parentMessageId: parentId,
      role: rawNode.role as TranscriptMessageNode['role'],
      swipes,
      activeSwipeIndex: rawNode.activeSwipeIndex,
    });
  }

  for (const nodeKey of Object.keys(nodes)) {
    const node = getOwn(nodes, nodeKey);
    if (node && node.parentMessageId !== null && !Object.hasOwn(nodes, node.parentMessageId)) {
      return err([
        validationError(
          `nodes.${nodeKey}.parentMessageId`,
          'MISSING_PARENT',
          `Parent node "${node.parentMessageId}" does not exist`
        ),
      ]);
    }
  }

  if (activeLeaf !== null && !Object.hasOwn(nodes, activeLeaf)) {
    return err([
      validationError(
        'activeLeafMessageId',
        'MISSING_LEAF',
        `activeLeafMessageId "${activeLeaf}" does not exist in nodes`
      ),
    ]);
  }

  return ok({
    nodes,
    activeLeafMessageId: activeLeaf,
    checkpoints,
  });
}
