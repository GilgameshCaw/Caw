-- Add Hashtag.displayName: original casing as typed by the first author to
-- use this hashtag. Nullable — older rows without it fall back to the
-- canonical lowercase `name` at read time.
ALTER TABLE "Hashtag" ADD COLUMN "displayName" TEXT;
