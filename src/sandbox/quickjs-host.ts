import {
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSRuntime,
  type QuickJSWASMModule,
  getQuickJS,
  shouldInterruptAfterDeadline,
} from 'quickjs-emscripten';
import { rollDice } from '../core/dice.js';
import { type ValidationError, formatValidationErrors, validationError } from '../core/errors.js';
import { type RngState, nextFloat } from '../core/prng.js';
import { ErrorAccumulator, type Result, err, ok } from '../core/result.js';
import type { EntityCollectionName, PatchOperation } from '../state/patch.js';
import type { WorldState } from '../state/world-state.js';
import {
  type ScriptManifest,
  checkEntityWriteCapability,
  checkStateWriteCapability,
  hasCapability,
  validateScriptManifest,
} from './capabilities.js';

/**
 * Input configuration for executing an untrusted script inside QuickJS WASM.
 */
export interface SandboxExecutionInput {
  readonly code: string;
  readonly manifest: ScriptManifest;
  readonly stateSnapshot: WorldState;
  readonly rngState: RngState;
  readonly eventPayload?: Record<string, unknown>;
}

/**
 * Isolated output produced by a successful sandboxed script invocation.
 */
export interface SandboxExecutionOutput {
  readonly operations: PatchOperation[];
  readonly injectedPrompts: Array<{ section: string; text: string }>;
  readonly logs: string[];
  readonly nextRng: RngState;
  readonly resultValue: unknown;
}

const DEFAULT_TIMEOUT_MS = 50;
const DEFAULT_MEMORY_LIMIT_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_STACK_SIZE_BYTES = 256 * 1024;
const MAX_EXTRACT_DEPTH = 32;
const MAX_ARRAY_LENGTH = 10_000;

const VIRTUAL_EPOCH_MS = Date.UTC(2026, 0, 1, 0, 0, 0, 0);
const DAY_MS = 86_400_000;

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
const VALID_ENTITY_COLLECTIONS: ReadonlySet<string> = new Set<EntityCollectionName>([
  'characters',
  'factions',
  'threats',
  'locations',
]);

const BOOTSTRAP_DATE_SOURCE = `
(function(virtualNow) {
  'use strict';
  var OrigDate = globalThis.Date;
  function VirtualDate() {
    if (!new.target) {
      return new OrigDate(virtualNow()).toString();
    }
    if (arguments.length === 0) {
      return new OrigDate(virtualNow());
    }
    if (arguments.length === 1) {
      return new OrigDate(arguments[0]);
    }
    return new OrigDate(
      arguments[0],
      arguments[1],
      arguments.length > 2 ? arguments[2] : 1,
      arguments.length > 3 ? arguments[3] : 0,
      arguments.length > 4 ? arguments[4] : 0,
      arguments.length > 5 ? arguments[5] : 0,
      arguments.length > 6 ? arguments[6] : 0
    );
  }
  VirtualDate.prototype = OrigDate.prototype;
  Object.defineProperty(OrigDate.prototype, 'constructor', {
    value: VirtualDate,
    writable: true,
    enumerable: false,
    configurable: true
  });
  Object.defineProperty(VirtualDate, 'prototype', {
    writable: false,
    enumerable: false,
    configurable: false
  });
  Object.setPrototypeOf(VirtualDate, OrigDate);
  Object.defineProperty(VirtualDate, 'now', {
    value: function() { return virtualNow(); },
    writable: false,
    enumerable: false,
    configurable: false
  });
  Object.defineProperty(globalThis, 'Date', {
    value: VirtualDate,
    writable: false,
    enumerable: false,
    configurable: false
  });
})
`;

const FREEZE_ENGINE_SOURCE = `
(function(target) {
  'use strict';
  function deepFreeze(obj, seen) {
    if (obj === null || typeof obj !== 'object') {
      return;
    }
    if (seen.indexOf(obj) !== -1) {
      return;
    }
    seen.push(obj);
    var keys = Object.getOwnPropertyNames(obj);
    for (var i = 0; i < keys.length; i += 1) {
      var k = keys[i];
      if (k !== '__proto__' && Object.prototype.hasOwnProperty.call(obj, k)) {
        deepFreeze(obj[k], seen);
      }
    }
    Object.freeze(obj);
  }
  deepFreeze(target.event, []);
  Object.freeze(target.state);
  Object.freeze(target.dice);
  Object.freeze(target.clock);
  Object.freeze(target.prompt);
  Object.freeze(target);
})
`;

interface SandboxRuntimeSession {
  readonly manifest: ScriptManifest;
  readonly stateSnapshot: WorldState;
  readonly safeEventPayload: Record<string, unknown>;
  readonly virtualTimestampMs: number;
  currentRng: RngState;
  readonly queuedOperations: PatchOperation[];
  readonly injectedPrompts: Array<{ section: string; text: string }>;
  readonly logs: string[];
  readonly capabilityViolations: ValidationError[];
}

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

