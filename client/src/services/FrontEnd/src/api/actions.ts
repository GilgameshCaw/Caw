import { useEffect, useState, useRef, useCallback } from "react";
import { apiFetch, retryOnIndexing }              from './client'
import { baseSepolia }           from 'wagmi/chains'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { useSignTypedData, useAccount, useSwitchChain, useChainId } from 'wagmi'
import { readContract } from '@wagmi/core'
// EIP-712 typed-data field shape. Locally declared instead of imported
// from `@ethersproject/abstract-signer` so this module doesn't depend
// on a package that isn't a direct FE dep. The previous import resolved
// locally via hoisting from `solidity/node_modules/` but failed on
// per-workspace VPS installs where no such fallback exists, breaking
// the prod build under `tsc -b`. Shape matches ethers' TypedDataField
// 1:1 ({ name, type }) so the consumer types are unchanged.
type TypedDataField = { name: string; type: string }
import { useActiveToken, useTokenDataStore } from "~/store/tokenDataStore";
import { CAW_ACTIONS_ADDRESS, CAW_NAMES_L2_ADDRESS } from '~/../../../abi/addresses'
import { cawActionsAbi, cawProfileL2Abi } from '~/../../../abi/generated'
import { wagmiConfig } from '~/config/Web3Provider'
import { hasMinimumStake, getRequiredStake, STAKING_REQUIREMENTS } from '~/constants/stakingRequirements'
import { getActionTypeForModal } from '~/errors/InsufficientStakeError'
import { useInsufficientStakeStore } from '~/store/insufficientStakeStore'
import { useAuthStore } from '~/store/authStore'
import { privateKeyToAccount } from 'viem/accounts'
import { keccak256, concat } from 'viem'
import { packActions, getPackedActionSlices } from '~/../../../utils/packActions'
import { useSessionKeyStore } from '~/store/sessionKeyStore'
import { useHasActiveSession } from '~/hooks/useHasActiveSession'
import { useQuickSignRenewStore } from '~/components/modals/QuickSignRenewModal'
import { useClientAuthStore } from '~/store/clientAuthStore'
import toast from 'react-hot-toast'
import { usePendingSpendStore } from '~/store/pendingSpendStore'
import { usePendingPostsStore } from '~/store/pendingPostsStore'
import { useInstanceStore } from '~/store/instanceStore'
import { API_HOST } from './client'


// Cache client auth status per tokenId to avoid repeated RPC calls
const clientAuthCache = new Map<number, boolean>()

/**
 * Read the current on-chain staked CAW balance for a tokenId directly from
 * the L2 contract (cawBalanceOf). Used when writing pending-deposit hints
 * to capture a trustworthy baseline — the wagmi store can be stale, but a
 * fresh RPC call is ground truth. The clearing rule in ProfileChooser
 * relies on this baseline to detect "deposit has landed" by measuring the
 * stake delta, so it must not be wrong.
 *
 * Returns 0n on any failure (fresh mints will legitimately return 0 because
 * the token didn't exist on L2 yet; failures also degrade to 0 which is the
 * safest default — a too-low baseline means the clearing rule needs the
 * absolute stake to reach the deposit amount before firing, which is correct).
 */
export async function readOnChainStakeForHint(tokenId: number): Promise<bigint> {
  try {
    const result = await readContract(wagmiConfig, {
      address: CAW_NAMES_L2_ADDRESS,
      abi: cawProfileL2Abi,
      functionName: 'cawBalanceOf',
      args: [tokenId],
      chainId: baseSepolia.id,
    })
    return BigInt(result?.toString() ?? '0')
  } catch (err) {
    console.warn(`[readOnChainStakeForHint] Failed for tokenId=${tokenId}:`, err)
    return 0n
  }
}

/** map human-friendly names to on-chain enum values */
const ActionTypeMap = {
  caw:      0,
  like:     1,
  unlike:   2,
  recaw:    3,
  follow:   4,
  unfollow: 5,
  withdraw: 6,
  other:    7
} as const

export type ActionTypeKey = keyof typeof ActionTypeMap

/** natstat: singleton client ID (one per front-end). Read from
 * VITE_CLIENT_ID at build time — the CLI writes it; running a build
 * without it produces a NaN here and breaks every contract call, which
 * is the failure mode we want (visible, not silently routing to client 1). */
export const CLIENT_ID = Number(import.meta.env.VITE_CLIENT_ID)
if (!Number.isFinite(CLIENT_ID) || CLIENT_ID <= 0) {
  console.error('[CLIENT_ID] VITE_CLIENT_ID is missing or invalid — frontend will not be able to submit actions correctly. Rebuild with VITE_CLIENT_ID set in client/src/services/FrontEnd/.env')
}

/**
 * Validator tip (in whole CAW tokens - contract multiplies by 10^18)
 *
 * Base tip is fetched from the server (set via admin settings page).
 * Falls back to VITE_VALIDATOR_TIP env var, then 1000.
 */
let BASE_VALIDATOR_TIP = BigInt(import.meta.env.VITE_VALIDATOR_TIP || "1000")
/** Priority tip threshold — actions at/above this get fast-lane processing. */
let PRIORITY_TIP = BASE_VALIDATOR_TIP * 3n

// Fetch live tip config from server on startup
apiFetch<{ baseTip: string; priorityTip: string }>('/api/validator-analytics/tip-config')
  .then(cfg => {
    BASE_VALIDATOR_TIP = BigInt(cfg.baseTip)
    PRIORITY_TIP = BigInt(cfg.priorityTip)
    console.log(`[Actions] Loaded tip config: base=${BASE_VALIDATOR_TIP} CAW, priority=${PRIORITY_TIP} CAW`)
  })
  .catch(() => {
    console.warn('[Actions] Could not fetch tip config, using defaults:', BASE_VALIDATOR_TIP.toString())
  })

/**
 * Calculate the validator tip.
 *
 * If a `ceiling` is provided (whole CAW tokens), the returned tip is capped at that value.
 * A ceiling of 0n means "no tip" (opt-out — the user explicitly chose not to tip).
 * Used by Quick Sign to enforce the per-session tip ceiling the user agreed to at activation.
 */
export function getValidatorTip(ceiling?: bigint): bigint {
  if (ceiling === undefined) return BASE_VALIDATOR_TIP
  if (ceiling === 0n) return 0n // explicit opt-out
  return BASE_VALIDATOR_TIP < ceiling ? BASE_VALIDATOR_TIP : ceiling
}

/** Get the current market tip without any ceiling applied. Used by UI to show "current rate". */
export function getCurrentMarketTip(): bigint {
  return BASE_VALIDATOR_TIP
}

/** Get all three tip tiers for the Quick Sign speed picker.
 *  Returns { slow, standard, fast } as whole CAW token amounts.
 *  - slow: the minimum tip the validator accepts (base tip)
 *  - standard: midpoint between slow and fast — balanced speed/cost
 *  - fast: the priority threshold — skip the batch wait entirely
 */
export function getTipTiers(): { slow: bigint; standard: bigint; fast: bigint } {
  const slow = BASE_VALIDATOR_TIP
  const fast = PRIORITY_TIP
  const standard = (slow + fast) / 2n
  return { slow, standard, fast }
}

/**
 * Check which cawonces in a range are already used (pending or confirmed).
 * Returns the first safe cawonce to start a contiguous block of `count` actions.
 */
export async function findSafeCawonceStart(tokenId: number, start: number, count: number): Promise<number> {
  const result = await apiFetch<{ used: number[]; nextSafe: number }>('/api/users/check-cawonces', {
    method: 'POST',
    body: JSON.stringify({ tokenId, start, count }),
  })
  // If no conflicts, the original start is fine
  if (result.used.length === 0) return start
  // Otherwise use the server's suggestion
  return result.nextSafe
}

// =====================================================================
// Cawonce allocation
// =====================================================================
//
// Three coordination layers, in order of authority:
//
//   1. chain.nextCawonce     — only authoritative source for confirmed
//      actions. Cross-mirror, cross-tab, cross-device truth. Read from
//      cawProfileL2.getTokens([tokenId]).nextCawonce.
//
//   2. localCawonceHigh      — in-flight (signed but not yet confirmed)
//      bookkeeping. Persisted to localStorage AND broadcast over a
//      BroadcastChannel so all tabs of the same origin see each other's
//      bumps in near-real-time. Without the broadcast, two tabs racing
//      to allocate read the same chainNext + same localHigh and pick the
//      same cawonce — exactly the failure that produced TxQueue 11827.
//
//   3. 409 cawonce_collision retry — server-side TxQueue partial unique
//      index catches anything layers 1+2 miss (cross-mirror, cross-device,
//      cross-browser-profile). Server returns suggestedCawonce; FE bumps
//      its watermark and re-signs. This is also the only signal a mirror
//      with stale-by-RPC chain.nextCawonce can use to align with another
//      mirror that just submitted.
//
// We do NOT have a server-side reservation table. The previous
// CawonceReservation system (728baf6, ripped out in 3ff804b) only worked
// for single-server installs — each mirror's reservation table was its
// own private view. Two users posting via two mirrors would each see
// "free" cawonce N and collide at the chain level. Chain truth + per-
// origin BroadcastChannel + 409 retry covers the same use cases without
// that limitation.
//
// What this design does NOT cover (acceptable):
//
//   - Cross-browser races (user has Chrome + Safari open). Each browser
//     has its own localStorage and BroadcastChannel; only layer 3 catches
//     these. Hits a single 409 → bump → retry, transparent to the user
//     except for one extra wallet popup if they're manually signing.
//
//   - Cross-mirror in-flight races (user posts via test.caw.social, then
//     posts via someone-elses-mirror.com within the chain RPC propagation
//     window). Same as above — 409 catches it.
//
//   - Tabs without BroadcastChannel support (very old browsers). Falls
//     back to localStorage polling in getLocalHigh which still gives
//     correctness, just with a wider race window.

// 5 min: long enough to cover a slow manual wallet sign (Safari mobile
// MetaMask is the worst offender, often 15-30s), short enough that an
// abandoned allocation doesn't stale-block subsequent allocations
// indefinitely. After expiry, the next allocation falls back to
// chain.nextCawonce alone — which is correct for confirmed actions but
// will under-count any signed-but-not-submitted action that's still
// pending. The TxQueue 409 retry catches the resulting collision.
const LOCAL_CAWONCE_TTL_MS = 5 * 60_000
const LOCAL_CAWONCE_LS_PREFIX = 'caw:cawonceHigh:'
const CAWONCE_BC_NAME = 'caw-cawonce-v1'

