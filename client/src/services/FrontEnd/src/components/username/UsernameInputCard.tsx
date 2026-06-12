/**
 * UsernameInputCard — shared input chrome for username entry.
 *
 * Owns:
 *   - The text <input> element (pill or boxed variant styling)
 *   - The status indicator inside the field (spinner / green-check / red-x) — boxed only
 *   - The info-icon button + popover shell wrapping <UsernamePricingTable>
 *
 * Does NOT own:
 *   - The cost/hint row — delegated to the `costRow` render prop because the two
 *     callsites differ too much (balance + taken-link + cost$ vs. cost+tooltip +
 *     format/gift errors + available label). Merging them would require more
 *     conditional branches than the shared code saves. The floor requirement
 *     (input + popover shell genuinely shared) is met; cost row is best-effort
 *     and explicitly left to each parent.
 *
 *   - Sanitizing — each parent's `onUsernameChange` implementation handles its
 *     own character filtering (New: lowercase+strip non-alphanum; onboarding:
 *     lowercase only). The component calls onUsernameChange(e.target.value)
 *     verbatim so parent logic is preserved exactly.
 *
 * Popover placement by variant:
 *   'pill'  — right-full mr-3 (opens to the left of the icon, inside the field)
 *   'boxed' — bottom-full mb-2 left-1/2 -translate-x-1/2 (centred above cost row)
 */

import React, { useState, useRef, useEffect } from 'react'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'
import UsernamePricingTable from '~/components/username/UsernamePricingTable'

export interface UsernameInputCardProps {
  variant: 'pill' | 'boxed'
  username: string
  onUsernameChange: (next: string) => void
  // input chrome
  inputRef?: React.RefObject<HTMLInputElement>
  onFocus?: () => void
  placeholder: string
  maxLength?: number
  // popover table props (forwarded to UsernamePricingTable)
  cawPriceUsd?: number
  giftCaw?: bigint
  // boxed-only status indicator
  isTyping?: boolean
  usernameAvailable?: boolean | null
  showAvailabilityMark?: boolean
  // cost/hint row rendered by the parent
  costRow: React.ReactNode
}

