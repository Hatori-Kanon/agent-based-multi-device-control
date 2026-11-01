/**
 * `PackStore` 的 `node:fs` 实现：把内容包注册表落在 `<dataDir>` 下。
 *
 * 注册表（`packages/core/src/scenario/pack-registry.ts`）只认这个端口，
 * key 是相对 `<dataDir>` 的 POSIX 路径（如 `content/registry.json`、
 * `content/packs/<id>/<version>/pack.json`）。本模块负责：
 *
 * - **原子写**：先写同目录临时文件再 `rename`，进程崩溃时不会留下
 *   半个 `registry.json` 或半个包文件；
 * - **缺失即常态**：`read` 缺失返回 `undefined`，`remove` 缺失不报错，
 *   `list` 指向的目录尚不存在时返回空列表；
 * - **越界拒绝**：绝对路径、`..`、反斜杠、控制字符在碰到 `fs` 之前就被
 *   拒绝（`内容包规范.md` §9）；
 * - **不跟符号链接**：`内容包规范.md` §9 要求导入/安装路径里的符号链接
 *   一律拒绝，`list` 直接跳过链接，`read` 明确报错。
 *
 * 临时文件名形如 `<目标名>.tmp-<12 位十六进制>`，`list` 会忽略它：如果进程
 * 恰好在 `writeFile` 与 `rename` 之间退出，残片不会被当成包文件交给加载器。
 */

import { randomBytes } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { PackStore } from '@embodied/core'

const TEMP_SUFFIX = /\.tmp-[0-9a-f]{12}$/u
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code
}

function invalid(operation: string, key: string, reason: string): Error {
  return new Error(`${operation}: refusing pack-store key "${key}": ${reason}`)
}

/**
 * 校验并拆分一个相对 POSIX key（文件路径或目录 prefix）。
 */
function keySegments(key: string, operation: string): readonly string[] {
  if (key.length === 0) throw invalid(operation, key, 'the key must not be empty')
  if (key.includes('\\')) throw invalid(operation, key, 'use POSIX "/" separators')
  if (key.startsWith('/') || /^[A-Za-z]:/u.test(key)) {
    throw invalid(operation, key, 'absolute paths are not allowed')
  }
  if (CONTROL_CHARS.test(key)) throw invalid(operation, key, 'control characters are not allowed')
  const segments = key.split('/')
  for (const segment of segments) {
    if (segment.length === 0) throw invalid(operation, key, 'empty path segment')
    if (segment === '.' || segment === '..') {
      throw invalid(operation, key, '"." and ".." segments are not allowed')
    }
  }
  return segments
}

/** `list` 的 prefix 只宽松到允许一个尾随斜杠，其余规则与文件 key 相同。 */
function prefixSegments(prefix: string): readonly string[] {
  if (prefix.length === 0) return []
  // `/` 是根目录的绝对路径；根 prefix 只能用空字符串表示。
  if (prefix.startsWith('/') || /^[A-Za-z]:/u.test(prefix)) {
    throw invalid('list', prefix, 'absolute paths are not allowed')
  }
  const trimmed = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix
  if (trimmed.length === 0) {
    throw invalid('list', prefix, 'use the empty prefix for the store root')
  }
  return keySegments(trimmed, 'list')
}

/**
 * 以 `<dataDir>` 为根的文件系统内容包仓库。
 *
 * `PackRegistry` 通过它读写 `content/registry.json` 与安装的包文件；会话服务
 * 的 `RegistryPackSource` 则用同一实例构造只读的 `ContentSource`。
 */
export class FsPackStore implements PackStore {
  private readonly root: string

  constructor(root: string) {
    this.root = resolve(root)
  }

  async read(key: string): Promise<Uint8Array | undefined> {
    const target = this.target(keySegments(key, 'read'), 'read')
    try {
      const info = await lstat(target)
      if (info.isSymbolicLink()) {
        throw new Error(`read: refusing symbolic link "${key}" in the pack store`)
      }
      if (!info.isFile()) return undefined
      return new Uint8Array(await readFile(target))
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return undefined
      throw error
    }
  }

  async write(key: string, bytes: Uint8Array): Promise<void> {
    const target = this.target(keySegments(key, 'write'), 'write')
    // 目录按需创建：安装器逐文件写入，不需要提前知道包目录结构。
    await mkdir(dirname(target), { recursive: true })
    const temp = `${target}.tmp-${randomBytes(6).toString('hex')}`
    try {
      await writeFile(temp, bytes)
      await rename(temp, target)
    } catch (error) {
      try {
        await unlink(temp)
      } catch {
        // 尽力清理；原始写入错误更有诊断价值。
      }
      throw error
    }
  }

  async remove(key: string): Promise<void> {
    const target = this.target(keySegments(key, 'remove'), 'remove')
    try {
      await unlink(target)
    } catch (error) {
      // 卸载可以重复执行；文件已经不在就是想要的状态。
      if (!hasCode(error, 'ENOENT')) throw error
    }
  }

  async list(prefix: string): Promise<readonly string[]> {
    const segments = prefixSegments(prefix)
    const directory = this.target(segments, 'list')
    const keys: string[] = []
    const normalized = segments.length === 0 ? '' : `${segments.join('/')}/`
    await this.walk(directory, normalized, keys)
    // 稳定顺序让注册表/加载器的警告顺序可复现。
    return keys.sort()
  }

  /** 把相对 key 解析成绝对路径，并确认结果仍在根目录之内。 */
  private target(segments: readonly string[], operation: string): string {
    const target = resolve(this.root, ...segments)
    const fromRoot = relative(this.root, target)
    if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
      throw new Error(`${operation}: key escapes the pack store root`)
    }
    return target
  }

  private async walk(directory: string, prefix: string, out: string[]): Promise<void> {
    let entries: Dirent[]
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      // 还没安装任何包时目录不存在；空列表比 ENOENT 更有用。
      if (hasCode(error, 'ENOENT') || hasCode(error, 'ENOTDIR')) return
      throw error
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        await this.walk(join(directory, entry.name), `${prefix}${entry.name}/`, out)
      } else if (entry.isFile() && !TEMP_SUFFIX.test(entry.name)) {
        out.push(`${prefix}${entry.name}`)
      }
    }
  }
}
