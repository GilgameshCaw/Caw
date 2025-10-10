# Getting Started with CAW Protocol

## Prerequisites

- Node.js v22.0.0 or higher
- PostgreSQL 14+
- Redis 6+
- Git
- A Web3 wallet (MetaMask recommended)

## Quick Start

### 1. Clone the Repository
```bash
git clone https://github.com/your-org/CAW-nfts.git
cd CAW-nfts
```

### 2. Install Dependencies
```bash
# Install client dependencies
cd client
npm install

# Install Solidity dependencies (if working with smart contracts)
cd ../solidity
npm install
```

### 3. Set Up Environment Variables
```bash
# Copy the example environment file
cp .env.example .env

# Edit with your configuration
nano .env
```

Required environment variables:
```env
# Database
DATABASE_URL=postgresql://postgres:password@localhost:5432/caw_dev

# Redis
REDIS_URL=redis://localhost:6379

# RPC Endpoints
L1_RPC_URL=wss://sepolia.infura.io/ws/v3/YOUR_INFURA_KEY
L2_RPC_URL=wss://base-sepolia.infura.io/ws/v3/YOUR_INFURA_KEY

# Validator (optional - only if running validator)
VALIDATOR_PRIVATE_KEY=0x...
VALIDATOR_ID=1
```

### 4. Set Up Database
```bash
# Run Prisma migrations
cd client
npx prisma migrate dev

# Seed initial data (optional)
npx prisma db seed
```

### 5. Start Services

#### Development Mode (All Services)
```bash
npm run dev
```
This starts:
- PostgreSQL connection
- Redis server
- API server with hot reload
- Frontend development server
- All background services

#### Production Mode
```bash
# Start API and services
npm run api

# In another terminal, start frontend
npm run web
```

### 6. Access the Application
- Frontend: http://localhost:5173
- API: http://localhost:4000
- API Documentation: http://localhost:4000/docs

## Running Individual Services

### API Server Only
```bash
npm run api
```

### Validator Service
```bash
npm run validator
```

### Frontend Only
```bash
npm run web
```

## Testing

### Run Tests
```bash
npm test
```

### Run Linting
```bash
npm run lint
```

### Type Checking
```bash
npm run typecheck
```

## Development Workflow

### 1. Creating a New Feature
1. Create a feature branch
2. Make your changes
3. Test locally with `npm run dev`
4. Run tests and linting
5. Submit a pull request

### 2. Working with Smart Contracts
```bash
cd solidity
# Compile contracts
npx truffle compile

# Deploy to local network
npx truffle migrate --network dev

# Deploy to testnet
npx truffle migrate --network testnetL2
```

### 3. Database Changes
```bash
# Modify schema
nano prisma/schema.prisma

# Create migration
npx prisma migrate dev --name your_migration_name

# Apply migration
npx prisma migrate deploy
```

## Common Issues

### Port Already in Use
```bash
# Kill process on port 5173 (frontend)
lsof -ti:5173 | xargs kill -9

# Kill process on port 4000 (API)
lsof -ti:4000 | xargs kill -9
```

### Database Connection Issues
```bash
# Check PostgreSQL is running
psql -U postgres -c "SELECT 1"

# Reset database
npx prisma migrate reset
```

### Redis Connection Issues
```bash
# Check Redis is running
redis-cli ping

# Start Redis manually
redis-server
```

## Next Steps

1. Read the [Architecture Documentation](./ARCHITECTURE.md)
2. Review [API Documentation](./API_DOCUMENTATION.md)
3. Learn about [Smart Contracts](./SMART_CONTRACTS.md)
4. Understand the [Data Flow](./DATA_FLOW.md)
5. Set up a [Validator Node](./VALIDATOR_SETUP.md)

## Getting Help

- GitHub Issues: [Report bugs or request features]
- Discord: [Join our community]
- Documentation: [Full documentation](./README.md)