-- Per-user language preferences (UI translation half lands later; this
-- column is consumed today by the post auto-translate flow):
--   preferredLanguage: BCP-47 primary subtag (e.g. "en", "es", "ja").
--     Nullable = "follow the browser locale" (today's behavior).
--   autoTranslate:     when true, FeedItem auto-runs translateText on
--     posts whose detected source language differs from preferredLanguage.
--
-- Caw.sourceLanguage is populated lazily by the FE the first time a viewer
-- successfully translates a post (the gtx response carries the detected
-- source). Nullable = "not yet detected" — FE always shows the manual
-- Translate button in that case so a single user can populate it for the
-- rest of the audience.
ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "preferredLanguage" TEXT,
  ADD COLUMN IF NOT EXISTS "autoTranslate"     BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Caw"
  ADD COLUMN IF NOT EXISTS "sourceLanguage" TEXT;
