/**
 * The M2 model tool surface (B1-T8 / D9).
 *
 * Twelve provider-neutral JSON Schema definitions exist; **nine** are visible to
 * the model. The three device-write tools (`set_level`, `run_pattern`,
 * `set_motion`) keep their definitions for the human console/debug path but are
 * not registered for the model: the single control entry is `apply_plan`, which
 * keeps one turn atomic for audit, preemption and probe registration
 * (§8.1 #1, `设计文档.md` §7).
 *
 * Security invariant (D4): no tool schema exposes a **cap or a read-back of
 * device state** — no `maxPercent`, no live output, no allowed duration/limit
 * values. `devices_list` returns region / tier / availability only. The two
 * percent-shaped fields in the surface are `apply_plan`'s *request* values
 * (`change.targetPercent`, `change.deltaPercent`): both are relative 0-100
 * values that the resolver maps through the channel's human-set interval. The
 * model never sees that interval or the resulting level, so they are not a
 * raise path (Lead ruling on B1-T8, 2026-11-01).
 *
 * Tool schemas are plain JSON Schema objects — no SDK type, no dependency. The
 * static part deliberately carries no `intentId`/`regions` enum: those are
 * injected at runtime from the loaded pack through {@link withPlayableEnums}
 * (§4.9.2 note). That helper clones `apply_plan` before adding the enums, so
 * one turn's playable menu can never mutate the shared static definitions.
 *
 * @module
 */

import { WHOLE_BODY_REGION } from '../scenario/beat-plan.ts'
import type { ToolDefinition } from './model.ts'

/** The nine tools the model may call, in prompt order. */
export const M2_MODEL_TOOL_NAMES = [
  'apply_plan',
  'sensors_list',
  'look',
  'devices_list',
  'waveform_list',
  'waveform_author',
  'state_get',
  'state_patch',
  'stop',
] as const

/** The three device-write tools that exist only for humans/debugging (D9). */
export const M2_HUMAN_ONLY_TOOL_NAMES = ['set_level', 'run_pattern', 'set_motion'] as const

export type M2ModelToolName = (typeof M2_MODEL_TOOL_NAMES)[number]
export type M2HumanOnlyToolName = (typeof M2_HUMAN_ONLY_TOOL_NAMES)[number]
export type M2ToolName = M2ModelToolName | M2HumanOnlyToolName

/**
 * Fields the engine injects into a `BeatPlan`; the model must not write them.
 * `apply_plan`'s argument schema is the plan contract minus exactly these.
 */
export const BEAT_PLAN_ENGINE_FIELDS = ['turnId', 'phase'] as const

const LEVEL_CHANGE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['kind'],
  additionalProperties: false,
  properties: {
    kind: { const: 'level' },
    targetPercent: {
      type: 'number',
      minimum: 0,
      maximum: 100,
      description: '0–100 的相对量：100% = 人类设定的通道上限；0 = 停止。',
    },
    deltaPercent: {
      type: 'number',
      minimum: -20,
      maximum: 20,
      description: '在当前输出位置上的相对变化量，同一 0–100 相对尺度。',
    },
    durationSec: { type: 'number', minimum: 1, maximum: 600 },
  },
}

const WAVEFORM_CHANGE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['kind', 'waveformId', 'durationSec'],
  additionalProperties: false,
  properties: {
    kind: { const: 'waveform' },
    waveformId: { type: 'string' },
    durationSec: { type: 'number', minimum: 1, maximum: 600 },
  },
}

/** `BeatChange`: a level change (strength/absolute/relative) or a waveform change. */
const BEAT_CHANGE_SCHEMA: Record<string, unknown> = {
  oneOf: [LEVEL_CHANGE_SCHEMA, WAVEFORM_CHANGE_SCHEMA],
}

const BEAT_STRENGTH_SCHEMA: Record<string, unknown> = {
  type: 'string',
  enum: ['low', 'med', 'high'],
}

