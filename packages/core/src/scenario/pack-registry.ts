/**
 * Installed content-pack registry.
 *
 * Owns the on-disk layout from `M2-实施计划.md` §4.6.3 / `内容包规范.md` §6:
 *
 *     <dataDir>/content/registry.json              # active version per pack id
 *     <dataDir>/content/packs/<id>/<version>/...   # installed pack files
 *
 * Invariants:
 *
 * 1. **Several versions of one id coexist, exactly one is active.** The active
 *    version is what the next session starts from (`内容包规范.md` §6.4: no
 *    hot-swapping mid-session).
 * 2. **Validation happens before any write.** The pack is fully validated
 *    through `loadPack` (which runs `validatePack`) *before* a single byte is
 *    written, and a failure while writing rolls back the files this call
 *    created. Re-importing an installed `id@version` replaces it in place
 *    instead of being rejected — the product rule is "解压到项目目录，同名文件
 *    覆盖" — so a failed re-import cannot restore bytes it already overwrote;
 *    see `PackRegistry.install` for the exact failure contract.
 * 3. **Uninstall only removes `content/packs/…` and the registry entry.** User
 *    saves (`state/…`, `memory/…`) are never touched — the port is rooted at
 *    `<dataDir>` precisely so that rule is structural rather than a convention.
 *
 * Platform-free like the rest of `core`: this module never imports `node:fs`.
 * The host supplies a {@link PackStore} implementation (see the TODO below).
 *
 * TODO(host wiring, owned by Lead — `apps/desktop/src/main/bootstrap.ts`):
 * - Implement `PackStore` over `node:fs` rooted at `<dataDir>`:
 *   `read`/`write`/`remove`/`list` map to `fs.readFile`/`writeFile`/`unlink`/
 *   `readdir` + `mkdir -p`; write `content/registry.json` with temp+rename.
 * - Create `new PackRegistry({ store, clock: systemClock })` in `bootstrap.ts`
 *   after `loadConfig()` and pass it to the dashboard.
 * - Routes (§4.11): `GET /api/packs` → `registry.list()`;
 *   `POST /api/packs/import` → `readZip(uploadBytes)` + `registry.install(...)`;
 *   `POST /api/packs/activate` → `registry.activate(id, version)`;
 *   session start → `registry.load(activeId)`.
 * - Single-`.md` import (`内容包规范.md` §6.1: slug id + placeholder
 *   `pack.json`) is a host-side convenience built on `install`; it is not part
 *   of this module.
 */

import type { Clock } from '../ports/clock.ts'
import { systemClock } from '../ports/clock.ts'
import { MemoryContentSource } from '../ports/content-source.ts'
import { loadPack, type LoadedPack, type PackMode, type PackRating } from './loader.ts'
import { parseVersion } from './semver.ts'
import { readZip, type RawInflate } from './zip.ts'

/** Registry document path, relative to the injected store root (`<dataDir>`). */
export const REGISTRY_KEY = 'content/registry.json'
/** Directory that holds every installed pack, relative to the store root. */
export const PACKS_PREFIX = 'content/packs/'

/**
 * Minimal storage port for the registry.
 *
 * Keys are POSIX paths relative to `<dataDir>`; the host maps them onto the
 * filesystem. Deliberately smaller than a filesystem: no metadata, no symlinks
 * (the importer/loader never needs them), and `list(prefix)` returns keys
 * starting with `prefix` in a stable order.
 */
export interface PackStore {
  read(key: string): Promise<Uint8Array | undefined>
  write(key: string, bytes: Uint8Array): Promise<void>
  remove(key: string): Promise<void>
  list(prefix: string): Promise<readonly string[]>
}

/** In-memory {@link PackStore} for tests and dry runs. */
export class MemoryPackStore implements PackStore {
  private readonly files = new Map<string, Uint8Array>()

  read(key: string): Promise<Uint8Array | undefined> {
    const value = this.files.get(key)
    return Promise.resolve(value === undefined ? undefined : new Uint8Array(value))
  }

  write(key: string, bytes: Uint8Array): Promise<void> {
    this.files.set(key, new Uint8Array(bytes))
    return Promise.resolve()
  }

  remove(key: string): Promise<void> {
    this.files.delete(key)
    return Promise.resolve()
  }

  list(prefix: string): Promise<readonly string[]> {
    return Promise.resolve([...this.files.keys()].filter(key => key.startsWith(prefix)).sort())
  }

