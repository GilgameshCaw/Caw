import type { SignedAction } from "./signing.js"

const DEFAULT_BASE = "https://caw.is"

export class CawApi {
  private base: string

  constructor(base?: string) {
    this.base = (base || process.env.CAW_API_URL || DEFAULT_BASE).replace(/\/$/, "")
  }

  private async get<T>(path: string, params?: Record<string, string | undefined>): Promise<T> {
    const url = new URL(path, this.base)
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) url.searchParams.set(k, v)
      }
    }
    const res = await fetch(url.toString())
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      throw new Error(`CAW API ${res.status}: ${body || res.statusText}`)
    }
    return res.json() as Promise<T>
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const url = new URL(path, this.base)
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      throw new Error(`CAW API ${res.status}: ${text || res.statusText}`)
    }
    return res.json() as Promise<T>
  }

  getPost(id: string) {
    return this.get(`/api/caws/${encodeURIComponent(id)}`)
  }

  getUser(username: string) {
    return this.get(`/api/users/${encodeURIComponent(username)}`)
  }

  searchPosts(query: string, limit?: number, offset?: number) {
    return this.get("/api/search/caws", {
      q: query,
      limit: String(limit || 20),
      offset: String(offset || 0),
    })
  }

  searchUsers(query: string, limit?: number) {
    return this.get("/api/search/users", {
      q: query,
      limit: String(limit || 10),
    })
  }

  getFeed(filter?: string, limit?: number, cursor?: string) {
    return this.get("/api/caws", {
      filter,
      limit: String(limit || 20),
      cursor,
    })
  }

  getStats() {
    return this.get("/api/stats")
  }

  getPrices() {
    return this.get("/api/prices")
  }

  searchHashtags(query: string, limit?: number) {
    return this.get("/api/search/hashtags", {
      q: query,
      limit: String(limit || 20),
    })
  }

  getMarketplaceListings(sort?: string, limit?: number, cursor?: string) {
    return this.get("/api/marketplace/listings", {
      sort,
      limit: String(limit || 20),
      cursor,
    })
  }

  getUserFollowers(username: string, limit?: number, cursor?: string) {
    return this.get(`/api/users/${encodeURIComponent(username)}/followers`, {
      limit: String(limit || 20),
      cursor,
    })
  }

  getUserFollowing(username: string, limit?: number, cursor?: string) {
    return this.get(`/api/users/${encodeURIComponent(username)}/following`, {
      limit: String(limit || 20),
      cursor,
    })
  }

  getCawonceHint(senderId: number) {
    return this.get<{ cawonce: number }>("/api/actions/hint/cawonce", {
      senderId: String(senderId),
    })
  }

  submitAction(signed: SignedAction) {
    return this.post("/api/actions", signed)
  }
}