interface CawonceHighEntry { cawonce: number; expiresAt: number }

// In-memory cache, keyed by tokenId. Mirrors what's in localStorage but
// avoids the JSON.parse round-trip on every read. Updated by:
//   - bumpHigh() (this tab's allocations)
//   - storage event listener (other tab in same browser)
//   - BroadcastChannel listener (other tab in same browser, faster)
const memHigh = new Map<number, CawonceHighEntry>()

// BroadcastChannel for near-real-time cross-tab coordination. localStorage
// alone propagates via the 'storage' event but only fires on OTHER tabs
// asynchronously and can lag noticeably under load. BroadcastChannel
// delivers same-microtask to all listeners.
let _bc: BroadcastChannel | null = null
function getBroadcastChannel(): BroadcastChannel | null {
  if (_bc) return _bc
  if (typeof BroadcastChannel === 'undefined') return null
  try {
    _bc = new BroadcastChannel(CAWONCE_BC_NAME)
    _bc.addEventListener('message', (ev: MessageEvent) => {
      const { tokenId, cawonce, expiresAt } = ev.data || {}
      if (typeof tokenId !== 'number' || typeof cawonce !== 'number' || typeof expiresAt !== 'number') return
      const cur = memHigh.get(tokenId)
      // Monotonic merge: a remote bump only wins if it's higher AND not
      // expired. Prevents a stale rebroadcast from clobbering a newer
      // local value (rare but possible if a tab sleeps and wakes).
      if (expiresAt > Date.now() && (!cur || cawonce > cur.cawonce)) {
        memHigh.set(tokenId, { cawonce, expiresAt })
      }
    })
    return _bc
  } catch {
    return null
  }
}

// Initialize listeners lazily — calling on module load works in browsers
// but breaks SSR. Defer to first use of getNextCawonce.
let _listenersInit = false
function initListeners() {
  if (_listenersInit) return
  _listenersInit = true
  getBroadcastChannel() // attaches its own listener
  // Storage event is the cross-tab fallback when BroadcastChannel isn't
  // available, AND a belt-and-braces backup when both are. The 'storage'
  // event only fires on tabs OTHER than the writer.
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('storage', (ev: StorageEvent) => {
      if (!ev.key || !ev.key.startsWith(LOCAL_CAWONCE_LS_PREFIX)) return
      const tokenId = Number(ev.key.slice(LOCAL_CAWONCE_LS_PREFIX.length))
      if (!Number.isFinite(tokenId)) return
      if (!ev.newValue) {
        memHigh.delete(tokenId)
        return
      }
      try {
        const parsed = JSON.parse(ev.newValue)
        if (typeof parsed?.cawonce === 'number' && typeof parsed?.expiresAt === 'number') {
          const cur = memHigh.get(tokenId)
          if (parsed.expiresAt > Date.now() && (!cur || parsed.cawonce > cur.cawonce)) {
            memHigh.set(tokenId, parsed)
          }
        }
      } catch {}
    })
  }
}

function readPersistedHigh(tokenId: number): CawonceHighEntry | undefined {
  try {
    const raw = localStorage.getItem(LOCAL_CAWONCE_LS_PREFIX + tokenId)
    if (!raw) return undefined
    const parsed = JSON.parse(raw)
    if (typeof parsed?.cawonce !== 'number' || typeof parsed?.expiresAt !== 'number') return undefined
    return parsed
  } catch {
    return undefined
  }
}

function persistHigh(tokenId: number, entry: CawonceHighEntry) {
  try {
    localStorage.setItem(LOCAL_CAWONCE_LS_PREFIX + tokenId, JSON.stringify(entry))
  } catch {}
}

/**
 * Get the current local high-watermark for a tokenId, considering:
 *   - in-memory cache (this tab + cross-tab broadcasts)
 *   - localStorage (cold-start / cross-tab persistence)
 *
 * Picks the higher of the two if both exist (safer to over-bump than
 * under-bump). Returns -1 if neither has a non-expired entry.
 */
function getLocalHigh(tokenId: number): number {
  initListeners()
  const now = Date.now()
  const memEntry = memHigh.get(tokenId)
  const memValid = memEntry && memEntry.expiresAt > now ? memEntry.cawonce : -1
  const persisted = readPersistedHigh(tokenId)
  const persistedValid = persisted && persisted.expiresAt > now ? persisted.cawonce : -1
  // Hydrate the cache from disk on cold start so subsequent calls don't
  // need to JSON.parse.
  if (persistedValid > memValid && persisted) {
    memHigh.set(tokenId, persisted)
  }
  return Math.max(memValid, persistedValid)
}

/**
 * Bump the local high-watermark for a tokenId. Synchronous: writes to
 * memory, localStorage, and broadcasts to other tabs in one shot.
 * Idempotent — bumping to a value <= current is a no-op.
 */
function bumpHigh(tokenId: number, cawonce: number) {
  initListeners()
  const now = Date.now()
  const cur = memHigh.get(tokenId)
  if (cur && cur.expiresAt > now && cur.cawonce >= cawonce) {
    // Refresh the TTL without changing the value. Keeps a long signing
    // session from letting the watermark expire mid-flow.
    cur.expiresAt = now + LOCAL_CAWONCE_TTL_MS
    persistHigh(tokenId, cur)
    return
  }
  const entry: CawonceHighEntry = { cawonce, expiresAt: now + LOCAL_CAWONCE_TTL_MS }
  memHigh.set(tokenId, entry)
  persistHigh(tokenId, entry)
  const bc = getBroadcastChannel()
  if (bc) {
    try { bc.postMessage({ tokenId, cawonce, expiresAt: entry.expiresAt }) } catch {}
  }
}

function clearHigh(tokenId: number) {
  memHigh.delete(tokenId)
  try { localStorage.removeItem(LOCAL_CAWONCE_LS_PREFIX + tokenId) } catch {}
  const bc = getBroadcastChannel()
  // Broadcast a clear by sending a low (-1) cawonce with an expired
  // timestamp; receivers will ignore it (won't beat their current value)
  // but will still notice the storage event and clear if needed. Cleanest
  // is to just rely on the storage event for clears across tabs.
  void bc
}

// Per-tokenId promise chain for true serialization of allocations within
// a tab. The previous "wait for inflight then proceed" pattern only
// blocked while an RPC was in flight — once it resolved, multiple awaiters
// raced to do their own read+bump. A linked promise chain forces strict
// FIFO: each caller awaits the previous caller's promise and only then
// runs its own read+bump.
const allocChain = new Map<number, Promise<unknown>>()

/**
 * Allocate `count` consecutive cawonces for `tokenId`. The returned numbers
 * are guaranteed contiguous (e.g. [12, 13, 14] for count=3) and the local
 * watermark + cross-tab broadcasts are bumped past the last one before
 * returning, so any other allocation racing for the same tokenId will pick
 * up where this one left off.
 *
 * Holds a single Web Lock for the whole batch — without that, releasing
 * between each getNextCawonce would let another tab insert its own
 * allocation in the middle, breaking the "contiguous" guarantee that
 * thread submission depends on.
 */
export async function allocateCawonces(tokenId: number, count = 1): Promise<number[]> {
  return await runUnderLock(tokenId, async () => {
    const out: number[] = []
    for (let i = 0; i < count; i++) {
      out.push(await doAllocate(tokenId))
    }
    return out
  })
}

/**
 * Wrap `fn` in:
 *   1. The per-tokenId promise chain (within-tab serialization).
 *   2. The Web Locks API (cross-tab serialization within the same origin).
 *
 * Both layers are needed:
 *   - Web Lock alone doesn't serialize within a tab if multiple async
 *     callers fire within the same microtask before the first acquires
 *     the lock — they'd all queue up at the lock, but the lock acquires
 *     in arbitrary order.
 *   - Promise chain alone covers within-tab but doesn't see other tabs.
 *
 * Falls back to chain-only if Web Locks isn't available (very old browser,
 * SSR). Cross-tab races in that case are caught by the 409 retry.
 */
async function runUnderLock<T>(tokenId: number, fn: () => Promise<T>): Promise<T> {
  const prev = allocChain.get(tokenId) ?? Promise.resolve()
  const run = async () => {
    if (typeof navigator !== 'undefined' && (navigator as any).locks?.request) {
      return await (navigator as any).locks.request(
        `caw-cawonce-${tokenId}`,
        async () => fn()
      )
    }
    return await fn()
  }
  const next = prev.then(run, run)
  const chained = next.finally(() => {
    if (allocChain.get(tokenId) === chained) {
      allocChain.delete(tokenId)
    }
  })
  allocChain.set(tokenId, chained)
  return await next
}

