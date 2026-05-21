/**
 * UsernameStep.tsx
 *
 * Step 1 of /onboarding: pick a username and verify it is available on-chain.
 * Uses wagmi's useReadContract to call cawProfileMinter.idByUsername(username)
 * — returns 0n when the name is free, a non-zero tokenId when taken.
 *
 * Availability check is debounced so we don't fire per-keystroke RPC calls.
 */

import { useState, useEffect } from 'react'
import { useReadContract } from 'wagmi'
import { cawProfileMinterAbi } from '~/../../../abi/generated'
import { CAW_NAMES_MINTER_ADDRESS } from '~/../../../abi/addresses'
import { chains } from '~/config/chains'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'

const DEBOUNCE_MS = 500

// Lowercase alphanumeric + underscore; min 3, max 24 chars
const USERNAME_REGEX = /^[a-z0-9_]{3,24}$/

export interface UsernameStepProps {
  username: string
  usernameAvailable: boolean | null
  onUsernameChange: (value: string) => void
  onAvailabilityChange: (available: boolean | null) => void
  onNext: () => void
}

export default function UsernameStep({
  username,
  usernameAvailable,
  onUsernameChange,
  onAvailabilityChange,
  onNext,
}: UsernameStepProps) {
  const { isDark } = useTheme()
  const t = useT()

  // Debounced value used for the RPC call — avoids a query per keystroke
  const [debouncedUsername, setDebouncedUsername] = useState(username)

  useEffect(() => {
    const id = setTimeout(() => setDebouncedUsername(username), DEBOUNCE_MS)
    return () => clearTimeout(id)
  }, [username])

  const isValidFormat = USERNAME_REGEX.test(debouncedUsername)

  const { data: existingId, isLoading: checkingUsername } = useReadContract({
    address: CAW_NAMES_MINTER_ADDRESS,
    abi: cawProfileMinterAbi,
    chainId: chains.l1.chainId,
    functionName: 'idByUsername',
    args: [debouncedUsername],
    query: { enabled: isValidFormat },
  })

  // Sync availability to parent whenever it changes
  useEffect(() => {
    if (!isValidFormat || checkingUsername) {
      onAvailabilityChange(null)
      return
    }
    // existingId === 0 or undefined means free; non-zero means taken
    // idByUsername returns uint32 — wagmi types it as number
    const available = existingId === undefined || existingId === 0
    onAvailabilityChange(available)
  }, [existingId, checkingUsername, isValidFormat, onAvailabilityChange])

  const isTyping = username !== debouncedUsername || checkingUsername
  const canProceed = usernameAvailable === true

  const mutedClass = isDark ? 'text-white/50' : 'text-gray-500'
  const strongClass = isDark ? 'text-white' : 'text-gray-900'
  const borderBase = isDark ? 'border-white/20' : 'border-gray-300'
  const borderFocus = 'focus:outline-none focus:ring-2 focus:ring-yellow-500/50 focus:border-yellow-500'
  const inputBg = isDark ? 'bg-white/5' : 'bg-white'

  return (
    <div className="space-y-6">
      <div>
        <h2 className={`text-xl font-bold mb-1 ${strongClass}`}>
          {t('onboarding.username.title')}
        </h2>
        <p className={`text-sm ${mutedClass}`}>
          {t('onboarding.username.subtitle')}
        </p>
      </div>

      <div className="space-y-2">
        <label className={`block text-sm font-medium ${strongClass}`}>
          {t('onboarding.username.label')}
        </label>

        <div className="relative">
          <input
            type="text"
            value={username}
            onChange={e => onUsernameChange(e.target.value.toLowerCase())}
            placeholder={t('onboarding.username.placeholder')}
            maxLength={24}
            autoComplete="off"
            spellCheck={false}
            className={`
              w-full px-4 py-3 pr-10 rounded-xl border text-sm transition-colors
              ${inputBg} ${strongClass} ${borderBase} ${borderFocus}
            `}
          />

          {/* Status indicator */}
          <div className="absolute right-3 top-1/2 -translate-y-1/2">
            {isTyping && username.length > 0 && (
              <svg
                className="w-4 h-4 animate-spin text-yellow-500"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            )}
            {!isTyping && usernameAvailable === true && (
              <svg className="w-4 h-4 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            )}
            {!isTyping && usernameAvailable === false && (
              <svg className="w-4 h-4 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            )}
          </div>
        </div>

        {/* Hint messages below the input */}
        <div className="min-h-[1.25rem]">
          {username.length > 0 && !isValidFormat && !isTyping && (
            <p className="text-xs text-red-500">
              {t('onboarding.username.format_hint')}
            </p>
          )}
          {!isTyping && usernameAvailable === true && (
            <p className="text-xs text-green-500">
              {t('onboarding.username.available')}
            </p>
          )}
          {!isTyping && usernameAvailable === false && (
            <p className="text-xs text-red-500">
              {t('onboarding.username.taken')}
            </p>
          )}
        </div>
      </div>

      <button
        onClick={onNext}
        disabled={!canProceed}
        className={`
          w-full py-3 rounded-full font-semibold text-sm transition-all
          ${canProceed
            ? 'bg-yellow-500 text-black hover:bg-yellow-400 cursor-pointer'
            : 'bg-yellow-500/30 text-black/40 cursor-not-allowed'
          }
        `}
      >
        {t('common.next')}
      </button>
    </div>
  )
}
