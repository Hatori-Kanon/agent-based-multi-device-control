/**
 * Content-pack kit helpers (Node >= 22.19, no dependencies).
 *
 * - findRepo() locates this DSH checkout so the kit can reuse the repository's
 *   authoritative validator instead of re-implementing the rules.
 * - DirContentSource exposes a folder as the loader's ContentSource port.
 * - createZip() writes a minimal store-method ZIP the server can import.
 * - discoverDashboards() finds <dataDir>/state/dashboard.json so the installer
 *   can talk to a running console without copy-pasting the token.
 */
import { spawnSync } from 'node:child_process'
import { readFile, readdir, stat } from 'node:fs/promises'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Walk up from `start` looking for `packages/core/src/scenario/loader.ts`. */
export function findRepo(start = process.cwd()) {
  const explicit = process.env.EMBODIED_REPO
  if (explicit !== undefined && existsSync(join(explicit, 'packages/core/src/scenario/loader.ts'))) {
    return resolve(explicit)
  }
  const visit = dir => {
    if (existsSync(join(dir, 'packages/core/src/scenario/loader.ts'))) return dir
    return undefined
  }
  for (const origin of [start, HERE]) {
    let current = resolve(origin)
    for (;;) {
      const found = visit(current)
      if (found !== undefined) return found
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }
  }
  return undefined
}

/**
 * Re-run the calling script with `--experimental-transform-types` when the flag
 * is missing. The kit imports the repository's TypeScript loader, and Node's
 * type stripping alone cannot load it (parameter properties are used), so a
 * plain `node tools/validate-pack.mjs ...` would otherwise fail with a cryptic
 * message. Relaunching keeps the simple command working.
 *
 * @param {URL} callerUrl - `new URL(import.meta.url)` of the calling script.
 * @param {readonly string[]} argv - the caller's `process.argv.slice(2)`.
 */
export function ensureTransformRuntime(callerUrl, argv) {
  if (process.execArgv.some(arg => arg.includes('experimental-transform-types'))) return
  const child = spawnSync(
    process.execPath,
    ['--no-warnings', '--experimental-transform-types', fileURLToPath(callerUrl), ...argv],
    { stdio: 'inherit' },
  )
  process.exit(child.status ?? 1)
}

/** Load the repository's real loadPack (needs --experimental-transform-types). */
export async function loadRepoLoader(repo) {
  const url = pathToFileURL(join(repo, 'packages/core/src/scenario/loader.ts')).href
  return import(url)
}

/** A folder exposed as a ContentSource: POSIX relative paths, no symlink following. */
export class DirContentSource {
  constructor(root) {
    this.root = resolve(root)
  }

  async files() {
    const out = []
    const walk = async (absolute, prefix) => {
      const entries = await readdir(absolute, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.name === '.DS_Store' || entry.name === 'Thumbs.db' || entry.name === '__MACOSX') continue
        const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
        const full = join(absolute, entry.name)
        if (entry.isSymbolicLink()) continue
        if (entry.isDirectory()) await walk(full, relative)
        else if (entry.isFile()) out.push(relative)
      }
    }
    await walk(this.root, '')
    return out.sort()
  }

  async list() {
    return this.files()
  }

  async readBytes(path) {
    return new Uint8Array(await readFile(this.absolute(path)))
  }

  async readText(path) {
    return new TextDecoder().decode(await this.readBytes(path))
  }

  async byteSize(path) {
    return (await stat(this.absolute(path))).size
  }

  absolute(path) {
    const segments = path.split('/')
    if (path.length === 0 || path.startsWith('/') || path.includes('\\') || segments.some(s => s === '' || s === '.' || s === '..')) {
      throw new Error(`unsafe pack-relative path: ${JSON.stringify(path)}`)
    }
    const target = join(this.root, ...segments)
    if (!target.startsWith(this.root + sep)) throw new Error(`path escapes pack root: ${path}`)
    return target
  }
}

/** Validate a folder with the repository loader. */
export async function validateFolder(repo, folder) {
  const loader = await loadRepoLoader(repo)
  const source = new DirContentSource(folder)
  try {
    const pack = await loader.loadPack(source)
    return { ok: true, errors: [], warnings: [...pack.warnings], pack }
  } catch (error) {
    const issues = Array.isArray(error?.issues) ? error.issues : []
    const mapped = issues.length > 0
      ? issues.map(issue => ({ file: issue.file, path: issue.path, message: issue.message, rule: issue.rule }))
      : [{ file: error?.file ?? '?', path: error?.path ?? '.', message: error?.message ?? String(error), rule: 'error' }]
    // The validator can report the same missing-file rule twice (files pass +
    // scenario pass); one line is enough for an author.
    const seen = new Set()
    const errors = []
    for (const issue of mapped) {
      const key = `${issue.file}|${issue.path}|${issue.rule}|${issue.message}`
      if (seen.has(key)) continue
      seen.add(key)
      errors.push(issue)
    }
    return { ok: false, errors, warnings: [], pack: undefined }
  }
}

