# Session Keys (Quick Sign)

Session keys let users delegate signing authority to a device-local ephemeral key, so they don't have to approve every post, like, or follow in their wallet. The delegation is scoped, time-limited, and spend-capped on-chain.

## How It Works

```
1. User clicks "Enable Quick Sign" in Settings
2. Frontend generates a fresh ECDSA keypair (viem)
3. User signs a human-readable message with their wallet (personal_sign):

     Enable Quick Sign
     ------------------
     Spend limit:
     5M CAW

     Expires:
     25 April 2026 00:00:00 UTC

     CAW Key:
     0x742d...3e

4. Validator submits registerSessionPersonal() on L2
5. On-chain: sessions[ownerAddress][sessionKeyAddress] = {expiry, scope, spendLimit}
6. From now on, the frontend signs actions with the local key — no wallet popup
```

## Scope

Session keys can sign every action type **except WITHDRAW**. The contract enforces this — bit 6 can never be set in the scope bitmap:

```solidity
require((scopeBitmap & 0x40) == 0, "Cannot delegate WITHDRAW");
```

The standard scope bitmap is `0xBF` (all bits set except bit 6), which covers:

| Action | Bit | Protocol Cost |
|--------|-----|---------------|
| CAW (post) | 0 | 5,000 CAW |
| LIKE | 1 | 2,000 CAW |
| UNLIKE | 2 | 0 |
| RECAW | 3 | 4,000 CAW |
| FOLLOW | 4 | 30,000 CAW |
| UNFOLLOW | 5 | 0 |
| OTHER (tips, profile) | 7 | varies |

A session key **cannot** withdraw tokens or transfer the NFT — those require a direct wallet signature.

## Spend Limit

Each session tracks cumulative spending on-chain:

```solidity
mapping(address owner => mapping(address sessionKey => uint256 spent)) public sessionSpent;
```

On every action signed by a session key, the contract increments `sessionSpent` by the total action cost (protocol cost + validator tip + any distributed amounts) and reverts if it exceeds the `spendLimit`.

**User-configurable presets**: $5, $10, $25, $100 (converted to CAW at current price), or custom amount. Default is ~$5 USD equivalent.

The spend limit is cumulative and never resets — once exhausted, the user creates a new session.

## Expiry

Sessions have an on-chain expiry timestamp (`uint64`). The contract checks `expiry > block.timestamp` on every action. Maximum duration enforced server-side: **30 days**.

**Duration presets**: 1 week, 1 month, 3 months, 6 months, 1 year.

## Tip Ceiling

At activation, the user locks a maximum tip-per-action. The frontend enforces this as a ceiling when building action data, preventing validators from extracting more than the user agreed to.

## Key Storage

Two modes, chosen at activation:

### Unencrypted (default)
- Private key stored as plaintext in localStorage
- Immediately available on page load — no wallet interaction needed
- Appropriate for small spend limits

### Encrypted (wallet-protected)
- Private key encrypted with AES-256-GCM before storage
- Encryption key derived from a wallet signature via PBKDF2 (100k iterations)
- Plaintext key exists in memory only — cleared on page close
- On page load, user must sign once to decrypt (or receives key from another open tab via BroadcastChannel)
- Auto-enabled when spend limit is set to unlimited

## Revocation

Users can revoke a session key anytime from Settings:

1. The session key signs a `RevokeSession` EIP-712 message
2. Validator submits `revokeSessionBySig()` on L2
3. On-chain: `delete sessions[owner][sessionKey]`
4. All future actions signed by that key are rejected
5. Local key cleared from memory and localStorage

## Security Model

### What a session key CAN do
- Sign posts, likes, recaws, follows, unfollows, tips, profile updates
- Spend up to the configured limit in CAW tokens

### What a session key CANNOT do
- Withdraw tokens from the user's staked balance
- Transfer the NFT
- Exceed the spend limit (enforced on-chain)
- Act after expiry (enforced on-chain)
- Sign action types outside its scope bitmap (enforced on-chain)

### Device compromise scenario

If an attacker extracts the key from localStorage:
- They can sign actions until the **spend limit** is exhausted or the **session expires**
- They **cannot** withdraw funds or transfer the NFT
- The user can **revoke** the session at any time to cut off access
- With encryption enabled, the attacker gets only ciphertext (useless without a wallet signature)

### Defense in depth

| Layer | Protection |
|-------|-----------|
| Scope bitmap | WITHDRAW permanently excluded (contract-enforced) |
| Spend limit | Cumulative cap on total CAW spent (contract-enforced) |
| Expiry | Time-limited delegation (contract-enforced) |
| Tip ceiling | Max tip per action (frontend-enforced) |
| Encryption | Optional AES-256-GCM for key-at-rest (device-level) |
| Revocation | Instant on-chain deletion via signed message |

## On-Chain Storage

```solidity
// CawProfileL2.sol
struct StoredSession {
  uint64  expiry;        // Unix timestamp (seconds)
  uint8   scopeBitmap;   // Action type authorization
  uint256 spendLimit;    // Max cumulative CAW (whole tokens)
}

mapping(address => mapping(address => StoredSession)) public sessions;
mapping(address => uint256) public sessionNonce;  // Replay protection
```

## Key Files

| Component | Path |
|-----------|------|
| On-chain session storage | `solidity/contracts/CawProfileL2.sol` (sessions mapping, registerSession) |
| On-chain verification | `solidity/contracts/CawActions.sol` (_verifySignatureMem, sessionSpent) |
| Session key store | `client/src/services/FrontEnd/src/store/sessionKeyStore.ts` |
| Session key hook | `client/src/services/FrontEnd/src/hooks/useSessionKey.ts` |
| Key encryption | `client/src/services/FrontEnd/src/services/sessionKeyEncryption.ts` |
| Quick Sign modal | `client/src/services/FrontEnd/src/components/modals/QuickSignModal.tsx` |
| Action signing | `client/src/services/FrontEnd/src/api/actions.ts` |
| Registration API | `client/src/api/routes/sessions.ts` |
