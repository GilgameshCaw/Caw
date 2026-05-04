import React, { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import MainLayout from '~/layouts/MainLayout'
import { useTheme } from '~/hooks/useTheme'
import { HiArrowLeft, HiTranslate } from 'react-icons/hi'
import { LANGUAGES } from '~/constants/languages'
import { apiFetch } from '~/api/client'
import { useUserByToken } from '~/hooks/useUserData'
import { useActiveToken } from '~/store/tokenDataStore'

const LanguageSettings: React.FC = () => {
  const { isDark } = useTheme()
  const activeToken = useActiveToken()
  const tokenId = activeToken?.tokenId
  const { data: user, refetch } = useUserByToken(tokenId)
  const queryClient = useQueryClient()

  // Local mirror so the controls feel snappy. We write through to the API
  // on every change but render from this state until the refetch lands.
  const [preferredLanguage, setPreferredLanguage] = useState<string>('')
  const [autoTranslate, setAutoTranslate] = useState<boolean>(false)

  useEffect(() => {
    if (!user) return
    setPreferredLanguage(user.preferredLanguage ?? '')
    setAutoTranslate(!!user.autoTranslate)
  }, [user?.preferredLanguage, user?.autoTranslate])

  const persist = async (patch: { preferredLanguage?: string | null; autoTranslate?: boolean }) => {
    if (!tokenId) return
    try {
      await apiFetch(`/api/users/${tokenId}/language`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      })
      // Bust the userByToken cache so any FeedItems mounted right now
      // see the new prefs without a full reload.
      queryClient.invalidateQueries({ queryKey: ['userByToken', tokenId] })
      refetch()
    } catch (e) {
      console.error('Failed to update language preferences:', e)
    }
  }

  const onLanguageChange = (code: string) => {
    setPreferredLanguage(code)
    void persist({ preferredLanguage: code === '' ? null : code })
  }

  const onAutoTranslateChange = (checked: boolean) => {
    setAutoTranslate(checked)
    void persist({ autoTranslate: checked })
  }

  const Toggle: React.FC<{ checked: boolean; onChange: (checked: boolean) => void }> = ({ checked, onChange }) => (
    <button
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
        checked ? 'bg-yellow-500' : isDark ? 'bg-white/20' : 'bg-gray-300'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
          checked ? 'translate-x-6' : 'translate-x-1'
        }`}
      />
    </button>
  )

  return (
    <MainLayout>
      <div className="max-w-2xl mx-auto px-6 py-4">
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
              Language
            </h1>
            <p className={`text-sm ${isDark ? 'text-white/60' : 'text-gray-600'}`}>
              Choose your language and how foreign-language posts behave
            </p>
          </div>
        </div>

        <section className="mb-8">
          <h2 className={`text-sm font-semibold mb-2 uppercase tracking-wide ${
            isDark ? 'text-white/40' : 'text-gray-400'
          }`}>
            Display language
          </h2>

          <div className={`py-4 border-b ${isDark ? 'border-white/10' : 'border-gray-100'}`}>
            <div className="flex items-start gap-3">
              <div className={`mt-0.5 ${isDark ? 'text-white/60' : 'text-gray-500'}`}>
                <HiTranslate className="w-5 h-5" />
              </div>
              <div className="flex-1">
                <h3 className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>
                  Your language
                </h3>
                <p className={`text-sm mb-3 ${isDark ? 'text-white/50' : 'text-gray-500'}`}>
                  Posts in other languages can be translated automatically below.
                </p>
                <select
                  value={preferredLanguage}
                  onChange={(e) => onLanguageChange(e.target.value)}
                  className={`w-full max-w-xs px-3 py-2 rounded-lg border transition-colors cursor-pointer ${
                    isDark
                      ? 'bg-black border-white/20 text-white hover:border-white/40'
                      : 'bg-white border-gray-300 text-gray-900 hover:border-gray-500'
                  }`}
                >
                  <option value="">Use browser language</option>
                  {LANGUAGES.map(l => (
                    <option key={l.code} value={l.code}>
                      {l.name}{l.name !== l.native ? ` (${l.native})` : ''}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>
        </section>

        <section className="mb-8">
          <h2 className={`text-sm font-semibold mb-2 uppercase tracking-wide ${
            isDark ? 'text-white/40' : 'text-gray-400'
          }`}>
            Translation
          </h2>

          <div className={`flex items-center justify-between py-4 border-b ${
            isDark ? 'border-white/10' : 'border-gray-100'
          }`}>
            <div className="flex items-start gap-3 flex-1">
              <div className={`mt-0.5 ${isDark ? 'text-white/60' : 'text-gray-500'}`}>
                <HiTranslate className="w-5 h-5" />
              </div>
              <div className="flex-1">
                <h3 className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>
                  Auto-translate posts
                </h3>
                <p className={`text-sm ${isDark ? 'text-white/50' : 'text-gray-500'}`}>
                  When on, posts in another language are translated for you automatically.
                  When off, you'll see a "Translate" button on those posts instead.
                </p>
              </div>
            </div>
            <Toggle checked={autoTranslate} onChange={onAutoTranslateChange} />
          </div>
        </section>

        <div className={`mt-6 px-4 py-3 rounded-lg text-xs ${
          isDark ? 'bg-white/5 text-white/50' : 'bg-gray-50 text-gray-500'
        }`}>
          Translations are powered by Google Translate. Translating a post sends its
          text to Google's servers; we don't keep a copy.
        </div>
      </div>
    </MainLayout>
  )
}

export default LanguageSettings
