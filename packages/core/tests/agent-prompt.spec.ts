import { describe, expect, it } from 'vitest'
import {
  buildSystemPrompt,
  buildTurnMessages,
  DEFAULT_SYSTEM_PROMPT_BUDGET_CHARS,
  PROMPT_SACRIFICE_ORDER,
  PROMPT_SECTION_ORDER,
  PROMPT_TRUNCATION_MARK,
} from '../src/agent/prompt.ts'

const BOUNDARIES = ['不得越过用户明确说出的底线', '不替玩家做决定']
const HOST = '主持风格：短句、克制、不解释规则。'
const PERSONA = '人设：嘴硬心软，称呼玩家为「你」。'
const SCENE = '场景：深夜的房间，只有台灯亮着。'
const BRIEFS = ['刚才的短促试探有明显反应。', '对方呼吸变快了一点。']
const WORLD = ['可用意图：probe-touch=短促试探；soothe=安抚', '可用部位：whole-body=全身；chest=胸口', '已就位部位：chest']

/** Render a prompt with only the requested blocks, at a budget that never cuts. */
function promptFor(
  parts: {
    readonly host?: string
    readonly persona?: string
    readonly scene?: string
    readonly briefs?: readonly string[]
    readonly world?: readonly string[]
    readonly protocol?: readonly string[]
  },
  budgetChars = 100_000,
): string {
  return buildSystemPrompt({
    boundaries: BOUNDARIES,
    ...(parts.host === undefined ? {} : { host: parts.host }),
    ...(parts.persona === undefined ? {} : { persona: parts.persona }),
    ...(parts.scene === undefined ? {} : { scene: parts.scene }),
    ...(parts.briefs === undefined ? {} : { briefs: parts.briefs }),
    ...(parts.world === undefined ? {} : { world: parts.world }),
    ...(parts.protocol === undefined ? {} : { protocol: parts.protocol }),
    budgetChars,
  })
}

