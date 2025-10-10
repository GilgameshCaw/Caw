# CAW Protocol 🦅

> A trustless and decentralized social clearing-house committed to making freedom of speech unstoppable

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Website](https://img.shields.io/badge/website-caw.is-green.svg)](https://caw.is)

## 🚀 Overview

CAW Protocol is a revolutionary decentralized social network built on blockchain technology. Unlike traditional social media platforms, CAW ensures true freedom of speech through immutable on-chain storage and a permissionless validator network.

### Key Features
- **🔐 Trustless**: All actions are cryptographically signed and verified
- **🌍 Decentralized**: No single point of control or failure
- **🛡️ Censorship-Resistant**: Content stored on blockchain cannot be removed
- **⚡ Scalable**: Hybrid architecture with on-chain settlement
- **🔗 Multi-Chain**: Supports Ethereum L1 and Base L2

## 📚 Documentation

### Core Documentation
- **[Architecture Overview](./docs/ARCHITECTURE.md)** - Complete system architecture and design principles
- **[Getting Started](./docs/GETTING_STARTED.md)** - Quick start guide for developers
- **[Data Flow](./docs/DATA_FLOW.md)** - Detailed explanation of how data moves through the system

### Technical Guides
- **[Validator Setup](./docs/VALIDATOR_MESH_NETWORK.md)** - How to run a validator node
- **[Smart Contracts](./solidity/README.md)** - Solidity contracts documentation
- **[API Reference](./client/README.md)** - Backend services and API documentation

### Feature Documentation
- **[Image Upload System](./docs/IMAGE_UPLOAD_SYSTEM.md)** - Media handling and storage
- **[Other Action Types](./docs/OTHER_ACTION_TYPES.md)** - Beyond posts: likes, follows, profiles
- **[Elasticsearch Setup](./docs/ELASTICSEARCH_SETUP.md)** - Search functionality setup

### Standards & Guidelines
- **[UI Consistency Standards](./docs/UI_CONSISTENCY_STANDARD.md)** - Frontend development guidelines
- **[Claude.md](./CLAUDE.md)** - AI assistant integration guidelines

## 🏗️ Project Structure

```
CAW-nfts/
├── docs/                    # Documentation
│   ├── ARCHITECTURE.md      # System architecture
│   ├── DATA_FLOW.md         # Data flow diagrams
│   └── ...                  # Other documentation
├── solidity/                # Smart contracts
│   ├── contracts/           # Solidity source files
│   ├── migrations/          # Deployment scripts
│   └── test/                # Contract tests
├── client/                  # Backend and frontend
│   ├── src/
│   │   ├── api/             # REST API server
│   │   ├── services/        # Core services
│   │   │   ├── ValidatorService/     # Transaction validation
│   │   │   ├── ActionProcessor/      # Event processing
│   │   │   ├── RawEventsGatherer/    # Blockchain events
│   │   │   ├── FrontEnd/             # React application
│   │   │   └── DataCleaner/          # Maintenance tasks
│   │   └── utils/           # Utility functions
│   ├── prisma/              # Database schema
│   └── scripts/             # Utility scripts
└── README.md                # This file
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
git clone https://github.com/your-org/CAW-nfts.git
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
npm run dev
```

This starts all services:
- 🌐 Frontend at http://localhost:5173
- 🔌 API at http://localhost:4000
- ✅ Validator service
- 📊 Event processors
- 🗄️ Database and cache

## 🛠️ Development

### Available Scripts
```bash
npm run dev        # Start all services (development)
npm run api        # Start API server only
npm run web        # Start frontend only
npm run validator  # Start validator service
npm test          # Run tests
npm run lint      # Run linting
npm run typecheck # TypeScript checking
```

### Working with Smart Contracts
```bash
cd solidity
npx truffle compile                    # Compile contracts
npx truffle migrate --network dev      # Deploy locally
npx truffle migrate --network testnetL2 # Deploy to testnet
```

## 🔄 System Architecture

The CAW Protocol uses a unique hybrid architecture:

```
Users → Frontend → API → Database ← Validator → Blockchain
                            ↑                        ↓
                     ActionProcessor ← Events ← RawEventsGatherer
```

**Key Components:**
- **Frontend**: React application for user interaction
- **API**: Receives signed actions from users
- **Validator**: Processes pending actions on-chain
- **Blockchain**: Immutable source of truth
- **Event Processors**: Index blockchain data for fast queries

[Learn more about the architecture →](./docs/ARCHITECTURE.md)

## 📊 Current Status

✅ **Completed Features**
- Core smart contracts deployed to testnet
- User authentication via Web3 wallets
- Post creation with media support
- Like and follow functionality
- Hashtag indexing and trending
- Real-time notifications
- Optimistic UI updates

🚧 **In Progress**
- Performance optimizations
- Enhanced search capabilities
- Cross-chain messaging
- Mobile application

📅 **Upcoming**
- Mainnet deployment
- Decentralized storage integration
- DAO governance
- Token economics

## 🤝 Contributing

We welcome contributions! Please see our [Contributing Guide](./CONTRIBUTING.md) for details.

### Development Workflow
1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run tests and linting
5. Submit a pull request

## 🔒 Security

- All actions require cryptographic signatures
- Smart contracts are audited (audit report coming soon)
- Bug bounty program (details coming soon)

For security concerns, please email: security@caw.is

## 📜 License

This project is licensed under the MIT License - see the [LICENSE](./LICENSE) file for details.

## 🌐 Resources

- **Website**: [https://caw.is](https://caw.is)
- **Documentation**: [Full Documentation](./docs/)
- **Discord**: [Join our community](#)
- **Twitter**: [@CAWprotocol](#)

## 🙏 Acknowledgments

CAW Protocol is built on the shoulders of giants:
- Ethereum for the blockchain infrastructure
- IPFS for decentralized storage
- The entire Web3 community for pioneering decentralized technology

---

**Remember**: With CAW Protocol, your voice cannot be silenced. 🦅