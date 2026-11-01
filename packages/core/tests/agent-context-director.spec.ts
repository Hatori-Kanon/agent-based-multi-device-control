import { describe, expect, it, vi } from 'vitest'
import {
  buildDirectorContext,
  DIRECTOR_CHARS_PER_TOKEN,
  DIRECTOR_CONTEXT_BUDGET_CHARS,
  DIRECTOR_CONTEXT_BUDGET_TOKENS,
  DIRECTOR_DEGRADED_INTENT_LIMIT,
  DIRECTOR_DIALOG_SUMMARY_LIMIT,
  DIRECTOR_PHASE_GOAL_HEADLINE_CHARS,
  DIRECTOR_RECENT_BEAT_LIMIT,
  estimateDirectorTokens,
  type DirectorContext,
  type DirectorContextInput,
  type DirectorProbeFact,
} from '../src/agent/context/director.ts'
import type { ChannelSnapshot, DeviceSnapshot, RegistrySnapshot } from '../src/devices/registry.ts'
import { DEFAULT_INTENTS } from '../src/scenario/default-intents.ts'
import type { FeedbackIntent } from '../src/scenario/intents.ts'
import { PhaseMachine } from '../src/scenario/phases.ts'

const BOUNDARIES = ['不得越过玩家明确说出的底线。', '不替玩家做决定。', '不做无法撤回的伤害。']
const PERSONA_SUMMARY = '行动倾向：先试探再推进；禁忌：不羞辱；称呼：你。'
const HOST_RHYTHM = '节奏：短句；禁止：解释规则；收尾：留白。'
const LAST_LINE = '「别急，先看着我。」'
const GOAL = '在试探中推进，观察反应，再决定下一步。'
const LONG_GOAL = `长阶段文本：${'在试探中推进并观察对方的反应，必要时放缓节奏。'.repeat(12)}`
const FULL_PERSONA = `人设全文：${'嘴硬心软，先试探再靠近。'.repeat(200)}【全文标记】`

/** A channel with the not-yet-landed `region` field (B2-T10) read structurally. */
type ChannelFact = ChannelSnapshot & { readonly region?: string }

function channel(overrides: Partial<ChannelFact> = {}): ChannelFact {
  return {
    id: 'A',
    kind: 'level',
    label: 'A 通道',
    supportsWaveform: true,
    outputFloorPercent: 0,
    percent: 0,
    maxPercent: 100,
    maxWaveIntensity: 100,
    maxDurationSec: 60,
    effect: undefined,
    waveform: undefined,
    ...overrides,
  }
}

function device(
  id: string,
  channels: readonly ChannelFact[],
  lifecycle: DeviceSnapshot['lifecycle'] = 'ready',
): DeviceSnapshot {
  return { id, name: id, lifecycle, canScan: false, channels }
}

function snapshot(devices: readonly DeviceSnapshot[]): RegistrySnapshot {
  return { locked: false, lockedReason: undefined, devices }
}

function phaseMachine(current = 'probe', goal = GOAL): PhaseMachine {
  return new PhaseMachine(
    [
      { id: 'scene', goal: '开场，自由互动', next: ['probe'] },
      { id: 'probe', goal, next: ['escalate'] },
      { id: 'escalate', goal: '推进到收束', next: [] },
    ],
    current,
  )
}

/** Unordered: the projector must sort the menu by id for byte stability. */
const INTENT_TABLE: ReadonlyMap<string, FeedbackIntent> = new Map(
  [...DEFAULT_INTENTS].reverse().map(intent => [intent.id, intent]),
)

/** `count` id-sorted intents with long meanings: enough to be worth trimming. */
function manyIntents(count = 12): ReadonlyMap<string, FeedbackIntent> {
  const entries: [string, FeedbackIntent][] = []
  for (let index = 0; index < count; index += 1) {
    const id = `intent-${String(index).padStart(2, '0')}`
    entries.push([id, { id, meaning: `${id}：${'行动说明与边界'.repeat(8)}`, regions: ['whole-body'] }])
  }
  return new Map(entries)
}

function dialogHistory(turns: number): string[] {
  return Array.from(
    { length: turns },
    (_, index) => `T${String(index + 1).padStart(2, '0')}：${'一句对话摘要'.repeat(8)}`,
  )
}

