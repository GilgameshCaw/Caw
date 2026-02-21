# XMTP Separate Inboxes Architecture

## Overview

This document explains how the CAW messaging system provides **separate inboxes for each token** (username) while sharing the same XMTP encryption keys at the wallet level.

## Problem Statement

Multiple NFT tokens can belong to the same wallet address:
- Token #1: gilgamesh (tokenId=1, wallet=0xABC)
- Token #2: gilgatwo (tokenId=4, wallet=0xABC)
- Token #3: gilgathree (tokenId=5, wallet=0xABC)

**Requirement**: Each token should have its own separate inbox/conversations, even though they share the same wallet and XMTP identity.

## Architecture Solution

### Two-Layer System

1. **XMTP Layer** (Wallet-Level)
   - Handles end-to-end encryption
   - One XMTP client per wallet address
   - Stored in memory: `Map<walletAddress, XmtpClient>`
   - Database: `XmtpIdentity` table keyed by `walletAddress`

2. **Database Layer** (Token-Level)
   - Stores conversation ownership
   - Filters conversations by `userId` (tokenId)
   - Tables: `Conversation`, `ConversationParticipant`, `Message`

### How It Works

#### Registration Flow
1. User clicks "Initialize XMTP" for token #1
2. XMTP client created for wallet address 0xABC
3. Database saves: `XmtpIdentity { walletAddress: 0xABC, userId: 1 }`
4. User switches to token #2 (same wallet)
5. Registration checks: wallet 0xABC already has XMTP identity
6. Returns existing identity (no re-initialization needed)

#### Conversation Creation Flow
1. **Token #1** (gilgamesh) creates conversation with another user
2. XMTP creates encrypted conversation with topic `xyz123`
3. **Database stores**:
   ```sql
   INSERT INTO Conversation (id, topic, type, creatorId)
   VALUES (uuid, 'xyz123', 'DM', 1)

   INSERT INTO ConversationParticipant (conversationId, userId)
   VALUES (uuid, 1), (uuid, <peer_userId>)
   ```
4. This conversation is now **owned by token #1 only**

#### Conversation Retrieval Flow
1. **Token #1** fetches conversations: `GET /api/conversations/1`
2. Query filters by `ConversationParticipant.userId = 1`
3. Returns only conversations where token #1 is a participant

4. **Token #2** fetches conversations: `GET /api/conversations/4`
5. Query filters by `ConversationParticipant.userId = 4`
6. Returns only conversations where token #2 is a participant

**Result**: Separate inboxes per token!

#### Message Encryption/Decryption
- Both tokens use the **same XMTP client** (wallet-level)
- Encryption keys are shared (same wallet)
- But **conversation access is filtered** (token-level)

## API Endpoints

### New Endpoints (`/api/conversations`)

#### `GET /api/conversations/:userId`
Fetch all conversations for a specific user (token).

**Query Parameters**: None

**Response**:
```json
{
  "conversations": [
    {
      "id": "uuid",
      "type": "DM",
      "topic": "xmtp-topic",
      "lastMessageAt": "2025-12-05T...",
      "unreadCount": 3,
      "participants": [
        {
          "userId": 1,
          "username": "gilgamesh",
          "walletAddress": "0xABC..."
        }
      ]
    }
  ]
}
```

#### `POST /api/conversations/dm`
Create or get a DM conversation between two users.

**Body**:
```json
{
  "userId": 1,
  "peerUserId": 5,
  "topic": "xmtp-conversation-topic"
}
```

**Response**:
```json
{
  "conversation": {
    "id": "uuid",
    "type": "DM",
    "topic": "xmtp-topic",
    "participants": [...]
  }
}
```

#### `GET /api/conversations/:conversationId/messages?userId=1`
Fetch messages for a conversation (only if user is a participant).

**Response**:
```json
{
  "messages": [
    {
      "id": "msg-uuid",
      "conversationId": "conv-uuid",
      "senderId": 1,
      "encryptedPayload": "...",
      "createdAt": "2025-12-05T...",
      "sender": {
        "user": {
          "username": "gilgamesh"
        }
      }
    }
  ]
}
```

### Updated Endpoints (`/api/xmtp-identity`)

#### `POST /api/xmtp-identity/register`
Now checks by `walletAddress` instead of `userId`:
- If wallet already registered → returns existing identity
- If new wallet → creates new identity

#### `GET /api/xmtp-identity/check/:username`
Now looks up by wallet address:
- Fetches user's wallet address
- Checks if that wallet has XMTP identity
- Returns whether **the wallet** has XMTP (not just the specific token)

