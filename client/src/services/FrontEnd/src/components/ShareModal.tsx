import React, { useState, useEffect } from 'react'
import { HiX, HiLink, HiMail, HiShare, HiCheck } from 'react-icons/hi'
import { FaXTwitter, FaFacebook, FaWhatsapp, FaTelegram } from 'react-icons/fa6'
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

  return (
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
    </>
  )
}
