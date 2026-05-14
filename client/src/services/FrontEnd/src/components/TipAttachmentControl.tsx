import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTheme } from '~/hooks/useTheme'
import { themeTextSecondary, themeTextMuted, themeBorder } from '~/utils/theme'
import { usePriceStore } from '~/store/tokenDataStore'
import { useT } from '~/i18n/I18nProvider'
import { apiFetch } from '~/api/client'
import { getUserAvatar } from '~/utils/defaultAvatar'
import type { CawItem } from '~/types'

const PRESET_USD_AMOUNTS = [1, 5, 10, 20]
const MIN_TIP_USD = 1

export interface TipAttachment {
  /** Tip amount in whole CAW tokens (no validator fee included — caller adds that). */
  tipAmountCaw: number
  /** USD amount entered by the user (display only). */
  tipUsd: number
  /** tokenId of the user who will receive the tip. */
  recipientTokenId: number
  /** Username of the recipient — for display in the badge / submit confirm. */
  recipientUsername: string
}

interface RecipientUser {
  tokenId: number
  username: string
  displayName?: string
  avatarUrl?: string
}

interface Props {
  /** Live post text — used to detect @mentions and prefill the recipient picker. */
  text: string
  /** When replying, the parent caw is the default recipient. */
  replyTo?: CawItem
  /** Tokens the user owns — we never tip ourselves, so we hide these from the picker. */
  ownTokenIds: number[]
  /** Current attached tip — null when no tip is attached. */
  value: TipAttachment | null
  onChange: (next: TipAttachment | null) => void
  /** Match parent toolbar sizing — w-5 on mobile bar, w-6 on desktop bar. */
  iconSizeClass?: string
  /** Disable the control (e.g. no token, not connected). */
  disabled?: boolean
  /** Optional tooltip text to show via title attribute. */
  title?: string
}

const usdToCaw = (usd: number, cawPrice: number): number => {
  if (!cawPrice || cawPrice <= 0) return 0
  return Math.max(1, Math.round(usd / cawPrice))
}

const formatUsd = (n: number): string =>
  n < 1 ? `$${n.toFixed(2)}` : `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`

// Pull @mentions out of the post text in the order they appear. We use the
// same pattern HighlightedTextarea highlights, so what the user sees
// underlined is exactly what we suggest.
function extractMentionUsernames(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const re = /(?:^|[^A-Za-z0-9_])@([A-Za-z0-9_]{1,32})/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const u = m[1].toLowerCase()
    if (!seen.has(u)) {
      seen.add(u)
      out.push(m[1])
    }
  }
  return out
}

