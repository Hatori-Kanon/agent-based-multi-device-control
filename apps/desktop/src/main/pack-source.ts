/**
 * 已安装内容包 → 会话服务的适配器（B2-T14 宿主接线）。
 *
 * `PlayHost` 只要求 `{ load(packId): Promise<LoadedPack> }`；本模块先用
 * `PackRegistry` 决定“下一次会话该用哪个版本”，再把基于 `FsPackStore` 的
 * `ContentSource` 交给 `loadPack` 从磁盘读取，避免把整个包复制进内存两次。
 *
 * 版本规则（`内容包规范.md` §6.4）：
 *
 * 1. 注册表条目存在时只看 `activeVersion`。没有 active 版本就明确报错，
 *    绝不猜“最新版”——会话中途不热切换，下一次会话从哪个版本开始必须由
 *    人类显式选择。
 * 2. `content/registry.json` 还不存在时，兼容 M2-B1 的临时目录布局
 *    （`content/packs/<id>/<version>/`，取最高 semver）。这是升级路径：
 *    一旦注册表被写过一次，它就是唯一权威，未登记的目录不再被自动采用。
 *
 * 错误保持可读：包内容错误以 `ContentPackError` 抛出（`PlayHost` 映射为
 * `PACK_INVALID`）；未安装/无 active 版本直接抛 `SessionError`（带
 * `PACK_NOT_FOUND`/`INVALID_INPUT` 码），控制台统一以 400 返回。
 */

import {
  ContentPackError,
  loadPack,
  PACKS_PREFIX,
  parseVersion,
  REGISTRY_KEY,
  type ContentSource,
  type LoadedPack,
  type PackRegistry,
  type PackStore,
  type SemverVersion,
} from '@embodied/core'
import { SessionError, type PlayPackSource } from './play.ts'

/** 与注册表一致的包 id 规则；拒绝在拼路径前。 */
const PACK_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/u

export interface RegistryPackSourceOptions {
  /** 已安装包的权威来源。 */
  readonly registry: PackRegistry
  /** 与注册表共用的存储端口；适配器只读，不写任何文件。 */
  readonly store: PackStore
  /** 校验 `pack.json#engine` 的引擎版本；省略时用 `loadPack` 的默认值。 */
  readonly engineVersion?: string
}

/**
 * `PlayHostOptions.packs` 的宿主实现。
 *
 * 读取时只使用注册表记录的 active 版本；注册表尚未创建时才回退到
 * M2-B1 的目录布局（见模块注释）。
 */
export class RegistryPackSource implements PlayPackSource {
  private readonly registry: PackRegistry
  private readonly store: PackStore
  private readonly engineVersion: string | undefined

  constructor(options: RegistryPackSourceOptions) {
    this.registry = options.registry
    this.store = options.store
    this.engineVersion = options.engineVersion
  }

  async load(packId: string): Promise<LoadedPack> {
    if (!PACK_ID_PATTERN.test(packId)) {
      throw new SessionError('INVALID_INPUT', `"${packId}" is not a valid content-pack id`)
    }
    const version = await this.resolveVersion(packId)
    const source = new StoreContentSource(this.store, `${PACKS_PREFIX}${packId}/${version}/`)
    try {
      return await loadPack(source, this.engineVersion === undefined ? {} : { engineVersion: this.engineVersion })
    } catch (error) {
      // 包内容错误已经带文件名/JSON 路径，原样交给 PlayHost 映射为 PACK_INVALID。
      if (error instanceof ContentPackError) throw error
      throw new SessionError(
        'PACK_NOT_FOUND',
        `could not load content pack "${packId}"@${version}: ${describe(error)}`,
      )
    }
  }

  /**
   * 解析本次会话应加载的版本。
   *
   * 注册表存在时绝不回退：未登记的包 = 未安装；登记但无 active = 需要人类先
   * 激活一个版本。只有整个 `content/registry.json` 从未创建时（M2-B1 升级
   * 路径）才扫描旧目录。
   */
  private async resolveVersion(packId: string): Promise<string> {
    const entries = await this.registry.list()
    const entry = entries.find(candidate => candidate.id === packId)
    if (entry !== undefined) {
      if (entry.activeVersion === undefined) {
        throw new SessionError(
          'PACK_NOT_FOUND',
          `content pack "${packId}" has no active version; activate one first`,
        )
      }
      return entry.activeVersion
    }
    const registryExists = (await this.store.read(REGISTRY_KEY)) !== undefined
    if (registryExists) {
      throw new SessionError('PACK_NOT_FOUND', `content pack "${packId}" is not installed`)
    }
    const legacy = await this.legacyVersion(packId)
    if (legacy === undefined) {
      throw new SessionError('PACK_NOT_FOUND', `content pack "${packId}" is not installed`)
    }
    return legacy
  }

  /** M2-B1 兼容：未建注册表时取 `content/packs/<id>/<version>/` 的最高版本。 */
  private async legacyVersion(packId: string): Promise<string | undefined> {
    const prefix = `${PACKS_PREFIX}${packId}/`
    const keys = await this.store.list(prefix)
    const versions: { readonly name: string; readonly version: SemverVersion }[] = []
    for (const key of keys) {
      if (!key.startsWith(prefix)) continue
      const relativePath = key.slice(prefix.length)
      const separator = relativePath.indexOf('/')
      if (separator <= 0) continue
      const name = relativePath.slice(0, separator)
      const version = parseVersion(name)
      if (version !== undefined) versions.push({ name, version })
    }
    versions.sort((left, right) => compareVersions(right.version, left.version))
    return versions[0]?.name
  }
}

function compareVersions(left: SemverVersion, right: SemverVersion): number {
  if (left.major !== right.major) return left.major - right.major
  if (left.minor !== right.minor) return left.minor - right.minor
  return left.patch - right.patch
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 把 `<dataDir>/content/packs/<id>/<version>/` 投影成加载器要的
 * `ContentSource`；路径校验在端口这一侧再做一遍，避免宿主拼出越界 key。
 */
class StoreContentSource implements ContentSource {
  private readonly store: PackStore
  private readonly prefix: string

  constructor(store: PackStore, prefix: string) {
    this.store = store
    this.prefix = prefix
  }

  async list(): Promise<readonly string[]> {
    const keys = await this.store.list(this.prefix)
    const files: string[] = []
    for (const key of keys) {
      if (!key.startsWith(this.prefix)) continue
      const path = key.slice(this.prefix.length)
      if (path.length === 0) continue
      files.push(path)
    }
    return files.sort()
  }

  async readText(path: string): Promise<string> {
    return new TextDecoder().decode(await this.readBytes(path))
  }

  async readBytes(path: string): Promise<Uint8Array> {
    const key = this.keyFor(path)
    const bytes = await this.store.read(key)
    if (bytes === undefined) throw new Error(`content source has no file "${path}"`)
    return bytes
  }

  async byteSize(path: string): Promise<number> {
    const bytes = await this.readBytes(path)
    return bytes.byteLength
  }

  private keyFor(path: string): string {
    const segments = path.split('/')
    if (
      path.length === 0 ||
      path.includes('\\') ||
      path.startsWith('/') ||
      segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')
    ) {
      throw new Error(`content source path "${path}" is not a safe pack-relative path`)
    }
    return `${this.prefix}${path}`
  }
}
