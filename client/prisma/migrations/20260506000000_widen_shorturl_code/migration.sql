-- Widen ShortUrl.code from VARCHAR(10) to VARCHAR(16).
--
-- The bulk creator generates a 6-char base62 stem and appends the URL's
-- extension verbatim (.gif/.jpg/.png/.mp4/.mov + .jpeg/.webm). The
-- 5-char extensions (.jpeg, .webm) overflowed the original 10-char
-- column and POST /api/shorturl/bulk returned 500 with no entry in
-- the response — silently degrading any post that included one.
-- Surfaced when MediaRecorder client-side transcoding started
-- producing .webm output (it was a latent bug; old phone-shot
-- mp4/mov inputs always fit).
--
-- 16 leaves headroom for any future extension up to 9 chars, which is
-- well past anything we'd preserve. Code paths still cap the stem at 6.
ALTER TABLE "ShortUrl"
  ALTER COLUMN "code" TYPE VARCHAR(16);
