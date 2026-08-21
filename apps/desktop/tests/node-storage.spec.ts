import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FileAppendOnlyStore, FileDocumentStore, readAuditTail } from '../src/main/node-storage.ts'

let root: string

beforeEach(async () => {
  // Kept inside the workspace so the file sandbox permits it.
  await mkdir(join(process.cwd(), '.test-tmp'), { recursive: true })
  root = await mkdtemp(join(process.cwd(), '.test-tmp', 'store-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('FileAppendOnlyStore', () => {
  it('creates missing directories and appends one line per record', async () => {
    const path = join(root, 'nested', 'deeper', 'audit.jsonl')
    const store = new FileAppendOnlyStore(path)
    await store.append('{"a":1}')
    await store.append('{"a":2}')
    const content = await readFile(path, 'utf8')
    expect(content).toBe('{"a":1}\n{"a":2}\n')
  })

  it('keeps concurrent appends from interleaving', async () => {
    const path = join(root, 'audit.jsonl')
    const store = new FileAppendOnlyStore(path)
    const records = Array.from({ length: 60 }, (_, index) => JSON.stringify({ index, pad: 'x'.repeat(200) }))
    await Promise.all(records.map(record => store.append(record)))

    const lines = (await readFile(path, 'utf8')).trimEnd().split('\n')
    expect(lines).toHaveLength(records.length)
    // Every line must still be a whole, parseable record.
    const seen = new Set<number>()
    for (const line of lines) {
      const parsed = JSON.parse(line) as { index: number }
      seen.add(parsed.index)
    }
    expect(seen.size).toBe(records.length)
  })

  it('keeps working after one append fails', async () => {
    // A directory where the file should be makes the first append fail.
    const store = new FileAppendOnlyStore(join(root, 'audit.jsonl'))
    await store.append('{"first":true}')
    const broken = new FileAppendOnlyStore(join(root, 'audit.jsonl', 'impossible.jsonl'))
    await expect(broken.append('{"nope":true}')).rejects.toThrow()
    await expect(store.append('{"second":true}')).resolves.toBeUndefined()
  })
})

describe('readAuditTail', () => {
  it('returns an empty list for a missing file rather than throwing', async () => {
    await expect(readAuditTail(join(root, 'absent.jsonl'))).resolves.toEqual([])
  })

  it('returns the most recent records in order', async () => {
    const path = join(root, 'audit.jsonl')
    const store = new FileAppendOnlyStore(path)
    for (let index = 0; index < 10; index += 1) await store.append(JSON.stringify({ index }))

    const tail = await readAuditTail(path, 3)
    expect(tail).toEqual([{ index: 7 }, { index: 8 }, { index: 9 }])
  })

  it('surfaces an unparseable line instead of dropping it', async () => {
    const path = join(root, 'audit.jsonl')
    const store = new FileAppendOnlyStore(path)
    await store.append('{"ok":true}')
    await store.append('{ truncated')

    // A corrupted record is itself information; hiding it would be worse.
    const tail = await readAuditTail(path)
    expect(tail).toEqual([{ ok: true }, { unparseable: '{ truncated' }])
  })
})

describe('FileDocumentStore', () => {
  it('round-trips a document', async () => {
    const store = new FileDocumentStore(join(root, 'state'))
    await store.write('session', '{"turn":1}')
    await expect(store.read('session')).resolves.toBe('{"turn":1}')
  })

  it('returns undefined for a missing document', async () => {
    const store = new FileDocumentStore(join(root, 'state'))
    await expect(store.read('absent')).resolves.toBeUndefined()
  })

  it('overwrites atomically and leaves no temporary files behind', async () => {
    const directory = join(root, 'state')
    const store = new FileDocumentStore(directory)
    await store.write('session', 'first')
    await store.write('session', 'second')
    await expect(store.read('session')).resolves.toBe('second')

    const { readdir } = await import('node:fs/promises')
    const entries = await readdir(directory)
    expect(entries.filter(entry => entry.endsWith('.tmp'))).toEqual([])
    expect(entries).toEqual(['session.json'])
  })

  it('does not let a hostile key escape the directory', async () => {
    const directory = join(root, 'state')
    const store = new FileDocumentStore(directory)
    await store.write('../../escaped', 'nope')
    const { readdir } = await import('node:fs/promises')
    const entries = await readdir(directory)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatch(/^[a-f0-9]{32}\.json$/)
    // And it is still readable through the same key.
    await expect(store.read('../../escaped')).resolves.toBe('nope')
  })
})
