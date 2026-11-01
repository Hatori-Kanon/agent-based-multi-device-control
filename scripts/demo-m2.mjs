#!/usr/bin/env node
/**
 * B2-T13 · M2 总演示（离线，`node scripts/demo-m2.mjs` 直接跑）。
 *
 * 演示不启动 Electron、不连 Intiface、不访问任何真实网络：
 * 设备是 `MockBackend`，模型是脚本化的 `DemoRunner`，时间来自 `FakeClock`，
 * 审计 / 存档 / 账本全部落在临时 dataDir 上。四个步骤对应
 * `M2-实施计划.md` §5.4 的 Demo B2 主干：
 *
 *   1. freeform 开场 + 1 回合（真实 PlayHost 回合引擎、mock 设备出动作）；
 *   2. pause / resume：暂停全停，恢复不重放上一回合；
 *   3. 人类把会话上限 X 设到 20 → 模型请求 80 也被夹到 20；
 *   4. 结束：账本多一行、快照落盘，打印路径与内容。
 *
 * 宿主实现是 TypeScript，而本脚本是 .mjs。Node 24 的 strip-only 模式不支持
 * 参数属性（`constructor(private readonly …)`），所以这里注册一个同步 load
 * hook，用 transform 模式加载 `.ts`；不需要构建步骤，也不需要额外依赖。
 */

import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// `stripTypeScriptTypes` 在 Node 24 仍标记为 experimental；演示输出不关心这条
// 提示（它不是错误）。只过滤这一条，其余 warning 仍走默认输出。
const emitWarning = process.emitWarning
process.emitWarning = (warning, ...rest) => {
  if (String(warning).includes('stripTypeScriptTypes')) return
  return emitWarning.call(process, warning, ...rest)
}

registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith('.ts')) return nextLoad(url, context)
    const source = readFileSync(fileURLToPath(url), 'utf8')
    return {
      format: 'module',
      source: stripTypeScriptTypes(source, { mode: 'transform' }),
      shortCircuit: true,
    }
  },
})

const core = await import('../packages/core/src/index.ts')
const { DirectoryPackSource, PlayHost } = await import('../apps/desktop/src/main/play.ts')
const { FileAppendOnlyStore, FileDocumentStore } = await import('../apps/desktop/src/main/node-storage.ts')

const {
  AuditLog,
  DeviceRegistry,
  FakeClock,
  MockBackend,
  PolicyStore,
  SensorRegistry,
  WaveformLibrary,
} = core

/** One scripted model turn (the demo's offline model). */
class DemoRunner {
  constructor(turns) {
    this.turns = [...turns]
    this.calls = []
  }

  async run(request) {
    this.calls.push(request)
    const turn = this.turns.shift()
    if (turn === undefined) throw new Error('DemoRunner ran out of scripted turns')
    for (const call of turn.toolCalls ?? []) request.onToolCall?.(call)
    if (turn.text !== '') request.onTextDelta?.(turn.text)
    return {
      text: turn.text,
      toolCalls: turn.toolCalls ?? [],
      finishReason: (turn.toolCalls ?? []).length > 0 ? 'tool-calls' : 'stop',
    }
  }
}

/** Wrap `apply_plan` arguments exactly as the wire format carries them. */
function planCall(arguments_) {
  return { id: 'call_demo', name: 'apply_plan', arguments: arguments_ }
}

async function readAudit(dataDir) {
  const raw = await readFile(join(dataDir, 'audit', 'device.jsonl'), 'utf8')
  return raw.split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line))
}

function lastPlan(records) {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (records[index].action === 'plan_resolved') return records[index]
  }
  throw new Error('no plan_resolved record in the audit log')
}

function activeEffects(registry) {
  return registry.snapshot().devices
    .flatMap(device => device.channels)
    .filter(channel => channel.effect !== undefined).length
}

