-- Migration to switch from plaintext to encrypted message storage
-- WARNING: This will preserve existing messages but mark them as requiring encryption

-- First, add the new columns
ALTER TABLE "Message"
ADD COLUMN IF NOT EXISTS "encryptedPayload" TEXT,
ADD COLUMN IF NOT EXISTS "messageTopic" TEXT;

-- Copy existing content to encryptedPayload temporarily (will need client-side encryption)
-- Mark these as needing encryption with a special prefix
UPDATE "Message"
SET "encryptedPayload" = CONCAT('NEEDS_ENCRYPTION:', "content")
WHERE "encryptedPayload" IS NULL AND "content" IS NOT NULL;

-- Drop the old content column (commented out for safety - run manually after verification)
-- ALTER TABLE "Message" DROP COLUMN "content";

-- Note: After this migration:
-- 1. All new messages MUST store encrypted payloads only
-- 2. Existing messages need client-side migration to proper encryption
-- 3. The backend should NEVER decrypt or access plaintext content