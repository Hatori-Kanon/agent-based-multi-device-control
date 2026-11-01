import { describe, expect, it } from 'vitest'
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { MAX_PACK_BYTES } from '../src/scenario/validate.ts'
import { readZip, ZipError, type RawInflate } from '../src/scenario/zip.ts'

// The host injects the decompressor: `core` must stay free of platform APIs
// (M4b reuses it under React Native), so Node's zlib lives in the test/host.
const inflateRaw: RawInflate = (data, options) => new Uint8Array(inflateRawSync(data, options))
const readZipFixture = (bytes: Uint8Array): Promise<Map<string, Uint8Array>> => readZip(bytes, { inflateRaw })

// ---------------------------------------------------------------------------
// A tiny ZIP writer for fixtures. The reader under test is deliberately
// zero-dependency, so the fixtures build archives by hand as well (store and
// deflate via node:zlib, which is also what the reader accepts).
// ---------------------------------------------------------------------------

const CRC32_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) !== 0 ? (0xedb88320 ^ (value >>> 1)) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = ((crc >>> 8) ^ CRC32_TABLE[(crc ^ byte) & 0xff]!) >>> 0
  return (crc ^ 0xffffffff) >>> 0
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0)
  const result = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.byteLength
  }
  return result
}

interface TestEntry {
  /** A string is UTF-8 encoded and flagged; raw bytes are written verbatim. */
  readonly name: string | Uint8Array
  readonly data: Uint8Array
  /** 0 = store (default), 8 = deflate, anything else = unsupported fixture. */
  readonly method?: number
  readonly flags?: number
  readonly crc?: number
  readonly uncompressedSize?: number
}

function makeZip(entries: readonly TestEntry[], options: { readonly zip64?: boolean } = {}): Uint8Array {
  const localParts: Uint8Array[] = []
  const centralParts: Uint8Array[] = []
  let localOffset = 0
  for (const entry of entries) {
    const nameBytes = typeof entry.name === 'string' ? utf8(entry.name) : entry.name
    const flags = entry.flags ?? (typeof entry.name === 'string' && /[^\u0000-\u007f]/u.test(entry.name) ? 0x0800 : 0)
    const method = entry.method ?? 0
    const compressed = method === 8 ? new Uint8Array(deflateRawSync(entry.data)) : entry.data
    const crc = entry.crc ?? crc32(entry.data)
    const uncompressedSize = entry.uncompressedSize ?? entry.data.byteLength

    const local = new Uint8Array(30 + nameBytes.byteLength + compressed.byteLength)
    const localView = new DataView(local.buffer)
    localView.setUint32(0, 0x04034b50, true)
    localView.setUint16(4, 20, true)
    localView.setUint16(6, flags, true)
    localView.setUint16(8, method, true)
    localView.setUint16(10, 0, true)
    localView.setUint16(12, 0x21, true)
    localView.setUint32(14, crc, true)
    localView.setUint32(18, compressed.byteLength, true)
    localView.setUint32(22, uncompressedSize, true)
    localView.setUint16(26, nameBytes.byteLength, true)
    localView.setUint16(28, 0, true)
    local.set(nameBytes, 30)
    local.set(compressed, 30 + nameBytes.byteLength)
    localParts.push(local)

    const central = new Uint8Array(46 + nameBytes.byteLength)
    const centralView = new DataView(central.buffer)
    centralView.setUint32(0, 0x02014b50, true)
    centralView.setUint16(4, 20, true)
    centralView.setUint16(6, 20, true)
    centralView.setUint16(8, flags, true)
    centralView.setUint16(10, method, true)
    centralView.setUint16(12, 0, true)
    centralView.setUint16(14, 0x21, true)
    centralView.setUint32(16, crc, true)
    centralView.setUint32(20, compressed.byteLength, true)
    centralView.setUint32(24, uncompressedSize, true)
    centralView.setUint16(28, nameBytes.byteLength, true)
    centralView.setUint16(30, 0, true)
    centralView.setUint16(32, 0, true)
    centralView.setUint16(34, 0, true)
    centralView.setUint16(36, 0, true)
    centralView.setUint32(38, 0, true)
    centralView.setUint32(42, localOffset, true)
    central.set(nameBytes, 46)
    centralParts.push(central)

    localOffset += local.byteLength
  }
  const centralOffset = localOffset
  const centralSize = centralParts.reduce((sum, part) => sum + part.byteLength, 0)
  const eocd = new Uint8Array(22)
  const eocdView = new DataView(eocd.buffer)
  eocdView.setUint32(0, 0x06054b50, true)
  eocdView.setUint16(8, entries.length, true)
  eocdView.setUint16(10, entries.length, true)
  eocdView.setUint32(12, options.zip64 === true ? 0xffffffff : centralSize, true)
  eocdView.setUint32(16, options.zip64 === true ? 0xffffffff : centralOffset, true)
  return concat([...localParts, ...centralParts, eocd])
}

