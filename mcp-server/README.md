# @caw-protocol/mcp-server

[![npm version](https://img.shields.io/npm/v/@caw-protocol/mcp-server)](https://www.npmjs.com/package/@caw-protocol/mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)

MCP (Model Context Protocol) server for the [CAW Protocol](https://caw.is). Provides read and write access to CAW social data — posts, profiles, search, protocol stats, and social actions — through any MCP-compatible client.

Built for developers integrating with the CAW Social Name Service (SNS) and for AI agents that need to interact with the protocol programmatically.

## Prerequisites

- Node.js 18+
- A running CAW API instance (or use the public endpoint)

## Installation

```bash
npm install -g @caw-protocol/mcp-server
```

Or run directly with npx:

```bash
npx @caw-protocol/mcp-server
```

## Quick Start

### Read-Only Mode (default)

Add to your MCP client settings (Claude Code, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "caw": {
      "command": "caw-mcp",
      "env": {
        "CAW_API_URL": "https://caw.is"
      }
    }
  }
}
```

### Read + Write Mode (with session key)

To enable write actions (post, like, follow, repost), provide a session key and sender configuration:

```json
{
  "mcpServers": {
    "caw": {
      "command": "caw-mcp",
      "env": {
        "CAW_API_URL": "https://caw.is",
        "CAW_SESSION_KEY": "0x...",
        "CAW_SENDER_ID": "42",
        "CAW_CLIENT_ID": "1",
        "CAW_CHAIN_ID": "84532",
        "CAW_VERIFYING_CONTRACT": "0x..."
      }
    }
  }
}
```

Session keys are created through the CAW frontend (Settings > Quick Sign). They are time-limited, spend-capped, and revocable — the agent can only operate within the boundaries the user defined.

### Local Development

```json
{
  "mcpServers": {
    "caw": {
      "command": "npx",
      "args": ["tsx", "/path/to/mcp-server/src/index.ts"],
      "env": {
        "CAW_API_URL": "http://localhost:3001"
      }
    }
  }
}
```

## Configuration

| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| `CAW_API_URL` | Base URL of the CAW API instance | no | `https://caw.is` |
| `CAW_SESSION_KEY` | Session key private key (hex) | for write tools | — |
| `CAW_SENDER_ID` | Your profile token ID | for write tools | — |
| `CAW_CLIENT_ID` | Client/network ID | for write tools | — |
| `CAW_CHAIN_ID` | L2 chain ID (e.g. `84532` for Base Sepolia) | for write tools | — |
| `CAW_VERIFYING_CONTRACT` | CawActions contract address | for write tools | — |

Without the write env vars, the server runs in read-only mode. All 11 read tools are always available.

## Read Tools

### `get_post`

Fetch a single post by ID. Returns content, author info, engagement stats, and metadata.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | yes | The post ID |

### `get_user`

Fetch a user profile by username. Returns display name, bio, wallet address, follower/following counts, staked CAW amount, and account creation date.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `username` | string | yes | The username (without @) |

### `search_posts`

Full-text search across all posts.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | yes | Search query |
| `limit` | number | no | Max results (default: 20, max: 50) |
| `offset` | number | no | Pagination offset (default: 0) |

### `search_users`

Search users by username or display name.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | yes | Search query |
| `limit` | number | no | Max results (default: 10, max: 50) |

### `search_hashtags`

Search trending or matching hashtags.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | yes | Hashtag search query (without #) |
| `limit` | number | no | Max results (default: 20, max: 50) |

### `get_feed`

Fetch the latest posts from the protocol.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filter` | string | no | `"media"` or `"trending"` |
| `limit` | number | no | Max posts (default: 20, max: 50) |
| `cursor` | string | no | Cursor from previous response for pagination |

### `get_stats`

Returns global protocol statistics — total users, posts, active networks, and more. No parameters.

### `get_prices`

Returns current CAW token price and market data. No parameters.

### `get_marketplace_listings`

Fetch CAW username marketplace listings — usernames available for sale or auction.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sort` | string | no | `"newest"`, `"price_asc"`, `"price_desc"`, or `"ending_soon"` |
| `limit` | number | no | Max results (default: 20, max: 50) |
| `cursor` | string | no | Cursor for pagination |

### `get_user_followers`

Fetch the followers of a CAW user.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `username` | string | yes | The username (without @) |
| `limit` | number | no | Max results (default: 20, max: 50) |
| `cursor` | string | no | Cursor for pagination |

### `get_user_following`

Fetch the accounts a CAW user is following.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `username` | string | yes | The username (without @) |
| `limit` | number | no | Max results (default: 20, max: 50) |
| `cursor` | string | no | Cursor for pagination |

## Write Tools

Available only when session key is configured. All actions are signed with the session key and submitted through the standard API — same flow as the frontend. The session key's spend limit, duration, and scope apply.

### `create_post`

Create a new post (caw) on the protocol.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `text` | string | yes | Post content (max 420 characters) |

### `like_post`

Like an existing post.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `post_id` | number | yes | The post ID to like |
| `author_id` | number | yes | The post author's token ID |

### `follow_user`

Follow a user.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `user_id` | number | yes | The token ID of the user to follow |

### `repost`

Repost (recaw) an existing post.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `post_id` | number | yes | The post ID to repost |
| `author_id` | number | yes | The original post author's token ID |

## Example Prompts

Once connected, you can ask your AI assistant things like:

- *"Show me the latest posts on CAW"*
- *"Look up the profile for @satoshi"*
- *"Search for posts about decentralized identity"*
- *"What's the current CAW token price?"*
- *"How many users does the CAW protocol have?"*
- *"What usernames are for sale on the marketplace?"*
- *"Post 'Hello from my AI agent!' on CAW"* (requires session key)
- *"Like post #1234"* (requires session key)

## Security Model

Write tools use **CAW session keys** — derived keys created through the frontend with explicit boundaries:

- **Spend limit** — maximum CAW tokens the session can spend
- **Duration** — session key expires after the configured time
- **Scope** — session key can only perform the action types the user allowed
- **Revocable** — user can revoke the session key at any time from the frontend

The user's wallet private key is never exposed to the MCP server. Session keys can only spend from pre-deposited CAW within the configured limits. If the session key is compromised, the maximum damage is bounded by the spend limit.

## Architecture

```
src/
  index.ts      Server entrypoint — stdio transport, tool routing
  tools.ts      Tool definitions (schemas + handlers)
  api.ts        HTTP client for the CAW REST API
  signing.ts    EIP-712 action signing with session keys
```

The server communicates over **stdio** using the MCP JSON-RPC protocol. Read tools map directly to public API endpoints. Write tools sign EIP-712 typed data with the session key and submit through the standard action endpoint — identical to how the frontend submits actions.

## Debugging

The server logs to **stderr** (stdout is reserved for MCP JSON-RPC). On startup it prints the configured API URL, mode, and tool count. Each tool call is logged with its name and any errors.

To see logs when running via an MCP client, check the client's server output panel. For manual testing:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' | npx tsx src/index.ts
```

Startup output (stderr):

```
[caw-mcp] API: https://caw.is
[caw-mcp] Mode: read-only
[caw-mcp] Tools: 11 read
```

## Building from Source

```bash
git clone https://github.com/nicefacer/Caw.git
cd Caw/mcp-server
npm install
npm run build
```

## License

MIT