  /** Every stored key, sorted. Test/UI convenience. */
  keys(): readonly string[] {
    return [...this.files.keys()].sort()
  }
}

export type PackRegistryErrorCode =
  | 'not-found'
  | 'not-installed'
  | 'invalid-argument'
  | 'invalid-registry'
  | 'no-active-version'
  | 'empty-pack'
  | 'store-failure'

export class PackRegistryError extends Error {
  readonly code: PackRegistryErrorCode

  constructor(code: PackRegistryErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'PackRegistryError'
    this.code = code
  }
}

/** One installed version, as reported to the UI. */
export interface InstalledPackVersion {
  readonly id: string
  readonly version: string
  readonly name: string
  readonly mode: PackMode
  readonly rating: PackRating
  /** ISO timestamp written by the injected clock at install time. */
  readonly installedAt: string
  /** True for the version the next session will start from. */
  readonly active: boolean
}

/** One pack id with all of its installed versions. */
export interface PackRegistryEntry {
  readonly id: string
  readonly activeVersion: string | undefined
  readonly versions: readonly InstalledPackVersion[]
}

export interface InstallPackOptions {
  /** Make the new version active immediately (upgrade/replace flows). Defaults to false. */
  readonly activate?: boolean
  /** Overrides `PackRegistryOptions.engineVersion` for this install. */
  readonly engineVersion?: string
}

export interface InstallResult {
  readonly id: string
  readonly version: string
  /** True when this install became the active version. */
  readonly active: boolean
  /**
   * True when this install replaced an already-installed `id@version` (the
   * archive was extracted over the existing `content/packs/<id>/<version>/`
   * prefix). False for a first install. The host surfaces this so the import UI
   * can say "已导入（覆盖）" instead of pretending it was a fresh install.
   */
  readonly replaced: boolean
  /** The fully validated pack; the host may start a session from it directly. */
  readonly pack: LoadedPack
}

export interface PackRegistryOptions {
  readonly store: PackStore
  /** Defaults to the real clock; tests inject `FakeClock`. */
  readonly clock?: Clock
  /** Engine version used to validate `pack.json#engine`; defaults to `ENGINE_VERSION`. */
  readonly engineVersion?: string
  /**
   * Raw DEFLATE decompressor for zip import, injected by the host.
   *
   * `core` stays free of platform APIs, so the desktop host passes Node's
   * `zlib.inflateRaw`; without it, importing a deflated archive fails with
   * `ZipError('inflate-unavailable')` instead of guessing.
   */
  readonly inflateRaw?: RawInflate
}

interface RegistryVersionMeta {
  readonly name: string
  readonly mode: PackMode
  readonly rating: PackRating
  readonly installedAt: string
}

interface RegistryPack {
  readonly active: string | undefined
  readonly versions: Readonly<Record<string, RegistryVersionMeta>>
}

interface RegistryDocument {
  readonly version: 1
  readonly packs: Readonly<Record<string, RegistryPack>>
}

const PACK_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/u
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u

function emptyRegistry(): RegistryDocument {
  return { version: 1, packs: {} }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sortVersions(versions: readonly string[]): readonly string[] {
  return [...versions].sort((left, right) => {
    try {
      const a = parseVersion(left)
      const b = parseVersion(right)
      if (a.major !== b.major) return a.major - b.major
      if (a.minor !== b.minor) return a.minor - b.minor
      return a.patch - b.patch
    } catch {
      return left < right ? -1 : left > right ? 1 : 0
    }
  })
}

/** Drop OS junk files a ZIP tool added (`__MACOSX/`, `.DS_Store`, …). */
function dropJunk(files: ReadonlyMap<string, Uint8Array>): Map<string, Uint8Array> {
  const kept = new Map<string, Uint8Array>()
  for (const [path, data] of files) {
    const base = path.split('/').pop() ?? ''
    if (path.startsWith('__MACOSX/') || base === '.DS_Store' || base === 'Thumbs.db') continue
    kept.set(path, data)
  }
  return kept
}

/**
 * Normalize an imported file map.
 *
 * Authors usually zip the pack *folder* (`MyPack/pack.json`), so a single
 * shared top-level directory is stripped. OS junk is dropped first. Everything
 * else must already be a valid pack root; validation reports the rest.
 */
function normalizeImport(files: ReadonlyMap<string, Uint8Array>): Map<string, Uint8Array> {
  let current = dropJunk(files)
  const roots = new Set([...current.keys()].map(path => path.split('/')[0]!))
  const hasRootFile = [...current.keys()].some(path => !path.includes('/'))
  if (!hasRootFile && roots.size === 1) {
    const root = [...roots][0]!
    const stripped = new Map<string, Uint8Array>()
    for (const [path, data] of current) {
      if (!path.startsWith(`${root}/`)) continue
      const relative = path.slice(root.length + 1)
      if (relative.length > 0) stripped.set(relative, data)
    }
    current = stripped
  }
  return new Map([...current.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)))
}

