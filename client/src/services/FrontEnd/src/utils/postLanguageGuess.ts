import { detectScript } from './translate'

// Parts of a post that say nothing about the language it is written in: links,
// and @mentions, #hashtags and $cashtags written with ASCII letters.
// A link is its ASCII characters only: Japanese or Chinese text often follows
// one with no space, and it is part of the post.
const NOISE = /https?:\/\/[\x21-\x7E]+|www\.[\x21-\x7E]+|[@#$]\w+/gi
const LATIN_LETTER = /\p{Script=Latin}/u
const ANY_LETTER = /\p{L}/u

/**
 * The language to presume for a post from its script, or null when the post is
 * mostly Latin-script text.
 *
 * `detectScript` commits to a script as soon as it sees a few characters of it,
 * and to Japanese on any kana. A post such as "(1/3) テスト" followed by an
 * English paragraph came out as Japanese, so a Japanese viewer was told the post
 * was already in their language: no Translate button, no auto-translate. This
 * keeps the guess only when the letters that are not Latin are at least half of
 * the letters of the post (links and ASCII @mentions, #hashtags and $cashtags
 * not counted).
 *
 * null is the safe answer here: the Translate button is shown and the
 * provider's own detection decides when it is pressed. A wrong guess hides the
 * button.
 */
export function guessPostLanguage(text: string): string | null {
  const guess = detectScript(text)
  if (!guess) return null
  let latin = 0
  let other = 0
  for (const ch of text.replace(NOISE, ' ')) {
    if (LATIN_LETTER.test(ch)) latin++
    else if (ANY_LETTER.test(ch)) other++
  }
  return other >= latin ? guess : null
}
