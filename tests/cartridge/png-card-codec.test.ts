import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  PNG_SIGNATURE,
  computePngChunkCrc,
  embedCharaJsonInPng,
  extractCharaJsonFromPngBuffer,
} from '../../src/cartridge/png-card-codec.js';
import { isErr, isOk } from '../../src/core/result.js';

interface ParsedChunk {
  type: string;
  data: Buffer;
  crc: number;
  raw: Buffer;
}

function parseAllChunks(pngBuffer: Buffer): ParsedChunk[] {
  const chunks: ParsedChunk[] = [];
  let offset = 8;
  while (offset + 12 <= pngBuffer.length) {
    const length = pngBuffer.readUInt32BE(offset);
    const type = pngBuffer.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const crc = pngBuffer.readUInt32BE(dataEnd);
    const raw = pngBuffer.subarray(offset, dataEnd + 4);
    chunks.push({
      type,
      data: pngBuffer.subarray(dataStart, dataEnd),
      crc,
      raw,
    });
    offset = dataEnd + 4;
    if (type === 'IEND') {
      break;
    }
  }
  return chunks;
}

function makeChunkWithValidCrc(type: string, data: Buffer): Buffer {
  const len = Buffer.allocUnsafe(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.allocUnsafe(4);
  crc.writeUInt32BE(computePngChunkCrc(type, data), 0);
  return Buffer.concat([len, Buffer.from(type, 'ascii'), data, crc]);
}

function buildBasePng(): { png: Buffer; ihdr: Buffer; idat: Buffer; gama: Buffer } {
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(2, 0);
  ihdrData.writeUInt32BE(2, 4);
  ihdrData.writeUInt8(8, 8);
  ihdrData.writeUInt8(6, 9);

  const gamaData = Buffer.alloc(4);
  gamaData.writeUInt32BE(45455, 0);

  const idatData = deflateSync(Buffer.from([0, 255, 0, 0, 255, 0, 255, 0, 255]));

  const ihdr = makeChunkWithValidCrc('IHDR', ihdrData);
  const gama = makeChunkWithValidCrc('gAMA', gamaData);
  const idat = makeChunkWithValidCrc('IDAT', idatData);
  const iend = makeChunkWithValidCrc('IEND', Buffer.alloc(0));

  return {
    png: Buffer.concat([PNG_SIGNATURE, ihdr, gama, idat, iend]),
    ihdr,
    idat,
    gama,
  };
}

describe('PR-7.1 PNG Card Codec (tEXt / zTXt / iTXt)', () => {
  const sampleV3Card = {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      name: 'Lyra Noctis',
      description: 'Starlight navigator with UTF-8 runes: ★ 日本語 café',
      personality: 'Calm, observant',
      scenario: 'Aboard the orbital observatory.',
      first_mes: '"The constellations shifted again."',
    },
  };

  it('round-trips tEXt, zTXt, uncompressed iTXt, and compressed iTXt with valid CRC32 and bit-for-bit pixel preservation', () => {
    const { png: basePng, ihdr, gama, idat } = buildBasePng();

    const modes = [
      { chunkType: 'tEXt' as const, compressed: false, keyword: 'chara' as const, encodeBase64: true },
      { chunkType: 'zTXt' as const, compressed: true, keyword: 'ccv3' as const, encodeBase64: true },
      { chunkType: 'iTXt' as const, compressed: false, keyword: 'ccv3' as const, encodeBase64: false },
      { chunkType: 'iTXt' as const, compressed: true, keyword: 'ccv3' as const, encodeBase64: false },
    ];

    for (const mode of modes) {
      const embedded = embedCharaJsonInPng(basePng, sampleV3Card, mode.keyword, {
        chunkType: mode.chunkType,
        compressed: mode.compressed,
        encodeBase64: mode.encodeBase64,
      });
      expect(isOk(embedded)).toBe(true);
      if (!embedded.ok) continue;

      const chunks = parseAllChunks(embedded.value);
      for (const ch of chunks) {
        expect(ch.crc).toBe(computePngChunkCrc(ch.type, ch.data));
      }

      const outIhdr = chunks.find((c) => c.type === 'IHDR');
      const outGama = chunks.find((c) => c.type === 'gAMA');
      const outIdat = chunks.find((c) => c.type === 'IDAT');
      expect(outIhdr?.raw.equals(ihdr)).toBe(true);
      expect(outGama?.raw.equals(gama)).toBe(true);
      expect(outIdat?.raw.equals(idat)).toBe(true);

      const extracted = extractCharaJsonFromPngBuffer(embedded.value);
      expect(isOk(extracted)).toBe(true);
      if (!extracted.ok) continue;
      expect(extracted.value).toEqual(sampleV3Card);
    }
  });

  it('decodes raw latin1 tEXt payloads without corrupting extended latin1 characters', () => {
    const { png: basePng } = buildBasePng();
    const latinCard = {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: { name: 'René', description: 'Café owner' },
    };
    const embedded = embedCharaJsonInPng(basePng, latinCard, 'chara', {
      chunkType: 'tEXt',
      encodeBase64: false,
    });
    expect(isOk(embedded)).toBe(true);
    if (!embedded.ok) return;

    const extracted = extractCharaJsonFromPngBuffer(embedded.value);
    expect(isOk(extracted)).toBe(true);
    if (!extracted.ok) return;
    expect((extracted.value as { data: { name: string } }).data.name).toBe('René');
  });

  it('prefers ccv3 over chara when both metadata chunks are present', () => {
    const { png: basePng } = buildBasePng();
    const v2 = { spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'Old V2' } };
    const v3 = { spec: 'chara_card_v3', spec_version: '3.0', data: { name: 'Preferred V3' } };

    const withChara = embedCharaJsonInPng(basePng, v2, 'chara');
    expect(isOk(withChara)).toBe(true);
    if (!withChara.ok) return;

    const withBoth = embedCharaJsonInPng(withChara.value, v3, 'ccv3', { chunkType: 'zTXt' });
    expect(isOk(withBoth)).toBe(true);
    if (!withBoth.ok) return;

    const extracted = extractCharaJsonFromPngBuffer(withBoth.value);
    expect(isOk(extracted)).toBe(true);
    if (!extracted.ok) return;
    expect((extracted.value as { data: { name: string } }).data.name).toBe('Preferred V3');
  });

  it('rejects prototype-pollution keys (__proto__, constructor, prototype) in PNG JSON payloads', () => {
    const { png: basePng } = buildBasePng();
    const chunks = parseAllChunks(basePng);
    const iend = chunks.pop()!;

    for (const badKey of ['__proto__', 'constructor', 'prototype']) {
      const maliciousJson = `{"spec":"chara_card_v2","data":{"name":"Bad","${badKey}":{"polluted":true}}}`;
      const b64 = Buffer.from(maliciousJson, 'utf8').toString('base64');
      const badTextChunk = makeChunkWithValidCrc(
        'tEXt',
        Buffer.concat([Buffer.from('chara', 'latin1'), Buffer.from([0x00]), Buffer.from(b64, 'latin1')])
      );
      const craftedPng = Buffer.concat([PNG_SIGNATURE, ...chunks.map((c) => c.raw), badTextChunk, iend.raw]);
      const res = extractCharaJsonFromPngBuffer(craftedPng);
      expect(isErr(res)).toBe(true);
      if (res.ok) continue;
      expect(res.error.some((e) => e.code === 'UNSAFE_PROPERTY_KEY')).toBe(true);

      const embedRes = embedCharaJsonInPng(basePng, maliciousJson, 'ccv3');
      expect(isErr(embedRes)).toBe(true);
    }
  });

  it('rejects invalid PNG signatures, truncated chunks, and missing chara/ccv3 chunks', () => {
    expect(isErr(extractCharaJsonFromPngBuffer(Buffer.from('not-a-png')))).toBe(true);

    const { png: basePng } = buildBasePng();
    expect(isErr(extractCharaJsonFromPngBuffer(basePng))).toBe(true);

    const truncated = basePng.subarray(0, basePng.length - 5);
    expect(isErr(extractCharaJsonFromPngBuffer(truncated))).toBe(true);
  });
});
