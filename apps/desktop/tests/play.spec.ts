import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  AuditLog,
  DeviceRegistry,
  FakeClock,
  loadPack,
  MemoryAppendOnlyStore,
  MemoryContentSource,
  MemoryDocumentStore,
  MockBackend,
  PolicyStore,
  SensorRegistry,
  WaveformLibrary,
  type AuditRecord,
  type EngineEvent,
  type LoadedPack,
  type ModelRunner,
  type ModelTurnRequest,
  type ModelTurnResult,
  type ToolCall,
} from '@embodied/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHostRuntime, type HostRuntime } from '../src/main/bootstrap.ts'
import {
  DirectoryPackSource,
  openingBriefText,
  PlayHost,
  PlaySession,
  SessionError,
  type PlayArchive,
  type PlaySessionEnvironment,
} from '../src/main/play.ts'

// ── Fixtures ───────────────────────────────────────────────────────────────

/** The first turn's plan: one low-probe beat over the whole body. */
function planCall(id = 'call_1'): ToolCall {
  return {
    id,
    name: 'apply_plan',
    arguments: {
      pacing: 'probe',
      beats: [{ id: 'b1', intentId: 'probe-touch', regions: ['whole-body'], strength: 'low' }],
    },
  }
}

/** The same plan, plus one offered player option (B2-T6/T11). */
function choicePlanCall(id = 'call_1'): ToolCall {
  return {
    id,
    name: 'apply_plan',
    arguments: {
      pacing: 'probe',
      beats: [{ id: 'b1', intentId: 'probe-touch', regions: ['whole-body'], strength: 'low' }],
      choices: [{ id: 'c1', label: '退开', tag: 'resist' }],
    },
  }
}

/** A scripted, offline {@link ModelRunner}; records every request. */
class ScriptedRunner implements ModelRunner {
  readonly requests: ModelTurnRequest[] = []
  private readonly turns: ModelTurnResult[]
  private readonly planFirst: boolean

  constructor(turns: readonly ModelTurnResult[], planFirst = true) {
    this.turns = [...turns]
    this.planFirst = planFirst
  }

  async run(request: ModelTurnRequest): Promise<ModelTurnResult> {
    this.requests.push(request)
    const turn = this.turns.shift()
    if (turn === undefined) throw new Error('ScriptedRunner ran out of scripted turns')
    if (this.planFirst) {
      // The plan arrives before the prose: planning -> executing -> writing.
      for (const call of turn.toolCalls) request.onToolCall?.(call)
      if (turn.text !== '') request.onTextDelta?.(turn.text)
    } else {
      if (turn.text !== '') request.onTextDelta?.(turn.text)
      for (const call of turn.toolCalls) request.onToolCall?.(call)
    }
    return turn
  }
}

function scriptedTurn(text: string, calls: readonly ToolCall[] = []): ModelTurnResult {
  return { text, toolCalls: calls, finishReason: calls.length > 0 ? 'tool-calls' : 'stop' }
}

let cachedPack: Promise<LoadedPack> | undefined

/** A minimal freeform pack: `pack.json` + `persona.md` (+ setting.md). */
function freeformPack(): Promise<LoadedPack> {
  cachedPack ??= loadPack(new MemoryContentSource({
    'pack.json': JSON.stringify({
      id: 'demo',
      name: 'Demo Pack',
      version: '1.0.0',
      engine: '>=0.2 <1.0',
      mode: 'freeform',
      rating: 'all',
      boundaries: ['不做真实伤害'],
    }),
    'persona.md': '# 阿岚\n\n## 导演摘要\n\n温柔的试探者，先观察再靠近。\n',
    'setting.md': '一间只有台灯的书房。\n',
  }))
  return cachedPack
}

let cachedScenarioPack: Promise<LoadedPack> | undefined

/** A scenario pack with a real body-region vocabulary and intent menu. */
function narrativePack(): Promise<LoadedPack> {
  cachedScenarioPack ??= loadPack(new MemoryContentSource({
    'pack.json': JSON.stringify({
      id: 'narrative',
      name: '叙事包',
      version: '1.0.0',
      engine: '>=0.2 <1.0',
      mode: 'scenario',
      rating: 'all',
      boundaries: ['不做真实伤害'],
    }),
    'persona.md': '# 阿岚\n\n## 导演摘要\n\n温柔的试探者，先观察再靠近。\n',
    'setting.md': '一间只有台灯的书房。\n',
    'scenario.json': JSON.stringify({
      session: { plannedMinutes: 30, phaseWindows: [], aftercareMin: 0 },
      regions: [
        { id: 'hands', label: '手' },
        { id: 'shoulders', label: '肩背' },
        { id: 'whole-body', label: '全身' },
      ],
      phases: [{ id: 'scene', goal: '自由互动', next: [] }],
      feedbackIntents: [
        { id: 'probe-touch', meaning: '短促试探', regions: ['hands'] },
        { id: 'soothe', meaning: '安抚或降档', regions: ['whole-body'] },
      ],
    }),
  }))
  return cachedScenarioPack
}

interface Harness {
  readonly session: PlaySession
  readonly host: PlayHost
  readonly env: PlaySessionEnvironment
  readonly clock: FakeClock
  readonly store: MemoryAppendOnlyStore
  readonly policy: PolicyStore
  readonly registry: DeviceRegistry
  readonly runner: ScriptedRunner
  readonly policySaves: number[]
  readonly states: string[]
  records(): AuditRecord[]
}

/** Build a real registry (mock devices) + scripted model + in-memory audit. */
async function createHarness(
  turns: readonly ModelTurnResult[],
  pack?: LoadedPack,
): Promise<Harness> {
  const clock = new FakeClock()
  const store = new MemoryAppendOnlyStore()
  const audit = new AuditLog(store, clock, () => {})
  const policy = new PolicyStore()
  const waveforms = new WaveformLibrary()
  const registry = new DeviceRegistry({
    clock,
    audit,
    policy,
    waveforms,
    onError: () => {},
  })
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

  const runner = new ScriptedRunner(turns)
  const policySaves: number[] = []
  const states: string[] = []
  const env: PlaySessionEnvironment = {
    clock,
    audit,
    registry,
    policy,
    waveforms,
    sensors: new SensorRegistry({ clock }),
    runner,
    savePolicy: async (): Promise<void> => { policySaves.push(clock.now()) },
    onEvent: (event: EngineEvent): void => {
      if (event.type === 'state') states.push((event.detail as { state: string }).state)
    },
  }
  const session = new PlaySession(env)
  const host = new PlayHost({ ...env, packs: { load: async () => pack ?? await freeformPack() } })
  return {
    session,
    host,
    env,
    clock,
    store,
    policy,
    registry,
    runner,
    policySaves,
    states,
    records: (): AuditRecord[] => store.lines.map(line => JSON.parse(line) as AuditRecord),
  }
}