function setOwn(record: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function normalizeZero(value: number): number {
  return value === 0 ? 0 : value;
}

function isUint32(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
}

function validateAndCloneRngState(
  raw: unknown,
  acc: ErrorAccumulator
): RngState | undefined {
  if (!isPlainObject(raw)) {
    acc.add('', 'INVALID_RNG_STATE', 'rngState must be an object');
    return undefined;
  }

  if (raw.type === 'xoshiro128**') {
    const { s0, s1, s2, s3, drawCount } = raw;

    if (!isUint32(s0) || !isUint32(s1) || !isUint32(s2) || !isUint32(s3)) {
      acc.add('', 'INVALID_RNG_STATE', 'xoshiro128** words s0..s3 must be uint32 integers');
    } else if ((s0 | s1 | s2 | s3) === 0) {
      acc.add('', 'INVALID_RNG_STATE', 'xoshiro128** state words cannot all be zero');
    }

    if (typeof drawCount !== 'number' || !Number.isInteger(drawCount) || drawCount < 0) {
      acc.add('drawCount', 'INVALID_RNG_STATE', 'drawCount must be a non-negative integer');
    }

    if (acc.hasErrors()) {
      return undefined;
    }

    return {
      type: 'xoshiro128**',
      s0: s0 as number,
      s1: s1 as number,
      s2: s2 as number,
      s3: s3 as number,
      drawCount: drawCount as number,
    };
  }

  if (raw.type === 'queued') {
    if (!Array.isArray(raw.queue)) {
      acc.add('queue', 'INVALID_RNG_STATE', 'queued RNG queue must be an array');
    } else {
      for (let i = 0; i < raw.queue.length; i += 1) {
        const val = raw.queue[i];
        if (typeof val !== 'number' || !Number.isFinite(val) || val < 0 || val >= 1) {
          acc.add(
            `queue[${i}]`,
            'INVALID_RNG_STATE',
            'queued RNG values must be finite floats in [0, 1)'
          );
        }
      }
    }

    if (typeof raw.cursor !== 'number' || !Number.isInteger(raw.cursor) || raw.cursor < 0) {
      acc.add('cursor', 'INVALID_RNG_STATE', 'queued RNG cursor must be a non-negative integer');
    }

    if (typeof raw.drawCount !== 'number' || !Number.isInteger(raw.drawCount) || raw.drawCount < 0) {
      acc.add('drawCount', 'INVALID_RNG_STATE', 'drawCount must be a non-negative integer');
    }

    const fallback = validateAndCloneRngState(raw.fallback, acc.scope('fallback'));
    if (fallback !== undefined && fallback.type !== 'xoshiro128**') {
      acc.add('fallback', 'INVALID_RNG_STATE', 'queued RNG fallback must be xoshiro128**');
    }

    if (acc.hasErrors() || fallback === undefined || fallback.type !== 'xoshiro128**') {
      return undefined;
    }

    return {
      type: 'queued',
      queue: [...(raw.queue as number[])],
      cursor: raw.cursor as number,
      fallback,
      drawCount: raw.drawCount as number,
    };
  }

  acc.add('type', 'INVALID_RNG_STATE', `Unsupported rngState type "${String(raw.type)}"`);
  return undefined;
}

function parseSafeDotPath(path: unknown): Result<string[], string> {
  if (typeof path !== 'string' || path.trim().length === 0 || path !== path.trim()) {
    return err('Path must be a non-empty string without leading or trailing whitespace');
  }
  if (FORBIDDEN_KEYS.has(path)) {
    return err(`Forbidden path "${path}"`);
  }
  const segments = path.split('.');
  for (const segment of segments) {
    if (!isSafeKey(segment)) {
      return err(`Invalid or forbidden path segment in "${path}"`);
    }
  }
  return ok(segments);
}

function sanitizeHostValue(
  value: unknown,
  errorPath: string,
  seen: Set<object> = new Set(),
  depth = 0
): Result<unknown, ValidationError[]> {
  if (depth > MAX_EXTRACT_DEPTH) {
    return err([
      validationError(errorPath, 'MAX_DEPTH_EXCEEDED', `${errorPath} exceeds max nesting depth`),
    ]);
  }

  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'string') {
    return ok(value);
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return err([
        validationError(errorPath, 'INVALID_NUMBER', `${errorPath} must be a finite number`),
      ]);
    }
    return ok(normalizeZero(value));
  }

  if (value instanceof Date) {
    const ms = value.getTime();
    if (!Number.isFinite(ms)) {
      return err([
        validationError(errorPath, 'INVALID_DATE', `${errorPath} contains an invalid Date`),
      ]);
    }
    return ok(value.toISOString());
  }

  if (typeof value !== 'object') {
    return err([
      validationError(
        errorPath,
        'UNSUPPORTED_TYPE',
        `${errorPath} has unsupported value type "${typeof value}"`
      ),
    ]);
  }

  if (seen.has(value)) {
    return err([
      validationError(errorPath, 'CIRCULAR_REFERENCE', `${errorPath} contains a circular reference`),
    ]);
  }

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > MAX_ARRAY_LENGTH) {
        return err([
          validationError(
            errorPath,
            'ARRAY_TOO_LARGE',
            `${errorPath} exceeds maximum array length ${MAX_ARRAY_LENGTH}`
          ),
        ]);
      }
      const out: unknown[] = [];
      for (let i = 0; i < value.length; i += 1) {
        const itemRes = sanitizeHostValue(value[i], `${errorPath}[${i}]`, seen, depth + 1);
        if (!itemRes.ok) {
          return itemRes;
        }
        out.push(itemRes.value);
      }
      return ok(out);
    }

    if (!isPlainObject(value)) {
      return err([
        validationError(errorPath, 'INVALID_TYPE', `${errorPath} must be a plain object`),
      ]);
    }

    const out: Record<string, unknown> = {};
    for (const key of Object.getOwnPropertyNames(value)) {
      if (!isSafeKey(key)) {
        return err([
          validationError(errorPath, 'UNSAFE_KEY', `Forbidden property key "${key}" at ${errorPath}`),
        ]);
      }
      const desc = Object.getOwnPropertyDescriptor(value, key);
      if (!desc || !desc.enumerable) {
        continue;
      }
      const childRes = sanitizeHostValue(desc.value, `${errorPath}.${key}`, seen, depth + 1);
      if (!childRes.ok) {
        return childRes;
      }
      setOwn(out, key, childRes.value);
    }
    return ok(out);
  } finally {
    seen.delete(value);
  }
}