function validateArguments(id: string, version: string | undefined): void {
  if (!PACK_ID_PATTERN.test(id)) {
    throw new PackRegistryError('invalid-argument', `invalid pack id "${id}"; expected lowercase letters, digits and dashes`)
  }
  if (version !== undefined && !VERSION_PATTERN.test(version)) {
    throw new PackRegistryError('invalid-argument', `invalid pack version "${version}"; expected x.y.z`)
  }
}

function packPrefix(id: string, version: string): string {
  const prefix = `${PACKS_PREFIX}${id}/${version}/`
  // Defense in depth: the id/version regexes already make this impossible.
  if (prefix.includes('..') || prefix.includes('\\')) {
    throw new PackRegistryError('invalid-argument', 'pack id or version would escape the content directory')
  }
  return prefix
}

/**
 * Case-fold a pack-store key for *set comparisons only*.
 *
 * Windows uses case-insensitive filesystems (NTFS), so two spellings of a path
 * can address the same physical file. When a re-imported archive renames
 * `phases/Resist.md` to `phases/resist.md`, the earlier `store.list(prefix)`
 * still reports the old casing while the write already replaced the same file.
 * Compared verbatim, the old key would look "stale" and removing it would
 * delete the file that was just written. Folding is used only to decide
 * created/overwritten/stale membership; `remove()` still receives the original
 * key returned by `store.list`.
 *
 * On a case-sensitive filesystem the error direction is the safe one: a
 * case-only rename leaves the old-cased file behind instead of deleting a file
 * that is still part of the pack.
 */
function foldPackKey(key: string): string {
  return key.toLowerCase()
}

function parseRegistry(raw: string): RegistryDocument {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch (failure) {
    throw new PackRegistryError('invalid-registry', `content/registry.json is not valid JSON: ${(failure as Error).message}`, failure)
  }
  if (!isRecord(parsed) || parsed['version'] !== 1 || !isRecord(parsed['packs'])) {
    throw new PackRegistryError('invalid-registry', 'content/registry.json does not match the registry schema (version 1)')
  }
  const packs: Record<string, RegistryPack> = {}
  for (const [id, value] of Object.entries(parsed['packs'])) {
    if (!PACK_ID_PATTERN.test(id)) {
      throw new PackRegistryError('invalid-registry', `content/registry.json: pack id "${id}" is invalid`)
    }
    if (!isRecord(value) || !isRecord(value['versions'])) {
      throw new PackRegistryError('invalid-registry', `content/registry.json: pack "${id}" is malformed`)
    }
    const versions: Record<string, RegistryVersionMeta> = {}
    for (const [version, meta] of Object.entries(value['versions'])) {
      if (!VERSION_PATTERN.test(version)) {
        throw new PackRegistryError('invalid-registry', `content/registry.json: "${id}" version "${version}" is invalid`)
      }
      if (
        !isRecord(meta) ||
        typeof meta['name'] !== 'string' ||
        (meta['mode'] !== 'freeform' && meta['mode'] !== 'scenario') ||
        (meta['rating'] !== 'all' && meta['rating'] !== '18+') ||
        typeof meta['installedAt'] !== 'string'
      ) {
        throw new PackRegistryError('invalid-registry', `content/registry.json: "${id}"@${version} metadata is malformed`)
      }
      versions[version] = {
        name: meta['name'],
        mode: meta['mode'],
        rating: meta['rating'],
        installedAt: meta['installedAt'],
      }
    }
    if (Object.keys(versions).length === 0) {
      throw new PackRegistryError('invalid-registry', `content/registry.json: pack "${id}" has no installed versions`)
    }
    const active = value['active']
    if (active !== undefined && (typeof active !== 'string' || !Object.hasOwn(versions, active))) {
      throw new PackRegistryError('invalid-registry', `content/registry.json: "${id}" has an active version that is not installed`)
    }
    packs[id] = { active: typeof active === 'string' ? active : undefined, versions }
  }
  return { version: 1, packs }
}

