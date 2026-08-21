/**
 * Starter waveform set.
 *
 * Only two are vendor material: `breathing` and `tide` are the frame tables
 * the official V3 protocol document prints as worked examples. The rest are
 * written here as scripts, so their provenance is this repository.
 *
 * The remaining stock app waveforms are **not** bundled. The one TypeScript
 * library that carries all of them is GPL-3.0, and copying its data table
 * would relicense this project; import them from your own DG-LAB app instead.
 */

import { compileWaveformScript, type WaveformScript } from './dsl.ts'
import { parseHexFrames } from './hex.ts'
import type { Waveform } from './types.ts'

/** Vendor worked example: slow swell, hold, release. */
const BREATHING_FRAMES = [
  '0A0A0A0A00000000',
  '0A0A0A0A14141414',
  '0A0A0A0A28282828',
  '0A0A0A0A3C3C3C3C',
  '0A0A0A0A50505050',
  '0A0A0A0A64646464',
  '0A0A0A0A64646464',
  '0A0A0A0A64646464',
  '0A0A0A0A00000000',
  '0A0A0A0A00000000',
  '0A0A0A0A00000000',
  '0A0A0A0A00000000',
] as const

/** Vendor worked example: two rising-then-easing passes with drifting frequency. */
const TIDE_FRAMES = [
  '0A0A0A0A00000000',
  '0B0B0B0B10101010',
  '0D0D0D0D21212121',
  '0E0E0E0E32323232',
  '1010101042424242',
  '1212121253535353',
  '1313131364646464',
  '151515155C5C5C5C',
  '1616161654545454',
  '181818184C4C4C4C',
  '1A1A1A1A44444444',
  '1A1A1A1A00000000',
  '1B1B1B1B10101010',
  '1D1D1D1D21212121',
  '1E1E1E1E32323232',
  '2020202042424242',
  '2222222253535353',
  '2323232364646464',
  '252525255C5C5C5C',
  '2626262654545454',
  '282828284C4C4C4C',
  '2A2A2A2A44444444',
  '0A0A0A0A00000000',
] as const

interface Authored {
  readonly id: string
  readonly tags: readonly string[]
  readonly script: WaveformScript
}

const AUTHORED: readonly Authored[] = [
  {
    id: 'probe',
    tags: ['sharp', 'sparse'],
    script: {
      name: '试探',
      segments: [
        { ms: 100, freq: 20, intensity: 70, curve: 'step' },
        { ms: 400, freq: 20, intensity: 0, curve: 'step' },
        { ms: 100, freq: 20, intensity: 55, curve: 'step' },
        { ms: 600, freq: 20, intensity: 0, curve: 'step' },
      ],
    },
  },
  {
    id: 'surge',
    tags: ['building', 'smooth'],
    script: {
      name: '涌动',
      segments: [
        { ms: 900, freq: { from: 70, to: 25 }, intensity: { from: 0, to: 85 }, curve: 'easeIn' },
        { ms: 300, freq: 25, intensity: 85 },
        { ms: 700, freq: { from: 25, to: 70 }, intensity: { from: 85, to: 0 }, curve: 'easeOut' },
        { ms: 300, freq: 70, intensity: 0 },
      ],
    },
  },
  {
    id: 'sustain',
    tags: ['gentle', 'continuous'],
    script: {
      name: '绵延',
      segments: [
        { ms: 800, freq: { from: 40, to: 55 }, intensity: { from: 35, to: 45 } },
        { ms: 800, freq: { from: 55, to: 40 }, intensity: { from: 45, to: 35 } },
      ],
    },
  },
  {
    id: 'staccato',
    tags: ['sharp', 'restless'],
    script: {
      name: '骤雨',
      segments: [
        { ms: 100, freq: 15, intensity: 90, curve: 'step' },
        { ms: 100, freq: 15, intensity: 0, curve: 'step' },
        { ms: 100, freq: 30, intensity: 75, curve: 'step' },
        { ms: 100, freq: 30, intensity: 0, curve: 'step' },
        { ms: 100, freq: 45, intensity: 90, curve: 'step' },
        { ms: 300, freq: 45, intensity: 0, curve: 'step' },
      ],
    },
  },
  {
    id: 'climb',
    tags: ['building', 'rhythmic'],
    script: {
      name: '攀升',
      segments: [
        { ms: 1_200, freq: { from: 90, to: 18 }, intensity: { from: 30, to: 95 }, curve: 'linear' },
        { ms: 400, freq: 18, intensity: 95 },
        { ms: 400, freq: 18, intensity: 0, curve: 'step' },
      ],
    },
  },
]

/**
 * Build the starter set.
 *
 * Compiling on demand means a malformed built-in script fails loudly at
 * startup rather than producing a silently odd waveform.
 */
export function createBuiltinWaveforms(): Waveform[] {
  const vendor: Waveform[] = [
    {
      id: 'breathing',
      name: '呼吸',
      frames: parseHexFrames([...BREATHING_FRAMES]),
      loop: true,
      source: 'builtin',
      tags: ['gentle', 'building'],
    },
    {
      id: 'tide',
      name: '潮汐',
      frames: parseHexFrames([...TIDE_FRAMES]),
      loop: true,
      source: 'builtin',
      tags: ['smooth', 'rhythmic'],
    },
  ]
  const authored = AUTHORED.map(entry => {
    const compiled = compileWaveformScript(entry.script)
    return {
      id: entry.id,
      name: compiled.name,
      frames: compiled.frames,
      loop: compiled.loop,
      source: 'builtin' as const,
      tags: entry.tags,
    }
  })
  return [...vendor, ...authored]
}
