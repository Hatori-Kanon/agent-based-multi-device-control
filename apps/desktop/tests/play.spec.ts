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
  PlanExecutor,
  PolicyStore,
  SensorRegistry,
  WaveformLibrary,
  type AuditRecord,
  type Channel,
  type DispatchStatus,
  type EngineConfig,
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

/** One beat using an intent's own suggestion (envelope/waveform/duration). */
function suggestPlanCall(intentId: string, id = 'call_suggest'): ToolCall {
  return {
    id,
    name: 'apply_plan',
    arguments: {
      pacing: 'probe',
      beats: [{ id: 'b1', intentId, regions: ['whole-body'], strength: 'low' }],
    },
  }
}

/** An explicit stop of every ready channel (the only way to end a body). */
function stopPlanCall(id = 'call_stop'): ToolCall {
  return {
    id,
    name: 'apply_plan',
    arguments: {
      pacing: 'probe',
      beats: [{ id: 'b1', intentId: 'stop', regions: ['whole-body'], strength: 'low' }],
    },
  }
}

/** A level change at an explicit band percentage (0–100 of the soft range). */
function targetPercentPlanCall(targetPercent: number, id = 'call_target'): ToolCall {
  return {
    id,
    name: 'apply_plan',
    arguments: {
      pacing: 'probe',
      beats: [{
        id: 'b1',
        intentId: 'ambient-field',
        regions: ['whole-body'],
        strength: 'med',
        change: { kind: 'level', targetPercent, durationSec: 10 },
      }],
    },
  }
}

/** A level change that only gives the strength bucket (no explicit percent). */
function strengthLevelPlanCall(
  strength: 'low' | 'med' | 'high',
  id = 'call_strength',
): ToolCall {
  return {
    id,
    name: 'apply_plan',
    arguments: {
      pacing: 'probe',
      beats: [{
        id: 'b1',
        intentId: 'ambient-field',
        regions: ['whole-body'],
        strength,
        change: { kind: 'level', durationSec: 10 },
      }],
    },
  }
}

