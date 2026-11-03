import { describe, expect, it } from 'vitest'
import { FakeClock } from '../src/ports/fake-clock.ts'
import { ContentPackError } from '../src/scenario/loader.ts'
import {
  MemoryPackStore,
  PackRegistry,
  PackRegistryError,
  type PackStore,
} from '../src/scenario/pack-registry.ts'

// ---------------------------------------------------------------------------
// A tiny store-only ZIP writer for fixtures; the reader itself is covered by
// scenario-zip.spec.ts.
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

function zipOf(files: Readonly<Record<string, string | Uint8Array>>): Uint8Array {
  const localParts: Uint8Array[] = []
  const centralParts: Uint8Array[] = []
  const entries = Object.entries(files)
  let localOffset = 0
  for (const [name, value] of entries) {
    const nameBytes = utf8(name)
    const flags = /[^\u0000-\u007f]/u.test(name) ? 0x0800 : 0
    const data = typeof value === 'string' ? utf8(value) : value
    const crc = crc32(data)

    const local = new Uint8Array(30 + nameBytes.byteLength + data.byteLength)
    const localView = new DataView(local.buffer)
    localView.setUint32(0, 0x04034b50, true)
    localView.setUint16(4, 20, true)
    localView.setUint16(6, flags, true)
    localView.setUint16(8, 0, true)
    localView.setUint16(14, crc, true)
    localView.setUint32(18, data.byteLength, true)
    localView.setUint32(22, data.byteLength, true)
    localView.setUint16(26, nameBytes.byteLength, true)
    local.set(nameBytes, 30)
    local.set(data, 30 + nameBytes.byteLength)
    localParts.push(local)

    const central = new Uint8Array(46 + nameBytes.byteLength)
    const centralView = new DataView(central.buffer)
    centralView.setUint32(0, 0x02014b50, true)
    centralView.setUint16(4, 20, true)
    centralView.setUint16(6, 20, true)
    centralView.setUint16(8, flags, true)
    centralView.setUint32(16, crc, true)
    centralView.setUint32(20, data.byteLength, true)
    centralView.setUint32(24, data.byteLength, true)
    centralView.setUint16(28, nameBytes.byteLength, true)
    centralView.setUint32(42, localOffset, true)
    central.set(nameBytes, 46)
    centralParts.push(central)

    localOffset += local.byteLength
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.byteLength, 0)
  const eocd = new Uint8Array(22)
  const eocdView = new DataView(eocd.buffer)
  eocdView.setUint32(0, 0x06054b50, true)
  eocdView.setUint16(8, entries.length, true)
  eocdView.setUint16(10, entries.length, true)
  eocdView.setUint32(12, centralSize, true)
  eocdView.setUint32(16, localOffset, true)
  return concat([...localParts, ...centralParts, eocd])
}

const PERSONA = '# 角色\n\n温柔而克制的引导者。\n\n## 导演摘要\n\n行动倾向：先观察再靠近；称呼：你。\n'

/**
 * Build a freeform pack archive.
 *
 * `extra` adds (or overrides, for `persona.md`) files relative to the pack root;
 * the re-import tests use it to change bytes and to drop a file that only the
 * older archive had.
 */
function freeformZipWith(
  id: string,
  version: string,
  name: string,
  extra: Readonly<Record<string, string>> = {},
  directory?: string,
): Uint8Array {
  const prefix = directory === undefined ? '' : `${directory}/`
  const files: Record<string, string> = {
    [`${prefix}pack.json`]: JSON.stringify({
      id,
      name,
      version,
      engine: '>=0.2 <1.0',
      mode: 'freeform',
      rating: 'all',
      boundaries: ['不得出现疼痛描写'],
      aftercare: { text: '慢慢缓过来。' },
    }),
    [`${prefix}persona.md`]: PERSONA,
  }
  for (const [path, value] of Object.entries(extra)) files[`${prefix}${path}`] = value
  return zipOf(files)
}

function freeformZip(id: string, version: string, name: string, directory?: string): Uint8Array {
  return freeformZipWith(id, version, name, {}, directory)
}

