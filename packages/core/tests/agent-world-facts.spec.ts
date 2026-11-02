import { describe, expect, it } from 'vitest'
import {
  buildWorldFacts,
  DEFAULT_WORLD_FACTS_BUDGET,
  type WorldFactsChannel,
  type WorldFactsInput,
  type WorldFactsIntent,
  type WorldFactsRegion,
} from '../src/agent/context/world.ts'

const INTENTS: readonly WorldFactsIntent[] = [
  { id: 'probe-touch', meaning: '短促试探' },
  { id: 'soothe', meaning: '安抚' },
]

const REGIONS: readonly WorldFactsRegion[] = [
  { id: 'chest', label: '胸口' },
  { id: 'waist', label: '腰' },
]

/** A complete input whose three lines fit comfortably in the default budget. */
function sampleInput(): WorldFactsInput {
  return {
    intents: INTENTS,
    regions: REGIONS,
    channels: [
      { region: 'chest', ready: true },
      { region: 'waist', ready: false },
    ],
  }
}

describe('world facts projection', () => {
  it('ships the documented default budget', () => {
    expect(DEFAULT_WORLD_FACTS_BUDGET).toBe(600)
  })

  it('emits the empty-menu fallbacks when the pack declares nothing', () => {
    const lines = buildWorldFacts({ intents: [], regions: [], channels: [] })
    expect(lines).toEqual([
      '可用意图：无（本回合不要调用 apply_plan）',
      '可用部位：whole-body=全身（作用于全部通道）',
      '已就位部位：无（使用 whole-body 可作用到全部通道）',
    ])
  })

  it('renders the intent menu in declaration order and maps regions to labels', () => {
    const lines = buildWorldFacts(sampleInput())
    expect(lines).toHaveLength(3)
    expect(lines[0]).toBe('可用意图：probe-touch=短促试探；soothe=安抚')
    expect(lines[1]).toBe('可用部位：whole-body=全身（作用于全部通道）；chest=胸口；waist=腰')
    expect(lines[2]).toBe('已就位部位：chest')
    // The whole block is a fact list, so it never carries a measurement.
    expect(lines.join('\n')).not.toMatch(/\p{Nd}/u)
  })

  it('deduplicates ids, skips a declared whole-body, and only lists declared ready regions', () => {
    const lines = buildWorldFacts({
      intents: [...INTENTS, INTENTS[0]!],
      regions: [REGIONS[0]!, { id: 'whole-body', label: '全身' }, REGIONS[1]!, REGIONS[0]!],
      channels: [
        { region: 'chest', ready: true },
        { region: 'chest', ready: false },
        { region: 'waist', ready: false },
        { region: 'undeclared', ready: true },
        { region: 'whole-body', ready: true },
        { region: undefined, ready: true },
      ],
    })
    expect(lines[0]).toBe('可用意图：probe-touch=短促试探；soothe=安抚')
    // The wildcard appears once, first; declared whole-body is not repeated.
    expect(lines[1]).toBe('可用部位：whole-body=全身（作用于全部通道）；chest=胸口；waist=腰')
    // `undeclared` is ready but not part of the pack, so the model never sees it.
    expect(lines[2]).toBe('已就位部位：chest')

    // Readiness follows declaration order, not channel order.
    const reordered = buildWorldFacts({
      intents: [],
      regions: [REGIONS[1]!, REGIONS[0]!],
      channels: [
        { region: 'chest', ready: true },
        { region: 'waist', ready: true },
      ],
    })
    expect(reordered[2]).toBe('已就位部位：waist、chest')
  })

  it('strips decimal digits from labels and meanings but keeps ids verbatim', () => {
    const lines = buildWorldFacts({
      intents: [
        { id: 'probe-touch', meaning: '第1档 30%' },
        { id: 'silent', meaning: '12' },
        // Ids are contract keys, so a digit in an id survives (documented
        // exception in the module: renaming it would break the enum contract).
        { id: 'sensation2', meaning: '触及' },
      ],
      regions: [{ id: 'chest', label: '左胸2' }],
      channels: [],
    })
    expect(lines[0]).toBe('可用意图：probe-touch=第档 %；silent=silent；sensation2=触及')
    expect(lines[1]).toBe('可用部位：whole-body=全身（作用于全部通道）；chest=左胸')
    // Labels/meanings are digit-free; the only digits are inside the id tokens,
    // which must match the pack vocabulary byte for byte.
    const ids = ['probe-touch', 'silent', 'sensation2', 'whole-body', 'chest']
    const withoutIds = ids.reduce((text, id) => text.replaceAll(id, ''), lines.join('\n'))
    expect(withoutIds).not.toMatch(/\p{Nd}/u)
    expect(lines.join('\n')).toContain('sensation2=触及')
  })

  it('keeps player-authored part labels verbatim, including digits', () => {
    // The host passes custom regions with label === id; they are the player's
    // own words, so the "no numbers" prose rule must not rename them.
    const lines = buildWorldFacts({
      intents: [{ id: 'probe-touch', meaning: '短促试探' }],
      regions: [{ id: '绑带 2', label: '绑带 2' }],
      channels: [{ region: '绑带 2', ready: true }],
    })
    expect(lines[1]).toContain('绑带 2=绑带 2')
    expect(lines[2]).toBe('已就位部位：绑带 2')
  })

  it('drops the readiness line before truncating the remaining text', () => {
    const input: WorldFactsInput = {
      intents: [
        { id: 'probe-touch', meaning: '短促试探' },
        { id: 'soothe', meaning: '安抚' },
        { id: 'amplify', meaning: '加强' },
      ],
      regions: REGIONS,
      channels: [{ region: 'chest', ready: true }],
    }
    const full = buildWorldFacts(input)
    expect(full).toHaveLength(3)
    expect(full.join('\n').length).toBeLessThanOrEqual(DEFAULT_WORLD_FACTS_BUDGET)

    // A budget equal to the two essential lines drops readiness and stops.
    const twoLineLength = full.slice(0, 2).join('\n').length
    const twoLines = buildWorldFacts({ ...input, budgetChars: twoLineLength })
    expect(twoLines).toEqual(full.slice(0, 2))
    expect(twoLines.join('\n')).not.toContain('已就位')

    // One character less forces the documented code-point truncation.
    const truncated = buildWorldFacts({ ...input, budgetChars: twoLineLength - 1 })
    expect(truncated).toHaveLength(1)
    expect(truncated[0]!.endsWith('…')).toBe(true)
    expect(truncated[0]!.length).toBe(twoLineLength - 1)
    expect(truncated[0]!).not.toContain('已就位')
  })

  it('honours a tiny explicit budget without splitting a code point', () => {
    const input = sampleInput()
    const tiny = buildWorldFacts({ ...input, budgetChars: 40 })
    expect(tiny).toHaveLength(1)
    expect(tiny[0]!.length).toBeLessThanOrEqual(40)
    expect(tiny[0]!.endsWith('…')).toBe(true)
    expect(tiny[0]!).not.toContain('已就位')

    // No room at all: the documented "emit nothing" case.
    expect(buildWorldFacts({ ...input, budgetChars: 0 })).toEqual([])
    expect(buildWorldFacts({ ...input, budgetChars: -3 })).toEqual([])
    // The smallest useful budget still returns a single ellipsis.
    expect(buildWorldFacts({ ...input, budgetChars: 1 })).toEqual(['…'])
  })

  it('is deterministic and leaves its input untouched', () => {
    const input = sampleInput()
    const before = JSON.stringify(input)
    const first = buildWorldFacts(input)
    const second = buildWorldFacts(input)
    expect(second).toEqual(first)
    expect(JSON.stringify(input)).toBe(before)
  })
})
