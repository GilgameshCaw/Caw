// Server-side twin of FrontEnd/src/utils/cawUrl.ts. Kept duplicated
// rather than imported because the FE and API live in separate module
// systems (FE = bundler-resolved aliases; API = tsc emit). When you
// change one, change the other — they MUST produce identical slugs or
// canonical-redirect logic loops between the two sides.

const STOP_WORDS = new Set<string>([
  'the','a','an','and','or','but','of','to','in','on','at','by','for','with',
  'from','as','is','it','be','this','that','these','those','i','you','we',
  'they','he','she','my','your','our','their','am','are','was','were','been',
  'do','does','did','have','has','had','will','would','can','could','should',
  'not','no','so','if','then','than','there','here',
  'el','la','los','las','un','una','unos','unas','de','del','y','o','pero',
  'en','para','por','con','sin','sobre','que','es','son','soy','eres','está',
  'están','muy','más','este','esta','estos','estas','ese','esa','eso','esto',
  'le','les','des','du','et','ou','mais','dans','pour','par','avec','sans',
  'sur','qui','ce','cette','ces','sont','suis','être','plus','très','je','tu',
  'il','elle','nous','vous','ils','elles',
  'o','os','as','do','da','dos','das','é','são','sou','estão','muito','este',
  'esta','estes','estas','esse','essa','isso',
  'lo','i','gli','uno','di','del','della','dei','degli','delle','ma','per',
  'su','sei','più','molto','questo','questa','questi','queste','quello','quella',
  'der','die','das','den','dem','des','ein','eine','einen','eines','einer',
  'und','oder','aber','auf','an','zu','für','mit','ohne','über','von','vom',
  'zum','zur','ist','sind','bin','bist','war','waren','sehr','mehr','ich','du',
  'er','sie','es','wir','ihr','nicht','kein','keine','dies',
  'het','een','of','maar','aan','voor','met','zonder','over','van','dat','die',
  'dit','deze','zijn','ben','was','waren','zeer','meer','jij','hij','zij',
  'wij','jullie','geen',
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
