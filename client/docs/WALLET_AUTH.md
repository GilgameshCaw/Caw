# Wallet Signature Authentication

## Overview

Session-based authentication system that proves wallet ownership via cryptographic signatures. Users can browse the app freely (read-only), but write operations require proving they own the wallet associated with the target tokenId.

## How It Works

### Session Tokens

- Stored in **Redis** (server) and **localStorage** (client)
- 2-year expiry
- One session can authorize **multiple addresses and tokenIds**
- Redis key pattern: `caw:session:<token>`
- localStorage key: `caw-auth-session`

### Authentication Flow

There are two ways a session accumulates authorized tokenIds:

#### 1. Passive Auth (automatic, invisible to user)

When a user submits a signed on-chain action via `POST /api/actions`:

1. Server reads the `x-session-token` header
2. Looks up the sender's address from the database
3. If that address isn't already in the session, verifies the EIP-712 signature using `ethers.verifyTypedData()`
4. If the recovered signer matches the sender's address, all tokenIds owned by that address are added to the session

This means most users get authenticated automatically just by using the app normally (posting, liking, following, etc.). The verification only runs once per address — subsequent actions from the same address skip it.

#### 2. Explicit Auth (fallback modal)

When a protected endpoint returns 401 and the user hasn't been passively authenticated yet:

1. Frontend catches the 401 response
2. Opens the `VerifyWalletModal`
3. User clicks "Verify" which triggers a `personal_sign` request in their wallet
4. Message format: `Verify wallet ownership for CAW\nTimestamp: <unix_seconds>`
5. Signature is sent to `POST /api/auth/verify`
6. Server recovers the address via `ethers.verifyMessage()`, looks up tokenIds, adds them to the session

This is free (no gas) and only needed if the user hasn't submitted any signed actions yet.

## API Endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/auth/verify` | POST | Verify wallet via personal_sign, returns/creates session |
| `/api/auth/session` | GET | Get current session state (authorized tokenIds/addresses) |
| `/api/auth/logout` | POST | Delete session |

### POST /api/auth/verify

**Request:**
```json
{
  "message": "Verify wallet ownership for CAW\nTimestamp: 1710590400",
  "signature": "0x..."
}
```

**Headers:** `x-session-token` (optional — creates new session if missing)

**Response:**
```json
{
  "sessionToken": "abc123...",
  "authorizedTokenIds": [1, 4, 7],
  "authorizedAddresses": ["0xabc..."],
  "expiresAt": 1773662400000
}
```

## Protected Endpoints

These endpoints require a valid session with authorization for the target tokenId:

| Endpoint | Auth Method |
|---|---|
| `POST /api/notifications/read` | userId from body |
| `PATCH /api/notifications/:id/hide` | userId from body |
| `POST /api/on-chain-images` | userId from body |
| `PATCH /api/on-chain-images/:id/ignore` | userId from image record |
| `PATCH /api/on-chain-images/mark-posted` | userId from body |
| `POST /api/upload` | tokenId from body |
| `POST /api/caws/:id/dismiss` | userId from caw record |

### Admin-Only Endpoints

These use the separate `requireAdmin` bearer token auth:

| Endpoint | Purpose |
|---|---|
| `PATCH /api/on-chain-images/:id/status` | Internal (ValidatorService) |
| `GET /api/reports` | Admin report viewing |
| `PATCH /api/reports/:id` | Admin report status updates |
| `GET /api/bug-reports` | Admin bug report viewing |
| `PATCH /api/bug-reports/:id` | Admin bug report updates |

### Rate-Limited Endpoints

Rate limits are tiered based on authentication status:

| Endpoint | Unauthenticated | Authenticated |
|---|---|---|
| `POST /api/upload` | 10 per day per IP | 30 per 15 minutes per IP |
| `POST /api/shorturl` | 10 per day per IP | 60 per 15 minutes per IP |

Unauthenticated users who hit the limit see a message suggesting they verify their wallet to increase it.

## Key Files

### Server
- `src/api/sessionStore.ts` — Redis session CRUD operations
- `src/api/middleware/auth.ts` — `requireAuth()` middleware, `requireAdmin`, `extractSession`
- `src/api/routes/auth.ts` — Auth API endpoints (verify, session, logout)
- `src/api/routes/actions.ts` — Passive auth accumulation block

### Frontend
- `src/services/FrontEnd/src/store/authStore.ts` — Zustand persisted session store
- `src/services/FrontEnd/src/store/verifyWalletStore.ts` — Modal state
- `src/services/FrontEnd/src/components/modals/VerifyWalletModal.tsx` — Verification UI
- `src/services/FrontEnd/src/api/client.ts` — `apiFetch` (auto-attaches session token, handles 401), `getAuthHeaders()` helper

## Error Codes

The middleware returns two distinct 401 error codes so the frontend can respond appropriately:

- `AUTH_REQUIRED` — No valid session token provided. Frontend should trigger verification.
- `TOKEN_NOT_AUTHORIZED` — Session exists but doesn't cover the target tokenId. Frontend should trigger verification for the specific wallet.

## Design Decisions

- **Redis over in-memory Map**: Sessions survive server restarts. Redis is already running for the ViewTracker.
- **2-year expiry**: Users shouldn't have to re-verify often. The wallet itself is the ultimate security — the session token only authorizes API writes, not fund transfers.
- **Passive auth only verifies once per address**: Avoids redundant `verifyTypedData` calls on every action submission.
- **personal_sign for fallback**: Simpler and cheaper than EIP-712. No on-chain processing needed — it's purely for server-side identity verification.
- **Multi-account sessions**: Users who control multiple wallets/profiles can authorize all of them under one session, matching the existing profile-switching UX.