function resolveStatePath(stateSnapshot: WorldState, segments: readonly string[]): unknown {
  let current: unknown = stateSnapshot;

  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    if (segment === undefined || !isSafeKey(segment) || current === null || typeof current !== 'object') {
      return undefined;
    }

    if (Array.isArray(current)) {
      if (segment === 'length') {
        current = current.length;
        continue;
      }
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return undefined;
      }
      current = current[index];
      continue;
    }

    if (Object.hasOwn(current, segment)) {
      const desc = Object.getOwnPropertyDescriptor(current, segment);
      current = desc?.value;
      continue;
    }

    // Fallback for flat dotted keys inside records such as customFields.
    const remainingJoined = segments.slice(i).join('.');
    if (
      remainingJoined !== segment &&
      !FORBIDDEN_KEYS.has(remainingJoined) &&
      Object.hasOwn(current, remainingJoined)
    ) {
      const desc = Object.getOwnPropertyDescriptor(current, remainingJoined);
      return desc?.value;
    }

    return undefined;
  }

  return current;
}

function computeVirtualTimestampMs(state: WorldState): number {
  const dayRaw = state.clocks?.day;
  const day = typeof dayRaw === 'number' && Number.isFinite(dayRaw) ? Math.max(1, Math.trunc(dayRaw)) : 1;

  const clockTurnRaw = state.clocks?.turn;
  const metaTurnRaw = state.meta?.turn;
  const clockTurn =
    typeof clockTurnRaw === 'number' && Number.isFinite(clockTurnRaw)
      ? Math.max(0, Math.trunc(clockTurnRaw))
      : 0;
  const metaTurn =
    typeof metaTurnRaw === 'number' && Number.isFinite(metaTurnRaw)
      ? Math.max(0, Math.trunc(metaTurnRaw))
      : 0;
  const effectiveTurn = clockTurn === 0 && metaTurn !== 0 ? metaTurn : clockTurn;

  return VIRTUAL_EPOCH_MS + (day - 1) * DAY_MS + effectiveTurn * 1_000;
}

function hostValueToHandle(vm: QuickJSContext, value: unknown, depth = 0): QuickJSHandle {
  if (depth > MAX_EXTRACT_DEPTH) {
    throw new Error(`Value exceeds maximum nesting depth of ${MAX_EXTRACT_DEPTH}`);
  }

  if (value === undefined) {
    return vm.undefined;
  }
  if (value === null) {
    return vm.null;
  }
  if (typeof value === 'boolean') {
    return value ? vm.true : vm.false;
  }
  if (typeof value === 'number') {
    return vm.newNumber(normalizeZero(value));
  }
  if (typeof value === 'string') {
    return vm.newString(value);
  }
  if (value instanceof Date) {
    return vm.newString(value.toISOString());
  }

  if (Array.isArray(value)) {
    const arrHandle = vm.newArray();
    try {
      for (let i = 0; i < value.length; i += 1) {
        const itemHandle = hostValueToHandle(vm, value[i], depth + 1);
        try {
          vm.setProp(arrHandle, i, itemHandle);
        } finally {
          itemHandle.dispose();
        }
      }
      return arrHandle;
    } catch (error) {
      arrHandle.dispose();
      throw error;
    }
  }

  if (typeof value === 'object') {
    const objHandle = vm.newObject();
    try {
      const record = value as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        if (!isSafeKey(key)) {
          continue;
        }
        const desc = Object.getOwnPropertyDescriptor(record, key);
        if (!desc) {
          continue;
        }
        const propHandle = hostValueToHandle(vm, desc.value, depth + 1);
        try {
          vm.setProp(objHandle, key, propHandle);
        } finally {
          propHandle.dispose();
        }
      }
      return objHandle;
    } catch (error) {
      objHandle.dispose();
      throw error;
    }
  }

  return vm.undefined;
}

function isQuickJSArray(
  vm: QuickJSContext,
  isArrayFn: QuickJSHandle,
  handle: QuickJSHandle
): boolean {
  const callRes = vm.callFunction(isArrayFn, vm.undefined, handle);
  try {
    if (callRes.error) {
      return false;
    }
    return vm.eq(callRes.value, vm.true);
  } finally {
    callRes.dispose();
  }
}

interface ExtractOptions {
  allowUndefined: boolean;
  allowNonFiniteNumber?: boolean;
}

