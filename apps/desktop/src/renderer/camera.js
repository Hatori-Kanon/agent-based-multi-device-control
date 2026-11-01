// Hidden camera worker. Owns the MediaStream and the capture canvas; the main
// process drives it through executeJavaScript calls, exactly like ble.js.
//
// A frame is drawn into a 32x24 canvas, converted to grey, and analysed with
// the shared @embodied/core feature extractor, so the renderer and the unit
// tests run the same feature code (plan §4.1). The page pushes only two
// payload shapes back across the bridge:
//
//     { type: 'features', sample: { capturedAtMs, frameAgeMs, features } }
//     { type: 'jpeg', bytes: '<base64>' }        // '' when there is no frame
//
// This source file is bundled by esbuild into dist/camera-renderer.js (see the
// package.json build script); it is never loaded directly by the browser.

import { analyzeFrame } from '@embodied/core'

const WIDTH = 32
const HEIGHT = 24
/** JPEG quality for look snapshots: readable, not a transport burden. */
const JPEG_QUALITY = 0.7

const host = window.__cameraHost
const video = document.getElementById('video')

let stream = null
let captureCanvas = null
let captureContext = null
let previous = null
// Motion bookkeeping returned by analyzeFrame, carried between samples.
let motionState = undefined
let lastFrameAt = 0
let sawAFrame = false
let watchingFrames = false

host?.diag('camera worker loaded')

/** Stringify a DOMException without losing its name. */
function describe(error) {
  const name = error && typeof error.name === 'string' ? error.name : ''
  const message = error && typeof error.message === 'string' ? error.message : String(error)
  return name ? `${name}: ${message}` : message
}

function ready() {
  return stream !== null && video !== null && video.readyState >= 2 && video.videoWidth > 0
}

function ensureCanvas() {
  if (captureContext !== null) return
  captureCanvas = document.createElement('canvas')
  captureCanvas.width = WIDTH
  captureCanvas.height = HEIGHT
  captureContext = captureCanvas.getContext('2d', { willReadFrequently: true })
}

/**
 * Record when the device last presented a frame.
 *
 * `requestVideoFrameCallback` is the honest source for frame age; without it
 * the age degrades to 0 on every sample (the sample itself just drew the
 * current frame) rather than inventing a number.
 */
function watchFrames() {
  if (stream === null || watchingFrames) return
  if (typeof video.requestVideoFrameCallback !== 'function') return
  watchingFrames = true
  const onPresented = () => {
    lastFrameAt = performance.now()
    sawAFrame = true
    if (stream === null) {
      watchingFrames = false
      return
    }
    video.requestVideoFrameCallback(onPresented)
  }
  video.requestVideoFrameCallback(onPresented)
}

function frameAgeMs() {
  if (!sawAFrame || lastFrameAt === 0) return 0
  return Math.max(0, Math.round(performance.now() - lastFrameAt))
}

/** Draw the current video frame into the 32x24 canvas and read it back as grey. */
function greyFrame() {
  captureContext.drawImage(video, 0, 0, WIDTH, HEIGHT)
  const pixels = captureContext.getImageData(0, 0, WIDTH, HEIGHT).data
  const data = new Uint8Array(WIDTH * HEIGHT)
  for (let index = 0, offset = 0; index < data.length; index += 1, offset += 4) {
    // BT.601 luma; the extractor only needs relative brightness.
    data[index] = (pixels[offset] * 0.299 + pixels[offset + 1] * 0.587 + pixels[offset + 2] * 0.114) | 0
  }
  return { width: WIDTH, height: HEIGHT, data }
}

function releaseStream() {
  if (stream !== null) {
    for (const track of stream.getTracks()) {
      try { track.stop() } catch { /* already gone */ }
    }
    stream = null
  }
  if (video !== null) video.srcObject = null
  previous = null
  motionState = undefined
  lastFrameAt = 0
  sawAFrame = false
  watchingFrames = false
}

window.__camera = {
  /** Video inputs, in platform order. Labels are empty before permission. */
  async listDevices() {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.enumerateDevices !== 'function') return []
    let devices
    try {
      devices = await navigator.mediaDevices.enumerateDevices()
    } catch (error) {
      host?.diag(`enumerateDevices failed: ${describe(error)}`)
      return []
    }
    return devices
      .filter(device => device.kind === 'videoinput')
      .map((device, index) => ({
        deviceId: device.deviceId,
        label: device.label || `摄像头 ${index + 1}`,
      }))
  },

  async start(deviceId) {
    releaseStream()
    // An empty id means the platform has not revealed device ids yet (no
    // permission granted): let the platform pick its default camera rather
    // than failing an `exact` constraint on a string we do not have.
    const videoConstraint = typeof deviceId === 'string' && deviceId.length > 0
      ? { deviceId: { exact: deviceId } }
      : true
    let opened
    try {
      opened = await navigator.mediaDevices.getUserMedia({ audio: false, video: videoConstraint })
    } catch (error) {
      throw new Error(`getUserMedia failed: ${describe(error)}`)
    }
    stream = opened
    ensureCanvas()
    previous = null
    motionState = undefined
    lastFrameAt = 0
    sawAFrame = false
    watchingFrames = false
    video.srcObject = opened
    // The window is hidden, so autoplay refusal is normal; the stream still
    // delivers frames to drawImage once the element has data.
    try {
      await video.play()
    } catch (error) {
      host?.diag(`video.play() refused (hidden window): ${describe(error)}`)
    }
    watchFrames()
    const track = opened.getVideoTracks()[0]
    if (track !== undefined) {
      // A USB unplug surfaces here on Chromium; this is the authoritative
      // "capture end" signal, which the main process turns into one
      // `quality:'unavailable'` sample.
      track.addEventListener('ended', () => {
        host?.ended('camera stream ended (device removed or unplugged)')
        releaseStream()
      })
      host?.diag(`camera started: ${track.label || deviceId || 'default'}`)
    }
    return true
  },

  /** Capture and analyse one frame; null when the stream has no frame yet. */
  sample() {
    if (!ready()) return null
    ensureCanvas()
    if (captureContext === null) return null
    const next = greyFrame()
    const result = analyzeFrame(next, previous ?? undefined, motionState, performance.now())
    previous = next
    motionState = result.state
    return {
      type: 'features',
      sample: {
        capturedAtMs: performance.now(),
        frameAgeMs: frameAgeMs(),
        features: result.features,
      },
    }
  },

  /** Capture the current frame as a base64 JPEG ('') when there is no frame. */
  snapshot() {
    if (!ready() || video.videoWidth === 0 || video.videoHeight === 0) {
      return { type: 'jpeg', bytes: '' }
    }
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const context = canvas.getContext('2d')
    if (context === null) return { type: 'jpeg', bytes: '' }
    context.drawImage(video, 0, 0, canvas.width, canvas.height)
    const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY)
    const comma = dataUrl.indexOf(',')
    return { type: 'jpeg', bytes: comma >= 0 ? dataUrl.slice(comma + 1) : '' }
  },

  stop() {
    releaseStream()
    return true
  },
}
