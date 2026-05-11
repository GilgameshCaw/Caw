// Canonical URL builder for caws. Twitter-style:
//   /users/<username>/caw/<id>-<slug>
//
// The slug is decorative — the numeric <id> prefix is the only piece used
// for lookup. Stale slugs (post edited, etc.) and stale usernames (token
// transferred) both resolve to the same caw and 301 to the canonical
// shape on the server side.
//
// Slug omitted entirely when the caw has no usable text (image-only,
// poll-only, all stop-words). The shape becomes /users/<u>/caw/<id>.

// Romance + Germanic stop words. Source-language slugs mean we want each
// language's articles/particles stripped so the slug carries only the
// content-bearing words. English-heavy by default; non-English entries
// are the high-frequency articles/prepositions/conjunctions and a few
// verbs that survive substring tokenization.
const STOP_WORDS = new Set<string>([
  // English
  'the','a','an','and','or','but','of','to','in','on','at','by','for','with',
  'from','as','is','it','be','this','that','these','those','i','you','we',
  'they','he','she','my','your','our','their','am','are','was','were','been',
  'do','does','did','have','has','had','will','would','can','could','should',
  'not','no','so','if','then','than','there','here',
  // Spanish
  'el','la','los','las','un','una','unos','unas','de','del','y','o','pero',
  'en','para','por','con','sin','sobre','que','es','son','soy','eres','está',
  'están','muy','más','este','esta','estos','estas','ese','esa','eso','esto',
  // French
  'le','les','un','une','des','du','et','ou','mais','dans','pour','par',
  'avec','sans','sur','que','qui','ce','cette','ces','est','sont','suis',
  'es','être','plus','très','je','tu','il','elle','nous','vous','ils','elles',
  // Portuguese
  'o','os','as','um','uma','uns','umas','de','do','da','dos','das','e','ou',
  'mas','em','para','por','com','sem','sobre','que','é','são','sou','está',
  'estão','muito','mais','este','esta','estes','estas','esse','essa','isso',
  // Italian
  'il','lo','la','i','gli','le','un','uno','una','di','del','della','dei',
  'degli','delle','e','o','ma','in','per','con','su','che','è','sono','sei',
  'più','molto','questo','questa','questi','queste','quello','quella',
  // German
  'der','die','das','den','dem','des','ein','eine','einen','eines','einer',
  'und','oder','aber','in','auf','an','zu','für','mit','ohne','über','von',
  'vom','zum','zur','ist','sind','bin','bist','war','waren','sehr','mehr',
  'ich','du','er','sie','es','wir','ihr','nicht','kein','keine','dies',
  // Dutch
  'de','het','een','en','of','maar','in','op','aan','voor','met','zonder',
  'over','van','dat','die','dit','deze','is','zijn','ben','was','waren',
  'zeer','meer','ik','jij','hij','zij','wij','jullie','niet','geen',
])

// Strip diacritics via NFD decomposition + combining-mark removal.
// "café" → "cafe", "naïve" → "naive", "Ñoño" → "Nono".
function deburr(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '')
}

const MAX_SLUG_LEN = 50
const MAX_WORDS = 6

/**
 * Build a URL slug from arbitrary post text. Returns '' when the input
 * yields no usable words — caller should omit the slug segment entirely
 * in that case rather than emitting a trailing hyphen.
 */
export function slugify(text: string | null | undefined): string {
  if (!text) return ''

  let s = String(text)

  // Strip URLs (http/https/www) — they're noise in slugs.
  s = s.replace(/https?:\/\/\S+/gi, ' ')
  s = s.replace(/\bwww\.\S+/gi, ' ')

  // Strip the smltxt-style escape markers if any survived decompression.
  s = s.replace(/::[a-z]+:[^:]*::/gi, ' ')

  // Drop the leading sigils on hashtags / mentions but keep the words.
  s = s.replace(/[#@]/g, ' ')

  // Deburr + lowercase.
  s = deburr(s).toLowerCase()

  // Collapse anything not a-z0-9 into spaces. Drops emoji, punctuation,
  // CJK (which doesn't slug well anyway — empty slug is the right answer
  // for a CJK-only caw), and stray combining marks deburr missed.
  s = s.replace(/[^a-z0-9]+/g, ' ').trim()

  if (!s) return ''

  const words = s.split(/\s+/).filter(w => w && !STOP_WORDS.has(w))

  // If stop-word elision left nothing, fall back to the un-elided list.
  // Very short caws like "ok!" or "yes the!" shouldn't produce '' just
  // because every word happens to be on the list.
  const useWords = words.length > 0 ? words : s.split(/\s+/).filter(Boolean)

  let slug = useWords.slice(0, MAX_WORDS).join('-')

  if (slug.length > MAX_SLUG_LEN) {
    // Truncate at the last hyphen before the limit so we never cut a
    // word in half.
    const cut = slug.slice(0, MAX_SLUG_LEN)
    const lastHyphen = cut.lastIndexOf('-')
    slug = lastHyphen > 0 ? cut.slice(0, lastHyphen) : cut
  }

  return slug
}

interface CawForUrl {
  id: string | number
  user?: { username?: string | null } | null
  content?: string | null
}

/**
 * Canonical FE path for a caw. Always starts with `/users/<username>/caw/`.
 * Slug is appended when derivable; omitted otherwise.
 *
 * Pass the full caw record. Optimistic / pending caws (id starts with
 * `pending-`) get the legacy `/caws/<id>` path because they have no
 * permanent owner-bound URL yet — the redirect to the canonical form
 * happens once the real id arrives.
 */
export function cawUrl(caw: CawForUrl): string {
  const idStr = String(caw.id)

  // Optimistic caws — no canonical URL yet. CawPage already has a
  // pending-<tempId> → real id redirect path that handles the swap.
  if (idStr.startsWith('pending-')) return `/caws/${idStr}`

  const username = caw.user?.username
  if (!username) return `/caws/${idStr}`

  const slug = slugify(caw.content)
  const tail = slug ? `${idStr}-${slug}` : idStr
  return `/users/${username}/caw/${tail}`
}

/**
 * Parse the numeric id out of the `:idSlug` route param. The slug
 * suffix is decorative — only the leading digits matter for lookup.
 * Returns null for malformed input so callers can 404 cleanly.
 */
export function parseCawIdSlug(idSlug: string | undefined): number | null {
  if (!idSlug) return null
  const m = idSlug.match(/^(\d+)/)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) && n > 0 ? n : null
}