/** The same plan plus the director's suggested wait before the next auto turn. */
function pacedPlanCall(nextTurnAfterSec: number, id = 'call_paced'): ToolCall {
  return {
    id,
    name: 'apply_plan',
    arguments: {
      pacing: 'probe',
      nextTurnAfterSec,
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

/** A plan that drives every ready channel with one packaged waveform reference. */
function waveformPlanCall(waveformId: string, id = 'call_wave'): ToolCall {
  return {
    id,
    name: 'apply_plan',
    arguments: {
      pacing: 'probe',
      beats: [{
        id: 'b1',
        intentId: 'cilia-tickle',
        regions: ['whole-body'],
        strength: 'low',
        change: { kind: 'waveform', waveformId, durationSec: 5 },
      }],
    },
  }
}

/** A level plan that names one pack region id. */
function regionPlanCall(region: string, id = 'call_region'): ToolCall {
  return {
    id,
    name: 'apply_plan',
    arguments: {
      pacing: 'probe',
      beats: [{
        id: 'b1',
        intentId: 'pause-watch',
        regions: [region],
        strength: 'low',
        change: { kind: 'level', targetPercent: 20, durationSec: 3 },
      }],
    },
  }
}

/** Two beats on a region no channel carries: exercises the fallback route. */
function fallbackPlanCall(id = 'call_fallback'): ToolCall {
  return {
    id,
    name: 'apply_plan',
    arguments: {
      pacing: 'probe',
      beats: [
        { id: 'b1', intentId: 'pause-watch', regions: ['waist'], strength: 'low' },
        { id: 'b2', intentId: 'pause-watch', regions: ['waist'], strength: 'low' },
      ],
    },
  }
}

/** One round-robin beat; the rotation seed should make the next turn differ. */
function rotationPlanCall(id = 'call_rotation'): ToolCall {
  return {
    id,
    name: 'apply_plan',
    arguments: {
      pacing: 'probe',
      beats: [{
        id: 'b1',
        intentId: 'sweep-touch',
        regions: ['whole-body'],
        strength: 'low',
      }],
    },
  }
}

/** Two round-robin beats in one plan: they share the turn's cursor. */
function doubleRotationPlanCall(id = 'call_double_rotation'): ToolCall {
  return {
    id,
    name: 'apply_plan',
    arguments: {
      pacing: 'probe',
      beats: [
        { id: 'b1', intentId: 'sweep-touch', regions: ['whole-body'], strength: 'low' },
        { id: 'b2', intentId: 'sweep-touch', regions: ['whole-body'], strength: 'low' },
      ],
    },
  }
}

/**
 * A level plan that drives every ready channel (synced intent, no waveform).
 *
 * `durationSec` defaults to a short 3 s hold so a following turn is past the
 * effect and the continuity hold is allowed to bridge the gap.
 */
function holdPlanCall(targetPercent: number, durationSec = 3, id = 'call_level'): ToolCall {
  return {
    id,
    name: 'apply_plan',
    arguments: {
      pacing: 'probe',
      beats: [{
        id: 'b1',
        intentId: 'ambient-field',
        regions: ['whole-body'],
        strength: 'low',
        change: { kind: 'level', targetPercent, durationSec },
      }],
    },
  }
}

/** Registry commands issued by the continuity hold (host, `system` actor). */
function holdRecords(records: readonly AuditRecord[]): readonly AuditRecord[] {
  return records.filter(record => record.actor === 'system'
    && (record.action === 'set_level' || record.action === 'run_pattern'))
}

/** Records after the previous `plan_resolved` up to and including the last one. */
function recordsOfLastTurn(records: readonly AuditRecord[]): readonly AuditRecord[] {
  const resolved = records
    .map((record, index) => ({ record, index }))
    .filter(entry => entry.record.action === 'plan_resolved')
  if (resolved.length < 2) return []
  const previous = resolved[resolved.length - 2]!
  const last = resolved[resolved.length - 1]!
  return records.slice(previous.index + 1, last.index + 1)
}

/** Every dispatch action recorded by the executor's `plan_resolved` audit lines. */
function planActions(records: readonly AuditRecord[]): readonly DispatchStatus[] {
  return records
    .filter(record => record.action === 'plan_resolved')
    .flatMap(record =>
      (record.detail as { readonly actions?: readonly DispatchStatus[] } | undefined)?.actions ?? [])
}

/** A scripted, offline {@link ModelRunner}; records every request. */
class ScriptedRunner implements ModelRunner {
  readonly requests: ModelTurnRequest[] = []
  private readonly turns: ModelTurnResult[]
  private readonly planFirst: boolean
  /** Optional per-request hook, run just before the scripted tool calls. */
  private readonly beforeCall: ((request: ModelTurnRequest) => void) | undefined

  constructor(
    turns: readonly ModelTurnResult[],
    planFirst = true,
    beforeCall?: (request: ModelTurnRequest) => void,
  ) {
    this.turns = [...turns]
    this.planFirst = planFirst
    this.beforeCall = beforeCall
  }

  async run(request: ModelTurnRequest): Promise<ModelTurnResult> {
    this.requests.push(request)
    const turn = this.turns.shift()
    if (turn === undefined) throw new Error('ScriptedRunner ran out of scripted turns')
    this.beforeCall?.(request)
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

let cachedTentaclePack: Promise<LoadedPack> | undefined

/**
 * A scenario pack shaped like the user's installed 内容包 (audit evidence).
 *
 * Its regions are the pack's own ids (`inner-thigh`/`anal`/`chest`/`waist`)
 * whose prose labels contain the words the player labels channels with
 * (`阴蒂`/`后穴`/`乳房`), and it ships one `waveforms/*.json` asset. That is
 * exactly the shape that produced the audit's `UNKNOWN_WAVEFORM` rejects and
 * "部位对不上" prose: the pack ids were in the menu, the player's parts were
 * not mapped anywhere.
 */
function tentaclePack(): Promise<LoadedPack> {
  cachedTentaclePack ??= loadPack(new MemoryContentSource({
    'pack.json': JSON.stringify({
      id: 'tentacle',
      name: '触手包',
      version: '0.3.0',
      engine: '>=0.2 <1.0',
      mode: 'scenario',
      rating: '18+',
      boundaries: ['不做真实伤害'],
    }),
    'persona.md': '# 阿岚\n\n## 导演摘要\n\n温柔的试探者，先观察再靠近。\n',
    'setting.md': '一间只有台灯的房间。\n',
    'scenario.json': JSON.stringify({
      session: { plannedMinutes: 30, phaseWindows: [], aftercareMin: 0 },
      regions: [
        { id: 'inner-thigh', label: '核心敏感区（阴部/阴茎/阴蒂/大腿内侧）' },
        { id: 'anal', label: '深层区域（后穴/内部深处）' },
        { id: 'chest', label: '胸部敏感区（乳房/乳尖）' },
        { id: 'waist', label: '躯干束缚（腰腹/四肢固定）' },
        { id: 'whole-body', label: '全身/环境场' },
      ],
      phases: [{ id: 'scene', goal: '自由互动', next: [] }],
      feedbackIntents: [
        {
          id: 'cilia-tickle',
          meaning: '细密撩拨',
          regions: ['inner-thigh', 'chest', 'anal'],
          suggest: { preset: 'wave', waveform: 'saw-spin', durationSec: 10, strength: 'low' },
        },
        {
          id: 'pause-watch',
          meaning: '停顿观察',
          regions: ['inner-thigh', 'anal', 'chest'],
          suggest: { preset: 'steady', durationSec: 4, strength: 'low' },
        },
        {
          id: 'soothe',
          meaning: '安抚或降档',
          regions: ['whole-body'],
          suggest: { preset: 'wave', waveform: 'builtin:tide', durationSec: 15, strength: 'low' },
        },
        {
          // Round-robin intent: the host must rotate its cursor across turns.
          id: 'sweep-touch',
          meaning: '轮流扫过',
          regions: ['whole-body'],
          distribution: 'round-robin',
          suggest: { preset: 'steady', durationSec: 4, strength: 'low' },
        },
      ],
    }),
    'waveforms/saw-spin.json': JSON.stringify({
      name: '回旋锯齿',
      loop: true,
      sensation: '细密先拍',
      frames: ['0A0A0A0A50505050', '1010101064646464'],
    }),
    // A non-loop asset: its short authored duration must stay short (the
    // sustain rule only raises `loop: true` textures).
    'waveforms/stinger.json': JSON.stringify({
      name: '短刺',
      loop: false,
      frames: ['1E1E1E1E64646464'],
    }),
  }))
  return cachedTentaclePack
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

interface HarnessOptions {
  /** Mock device channels; defaults to the two plain pulse channels. */
  readonly channels?: readonly Channel[]
  /** Hook run by the scripted runner before its tool calls (fault injection). */
  readonly beforeCall?: (request: ModelTurnRequest) => void
  /** Engine tuning forwarded to the session environment. */
  readonly engineConfig?: Partial<EngineConfig>
}

/** Build a real registry (mock devices) + scripted model + in-memory audit. */
async function createHarness(
  turns: readonly ModelTurnResult[],
  pack?: LoadedPack,
  options?: HarnessOptions,
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
    channels: options?.channels ?? [
      { id: 'a', kind: 'level', label: 'A 通道' },
      { id: 'b', kind: 'level', label: 'B 通道' },
    ],
  }))
  await registry.connect('mock-pulse', new AbortController().signal)

  const runner = new ScriptedRunner(turns, true, options?.beforeCall)
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
    ...(options?.engineConfig === undefined ? {} : { engineConfig: options.engineConfig }),
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
      scriptedTurn('这次他没有退。', [planCall('call_2')]),
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
    const h = await createHarness([
      scriptedTurn('第一次。', [planCall()]),
      scriptedTurn('第二次。', [planCall('call_2')]),
    ])

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
    // A legacy interval is the fixed `[15, 15]` window.
    expect(started.autopilot).toMatchObject({
      enabled: true,
      intervalSec: 15,
      minSec: 10,
      maxSec: 60,
      windowMinSec: 15,
      windowMaxSec: 15,
    })

    const changed = await h.host.setAutopilot({ enabled: false, intervalSec: 45 })
    expect(changed.autopilot).toMatchObject({
      enabled: false,
      intervalSec: 45,
      windowMinSec: 45,
      windowMaxSec: 45,
    })
    await h.host.end('completed')
  })

  it('applies an autopilot pacing window at start and live', async () => {
    const h = await createHarness([
      scriptedTurn('第一句。', [planCall()]),
      scriptedTurn('第二句。', [planCall('call_2')]),
    ])

    const started = await h.host.start({
      packId: 'demo',
      plannedMinutes: 30,
      autopilot: { enabled: true, windowMinSec: 10, windowMaxSec: 30 },
    })
    expect(started.autopilot).toMatchObject({
      enabled: true,
      minSec: 10,
      maxSec: 60,
      windowMinSec: 10,
      windowMaxSec: 30,
    })
    // The pending delay is sampled inside the human window.
    expect(started.autopilot.intervalSec).toBeGreaterThanOrEqual(10)
    expect(started.autopilot.intervalSec).toBeLessThanOrEqual(30)

    // A variable window is randomised by the engine, and the prompt says so.
    const variablePrompt = h.runner.requests[0]?.messages
      .find(message => message.role === 'system')?.content ?? ''
    expect(variablePrompt).toContain('自动运行节奏区间：10–30s')
    expect(variablePrompt).toContain('不写则由引擎在区间内随机')
    expect(variablePrompt).not.toContain('自动运行等待：固定')

    const changed = await h.host.setAutopilot({
      enabled: true,
      windowMinSec: 20,
      windowMaxSec: 40,
    })
    expect(changed.autopilot).toMatchObject({ windowMinSec: 20, windowMaxSec: 40 })
    expect(changed.autopilot.intervalSec).toBeGreaterThanOrEqual(20)
    expect(changed.autopilot.intervalSec).toBeLessThanOrEqual(40)

    // Engine bounds clamp a window wider than the absolute 10–60 s band.
    const clamped = await h.host.setAutopilot({ enabled: true, windowMinSec: 5, windowMaxSec: 120 })
    expect(clamped.autopilot).toMatchObject({ windowMinSec: 10, windowMaxSec: 60 })

    // Malformed windows are caller errors, not 500s.
    for (const bad of [
      { enabled: true, windowMinSec: 10 },
      { enabled: true, windowMinSec: 30, windowMaxSec: 10 },
      { enabled: true, windowMinSec: -1, windowMaxSec: 20 },
    ] as const) {
      await expect(h.host.setAutopilot(bad)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    }
    await h.host.end('completed')
  })

  it('adopts the plan nextTurnAfterSec as the next autopilot delay', async () => {
    const h = await createHarness([
      scriptedTurn('第一句。', [pacedPlanCall(25)]),
      scriptedTurn('第二句。', [planCall('call_2')]),
    ])
    await h.host.start({
      packId: 'demo',
      plannedMinutes: 30,
      autopilot: { enabled: true, windowMinSec: 10, windowMaxSec: 30 },
    })
    // The opening plan suggested 25 s; the engine consumes it once for the
    // pending tick, so the live snapshot shows the adopted delay.
    expect(h.host.snapshot()?.autopilot.intervalSec).toBe(25)
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

    // `GET /api/snapshot` decorates the channels with the model-requested band
    // percent the session tracks (fixture plan: probe-touch, strength low → 40).
    const requested = runtime.play.requestedPercents()
    expect(Object.values(requested)).toContain(40)
    const [requestedKey, requestedValue] = Object.entries(requested)[0]!
    const [requestedDeviceId, requestedChannelId] = requestedKey.split(':')
    const decoratedSnapshot = await (await get('/api/snapshot')).json() as {
      devices: readonly {
        id: string
        channels: readonly { id: string; requestedPercent?: number }[]
      }[]
    }
    const requestedChannel = decoratedSnapshot.devices
      .find(device => device.id === requestedDeviceId)?.channels
      .find(channel => channel.id === requestedChannelId)
    expect(requestedChannel?.requestedPercent).toBe(requestedValue)

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

    // A pacing window is accepted and reflected by the live snapshot.
    const windowed = await post('/api/session/autopilot', {
      enabled: true,
      windowMinSec: 10,
      windowMaxSec: 30,
    })
    expect(windowed.status).toBe(200)
    expect((await windowed.json() as { autopilot: Record<string, unknown> }).autopilot)
      .toMatchObject({ windowMinSec: 10, windowMaxSec: 30 })
    expect(await (await get('/api/session')).json()).toMatchObject({
      autopilot: { windowMinSec: 10, windowMaxSec: 30 },
    })
    // A half/window-inverted request is a caller error.
    expect((await post('/api/session/autopilot', { enabled: true, windowMinSec: 10 })).status).toBe(400)
    expect((await post('/api/session/autopilot', {
      enabled: true,
      windowMinSec: 30,
      windowMaxSec: 10,
    })).status).toBe(400)
    expect((await post('/api/session/autopilot', { enabled: true, windowMinSec: 'x' })).status).toBe(400)

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

    // A fresh start accepts a pacing window in its autopilot payload too.
    const restarted = await post('/api/session/start', {
      packId: 'demo',
      plannedMinutes: 30,
      autopilot: { enabled: true, windowMinSec: 10, windowMaxSec: 30 },
    })
    expect(restarted.status).toBe(200)
    expect(await restarted.json()).toMatchObject({
      autopilot: { enabled: true, windowMinSec: 10, windowMaxSec: 30 },
    })
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
        scriptedTurn('第二句。', [planCall('call_2')]),
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
      turns: [scriptedTurn('第一局。', [planCall()]), scriptedTurn('第二回合。', [planCall('call_2')])],
      backing,
      clock,
    })
    const first = await crashed.host.start({ packId: 'demo', plannedMinutes: 30 })
    clock.advance(18 * 60_000)
    await crashed.host.message('我还在。')
    // Quit without end(): the open marker and the active snapshot survive.
    crashed.host.dispose()

    const restarted = await createArchivedHarness({
      turns: [scriptedTurn('重新开始。', [planCall()])],
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
    const firstRun = await createArchivedHarness({
      turns: [scriptedTurn('冷。', [planCall()])],
      pack,
      backing,
    })
    await firstRun.host.start({ packId: 'demo', plannedMinutes: 45 })
    expect(firstRun.runner.requests[0]!.messages[0]!.content).not.toContain('开场指引')
    await firstRun.host.end('left_early')

    // The next session reads the ledger and receives the brief.
    const secondRun = await createArchivedHarness({
      turns: [scriptedTurn('你回来了。', [planCall()])],
      pack,
      backing,
    })
    await secondRun.host.start({ packId: 'demo', plannedMinutes: 45 })
    const system = secondRun.runner.requests[0]!.messages[0]!.content
    expect(system).toContain('开场指引')
    expect(system).toContain('cold')
    expect(system).toContain('soothe')
    await secondRun.host.end('stop')

    // A pack that does not read the ledger stays neutral even with entries.
    const silentRun = await createArchivedHarness({
      turns: [scriptedTurn('嗯。', [planCall()])],
      backing,
    })
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
    expect(system).toContain('whole-body=全身')
    expect(system).toContain('已就位部位：hands')
    // A pack recommendation with no ready channel behind it is not a target:
    // 肩背 stays out of the menu, so the model cannot aim at hardware that is
    // not there (the audit's "部位输出只偶尔出现" root cause).
    expect(system).not.toContain('shoulders=肩背')
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
    expect(beat.regions.items.enum).toEqual(['whole-body', 'hands'])

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
    // Auto mode names its live pacing window and carries the only
    // `nextTurnAfterSec` mention (it has no effect in manual mode); the
    // one-beat-per-channel rule is part of the global turn protocol too.
    // This session uses a *fixed* 10 s window: no random wording.
    expect(system).toContain('自动运行等待：固定 10s')
    expect(system).toContain('可在 apply_plan.nextTurnAfterSec 给下一回合等待建议')
    expect(system).not.toContain('随机')
    expect(system).not.toContain('自动运行节奏区间')
    expect(system).toContain('同一通道一回合最多一个 beat')
    expect(system).toContain('superseded')
    await h.host.end('completed')

    // The engine default (no interval/window given) is the fixed 20–20 s
    // window, so the prompt must say 固定 rather than promising a random pick.
    const defaults = await createHarness([scriptedTurn('默认。', [planCall()])])
    await defaults.host.start({
      packId: 'demo',
      plannedMinutes: 30,
      autopilot: { enabled: true },
    })
    const defaultPrompt = defaults.runner.requests[0]?.messages
      .find(message => message.role === 'system')?.content ?? ''
    expect(defaultPrompt).toContain('自动运行等待：固定 20s')
    expect(defaultPrompt).not.toContain('随机')
    await defaults.host.end('completed')
  })

  it('does not wait forever on a choice in autopilot mode', async () => {
    const h = await createHarness([
      scriptedTurn('开场带选项。', [choicePlanCall()]),
      scriptedTurn('超时后继续。', [planCall('call_2')]),
    ])
    await h.host.start({
      packId: 'demo',
      plannedMinutes: 30,
      autopilot: { enabled: true, intervalSec: 10 },
    })
    expect(h.host.snapshot()?.choices).toHaveLength(1)
    // The choice timeout follows the auto interval (10s here). It is passive:
    // no player decision is fabricated, the menu expires and the next turn opens.
    h.clock.advance(10_000)
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
      scriptedTurn('开场。', [planCall()]),
      scriptedTurn('自动回合。', [planCall('call_2')]),
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
    const h = await createHarness([
      scriptedTurn('第一句。', [planCall()]),
      scriptedTurn('第二句。', [planCall('call_2')]),
    ])
    await h.host.start({ packId: 'demo', plannedMinutes: 30 })

    const opening = h.runner.requests[0]?.messages.find(message => message.role === 'system')?.content ?? ''
    expect(opening).toContain('## 工具与输出协议（本回合必须）')
    expect(opening).toContain('narration')
    expect(opening).toContain('开场回合')
    expect(opening).toContain('不要调用它们')
    // The player's own part names are the only legal regions (whole-body is
    // the wildcard), and a prose-only turn is called out as producing nothing.
    expect(opening).toContain('已就位部位')
    expect(opening).toContain('不要使用没有出现在「已就位部位」里的内容包 id')
    // Device/channel ids are not visible to the model: targets are forbidden and
    // a wrong device id falls back to region matching (resolver fallback).
    expect(opening).toContain('设备/通道 id 对模型不可见')
    expect(opening).toContain('不要使用 beats[].targets')
    expect(opening).toContain('写错设备 id 的 beat 会回退到 regions')
    expect(opening).toContain('只写正文')
    // Raw provider/tool marker syntax must never leak into the player-visible
    // prose (some providers stream DSML/parameter tags into the text).
    expect(opening).toContain('正文只输出给玩家看的叙事')
    expect(opening).toContain('不要输出 <|...|>、DSML、工具调用语法、parameter/invoke 或任何特殊 token')
    // Band-percent semantics, continuation-by-default and the loop-order
    // rule are global directives (manual and auto mode both need them). The
    // model's own percentage scale is 0–100 with no concrete cap number: the
    // mapping into the human's soft range happens client-side.
    expect(opening).toContain('strength 档位：low=40%、med=70%、high=100%')
    expect(opening).toContain('100% = 玩家设定的通道上限')
    expect(opening).toContain('具体数值不向模型暴露')
    expect(opening).toContain('普通接触用 med')
    expect(opening).toContain('targetPercent 是 0–100 的区间百分比')
    expect(opening).toContain('请直接给普通强度 40–70 这样的区间百分比')
    expect(opening).toContain('不要用 5–20 这类过小值')
    expect(opening).toContain('deltaPercent 只用于微调')
    expect(opening).not.toContain('上限 20 时输出 10')
    expect(opening).toContain('本回合未提及的通道默认延续上一回合输出')
    expect(opening).toContain('不再刺激某个部位时必须用 stop 意图')
    expect(opening).toContain('loop 输出只能放在最后一拍')
    // The one-beat-per-channel rule is a *global* director constraint (manual
    // mode hits duplicate merges too), so it lives in the mandatory turn
    // protocol — not in the autopilot-only block.
    expect(opening).toContain('同一通道一回合最多一个 beat')
    expect(opening).toContain('superseded')
    // `nextTurnAfterSec` only matters in auto mode: the pacing-window line
    // (absent here) carries it, the one-beat rule must not advertise it.
    expect(opening).not.toContain('nextTurnAfterSec')
    // The pacing window is auto-mode state and must not leak into manual turns.
    expect(opening).not.toContain('自动运行节奏区间')
    const applyPlan = h.runner.requests[0]?.tools.find(tool => tool.name === 'apply_plan')
    const properties = (applyPlan?.parameters as { properties: Record<string, unknown> }).properties
    expect(properties).toHaveProperty('narration')

    // The scene/background requirement is opening-only; later turns still get
    // the narration contract but not the opening instruction.
    await h.host.message('继续。')
    const second = h.runner.requests[1]?.messages.find(message => message.role === 'system')?.content ?? ''
    expect(second).toContain('narration')
    expect(second).toContain('同一通道一回合最多一个 beat')
    expect(second).toContain('设备/通道 id 对模型不可见')
    expect(second).toContain('本回合未提及的通道默认延续上一回合输出')
    expect(second).not.toContain('nextTurnAfterSec')
    expect(second).not.toContain('自动运行节奏区间')
    expect(second).not.toContain('开场回合')
    await h.host.end('stop')
  })

  it('adds player-named parts to the session vocabulary', async () => {
    const h = await createHarness([scriptedTurn('好。', [planCall()])], await narrativePack())
    // v6: the player may name a part freely; it becomes a region key the model
    // can target. Since v10 the prompt offers *only* reachable parts, so the
    // pack's other recommendations (no channel behind them) leave the menu.
    await h.host.setRegion('mock-pulse', 'b', '左胸')
    await h.host.start({ packId: 'narrative', plannedMinutes: 30 })

    const system = h.runner.requests[0]?.messages.find(message => message.role === 'system')?.content ?? ''
    expect(system).toContain('左胸=左胸')
    expect(system).toContain('已就位部位：左胸')
    // The pack vocabulary is not offered as a substitute for the player's part.
    expect(system).not.toContain('hands=手')
    expect(system).not.toContain('shoulders=肩背')

    const applyPlan = h.runner.requests[0]?.tools.find(tool => tool.name === 'apply_plan')
    const beat = (applyPlan!.parameters as {
      properties: { beats: { items: { properties: { regions: { items: { enum: readonly string[] } } } } } }
    }).properties.beats.items.properties
    expect(beat.regions.items.enum).toEqual(['whole-body', '左胸'])

    await h.host.end('stop')
  })
})

// ── Audit regressions: packed waveforms, player parts, real effect rows ────

/** The `apply_plan` region enum the model is actually offered this turn. */
function regionsEnumOf(request: ModelTurnRequest): readonly string[] {
  const applyPlan = request.tools.find(tool => tool.name === 'apply_plan')
  const beat = (applyPlan!.parameters as {
    properties: { beats: { items: { properties: { regions: { items: { enum: readonly string[] } } } } } }
  }).properties.beats.items.properties
  return beat.regions.items.enum
}

describe('packed waveforms, player parts and true effect rows (audit fixes)', () => {
  /** The pulse pair that can actually play a waveform (Coyote-like). */
  const waveformChannels: readonly Channel[] = [
    { id: 'a', kind: 'level', label: 'A 通道', supportsWaveform: true },
    { id: 'b', kind: 'level', label: 'B 通道', supportsWaveform: true },
  ]

  it('registers pack waveforms so a packed id survives dispatch', async () => {
    const h = await createHarness(
      [
        // The audit's model used the bare asset id (`saw-spin`).
        scriptedTurn('（细密的电流贴着皮肤散开。）', [waveformPlanCall('saw-spin')]),
        // The waveform menu advertises the namespaced id; both must work.
        scriptedTurn('（纹理换了方向。）', [waveformPlanCall('tentacle:saw-spin', 'call_wave_2')]),
      ],
      await tentaclePack(),
      { channels: waveformChannels },
    )

    const started = await h.host.start({ packId: 'tentacle', plannedMinutes: 30 })
    expect(started.state).toBe('idle')
    // The registry dispatches through its own WaveformLibrary, not the
    // executor's pack-aware lookup; the asset must be in the session scratch
    // there, or dispatch rejects with `UNKNOWN_WAVEFORM` (the audit's turn
    // 1/2/4). PlaySession.start registers every pack waveform.
    expect(h.env.waveforms.get('tentacle:saw-spin')?.name).toBe('回旋锯齿')

    // No ready channel carries a label here. The menu must NOT fall back to the
    // pack's recommended ids: the resolver cannot match them, so they only
    // produce the "drive every channel" fallback and the audit's 文不对部位
    // symptom. The only legal target is the wildcard, which still drives all
    // channels.
    const request = h.runner.requests[0]!
    const system = request.messages.find(message => message.role === 'system')?.content ?? ''
    expect(system).toContain('可用部位：whole-body=全身（作用于全部通道）')
    expect(system).toContain('已就位部位：无')
    expect(system).not.toContain('inner-thigh=')
    expect(regionsEnumOf(request)).toEqual(['whole-body'])

    const opening = h.host.transcript()[0]!
    expect(opening.text).toContain('细密')
    // One whole-body beat over two channels is two rows: the dedupe key
    // includes device+channel, so different parts are never merged.
    expect(opening.effects).toHaveLength(2)
    expect(opening.effects.map(effect => effect.channelId)).toEqual(['a', 'b'])
    for (const effect of opening.effects) {
      expect(effect).toMatchObject({
        deviceId: 'mock-pulse',
        status: 'dispatched',
        waveformId: 'tentacle:saw-spin',
        waveformName: '回旋锯齿',
        // `strength: 'low'` is 40 % of the channel's soft band (0–20) → 8 %.
        percent: 8,
      })
    }
    expect(planActions(h.records()).every(action => action.status !== 'rejected')).toBe(true)
    expect(h.records().some(record => record.action === 'run_pattern' && record.result === 'rejected'))
      .toBe(false)

    // The namespaced id the prompt's waveform menu advertises works too.
    await h.host.message('继续。')
    const second = h.host.transcript()[1]!
    expect(second.effects.map(effect => effect.waveformId))
      .toEqual(['tentacle:saw-spin', 'tentacle:saw-spin'])
    const patternWrites = h.records().filter(record => record.action === 'run_pattern')
    expect(patternWrites.length).toBeGreaterThan(0)
    expect(patternWrites.every(record => record.result === 'ok')).toBe(true)

    await h.host.end('stop')
    // Session scratch is per session: disposing it discards the pack assets.
    h.host.dispose()
    expect(h.env.waveforms.get('tentacle:saw-spin')).toBeUndefined()
  })

  it('keeps human session waveforms across start and a session boundary', async () => {
    const h = await createHarness([scriptedTurn('好。', [planCall()])])
    // The device page imports waveforms into the session scratch before 开局
    // (a human path, not a pack asset). `start` must not wipe them, and
    // `dispose` may only remove the pack assets this session registered.
    const imported = h.env.waveforms.importFrames('人类导入波', ['0A0A0A0A50505050'])
    expect(h.env.waveforms.get(imported.id)?.name).toBe('人类导入波')

    await h.host.start({ packId: 'demo', plannedMinutes: 30 })
    expect(h.env.waveforms.get(imported.id)?.name).toBe('人类导入波')

    await h.host.end('stop')
    h.host.dispose()
    // The freeform pack registered no asset, so dispose removes nothing; the
    // human import lives until host shutdown clears the scratch by design.
    expect(h.env.waveforms.get(imported.id)?.name).toBe('人类导入波')
  })

  it('keeps a human waveform when the next start disposes the old session', async () => {
    const h = await createHarness([
      scriptedTurn('第一局。', [planCall()]),
      scriptedTurn('第二局。', [planCall('call_2')]),
    ])
    await h.host.start({ packId: 'demo', plannedMinutes: 30 })
    // Imported while the old session exists: 结束 then 开局 disposes the old
    // session, and that cleanup must not delete the human waveform (P1-4R).
    const imported = h.env.waveforms.importFrames('局中导入', ['0A0A0A0A50505050'])
    await h.host.end('stop')

    await h.host.start({ packId: 'demo', plannedMinutes: 30 })
    expect(h.env.waveforms.get(imported.id)?.name).toBe('局中导入')
    await h.host.end('stop')
    h.host.dispose()
  })

  it('routes a pack region id through the player label and reports that label', async () => {
    const h = await createHarness(
      [scriptedTurn('（指腹压在那处。）', [regionPlanCall('inner-thigh')])],
      await tentaclePack(),
    )
    // Exactly the words in the audit's state/regions.json.
    await h.host.setRegion('mock-pulse', 'a', '阴蒂')
    await h.host.setRegion('mock-pulse', 'b', '小穴')
    await h.host.start({ packId: 'tentacle', plannedMinutes: 30 })

    const opening = h.host.transcript()[0]!
    expect(opening.effects).toHaveLength(1)
    expect(opening.effects[0]).toMatchObject({
      deviceId: 'mock-pulse',
      channelId: 'a',
      region: '阴蒂',
      regionLabel: '阴蒂',
      // targetPercent 20 is 20 % of the soft band (0–20) → 4 % actual output;
      // only the *route* (alias) is new.
      percent: 4,
      status: 'dispatched',
    })
    // The action really landed on the aliased channel; the "every online
    // channel" fallback would have driven b too and marked it degraded.
    const actions = planActions(h.records())
    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({ channelId: 'a', status: 'dispatched' })
    const resolved = h.records().find(record => record.action === 'plan_resolved')
    expect((resolved?.detail as { readonly warnings?: readonly string[] } | undefined)?.warnings?.join('\n') ?? '')
      .not.toContain('falling back')
  })

  it('offers only player-named parts that a ready channel can reach', async () => {
    const h = await createHarness(
      [scriptedTurn('（试探。）', [regionPlanCall('whole-body')])],
      await tentaclePack(),
    )
    await h.host.setRegion('mock-pulse', 'a', '阴蒂')
    await h.host.setRegion('mock-pulse', 'b', '乳房')
    await h.host.start({ packId: 'tentacle', plannedMinutes: 30 })

    const request = h.runner.requests[0]!
    const system = request.messages.find(message => message.role === 'system')?.content ?? ''
    expect(system).toContain('可用部位')
    expect(system).toContain('whole-body=全身')
    expect(system).toContain('已就位部位：阴蒂、乳房')
    // The pack's recommended ids are not a substitute for the player's words.
    expect(system).not.toContain('inner-thigh=')
    expect(system).not.toContain('waist=')
    expect(regionsEnumOf(request)).toEqual(['whole-body', '阴蒂', '乳房'])
  })

  it('keeps fallback dispatch rows in the effect box, deduplicated', async () => {
    const h = await createHarness(
      [scriptedTurn('（动作落到没有标注的地方。）', [fallbackPlanCall()])],
      await tentaclePack(),
    )
    await h.host.setRegion('mock-pulse', 'a', '小穴')
    await h.host.setRegion('mock-pulse', 'b', '后穴')
    await h.host.start({ packId: 'tentacle', plannedMinutes: 30 })

    // `waist` has no channel and no alias, so the resolver falls back to both
    // ready channels and marks each command `no-region-match`. v9 filtered
    // exactly these successful dispatches out of the effect box.
    const effects = h.host.transcript()[0]!.effects
    expect(effects.map(effect => effect.channelId)).toEqual(['a', 'b'])
    expect(effects.map(effect => effect.regionLabel)).toEqual(['小穴', '后穴'])
    expect(effects.every(effect => effect.status === 'degraded')).toBe(true)
    // Two beats requested the same region; the resolver merges same-channel
    // commands (keep the last body), so each channel dispatched exactly one
    // command. Both channels still get a row in the effect box — the old v9
    // filter hid them entirely.
    expect(planActions(h.records())).toHaveLength(2)
  })

  it('rotates round-robin intents across turns', async () => {
    const h = await createHarness(
      [
        scriptedTurn('（第一拍。）', [rotationPlanCall('call_1')]),
        scriptedTurn('（第二拍。）', [rotationPlanCall('call_2')]),
      ],
      await tentaclePack(),
    )
    // The rig is unlabelled: whole-body is the only legal region and both
    // ready channels match it, so the intent's round-robin distribution picks
    // exactly one channel per turn.
    await h.host.start({ packId: 'tentacle', plannedMinutes: 30 })
    const first = h.host.transcript()[0]!
    expect(first.effects).toHaveLength(1)

    await h.host.message('继续。')
    const second = h.host.transcript()[1]!
    expect(second.effects).toHaveLength(1)

    // Per-turn rotation: the same plan lands on the other ready channel next
    // turn instead of pinning `a` forever (roundRobinCursor was never supplied
    // by the host before, so production never rotated).
    expect(first.effects[0]).toMatchObject({ deviceId: 'mock-pulse', channelId: 'a' })
    expect(second.effects[0]).toMatchObject({ deviceId: 'mock-pulse', channelId: 'b' })
  })

  it('advances one rotation step for a plan with two round-robin beats', async () => {
    const h = await createHarness(
      [
        scriptedTurn('（第一拍。）', [doubleRotationPlanCall('call_1')]),
        scriptedTurn('（第二拍。）', [doubleRotationPlanCall('call_2')]),
      ],
      await tentaclePack(),
    )
    await h.host.start({ packId: 'tentacle', plannedMinutes: 30 })
    // Both beats of one plan share the turn's cursor, so both would pick `a`;
    // the resolver then merges their same-channel commands into one dispatch.
    expect(planActions(h.records()).map(action => action.channelId)).toEqual(['a'])

    await h.host.message('继续。')
    // The turn advances the cursor by exactly one (not by the beat count):
    // turn 2 = b. With +2 per turn an even pool would stay on `a` forever.
    expect(planActions(h.records()).slice(1).map(action => action.channelId)).toEqual(['b'])
  })

  it('does not jump channels when a no-plan turn is interleaved', async () => {
    const h = await createHarness(
      [
        scriptedTurn('（第一拍。）', [rotationPlanCall('call_1')]),
        // Both attempts omit apply_plan: the turn settles with no plan and no
        // dispatch, so it must not consume a rotation slot.
        scriptedTurn('（沉默。）'),
        scriptedTurn('（还是没有计划。）'),
        scriptedTurn('（第三拍。）', [rotationPlanCall('call_3')]),
      ],
      await tentaclePack(),
    )
    await h.host.start({ packId: 'tentacle', plannedMinutes: 30 })
    expect(h.host.transcript()[0]!.effects[0]).toMatchObject({ channelId: 'a' })

    await h.host.message('继续。')
    const noPlan = h.host.transcript()[1]!
    expect(noPlan.effects).toHaveLength(0)

    await h.host.message('继续。')
    const third = h.host.transcript()[2]!
    // Strict alternation across round-robin turns: a → (no plan) → b. The
    // no-plan turn must not move the cursor back onto `a`.
    expect(third.effects[0]).toMatchObject({ channelId: 'b' })
  })

  it('corrects a prose-only reply until apply_plan is dispatched', async () => {
    const h = await createHarness(
      [
        scriptedTurn('（他写了正文，但没有给动作。）'),
        scriptedTurn('（这一次动作真的落下去。）', [regionPlanCall('whole-body')]),
      ],
      await tentaclePack(),
    )
    await h.host.setRegion('mock-pulse', 'a', '小穴')
    await h.host.start({ packId: 'tentacle', plannedMinutes: 30 })

    // One settled turn, two model requests: the second is the correction.
    expect(h.runner.requests).toHaveLength(2)
    const first = h.runner.requests[0]!
    const retry = h.runner.requests[1]!
    expect(retry.messages.length).toBeGreaterThan(first.messages.length)
    const correction = retry.messages.at(-1)
    expect(correction?.role).toBe('user')
    expect(correction?.content).toContain('apply_plan')
    // The retry's line and plan are the turn's results: prose-only turns no
    // longer settle with nothing on the hardware.
    expect(h.host.snapshot()?.state).toBe('idle')
    expect(h.host.transcript()).toHaveLength(1)
    expect(h.host.transcript()[0]!.text).toContain('动作真的落下去')
    expect(h.host.transcript()[0]!.effects.length).toBeGreaterThan(0)
    expect(planActions(h.records()).some(action => action.status === 'dispatched')).toBe(true)
  })

  it('keeps the effect box when a plan dispatched but the write failed', async () => {
    const h = await createHarness(
      // Tool-call providers can return a plan with neither `content` nor
      // `narration`: the write fails while the actions are authorised.
      [scriptedTurn('', [regionPlanCall('whole-body')])],
      await tentaclePack(),
    )
    await h.host.start({ packId: 'tentacle', plannedMinutes: 30 })

    // §3 of the writer contract: a failed write settles with the template line
    // and the actions still run. The transcript must therefore keep the turn
    // (and its effect box) instead of silently dropping it.
    const entries = h.host.transcript()
    expect(entries).toHaveLength(1)
    expect(entries[0]!.text).toBe('（短暂停顿）')
    expect(entries[0]!.effects.length).toBeGreaterThan(0)
    expect(entries[0]!.effects.every(effect => effect.status !== 'rejected')).toBe(true)
    // The player-visible snapshot shows the same placeholder, and the host did
    // not invent a `plan_fallback` audit line for a turn that really executed.
    expect(h.host.snapshot()?.lastLine).toBe('（短暂停顿）')
    expect(h.records().some(record => record.action === 'plan_fallback')).toBe(false)
  })
})

// ── Continuity hold + default waveform (user feedback 4/5/6) ───────────────

describe('continuity hold while the model thinks', () => {
  /** Two pulse channels that can actually play a waveform (Coyote-like). */
  const waveformChannels: readonly Channel[] = [
    { id: 'a', kind: 'level', label: 'A 通道', supportsWaveform: true },
    { id: 'b', kind: 'level', label: 'B 通道', supportsWaveform: true },
  ]

  it('holds the last output before the next turn and lets the plan override it', async () => {
    const h = await createHarness([
      scriptedTurn('（第一回合。）', [holdPlanCall(100)]),
      scriptedTurn('（第二回合。）', [planCall('call_2')]),
    ])
    await h.host.start({ packId: 'demo', plannedMinutes: 30 })
    // targetPercent 100 is the top of the soft band → the channel's 20 % cap;
    // the synced ambient intent drove both ready channels.
    expect(h.host.transcript()[0]!.effects.map(effect => effect.percent)).toEqual([20, 20])

    // Let the plan's own 3 s hold expire: only then is there a gap for the
    // continuity hold to bridge.
    h.clock.advance(4_000)
    await h.host.message('继续。')

    const records = h.records()
    const holds = holdRecords(records)
    // One hold per channel, bounded by min(30, channel.maxDurationSec), and it
    // replays the original body (a 20 % level), not a host-made value.
    expect(holds.length).toBeGreaterThanOrEqual(2)
    for (const hold of holds.slice(0, 2)) {
      expect(hold.action).toBe('set_level')
      expect(hold.detail).toMatchObject({ percent: 20 })
      const durationSec = (hold.detail as { durationSec?: number }).durationSec
      expect(durationSec).toBeGreaterThan(0)
      expect(durationSec).toBeLessThanOrEqual(30)
    }
    // The hold belongs to the *second* turn and precedes its plan commands, so
    // the model's thinking time is bridged before any new effect starts.
    const turn = recordsOfLastTurn(records)
    const firstHold = turn.findIndex(record => holds.includes(record))
    const firstPlanCommand = turn.findIndex(record => record.actor === 'model')
    expect(firstHold).toBeGreaterThanOrEqual(0)
    expect(firstPlanCommand).toBeGreaterThan(firstHold)

    // The new plan overrides the held channel: `probe-touch` is `primary`, so
    // it drives channel a only; low strength is 40 % of the band → 8 %.
    const second = h.host.transcript()[1]!
    expect(second.effects).toHaveLength(1)
    expect(second.effects[0]).toMatchObject({ channelId: 'a', percent: 8 })
  })

  it('does not hold a channel that was explicitly stopped', async () => {
    const h = await createHarness([
      // Turn 1 raises both channels for 60 s (still running at turn 2, so no
      // hold is needed there); turn 2 stops them explicitly; turn 3 must not
      // revive anything.
      scriptedTurn('（起。）', [holdPlanCall(100, 60)]),
      scriptedTurn('（停。）', [stopPlanCall('call_stop')]),
      scriptedTurn('（下一回合。）', [planCall('call_3')]),
    ])
    await h.host.start({ packId: 'demo', plannedMinutes: 30 })
    expect(holdRecords(h.records())).toHaveLength(0)

    await h.host.message('继续。')
    // The explicit stop is recorded in the effect box as percent 0 on both
    // channels (the level was still running, hence no hold at this turn start).
    const stopped = h.host.transcript()[1]!
    expect(stopped.effects.map(effect => effect.percent)).toEqual([0, 0])

    await h.host.message('继续。')
    // A stop removes the continuation state: the next turn must not revive it.
    expect(holdRecords(h.records())).toHaveLength(0)
    expect(h.host.transcript()).toHaveLength(3)
  })

  it('does not restart an effect that still covers the think time', async () => {
    const long = await createHarness([
      scriptedTurn('（长效果。）', [holdPlanCall(100, 60)]),
      scriptedTurn('（下一回合。）', [planCall('call_2')]),
    ])
    await long.host.start({ packId: 'demo', plannedMinutes: 30 })
    await long.host.message('继续。')
    // A 60 s command accepted a moment ago still covers the generation window:
    // there is no gap to bridge, so restarting it would only duplicate/lengthen.
    expect(holdRecords(long.records())).toHaveLength(0)

    const short = await createHarness([
      scriptedTurn('（短效果。）', [holdPlanCall(100, 3)]),
      scriptedTurn('（下一回合。）', [planCall('call_2')]),
    ])
    await short.host.start({ packId: 'demo', plannedMinutes: 30 })
    // The 3 s effect has already expired when the next turn starts: bridge it.
    short.clock.advance(4_000)
    await short.host.message('继续。')
    expect(holdRecords(short.records()).length).toBeGreaterThanOrEqual(2)
  })

  it('keeps continuing an unmentioned channel past the old 90 s TTL', async () => {
    const h = await createHarness([
      scriptedTurn('（很旧的一拍。）', [holdPlanCall(100, 3)]),
      scriptedTurn('（很久以后。）', [planCall('call_2')]),
    ])
    await h.host.start({ packId: 'demo', plannedMinutes: 30 })
    // User rule: unmentioned channels continue until an explicit stop — there
    // is no age limit, so an old body is still replayed.
    h.clock.advance(91_000)
    await h.host.message('继续。')
    expect(holdRecords(h.records()).length).toBeGreaterThanOrEqual(2)
  })

  it('does not replay human direct control', async () => {
    const h = await createHarness([
      scriptedTurn('（起。）', [holdPlanCall(100, 3)]),
      scriptedTurn('（下一回合。）', [planCall('call_2')]),
    ])
    await h.host.start({ packId: 'demo', plannedMinutes: 30 })
    h.clock.advance(4_000)

    // The human drives channel a from the device page after the plan ran: that
    // becomes the channel's truth, so its plan body must be dropped and the
    // next turn must not overwrite the human's level.
    await h.registry.setLevel('human', {
      deviceId: 'mock-pulse',
      channelId: 'a',
      percent: 15,
      durationSec: 5,
    })
    expect(h.records().some(record =>
      record.action === 'set_level' && record.actor === 'human')).toBe(true)

    await h.host.message('继续。')
    // Only channel b still continues the plan's 20 %; a keeps the human level.
    const holds = holdRecords(h.records())
    expect(holds).toHaveLength(1)
    expect(holds[0]!.detail).toMatchObject({ channelId: 'b', percent: 20 })
    expect(h.host.transcript()).toHaveLength(2)
  })

  it('keeps the previous continuation when a plan is blocked', async () => {
    let lockSpy: ReturnType<typeof vi.spyOn> | undefined
    let harnessRef: Harness | undefined
    let modelCalls = 0
    const h = await createHarness(
      [
        scriptedTurn('（起。）', [holdPlanCall(100, 3)]),
        scriptedTurn('（被锁的一拍。）', [targetPercentPlanCall(50, 'call_blocked')]),
        scriptedTurn('（继续。）', [planCall('call_3')]),
      ],
      undefined,
      {
        beforeCall: () => {
          // Lock the registry only for the second dispatch, after the engine
          // already accepted the turn: the executor must report a blocked plan.
          modelCalls += 1
          if (modelCalls === 2 && harnessRef !== undefined) {
            lockSpy = vi.spyOn(harnessRef.registry, 'isLocked', 'get').mockReturnValue(true)
          }
        },
      },
    )
    harnessRef = h
    await h.host.start({ packId: 'demo', plannedMinutes: 30 })
    h.clock.advance(4_000)

    await h.host.message('继续。')
    lockSpy?.mockRestore()
    const blocked = h.records().filter(record => record.action === 'plan_resolved').at(-1)
    expect((blocked?.detail as { readonly blocked?: boolean } | undefined)?.blocked).toBe(true)
    // A blocked plan drives nothing and must not become the continuation.
    expect(h.host.transcript()[1]!.effects).toHaveLength(0)

    await h.host.message('继续。')
    // The old 20 % body is still the only continuation (never the blocked 50 %).
    const holds = holdRecords(h.records())
    expect(holds.length).toBeGreaterThan(0)
    expect(holds.every(hold =>
      (hold.detail as { readonly percent?: number }).percent === 20)).toBe(true)
  })

  it('does not continue a command the registry rejected', async () => {
    const h = await createHarness([
      scriptedTurn('（部分失败。）', [holdPlanCall(100, 3)]),
      scriptedTurn('（下一回合。）', [planCall('call_2')]),
    ])
    const original = h.registry.setLevel
    const spy = vi.spyOn(h.registry, 'setLevel').mockImplementation(
      async (...args: Parameters<typeof original>) => {
        const [actor, command] = args
        if (actor === 'model' && command.channelId === 'a') throw new Error('channel offline')
        return await original.apply(h.registry, args)
      },
    )
    await h.host.start({ packId: 'demo', plannedMinutes: 30 })
    spy.mockRestore()

    // Channel a's command was rejected, so only b actually ran/continues.
    expect(h.host.transcript()[0]!.effects.map(effect => effect.channelId)).toEqual(['b'])
    h.clock.advance(4_000)
    await h.host.message('继续。')
    const holds = holdRecords(h.records())
    expect(holds).toHaveLength(1)
    expect(holds[0]!.detail).toMatchObject({ channelId: 'b', percent: 20 })
  })

  it('keeps the old body when an explicit stop is rejected', async () => {
    const h = await createHarness([
      scriptedTurn('（起。）', [holdPlanCall(100, 60)]),
      scriptedTurn('（假停。）', [stopPlanCall('call_stop')]),
      scriptedTurn('（继续。）', [planCall('call_3')]),
    ])
    await h.host.start({ packId: 'demo', plannedMinutes: 30 })
    const original = h.registry.setLevel
    const spy = vi.spyOn(h.registry, 'setLevel').mockImplementation(
      async (...args: Parameters<typeof original>) => {
        const [actor, command] = args
        if (actor === 'model' && command.percent === 0) throw new Error('stop offline')
        return await original.apply(h.registry, args)
      },
    )
    await h.host.message('继续。')
    spy.mockRestore()

    // The rejected stop never reached the registry, so it must not erase the
    // continuation body: a later turn still continues the 20 % level.
    expect(h.host.transcript()[1]!.effects).toHaveLength(0)
    h.clock.advance(60_000)
    await h.host.message('继续。')
    const holds = holdRecords(h.records())
    expect(holds.length).toBeGreaterThan(0)
    expect(holds.every(hold =>
      (hold.detail as { readonly percent?: number }).percent === 20)).toBe(true)
  })

  it('carries the turn abort signal into the executor', async () => {
    let harnessRef: Harness | undefined
    const h = await createHarness(
      [scriptedTurn('（被抢占。）', [planCall()])],
      undefined,
      {
        engineConfig: { turnTimeoutMs: 1_000 },
        // Advance past the turn budget right before the plan is dispatched: the
        // timeout aborts the turn controller (without locking the registry), so
        // a passed-through signal must make the executor record a preempted,
        // non-dispatched plan.
        beforeCall: () => {
          harnessRef?.clock.advance(2_000)
        },
      },
    )
    harnessRef = h
    await h.host.start({ packId: 'demo', plannedMinutes: 30 })
    // The executor's audit write races the aborted turn; give it a tick to land.
    for (let i = 0; i < 5; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 0))
    }

    // The aborted signal reached the executor (P1-2): the plan is recorded as
    // preempted and nothing was dispatched.
    const resolved = h.records().filter(record => record.action === 'plan_resolved')
    expect(resolved.length).toBeGreaterThanOrEqual(1)
    expect((resolved.at(-1)?.detail as { readonly preempted?: boolean } | undefined)?.preempted)
      .toBe(true)
    expect(planActions(h.records())).toHaveLength(0)
    expect(h.registry.snapshot().devices
      .flatMap(device => device.channels)
      .every(channel => channel.percent === 0)).toBe(true)
  })

  it('holds a loop waveform with its original envelope and texture', async () => {
    const h = await createHarness(
      [
        // `cilia-tickle` suggests a `wave` envelope over the loop asset
        // (`saw-spin`), so the resolved body is NOT a steady hold.
        scriptedTurn('（循环的一拍。）', [suggestPlanCall('cilia-tickle')]),
        scriptedTurn('（下一回合。）', [planCall('call_2')]),
      ],
      await tentaclePack(),
      { channels: waveformChannels },
    )
    await h.host.start({ packId: 'tentacle', plannedMinutes: 30 })

    // Capture what the plan actually dispatched: the continuation must replay
    // this exact body, not a host-made steady envelope.
    const modelPatterns = h.records().filter(record =>
      record.action === 'run_pattern' && record.actor === 'model')
    expect(modelPatterns).toHaveLength(2)
    const body = modelPatterns[0]!.detail as {
      readonly envelope?: Record<string, unknown>
      readonly waveformId?: string
      readonly durationSec?: number
    }
    expect(body.waveformId).toBe('tentacle:saw-spin')
    expect(body.envelope?.['preset']).toBe('wave')
    // `saw-spin` is loop:true, so the resolver sustains the 10 s suggestion.
    expect(body.durationSec).toBe(60)

    h.clock.advance(61_000)
    await h.host.message('继续。')

    const holds = holdRecords(h.records()).filter(record => record.action === 'run_pattern')
    expect(holds).toHaveLength(2)
    for (const hold of holds) {
      const detail = hold.detail as {
        readonly envelope?: Record<string, unknown>
        readonly waveformId?: string
        readonly durationSec?: number
      }
      // Same envelope + same waveform; only the bridge duration is bounded.
      expect(detail.envelope).toEqual(body.envelope)
      expect(detail.waveformId).toBe('tentacle:saw-spin')
      expect(detail.durationSec).toBe(30)
    }
  })

  it('sustains loop textures and keeps non-loop durations short', async () => {
    const h = await createHarness(
      [
        // Both turns request a 5 s waveform change.
        scriptedTurn('（循环纹理。）', [waveformPlanCall('saw-spin')]),
        scriptedTurn('（短刺。）', [waveformPlanCall('stinger')]),
      ],
      await tentaclePack(),
      { channels: waveformChannels },
    )
    await h.host.start({ packId: 'tentacle', plannedMinutes: 30 })
    await h.host.message('继续。')

    const modelDurations = h.records()
      .filter(record => record.action === 'run_pattern' && record.actor === 'model')
      .map(record => (record.detail as { readonly durationSec?: number }).durationSec)
    // `saw-spin` is `loop: true`: the 5 s request is raised to
    // min(SUSTAIN_LOOP_SEC, channel maxDurationSec) = 60 on both channels.
    expect(modelDurations.slice(0, 2)).toEqual([60, 60])
    // `stinger` is `loop: false`: the authored short action keeps its 5 s.
    expect(modelDurations.slice(2)).toEqual([5, 5])
  })

  it('never blocks the turn when a hold command fails', async () => {
    const h = await createHarness([
      scriptedTurn('（第一回合。）', [holdPlanCall(100)]),
      scriptedTurn('（第二回合。）', [planCall('call_2')]),
    ])
    await h.host.start({ packId: 'demo', plannedMinutes: 30 })
    // The first held channel fails; the host must swallow it and still run the
    // turn (the hold is best-effort, never a turn failure).
    const rejected = vi.spyOn(h.registry, 'setLevel').mockRejectedValueOnce(new Error('hold failed'))
    // Past the plan's 3 s hold so the continuity hold actually runs.
    h.clock.advance(4_000)

    await h.host.message('继续。')

    expect(rejected).toHaveBeenCalled()
    expect(h.host.transcript()).toHaveLength(2)
    expect(h.host.transcript()[1]!.effects).toHaveLength(1)
    expect(planActions(h.records())).toHaveLength(3)
    expect(h.host.snapshot()?.state).toBe('idle')
  })

  it('wires the pack default waveform into the resolver fallback', async () => {
    const h = await createHarness(
      [scriptedTurn('（波形丢失的一拍。）', [waveformPlanCall('missing-wave')])],
      await tentaclePack(),
      { channels: waveformChannels },
    )
    await h.host.start({ packId: 'tentacle', plannedMinutes: 30 })

    // The pack's only waveform is the session default; an unknown reference
    // degrades to it instead of dropping the texture (the host must pass
    // `defaultWaveformId` into the resolve context).
    const opening = h.host.transcript()[0]!
    expect(opening.effects).toHaveLength(2)
    for (const effect of opening.effects) {
      expect(effect).toMatchObject({
        status: 'degraded',
        waveformId: 'tentacle:saw-spin',
        waveformName: '回旋锯齿',
      })
    }
    const resolved = h.records().find(record => record.action === 'plan_resolved')
    const warnings = (resolved?.detail as { readonly warnings?: readonly string[] } | undefined)?.warnings ?? []
    expect(warnings.join('\n')).toContain('using the session default waveform "tentacle:saw-spin"')
    expect(holdRecords(h.records())).toHaveLength(0)
  })
})

