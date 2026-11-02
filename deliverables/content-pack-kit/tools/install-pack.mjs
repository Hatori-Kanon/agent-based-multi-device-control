#!/usr/bin/env node
/**
 * Validate + zip + install a content pack through the console's HTTP API.
 *
 *   node tools/install-pack.mjs <pack-folder>
 *   node tools/install-pack.mjs templates/scenario --data-dir "E:/embodied-data"
 *   node tools/install-pack.mjs my-pack --url http://127.0.0.1:12345 --token <token>
 *   node tools/install-pack.mjs --list
 *   node tools/install-pack.mjs my-pack --zip my-pack.zip   # 只打包，不上传
 *
 * The console API requires the control token. The installer discovers
 * `<dataDir>/state/dashboard.json` automatically (EMBODIED_DATA_DIR, the repo's
 * `.dev-data`, and Electron's app-data folders), newest first.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import {
  collectFiles,
  createZip,
  describePack,
  discoverDashboards,
  ensureTransformRuntime,
  findRepo,
  validateFolder,
} from './pack-utils.mjs'

const HELP = `用法:
  node tools/install-pack.mjs <内容包目录或 .zip> [选项]
  node tools/install-pack.mjs --list [选项]

选项:
  --url <http://host:port>   控制台地址（默认自动发现）
  --token <token>            控制台 token（默认从 dataDir/state/dashboard.json 读取）
  --data-dir <path>          数据目录（默认: EMBODIED_DATA_DIR / 仓库 .dev-data / Electron app data）
  --zip <out.zip>            只生成 zip，不上传
  --list                     列出已安装内容包
  --activate <id@version>    切换 active 版本（导入会默认激活新版本）
  --no-validate              跳过仓库校验器的预检（不推荐）
  -h, --help                 显示帮助
`

function parseArgs(argv) {
  const options = { list: false, noValidate: false, positional: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--list') options.list = true
    else if (arg === '--no-validate') options.noValidate = true
    else if (arg === '--url') options.url = argv[++index]
    else if (arg === '--token') options.token = argv[++index]
    else if (arg === '--data-dir') options.dataDir = argv[++index]
    else if (arg === '--zip') options.zipOut = argv[++index]
    else if (arg === '--activate') options.activate = argv[++index]
    else if (arg.startsWith('--')) {
      console.error(`未知选项: ${arg}`)
      process.exit(2)
    } else options.positional.push(arg)
  }
  return options
}

async function basicPreflight(folder) {
  const manifestPath = resolve(folder, 'pack.json')
  if (!existsSync(manifestPath)) return { ok: false, errors: [`缺少 pack.json: ${manifestPath}`] }
  try {
    JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch (error) {
    return { ok: false, errors: [`pack.json 不是合法 JSON: ${error.message}`] }
  }
  const personaPath = resolve(folder, 'persona.md')
  if (!existsSync(personaPath)) return { ok: false, errors: [`缺少 persona.md: ${personaPath}`] }
  return { ok: true, errors: [] }
}

function resolveEndpoint(options) {
  if (options.url !== undefined && options.token !== undefined) {
    return { url: options.url.replace(/\/+$/u, ''), token: options.token, source: '命令行参数' }
  }
  const candidates = discoverDashboards()
  if (options.dataDir !== undefined) {
    const wanted = resolve(options.dataDir).toLowerCase()
    const ordered = [
      ...candidates.filter(candidate => candidate.dataDir.toLowerCase() === wanted),
      ...candidates.filter(candidate => candidate.dataDir.toLowerCase() !== wanted),
    ]
    candidates.splice(0, candidates.length, ...ordered)
  }
  const found = candidates[0]
  if (found === undefined) {
    console.error('找不到正在运行的控制台（没有 state/dashboard.json）。')
    console.error('请先启动控制台（start.bat / start-dev.bat），或用 --url 和 --token 指定。')
    process.exit(2)
  }
  if (candidates.length > 1 && options.dataDir === undefined) {
    console.log(`发现 ${candidates.length} 个控制台数据目录，使用最新写入的：`)
    for (const candidate of candidates.slice(0, 5)) {
      console.log(`  - ${candidate.dataDir}  ${candidate.url}`)
    }
    console.log('  可用 --data-dir 指定其它目录。')
  }
  return { url: found.url, token: found.token, source: found.dataDir }
}

async function api(url, token, path, init = {}) {
  const response = await fetch(`${url}${path}`, {
    ...init,
    signal: AbortSignal.timeout(30_000),
    headers: {
      'x-control-token': token,
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/zip' }),
      ...(init.headers ?? {}),
    },
  })
  const text = await response.text()
  let body = undefined
  try {
    body = text === '' ? undefined : JSON.parse(text)
  } catch {
    body = undefined
  }
  if (!response.ok) {
    const message = body?.error ?? text.slice(0, 400) ?? `HTTP ${response.status}`
    const error = new Error(`${path} -> HTTP ${response.status}: ${message}`)
    error.body = body
    throw error
  }
  return body
}

function printPacks(packs) {
  if (!Array.isArray(packs) || packs.length === 0) {
    console.log('（还没有安装任何内容包）')
    return
  }
  for (const pack of packs) {
    const active = pack.activeVersion ?? '（无 active 版本）'
    const versions = Array.isArray(pack.versions)
      ? pack.versions.map(version => version.version + (version.active ? '*' : '')).join(', ')
      : ''
    console.log(`- ${pack.id}  active=${active}  versions=${versions}`)
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(HELP)
    return
  }
  const endpoint = resolveEndpoint(options)

  if (options.list) {
    const body = await api(endpoint.url, endpoint.token, '/api/packs')
    console.log(`控制台: ${endpoint.url}（token 来自 ${endpoint.source}）`)
    printPacks(body?.packs)
    return
  }

  if (options.activate !== undefined) {
    const [id, version] = String(options.activate).split('@')
    if (!id || !version) {
      console.error('--activate 需要 id@version，例如 lighthouse-night@0.1.0')
      process.exit(2)
    }
    const body = await api(endpoint.url, endpoint.token, '/api/packs/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, version }),
    })
    console.log(`已激活 ${id}@${version}`)
    printPacks(body?.packs)
    return
  }

  const input = options.positional[0]
  if (input === undefined) {
    console.error(HELP)
    process.exit(2)
  }
  const target = resolve(input)
  if (!existsSync(target)) {
    console.error(`路径不存在: ${target}`)
    process.exit(2)
  }

  let zipBytes
  if (statSync(target).isDirectory()) {
    const repo = findRepo(target)
    if (!options.noValidate) {
      if (repo === undefined) {
        console.warn('⚠️  找不到项目仓库，跳过仓库校验器；只做基础检查。')
        const basic = await basicPreflight(target)
        if (!basic.ok) {
          console.error('❌ ' + basic.errors.join('\n'))
          process.exit(1)
        }
      } else {
        ensureTransformRuntime(new URL(import.meta.url), process.argv.slice(2))
        const result = await validateFolder(repo, target)
        if (!result.ok) {
          console.error('❌ 校验未通过，未上传：')
          for (const issue of result.errors) {
            console.error(`  - ${issue.file} (${issue.path}) [${issue.rule}] ${issue.message}`)
          }
          process.exit(1)
        }
        console.log('✅ 校验通过')
        for (const line of describePack(result.pack)) console.log('  ' + line)
        if (result.warnings.length > 0) {
          console.log(`  ⚠️ ${result.warnings.length} 条警告：`)
          for (const warning of result.warnings) console.log('    - ' + warning)
        }
      }
    } else {
      const basic = await basicPreflight(target)
      if (!basic.ok) {
        console.error('❌ ' + basic.errors.join('\n'))
        process.exit(1)
      }
    }
    const files = await collectFiles(target)
    const total = files.reduce((sum, file) => sum + file.bytes.length, 0)
    if (files.length > 2048 || total > 50 * 1024 * 1024) {
      console.error('❌ 内容包超过限制（2048 个文件 / 50MB）。')
      process.exit(1)
    }
    zipBytes = createZip(files)
    console.log(`已打包 ${files.length} 个文件（${(total / 1024).toFixed(1)} KiB，未压缩）`)
  } else {
    if (!target.toLowerCase().endsWith('.zip')) {
      console.error('输入必须是内容包目录或 .zip 文件。')
      process.exit(2)
    }
    zipBytes = new Uint8Array(await readFile(target))
    console.log(`读取 zip: ${basename(target)}（${(zipBytes.length / 1024).toFixed(1)} KiB）`)
  }

  if (options.zipOut !== undefined) {
    await writeFile(options.zipOut, zipBytes)
    console.log(`已写入 ${resolve(options.zipOut)}（可在控制台 API 手动上传）`)
    return
  }

  console.log(`上传到 ${endpoint.url}（token 来自 ${endpoint.source}）`)
  try {
    const body = await api(endpoint.url, endpoint.token, '/api/packs/import', {
      method: 'POST',
      body: zipBytes,
    })
    const pack = body?.pack
    if (pack !== undefined) {
      console.log(`✅ 已安装并激活 ${pack.id}@${pack.version}`)
    } else {
      console.log('✅ 已导入')
    }
    console.log('已安装内容包：')
    printPacks(body?.packs)
    console.log('')
    console.log('下一步：打开控制台 "游玩" 视图，在「内容包」下拉里选择它并点「开局」。')
  } catch (error) {
    console.error('❌ ' + (error?.message ?? String(error)))
    console.error('提示：确认控制台正在运行、token 正确，且内容包通过校验（先跑 validate-pack）。')
    process.exit(1)
  }
}

main().catch(error => {
  console.error('安装失败:', error?.stack ?? error)
  process.exit(1)
})
