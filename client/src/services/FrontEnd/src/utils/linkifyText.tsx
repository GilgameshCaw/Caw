import React from 'react'

// Match http(s) URLs. Same shape as PostForm.tsx URL_REGEX so DM and post
// detection agree on what counts as a URL. Excludes quote/bracket chars
// (don't swallow quote wrappers) and trailing punctuation (don't grab the
// period that ends a sentence). The negated trailing-char class is what
// makes `Visit https://x.com.` extract `https://x.com` rather than
// `https://x.com.`.
const URL_REGEX = /https?:\/\/[^\s<>"'{}|\\^`[\]]+[^\s<>"'{}|\\^`[\].,!?;:)\]]/gi

/**
 * Split `text` into an array of strings and `<a>` nodes, with every
 * matched URL turned into a clickable link. Use cases: chat bubbles,
 * any plain-text surface that should auto-hyperlink without pulling in
 * the full ContentWithHashtags pipeline (link previews, image embeds,
 * hashtag/mention routing — all post-feed-specific).
 *
 * Renders to React nodes, not HTML — `dangerouslySetInnerHTML` is the
 * usual landmine here, and the slight performance cost of the array
 * approach is irrelevant for the tens of bubbles a DM thread shows.
 *
 * Links open in a new tab with `noopener noreferrer` so a malicious
 * destination can't `window.opener.location` the user away from the
 * app — every untrusted external link in this codebase already does
 * the same.
 */
export function linkifyText(text: string, linkClassName?: string): React.ReactNode[] {
  if (!text) return []

  const nodes: React.ReactNode[] = []
  let lastIndex = 0
  let key = 0

  // Reset lastIndex so callers can reuse the regex (it's a module-level
  // /gi pattern; without resetting, a second call would skip matches
  // it already consumed in a prior invocation).
  URL_REGEX.lastIndex = 0
  for (let m = URL_REGEX.exec(text); m !== null; m = URL_REGEX.exec(text)) {
    const url = m[0]
    const start = m.index
    if (start > lastIndex) {
      nodes.push(text.slice(lastIndex, start))
    }
    nodes.push(
      <a
        key={`url-${key++}`}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        // Stop the click from bubbling up to bubble-level handlers
        // (e.g. open-message-actions) so a link tap navigates without
        // also triggering the surrounding UI.
        onClick={e => e.stopPropagation()}
        className={linkClassName ?? 'underline hover:opacity-80 break-all'}
      >
        {url}
      </a>,
    )
    lastIndex = start + url.length
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex))
  }
  return nodes
}