const TEXTURE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    rate: { type: 'number', minimum: 0.5, maximum: 2 },
    intensityScale: { type: 'number', minimum: 0, maximum: 1 },
    phaseOffset: { type: 'number', minimum: 0, maximum: 1 },
  },
}

const BEAT_TARGET_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['deviceId', 'channelId'],
  additionalProperties: false,
  properties: {
    deviceId: { type: 'string' },
    channelId: { type: 'string' },
    change: BEAT_CHANGE_SCHEMA,
    strength: BEAT_STRENGTH_SCHEMA,
  },
}

const BEAT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['id', 'intentId', 'regions', 'strength'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 8 },
    // The value enum is injected at runtime from the loaded pack (§4.9.2).
    intentId: { type: 'string' },
    regions: {
      type: 'array',
      minItems: 1,
      items: { type: 'string' },
    },
    change: BEAT_CHANGE_SCHEMA,
    strength: BEAT_STRENGTH_SCHEMA,
    mustMention: { type: 'boolean' },
    targets: { type: 'array', items: BEAT_TARGET_SCHEMA },
    texture: TEXTURE_SCHEMA,
  },
}

const PLAYER_CHOICE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['id', 'label', 'tag'],
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    label: { type: 'string', minLength: 1, maxLength: 20 },
    tag: { type: 'string' },
  },
}

const LINE_GUIDANCE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    tone: { type: 'string' },
    mustMentionBeatIds: { type: 'array', items: { type: 'string' } },
  },
}

/** No-argument tools still declare a closed empty object. */
const NO_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {},
}

/** A single ramp bound for a waveform segment: a number or `{from,to}`. */
const RAMPED_VALUE_SCHEMA: Record<string, unknown> = {
  oneOf: [
    { type: 'number' },
    {
      type: 'object',
      required: ['from', 'to'],
      additionalProperties: false,
      properties: { from: { type: 'number' }, to: { type: 'number' } },
    },
  ],
}

const WAVEFORM_SEGMENT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['ms', 'freq', 'intensity'],
  additionalProperties: false,
  properties: {
    ms: { type: 'number', minimum: 1, maximum: 60000 },
    freq: RAMPED_VALUE_SCHEMA,
    intensity: RAMPED_VALUE_SCHEMA,
    curve: { type: 'string', enum: ['linear', 'easeIn', 'easeOut', 'step'] },
  },
}

/**
 * All twelve definitions, model-visible ones first.
 *
 * `apply_plan`'s `parameters` is exactly the `BeatPlan` contract (§4.3) minus
 * {@link BEAT_PLAN_ENGINE_FIELDS}; `parseBeatPlan` accepts what this schema
 * describes (tested).
 */
