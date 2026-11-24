import { deflateSync, inflateSync } from 'node:zlib';
import { type ValidationError, validationError } from '../core/errors.js';
import { ErrorAccumulator, type Result, err, ok } from '../core/result.js';
import {
  isPlainObject,
  isUnsafeRecordKey,
  scanObjectForUnsafeKeys,
  setSafeProperty,
} from './cartridge-schema.js';

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type PngCardKeyword = 'ccv3' | 'chara';
export type PngTextChunkType = 'tEXt' | 'zTXt' | 'iTXt';

export interface EmbedCharaJsonOptions {
  chunkType?: PngTextChunkType;
  compressed?: boolean;
  encodeBase64?: boolean;
}

const CRC32_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * Compute standard IEEE 802.3 CRC32 (used by PNG chunks) over a byte sequence.
 */
export function computeCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i] ?? 0;
    const tableVal = CRC32_TABLE[(crc ^ byte) & 0xff] ?? 0;
    crc = (tableVal ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Compute PNG chunk CRC32 over the 4-byte ASCII chunk type and chunk data bytes.
 */
export function computePngChunkCrc(chunkType: string, data: Uint8Array): number {
  const typeBytes = Buffer.from(chunkType, 'ascii');
  const combined = Buffer.concat([typeBytes, data]);
  return computeCrc32(combined);
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
        setSafeProperty(out, key, sanitizeJsonValue(desc.value));
      }
    }
    return out;
  }
  return value;
}

function decodeBase64OrJsonString(rawText: string): Result<unknown, ValidationError[]> {
  const trimmed = rawText.trim();
  if (trimmed.length === 0) {
    return err([validationError('', 'EMPTY_PAYLOAD', 'Card text payload is empty')]);
  }

  const tryParseJson = (candidate: string): { ok: true; value: unknown } | { ok: false } => {
    try {
      return { ok: true, value: JSON.parse(candidate) as unknown };
    } catch {
      return { ok: false };
    }
  };

  if (trimmed.startsWith('{')) {
    const direct = tryParseJson(trimmed);
    if (direct.ok) {
      return ok(direct.value);
    }
  }

  const decoded = Buffer.from(trimmed, 'base64').toString('utf8').trim();
  const fromBase64 = tryParseJson(decoded);
  if (fromBase64.ok) {
    return ok(fromBase64.value);
  }

  const directFallback = tryParseJson(trimmed);
  if (directFallback.ok) {
    return ok(directFallback.value);
  }

  return err([
    validationError(
      '',
      'INVALID_JSON',
      'Failed to decode SillyTavern card JSON from base64 or UTF-8 text'
    ),
  ]);
}

function parsePngTextChunk(data: Buffer): { keyword: string; text: string } | null {
  const nullIdx = data.indexOf(0x00);
  if (nullIdx <= 0) {
    return null;
  }
  const keyword = data.subarray(0, nullIdx).toString('latin1');
  const text = data.subarray(nullIdx + 1).toString('latin1');
  return { keyword, text };
}

function parsePngZtxtChunk(
  data: Buffer
): Result<{ keyword: string; text: string } | null, ValidationError[]> {
  const nullIdx = data.indexOf(0x00);
  if (nullIdx <= 0 || nullIdx + 1 >= data.length) {
    return ok(null);
  }
  const keyword = data.subarray(0, nullIdx).toString('latin1');
  const compressionMethod = data.readUInt8(nullIdx + 1);
  if (compressionMethod !== 0) {
    return err([
      validationError(
        '',
        'UNSUPPORTED_COMPRESSION',
        `Unsupported zTXt compression method ${compressionMethod}`
      ),
    ]);
  }
  const compressedBytes = data.subarray(nullIdx + 2);
  try {
    const inflated = inflateSync(compressedBytes);
    return ok({ keyword, text: inflated.toString('latin1') });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'zlib inflate failed';
    return err([
      validationError('', 'DECOMPRESSION_FAILED', `Failed to decompress PNG zTXt chunk: ${message}`),
    ]);
  }
}

