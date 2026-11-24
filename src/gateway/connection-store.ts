import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { type ValidationError, validationError } from '../core/errors.js';
import { ErrorAccumulator, type Result, err, ok } from '../core/result.js';
import { ModelGateway } from './model-gateway.js';
import {
  AGENT_ROLES,
  type AgentRole,
  PROVIDER_KINDS,
  type ProviderKind,
  type RoleConnectionConfig,
} from './types.js';

/**
 * Named connection preset containing optional default and per-role connection overrides.
 */
export interface ConnectionProfile {
  readonly defaultConnection?: Omit<RoleConnectionConfig, 'role'>;
  readonly connections?: Partial<Record<AgentRole, Omit<RoleConnectionConfig, 'role'>>>;
}

/**
 * Versioned on-disk connection configuration document supporting named presets/profiles.
 */
export interface ConnectionsFileDocument {
  readonly version: 1;
  readonly activeProfile?: string;
  readonly defaultConnection?: Omit<RoleConnectionConfig, 'role'>;
  readonly connections?: Partial<Record<AgentRole, Omit<RoleConnectionConfig, 'role'>>>;
  readonly profiles?: Record<string, ConnectionProfile>;
}

const VALID_AGENT_ROLES: ReadonlySet<string> = new Set<string>(AGENT_ROLES);
const VALID_PROVIDER_KINDS: ReadonlySet<string> = new Set<string>(PROVIDER_KINDS);
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

