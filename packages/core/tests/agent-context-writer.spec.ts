import { describe, expect, it } from 'vitest'
import {
  buildWriterContext,
  COMPRESSED_RECENT_LINES,
  DEFAULT_WRITER_CONTEXT_BUDGET_CHARS,
  humanizePlan,
  MAX_CORPUS_EXCERPTS,
  MAX_RECENT_LINES,
  writerContextChars,
  WRITER_CONSTRAINTS,
  WRITER_TEMPLATE_LINE,
  type HumanizePlanOptions,
  type RegionLabelSource,
  type WriterContext,
  type WriterContextInput,
} from '../src/agent/context/writer.ts'
import type { Beat, BeatPlan } from '../src/scenario/beat-plan.ts'
import { DEFAULT_INTENTS } from '../src/scenario/default-intents.ts'
import type { FeedbackIntent } from '../src/scenario/intents.ts'

/** Large enough that the default budget never bites in content tests. */
const UNBOUNDED = 1_000_000

const INTENTS: ReadonlyMap<string, FeedbackIntent> = new Map(
  DEFAULT_INTENTS.map(intent => [intent.id, intent] as const),
)

const PERSONA = '人设：嘴硬心软，称呼玩家为「你」，不说教，不解释规则。'
const HOST = '主持风格：短句、克制，留白多于说明。'
const SCENE = '场景：深夜的房间，只有台灯亮着，窗外很安静。'
const PHASE_NOTE = '当前阶段：试探，先确认对方的反应。'
const BOUNDARIES = ['不得越过玩家明确说出的底线', '不替玩家做决定']
const PROBE_BRIEF = '刚才那一下，对方明显有反应。'

const RECENT_LINES = [
  '她说别停下。',
  '他低声笑了一下。',
  '灯光落在锁骨上。',
  '她别过头去。',
  '他抬手挡住眼睛。',
  '她说你慢一点。',
  '他的呼吸有点乱。',
  '她凑近了一点。',
  '他叫了她的名字。',
  '她没再接话。',
  '他松开手又握紧。',
  '她说看着我。',
]

const CORPUS = [
  '他的呼吸有点乱，像在忍着什么。',
  '灯光从侧面压过来，轮廓很清楚。',
  '她说话很轻，尾音却压得很稳。',
  '空气停了一拍，谁都没有先动。',
  '他的手指收紧，又慢慢松开。',
]

/** One beat carrying every forbidden numeric/device field the plan can hold. */
const FIRST_BEAT: Beat = {
  id: 'probe',
  intentId: 'probe-touch',
  regions: ['chest'],
  strength: 'low',
  mustMention: true,
  change: { kind: 'level', targetPercent: 42, deltaPercent: 3, durationSec: 9 },
  targets: [{ deviceId: 'toy-secret', channelId: 'a', change: { kind: 'level', targetPercent: 99 } }],
}

/** Flagged only through the redundant `lineGuidance.mustMentionBeatIds`. */
const SECOND_BEAT: Beat = {
  id: 'soothe',
  intentId: 'soothe',
  regions: ['whole-body'],
  strength: 'med',
  change: { kind: 'level', deltaPercent: -5 },
  targets: [{ deviceId: 'toy-secret', channelId: 'b' }],
}

/** Not flagged; used to prove marks are not sprayed over every beat. */
const THIRD_BEAT: Beat = {
  id: 'field',
  intentId: 'ambient-field',
  regions: ['back'],
  strength: 'high',
  targets: [{ deviceId: 'toy-secret', channelId: 'c' }],
}

const PLAN: BeatPlan = {
  turnId: 7,
  phase: 'probe',
  pacing: 'probe',
  nextTurnAfterSec: 20,
  beats: [FIRST_BEAT, SECOND_BEAT, THIRD_BEAT],
  choices: [{ id: 'c1', label: '别闹', tag: 'resist' }],
  lineGuidance: { tone: '克制', mustMentionBeatIds: ['soothe'] },
}

function baseInput(overrides: Partial<WriterContextInput> = {}): WriterContextInput {
  return {
    plan: PLAN,
    persona: PERSONA,
    host: HOST,
    scene: SCENE,
    intents: INTENTS,
    recentLines: RECENT_LINES,
    corpusExcerpts: CORPUS,
    probeBrief: PROBE_BRIEF,
    boundaries: BOUNDARIES,
    phaseNote: PHASE_NOTE,
    ...overrides,
  }
}

