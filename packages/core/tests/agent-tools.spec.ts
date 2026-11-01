import { describe, expect, it } from 'vitest'
import type { ToolDefinition } from '../src/agent/model.ts'
import {
  BEAT_PLAN_ENGINE_FIELDS,
  isModelTool,
  M2_HUMAN_ONLY_TOOL_NAMES,
  M2_MODEL_TOOL_NAMES,
  M2_MODEL_TOOLS,
  M2_TOOL_SCHEMAS,
  M2_TOOL_SCHEMAS_BY_NAME,
} from '../src/agent/tools.ts'
import { parseBeatPlan } from '../src/scenario/beat-plan.ts'
import type { PlanContext } from '../src/scenario/beat-plan.ts'
import { DEFAULT_INTENTS } from '../src/scenario/default-intents.ts'
import type { FeedbackIntent } from '../src/scenario/intents.ts'

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function objectKeys(value: unknown): string[] {
  return Object.keys(asRecord(value)).sort()
}

function parametersOf(tool: ToolDefinition): Record<string, unknown> {
  return asRecord(tool.parameters)
}

interface PropertyRef {
  /** Dotted logical path, e.g. `apply_plan.beats.change.targetPercent`. */
  readonly path: string
  readonly key: string
}

/** Every `properties` key in every tool schema, with a path for diagnostics. */
function collectPropertyRefs(tools: readonly ToolDefinition[]): PropertyRef[] {
  const refs: PropertyRef[] = []
  const walk = (name: string, node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      for (let index = 0; index < node.length; index += 1) walk(name, node[index], `${path}[${index}]`)
      return
    }
    if (typeof node !== 'object' || node === null) return
    const record = node as Record<string, unknown>
    const properties = record['properties']
    if (typeof properties === 'object' && properties !== null && !Array.isArray(properties)) {
      for (const [key, child] of Object.entries(properties as Record<string, unknown>)) {
        refs.push({ path: `${name}.${path}${key}`, key })
        walk(name, child, `${path}${key}.`)
      }
    }
    for (const [key, child] of Object.entries(record)) {
      if (key === 'properties') continue
      walk(name, child, `${path}${key}.`)
    }
  }
  for (const tool of tools) walk(tool.name, tool.parameters, '')
  return refs
}

function planContext(): PlanContext {
  const intents = new Map<string, FeedbackIntent>(DEFAULT_INTENTS.map(intent => [intent.id, intent]))
  return { intents, regions: ['chest', 'whole-body'] }
}

/** A plan whose shape follows the apply_plan argument schema exactly. */
function sampleApplyPlan(): Record<string, unknown> {
  return {
    pacing: 'build',
    nextTurnAfterSec: 20,
    beats: [{
      id: 'b1',
      intentId: 'probe-touch',
      regions: ['chest'],
      strength: 'med',
      change: { kind: 'level', targetPercent: 60, deltaPercent: 5 },
      mustMention: true,
      targets: [{
        deviceId: 'coyote-1',
        channelId: 'A',
        strength: 'low',
        change: { kind: 'waveform', waveformId: 'tide', durationSec: 10 },
      }],
      texture: { rate: 1.2, intensityScale: 0.8, phaseOffset: 0.1 },
    }],
    choices: [{ id: 'c1', label: '继续', tag: 'comply' }],
    lineGuidance: { tone: '克制', mustMentionBeatIds: ['b1'] },
  }
}

