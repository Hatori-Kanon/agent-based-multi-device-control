/**
 * B2-T13 — M2 端到端总验收（M2 的第一个可玩版本）。
 *
 * 六个 `it` 覆盖 `M2-实施计划.md` §3.4 B2-T13 与 §2 的 M2-B2 出口条件：
 *
 * 1. 一局 8 回合：fixture LLM 的 `apply_plan` + 文本经真实 HTTP 路由
 *    (`POST /api/session/message`) 驱动；审计 JSONL 能重建命令时间线；
 * 2. 一局一快照 + 一行账本，`endReason` 正确；
 * 3. 崩溃恢复：残留 active 快照 + ledger open 标记 → `recovered` +
 *    一行 `unexpected_exit`，且不重放旧回合的设备命令；
 * 4. 跨会话 `metaReactions`：第二局开场 brief 进入首回合 system prompt；
 * 5. 会话上限 X：通道 cap 40、X 20 → 模型请求 100 也只派发 20 且审计
 *    `clamped`；人类把 X 降到 10 后下一条命令 ≤10；
 * 6. 门禁：全程 fixture fetch（无真实网络）、无 Electron。
 *
 * 与 `play.spec.ts` 共用既有模式：真实 `createHostRuntime` + mock 设备 +
 * 脚本化 `llmFetch` + 临时 dataDir；这里只走 HTTP 路由，不 import 生产代码
 * 的内部状态（崩溃恢复用例除外：它按 §4.7.2 直接造残留存档/账本）。
 */

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  FakeClock,
  SessionLedger,
  SessionStore,
  type AuditRecord,
  type FetchLike,
} from '@embodied/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHostRuntime, type HostRuntime } from '../src/main/bootstrap.ts'
import { FileAppendOnlyStore, FileDocumentStore } from '../src/main/node-storage.ts'

// ── Fixtures ───────────────────────────────────────────────────────────────

/** One scripted model turn: prose + the `apply_plan` arguments. */
interface ScriptedTurn {
  readonly text: string
  readonly plan?: Record<string, unknown>
}

/** One model call the fixture gateway received, request body included. */
interface RecordedCall {
  readonly url: string
  readonly body: Record<string, unknown>
}

/**
 * Offline model boundary: hands out scripted completions and records the
 * requests so the tests can assert which prompt the model actually saw.
 *
 * It satisfies `FetchLike` directly — no socket, no provider, no clock.
 */
class FixtureGateway {
  readonly calls: RecordedCall[] = []
  private readonly turns: ScriptedTurn[]

  constructor(turns: readonly ScriptedTurn[]) {
    this.turns = [...turns]
  }

  readonly fetch: FetchLike = async (url, init) => {
    const raw = (init as { readonly body?: string } | undefined)?.body
    const body = raw === undefined ? {} : JSON.parse(raw) as Record<string, unknown>
    this.calls.push({ url, body })
    const turn = this.turns.shift()
    if (turn === undefined) throw new Error('the fixture gateway ran out of scripted turns')
    return {
      ok: true,
      status: 200,
      json: async (): Promise<unknown> => completionOf(turn, this.calls.length),
    }
  }
}

/** One OpenAI-compatible aggregate completion (the transport accepts it). */
function completionOf(turn: ScriptedTurn, index: number): unknown {
  const toolCalls = turn.plan === undefined
    ? []
    : [{
        id: `call_${index}`,
        type: 'function',
        function: { name: 'apply_plan', arguments: JSON.stringify(turn.plan) },
      }]
  return {
    id: `chatcmpl-fixture-${index}`,
    object: 'chat.completion',
    choices: [{
      index: 0,
      finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
      message: {
        role: 'assistant',
        content: turn.text,
        ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
      },
    }],
  }
}

/** Messages the host sent to the model on one call. */
function messagesOf(call: RecordedCall): readonly { readonly role: string; readonly content: string }[] {
  const messages = call.body['messages']
  return Array.isArray(messages)
    ? messages as { readonly role: string; readonly content: string }[]
    : []
}