function handleToSafeHostValue(
  vm: QuickJSContext,
  isArrayFn: QuickJSHandle,
  handle: QuickJSHandle,
  options: ExtractOptions,
  seenHandles: QuickJSHandle[] = [],
  depth = 0
): unknown {
  if (depth > MAX_EXTRACT_DEPTH) {
    throw new Error(`Value exceeds maximum nesting depth of ${MAX_EXTRACT_DEPTH}`);
  }

  const kind = vm.typeof(handle);

  if (kind === 'undefined') {
    if (!options.allowUndefined) {
      throw new Error('Value cannot be undefined');
    }
    return undefined;
  }

  if (kind === 'boolean') {
    return vm.eq(handle, vm.true);
  }

  if (kind === 'number') {
    const num = vm.getNumber(handle);
    if (!options.allowNonFiniteNumber && !Number.isFinite(num)) {
      throw new Error(`Number must be finite; received ${String(num)}`);
    }
    return normalizeZero(num);
  }

  if (kind === 'string') {
    return vm.getString(handle);
  }

  if (kind !== 'object') {
    throw new Error(`Unsupported value type "${kind}" across sandbox boundary`);
  }

  if (vm.eq(handle, vm.null)) {
    return null;
  }

  for (const ancestor of seenHandles) {
    if (vm.sameValue(ancestor, handle)) {
      throw new Error('Circular references are not allowed');
    }
  }

  seenHandles.push(handle);
  try {
    if (isQuickJSArray(vm, isArrayFn, handle)) {
      const length = vm.getLength(handle) ?? 0;
      if (length > MAX_ARRAY_LENGTH) {
        throw new Error(`Array length ${length} exceeds maximum allowed length ${MAX_ARRAY_LENGTH}`);
      }
      const arr: unknown[] = [];
      for (let i = 0; i < length; i += 1) {
        const elemHandle = vm.getProp(handle, i);
        try {
          arr.push(
            handleToSafeHostValue(
              vm,
              isArrayFn,
              elemHandle,
              { allowUndefined: false, allowNonFiniteNumber: options.allowNonFiniteNumber },
              seenHandles,
              depth + 1
            )
          );
        } finally {
          elemHandle.dispose();
        }
      }
      return arr;
    }

    const namesResult = vm.getOwnPropertyNames(handle, {
      strings: true,
      numbersAsStrings: true,
      onlyEnumerable: true,
    });
    if (namesResult.error) {
      namesResult.dispose();
      throw new Error('Failed to inspect object properties');
    }

    try {
      const out: Record<string, unknown> = {};
      for (const keyHandle of namesResult.value) {
        const key = vm.getString(keyHandle);
        if (!isSafeKey(key)) {
          throw new Error(`Forbidden property key "${key}"`);
        }
        const propHandle = vm.getProp(handle, keyHandle);
        try {
          const propVal = handleToSafeHostValue(
            vm,
            isArrayFn,
            propHandle,
            { allowUndefined: true, allowNonFiniteNumber: options.allowNonFiniteNumber },
            seenHandles,
            depth + 1
          );
          if (propVal !== undefined) {
            setOwn(out, key, propVal);
          }
        } finally {
          propHandle.dispose();
        }
      }
      return out;
    } finally {
      namesResult.dispose();
    }
  } finally {
    seenHandles.pop();
  }
}

function formatLogArgument(
  vm: QuickJSContext,
  isArrayFn: QuickJSHandle,
  handle: QuickJSHandle
): string {
  const kind = vm.typeof(handle);
  if (kind === 'string') {
    return vm.getString(handle);
  }
  if (kind === 'undefined') {
    return 'undefined';
  }
  if (kind === 'boolean') {
    return vm.eq(handle, vm.true) ? 'true' : 'false';
  }
  if (kind === 'number') {
    return String(vm.getNumber(handle));
  }
  if (kind === 'object' && vm.eq(handle, vm.null)) {
    return 'null';
  }
  try {
    const safeVal = handleToSafeHostValue(vm, isArrayFn, handle, {
      allowUndefined: true,
      allowNonFiniteNumber: true,
    });
    return JSON.stringify(safeVal) ?? String(safeVal);
  } catch {
    return `[${kind}]`;
  }
}

function classifyVmError(errorObj: unknown, scriptId: string): ValidationError {
  if (errorObj !== null && typeof errorObj === 'object' && !Array.isArray(errorObj)) {
    const nameProp = Object.getOwnPropertyDescriptor(errorObj, 'name')?.value;
    const msgProp = Object.getOwnPropertyDescriptor(errorObj, 'message')?.value;
    const name = typeof nameProp === 'string' ? nameProp : 'Error';
    const message = typeof msgProp === 'string' ? msgProp : 'Script execution failed';

    if (name === 'InternalError' && message === 'interrupted') {
      return validationError(
        'code',
        'SCRIPT_TIMEOUT',
        `Script "${scriptId}" exceeded execution timeout`
      );
    }
    if (name === 'InternalError' && message === 'out of memory') {
      return validationError(
        'code',
        'SCRIPT_OUT_OF_MEMORY',
        `Script "${scriptId}" exceeded memory limit`
      );
    }
    if (name === 'InternalError' && message === 'stack overflow') {
      return validationError(
        'code',
        'SCRIPT_STACK_OVERFLOW',
        `Script "${scriptId}" exceeded maximum call stack size`
      );
    }
    if (name === 'SyntaxError') {
      return validationError(
        'code',
        'SCRIPT_SYNTAX_ERROR',
        `Script "${scriptId}" syntax error: ${message}`
      );
    }
    return validationError(
      'code',
      'SCRIPT_RUNTIME_ERROR',
      `Script "${scriptId}" failed (${name}): ${message}`
    );
  }

  return validationError(
    'code',
    'SCRIPT_RUNTIME_ERROR',
    `Script "${scriptId}" threw non-Error value: ${String(errorObj)}`
  );
}

