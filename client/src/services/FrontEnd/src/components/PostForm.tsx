import React, { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { useSignAndSubmitAction, buildTypedData, TYPES, DOMAIN } from '../api/actions'
import { useTokenDataStore, useActiveToken } from "~/store/tokenDataStore";
import { useAccount, useChains, useSwitchChain, useConnections, useSignTypedData } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import type { ActionParams } from '~/api/actions'
import { baseSepolia } from "wagmi/chains";
import type { CawItem } from '~/types'
import { useTheme } from '~/hooks/useTheme'
import { BsWallet } from 'react-icons/bs'
import MediaUpload from './MediaUpload'
import type { MediaType, StorageType } from './MediaUpload'
import { calculateOnChainCost } from '~/utils/imageUtils'
import { useHasActiveSession } from '~/hooks/useHasActiveSession'
import { usePendingPostsStore } from '~/store/pendingPostsStore'
import Tooltip from '~/components/Tooltip'
import { apiFetch } from '~/api/client'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { HiCalendar, HiClock, HiX, HiPhotograph } from 'react-icons/hi'
import MentionAutocomplete from './MentionAutocomplete'
import GifPicker from './GifPicker'
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
const URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`[\]]+/gi

// Helper function to shorten URLs in text
async function shortenUrlsInText(text: string): Promise<string> {
  const urls = text.match(URL_REGEX)
  if (!urls || urls.length === 0) return text

  // Deduplicate URLs
  const uniqueUrls = [...new Set(urls)]

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
}

const PostForm: React.FC<PostFormProps> = ({ replyTo, quote, onSuccess }) => {
  const postFormQc = useQueryClient()

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

  const [text, setText] = useState('')
  const [cursorPosition, setCursorPosition] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [selectedMedia, setSelectedMedia] = useState<any[]>([])
  const [isDragOverTextarea, setIsDragOverTextarea] = useState(false)
  const [showGifPicker, setShowGifPicker] = useState(false)
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)
  const [showScheduler, setShowScheduler] = useState(false)
  const [scheduledDate, setScheduledDate] = useState('')
  const [scheduledTime, setScheduledTime] = useState('')
  const [isScheduling, setIsScheduling] = useState(false)
  const [isProcessingOnChain, setIsProcessingOnChain] = useState(false)
  const [showMediaUpload, setShowMediaUpload] = useState(false)
  const [showMediaOverlay, setShowMediaOverlay] = useState(false)
  const [showScheduledSuccessModal, setShowScheduledSuccessModal] = useState(false)
  const [scheduledSuccessTime, setScheduledSuccessTime] = useState<Date | null>(null)
  const [includePageIndicators, setIncludePageIndicators] = useState(true)
  const [mediaPosition, setMediaPosition] = useState<'start' | 'end'>('start')
  const [showImageLibrary, setShowImageLibrary] = useState(false)
  const [libraryImages, setLibraryImages] = useState<any[]>([])
  const [libraryNextCursor, setLibraryNextCursor] = useState<number | undefined>(undefined)
  const [libraryHasMore, setLibraryHasMore] = useState(false)
  const [isLoadingMoreLibrary, setIsLoadingMoreLibrary] = useState(false)
  const libraryScrollRef = useRef<HTMLDivElement>(null)
  const [isLoadingLibrary, setIsLoadingLibrary] = useState(false)
  const [libraryUnpostedCount, setLibraryUnpostedCount] = useState(0)
  const [libraryTotalCount, setLibraryTotalCount] = useState(0)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const activeTokenId = useTokenDataStore(state => state.activeTokenId);
  const activeToken = useActiveToken();
  const avatars = useTokenDataStore(s => s.avatarsByTokenId);
  const signAndSubmit = useSignAndSubmitAction()
  const { signTypedDataAsync } = useSignTypedData()
  const bumpCawonce = useTokenDataStore(s => s.bumpCawonce)
  const addPendingPost = usePendingPostsStore((state) => state.addPendingPost)
  const updatePostWithTxQueueId = usePendingPostsStore((state) => state.updatePostWithTxQueueId)

  const { switchChain } = useSwitchChain();
  const chains = useChains();
  const { address } = useAccount();
  const handleSwitchChain = () => switchChain({ chainId: baseSepolia.id });
  const wrongChain = connections[0]?.chainId != baseSepolia.id;

  // Check if the user owns the selected token
  const isTokenOwner = activeToken && address && activeToken.owner?.toLowerCase() === address.toLowerCase();
  const hasNoToken = !activeToken?.tokenId;
  const canPost = !hasNoToken && (hasActiveSession || (isTokenOwner && !wrongChain && isConnected));

  const handleMediaSelected = async (media: any[]) => {
    // Check if any image was just toggled to on-chain (compare with current state)
    const updatedMedia = await Promise.all(media.map(async (item, index) => {
      const prevItem = selectedMedia[index]

      // Check if this image was just changed to on-chain and doesn't have an uploadedRef yet
      if (
        item.type === 'image' &&
        item.storageType === 'on-chain' &&
        !item.uploadedRef &&
        item.file &&
        prevItem?.storageType !== 'on-chain'
      ) {
        // Read the file as base64 and check against library
        try {
          const base64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader()
            reader.onload = () => resolve(reader.result as string)
            reader.onerror = reject
            reader.readAsDataURL(item.file)
          })

          const imageData = base64.split(',')[1] // Remove data:image/...;base64, prefix

          // Check if this image already exists in user's library
          const existingImage = libraryImages.find(img => {
            const existingBase64 = img.base64Data.includes(',')
              ? img.base64Data.split(',')[1]
              : img.base64Data
            return existingBase64 === imageData
          })

          if (existingImage) {
            return {
              ...item,
              uploadedRef: existingImage.imageRef,
              uploadStatus: 'success' as const,
              isFromLibrary: true,
              preview: existingImage.base64Data.startsWith('data:')
                ? existingImage.base64Data
                : `data:image/jpeg;base64,${existingImage.base64Data}`
            }
          }
        } catch (error) {
          // Ignore duplicate check errors
        }
      }

      return item
    }))

    setSelectedMedia(updatedMedia)
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

  // Fetch library counts (for showing icon and badge)
  const effectiveTokenId = activeTokenId || activeToken?.tokenId
  const { data: libraryCounts } = useQuery({
    queryKey: ['libraryUnpostedCount', effectiveTokenId],
    queryFn: () => apiFetch<{ unpostedCount: number; totalCount: number }>(
      `/api/on-chain-images/unposted-count/${effectiveTokenId}`
    ),
    enabled: !!effectiveTokenId,
  })

  useEffect(() => {
    if (libraryCounts) {
      setLibraryUnpostedCount(libraryCounts.unpostedCount || 0)
      setLibraryTotalCount(libraryCounts.totalCount || 0)
    }
  }, [libraryCounts])

  // Fetch library images for duplicate detection when toggling on-chain
  useEffect(() => {
    fetchImageLibrary()
  }, [activeTokenId, activeToken?.tokenId])

  // Fetch on-chain images from the user's library (only SUCCESS status)
  const fetchImageLibrary = async (cursor?: number) => {
    const effectiveTokenId = activeTokenId || activeToken?.tokenId
    if (!effectiveTokenId) return

    const isLoadingMore = cursor !== undefined
    if (isLoadingMore) {
      setIsLoadingMoreLibrary(true)
    } else {
      setIsLoadingLibrary(true)
    }

    try {
      const url = cursor
        ? `/api/on-chain-images?userId=${effectiveTokenId}&status=SUCCESS&cursor=${cursor}`
        : `/api/on-chain-images?userId=${effectiveTokenId}&status=SUCCESS`

      const response = await apiFetch<{ items: any[]; nextCursor?: number; hasMore: boolean }>(url)

      if (isLoadingMore) {
        // Append to existing images
        setLibraryImages(prev => [...prev, ...(response.items || [])])
      } else {
        // Replace images
        setLibraryImages(response.items || [])
      }

      setLibraryNextCursor(response.nextCursor)
      setLibraryHasMore(response.hasMore)

      // Also refresh counts on initial load
      if (!isLoadingMore) {
        postFormQc.invalidateQueries({ queryKey: ['libraryUnpostedCount', effectiveTokenId] })
      }
    } catch (error) {
      if (!isLoadingMore) {
        setLibraryImages([])
      }
    } finally {
      if (isLoadingMore) {
        setIsLoadingMoreLibrary(false)
      } else {
        setIsLoadingLibrary(false)
      }
    }
  }

  // Handle scroll in library modal to load more
  const handleLibraryScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const target = e.target as HTMLDivElement
    const scrolledToBottom = target.scrollHeight - target.scrollTop <= target.clientHeight + 50

    if (scrolledToBottom && libraryHasMore && !isLoadingMoreLibrary && libraryNextCursor) {
      fetchImageLibrary(libraryNextCursor)
    }
  }

  // Ignore an image (dismiss "not posted" badge)
  const handleIgnoreImage = async (imageId: number) => {
    try {
      await apiFetch(`/api/on-chain-images/${imageId}/ignore`, {
        method: 'PATCH',
        body: JSON.stringify({ ignored: true })
      })
      // Update local state
      setLibraryImages(prev => prev.map(img =>
        img.id === imageId ? { ...img, ignored: true } : img
      ))
      // Update counts
      setLibraryUnpostedCount(prev => Math.max(0, prev - 1))
    } catch (error) {
      // Ignore errors
    }
  }

  // Mark images as posted after successful submission
  const markImagesAsPosted = async (imageRefs: string[]) => {
    if (imageRefs.length === 0) return
    try {
      await apiFetch('/api/on-chain-images/mark-posted', {
        method: 'PATCH',
        body: JSON.stringify({ imageRefs })
      })
      // Refresh counts after posting
      postFormQc.invalidateQueries({ queryKey: ['libraryUnpostedCount', effectiveTokenId] })
    } catch (error) {
      // Ignore errors
    }
  }

  // Open image library modal
  const handleOpenImageLibrary = () => {
    setShowImageLibrary(true)
    fetchImageLibrary()
  }

  // Select an image from the library to add to the post
  const handleSelectLibraryImage = (image: any) => {
    // Add the library image to selectedMedia with the uploadedRef already set
    // This will be picked up by the submit logic and added to the final text
    const libraryMedia = {
      type: 'image',
      storageType: 'on-chain',
      uploadedRef: image.imageRef, // e.g., "img:5:33"
      preview: image.base64Data.startsWith('data:')
        ? image.base64Data
        : `data:image/jpeg;base64,${image.base64Data}`,
      isFromLibrary: true, // Flag to identify library images
      uploadStatus: 'success' // Already uploaded
    }
    setSelectedMedia(prev => [...prev, libraryMedia])
    setShowImageLibrary(false)
  }

  // Poll OnChainImage status for pending uploads
  const pollImageStatus = async (txQueueId: number, mediaIndex: number, imageRef: string) => {
    const maxAttempts = 60 // Poll for up to 3 minutes (60 * 3 seconds)
    let attempts = 0

    const poll = async () => {
      try {
        // Poll the OnChainImage status endpoint
        const response = await apiFetch<{ id: number; imageRef: string; status: string; reason?: string }>(
          `/api/on-chain-images/status?txId=${txQueueId}`
        )

        if (response.status === 'SUCCESS') {
          // Update media to show success
          setSelectedMedia(prev => prev.map((m, i) =>
            i === mediaIndex ? { ...m, uploadStatus: 'success', uploadedRef: imageRef } : m
          ))
          // Increment library counts so the on-chain image icon becomes visible
          setLibraryTotalCount(prev => prev + 1)
          setLibraryUnpostedCount(prev => prev + 1)
          return
        } else if (response.status === 'FAILED') {
          // Update media to show failure
          setSelectedMedia(prev => prev.map((m, i) =>
            i === mediaIndex ? { ...m, uploadStatus: 'failed', uploadedRef: undefined, failureReason: response.reason } : m
          ))
          return
        }

        // Still pending, poll again
        attempts++
        if (attempts < maxAttempts) {
          setTimeout(poll, 3000) // Poll every 3 seconds
        }
      } catch (error: any) {
        // If 404, the record might not exist yet, keep polling
        if (error?.status === 404) {
          attempts++
          if (attempts < maxAttempts) {
            setTimeout(poll, 3000) // Poll every 3 seconds
          }
          return
        }
        // On error, keep polling
        attempts++
        if (attempts < maxAttempts) {
          setTimeout(poll, 3000) // Poll every 3 seconds
        }
      }
    }

    poll()
  }

  // Upload on-chain images to blockchain (signs and submits each image)
  const handleUploadOnChain = async () => {
    const onChainImages = selectedMedia.filter(m => m.type === 'image' && m.storageType === 'on-chain' && !m.uploadedRef && m.uploadStatus !== 'pending')

    if (onChainImages.length === 0) return

    const effectiveTokenId = activeTokenId || activeToken?.tokenId
    if (!effectiveTokenId) return

    // Fetch latest library images to check for duplicates
    let currentLibraryImages = libraryImages
    if (currentLibraryImages.length === 0) {
      try {
        const response = await apiFetch<{ items: any[] }>(
          `/api/on-chain-images?userId=${effectiveTokenId}&status=SUCCESS`
        )
        currentLibraryImages = response.items || []
        setLibraryImages(currentLibraryImages)
      } catch (error) {
        // Ignore errors
      }
    }

    setIsProcessingOnChain(true)

    try {
      // Process images sequentially (not in parallel) to ensure each gets a unique cawonce
      // When using Promise.all, all images would read the same stale cawonce value

      // Get indices of images that need to be uploaded
      const indicesToProcess = selectedMedia
        .map((media, index) => ({ media, index }))
        .filter(({ media }) =>
          media.type === 'image' &&
          media.storageType === 'on-chain' &&
          !media.uploadedRef &&
          media.uploadStatus !== 'pending'
        )
        .map(({ index }) => index)

      for (const index of indicesToProcess) {
        // Read current state fresh each iteration
        const currentMedia = selectedMedia[index]

        // Read file as base64
        const base64 = await new Promise<string>((resolve) => {
          const reader = new FileReader()
          reader.onloadend = () => resolve(reader.result as string)
          reader.readAsDataURL(currentMedia.file)
        })

        const imageData = base64.split(',')[1] // Remove data:image/...;base64, prefix

        // Check if this image already exists in user's library (compare base64)
        const existingImage = currentLibraryImages.find(img => {
          const existingBase64 = img.base64Data.includes(',')
            ? img.base64Data.split(',')[1]
            : img.base64Data
          return existingBase64 === imageData
        })

        if (existingImage) {
          // Update the media with the existing reference - no need to upload again
          setSelectedMedia(prev => prev.map((m, i) =>
            i === index ? {
              ...m,
              uploadedRef: existingImage.imageRef,
              uploadStatus: 'success' as const,
              isFromLibrary: true,
              preview: existingImage.base64Data.startsWith('data:')
                ? existingImage.base64Data
                : `data:image/jpeg;base64,${existingImage.base64Data}`
            } : m
          ))
          continue
        }

        // Calculate cost from base64 length to match backend exactly
        const estimatedOriginalSize = Math.ceil((imageData.length * 3) / 4)
        const cawCost = calculateOnChainCost(estimatedOriginalSize)

        // Capture the cawonce BEFORE signing - read fresh from store each time
        // activeToken is a stale hook value, so we must read from getState() directly
        // The store uses tokensByAddress: Record<Address, TokenData[]>, not tokens
        const preSignState = useTokenDataStore.getState()
        const allTokens = Object.values(preSignState.tokensByAddress).flat()
        const preSignToken = allTokens.find(t => t.tokenId === effectiveTokenId)
        const cawonceForThisImage = preSignToken?.cawonce ?? 0
        const imageRef = `img:${effectiveTokenId}:${cawonceForThisImage}`

        // Sign and submit the image as an OTHER action
        let response
        try {
          response = await signAndSubmit({
            actionType: 'other',
            senderId: effectiveTokenId,
            text: `image64:${imageData}`,
            amounts: [BigInt(cawCost)]
          })
        } catch (signError: any) {
          // User rejected signature or other error - skip this image but continue with others
          continue
        }

        if (!response) continue

        // Note: signAndSubmit already bumps cawonce internally, so the next loop iteration
        // will read the updated cawonce from the store

        // OnChainImage record is now created server-side by POST /api/actions
        if (response.txQueueId) {
          // Start polling for image status
          pollImageStatus(response.txQueueId, index, imageRef)
        }

        // Update state immediately after each image is processed
        setSelectedMedia(prev => prev.map((m, i) =>
          i === index ? {
            ...m,
            processedBase64: imageData,
            processedCost: cawCost,
            uploadStatus: 'pending' as const,
            txQueueId: response.txQueueId,
            pendingImageRef: imageRef // Store ref for when tx succeeds
          } : m
        ))
      }
    } catch (error) {
      // Ignore errors
    } finally {
      setIsProcessingOnChain(false)
    }
  }

  // Check if there are on-chain images that need to be uploaded (includes failed ones for retry)
  const hasUnuploadedOnChainImages = selectedMedia.some(
    m => m.type === 'image' && m.storageType === 'on-chain' && !m.uploadedRef && m.uploadStatus !== 'pending'
  )

  // Check if there are pending uploads (tx submitted but not confirmed)
  const hasPendingUploads = selectedMedia.some(
    m => m.type === 'image' && m.uploadStatus === 'pending'
  )

  // Check if there are failed uploads
  const hasFailedUploads = selectedMedia.some(
    m => m.type === 'image' && m.uploadStatus === 'failed'
  )

  // Retry failed uploads - clears failed state and re-triggers upload
  const handleRetryFailedUploads = async () => {
    // Clear failed state first
    setSelectedMedia(prev => prev.map(m =>
      m.uploadStatus === 'failed'
        ? { ...m, uploadStatus: undefined, txQueueId: undefined, processedCost: undefined }
        : m
    ))
    // Wait a tick for state to update, then trigger upload
    setTimeout(() => {
      handleUploadOnChain()
    }, 100)
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

      setIsScheduling(true)
      try {
        const scheduledAt = new Date(`${scheduledDate}T${scheduledTime}`)

        // Prepare image data if any
        let imageData = null
        const images = selectedMedia.filter(m => m.type === 'image')
        if (images.length > 0) {
          // For scheduled posts, only support on-chain images
          const onChainImages = images.filter(img => img.storageType === 'on-chain')
          if (onChainImages.length > 0) {
            imageData = onChainImages.map(img => img.content).join('|||')
          }
        }

        // Build the post content (same as regular posts)
        let finalText = text
        if (imageData) {
          finalText = text + '\n' + imageData.split('|||').map((img: string) => `image64:${img}`).join('\n')
        }

        // Handle GIFs (already have URLs from Giphy)
        const gifs = selectedMedia.filter(m => m.type === 'gif')
        if (gifs.length > 0) {
          const gifUrls = gifs.map(gif => `\n${gif.url}`).join('')
          finalText = finalText + gifUrls
        }

        // Shorten any URLs in the text (including GIF URLs)
        finalText = await shortenUrlsInText(finalText)

        // Get current cawonce
        const currentCawonce = activeToken?.cawonce ?? 0

        // Build EIP-712 typed data (same as regular post)
        const { domain, types, primaryType, message } = buildTypedData({
          actionType: 'caw',
          senderId: effectiveTokenId,
          text: finalText,
          cawonce: currentCawonce
        })

        // Sign the action (user will see the signature request)
        const signature = await signTypedDataAsync({
          domain,
          types: { ActionData: TYPES.ActionData },
          primaryType,
          message
        })

        // Bump cawonce after successful signature
        bumpCawonce(effectiveTokenId)

        // Send to scheduled API with the signed data
        await apiFetch('/api/scheduled', {
          method: 'POST',
          body: JSON.stringify({
            content: text,
            scheduledAt: scheduledAt.toISOString(),
            imageData,
            // Include signed action data for later processing
            signedAction: {
              data: message,
              domain,
              types,
              signature
            }
          }),
          headers: { 'x-user-id': effectiveTokenId.toString() }
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
        // Ignore errors (user may have rejected signature)
      } finally {
        setIsScheduling(false)
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
      .filter(({ media }) => media.type === 'image' && media.storageType !== 'on-chain')
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
        if (media.storageType === 'on-chain') {
          // On-chain image - use the uploadedRef
          if ((media as any).uploadedRef) {
            url = `[${(media as any).uploadedRef}]`
          }
        } else {
          // Off-chain image - use the uploaded URL
          url = uploadedUrls.get(index)
        }
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

    // Shorten any URLs in the text (including GIF URLs, but not on-chain refs)
    finalText = await shortenUrlsInText(finalText)

    // effectiveTokenId is already defined at the start of handleSubmit

    // For replies and quotes, include the original post's info
    const parentCaw = replyTo || quote

    // Split into thread chunks if text exceeds the limit
    const chunks = splitTextIntoChunks(finalText, includePageIndicators)

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

    // For threads (multiple chunks), verify the cawonce range is clear.
    // This prevents "cawonce already used" errors from cancelled retries.
    if (chunks.length > 1) {
      try {
        const { findSafeCawonceStart } = await import('~/api/actions')
        const currentCawonce = getCawonce()
        const safeCawonce = await findSafeCawonceStart(effectiveTokenId, currentCawonce, chunks.length)
        if (safeCawonce !== currentCawonce) {
          console.log(`[Thread] Cawonce conflict detected: local=${currentCawonce}, resetting to safe=${safeCawonce}`)
          const setCawonce = useTokenDataStore.getState().setCawonce
          setCawonce(effectiveTokenId, safeCawonce)
        }
      } catch (err) {
        console.warn('[Thread] Could not verify cawonce range, proceeding with local value:', err)
      }
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

    const response = await signAndSubmit(firstParams)

    // If signAndSubmit returned null (e.g. insufficient stake modal), don't clear the form
    if (!response) return

    // Only add pending post AFTER signing succeeds (not before)
    // This prevents showing the post before user confirms the signature
    if (!replyTo && activeToken) {
      const tempId = addPendingPost({
        content: chunks[0],
        username: activeToken.username,
        tokenId: effectiveTokenId,
        avatarUrl: avatars[effectiveTokenId] || undefined
      })

      // Update pending post with txQueue ID if available
      if (response.txQueueId) {
        updatePostWithTxQueueId(tempId, response.txQueueId)
      }
    }

    // Post remaining chunks as replies to the first post
    const firstPostCawonce = threadCawonces[0]
    for (let i = 1; i < chunks.length; i++) {
      const replyParams: ActionParams = {
        actionType: 'caw',
        senderId: effectiveTokenId,
        text: chunks[i],
        cawonce: threadCawonces[i],
        receiverId: effectiveTokenId,
        receiverCawonce: firstPostCawonce,
      }

      const replyResponse = await signAndSubmit(replyParams)
      if (!replyResponse) break // User cancelled or error

      // Add pending posts for thread replies too
      if (activeToken) {
        const tempId = addPendingPost({
          content: chunks[i],
          username: activeToken.username,
          tokenId: effectiveTokenId,
          avatarUrl: avatars[effectiveTokenId] || undefined
        })
        if (replyResponse.txQueueId) {
          updatePostWithTxQueueId(tempId, replyResponse.txQueueId)
        }
      }
    }

    // Mark any library images (from on-chain library) as posted
    const libraryImageRefs = selectedMedia
      .filter(m => m.type === 'image' && m.storageType === 'on-chain' && m.uploadedRef && m.isFromLibrary)
      .map(m => m.uploadedRef)
    if (libraryImageRefs.length > 0) {
      markImagesAsPosted(libraryImageRefs)
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
    }
  }

  // Calculate total media URL character cost
  const getMediaCharCost = () => {
    let mediaCost = 0
    const offChainImages = selectedMedia.filter(m => m.type === 'image' && m.storageType !== 'on-chain')
    const videos = selectedMedia.filter(m => m.type === 'video')
    const gifs = selectedMedia.filter(m => m.type === 'gif')
    const onChainWithRef = selectedMedia.filter(m => m.type === 'image' && m.storageType === 'on-chain' && m.uploadedRef)
    onChainWithRef.forEach(img => {
      mediaCost += `[${img.uploadedRef}] `.length
    })
    mediaCost += offChainImages.length * 80
    mediaCost += videos.length * 90
    mediaCost += gifs.length * 100
    return mediaCost
  }

  // Thread splitting info — all length comparisons here are in BYTES (matches the on-chain check).
  const mediaCost = getMediaCharCost() // already in bytes (media refs are ASCII)
  const textBytes = byteLen(text)
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

  // Calculate bytes remaining for the current chunk
  const calculateCharCount = () => {
    if (!isThreadMode) {
      return POST_CHAR_LIMIT - effectiveTextLength
    }
    // In thread mode, show remaining bytes for the current chunk
    const chunkStart = chunkBoundaries[currentChunkIndex]
    const chunkEnd = currentChunkIndex < chunkBoundaries.length - 1
      ? chunkBoundaries[currentChunkIndex + 1]
      : text.length
    const chunkLen = byteLen(text.slice(chunkStart, chunkEnd))
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
                      quote ? "Add a comment" : "What's happening?"
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
                  isDark ? 'bg-yellow-500/20 text-yellow-400' : 'bg-yellow-100 text-yellow-700'
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
                onClick={() => setShowGifPicker(!showGifPicker)}
                className={`px-3 py-1 rounded-full text-base font-medium transition-all duration-200 cursor-pointer ${
                text.trim()
                  ? (isDark
                      ? 'text-yellow-400 hover:text-yellow-300 hover:bg-yellow-400/10'
                      : 'text-yellow-600 hover:text-yellow-500 hover:bg-yellow-200/50')
                  : (isDark
                      ? 'text-yellow-400/70 hover:text-yellow-400 hover:bg-yellow-400/10'
                      : 'text-yellow-600/70 hover:text-yellow-600 hover:bg-yellow-200/50')
              }`}>
                GIF
              </button>

              {/* Image Library (On-Chain) - only show if user has uploaded images */}
              {libraryTotalCount > 0 && (
                <div className="relative">
                  <button
                    onClick={handleOpenImageLibrary}
                    className={`p-1 rounded-full transition-all duration-200 cursor-pointer hover:bg-yellow-400/10`}
                    title="Previously uploaded on-chain images"
                  >
                    <img src="/icons/on-chain-images.svg" alt="On-chain images" className="w-[27px] h-[27px] min-w-[27px] opacity-85 hover:opacity-100 transition-opacity translate-y-[3px]" />
                  </button>
                  {/* Unposted badge */}
                  {libraryUnpostedCount > 0 && (
                    <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] px-0.5 flex items-center justify-center bg-red-500 text-white text-[9px] font-bold rounded-full">
                      {libraryUnpostedCount}
                    </span>
                  )}
                </div>
              )}

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

            {/* Right side - Action buttons (Connect/Switch/Post/etc.) */}
            { !isConnected && !hasActiveSession ? (
              <button
                className="px-3 py-1.5 bg-yellow-500 text-black font-semibold text-sm rounded-full hover:bg-yellow-400 transition-all duration-200 shadow-lg hover:shadow-xl cursor-pointer flex items-center justify-center gap-1"
                onClick={openConnectModal}
              >
                <BsWallet className="w-3 h-3" />
                Connect
              </button>
            ) : !hasActiveSession && wrongChain ? (
              <button className="px-3 py-1.5 bg-yellow-500 text-black font-semibold text-sm rounded-full hover:bg-yellow-400 transition-all duration-200 shadow-lg hover:shadow-xl cursor-pointer" onClick={handleSwitchChain}>
                Switch
              </button>
            ) : hasNoToken ? (
              <Link
                to="/usernames/new"
                className="px-3 py-1.5 bg-yellow-500 text-black font-semibold text-sm rounded-full hover:bg-yellow-400 transition-all duration-200 shadow-lg hover:shadow-xl cursor-pointer"
              >
                Create profile
              </Link>
            ) : (() => {
                const wrongWallet = !isTokenOwner && !hasActiveSession && activeToken?.tokenId
                const tooltipText = wrongWallet ? 'Please switch to the correct wallet' : hasPendingUploads ? 'Waiting for upload to confirm...' : isSubmitting ? (isThreadMode ? 'Waiting for signatures...' : 'Waiting for signature...') : ''
                const isDisabled = (!text && selectedMedia.length === 0) || isOverLimit || !canPost || isProcessingOnChain || hasPendingUploads || isSubmitting
                const btn = (
                  <button
                    className="px-3 py-1.5 bg-yellow-500 text-black font-semibold text-sm rounded-full hover:bg-yellow-400 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200 shadow-lg hover:shadow-xl cursor-pointer"
                    disabled={isDisabled}
                    onClick={hasFailedUploads ? handleRetryFailedUploads : hasUnuploadedOnChainImages ? handleUploadOnChain : handleSubmit}
                  >
                    {wrongWallet ? 'Wrong Wallet' : isSubmitting ? 'Signing...' : isProcessingOnChain ? 'Uploading...' : hasPendingUploads ? 'Pending...' : hasFailedUploads ? 'Retry' : hasUnuploadedOnChainImages ? 'Upload' : isThreadMode ? `Thread (${chunkCount})` : replyTo ? 'Reply' : 'Post'}
                  </button>
                )
                return tooltipText ? <Tooltip text={tooltipText}>{btn}</Tooltip> : btn
              })()
            }
          </div>

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
              isProcessingOnChain={isProcessingOnChain}
              className=""
            />
          </div>
        )}

        {/* Mobile GIF Picker */}
        {showGifPicker && (
          <div className="mt-4">
            <GifPicker
              initialQuery={text.trim()}
              onSelect={handleGifSelected}
              onClose={() => setShowGifPicker(false)}
            />
          </div>
        )}

        {/* Mobile Emoji Picker */}
        {showEmojiPicker && (
          <div className={`mt-4 p-4 border rounded-lg ${
            isDark ? 'border-gray-600 bg-gray-800' : 'border-gray-200 bg-gray-50'
          }`}>
            <div className="grid grid-cols-6 gap-2 max-h-32 overflow-y-auto">
              {['😀', '😂', '🤣', '😊', '😍', '🤔', '😎', '🔥', '💯', '❤️', '👍', '👎'].map(emoji => (
                <button
                  key={emoji}
                  onClick={() => {
                    setText(prev => prev + emoji)
                    setShowEmojiPicker(false)
                  }}
                  className="p-1 text-xl hover:bg-gray-200 dark:hover:bg-gray-700 rounded transition-colors"
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
                  quote ? "Add a comment" : "What's happening?"
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
              isProcessingOnChain={isProcessingOnChain}
              className=""
            />
          </div>
        )}

        {/* On-chain info message */}
        {selectedMedia.some(m => m.type === 'image' && m.storageType === 'on-chain') && (
          <div className={`mt-3 p-3 rounded-lg flex items-start gap-2 ${
            isDark ? 'bg-yellow-500/10 border border-yellow-500/30' : 'bg-yellow-50 border border-yellow-200'
          }`}>
            <svg className="w-4 h-4 mt-0.5 flex-shrink-0 text-yellow-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p className={`text-xs ${isDark ? 'text-yellow-200' : 'text-yellow-800'}`}>
              On-chain images are stored permanently on the blockchain and will live forever.
              <br/>
              This costs CAW tokens to upload.
            </p>
          </div>
        )}

        {/* GIF Picker */}
        {showGifPicker && (
          <div className="mt-4">
            <GifPicker
              initialQuery={text.trim()}
              onSelect={handleGifSelected}
              onClose={() => setShowGifPicker(false)}
            />
          </div>
        )}

        {/* Emoji Picker */}
        {showEmojiPicker && (
          <div className={`mt-4 p-4 border rounded-lg ${
            isDark ? 'border-gray-600 bg-gray-800' : 'border-gray-200 bg-gray-50'
          }`}>
            <div className="grid grid-cols-8 gap-2 max-h-48 overflow-y-auto">
              {['😀', '😂', '🤣', '😊', '😍', '🤔', '😎', '🔥', '💯', '❤️', '👍', '👎', '👏', '🙏', '💪', '🚀'].map(emoji => (
                <button
                  key={emoji}
                  onClick={() => {
                    setText(prev => prev + emoji)
                    setShowEmojiPicker(false)
                  }}
                  className="p-2 text-2xl hover:bg-gray-200 dark:hover:bg-gray-700 rounded transition-colors"
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
            isDark ? 'border-gray-600 bg-gray-800' : 'border-gray-200 bg-gray-50'
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
                  onChange={(e) => setScheduledDate(e.target.value)}
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
                  onChange={(e) => setScheduledTime(e.target.value)}
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
              onClick={() => setShowGifPicker(!showGifPicker)}
              className={`p-2 rounded-full transition-all duration-200 cursor-pointer ${
              text.trim()
                ? (isDark
                    ? 'text-yellow-400 hover:text-yellow-300 hover:bg-yellow-400/10'
                    : 'text-yellow-600 hover:text-yellow-500 hover:bg-yellow-200/50')
                : (isDark
                    ? 'text-yellow-400/70 hover:text-yellow-400 hover:bg-yellow-400/10'
                    : 'text-yellow-600/70 hover:text-yellow-600 hover:bg-yellow-200/50')
            }`}>
              <span className="text-base font-medium">GIF</span>
            </button>

            {/* Image Library (On-Chain) - only show if user has uploaded images */}
            {libraryTotalCount > 0 && (
              <div className="relative">
                <button
                  onClick={handleOpenImageLibrary}
                  className={`p-2 rounded-full transition-all duration-200 cursor-pointer hover:bg-yellow-400/10`}
                  title="Previously uploaded on-chain images"
                >
                  <img src="/icons/on-chain-images.svg" alt="On-chain images" className="w-[27px] h-[27px] min-w-[27px] opacity-85 hover:opacity-100 transition-opacity translate-y-[3px]" />
                </button>
                {/* Unposted badge */}
                {libraryUnpostedCount > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] px-0.5 flex items-center justify-center bg-red-500 text-white text-[9px] font-bold rounded-full">
                    {libraryUnpostedCount}
                  </span>
                )}
              </div>
            )}

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

            { !isConnected && !hasActiveSession ? (
            <button
              className="px-5 py-2 bg-yellow-500 text-black font-semibold text-base rounded-full hover:bg-yellow-400 transition-all duration-200 shadow-lg hover:shadow-xl cursor-pointer flex items-center justify-center gap-2"
              onClick={openConnectModal}
            >
              <BsWallet className="w-4 h-4" />
              Connect Wallet
            </button>
          ) : !hasActiveSession && wrongChain ? (
            <button className="px-5 py-2 bg-yellow-500 text-black font-semibold text-base rounded-full hover:bg-yellow-400 transition-all duration-200 shadow-lg hover:shadow-xl cursor-pointer" onClick={handleSwitchChain}>
              Switch Network
            </button>
          ) : (() => {
                const wrongWallet2 = !isTokenOwner && !hasActiveSession && activeToken?.tokenId
                const tooltipText2 = wrongWallet2 ? 'Please switch to the correct wallet' : hasNoToken ? '' : hasPendingUploads ? 'Waiting for upload to confirm...' : isSubmitting ? (isThreadMode ? 'Waiting for signatures...' : 'Waiting for signature...') : ''
                const isDisabled2 = (!text && selectedMedia.length === 0) || isOverLimit || !canPost || isProcessingOnChain || hasPendingUploads || isSubmitting
                const btn2 = (
                  <button
                    className="px-5 py-2 bg-yellow-500 text-black font-semibold text-base rounded-full hover:bg-yellow-400 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200 shadow-lg hover:shadow-xl cursor-pointer"
                    disabled={isDisabled2}
                    onClick={hasFailedUploads ? handleRetryFailedUploads : hasUnuploadedOnChainImages ? handleUploadOnChain : handleSubmit}
                  >
                    {wrongWallet2 ? 'Wrong Wallet' : hasNoToken ? 'Create Account' : isSubmitting ? 'Signing...' : isProcessingOnChain ? 'Uploading...' : hasPendingUploads ? 'Pending...' : hasFailedUploads ? 'Retry' : hasUnuploadedOnChainImages ? 'Upload' : isThreadMode ? `Thread (${chunkCount})` : replyTo ? 'Reply' : 'Post'}
                  </button>
                )
                return tooltipText2 ? <Tooltip text={tooltipText2}>{btn2}</Tooltip> : btn2
              })()
            }
          </div>
        </div>

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
      </div>

      {/* Image Library Modal */}
      {showImageLibrary && createPortal(
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-black/60 z-[80]"
            onClick={() => setShowImageLibrary(false)}
          />

          {/* Modal */}
          <div className="fixed z-[90] top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 w-full max-w-md mx-4 rounded-xl shadow-2xl border bg-black border-yellow-500/30">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-full bg-yellow-500/20">
                  <img src="/icons/on-chain-images.svg" alt="On-chain images" className="w-5 h-5" />
                </div>
                <h3 className="text-lg font-semibold text-white">
                  On-Chain Images
                </h3>
              </div>
              <button
                onClick={() => setShowImageLibrary(false)}
                className="p-1 rounded-full transition-colors text-white/60 hover:text-white hover:bg-white/10"
              >
                <HiX className="w-5 h-5" />
              </button>
            </div>

            {/* Content */}
            <div className="px-4 pb-4">
              <p className="text-sm mb-4 text-white/70">
                Select a previously uploaded on-chain image to include in your post.
              </p>

              <div
                ref={libraryScrollRef}
                onScroll={handleLibraryScroll}
                className="max-h-64 overflow-y-auto rounded-lg border border-yellow-500/20 bg-black/50 p-2">
                {isLoadingLibrary ? (
                  <div className="flex items-center justify-center py-8">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-yellow-500"></div>
                  </div>
                ) : libraryImages.length === 0 ? (
                  <div className="text-center py-8 text-white/50">
                    <HiPhotograph className="mx-auto h-10 w-10 mb-3 opacity-50" />
                    <p className="text-sm">No on-chain images found</p>
                    <p className="text-xs mt-1 text-white/40">Upload images with "On-Chain" enabled to see them here</p>
                  </div>
                ) : (
                  <>
                    <div className="grid grid-cols-3 gap-2">
                      {libraryImages.map((image) => {
                        const isUnposted = !image.postedAt && !image.ignored
                        return (
                          <div key={image.imageRef} className="relative">
                            <button
                              onClick={() => handleSelectLibraryImage(image)}
                              className="relative aspect-square rounded-lg overflow-hidden border-2 border-transparent hover:border-yellow-500 transition-all hover:scale-105 group w-full"
                            >
                              <img
                                src={image.base64Data.startsWith('data:') ? image.base64Data : `data:image/jpeg;base64,${image.base64Data}`}
                                alt="On-chain image"
                                className="w-full h-full object-cover"
                              />
                              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center">
                                <span className="opacity-0 group-hover:opacity-100 text-white text-xs font-medium bg-yellow-500 px-2 py-1 rounded transition-opacity">
                                  Select
                                </span>
                              </div>
                            </button>
                            {/* Not Posted badge with dismiss X - bottom center */}
                            {isUnposted && (
                              <div className="absolute bottom-2.5 left-1/2 -translate-x-1/2">
                                <span className="bg-red-500 text-white text-[9px] font-bold px-1.5 py-0.5 rounded inline-flex items-center gap-1 whitespace-nowrap">
                                  Not Posted
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      handleIgnoreImage(image.id)
                                    }}
                                    className="hover:bg-red-600 rounded-sm transition-colors"
                                    title="Dismiss"
                                  >
                                    <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 18L18 6M6 6l12 12" />
                                    </svg>
                                  </button>
                                </span>
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                    {/* Loading more indicator */}
                    {isLoadingMoreLibrary && (
                      <div className="flex items-center justify-center py-3">
                        <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-yellow-500"></div>
                      </div>
                    )}
                  </>
                )}
              </div>

              <p className="text-xs mt-3 text-white/40">
                These images are stored permanently on the blockchain.
              </p>

              {/* Close button */}
              <button
                onClick={() => setShowImageLibrary(false)}
                className="w-full mt-4 py-2.5 px-4 rounded-lg text-sm font-medium bg-yellow-500 text-black hover:bg-yellow-400 transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </>,
        document.body
      )}

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

