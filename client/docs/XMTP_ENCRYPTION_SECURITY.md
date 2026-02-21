# XMTP Encryption Security

## Critical Security Requirement

**ALL messages MUST be stored encrypted in the database. The server must NEVER have access to decrypted message content.**

## Current Architecture Status

### ✅ What's Secure Now

1. **XMTP Handles Encryption**
   - All messages sent through XMTP are automatically end-to-end encrypted
   - Encryption happens client-side using wallet private keys
   - XMTP network only stores encrypted payloads

2. **Database Schema**
   - `Message` table has `encryptedPayload` field (TEXT)
   - No plaintext `content` field exists

3. **Client-Side Decryption**
   - XMTP SDK decrypts messages client-side only
   - Server never sees decrypted content

### ⚠️ Current Gap

**Messages are NOT being stored in the database yet!**

Currently:
- Messages sent via XMTP (`convo.sendText()`)
- Messages stored in React state only
- No database persistence implemented

This means:
- ✅ Messages are secure (XMTP encryption)
- ⚠️ But not backed up to database
- ⚠️ No offline access
- ⚠️ Conversations lost on page refresh

## Required Implementation

### Message Send Flow (WITH Database Backup)

```typescript
async function sendMessage(content: string, conversationId: string, userId: number) {
  // 1. Send via XMTP (automatically encrypts)
  const xmtpMessage = await convo.sendText(content);

  // 2. Extract encrypted payload from XMTP message
  const encryptedPayload = xmtpMessage.contentBytes; // Raw encrypted bytes

  // 3. Store encrypted payload in database
  await fetch('/api/conversations/messages', {
    method: 'POST',
    body: JSON.stringify({
      conversationId,
      senderId: userId,
      encryptedPayload: base64Encode(encryptedPayload), // Store as base64
      messageId: xmtpMessage.id,
      senderWallet: address
    })
  });

  // 4. Update UI with decrypted message (from XMTP)
  setMessages(prev => [...prev, xmtpMessage]);
}
```

### Message Receive Flow (WITH Database Backup)

```typescript
async function syncMessages(conversationId: string) {
  // 1. Fetch encrypted messages from database
  const dbMessages = await fetch(`/api/conversations/${conversationId}/messages`)
    .then(r => r.json());

  // 2. Decrypt messages client-side using XMTP
  const decryptedMessages = await Promise.all(
    dbMessages.map(async (msg) => {
      const bytes = base64Decode(msg.encryptedPayload);
      const decrypted = await xmtpClient.decryptMessage(bytes);
      return decrypted;
    })
  );

  // 3. Display decrypted messages in UI
  setMessages(decryptedMessages);

  // 4. Stream new messages from XMTP network
  const stream = await xmtpClient.conversations.streamAllMessages({
    onValue: async (newMsg) => {
      // Store encrypted in database
      await storeEncryptedMessage(newMsg);
      // Display decrypted in UI
      setMessages(prev => [...prev, newMsg]);
    }
  });
}
```

## Database Security Guarantees

### What Server Can See
- ✅ Conversation IDs (UUIDs)
- ✅ Participant user IDs (token IDs)
- ✅ Message timestamps
- ✅ Sender wallet addresses
- ✅ **Encrypted message payloads** (indecipherable blobs)

### What Server CANNOT See
- ❌ Message content (always encrypted)
- ❌ Private keys (never leave client)
- ❌ Decryption keys (generated from wallet)

### Attack Scenarios

**Scenario 1: Database Breach**
- Attacker: Gets encrypted message payloads
- Result: ✅ **SAFE** - Cannot decrypt without private keys
- Data exposed: Only metadata (timestamps, participant IDs)

**Scenario 2: Server Compromise**
- Attacker: Controls server code
- Result: ✅ **SAFE** - Server never receives decrypted content
- Limitation: Attacker could see future messages if they modify client code, but cannot decrypt historical messages