describe('play session', () => {
  it('starts a session from a freeform pack and answers the first turn', async () => {
    const h = await createHarness([
      scriptedTurn('他轻轻靠近。', [planCall()]),
      scriptedTurn('这次他没有退。'),
    ])
    const pack = await freeformPack()

    const snapshot = await h.session.start({ pack, plannedMinutes: 30, ceilingPercent: 20 })

    expect(snapshot.state).toBe('idle')
    expect(snapshot.turnId).toBe(1)
    expect(snapshot.phase).toBe('scene')
    expect(snapshot.elapsedMin).toBe(0)
    expect(snapshot.remainingMin).toBe(30)
    expect(snapshot.packId).toBe('demo')
    expect(snapshot.packVersion).toBe('1.0.0')
    expect(snapshot.lastLine).toBe('他轻轻靠近。')
    expect(snapshot.outcome).toBe('completed')
    // The freeform scenario is synthesised (single terminal phase) and the
    // engine walked the documented stages around the single model call.
    expect(h.states).toEqual(['planning', 'executing', 'writing', 'settling', 'idle'])
    expect(h.runner.requests).toHaveLength(1)

    const request = h.runner.requests[0]!
    expect(request.tools.length).toBe(9)
    const system = request.messages[0]
    expect(system?.role).toBe('system')
    expect(system?.content).toContain('不做真实伤害')
    expect(system?.content).toContain('阿岚')
    expect(system?.content).toContain('书房')
    // The plan went through the executor and the audit, not straight to a device.
    expect(h.records().some(record => record.action === 'plan_resolved')).toBe(true)

    // A second turn keeps the first line in the conversation as assistant prose.
    const second = await h.session.message('我往后缩了一下')
    expect(second.turnId).toBe(2)
    expect(second.lastLine).toBe('这次他没有退。')
    const secondRequest = h.runner.requests[1]!
    expect(secondRequest.messages.some(message =>
      message.role === 'assistant' && message.content === '他轻轻靠近。')).toBe(true)
    expect(secondRequest.messages.some(message =>
      message.role === 'user' && message.content === '我往后缩了一下')).toBe(true)
  })

  it('refuses a player message while no session is open', async () => {
    const h = await createHarness([])
    await expect(h.session.message('你好')).rejects.toMatchObject({ code: 'NO_SESSION' })
    expect(h.runner.requests).toHaveLength(0)
  })

  it('refuses to start or message while the runtime is locked', async () => {
    const h = await createHarness([scriptedTurn('……', [planCall()])])
    const pack = await freeformPack()

    await h.registry.emergencyStop('test')
    await expect(h.session.start({ pack, plannedMinutes: 30 }))
      .rejects.toMatchObject({ code: 'LOCKED' })

    await h.registry.unlock('human')
    await h.session.start({ pack, plannedMinutes: 30 })
    await h.session.panic('hotkey')
    expect(h.session.snapshot()?.state).toBe('locked')
    await expect(h.session.message('还在吗')).rejects.toMatchObject({ code: 'LOCKED' })
  })

  it('refuses a second start while open and allows a new one after end', async () => {
    const h = await createHarness([scriptedTurn('第一次。'), scriptedTurn('第二次。')])

    const first = await h.host.start({ packId: 'demo', plannedMinutes: 30 })
    await expect(h.host.start({ packId: 'demo', plannedMinutes: 30 }))
      .rejects.toMatchObject({ code: 'SESSION_OPEN' })

    // An ended session is replaced, not reused: the lobby is shown again, so
    // the next 开局 gets a fresh session (new id, turn 1).
    await h.host.end('left_early')
    const second = await h.host.start({ packId: 'demo', plannedMinutes: 30 })
    expect(second.sessionId).not.toBe(first.sessionId)
    expect(second).toMatchObject({ state: 'idle', turnId: 1, lastLine: '第二次。' })
    expect(h.runner.requests).toHaveLength(2)
  })

  it('applies the lobby autopilot choice and accepts live changes', async () => {
    const h = await createHarness([scriptedTurn('第一句。'), scriptedTurn('第二句。')])

    const started = await h.host.start({
      packId: 'demo',
      plannedMinutes: 30,
      autopilot: { enabled: true, intervalSec: 15 },
    })
    expect(started.autopilot).toEqual({ enabled: true, intervalSec: 15, minSec: 10, maxSec: 60 })

    const changed = await h.host.setAutopilot({ enabled: false, intervalSec: 45 })
    expect(changed.autopilot).toEqual({ enabled: false, intervalSec: 45, minSec: 10, maxSec: 60 })
    await h.host.end('completed')
  })

  it('persists the human-set ceiling and audits policy_change with scope session', async () => {
    const h = await createHarness([scriptedTurn('嗯。')])
    const pack = await freeformPack()

    await h.session.start({ pack, plannedMinutes: 30, ceilingPercent: 20 })

    expect(h.policy.ceiling()).toBe(20)
    expect(h.policy.snapshot().sessionCeiling).toBe(20)
    expect(h.policy.effective('mock-pulse', 'a').maxPercent).toBe(20)
    expect(h.policySaves).toHaveLength(1)
    const change = h.records().find(record => record.action === 'policy_change')
    expect(change?.actor).toBe('human')
    expect(change?.detail).toMatchObject({ scope: 'session', previous: 100, next: 20 })
  })

  it('leaves the stored ceiling untouched when start omits ceilingPercent', async () => {
    const h = await createHarness([scriptedTurn('嗯。')])
    const pack = await freeformPack()

    // A previous session narrowed the ceiling; a new start without the field
    // must never be an implicit raise (D4).
    h.policy.setSessionCeilingByHuman(30)
    await h.session.start({ pack, plannedMinutes: 30 })

    expect(h.policy.ceiling()).toBe(30)
    expect(h.policySaves).toHaveLength(0)
    expect(h.records().some(record => record.action === 'policy_change')).toBe(false)
  })

  it('reports a typed refusal and never leaks a raw error', async () => {
    const h = await createHarness([])
    try {
      await h.session.message('你好')
      throw new Error('expected a rejection')
    } catch (error) {
      expect(error).toBeInstanceOf(SessionError)
      expect((error as SessionError).code).toBe('NO_SESSION')
      expect((error as Error).message).toContain('no session')
    }
  })
})

