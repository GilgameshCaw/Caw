/**
 * URL-shape validators for media uploaded via the CAW upload pipeline.
 *
 * The pipeline emits two distinct filename shapes:
 *   /uploads/images/<8hex>.<ext>     — generateFilename() uses randomBytes(4) = 8 hex
 *   /uploads/videos/<8hex>.<ext>     — same generator
 *   /uploads/encrypted/<16hex>.enc   — DM attachments use randomBytes(8) = 16 hex
 *
 * We validate by PATH SHAPE (not host equality) per the project-wide
 * convention: host equality breaks dev + multi-mirror deploys, and a
 * mirror running on a different domain can still safely render media
 * served from its own /uploads/ tree. Audit fix 2026-05-09 (Round 5
 * FE/DM HIGH-1; Round 6 fix to match the actual filename widths after
 * the original regex used `{8}` for both kinds and would have rejected
 * every legitimate encrypted-DM URL).
 *
 * IMPORTANT: do NOT use these as gates for security-critical decisions
 * about content authenticity. They only prevent the FE from emitting
 * fetches/img-loads to attacker-chosen URLs from inside post bodies and
 * DMs (passive deanon + LAN-probe vectors). The server's upload path
 * is the actual integrity boundary.
 */

const IMAGE_VIDEO_PATH_RE = /^\/uploads\/(images|videos)\/[0-9a-f]{8}(\.[a-z0-9]{1,8})?$/i
const ENCRYPTED_PATH_RE = /^\/uploads\/encrypted\/[0-9a-f]{16}(\.[a-z0-9]{1,8})?$/i

/** Returns true iff `url` parses as http(s) AND its path matches the
 *  canonical /uploads/{images,videos}/<8hex>.<ext> shape. Encrypted
 *  attachments have a different filename width — use
 *  `isCanonicalEncryptedUploadUrl` for those. Relative URLs are
 *  resolved against window.location.origin. */
export function isCanonicalUploadUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url, typeof window !== 'undefined' ? window.location.origin : 'http://localhost')
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  return IMAGE_VIDEO_PATH_RE.test(parsed.pathname)
}

/** Returns true iff `url` matches the canonical
 *  /uploads/encrypted/<16hex>.<ext> DM-attachment path shape. */
export function isCanonicalEncryptedUploadUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url, typeof window !== 'undefined' ? window.location.origin : 'http://localhost')
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  return ENCRYPTED_PATH_RE.test(parsed.pathname)
}