export default function UsernameInputCard({
  variant,
  username,
  onUsernameChange,
  inputRef,
  onFocus,
  placeholder,
  maxLength,
  cawPriceUsd,
  giftCaw,
  isTyping,
  usernameAvailable,
  showAvailabilityMark,
  costRow,
}: UsernameInputCardProps) {
  const { isDark } = useTheme()
  const t = useT()

  // Popover open/close state + hover-stay timer (shared across enter/leave of
  // both the trigger button and the popover panel).
  const [showPricingPopover, setShowPricingPopover] = useState(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const openPopover = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    setShowPricingPopover(true)
  }
  const scheduleClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => setShowPricingPopover(false), 120)
  }

  useEffect(() => () => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
  }, [])

  // ── Pill variant ─────────────────────────────────────────────────────────
  if (variant === 'pill') {
    return (
      <div>
        <div className="relative">
          {/* Left user icon */}
          <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
            <svg className="h-5 w-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
            </svg>
          </div>

          <input
            ref={inputRef}
            type="text"
            value={username}
            pattern="[A-Za-z0-9]*"
            onChange={e => onUsernameChange(e.target.value)}
            onFocus={onFocus}
            placeholder={placeholder}
            maxLength={maxLength}
            className={`w-full pl-10 pr-12 py-3 rounded-full focus:outline-none transition-all duration-300 ${
              isDark
                ? 'bg-black border border-white/20 text-white placeholder-white/50 focus:border-white/30 focus:bg-black'
                : 'bg-gray-100 border border-gray-300 text-black placeholder-gray-400 focus:border-gray-400 focus:bg-white'
            }`}
          />

          {/* Right info icon + popover — pill: opens to the LEFT */}
          <div className="absolute inset-y-0 right-0 pr-3 flex items-center">
            <div
              className="relative"
              onMouseEnter={openPopover}
              onMouseLeave={scheduleClose}
            >
              <button
                type="button"
                aria-label={t('new_profile.pricing_title')}
                className="text-gray-400 hover:text-white transition-colors duration-200"
              >
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </button>

              {showPricingPopover && (
                <div
                  onMouseEnter={openPopover}
                  onMouseLeave={scheduleClose}
                  className={`absolute top-1/2 -translate-y-1/2 right-full mr-3 w-72 border rounded-lg p-5 z-50 ${
                    isDark ? 'bg-black border-white/20' : 'bg-white border-gray-200'
                  }`}
                >
                  <div className={`text-sm font-medium text-center mb-3 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                    {t('new_profile.pricing_title')}
                  </div>
                  <UsernamePricingTable cawPriceUsd={cawPriceUsd} giftCaw={giftCaw} />
                </div>
              )}
            </div>
          </div>
        </div>

        {costRow}
      </div>
    )
  }

  // ── Boxed variant ────────────────────────────────────────────────────────
  const borderBase = isDark ? 'border-white/20' : 'border-gray-300'
  const borderFocus = 'focus:outline-none focus:ring-2 focus:ring-yellow-500/50 focus:border-yellow-500'
  const inputBg = isDark ? 'bg-white/5' : 'bg-white'
  const strongClass = isDark ? 'text-white' : 'text-gray-900'

  return (
    <div>
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          value={username}
          onChange={e => onUsernameChange(e.target.value)}
          onFocus={onFocus}
          placeholder={placeholder}
          maxLength={maxLength}
          autoComplete="off"
          spellCheck={false}
          className={`
            w-full px-4 py-3 pr-10 rounded-xl border text-sm transition-colors
            ${inputBg} ${strongClass} ${borderBase} ${borderFocus}
          `}
        />

        {/* Right: status indicator (spinner / check / x) */}
        {showAvailabilityMark && (
          <div className="absolute right-3 top-1/2 -translate-y-1/2">
            {isTyping && username.length > 0 && (
              <svg className="w-4 h-4 animate-spin text-yellow-500" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            )}
            {!isTyping && usernameAvailable === true && (
              <svg className="w-4 h-4 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            )}
            {!isTyping && usernameAvailable === false && username.length > 0 && (
              <svg className="w-4 h-4 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            )}
          </div>
        )}
      </div>

      {/*
        The boxed variant's info-icon + popover lives INSIDE the cost row,
        inline next to the mint-cost text. Rather than trying to inject a
        sub-element into the costRow slot from here, we expose the popover
        trigger as a named export so UsernameStep can place it inline.
        The costRow slot still comes from the parent; the parent imports
        BoxedPricingTrigger separately. See UsernameStep.tsx for usage.
      */}
      {costRow}
    </div>
  )
}

/**
 * BoxedPricingTrigger — the standalone info-icon + centred popover used in the
 * boxed variant's cost row. UsernameStep imports and places this inline next to
 * the mint-cost text rather than having it float inside the input field.
 */
export function BoxedPricingTrigger({
  cawPriceUsd,
  giftCaw,
}: {
  cawPriceUsd?: number
  giftCaw?: bigint
}) {
  const { isDark } = useTheme()
  const t = useT()
  const [show, setShow] = useState(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const open = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    setShow(true)
  }
  const scheduleClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => setShow(false), 120)
  }

  useEffect(() => () => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
  }, [])

  const strongClass = isDark ? 'text-white' : 'text-gray-900'

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={open}
      onMouseLeave={scheduleClose}
    >
      <button
        type="button"
        aria-label={t('new_profile.pricing_title')}
        className={`inline-flex items-center justify-center transition-colors ${
          isDark ? 'text-white/40 hover:text-white' : 'text-gray-400 hover:text-gray-700'
        }`}
        onFocus={open}
        onBlur={scheduleClose}
      >
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      </button>
      {show && (
        <div
          onMouseEnter={open}
          onMouseLeave={scheduleClose}
          className={`absolute z-50 bottom-full mb-2 left-1/2 -translate-x-1/2 w-64 border rounded-lg p-4 shadow-lg ${
            isDark ? 'bg-black border-white/20' : 'bg-white border-gray-200'
          }`}
        >
          <div className={`text-sm font-medium text-center mb-3 ${strongClass}`}>
            {t('new_profile.pricing_title')}
          </div>
          <UsernamePricingTable cawPriceUsd={cawPriceUsd} giftCaw={giftCaw} />
        </div>
      )}
    </span>
  )
}
