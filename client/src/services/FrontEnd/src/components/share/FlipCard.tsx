import React, { useMemo, useState } from 'react'

type FlipCardSize = {
  width?: string
  height?: string
  aspectRatio?: string
}

export type FlipCardProps = {
  front: React.ReactNode
  back: React.ReactNode
  className?: string
  size?: FlipCardSize
  /** If true, tapping/clicking toggles flip. Keeps hover flip too. */
  flipOnClick?: boolean
}

/**
 * 3D flip card.
 * - Desktop: flips on hover.
 * - Mobile: flips on tap (optional via flipOnClick).
 */
export const FlipCard: React.FC<FlipCardProps> = ({
  front,
  back,
  className,
  size,
  flipOnClick = true
}) => {
  const [flipped, setFlipped] = useState(false)

  const outerStyle = useMemo<React.CSSProperties>(() => {
    const width = size?.width ?? 'clamp(220px, 70vw, 340px)'
    const aspectRatio = size?.aspectRatio ?? '190 / 254'
    const height = size?.height

    return {
      perspective: 1000,
      width,
      ...(height ? { height } : { aspectRatio })
    }
  }, [size?.aspectRatio, size?.height, size?.width])

  const innerStyle = useMemo<React.CSSProperties>(() => {
    return {
      transformStyle: 'preserve-3d',
      transition: 'transform 800ms',
      transform: flipped ? 'rotateY(180deg)' : 'rotateY(0deg)'
    }
  }, [flipped])

  const faceStyle = useMemo<React.CSSProperties>(() => {
    return {
      backfaceVisibility: 'hidden',
      WebkitBackfaceVisibility: 'hidden'
    }
  }, [])

  return (
    <div
      className={['flip-card group bg-transparent', className].filter(Boolean).join(' ')}
      style={outerStyle}
      onClick={() => {
        if (!flipOnClick) return
        setFlipped(v => !v)
      }}
      role={flipOnClick ? 'button' : undefined}
      tabIndex={flipOnClick ? 0 : undefined}
      onKeyDown={(e) => {
        if (!flipOnClick) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          setFlipped(v => !v)
        }
      }}
      aria-label={flipOnClick ? 'Flip card' : undefined}
    >
      <div
        className="relative h-full w-full text-center"
        style={innerStyle}
      >
        <div
          className="absolute inset-0 flex flex-col items-center justify-center rounded-2xl"
          style={faceStyle}
        >
          {front}
        </div>
        <div
          className="absolute inset-0 flex flex-col items-center justify-center rounded-2xl"
          style={{
            ...faceStyle,
            transform: 'rotateY(180deg)'
          }}
        >
          {back}
        </div>
      </div>

      {/* Desktop hover behavior */}
      <style>{`
        @media (hover: hover) and (pointer: fine) {
          .flip-card {
            cursor: pointer;
          }
          .group:hover > div {
            transform: rotateY(180deg) !important;
          }
        }
      `}</style>
    </div>
  )
}
