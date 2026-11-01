/**
 * Minimal ZIP reader for content-pack import.
 *
 * Zero third-party dependencies: Node's built-in `zlib.inflateRaw` is the only
 * decompressor, exactly as `M2-实施计划.md` §3.1 decided ("Node 无内建 zip →
 * 自写最小 zip 读取；不新增依赖"). The reader is deliberately narrow:
 *
 * - only **store** (method 0) and **deflate** (method 8) are accepted; every
 *   other method (bzip2, LZMA, zstd, …) is refused with the method number;
 * - encrypted entries and ZIP64 archives are refused (a pack is capped at
 *   50 MB, so neither is legitimate here);
 * - absolute paths, `..` traversal segments and control characters are refused
 *   *before* the loader ever sees a path (`内容包规范.md` §9);
 * - the uncompressed total is checked against the pack cap before inflating,
 *   and each entry is inflated with `maxOutputLength` so a lying central
 *   directory cannot be used as a zip bomb;
 * - every entry's CRC-32 is verified, so a truncated/corrupt archive fails
 *   with the entry name rather than producing a half-broken pack;
 * - entry names without the UTF-8 flag are decoded as CP437, the encoding the
 *   ZIP spec mandates. This is the "Windows 压缩工具的坑" fix from
 *   `内容包规范.md` §9 / `项目分析报告.md` §4: a UTF-8 decode of CP437 bytes
 *   silently mangles the name.
 *
 * Errors are {@link ZipError} with a stable `code` so the import UI can show a
 * translated message and tests can assert the rule.
 */

import { MAX_PACK_BYTES } from './validate.ts'

/** Hard cap on the archive bytes the reader will even look at. */
export const MAX_ZIP_BYTES = 64 * 1024 * 1024
/** Hard cap on entry count; a pack has a handful of files, not thousands. */
export const MAX_ZIP_ENTRIES = 2048

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
/** EOCD is 22 bytes plus a comment of at most 65535 bytes. */
const EOCD_MIN_BYTES = 22
const MAX_COMMENT_BYTES = 0xffff
/** Zip64 markers in the 32-bit fields. */
const ZIP64_MARKER = 0xffffffff
const ZIP64_COUNT_MARKER = 0xffff
const FLAG_ENCRYPTED = 0x0001
const FLAG_UTF8 = 0x0800
const METHOD_STORE = 0
const METHOD_DEFLATE = 8

export type ZipErrorCode =
  | 'not-a-zip'
  | 'corrupt'
  | 'unsupported-method'
  | 'inflate-unavailable'
  | 'encrypted'
  | 'zip64-unsupported'
  | 'too-many-entries'
  | 'too-large'
  | 'unsafe-path'
  | 'duplicate-entry'
  | 'bad-entry'
  | 'crc-mismatch'

/**
 * Raw DEFLATE decompressor, injected by the host.
 *
 * `core` deliberately contains no platform API — M4b reuses it under React
 * Native — so Node's `zlib.inflateRaw` is never imported here. The desktop host
 * injects it; a store-only archive needs none.
 */
export type RawInflate = (data: Uint8Array, options: { maxOutputLength: number }) => Uint8Array

/** Options for {@link readZip}. */
export interface ReadZipOptions {
  /**
   * Decompressor for deflate entries.
   *
   * When omitted, a store-only archive still reads; encountering a deflated
   * entry fails with `inflate-unavailable` rather than guessing.
   */
  readonly inflateRaw?: RawInflate
}

export class ZipError extends Error {
  readonly code: ZipErrorCode
  /** Entry name when the failure is attributable to one entry. */
  readonly entry: string | undefined

  constructor(code: ZipErrorCode, message: string, entry?: string) {
    super(entry === undefined ? message : `${message} (entry "${entry}")`)
    this.name = 'ZipError'
    this.code = code
    this.entry = entry
  }
}

/**
 * CP437 code points for bytes 0x80-0xFF, the encoding ZIP mandates when the
 * UTF-8 flag is absent. 0x00-0x7F are ASCII and handled separately.
 */
