/** Deterministic {@link Clock} for tests. */

import type { Clock, Timer } from './clock.ts'

interface Scheduled {
  id: number
  due: number
  /** Undefined for one-shot timers. */
  everyMs: number | undefined
  fn: () => void
  cancelled: boolean
}

/**
 * A clock that only moves when {@link FakeClock.advance} is called.
 *
 * Callbacks scheduled during an advance are honoured within the same advance
 * if they come due before the target time, which lets tests exercise chained
 * timing (an effect tick that schedules an auto-stop, for example).
 */
export class FakeClock implements Clock {
  private current: number
  private nextId = 0
  private scheduled: Scheduled[] = []

  /** @param start - Initial millisecond value. */
  constructor(start = 0) {
    this.current = start
  }

  now(): number {
    return this.current
  }

  timeout(ms: number, fn: () => void): Timer {
    return this.schedule(ms, undefined, fn)
  }

  interval(ms: number, fn: () => void): Timer {
    return this.schedule(ms, Math.max(1, Math.trunc(ms)), fn)
  }

  /** Number of live timers; useful for leak assertions. */
  get pendingCount(): number {
    return this.scheduled.filter(entry => !entry.cancelled).length
  }

  /** Move time forward by `ms`, firing every callback that comes due. */
  advance(ms: number): void {
    const target = this.current + Math.max(0, ms)
    for (;;) {
      const next = this.dueBefore(target)
      if (next === undefined) break
      this.current = next.due
      if (next.everyMs === undefined) next.cancelled = true
      else next.due = next.due + next.everyMs
      next.fn()
    }
    this.current = target
    this.scheduled = this.scheduled.filter(entry => !entry.cancelled)
  }

  private dueBefore(target: number): Scheduled | undefined {
    let best: Scheduled | undefined
    for (const entry of this.scheduled) {
      if (entry.cancelled || entry.due > target) continue
      if (best === undefined || entry.due < best.due || (entry.due === best.due && entry.id < best.id)) {
        best = entry
      }
    }
    return best
  }

  private schedule(ms: number, everyMs: number | undefined, fn: () => void): Timer {
    const entry: Scheduled = {
      id: this.nextId++,
      due: this.current + Math.max(0, Math.trunc(ms)),
      everyMs,
      fn,
      cancelled: false,
    }
    this.scheduled.push(entry)
    return { cancel: () => { entry.cancelled = true } }
  }
}