function extractVmErrorSafe(
  vm: QuickJSContext,
  isArrayFn: QuickJSHandle,
  errorHandle: QuickJSHandle
): unknown {
  const kind = vm.typeof(errorHandle);
  if (kind !== 'object' || vm.eq(errorHandle, vm.null)) {
    try {
      return handleToSafeHostValue(vm, isArrayFn, errorHandle, {
        allowUndefined: true,
        allowNonFiniteNumber: true,
      });
    } catch {
      return `[${kind}]`;
    }
  }

  const out: Record<string, unknown> = {};
  const nameHandle = vm.getProp(errorHandle, 'name');
  try {
    if (vm.typeof(nameHandle) === 'string') {
      setOwn(out, 'name', vm.getString(nameHandle));
    }
  } finally {
    nameHandle.dispose();
  }

  const msgHandle = vm.getProp(errorHandle, 'message');
  try {
    if (vm.typeof(msgHandle) === 'string') {
      setOwn(out, 'message', vm.getString(msgHandle));
    }
  } finally {
    msgHandle.dispose();
  }

  return out;
}

function attachReadOnlyProp(
  vm: QuickJSContext,
  targetObj: QuickJSHandle,
  propName: string,
  valueHandle: QuickJSHandle
): void {
  vm.defineProp(targetObj, propName, {
    value: valueHandle,
    enumerable: true,
    configurable: false,
  });
}

function attachEngineMethod(
  vm: QuickJSContext,
  targetObj: QuickJSHandle,
  methodName: string,
  impl: (...args: QuickJSHandle[]) => QuickJSHandle | void
): void {
  const fnHandle = vm.newFunction(methodName, impl);
  try {
    attachReadOnlyProp(vm, targetObj, methodName, fnHandle);
  } finally {
    fnHandle.dispose();
  }
}

function runBootstrapFunction(
  vm: QuickJSContext,
  source: string,
  argHandle: QuickJSHandle
): void {
  const fnResult = vm.evalCode(source, 'sandbox-bootstrap.js', { type: 'global' });
  try {
    if (fnResult.error) {
      throw new Error('Failed to compile sandbox bootstrap');
    }
    const callResult = vm.callFunction(fnResult.value, vm.undefined, argHandle);
    try {
      if (callResult.error) {
        throw new Error('Failed to initialize sandbox bootstrap');
      }
    } finally {
      callResult.dispose();
    }
  } finally {
    fnResult.dispose();
  }
}

function validateSandboxInput(
  input: SandboxExecutionInput
): Result<SandboxRuntimeSession, ValidationError[]> {
  const acc = new ErrorAccumulator();

  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    acc.add('input', 'INVALID_INPUT', 'SandboxExecutionInput must be an object');
    return err([...acc.errors]);
  }

  if (typeof input.code !== 'string') {
    acc.add('code', 'INVALID_CODE', 'SandboxExecutionInput.code must be a string');
  }

  acc.absorb(validateScriptManifest(input.manifest));

  if (
    input.stateSnapshot === null ||
    typeof input.stateSnapshot !== 'object' ||
    Array.isArray(input.stateSnapshot)
  ) {
    acc.add('stateSnapshot', 'INVALID_STATE', 'SandboxExecutionInput.stateSnapshot must be an object');
  }

  const initialRng = validateAndCloneRngState(input.rngState, acc.scope('rngState'));

  let safeEventPayload: Record<string, unknown> = {};
  if (input.eventPayload !== undefined) {
    if (!isPlainObject(input.eventPayload)) {
      acc.add('eventPayload', 'INVALID_EVENT_PAYLOAD', 'eventPayload must be a plain object');
    } else {
      const extracted = acc.absorb(sanitizeHostValue(input.eventPayload, 'eventPayload'));
      if (isPlainObject(extracted)) {
        safeEventPayload = extracted;
      }
    }
  }

  if (acc.hasErrors() || initialRng === undefined) {
    return err([...acc.errors]);
  }

  return ok({
    manifest: input.manifest,
    stateSnapshot: input.stateSnapshot,
    safeEventPayload,
    virtualTimestampMs: computeVirtualTimestampMs(input.stateSnapshot),
    currentRng: initialRng,
    queuedOperations: [],
    injectedPrompts: [],
    logs: [],
    capabilityViolations: [],
  });
}

function enforceSessionCapability(
  session: SandboxRuntimeSession,
  checkResult: Result<void, ValidationError[]>
): void {
  if (!checkResult.ok) {
    session.capabilityViolations.push(...checkResult.error);
    throw new Error(formatValidationErrors(checkResult.error));
  }
}

