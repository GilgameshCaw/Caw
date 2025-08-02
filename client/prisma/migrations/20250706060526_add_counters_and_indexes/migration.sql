-- AlterTable
ALTER TABLE "Caw" ADD COLUMN     "commentCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "recawCount" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "Caw_originalCawId_idx" ON "Caw"("originalCawId");

-- CreateIndex
CREATE INDEX "Like_cawId_idx" ON "Like"("cawId");
