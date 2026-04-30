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
export const POLL_MAX_OPTION_BYTES = 50

// Regex matches "::poll:" up to the next "::". The body in between is the
// colon-separated option list. Greedy on inner content but bounded by the
// closing "::". Anchored anywhere in the string (g flag for matchAll).
//
// Doesn't span newlines — polls live on one logical line. If the user types
// a newline mid-poll the marker is "broken" and we surface an error.
const POLL_REGEX = /::poll:([^\n]+?)::/g

export interface ParsedPoll {
  /** Substring of the input matched by the marker, including outer "::poll:" / "::" */
  marker: string
  /** Position in the input where the marker starts (UTF-16 char index) */
  start: number
  /** Position one past the end of the marker */
  end: number
  /** The decoded options, in order. Empty/whitespace-only entries dropped. */
  options: string[]
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

  return {
    marker: match[0],
    start: match.index,
    end: match.index + match[0].length,
    options,
  }
}

/**
 * Build a poll marker from option strings. Used by the compose UI when
 * the user clicks "save poll" — we splice the marker into the caw text.
 *
 * Returns null when options are invalid (too few, too many, or contain
 * the colon delimiter / newlines). Caller should surface the error to
 * the user before letting them post.
 */
export function buildPollMarker(options: string[]): string | null {
  const trimmed = options.map(o => o.trim()).filter(o => o.length > 0)
  if (trimmed.length < POLL_MIN_OPTIONS || trimmed.length > POLL_MAX_OPTIONS) {
    return null
  }
  for (const o of trimmed) {
    if (o.includes(':') || o.includes('\n')) return null
  }
  return `::poll:${trimmed.join(':')}::`
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
