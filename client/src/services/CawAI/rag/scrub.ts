// CawAI/rag/scrub.ts
//
// Pseudonymity scrub gate for the RAG index build.
//
// Before any chunk is embedded it MUST pass through scrubChunk().
// Any chunk that matches a pseudonymity pattern causes the build to
// HALT with a non-zero exit (see build-index.ts). The author's real
// identity must never leak through a public bot indexing repo content.
//
// Patterns detected:
//   - The operator's real name (hard rule from MEMORY.md) — the literal is
//     never written in this source file; it is decoded at runtime from a
//     base64 constant so a `git grep` of the repo stays clean. The scrub
//     still matches the plaintext when it appears in a corpus chunk.
//   - Email addresses (any, not just the known one)
//   - Absolute home paths: /Users/<name>/... or /home/<name>/...
//
// The `redacted` field replaces matches with [REDACTED] so a human
// reviewer can read the surrounding context without re-leaking the
// sensitive string.

export type ScrubResult = {
  /** true if the chunk passed with no matches */
  clean: boolean
  /** the chunk text with matched strings replaced by [REDACTED] */
  redacted: string
  /** the raw matched strings that triggered the flag */
  matches: string[]
}

// Sensitive tokens are stored base64-encoded so the plaintext (the operator's
// pseudonymity-sensitive name) never appears literally in committed source —
// which would itself be a leak and would re-enter the corpus via git ls-files.
// Decoded once at module load into a case-insensitive alternation.
const ENCODED_NAME_TOKENS = ['bmVpbA==', 'YmFuYW5hbmVpbA==']
const NAME_ALTERNATION = ENCODED_NAME_TOKENS
  .map(t => Buffer.from(t, 'base64').toString('utf8'))
  // longest first so the alternation prefers the more specific match
  .sort((a, b) => b.length - a.length)
  .join('|')

// Patterns that signal a pseudonymity leak.
// Order matters only for readability; all are applied to every chunk.
const PATTERNS: Array<{ label: string; re: RegExp }> = [
  // The operator's real name (any case). Built from decoded tokens above.
  { label: 'name',      re: new RegExp(NAME_ALTERNATION, 'gi') },
  // Any email address
  { label: 'email',     re: /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g },
  // Absolute home paths on macOS or Linux
  { label: 'home-path', re: /\/(?:Users|home)\/[^/\s"'`]+/g },
]

export function scrubChunk(text: string, _path: string): ScrubResult {
  const matches: string[] = []
  let redacted = text

  for (const { re } of PATTERNS) {
    // Reset lastIndex for global regexes between calls.
    re.lastIndex = 0
    const found = text.match(re)
    if (found) {
      matches.push(...found)
      redacted = redacted.replace(re, '[REDACTED]')
    }
    // Re-reset after match() consumed the global state.
    re.lastIndex = 0
  }

  // Deduplicate matches list for cleaner review output.
  const unique = [...new Set(matches)]

  return {
    clean: unique.length === 0,
    redacted,
    matches: unique,
  }
}