function channelPercent(registry, deviceId, channelId) {
  const device = registry.snapshot().devices.find(candidate => candidate.id === deviceId)
  return device?.channels.find(channel => channel.id === channelId)?.percent ?? 0
}

async function main() {
  const dataDir = await mkdtemp(join(tmpdir(), 'embodied-m2-demo-'))
  // The fixture pack is the same one the acceptance suite installs.
  const fixtureDir = fileURLToPath(new URL('../apps/desktop/tests/fixtures/m2/pack-freeform/', import.meta.url))
  const packDir = join(dataDir, 'content', 'packs', 'demo', '1.0.0')
  await mkdir(packDir, { recursive: true })
  for (const name of ['pack.json', 'persona.md', 'setting.md']) {
    await writeFile(join(packDir, name), await readFile(join(fixtureDir, name), 'utf8'))
  }

  const clock = new FakeClock(Date.UTC(2026, 10, 1, 20, 0, 0))
  const documents = new FileDocumentStore(join(dataDir, 'state'))
  const ledgerPath = join(dataDir, 'memory', 'ledger.jsonl')
  const audit = new AuditLog(
    new FileAppendOnlyStore(join(dataDir, 'audit', 'device.jsonl')),
    clock,
    error => { console.error('[audit]', error instanceof Error ? error.message : String(error)) },
  )
  const policy = new PolicyStore()
  const waveforms = new WaveformLibrary()
  const registry = new DeviceRegistry({ clock, audit, policy, waveforms, onError: () => {} })
  registry.register(new MockBackend({
    id: 'mock-pulse',
    name: 'Mock Pulse Box',
    clock,
    keepAliveMs: 400,
    refreshMs: 100,
    channels: [
      { id: 'a', kind: 'level', label: 'A 通道' },
      { id: 'b', kind: 'level', label: 'B 通道' },
    ],
  }))
  await registry.connect('mock-pulse', new AbortController().signal)

  const runner = new DemoRunner([
    {
      // 1) opening turn: a low probe.
      text: '（台灯下）他停了一下，才伸手。',
      toolCalls: [planCall({
        pacing: 'probe',
        beats: [{
          id: 'b1',
          intentId: 'probe-touch',
          regions: ['whole-body'],
          strength: 'low',
          targets: [{ deviceId: 'mock-pulse', channelId: 'a' }],
        }],
      })],
    },
    {
      // 3) the model asks for 80 while X is 20.
      text: '（他放轻了动作）这次，慢慢来。',
      toolCalls: [planCall({
        pacing: 'build',
        beats: [{
          id: 'b1',
          intentId: 'escalate-step',
          regions: ['whole-body'],
          strength: 'high',
          change: { kind: 'level', targetPercent: 80, durationSec: 5 },
          targets: [{ deviceId: 'mock-pulse', channelId: 'a' }],
        }],
      })],
    },
    { text: '（备用台词，本演示不会用到。）', toolCalls: [] },
  ])

  const host = new PlayHost({
    clock,
    audit,
    registry,
    policy,
    waveforms,
    sensors: new SensorRegistry({ clock }),
    runner,
    savePolicy: async () => {
      await documents.write('policy', JSON.stringify(policy.snapshot(), null, 2))
    },
    archive: {
      state: documents,
      memory: new FileDocumentStore(join(dataDir, 'memory')),
      ledger: new FileAppendOnlyStore(ledgerPath),
      ledgerText: async () => {
        try {
          return await readFile(ledgerPath, 'utf8')
        } catch {
          return undefined
        }
      },
    },
    packs: new DirectoryPackSource(dataDir),
    onEvent: () => {},
  })

  console.log('M2 demo · B2-T13（离线）')
  console.log(`dataDir: ${dataDir}`)
  console.log('gate: MockBackend + scripted model runner + FakeClock; no network, no Electron\n')

  // ── 1/4 ────────────────────────────────────────────────────────────────
  const opening = await host.start({ packId: 'demo', plannedMinutes: 30 })
  const firstPlan = lastPlan(await readAudit(dataDir))
  console.log('[1/4] freeform 开场 + 1 回合')
  console.log(`  state=${opening.state} turn=${opening.turnId} phase=${opening.phase} remainingMin=${opening.remainingMin}`)
  console.log(`  line=${opening.lastLine}`)
  console.log(`  plan_resolved actions=${firstPlan.detail.actions.map(action =>
    `${action.beatId}→${action.deviceId}:${action.channelId} ${action.percent}%`).join(' | ')}`)
  console.log(`  device mock-pulse/a percent=${channelPercent(registry, 'mock-pulse', 'a')}`)

  // ── 2/4 ────────────────────────────────────────────────────────────────
  const effectsBefore = activeEffects(registry)
  const paused = await host.pause()
  const effectsAfter = activeEffects(registry)
  const resumed = await host.resume()
  console.log('\n[2/4] pause / resume')
  console.log(`  paused state=${paused.state}; active effects ${effectsBefore} → ${effectsAfter}（全停）`)
  console.log(`  resumed state=${resumed.state}; modelCalls=${runner.calls.length}（不重放上一回合）`)

  // ── 3/4 ────────────────────────────────────────────────────────────────
  // Human path only (v3 semantics): the channel owns an interval [10, 60] and a
  // frequency band [40, 120]; the session ceiling then narrows the top of that
  // interval to 25. The model still writes a relative percentage, so 80% of the
  // effective interval lands at 10 + 0.8 * (25 - 10) = 22.
  await registry.setPolicyByHuman('mock-pulse', 'a', { minPercent: 10, maxPercent: 60, minFreq: 40, maxFreq: 120 })
  await documents.write('policy', JSON.stringify(policy.snapshot(), null, 2))
  await host.setCeiling(25)
  const clamped = await host.message('继续。')
  const clampPlan = lastPlan(await readAudit(dataDir))
  const action = clampPlan.detail.actions[0]
  const effective = policy.effective('mock-pulse', 'a')
  const expected = Math.round(effective.minPercent + 0.8 * (effective.maxPercent - effective.minPercent))
  console.log('\n[3/4] 人类设通道范围 10–60%（频率 40–120），会话上限 X=25')
  console.log(`  effective interval = [${effective.minPercent}, ${effective.maxPercent}]（ceiling 收窄上限）`)
  console.log(`  model asked targetPercent=80（相对量）→ dispatched ${action.percent}% status=${action.status}`)
  console.log(`  session turn=${clamped.turnId}; mock-pulse/a percent=${channelPercent(registry, 'mock-pulse', 'a')}`)
  if (action.percent !== expected || action.percent < effective.minPercent || action.percent > effective.maxPercent) {
    throw new Error(`the interval mapping is wrong: ${JSON.stringify({ action, effective, expected })}`)
  }

  // ── 4/4 ────────────────────────────────────────────────────────────────
  const ended = await host.end('completed')
  const ledgerLines = (await readFile(ledgerPath, 'utf8')).trim().split('\n').filter(line => line !== '')
  const ledgerLine = ledgerLines.at(-1)
  const snapshotPath = join(dataDir, 'state', `session-${ended.sessionId}.json`)
  const archived = JSON.parse(await readFile(snapshotPath, 'utf8'))
  console.log('\n[4/4] 结束 / 账本 / 快照')
  console.log(`  state=${ended.state} turn=${ended.turnId}`)
  console.log(`  snapshot: ${snapshotPath}`)
  console.log(`    status=${archived.status} phase=${archived.currentPhase} turn=${archived.turn} lastLine=${archived.lastLine}`)
  console.log(`  ledger (${ledgerLines.length} line): ${ledgerLine}`)
  console.log('\ndone: 4 steps passed.')

  host.dispose()
  await registry.shutdown()
}

try {
  await main()
} catch (error) {
  console.error('\ndemo failed:', error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
}
