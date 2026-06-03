# CAW Protocol - Backend Services Documentation

## Overview

The CAW Protocol backend consists of twelve services that work together to manage blockchain event processing, validation, user management, notifications, and search functionality.

## Architecture Diagram

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  L2 Blockchain  │────▶│ RawEventsGatherer│────▶│     Redis       │
└─────────────────┘     └──────────────────┘     └────────┬────────┘
                                                          │
                                                          ▼
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   ValidatorService    │     ActionProcessor    │────▶│  PostgreSQL   │
│  (TxQueue → Chain)    │  (Events → Domain)     │     └─────────────────┘
└──────────┬────────────┘     └────────┬─────────┘              │
           │                           │                         ▼
           ▼                           ▼               ┌─────────────────┐
┌──────────────────┐     ┌──────────────────┐        │ Elasticsearch   │
│  Uniswap (L1)    │     │  NotificationService     │◀────────────────────┘
└──────────────────┘     └──────────────────┘
```

---

## 1. ActionProcessor

**Location:** `ActionProcessor/`

**Purpose:** Processes raw blockchain events and translates them into domain objects (caws, likes, follows, etc.).

### How It Works
1. Subscribes to Redis `raws` channel for new events
2. Processes backlog of unprocessed events on startup
3. Delegates to domain-specific handlers based on action type
4. Creates/updates domain objects in PostgreSQL

### Action Types
| Type | Description |
|------|-------------|
| CAW | Create a new post |
| RECAW | Repost content |
| LIKE | Like a caw |
| UNLIKE | Remove a like |
| FOLLOW | Follow a user |
| UNFOLLOW | Unfollow a user |
| OTHER | Profile updates, on-chain images |
| WITHDRAW | Token withdrawal |

### Configuration
```typescript
{
  redisUrl: 'redis://127.0.0.1:6379'
}
```

### Dependencies
- Prisma, Redis, UserService, ElasticsearchService, NotificationService

---

## 2. Api

**Location:** `Api/`

**Purpose:** Manages the Express.js REST API server.

### Configuration
```typescript
{
  port: 4000,
  allowedOrigins: ['https://caw.is', 'http://localhost:3000'],
  shortUrlDomain: 'https://caw.is'
}
```

---

## 3. DataCleaner

**Location:** `DataCleaner/`

**Purpose:** Maintains data consistency by cleaning up stale pending records.

### Cleanup Tasks
- **Pending likes (5+ min)** - Reconciles with on-chain state
- **Orphaned likes (30+ min)** - Removes and recalculates counts
- **Failed TxQueue** - Cleans up failed transactions

### Schedule
- Runs on startup, then every 1 minute

---

## 4. ElasticsearchService

**Location:** `ElasticsearchService.ts`

**Purpose:** Provides full-text search and data aggregation.

### Indexes
- **caws** - Content, hashtags, mentions, engagement
- **notifications** - User notifications with grouping
- **users** - Profiles with follower counts

### Key Methods
```typescript
async indexCaw(caw)
async indexUser(user)
async search(query, type, limit, offset)
async getTrendingHashtags(timeRange, limit)
```

### Configuration
```bash
ELASTICSEARCH_NODE=http://localhost:9200
ELASTICSEARCH_API_KEY=(optional)
```

### Features
- Auto-reconnection with exponential backoff
- Falls back to PostgreSQL if unavailable
- Fuzzy matching support

---

## 5. NotificationService

**Location:** `NotificationService.ts`

**Purpose:** Manages user notifications for social actions.

### Notification Types
| Type | Trigger |
|------|---------|
| MENTION | User @mentioned in content |
| FOLLOW | User followed |
| LIKE | Caw liked |
| REPLY | Caw replied to |
| REPOST | Caw reposted |
| QUOTE | Caw quoted |

### Key Methods
```typescript
static async createMentionNotifications(cawId, content, actorId)
static async createFollowNotification(followedId, followerId)
static async createLikeNotification(cawId, likerId)
static async markAsRead(userId, notificationIds?)
static async getUnreadCount(userId)
```

### Features
- Respects mute/block settings
- Prevents duplicate notifications
- Supports notification grouping

---

## 6. RawEventsGatherer

**Location:** `RawEventsGatherer/`

**Purpose:** Listens to blockchain events and stores them for processing.

### How It Works
1. Connects to L2 via WebSocket RPC
2. Listens for CAW contract events
3. Stores events with deduplication (blockNumber, logIndex, txHash)
4. Publishes event IDs to Redis

### Configuration
```typescript
{
  chainId: 84532,  // Base Sepolia
  rpcUrl: 'wss://...',
  redisUrl: 'redis://127.0.0.1:6379'
}
```

---

## 7. ScheduledPostProcessor

**Location:** `ScheduledPostProcessor/`

**Purpose:** Processes scheduled posts when their scheduled time arrives.

### Processing Steps
1. Finds scheduled posts due for publishing
2. Validates signed action
3. Creates pending caw in database
4. Processes hashtags
5. Creates TxQueue entry
6. Updates status to 'published'

### Schedule
- Runs on startup, then every 1 minute

---

## 8. UserService

**Location:** `UserService.ts`

**Purpose:** Manages user creation and enrichment from on-chain data.

### Key Methods
```typescript
async findOrCreateUser(senderId)
async enrichUser(userId, tokenId)
```

### Data Sources
- **L2 (CawProfileLedger):** Wallet address, token info
- **L1 (CawProfile):** Username lookup

### Features
- Exponential backoff for rate limiting
- Lazy connection initialization
- 30-second connection timeout

---

## 9. ValidatorService

**Location:** `ValidatorService/`

**Purpose:** Validates pending transactions and submits them to the blockchain.

### Key Features
- **Gas Validation** - Ensures tips cover gas costs
- **Simulation** - Tests transactions before submission
- **Client Batching** - Max 4 unique clients per batch
- **Replication Costing** - Calculates cross-chain fees
- **Uniswap Integration** - Converts CAW to ETH for fee comparison

### Configuration
```typescript
{
  l2RpcUrl: 'wss://...',
  ethMainnetRpcUrl: 'https://...',
  validatorId: 1,
  checkInterval: 10000
}
```

### Transaction Flow
1. Fetch pending TxQueue entries (max 256)
2. Mark as 'processing'
3. Filter underpriced actions
4. Split if >4 unique clients
5. Simulate each batch
6. Recalculate fees for successful actions
7. Verify tip covers gas
8. Submit transaction
9. Update statuses

### Fee Components
| Fee Type | Description |
|----------|-------------|
| Withdrawal Fee | Cross-chain withdrawal via LayerZero |
| Replication Fee | Archive replication across chains |
| Gas Cost | L2 transaction execution |
| Tip | Validator compensation (CAW) |

### Error Handling
- Retries with 15% gas bump (max 3 attempts)
- Handles REPLACEMENT_UNDERPRICED
- Reinitiates WebSocket on network failures
- Keeps temporary failures as PENDING

### Important Notes
- **Max 4 clients per batch** - Contract limit; larger batches are split automatically
- **Single-client batches are most efficient** - Validators should batch by client when possible
- **Testnet mode** - Scales gas by 10,000x on Base Sepolia

---

## 10. ViewTracker

**Location:** `ViewTracker/` and `ViewTracker.ts`

**Purpose:** Tracks caw views with Redis caching and batch updates.

### Key Methods
```typescript
async trackView({cawId, userId, ipHash})
async trackBulkViews(cawIds, userId, ipHash)
async getTrendingByViews(limit)
```

### Features
- 24-hour view deduplication per user/IP
- Batched DB updates every 30 seconds
- Trending scores with time decay

### Redis Keys
- `caw:{cawId}:views:{viewer}` - Tracking (24h TTL)
- `caw:views:pending` - Pending counts
- `caw:trending:views` - Trending sorted set

---

## 11. XmtpService

**Location:** `XmtpService/`

**Purpose:** Manages XMTP encrypted messaging identities.

### Key Methods
```typescript
async generateIdentity(userId, walletAddress)
async registerIdentity(userId, walletAddress)
async initializeClient(userId)
async canMessage(walletAddress)
```

### Identity Components
- **Identity Keys** - Long-term user identity
- **Pre-Keys** - Ephemeral keys for offline messaging
- **Signed Pre-Key** - Pre-key signed with identity
- **Installation ID** - Per-client unique identifier

---

## Environment Variables

```bash
# Blockchain
L2_RPC_URL=wss://base-sepolia-rpc.publicnode.com/
L1_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com/
ETH_MAINNET_RPC_URL=https://eth.llamarpc.com

# Database
DATABASE_URL=postgresql://...

# Redis
REDIS_URL=redis://localhost:6379

# Elasticsearch
ELASTICSEARCH_NODE=http://localhost:9200
ELASTICSEARCH_API_KEY=(optional)

# Validator
VALIDATOR_PRIVATE_KEY=0x...
```

---

## Service Dependencies

```
RawEventsGatherer
  └──▶ ActionProcessor
         ├──▶ UserService
         ├──▶ NotificationService
         ├──▶ ElasticsearchService
         └──▶ ViewTracker

ValidatorService
  ├──▶ TxQueue (PostgreSQL)
  └──▶ Uniswap (L1 price oracle)

DataCleaner
  └──▶ PostgreSQL reconciliation

ScheduledPostProcessor
  └──▶ TxQueue creation

XmtpService
  └──▶ Independent (messaging)
```

---

## Startup Order

1. Database connections (Prisma → PostgreSQL)
2. External services (Redis, Elasticsearch)
3. Blockchain connections (L1/L2 WebSocket)
4. Background workers (DataCleaner, ScheduledPostProcessor, ViewTracker)
5. Event listeners (RawEventsGatherer, ActionProcessor)
6. Validation loop (ValidatorService)
7. API server (Express.js)