async function doAllocate(tokenId: number): Promise<number> {
  // 1. Chain truth — retry a few times, the RPC throws "0x" /
  // AbiDecodingZeroDataError when Infura rate-limits or the gateway
  // hiccups. Without retries, a single transient failure made
  // chainNext fall back to 0 silently and we'd post with cawonce 0
  // (which collides with the very first post on this token).
  let chainNext: number | null = null
  let lastErr: unknown = null
  const RETRY_DELAYS_MS = [0, 400, 1200, 3000, 6000]
  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
    if (RETRY_DELAYS_MS[attempt] > 0) {
      await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[attempt]))
    }
    try {
      const result = await readContract(wagmiConfig, {
        address: CAW_NAMES_L2_ADDRESS,
        abi: cawProfileL2Abi,
        functionName: 'getTokens',
        args: [[tokenId]],
        chainId: baseSepolia.id,
      }) as any
      const tok = result?.[0]
      const raw = tok?.nextCawonce ?? tok?.[4]
      chainNext = Number(BigInt(raw?.toString() ?? '0'))
      break
    } catch (err) {
      lastErr = err
      if (attempt < RETRY_DELAYS_MS.length - 1) {
        console.warn(`[getNextCawonce] chain read attempt ${attempt + 1} failed for tokenId=${tokenId}, retrying…`)
      }
    }
  }

  // 2. Local high-watermark (this tab + cross-tab via BC + localStorage).
  const localHigh = getLocalHigh(tokenId)

  // 3. If chain read failed AND we have no local watermark, refuse to
  // pick a value. cawonce=0 collides with the first post on a token
  // and a stale localHigh can collide with confirmed posts from other
  // mirrors. Better to surface a real error than silently submit a
  // duplicate that the validator rejects an hour later.
  if (chainNext === null && localHigh < 0) {
    console.error('[getNextCawonce] chain read failed and no local watermark — refusing to allocate', lastErr)
    throw new Error('Could not reach the chain to assign a post number. Please try again in a moment.')
  }

  // 4. Pick the higher, then verify the slot is actually free on chain.
  //
  // chain.nextCawonce returns the first unset bit in the current word
  // (CawActions.nextCawonce: scans usedCawonce[currentMap] for a gap).
  // It's normally correct, but a stale RPC node — or any path that's
  // updated localHigh past a slot whose bitmap state we can't trust
  // (closed-tab signs, cross-mirror leakage) — can hand back a cawonce
  // that's already used. Without this pre-check, the wallet popup goes
  // up, the user signs, the server accepts, and only the validator's
  // simulate eventually rejects with "Cawonce already used" — usually
  // recovered transparently by useTxQueueMonitor, but it's visible to
  // the user as a flash and burns a sig.
  //
  // We try a small number of slots forward; each isCawonceUsed costs one
  // eth_call. Two tries covers the common case (stale chain.nextCawonce
  // missed exactly one used slot). Past that we trust the bitmap-driven
  // chain.nextCawonce + 409 retry to converge.
  const MAX_PROBE = 4
  let allocated = Math.max(chainNext ?? 0, localHigh + 1)
  for (let probe = 0; probe < MAX_PROBE; probe++) {
    let used: boolean
    try {
      used = await readContract(wagmiConfig, {
        address: CAW_ACTIONS_ADDRESS,
        abi: cawActionsAbi,
        functionName: 'isCawonceUsed',
        args: [tokenId, BigInt(allocated)],
        chainId: baseSepolia.id,
      }) as boolean
    } catch (err) {
      // Probe RPC failed — don't block the allocation. The 409 retry
      // path still catches collisions; this pre-check is best-effort.
      console.warn(`[doAllocate] isCawonceUsed probe failed for cawonce=${allocated}, skipping pre-check`, err)
      break
    }
    if (!used) break
    console.warn(`[doAllocate] cawonce=${allocated} already used on chain — bumping past it`)
    bumpHigh(tokenId, allocated)
    allocated += 1
  }

  bumpHigh(tokenId, allocated)
  return allocated
}

/**
 * Reset the local cawonce watermark for a tokenId. Called when an action
 * submission fails — the next signAndSubmit will re-read fresh chain state
 * instead of trusting the (now-known-stale) local watermark. Affects this
 * tab AND any other tabs of the same origin (storage event propagates).
 */
export function invalidateLocalCawonce(tokenId: number) {
  clearHigh(tokenId)
}

/**
 * Push the local watermark to a server-suggested floor. Called on a 409
 * cawonce_collision when the server tells us the highest active cawonce in
 * its TxQueue (chain alone can't see in-flight TxQueue rows). The bump is
 * broadcast so any other tab racing for the same cawonce learns the floor
 * without waiting for its own 409.
 *
 * `suggestedCawonce` is what the SERVER says is the next free slot. The
 * watermark is the "highest issued so far" semantic, so store one less —
 * the next getNextCawonce returns max(chain, localHigh + 1) = suggestedCawonce.
 */
export function setLocalCawonceFloor(tokenId: number, suggestedCawonce: number) {
  bumpHigh(tokenId, suggestedCawonce - 1)
}


/** natstat: EIP-712 domain */
export const DOMAIN = {
  name:               'Caw Protocol',
  version:            '1',
  chainId:            baseSepolia.id,
  verifyingContract:  CAW_ACTIONS_ADDRESS
} as const

/** natstat: EIP-712 types */
export const TYPES: Record<string, TypedDataField[]> = {
  EIP712Domain: [
    { name: 'name',              type: 'string'  },
    { name: 'version',           type: 'string'  },
    { name: 'chainId',           type: 'uint256' },
    { name: 'verifyingContract', type: 'address' }
  ],
  ActionData: [
    { name: 'actionType',      type: 'uint8'    },
    { name: 'senderId',        type: 'uint32'   },
    { name: 'receiverId',      type: 'uint32'   },
    { name: 'receiverCawonce', type: 'uint32'   },
    { name: 'clientId',        type: 'uint32'   },
    { name: 'cawonce',         type: 'uint32'   },
    { name: 'recipients',      type: 'uint32[]' },
    { name: 'amounts',         type: 'uint64[]' },
    { name: 'text',            type: 'bytes'    }
  ]
}

import SmlTxt from 'smltxt'
import { bytesToHex } from 'viem'

// Lazy singleton — table is ~380 KB inlined. First call costs ~1-2s of table parse;
// subsequent calls are instant. Worth deferring until first signature attempt.
let _smlTxt: SmlTxt | undefined
function getSmlTxt(): SmlTxt {
  if (!_smlTxt) _smlTxt = SmlTxt.fromPkg()
  return _smlTxt
}

/** Compress UTF-8 text → 0x-prefixed hex string for an EIP-712 `bytes` field. */
export function compressTextForSigning(text: string): `0x${string}` {
  if (!text) return '0x'
  return bytesToHex(getSmlTxt().compress(text))
}

/** Decompress 0x-prefixed hex from a signed action back to UTF-8 text. */
export function decompressSignedText(hex: string): string {
  if (!hex || hex === '0x') return ''
  const bytes = new Uint8Array(
    (hex.startsWith('0x') ? hex.slice(2) : hex).match(/.{1,2}/g)!.map(b => parseInt(b, 16))
  )
  return getSmlTxt().decompress(bytes)
}

export type ActionParams = {
  actionType:     ActionTypeKey   // now a string key
  senderId:       number
  receiverId?:    number
  receiverCawonce?: number
  cawonce?:       number
  recipients?:    number[]
  amounts?:       BigInt[]
  text?:          string
  retriedTxQueueId?: number
  /** Per-option image URLs for a poll, positional with the options listed
   *  inside the ::poll:...:: marker in `text`. Off-chain — sent to the API
   *  in the request body but NOT included in the signed EIP-712 payload.
   *  The server persists these next to Poll.options. */
  pollOptionImages?: string[]
  /** Internal: incremented when re-entering after a cawonce collision so
   *  we cap auto-retries. Don't set this manually. */
  _cawonceRetryCount?: number
}

/**
 * natstat: build the EIP-712 payload, mapping string→enum and inlining CLIENT_ID
 *
 * @param tipOverride Optional explicit tip (whole CAW tokens) to use instead of the current
 *                    market rate. Used by Quick Sign to enforce per-session tip ceilings.
 *                    Pass `0n` for explicit no-tip (opt-out).
 */
export function buildTypedData(params: ActionParams, tipOverride?: bigint, opts?: { sessionKeySigning?: boolean }) {
  const code = ActionTypeMap[params.actionType]
  if (code === undefined) {
    throw new Error(`Unknown actionType "${params.actionType}"`)
  }
  // Clone the amounts array to avoid mutating the original
  const amounts = [...(params.amounts ?? [])];

  // Three cases for the tip slot:
  //
  //  1) Session-key signing: don't add a tip slot. The contract reads the
  //     per-action tip rate from the session record and credits the
  //     validator once at batch end (gas optimization). amounts only carries
  //     user-to-user transfers (recipients × amounts) when present.
  //
  //  2) OTHER actions with caller-provided amounts: caller already wove the
  //     validator tip into amounts (e.g. tip-action format [tipAmt, valTip]).
  //     Don't add another or it'd double-count.
  //
  //  3) Everything else (manual wallet sign, no caller amounts): append the
  //     current validator tip as the trailing amounts entry.
  const sessionKeySigning = opts?.sessionKeySigning ?? false
  if (sessionKeySigning) {
    // case 1 — leave amounts as-is
  } else if (params.actionType !== 'other' || amounts.length === 0) {
    amounts.push(tipOverride !== undefined ? tipOverride : getValidatorTip());
  }


  return {
    domain:      DOMAIN,
    types:       TYPES,
    primaryType: 'ActionData' as const,
    message: {
      actionType:      code,
      senderId:        params.senderId,
      receiverId:      params.receiverId      ?? 0,
      receiverCawonce: params.receiverCawonce ?? 0,
      clientId:        CLIENT_ID,
      cawonce:         params.cawonce         ?? 0,
      recipients:      params.recipients      ?? [],
      text:            compressTextForSigning(params.text ?? ''),
      amounts:         amounts.map((amount) => amount.toString())
    }
  }
}

/**
 * Retry every TxQueue row in a batchId group as a single new batch.
 *
 * Why this exists: when a thread is submitted via /api/actions/batch
 * and the validator rejects with a recoverable error (e.g. transient
 * "Session expired or not found" — see project memories on the
 * false-positive variants of that classification), every row in the
 * group ends up status=failed. Retrying via the single-action path
 * would either (a) leave siblings dead in the queue, or (b) re-sign
 * each independently — losing the single-batch-sig efficiency the
 * thread originally had, and risking inconsistent cawonce ordering.
 *
 * This re-signs all failed-or-stuck siblings with fresh, contiguous
 * cawonces under ONE new ActionBatch signature, sends them through
 * /api/actions/batch, and marks each original as retried. The new
 * batch is atomic from the validator's perspective.
 *
 * Requires an active Quick Sign session for the sender's owner —
 * the modal-renew flow upstream is expected to have run first.
 * Skips rows already in done/retried state. Returns the number of
 * rows that got resubmitted (0 = nothing to do).
 */
