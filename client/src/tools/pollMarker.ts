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
// (options + ::pi:host:hashes::) marker still fits inside 420 bytes with
// room for body text.
//
// Worst-case marker math (6 options + 6 images + 16-byte host):
//   ::poll: + 6*30 + 5 colons   ← options  = 7 + 180 + 5  = 192
//   ::pi: + host + ":" + 6*8 + 5 colons + :: ← sidecar = 5 + 16 + 1 + 48 + 5 + 2 = 77
//   Total = 269 bytes; leaves ~151 for body + separators. Comfortable.
//
// If the operator's host is unusually long (>30 bytes) the worst-case
// shrinks the body budget proportionally — text-only polls are unaffected.
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

// Optional duration sidecar, e.g. "::pd:7d::". Encodes how long the
// poll accepts votes after the caw's block timestamp. Validator and
// indexer reject vote actions whose block timestamp is past
// (cawCreated + duration). Format is digits + a single unit char
// from POLL_DURATION_UNITS. Compact (2-3 bytes vs 10 for unix epoch)
// and mirror-consistent because every node derives endsAt from the
// same on-chain timestamps. Omitted entirely on polls that should
// never expire (pre-launch backstop — we can decide to require a
// duration later without a marker shape change).
//
// Wire shape:
//   ::poll:opt1:opt2:opt3::pd:7d::
//   ::poll:opt1:opt2::pi:host:hash:hash::pd:1h::
//   ::poll:opt1:opt2:opt3::pm::                       (multi-select)
//   ::poll:opt1:opt2::pi:host:hash:hash::pd:1h::pm::  (everything)
// Order: ::pi: → ::pd: → ::pm: when present. Parser walks sidecars
// in this order; missing ones are tolerated. Old mirrors that don't
// know about a sidecar just ignore the trailing bytes (the main
// poll/image shape stays intact).
const POLL_DURATION_REGEX = /^::pd:(\d{1,3}[hdw])::/
// Multi-select flag sidecar — bare `::pm::` (4 bytes). Presence
// indicates the poll accepts multiple option picks per voter. Absent =
// single-select, the historical default.
const POLL_MULTISELECT_REGEX = /^::pm::/
// Mapping from unit suffix to seconds. Kept narrow (h/d/w) so the
// validator's allow-list is trivial — minutes feel too short for a
// social poll, months are unbounded enough we'd rather force a fresh
// post.
export const POLL_DURATION_UNITS: Record<string, number> = {
  h: 3600,
  d: 86400,
  w: 604800,
}
// Composer-facing duration choices. Validator accepts any well-formed
// `\d+[hdw]` value within (POLL_MIN_DURATION_SEC, POLL_MAX_DURATION_SEC]
// — these constants are what we surface in the picker UI but are not
// the only legal values on-chain.
export const POLL_DURATION_CHOICES: { label: string; value: string; seconds: number }[] = [
  { label: '1 hour', value: '1h', seconds: 3600 },
  { label: '6 hours', value: '6h', seconds: 21600 },
  { label: '1 day', value: '1d', seconds: 86400 },
  { label: '7 days', value: '7d', seconds: 604800 },
  { label: '30 days', value: '30d', seconds: 2592000 },
]
export const POLL_DURATION_DEFAULT = '1d'
export const POLL_MIN_DURATION_SEC = 3600        // 1 hour
export const POLL_MAX_DURATION_SEC = 30 * 86400  // 30 days
// Parse the bare duration value (e.g. "7d") into seconds. Returns
// undefined for malformed input or values outside the allowed range.
export function parsePollDuration(s: string): number | undefined {
  const m = /^(\d{1,3})([hdw])$/.exec(s)
  if (!m) return undefined
  const n = parseInt(m[1], 10)
  const unit = m[2] as keyof typeof POLL_DURATION_UNITS
  const seconds = n * POLL_DURATION_UNITS[unit]
  if (seconds < POLL_MIN_DURATION_SEC || seconds > POLL_MAX_DURATION_SEC) return undefined
  return seconds
}

