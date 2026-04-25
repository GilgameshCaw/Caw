// Single source of truth for hashtag/cashtag/mention recognition. Used by:
//   - server-side indexing (tools/hashtags.ts, ElasticsearchService)
//   - the post composer's syntax highlighter (HighlightedTextarea)
//   - feed rendering (ContentWithHashtags)
//   - mute matching (useMutePreferences)
//
// The character class accepts any Unicode letter, digit, mark, or underscore
// so kanji / cyrillic / accented Latin / etc. all work as hashtags. The only
// rejection is "purely numeric" — `#123` or `$45` should render as plain text
// since they're almost always part of a sentence, not a tag.

/** Char class for the body of a hashtag/cashtag/mention. */
export const TAG_CHAR_CLASS = '[\\p{L}\\p{N}\\p{M}_]';

/** Matches `#word` or `$word` runs. Use with `String#matchAll`. */
export const HASHTAG_REGEX = new RegExp(`[#$](${TAG_CHAR_CLASS}+)`, 'gu');

/** Matches `@word` runs. */
export const MENTION_REGEX = new RegExp(`@(${TAG_CHAR_CLASS}+)`, 'gu');

/**
 * True if `body` (the part after `#` / `$` / `@`) is a valid tag — i.e. it
 * contains at least one non-digit character. Pure-digit bodies like `123` are
 * rejected so `#5` and `$100` render as plain text.
 */
export function isValidTagBody(body: string): boolean {
  return body.length > 0 && /[^0-9]/.test(body);
}

/** Convenience: extract valid hashtag/cashtag bodies (lowercased, deduped). */
export function extractHashtagBodies(content: string, maxLen = 100): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of content.matchAll(HASHTAG_REGEX)) {
    const body = m[1].toLowerCase();
    if (!isValidTagBody(body)) continue;
    if (body.length > maxLen) continue;
    if (seen.has(body)) continue;
    seen.add(body);
    out.push(body);
  }
  return out;
}
