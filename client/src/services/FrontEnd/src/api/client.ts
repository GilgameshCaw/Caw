// src/services/FrontEnd/src/api/client.ts

import { useTokenDataStore } from "~/store/tokenDataStore";
import { useAuthStore } from "~/store/authStore";
import { useVerifyWalletStore } from "~/store/verifyWalletStore";

/**
 * natstat: Base URL for all API calls
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
 * natstat: wrapper around fetch that prefixes our API host
 */
export async function apiFetch<T = any>(
  path: string,
  init?: RequestInit
): Promise<T> {
  // Get activeTokenId directly from store state (not using hooks)
  const state = useTokenDataStore.getState()
  const tokens = Object.values(state.tokensByAddress).flat()
  const activeToken = tokens.find(t => t.tokenId === state.activeTokenId) || tokens[0]
  const activeTokenId = activeToken?.tokenId

  // Get session token
  const sessionToken = useAuthStore.getState().sessionToken

  const url = `${API_HOST}${path}`
  // build headers
  const headers: Record<string,string> = {
    'Accept':       'application/json',
    'Content-Type': 'application/json',
    // only add x-user-id if we actually have one (including 0)
    ...(activeTokenId !== undefined ? { 'x-user-id': String(activeTokenId) } : {}),
    // attach session token if we have one
    ...(sessionToken ? { 'x-session-token': sessionToken } : {}),
  }

  const res = await fetch(url, {
    ...init,
    headers: {
      ...headers,
      ...(init?.headers as Record<string,string>||{})
    }
  })

  if (res.status === 401) {
    // Try to parse the error response
    let errorData: any = {}
    try { errorData = await res.json() } catch {}

    if (errorData.error === 'AUTH_REQUIRED' || errorData.error === 'TOKEN_NOT_AUTHORIZED') {
      // Trigger the verify wallet modal
      useVerifyWalletStore.getState().show()
      throw new AuthError(
        errorData.message || 'Authentication required',
        errorData.error,
        errorData.tokenId
      )
    }
  }

  if (!res.ok) throw new Error(`API ${res.status} ${res.statusText}`)
  return res.json()
}