/** The system prompt of one call (always the first message). */
function systemPromptOf(call: RecordedCall): string {
  const system = messagesOf(call).find(message => message.role === 'system')
  return system?.content ?? ''
}

/**
 * A plan that produces one `set_level` (b1) followed by one `run_pattern` (b2).
 *
 * Both beats name explicit targets, so the resolver never depends on region
 * fallback and the command order is exactly the plan order.
 */
function twoBeatPlan(): Record<string, unknown> {
  return {
    pacing: 'probe',
    beats: [
      {
        id: 'b1',
        intentId: 'escalate-step',
        regions: ['whole-body'],
        strength: 'high',
        targets: [{ deviceId: 'mock-pulse', channelId: 'a' }],
      },
      {
        id: 'b2',
        intentId: 'probe-touch',
        regions: ['whole-body'],
        strength: 'low',
        targets: [{ deviceId: 'mock-pulse', channelId: 'b' }],
      },
    ],
  }
}

/** One level beat whose absolute request (100) must be clamped by policy. */
function clampedPlan(): Record<string, unknown> {
  return {
    pacing: 'build',
    beats: [{
      id: 'b1',
      intentId: 'escalate-step',
      regions: ['whole-body'],
      strength: 'high',
      change: { kind: 'level', targetPercent: 100, durationSec: 5 },
      targets: [{ deviceId: 'mock-pulse', channelId: 'a' }],
    }],
  }
}

/** A minimal single-beat plan for harness tests that do not inspect commands. */
function simplePlan(): Record<string, unknown> {
  return {
    pacing: 'probe',
    beats: [{
      id: 'b1',
      intentId: 'probe-touch',
      regions: ['whole-body'],
      strength: 'low',
      targets: [{ deviceId: 'mock-pulse', channelId: 'a' }],
    }],
  }
}

// ── Test harness ───────────────────────────────────────────────────────────

const TEST_LLM = {
  default: { provider: 'fixture', model: 'fixture-model', baseUrl: 'http://fixture.invalid/v1' },
  director: null,
  writer: null,
} as const

/** Copy one fixture pack into `<dataDir>/content/packs/demo/1.0.0/`. */
async function installPack(
  root: string,
  fixture: 'pack-freeform' | 'pack-history' = 'pack-freeform',
): Promise<void> {
  const source = fileURLToPath(new URL(`./fixtures/m2/${fixture}/`, import.meta.url))
  const target = join(root, 'content', 'packs', 'demo', '1.0.0')
  await mkdir(target, { recursive: true })
  for (const name of ['pack.json', 'persona.md', 'setting.md']) {
    await writeFile(join(target, name), await readFile(join(source, name), 'utf8'))
  }
}

/** Real host runtime over a temp data directory, two mock devices connected. */
async function bootRuntime(
  root: string,
  gateway: FixtureGateway,
  clock: FakeClock = new FakeClock(),
): Promise<HostRuntime> {
  const runtime = await createHostRuntime({
    dataDir: root,
    clock,
    withPanicServer: false,
    withButtplug: false,
    llmConfig: TEST_LLM,
    llmEnv: { EMBODIED_LLM_API_KEY: 'test-key' },
    llmFetch: gateway.fetch,
  })
  await runtime.registry.connect('mock-pulse', new AbortController().signal)
  await runtime.registry.connect('mock-hold', new AbortController().signal)
  return runtime
}

/** Tiny typed client around the dashboard token. */
interface Client {
  get(path: string): Promise<Response>
  post(path: string, body: unknown): Promise<Response>
  body<T>(response: Response): Promise<T>
}

