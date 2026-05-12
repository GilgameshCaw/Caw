// src/components/ContentWithHashtags.tsx
import React, { useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useNavigate } from '~/utils/localizedRouter'
import LinkPreview from './LinkPreview'
import PostVideo from './PostVideo'
import Tooltip from '~/components/Tooltip'
import ImageLightbox from './ImageLightbox'
import { useCachedFetch } from '~/hooks/useCachedFetch'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'
import { feedImageLargeUrl, feedImageSrcset } from '~/utils/imageVariants'

// Browser sizes hint for inline feed images. Feed container is max-w-2xl
// (672px), inner width ~624px after padding, narrower below the sm
// breakpoint (640px). Communicating this lets the browser pick the
// smallest srcset candidate that satisfies the slot at its DPR.
//
//   single full-width image: clamps to 624px on desktop, 100vw on mobile
//   two-up grid cell:        ~310px on desktop, ~50vw on mobile
//
// We slightly overstate the desktop ceiling (624 → 640) because the
// browser rounds upward when picking; conservative sizes saves bytes
// without ever underserving.
const SIZES_SINGLE = '(min-width: 640px) 624px, 100vw'
const SIZES_GRID_CELL = '(min-width: 640px) 312px, 50vw'
import { isCanonicalUploadUrl } from '~/utils/uploadUrl'
import { TAG_CHAR_CLASS, HASHTAG_SIGIL_CLASS, MENTION_SIGIL_CLASS } from '~/../../../tools/hashtagRegex'

// Caches. Keyed by `${host}|${code}` so cross-node short URLs with the
// same code (e.g. coincidentally identical codes on two mirroring nodes)
// don't clobber each other's resolved values. Exported so other
// renderers (e.g. the "Replying to" thumbnail in FeedItem) can share
// the resolved values instead of re-fetching and racing.
export const shortUrlCache = new Map<string, string | null>()

const cacheKey = (host: string | undefined, code: string) =>
  host ? `${host}|${code}` : code

// Build the resolver endpoint. When the short URL was fully-qualified
// in the post (https://node-a.com/s/abc), we MUST resolve against that
// node — the row only exists in that node's DB. Relative /s/abc URLs
// resolve against the local API as before.
const resolverEndpoint = (host: string | undefined, code: string) =>
  host ? `${host}/api/shorturl/${code}` : `/api/shorturl/${code}`

