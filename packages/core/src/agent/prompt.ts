/**
 * Layered prompt assembly for the single-call M2 turn (B1-T9).
 *
 * One model call both plans and narrates (D6), so the system prompt is the
 * whole stage: hard boundaries, then host voice, then persona, then scene, then
 * this turn's narrative facts. The order is fixed here rather than in the
 * caller, because "boundaries first" is a safety property (§4.9.1, `内容包规范.md`
 * §4: `boundaries` is the single hard-constraint declaration) and the writer
 * reads it as the highest-priority block.
 *
 * ```
 * boundaries 最前 → host → persona → scene → briefs
 * ```
 *
 * ## Budget and truncation order
 *
 * The budget is measured in **characters, not tokens**: core is dependency-free
 * and has no tokenizer, and the 8–12k-token single-call budget maps to roughly
 * this many CJK characters. The system prompt is the stable prefix; dynamic
 * per-turn content (recent lines, the plan) lives in the turn messages.
 *
 * When the assembled text exceeds `budgetChars`, content is sacrificed in
 * exactly this order (`导演与写作上下文契约.md` §6, applied to these blocks):
 *
 * 1. `briefs` — drop whole briefs from the end (fewer retrieved snippets);
 * 2. `scene` — drop the long setting block whole;
 * 3. `persona` — truncate the tail, keep the head;
 * 4. `host` — truncate the tail, keep the head.
 *
 * `boundaries` is **never** truncated or dropped: if the boundaries alone
 * exceed the budget the assembled prompt is over budget on purpose, because a
 * cut boundary is a safety regression rather than a style regression.
 *
 * ## No numbers
 *
 * `briefs` are injected verbatim. Probe numbers go to the director and the
 * audit trail only; the writer receives narration sentences produced by the
 * packed projection (e.g. "刚才的试探有明显反应"). This module never formats a
 * number or turns a measurement into text, so there is nothing to leak.
 *
 * @module
 */

import type { LlmMessage } from './model.ts'

/** Approximate character budget for the system prompt of a single-call turn. */
export const DEFAULT_SYSTEM_PROMPT_BUDGET_CHARS = 4_000

/** Appended where a block was cut, so the model can tell the text is partial. */
export const PROMPT_TRUNCATION_MARK = '…'

/** One block of the layered system prompt. */
export type PromptSectionKey = 'boundaries' | 'host' | 'persona' | 'scene' | 'briefs'

/**
 * Canonical block order: hard constraints first, this turn's facts last.
 * The model-facing prompt is always assembled in this order.
 */
export const PROMPT_SECTION_ORDER: readonly PromptSectionKey[] = [
  'boundaries',
  'host',
  'persona',
  'scene',
  'briefs',
]

/**
 * Sacrifice order used when over budget: the first entry is dropped first.
 * `boundaries` is absent on purpose — it is never truncated.
 */
export const PROMPT_SACRIFICE_ORDER: readonly PromptSectionKey[] = ['briefs', 'scene', 'persona', 'host']

/** Everything the system prompt can be built from; every block is optional. */
export interface SystemPromptInput {
  /** Hard constraints from the pack; the highest-priority block. */
  readonly boundaries?: readonly string[]
  /** Host style (`host.md`). */
  readonly host?: string
  /** Full persona text (`persona.md`). */
  readonly persona?: string
  /** Scene / setting text (`setting.md`, phase note). */
  readonly scene?: string
  /** Narrative facts for this turn; must arrive digit-free. */
  readonly briefs?: readonly string[]
  /** Character budget; defaults to {@link DEFAULT_SYSTEM_PROMPT_BUDGET_CHARS}. */
  readonly budgetChars?: number
}

/** Input for {@link buildTurnMessages}. */
export interface TurnMessagesInput {
  /** Output of {@link buildSystemPrompt}; omitted or empty when a caller has none. */
  readonly system?: string
  /** Previous turns' lines, oldest first; rendered as assistant messages. */
  readonly recentLines?: readonly string[]
  /** The player message that opened this turn. */
  readonly playerText?: string
  /** Results of tools already invoked this turn (e.g. `look`), appended last. */
  readonly toolResults?: readonly LlmMessage[]
}

interface PromptSection {
  readonly key: PromptSectionKey
  readonly header: string
  readonly items: readonly string[]
}

/** Separator between two blocks of the assembled prompt. */
const SECTION_SEPARATOR = '\n\n'

/** A cut block must keep at least this many characters to be worth emitting. */
const MIN_TRUNCATED_BODY_CHARS = 8

const SECTION_HEADERS: Readonly<Record<PromptSectionKey, string>> = {
  boundaries: '## 边界（最高优先级，必须遵守）',
  host: '## 主持风格',
  persona: '## 人设',
  scene: '## 场景',
  briefs: '## 本回合事实（叙事化，不含数值）',
}

/**
 * Assemble the system prompt.
 *
 * Blocks that are absent or blank are skipped; the result is the surviving
 * blocks in {@link PROMPT_SECTION_ORDER}, joined by a blank line. An empty
 * input produces an empty string (the caller then omits the system message).
 */
