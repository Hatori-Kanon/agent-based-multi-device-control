/**
 * Node implementations of the core storage ports.
 *
 * Kept free of any Electron import so the host logic stays unit-testable.
 */

import { createHash, randomBytes } from 'node:crypto'
import { appendFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AppendOnlyStore, DocumentStore } from '@embodied/core'

/**
 * Append-only JSONL file.
 *
 * Appends are serialised through a promise chain: concurrent writes to the
 * same descriptor can otherwise interleave and produce a torn line, which
 * would corrupt the one record we most need to trust.
 */
export class FileAppendOnlyStore implements AppendOnlyStore {
  private tail: Promise<void> = Promise.resolve()
  private ensured = false

  /** @param path - Destination file; parent directories are created. */
  constructor(private readonly path: string) {}

  append(line: string): Promise<void> {
    const run = this.tail.then(async () => {
      if (!this.ensured) {
        await mkdir(dirname(this.path), { recursive: true })
        this.ensured = true
      }
      await appendFile(this.path, `${line}\n`, { encoding: 'utf8', mode: 0o600 })
    })
    // Keep the chain alive even after a failure so one bad append does not
    // permanently wedge the audit trail.
    this.tail = run.catch(() => {})
    return run
  }
}

/**
 * Read the most recent audit records.
 *
 * Reading is fine; it is the *writer* that must be append-only. A line that
 * cannot be parsed is surfaced rather than dropped, because a corrupted record
 * is itself information.
 */
export async function readAuditTail(path: string, limit = 200): Promise<unknown[]> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return []
  }
  const lines = raw.split('\n').filter(line => line.trim().length > 0)
  return lines.slice(-Math.max(1, limit)).map(line => {
    try {
      return JSON.parse(line) as unknown
    } catch {
      return { unparseable: line }
    }
  })
}

/**
 * Keyed documents written atomically.
 *
 * Every write goes to a unique temporary file and is renamed into place, so a
 * reader can never observe a half-written document. The sensor frame store in
 * M1 reuses this rule; the reference project's torn-JPEG bug came from
 * skipping it.
 */
export class FileDocumentStore implements DocumentStore {
  private ensured = false

  /** @param directory - Root for all documents. */
  constructor(private readonly directory: string) {}

  async read(key: string): Promise<string | undefined> {
    try {
      return await readFile(this.pathFor(key), 'utf8')
    } catch {
      return undefined
    }
  }

  async write(key: string, value: string): Promise<void> {
    if (!this.ensured) {
      await mkdir(this.directory, { recursive: true })
      this.ensured = true
    }
    const target = this.pathFor(key)
    const temporary = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
    await writeFile(temporary, value, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    try {
      await rename(temporary, target)
    } catch (error) {
      await unlink(temporary).catch(() => {})
      throw error
    }
  }

  /** Hash the key so an arbitrary label cannot escape the directory. */
  private pathFor(key: string): string {
    const safe = /^[a-zA-Z0-9._-]{1,64}$/.test(key)
      ? key
      : createHash('sha256').update(key).digest('hex').slice(0, 32)
    return join(this.directory, `${safe}.json`)
  }
}
