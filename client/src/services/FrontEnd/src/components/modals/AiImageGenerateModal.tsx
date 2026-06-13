import React, { useState, useEffect } from 'react'
import ModalWrapper from './ModalWrapper'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'
import { themeText, themeTextSecondary, themeSecondaryButton } from '~/utils/theme'
import { useAIProviderStore, type AIProvider } from '~/store/aiProviderStore'
import { generateAIImage, AIImageError } from '~/utils/aiImage'
const SiOpenai: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...props}><path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365 2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z"/></svg>
)
const SiGooglegemini: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...props}><path d="M11.04 19.32Q12 24 12 24q.96-4.68 4.08-7.8 3.12-3.12 7.8-4.08Q19.2 11.16 12 11.16q-4.68.96-7.8 4.08Q1.08 18.36.12 12.12 4.8 13.08 7.92 16.2q3.12 3.12 3.12 3.12zM12 0q-.96 4.68-4.08 7.8-3.12 3.12-7.8 4.08Q4.8 12.84 12 12.84q4.68-.96 7.8-4.08Q22.92 5.64 23.88 11.88 19.2 10.92 16.08 7.8 12.96 4.68 12 0z"/></svg>
)
const SiX: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...props}><path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z"/></svg>
)

type SvgIcon = React.FC<React.SVGProps<SVGSVGElement>>

const PROVIDER_TAG: Record<AIProvider, { label: string; Icon: SvgIcon }> = {
  gemini: { label: 'Gemini', Icon: SiGooglegemini },
  openai: { label: 'OpenAI', Icon: SiOpenai },
  grok:   { label: 'Grok',   Icon: SiX },
}

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
        <div className="flex items-center gap-2 mb-4">
          <h2 className={`text-lg font-bold ${themeText(isDark)}`}>{t('post_form.ai.gen.title')}</h2>
          {provider && (() => {
            const { label, Icon } = PROVIDER_TAG[provider]
            return (
              <span
                className={`inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full border ${
                  isDark
                    ? 'border-yellow-500/30 bg-yellow-500/10 text-yellow-400'
                    : 'border-yellow-500/40 bg-yellow-500/10 text-yellow-700'
                }`}
                title={t('settings.ai_provider.title')}
              >
                <Icon className="w-3 h-3" aria-hidden />
                {label}
              </span>
            )
          })()}
        </div>

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
            {loading ? (
              <span className="inline-flex items-center gap-2">
                {/* Inline spinner — same border-spin pattern used across
                    the app (TrendingHashtags, ReplyItem). Sized small to
                    sit next to the label without changing button height. */}
                <span className="w-3.5 h-3.5 border-2 border-gray-400 border-t-yellow-500 rounded-full animate-spin" />
                {t('post_form.ai.gen.generating')}
              </span>
            ) : result ? t('post_form.ai.gen.regenerate') : t('post_form.ai.gen.generate')}
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
