// Query builder for ElasticsearchService.search().
//
// The caws and users indices analyse text with Elasticsearch's `standard`
// analyzer, which splits hiragana and ideographs (kanji / hanzi) into one
// token per character: "予約投稿" is indexed as 予 / 約 / 投 / 稿. A
// multi_match with the default OR operator therefore matches any document that
// has any one of those characters, so a Japanese or Chinese query returns
// mostly unrelated results, and a phrase nobody has posted still returns a full
// page. The tokens of such a phrase are consecutive in the index, so a
// match_phrase requires them to occur in sequence instead of matching any one
// character; that is what is used when the query contains such characters. The
// match follows the analyzer's tokenization and normalization (spaces and
// punctuation are dropped, Latin is lower-cased), so it is not a literal
// substring match.
//
// Queries without them keep the previous multi_match with fuzziness. That
// includes katakana-only queries (a katakana run stays one token, so it has no
// per-character problem and keeps its fuzzy partial matching) and Hangul (a
// Hangul word is also one token; its separate problem, partial-word search,
// needs another analyzer and a reindex).

export type SearchKind = 'all' | 'users' | 'caws' | 'hashtags'

// Characters the standard analyzer indexes one per token (checked with its
// _analyze output): hiragana (U+3040-309F), the ideographic zero 〇 (U+3007),
// and CJK ideographs: extension A (U+3400-4DBF), unified (U+4E00-9FFF),
// compatibility (U+F900-FAFF) and the supplementary planes (U+20000-2FA1F).
// U+4DC0-4DFF, the Yijing hexagram symbols between extension A and the unified
// block, are not ideographs and the analyzer drops them, so they are left out.
const SINGLE_CHAR_TOKEN_REGEX = /[\u3007\u3040-\u309f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u{20000}-\u{2fa1f}]/u

export function hasSingleCharTokens(text: string): boolean {
  return SINGLE_CHAR_TOKEN_REGEX.test(text)
}

export function buildSearchQuery(query: string, type: SearchKind): any {
  const phrase = hasSingleCharTokens(query)

  if (type === 'users') {
    // Fuzzy full-token matching plus prefix matching, so short queries like
    // "gilg" can find "gilgatwo" (fuzziness alone caps at edit distance 2).
    if (phrase) {
      return {
        bool: {
          should: [
            { match_phrase: { displayName: { query, boost: 2 } } },
            { match_phrase: { bio: { query } } },
            { match_phrase_prefix: { username: { query, boost: 3 } } },
          ],
          minimum_should_match: 1
        }
      }
    }
    return {
      bool: {
        should: [
          { multi_match: { query, fields: ['username^2', 'displayName', 'bio'], type: 'best_fields', fuzziness: 'AUTO' } },
          { match_phrase_prefix: { username: { query, boost: 3 } } },
          { match_phrase_prefix: { displayName: { query } } },
        ],
        minimum_should_match: 1
      }
    }
  }

  if (type === 'hashtags') {
    return {
      multi_match: { query, fields: ['hashtags'], type: 'best_fields', fuzziness: 'AUTO' }
    }
  }

  // 'caws' and 'all'
  if (phrase) {
    return {
      bool: {
        should: [
          { match_phrase: { content: { query, boost: 2 } } },
          { match_phrase: { displayName: { query } } },
          // username, hashtags and mentions are keyword fields (whole values),
          // so fuzziness over them does not split anything into characters.
          { multi_match: { query, fields: ['username', 'hashtags', 'mentions'], type: 'best_fields', fuzziness: 'AUTO' } },
        ],
        minimum_should_match: 1
      }
    }
  }
  return {
    multi_match: {
      query,
      fields: ['content^2', 'username', 'displayName', 'hashtags', 'mentions'],
      type: 'best_fields',
      fuzziness: 'AUTO'
    }
  }
}
