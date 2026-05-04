import MainLayout from '~/layouts/MainLayout'
import { useTheme } from '~/hooks/useTheme'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { HiUser, HiBell, HiVolumeOff, HiLightningBolt, HiTranslate } from 'react-icons/hi'
import { useT } from '~/i18n/I18nProvider'

// Settings page component with clean, modern design
export const SettingsPage: React.FC = () => {
  const { isDark } = useTheme()
  const t = useT()
  const [searchQuery, setSearchQuery] = useState('')
  const navigate = useNavigate()

  // Settings menu items in the specified order
  const settingsItems = [
    {
      id: 'account',
      title: t('settings.account.title'),
      description: t('settings.account.description'),
      icon: <HiUser className="w-5 h-5" />,
      hasArrow: true,
      onClick: () => navigate('/settings/account')
    },
    {
      id: 'notifications',
      title: t('settings.notifications.title'),
      description: t('settings.notifications.description'),
      icon: <HiBell className="w-5 h-5" />,
      hasArrow: true,
      onClick: () => navigate('/settings/notifications')
    },
    {
      id: 'language',
      title: t('settings.language.title'),
      description: t('settings.language.description'),
      icon: <HiTranslate className="w-5 h-5" />,
      hasArrow: true,
      onClick: () => navigate('/settings/language')
    },
    {
      id: 'quick-sign',
      title: t('settings.quick_sign.title'),
      description: t('settings.quick_sign.description'),
      icon: <HiLightningBolt className="w-5 h-5" />,
      hasArrow: true,
      onClick: () => navigate('/settings/session-keys')
    },
    {
      id: 'muted-content',
      title: t('settings.muted.title'),
      description: t('settings.muted.description'),
      icon: <HiVolumeOff className="w-5 h-5" />,
      hasArrow: true,
      onClick: () => navigate('/settings/muted')
    }
  ]

  // Filter settings based on search query
  const filteredItems = settingsItems.filter(item =>
    item.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
    item.description.toLowerCase().includes(searchQuery.toLowerCase())
  )

  return (
    <MainLayout>
      <div className={`max-w-2xl mx-auto px-6 py-4 ${isDark ? 'bg-black' : 'bg-white'}`}>
        {/* Settings Header */}
        <div className="mb-6">
          <h1 className={`text-2xl font-bold mb-2 transition-colors duration-300 ${
            isDark ? 'text-white' : 'text-black'
          }`}>
            {t('settings.title')}
          </h1>
        </div>

        {/* Search Bar */}
        <div className="mb-6">
          <div className={`relative rounded-2xl border transition-all duration-300 ${
            isDark
              ? 'bg-black border-gray-600 focus-within:border-gray-400'
              : 'bg-gray-100 border-gray-300 focus-within:border-gray-500 shadow-xl'
          }`}>
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <svg 
                className={`w-5 h-5 transition-colors duration-300 ${
                  isDark ? 'text-gray-400' : 'text-gray-500'
                }`} 
                fill="none" 
                stroke="currentColor" 
                viewBox="0 0 24 24"
              >
                <path 
                  strokeLinecap="round" 
                  strokeLinejoin="round" 
                  strokeWidth={2} 
                  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" 
                />
              </svg>
            </div>
            <input
              type="text"
              placeholder={t('settings.search_placeholder')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className={`w-full pl-10 pr-4 py-3 rounded-2xl border-0 bg-transparent transition-colors duration-300 focus:outline-none focus:ring-0 focus:bg-transparent ${
                isDark 
                  ? 'text-white placeholder-gray-400' 
                  : 'text-black placeholder-gray-500'
              }`}
            />
          </div>
        </div>

        {/* Settings Menu */}
        <div className="space-y-0">
          {filteredItems.map((item, index) => (
            <div
              key={item.id}
              onClick={item.onClick}
              className={`group cursor-pointer py-4 px-4 transition-all duration-200 hover:bg-gray-500/20`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4 flex-1">
                  {/* Icon */}
                  {'icon' in item && item.icon && (
                    <div className={`transition-colors duration-300 ${
                      isDark ? 'text-white/60' : 'text-gray-500'
                    }`}>
                      {item.icon}
                    </div>
                  )}
                  <div>
                    <h3 className={`font-normal text-base transition-colors duration-300 ${
                      isDark ? 'text-white' : 'text-black'
                    }`}>
                      {item.title}
                    </h3>
                    <p className={`text-sm transition-colors duration-300 ${
                      isDark ? 'text-white/50' : 'text-gray-500'
                    }`}>
                      {item.description}
                    </p>
                  </div>
                </div>

                {/* Arrow icon */}
                {item.hasArrow && (
                  <div className={`ml-4 transition-colors duration-300 ${
                    isDark ? 'text-gray-400' : 'text-gray-500'
                  }`}>
                    <svg
                      className="w-4 h-4"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M9 5l7 7-7 7"
                      />
                    </svg>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* No results message */}
        {filteredItems.length === 0 && searchQuery && (
          <div className={`text-center py-8 transition-colors duration-300 ${
            isDark ? 'text-gray-400' : 'text-gray-600'
          }`}>
            <p>{t('settings.no_results', { query: searchQuery })}</p>
          </div>
        )}
      </div>
    </MainLayout>
  )
}
