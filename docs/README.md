# CAW Protocol Documentation

Welcome to the documentation for the CAW Protocol — a trustless and decentralized social clearing-house committed to making freedom of speech unstoppable.

**👉 New here? Start with [Building on CAW](./FOR_DEVELOPERS.md)** — a builder-focused index organized by what you want to do (run a node, build a frontend, build a smart-contract extension).

## 📚 Core Documentation

### System Overview
- **[Building on CAW](./FOR_DEVELOPERS.md)** - Developer landing page; what you can build and how
- **[Architecture Overview](./ARCHITECTURE.md)** - Complete system architecture and design principles
- **[Data Flow](./DATA_FLOW.md)** - How data moves through the system
- **[Getting Started](./GETTING_STARTED.md)** - Quick start guide for developers

## 🔧 Technical Guides

### Infrastructure
- **[Validator Setup](./VALIDATOR_MESH_NETWORK.md)** - How to run a validator node
- **[Elasticsearch Setup](./ELASTICSEARCH_SETUP.md)** - Search functionality configuration
- **[Image Upload System](./IMAGE_UPLOAD_SYSTEM.md)** - Media handling and storage

### Features
- **[Other Action Types](./OTHER_ACTION_TYPES.md)** - Beyond posts: likes, follows, profiles
- **[Direct Messaging](./DIRECT_MESSAGING.md)** - E2E encrypted DM system (ECDH + AES-256-GCM)
- **[Profile Marketplace](./MARKETPLACE.md)** - Trustless 0% fee NFT trading (fixed, Dutch, English auctions + offers)
- **[Session Keys (Quick Sign)](./SESSION_KEYS.md)** - Scoped, spend-capped key delegation for gasless UX
- **[ZK Sig-Only Path](./ZK_SIG_PATH.md)** - Optional Groth16-verified signature batching; break-even at n≈70 actions/batch (current prod batch sizes are more expensive on the ZK path)

### Standards
- **[UI Consistency Standards](./UI_CONSISTENCY_STANDARD.md)** - Frontend development guidelines

## 🏗️ Architecture Components

### Smart Contracts
- **CawActions.sol** - Core action processing with EIP-712 verification
- **CawProfile.sol / CawProfileL2.sol** - Name service (ERC-721) for L1 and L2
- **CawProfileMinter.sol** - Minting with CAW token burn
- **CawProfileMarketplace.sol** - On-chain profile trading
- **CawProfileURI.sol** - On-chain SVG renderer
- **CawNetworkManager.sol** - Network registry, per-network fees, instance registry
- **CawActionsArchive.sol** - Optimistic archive on archive chains; validators stake ETH and submit checkpoint replications, challengeable for 2 days
- **CawChallengeRelay.sol** - Per-L2 relay that ships canonical checkpoint hashes to the archive over LayerZero for fraud resolution
- **CawBuyAndBurn.sol** - Token economics

### Backend Services
- **ValidatorService** - Batches and submits pending actions on-chain
- **ActionProcessor** - Indexes blockchain events into PostgreSQL
- **RawEventsGatherer** - Captures blockchain events via WebSocket
- **RawEventsProvider** - Event data provider
- **DataCleaner** - Stale data cleanup and failure escalation
- **DmService / DmRelayService** - Direct messaging infrastructure
- **MarketplaceIndexerService** - NFT marketplace event indexing
- **ChainSyncService** - Chain synchronization
- **InstanceRegistryService** - Validator instance registry
- **ScheduledPostProcessor** - Scheduled post execution
- **ViewTracker** - Post view counting
- **ElasticsearchService** - Full-text search
- **NotificationService** - Real-time notifications
- **UserService** - User management
- **API Server** - REST endpoints

### Frontend
- React 18 with TypeScript
- Vite build system
- TailwindCSS v4
- Wagmi + RainbowKit for Web3
- Zustand state management
- Framer Motion animations

## 📞 Resources

- **Website**: [https://caw.is](https://caw.is)
- **Manifesto**: [Read the CAW Manifesto](./manifesto.txt)
- **Twitter**: [@caw_dev](https://x.com/caw_dev)
- **Telegram**: [@cawbuilders](https://t.me/cawbuilders)
