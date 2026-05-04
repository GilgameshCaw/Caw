// Client-side video compression. Mirrors the compressImage.ts API: pass
// in a File + preset, get back a (possibly-shrunk) File ready to upload.
//
// Implementation: MediaRecorder. We play the source video through a
// hidden <video> + offscreen <canvas>, capture the canvas + the source's
// audio track via MediaRecorder at a target bitrate, and box the result
// back into a File.
//
// Why MediaRecorder (not WebCodecs / FFmpeg.wasm):
//   - Universal: Chrome/Edge/Safari/Firefox/iOS Safari all support it.
//   - Zero bundle weight (browser-native).
//   - "Compress to fit a cap" doesn't need fine-grained codec control.
//   - WebCodecs is faster (HW-accelerated) but the muxing glue is large
//     and not available on iOS pre-17. Future upgrade if real users
//     complain about compression speed; not v1.
//
// Output: WebM (VP9 video + Opus audio if supported, falls back to VP8).
// The server's MIME allowlist already accepts video/webm.
//
// Speed: roughly real-time. A 30-second clip takes ~30s to compress.
// Callers should show a "Compressing video…" spinner.

const PRESETS = {
  /** Feed video — target ~6MB so we land comfortably under the 10MB
   *  server cap with container/audio overhead. 1.5 Mbps video + 96 kbps
   *  audio at 720p is acceptable for short-form social. */
  feed: { targetBytes: 6 * 1024 * 1024, videoBitsPerSecond: 1_500_000, audioBitsPerSecond: 96_000, maxDimension: 1280 },
  /** DM video — much tighter. 1.5MB target. ~600 kbps video at 480p
   *  height keeps phone clips watchable while fitting in a DM. */
  dm:   { targetBytes: 1500 * 1024,    videoBitsPerSecond: 600_000,   audioBitsPerSecond: 64_000, maxDimension: 854 },
} as const

export type VideoPreset = keyof typeof PRESETS

interface CompressResult {
  file: File
  /** True if the function actually transcoded; false means we returned
   *  the input unchanged (already small enough, or compression skipped
   *  for an unrenderable input). */
  transcoded: boolean
}

/**
 * Compress a video to fit under a target byte size. Pass-through for
 * non-videos and for inputs that are already small enough.
 *
 * Throws on transcoding failure so the caller can surface a "this video
 * couldn't be compressed, try a smaller clip" error. We deliberately
 * don't fall back to the original here (unlike compressImage) — videos
 * exceeding the cap need to be smaller, not the same size as before.
 */