const CP437_HIGH: readonly string[] = [
  'Ç', 'ü', 'é', 'â', 'ä', 'à', 'å', 'ç', 'ê', 'ë', 'è', 'ï', 'î', 'ì', 'Ä', 'Å',
  'É', 'æ', 'Æ', 'ô', 'ö', 'ò', 'û', 'ù', 'ÿ', 'Ö', 'Ü', '¢', '£', '¥', '₧', 'ƒ',
  'á', 'í', 'ó', 'ú', 'ñ', 'Ñ', 'ª', 'º', '¿', '⌐', '¬', '½', '¼', '¡', '«', '»',
  '░', '▒', '▓', '│', '┤', '╡', '╢', '╖', '╕', '╣', '║', '╗', '╝', '╜', '╛', '┐',
  '└', '┴', '┬', '├', '─', '┼', '╞', '╟', '╚', '╔', '╩', '╦', '╠', '═', '╬', '╧',
  '╨', '╤', '╥', '╙', '╘', '╒', '╓', '╫', '╪', '┘', '┌', '█', '▄', '▌', '▐', '▀',
  'α', 'ß', 'Γ', 'π', 'Σ', 'σ', 'µ', 'τ', 'Φ', 'Θ', 'Ω', 'δ', '∞', 'φ', 'ε', '∩',
  '≡', '±', '≥', '≤', '⌠', '⌡', '÷', '≈', '°', '∙', '·', '√', 'ⁿ', '²', '■', '\u00a0',
]

const CRC32_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? (0xedb88320 ^ (value >>> 1)) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc = ((crc >>> 8) ^ CRC32_TABLE[(crc ^ byte) & 0xff]!) >>> 0
  }
  return (crc ^ 0xffffffff) >>> 0
}

interface View {
  readonly view: DataView
  readonly bytes: Uint8Array
}

function needed(context: View, offset: number, length: number, what: string): void {
  if (offset < 0 || length < 0 || offset + length > context.view.byteLength) {
    throw new ZipError('corrupt', `${what} is truncated (needs ${length} bytes at offset ${offset})`)
  }
}

function u16(context: View, offset: number, what: string): number {
  needed(context, offset, 2, what)
  return context.view.getUint16(offset, true)
}

function u32(context: View, offset: number, what: string): number {
  needed(context, offset, 4, what)
  return context.view.getUint32(offset, true)
}

/** Decode an entry name: UTF-8 when flagged, CP437 otherwise (ZIP spec). */
function decodeName(raw: Uint8Array, flags: number, entryLabel: string): string {
  if ((flags & FLAG_UTF8) !== 0) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(raw)
    } catch {
      throw new ZipError('bad-entry', 'file name is flagged UTF-8 but is not valid UTF-8', entryLabel)
    }
  }
  let name = ''
  for (const byte of raw) {
    name += byte < 0x80 ? String.fromCharCode(byte) : CP437_HIGH[byte - 0x80]!
  }
  return name
}

/**
 * Normalize and safety-check one entry name.
 *
 * Backslashes are treated as separators before the traversal check because
 * some Windows tools emit them; after that an absolute path, a `..` segment or
 * a control character is refused outright.
 */
function safePath(raw: string): string {
  let normalized = raw.replace(/\\/gu, '/')
  while (normalized.startsWith('./')) normalized = normalized.slice(2)
  if (normalized.length === 0) throw new ZipError('unsafe-path', 'entry has an empty file name')
  if (normalized.startsWith('/') || /^[A-Za-z]:/u.test(normalized)) {
    throw new ZipError('unsafe-path', 'absolute paths are not allowed', raw)
  }
  const segments = normalized.split('/')
  for (const segment of segments) {
    if (segment.length === 0) throw new ZipError('unsafe-path', 'empty path segment (double separator)', raw)
    if (segment === '..') throw new ZipError('unsafe-path', '".." path traversal is not allowed', raw)
    if (segment === '.') throw new ZipError('unsafe-path', '"." path segments are not allowed', raw)
    if (/[\u0000-\u001f\u007f]/u.test(segment)) {
      throw new ZipError('unsafe-path', 'control characters are not allowed in file names', raw)
    }
  }
  return segments.join('/')
}

interface CentralEntry {
  readonly name: string
  readonly flags: number
  readonly method: number
  readonly crc: number
  readonly compressedSize: number
  readonly uncompressedSize: number
  readonly localOffset: number
}

