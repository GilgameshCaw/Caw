# Direct Messaging

End-to-end encrypted direct messaging for CAW Protocol. Messages are stored in PostgreSQL but encrypted client-side — the server never sees plaintext.

## Architecture

```
User A (browser)                     Server                     User B (browser)
     │                                  │                              │
     │  sign("Enable DMs\n@alice")      │                              │
     │  → derive secp256k1 keypair      │                              │
     │  → POST /api/dm/identity {pubkey}│                              │
     │─────────────────────────────────>│                              │
     │                                  │  store pubkey in DmIdentity  │
     │                                  │                              │
     │  GET /api/dm/identity/:bobId     │                              │
     │─────────────────────────────────>│                              │
     │  ← bob's public key             │                              │
     │                                  │                              │
     │  ECDH(myPrivKey, bobPubKey)      │                              │
     │  → sharedSecret (AES-256 key)   │                              │
     │                                  │                              │
     │  AES-GCM encrypt(plaintext)     │                              │
     │  POST /api/dm/messages           │                              │
     │    { encryptedPayload }         │                              │
     │─────────────────────────────────>│  store encrypted blob        │
     │                                  │  WebSocket → user:bob        │
     │                                  │─────────────────────────────>│
     │                                  │              ECDH + decrypt  │
```

## Encryption

### Key Derivation

1. User signs a deterministic message: `"CAW Protocol\nEnable DMs\n@{username}"`
2. `SHA-256(signature)` → 32-byte secp256k1 private key
3. Compressed public key (33 bytes, hex) is derived and sent to the server
4. Same wallet + username always produces the same keypair (deterministic, no storage needed)

### Message Encryption (AES-256-GCM)

1. Shared secret: `SHA-256(secp256k1.getSharedSecret(myPrivKey, theirPubKey))`
2. Import as AES-GCM CryptoKey via Web Crypto API
3. Per-message: random 12-byte IV → AES-GCM encrypt → `base64(IV || ciphertext || tag)`
4. Stored in DB as `encryptedPayload` — server cannot decrypt

### What's NOT Encrypted

- Participant identity (who is in the conversation)
- Conversation ID (deterministic: `dm:{min_id}:{max_id}`)
- Timestamps, read receipts, typing indicators
- DM privacy settings

## Privacy Controls

Users set `dmPrivacy` on their DmIdentity:

| Setting | Who can message them |
|---------|---------------------|
| `EVERYONE` | Any user with a DM identity |
| `FOLLOWERS` | Only users they follow |
| `FOLLOWING` | Only users who follow them |

Privacy is enforced at conversation creation and message send time. Messages to
privacy-denied recipients are "shadow-blocked" — the sender sees them, the
recipient doesn't.

## Real-Time Delivery

WebSocket server on `/dm-ws/` using Socket.IO:

- Auth via `x-session-token` (same as REST API)
- Rooms: `user:{userId}`, `conversation:{conversationId}`
- Events: `new-message`, `message-edited`, `message-deleted`, `user-typing`, `message-read`

## Multi-Instance Relay

When multiple CAW instances are running (registered via the on-chain
`ClientManager` contract), messages are relayed between instances:

1. Instance A stores message locally
2. Instance A sends `POST /api/dm/relay` to all peer instances
3. Peers validate: timestamp within 5-min window, signature recovery, privacy rules
4. Fire-and-forget — best effort delivery

## Database Models

- **DmIdentity** — userId, walletAddress, publicKey (hex), dmPrivacy setting
- **Conversation** — deterministic ID, participants (M:M), last message tracking
- **Message** — UUID, conversationId, senderId, encryptedPayload, contentType (text/deleted)
- **MessageReceipt** — per-user read tracking
- **MessageDeletion** — per-user message deletion

## Key Files

| Component | Path |
|-----------|------|
| Crypto service | `client/src/services/FrontEnd/src/services/DmCryptoService.ts` |
| DM hooks | `client/src/services/FrontEnd/src/hooks/useDm.ts` |
| API routes | `client/src/api/routes/dm.ts` |
| Relay routes | `client/src/api/routes/dm-relay.ts` |
| WebSocket server | `client/src/services/DmService/websocket.ts` |
| Relay service | `client/src/services/DmRelayService/index.ts` |
| Auth (DM key reg) | `client/src/api/routes/auth.ts` (`verify-dm` endpoint) |