function serializeRegistry(document: RegistryDocument): Uint8Array {
  const packs: Record<string, unknown> = {}
  for (const id of Object.keys(document.packs).sort()) {
    const pack = document.packs[id]!
    const versions: Record<string, RegistryVersionMeta> = {}
    for (const version of Object.keys(pack.versions).sort()) versions[version] = pack.versions[version]!
    packs[id] = pack.active === undefined ? { versions } : { active: pack.active, versions }
  }
  const text = `${JSON.stringify({ version: 1, packs }, null, 2)}\n`
  return new TextEncoder().encode(text)
}

/**
 * Installed-pack registry with explicit version activation.
 *
 * @see module docs for the all-or-nothing install rule and host TODO.
 */
export class PackRegistry {
  private readonly store: PackStore
  private readonly clock: Clock
  private readonly engineVersion: string | undefined
  private readonly inflateRaw: RawInflate | undefined

  constructor(options: PackRegistryOptions) {
    this.store = options.store
    this.clock = options.clock ?? systemClock
    this.engineVersion = options.engineVersion
    this.inflateRaw = options.inflateRaw
  }

  /**
   * Validate and install a zip archive.
   *
   * **Re-importing an installed `id@version` replaces it in place.** Per the
   * product rule the import is "extract into the project's own directory,
   * overwrite files with the same name", never "refuse because it exists".
   * Concretely, in this order:
   *
   * 1. the archive is fully validated (`loadPack`) — a rejected archive touches
   *    nothing, including when it claims an already-installed `id@version`;
   * 2. every file of the new archive is written under
   *    `content/packs/<id>/<version>/`, overwriting same-named files;
   * 3. files the previous install had but the new archive does not are removed,
   *    so an updated pack can drop optional files without stale content being
   *    picked up by `load()`;
   * 4. `content/registry.json` is rewritten (fresh `installedAt`, new
   *    name/mode/rating, `activate:true` still decides the active version).
   *
   * Failure contract: validation failures never touch the store. Once writing
   * started, the rollback can only delete the keys this call *created* —
   * overwritten bytes cannot be restored (the {@link PackStore} port has no
   * backup/rename-in-place primitive) — so those keys keep the new content
   * instead of being deleted, which would leave the installed version missing
   * files. The registry is not updated on failure; importing again repairs it.
   *
   * @throws {ZipError} when the archive is unreadable/unsupported.
   * @throws {import('./loader.ts').ContentPackError} when the pack fails validation.
   * @throws {PackRegistryError} when the store fails.
   */
  async install(bytes: Uint8Array, options: InstallPackOptions = {}): Promise<InstallResult> {
    const archive = await readZip(bytes, this.inflateRaw === undefined ? {} : { inflateRaw: this.inflateRaw })
    const files = normalizeImport(archive)
    if (files.size === 0) throw new PackRegistryError('empty-pack', 'the archive contains no pack files')
    const engineVersion = options.engineVersion ?? this.engineVersion
    const loadOptions = engineVersion === undefined ? {} : { engineVersion }
    // Validate completely before touching the store: a rejected pack leaves the
    // installed version byte-for-byte untouched, and a rejected *re-import*
    // must not damage what is already installed.
    const pack = await loadPack(new MemoryContentSource(Object.fromEntries(files)), loadOptions)
    const { id, version } = pack.manifest
    validateArguments(id, version)

    const registry = await this.readRegistry()
    const existing = registry.packs[id]
    // Same id@version already installed: overwrite it instead of failing.
    const replaced = existing !== undefined && Object.hasOwn(existing.versions, version)
    const prefix = packPrefix(id, version)
    // Created/overwritten/stale membership is decided on case-folded keys, not
    // verbatim ones: on Windows the same physical file can be listed under the
    // old casing (`phases/Resist.md`) while this archive writes the new casing
    // (`phases/resist.md`). Removing the "stale" old-cased key would delete the
    // file just written. See `foldPackKey`.
    const incoming = new Set([...files.keys()].map(path => foldPackKey(`${prefix}${path}`)))

    // Read the old file set before writing (read-only, so a failure here has no
    // side effects): overwritten keys are known up front and stale keys are the
    // difference to the new archive.
    const previous = await this.listPrefix(prefix)
    const previousFolded = new Set(previous.map(foldPackKey))

    const created: string[] = []
    try {
      for (const [path, data] of files) {
        const key = `${prefix}${path}`
        await this.store.write(key, data)
        if (!previousFolded.has(foldPackKey(key))) created.push(key)
      }
    } catch (failure) {
      await this.rollback(created)
      throw new PackRegistryError('store-failure', `could not write pack files: ${(failure as Error).message}`, failure)
    }

    // Drop files this install no longer contains (the actual remove calls keep
    // the store's original casing). The writes above already completed, so an
    // interrupted cleanup still leaves a loadable superset (the registry update
    // below is what commits the new version as a whole).
    const stale = previous.filter(key => key.startsWith(prefix) && !incoming.has(foldPackKey(key)))
    try {
      for (const key of stale) await this.store.remove(key)
    } catch (failure) {
      await this.rollback(created)
      throw new PackRegistryError('store-failure', `could not remove stale pack files: ${(failure as Error).message}`, failure)
    }

    const active = options.activate === true ? version : existing?.active
    const versions: Record<string, RegistryVersionMeta> = { ...existing?.versions }
    versions[version] = {
      name: pack.manifest.name,
      mode: pack.manifest.mode,
      rating: pack.manifest.rating,
      // A re-import counts as a reinstall: the timestamp tracks the bytes that
      // are on disk now, not the first time this version was seen.
      installedAt: new Date(this.clock.now()).toISOString(),
    }
    const packs: Record<string, RegistryPack> = { ...registry.packs }
    packs[id] = { active, versions }
    try {
      await this.writeRegistry({ version: 1, packs })
    } catch (failure) {
      // Best effort, same rule as above: only files this call created are
      // removed. For a re-import that already deleted stale files the old key
      // set cannot be rebuilt either; the registry still describes the previous
      // install, so the user-facing repair is to import the archive again.
      await this.rollback(created)
      throw new PackRegistryError('store-failure', `could not update the registry: ${(failure as Error).message}`, failure)
    }

    return { id, version, active: active === version, replaced, pack }
  }