export async function compressVideo(file: File, preset: VideoPreset = 'feed'): Promise<CompressResult> {
  if (!file.type.startsWith('video/')) return { file, transcoded: false }

  const cfg = PRESETS[preset]
  if (file.size <= cfg.targetBytes) return { file, transcoded: false }

  if (typeof MediaRecorder === 'undefined') {
    throw new Error('Your browser does not support video compression. Try Chrome, Edge, Safari, or Firefox.')
  }

  // Pick the best supported mimeType. VP9 is meaningfully smaller at the
  // same visual quality but isn't universal in MediaRecorder; VP8 is
  // baseline-supported. iOS Safari historically only supported its own
  // codec strings; we fall back to a bare type if all the explicit ones
  // fail.
  const mimeCandidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
    'video/mp4',
  ]
  const recorderMime = mimeCandidates.find(m => MediaRecorder.isTypeSupported(m))
  if (!recorderMime) {
    throw new Error('Your browser does not support a compatible video format.')
  }

  // Decode the source by playing it into a hidden <video>. The video
  // element is muted so autoplay is allowed and the user doesn't hear
  // the source playback during compression.
  const sourceUrl = URL.createObjectURL(file)
  const video = document.createElement('video')
  video.src = sourceUrl
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'

  try {
    await waitForMetadata(video)

    // Constrain output dimensions. The MediaRecorder will record the
    // canvas at whatever size we paint to it; downsampling here is the
    // primary mechanism for hitting the bitrate target on phone-shot
    // 4K/1080p source.
    const { width, height } = fitWithin(video.videoWidth, video.videoHeight, cfg.maxDimension)

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Could not create 2D drawing context for video compression.')

    // captureStream pulls real-time video from the canvas. Some browsers
    // expose it as captureStream() with a frameRate hint; pass a sane
    // 30fps so we don't oversample static frames.
    const canvasStream = (canvas as any).captureStream
      ? (canvas as any).captureStream(30)
      : (canvas as any).mozCaptureStream?.(30)
    if (!canvasStream) throw new Error('Canvas captureStream not supported.')

    // Pull audio off the source video. Some browsers gate this behind
    // CORS / EME flags, in which case we record video-only.
    let audioStream: MediaStream | null = null
    try {
      const sourceStream = (video as any).captureStream
        ? (video as any).captureStream()
        : (video as any).mozCaptureStream?.()
      const audioTracks = sourceStream?.getAudioTracks?.() ?? []
      if (audioTracks.length > 0) {
        audioStream = new MediaStream([audioTracks[0]])
      }
    } catch {
      // No audio is acceptable — we'd rather get a silent compressed
      // video than fail the whole upload.
    }

    const combinedTracks = [...canvasStream.getVideoTracks()]
    if (audioStream) combinedTracks.push(...audioStream.getAudioTracks())
    const combined = new MediaStream(combinedTracks)

    const recorder = new MediaRecorder(combined, {
      mimeType: recorderMime,
      videoBitsPerSecond: cfg.videoBitsPerSecond,
      audioBitsPerSecond: cfg.audioBitsPerSecond,
    })

    const chunks: Blob[] = []
    recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data) }

    const recordingDone = new Promise<Blob>((resolve, reject) => {
      recorder.onstop = () => resolve(new Blob(chunks, { type: recorderMime }))
      recorder.onerror = (e: any) => reject(e?.error || new Error('MediaRecorder error'))
    })

    recorder.start(1000) // 1s timeslices — a few chunks for a 30s clip

    // Render frames onto the canvas as the video plays. requestVideoFrameCallback
    // is the modern, drift-free way to do this; fall back to rAF for older
    // browsers (Firefox shipped rVFC in 130).
    const drawLoop = () => {
      if (video.paused || video.ended) return
      ctx.drawImage(video, 0, 0, width, height)
      if ('requestVideoFrameCallback' in video) {
        (video as any).requestVideoFrameCallback(drawLoop)
      } else {
        requestAnimationFrame(drawLoop)
      }
    }

    await video.play()
    drawLoop()

    // Wait for the source to finish playing, then stop the recorder.
    await new Promise<void>((resolve) => {
      video.onended = () => resolve()
      // Safety: if the source video has no duration metadata or the
      // 'ended' event somehow doesn't fire, bail after duration + 2s.
      const safety = (video.duration || 60) * 1000 + 2000
      setTimeout(resolve, safety)
    })
    recorder.stop()

    const blob = await recordingDone
    const ext = recorderMime.includes('mp4') ? '.mp4' : '.webm'
    const baseName = file.name.replace(/\.[^.]+$/, '') || 'video'
    const out = new File([blob], `${baseName}${ext}`, { type: recorderMime.split(';')[0] })

    // Sanity check: if the "compressed" output is bigger than the input
    // (rare but possible with already-optimized small WebM source),
    // return the original instead.
    if (out.size >= file.size) {
      console.warn(`[compressVideo] output ${out.size} >= input ${file.size}; using original`)
      return { file, transcoded: false }
    }

    console.log(
      `[compressVideo] ${preset}: ${(file.size / 1024 / 1024).toFixed(1)}MB → ` +
      `${(out.size / 1024 / 1024).toFixed(1)}MB (${Math.round((1 - out.size / file.size) * 100)}% smaller)`,
    )
    return { file: out, transcoded: true }
  } finally {
    URL.revokeObjectURL(sourceUrl)
    video.src = ''
    video.load()
  }
}

function waitForMetadata(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve, reject) => {
    if (video.readyState >= 1 && video.videoWidth > 0) return resolve()
    video.onloadedmetadata = () => resolve()
    video.onerror = () => reject(new Error('Failed to load video metadata.'))
    // Hard timeout — a corrupt or unsupported source shouldn't hang the
    // composer forever.
    setTimeout(() => reject(new Error('Video metadata load timed out.')), 15000)
  })
}

function fitWithin(srcW: number, srcH: number, maxDim: number): { width: number; height: number } {
  if (srcW <= maxDim && srcH <= maxDim) return { width: srcW, height: srcH }
  const ratio = srcW / srcH
  if (srcW >= srcH) return { width: maxDim, height: Math.round(maxDim / ratio) }
  return { width: Math.round(maxDim * ratio), height: maxDim }
}
