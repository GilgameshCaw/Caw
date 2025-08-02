/*
  Warnings:

  - A unique constraint covering the columns `[tokenId]` on the table `User` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `cawonce` to the `Caw` table without a default value. This is not possible if the table is not empty.
  - Added the required column `senderId` to the `TxQueue` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Caw" ADD COLUMN     "cawonce" INTEGER NOT NULL;

-- AlterTable
ALTER TABLE "TxQueue" ADD COLUMN     "senderId" INTEGER NOT NULL;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "cawCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "followerCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "followingCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "image" TEXT,
ADD COLUMN     "likeCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "tokenId" INTEGER,
ADD COLUMN     "username" TEXT;

-- CreateIndex
CREATE INDEX "TxQueue_senderId_status_idx" ON "TxQueue"("senderId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "User_tokenId_key" ON "User"("tokenId");