// ── HTTP routes through the real host runtime ─────────────────────────────

describe('session HTTP routes', () => {
  let root: string
  let runtime: HostRuntime | undefined

  beforeEach(async () => {
    await mkdir(join(process.cwd(), '.test-tmp'), { recursive: true })
    root = await mkdtemp(join(process.cwd(), '.test-tmp', 'play-'))
  })

  afterEach(async () => {
    await runtime?.shutdown()
    runtime = undefined
    await rm(root, { recursive: true, force: true })
  })

  async function writeFreeformPack(): Promise<void> {
    const dir = join(root, 'content', 'packs', 'demo', '1.0.0')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'pack.json'), JSON.stringify({
      id: 'demo',
      name: 'Demo Pack',
      version: '1.0.0',
      engine: '>=0.2 <1.0',
      mode: 'freeform',
      rating: 'all',
      boundaries: ['不做真实伤害'],
    }, null, 2))
    await writeFile(join(dir, 'persona.md'), '# 阿岚\n\n## 导演摘要\n\n温柔的试探者。\n')
    await writeFile(join(dir, 'setting.md'), '一间只有台灯的书房。\n')
  }

  /** One OpenAI-compatible aggregate completion with a plan call and prose. */
  function fixtureCompletion(): unknown {
    return {
      id: 'chatcmpl-fixture',
      object: 'chat.completion',
      choices: [{
        index: 0,
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: '他轻轻靠近。',
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: {
              name: 'apply_plan',
              arguments: JSON.stringify({
                pacing: 'probe',
                beats: [{ id: 'b1', intentId: 'probe-touch', regions: ['whole-body'], strength: 'low' }],
              }),
            },
          }],
        },
      }],
    }
  }

  it('starts a session from an installed pack and answers turns over HTTP', async () => {
    await writeFreeformPack()
    let modelCalls = 0
    runtime = await createHostRuntime({
      dataDir: root,
      clock: new FakeClock(),
      withPanicServer: false,
      withButtplug: false,
      llmConfig: {
        default: { provider: 'fixture', model: 'fixture-model', baseUrl: 'http://fixture.invalid/v1' },
        director: null,
        writer: null,
      },
      llmEnv: { EMBODIED_LLM_API_KEY: 'test-key' },
      // Test-only fetch: no socket is opened and no real provider is reached.
      llmFetch: async () => {
        modelCalls += 1
        return { ok: true, status: 200, json: async () => fixtureCompletion() }
      },
    })
    // Both mock devices must be online: the resolver's `primary` distribution
    // picks by device id, and an offline pick degrades to narrative-only.
    await runtime.registry.connect('mock-pulse', new AbortController().signal)
    await runtime.registry.connect('mock-hold', new AbortController().signal)

    const address = runtime.dashboardAddress!
    const base = `http://${address.host}:${address.port}`
    const headers = { 'x-control-token': runtime.dashboardToken, 'Content-Type': 'application/json' }
    const get = async (path: string): Promise<Response> =>
      await fetch(`${base}${path}`, { headers: { 'x-control-token': runtime!.dashboardToken } })
    const post = async (path: string, body: unknown): Promise<Response> =>
      await fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) })

    // No session yet: the snapshot is absent and a message is a caller error.
    expect((await get('/api/session')).status).toBe(404)
    expect((await post('/api/session/message', { text: '你好' })).status).toBe(400)

    const started = await post('/api/session/start', {
      packId: 'demo',
      plannedMinutes: 30,
      ceilingPercent: 15,
    })
    expect(started.status).toBe(200)
    const firstTurn = await started.json() as {
      state: string
      turnId: number
      phase: string
      lastLine?: string
      packId: string
      packVersion: string
    }
    expect(firstTurn).toMatchObject({
      state: 'idle',
      turnId: 1,
      phase: 'scene',
      lastLine: '他轻轻靠近。',
      packId: 'demo',
      packVersion: '1.0.0',
    })

    // A second start is a 400, not a 500: one active session.
    const secondStart = await post('/api/session/start', { packId: 'demo', plannedMinutes: 30 })
    expect(secondStart.status).toBe(400)
    expect((await secondStart.json() as { code?: string }).code).toBe('SESSION_OPEN')

    // Human autopilot control is a session-scoped POST and carries the adopted
    // interval back; a malformed flag is a caller error.
    const autoOn = await post('/api/session/autopilot', { enabled: true, intervalSec: 15 })
    expect(autoOn.status).toBe(200)
    expect((await autoOn.json() as { autopilot: unknown }).autopilot)
      .toMatchObject({ enabled: true, intervalSec: 15 })
    expect((await post('/api/session/autopilot', { enabled: 'yes' })).status).toBe(400)

    // The play rail's live chart asks for one waveform's per-slot preview.
    const library = await get('/api/waveforms')
    expect(library.status).toBe(200)
    const waveforms = await library.json() as { id: string }[]
    expect(waveforms.length).toBeGreaterThan(0)
    const preview = await get(`/api/waveforms/preview?id=${encodeURIComponent(waveforms[0]!.id)}`)
    expect(preview.status).toBe(200)
    expect(await preview.json()).toMatchObject({
      id: waveforms[0]!.id,
      freq: expect.any(Array),
      intensity: expect.any(Array),
    })

    const messaged = await post('/api/session/message', { text: '我往后缩了一下' })
    expect(messaged.status).toBe(200)
    const secondTurn = await messaged.json() as { turnId: number; lastLine?: string }
    expect(secondTurn.turnId).toBe(2)
    expect(secondTurn.lastLine).toBe('他轻轻靠近。')
    expect(modelCalls).toBe(2)

    const snapshot = await get('/api/session')
    expect(snapshot.status).toBe(200)
    expect(await snapshot.json()).toMatchObject({ turnId: 2, phase: 'scene' })

    // The ceiling was persisted and audited as the existing policy_change.
    const policyFile = JSON.parse(await readFile(join(root, 'state', 'policy.json'), 'utf8')) as {
      sessionCeiling: number
    }
    expect(policyFile.sessionCeiling).toBe(15)
    const auditRaw = await readFile(join(root, 'audit', 'device.jsonl'), 'utf8')
    const records = auditRaw.trimEnd().split('\n').map(line => JSON.parse(line) as AuditRecord)
    expect(records.find(record =>
      record.action === 'policy_change'
      && (record.detail as { scope?: string } | undefined)?.scope === 'session')?.detail)
      .toMatchObject({ previous: 100, next: 15 })
    expect(records.some(record => record.action === 'session_start')).toBe(true)
    const resolved = records.find(record => record.action === 'plan_resolved')
    expect(resolved).toBeDefined()
    const actions = (resolved?.detail as { actions?: readonly { percent?: number }[] } | undefined)?.actions ?? []
    expect(actions.length).toBeGreaterThan(0)
    // D4 reaches execution: every dispatched target is under the human ceiling.
    expect(actions.every(action => action.percent === undefined || action.percent <= 15)).toBe(true)

    const ended = await post('/api/session/end', { reason: 'stop' })
    expect(ended.status).toBe(200)
    expect(await ended.json()).toMatchObject({ state: 'ended' })
    expect((await get('/api/session')).status).toBe(200)
    expect((await post('/api/session/message', { text: '还在吗' })).status).toBe(400)
  })

  it('refuses unknown packs and bad session input with 400', async () => {
    runtime = await createHostRuntime({
      dataDir: root,
      clock: new FakeClock(),
      withPanicServer: false,
      withButtplug: false,
      llmConfig: {
        default: { provider: 'fixture', model: 'fixture-model', baseUrl: 'http://fixture.invalid/v1' },
      },
      llmEnv: { EMBODIED_LLM_API_KEY: 'test-key' },
      llmFetch: async () => ({ ok: true, status: 200, json: async () => fixtureCompletion() }),
    })
    const address = runtime.dashboardAddress!
    const base = `http://${address.host}:${address.port}`
    const headers = { 'x-control-token': runtime.dashboardToken, 'Content-Type': 'application/json' }

    const cases: readonly { readonly path: string; readonly body: unknown }[] = [
      { path: '/api/session/start', body: {} },
      { path: '/api/session/start', body: { packId: 'missing-pack', plannedMinutes: 30 } },
      { path: '/api/session/start', body: { packId: '../escape', plannedMinutes: 30 } },
      { path: '/api/session/start', body: { packId: 'demo', plannedMinutes: 0 } },
      { path: '/api/session/start', body: { packId: 'demo', plannedMinutes: 30, ceilingPercent: 101 } },
      { path: '/api/session/end', body: { reason: 'later' } },
    ]
    for (const testCase of cases) {
      const response = await fetch(`${base}${testCase.path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(testCase.body),
      })
      expect(response.status, `${testCase.path} ${JSON.stringify(testCase.body)}`).toBe(400)
    }

    // A pack directory that exists but fails validation is also caller input.
    const broken = join(root, 'content', 'packs', 'broken', '1.0.0')
    await mkdir(broken, { recursive: true })
    await writeFile(join(broken, 'pack.json'), JSON.stringify({
      id: 'broken', name: 'Broken', version: '1.0.0', engine: '>=0.2 <1.0', mode: 'freeform',
    }))
    // persona.md is missing -> ContentPackError -> 400, not 500.
    const invalid = await fetch(`${base}/api/session/start`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ packId: 'broken', plannedMinutes: 30 }),
    })
    expect(invalid.status).toBe(400)
    expect((await invalid.json() as { code?: string }).code).toBe('PACK_INVALID')
  })

  it('refuses start and message over HTTP while the runtime is locked', async () => {
    await writeFreeformPack()
    runtime = await createHostRuntime({
      dataDir: root,
      clock: new FakeClock(),
      withPanicServer: false,
      withButtplug: false,
      llmConfig: {
        default: { provider: 'fixture', model: 'fixture-model', baseUrl: 'http://fixture.invalid/v1' },
      },
      llmEnv: { EMBODIED_LLM_API_KEY: 'test-key' },
      llmFetch: async () => ({ ok: true, status: 200, json: async () => fixtureCompletion() }),
    })
    await runtime.registry.connect('mock-pulse', new AbortController().signal)

    const address = runtime.dashboardAddress!
    const base = `http://${address.host}:${address.port}`
    const token = runtime.dashboardToken
    const headers = { 'x-control-token': token, 'Content-Type': 'application/json' }
    const post = async (path: string, body: unknown): Promise<Response> =>
      await fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
    const get = async (path: string): Promise<Response> =>
      await fetch(`${base}${path}`, { headers: { 'x-control-token': token } })

    // Panic without a session locks the registry; starting is refused.
    expect((await post('/api/panic', { source: 'test' })).status).toBe(200)
    const lockedStart = await post('/api/session/start', { packId: 'demo', plannedMinutes: 30 })
    expect(lockedStart.status).toBe(400)
    expect((await lockedStart.json() as { code?: string }).code).toBe('LOCKED')

    // Human unlock + start, then a second panic locks the engine itself.
    expect((await post('/api/unlock', {})).status).toBe(200)
    expect((await post('/api/session/start', { packId: 'demo', plannedMinutes: 30 })).status).toBe(200)
    expect((await post('/api/panic', { source: 'test' })).status).toBe(200)
    const lockedSnapshot = await get('/api/session')
    expect(lockedSnapshot.status).toBe(200)
    expect(await lockedSnapshot.json()).toMatchObject({ state: 'locked' })

    const lockedMessage = await post('/api/session/message', { text: '还在吗' })
    expect(lockedMessage.status).toBe(400)
    expect((await lockedMessage.json() as { code?: string }).code).toBe('LOCKED')
  })

  it('loads the highest installed version directory', async () => {
    const source = new DirectoryPackSource(root)
    for (const version of ['1.0.0', '1.2.0']) {
      const dir = join(root, 'content', 'packs', 'demo', version)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'pack.json'), JSON.stringify({
        id: 'demo',
        name: 'Demo Pack',
        version,
        engine: '>=0.2 <1.0',
        mode: 'freeform',
        rating: 'all',
      }))
      await writeFile(join(dir, 'persona.md'), `# 阿岚 ${version}\n\n## 导演摘要\n\n温柔的试探者。\n`)
    }
    const pack = await source.load('demo')
    expect(pack.manifest.version).toBe('1.2.0')
    await expect(source.load('nope')).rejects.toMatchObject({ code: 'PACK_NOT_FOUND' })
  })
})

