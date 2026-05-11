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

  const fmt = (s: number) => {
    if (!isFinite(s)) return '0:00'
    const m = Math.floor(s / 60)
    const sec = Math.floor(s % 60)
    return `${m}:${sec.toString().padStart(2, '0')}`
  }
  const togglePlay = (e: React.MouseEvent) => {
    e.stopPropagation()
    const v = videoRef.current; if (!v) return
    if (v.paused) v.play(); else v.pause()
  }
  const toggleMute = (e: React.MouseEvent) => {
    e.stopPropagation()
    const v = videoRef.current; if (!v) return
    v.muted = !v.muted; setIsMuted(v.muted)
  }
  const seek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = videoRef.current; if (!v) return
    v.currentTime = Number(e.target.value)
  }

  if (!isDesktop) {
    return (
      <video
        src={url}
        autoPlay
        controls
        className="w-full h-auto max-h-[32rem] block outline-none"
        loop
        muted
        playsInline
        preload="metadata"
        onClick={(e) => e.stopPropagation()}
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
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
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
