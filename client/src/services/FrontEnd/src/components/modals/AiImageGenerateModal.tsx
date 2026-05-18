import React, { useState, useEffect } from 'react'
import ModalWrapper from './ModalWrapper'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'
import { themeText, themeTextSecondary, themeSecondaryButton } from '~/utils/theme'
import { useAIProviderStore } from '~/store/aiProviderStore'
import { generateAIImage, AIImageError } from '~/utils/aiImage'

interface Props {
  isOpen: boolean
  onClose: () => void
  /** Hands the generated image to the composer as an attachment. */
  onImage: (file: File) => void
}

const AiImageGenerateModal: React.FC<Props> = ({ isOpen, onClose, onImage }) => {
  const { isDark } = useTheme()
  const t = useT()
  const { provider, apiKey } = useAIProviderStore()

  const [prompt, setPrompt] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ blob: Blob; url: string; mime: string } | null>(null)

  // Revoke the object URL when it's replaced or the modal unmounts.
  useEffect(() => {
    return () => { if (result) URL.revokeObjectURL(result.url) }
  }, [result])

  useEffect(() => {
    if (!isOpen) {
      setPrompt(''); setError(null); setLoading(false)
      setResult((r) => { if (r) URL.revokeObjectURL(r.url); return null })
    }
  }, [isOpen])

  const generate = async () => {
    if (!prompt.trim() || !provider || !apiKey) return
    setLoading(true); setError(null)
    try {
      const { blob, mimeType } = await generateAIImage(provider, prompt.trim(), apiKey)
      setResult((prev) => { if (prev) URL.revokeObjectURL(prev.url); return { blob, url: URL.createObjectURL(blob), mime: mimeType } })
    } catch (e) {
      const msg = e instanceof AIImageError ? t(`post_form.ai.gen.error.${e.kind}`) : t('post_form.ai.gen.error.network')
      setError(msg)
    } finally {
      setLoading(false)
    }
  }

  const use = () => {
    if (!result) return
    const ext = result.mime.split('/')[1] || 'png'
    onImage(new File([result.blob], `ai-image.${ext}`, { type: result.mime }))
    onClose()
  }

  return (
    <ModalWrapper isOpen={isOpen} onClose={onClose} maxWidth="max-w-md" zIndex={90} usePortal backdropClass="bg-black/60">
      <div className="p-6">
        <h2 className={`text-lg font-bold mb-4 ${themeText(isDark)}`}>{t('post_form.ai.gen.title')}</h2>

        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={t('post_form.ai.gen.placeholder')}
          rows={3}
          className={`w-full mb-3 px-3 py-2 rounded-lg border text-sm resize-none focus:outline-none focus:ring-2 focus:ring-yellow-500/40 ${
            isDark ? 'border-white/15 bg-black text-white' : 'border-gray-300 bg-white text-black'
          }`}
        />

        {error && <p className="text-sm text-red-500 mb-3">{error}</p>}

        {result && (
          <img src={result.url} alt="" className="w-full rounded-lg mb-3 max-h-80 object-contain" />
        )}

        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className={`px-4 py-2 rounded-lg text-sm transition cursor-pointer ${themeSecondaryButton(isDark)}`}
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={generate}
            disabled={loading || !prompt.trim()}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition cursor-pointer ${themeSecondaryButton(isDark)} disabled:opacity-50`}
          >
            {loading ? t('post_form.ai.gen.generating') : result ? t('post_form.ai.gen.regenerate') : t('post_form.ai.gen.generate')}
          </button>
          {result && (
            <button
              type="button"
              onClick={use}
              className="px-4 py-2 rounded-lg text-sm font-medium transition cursor-pointer bg-yellow-500 text-black hover:bg-yellow-400"
            >
              {t('post_form.ai.gen.use')}
            </button>
          )}
        </div>
      </div>
    </ModalWrapper>
  )
}

export default AiImageGenerateModal
