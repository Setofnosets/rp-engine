import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as path from 'node:path';
import { type ValidationError, validationError } from '../core/errors.js';
import { type Result, err, ok } from '../core/result.js';

export const ALLOWED_ASSET_MIME_BY_EXT: ReadonlyMap<string, string> = new Map([
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.svg', 'image/svg+xml'],
  ['.geojson', 'application/geo+json'],
  ['.json', 'application/json'],
  ['.mp3', 'audio/mpeg'],
  ['.wav', 'audio/wav'],
  ['.ogg', 'audio/ogg'],
]);

export const DEFAULT_ASSET_CACHE_CONTROL = 'public, max-age=3600, must-revalidate';

export interface AssetResolutionError {
  readonly status: number;
  readonly errors: ValidationError[];
}

export interface ContainedAssetInfo {
  readonly resolvedPath: string;
  readonly normalizedRelPath: string;
  readonly mimeType: string;
}

export interface ServeSafeBinaryAssetOptions {
  readonly rootDir?: string;
  readonly relPath: string;
  readonly inMemoryBuffer?: Buffer | Uint8Array;
  readonly cacheControl?: string;
}

function isContainedWithin(resolvedRoot: string, resolvedTarget: string): boolean {
  const normalizedRoot = process.platform === 'win32' ? resolvedRoot.toLowerCase() : resolvedRoot;
  const normalizedTarget = process.platform === 'win32' ? resolvedTarget.toLowerCase() : resolvedTarget;
  const rel = path.relative(normalizedRoot, normalizedTarget);
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Resolve a MIME type from an asset path's extension against the strict allowlist.
 */
export function resolveAllowedAssetMime(assetPath: string): string | null {
  const ext = path.extname(assetPath).toLowerCase();
  return ALLOWED_ASSET_MIME_BY_EXT.get(ext) ?? null;
}

/**
 * Decode, validate, and normalize a relative asset path, rejecting traversal (`..`),
 * null bytes, drive-letter prefixes, and unsupported MIME extensions.
 */
export function normalizeRelativeAssetPath(
  requestedRelPath: string
): Result<{ readonly normalizedRelPath: string; readonly mimeType: string }, AssetResolutionError> {
  if (typeof requestedRelPath !== 'string' || requestedRelPath.trim().length === 0) {
    return err({
      status: 400,
      errors: [validationError('assetPath', 'REQUIRED', 'Asset path must be a non-empty string')],
    });
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(requestedRelPath);
  } catch {
    return err({
      status: 400,
      errors: [validationError('assetPath', 'INVALID_ENCODING', 'Malformed URL encoding in asset path')],
    });
  }

  if (decoded.includes('\0')) {
    return err({
      status: 403,
      errors: [validationError('assetPath', 'FORBIDDEN_PATH', 'Null byte in asset path')],
    });
  }

  const slashNormalized = decoded.replace(/\\/g, '/').replace(/^\/+/, '');
  if (slashNormalized.length === 0) {
    return err({
      status: 400,
      errors: [validationError('assetPath', 'REQUIRED', 'Asset path must not be empty')],
    });
  }

  if (/^[a-zA-Z]:/.test(slashNormalized)) {
    return err({
      status: 403,
      errors: [
        validationError('assetPath', 'FORBIDDEN_PATH_TRAVERSAL', 'Drive-prefixed asset paths are forbidden'),
      ],
    });
  }

  const segments = slashNormalized.split('/');
  for (const seg of segments) {
    if (seg === '..' || seg === '.') {
      return err({
        status: 403,
        errors: [
          validationError(
            'assetPath',
            'FORBIDDEN_PATH_TRAVERSAL',
            'Path traversal segments ("." / "..") are forbidden'
          ),
        ],
      });
    }
  }

  const mimeType = resolveAllowedAssetMime(slashNormalized);
  if (mimeType === null) {
    return err({
      status: 415,
      errors: [
        validationError(
          'assetPath',
          'UNSUPPORTED_ASSET_TYPE',
          `Unsupported asset extension for "${slashNormalized}"`
        ),
      ],
    });
  }

  return ok({
    normalizedRelPath: segments.filter((s) => s.length > 0).join('/'),
    mimeType,
  });
}

/**
 * Resolve `requestedRelPath` strictly within `rootDir`, returning `403` on any traversal
 * or root-escape attempt and `415` on disallowed MIME extensions.
 */
export function resolveContainedAssetPath(
  rootDir: string,
  requestedRelPath: string
): Result<ContainedAssetInfo, AssetResolutionError> {
  if (typeof rootDir !== 'string' || rootDir.trim().length === 0) {
    return err({
      status: 500,
      errors: [validationError('rootDir', 'REQUIRED', 'Asset rootDir is required')],
    });
  }

  const normRes = normalizeRelativeAssetPath(requestedRelPath);
  if (!normRes.ok) {
    return normRes;
  }

  const resolvedRoot = path.resolve(rootDir);
  const resolvedTarget = path.resolve(resolvedRoot, normRes.value.normalizedRelPath);
  if (!isContainedWithin(resolvedRoot, resolvedTarget)) {
    return err({
      status: 403,
      errors: [
        validationError(
          'assetPath',
          'FORBIDDEN_PATH_TRAVERSAL',
          'Resolved asset path escapes the allowed root directory'
        ),
      ],
    });
  }

  return ok({
    resolvedPath: resolvedTarget,
    normalizedRelPath: normRes.value.normalizedRelPath,
    mimeType: normRes.value.mimeType,
  });
}

/**
 * Compute a deterministic weak/strong SHA-256 ETag for a binary buffer.
 */
export function computeAssetETag(buffer: Buffer | Uint8Array): string {
  const hash = createHash('sha256').update(buffer).digest('hex').slice(0, 32);
  return `"${hash}"`;
}

/**
 * Stream an in-memory binary buffer over HTTP with `ETag`, `Cache-Control`, `If-None-Match`,
 * and `X-Content-Type-Options: nosniff`.
 */
export function serveBufferAsset(
  req: IncomingMessage,
  res: ServerResponse,
  buffer: Buffer | Uint8Array,
  mimeType: string,
  cacheControl: string = DEFAULT_ASSET_CACHE_CONTROL
): void {
  const body = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const etag = computeAssetETag(body);
  const ifNoneMatch = req.headers['if-none-match'];

  if (typeof ifNoneMatch === 'string' && ifNoneMatch.trim() === etag) {
    res.writeHead(304, {
      ETag: etag,
      'Cache-Control': cacheControl,
      'X-Content-Type-Options': 'nosniff',
    });
    res.end();
    return;
  }

  res.writeHead(200, {
    'Content-Type': mimeType,
    'Content-Length': body.byteLength,
    ETag: etag,
    'Cache-Control': cacheControl,
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

/**
 * Safely serve a binary asset from either an in-memory buffer or a contained disk directory.
 */
export async function serveSafeBinaryAsset(
  req: IncomingMessage,
  res: ServerResponse,
  options: ServeSafeBinaryAssetOptions
): Promise<Result<void, AssetResolutionError>> {
  const normRes = normalizeRelativeAssetPath(options.relPath);
  if (!normRes.ok) {
    return err(normRes.error);
  }

  if (options.inMemoryBuffer !== undefined) {
    serveBufferAsset(
      req,
      res,
      options.inMemoryBuffer,
      normRes.value.mimeType,
      options.cacheControl
    );
    return ok(undefined);
  }

  if (options.rootDir === undefined) {
    return err({
      status: 404,
      errors: [validationError('assetPath', 'NOT_FOUND', `Asset "${options.relPath}" not found`)],
    });
  }

  const containedRes = resolveContainedAssetPath(options.rootDir, options.relPath);
  if (!containedRes.ok) {
    return err(containedRes.error);
  }

  const { resolvedPath, mimeType } = containedRes.value;
  let stat;
  try {
    stat = await fs.stat(resolvedPath);
  } catch {
    return err({
      status: 404,
      errors: [validationError('assetPath', 'NOT_FOUND', `Asset "${options.relPath}" not found`)],
    });
  }

  if (!stat.isFile()) {
    return err({
      status: 404,
      errors: [validationError('assetPath', 'NOT_FOUND', `Asset "${options.relPath}" is not a file`)],
    });
  }

  const realRoot = await fs.realpath(path.resolve(options.rootDir));
  const realTarget = await fs.realpath(resolvedPath);
  if (!isContainedWithin(realRoot, realTarget)) {
    return err({
      status: 403,
      errors: [
        validationError(
          'assetPath',
          'FORBIDDEN_PATH_TRAVERSAL',
          'Symlinked asset path escapes the allowed root directory'
        ),
      ],
    });
  }

  const buffer = await fs.readFile(realTarget);
  serveBufferAsset(req, res, buffer, mimeType, options.cacheControl);
  return ok(undefined);
}
