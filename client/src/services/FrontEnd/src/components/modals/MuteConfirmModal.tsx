import React, { useState } from 'react'
import { HiEyeOff, HiVolumeOff, HiUserRemove } from 'react-icons/hi'
import { Link } from 'react-router-dom'
import ModalWrapper from './ModalWrapper'
import ModalHeader from './ModalHeader'
import { useT } from '~/i18n/I18nProvider'

type ActionType = 'hide-post' | 'mute-thread' | 'mute-account' | 'block-account' | 'mute-words'

interface MuteConfirmModalProps {
  isOpen: boolean
  onClose: () => void
  actionType: ActionType
  targetName?: string // username for account actions
  onConfirm: () => void
}

// Icon-only — title/description/button text now resolved through t()
// inside the component so they reflect the active locale.
const ACTION_ICON: Record<ActionType, React.ComponentType<{ className?: string }>> = {
  'hide-post':     HiEyeOff,
  'mute-thread':   HiVolumeOff,
  'mute-account':  HiVolumeOff,
  'block-account': HiUserRemove,
  'mute-words':    HiVolumeOff,
}

const STORAGE_KEY = 'hideMuteConfirmModal'

export function shouldShowMuteConfirmModal(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== 'true'
  } catch {
    return true
  }
}

const MuteConfirmModal: React.FC<MuteConfirmModalProps> = ({
  isOpen,
  onClose,
  actionType,
  targetName,
  onConfirm
}) => {
  const t = useT()
  const [dontShowAgain, setDontShowAgain] = useState(false)

  // The description has a `this account` substring that gets swapped for
  // `@username` when targetName is set. The translated description must
  // also use the same `this account` placeholder so the same .replace()
  // works across locales — the en.json values keep that token.
  const titleKey       = `mute_confirm.${actionType.replace('-', '_')}.title`
  const descriptionKey = `mute_confirm.${actionType.replace('-', '_')}.description`
  const Icon = ACTION_ICON[actionType]

  const handleConfirm = () => {
    if (dontShowAgain) {
      try {
        localStorage.setItem(STORAGE_KEY, 'true')
      } catch (e) {
        console.error('Failed to save preference:', e)
      }
    }
    onConfirm()
    onClose()
  }

  return (
    <ModalWrapper
      isOpen={isOpen}
      onClose={onClose}
      maxWidth="max-w-sm"
      zIndex={80}
      usePortal
      backdropClass="bg-black/60"
      className="shadow-2xl"
    >
      <ModalHeader
        title={t(titleKey)}
        onClose={onClose}
        icon={<Icon className="w-5 h-5 text-yellow-500" />}
        border={false}
        forceDark
      />

      {/* Content */}
      <div className="px-4 pb-4">
        <p className="text-sm mb-4 text-white/70">
          {targetName
            ? t(descriptionKey).replace('this account', `@${targetName}`)
            : t(descriptionKey)
          }
        </p>

        <p className="text-sm mb-4 text-white/50">
          {t('mute_confirm.undo_hint')}
          <br />
          <Link
            to="/settings/muted"
            className="underline text-yellow-500 hover:text-yellow-400"
            onClick={onClose}
          >
            {t('mute_confirm.undo_link')}
          </Link>.
        </p>

        {actionType !== 'mute-thread' && actionType !== 'block-account' && (
          <p className="text-xs mb-4 text-white/40">
            {t('mute_confirm.note.local_storage')}
          </p>
        )}
        {actionType === 'block-account' && (
          <p className="text-xs mb-4 text-white/40">
            {t('mute_confirm.note.account_wide')}
          </p>
        )}

        {/* Don't show again checkbox */}
        <label className="flex items-center justify-center gap-2 mb-4 cursor-pointer text-sm text-white/60">
          <button
            type="button"
            role="checkbox"
            aria-checked={dontShowAgain}
            onClick={() => setDontShowAgain(!dontShowAgain)}
            className={`w-4 h-4 rounded flex-shrink-0 flex items-center justify-center transition-colors duration-150 ${
              dontShowAgain
                ? 'bg-yellow-500'
                : 'bg-black border border-white/30'
            }`}
          >
            {dontShowAgain && (
              <svg className="w-3 h-3 text-black" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            )}
          </button>
          {t('mute_confirm.dont_show_message')}
        </label>

        {/* Button */}
        <button
          onClick={handleConfirm}
          className="w-full py-2.5 px-4 rounded-lg text-sm font-medium bg-yellow-500 text-black hover:bg-yellow-400 transition-colors cursor-pointer"
        >
          {t('mute_confirm.got_it')}
        </button>
      </div>
    </ModalWrapper>
  )
}

export default MuteConfirmModal