// Regex matches "::poll:" up to the next "::". The body in between is the
// colon-separated option list. Greedy on inner content but bounded by the
// closing "::". Anchored anywhere in the string (g flag for matchAll).
//
// Doesn't span newlines — polls live on one logical line. If the user types
// a newline mid-poll the marker is "broken" and we surface an error.
const POLL_REGEX = /::poll:([^\n]+?)::/g
// Optional per-poll image-hash sidecar. Lives directly after the closing
// :: of the main marker (no whitespace between), e.g.:
//   ::poll:a:b:c::pi:text.caw.social:abc12345:def67890::
//   ::poll:a:b::pi:local.caw.com:p5274:s:abc12345:def67890::    (with port + http)
//
// Format: "::pi:" host [":p" port] [":s"] (":" hash)+ "::"
//   - host   = originating instance's hostname (no port, no scheme).
//              Indexers join host (and the optional port/scheme below)
//              into  <scheme>://<host>[:<port>]/uploads/images/<hash>.<ext>
//   - p<N>   = OPTIONAL port segment, prefix `p` + decimal digits.
//              Omitted on default ports (443 for https, 80 for http).
//              Lets local dev (e.g. local.caw.com:5274) survive the
//              round-trip without breaking image URLs.
//   - s      = OPTIONAL "http (insecure) scheme" flag. Omitted means
//              https — the prod default. Single-char marker for the
//              dev/internal-only case so we don't burn 5 bytes
//              ("https") on the common path.
//   - hash   = 8-char hex filename stem from the upload route. Positional
//              with options. Empty slot (between two colons) = no image
//              for that option.
//
// Regex admits the union of all valid characters: hostname chars
// (alnum/dot/hyphen) + `p` + digits for port + bare `s` + 8-hex hashes
// + colons. Anchored to start-of-string because we only consume it
// directly after the main marker — not anywhere in the text.
const POLL_IMAGES_REGEX = /^::pi:([a-zA-Z0-9.\-:]*?)::/
// DNS-style host validation. Lowercased, no port, no scheme. Reject
// anything fancy at parse-time so a malformed sidecar degrades to
// text-only instead of producing junk URLs the indexer would 404 on.
const POLL_HOST_REGEX = /^[a-z0-9](?:[a-z0-9.\-]{0,253}[a-z0-9])?$/
const POLL_PORT_REGEX = /^p([1-9][0-9]{0,4})$/
const POLL_SCHEME_FLAG = 's'

export interface ParsedPoll {
  /** Substring of the input matched by the marker, including outer "::poll:" / "::" AND any trailing ::pi:...:: + ::pd:...:: sidecars. */
  marker: string
  /** Position in the input where the marker starts (UTF-16 char index) */
  start: number
  /** Position one past the end of the marker (including any sidecars) */
  end: number
  /** The decoded options, in order. Empty/whitespace-only entries dropped. */
  options: string[]
  /** Per-option image hashes — positional, same length as `options`.
   *  Empty string in slot i = no image. Always returned (defaults to all
   *  empty when the sidecar is absent) so consumers don't have to bounds-check. */
  imageHashes: string[]
  /** Originating-instance host for the image hashes — populated when the
   *  ::pi:host:...:: sidecar is present and `host` is a valid hostname.
   *  Empty when absent. */
  imageHost: string
  /** Optional port from the `:p<N>:` segment. Undefined when absent
   *  (resolver uses the scheme's default port). */
  imagePort?: number
  /** Scheme to use when reconstructing URLs: 'https' (default) or 'http'
   *  when the `:s:` flag is present. */
  imageScheme: 'http' | 'https'
  /** Voting window in seconds, from the ::pd:<dur>:: sidecar. Undefined
   *  when the sidecar is absent (poll never expires by marker) or
   *  malformed. Validator + indexer enforce: reject votes whose block
   *  timestamp is past (cawCreatedAt + durationSeconds). */
  durationSeconds?: number
  /** Raw duration value from the marker (e.g. "7d"). Preserved so
   *  re-renderers can emit the same wire form when reconstructing. */
  durationValue?: string
  /** True when the ::pm:: sidecar is present. Multi-select polls let
   *  the voter pick multiple options; each vote action toggles a
   *  specific option in or out (instead of replacing the prior pick). */
  multiSelect: boolean
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

  // Try to consume sidecars immediately after the main marker. Same-
  // line only; anything else (whitespace, a newline) ends the poll
  // block. Sidecars appear in fixed order: image first, then duration.
  // Each is independently optional.
  const tailStart = match.index + match[0].length
  let cursor = tailStart
  let imageHashes: string[] = options.map(() => '')
  let imageHost = ''
  let imagePort: number | undefined
  let imageScheme: 'http' | 'https' = 'https'
  let durationSeconds: number | undefined
  let durationValue: string | undefined

