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
- **[Profile Marketplace](./docs/MARKETPLACE.md)** - Trustless zero-fee profile NFT trading (fixed sales, Dutch auctions, English auctions, and purchase offers)
- **[Session Keys (Quick Sign)](./docs/SESSION_KEYS.md)** - Scoped, spend-capped key delegation for gasless UX

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

## 🛠 Run a Node

There are two ways to run a CAW node: the **one-liner installer** (recommended for fresh Linux servers — VPS, cloud, etc.) and the **manual install** (if you want full control or you're on macOS for local dev).

### One-liner installer

On a fresh Debian/Ubuntu host:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/GilgameshCaw/Caw/master/install.sh)"
```

The script:

- Asks for your domain, then re-execs with sudo
- Detects host capacity (RAM / cores / disk) and warns if you're below recommended specs
- Asks how you want to run Postgres / Redis / Elasticsearch (native install, Docker, or connect to existing)
- Installs Node 22, pm2, yarn, nginx, ufw, certbot, and the chosen DB stack
- Creates a `caw` system user, clones the repo to `/var/www/<domain>`, hands off to the interactive Node CLI
- The CLI walks you through node type, network, RPC URLs, validator config, optional replication, infrastructure, and TLS

#### Requirements

| Resource | Minimum (validator-only) | Recommended (full node) |
|---|---|---|
| **RAM** | 2 GB | 8 GB |
| **CPU** | 1 core | 2+ cores |
| **Disk** | 10 GB | 25+ GB SSD |
| **OS** | Linux (apt-based) | Ubuntu 24.04 LTS |
| **Network** | Public IPv4 | Static IPv4 + domain |

A full node runs Elasticsearch (~512 MB heap), Postgres, Redis, the Node API + indexers under pm2, and an nginx-served React build. ES is the dominant memory consumer.

#### Environment overrides

Set these before running the script to skip the corresponding prompt:

| Variable | Effect |
|---|---|
| `CAW_DIR` | Install directory (default: `/var/www/<domain>` from the prompt) |
| `CAW_REPO` | Git remote (default: `https://github.com/GilgameshCaw/Caw.git`) |
| `CAW_BRANCH` | Branch to check out (default: `master`) |
| `CAW_USER` | System user that owns the install (default: `caw`) |
| `CAW_DOMAIN` | Skip the domain prompt |
| `CAW_INFRA_MODE` | `native`, `docker`, or `existing` |
| `CAW_DB_URL` / `CAW_REDIS_URL` / `CAW_ES_URL` | Use these instead of installing the corresponding service |
| `CAW_CERT_PATH` / `CAW_KEY_PATH` | Skip the TLS prompt; use these files for nginx |
| `CAW_API_PORT` | Override the default API port (4000) |
| `SKIP_BOOTSTRAP=1` | Skip apt installs (assume system deps are already there) |

### Manual install

If the one-liner doesn't fit your environment, install the system deps yourself, then run the interactive CLI:

```bash
# 1. System packages (Debian/Ubuntu shown — adapt for your distro)
sudo apt-get update
sudo apt-get install -y curl git build-essential nginx postgresql postgresql-contrib redis-server

# Node 22 from NodeSource
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt-get install -y nodejs
sudo npm install -g yarn pm2

# Elasticsearch from Elastic's apt repo (or use a managed ES instance)
curl -fsSL https://artifacts.elastic.co/GPG-KEY-elasticsearch | \
  sudo gpg --dearmor -o /usr/share/keyrings/elastic.gpg
echo "deb [signed-by=/usr/share/keyrings/elastic.gpg] https://artifacts.elastic.co/packages/8.x/apt stable main" | \
  sudo tee /etc/apt/sources.list.d/elastic-8.x.list
sudo apt-get update && sudo apt-get install -y elasticsearch

# 2. Configure Elasticsearch (cap heap, disable auth, bind localhost)
# See install.sh for the exact /etc/elasticsearch/elasticsearch.yml we write.

# 3. Create a non-root user and clone the repo
sudo adduser --disabled-password --gecos "" caw
sudo mkdir -p /var/www/<your-domain>
sudo chown caw:caw /var/www/<your-domain>
sudo -u caw git clone https://github.com/GilgameshCaw/Caw.git /var/www/<your-domain>

# 4. Run the interactive CLI as the caw user
cd /var/www/<your-domain>
sudo -u caw bash -c 'cd cli && npm install'
sudo -u caw node cli/bin/caw.js install --dir /var/www/<your-domain>
```

The CLI generates `client/.env`, `client/config.json`, and `ecosystem.config.cjs`, runs `prisma db push`, and starts services under pm2.

### Local dev (macOS)

For local development without Linux:

```bash
git clone https://github.com/GilgameshCaw/Caw.git
cd Caw

# Install Node 22, postgres, redis, elasticsearch via Homebrew
brew install node@22 postgresql@16 redis elasticsearch

# Start the stateful services
brew services start postgresql@16
brew services start redis
brew services start elasticsearch

# Run the interactive CLI
cd cli && npm install && cd ..
node cli/bin/caw.js install --dir "$PWD"
```

Pick the `dev` deployment mode in the CLI — vite serves the frontend live at http://localhost:5273 and pm2 watches the API.

## ⚡ Quick Start (legacy)

For development against an already-installed checkout:

### Prerequisites
- Node.js v22.0.0+
- PostgreSQL 14+
- Redis 6+
- Web3 wallet (MetaMask)

### Installation
```bash
# Clone the repository
git clone https://github.com/GilgameshCaw/Caw.git
cd Caw

# Install dependencies
cd client
npm install --legacy-peer-deps

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
