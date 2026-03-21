// src/services/FrontEnd/src/api/client.ts

import { useTokenDataStore } from "~/store/tokenDataStore";
import { useAuthStore } from "~/store/authStore";
import { useVerifyWalletStore } from "~/store/verifyWalletStore";
import { useInstanceStore } from "~/store/instanceStore";

/**
 * natstat: Base URL for all API calls.
 * If set, this is the preferred API host. If empty, instance discovery takes over.
 */
export const API_HOST = import.meta.env.VITE_API_HOST ?? ''

/**
 * Get auth headers for direct fetch calls (e.g., multipart uploads that can't use apiFetch)
 */
export function getAuthHeaders(): Record<string, string> {
  const sessionToken = useAuthStore.getState().sessionToken
  return sessionToken ? { 'x-session-token': sessionToken } : {}
}

/**
 * Custom error for auth failures that need user interaction
 */
export class AuthError extends Error {
  constructor(
    message: string,
    public code: 'AUTH_REQUIRED' | 'TOKEN_NOT_AUTHORIZED',
    public tokenId?: number
  ) {
    super(message)
    this.name = 'AuthError'
  }
}

/**
 * Build common request headers (auth, user ID, content type)
 */
function buildHeaders(init?: RequestInit): Record<string, string> {
  const state = useTokenDataStore.getState()
  const tokens = Object.values(state.tokensByAddress).flat()
  const activeToken = tokens.find(t => t.tokenId === state.activeTokenId) || tokens[0]
  const activeTokenId = activeToken?.tokenId
  const sessionToken = useAuthStore.getState().sessionToken

  return {
    'Accept':       'application/json',
    'Content-Type': 'application/json',
    ...(activeTokenId !== undefined ? { 'x-user-id': String(activeTokenId) } : {}),
    ...(sessionToken ? { 'x-session-token': sessionToken } : {}),
    ...(init?.headers as Record<string,string> || {}),
  }
}

/**
 * Handle auth-related response errors (401)
 */
function handleAuthError(_res: Response, errorData: any): never {
  useVerifyWalletStore.getState().show()
  throw new AuthError(
    errorData.message || 'Authentication required',
    errorData.error,
    errorData.tokenId
  )
}

/**
 * natstat: wrapper around fetch that prefixes our API host.
 * Supports multi-instance failover: tries each known API host in order.
 * Falls back to VITE_API_HOST if no instances are discovered.
 */
export async function apiFetch<T = any>(
  path: string,
  init?: RequestInit
): Promise<T> {
  const headers = buildHeaders(init)

  // Get ordered list of API hosts (preferred first, then on-chain instances)
  const hosts = useInstanceStore.getState().getApiHosts()

  // If no discovered instances, fall back to API_HOST (may be empty for dev proxy)
  const targets = hosts.length > 0 ? hosts : [API_HOST]

  let lastError: Error | null = null

  for (const host of targets) {
    try {
      const url = `${host}${path}`
      const res = await fetch(url, {
        ...init,
        headers,
      })

      // Auth errors are not failover-able — they mean the user needs to re-auth
      if (res.status === 401) {
        let errorData: any = {}
        try { errorData = await res.json() } catch {}
        if (errorData.error === 'AUTH_REQUIRED') {
          // Session expired or missing server-side — clear stale client state
          useAuthStore.getState().clearSession()
        }
        const method = (init?.method || 'GET').toUpperCase()
        if (method !== 'GET' && (errorData.error === 'AUTH_REQUIRED' || errorData.error === 'TOKEN_NOT_AUTHORIZED')) {
          handleAuthError(res, errorData)
        }
      }

      // Client errors (4xx) are not the instance's fault — don't failover
      // Server errors (5xx) mean this instance is unhealthy — try the next one
      if (res.status >= 500) {
        lastError = new Error(`API ${res.status} ${res.statusText}`)
        continue
      }

      if (!res.ok) throw new Error(`API ${res.status} ${res.statusText}`)

      // Track which host we're actively using
      useInstanceStore.getState().setActiveApiHost(host)

      return res.json()
    } catch (e: any) {
      // Network errors (ECONNREFUSED, timeout, etc.) — try next instance
      if (e instanceof AuthError) throw e
      lastError = e
      if (targets.length > 1) {
        console.warn(`[apiFetch] Instance ${host} failed, trying next...`, e.message)
      }
      continue
    }
  }

  throw lastError ?? new Error('No API instances available')
}
