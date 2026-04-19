# CAW Protocol 🦅

> A trustless and decentralized social clearing-house committed to making freedom of speech unstoppable

## 🚀 Overview

CAW Protocol is a decentralized social network built on blockchain technology. All actions are cryptographically signed and verified on-chain, ensuring censorship-resistant content and permissionless participation.

### Key Features
- 🔐 **Trustless** - All actions are EIP-712 signed and verified on-chain
- 🌍 **Decentralized** - Permissionless validator network processes actions
- 🛡️ **Censorship-Resistant** - Content stored on blockchain cannot be removed
- 🔗 **Multi-Chain** - Ethereum L1, Base L2, with Arbitrum archive chain
- ⚡ **Cross-Chain Archiving** - LayerZero-based replication to archive chains

## 📚 Documentation

### Core
- **[Architecture Overview](./docs/ARCHITECTURE.md)** - System architecture and design principles
- **[Getting Started](./docs/GETTING_STARTED.md)** - Quick start guide for developers
- **[Data Flow](./docs/DATA_FLOW.md)** - How data moves through the system

### Technical Guides
- **[Validator Setup](./docs/VALIDATOR_MESH_NETWORK.md)** - How to run a validator node
- **[Smart Contracts](./solidity/README.md)** - Solidity contracts documentation
- **[Client Replication Guide](./solidity/docs/CLIENT_REPLICATION_GUIDE.md)** - Cross-chain archiving setup via LayerZero
- **[API & Backend](./client/README.md)** - Backend services and API documentation
- **[Services Overview](./client/src/services/SERVICES.md)** - All backend services

### Feature Documentation
- **[Image Upload System](./docs/IMAGE_UPLOAD_SYSTEM.md)** - Media handling and storage
- **[Other Action Types](./docs/OTHER_ACTION_TYPES.md)** - Beyond posts: likes, follows, profiles
- **[Elasticsearch Setup](./docs/ELASTICSEARCH_SETUP.md)** - Search functionality setup
- **[Direct Messaging](./docs/DIRECT_MESSAGING.md)** - E2E encrypted DM system (ECDH + AES-256-GCM)

### Standards
- **[UI Consistency Standards](./docs/UI_CONSISTENCY_STANDARD.md)** - Frontend development guidelines
- **[Claude.md](./CLAUDE.md)** - AI assistant integration guidelines

## 🏗️ Project Structure

```
CAW-nfts/
├── docs/                    # Documentation
├── solidity/                # Smart contracts
│   ├── contracts/           # Solidity source files
│   ├── scripts/             # Deployment scripts
│   └── test/                # Contract tests
├── client/                  # Backend and frontend
│   ├── src/
│   │   ├── api/             # REST API server & routes
│   │   ├── services/
│   │   │   ├── ValidatorService/          # On-chain action processing
│   │   │   ├── ActionProcessor/           # Blockchain event indexing
│   │   │   ├── RawEventsGatherer/         # Blockchain event listener
│   │   │   ├── RawEventsProvider/         # Event data provider
│   │   │   ├── FrontEnd/                  # React application
│   │   │   ├── DataCleaner/               # Stale data cleanup
│   │   │   ├── DmService/                 # Direct messaging
│   │   │   ├── DmRelayService/            # DM relay infrastructure
│   │   │   ├── MarketplaceIndexerService/ # NFT marketplace indexing
│   │   │   ├── ChainSyncService/          # Chain synchronization
│   │   │   ├── InstanceRegistryService/   # Validator instance registry
│   │   │   ├── ScheduledPostProcessor/    # Scheduled post execution
│   │   │   └── ViewTracker/               # Post view counting
│   │   └── utils/           # Utility functions
│   ├── prisma/              # Database schema & migrations
│   └── scripts/             # Utility scripts
└── README.md
```

## ⚡ Quick Start

### Prerequisites
- Node.js v22.0.0+
- PostgreSQL 14+
- Redis 6+
- Web3 wallet (MetaMask)

