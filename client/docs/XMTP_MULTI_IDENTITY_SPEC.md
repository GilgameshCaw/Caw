# XMTP Multi-Identity Support Specification

## Overview

The CAW platform supports multiple identities in the same browser session:
1. **Multiple wallet addresses** - Users can switch between different wallet addresses
2. **Multiple tokens per address** - Users can switch between different CAW NFT tokens owned by the same address

Each combination of (wallet address + NFT token) represents a distinct identity for messaging purposes.

## Architecture

### Client Storage by Wallet Address

XMTP clients are stored in a module-level Map keyed by wallet address:

```typescript
const clientsByAddress = new Map<string, Client>();
const initPromisesByAddress = new Map<string, Promise<Client>>();
```

**Key Design Decisions:**

1. **One XMTP client per wallet address** - Since XMTP authentication is tied to the wallet's cryptographic keys, each address gets its own client
2. **NFT tokens share the same client** - Multiple CAW tokens owned by the same address reuse the same XMTP client
3. **Address as key** - Addresses are normalized to lowercase for consistent lookups

### State Management

The `useXmtpCore()` hook manages state reactively:

```typescript
useEffect(() => {
  if (address) {
    const addressKey = address.toLowerCase();
    const existingClient = clientsByAddress.get(addressKey);
    if (existingClient) {
      // Load existing client for this address
      setXmtpClient(existingClient);
      setIsInitialized(true);
    } else {
      // No client for this address yet
      setXmtpClient(null);
      setIsInitialized(false);
    }
  }
}, [address]);
```

**Behavior:**

- When address changes (wallet switch or token switch with different owner), the hook loads the appropriate client
- If client exists for that address, it's immediately available (no re-initialization needed)
- If no client exists, user must click "Initialize XMTP" to create one

## User Scenarios

### Scenario 1: Single Address, Multiple Tokens

**Setup:**
- Wallet address: `0xABC...123`
- Tokens owned: `cawuser1`, `cawuser2`, `cawuser3`

**Flow:**
1. User connects wallet `0xABC...123`
2. User selects token `cawuser1`
3. User clicks "Initialize XMTP"
   - XMTP client created for `0xabc...123` (lowercased)
   - Client stored in `clientsByAddress`
4. User switches to token `cawuser2` (same address)
   - Hook detects address is still `0xabc...123`
   - Existing client loaded automatically
   - ✅ **No re-initialization needed**
5. User switches to token `cawuser3` (same address)
   - Same existing client loaded
   - ✅ **No re-initialization needed**

**Result:** All three tokens share the same XMTP client. Messages sent from different tokens are distinguished by:
- Display name (from NFT metadata)
- Username (token name)
- But use the same wallet address for XMTP encryption

### Scenario 2: Multiple Addresses (Wallet Switch)

**Setup:**
- Address A: `0xABC...123` (owns `cawuser1`)
- Address B: `0xDEF...456` (owns `cawuser2`)

**Flow:**
1. User connects Address A
2. User selects `cawuser1`, initializes XMTP
   - Client created for `0xabc...123`
3. User disconnects and connects Address B
4. User selects `cawuser2`
   - Hook detects address changed to `0xdef...456`
   - No client exists for this address
   - State shows "not initialized"
5. User clicks "Initialize XMTP" for Address B
   - New client created for `0xdef...456`
   - Both clients coexist in `clientsByAddress`
6. User switches back to Address A
   - Hook loads existing client for `0xabc...123`
   - ✅ **No re-initialization needed**

**Result:** Each address maintains its own XMTP client. Switching addresses automatically loads the appropriate client.

### Scenario 3: Mixed Ownership

**Setup:**
- Address A owns: `token1`, `token2`
- Address B owns: `token3`
- Address A also owns: `token4`

**Flow:**
1. User connects Address A, selects `token1`, initializes XMTP
   - Client created for Address A
2. User switches to `token2` (Address A)
   - Same client loaded ✅
3. User switches wallets to Address B, selects `token3`
   - Different address detected
   - Must initialize XMTP for Address B
4. User switches back to Address A, selects `token4`
   - Existing client for Address A loaded ✅

## Implementation Details

### Client Initialization

