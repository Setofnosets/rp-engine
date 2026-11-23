import { type ValidationError } from '../core/errors.js';
import { ErrorAccumulator, type Result, err, ok } from '../core/result.js';

/**
 * Capability permissions assignable to a sandboxed script manifest.
 */
export type SandboxCapability =
  | 'dice'
  | 'state:read'
  | 'clock:advance'
  | 'prompt:inject'
  | 'combat:act'
  | `state:write:${string}`
  | `entities:write:${string}`;

/**
 * Manifest declaring a script's identity, granted capabilities, and resource limits.
 */
export interface ScriptManifest {
  readonly scriptId: string;
  readonly capabilities: readonly SandboxCapability[];
  readonly timeoutMs?: number;
  readonly memoryLimitBytes?: number;
}

const STATIC_CAPABILITIES: ReadonlySet<string> = new Set([
  'dice',
  'state:read',
  'clock:advance',
  'prompt:inject',
  'combat:act',
]);

const STATE_WRITE_PREFIX = 'state:write:';
const ENTITIES_WRITE_PREFIX = 'entities:write:';

function matchWildcardPattern(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let starIdx = -1;
  let matchIdx = 0;

  while (t < text.length) {
    if (p < pattern.length && pattern[p] === text[t]) {
      p += 1;
      t += 1;
    } else if (p < pattern.length && pattern[p] === '*') {
      starIdx = p;
      matchIdx = t;
      p += 1;
    } else if (starIdx !== -1) {
      p = starIdx + 1;
      matchIdx += 1;
      t = matchIdx;
    } else {
      return false;
    }
  }

  while (p < pattern.length && pattern[p] === '*') {
    p += 1;
  }

  return p === pattern.length;
}

/**
 * Match a write capability glob pattern against a target path or collection name.
 *
 * Examples:
 * - `matchesWriteGlob('flags.*', 'flags.met_castellan')` -> `true`
 * - `matchesWriteGlob('flags.*', 'counters.trust')` -> `false`
 * - `matchesWriteGlob('*', 'anything')` -> `true`
 */
export function matchesWriteGlob(globPattern: string, targetPath: string): boolean {
  if (
    typeof globPattern !== 'string' ||
    typeof targetPath !== 'string' ||
    globPattern.length === 0 ||
    targetPath.length === 0
  ) {
    return false;
  }

  if (globPattern === '*') {
    return true;
  }

  return matchWildcardPattern(globPattern, targetPath);
}

/**
 * Validate structural integrity of a {@link ScriptManifest}.
 */
export function validateScriptManifest(
  manifest: ScriptManifest
): Result<void, ValidationError[]> {
  const acc = new ErrorAccumulator();

  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    acc.add('manifest', 'INVALID_MANIFEST', 'ScriptManifest must be an object');
    return err([...acc.errors]);
  }

  if (typeof manifest.scriptId !== 'string' || manifest.scriptId.trim().length === 0) {
    acc.add('scriptId', 'INVALID_SCRIPT_ID', 'ScriptManifest.scriptId must be a non-empty string');
  }

  if (!Array.isArray(manifest.capabilities)) {
    acc.add('capabilities', 'INVALID_CAPABILITIES', 'ScriptManifest.capabilities must be an array');
  } else {
    for (let i = 0; i < manifest.capabilities.length; i += 1) {
      const cap = manifest.capabilities[i];
      if (typeof cap !== 'string' || !isValidCapabilityString(cap)) {
        acc.add(
          `capabilities[${i}]`,
          'INVALID_CAPABILITY',
          `Invalid capability entry "${String(cap)}" at index ${i}`
        );
      }
    }
  }

  if (manifest.timeoutMs !== undefined) {
    if (
      typeof manifest.timeoutMs !== 'number' ||
      !Number.isFinite(manifest.timeoutMs) ||
      manifest.timeoutMs <= 0
    ) {
      acc.add(
        'timeoutMs',
        'INVALID_TIMEOUT',
        'ScriptManifest.timeoutMs must be a positive finite number'
      );
    }
  }

  if (manifest.memoryLimitBytes !== undefined) {
    if (
      typeof manifest.memoryLimitBytes !== 'number' ||
      !Number.isInteger(manifest.memoryLimitBytes) ||
      manifest.memoryLimitBytes <= 0
    ) {
      acc.add(
        'memoryLimitBytes',
        'INVALID_MEMORY_LIMIT',
        'ScriptManifest.memoryLimitBytes must be a positive integer'
      );
    }
  }

  return acc.toResult();
}

