import React, { useEffect } from 'react'
import { Link, useNavigate } from '~/utils/localizedRouter'
import { useTheme } from '~/hooks/useTheme'
import { useMyRole } from '~/hooks/useMyRole'

// Moderator-tier dashboard. Mirrors /admin's card-grid look but only
// surfaces the pages we've opened to moderators (currently: bug reports
// and content reports). Admins land here too via /moderation, but we
// bounce them to /admin since they have access to the full surface.
//
// Keep this list in sync with the moderator routes in routes.tsx
// (anything wrapped in <ModeratorGate>) and with the admin equivalents
// in pages/Admin.tsx so cards stay visually consistent across tiers.
const moderatorPages = [
  {
    path: '/moderation/bugs',
    title: 'Bug Reports',
    description: 'Review and manage user-submitted bug reports',
    color: 'from-yellow-500/20 to-yellow-600/10',
    iconColor: 'text-yellow-400',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-6 h-6">
        <path d="M8 2l1.88 1.88M14.12 3.88L16 2M9 7.13v-1a3.003 3.003 0 116 0v1" />
        <path d="M12 20c-3.3 0-6-2.7-6-6v-3a6 6 0 0112 0v3c0 3.3-2.7 6-6 6z" />
        <path d="M12 20v2M6 13H2M22 13h-4M6 17H3.5M20.5 17H18M6 9H4M20 9h-2" />
      </svg>
    ),
  },
  {
    path: '/moderation/reports',
    title: 'Content Reports',
    description: 'Review flagged posts and user reports',
    color: 'from-red-500/20 to-red-600/10',
    iconColor: 'text-red-400',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-6 h-6">
        <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
        <line x1="4" y1="22" x2="4" y2="15" />
      </svg>
    ),
  },
]

const Moderation: React.FC = () => {
  const { isDark } = useTheme()
  const navigate = useNavigate()
  const { isAdmin, loaded } = useMyRole()

  // Admins get the full /admin dashboard — no point showing them the
  // moderator subset. Wait for role to load so we don't bounce a
  // moderator who briefly looks like USER during the role fetch.
  useEffect(() => {
    if (loaded && isAdmin) navigate('/admin', { replace: true })
  }, [loaded, isAdmin, navigate])

  const bg = isDark ? 'bg-black' : 'bg-gray-50'
  const card = isDark ? 'bg-gray-950 border-white/10' : 'bg-white border-gray-200'
  const text = isDark ? 'text-white' : 'text-gray-900'
  const muted = isDark ? 'text-white/50' : 'text-gray-500'
  const hover = isDark ? 'hover:bg-white/5 hover:border-white/20' : 'hover:bg-gray-50 hover:border-gray-300'

  return (
    <div className={`min-h-screen ${bg} p-6`}>
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className={`text-2xl font-bold ${text}`}>Moderation</h1>
          <Link to="/settings" className={`text-sm ${muted} hover:underline`}>Back to settings</Link>
        </div>

        <div className="grid gap-3">
          {moderatorPages.map(page => (
            <Link
              key={page.path}
              to={page.path}
              className={`block p-5 rounded-xl border transition-all ${card} ${hover}`}
            >
              <div className="flex items-center gap-4">
                <div className={`w-11 h-11 rounded-xl flex items-center justify-center bg-gradient-to-br ${page.color} ${page.iconColor}`}>
                  {page.icon}
                </div>
                <div>
                  <div className={`font-semibold ${text}`}>{page.title}</div>
                  <div className={`text-sm ${muted}`}>{page.description}</div>
                </div>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  )
}

export default Moderation
