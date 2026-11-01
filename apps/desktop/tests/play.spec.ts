import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  AuditLog,
  DeviceRegistry,
  FakeClock,
  loadPack,
  MemoryAppendOnlyStore,
  MemoryContentSource,
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
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHostRuntime, type HostRuntime } from '../src/main/bootstrap.ts'
import {
  DirectoryPackSource,
  PlayHost,
  PlaySession,
  SessionError,
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
async function createHarness(turns: readonly ModelTurnResult[]): Promise<Harness> {
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
  const host = new PlayHost({ ...env, packs: { load: async () => await freeformPack() } })
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

  it('refuses a second session start while one is open', async () => {
    const h = await createHarness([scriptedTurn('第一次。'), scriptedTurn('第二次。')])

    await h.host.start({ packId: 'demo', plannedMinutes: 30 })
    await expect(h.host.start({ packId: 'demo', plannedMinutes: 30 }))
      .rejects.toMatchObject({ code: 'SESSION_OPEN' })

    // "One process, one session" also holds after the session ends.
    await h.host.end('left_early')
    await expect(h.host.start({ packId: 'demo', plannedMinutes: 30 }))
      .rejects.toMatchObject({ code: 'SESSION_OPEN' })
    expect(h.runner.requests).toHaveLength(1)
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
    await runtime.registry.connect('mock-pulse', new AbortController().signal)

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

    // A second start is a 400, not a 500: one process, one session.
    const secondStart = await post('/api/session/start', { packId: 'demo', plannedMinutes: 30 })
    expect(secondStart.status).toBe(400)
    expect((await secondStart.json() as { code?: string }).code).toBe('SESSION_OPEN')

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
    expect(records.some(record => record.action === 'plan_resolved')).toBe(true)

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
