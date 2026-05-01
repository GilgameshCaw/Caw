// Server-side SSRF guard. Used anywhere the API does an outbound fetch
// against a URL whose authority is influenced by user input (avatar URL,
// short URL preview, etc).
//
// Why we need a guard at all: a malicious user could submit
//   http://169.254.169.254/latest/meta-data/  (AWS instance metadata)
//   http://localhost:9200/_cat/indices         (local Elasticsearch)
//   http://10.0.0.5/admin                       (private network reach)
// and our box would happily fetch + return the response. Even when the
// caller only base64s the bytes (og.ts does this), an attacker can probe
// for service presence via response timing. The conservative default is
// "don't reach into private network ranges on a stranger's behalf."
//
// Three checks:
//   1. Protocol must be http: or https:.
//   2. If hostname is a literal IP, it must be public.
//   3. Otherwise resolve via DNS — ALL returned addresses must be public
//      (a single private match means reject; defends against DNS records
//      that splice 127.0.0.1 into a public-looking host, the
//      "DNS-rebinding-via-A-record" pattern).
//
// Note this does NOT defend against full DNS rebinding (where the
// resolver returns "public" on the check call and "private" on the
// fetch call moments later). That requires either pinning the resolved
// IP across the check + fetch pair, or running both behind a proxy that
// validates the resolved address. We accept the residual risk because
// most production deploys behind a reverse proxy don't expose the
// fetch-time DNS resolution to attacker control.

import dns from 'dns/promises'
import net from 'net'

export async function isSafePublicUrl(rawUrl: string): Promise<boolean> {
  let parsed: URL
  try { parsed = new URL(rawUrl) } catch { return false }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false

  const host = parsed.hostname
  if (!host) return false

  // Hostname can be a literal IPv4/IPv6 — check directly. Otherwise resolve.
  const literalFamily = net.isIP(host) // 0 = not an IP, 4 or 6 otherwise
  const ips: string[] = literalFamily ? [host] : []
  if (!literalFamily) {
    try {
      const records = await dns.lookup(host, { all: true })
      for (const r of records) ips.push(r.address)
    } catch {
      return false // DNS failure → can't verify, refuse
    }
  }
  if (ips.length === 0) return false
  for (const ip of ips) if (!isPublicIp(ip)) return false
  return true
}

// True only for IPs we're willing to reach from the server. Excludes:
// loopback (127/8, ::1), link-local (169.254/16, fe80::/10 — covers AWS
// metadata at 169.254.169.254), RFC1918 (10/8, 172.16/12, 192.168/16),
// CGNAT (100.64/10), unspecified (0.0.0.0, ::), private IPv6 (fc00::/7),
// IPv4-mapped IPv6 (::ffff:0:0/96 — block to prevent IPv6-tunnel bypass).
export function isPublicIp(ip: string): boolean {
  // IPv4
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number)
    if (a === 0) return false                                  // 0.0.0.0/8
    if (a === 10) return false                                 // 10/8
    if (a === 127) return false                                // loopback
    if (a === 169 && b === 254) return false                   // link-local + AWS metadata
    if (a === 172 && b >= 16 && b <= 31) return false          // 172.16/12
    if (a === 192 && b === 168) return false                   // 192.168/16
    if (a === 100 && b >= 64 && b <= 127) return false         // CGNAT 100.64/10
    if (a >= 224) return false                                 // multicast / reserved
    return true
  }
  // IPv6
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase()
    if (lower === '::' || lower === '::1') return false         // unspec + loopback
    if (lower.startsWith('fe8') || lower.startsWith('fe9') ||
        lower.startsWith('fea') || lower.startsWith('feb')) return false // fe80::/10 link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return false   // fc00::/7 ULA
    // IPv4-mapped IPv6 (::ffff:a.b.c.d) — re-check the embedded v4.
    const v4 = lower.match(/^::ffff:([0-9.]+)$/)?.[1]
    if (v4 && net.isIPv4(v4)) return isPublicIp(v4)
    // ::ffff:hex:hex form — extract last 32 bits as v4.
    const hexMapped = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
    if (hexMapped) {
      const hi = parseInt(hexMapped[1], 16)
      const lo = parseInt(hexMapped[2], 16)
      const v4back = `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`
      return isPublicIp(v4back)
    }
    return true
  }
  return false
}
