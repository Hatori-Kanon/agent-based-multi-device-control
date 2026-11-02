import { describe, expect, it } from 'vitest'
import { ENGINE_VERSION } from '../src/version.ts'
import type { PackManifest, ScenarioDefinition } from '../src/scenario/loader.ts'
import { MAX_PACK_BYTES, validatePack, type ValidatePackInput, type ValidationIssue } from '../src/scenario/validate.ts'

function manifest(overrides: Record<string, unknown> = {}): PackManifest {
  return {
    id: 'probe-pack',
    name: '试探包',
    version: '0.1.0',
    engine: '>=0.2 <1.0',
    mode: 'scenario',
    rating: 'all',
    boundaries: ['不得出现疼痛描写'],
    ...overrides,
  } as PackManifest
}

function scenario(overrides: Record<string, unknown> = {}): ScenarioDefinition {
  return {
    session: {
      plannedMinutes: 45,
      phaseWindows: [
        { phase: 'probe', from: 0, to: 0.2 },
        { phase: 'resolve', from: 0.8, to: 1 },
      ],
      aftercareMin: 5,
    },
    regions: [
      { id: 'chest', label: '胸口' },
      { id: 'whole-body', label: '全身' },
    ],
    phases: [
      { id: 'probe', goal: '试探与观察', next: ['resolve'] },
      { id: 'resolve', goal: '收束与事后照顾', next: [] },
    ],
    feedbackIntents: [
      { id: 'probe-touch', meaning: '短促试探', regions: ['chest'], suggest: { preset: 'pulse', waveform: 'builtin:tide', durationSec: 2, strength: 'low' } },
      { id: 'soothe', meaning: '安抚', regions: ['whole-body'], suggest: { preset: 'wave', durationSec: 10, strength: 'low' } },
    ],
    ...overrides,
  } as ScenarioDefinition
}

function baseInput(): ValidatePackInput {
  const files = ['pack.json', 'persona.md', 'scenario.json', 'phases/probe.md', 'phases/resolve.md']
  return {
    manifest: manifest(),
    files,
    sizes: new Map(files.map(file => [file, 16])),
    scenario: scenario(),
    engineVersion: ENGINE_VERSION,
  }
}

function rules(issues: readonly ValidationIssue[], severity: 'error' | 'warning'): readonly string[] {
  return issues.filter(issue => issue.severity === severity).map(issue => issue.rule)
}

