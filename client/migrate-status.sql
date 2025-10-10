-- Add CawStatus enum
DO $$ BEGIN
    CREATE TYPE "CawStatus" AS ENUM ('SUCCESS', 'PENDING', 'FAILED');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Add status column with default SUCCESS
ALTER TABLE "Caw" ADD COLUMN IF NOT EXISTS "status" "CawStatus" DEFAULT 'SUCCESS';

-- Migrate existing pending data to status field
UPDATE "Caw"
SET "status" = CASE
    WHEN "pending" = true THEN 'PENDING'::"CawStatus"
    ELSE 'SUCCESS'::"CawStatus"
END;

-- Create index on status and userId
CREATE INDEX IF NOT EXISTS "Caw_status_userId_idx" ON "Caw"("status", "userId");

-- Drop the old pending column (optional - can do this later)
-- ALTER TABLE "Caw" DROP COLUMN "pending";