describe('buildSystemPrompt', () => {
  it('puts boundaries before persona and host', () => {
    const prompt = promptFor({ host: HOST, persona: PERSONA })
    const boundariesIndex = prompt.indexOf(BOUNDARIES[0] ?? '')
    const hostIndex = prompt.indexOf(HOST)
    const personaIndex = prompt.indexOf(PERSONA)
    expect(boundariesIndex).toBeGreaterThanOrEqual(0)
    expect(hostIndex).toBeGreaterThan(boundariesIndex)
    expect(personaIndex).toBeGreaterThan(boundariesIndex)
    // The hard constraints are the opening block, not merely present.
    expect(prompt.startsWith('## 边界（最高优先级')).toBe(true)
  })

  it('assembles every block in the documented order', () => {
    const prompt = promptFor({ host: HOST, persona: PERSONA, scene: SCENE, briefs: BRIEFS, world: WORLD })
    const anchors = [BOUNDARIES[0] ?? '', HOST, PERSONA, SCENE, BRIEFS[0] ?? '', WORLD[0] ?? '']
    const indexes = anchors.map(anchor => prompt.indexOf(anchor))
    expect(indexes.every(index => index >= 0)).toBe(true)
    expect([...indexes].sort((a, b) => a - b)).toEqual(indexes)
    expect(PROMPT_SECTION_ORDER).toEqual(['boundaries', 'host', 'persona', 'scene', 'briefs', 'world', 'protocol'])
    expect(PROMPT_SACRIFICE_ORDER).toEqual(['briefs', 'scene', 'persona', 'host'])
  })

  it('omits blocks the pack does not provide', () => {
    expect(buildSystemPrompt({})).toBe('')
    expect(buildSystemPrompt({ host: '   ', persona: '', briefs: [] })).toBe('')
    const prompt = promptFor({ host: HOST })
    expect(prompt).toContain(HOST)
    expect(prompt).not.toContain(PERSONA)
    expect(prompt).not.toContain(SCENE)
  })

  it('truncates in the documented order when over budget', () => {
    const withHost = promptFor({ host: HOST })
    const withPersona = promptFor({ host: HOST, persona: PERSONA })
    const withScene = promptFor({ host: HOST, persona: PERSONA, scene: SCENE })

    // ① briefs are sacrificed first: a budget that cannot fit them keeps the
    // rest untouched.
    const noBriefs = buildSystemPrompt({
      boundaries: BOUNDARIES,
      host: HOST,
      persona: PERSONA,
      scene: SCENE,
      briefs: BRIEFS,
      budgetChars: withScene.length + 4,
    })
    expect(noBriefs).toBe(withScene)
    expect(noBriefs).not.toContain(BRIEFS[0] ?? '')

    // ② then the setting block is dropped whole.
    const noScene = buildSystemPrompt({
      boundaries: BOUNDARIES,
      host: HOST,
      persona: PERSONA,
      scene: SCENE,
      briefs: BRIEFS,
      budgetChars: withPersona.length + 4,
    })
    expect(noScene).toBe(withPersona)
    expect(noScene).not.toContain(SCENE)

    // ③ then persona is cut at the tail, keeping host intact.
    const personaBlock = withPersona.slice(withHost.length + 2)
    const personaHeader = personaBlock.slice(0, personaBlock.indexOf('\n'))
    const truncatedBudget = withHost.length + 2
      + personaHeader.length + 1 + 10 + PROMPT_TRUNCATION_MARK.length
    const truncated = buildSystemPrompt({
      boundaries: BOUNDARIES,
      host: HOST,
      persona: PERSONA,
      scene: SCENE,
      briefs: BRIEFS,
      budgetChars: truncatedBudget,
    })
    expect(truncated.startsWith(withHost)).toBe(true)
    expect(truncated).toContain(HOST)
    expect(truncated.endsWith(PROMPT_TRUNCATION_MARK)).toBe(true)
    expect(truncated).not.toContain(PERSONA) // only a prefix of it survives
    expect(truncated).not.toContain(SCENE)
    expect(truncated.length).toBeLessThanOrEqual(truncatedBudget)
  })

  it('never truncates boundaries, even when they alone exceed the budget', () => {
    const boundariesOnly = promptFor({})
    const tiny = buildSystemPrompt({
      boundaries: BOUNDARIES,
      host: HOST,
      persona: PERSONA,
      scene: SCENE,
      briefs: BRIEFS,
      budgetChars: 5,
    })
    expect(tiny).toBe(boundariesOnly)
    for (const boundary of BOUNDARIES) expect(tiny).toContain(boundary)
    // The documented exception: a cut boundary is worse than an over-budget prompt.
    expect(tiny.length).toBeGreaterThan(5)
  })

  it('keeps the mandatory world menu when a long persona fills the budget', () => {
    // The single-call model cannot produce a valid `apply_plan` without the
    // intent/region menu. Even when persona/scene/briefs consume the whole
    // budget (the loop breaks before `world` in document order), the menu must
    // still be appended — an over-budget prompt is the intended trade-off.
    const longPersona = '长'.repeat(5_000)
    const prompt = buildSystemPrompt({
      boundaries: BOUNDARIES,
      host: HOST,
      persona: longPersona,
      scene: SCENE,
      briefs: BRIEFS,
      world: WORLD,
      budgetChars: 120,
    })
    for (const line of WORLD) expect(prompt).toContain(line)
    expect(prompt).toContain('## 本回合可用（意图与部位）')
    expect(prompt.indexOf(WORLD[WORLD.length - 1] ?? '')).toBeGreaterThan(0)
    expect(prompt.length).toBeGreaterThan(120)
    // The budgeted narrative blocks lost the sacrifice race, not the menu.
    expect(prompt).not.toContain(BRIEFS[0] ?? '')
  })

  it('keeps the mandatory protocol block after the world menu when over budget', () => {
    const protocol = ['正文写进 apply_plan 的 narration 字段。']
    const prompt = buildSystemPrompt({
      boundaries: BOUNDARIES,
      persona: '长'.repeat(5_000),
      scene: SCENE,
      briefs: BRIEFS,
      world: WORLD,
      protocol,
      budgetChars: 120,
    })
    expect(prompt).toContain('## 工具与输出协议（本回合必须）')
    expect(prompt).toContain(protocol[0] ?? '')
    expect(prompt.indexOf(protocol[0] ?? '')).toBeGreaterThan(prompt.indexOf(WORLD[0] ?? ''))
    expect(prompt.endsWith(protocol[0] ?? '')).toBe(true)
  })

  it('keeps whole briefs and drops the tail ones first', () => {
    const firstBriefOnly = buildSystemPrompt({
      boundaries: BOUNDARIES,
      host: HOST,
      persona: PERSONA,
      scene: SCENE,
      briefs: [BRIEFS[0] ?? ''],
      budgetChars: 100_000,
    })
    const trimmed = buildSystemPrompt({
      boundaries: BOUNDARIES,
      host: HOST,
      persona: PERSONA,
      scene: SCENE,
      briefs: BRIEFS,
      budgetChars: firstBriefOnly.length,
    })
    expect(trimmed).toBe(firstBriefOnly)
    expect(trimmed).toContain(BRIEFS[0] ?? '')
    expect(trimmed).not.toContain(BRIEFS[1] ?? '')
  })

  it('injects briefs verbatim and adds no numbers of its own', () => {
    const prompt = promptFor({ host: HOST, persona: PERSONA, scene: SCENE, briefs: BRIEFS })
    for (const brief of BRIEFS) expect(prompt).toContain(brief)
    // Probe numbers go to the director/audit; the writer prompt carries only
    // narration sentences, so a digit in the assembled prompt would be invented.
    expect(prompt).not.toMatch(/\p{Nd}/u)
    expect(DEFAULT_SYSTEM_PROMPT_BUDGET_CHARS).toBeGreaterThan(0)
  })

  it('defaults to the documented budget', () => {
    const prompt = promptFor({ host: HOST, persona: PERSONA, scene: SCENE, briefs: BRIEFS }, 0)
    expect(prompt.length).toBeLessThan(DEFAULT_SYSTEM_PROMPT_BUDGET_CHARS)
    expect(prompt).toContain(BRIEFS[0] ?? '')
  })
})