// Extract the origin from a short URL match. Returns undefined for
// relative URLs (/s/abc) — those are local and use the current host.
const extractShortUrlHost = (shortUrlText: string): string | undefined => {
  const m = shortUrlText.match(/^(https?:\/\/[^\/]+)\/s\//)
  return m ? m[1] : undefined
}

// Shared loading skeleton
const MediaSkeleton = () => (
  <div className="my-2 max-w-full h-48 bg-gray-200 dark:bg-gray-700 rounded-lg animate-pulse" />
)

// Component to render short URL images. `originHost` lets us resolve a
// short URL against a different node when the post was created on a
// mirror — see resolverEndpoint() comment.
const ShortUrlImage: React.FC<{
  code: string
  originHost?: string
  onError: (url: string) => void
  imageErrors: Set<string>
  /** Optional wrapper class override (defaults keep legacy layout). */
  wrapperClassName?: string
  /** Optional img class override (defaults keep legacy layout). */
  imgClassName?: string
  /** Optional skeleton class override (defaults keep legacy layout). */
  skeletonClassName?: string
  /** Browser sizes hint for srcset selection. Defaults to the
   *  single-image layout. Pass SIZES_GRID_CELL when this image is
   *  rendered inside the multi-image grid. */
  sizes?: string
  /** When provided, click is forwarded instead of opening internal lightbox. */
  onImageClick?: (originalUrl: string, e: React.MouseEvent) => void
}> = ({ code, originHost, onError, imageErrors, wrapperClassName, imgClassName, skeletonClassName, sizes, onImageClick }) => {
  const { url: originalUrl, loading } = useCachedFetch(
    cacheKey(originHost, code),
    shortUrlCache,
    resolverEndpoint(originHost, code),
    (data: { originalUrl: string }) => data.originalUrl
  )

  const [lightboxOpen, setLightboxOpen] = useState(false)

  if (loading) {
    return skeletonClassName
      ? <div className={skeletonClassName} />
      : <MediaSkeleton />
  }
  if (!originalUrl || imageErrors.has(originalUrl)) return null

  // feedImageLargeUrl returns undefined for URLs outside /uploads/images/,
  // and the lightbox falls back to `src` if the variant 404s — so it's
  // safe to pass through unconditionally.
  const largeSrc = feedImageLargeUrl(originalUrl)

  const wrapper = wrapperClassName ?? 'my-2 max-w-full'
  const imgClass = imgClassName ?? 'max-w-full max-h-96 rounded-lg object-contain cursor-zoom-in'

  return (
    <>
      <div className={wrapper}>
        <img
          src={originalUrl}
          srcSet={feedImageSrcset(originalUrl)}
          sizes={sizes ?? SIZES_SINGLE}
          alt="Embedded content"
          className={imgClass}
          loading="lazy"
          onError={() => onError(originalUrl)}
          onClick={(e) => {
            e.stopPropagation()
            if (onImageClick) {
              onImageClick(originalUrl, e)
            } else {
              setLightboxOpen(true)
            }
          }}
        />
      </div>
      {!onImageClick && (
        <ImageLightbox
          src={originalUrl}
          largeSrc={largeSrc}
          isOpen={lightboxOpen}
          onClose={() => setLightboxOpen(false)}
        />
      )}
    </>
  )
}

// Component to render an inline short URL link — shows the original URL
// (truncated) as link text, but the href points to the short URL for analytics.
const ShortUrlLink: React.FC<{ code: string; shortHref: string; originHost?: string }> = ({ code, shortHref, originHost }) => {
  const { isDark } = useTheme()
  const { url: originalUrl, loading } = useCachedFetch(
    cacheKey(originHost, code),
    shortUrlCache,
    resolverEndpoint(originHost, code),
    (data: { originalUrl: string }) => data.originalUrl
  )

  // Display the original URL, stripped of protocol and truncated if too long
  const displayText = (() => {
    if (loading || !originalUrl) return shortHref
    const stripped = originalUrl.replace(/^https?:\/\//, '')
    return stripped.length > 40 ? stripped.slice(0, 37) + '…' : stripped
  })()

  return (
    <a
      href={shortHref}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className={`${isDark ? 'text-yellow-400 hover:text-yellow-300' : 'text-amber-800 hover:text-amber-900'} hover:underline break-all`}
    >
      {displayText}
    </a>
  )
}

// Component to render short URL videos
const ShortUrlVideo: React.FC<{
  code: string
  originHost?: string
  onError: (url: string) => void
  videoErrors: Set<string>
}> = ({ code, originHost, onError, videoErrors }) => {
  const { url: originalUrl, loading } = useCachedFetch(
    cacheKey(originHost, code),
    shortUrlCache,
    resolverEndpoint(originHost, code),
    (data: { originalUrl: string }) => data.originalUrl
  )

  if (loading) return <MediaSkeleton />
  if (!originalUrl || videoErrors.has(originalUrl)) return null

  return (
    <div className="my-2 w-full max-w-full rounded-lg overflow-hidden">
      <PostVideo url={originalUrl} onError={() => onError(originalUrl)} />
    </div>
  )
}

interface Props {
  content: string
  className?: string
  /** When provided, clicking an image navigates to the post media modal route. */
  postId?: string
  /** When false, do not extract/render embedded media (images/videos) from content. */
  renderMedia?: boolean
  /** When true, remove media URLs from the text output (prevents raw image links showing). */
  stripMediaUrls?: boolean
}

// Regex to match Giphy URLs
const GIPHY_URL_REGEX = /https?:\/\/(?:media\d?\.giphy\.com|i\.giphy\.com)\/media\/[^\s]+\.gif/gi

// Regex to match general image URLs (common formats)
const IMAGE_URL_REGEX = /https?:\/\/[^\s]+\.(?:gif|jpg|jpeg|png|webp)(?:\?[^\s]*)?/gi

// Regex to match short URLs - both relative (/s/code) and absolute (https://domain.com/s/code)
// Supports optional file extensions like .gif, .jpg, etc.
const SHORT_URL_REGEX = /^(?:https?:\/\/[^\/]+)?\/s\/([a-zA-Z0-9]+(?:\.[a-zA-Z0-9]+)?)$/

/**
 * Component that renders text content with clickable hashtags and embedded images/GIFs
 */
const ContentWithHashtags: React.FC<Props> = ({ content, className = '', postId, renderMedia = true, stripMediaUrls = true }) => {
  const navigate = useNavigate()
  const location = useLocation()
  const { isDark } = useTheme()
  const t = useT()
  const linkClass = isDark
    ? 'text-yellow-400 hover:text-yellow-300'
    : 'text-amber-800 hover:text-amber-900'
  const [imageErrors, setImageErrors] = useState<Set<string>>(new Set())
  // One lightbox slot for the whole post — clicking any inline image
  // sets it; the modal closes on Esc / backdrop / swipe down.
  const [lightbox, setLightbox] = useState<{ src: string; largeSrc?: string } | null>(null)

  const openPostMedia = (mediaIndex: number) => {
    if (!postId) return
    navigate(`/caws/${postId}?media=${mediaIndex}&source=content`, {
      state: { backgroundLocation: location }
    })
  }

  const handleHashtagClick = (hashtag: string, event: React.MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    // Strip the leading sigil (ASCII # / $ OR fullwidth ＃ / ＄ from CJK keyboards).
    const cleanHashtag = hashtag.replace(/^[#$＃＄]/, '')
    navigate(`/hashtags/${cleanHashtag}`)
  }

  const handleMentionClick = (mention: string, event: React.MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    // Strip the leading sigil (ASCII @ OR fullwidth ＠ from CJK keyboards).
    const username = mention.replace(/^[@＠]/, '')
    navigate(`/users/${username}`)
  }

  const handleImageError = (url: string) => {
    setImageErrors(prev => new Set(prev).add(url))
  }

  const isGiphyUrl = (url: string): boolean => {
    return /https?:\/\/(?:media\d?\.giphy\.com|i\.giphy\.com)\/media\//i.test(url)
  }

  const isImageUrl = (url: string): boolean => {
    return /\.(?:gif|jpg|jpeg|png|webp)(?:\?|$)/i.test(url)
  }

  const isVideoUrl = (url: string): boolean => {
    return /\.(?:mp4|webm|mov|avi|mkv|ogg|ogv)(?:\?|$)/i.test(url)
  }

  const isShortUrl = (url: string): boolean => {
    return SHORT_URL_REGEX.test(url)
  }

  // Check if short URL code has a video extension
  const isVideoShortUrl = (code: string): boolean => {
    return /\.(mp4|webm|mov|avi|mkv|ogg|ogv)$/i.test(code)
  }

  const getShortUrlCode = (url: string): string | null => {
    const match = url.match(SHORT_URL_REGEX)
    return match ? match[1] : null
  }

  // Check if short URL code has a media extension (should be rendered as image)
  const isMediaShortUrl = (code: string): boolean => {
    return /\.(gif|jpg|jpeg|png|webp)$/i.test(code)
  }

  const parseTextWithHashtags = (text: string, keyPrefix: string, renderMedia: boolean) => {
    // Matches hashtags, cashtags, @mentions, AND short URLs (so we can render
    // short URLs as clickable links pointing to the original URL).
    // - Short URLs: /s/code or https://host/s/code (with optional extension).
    // - Hashtags/cashtags/mentions: any Unicode letter / digit / mark or `_`,
    //   provided the run contains at least one non-digit. So `#テスト`,
    //   `#你好`, `#résumé`, `#foo123` all match; `#5` and `$100` are plain text.
    // The lookahead `(?=...*[non-digit]...)` enforces the not-pure-digit rule.
    // Sigil class merges hashtag/cashtag (#$＃＄) + mention (@＠) — historically
    // they were kept separate but rendering treats them with the same matcher
    // because the render-time differentiation happens in isFullMention vs
    // isFullTag below.
    const allSigils = `(?:${HASHTAG_SIGIL_CLASS}|${MENTION_SIGIL_CLASS})`
    const tagAlt = `${allSigils}(?=${TAG_CHAR_CLASS}*[\\p{L}\\p{M}_])${TAG_CHAR_CLASS}+`
    // Plain URL alt — same shape as PostForm.tsx URL_REGEX. Keeps the
    // short-URL alt first so e.g. `https://caw.social/s/abc` is captured by
    // the short-URL branch, not the generic one.
    const urlAlt = `https?:\\/\\/[^\\s<>"'{}|\\\\^\`\\[\\]]+[^\\s<>"'{}|\\\\^\`\\[\\].,!?;:)\\]]`
    const specialRegex = new RegExp(
      `((?:https?:\\/\\/[^\\s]+)?\\/s\\/[a-zA-Z0-9]+(?:\\.[a-zA-Z0-9]+)?|${tagAlt}|${urlAlt})`,
      'gu',
    )
    // Anchored matchers used to confirm a split chunk is *entirely* a tag /
    // mention / URL — not just text that happens to start with `#`/`http`
    // (e.g. `#333 hi` or `https://x.com/foo bar`, which split() returns
    // intact as the head of the parts array if they don't fully match).
    const isFullMention = new RegExp(`^${MENTION_SIGIL_CLASS}${TAG_CHAR_CLASS}+$`, 'u')
    const isFullTag = new RegExp(`^${tagAlt}$`, 'u')
    const isFullUrl = new RegExp(`^${urlAlt}$`, 'u')

    const parts = text.split(specialRegex)

    return parts.map((part, index) => {
      // Check if this is a short URL
      const shortUrlMatch = part.match(/^((?:https?:\/\/[^\s\/]+)?\/s\/([a-zA-Z0-9]+(?:\.[a-zA-Z0-9]+)?))$/)
      if (shortUrlMatch) {
        const shortHref = shortUrlMatch[1]
        const code = shortUrlMatch[2]
        // Media short URLs are normally handled by parseContent as images/videos.
        // But when media rendering is disabled (e.g. inside the media modal post panel),
        // render them as a regular short link instead.
        if (isMediaShortUrl(code) || isVideoShortUrl(code)) {
          if (!renderMedia) {
            return (
              <ShortUrlLink
                key={`${keyPrefix}-${index}`}
                code={code}
                shortHref={shortHref}
                originHost={extractShortUrlHost(shortHref)}
              />
            )
          }
          return part
        }
        return (
          <ShortUrlLink key={`${keyPrefix}-${index}`} code={code} shortHref={shortHref} originHost={extractShortUrlHost(shortHref)} />
        )
      }

      // Check if this is a plain http(s) URL
      if (isFullUrl.test(part)) {
        return (
          <a
            key={`${keyPrefix}-${index}`}
            href={part}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className={`${linkClass} hover:underline break-all`}
          >
            {part}
          </a>
        )
      }

      // Check if this is an @mention
      if (isFullMention.test(part)) {
        return (
          <Tooltip key={`${keyPrefix}-${index}`} text={t('content_hashtags.view_profile', { name: part })} className="inline">
            <button
              onClick={(e) => handleMentionClick(part, e)}
              className={`
                hover:underline cursor-pointer transition-colors duration-200
                bg-transparent border-none p-0 m-0 font-inherit
                ${linkClass}
              `}
            >
              {part}
            </button>
          </Tooltip>
        )
      }

      // Check if this is a hashtag or cashtag
      if (isFullTag.test(part)) {
        return (
          <Tooltip key={`${keyPrefix}-${index}`} text={t('content_hashtags.view_posts_with', { tag: part })} className="inline">
            <button
              onClick={(e) => handleHashtagClick(part, e)}
              className={`
                hover:underline cursor-pointer transition-colors duration-200
                bg-transparent border-none p-0 m-0 font-inherit
                ${linkClass}
              `}
            >
              {part}
            </button>
          </Tooltip>
        )
      }

      // Regular text
      return part
    })
  }

  const parseContent = (text: string, renderMedia: boolean, stripMediaUrls: boolean) => {
    // Extract all media in a single pass to preserve order.
    // Each match includes its position so we can sort by original order.
    const mediaMatches: { type: 'image' | 'shortImage' | 'shortVideo'; data: string; code?: string; originHost?: string; position: number }[] = []

    // Pattern for short URLs with extensions (e.g., /s/abc123.png, /s/abc123.mov)
    const shortUrlWithExtPattern = /(?:https?:\/\/[^\s]+)?\/s\/([a-zA-Z0-9]+\.(gif|jpg|jpeg|png|webp|mp4|webm|mov))/g
    // Pattern for direct image URLs
    const imageUrlPattern = /https?:\/\/[^\s<>"{}|\\^`[\]]+\.(?:gif|jpg|jpeg|png|webp)(?:\?[^\s]*)?/g

    // Find all matches with their positions
    let match: RegExpExecArray | null

    if (renderMedia) {
      // Short URLs with media extensions (images and videos)
      while ((match = shortUrlWithExtPattern.exec(text)) !== null) {
        const code = match[1]
        const isVideo = /\.(mp4|webm|mov)$/i.test(code)
        mediaMatches.push({
          type: isVideo ? 'shortVideo' : 'shortImage',
          data: match[0],
          code: code,
          originHost: extractShortUrlHost(match[0]),
          position: match.index
        })
      }

      // Direct image URLs (excluding short URLs)
      while ((match = imageUrlPattern.exec(text)) !== null) {
        // Skip if it's a short URL (already handled)
        if (match[0].includes('/s/')) continue
        // Reject URLs that don't match the canonical upload-pipeline
        // path shape. Without this filter, a malicious poster could
        // embed https://attacker.tld/track.png in a popular caw and
        // every viewer's IP+UA hits attacker logs (passive deanon).
        // External-host images flow through LinkPreview / explicit
        // unfurling instead. Audit fix 2026-05-09 (Round 5 FE/DM HIGH-1).
        if (!isCanonicalUploadUrl(match[0])) continue
        mediaMatches.push({
          type: 'image',
          data: match[0],
          position: match.index
        })
      }

      // Sort by position to maintain original order
      mediaMatches.sort((a, b) => a.position - b.position)
    }

    // Remove media URLs from the text when requested.
    // NOTE: This is especially important in the media modal post panel where we
    // hide inline media — we still don't want to show raw image URLs.
    let processedText = stripMediaUrls
      ? text
          .replace(shortUrlWithExtPattern, '')
          .replace(imageUrlPattern, (match) => match.includes('/s/') ? match : '')
      : text

    // Clean up extra spaces (but preserve newlines!)
    processedText = processedText
      .replace(/[ \t]+/g, ' ')  // Collapse multiple spaces/tabs (not newlines)
      .replace(/^ +/gm, '')     // Remove leading spaces on each line
      .replace(/\n{3,}/g, '\n\n') // Collapse 3+ newlines to 2
      .trim()

    // Split by lines first to handle URLs on their own lines
    const lines = processedText.split('\n')
    const result: React.ReactNode[] = []
    // Track whether we've already emitted a preview card so we don't stack
    // a second one when the post has both a standalone short-URL line *and*
    // additional inline short URLs elsewhere.
    let previewEmitted = false

    lines.forEach((line, lineIndex) => {
      const trimmedLine = line.trim()

      // Skip empty lines (after media extraction)
      if (!trimmedLine) {
        // Add line break for empty lines between text
        if (lineIndex < lines.length - 1 && lineIndex > 0) {
          result.push(<br key={`br-${lineIndex}`} />)
        }
        return
      }

      // Check if this line is a short URL (without media extension - for link previews)
      if (isShortUrl(trimmedLine)) {
        const code = getShortUrlCode(trimmedLine)
        if (code && !isMediaShortUrl(code) && !isVideoShortUrl(code)) {
          // Show the resolved long URL as a clickable line above the preview
          // card, with href pointing to the short URL. Mirrors the inline
          // behavior — the user sees what they originally typed, while the
          // on-chain text + analytics still flow through /s/CODE.
          const lineHost = extractShortUrlHost(trimmedLine)
          result.push(
            <span key={`shortlink-${lineIndex}`} className="block">
              <ShortUrlLink code={code} shortHref={trimmedLine} originHost={lineHost} />
            </span>
          )
          // Render as link preview card (non-media short URLs)
          result.push(
            <LinkPreview
              key={`link-${lineIndex}`}
              code={code}
              originHost={lineHost}
              className="my-2"
            />
          )
          previewEmitted = true
          return
        }
      }

      // Regular text line with hashtag parsing
      result.push(
        <span key={`text-${lineIndex}`}>
          {parseTextWithHashtags(line, `line-${lineIndex}`, renderMedia)}
        </span>
      )

      // Add line break between text lines
      if (lineIndex < lines.length - 1) {
        result.push(<br key={`br-${lineIndex}`} />)
      }
    })

    // If no preview card was emitted (because every short URL was inline
    // alongside other text), append one for the *first* non-media short URL
    // we can find anywhere in the post. Single card per post is enough —
    // additional URLs still render as inline ShortUrlLinks above.
    if (!previewEmitted) {
      const firstShortMatch = processedText.match(/(?:https?:\/\/[^\s]+)?\/s\/([a-zA-Z0-9]+(?:\.[a-zA-Z0-9]+)?)/)
      if (firstShortMatch) {
        const firstCode = firstShortMatch[1]
        if (!isMediaShortUrl(firstCode) && !isVideoShortUrl(firstCode)) {
          result.push(
            <LinkPreview
              key={`link-inline-first`}
              code={firstCode}
              originHost={extractShortUrlHost(firstShortMatch[0])}
              className="my-2"
            />
          )
        }
      }
    }

    const gridClassFor = (count: number) =>
      count === 2
        ? 'grid grid-cols-2 gap-1.5 aspect-video rounded-lg overflow-hidden'
        : count === 3
          ? 'grid grid-cols-2 grid-rows-2 gap-1.5 aspect-video rounded-lg overflow-hidden'
          : 'grid grid-cols-2 grid-rows-2 gap-1.5 aspect-video rounded-lg overflow-hidden'

    const cellClassFor = (count: number, i: number) =>
      count === 3 && i === 0 ? 'row-span-2 w-full h-full' : 'w-full h-full'

    // Image index within the post (in render order). Used for deep-linking
    // into the post media modal.
    let mediaImageIndex = 0

    if (!renderMedia) return result

    // Render all media in order (sorted by original position in text)
    // UX fix: when multiple images are present, render them as a grid
    // (matching the pre-post MediaUpload layout) instead of stacking.
    for (let i = 0; i < mediaMatches.length; i++) {
      const m = mediaMatches[i]
      const isImageLike = m.type === 'image' || m.type === 'shortImage'

      if (isImageLike) {
        const start = i
        while (i < mediaMatches.length && (mediaMatches[i].type === 'image' || mediaMatches[i].type === 'shortImage')) i++
        const run = mediaMatches.slice(start, i)
        i--

        // Single image keeps legacy behavior (object-contain)
        if (run.length === 1) {
          const only = run[0]
          const imageIdx = mediaImageIndex
          mediaImageIndex += 1
          if (only.type === 'shortImage' && only.code) {
            result.push(
              <ShortUrlImage
                key={`shortimg-${start}`}
                code={only.code}
                originHost={only.originHost}
                onError={handleImageError}
                imageErrors={imageErrors}
                onImageClick={postId ? () => openPostMedia(imageIdx) : undefined}
              />
            )
          } else if (only.type === 'image') {
            const url = only.data
            result.push(
              <div key={`img-${start}`} className="my-2 max-w-full">
                <img
                  src={url}
                  srcSet={feedImageSrcset(url)}
                  sizes={SIZES_SINGLE}
                  alt="Embedded content"
                  className="max-w-full max-h-96 rounded-lg object-contain cursor-zoom-in"
                  loading="lazy"
                  onError={() => handleImageError(url)}
                  onClick={(e) => {
                    e.stopPropagation()
                    if (postId) openPostMedia(imageIdx)
                    else setLightbox({ src: url, largeSrc: feedImageLargeUrl(url) })
                  }}
                />
              </div>
            )
          }
          continue
        }

        const baseImageIndex = mediaImageIndex
        // Even if we only *display* up to 4, keep indices consistent so
        // +N overlays still deep-link correctly.
        mediaImageIndex += run.length

        const visible = run.slice(0, 4)
        const count = visible.length

        result.push(
          <div key={`imggrid-${start}`} className="my-2 max-w-full">
            <div className={gridClassFor(count)}>
              {visible.map((im, idx) => (
                <div
                  key={`imgcell-${start}-${idx}`}
                  className={`relative w-full h-full overflow-hidden ${cellClassFor(count, idx)}`}
                >
                  {im.type === 'shortImage' && im.code ? (
                    <ShortUrlImage
                      code={im.code}
                      originHost={im.originHost}
                      onError={handleImageError}
                      imageErrors={imageErrors}
                      wrapperClassName="w-full h-full"
                      imgClassName="block w-full h-full object-cover"
                      skeletonClassName="w-full h-full bg-gray-200 dark:bg-gray-700 animate-pulse"
                      sizes={SIZES_GRID_CELL}
                      onImageClick={postId ? () => openPostMedia(baseImageIndex + idx) : undefined}
                    />
                  ) : (
                    <img
                      src={im.data}
                      srcSet={feedImageSrcset(im.data)}
                      sizes={SIZES_GRID_CELL}
                      alt={`Embedded content ${idx + 1}`}
                      className="block w-full h-full object-cover cursor-zoom-in"
                      loading="lazy"
                      onError={() => handleImageError(im.data)}
                      onClick={(e) => {
                        e.stopPropagation()
                        if (postId) openPostMedia(baseImageIndex + idx)
                        else setLightbox({ src: im.data, largeSrc: feedImageLargeUrl(im.data) })
                      }}
                    />
                  )}

                  {run.length > 4 && idx === 3 && (
                    <div className="absolute inset-0 bg-black/50 flex items-center justify-center text-white text-xl font-semibold pointer-events-none">
                      +{run.length - 4}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )
        continue
      }

      if (m.type === 'shortVideo' && m.code) {
        result.push(
          <ShortUrlVideo
            key={`shortvid-${i}`}
            code={m.code}
            originHost={m.originHost}
            onError={handleImageError}
            videoErrors={imageErrors}
          />
        )
      }
    }

    return result
  }

  return (
    <div className={`break-words ${className}`}>
      {parseContent(content, renderMedia, stripMediaUrls)}
      {lightbox && (
        <ImageLightbox
          src={lightbox.src}
          largeSrc={lightbox.largeSrc}
          isOpen={true}
          onClose={() => setLightbox(null)}
        />
      )}
    </div>
  )
}

export default ContentWithHashtags