// ── Effect box: requested band percent → actual output (task-17) ──────────

describe('effect requested percent transparency', () => {
  it('shows the requested band percent next to the mapped actual percent', async () => {
    const h = await createHarness([scriptedTurn('（半档。）', [targetPercentPlanCall(50)])])
    await h.host.start({ packId: 'demo', plannedMinutes: 30 })

    // The channel's soft band is 0–20: targetPercent 50 (band midpoint) maps
    // to 10, and the effect carries both numbers for the UI.
    const effects = h.host.transcript()[0]!.effects
    expect(effects).toHaveLength(2)
    for (const effect of effects) {
      expect(effect).toMatchObject({
        requestedPercent: 50,
        percent: 10,
        status: 'dispatched',
      })
    }
    // The console projection exposes the requested factor per channel too.
    expect(h.host.requestedPercents()).toEqual({
      'mock-pulse:a': 50,
      'mock-pulse:b': 50,
    })
  })

  it('clears the requested percent on an explicit stop', async () => {
    const h = await createHarness([
      scriptedTurn('（起。）', [targetPercentPlanCall(50)]),
      scriptedTurn('（停。）', [stopPlanCall('call_stop')]),
    ])
    await h.host.start({ packId: 'demo', plannedMinutes: 30 })
    expect(h.host.requestedPercents()).toEqual({ 'mock-pulse:a': 50, 'mock-pulse:b': 50 })

    await h.host.message('继续。')
    // A stop removes the channel's continuation state *and* its last request.
    expect(h.host.requestedPercents()).toEqual({})
  })

  it('clears the requested percent on human direct control', async () => {
    const h = await createHarness([
      scriptedTurn('（起。）', [targetPercentPlanCall(50)]),
      scriptedTurn('（继续。）', [planCall('call_2')]),
    ])
    await h.host.start({ packId: 'demo', plannedMinutes: 30 })
    expect(h.host.requestedPercents()).toEqual({ 'mock-pulse:a': 50, 'mock-pulse:b': 50 })

    // Human device-page control on channel a: that channel no longer reflects
    // a model request, while channel b keeps its value (continuation).
    await h.registry.setLevel('human', {
      deviceId: 'mock-pulse',
      channelId: 'a',
      percent: 15,
      durationSec: 5,
    })
    expect(h.host.requestedPercents()).toEqual({ 'mock-pulse:b': 50 })
  })

  it('reports the strength bucket as its band percent', async () => {
    const h = await createHarness([scriptedTurn('（轻触。）', [strengthLevelPlanCall('low')])])
    await h.host.start({ packId: 'demo', plannedMinutes: 30 })

    // `strength: 'low'` is 40 % of the soft band → actual 8 on a 0–20 band.
    const effects = h.host.transcript()[0]!.effects
    expect(effects).toHaveLength(2)
    for (const effect of effects) {
      expect(effect).toMatchObject({ requestedPercent: 40, strength: 'low', percent: 8 })
    }
  })

  it('omits the request fields when the executor provides no request', async () => {
    // Simulate an old dispatch path: strip the new `request` field from every
    // action. The effect must keep working and simply omit both fields.
    const originalDispatch = PlanExecutor.prototype.dispatch
    const spy = vi.spyOn(PlanExecutor.prototype, 'dispatch').mockImplementation(
      async function (this: PlanExecutor, ...args: Parameters<typeof originalDispatch>) {
        const result = await originalDispatch.apply(this, args)
        return {
          ...result,
          actions: result.actions.map(action => {
            const { request: _request, ...rest } = action
            return rest
          }),
        }
      },
    )
    try {
      const h = await createHarness([scriptedTurn('（旧路径。）', [planCall()])])
      await h.host.start({ packId: 'demo', plannedMinutes: 30 })
      const effect = h.host.transcript()[0]!.effects[0]!
      expect(effect.percent).toBe(8)
      expect(effect).not.toHaveProperty('requestedPercent')
      expect(effect).not.toHaveProperty('strength')
    } finally {
      spy.mockRestore()
    }
  })
})

