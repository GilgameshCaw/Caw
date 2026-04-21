import React from 'react'
import { useTheme } from '~/hooks/useTheme'

interface SkeletonProps {
  className?: string
}

/** Theme-aware pulsing placeholder block */
const Skeleton: React.FC<SkeletonProps> = ({ className = 'h-32 rounded-lg' }) => {
  const { isDark } = useTheme()
  return (
    <div className={`animate-pulse ${isDark ? 'bg-gray-800' : 'bg-gray-200'} ${className}`} />
  )
}

/** Simple centered spinner for loading states */
export const LoadingSpinner: React.FC<{ className?: string }> = ({ className = 'py-12' }) => {
  const { isDark } = useTheme()
  return (
    <div className={`flex justify-center ${className}`}>
      <svg className={`animate-spin h-8 w-8 ${isDark ? 'text-yellow-500' : 'text-yellow-600'}`} fill="none" viewBox="0 0 24 24">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
      </svg>
    </div>
  )
}

/** Multiple skeleton rows for feed-style loading */
export const FeedSkeleton: React.FC<{ count?: number }> = ({ count = 3 }) => (
  <div className="space-y-4 mt-4">
    {[...Array(count)].map((_, i) => (
      <Skeleton key={i} className="h-32 rounded-lg" />
    ))}
  </div>
)

export default Skeleton