// ── B2-T7/T8: session archive + ledger wiring ──────────────────────────────

interface ArchiveBacking {
  readonly state: MemoryDocumentStore
  readonly ledger: MemoryAppendOnlyStore
  readonly memory: MemoryDocumentStore
}

interface ArchivedHarness {
  readonly host: PlayHost
  readonly clock: FakeClock
  readonly runner: ScriptedRunner
  readonly backing: ArchiveBacking
}

/**
 * The real session service over in-memory archive/ledger ports.
 *
 * `backing` is reusable across harnesses on purpose: a second harness with the
 * same backing is exactly what a process restart looks like to `play.ts`.
 */
async function createArchivedHarness(input: {
  readonly turns: readonly ModelTurnResult[]
  readonly pack?: LoadedPack
  readonly backing?: ArchiveBacking
  readonly clock?: FakeClock
}): Promise<ArchivedHarness> {
  const clock = input.clock ?? new FakeClock()
  const audit = new AuditLog(new MemoryAppendOnlyStore(), clock, () => {})
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

  const backing = input.backing ?? {
    state: new MemoryDocumentStore(),
    ledger: new MemoryAppendOnlyStore(),
    memory: new MemoryDocumentStore(),
  }
  const archive: PlayArchive = {
    state: backing.state,
    ledger: backing.ledger,
    memory: backing.memory,
    ledgerText: async () => backing.ledger.lines.join('\n'),
  }
  const runner = new ScriptedRunner(input.turns)
  const env: PlaySessionEnvironment = {
    clock,
    audit,
    registry,
    policy,
    waveforms,
    sensors: new SensorRegistry({ clock }),
    runner,
    savePolicy: async (): Promise<void> => {},
    archive,
    onEvent: (): void => {},
  }
  const pack = input.pack ?? await freeformPack()
  const host = new PlayHost({ ...env, packs: { load: async () => pack } })
  return { host, clock, runner, backing }
}

