/**
 * URL-shape validators for media uploaded via the CAW upload pipeline.
 *
 * The pipeline stores files at deterministic paths:
 *   /uploads/images/<8hex>(.<ext>)?
 *   /uploads/videos/<8hex>(.<ext>)?
 *   /uploads/encrypted/<8hex>(.<ext>)?  (DM attachments)
 *
 * We validate by PATH SHAPE (not host equality) per the project-wide
 * convention: host equality breaks dev + multi-mirror deploys, and a
 * mirror running on a different domain can still safely render media
 * served from its own /uploads/ tree. Audit fix 2026-05-09 (Round 5
 * FE/DM HIGH-1).
 *
 * IMPORTANT: do NOT use these as gates for security-critical decisions
 * about content authenticity. They only prevent the FE from emitting
 * fetches/img-loads to attacker-chosen URLs from inside post bodies and
 * DMs (passive deanon + LAN-probe vectors). The server's upload path
 * is the actual integrity boundary.
 */

const HEX8_PATH_RE = /^\/uploads\/(images|videos|encrypted)\/[0-9a-f]{8}(\.[a-z0-9]{1,8})?$/i

/** Returns true iff `url` parses as http(s) AND its path matches the
 *  canonical /uploads/<kind>/<8hex>.<ext> shape. Relative URLs are
 *  resolved against window.location.origin. */
export function isCanonicalUploadUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url, typeof window !== 'undefined' ? window.location.origin : 'http://localhost')
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  return HEX8_PATH_RE.test(parsed.pathname)
}
