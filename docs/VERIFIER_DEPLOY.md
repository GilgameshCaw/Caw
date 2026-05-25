# Deploying verify.caw.social

The verifier is a static SPA. Build, copy `dist/` to the host, point nginx at it.

## DNS

`verify.caw.social` as an A record pointing at the host. **Use a host you
control directly** — not a mirror operator's. If the mirror operator can
swap the verifier's bytes, the user is back to trusting the mirror.

## TLS

Wildcard cert for `*.caw.social` already exists. Re-use it; no per-host
cert needed.

## Build & ship

```sh
# Local
cd client/src/services/Verifier
npm install
npm run build
# dist/ now contains the static site

# Copy to VPS (replace <host> with the verifier VPS)
rsync -avz --delete dist/ <user>@<host>:/var/www/verify.caw.social/
```

## nginx

```nginx
server {
    listen 443 ssl http2;
    server_name verify.caw.social;

    ssl_certificate     /etc/letsencrypt/live/caw.social-0001/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/caw.social-0001/privkey.pem;

    root /var/www/verify.caw.social;
    index index.html;

    # SPA fallback. Verifier is one HTML shell + assets; any deep path
    # should serve index.html and let the React router (none currently)
    # take over.
    location / {
        try_files $uri /index.html;
    }

    # The verifier is read-only and serves no credentials. Encourage
    # browsers to cache hashed assets aggressively but never the shell.
    location ~* /assets/.*\.(js|css|woff2?)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
    location = /index.html {
        add_header Cache-Control "no-store";
    }

    # Defensive headers. The verifier loads nothing from third parties
    # at runtime except (a) raw.githubusercontent.com for the reference
    # manifest, and (b) whatever mirror the user typed in.
    add_header X-Frame-Options DENY always;
    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy strict-origin-when-cross-origin always;
    add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src https://raw.githubusercontent.com https://*.caw.social https://*; img-src 'self' data:; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'" always;
}

server {
    listen 80;
    server_name verify.caw.social;
    return 301 https://$host$request_uri;
}
```

The `connect-src` allows fetching from any HTTPS host because the user
types arbitrary mirror URLs. We tighten it to `*.caw.social` only if we
decide verifying third-party forks is out of scope — for now, leaving
it open is a UX win.

## Required CORS on each mirror

The verifier hashes the mirror's files via in-browser `fetch`. For this
to work cross-origin, each mirror must serve:

```
Access-Control-Allow-Origin: https://verify.caw.social
```

(or `*`, which is fine for static-asset paths) on:

- `/build-manifest.json`
- `/assets/*`
- Any other path listed in the reference manifest

Without that header, the verifier fetches will fail with opaque CORS errors
and every file will show as `errored`. Add to the existing mirror nginx
config:

```nginx
location /build-manifest.json {
    add_header Access-Control-Allow-Origin "https://verify.caw.social" always;
    try_files $uri =404;
}
location /assets/ {
    add_header Access-Control-Allow-Origin "https://verify.caw.social" always;
    try_files $uri =404;
}
```

## Per-build publishing

Every FE deploy needs to publish a fresh reference manifest to
`docs/manifests/`:

```sh
cd client/src/services/FrontEnd
npm run build
cd -
npx tsx client/scripts/publish-build-manifest.ts
git add docs/manifests/
git commit -m "manifest: publish <sha>"
git push
```

The verifier reads `latest.json` from `raw.githubusercontent.com`, so the
new reference is live as soon as the commit reaches master.