describe('content-pack validation', () => {
  it('treats regions as optional recommendations (v6)', () => {
    // A pack may ship no recommendation list at all; intents without their own
    // regions default to whole-body, and the session adds the player's names.
    const bare = scenario({
      regions: undefined,
      feedbackIntents: [
        // `whole-body` is legal without a declared regions list.
        { id: 'probe-touch', meaning: '短促试探', regions: ['whole-body'] },
        { id: 'soothe', meaning: '安抚' },
      ],
    })
    const issues = validatePack({ ...baseInput(), scenario: bare })
    expect(rules(issues, 'error')).toEqual([])
    expect(rules(issues, 'warning')).toContain('scenario.regions')

    // If the field is present it must still be an array.
    const malformed = { ...baseInput(), scenario: scenario({ regions: 'chest' }) }
    expect(rules(validatePack(malformed), 'error')).toContain('scenario.regions')
  })

  it('accepts a reachable phase graph and rejects a dead end with no terminal phase', () => {
    // The base fixture is a linear probe → resolve graph: valid, no errors.
    expect(rules(validatePack(baseInput()), 'error')).toEqual([])

    // probe ⇄ escalate: every phase is reachable but none is terminal, so a
    // session could never end.
    const deadEnd = scenario({
      session: {
        plannedMinutes: 45,
        phaseWindows: [
          { phase: 'probe', from: 0, to: 0.5 },
          { phase: 'escalate', from: 0.5, to: 1 },
        ],
        aftercareMin: 5,
      },
      phases: [
        { id: 'probe', goal: '试探', next: ['escalate'] },
        { id: 'escalate', goal: '施压', next: ['probe'] },
      ],
    })
    const issues = validatePack({ ...baseInput(), scenario: deadEnd })
    expect(rules(issues, 'error')).toContain('phases.no-terminal')
  })

  it('rejects a duplicate intent id and only warns for an unreferenced intent', () => {
    const duplicated = scenario({
      feedbackIntents: [
        { id: 'probe-touch', meaning: '短促试探', regions: ['chest'] },
        { id: 'probe-touch', meaning: '重复的意图', regions: ['chest'] },
        { id: 'soothe', meaning: '安抚', regions: ['whole-body'] },
      ],
    })
    expect(rules(validatePack({ ...baseInput(), scenario: duplicated }), 'error')).toContain('intent.duplicate')

    // Rule 9: a metaReactions `firstIntent` the pack's table does not define is
    // an unreferenced intent — only the tone is injected, so it warns.
    const unreferenced = manifest({
      metaReactions: [{ when: { endReason: ['left_early'] }, opening: { tone: 'cold', firstIntent: 'restrained-opening' } }],
    })
    const warnings = validatePack({ ...baseInput(), manifest: unreferenced })
    expect(rules(warnings, 'error')).toEqual([])
    expect(rules(warnings, 'warning')).toContain('metaReaction.firstIntent')
  })

  it('rejects an intent region the scenario never declares', () => {
    const undeclared = scenario({
      feedbackIntents: [{ id: 'probe-touch', meaning: '短促试探', regions: ['inner-thigh'] }],
    })
    const issues = validatePack({ ...baseInput(), scenario: undeclared })
    expect(rules(issues, 'error')).toContain('intent.region-undeclared')
  })

  it('rejects files outside the whitelist and unsafe paths', () => {
    const files = ['pack.json', 'persona.md', 'scenario.json', 'notes.txt', '../escape.md']
    const issues = validatePack({
      ...baseInput(),
      files,
      sizes: new Map(files.map(file => [file, 16])),
    })
    expect(rules(issues, 'error')).toContain('files.extension')
    expect(rules(issues, 'error')).toContain('files.path')
  })

  it('warns about ignored scenario boundaries and a missing host file', () => {
    const withLegacyFields = { ...scenario(), host: 'missing-host.md', boundaries: ['只在 pack.json 声明'] }
    const issues = validatePack({ ...baseInput(), scenario: withLegacyFields })
    expect(rules(issues, 'error')).toEqual([])
    expect(rules(issues, 'warning')).toContain('scenario.host')
    expect(rules(issues, 'warning')).toContain('scenario.boundaries')
  })

  it('refuses an unknown distribution value', () => {
    const badDistribution = scenario({
      feedbackIntents: [{ id: 'ambient-field', meaning: '持续环境', regions: ['whole-body'], distribution: 'round' }],
    })
    const issues = validatePack({ ...baseInput(), scenario: badDistribution })
    expect(rules(issues, 'error')).toContain('intent.distribution')
  })

  it('refuses a pack over the 50MB total limit', () => {
    const input = baseInput()
    const sizes = new Map(input.sizes)
    sizes.set('pack.json', MAX_PACK_BYTES + 1)
    const issues = validatePack({ ...input, sizes })
    expect(rules(issues, 'error')).toContain('files.total-size')
  })

  it('warns for an engine capability M2 does not implement', () => {
    const issues = validatePack({ ...baseInput(), manifest: manifest({ requires: ['hr', 'waveform'] }) })
    expect(rules(issues, 'error')).toEqual([])
    expect(rules(issues, 'warning')).toContain('manifest.requires')
  })

  it('refuses an engine range that excludes ENGINE_VERSION', () => {
    const issues = validatePack({ ...baseInput(), manifest: manifest({ engine: '>=0.9 <1.0' }) })
    expect(rules(issues, 'error')).toContain('manifest.engine')
  })

  it('accepts a freeform pack with only the manifest and persona', () => {
    const { scenario: ignoredScenario, ...withoutScenario } = baseInput()
    void ignoredScenario
    const input: ValidatePackInput = {
      ...withoutScenario,
      manifest: manifest({ mode: 'freeform' }),
      files: ['pack.json', 'persona.md'],
      sizes: new Map([['pack.json', 120], ['persona.md', 400]]),
    }
    expect(rules(validatePack(input), 'error')).toEqual([])
  })
})
