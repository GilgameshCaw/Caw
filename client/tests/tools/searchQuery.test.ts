import { expect } from 'chai'
import { buildSearchQuery, hasSingleCharTokens } from '../../src/tools/searchQuery'

// The standard analyzer indexes hiragana and ideographs one character per
// token, so a multi_match (OR) for "ふじこふじこ" matches every document with
// any of those characters. For queries with such characters the builder
// switches to match_phrase; every other query must keep the earlier query.

describe('hasSingleCharTokens', () => {
  it('is true when the text has hiragana or ideographs (kanji, hanzi)', () => {
    for (const q of ['うまくいった', '予約投稿', '我们的社交网络', '我們的社交網路', 'xyzzy投稿', 'CAWの話', 'チャンク境界', '𠮷野家']) {
      expect(hasSingleCharTokens(q), q).to.equal(true)
    }
  })

  it('is true for ideographs outside the BMP on their own (two UTF-16 units each)', () => {
    for (const q of ['𠮷', '𠮷𠮷', '\u{20000}', '\u{2fa1f}']) {
      expect(hasSingleCharTokens(q), q).to.equal(true)
    }
  })

  it('is true for the ideographic zero, which the analyzer also splits per character', () => {
    for (const q of ['〇', '〇〇', '一〇〇']) expect(hasSingleCharTokens(q), q).to.equal(true)
  })

  it('covers the first and last code point of each range and not the ones just outside', () => {
    const inside = ['\u3007', '\u3040', '\u309f', '\u3400', '\u4dbf', '\u4e00', '\u9fff', '\uf900', '\ufaff', '\u{20000}', '\u{2fa1f}']
    // U+3008 (a bracket), U+303F, U+30A0 (just above hiragana), U+33FF, U+4DC0 and U+4DFF (the Yijing
    // hexagram symbols, which the analyzer drops), U+A000, U+FB00, U+1FFFF, U+2FA20
    const outside = ['\u3008', '\u303f', '\u30a0', '\u33ff', '\u4dc0', '\u4dff', '\ua000', '\ufb00', '\u{1ffff}', '\u{2fa20}']
    for (const q of inside) expect(hasSingleCharTokens(q), q.codePointAt(0)!.toString(16)).to.equal(true)
    for (const q of outside) expect(hasSingleCharTokens(q), q.codePointAt(0)!.toString(16)).to.equal(false)
  })

  it('is false for katakana-only, Latin, Hangul, Thai, digits, symbols and the empty string', () => {
    for (const q of ['チャンク', 'チャンクテスト', 'hello world', 'CAW', '#caw', '한국어로 검색', 'ภาษาไทย', '12345', '!?', '', 'ÅÄÖ', 'Привет']) {
      expect(hasSingleCharTokens(q), q).to.equal(false)
    }
  })
})

describe('buildSearchQuery without hiragana or ideographs keeps the earlier queries', () => {
  const q = 'hello world'

  it('caws and all: multi_match over content, names, hashtags and mentions', () => {
    const expected = {
      multi_match: {
        query: q,
        fields: ['content^2', 'username', 'displayName', 'hashtags', 'mentions'],
        type: 'best_fields',
        fuzziness: 'AUTO'
      }
    }
    expect(buildSearchQuery(q, 'caws')).to.deep.equal(expected)
    expect(buildSearchQuery(q, 'all')).to.deep.equal(expected)
  })

  it('hashtags: multi_match over the hashtags field only', () => {
    expect(buildSearchQuery(q, 'hashtags')).to.deep.equal({
      multi_match: { query: q, fields: ['hashtags'], type: 'best_fields', fuzziness: 'AUTO' }
    })
  })

  it('users: fuzzy multi_match plus prefix matches', () => {
    expect(buildSearchQuery('gilg', 'users')).to.deep.equal({
      bool: {
        should: [
          { multi_match: { query: 'gilg', fields: ['username^2', 'displayName', 'bio'], type: 'best_fields', fuzziness: 'AUTO' } },
          { match_phrase_prefix: { username: { query: 'gilg', boost: 3 } } },
          { match_phrase_prefix: { displayName: { query: 'gilg' } } },
        ],
        minimum_should_match: 1
      }
    })
  })

  it('katakana-only, Hangul and Thai queries are not switched', () => {
    for (const hq of ['チャンク', '한국어로', 'ภาษาไทย']) {
      expect(buildSearchQuery(hq, 'caws')).to.have.property('multi_match')
    }
  })
})

describe('buildSearchQuery with hiragana or ideographs', () => {
  const q = '予約投稿'

  // Walk the query and collect [clauseType, field] for the clauses that
  // analyse text field values.
  function clauses(dsl: any): Array<{ kind: string; field: string }> {
    const out: Array<{ kind: string; field: string }> = []
    for (const c of dsl.bool.should) {
      for (const kind of Object.keys(c)) {
        if (kind === 'multi_match') for (const f of c[kind].fields) out.push({ kind, field: f.split('^')[0] })
        else for (const f of Object.keys(c[kind])) out.push({ kind, field: f })
      }
    }
    return out
  }

  it('caws and all: phrase on content and displayName, fuzzy only on keyword fields', () => {
    for (const type of ['caws', 'all'] as const) {
      const dsl = buildSearchQuery(q, type)
      expect(dsl.bool.minimum_should_match).to.equal(1)
      expect(dsl.bool.should[0]).to.deep.equal({ match_phrase: { content: { query: q, boost: 2 } } })
      expect(dsl.bool.should[1]).to.deep.equal({ match_phrase: { displayName: { query: q } } })
      expect(dsl.bool.should[2].multi_match.fields).to.deep.equal(['username', 'hashtags', 'mentions'])
      // No OR match over the analysed text fields.
      const loose = clauses(dsl).filter(c => c.kind === 'multi_match' && (c.field === 'content' || c.field === 'displayName'))
      expect(loose).to.deep.equal([])
    }
  })

  it('users: phrase on displayName and bio, no multi_match over them', () => {
    const dsl = buildSearchQuery(q, 'users')
    expect(dsl.bool.should).to.deep.equal([
      { match_phrase: { displayName: { query: q, boost: 2 } } },
      { match_phrase: { bio: { query: q } } },
      { match_phrase_prefix: { username: { query: q, boost: 3 } } },
    ])
    expect(clauses(dsl).filter(c => c.kind === 'multi_match')).to.deep.equal([])
  })

  it('hashtags keep the keyword-field query', () => {
    expect(buildSearchQuery(q, 'hashtags')).to.deep.equal({
      multi_match: { query: q, fields: ['hashtags'], type: 'best_fields', fuzziness: 'AUTO' }
    })
  })

  it('a query of ideographs outside the BMP is a phrase query, hexagram symbols alone are not', () => {
    expect(buildSearchQuery('𠮷𠮷', 'caws').bool.should[0]).to.deep.equal({ match_phrase: { content: { query: '𠮷𠮷', boost: 2 } } })
    expect(buildSearchQuery('\u4dc0\u4dc1', 'caws')).to.have.property('multi_match')
  })

  it('a mixed Latin and Japanese query is a phrase query too', () => {
    const dsl = buildSearchQuery('xyzzy投稿', 'caws')
    expect(dsl.bool.should[0]).to.deep.equal({ match_phrase: { content: { query: 'xyzzy投稿', boost: 2 } } })
  })
})
