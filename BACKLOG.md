# Backlog

## UX

- **Ensure supporting other languages.** Audit text rendering, input handling, and storage end-to-end for non-Latin scripts (CJK, Cyrillic, Arabic, accented Latin, etc.). Hashtag recognition is already Unicode-aware (`tools/hashtagRegex.ts`). Still to verify: post composer length counting (bytes vs codepoints vs grapheme clusters), search/Elasticsearch analyzers, RTL layout for Arabic/Hebrew, font fallback in feed items, mute-word matching across scripts, username display in places that still use system fonts.

## Infrastructure

- **CLI: fix `sudo -u caw -E` HOME bug.** `caw update` runs `sudo -u caw -E yarn install` which preserves `HOME=/root`, breaking yarn's RC lookup with EACCES on `/root/.config/yarn`. Switch `-E` to `-H` (sets HOME to target user's home dir) on every privileged drop in `cli/src/steps/update.js` and any other step that runs commands as the install user.

- **CORS audit: wildcard public-read endpoints, allowlist auth-gated ones.** `/api/shorturl/<code>` is now wildcarded (commit 138776a) but other public-read endpoints aren't. Audit every `/api/*` route and bucket as: (a) public-read (no auth, scrapable data — wildcard CORS), (b) auth-gated (requireAuth, cookies, or any state mutation — origin-allowlist from discovered-instances), or (c) admin-only (no CORS). Likely public-read candidates: `/api/users/by-token`, `/api/users/<username>`, `/api/feed`, `/api/caws/<id>`, `/api/hashtags/*`, `/api/search/*`. Auth-gated: `/api/dm/*`, `/api/auth/*`, `/api/upload/*`, `/api/users/me`, `/api/notifications/*`, `/api/bookmarks`. Never set `Access-Control-Allow-Credentials: true` with a `*` origin. Cross-node mirroring won't fully work (e.g. a feed rendering content from another node) until the public-read set has CORS.
