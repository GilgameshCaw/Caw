// src/services/DmRelayService/peerTargets.ts
//
// Picks the URLs a relay POST goes to. Kept apart from index.ts so it
// can be tested without the import chain behind the relay (dm-relay.ts
// pulls in prisma and opens a Redis connection at import time).

import type { PeerInstance } from '../InstanceRegistryService'

/**
 * Build a peer fetch URL using `new URL()` so path injection via a
 * maliciously-crafted apiUrl (e.g. "https://evil.com?x=") is blocked.
 *
 * Rules enforced (audit 2026-05-22 M-3):
 *   - apiUrl must not contain a query string or fragment — if it does,
 *     the path would be silently absorbed into the query param, sending
 *     the request to the wrong host.
 *   - The pathname is set (overwritten) explicitly to the given path so
 *     any trailing-path component in apiUrl also can't interfere.
 *
 * Throws on malformed apiUrl or disallowed query/fragment — callers
 * should catch and skip the peer rather than crashing the relay loop.
 */
export function buildPeerUrl(apiUrl: string, path: string): string {
  const target = new URL(apiUrl)
  if (target.search || target.hash) {
    throw new Error(`peer apiUrl must have no query string or fragment: ${apiUrl}`)
  }
  target.pathname = path
  return target.toString()
}

/**
 * What relayTargets compares: the URL with trailing dots taken off the
 * hostname. "a.example." is the same host as "a.example" (the absolute
 * form of the name), but new URL() keeps the dot, so without this an
 * entry on "https://a.example." would get a second POST to the same
 * server. Only the key changes; the URL that is fetched is left as is.
 */
function targetKey(url: string): string {
  const u = new URL(url)
  u.hostname = u.hostname.replace(/\.+$/, '')
  return u.toString()
}

export interface RelayTarget {
  instanceId: number
  apiUrl: string
  url: string
}

/**
 * Active peers other than this node, one per URL.
 *
 * The registry is permissionless and one operator can hold many
 * instances on the same apiUrl. buildPeerUrl overwrites the path, so
 * those entries are one endpoint, and the receiver keys on
 * sourceInstanceId only — every copy is the same request. Sending each
 * of them at once also defeats the receiver's relayId check: the copies
 * all pass it before any of them has stored the row, and each one is
 * charged to the recipient's inbound budget. Entries on our own URL are
 * dropped too; they would only POST back to this node.
 *
 * The first peer in the given order wins (getPeers sorts by instanceId).
 */
export function relayTargets(
  peers: PeerInstance[],
  ownInstanceId: number,
  path: string,
): RelayTarget[] {
  const seen = new Set<string>()
  const own = peers.find(p => p.instanceId === ownInstanceId)
  if (own) {
    try {
      seen.add(targetKey(buildPeerUrl(own.apiUrl, path)))
    } catch {
      // Our own apiUrl doesn't parse; nothing to exclude by URL.
    }
  }

  const targets: RelayTarget[] = []
  for (const peer of peers) {
    if (!peer.active || peer.instanceId === ownInstanceId) continue
    let url: string
    try {
      url = buildPeerUrl(peer.apiUrl, path)
    } catch (urlErr: any) {
      console.warn(`[DmRelay] Skipping peer ${peer.instanceId} — invalid apiUrl: ${urlErr.message}`)
      continue
    }
    const key = targetKey(url)
    if (seen.has(key)) continue
    seen.add(key)
    targets.push({ instanceId: peer.instanceId, apiUrl: peer.apiUrl, url })
  }
  return targets
}
