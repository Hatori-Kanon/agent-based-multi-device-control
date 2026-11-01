import { describe, expect, it } from 'vitest'
import {
  TurnEngine,
  type EngineConfig,
  type EngineEvent,
  type TurnRunner,
} from '../src/engine/turn-engine.ts'
import type { TurnState } from '../src/engine/state-machine.ts'
import { AuditLog, type AuditRecord } from '../src/devices/audit.ts'
import { FakeClock } from '../src/ports/fake-clock.ts'
import { MemoryAppendOnlyStore } from '../src/ports/storage.ts'

function createHarness(runner: TurnRunner, config?: Partial<EngineConfig>) {
  const clock = new FakeClock()
  const store = new MemoryAppendOnlyStore()
  const audit = new AuditLog(store, clock, () => {})
  const events: EngineEvent[] = []
  const engine = new TurnEngine({
    clock,
    audit,
    runner,
    ...(config === undefined ? {} : { config }),
    onEvent: event => events.push(event),
  })
  const records = (): AuditRecord[] => store.lines.map(line => JSON.parse(line) as AuditRecord)
  return { clock, engine, events, records }
}

function stagedRunner(): TurnRunner {
  return {
    async run(request) {
      request.onStage?.('executing')
      await Promise.resolve()
      request.onStage?.('writing')
      return { line: '（低笑）你退后了半步。' }
    },
  }
}

