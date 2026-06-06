import React, { useState, useEffect, useCallback } from 'react'
import { Link } from '~/utils/localizedRouter'
import { useTheme } from '~/hooks/useTheme'
import { HiArrowLeft, HiBell, HiHeart, HiChat, HiUserAdd, HiAtSymbol, HiVolumeOff, HiCurrencyDollar } from 'react-icons/hi'
import { useT } from '~/i18n/I18nProvider'
import { useActiveToken } from '~/store/tokenDataStore'
import { apiFetch } from '~/api/client'

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
  const activeToken = useActiveToken()
  const myTokenId = activeToken?.tokenId

  // Mention tip floor state
  const [tipFloor, setTipFloor] = useState<number>(0)
  const [tipFloorInput, setTipFloorInput] = useState<string>('0')
  const [tipFloorLoading, setTipFloorLoading] = useState(false)
  const [tipFloorSaving, setTipFloorSaving] = useState(false)
  const [tipFloorSaved, setTipFloorSaved] = useState(false)
  const [tipFloorError, setTipFloorError] = useState<string | null>(null)

  // Load tip floor from server
  useEffect(() => {
    if (!myTokenId) return
    setTipFloorLoading(true)
    apiFetch<{ notificationTipRequired?: number }>(`/api/users/by-token/${myTokenId}`)
      .then(data => {
        const v = data?.notificationTipRequired ?? 0
        setTipFloor(v)
        setTipFloorInput(String(v))
      })
      .catch(() => {})
      .finally(() => setTipFloorLoading(false))
  }, [myTokenId])

  const saveTipFloor = useCallback(async () => {
    if (!myTokenId) return
    const parsed = parseInt(tipFloorInput, 10)
    if (isNaN(parsed) || parsed < 0 || parsed > 1_000_000) return
    setTipFloorSaving(true)
    setTipFloorError(null)
    try {
      await apiFetch(`/api/users/${myTokenId}/notification-tip-gate`, {
        method: 'PATCH',
        body: JSON.stringify({ notificationTipRequired: parsed }),
      })
      setTipFloor(parsed)
      setTipFloorSaved(true)
      setTimeout(() => setTipFloorSaved(false), 2000)
    } catch (e: unknown) {
      setTipFloorError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setTipFloorSaving(false)
    }
  }, [myTokenId, tipFloorInput])

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
      <div className="max-w-2xl mx-auto px-3 sm:px-6 py-4">
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

        {/* Mention Tip Floor Section */}
        {myTokenId && (
          <section className="mb-8">
            <h2 className={`text-sm font-semibold mb-2 uppercase tracking-wide ${
              isDark ? 'text-white/40' : 'text-gray-400'
            }`}>
              {t('notifications_settings.section.tip_gate', { defaultValue: 'Mention tip floor' })}
            </h2>

            <div className={`rounded-xl border p-4 space-y-3 ${
              isDark ? 'border-white/10 bg-white/5' : 'border-gray-100 bg-gray-50'
            }`}>
              <div className="flex items-start gap-3">
                <div className={`mt-0.5 ${isDark ? 'text-white/60' : 'text-gray-500'}`}>
                  <HiCurrencyDollar className="w-5 h-5" />
                </div>
                <div className="flex-1">
                  <h3 className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>
                    {t('notifications_settings.tip_floor.title', { defaultValue: 'Require a tip to notify you' })}
                  </h3>
                  <p className={`text-sm mt-0.5 ${isDark ? 'text-white/50' : 'text-gray-500'}`}>
                    {tipFloor === 0
                      ? t('notifications_settings.tip_floor.disabled_hint', { defaultValue: 'Disabled — you receive all @mention notifications. Set a value above 0 to require a minimum CAW tip.' })
                      : t('notifications_settings.tip_floor.enabled_hint', { defaultValue: `You only receive @mention notifications when the post tips you at least ${tipFloor.toLocaleString()} CAW. Set to 0 to disable.` })}
                  </p>
                </div>
              </div>

              {tipFloorLoading ? (
                <div className={`text-sm ${isDark ? 'text-white/40' : 'text-gray-400'}`}>
                  {t('notifications_settings.tip_floor.loading', { defaultValue: 'Loading…' })}
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={0}
                    max={1_000_000}
                    step={1}
                    value={tipFloorInput}
                    onChange={e => {
                      setTipFloorInput(e.target.value)
                      setTipFloorSaved(false)
                      setTipFloorError(null)
                    }}
                    className={`w-36 px-3 py-1.5 rounded-lg text-sm outline-none transition-colors ${
                      isDark
                        ? 'bg-white/10 text-white border border-white/20 focus:border-yellow-500/50 placeholder-gray-500'
                        : 'bg-white text-gray-900 border border-gray-200 focus:border-yellow-500 placeholder-gray-400'
                    }`}
                  />
                  <span className={`text-sm ${isDark ? 'text-white/50' : 'text-gray-500'}`}>
                    {t('notifications_settings.tip_floor.unit', { defaultValue: 'CAW' })}
                  </span>
                  <button
                    type="button"
                    onClick={saveTipFloor}
                    disabled={tipFloorSaving}
                    className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors cursor-pointer ${
                      tipFloorSaved
                        ? (isDark ? 'bg-green-500/20 text-green-400' : 'bg-green-100 text-green-700')
                        : tipFloorSaving
                          ? 'opacity-50 bg-yellow-500 text-black cursor-not-allowed'
                          : 'bg-yellow-500 text-black hover:bg-yellow-400'
                    }`}
                  >
                    {tipFloorSaved
                      ? t('notifications_settings.tip_floor.saved', { defaultValue: 'Saved' })
                      : tipFloorSaving
                        ? t('notifications_settings.tip_floor.saving', { defaultValue: 'Saving…' })
                        : t('notifications_settings.tip_floor.save', { defaultValue: 'Save' })}
                  </button>
                </div>
              )}

              {tipFloorError && (
                <p className="text-sm text-red-500">{tipFloorError}</p>
              )}
            </div>
          </section>
        )}

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
  )
}

export default NotificationSettings
