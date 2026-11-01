/**
 * Content-pack filesystem boundary.
 *
 * Content packs live on disk in production and inside a zip (or a test
 * fixture) while importing, so the loader never talks to `node:fs` directly:
 * it reads through this port. That keeps `core` platform-free (the same rule
 * `ports/storage.ts`, `ports/clock.ts` and `ports/ble.ts` follow) and makes
 * every loader test an in-memory `MemoryContentSource`.
 *
 * Paths are POSIX separated and relative to the pack root. The loader rejects
 * absolute paths, `..` segments and control characters before it reads
 * anything; traversal and symlink checks that need filesystem metadata belong
 * to the host-side importer, because this port intentionally cannot see them.
 */

export interface ContentSource {
  /** Every file path under the pack root, POSIX separators, stable order. */
  list(): Promise<readonly string[]>
  /** Read a UTF-8 text file. */
  readText(path: string): Promise<string>
  /** Read a binary asset (waveform payloads, images). */
  readBytes(path: string): Promise<Uint8Array>
  /** Size in bytes without reading the whole file. */
  byteSize(path: string): Promise<number>
}

function missing(path: string): Error {
  return new Error(`content source has no file "${path}"`)
}

/**
 * In-memory {@link ContentSource} for tests and for `loadPack` fixtures.
 *
 * String entries are UTF-8 text; `Uint8Array` entries are binary. `list()`
 * returns sorted paths so loading the same fixture twice produces the same
 * warnings in the same order.
 */
export class MemoryContentSource implements ContentSource {
  private readonly files: ReadonlyMap<string, string | Uint8Array>

  constructor(files: Readonly<Record<string, string | Uint8Array>>) {
    this.files = new Map(Object.entries(files))
  }

  list(): Promise<readonly string[]> {
    return Promise.resolve([...this.files.keys()].sort())
  }

  readText(path: string): Promise<string> {
    const value = this.files.get(path)
    if (value === undefined) return Promise.reject(missing(path))
    if (typeof value === 'string') return Promise.resolve(value)
    return Promise.resolve(new TextDecoder().decode(value))
  }

  readBytes(path: string): Promise<Uint8Array> {
    const value = this.files.get(path)
    if (value === undefined) return Promise.reject(missing(path))
    if (value instanceof Uint8Array) return Promise.resolve(value)
    return Promise.resolve(new TextEncoder().encode(value))
  }

  byteSize(path: string): Promise<number> {
    const value = this.files.get(path)
    if (value === undefined) return Promise.reject(missing(path))
    // UTF-8 byte length, not `String.length`: `.length` counts UTF-16 code
    // units, and a pack full of CJK text would be measured at half its size.
    return Promise.resolve(typeof value === 'string' ? new TextEncoder().encode(value).length : value.byteLength)
  }
}