function installDeterministicGlobals(
  vm: QuickJSContext,
  session: SandboxRuntimeSession
): void {
  const mathHandle = vm.getProp(vm.global, 'Math');
  try {
    const randomFnHandle = vm.newFunction('random', () => {
      const step = nextFloat(session.currentRng);
      session.currentRng = step.nextState;
      return vm.newNumber(step.value);
    });
    try {
      vm.defineProp(mathHandle, 'random', {
        value: randomFnHandle,
        enumerable: false,
        configurable: false,
      });
    } finally {
      randomFnHandle.dispose();
    }
  } finally {
    mathHandle.dispose();
  }

  const virtualNowFnHandle = vm.newFunction('virtualNow', () => {
    return vm.newNumber(session.virtualTimestampMs);
  });
  try {
    runBootstrapFunction(vm, BOOTSTRAP_DATE_SOURCE, virtualNowFnHandle);
  } finally {
    virtualNowFnHandle.dispose();
  }
}

function buildStateBridge(
  vm: QuickJSContext,
  isArrayFn: QuickJSHandle,
  session: SandboxRuntimeSession
): QuickJSHandle {
  const stateHandle = vm.newObject();
  try {
    attachEngineMethod(vm, stateHandle, 'get', (pathHandle) => {
      enforceSessionCapability(session, hasCapability(session.manifest, 'state:read'));
      if (!pathHandle || vm.typeof(pathHandle) !== 'string') {
        throw new Error('engine.state.get(path): path must be a string');
      }
      const rawPath = vm.getString(pathHandle);
      const parsed = parseSafeDotPath(rawPath);
      if (!parsed.ok) {
        throw new Error(`engine.state.get(path): ${parsed.error}`);
      }
      const value = resolveStatePath(session.stateSnapshot, parsed.value);
      const sanitized = sanitizeHostValue(value, rawPath);
      if (!sanitized.ok) {
        throw new Error(
          `engine.state.get("${rawPath}"): ${formatValidationErrors(sanitized.error)}`
        );
      }
      return hostValueToHandle(vm, sanitized.value);
    });

    attachEngineMethod(vm, stateHandle, 'set', (pathHandle, valueHandle) => {
      if (!pathHandle || vm.typeof(pathHandle) !== 'string') {
        throw new Error('engine.state.set(path, value): path must be a string');
      }
      const rawPath = vm.getString(pathHandle);
      const parsed = parseSafeDotPath(rawPath);
      if (!parsed.ok) {
        throw new Error(`engine.state.set(path, value): ${parsed.error}`);
      }
      enforceSessionCapability(session, checkStateWriteCapability(session.manifest, rawPath));
      if (!valueHandle) {
        throw new Error('engine.state.set(path, value): value is required');
      }
      const extracted = handleToSafeHostValue(vm, isArrayFn, valueHandle, {
        allowUndefined: false,
      });
      session.queuedOperations.push({ op: 'set', path: rawPath, value: extracted });
    });

    attachEngineMethod(vm, stateHandle, 'increment', (pathHandle, deltaHandle) => {
      if (!pathHandle || vm.typeof(pathHandle) !== 'string') {
        throw new Error('engine.state.increment(path, delta): path must be a string');
      }
      const rawPath = vm.getString(pathHandle);
      const parsed = parseSafeDotPath(rawPath);
      if (!parsed.ok) {
        throw new Error(`engine.state.increment(path, delta): ${parsed.error}`);
      }
      enforceSessionCapability(session, checkStateWriteCapability(session.manifest, rawPath));
      if (!deltaHandle || vm.typeof(deltaHandle) !== 'number') {
        throw new Error('engine.state.increment(path, delta): delta must be a finite number');
      }
      const delta = vm.getNumber(deltaHandle);
      if (!Number.isFinite(delta)) {
        throw new Error('engine.state.increment(path, delta): delta must be a finite number');
      }
      session.queuedOperations.push({
        op: 'increment',
        path: rawPath,
        delta: normalizeZero(delta),
      });
    });

    attachEngineMethod(
      vm,
      stateHandle,
      'entityPatch',
      (collectionHandle, idHandle, patchHandle) => {
        if (!collectionHandle || vm.typeof(collectionHandle) !== 'string') {
          throw new Error(
            'engine.state.entityPatch(collection, id, patch): collection must be a string'
          );
        }
        const collection = vm.getString(collectionHandle);
        if (!isSafeKey(collection)) {
          throw new Error(
            `engine.state.entityPatch: forbidden or empty collection "${collection}"`
          );
        }
        enforceSessionCapability(
          session,
          checkEntityWriteCapability(session.manifest, collection)
        );

        if (!VALID_ENTITY_COLLECTIONS.has(collection)) {
          throw new Error(
            `engine.state.entityPatch: unknown entity collection "${collection}"`
          );
        }
        if (!idHandle || vm.typeof(idHandle) !== 'string') {
          throw new Error('engine.state.entityPatch: id must be a string');
        }
        const entityId = vm.getString(idHandle);
        if (!isSafeKey(entityId) || entityId.trim().length === 0) {
          throw new Error(`engine.state.entityPatch: invalid entity id "${entityId}"`);
        }
        if (
          !patchHandle ||
          vm.typeof(patchHandle) !== 'object' ||
          vm.eq(patchHandle, vm.null) ||
          isQuickJSArray(vm, isArrayFn, patchHandle)
        ) {
          throw new Error('engine.state.entityPatch: patch must be a plain object');
        }
        const extractedPatch = handleToSafeHostValue(vm, isArrayFn, patchHandle, {
          allowUndefined: false,
        });
        if (!isPlainObject(extractedPatch)) {
          throw new Error('engine.state.entityPatch: patch must be a plain object');
        }
        session.queuedOperations.push({
          op: 'entity_patch',
          collection: collection as EntityCollectionName,
          entityId,
          patch: extractedPatch,
        });
      }
    );

    return stateHandle;
  } catch (error) {
    stateHandle.dispose();
    throw error;
  }
}

