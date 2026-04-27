// Single source of truth for the install's public URL. Used for absolute
// URLs we hand to crawlers (og:url, og:image, twitter:image) and for
// short-URL generation. Operators set SHORTURL_DOMAIN in client/.env;
// the dev default matches what the SPA dev server serves.
export function publicUrl(): string {
  return process.env.SHORTURL_DOMAIN || 'http://local.caw.com:5274'
}
