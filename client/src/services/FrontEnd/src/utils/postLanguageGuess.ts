import { detectScript } from './translate'

// Parts of a post that say nothing about the language it is written in: links,
// and @mentions, #hashtags and $cashtags written with ASCII letters.
// A link is its ASCII characters only: Japanese or Chinese text often follows
// one with no space, and it is part of the post.
const NOISE = /https?:\/\/[\x21-\x7E]+|www\.[\x21-\x7E]+|[@#$]\w+/gi
const LATIN_LETTER = /\p{Script=Latin}/u
const ANY_LETTER = /\p{L}/u
const MARK = /\p{M}/u

/**
 * The language to presume for a post from its script, or null when the post is
 * mostly Latin-script text.
 *
 * `detectScript` commits to a script as soon as it sees a few characters of it,
 * and to Japanese on any kana. A post such as "(1/3) テスト" followed by an
 * English paragraph came out as Japanese, so a Japanese viewer was told the post
 * was already in their language: no Translate button, no auto-translate. This
 * keeps the guess when the post is not mostly Latin text by either of two
 * counts, and gives null when it is Latin by both:
 *
 * - letters: the letters that are not Latin are at least as many as the Latin
 *   ones. This keeps a long passage in another script that ends with a few
 *   English sentences;
 * - runs: a Latin word is a run of Latin letters, and a run of letters of any
 *   other script (a Japanese or Chinese phrase, a Korean word) is one run. A
 *   run of another script counts for two Latin words, because a phrase is
 *   longer than a word, and the runs counted that way are at least as many as
 *   the Latin words. This keeps a short sentence with English words in it:
 *   "GitHub の PR を review して merge しました" has more Latin letters than
 *   hiragana, because particles and endings are short, but its runs are not
 *   outnumbered.
 *
 * A combining mark stays in the run of the letter before it. Links and ASCII
 * @mentions, #hashtags and $cashtags are not counted.
 *
 * null is the safe answer here: the Translate button is shown and the
 * provider's own detection decides when it is pressed. A wrong guess hides the
 * button.
 */
export function guessPostLanguage(text: string): string | null {
  const guess = detectScript(text)
  if (!guess) return null
  let latinLetters = 0
  let otherLetters = 0
  let latinWords = 0
  let otherRuns = 0
  let current: 'latin' | 'other' | null = null
  for (const ch of text.replace(NOISE, ' ')) {
    let kind: 'latin' | 'other' | null
    if (LATIN_LETTER.test(ch)) {
      kind = 'latin'
      latinLetters++
    } else if (ANY_LETTER.test(ch)) {
      kind = 'other'
      otherLetters++
    } else {
      // A combining mark belongs to the letter before it: it does not end the run.
      kind = MARK.test(ch) ? current : null
    }
    if (kind !== null && kind !== current) {
      if (kind === 'latin') latinWords++
      else otherRuns++
    }
    current = kind
  }
  return otherLetters >= latinLetters || otherRuns * 2 >= latinWords ? guess : null
}