describe('turn choices (B2-T6)', () => {
  it('submits a choice as a player turn', async () => {
    const requests: { choiceId?: string; playerText?: string }[] = []
    const offered = [
      { id: 'c1', label: '退开', tag: 'resist' },
      { id: 'c2', label: '别动', tag: 'passive' },
      { id: 'c3', label: '求你', tag: 'plead' },
      { id: 'c4', label: '照做', tag: 'comply' },
    ]
    let calls = 0
    const runner: TurnRunner = {
      async run(request) {
        calls += 1
        requests.push({
          ...(request.choiceId === undefined ? {} : { choiceId: request.choiceId }),
          ...(request.playerText === undefined ? {} : { playerText: request.playerText }),
        })
        return calls === 1 ? { line: '第一句', choices: offered } : { line: '第二句' }
      },
    }
    const h = createHarness(runner)
    await h.engine.submitPlayerMessage('开始')

    // 0–3: four suggested options are capped to the configured maximum (3).
    expect(h.engine.snapshot().choices?.map(choice => choice.id)).toEqual(['c1', 'c2', 'c3'])
    const offeredRecord = h.records().find(record => record.action === 'choices_offered')
    expect(offeredRecord?.actor).toBe('system')
    expect(offeredRecord?.detail).toEqual({ turnId: 1, ids: ['c1', 'c2', 'c3'] })
    // Autopilot off: a menu waits for the player indefinitely.
    expect(h.clock.pendingCount).toBe(0)

    await h.engine.submitChoice('c2')

    expect(calls).toBe(2)
    expect(requests[1]?.choiceId).toBe('c2')
    expect(requests[1]?.playerText).toBeUndefined()
    expect(h.engine.state).toBe('idle')
    expect(h.engine.snapshot().lastLine).toBe('第二句')
    // The selection is audited as a human action against the offering turn,
    // and it is ordered before the new turn opens.
    const selected = h.records().find(record => record.action === 'choice_selected')
    expect(selected?.actor).toBe('human')
    expect(selected?.detail).toMatchObject({ turnId: 1, choiceId: 'c2', tag: 'passive' })
    const actions = h.records().map(record => record.action)
    expect(actions.indexOf('choice_selected')).toBeLessThan(actions.lastIndexOf('turn_started'))
    expect(actions).not.toContain('choice_timeout')
    expect(h.clock.pendingCount).toBe(0)
  })

  it('treats a timeout as passive only while autopilot is on', async () => {
    // 1) Autopilot off: no timer is armed and the session waits for the player.
    let manualCalls = 0
    const manualRunner: TurnRunner = {
      async run() {
        manualCalls += 1
        return manualCalls === 1
          ? { line: '第一句', choices: [{ id: 'c1', label: '退开', tag: 'resist' }] }
          : { line: '第二句' }
      },
    }
    const manual = createHarness(manualRunner)
    await manual.engine.submitPlayerMessage('开始')
    expect(manual.clock.pendingCount).toBe(0)
    manual.clock.advance(10 * 60_000)
    await Promise.resolve()
    expect(manualCalls).toBe(1)
    expect(manual.engine.snapshot().choices).toHaveLength(1)
    expect(manual.records().some(record => record.action === 'choice_timeout')).toBe(false)
    manual.engine.dispose()

    // 2) Autopilot on: the 60s timeout is passive and the director continues.
    let autoCalls = 0
    const autoRunner: TurnRunner = {
      async run() {
        autoCalls += 1
        return autoCalls === 1
          ? { line: '第一句', choices: [{ id: 'c1', label: '退开', tag: 'resist' }] }
          : { line: '第二句' }
      },
    }
    const h = createHarness(autoRunner)
    h.engine.setAutopilot(true)
    await h.engine.submitPlayerMessage('开始')
    expect(h.engine.snapshot().choices).toHaveLength(1)
    // A pending menu suppresses the autopilot tick: no turn replaces the menu.
    h.clock.advance(20_000)
    await Promise.resolve()
    expect(autoCalls).toBe(1)
    // At choices.timeoutSec the menu expires as passive and a turn opens.
    h.clock.advance(40_000)
    await h.engine.whenIdle()
    expect(autoCalls).toBe(2)
    expect(h.engine.snapshot().choices).toBeUndefined()
    const timeout = h.records().find(record => record.action === 'choice_timeout')
    expect(timeout?.actor).toBe('system')
    expect(timeout?.detail).toMatchObject({ turnId: 1 })
    expect(h.engine.state).toBe('idle')

    h.engine.stopAutopilot()
    expect(h.clock.pendingCount).toBe(0)
  })

  it('accepts zero choices for a high-intensity turn', async () => {
    let calls = 0
    const runner: TurnRunner = {
      async run() {
        calls += 1
        return { line: '这一回合没有可选项', choices: [] }
      },
    }
    const h = createHarness(runner)
    h.engine.setAutopilot(true)
    await h.engine.submitPlayerMessage('开始')

    // 0 choices is legal (`choices.max` is only an upper bound) and starts no
    // passive timeout: only the autopilot tick is pending after the turn.
    expect(calls).toBe(1)
    expect(h.engine.snapshot().choices).toEqual([])
    expect(h.events.some(event => event.type === 'error')).toBe(false)
    expect(h.clock.pendingCount).toBe(1)
    expect(h.records().find(record => record.action === 'choices_offered')?.detail)
      .toEqual({ turnId: 1, ids: [] })

    h.engine.stopAutopilot()
    expect(h.clock.pendingCount).toBe(0)
    h.clock.advance(10 * 60_000)
    await Promise.resolve()
    expect(calls).toBe(1)
    expect(h.records().some(record => record.action === 'choice_timeout')).toBe(false)
    expect(h.engine.state).toBe('idle')
  })

  it('refuses an unknown choice id while a menu is open', async () => {
    let calls = 0
    const runner: TurnRunner = {
      async run() {
        calls += 1
        return calls === 1
          ? { line: '第一句', choices: [{ id: 'c1', label: '退开', tag: 'resist' }] }
          : { line: '第二句' }
      },
    }
    const h = createHarness(runner)
    await h.engine.submitPlayerMessage('开始')
    await h.engine.submitChoice('c9')

    expect(calls).toBe(1)
    expect(h.engine.state).toBe('idle')
    expect(h.records().some(record => record.action === 'choice_selected')).toBe(false)
    expect(h.events.some(event => event.type === 'error'
      && (event.detail as { reason?: string }).reason === 'unknown_choice')).toBe(true)
    expect(h.clock.pendingCount).toBe(0)
  })

  it('leaves a plain turn without a choice menu', async () => {
    const h = createHarness(stagedRunner())
    await h.engine.submitPlayerMessage('你好')
    expect(h.engine.state).toBe('idle')
    expect(h.engine.snapshot().choices).toBeUndefined()
    expect(h.records().some(record => record.action === 'choices_offered')).toBe(false)
    expect(h.clock.pendingCount).toBe(0)
  })
})
