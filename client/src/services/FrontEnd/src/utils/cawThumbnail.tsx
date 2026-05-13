import React, { useState } from 'react'
import { useCachedFetch } from '~/hooks/useCachedFetch'
import { shortUrlCache } from '~/components/ContentWithHashtags'

// Shared thumbnail picker for caw previews. Used in two places that
// both need to lift the first piece of media out of a caw and (when
// the media is a GIF embedded in body text) scrub the URL from the
// text so it doesn't render twice. Originally lived inside FeedItem
// as the "Replying to" preview; extracted so the notifications row
// can render the same thumbnail kinds (image, video, raw giphy,
// /s/<code>.gif short URL).

export const giphyStillUrl = (url: string): string =>
  /\/giphy\.gif(?:\?|$)/i.test(url) ? url.replace('/giphy.gif', '/giphy_s.gif') : url

export const isGiphyUrl = (url: string): boolean =>
  /https?:\/\/(?:media\d?\.giphy\.com|i\.giphy\.com)\/media\//i.test(url)

export type CawThumb =
  | { kind: 'image'; src: string }
  | { kind: 'video'; src: string }
  | { kind: 'gif'; src: string }
  | { kind: 'shortGif'; code: string; originHost?: string }
  | { kind: 'shortVideo'; code: string; originHost?: string }

export interface CawThumbnailSource {
  hasImage?: boolean
  hasVideo?: boolean
  imageData?: string | null
  videoData?: string | null
}

// Returns the first lifted thumbnail (image/video/gif/shortGif) plus
// the body with any lifted GIF URL scrubbed. Callers pass the caw's
// media-bearing fields plus the body they want scrubbed; gif lifting
// only inspects `body`, so passing an empty string skips that step.
export function pickCawThumbnail(
  source: CawThumbnailSource,
  body: string,
): { thumb: CawThumb | null; body: string } {
  let thumb: CawThumb | null = null

  if (source.hasImage && source.imageData) {
    const data = source.imageData
    if (data.startsWith('urls:')) {
      const first = data.replace('urls:', '').split('|||')[0]
      if (first) thumb = { kind: 'image', src: first }
    } else {
      const first = data.split('|||')[0]
      if (first) thumb = { kind: 'image', src: `data:image/jpeg;base64,${first}` }
    }
  }
  if (!thumb && source.hasVideo && source.videoData) {
    const first = String(source.videoData).split('|||')[0]
    if (first) thumb = { kind: 'video', src: first }
  }
  if (!thumb && body) {
    // Media embedded in body text:
    //   /s/<code>.gif → short-URL'd GIF (resolver renders the still)
    //   /s/<code>.<vid> → short-URL'd VIDEO (mp4/webm/mov/m4v) — render
    //                     as a <video> directly from the resolved URL
    //   raw giphy URL  → legacy pre-shortener path
    // When we lift the URL into a thumbnail we scrub it from the body
    // so the user doesn't see the raw URL twice.
    const shortGifRegex = /(https?:\/\/[^\s\/]+)?\/s\/([a-zA-Z0-9]+\.gif)\b/i
    const shortVideoRegex = /(https?:\/\/[^\s\/]+)?\/s\/([a-zA-Z0-9]+\.(?:mp4|webm|mov|m4v))\b/i
    const shortGifMatch = body.match(shortGifRegex)
    const shortVideoMatch = body.match(shortVideoRegex)
    if (shortGifMatch) {
      // Code includes the extension — the resolver row was created
      // with `code: <base>.gif` so we MUST query that exact form.
      // Stripping `.gif` 404s.
      const code = shortGifMatch[2]
      const originHost = shortGifMatch[1] || undefined
      thumb = { kind: 'shortGif', code, originHost }
      body = body.replace(shortGifRegex, '').replace(/\s{2,}/g, ' ').trim()
    } else if (shortVideoMatch) {
      // Same short-URL resolver, different kind so the renderer plays
      // a <video> instead of an <img>.
      const code = shortVideoMatch[2]
      const originHost = shortVideoMatch[1] || undefined
      thumb = { kind: 'shortVideo', code, originHost }
      body = body.replace(shortVideoRegex, '').replace(/\s{2,}/g, ' ').trim()
    } else {
      const giphyRegex = /https?:\/\/(?:media\d?\.giphy\.com|i\.giphy\.com)\/media\/\S*?\/giphy\.gif(?:\?\S*)?/i
      const giphyMatch = body.match(giphyRegex)
      if (giphyMatch) {
        thumb = { kind: 'gif', src: giphyStillUrl(giphyMatch[0]) }
        body = body.replace(giphyRegex, '').replace(/\s{2,}/g, ' ').trim()
      }
    }
  }

  return { thumb, body }
}