export async function retryBatchByBatchId(
  batchId: number,
  originalTxQueueId: number,
): Promise<{ resubmitted: number; reason?: string }> {
  // Fetch every sibling in the batch from the server (we need their
  // original payloads to re-sign).
  let entries: Array<{
    id: number
    senderId: number
    cawonce: number
    status: string
    payload: any
  }>
  try {
    const res = await apiFetch(`/api/txqueue/batch/${batchId}`)
    entries = res?.entries ?? []
  } catch (err: any) {
    console.warn('[retryBatch] Failed to fetch batch siblings:', err?.message)
    return { resubmitted: 0, reason: 'fetch-failed' }
  }
  if (entries.length === 0) return { resubmitted: 0, reason: 'empty-batch' }

  // Skip rows already terminally resolved by some other path —
  // only retry pending/failed siblings. If the originally-clicked
  // row is already done, exit silently (something else recovered).
  const retryable = entries.filter(e => e.status === 'failed' || e.status === 'pending' || e.status === 'awaiting_indexer')
  if (retryable.length === 0) return { resubmitted: 0, reason: 'nothing-retryable' }

  const senderId = retryable[0].senderId

  // Look up the session key for the sender's owner. The renew modal
  // upstream should have re-established this if the failure was a
  // session-expiry one.
  const userRes = await apiFetch(`/api/users/by-token/${senderId}`)
  const ownerAddress = userRes?.address?.toLowerCase()
  if (!ownerAddress) return { resubmitted: 0, reason: 'no-owner' }
  const sessionStore = useSessionKeyStore.getState()
  const session = sessionStore.getSessionForAddress(ownerAddress)
  if (!session || !sessionStore.enabled || session.expiry < Date.now() / 1000) {
    return { resubmitted: 0, reason: 'no-active-session' }
  }

  // Allocate a contiguous block of fresh cawonces for the whole batch.
  // Using one allocator call here matches what signAndSubmitMany does
  // on the original submission — the resulting cawonces are sequential
  // and won't collide with anything else this tab signs.
  const fresh = await allocateCawonces(senderId, retryable.length)
  if (fresh.length !== retryable.length) {
    return { resubmitted: 0, reason: 'cawonce-alloc-short' }
  }

  // Build typed messages with the fresh cawonces, then ONE ActionBatch
  // signature covering all of them. Mirrors signAndSubmitMany — kept
  // duplicated rather than refactored because the retry context (no
  // tip ceiling lookup, no client-auth precheck, no progress callback,
  // no per-action pending-spend accounting) is different enough that
  // sharing the loop body would tangle both paths.
  const tipCeiling = session.tipCeiling !== undefined
    ? BigInt(session.tipCeiling || '0')
    : undefined
  const effectiveTip = getValidatorTip(tipCeiling)

  const typedItems = retryable.map((row, i) => {
    const originalData = row.payload?.data
    if (!originalData) throw new Error(`Missing payload data on row ${row.id}`)
    const message = { ...originalData, cawonce: fresh[i] }
    // buildTypedData expects ActionParams; row payloads are already in
    // the same shape minus the param-level conveniences. Skip
    // buildTypedData here and reuse the existing data — we ONLY need
    // to bump cawonce. Amounts already include the validator tip.
    void effectiveTip
    return {
      domain: DOMAIN,
      types: TYPES,
      message,
      params: originalData,
    }
  })

  // Pack + hash for ActionBatch.actionsHash. Same logic
  // signAndSubmitMany uses on the original send.
  const sanitizedForPack = typedItems.map(item => ({
    actionType: Number(item.message.actionType),
    senderId: Number(item.message.senderId),
    receiverId: Number(item.message.receiverId || 0),
    receiverCawonce: Number(item.message.receiverCawonce || 0),
    clientId: Number(item.message.clientId),
    cawonce: Number(item.message.cawonce),
    recipients: (item.message.recipients || []).map(Number),
    amounts: (item.message.amounts || []).map((x: any) => BigInt(x)),
    text: item.message.text || '0x',
  }))
  const packedBytes = packActions(sanitizedForPack)
  const slices = getPackedActionSlices(packedBytes)
  const perActionHashes = slices.map((s: Uint8Array) => keccak256(s))
  const actionsHash = keccak256(concat(perActionHashes))

  const batchDomain = typedItems[0].domain
  const batchTypeDef = {
    ActionBatch: [
      { name: 'senderId', type: 'uint32' },
      { name: 'firstCawonce', type: 'uint32' },
      { name: 'actionCount', type: 'uint32' },
      { name: 'actionsHash', type: 'bytes32' },
    ],
  }
  const batchMessage = {
    senderId: Number(typedItems[0].message.senderId),
    firstCawonce: Number(typedItems[0].message.cawonce),
    actionCount: typedItems.length,
    actionsHash,
  }
  const sessionAccount = privateKeyToAccount(session.privateKey)
  const batchSig = await sessionAccount.signTypedData({
    domain: batchDomain as any,
    types: batchTypeDef,
    primaryType: 'ActionBatch',
    message: batchMessage,
  })

  // Submit the new batch. retriedTxQueueIds carries every original row
  // id so the server can mark them all retried atomically (analogous to
  // the single-action path's retriedTxQueueId, just plural).
  const batchPayload = typedItems.map(item => ({ data: item.message }))
  try {
    await retryOnIndexing(() => apiFetch('/api/actions/batch', {
      method: 'POST',
      body: JSON.stringify({
        actions: batchPayload,
        batchSig,
        domain: batchDomain,
        types: batchTypeDef,
        retriedTxQueueIds: retryable.map(r => r.id),
      }),
    }))
  } catch (err: any) {
    console.warn('[retryBatch] Batch resubmit failed:', err?.message)
    return { resubmitted: 0, reason: err?.message || 'submit-failed' }
  }

  // Best-effort: hide the ACTION_FAILED notification(s) for the
  // originally-clicked row. The server's batch handler will hide the
  // others via retriedTxQueueIds → server-side per-row notification
  // cleanup; this just covers the user-clicked case immediately.
  try {
    await apiFetch('/api/notifications/hide-by-original-tx', {
      method: 'POST',
      body: JSON.stringify({ userId: senderId, txQueueId: originalTxQueueId }),
    })
  } catch { /* non-fatal */ }

  console.log(`[retryBatch] Resubmitted ${retryable.length} row(s) of batch ${batchId} (originally clicked ${originalTxQueueId})`)
  return { resubmitted: retryable.length }
}

/**
 * natstat: sign with EIP-712 v4 and enqueue to our API
 */
