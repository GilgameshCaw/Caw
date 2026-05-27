import React, { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import {
  HiOutlineX,
  HiOutlinePlay,
  HiOutlinePause,
  HiOutlineVolumeUp,
  HiOutlineVolumeOff,
  HiOutlineArrowsExpand,
} from 'react-icons/hi'

// Module-scoped singleton tracking the one <video> currently playing
// with sound. When a second video unmutes, the previously-tracked one
// gets re-muted so the user never hears two posts at once (bug
// reports #99, #173). Plain ref, no React state — coordinator must
// work across sibling instances and a re-render would defeat that.
const audioCoordinator: { current: HTMLVideoElement | null } = { current: null }
function claimAudio(el: HTMLVideoElement) {
  if (audioCoordinator.current && audioCoordinator.current !== el) {
    audioCoordinator.current.muted = true
  }
  audioCoordinator.current = el
}
function releaseAudio(el: HTMLVideoElement) {
  if (audioCoordinator.current === el) audioCoordinator.current = null
}

// Session-sticky "user wants audio" flag (#336). Once the user unmutes
// any video, subsequent videos they swipe into auto-unmute too — same
// behaviour as TikTok / X. Cleared when the user explicitly mutes via
// our toggle. Coordinator-driven mutes (when another video claims the
// audio slot) intentionally DON'T clear it: that mute reflects video
// switching, not the user wanting silence.
let userWantsAudio = false

/** Video player for posts. Mobile = native browser controls (familiar UX,
 * accessibility, buffering indicator). Desktop = custom hover overlay
 * (no browser chrome, cleaner look, fullscreen modal). */
const PostVideo: React.FC<{ url: string; onError?: () => void }> = ({ url, onError }) => {
  const [isDesktop, setIsDesktop] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)')
    const update = () => setIsDesktop(mq.matches)
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [])

  const videoRef = useRef<HTMLVideoElement>(null)
  const [isPlaying, setIsPlaying] = useState(true)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [isMuted, setIsMuted] = useState(true)
  const [showFullscreen, setShowFullscreen] = useState(false)

  useEffect(() => {
    if (!showFullscreen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setShowFullscreen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [showFullscreen])

  // Track explicit user-initiated pauses so the IntersectionObserver
  // below doesn't auto-resume a video the user deliberately stopped.
  // Declared before any effect that reads it (the closures don't fire
  // until after mount, but keeping the source order tidy avoids TDZ
  // surprises if the file is ever restructured).
  const videoUserPausedRef = useRef(false)

  // Pause when the video scrolls off-screen, resume when it scrolls
  // back in. Fixes bug #177 (videos kept playing after swipe-past).
  // Uses 0.25 as the threshold so a partial sliver visible at the
  // edge of the viewport doesn't keep playback running.
  useEffect(() => {
    const el = videoRef.current
    if (!el) return
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          // Only auto-resume videos the user hasn't explicitly paused.
          // We can't fully tell intent vs scroll-pause, but
          // `videoUserPausedRef` is flipped in togglePlay below to
          // record explicit pauses.
          if (!videoUserPausedRef.current && el.paused) {
            void el.play().catch(() => { /* autoplay blocked: ignore */ })
          }
          // #336 — if the user already unmuted a previous video this
          // session, carry that preference into this one too. claimAudio
          // mutes any other unmuted video so we still play at most one
          // at a time. Browsers permit programmatic unmute once the user
          // has interacted with the page (which they did by unmuting the
          // first video), so this doesn't trip autoplay-with-audio.
          if (userWantsAudio && el.muted) {
            el.muted = false
            claimAudio(el)
          }
        } else {
          if (!el.paused) el.pause()
          // Reset audio state when leaving the viewport. Without this,
          // scrolling past a video the user unmuted and then scrolling
          // back later would auto-resume it with sound — and if
          // another video also got unmuted in the meantime, both
          // would play audio at once. Force-muting on exit gives a
          // clean slate; the user can re-unmute if they want sound.
          el.muted = true
          releaseAudio(el)
        }
      },
      { threshold: 0.25 },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])

  // Cleanup audio-coordinator slot on unmount.
  useEffect(() => {
    return () => {
      const el = videoRef.current
      if (el) releaseAudio(el)
    }
  }, [])

  // Sync the audio coordinator with native-control-driven mute changes.
  // The mobile path uses the browser's built-in <video controls>, so a
  // user unmute via the native UI never hits our toggleMute handler.
  // Listening for `volumechange` here catches both desktop and mobile
  // paths uniformly and fixes the sibling case where two posts on
  // screen could be unmuted at once via the native bar (bug #173,
  // #99).
  useEffect(() => {
    const el = videoRef.current
    if (!el) return
    const onVolumeChange = () => {
      setIsMuted(el.muted)
      if (!el.muted) {
        claimAudio(el)
        // #336 — any unmute (toggle button OR native controls) means the
        // user wants audio for the session. Don't clear on mute here:
        // we can't distinguish a user mute from a coordinator force-mute,
        // and clearing on the latter would defeat the sticky behaviour.
        // Explicit user mutes flow through toggleMute below and clear it.
        userWantsAudio = true
      }
      else releaseAudio(el)
    }
    el.addEventListener('volumechange', onVolumeChange)
    return () => { el.removeEventListener('volumechange', onVolumeChange) }
  }, [])

  const fmt = (s: number) => {
    if (!isFinite(s)) return '0:00'
    const m = Math.floor(s / 60)
    const sec = Math.floor(s % 60)
    return `${m}:${sec.toString().padStart(2, '0')}`
  }
  const togglePlay = (e: React.MouseEvent) => {
    e.stopPropagation()
    const v = videoRef.current; if (!v) return
    if (v.paused) {
      videoUserPausedRef.current = false
      void v.play().catch(() => { /* ignore */ })
    } else {
      videoUserPausedRef.current = true
      v.pause()
    }
  }
  const toggleMute = (e: React.MouseEvent) => {
    e.stopPropagation()
    const v = videoRef.current; if (!v) return
    v.muted = !v.muted
    setIsMuted(v.muted)
    if (!v.muted) {
      // Claim the global audio slot so any other unmuted PostVideo
      // gets re-muted before this one starts producing sound.
      claimAudio(v)
      // #336 — explicit user unmute → sticky for the session.
      userWantsAudio = true
    } else {
      releaseAudio(v)
      // #336 — explicit user mute via our toggle → clears the session
      // preference. Coordinator-driven mutes don't reach this path.
      userWantsAudio = false
    }
  }
  const seek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = videoRef.current; if (!v) return
    v.currentTime = Number(e.target.value)
  }

  if (!isDesktop) {
    return (
      <video
        // Same ref the desktop path uses — wires up the
        // IntersectionObserver (auto-pause on scroll-off) and
        // volumechange listener (audio coordinator) for mobile too.
        // Without this the mobile native-controls path skipped both,
        // so videos kept playing after swipe-down and two videos
        // could be audible at once.
        ref={videoRef}
        src={url}
        autoPlay
        controls
        className="w-full h-auto max-h-[32rem] block outline-none"
        loop
        muted
        playsInline
        preload="metadata"
        onClick={(e) => e.stopPropagation()}
        // Track user-initiated pauses via the native controls so the
        // IntersectionObserver doesn't force-resume on the next
        // scroll back into view.
        onPause={(e) => {
          // We only flag user pauses, not auto-pauses. Distinguish by
          // checking whether the pause came from a fully-visible
          // state — if the element is on-screen, the only thing that
          // could have paused it is the user tapping the native
          // pause button.
          const v = e.currentTarget
          const rect = v.getBoundingClientRect()
          const onScreen = rect.bottom > 0 && rect.top < window.innerHeight
          if (onScreen) videoUserPausedRef.current = true
        }}
        onPlay={() => { videoUserPausedRef.current = false }}
        onError={onError}
      />
    )
  }

  return (
    <>
      <div className="relative w-full group">
        <video
          ref={videoRef}
          src={url}
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
          className="w-full h-auto max-h-[32rem] block outline-none cursor-pointer"
          onClick={togglePlay}
          onPlay={() => { setIsPlaying(true); videoUserPausedRef.current = false }}
          onPause={(e) => {
            setIsPlaying(false)
            // Mark explicit pauses (anything that happens while the
            // element is on-screen) so the IntersectionObserver
            // resume doesn't fight a deliberate user pause.
            const v = e.currentTarget
            const rect = v.getBoundingClientRect()
            const onScreen = rect.bottom > 0 && rect.top < window.innerHeight
            if (onScreen) videoUserPausedRef.current = true
          }}
          onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
          onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
          onError={onError}
        />
        <div
          className="absolute bottom-0 left-0 right-0 px-3 py-2 bg-gradient-to-t from-black/80 to-transparent opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center gap-2 pointer-events-auto">
            <button onClick={togglePlay} className="text-white hover:opacity-80 shrink-0 cursor-pointer" title={isPlaying ? 'Pause' : 'Play'}>
              {isPlaying ? <HiOutlinePause className="w-7 h-7" /> : <HiOutlinePlay className="w-7 h-7" />}
            </button>
            <button onClick={toggleMute} className="text-white hover:opacity-80 shrink-0 cursor-pointer" title={isMuted ? 'Unmute' : 'Mute'}>
              {isMuted ? <HiOutlineVolumeOff className="w-5 h-5" /> : <HiOutlineVolumeUp className="w-5 h-5" />}
            </button>
            <input
              type="range"
              min={0}
              max={duration || 0}
              value={currentTime}
              step={0.01}
              onChange={seek}
              onClick={(e) => e.stopPropagation()}
              className="flex-1 h-1 accent-yellow-500 cursor-pointer min-w-0"
            />
            <span className="text-[11px] text-white tabular-nums shrink-0">{fmt(currentTime)} / {fmt(duration)}</span>
            <button
              onClick={(e) => { e.stopPropagation(); setShowFullscreen(true) }}
              className="text-white hover:opacity-80 shrink-0 cursor-pointer"
              title="Fullscreen"
            >
              <HiOutlineArrowsExpand className="w-5 h-5" />
            </button>
          </div>
        </div>
      </div>
      {showFullscreen && createPortal(
        <div
          className="fixed inset-0 z-[10000] bg-black/95 flex items-center justify-center p-4"
          onClick={() => setShowFullscreen(false)}
        >
          <button
            onClick={(e) => { e.stopPropagation(); setShowFullscreen(false) }}
            className="absolute top-4 right-4 z-10 p-2 rounded-full bg-black/70 hover:bg-black/90 cursor-pointer"
            title="Close"
          >
            <HiOutlineX className="w-6 h-6 text-white" />
          </button>
          <video
            src={url}
            controls
            autoPlay
            playsInline
            className="max-w-full max-h-full"
            onClick={(e) => e.stopPropagation()}
          />
        </div>,
        document.body
      )}
    </>
  )
}

export default PostVideo
