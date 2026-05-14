import React, { useState, useRef, useEffect, useLayoutEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import toast from 'react-hot-toast'
import { Link } from '~/utils/localizedRouter'
import { useSignAndSubmitAction, buildTypedData, TYPES, allocateCawonces } from '../api/actions'

/** Hard cap on thread length. Must match the API cap in
 *  `client/src/api/routes/actions.ts` (POST /api/actions/batch). The cap
 *  exists for both UX (64 posts is more than enough) and to keep the
 *  ActionBatch sig safely below the validator's 120KB calldata bound —
 *  see the comment on the API limit for the full safety reasoning. */
const MAX_THREAD_LENGTH = 64
import { useTokenDataStore, useActiveToken } from "~/store/tokenDataStore";
import { useAccount, useConnections, useSignTypedData } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import type { ActionParams } from '~/api/actions'
import type { CawItem } from '~/types'
import { useTheme } from '~/hooks/useTheme'
import { DesktopDatePicker, DesktopTimePicker } from '~/components/forms/DesktopDateTimePicker'
import { getUserAvatar } from '~/utils/defaultAvatar'
import { BsWallet } from 'react-icons/bs'
import MediaUpload from './MediaUpload'
import { useHasActiveSession } from '~/hooks/useHasActiveSession'
import { usePendingPostsStore } from '~/store/pendingPostsStore'
import { useComposeDraftStore } from '~/store/composeDraftStore'
import { useUserByUsername } from '~/hooks/useUserData'
import Tooltip from '~/components/Tooltip'
import { apiFetch } from '~/api/client'
import { HiCalendar, HiClock, HiX } from 'react-icons/hi'
import MentionAutocomplete from './MentionAutocomplete'
import GifPicker from './GifPicker'
import PollComposer from './PollComposer'
import TipAttachmentControl, { type TipAttachment } from './TipAttachmentControl'
import AiProviderConnectModal from './modals/AiProviderConnectModal'
import AiImageGenerateModal from './modals/AiImageGenerateModal'
import { useAIProviderStore } from '~/store/aiProviderStore'
import { useNavigate } from '~/utils/localizedRouter'
import { HiOutlineChartBar } from 'react-icons/hi'
import { buildPollMarker, imageUrlToPollHash, imageUrlToMeta } from '~/../../../tools/pollMarker'

// AI button icon: just sparkles.
// Rationale: letters/frames read like a sticker and look off next to toolbar icons.
// IMPORTANT: keep strokeWeight consistent with the rest of the toolbar (2).
const AiGlitterIcon: React.FC<{ sizeClass: string }> = ({ sizeClass }) => (
  <svg className={sizeClass} viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
    {/* Sparkles — outline, centered */}
    {/* Slightly larger and nudged down to visually center inside circular button */}
    {/* NOTE: sparkles read visually heavier than other outline icons; use slightly thinner stroke */}
    <g transform="translate(12 12) scale(1.12) translate(-12 -12) translate(-1.6 2.6)">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.8}
        vectorEffect="non-scaling-stroke"
        d="M12 3.5l.8 2.7a3.6 3.6 0 002.5 2.5l2.7.8-2.7.8a3.6 3.6 0 00-2.5 2.5l-.8 2.7-.8-2.7a3.6 3.6 0 00-2.5-2.5l-2.7-.8 2.7-.8a3.6 3.6 0 002.5-2.5L12 3.5z"
      />
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.8}
        vectorEffect="non-scaling-stroke"
        d="M18 6.2l.3 1a2.1 2.1 0 001.4 1.4l1 .3-1 .3a2.1 2.1 0 00-1.4 1.4l-.3 1-.3-1a2.1 2.1 0 00-1.4-1.4l-1-.3 1-.3a2.1 2.1 0 001.4-1.4l.3-1z"
      />
    </g>
  </svg>
)

/** Extract a short, meaningful search query from post text for GIF search.
 *  Drops articles/prepositions/conjunctions, URLs, and @mentions,
 *  then takes the last 5 remaining words. */
function gifSearchQuery(text: string): string {
  const stopWords = new Set([
    'a','an','the','is','are','was','were','be','been','being',
    'in','on','at','to','for','of','with','by','from','as',
    'and','or','but','nor','so','yet','not','no','if','then',
    'i','me','my','we','our','you','your','he','she','it','they',
    'this','that','these','those','its','his','her','their',
    'do','does','did','has','have','had','will','would','can','could',
    'just','also','very','really','about','into','over','after','before',
  ])
  const words = text
    .replace(/https?:\/\/\S+/g, '')   // drop URLs
    .replace(/@\w+/g, '')             // drop mentions
    .replace(/[#$]\w+/g, '')          // drop hashtags/cashtags
    .replace(/[^\w\s]/g, ' ')         // strip punctuation
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w.length > 1 && !stopWords.has(w))
  return words.slice(-5).join(' ')
}
import HighlightedTextarea from './HighlightedTextarea'
import { useT } from '~/i18n/I18nProvider'
import { acquireScrollLock, releaseScrollLock } from '~/utils/scrollLock'

const POST_CHAR_LIMIT = 420 // bytes — matches the on-chain check `bytes(text).length <= 420`

// Count UTF-8 byte length, matching the on-chain check.
// JS string.length returns UTF-16 code units, which under-counts ASCII vs bytes for some chars.
const _textEncoder = new TextEncoder()
function byteLen(s: string): number {
  return _textEncoder.encode(s).length
}

// Find the largest prefix of `s` whose UTF-8 byte length is ≤ maxBytes.
// Returns the character-index (string offset) of the slice end. Never splits a codepoint.
function clampToByteLimit(s: string, maxBytes: number): number {
  if (maxBytes <= 0) return 0
  let bytes = 0
  for (let i = 0; i < s.length; ) {
    const code = s.codePointAt(i)!
    const charLen = code > 0xFFFF ? 2 : 1 // surrogate pair = 2 UTF-16 units
    let cpBytes
    if (code < 0x80) cpBytes = 1
    else if (code < 0x800) cpBytes = 2
    else if (code < 0x10000) cpBytes = 3
    else cpBytes = 4
    if (bytes + cpBytes > maxBytes) return i
    bytes += cpBytes
    i += charLen
  }
  return s.length
}

// Find the last space before (or at) the given character index whose prefix fits within maxBytes.
// Falls back to the byte-clamped hard split if no space is found.
function findSplitPoint(s: string, maxBytes: number): number {
  // First, find the largest character index whose prefix fits in maxBytes
  const hardLimit = clampToByteLimit(s, maxBytes)
  if (hardLimit >= s.length) return s.length
  // Try to find a space at or before hardLimit
  const spaceAt = s.lastIndexOf(' ', hardLimit)
  if (spaceAt > 0) return spaceAt
  return hardLimit
}

/**
 * Split text into chunks that fit within the character limit.
 * Breaks at word boundaries. Optionally prepends (1/N) page indicators.
 */
function splitTextIntoChunks(text: string, includePageIndicators: boolean): string[] {
  if (byteLen(text) <= POST_CHAR_LIMIT) return [text]

  const chunks: string[] = []
  let remaining = text

  // First pass: split by words respecting the byte limit (without indicators, to count chunks)
  while (remaining.length > 0) {
    if (byteLen(remaining) <= POST_CHAR_LIMIT) {
      chunks.push(remaining)
      break
    }
    const splitAt = findSplitPoint(remaining, POST_CHAR_LIMIT)
    chunks.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt).trimStart()
  }

  if (!includePageIndicators) return chunks

  // Second pass: re-split accounting for indicator prefix length (in bytes — indicators are ASCII)
  const totalChunks = chunks.length
  const result: string[] = []
  remaining = text
  // Re-estimate total — iterate to converge
  let estimatedTotal = totalChunks
  for (let attempt = 0; attempt < 3; attempt++) {
    result.length = 0
    remaining = text
    let chunkIndex = 0
    while (remaining.length > 0) {
      const indicator = `(${chunkIndex + 1}/${estimatedTotal}) `
      const available = POST_CHAR_LIMIT - indicator.length // indicator is ASCII so byteLen = .length
      if (byteLen(remaining) <= available) {
        result.push(indicator + remaining)
        break
      }
      const splitAt = findSplitPoint(remaining, available)
      result.push(indicator + remaining.slice(0, splitAt))
      remaining = remaining.slice(splitAt).trimStart()
      chunkIndex++
    }
    if (result.length === estimatedTotal) break
    estimatedTotal = result.length
  }
  return result
}

/**
 * Calculate which chunk the cursor is in, and the chunk boundaries,
 * for display purposes. When includePageIndicators is true, reserves
 * space for the "(1/N) " prefix in each chunk.
 */
function getChunkInfo(text: string, includePageIndicators = false, firstChunkReserved = 0, lastChunkReserved = 0): { chunkCount: number; chunkBoundaries: number[] } {
  // All limits are in BYTES. firstChunkReserved/lastChunkReserved are ASCII media-ref byte budgets,
  // so they're already byte counts. Boundaries are returned as character (string) indices since
  // downstream code uses them with text.slice(start, end).
  const firstChunkLimit = POST_CHAR_LIMIT - firstChunkReserved
  if (byteLen(text) <= firstChunkLimit - lastChunkReserved) return { chunkCount: 1, chunkBoundaries: [0] }

  // Helper to get the available bytes for a given chunk
  const getLimit = (chunkIdx: number, total: number, indicatorLen: number) => {
    let limit = chunkIdx === 0 ? firstChunkLimit : POST_CHAR_LIMIT
    // Reserve space in the last chunk for media
    if (lastChunkReserved > 0 && chunkIdx === total - 1) limit -= lastChunkReserved
    return limit - indicatorLen
  }

  // First pass without indicators to estimate chunk count
  let estimatedTotal = 0
  {
    const boundaries: number[] = [0]
    let remaining = text
    let chunkIdx = 0
    while (remaining.length > 0) {
      const limit = chunkIdx === 0 ? firstChunkLimit : POST_CHAR_LIMIT
      if (byteLen(remaining) <= limit) break
      const splitAt = findSplitPoint(remaining, limit)
      remaining = remaining.slice(splitAt).trimStart()
      boundaries.push(0)
      chunkIdx++
    }
    estimatedTotal = boundaries.length
    // Check if last chunk overflows with reserved space
    if (lastChunkReserved > 0 && byteLen(remaining) > POST_CHAR_LIMIT - lastChunkReserved) {
      estimatedTotal++
    }
  }

  // Determine if media needs its own dedicated chunk (no text, just media).
  const mediaNeedsOwnChunk = lastChunkReserved > 0 && estimatedTotal > 0 && (() => {
    const boundaries: number[] = [0]
    let remaining = text
    let chunkIdx = 0
    while (remaining.length > 0) {
      const indicatorLen = includePageIndicators ? `(${chunkIdx + 1}/${estimatedTotal}) `.length : 0
      const limit = (chunkIdx === 0 ? firstChunkLimit : POST_CHAR_LIMIT) - indicatorLen
      if (byteLen(remaining) <= limit) break
      const splitAt = findSplitPoint(remaining, limit)
      remaining = remaining.slice(splitAt).trimStart()
      boundaries.push(0)
      chunkIdx++
    }
    const lastIndicatorLen = includePageIndicators ? `(${boundaries.length}/${estimatedTotal}) `.length : 0
    const lastChunkAvailable = POST_CHAR_LIMIT - lastIndicatorLen
    return byteLen(remaining) + lastChunkReserved > lastChunkAvailable
  })()

  // Second pass with indicator space and last-chunk reserve
  for (let attempt = 0; attempt < 3; attempt++) {
    const boundaries: number[] = [0]
    let remaining = text
    let offset = 0
    let chunkIndex = 0

    while (remaining.length > 0) {
      const indicatorLen = includePageIndicators ? `(${chunkIndex + 1}/${estimatedTotal}) `.length : 0
      const available = getLimit(chunkIndex, mediaNeedsOwnChunk ? Infinity : estimatedTotal, indicatorLen)

      if (byteLen(remaining) <= available) break
      const splitAt = findSplitPoint(remaining, available)
      offset += splitAt
      const trimmed = remaining.slice(splitAt)
      const trimmedLen = trimmed.length - trimmed.trimStart().length
      offset += trimmedLen
      boundaries.push(offset)
      remaining = remaining.slice(splitAt).trimStart()
      chunkIndex++
    }

    if (mediaNeedsOwnChunk) {
      boundaries.push(text.length)
      return { chunkCount: boundaries.length, chunkBoundaries: boundaries }
    }

    if (boundaries.length === estimatedTotal || !includePageIndicators) {
      return { chunkCount: boundaries.length, chunkBoundaries: boundaries }
    }
    estimatedTotal = boundaries.length
  }

  // Fallback
  return { chunkCount: estimatedTotal, chunkBoundaries: [0] }
}

