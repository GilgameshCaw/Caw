import React, { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { HiX, HiLink, HiMail, HiShare, HiCheck } from 'react-icons/hi'
const FaXTwitter: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 512 512" fill="currentColor" {...props}><path d="M389.2 48h70.6L305.6 224.2 487 464H345L233.7 318.6 106.5 464H35.8l164.9-188.5L26.8 48h145.6l100.5 132.9zm-24.8 373.8h39.1L151.1 88h-42z"/></svg>
)
const FaFacebook: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 512 512" fill="currentColor" {...props}><path d="M512 256C512 114.6 397.4 0 256 0S0 114.6 0 256c0 120 82.7 220.8 194.2 248.5V334.2h-56.6v-78.2h56.6v-61.3c0-56 33.3-86.9 84.4-86.9 24.4 0 50 4.4 50 4.4v55h-28.2c-27.8 0-36.4 17.2-36.4 34.9v42h61.8l-9.9 78.2h-51.9V504.5C429.3 476.8 512 376 512 256z"/></svg>
)
const FaWhatsapp: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 448 512" fill="currentColor" {...props}><path d="M380.9 97.1C339 55.1 283.2 32 223.9 32c-122.4 0-222 99.6-222 222 0 39.1 10.2 77.3 29.6 111L0 480l117.7-30.9c32.4 17.7 68.9 27 106.1 27h.1c122.3 0 224.1-99.6 224.1-222 0-59.3-25.2-115-67.1-157zm-157 341.6c-33.2 0-65.7-8.9-94-25.7l-6.7-4-69.8 18.3L72 359.2l-4.4-7c-18.5-29.4-28.2-63.3-28.2-98.2 0-101.7 82.8-184.5 184.6-184.5 49.3 0 95.6 19.2 130.4 54.1 34.8 34.9 56.2 81.2 56.1 130.5 0 101.8-84.9 184.6-186.6 184.6zm101.2-138.2c-5.5-2.8-32.8-16.2-37.9-18-5.1-1.9-8.8-2.8-12.5 2.8-3.7 5.6-14.3 18-17.6 21.8-3.2 3.7-6.5 4.2-12 1.4-32.6-16.3-54-29.1-75.5-66-5.7-9.8 5.7-9.1 16.3-30.3 1.8-3.7.9-6.9-.5-9.7-1.4-2.8-12.5-30.1-17.1-41.2-4.5-10.8-9.1-9.3-12.5-9.5-3.2-.2-6.9-.2-10.6-.2-3.7 0-9.7 1.4-14.8 6.9-5.1 5.6-19.4 19-19.4 46.3 0 27.3 19.9 53.7 22.6 57.4 2.8 3.7 39.1 59.7 94.8 83.8 35.2 15.2 49 16.5 66.6 13.9 10.7-1.6 32.8-13.4 37.4-26.4 4.6-13 4.6-24.1 3.2-26.4-1.3-2.5-5-3.9-10.5-6.6z"/></svg>
)
const FaTelegram: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 496 512" fill="currentColor" {...props}><path d="M248 8C111 8 0 119 0 256s111 248 248 248 248-111 248-248S385 8 248 8zm121.8 169.9l-40.7 191.8c-3 13.6-11.1 16.9-22.4 10.5l-62-45.7-29.9 28.8c-3.3 3.3-6.1 6.1-12.5 6.1l4.4-63.1 114.9-103.8c5-4.4-1.1-6.9-7.7-2.5l-142 89.4-61.2-19.1c-13.3-4.2-13.6-13.3 2.8-19.7l239.1-92.2c11.1-4 20.8 2.7 17.2 19.5z"/></svg>
)
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'

interface ShareModalProps {
  isOpen: boolean
  onClose: () => void
  url: string
  title: string
  text?: string
}

