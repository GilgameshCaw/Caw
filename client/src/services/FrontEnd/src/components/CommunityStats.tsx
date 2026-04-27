import React from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTheme } from '~/hooks/useTheme'

interface StatsData {
  totalUsers: number
  totalPosts: number
  postsToday: number
  newMembersThisWeek: number
  activeUsersThisWeek: number
}

const formatNumber = (num: number): string => {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1).replace(/\.0$/, '') + 'M'
  }
  if (num >= 1000) {
    return (num / 1000).toFixed(1).replace(/\.0$/, '') + 'K'
  }
  return num.toString()
}

const CommunityStats: React.FC = () => {
  const { isDark } = useTheme()

  const { data: stats, isLoading } = useQuery<StatsData>({
    queryKey: ['communityStats'],
    queryFn: async () => {
      const res = await fetch('/api/stats')
      if (!res.ok) throw new Error('Failed to fetch stats')
      return res.json()
    },
    staleTime: 60 * 1000, // Cache for 1 minute
    refetchInterval: 60 * 1000 // Refresh every minute
  })

  const statItems = [
    {
      label: 'Active Users',
      value: stats?.activeUsersThisWeek ?? 0,
      icon: (
        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
        </svg>
      )
    },
    {
      label: 'Posts Today',
      value: stats?.postsToday ?? 0,
      icon: (
        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
      )
    },
    {
      label: 'New Members',
      value: stats?.newMembersThisWeek ?? 0,
      icon: (
        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" />
        </svg>
      )
    },
    {
      label: 'Total Posts',
      value: stats?.totalPosts ?? 0,
      icon: (
        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
        </svg>
      )
    }
  ]

  return (
    <div className="grid grid-cols-2 gap-4 mb-6 m-4">
      {statItems.map((stat, index) => (
        <div
          key={index}
          className={`p-4 rounded-lg border transition-all duration-300 ${
            isDark
              ? 'bg-white/5 border-white/10 hover:bg-white/10'
              : 'bg-white border-gray-200 hover:bg-gray-50'
          }`}
        >
          <div className="flex items-center space-x-3">
            <div className={`transition-colors duration-300 ${
              isDark ? 'text-white' : 'text-black'
            }`}>
              {stat.icon}
            </div>
            <div>
              <div className={`text-2xl font-bold transition-colors duration-300 ${
                isDark ? 'text-white' : 'text-black'
              }`}>
                {isLoading ? (
                  <div className={`h-8 w-16 rounded animate-pulse ${
                    isDark ? 'bg-white/10' : 'bg-gray-200'
                  }`} />
                ) : (
                  formatNumber(stat.value)
                )}
              </div>
              <div className={`text-sm transition-colors duration-300 ${
                isDark ? 'text-gray-400' : 'text-gray-600'
              }`}>
                {stat.label}
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

export default CommunityStats
