import { describe, expect, it } from 'vitest'
import {
  TurnEngine,
  type EngineConfig,
  type EngineEvent,
  type TurnRunner,
} from '../src/engine/turn-engine.ts'
import type { TurnState } from '../src/engine/state-machine.ts'
import {
  planPreemption,
  PriorityQueue,
  TURN_PRIORITY_ORDER,
  type TurnPriority,
  type TurnTrigger,
  type TurnTriggerKind,
} from '../src/engine/scheduler.ts'
import { AuditLog, type AuditRecord } from '../src/devices/audit.ts'
import { FakeClock } from '../src/ports/fake-clock.ts'
import { MemoryAppendOnlyStore } from '../src/ports/storage.ts'

function trigger(
  priority: TurnPriority,
  kind: TurnTriggerKind,
  at: number,
  payload?: TurnTrigger['payload'],
): TurnTrigger {
  return { priority, kind, at, ...(payload === undefined ? {} : { payload }) }
}

function createHarness(runner: TurnRunner, options: { config?: Partial<EngineConfig>; clock?: FakeClock } = {}) {
  const clock = options.clock ?? new FakeClock()
  const store = new MemoryAppendOnlyStore()
  const audit = new AuditLog(store, clock, () => {})
  const states: TurnState[] = []
  const events: EngineEvent[] = []
  const engine = new TurnEngine({
    clock,
    audit,
    runner,
    ...(options.config === undefined ? {} : { config: options.config }),
    onEvent: event => {
      events.push(event)
      if (event.type === 'state') states.push((event.detail as { state: TurnState }).state)
    },
  })
  const records = (): AuditRecord[] => store.lines.map(line => JSON.parse(line) as AuditRecord)
  return { clock, engine, states, events, records }
}

/** Reports both observable stages, then returns one fixed line. */
function stagedRunner(line = '（低笑）你退后了半步。'): TurnRunner {
  return {
    async run(request) {
      request.onStage?.('executing')
      await Promise.resolve()
      request.onStage?.('writing')
      return { line }
    },
  }
}

describe('priority queue (B2-T4)', () => {
  it('queues only P2 and drops P3 instead of stacking autopilot turns', () => {
    const queue = new PriorityQueue()
    expect(queue.submit(trigger('autopilot', 'autopilot', 1))).toBe('dropped')
    expect(queue.submit(trigger('autopilot', 'autopilot', 2))).toBe('dropped')
    expect(queue.submit(trigger('observe', 'observe', 3))).toBe('ignored')
    expect(queue.submit(trigger('maintenance', 'maintenance', 4))).toBe('ignored')
    // P1 has its own preempt path; it must never sit in the P2 queue.
    expect(queue.submit(trigger('player', 'player', 5))).toBe('ignored')
    expect(queue.size).toBe(0)
    expect(queue.drain()).toEqual([])

    expect(queue.submit(trigger('session', 'checkpoint', 6, { checkpoint: 0.5 }))).toBe('queued')
    expect(queue.size).toBe(1)
  })

  it('keeps same-priority order stable by at and then by submission', () => {
    const queue = new PriorityQueue()
    const late = trigger('session', 'checkpoint', 30, { checkpoint: 0.9 })
    const early = trigger('session', 'checkpoint', 10, { checkpoint: 0.5 })
    const end = trigger('session', 'end', 20)
    const checkpoint = trigger('session', 'checkpoint', 20, { checkpoint: 0.8 })
    // Deliberately out of order: `end` and `checkpoint` share the same `at`.
    for (const item of [late, early, end, checkpoint]) queue.submit(item)

    expect(queue.drain()).toEqual([early, end, checkpoint, late])
    expect(queue.size).toBe(0)
  })

  it('drains a bounded prefix and can be cleared', () => {
    const queue = new PriorityQueue()
    queue.submit(trigger('session', 'checkpoint', 3, { checkpoint: 0.9 }))
    queue.submit(trigger('session', 'checkpoint', 1, { checkpoint: 0.5 }))
    queue.submit(trigger('session', 'checkpoint', 2, { checkpoint: 0.8 }))

    expect(queue.drain(1).map(item => item.at)).toEqual([1])
    expect(queue.size).toBe(2)
    expect(queue.drain().map(item => item.at)).toEqual([2, 3])
    queue.submit(trigger('session', 'checkpoint', 4))
    queue.clear()
    expect(queue.size).toBe(0)
  })

  it('maps the preemption matrix per stage', () => {
    expect(TURN_PRIORITY_ORDER.player).toBeLessThan(TURN_PRIORITY_ORDER.session)
    expect(planPreemption('planning', 500)).toEqual({
      reason: 'player', action: 'preempted', immediate: true, graceMs: 0,
    })
    expect(planPreemption('executing', 500)).toEqual({
      reason: 'player', action: 'preempted', immediate: false, graceMs: 500,
    })
    expect(planPreemption('writing', 500)).toEqual({
      reason: 'writer', action: 'writer_preempted', immediate: true, graceMs: 0,
    })
    // A zero/negative grace degrades to an immediate abort instead of a timer.
    expect(planPreemption('executing', 0)).toMatchObject({ immediate: true, graceMs: 0 })
    expect(planPreemption('executing', -20)).toMatchObject({ immediate: true, graceMs: 0 })
  })
})