async function zipFailure(promise: Promise<unknown>): Promise<ZipError> {
  try {
    await promise
    throw new Error('readZip should have rejected')
  } catch (error) {
    expect(error).toBeInstanceOf(ZipError)
    return error as ZipError
  }
}

describe('content-pack zip reader', () => {
  it('reads stored and deflated entries and rejects an unsupported compression method', async () => {
    const persona = '# 角色\n\n温柔而克制的引导者。\n'.repeat(20)
    const archive = makeZip([
      { name: 'pack.json', data: utf8('{"id":"low-tide"}') },
      { name: 'persona.md', data: utf8(persona), method: 8 },
      { name: 'phases/', data: new Uint8Array(0) },
    ])
    const files = await readZipFixture(archive)
    // Directory entries carry no data and are not files.
    expect([...files.keys()]).toEqual(['pack.json', 'persona.md'])
    expect(new TextDecoder().decode(files.get('pack.json'))).toBe('{"id":"low-tide"}')
    expect(new TextDecoder().decode(files.get('persona.md'))).toBe(persona)

    const unsupported = makeZip([{ name: 'pack.json', data: utf8('{}'), method: 12 }])
    const error = await zipFailure(readZipFixture(unsupported))
    expect(error.code).toBe('unsupported-method')
    expect(error.message).toContain('12')
  })

  it('fixes CP437 file names and honours the UTF-8 flag', async () => {
    // 0x84 is 'ä' in CP437: decoding it as UTF-8 would yield a replacement char.
    const cp437Name = new Uint8Array([0x84, ...utf8('.md')])
    const archive = makeZip([
      { name: cp437Name, data: utf8('cp437') },
      { name: '人设.md', data: utf8('utf8') },
    ])
    const files = await readZipFixture(archive)
    expect([...files.keys()]).toEqual(['ä.md', '人设.md'])
    expect(new TextDecoder().decode(files.get('人设.md'))).toBe('utf8')
  })

  it('rejects absolute paths and path traversal', async () => {
    for (const name of ['../evil.md', '/etc/passwd', 'a\\..\\b.md', 'a/../b.md', 'C:/windows/evil.md', 'a//b.md']) {
      const error = await zipFailure(readZipFixture(makeZip([{ name, data: utf8('x') }])))
      expect(error.code, name).toBe('unsafe-path')
    }
  })

  it('rejects an archive whose uncompressed total exceeds the pack limit', async () => {
    const archive = makeZip([
      {
        name: 'waveforms/big.json',
        data: utf8('{}'),
        method: 8,
        uncompressedSize: MAX_PACK_BYTES + 1,
      },
    ])
    const error = await zipFailure(readZipFixture(archive))
    expect(error.code).toBe('too-large')
  })

  it('rejects encrypted and ZIP64 archives and corrupt CRCs', async () => {
    const encrypted = await zipFailure(readZipFixture(makeZip([{ name: 'pack.json', data: utf8('{}'), flags: 0x0001 }])))
    expect(encrypted.code).toBe('encrypted')

    const zip64 = await zipFailure(readZipFixture(makeZip([{ name: 'pack.json', data: utf8('{}') }], { zip64: true })))
    expect(zip64.code).toBe('zip64-unsupported')

    const badCrc = await zipFailure(readZipFixture(makeZip([{ name: 'pack.json', data: utf8('{}'), crc: 0x12345678 }])))
    expect(badCrc.code).toBe('crc-mismatch')
    expect(badCrc.entry).toBe('pack.json')
  })

  it('rejects duplicate entry names and non-zip bytes', async () => {
    const duplicate = await zipFailure(
      readZipFixture(
        makeZip([
          { name: 'pack.json', data: utf8('{}') },
          { name: 'pack.json', data: utf8('{"a":1}') },
        ]),
      ),
    )
    expect(duplicate.code).toBe('duplicate-entry')

    const notZip = await zipFailure(readZipFixture(utf8('this is not a zip archive at all')))
    expect(notZip.code).toBe('not-a-zip')
  })
})

describe('zip reader without an injected inflater', () => {
  it('reads a store-only archive but refuses a deflated entry', async () => {
    // A store-only archive needs no decompressor at all.
    const stored = makeZip([{ name: 'pack.json', data: utf8('{"id":"x"}') }])
    await expect(readZip(stored)).resolves.toBeInstanceOf(Map)

    // A deflated entry fails loudly instead of guessing: `core` has no zlib.
    const deflated = makeZip([{ name: 'pack.json', data: utf8('{"id":"x"}'), method: 8 }])
    const error = await zipFailure(readZip(deflated))
    expect(error.code).toBe('inflate-unavailable')
  })
})