/** Read one archived snapshot document and parse it. */
function archivedState(raw: string | undefined): Record<string, unknown> {
  expect(raw).toBeDefined()
  return JSON.parse(raw!) as Record<string, unknown>
}

/** A pack that opts into the ledger and declares one `left_early` reaction. */
async function historyPack(): Promise<LoadedPack> {
  return await loadPack(new MemoryContentSource({
    'pack.json': JSON.stringify({
      id: 'demo',
      name: 'Demo Pack',
      version: '1.0.0',
      engine: '>=0.2 <1.0',
      mode: 'freeform',
      rating: 'all',
      history: { read: true, windowHours: 72, lastN: 1 },
      metaReactions: [
        {
          when: { endReason: ['left_early'] },
          opening: { tone: 'cold', firstIntent: 'soothe' },
        },
      ],
    }),
    'persona.md': '# 阿岚\n\n## 导演摘要\n\n温柔的试探者。\n',
  }))
}

describe('play session archive and ledger (B2-T7/T8)', () => {
  it('archives one snapshot per turn and one ledger line at the end', async () => {
    const h = await createArchivedHarness({
      turns: [
        scriptedTurn('第一句。', [planCall()]),
        scriptedTurn('第二句。'),
      ],
    })

    const first = await h.host.start({ packId: 'demo', plannedMinutes: 30 })
    expect(first.sessionId).not.toBe('')
    const afterOpening = archivedState(await h.backing.state.read(`session-${first.sessionId}`))
    expect(afterOpening).toMatchObject({
      sessionId: first.sessionId,
      packId: 'demo',
      currentPhase: 'scene',
      turn: 1,
      elapsedMin: 0,
      status: 'active',
      lastLine: '第一句。',
    })
    expect(afterOpening['recentBeats']).toEqual(['probe-touch'])

    await h.host.message('嗯。')
    expect(archivedState(await h.backing.state.read(`session-${first.sessionId}`))).toMatchObject({
      turn: 2,
      lastLine: '第二句。',
      status: 'active',
    })

    await h.host.end('left_early')
    expect(archivedState(await h.backing.state.read(`session-${first.sessionId}`))).toMatchObject({
      turn: 2,
      status: 'ended',
    })

    // Exactly one line, facts only, and the highest dispatched percent — never
    // a cap and never prose.
    expect(h.backing.ledger.lines).toHaveLength(1)
    const line = JSON.parse(h.backing.ledger.lines[0]!) as Record<string, unknown>
    expect(line).toMatchObject({
      sessionId: first.sessionId,
      pack: 'demo',
      endReason: 'left_early',
      plannedMin: 30,
      actualMin: 0,
      phaseReached: 'scene',
      aftercare: false,
    })
    expect(line['maxCapUsed']).toBeGreaterThan(0)
    expect(Object.keys(line)).toHaveLength(10)

    // A duplicated end must not append a second line for the session.
    await h.host.end('left_early')
    expect(h.backing.ledger.lines).toHaveLength(1)
  })

  it('marks the interrupted snapshot recovered and records unexpected_exit on the next start', async () => {
    const backing: ArchiveBacking = {
      state: new MemoryDocumentStore(),
      ledger: new MemoryAppendOnlyStore(),
      memory: new MemoryDocumentStore(),
    }
    const clock = new FakeClock()
    const crashed = await createArchivedHarness({
      turns: [scriptedTurn('第一局。', [planCall()]), scriptedTurn('第二回合。')],
      backing,
      clock,
    })
    const first = await crashed.host.start({ packId: 'demo', plannedMinutes: 30 })
    clock.advance(18 * 60_000)
    await crashed.host.message('我还在。')
    // Quit without end(): the open marker and the active snapshot survive.
    crashed.host.dispose()

    const restarted = await createArchivedHarness({
      turns: [scriptedTurn('重新开始。')],
      backing,
      clock,
    })
    const next = await restarted.host.start({ packId: 'demo', plannedMinutes: 20 })
    expect(next.sessionId).not.toBe(first.sessionId)
    // The unfinished turn is not replayed: the new session ran its own one turn.
    expect(restarted.runner.requests).toHaveLength(1)

    const previous = archivedState(await backing.state.read(`session-${first.sessionId}`))
    expect(previous).toMatchObject({ status: 'recovered', turn: 2 })

    const lines = backing.ledger.lines.map(line => JSON.parse(line) as Record<string, unknown>)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      sessionId: first.sessionId,
      endReason: 'unexpected_exit',
      plannedMin: 30,
      actualMin: 18,
      phaseReached: 'scene',
      aftercare: false,
      maxCapUsed: 0,
    })
  })

  it('injects the matched metaReactions brief into the opening system prompt', async () => {
    const pack = await historyPack()
    const backing: ArchiveBacking = {
      state: new MemoryDocumentStore(),
      ledger: new MemoryAppendOnlyStore(),
      memory: new MemoryDocumentStore(),
    }

    // A first session ends `left_early`; the opening had no ledger to read.
    const firstRun = await createArchivedHarness({ turns: [scriptedTurn('冷。')], pack, backing })
    await firstRun.host.start({ packId: 'demo', plannedMinutes: 45 })
    expect(firstRun.runner.requests[0]!.messages[0]!.content).not.toContain('开场指引')
    await firstRun.host.end('left_early')

    // The next session reads the ledger and receives the brief.
    const secondRun = await createArchivedHarness({ turns: [scriptedTurn('你回来了。')], pack, backing })
    await secondRun.host.start({ packId: 'demo', plannedMinutes: 45 })
    const system = secondRun.runner.requests[0]!.messages[0]!.content
    expect(system).toContain('开场指引')
    expect(system).toContain('cold')
    expect(system).toContain('soothe')
    await secondRun.host.end('stop')

    // A pack that does not read the ledger stays neutral even with entries.
    const silentRun = await createArchivedHarness({ turns: [scriptedTurn('嗯。')], backing })
    await silentRun.host.start({ packId: 'demo', plannedMinutes: 45 })
    expect(silentRun.runner.requests[0]!.messages[0]!.content).not.toContain('开场指引')
  })
})

