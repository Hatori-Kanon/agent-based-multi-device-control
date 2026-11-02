#!/usr/bin/env node
/**
 * Validate a content-pack folder with the repository's own loader.
 *
 *   node --experimental-transform-types tools/validate-pack.mjs <pack-folder>
 *
 * The kit deliberately reuses `packages/core/src/scenario/loader.ts` instead of
 * re-implementing the rules, so the result is byte-for-byte the same decision
 * the game will make on import. Node >= 22.7 is required for the
 * `--experimental-transform-types` flag; the .bat wrapper already passes it.
 */
import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { describePack, ensureTransformRuntime, findRepo, validateFolder } from './pack-utils.mjs'

function usage() {
  console.error('用法: node --experimental-transform-types tools/validate-pack.mjs <内容包目录>')
  console.error('示例: node --experimental-transform-types tools/validate-pack.mjs templates/freeform')
}

async function main() {
  const folderArg = process.argv[2]
  if (folderArg === undefined || folderArg === '--help' || folderArg === '-h') {
    usage()
    process.exit(folderArg === undefined ? 2 : 0)
  }
  const folder = resolve(folderArg)
  if (!existsSync(folder) || !statSync(folder).isDirectory()) {
    console.error(`不是目录: ${folder}`)
    process.exit(2)
  }
  const repo = findRepo(folder)
  if (repo === undefined) {
    console.error('找不到本项目仓库（packages/core/src/scenario/loader.ts）。')
    console.error('请在 DSH 项目仓库内运行，或设置 EMBODIED_REPO 指向仓库根目录。')
    process.exit(2)
  }

  // Running the .mjs directly without the flag would fail inside Node's type
  // stripping; transparently re-exec with the flag the .bat wrapper uses.
  ensureTransformRuntime(new URL(import.meta.url), process.argv.slice(2))

  let result
  try {
    result = await validateFolder(repo, folder)
  } catch (error) {
    if (String(error?.message ?? '').includes('TypeScript')) {
      console.error('Node 需要 --experimental-transform-types 才能加载仓库的 TS 校验器。')
      console.error('请用 tools/validate-pack.bat，或手动加上该参数（Node >= 22.7）。')
      process.exit(2)
    }
    throw error
  }

  if (!result.ok) {
    console.error('❌ 校验未通过：')
    for (const issue of result.errors) {
      console.error(`  - ${issue.file} (${issue.path}) [${issue.rule}] ${issue.message}`)
    }
    process.exit(1)
  }

  console.log('✅ 校验通过')
  console.log('')
  for (const line of describePack(result.pack)) console.log(line)
  if (result.warnings.length > 0) {
    console.log('')
    console.log(`⚠️  ${result.warnings.length} 条警告（不阻止加载，但建议处理）：`)
    for (const warning of result.warnings) console.log(`  - ${warning}`)
  }
  console.log('')
  console.log('下一步: node tools/install-pack.mjs ' + folderArg)
}

main().catch(error => {
  console.error('校验失败:', error?.stack ?? error)
  process.exit(1)
})