### Installation
```bash
# Clone the repository
git clone https://github.com/AW-CAW/CAW-nfts.git
cd CAW-nfts

# Install dependencies
cd client
npm install

# Set up environment
cp .env.example .env
# Edit .env with your configuration

# Set up database
npx prisma migrate dev

# Start development environment
cd ..
npm run dev
```

This starts all services:
- Frontend at http://localhost:5173
- API at http://localhost:4000
- Validator, event processors, and background services

### Available Scripts (root)
```bash
npm run dev    # Start all services (Redis, API with hot reload, frontend)
npm start      # Start Redis and API services
npm run web    # Start frontend only
npm test       # Run TypeScript check and Mocha tests
```

### Frontend (client/src/services/FrontEnd/)
```bash
yarn dev       # Start Vite dev server
yarn build     # TypeScript compile and production build
yarn lint      # Run ESLint
```

### Smart Contracts (solidity/)
```bash
npx truffle compile                     # Compile contracts
npx truffle migrate --network dev       # Deploy locally
npx truffle migrate --network testnetL2 # Deploy to Base Sepolia
npx truffle test                        # Run contract tests
```

## 🔄 Architecture

```
Users -> Frontend -> API -> Database <- Validator -> Blockchain (L2)
                              |                         |
                       ActionProcessor <- RawEventsGatherer
                                                        |
                                              CawActionsReplicator
                                                        |
                                                  Archive Chain
```

**Key Components:**
- **Frontend** - React 18 + Vite + TailwindCSS + Wagmi/RainbowKit
- **API** - Express server receiving EIP-712 signed actions
- **Validator** - Batches and submits pending actions on-chain
- **Blockchain** - Immutable source of truth (Base L2)
- **Event Processors** - Index blockchain events into PostgreSQL
- **Replicator** - Cross-chain archiving via LayerZero

[Learn more about the architecture ->](./docs/ARCHITECTURE.md)

## 📜 Smart Contracts

| Contract | Description |
|----------|-------------|
| **CawActions** | Core contract for social actions (post, like, follow, tip, etc.) |
| **CawProfile / CawProfileL2** | Name service (ERC-721) for L1 and L2 |
| **CawProfileMinter** | Minting with CAW token burn mechanism |
| **CawProfileMarketplace** | On-chain profile trading |
| **CawProfileURI** | On-chain SVG renderer for profile NFTs |
| **CawClientManager** | Client authentication and archive chain config |
| **CawActionsReplicator** | Cross-chain archiving via LayerZero |
| **CawActionsArchive** | Archive contract on Arbitrum |
| **CawBuyAndBurn** | Token economics: buy and burn mechanism |

## ✨ Features

- Post, reply, quote, recaw (repost)
- Likes, follows, and unfollows
- Tipping (CAW token transfers between users)
- Hashtag indexing and trending topics
- Full-text search via Elasticsearch
- Direct messaging (E2E encrypted via ECDH + AES-256-GCM)
- NFT profile marketplace
- Session keys (Quick Sign) for gasless UX
- Scheduled posts
- Bookmarks
- Real-time notifications
- Optimistic UI with auto-retry on failures
- On-chain SVG profile rendering (no external dependencies)
- Cross-chain archiving to Arbitrum via LayerZero
- Multi-chain deployment (Ethereum L1, Base L2, Arbitrum archive)

## 🔒 Security

- All actions require EIP-712 cryptographic signatures
- Session key delegation with scoped permissions and spend limits
- Wallet-based authentication (no passwords)

## 🌐 Resources

- **Website**: [https://caw.is](https://caw.is)
- **Documentation**: [Full Documentation](./docs/)
- **Manifesto**: [Read the CAW Manifesto](./docs/manifesto.txt)
- **Twitter**: [@caw_dev](https://x.com/caw_dev)
- **Telegram**: [@cawbuilders](https://t.me/cawbuilders)

---

**With CAW Protocol, your voice cannot be silenced. 🦅**
