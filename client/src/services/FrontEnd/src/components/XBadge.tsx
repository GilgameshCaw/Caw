import React from 'react'
import { HiCheckCircle } from 'react-icons/hi'
import Tooltip from '~/components/Tooltip'

interface XBadgeProps {
  xHandle?: string | null
  xFollowerBucket?: number | null
  className?: string
  size?: 'sm' | 'md'
}

/**
 * Render the bucketed follower count as a short label. Buckets are stored as
 * the lower bound of the range the user falls into, so "25000" → "25k+".
 * Returns null below the smallest bucket so we don't visually "verify" tiny
 * accounts; the linked-handle tooltip itself is enough at that scale.
 */
export function formatFollowerBucket(bucket: number | null | undefined): string | null {
  if (!bucket || bucket < 1000) return null
  if (bucket >= 1_000_000) {
    const m = bucket / 1_000_000
    const s = m % 1 === 0 ? m.toFixed(0) : m.toFixed(1)
    return `${s}M+`
  }
  return `${Math.round(bucket / 1000)}k+`
}

/**
 * Small ✓ shown next to a verified profile's displayName. Renders nothing
 * when xHandle is empty so callers can drop it in unconditionally.
 */
const XBadge: React.FC<XBadgeProps> = ({ xHandle, xFollowerBucket, className = '', size = 'sm' }) => {
  if (!xHandle) return null

  const followers = formatFollowerBucket(xFollowerBucket)
  const tooltip = followers
    ? `Linked to @${xHandle} on X — ${followers} followers`
    : `Linked to @${xHandle} on X`

  const iconClass = size === 'md' ? 'w-5 h-5' : 'w-4 h-4'

  return (
    <Tooltip text={tooltip}>
      <span
        className={`inline-flex items-center text-yellow-500 ${className}`}
        aria-label={tooltip}
      >
        <HiCheckCircle className={iconClass} />
      </span>
    </Tooltip>
  )
}

export default XBadge