  // ::pi:host[:p<N>][:s]:hash:hash:: — image sidecar.
  const imgMatch = POLL_IMAGES_REGEX.exec(text.slice(cursor))
  if (imgMatch) {
    const segments = imgMatch[1].split(':')
    const host = (segments[0] || '').trim().toLowerCase()
    if (POLL_HOST_REGEX.test(host)) {
      imageHost = host
      // After the host, optional metadata segments (port, scheme) come
      // BEFORE the hash list. Walk forward consuming any segment that
      // matches a known meta prefix; first non-meta segment is the start
      // of the hash list.
      let i = 1
      while (i < segments.length) {
        const seg = segments[i].trim()
        const portMatch = POLL_PORT_REGEX.exec(seg)
        if (portMatch) {
          const p = parseInt(portMatch[1], 10)
          if (p > 0 && p <= 65535) imagePort = p
          i++
          continue
        }
        if (seg === POLL_SCHEME_FLAG) {
          imageScheme = 'http'
          i++
          continue
        }
        break
      }
      // From `i` onward, segments are positional hashes — same handling
      // as before. Empty slots preserve "no image for this option."
      const rawHashes = segments.slice(i)
      imageHashes = options.map((_, idx) => {
        const h = (rawHashes[idx] || '').trim()
        return POLL_IMAGE_HASH_REGEX.test(h) ? h : ''
      })
      cursor += imgMatch[0].length
    }
    // Malformed host → consume no sidecar bytes; treat as text-only.
    // The ::pi:...:: substring still appears in `text` and would render
    // verbatim in the body — the renderer's stripPollMarker won't catch
    // it. Acceptable: invalid sidecars are user/forgery error and rare.
  }

  // ::pd:<duration>:: — vote-window sidecar. Mirror nodes that don't
  // know about ::pd:: just leave it in the body text — same fallback
  // as a malformed ::pi: above.
  const durMatch = POLL_DURATION_REGEX.exec(text.slice(cursor))
  if (durMatch) {
    const parsed = parsePollDuration(durMatch[1])
    if (parsed != null) {
      durationSeconds = parsed
      durationValue = durMatch[1]
      cursor += durMatch[0].length
    }
  }

  // ::pm:: — multi-select flag. Same lenient-tail policy: a malformed
  // run leaves the literal bytes in the body for older renderers to
  // ignore.
  let multiSelect = false
  const msMatch = POLL_MULTISELECT_REGEX.exec(text.slice(cursor))
  if (msMatch) {
    multiSelect = true
    cursor += msMatch[0].length
  }

