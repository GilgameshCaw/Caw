-- CreateEnum
CREATE TYPE "ActionType" AS ENUM ('CAW', 'LIKE', 'UNLIKE', 'RECAW', 'FOLLOW', 'UNFOLLOW', 'WITHDRAW', 'OTHER');

-- CreateEnum
CREATE TYPE "CawStatus" AS ENUM ('SUCCESS', 'PENDING', 'FAILED');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('FOLLOW', 'LIKE', 'REPLY', 'REPOST', 'QUOTE', 'MENTION');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('SENT', 'DELIVERED', 'READ', 'FAILED');

-- CreateEnum
CREATE TYPE "ConversationType" AS ENUM ('DM', 'GROUP');

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
    "id" INTEGER NOT NULL,
    "address" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "cawCount" INTEGER NOT NULL DEFAULT 0,
    "followerCount" INTEGER NOT NULL DEFAULT 0,
    "followingCount" INTEGER NOT NULL DEFAULT 0,
    "image" TEXT,
    "likeCount" INTEGER NOT NULL DEFAULT 0,
    "tokenId" INTEGER NOT NULL,
    "username" TEXT NOT NULL,
    "avatarUrl" TEXT,
    "bio" TEXT,
    "coverPhotoUrl" TEXT,
    "displayName" TEXT,
    "location" TEXT,
    "profileUpdatePending" BOOLEAN NOT NULL DEFAULT false,
    "website" TEXT,
    "lastStakedAt" TIMESTAMP(3),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Caw" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "action" "ActionType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "originalCawId" INTEGER,
    "cawonce" INTEGER NOT NULL,
    "commentCount" INTEGER NOT NULL DEFAULT 0,
    "recawCount" INTEGER NOT NULL DEFAULT 0,
    "likeCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "hasImage" BOOLEAN NOT NULL DEFAULT false,
    "hasVideo" BOOLEAN NOT NULL DEFAULT false,
    "imageData" TEXT,
    "status" "CawStatus" NOT NULL DEFAULT 'SUCCESS',
    "videoData" TEXT,
    "viewCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Caw_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Like" (
    "userId" INTEGER NOT NULL,
    "cawId" INTEGER NOT NULL,
    "action" "ActionType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pending" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "id" SERIAL NOT NULL,

    CONSTRAINT "Like_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Follow" (
    "id" SERIAL NOT NULL,
    "followerId" INTEGER NOT NULL,
    "followingId" INTEGER NOT NULL,
    "action" "ActionType" NOT NULL DEFAULT 'FOLLOW',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "status" "CawStatus" NOT NULL DEFAULT 'SUCCESS',

    CONSTRAINT "Follow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TxQueue" (
    "id" SERIAL NOT NULL,
    "payload" JSONB NOT NULL,
    "signedTx" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "senderId" INTEGER NOT NULL,
    "reason" TEXT,

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

-- CreateTable
CREATE TABLE "ScheduledCaw" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "publishedId" INTEGER,
    "imageData" TEXT,
    "hasImage" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "signedAction" JSONB,
    "cawonce" INTEGER,

    CONSTRAINT "ScheduledCaw_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "actorId" INTEGER NOT NULL,
    "type" "NotificationType" NOT NULL,
    "cawId" INTEGER,
    "groupKey" TEXT,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "XmtpIdentity" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "installationId" TEXT NOT NULL,
    "identityKey" TEXT NOT NULL,
    "preKeys" JSONB NOT NULL,
    "signedPreKey" JSONB NOT NULL,
    "registrationId" INTEGER NOT NULL,
    "encryptionKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "XmtpIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "type" "ConversationType" NOT NULL,
    "topic" TEXT NOT NULL,
    "name" TEXT,
    "description" TEXT,
    "avatarUrl" TEXT,
    "creatorId" INTEGER NOT NULL,
    "metadata" JSONB,
    "lastMessageAt" TIMESTAMP(3),
    "lastMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationParticipant" (
    "id" SERIAL NOT NULL,
    "conversationId" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leftAt" TIMESTAMP(3),
    "isAdmin" BOOLEAN NOT NULL DEFAULT false,
    "isMuted" BOOLEAN NOT NULL DEFAULT false,
    "lastReadAt" TIMESTAMP(3),
    "unreadCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ConversationParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "senderId" INTEGER NOT NULL,
    "senderWallet" TEXT,
    "encryptedPayload" TEXT NOT NULL,
    "messageTopic" TEXT,
    "contentType" TEXT NOT NULL DEFAULT 'text',
    "metadata" JSONB,
    "status" "MessageStatus" NOT NULL DEFAULT 'SENT',
    "editedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "parentMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageReceipt" (
    "id" SERIAL NOT NULL,
    "messageId" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "deliveredAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),

    CONSTRAINT "MessageReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WithdrawalRequest" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "amount" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "txHash" TEXT,
    "cawonce" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "WithdrawalRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MutedThread" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "cawId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MutedThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MutedAccount" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "mutedUserId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MutedAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShortUrl" (
    "id" SERIAL NOT NULL,
    "code" VARCHAR(10) NOT NULL,
    "originalUrl" TEXT NOT NULL,
    "title" VARCHAR(255),
    "description" TEXT,
    "imageUrl" TEXT,
    "siteName" VARCHAR(100),
    "clickCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShortUrl_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OnChainImage" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "txQueueId" INTEGER,
    "imageRef" TEXT NOT NULL,
    "cawonce" INTEGER NOT NULL,
    "base64Data" TEXT NOT NULL,
    "status" "CawStatus" NOT NULL DEFAULT 'PENDING',
    "cawCost" INTEGER NOT NULL,
    "reason" TEXT,
    "postedAt" TIMESTAMP(3),
    "ignored" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OnChainImage_pkey" PRIMARY KEY ("id")
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
CREATE INDEX "Caw_status_userId_idx" ON "Caw"("status", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Caw_userId_cawonce_key" ON "Caw"("userId", "cawonce");

-- CreateIndex
CREATE INDEX "Like_cawId_idx" ON "Like"("cawId");

-- CreateIndex
CREATE UNIQUE INDEX "Like_userId_cawId_key" ON "Like"("userId", "cawId");

-- CreateIndex
CREATE INDEX "Follow_followerId_status_idx" ON "Follow"("followerId", "status");

-- CreateIndex
CREATE INDEX "Follow_followingId_status_idx" ON "Follow"("followingId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Follow_followerId_followingId_key" ON "Follow"("followerId", "followingId");

-- CreateIndex
CREATE UNIQUE INDEX "TxQueue_signedTx_key" ON "TxQueue"("signedTx");

-- CreateIndex
CREATE INDEX "TxQueue_senderId_status_idx" ON "TxQueue"("senderId", "status");

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

-- CreateIndex
CREATE INDEX "ScheduledCaw_userId_idx" ON "ScheduledCaw"("userId");

-- CreateIndex
CREATE INDEX "ScheduledCaw_scheduledAt_idx" ON "ScheduledCaw"("scheduledAt");

-- CreateIndex
CREATE INDEX "ScheduledCaw_status_idx" ON "ScheduledCaw"("status");

-- CreateIndex
CREATE INDEX "ScheduledCaw_userId_status_cawonce_idx" ON "ScheduledCaw"("userId", "status", "cawonce");

-- CreateIndex
CREATE INDEX "Notification_userId_isRead_createdAt_idx" ON "Notification"("userId", "isRead", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_userId_type_idx" ON "Notification"("userId", "type");

-- CreateIndex
CREATE INDEX "Notification_groupKey_idx" ON "Notification"("groupKey");

-- CreateIndex
CREATE INDEX "Notification_createdAt_idx" ON "Notification"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "XmtpIdentity_userId_key" ON "XmtpIdentity"("userId");

-- CreateIndex
CREATE INDEX "XmtpIdentity_walletAddress_idx" ON "XmtpIdentity"("walletAddress");

-- CreateIndex
CREATE INDEX "XmtpIdentity_installationId_idx" ON "XmtpIdentity"("installationId");

-- CreateIndex
CREATE INDEX "Conversation_topic_idx" ON "Conversation"("topic");

-- CreateIndex
CREATE INDEX "Conversation_lastMessageAt_idx" ON "Conversation"("lastMessageAt");

-- CreateIndex
CREATE INDEX "Conversation_creatorId_idx" ON "Conversation"("creatorId");

-- CreateIndex
CREATE INDEX "ConversationParticipant_userId_idx" ON "ConversationParticipant"("userId");

-- CreateIndex
CREATE INDEX "ConversationParticipant_conversationId_idx" ON "ConversationParticipant"("conversationId");

-- CreateIndex
CREATE UNIQUE INDEX "ConversationParticipant_conversationId_userId_key" ON "ConversationParticipant"("conversationId", "userId");

-- CreateIndex
CREATE INDEX "Message_conversationId_createdAt_idx" ON "Message"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "Message_senderId_idx" ON "Message"("senderId");

-- CreateIndex
CREATE INDEX "Message_parentMessageId_idx" ON "Message"("parentMessageId");

-- CreateIndex
CREATE INDEX "MessageReceipt_userId_idx" ON "MessageReceipt"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "MessageReceipt_messageId_userId_key" ON "MessageReceipt"("messageId", "userId");

-- CreateIndex
CREATE INDEX "WithdrawalRequest_userId_status_idx" ON "WithdrawalRequest"("userId", "status");

-- CreateIndex
CREATE INDEX "WithdrawalRequest_status_idx" ON "WithdrawalRequest"("status");

-- CreateIndex
CREATE INDEX "WithdrawalRequest_cawonce_idx" ON "WithdrawalRequest"("cawonce");

-- CreateIndex
CREATE INDEX "MutedThread_userId_idx" ON "MutedThread"("userId");

-- CreateIndex
CREATE INDEX "MutedThread_cawId_idx" ON "MutedThread"("cawId");

-- CreateIndex
CREATE UNIQUE INDEX "MutedThread_userId_cawId_key" ON "MutedThread"("userId", "cawId");

-- CreateIndex
CREATE INDEX "MutedAccount_userId_idx" ON "MutedAccount"("userId");

-- CreateIndex
CREATE INDEX "MutedAccount_mutedUserId_idx" ON "MutedAccount"("mutedUserId");

-- CreateIndex
CREATE UNIQUE INDEX "MutedAccount_userId_mutedUserId_key" ON "MutedAccount"("userId", "mutedUserId");

-- CreateIndex
CREATE UNIQUE INDEX "ShortUrl_code_key" ON "ShortUrl"("code");

-- CreateIndex
CREATE INDEX "ShortUrl_code_idx" ON "ShortUrl"("code");

-- CreateIndex
CREATE INDEX "ShortUrl_originalUrl_idx" ON "ShortUrl"("originalUrl");

-- CreateIndex
CREATE UNIQUE INDEX "OnChainImage_imageRef_key" ON "OnChainImage"("imageRef");

-- CreateIndex
CREATE INDEX "OnChainImage_userId_status_idx" ON "OnChainImage"("userId", "status");

-- CreateIndex
CREATE INDEX "OnChainImage_status_idx" ON "OnChainImage"("status");

-- CreateIndex
CREATE INDEX "OnChainImage_createdAt_idx" ON "OnChainImage"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "OnChainImage_userId_cawonce_key" ON "OnChainImage"("userId", "cawonce");

-- AddForeignKey
ALTER TABLE "Caw" ADD CONSTRAINT "Caw_originalCawId_fkey" FOREIGN KEY ("originalCawId") REFERENCES "Caw"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Caw" ADD CONSTRAINT "Caw_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("tokenId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Like" ADD CONSTRAINT "Like_cawId_fkey" FOREIGN KEY ("cawId") REFERENCES "Caw"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Like" ADD CONSTRAINT "Like_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("tokenId") ON DELETE RESTRICT ON UPDATE CASCADE;

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

-- AddForeignKey
ALTER TABLE "ScheduledCaw" ADD CONSTRAINT "ScheduledCaw_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("tokenId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("tokenId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_cawId_fkey" FOREIGN KEY ("cawId") REFERENCES "Caw"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("tokenId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "XmtpIdentity" ADD CONSTRAINT "XmtpIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("tokenId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationParticipant" ADD CONSTRAINT "ConversationParticipant_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationParticipant" ADD CONSTRAINT "ConversationParticipant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "XmtpIdentity"("userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_parentMessageId_fkey" FOREIGN KEY ("parentMessageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "XmtpIdentity"("userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageReceipt" ADD CONSTRAINT "MessageReceipt_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnChainImage" ADD CONSTRAINT "OnChainImage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("tokenId") ON DELETE CASCADE ON UPDATE CASCADE;