function contextWith(overrides: Partial<WriterContextInput> = {}): WriterContext {
  return buildWriterContext(baseInput({ budgetChars: UNBOUNDED, ...overrides }))
}

describe('buildWriterContext', () => {
  it('builds a writer context with no device id and no digit', () => {
    const context = contextWith()
    const serialized = JSON.stringify(context)

    // Hard guarantee: nothing the writer sees contains an Arabic digit, so no
    // percent, cap, duration, target or raw probe value can have leaked.
    expect(serialized).not.toMatch(/\p{Nd}/u)
    for (const forbidden of [
      'toy-secret',
      'targetPercent',
      'deltaPercent',
      'durationSec',
      'turnId',
      'nextTurnAfterSec',
      'waveformId',
      '别闹',
    ]) {
      expect(serialized).not.toContain(forbidden)
    }

    // The exact contract shape: no raw plan, snapshot, audit or command field.
    expect(Object.keys(context).sort()).toEqual([
      'boundaries',
      'constraints',
      'corpusExcerpts',
      'host',
      'mustMention',
      'persona',
      'phaseNote',
      'planText',
      'probeBrief',
      'recentLines',
      'scene',
    ])

    expect(context.persona).toBe(PERSONA)
    expect(context.host).toBe(HOST)
    expect(context.scene).toBe(SCENE)
    expect(context.phaseNote).toBe(PHASE_NOTE)
    expect(context.boundaries).toEqual(BOUNDARIES)
    expect(context.recentLines).toEqual(RECENT_LINES)
    expect(context.corpusExcerpts).toEqual(CORPUS.slice(0, MAX_CORPUS_EXCERPTS))
    expect(context.probeBrief).toBe(PROBE_BRIEF)
    expect(context.constraints).toEqual([WRITER_CONSTRAINTS])

    // The plan arrives as words: meaning + body label + strength + pacing.
    expect(context.planText).toContain('节奏是试探')
    expect(context.planText).toContain('短促试探')
    expect(context.planText).toContain('胸口')
    expect(context.planText).toContain('力度轻')
    expect(context.planText).toContain('持续环境')
    expect(context.planText).not.toContain('别闹')
  })

  it('is byte-stable for the same state and pack', () => {
    const first = buildWriterContext(baseInput({ budgetChars: 9_999 }))
    const second = buildWriterContext(baseInput({ budgetChars: 9_999 }))
    const third = contextWith()

    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
    expect(JSON.stringify(third)).toBe(JSON.stringify(contextWith()))
    expect(first).toEqual(third)
  })

  it('keeps every mustMention mark and its humanized action', () => {
    const context = contextWith()
    expect(context.mustMention.map(entry => entry.beatId)).toEqual(['probe', 'soothe'])
    expect(context.mustMention[0]?.text).toContain('短促试探')
    expect(context.mustMention[1]?.text).toContain('安抚/降档')
    for (const entry of context.mustMention) expect(entry.text).not.toMatch(/\p{Nd}/u)

    const marks = context.planText.match(/必须提到/gu) ?? []
    expect(marks).toHaveLength(2)
    expect(context.planText).toContain('持续环境，落在后背，力度强')
    expect(context.planText).not.toContain('持续环境（必须提到）')
  })

  it('lets an explicit beat flag override lineGuidance', () => {
    const vetoed: BeatPlan = {
      ...PLAN,
      beats: PLAN.beats.map(beat => (beat.id === 'field' ? { ...beat, mustMention: false } : beat)),
      lineGuidance: { mustMentionBeatIds: ['probe', 'soothe', 'field'] },
    }
    const context = contextWith({ plan: vetoed })
    expect(context.mustMention.map(entry => entry.beatId)).toEqual(['probe', 'soothe'])
  })

  it('passes a narrative probe brief through and drops a leaked measurement', () => {
    expect(contextWith().probeBrief).toBe(PROBE_BRIEF)

    const leaked = contextWith({ probeBrief: '位移 0.17，音量 +29。' })
    expect(leaked.probeBrief).toBeUndefined()
    expect(JSON.stringify(leaked)).not.toMatch(/\p{Nd}/u)

    expect(contextWith({ probeBrief: undefined }).probeBrief).toBeUndefined()
    expect(contextWith({ probeBrief: '   ' }).probeBrief).toBeUndefined()
  })

  it('reads at most twenty recent rounds and three corpus excerpts', () => {
    const longRecent = [...RECENT_LINES, ...RECENT_LINES, '最后一句。']
    const context = contextWith({
      recentLines: longRecent,
      corpusExcerpts: [...CORPUS, ...CORPUS],
    })
    expect(longRecent).toHaveLength(25)
    expect(context.recentLines).toEqual(longRecent.slice(-MAX_RECENT_LINES))
    expect(context.recentLines).toHaveLength(MAX_RECENT_LINES)
    expect(context.corpusExcerpts).toEqual(CORPUS.slice(0, MAX_CORPUS_EXCERPTS))
  })

  it('drops corpus excerpts first when the budget is tight', () => {
    const full = contextWith()
    const twoExcerpts = contextWith({ corpusExcerpts: CORPUS.slice(0, 2) })
    const budget = writerContextChars(twoExcerpts)
    expect(writerContextChars(full)).toBeGreaterThan(budget)

    const degraded = buildWriterContext(baseInput({ budgetChars: budget }))
    expect(degraded.corpusExcerpts).toEqual(CORPUS.slice(0, 2))
    expect(degraded.recentLines).toEqual(RECENT_LINES)
    expect(degraded.scene).toBe(SCENE)
    expect(degraded.persona).toBe(PERSONA)
    expect(degraded.host).toBe(HOST)
    expect(writerContextChars(degraded)).toBeLessThanOrEqual(budget)
  })

  it('compresses recent lines to a summary plus the last five rounds', () => {
    const summary = '此前聊到了她的迟疑。'
    const compressed = [summary, ...RECENT_LINES.slice(-COMPRESSED_RECENT_LINES)]
    const target = contextWith({ corpusExcerpts: [], recentLines: compressed })
    const budget = writerContextChars(target)

    const degraded = buildWriterContext(baseInput({ budgetChars: budget, recentSummary: summary }))
    expect(degraded.corpusExcerpts).toEqual([])
    expect(degraded.recentLines).toEqual(compressed)
    expect(degraded.recentLines).toHaveLength(COMPRESSED_RECENT_LINES + 1)
    expect(degraded.scene).toBe(SCENE)
    expect(degraded.persona).toBe(PERSONA)
  })

  it('drops the setting after the recent history has been compressed', () => {
    const summary = '此前聊到了她的迟疑。'
    const compressed = [summary, ...RECENT_LINES.slice(-COMPRESSED_RECENT_LINES)]
    const target = contextWith({ corpusExcerpts: [], recentLines: compressed, scene: '', phaseNote: undefined })
    const budget = writerContextChars(target)

    const degraded = buildWriterContext(baseInput({ budgetChars: budget, recentSummary: summary }))
    expect(degraded.corpusExcerpts).toEqual([])
    expect(degraded.recentLines).toEqual(compressed)
    expect(degraded.scene).toBe('')
    expect(degraded.phaseNote).toBeUndefined()
    expect(degraded.persona).toBe(PERSONA)
    expect(degraded.host).toBe(HOST)
  })

  it('falls back to a minimal context when even the setting is gone', () => {
    const minimal = buildWriterContext(baseInput({ budgetChars: 1 }))
    expect(minimal.persona).toBe('')
    expect(minimal.host).toBe('')
    expect(minimal.scene).toBe('')
    expect(minimal.phaseNote).toBeUndefined()
    expect(minimal.recentLines).toEqual([])
    expect(minimal.corpusExcerpts).toEqual([])
    expect(minimal.boundaries).toEqual(BOUNDARIES)
    expect(minimal.constraints).toEqual([WRITER_CONSTRAINTS])
    expect(minimal.probeBrief).toBe(PROBE_BRIEF)
    expect(minimal.planText).toContain('短促试探')
    expect(WRITER_TEMPLATE_LINE).not.toMatch(/\p{Nd}/u)

    const budget = writerContextChars(minimal)
    const degraded = buildWriterContext(baseInput({ budgetChars: budget }))
    expect(degraded).toEqual(minimal)
    expect(writerContextChars(degraded)).toBeLessThanOrEqual(budget)
  })

  it('never truncates boundaries, even when they alone exceed the budget', () => {
    const minimal = buildWriterContext(baseInput({ budgetChars: 5 }))
    expect(minimal.boundaries).toEqual(BOUNDARIES)
    expect(writerContextChars(minimal)).toBeGreaterThan(5)
    expect(minimal.planText).not.toBe('')
  })

  it('uses the documented 8-16k token budget mapped to characters', () => {
    expect(DEFAULT_WRITER_CONTEXT_BUDGET_CHARS).toBeGreaterThanOrEqual(8_000)
    expect(DEFAULT_WRITER_CONTEXT_BUDGET_CHARS).toBeLessThanOrEqual(16_000)
    // A zero/negative override falls back to the documented default.
    const defaulted = contextWith({ budgetChars: 0 })
    expect(defaulted.persona).toBe(PERSONA)
  })
})

