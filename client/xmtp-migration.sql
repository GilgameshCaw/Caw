-- XMTP Schema Migration

-- Create MessageStatus enum
CREATE TYPE "MessageStatus" AS ENUM ('SENT', 'DELIVERED', 'READ', 'FAILED');

-- Create ConversationType enum
CREATE TYPE "ConversationType" AS ENUM ('DM', 'GROUP');

-- Create XmtpIdentity table
CREATE TABLE "XmtpIdentity" (
    "id" SERIAL PRIMARY KEY,
    "userId" INTEGER UNIQUE NOT NULL,
    "walletAddress" TEXT UNIQUE NOT NULL,
    "installationId" TEXT UNIQUE NOT NULL,
    "identityKey" TEXT NOT NULL,
    "preKeys" JSONB NOT NULL,
    "signedPreKey" JSONB NOT NULL,
    "registrationId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "XmtpIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("tokenId") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- Create indexes for XmtpIdentity
CREATE INDEX "XmtpIdentity_walletAddress_idx" ON "XmtpIdentity"("walletAddress");
CREATE INDEX "XmtpIdentity_installationId_idx" ON "XmtpIdentity"("installationId");

-- Create Conversation table
CREATE TABLE "Conversation" (
    "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    "type" "ConversationType" NOT NULL,
    "topic" TEXT UNIQUE NOT NULL,
    "name" TEXT,
    "description" TEXT,
    "avatarUrl" TEXT,
    "creatorId" INTEGER NOT NULL,
    "metadata" JSONB,
    "lastMessageAt" TIMESTAMP(3),
    "lastMessageId" TEXT,
    "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL
);

-- Create indexes for Conversation
CREATE INDEX "Conversation_lastMessageAt_idx" ON "Conversation"("lastMessageAt");
CREATE INDEX "Conversation_creatorId_idx" ON "Conversation"("creatorId");

-- Create ConversationParticipant table
CREATE TABLE "ConversationParticipant" (
    "id" SERIAL PRIMARY KEY,
    "conversationId" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "joinedAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "leftAt" TIMESTAMP(3),
    "isAdmin" BOOLEAN DEFAULT false NOT NULL,
    "isMuted" BOOLEAN DEFAULT false NOT NULL,
    "lastReadAt" TIMESTAMP(3),
    "unreadCount" INTEGER DEFAULT 0 NOT NULL,
    CONSTRAINT "ConversationParticipant_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ConversationParticipant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "XmtpIdentity"("userId") ON DELETE RESTRICT ON UPDATE CASCADE,
    UNIQUE ("conversationId", "userId")
);

-- Create indexes for ConversationParticipant
CREATE INDEX "ConversationParticipant_userId_idx" ON "ConversationParticipant"("userId");
CREATE INDEX "ConversationParticipant_conversationId_idx" ON "ConversationParticipant"("conversationId");

-- Create Message table
CREATE TABLE "Message" (
    "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    "conversationId" TEXT NOT NULL,
    "senderId" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "contentType" TEXT DEFAULT 'text' NOT NULL,
    "metadata" JSONB,
    "status" "MessageStatus" DEFAULT 'SENT' NOT NULL,
    "editedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "parentMessageId" TEXT,
    "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Message_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "XmtpIdentity"("userId") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Message_parentMessageId_fkey" FOREIGN KEY ("parentMessageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- Create indexes for Message
CREATE INDEX "Message_conversationId_createdAt_idx" ON "Message"("conversationId", "createdAt");
CREATE INDEX "Message_senderId_idx" ON "Message"("senderId");
CREATE INDEX "Message_parentMessageId_idx" ON "Message"("parentMessageId");

-- Create MessageReceipt table
CREATE TABLE "MessageReceipt" (
    "id" SERIAL PRIMARY KEY,
    "messageId" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "deliveredAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    CONSTRAINT "MessageReceipt_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    UNIQUE ("messageId", "userId")
);

-- Create index for MessageReceipt
CREATE INDEX "MessageReceipt_userId_idx" ON "MessageReceipt"("userId");