describe('buildTurnMessages', () => {
  it('builds the system prompt first and the player line last', () => {
    const system = promptFor({ host: HOST, persona: PERSONA })
    const messages = buildTurnMessages({
      system,
      recentLines: ['上一句台词', '   ', '再上一句台词'],
      playerText: '你好',
      toolResults: [{ role: 'tool', content: '{"ok":true}', toolCallId: 'call_1' }],
    })
    expect(messages.map(message => message.role)).toEqual(['system', 'assistant', 'assistant', 'user', 'tool'])
    expect(messages[0]).toEqual({ role: 'system', content: system })
    expect(messages[1]).toEqual({ role: 'assistant', content: '上一句台词' })
    expect(messages[3]).toEqual({ role: 'user', content: '你好' })
    expect(messages[4]).toEqual({ role: 'tool', content: '{"ok":true}', toolCallId: 'call_1' })
  })

  it('handles a turn without a system prompt or player message', () => {
    expect(buildTurnMessages({})).toEqual([])
    expect(buildTurnMessages({ playerText: '   ' })).toEqual([])
    const opening = buildTurnMessages({ system: buildSystemPrompt({ boundaries: BOUNDARIES }) })
    expect(opening).toHaveLength(1)
    expect(opening[0]?.role).toBe('system')
  })

  it('keeps the player text as the last non-tool message', () => {
    const messages = buildTurnMessages({ recentLines: ['我轻轻碰了你一下。'], playerText: '别闹。' })
    expect(messages.map(message => message.role)).toEqual(['assistant', 'user'])
    expect(messages[messages.length - 1]?.content).toBe('别闹。')
  })
})