function parsePngItxtChunk(
  data: Buffer
): Result<{ keyword: string; text: string } | null, ValidationError[]> {
  const keywordEnd = data.indexOf(0x00);
  if (keywordEnd <= 0 || keywordEnd + 2 >= data.length) {
    return ok(null);
  }
  const keyword = data.subarray(0, keywordEnd).toString('latin1');
  const compressionFlag = data.readUInt8(keywordEnd + 1);
  const compressionMethod = data.readUInt8(keywordEnd + 2);

  let pos = keywordEnd + 3;
  const langEnd = data.indexOf(0x00, pos);
  if (langEnd === -1) {
    return ok(null);
  }
  pos = langEnd + 1;

  const transEnd = data.indexOf(0x00, pos);
  if (transEnd === -1) {
    return ok(null);
  }
  pos = transEnd + 1;

  const textBytes = data.subarray(pos);
  if (compressionFlag === 1) {
    if (compressionMethod !== 0) {
      return err([
        validationError(
          '',
          'UNSUPPORTED_COMPRESSION',
          `Unsupported iTXt compression method ${compressionMethod}`
        ),
      ]);
    }
    try {
      const inflated = inflateSync(textBytes);
      return ok({ keyword, text: inflated.toString('utf8') });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'zlib inflate failed';
      return err([
        validationError('', 'DECOMPRESSION_FAILED', `Failed to decompress PNG iTXt chunk: ${message}`),
      ]);
    }
  }

  return ok({ keyword, text: textBytes.toString('utf8') });
}

function buildPngChunk(chunkType: string, data: Buffer): Buffer {
  const lengthBuf = Buffer.allocUnsafe(4);
  lengthBuf.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(chunkType, 'ascii');
  const crcBuf = Buffer.allocUnsafe(4);
  crcBuf.writeUInt32BE(computePngChunkCrc(chunkType, data), 0);
  return Buffer.concat([lengthBuf, typeBuf, data, crcBuf]);
}

function buildTextChunk(keyword: string, payloadText: string): Buffer {
  const data = Buffer.concat([
    Buffer.from(keyword, 'latin1'),
    Buffer.from([0x00]),
    Buffer.from(payloadText, 'latin1'),
  ]);
  return buildPngChunk('tEXt', data);
}

function buildZtxtChunk(keyword: string, payloadText: string): Buffer {
  const compressed = deflateSync(Buffer.from(payloadText, 'latin1'));
  const data = Buffer.concat([
    Buffer.from(keyword, 'latin1'),
    Buffer.from([0x00, 0x00]),
    compressed,
  ]);
  return buildPngChunk('zTXt', data);
}

function buildItxtChunk(keyword: string, payloadText: string, compressed: boolean): Buffer {
  const textBytes = Buffer.from(payloadText, 'utf8');
  const payload = compressed ? deflateSync(textBytes) : textBytes;
  const data = Buffer.concat([
    Buffer.from(keyword, 'latin1'),
    Buffer.from([0x00, compressed ? 1 : 0, 0x00, 0x00, 0x00]),
    payload,
  ]);
  return buildPngChunk('iTXt', data);
}

function extractKeywordFromChunk(chunkType: string, data: Buffer): string | null {
  if (chunkType !== 'tEXt' && chunkType !== 'zTXt' && chunkType !== 'iTXt') {
    return null;
  }
  const nullIdx = data.indexOf(0x00);
  if (nullIdx <= 0) {
    return null;
  }
  return data.subarray(0, nullIdx).toString('latin1');
}

/**
 * Pure Node `Buffer` + `node:zlib` PNG chunk parser that locates SillyTavern
 * `ccv3` (preferred V3) or `chara` (V2) metadata in `tEXt`, `zTXt`, or `iTXt`
 * chunks, decodes the embedded JSON payload, and rejects prototype-pollution keys.
 */
