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
 * injected at runtime from the loaded pack (§4.9.2 note).
 *
 * @module
 */

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
