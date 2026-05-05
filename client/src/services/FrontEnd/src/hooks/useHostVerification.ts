import { useEffect, useRef } from 'react'
import { verifyTypedData } from 'viem'
import { useInstanceStore } from '~/store/instanceStore'
import { apiFetch } from '~/api/client'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/**
 * Host verification store — tracks trust scores and blacklisted hosts.
 * Persisted in localStorage so bad hosts stay blacklisted across sessions.
 * All scoring is LOCAL to this browser — no cross-reporting to other APIs.
 */
interface HostVerificationState {
  /** Hosts that failed verification — maps host URL to failure count */
  failureCounts: Record<string, number>
  /** Hosts permanently blacklisted (too many failures) */
  blacklistedHosts: string[]
  /** Response time tracking — maps host to average ms */
  responseTimes: Record<string, number>

  recordFailure: (host: string) => void
  recordResponseTime: (host: string, ms: number) => void
  isBlacklisted: (host: string) => boolean
  getHostScore: (host: string) => number
  clearBlacklist: () => void
}

const FAILURE_THRESHOLD = 3 // blacklist after 3 verification failures

/**
 * Returns true if `host` is the origin we're being served from. Self-
 * blacklisting locks the user out of their own home instance — they
 * can't reach any other peer either if instance discovery hasn't
 * populated, so the FE just hangs. Treat self as always trusted; if
 * our own home server is genuinely fraudulent, the user has bigger
 * problems than spot-check verification.
 */
function isSelfHost(host: string): boolean {
  if (typeof window === 'undefined' || !host) return false
  try {
    const h = new URL(host).origin.toLowerCase()
    return h === window.location.origin.toLowerCase()
  } catch {
    return false
  }
}

export const useHostVerificationStore = create<HostVerificationState>()(
  persist(
    (set, get) => ({
      failureCounts: {},
      blacklistedHosts: [],
      responseTimes: {},

      recordFailure: (host) => {
        if (isSelfHost(host)) {
          console.warn(`[HostVerification] Skipping failure record for self-host ${host}`)
          return
        }
        set(state => {
          const count = (state.failureCounts[host] || 0) + 1
          const shouldBlacklist = count >= FAILURE_THRESHOLD && !state.blacklistedHosts.includes(host)
          console.warn(`[HostVerification] Failure #${count} for ${host}${shouldBlacklist ? ' — BLACKLISTED' : ''}`)
          return {
            failureCounts: { ...state.failureCounts, [host]: count },
            blacklistedHosts: shouldBlacklist
              ? [...state.blacklistedHosts, host]
              : state.blacklistedHosts,
          }
        })
      },

      recordResponseTime: (host, ms) => set(state => {
        const prev = state.responseTimes[host] || ms
        return {
          responseTimes: { ...state.responseTimes, [host]: Math.round(prev * 0.7 + ms * 0.3) },
        }
      }),

      isBlacklisted: (host) => {
        // Self-host is never blacklisted — even if a stale entry from
        // before the recordFailure guard landed in persisted state.
        if (isSelfHost(host)) return false
        return get().blacklistedHosts.includes(host)
      },

      getHostScore: (host) => {
        const state = get()
        const failures = state.failureCounts[host] || 0
        const responseTime = state.responseTimes[host] || 500
        return failures * 10000 + responseTime
      },

      clearBlacklist: () => set({ blacklistedHosts: [], failureCounts: {} }),
    }),
    // Bump to v2 to wipe persisted state from before the self-host
    // guards landed. Users whose own home host got blacklisted (or who
    // accumulated stale failureCounts that drove apiFetch to deprioritize
    // their home host) need a clean slate. Cheap: lose a few hours of
    // peer-trust history, gain a working feed.
    { name: 'caw-host-verification-v2' }
  )
)

/**
 * Verify a post by checking the EIP-712 signature against the action data.
 * Fetches the proof from /api/caws/verify/:userId/:cawonce, then recovers
 * the signer and checks it matches the expected author address.
 */
