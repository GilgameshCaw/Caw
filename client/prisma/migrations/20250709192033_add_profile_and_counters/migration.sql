/*
  Warnings:

  - The primary key for the `Like` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `createdAt` on the `Like` table. All the data in the column will be lost.
  - You are about to drop the column `id` on the `Like` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[username]` on the table `User` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `updatedAt` to the `Caw` table without a default value. This is not possible if the table is not empty.
  - Made the column `tokenId` on table `User` required. This step will fail if there are existing NULL values in that column.
  - Made the column `username` on table `User` required. This step will fail if there are existing NULL values in that column.

*/
-- DropForeignKey
ALTER TABLE "Caw" DROP CONSTRAINT "Caw_originalCawId_fkey";

-- AlterTable
ALTER TABLE "Caw" ADD COLUMN     "likeCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL,
ALTER COLUMN "action" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Like" DROP CONSTRAINT "Like_pkey",
DROP COLUMN "createdAt",
DROP COLUMN "id",
ALTER COLUMN "action" DROP DEFAULT;

-- AlterTable
ALTER TABLE "User" ALTER COLUMN "tokenId" SET NOT NULL,
ALTER COLUMN "username" SET NOT NULL;

-- CreateIndex
CREATE INDEX "Caw_userId_createdAt_idx" ON "Caw"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE INDEX "User_username_idx" ON "User"("username");