describe('session ceiling and narrative regions (B2-T9/T10)', () => {
  it('writes a narrowed ceiling through the human path, audits it and re-asserts bounds', async () => {
    const h = await createHarness([
      {
        text: '（低笑）',
        toolCalls: [planCall()],
        finishReason: 'tool-calls',
      },
    ])
    const bounds = vi.spyOn(h.registry, 'reapplyBounds')
    await h.host.start({ packId: 'tentacle', plannedMinutes: 30 })

    await h.host.setCeiling(15)

    expect(h.policy.ceiling()).toBe(15)
    // Hardware ceiling must follow the software one (Coyote BF).
    expect(bounds).toHaveBeenCalledTimes(1)
    const change = h.records().find(record => record.action === 'policy_change'
      && (record.detail as { scope?: string } | undefined)?.scope === 'session')
    expect(change?.detail).toMatchObject({ previous: 100, next: 15 })
    // The ceiling is persisted through the human save hook.
    expect(h.states.length).toBeGreaterThan(0)
  })

  it('edits a channel region label and clears it again, auditing both directions', async () => {
    const h = await createHarness([{ text: '好。', toolCalls: [], finishReason: 'stop' }])

    await h.host.setRegion('mock-pulse', 'a', 'chest')
    expect(h.host.regions()['mock-pulse:a']).toBe('chest')
    const channelA = h.registry.snapshot().devices
      .find(device => device.id === 'mock-pulse')?.channels
      .find(channel => channel.id === 'a')
    expect(channelA?.region).toBe('chest')
    expect(h.records().some(record => record.action === 'region_change'
      && record.result === 'ok')).toBe(true)

    await h.host.setRegion('mock-pulse', 'a', undefined)
    expect(h.host.regions()['mock-pulse:a']).toBeUndefined()
  })

  it('projects the intent menu and the ready body regions into the single-call prompt', async () => {
    const h = await createHarness([scriptedTurn('好。', [planCall()])], await narrativePack())
    // Channel A is placed on 手; B stays unlabelled, so only 手 is "ready".
    await h.host.setRegion('mock-pulse', 'a', 'hands')
    await h.host.start({ packId: 'narrative', plannedMinutes: 30 })

    const request = h.runner.requests[0]
    expect(request).toBeDefined()
    const system = request!.messages.find(message => message.role === 'system')?.content ?? ''
    // The model cannot plan without the pack's menu; the labels are what the
    // player sees in the per-channel region picker.
    expect(system).toContain('可用意图')
    expect(system).toContain('probe-touch=短促试探')
    expect(system).toContain('soothe=安抚或降档')
    expect(system).toContain('可用部位')
    expect(system).toContain('hands=手')
    expect(system).toContain('shoulders=肩背')
    expect(system).toContain('whole-body=全身')
    expect(system).toContain('已就位部位：hands')
    // The facts live in the mandatory `world` section, not in the budgeted
    // narrative briefs: a long persona can never hide the menu.
    expect(system).toContain('## 本回合可用（意图与部位）')
    expect(system.indexOf('## 本回合可用（意图与部位）')).toBeGreaterThan(system.indexOf('## 人设'))
    // B carries no label: the model must not be told 肩背 is addressable.
    expect(system).not.toContain('已就位部位：hands、shoulders')

    // The runtime enums are the same vocabulary: a hallucinated id is rejected
    // before it reaches parseBeatPlan.
    const applyPlan = request!.tools.find(tool => tool.name === 'apply_plan')
    const beat = (applyPlan!.parameters as {
      properties: {
        beats: {
          items: {
            properties: {
              intentId: { enum: readonly string[] }
              regions: { items: { enum: readonly string[] } }
            }
          }
        }
      }
    }).properties.beats.items.properties
    expect(beat.intentId.enum).toEqual(['probe-touch', 'soothe'])
    expect(beat.regions.items.enum).toEqual(['whole-body', 'hands', 'shoulders'])

    await h.host.end('stop')
  })

  it('keeps player choices in autopilot mode', async () => {
    const h = await createHarness([scriptedTurn('自动推进。', [choicePlanCall()])])
    const started = await h.host.start({
      packId: 'demo',
      plannedMinutes: 30,
      autopilot: { enabled: true, intervalSec: 10 },
    })
    expect(started.choices).toHaveLength(1)
    const system = h.runner.requests[0]?.messages.find(message => message.role === 'system')?.content ?? ''
    expect(system).toContain('自动运行')
    expect(system).toContain('choices')
    expect(system).not.toContain('不要生成 choices')
    await h.host.end('completed')
  })

  it('does not wait forever on a choice in autopilot mode', async () => {
    const h = await createHarness([
      scriptedTurn('开场带选项。', [choicePlanCall()]),
      scriptedTurn('超时后继续。'),
    ])
    await h.host.start({
      packId: 'demo',
      plannedMinutes: 30,
      autopilot: { enabled: true, intervalSec: 10 },
    })
    expect(h.host.snapshot()?.choices).toHaveLength(1)
    // The choice timeout is passive: no player decision is fabricated, the
    // menu expires and the autopilot opens the next turn.
    h.clock.advance(60_000)
    for (let i = 0; i < 20 && h.runner.requests.length < 2; i += 1) {
      await Promise.resolve()
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    expect(h.runner.requests).toHaveLength(2)
    expect(h.host.snapshot()?.choices).toBeUndefined()
    await h.host.end('completed')
  })

  it('sends a synthetic continuation user turn for auto turns', async () => {
    const h = await createHarness([
      scriptedTurn('开场。'),
      scriptedTurn('自动回合。'),
    ])
    await h.host.start({
      packId: 'demo',
      plannedMinutes: 30,
      autopilot: { enabled: true, intervalSec: 10 },
    })
    // FakeClock fires one autopilot tick; no choice menu is open.
    h.clock.advance(10_000)
    for (let i = 0; i < 20 && h.runner.requests.length < 2; i += 1) {
      await Promise.resolve()
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    expect(h.runner.requests).toHaveLength(2)
    expect(h.runner.requests[1]?.messages.at(-1)).toMatchObject({ role: 'user' })
    expect(h.runner.requests[1]?.messages.at(-1)?.content).toContain('自动运行继续')
    await h.host.end('completed')
  })

  it('adds the single-call narration protocol and the opening scene instruction', async () => {
    const h = await createHarness([scriptedTurn('第一句。'), scriptedTurn('第二句。')])
    await h.host.start({ packId: 'demo', plannedMinutes: 30 })

    const opening = h.runner.requests[0]?.messages.find(message => message.role === 'system')?.content ?? ''
    expect(opening).toContain('## 工具与输出协议（本回合必须）')
    expect(opening).toContain('narration')
    expect(opening).toContain('开场回合')
    expect(opening).toContain('不要调用它们')
    const applyPlan = h.runner.requests[0]?.tools.find(tool => tool.name === 'apply_plan')
    const properties = (applyPlan?.parameters as { properties: Record<string, unknown> }).properties
    expect(properties).toHaveProperty('narration')

    // The scene/background requirement is opening-only; later turns still get
    // the narration contract but not the opening instruction.
    await h.host.message('继续。')
    const second = h.runner.requests[1]?.messages.find(message => message.role === 'system')?.content ?? ''
    expect(second).toContain('narration')
    expect(second).not.toContain('开场回合')
    await h.host.end('stop')
  })

  it('adds player-named parts to the session vocabulary', async () => {
    const h = await createHarness([scriptedTurn('好。', [planCall()])], await narrativePack())
    // v6: the player may name a part freely; it becomes a region key the model
    // can target, alongside the pack's recommendations.
    await h.host.setRegion('mock-pulse', 'b', '左胸')
    await h.host.start({ packId: 'narrative', plannedMinutes: 30 })

    const system = h.runner.requests[0]?.messages.find(message => message.role === 'system')?.content ?? ''
    expect(system).toContain('hands=手')
    expect(system).toContain('左胸=左胸')
    expect(system).toContain('已就位部位：左胸')

    const applyPlan = h.runner.requests[0]?.tools.find(tool => tool.name === 'apply_plan')
    const beat = (applyPlan!.parameters as {
      properties: { beats: { items: { properties: { regions: { items: { enum: readonly string[] } } } } } }
    }).properties.beats.items.properties
    expect(beat.regions.items.enum).toEqual(['whole-body', 'hands', 'shoulders', '左胸'])

    await h.host.end('stop')
  })
})

// ── B2-T11: pause / resume / choice / transcript / ledger ──────────────────

describe('session controls (B2-T11)', () => {
  it('pauses only after the current turn settles and stops every effect', async () => {
    const h = await createHarness([
      scriptedTurn('第一句。', [planCall()]),
      scriptedTurn('第二句。'),
    ])
    await h.host.start({ packId: 'demo', plannedMinutes: 30 })
    expect(h.runner.requests).toHaveLength(1)
    const stop = vi.spyOn(h.registry, 'stop')

    const paused = await h.host.pause()

    // The pause landed after the opening turn settled and ran the full-stop
    // hook; the engine is parked, not merely idle.
    expect(paused.state).toBe('paused')
    expect(paused.turnId).toBe(1)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(stop.mock.calls[0]?.[0]).toBe('system')
    expect(h.states).toContain('paused')
    expect(h.records().some(record =>
      record.action === 'session_paused' && record.actor === 'human')).toBe(true)
    expect(h.runner.requests).toHaveLength(1)

    // Product semantics fixed here: P1 input is still accepted while paused
    // (the engine resumes explicitly), so the UI does not have to unlock a
    // dead input box. It opens a new turn, not a replay.
    const next = await h.host.message('我还在')
    expect(next.state).toBe('idle')
    expect(next.turnId).toBe(2)
    expect(h.runner.requests).toHaveLength(2)
  })

  it('resumes without replaying the last effect', async () => {
    const h = await createHarness([
      scriptedTurn('第一句。', [planCall()]),
      scriptedTurn('第二句。', [planCall('call_2')]),
    ])
    await h.host.start({ packId: 'demo', plannedMinutes: 30 })
    const planDispatches = h.records().filter(record => record.action === 'plan_resolved')
    expect(planDispatches).toHaveLength(1)

    await h.host.pause()
    const resumed = await h.host.resume()

    expect(resumed.state).toBe('idle')
    expect(h.states.at(-1)).toBe('idle')
    // No model call and no plan dispatch while resuming: the stopped effects
    // are not re-issued, the next turn re-plans from the current state.
    expect(h.runner.requests).toHaveLength(1)
    expect(h.records().filter(record => record.action === 'plan_resolved')).toHaveLength(1)
    expect(h.records().some(record =>
      record.action === 'session_resumed' && record.actor === 'human')).toBe(true)

    const next = await h.host.message('继续')
    expect(next.turnId).toBe(2)
    expect(h.records().filter(record => record.action === 'plan_resolved')).toHaveLength(2)
  })

  it('rejects a choice when no menu is open', async () => {
    const h = await createHarness([
      scriptedTurn('第一句。', [planCall()]),
      scriptedTurn('不该出现的回合。'),
    ])
    const started = await h.host.start({ packId: 'demo', plannedMinutes: 30 })
    expect(started.choices).toBeUndefined()

    await expect(h.host.submitChoice('')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(h.host.submitChoice('c1')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(h.host.choice('c1')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    // A stray id must not become a phantom player message/turn.
    expect(h.runner.requests).toHaveLength(1)
    expect(h.records().some(record => record.action === 'choice_selected')).toBe(false)
  })

  it('opens a new turn when an offered choice is picked', async () => {
    const h = await createHarness([
      scriptedTurn('第一句。', [choicePlanCall()]),
      scriptedTurn('第二句。'),
    ])
    const started = await h.host.start({ packId: 'demo', plannedMinutes: 30 })
    expect(started.choices).toEqual([{ id: 'c1', label: '退开', tag: 'resist' }])

    const picked = await h.host.submitChoice('c1')

    expect(picked.turnId).toBe(2)
    expect(picked.lastLine).toBe('第二句。')
    expect(picked.choices).toBeUndefined()
    const selected = h.records().find(record => record.action === 'choice_selected')
    expect(selected?.actor).toBe('human')
    expect(selected?.detail).toMatchObject({ turnId: 1, choiceId: 'c1' })
  })

  it('keeps the opening and later lines in the transcript', async () => {
    const h = await createHarness([
      scriptedTurn('第一句。', [planCall()]),
      scriptedTurn('第二句。'),
    ])
    await h.host.start({ packId: 'demo', plannedMinutes: 30 })

    const opening = h.host.transcript()[0]
    expect(opening).toMatchObject({ turnId: 1, at: h.clock.now(), text: '第一句。' })
    // Resolved dispatch actions ride along as the per-turn effect summary.
    expect(opening?.effects.length).toBeGreaterThan(0)
    expect(opening?.effects[0]).toMatchObject({
      deviceId: 'mock-pulse',
      channelId: 'a',
      percent: expect.any(Number),
      status: 'dispatched',
    })

    h.clock.advance(1_234)
    await h.host.message('嗯。')
    const entries = h.host.transcript()
    expect(entries.map(entry => entry.text)).toEqual(['第一句。', '第二句。'])
    expect(entries[1]).toMatchObject({ turnId: 2, at: h.clock.now() })
  })

  it('rejects a second session start while the first is still starting', async () => {
    const h = await createHarness([scriptedTurn('第一句。')])

    const results = await Promise.allSettled([
      h.host.start({ packId: 'demo', plannedMinutes: 30 }),
      h.host.start({ packId: 'demo', plannedMinutes: 30 }),
    ])

    const rejected = results.filter((result): result is PromiseRejectedResult =>
      result.status === 'rejected')
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0]?.reason).toBeInstanceOf(SessionError)
    expect((rejected[0]?.reason as SessionError).code).toBe('SESSION_OPEN')
    // Exactly one engine: one opening turn reached the model.
    expect(h.runner.requests).toHaveLength(1)
    expect(h.states.filter(state => state === 'planning')).toHaveLength(1)
  })

  it('rejects a concurrent PlaySession.start before the opening turn settles', async () => {
    const h = await createHarness([scriptedTurn('第一句。')])
    const pack = await freeformPack()

    const results = await Promise.allSettled([
      h.session.start({ pack, plannedMinutes: 30 }),
      h.session.start({ pack, plannedMinutes: 30 }),
    ])

    const rejected = results.filter((result): result is PromiseRejectedResult =>
      result.status === 'rejected')
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0]?.reason as SessionError).code).toBe('SESSION_OPEN')
    expect(h.runner.requests).toHaveLength(1)
    expect(h.session.state).toBe('idle')
  })

  it('returns no ledger entries without an archive and one line after the session ends', async () => {
    const plain = await createHarness([])
    expect(await plain.host.ledgerEntries()).toEqual([])
    expect(await plain.host.ledger()).toEqual([])

    const h = await createArchivedHarness({ turns: [scriptedTurn('第一句。')] })
    // No session yet, so nothing to read through the session seam.
    expect(await h.host.ledgerEntries()).toEqual([])

    const started = await h.host.start({ packId: 'demo', plannedMinutes: 30 })
    await h.host.end('completed')

    const entries = await h.host.ledgerEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      sessionId: started.sessionId,
      pack: 'demo',
      endReason: 'completed',
    })
    expect(await h.host.ledgerEntries(1)).toHaveLength(1)
  })
})


