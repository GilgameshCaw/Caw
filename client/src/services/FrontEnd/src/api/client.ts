// src/services/FrontEnd/src/api/client.ts

import { useTokenDataStore } from '~/store/tokenDataStore'

/**  
 * natstat: Base URL for all API calls  
 */  
export const API_HOST = import.meta.env.VITE_API_HOST ?? ''

/**  
 * natstat: wrapper around fetch that prefixes our API host  
 */  
export async function apiFetch(
  path: string,
  init?: RequestInit
): Promise<any> {
  const activeTokenId = useTokenDataStore.getState().activeTokenId

  const url = `${API_HOST}${path}`
  // build headers
  const headers: Record<string,string> = {
    'Accept':       'application/json',
    'Content-Type': 'application/json',
    // only add x-user-id if we actually have one
    ...(activeTokenId ? { 'x-user-id': String(activeTokenId) } : {})
  }
console.log("WILL FETCH WITH USER:", headers)

  const res = await fetch(`${API_HOST}${path}`, {
    ...init,
    headers: {
      ...headers,
      ...(init?.headers as Record<string,string>||{})
    }
  })
  if (!res.ok) throw new Error(`API ${res.status} ${res.statusText}`)
  return res.json()
}