export function extractCharaJsonFromPngBuffer(
  pngBuffer: Buffer
): Result<unknown, ValidationError[]> {
  if (!Buffer.isBuffer(pngBuffer)) {
    return err([validationError('', 'INVALID_TYPE', 'PNG input must be a Node Buffer')]);
  }
  if (pngBuffer.length < PNG_SIGNATURE.length || !pngBuffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return err([
      validationError('', 'INVALID_PNG_SIGNATURE', 'Buffer does not start with a valid PNG signature'),
    ]);
  }

  let offset = 8;
  let ccv3Text: string | undefined;
  let charaText: string | undefined;
  let sawIend = false;

  while (offset + 12 <= pngBuffer.length) {
    const length = pngBuffer.readUInt32BE(offset);
    const chunkType = pngBuffer.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const crcEnd = dataEnd + 4;

    if (crcEnd > pngBuffer.length) {
      return err([
        validationError(
          '',
          'TRUNCATED_PNG_CHUNK',
          `PNG chunk "${chunkType}" at offset ${offset} exceeds buffer length`
        ),
      ]);
    }

    const data = pngBuffer.subarray(dataStart, dataEnd);
    if (chunkType === 'tEXt') {
      const parsed = parsePngTextChunk(data);
      if (parsed) {
        if (parsed.keyword === 'ccv3' && ccv3Text === undefined) {
          ccv3Text = parsed.text;
        } else if (parsed.keyword === 'chara' && charaText === undefined) {
          charaText = parsed.text;
        }
      }
    } else if (chunkType === 'zTXt') {
      const ztxtRes = parsePngZtxtChunk(data);
      if (!ztxtRes.ok) {
        return ztxtRes;
      }
      if (ztxtRes.value) {
        if (ztxtRes.value.keyword === 'ccv3' && ccv3Text === undefined) {
          ccv3Text = ztxtRes.value.text;
        } else if (ztxtRes.value.keyword === 'chara' && charaText === undefined) {
          charaText = ztxtRes.value.text;
        }
      }
    } else if (chunkType === 'iTXt') {
      const itxtRes = parsePngItxtChunk(data);
      if (!itxtRes.ok) {
        return itxtRes;
      }
      if (itxtRes.value) {
        if (itxtRes.value.keyword === 'ccv3' && ccv3Text === undefined) {
          ccv3Text = itxtRes.value.text;
        } else if (itxtRes.value.keyword === 'chara' && charaText === undefined) {
          charaText = itxtRes.value.text;
        }
      }
    } else if (chunkType === 'IEND') {
      sawIend = true;
      break;
    }

    offset = crcEnd;
  }

  if (!sawIend && offset < pngBuffer.length) {
    return err([
      validationError('', 'TRUNCATED_PNG_CHUNK', `Truncated PNG chunk header at offset ${offset}`),
    ]);
  }

  const chosen = ccv3Text ?? charaText;
  if (chosen === undefined) {
    return err([
      validationError(
        '',
        'MISSING_CHARA_CHUNK',
        'PNG image does not contain a "ccv3" or "chara" metadata chunk'
      ),
    ]);
  }

  const decoded = decodeBase64OrJsonString(chosen);
  if (!decoded.ok) {
    return decoded;
  }

  const acc = new ErrorAccumulator();
  scanObjectForUnsafeKeys(decoded.value, acc);
  if (acc.hasErrors()) {
    return err([...acc.errors]);
  }

  return ok(sanitizeJsonValue(decoded.value));
}

/**
 * Embed SillyTavern V2/V3 card JSON into a PNG buffer under `ccv3` (default) or `chara`,
 * replacing any existing chunk with the same keyword, computing valid CRC32 checksums,
 * and preserving all pixel/image chunks (`IHDR`, `IDAT`, etc.) bit-for-bit.
 */
