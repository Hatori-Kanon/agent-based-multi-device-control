import { describe, expect, it } from 'vitest'
import {
  TurnEngine,
  type CheckpointUpdate,
  type EndReason,
  type EngineConfig,
  type EngineEvent,
  type TurnRunner,
} from '../src/engine/turn-engine.ts'
import type { TurnState } from '../src/engine/state-machine.ts'
import { AuditLog, type AuditRecord } from '../src/devices/audit.ts'
import { FakeClock } from '../src/ports/fake-clock.ts'
import { MemoryAppendOnlyStore } from '../src/ports/storage.ts'

interface HarnessOptions {
  readonly config?: Partial<EngineConfig>
  readonly plannedMinutes?: number
  readonly onEnd?: (reason: EndReason) => Promise<void> | void
  readonly onCheckpoint?: (update: CheckpointUpdate) => void
  readonly onPlanPacing?: (seconds: number) => void
  readonly onEvent?: (event: EngineEvent) => void
}

function createHarness(runner: TurnRunner, options: HarnessOptions = {}) {
  const clock = new FakeClock()
  const store = new MemoryAppendOnlyStore()
  const audit = new AuditLog(store, clock, () => {})
  const events: EngineEvent[] = []
  const engine = new TurnEngine({
    clock,
    audit,
    runner,
    ...(options.config === undefined ? {} : { config: options.config }),
    ...(options.plannedMinutes === undefined ? {} : { plannedMinutes: options.plannedMinutes }),
    ...(options.onEnd === undefined ? {} : { onEnd: options.onEnd }),
    ...(options.onCheckpoint === undefined ? {} : { onCheckpoint: options.onCheckpoint }),
    ...(options.onPlanPacing === undefined ? {} : { onPlanPacing: options.onPlanPacing }),
    onEvent: event => {
      events.push(event)
      options.onEvent?.(event)
    },
  })
  const records = (): AuditRecord[] => store.lines.map(line => JSON.parse(line) as AuditRecord)
  return { clock, engine, events, records }
}

/** A runner that finishes immediately with one line. */
function immediateRunner(line = '（低笑）你退后了半步。'): TurnRunner {
  return {
    async run() {
      return { line }
    },
  }
}

