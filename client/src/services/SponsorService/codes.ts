/**
 * Sponsor code generation and hashing utilities.
 *
 * Two tiers:
 *   Tier 1 ("short") — 24-bit entropy, human-readable: URUK-LAUNCH-7K2
 *   Tier 2 ("long")  — 128-bit entropy, machine-generated: CAWS-XXXX-XXXX-...
 *
 * Both tiers use HMAC-SHA256(SPONSOR_CODE_HMAC_SECRET, normalizedCode) as the
 * stored key.  The raw code is never written to the database.
 * Normalized form = uppercase + dashes stripped.
 */

import crypto from 'crypto'

// ─── HMAC helper ─────────────────────────────────────────────────────────────

/**
 * Normalize a raw code to the canonical form used for hashing.
 * Uppercase + strip all dash characters.
 */
export function normalizeCode(raw: string): string {
  return raw.toUpperCase().replace(/-/g, '')
}

/**
 * Compute HMAC-SHA256(SPONSOR_CODE_HMAC_SECRET, normalizedCode).
 * This is the value stored as `SponsorCode.codeHash` for both tiers.
 *
 * Throws if SPONSOR_CODE_HMAC_SECRET is not set (startup guard in
 * getSponsorService already enforces this when SPONSOR_ENABLED=1).
 */
export function hashCode(raw: string): string {
  const secret = process.env.SPONSOR_CODE_HMAC_SECRET
  if (!secret) {
    throw new Error('SPONSOR_CODE_HMAC_SECRET is not set')
  }
  const normalized = normalizeCode(raw)
  return crypto.createHmac('sha256', secret).update(normalized).digest('hex')
}

// ─── Tier 1: short pretty codes ──────────────────────────────────────────────
//
// Format: WORD-WORD-NNN  (two dictionary words + 3 random digits).
// ~256 × 256 × 1000 ≈ 65 million unique codes — well above any realistic
// issuance. Per-code rate limiting (1/hour) and the global circuit breaker
// make online enumeration of the 24-bit space infeasible.

const WORD_LIST: readonly string[] = [
  'URUK', 'CLAW', 'DAWN', 'FLUX', 'GALE', 'HELM', 'IRIS', 'JADE',
  'KITE', 'LARK', 'MIST', 'NODE', 'OPAL', 'PEAK', 'QUID', 'REEF',
  'SAGE', 'TIDE', 'UNIT', 'VALE', 'WAKE', 'XBOX', 'YARN', 'ZEAL',
  'APEX', 'BOLT', 'CORE', 'DUSK', 'ECHO', 'FERN', 'GOLD', 'HAZE',
  'ICON', 'JEST', 'KEEN', 'LIME', 'MOON', 'NOVA', 'ONYX', 'PINE',
  'QUEST', 'RAIN', 'SNOW', 'TUSK', 'ULNA', 'VOLT', 'WIND', 'XENON',
  'YEAR', 'ZONE', 'ARCH', 'BEAR', 'COAL', 'DOVE', 'EARL', 'FOAM',
  'GLOW', 'HULL', 'ISLE', 'JUMP', 'KELP', 'LEAF', 'MARK', 'NEON',
  'OVAL', 'PACT', 'QUIZ', 'ROCK', 'SILK', 'TEAL', 'UNDO', 'VEIL',
  'WAVE', 'XRAY', 'YAK', 'ZIP', 'ATOM', 'BRIM', 'CROW', 'DRUM',
  'EDGE', 'FIST', 'GRIP', 'HAWK', 'IRON', 'JOLT', 'KNOT', 'LOOM',
  'MANE', 'NAIL', 'ORBS', 'PALM', 'QUAY', 'RUST', 'SLAB', 'TURF',
  'VENT', 'WARP', 'AXIS', 'BARN', 'CLAM', 'DENT', 'EPIC', 'FAWN',
  'GUST', 'HORN', 'INCA', 'JOULE', 'KNOB', 'LENS', 'MULE', 'NAVY',
  'ORCA', 'POND', 'QUILL', 'ROOK', 'STEM', 'THORN', 'USHER', 'VERB',
  'WASP', 'YOLK', 'ZEST', 'ACME', 'BLOT', 'CHAP', 'DUAL', 'EMIT',
  'FAZE', 'GRIN', 'HIKE', 'INKS', 'JIBE', 'KNAP', 'LACE', 'MADE',
  'NORM', 'OVEN', 'PYRE', 'RASP', 'SEAL', 'TUFT', 'URGE', 'VOID',
  'WELD', 'EXEC', 'YAW', 'ZOOM', 'ALBA', 'BURN', 'CITE', 'DOME',
  'EACH', 'FIFE', 'GALE', 'HEMP', 'INTO', 'JAIL', 'KIND', 'LAUD',
  'MESH', 'NOOK', 'OATH', 'PORE', 'RAMP', 'SHED', 'TOME', 'UNTO',
  'VAIN', 'WORD', 'EXPO', 'ZERO', 'ARCH', 'BARK', 'CORD', 'DISC',
  'EARL', 'FORK', 'GUST', 'HUSK', 'ISLE', 'JINX', 'KEEL', 'LACK',
  'MAUL', 'NUMB', 'OUZO', 'PANE', 'RIME', 'STUB', 'TANK', 'UPON',
  'VERB', 'WHIP', 'XERX', 'YORE', 'ZEAL', 'AURA', 'BALE', 'CAMP',
  'DIKE', 'ENVY', 'FORD', 'GILL', 'HEAP', 'ITCH', 'JUNK', 'KILN',
  'LIEN', 'MUTT', 'NAPE', 'OGRE', 'PAVE', 'RAID', 'SERF', 'TIPI',
  'UGLY', 'VALE', 'WREN', 'XENO', 'YELL', 'ZERO', 'AMEN', 'BUFF',
  'CLOT', 'DRAB', 'ELAN', 'FLAB', 'GNAW', 'HUMP', 'IDEA', 'JINK',
  'KNIT', 'LAWN', 'MOAT', 'NULL', 'ODOR', 'PLOY', 'RIND', 'SNAG',
  'TWIG', 'URSA', 'VOWS', 'WAYS', 'XACT', 'YEWS', 'ZING', 'AEON',
  'BLIP', 'CHAT', 'DOJO', 'ENVY', 'FEND', 'GLIB', 'HYMN', 'IBEX',
]

