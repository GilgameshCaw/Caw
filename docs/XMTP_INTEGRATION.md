# XMTP Integration for CAW Protocol - Implementation Specification

## Executive Summary

This document outlines the integration of XMTP (Extensible Message Transport Protocol) to enable end-to-end encrypted private messaging and group messaging functionality in the CAW Protocol. XMTP will provide a decentralized, encrypted messaging layer that complements CAW's public social features.

## Table of Contents
1. [System Architecture](#system-architecture)
2. [Technical Stack](#technical-stack)
3. [Implementation Plan](#implementation-plan)
4. [API Specifications](#api-specifications)
5. [Security Considerations](#security-considerations)
6. [Development Checklist](#development-checklist)

## System Architecture

### High-Level Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        CAW Frontend (React)                      │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────┐ │
│  │  Public Caws     │  │  Private DMs     │  │  Group Chats │ │
│  └──────────────────┘  └──────────────────┘  └──────────────┘ │
└───────────────┬────────────────┬────────────────┬──────────────┘
                │                │                │
         ┌──────▼──────┐  ┌──────▼──────┐  ┌─────▼──────┐
         │ CAW API     │  │  XMTP SDK   │  │ Wagmi/     │
         │ (Express)   │  │  (JS Client)│  │ RainbowKit │
         └──────┬──────┘  └──────┬──────┘  └─────┬──────┘
                │                │                │
         ┌──────▼──────────────────────────────────┐
         │         Backend Services Layer          │
         │  ┌────────────┐  ┌────────────────┐   │
         │  │ XMTP Node  │  │ Message Index  │   │
         │  │ (Docker)   │  │ Service        │   │
         │  └────────────┘  └────────────────┘   │
         └───────────┬──────────────┬─────────────┘
                     │              │
         ┌───────────▼──────┐  ┌───▼──────────┐
         │   PostgreSQL     │  │   Redis       │
         │  - Metadata      │  │  - Sessions   │
         │  - Conversation  │  │  - Cache      │
         │    Index         │  │  - Presence   │
         └──────────────────┘  └───────────────┘
```

### Component Responsibilities

#### Frontend Layer
- **Public Caws**: Existing public messaging (unchanged)
- **Private DMs**: New XMTP 1:1 encrypted conversations
- **Group Chats**: New XMTP MLS-based group messaging

#### Middleware Layer
- **CAW API**: Existing REST API + new XMTP endpoints
- **XMTP SDK**: Client-side encryption/decryption
- **Wagmi/RainbowKit**: Wallet connection and signing

#### Backend Services
- **XMTP Node**: Message relay and storage (encrypted)
- **Message Index Service**: Metadata indexing, search, notifications
- **PostgreSQL**: Conversation metadata, user mappings
- **Redis**: Session management, real-time presence

## Technical Stack

### Dependencies

```json
{
  "dependencies": {
    "@xmtp/xmtp-js": "^11.0.0",
    "@xmtp/content-types": "^1.0.0",
    "@xmtp/react-sdk": "^3.0.0",
    "@xmtp/mls-client": "^0.1.0"
  }
}
```

### Database Schema Extensions

```prisma
// New models for XMTP integration
model XmtpIdentity {
  id              Int      @id @default(autoincrement())
  userId          Int      @unique
  identityKey     String   @unique
  installationIds String[] // Array of device installation IDs
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  user            User     @relation(fields: [userId], references: [tokenId])
  conversations   ConversationMember[]
}

model Conversation {
  id              String   @id // XMTP conversation ID
  type            ConversationType
  title           String?  // For groups
  avatarUrl       String?
  metadata        Json?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  lastMessageAt   DateTime?
  lastMessageId   String?

  members         ConversationMember[]
  messageMetadata MessageMetadata[]
}

model ConversationMember {
  conversationId  String
  identityId      Int
  joinedAt        DateTime @default(now())
  role           MemberRole @default(MEMBER)
  isActive        Boolean  @default(true)
  lastReadAt      DateTime?

  conversation    Conversation @relation(fields: [conversationId], references: [id])
  identity        XmtpIdentity @relation(fields: [identityId], references: [id])

  @@id([conversationId, identityId])
  @@index([identityId, isActive])
}

model MessageMetadata {
  id              String   @id // XMTP message ID
  conversationId  String
  senderAddress   String
  timestamp       DateTime
  contentType     String
  hasAttachment   Boolean  @default(false)
  isEdited        Boolean  @default(false)
  reactions       Json?    // Store reaction metadata

  conversation    Conversation @relation(fields: [conversationId], references: [id])

  @@index([conversationId, timestamp])
  @@index([senderAddress])
}

enum ConversationType {
  DM
  GROUP
}

enum MemberRole {
  ADMIN
  MODERATOR
  MEMBER
}
```

## Implementation Plan

### Phase 1: Foundation (Week 1-2)

#### 1.1 XMTP Node Setup
```bash
# Docker setup for XMTP node
docker run -d \
  --name xmtp-node \
  -p 5555:5555 \
  -v xmtp-data:/data \
  -e XMTP_ENV=production \
  -e XMTP_LOG_LEVEL=info \
  xmtp/node:latest
```

#### 1.2 Identity Service
```typescript
// src/services/XmtpIdentityService/index.ts
import { Client } from '@xmtp/xmtp-js'
import { Wallet } from 'ethers'
import { prisma } from '../../prismaClient'

export class XmtpIdentityService {
  async registerIdentity(userId: number, wallet: Wallet): Promise<Client> {
    // Check if identity exists
    let identity = await prisma.xmtpIdentity.findUnique({
      where: { userId }
    })

    // Create XMTP client
    const xmtp = await Client.create(wallet, { env: 'production' })

    if (!identity) {
      // Store identity
      identity = await prisma.xmtpIdentity.create({
        data: {
          userId,
          identityKey: xmtp.address,
          installationIds: [xmtp.installationId]
        }
      })
    } else {
      // Add new installation
      await prisma.xmtpIdentity.update({
        where: { id: identity.id },
        data: {
          installationIds: {
            push: xmtp.installationId
          }
        }
      })
    }

    return xmtp
  }

  async canMessage(address: string): Promise<boolean> {
    return await Client.canMessage(address, { env: 'production' })
  }
}
```

### Phase 2: Direct Messaging (Week 2-3)

#### 2.1 API Endpoints
```typescript
// src/api/routes/messages.ts
import { Router } from 'express'
import { XmtpMessageService } from '../../services/XmtpMessageService'

const router = Router()
const messageService = new XmtpMessageService()

// Start a new conversation
router.post('/conversations', async (req, res) => {
  const { peerAddress, message } = req.body
  const userId = req.header('x-user-id')

  const conversation = await messageService.startConversation(
    userId,
    peerAddress,
    message
  )

  res.json(conversation)
})

// Get conversations list
router.get('/conversations', async (req, res) => {
  const userId = req.header('x-user-id')
  const conversations = await messageService.listConversations(userId)
  res.json(conversations)
})

// Get messages in conversation
router.get('/conversations/:id/messages', async (req, res) => {
  const { id } = req.params
  const messages = await messageService.getMessages(id)
  res.json(messages)
})

// Send message
router.post('/conversations/:id/messages', async (req, res) => {
  const { id } = req.params
  const { content, contentType = 'text' } = req.body

  const message = await messageService.sendMessage(id, content, contentType)
  res.json(message)
})
```

#### 2.2 Frontend Components
```tsx
// src/services/FrontEnd/src/components/MessageInbox.tsx
import React, { useEffect, useState } from 'react'
import { Client } from '@xmtp/xmtp-js'
import { useWalletClient } from 'wagmi'

export const MessageInbox: React.FC = () => {
  const { data: walletClient } = useWalletClient()
  const [xmtpClient, setXmtpClient] = useState<Client | null>(null)
  const [conversations, setConversations] = useState([])

  useEffect(() => {
    if (walletClient) {
      initXmtp()
    }
  }, [walletClient])

  const initXmtp = async () => {
    const xmtp = await Client.create(walletClient)
    setXmtpClient(xmtp)

    // Load conversations
    const convos = await xmtp.conversations.list()
    setConversations(convos)

    // Stream new conversations
    const stream = await xmtp.conversations.stream()
    for await (const convo of stream) {
      setConversations(prev => [...prev, convo])
    }
  }

  return (
    <div className="message-inbox">
      {conversations.map(convo => (
        <ConversationPreview key={convo.topic} conversation={convo} />
      ))}
    </div>
  )
}
```

### Phase 3: Group Messaging (Week 3-4)

#### 3.1 Group Management Service
```typescript
// src/services/XmtpGroupService/index.ts
import { Client } from '@xmtp/xmtp-js'
import { GroupChat } from '@xmtp/mls-client'

export class XmtpGroupService {
  async createGroup(
    creatorId: number,
    name: string,
    memberAddresses: string[]
  ): Promise<GroupChat> {
    const client = await this.getClient(creatorId)

    // Create MLS group
    const group = await client.conversations.newGroup(memberAddresses, {
      name,
      imageUrl: null,
      description: null
    })

    // Store in database
    await prisma.conversation.create({
      data: {
        id: group.id,
        type: 'GROUP',
        title: name,
        members: {
          create: memberAddresses.map(addr => ({
            identityId: await this.getIdentityId(addr),
            role: addr === client.address ? 'ADMIN' : 'MEMBER'
          }))
        }
      }
    })

    return group
  }

  async inviteToGroup(
    groupId: string,
    inviterAddress: string,
    inviteeAddresses: string[]
  ): Promise<void> {
    const group = await this.getGroup(groupId)
    await group.addMembers(inviteeAddresses)

    // Update database
    await prisma.conversationMember.createMany({
      data: inviteeAddresses.map(addr => ({
        conversationId: groupId,
        identityId: this.getIdentityId(addr),
        role: 'MEMBER'
      }))
    })
  }
}
```

### Phase 4: Real-time & Notifications (Week 4-5)

#### 4.1 WebSocket Service
```typescript
// src/services/MessageStreamService/index.ts
import { Server as SocketServer } from 'socket.io'
import { Client } from '@xmtp/xmtp-js'

export class MessageStreamService {
  private io: SocketServer
  private userClients: Map<number, Client> = new Map()

  constructor(server: any) {
    this.io = new SocketServer(server, {
      cors: { origin: '*' }
    })

    this.io.on('connection', this.handleConnection.bind(this))
  }

  async handleConnection(socket: any) {
    const userId = socket.handshake.auth.userId

    // Initialize XMTP client for user
    const client = await this.getOrCreateClient(userId)

    // Stream messages
    const stream = await client.conversations.streamAllMessages()
    for await (const message of stream) {
      socket.emit('new-message', {
        conversationId: message.conversation.topic,
        content: message.content,
        senderAddress: message.senderAddress,
        timestamp: message.sent
      })

      // Store metadata
      await this.storeMessageMetadata(message)

      // Send push notification if user offline
      await this.sendPushNotification(userId, message)
    }
  }
}
```

#### 4.2 Push Notifications
```typescript
// src/services/NotificationService/xmtpNotifications.ts
export class XmtpNotificationService {
  async sendMessageNotification(
    userId: number,
    message: any
  ): Promise<void> {
    const user = await prisma.user.findUnique({
      where: { tokenId: userId },
      include: { pushTokens: true }
    })

    if (!user?.pushTokens.length) return

    const notification = {
      title: `New message from ${message.senderAddress}`,
      body: this.truncateMessage(message.content),
      data: {
        type: 'xmtp_message',
        conversationId: message.conversation.topic
      }
    }

    // Send via Firebase/APNs
    await this.pushProvider.send(user.pushTokens, notification)
  }
}
```

### Phase 5: Search & Indexing (Week 5-6)

#### 5.1 Message Indexing
```typescript
// src/services/MessageIndexService/index.ts
export class MessageIndexService {
  async indexMessage(
    conversationId: string,
    messageId: string,
    decryptedContent: string
  ): Promise<void> {
    // Store searchable content (only if user consents)
    await prisma.messageSearchIndex.create({
      data: {
        messageId,
        conversationId,
        content: decryptedContent,
        contentVector: await this.vectorize(decryptedContent), // For semantic search
        timestamp: new Date()
      }
    })
  }

  async searchMessages(
    userId: number,
    query: string
  ): Promise<any[]> {
    // Get user's conversations
    const conversations = await this.getUserConversations(userId)

    // Search within those conversations
    return await prisma.messageSearchIndex.findMany({
      where: {
        conversationId: { in: conversations.map(c => c.id) },
        content: { contains: query, mode: 'insensitive' }
      },
      orderBy: { timestamp: 'desc' },
      take: 50
    })
  }
}
```

## API Specifications

### REST Endpoints

#### Identity Management
- `POST /api/xmtp/identity` - Register XMTP identity
- `GET /api/xmtp/identity/:address` - Check if address has XMTP
- `POST /api/xmtp/installations` - Add new device

#### Conversations
- `GET /api/xmtp/conversations` - List all conversations
- `POST /api/xmtp/conversations` - Start new conversation
- `GET /api/xmtp/conversations/:id` - Get conversation details
- `DELETE /api/xmtp/conversations/:id` - Leave/delete conversation

#### Messages
- `GET /api/xmtp/conversations/:id/messages` - Get messages
- `POST /api/xmtp/conversations/:id/messages` - Send message
- `PUT /api/xmtp/messages/:id` - Edit message (if supported)
- `DELETE /api/xmtp/messages/:id` - Delete message

#### Groups
- `POST /api/xmtp/groups` - Create group
- `POST /api/xmtp/groups/:id/members` - Add members
- `DELETE /api/xmtp/groups/:id/members/:userId` - Remove member
- `PUT /api/xmtp/groups/:id` - Update group metadata

### WebSocket Events

#### Client → Server
- `authenticate` - Authenticate WebSocket connection
- `subscribe-conversation` - Subscribe to conversation updates
- `mark-read` - Mark messages as read
- `typing` - Send typing indicator

#### Server → Client
- `new-message` - New message received
- `message-updated` - Message edited/deleted
- `conversation-updated` - Conversation metadata changed
- `member-joined` - New member joined group
- `member-left` - Member left group
- `typing-indicator` - Someone is typing

## Security Considerations

### Key Management
```typescript
// Secure key storage implementation
export class KeyManager {
  private readonly keystore: SecureKeystore

  async storeIdentityKey(userId: number, key: CryptoKey): Promise<void> {
    // Encrypt key with user's password/PIN
    const encrypted = await this.encrypt(key, userId)

    // Store in secure storage
    await this.keystore.set(`identity_${userId}`, encrypted)
  }

  async retrieveIdentityKey(userId: number, password: string): Promise<CryptoKey> {
    const encrypted = await this.keystore.get(`identity_${userId}`)
    return await this.decrypt(encrypted, password)
  }

  async revokeDevice(userId: number, installationId: string): Promise<void> {
    // Remove from allowed installations
    await prisma.xmtpIdentity.update({
      where: { userId },
      data: {
        installationIds: {
          set: await this.getInstallations(userId)
            .filter(id => id !== installationId)
        }
      }
    })

    // Trigger rekey for all groups
    await this.rekeyUserGroups(userId)
  }
}
```

### Privacy Features
- End-to-end encryption for all messages
- Metadata encryption for group membership
- Optional disappearing messages
- Message forward secrecy via MLS
- Device verification

### Consent & Spam Prevention
```typescript
export class ConsentManager {
  async checkConsent(
    senderAddress: string,
    recipientAddress: string
  ): Promise<boolean> {
    // Check if recipient has allowed sender
    const consent = await prisma.messageConsent.findFirst({
      where: {
        userAddress: recipientAddress,
        peerAddress: senderAddress,
        status: 'ALLOWED'
      }
    })

    return !!consent
  }

  async updateConsent(
    userAddress: string,
    peerAddress: string,
    status: 'ALLOWED' | 'BLOCKED'
  ): Promise<void> {
    await prisma.messageConsent.upsert({
      where: {
        userAddress_peerAddress: { userAddress, peerAddress }
      },
      create: { userAddress, peerAddress, status },
      update: { status }
    })
  }
}
```

## Development Checklist

### Week 1-2: Foundation ✅
- [ ] Set up XMTP node infrastructure
- [ ] Configure networking and TLS
- [ ] Implement identity registration
- [ ] Create database schema
- [ ] Set up development environment

### Week 2-3: Direct Messaging
- [ ] Implement conversation creation
- [ ] Build message sending/receiving
- [ ] Add message streaming
- [ ] Create inbox UI
- [ ] Implement conversation UI

### Week 3-4: Group Messaging
- [ ] Implement group creation
- [ ] Add member management
- [ ] Handle MLS epochs
- [ ] Build group UI
- [ ] Test group scaling

### Week 4-5: Real-time & Notifications
- [ ] Set up WebSocket server
- [ ] Implement message streaming
- [ ] Add push notifications
- [ ] Create typing indicators
- [ ] Build presence system

### Week 5-6: Search & Polish
- [ ] Implement message search
- [ ] Add content type support
- [ ] Build admin tools
- [ ] Performance optimization
- [ ] Security audit

### Testing & QA
- [ ] Unit tests for all services
- [ ] Integration tests
- [ ] Load testing
- [ ] Security testing
- [ ] UI/UX testing

## Monitoring & Operations

### Metrics to Track
```typescript
export const XmtpMetrics = {
  // Performance
  messageLatency: new Histogram({ name: 'xmtp_message_latency' }),
  encryptionTime: new Histogram({ name: 'xmtp_encryption_time' }),

  // Usage
  activeConversations: new Gauge({ name: 'xmtp_active_conversations' }),
  messagesPerSecond: new Counter({ name: 'xmtp_messages_per_second' }),

  // Errors
  failedDeliveries: new Counter({ name: 'xmtp_failed_deliveries' }),
  keyErrors: new Counter({ name: 'xmtp_key_errors' }),

  // Groups
  groupSize: new Histogram({ name: 'xmtp_group_size' }),
  epochChanges: new Counter({ name: 'xmtp_epoch_changes' })
}
```

### Logging Strategy
```typescript
export const XmtpLogger = {
  messageReceived: (msg: any) => {
    logger.info('Message received', {
      conversationId: msg.conversation.topic,
      senderAddress: msg.senderAddress,
      contentType: msg.contentType,
      timestamp: msg.sent
    })
  },

  error: (error: any, context: any) => {
    logger.error('XMTP error', {
      error: error.message,
      stack: error.stack,
      ...context
    })
  }
}
```

## Deployment Configuration

### Docker Compose
```yaml
version: '3.8'
services:
  xmtp-node:
    image: xmtp/node:latest
    environment:
      - XMTP_ENV=production
      - XMTP_LOG_LEVEL=info
      - DATABASE_URL=postgresql://...
      - REDIS_URL=redis://...
    ports:
      - "5555:5555"
    volumes:
      - xmtp-data:/data
    networks:
      - caw-network

  message-indexer:
    build: ./services/message-indexer
    environment:
      - NODE_ENV=production
      - DATABASE_URL=postgresql://...
    depends_on:
      - xmtp-node
      - postgres
    networks:
      - caw-network

networks:
  caw-network:
    external: true

volumes:
  xmtp-data:
```

## Edge Cases & Error Handling

### Common Issues & Solutions

#### Message Ordering
```typescript
// Handle out-of-order messages
async handleOutOfOrderMessage(message: any) {
  // Store in pending queue
  await this.pendingQueue.add(message)

  // Request missing messages
  const missing = await this.detectMissingMessages(message)
  if (missing.length > 0) {
    await this.requestMissingMessages(missing)
  }

  // Process queue when complete
  await this.processPendingQueue()
}
```

#### Network Failures
```typescript
// Retry logic with exponential backoff
async sendWithRetry(message: any, maxRetries = 3) {
  let attempt = 0
  let delay = 1000

  while (attempt < maxRetries) {
    try {
      return await this.send(message)
    } catch (error) {
      attempt++
      if (attempt === maxRetries) throw error

      await new Promise(resolve => setTimeout(resolve, delay))
      delay *= 2
    }
  }
}
```

## References & Resources

- [XMTP Documentation](https://docs.xmtp.org)
- [XMTP JavaScript SDK](https://github.com/xmtp/xmtp-js)
- [MLS Protocol Specification](https://messaginglayersecurity.rocks)
- [XMTP Community Forum](https://community.xmtp.org)
- [CAW Protocol Documentation](../README.md)

## Appendix: Migration from Existing DM System

If CAW already has a DM system, here's the migration strategy:

1. **Parallel Operation**: Run both systems initially
2. **Identity Migration**: Link existing users to XMTP identities
3. **Message Export**: Allow users to export old messages
4. **Gradual Transition**: Redirect new conversations to XMTP
5. **Legacy Shutdown**: Deprecate old system after migration

---

*Last Updated: January 2025*
*Version: 1.0.0*