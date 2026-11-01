import { describe, expect, it } from 'vitest'
import { DEFAULT_CHECKPOINTS, PhaseMachine, type PhaseNode } from '../src/scenario/phases.ts'

function graph(): readonly PhaseNode[] {
  return [
    { id: 'probe', goal: '试探与观察', next: ['escalate'] },
    { id: 'escalate', goal: '推进与施压', next: ['peak', 'resolve'] },
    { id: 'peak', goal: '维持峰值', next: ['resolve'] },
    { id: 'resolve', goal: '收束与事后照顾', next: [] },
  ]
}

describe('phase machine', () => {
  it('never advances to a phase outside next', () => {
    const machine = new PhaseMachine(graph())
    expect(machine.current).toBe('probe')
    expect(machine.allowedNext).toEqual(['escalate'])

    // `resolve` exists in the graph but is not an edge from `probe`.
    expect(() => machine.advanceTo('resolve')).toThrow(/allowed next: escalate/u)
    expect(machine.current).toBe('probe')

    machine.advanceTo('escalate')
    expect(machine.current).toBe('escalate')
    expect(machine.allowedNext).toEqual(['peak', 'resolve'])

    // A terminal phase has no outgoing edges at all.
    machine.advanceTo('resolve')
    expect(machine.isTerminal).toBe(true)
    expect(() => machine.advanceTo('probe')).toThrow(/terminal/u)
  })

  it('emits a drift hint when a resolve-shaped plan runs in the probe phase', () => {
    const machine = new PhaseMachine(graph())

    // Release pacing in an early phase is drift.
    const release = machine.driftHint({ phase: 'probe', pacing: 'release', beats: [{ intentId: 'soothe' }] })
    expect(release).toBeDefined()
    expect(release).toContain('probe')
    expect(release).toContain('resolve')

    // Only closing beats is the same shape even without release pacing.
    expect(machine.driftHint({ phase: 'probe', pacing: 'build', beats: [{ intentId: 'stop' }] })).toBeDefined()

    // A probe-shaped plan fits and says nothing.
    expect(machine.driftHint({ phase: 'probe', pacing: 'probe', beats: [{ intentId: 'probe-touch' }] })).toBeUndefined()

    // A plan stamped with a non-adjacent phase is drift even when its beats fit.
    expect(machine.driftHint({ phase: 'peak', pacing: 'build', beats: [{ intentId: 'ambient-field' }] })).toContain('peak')

    // In the terminal phase a resolve-shaped plan is exactly right.
    machine.advanceTo('escalate')
    machine.advanceTo('peak')
    machine.advanceTo('resolve')
    expect(machine.driftHint({ phase: 'resolve', pacing: 'release', beats: [{ intentId: 'soothe' }] })).toBeUndefined()
  })

  it('sets mustResolve from the 90% checkpoint', () => {
    const machine = new PhaseMachine(graph())
    expect(DEFAULT_CHECKPOINTS).toEqual([0.5, 0.8, 0.9])

    expect(machine.at(0.49)).toEqual({ mustResolve: false })
    expect(machine.at(0.5)).toEqual({ checkpoint: 0.5, mustResolve: false })
    expect(machine.at(0.79)).toEqual({ checkpoint: 0.5, mustResolve: false })
    expect(machine.at(0.8)).toEqual({ checkpoint: 0.8, mustResolve: false })
    expect(machine.at(0.89)).toEqual({ checkpoint: 0.8, mustResolve: false })
    expect(machine.at(0.9)).toEqual({ checkpoint: 0.9, mustResolve: true })
    // Overshoot keeps the closing flag on.
    expect(machine.at(1.4)).toEqual({ checkpoint: 0.9, mustResolve: true })
    // Garbage ratios fall back to "not started" instead of throwing.
    expect(machine.at(Number.NaN)).toEqual({ mustResolve: false })
  })

  it('starts from a declared phase and refuses unknown ones', () => {
    expect(new PhaseMachine(graph()).current).toBe('probe')
    expect(new PhaseMachine(graph(), 'peak').current).toBe('peak')
    expect(() => new PhaseMachine(graph(), 'nowhere')).toThrow(/unknown starting phase/u)
    expect(() => new PhaseMachine([])).toThrow(/at least one phase/u)
    const duplicated = [...graph(), { id: 'probe', goal: 'duplicate', next: [] }]
    expect(() => new PhaseMachine(duplicated)).toThrow(/unique ids/u)
  })
})
