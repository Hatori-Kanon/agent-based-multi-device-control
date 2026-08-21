import { describe, expect, it } from 'vitest'
import { SerialQueue } from '../src/index.ts'

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

describe('SerialQueue', () => {
  it('runs one operation at a time in submission order', async () => {
    const queue = new SerialQueue()
    const order: string[] = []
    let concurrent = 0
    let peak = 0

    const task = (name: string) => async (): Promise<void> => {
      concurrent += 1
      peak = Math.max(peak, concurrent)
      await Promise.resolve()
      order.push(name)
      concurrent -= 1
    }

    await Promise.all([
      queue.enqueue(task('a')),
      queue.enqueue(task('b')),
      queue.enqueue(task('c')),
    ])

    expect(order).toEqual(['a', 'b', 'c'])
    expect(peak).toBe(1)
  })

  it('lets a priority operation jump ahead of queued work', async () => {
    const queue = new SerialQueue()
    const order: string[] = []
    const gate = deferred()

    // Occupy the queue so the rest genuinely wait.
    const blocking = queue.enqueue(async () => {
      await gate.promise
      order.push('blocking')
    })
    const low1 = queue.enqueue(() => { order.push('low1'); return Promise.resolve() })
    const low2 = queue.enqueue(() => { order.push('low2'); return Promise.resolve() })
    const stop = queue.enqueue(() => { order.push('stop'); return Promise.resolve() }, true)

    gate.resolve()
    await Promise.all([blocking, low1, low2, stop])

    // The in-flight operation still finishes first; the stop then pre-empts
    // the queued output changes. This is what bounds panic latency.
    expect(order).toEqual(['blocking', 'stop', 'low1', 'low2'])
  })

  it('keeps draining after an operation rejects', async () => {
    const queue = new SerialQueue()
    const failing = queue.enqueue(() => Promise.reject(new Error('boom')))
    const following = queue.enqueue(() => Promise.resolve('ok'))

    await expect(failing).rejects.toThrow('boom')
    await expect(following).resolves.toBe('ok')
  })

  it('reports depth and reaches idle', async () => {
    const queue = new SerialQueue()
    const gate = deferred()
    const first = queue.enqueue(() => gate.promise)
    queue.enqueue(() => Promise.resolve())
    expect(queue.depth).toBeGreaterThan(0)
    gate.resolve()
    await first
    await queue.idle()
    expect(queue.depth).toBe(0)
  })
})
