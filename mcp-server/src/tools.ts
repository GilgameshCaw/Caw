import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import type { CawApi } from "./api.js"
import { signAction } from "./signing.js"

export const TOOLS: Tool[] = [
  {
    name: "get_post",
    description: "Fetch a single CAW post by ID. Returns content, author, engagement stats, and metadata.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The post ID" },
      },
      required: ["id"],
    },
  },
  {
    name: "get_user",
    description: "Fetch a CAW user profile by username. Returns display name, bio, wallet address, follower/following counts, stake amount, and creation date.",
    inputSchema: {
      type: "object",
      properties: {
        username: { type: "string", description: "The username (without @)" },
      },
      required: ["username"],
    },
  },
  {
    name: "search_posts",
    description: "Full-text search across CAW posts. Returns matching posts with content and engagement stats.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        limit: { type: "number", description: "Max results (default 20, max 50)" },
        offset: { type: "number", description: "Offset for pagination (default 0)" },
      },
      required: ["query"],
    },
  },
  {
    name: "search_users",
    description: "Search CAW users by username or display name.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        limit: { type: "number", description: "Max results (default 10, max 50)" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_feed",
    description: "Fetch the latest posts from the CAW protocol. Supports optional filters. Note: 'following' filter requires authentication (not available in v1).",
    inputSchema: {
      type: "object",
      properties: {
        filter: {
          type: "string",
          enum: ["media", "trending"],
          description: "Optional feed filter",
        },
        limit: { type: "number", description: "Max posts to return (default 20, max 50)" },
        cursor: { type: "string", description: "Cursor for pagination (from previous response)" },
      },
    },
  },
  {
    name: "get_stats",
    description: "Get global CAW protocol statistics: total users, posts, active networks, etc.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_prices",
    description: "Get current CAW token price and market data.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "search_hashtags",
    description: "Search trending or matching hashtags on CAW.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Hashtag search query (without #)" },
        limit: { type: "number", description: "Max results (default 20, max 50)" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_marketplace_listings",
    description: "Fetch CAW username marketplace listings — usernames available for sale or auction.",
    inputSchema: {
      type: "object",
      properties: {
        sort: { type: "string", enum: ["newest", "price_asc", "price_desc", "ending_soon"], description: "Sort order" },
        limit: { type: "number", description: "Max results (default 20, max 50)" },
        cursor: { type: "string", description: "Cursor for pagination" },
      },
    },
  },
  {
    name: "get_user_followers",
    description: "Fetch the followers of a CAW user.",
    inputSchema: {
      type: "object",
      properties: {
        username: { type: "string", description: "The username (without @)" },
        limit: { type: "number", description: "Max results (default 20, max 50)" },
        cursor: { type: "string", description: "Cursor for pagination" },
      },
      required: ["username"],
    },
  },
  {
    name: "get_user_following",
    description: "Fetch the accounts a CAW user is following.",
    inputSchema: {
      type: "object",
      properties: {
        username: { type: "string", description: "The username (without @)" },
        limit: { type: "number", description: "Max results (default 20, max 50)" },
        cursor: { type: "string", description: "Cursor for pagination" },
      },
      required: ["username"],
    },
  },
]

export const WRITE_TOOLS: Tool[] = [
  {
    name: "create_post",
    description: "Create a new post (caw) on the protocol. Requires CAW_SESSION_KEY to be configured.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Post content (max 420 characters)" },
      },
      required: ["text"],
    },
  },
  {
    name: "like_post",
    description: "Like a post. Requires CAW_SESSION_KEY to be configured.",
    inputSchema: {
      type: "object",
      properties: {
        post_id: { type: "number", description: "The post ID to like" },
        author_id: { type: "number", description: "The post author's token ID" },
      },
      required: ["post_id", "author_id"],
    },
  },
  {
    name: "follow_user",
    description: "Follow a user. Requires CAW_SESSION_KEY to be configured.",
    inputSchema: {
      type: "object",
      properties: {
        user_id: { type: "number", description: "The token ID of the user to follow" },
      },
      required: ["user_id"],
    },
  },
  {
    name: "repost",
    description: "Repost (recaw) an existing post. Requires CAW_SESSION_KEY to be configured.",
    inputSchema: {
      type: "object",
      properties: {
        post_id: { type: "number", description: "The post ID to repost" },
        author_id: { type: "number", description: "The original post author's token ID" },
      },
      required: ["post_id", "author_id"],
    },
  },
]