describe('humanizePlan', () => {
  it('renders meaning, region label, strength and pacing as words', () => {
    const text = humanizePlan(PLAN, INTENTS)
    expect(text).toContain('节奏是试探')
    expect(text).toContain('短促试探')
    expect(text).toContain('落在胸口')
    expect(text).toContain('力度轻')
    expect(text).toContain('力度适中')
    expect(text).toContain('力度强')
    expect(text).toContain('（必须提到）')
    expect(text).not.toMatch(/\p{Nd}/u)
  })

  it('maps every pacing and strength value to a digit-free word', () => {
    const pacings = ['hold', 'build', 'release', 'probe'] as const
    const strengths = ['low', 'med', 'high'] as const
    for (const pacing of pacings) {
      for (const strength of strengths) {
        const plan: BeatPlan = { ...PLAN, pacing, beats: [{ ...FIRST_BEAT, strength }] }
        const text = humanizePlan(plan, INTENTS)
        expect(text).not.toMatch(/\p{Nd}/u)
        expect(text).not.toContain('undefined')
        expect(text).not.toContain('NaN')
      }
    }
  })

  it('describes an empty plan without inventing an action', () => {
    const text = humanizePlan({ ...PLAN, beats: [] }, INTENTS)
    expect(text).toContain('不安排')
    expect(text).not.toMatch(/\p{Nd}/u)
  })

  it('never leaks target ids, changes, waveform ids or choices', () => {
    const wavePlan: BeatPlan = {
      ...PLAN,
      beats: [
        {
          id: 'wave',
          intentId: 'ambient-field',
          regions: ['back'],
          strength: 'high',
          change: { kind: 'waveform', waveformId: 'tide-2', durationSec: 30 },
        },
      ],
    }
    const text = humanizePlan(PLAN, INTENTS)
    for (const marker of ['toy-secret', 'targetPercent', 'deltaPercent', 'durationSec', 'c1', '别闹']) {
      expect(text).not.toContain(marker)
    }
    expect(humanizePlan(wavePlan, INTENTS)).not.toContain('tide-2')
  })

  it('falls back to a generic action for an intent the table does not contain', () => {
    const plan: BeatPlan = {
      ...PLAN,
      beats: [{ id: 'unknown', intentId: 'missing', regions: ['chest'], strength: 'med' }],
    }
    const text = humanizePlan(plan, INTENTS)
    expect(text).toContain('一个动作')
    expect(text).not.toContain('missing')
    expect(text).not.toContain('undefined')
    expect(text).not.toMatch(/\p{Nd}/u)
  })

  it('strips a digit a content pack authored into an intent meaning', () => {
    const numeric = new Map<string, FeedbackIntent>([
      ['probe-touch', { id: 'probe-touch', meaning: '第2档', regions: ['chest'] }],
    ])
    const text = humanizePlan(PLAN, numeric)
    expect(text).not.toMatch(/\p{Nd}/u)
    expect(text).toContain('第档')

    const onlyDigits = new Map<string, FeedbackIntent>([
      ['probe-touch', { id: 'probe-touch', meaning: '42', regions: ['chest'] }],
    ])
    expect(humanizePlan(PLAN, onlyDigits)).toContain('一个动作')
  })

  it('prefers caller-provided region labels over the built-in table', () => {
    const labels: RegionLabelSource = new Map([['chest', '心口']])
    const options: HumanizePlanOptions = { regionLabels: labels }
    const text = humanizePlan(PLAN, INTENTS, options)
    expect(text).toContain('心口')
    expect(text).not.toContain('胸口')

    const context = contextWith({ regionLabels: labels })
    expect(context.planText).toContain('心口')
  })

  it('never leaks an unknown region id into the prose', () => {
    const plan: BeatPlan = { ...PLAN, beats: [{ ...FIRST_BEAT, regions: ['left-ear'] }] }
    const text = humanizePlan(plan, INTENTS)
    expect(text).toContain('身体')
    expect(text).not.toContain('left-ear')
    expect(text).not.toMatch(/\p{Nd}/u)
  })
})
