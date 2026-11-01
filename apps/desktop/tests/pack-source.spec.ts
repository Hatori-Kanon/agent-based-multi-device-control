/**
 * `RegistryPackSource`（B2-T14 会话侧适配器）的行为测试。
 *
 * 用真实的 `FsPackStore` + `PackRegistry` 跑在临时目录上：这里要验证的重点
 * 不是注册表本身（core 已有测试），而是“下一次会话到底会加载哪个版本”：
 * 注册表 active 版本优先、无 active 明确报错、注册表存在后不再回退目录布局。
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ContentPackError,
  ENGINE_VERSION,
  FakeClock,
  PackRegistry,
  PACKS_PREFIX,
  REGISTRY_KEY,
} from '@embodied/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FsPackStore } from '../src/main/pack-store.ts'
import { RegistryPackSource } from '../src/main/pack-source.ts'

const PERSONA = '# 阿岚\n\n温柔而克制的引导者。\n\n## 导演摘要\n\n先观察再靠近。\n'
const INSTALLED_AT = '2026-11-01T12:00:00.000Z'

let root: string
let store: FsPackStore
let registry: PackRegistry
let source: RegistryPackSource

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function manifest(id: string, version: string): string {
  return JSON.stringify({
    id,
    name: `${id} ${version}`,
    version,
    engine: '>=0.2 <1.0',
    mode: 'freeform',
    rating: 'all',
    boundaries: ['不做真实伤害'],
  })
}

async function writePackFiles(id: string, version: string, persona = PERSONA): Promise<void> {
  await store.write(`${PACKS_PREFIX}${id}/${version}/pack.json`, utf8(manifest(id, version)))
  await store.write(`${PACKS_PREFIX}${id}/${version}/persona.md`, utf8(persona))
}

interface SeedEntry {
  readonly active?: string
  readonly versions: readonly string[]
}

/** 直接写 `content/registry.json`（与 PackRegistry 的 schema 一致）。 */
async function seedRegistry(entries: Readonly<Record<string, SeedEntry>>): Promise<void> {
  const packs: Record<string, unknown> = {}
  for (const [id, entry] of Object.entries(entries)) {
    const versions: Record<string, unknown> = {}
    for (const version of entry.versions) {
      await writePackFiles(id, version)
      versions[version] = {
        name: `${id} ${version}`,
        mode: 'freeform',
        rating: 'all',
        installedAt: INSTALLED_AT,
      }
    }
    packs[id] = entry.active === undefined ? { versions } : { active: entry.active, versions }
  }
  await store.write(REGISTRY_KEY, utf8(JSON.stringify({ version: 1, packs }, null, 2)))
}

beforeEach(async () => {
  await mkdir(join(process.cwd(), '.test-tmp'), { recursive: true })
  root = await mkdtemp(join(process.cwd(), '.test-tmp', 'pack-source-'))
  store = new FsPackStore(root)
  registry = new PackRegistry({
    store,
    clock: new FakeClock(Date.UTC(2026, 10, 1, 12, 0, 0)),
    engineVersion: ENGINE_VERSION,
  })
  source = new RegistryPackSource({ registry, store, engineVersion: ENGINE_VERSION })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('RegistryPackSource', () => {
  it('loads the active version even when a newer version is installed', async () => {
    await seedRegistry({ demo: { active: '1.0.0', versions: ['1.0.0', '1.1.0'] } })

    const pack = await source.load('demo')
    expect(pack.manifest.version).toBe('1.0.0')
    expect(pack.persona).toContain('温柔而克制')
  })

  it('switches to the version activated through the registry', async () => {
    await seedRegistry({ demo: { active: '1.0.0', versions: ['1.0.0', '1.1.0'] } })
    await registry.activate('demo', '1.1.0')

    expect((await source.load('demo')).manifest.version).toBe('1.1.0')
  })

  it('refuses a registered pack with no active version instead of guessing the newest', async () => {
    await seedRegistry({ demo: { versions: ['1.0.0', '1.1.0'] } })

    await expect(source.load('demo')).rejects.toMatchObject({ code: 'PACK_NOT_FOUND' })
    await expect(source.load('demo')).rejects.toThrow(/no active version/u)
  })

  it('refuses an unknown pack once the registry exists', async () => {
    await seedRegistry({ demo: { active: '1.0.0', versions: ['1.0.0'] } })

    await expect(source.load('ghost')).rejects.toMatchObject({ code: 'PACK_NOT_FOUND' })
    await expect(source.load('ghost')).rejects.toThrow(/not installed/u)
  })

  it('refuses an id that could escape the pack directory before touching disk', async () => {
    await seedRegistry({ demo: { active: '1.0.0', versions: ['1.0.0'] } })

    await expect(source.load('../demo')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(source.load('../demo')).rejects.toThrow(/not a valid content-pack id/u)
  })

  it('surfaces a corrupt installed pack as a ContentPackError', async () => {
    await seedRegistry({ demo: { active: '1.0.0', versions: ['1.0.0'] } })
    await store.remove(`${PACKS_PREFIX}demo/1.0.0/persona.md`)

    const failure = await source.load('demo').then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(ContentPackError)
    expect((failure as ContentPackError).message).toContain('persona.md')
  })

  it('falls back to the M2-B1 directory layout only while no registry exists', async () => {
    await writePackFiles('legacy', '1.0.0')
    await writePackFiles('legacy', '1.2.0')

    const pack = await source.load('legacy')
    expect(pack.manifest.version).toBe('1.2.0')

    // 注册表一旦存在就是唯一权威：未登记的旧目录不再被自动采用。
    await store.write(REGISTRY_KEY, utf8(JSON.stringify({ version: 1, packs: {} })))
    await expect(source.load('legacy')).rejects.toThrow(/not installed/u)
  })
})
