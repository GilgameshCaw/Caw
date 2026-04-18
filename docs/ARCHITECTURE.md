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
│  • CawClientManager.sol - Client management                      │
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

#### CawClientManager.sol
- Manages registered clients/validators
- Tracks client permissions and capabilities

#### CawActionsReplicator.sol
- Cross-chain archiving via LayerZero
- Sends action data to archive chains for censorship resistance
- Supports protocol-level archive (always on) and client-specific archives
- Client owners can configure additional archive chains for their users

#### CawActionsArchive.sol
- Deployed on archive chains (e.g., Arbitrum)
- Receives action data via LayerZero
- Emits `ActionsArchived` events for permanent storage
- Minimal gas cost - just event emission for data preservation

### Fee Structure

CawProfile charges ETH fees on four operations: **mint**, **deposit**, **authenticate**, and **withdraw**. Each fee is set independently per client by the client owner via `CawClientManager`.

#### 50/50 Split
Every fee is split equally between two recipients:
1. **Client** — receives their share as CAW tokens (converted via Uniswap at withdrawal time)
2. **Burn** — the matching share of CAW is sent to `0xdead` (permanently burned)

The fee amount set by the client (e.g. `mintFee = 0.001 ETH`) is the **per-recipient** amount. The user pays **double** that (0.002 ETH total) at the time of the transaction. When the client later withdraws fees, all accumulated ETH is swapped to CAW in a single trade, with half going to the client and half burned. UIs must show the total cost, not the per-recipient fee.

#### Withdraw Fee Locking
When a user first authenticates or deposits with a client, the current withdraw fee is locked for that (client, token) pair. On withdrawal, the user pays `min(locked, current)` — they automatically benefit if the client lowers fees, but are protected from retroactive increases.

#### Buy-and-Burn (`CawBuyAndBurn.sol`)
- Protocol fees accumulate in CawProfile's `accruedFees` mapping under the buy-and-burn contract's address
- When a client calls `withdrawFees(minCawOut)`, CawProfile combines the client's fees + the protocol's matching portion and sends them to `CawBuyAndBurn.swapAndSplit()` in a single Uniswap swap
- Half the resulting CAW goes to the client, half to `0xdead` (burned)
- Clients receive CAW instead of ETH — this aligns incentives: a bad `minCawOut` hurts the client's own payout equally, making sandwich griefing self-punishing
- Only CawProfile can call `swapAndSplit()` — no public access, no external MEV griefing
- The CAW/ETH Uniswap V2 pool has 99.99% of LP tokens burned, ensuring permanent liquidity

#### Fee Configuration (for client operators)
Client owners set fees via `CawClientManager`:
- `setMintFee(clientId, fee)` — charged when a user creates a username through this client
- `setAuthFee(clientId, fee)` — charged on first authentication with this client
- `setDepositFee(clientId, fee)` — charged on each CAW deposit
- `setWithdrawFee(clientId, fee)` — charged on withdrawal (subject to locking, see above)
- `setFees(clientId, ...)` — atomic batch update of all four fees
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

## Cross-Chain Archiving

CAW Protocol implements cross-chain archiving to ensure censorship resistance. Actions are replicated to archive chains where they are permanently stored as blockchain events.

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    L2 (Base) - Primary Chain                     │
│  ┌─────────────────┐     ┌─────────────────────────────────┐    │
│  │   CawActions    │────▶│    CawActionsReplicator         │    │
│  │ (processes all  │     │  • Reads client's replication   │    │
│  │  social actions)│     │    config from CawClientManager │    │
│  └─────────────────┘     └──────────────┬──────────────────┘    │
└─────────────────────────────────────────┼───────────────────────┘
                                          │ LayerZero
                    ┌─────────────────────┼─────────────────────┐
                    │                     │                     │
                    ▼                     ▼                     ▼
        ┌───────────────────┐  ┌───────────────────┐  ┌───────────────────┐
        │  Client 1 Archive │  │  Client 2 Archive │  │  Client 3 Archive │
        │   (Arbitrum)      │  │   (Optimism)      │  │   (Polygon)       │
        │                   │  │                   │  │                   │
        │ CawActionsArchive │  │ CawActionsArchive │  │ CawActionsArchive │
        │   └─ Events       │  │   └─ Events       │  │   └─ Events       │
        └───────────────────┘  └───────────────────┘  └───────────────────┘
```

### Client Replication

Each action belongs to a client. When an action is processed, it is replicated to that client's configured archive destinations:

- Clients can deploy their own `CawActionsArchive` contracts to any chain
- Client owners register their archive addresses in `CawClientManager`
- Allows communities to choose trusted archive destinations and maintain control
- Up to 4 replication destinations per client
- Archive costs are factored into the action's CAW payment

### Data Preservation

Actions are stored as events on archive chains:
```solidity
event ActionsArchived(
    uint32 indexed sourceChainId,
    bytes32 indexed guid,
    bytes data  // Full action payload including signatures
);
```

This ensures:
- **Permanent storage**: Events are immutable blockchain history
- **Verifiable**: Original signatures preserved for authenticity
- **Recoverable**: Full history can be reconstructed from events
- **Cost-effective**: Event emission is minimal gas cost

### Archive Cost Calculation

Archive costs are factored into action pricing:
- LayerZero base fee (~0.0005 ETH per chain)
- Destination chain gas (~50k gas for event emission)
- Multiplied by number of archive chains
- 50% buffer for fee volatility

For a typical post:
- L2 storage cost: ~2,400 CAW (10KB)
- Archive cost: ~750 CAW per chain
- Total: ~3,150 CAW for L2 + 1 archive chain

### Client Replication Management

Clients can deploy their own `CawActionsArchive` contracts to any chain and register them with their client configuration. This allows communities to:
- Choose their own trusted archive chains
- Deploy archives to chains with favorable storage costs
- Maintain full control over their archiving infrastructure

Client owners manage replication destinations via `CawClientManager`:

```solidity
// Deploy your own CawActionsArchive on a target chain, then register it:
clientManager.addReplication(clientId, eid, archiveContractAddress);

// Remove a replication destination
clientManager.removeReplication(clientId, eid);

// Enable/disable replication for your client
clientManager.setReplicationEnabled(clientId, true);

// Query current replication destinations
ReplicationDestination[] memory replications = clientManager.getReplications(clientId);
```

The `ReplicationDestination` struct contains:
- `eid`: LayerZero endpoint ID of the chain
- `target`: Address of the deployed contract (e.g., `CawActionsArchive`)

Each client can have up to 4 replication destinations.

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