function probe(overrides: Partial<DirectorProbeFact> = {}): DirectorProbeFact {
  return {
    probeId: 'p-0001',
    beatId: 'b1',
    intentId: 'probe-touch',
    verdict: 'responded',
    actionAt: 1_000,
    targets: [{ deviceId: 'coyote', channelId: 'A' }],
    delta: { motion: 0.17345, audioPct: 29.7 },
    ...overrides,
  }
}

function baseInput(overrides: Partial<DirectorContextInput> = {}): DirectorContextInput {
  return {
    state: {
      elapsedMin: 12,
      turn: 7,
      status: 'active',
      flags: { mood: 'calm' },
      player: { address: '你' },
      lastLine: LAST_LINE,
      recentBeats: ['ambient-field', 'probe-touch'],
    },
    phase: phaseMachine(),
    intents: INTENT_TABLE,
    snapshot: snapshot([
      device('coyote', [channel({ id: 'A' }), channel({ id: 'B', supportsWaveform: false })]),
    ]),
    probes: [],
    boundaries: BOUNDARIES,
    personaSummary: PERSONA_SUMMARY,
    hostRhythm: HOST_RHYTHM,
    dialogSummary: ['T01：开场', 'T02：试探'],
    plannedMin: 30,
    phaseEnteredMin: 8,
    ...overrides,
  }
}

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`expected ${what}`)
  return value
}

/** Recursively collect every object key, so a test can assert a block has no extras. */
function collectKeys(value: unknown, keys: Set<string> = new Set()): ReadonlySet<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys)
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      keys.add(key)
      collectKeys(child, keys)
    }
  }
  return keys
}

/** Budget for "force the next ladder stage": one character below the current output. */
function oneBelow(context: DirectorContext): number {
  return JSON.stringify(context).length - 1
}