export const M2_TOOL_SCHEMAS: readonly ToolDefinition[] = [
  {
    name: 'apply_plan',
    description: '本回合的动作计划。turnId 与 phase 由引擎注入，不要自己写。一回合只能调用一次。强度只用 low/med/high，系统会按人类设定的通道范围换算。',
    parameters: {
      type: 'object',
      required: ['pacing', 'beats'],
      additionalProperties: false,
      properties: {
        pacing: { type: 'string', enum: ['hold', 'build', 'release', 'probe'] },
        nextTurnAfterSec: { type: 'number', minimum: 1 },
        beats: {
          type: 'array',
          minItems: 1,
          maxItems: 3,
          items: BEAT_SCHEMA,
        },
        choices: { type: 'array', maxItems: 3, items: PLAYER_CHOICE_SCHEMA },
        lineGuidance: LINE_GUIDANCE_SCHEMA,
      },
    },
  },
  {
    name: 'sensors_list',
    description: '列出命名感知源及其质量与新鲜度。没有配置感知源时返回空列表，属正常情况。只读。',
    parameters: NO_PARAMETERS,
  },
  {
    name: 'look',
    description: '取某个命名感知源的最新快照。每回合最多调用一次；过期或过大的快照会被拒绝。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sourceId: { type: 'string' },
      },
    },
  },
  {
    name: 'devices_list',
    description: '列出在线设备与通道：region、最近档位（low/med/high）与可用性。不含百分比、上限或实时输出值。只读。',
    parameters: NO_PARAMETERS,
  },
  {
    name: 'waveform_list',
    description: '列出可用波形摘要（id、名称、标签、时长、帧数、峰值均值），不含 hex。只读。',
    parameters: NO_PARAMETERS,
  },
  {
    name: 'waveform_author',
    description: '把段落 DSL 或 hex 帧编译成波形并存入本会话作用域（不进入永久库）。返回编译摘要。',
    parameters: {
      type: 'object',
      required: ['name'],
      additionalProperties: false,
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 64 },
        loop: { type: 'boolean' },
        tags: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 24 } },
        segments: { type: 'array', minItems: 1, maxItems: 64, items: WAVEFORM_SEGMENT_SCHEMA },
        frames: { type: 'array', minItems: 1, items: { type: 'string' } },
      },
      oneOf: [
        { required: ['segments'] },
        { required: ['frames'] },
      ],
    },
  },
  {
    name: 'state_get',
    description: '读取当前会话的结构化存档快照。只读。',
    parameters: NO_PARAMETERS,
  },
  {
    name: 'state_patch',
    description: '用 RFC 7386 JSON Merge Patch 增量修改存档：顶层只允许 scene/player/npcs/flags/learned；null 删除键；数组整体替换。不能修改当前阶段、回合或会话元数据。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        scene: {},
        player: {},
        npcs: {},
        flags: {},
        learned: {},
      },
    },
  },
  {
    name: 'stop',
    description: '立即停止所有设备输出（省略参数 = 全局停止）。任何状态都可用，包括 LOCKED。',
    parameters: NO_PARAMETERS,
  },
  {
    name: 'set_level',
    description: '【人类/调试控制台专用，不注册给模型】直接设置通道电平。模型的控制入口是 apply_plan。',
    parameters: {
      type: 'object',
      required: ['deviceId', 'channelId', 'level'],
      additionalProperties: false,
      properties: {
        deviceId: { type: 'string' },
        channelId: { type: 'string' },
        level: { type: 'string', enum: ['low', 'med', 'high'] },
        durationSec: { type: 'number', minimum: 1 },
      },
    },
  },
  {
    name: 'run_pattern',
    description: '【人类/调试控制台专用，不注册给模型】在通道上运行动作包络或预设波形。模型改用 apply_plan 的 change.waveformId。',
    parameters: {
      type: 'object',
      required: ['deviceId', 'channelId', 'preset'],
      additionalProperties: false,
      properties: {
        deviceId: { type: 'string' },
        channelId: { type: 'string' },
        preset: { type: 'string', enum: ['steady', 'pulse', 'wave', 'random', 'ramp'] },
        durationSec: { type: 'number', minimum: 1 },
        waveform: { type: 'string' },
      },
    },
  },
  {
    name: 'set_motion',
    description: '【人类/调试控制台专用（M6 预留），不注册给模型】设置运动/摆动类设备。',
    parameters: {
      type: 'object',
      required: ['deviceId', 'mode'],
      additionalProperties: false,
      properties: {
        deviceId: { type: 'string' },
        channelId: { type: 'string' },
        mode: { type: 'string' },
        durationSec: { type: 'number', minimum: 1 },
      },
    },
  },
]

/** The nine definitions the model may actually call (D9). */
export const M2_MODEL_TOOLS: readonly ToolDefinition[] = M2_TOOL_SCHEMAS.filter(tool =>
  (M2_MODEL_TOOL_NAMES as readonly string[]).includes(tool.name),
)

/** Definitions indexed by name, e.g. for the loop's `apply_plan` handling. */
export const M2_TOOL_SCHEMAS_BY_NAME: Readonly<Record<M2ToolName, ToolDefinition>> = Object.fromEntries(
  M2_TOOL_SCHEMAS.map(tool => [tool.name, tool]),
) as Record<M2ToolName, ToolDefinition>

/**
 * Whether a tool name is visible to the model.
 *
 * The loop uses this to reject a call to a human-only definition if one ever
 * leaks through a permissive provider.
 */
