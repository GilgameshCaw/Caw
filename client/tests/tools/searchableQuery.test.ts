import { expect } from 'chai'
import { isSearchableQuery } from '../../src/tools/searchableQuery'

// GET /api/search needs two characters, except for a single ideograph: in
// Japanese and Chinese one character is a word (猫, 酒, 愛).

describe('isSearchableQuery', () => {
  it('accepts a single kanji or hanzi, with or without surrounding whitespace', () => {
    for (const q of ['猫', '酒', '愛', '猫 ', '  猫', '\t投\n', '猫\u3000', '豈']) {
      expect(isSearchableQuery(q), JSON.stringify(q)).to.equal(true)
    }
  })

  it('still accepts anything of two or more characters', () => {
    for (const q of ['ab', '猫猫', '予約', 'あい', 'ab ', '#a', '12']) {
      expect(isSearchableQuery(q), JSON.stringify(q)).to.equal(true)
    }
  })

  it('rejects one letter, digit, kana, Hangul or symbol, and empty input', () => {
    for (const q of ['a', 'Z', '1', 'あ', 'ア', 'ｱ', '한', 'я', '#', '!', '', ' ', '\n', '  a  ']) {
      expect(isSearchableQuery(q), JSON.stringify(q)).to.equal(false)
    }
  })

  it('keeps the earlier UTF-16 length rule for two-unit characters', () => {
    // An emoji and an ideograph outside the BMP are two UTF-16 units, so both
    // passed the old `length < 2` check and still do.
    expect(isSearchableQuery('😀')).to.equal(true)
    expect(isSearchableQuery('𠮷')).to.equal(true)
    expect(isSearchableQuery(' 𠮷 ')).to.equal(true)
  })

  it('accepts the ends of the ideograph ranges and rejects what lies just outside them', () => {
    // extension A, unified ideographs, compatibility ideographs: first and last code point of each
    for (const q of ['\u3400', '\u4dbf', '\u4e00', '\u9fff', '\uf900', '\ufaff']) expect(isSearchableQuery(q), q.codePointAt(0)!.toString(16)).to.equal(true)
    // U+33FF (CJK compatibility block), U+4DC0 and U+4DFF (Yijing hexagram symbols, the ends of
    // the gap between extension A and the unified ideographs), U+A000 (Yi syllables),
    // U+30A2 (katakana), U+FB00 (a ligature)
    for (const q of ['\u33ff', '\u4dc0', '\u4dff', '\ua000', '\u30a2', '\ufb00']) expect(isSearchableQuery(q), q.codePointAt(0)!.toString(16)).to.equal(false)
  })
})