describe('M2 model tool surface', () => {
  it('defines twelve tools and exposes nine', () => {
    expect(M2_TOOL_SCHEMAS).toHaveLength(12)
    expect(M2_MODEL_TOOLS).toHaveLength(9)
    expect(new Set(M2_TOOL_SCHEMAS.map(tool => tool.name)).size).toBe(12)
    expect([...M2_TOOL_SCHEMAS.map(tool => tool.name)].sort())
      .toEqual([...M2_MODEL_TOOL_NAMES, ...M2_HUMAN_ONLY_TOOL_NAMES].sort())
    expect(M2_MODEL_TOOLS.map(tool => tool.name)).toEqual([...M2_MODEL_TOOL_NAMES])
    // Every definition is a plain JSON Schema object, not an SDK type.
    for (const tool of M2_TOOL_SCHEMAS) {
      expect(tool.name).not.toBe('')
      expect(tool.description).not.toBe('')
      const parameters = parametersOf(tool)
      expect(parameters['type']).toBe('object')
      expect(typeof parameters['properties']).toBe('object')
      expect(M2_TOOL_SCHEMAS_BY_NAME[tool.name as keyof typeof M2_TOOL_SCHEMAS_BY_NAME]).toBe(tool)
    }
  })

  it('keeps set_level, run_pattern and set_motion out of the model tool list', () => {
    const modelNames = M2_MODEL_TOOLS.map(tool => tool.name)
    expect(modelNames[0]).toBe('apply_plan')
    for (const name of M2_HUMAN_ONLY_TOOL_NAMES) {
      expect(modelNames).not.toContain(name)
      expect(isModelTool(name)).toBe(false)
      // The definition still exists for the human console / debug path (D9).
      expect(M2_TOOL_SCHEMAS_BY_NAME[name].name).toBe(name)
    }
    expect(isModelTool('apply_plan')).toBe(true)
    expect(isModelTool('sensors_list')).toBe(true)
  })

  it('exposes apply_plan whose argument schema equals BeatPlan minus engine fields', () => {
    const applyPlan = M2_TOOL_SCHEMAS_BY_NAME.apply_plan
    const parameters = parametersOf(applyPlan)
    const properties = asRecord(parameters['properties'])

    // BeatPlan top level minus the engine-injected fields (§4.3).
    expect(objectKeys(properties)).toEqual(['beats', 'choices', 'lineGuidance', 'nextTurnAfterSec', 'pacing'])
    expect(parameters['required']).toEqual(['pacing', 'beats'])
    for (const engineField of BEAT_PLAN_ENGINE_FIELDS) {
      expect(properties).not.toHaveProperty(engineField)
      // The description tells the model the engine injects them.
      expect(applyPlan.description).toContain(engineField)
    }

    // Beat: id / intentId / regions / change / strength / mustMention / targets / texture.
    const beat = asRecord(asRecord(properties['beats'])['items'])
    const beatProperties = asRecord(beat['properties'])
    expect(objectKeys(beatProperties)).toEqual([
      'change',
      'id',
      'intentId',
      'mustMention',
      'regions',
      'strength',
      'targets',
      'texture',
    ])
    expect(beat['required']).toEqual(['id', 'intentId', 'regions', 'strength'])

    // BeatChange: a level branch and a waveform branch.
    const changeBranches = asRecord(beatProperties['change'])['oneOf']
    expect(Array.isArray(changeBranches)).toBe(true)
    const branches = changeBranches as readonly Record<string, unknown>[]
    expect(branches).toHaveLength(2)
    expect(objectKeys(asRecord(branches[0])['properties'])).toEqual([
      'deltaPercent',
      'durationSec',
      'kind',
      'targetPercent',
    ])
    expect(objectKeys(asRecord(branches[1])['properties'])).toEqual(['durationSec', 'kind', 'waveformId'])

    // Per-target override: device/channel plus the same change/strength fields.
    const target = asRecord(asRecord(beatProperties['targets'])['items'])
    expect(objectKeys(asRecord(target['properties']))).toEqual(['change', 'channelId', 'deviceId', 'strength'])

    // D16 texture: parsed and range-checked only.
    expect(objectKeys(asRecord(beatProperties['texture'])['properties'])).toEqual([
      'intensityScale',
      'phaseOffset',
      'rate',
    ])

    // Choices and line guidance.
    const choice = asRecord(asRecord(properties['choices'])['items'])
    expect(objectKeys(asRecord(choice['properties']))).toEqual(['id', 'label', 'tag'])
    expect(objectKeys(asRecord(properties['lineGuidance'])['properties'])).toEqual(['mustMentionBeatIds', 'tone'])
  })

  it('exposes no percent field in any tool schema', () => {
    const refs = collectPropertyRefs(M2_TOOL_SCHEMAS)
    const percentKeys = refs.filter(ref => /percent/i.test(ref.key))

    // Explicit allow-list (Lead ruling, 2026-11-01): these two are BeatPlan
    // *request* values. The resolver clamps them to the effective cap and the
    // model can never read the cap or the resulting level back, so they are not
    // a cap-raise path. Every other percent-shaped field is forbidden.
    expect([...new Set(percentKeys.map(ref => ref.key))].sort()).toEqual(['deltaPercent', 'targetPercent'])
    for (const ref of percentKeys) {
      expect(ref.path.startsWith('apply_plan.')).toBe(true)
      expect(ref.path).toContain('change.')
    }

    // No cap or live-value read-back fields anywhere, including the three
    // human-only definitions.
    const forbidden = [
      'percent',
      'maxPercent',
      'currentPercent',
      'outputFloorPercent',
      'effectivePercent',
      'maxWaveIntensity',
      'maxDurationSec',
      'maxIntensity',
      'currentOutput',
      'outputPercent',
      'ceiling',
    ]
    const keys = refs.map(ref => ref.key.toLowerCase())
    for (const name of forbidden) expect(keys).not.toContain(name.toLowerCase())
    // No property is named like a limit either (maxItems/maxLength are JSON
    // Schema keywords, not properties, and are not collected here).
    expect(refs.filter(ref => /^(max|min|cap)/i.test(ref.key))).toEqual([])
  })

  it('exposes devices_list and the other read tools without cap or live values', () => {
    expect(objectKeys(asRecord(parametersOf(M2_TOOL_SCHEMAS_BY_NAME.devices_list)['properties']))).toEqual([])
    expect(objectKeys(asRecord(parametersOf(M2_TOOL_SCHEMAS_BY_NAME.look)['properties']))).toEqual(['sourceId'])
    for (const name of ['sensors_list', 'waveform_list', 'state_get', 'stop'] as const) {
      expect(objectKeys(asRecord(parametersOf(M2_TOOL_SCHEMAS_BY_NAME[name])['properties']))).toEqual([])
    }
  })

  it('leaves intent and region enums to the runtime', () => {
    const beat = asRecord(asRecord(asRecord(parametersOf(M2_TOOL_SCHEMAS_BY_NAME.apply_plan)['properties'])['beats'])['items'])
    const beatProperties = asRecord(beat['properties'])
    // §4.9.2 note: the value enum is injected from the loaded pack, never baked in.
    expect(asRecord(beatProperties['intentId'])['enum']).toBeUndefined()
    expect(asRecord(asRecord(beatProperties['regions'])['items'])['enum']).toBeUndefined()
    const schemaText = JSON.stringify(M2_TOOL_SCHEMAS)
    for (const intent of DEFAULT_INTENTS) {
      if (intent.id === 'stop') continue // also a tool name
      expect(schemaText).not.toContain(intent.id)
    }
  })

  it('accepts a plan shaped by the apply_plan schema through parseBeatPlan', () => {
    const ctx = planContext()
    const sample = sampleApplyPlan()

    // The sample covers every field the schema requires, so the two contracts
    // are checked against each other instead of against copies of themselves.
    const parameters = parametersOf(M2_TOOL_SCHEMAS_BY_NAME.apply_plan)
    const requiredTopLevel = parameters['required'] as readonly string[]
    for (const key of requiredTopLevel) expect(sample).toHaveProperty(key)
    const beats = sample['beats'] as readonly Record<string, unknown>[]
    const beatSchema = asRecord(asRecord(asRecord(parameters['properties'])['beats'])['items'])
    for (const key of beatSchema['required'] as readonly string[]) expect(beats[0]).toHaveProperty(key)

    const { plan, dropped, warnings } = parseBeatPlan(sample, ctx)
    expect(dropped).toEqual([])
    expect(warnings).toEqual([])
    expect(plan.pacing).toBe('build')
    expect(plan.nextTurnAfterSec).toBe(20)
    expect(plan.beats).toHaveLength(1)
    expect(plan.beats[0]?.id).toBe('b1')
    expect(plan.beats[0]?.change).toEqual({ kind: 'level', targetPercent: 60, deltaPercent: 5 })
    expect(plan.beats[0]?.targets?.[0]?.change).toEqual({ kind: 'waveform', waveformId: 'tide', durationSec: 10 })
    expect(plan.beats[0]?.texture).toEqual({ rate: 1.2, intensityScale: 0.8, phaseOffset: 0.1 })
    expect(plan.choices?.[0]?.label).toBe('继续')
    expect(plan.lineGuidance?.tone).toBe('克制')

    // The parser enforces the same shape the schema advertises: no beats ⇒ no
    // plan, and an intent outside the runtime table is dropped.
    const noBeats = parseBeatPlan({ pacing: 'build' }, ctx)
    expect(noBeats.plan.beats).toEqual([])
    expect(noBeats.dropped.some(drop => drop.rule === 'beats')).toBe(true)
    const unknownIntent = parseBeatPlan({
      pacing: 'build',
      beats: [{ id: 'b1', intentId: 'not-an-intent', regions: ['chest'], strength: 'med' }],
    }, ctx)
    expect(unknownIntent.plan.beats).toEqual([])
    expect(unknownIntent.dropped.some(drop => drop.rule === 'intent')).toBe(true)
  })
})
