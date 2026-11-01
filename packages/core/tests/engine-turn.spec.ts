import { describe, expect, it } from 'vitest'
import { TurnEngine, TEMPLATE_LINE, type TurnRunner } from '../src/engine/turn-engine.ts'
import type { TurnState } from '../src/engine/state-machine.ts'
import { AuditLog, type AuditRecord } from '../src/devices/audit.ts'
import { FakeClock } from '../src/ports/fake-clock.ts'
import { MemoryAppendOnlyStore } from '../src/ports/storage.ts'

function createHarness(runner: TurnRunner, hooks: { pauseCount?: number } = {}) {
  const clock = new FakeClock()
  const store = new MemoryAppendOnlyStore()
  const audit = new AuditLog(store, clock, () => {})
  const states: TurnState[] = []
  const pauses: number[] = []
  const engine = new TurnEngine({
    clock,
    audit,
    runner,
    plannedMinutes: 30,
    onEvent: event => {
      if (event.type === 'state') states.push((event.detail as { state: TurnState }).state)
    },
    onPause: () => {
      pauses.push(clock.now())
      if (hooks.pauseCount !== undefined) hooks.pauseCount += 1
    },
  })
  const records = (): AuditRecord[] => store.lines.map(line => JSON.parse(line) as AuditRecord)
  return { clock, engine, states, pauses, records }
}

/** Reports the two observable stages, then returns a fixed result. */
function stagedRunner(result: { line?: string; choices?: readonly { id: string; label: string; tag: string }[] } = {}): TurnRunner {
  return {
    async run(request) {
      request.onStage?.('executing')
      await Promise.resolve()
      request.onStage?.('writing')
      return {
        ...(result.line === undefined ? { line: '（低笑）你退后了半步。' } : { line: result.line }),
        ...(result.choices === undefined ? {} : { choices: result.choices }),
      }
    },
  }
}

/** Never resolves until aborted; used for timeout and preemption. */
function hangingRunner(): TurnRunner {
  return {
    run: request => new Promise((_, reject) => {
      request.signal.addEventListener('abort', () => reject(new Error('aborted')))
    }),
  }
}