describe('buildDirectorContext', () => {
  it('never accepts the full persona text', () => {
    // Compile-time: the input type has no full-persona key, only personaSummary.
    type InputHasPersonaKey = 'persona' extends keyof DirectorContextInput ? true : false
    const inputHasPersona: InputHasPersonaKey = false
    // The object-literal form must be rejected by excess-property checking.
    // @ts-expect-error — the signature has no `persona: string` field (§4.9.3)
    const rejectedInput: DirectorContextInput = { ...baseInput(), persona: FULL_PERSONA }

    // Runtime: a caller that smuggles the full text in anyway is ignored.
    const smuggled = { ...baseInput(), persona: FULL_PERSONA } as unknown as DirectorContextInput
    const context = buildDirectorContext(smuggled)

    expect(inputHasPersona).toBe(false)
    expect(rejectedInput.personaSummary).toBe(PERSONA_SUMMARY)
    expect(Object.keys(smuggled)).toContain('persona')
    expect(Object.keys(context)).not.toContain('persona')
    expect(JSON.stringify(context)).not.toContain('【全文标记】')
    expect(context.personaSummary).toBe(PERSONA_SUMMARY)
  })

  it('passes the host rhythm rules and the persona summary through unchanged', () => {
    const context = buildDirectorContext(baseInput())

    expect(context.hostRhythm).toBe(HOST_RHYTHM)
    expect(context.personaSummary).toBe(PERSONA_SUMMARY)
  })

  it('stays inside the 4k token budget with a 50-turn history', () => {
    const input = baseInput({
      dialogSummary: dialogHistory(50),
      intents: manyIntents(20),
      phase: phaseMachine('probe', LONG_GOAL),
      personaSummary: `导演摘要：${'先试探再推进'.repeat(40)}`,
      hostRhythm: `节奏：${'克制'.repeat(75)}`,
    })

    const context = buildDirectorContext(input)
    const rendered = JSON.stringify(context)

    expect(rendered.length).toBeLessThanOrEqual(DIRECTOR_CONTEXT_BUDGET_CHARS)
    expect(estimateDirectorTokens(rendered)).toBeLessThanOrEqual(DIRECTOR_CONTEXT_BUDGET_TOKENS)
    expect(DIRECTOR_CHARS_PER_TOKEN).toBeGreaterThan(1)
    expect(DIRECTOR_CONTEXT_BUDGET_CHARS).toBe(
      Math.floor(DIRECTOR_CONTEXT_BUDGET_TOKENS * DIRECTOR_CHARS_PER_TOKEN),
    )
    // 50 turns of history are NOT projected: the newest five survive and the
    // intent menu paid for the overage before any narrative fact was cut.
    expect(context.dialogSummary.length).toBeLessThanOrEqual(DIRECTOR_DIALOG_SUMMARY_LIMIT)
    expect(rendered).not.toContain('T01：')
    expect(context.dialogSummary.at(-1)).toBe('T50：' + '一句对话摘要'.repeat(8))
    expect(context.intents.length).toBe(DIRECTOR_DEGRADED_INTENT_LIMIT)
    expect(context.phase.goal).toBe(LONG_GOAL)
    // Boundaries are not the block that pays for the cut.
    expect(context.boundaries).toEqual(BOUNDARIES)
  })

  it('is a pure projection: the same input serialises to the same bytes', () => {
    const input = baseInput({ probes: [probe()] })
    // If the projector sorted an input array in place, a frozen array would throw.
    Object.freeze(input.boundaries)
    Object.freeze(input.dialogSummary)
    Object.freeze(input.snapshot.devices)

    const first = buildDirectorContext(input)
    const second = buildDirectorContext(input)

    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
    // Frozen key order is part of the contract, not an accident of insertion.
    expect(Object.keys(first)).toEqual([
      'boundaries',
      'time',
      'phase',
      'intents',
      'devices',
      'probes',
      'recentBeats',
      'state',
      'dialogSummary',
      'lastLine',
      'personaSummary',
      'hostRhythm',
      'outputSchema',
    ])
  })

  it('reads no clock and no randomness', () => {
    const now = vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('the director projection must not read the clock')
    })
    const random = vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('the director projection must not use randomness')
    })
    let context: DirectorContext | undefined
    try {
      context = buildDirectorContext(baseInput())
    } finally {
      now.mockRestore()
      random.mockRestore()
    }
    expect(context).toBeDefined()
  })

  it('reads elapsed time, the remaining budget and closing pressure', () => {
    const context = buildDirectorContext(
      baseInput({
        state: { elapsedMin: 27, lastLine: LAST_LINE, recentBeats: [] },
        phase: phaseMachine('probe'),
        plannedMin: 30,
        phaseEnteredMin: 20,
      }),
    )

    expect(context.time).toEqual({ elapsedMin: 27, remainingMin: 3, mustResolve: true })
    expect(context.phase).toEqual({
      id: 'probe',
      goal: GOAL,
      allowedNext: ['escalate'],
      dwellMin: 7,
    })
  })

  it('treats an open-ended session as having no remaining time and no closing pressure', () => {
    const context = buildDirectorContext(
      baseInput({
        state: { elapsedMin: 5 },
        plannedMin: null,
      }),
    )

    expect(context.time).toEqual({ elapsedMin: 5, remainingMin: null, mustResolve: false })
  })

  it('reads only the latest two beats and the previous turn line', () => {
    const context = buildDirectorContext(
      baseInput({
        state: {
          elapsedMin: 3,
          lastLine: LAST_LINE,
          recentBeats: ['ambient-field', 'probe-touch', 'soothe'],
        },
      }),
    )

    expect(context.recentBeats).toEqual(['probe-touch', 'soothe'])
    expect(context.recentBeats.length).toBeLessThanOrEqual(DIRECTOR_RECENT_BEAT_LIMIT)
    expect(context.lastLine).toBe(LAST_LINE)
  })

  it('keeps only the most recent dialog summaries', () => {
    const summaries = ['一', '二', '三', '四', '五', '六'].map(label => `第${label}轮：一句摘要`)
    const context = buildDirectorContext(baseInput({ dialogSummary: summaries }))

    expect(context.dialogSummary).toEqual(summaries.slice(-DIRECTOR_DIALOG_SUMMARY_LIMIT))
  })

  it('sorts the intent menu and fills the resolver default distribution', () => {
    const custom: FeedbackIntent = { id: 'zz-custom', meaning: '自定义', regions: ['chest'] }
    const table = new Map<string, FeedbackIntent>([...INTENT_TABLE, ['zz-custom', custom]])
    const context = buildDirectorContext(baseInput({ intents: table }))

    expect(context.intents.map(intent => intent.id)).toEqual([
      'ambient-field',
      'escalate-step',
      'probe-touch',
      'soothe',
      'stop',
      'zz-custom',
    ])
    expect(must(context.intents.find(intent => intent.id === 'probe-touch'), 'probe-touch').distribution).toBe(
      'primary',
    )
    expect(must(context.intents.find(intent => intent.id === 'probe-touch'), 'probe-touch').meaning).toBe(
      '短促试探',
    )
    expect(must(context.intents.find(intent => intent.id === 'zz-custom'), 'zz-custom').distribution).toBe(
      'synced',
    )
    expect(must(context.intents.find(intent => intent.id === 'ambient-field'), 'ambient-field').regions).toEqual([
      'whole-body',
    ])
  })

  it('summarises state without scene or npc prose', () => {
    const context = buildDirectorContext(baseInput())

    expect(context.state).toEqual({
      currentPhase: 'probe',
      turn: 7,
      status: 'active',
      flags: { mood: 'calm' },
      player: { address: '你' },
    })
    expect(Object.keys(context.state)).toEqual(['currentPhase', 'turn', 'status', 'flags', 'player'])
  })

  it('carries the BeatPlan output schema with the beat limit', () => {
    const context = buildDirectorContext(baseInput())
    const properties = context.outputSchema['properties'] as Record<string, Record<string, unknown>>

    expect(context.outputSchema['required']).toEqual(['pacing', 'beats'])
    expect(must(properties['beats'], 'beats schema')['maxItems']).toBe(3)
  })

  it('projects probes without any raw numbers', () => {
    const context = buildDirectorContext(
      baseInput({
        probes: [
          probe({ probeId: 'p-0001', actionAt: 1_000, verdict: 'responded' }),
          probe({ probeId: 'p-0002', actionAt: 3_000, verdict: 'none', delta: { motion: 0, audioPct: 0 } }),
          probe({ probeId: 'p-0003', actionAt: 2_000, verdict: 'ambiguous', delta: { motion: 0.04, audioPct: 0 } }),
          probe({ probeId: 'p-0004', actionAt: 4_000, verdict: 'unavailable', delta: undefined }),
        ],
      }),
    )

    // Latest three, chronological; the oldest probe is gone.
    expect(context.probes.map(entry => entry.probeId)).toEqual(['p-0003', 'p-0002', 'p-0004'])
    expect(context.probes.map(entry => entry.direction)).toEqual(['up', 'flat', 'unknown'])
    for (const entry of context.probes) {
      expect(Object.keys(entry)).toEqual(['probeId', 'beatId', 'intentId', 'verdict', 'direction', 'targets'])
    }

    const rendered = JSON.stringify(context.probes)
    expect(rendered).not.toContain('0.17345')
    expect(rendered).not.toContain('29.7')
    expect(rendered).not.toContain('0.04')
    const keys = collectKeys(context.probes)
    for (const forbidden of ['delta', 'motion', 'audioPct', 'baseline', 'window', 'reason']) {
      expect(keys.has(forbidden)).toBe(false)
    }
  })

  it('describes device capability without percentages', () => {
    const context = buildDirectorContext(
      baseInput({
        snapshot: snapshot([
          device('coyote', [
            channel({ id: 'A', percent: 37, maxPercent: 100, region: 'chest', supportsWaveform: true }),
            channel({ id: 'B', percent: 0, maxPercent: 100, region: 'chest', supportsWaveform: false }),
          ]),
          device(
            'xhtkj',
            [channel({ id: 'A', percent: 80, maxPercent: 100, region: 'inner-thigh', supportsWaveform: false })],
            'failed',
          ),
        ]),
      }),
    )

    expect(context.devices.map(entry => entry.deviceId)).toEqual(['coyote', 'xhtkj'])
    const coyote = must(context.devices[0], 'the coyote view')
    expect(Object.keys(coyote)).toEqual([
      'deviceId',
      'region',
      'regions',
      'channels',
      'level',
      'waveformAvailable',
      'available',
    ])
    expect(coyote.region).toBe('chest')
    expect(coyote.regions).toEqual(['chest'])
    expect(coyote.channels).toBe(2)
    expect(coyote.level).toBe('med')
    expect(coyote.waveformAvailable).toBe(true)
    expect(coyote.available).toBe(true)

    const xhtkj = must(context.devices[1], 'the xhtkj view')
    expect(xhtkj.level).toBe('high')
    expect(xhtkj.available).toBe(false)

    const rendered = JSON.stringify(context.devices)
    expect(rendered).not.toContain('37')
    expect(rendered).not.toContain('80')
    for (const forbidden of ['percent', 'maxPercent', 'outputFloorPercent']) {
      expect(rendered).not.toContain(forbidden)
    }
  })

  it('reports the wildcard region literally and keeps multi-region devices explicit', () => {
    const context = buildDirectorContext(
      baseInput({
        snapshot: snapshot([
          device('coyote', [channel({ id: 'A', region: 'whole-body' })]),
          device('spanning', [
            channel({ id: 'A', region: 'chest' }),
            channel({ id: 'B', region: 'inner-thigh' }),
          ]),
          device('unmarked', [channel({ id: 'A' })]),
        ]),
      }),
    )

    const wildcard = must(context.devices[0], 'the wildcard device')
    expect(wildcard.region).toBe('whole-body')
    expect(wildcard.regions).toEqual(['whole-body'])

    const spanning = must(context.devices[1], 'the multi-region device')
    // One `region` would lie on a device that spans several; the list is exact.
    expect(spanning.region).toBeUndefined()
    expect(spanning.regions).toEqual(['chest', 'inner-thigh'])

    const unmarked = must(context.devices[2], 'the unmarked device')
    expect(unmarked.region).toBeUndefined()
    expect(unmarked.regions).toEqual([])
  })

  it('trims the intent menu first when the projection is over budget', () => {
    const input = ladderInput()
    const full = buildDirectorContext({ ...input, budgetChars: 10_000_000 })
    expect(full.intents.length).toBe(12)

    const trimmed = buildDirectorContext({ ...input, budgetChars: oneBelow(full) })
    expect(trimmed.intents.length).toBe(DIRECTOR_DEGRADED_INTENT_LIMIT)
    expect(trimmed.dialogSummary.length).toBe(DIRECTOR_DIALOG_SUMMARY_LIMIT)
    expect(trimmed.phase.goal).toBe(LONG_GOAL)
  })

  it('compresses the dialog summary before it touches the phase text', () => {
    const input = ladderInput()
    const full = buildDirectorContext({ ...input, budgetChars: 10_000_000 })
    const afterStep1 = buildDirectorContext({ ...input, budgetChars: oneBelow(full) })
    expect(afterStep1.intents.length).toBe(DIRECTOR_DEGRADED_INTENT_LIMIT)
    expect(afterStep1.dialogSummary.length).toBe(DIRECTOR_DIALOG_SUMMARY_LIMIT)

    const afterStep2 = buildDirectorContext({ ...input, budgetChars: oneBelow(afterStep1) })
    expect(afterStep2.intents.length).toBe(DIRECTOR_DEGRADED_INTENT_LIMIT)
    expect(afterStep2.dialogSummary).toEqual(input.dialogSummary.slice(-1))
    expect(afterStep2.phase.goal).toBe(LONG_GOAL)
  })

  it('drops the long phase goal last', () => {
    const input = ladderInput()
    const full = buildDirectorContext({ ...input, budgetChars: 10_000_000 })
    const afterStep1 = buildDirectorContext({ ...input, budgetChars: oneBelow(full) })
    const afterStep2 = buildDirectorContext({ ...input, budgetChars: oneBelow(afterStep1) })

    const afterStep3 = buildDirectorContext({ ...input, budgetChars: oneBelow(afterStep2) })
    expect(afterStep3.intents.length).toBe(DIRECTOR_DEGRADED_INTENT_LIMIT)
    expect(afterStep3.dialogSummary.length).toBe(1)
    expect(afterStep3.phase.goal).not.toBe(LONG_GOAL)
    expect(afterStep3.phase.goal.endsWith('…')).toBe(true)
    expect(Array.from(afterStep3.phase.goal).length).toBeLessThanOrEqual(
      DIRECTOR_PHASE_GOAL_HEADLINE_CHARS,
    )
    expect(JSON.stringify(afterStep3).length).toBeLessThanOrEqual(oneBelow(afterStep2))
  })

  it('never cuts boundaries, even when they alone exceed the budget', () => {
    const context = buildDirectorContext(baseInput({ budgetChars: 10 }))

    expect(context.boundaries).toEqual(BOUNDARIES)
    expect(JSON.stringify(context).length).toBeGreaterThan(10)
  })
})

/** 12 long-meaning intents, a long goal and five long summaries. */
function ladderInput(): DirectorContextInput {
  return baseInput({
    phase: phaseMachine('probe', LONG_GOAL),
    intents: manyIntents(12),
    dialogSummary: Array.from({ length: 5 }, (_, index) => `S${index + 1}：${'摘要细节'.repeat(30)}`),
    personaSummary: `导演摘要：${'先试探再推进'.repeat(100)}`,
    hostRhythm: `节奏规则：${'克制、短句、不解释'.repeat(50)}`,
  })
}