function scenarioZip(): Uint8Array {
  return zipOf({
    'MyPack/pack.json': JSON.stringify({
      id: 'tentacle-pure',
      name: '触手 · 纯爱',
      version: '0.2.0',
      engine: '>=0.2 <1.0',
      mode: 'scenario',
      rating: '18+',
      boundaries: ['不得出现不可逆伤害'],
    }),
    'MyPack/persona.md': PERSONA,
    'MyPack/host.md': '# 主持\n\n节奏：慢。',
    'MyPack/scenario.json': JSON.stringify({
      host: 'host.md',
      session: {
        plannedMinutes: 45,
        phaseWindows: [
          { phase: 'probe', from: 0, to: 0.2 },
          { phase: 'resolve', from: 0.8, to: 1 },
        ],
        aftercareMin: 5,
      },
      regions: [
        { id: 'chest', label: '胸口' },
        { id: 'whole-body', label: '全身' },
      ],
      phases: [
        { id: 'probe', goal: '试探与观察', next: ['resolve'] },
        { id: 'resolve', goal: '收束与事后照顾', next: [] },
      ],
      feedbackIntents: [
        { id: 'probe-touch', meaning: '短促试探', regions: ['chest'] },
        { id: 'soothe', meaning: '安抚', regions: ['whole-body'] },
      ],
    }),
    'MyPack/phases/probe.md': '只观察。',
    'MyPack/phases/resolve.md': '先归零。',
    'MyPack/waveforms/gentle.json': JSON.stringify({
      id: 'gentle',
      name: '轻柔',
      frames: ['0A0A0A0A00000000', '0A0A0A0A0A0A0A0A'],
    }),
    '__MACOSX/._pack.json': 'mac junk',
    'MyPack/.DS_Store': 'finder junk',
  })
}

async function registryError(promise: Promise<unknown>): Promise<PackRegistryError> {
  try {
    await promise
    throw new Error('operation should have rejected')
  } catch (error) {
    expect(error).toBeInstanceOf(PackRegistryError)
    return error as PackRegistryError
  }
}

/**
 * Store that fails selected calls so rollback/failure behaviour is testable.
 *
 * Both switches are mutable: an install can be prepared on a healthy store and
 * the failure only armed for the follow-up (re-import) call.
 */
class FailingStore implements PackStore {
  private readonly inner = new MemoryPackStore()
  failOn: string | undefined
  failRemoveOn: string | undefined

  constructor(failOn?: string, failRemoveOn?: string) {
    this.failOn = failOn
    this.failRemoveOn = failRemoveOn
  }

  read(key: string): Promise<Uint8Array | undefined> {
    return this.inner.read(key)
  }

  write(key: string, bytes: Uint8Array): Promise<void> {
    if (this.failOn !== undefined && key.includes(this.failOn)) {
      return Promise.reject(new Error('simulated disk full'))
    }
    return this.inner.write(key, bytes)
  }

  remove(key: string): Promise<void> {
    if (this.failRemoveOn !== undefined && key.includes(this.failRemoveOn)) {
      return Promise.reject(new Error('simulated delete failure'))
    }
    return this.inner.remove(key)
  }

  list(prefix: string): Promise<readonly string[]> {
    return this.inner.list(prefix)
  }

  keys(): readonly string[] {
    return this.inner.keys()
  }
}

/**
 * PackStore that behaves like a case-insensitive filesystem (Windows NTFS):
 * keys differing only in casing address the same physical file, while `list`
 * reports the casing of the most recent write. A re-import therefore lists the
 * *old* casing (the snapshot is taken before writing) and writes the new one.
 */
class CaseInsensitiveStore implements PackStore {
  private readonly files = new Map<string, { readonly key: string; readonly bytes: Uint8Array }>()

  private static fold(key: string): string {
    return key.toLowerCase()
  }

  read(key: string): Promise<Uint8Array | undefined> {
    const entry = this.files.get(CaseInsensitiveStore.fold(key))
    return Promise.resolve(entry === undefined ? undefined : new Uint8Array(entry.bytes))
  }

