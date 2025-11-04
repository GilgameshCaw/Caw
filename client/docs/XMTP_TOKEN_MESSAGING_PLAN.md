# Token-Based XMTP Messaging Architecture Plan

## Overview
Messaging remains token-based (not wallet-based) with proper handling for token transfers and encrypted content access.

## Core Principles

### 1. Token Identity Ownership
- Messages are sent TO and FROM token IDs (users)
- Each token has an associated XMTP identity
- When a token changes owners, the messaging history stays with the token
- New owner gets access to the conversation history but NOT the content

### 2. Encryption Key Management

#### Current Owner Access
- Current token owner's wallet address has access to encryption keys
- Can decrypt and read all NEW messages sent after ownership
- Can send new messages

#### Previous Owner Messages
- Messages sent by previous owners remain encrypted with their keys
- New owner sees these messages as "Content Unavailable"
- Preserves privacy while maintaining conversation continuity

### 3. Implementation Strategy

#### Database Schema
```prisma
model XmtpIdentity {
  userId           Int      @unique  // Token ID
  walletAddress    String   // Current owner's wallet
  encryptionKey    String?  // Current encryption key
  previousKeys     Json?    // Array of {walletAddress, encryptionKey, validUntil}
  // ... rest of fields
}

model Message {
  id               String
  conversationId   String
  senderId         Int      // Token ID
  senderWallet     String   // Wallet that sent the message
  content          String   // Encrypted content
  encryptionKeyId  String?  // Which key was used
  // ... rest of fields
}
```

#### Message Display Logic
```typescript
function displayMessage(message: Message, currentWallet: string) {
  // Check if current wallet can decrypt this message
  if (message.senderWallet === currentWallet) {
    // Current owner sent this - can decrypt
    return decryptContent(message.content)
  }

  // Check if message was sent after current ownership
  const ownershipStart = getOwnershipStartDate(currentWallet, message.senderId)
  if (message.createdAt > ownershipStart) {
    // Message sent during current ownership - can decrypt
    return decryptContent(message.content)
  }

  // Message from previous owner
  return "Content Unavailable - Message from previous token owner"
}
```

### 4. Token Transfer Flow

When a token is transferred:

1. **Update XMTP Identity**
   - Store current encryption key in `previousKeys` array
   - Update `walletAddress` to new owner
   - Generate new encryption key for new owner

2. **Conversation Access**
   - New owner sees all conversations
   - Can read conversation metadata (participants, timestamps)
   - Old messages show as "Content Unavailable"
   - Can send and receive new messages

3. **UI Indicators**
   - Gray out unavailable messages
   - Show lock icon with tooltip explaining why
   - Display sender's username but not content

### 5. Benefits of This Approach

- **Privacy Preserved**: Previous owners' messages remain private
- **Continuity Maintained**: Conversation history stays with token
- **Social Graph Intact**: New owner inherits social connections
- **Clear Ownership**: Messages clearly tied to token identity
- **Future Proof**: Can add message export/backup for owners

### 6. Implementation Phases

#### Phase 1: Foundation (Current)
- Basic token-based messaging working
- Simple encryption with single key

#### Phase 2: Ownership Tracking
- Add `senderWallet` to messages
- Track wallet addresses in XMTP identity
- Implement "Content Unavailable" display

#### Phase 3: Key Rotation
- Implement `previousKeys` storage
- Key rotation on transfer
- Proper key selection for decryption

#### Phase 4: Enhanced UX
- Visual indicators for unavailable content
- Ownership timeline view
- Message export for current owners

### 7. Edge Cases Handled

- **Rapid Token Trading**: Each owner period has distinct keys
- **Reclaimed Tokens**: If original owner gets token back, their old messages remain unavailable
- **Multi-device**: Each device uses same token identity but different installation IDs
- **Conversation Participants**: Both sides see same availability rules

## Next Steps

1. Implement `senderWallet` tracking in messages
2. Add "Content Unavailable" UI component
3. Create ownership tracking service
4. Test with token transfer scenarios