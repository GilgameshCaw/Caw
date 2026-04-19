# CAW Client

### To start

```bash
# install dependencies
npm install

# reset & push Prisma schema
npm run prisma:reset

# run everything in dev
npm run dev
```

## 🗄️ Database & Cache Setup

You need PostgreSQL **and** Redis. Pick **one** of the following recipes (and will likely want to change your password):

---

### Option 1: Docker (recommended for quick start)

```bash
# Launch Postgres
docker run --rm -d \
  --name caw-postgres \
  -e POSTGRES_USER=caw \
  -e POSTGRES_PASSWORD=caw \
  -e POSTGRES_DB=caw \
  -p 5432:5432 \
  postgres:15-alpine

# Launch Redis
docker run --rm -d \
  --name caw-redis \
  -p 6379:6379 \
  redis:7-alpine

# Set your DATABASE_URL
export DATABASE_URL="postgresql://caw:caw@127.0.0.1:5432/caw"
```

### Option 2: Native install

**macOS:**

```bash
# Install
brew install postgresql redis

# Start services
brew services start postgresql
brew services start redis

# Create DB & user
psql postgres -c "CREATE ROLE caw WITH LOGIN PASSWORD 'caw';"
psql postgres -c "CREATE DATABASE caw OWNER caw;"

# Set your DATABASE_URL
export DATABASE_URL="postgresql://caw:caw@127.0.0.1:5432/caw"
```

**Ubuntu:**

```bash
# Install
sudo apt update
sudo apt install -y postgresql redis-server

# Create DB & user as the postgres superuser
sudo -iu postgres psql -c "CREATE ROLE caw WITH LOGIN PASSWORD 'caw';"
sudo -iu postgres psql -c "CREATE DATABASE caw OWNER caw;"

# Ensure Redis is running
sudo systemctl enable --now redis-server

# Set your DATABASE_URL
export DATABASE_URL="postgresql://caw:caw@127.0.0.1:5432/caw"
```

---

## External API Keys

### Giphy (for GIF picker)

To enable the GIF picker in post composition, you need a Giphy API key:

1. Go to [developers.giphy.com](https://developers.giphy.com/) and create an account
2. Create an app to get an API key
3. Add to your `.env` file:
   ```
   GIPHY_API_KEY=your_api_key_here
   ```

**Note:** The free tier allows 100 requests per hour. For production usage, you may need a paid plan.

### RPC URLs

The backend needs RPC access to both L1 (Ethereum) and L2 (Base). Configure in `.env`:

```env
# L1 — used for name resolution and deposit watching
MAINNET_RPC_URL="https://sepolia.drpc.org"
L1_RPC_URL="wss://eth-sepolia.g.alchemy.com/v2/YOUR_KEY"

# L2 — used by the validator, event gatherer, and chain sync
L2_RPC_URL="wss://base-sepolia.infura.io/ws/v3/YOUR_KEY"
L2_RPC_URL_HTTP="https://base-sepolia.infura.io/v3/YOUR_KEY"

# Validator wallet (for submitting on-chain transactions)
VALIDATOR_PRIVATE_KEY="0x..."
```

WebSocket URLs (`wss://`) are required for the RawEventsGatherer. HTTP URLs are used as fallback by other services. You'll need an Alchemy, Infura, or similar provider key.

---

## Authentication

Session-based wallet authentication — no passwords, no JWTs for end users.

1. **Wallet connect** — User connects via RainbowKit/Wagmi (MetaMask, WalletConnect, etc.)
2. **Passive sign** — Frontend requests a `personal_sign` of a timestamped message:
   `"Verify wallet ownership for CAW\nTimestamp: {unix_seconds}"`
3. **Session creation** — Server recovers the signing address, looks up the user's
   CAW NFT token IDs, and creates a Redis-backed session (returned as an opaque
   `x-session-token` header). Subsequent API calls include this header.
4. **Multi-token support** — A single session can authorize multiple token IDs
   owned by the same wallet. Switching active profiles doesn't require re-signing.
5. **DM auth shortcut** — The `POST /api/auth/verify-dm` endpoint combines session
   creation with DM key registration in a single signature, so enabling DMs
   doesn't require a separate sign step.

Sessions expire after inactivity. The frontend detects expired sessions and
prompts a re-sign transparently.

---

## Structure

The backend is organized into services that can run together in a single process
or independently across machines. Configure which services to run in
`config.json`:

```jsonc
// config.json
[
  {
    "service": "RawEventsGatherer",
    "config": { /* service-specific config */ }
  },
  {
    "service": "ValidatorService",
    "config": {}
  }
]
```

Copy `config.template.json` to `config.json` to get started. See
[SERVICES.md](./src/services/SERVICES.md) for the full list of available
services and their configuration options.

All inter-service communication goes over sockets/HTTP — no shared globals or
direct object passing — so services can be split across machines when needed.

## Available Scripts

```bash
npm run dev          # Start all services with hot reload
npm start            # Start Redis, Elasticsearch, and API
npm run web          # Start frontend dev server only
npm test             # TypeScript check + Mocha tests
npm run prisma:push  # Push schema changes to DB
npm run prisma:reset # Reset DB and push schema
```