function isValidCapabilityString(cap: string): boolean {
  if (STATIC_CAPABILITIES.has(cap)) {
    return true;
  }
  if (cap.startsWith(STATE_WRITE_PREFIX)) {
    return cap.length > STATE_WRITE_PREFIX.length;
  }
  if (cap.startsWith(ENTITIES_WRITE_PREFIX)) {
    return cap.length > ENTITIES_WRITE_PREFIX.length;
  }
  return false;
}

/**
 * Verify whether `manifest` grants `capabilityCheck` (including `state:write:<glob>`
 * and `entities:write:<glob>` wildcard patterns).
 */
export function hasCapability(
  manifest: ScriptManifest,
  capabilityCheck: SandboxCapability
): Result<void, ValidationError[]> {
  const acc = new ErrorAccumulator();

  if (manifest === null || typeof manifest !== 'object' || !Array.isArray(manifest.capabilities)) {
    acc.add('capabilities', 'INVALID_MANIFEST', 'Script manifest must contain a capabilities array');
    return err([...acc.errors]);
  }

  if (typeof capabilityCheck !== 'string' || capabilityCheck.length === 0) {
    acc.add('capabilities', 'INVALID_CAPABILITY', 'Capability check must be a non-empty string');
    return err([...acc.errors]);
  }

  for (const granted of manifest.capabilities) {
    if (typeof granted !== 'string') {
      continue;
    }

    if (granted === capabilityCheck) {
      return ok(undefined);
    }

    if (
      granted.startsWith(STATE_WRITE_PREFIX) &&
      capabilityCheck.startsWith(STATE_WRITE_PREFIX)
    ) {
      const globPattern = granted.slice(STATE_WRITE_PREFIX.length);
      const targetPath = capabilityCheck.slice(STATE_WRITE_PREFIX.length);
      if (matchesWriteGlob(globPattern, targetPath)) {
        return ok(undefined);
      }
    }

    if (
      granted.startsWith(ENTITIES_WRITE_PREFIX) &&
      capabilityCheck.startsWith(ENTITIES_WRITE_PREFIX)
    ) {
      const globPattern = granted.slice(ENTITIES_WRITE_PREFIX.length);
      const targetCollection = capabilityCheck.slice(ENTITIES_WRITE_PREFIX.length);
      if (matchesWriteGlob(globPattern, targetCollection)) {
        return ok(undefined);
      }
    }
  }

  const scriptLabel =
    typeof manifest.scriptId === 'string' && manifest.scriptId.length > 0
      ? manifest.scriptId
      : '<unknown>';
  acc.add(
    'capabilities',
    'CAPABILITY_DENIED',
    `Script "${scriptLabel}" lacks required capability "${capabilityCheck}"`
  );
  return err([...acc.errors]);
}

/**
 * Check whether `manifest` allows writing to `targetPath` under `state:write:<glob>`.
 */
export function checkStateWriteCapability(
  manifest: ScriptManifest,
  targetPath: string
): Result<void, ValidationError[]> {
  return hasCapability(manifest, `state:write:${targetPath}`);
}

/**
 * Check whether `manifest` allows patching `collection` under `entities:write:<collection>`.
 */
export function checkEntityWriteCapability(
  manifest: ScriptManifest,
  collection: string
): Result<void, ValidationError[]> {
  return hasCapability(manifest, `entities:write:${collection}`);
}
