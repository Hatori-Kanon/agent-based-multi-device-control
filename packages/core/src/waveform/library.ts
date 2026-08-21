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
    this.durable.set(id, waveform)
    return waveform
  }

  /** Discard scratch space at the end of a session. */
  clearSession(): void {
    this.scratch.clear()
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
    if (this.scratch.size >= MAX_SESSION_WAVEFORMS) {
      throw new SafetyError(
        'INVALID_WAVEFORM',
        `the session already holds ${MAX_SESSION_WAVEFORMS} waveforms; reuse one or ask the operator to promote and clear`,
      )
    }
    this.scratch.set(waveform.id, waveform)
    return waveform
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