const NUMERIC_SAMPLING_FIELDS = [
  'timeoutMs',
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

type NumericSamplingField = (typeof NUMERIC_SAMPLING_FIELDS)[number];

function isSafeKey(key: string): boolean {
  return key.length > 0 && !FORBIDDEN_KEYS.has(key);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
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

function compareStringsDeterministic(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
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

function cloneConnectionWithoutRole(
  config: Omit<RoleConnectionConfig, 'role'> & { readonly role?: AgentRole }
): Omit<RoleConnectionConfig, 'role'> {
  const { role: _ignoredRole, ...rest } = config;
  return {
    ...rest,
    ...(rest.stopSequences !== undefined ? { stopSequences: [...rest.stopSequences] } : {}),
  };
}

function cloneConnectionsRecord(
  connections: Partial<Record<AgentRole, Omit<RoleConnectionConfig, 'role'>>> | undefined
): Partial<Record<AgentRole, Omit<RoleConnectionConfig, 'role'>>> | undefined {
  if (connections === undefined) {
    return undefined;
  }
  const cloned: Partial<Record<AgentRole, Omit<RoleConnectionConfig, 'role'>>> = {};
  const keys = Object.keys(connections).sort(compareStringsDeterministic);
  for (const key of keys) {
    if (!isSafeKey(key) || !VALID_AGENT_ROLES.has(key)) {
      continue;
    }
    const value = Object.getOwnPropertyDescriptor(connections, key)?.value as
      | Omit<RoleConnectionConfig, 'role'>
      | undefined;
    if (value !== undefined) {
      setOwn(
        cloned as Record<string, Omit<RoleConnectionConfig, 'role'>>,
        key,
        cloneConnectionWithoutRole(value)
      );
    }
  }
  return cloned;
}

function cloneProfile(profile: ConnectionProfile): ConnectionProfile {
  const clonedConnections = cloneConnectionsRecord(profile.connections);
  return {
    ...(profile.defaultConnection !== undefined
      ? { defaultConnection: cloneConnectionWithoutRole(profile.defaultConnection) }
      : {}),
    ...(clonedConnections !== undefined ? { connections: clonedConnections } : {}),
  };
}

function cloneProfilesRecord(
  profiles: Record<string, ConnectionProfile> | undefined
): Record<string, ConnectionProfile> | undefined {
  if (profiles === undefined) {
    return undefined;
  }
  const cloned: Record<string, ConnectionProfile> = {};
  const names = Object.keys(profiles).sort(compareStringsDeterministic);
  for (const name of names) {
    if (!isSafeKey(name)) {
      continue;
    }
    const profile = Object.getOwnPropertyDescriptor(profiles, name)?.value as
      | ConnectionProfile
      | undefined;
    if (profile !== undefined) {
      setOwn(cloned, name, cloneProfile(profile));
    }
  }
  return cloned;
}

function validateAndNormalizeConnection(
  raw: unknown,
  acc: ErrorAccumulator
): Omit<RoleConnectionConfig, 'role'> | undefined {
  if (!isPlainRecord(raw)) {
    acc.add('', 'INVALID_TYPE', 'Connection configuration must be a plain object');
    return undefined;
  }

  const rawProvider = getOwn(raw, 'provider');
  let provider: ProviderKind = 'openai_compatible';
  if (rawProvider !== undefined) {
    if (typeof rawProvider !== 'string' || !VALID_PROVIDER_KINDS.has(rawProvider)) {
      acc.add(
        'provider',
        'INVALID_PROVIDER',
        `provider must be one of: ${PROVIDER_KINDS.join(', ')}`
      );
    } else {
      provider = rawProvider as ProviderKind;
    }
  }

  const rawBaseUrl = getOwn(raw, 'baseUrl');
  if (typeof rawBaseUrl !== 'string' || rawBaseUrl.trim().length === 0) {
    acc.add('baseUrl', 'REQUIRED', 'baseUrl must be a non-empty string');
  }

  const rawModel = getOwn(raw, 'model');
  if (typeof rawModel !== 'string' || rawModel.trim().length === 0) {
    acc.add('model', 'REQUIRED', 'model must be a non-empty string');
  }

  const rawApiKey = getOwn(raw, 'apiKey');
  if (rawApiKey !== undefined && typeof rawApiKey !== 'string') {
    acc.add('apiKey', 'INVALID_TYPE', 'apiKey must be a string');
  }

  const rawSupportsJsonSchema = getOwn(raw, 'supportsJsonSchema');
  if (rawSupportsJsonSchema !== undefined && typeof rawSupportsJsonSchema !== 'boolean') {
    acc.add('supportsJsonSchema', 'INVALID_TYPE', 'supportsJsonSchema must be a boolean');
  }

  const numericValues: Partial<Record<NumericSamplingField, number>> = {};
  for (const field of NUMERIC_SAMPLING_FIELDS) {
    const rawVal = getOwn(raw, field);
    if (rawVal !== undefined) {
      if (typeof rawVal !== 'number' || !Number.isFinite(rawVal)) {
        acc.add(field, 'INVALID_TYPE', `${field} must be a finite number`);
      } else {
        setOwn(numericValues as Record<string, number>, field, rawVal);
      }
    }
  }

  const rawStopSequences = getOwn(raw, 'stopSequences');
  let stopSequences: string[] | undefined;
  if (rawStopSequences !== undefined) {
    if (
      !Array.isArray(rawStopSequences) ||
      !rawStopSequences.every((item) => typeof item === 'string')
    ) {
      acc.add('stopSequences', 'INVALID_TYPE', 'stopSequences must be an array of strings');
    } else {
      stopSequences = [...rawStopSequences];
    }
  }

  if (
    typeof rawBaseUrl !== 'string' ||
    rawBaseUrl.trim().length === 0 ||
    typeof rawModel !== 'string' ||
    rawModel.trim().length === 0
  ) {
    return undefined;
  }

  return {
    provider,
    baseUrl: rawBaseUrl,
    model: rawModel,
    ...(typeof rawApiKey === 'string' ? { apiKey: rawApiKey } : {}),
    ...(typeof rawSupportsJsonSchema === 'boolean'
      ? { supportsJsonSchema: rawSupportsJsonSchema }
      : {}),
    ...numericValues,
    ...(stopSequences !== undefined ? { stopSequences } : {}),
  };
}

function validateAndNormalizeConnectionsMap(
  raw: unknown,
  acc: ErrorAccumulator
): Partial<Record<AgentRole, Omit<RoleConnectionConfig, 'role'>>> | undefined {
  if (!isPlainRecord(raw)) {
    acc.add('', 'INVALID_TYPE', 'connections must be a plain object');
    return undefined;
  }

  const normalized: Partial<Record<AgentRole, Omit<RoleConnectionConfig, 'role'>>> = {};
  const keys = Object.keys(raw).sort(compareStringsDeterministic);
  for (const roleKey of keys) {
    if (!isSafeKey(roleKey)) {
      acc.add(roleKey, 'UNSAFE_KEY', `Forbidden key '${roleKey}' in connections`);
      continue;
    }
    if (!VALID_AGENT_ROLES.has(roleKey)) {
      acc.add(roleKey, 'INVALID_ROLE', `Unknown agent role '${roleKey}'`);
      continue;
    }
    const entry = getOwn(raw, roleKey);
    const normalizedEntry = validateAndNormalizeConnection(entry, acc.scope(roleKey));
    if (normalizedEntry !== undefined) {
      setOwn(
        normalized as Record<string, Omit<RoleConnectionConfig, 'role'>>,
        roleKey,
        normalizedEntry
      );
    }
  }
  return normalized;
}

function validateAndNormalizeProfile(
  raw: unknown,
  acc: ErrorAccumulator
): ConnectionProfile | undefined {
  if (!isPlainRecord(raw)) {
    acc.add('', 'INVALID_TYPE', 'Profile must be a plain object');
    return undefined;
  }

  const rawDefault = getOwn(raw, 'defaultConnection');
  const defaultConnection =
    rawDefault !== undefined
      ? validateAndNormalizeConnection(rawDefault, acc.scope('defaultConnection'))
      : undefined;

  const rawConnections = getOwn(raw, 'connections');
  const connections =
    rawConnections !== undefined
      ? validateAndNormalizeConnectionsMap(rawConnections, acc.scope('connections'))
      : undefined;

  return {
    ...(defaultConnection !== undefined ? { defaultConnection } : {}),
    ...(connections !== undefined ? { connections } : {}),
  };
}

/**
 * Validate and normalize an unknown value into a {@link ConnectionsFileDocument},
 * upgrading legacy `referee.connections.json` files (without `version` or `profiles`) to `version: 1`.
 */
export function validateConnectionsDocument(
  raw: unknown
): Result<ConnectionsFileDocument, ValidationError[]> {
  if (containsForbiddenKeys(raw)) {
    return err([
      validationError('', 'UNSAFE_KEY', 'Forbidden prototype-polluting key in connections document'),
    ]);
  }
  if (!isPlainRecord(raw)) {
    return err([
      validationError('', 'INVALID_TYPE', 'Connections document must be a plain JSON object'),
    ]);
  }

  const acc = new ErrorAccumulator();

  const rawVersion = getOwn(raw, 'version');
  if (rawVersion !== undefined && rawVersion !== 1) {
    acc.add('version', 'UNSUPPORTED_VERSION', `Unsupported connections document version: ${String(rawVersion)}`);
  }

  const rawActiveProfile = getOwn(raw, 'activeProfile');
  let activeProfile: string | undefined;
  if (rawActiveProfile !== undefined) {
    if (typeof rawActiveProfile !== 'string' || rawActiveProfile.trim().length === 0) {
      acc.add('activeProfile', 'INVALID_TYPE', 'activeProfile must be a non-empty string');
    } else if (!isSafeKey(rawActiveProfile)) {
      acc.add('activeProfile', 'UNSAFE_KEY', `Forbidden activeProfile name '${rawActiveProfile}'`);
    } else {
      activeProfile = rawActiveProfile;
    }
  }

  const rawDefault = getOwn(raw, 'defaultConnection');
  const defaultConnection =
    rawDefault !== undefined
      ? validateAndNormalizeConnection(rawDefault, acc.scope('defaultConnection'))
      : undefined;

  const rawConnections = getOwn(raw, 'connections');
  const connections =
    rawConnections !== undefined
      ? validateAndNormalizeConnectionsMap(rawConnections, acc.scope('connections'))
      : undefined;

  const rawProfiles = getOwn(raw, 'profiles');
  let profiles: Record<string, ConnectionProfile> | undefined;
  if (rawProfiles !== undefined) {
    if (!isPlainRecord(rawProfiles)) {
      acc.add('profiles', 'INVALID_TYPE', 'profiles must be a plain object');
    } else {
      profiles = {};
      const names = Object.keys(rawProfiles).sort(compareStringsDeterministic);
      for (const name of names) {
        if (!isSafeKey(name)) {
          acc.add(`profiles.${name}`, 'UNSAFE_KEY', `Forbidden profile name '${name}'`);
          continue;
        }
        if (name.trim().length === 0) {
          acc.add('profiles', 'INVALID_PROFILE_NAME', 'Profile name must be non-empty');
          continue;
        }
        const normalizedProfile = validateAndNormalizeProfile(
          getOwn(rawProfiles, name),
          acc.scope(`profiles.${name}`)
        );
        if (normalizedProfile !== undefined) {
          setOwn(profiles, name, normalizedProfile);
        }
      }
    }
  }

  if (acc.hasErrors()) {
    return err([...acc.errors]);
  }

  return ok({
    version: 1,
    ...(activeProfile !== undefined ? { activeProfile } : {}),
    ...(defaultConnection !== undefined ? { defaultConnection } : {}),
    ...(connections !== undefined ? { connections } : {}),
    ...(profiles !== undefined ? { profiles } : {}),
  });
}

/**
 * Parse and validate a connections JSON string with prototype-pollution protection.
 */
export function parseConnectionsDocument(
  rawText: string,
  pathLabel = 'connections'
): Result<ConnectionsFileDocument, ValidationError[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText) as unknown;
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    return err([
      validationError(pathLabel, 'INVALID_JSON', `Failed to parse connections JSON: ${message}`),
    ]);
  }
  return validateConnectionsDocument(parsed);
}

/**
 * Load, parse, and validate a {@link ConnectionsFileDocument} from disk,
 * supporting both versioned documents and legacy `referee.connections.json` files.
 */
export async function loadConnectionsFile(
  filePath: string
): Promise<Result<ConnectionsFileDocument, ValidationError[]>> {
  if (typeof filePath !== 'string' || filePath.trim().length === 0 || filePath.includes('\0')) {
    return err([
      validationError('filePath', 'REQUIRED', 'filePath must be a valid non-empty string'),
    ]);
  }

  let rawText: string;
  try {
    rawText = await fs.readFile(filePath, 'utf8');
  } catch (caught) {
    const isNotFound =
      typeof caught === 'object' &&
      caught !== null &&
      'code' in caught &&
      (caught as { code?: unknown }).code === 'ENOENT';
    const message = caught instanceof Error ? caught.message : 'Unable to read connections file';
    return err([
      validationError(
        'filePath',
        isNotFound ? 'NOT_FOUND' : 'FILE_READ_ERROR',
        `Failed to read connections file "${filePath}": ${message}`
      ),
    ]);
  }

  return parseConnectionsDocument(rawText, filePath);
}

/**
 * Atomically write a {@link ConnectionsFileDocument} to disk using a same-directory temp file + rename.
 */
export async function saveConnectionsFile(
  filePath: string,
  doc: ConnectionsFileDocument
): Promise<Result<void, ValidationError[]>> {
  if (typeof filePath !== 'string' || filePath.trim().length === 0 || filePath.includes('\0')) {
    return err([
      validationError('filePath', 'REQUIRED', 'filePath must be a valid non-empty string'),
    ]);
  }

  const validated = validateConnectionsDocument(doc);
  if (!validated.ok) {
    return validated;
  }

  const parentDir = path.dirname(filePath);
  const tmpPath = `${filePath}.tmp`;
  const serialized = `${JSON.stringify(validated.value, null, 2)}\n`;
  let handle: fs.FileHandle | undefined;

  try {
    await fs.mkdir(parentDir, { recursive: true });
    handle = await fs.open(tmpPath, 'w');
    await handle.writeFile(serialized, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(tmpPath, filePath);
    return ok();
  } catch (caught) {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
    await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    const message = caught instanceof Error ? caught.message : 'Unable to write connections file';
    return err([
      validationError(
        'filePath',
        'FILE_WRITE_ERROR',
        `Failed to write connections file "${filePath}": ${message}`
      ),
    ]);
  }
}

/**
 * Apply the connections from a {@link ConnectionsFileDocument} onto a {@link ModelGateway},
 * clearing any previous per-role overrides first.
 */
export function applyConnectionsFileToGateway(
  gateway: ModelGateway,
  doc: ConnectionsFileDocument
): void {
  let effectiveDefault = doc.defaultConnection;
  let effectiveConnections = doc.connections;

  if (
    effectiveDefault === undefined &&
    effectiveConnections === undefined &&
    doc.activeProfile !== undefined &&
    doc.profiles !== undefined &&
    isSafeKey(doc.activeProfile) &&
    Object.hasOwn(doc.profiles, doc.activeProfile)
  ) {
    const active = Object.getOwnPropertyDescriptor(doc.profiles, doc.activeProfile)?.value as
      | ConnectionProfile
      | undefined;
    if (active !== undefined) {
      effectiveDefault = active.defaultConnection;
      effectiveConnections = active.connections;
    }
  }

  gateway.clearRoleConnections();
  gateway.setDefaultConnection(
    effectiveDefault !== undefined ? cloneConnectionWithoutRole(effectiveDefault) : undefined
  );

  if (effectiveConnections !== undefined) {
    const roleKeys = Object.keys(effectiveConnections).sort(compareStringsDeterministic);
    for (const roleKey of roleKeys) {
      if (!isSafeKey(roleKey) || !VALID_AGENT_ROLES.has(roleKey)) {
        continue;
      }
      const cfg = Object.getOwnPropertyDescriptor(effectiveConnections, roleKey)?.value as
        | Omit<RoleConnectionConfig, 'role'>
        | undefined;
      if (cfg !== undefined) {
        gateway.setRoleConnection(roleKey as AgentRole, cloneConnectionWithoutRole(cfg));
      }
    }
  }
}

/**
 * Capture the current unredacted connections from a {@link ModelGateway} into a
 * {@link ConnectionsFileDocument}, preserving `activeProfile` and `profiles` from `existingDoc` if supplied.
 */
export function snapshotGatewayToConnectionsDoc(
  gateway: ModelGateway,
  existingDoc?: ConnectionsFileDocument
): ConnectionsFileDocument {
  const snapshot = gateway.getConnectionsSnapshot();
  const connections: Partial<Record<AgentRole, Omit<RoleConnectionConfig, 'role'>>> = {};
  const roleKeys = Object.keys(snapshot.connections).sort(compareStringsDeterministic);

  for (const roleKey of roleKeys) {
    if (!isSafeKey(roleKey) || !VALID_AGENT_ROLES.has(roleKey)) {
      continue;
    }
    const cfg = Object.getOwnPropertyDescriptor(snapshot.connections, roleKey)?.value as
      | RoleConnectionConfig
      | undefined;
    if (cfg !== undefined) {
      setOwn(
        connections as Record<string, Omit<RoleConnectionConfig, 'role'>>,
        roleKey,
        cloneConnectionWithoutRole(cfg)
      );
    }
  }

  const preservedProfiles = cloneProfilesRecord(existingDoc?.profiles);

  return {
    version: 1,
    ...(existingDoc?.activeProfile !== undefined && isSafeKey(existingDoc.activeProfile)
      ? { activeProfile: existingDoc.activeProfile }
      : {}),
    ...(snapshot.defaultConnection !== undefined
      ? { defaultConnection: cloneConnectionWithoutRole(snapshot.defaultConnection) }
      : {}),
    connections,
    ...(preservedProfiles !== undefined ? { profiles: preservedProfiles } : {}),
  };
}

function validateProfileName(name: string): ValidationError | undefined {
  if (typeof name !== 'string' || name.trim().length === 0) {
    return validationError('name', 'INVALID_PROFILE_NAME', 'Profile name must be a non-empty string');
  }
  if (!isSafeKey(name)) {
    return validationError('name', 'UNSAFE_KEY', `Forbidden profile name '${name}'`);
  }
  return undefined;
}

/**
 * Return a new {@link ConnectionsFileDocument} with the named {@link ConnectionProfile} saved or updated.
 */
export function saveNamedProfile(
  doc: ConnectionsFileDocument,
  name: string,
  profile: ConnectionProfile
): Result<ConnectionsFileDocument, ValidationError[]> {
  const nameErr = validateProfileName(name);
  if (nameErr !== undefined) {
    return err([nameErr]);
  }
  if (containsForbiddenKeys(profile)) {
    return err([
      validationError('profile', 'UNSAFE_KEY', 'Forbidden prototype-polluting key in profile'),
    ]);
  }

  const acc = new ErrorAccumulator('profile');
  const validatedProfile = validateAndNormalizeProfile(profile, acc);
  if (acc.hasErrors() || validatedProfile === undefined) {
    return err(
      acc.hasErrors()
        ? [...acc.errors]
        : [validationError('profile', 'INVALID_TYPE', 'Profile must be a plain object')]
    );
  }

  const nextProfiles = cloneProfilesRecord(doc.profiles) ?? {};
  setOwn(nextProfiles, name, validatedProfile);

  const clonedConnections = cloneConnectionsRecord(doc.connections);

  return ok({
    version: 1,
    ...(doc.activeProfile !== undefined && isSafeKey(doc.activeProfile)
      ? { activeProfile: doc.activeProfile }
      : {}),
    ...(doc.defaultConnection !== undefined
      ? { defaultConnection: cloneConnectionWithoutRole(doc.defaultConnection) }
      : {}),
    ...(clonedConnections !== undefined ? { connections: clonedConnections } : {}),
    profiles: nextProfiles,
  });
}

/**
 * Activate a named profile from `doc.profiles`, apply it to `gateway`,
 * and return the updated {@link ConnectionsFileDocument} with `activeProfile` and top-level connections synchronized.
 */
export function activateNamedProfile(
  doc: ConnectionsFileDocument,
  name: string,
  gateway: ModelGateway
): Result<ConnectionsFileDocument, ValidationError[]> {
  const nameErr = validateProfileName(name);
  if (nameErr !== undefined) {
    return err([nameErr]);
  }

  if (doc.profiles === undefined || !Object.hasOwn(doc.profiles, name)) {
    return err([validationError('name', 'PROFILE_NOT_FOUND', `Profile '${name}' does not exist`)]);
  }

  const targetProfile = Object.getOwnPropertyDescriptor(doc.profiles, name)?.value as
    | ConnectionProfile
    | undefined;
  if (targetProfile === undefined) {
    return err([validationError('name', 'PROFILE_NOT_FOUND', `Profile '${name}' does not exist`)]);
  }

  const clonedProfile = cloneProfile(targetProfile);
  const nextProfiles = cloneProfilesRecord(doc.profiles) ?? {};

  const nextDoc: ConnectionsFileDocument = {
    version: 1,
    activeProfile: name,
    ...(clonedProfile.defaultConnection !== undefined
      ? { defaultConnection: clonedProfile.defaultConnection }
      : {}),
    ...(clonedProfile.connections !== undefined ? { connections: clonedProfile.connections } : {}),
    profiles: nextProfiles,
  };

  applyConnectionsFileToGateway(gateway, nextDoc);
  return ok(nextDoc);
}

/**
 * Delete a named profile from `doc.profiles`, clearing `activeProfile` if it matched the deleted profile.
 */
export function deleteNamedProfile(
  doc: ConnectionsFileDocument,
  name: string
): Result<ConnectionsFileDocument, ValidationError[]> {
  const nameErr = validateProfileName(name);
  if (nameErr !== undefined) {
    return err([nameErr]);
  }

  if (doc.profiles === undefined || !Object.hasOwn(doc.profiles, name)) {
    return err([validationError('name', 'PROFILE_NOT_FOUND', `Profile '${name}' does not exist`)]);
  }

  const nextProfiles: Record<string, ConnectionProfile> = {};
  const existingNames = Object.keys(doc.profiles).sort(compareStringsDeterministic);
  for (const existingName of existingNames) {
    if (existingName === name || !isSafeKey(existingName)) {
      continue;
    }
    const profile = Object.getOwnPropertyDescriptor(doc.profiles, existingName)?.value as
      | ConnectionProfile
      | undefined;
    if (profile !== undefined) {
      setOwn(nextProfiles, existingName, cloneProfile(profile));
    }
  }

  const nextActiveProfile =
    doc.activeProfile !== undefined && doc.activeProfile !== name && isSafeKey(doc.activeProfile)
      ? doc.activeProfile
      : undefined;
  const clonedConnections = cloneConnectionsRecord(doc.connections);

  return ok({
    version: 1,
    ...(nextActiveProfile !== undefined ? { activeProfile: nextActiveProfile } : {}),
    ...(doc.defaultConnection !== undefined
      ? { defaultConnection: cloneConnectionWithoutRole(doc.defaultConnection) }
      : {}),
    ...(clonedConnections !== undefined ? { connections: clonedConnections } : {}),
    profiles: nextProfiles,
  });
}
