-- CreateEnum
CREATE TYPE "ActionType" AS ENUM ('CAW', 'LIKE', 'UNLIKE', 'RECAW', 'FOLLOW', 'UNFOLLOW', 'WITHDRAW', 'OTHER');

-- CreateEnum
CREATE TYPE "CawStatus" AS ENUM ('SUCCESS', 'PENDING', 'FAILED');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('FOLLOW', 'LIKE', 'REPLY', 'REPOST', 'QUOTE', 'MENTION', 'TIP');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('SENT', 'DELIVERED', 'READ', 'FAILED');

-- CreateEnum
CREATE TYPE "ConversationType" AS ENUM ('DM');

-- CreateEnum
CREATE TYPE "DmPrivacy" AS ENUM ('EVERYONE', 'FOLLOWERS', 'FOLLOWING');

-- CreateEnum
CREATE TYPE "ReportReason" AS ENUM ('SPAM', 'HARASSMENT', 'INAPPROPRIATE', 'MISINFORMATION', 'OTHER');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('PENDING', 'REVIEWED', 'ACTIONED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "MarketListingType" AS ENUM ('FIXED', 'DUTCH_AUCTION', 'ENGLISH_AUCTION');

-- CreateEnum
CREATE TYPE "MarketListingStatus" AS ENUM ('ACTIVE', 'SOLD', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "BidStatus" AS ENUM ('ACTIVE', 'OUTBID', 'WON', 'WITHDRAWN');

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
    "onboardingStep" INTEGER NOT NULL DEFAULT 0,
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
    "reason" TEXT,
    "videoData" TEXT,
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "bookmarkCount" INTEGER NOT NULL DEFAULT 0,

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
CREATE TABLE "Reply" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "cawId" INTEGER NOT NULL,
    "replyCawId" INTEGER NOT NULL,
    "pending" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Reply_pkey" PRIMARY KEY ("id")
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
CREATE TABLE "Block" (
    "id" SERIAL NOT NULL,
    "blockerId" INTEGER NOT NULL,
    "blockedId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Block_pkey" PRIMARY KEY ("id")
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
    "displayName" TEXT,
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
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DmIdentity" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "dmPrivacy" "DmPrivacy" NOT NULL DEFAULT 'EVERYONE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DmIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "type" "ConversationType" NOT NULL DEFAULT 'DM',
    "creatorId" INTEGER NOT NULL,
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
    "lastReadAt" TIMESTAMP(3),
    "unreadCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ConversationParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "senderId" INTEGER NOT NULL,
    "encryptedPayload" TEXT,
    "contentType" TEXT NOT NULL DEFAULT 'text',
    "editHistory" TEXT,
    "status" "MessageStatus" NOT NULL DEFAULT 'SENT',
    "shadowBlocked" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageDeletion" (
    "id" SERIAL NOT NULL,
    "messageId" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "deletedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageDeletion_pkey" PRIMARY KEY ("id")
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

-- CreateTable
CREATE TABLE "Tip" (
    "id" SERIAL NOT NULL,
    "senderId" INTEGER NOT NULL,
    "recipientId" INTEGER NOT NULL,
    "amount" INTEGER NOT NULL,
    "cawId" INTEGER,
    "cawonce" INTEGER NOT NULL,
    "pending" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Client" (
    "id" INTEGER NOT NULL,
    "ownerAddress" TEXT NOT NULL,
    "feeAddress" TEXT NOT NULL,
    "mintFee" TEXT NOT NULL DEFAULT '0',
    "depositFee" TEXT NOT NULL DEFAULT '0',
    "withdrawFee" TEXT NOT NULL DEFAULT '0',
    "authFee" TEXT NOT NULL DEFAULT '0',
    "replicationEnabled" BOOLEAN NOT NULL DEFAULT false,
    "replicationCount" INTEGER NOT NULL DEFAULT 0,
    "replications" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastSyncedAt" TIMESTAMP(3),
    "lastSyncedBlock" BIGINT,

    CONSTRAINT "Client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChainData" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChainData_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "Report" (
    "id" SERIAL NOT NULL,
    "reporterId" INTEGER NOT NULL,
    "postId" INTEGER NOT NULL,
    "postAuthorId" INTEGER NOT NULL,
    "reason" "ReportReason" NOT NULL,
    "details" TEXT,
    "status" "ReportStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,
    "resolution" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BugReport" (
    "id" SERIAL NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'bug',
    "userId" INTEGER,
    "username" TEXT,
    "stakedAmount" TEXT,
    "description" TEXT NOT NULL,
    "imageUrls" TEXT,
    "page" TEXT,
    "userAgent" TEXT,
    "status" "ReportStatus" NOT NULL DEFAULT 'PENDING',
    "resolution" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BugReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceSnapshot" (
    "id" SERIAL NOT NULL,
    "token" TEXT NOT NULL,
    "usdPrice" DOUBLE PRECISION NOT NULL,
    "ethPrice" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PriceSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ValidatorTx" (
    "id" SERIAL NOT NULL,
    "txHash" TEXT NOT NULL,
    "blockNumber" BIGINT,
    "txType" TEXT NOT NULL DEFAULT 'processActions',
    "actionCount" INTEGER NOT NULL,
    "actionBreakdown" JSONB,
    "gasUsed" TEXT NOT NULL,
    "gasPrice" TEXT NOT NULL,
    "ethCost" TEXT NOT NULL,
    "tipCaw" TEXT NOT NULL,
    "tipEthValue" TEXT NOT NULL,
    "profit" TEXT NOT NULL,
    "validatorId" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'confirmed',
    "failReason" TEXT,
    "avgWaitMs" INTEGER,
    "sessionUser" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ValidatorTx_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReplicationTx" (
    "id" SERIAL NOT NULL,
    "txHash" TEXT NOT NULL,
    "blockNumber" BIGINT,
    "clientId" INTEGER NOT NULL,
    "destEid" INTEGER NOT NULL,
    "checkpointId" INTEGER NOT NULL,
    "actionCount" INTEGER NOT NULL DEFAULT 256,
    "gasUsed" TEXT NOT NULL,
    "gasPrice" TEXT NOT NULL,
    "ethCost" TEXT NOT NULL,
    "lzFee" TEXT NOT NULL,
    "totalCost" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'confirmed',
    "failReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReplicationTx_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ValidatorSetting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ValidatorSetting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "MarketplaceListing" (
    "id" SERIAL NOT NULL,
    "listingId" INTEGER NOT NULL,
    "tokenId" INTEGER NOT NULL,
    "seller" TEXT NOT NULL,
    "listingType" "MarketListingType" NOT NULL,
    "paymentToken" TEXT NOT NULL,
    "paymentAddress" TEXT NOT NULL,
    "startPrice" TEXT NOT NULL,
    "endPrice" TEXT,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3),
    "status" "MarketListingStatus" NOT NULL DEFAULT 'ACTIVE',
    "highestBid" TEXT,
    "highestBidder" TEXT,
    "username" TEXT NOT NULL,
    "usernameLength" INTEGER NOT NULL,
    "stakedCaw" TEXT,
    "txHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketplaceListing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketplaceBid" (
    "id" SERIAL NOT NULL,
    "listingId" INTEGER NOT NULL,
    "bidder" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "txHash" TEXT,
    "status" "BidStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketplaceBid_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketplaceSale" (
    "id" SERIAL NOT NULL,
    "listingId" INTEGER NOT NULL,
    "buyer" TEXT NOT NULL,
    "seller" TEXT NOT NULL,
    "tokenId" INTEGER NOT NULL,
    "price" TEXT NOT NULL,
    "paymentToken" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "txHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketplaceSale_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Bookmark" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "cawId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Bookmark_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RawEvent_chainId_blockNumber_logIndex_idx" ON "RawEvent"("chainId", "blockNumber", "logIndex");

-- CreateIndex
CREATE UNIQUE INDEX "RawEvent_blockNumber_logIndex_transactionHash_key" ON "RawEvent"("blockNumber", "logIndex", "transactionHash");

-- CreateIndex
CREATE UNIQUE INDEX "User_tokenId_key" ON "User"("tokenId");

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE INDEX "User_address_idx" ON "User"("address");

-- CreateIndex
CREATE INDEX "Caw_userId_action_createdAt_idx" ON "Caw"("userId", "action", "createdAt");

-- CreateIndex
CREATE INDEX "Caw_originalCawId_idx" ON "Caw"("originalCawId");

-- CreateIndex
CREATE INDEX "Caw_originalCawId_action_idx" ON "Caw"("originalCawId", "action");

-- CreateIndex
CREATE INDEX "Caw_status_userId_idx" ON "Caw"("status", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Caw_userId_cawonce_key" ON "Caw"("userId", "cawonce");

-- CreateIndex
CREATE INDEX "Like_cawId_idx" ON "Like"("cawId");

-- CreateIndex
CREATE INDEX "Like_cawId_action_idx" ON "Like"("cawId", "action");

-- CreateIndex
CREATE UNIQUE INDEX "Like_userId_cawId_key" ON "Like"("userId", "cawId");

-- CreateIndex
CREATE INDEX "Reply_cawId_idx" ON "Reply"("cawId");

-- CreateIndex
CREATE INDEX "Reply_cawId_pending_idx" ON "Reply"("cawId", "pending");

-- CreateIndex
CREATE INDEX "Reply_userId_idx" ON "Reply"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Reply_userId_cawId_replyCawId_key" ON "Reply"("userId", "cawId", "replyCawId");

-- CreateIndex
CREATE INDEX "Follow_followerId_status_idx" ON "Follow"("followerId", "status");

-- CreateIndex
CREATE INDEX "Follow_followingId_status_idx" ON "Follow"("followingId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Follow_followerId_followingId_key" ON "Follow"("followerId", "followingId");

-- CreateIndex
CREATE INDEX "Block_blockerId_idx" ON "Block"("blockerId");

-- CreateIndex
CREATE INDEX "Block_blockedId_idx" ON "Block"("blockedId");

-- CreateIndex
CREATE UNIQUE INDEX "Block_blockerId_blockedId_key" ON "Block"("blockerId", "blockedId");

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
CREATE INDEX "ScheduledCaw_status_scheduledAt_idx" ON "ScheduledCaw"("status", "scheduledAt");

-- CreateIndex
CREATE INDEX "ScheduledCaw_userId_status_cawonce_idx" ON "ScheduledCaw"("userId", "status", "cawonce");

-- CreateIndex
CREATE INDEX "Notification_userId_isRead_createdAt_idx" ON "Notification"("userId", "isRead", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_userId_hidden_createdAt_idx" ON "Notification"("userId", "hidden", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_userId_type_idx" ON "Notification"("userId", "type");

-- CreateIndex
CREATE INDEX "Notification_userId_actorId_type_idx" ON "Notification"("userId", "actorId", "type");

-- CreateIndex
CREATE INDEX "Notification_groupKey_idx" ON "Notification"("groupKey");

-- CreateIndex
CREATE INDEX "Notification_createdAt_idx" ON "Notification"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "DmIdentity_userId_key" ON "DmIdentity"("userId");

-- CreateIndex
CREATE INDEX "DmIdentity_walletAddress_idx" ON "DmIdentity"("walletAddress");

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
CREATE INDEX "MessageDeletion_userId_idx" ON "MessageDeletion"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "MessageDeletion_messageId_userId_key" ON "MessageDeletion"("messageId", "userId");

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
CREATE INDEX "OnChainImage_userId_postedAt_ignored_idx" ON "OnChainImage"("userId", "postedAt", "ignored");

-- CreateIndex
CREATE INDEX "OnChainImage_status_idx" ON "OnChainImage"("status");

-- CreateIndex
CREATE INDEX "OnChainImage_createdAt_idx" ON "OnChainImage"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "OnChainImage_userId_cawonce_key" ON "OnChainImage"("userId", "cawonce");

-- CreateIndex
CREATE INDEX "Tip_senderId_idx" ON "Tip"("senderId");

-- CreateIndex
CREATE INDEX "Tip_senderId_recipientId_cawId_idx" ON "Tip"("senderId", "recipientId", "cawId");

-- CreateIndex
CREATE INDEX "Tip_senderId_pending_idx" ON "Tip"("senderId", "pending");

-- CreateIndex
CREATE INDEX "Tip_recipientId_idx" ON "Tip"("recipientId");

-- CreateIndex
CREATE INDEX "Tip_cawId_idx" ON "Tip"("cawId");

-- CreateIndex
CREATE INDEX "Tip_pending_idx" ON "Tip"("pending");

-- CreateIndex
CREATE INDEX "Client_ownerAddress_idx" ON "Client"("ownerAddress");

-- CreateIndex
CREATE INDEX "Report_status_idx" ON "Report"("status");

-- CreateIndex
CREATE INDEX "Report_postId_idx" ON "Report"("postId");

-- CreateIndex
CREATE INDEX "Report_reporterId_idx" ON "Report"("reporterId");

-- CreateIndex
CREATE INDEX "Report_reporterId_postId_idx" ON "Report"("reporterId", "postId");

-- CreateIndex
CREATE INDEX "Report_postAuthorId_idx" ON "Report"("postAuthorId");

-- CreateIndex
CREATE INDEX "Report_createdAt_idx" ON "Report"("createdAt");

-- CreateIndex
CREATE INDEX "BugReport_status_idx" ON "BugReport"("status");

-- CreateIndex
CREATE INDEX "BugReport_createdAt_idx" ON "BugReport"("createdAt");

-- CreateIndex
CREATE INDEX "BugReport_type_idx" ON "BugReport"("type");

-- CreateIndex
CREATE INDEX "PriceSnapshot_token_createdAt_idx" ON "PriceSnapshot"("token", "createdAt");

-- CreateIndex
CREATE INDEX "PriceSnapshot_createdAt_idx" ON "PriceSnapshot"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ValidatorTx_txHash_key" ON "ValidatorTx"("txHash");

-- CreateIndex
CREATE INDEX "ValidatorTx_createdAt_idx" ON "ValidatorTx"("createdAt");

-- CreateIndex
CREATE INDEX "ValidatorTx_validatorId_createdAt_idx" ON "ValidatorTx"("validatorId", "createdAt");

-- CreateIndex
CREATE INDEX "ValidatorTx_txType_createdAt_idx" ON "ValidatorTx"("txType", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReplicationTx_txHash_key" ON "ReplicationTx"("txHash");

-- CreateIndex
CREATE INDEX "ReplicationTx_createdAt_idx" ON "ReplicationTx"("createdAt");

-- CreateIndex
CREATE INDEX "ReplicationTx_clientId_createdAt_idx" ON "ReplicationTx"("clientId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MarketplaceListing_listingId_key" ON "MarketplaceListing"("listingId");

-- CreateIndex
CREATE INDEX "MarketplaceListing_status_createdAt_idx" ON "MarketplaceListing"("status", "createdAt");

-- CreateIndex
CREATE INDEX "MarketplaceListing_status_usernameLength_idx" ON "MarketplaceListing"("status", "usernameLength");

-- CreateIndex
CREATE INDEX "MarketplaceListing_tokenId_idx" ON "MarketplaceListing"("tokenId");

-- CreateIndex
CREATE INDEX "MarketplaceBid_listingId_status_idx" ON "MarketplaceBid"("listingId", "status");

-- CreateIndex
CREATE INDEX "MarketplaceBid_bidder_idx" ON "MarketplaceBid"("bidder");

-- CreateIndex
CREATE UNIQUE INDEX "MarketplaceSale_listingId_key" ON "MarketplaceSale"("listingId");

-- CreateIndex
CREATE INDEX "MarketplaceSale_createdAt_idx" ON "MarketplaceSale"("createdAt");

-- CreateIndex
CREATE INDEX "MarketplaceSale_tokenId_idx" ON "MarketplaceSale"("tokenId");

-- CreateIndex
CREATE INDEX "Bookmark_userId_createdAt_idx" ON "Bookmark"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Bookmark_cawId_idx" ON "Bookmark"("cawId");

-- CreateIndex
CREATE UNIQUE INDEX "Bookmark_userId_cawId_key" ON "Bookmark"("userId", "cawId");

-- AddForeignKey
ALTER TABLE "Caw" ADD CONSTRAINT "Caw_originalCawId_fkey" FOREIGN KEY ("originalCawId") REFERENCES "Caw"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Caw" ADD CONSTRAINT "Caw_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("tokenId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Like" ADD CONSTRAINT "Like_cawId_fkey" FOREIGN KEY ("cawId") REFERENCES "Caw"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Like" ADD CONSTRAINT "Like_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("tokenId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reply" ADD CONSTRAINT "Reply_cawId_fkey" FOREIGN KEY ("cawId") REFERENCES "Caw"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reply" ADD CONSTRAINT "Reply_replyCawId_fkey" FOREIGN KEY ("replyCawId") REFERENCES "Caw"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reply" ADD CONSTRAINT "Reply_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("tokenId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Follow" ADD CONSTRAINT "Follow_followerId_fkey" FOREIGN KEY ("followerId") REFERENCES "User"("tokenId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Follow" ADD CONSTRAINT "Follow_followingId_fkey" FOREIGN KEY ("followingId") REFERENCES "User"("tokenId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Block" ADD CONSTRAINT "Block_blockerId_fkey" FOREIGN KEY ("blockerId") REFERENCES "User"("tokenId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Block" ADD CONSTRAINT "Block_blockedId_fkey" FOREIGN KEY ("blockedId") REFERENCES "User"("tokenId") ON DELETE RESTRICT ON UPDATE CASCADE;

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
ALTER TABLE "DmIdentity" ADD CONSTRAINT "DmIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("tokenId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationParticipant" ADD CONSTRAINT "ConversationParticipant_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationParticipant" ADD CONSTRAINT "ConversationParticipant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "DmIdentity"("userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "DmIdentity"("userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageDeletion" ADD CONSTRAINT "MessageDeletion_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageReceipt" ADD CONSTRAINT "MessageReceipt_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnChainImage" ADD CONSTRAINT "OnChainImage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("tokenId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tip" ADD CONSTRAINT "Tip_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("tokenId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tip" ADD CONSTRAINT "Tip_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "User"("tokenId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tip" ADD CONSTRAINT "Tip_cawId_fkey" FOREIGN KEY ("cawId") REFERENCES "Caw"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketplaceBid" ADD CONSTRAINT "MarketplaceBid_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "MarketplaceListing"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketplaceSale" ADD CONSTRAINT "MarketplaceSale_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "MarketplaceListing"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bookmark" ADD CONSTRAINT "Bookmark_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("tokenId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bookmark" ADD CONSTRAINT "Bookmark_cawId_fkey" FOREIGN KEY ("cawId") REFERENCES "Caw"("id") ON DELETE CASCADE ON UPDATE CASCADE;

