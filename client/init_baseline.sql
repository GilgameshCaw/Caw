-- CreateEnum
CREATE TYPE "ActionType" AS ENUM ('CAW', 'LIKE', 'UNLIKE', 'RECAW', 'FOLLOW', 'UNFOLLOW', 'WITHDRAW', 'OTHER');

-- CreateTable
CREATE TABLE "RawEvent" (
    "id" SERIAL NOT NULL,
    "chainId" INTEGER NOT NULL,
    "blockNumber" BIGINT NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "transactionHash" TEXT NOT NULL,
    "parentHash" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "topics" JSONB NOT NULL,
    "contractAddress" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RawEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" SERIAL NOT NULL,
    "address" TEXT NOT NULL,
    "tokenId" INTEGER NOT NULL,
    "username" TEXT NOT NULL,
    "image" TEXT,
    "cawCount" INTEGER NOT NULL DEFAULT 0,
    "followerCount" INTEGER NOT NULL DEFAULT 0,
    "followingCount" INTEGER NOT NULL DEFAULT 0,
    "likeCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "bio" TEXT,
    "displayName" TEXT,
    "location" TEXT,
    "website" TEXT,
    "avatarUrl" TEXT,
    "coverPhotoUrl" TEXT,
    "profileUpdatePending" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Caw" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "action" "ActionType" NOT NULL,
    "originalCawId" INTEGER,
    "cawonce" INTEGER NOT NULL,
    "imageData" TEXT,
    "hasImage" BOOLEAN NOT NULL DEFAULT false,
    "videoData" TEXT,
    "hasVideo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "commentCount" INTEGER NOT NULL DEFAULT 0,
    "recawCount" INTEGER NOT NULL DEFAULT 0,
    "likeCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Caw_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Like" (
    "userId" INTEGER NOT NULL,
    "cawId" INTEGER NOT NULL,
    "action" "ActionType" NOT NULL,
    "pending" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL
);

-- CreateTable
CREATE TABLE "Follow" (
    "id" SERIAL NOT NULL,
    "followerId" INTEGER NOT NULL,
    "followingId" INTEGER NOT NULL,
    "action" "ActionType" NOT NULL DEFAULT 'FOLLOW',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Follow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TxQueue" (
    "id" SERIAL NOT NULL,
    "senderId" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "signedTx" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TxQueue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Action" (
    "id" SERIAL NOT NULL,
    "rawEventId" INTEGER NOT NULL,
    "chainId" INTEGER NOT NULL,
    "senderId" INTEGER NOT NULL,
    "cawonce" INTEGER NOT NULL,
    "actionType" "ActionType" NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Action_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Hashtag" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Hashtag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CawHashtag" (
    "id" SERIAL NOT NULL,
    "cawId" INTEGER NOT NULL,
    "hashtagId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CawHashtag_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RawEvent_blockNumber_logIndex_transactionHash_key" ON "RawEvent"("blockNumber", "logIndex", "transactionHash");

-- CreateIndex
CREATE UNIQUE INDEX "User_tokenId_key" ON "User"("tokenId");

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE INDEX "Caw_userId_action_createdAt_idx" ON "Caw"("userId", "action", "createdAt");

-- CreateIndex
CREATE INDEX "Caw_originalCawId_idx" ON "Caw"("originalCawId");

-- CreateIndex
CREATE UNIQUE INDEX "Caw_userId_cawonce_key" ON "Caw"("userId", "cawonce");

-- CreateIndex
CREATE INDEX "Like_cawId_idx" ON "Like"("cawId");

-- CreateIndex
CREATE UNIQUE INDEX "Like_userId_cawId_key" ON "Like"("userId", "cawId");

-- CreateIndex
CREATE UNIQUE INDEX "Follow_followerId_followingId_key" ON "Follow"("followerId", "followingId");

-- CreateIndex
CREATE INDEX "TxQueue_senderId_status_idx" ON "TxQueue"("senderId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "TxQueue_signedTx_key" ON "TxQueue"("signedTx");

-- CreateIndex
CREATE UNIQUE INDEX "Action_chainId_senderId_cawonce_key" ON "Action"("chainId", "senderId", "cawonce");

-- CreateIndex
CREATE UNIQUE INDEX "Hashtag_name_key" ON "Hashtag"("name");

-- CreateIndex
CREATE INDEX "Hashtag_name_idx" ON "Hashtag"("name");

-- CreateIndex
CREATE INDEX "Hashtag_usageCount_idx" ON "Hashtag"("usageCount");

-- CreateIndex
CREATE INDEX "CawHashtag_hashtagId_idx" ON "CawHashtag"("hashtagId");

-- CreateIndex
CREATE INDEX "CawHashtag_cawId_idx" ON "CawHashtag"("cawId");

-- CreateIndex
CREATE UNIQUE INDEX "CawHashtag_cawId_hashtagId_key" ON "CawHashtag"("cawId", "hashtagId");

-- AddForeignKey
ALTER TABLE "Caw" ADD CONSTRAINT "Caw_originalCawId_fkey" FOREIGN KEY ("originalCawId") REFERENCES "Caw"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Caw" ADD CONSTRAINT "Caw_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("tokenId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Like" ADD CONSTRAINT "Like_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("tokenId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Like" ADD CONSTRAINT "Like_cawId_fkey" FOREIGN KEY ("cawId") REFERENCES "Caw"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Follow" ADD CONSTRAINT "Follow_followerId_fkey" FOREIGN KEY ("followerId") REFERENCES "User"("tokenId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Follow" ADD CONSTRAINT "Follow_followingId_fkey" FOREIGN KEY ("followingId") REFERENCES "User"("tokenId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Action" ADD CONSTRAINT "Action_rawEventId_fkey" FOREIGN KEY ("rawEventId") REFERENCES "RawEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CawHashtag" ADD CONSTRAINT "CawHashtag_cawId_fkey" FOREIGN KEY ("cawId") REFERENCES "Caw"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CawHashtag" ADD CONSTRAINT "CawHashtag_hashtagId_fkey" FOREIGN KEY ("hashtagId") REFERENCES "Hashtag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