export function useSignAndSubmitAction() {
  const { isConnected, address }      = useAccount()
  const { openConnectModal } = useConnectModal()
  const { switchChainAsync } = useSwitchChain()
  const walletChainId = useChainId()
  const hasActiveSession = useHasActiveSession()

  const { signTypedDataAsync } = useSignTypedData()
  const activeToken = useActiveToken();
  const cawonce       = activeToken?.cawonce;
  // Kept as a UI hint refresher — chain.nextCawonce is the authority,
  // but we still set the store optimistically so any UI showing
  // "next post will be #N" stays roughly accurate.
  const setCawonce    = useTokenDataStore(s => s.setCawonce)
  const activeTokenId = activeToken?.tokenId

  // ⬇️ buffer for the action the user tried to do before they were connected
  const [pendingParams, setPendingParams] = useState<ActionParams | null>(null)
  const submittingRef = useRef(false) // Use ref to prevent re-entrancy

  const requestAndSubmit = useCallback(async (params: ActionParams) => {
    // Ensure we have an active token ID
    if (!activeTokenId) {
      throw new Error('No active token selected. Please connect your wallet.')
    }

    // Look up session key for the token owner (not the connected wallet).
    // This allows Quick Sign to work regardless of which wallet is connected,
    // since the session key was delegated by the token owner on-chain.
    // Read fresh from the store to avoid stale closures.
    const sessionStore0 = useSessionKeyStore.getState()
    const freshToken = Object.values(useTokenDataStore.getState().tokensByAddress)
      .flat().find(t => t.tokenId === activeTokenId)
    const tokenOwner = freshToken?.owner || activeToken?.owner
    const activeSession0 = tokenOwner
      ? sessionStore0.getActiveSessionForAddress(tokenOwner)
      : sessionStore0.getActiveSession()
    const actionCode0 = ActionTypeMap[params.actionType]
    const canUseSession0 = activeSession0 &&
      actionCode0 !== 6 && // exclude WITHDRAW
      (activeSession0.scopeBitmap & (1 << actionCode0)) !== 0

    if (!canUseSession0 && isConnected && activeToken?.owner && address) {
      if (activeToken.owner.toLowerCase() !== address.toLowerCase()) {
        throw new Error('Wrong wallet connected. Please switch to the correct wallet.')
      }
    }

    // Prompt to enable Quick Sign if it's not active.
    // Only for action types that Quick Sign supports (codes 0-5: caw, like, unlike, recaw, follow, unfollow).
    // Tips (other=7) and withdrawals (6) always require wallet signing — don't prompt for those.
    // Suppress the prompt only when Quick Sign is actually useful right now
    // (we have a session covering this action). If `enabled` is true but
    // `canUseSession0` is false (session expired, wrong scope, etc.), falling
    // through to wallet signing without a heads-up makes clicks feel unresponsive
    // — the user sees "Processing..." with no modal. Prompt them to re-enable
    // Quick Sign or sign manually explicitly.
    const hasActiveSessions = Object.keys(sessionStore0.sessions).length > 0
    const suppressPrompt = sessionStore0.hasSeenPrompt && hasActiveSessions
    const actionEligibleForQuickSign = actionCode0 !== 6 // everything except WITHDRAW
    if (!canUseSession0 && !suppressPrompt && actionEligibleForQuickSign) {
      const { useQuickSignPromptStore } = await import('~/components/modals/QuickSignModal')
      const promptStore = useQuickSignPromptStore.getState()
      if (promptStore.skipOnce) {
        // User chose "Sign Manually" — consume the flag and proceed with wallet signing
        useQuickSignPromptStore.setState({ skipOnce: false })
      } else {
        // Return a promise that resolves when the modal callback completes,
        // or rejects with a user-rejection error if the modal is dismissed
        // without the user choosing an action (so callers like useFollowButton
        // can reset their UI state).
        return new Promise((resolve, reject) => {
          promptStore.show(
            async () => {
              try {
                const result = await requestAndSubmit(params)
                resolve(result)
              } catch (err) {
                reject(err)
              }
            },
            () => {
              // Modal dismissed — treat as user cancellation
              const err = new Error('User dismissed Quick Sign prompt')
              ;(err as any).code = 'ACTION_REJECTED'
              reject(err)
            }
          )
        })
      }
    }

    // Check for minimum stake based on action type
    // Note: unlike and unfollow don't require stake checks
    const stakingKey = params.actionType === 'like' ? 'MIN_STAKE_LIKE' :
                      params.actionType === 'recaw' ? 'MIN_STAKE_REPOST' :
                      params.actionType === 'follow' ? 'MIN_STAKE_FOLLOW' :
                      params.actionType === 'caw' && params.receiverId ? 'MIN_STAKE_COMMENT' :
                      params.actionType === 'caw' ? 'MIN_STAKE_POST' :
                      params.actionType === 'other' ? 'MIN_STAKE_POST' :
                      null

    // Budget math:
    //   budget = onChainStake + pendingDepositAmount - sum(in-flight TxQueue costs)
    //
    // The pending deposit is treated as real spendable budget — it's in flight
    // on L1 and guaranteed to land on L2 unless the tx reverts. The pending
    // TxQueue spend (actions already queued but not yet confirmed on-chain)
    // is subtracted so each queued action "consumes" its own slice of the
    // budget, preventing the user from over-spending. When the action is
    // either confirmed or failed, the pending-spend store releases the slice.
    // Trigger a fresh on-chain token data fetch before reading the stake.
    // Fire-and-forget: we immediately read whatever is currently in the store,
    // but queue the refetch so subsequent action submissions see updated
    // values. We do NOT await because that would add visible latency to
    // every button click. For the mint&deposit-lands case this will self-heal
    // within one click-cycle if the first attempt is wrong.
    try { useTokenDataStore.getState().refetchTokenData?.() } catch {}

    // Self-heal any stale pendingSpend entries before reading the store.
    // getEffectiveStake has stale-cleanup logic that's only triggered when
    // called. Passing 1n guarantees the sweep runs (it's called for its
    // side effect, not its return value).
    usePendingSpendStore.getState().getEffectiveStake(1n)

    const pendingState = usePendingSpendStore.getState()

    // Read the freshest on-chain stake directly from the store rather than
    // the closure-captured activeToken, because activeToken can be stale after
    // the pending deposit lands: the Zustand subscription may not re-fire if
    // the stakedAmount update happens mid-action before this hook re-renders.
    // Pull the value imperatively so the stake check always uses current state.
    const freshTokenDataStore = useTokenDataStore.getState()
    const freshActiveToken = freshTokenDataStore.activeTokenId !== undefined
      ? Object.values(freshTokenDataStore.tokensByAddress).flat().find(t => t.tokenId === freshTokenDataStore.activeTokenId)
      : undefined
    const onChainStake = (freshActiveToken?.stakedAmount ?? activeToken?.stakedAmount) ?? 0n

    // Read pending deposit amount from localStorage (optimistic, written by
    // New.tsx / Staking.tsx / PostMintOnboarding.tsx on L1 tx success) and
    // from the backend (authoritative, written by the PATCH paths when the
    // user exists). Use the larger of the two to avoid double-counting when
    // both are in sync, but still cover the race window where only one has
    // updated yet.
    let localHintWei = 0n
    try {
      const hintRaw = localStorage.getItem(`caw:pendingDeposit:${activeTokenId}`)
      if (hintRaw) {
        const hint = JSON.parse(hintRaw)
        const age = Date.now() - (hint?.at ?? 0)
        if (hint?.amount && age < 30 * 60 * 1000) {
          try { localHintWei = BigInt(hint.amount) } catch {}
        }
      }
    } catch { /* ignore */ }

    let backendPendingWei = 0n
    try {
      const userRes = await apiFetch(`/api/users/by-token/${activeTokenId}`)
      if (userRes?.pendingDepositAmount) {
        try { backendPendingWei = BigInt(userRes.pendingDepositAmount) } catch {}
      }
    } catch (err) {
      console.warn('[Actions] Failed to fetch by-token for pending-deposit check:', err)
    }

    const pendingDepositWei = localHintWei > backendPendingWei ? localHintWei : backendPendingWei
    const userHasPendingDeposit = pendingDepositWei > 0n

    // Explicit signed math — do NOT route through getEffectiveStake because it
    // clamps (onChainStake - pendingSpend) to 0 when onChainStake is zero,
    // which hides the negative overspend and lets pendingSpend fall off the
    // books. We want: total = onChain + pendingDeposit - pendingSpend, clamped
    // at zero only after all three are summed.
    const totalBudgetSigned = onChainStake + pendingDepositWei - pendingState.pendingSpend
    const effectiveStake = totalBudgetSigned > 0n ? totalBudgetSigned : 0n

    console.log(`[StakeCheck] onChain=${onChainStake.toString()}, pendingDeposit=${pendingDepositWei.toString()}, pendingSpend=${pendingState.pendingSpend.toString()}, effectiveBudget=${effectiveStake.toString()}, pendingItems=${Object.keys(pendingState.pendingByTxQueue).length}`)

    if (stakingKey && !hasMinimumStake(effectiveStake, stakingKey)) {
      // Budget is insufficient even counting the pending deposit. Show the
      // insufficient-stake modal with the real remaining budget so the user
      // sees what they can/can't afford. If they still have budget for a
      // cheaper action (e.g. a like at 2k CAW instead of a follow at 30k),
      // the modal's "you have X remaining" messaging lets them pick one.
      const requiredAmount = getRequiredStake(stakingKey)
      const actionTypeForModal = getActionTypeForModal(params.actionType)
      useInsufficientStakeStore.getState().show(effectiveStake, requiredAmount, actionTypeForModal)
      return null
    }

    // Check if user is authenticated with this client. Auth is a one-way flag
    // (once true, always true), so cache aggressively.
    //
    // Primary source: backend ClientAuth table (populated by ChainSyncService
    // indexer watching the L2 Authenticated event) — a fast DB read, no RPC.
    // Fallback: live readContract if the DB says false (the indexer may not
    // have picked up a just-authenticated user yet).
    //
    // Skip the modal entirely if we know a deposit is pending: minting through
    // this client auto-authenticates it, but the L1→L2 LZ message may not have
    // landed yet. The validator's waiting_for_deposit path will hold the action
    // until both the deposit and the client auth arrive.
    if (!clientAuthCache.get(activeTokenId) && !userHasPendingDeposit) {
      try {
        // 1. Ask the backend first
        let isAuthed = false
        let backendReachable = false
        try {
          const res = await apiFetch<{ authenticated: boolean }>(`/api/users/client-auth/${activeTokenId}?clientId=${CLIENT_ID}`)
          backendReachable = true
          isAuthed = !!res?.authenticated
        } catch { /* fall through to RPC fallback */ }

        // 2. If backend says no, verify via live RPC before showing the modal.
        //    The backend might just be behind the indexer.
        //
        // Retry the RPC up to 5 times with exponential backoff — cold-start
        // transport races and transient 429s routinely make the first call
        // return "0x" (AbiDecodingZeroDataError) or throw. A few hundred ms
        // later the same call succeeds, so silent retries are far better UX
        // than immediately surfacing a scary network error.
        if (!isAuthed) {
          let rpcFailed = false
          let lastErr: any = null
          const RETRY_SCHEDULE_MS = [0, 400, 1000, 2500, 5000]
          for (let attempt = 0; attempt < RETRY_SCHEDULE_MS.length; attempt++) {
            if (RETRY_SCHEDULE_MS[attempt] > 0) {
              await new Promise(r => setTimeout(r, RETRY_SCHEDULE_MS[attempt]))
            }
            try {
              isAuthed = !!(await readContract(wagmiConfig, {
                address: CAW_NAMES_L2_ADDRESS,
                abi: cawProfileL2Abi,
                functionName: 'authenticated',
                args: [CLIENT_ID, activeTokenId],
                chainId: baseSepolia.id,
              }))
              rpcFailed = false
              break
            } catch (e) {
              rpcFailed = true
              lastErr = e
              if (attempt < RETRY_SCHEDULE_MS.length - 1) {
                console.warn(`[Actions] client-auth RPC attempt ${attempt + 1} failed, retrying…`)
              }
            }
          }

          if (!isAuthed && rpcFailed) {
            // RPC is the wrong place to hard-fail the post — this is a
            // permission pre-flight, not a money-moving call. The validator
            // re-checks authorization on chain when the action is included,
            // so optimistically letting it through is safe: if the user
            // genuinely isn't authorized the validator rejects with a clear
            // reason. If we hard-fail here, transient RPC blips kill posts
            // for fully-authorized users (saw this bug 2026-05-11). Log
            // loudly and proceed.
            console.warn('[Actions] RPC client-auth fallback failed after retries — proceeding optimistically:', lastErr)
            isAuthed = true
          }
        }

        if (isAuthed) {
          clientAuthCache.set(activeTokenId, true)
        } else {
          return new Promise((resolve, reject) => {
            useClientAuthStore.getState().show(
              activeTokenId,
              async () => {
                try {
                  clientAuthCache.set(activeTokenId, true)
                  const result = await requestAndSubmit(params)
                  resolve(result)
                } catch (err) { reject(err) }
              },
              // Reject on cancel so the caller (e.g. PostForm submit) can
              // unstick its pending state instead of hanging on this Promise.
              () => reject(new Error('Client authentication cancelled'))
            )
          })
        }
      } catch (err) {
        console.warn('[Actions] Failed to check client auth status, proceeding:', err)
      }
    }

    // Wait for token data to be loaded (max 10 seconds)
    let attempts = 0;
    let currentToken;
    let currentCawonce;

    while (attempts < 100) { // 100 attempts * 100ms = 10 seconds max
      const state = useTokenDataStore.getState();

      // Search all addresses for the active token (supports session keys where
      // the connected wallet may differ from the token owner)
      for (const tokens of Object.values(state.tokensByAddress)) {
        const found = tokens.find(t => t.tokenId === activeTokenId);
        if (found) {
          currentToken = found;
          currentCawonce = found.cawonce;
          break;
        }
      }

      if (currentCawonce !== undefined && currentCawonce !== null) {
        break; // Token data is loaded
      }

      // Wait 100ms before trying again
      await new Promise(resolve => setTimeout(resolve, 100));
      attempts++;
    }

    // If still not loaded after waiting, throw error
    if (currentCawonce === undefined || currentCawonce === null) {
      console.error('Token data not loaded:', {
        activeTokenId,
        address,
        allAddresses: Object.keys(useTokenDataStore.getState().tokensByAddress),
        tokensByAddress: useTokenDataStore.getState().tokensByAddress,
        currentToken
      });
      throw new Error('Token data not loaded. Please refresh and try again.')
    }

    // Resolve the cawonce. Two paths:
    //
    //   - Explicit `params.cawonce` (threads): the caller has pre-allocated
    //     a contiguous block via findSafeCawonceStart and is issuing them
    //     one at a time. We trust the input and don't allocate again.
    //
    //   - Default (single action): chain-only allocation via allocateCawonces.
    //     Reads cawProfileL2.getTokens([tokenId]).nextCawonce from L2 and
    //     bumps a per-tab local watermark to keep concurrent in-tab calls
    //     monotonic. The TxQueue partial unique index on (senderId, cawonce)
    //     catches any cross-tab / cross-server race; on collision the
    //     server returns 409 cawonce_collision and signAndSubmit's catch
    //     block invalidates the watermark and retries once with a fresh
    //     chain read.
    let useCawonce: number
    if (params.cawonce != null) {
      useCawonce = params.cawonce
      console.log(`[signAndSubmit] Using pre-allocated cawonce=${useCawonce} for ${params.actionType}`)
    } else {
      const [allocated] = await allocateCawonces(activeTokenId, 1)
      useCawonce = allocated
      // Update the UI hint so any "next post #N" indicator stays roughly
      // accurate. This is non-authoritative — server is the source of truth.
      setCawonce(activeTokenId, allocated + 1)
      console.log(`[signAndSubmit] Server-allocated cawonce=${useCawonce} for ${params.actionType}`)
    }

    // Check for an active session key that covers this action type.
    // Look up by token owner so Quick Sign works regardless of connected wallet.
    const actionCode = ActionTypeMap[params.actionType]
    const sessionStore = useSessionKeyStore.getState()
    const activeSession = tokenOwner
      ? sessionStore.getActiveSessionForAddress(tokenOwner)
      : sessionStore.getActiveSession()

    // If Quick Sign is enabled but session expired, show renewal modal
    const rawSession = tokenOwner
      ? sessionStore.getSessionForAddress(tokenOwner)
      : sessionStore.getSession()
    if (sessionStore.enabled && !activeSession && rawSession) {
      return new Promise((resolve, reject) => {
        useQuickSignRenewStore.getState().show('expired', async () => {
          try {
            const result = await requestAndSubmit(params)
            resolve(result)
          } catch (err) { reject(err) }
        })
      })
    }

    const canUseSession = activeSession &&
      actionCode !== 6 && // exclude WITHDRAW
      (activeSession.scopeBitmap & (1 << actionCode)) !== 0

    // Determine the effective tip for THIS action.
    // - If signing with a session key and the session has a tipCeiling, cap the tip at it.
    //   A ceiling of 0 means "no tip" (opt-out — explicit user choice at session activation).
    // - Otherwise (manual signing) use the current market tip.
    let effectiveTip: bigint
    if (canUseSession && activeSession.tipCeiling !== undefined) {
      const ceiling = BigInt(activeSession.tipCeiling || '0')
      effectiveTip = getValidatorTip(ceiling)
    } else {
      effectiveTip = getValidatorTip()
    }

    const { domain, types, primaryType, message } = buildTypedData(
      { ...params, cawonce: useCawonce },
      effectiveTip,
      { sessionKeySigning: !!canUseSession },
    )

    // Fixed protocol costs per action type (whole CAW tokens) — must match CawActions.sol
    const ACTION_COSTS: Record<string, bigint> = {
      caw: 5000n, like: 2000n, recaw: 4000n, follow: 30000n,
      unlike: 0n, unfollow: 0n, other: 0n, withdraw: 0n,
    }

    // Check spend limit before signing with session key.
    //
    // For 'caw'/'like'/'recaw'/'follow' the cost is the fixed protocol
    // fee (ACTION_COSTS) plus the validator tip — both whole CAW.
    //
    // For 'other' (tips, image uploads, votes, etc.) and 'withdraw',
    // the real cost lives in params.amounts. Tip actions carry
    // [tipAmount, validatorTip] (TipModal.tsx); withdraws carry
    // [withdrawAmount]; image uploads carry [cawCost]; etc. — all
    // whole CAW. We sum them so the gate matches what actually gets
    // spent on chain. Without this, a $20 tip with a $10 session limit
    // sails past the pre-check (protocolCost=0 for 'other', tip alone
    // is small) and only fails minutes later when the validator
    // rejects on settlement and useTxQueueMonitor pops the renew modal
    // late.
    //
    // For 'other', buildTypedData does NOT append the validator tip
    // when amounts is non-empty (the caller already wove it in), so we
    // skip adding effectiveTip again here — that would double-count.
    if (canUseSession) {
      const limit = BigInt(activeSession.spendLimit || '0')
      if (limit > 0n) {
        const spent = BigInt(rawSession?.spent || '0')
        const protocolCost = ACTION_COSTS[params.actionType] || 0n
        let extraAmountsWhole = 0n
        if ((params.actionType === 'other' || params.actionType === 'withdraw') &&
            params.amounts && params.amounts.length > 0) {
          for (const amt of params.amounts) {
            try { extraAmountsWhole += BigInt(amt as any) } catch {}
          }
        }
        const tipForCalc = params.actionType === 'other' ? 0n : effectiveTip
        const totalCost = protocolCost + extraAmountsWhole + tipForCalc
        const remaining = limit - spent
        console.log(`[QuickSign] Spend limit: ${limit}, spent: ${spent}, remaining: ${remaining}, actionCost: ${protocolCost}, extraAmounts: ${extraAmountsWhole}, tip: ${tipForCalc}, totalCost: ${totalCost}`)
        if (spent + totalCost > limit) {
          return new Promise((resolve, reject) => {
            useQuickSignRenewStore.getState().show('spend_limit', async () => {
              try {
                const result = await requestAndSubmit(params)
                resolve(result)
              } catch (err) { reject(err) }
            })
          })
        }
      }
    }

    try {
      let signature: `0x${string}`

      // Auto-switch to L2 before signing if the wallet is on the wrong chain.
      // Without this, the wallet happily signs for the wrong chainId and the
      // server rejects the signature with a 400.
      if (!canUseSession) {
        if (walletChainId !== baseSepolia.id) {
          await switchChainAsync({ chainId: baseSepolia.id })
        }
      }

      if (canUseSession) {
        // Sign with session key — no wallet popup
        const sessionAccount = privateKeyToAccount(activeSession.privateKey)
        signature = await sessionAccount.signTypedData({
          domain,
          types:       { ActionData: TYPES.ActionData },
          primaryType,
          message,
        })
      } else {
        // Fall back to wallet signature (MetaMask popup)
        signature = await signTypedDataAsync({
          domain,
          types:       { ActionData: TYPES.ActionData },
          primaryType,
          message,
        })
      }

      // If there's a pending mint/deposit in localStorage for this sender, forward
      // the L1 tx hash so the server can park the action in waiting_for_deposit
      // until the DataCleaner watcher sees the deposit landed on L2. The server
      // never verifies the hash synchronously — presence alone is a hint, and
      // grief is bounded by a per-sender waiting-slot cap on the server side.
      let pendingDepositTxHash: string | undefined
      try {
        const hintRaw = localStorage.getItem(`caw:pendingDeposit:${activeTokenId}`)
        if (hintRaw) {
          const hint = JSON.parse(hintRaw)
          if (hint?.txHash && typeof hint.txHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(hint.txHash)) {
            // Hard expiry: 30 min stale hint is garbage, ignore and clear it
            const age = Date.now() - (hint.at ?? 0)
            if (age < 30 * 60 * 1000) {
              pendingDepositTxHash = hint.txHash
            } else {
              localStorage.removeItem(`caw:pendingDeposit:${activeTokenId}`)
            }
          }
        }
      } catch { /* ignore */ }

      // Mirror of the deposit hint, for the bundled mintAndDepositAndQuickSign
      // flow: when the action is signed by a session key whose registration
      // tx hasn't yet propagated to L2, the validator should hold the row
      // instead of failing it with "Session expired or not found".
      let pendingQuickSignTxHash: string | undefined
      try {
        // Resolve the token owner for the active sender via the token store.
        let ownerAddress: string | undefined
        const state = useTokenDataStore.getState()
        for (const tokens of Object.values(state.tokensByAddress)) {
          const found = tokens.find(t => t.tokenId === activeTokenId)
          if (found?.owner) { ownerAddress = found.owner.toLowerCase(); break }
        }
        if (ownerAddress) {
          const hintRaw = localStorage.getItem(`caw:pendingQuickSign:${ownerAddress}`)
          if (hintRaw) {
            const hint = JSON.parse(hintRaw)
            if (hint?.txHash && typeof hint.txHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(hint.txHash)) {
              const age = Date.now() - (hint.submittedAt ?? 0)
              if (age < 30 * 60 * 1000) {
                pendingQuickSignTxHash = hint.txHash
              } else {
                localStorage.removeItem(`caw:pendingQuickSign:${ownerAddress}`)
              }
            }
          }
        }
      } catch { /* ignore */ }

      // Retry on 202 ("user not yet indexed") — extremely rare here because
      // allocate-cawonce already gated on the sender row existing, but
      // possible if the User row was deleted between the two calls. Same
      // backoff schedule as allocate.
      const response = await retryOnIndexing(() => apiFetch('/api/actions', {
        method: 'POST',
        body: JSON.stringify({
          data: message, domain, types, signature,
          ...(pendingDepositTxHash ? { pendingDepositTxHash } : {}),
          ...(pendingQuickSignTxHash ? { pendingQuickSignTxHash } : {}),
          ...(params.retriedTxQueueId ? { retriedTxQueueId: params.retriedTxQueueId } : {}),
          // Off-chain poll metadata — image URLs that pair positionally with
          // the options inside the ::poll:...:: marker. Server-side validated
          // in /api/actions before persisting to Poll.optionImages.
          ...(params.pollOptionImages && params.pollOptionImages.length > 0 ? { pollOptionImages: params.pollOptionImages } : {}),
        })
      }))

      // If the server returned auth data (passive auth), store it immediately
      if (response.auth) {
        const { sessionToken: newToken, authorizedTokenIds, authorizedAddresses, expiresAt } = response.auth
        const authState = useAuthStore.getState()
        if (authState.sessionToken && authState.sessionToken === newToken) {
          // Same session — just add the new authorizations
          authState.addAuthorization(authorizedTokenIds, authorizedAddresses)
        } else {
          // New session created by server
          authState.setSession(newToken, authorizedTokenIds, authorizedAddresses, expiresAt)
        }
      }

      // Swap the pending post's tempId (`pending-<ts>-<rand>`) for the
      // real DB id the server just returned. Without this, the URL bar
      // and any share links show `/caws/pending-...` until Feed.tsx's
      // dedup pass catches up on the next refetch — which can be tens
      // of seconds. Server only returns cawId for CAW/RECAW actions.
      if (response.cawId != null && response.cawonce != null && response.senderId != null) {
        usePendingPostsStore.getState().updatePostId(
          response.cawonce,
          response.senderId,
          String(response.cawId),
        )
      }

      // Record pending spend so subsequent actions see reduced effective stake.
      // Use the effective tip we actually signed with (respects per-session ceiling), not the
      // current market tip — otherwise the pending counter would mis-estimate.
      if (response.txQueueId) {
        const actionCostWei: Record<string, bigint> = {
          caw: 5000n, like: 2000n, recaw: 4000n, follow: 30000n,
          unlike: 0n, unfollow: 0n, other: 0n, withdraw: 0n,
        }
        // For withdrawals and "other" actions (tips, image uploads), the real
        // cost is in the amounts array, not the fixed protocol fee. Withdrawals
        // carry the withdrawal amount in amounts[0]. Tips carry [tipAmount,
        // validatorTip] where both are already in whole CAW tokens. Image
        // uploads carry the CAW cost in amounts[0]. We sum all amounts as
        // the spend; for tip actions buildTypedData already includes the
        // validator tip in the amounts, so we DON'T add effectiveTip again
        // for 'other' actions — it would double-count.
        let extraAmountsWhole = 0n
        if ((params.actionType === 'withdraw' || params.actionType === 'other') &&
            params.amounts && params.amounts.length > 0) {
          for (const amt of params.amounts) {
            try { extraAmountsWhole += BigInt(amt as any) } catch {}
          }
        }
        // For 'other' actions, amounts already include the validator tip
        // (buildTypedData doesn't add tip for 'other'). So skip adding
        // effectiveTip again to avoid double-counting.
        const tipForCalc = params.actionType === 'other' ? 0n : effectiveTip
        const costWholeTokens = (actionCostWei[params.actionType] || 0n) + extraAmountsWhole + tipForCalc
        const costWei = costWholeTokens * 10n**18n
        if (costWei > 0n) {
          usePendingSpendStore.getState().addPendingSpend(response.txQueueId, costWei, params.senderId)
          // Surface the outgoing spend in the BalanceChange pill immediately
          // — pending=true so the toast renders it in dim/grey. The
          // useTxQueueMonitor 'done' branch later calls confirmWindow with
          // the same source key, which upgrades this window to confirmed
          // (red) without producing a duplicate. If the action fails /
          // cancels, the pending window just expires at the same duration.
          {
            // 5s total visible window — same as the confirmed branch — so
            // the pill doesn't linger. If the validator takes longer than
            // 5s to confirm, the user just sees the dim pending pill the
            // whole time and it fades; the confirm is silent (no second
            // pop). Matches the spec: "go away after 5 seconds".
            const { useBalanceChangeStore } = await import('~/store/balanceChangeStore')
            useBalanceChangeStore.getState().addWindow(
              -costWei,
              5_000,
              `txq:${response.txQueueId}`,
              { pending: true, tokenId: params.senderId },
            )
          }
        }
      }

      // Broadcast to other instances as redundancy (fire-and-forget after 20s delay).
      // The 20s window is the user's grace period to hit cancel on like /
      // recaw / follow / unfollow before the signed payload leaks to peers.
      // Without it, even a successful local cancel still results in peer
      // mirrors picking up the action — their validators eventually try to
      // submit it, the on-chain action lands, and the user-visible "cancel"
      // didn't actually cancel anything (incident 2026-05-14, cancel UX).
      //
      // Right before broadcasting we re-check the local row's status; if it
      // was cancelled (or otherwise no longer pending), we skip the broadcast
      // entirely so peers don't create orphan pending rows for a dead action.
      // Other instances will either accept it or reject as duplicate — both
      // are fine. Filtered through useHostVerificationStore so a peer that's
      // repeatedly failing or has been blacklisted gets skipped — keeps a
      // misbehaving node from absorbing every browser's broadcast traffic.
      const actionPayload = JSON.stringify({ data: message, domain, types, signature })
      const broadcastTxQueueId = response.txQueueId
      setTimeout(async () => {
        try {
          // Cancel-aware: skip the broadcast if the local row was cancelled
          // (or finished, failed, picked up by validator, etc.) in the 20s
          // window. Status === 'pending' is the only case where redundant
          // peer submission is still useful.
          if (broadcastTxQueueId) {
            try {
              const statusRes = await apiFetch<{ statuses: Array<{ id: number; status: string }> }>(
                `/api/txqueue/status?ids=${broadcastTxQueueId}`,
              )
              const entry = statusRes?.statuses?.find(s => s.id === broadcastTxQueueId)
              if (entry && entry.status !== 'pending') {
                console.log(`[Actions] Skipping broadcast for TxQueue ${broadcastTxQueueId} — status=${entry.status}`)
                return
              }
            } catch {
              // Status check failed — proceed with the broadcast. Better to
              // double-fan-out than to silently drop a legitimate action.
            }
          }
          const { useHostVerificationStore } = await import('~/hooks/useHostVerification')
          const verify = useHostVerificationStore.getState()
          const allHosts = useInstanceStore.getState().getApiHosts()
          const activeHost = useInstanceStore.getState().activeApiHost || API_HOST || ''
          const otherHosts = allHosts
            .filter((h: string) => h !== activeHost && h !== '')
            .filter((h: string) => !verify.isBlacklisted(h))
            .sort((a: string, b: string) => verify.getHostScore(a) - verify.getHostScore(b))
          const clientVersion = (typeof __CLIENT_VERSION__ !== 'undefined' && __CLIENT_VERSION__) || 'unknown'
          for (const host of otherHosts) {
            const startTime = Date.now()
            fetch(`${host}/api/actions`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-caw-client-version': clientVersion,
              },
              body: actionPayload,
            })
              .then(res => {
                verify.recordResponseTime(host, Date.now() - startTime)
                if (!res.ok && res.status >= 500) verify.recordFailure(host)
              })
              .catch(() => verify.recordFailure(host))
          }
          if (otherHosts.length > 0) {
            console.log(`[Actions] Broadcast to ${otherHosts.length} redundant instance(s)`)
          }
        } catch {}
      }, 20000)

      return { ...response, cawonce: useCawonce } // Include cawonce for pending post tracking
    } catch (error: any) {
      console.error('Failed to submit action:', error)

      // Cawonce collision: TxQueue partial unique index fired because two
      // submissions raced to the same cawonce. The 409 carries
      // suggestedCawonce — the server's max(active TxQueue cawonces) + 1,
      // which the chain CAN'T see (those rows haven't been confirmed on
      // L2 yet). We push the local watermark to that floor so the next
      // getNextCawonce call returns suggestedCawonce, not the stale
      // chain.nextCawonce.
      if (error?.name === 'CawonceCollisionError') {
        // Always bump the local watermark from the server's hint, regardless
        // of whether the caller pre-allocated the cawonce. The watermark is
        // process-wide; skipping it for pre-allocated cawonces was the bug
        // that caused three retries to all collide on the same dead slot.
        if (activeTokenId) {
          if (typeof error.suggestedCawonce === 'number') {
            console.log(`[signAndSubmit] Server suggests next cawonce=${error.suggestedCawonce} — bumping local watermark`)
            setLocalCawonceFloor(activeTokenId, error.suggestedCawonce)
          } else if (params.cawonce == null) {
            // Older server without suggestedCawonce in the payload, and no
            // pre-allocated cawonce — fall back to invalidating the watermark.
            invalidateLocalCawonce(activeTokenId)
          }
        }
        const attempt = (params._cawonceRetryCount || 0) + 1
        const MAX_CAWONCE_RETRIES = 3
        if (attempt <= MAX_CAWONCE_RETRIES) {
          console.log(`[signAndSubmit] Cawonce collision (attempt ${attempt}/${MAX_CAWONCE_RETRIES}) — re-reading chain and re-signing`)
          // CRITICAL: strip the pre-allocated cawonce on retry so the next
          // call re-allocates from the bumped watermark. Without this,
          // pre-allocated cawonces (thread submissions, FeedItem optimistic
          // ops) are passed unchanged and collide again on every retry.
          // NOTE: signAndSubmit.many (batch path) also receives pre-allocated
          // cawonces but its batch-sig commits to firstCawonce+actionCount —
          // re-signing the full batch on collision is a non-trivial change.
          // MILESTONE: signAndSubmit.many batch-collision retry left as follow-up
          const { cawonce: _staleCawonce, ...paramsWithoutCawonce } = params
          return await requestAndSubmit({
            ...paramsWithoutCawonce,
            _cawonceRetryCount: attempt,
          } as ActionParams)
        }
        console.warn('[signAndSubmit] Cawonce collision persisted past max retries — surfacing')
      }

      // Note: we deliberately do NOT invalidate the local watermark on
      // non-collision errors. If the API call failed (network, 5xx) the
      // server may or may not have persisted the row — clearing the
      // watermark would let the next allocation re-pick the same cawonce,
      // which collides if the row DID land. Better to leak a single
      // cawonce slot (chain.nextCawonce will see the gap and recover) than
      // to amplify a transient error into a guaranteed conflict.

      const errMsg = (error?.message || error?.shortMessage || '').toLowerCase()

      // Wrong chain — switch and retry
      if (errMsg.includes('chainid should be same') || errMsg.includes('chain mismatch')) {
        try {
          await switchChainAsync({ chainId: baseSepolia.id })
          return await requestAndSubmit(params)
        } catch {
          throw new Error('Please switch to the correct network and try again.')
        }
      }

      // Not authenticated with this client — show auth modal
      if (errMsg.includes('not authenticated')) {
        clientAuthCache.delete(activeTokenId!)
        return new Promise((resolve, reject) => {
          useClientAuthStore.getState().show(
            activeTokenId!,
            async () => {
              try {
                clientAuthCache.set(activeTokenId!, true)
                const result = await requestAndSubmit(params)
                resolve(result)
              } catch (err) { reject(err) }
            },
            // Reject on cancel so the caller can unstick its pending state.
            () => reject(new Error('Client authentication cancelled'))
          )
        })
      }

      // Detect session key spend limit or expiry errors from the contract/validator
      if (canUseSession && (errMsg.includes('spend limit') || errMsg.includes('session') || errMsg.includes('expired'))) {
        const reason = errMsg.includes('spend') ? 'spend_limit' : 'expired'
        return new Promise((resolve, reject) => {
          useQuickSignRenewStore.getState().show(reason, async () => {
            try {
              const result = await requestAndSubmit(params)
              resolve(result)
            } catch (err) { reject(err) }
          })
        })
      }

      throw error
    }
  }, [activeTokenId, address, signTypedDataAsync, setCawonce])

  // as soon as we become connected with the correct wallet, replay the pending action
  useEffect(() => {
    if (!isConnected || !pendingParams || !cawonce || submittingRef.current) {
      return
    }

    // Don't auto-submit if connected wallet doesn't match the active token's owner
    if (activeToken?.address && address && activeToken.address.toLowerCase() !== address.toLowerCase()) {
      return
    }

    // Set flag immediately to prevent re-execution
    submittingRef.current = true
    const params = pendingParams
    setPendingParams(null)

    // pendingParams is only set when the wallet was disconnected, so the user
    // never saw the Quick Sign prompt. Let the normal prompt flow run — if they
    // previously chose "don't show again", suppressPrompt handles it.
    ;(async () => {
      try {
        await requestAndSubmit(params)
      } finally {
        submittingRef.current = false
      }
    })()
  }, [isConnected, pendingParams, cawonce, requestAndSubmit, address, activeToken?.address])

  /**
   * Fast-path batch submission for threads/bulk actions.
   *
   * Runs pre-checks (auth, stake, deposit) ONCE for the whole batch, then
   * signs all actions in sequence with the session key (in-memory, fast),
   * then POSTs them to /api/actions with limited concurrency.
   *
   * Requires an active Quick Sign session (no wallet popups). Callers should
   * pre-allocate cawonces and pass them in params. Returns an array of
   * responses in the same order as the input params.
   *
   * @param allParams Array of action params. Each MUST have a cawonce pre-set.
   * @param onProgress Called with { signed, submitted, total } as work progresses.
   */
  const signAndSubmitMany = useCallback(async (
    allParams: ActionParams[],
    onProgress?: (p: { signed: number; submitted: number; total: number }) => void,
  ): Promise<any[]> => {
    if (allParams.length === 0) return []
    if (!activeTokenId) throw new Error('No active token selected')

    // Require Quick Sign — otherwise we can't batch (wallet popup per action)
    const sessionStore = useSessionKeyStore.getState()
    const freshToken = Object.values(useTokenDataStore.getState().tokensByAddress)
      .flat().find(t => t.tokenId === activeTokenId)
    const tokenOwner = freshToken?.owner || activeToken?.owner
    const activeSession = tokenOwner
      ? sessionStore.getActiveSessionForAddress(tokenOwner)
      : sessionStore.getActiveSession()
    if (!activeSession) {
      throw new Error('Batch submission requires an active Quick Sign session')
    }

    // Validate all actions are covered by the session scope
    for (const p of allParams) {
      const code = ActionTypeMap[p.actionType]
      if (code === 6) throw new Error('Batch cannot include withdrawals')
      if ((activeSession.scopeBitmap & (1 << code)) === 0) {
        throw new Error(`Session does not cover ${p.actionType} actions`)
      }
      if (p.cawonce == null) {
        throw new Error('All params must have pre-allocated cawonces')
      }
    }

    // Pre-check client auth (once, cached after first hit).
    // Prefer backend DB lookup over live RPC — much faster for cold starts.
    if (!clientAuthCache.get(activeTokenId)) {
      try {
        const res = await apiFetch<{ authenticated: boolean }>(`/api/users/client-auth/${activeTokenId}?clientId=${CLIENT_ID}`)
        if (res?.authenticated) clientAuthCache.set(activeTokenId, true)
      } catch { /* non-fatal, server will validate; contract will enforce */ }
    }

    // Determine effective tip once (respects session ceiling if set)
    const effectiveTip = activeSession.tipCeiling !== undefined
      ? getValidatorTip(BigInt(activeSession.tipCeiling || '0'))
      : getValidatorTip()

    // Build typed data for every action (no signing yet — needed to compute
    // the per-action packed slice each batch sig commits to).
    const sessionAccount = privateKeyToAccount(activeSession.privateKey)
    const typedItems: Array<{ params: ActionParams; data: any; domain: any; types: any }> = []
    for (let i = 0; i < allParams.length; i++) {
      const p = allParams[i]
      // Batch-sig path is by definition session-key signing — omit the tip
      // slot so the contract uses the implicit per-action rate from the
      // session record.
      const { domain, types, message } = buildTypedData(p, effectiveTip, { sessionKeySigning: true })
      typedItems.push({ params: p, data: message, domain, types })
    }

    // ONE ActionBatch signature covers all N actions. Mirrors the contract's
    // batch path: hash each per-action packed slice, then keccak the concat,
    // then sign ActionBatch(senderId, firstCawonce, actionCount, actionsHash).
    // The validator clusters txQueue rows by batchId and emits one sig group
    // for the whole thread, replacing N ecrecovers with 1 on-chain.
    const sanitizedForPack = typedItems.map(item => ({
      actionType: Number(item.data.actionType),
      senderId: Number(item.data.senderId),
      receiverId: Number(item.data.receiverId || 0),
      receiverCawonce: Number(item.data.receiverCawonce || 0),
      clientId: Number(item.data.clientId),
      cawonce: Number(item.data.cawonce),
      recipients: (item.data.recipients || []).map(Number),
      amounts: (item.data.amounts || []).map((x: any) => BigInt(x)),
      text: item.data.text || '0x',
    }))
    const packedBytes = packActions(sanitizedForPack)
    const slices = getPackedActionSlices(packedBytes)
    // viem's keccak256(ByteArray) returns Hex; concat(Hex[]) → Hex; keccak256(Hex) → Hex.
    const perActionHashes = slices.map((s: Uint8Array) => keccak256(s))
    const actionsHash = keccak256(concat(perActionHashes))

    const batchDomain = typedItems[0].domain
    const batchTypeDef = {
      ActionBatch: [
        { name: 'senderId', type: 'uint32' },
        { name: 'firstCawonce', type: 'uint32' },
        { name: 'actionCount', type: 'uint32' },
        { name: 'actionsHash', type: 'bytes32' },
      ],
    }
    const batchMessage = {
      senderId: Number(typedItems[0].data.senderId),
      firstCawonce: Number(typedItems[0].data.cawonce),
      actionCount: typedItems.length,
      actionsHash,
    }
    const batchSig = await sessionAccount.signTypedData({
      domain: batchDomain as any,
      types: batchTypeDef,
      primaryType: 'ActionBatch',
      message: batchMessage,
    })
    onProgress?.({ signed: typedItems.length, submitted: 0, total: typedItems.length })

    // Phase 2: single batch POST. The server verifies the batch sig once,
    // creates N TxQueue rows sharing batchId + signedTx, and the validator
    // re-clusters them into one sig group when packing the on-chain submission.
    const batchPayload = typedItems.map(item => ({ data: item.data }))

    // Forward pending mint/deposit hint (same logic as single-action path) so
    // threads posted during LZ propagation get parked in waiting_for_deposit
    // instead of failing with "User has not authenticated with this client".
    let pendingDepositTxHash: string | undefined
    try {
      const hintRaw = localStorage.getItem(`caw:pendingDeposit:${activeTokenId}`)
      if (hintRaw) {
        const hint = JSON.parse(hintRaw)
        if (hint?.txHash && typeof hint.txHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(hint.txHash)) {
          const age = Date.now() - (hint.at ?? 0)
          if (age < 30 * 60 * 1000) {
            pendingDepositTxHash = hint.txHash
          } else {
            localStorage.removeItem(`caw:pendingDeposit:${activeTokenId}`)
          }
        }
      }
    } catch { /* ignore */ }

    // Same forward for the bundled mintAndDepositAndQuickSign session leg.
    let pendingQuickSignTxHash: string | undefined
    try {
      let ownerAddress: string | undefined
      const tdState = useTokenDataStore.getState()
      for (const tokens of Object.values(tdState.tokensByAddress)) {
        const found = tokens.find(t => t.tokenId === activeTokenId)
        if (found?.owner) { ownerAddress = found.owner.toLowerCase(); break }
      }
      if (ownerAddress) {
        const hintRaw = localStorage.getItem(`caw:pendingQuickSign:${ownerAddress}`)
        if (hintRaw) {
          const hint = JSON.parse(hintRaw)
          if (hint?.txHash && typeof hint.txHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(hint.txHash)) {
            const age = Date.now() - (hint.submittedAt ?? 0)
            if (age < 30 * 60 * 1000) {
              pendingQuickSignTxHash = hint.txHash
            } else {
              localStorage.removeItem(`caw:pendingQuickSign:${ownerAddress}`)
            }
          }
        }
      }
    } catch { /* ignore */ }

    let batchResponse: any
    try {
      // Wrap in retryOnIndexing for parity with the single-action path:
      // /api/actions/batch returns 202 when the sender row isn't indexed
      // yet (fresh-mint case). Without this wrap, IndexingError would
      // surface as a flat batch failure to the user.
      batchResponse = await retryOnIndexing(() => apiFetch('/api/actions/batch', {
        method: 'POST',
        body: JSON.stringify({
          actions: batchPayload,
          batchSig,
          domain: batchDomain,
          types: batchTypeDef,
          ...(pendingDepositTxHash ? { pendingDepositTxHash } : {}),
          ...(pendingQuickSignTxHash ? { pendingQuickSignTxHash } : {}),
        }),
      }))
    } catch (err: any) {
      console.error('[submitMany] Batch submit failed:', err.message)
      // Fill all with error so caller sees consistent shape
      const results = typedItems.map(() => ({ error: err.message || 'batch submission failed' }))
      return results
    }

    const results: any[] = new Array(allParams.length)
    const actionCostWei: Record<string, bigint> = {
      caw: 5000n, like: 2000n, recaw: 4000n, follow: 30000n,
      unlike: 0n, unfollow: 0n, other: 0n, withdraw: 0n,
    }

    for (let i = 0; i < allParams.length; i++) {
      const r = batchResponse?.results?.[i]
      results[i] = r ? { ...r, cawonce: typedItems[i]?.data?.cawonce } : { error: 'no response for action' }
      // Track pending spend for successful queues
      if (r?.txQueueId) {
        const costWholeTokens = (actionCostWei[typedItems[i].params.actionType] || 0n) + effectiveTip
        const costWei = costWholeTokens * 10n**18n
        if (costWei > 0n) {
          usePendingSpendStore.getState().addPendingSpend(r.txQueueId, costWei, typedItems[i].params.senderId)
        }
      }
      // Swap each pending post's tempId for its real DB id (same reason
      // as the single-action path — beats waiting for Feed.tsx dedup).
      if (r?.cawId != null && r?.cawonce != null && r?.senderId != null) {
        usePendingPostsStore.getState().updatePostId(
          r.cawonce,
          r.senderId,
          String(r.cawId),
        )
      }
      onProgress?.({ signed: allParams.length, submitted: i + 1, total: allParams.length })
    }

    return results
  }, [activeTokenId, activeToken?.owner])

  const signAndSubmit = async (params: ActionParams) => {
    // Session key active for this token's owner — skip wallet checks entirely
    if (hasActiveSession) {
      return await requestAndSubmit(params)
    }

    // 1) if wallet not yet connected, pop the connect modal
    if (!isConnected) {
      setPendingParams(params)
      openConnectModal?.()
      return null
    } else if (activeToken?.owner?.toLowerCase() !== address?.toLowerCase()) {
      console.error("That profile tokenId is not owned by your connected wallet")
      return null
    } else {
      return await requestAndSubmit(params)
    }
  }

  // Attach signAndSubmitMany as a property on the returned function for backward compat
  ;(signAndSubmit as any).many = signAndSubmitMany
  return signAndSubmit as typeof signAndSubmit & { many: typeof signAndSubmitMany }
}