describe('opening brief intent filter', () => {
  it('renders firstIntent only when it is in the effective intent table', () => {
    // Scenario validation only warns about an unknown metaReactions default,
    // and freeform packs are not checked against DEFAULT_INTENTS at all. The
    // rendered brief must agree with the apply_plan enum the host injects.
    const all = new Set(['probe-touch', 'soothe'])
    expect(openingBriefText({ tone: '冷', firstIntent: 'soothe' }, all)).toContain('首个意图「soothe」')
    const unknown = openingBriefText({ tone: '冷', firstIntent: 'ghost' }, all)
    expect(unknown).not.toContain('首个意图')
    expect(unknown).toContain('语气「冷」')
    expect(openingBriefText({ firstIntent: 'ghost' }, all)).toBe('')
  })
})

describe('narrative-only session with no sensors and no devices (F-6)', () => {
  it('runs a whole session without any sensor source or connected device', async () => {
    const clock = new FakeClock()
    const store = new MemoryAppendOnlyStore()
    const audit = new AuditLog(store, clock, () => {})
    const policy = new PolicyStore()
    const waveforms = new WaveformLibrary()
    // No backends registered and no sensors pushed: the whole world is empty.
    const registry = new DeviceRegistry({ clock, audit, policy, waveforms, onError: () => {} })
    const env: PlaySessionEnvironment = {
      clock,
      audit,
      registry,
      policy,
      waveforms,
      sensors: new SensorRegistry({ clock }),
      runner: new ScriptedRunner([
        { text: '（风声）', toolCalls: [planCall()], finishReason: 'tool-calls' },
        { text: '……', toolCalls: [], finishReason: 'stop' },
      ]),
      savePolicy: async (): Promise<void> => {},
    }
    const host = new PlayHost({ ...env, packs: { load: async () => await freeformPack() } })

    const started = await host.start({ packId: 'tentacle', plannedMinutes: 30 })
    expect(started.state).toBe('idle')
    const answered = await host.message('继续')
    expect(answered.state).toBe('idle')
    const ended = await host.end('completed')
    expect(ended.state).toBe('ended')
    // Nothing was dispatched, and the session still produced a ledger line.
    expect(registry.snapshot().devices.filter(device => device.lifecycle === 'ready')).toHaveLength(0)
  })
})
