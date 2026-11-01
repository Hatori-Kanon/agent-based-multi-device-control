/**
 * `FsPackStore`（B2-T14 宿主侧 `PackStore`）的行为测试。
 *
 * 覆盖注册表真正依赖的四条契约：原子写、缺失容忍、递归 list、越界/符号链接
 * 拒绝；另外验证崩溃残留的临时文件不会被当成包文件列出来。
 */

import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FsPackStore } from '../src/main/pack-store.ts'

let root: string
let store: FsPackStore

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

beforeEach(async () => {
  await mkdir(join(process.cwd(), '.test-tmp'), { recursive: true })
  root = await mkdtemp(join(process.cwd(), '.test-tmp', 'pack-store-'))
  store = new FsPackStore(root)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('FsPackStore', () => {
  it('writes nested keys, reads them back, and overwrites atomically', async () => {
    const key = 'content/packs/demo/1.0.0/pack.json'
    await store.write(key, utf8('{"id":"demo"}'))
    expect(await store.read(key)).toEqual(utf8('{"id":"demo"}'))

    await store.write(key, utf8('{"id":"demo","version":"1.0.0"}'))
    expect(await store.read(key)).toEqual(utf8('{"id":"demo","version":"1.0.0"}'))

    // write 会 mkdir -p；磁盘上只应有目标文件，没有遗留临时文件。
    const directory = join(root, 'content', 'packs', 'demo', '1.0.0')
    expect(await readdir(directory)).toEqual(['pack.json'])
    expect(await readFile(join(directory, 'pack.json'), 'utf8')).toBe('{"id":"demo","version":"1.0.0"}')
  })

  it('treats a missing file as absent and a missing remove as success', async () => {
    expect(await store.read('content/registry.json')).toBeUndefined()
    await expect(store.remove('content/registry.json')).resolves.toBeUndefined()
    await store.write('content/registry.json', utf8('{}'))
    await store.remove('content/registry.json')
    expect(await store.read('content/registry.json')).toBeUndefined()
  })

  it('lists files recursively under a prefix in stable order', async () => {
    await store.write('content/registry.json', utf8('{}'))
    await store.write('content/packs/b/1.0.0/persona.md', utf8('b'))
    await store.write('content/packs/a/1.0.0/pack.json', utf8('a'))
    await store.write('content/packs/a/1.0.0/persona.md', utf8('a'))

    expect(await store.list('content/packs/')).toEqual([
      'content/packs/a/1.0.0/pack.json',
      'content/packs/a/1.0.0/persona.md',
      'content/packs/b/1.0.0/persona.md',
    ])
    // 不带尾随斜杠的 prefix 同样按目录处理。
    expect(await store.list('content')).toEqual([
      'content/packs/a/1.0.0/pack.json',
      'content/packs/a/1.0.0/persona.md',
      'content/packs/b/1.0.0/persona.md',
      'content/registry.json',
    ])
    // 注册表在卸载/首次启动时会查询尚不存在的目录。
    expect(await store.list('content/packs/nope/')).toEqual([])
    expect(await store.list('')).toEqual([
      'content/packs/a/1.0.0/pack.json',
      'content/packs/a/1.0.0/persona.md',
      'content/packs/b/1.0.0/persona.md',
      'content/registry.json',
    ])
  })

  it('refuses keys and prefixes that escape the store root', async () => {
    const badKeys = [
      '',
      '../escape',
      'content/../../escape',
      '/absolute',
      'C:/windows',
      'content\\registry.json',
      'a//b',
      './x',
      'content/.',
    ]
    for (const key of badKeys) {
      await expect(store.write(key, utf8('x'))).rejects.toThrow(/refusing pack-store key/u)
      await expect(store.read(key)).rejects.toThrow(/refusing pack-store key/u)
      await expect(store.remove(key)).rejects.toThrow(/refusing pack-store key/u)
    }
    for (const prefix of ['/', '../', 'content/../../']) {
      await expect(store.list(prefix)).rejects.toThrow(/refusing pack-store key/u)
    }
    // 越界尝试没有在根目录之外留下任何文件。
    await expect(readFile(join(root, '..', 'escape'), 'utf8')).rejects.toThrow()
  })

  it('does not list a stale temp file left by an interrupted atomic write', async () => {
    const directory = join(root, 'content', 'packs', 'demo', '1.0.0')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'persona.md'), '# demo\n')
    // 模拟 writeFile 与 rename 之间崩溃：真实文件 + 一个临时残片。
    await writeFile(join(directory, 'pack.json.tmp-0123456789ab'), '{"id":')

    expect(await store.list('content/packs/demo/1.0.0/')).toEqual([
      'content/packs/demo/1.0.0/persona.md',
    ])
  })

  it('refuses to read through a symbolic link planted inside the store', async () => {
    const outside = join(root, '..', `outside-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`)
    await writeFile(outside, 'secret')
    try {
      const link = join(root, 'content', 'registry.json')
      await mkdir(join(root, 'content'), { recursive: true })
      try {
        await symlink(outside, link, 'file')
      } catch {
        // Windows 未开开发者模式时创建符号链接需要管理员权限；此测试只在
        // 平台允许时验证行为，不能因此让套件变红。
        return
      }
      await expect(store.read('content/registry.json')).rejects.toThrow(/symbolic link/u)
      expect(await store.list('content/')).toEqual([])
    } finally {
      await rm(outside, { force: true })
    }
  })
})