describe('autopilot pacing (B2-T5)', () => {
  it('runs one autopilot turn per interval and skips a busy slot', async () => {
    const resolvers: (() => void)[] = []
    let calls = 0
    const runner: TurnRunner = {
      async run() {
        calls += 1
        await new Promise<void>(resolve => { resolvers.push(resolve) })
        return { line: '一拍' }
      },
    }
    const h = createHarness(runner)

    h.engine.setAutopilot(true)
    expect(h.engine.autopilotEnabled).toBe(true)
    expect(h.engine.autopilotIntervalSec).toBe(20)
    expect(h.clock.pendingCount).toBe(1)

    h.clock.advance(19_999)
    await Promise.resolve()
    expect(calls).toBe(0)

    h.clock.advance(1)
    expect(calls).toBe(1)
    // One autopilot tick and one turn timeout: the queue stays empty.
    expect(h.clock.pendingCount).toBe(2)
    expect(h.engine.queueSize).toBe(0)

    // The next slot lands while the turn is still running: dropped, not queued.
    h.clock.advance(20_000)
    await Promise.resolve()
    expect(calls).toBe(1)
    expect(h.engine.queueSize).toBe(0)

    resolvers[0]?.()
    await h.engine.whenIdle()
    expect(h.engine.state).toBe('idle')
    expect(calls).toBe(1)

    // After the free slot the next interval opens exactly one turn.
    h.clock.advance(20_000)
    expect(calls).toBe(2)
    resolvers[1]?.()
    await h.engine.whenIdle()
    expect(calls).toBe(2)

    h.engine.stopAutopilot()
    expect(h.engine.autopilotEnabled).toBe(false)
    expect(h.clock.pendingCount).toBe(0)
  })

  it('clamps a plan nextTurnAfterSec into the configured range', async () => {
    const suggestions = [3, 999]
    const paced: number[] = []
    let calls = 0
    const runner: TurnRunner = {
      async run() {
        calls += 1
        const nextTurnAfterSec = suggestions[calls - 1]
        return nextTurnAfterSec === undefined ? { line: 'ok' } : { line: 'ok', nextTurnAfterSec }
      },
    }
    const h = createHarness(runner, { onPlanPacing: seconds => paced.push(seconds) })

    h.engine.setAutopilot(true)
    expect(h.engine.autopilotIntervalSec).toBe(20)

    h.clock.advance(20_000)
    expect(calls).toBe(1)
    await h.engine.whenIdle()
    // 3s is below the 10s floor, so the engine adopts 10s.
    expect(h.engine.autopilotIntervalSec).toBe(10)
    expect(paced).toEqual([10])

    h.clock.advance(9_999)
    expect(calls).toBe(1)
    h.clock.advance(1)
    expect(calls).toBe(2)
    await h.engine.whenIdle()
    // 999s is above the 60s ceiling, so the engine adopts 60s.
    expect(h.engine.autopilotIntervalSec).toBe(60)
    expect(paced).toEqual([10, 60])

    h.clock.advance(59_999)
    expect(calls).toBe(2)
    h.clock.advance(1)
    expect(calls).toBe(3)
    await h.engine.whenIdle()

    h.engine.stopAutopilot()
    expect(h.clock.pendingCount).toBe(0)
  })

  it('forces a resolve turn after plannedMinutes plus five minutes', async () => {
    const checkpoints: (number | undefined)[] = []
    const mustResolveSeen: (boolean | undefined)[] = []
    const reminders: CheckpointUpdate[] = []
    const runner: TurnRunner = {
      async run(request) {
        checkpoints.push(request.checkpoint)
        mustResolveSeen.push(request.mustResolve)
        return { line: '收束' }
      },
    }
    const h = createHarness(runner, {
      plannedMinutes: 1,
      config: { endGraceMin: 5, checkpoints: [0.5, 0.8, 0.9] },
      onCheckpoint: update => reminders.push(update),
    })

    h.engine.startSession()
    // Three checkpoints plus the hard stop at plannedMinutes + endGraceMin.
    expect(h.clock.pendingCount).toBe(4)

    h.clock.advance(30_000)
    await Promise.resolve()
    expect(h.engine.checkpoint).toBe(0.5)
    expect(h.engine.mustResolve).toBe(false)
    // 50% only injects a reminder; it never opens a turn.
    expect(checkpoints).toEqual([])

    h.clock.advance(24_000) // 0.8 at 48s, 0.9 at 54s
    expect(h.engine.checkpoint).toBe(0.9)
    expect(h.engine.mustResolve).toBe(true)
    expect(checkpoints).toEqual([])
    expect(reminders.map(update => update.checkpoint)).toEqual([0.5, 0.8, 0.9])
    expect(reminders.at(-1)?.mustResolve).toBe(true)

    h.clock.advance(6_000) // planned time reached, grace still running
    expect(checkpoints).toEqual([])

    h.clock.advance(5 * 60_000) // plannedMinutes + endGraceMin = 6 minutes
    expect(checkpoints).toEqual([1])
    expect(mustResolveSeen).toEqual([true])
    await h.engine.whenIdle()
    expect(h.engine.state).toBe('idle')
    expect(h.engine.mustResolve).toBe(true)
    expect(h.engine.snapshot().mustResolve).toBe(true)
    expect(h.engine.snapshot().checkpoint).toBe(0.9)

    await h.engine.end('completed')
    expect(h.engine.state).toBe('ended')
    expect(h.clock.pendingCount).toBe(0)
  })

  it('never opens an autopilot turn while paused or locked', async () => {
    let calls = 0
    const h = createHarness({
      async run() {
        calls += 1
        return { line: 'ok' }
      },
    })

    h.engine.setAutopilot(true)
    await h.engine.pause()
    expect(h.engine.state).toBe('paused')
    // Pausing stops the cadence; no tick survives to fire behind the pause.
    expect(h.clock.pendingCount).toBe(0)
    h.clock.advance(10 * 60_000)
    expect(calls).toBe(0)

    await h.engine.resume()
    expect(h.clock.pendingCount).toBe(1)
    h.clock.advance(20_000)
    expect(calls).toBe(1)
    await h.engine.whenIdle()

    await h.engine.panic('hotkey')
    expect(h.engine.state).toBe('locked')
    expect(h.clock.pendingCount).toBe(0)
    h.clock.advance(10 * 60_000)
    expect(calls).toBe(1)

    h.engine.dispose()
    expect(h.clock.pendingCount).toBe(0)
  })

  it('pauses autopilot after consecutive failures and keeps manual turns working', async () => {
    const outcomes = ['fallback', 'fallback', 'completed'] as const
    let calls = 0
    const runner: TurnRunner = {
      async run() {
        const outcome = outcomes[calls] ?? 'completed'
        calls += 1
        return { line: '模板', outcome }
      },
    }
    const h = createHarness(runner, { config: { maxConsecutiveFailures: 2 } })

    h.engine.setAutopilot(true)
    h.clock.advance(20_000)
    await h.engine.whenIdle()
    h.clock.advance(20_000)
    await h.engine.whenIdle()

    expect(calls).toBe(2)
    expect(h.engine.consecutiveFailureCount).toBe(2)
    expect(h.engine.autopilotEnabled).toBe(false)
    expect(h.events.some(event => event.type === 'error'
      && (event.detail as { reason?: string }).reason === 'autopilot_paused')).toBe(true)

    // The paused autopilot never fires again by itself.
    h.clock.advance(10 * 60_000)
    await Promise.resolve()
    expect(calls).toBe(2)

    // Manual play is explicitly not paused by the failure streak.
    await h.engine.submitPlayerMessage('继续')
    expect(calls).toBe(3)
    expect(h.engine.state).toBe('idle')
    expect(h.clock.pendingCount).toBe(0)
  })

  it('holds ending for the minimum aftercare duration before entering ended', async () => {
    const order: string[] = []
    let endCalls = 0
    const h = createHarness(immediateRunner(), {
      config: { aftercareMin: 1 },
      onEnd: reason => {
        endCalls += 1
        order.push(`onEnd:${reason}:${h.engine.state}`)
      },
      onEvent: event => {
        if (event.type === 'state') order.push(`state:${(event.detail as { state: TurnState }).state}`)
      },
    })

    await h.engine.submitPlayerMessage('你好')
    const ending = h.engine.end('completed')
    for (let i = 0; i < 4; i += 1) await Promise.resolve()

    expect(h.engine.state).toBe('ending')
    expect(endCalls).toBe(1)
    // Exactly the aftercare guard timer is live; session_end is still unaudited.
    expect(h.clock.pendingCount).toBe(1)
    expect(h.records().some(record => record.action === 'session_end')).toBe(false)

    h.clock.advance(59_999)
    await Promise.resolve()
    expect(h.engine.state).toBe('ending')
    expect(endCalls).toBe(1)

    h.clock.advance(1)
    await ending
    expect(h.engine.state).toBe('ended')
    expect(endCalls).toBe(1)
    expect(h.clock.pendingCount).toBe(0)
    expect(h.engine.queueSize).toBe(0)
    // Zeroing order: the close hook runs inside ending, session_end after it,
    // and `ended` is the last observable transition.
    expect(order).toEqual([
      'state:planning',
      'state:settling',
      'state:idle',
      'state:ending',
      'onEnd:completed:ending',
      // `setState` emits once, and `end` repeats the transition with its reason.
      'state:ended',
      'state:ended',
    ])
    const endRecord = h.records().find(record => record.action === 'session_end')
    expect(endRecord?.detail).toMatchObject({ reason: 'completed' })
  })
})
