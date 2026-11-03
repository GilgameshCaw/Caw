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
 * http(s) URLs, with the same shape the composer highlighter and the feed
 * renderer use (HighlightedTextarea, ContentWithHashtags): up to the next
 * whitespace or quote/bracket, without trailing sentence punctuation.
 */
const URL_REGEX_SOURCE = 'https?:\\/\\/[^\\s<>"\'{}|\\\\^`\\[\\]]+[^\\s<>"\'{}|\\\\^`\\[\\].,!?;:)\\]]';

/**
 * Short links the feed renders as one piece (`/s/abc`, `https://host/s/abc`);
 * the feed tries this alternative before a tag or a URL.
 */
const SHORT_URL_REGEX_SOURCE = '(?:https?:\\/\\/[^\\s]+)?\\/s\\/[a-zA-Z0-9]+(?:\\.[a-zA-Z0-9]+)?';

/**
 * Short links, mentions, URLs and tags in one left-to-right pass, the way the
 * feed splits a post: whichever starts first wins. Group 1 is a mention.
 * `@https://x.com/a#b` is the mention `@https`; the `@bob` in
 * `$x1https://medium.com/@bob/a.b` is a mention (the tag `$x1https` comes
 * first); the `@name` inside https://www.youtube.com/@name is part of a link.
 */
const MENTION_OR_URL_REGEX = new RegExp(
  `${SHORT_URL_REGEX_SOURCE}|(${MENTION_SIGIL_CLASS}${TAG_CHAR_CLASS}+)|${URL_REGEX_SOURCE}|${HASHTAG_SIGIL_CLASS}${TAG_CHAR_CLASS}+`,
  'gu',
);

/**
 * The names that `@name` mentions in `content` refer to, in order of
 * appearance, as the feed draws them. A name is the ASCII word characters
 * after an ASCII `@` (so `@zinsanjpさん` is `zinsanjp`); not deduplicated.
 */
export function extractMentionNames(content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(MENTION_OR_URL_REGEX)) {
    if (m[1] === undefined) continue;
    const name = /^@(\w+)/.exec(m[1]);
    if (name) out.push(name[1]);
  }
  return out;
}

/**
 * Mentions, URLs and tags in one left-to-right pass, as the renderer does it:
 * a URL is one piece (its `#fragment` is not a tag on screen), a mention is
 * taken first wherever it starts (so `@https://x.com/a#b` is the mention
 * `@https` and then plain text, as on screen), and a tag is read from wherever
 * it starts. Group 1 is the tag body; it is undefined for a mention or a URL.
 */
const TAG_OR_URL_REGEX = new RegExp(
  `${MENTION_SIGIL_CLASS}${TAG_CHAR_CLASS}+|${URL_REGEX_SOURCE}|${HASHTAG_SIGIL_CLASS}(${TAG_CHAR_CLASS}+)`,
  'gu',
);

/** The tag bodies of `content` in order of appearance (not yet validated or lowercased); a mention or a URL contributes none. */
function tagBodies(content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(TAG_OR_URL_REGEX)) {
    if (m[1] !== undefined) out.push(m[1]);
  }
  return out;
}

/**
 * True if `body` (the part after `#` / `$` / `@`) is a valid tag — i.e. it
 * contains at least one non-digit character. Pure-digit bodies like `123` are
 * rejected so `#5` and `$100` render as plain text.
 */
export function isValidTagBody(body: string): boolean {
  return body.length > 0 && /[^0-9]/.test(body);
}

/** Convenience: extract valid hashtag/cashtag bodies (lowercased, deduped). A URL's `#fragment` is not a tag. */
export function extractHashtagBodies(content: string, maxLen = 100): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const original of tagBodies(content)) {
    const body = original.toLowerCase();
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
  for (const original of tagBodies(content)) {
    const body = original.toLowerCase();
    if (!isValidTagBody(body)) continue;
    if (body.length > maxLen) continue;
    if (seen.has(body)) continue;
    seen.add(body);
    out.push({ name: body, displayName: original });
  }
  return out;
}
