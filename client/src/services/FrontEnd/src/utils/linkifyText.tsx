import React from 'react'
import { TAG_CHAR_CLASS, HASHTAG_SIGIL_CLASS, MENTION_SIGIL_CLASS } from '~/../../../tools/hashtagRegex'

// Match http(s) URLs. Same shape as PostForm.tsx URL_REGEX so DM and post
// detection agree on what counts as a URL. Excludes quote/bracket chars
// (don't swallow quote wrappers) and trailing punctuation (don't grab the
// period that ends a sentence).
const URL_ALT = `https?:\\/\\/[^\\s<>"'{}|\\\\^\`\\[\\]]+[^\\s<>"'{}|\\\\^\`\\[\\].,!?;:)\\]]`

// Tag/cashtag/mention shape. Matches the feed parser in
// ContentWithHashtags.tsx so DM bubbles linkify the exact same surfaces
// as a post's body: hashtags + cashtags (#, $, ＃, ＄) and @mentions
// (@, ＠). The lookahead enforces "at least one non-digit char" so #5
// and $100 stay plain text.
const ALL_SIGILS = `(?:${HASHTAG_SIGIL_CLASS}|${MENTION_SIGIL_CLASS})`
const TAG_ALT = `${ALL_SIGILS}(?=${TAG_CHAR_CLASS}*[\\p{L}\\p{M}_])${TAG_CHAR_CLASS}+`

const SPLIT_REGEX = new RegExp(`(${TAG_ALT}|${URL_ALT})`, 'gu')

// Anchored matchers: confirm a split chunk is ENTIRELY a tag/mention/URL
// rather than text that happens to start with one of those characters.
const IS_FULL_MENTION = new RegExp(`^${MENTION_SIGIL_CLASS}${TAG_CHAR_CLASS}+$`, 'u')
const IS_FULL_TAG = new RegExp(`^${TAG_ALT}$`, 'u')
const IS_FULL_URL = new RegExp(`^${URL_ALT}$`, 'u')

/**
 * Split `text` into an array of strings and React nodes, with every
 * matched URL, @mention, #hashtag, and $cashtag turned into a clickable
 * link/button. Use cases: chat bubbles, any plain-text surface that
 * should auto-hyperlink without pulling in the full ContentWithHashtags
 * pipeline (which also handles inline images, link previews, video).
 *
 * Renders to React nodes, not HTML — `dangerouslySetInnerHTML` is the
 * usual landmine here.
 *
 * Mentions navigate to /users/{username}; hashtags + cashtags navigate
 * to /hashtags/{tag}; URLs open in a new tab with noopener/noreferrer.
 */
export function linkifyText(text: string, linkClassName?: string): React.ReactNode[] {
  if (!text) return []
  const cls = linkClassName ?? 'underline hover:opacity-80 break-all'
  const tagCls = 'text-blue-400 hover:underline cursor-pointer'

  const parts = text.split(SPLIT_REGEX)
  return parts.map((part, idx) => {
    if (!part) return null
    const key = `lnk-${idx}`

    if (IS_FULL_URL.test(part)) {
      return (
        <a
          key={key}
          href={part}
          target="_blank"
          rel="noopener noreferrer"
          onClick={e => e.stopPropagation()}
          className={cls}
        >
          {part}
        </a>
      )
    }

    if (IS_FULL_MENTION.test(part)) {
      // Strip the @ / ＠ sigil for the URL slug; render the raw token so
      // ＠fancy renders ＠fancy but links to /users/fancy.
      const username = part.replace(new RegExp(`^${MENTION_SIGIL_CLASS}`, 'u'), '')
      // Homograph guard: CAW usernames are [a-z0-9] only (on-chain claim).
      // NFKC-normalize then reject non-ASCII slugs so Cyrillic lookalikes
      // can't route to an impersonating path. Render as plain text if invalid.
      const normalized = username.normalize('NFKC')
      if (!/^[a-z0-9]+$/.test(normalized) || normalized !== username) {
        return <span key={key}>{part}</span>
      }
      return (
        <a
          key={key}
          href={`/users/${encodeURIComponent(username)}`}
          onClick={e => e.stopPropagation()}
          className={tagCls}
        >
          {part}
        </a>
      )
    }

    if (IS_FULL_TAG.test(part)) {
      // Hashtag or cashtag — both route to /hashtags/{stripped}. Strip
      // any sigil (ascii or fullwidth) for the slug.
      const tag = part.replace(new RegExp(`^${HASHTAG_SIGIL_CLASS}`, 'u'), '')
      return (
        <a
          key={key}
          href={`/hashtags/${encodeURIComponent(tag)}`}
          onClick={e => e.stopPropagation()}
          className={tagCls}
        >
          {part}
        </a>
      )
    }

    return part
  })
}
