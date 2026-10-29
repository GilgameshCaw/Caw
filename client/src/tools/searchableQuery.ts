// GET /api/search rejects queries shorter than two characters: one letter or
// digit matches too much to be a useful search. In Japanese and Chinese a
// single ideograph is a whole word (猫, 酒, 愛), so such a query is allowed.
// Hiragana and katakana are not: a single kana is a particle or a syllable
// and matches nearly everything.

// Exactly one CJK ideograph in the Basic Multilingual Plane: extension A
// (U+3400-4DBF), the unified ideographs (U+4E00-9FFF) and the compatibility
// ideographs (U+F900-FAFF). U+4DC0-4DFF, the Yijing hexagram symbols that sit
// between the first two blocks, are not ideographs and are left out. An
// ideograph outside the BMP is two UTF-16 units, so it already passes the
// length rule below and needs no entry here.
const SINGLE_IDEOGRAPH_REGEX = /^[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]$/

export function isSearchableQuery(raw: string): boolean {
  const q = raw.trim()
  return q.length >= 2 || SINGLE_IDEOGRAPH_REGEX.test(q)
}
