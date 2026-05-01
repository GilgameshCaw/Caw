// Shared poll marker parser. Used by:
//   - Frontend PostForm: live char-counting + thread splitter (poll is atomic)
//   - Frontend FeedItem: renders the poll inside a post
//   - Backend ActionProcessor: indexer creates/finds Poll rows from caw text
//   - Backend API submit path: optimistic Poll creation alongside the Caw
//
// Format: ::poll:option one:option two:option three::
//   - Outer markers: literal "::poll:" prefix and "::" suffix
//   - Options separated by ":"
//   - Options can NOT contain ":" or whitespace-only — rejected at compose time
//   - 2–6 options
//
// Why so strict? Polls live inline inside the freeform caw text (which can
// also have body, hashtags, mentions, image URLs, etc.). The marker has to
// be unambiguous to scan out at index time AND it has to fit byte-for-byte
// inside a single 420-byte chunk — the thread splitter treats the whole
// "::poll:...::" run as atomic and refuses to break it.
//
// Per-option char limit is enforced at compose time, not parse time. The
// parser is intentionally lenient on length so the indexer accepts whatever
// landed on-chain (votes still work even if the poll author exploited a
// stale frontend to post longer options — graceful degrade beats refusing
// to index).

export const POLL_MAX_OPTIONS = 6
export const POLL_MIN_OPTIONS = 2
// When the poll has NO images, options can be up to 50 bytes — leaves
// plenty of body budget. When ANY option has an image, the per-option
// cap drops to POLL_MAX_OPTION_BYTES_WITH_IMAGES so the combined
// (options + ::pi:hash list::) marker still fits inside 420 bytes with
// room for body text.
//
// Worst-case marker math (6 options + 6 images, all maxed):
//   ::poll: + 6*30 + 5 colons + ::pi: + 6*8 + 5 colons + ::
//   = 7 + 180 + 5 + 5 + 48 + 5 + 2 = 252 bytes
// Leaves ~168 bytes for body + separators. Comfortable.
export const POLL_MAX_OPTION_BYTES = 50
export const POLL_MAX_OPTION_BYTES_WITH_IMAGES = 30
// Image hashes embedded in the marker are the 8-char filename stem from
// the upload route's randomBytes(4).toString('hex'). The indexer
// reconstructs the URL on lookup. Length must match what the route
// produces; if uniqueId length ever changes, update this in lockstep.
export const POLL_IMAGE_HASH_LEN = 8
// Per-image regex for picking valid hashes out of the marker. Lowercase
// hex only; anything else is rejected (and treated as "no image" for
// that slot). Mirror nodes that see an unknown hash render text-only.
const POLL_IMAGE_HASH_REGEX = /^[a-f0-9]{8}$/

// Regex matches "::poll:" up to the next "::". The body in between is the
// colon-separated option list. Greedy on inner content but bounded by the
// closing "::". Anchored anywhere in the string (g flag for matchAll).
//
// Doesn't span newlines — polls live on one logical line. If the user types
// a newline mid-poll the marker is "broken" and we surface an error.
const POLL_REGEX = /::poll:([^\n]+?)::/g
// Optional per-poll image-hash sidecar. Lives directly after the closing
// :: of the main marker (no whitespace between), e.g.:
//   ::poll:a:b:c::pi:abc12345:def67890::
// Each hash is positional with the matching option index. Empty slot
// (between two colons, e.g. "::pi::") = no image for that option.
const POLL_IMAGES_REGEX = /^::pi:([a-f0-9:]*?)::/

export interface ParsedPoll {
  /** Substring of the input matched by the marker, including outer "::poll:" / "::" AND any trailing ::pi:...:: sidecar. */
  marker: string
  /** Position in the input where the marker starts (UTF-16 char index) */
  start: number
  /** Position one past the end of the marker (including image sidecar if present) */
  end: number
  /** The decoded options, in order. Empty/whitespace-only entries dropped. */
  options: string[]
  /** Per-option image hashes — positional, same length as `options`.
   *  Empty string in slot i = no image. Always returned (defaults to all
   *  empty when the sidecar is absent) so consumers don't have to bounds-check. */
  imageHashes: string[]
}

/**
 * Find the first valid poll marker in `text`. Returns null if none, or
 * if the only marker found is malformed (wrong option count). Doesn't
 * throw — calling code uses the null/non-null result to branch UI.
 *
 * "First valid" matters: the parser tolerates a second `::poll:...::`
 * appearing inside an option (unlikely but possible in adversarial text)
 * by matching greedily-by-position, not by trying every alternative.
 */