// ── B2-T11: pause / resume / choice / transcript / ledger ──────────────────

describe('session controls (B2-T11)', () => {
  it('pauses only after the current turn settles and stops every effect', async () => {
    const h = await createHarness([
      scriptedTurn('第一句。', [planCall()]),
      scriptedTurn('第二句。', [planCall('call_2')]),
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
      scriptedTurn('第二句。', [planCall('call_2')]),
    ])
    const started = await h.host.start({ packId: 'demo', plannedMinutes: 30 })
    expect(started.choices).toEqual([{ id: 'c1', label: '退开', tag: 'resist' }])

    const picked = await h.host.submitChoice('c1')

    expect(picked.turnId).toBe(2)
    expect(picked.lastLine).toBe('第二句。')
    expect(picked.choices).toBeUndefined()
    const choiceRequest = h.runner.requests[1]
    expect(choiceRequest?.messages.at(-1)).toMatchObject({ role: 'user' })
    expect(choiceRequest?.messages.at(-1)?.content).toContain('玩家选择：退开')
    expect(choiceRequest?.messages.at(-1)?.content).toContain('resist')
    const selected = h.records().find(record => record.action === 'choice_selected')
    expect(selected?.actor).toBe('human')
    expect(selected?.detail).toMatchObject({ turnId: 1, choiceId: 'c1' })
  })

  it('keeps the opening and later lines in the transcript', async () => {
    const h = await createHarness([
      scriptedTurn('第一句。', [planCall()]),
      scriptedTurn('第二句。', [planCall('call_2')]),
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
    const h = await createHarness([scriptedTurn('第一句。', [planCall()])])

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
    const h = await createHarness([scriptedTurn('第一句。', [planCall()])])
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
        { text: '……', toolCalls: [planCall('call_2')], finishReason: 'tool-calls' },
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
