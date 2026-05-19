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
/** Contract hard-cap: require(numRecipients <= 10). */
const MAX_TIPS = 10

export interface TipAttachment {
  /** Tip amount in whole CAW tokens. */
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
  /** When replying, the parent caw is the default recipient for the first tip. */
  replyTo?: CawItem
  /** Tokens the user owns — we never tip ourselves, so we hide these from the picker. */
  ownTokenIds: number[]
  /** Current attached tips — empty array when no tips are attached. */
  values: TipAttachment[]
  onChange: (next: TipAttachment[]) => void
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

// Single-tip picker sub-component — shared between the "add first" and
// "add another" flows. Calls onAttach(tip) when the user confirms.
interface PickerProps {
  text: string
  replyTo?: CawItem
  ownTokenIds: number[]
  /** tokenIds already tipped — excluded from the picker to prevent dupes. */
  excludeTokenIds: number[]
  /** Pre-fill a recipient (e.g. for editing). */
  prefillRecipient?: RecipientUser
  prefillUsd?: number
  isDark: boolean
  onAttach: (tip: TipAttachment) => void
  onCancel: () => void
  attachLabel: string
}

const SingleTipPicker: React.FC<PickerProps> = ({
  text, replyTo, ownTokenIds, excludeTokenIds, prefillRecipient, prefillUsd,
  isDark, onAttach, onCancel, attachLabel,
}) => {
  const t = useT()
  const cawPrice = usePriceStore(s => s.priceMap['a-hunters-dream'] ?? 0)
  const priceReady = cawPrice > 0

  const [usdInput, setUsdInput] = useState<string>(String(prefillUsd ?? PRESET_USD_AMOUNTS[0]))
  const [recipient, setRecipient] = useState<RecipientUser | null>(prefillRecipient ?? null)
  const [recipientQuery, setRecipientQuery] = useState('')
  const [recipientSuggestions, setRecipientSuggestions] = useState<RecipientUser[]>([])
  const [showSuggestions, setShowSuggestions] = useState(false)

  const mentionUsernames = useMemo(() => extractMentionUsernames(text), [text])
  const allExcluded = useMemo(() => [...ownTokenIds, ...excludeTokenIds], [ownTokenIds, excludeTokenIds])

  // Default recipient: replyTo > first @mention > nothing (only when no prefill).
  useEffect(() => {
    if (prefillRecipient || recipient) return
    if (replyTo && !allExcluded.includes(replyTo.user.tokenId)) {
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
        if (exact && !allExcluded.includes(exact.tokenId)) setRecipient(exact)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, []) // intentionally run once on mount

  // Debounced search
  useEffect(() => {
    const q = recipientQuery.trim()
    if (!q) {
      if (mentionUsernames.length === 0) { setRecipientSuggestions([]); return }
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
          if (allExcluded.includes(r.tokenId)) continue
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
          setRecipientSuggestions((data?.users ?? []).filter(u => !allExcluded.includes(u.tokenId)).slice(0, 8))
        })
        .catch(() => { if (!cancelled) setRecipientSuggestions([]) })
    }, 180)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [recipientQuery, mentionUsernames, allExcluded])

  const usdAmount = parseFloat(usdInput) || 0
  const tipAmountCaw = usdToCaw(usdAmount, cawPrice)
  const canAttach = priceReady && usdAmount >= MIN_TIP_USD && tipAmountCaw > 0 && !!recipient

  const handleAttach = () => {
    if (!canAttach || !recipient) return
    onAttach({ tipAmountCaw, tipUsd: usdAmount, recipientTokenId: recipient.tokenId, recipientUsername: recipient.username })
  }

  return (
    <div className="space-y-3">
      {/* Recipient picker */}
      <div className="space-y-1">
        <label className={`text-xs font-medium ${themeTextSecondary(isDark)}`}>
          {t('post_form.tip.recipient', { defaultValue: 'Recipient' })}
        </label>
        {recipient ? (
          <div className={`flex items-center justify-between rounded-lg px-2 py-1.5 ${isDark ? 'bg-white/10' : 'bg-gray-100'}`}>
            <div className="flex items-center gap-2 min-w-0">
              <img src={getUserAvatar({ tokenId: recipient.tokenId, avatarUrl: recipient.avatarUrl })} alt={recipient.username} className="w-6 h-6 rounded-full" />
              <span className="text-sm truncate">
                {recipient.displayName ? (
                  <><span className="font-medium">{recipient.displayName}</span>{' '}<span className={themeTextMuted(isDark)}>@{recipient.username}</span></>
                ) : <>@{recipient.username}</>}
              </span>
            </div>
            <button type="button" onClick={() => { setRecipient(null); setShowSuggestions(true) }}
              className={`text-xs ${themeTextMuted(isDark)} hover:underline cursor-pointer flex-shrink-0 ml-2`}>
              {t('post_form.tip.change', { defaultValue: 'Change' })}
            </button>
          </div>
        ) : (
          <div className="relative">
            <input type="text" value={recipientQuery}
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
              <ul className={`absolute left-0 right-0 mt-1 max-h-48 overflow-auto rounded-lg shadow-lg border z-10 ${isDark ? 'bg-zinc-900 border-white/10' : 'bg-white border-gray-200'}`}>
                {recipientSuggestions.map(u => (
                  <li key={u.tokenId}>
                    <button type="button"
                      onClick={() => { setRecipient(u); setShowSuggestions(false); setRecipientQuery('') }}
                      className={`w-full flex items-center gap-2 px-2 py-1.5 text-left cursor-pointer ${isDark ? 'hover:bg-white/10' : 'hover:bg-gray-100'}`}>
                      <img src={getUserAvatar({ tokenId: u.tokenId, avatarUrl: u.avatarUrl })} alt={u.username} className="w-6 h-6 rounded-full" />
                      <span className="text-sm truncate">
                        {u.displayName ? (
                          <><span className="font-medium">{u.displayName}</span>{' '}<span className={themeTextMuted(isDark)}>@{u.username}</span></>
                        ) : <>@{u.username}</>}
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
          <button key={preset} type="button" onClick={() => setUsdInput(preset.toString())}
            className={`px-2 py-1.5 rounded-lg text-sm font-medium cursor-pointer transition-colors ${
              usdAmount === preset
                ? 'bg-yellow-500 text-black'
                : isDark ? 'bg-white/10 text-white hover:bg-white/20' : 'bg-gray-100 text-gray-900 hover:bg-gray-200'
            }`}>
            {formatUsd(preset)}
          </button>
        ))}
      </div>

      {/* Custom amount */}
      <div className="relative">
        <span className={`absolute left-3 top-1/2 -translate-y-1/2 text-sm ${themeTextMuted(isDark)}`}>$</span>
        <input type="number" min={MIN_TIP_USD} step="1" value={usdInput} onChange={e => setUsdInput(e.target.value)} placeholder="0"
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

      {!priceReady && <p className="text-xs text-yellow-500">{t('post_form.tip.loading_price', { defaultValue: 'Loading CAW price…' })}</p>}
      {priceReady && usdAmount > 0 && usdAmount < MIN_TIP_USD && (
        <p className={`text-xs ${themeTextMuted(isDark)}`}>{t('post_form.tip.min', { defaultValue: `Minimum $${MIN_TIP_USD}.` })}</p>
      )}
      {!recipient && (
        <p className={`text-xs ${themeTextMuted(isDark)}`}>{t('post_form.tip.need_recipient', { defaultValue: 'Pick a recipient — start with @username to find someone.' })}</p>
      )}

      <div className="flex gap-2 pt-1">
        <button type="button" onClick={onCancel}
          className={`flex-1 py-1.5 rounded-lg text-sm font-medium border cursor-pointer ${themeBorder(isDark)} ${isDark ? 'text-white hover:bg-white/5' : 'text-gray-900 hover:bg-gray-50'}`}>
          {t('post_form.tip.cancel', { defaultValue: 'Cancel' })}
        </button>
        <button type="button" onClick={handleAttach} disabled={!canAttach}
          className={`flex-1 py-1.5 rounded-lg text-sm font-semibold cursor-pointer ${canAttach ? 'bg-yellow-500 text-black hover:bg-yellow-400' : 'bg-yellow-500/30 text-yellow-500/60 cursor-not-allowed'}`}>
          {attachLabel}
        </button>
      </div>
    </div>
  )
}

const TipAttachmentControl: React.FC<Props> = ({
  text, replyTo, ownTokenIds, values, onChange,
  iconSizeClass = 'w-5 h-5', disabled = false, title,
}) => {
  const { isDark } = useTheme()
  const t = useT()

  const [open, setOpen] = useState(false)
  const [popPos, setPopPos] = useState<{ x: number; y: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)

  // 'list' = showing the attached-tips list (with "add another")
  // 'picker' = showing the single-tip picker (new entry or editing index editingIdx)
  type PanelView = 'list' | 'picker'
  const [view, setView] = useState<PanelView>('list')
  const [editingIdx, setEditingIdx] = useState<number | null>(null)

  const hasTips = values.length > 0
  const totalUsd = values.reduce((s, t) => s + t.tipUsd, 0)

  // Position the popover relative to the button.
  useLayoutEffect(() => {
    if (!open) { setPopPos(null); return }
    const btn = btnRef.current
    if (!btn) return
    const r = btn.getBoundingClientRect()
    const pad = 8
    const el = popRef.current
    const panelW = el?.offsetWidth || 320
    const panelH = el?.offsetHeight || 380
    const xRaw = r.left + r.width / 2 - panelW / 2
    const yBelow = r.bottom + 8
    const yAbove = r.top - panelH - 8
    const fitsBelow = yBelow + panelH <= window.innerHeight - pad
    const x = Math.min(Math.max(pad, xRaw), window.innerWidth - panelW - pad)
    const y = fitsBelow ? yBelow : Math.max(pad, yAbove)
    setPopPos(prev => prev && Math.abs(prev.x - x) < 0.5 && Math.abs(prev.y - y) < 0.5 ? prev : { x, y })
  }, [open])

  // Refinement pass once the popover is in the DOM.
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
    if (Math.abs(popPos.x - x) > 0.5 || Math.abs(popPos.y - y) > 0.5) setPopPos({ x, y })
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

  const handleOpenToggle = () => {
    if (disabled) return
    if (!open) {
      // If no tips yet, go straight to picker; otherwise show the list.
      setView(hasTips ? 'list' : 'picker')
      setEditingIdx(null)
      setOpen(true)
    } else {
      setOpen(false)
    }
  }

  const handlePickerAttach = (tip: TipAttachment) => {
    if (editingIdx !== null) {
      // Replace an existing entry (duplicate-recipient dedupe: handled naturally
      // since we edit by index, not search).
      const next = [...values]
      next[editingIdx] = tip
      onChange(next)
    } else {
      // New entry. Dedupe by recipient: replace if already tipped that person.
      const existing = values.findIndex(v => v.recipientTokenId === tip.recipientTokenId)
      if (existing !== -1) {
        const next = [...values]
        next[existing] = tip
        onChange(next)
      } else {
        onChange([...values, tip])
      }
    }
    // After attaching, return to list view so the user sees the full list.
    setView('list')
    setEditingIdx(null)
  }

  const handleRemove = (idx: number) => {
    onChange(values.filter((_, i) => i !== idx))
  }

  const handleClearAll = () => {
    onChange([])
    setOpen(false)
  }

  // Tip-button active-state styling — mirrors the poll button pattern.
  const activeClasses = hasTips
    ? 'text-yellow-500 bg-yellow-400/10'
    : text.trim()
      ? (isDark
          ? 'text-yellow-400 hover:text-yellow-300 hover:bg-yellow-400/10'
          : 'text-yellow-600 hover:text-yellow-500 hover:bg-yellow-200/50')
      : (isDark
          ? 'text-yellow-400/70 hover:text-yellow-400 hover:bg-yellow-400/10'
          : 'text-yellow-600/70 hover:text-yellow-600 hover:bg-yellow-200/50')

  // The tooltip on the trigger summarises the attached total.
  const triggerAriaLabel = hasTips
    ? t('post_form.tip.aria_attached_multi', {
        defaultValue: `${values.length} tip${values.length > 1 ? 's' : ''} attached — total $${totalUsd}`,
      })
    : t('post_form.tip.aria', { defaultValue: 'Attach a tip' })

  // Already-tipped tokenIds (excluding the one being edited).
  const excludeForPicker = values
    .filter((_, i) => i !== editingIdx)
    .map(v => v.recipientTokenId)

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={handleOpenToggle}
        disabled={disabled}
        title={title || t('post_form.tip.tooltip', { defaultValue: 'Attach tips to your post' })}
        aria-label={triggerAriaLabel}
        className={`relative p-1 rounded-full transition-all duration-200 ${
          disabled ? 'opacity-30 cursor-not-allowed' : 'cursor-pointer'
        } ${activeClasses}`}
      >
        {/* Tip icon: filled coin with an integrated "$" glyph (noun project
            #5805672). Single self-contained path → relies on currentColor
            inheritance for theming + the surrounding activeClasses for the
            active/inactive colour swap, just like every other toolbar icon. */}
        <svg className={iconSizeClass} fill="currentColor" viewBox="0 0 100 100" aria-hidden="true">
          <path d="M49.9999313,2.5001991c-26.249855,0-47.4999313,21.2498207-47.4999313,47.4999275c0,26.2498512,21.2500782,47.4996758,47.4999313,47.4996758s47.4999313-21.2498245,47.4999313-47.4996758C97.5621719,23.7500191,76.2497864,2.5001991,49.9999313,2.5001991z M63.6875267,68.750061c-2.0627289,2.4998856-4.7500458,4.1875-7.9375954,5.0623398c-1.3750648,0.3751068-1.9999123,1.1250763-1.937603,2.5001373c0.062561,1.3748169,0,2.812439,0,4.1872559c0,1.2501984-0.6248474,1.9375992-1.8747902,1.9375992c-1.5001907,0.062561-3.0001221,0.062561-4.5626183,0c-1.3125038,0-1.9373512-0.7499619-1.9373512-2.0624695V77.3125c0-2.2501602-0.1251183-2.3750229-2.2501526-2.6875763c-2.812439-0.4374161-5.5000114-1.0625153-8.0624619-2.3124619c-1.9999123-0.9999542-2.1873398-1.4999313-1.6250572-3.5624008c0.4376717-1.5625,0.8750916-3.1249924,1.3125076-4.6874847c0.5625381-1.8124847,1.0625153-2.0001678,2.6875725-1.1876373c2.812439,1.4376221,5.812561,2.3124619,8.9375496,2.6875687c1.9999123,0.2499924,3.9998207,0.062561,5.8748665-0.7499619c3.5000992-1.5001907,4.0626373-5.5625763,1.0625153-8.0001564c-0.9999542-0.8122749-2.1250305-1.4373741-3.3124161-1.9373512c-3.0624275-1.3750648-6.2499771-2.3750229-9.1249771-4.1249428c-4.6874847-2.812439-7.6876068-6.6876488-7.3124962-12.3750877c0.3748589-6.4374065,4.0623856-10.4997902,9.9375076-12.6248226c2.4373283-0.8750877,2.4373283-0.8750877,2.4373283-3.3749771v-2.5624504c0.062561-1.9376049,0.3751106-2.2501545,2.3124619-2.3127155h1.7501755c4.0623856,0,4.0623856,0,4.1249466,4.0626373c0,2.875,0,2.875,2.875,3.374979c2.1873398,0.374855,4.3123703,0.9999542,6.3125381,1.8750439c1.1248245,0.4999771,1.5624924,1.2499447,1.1873856,2.4373283c-0.4999771,1.7499218-0.999958,3.5626602-1.5624962,5.2500229c-0.5625381,1.6250534-1.0625191,1.875042-2.6250114,1.1250763c-3.1875496-1.5624962-6.4999657-2.1875954-10.0623741-2.0001678C49.3748322,33.6875229,48.5,33.812645,47.6249084,34.1875c-3.0624275,1.3125076-3.5624046,4.6874847-0.9373932,6.749958c1.3125038,1.0625153,2.812439,1.8124809,4.3749313,2.4375801c2.6875725,1.1248245,5.3748894,2.1873398,7.9373398,3.6249695C67.1873703,51.500061,69.4372711,61.7498589,63.6875267,68.750061z" />
        </svg>
        {hasTips && (
          <span className="absolute -top-1 -right-1 bg-yellow-500 text-black text-[10px] font-bold rounded-full px-1 min-w-4 h-4 flex items-center justify-center shadow">
            {values.length > 1
              ? `$${totalUsd >= 100 ? Math.round(totalUsd) : totalUsd} ×${values.length}`
              : `$${values[0].tipUsd >= 100 ? Math.round(values[0].tipUsd) : values[0].tipUsd}`}
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
          {/* Panel header */}
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold">
              {view === 'picker' && editingIdx === null && hasTips
                ? t('post_form.tip.add_another_title', { defaultValue: 'Add another tip' })
                : view === 'picker' && editingIdx !== null
                  ? t('post_form.tip.edit_tip_title', { defaultValue: 'Edit tip' })
                  : t('post_form.tip.title', { defaultValue: 'Tip alongside your post' })}
            </span>
            {view === 'list' && hasTips && (
              <button type="button" onClick={handleClearAll}
                className={`text-xs ${themeTextMuted(isDark)} hover:underline cursor-pointer`}>
                {t('post_form.tip.remove_all', { defaultValue: 'Remove all' })}
              </button>
            )}
            {view === 'picker' && hasTips && (
              <button type="button" onClick={() => { setView('list'); setEditingIdx(null) }}
                className={`text-xs ${themeTextMuted(isDark)} hover:underline cursor-pointer`}>
                {t('post_form.tip.back', { defaultValue: '← Back' })}
              </button>
            )}
          </div>

          {view === 'list' && (
            <>
              {/* Attached tips list */}
              <div className="space-y-2">
                {values.map((tip, idx) => (
                  <div key={tip.recipientTokenId}
                    className={`flex items-center justify-between rounded-lg px-2 py-1.5 ${isDark ? 'bg-white/10' : 'bg-gray-100'}`}>
                    <span className="text-sm truncate">
                      <span className={themeTextMuted(isDark)}>@{tip.recipientUsername}</span>
                      {' '}
                      <span className="font-medium text-yellow-500">${tip.tipUsd >= 100 ? Math.round(tip.tipUsd) : tip.tipUsd}</span>
                    </span>
                    <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                      <button type="button"
                        onClick={() => { setEditingIdx(idx); setView('picker') }}
                        className={`text-xs ${themeTextMuted(isDark)} hover:underline cursor-pointer`}>
                        {t('post_form.tip.edit', { defaultValue: 'Edit' })}
                      </button>
                      <button type="button" onClick={() => handleRemove(idx)}
                        aria-label={`Remove tip to @${tip.recipientUsername}`}
                        className={`text-xs ${themeTextMuted(isDark)} hover:text-red-500 cursor-pointer leading-none`}>
                        ×
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              {/* Add another tip affordance (hidden at cap) */}
              {values.length < MAX_TIPS && (
                <button type="button"
                  onClick={() => { setEditingIdx(null); setView('picker') }}
                  className={`w-full py-1.5 rounded-lg text-sm font-medium border cursor-pointer ${themeBorder(isDark)} ${
                    isDark ? 'text-yellow-400 hover:bg-white/5' : 'text-yellow-600 hover:bg-gray-50'
                  }`}>
                  {t('post_form.tip.add_another', { defaultValue: '+ Add another tip' })}
                </button>
              )}

              {values.length >= MAX_TIPS && (
                <p className={`text-xs ${themeTextMuted(isDark)}`}>
                  {t('post_form.tip.cap_reached', { defaultValue: `Maximum ${MAX_TIPS} tips per post.` })}
                </p>
              )}

              <button type="button" onClick={() => setOpen(false)}
                className={`w-full py-1.5 rounded-lg text-sm font-medium border cursor-pointer ${themeBorder(isDark)} ${
                  isDark ? 'text-white hover:bg-white/5' : 'text-gray-900 hover:bg-gray-50'
                }`}>
                {t('post_form.tip.done', { defaultValue: 'Done' })}
              </button>
            </>
          )}

          {view === 'picker' && (
            <SingleTipPicker
              text={text}
              replyTo={replyTo}
              ownTokenIds={ownTokenIds}
              excludeTokenIds={excludeForPicker}
              prefillRecipient={editingIdx !== null
                ? { tokenId: values[editingIdx].recipientTokenId, username: values[editingIdx].recipientUsername }
                : undefined}
              prefillUsd={editingIdx !== null ? values[editingIdx].tipUsd : undefined}
              isDark={isDark}
              onAttach={handlePickerAttach}
              onCancel={() => {
                if (hasTips) { setView('list'); setEditingIdx(null) }
                else setOpen(false)
              }}
              attachLabel={editingIdx !== null
                ? t('post_form.tip.update', { defaultValue: 'Update' })
                : t('post_form.tip.attach', { defaultValue: 'Attach' })}
            />
          )}
        </div>,
        document.body
      )}
    </>
  )
}

export default TipAttachmentControl
