import React, { useState, useRef, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useSignAndSubmitAction, buildTypedData, TYPES } from '../api/actions'

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
import { getUserAvatar } from '~/utils/defaultAvatar'
import { BsWallet } from 'react-icons/bs'
import MediaUpload from './MediaUpload'
import { useHasActiveSession } from '~/hooks/useHasActiveSession'
import { usePendingPostsStore } from '~/store/pendingPostsStore'
import { useUserByUsername } from '~/hooks/useUserData'
import Tooltip from '~/components/Tooltip'
import { apiFetch } from '~/api/client'
import { HiCalendar, HiClock } from 'react-icons/hi'
import MentionAutocomplete from './MentionAutocomplete'
import GifPicker from './GifPicker'

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

    let shortenedText = text
    for (const [originalUrl, data] of Object.entries(response.results)) {
      // Replace all occurrences of this URL with the short URL
      shortenedText = shortenedText.split(originalUrl).join(data.shortUrl)
    }

    return shortenedText
  } catch (error) {
    // Return original text if shortening fails
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
}

const PostForm: React.FC<PostFormProps> = ({ replyTo, quote, onSuccess, placeholder }) => {
  const { isConnected } = useAccount();
  const { openConnectModal } = useConnectModal();
  const hasActiveSession = useHasActiveSession();
  const connections = useConnections();
  const { isDark } = useTheme()

  // Auto-focus the textarea when component mounts (e.g., when modal opens)
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.focus()
    }
  }, [])

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
  const [selectedMedia, setSelectedMedia] = useState<any[]>([])
  const [isDragOverTextarea, setIsDragOverTextarea] = useState(false)
  const [showGifPicker, setShowGifPicker] = useState(false)
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)
  const [showScheduler, setShowScheduler] = useState(false)
  const [scheduledDate, setScheduledDate] = useState('')
  const [scheduledTime, setScheduledTime] = useState('')
  const [isScheduling, setIsScheduling] = useState(false)
  const [scheduleError, setScheduleError] = useState<string | null>(null)
  const [showMediaUpload, setShowMediaUpload] = useState(false)
  const [showMediaOverlay, setShowMediaOverlay] = useState(false)
  const [showScheduledSuccessModal, setShowScheduledSuccessModal] = useState(false)
  const [scheduledSuccessTime, setScheduledSuccessTime] = useState<Date | null>(null)
  const [includePageIndicators, setIncludePageIndicators] = useState(true)
  const [mediaPosition, setMediaPosition] = useState<'start' | 'end'>('start')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [signingProgress, setSigningProgress] = useState<{ current: number; total: number } | null>(null)
  const signingTotal = signingProgress?.total ?? 0
  // Refs to the count-up <span>s inside each submit button variant. We write
  // textContent directly to avoid re-rendering the whole form on every tick —
  // signing is main-thread heavy, and React reconciliation would starve it.
  const signingCountRef1 = useRef<HTMLSpanElement | null>(null)
  const signingCountRef2 = useRef<HTMLSpanElement | null>(null)
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

    for (const file of Array.from(files)) {
      const isImage = file.type.startsWith('image/')
      const isVideo = file.type.startsWith('video/')

      if (!isImage && !isVideo) continue

      // Check limits
      const currentImages = selectedMedia.filter(m => m.type === 'image').length
      const currentVideos = selectedMedia.filter(m => m.type === 'video').length

      if (isImage && currentImages + newMedia.filter(m => m.type === 'image').length >= 4) continue
      if (isVideo && currentVideos + newMedia.filter(m => m.type === 'video').length >= 1) continue

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

    // Reset input so same file can be selected again
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  // Handle text change and cursor position for mention autocomplete
  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value)
    setCursorPosition(e.target.selectionStart)
  }

  const handleTextClick = (e: React.MouseEvent<HTMLTextAreaElement>) => {
    setCursorPosition((e.target as HTMLTextAreaElement).selectionEnd ?? (e.target as HTMLTextAreaElement).selectionStart)
  }

  const handleTextKeyUp = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    setCursorPosition((e.target as HTMLTextAreaElement).selectionEnd ?? (e.target as HTMLTextAreaElement).selectionStart)
  }

  // Handle mention selection from autocomplete
  const handleMentionSelect = (username: string, startPos: number, endPos: number) => {
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

  // Helper function to upload media files
  const uploadMedia = async (files: File[], type: 'image' | 'video', tokenId: number) => {
    const formData = new FormData()
    files.forEach(file => formData.append('media', file))
    formData.append('type', type)
    formData.append('tokenId', tokenId.toString())

    const { getAuthHeaders } = await import('~/api/client')
    const response = await fetch('/api/upload', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: formData
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`Upload failed: ${text}`)
    }

    return response.json()
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

        // Handle GIFs (already have URLs from Giphy)
        const gifs = selectedMedia.filter(m => m.type === 'gif')
        if (gifs.length > 0) {
          const gifUrls = gifs.map(gif => `\n${gif.url}`).join('')
          finalText = finalText + gifUrls
        }

        // Replace original URLs with short URLs for on-chain submission
        // (skipped entirely when the user turned shortening off).
        if (shortenUrls) finalText = await shortenUrlsInText(getOnChainText(finalText))

        // Split into thread chunks if needed — mirrors the immediate-post path.
        const chunks = splitTextIntoChunks(finalText, includePageIndicators)

        // Same MAX_THREAD_LENGTH guard as the immediate-post path. Catch this
        // before reserving cawonces so a bounced submit doesn't leave a gap
        // in the local cawonce store. The submit button is also disabled
        // when over the cap (see threadTooLong/threadTooLong2 below) — this
        // is defense-in-depth for paste / programmatic flows.
        if (chunks.length > MAX_THREAD_LENGTH) return

        // Reserve sequential cawonces for the whole thread up front so async
        // syncs don't reuse them. (Same approach as the immediate-post path.)
        const startCawonce = activeToken?.cawonce ?? 0
        const threadCawonces = chunks.map((_, i) => startCawonce + i)
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
          const raw = error?.message || 'Something went wrong scheduling this post.'
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
        const imageFiles = offChainImages.map(({ media }) => media.file)
        const uploadResult = await uploadMedia(imageFiles, 'image', effectiveTokenId)

        if (uploadResult.success && uploadResult.urls) {
          // Map URLs back to their original positions
          offChainImages.forEach(({ index }, i) => {
            uploadedUrls.set(index, uploadResult.urls![i])
          })
        } else {
          return
        }
      } catch (error) {
        return
      }
    }

    // Upload videos
    if (videos.length > 0) {
      try {
        const videoFiles = videos.map(({ media }) => media.file)
        const uploadResult = await uploadMedia(videoFiles, 'video', effectiveTokenId)

        if (uploadResult.success && uploadResult.urls) {
          // Map URLs back to their original positions
          videos.forEach(({ index }, i) => {
            uploadedUrls.set(index, uploadResult.urls![i])
          })
        } else {
          return
        }
      } catch (error) {
        return
      }
    }

    // Now build the media URLs list in order
    const mediaUrls: string[] = []

    selectedMedia.forEach((media, index) => {
      let url: string | undefined
      if (media.type === 'image') {
        url = uploadedUrls.get(index)
      } else if (media.type === 'video') {
        // Video - use the uploaded URL (already has video: prefix)
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

    // Replace original URLs with short URLs for on-chain submission
    // (skipped entirely when the user turned shortening off).
    if (shortenUrls) finalText = await shortenUrlsInText(getOnChainText(finalText))

    // effectiveTokenId is already defined at the start of handleSubmit

    // For replies and quotes, include the original post's info
    const parentCaw = replyTo || quote

    // Split into thread chunks if text exceeds the limit
    const chunks = splitTextIntoChunks(finalText, includePageIndicators)

    // Show the count-up immediately so the button goes straight from "Post" to
    // "Signing 1/N" instead of showing a transient "Signing..." while budget /
    // cawonce prep runs. Progress updates later in the signing loop still win.
    if (chunks.length > 1) setSigningProgress({ current: 1, total: chunks.length })

    // If media goes at end of thread, check if it fits in the last chunk or needs its own
    if (isThreadMode && mediaPosition === 'end' && mediaBlock && chunks.length > 1) {
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

    // Get the current cawonce BEFORE submitting (signAndSubmit bumps it internally)
    const getCawonce = () => {
      const state = useTokenDataStore.getState()
      for (const tokens of Object.values(state.tokensByAddress)) {
        const found = tokens.find(t => t.tokenId === effectiveTokenId)
        if (found) return found.cawonce ?? 0
      }
      return 0
    }

    // Verify the cawonce range is clear before signing. The local
    // useTokenDataStore.cawonce can drift from on-chain reality (other tabs,
    // other devices, missed bumpCawonce events, action processor races) and
    // signing with a stale cawonce results in a wasted on-chain failure +
    // auto-retry. Cheap one-shot check that lets us fix the local store
    // before signing instead of after the fact.
    try {
      const { findSafeCawonceStart } = await import('~/api/actions')
      const currentCawonce = getCawonce()
      const safeCawonce = await findSafeCawonceStart(effectiveTokenId, currentCawonce, chunks.length)
      if (safeCawonce !== currentCawonce) {
        console.log(`[Post] Cawonce conflict detected: local=${currentCawonce}, resetting to safe=${safeCawonce}`)
        const setCawonce = useTokenDataStore.getState().setCawonce
        setCawonce(effectiveTokenId, safeCawonce)
      }
    } catch (err) {
      console.warn('[Post] Could not verify cawonce range, proceeding with local value:', err)
    }

    // Pre-allocate cawonces for the entire thread upfront.
    // This prevents race conditions where other async processes (cawonce sync,
    // txqueue monitor retries) overwrite the store cawonce mid-thread.
    const startCawonce = getCawonce()
    const threadCawonces = chunks.map((_, i) => startCawonce + i)
    // Immediately bump the store past the entire range so nothing else uses these
    const setCawonce = useTokenDataStore.getState().setCawonce
    setCawonce(effectiveTokenId, startCawonce + chunks.length)

    // Post first chunk (with media, parent info, etc.)
    // Quotes use actionType 'recaw' (with text) so the original author receives funds.
    // Replies use actionType 'caw' with a parent reference.
    const firstParams: ActionParams = {
      actionType: quote ? 'recaw' : 'caw',
      senderId: effectiveTokenId,
      text: chunks[0],
      cawonce: threadCawonces[0],
      ...(parentCaw && {
        receiverId: parentCaw.user.tokenId,
        receiverCawonce: parentCaw.cawonce,
      }),
      ...(totalCawCost > 0 && {
        amounts: [totalCawCost]
      })
    }

    const firstPostCawonce = threadCawonces[0]

    // Check if we can batch via Quick Sign session
    const checkCanBatch = async () => {
      if (chunks.length <= 1 || typeof (signAndSubmit as any).many !== 'function') return false
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

    // Batch-submit a set of chunk params via .many(), adding pending posts for each
    const batchSubmitChunks = async (params: ActionParams[], chunkOffset: number) => {
      const responses = await (signAndSubmit as any).many(params, (p: any) => {
        setSigningProgress({ current: chunkOffset + p.signed, total: chunks.length })
      })
      if (activeToken) {
        for (let i = 0; i < params.length; i++) {
          const r = responses[i]
          if (!r || r.error) continue
          const isFirstChunk = chunkOffset + i === 0
          const tempId = addPendingPost({
            content: chunks[chunkOffset + i],
            username: activeToken.username,
            displayName: activeUserData?.displayName,
            tokenId: effectiveTokenId,
            avatarUrl: avatars[effectiveTokenId] || getUserAvatar({ tokenId: effectiveTokenId }),
            cawonce: r.cawonce,
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

    // Build reply params for chunks after the first
    const buildReplyParams = (startIdx: number): ActionParams[] =>
      chunks.slice(startIdx).map((text, i) => ({
        actionType: 'caw' as const,
        senderId: effectiveTokenId,
        text,
        cawonce: threadCawonces[startIdx + i],
        receiverId: effectiveTokenId,
        receiverCawonce: firstPostCawonce,
      }))

    if (await checkCanBatch()) {
      // Fast path: batch all chunks (including first) through .many()
      await batchSubmitChunks([firstParams, ...buildReplyParams(1)], 0)
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
              const tempId = addPendingPost({
                content: chunks[i],
                username: activeToken.username,
                displayName: activeUserData?.displayName,
                tokenId: effectiveTokenId,
                avatarUrl: avatars[effectiveTokenId] || getUserAvatar({ tokenId: effectiveTokenId }),
                cawonce: replyResponse.cawonce,
                replyToId: firstPendingId,
                parent: firstPendingPost,
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
    onSuccess?.()
    } catch (error: any) {
      // Ignore errors (user may have rejected signature)
    } finally {
      setIsSubmitting(false)
      setSigningProgress(null)
    }
  }

  // Calculate total media URL character cost
  const getMediaCharCost = () => {
    let mediaCost = 0
    const images = selectedMedia.filter(m => m.type === 'image')
    const videos = selectedMedia.filter(m => m.type === 'video')
    const gifs = selectedMedia.filter(m => m.type === 'gif')
    mediaCost += images.length * 80
    mediaCost += videos.length * 90
    mediaCost += gifs.length * 100
    return mediaCost
  }

  const imageCount = selectedMedia.filter(m => m.type === 'image' || m.type === 'gif').length
  const gifDisabled = imageCount >= 4

  // Thread splitting info — all length comparisons here are in BYTES (matches the on-chain check).
  // Use on-chain byte length (with short URLs) for accurate counting.
  const mediaCost = getMediaCharCost() // already in bytes (media refs are ASCII)
  const textBytes = onChainByteLen(text)
  const effectiveTextLength = textBytes + mediaCost
  const isThreadMode = effectiveTextLength > POST_CHAR_LIMIT
  const firstChunkMediaCost = (!isThreadMode || mediaPosition === 'start') ? mediaCost : 0
  const lastChunkMediaCost = (isThreadMode && mediaPosition === 'end') ? mediaCost : 0
  const { chunkCount, chunkBoundaries } = getChunkInfo(text, includePageIndicators, firstChunkMediaCost, lastChunkMediaCost)

  // Figure out which chunk the cursor is in
  // When media gets its own dedicated last chunk, the cursor should never land there —
  // cap to the last text chunk so the counter shows remaining bytes for actual text.
  const hasMediaOnlyChunk = mediaPosition === 'end' && chunkCount >= 2 && chunkBoundaries[chunkCount - 1] === text.length
  const maxCursorChunk = hasMediaOnlyChunk ? chunkCount - 2 : chunkCount - 1
  const currentChunkIndex = (() => {
    if (!isThreadMode) return 0
    for (let i = chunkBoundaries.length - 1; i >= 0; i--) {
      if (cursorPosition >= chunkBoundaries[i]) return Math.min(i, maxCursorChunk)
    }
    return 0
  })()

  // Calculate bytes remaining for the current chunk (uses on-chain byte lengths
  // so the counter reflects the actual space available after URL shortening)
  const calculateCharCount = () => {
    if (!isThreadMode) {
      return POST_CHAR_LIMIT - effectiveTextLength
    }
    // In thread mode, show remaining bytes for the current chunk
    const chunkStart = chunkBoundaries[currentChunkIndex]
    const chunkEnd = currentChunkIndex < chunkBoundaries.length - 1
      ? chunkBoundaries[currentChunkIndex + 1]
      : text.length
    const chunkLen = onChainByteLen(text.slice(chunkStart, chunkEnd))
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
  const desktopRows = Math.max(3, Math.min(lineCount, 12))
  const isOverLimit = false // Thread mode handles overflow by splitting

  return (
    <div className={`p-4 transition-all duration-300 ${isDark ? 'bg-black' : 'bg-white'}`}>
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
      <div className="md:hidden flex flex-col space-y-2">
          {/* Input and Reply Button Row */}
          <div className="flex items-center space-x-3">
            {/* Input */}
            <div className="flex-1 relative">
              <HighlightedTextarea
                value={text}
                onChange={handleTextChange}
                onClick={handleTextClick}
                onKeyUp={handleTextKeyUp}
                onDragOver={handleTextareaDragOver}
                onDragLeave={handleTextareaDragLeave}
                onDrop={handleTextareaDrop}
                rows={1}
                placeholder={
                  replyTo
                    ? `Reply to @${replyTo.user.username}`
                    : (
                      placeholder ?? (quote ? "Add a comment" : "What's happening?")
                    )
                }
                textareaRef={textareaRef}
                fontSize="base"
              />
              <MentionAutocomplete
                text={text}
                cursorPosition={cursorPosition}
                onSelect={handleMentionSelect}
                textareaRef={textareaRef}
              />
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
                  chunkCount > 300
                    ? (isDark ? 'bg-red-500/20 text-red-400' : 'bg-red-100 text-red-700')
                    : (isDark ? 'bg-yellow-500/20 text-yellow-400' : 'bg-yellow-100 text-yellow-700')
                }`}>
                  {currentChunkIndex + 1}/{chunkCount}
                </span>
              )}
              {(text.length > 0 || selectedMedia.length > 0) && (
                <span
                  title="Bytes remaining"
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

          {/* Mobile Icons Row */}
          <div className="flex items-center justify-between">
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
                onClick={() => !gifDisabled && setShowGifPicker(!showGifPicker)}
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
                onClick={() => setShowEmojiPicker(!showEmojiPicker)}
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
                const tooltipText = wrongWallet ? 'Please switch to the correct wallet' : ''
                const threadTooLong = isThreadMode && chunkCount > MAX_THREAD_LENGTH
                const isDisabled = (!text && selectedMedia.length === 0) || isOverLimit || !canPost || isSubmitting || isScheduling || threadTooLong
                const btn = (
                  <button
                    ref={submitBtnRef}
                    className="px-3 py-1.5 bg-yellow-500 text-black font-semibold text-sm rounded-full hover:bg-yellow-400 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200 shadow-lg hover:shadow-xl cursor-pointer"
                    disabled={isDisabled}
                    onClick={handleSubmit}
                  >
                    {wrongWallet ? 'Wrong Wallet' : signingProgress ? <>Signing <span ref={signingCountRef1}>1</span>/{signingProgress.total}...</> : isSubmitting ? 'Signing...' : isThreadMode ? `Thread (${chunkCount})` : replyTo ? 'Reply' : 'Post'}
                  </button>
                )
                return tooltipText ? <Tooltip text={tooltipText}>{btn}</Tooltip> : btn
              })()
            }
          </div>

        {isThreadMode && chunkCount > MAX_THREAD_LENGTH && (
          <p className="text-xs text-red-500 mt-1 text-right">Thread exceeds {MAX_THREAD_LENGTH} post limit. Shorten your text to continue.</p>
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
                This will be posted as a thread of {chunkCount} posts
              </span>
            </div>
            {selectedMedia.length > 0 && (
              <div className={`flex items-center gap-3 mt-1 text-xs ${isDark ? 'text-yellow-200' : 'text-yellow-800'}`}>
                <span>Attach media to:</span>
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
              Include (1/{chunkCount}) indicators
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
          <div className="mt-4">
            <GifPicker
              initialQuery={gifSearchQuery(text)}
              onSelect={handleGifSelected}
              onClose={() => setShowGifPicker(false)}
            />
          </div>
        )}

        {/* Mobile Emoji Picker */}
        {showEmojiPicker && (
          <div className={`mt-4 p-4 border rounded-lg ${
            isDark ? 'border-white/20 bg-black' : 'border-gray-200 bg-gray-50'
          }`}>
            <div className="grid grid-cols-6 gap-2 max-h-32 overflow-y-auto">
              {['😀', '😂', '🤣', '😊', '😍', '🤔', '😎', '🔥', '💯', '❤️', '👍', '👎'].map(emoji => (
                <button
                  key={emoji}
                  onClick={() => {
                    setText(prev => prev + emoji)
                    setShowEmojiPicker(false)
                  }}
                  className="p-1 text-xl hover:bg-gray-200 dark:hover:bg-white/10 rounded transition-colors"
                >
                  {emoji}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Desktop Layout - Original */}
      <div className="hidden md:block">
        <div className="relative">
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
                  placeholder ?? (quote ? "Add a comment" : "What's happening?")
                )
            }
            textareaRef={textareaRef}
            fontSize="xl"
          />
          <MentionAutocomplete
            text={text}
            cursorPosition={cursorPosition}
            onSelect={handleMentionSelect}
            textareaRef={textareaRef}
          />
          {/* Drag overlay */}
          {isDragOverTextarea && (
            <div className="top-[-3px] absolute inset-0 flex items-center justify-center bg-yellow-500/10 border-2 border-dashed border-yellow-500 rounded-lg pointer-events-none">
              <div className="text-center">
                <svg className="mx-auto h-12 w-12 text-yellow-500 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                <p className="text-lg font-medium text-yellow-600 dark:text-yellow-400">Drop photos or video here</p>
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

        {/* GIF Picker */}
        {showGifPicker && (
          <div className="mt-4">
            <GifPicker
              initialQuery={gifSearchQuery(text)}
              onSelect={handleGifSelected}
              onClose={() => setShowGifPicker(false)}
            />
          </div>
        )}

        {/* Emoji Picker */}
        {showEmojiPicker && (
          <div className={`mt-4 p-4 border rounded-lg ${
            isDark ? 'border-white/20 bg-black' : 'border-gray-200 bg-gray-50'
          }`}>
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
          </div>
        )}

        {/* Scheduler */}
        {showScheduler && (
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
                <input
                  type="date"
                  value={scheduledDate}
                  onChange={(e) => { setScheduledDate(e.target.value); setScheduleError(null) }}
                  min={new Date().toISOString().split('T')[0]}
                  className={`w-full px-3 py-2 rounded-lg border transition-colors ${
                    isDark
                      ? 'bg-gray-700 border-gray-600 text-white focus:border-yellow-400'
                      : 'bg-white border-gray-300 text-gray-900 focus:border-yellow-500'
                  } focus:outline-none`}
                />
              </div>
              <div>
                <label className={`block text-sm mb-1 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                  Time
                </label>
                <input
                  type="time"
                  value={scheduledTime}
                  onChange={(e) => { setScheduledTime(e.target.value); setScheduleError(null) }}
                  className={`w-full px-3 py-2 rounded-lg border transition-colors ${
                    isDark
                      ? 'bg-gray-700 border-gray-600 text-white focus:border-yellow-400'
                      : 'bg-white border-gray-300 text-gray-900 focus:border-yellow-500'
                  } focus:outline-none`}
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

        {/* Functionality Icons */}
        <div className="flex items-center justify-between mt-4">
          <div className="flex items-center space-x-3">
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
            <button
              onClick={() => !gifDisabled && setShowGifPicker(!showGifPicker)}
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
            }`}>
              <span className="text-base font-medium">GIF</span>
            </button>

            {/* Emoji Picker */}
            <button
              onClick={() => setShowEmojiPicker(!showEmojiPicker)}
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
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.828 14.828a4 4 0 01-5.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </button>

            {/* Schedule Post */}
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

          </div>

          {/* Character counter, token status and Post Button */}
          <div className="flex items-center space-x-3">
            {/* Token ownership and character counter */}
            <div className="flex items-center space-x-3">
              {isThreadMode && (
                <span className={`text-sm font-medium px-2 py-0.5 rounded ${
                  isDark ? 'bg-yellow-500/20 text-yellow-400' : 'bg-yellow-100 text-yellow-700'
                }`}>
                  {currentChunkIndex + 1}/{chunkCount}
                </span>
              )}
              {(text.length > 0 || selectedMedia.length > 0) && (
                <span
                  title="Bytes remaining"
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
                const tooltipText2 = wrongWallet2 ? 'Please switch to the correct wallet' : ''
                const threadTooLong2 = isThreadMode && chunkCount > MAX_THREAD_LENGTH
                const isDisabled2 = (!text && selectedMedia.length === 0) || isOverLimit || !canPost || isSubmitting || isScheduling || threadTooLong2
                const btn2 = (
                  <button
                    ref={submitBtnRef}
                    className="px-5 py-2 bg-yellow-500 text-black font-semibold text-base rounded-full hover:bg-yellow-400 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200 shadow-lg hover:shadow-xl cursor-pointer"
                    disabled={isDisabled2}
                    onClick={handleSubmit}
                  >
                    {wrongWallet2 ? 'Wrong Wallet' : hasNoToken ? 'Create Account' : signingProgress ? <>Signing <span ref={signingCountRef2}>1</span>/{signingProgress.total}...</> : isSubmitting ? 'Signing...' : isThreadMode ? `Thread (${chunkCount})` : replyTo ? 'Reply' : 'Post'}
                  </button>
                )
                return tooltipText2 ? <Tooltip text={tooltipText2}>{btn2}</Tooltip> : btn2
              })()
            }
          </div>
        </div>

        {isThreadMode && chunkCount > MAX_THREAD_LENGTH && (
          <p className="text-xs text-red-500 mt-1 text-right">Thread exceeds {MAX_THREAD_LENGTH} post limit. Shorten your text to continue.</p>
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
                This will be posted as a thread of {chunkCount} posts
              </span>
            </div>
            {selectedMedia.length > 0 && (
              <div className={`flex items-center gap-4 mt-2 text-sm ${isDark ? 'text-yellow-200' : 'text-yellow-800'}`}>
                <span>Attach media to:</span>
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
              Include (1/{chunkCount}) indicators
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
      </div>

      {/* Scheduled Post Success Modal */}
      {showScheduledSuccessModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setShowScheduledSuccessModal(false)}
          />
          <div className={`relative z-10 w-full max-w-sm mx-4 p-6 rounded-2xl shadow-xl ${
            isDark ? 'bg-gray-900 border border-white/10' : 'bg-white border border-gray-200'
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
    </div>
  )
}

export default PostForm