function buildEngineBridge(
  vm: QuickJSContext,
  isArrayFn: QuickJSHandle,
  session: SandboxRuntimeSession
): void {
  const engineHandle = vm.newObject();
  try {
    const stateHandle = buildStateBridge(vm, isArrayFn, session);
    try {
      attachReadOnlyProp(vm, engineHandle, 'state', stateHandle);
    } finally {
      stateHandle.dispose();
    }

    const diceHandle = vm.newObject();
    try {
      attachEngineMethod(vm, diceHandle, 'roll', (notationHandle) => {
        enforceSessionCapability(session, hasCapability(session.manifest, 'dice'));
        if (!notationHandle || vm.typeof(notationHandle) !== 'string') {
          throw new Error('engine.dice.roll(notation): notation must be a string');
        }
        const notation = vm.getString(notationHandle);
        const diceRes = rollDice(notation, session.currentRng);
        if (!diceRes.ok) {
          throw new Error(
            `engine.dice.roll("${notation}"): ${formatValidationErrors(diceRes.error)}`
          );
        }
        session.currentRng = diceRes.value.nextState;
        return hostValueToHandle(vm, {
          notation: diceRes.value.trace.notation,
          total: diceRes.value.total,
          rolls: [...diceRes.value.rolls],
          rawRolls: [...diceRes.value.trace.rawRolls],
          modifier: diceRes.value.modifier,
        });
      });
      attachReadOnlyProp(vm, engineHandle, 'dice', diceHandle);
    } finally {
      diceHandle.dispose();
    }

    const clockHandle = vm.newObject();
    try {
      attachEngineMethod(vm, clockHandle, 'advanceSlots', (slotsHandle) => {
        enforceSessionCapability(session, hasCapability(session.manifest, 'clock:advance'));
        if (!slotsHandle || vm.typeof(slotsHandle) !== 'number') {
          throw new Error('engine.clock.advanceSlots(n): n must be a non-negative integer');
        }
        const slots = vm.getNumber(slotsHandle);
        if (!Number.isInteger(slots) || slots < 0) {
          throw new Error('engine.clock.advanceSlots(n): n must be a non-negative integer');
        }
        session.queuedOperations.push({
          op: 'clock_advance',
          mechanicalTurns: 0,
          storySlots: normalizeZero(slots),
        });
      });

      attachEngineMethod(vm, clockHandle, 'hold', (reasonHandle) => {
        enforceSessionCapability(session, hasCapability(session.manifest, 'clock:advance'));
        if (!reasonHandle || vm.typeof(reasonHandle) !== 'string') {
          throw new Error('engine.clock.hold(reason): reason must be a string');
        }
        session.queuedOperations.push({
          op: 'clock_hold',
          reason: vm.getString(reasonHandle),
        });
      });

      attachReadOnlyProp(vm, engineHandle, 'clock', clockHandle);
    } finally {
      clockHandle.dispose();
    }

    const promptHandle = vm.newObject();
    try {
      attachEngineMethod(vm, promptHandle, 'inject', (sectionHandle, textHandle) => {
        enforceSessionCapability(session, hasCapability(session.manifest, 'prompt:inject'));
        if (!sectionHandle || vm.typeof(sectionHandle) !== 'string') {
          throw new Error('engine.prompt.inject(section, text): section must be a string');
        }
        const section = vm.getString(sectionHandle);
        if (section.trim().length === 0) {
          throw new Error('engine.prompt.inject(section, text): section must be non-empty');
        }
        if (!textHandle || vm.typeof(textHandle) !== 'string') {
          throw new Error('engine.prompt.inject(section, text): text must be a string');
        }
        session.injectedPrompts.push({ section, text: vm.getString(textHandle) });
      });

      attachReadOnlyProp(vm, engineHandle, 'prompt', promptHandle);
    } finally {
      promptHandle.dispose();
    }

    attachEngineMethod(vm, engineHandle, 'log', (...args) => {
      if (args.length === 0) {
        session.logs.push('');
        return;
      }
      session.logs.push(args.map((arg) => formatLogArgument(vm, isArrayFn, arg)).join(' '));
    });

    const eventHandle = hostValueToHandle(vm, session.safeEventPayload);
    try {
      attachReadOnlyProp(vm, engineHandle, 'event', eventHandle);
    } finally {
      eventHandle.dispose();
    }

    runBootstrapFunction(vm, FREEZE_ENGINE_SOURCE, engineHandle);
    attachReadOnlyProp(vm, vm.global, 'engine', engineHandle);
  } finally {
    engineHandle.dispose();
  }
}

function discardQueuedEffects(session: SandboxRuntimeSession): void {
  session.queuedOperations.length = 0;
  session.injectedPrompts.length = 0;
}