// URL detection regex - matches http(s) URLs
// Excludes quotes and trailing punctuation so `'url'` or "url" don't swallow the quote chars
const URL_REGEX = /https?:\/\/[^\s<>"'{}|\\^`[\]]+[^\s<>"'{}|\\^`[\].,!?;:)\]]/gi

// Helper function to shorten URLs in text
async function shortenUrlsInText(text: string): Promise<string> {
  const urls = text.match(URL_REGEX)
  if (!urls || urls.length === 0) return text

  // Deduplicate URLs and skip already-shortened ones — re-shortening a
  // /s/CODE produces a chain of short URLs whose terminal originalUrl is
  // another short URL, which the feed renderer then displays as link text
  // instead of the actual long URL the user originally typed.
  const uniqueUrls = [...new Set(urls)].filter(u => !/\/s\/[a-zA-Z0-9]+/.test(u))
  if (uniqueUrls.length === 0) return text

  try {
    const response = await apiFetch('/api/shorturl/bulk', {
      method: 'POST',
      body: JSON.stringify({ urls: uniqueUrls })
    }) as { results: Record<string, { shortUrl: string }> }

    // If the response came back without entries for some inputs (e.g.
    // partial failure inside the route's per-URL loop), surface that —
    // a partial wrap means the full URL ends up on-chain even though
    // the user opted into shortening, which silently breaks the post's
    // text/videoData split downstream (extractor strips the URL from
    // text → empty content; see actionHandlers.ts handleCawAction).
    const missing = uniqueUrls.filter(u => !response.results[u])
    if (missing.length > 0) {
      console.warn(
        `[shortenUrlsInText] /api/shorturl/bulk returned no entry for ${missing.length} of ${uniqueUrls.length} URLs — those will post un-shortened:`,
        missing,
      )
    }

    let shortenedText = text
    for (const [originalUrl, data] of Object.entries(response.results)) {
      // Replace all occurrences of this URL with the short URL
      shortenedText = shortenedText.split(originalUrl).join(data.shortUrl)
    }

    return shortenedText
  } catch (error) {
    // Don't fail the post on shortening errors, but log loudly so the
    // root cause is visible in the console. Without this the bulk call
    // can fail invisibly and the user sees a post with empty content
    // (the extractor strips the long URL from text into videoData).
    console.warn('[shortenUrlsInText] /api/shorturl/bulk failed, posting URLs un-shortened:', error)
    return text
  }
}

interface PostFormProps {
  /** if provided, we're replying to this caw */
  replyTo?: CawItem;
  quote?: CawItem;
  /** called after a successful sign+submit */
  onSuccess?: () => void;
  placeholder?: string;
  /** force the spacious compose layout (used by the mobile compose sheet) */
  composeMode?: boolean;
  /** when true, publish draft state to the compose store so the mobile bottom nav can hide while typing */
  trackDraft?: boolean;
  /**
   * Focus the textarea on mount. Default true (modals/reply boxes the user
   * opened intentionally want the caret ready). The inline home-feed
   * composer passes false: tapping the bottom-nav home icon mounts it and
   * an unconditional focus pops the iOS keyboard with no input intent (#202).
   */
  autoFocus?: boolean;
}

const PostForm: React.FC<PostFormProps> = ({ replyTo, quote, onSuccess, placeholder, composeMode = false, trackDraft = false, autoFocus = true }) => {
  const { isConnected } = useAccount();
  const { openConnectModal } = useConnectModal();
  const hasActiveSession = useHasActiveSession();
  const connections = useConnections();
  const { isDark } = useTheme()
  const t = useT()

  const [aiModalOpen, setAiModalOpen] = useState(false)
  const [aiGenOpen, setAiGenOpen] = useState(false)
  const aiNavigate = useNavigate()
  const aiConnected = useAIProviderStore((s) => !!s.apiKey && !!s.provider)
  // AI-images entry point: generate when a provider is connected, otherwise
  // prompt to connect one (modal -> /settings/ai-provider).
  const openAiImages = () => (aiConnected ? setAiGenOpen(true) : setAiModalOpen(true))
  const handleAiImage = (file: File) => {
    if (selectedMedia.filter((m: any) => m.type === 'image' || m.type === 'gif').length >= 4) return
    setSelectedMedia((prev: any[]) => [...prev, {
      file, type: 'image', preview: URL.createObjectURL(file), size: file.size, storageType: 'off-chain',
    }])
  }

  // Auto-focus the textarea when component mounts (e.g., when modal opens).
  // Skipped for the inline home-feed composer (autoFocus=false) so landing
  // on /home via the bottom-nav home icon doesn't pop the iOS keyboard (#202).
  useEffect(() => {
    if (autoFocus && textareaRef.current) {
      textareaRef.current.focus()
    }
  }, [autoFocus])

  // Tab key in textarea moves focus to the submit button
  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault()
        submitBtnRef.current?.focus()
      }
    }
    ta.addEventListener('keydown', handler)
    return () => ta.removeEventListener('keydown', handler)
  }, [])

  const [text, setText] = useState('')
  const [cursorPosition, setCursorPosition] = useState(0)

  // Publish draft state so MainLayout can hide the mobile bottom nav while typing
  const setHasInlineDraft = useComposeDraftStore(s => s.setHasInlineDraft)
  useEffect(() => {
    if (!trackDraft) return
    setHasInlineDraft(text.trim().length > 0)
    return () => setHasInlineDraft(false)
  }, [trackDraft, text, setHasInlineDraft])
  // User-facing toggle for the shorten-URLs behavior. When on (default), we
  // silently map original URLs to short URLs and use the short form for the
  // byte counter and on-chain submission. When off, URLs pass through
  // untouched and the counter reflects the full URL length.
  const [shortenUrls, setShortenUrls] = useState(true)
  // Maps original URLs to their shortened versions. The user always sees their
  // original text — short URLs are only used for character counting and on-chain submission.
  const urlMappings = useRef<Map<string, string>>(new Map())
  // Tracks which URLs we've already attempted to shorten so we don't re-call the API
  const shortenedUrls = useRef<Set<string>>(new Set())

  // Auto-shorten URLs as the user types (background, no visible text change).
  // We only shorten URLs that are "finalized" (followed by whitespace or end-of-string).
  useEffect(() => {
    if (!text) return
    if (!shortenUrls) return
    const FINALIZED_URL = /(https?:\/\/[^\s<>"'{}|\\^`[\]]+[^\s<>"'{}|\\^`[\].,!?;:)\]])(?=\s|$)/g
    const toShorten: string[] = []
    let m: RegExpExecArray | null
    while ((m = FINALIZED_URL.exec(text)) !== null) {
      const url = m[1]
      if (/\/s\/[a-zA-Z0-9]+/.test(url)) continue
      if (shortenedUrls.current.has(url)) continue
      toShorten.push(url)
    }
    if (toShorten.length === 0) return

    const timer = setTimeout(async () => {
      toShorten.forEach(u => shortenedUrls.current.add(u))
      try {
        const response = await apiFetch('/api/shorturl/bulk', {
          method: 'POST',
          body: JSON.stringify({ urls: toShorten }),
        }) as { results: Record<string, { shortUrl: string }> }
        for (const [originalUrl, data] of Object.entries(response.results)) {
          urlMappings.current.set(originalUrl, data.shortUrl)
        }
      } catch {
        toShorten.forEach(u => shortenedUrls.current.delete(u))
      }
    }, 500)
    return () => clearTimeout(timer)
  }, [text, shortenUrls])

  /** Replace original URLs with short URLs for on-chain submission.
   *  Honors the shortenUrls toggle — when disabled, returns input unchanged. */
  function getOnChainText(input: string): string {
    if (!shortenUrls) return input
    let result = input
    for (const [original, short] of urlMappings.current) {
      result = result.split(original).join(short)
    }
    return result
  }

  /** Byte length of text as it will appear on-chain (with short URLs) */
  function onChainByteLen(input: string): number {
    return byteLen(getOnChainText(input))
  }
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const submitBtnRef = useRef<HTMLButtonElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // Per-chunk textarea refs for thread mode (N separate textareas).
  const chunkRefs = useRef<Array<HTMLTextAreaElement | null>>([])
  // Which chunk last had focus, and the cursor position within that chunk's local text.
  const [activeChunkIndex, setActiveChunkIndex] = useState(0)
  const [activeChunkCursor, setActiveChunkCursor] = useState(0)
  // Cross-chunk "select all" state. Native browsers can't select across
  // separate <textarea> elements, so Cmd/Ctrl-A within any chunk only
  // highlights that one chunk. We emulate select-all-across-thread:
  //   - Cmd/Ctrl-A in any chunk → set allChunksSelected = true, tint every chunk
  //   - Then Copy / Cut → clipboard gets the master text; Cut also clears
  //   - Then Backspace / Delete → clear master text
  //   - Then a printable key (or onBeforeInput) → replace master with typed char
  //   - Any click / arrow / focus change → clear the all-selected state
  const [allChunksSelected, setAllChunksSelected] = useState(false)
  // Anchor refs for the GIF / emoji popovers. We portal the popovers
  // to document.body so they aren't clipped by overflow:hidden /
  // overflow:auto ancestors (the home inline composer, ComposeModal,
  // etc.), and use the button's bounding rect to position them just
  // above the button.
  const gifButtonRef = useRef<HTMLButtonElement>(null)
  const emojiButtonRef = useRef<HTMLButtonElement>(null)
  const [selectedMedia, setSelectedMedia] = useState<any[]>([])
  const [isDragOverTextarea, setIsDragOverTextarea] = useState(false)
  const [showGifPicker, setShowGifPicker] = useState(false)
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)
  // #207: true while the picker is fading out before unmount (close-on-scroll).
  const [emojiClosing, setEmojiClosing] = useState(false)
  type AnchorRect = { left: number; right: number; top: number; bottom: number }
  const [emojiPopover, setEmojiPopover] = useState<null | {
    x: number
    y: number
    anchor: AnchorRect
  }>(null)
  const emojiPopoverRef = useRef<HTMLDivElement>(null)
  const [showScheduler, setShowScheduler] = useState(false)
  const [scheduledDate, setScheduledDate] = useState('')
  const [scheduledTime, setScheduledTime] = useState('')
  const [schedulePicker, setSchedulePicker] = useState<null | 'date' | 'time'>(null)
  const [isScheduling, setIsScheduling] = useState(false)
  const [scheduleError, setScheduleError] = useState<string | null>(null)
  const [showMediaUpload, setShowMediaUpload] = useState(false)
  const [showMediaOverlay, setShowMediaOverlay] = useState(false)
  const [showScheduledSuccessModal, setShowScheduledSuccessModal] = useState(false)
  const [scheduledSuccessTime, setScheduledSuccessTime] = useState<Date | null>(null)
  const [includePageIndicators, setIncludePageIndicators] = useState(true)
  const [mediaPosition, setMediaPosition] = useState<'start' | 'end'>('start')
  // Poll compose state. Options are edited as a separate array; the marker
  // gets spliced into the text on save (and removed when the user clears).
  // pollPosition mirrors mediaPosition: when threading, where to attach the
  // (atomic) ::poll:...:: block.
  const [pollOptions, setPollOptions] = useState<string[]>([])
  // Per-option image URLs, positional, parallel to pollOptions. Empty
  // string slot = no image. Persisted off-chain via the API submit body
  // (NOT inside the signed action data, since URLs are not part of the
  // on-chain marker).
  const [pollOptionImages, setPollOptionImages] = useState<string[]>([])
  const [pollEnabled, setPollEnabled] = useState(false)
  const [pollPosition, setPollPosition] = useState<'start' | 'end'>('end')
  // Voting window for the poll, encoded on-chain via the ::pd:<dur>::
  // marker sidecar. Validator + indexer reject vote actions whose
  // server-now is past (caw.createdAt + duration). Default 1d
  // matches the picker default in pollMarker.ts.
  const [pollDuration, setPollDuration] = useState<string>('1d')
  // Multi-select flag (::pm:: marker sidecar). When set, voters can
  // toggle any subset of options instead of picking exactly one.
  const [pollMultiSelect, setPollMultiSelect] = useState(false)
  // Tips embedded directly in the CAW action's recipients[]/amounts[]. Up to
  // 10 tips per post (contract cap). Cleared on submit-success / reset.
  const [tipAttachments, setTipAttachments] = useState<TipAttachment[]>([])
  // Reset the tips whenever we swap to a different reply target — the picker's
  // default recipient (parent author) only makes sense for the active context.
  useEffect(() => {
    setTipAttachments([])
  }, [replyTo?.id, quote?.id])
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [signingProgress, setSigningProgress] = useState<{ current: number; total: number } | null>(null)
  const signingTotal = signingProgress?.total ?? 0
  // Pre-signing phase progress: media compression + upload. Without this
  // the submit button reads "Signing..." while we're actually still
  // uploading a 30s-transcoding video, which is misleading. Cleared
  // before the signing loop starts.
  const [uploadProgress, setUploadProgress] = useState<string | null>(null)
  // Refs to the count-up <span>s inside each submit button variant. We write
  // textContent directly to avoid re-rendering the whole form on every tick —
  // signing is main-thread heavy, and React reconciliation would starve it.
  const signingCountRef1 = useRef<HTMLSpanElement | null>(null)
  const signingCountRef2 = useRef<HTMLSpanElement | null>(null)

  // Mobile emoji picker should open near the emoji button, not glued to the bottom.
  // We compute an initial position on click, then measure the panel and clamp
  // before paint to avoid the "jump" glitch.
  useLayoutEffect(() => {
    if (!showEmojiPicker || !emojiPopover) return
    const el = emojiPopoverRef.current
    if (!el) return

    const { width: panelW, height: panelH } = el.getBoundingClientRect()
    const pad = 8
    const gap = 8
    const bounds = {
      left: pad,
      right: window.innerWidth - pad,
      top: pad,
      bottom: window.innerHeight - pad,
    }

    const a = emojiPopover.anchor
    const anchorCx = (a.left + a.right) / 2
    const xRaw = anchorCx - panelW / 2

    const yBelow = a.bottom + gap
    const yAbove = a.top - panelH - gap
    const hasRoomBelow = yBelow + panelH <= bounds.bottom
    const hasRoomAbove = yAbove >= bounds.top
    const yRaw = hasRoomBelow
      ? yBelow
      : (hasRoomAbove ? yAbove : (a.top - panelH / 2))

    const x = Math.min(Math.max(bounds.left, xRaw), bounds.right - panelW)
    const y = Math.min(Math.max(bounds.top, yRaw), bounds.bottom - panelH)

    if (Math.abs(x - emojiPopover.x) > 0.5 || Math.abs(y - emojiPopover.y) > 0.5) {
      setEmojiPopover(prev => prev ? { ...prev, x, y } : prev)
    }
  }, [showEmojiPicker, emojiPopover])
  useEffect(() => {
    if (!signingTotal) return
    // Pace the full count-up to roughly 2s regardless of thread length; floor
    // the per-step interval at 8ms so small threads don't blitz past too fast.
    const stepMs = Math.min(80, Math.max(8, 2200 / signingTotal))
    const start = performance.now()
    let rafId = 0
    const tick = (now: number) => {
      const target = Math.min(signingTotal, Math.max(1, Math.floor((now - start) / stepMs)))
      const text = `${target}`
      if (signingCountRef1.current) signingCountRef1.current.textContent = text
      if (signingCountRef2.current) signingCountRef2.current.textContent = text
      if (target < signingTotal) rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  }, [signingTotal])
  const activeTokenId = useTokenDataStore(state => state.activeTokenId);
  const activeToken = useActiveToken();
  const avatars = useTokenDataStore(s => s.avatarsByTokenId);
  const { data: activeUserData } = useUserByUsername(activeToken?.username);
  const signAndSubmit = useSignAndSubmitAction()
  const { signTypedDataAsync } = useSignTypedData()
  const bumpCawonce = useTokenDataStore(s => s.bumpCawonce)
  const addPendingPost = usePendingPostsStore((state) => state.addPendingPost)
  const updatePostWithTxQueueId = usePendingPostsStore((state) => state.updatePostWithTxQueueId)

  const { address } = useAccount();

  // Check if the user owns the selected token
  const isTokenOwner = activeToken && address && activeToken.owner?.toLowerCase() === address.toLowerCase();
  const hasNoToken = !activeToken?.tokenId;
  // Allow posting whenever there's an active profile. If the wallet isn't
  // connected, signAndSubmit opens the connect modal and auto-retries. If on
  // the wrong chain, it auto-switches before signing. No need to gate the
  // button on those here — let the user click and we'll handle it.
  const canPost = !hasNoToken && (hasActiveSession || isTokenOwner || !isConnected);

  const handleMediaSelected = (media: any[]) => {
    setSelectedMedia(media)
  }

  const handleMediaRemoved = (index?: number) => {
    if (typeof index === 'number' && index >= 0 && index < selectedMedia.length) {
      setSelectedMedia(prev => {
        const newMedia = [...prev]
        newMedia.splice(index, 1)
        return newMedia
      })
    } else if (index === undefined) {
      setSelectedMedia([])
    }
  }

  // Handle GIF selection from picker - shorten URL immediately
  const handleGifSelected = async (gif: { id: string; url: string; title: string; preview: string; width: number; height: number }) => {
    // Check image limit (GIFs count towards the 4 image limit)
    const currentImageCount = selectedMedia.filter(m => m.type === 'image' || m.type === 'gif').length
    if (currentImageCount >= 4) {
      setShowGifPicker(false)
      return
    }

    // Shorten the GIF URL immediately
    let shortUrl = gif.url
    try {
      const response = await apiFetch('/api/shorturl', {
        method: 'POST',
        body: JSON.stringify({ url: gif.url })
      }) as { shortUrl: string; code: string }
      shortUrl = response.shortUrl
    } catch (error) {
      // Continue with original URL if shortening fails
    }

    // Add GIF as a media item with shortened URL
    const gifMedia = {
      type: 'gif' as const,
      url: shortUrl, // Use shortened URL
      originalUrl: gif.url, // Keep original for preview display
      preview: gif.preview,
      title: gif.title,
      width: gif.width,
      height: gif.height,
      storageType: 'off-chain'
    }
    setSelectedMedia(prev => [...prev, gifMedia])
    setShowGifPicker(false)
  }

  // Handle file input selection
  const handleFileInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return

    const newMedia: any[] = []
    let droppedImages = 0
    let droppedVideos = 0

    for (const file of Array.from(files)) {
      const isImage = file.type.startsWith('image/')
      const isVideo = file.type.startsWith('video/')

      if (!isImage && !isVideo) continue

      // Check limits
      const currentImages = selectedMedia.filter(m => m.type === 'image').length
      const currentVideos = selectedMedia.filter(m => m.type === 'video').length

      if (isImage && currentImages + newMedia.filter(m => m.type === 'image').length >= 4) {
        droppedImages++
        continue
      }
      if (isVideo && currentVideos + newMedia.filter(m => m.type === 'video').length >= 1) {
        droppedVideos++
        continue
      }

      const mediaFile = {
        file,
        type: isImage ? 'image' : 'video',
        preview: URL.createObjectURL(file),
        size: file.size,
        storageType: 'off-chain'
      }

      newMedia.push(mediaFile)
    }

    if (newMedia.length > 0) {
      setSelectedMedia(prev => [...prev, ...newMedia])
    }

    // Surface a toast if any selections were silently dropped. iOS in
    // particular lets the native picker pick N regardless of our cap;
    // without this users wonder why only the first 4 images appeared.
    if (droppedImages > 0 || droppedVideos > 0) {
      const parts: string[] = []
      if (droppedImages > 0) parts.push(t('post_form.media.dropped_images', { count: droppedImages }))
      if (droppedVideos > 0) parts.push(t('post_form.media.dropped_videos', { count: droppedVideos }))
      toast(parts.join(' '))
    }

    // Reset input so same file can be selected again
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  // Handle text change and cursor position for mention autocomplete
  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const cursor = e.target.selectionStart
    // Single-mode → thread-mode transition: when this keystroke pushes the
    // text past POST_CHAR_LIMIT, the single textarea will unmount and the
    // chunk-mode textareas mount on the next render. The chunk-grew
    // layoutEffect won't have a preInputStateRef snapshot (we never set
    // one in single-mode) and the cursor-restore effect needs a master
    // cursor offset to know where to land focus. Single-mode master ==
    // local since there's only one chunk, so cursor IS the master offset.
    pendingMasterCursorRef.current = cursor
    setText(e.target.value)
    setCursorPosition(cursor)
  }

  const handleTextClick = (e: React.MouseEvent<HTMLTextAreaElement>) => {
    setCursorPosition((e.target as HTMLTextAreaElement).selectionEnd ?? (e.target as HTMLTextAreaElement).selectionStart)
  }

  const handleTextKeyUp = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    setCursorPosition((e.target as HTMLTextAreaElement).selectionEnd ?? (e.target as HTMLTextAreaElement).selectionStart)
  }

  // Handle mention selection from autocomplete.
  // In thread mode the positions are relative to the active chunk's local text;
  // we patch only that chunk's slice and rebuild master text via replaceChunk.
  const handleMentionSelect = (username: string, startPos: number, endPos: number) => {
    if (isThreadMode && chunkSlices.length > 0) {
      const chunkText = chunkSlices[activeChunkIndex] ?? ''
      const before = chunkText.substring(0, startPos)
      const after = chunkText.substring(endPos)
      const newChunkText = `${before}@${username} ${after}`
      replaceChunk(activeChunkIndex, newChunkText)
      setTimeout(() => {
        const ta = chunkRefs.current[activeChunkIndex]
        if (ta) {
          const newCursorPos = startPos + username.length + 2
          ta.selectionStart = newCursorPos
          ta.selectionEnd = newCursorPos
          setActiveChunkCursor(newCursorPos)
          ta.focus({ preventScroll: true })
        }
      }, 0)
    } else {
      const beforeMention = text.substring(0, startPos)
      const afterMention = text.substring(endPos)
      const newText = `${beforeMention}@${username} ${afterMention}`
      setText(newText)
      // Set cursor position after the inserted mention
      setTimeout(() => {
        if (textareaRef.current) {
          const newCursorPos = startPos + username.length + 2 // +2 for @ and space
          textareaRef.current.selectionStart = newCursorPos
          textareaRef.current.selectionEnd = newCursorPos
          setCursorPosition(newCursorPos)
          textareaRef.current.focus()
        }
      }, 0)
    }
  }

  // Thin wrapper preserving the local { success, urls } shape. Images
  // route through uploadFeedImage so each one gets a 2048px lightbox
  // variant alongside the 1024px inline display file. Videos go through
  // the generic uploadMedia helper unchanged.
  const uploadMedia = async (
    files: File[],
    type: 'image' | 'video',
    tokenId: number,
    onProgress?: (msg: string) => void,
  ) => {
    if (type === 'image') {
      const { uploadFeedImage } = await import('~/api/upload')
      const urls = await Promise.all(files.map(f => uploadFeedImage(f, tokenId)))
      return { success: true, urls }
    }
    const { uploadMedia: sharedUpload } = await import('~/api/upload')
    const urls = await sharedUpload(files, tokenId, 'feed', onProgress)
    return { success: true, urls }
  }

  // Drag and drop handlers for textarea
  const handleTextareaDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()

    // Check if dragging files
    const hasFiles = Array.from(e.dataTransfer.types).includes('Files')
    if (hasFiles) {
      setIsDragOverTextarea(true)
    }
  }

  const handleTextareaDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOverTextarea(false)
  }

  const handleTextareaDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOverTextarea(false)

    const files = Array.from(e.dataTransfer.files)

    // Process dropped files directly
    if (files.length > 0) {
      // Process files immediately
      const newMedia: any[] = []

      for (const file of files) {
        // Check if it's an image or video
        const isImage = file.type.startsWith('image/')
        const isVideo = file.type.startsWith('video/')

        if (!isImage && !isVideo) continue

        // Check limits
        const currentImages = selectedMedia.filter(m => m.type === 'image').length
        const currentVideos = selectedMedia.filter(m => m.type === 'video').length

        if (isImage && currentImages >= 4) continue
        if (isVideo && currentVideos >= 1) continue

        // Create media object
        const mediaFile = {
          file,
          type: isImage ? 'image' : 'video',
          preview: URL.createObjectURL(file),
          size: file.size,
          storageType: 'off-chain' // default to off-chain
        }

        newMedia.push(mediaFile)
      }

      if (newMedia.length > 0) {
        setSelectedMedia([...selectedMedia, ...newMedia])
      }
    }
  }


  const handleSubmit = async () => {
    // Get effective token ID with fallback
    const effectiveTokenId = activeTokenId || activeToken?.tokenId
    if (!effectiveTokenId) {
      console.error('No active token ID - user may not be connected or data not loaded')
      return
    }

    // Check if this is a scheduled post
    if (showScheduler && scheduledDate && scheduledTime) {
      // Guard against double-clicks: a thread takes seconds to sign, and a
      // second click would re-enter and schedule the same post twice.
      if (isScheduling) return
      setIsScheduling(true)
      setScheduleError(null)
      try {
        const scheduledAt = new Date(`${scheduledDate}T${scheduledTime}`)

        // Build the post content
        let finalText = text

        // Persist attached media for scheduled posts. We upload images now and
        // append media URLs into the scheduled text (same as immediate posts).
        // NOTE: scheduled posts do not support video yet.
        if (selectedMedia.some(m => m.type === 'video')) {
          setScheduleError(t('post_form.error.no_video_schedule'))
          return
        }

        const uploadedUrls: Map<number, string> = new Map()
        const offChainImages = selectedMedia
          .map((m, i) => ({ media: m, index: i }))
          .filter(({ media }) => media.type === 'image')

        if (offChainImages.length > 0) {
          const imageFiles = offChainImages.map(({ media }: any) => media.file as File)
          const uploadResult = await uploadMedia(imageFiles, 'image', effectiveTokenId)
          if (!uploadResult.success || !uploadResult.urls) {
            setScheduleError(t('post_form.error.upload_failed'))
            return
          }
          offChainImages.forEach(({ index }, i) => {
            uploadedUrls.set(index, uploadResult.urls![i])
          })
        }

        const mediaUrls: string[] = []
        selectedMedia.forEach((media: any, index: number) => {
          let url: string | undefined
          if (media.type === 'image') url = uploadedUrls.get(index)
          if (media.type === 'gif') url = media.shortUrl || media.url
          if (url) mediaUrls.push(url)
        })

        const mediaBlock = mediaUrls.length > 0 ? '\n' + mediaUrls.join('\n') : ''
        if (mediaBlock) {
          if (isThreadMode && mediaPosition === 'end') {
            // Media appended after splitting.
          } else {
            finalText = finalText + mediaBlock
          }
        }

        // Replace original URLs with short URLs for on-chain submission
        // (skipped entirely when the user turned shortening off).
        if (shortenUrls) finalText = await shortenUrlsInText(getOnChainText(finalText))

        // Split into thread chunks if needed — mirrors the immediate-post path.
        const chunks = splitTextIntoChunks(finalText, includePageIndicators)

        // If media goes at end of thread, check if it fits in the last chunk or needs its own.
        if (isThreadMode && mediaPosition === 'end' && mediaBlock) {
          const lastChunk = chunks[chunks.length - 1]
          if (byteLen(lastChunk) + byteLen(mediaBlock) <= POST_CHAR_LIMIT) {
            chunks[chunks.length - 1] = lastChunk + mediaBlock
          } else {
            const mediaContent = mediaBlock.replace(/^\n/, '')
            const totalWithMedia = chunks.length + 1
            if (includePageIndicators) {
              const oldDigits = String(chunks.length).length
              const newDigits = String(totalWithMedia).length
              if (newDigits > oldDigits) {
                chunks.length = 0
                let remaining = finalText
                let idx = 0
                while (remaining.length > 0) {
                  const indicator = `(${idx + 1}/${totalWithMedia}) `
                  const available = POST_CHAR_LIMIT - indicator.length
                  if (byteLen(remaining) <= available) {
                    chunks.push(indicator + remaining)
                    break
                  }
                  const splitAt = findSplitPoint(remaining, available)
                  chunks.push(indicator + remaining.slice(0, splitAt))
                  remaining = remaining.slice(splitAt).trimStart()
                  idx++
                }
              } else {
                for (let i = 0; i < chunks.length; i++) {
                  const oldIndicator = `(${i + 1}/${chunks.length}) `
                  const newIndicator = `(${i + 1}/${totalWithMedia}) `
                  if (chunks[i].startsWith(oldIndicator)) {
                    chunks[i] = newIndicator + chunks[i].slice(oldIndicator.length)
                  }
                }
              }
              chunks.push(`(${totalWithMedia}/${totalWithMedia}) ${mediaContent}`)
            } else {
              chunks.push(mediaContent)
            }
          }
        }

        // Same MAX_THREAD_LENGTH guard as the immediate-post path. Catch this
        // before reserving cawonces so a bounced submit doesn't leave a gap
        // in the local cawonce store. The submit button is also disabled
        // when over the cap (see threadTooLong/threadTooLong2 below) — this
        // is defense-in-depth for paste / programmatic flows.
        if (chunks.length > MAX_THREAD_LENGTH) return

        // Reserve sequential cawonces for the whole thread up front. Going
        // through allocateCawonces means:
        //   (a) chain.nextCawonce is the floor (cross-mirror correct);
        //   (b) the per-tokenId Web Lock + promise chain prevents any other
        //       allocation in this tab or any other tab of the same origin
        //       from interleaving and breaking contiguity;
        //   (c) the local watermark (used by all subsequent vote/like/tip
        //       allocations) is bumped past the entire range automatically.
        // Replaces the old store-based read (activeToken?.cawonce) which
        // could be stale across tabs/devices and required a separate
        // setLocalCawonceFloor nudge to keep the chain allocator in sync.
        const threadCawonces = await allocateCawonces(effectiveTokenId, chunks.length)
        const startCawonce = threadCawonces[0]
        // Keep the UI hint store roughly accurate so any "next post #N"
        // indicator updates without waiting for the next poll.
        const setCawonce = useTokenDataStore.getState().setCawonce
        setCawonce(effectiveTokenId, startCawonce + chunks.length)
        const firstPostCawonce = threadCawonces[0]

        // Resolve session key once — same logic as immediate-post path.
        const { useSessionKeyStore } = await import('~/store/sessionKeyStore')
        const { privateKeyToAccount } = await import('viem/accounts')
        const tokenOwner = activeToken?.owner
        const session = tokenOwner
          ? useSessionKeyStore.getState().getActiveSessionForAddress(tokenOwner)
          : useSessionKeyStore.getState().getActiveSession()
        const cawActionBit = 0
        const canUseSession = !!session && (session.scopeBitmap & (1 << cawActionBit)) !== 0
        const sessionAccount = canUseSession ? privateKeyToAccount(session!.privateKey) : null

        // Drive the count-up button immediately for multi-chunk threads.
        if (chunks.length > 1) setSigningProgress({ current: 1, total: chunks.length })

        // Sign each chunk. Chunks 1..N reply to chunk 0 (flat thread, matches
        // the immediate-post path at lines 1095-1104).
        const signedChunks: any[] = []
        for (let i = 0; i < chunks.length; i++) {
          const isFirst = i === 0
          const { domain, types, primaryType, message } = buildTypedData({
            actionType: 'caw',
            senderId: effectiveTokenId,
            text: chunks[i],
            cawonce: threadCawonces[i],
            ...(isFirst ? {} : { receiverId: effectiveTokenId, receiverCawonce: firstPostCawonce }),
          })
          const signArgs = { domain, types: { ActionData: TYPES.ActionData }, primaryType, message } as const
          const signature = sessionAccount
            ? await sessionAccount.signTypedData(signArgs)
            : await signTypedDataAsync(signArgs)
          signedChunks.push({
            content: chunks[i],
            signedAction: { data: message, domain, types, signature },
          })
          if (chunks.length > 1) setSigningProgress({ current: i + 1, total: chunks.length })
        }

        bumpCawonce(effectiveTokenId)

        // POST single payload for one chunk (back-compat); array for threads.
        const body = chunks.length > 1
          ? { scheduledAt: scheduledAt.toISOString(), chunks: signedChunks }
          : {
              content: signedChunks[0].content,
              scheduledAt: scheduledAt.toISOString(),
              signedAction: signedChunks[0].signedAction,
            }
        await apiFetch('/api/scheduled', {
          method: 'POST',
          body: JSON.stringify(body),
          headers: { 'x-user-id': effectiveTokenId.toString() },
        })

        // Clear form
        setText('')
        setSelectedMedia([])
        setShowScheduler(false)
        setScheduledDate('')
        setScheduledTime('')

        // Show success modal
        setScheduledSuccessTime(scheduledAt)
        setShowScheduledSuccessModal(true)
        if (onSuccess) onSuccess()
      } catch (error: any) {
        console.error('[Schedule] Failed:', error)
        const isUserRejection = error?.code === 4001 || /rejected|denied|cancelled/i.test(error?.message || '')
        if (!isUserRejection) {
          // apiFetch wraps server messages as "API 400: <detail>" — strip the
          // status prefix before showing it to the user so the inline error
          // reads like a normal sentence, not a developer log line.
          const raw = error?.message || t('post_form.error.schedule_failed')
          const cleaned = raw.replace(/^API\s+\d+(?:\s+[A-Za-z ]+)?:\s*/, '')
          setScheduleError(cleaned)
        }
      } finally {
        setIsScheduling(false)
        // Don't clear signingProgress immediately — session-key signing finishes
        // in well under the count-up's 2.2s animation budget, and clearing here
        // kills the rAF tick mid-animation. Let it run out, then clear.
        setTimeout(() => setSigningProgress(null), 2300)
      }
      return
    }

    // Regular post submission
    // Prevent double-clicks
    if (isSubmitting) return
    setIsSubmitting(true)

    try {
    let finalText = text
    let totalCawCost = BigInt(0)

    // Build a map of uploaded URLs indexed by position in selectedMedia
    // This preserves the order the user added media
    const uploadedUrls: Map<number, string> = new Map()

    // Separate media by type for uploading
    const offChainImages = selectedMedia
      .map((m, i) => ({ media: m, index: i }))
      .filter(({ media }) => media.type === 'image')
    const videos = selectedMedia
      .map((m, i) => ({ media: m, index: i }))
      .filter(({ media }) => media.type === 'video')

    // Upload off-chain images
    if (offChainImages.length > 0) {
      try {
        setUploadProgress(t('post_form.button.uploading'))
        const imageFiles = offChainImages.map(({ media }) => media.file)
        const uploadResult = await uploadMedia(imageFiles, 'image', effectiveTokenId)

        if (uploadResult.success && uploadResult.urls) {
          // Map URLs back to their original positions
          offChainImages.forEach(({ index }, i) => {
            uploadedUrls.set(index, uploadResult.urls![i])
          })
        } else {
          setUploadProgress(null)
          return
        }
      } catch (error) {
        setUploadProgress(null)
        return
      }
    }

    // Upload videos. The shared helper drives onProgress through the
    // compress-then-upload pipeline so the button can read "Compressing
    // video…" during MediaRecorder transcoding (slow — roughly real-time
    // on the source's duration) before flipping back to a generic
    // "Uploading…" while the network upload runs.
    if (videos.length > 0) {
      try {
        const videoFiles = videos.map(({ media }) => media.file)
        const uploadResult = await uploadMedia(
          videoFiles,
          'video',
          effectiveTokenId,
          msg => setUploadProgress(msg),
        )

        if (uploadResult.success && uploadResult.urls) {
          // Map URLs back to their original positions
          videos.forEach(({ index }, i) => {
            uploadedUrls.set(index, uploadResult.urls![i])
          })
        } else {
          setUploadProgress(null)
          return
        }
      } catch (error) {
        setUploadProgress(null)
        return
      }
    }
    // Clear before the signing phase begins so the button can flip to
    // "Signing…" without a stale upload string lingering underneath.
    setUploadProgress(null)

    // Now build the media URLs list in order
    const mediaUrls: string[] = []

    selectedMedia.forEach((media, index) => {
      let url: string | undefined
      if (media.type === 'image') {
        url = uploadedUrls.get(index)
      } else if (media.type === 'video') {
        // Bare URL — backend video extraction matches /uploads/videos/<file>
        // without any prefix, in lockstep with the image extractor.
        url = uploadedUrls.get(index)
      } else if (media.type === 'gif') {
        // GIF - prefer shortUrl if available, otherwise use url
        url = (media as any).shortUrl || (media as any).url
      }

      if (url) {
        mediaUrls.push(url)
      }
    })

    // Append all media URLs to text — at start or end depending on user choice
    // (only matters for threads; for single posts it's always appended)
    const mediaBlock = mediaUrls.length > 0 ? '\n' + mediaUrls.join('\n') : ''
    if (mediaBlock) {
      if (isThreadMode && mediaPosition === 'end') {
        // Media will be appended to the last chunk after splitting
      } else {
        finalText = finalText + mediaBlock
      }
    }

    // Append the poll marker only when not threading. For threads it gets
    // attached after the split (atomic — never broken apart).
    // Build the marker with the per-option image-hash sidecar when any
    // option carries an uploaded image. Hashes derive from the upload
    // URL's filename stem; host + (non-default) port + scheme come from
    // the URL itself — same source of truth, works whether the SPA is
    // same-origin or hits an external VITE_API_HOST. First non-empty
    // URL wins — all images in one poll were uploaded through the same
    // endpoint so they share a host.
    const submitPollHashes = pollOptionImages.map(u => imageUrlToPollHash(u || ''))
    const submitPollMeta = imageUrlToMeta(pollOptionImages.find(u => u) || '')
    const submitPollMarker = pollEnabled && submitPollMeta
      ? buildPollMarker(pollOptions, submitPollHashes, submitPollMeta, pollDuration, pollMultiSelect)
      : pollEnabled
        ? buildPollMarker(pollOptions, undefined, undefined, pollDuration, pollMultiSelect) // text-only poll
        : null
    if (submitPollMarker && !isThreadMode) {
      finalText = (finalText ? finalText + '\n' : '') + submitPollMarker
    }

    // Replace original URLs with short URLs for on-chain submission
    // (skipped entirely when the user turned shortening off).
    if (shortenUrls) finalText = await shortenUrlsInText(getOnChainText(finalText))

    // effectiveTokenId is already defined at the start of handleSubmit

    // For replies and quotes, include the original post's info
    const parentCaw = replyTo || quote

    // Split into thread chunks if text exceeds the limit
    const chunks = splitTextIntoChunks(finalText, includePageIndicators)

    // Attach the poll marker to either the first or last chunk in a thread.
    // We do this AFTER splitting so the marker never gets broken apart by
    // the splitter itself. The char counter reserved space for it, so the
    // host chunk has room.
    if (submitPollMarker && isThreadMode && chunks.length > 0) {
      const idx = pollPosition === 'start' ? 0 : chunks.length - 1
      const sep = chunks[idx].endsWith('\n') ? '' : '\n'
      chunks[idx] = chunks[idx] + sep + submitPollMarker
    }

    // Show the count-up immediately so the button goes straight from "Post" to
    // "Signing 1/N" instead of showing a transient "Signing..." while budget /
    // cawonce prep runs. Progress updates later in the signing loop still win.
    if (chunks.length > 1) setSigningProgress({ current: 1, total: chunks.length })

    // If media goes at end of thread, check if it fits in the last chunk or needs its own
    if (isThreadMode && mediaPosition === 'end' && mediaBlock) {
      const lastChunk = chunks[chunks.length - 1]
      if (byteLen(lastChunk) + byteLen(mediaBlock) <= POST_CHAR_LIMIT) {
        // Media fits in the last text chunk
        chunks[chunks.length - 1] = lastChunk + mediaBlock
      } else {
        // Media needs its own chunk
        const mediaContent = mediaBlock.replace(/^\n/, '') // strip leading newline for standalone chunk
        const totalWithMedia = chunks.length + 1
        if (includePageIndicators) {
          // If adding a chunk crosses a digit boundary (e.g., 9→10), the indicator
          // grows by 1 byte per chunk, which could push existing chunks over 420.
          // Re-split from scratch in that case to be safe.
          const oldDigits = String(chunks.length).length
          const newDigits = String(totalWithMedia).length
          if (newDigits > oldDigits) {
            // Re-split text aware of the new total's indicator length
            chunks.length = 0
            let remaining = finalText
            let idx = 0
            while (remaining.length > 0) {
              const indicator = `(${idx + 1}/${totalWithMedia}) `
              const available = POST_CHAR_LIMIT - indicator.length // ASCII indicator
              if (byteLen(remaining) <= available) {
                chunks.push(indicator + remaining)
                break
              }
              const splitAt = findSplitPoint(remaining, available)
              chunks.push(indicator + remaining.slice(0, splitAt))
              remaining = remaining.slice(splitAt).trimStart()
              idx++
            }
          } else {
            // Same digit count — safe to do simple string replacement
            for (let i = 0; i < chunks.length; i++) {
              const oldIndicator = `(${i + 1}/${chunks.length}) `
              const newIndicator = `(${i + 1}/${totalWithMedia}) `
              if (chunks[i].startsWith(oldIndicator)) {
                chunks[i] = newIndicator + chunks[i].slice(oldIndicator.length)
              }
            }
          }
          chunks.push(`(${totalWithMedia}/${totalWithMedia}) ${mediaContent}`)
        } else {
          chunks.push(mediaContent)
        }
      }
    }

    // Hard limit on thread length. The API + contract both reject anything
    // over MAX_THREAD_LENGTH. The submit button is disabled when chunkCount
    // exceeds the cap and an inline message is shown — this is the last-line
    // defense for any path that bypasses the button (paste, programmatic).
    if (chunks.length > MAX_THREAD_LENGTH) return

    // Pre-check: verify the user has enough CAW budget (staked + pending deposit
    // - in-flight spend) to cover all thread chunks. Without this, a multi-post
    // thread would pass the single-post stake check on the first chunk and then
    // start failing partway through when the pending-spend accumulator ate the
    // remaining budget — stranding the user with a half-posted thread and a
    // modal mid-stream. Check the whole thread cost up front.
    if (chunks.length > 1) {
      const { getValidatorTip, CLIENT_ID: _ignored } = await import('~/api/actions')
      const { usePendingSpendStore } = await import('~/store/pendingSpendStore')
      const { useInsufficientStakeStore } = await import('~/store/insufficientStakeStore')

      const CAW_COST_PER_POST_WHOLE = 5000n // matches STAKING_REQUIREMENTS.MIN_STAKE_POST
      const tipWhole = getValidatorTip()
      const costPerChunkWhole = CAW_COST_PER_POST_WHOLE + tipWhole
      const totalThreadCostWei = costPerChunkWhole * BigInt(chunks.length) * 10n ** 18n

      // Read the same three inputs actions.ts uses for the single-action budget
      // check: on-chain stake, pending deposit (local hint + backend), and
      // in-flight TxQueue spend.
      const pendingSpend = usePendingSpendStore.getState().pendingSpend
      const onChainStake = activeToken?.stakedAmount ?? 0n

      let localHintWei = 0n
      try {
        const hintRaw = localStorage.getItem(`caw:pendingDeposit:${effectiveTokenId}`)
        if (hintRaw) {
          const hint = JSON.parse(hintRaw)
          const age = Date.now() - (hint?.at ?? 0)
          if (hint?.amount && age < 30 * 60 * 1000) {
            try { localHintWei = BigInt(hint.amount) } catch {}
          }
        }
      } catch { /* ignore */ }

      let backendPendingWei = 0n
      try {
        const { apiFetch } = await import('~/api/client')
        const userRes = await apiFetch(`/api/users/by-token/${effectiveTokenId}`)
        if (userRes?.pendingDepositAmount) {
          try { backendPendingWei = BigInt(userRes.pendingDepositAmount) } catch {}
        }
      } catch { /* ignore */ }

      const pendingDepositWei = localHintWei > backendPendingWei ? localHintWei : backendPendingWei
      const totalBudgetSigned = onChainStake + pendingDepositWei - pendingSpend
      const effectiveBudgetWei = totalBudgetSigned > 0n ? totalBudgetSigned : 0n

      if (effectiveBudgetWei < totalThreadCostWei) {
        // Show the insufficient modal with whole-thread cost so the user sees
        // why a 20-post thread at 5k+1k each is blocked even though a single
        // post would have been fine.
        useInsufficientStakeStore.getState().show(effectiveBudgetWei, totalThreadCostWei, 'post')
        return
      }

      // Also keep the Quick Sign session spend-limit pre-check (separate concern
      // from staked budget — session spend limits protect the wallet, staked
      // budget protects the on-chain execution).
      const { useSessionKeyStore } = await import('~/store/sessionKeyStore')
      const { useQuickSignRenewStore } = await import('~/components/modals/QuickSignRenewModal')
      const sessionStore = useSessionKeyStore.getState()
      if (sessionStore.enabled) {
        const remaining = sessionStore.getRemainingLimit()
        const totalThreadCostWhole = costPerChunkWhole * BigInt(chunks.length)
        if (remaining !== null && totalThreadCostWhole > remaining) {
          useQuickSignRenewStore.getState().show('spend_limit', () => handleSubmit())
          return
        }
      }
      void _ignored
    }

    // Pre-check for embedded tips. Tips ride on the CAW action itself (not a
    // separate OTHER action), so they require a Quick Sign session with the CAW
    // bit (bit 0). The session's perActionTipRate covers validator compensation
    // implicitly, so we only need to gate on the sum of recipient tip amounts.
    if (tipAttachments.length > 0) {
      const { useSessionKeyStore } = await import('~/store/sessionKeyStore')
      const { useQuickSignPromptStore } = await import('~/components/modals/QuickSignModal')
      const { useQuickSignRenewStore } = await import('~/components/modals/QuickSignRenewModal')
      const { useInsufficientStakeStore } = await import('~/store/insufficientStakeStore')
      const { usePendingSpendStore } = await import('~/store/pendingSpendStore')

      const sessionStore = useSessionKeyStore.getState()
      const sess = activeToken?.owner
        ? sessionStore.getActiveSessionForAddress(activeToken.owner)
        : sessionStore.getActiveSession()
      // Tips are embedded in the CAW action — only the CAW bit (bit 0) is needed.
      const CAW_BIT = 0
      const sessionCoversCAW = !!sess && (sess.scopeBitmap & (1 << CAW_BIT)) !== 0
      if (!sessionCoversCAW) {
        useQuickSignPromptStore.getState().show(async () => { await handleSubmit() })
        return
      }

      // Gate: sum of all recipient tip amounts (session's implicit validator fee
      // via perActionTipRate is already included in chunksCostWhole from the
      // batch-cost gate above, so we don't add it again here).
      const recipientTipSum = tipAttachments.reduce((s, tip) => s + BigInt(tip.tipAmountCaw), 0n)
      const CAW_COST_PER_POST_WHOLE = 5000n
      const { getValidatorTip } = await import('~/api/actions')
      const validatorTipWhole = getValidatorTip()
      const chunksCostWhole = (CAW_COST_PER_POST_WHOLE + validatorTipWhole) * BigInt(chunks.length)
      const grandTotalWei = (chunksCostWhole + recipientTipSum) * 10n ** 18n
      const onChainStake = activeToken?.stakedAmount ?? 0n
      const pendingSpend = usePendingSpendStore.getState().pendingSpend
      const totalBudgetSigned = onChainStake - pendingSpend
      const effectiveBudgetWei = totalBudgetSigned > 0n ? totalBudgetSigned : 0n
      if (effectiveBudgetWei < grandTotalWei) {
        useInsufficientStakeStore.getState().show(effectiveBudgetWei, grandTotalWei, 'post')
        return
      }

      // Quick Sign spend-limit gate, including the embedded tip recipients.
      if (sessionStore.enabled) {
        const remaining = sessionStore.getRemainingLimit()
        const totalCostWhole = chunksCostWhole + recipientTipSum
        if (remaining !== null && totalCostWhole > remaining) {
          useQuickSignRenewStore.getState().show('spend_limit', () => handleSubmit())
          return
        }
      }
    }

    // Allocate the whole thread atomically through the chain-based
    // allocator. allocateCawonces holds a per-tokenId Web Lock for the
    // full batch, so any concurrent vote/like/tip in this tab or another
    // tab of the same origin queues behind us instead of grabbing a
    // cawonce in the middle of our range. Cross-server races (other
    // mirror submitting concurrently) still possible but caught by the
    // 409 retry path on submit.
    //
    // Tips are embedded in the CAW action itself — no extra cawonces needed.
    const allocatedCawonces = await allocateCawonces(effectiveTokenId, chunks.length)
    const threadCawonces = allocatedCawonces
    const startCawonce = threadCawonces[0]
    // Refresh the UI hint store so any "next post #N" indicator stays
    // roughly accurate without waiting for the next poll cycle.
    const setCawonce = useTokenDataStore.getState().setCawonce
    setCawonce(effectiveTokenId, startCawonce + chunks.length)

    // Post first chunk (with media, parent info, etc.)
    // Quotes use actionType 'recaw' (with text) so the original author receives funds.
    // Replies use actionType 'caw' with a parent reference.
    // Poll images travel only with the chunk that carries the ::poll:...::
    // marker. For a single post, that's chunk 0. For a thread, it's the
    // first or last chunk depending on pollPosition. Other chunks send
    // nothing.
    const pollLandsInFirstChunk = !!submitPollMarker && (!isThreadMode || pollPosition === 'start')
    const pollLandsInLastChunk = !!submitPollMarker && isThreadMode && pollPosition === 'end'

    const firstParams: ActionParams = {
      actionType: quote ? 'recaw' : 'caw',
      senderId: effectiveTokenId,
      text: chunks[0],
      cawonce: threadCawonces[0],
      ...(parentCaw && {
        receiverId: parentCaw.user.tokenId,
        receiverCawonce: parentCaw.cawonce,
      }),
      // Embed tip recipients/amounts on the first CAW chunk only.
      // Contract shape: recipients[i] receives amounts[i] (recipient-only).
      // Session's perActionTipRate covers validator compensation implicitly.
      // Subsequent chunks (reply thread) do NOT carry tips.
      ...(tipAttachments.length > 0 && {
        recipients: tipAttachments.map(t => t.recipientTokenId),
        amounts: tipAttachments.map(t => BigInt(t.tipAmountCaw)),
      }),
      ...(pollLandsInFirstChunk && pollOptionImages.some(s => s) && { pollOptionImages }),
    }

    const firstPostCawonce = threadCawonces[0]

    // Check if we can batch via Quick Sign session.
    const checkCanBatch = async () => {
      if (typeof (signAndSubmit as any).many !== 'function') return false
      if (chunks.length <= 1) return false
      try {
        const { useSessionKeyStore: sks } = await import('~/store/sessionKeyStore')
        const store = sks.getState()
        const owner = activeToken?.owner
        const sess = owner ? store.getActiveSessionForAddress(owner) : store.getActiveSession()
        return !!sess && (sess.scopeBitmap & 1) !== 0 // CAW bit
      } catch { return false }
    }

    // Track the first pending post so thread replies can reference it as parent
    let firstPendingId: string | undefined
    let firstPendingPost: CawItem | undefined

    // Batch-submit a set of chunk params via .many(), adding pending posts for each.
    const batchSubmitChunks = async (params: ActionParams[], chunkOffset: number) => {
      const responses = await (signAndSubmit as any).many(params, (p: any) => {
        setSigningProgress({ current: chunkOffset + p.signed, total: chunks.length })
      })
      if (activeToken) {
        for (let i = 0; i < params.length; i++) {
          const r = responses[i]
          if (!r || r.error) continue
          const chunkAbsIdx = chunkOffset + i
          const isFirstChunk = chunkAbsIdx === 0
          const isLastChunk = chunkAbsIdx === chunks.length - 1
          const chunkHasPoll =
            (pollLandsInFirstChunk && isFirstChunk) ||
            (pollLandsInLastChunk && isLastChunk)
          const tempId = addPendingPost({
            content: chunks[chunkAbsIdx],
            username: activeToken.username,
            displayName: activeUserData?.displayName,
            tokenId: effectiveTokenId,
            avatarUrl: avatars[effectiveTokenId] || getUserAvatar({ tokenId: effectiveTokenId }),
            cawonce: r.cawonce,
            ...(chunkHasPoll && pollOptionImages.some(s => s) ? { pollOptionImages } : {}),
            ...(isFirstChunk ? {
              replyToId: replyTo?.id,
              parent: replyTo || quote || undefined,
              isQuote: !!quote,
            } : {
              replyToId: firstPendingId,
              parent: firstPendingPost,
            }),
          })
          if (r.txQueueId) updatePostWithTxQueueId(tempId, r.txQueueId)
          if (isFirstChunk) {
            firstPendingId = tempId
            firstPendingPost = {
              id: tempId, content: chunks[0], cawonce: r.cawonce,
              user: { tokenId: effectiveTokenId, username: activeToken.username, displayName: activeUserData?.displayName, id: effectiveTokenId },
              timestamp: new Date().toISOString(), status: 'PENDING',
            } as CawItem
          }
        }
      }
    }

    // Build reply params for chunks after the first.
    //
    // When the thread is a reply to someone else's caw (parentCaw set), every
    // chunk targets the SAME parentCaw — not a chain pointing back at chunk 0.
    // Otherwise threads to @alice would only credit her with one reply even
    // though the user wrote N posts directly under her. The visual thread
    // order is preserved by cawonce sequencing.
    //
    // When there's no parentCaw (top-level self-thread), chunks 1..N still
    // chain to chunk 0 — there's no other receiver to point at, and the
    // chain links the thread together server-side.
    const replyTargetId = parentCaw ? parentCaw.user.tokenId : effectiveTokenId
    const replyTargetCawonce = parentCaw ? parentCaw.cawonce : firstPostCawonce
    const buildReplyParams = (startIdx: number): ActionParams[] =>
      chunks.slice(startIdx).map((text, i) => {
        const chunkIdx = startIdx + i
        const isLastChunk = chunkIdx === chunks.length - 1
        return {
          actionType: 'caw' as const,
          senderId: effectiveTokenId,
          text,
          cawonce: threadCawonces[chunkIdx],
          receiverId: replyTargetId,
          receiverCawonce: replyTargetCawonce,
          // Attach poll images to whichever reply chunk carries the marker.
          // Single-chunk threads don't reach this builder; for multi-chunk
          // threads with poll-position=end, the marker lives in chunks[last].
          ...(pollLandsInLastChunk && isLastChunk && pollOptionImages.some(s => s)
            ? { pollOptionImages }
            : {}),
        }
      })

    if (await checkCanBatch()) {
      // Fast path: batch all chunks (including first) through .many().
      // Tips are embedded in firstParams.recipients/amounts — no separate action.
      const allParams: ActionParams[] = [firstParams, ...buildReplyParams(1)]
      await batchSubmitChunks(allParams, 0)
    } else {
      // Sign+submit the first chunk (may trigger Quick Sign enable prompt)
      const response = await signAndSubmit(firstParams)
      if (!response) return

      if (activeToken) {
        firstPendingId = addPendingPost({
          content: chunks[0],
          username: activeToken.username,
          displayName: activeUserData?.displayName,
          tokenId: effectiveTokenId,
          avatarUrl: avatars[effectiveTokenId] || getUserAvatar({ tokenId: effectiveTokenId }),
          replyToId: replyTo?.id,
          parent: replyTo || quote || undefined,
          cawonce: response.cawonce,
          isQuote: !!quote,
          // First chunk gets the poll images when the poll lands here
          // (single-chunk posts always; threads with pollPosition='start').
          ...(pollLandsInFirstChunk && pollOptionImages.some(s => s) ? { pollOptionImages } : {}),
        })
        if (response.txQueueId) updatePostWithTxQueueId(firstPendingId, response.txQueueId)
        firstPendingPost = {
          id: firstPendingId, content: chunks[0], cawonce: response.cawonce,
          user: { tokenId: effectiveTokenId, username: activeToken.username, displayName: activeUserData?.displayName, id: effectiveTokenId },
          timestamp: new Date().toISOString(), status: 'PENDING',
        } as CawItem
      }

      // Remaining chunks: re-check for session (user may have just enabled Quick Sign)
      if (chunks.length > 1) {
        if (await checkCanBatch()) {
          await batchSubmitChunks(buildReplyParams(1), 1)
        } else {
          for (let i = 1; i < chunks.length; i++) {
            setSigningProgress({ current: i + 1, total: chunks.length })
            const replyResponse = await signAndSubmit(buildReplyParams(i)[0])
            if (!replyResponse) break

            if (activeToken) {
              const isLastChunk = i === chunks.length - 1
              const tempId = addPendingPost({
                content: chunks[i],
                username: activeToken.username,
                displayName: activeUserData?.displayName,
                tokenId: effectiveTokenId,
                avatarUrl: avatars[effectiveTokenId] || getUserAvatar({ tokenId: effectiveTokenId }),
                cawonce: replyResponse.cawonce,
                replyToId: firstPendingId,
                parent: firstPendingPost,
                ...(pollLandsInLastChunk && isLastChunk && pollOptionImages.some(s => s) ? { pollOptionImages } : {}),
              })
              if (replyResponse.txQueueId) updatePostWithTxQueueId(tempId, replyResponse.txQueueId)
            }
          }
        }
      }
    }

    // Reset form
    setText('')
    setSelectedMedia([])
    setShowMediaUpload(false)
    setShowMediaOverlay(false)
    setPollEnabled(false)
    setPollOptions([])
    setPollOptionImages([])
    setPollMultiSelect(false)
    setTipAttachments([])
    onSuccess?.()
    } catch (error: any) {
      // Ignore errors (user may have rejected signature)
    } finally {
      setIsSubmitting(false)
      setSigningProgress(null)
      setUploadProgress(null)
    }
  }

  useEffect(() => {
    if (!showScheduler) setSchedulePicker(null)
  }, [showScheduler])

  // Reservation per attached media item, in bytes. Each ends up in the post text
  // as `\n` + a short URL of the form `https://caw.social/s/XXXXXX.<ext>`. The
  // longest extension we emit is `.webp` (5 incl. dot) → 32 + 1 newline = 33.
  // 34 leaves a 1-byte cushion without stranding usable post space.
  const MEDIA_BYTES_PER_ITEM = 34
  const getMediaCharCost = () => selectedMedia.length * MEDIA_BYTES_PER_ITEM

  const imageCount = selectedMedia.filter(m => m.type === 'image' || m.type === 'gif').length
  const gifDisabled = imageCount >= 4

  // Thread splitting info — all length comparisons here are in BYTES (matches the on-chain check).
  // Use on-chain byte length (with short URLs) for accurate counting.
  const mediaCost = getMediaCharCost() // already in bytes (media refs are ASCII)
  const textBytes = onChainByteLen(text)

  // Poll byte cost when active. The marker is atomic — never split across
  // chunks — so we treat it as either media-like reserve on the first/last
  // chunk (with a +1 byte newline separator) or a no-op when disabled.
  // Options are ASCII-friendly so byteLen ≈ length, but we use byteLen to
  // be precise for emoji-laced labels.
  // Include image hashes + meta (host/port/scheme) in the counter-time
  // marker so the byte budget reflects what we'll actually post.
  const counterPollHashes = pollOptionImages.map(u => imageUrlToPollHash(u || ''))
  const counterPollMeta = imageUrlToMeta(pollOptionImages.find(u => u) || '')
  const pollMarker = pollEnabled && counterPollMeta
    ? buildPollMarker(pollOptions, counterPollHashes, counterPollMeta, pollDuration, pollMultiSelect)
    : pollEnabled
      ? buildPollMarker(pollOptions, undefined, undefined, pollDuration, pollMultiSelect)
      : null
  // Poll is "active but not yet valid" when the user has opened the composer
  // but hasn't filled in at least 2 valid options. Submit gets blocked but
  // we don't yell at the user — the composer's own inline error is enough.
  const pollInvalid = pollEnabled && !pollMarker
  const pollBytes = pollMarker ? byteLen(pollMarker) + 1 : 0  // +1 for newline before
  const firstChunkPollCost = (pollMarker && pollPosition === 'start') ? pollBytes : 0
  const lastChunkPollCost = (pollMarker && pollPosition === 'end') ? pollBytes : 0

  const effectiveTextLength = textBytes + mediaCost + pollBytes
  // Thread mode is active when text overflows one post OR the user typed a
  // manual `---` break marker (which forces a split regardless of length).
  const isThreadMode = effectiveTextLength > POST_CHAR_LIMIT
  const firstChunkMediaCost = (!isThreadMode || mediaPosition === 'start') ? mediaCost : 0
  const lastChunkMediaCost = (isThreadMode && mediaPosition === 'end') ? mediaCost : 0
  const { chunkCount, chunkBoundaries } = getChunkInfo(
    text,
    includePageIndicators,
    firstChunkMediaCost + firstChunkPollCost,
    lastChunkMediaCost + lastChunkPollCost,
  )

  // ---------------------------------------------------------------------------
  // Per-chunk slices (marker-stripped) for the N-textarea thread UI.
  // In manual-break mode the boundaries point PAST each `---\n` marker, so
  // slicing [boundaries[i]..boundaries[i+1]] already contains no marker — the
  // only thing to strip is a trailing newline that preceded the next marker.
  // In auto-split mode boundaries point to post-trimStart offsets so the raw
  // slice is also clean.
  // ---------------------------------------------------------------------------
  const chunkSlices = useMemo((): string[] => {
    if (!isThreadMode) return [text]
    return chunkBoundaries.map((start, i) => {
      const end = chunkBoundaries[i + 1] ?? text.length
      return text.slice(start, end)
    })
  }, [text, chunkBoundaries, isThreadMode])

  /** Replace chunk `i`'s content with `newValue` and patch the master `text`. */
  const replaceChunk = (i: number, newValue: string) => {
    if (!isThreadMode) {
      setText(newValue)
      return
    }
    // Auto-split mode: patch raw string at the known boundary offsets.
    const start = chunkBoundaries[i]
    const end = chunkBoundaries[i + 1] ?? text.length
    setText(text.slice(0, start) + newValue + text.slice(end))
  }

  // Number of non-empty chunks — used for button labels.
  const submittableChunkCount = chunkSlices.filter(s => s.trim().length > 0).length

  // ---------------------------------------------------------------------------
  // Focus auto-jump on chunk-count change. Three cases:
  //
  //   GREW + active chunk OVERFLOWED (the spillover case — single keystroke
  //     typed past the cap, OR multi-char paste that crossed the boundary):
  //     Jump to the end of the LAST new chunk that holds the spillover.
  //     For typing one char past the cap this is position 1 of the new
  //     chunk (≈ start); for a paste that lands a 300-char block this is
  //     position 300, which is what the user expects (cursor follows the
  //     pasted text).
  //
  //   GREW for other reasons (programmatic insertion, marker injection by
  //     a future feature): jump to start of the chunk after the active one.
  //
  //   SHRANK (e.g. user deleted all content in chunk i and the boundary
  //     above merged with the next one):
  //     Move focus to the END of the chunk that absorbed the deletion
  //     (typically chunk i-1, or chunk 0 if everything collapsed).
  //
  //   STABLE:
  //     No-op. Active chunk's own onChange already kept the cursor live.
  // ---------------------------------------------------------------------------
  const prevBoundariesRef = useRef(chunkBoundaries)
  // Stable per-index callback refs. Inline `(el) => { ... }` would recreate
  // a new function identity on every render; React's diff would then call
  // the old ref with `null` and the new ref with the node — the brief null
  // window steals focus out of the textarea on every keystroke (only
  // observable when a NEW chunk mounts, because that triggers a full
  // re-render). useRef-cached makers preserve identity.
  const chunkRefSettersRef = useRef<Map<number, (el: HTMLTextAreaElement | null) => void>>(new Map())
  const getChunkRefSetter = (i: number) => {
    let fn = chunkRefSettersRef.current.get(i)
    if (!fn) {
      fn = (el: HTMLTextAreaElement | null) => {
        if (el && el.offsetParent !== null) {
          chunkRefs.current[i] = el
          if (i === 0) {
            (textareaRef as React.MutableRefObject<HTMLTextAreaElement | null>).current = el
          }
        } else if (!el && chunkRefs.current[i]) {
          // Unmount: clear ONLY if we currently hold this node.
          chunkRefs.current[i] = null
        }
      }
      chunkRefSettersRef.current.set(i, fn)
    }
    return fn
  }
  // Pre-input snapshot captured by onBeforeInput on each chunk textarea.
  // The onChange handler fires AFTER the keystroke has already been
  // applied, so e.target.selectionStart reflects the POST-keystroke
  // cursor, which is always >= the previous slice length when typing at
  // OR before the end. To distinguish "at end" (jump) from "in middle"
  // (stay), we need the cursor + slice length AS THEY WERE before the
  // keystroke fired. onBeforeInput runs synchronously immediately before
  // the value mutates, with the cursor still at its pre-input position.
  const preInputStateRef = useRef<{ chunkIdx: number, preCursorPos: number, preSliceLen: number } | null>(null)
  // After a chunk's onChange, this holds the cursor's MASTER-text offset
  // (chunkBoundary[i] + e.target.selectionStart). The cursor-restore
  // layoutEffect uses it to compute which new chunk the cursor lives in
  // post-resplit and the local offset within it — so adding a space mid-
  // chunk lands the cursor right after the typed space, even if the
  // splitter shifts the chunk boundaries earlier (word-boundary effect).
  const pendingMasterCursorRef = useRef<number | null>(null)
  // Use layoutEffect so the focus + cursor jump runs BEFORE the browser
  // paints the new layout. Otherwise on a fast keystroke that spills into
  // a new chunk, the user sees the cursor flash in the old chunk for one
  // frame before it jumps. Layout effect fires synchronously after DOM
  // mutation, which is when the new textarea's ref callback has already
  // fired and chunkRefs.current[targetIdx] is populated.
  useLayoutEffect(() => {
    const prev = prevBoundariesRef.current
    const prevCount = prev.length
    const nextCount = chunkBoundaries.length

    if (nextCount > prevCount) {
      // GREW. New chunk(s) appeared. Two reasons this can happen:
      //
      //   (A) User typed/pasted AT THE END of the active chunk and the
      //       content spilled forward → cursor follows into the new chunk.
      //       Detected via: pre-keystroke cursor was at the end of the
      //       pre-keystroke slice (snapshot captured in onBeforeInput).
      //
      //   (B) User typed/pasted in the MIDDLE of the active chunk, pushing
      //       trailing content forward → cursor STAYS where the user was
      //       typing (don't yank focus away).
      //       Detected via: pre-keystroke cursor was strictly before the
      //       end of the pre-keystroke slice.
      //
      //   Fallback (no preInputState — e.g. programmatic setText):
      //   Default to NOT jumping. The caller can manually focus a chunk
      //   if they want a specific cursor placement.
      const snap = preInputStateRef.current
      const cursorWasAtEnd = snap != null && snap.preCursorPos >= snap.preSliceLen
      // Consume the snapshot so a later render (not driven by an input
      // event) doesn't reuse it.
      preInputStateRef.current = null

      if (cursorWasAtEnd) {
        const targetIdx = nextCount - 1
        const ta = chunkRefs.current[targetIdx]
        const sliceLen = chunkSlices[targetIdx]?.length ?? 0
        if (ta) {
          cursorRestoreSkipRef.current = true
          // setActiveChunkIndex / setActiveChunkCursor will trigger a second
          // render; do these BEFORE the DOM focus call so the React-tracked
          // active chunk matches the DOM-focused chunk immediately.
          setActiveChunkIndex(targetIdx)
          setActiveChunkCursor(sliceLen)
          // Focus + cursor write directly — no rAF defer. The new textarea
          // is already in the DOM (layoutEffect runs after commit) and its
          // .value has been applied by React's reconciliation pass. Setting
          // selectionRange on it lands cleanly.
          ta.focus({ preventScroll: true })
          ta.setSelectionRange(sliceLen, sliceLen)
        }
      }
      // Mid-chunk overflow (case B): no-op. The user's textarea still has
      // focus and the browser-maintained selection is correct for where
      // they were typing.
    } else if (nextCount < prevCount) {
      // SHRANK. Active chunk merged backward. Cursor at END of the
      // absorbing chunk so the user can keep typing where they left off.
      // Two sub-cases:
      //   - Still in thread mode (chunk count went 3→2 etc.): focus the
      //     surviving chunk's textarea via chunkRefs.
      //   - Dropped out of thread mode (count 2→1 = back to single textarea):
      //     chunkRefs no longer apply — the single-mode textarea is the one
      //     attached to the outer `textareaRef`. requestAnimationFrame lets
      //     React swap the DOM (chunk-mode <Frag> → single <HighlightedTextarea>)
      //     and the new ref to populate before we focus.
      const targetIdx = Math.max(0, Math.min(activeChunkIndex, nextCount - 1))
      const sliceLen = chunkSlices[targetIdx]?.length ?? 0
      setActiveChunkIndex(targetIdx)
      setActiveChunkCursor(sliceLen)
      cursorRestoreSkipRef.current = true
      if (nextCount > 1) {
        // Still in thread mode.
        const ta = chunkRefs.current[targetIdx]
        if (ta) {
          ta.focus({ preventScroll: true })
          ta.setSelectionRange(sliceLen, sliceLen)
        }
      } else {
        // Collapsed back to single-textarea mode. The chunk-mode textareas
        // are about to unmount; wait one frame for the single-mode one to
        // mount and claim the outer textareaRef, then focus it at END.
        requestAnimationFrame(() => {
          const ta = textareaRef.current
          if (ta) {
            const fullLen = ta.value.length
            ta.focus({ preventScroll: true })
            ta.setSelectionRange(fullLen, fullLen)
          }
        })
      }
    }
    prevBoundariesRef.current = chunkBoundaries
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chunkBoundaries.join(',')])

  // Cursor-restore effect: after a setText-driven re-render the splitter
  // can shift chunk boundaries (e.g. typing a space mid-chunk introduces
  // a new word boundary, so chunk 0 shrinks and the rest spills forward).
  // React clamps the textarea's DOM selection to the new (shorter) value's
  // end — the user perceives this as "cursor jumped to end."
  //
  // To preserve the user's intended position, onChange records the cursor's
  // MASTER-text offset in pendingMasterCursorRef. After the re-render we
  // translate that master offset back to (newChunk, newLocalOffset) using
  // the freshly-computed chunkBoundaries, then focus + place cursor there.
  //
  // Skipped when the chunk-count layoutEffect already placed the cursor
  // (its own jump logic is authoritative for those cases).
  const cursorRestoreSkipRef = useRef(false)
  useLayoutEffect(() => {
    // Always consume the skip flag at the top, even when we return early
    // for non-thread mode. Otherwise a SHRANK→1 transition (which sets
    // skip while isThreadMode is already false) leaves the flag set, and
    // the NEXT single→thread transition gets silently suppressed —
    // observed as "second time entering thread mode, focus is lost."
    const skipThisRender = cursorRestoreSkipRef.current
    cursorRestoreSkipRef.current = false
    if (!isThreadMode) {
      // Also drop any pending master cursor on the way out — it was set
      // for a chunk layout that no longer exists.
      pendingMasterCursorRef.current = null
      return
    }
    if (skipThisRender) {
      pendingMasterCursorRef.current = null
      return
    }
    const masterCursor = pendingMasterCursorRef.current
    pendingMasterCursorRef.current = null
    if (masterCursor == null) return
    // Walk forward to find the chunk that contains masterCursor. The
    // RIGHTMOST chunk whose start is <= masterCursor wins (i.e. the cursor
    // lives at the very start of a chunk rather than at the end of the
    // prior one when sitting on a boundary).
    let targetIdx = 0
    for (let k = 0; k < chunkBoundaries.length; k++) {
      if (chunkBoundaries[k] <= masterCursor) targetIdx = k
      else break
    }
    const localOffset = Math.max(0, masterCursor - chunkBoundaries[targetIdx])
    const ta = chunkRefs.current[targetIdx]
    if (!ta) return
    const sliceLen = chunkSlices[targetIdx]?.length ?? 0
    const desired = Math.min(localOffset, sliceLen)
    // Update React-tracked active chunk if it shifted.
    if (targetIdx !== activeChunkIndex) {
      setActiveChunkIndex(targetIdx)
    }
    setActiveChunkCursor(desired)
    ta.focus({ preventScroll: true })
    ta.setSelectionRange(desired, desired)
  })

  // Measure the (x, y) pixel position of a caret offset within a textarea,
  // relative to the textarea's own padding box. Uses a hidden mirror div
  // styled to match the textarea's wrap/font/padding so a marker span at
  // the same character offset lands at the same visual position. Returns
  // null if the mirror can't be built (e.g. textarea isn't laid out).
  const measureCaretXY = (ta: HTMLTextAreaElement, offset: number): { x: number, y: number } | null => {
    const style = window.getComputedStyle(ta)
    const mirror = document.createElement('div')
    // Copy every property that affects line-wrap and glyph positioning.
    const props: (keyof CSSStyleDeclaration)[] = [
      'boxSizing', 'width', 'height',
      'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
      'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
      'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant',
      'lineHeight', 'letterSpacing', 'wordSpacing', 'textTransform', 'textIndent',
      'whiteSpace', 'wordBreak', 'overflowWrap', 'tabSize',
    ]
    for (const p of props) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(mirror.style as any)[p] = (style as any)[p]
    }
    mirror.style.position = 'absolute'
    mirror.style.visibility = 'hidden'
    mirror.style.top = '0'
    mirror.style.left = '0'
    mirror.style.whiteSpace = 'pre-wrap'
    mirror.style.wordWrap = 'break-word'
    mirror.style.overflow = 'hidden'

    const value = ta.value
    const before = document.createTextNode(value.slice(0, offset))
    const marker = document.createElement('span')
    marker.textContent = '​' // zero-width space — gets a layout box
    const after = document.createTextNode(value.slice(offset) || '​')
    mirror.appendChild(before)
    mirror.appendChild(marker)
    mirror.appendChild(after)
    document.body.appendChild(mirror)
    const rect = marker.getBoundingClientRect()
    const mirrorRect = mirror.getBoundingClientRect()
    document.body.removeChild(mirror)
    if (!rect.width && !rect.height) return null
    return {
      x: rect.left - mirrorRect.left,
      y: rect.top - mirrorRect.top,
    }
  }

  // Given a textarea and a target pixel-x, find the character offset on
  // the FIRST visual row (when seekFirstRow=true) or LAST visual row
  // (when seekFirstRow=false) whose caret x is closest to targetX.
  // Returns 0 / value.length as fallbacks if the textarea is empty.
  const findOffsetByX = (ta: HTMLTextAreaElement, targetX: number, seekFirstRow: boolean): number => {
    const value = ta.value
    if (!value) return 0
    const len = value.length
    // Build mirror once; we'll move the marker through every offset.
    const style = window.getComputedStyle(ta)
    const mirror = document.createElement('div')
    const props: (keyof CSSStyleDeclaration)[] = [
      'boxSizing', 'width', 'height',
      'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
      'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
      'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant',
      'lineHeight', 'letterSpacing', 'wordSpacing', 'textTransform', 'textIndent',
      'whiteSpace', 'wordBreak', 'overflowWrap', 'tabSize',
    ]
    for (const p of props) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(mirror.style as any)[p] = (style as any)[p]
    }
    mirror.style.position = 'absolute'
    mirror.style.visibility = 'hidden'
    mirror.style.top = '0'
    mirror.style.left = '0'
    mirror.style.whiteSpace = 'pre-wrap'
    mirror.style.wordWrap = 'break-word'
    mirror.style.overflow = 'hidden'

    // Render the whole value + a single trailing marker we move via DOM ops.
    const span = document.createElement('span')
    span.textContent = value
    const marker = document.createElement('span')
    marker.textContent = '​'
    mirror.appendChild(span)
    mirror.appendChild(marker)
    document.body.appendChild(mirror)

    // Walk every character offset, measure its y; pick offsets on the
    // target row, then choose the one closest to targetX.
    // O(n) on chunk length — chunks are bounded by POST_CHAR_LIMIT bytes
    // so a few hundred chars at most.
    const range = document.createRange()
    const textNode = span.firstChild as Text
    const mirrorTop = mirror.getBoundingClientRect().top
    const mirrorLeft = mirror.getBoundingClientRect().left

    let firstRowY = Infinity
    let lastRowY = -Infinity
    const points: { offset: number, x: number, y: number }[] = []
    for (let off = 0; off <= len; off++) {
      try {
        range.setStart(textNode, Math.min(off, textNode.length))
        range.setEnd(textNode, Math.min(off, textNode.length))
        const r = range.getBoundingClientRect()
        const x = r.left - mirrorLeft
        const y = r.top - mirrorTop
        if (y < firstRowY) firstRowY = y
        if (y > lastRowY) lastRowY = y
        points.push({ offset: off, x, y })
      } catch { /* ignore */ }
    }
    document.body.removeChild(mirror)
    const targetY = seekFirstRow ? firstRowY : lastRowY
    // Tolerance for "same row" — half the row height.
    const rowHeight = lastRowY - firstRowY > 0
      ? (lastRowY - firstRowY) / Math.max(1, Math.round((lastRowY - firstRowY) / (parseFloat(style.lineHeight) || 20)))
      : (parseFloat(style.lineHeight) || 20)
    const tol = Math.max(2, rowHeight / 2)
    const onRow = points.filter(p => Math.abs(p.y - targetY) < tol)
    if (onRow.length === 0) return seekFirstRow ? 0 : len
    let best = onRow[0]
    let bestDist = Math.abs(best.x - targetX)
    for (const p of onRow) {
      const d = Math.abs(p.x - targetX)
      if (d < bestDist) { best = p; bestDist = d }
    }
    return best.offset
  }

  // Arrow-key navigation BETWEEN chunks. In thread mode, the user expects
  // arrow keys to cross chunk boundaries the same way they cross newlines
  // in a single textarea:
  //
  //   - Left  at column 0       → end of previous chunk
  //   - Right at end-of-content → start of next chunk
  //   - Up    on the first line → end of previous chunk
  //   - Down  on the last line  → start of next chunk
  //
  // "First/last line" is detected via cursor position vs newline markers:
  //   - first line  = no `\n` in value[0..selectionStart]
  //   - last line   = no `\n` in value[selectionStart..]
  // Soft-wrapped lines without an explicit `\n` count as a single line for
  // this check, which is fine: arrow-key navigation across a soft-wrap
  // still works inside the current textarea via the browser's native
  // handling; we only intercept when the user is at a HARD boundary.
  const handleChunkArrow = (e: React.KeyboardEvent<HTMLTextAreaElement>, i: number) => {
    if (!isThreadMode) return
    const ta = e.currentTarget
    const pos = ta.selectionStart ?? 0
    const end = ta.selectionEnd ?? pos

    // ---- Cross-chunk SELECT-ALL / COPY / CUT / DELETE handling ----
    // Browsers can't select across separate <textarea>s, so Cmd/Ctrl-A
    // within any chunk only highlights that one. We intercept the chord,
    // mark allChunksSelected=true (visual tint on every chunk via class),
    // then catch the FOLLOW-UP keystroke (copy/cut/delete/print char) to
    // act on the master text.
    const modKey = e.metaKey || e.ctrlKey
    if (modKey && e.key === 'a' && !e.shiftKey && !e.altKey) {
      // Multi-chunk thread mode: suppress the native textarea selection
      // entirely so the only visible "selection" is our yellow tint across
      // every chunk. Without this, the focused chunk also shows the
      // browser's native highlight (blue/system color) on top of our
      // yellow wrapper, which reads as two competing selection states.
      // Single-chunk thread mode (rare: media-only chunk-pinned case) —
      // let the native select-all run as usual since there's nothing to
      // tint across.
      if (chunkSlices.length > 1) {
        e.preventDefault()
        // Collapse selection so neither a highlight nor a blinking caret
        // is visible — only the yellow wrapper tint remains.
        ta.setSelectionRange(ta.value.length, ta.value.length)
        setAllChunksSelected(true)
        return
      }
    }
    if (allChunksSelected) {
      // Copy/Cut → write master text to clipboard.
      // Copy is non-destructive; KEEP the all-selected highlight so the
      // user can hit Copy again or extend the action (Cut, Delete, etc.).
      // Cut clears the master text AND deselects.
      if (modKey && (e.key === 'c' || e.key === 'x') && !e.shiftKey && !e.altKey) {
        e.preventDefault()
        // Best-effort: use the Clipboard API; fall back to execCommand if
        // unavailable (e.g. non-secure context). Errors silently no-op —
        // not worth a user-facing toast for a clipboard hiccup.
        try { void navigator.clipboard.writeText(text) }
        catch { try { document.execCommand('copy') } catch { /* no-op */ } }
        if (e.key === 'x') {
          setText('')
          pendingMasterCursorRef.current = 0
          setAllChunksSelected(false)
        }
        return
      }
      // Backspace / Delete → clear master text.
      if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault()
        setText('')
        pendingMasterCursorRef.current = 0
        setAllChunksSelected(false)
        return
      }
      // Arrow keys / Home / End / Escape → just clear the highlight
      // (native deselect behavior) and let the textarea handle the key.
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight'
          || e.key === 'ArrowUp' || e.key === 'ArrowDown'
          || e.key === 'Home' || e.key === 'End' || e.key === 'Escape') {
        setAllChunksSelected(false)
        // Don't return — let the rest of the arrow-handler run too.
      }
      // Printable single-char keys (and Enter / Tab) replace master text
      // with that char. onBeforeInput on the chunk textarea catches the
      // typed input path too, but doing it here covers Enter (which
      // doesn't go through onBeforeInput as a textInputType).
      else if (e.key.length === 1 || e.key === 'Enter') {
        e.preventDefault()
        const replacement = e.key === 'Enter' ? '\n' : e.key
        setText(replacement)
        pendingMasterCursorRef.current = replacement.length
        setAllChunksSelected(false)
        return
      }
    }

    // Only intercept when there's no selection — otherwise arrow keys are
    // editing the selection range and the user means in-textarea behavior.
    if (pos !== end) return
    // Don't fight modifier-key combos (Shift+Arrow for selection extension,
    // Cmd/Ctrl+Arrow for word/line jumps).
    if (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return

    const value = ta.value
    const isAtLogicalStart = pos === 0
    const isAtLogicalEnd = pos === value.length
    const isOnFirstLine = value.lastIndexOf('\n', pos - 1) === -1
    const isOnLastLine = value.indexOf('\n', pos) === -1

    // For Up/Down crosses we want to preserve the cursor's pixel-x in the
    // target textarea — same convention as moving up/down within a single
    // textarea. carryX = the x-coord of the cursor right now; null means
    // "Left/Right cross, no x-preservation".
    const goPrev = (carryX: number | null) => {
      if (i === 0) return
      const targetIdx = i - 1
      const targetTa = chunkRefs.current[targetIdx]
      if (!targetTa) return
      e.preventDefault()
      let targetOffset: number
      if (carryX != null) {
        // Land on the LAST row of the previous chunk, x closest to carryX.
        targetOffset = findOffsetByX(targetTa, carryX, false)
      } else {
        targetOffset = chunkSlices[targetIdx]?.length ?? 0
      }
      setActiveChunkIndex(targetIdx)
      setActiveChunkCursor(targetOffset)
      targetTa.focus({ preventScroll: true })
      targetTa.setSelectionRange(targetOffset, targetOffset)
    }
    const goNext = (carryX: number | null) => {
      if (i >= chunkSlices.length - 1) return
      const targetIdx = i + 1
      const targetTa = chunkRefs.current[targetIdx]
      if (!targetTa) return
      e.preventDefault()
      let targetOffset: number
      if (carryX != null) {
        // Land on the FIRST row of the next chunk, x closest to carryX.
        targetOffset = findOffsetByX(targetTa, carryX, true)
      } else {
        targetOffset = 0
      }
      setActiveChunkIndex(targetIdx)
      setActiveChunkCursor(targetOffset)
      targetTa.focus({ preventScroll: true })
      targetTa.setSelectionRange(targetOffset, targetOffset)
    }

    if (e.key === 'ArrowLeft' && isAtLogicalStart) {
      goPrev(null)
    } else if (e.key === 'ArrowRight' && isAtLogicalEnd) {
      goNext(null)
    } else if (e.key === 'ArrowUp' && isOnFirstLine) {
      const xy = measureCaretXY(ta, pos)
      goPrev(xy ? xy.x : null)
    } else if (e.key === 'ArrowDown' && isOnLastLine) {
      const xy = measureCaretXY(ta, pos)
      goNext(xy ? xy.x : null)
    } else if (e.key === 'Backspace' && isAtLogicalStart && i > 0) {
      // Backspace at position 0 of a non-first chunk. Always preventDefault
      // and hop focus to end of the previous chunk — same intuition as
      // backspace-at-start in a single textarea (deletes the preceding
      // newline-equivalent boundary). Two sub-cases:
      //
      //   a) Current chunk has content (value.length > 0):
      //      Merge it backward into the previous chunk via setText. The
      //      layoutEffect's SHRANK branch then handles focus + cursor.
      //
      //   b) Current chunk is empty:
      //      No merge needed. Just move focus + cursor to end of the
      //      previous chunk. The empty chunk stays rendered (the splitter
      //      keeps it as long as the previous chunk is at the cap), but
      //      the user can keep typing/deleting in the previous chunk.
      //      When they delete enough from prev chunk to fall under the
      //      cap, the splitter collapses both chunks and the layoutEffect
      //      SHRANK branch handles the final cursor.
      const prevSlice = chunkSlices[i - 1] ?? ''
      const cursorLand = prevSlice.length
      const prevTa = chunkRefs.current[i - 1]
      e.preventDefault()
      if (value.length > 0) {
        // Merge sub-case: rebuild master text with this chunk concatenated
        // onto the previous one.
        const mergedPrev = prevSlice + value
        const prevStart = chunkBoundaries[i - 1]
        const thisEnd = chunkBoundaries[i + 1] ?? text.length
        const nextText = text.slice(0, prevStart) + mergedPrev + text.slice(thisEnd)
        setActiveChunkIndex(i - 1)
        setActiveChunkCursor(cursorLand)
        setText(nextText)
      } else if (prevTa) {
        // Hop sub-case: empty chunk, just move focus.
        setActiveChunkIndex(i - 1)
        setActiveChunkCursor(cursorLand)
        prevTa.focus({ preventScroll: true })
        prevTa.setSelectionRange(cursorLand, cursorLand)
      }
    }
  }

  // Figure out which chunk the cursor is in
  // When media gets its own dedicated last chunk, the cursor should never land there —
  // cap to the last text chunk so the counter shows remaining bytes for actual text.
  const hasMediaOnlyChunk = mediaPosition === 'end' && chunkCount >= 2 && chunkBoundaries[chunkCount - 1] === text.length
  const maxCursorChunk = hasMediaOnlyChunk ? chunkCount - 2 : chunkCount - 1
  const currentChunkIndex = (() => {
    if (!isThreadMode) return 0
    // In thread mode with separate textareas, use the actively focused chunk.
    return Math.min(activeChunkIndex, maxCursorChunk)
  })()

  // Calculate bytes remaining for the current chunk (uses on-chain byte lengths
  // so the counter reflects the actual space available after URL shortening)
  const calculateCharCount = () => {
    if (!isThreadMode) {
      return POST_CHAR_LIMIT - effectiveTextLength
    }
    // In thread mode, show remaining bytes for the focused chunk's stripped slice.
    const chunkText = chunkSlices[currentChunkIndex] ?? ''
    const chunkLen = onChainByteLen(chunkText)
    // Add media cost to the chunk that will contain the media
    const isFirstChunk = currentChunkIndex === 0
    const isLastChunk = currentChunkIndex === chunkCount - 1
    const extraCost = mediaPosition === 'end'
      ? (isLastChunk ? mediaCost : 0)
      : (isFirstChunk ? mediaCost : 0)
    return POST_CHAR_LIMIT - chunkLen - extraCost
  }

  const charCount = calculateCharCount()

  // Dynamic textarea rows — grow after 4 lines, max 12
  const lineCount = text.split('\n').length
  // Replies should feel tighter (closer to X/Threads).
  // For regular posts, keep it roomy when it's text-only, but when media is
  // attached the big empty textarea looks ridiculous.
  const hasMedia = selectedMedia.length > 0
  const hasInlineFeedDraft = trackDraft && (text.trim().length > 0 || hasMedia)

  // Lock background scroll while the inline draft is expanded fullscreen
  // on mobile. Desktop renders the form inline (`md:static` in the
  // wrapper className), so the lock is gated to viewports below the md
  // breakpoint to avoid freezing the page during normal desktop typing.
  useEffect(() => {
    if (!hasInlineFeedDraft) return
    if (typeof window === 'undefined') return
    const mq = window.matchMedia('(max-width: 767px)')
    if (!mq.matches) return
    acquireScrollLock()
    return () => { releaseScrollLock() }
  }, [hasInlineFeedDraft])

  // #207: the emoji picker is a transient fixed/portaled popover whose grid
  // is too short to scroll, so wheel/touch over it falls through and the page
  // scrolls behind it. Rather than fighting the scroll container (the real
  // vertical scroller is <html>, not body — see scrollLock notes), close the
  // picker on the first scroll with a short fade-out. This is the common
  // popover pattern (X, GitHub) and is robust regardless of which element
  // owns the scroll. emojiClosing drives the opacity transition; the picker
  // unmounts ~160ms later so the fade is visible.
  useEffect(() => {
    if (!showEmojiPicker) return
    setEmojiClosing(false) // fresh open is fully opaque
    const onScroll = () => {
      setEmojiClosing(true)
      window.setTimeout(() => {
        setShowEmojiPicker(false)
        setEmojiClosing(false)
      }, 160)
    }
    window.addEventListener('scroll', onScroll, { passive: true, capture: true })
    return () => window.removeEventListener('scroll', onScroll, { capture: true } as EventListenerOptions)
  }, [showEmojiPicker])
  // Reusable fade class for the picker containers (close-on-scroll, #207).
  const emojiFadeClass = `transition-opacity duration-150 ${emojiClosing ? 'opacity-0' : 'opacity-100'}`
  const desktopRows = replyTo
    ? Math.max(2, Math.min(lineCount, 10))
    : hasMedia
      ? Math.max(1, Math.min(lineCount, 5))
      : Math.max(5, Math.min(lineCount, 12))
  const isOverLimit = false // Thread mode handles overflow by splitting

  // transition-colors (not transition-all) on the outer wrapper — the
  // compose form's subtree (poll inputs, char counter, byte gauges)
  // re-renders on every keystroke, and transition-all here causes
  // Android Chrome to layer-promote the whole subtree and tear the GPU
  // composite during keyboard input. The only property we actually
  // want to fade is background-color on the dark/light toggle.
  return (
      <div className={`${composeMode ? 'px-0 py-4' : replyTo ? 'p-2' : 'p-4'} transition-colors duration-300 ${isDark ? 'bg-black' : 'bg-white'} ${
        hasInlineFeedDraft ? 'md:static md:p-4 md:pt-4 md:pb-4 fixed left-0 right-0 bottom-0 top-16 z-[60] overflow-y-auto pt-14 pb-[calc(env(safe-area-inset-bottom)+90px)]' : ''
      } ${composeMode ? 'flex-1 min-h-0 flex flex-col md:block md:min-h-0' : ''}`}>
      {hasInlineFeedDraft && (
        <button
          type="button"
          aria-label="Close"
          onClick={() => { setText(''); setSelectedMedia([]) }}
          className={`md:hidden absolute left-3 top-3 p-2 rounded-full transition-colors cursor-pointer ${
            isDark ? 'hover:bg-white/10 text-white' : 'hover:bg-gray-100 text-black'
          }`}
        >
          <HiX className="w-6 h-6" />
        </button>
      )}
      {/* Hidden file input for media selection */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,video/*"
        multiple
        onChange={handleFileInputChange}
        className="hidden"
      />

      {/* Mobile Layout - Input + Button */}
      <div className={`${composeMode ? 'hidden' : 'md:hidden'} flex flex-col ${replyTo ? 'space-y-1' : 'space-y-2'}`}>
          {/* Input and Reply Button Row.
              min-w-0 on the input flex item is critical — without it
              the textarea's intrinsic min-content (1 line of text)
              prevents flex-1 from shrinking, so on a narrow viewport
              the input collapses to its smallest visible size and
              everything else takes the rest of the row. */}
          <div className="flex items-center space-x-3 w-full">
            {/* Input — single textarea (single-post) or N textareas (thread mode) */}
            <div className="flex-1 min-w-0 relative">
              {isThreadMode ? (
                <div>
                  {chunkSlices.map((slice, i) => (
                    <React.Fragment key={i}>
                      {i > 0 && (
                        <div
                          style={{
                            borderTop: '1px dashed #f0b1005e',
                            marginLeft: '20px',
                            marginRight: '20px',
                            marginTop: '10px',
                            marginBottom: '10px',
                          }}
                        />
                      )}
                      <div
                        // When Cmd/Ctrl-A is active across the thread, tint
                        // every chunk so the user can see the "all selected"
                        // state. Native textarea selection only highlights
                        // the focused chunk; this wrapper bg fills the gap.
                        // Yellow at low opacity matches the divider line.
                        className={allChunksSelected ? 'bg-yellow-500/20 rounded' : ''}
                      >
                      <HighlightedTextarea
                        value={slice}
                        onChange={(e) => {
                          const localCursor = e.target.selectionStart ?? 0
                          // Stash the cursor's master-text offset so the
                          // cursor-restore layoutEffect can translate it
                          // to (newChunk, newLocalOffset) after re-split.
                          pendingMasterCursorRef.current = chunkBoundaries[i] + localCursor
                          replaceChunk(i, e.target.value)
                          setActiveChunkIndex(i)
                          setActiveChunkCursor(localCursor)
                        }}
                        onClick={(e) => {
                          setActiveChunkIndex(i)
                          setActiveChunkCursor((e.target as HTMLTextAreaElement).selectionStart ?? 0)
                          setAllChunksSelected(false)
                        }}
                        onKeyUp={(e) => {
                          setActiveChunkIndex(i)
                          setActiveChunkCursor((e.target as HTMLTextAreaElement).selectionStart ?? 0)
                        }}
                        onKeyDown={(e) => handleChunkArrow(e, i)}
                        onBeforeInput={(e) => {
                          // Capture pre-input cursor + slice length so the
                          // chunk-grew layoutEffect can tell end-of-chunk
                          // spillover (cursor follows forward) from mid-chunk
                          // overflow (cursor stays where the user was typing).
                          const ta = e.currentTarget as HTMLTextAreaElement
                          preInputStateRef.current = {
                            chunkIdx: i,
                            preCursorPos: ta.selectionStart ?? 0,
                            preSliceLen: ta.value.length,
                          }
                        }}
                        onDragOver={handleTextareaDragOver}
                        onDragLeave={handleTextareaDragLeave}
                        onDrop={handleTextareaDrop}
                        rows={1}
                        placeholder={i === 0
                          ? (replyTo
                              ? `Reply to @${replyTo.user.username}`
                              : (placeholder ?? (quote ? t('post_form.placeholder_quote') : t('post_form.placeholder'))))
                          : ''}
                        textareaRef={getChunkRefSetter(i)}
                        fontSize="base"
                        denser
                        autoResize
                      />
                      </div>
                    </React.Fragment>
                  ))}
                  <MentionAutocomplete
                    text={chunkSlices[activeChunkIndex] ?? ''}
                    cursorPosition={activeChunkCursor}
                    onSelect={handleMentionSelect}
                    textareaRef={{ current: chunkRefs.current[activeChunkIndex] ?? null }}
                  />
                </div>
              ) : (
                <>
                  <HighlightedTextarea
                    value={text}
                    onChange={handleTextChange}
                    onClick={handleTextClick}
                    onKeyUp={handleTextKeyUp}
                    onDragOver={handleTextareaDragOver}
                    onDragLeave={handleTextareaDragLeave}
                    onDrop={handleTextareaDrop}
                    rows={replyTo ? 3 : 1}
                    placeholder={
                      replyTo
                        ? `Reply to @${replyTo.user.username}`
                        : (
                          placeholder ?? (quote ? t('post_form.placeholder_quote') : t('post_form.placeholder'))
                        )
                    }
                    textareaRef={textareaRef}
                    fontSize="base"
                    compact={!!replyTo || hasMedia}
                    autoResize
                  />
                  <MentionAutocomplete
                    text={text}
                    cursorPosition={cursorPosition}
                    onSelect={handleMentionSelect}
                    textareaRef={textareaRef}
                  />
                </>
              )}
              {/* Drag overlay */}
              {isDragOverTextarea && (
                <div className="absolute inset-0 flex items-center justify-center bg-yellow-500/10 border-2 border-dashed border-yellow-500 rounded-lg pointer-events-none">
                  <div className="text-center">
                    <svg className="mx-auto h-8 w-8 text-yellow-500 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                    </svg>
                    <p className="text-sm font-medium text-yellow-600 dark:text-yellow-400">Drop here</p>
                  </div>
                </div>
              )}
            </div>

            {/* Character counter and thread indicator */}
            <div className="flex items-center space-x-2">
              {isThreadMode && (
                <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${
                  submittableChunkCount > 300
                    ? (isDark ? 'bg-red-500/20 text-red-400' : 'bg-red-100 text-red-700')
                    : (isDark ? 'bg-yellow-500/20 text-yellow-400' : 'bg-yellow-100 text-yellow-700')
                }`}>
                  {currentChunkIndex + 1}/{submittableChunkCount}
                </span>
              )}
              {(text.length > 0 || selectedMedia.length > 0) && (
                <span
                  title={t('post_form.bytes_remaining')}
                  className={`text-xs font-medium ${
                    charCount <= 20
                      ? 'text-yellow-500'
                      : isDark ? 'text-gray-400' : 'text-gray-500'
                  }`}
                >
                  {charCount}
                </span>
              )}
            </div>

          </div>

          {/* Poll composer (mobile) */}
          {pollEnabled && (
            <PollComposer
              options={pollOptions}
              onChange={setPollOptions}
              optionImages={pollOptionImages}
              onChangeImages={setPollOptionImages}
              onClose={() => { setPollEnabled(false); setPollOptions([]); setPollOptionImages([]); setPollMultiSelect(false) }}
              position={pollPosition}
              onChangePosition={setPollPosition}
              showPositionPicker={isThreadMode}
              duration={pollDuration}
              onChangeDuration={setPollDuration}
              multiSelect={pollMultiSelect}
              onChangeMultiSelect={setPollMultiSelect}
            />
          )}

          {/* Mobile Icons Row */}
          <div className={`flex items-center justify-between mt-4 pb-3 border-b ${
            isDark ? 'border-white/10' : 'border-gray-200'
          } ${replyTo ? 'pt-0.5' : ''}`}>
            {/* Left side - media icons */}
            <div className="flex items-center space-x-4">
              {/* Media Upload */}
              <button
                onClick={() => fileInputRef.current?.click()}
                className={`p-1 rounded-full transition-all duration-200 cursor-pointer ${
                  selectedMedia.length > 0
                    ? 'text-yellow-500 bg-yellow-400/10'
                    : text.trim()
                      ? (isDark
                          ? 'text-yellow-400 hover:text-yellow-300 hover:bg-yellow-400/10'
                          : 'text-yellow-600 hover:text-yellow-500 hover:bg-yellow-200/50')
                      : (isDark
                          ? 'text-yellow-400/70 hover:text-yellow-400 hover:bg-yellow-400/10'
                          : 'text-yellow-600/70 hover:text-yellow-600 hover:bg-yellow-200/50')
                }`}>
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
              </button>

              {/* GIF */}
              <button
                onClick={() => {
                  if (gifDisabled) return
                  setShowGifPicker(!showGifPicker)
                  setShowEmojiPicker(false)
                  setEmojiPopover(null)
                }}
                disabled={gifDisabled}
                className={`px-3 py-1 rounded-full text-base font-medium transition-all duration-200 ${
                gifDisabled
                  ? 'opacity-30 cursor-not-allowed'
                  : `cursor-pointer ${text.trim()
                    ? (isDark
                        ? 'text-yellow-400 hover:text-yellow-300 hover:bg-yellow-400/10'
                        : 'text-yellow-600 hover:text-yellow-500 hover:bg-yellow-200/50')
                    : (isDark
                        ? 'text-yellow-400/70 hover:text-yellow-400 hover:bg-yellow-400/10'
                        : 'text-yellow-600/70 hover:text-yellow-600 hover:bg-yellow-200/50')}`
              }`}>
                GIF
              </button>

              {/* Emoji Picker */}
              <button
                onClick={(e) => {
                  const willOpen = !showEmojiPicker
                  setShowGifPicker(false)
                  setShowEmojiPicker(willOpen)
                  if (willOpen) {
                    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                    // First-pass position (centered under the button). We'll
                    // measure + clamp in layoutEffect.
                    const anchorCx = (r.left + r.right) / 2
                    setEmojiPopover({
                      anchor: { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
                      // left coordinate guess; refined after measuring.
                      x: anchorCx - 180,
                      y: r.bottom + 8,
                    })
                  } else {
                    setEmojiPopover(null)
                  }
                }}
                className={`p-1 rounded-full transition-all duration-200 cursor-pointer ${
                text.trim()
                  ? (isDark
                      ? 'text-yellow-400 hover:text-yellow-300 hover:bg-yellow-400/10'
                      : 'text-yellow-600 hover:text-yellow-500 hover:bg-yellow-200/50')
                  : (isDark
                      ? 'text-yellow-400/70 hover:text-yellow-400 hover:bg-yellow-400/10'
                      : 'text-yellow-600/70 hover:text-yellow-600 hover:bg-yellow-200/50')
              }`}>
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.828 14.828a4 4 0 01-5.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </button>

              {/* Poll */}
              <button
                onClick={() => {
                  if (pollEnabled) {
                    setPollEnabled(false)
                    setPollOptions([])
                    setPollOptionImages([])
                  } else {
                    setPollEnabled(true)
                    setPollOptions(['', ''])
                    setPollOptionImages(['', ''])
                  }
                }}
                aria-label={pollEnabled ? 'Remove poll' : 'Add poll'}
                className={`p-1 rounded-full transition-all duration-200 cursor-pointer ${
                  pollEnabled
                    ? 'text-yellow-500 bg-yellow-400/10'
                    : text.trim()
                      ? (isDark
                          ? 'text-yellow-400 hover:text-yellow-300 hover:bg-yellow-400/10'
                          : 'text-yellow-600 hover:text-yellow-500 hover:bg-yellow-200/50')
                      : (isDark
                          ? 'text-yellow-400/70 hover:text-yellow-400 hover:bg-yellow-400/10'
                          : 'text-yellow-600/70 hover:text-yellow-600 hover:bg-yellow-200/50')
                }`}
              >
                <HiOutlineChartBar className="w-5 h-5" />
              </button>

              {/* Tip attachment — embedded in the CAW action's recipients[]/amounts[]. */}
              <TipAttachmentControl
                text={text}
                replyTo={replyTo}
                ownTokenIds={activeToken?.tokenId ? [activeToken.tokenId] : []}
                values={tipAttachments}
                onChange={setTipAttachments}
                iconSizeClass="w-5 h-5"
              />

              {/* AI image generation — available in every composer (incl.
                  replies + quotes). The narrow-context overflow is handled
                  by the outer flex-wrap on the toolbar row. -ml-0.5 nudges
                  it back inside the toolbar's hitbox rhythm. */}
              <button
                type="button"
                onClick={openAiImages}
                title={t('post_form.ai.tooltip')}
                aria-label={t('post_form.ai.aria')}
                className={`relative p-1 -ml-0.5 rounded-full transition-all duration-200 cursor-pointer ${
                  text.trim()
                    ? (isDark
                        ? 'text-yellow-400 hover:text-yellow-300 hover:bg-yellow-400/10'
                        : 'text-yellow-600 hover:text-yellow-500 hover:bg-yellow-200/50')
                    : (isDark
                        ? 'text-yellow-400/70 hover:text-yellow-400 hover:bg-yellow-400/10'
                        : 'text-yellow-600/70 hover:text-yellow-600 hover:bg-yellow-200/50')
                }`}
              >
                <AiGlitterIcon sizeClass="w-5 h-5" />
              </button>
            </div>

            {/* Right side - Action buttons (Post/etc.) */}
            { hasNoToken ? (
              <Link
                to="/usernames/new"
                className="px-3 py-1.5 bg-yellow-500 text-black font-semibold text-sm rounded-full hover:bg-yellow-400 transition-all duration-200 shadow-lg hover:shadow-xl cursor-pointer"
              >
                Create profile
              </Link>
            ) : (() => {
                // "Wrong Wallet" only applies when a wallet IS connected but
                // doesn't own the active token (and no Quick Sign session is
                // covering for it). If no wallet is connected, the button just
                // triggers the connect flow and should say "Post".
                const wrongWallet = isConnected && !isTokenOwner && !hasActiveSession && activeToken?.tokenId
                const tooltipText = wrongWallet ? t('post_form.error.wrong_wallet_tooltip') : ''
                const threadTooLong = isThreadMode && submittableChunkCount > MAX_THREAD_LENGTH
                const isDisabled = (!text && selectedMedia.length === 0 && !pollMarker) || isOverLimit || !canPost || isSubmitting || isScheduling || threadTooLong || pollInvalid
                const btn = (
                  <button
                    ref={submitBtnRef}
                    className="px-3 py-1.5 bg-yellow-500 text-black font-semibold text-sm rounded-full hover:bg-yellow-400 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200 shadow-lg hover:shadow-xl cursor-pointer"
                    disabled={isDisabled}
                    onClick={handleSubmit}
                  >
                    {wrongWallet ? t('post_form.button.wrong_wallet') : uploadProgress ? uploadProgress : signingProgress ? <>{t('post_form.button.signing_progress')} <span ref={signingCountRef1}>1</span>/{signingProgress.total}...</> : isSubmitting ? t('post_form.button.signing') : isThreadMode ? t('post_form.button.thread', { count: submittableChunkCount }) : replyTo ? t('post_form.button.reply') : t('post_form.button.post')}
                  </button>
                )
                return tooltipText ? <Tooltip text={tooltipText}>{btn}</Tooltip> : btn
              })()
            }
          </div>

        {isThreadMode && submittableChunkCount > MAX_THREAD_LENGTH && (
          <p className="text-xs text-error-dim mt-1 text-right">Thread exceeds {MAX_THREAD_LENGTH} post limit. Shorten your text to continue.</p>
        )}

        {/* Mobile Thread Info */}
        {isThreadMode && (
          <div className={`mt-3 p-3 rounded-lg flex items-center justify-between ${
            isDark ? 'bg-yellow-500/10 border border-yellow-500/30' : 'bg-yellow-50 border border-yellow-200'
          }`}>
            <div className="flex items-center gap-2">
              <svg className="w-4 h-4 flex-shrink-0 text-yellow-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
              </svg>
              <span className={`text-xs font-medium ${isDark ? 'text-yellow-200' : 'text-yellow-800'}`}>
                This will be posted as a thread of {submittableChunkCount} posts
              </span>
            </div>
            {selectedMedia.length > 0 && (
              <div className={`flex items-center gap-3 mt-1 text-xs ${isDark ? 'text-yellow-200' : 'text-yellow-800'}`}>
                <span>{t('post_form.attach_media_to')}</span>
                <label className="flex items-center gap-1 cursor-pointer">
                  <input type="radio" name="mediaPosMobile" checked={mediaPosition === 'start'} onChange={() => setMediaPosition('start')} className="accent-yellow-500" />
                  First post
                </label>
                <label className="flex items-center gap-1 cursor-pointer">
                  <input type="radio" name="mediaPosMobile" checked={mediaPosition === 'end'} onChange={() => setMediaPosition('end')} className="accent-yellow-500" />
                  Last post
                </label>
              </div>
            )}
            <label className={`flex items-center gap-1.5 cursor-pointer text-xs mt-1 ${isDark ? 'text-yellow-200' : 'text-yellow-800'}`}>
              <input
                type="checkbox"
                checked={includePageIndicators}
                onChange={(e) => setIncludePageIndicators(e.target.checked)}
                className="w-3.5 h-3.5 rounded accent-yellow-500"
              />
              Include (1/{submittableChunkCount}) indicators
            </label>
          </div>
        )}

        {/* Mobile Selected Media Display */}
        {selectedMedia.length > 0 && (
          <div
            className={`mt-4 p-2 rounded-lg border-2 ${
              isDragOverTextarea
                ? 'border-yellow-500 border-dashed bg-yellow-50 dark:bg-yellow-900/20'
                : 'border-transparent'
            }`}
            onDragOver={handleTextareaDragOver}
            onDragLeave={handleTextareaDragLeave}
            onDrop={handleTextareaDrop}
          >
            <MediaUpload
              onMediaSelected={handleMediaSelected}
              onMediaRemoved={handleMediaRemoved}
              selectedMedia={selectedMedia}

              className=""
            />
          </div>
        )}

        {/* Mobile GIF Picker */}
        {showGifPicker && (
          <>
            {/* Backdrop */}
            <div
              className="fixed inset-0 z-40"
              onClick={() => setShowGifPicker(false)}
            />
            {/* Floating panel — anchored above the composer so it covers the post */}
            <div
              className={`fixed left-1/2 -translate-x-1/2 w-[calc(100%-2rem)] z-50 rounded-xl shadow-2xl max-h-[60vh] overflow-auto ${isDark ? 'border border-white/10 bg-black' : 'border border-gray-200 bg-white'}`}
              style={{ bottom: 'calc(var(--app-mobile-header-h, 4rem) + env(safe-area-inset-bottom))' }}
            >
              <GifPicker
                initialQuery={gifSearchQuery(text)}
                onSelect={handleGifSelected}
                onClose={() => setShowGifPicker(false)}
              />
            </div>
          </>
        )}

        {/* Mobile Emoji Picker */}
        {showEmojiPicker && (
          <>
            {/* Backdrop */}
            <div
              className="fixed inset-0 z-40"
              onClick={() => {
                setShowEmojiPicker(false)
                setEmojiPopover(null)
              }}
            />
            {/* Floating panel — opens near the emoji button in mobile feed */}
            <div
              ref={emojiPopoverRef}
              className={`fixed z-50 rounded-xl shadow-2xl max-h-[40vh] overflow-auto overscroll-contain ${emojiFadeClass} ${isDark ? 'border border-white/10 bg-black' : 'border border-gray-200 bg-white'}`}
              style={emojiPopover
                ? {
                    left: emojiPopover.x,
                    top: emojiPopover.y,
                    width: 'min(360px, calc(100vw - 2rem))',
                  }
                : {
                    left: '50%',
                    transform: 'translateX(-50%)',
                    width: 'calc(100% - 2rem)',
                    bottom: 'calc(env(safe-area-inset-bottom) + 0.75rem)',
                  }}
            >
              <div className="p-3">
                <div className="grid grid-cols-6 gap-2">
                  {['😀', '😂', '🤣', '😊', '😍', '🤔', '😎', '🔥', '💯', '❤️', '👍', '👎'].map(emoji => (
                    <button
                      key={emoji}
                      onClick={() => {
                        setText(prev => prev + emoji)
                        setShowEmojiPicker(false)
                        setEmojiPopover(null)
                      }}
                      className="p-1 text-2xl hover:bg-gray-200 dark:hover:bg-white/10 rounded transition-colors"
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Desktop Layout - Original.
          On mobile (composeMode), split into scrollable top + sticky
          bottom so the toolbar / thread info / shorten-URLs toggle stay
          glued to the keyboard edge while the textarea scrolls. On
          desktop the whole block lays out naturally — md: prefixes
          neutralize the mobile-only flex split. */}
      <div className={`${composeMode ? 'flex flex-col flex-1 min-h-0 md:block' : 'hidden md:block'}`}>
        <div className={`${composeMode ? 'flex-1 min-h-0 overflow-y-auto px-4 pt-2 pb-4 md:p-0 md:overflow-visible' : ''}`}>
        <div className="relative">
          {isThreadMode ? (
            <>
              {chunkSlices.map((slice, i) => (
                <React.Fragment key={i}>
                  {i > 0 && (
                    <div
                      style={{
                        borderTop: '1px dashed #f0b1005e',
                        marginLeft: '20px',
                        marginRight: '20px',
                        marginTop: '10px',
                        marginBottom: '10px',
                      }}
                    />
                  )}
                  <div className={allChunksSelected ? 'bg-yellow-500/20 rounded' : ''}>
                  <HighlightedTextarea
                    value={slice}
                    onChange={(e) => {
                      const localCursor = e.target.selectionStart ?? 0
                      pendingMasterCursorRef.current = chunkBoundaries[i] + localCursor
                      replaceChunk(i, e.target.value)
                      setActiveChunkIndex(i)
                      setActiveChunkCursor(localCursor)
                    }}
                    onClick={(e) => {
                      setActiveChunkIndex(i)
                      setActiveChunkCursor((e.target as HTMLTextAreaElement).selectionStart ?? 0)
                      setAllChunksSelected(false)
                    }}
                    onKeyUp={(e) => {
                      setActiveChunkIndex(i)
                      setActiveChunkCursor((e.target as HTMLTextAreaElement).selectionStart ?? 0)
                    }}
                    onKeyDown={(e) => handleChunkArrow(e, i)}
                    onBeforeInput={(e) => {
                      const ta = e.currentTarget as HTMLTextAreaElement
                      preInputStateRef.current = {
                        chunkIdx: i,
                        preCursorPos: ta.selectionStart ?? 0,
                        preSliceLen: ta.value.length,
                      }
                    }}
                    onDragOver={handleTextareaDragOver}
                    onDragLeave={handleTextareaDragLeave}
                    onDrop={handleTextareaDrop}
                    rows={desktopRows}
                    placeholder={i === 0
                      ? (replyTo
                          ? `Reply to @${replyTo.user.username}`
                          : (placeholder ?? (quote ? t('post_form.placeholder_quote') : t('post_form.placeholder'))))
                      : ''}
                    textareaRef={(el) => {
                          // Mobile + desktop PostForm instances both mount this loop.
                          // Only the visible instance (offsetParent !== null) should
                          // claim chunkRefs[i] — otherwise focus/setSelectionRange
                          // lands on a display:none textarea and silently no-ops.
                          if (el && el.offsetParent !== null) {
                            chunkRefs.current[i] = el
                            if (i === 0) (textareaRef as React.MutableRefObject<HTMLTextAreaElement | null>).current = el
                          } else if (!el && chunkRefs.current[i]) {
                            // Unmount: clear ONLY if we currently hold this node.
                            chunkRefs.current[i] = null
                          }
                        }}
                    fontSize={replyTo ? 'base' : 'xl'}
                    denser
                    autoResize
                  />
                  </div>
                </React.Fragment>
              ))}
              <MentionAutocomplete
                text={chunkSlices[activeChunkIndex] ?? ''}
                cursorPosition={activeChunkCursor}
                onSelect={handleMentionSelect}
                textareaRef={{ current: chunkRefs.current[activeChunkIndex] ?? null }}
              />
            </>
          ) : (
            <>
              <HighlightedTextarea
                value={text}
                onChange={handleTextChange}
                onClick={handleTextClick}
                onKeyUp={handleTextKeyUp}
                onDragOver={handleTextareaDragOver}
                onDragLeave={handleTextareaDragLeave}
                onDrop={handleTextareaDrop}
                rows={desktopRows}
                placeholder={
                  replyTo
                    ? `Reply to @${replyTo.user.username}`
                    : (
                      placeholder ?? (quote ? t('post_form.placeholder_quote') : t('post_form.placeholder'))
                    )
                }
                textareaRef={textareaRef}
                fontSize={replyTo ? 'base' : 'xl'}
                compact={!!replyTo || hasMedia}
                autoResize
              />
              <MentionAutocomplete
                text={text}
                cursorPosition={cursorPosition}
                onSelect={handleMentionSelect}
                textareaRef={textareaRef}
              />
            </>
          )}
          {/* Drag overlay */}
          {isDragOverTextarea && (
            <div className="top-[-3px] absolute inset-0 flex items-center justify-center bg-yellow-500/10 border-2 border-dashed border-yellow-500 rounded-lg pointer-events-none">
              <div className="text-center">
                {/* The icon's path only fills [4..20] of its 24×24 viewBox,
                    so there's ~4px of invisible bottom padding inside the
                    SVG. Use a negative top margin on the text to claw that
                    back; otherwise mb-0 still looks like a 12px gap. */}
                <svg className="mx-auto h-12 w-12 text-yellow-500 mb-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                <p className="-mt-2 text-lg font-medium text-yellow-600 dark:text-yellow-400">Drop photos or video here</p>
              </div>
            </div>
          )}
        </div>

        {/* Desktop Selected Media Display */}
        {selectedMedia.length > 0 && (
          <div
            className={`mt-4 p-2 rounded-lg border-2 ${
              isDragOverTextarea
                ? 'border-yellow-500 border-dashed bg-yellow-50 dark:bg-yellow-900/20'
                : 'border-transparent'
            }`}
            onDragOver={handleTextareaDragOver}
            onDragLeave={handleTextareaDragLeave}
            onDrop={handleTextareaDrop}
          >
            <MediaUpload
              onMediaSelected={handleMediaSelected}
              onMediaRemoved={handleMediaRemoved}
              selectedMedia={selectedMedia}

              className=""
            />
          </div>
        )}

        {/* GIF Picker (desktop) is rendered as a popover above the GIF button.
            Keeping it inline pushes the whole page down, which feels broken on desktop. */}

        {/* Emoji Picker (desktop) is rendered as a popover above the emoji button.
            Keeping it inline pushes the whole page down, which feels broken on desktop. */}

        {/* Poll composer */}
        {pollEnabled && (
          <PollComposer
            options={pollOptions}
            onChange={setPollOptions}
            optionImages={pollOptionImages}
            onChangeImages={setPollOptionImages}
            onClose={() => { setPollEnabled(false); setPollOptions([]); setPollOptionImages([]); setPollMultiSelect(false) }}
            position={pollPosition}
            onChangePosition={setPollPosition}
            showPositionPicker={isThreadMode}
            duration={pollDuration}
            onChangeDuration={setPollDuration}
            multiSelect={pollMultiSelect}
            onChangeMultiSelect={setPollMultiSelect}
          />
        )}

        {/* Scheduler */}
        {!replyTo && !quote && showScheduler && (
          <div className={`mt-4 p-4 border rounded-lg ${
            isDark ? 'border-white/20 bg-black' : 'border-gray-200 bg-gray-50'
          }`}>
            <div className="flex items-center space-x-2 mb-3">
              <HiCalendar className={`w-5 h-5 ${isDark ? 'text-yellow-400' : 'text-yellow-600'}`} />
              <span className={`font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                Schedule Post
              </span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={`block text-sm mb-1 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                  Date
                </label>
                <DesktopDatePicker
                  isDark={isDark}
                  value={scheduledDate}
                  open={schedulePicker === 'date'}
                  onOpenChange={(o) => setSchedulePicker(o ? 'date' : null)}
                  onChange={(v) => {
                    setScheduledDate(v)
                    setScheduleError(null)
                  }}
                />
              </div>
              <div>
                <label className={`block text-sm mb-1 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                  Time
                </label>
                <DesktopTimePicker
                  isDark={isDark}
                  value={scheduledTime}
                  open={schedulePicker === 'time'}
                  onOpenChange={(o) => setSchedulePicker(o ? 'time' : null)}
                  onChange={(v) => {
                    setScheduledTime(v)
                    setScheduleError(null)
                  }}
                />
              </div>
            </div>
            {scheduledDate && scheduledTime && (
              <p className={`mt-2 text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                <HiClock className="inline-block w-4 h-4 mr-1" />
                Scheduled for {new Date(`${scheduledDate}T${scheduledTime}`).toLocaleString()}
              </p>
            )}
            {scheduleError && (
              <p className="mt-2 text-sm text-red-400">
                {scheduleError}
              </p>
            )}
          </div>
        )}
        </div>{/* end scrollable region (composeMode) */}

        {/* Sticky footer on mobile composeMode: pinned to bottom while
            the textarea above scrolls. Wraps the toolbar + thread info
            + shorten-URLs toggle so the user can always reach Post and
            see thread/URL controls without dismissing the keyboard. */}
        <div className={composeMode ? `shrink-0 px-2 pt-2 pb-[max(env(safe-area-inset-bottom),0.5rem)] border-t md:p-0 md:border-0 md:pb-0 ${isDark ? 'bg-black border-white/10' : 'bg-white border-gray-200'}` : ''}>

        {/* Functionality Icons */}
        {/* Outer row: Post button stays pinned right (items-start so on the
            two-row icons case the Post button doesn't jump to mid-height).
            The icons block on the left is the only thing that wraps. */}
        <div className={`flex items-start justify-between gap-2 ${replyTo ? 'mt-1.5' : 'mt-4'} ${
          hasInlineFeedDraft
            ? `fixed md:static bottom-0 left-0 right-0 z-[60] px-4 py-3 pb-[max(env(safe-area-inset-bottom),0.75rem)] border-t ${isDark ? 'bg-black border-white/10' : 'bg-white border-gray-200'}`
            : composeMode
              ? ''
              : ''
        }`}>
          {/* Icons split into two groups so the toolbar collapses into a
              clean 3 + 4 split when wrapped instead of breaking one icon
              at a time. The first group (content embedding — Media / GIF /
              Emoji) sits inline with the Post button on the top row; the
              second group (post attributes — Schedule / Poll / Tip / AI)
              wraps to a second row when there isn't enough width.

              Outer gap-x mirrors the inner groups' gap-x so the inter-group
              spacing (Emoji ↔ Schedule) matches the intra-group spacing.
              Without this the parent kept gap-x-3 in compose/reply mode
              while the groups dropped to gap-x-1 → 8px asymmetric hole. */}
          <div className={`flex flex-wrap items-center min-w-0 gap-y-1 flex-1 ${
            composeMode || replyTo ? 'gap-x-1' : 'gap-x-1 sm:gap-x-3'
          }`}>
            {/* Group 1 — content embedding (3 icons) */}
            <div className={`flex items-center ${
              composeMode || replyTo ? 'gap-x-1' : 'gap-x-1 sm:gap-x-3'
            }`}>
            {/* Media Upload */}
            <button
              onClick={() => fileInputRef.current?.click()}
              className={`p-2 rounded-full transition-all duration-200 cursor-pointer ${
                selectedMedia.length > 0
                  ? 'text-yellow-500 bg-yellow-400/10'
                  : text.trim()
                    ? (isDark
                        ? 'text-yellow-400 hover:text-yellow-300 hover:bg-yellow-400/10'
                        : 'text-yellow-600 hover:text-yellow-500 hover:bg-yellow-200/50')
                    : (isDark
                        ? 'text-yellow-400/70 hover:text-yellow-400 hover:bg-yellow-400/10'
                        : 'text-yellow-600/70 hover:text-yellow-600 hover:bg-yellow-200/50')
              }`}>
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
            </button>

            {/* GIF */}
            <div className="relative">
              <button
                ref={gifButtonRef}
                type="button"
                onClick={() => {
                  if (gifDisabled) return
                  setShowGifPicker((v) => !v)
                  setShowEmojiPicker(false)
                }}
                disabled={gifDisabled}
                className={`p-2 rounded-full transition-all duration-200 ${
                gifDisabled
                  ? 'opacity-30 cursor-not-allowed'
                  : `cursor-pointer ${text.trim()
                    ? (isDark
                        ? 'text-yellow-400 hover:text-yellow-300 hover:bg-yellow-400/10'
                        : 'text-yellow-600 hover:text-yellow-500 hover:bg-yellow-200/50')
                    : (isDark
                        ? 'text-yellow-400/70 hover:text-yellow-400 hover:bg-yellow-400/10'
                        : 'text-yellow-600/70 hover:text-yellow-600 hover:bg-yellow-200/50')}`
              }`}
                aria-haspopup="dialog"
                aria-expanded={showGifPicker}
              >
                <span className="text-base font-medium">GIF</span>
              </button>

              {showGifPicker && (
                <>
                  {/* Backdrop: click outside closes */}
                  <div
                    className="fixed inset-0 z-40"
                    onClick={() => setShowGifPicker(false)}
                  />

                  {/* Mobile (<md): bottom-anchored sheet above keyboard.
                      Desktop (≥md, including the home inline composer
                      which also uses composeMode): anchored popover
                      hanging off the GIF button's relative parent. The
                      gating is by viewport, NOT composeMode — the home
                      inline composer also passes composeMode but lives
                      on a desktop page. */}
                  <div className="md:hidden fixed inset-x-3 bottom-3 z-[100] max-w-[520px] mx-auto max-h-[70vh] overflow-y-auto">
                    <GifPicker
                      initialQuery={gifSearchQuery(text)}
                      onSelect={handleGifSelected}
                      onClose={() => setShowGifPicker(false)}
                    />
                  </div>
                  {/* Desktop: portaled to document.body to escape any
                      overflow:hidden / overflow:auto ancestor (the
                      home inline composer's fixed wrapper, the desktop
                      ComposeModal's rounded-overflow-hidden box, etc).
                      Position is computed from the button's bounding
                      rect — opens upward so it doesn't get clipped by
                      the form bottom. */}
                  {(() => {
                    const rect = gifButtonRef.current?.getBoundingClientRect()
                    if (!rect) return null
                    const popoverW = Math.min(520, window.innerWidth - 32)
                    // Approximate popover height for fit-test. GifPicker
                    // is ~480px tall in its full layout — close enough
                    // to decide between hanging-down vs centered. If
                    // hanging down would clip the bottom, center on the
                    // viewport instead (covers the modal-near-bottom
                    // case where rect.bottom is already near viewport).
                    const POPOVER_H = 480
                    const overflowsBottom = rect.bottom + 8 + POPOVER_H > window.innerHeight - 16
                    const style: React.CSSProperties = overflowsBottom
                      ? {
                          left: '50%',
                          top: '50%',
                          transform: 'translate(-50%, -50%)',
                          width: popoverW,
                          maxHeight: 'calc(100vh - 32px)',
                          overflowY: 'auto',
                        }
                      : {
                          left: Math.max(16, Math.min(rect.left, window.innerWidth - popoverW - 16)),
                          top: rect.bottom + 8,
                          width: popoverW,
                        }
                    return createPortal(
                      <div className="hidden md:block fixed z-[100]" style={style}>
                        <GifPicker
                          initialQuery={gifSearchQuery(text)}
                          onSelect={handleGifSelected}
                          onClose={() => setShowGifPicker(false)}
                        />
                      </div>,
                      document.body,
                    )
                  })()}
                </>
              )}
            </div>

            {/* Emoji Picker */}
            <div className="relative">
              <button
                ref={emojiButtonRef}
                type="button"
                onClick={() => {
                  setShowEmojiPicker(!showEmojiPicker)
                  setShowGifPicker(false)
                }}
                className={`p-2 rounded-full transition-all duration-200 cursor-pointer ${
                text.trim()
                  ? (isDark
                      ? 'text-yellow-400 hover:text-yellow-300 hover:bg-yellow-400/10'
                      : 'text-yellow-600 hover:text-yellow-500 hover:bg-yellow-200/50')
                  : (isDark
                      ? 'text-yellow-400/70 hover:text-yellow-400 hover:bg-yellow-400/10'
                      : 'text-yellow-600/70 hover:text-yellow-600 hover:bg-yellow-200/50')
              }`}
                aria-haspopup="dialog"
                aria-expanded={showEmojiPicker}
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.828 14.828a4 4 0 01-5.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </button>

              {showEmojiPicker && (
                <>
                  {/* Backdrop: click outside closes */}
                  <div
                    className="fixed inset-0 z-40"
                    onClick={() => setShowEmojiPicker(false)}
                  />

                  {(() => {
                    const grid = (
                      <div className="grid grid-cols-8 gap-2 max-h-48 overflow-y-auto">
                        {['😀', '😂', '🤣', '😊', '😍', '🤔', '😎', '🔥', '💯', '❤️', '👍', '👎', '👏', '🙏', '💪', '🚀'].map(emoji => (
                          <button
                            key={emoji}
                            onClick={() => {
                              setText(prev => prev + emoji)
                              setShowEmojiPicker(false)
                            }}
                            className="p-2 text-2xl hover:bg-gray-200 dark:hover:bg-white/10 rounded transition-colors"
                          >
                            {emoji}
                          </button>
                        ))}
                      </div>
                    )
                    const rect = emojiButtonRef.current?.getBoundingClientRect()
                    const popoverW = Math.min(420, typeof window !== 'undefined' ? window.innerWidth - 32 : 420)
                    // Emoji picker is short (~220px), but mirror the
                    // GifPicker fit-test for consistency: if hanging
                    // down would clip, center it instead.
                    const POPOVER_H = 220
                    const overflowsBottom = !!rect && rect.bottom + 8 + POPOVER_H > window.innerHeight - 16
                    const desktopStyle: React.CSSProperties = overflowsBottom
                      ? {
                          left: '50%',
                          top: '50%',
                          transform: 'translate(-50%, -50%)',
                          width: popoverW,
                        }
                      : {
                          left: rect ? Math.max(16, Math.min(rect.left, window.innerWidth - popoverW - 16)) : 0,
                          top: rect ? rect.bottom + 8 : 0,
                          width: popoverW,
                        }
                    return (
                      <>
                        <div
                          className={`md:hidden fixed inset-x-3 bottom-3 z-[100] max-w-[420px] mx-auto p-3 border rounded-xl shadow-2xl ${emojiFadeClass} ${
                            isDark ? 'border-white/10 bg-black' : 'border-gray-200 bg-white'
                          }`}
                        >
                          {grid}
                        </div>
                        {rect && createPortal(
                          <div
                            className={`hidden md:block fixed z-[100] p-3 border rounded-xl shadow-2xl ${emojiFadeClass} ${
                              isDark ? 'border-white/10 bg-black' : 'border-gray-200 bg-white'
                            }`}
                            style={desktopStyle}
                          >
                            {grid}
                          </div>,
                          document.body,
                        )}
                      </>
                    )
                  })()}
                </>
              )}
            </div>
            </div>
            {/* Group 2 — post attributes (4 icons). flex-1 lets it fill
                the row width on wrap; justify-start hugs them to the left
                edge of that filled width (matches the alignment of group
                1 above, which also pins left). */}
            <div className={`flex flex-1 items-center justify-start ${
              composeMode || replyTo ? 'gap-x-1' : 'gap-x-1 sm:gap-x-3'
            }`}>

            {/* Schedule Post (not for replies/quotes) */}
            {!replyTo && !quote && (
              <button
                onClick={() => setShowScheduler(!showScheduler)}
                className={`p-2 rounded-full transition-all duration-200 cursor-pointer ${
                text.trim()
                  ? (isDark
                      ? 'text-yellow-400 hover:text-yellow-300 hover:bg-yellow-400/10'
                      : 'text-yellow-600 hover:text-yellow-500 hover:bg-yellow-200/50')
                  : (isDark
                      ? 'text-yellow-400/70 hover:text-yellow-400 hover:bg-yellow-400/10'
                      : 'text-yellow-600/70 hover:text-yellow-600 hover:bg-yellow-200/50')
              }`}>
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </button>
            )}

            {/* Add poll. Initializes with two empty options when first
                opened — matching Twitter / X's "two choices required"
                expectation, so the user immediately sees what they're about
                to fill in. */}
            <button
              onClick={() => {
                if (pollEnabled) {
                  setPollEnabled(false)
                  setPollOptions([])
                  setPollOptionImages([])
                } else {
                  setPollEnabled(true)
                  setPollOptions(['', ''])
                  setPollOptionImages(['', ''])
                }
              }}
              aria-label={pollEnabled ? 'Remove poll' : 'Add poll'}
              className={`p-2 rounded-full transition-all duration-200 cursor-pointer ${
                pollEnabled
                  ? (isDark ? 'text-yellow-400 bg-yellow-400/10' : 'text-yellow-600 bg-yellow-200/50')
                  : text.trim()
                    ? (isDark
                        ? 'text-yellow-400 hover:text-yellow-300 hover:bg-yellow-400/10'
                        : 'text-yellow-600 hover:text-yellow-500 hover:bg-yellow-200/50')
                    : (isDark
                        ? 'text-yellow-400/70 hover:text-yellow-400 hover:bg-yellow-400/10'
                        : 'text-yellow-600/70 hover:text-yellow-600 hover:bg-yellow-200/50')
              }`}
            >
              <HiOutlineChartBar className="w-6 h-6" />
            </button>

            {/* Tip attachment — embedded in the CAW action's recipients[]/amounts[]. */}
            <TipAttachmentControl
              text={text}
              replyTo={replyTo}
              ownTokenIds={activeToken?.tokenId ? [activeToken.tokenId] : []}
              values={tipAttachments}
              onChange={setTipAttachments}
              iconSizeClass="w-6 h-6"
            />

            {/* AI image generation — available in every composer (incl.
                replies + quotes). Narrow-context overflow is handled by
                the outer flex-wrap on the toolbar row. -ml-1 nudges the
                hitbox to line up with the rest of the toolbar. */}
            <button
              type="button"
              onClick={openAiImages}
              title={t('post_form.ai.tooltip')}
              aria-label={t('post_form.ai.aria')}
              className={`relative p-2 -ml-1 rounded-full transition-all duration-200 cursor-pointer ${
                text.trim()
                  ? (isDark
                      ? 'text-yellow-400 hover:text-yellow-300 hover:bg-yellow-400/10'
                      : 'text-yellow-600 hover:text-yellow-500 hover:bg-yellow-200/50')
                  : (isDark
                      ? 'text-yellow-400/70 hover:text-yellow-400 hover:bg-yellow-400/10'
                      : 'text-yellow-600/70 hover:text-yellow-600 hover:bg-yellow-200/50')
              }`}
            >
              <AiGlitterIcon sizeClass="w-6 h-6" />
            </button>
            </div>

          </div>

          {/* Character counter, token status and Post Button. The outer
              justify-between pins this right; items-start on the outer
              row keeps it top-aligned when the icons block wraps to two
              rows so the Post button stays where the eye expects it. */}
          <div className="flex items-center space-x-3 flex-shrink-0">
            {/* Token ownership and character counter */}
            <div className="flex items-center space-x-3">
              {isThreadMode && !composeMode && (
                <span className={`text-sm font-medium px-2 py-0.5 rounded ${
                  isDark ? 'bg-yellow-500/20 text-yellow-400' : 'bg-yellow-100 text-yellow-700'
                }`}>
                  {currentChunkIndex + 1}/{submittableChunkCount}
                </span>
              )}
              {(text.length > 0 || selectedMedia.length > 0) && (
                <span
                  title={t('post_form.bytes_remaining')}
                  className={`text-sm font-medium ${
                    charCount <= 20
                      ? 'text-yellow-500'
                      : isDark ? 'text-gray-400' : 'text-gray-500'
                  }`}
                >
                  {charCount}
                </span>
              )}
            </div>

            {(() => {
                const wrongWallet2 = isConnected && !isTokenOwner && !hasActiveSession && activeToken?.tokenId
                const tooltipText2 = wrongWallet2 ? t('post_form.error.wrong_wallet_tooltip') : ''
                const threadTooLong2 = isThreadMode && submittableChunkCount > MAX_THREAD_LENGTH
                const isDisabled2 = (!text && selectedMedia.length === 0 && !pollMarker) || isOverLimit || !canPost || isSubmitting || isScheduling || threadTooLong2 || pollInvalid
                const btn2 = (
                  <button
                    ref={submitBtnRef}
                    className="px-3 sm:px-5 py-2 bg-yellow-500 text-black font-semibold text-sm sm:text-base rounded-full hover:bg-yellow-400 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200 shadow-lg hover:shadow-xl cursor-pointer min-w-0 truncate"
                    disabled={isDisabled2}
                    onClick={handleSubmit}
                  >
                    {wrongWallet2 ? t('post_form.button.wrong_wallet') : hasNoToken ? t('post_form.button.create_account') : uploadProgress ? uploadProgress : signingProgress ? <>{t('post_form.button.signing_progress')} <span ref={signingCountRef2}>1</span>/{signingProgress.total}...</> : isSubmitting ? t('post_form.button.signing') : isThreadMode ? t('post_form.button.thread', { count: submittableChunkCount }) : replyTo ? t('post_form.button.reply') : t('post_form.button.post')}
                  </button>
                )
                return tooltipText2 ? <Tooltip text={tooltipText2}>{btn2}</Tooltip> : btn2
              })()
            }
          </div>
        </div>

        {isThreadMode && submittableChunkCount > MAX_THREAD_LENGTH && (
          <p className="text-xs text-error-dim mt-1 text-right">Thread exceeds {MAX_THREAD_LENGTH} post limit. Shorten your text to continue.</p>
        )}

        {/* Desktop Thread Info */}
        {isThreadMode && (
          <div className={`mt-3 p-3 rounded-lg ${
            isDark ? 'bg-yellow-500/10 border border-yellow-500/30' : 'bg-yellow-50 border border-yellow-200'
          }`}>
            <div className="flex items-center gap-2">
              <svg className="w-4 h-4 flex-shrink-0 text-yellow-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
              </svg>
              <span className={`text-sm ${isDark ? 'text-yellow-200' : 'text-yellow-800'}`}>
                This will be posted as a thread of {submittableChunkCount} posts
              </span>
            </div>
            {selectedMedia.length > 0 && (
              <div className={`flex items-center gap-4 mt-2 text-sm ${isDark ? 'text-yellow-200' : 'text-yellow-800'}`}>
                <span>{t('post_form.attach_media_to')}</span>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input type="radio" name="mediaPosDesktop" checked={mediaPosition === 'start'} onChange={() => setMediaPosition('start')} className="accent-yellow-500" />
                  First post
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input type="radio" name="mediaPosDesktop" checked={mediaPosition === 'end'} onChange={() => setMediaPosition('end')} className="accent-yellow-500" />
                  Last post
                </label>
              </div>
            )}
            <label className={`flex items-center gap-2 cursor-pointer text-sm mt-2 ${isDark ? 'text-yellow-200' : 'text-yellow-800'}`}>
              <input
                type="checkbox"
                checked={includePageIndicators}
                onChange={(e) => setIncludePageIndicators(e.target.checked)}
                className="w-4 h-4 rounded accent-yellow-500"
              />
              Include (1/{submittableChunkCount}) indicators
            </label>
          </div>
        )}

        {/* Shorten URLs toggle. Only rendered when the draft actually has at
            least one URL — otherwise the toggle is irrelevant and just adds
            noise. The tooltip names the current host so it reads right on
            caw.social, localhost, preview deploys, etc.
            `.search()` instead of `URL_REGEX.test()` — the constant has the
            `g` flag and `.test()` would alternate true/false on each render. */}
        {text.search(URL_REGEX) !== -1 && (
          <div className="flex items-center mt-3">
            <Tooltip
              text={`Your URLs will show their original text in your post,\nbut on-chain they will be stored using the ${typeof window !== 'undefined' ? window.location.hostname : 'caw.social'} domain`}
            >
              <label className="inline-flex items-center gap-2 cursor-pointer select-none">
                <button
                  type="button"
                  role="switch"
                  aria-checked={shortenUrls}
                  onClick={() => setShortenUrls(s => !s)}
                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors duration-200 focus:outline-none ${
                    shortenUrls
                      ? 'bg-yellow-500'
                      : (isDark ? 'bg-white/20' : 'bg-gray-300')
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform duration-200 ${
                      shortenUrls ? 'translate-x-4' : 'translate-x-0.5'
                    }`}
                  />
                </button>
                <span className={`text-sm ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                  Shorten URLs on chain
                </span>
              </label>
            </Tooltip>
          </div>
        )}
        </div>{/* end sticky footer (composeMode) */}
      </div>

      {/* Scheduled Post Success Modal */}
      {showScheduledSuccessModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/60"
            onClick={() => setShowScheduledSuccessModal(false)}
          />
          <div className={`relative z-10 w-full max-w-sm mx-4 p-6 rounded-2xl shadow-xl ${
            isDark ? 'bg-black border border-white/10' : 'bg-white border border-gray-200'
          }`}>
            <div className="text-center">
              <div className={`w-16 h-16 mx-auto mb-4 rounded-full flex items-center justify-center ${
                isDark ? 'bg-green-500/20' : 'bg-green-100'
              }`}>
                <HiCalendar className="w-8 h-8 text-green-500" />
              </div>
              <h3 className={`text-xl font-bold mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                Post Scheduled!
              </h3>
              <p className={`text-sm mb-4 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                Your post will be published on
              </p>
              <p className={`text-base font-medium mb-6 ${isDark ? 'text-yellow-400' : 'text-yellow-600'}`}>
                {scheduledSuccessTime?.toLocaleString()}
              </p>
              <button
                onClick={() => setShowScheduledSuccessModal(false)}
                className="w-full py-3 px-4 rounded-full font-semibold bg-yellow-500 hover:bg-yellow-600 text-black transition-colors"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      <AiProviderConnectModal
        isOpen={aiModalOpen}
        onClose={() => setAiModalOpen(false)}
        onConnect={() => {
          setAiModalOpen(false)
          // Close the host composer modal (ComposePostModal passes its
          // onClose as onSuccess) so we don't navigate to settings with the
          // post modal still floating on top. No-op for the inline feed
          // composer (it just refreshes; it unmounts on navigation anyway).
          onSuccess?.()
          aiNavigate('/settings/ai-provider')
        }}
      />
      <AiImageGenerateModal
        isOpen={aiGenOpen}
        onClose={() => setAiGenOpen(false)}
        onImage={handleAiImage}
      />
    </div>
  )
}

export default PostForm
