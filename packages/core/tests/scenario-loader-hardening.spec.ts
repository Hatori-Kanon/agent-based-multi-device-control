import { describe, expect, it } from 'vitest'
import { MemoryContentSource, type ContentSource } from '../src/ports/content-source.ts'
import { ContentPackError, loadPack } from '../src/scenario/loader.ts'

/**
 * Regression tests for the two blockers the independent wave-1 review found in
 * `loadPack` (see `analysis/m2-wave1-review-modules.md`):
 *
 * - a structurally broken `feedbackIntents` entry threw a raw `TypeError`;
 * - unsafe paths were read from the host *before* they were rejected.
 */

const FREEFORM_MANIFEST = {
  id: 'low-tide',
  name: '轻潮',
  version: '0.1.0',
  engine: '>=0.2 <1.0',
  mode: 'freeform',
  rating: 'all',
  boundaries: ['不得出现疼痛描写'],
  aftercare: { text: '慢一点，喝口水。' },
}

const SCENARIO_MANIFEST = { ...FREEFORM_MANIFEST, mode: 'scenario' }

/** Wraps a source and records every access, so ordering is observable. */
class RecordingSource implements ContentSource {
  readonly calls: string[] = []

  constructor(private readonly inner: ContentSource) {}

  async list(): Promise<readonly string[]> {
    this.calls.push('list')
    return this.inner.list()
  }

  async readText(path: string): Promise<string> {
    this.calls.push(`text:${path}`)
    return this.inner.readText(path)
  }

  async readBytes(path: string): Promise<Uint8Array> {
    this.calls.push(`bytes:${path}`)
    return this.inner.readBytes(path)
  }

  async byteSize(path: string): Promise<number> {
    this.calls.push(`size:${path}`)
    return this.inner.byteSize(path)
  }
}

function pack(files: Readonly<Record<string, string>>): ContentSource {
  return new MemoryContentSource(files)
}

describe('loadPack hardening', () => {
  it('reports a malformed feedbackIntents entry as a ContentPackError, never a TypeError', async () => {
    const source = pack({
      'pack.json': JSON.stringify(SCENARIO_MANIFEST),
      'persona.md': '# 角色',
      'scenario.json': JSON.stringify({ feedbackIntents: [null] }),
    })

    const caught: unknown = await loadPack(source).then(() => undefined, (error: unknown) => error)
    expect(caught).toBeInstanceOf(ContentPackError)
    const issues = (caught as ContentPackError).issues ?? []
    expect(issues.some(issue => issue.rule === 'intent.shape')).toBe(true)
  })

  it('rejects an unsafe path before asking the source for any bytes', async () => {
    const recording = new RecordingSource(pack({
      'pack.json': JSON.stringify(FREEFORM_MANIFEST),
      'persona.md': '# 角色',
      'waveforms/../../outside.json': '{"frames":[]}',
    }))

    const caught: unknown = await loadPack(recording).then(() => undefined, (error: unknown) => error)
    expect(caught).toBeInstanceOf(ContentPackError)
    expect((caught as ContentPackError).message).toContain('unsafe path')
    // Only the directory listing happened; the traversal path never reached
    // byteSize/readText/readBytes on the host-mapped source.
    expect(recording.calls).toEqual(['list'])
  })
})
