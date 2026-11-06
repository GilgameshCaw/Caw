import { describe, it, expect, beforeEach } from 'vitest'
import { compressVideo } from './compressVideo'

// Stand-ins for the browser media APIs. The recorder's output grows with the
// time it ran, so a recording that stops early gives a small file.
let source: { duration: number; playMs: number | null } // null: never reaches the end
let recordedMs = 0

class FakeVideo {
  muted = false
  paused = false
  ended = false
  playsInline = false
  preload = ''
  videoWidth = 1920
  videoHeight = 1080
  readyState = 2
  onended: (() => void) | null = null
  src = ''
  get duration() { return source.duration }
  load() {}
  captureStream() { return { getAudioTracks: () => [] } }
  async play() {
    if (source.playMs === null) return
    setTimeout(() => { this.ended = true; this.onended?.() }, source.playMs)
  }
}

class FakeRecorder {
  static isTypeSupported() { return true }
  ondataavailable: ((e: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  private startedAt = 0
  start() { this.startedAt = performance.now() }
  stop() {
    recordedMs = performance.now() - this.startedAt
    this.ondataavailable?.({ data: new Blob([new Uint8Array(Math.round(recordedMs))]) })
    this.onstop?.()
  }
}

const g = globalThis as any

beforeEach(() => {
  recordedMs = 0
  g.document = {
    createElement: (tag: string) => tag === 'video'
      ? new FakeVideo()
      : {
          width: 0,
          height: 0,
          getContext: () => ({ drawImage() {} }),
          captureStream: () => ({ getVideoTracks: () => ['video'] }),
        },
  }
  g.MediaRecorder = FakeRecorder
  g.MediaStream = class {}
  g.requestAnimationFrame = () => 0
  URL.createObjectURL = () => 'blob:test'
  URL.revokeObjectURL = () => {}
})

const input = () => new File([new Uint8Array(12 * 1024 * 1024)], 'clip.webm', { type: 'video/webm' })

describe('compressVideo', () => {
  it('records the whole clip when the duration is known', async () => {
    source = { duration: 0.2, playMs: 200 }
    const { transcoded } = await compressVideo(input(), 'feed')
    expect(transcoded).toBe(true)
    expect(recordedMs).toBeGreaterThan(150)
  })

  it('records the whole clip when the source reports an Infinity duration', async () => {
    source = { duration: Infinity, playMs: 200 }
    const { transcoded } = await compressVideo(input(), 'feed')
    expect(transcoded).toBe(true)
    expect(recordedMs).toBeGreaterThan(150)
  })

  it('throws instead of returning a partial clip when playback stalls', async () => {
    source = { duration: 0.01, playMs: null }
    await expect(compressVideo(input(), 'feed')).rejects.toThrow('did not finish')
  })
})
