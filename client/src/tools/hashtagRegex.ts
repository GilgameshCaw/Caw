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

// Sigil character classes accept the ASCII forms (`#`, `$`, `@`) and their
// fullwidth CJK counterparts (`＃` U+FF03, `＄` U+FF04, `＠` U+FF20). Japanese,
// Chinese, and Korean keyboards default to fullwidth in many input modes;
// without these, a Japanese user typing `＃ハッシュ` got plain text instead of a
// hashtag. We normalize sigils to ASCII at extract time so storage and lookup
// stay in one form.
export const HASHTAG_SIGIL_CLASS = '[#$\\uFF03\\uFF04]';
export const MENTION_SIGIL_CLASS = '[@\\uFF20]';

/** Matches `#word` / `$word` runs (incl. fullwidth ＃ ＄). Use with `String#matchAll`. */
export const HASHTAG_REGEX = new RegExp(`${HASHTAG_SIGIL_CLASS}(${TAG_CHAR_CLASS}+)`, 'gu');

/** Matches `@word` runs (incl. fullwidth ＠). */
export const MENTION_REGEX = new RegExp(`${MENTION_SIGIL_CLASS}(${TAG_CHAR_CLASS}+)`, 'gu');

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

/**
 * Like extractHashtagBodies but also returns the original casing of each
 * tag's first occurrence in the text. The lowercased `name` is the canonical
 * lookup key; `displayName` is what the *first* author typed and is what
 * read paths render. Multiple casings of the same tag in one post collapse
 * to the first occurrence.
 */
export function extractHashtagBodiesWithDisplay(
  content: string,
  maxLen = 100,
): Array<{ name: string; displayName: string }> {
  const out: Array<{ name: string; displayName: string }> = [];
  const seen = new Set<string>();
  for (const m of content.matchAll(HASHTAG_REGEX)) {
    const original = m[1];
    const body = original.toLowerCase();
    if (!isValidTagBody(body)) continue;
    if (body.length > maxLen) continue;
    if (seen.has(body)) continue;
    seen.add(body);
    out.push({ name: body, displayName: original });
  }
  return out;
}