function findEndOfCentralDirectory(context: View): number {
  const length = context.view.byteLength
  if (length < EOCD_MIN_BYTES) throw new ZipError('not-a-zip', 'file is too small to be a ZIP archive')
  const lowest = Math.max(0, length - EOCD_MIN_BYTES - MAX_COMMENT_BYTES)
  for (let offset = length - EOCD_MIN_BYTES; offset >= lowest; offset -= 1) {
    if (u32(context, offset, 'end of central directory') === EOCD_SIGNATURE) {
      const commentLength = u16(context, offset + 20, 'end of central directory comment length')
      if (offset + EOCD_MIN_BYTES + commentLength <= length) return offset
    }
  }
  throw new ZipError('not-a-zip', 'no ZIP end-of-central-directory record found')
}

function readCentralDirectory(context: View, eocdOffset: number): readonly CentralEntry[] {
  const count = u16(context, eocdOffset + 10, 'entry count')
  const directorySize = u32(context, eocdOffset + 12, 'central directory size')
  const directoryOffset = u32(context, eocdOffset + 16, 'central directory offset')

  if (count === ZIP64_COUNT_MARKER || directorySize === ZIP64_MARKER || directoryOffset === ZIP64_MARKER) {
    throw new ZipError('zip64-unsupported', 'ZIP64 archives are not supported; repackage the pack without ZIP64')
  }
  if (count > MAX_ZIP_ENTRIES) {
    throw new ZipError('too-many-entries', `archive has ${count} entries; the limit is ${MAX_ZIP_ENTRIES}`)
  }
  if (directoryOffset + directorySize > eocdOffset) {
    throw new ZipError('corrupt', 'central directory overlaps the end-of-central-directory record')
  }

  const entries: CentralEntry[] = []
  let cursor = directoryOffset
  for (let index = 0; index < count; index += 1) {
    needed(context, cursor, 46, 'central directory entry')
    if (u32(context, cursor, 'central directory signature') !== CENTRAL_SIGNATURE) {
      throw new ZipError('corrupt', `central directory entry ${index} has a bad signature`)
    }
    const flags = u16(context, cursor + 8, 'central directory flags')
    const method = u16(context, cursor + 10, 'central directory compression method')
    const crc = u32(context, cursor + 16, 'central directory CRC')
    const compressedSize = u32(context, cursor + 20, 'central directory compressed size')
    const uncompressedSize = u32(context, cursor + 24, 'central directory uncompressed size')
    const nameLength = u16(context, cursor + 28, 'central directory name length')
    const extraLength = u16(context, cursor + 30, 'central directory extra length')
    const commentLength = u16(context, cursor + 32, 'central directory comment length')
    const localOffset = u32(context, cursor + 42, 'central directory local header offset')
    needed(context, cursor + 46, nameLength + extraLength + commentLength, 'central directory entry data')
    const rawName = context.bytes.subarray(cursor + 46, cursor + 46 + nameLength)
    const label = decodeName(rawName, flags, `entry ${index}`)
    entries.push({ name: label, flags, method, crc, compressedSize, uncompressedSize, localOffset })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  if (cursor > directoryOffset + directorySize) {
    throw new ZipError('corrupt', 'central directory entries overrun the declared directory size')
  }
  return entries
}

function inflateEntry(
  context: View,
  entry: CentralEntry,
  data: Uint8Array,
  remainingBudget: number,
  inflateRaw: RawInflate | undefined,
): Uint8Array {
  if (inflateRaw === undefined) {
    throw new ZipError(
      'inflate-unavailable',
      'this archive contains deflate entries but the host injected no raw inflater',
      entry.name,
    )
  }
  const limit = Math.max(1, Math.min(entry.uncompressedSize > 0 ? entry.uncompressedSize : remainingBudget, remainingBudget))
  let inflated: Uint8Array
  try {
    inflated = new Uint8Array(inflateRaw(data, { maxOutputLength: limit }))
  } catch (failure) {
    const code = (failure as { code?: string }).code
    if (code === 'ERR_BUFFER_TOO_LARGE') {
      throw new ZipError('too-large', `entry inflates beyond the pack size limit (${MAX_PACK_BYTES} bytes)`, entry.name)
    }
    throw new ZipError('corrupt', `deflate stream could not be read: ${(failure as Error).message}`, entry.name)
  }
  if (inflated.byteLength !== entry.uncompressedSize) {
    throw new ZipError(
      'corrupt',
      `deflate stream produced ${inflated.byteLength} bytes but the directory claims ${entry.uncompressedSize}`,
      entry.name,
    )
  }
  return inflated
}

/**
 * Read a ZIP archive into a file map.
 *
 * @param bytes - The raw archive.
 * @param options - Host-injected decompressor; see {@link ReadZipOptions}.
 * @returns File paths (POSIX, sorted) mapped to their decompressed bytes.
 * @throws {ZipError} for a corrupt archive, unsupported compression, unsafe
 *   paths, or a pack that exceeds the size/entry limits.
 */
export async function readZip(bytes: Uint8Array, options: ReadZipOptions = {}): Promise<Map<string, Uint8Array>> {
  if (!(bytes instanceof Uint8Array)) throw new ZipError('not-a-zip', 'expected the archive as a Uint8Array')
  if (bytes.byteLength > MAX_ZIP_BYTES) {
    throw new ZipError('too-large', `archive is ${bytes.byteLength} bytes; the limit is ${MAX_ZIP_BYTES} bytes`)
  }
  const context: View = {
    bytes,
    view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
  }
  const eocdOffset = findEndOfCentralDirectory(context)
  const central = readCentralDirectory(context, eocdOffset)

  const files = new Map<string, Uint8Array>()
  let totalUncompressed = 0
  for (const entry of central) {
    const isDirectory = entry.name.endsWith('/')
    const path = isDirectory ? entry.name : safePath(entry.name)
    if (isDirectory) continue
    if ((entry.flags & FLAG_ENCRYPTED) !== 0) {
      throw new ZipError('encrypted', 'encrypted entries are not supported', path)
    }
    if (entry.method !== METHOD_STORE && entry.method !== METHOD_DEFLATE) {
      throw new ZipError('unsupported-method', `compression method ${entry.method} is not supported; use store or deflate`, path)
    }
    if (entry.compressedSize === ZIP64_MARKER || entry.uncompressedSize === ZIP64_MARKER) {
      throw new ZipError('zip64-unsupported', 'ZIP64 entries are not supported', path)
    }
    totalUncompressed += entry.uncompressedSize
    if (totalUncompressed > MAX_PACK_BYTES) {
      throw new ZipError(
        'too-large',
        `archive expands to more than the ${MAX_PACK_BYTES}-byte pack limit (50MB)`,
        path,
      )
    }
    if (files.has(path)) throw new ZipError('duplicate-entry', 'the archive contains the same path twice', path)

    needed(context, entry.localOffset, 30, 'local file header')
    if (u32(context, entry.localOffset, 'local file header signature') !== LOCAL_SIGNATURE) {
      throw new ZipError('corrupt', 'local file header has a bad signature', path)
    }
    const localNameLength = u16(context, entry.localOffset + 26, 'local file header name length')
    const localExtraLength = u16(context, entry.localOffset + 28, 'local file header extra length')
    const dataStart = entry.localOffset + 30 + localNameLength + localExtraLength
    needed(context, dataStart, entry.compressedSize, 'entry data')
    const raw = bytes.subarray(dataStart, dataStart + entry.compressedSize)

    let data: Uint8Array
    if (entry.method === METHOD_STORE) {
      if (entry.compressedSize !== entry.uncompressedSize) {
        throw new ZipError('corrupt', 'stored entry has different compressed and uncompressed sizes', path)
      }
      data = new Uint8Array(raw)
    } else {
      data = inflateEntry(
        context,
        entry,
        raw,
        MAX_PACK_BYTES - (totalUncompressed - entry.uncompressedSize),
        options.inflateRaw,
      )
    }
    if (crc32(data) !== entry.crc) {
      throw new ZipError('crc-mismatch', 'CRC-32 does not match; the archive is corrupt', path)
    }
    files.set(path, data)
  }

  // Deterministic order: importers and tests get the same listing every time.
  return new Map([...files.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)))
}
