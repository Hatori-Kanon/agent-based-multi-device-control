/**
 * Two-scope waveform storage.
 *
 * `library` is durable and human-curated. `session` is scratch space that the
 * agent may write and that is discarded when the session ends. Authoring
 * therefore cannot pollute the durable set, and promoting something into it is
 * an explicit human act — which is also why the promote method says so in its
 * name, the same convention `PolicyStore.setByHuman` uses.
 */

import { SafetyError } from '../devices/errors.ts'
import { createBuiltinWaveforms } from './builtin.ts'
import { compileWaveformScript, type WaveformScript } from './dsl.ts'
import { formatHexFrame, parseHexFrames } from './hex.ts'
import {
  summarizeWaveform,
  type Waveform,
  type WaveformScope,
  type WaveformSource,
  type WaveformSummary,
} from './types.ts'

/** Cap on agent-authored scratch so a loop cannot exhaust memory. */
export const MAX_SESSION_WAVEFORMS = 64

/** Persistable form; frames travel as the shared hex interchange format. */
export interface SerializedWaveform {
  readonly id: string
  readonly name: string
  readonly loop: boolean
  readonly source: WaveformSource
  readonly tags: readonly string[]
  readonly frames: readonly string[]
}

export function serializeWaveform(waveform: Waveform): SerializedWaveform {
  return {
    id: waveform.id,
    name: waveform.name,
    loop: waveform.loop,
    source: waveform.source,
    tags: [...waveform.tags],
    frames: waveform.frames.map(formatHexFrame),
  }
}

export function deserializeWaveform(data: SerializedWaveform): Waveform {
  return {
    id: data.id,
    name: data.name,
    frames: parseHexFrames(data.frames),
    loop: data.loop,
    source: data.source,
    tags: [...data.tags],
  }
}

function slugify(name: string): string {
  const cleaned = name
    .trim()
    .toLowerCase()
    .replace(/[\s/\\.]+/gu, '-')
    .replace(/[^\p{L}\p{N}_-]/gu, '')
    .replace(/-{2,}/gu, '-')
    .replace(/^-+|-+$/gu, '')
  return cleaned.length > 0 ? cleaned.slice(0, 48) : 'waveform'
}

export interface WaveformLibraryOptions {
  /** Overrides the starter set; mainly useful in tests. */
  readonly builtins?: readonly Waveform[]
}

export class WaveformLibrary {
  private readonly durable = new Map<string, Waveform>()
  private readonly scratch = new Map<string, Waveform>()
  /**
   * Scratch ids installed through {@link addSessionWaveform}.
   *
   * Host pack assets share `scratch` with agent/human work but must not count
   * against {@link MAX_SESSION_WAVEFORMS} (P2-N1); this set is how the two
   * populations are told apart. Invariant: every id here is also in
   * `scratch`, maintained by remove/promote/clear below.
   */
  private readonly hostRegistered = new Set<string>()

  constructor(options: WaveformLibraryOptions = {}) {
    for (const waveform of options.builtins ?? createBuiltinWaveforms()) {
      this.durable.set(waveform.id, waveform)
    }
  }

  /** Summaries for every waveform, durable first. Never includes frame data. */
  list(): WaveformSummary[] {
    return [
      ...[...this.durable.values()].map(waveform => summarizeWaveform(waveform, 'library')),
      ...[...this.scratch.values()].map(waveform => summarizeWaveform(waveform, 'session')),
    ]
  }

  get(id: string): Waveform | undefined {
    return this.durable.get(id) ?? this.scratch.get(id)
  }

  scopeOf(id: string): WaveformScope | undefined {
    if (this.durable.has(id)) return 'library'
    if (this.scratch.has(id)) return 'session'
    return undefined
  }

  /** Resolve or explain. */
  require(id: string): Waveform {
    const waveform = this.get(id)
    if (waveform === undefined) {
      throw new SafetyError('UNKNOWN_WAVEFORM', `no waveform with id "${id}"; call waveform_list to see what is available`)
    }
    return waveform
  }

  /** Compile a script into session scope. */
  author(script: WaveformScript): Waveform {
    const compiled = compileWaveformScript(script)
    return this.addToSession({
      id: this.uniqueId(slugify(compiled.name)),
      name: compiled.name,
      frames: compiled.frames,
      loop: compiled.loop,
      source: 'authored',
      tags: compiled.tags,
    })
  }

