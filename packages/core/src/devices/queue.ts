/**
 * Per-device serial execution.
 *
 * A BLE link tolerates exactly one outstanding write, so every transport
 * operation for one device is serialised. Operations for *different* devices
 * run in parallel — this is the bottleneck that a single global queue creates
 * and that multi-device roleplay cannot afford.
 *
 * Stop-shaped work can jump ahead of queued output changes with `priority`,
 * which bounds emergency-stop latency to one in-flight write.
 */

interface Entry<T> {
  readonly task: () => Promise<T>
  readonly priority: boolean
  readonly settle: (result: { ok: true; value: T } | { ok: false; error: unknown }) => void
}

export class SerialQueue {
  private readonly pending: Entry<never>[] = []
  private running = false

  /** Number of queued (not yet started) operations. */
  get depth(): number {
    return this.pending.length
  }

  /**
   * Queue one operation.
   *
   * @param task - Runs when every earlier operation has settled.
   * @param priority - Place ahead of non-priority operations already queued.
   */
  enqueue<T>(task: () => Promise<T>, priority = false): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const entry = {
        task,
        priority,
        settle: (result: { ok: true; value: T } | { ok: false; error: unknown }) => {
          if (result.ok) resolve(result.value)
          else reject(result.error)
        },
      } as unknown as Entry<never>
      if (priority) {
        const firstNonPriority = this.pending.findIndex(candidate => !candidate.priority)
        if (firstNonPriority === -1) this.pending.push(entry)
        else this.pending.splice(firstNonPriority, 0, entry)
      } else {
        this.pending.push(entry)
      }
      if (!this.running) void this.pump()
    })
  }

  /** Resolve once the queue has drained. */
  async idle(): Promise<void> {
    while (this.running || this.pending.length > 0) {
      await new Promise<void>(resolve => { setTimeout(resolve, 0) })
    }
  }

  private async pump(): Promise<void> {
    this.running = true
    try {
      for (;;) {
        const entry = this.pending.shift()
        if (entry === undefined) break
        try {
          const value = await entry.task()
          entry.settle({ ok: true, value })
        } catch (error) {
          entry.settle({ ok: false, error })
        }
      }
    } finally {
      this.running = false
    }
  }
}