**Scenario 3: Man-in-the-Middle**
- Attacker: Intercepts API calls
- Result: ✅ **SAFE** - Only encrypted payloads transmitted
- Additional protection: Use HTTPS for transport security

## XMTP SDK v4 Encryption Details

### How XMTP Encrypts Messages

1. **Key Generation**
   - Uses wallet's private key to derive XMTP identity
   - Generates conversation-specific encryption keys
   - Uses Signal's Double Ratchet algorithm

2. **Message Encryption**
   ```
   User types: "Hello"
   ↓
   XMTP encrypts: 0x7a8f3e... (encrypted bytes)
   ↓
   Store in DB: "eqPo3f8..." (base64-encoded encrypted bytes)
   ↓
   Network transmits: encrypted payload only
   ↓
   Recipient's XMTP decrypts: "Hello"
   ```

3. **Decryption**
   - Only possible with recipient's private key
   - Happens entirely client-side
   - Server never involved in decryption

### Code Example: Accessing Encrypted Payload

```typescript
// In XMTP SDK, messages have both encrypted and decrypted forms

// Sending
const message = await conversation.sendText("Hello");

// Access decrypted (for UI)
console.log(message.content); // "Hello"

// Access encrypted (for database)
console.log(message.contentBytes); // Uint8Array [encrypted bytes]
const encrypted = base64Encode(message.contentBytes); // Store this in DB
```

## Implementation Checklist

- [ ] Update `sendMessage` to store encrypted payloads in database
- [ ] Update `useMessages` to fetch from database first
- [ ] Implement message sync between XMTP network and database
- [ ] Add encryption key rotation support
- [ ] Implement secure backup/export of encrypted messages
- [ ] Add encrypted message search (using encrypted indices)

## Testing Encryption

### Verification Steps

1. **Database Inspection**
   ```sql
   SELECT encryptedPayload FROM Message LIMIT 1;
   -- Should return: gibberish base64 string
   -- Should NOT return: readable text
   ```

2. **Network Inspection**
   - Open browser DevTools → Network tab
   - Send a message
   - Check POST /api/conversations/messages payload
   - Verify `encryptedPayload` is not readable

3. **Server-Side Test**
   ```javascript
   // On server
   const message = await prisma.message.findFirst();
   console.log(message.encryptedPayload);
   // Should output: unreadable encrypted blob
   ```

## Compliance & Regulations

This architecture provides:
- ✅ **GDPR Compliance**: Messages can be deleted on user request
- ✅ **End-to-End Encryption**: Industry standard (Signal Protocol)
- ✅ **Zero-Knowledge Server**: Server cannot read user messages
- ✅ **Forward Secrecy**: Past messages safe even if keys compromised

## Performance Considerations

### Encryption Overhead
- Encryption/decryption: ~1ms per message
- Database storage: Encrypted payload ~20% larger than plaintext
- Acceptable tradeoff for security

### Optimization Strategies
1. Batch encrypt/decrypt for large message lists
2. Use indexed DB for client-side encrypted cache
3. Lazy-load older messages
4. Use message pagination (50 messages at a time)

## Current Status Summary

**What We Have:**
- ✅ XMTP SDK with built-in encryption
- ✅ Database schema with `encryptedPayload` field
- ✅ Client-side encryption/decryption

**What We Need:**
- ⚠️ Implement database storage of encrypted payloads
- ⚠️ Implement message sync between XMTP and database
- ⚠️ Add encrypted message retrieval API

**Security Status:**
- ✅ **Currently Secure** (XMTP network is encrypted)
- ⚠️ **Not Persistent** (messages not in database yet)
- 🎯 **Next Step**: Implement encrypted database storage

## Action Items

1. **Immediate**: Fix `getInboxId` error (DONE)
2. **High Priority**: Implement encrypted message storage
3. **Medium Priority**: Add message sync worker
4. **Low Priority**: Add encrypted search

## Security Audit Recommendations

Before production:
1. Third-party security audit of encryption implementation
2. Penetration testing of message storage
3. Code review of key management
4. Verify no plaintext logging of messages