function randomWord(): string {
  const idx = crypto.randomInt(0, WORD_LIST.length)
  return WORD_LIST[idx]
}

function randomDigits(n: number): string {
  let result = ''
  for (let i = 0; i < n; i++) {
    result += crypto.randomInt(0, 10).toString()
  }
  return result
}

/**
 * Generate a Tier 1 short code.
 * Example: URUK-LAUNCH-7K2
 * The third segment is 2 digits + 1 uppercase letter for visual variety.
 */
export function generateShortCode(): string {
  const w1 = randomWord()
  const w2 = randomWord()
  // 2 digits + 1 letter gives ~26 × 100 = 2600 combos for the suffix,
  // keeping the overall code short while adding non-digit chars.
  const digits = randomDigits(2)
  const letter = String.fromCharCode(65 + crypto.randomInt(0, 26))
  return `${w1}-${w2}-${digits}${letter}`
}

// ─── Tier 2: long random codes ────────────────────────────────────────────────
//
// Format: CAWS-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX
// 16 random bytes → base32 (no padding) → split into 6 groups of ~4 chars.
// RFC 4648 base32 alphabet: A-Z + 2-7.

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

function toBase32(buf: Buffer): string {
  let bits = 0
  let value = 0
  let output = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f]
      bits -= 5
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f]
  }
  return output
}

/**
 * Generate a Tier 2 long code.
 * Example: CAWS-ABCD-EFGH-IJKL-MNOP-QRST-UVWX
 * 16 random bytes = 128 bits of entropy, base32-encoded = 26 chars,
 * split into 6 groups of 4-5 chars for readability.
 */
export function generateLongCode(): string {
  const buf = crypto.randomBytes(16)
  const encoded = toBase32(buf)  // 26 chars
  // Split into groups of 4 chars: 6 groups + 2 leftover → make it 4+4+4+4+4+4+2
  // or pad to 28 chars for 7 even groups. We'll do 4-char groups, dropping to
  // whatever fits. With 26 chars we get 6×4 + 2 leftover; pad to 28 for 7 groups.
  const padded = encoded.padEnd(28, '0')
  const groups: string[] = []
  for (let i = 0; i < 28; i += 4) {
    groups.push(padded.slice(i, i + 4))
  }
  return `CAWS-${groups.join('-')}`
}