const TipAttachmentControl: React.FC<Props> = ({
  text, replyTo, ownTokenIds, value, onChange,
  iconSizeClass = 'w-5 h-5', disabled = false, title,
}) => {
  const { isDark } = useTheme()
  const t = useT()
  const cawPrice = usePriceStore(s => s.priceMap['a-hunters-dream'] ?? 0)
  const priceReady = cawPrice > 0

  const [open, setOpen] = useState(false)
  const [popPos, setPopPos] = useState<{ x: number; y: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)

  const [usdInput, setUsdInput] = useState<string>(String(value?.tipUsd ?? PRESET_USD_AMOUNTS[0]))
  const [recipient, setRecipient] = useState<RecipientUser | null>(
    value
      ? { tokenId: value.recipientTokenId, username: value.recipientUsername }
      : replyTo
        ? { tokenId: replyTo.user.tokenId, username: replyTo.user.username, displayName: replyTo.user.displayName }
        : null
  )
  const [recipientQuery, setRecipientQuery] = useState('')
  const [recipientSuggestions, setRecipientSuggestions] = useState<RecipientUser[]>([])
  const [showSuggestions, setShowSuggestions] = useState(false)

  // Default recipient resolves from replyTo > first @mention > nothing.
  // Re-runs only while no recipient is set so manual choices stick.
  const mentionUsernames = useMemo(() => extractMentionUsernames(text), [text])
  useEffect(() => {
    if (recipient) return
    if (replyTo) {
      setRecipient({ tokenId: replyTo.user.tokenId, username: replyTo.user.username, displayName: replyTo.user.displayName })
      return
    }
    const firstMention = mentionUsernames[0]
    if (!firstMention) return
    let cancelled = false
    apiFetch<{ users: RecipientUser[] }>(`/api/users/search/${encodeURIComponent(firstMention)}`)
      .then(data => {
        if (cancelled) return
        const users = data?.users ?? []
        const exact = users.find(u => u.username.toLowerCase() === firstMention.toLowerCase())
        if (exact && !ownTokenIds.includes(exact.tokenId)) setRecipient(exact)
      })
      .catch(() => { /* silent — picker still lets them search */ })
    return () => { cancelled = true }
  }, [recipient, replyTo, mentionUsernames, ownTokenIds])

  // Debounced user search for the picker input. Mention-prefill candidates
  // float to the top so the user sees the people they're addressing first.
  useEffect(() => {
    const q = recipientQuery.trim()
    if (!q) {
      // When no query: surface @mention-prefilled candidates from the caw text.
      if (mentionUsernames.length === 0) {
        setRecipientSuggestions([])
        return
      }
      let cancelled = false
      Promise.all(
        mentionUsernames.slice(0, 5).map(u =>
          apiFetch<{ users: RecipientUser[] }>(`/api/users/search/${encodeURIComponent(u)}`)
            .then(data => (data?.users ?? []).find(x => x.username.toLowerCase() === u.toLowerCase()) || null)
            .catch(() => null)
        )
      ).then(results => {
        if (cancelled) return
        const seen = new Set<number>()
        const out: RecipientUser[] = []
        for (const r of results) {
          if (!r) continue
          if (ownTokenIds.includes(r.tokenId)) continue
          if (seen.has(r.tokenId)) continue
          seen.add(r.tokenId)
          out.push(r)
        }
        setRecipientSuggestions(out)
      })
      return () => { cancelled = true }
    }
    let cancelled = false
    const timer = setTimeout(() => {
      apiFetch<{ users: RecipientUser[] }>(`/api/users/search/${encodeURIComponent(q)}`)
        .then(data => {
          if (cancelled) return
          const users = data?.users ?? []
          setRecipientSuggestions(users.filter(u => !ownTokenIds.includes(u.tokenId)).slice(0, 8))
        })
        .catch(() => { if (!cancelled) setRecipientSuggestions([]) })
    }, 180)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [recipientQuery, mentionUsernames, ownTokenIds])

  // Position the popover relative to the button. The render gate below is
  // `open && popPos`, so popPos MUST be set synchronously when open flips
  // true or the popover never mounts. Use useLayoutEffect (pre-paint) with
  // an estimated panel size on the first pass.
  useLayoutEffect(() => {
    if (!open) {
      setPopPos(null)
      return
    }
    const btn = btnRef.current
    if (!btn) return
    const r = btn.getBoundingClientRect()
    const pad = 8
    // popRef.current is null on the very first run (popover not in DOM yet
    // because popPos is still null). Estimate ~320×360 from the design;
    // the refinement effect below re-measures once the popover has mounted.
    const el = popRef.current
    const panelW = el?.offsetWidth || 320
    const panelH = el?.offsetHeight || 360
    const xRaw = r.left + r.width / 2 - panelW / 2
    const yBelow = r.bottom + 8
    const yAbove = r.top - panelH - 8
    const fitsBelow = yBelow + panelH <= window.innerHeight - pad
    const x = Math.min(Math.max(pad, xRaw), window.innerWidth - panelW - pad)
    const y = fitsBelow ? yBelow : Math.max(pad, yAbove)
    setPopPos(prev => prev && Math.abs(prev.x - x) < 0.5 && Math.abs(prev.y - y) < 0.5 ? prev : { x, y })
  }, [open])

  // Refinement pass: once the popover is in the DOM and popPos has a value,
  // measure it for real and nudge the position if the estimate was off.
  useLayoutEffect(() => {
    if (!open || !popPos) return
    const btn = btnRef.current
    const el = popRef.current
    if (!btn || !el) return
    const r = btn.getBoundingClientRect()
    const panelW = el.offsetWidth
    const panelH = el.offsetHeight
    if (panelW === 0 || panelH === 0) return
    const pad = 8
    const xRaw = r.left + r.width / 2 - panelW / 2
    const yBelow = r.bottom + 8
    const yAbove = r.top - panelH - 8
    const fitsBelow = yBelow + panelH <= window.innerHeight - pad
    const x = Math.min(Math.max(pad, xRaw), window.innerWidth - panelW - pad)
    const y = fitsBelow ? yBelow : Math.max(pad, yAbove)
    if (Math.abs(popPos.x - x) > 0.5 || Math.abs(popPos.y - y) > 0.5) {
      setPopPos({ x, y })
    }
  }, [open, popPos])

  // Close on click-outside.
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      const tgt = e.target as Node
      if (popRef.current?.contains(tgt)) return
      if (btnRef.current?.contains(tgt)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const usdAmount = parseFloat(usdInput) || 0
  const tipAmountCaw = usdToCaw(usdAmount, cawPrice)
  const canAttach = priceReady && usdAmount >= MIN_TIP_USD && tipAmountCaw > 0 && !!recipient

  const handleAttach = () => {
    if (!canAttach || !recipient) return
    onChange({
      tipAmountCaw,
      tipUsd: usdAmount,
      recipientTokenId: recipient.tokenId,
      recipientUsername: recipient.username,
    })
    setOpen(false)
  }

  const handleClear = () => {
    onChange(null)
    setRecipientQuery('')
  }

  // Active state styling mirrors the poll button — yellow fill when attached,
  // dimmed yellow when empty.
  const hasTip = !!value
  const activeClasses = hasTip
    ? 'text-yellow-500 bg-yellow-400/10'
    : text.trim()
      ? (isDark
          ? 'text-yellow-400 hover:text-yellow-300 hover:bg-yellow-400/10'
          : 'text-yellow-600 hover:text-yellow-500 hover:bg-yellow-200/50')
      : (isDark
          ? 'text-yellow-400/70 hover:text-yellow-400 hover:bg-yellow-400/10'
          : 'text-yellow-600/70 hover:text-yellow-600 hover:bg-yellow-200/50')

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => { if (!disabled) setOpen(o => !o) }}
        disabled={disabled}
        title={title || t('post_form.tip.tooltip', { defaultValue: 'Attach a tip to your post' })}
        aria-label={hasTip
          ? t('post_form.tip.aria_attached', { defaultValue: `Tip attached: $${value!.tipUsd} to @${value!.recipientUsername}` })
          : t('post_form.tip.aria', { defaultValue: 'Attach a tip' })}
        className={`relative p-1 rounded-full transition-all duration-200 ${
          disabled ? 'opacity-30 cursor-not-allowed' : 'cursor-pointer'
        } ${activeClasses}`}
      >
        {/* Dollar-sign coin icon. Filled when a tip is attached, outline when not. */}
        <svg className={iconSizeClass} fill={hasTip ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24">
          {hasTip ? (
            <path fillRule="evenodd" clipRule="evenodd" d="M12 2a10 10 0 100 20 10 10 0 000-20zm.75 5a.75.75 0 00-1.5 0v.5h-.5a2.25 2.25 0 000 4.5h2a.75.75 0 010 1.5h-3a.75.75 0 000 1.5h1.5v.5a.75.75 0 001.5 0V15h.5a2.25 2.25 0 000-4.5h-2a.75.75 0 010-1.5h3a.75.75 0 000-1.5h-1.5V7z" />
          ) : (
            <>
              <circle cx="12" cy="12" r="9" strokeWidth={2} />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.5 9.5a3 3 0 00-3-1.5h-1a2 2 0 000 4h2a2 2 0 010 4h-1.5a3 3 0 01-3-1.5M12 7v1.5m0 7V17" />
            </>
          )}
        </svg>
        {hasTip && (
          <span className="absolute -top-1 -right-1 bg-yellow-500 text-black text-[10px] font-bold rounded-full px-1 min-w-4 h-4 flex items-center justify-center shadow">
            ${value!.tipUsd >= 100 ? Math.round(value!.tipUsd) : value!.tipUsd}
          </span>
        )}
      </button>

      {open && popPos && createPortal(
        <div
          ref={popRef}
          role="dialog"
          style={{ position: 'fixed', left: popPos.x, top: popPos.y, width: 320, zIndex: 60 }}
          className={`rounded-xl shadow-2xl border ${
            isDark ? 'bg-zinc-900 border-white/10 text-white' : 'bg-white border-gray-200 text-gray-900'
          } p-4 space-y-3`}
        >
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold">
              {t('post_form.tip.title', { defaultValue: 'Tip alongside your post' })}
            </span>
            {hasTip && (
              <button
                type="button"
                onClick={handleClear}
                className={`text-xs ${themeTextMuted(isDark)} hover:underline cursor-pointer`}
              >
                {t('post_form.tip.remove', { defaultValue: 'Remove' })}
              </button>
            )}
          </div>

          {/* Recipient picker */}
          <div className="space-y-1">
            <label className={`text-xs font-medium ${themeTextSecondary(isDark)}`}>
              {t('post_form.tip.recipient', { defaultValue: 'Recipient' })}
            </label>
            {recipient ? (
              <div className={`flex items-center justify-between rounded-lg px-2 py-1.5 ${
                isDark ? 'bg-white/10' : 'bg-gray-100'
              }`}>
                <div className="flex items-center gap-2 min-w-0">
                  <img
                    src={getUserAvatar({ tokenId: recipient.tokenId, avatarUrl: recipient.avatarUrl })}
                    alt={recipient.username}
                    className="w-6 h-6 rounded-full"
                  />
                  <span className="text-sm truncate">
                    {recipient.displayName ? (
                      <>
                        <span className="font-medium">{recipient.displayName}</span>{' '}
                        <span className={themeTextMuted(isDark)}>@{recipient.username}</span>
                      </>
                    ) : (
                      <>@{recipient.username}</>
                    )}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => { setRecipient(null); setShowSuggestions(true) }}
                  className={`text-xs ${themeTextMuted(isDark)} hover:underline cursor-pointer flex-shrink-0 ml-2`}
                >
                  {t('post_form.tip.change', { defaultValue: 'Change' })}
                </button>
              </div>
            ) : (
              <div className="relative">
                <input
                  type="text"
                  value={recipientQuery}
                  onChange={e => { setRecipientQuery(e.target.value); setShowSuggestions(true) }}
                  onFocus={() => setShowSuggestions(true)}
                  placeholder={t('post_form.tip.recipient_placeholder', { defaultValue: 'Search by username…' })}
                  className={`w-full px-3 py-1.5 rounded-lg text-sm outline-none transition-colors ${
                    isDark
                      ? 'bg-white/10 text-white border border-white/20 focus:border-yellow-500/50 placeholder-gray-500'
                      : 'bg-gray-100 text-gray-900 border border-gray-200 focus:border-yellow-500 placeholder-gray-400'
                  }`}
                />
                {showSuggestions && recipientSuggestions.length > 0 && (
                  <ul className={`absolute left-0 right-0 mt-1 max-h-48 overflow-auto rounded-lg shadow-lg border z-10 ${
                    isDark ? 'bg-zinc-900 border-white/10' : 'bg-white border-gray-200'
                  }`}>
                    {recipientSuggestions.map(u => (
                      <li key={u.tokenId}>
                        <button
                          type="button"
                          onClick={() => { setRecipient(u); setShowSuggestions(false); setRecipientQuery('') }}
                          className={`w-full flex items-center gap-2 px-2 py-1.5 text-left cursor-pointer ${
                            isDark ? 'hover:bg-white/10' : 'hover:bg-gray-100'
                          }`}
                        >
                          <img
                            src={getUserAvatar({ tokenId: u.tokenId, avatarUrl: u.avatarUrl })}
                            alt={u.username}
                            className="w-6 h-6 rounded-full"
                          />
                          <span className="text-sm truncate">
                            {u.displayName ? (
                              <>
                                <span className="font-medium">{u.displayName}</span>{' '}
                                <span className={themeTextMuted(isDark)}>@{u.username}</span>
                              </>
                            ) : (
                              <>@{u.username}</>
                            )}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>

          {/* Preset amounts */}
          <div className="grid grid-cols-4 gap-1.5">
            {PRESET_USD_AMOUNTS.map(preset => (
              <button
                key={preset}
                type="button"
                onClick={() => setUsdInput(preset.toString())}
                className={`px-2 py-1.5 rounded-lg text-sm font-medium cursor-pointer transition-colors ${
                  usdAmount === preset
                    ? 'bg-yellow-500 text-black'
                    : isDark
                      ? 'bg-white/10 text-white hover:bg-white/20'
                      : 'bg-gray-100 text-gray-900 hover:bg-gray-200'
                }`}
              >
                {formatUsd(preset)}
              </button>
            ))}
          </div>

          {/* Custom amount */}
          <div className="relative">
            <span className={`absolute left-3 top-1/2 -translate-y-1/2 text-sm ${themeTextMuted(isDark)}`}>$</span>
            <input
              type="number"
              min={MIN_TIP_USD}
              step="1"
              value={usdInput}
              onChange={e => setUsdInput(e.target.value)}
              placeholder="0"
              className={`w-full pl-7 pr-3 py-1.5 rounded-lg text-sm outline-none transition-colors ${
                isDark
                  ? 'bg-white/10 text-white border border-white/20 focus:border-yellow-500/50 placeholder-gray-500'
                  : 'bg-gray-100 text-gray-900 border border-gray-200 focus:border-yellow-500 placeholder-gray-400'
              }`}
            />
          </div>

          {/* Cost preview */}
          <div className={`text-xs flex justify-between ${themeTextMuted(isDark)}`}>
            <span>{t('post_form.tip.preview_label', { defaultValue: 'Approx.' })}</span>
            <span>{priceReady ? `${tipAmountCaw.toLocaleString()} CAW` : '—'}</span>
          </div>

          {/* Hints */}
          {!priceReady && (
            <p className="text-xs text-yellow-500">
              {t('post_form.tip.loading_price', { defaultValue: 'Loading CAW price…' })}
            </p>
          )}
          {priceReady && usdAmount > 0 && usdAmount < MIN_TIP_USD && (
            <p className={`text-xs ${themeTextMuted(isDark)}`}>
              {t('post_form.tip.min', { defaultValue: `Minimum $${MIN_TIP_USD}.` })}
            </p>
          )}
          {!recipient && (
            <p className={`text-xs ${themeTextMuted(isDark)}`}>
              {t('post_form.tip.need_recipient', { defaultValue: 'Pick a recipient — start with @username to find someone.' })}
            </p>
          )}

          {/* Actions */}
          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className={`flex-1 py-1.5 rounded-lg text-sm font-medium border cursor-pointer ${themeBorder(isDark)} ${
                isDark ? 'text-white hover:bg-white/5' : 'text-gray-900 hover:bg-gray-50'
              }`}
            >
              {t('post_form.tip.cancel', { defaultValue: 'Cancel' })}
            </button>
            <button
              type="button"
              onClick={handleAttach}
              disabled={!canAttach}
              className={`flex-1 py-1.5 rounded-lg text-sm font-semibold cursor-pointer ${
                canAttach
                  ? 'bg-yellow-500 text-black hover:bg-yellow-400'
                  : 'bg-yellow-500/30 text-yellow-500/60 cursor-not-allowed'
              }`}
            >
              {hasTip
                ? t('post_form.tip.update', { defaultValue: 'Update' })
                : t('post_form.tip.attach', { defaultValue: 'Attach' })}
            </button>
          </div>
        </div>,
        document.body
      )}
    </>
  )
}

export default TipAttachmentControl