function extractEvalOutput(
  vm: QuickJSContext,
  runtime: QuickJSRuntime,
  isArrayFn: QuickJSHandle,
  evalResult: ReturnType<QuickJSContext['evalCode']>,
  session: SandboxRuntimeSession
): Result<SandboxExecutionOutput, ValidationError[]> {
  if (session.capabilityViolations.length > 0) {
    discardQueuedEffects(session);
    return err([...session.capabilityViolations]);
  }

  if (evalResult.error) {
    runtime.setMemoryLimit(-1);
    runtime.removeInterruptHandler();
    discardQueuedEffects(session);
    const errInfo = extractVmErrorSafe(vm, isArrayFn, evalResult.error);
    return err([classifyVmError(errInfo, session.manifest.scriptId)]);
  }

  if (runtime.hasPendingJob()) {
    const jobRes = runtime.executePendingJobs();
    try {
      if (session.capabilityViolations.length > 0) {
        discardQueuedEffects(session);
        return err([...session.capabilityViolations]);
      }
      if (jobRes.error) {
        runtime.setMemoryLimit(-1);
        runtime.removeInterruptHandler();
        discardQueuedEffects(session);
        const jobErrInfo = extractVmErrorSafe(vm, isArrayFn, jobRes.error);
        return err([classifyVmError(jobErrInfo, session.manifest.scriptId)]);
      }
    } finally {
      jobRes.dispose();
    }
  }

  // Lift memory/interrupt guards before inspecting promises or extracting values.
  runtime.setMemoryLimit(-1);
  runtime.removeInterruptHandler();

  const promiseState = vm.getPromiseState(evalResult.value);
  let targetValueHandle = evalResult.value;
  let shouldDisposeTargetHandle = false;

  if (promiseState.type === 'pending') {
    discardQueuedEffects(session);
    return err([
      validationError(
        'resultValue',
        'UNRESOLVED_PROMISE',
        `Script "${session.manifest.scriptId}" returned an unresolved Promise`
      ),
    ]);
  }

  if (promiseState.type === 'rejected') {
    try {
      discardQueuedEffects(session);
      const errInfo = extractVmErrorSafe(vm, isArrayFn, promiseState.error);
      return err([classifyVmError(errInfo, session.manifest.scriptId)]);
    } finally {
      promiseState.error.dispose();
    }
  }

  if (!promiseState.notAPromise) {
    targetValueHandle = promiseState.value;
    shouldDisposeTargetHandle = true;
  }

  try {
    const resultValue = handleToSafeHostValue(vm, isArrayFn, targetValueHandle, {
      allowUndefined: true,
    });
    return ok({
      operations: session.queuedOperations,
      injectedPrompts: session.injectedPrompts,
      logs: session.logs,
      nextRng: session.currentRng,
      resultValue,
    });
  } catch (extractError) {
    discardQueuedEffects(session);
    return err([
      validationError(
        'resultValue',
        'INVALID_RETURN_VALUE',
        extractError instanceof Error ? extractError.message : String(extractError)
      ),
    ]);
  } finally {
    if (shouldDisposeTargetHandle && targetValueHandle.alive) {
      targetValueHandle.dispose();
    }
  }
}

/**
 * Execute an untrusted script inside an isolated QuickJS WebAssembly runtime
 * with capability manifest enforcement, seeded PRNG determinism, virtual clock,
 * strict timeout/memory guards, and atomic patch queuing (BR-2).
 */
export async function executeSandboxedScript(
  input: SandboxExecutionInput
): Promise<Result<SandboxExecutionOutput, ValidationError[]>> {
  const sessionRes = validateSandboxInput(input);
  if (!sessionRes.ok) {
    return sessionRes;
  }
  const session = sessionRes.value;

  let quickjs: QuickJSWASMModule;
  try {
    quickjs = await getQuickJS();
  } catch (error) {
    return err([
      validationError(
        'sandbox',
        'SANDBOX_INIT_FAILED',
        `Failed to initialize QuickJS WASM module: ${error instanceof Error ? error.message : String(error)}`
      ),
    ]);
  }

  const timeoutMs = session.manifest.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const memoryLimitBytes = session.manifest.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT_BYTES;

  let runtime: QuickJSRuntime | undefined;
  let vm: QuickJSContext | undefined;
  let isArrayFn: QuickJSHandle | undefined;

  try {
    runtime = quickjs.newRuntime();
    runtime.setMemoryLimit(memoryLimitBytes);
    runtime.setMaxStackSize(DEFAULT_MAX_STACK_SIZE_BYTES);
    runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + timeoutMs));

    vm = runtime.newContext();
    const arrayCtorHandle = vm.getProp(vm.global, 'Array');
    try {
      isArrayFn = vm.getProp(arrayCtorHandle, 'isArray');
    } finally {
      arrayCtorHandle.dispose();
    }

    installDeterministicGlobals(vm, session);
    buildEngineBridge(vm, isArrayFn, session);

    const evalResult = vm.evalCode(
      input.code,
      `${session.manifest.scriptId}.js`,
      { type: 'global' }
    );
    try {
      return extractEvalOutput(vm, runtime, isArrayFn, evalResult, session);
    } finally {
      evalResult.dispose();
    }
  } catch (error) {
    discardQueuedEffects(session);
    if (session.capabilityViolations.length > 0) {
      return err([...session.capabilityViolations]);
    }
    return err([
      validationError(
        'sandbox',
        'SANDBOX_EXECUTION_ERROR',
        error instanceof Error ? error.message : String(error)
      ),
    ]);
  } finally {
    if (isArrayFn && isArrayFn.alive) {
      isArrayFn.dispose();
    }
    if (vm && vm.alive) {
      vm.dispose();
    }
    if (runtime && runtime.alive) {
      runtime.dispose();
    }
  }
}
