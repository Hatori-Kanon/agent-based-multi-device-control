import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SENSOR_BLOCK_BUDGET,
  sensorPromptBlock,
  sensorsListPayload,
} from '../src/sensors/projection.ts'
import type { SensorKind, SensorQuality, SensorStatus } from '../src/sensors/types.ts'

function status(
  id: string,
  kind: SensorKind,
  quality: SensorQuality,
  label: string,
  freshnessMs: number | undefined,
): SensorStatus {
  return {
    id,
    kind,
    label,
    quality,
    lastTs: freshnessMs === undefined ? undefined : 1_000,
    freshnessMs,
  }
}

describe('sensor projection', () => {
  it('renders an empty sensor block when nothing is registered', () => {
    expect(sensorPromptBlock([])).toBe('')
    expect(sensorPromptBlock([], DEFAULT_SENSOR_BLOCK_BUDGET)).toBe('')
    // An empty budget and an empty world are both "no section", never noise.
    expect(sensorPromptBlock([], 0)).toBe('')
    expect(sensorPromptBlock([status('usb-cam-1', 'image', 'ok', 'USB 摄像头', 100)], 0)).toBe('')
  })

  it('keeps the injected block within 200 characters', () => {
    expect(DEFAULT_SENSOR_BLOCK_BUDGET).toBe(200)
    const many: SensorStatus[] = []
    for (let index = 0; index < 20; index += 1) {
      many.push(status(`cam-${index}`, 'image', 'ok', '很长的摄像头名称一号', 400 + index))
    }
    const block = sensorPromptBlock(many)
    expect(block.startsWith('感知：')).toBe(true)
    expect(block.length).toBeLessThanOrEqual(200)
    // Facts are dropped (freshness, then ok sources) before hard truncation.
    expect(block.endsWith('…')).toBe(true)

    // A tight budget goes straight to the actionable sources.
    const mixed = [
      status('cam-1', 'image', 'ok', '摄像头', 400),
      status('mic-1', 'audio', 'stale', '麦克风', 3_000),
    ]
    const tight = sensorPromptBlock(mixed, 20)
    expect(tight.length).toBeLessThanOrEqual(20)
    expect(tight).toContain('无新数据')
    expect(tight).not.toContain('可用')
    expect(tight).not.toContain('s前')
  })

  it('states quality facts only and never an emotion label', () => {
    const block = sensorPromptBlock([
      status('usb-cam-1', 'image', 'dim', 'USB 摄像头', 1_200),
      status('usb-cam-2', 'image', 'blocked', '副摄像头', 800),
      status('mic-1', 'audio', 'stale', '麦克风', 3_000),
    ])

    expect(block).toContain('USB 摄像头')
    expect(block).toContain('偏暗')
    expect(block).toContain('被遮挡')
    expect(block).toContain('无新数据')
    // No inferred feeling, no hedging, no advice — only measured facts.
    expect(block).not.toMatch(/紧张|害怕|焦虑|生气|开心|兴奋|难过|情绪|似乎|可能|大概|推测|建议/)
    expect(block).not.toMatch(/mood|emotion|feeling/i)
  })

  it('skips an hr source and describes audio by volume only', () => {
    const block = sensorPromptBlock([
      status('hr-band-1', 'hr', 'ok', '心率臂带', 500),
      status('mic-1', 'audio', 'ok', '麦克风', 500),
    ])

    expect(block).not.toContain('hr-band-1')
    expect(block).not.toContain('心率臂带')
    expect(block).toContain('麦克风')
    // A microphone has a level, not a picture.
    expect(block).toContain('音量')
    expect(block).not.toContain('画面')
  })

  it('projects one payload entry per source in registration order', () => {
    const payload = sensorsListPayload([
      status('usb-cam-1', 'image', 'ok', 'USB 摄像头', 400),
      status('mic-1', 'audio', 'stale', '麦克风', undefined),
    ])

    expect(payload).toEqual({
      sources: [
        { id: 'usb-cam-1', kind: 'image', label: 'USB 摄像头', quality: 'ok', freshnessMs: 400 },
        { id: 'mic-1', kind: 'audio', label: '麦克风', quality: 'stale', freshnessMs: undefined },
      ],
    })
  })
})