```typescript
async function ensureClient(xmtpSigner: XmtpSigner, walletAddress: string): Promise<Client> {
  const addressKey = walletAddress.toLowerCase();

  // Return existing client if available
  const existingClient = clientsByAddress.get(addressKey);
  if (existingClient) return existingClient;

  // Check if initialization in progress
  const existingPromise = initPromisesByAddress.get(addressKey);
  if (existingPromise) return existingPromise;

  // Create new client
  const initPromise = Client.create(xmtpSigner, { env, appVersion })
    .then(client => {
      clientsByAddress.set(addressKey, client);
      return client;
    })
    .catch(error => {
      initPromisesByAddress.delete(addressKey); // Allow retry
      throw error;
    });

  initPromisesByAddress.set(addressKey, initPromise);
  return initPromise;
}
```

### WebSocket Integration

WebSocket connections are managed separately and use:
- `userId` - The NFT token ID (changes per token)
- `username` - The NFT token name (changes per token)
- Both hooks (`useXmtpWebSocket` and `useMessageNotifications`) reconnect when these change

This allows the server to:
- Track which specific token is online
- Route messages to the correct user identity
- Show online status per token, not just per address

## Testing Checklist

- [ ] Initialize XMTP with Address A, Token 1
- [ ] Switch to Token 2 (same address) - should not require re-init
- [ ] Switch to Token 3 (same address) - should not require re-init
- [ ] Switch wallet to Address B, Token 4 - should require init
- [ ] Switch back to Address A, any token - should not require re-init
- [ ] Send messages from different tokens of same address - should work
- [ ] Send messages from different addresses - should work
- [ ] Receive messages while switching tokens - should work
- [ ] WebSocket should reconnect with new userId/username on token switch

## Future Considerations

### Potential Issues

1. **Storage limits** - Browser storage for XMTP databases is per-origin. With many addresses, storage could become large.
2. **Memory usage** - Each client maintains its own state. Many clients could consume significant memory.
3. **Cleanup** - Currently no mechanism to remove old/unused clients.

### Possible Enhancements

1. **Client pruning** - Add LRU cache to remove least-recently-used clients
2. **Explicit disconnect** - Add UI to disconnect/remove specific addresses
3. **Storage monitoring** - Warn users if approaching storage limits
4. **Shared conversations** - Currently conversations are per-address. Could add UI to view all conversations across addresses.

## API Reference

### Key Functions

#### `ensureClient(signer, address)`
Creates or retrieves XMTP client for given address.

**Parameters:**
- `signer: XmtpSigner` - Wallet signer for this address
- `address: string` - Wallet address (will be lowercased)

**Returns:** `Promise<Client>`

**Behavior:**
- Returns existing client if already initialized
- Waits for in-progress initialization if applicable
- Creates new client if none exists
- Stores client in global Map

#### `useXmtpCore()`
React hook providing XMTP client state.

**Returns:**
```typescript
{
  xmtpClient: Client | null,
  isInitialized: boolean,
  isLoading: boolean,
  error: Error | null,
  initializeClient: () => Promise<void>
}
```

**Behavior:**
- Automatically syncs with `wagmi` address changes
- Loads existing client when address matches
- Resets to uninitialized when address has no client

## Diagram

```
┌─────────────────────────────────────────────────┐
│                Browser Window                    │
│                                                  │
│  ┌────────────────────────────────────────────┐ │
│  │         clientsByAddress Map               │ │
│  │                                            │ │
│  │  "0xabc...123" → Client A ────────┐       │ │
│  │                      │             │       │ │
│  │  "0xdef...456" → Client B          │       │ │
│  │                      │             │       │ │
│  └──────────────────────┼─────────────┼───────┘ │
│                         │             │         │
│  ┌─────────────────────┼─────────────┼───────┐ │
│  │  Token Selection    │             │       │ │
│  │                     │             │       │ │
│  │  cawuser1 (0xABC..123) ───────────┘       │ │
│  │  cawuser2 (0xABC..123) ───────────┐       │ │
│  │  cawuser3 (0xDEF..456) ────────────┼───────┘ │
│  │                                    │         │
│  │  All tokens with same address      │         │
│  │  share the same XMTP client        │         │
│  └────────────────────────────────────┘         │
└─────────────────────────────────────────────────┘
```