  write(key: string, bytes: Uint8Array): Promise<void> {
    this.files.set(CaseInsensitiveStore.fold(key), { key, bytes: new Uint8Array(bytes) })
    return Promise.resolve()
  }

  remove(key: string): Promise<void> {
    // NTFS `unlink` resolves the path case-insensitively: removing the old
    // casing would delete the file the re-import just wrote under a new casing.
    this.files.delete(CaseInsensitiveStore.fold(key))
    return Promise.resolve()
  }

  list(prefix: string): Promise<readonly string[]> {
    return Promise.resolve(
      [...this.files.values()]
        .map(entry => entry.key)
        .filter(key => key.startsWith(prefix))
        .sort(),
    )
  }

  /** Every physically stored path, in list order (test convenience). */
  keys(): readonly string[] {
    return [...this.files.values()].map(entry => entry.key).sort()
  }
}

describe('content-pack registry', () => {
  it('keeps two versions installed while only one is active', async () => {
    const store = new MemoryPackStore()
    const clock = new FakeClock(Date.UTC(2026, 10, 1, 12, 0, 0))
    const registry = new PackRegistry({ store, clock })

    const first = await registry.install(freeformZip('tentacle', '0.1.0', '触手 · 旧版'), { activate: true })
    expect(first.active).toBe(true)
    const second = await registry.install(freeformZip('tentacle', '0.2.0', '触手 · 新版'))
    expect(second.active).toBe(false)

    let entries = await registry.list()
    expect(entries).toHaveLength(1)
    expect(entries[0]!.id).toBe('tentacle')
    expect(entries[0]!.activeVersion).toBe('0.1.0')
    expect(entries[0]!.versions.map(version => version.version)).toEqual(['0.1.0', '0.2.0'])
    expect(entries[0]!.versions.filter(version => version.active)).toHaveLength(1)
    expect(entries[0]!.versions[0]!.installedAt).toBe('2026-11-01T12:00:00.000Z')
    expect((await registry.load('tentacle')).manifest.version).toBe('0.1.0')
    // Both versions stay installed; the inactive one is still loadable by pinning.
    expect((await registry.load('tentacle', '0.2.0')).manifest.version).toBe('0.2.0')

    await registry.activate('tentacle', '0.2.0')
    entries = await registry.list()
    expect(entries[0]!.activeVersion).toBe('0.2.0')
    expect((await registry.load('tentacle')).manifest.version).toBe('0.2.0')

    // Rollback is just another activation of the older version.
    await registry.activate('tentacle', '0.1.0')
    expect((await registry.load('tentacle')).manifest.version).toBe('0.1.0')
    expect((await registry.list())[0]!.versions).toHaveLength(2)
  })

  it('imports a pack whose waveform has long sensation prose and easeInOut curves', async () => {
    const store = new MemoryPackStore()
    const registry = new PackRegistry({ store })
    const sensation = '密集软刺履带单向无限循环滚动刮抚，如粗糙猫舌连绵不绝的密集体表电麻'
    const bytes = freeformZipWith('tentacle', '0.1.0', '触手', {
      'waveforms/mech.json': JSON.stringify({
        id: 'mech',
        name: '机械爬行',
        sensation,
        tags: ['mechanical'],
        loop: true,
        segments: [
          { ms: 400, freq: 60, intensity: { from: 0, to: 50 }, curve: 'easeInOut' },
          { ms: 400, freq: 60, intensity: { from: 50, to: 0 }, curve: 'easeInOut' },
        ],
      }),
    })
    const result = await registry.install(bytes, { activate: true })
    expect(result.id).toBe('tentacle')
    const loaded = await registry.load('tentacle')
    expect(loaded.waveforms).toHaveLength(1)
    // The prose is preserved, beyond the 24-char author-tag cap.
    expect(loaded.waveforms[0]!.tags).toContain(sensation)
    expect(loaded.waveforms[0]!.tags).toContain('mechanical')
  })

  it('never touches session state when a pack is uninstalled', async () => {
    const store = new MemoryPackStore()
    const registry = new PackRegistry({ store })
    await registry.install(freeformZip('tentacle', '0.1.0', '触手'), { activate: true })

    const saves: Readonly<Record<string, string>> = {
      'state/session.json': '{"turn":3,"currentPhase":"probe"}',
      'state/policy.json': '{"maxPercent":20}',
      'state/waveforms.json': '[]',
      'state/devices.json': '{"device-1":{"protocol":"coyote"}}',
      'memory/ledger.jsonl': '{"sessionId":"s-1","endReason":"completed"}\n',
      'memory/open.json': '{"sessionId":"s-1"}',
    }
    for (const [key, value] of Object.entries(saves)) await store.write(key, utf8(value))

    await registry.uninstall('tentacle')

    // User data is byte-for-byte untouched.
    for (const [key, value] of Object.entries(saves)) {
      expect(new TextDecoder().decode((await store.read(key)) ?? new Uint8Array()), key).toBe(value)
    }
    expect(await store.list('state/')).toEqual(Object.keys(saves).filter(key => key.startsWith('state/')).sort())
    // Pack files and the registry entry are gone.
    expect(await store.list('content/packs/')).toEqual([])
    expect(await registry.list()).toEqual([])
    const registryRaw = await store.read('content/registry.json')
    expect(JSON.parse(new TextDecoder().decode(registryRaw!))).toEqual({ version: 1, packs: {} })
    await expect(registry.load('tentacle')).rejects.toMatchObject({ code: 'not-found' })
  })

  it('removes one version without touching the other and clears the active slot', async () => {
    const store = new MemoryPackStore()
    const registry = new PackRegistry({ store })
    await registry.install(freeformZip('tentacle', '0.1.0', '旧版'))
    await registry.install(freeformZip('tentacle', '0.2.0', '新版'), { activate: true })

    await registry.uninstall('tentacle', '0.2.0')
    let entries = await registry.list()
    expect(entries[0]!.versions.map(version => version.version)).toEqual(['0.1.0'])
    // The removed version was active; nothing becomes active implicitly.
    expect(entries[0]!.activeVersion).toBeUndefined()
    await expect(registry.load('tentacle')).rejects.toMatchObject({ code: 'no-active-version' })

    await registry.activate('tentacle', '0.1.0')
    entries = await registry.list()
    expect(entries[0]!.activeVersion).toBe('0.1.0')
    expect((await registry.load('tentacle')).manifest.version).toBe('0.1.0')

    const missing = await registryError(registry.activate('tentacle', '9.9.9'))
    expect(missing.code).toBe('not-installed')
    const unknownPack = await registryError(registry.uninstall('nope'))
    expect(unknownPack.code).toBe('not-found')
  })

  it('refuses an invalid pack without leaving anything half-installed', async () => {
    const store = new MemoryPackStore()
    const registry = new PackRegistry({ store })
    const missingPersona = zipOf({
      'pack.json': JSON.stringify({
        id: 'broken',
        name: '坏包',
        version: '0.1.0',
        engine: '>=0.2 <1.0',
        mode: 'freeform',
        rating: 'all',
      }),
    })

    await expect(registry.install(missingPersona)).rejects.toBeInstanceOf(ContentPackError)
    expect(store.keys()).toEqual([])
    expect(await store.read('content/registry.json')).toBeUndefined()
    expect(await registry.list()).toEqual([])
  })

  it('replaces an installed id@version instead of refusing the import', async () => {
    const store = new MemoryPackStore()
    const clock = new FakeClock(Date.UTC(2026, 10, 1, 12, 0, 0))
    const registry = new PackRegistry({ store, clock })

    const first = await registry.install(
      freeformZipWith('tentacle', '0.1.0', '触手 · 初版', { 'notes/extra.md': '旧附注' }),
      { activate: true },
    )
    expect(first.replaced).toBe(false)
    expect(first.active).toBe(true)
    expect(store.keys()).toEqual([
      'content/packs/tentacle/0.1.0/notes/extra.md',
      'content/packs/tentacle/0.1.0/pack.json',
      'content/packs/tentacle/0.1.0/persona.md',
      'content/registry.json',
    ])

    // Same id@version, changed bytes and one dropped file: the import must
    // succeed, overwrite same-named files, and delete the file the new archive
    // no longer contains.
    clock.advance(60 * 60 * 1000)
    const second = await registry.install(
      freeformZipWith('tentacle', '0.1.0', '触手 · 修订版', { 'persona.md': '# 角色\n\n修订后的角色。\n' }),
      { activate: true },
    )
    expect(second.replaced).toBe(true)
    expect(second.active).toBe(true)
    expect(second.pack.manifest.name).toBe('触手 · 修订版')

    expect(store.keys()).toEqual([
      'content/packs/tentacle/0.1.0/pack.json',
      'content/packs/tentacle/0.1.0/persona.md',
      'content/registry.json',
    ])
    const persona = new TextDecoder().decode(
      (await store.read('content/packs/tentacle/0.1.0/persona.md')) ?? new Uint8Array(),
    )
    expect(persona).toContain('修订后的角色')
    const manifest = JSON.parse(
      new TextDecoder().decode((await store.read('content/packs/tentacle/0.1.0/pack.json')) ?? new Uint8Array()),
    ) as { name: string }
    expect(manifest.name).toBe('触手 · 修订版')

    // Still exactly one version, with a fresh installedAt; reloading the pack
    // reads the new bytes (no stale copy is left behind).
    const entries = await registry.list()
    expect(entries).toHaveLength(1)
    expect(entries[0]!.versions).toHaveLength(1)
    expect(entries[0]!.versions[0]!.installedAt).toBe('2026-11-01T13:00:00.000Z')
    expect(entries[0]!.versions[0]!.name).toBe('触手 · 修订版')
    expect(entries[0]!.activeVersion).toBe('0.1.0')
    const loaded = await registry.load('tentacle')
    expect(loaded.manifest.name).toBe('触手 · 修订版')
    expect(loaded.persona).toContain('修订后的角色')
  })

  it('keeps the active version and other versions untouched when a stale version is re-imported', async () => {
    const store = new MemoryPackStore()
    const registry = new PackRegistry({ store })
    await registry.install(
      freeformZipWith('tentacle', '0.1.0', '旧版', { 'notes/extra.md': '只有旧版有的附注' }),
      { activate: true },
    )
    await registry.install(freeformZip('tentacle', '0.2.0', '新版'), { activate: true })
    const v2Keys = store.keys().filter(key => key.includes('/0.2.0/'))
    expect(v2Keys).toHaveLength(2)

    // Re-import the *inactive* older version without `activate`: the files under
    // that prefix update, but the active slot keeps pointing at 0.2.0.
    const reinstalled = await registry.install(freeformZip('tentacle', '0.1.0', '旧版 · 重导'))
    expect(reinstalled.replaced).toBe(true)
    expect(reinstalled.active).toBe(false)

    const entries = await registry.list()
    expect(entries[0]!.activeVersion).toBe('0.2.0')
    expect(entries[0]!.versions.map(version => version.version)).toEqual(['0.1.0', '0.2.0'])
    expect(entries[0]!.versions.map(version => version.active)).toEqual([false, true])
    expect(entries[0]!.versions[0]!.name).toBe('旧版 · 重导')
    expect(await store.read('content/packs/tentacle/0.1.0/notes/extra.md')).toBeUndefined()
    // Stale cleanup is scoped to the re-imported prefix: 0.2.0 is untouched.
    expect(store.keys().filter(key => key.includes('/0.2.0/'))).toEqual(v2Keys)
    expect((await registry.load('tentacle')).manifest.name).toBe('新版')
    expect((await registry.load('tentacle', '0.1.0')).manifest.name).toBe('旧版 · 重导')
  })

  it('leaves the installed bytes and registry untouched when a re-import fails validation', async () => {
    const store = new MemoryPackStore()
    const clock = new FakeClock(Date.UTC(2026, 10, 1, 12, 0, 0))
    const registry = new PackRegistry({ store, clock })
    await registry.install(
      freeformZipWith('tentacle', '0.1.0', '触手', { 'notes/extra.md': '旧附注' }),
      { activate: true },
    )
    const keysBefore = store.keys()
    const decode = (bytes: Uint8Array | undefined): string => new TextDecoder().decode(bytes ?? new Uint8Array())
    const registryBefore = decode(await store.read('content/registry.json'))

    // Same id/version but no persona.md: validation rejects before any write.
    clock.advance(60 * 60 * 1000)
    const broken = zipOf({
      'pack.json': JSON.stringify({
        id: 'tentacle',
        name: '坏包',
        version: '0.1.0',
        engine: '>=0.2 <1.0',
        mode: 'freeform',
        rating: 'all',
      }),
    })
    await expect(registry.install(broken, { activate: true })).rejects.toBeInstanceOf(ContentPackError)

    expect(store.keys()).toEqual(keysBefore)
    expect(decode(await store.read('content/registry.json'))).toBe(registryBefore)
    expect((await registry.load('tentacle')).manifest.name).toBe('触手')
    expect(decode(await store.read('content/packs/tentacle/0.1.0/persona.md'))).toBe(PERSONA)
  })

  it('keeps the old key set when cleanup of a dropped file fails', async () => {
    const store = new FailingStore(undefined, 'notes/extra.md')
    const registry = new PackRegistry({ store })
    await registry.install(
      freeformZipWith('tentacle', '0.1.0', '触手', {
        'notes/extra.md': '旧附注',
        'notes/keep.md': '保留',
      }),
      { activate: true },
    )
    const keysBefore = store.keys()

    // The new archive drops both notes; the first remove fails, so the created
    // keys are rolled back and the previous key set stays in place.
    const error = await registryError(registry.install(freeformZip('tentacle', '0.1.0', '触手 · 新')))
    expect(error.code).toBe('store-failure')
    expect(store.keys()).toEqual(keysBefore)
    // Registry metadata is only committed after every file operation succeeded.
    expect((await registry.list())[0]!.versions[0]!.name).toBe('触手')
  })

  it('rolls back only the files a failed re-import created, keeping overwritten bytes', async () => {
    const store = new FailingStore()
    const registry = new PackRegistry({ store })
    await registry.install(freeformZip('tentacle', '0.1.0', '触手 · 初版'), { activate: true })
    const keysBefore = store.keys()

    // The new archive adds one file and changes pack.json; the persona write
    // fails after those two succeeded. Old bytes of overwritten keys cannot be
    // restored, so they keep the new content and only the created key is
    // removed — the key set is back to exactly what the previous install had.
    store.failOn = 'persona.md'
    const error = await registryError(
      registry.install(freeformZipWith('tentacle', '0.1.0', '触手 · 修订', { 'aaa-extra.md': '新文件' })),
    )
    expect(error.code).toBe('store-failure')
    expect(store.keys()).toEqual(keysBefore)
    const manifest = JSON.parse(
      new TextDecoder().decode((await store.read('content/packs/tentacle/0.1.0/pack.json')) ?? new Uint8Array()),
    ) as { name: string }
    expect(manifest.name).toBe('触手 · 修订')
    // The registry was not updated: it still reports the first install.
    expect((await registry.list())[0]!.versions[0]!.name).toBe('触手 · 初版')
  })

  it('does not delete a freshly written file when a re-import only changes its case (Windows)', async () => {
    // NTFS is case-insensitive: `phases/Resist.md` -> `phases/resist.md` is the
    // same physical file. The pre-write `list` reports the old casing while the
    // write replaces that file under the new casing, so a verbatim stale
    // comparison would `remove` the old-cased key and delete the new bytes.
    const store = new CaseInsensitiveStore()
    const registry = new PackRegistry({ store })
    await registry.install(
      freeformZipWith('tentacle', '0.1.0', '触手', {
        'phases/Resist.md': '旧内容',
        'notes/old.md': '旧附注',
      }),
      { activate: true },
    )
    expect(store.keys()).toContain('content/packs/tentacle/0.1.0/phases/Resist.md')

    const result = await registry.install(
      freeformZipWith('tentacle', '0.1.0', '触手 · 修订', { 'phases/resist.md': '新内容' }),
      { activate: true },
    )
    expect(result.replaced).toBe(true)

    // The case-only rename overwrote the same physical file; the new bytes must
    // still be there (the old-cased remove must not be issued).
    const renamed = await store.read('content/packs/tentacle/0.1.0/phases/resist.md')
    expect(new TextDecoder().decode(renamed ?? new Uint8Array())).toBe('新内容')
    expect(store.keys()).toContain('content/packs/tentacle/0.1.0/phases/resist.md')
    expect(store.keys()).not.toContain('content/packs/tentacle/0.1.0/phases/Resist.md')

    // A file the new archive genuinely dropped is still cleaned up, and the
    // installed pack still loads.
    expect(await store.read('content/packs/tentacle/0.1.0/notes/old.md')).toBeUndefined()
    expect(store.keys()).not.toContain('content/packs/tentacle/0.1.0/notes/old.md')
    expect((await registry.load('tentacle')).manifest.name).toBe('触手 · 修订')
  })

  it('imports a pack wrapped in a folder and ignores OS junk', async () => {
    const store = new MemoryPackStore()
    const registry = new PackRegistry({ store })
    const result = await registry.install(freeformZip('wrapped', '0.1.0', '包装包', 'WrappedPack'), { activate: true })

    expect(result.pack.manifest.id).toBe('wrapped')
    expect(result.replaced).toBe(false)
    expect(store.keys()).toContain('content/packs/wrapped/0.1.0/pack.json')
    expect(store.keys()).toContain('content/packs/wrapped/0.1.0/persona.md')
    expect(store.keys().some(key => key.includes('__MACOSX') || key.includes('.DS_Store'))).toBe(false)
    expect((await registry.load('wrapped')).persona).toContain('温柔而克制')
  })

  it('rolls back downloaded files when the store fails mid-install', async () => {
    const failingFiles = new FailingStore('persona.md')
    const registry = new PackRegistry({ store: failingFiles })
    const fileError = await registryError(registry.install(freeformZip('tentacle', '0.1.0', '触手')))
    expect(fileError.code).toBe('store-failure')
    expect(failingFiles.keys()).toEqual([])

    const failingRegistry = new FailingStore('content/registry.json')
    const registry2 = new PackRegistry({ store: failingRegistry })
    const registryErrorResult = await registryError(registry2.install(freeformZip('tentacle', '0.1.0', '触手')))
    expect(registryErrorResult.code).toBe('store-failure')
    // Files written before the registry update are rolled back too.
    expect(failingRegistry.keys()).toEqual([])
    expect(await registry2.list()).toEqual([])
  })

  it('reports a corrupt registry instead of silently resetting it', async () => {
    const store = new MemoryPackStore()
    await store.write('content/registry.json', utf8('{ "version": 1, "packs": '))
    const registry = new PackRegistry({ store })
    const error = await registryError(registry.list())
    expect(error.code).toBe('invalid-registry')

    await store.write(
      'content/registry.json',
      utf8(JSON.stringify({ version: 1, packs: { tentacle: { active: '9.9.9', versions: {} } } })),
    )
    const second = await registryError(registry.list())
    expect(second.code).toBe('invalid-registry')
  })

  it('loads an installed scenario pack with host, phase notes and waveforms', async () => {
    const store = new MemoryPackStore()
    const registry = new PackRegistry({ store })
    const result = await registry.install(scenarioZip(), { activate: true })
    expect(result.active).toBe(true)

    const pack = await registry.load('tentacle-pure')
    expect(pack.scenario?.phases.map(phase => phase.id)).toEqual(['probe', 'resolve'])
    expect(pack.host).toContain('节奏：慢')
    expect(pack.phaseNotes.size).toBe(2)
    expect(pack.waveforms.map(waveform => waveform.id)).toEqual(['tentacle-pure:gentle'])
    expect(pack.manifest.mode).toBe('scenario')

    const entries = await registry.list()
    expect(entries[0]!.versions[0]!.mode).toBe('scenario')
    expect(entries[0]!.versions[0]!.rating).toBe('18+')
  })
})