export function embedCharaJsonInPng(
  pngBuffer: Buffer,
  cardJson: unknown,
  keyword: PngCardKeyword = 'ccv3',
  options: EmbedCharaJsonOptions = {}
): Result<Buffer, ValidationError[]> {
  if (!Buffer.isBuffer(pngBuffer)) {
    return err([validationError('', 'INVALID_TYPE', 'PNG input must be a Node Buffer')]);
  }
  if (pngBuffer.length < PNG_SIGNATURE.length || !pngBuffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return err([
      validationError('', 'INVALID_PNG_SIGNATURE', 'Buffer does not start with a valid PNG signature'),
    ]);
  }
  if (keyword !== 'ccv3' && keyword !== 'chara') {
    return err([
      validationError('keyword', 'INVALID_VALUE', 'PNG card keyword must be "ccv3" or "chara"'),
    ]);
  }

  let parsedJson: unknown;
  if (typeof cardJson === 'string') {
    try {
      parsedJson = JSON.parse(cardJson) as unknown;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid JSON';
      return err([validationError('cardJson', 'INVALID_JSON', `Invalid card JSON: ${message}`)]);
    }
  } else {
    parsedJson = cardJson;
  }

  if (!isPlainObject(parsedJson)) {
    return err([
      validationError('cardJson', 'INVALID_TYPE', 'Card JSON root must be a plain object'),
    ]);
  }

  const acc = new ErrorAccumulator();
  scanObjectForUnsafeKeys(parsedJson, acc);
  if (acc.hasErrors()) {
    return err([...acc.errors]);
  }

  const jsonString = JSON.stringify(sanitizeJsonValue(parsedJson));
  const encodeBase64 = options.encodeBase64 ?? true;
  const payloadText = encodeBase64
    ? Buffer.from(jsonString, 'utf8').toString('base64')
    : jsonString;

  const chunkType = options.chunkType ?? 'tEXt';
  let metadataChunk: Buffer;
  if (chunkType === 'tEXt') {
    metadataChunk = buildTextChunk(keyword, payloadText);
  } else if (chunkType === 'zTXt') {
    metadataChunk = buildZtxtChunk(keyword, payloadText);
  } else if (chunkType === 'iTXt') {
    metadataChunk = buildItxtChunk(keyword, payloadText, options.compressed ?? false);
  } else {
    return err([
      validationError(
        'options.chunkType',
        'INVALID_VALUE',
        `Unsupported PNG text chunk type "${String(chunkType)}"`
      ),
    ]);
  }

  const preservedChunks: Buffer[] = [PNG_SIGNATURE];
  let iendChunk: Buffer | null = null;
  let offset = 8;

  while (offset + 12 <= pngBuffer.length) {
    const length = pngBuffer.readUInt32BE(offset);
    const type = pngBuffer.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const crcEnd = dataEnd + 4;

    if (crcEnd > pngBuffer.length) {
      return err([
        validationError(
          '',
          'TRUNCATED_PNG_CHUNK',
          `PNG chunk "${type}" at offset ${offset} exceeds buffer length`
        ),
      ]);
    }

    const rawChunk = pngBuffer.subarray(offset, crcEnd);
    if (type === 'IEND') {
      iendChunk = rawChunk;
      break;
    }

    const chunkData = pngBuffer.subarray(dataStart, dataEnd);
    const existingKeyword = extractKeywordFromChunk(type, chunkData);
    if (existingKeyword !== keyword) {
      preservedChunks.push(rawChunk);
    }

    offset = crcEnd;
  }

  if (iendChunk === null && offset < pngBuffer.length) {
    return err([
      validationError('', 'TRUNCATED_PNG_CHUNK', `Truncated PNG chunk header at offset ${offset}`),
    ]);
  }

  preservedChunks.push(metadataChunk);
  preservedChunks.push(iendChunk ?? buildPngChunk('IEND', Buffer.alloc(0)));

  return ok(Buffer.concat(preservedChunks));
}