  return {
    marker: text.slice(match.index, cursor),
    start: match.index,
    end: cursor,
    options,
    imageHashes,
    imageHost,
    imagePort,
    imageScheme,
    durationSeconds,
    durationValue,
    multiSelect,
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
 * `meta` (required when emitting an image sidecar) is the originating
 * instance's host plus optional non-default port + http scheme. The
 * host appears ONCE; port (`:p<N>:`) is omitted when it's the default
 * for the scheme; scheme flag (`:s:`) is omitted when https. Default-
 * port https therefore costs zero extra marker bytes — only dev /
 * non-standard deployments pay for the extra segments.
 *
 * Returns null when options are invalid (too few, too many, or contain
 * the colon delimiter / newlines), or when image hashes are provided
 * without a valid host. Caller should surface the error to the user
 * before letting them post.
 */
export function buildPollMarker(
  options: string[],
  imageHashes?: string[],
  meta?: { host: string; port?: number; scheme?: 'http' | 'https' },
  duration?: string,
  multiSelect?: boolean,
): string | null {
  const trimmed = options.map(o => o.trim()).filter(o => o.length > 0)
  if (trimmed.length < POLL_MIN_OPTIONS || trimmed.length > POLL_MAX_OPTIONS) {
    return null
  }
  for (const o of trimmed) {
    if (o.includes(':') || o.includes('\n')) return null
  }
  let out = `::poll:${trimmed.join(':')}::`

  // Image sidecar — only emit when at least one slot is populated AND we
  // have a valid host. Without a host the hashes can't be resolved on a
  // mirror, so there's no point burning marker bytes on them.
  const hasAnyHash = imageHashes && imageHashes.some(h => POLL_IMAGE_HASH_REGEX.test((h || '').trim()))
  if (hasAnyHash) {
    const cleanHost = (meta?.host || '').trim().toLowerCase()
    if (!POLL_HOST_REGEX.test(cleanHost)) return null
    const padded = trimmed.map((_, i) => {
      const h = (imageHashes![i] || '').trim()
      return POLL_IMAGE_HASH_REGEX.test(h) ? h : ''
    })
    // Build the optional port + scheme segments. Default-port https
    // emits nothing extra; only non-default ports / http get the bytes.
    const scheme = meta?.scheme === 'http' ? 'http' : 'https'
    const port = meta?.port
    const defaultPort = scheme === 'https' ? 443 : 80
    const metaSegments: string[] = []
    if (port && port !== defaultPort) metaSegments.push(`p${port}`)
    if (scheme === 'http') metaSegments.push(POLL_SCHEME_FLAG)
    const metaPrefix = metaSegments.length > 0 ? `:${metaSegments.join(':')}` : ''
    out += `::pi:${cleanHost}${metaPrefix}:${padded.join(':')}::`
  }

  // Duration sidecar — only emit when duration is a well-formed value
  // within the allowed range. Malformed input is silently dropped (poll
  // becomes never-expires) rather than failing the whole build; the
  // composer should validate before getting here, but a graceful
  // degrade is safer than a hard reject.
  if (duration) {
    const seconds = parsePollDuration(duration)
    if (seconds != null) {
      out += `::pd:${duration}::`
    }
  }

  // Multi-select flag sidecar — bare presence indicates the poll
  // accepts multiple picks per voter. Omitted on single-select (the
  // default, common path).
  if (multiSelect) out += `::pm::`

  return out
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
 * Extract host + optional non-default port + scheme from an absolute
 * image URL — the same fields that go into the on-chain
 * ::pi:host[:p<port>][:s]:hashes:: sidecar so mirror nodes can fetch it.
 *
 * Returns null for relative paths (no host to extract) or malformed
 * URLs. Default ports are returned as `undefined` so the marker
 * builder can omit the segment.
 *
 * The URL the upload route returned IS the source of truth: that's
 * exactly where the file lives, including for frontend-only
 * deployments that hit an external VITE_API_HOST sibling.
 *
 * Examples:
 *   "https://text.caw.social/uploads/images/x.webp"     → { host: 'text.caw.social' }
 *   "http://local.caw.com:5274/uploads/images/x.webp"   → { host: 'local.caw.com', port: 5274, scheme: 'http' }
 *   "/uploads/images/x.webp"                             → null
 */
export function imageUrlToMeta(url: string): { host: string; port?: number; scheme: 'http' | 'https' } | null {
  if (!url || typeof url !== 'string') return null
  if (!url.startsWith('http://') && !url.startsWith('https://')) return null
  try {
    const u = new URL(url)
    const scheme: 'http' | 'https' = u.protocol === 'http:' ? 'http' : 'https'
    const defaultPort = scheme === 'https' ? 443 : 80
    // u.port is "" when default. Parse to a number; treat default-equal as undefined.
    const port = u.port ? parseInt(u.port, 10) : undefined
    return {
      host: u.hostname.toLowerCase(),
      port: port && port !== defaultPort ? port : undefined,
      scheme,
    }
  } catch {
    return null
  }
}

/** Back-compat shim — call sites that only need the bare host. */
export function imageUrlToHost(url: string): string {
  return imageUrlToMeta(url)?.host || ''
}

/**
 * Extension probe order for resolving an on-chain (host, hash) pair to a
 * concrete URL. WebP first because that's what the upload route writes
 * for compressed images; png/jpg/gif round out the formats the route
 * accepts. The indexer tries them in order and stores the first that
 * 200s (or stores all of them as a single comma-separated list and lets
 * the renderer try them in order — see resolvePollImageUrl below).
 */
export const POLL_IMAGE_EXTENSIONS = ['webp', 'png', 'jpg', 'jpeg', 'gif'] as const

/**
 * Reconstruct an image URL from on-chain marker fields. Returns the
 * WebP URL by default since that's the upload route's canonical output
 * format; callers that need a different extension can override.
 *
 * Scheme defaults to https (the prod case) and port to the scheme's
 * default. Both are overridable for dev / non-standard deployments
 * that ride along in the marker via the optional `:p<N>:` and `:s:`
 * segments.
 */
export function resolvePollImageUrl(
  host: string,
  hash: string,
  ext: typeof POLL_IMAGE_EXTENSIONS[number] = 'webp',
  port?: number,
  scheme: 'http' | 'https' = 'https',
): string {
  if (!host || !hash) return ''
  if (!POLL_HOST_REGEX.test(host) || !POLL_IMAGE_HASH_REGEX.test(hash)) return ''
  const defaultPort = scheme === 'https' ? 443 : 80
  const portSuffix = port && port !== defaultPort ? `:${port}` : ''
  return `${scheme}://${host}${portSuffix}/uploads/images/${hash}.${ext}`
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
