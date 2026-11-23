import { readFile } from 'node:fs/promises';
import { type ValidationError, validationError } from '../core/errors.js';
import { ErrorAccumulator, type Result, err, ok } from '../core/result.js';
import {
  cloneSystemPack,
  validateSystemPack,
} from '../schema/dynamic-schema-compiler.js';
import type { SystemPack } from '../schema/tracker-module.js';

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

function scanForUnsafeKeys(value: unknown, acc: ErrorAccumulator): void {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      scanForUnsafeKeys(value[i], acc.scope(`[${i}]`));
    }
    return;
  }
  if (value === null || typeof value !== 'object') {
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
      scanForUnsafeKeys(desc.value, acc.scope(key));
    }
  }
}

function cloneJsonSafeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(cloneJsonSafeValue);
  }
  if (value !== null && typeof value === 'object' && isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.getOwnPropertyNames(value)) {
      if (isUnsafeKey(key)) {
        continue;
      }
      const desc = Object.getOwnPropertyDescriptor(value, key);
      if (desc !== undefined) {
        Object.defineProperty(out, key, {
          value: cloneJsonSafeValue(desc.value),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
    }
    return out;
  }
  return value;
}

/**
 * Parse and validate an unknown value as a `system-pack/0.1` {@link SystemPack}.
 *
 * Validates `spec === 'system-pack/0.1'`, `id`, `name`, `capabilities`, `pcCoreSections`,
 * `npcCoreSections`, `gameSystems`, `blockOrder`, and `syspromptSectionOrder`, while
 * guarding against prototype pollution keys.
 */
export function parseAndValidateSystemPack(
  raw: unknown
): Result<SystemPack, ValidationError[]> {
  if (!isPlainObject(raw)) {
    return err([
      validationError('', 'INVALID_TYPE', 'SystemPack payload must be a non-null plain object'),
    ]);
  }

  const acc = new ErrorAccumulator();
  scanForUnsafeKeys(raw, acc);

  const sanitized = cloneJsonSafeValue(raw) as Record<string, unknown>;
  if (
    typeof sanitized['id'] === 'string' &&
    isUnsafeKey(sanitized['id'].trim())
  ) {
    acc.add(
      'id',
      'UNSAFE_PROPERTY_KEY',
      `Forbidden prototype property key "${sanitized['id']}" in SystemPack id`
    );
  }

  if (sanitized['description'] === undefined) {
    Object.defineProperty(sanitized, 'description', {
      value: '',
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  // Validate against canonical SystemPack rules.
  const candidate = sanitized as unknown as SystemPack;
  const packValidation = validateSystemPack(candidate);
  if (!packValidation.ok) {
    acc.addAll(packValidation.error);
  }

  // Additional unsafe-key checks on section IDs and module IDs.
  if (Array.isArray(sanitized['pcCoreSections'])) {
    for (let i = 0; i < sanitized['pcCoreSections'].length; i += 1) {
      const sec = sanitized['pcCoreSections'][i] as Record<string, unknown> | undefined;
      if (sec && typeof sec['id'] === 'string' && isUnsafeKey(sec['id'].trim())) {
        acc.add(
          `pcCoreSections[${i}].id`,
          'UNSAFE_PROPERTY_KEY',
          `Forbidden section id "${sec['id']}"`
        );
      }
    }
  }
  if (Array.isArray(sanitized['npcCoreSections'])) {
    for (let i = 0; i < sanitized['npcCoreSections'].length; i += 1) {
      const sec = sanitized['npcCoreSections'][i] as Record<string, unknown> | undefined;
      if (sec && typeof sec['id'] === 'string' && isUnsafeKey(sec['id'].trim())) {
        acc.add(
          `npcCoreSections[${i}].id`,
          'UNSAFE_PROPERTY_KEY',
          `Forbidden section id "${sec['id']}"`
        );
      }
    }
  }
  if (Array.isArray(sanitized['gameSystems'])) {
    for (let i = 0; i < sanitized['gameSystems'].length; i += 1) {
      const mod = sanitized['gameSystems'][i] as Record<string, unknown> | undefined;
      if (mod && typeof mod['id'] === 'string' && isUnsafeKey(mod['id'].trim())) {
        acc.add(
          `gameSystems[${i}].id`,
          'UNSAFE_PROPERTY_KEY',
          `Forbidden gameSystem id "${mod['id']}"`
        );
      }
    }
  }

  if (acc.hasErrors()) {
    return err([...acc.errors]);
  }

  return ok(cloneSystemPack(candidate));
}

/**
 * Parse and validate a JSON string containing a `system-pack/0.1` definition.
 */
export function loadSystemPackFromJson(
  jsonString: string
): Result<SystemPack, ValidationError[]> {
  if (typeof jsonString !== 'string') {
    return err([validationError('', 'INVALID_TYPE', 'SystemPack JSON input must be a string')]);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonString) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Malformed JSON';
    return err([validationError('', 'INVALID_JSON', `Failed to parse SystemPack JSON: ${message}`)]);
  }

  return parseAndValidateSystemPack(parsed);
}

/**
 * Load, parse, and validate a `system-pack/0.1` JSON file from disk.
 */
export async function loadSystemPackFromFile(
  filePath: string
): Promise<Result<SystemPack, ValidationError[]>> {
  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    return err([validationError('filePath', 'REQUIRED', 'filePath must be a non-empty string')]);
  }

  let rawText: string;
  try {
    rawText = await readFile(filePath, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to read file';
    return err([
      validationError(
        '',
        'FILE_READ_ERROR',
        `Failed to read SystemPack file "${filePath}": ${message}`
      ),
    ]);
  }

  return loadSystemPackFromJson(rawText);
}
