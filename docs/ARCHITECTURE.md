# CAW Protocol Architecture Documentation

## Table of Contents
1. [Overview](#overview)
2. [Core Principles](#core-principles)
3. [System Architecture](#system-architecture)
4. [Data Flow](#data-flow)
5. [Components](#components)
6. [Database Schema](#database-schema)
7. [Deployment Architecture](#deployment-architecture)
8. [Security Considerations](#security-considerations)

## Overview

CAW Protocol is a decentralized social network built on blockchain technology, designed to ensure freedom of speech through trustless and censorship-resistant architecture. The system uses a unique hybrid approach where the blockchain serves as the immutable source of truth, while off-chain components provide scalability and user experience enhancements.

### Key Features
- **Decentralized**: No single point of control or failure
- **Trustless**: Actions are cryptographically signed and verified
- **Censorship-resistant**: Content stored on blockchain cannot be removed
- **Cross-chain archiving**: Actions replicated to multiple chains via LayerZero
- **Scalable**: Off-chain processing with on-chain settlement
- **Multi-chain**: Supports both L1 (Ethereum) and L2 (Base) deployments

## Core Principles

### 1. Blockchain as Source of Truth
- All social actions (posts, likes, follows) are ultimately stored on-chain
- Smart contracts validate and process actions
- Events emitted by contracts serve as the canonical record

### 2. Optimistic UI Updates
- Users see immediate feedback when taking actions
- Actions are marked as "PENDING" in the database
- UI updates optimistically while waiting for blockchain confirmation

### 3. Validator Network
- Anyone can run a validator node
- Validators batch and submit pending actions to the blockchain
- Validators earn rewards through tips attached to actions

### 4. Status Lifecycle
Actions follow this lifecycle:
```
User Action → PENDING → Validator Processing → On-chain Submission → SUCCESS/FAILED
```

## System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         User Interface                           │
│                    (React Frontend - Vite)                       │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                         API Server                               │
│                     (Express + Redis)                            │
│  • Receives signed actions from users                            │
│  • Stores pending actions in TxQueue                             │
│  • Serves indexed data from database                             │
└────────┬───────────────────────────────────┬────────────────────┘
         │                                   │
         ▼                                   ▼
┌──────────────────────┐           ┌──────────────────────────────┐
│    TxQueue Table     │           │     PostgreSQL Database       │
│  (Pending Actions)   │           │   (Indexed Blockchain Data)   │
└──────────────────────┘           └──────────────────────────────┘
         │                                   ▲
         ▼                                   │
┌──────────────────────────────────────────────────────────────────┐
│                      Validator Service                           │
│  • Polls TxQueue for pending actions                             │
│  • Validates and batches actions                                 │
│  • Submits to blockchain via smart contracts                     │
│  • Updates status: PENDING → SUCCESS/FAILED                      │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────────────────────┐
│                    Smart Contracts                               │
│  • CawActions.sol - Core action processing                       │
│  • CawProfile.sol - Name service (L1/L2)                           │
│  • CawNetworkManager.sol - Network registry                      │
│  • LayerZero integration for cross-chain                        │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────────────────────┐
│                 Blockchain Events (Source of Truth)              │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────────────────────┐
│                   RawEventsGatherer Service                      │
│  • Listens to blockchain events via WebSocket                    │
│  • Stores raw events in BlockchainEvent table                    │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────────────────────┐
│                    ActionProcessor Service                       │
│  • Processes raw blockchain events                               │
│  • Creates indexed data (Caws, Likes, Follows, Users)           │
│  • Handles hashtag extraction and processing                     │
│  • Updates notification system                                   │
└──────────────────────────────────────────────────────────────────┘
```

## Data Flow

### 1. New Action Creation (e.g., posting a CAW)

```
1. User creates content in UI
2. Frontend signs action with user's wallet (EIP-712)
3. POST to API: /api/actions
4. API validates signature and stores in:
   - TxQueue (status: 'pending')
   - Caw table (status: 'PENDING')
5. Processes hashtags immediately
6. Returns success to frontend (optimistic update)
```

### 2. Validator Processing

```
1. ValidatorService polls TxQueue every 3 seconds
2. Filters for status='pending' entries
3. Groups actions by type and validates:
   - Signature verification
   - Nonce checking (prevents duplicates)
   - Cost validation (CAW tokens for content)
4. Simulates transaction on-chain
5. If simulation succeeds:
   - Batches multiple actions
   - Submits to blockchain
   - Waits for confirmation
6. Updates database:
   - TxQueue: status → 'done' or 'failed'
   - Caw: status → 'SUCCESS' or 'FAILED'
```

### 3. Blockchain Event Processing

```
1. RawEventsGatherer listens to contract events
2. Stores raw events in BlockchainEvent table
3. ActionProcessor receives events via Redis pub/sub
4. Creates/updates indexed data:
   - Creates Action record
   - Processes domain effects (Caws, Likes, Follows)
   - Extracts and indexes hashtags
   - Generates notifications
5. Updates Elasticsearch for search functionality
```

### 4. Timeout and Retry Logic

```
1. RPC calls have 60-second timeout (with exponential backoff)
2. If timeout occurs:
   - Action remains 'pending' (not marked as failed)
   - Will be retried in next polling cycle
3. Only legitimate failures marked as 'failed':
   - Invalid signature
   - Duplicate nonce
   - Insufficient funds
   - Smart contract reversion
```

## Components

### Smart Contracts (Solidity)

#### CawActions.sol
- Core contract for processing social actions
- Validates signatures and nonces
- Emits events for all actions
- Manages cross-chain messaging via LayerZero

#### CawProfile.sol / CawProfileL2.sol
- Name service for user handles
- Separate contracts for L1 and L2
- Manages name registration and transfers

#### CawNetworkManager.sol
- Registry of all Networks (the operator-tier entity — a hosted CAW deployment with its own L2, fees, and validator set)
- Permissionless Network registration via `createNetwork()`
- Tracks Network fee gates, lockdown flags, and capabilities

#### CawActionsArchive.sol
- Deployed on archive chains (e.g., Arbitrum)
- Validators stake ETH (`MIN_STAKE = 0.01 ether`) and call `submitReplication()` with a merkle root of checkpoint hashes plus the underlying packed actions
- Submissions finalize after a 2-day challenge window
- Successful fraud proof slashes the validator's entire stake and invalidates all their pending submissions
- Replication is permissionless: any staked validator can replicate any Network's batches

#### CawChallengeRelay.sol
- Deployed on each source L2 alongside `CawActions`
- Reads canonical `clientHashAtCheckpoint` from `CawActions` storage and relays it to the archive over LayerZero
- Anyone can call `relayChallenge()` against a fraudulent submission
- Slashing is automatic if the relayed hash differs from the submitter's claimed checkpoint leaf

### Fee Structure

CawProfile charges ETH fees on four operations: **mint**, **deposit**, **authenticate**, and **withdraw**. Each fee is set independently per Network by the Network owner via `CawNetworkManager`.

#### 50/50 Split
Every fee is split equally between two recipients:
1. **Network** — receives their share as CAW tokens (converted via Uniswap at withdrawal time)
2. **Burn** — the matching share of CAW is sent to `0xdead` (permanently burned)

The fee amount set by the Network (e.g. `mintFee = 0.001 ETH`) is the **per-recipient** amount. The user pays **double** that (0.002 ETH total) at the time of the transaction. When the Network later withdraws fees, all accumulated ETH is swapped to CAW in a single trade, with half going to the Network and half burned. UIs must show the total cost, not the per-recipient fee.

#### Withdraw Fee Locking
When a user first authenticates or deposits with a Network, the current withdraw fee is locked for that (Network, token) pair. On withdrawal, the user pays `min(locked, current)` — they automatically benefit if the Network lowers fees, but are protected from retroactive increases.

#### Buy-and-Burn (`CawBuyAndBurn.sol`)
- Protocol fees accumulate in CawProfile's `accruedFees` mapping under the buy-and-burn contract's address
- When a Network calls `withdrawFees(minCawOut)`, CawProfile combines the Network's fees + the protocol's matching portion and sends them to `CawBuyAndBurn.swapAndSplit()` in a single Uniswap swap
- Half the resulting CAW goes to the Network, half to `0xdead` (burned)
- Networks receive CAW instead of ETH — this aligns incentives: a bad `minCawOut` hurts the Network's own payout equally, making sandwich griefing self-punishing
- Only CawProfile can call `swapAndSplit()` — no public access, no external MEV griefing
- The CAW/ETH Uniswap V2 pool has 99.99% of LP tokens burned, ensuring permanent liquidity

#### Fee Configuration (for Network operators)
Network owners set fees via `CawNetworkManager`:
- `setMintFee(networkId, fee)` — charged when a user creates a username through this Network
- `setAuthFee(networkId, fee)` — charged on first authentication with this Network
- `setDepositFee(networkId, fee)` — charged on each CAW deposit
- `setWithdrawFee(networkId, fee)` — charged on withdrawal (subject to locking, see above)
- `setFees(networkId, ...)` — atomic batch update of all four fees
- All fees are in wei (ETH). Remember: users pay 2× the set amount due to the 50/50 split.

### Backend Services (TypeScript/Node.js)

#### API Server (`/src/api`)
- REST endpoints for actions and data queries
- WebSocket support for real-time updates
- Redis for caching and pub/sub
- Routes:
  - `/actions` - Submit new signed actions
  - `/caws` - Query posts
  - `/users` - User profiles
  - `/search` - Elasticsearch queries
  - `/hashtags` - Trending hashtags

#### ValidatorService (`/src/services/ValidatorService`)
- Polls pending actions from TxQueue
- Validates and batches actions
- Submits to blockchain
- Handles retry logic with exponential backoff
- Updates status after confirmation

#### RawEventsGatherer (`/src/services/RawEventsGatherer`)
- WebSocket connection to RPC nodes
- Listens for contract events
- Stores raw events in database
- Publishes to Redis for other services

#### ActionProcessor (`/src/services/ActionProcessor`)
- Subscribes to raw events via Redis
- Creates indexed database records
- Processes domain-specific logic:
  - CAW posts with media
  - Like/unlike actions
  - Follow/unfollow
  - Profile updates
- Extracts and indexes hashtags
- Generates notifications for mentions

#### DataCleaner (`/src/services/DataCleaner`)
- Background worker running every minute
- Cleans up stale pending likes
- Removes old failed transactions
- Maintains database consistency

### Frontend (`/src/services/FrontEnd`)

- React 18 with TypeScript
- Vite build system
- TailwindCSS v4 for styling
- Wagmi + RainbowKit for Web3
- Zustand for state management
- React Query for server state

## Database Schema

### Core Tables

#### TxQueue
```sql
- id: number
- status: 'pending' | 'done' | 'failed'
- payload: JSON (signed action data)
- reason: string (failure reason)
- createdAt: timestamp
```

#### Caw
```sql
- id: number
- userId: number
- cawonce: number (nonce)
- content: string
- status: 'PENDING' | 'SUCCESS' | 'FAILED'
- imageData: string (IPFS/URLs)
- videoData: string
- likeCount, recawCount, commentCount: numbers
```

#### BlockchainEvent
```sql
- id: number
- eventName: string
- transactionHash: string
- blockNumber: number
- args: JSON
- processed: boolean
```

#### Action
```sql
- id: number
- rawEventId: number (foreign key)
- actionType: number
- senderId: number
- createdAt: timestamp
```

#### Hashtag
```sql
- id: number
- name: string (lowercase, without #)
- usageCount: number
- createdAt, updatedAt: timestamps
```

#### CawHashtag (junction table)
```sql
- id: number
- cawId: number
- hashtagId: number
```

## Deployment Architecture

### Development Environment
```bash
npm run dev  # Starts all services concurrently
```

### Production Deployment

#### Required Services
1. **PostgreSQL Database** - Main data store
2. **Redis** - Caching and pub/sub
3. **Elasticsearch** (optional) - Advanced search
4. **RPC Endpoints** - Blockchain connectivity
   - Ethereum mainnet/Sepolia
   - Base mainnet/Sepolia

#### Service Configuration
Each service can run independently:
```bash
# Individual services
npm run api          # API server only
npm run validator    # Validator service
npm run processor    # ActionProcessor
npm run gatherer     # RawEventsGatherer
```

#### Environment Variables
```env
DATABASE_URL=postgresql://user:pass@localhost/caw_dev
REDIS_URL=redis://localhost:6379
L1_RPC_URL=wss://mainnet.infura.io/ws/v3/YOUR_KEY
L2_RPC_URL=wss://base-mainnet.infura.io/ws/v3/YOUR_KEY
VALIDATOR_PRIVATE_KEY=0x...
VALIDATOR_ID=1
```

### Multi-Node Setup

Validators can run independently:
1. Each validator needs unique VALIDATOR_ID
2. Multiple validators can process same TxQueue
3. Smart contracts prevent duplicate submissions
4. First validator to submit gets the tip rewards

## Security Considerations

### 1. Signature Verification
- All actions require EIP-712 signatures
- Signatures validated both client and server side
- Smart contracts perform final validation

### 2. Nonce Management
- Each user has incrementing nonce (cawonce)
- Prevents replay attacks
- Ensures action ordering

### 3. Private Key Security
- Validator private keys should use hardware wallets in production
- Never commit keys to version control
- Use environment variables or secure key management

### 4. Rate Limiting
- API endpoints should implement rate limiting
- Prevent spam and DoS attacks
- Consider implementing proof-of-work for posts

### 5. Content Validation
- Sanitize user input to prevent XSS
- Validate media URLs and IPFS hashes
- Implement content size limits

## Monitoring and Maintenance

### Health Checks
- Each service exposes health endpoints
- Monitor blockchain connectivity
- Track pending queue sizes
- Alert on failed transaction rates

### Database Maintenance
- Regular backups of PostgreSQL
- Index optimization for query performance
- Archival strategy for old events

### Log Management
- Centralized logging with timestamps
- Log rotation to prevent disk fill
- Error tracking and alerting

### Performance Optimization
- Redis caching for frequently accessed data
- Database query optimization
- CDN for media content
- WebSocket connection pooling

## Optimistic Archive + Challenge

CAW Protocol uses an optimistic archive with a fraud-proof window for censorship-resistant action storage. Validators stake ETH and submit checkpoint replications to archive chains; anyone can challenge a fraudulent submission, and a successful challenge slashes the validator's entire stake.

### Architecture

```
┌────────────────────────────────────────────────────────────────┐
│                    Source L2 (e.g. Base)                        │
│  ┌─────────────────┐    ┌─────────────────────────────────┐    │
│  │   CawActions    │    │      CawChallengeRelay          │    │
│  │ (stores         │───▶│  reads clientHashAtCheckpoint   │    │
│  │ clientHashAt-   │    │  and relays it via LayerZero    │    │
│  │ Checkpoint)     │    │  on challenge                   │    │
│  └─────────────────┘    └──────────────┬──────────────────┘    │
└─────────────────────────────────────────┼───────────────────────┘
                          (validator                │
                           submits via              │
                           plain calldata)          │ LayerZero
                                ▼                   ▼
                  ┌──────────────────────────────────────┐
                  │       Archive Chain                  │
                  │   ┌──────────────────────────────┐   │
                  │   │     CawActionsArchive        │   │
                  │   │  • stakes[validator] >= MIN  │   │
                  │   │  • submitReplication(root,   │   │
                  │   │       packedActions, ...)    │   │
                  │   │  • 2-day challenge window    │   │
                  │   │  • resolveChallenge slashes  │   │
                  │   └──────────────────────────────┘   │
                  └──────────────────────────────────────┘
```

### Lifecycle

1. **Submit (optimistic)** — a validator with stake calls `submitReplication()` on `CawActionsArchive` with the merkle root of checkpoint hashes plus the underlying packed actions and `r` anchors. Action *bytes* live in calldata, committed to via `dataCommitment` on the submission record — they are not stored long-term in contract storage.

2. **Challenge (permissionless)** — anyone monitoring the source L2 can call `CawChallengeRelay.relayChallenge()` with the suspect checkpoint. The relay reads the canonical `clientHashAtCheckpoint` from `CawActions` storage and ships it over LayerZero to the archive.

3. **Resolve** — if the relayed hash differs from the submitter's claimed leaf, `resolveChallenge()` slashes the entire stake and invalidates all the submitter's pending submissions. `slashIncoherentRoot()` catches a separate fraud class where the merkle root can't even be derived from the published data.

4. **Finalize** — after `CHALLENGE_PERIOD = 2 days` with no successful challenge, `finalizeSubmission()` makes the archive entry canonical.

### Permissionless and Per-Operator

Replication is not configured per-Network on-chain. Any validator with stake on a peered archive chain can replicate any Network's batches. Each operator chooses which Networks to replicate (`REPLICATE_NETWORK_IDS` env on the validator) and which archive chain to stake on. Multiple validators replicate the same batches in parallel; the optimistic model accepts the first finalized submission per checkpoint.

### Data Availability

The action bytes never live in archive contract storage. They live in the submitter-supplied calldata, committed to via `dataCommitment`. Indexers reconstruct full action data from the calldata logs of `submitReplication` calls.

### Cost Model

Per-action cost on the archive is dominated by calldata, not storage — typical submission packs many actions per call. Validators pay this gas; they're compensated by the fees baked into actions on the source L2.

## Future Enhancements

1. **Decentralized Storage**
   - IPFS integration for media
   - Arweave for permanent storage

2. **Enhanced Privacy**
   - Encrypted direct messages
   - Zero-knowledge proofs for private actions

3. **Governance**
   - DAO for protocol upgrades
   - Token-based voting mechanisms

4. **Scalability**
   - State channels for micro-interactions
   - Rollup integration for cheaper transactions

5. **Interoperability**
   - Cross-chain social graph
   - Integration with other social protocols

## Conclusion

The CAW Protocol architecture prioritizes decentralization and censorship resistance while maintaining good user experience through optimistic updates and efficient indexing. The validator network ensures permissionless participation, while the blockchain provides an immutable record of all social interactions. This design creates a truly unstoppable platform for free speech.