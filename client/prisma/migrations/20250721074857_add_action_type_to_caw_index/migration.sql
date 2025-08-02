-- DropIndex
DROP INDEX "Caw_userId_createdAt_idx";

-- CreateIndex
CREATE INDEX "Caw_userId_action_createdAt_idx" ON "Caw"("userId", "action", "createdAt");
