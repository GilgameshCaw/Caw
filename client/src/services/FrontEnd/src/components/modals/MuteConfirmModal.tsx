import React, { useState } from 'react'
import { HiEyeOff, HiVolumeOff, HiUserRemove } from 'react-icons/hi'
import { Link } from 'react-router-dom'
import ModalWrapper from './ModalWrapper'
import ModalHeader from './ModalHeader'

type ActionType = 'hide-post' | 'mute-thread' | 'mute-account' | 'block-account' | 'mute-words'

interface MuteConfirmModalProps {
  isOpen: boolean
  onClose: () => void
  actionType: ActionType
  targetName?: string // username for account actions
  onConfirm: () => void
}

const ACTION_CONFIG: Record<ActionType, {
  title: string
  description: string
  icon: React.ComponentType<{ className?: string }>
  buttonText: string
}> = {
  'hide-post': {
    title: 'Post Hidden',
    description: 'This post has been hidden from your feed. You won\'t see it again unless you unhide it.',
    icon: HiEyeOff,
    buttonText: 'Got it'
  },
  'mute-thread': {
    title: 'Thread Muted',
    description: 'You\'ve muted this thread. You won\'t receive notifications for likes, replies, reposts, or quotes on this post or its replies.',
    icon: HiVolumeOff,
    buttonText: 'Got it'
  },
  'mute-account': {
    title: 'Account Muted',
    description: 'Posts from this account will no longer appear in your feed. They can still see your posts and follow you.',
    icon: HiVolumeOff,
    buttonText: 'Got it'
  },
  'block-account': {
    title: 'Account Blocked',
    description: 'This account can no longer see your posts, follow you, or interact with you. You won\'t see their content either.',
    icon: HiUserRemove,
    buttonText: 'Got it'
  },
  'mute-words': {
    title: 'Words Muted',
    description: 'Posts containing these words will be hidden from your feed.',
    icon: HiVolumeOff,
    buttonText: 'Got it'
  }
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
  const [dontShowAgain, setDontShowAgain] = useState(false)

  const config = ACTION_CONFIG[actionType]
  const Icon = config.icon

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
        title={config.title}
        onClose={onClose}
        icon={<Icon className="w-5 h-5 text-yellow-500" />}
        border={false}
        forceDark
      />

      {/* Content */}
      <div className="px-4 pb-4">
        <p className="text-sm mb-4 text-white/70">
          {targetName
            ? config.description.replace('this account', `@${targetName}`)
            : config.description
          }
        </p>

        <p className="text-sm mb-4 text-white/50">
          You can undo this anytime in
          <br />
          <Link
            to="/settings/muted"
            className="underline text-yellow-500 hover:text-yellow-400"
            onClick={onClose}
          >
            Settings → Muted Content
          </Link>.
        </p>

        {actionType !== 'mute-thread' && (
          <p className="text-xs mb-4 text-white/40">
            Note: This preference is stored in this browser only and will apply to all accounts you access on this device.
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
          Don't show this message again
        </label>

        {/* Button */}
        <button
          onClick={handleConfirm}
          className="w-full py-2.5 px-4 rounded-lg text-sm font-medium bg-yellow-500 text-black hover:bg-yellow-400 transition-colors cursor-pointer"
        >
          {config.buttonText}
        </button>
      </div>
    </ModalWrapper>
  )
}

export default MuteConfirmModal