async function verifyPostSignature(
  userId: number,
  cawonce: number,
  expectedContent: string,
  authorAddress?: string
): Promise<{ valid: boolean; reason?: string }> {
  try {
    const proof = await apiFetch<{
      verified: boolean
      reason?: string
      signature?: string
      data?: any
      domain?: any
      types?: any
    }>(`/api/caws/verify/${userId}/${cawonce}`)

    if (!proof.verified || !proof.signature || !proof.data) {
      return { valid: false, reason: proof.reason || 'No proof available' }
    }

    // Verify the content matches what the API served. The signed `text` field
    // is smltxt-compressed bytes (0x-hex); decompress for the plaintext compare.
    const { decompressSignedText } = await import('~/api/actions')
    const signedText = decompressSignedText(proof.data.text || '')
    // The signed text includes URLs and metadata — the displayed content is extracted from it
    // So we check if the signed text contains the displayed content
    if (expectedContent && !signedText.includes(expectedContent.slice(0, 50))) {
      return { valid: false, reason: 'Content mismatch — signed text does not match displayed content' }
    }

    // Recover the signer from the EIP-712 signature
    // If we have the author's address, verify it matches
    if (authorAddress) {
      const isValid = await verifyTypedData({
        address: authorAddress as `0x${string}`,
        domain: proof.domain,
        types: { ActionData: proof.types?.ActionData },
        primaryType: 'ActionData',
        message: proof.data,
        signature: proof.signature as `0x${string}`,
      })

      if (!isValid) {
        return { valid: false, reason: 'Signature does not match author wallet' }
      }
    }

    return { valid: true }
  } catch (err: any) {
    // Network/RPC errors — can't verify, don't penalize
    console.warn('[HostVerification] Verification error (non-fatal):', err.message)
    return { valid: true } // Assume honest on error
  }
}

/**
 * Hook that spot-checks posts from the feed by verifying EIP-712 signatures.
 * Randomly verifies ~5% of posts. If verification fails, flags the current host.
 *
 * @param posts Array of posts with user info, cawonce, content, and status
 */
export function useHostVerification(
  posts: Array<{
    user: { tokenId: number; address?: string }
    cawonce: number
    content?: string
    status?: string
  }>
) {
  const verifiedKeys = useRef(new Set<string>())
  const activeHost = useInstanceStore(s => s.activeApiHost)

  useEffect(() => {
    if (!posts.length || !activeHost) return

    // Only verify SUCCESS posts (PENDING haven't hit chain yet)
    const verifiable = posts.filter(p =>
      p.status === 'SUCCESS' &&
      p.cawonce > 0 &&
      !verifiedKeys.current.has(`${p.user.tokenId}-${p.cawonce}`)
    )

    if (verifiable.length === 0) return

    // Sample ~5% (at least 1)
    const sampleSize = Math.max(1, Math.ceil(verifiable.length * 0.05))
    const sampled = verifiable
      .sort(() => Math.random() - 0.5)
      .slice(0, sampleSize)

    for (const post of sampled) {
      const key = `${post.user.tokenId}-${post.cawonce}`
      verifiedKeys.current.add(key)

      verifyPostSignature(
        post.user.tokenId,
        post.cawonce,
        post.content || '',
        post.user.address
      ).then(result => {
        if (!result.valid) {
          // Distinguish "host couldn't produce the proof" from "host
          // produced a bad proof". The former is expected in the
          // decentralized model — posts indexed from chain or relayed
          // from a peer mirror won't have a local TxQueue row, so
          // `verify/:userId/:cawonce` returns "No transaction record
          // found". Penalizing the host for that would blacklist any
          // honest mirror as soon as the user scrolls past a peer-
          // authored post. Only signature/content mismatches are
          // actual fraud signals.
          const isMissingProof = !result.reason
            || /no.+(transaction|proof)/i.test(result.reason)
          if (isMissingProof) {
            console.warn(
              `[HostVerification] No local proof for userId=${post.user.tokenId} cawonce=${post.cawonce} on ${activeHost} (reason="${result.reason}") — not penalizing; post may have been authored on a peer mirror.`
            )
            return
          }
          console.error(
            `[HostVerification] UNVERIFIED POST! userId=${post.user.tokenId} cawonce=${post.cawonce} reason="${result.reason}" host=${activeHost}`
          )
          useHostVerificationStore.getState().recordFailure(activeHost)

          // Auto-switch if blacklisted
          if (useHostVerificationStore.getState().isBlacklisted(activeHost)) {
            console.error(`[HostVerification] Host ${activeHost} BLACKLISTED — switching to another instance`)
            useInstanceStore.getState().setActiveApiHost('')
          }
        }
      })
    }
  }, [posts, activeHost])
}

