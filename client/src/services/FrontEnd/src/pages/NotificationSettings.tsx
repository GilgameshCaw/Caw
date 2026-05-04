import React, { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import MainLayout from '~/layouts/MainLayout'
import { useTheme } from '~/hooks/useTheme'
import { HiArrowLeft, HiBell, HiHeart, HiChat, HiUserAdd, HiAtSymbol, HiVolumeOff } from 'react-icons/hi'
import { useT } from '~/i18n/I18nProvider'

interface NotificationPreferences {
  likes: boolean
  replies: boolean
  reposts: boolean
  quotes: boolean
  follows: boolean
  mentions: boolean
  groupSimilar: boolean
}

const STORAGE_KEY = 'notificationPreferences'

const defaultPreferences: NotificationPreferences = {
  likes: true,
  replies: true,
  reposts: true,
  quotes: true,
  follows: true,
  mentions: true,
  groupSimilar: true,
}

const NotificationSettings: React.FC = () => {
  const { isDark } = useTheme()
  const t = useT()
  const [preferences, setPreferences] = useState<NotificationPreferences>(defaultPreferences)

  // Load preferences from localStorage
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored) {
        setPreferences({ ...defaultPreferences, ...JSON.parse(stored) })
      }
    } catch {
      // Use defaults
    }
  }, [])

  // Save preferences to localStorage
  const updatePreference = (key: keyof NotificationPreferences, value: boolean) => {
    const updated = { ...preferences, [key]: value }
    setPreferences(updated)
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(updated))
    } catch (e) {
      console.error('Failed to save notification preferences:', e)
    }
  }

  const Toggle: React.FC<{ checked: boolean; onChange: (checked: boolean) => void }> = ({ checked, onChange }) => (
    <button
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
        checked
          ? 'bg-yellow-500'
          : isDark ? 'bg-white/20' : 'bg-gray-300'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
          checked ? 'translate-x-6' : 'translate-x-1'
        }`}
      />
    </button>
  )

  const SettingRow: React.FC<{
    icon: React.ReactNode
    title: string
    description: string
    checked: boolean
    onChange: (checked: boolean) => void
  }> = ({ icon, title, description, checked, onChange }) => (
    <div className={`flex items-center justify-between py-4 border-b ${
      isDark ? 'border-white/10' : 'border-gray-100'
    }`}>
      <div className="flex items-start gap-3 flex-1">
        <div className={`mt-0.5 ${isDark ? 'text-white/60' : 'text-gray-500'}`}>
          {icon}
        </div>
        <div className="flex-1">
          <h3 className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>
            {title}
          </h3>
          <p className={`text-sm ${isDark ? 'text-white/50' : 'text-gray-500'}`}>
            {description}
          </p>
        </div>
      </div>
      <Toggle checked={checked} onChange={onChange} />
    </div>
  )

  return (
    <MainLayout>
      <div className="max-w-2xl mx-auto px-6 py-4">
        {/* Header */}
        <div className="flex items-center gap-4 mb-6">
          <Link
            to="/settings"
            className={`p-2 rounded-full transition-colors cursor-pointer ${
              isDark ? 'hover:bg-white/10' : 'hover:bg-gray-100'
            }`}
          >
            <HiArrowLeft className="w-5 h-5" />
          </Link>
          <div>
            <h1 className={`text-2xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
              {t('notifications_settings.title')}
            </h1>
            <p className={`text-sm ${isDark ? 'text-white/60' : 'text-gray-600'}`}>
              {t('notifications_settings.subtitle')}
            </p>
          </div>
        </div>

        {/* Browser-specific notice */}
        <div className={`mb-6 px-4 py-3 rounded-lg text-sm ${
          isDark ? 'bg-white/5 text-white/60' : 'bg-gray-50 text-gray-600'
        }`}>
          {t('notifications_settings.local_storage_notice')}
        </div>

        {/* Activity Section */}
        <section className="mb-8">
          <h2 className={`text-sm font-semibold mb-2 uppercase tracking-wide ${
            isDark ? 'text-white/40' : 'text-gray-400'
          }`}>
            {t('notifications_settings.section.activity')}
          </h2>

          <SettingRow
            icon={<HiHeart className="w-5 h-5" />}
            title={t('notifications_settings.likes.title')}
            description={t('notifications_settings.likes.description')}
            checked={preferences.likes}
            onChange={(v) => updatePreference('likes', v)}
          />

          <SettingRow
            icon={<HiChat className="w-5 h-5" />}
            title={t('notifications_settings.replies.title')}
            description={t('notifications_settings.replies.description')}
            checked={preferences.replies}
            onChange={(v) => updatePreference('replies', v)}
          />

          <SettingRow
            icon={<HiBell className="w-5 h-5" />}
            title={t('notifications_settings.reposts.title')}
            description={t('notifications_settings.reposts.description')}
            checked={preferences.reposts}
            onChange={(v) => updatePreference('reposts', v)}
          />

          <SettingRow
            icon={<HiChat className="w-5 h-5" />}
            title={t('notifications_settings.quotes.title')}
            description={t('notifications_settings.quotes.description')}
            checked={preferences.quotes}
            onChange={(v) => updatePreference('quotes', v)}
          />
        </section>

        {/* People Section */}
        <section className="mb-8">
          <h2 className={`text-sm font-semibold mb-2 uppercase tracking-wide ${
            isDark ? 'text-white/40' : 'text-gray-400'
          }`}>
            {t('notifications_settings.section.people')}
          </h2>

          <SettingRow
            icon={<HiUserAdd className="w-5 h-5" />}
            title={t('notifications_settings.follows.title')}
            description={t('notifications_settings.follows.description')}
            checked={preferences.follows}
            onChange={(v) => updatePreference('follows', v)}
          />

          <SettingRow
            icon={<HiAtSymbol className="w-5 h-5" />}
            title={t('notifications_settings.mentions.title')}
            description={t('notifications_settings.mentions.description')}
            checked={preferences.mentions}
            onChange={(v) => updatePreference('mentions', v)}
          />
        </section>

        {/* Display Section */}
        <section className="mb-8">
          <h2 className={`text-sm font-semibold mb-2 uppercase tracking-wide ${
            isDark ? 'text-white/40' : 'text-gray-400'
          }`}>
            {t('notifications_settings.section.display')}
          </h2>

          <SettingRow
            icon={<HiVolumeOff className="w-5 h-5" />}
            title={t('notifications_settings.group_similar.title')}
            description={t('notifications_settings.group_similar.description')}
            checked={preferences.groupSimilar}
            onChange={(v) => updatePreference('groupSimilar', v)}
          />
        </section>

        {/* Muted Content Link */}
        <Link
          to="/settings/muted"
          className={`flex items-center justify-between py-4 px-4 rounded-lg transition-colors ${
            isDark ? 'bg-white/5 hover:bg-white/10' : 'bg-gray-50 hover:bg-gray-100'
          }`}
        >
          <div>
            <h3 className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>
              {t('settings.muted.title')}
            </h3>
            <p className={`text-sm ${isDark ? 'text-white/50' : 'text-gray-500'}`}>
              {t('settings.muted.description')}
            </p>
          </div>
          <svg
            className={`w-5 h-5 ${isDark ? 'text-white/40' : 'text-gray-400'}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </Link>
      </div>
    </MainLayout>
  )
}

export default NotificationSettings
