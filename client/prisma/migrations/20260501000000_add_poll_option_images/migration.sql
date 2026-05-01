-- Optional per-option image URLs on a Poll. Positional, parallel to
-- Poll.options (slot i in optionImages corresponds to slot i in options).
-- Empty string in slot i = no image for that option. Default empty array
-- so existing rows stay valid without backfill.

ALTER TABLE "Poll"
  ADD COLUMN IF NOT EXISTS "optionImages" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