export interface WriteConfig {
  sessionKey: `0x${string}`
  senderId: number
  clientId: number
  chainId: number
  verifyingContract: `0x${string}`
}

export function getWriteConfig(): WriteConfig | null {
  const key = process.env.CAW_SESSION_KEY
  const sender = process.env.CAW_SENDER_ID
  const client = process.env.CAW_CLIENT_ID
  const chain = process.env.CAW_CHAIN_ID
  const contract = process.env.CAW_VERIFYING_CONTRACT
  if (!key || !sender || !client || !chain || !contract) return null
  return {
    sessionKey: key as `0x${string}`,
    senderId: Number(sender),
    clientId: Number(client),
    chainId: Number(chain),
    verifyingContract: contract as `0x${string}`,
  }
}

async function handleWriteToolCall(
  api: CawApi,
  config: WriteConfig,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const hint = await api.getCawonceHint(config.senderId)
  const cawonce = hint.cawonce

  let signed
  switch (name) {
    case "create_post": {
      const text = args.text as string
      if (!text || text.trim().length === 0) {
        return { content: [{ type: "text", text: "Post text cannot be empty." }], isError: true }
      }
      if (text.length > 420) {
        return { content: [{ type: "text", text: `Post text exceeds 420 character limit (${text.length} characters).` }], isError: true }
      }
      signed = await signAction({
        ...config,
        cawonce,
        actionType: "caw",
        text,
      })
      break
    }
    case "like_post":
      signed = await signAction({
        ...config,
        cawonce,
        actionType: "like",
        receiverId: args.author_id as number,
        receiverCawonce: args.post_id as number,
      })
      break
    case "follow_user":
      signed = await signAction({
        ...config,
        cawonce,
        actionType: "follow",
        receiverId: args.user_id as number,
      })
      break
    case "repost":
      signed = await signAction({
        ...config,
        cawonce,
        actionType: "recaw",
        receiverId: args.author_id as number,
        receiverCawonce: args.post_id as number,
      })
      break
    default:
      return { content: [{ type: "text", text: `Unknown write tool: ${name}` }], isError: true }
  }

  const result = await api.submitAction(signed)
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }
}

export async function handleToolCall(
  api: CawApi,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  try {
    const writeConfig = getWriteConfig()
    if (WRITE_TOOLS.some(t => t.name === name)) {
      if (!writeConfig) {
        return {
          content: [{ type: "text", text: "Write tools require CAW_SESSION_KEY, CAW_SENDER_ID, CAW_CLIENT_ID, CAW_CHAIN_ID, and CAW_VERIFYING_CONTRACT environment variables." }],
          isError: true,
        }
      }
      return await handleWriteToolCall(api, writeConfig, name, args)
    }

    let result: unknown

    switch (name) {
      case "get_post":
        result = await api.getPost(args.id as string)
        break
      case "get_user":
        result = await api.getUser(args.username as string)
        break
      case "search_posts":
        result = await api.searchPosts(
          args.query as string,
          args.limit as number | undefined,
          args.offset as number | undefined,
        )
        break
      case "search_users":
        result = await api.searchUsers(
          args.query as string,
          args.limit as number | undefined,
        )
        break
      case "get_feed":
        result = await api.getFeed(
          args.filter as string | undefined,
          args.limit as number | undefined,
          args.cursor as string | undefined,
        )
        break
      case "get_stats":
        result = await api.getStats()
        break
      case "get_prices":
        result = await api.getPrices()
        break
      case "search_hashtags":
        result = await api.searchHashtags(
          args.query as string,
          args.limit as number | undefined,
        )
        break
      case "get_marketplace_listings":
        result = await api.getMarketplaceListings(
          args.sort as string | undefined,
          args.limit as number | undefined,
          args.cursor as string | undefined,
        )
        break
      case "get_user_followers":
        result = await api.getUserFollowers(
          args.username as string,
          args.limit as number | undefined,
          args.cursor as string | undefined,
        )
        break
      case "get_user_following":
        result = await api.getUserFollowing(
          args.username as string,
          args.limit as number | undefined,
          args.cursor as string | undefined,
        )
        break
      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        }
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    }
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err)
    const isNetwork = raw.includes("fetch failed") || raw.includes("ECONNREFUSED") || raw.includes("ETIMEDOUT")
    const message = isNetwork
      ? `Cannot reach the CAW API (${process.env.CAW_API_URL || "https://caw.is"}). Check that CAW_API_URL is correct and the server is running.`
      : raw
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    }
  }
}
