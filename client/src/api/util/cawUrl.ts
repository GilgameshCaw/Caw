// Server-side twin of FrontEnd/src/utils/cawUrl.ts. Kept duplicated
// rather than imported because the FE and API live in separate module
// systems (FE = bundler-resolved aliases; API = tsc emit). When you
// change one, change the other — they MUST produce identical slugs or
// canonical-redirect logic loops between the two sides.
// tests/api/cawUrlTwin.test.ts checks that both sides give the same slug.

// Same list, same order, as the FE twin, so the two can be diffed by eye.
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

function deburr(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '')
}

const MAX_SLUG_LEN = 50
const MAX_WORDS = 6

export function slugify(text: string | null | undefined): string {
  if (!text) return ''

  let s = String(text)
  s = s.replace(/https?:\/\/\S+/gi, ' ')
  s = s.replace(/\bwww\.\S+/gi, ' ')
  s = s.replace(/::[a-z]+:[^:]*::/gi, ' ')
  s = s.replace(/[#@]/g, ' ')
  s = deburr(s).toLowerCase()
  s = s.replace(/[^a-z0-9]+/g, ' ').trim()

  if (!s) return ''

  const words = s.split(/\s+/).filter(w => w && !STOP_WORDS.has(w))
  const useWords = words.length > 0 ? words : s.split(/\s+/).filter(Boolean)

  let slug = useWords.slice(0, MAX_WORDS).join('-')

  if (slug.length > MAX_SLUG_LEN) {
    const cut = slug.slice(0, MAX_SLUG_LEN)
    const lastHyphen = cut.lastIndexOf('-')
    slug = lastHyphen > 0 ? cut.slice(0, lastHyphen) : cut
  }

  return slug
}

interface CawForUrl {
  id: string | number
  username: string | null | undefined
  content: string | null | undefined
}

/**
 * Canonical PATH (no origin) for a caw. Returns `/caws/<id>` as a
 * fallback when the username is missing — the legacy route still
 * resolves and the FE 301s it through once the data is available.
 */
export function cawPath(caw: CawForUrl): string {
  const idStr = String(caw.id)
  if (!caw.username) return `/caws/${idStr}`
  const slug = slugify(caw.content)
  const tail = slug ? `${idStr}-${slug}` : idStr
  return `/users/${caw.username}/caw/${tail}`
}

/** Numeric id from the `:idSlug` segment. Slug suffix is decorative. */
export function parseCawIdSlug(idSlug: string | undefined): number | null {
  if (!idSlug) return null
  const m = idSlug.match(/^(\d+)/)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) && n > 0 ? n : null
}
