-- Make autoTranslate nullable (tri-state: null = unset → default-on, false = explicit opt-out, true = explicit opt-in).
-- Existing false rows are the schema-forced default (the toggle was never surfaced in the UI),
-- NOT genuine opt-outs, so they are reset to null to pick up the new default-on behaviour.
-- Rows that are already true remain true.
ALTER TABLE "User" ALTER COLUMN "autoTranslate" DROP DEFAULT;
ALTER TABLE "User" ALTER COLUMN "autoTranslate" DROP NOT NULL;
UPDATE "User" SET "autoTranslate" = NULL WHERE "autoTranslate" = false;