function clientOf(runtime: HostRuntime): Client {
  const address = runtime.dashboardAddress
  if (address === undefined) throw new Error('the runtime must expose the dashboard for this test')
  const base = `http://${address.host}:${address.port}`
  const headers = { 'x-control-token': runtime.dashboardToken, 'Content-Type': 'application/json' }
  return {
    get: async path => await fetch(`${base}${path}`, {
      headers: { 'x-control-token': runtime.dashboardToken },
    }),
    post: async (path, body) => await fetch(`${base}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }),
    body: async <T>(response: Response): Promise<T> => await response.json() as T,
  }
}

/** The audit JSONL as parsed records (append order preserved). */
async function readAudit(root: string): Promise<AuditRecord[]> {
  try {
    const raw = await readFile(join(root, 'audit', 'device.jsonl'), 'utf8')
    return raw.split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line) as AuditRecord)
  } catch {
    return []
  }
}

/** `memory/ledger.jsonl` as parsed lines. */
async function readLedger(root: string): Promise<Record<string, unknown>[]> {
  try {
    const raw = await readFile(join(root, 'memory', 'ledger.jsonl'), 'utf8')
    return raw.split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line) as Record<string, unknown>)
  } catch {
    return []
  }
}

/** One archived session snapshot, parsed. */
async function readSnapshot(root: string, sessionId: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(root, 'state', `session-${sessionId}.json`), 'utf8')) as Record<string, unknown>
}

interface TimelineCommand {
  readonly beatId: string
  readonly kind: 'set_level' | 'run_pattern'
  readonly deviceId: string
  readonly channelId: string
  readonly percent?: number
}

interface TimelineTurn {
  readonly turnId: number
  readonly commands: readonly TimelineCommand[]
}

/**
 * Rebuild the per-turn beat → command timeline from the audit JSONL alone.
 *
 * The executor dispatches first and records `plan_resolved` last, so the
 * registry's own `set_level`/`run_pattern` records *precede* the plan that
 * caused them. Replay pairs the pending command block with the `actions` list
 * of the next `plan_resolved` (both are in the same resolved-command order)
 * and takes the beat id from the plan side and the command kind from the
 * registry side. Nothing outside the two record families is read.
 */
function replayTimeline(records: readonly AuditRecord[]): TimelineTurn[] {
  const timeline: TimelineTurn[] = []
  let pending: AuditRecord[] = []
  for (const record of records) {
    if (record.action === 'set_level' || record.action === 'run_pattern') {
      pending.push(record)
      continue
    }
    if (record.action !== 'plan_resolved') continue
    const detail = (record.detail ?? {}) as Record<string, unknown>
    const actions = Array.isArray(detail['actions']) ? detail['actions'] as PlanAction[] : []
    // A `rejected` action never reaches the registry, so it has no command
    // record; every accepted action must have exactly one.
    const accepted = actions.filter(action => action.status !== 'rejected')
    if (accepted.length !== pending.length) {
      throw new Error(
        `turn ${String(detail['turnId'])} has ${accepted.length} accepted actions but ${pending.length} commands`,
      )
    }
    const commands = accepted.map((action, index): TimelineCommand => {
      const raw = pending[index]!
      const commandDetail = (raw.detail ?? {}) as Record<string, unknown>
      const envelope = commandDetail['envelope'] as { readonly maxPercent?: unknown } | undefined
      const percent = raw.action === 'set_level'
        ? (typeof commandDetail['percent'] === 'number' ? commandDetail['percent'] : undefined)
        : (typeof envelope?.maxPercent === 'number' ? envelope.maxPercent : undefined)
      return {
        beatId: action.beatId,
        kind: raw.action as 'set_level' | 'run_pattern',
        deviceId: typeof commandDetail['deviceId'] === 'string' ? commandDetail['deviceId'] : '',
        channelId: typeof commandDetail['channelId'] === 'string' ? commandDetail['channelId'] : '',
        ...(percent === undefined ? {} : { percent }),
      }
    })
    pending = []
    timeline.push({
      turnId: typeof detail['turnId'] === 'number' ? detail['turnId'] : 0,
      commands,
    })
  }
  return timeline
}

/** The most recent `plan_resolved` actions, as the audit stored them. */
interface PlanAction {
  readonly beatId: string
  readonly deviceId: string
  readonly channelId: string
  readonly status: 'dispatched' | 'clamped' | 'degraded' | 'rejected'
  readonly percent?: number
}

function lastPlanActions(records: readonly AuditRecord[]): readonly PlanAction[] {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]!
    if (record.action !== 'plan_resolved') continue
    const actions = (record.detail as { readonly actions?: readonly PlanAction[] } | undefined)?.actions
    return actions ?? []
  }
  return []
}

/** Audit `detail.turnId` of a record, when it has one. */
function turnIdOf(record: AuditRecord): number | undefined {
  const detail = record.detail as { readonly turnId?: unknown } | undefined
  return typeof detail?.turnId === 'number' ? detail.turnId : undefined
}

// ── Suite ──────────────────────────────────────────────────────────────────

describe('M2 end-to-end acceptance (B2-T13)', () => {
  let root: string
  let runtime: HostRuntime | undefined

  beforeEach(async () => {
    await mkdir(join(process.cwd(), '.test-tmp'), { recursive: true })
    root = await mkdtemp(join(process.cwd(), '.test-tmp', 'm2-e2e-'))
  })

  afterEach(async () => {
    await runtime?.shutdown()
    runtime = undefined
    await rm(root, { recursive: true, force: true })
  })

  it('plays eight turns end to end and rebuilds the command timeline from the audit log', async () => {
    await installPack(root)
    const lines = Array.from({ length: 8 }, (_, index) => `第 ${index + 1} 句台词。`)
    const gateway = new FixtureGateway(lines.map(text => ({ text, plan: twoBeatPlan() })))
    runtime = await bootRuntime(root, gateway)
    const client = clientOf(runtime)

    const startResponse = await client.post('/api/session/start', { packId: 'demo', plannedMinutes: 30 })
    expect(startResponse.status).toBe(200)
    const opening = await client.body<{ state: string; turnId: number; phase: string; lastLine?: string }>(startResponse)
    expect(opening).toMatchObject({ state: 'idle', turnId: 1, phase: 'scene', lastLine: lines[0] })

    // 8 turns total: the opening turn + 7 player messages.
    const turnIds: number[] = [opening.turnId]
    for (let turn = 2; turn <= 8; turn += 1) {
      const response = await client.post('/api/session/message', { text: `玩家的第 ${turn} 句话。` })
      expect(response.status).toBe(200)
      const snapshot = await client.body<{ turnId: number; lastLine?: string }>(response)
      expect(snapshot.turnId).toBe(turn)
      expect(snapshot.lastLine).toBe(lines[turn - 1])
      // The live snapshot (GET /api/session) follows the same counter.
      const live = await client.get('/api/session')
      expect(live.status).toBe(200)
      expect(await client.body<{ turnId: number }>(live)).toMatchObject({ turnId: turn })
      turnIds.push(snapshot.turnId)
    }
    expect(turnIds).toEqual([1, 2, 3, 4, 5, 6, 7, 8])

    const lastSnapshot = await client.get('/api/session')
    expect(lastSnapshot.status).toBe(200)
    expect(await client.body<{ turnId: number; phase: string }>(lastSnapshot)).toMatchObject({
      turnId: 8,
      phase: 'scene',
    })

    // Every settled line is in the transcript, in order.
    const transcriptResponse = await client.get('/api/session/transcript')
    const transcript = (await client.body<{ transcript: readonly { turnId: number; text: string }[] }>(
      transcriptResponse,
    )).transcript
    expect(transcript.map(entry => entry.turnId)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(transcript.map(entry => entry.text)).toEqual(lines)

    // Eight turn_completed records, one per turn, in order.
    const records = await readAudit(root)
    const completed = records.filter(record => record.action === 'turn_completed')
    expect(completed).toHaveLength(8)
    expect(completed.map(turnIdOf)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])

    // The audit JSONL alone rebuilds the beat → command timeline.
    const timeline = replayTimeline(records)
    expect(timeline.map(turn => turn.turnId)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    for (const turn of timeline) {
      expect(turn.commands.map(command => `${command.beatId}:${command.kind}`))
        .toEqual(['b1:set_level', 'b2:run_pattern'])
      expect(turn.commands.map(command => `${command.deviceId}:${command.channelId}`))
        .toEqual(['mock-pulse:a', 'mock-pulse:b'])
      // Default channel cap is 20 (D4), so high↔20 and low↔8.
      expect(turn.commands.every(command =>
        command.percent !== undefined && command.percent > 0 && command.percent <= 20)).toBe(true)
    }
    expect(gateway.calls).toHaveLength(8)
  })

  it('writes exactly one ledger line and one state snapshot when the session ends', async () => {
    await installPack(root)
    const gateway = new FixtureGateway([
      { text: '第一句。', plan: twoBeatPlan() },
      { text: '第二句。', plan: twoBeatPlan() },
    ])
    runtime = await bootRuntime(root, gateway)
    const client = clientOf(runtime)

    const startResponse = await client.post('/api/session/start', { packId: 'demo', plannedMinutes: 30 })
    expect(startResponse.status).toBe(200)
    const started = await client.body<{ sessionId: string }>(startResponse)
    expect(started.sessionId).not.toBe('')

    const messaged = await client.post('/api/session/message', { text: '嗯。' })
    expect(messaged.status).toBe(200)
    expect(await client.body<{ turnId: number }>(messaged)).toMatchObject({ turnId: 2 })

    // No ledger line while the session is open: the line is the ended fact.
    expect(await readLedger(root)).toEqual([])

    const ended = await client.post('/api/session/end', { reason: 'completed' })
    expect(ended.status).toBe(200)
    expect(await client.body<{ state: string }>(ended)).toMatchObject({ state: 'ended' })

    // Exactly one snapshot per session, with the phase the engine actually ran.
    const stateDir = join(root, 'state')
    const snapshots = (await readdir(stateDir))
      .filter(name => /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/.test(name))
    expect(snapshots).toEqual([`session-${started.sessionId}.json`])
    expect(await readSnapshot(root, started.sessionId)).toMatchObject({
      sessionId: started.sessionId,
      packId: 'demo',
      currentPhase: 'scene',
      turn: 2,
      status: 'ended',
      lastLine: '第二句。',
    })

    // Exactly one ledger line, facts only, with the ended reason.
    const ledger = await readLedger(root)
    expect(ledger).toHaveLength(1)
    const line = ledger[0]!
    expect(line).toMatchObject({
      sessionId: started.sessionId,
      pack: 'demo',
      endReason: 'completed',
      plannedMin: 30,
      actualMin: 0,
      phaseReached: 'scene',
      aftercare: false,
    })
    expect(line['maxCapUsed']).toBeGreaterThan(0)
    expect(Object.keys(line)).toHaveLength(10)

    // A duplicated end must not append a second line for the same session.
    expect((await client.post('/api/session/end', { reason: 'completed' })).status).toBe(200)
    expect(await readLedger(root)).toHaveLength(1)
  })

  it('does not replay an unfinished turn after a crash restart', async () => {
    await installPack(root)
    // A fixed epoch so the fabricated snapshot's timeline is exact.
    const base = Date.UTC(2026, 10, 1, 20, 0, 0)
    const clock = new FakeClock(base)

    // Residue of a process that died mid-session: one active snapshot and a
    // ledger open marker, both written through the real core stores.
    const stateDocuments = new FileDocumentStore(join(root, 'state'))
    const store = new SessionStore({ documents: stateDocuments, clock })
    const opened = await store.open({
      sessionId: 'crashed-session',
      packId: 'demo',
      phase: 'scene',
      startedAt: base,
    })
    await store.save({
      ...opened,
      turn: 7,
      elapsedMin: 18,
      lastLine: '上一局最后一句。',
      recentBeats: ['probe-touch'],
      flags: {},
      learned: [],
    })
    const ledger = new SessionLedger({
      store: new FileAppendOnlyStore(join(root, 'memory', 'ledger.jsonl')),
      documents: new FileDocumentStore(join(root, 'memory')),
      clock,
    })
    await ledger.open('crashed-session', { pack: 'demo', plannedMin: 30 })
    // The crash happened 20 minutes after the last settled snapshot.
    clock.advance(20 * 60_000)

    const gateway = new FixtureGateway([{ text: '重新开始。', plan: clampedPlan() }])
    runtime = await bootRuntime(root, gateway, clock)
    const client = clientOf(runtime)
    const response = await client.post('/api/session/start', { packId: 'demo', plannedMinutes: 20 })
    expect(response.status).toBe(200)
    const started = await client.body<{ sessionId: string; turnId: number }>(response)
    expect(started.turnId).toBe(1)
    expect(started.sessionId).not.toBe('crashed-session')

    // The leftover snapshot is relabelled, never resumed.
    expect(await readSnapshot(root, 'crashed-session')).toMatchObject({
      sessionId: 'crashed-session',
      status: 'recovered',
      turn: 7,
      currentPhase: 'scene',
    })
    // The new session opened its own snapshot at turn 1.
    expect(await readSnapshot(root, started.sessionId)).toMatchObject({
      sessionId: started.sessionId,
      status: 'active',
      turn: 1,
    })

    // Exactly one added ledger line, the crash fact, derived from the last
    // settled snapshot (startedAt + elapsedMin = 18 min), not from "now".
    const ledgerLines = await readLedger(root)
    expect(ledgerLines).toHaveLength(1)
    expect(ledgerLines[0]).toMatchObject({
      sessionId: 'crashed-session',
      pack: 'demo',
      endReason: 'unexpected_exit',
      plannedMin: 30,
      actualMin: 18,
      phaseReached: 'scene',
      aftercare: false,
      maxCapUsed: 0,
    })
    // The open marker now belongs to the new session, so a later crash names it.
    const marker = JSON.parse(await readFile(join(root, 'memory', 'open.json'), 'utf8')) as { sessionId: string }
    expect(marker.sessionId).toBe(started.sessionId)

    // No replay: the old turn number never appears in this process's audit, and
    // the only execution records are the new opening turn's single command.
    const records = await readAudit(root)
    expect(records.filter(record => turnIdOf(record) === 7)).toEqual([])
    const restartedTurns = records.filter(record =>
      record.action === 'turn_started' || record.action === 'turn_completed' || record.action === 'plan_resolved')
    expect(restartedTurns.every(record => turnIdOf(record) === 1)).toBe(true)
    expect(records.filter(record => record.action === 'turn_completed')).toHaveLength(1)
    expect(records.filter(record => record.action === 'plan_resolved')).toHaveLength(1)
    expect(records.filter(record => record.action === 'set_level' || record.action === 'run_pattern'))
      .toHaveLength(1)
    expect(gateway.calls).toHaveLength(1)

    // Neither the last line nor the transcript of the crashed session leaks
    // into the restarted one: only this process's opening turn exists.
    expect(systemPromptOf(gateway.calls[0]!)).not.toContain('上一局最后一句。')
    const transcript = (await client.body<{ transcript: readonly { text: string }[] }>(
      await client.get('/api/session/transcript'),
    )).transcript
    expect(transcript.map(entry => entry.text)).toEqual(['重新开始。'])
  })

  it('injects the matched cross-session metaReactions brief into the next opening prompt', async () => {
    await installPack(root, 'pack-history')
    const clock = new FakeClock(Date.UTC(2026, 10, 1, 20, 0, 0))

    // First session: ends left_early, so its line matches the pack's rule.
    const firstGateway = new FixtureGateway([{ text: '冷。', plan: simplePlan() }])
    const firstRuntime = await bootRuntime(root, firstGateway, clock)
    try {
      const firstClient = clientOf(firstRuntime)
      expect((await firstClient.post('/api/session/start', { packId: 'demo', plannedMinutes: 45 })).status).toBe(200)
      expect(systemPromptOf(firstGateway.calls[0]!)).not.toContain('开场指引')
      expect((await firstClient.post('/api/session/end', { reason: 'left_early' })).status).toBe(200)
    } finally {
      await firstRuntime.shutdown()
    }
    const firstLedger = await readLedger(root)
    expect(firstLedger).toHaveLength(1)
    expect(firstLedger[0]).toMatchObject({ endReason: 'left_early' })

    clock.advance(60 * 60_000)

    // Second session in a fresh process: the ledger line becomes a tone brief
    // in the first turn's system prompt (the model need not act on it).
    const secondGateway = new FixtureGateway([{ text: '你回来了。', plan: simplePlan() }])
    runtime = await bootRuntime(root, secondGateway, clock)
    const secondClient = clientOf(runtime)
    expect((await secondClient.post('/api/session/start', { packId: 'demo', plannedMinutes: 45 })).status).toBe(200)

    const system = systemPromptOf(secondGateway.calls[0]!)
    expect(system).toContain('开场指引')
    expect(system).toContain('cold')
    expect(system).toContain('soothe')
    // The brief is a first-turn fact only; it did not itself write a ledger
    // line. Ending the second session appends its own line.
    expect(await readLedger(root)).toHaveLength(1)
    expect((await secondClient.post('/api/session/end', { reason: 'stop' })).status).toBe(200)
    expect(await readLedger(root)).toHaveLength(2)
  })

  it('keeps the human session ceiling below the channel cap and clamps beyond it', async () => {
    await installPack(root)
    const gateway = new FixtureGateway([
      { text: '想再进一步。', plan: clampedPlan() },
      { text: '这次慢一点。', plan: clampedPlan() },
    ])
    runtime = await bootRuntime(root, gateway)
    const client = clientOf(runtime)

    // Channel cap is the human's hard bound for this channel: 40.
    const capResponse = await client.post('/api/cap', {
      deviceId: 'mock-pulse',
      channelId: 'a',
      patch: { maxPercent: 40 },
    })
    expect(capResponse.status).toBe(200)

    // The human opens the session with consent ceiling X = 20.
    const startResponse = await client.post('/api/session/start', {
      packId: 'demo',
      plannedMinutes: 30,
      ceilingPercent: 20,
    })
    expect(startResponse.status).toBe(200)

    const afterStart = await readAudit(root)
    const firstActions = lastPlanActions(afterStart)
    expect(firstActions).toHaveLength(1)
    // v3: the model writes a *relative* percentage. 100% maps onto the channel
    // interval [0, 40], and the session ceiling then binds it at 20. The clamp
    // is not a resolver "clamped" flag any more — it is visible in the applied
    // percent (audit + dispatch status), which is what the human guards.
    expect(firstActions[0]!.percent).toBe(20)
    expect(firstActions[0]!.percent).toBeLessThanOrEqual(20)

    const policyAfterStart = JSON.parse(await readFile(join(root, 'state', 'policy.json'), 'utf8')) as {
      sessionCeiling: number
    }
    expect(policyAfterStart.sessionCeiling).toBe(20)
    // Effective = min(channel cap 40, X 20); the raw cap stays the human's 40.
    expect(runtime.policy.get('mock-pulse', 'a').maxPercent).toBe(40)
    expect(runtime.policy.effective('mock-pulse', 'a').maxPercent).toBe(20)

    // Lowering X to 10 must bind the very next command, with a clamp record.
    const lowered = await client.post('/api/session/ceiling', { percent: 10 })
    expect(lowered.status).toBe(200)
    const message = await client.post('/api/session/message', { text: '继续。' })
    expect(message.status).toBe(200)

    const afterMessage = await readAudit(root)
    const secondActions = lastPlanActions(afterMessage)
    expect(secondActions).toHaveLength(1)
    expect(secondActions[0]!.percent).toBe(10)
    expect(secondActions[0]!.percent).toBeLessThanOrEqual(10)
    expect(runtime.policy.effective('mock-pulse', 'a').maxPercent).toBe(10)

    const dispatchedPercents = afterMessage
      .filter(record => record.action === 'set_level')
      .map(record => (record.detail as { readonly percent?: number } | undefined)?.percent)
    expect(dispatchedPercents).toEqual([20, 10])

    const ceilingChange = [...afterMessage].reverse().find(record =>
      record.action === 'policy_change'
      && (record.detail as { readonly scope?: string } | undefined)?.scope === 'session')
    expect(ceilingChange).toMatchObject({ actor: 'human', detail: { scope: 'session', previous: 20, next: 10 } })
    expect((await readFile(join(root, 'state', 'policy.json'), 'utf8')).length).toBeGreaterThan(0)
  })

  it('stays offline and never boots Electron for the whole acceptance path', async () => {
    await installPack(root)
    const gateway = new FixtureGateway([
      { text: '第一句。', plan: simplePlan() },
      { text: '第二句。', plan: simplePlan() },
      { text: '第三句。', plan: simplePlan() },
    ])
    const observed: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      observed.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      return await originalFetch(input, init)
    }) as typeof fetch

    try {
      runtime = await bootRuntime(root, gateway)
      const client = clientOf(runtime)
      expect((await client.post('/api/session/start', { packId: 'demo', plannedMinutes: 20 })).status).toBe(200)
      expect((await client.post('/api/session/message', { text: '嗯。' })).status).toBe(200)

      // The model boundary is the injected fixture: calls happened, and every
      // one addressed an un-routable fixture host (no provider socket).
      expect(gateway.calls.length).toBeGreaterThan(0)
      expect(gateway.calls.every(call => new URL(call.url).hostname === 'fixture.invalid')).toBe(true)
      expect(TEST_LLM.default.baseUrl).toBe('http://fixture.invalid/v1')

      // The only sockets the host opened are the loopback control API the test
      // itself drives; no external host was ever contacted.
      expect(observed.length).toBeGreaterThan(0)
      expect(observed.every(url => new URL(url).hostname === '127.0.0.1')).toBe(true)

      // No Electron process/module, no Intiface probe, no panic listener.
      expect(process.versions.electron).toBeUndefined()
      expect(runtime.intiface.availability).toBe('unavailable')
      expect(runtime.panicAddress).toBeUndefined()

      // A second runtime with the dashboard disabled proves the model/engine
      // path itself opens no socket: the only global-fetch observer stays empty
      // while the fixture gateway still serves the turn.
      const fetchedBefore = observed.length
      const callsBefore = gateway.calls.length
      await runtime.shutdown()
      runtime = await createHostRuntime({
        dataDir: root,
        clock: new FakeClock(),
        withPanicServer: false,
        withDashboard: false,
        withButtplug: false,
        llmConfig: TEST_LLM,
        llmEnv: { EMBODIED_LLM_API_KEY: 'test-key' },
        llmFetch: gateway.fetch,
      })
      await runtime.registry.connect('mock-pulse', new AbortController().signal)
      expect(runtime.dashboardAddress).toBeUndefined()
      const offline = await runtime.play.start({ packId: 'demo', plannedMinutes: 20 })
      expect(offline.turnId).toBe(1)
      expect(gateway.calls.length).toBe(callsBefore + 1)
      expect(observed.length).toBe(fetchedBefore)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