  /**
   * Install a host-owned waveform into session scope, keyed by its own id.
   *
   * Content packs ship waveforms under canonical ids (`<packId>:<localId>`),
   * and the executor dispatches through the registry, which resolves a plan's
   * `waveformId` with {@link require}. Before this seam the resolver could find
   * a packed waveform while the registry could not, so an otherwise valid plan
   * was rejected with `UNKNOWN_WAVEFORM` (play-session audit). The host calls
   * this once per pack at session start; replace-by-id keeps a retried start
   * cheap.
   *
   * This is a **trusted host path, not an agent path**, so it deliberately
   * ignores {@link MAX_SESSION_WAVEFORMS}: a content pack is validated on its
   * own terms and may legally ship more waveforms than the agent scratch cap,
   * and failing the whole session start over that count is unacceptable
   * (adversarial review P1-3). Only `author`/`importFrames` keep the cap, so a
   * model loop still cannot exhaust memory.
   */
  addSessionWaveform(waveform: Waveform): void {
    this.scratch.set(waveform.id, waveform)
    this.hostRegistered.add(waveform.id)
  }

  /**
   * Remove exactly one host-installed session waveform.
   *
   * Session teardown (normal end, failed start, pack switch) must be able to
   * drop the pack assets this session installed without clearing human
   * imports or agent scratch via {@link clearSession}. Durable waveforms are
   * never touched — a builtin id such as `tide` is simply not in scratch — and
   * a host id also leaves the {@link hostRegistered} bookkeeping so the agent
   * cap reflects the smaller host population again.
   *
   * @returns true when a scratch entry was removed, false for an absent id.
   */
  removeSessionWaveform(id: string): boolean {
    const removed = this.scratch.delete(id)
    this.hostRegistered.delete(id)
    return removed
  }

  /** Bring a shared waveform in from the hex interchange format. */
  importFrames(name: string, frames: readonly string[], tags: readonly string[] = []): Waveform {
    const trimmed = name.trim()
    if (trimmed.length === 0 || trimmed.length > 64) {
      throw new SafetyError('INVALID_WAVEFORM', 'name must be 1-64 characters')
    }
    return this.addToSession({
      id: this.uniqueId(slugify(trimmed)),
      name: trimmed,
      frames: parseHexFrames(frames),
      loop: true,
      source: 'imported',
      tags: [...tags],
    })
  }

  /**
   * Move a session waveform into the durable library.
   *
   * Human action only. There is no agent-reachable equivalent.
   */
  promoteByHuman(id: string): Waveform {
    const waveform = this.scratch.get(id)
    if (waveform === undefined) {
      throw new SafetyError('UNKNOWN_WAVEFORM', `no session waveform with id "${id}"`)
    }
    this.scratch.delete(id)
    this.hostRegistered.delete(id)
    this.durable.set(id, waveform)
    return waveform
  }

  /** Discard scratch space at the end of a session. */
  clearSession(): void {
    this.scratch.clear()
    this.hostRegistered.clear()
  }

  /** Durable, non-builtin waveforms, for the host to persist. */
  exportLibrary(): SerializedWaveform[] {
    return [...this.durable.values()]
      .filter(waveform => waveform.source !== 'builtin')
      .map(serializeWaveform)
  }

  /** Restore previously persisted durable waveforms. */
  loadLibrary(entries: readonly SerializedWaveform[]): void {
    for (const entry of entries) {
      const waveform = deserializeWaveform(entry)
      this.durable.set(waveform.id, waveform)
    }
  }

  private addToSession(waveform: Waveform): Waveform {
    if (this.agentScratchCount() >= MAX_SESSION_WAVEFORMS) {
      throw new SafetyError(
        'INVALID_WAVEFORM',
        `the session already holds ${MAX_SESSION_WAVEFORMS} waveforms; reuse one or ask the operator to promote and clear`,
      )
    }
    this.scratch.set(waveform.id, waveform)
    return waveform
  }

  /**
   * Scratch entries owned by the agent/human paths.
   *
   * Host-registered pack waveforms are excluded: a pack may legally ship more
   * than {@link MAX_SESSION_WAVEFORMS}, and those assets must not consume the
   * 64 slots the model and the human importer share (adversarial review
   * P2-N1). Counting by membership rather than `size - hostRegistered.size`
   * stays correct even if a bookkeeping entry ever outlives its scratch entry.
   */
  private agentScratchCount(): number {
    let count = 0
    for (const id of this.scratch.keys()) {
      if (!this.hostRegistered.has(id)) count += 1
    }
    return count
  }

  private uniqueId(base: string): string {
    if (this.get(base) === undefined) return base
    for (let suffix = 2; suffix < 1_000; suffix += 1) {
      const candidate = `${base}-${suffix}`
      if (this.get(candidate) === undefined) return candidate
    }
    throw new SafetyError('INVALID_WAVEFORM', `could not allocate an id for "${base}"`)
  }
}