  /** Make an installed version the one the next session starts from. */
  async activate(id: string, version: string): Promise<void> {
    validateArguments(id, version)
    const registry = await this.readRegistry()
    const pack = registry.packs[id]
    if (pack === undefined) throw new PackRegistryError('not-found', `pack "${id}" is not installed`)
    if (!Object.hasOwn(pack.versions, version)) {
      throw new PackRegistryError('not-installed', `pack "${id}"@${version} is not installed`)
    }
    if (pack.active === version) return
    const packs: Record<string, RegistryPack> = { ...registry.packs, [id]: { active: version, versions: pack.versions } }
    try {
      await this.writeRegistry({ version: 1, packs })
    } catch (failure) {
      throw new PackRegistryError('store-failure', `could not update the registry: ${(failure as Error).message}`, failure)
    }
  }

  /**
   * Remove one version (or every version of the pack when omitted).
   *
   * Only `content/packs/<id>/<version>/` files and the registry entry are
   * deleted; user saves (`state/`, `memory/`) are never touched.
   */
  async uninstall(id: string, version?: string): Promise<void> {
    validateArguments(id, version)
    const registry = await this.readRegistry()
    const pack = registry.packs[id]
    if (pack === undefined) throw new PackRegistryError('not-found', `pack "${id}" is not installed`)
    let targets: readonly string[]
    if (version === undefined) {
      targets = Object.keys(pack.versions)
    } else if (Object.hasOwn(pack.versions, version)) {
      targets = [version]
    } else {
      throw new PackRegistryError('not-installed', `pack "${id}"@${version} is not installed`)
    }

    for (const target of targets) {
      let keys: readonly string[]
      try {
        keys = await this.store.list(packPrefix(id, target))
      } catch (failure) {
        throw new PackRegistryError('store-failure', `could not list pack files: ${(failure as Error).message}`, failure)
      }
      for (const key of keys) {
        try {
          await this.store.remove(key)
        } catch (failure) {
          throw new PackRegistryError('store-failure', `could not remove "${key}": ${(failure as Error).message}`, failure)
        }
      }
    }

    const packs: Record<string, RegistryPack> = { ...registry.packs }
    if (version === undefined) {
      delete packs[id]
    } else {
      const versions: Record<string, RegistryVersionMeta> = { ...pack.versions }
      delete versions[version]
      if (Object.keys(versions).length === 0) delete packs[id]
      else packs[id] = { active: pack.active === version ? undefined : pack.active, versions }
    }
    try {
      await this.writeRegistry({ version: 1, packs })
    } catch (failure) {
      throw new PackRegistryError('store-failure', `could not update the registry: ${(failure as Error).message}`, failure)
    }
  }