export function parsePoll(text: string): ParsedPoll | null {
  if (!text) return null
  POLL_REGEX.lastIndex = 0
  const match = POLL_REGEX.exec(text)
  if (!match) return null

  const inner = match[1]
  // Empty options are allowed in the wire format (a stray "::") but the
  // parser drops them — they'd just be unselectable.
  const options = inner.split(':').map(o => o.trim()).filter(o => o.length > 0)
  if (options.length < POLL_MIN_OPTIONS || options.length > POLL_MAX_OPTIONS) {
    return null
  }

  // Try to consume a "::pi:hash:hash::" sidecar immediately after the main
  // marker. Same-line only; anything else (whitespace, a newline) ends the
  // poll block.
  const tailStart = match.index + match[0].length
  const tail = text.slice(tailStart)
  let imageHashes: string[] = options.map(() => '')
  let endPos = tailStart
  const imgMatch = POLL_IMAGES_REGEX.exec(tail)
  if (imgMatch) {
    // Split keeps empty slots ("::pi:hash::hash3::" → ["hash", "", "hash3"])
    // so positional alignment with options is preserved across "no image
    // for slot i" gaps.
    const rawHashes = imgMatch[1].split(':')
    imageHashes = options.map((_, i) => {
      const h = (rawHashes[i] || '').trim()
      return POLL_IMAGE_HASH_REGEX.test(h) ? h : ''
    })
    endPos = tailStart + imgMatch[0].length
  }

  return {
    marker: text.slice(match.index, endPos),
    start: match.index,
    end: endPos,
    options,
    imageHashes,
  }
}

/**
 * Build a poll marker from option strings, optionally with a per-option
 * image-hash sidecar.
 *
 * `imageHashes` (when provided) must be POSITIONAL with `options` —
 * imageHashes[i] is the 8-char hex hash for options[i], or the empty
 * string for "no image". Out-of-shape arrays are tolerated: missing or
 * malformed entries become "no image" rather than rejecting the build.
 *
 * Returns null when options are invalid (too few, too many, or contain
 * the colon delimiter / newlines). Caller should surface the error to
 * the user before letting them post.
 */
export function buildPollMarker(options: string[], imageHashes?: string[]): string | null {
  const trimmed = options.map(o => o.trim()).filter(o => o.length > 0)
  if (trimmed.length < POLL_MIN_OPTIONS || trimmed.length > POLL_MAX_OPTIONS) {
    return null
  }
  for (const o of trimmed) {
    if (o.includes(':') || o.includes('\n')) return null
  }
  const base = `::poll:${trimmed.join(':')}::`

  // Image sidecar — only emit when at least one slot is populated. Saves
  // bytes (and visual noise on-chain) when the poll is text-only.
  if (imageHashes && imageHashes.some(h => POLL_IMAGE_HASH_REGEX.test((h || '').trim()))) {
    const padded = trimmed.map((_, i) => {
      const h = (imageHashes[i] || '').trim()
      return POLL_IMAGE_HASH_REGEX.test(h) ? h : ''
    })
    return `${base}::pi:${padded.join(':')}::`
  }

  return base
}

/**
 * Strip the poll marker from text, returning the body without it. Used by
 * the renderer so the caw body can be displayed above the poll widget
 * without the inline marker leaking through.
 *
 * Trims surrounding whitespace from the cut so "hey ::poll:a:b::" doesn't
 * leave a trailing space.
 */
export function stripPollMarker(text: string): string {
  const parsed = parsePoll(text)
  if (!parsed) return text
  return (text.slice(0, parsed.start) + text.slice(parsed.end))
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Extract the on-chain hash (8-char filename stem) from an off-chain
 * image URL. Returns "" when the URL doesn't look like one of our
 * upload-route URLs — caller treats that as "no image."
 *
 * Example: "https://text.caw.social/uploads/images/abc12345.webp" → "abc12345"
 *          "/uploads/images/abc12345.webp"                          → "abc12345"
 *          "https://example.com/x.png"                              → ""
 */
export function imageUrlToPollHash(url: string): string {
  if (!url || typeof url !== 'string') return ''
  // Match the `/uploads/images/<8hex>.<ext>` tail. Tolerant about origin —
  // works for relative paths and same-origin absolute URLs alike.
  const m = /\/uploads\/images\/([a-f0-9]{8})\.[a-zA-Z0-9]+(?:[?#].*)?$/.exec(url)
  return m ? m[1] : ''
}

/**
 * Parse a vote action's text. Returns the optionIndex to vote for, or
 * null for unvote (text is just "vote:"). Returns undefined when the
 * text isn't a vote action at all.
 *
 * Format:
 *   vote:N        — vote for option N (0-based)
 *   vote:         — unvote (remove existing vote)
 */
export function parseVoteText(text: string): { optionIndex: number | null } | undefined {
  if (!text || !text.startsWith('vote:')) return undefined
  const rest = text.slice(5).trim()
  if (rest === '') return { optionIndex: null }
  const n = parseInt(rest, 10)
  if (!Number.isFinite(n) || n < 0 || n >= POLL_MAX_OPTIONS) return undefined
  return { optionIndex: n }
}

/**
 * Build a vote action's text. Pass null/undefined for unvote.
 */
export function buildVoteText(optionIndex: number | null): string {
  if (optionIndex == null) return 'vote:'
  return `vote:${optionIndex}`
}
