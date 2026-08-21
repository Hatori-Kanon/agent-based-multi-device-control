import { describe, expect, it } from 'vitest'
import {
  clampFrameIntensity,
  clampWaveformIntensity,
  compileWaveformScript,
  createBuiltinWaveforms,
  DEFAULT_MAX_WAVE_INTENSITY,
  deserializeWaveform,
  formatHexFrame,
  frameAt,
  MAX_FREQ,
  MAX_INTENSITY,
  MAX_SESSION_WAVEFORMS,
  MIN_FREQ,
  parseHexFrame,
  parseHexFrames,
  peakIntensity,
  SafetyError,
  serializeWaveform,
  SLOTS_PER_FRAME,
  summarizeWaveform,
  WaveformLibrary,
  type PulseFrame,
  type Waveform,
} from '../src/index.ts'

function waveform(frames: readonly PulseFrame[], loop = true): Waveform {
  return { id: 'test', name: 'test', frames, loop, source: 'authored', tags: [] }
}

async function safetyError(run: () => unknown): Promise<SafetyError> {
  let caught: unknown
  try {
    await run()
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(SafetyError)
  return caught as SafetyError
}

describe('hex interchange format', () => {
  it('reads four frequency bytes then four intensity bytes', () => {
    const frame = parseHexFrame('0A0A0A0A00000000')
    expect(frame.freq).toEqual([10, 10, 10, 10])
    expect(frame.intensity).toEqual([0, 0, 0, 0])
  })

  it('round-trips a vendor frame', () => {
    const source = '0B0C0D0E10203040'
    expect(formatHexFrame(parseHexFrame(source))).toBe(source)
  })

  it('locates a malformed frame in the source list', async () => {
    const error = await safetyError(() => parseHexFrames(['0A0A0A0A00000000', 'nope']))
    expect(error.code).toBe('INVALID_WAVEFORM')
    expect(error.message).toContain('frame 1')
  })

  it('refuses rather than mangles an out-of-range value', async () => {
    // Frequency 0x05 = 5, below the protocol floor of 10.
    const low = await safetyError(() => parseHexFrame('05050505_0000000'.replace('_', '0')))
    expect(low.message).toContain('outside 10-240')
    // Intensity 0x65 = 101, above the protocol ceiling.
    const high = await safetyError(() => parseHexFrame('0A0A0A0A65656565'))
    expect(high.message).toContain('outside 0-100')
  })

  it('rejects an empty list', async () => {
    expect((await safetyError(() => parseHexFrames([]))).message).toContain('at least one frame')
  })
})

describe('waveform script compiler', () => {
  it('produces uniform frames for a constant segment', () => {
    const compiled = compileWaveformScript({
      name: 'flat',
      segments: [{ ms: 200, freq: 30, intensity: 50 }],
    })
    expect(compiled.frames).toHaveLength(2)
    for (const frame of compiled.frames) {
      expect(frame.freq).toEqual([30, 30, 30, 30])
      expect(frame.intensity).toEqual([50, 50, 50, 50])
    }
  })

  it('interpolates at 25ms slot resolution, not once per frame', () => {
    const compiled = compileWaveformScript({
      name: 'ramp',
      segments: [{ ms: 400, freq: 20, intensity: { from: 0, to: 80 } }],
    })
    expect(compiled.frames).toHaveLength(4)
    // Four distinct values inside the first 100ms; the vendor presets would
    // have emitted a single repeated value here.
    expect(compiled.frames[0]?.intensity).toEqual([0, 5, 10, 15])
    expect(compiled.frames[1]?.intensity).toEqual([20, 25, 30, 35])
    expect(compiled.frames[3]?.intensity).toEqual([60, 65, 70, 75])
  })

  it('holds the start value across a step segment', () => {
    const compiled = compileWaveformScript({
      name: 'stepped',
      segments: [
        { ms: 200, freq: 20, intensity: { from: 10, to: 90 }, curve: 'step' },
        { ms: 200, freq: 20, intensity: 90 },
      ],
    })
    expect(compiled.frames[0]?.intensity).toEqual([10, 10, 10, 10])
    expect(compiled.frames[1]?.intensity).toEqual([10, 10, 10, 10])
    expect(compiled.frames[2]?.intensity).toEqual([90, 90, 90, 90])
  })

  it('eases in more slowly than linear', () => {
    const linear = compileWaveformScript({
      name: 'linear',
      segments: [{ ms: 400, freq: 20, intensity: { from: 0, to: 100 } }],
    })
    const eased = compileWaveformScript({
      name: 'eased',
      segments: [{ ms: 400, freq: 20, intensity: { from: 0, to: 100 }, curve: 'easeIn' }],
    })
    expect(eased.frames[2]?.intensity[0]).toBeLessThan(linear.frames[2]?.intensity[0] ?? 0)
  })

  it('requires the total to be a whole number of frames and says how to fix it', async () => {
    const error = await safetyError(() => compileWaveformScript({
      name: 'ragged',
      segments: [{ ms: 250, freq: 20, intensity: 40 }],
    }))
    expect(error.message).toContain('250ms')
    expect(error.message).toContain('adjust a segment by 50ms')
  })

  it('names the offending segment and the legal range', async () => {
    const freq = await safetyError(() => compileWaveformScript({
      name: 'bad freq',
      segments: [{ ms: 100, freq: 20, intensity: 40 }, { ms: 100, freq: 300, intensity: 40 }],
    }))
    expect(freq.message).toContain('segment 1')
    expect(freq.message).toContain('10-240')

    const intensity = await safetyError(() => compileWaveformScript({
      name: 'bad intensity',
      segments: [{ ms: 100, freq: 20, intensity: { from: 0, to: 120 } }],
    }))
    expect(intensity.message).toContain('intensity.to')
    expect(intensity.message).toContain('0-100')
  })

  it('rejects a waveform that never outputs anything', async () => {
    const error = await safetyError(() => compileWaveformScript({
      name: 'silent',
      segments: [{ ms: 200, freq: 20, intensity: 0 }],
    }))
    expect(error.message).toContain('never produces output')
  })

  it('defaults to looping and keeps trimmed tags', () => {
    const compiled = compileWaveformScript({
      name: '  spaced  ',
      tags: [' gentle ', 'slow'],
      segments: [{ ms: 100, freq: 20, intensity: 30 }],
    })
    expect(compiled.name).toBe('spaced')
    expect(compiled.loop).toBe(true)
    expect(compiled.tags).toEqual(['gentle', 'slow'])
  })
})

describe('frame access and summaries', () => {
  const sample = waveform([
    { freq: [10, 10, 10, 10], intensity: [0, 0, 0, 0] },
    { freq: [20, 20, 20, 20], intensity: [40, 40, 40, 80] },
  ])

  it('wraps a looping waveform and stops a non-looping one', () => {
    expect(frameAt(sample, 0)?.freq[0]).toBe(10)
    expect(frameAt(sample, 2)?.freq[0]).toBe(10)
    expect(frameAt(sample, 3)?.freq[0]).toBe(20)
    expect(frameAt({ ...sample, loop: false }, 2)).toBeUndefined()
  })

  it('reports duration, peak, mean, and frequency span', () => {
    const summary = summarizeWaveform(sample, 'session')
    expect(summary.frameCount).toBe(2)
    expect(summary.durationMs).toBe(200)
    expect(summary.peakIntensity).toBe(80)
    expect(summary.meanIntensity).toBe(Math.round((0 + 0 + 0 + 0 + 40 + 40 + 40 + 80) / 8))
    expect(summary.minFreq).toBe(10)
    expect(summary.maxFreq).toBe(20)
    expect(summary.scope).toBe('session')
  })

  it('never leaks frame data into a summary', () => {
    const summary = summarizeWaveform(sample, 'library') as unknown as Record<string, unknown>
    expect(summary.frames).toBeUndefined()
  })
})

describe('emit-path clamping', () => {
  const frame: PulseFrame = { freq: [10, 20, 30, 40], intensity: [10, 50, 90, 100] }

  it('lowers intensity and leaves frequency alone', () => {
    const clamped = clampFrameIntensity(frame, 60)
    expect(clamped.intensity).toEqual([10, 50, 60, 60])
    expect(clamped.freq).toEqual([10, 20, 30, 40])
  })

  it('returns the same object when nothing needs clamping', () => {
    expect(clampFrameIntensity(frame, 100)).toBe(frame)
  })

  it('brings a whole waveform under the cap', () => {
    const clamped = clampWaveformIntensity(waveform([frame]), DEFAULT_MAX_WAVE_INTENSITY)
    expect(peakIntensity(clamped)).toBe(DEFAULT_MAX_WAVE_INTENSITY)
  })

  it('keeps the vendor square waves intact under a generous cap', () => {
    // 挤压 and 气泡 are 0-to-100 square waves. No slew limit may exist here or
    // most shared waveforms would be rejected.
    const square = waveform([
      { freq: [10, 10, 10, 10], intensity: [0, 0, 0, 0] },
      { freq: [10, 10, 10, 10], intensity: [100, 100, 100, 100] },
    ])
    const clamped = clampWaveformIntensity(square, 100)
    expect(clamped).toBe(square)
  })
})

describe('builtin starter set', () => {
  const builtins = createBuiltinWaveforms()

  it('includes the two vendor worked examples at their documented lengths', () => {
    const breathing = builtins.find(entry => entry.id === 'breathing')
    const tide = builtins.find(entry => entry.id === 'tide')
    expect(breathing?.frames).toHaveLength(12)
    expect(tide?.frames).toHaveLength(23)
    expect(breathing?.frames[1]?.intensity).toEqual([20, 20, 20, 20])
  })

  it('keeps every frame inside the protocol range', () => {
    for (const entry of builtins) {
      for (const [index, frame] of entry.frames.entries()) {
        for (let slot = 0; slot < SLOTS_PER_FRAME; slot += 1) {
          const freq = frame.freq[slot] ?? 0
          const intensity = frame.intensity[slot] ?? 0
          expect(freq, `${entry.id} frame ${index}`).toBeGreaterThanOrEqual(MIN_FREQ)
          expect(freq, `${entry.id} frame ${index}`).toBeLessThanOrEqual(MAX_FREQ)
          expect(intensity, `${entry.id} frame ${index}`).toBeLessThanOrEqual(MAX_INTENSITY)
        }
      }
    }
  })

  it('gives every entry a distinct id and at least one tag', () => {
    const ids = builtins.map(entry => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const entry of builtins) expect(entry.tags.length).toBeGreaterThan(0)
  })
})

describe('WaveformLibrary', () => {
  it('lists builtins as durable and authored work as session scratch', () => {
    const library = new WaveformLibrary()
    const before = library.list()
    expect(before.every(entry => entry.scope === 'library')).toBe(true)

    const authored = library.author({
      name: '涨潮试探',
      segments: [{ ms: 300, freq: { from: 60, to: 25 }, intensity: { from: 0, to: 70 } }],
    })
    expect(library.scopeOf(authored.id)).toBe('session')
    expect(authored.source).toBe('authored')
    expect(authored.id).toBe('涨潮试探')

    const listed = library.list().find(entry => entry.id === authored.id)
    expect(listed?.scope).toBe('session')
  })

  it('only lets a human move something into the durable library', () => {
    const library = new WaveformLibrary()
    const authored = library.author({
      name: 'scratch',
      segments: [{ ms: 100, freq: 20, intensity: 30 }],
    })
    expect(library.scopeOf(authored.id)).toBe('session')
    library.promoteByHuman(authored.id)
    expect(library.scopeOf(authored.id)).toBe('library')

    const names = new Set<string>()
    for (let proto: object | null = library; proto !== null; proto = Object.getPrototypeOf(proto) as object | null) {
      for (const name of Object.getOwnPropertyNames(proto)) names.add(name)
    }
    expect([...names].filter(name => /promote/i.test(name))).toEqual(['promoteByHuman'])
  })

  it('drops scratch on clearSession but keeps promoted work', () => {
    const library = new WaveformLibrary()
    const kept = library.author({ name: 'kept', segments: [{ ms: 100, freq: 20, intensity: 30 }] })
    const dropped = library.author({ name: 'dropped', segments: [{ ms: 100, freq: 20, intensity: 30 }] })
    library.promoteByHuman(kept.id)
    library.clearSession()
    expect(library.get(kept.id)).toBeDefined()
    expect(library.get(dropped.id)).toBeUndefined()
  })

  it('allocates distinct ids for repeated names', () => {
    const library = new WaveformLibrary()
    const first = library.author({ name: 'same', segments: [{ ms: 100, freq: 20, intensity: 30 }] })
    const second = library.author({ name: 'same', segments: [{ ms: 100, freq: 20, intensity: 30 }] })
    expect(first.id).toBe('same')
    expect(second.id).toBe('same-2')
  })

  it('caps session scratch', async () => {
    const library = new WaveformLibrary()
    for (let index = 0; index < MAX_SESSION_WAVEFORMS; index += 1) {
      library.author({ name: 'spam', segments: [{ ms: 100, freq: 20, intensity: 30 }] })
    }
    const error = await safetyError(() => library.author({
      name: 'one too many',
      segments: [{ ms: 100, freq: 20, intensity: 30 }],
    }))
    expect(error.message).toContain(String(MAX_SESSION_WAVEFORMS))
  })

  it('explains an unknown id instead of returning nothing useful', async () => {
    const library = new WaveformLibrary()
    const error = await safetyError(() => library.require('absent'))
    expect(error.code).toBe('UNKNOWN_WAVEFORM')
    expect(error.message).toContain('waveform_list')
  })

  it('imports shared frames into session scope', () => {
    const library = new WaveformLibrary()
    const imported = library.importFrames('社区波形', ['0A0A0A0A00000000', '0A0A0A0A64646464'], ['sharp'])
    expect(imported.source).toBe('imported')
    expect(library.scopeOf(imported.id)).toBe('session')
    expect(imported.frames).toHaveLength(2)
  })

  it('round-trips durable non-builtin waveforms for persistence', () => {
    const library = new WaveformLibrary()
    const authored = library.author({
      name: 'persist me',
      tags: ['building'],
      segments: [{ ms: 200, freq: { from: 20, to: 40 }, intensity: { from: 10, to: 70 } }],
    })
    library.promoteByHuman(authored.id)

    const exported = library.exportLibrary()
    // Builtins are not persisted; they ship with the code.
    expect(exported.map(entry => entry.id)).toEqual([authored.id])

    const restored = new WaveformLibrary()
    restored.loadLibrary(exported)
    const back = restored.require(authored.id)
    expect(back.frames).toEqual(authored.frames)
    expect(back.tags).toEqual(['building'])
    expect(restored.scopeOf(authored.id)).toBe('library')
  })

  it('serializes through the shared hex format', () => {
    const library = new WaveformLibrary()
    const original = library.require('breathing')
    const restored = deserializeWaveform(serializeWaveform(original))
    expect(restored.frames).toEqual(original.frames)
  })
})