describe('turn engine preemption (B2-T4)', () => {
  it('never queues two autopilot turns and drops the trigger while busy', async () => {
    const resolvers: (() => void)[] = []
    const runner: TurnRunner = {
      async run() {
        await new Promise<void>(resolve => { resolvers.push(resolve) })
        return { line: 'ok' }
      },
    }
    const h = createHarness(runner)

    const first = h.engine.submitPlayerMessage('开始')
    await Promise.resolve()
    h.engine.submit(trigger('autopilot', 'autopilot', h.clock.now()))
    h.engine.submit(trigger('autopilot', 'autopilot', h.clock.now()))

    expect(h.engine.queueSize).toBe(0)
    expect(resolvers).toHaveLength(1)

    resolvers[0]?.()
    await first
    // Neither autopilot tick may have become a queued turn.
    expect(resolvers).toHaveLength(1)
    expect(h.engine.state).toBe('idle')
    expect(h.records().some(record => record.action === 'turn_completed')).toBe(true)
    expect(h.clock.pendingCount).toBe(0)
  })

  it('aborts planning on a player message and opens a new turn', async () => {
    const signals: AbortSignal[] = []
    let calls = 0
    const runner: TurnRunner = {
      async run(request) {
        calls += 1
        signals.push(request.signal)
        if (calls === 1) {
          await new Promise<never>((_resolve, reject) => {
            request.signal.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
          })
        }
        request.onStage?.('writing')
        return { line: '第二句' }
      },
    }
    const h = createHarness(runner)

    const first = h.engine.submitPlayerMessage('第一句')
    await Promise.resolve()
    expect(h.engine.state).toBe('planning')
    const second = h.engine.submitPlayerMessage('第二句')
    await Promise.all([first, second])

    expect(signals[0]?.aborted).toBe(true)
    expect(calls).toBe(2)
    expect(h.engine.state).toBe('idle')
    expect(h.engine.snapshot().lastLine).toBe('第二句')
    expect(h.engine.snapshot().outcome).toBe('completed')
    const preempted = h.records().find(record => record.action === 'preempted')
    expect(preempted?.result).toBe('ok')
    expect(preempted?.detail).toMatchObject({ from: 'planning', reason: 'player' })
    expect(h.clock.pendingCount).toBe(0)
  })

  it('lets one beat finish within 500ms before dropping the rest', async () => {
    const clock = new FakeClock()
    const beats: string[] = []
    const hardSignals: AbortSignal[] = []
    let calls = 0
    const runner: TurnRunner = {
      async run(request) {
        calls += 1
        hardSignals.push(request.signal)
        if (calls > 1) return { line: '新回合' }
        request.onStage?.('executing')
        let stop = false
        request.preemptSignal?.addEventListener('abort', () => { stop = true }, { once: true })
        // The one in-flight beat completes inside the 500ms grace window.
        await new Promise<void>(resolve => { clock.timeout(300, resolve) })
        beats.push('beat-1')
        if (stop) return { line: '只派出一拍' }
        // Only reached when the runner ignores the cooperative signal.
        await new Promise<void>(resolve => { clock.timeout(300, resolve) })
        beats.push('beat-2')
        return { line: '两拍' }
      },
    }
    const h = createHarness(runner, { clock })

    const first = h.engine.submitPlayerMessage('开始')
    await Promise.resolve()
    expect(h.engine.state).toBe('executing')
    expect(h.clock.pendingCount).toBe(2) // turn timeout + in-flight beat

    const second = h.engine.submitPlayerMessage('停一下')
    expect(h.clock.pendingCount).toBe(3) // + the 500ms grace backstop
    expect(hardSignals[0]?.aborted).toBe(false)

    h.clock.advance(300)
    await first
    expect(beats).toEqual(['beat-1'])

    await second
    expect(calls).toBe(2)
    expect(h.engine.snapshot().lastLine).toBe('新回合')
    expect(h.clock.pendingCount).toBe(0)
    expect(h.records().find(record => record.action === 'preempted')?.detail)
      .toMatchObject({ from: 'executing', reason: 'player', graceMs: 500 })
  })

  it('refuses every trigger while locked except stop and unlock', async () => {
    let calls = 0
    const runner: TurnRunner = {
      async run() {
        calls += 1
        return { line: 'ok' }
      },
    }
    const h = createHarness(runner)
    await h.engine.panic('hotkey')
    expect(h.engine.state).toBe('locked')

    const everyPriority: readonly TurnTrigger[] = [
      trigger('player', 'player', 1, { text: '还在吗' }),
      trigger('session', 'checkpoint', 1, { checkpoint: 0.5 }),
      trigger('autopilot', 'autopilot', 1),
      trigger('observe', 'observe', 1),
      trigger('maintenance', 'maintenance', 1),
    ]
    for (const item of everyPriority) h.engine.submit(item)
    await h.engine.submitPlayerMessage('还在吗')
    await h.engine.submitChoice('c1')

    expect(h.engine.state).toBe('locked')
    expect(h.engine.queueSize).toBe(0)
    expect(calls).toBe(0)
    expect(h.records().filter(record => record.action === 'preempted' && record.result === 'rejected'))
      .toHaveLength(2)

    // P0 (stop/panic) stays accepted while already locked.
    await h.engine.panic('hotkey-again')
    expect(h.engine.state).toBe('locked')

    // Unlock is the only exit; queued work was dropped and never auto-fires.
    h.engine.unlock('我看过了')
    expect(h.engine.state).toBe('idle')
    await h.engine.submitPlayerMessage('继续')
    expect(calls).toBe(1)
    expect(h.engine.state).toBe('idle')
  })

  it('cancels a writing stream and audits writer_preempted without back-filling the line', async () => {
    const signals: AbortSignal[] = []
    let calls = 0
    const runner: TurnRunner = {
      async run(request) {
        calls += 1
        signals.push(request.signal)
        if (calls === 1) {
          request.onStage?.('executing')
          request.onStage?.('writing')
          await new Promise<never>((_resolve, reject) => {
            request.signal.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
          })
        }
        return { line: '新回合' }
      },
    }
    const h = createHarness(runner)

    const first = h.engine.submitPlayerMessage('一')
    await Promise.resolve()
    expect(h.engine.state).toBe('writing')
    const second = h.engine.submitPlayerMessage('二')
    await Promise.all([first, second])

    expect(signals[0]?.aborted).toBe(true)
    expect(calls).toBe(2)
    const writer = h.records().find(record => record.action === 'writer_preempted')
    expect(writer?.result).toBe('ok')
    expect(writer?.detail).toMatchObject({ from: 'writing', reason: 'writer' })
    // The preempted turn's partial line is never surfaced.
    expect(h.engine.snapshot().lastLine).toBe('新回合')
    expect(h.clock.pendingCount).toBe(0)
  })

  it('hard-aborts an executing turn when its beat outlives the grace window', async () => {
    const signals: AbortSignal[] = []
    let calls = 0
    const runner: TurnRunner = {
      async run(request) {
        calls += 1
        signals.push(request.signal)
        if (calls === 1) {
          request.onStage?.('executing')
          await new Promise<never>((_resolve, reject) => {
            request.signal.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
          })
        }
        return { line: '新回合' }
      },
    }
    const h = createHarness(runner)

    const first = h.engine.submitPlayerMessage('一')
    await Promise.resolve()
    const second = h.engine.submitPlayerMessage('二')
    expect(h.clock.pendingCount).toBe(2) // turn timeout + grace backstop

    h.clock.advance(499)
    await Promise.resolve()
    expect(signals[0]?.aborted).toBe(false)
    expect(calls).toBe(1)

    h.clock.advance(1)
    await Promise.all([first, second])
    expect(signals[0]?.aborted).toBe(true)
    expect(calls).toBe(2)
    expect(h.clock.pendingCount).toBe(0)
  })

  it('starts queued P2 checkpoints in stable order once the turn settles', async () => {
    const gates: (() => void)[] = []
    const seen: (number | undefined)[] = []
    const runner: TurnRunner = {
      async run(request) {
        seen.push(request.checkpoint)
        await new Promise<void>(resolve => { gates.push(resolve) })
        return { line: 'ok' }
      },
    }
    const h = createHarness(runner)

    const first = h.engine.submitPlayerMessage('开始')
    await Promise.resolve()
    h.engine.submit(trigger('session', 'checkpoint', 30, { checkpoint: 0.9 }))
    h.engine.submit(trigger('session', 'checkpoint', 10, { checkpoint: 0.5 }))
    expect(h.engine.queueSize).toBe(2)

    gates[0]?.()
    await first
    expect(seen).toEqual([undefined, 0.5])

    gates[1]?.()
    await h.engine.whenIdle()
    expect(seen).toEqual([undefined, 0.5, 0.9])

    gates[2]?.()
    await h.engine.whenIdle()
    expect(h.engine.state).toBe('idle')
    expect(h.engine.queueSize).toBe(0)
  })

  it('ignores P4/P5 triggers without starting a turn or touching the queue', async () => {
    let calls = 0
    const runner: TurnRunner = {
      async run() {
        calls += 1
        return { line: 'ok' }
      },
    }
    const h = createHarness(runner)

    h.engine.submit(trigger('observe', 'observe', h.clock.now()))
    h.engine.submit(trigger('maintenance', 'maintenance', h.clock.now()))
    await Promise.resolve()

    expect(calls).toBe(0)
    expect(h.engine.state).toBe('idle')
    expect(h.engine.queueSize).toBe(0)
    expect(h.records()).toEqual([])
    const ignored = h.events.filter(event => event.type === 'turn'
      && (event.detail as { ignored?: boolean }).ignored === true)
    expect(ignored).toHaveLength(2)
  })
})

// Keep the staged runner referenced so the harness helper is not dead code and
// the ordinary lifecycle stays covered in this file too.
describe('turn engine lifecycle smoke (B2-T4)', () => {
  it('still walks a normal turn through every stage', async () => {
    const h = createHarness(stagedRunner('正常一句'))
    await h.engine.submitPlayerMessage('你好')

    expect(h.states).toEqual(['planning', 'executing', 'writing', 'settling', 'idle'])
    expect(h.engine.snapshot().outcome).toBe('completed')
    expect(h.engine.snapshot().lastLine).toBe('正常一句')
    expect(h.records().some(record => record.action === 'turn_started' && record.result === 'ok')).toBe(true)
    expect(h.records().some(record => record.action === 'turn_completed' && record.result === 'ok')).toBe(true)
    expect(h.clock.pendingCount).toBe(0)
  })
})
