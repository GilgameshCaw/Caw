import React, { useState } from 'react'
import { useNavigate } from '~/utils/localizedRouter'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'
import { themeText, themeTextSecondary, themeSecondaryButton } from '~/utils/theme'
import { useAIProviderStore } from '~/store/aiProviderStore'
import { HiArrowLeft } from 'react-icons/hi'

const AIProviderSettings: React.FC = () => {
  const { isDark } = useTheme()
  const t = useT()
  const navigate = useNavigate()
  const { provider, apiKey, remembered, connect, disconnect } = useAIProviderStore()

  const [key, setKey] = useState(apiKey ?? '')
  const [remember, setRemember] = useState(remembered)
  const [saved, setSaved] = useState(false)

  const connected = !!apiKey && !!provider

  const onSave = () => {
    const trimmed = key.trim()
    if (!trimmed) return
    connect('gemini', trimmed, remember)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <div className="max-w-2xl mx-auto px-6 py-4">
      <div className="flex items-center gap-3 mb-6">
        <button
          onClick={() => navigate('/settings')}
          className={`p-2 rounded-full ${themeSecondaryButton(isDark)}`}
          aria-label={t('common.back')}
        >
          <HiArrowLeft className="w-5 h-5" />
        </button>
        <h1 className={`text-xl font-bold ${themeText(isDark)}`}>
          {t('settings.ai_provider.title')}
        </h1>
      </div>

      <p className={`text-sm mb-6 ${themeTextSecondary(isDark)}`}>
        {t('settings.ai_provider.description')}
      </p>

      <label className={`block text-sm font-medium mb-1 ${themeText(isDark)}`}>
        {t('settings.ai_provider.provider_label')}
      </label>
      <div className={`mb-4 px-3 py-2 rounded-lg border text-sm ${
        isDark ? 'border-white/15 bg-white/5 text-white' : 'border-gray-300 bg-gray-50 text-black'
      }`}>
        Google Gemini
      </div>

      <label className={`block text-sm font-medium mb-1 ${themeText(isDark)}`}>
        {t('settings.ai_provider.key_label')}
      </label>
      <input
        type="password"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        placeholder="AI..."
        autoComplete="off"
        className={`w-full mb-2 px-3 py-2 rounded-lg border text-sm focus:outline-none focus:ring-2 focus:ring-yellow-500/40 ${
          isDark ? 'border-white/15 bg-black text-white' : 'border-gray-300 bg-white text-black'
        }`}
      />
      <a
        href="https://aistudio.google.com/apikey"
        target="_blank"
        rel="noopener noreferrer"
        className="text-xs text-yellow-500 hover:underline"
      >
        {t('settings.ai_provider.get_key')}
      </a>

      <label className={`flex items-start gap-2 mt-5 mb-1 cursor-pointer ${themeText(isDark)}`}>
        <input
          type="checkbox"
          checked={remember}
          onChange={(e) => setRemember(e.target.checked)}
          className="mt-0.5"
        />
        <span className="text-sm">{t('settings.ai_provider.remember')}</span>
      </label>
      <p className={`text-xs mb-6 ${themeTextSecondary(isDark)}`}>
        {t('settings.ai_provider.remember_warning')}
      </p>

      <div className="flex items-center gap-3">
        <button
          onClick={onSave}
          disabled={!key.trim()}
          className="px-4 py-2 rounded-lg text-sm font-medium bg-yellow-500 text-black hover:bg-yellow-400 disabled:opacity-50 cursor-pointer"
        >
          {saved ? t('settings.ai_provider.saved') : t('settings.ai_provider.save')}
        </button>
        {connected && (
          <button
            onClick={() => { disconnect(); setKey('') }}
            className={`px-4 py-2 rounded-lg text-sm ${themeSecondaryButton(isDark)}`}
          >
            {t('settings.ai_provider.disconnect')}
          </button>
        )}
      </div>
    </div>
  )
}

export default AIProviderSettings