## Database Schema (Relevant Tables)

### XmtpIdentity
```prisma
model XmtpIdentity {
  id               Int      @id @default(autoincrement())
  userId           Int      @unique // First token that registered
  walletAddress    String   @unique // PRIMARY KEY for lookup
  installationId   String   @unique
  identityKey      String
  // ... encryption keys
}
```

### Conversation
```prisma
model Conversation {
  id               String   @id @default(uuid())
  type             ConversationType // DM or GROUP
  topic            String   @unique // XMTP conversation topic
  creatorId        Int      // Token that created it
  lastMessageAt    DateTime?
  participants     ConversationParticipant[]
  messages         Message[]
}
```

### ConversationParticipant
```prisma
model ConversationParticipant {
  id               Int      @id @default(autoincrement())
  conversationId   String
  userId           Int      // Token ID (NOT wallet)
  joinedAt         DateTime @default(now())
  leftAt           DateTime?
  unreadCount      Int      @default(0)
}
```

### Message
```prisma
model Message {
  id               String   @id @default(uuid())
  conversationId   String
  senderId         Int      // Token ID that sent
  encryptedPayload String   @db.Text
  createdAt        DateTime @default(now())
}
```

## Key Design Decisions

### 1. Wallet-Level XMTP Identity
**Why**: XMTP requires one identity per wallet address. Multiple tokens from the same wallet must share encryption keys.

**Implementation**: `XmtpIdentity` table uses `walletAddress` as unique key.

### 2. Token-Level Conversations
**Why**: Each token (username) should have separate inbox for better UX.

**Implementation**: `ConversationParticipant` links conversations to specific `userId` (tokenId).

### 3. Database Registration Check
**Why**: XMTP network propagation is slow/unreliable. Database provides instant verification.

**Implementation**: Check database first before XMTP network in `startConversation()`.

## Frontend Implementation (TODO)

The Messages.tsx component needs to be updated to:

1. **When creating conversation**:
   ```typescript
   // Create XMTP conversation (encryption)
   const xmtpConv = await startConversation(peerAddress)

   // Store in database (ownership)
   await fetch('/api/conversations/dm', {
     method: 'POST',
     body: JSON.stringify({
       userId: currentUser.id,
       peerUserId: targetUser.id,
       topic: xmtpConv.topic
     })
   })
   ```

2. **When fetching conversations**:
   ```typescript
   // Fetch from database (filtered by current token)
   const response = await fetch(`/api/conversations/${currentUser.id}`)
   const { conversations } = await response.json()

   // Then use XMTP client to fetch/decrypt messages for each conversation
   ```

3. **When switching tokens**:
   - XMTP client remains the same (same wallet)
   - Fetch new conversations list for new userId
   - Inbox updates automatically

## Testing Scenarios

### Scenario 1: Same Wallet, Different Tokens
1. Login as gilgamesh (token #1, wallet 0xABC)
2. Initialize XMTP → creates identity for 0xABC
3. Create conversation with user X → stored for userId=1
4. Switch to gilgatwo (token #4, same wallet 0xABC)
5. XMTP already initialized (same wallet)
6. Fetch conversations → empty (userId=4 has no conversations)
7. Create conversation with user Y → stored for userId=4
8. Switch back to gilgamesh → sees conversation with X only

### Scenario 2: Same User Messages From Different Tokens
1. gilgamesh (token #1) messages user X
2. gilgatwo (token #4) also messages user X
3. User X sees TWO separate conversations:
   - One with gilgamesh
   - One with gilgatwo
4. This is correct behavior (different identities)

## Security Considerations

1. **Encryption**: End-to-end encrypted via XMTP (wallet-level)
2. **Access Control**: Conversation access verified via `ConversationParticipant`
3. **Message Storage**: Encrypted payloads stored, decrypted client-side
4. **Token Isolation**: Tokens from same wallet cannot see each other's conversations

## Migration Path

If there are existing XMTP conversations stored only in XMTP (not database):

1. Add migration script to sync existing XMTP conversations to database
2. For each XMTP conversation:
   - Create `Conversation` record
   - Create `ConversationParticipant` records for participants
   - Associate with current user's token
3. Future conversations use new system

## Summary

**Before**: Conversations shared per wallet → confusing UX
**After**: Conversations separate per token → clear UX

**Encryption**: Still wallet-level (XMTP requirement)
**Ownership**: Now token-level (better user experience)

The system provides the best of both worlds:
- Strong encryption via XMTP (wallet-level)
- Clear identity separation (token-level)