export const ShareModal: React.FC<ShareModalProps> = ({
  isOpen,
  onClose,
  url,
  title,
  text = ''
}) => {
  const { isDark } = useTheme()
  const t = useT()
  const [copied, setCopied] = useState(false)
  const shareUrl = `${window.location.origin}${url}`
  const shareText = text || title

  useEffect(() => {
    if (!isOpen) return
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isOpen, onClose])

  if (!isOpen) return null

  const handleNativeShare = async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title,
          text: shareText,
          url: shareUrl
        })
        onClose()
      } catch (error) {
        if ((error as Error).name !== 'AbortError') {
          console.error('Share failed:', error)
        }
      }
    }
  }

  const handleCopyLink = () => {
    navigator.clipboard.writeText(shareUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const shareOptions = [
    {
      name: 'X',
      icon: FaXTwitter,
      color: isDark ? 'text-white' : 'text-black',
      url: `https://x.com/intent/tweet?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(shareUrl)}`
    },
    {
      name: 'Facebook',
      icon: FaFacebook,
      color: 'text-blue-600',
      url: `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(shareUrl)}`
    },
    {
      name: 'WhatsApp',
      icon: FaWhatsapp,
      color: 'text-green-500',
      url: `https://wa.me/?text=${encodeURIComponent(shareText + ' ' + shareUrl)}`
    },
    {
      name: 'Telegram',
      icon: FaTelegram,
      color: 'text-blue-500',
      url: `https://t.me/share/url?url=${encodeURIComponent(shareUrl)}&text=${encodeURIComponent(shareText)}`
    },
    {
      name: 'Email',
      icon: HiMail,
      color: 'text-gray-500',
      url: `mailto:?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(shareText + '\n\n' + shareUrl)}`
    }
  ]

  const handleBackdropMouseDown = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose()
  }

  // Portal to document.body so we escape any stacking context the
  // mounting parent (FeedItem, ShareProfileCardModal, etc.) creates.
  // Without this the fixed-position modal gets trapped behind sibling
  // FeedItems lower in the DOM because they're rendered after the
  // modal's parent and share the same z-stack.
  return createPortal(
    <>
      {/* Backdrop + modal share a container so clicks on empty area close */}
      <div
        className="fixed inset-0 bg-black/50 z-[80] flex items-end justify-center md:items-center px-4 md:px-0"
        onMouseDown={handleBackdropMouseDown}
      >
        <div
          className={`w-full md:w-96 rounded-t-2xl md:rounded-2xl ${
            isDark ? 'bg-black border-yellow-500/30' : 'bg-white border-gray-200'
          } border overflow-hidden animate-slide-up md:animate-fade-in`}
          onMouseDown={e => e.stopPropagation()}
        >
          {/* Header */}
          <div className={`flex items-center justify-between px-4 py-3 border-b ${
            isDark ? 'border-white/20' : 'border-gray-200'
          }`}>
            <h2 className={`text-lg font-semibold ${
              isDark ? 'text-white' : 'text-gray-900'
            }`}>
              {t('share.title')}
            </h2>
            <button
              onClick={onClose}
              className={`p-1 rounded-full transition ${
                isDark ? 'hover:bg-white/10' : 'hover:bg-gray-100'
              }`}
            >
              <HiX className={`w-5 h-5 ${
                isDark ? 'text-white/70' : 'text-gray-600'
              }`} />
            </button>
          </div>

          {/* Content */}
          <div className="p-4">
            {/* Native share button (if supported) */}
            {typeof navigator.share === 'function' && (
              <button
                onClick={handleNativeShare}
                className={`w-full mb-4 px-4 py-3 rounded-full flex items-center justify-center space-x-2 transition ${
                  'bg-yellow-500 hover:bg-yellow-400 text-black font-medium'
                }`}
              >
                <HiShare className="w-5 h-5" />
                <span>{t('share.via')}</span>
              </button>
            )}

            {/* Copy link button */}
            <button
              onClick={handleCopyLink}
              className={`w-full mb-4 px-4 py-3 rounded-full flex items-center justify-center space-x-2 transition ${
                isDark
                  ? 'bg-white/10 hover:bg-white/20 text-white border border-white/20'
                  : 'bg-gray-100 hover:bg-gray-200 text-gray-900 border border-gray-300'
              }`}
            >
              {copied ? (
                <>
                  <HiCheck className="w-5 h-5 text-green-500" />
                  <span>{t('post.copied')}</span>
                </>
              ) : (
                <>
                  <HiLink className="w-5 h-5" />
                  <span>{t('share.copy_link')}</span>
                </>
              )}
            </button>

            {/* Share options grid */}
            <div className="flex flex-wrap justify-center gap-3">
              {shareOptions.map((option) => (
                <a
                  key={option.name}
                  href={option.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`flex flex-col items-center justify-center p-3 rounded-lg transition w-[calc(33.333%-0.5rem)] ${
                    isDark
                      ? 'bg-white/5 hover:bg-white/10'
                      : 'bg-gray-50 hover:bg-gray-100'
                  }`}
                >
                  <option.icon className={`w-6 h-6 mb-1 ${option.color}`} />
                  <span className={`text-xs ${
                    isDark ? 'text-white/70' : 'text-gray-600'
                  }`}>
                    {option.name}
                  </span>
                </a>
              ))}
            </div>
          </div>
        </div>
      </div>

      <style>{`
        @keyframes slide-up {
          from {
            transform: translateY(100%);
          }
          to {
            transform: translateY(0);
          }
        }

        @keyframes fade-in {
          from {
            opacity: 0;
            transform: scale(0.95);
          }
          to {
            opacity: 1;
            transform: scale(1);
          }
        }

        .animate-slide-up {
          animation: slide-up 0.3s ease-out;
        }

        .animate-fade-in {
          animation: fade-in 0.2s ease-out;
        }
      `}</style>
    </>,
    document.body,
  )
}
