import React, { useEffect, useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useTheme } from '~/hooks/useTheme'
import { themeTextMuted, themeBorder } from '~/utils/theme'
import { convertToNumber, formatNumberCompact } from '~/utils'
import { apiFetch } from '~/api/client'
import UsernameSvg from '~/components/UsernameSvg'
import { useTokenDataStore } from '~/store/tokenDataStore'

type UserStats = { followerCount: number; cawCount: number; likeCount: number }

type Props = {
  username: string
  /** Pre-fetched stats (skips API call if provided) */
  stats?: UserStats | null
  /** Bottom section (e.g. button, price info) */
  children?: React.ReactNode
}

const ProfileCard: React.FC<Props> = ({ username, stats: externalStats, children }) => {
  const { isDark } = useTheme()
  const [stats, setStats] = useState<UserStats | null>(externalStats ?? null)
  const tokensByAddress = useTokenDataStore(s => s.tokensByAddress)
  const staked = useMemo(() => {
    const token = Object.values(tokensByAddress).flat().find(t => t.username === username)
    return token ? convertToNumber(token.stakedAmount, 18) : 0
  }, [tokensByAddress, username])

  useEffect(() => {
    if (externalStats !== undefined) {
      setStats(externalStats)
      return
    }
    apiFetch<UserStats>(`/api/users/${username}`)
      .then(setStats)
      .catch(() => {})
  }, [username, externalStats])

  return (
    <div className={`rounded-xl border overflow-hidden ${
      isDark ? 'bg-white/5 border-white/10' : 'bg-white border-gray-200'
    }`}>
      <div className={`flex flex-col items-center justify-center pt-4 pb-2 px-4 ${isDark ? 'bg-white/[0.02]' : 'bg-gray-50'}`}>
        <div className="w-full max-w-[200px]">
          <UsernameSvg username={username} />
        </div>
        <Link
          to={`/users/${username}`}
          onClick={e => e.stopPropagation()}
          className={`text-xs mt-2 transition ${isDark ? 'text-gray-500 hover:text-gray-300' : 'text-gray-400 hover:text-gray-600'}`}
        >
          visit profile &rarr;
        </Link>
      </div>
      <div className={`grid grid-cols-2 min-[370px]:max-[520px]:grid-cols-4 gap-3 px-5 py-4 border-t ${themeBorder(isDark)}`}>
        <div className="text-center">
          <div className={`text-lg font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
            {stats ? formatNumberCompact(stats.followerCount) : '—'}
          </div>
          <div className={`text-sm ${themeTextMuted(isDark)}`}>Followers</div>
        </div>
        <div className="text-center">
          <div className={`text-lg font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
            {stats ? formatNumberCompact(stats.cawCount) : '—'}
          </div>
          <div className={`text-sm ${themeTextMuted(isDark)}`}>Posts</div>
        </div>
        <div className="text-center">
          <div className={`text-lg font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
            {stats ? formatNumberCompact(stats.likeCount) : '—'}
          </div>
          <div className={`text-sm ${themeTextMuted(isDark)}`}>Likes</div>
        </div>
        <div className="text-center">
          <div className={`text-lg font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
            {formatNumberCompact(staked, 0, 1)}
          </div>
          <div className={`text-sm ${themeTextMuted(isDark)}`}>CAW</div>
        </div>
      </div>
      {children && (
        <div className={`px-5 pb-3`}>
          {children}
        </div>
      )}
    </div>
  )
}

export default ProfileCard