  /** Every installed pack id, with its versions and active version. */
  async list(): Promise<readonly PackRegistryEntry[]> {
    const registry = await this.readRegistry()
    return Object.keys(registry.packs)
      .sort()
      .map(id => {
        const pack = registry.packs[id]!
        const versions = sortVersions(Object.keys(pack.versions)).map(version => {
          const meta = pack.versions[version]!
          return {
            id,
            version,
            name: meta.name,
            mode: meta.mode,
            rating: meta.rating,
            installedAt: meta.installedAt,
            active: pack.active === version,
          }
        })
        return { id, activeVersion: pack.active, versions }
      })
  }

  /** Active version of one pack, or undefined when none is active. */
  async activeVersion(id: string): Promise<string | undefined> {
    validateArguments(id, undefined)
    const registry = await this.readRegistry()
    return registry.packs[id]?.active
  }

  /**
   * Load an installed pack.
   *
   * @param version - Defaults to the active version.
   * @throws {PackRegistryError} when the pack/version is not installed or when
   *   no version is active.
   */
  async load(id: string, version?: string): Promise<LoadedPack> {
    validateArguments(id, version)
    const registry = await this.readRegistry()
    const pack = registry.packs[id]
    if (pack === undefined) throw new PackRegistryError('not-found', `pack "${id}" is not installed`)
    const target = version ?? pack.active
    if (target === undefined) {
      throw new PackRegistryError('no-active-version', `pack "${id}" has no active version; activate one first`)
    }
    if (!Object.hasOwn(pack.versions, target)) {
      throw new PackRegistryError('not-installed', `pack "${id}"@${target} is not installed`)
    }
    const prefix = packPrefix(id, target)
    let keys: readonly string[]
    try {
      keys = await this.store.list(prefix)
    } catch (failure) {
      throw new PackRegistryError('store-failure', `could not list pack files: ${(failure as Error).message}`, failure)
    }
    if (keys.length === 0) throw new PackRegistryError('not-installed', `pack "${id}"@${target} has no files on disk`)
    const files: Record<string, Uint8Array> = {}
    for (const key of [...keys].sort()) {
      if (!key.startsWith(prefix)) continue
      const relative = key.slice(prefix.length)
      if (relative.length === 0) continue
      const data = await this.store.read(key)
      if (data === undefined) throw new PackRegistryError('store-failure', `registry references missing file "${key}"`)
      files[relative] = data
    }
    const loadOptions = this.engineVersion === undefined ? {} : { engineVersion: this.engineVersion }
    return loadPack(new MemoryContentSource(files), loadOptions)
  }

  /** `store.list` with the registry's error mapping (used before install writes). */
  private async listPrefix(prefix: string): Promise<readonly string[]> {
    try {
      return await this.store.list(prefix)
    } catch (failure) {
      throw new PackRegistryError('store-failure', `could not list pack files: ${(failure as Error).message}`, failure)
    }
  }

  private async readRegistry(): Promise<RegistryDocument> {
    let raw: Uint8Array | undefined
    try {
      raw = await this.store.read(REGISTRY_KEY)
    } catch (failure) {
      throw new PackRegistryError('store-failure', `could not read the registry: ${(failure as Error).message}`, failure)
    }
    if (raw === undefined) return emptyRegistry()
    return parseRegistry(new TextDecoder().decode(raw))
  }

  private async writeRegistry(document: RegistryDocument): Promise<void> {
    await this.store.write(REGISTRY_KEY, serializeRegistry(document))
  }

  /**
   * Best-effort removal of the keys a failed install *created*.
   *
   * Keys this call overwrote are deliberately left alone: their old bytes are
   * already gone (the store port has no way to restore them), and deleting the
   * new bytes on top would leave the installed version missing files.
   */
  private async rollback(created: readonly string[]): Promise<void> {
    for (const key of [...created].reverse()) {
      try {
        await this.store.remove(key)
      } catch {
        // Best effort: the install already failed; report the original error.
      }
    }
  }
}