export function isModelTool(name: string): name is M2ModelToolName {
  return (M2_MODEL_TOOL_NAMES as readonly string[]).includes(name)
}

/**
 * Deep-copy a JSON-schema-shaped value, so a decorated copy can be edited
 * without touching the static definition (schemas are plain JSON: objects,
 * arrays, strings, numbers, booleans and null only).
 */
function cloneSchemaValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map(entry => cloneSchemaValue(entry)) as unknown as T
  if (typeof value === 'object' && value !== null) {
    const copy: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      copy[key] = cloneSchemaValue(entry)
    }
    return copy as T
  }
  return value
}

/** Narrow a schema node, or `undefined` when the shape is not an object. */
function asSchemaObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Trimmed, non-empty, first occurrence wins — the enum values a provider sees. */
function uniqueNonEmpty(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    const trimmed = value.trim()
    if (trimmed === '' || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

/**
 * Inject the pack's playable `intentId`/`regions` enums into `apply_plan`.
 *
 * The static schema advertises the *contract*; the loaded pack decides the
 * *values*. This helper is the runtime injection point (§4.9.2): it returns a
 * new tool list whose `apply_plan` carries
 *
 * - `intentId.enum` — the trimmed, deduplicated intent ids in pack order,
 *   omitted entirely when the list is empty (an empty enum is invalid JSON
 *   Schema and would make the tool uncallable);
 * - `regions.items.enum` — `whole-body` first, then the declared region ids,
 *   because the wildcard is always legal for any pack.
 *
 * Only `apply_plan` is decorated; every other definition is returned by
 * reference and the input array is never modified. The `parameters` tree of
 * `apply_plan` is deep-cloned before the enums are written, so the shared
 * {@link M2_TOOL_SCHEMAS} objects stay byte-identical across turns.
 *
 * @param tools - The model-visible tool list for this turn.
 * @param intentIds - Intent ids declared by the loaded pack.
 * @param regionIds - Region ids declared by the loaded pack (no wildcard
 *   required; it is added here).
 * @returns A new array with the decorated `apply_plan`, or `tools` unchanged
 *   when no `apply_plan` definition is present.
 */
export function withPlayableEnums(
  tools: readonly ToolDefinition[],
  intentIds: readonly string[],
  regionIds: readonly string[],
): readonly ToolDefinition[] {
  const index = tools.findIndex(tool => tool.name === 'apply_plan')
  if (index < 0) return tools
  const original = tools[index]
  if (original === undefined) return tools
  const parameters = cloneSchemaValue(original.parameters)
  const properties = asSchemaObject(parameters['properties'])
  const beats = properties === undefined ? undefined : asSchemaObject(properties['beats'])
  const beatItems = beats === undefined ? undefined : asSchemaObject(beats['items'])
  const beatProperties = beatItems === undefined ? undefined : asSchemaObject(beatItems['properties'])
  if (beatItems === undefined || beatProperties === undefined) return tools

  const intentEnum = uniqueNonEmpty(intentIds)
  if (intentEnum.length > 0) {
    const intentId = asSchemaObject(beatProperties['intentId'])
    if (intentId !== undefined) intentId['enum'] = intentEnum
  }
  // Else: leave the property enum-free rather than emitting an empty enum.

  const regionsSchema = asSchemaObject(beatProperties['regions'])
  const regionItems = regionsSchema === undefined ? undefined : asSchemaObject(regionsSchema['items'])
  if (regionItems !== undefined) {
    const declared = uniqueNonEmpty(regionIds).filter(id => id !== WHOLE_BODY_REGION)
    // `whole-body` is the wildcard every pack may use, so it is always legal.
    regionItems['enum'] = [WHOLE_BODY_REGION, ...declared]
  }

  const decorated: ToolDefinition = {
    name: original.name,
    description: original.description,
    parameters,
  }
  return tools.map((tool, toolIndex) => (toolIndex === index ? decorated : tool))
}