// Resolves a `/s/<code>.<ext>` short URL via the same `/api/shorturl/:code`
// endpoint ContentWithHashtags uses. For GIFs we map a Giphy original
// to its `_s.gif` still (non-Giphy short GIFs render as-is — first
// paint shows the GIF's first frame). For videos we render a <video>
// element from the resolved URL with `preload=metadata` so the
// browser shows the first frame without auto-playing.
// Renders nothing when the resolver 404s or the media errors — own
// wrapper shape so the surrounding layout can size it.
export const ShortUrlMediaThumb: React.FC<{
  kind: 'gif' | 'video'
  code: string
  originHost?: string
  wrapperClass: string
  showPlayOverlay?: boolean
}> = ({ kind, code, originHost, wrapperClass, showPlayOverlay = true }) => {
  const key = originHost ? `${originHost}|${code}` : code
  const endpoint = originHost ? `${originHost}/api/shorturl/${code}` : `/api/shorturl/${code}`
  const { url: originalUrl, loading } = useCachedFetch(
    key,
    shortUrlCache,
    endpoint,
    (data: { originalUrl: string }) => data.originalUrl,
  )
  const [errored, setErrored] = useState(false)
  if (loading) return <span className={`${wrapperClass} animate-pulse bg-white/10`} />
  if (!originalUrl || errored) return null
  const playOverlay = showPlayOverlay && (
    <span className="absolute inset-0 flex items-center justify-center pointer-events-none">
      <span className="w-6 h-6 rounded-full bg-black/60 flex items-center justify-center">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="white">
          <polygon points="2,1 9,5 2,9" />
        </svg>
      </span>
    </span>
  )
  if (kind === 'video') {
    return (
      <span className={`${wrapperClass} bg-black`}>
        <video
          src={originalUrl}
          muted
          playsInline
          preload="metadata"
          className="w-full h-full object-cover pointer-events-none"
          onError={() => setErrored(true)}
        />
        {playOverlay}
      </span>
    )
  }
  const src = isGiphyUrl(originalUrl) ? giphyStillUrl(originalUrl) : originalUrl
  return (
    <span className={`${wrapperClass} bg-black`}>
      <img
        src={src}
        alt=""
        className="w-full h-full object-cover"
        onError={() => setErrored(true)}
      />
      {playOverlay}
    </span>
  )
}

// Renders a CawThumb in a square wrapper. `wrapperClass` controls
// outer sizing/rounding so callers can pick (e.g. w-16 h-16 for the
// FeedItem "Replying to" preview, w-12 h-12 for notifications).
export const CawThumbnail: React.FC<{
  thumb: CawThumb
  wrapperClass: string
  showPlayOverlay?: boolean
}> = ({ thumb, wrapperClass, showPlayOverlay = true }) => {
  const playOverlay = showPlayOverlay && (
    <span className="absolute inset-0 flex items-center justify-center pointer-events-none">
      <span className="w-6 h-6 rounded-full bg-black/60 flex items-center justify-center">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="white">
          <polygon points="2,1 9,5 2,9" />
        </svg>
      </span>
    </span>
  )
  if (thumb.kind === 'shortGif' || thumb.kind === 'shortVideo') {
    return (
      <ShortUrlMediaThumb
        kind={thumb.kind === 'shortGif' ? 'gif' : 'video'}
        code={thumb.code}
        originHost={thumb.originHost}
        wrapperClass={wrapperClass}
        showPlayOverlay={showPlayOverlay}
      />
    )
  }
  if (thumb.kind === 'video') {
    return (
      <span className={`${wrapperClass} bg-black`}>
        <video
          src={thumb.src}
          muted
          playsInline
          preload="metadata"
          className="w-full h-full object-cover pointer-events-none"
        />
        {playOverlay}
      </span>
    )
  }
  return (
    <span className={`${wrapperClass} bg-black`}>
      <img
        src={thumb.src}
        alt=""
        className="w-full h-full object-cover"
        onError={(e) => { (e.currentTarget.parentElement as HTMLElement | null)?.style.setProperty('display', 'none') }}
      />
      {thumb.kind === 'gif' && playOverlay}
    </span>
  )
}
