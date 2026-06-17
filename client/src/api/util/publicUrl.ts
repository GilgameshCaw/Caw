// Single source of truth for the install's public URL. Used for absolute
// URLs we hand to crawlers (og:url, og:image, twitter:image), media URL
// derivation, short-URL generation, and the CawAI citation links.
//
// HOST_DOMAIN is the canonical public origin for the whole install. Features
// that need a different host (an external URL shortener, a separate bot site)
// override it with their own var — but they all fall back here. SHORTURL_DOMAIN
// is kept as a back-compat fallback so existing installs that only set it keep
// working without change.
export function publicUrl(): string {
  return (
    process.env.HOST_DOMAIN ||
    process.env.SHORTURL_DOMAIN ||
    'http://local.caw.com:5274'
  )
}
