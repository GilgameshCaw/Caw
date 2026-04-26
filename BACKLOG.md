# Backlog

## UX

- **Ensure supporting other languages.** Audit text rendering, input handling, and storage end-to-end for non-Latin scripts (CJK, Cyrillic, Arabic, accented Latin, etc.). Hashtag recognition is already Unicode-aware (`tools/hashtagRegex.ts`). Still to verify: post composer length counting (bytes vs codepoints vs grapheme clusters), search/Elasticsearch analyzers, RTL layout for Arabic/Hebrew, font fallback in feed items, mute-word matching across scripts, username display in places that still use system fonts.
