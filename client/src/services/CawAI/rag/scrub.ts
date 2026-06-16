// CawAI/rag/scrub.ts
//
// Pseudonymity scrub gate for the RAG index build.
//
// Before any chunk is embedded it MUST pass through scrubChunk().
// Any chunk that matches a pseudonymity pattern causes the build to
// HALT with a non-zero exit (see build-index.ts). The author's real
// identity must never leak through a public bot indexing repo content.
//
// What's detected — and what is DELIBERATELY NOT:
//   - The operator's real name (hard rule from MEMORY.md). This is the ONLY
//     pseudonymity leak that matters: the real name, and any string embedding
//     it (e.g. a real-name email or a /Users/<real-name>/ home path, both of
//     which the name pattern catches anyway). The literal is never written in
//     this source file — it is decoded at runtime from a base64 constant so a
//     `git grep` of the repo stays clean. The scrub still matches the plaintext
//     when it appears in a corpus chunk.
//
// NOT flagged (intentionally — these are the pseudonymous identity, not the
// real one, and blocking them only caused false halts on doc placeholders):
//   - Placeholder / pseudonymous emails (user@gmail.com, gilgamesh@…, etc.)
//   - Generic home paths that don't contain the real name
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

// The sole pattern that signals a pseudonymity leak: the operator's real name
// (any case). Built from the decoded base64 tokens above. A real-name email or
// /Users/<real-name>/ path is caught by this same pattern, so no separate
// email/home-path rules are needed (and the broad versions only produced false
// halts on placeholder/pseudonymous values).
const PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: 'name', re: new RegExp(NAME_ALTERNATION, 'gi') },
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
