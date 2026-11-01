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

function freeformZip(id: string, version: string, name: string, directory?: string): Uint8Array {
  const prefix = directory === undefined ? '' : `${directory}/`
  return zipOf({
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
  })
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

/** Store that fails the write for a chosen key so rollback behaviour is testable. */
class FailingStore implements PackStore {
  private readonly inner = new MemoryPackStore()
  private readonly failOn: string

  constructor(failOn: string) {
    this.failOn = failOn
  }

  read(key: string): Promise<Uint8Array | undefined> {
    return this.inner.read(key)
  }

  write(key: string, bytes: Uint8Array): Promise<void> {
    if (key.includes(this.failOn)) return Promise.reject(new Error('simulated disk full'))
    return this.inner.write(key, bytes)
  }

  remove(key: string): Promise<void> {
    return this.inner.remove(key)
  }

  list(prefix: string): Promise<readonly string[]> {
    return this.inner.list(prefix)
  }

  keys(): readonly string[] {
    return this.inner.keys()
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

  it('installs the same id and version only once', async () => {
    const store = new MemoryPackStore()
    const registry = new PackRegistry({ store })
    const archive = freeformZip('tentacle', '0.1.0', '触手')
    await registry.install(archive)
    const keysAfterInstall = store.keys()

    const duplicate = await registryError(registry.install(archive))
    expect(duplicate.code).toBe('already-installed')
    expect(store.keys()).toEqual(keysAfterInstall)
  })

  it('imports a pack wrapped in a folder and ignores OS junk', async () => {
    const store = new MemoryPackStore()
    const registry = new PackRegistry({ store })
    const result = await registry.install(freeformZip('wrapped', '0.1.0', '包装包', 'WrappedPack'), { activate: true })

    expect(result.pack.manifest.id).toBe('wrapped')
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
