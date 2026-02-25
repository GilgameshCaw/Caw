# CAW Infrastructure Setup

This document describes how to set up the required infrastructure services for the CAW client.

## Required Services

| Service | Port | Purpose |
|---------|------|---------|
| PostgreSQL | 5432 | Primary database |
| Redis | 6379 | Caching, pub/sub for real-time events |
| Elasticsearch | 9200 | Full-text search (optional, falls back to PostgreSQL) |

## Quick Start

```bash
# Start all services (PostgreSQL, Redis, Elasticsearch, API, Frontend)
npm run dev

# Or just the backend services
npm start
```

All services including Elasticsearch are started automatically via `concurrently`.

## PostgreSQL

### macOS (Native)
```bash
# Install
brew install postgresql@15
brew services start postgresql@15

# Create database
createdb caw_dev
```

### Docker
```bash
docker run -d --name postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=caw_dev \
  -p 5432:5432 \
  postgres:15
```

## Redis

### macOS (Native)
```bash
# Install and start
brew install redis
brew services start redis

# Or run manually
redis-server
```

### Docker
```bash
docker run -d --name redis -p 6379:6379 redis:7-alpine
```

## Elasticsearch

Elasticsearch enables fast full-text search with relevance ranking. Without it, search falls back to PostgreSQL `ILIKE` queries (which work fine for small datasets).

### macOS (Native - Recommended for Development)

1. Download Elasticsearch 8.11.0 for Apple Silicon:
```bash
curl -L -o /tmp/elasticsearch.tar.gz \
  "https://artifacts.elastic.co/downloads/elasticsearch/elasticsearch-8.11.0-darwin-aarch64.tar.gz"
```

2. Extract to home directory:
```bash
mkdir -p ~/elasticsearch
tar -xzf /tmp/elasticsearch.tar.gz -C ~/elasticsearch --strip-components=1
```

3. Configure for local development (disable security):
```bash
cat >> ~/elasticsearch/config/elasticsearch.yml << 'EOF'

# CAW Dev Config
xpack.security.enabled: false
xpack.security.enrollment.enabled: false
xpack.security.http.ssl.enabled: false
xpack.security.transport.ssl.enabled: false
discovery.type: single-node
indices.memory.index_buffer_size: 10%
EOF
```

4. Start Elasticsearch:
```bash
# Start in background
~/elasticsearch/bin/elasticsearch -d -p ~/elasticsearch/elasticsearch.pid

# Verify it's running
curl http://localhost:9200
```

5. Stop Elasticsearch:
```bash
kill $(cat ~/elasticsearch/elasticsearch.pid)
```

### Docker
```bash
docker run -d --name elasticsearch \
  -p 9200:9200 -p 9300:9300 \
  -e "discovery.type=single-node" \
  -e "xpack.security.enabled=false" \
  -e "ES_JAVA_OPTS=-Xms512m -Xmx512m" \
  elasticsearch:8.11.0
```

### Syncing Data to Elasticsearch

After starting Elasticsearch, sync existing data:
```bash
curl -X POST http://localhost:4000/api/search/sync
```

Check status:
```bash
curl http://localhost:4000/api/search/status
# {"elasticsearch":"connected"}
```

## Environment Variables

Create a `.env` file in the client directory:

```bash
# Database
DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5432/caw_dev"

# RPC URLs (get from Infura, Alchemy, etc.)
L1_RPC_URL="wss://eth-sepolia.g.alchemy.com/v2/YOUR_API_KEY"
L2_RPC_URL="wss://base-sepolia.infura.io/ws/v3/YOUR_API_KEY"
L2_RPC_URL_HTTP="https://base-sepolia.infura.io/v3/YOUR_API_KEY"
MAINNET_RPC_URL="https://sepolia.drpc.org"

# Validator (for signing transactions)
VALIDATOR_PRIVATE_KEY="0x..."

# Optional
GIPHY_API_KEY="YOUR_GIPHY_API_KEY"
ELASTICSEARCH_NODE="http://localhost:9200"  # Default, can override
```

## Troubleshooting

### Elasticsearch shows "disconnected"
1. Check ES is running: `curl http://localhost:9200`
2. Restart the API server - ES reconnects on startup
3. Check version compatibility - client and server must match (both 8.x)
4. ES starts automatically with `npm run dev` - no manual start needed

### Starting Elasticsearch manually (if needed)
```bash
# Start
~/elasticsearch/bin/elasticsearch -d -p ~/elasticsearch/elasticsearch.pid

# Stop
kill $(cat ~/elasticsearch/elasticsearch.pid)

# Or use npm script
npm run elasticsearch
```

### PostgreSQL connection refused
1. Check PostgreSQL is running: `brew services list`
2. Verify DATABASE_URL in .env matches your setup

### Redis connection error
1. Check Redis is running: `redis-cli ping` (should return PONG)
2. Default URL is `redis://127.0.0.1:6379`