export function buildSystemPrompt(input: SystemPromptInput): string {
  const budget = resolveBudget(input.budgetChars)
  const parts: string[] = []
  let used = 0
  for (const section of promptSections(input)) {
    const separator = parts.length === 0 ? 0 : SECTION_SEPARATOR.length
    const available = budget - used - separator
    const full = renderSection(section)
    if (section.key === 'boundaries') {
      // Never truncated or dropped, even when it alone exceeds the budget.
      parts.push(full)
      used += separator + full.length
      continue
    }
    if (available <= 0) break
    if (full.length <= available) {
      parts.push(full)
      used += separator + full.length
      continue
    }
    // Over budget: sacrifice according to PROMPT_SACRIFICE_ORDER. Because the
    // loop runs in PROMPT_SECTION_ORDER, a block that does not fit means every
    // later (lower-priority) block is dropped too.
    if (section.key === 'briefs') {
      const fitted = fitBriefs(section, available)
      if (fitted !== undefined) {
        parts.push(fitted)
        used += separator + fitted.length
      }
      break
    }
    if (section.key === 'scene') break // setting long text is dropped whole
    const truncated = truncateSection(section, available)
    if (truncated !== undefined) {
      parts.push(truncated)
      used += separator + truncated.length
    }
    break
  }
  return parts.join(SECTION_SEPARATOR)
}

/**
 * Build the message list for one model turn.
 *
 * Order: system prompt, previous lines as assistant messages, the player's
 * message, then any tool results from earlier in the same turn. Blank entries
 * are skipped so a caller can pass `playerText: undefined` on the opening turn.
 */
export function buildTurnMessages(input: TurnMessagesInput): LlmMessage[] {
  const messages: LlmMessage[] = []
  const system = input.system?.trim()
  if (system !== undefined && system !== '') messages.push({ role: 'system', content: system })
  for (const line of input.recentLines ?? []) {
    const content = line.trim()
    if (content !== '') messages.push({ role: 'assistant', content })
  }
  const playerText = input.playerText?.trim()
  if (playerText !== undefined && playerText !== '') messages.push({ role: 'user', content: playerText })
  for (const result of input.toolResults ?? []) messages.push(result)
  return messages
}

function resolveBudget(budgetChars: number | undefined): number {
  if (budgetChars === undefined || !Number.isFinite(budgetChars) || budgetChars <= 0) {
    return DEFAULT_SYSTEM_PROMPT_BUDGET_CHARS
  }
  return Math.floor(budgetChars)
}

/** Non-empty blocks in canonical order. */
function promptSections(input: SystemPromptInput): PromptSection[] {
  const sections: PromptSection[] = []
  const boundaries = cleanLines(input.boundaries)
  if (boundaries.length > 0) sections.push(sectionOf('boundaries', boundaries))
  const host = cleanLines(input.host === undefined ? [] : [input.host])
  if (host.length > 0) sections.push(sectionOf('host', host))
  const persona = cleanLines(input.persona === undefined ? [] : [input.persona])
  if (persona.length > 0) sections.push(sectionOf('persona', persona))
  const scene = cleanLines(input.scene === undefined ? [] : [input.scene])
  if (scene.length > 0) sections.push(sectionOf('scene', scene))
  const briefs = cleanLines(input.briefs)
  if (briefs.length > 0) sections.push(sectionOf('briefs', briefs))
  return sections
}

function sectionOf(key: PromptSectionKey, items: readonly string[]): PromptSection {
  return { key, header: SECTION_HEADERS[key], items }
}

function renderSection(section: PromptSection): string {
  return `${section.header}\n${renderItems(section.items)}`
}

/** Bullet lists for multi-line blocks, plain text for single-text blocks. */
function renderItems(items: readonly string[]): string {
  return items.map(item => `- ${item}`).join('\n')
}

/** Drop blank entries from a list of blocks (boundaries, host, persona, scene, briefs). */
function cleanLines(values: readonly string[] | undefined): string[] {
  const lines: string[] = []
  for (const value of values ?? []) {
    const line = value.trim()
    if (line !== '') lines.push(line)
  }
  return lines
}

/**
 * Fit as many whole briefs as possible into the remaining room. Briefs are
 * dropped from the end, matching "fewer retrieved snippets" in the documented
 * degradation order; a partial brief is never emitted.
 */
function fitBriefs(section: PromptSection, available: number): string | undefined {
  const header = `${section.header}\n`
  const room = available - header.length
  if (room <= 0) return undefined
  let body = ''
  for (const item of section.items) {
    const line = `- ${item}`
    const candidate = body === '' ? line : `${body}\n${line}`
    if (candidate.length > room) break
    body = candidate
  }
  return body === '' ? undefined : `${header}${body}`
}

/**
 * Cut a block's tail and mark it with {@link PROMPT_TRUNCATION_MARK}. Returns
 * `undefined` when too little room is left to be useful.
 */
function truncateSection(section: PromptSection, available: number): string | undefined {
  const header = `${section.header}\n`
  const body = renderItems(section.items)
  const room = available - header.length - PROMPT_TRUNCATION_MARK.length
  if (room < MIN_TRUNCATED_BODY_CHARS) return undefined
  return `${header}${body.slice(0, room).trimEnd()}${PROMPT_TRUNCATION_MARK}`
}