describe('turn state machine', () => {
  it('walks idle to planning to executing to writing to settling in order', async () => {
    const h = createHarness(stagedRunner())
    await h.engine.submitPlayerMessage('我往后缩了一下')

    expect(h.states).toEqual(['planning', 'executing', 'writing', 'settling', 'idle'])
    expect(h.engine.state).toBe('idle')
    expect(h.engine.snapshot().outcome).toBe('completed')
    expect(h.engine.snapshot().lastLine).toContain('低笑')
    // The timeout timer is cancelled when the turn settles.
    expect(h.clock.pendingCount).toBe(0)
  })

  it('falls back to a narrative-only turn after the director timeout', async () => {
    const h = createHarness(hangingRunner())
    const pending = h.engine.submitPlayerMessage('慢一点')
    h.clock.advance(60_000)
    await pending

    const snapshot = h.engine.snapshot()
    expect(snapshot.outcome).toBe('timeout')
    expect(snapshot.lastLine).toBe(TEMPLATE_LINE)
    expect(h.engine.state).toBe('idle')
    expect(h.records().some(record => record.action === 'plan_fallback' && record.reason === 'timeout')).toBe(true)
    expect(h.clock.pendingCount).toBe(0)
  })

  it('enters locked on panic and refuses a new turn', async () => {
    const h = createHarness(stagedRunner())
    await h.engine.panic('hotkey')
    expect(h.engine.state).toBe('locked')

    await h.engine.submitPlayerMessage('还在吗')
    expect(h.engine.state).toBe('locked')
    expect(h.records().some(record => record.action === 'preempted' && record.result === 'rejected')).toBe(true)

    h.engine.unlock('我看过了')
    expect(h.engine.state).toBe('idle')
  })

  it('preempts a running turn when the player sends another message', async () => {
    let calls = 0
    const runner: TurnRunner = {
      run: async request => {
        calls += 1
        if (calls === 1) {
          return await new Promise((_, reject) => {
            request.signal.addEventListener('abort', () => reject(new Error('aborted')))
          })
        }
        request.onStage?.('writing')
        return { line: '第二句' }
      },
    }
    const h = createHarness(runner)

    const first = h.engine.submitPlayerMessage('第一句')
    await Promise.resolve()
    const second = h.engine.submitPlayerMessage('第二句')
    await Promise.all([first, second])

    expect(h.engine.state).toBe('idle')
    expect(h.engine.snapshot().lastLine).toBe('第二句')
    expect(h.records().some(record => record.action === 'preempted' && record.result === 'ok')).toBe(true)
  })

  it('pauses only after the current turn settles and stops effects once', async () => {
    let pauseCount = 0
    const h = createHarness(stagedRunner(), { pauseCount: 0 })
    // Recreate with a counting hook.
    const engine = new TurnEngine({
      clock: h.clock,
      audit: new AuditLog(new MemoryAppendOnlyStore(), h.clock, () => {}),
      runner: stagedRunner(),
      onPause: () => { pauseCount += 1 },
    })
    await engine.submitPlayerMessage('开始')
    await engine.pause()
    expect(engine.state).toBe('paused')
    expect(pauseCount).toBe(1)

    await engine.resume()
    expect(engine.state).toBe('idle')
    // Resuming never replays the last effect: nothing was recorded for it.
    expect(pauseCount).toBe(1)
  })

  it('drops a P3 autopilot trigger while busy but queues a P2 checkpoint', async () => {
    const resolvers: (() => void)[] = []
    const runner: TurnRunner = {
      run: async () => await new Promise(resolve => {
        resolvers.push(() => resolve({ line: 'ok' }))
      }),
    }
    const h = createHarness(runner)

    const first = h.engine.submitPlayerMessage('一')
    await Promise.resolve()
    h.engine.submit({ priority: 'autopilot', kind: 'autopilot', at: h.clock.now() })
    h.engine.submit({ priority: 'session', kind: 'checkpoint', at: h.clock.now(), payload: { checkpoint: 0.5 } })
    expect(resolvers).toHaveLength(1)

    resolvers[0]?.()
    await first
    // The queued P2 turn started, the P3 one never did.
    expect(resolvers).toHaveLength(2)
    resolvers[1]?.()
    await h.engine.whenIdle()
    expect(h.engine.state).toBe('idle')
  })

  it('ends a session through ending to ended and audits the reason', async () => {
    const h = createHarness(stagedRunner())
    await h.engine.submitPlayerMessage('你好')
    await h.engine.end('left_early')

    expect(h.engine.state).toBe('ended')
    expect(h.records().some(record => record.action === 'session_end'
      && (record.detail as { reason?: string } | undefined)?.reason === 'left_early')).toBe(true)
    await h.engine.submitPlayerMessage('还能说话吗')
    expect(h.engine.state).toBe('ended')
  })
})

describe('P0 wins over the settle tail', () => {
  function emptyAudit(clock: FakeClock): AuditLog {
    return new AuditLog(new MemoryAppendOnlyStore(), clock, () => {})
  }

  it('stays locked when a panic lands while the settle hook is awaiting', async () => {
    const clock = new FakeClock()
    const audit = new AuditLog(new MemoryAppendOnlyStore(), clock, () => {})
    let release: (() => void) | undefined
    const engine = new TurnEngine({
      clock,
      audit,
      runner: stagedRunner(),
      onSettle: () => new Promise<void>(resolve => { release = resolve }),
    })

    const turn = engine.submitPlayerMessage('开始')
    // Let the turn reach the settle hook.
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await engine.panic('hotkey')
    expect(engine.state).toBe('locked')

    release?.()
    await turn
    // The emergency latch must survive the tail of the turn it interrupted.
    expect(engine.state).toBe('locked')
    await engine.submitPlayerMessage('还能继续吗')
    expect(engine.state).toBe('locked')

    engine.unlock('我看过了')
    expect(engine.state).toBe('idle')
  })

  it('reports a panic during the turn as cancelled, never as a model fallback', async () => {
    const clock = new FakeClock()
    const store = new MemoryAppendOnlyStore()
    const audit = new AuditLog(store, clock, () => {})
    const engine = new TurnEngine({ clock, audit, runner: hangingRunner() })

    const turn = engine.submitPlayerMessage('慢一点')
    await Promise.resolve()
    await engine.panic('hotkey')
    await turn

    const records = store.lines.map(line => JSON.parse(line) as AuditRecord)
    expect(engine.state).toBe('locked')
    expect(engine.snapshot().outcome).toBe('cancelled')
    expect(records.some(record => record.action === 'plan_fallback')).toBe(false)
  })

  it('ends a session that panics during aftercare into locked, not ended', async () => {
    const clock = new FakeClock()
    const audit = emptyAudit(clock)
    let releaseEnd: (() => void) | undefined
    const engine = new TurnEngine({
      clock,
      audit,
      runner: stagedRunner(),
      onEnd: () => new Promise<void>(resolve => { releaseEnd = resolve }),
    })

    await engine.submitPlayerMessage('你好')
    const ending = engine.end('completed')
    await Promise.resolve()
    await Promise.resolve()
    await engine.panic('hotkey')
    releaseEnd?.()
    await ending

    expect(engine.state).toBe('locked')
  })
})