/** Compact pack summary lines for the CLI. */
export function describePack(pack) {
  const scenario = pack.scenario
  const lines = []
  lines.push(`id        ${pack.manifest.id}`)
  lines.push(`名称      ${pack.manifest.name}`)
  lines.push(`版本      ${pack.manifest.version}`)
  lines.push(`模式      ${pack.manifest.mode}`)
  lines.push(`分级      ${pack.manifest.rating}`)
  lines.push(`引擎      ${pack.manifest.engine}`)
  if (scenario !== undefined) {
    lines.push(`阶段      ${scenario.phases.map(phase => phase.id).join(' -> ')}`)
    lines.push(`部位      ${scenario.regions.map(region => region.id + '(' + region.label + ')').join('、') || '（无）'}`)
    lines.push(`意图      ${scenario.feedbackIntents.map(intent => intent.id).join('、') || '（无）'}`)
  } else {
    lines.push('阶段      自由沙盒（引擎默认意图表）')
  }
  if (pack.waveforms.length > 0) lines.push(`波形      ${pack.waveforms.map(waveform => waveform.id).join('、')}`)
  return lines
}

// ── ZIP (store only) ────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) !== 0 ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1)
    table[index] = value >>> 0
  }
  return table
})()

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff]
  return (crc ^ 0xffffffff) >>> 0
}

/** Collect [{name, bytes}] from a folder (the loader rejects bad extensions itself). */
export async function collectFiles(folder) {
  const source = new DirContentSource(folder)
  const relative = await source.files()
  const files = []
  for (const name of relative) files.push({ name, bytes: await source.readBytes(name) })
  return files
}

/** Build a store-method ZIP (UTF-8 names); accepted by the console importer. */
export function createZip(files) {
  const encoder = new TextEncoder()
  const localParts = []
  const centralParts = []
  let offset = 0
  for (const file of files) {
    const nameBytes = encoder.encode(file.name)
    const data = file.bytes
    const crc = crc32(data)
    const local = new Uint8Array(30 + nameBytes.length + data.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(6, 0x0800, true)
    lv.setUint16(8, 0, true)
    lv.setUint16(10, 0, true)
    lv.setUint16(12, 0, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, data.length, true)
    lv.setUint32(22, data.length, true)
    lv.setUint16(26, nameBytes.length, true)
    lv.setUint16(28, 0, true)
    local.set(nameBytes, 30)
    local.set(data, 30 + nameBytes.length)
    localParts.push(local)

    const central = new Uint8Array(46 + nameBytes.length)
    const cv = new DataView(central.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint16(8, 0x0800, true)
    cv.setUint16(10, 0, true)
    cv.setUint16(12, 0, true)
    cv.setUint16(14, 0, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, data.length, true)
    cv.setUint32(24, data.length, true)
    cv.setUint16(28, nameBytes.length, true)
    cv.setUint16(30, 0, true)
    cv.setUint16(32, 0, true)
    cv.setUint16(34, 0, true)
    cv.setUint16(36, 0, true)
    cv.setUint32(38, 0, true)
    cv.setUint32(42, offset, true)
    central.set(nameBytes, 46)
    centralParts.push(central)
    offset += local.length
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0)
  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, files.length, true)
  ev.setUint16(10, files.length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, offset, true)
  const total = offset + centralSize + eocd.length
  const out = new Uint8Array(total)
  let cursor = 0
  for (const part of localParts) { out.set(part, cursor); cursor += part.length }
  for (const part of centralParts) { out.set(part, cursor); cursor += part.length }
  out.set(eocd, cursor)
  return out
}

// ── Dashboard discovery ─────────────────────────────────────────────────────

function scanForDataDirs(root) {
  const found = []
  const read = (dir, depth) => {
    if (depth > 2) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const child = join(dir, entry.name)
      for (const candidate of [child, join(child, 'embodied')]) {
        if (existsSync(join(candidate, 'state', 'dashboard.json'))) found.push(candidate)
      }
      read(child, depth + 1)
    }
  }
  read(root, 0)
  return found
}

function candidateRoots() {
  const roots = []
  const explicit = process.env.EMBODIED_DATA_DIR
  if (explicit !== undefined && explicit.trim() !== '') roots.push(resolve(explicit))
  const repo = findRepo()
  if (repo !== undefined) roots.push(join(repo, '.dev-data'))
  const appData = process.env.APPDATA
  if (appData !== undefined) roots.push(...scanForDataDirs(appData))
  const localAppData = process.env.LOCALAPPDATA
  if (localAppData !== undefined && localAppData !== appData) roots.push(...scanForDataDirs(localAppData))
  roots.push(join(homedir(), 'Library', 'Application Support'))
  roots.push(join(homedir(), '.config'))
  return roots
}

/** Every usable { dataDir, url, token }, newest first. */
export function discoverDashboards() {
  const seen = new Set()
  const found = []
  for (const dataDir of candidateRoots()) {
    const file = join(dataDir, 'state', 'dashboard.json')
    if (seen.has(file) || !existsSync(file)) continue
    seen.add(file)
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      const host = parsed?.host ?? '127.0.0.1'
      const port = parsed?.port
      const token = parsed?.token
      if (typeof port !== 'number' || typeof token !== 'string') continue
      let mtimeMs = 0
      try {
        mtimeMs = statSync(file).mtimeMs
      } catch {
        mtimeMs = 0
      }
      found.push({ dataDir: resolve(dataDir), url: `http://${host}:${port}`, token, mtimeMs })
    } catch {
      // A corrupt dashboard.json is not usable; keep scanning.
    }
  }
  found.sort((left, right) => right.mtimeMs - left.mtimeMs)
  return found
}