describe('P1 turns are serialised and P0 outranks a clean resolve', () => {
  it('runs a burst of player messages as one turn at a time, in order', async () => {
    let active = 0
    let maxActive = 0
    const lines: string[] = []
    const runner: TurnRunner = {
      run: async request => {
        active += 1
        maxActive = Math.max(maxActive, active)
        await Promise.resolve()
        await Promise.resolve()
        active -= 1
        lines.push(request.playerText ?? '')
        return { line: request.playerText ?? '' }
      },
    }
    const h = createHarness(runner)
    await Promise.all([h.engine.submitPlayerMessage('一'), h.engine.submitPlayerMessage('二'), h.engine.submitPlayerMessage('三')])

    expect(maxActive).toBe(1)
    expect(lines).toEqual(['一', '二', '三'])
    expect(h.engine.state).toBe('idle')
  })

  it('records cancelled and back-fills no line when a panicked runner resolves cleanly', async () => {
    const clock = new FakeClock()
    const audit = new AuditLog(new MemoryAppendOnlyStore(), clock, () => {})
    let release: (() => void) | undefined
    const runner: TurnRunner = {
      run: async () => await new Promise(resolve => { release = () => resolve({ line: '（不该出现）' }) }),
    }
    const engine = new TurnEngine({ clock, audit, runner })

    const turn = engine.submitPlayerMessage('慢一点')
    await Promise.resolve()
    await engine.panic('hotkey')
    release?.()
    await turn

    expect(engine.state).toBe('locked')
    expect(engine.snapshot().outcome).toBe('cancelled')
    expect(engine.snapshot().lastLine).toBeUndefined()
  })
})

describe('panic sets the latch before awaiting the host hook (wave-4 review S-6)', () => {
  it('is already locked inside onPanic', async () => {
    const clock = new FakeClock()
    const audit = new AuditLog(new MemoryAppendOnlyStore(), clock, () => {})
    let stateInHook: TurnState | undefined
    const engine = new TurnEngine({
      clock,
      audit,
      runner: stagedRunner(),
      onPanic: () => {
        stateInHook = engine.state
      },
    })

    await engine.panic('hotkey')

    expect(stateInHook).toBe('locked')
    expect(engine.state).toBe('locked')
    expect(clock.pendingCount).toBe(0)
  })

  it('stays locked when onPanic throws, and reports the failure as an event', async () => {
    const clock = new FakeClock()
    const audit = new AuditLog(new MemoryAppendOnlyStore(), clock, () => {})
    const errors: unknown[] = []
    const engine = new TurnEngine({
      clock,
      audit,
      runner: hangingRunner(),
      onPanic: () => {
        throw new Error('device stop failed')
      },
      onEvent: event => {
        if (event.type === 'error') errors.push(event.detail)
      },
    })

    const turn = engine.submitPlayerMessage('慢一点')
    await Promise.resolve()
    // A failing stop hook must not reject panic() and must not unlock.
    let thrown: unknown
    try {
      await engine.panic('hotkey')
    } catch (error) {
      thrown = error
    }
    await turn

    expect(thrown).toBeUndefined()
    expect(engine.state).toBe('locked')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ phase: 'panic', source: 'hotkey', message: 'device stop failed' })
    expect(engine.snapshot().outcome).toBe('cancelled')
    expect(clock.pendingCount).toBe(0)
  })
})
