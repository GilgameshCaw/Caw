import inquirer from 'inquirer'
import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'
import ora from 'ora'
import { section, dim, brand, success, warn, err, tipBlock } from '../utils/ui.js'

/**
 * Configure nginx for the user's domain.
 *
 * Returns the SSL choice + paths so generate.js can stash them in the install
 * record. We ask three questions:
 *
 *   1. own-cert      — operator already has a cert; we just point nginx at it
 *   2. letsencrypt   — invoke certbot with --nginx (works only after DNS is live)
 *   3. skip          — HTTP only, dev/staging convenience
 *
 * The function only runs in production deployments with a domain. Dev mode
 * (or no domain) skips it entirely.
 */
export async function configureNginx(config, installDir) {
  if (config.deployment !== 'production') return null
  if (!config.domain) return null

  // We can only write to /etc/nginx as root. Surface the situation early
  // rather than failing mid-write.
  const isRoot = process.getuid && process.getuid() === 0
  if (!isRoot) {
    section('Nginx (skipped)')
    console.log(warn('  CLI is not running as root — skipping nginx setup.'))
    console.log(dim('  Re-run the install with sudo, or write the server block by hand.'))
    return null
  }

  section('Nginx + TLS')

  tipBlock([
    `We'll write a server block for ${brand(config.domain)} that:`,
    '  • serves the built frontend from client/src/services/FrontEnd/dist',
    '  • proxies /api/ and /socket.io/ to the API on localhost',
    '  • terminates HTTPS via your chosen TLS source',
  ])

  // Detect a wildcard cert one level up from the install domain
  // (e.g. /etc/ssl/caw.social/ for testnet.caw.social). When found, present
  // it as the most prominent option — operators with paid wildcards almost
  // always want to reuse them across subdomains.
  const wildcard = detectParentWildcard(config.domain)

  // Pre-supplied paths via env (install.sh sets these after asking the
  // operator to scp the files). Skip the prompt entirely in that case.
  const envCert = process.env.CAW_CERT_PATH
  const envKey = process.env.CAW_KEY_PATH
  const haveEnvPaths = envCert && envKey && fs.existsSync(envCert) && fs.existsSync(envKey)

  const choices = []
  if (wildcard) {
    choices.push({
      value: 'wildcard',
      name: `${brand(`Use the wildcard cert at /etc/ssl/${wildcard.parent}/`)} ${dim('(recommended)')}`,
    })
  }
  choices.push({
    value: 'letsencrypt',
    name: `${brand("Let's Encrypt (free)")} ${dim('— good for one domain, auto-renews every 90 days')}`,
  })
  choices.push({
    value: 'own-cert',
    name: `${brand('I have my own cert')} ${dim('— best for wildcards or multi-domain certs')}`,
  })

  let sslMode, certPath, keyPath

  // install.sh can pre-resolve the TLS choice. Two fast paths:
  //   • CAW_CERT_PATH + CAW_KEY_PATH set → own-cert with those files
  //   • CAW_TLS_MODE=letsencrypt → skip the prompt, run certbot
  if (haveEnvPaths) {
    sslMode = 'own-cert'
    certPath = envCert
    keyPath = envKey
    console.log(dim(`  Using cert + key from CAW_CERT_PATH / CAW_KEY_PATH (set by install.sh).`))
  } else if (process.env.CAW_TLS_MODE === 'letsencrypt') {
    sslMode = 'letsencrypt'
    console.log(dim(`  Using Let's Encrypt (CAW_TLS_MODE set by install.sh).`))
  } else {
    const answer = await inquirer.prompt([
      {
        type: 'list',
        name: 'sslMode',
        message: 'How are you handling SSL?',
        choices,
        default: choices[0].value,
      },
    ])
    sslMode = answer.sslMode
  }

  if (sslMode === 'wildcard') {
    certPath = wildcard.cert
    keyPath = wildcard.key
    console.log(dim(`  Using ${certPath} + ${keyPath}`))
  } else if (sslMode === 'own-cert' && !certPath) {
    // Show the scp instructions before asking for paths so the user has
    // something concrete to copy/paste while the script waits.
    tipBlock([
      'Drop your cert + key on this server before proceeding. From your',
      'local machine, something like:',
      '',
      `  ${brand(`scp fullchain.pem your-key.key root@<host>:/etc/ssl/${config.domain}/`)}`,
      '',
      'Make sure the files exist before you press Enter.',
    ])
    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'certPath',
        message: `Path to fullchain (cert + intermediates) PEM:`,
        default: `/etc/ssl/${config.domain}/fullchain.pem`,
        validate: (input) => fs.existsSync(input) ? true : `File not found: ${input}`,
      },
      {
        type: 'input',
        name: 'keyPath',
        message: `Path to private key PEM:`,
        default: `/etc/ssl/${config.domain}/${config.domain}.key`,
        validate: (input) => fs.existsSync(input) ? true : `File not found: ${input}`,
      },
    ])
    certPath = answers.certPath
    keyPath = answers.keyPath
  }

  const apiPort = config.apiPort || 4000
  const frontendDist = path.join(installDir, 'client/src/services/FrontEnd/dist')
  const uploadsDir = path.join(installDir, 'client/public/uploads')
  const sitesAvailable = `/etc/nginx/sites-available/${config.domain}`
  const sitesEnabled = `/etc/nginx/sites-enabled/${config.domain}`

  // Letsencrypt requires a running HTTP-only block first so certbot can solve
  // the HTTP-01 challenge. Once it succeeds, certbot rewrites our config to
  // add the TLS server and 80→443 redirect.
  const tls = sslMode === 'letsencrypt' ? null : { certPath, keyPath, mode: sslMode }
  const nginxSupportsHttp2Directive = detectNginxHttp2DirectiveSupport()
  const conf = renderNginxConf({
    domain: config.domain,
    apiPort,
    frontendDist,
    uploadsDir,
    tls,
    nginxSupportsHttp2Directive,
  })

  const spinner = ora('Writing nginx server block...').start()
  try {
    fs.writeFileSync(sitesAvailable, conf)
    if (!fs.existsSync(sitesEnabled)) {
      fs.symlinkSync(sitesAvailable, sitesEnabled)
    }
    spinner.succeed(`Wrote ${sitesAvailable}`)
  } catch (e) {
    spinner.fail('Failed to write nginx config')
    throw e
  }

  // Letsencrypt path: certbot rewrites the server block we just wrote and
  // installs the cert. It needs a *running* nginx with a working HTTP block,
  // so we test+reload first, then run certbot, then it reloads again itself.
  if (sslMode === 'letsencrypt') {
    const spinner2 = ora('Reloading nginx (HTTP only) to give certbot a target...').start()
    try {
      execSync('nginx -t', { stdio: 'pipe' })
      execSync('systemctl reload nginx', { stdio: 'pipe' })
      spinner2.succeed('nginx reloaded')
    } catch (e) {
      spinner2.fail('nginx config test failed — fix the file and re-run')
      throw e
    }

    const spinner3 = ora('Requesting Let\'s Encrypt cert via certbot...').start()
    try {
      execSync(
        `certbot --nginx -d ${config.domain} --non-interactive --agree-tos --redirect -m admin@${config.domain}`,
        { stdio: 'pipe' }
      )
      spinner3.succeed('Certbot installed cert and updated nginx')
    } catch (e) {
      spinner3.fail('certbot failed — see /var/log/letsencrypt/letsencrypt.log')
      console.log(err(`  ${e.message}`))
      throw e
    }
  } else {
    // Own-cert / wildcard paths — direct write + reload, no certbot.
    const spinner2 = ora('Testing + reloading nginx...').start()
    try {
      execSync('nginx -t', { stdio: 'pipe' })
      execSync('systemctl reload nginx', { stdio: 'pipe' })
      spinner2.succeed('nginx reloaded')
    } catch (e) {
      spinner2.fail('nginx config test failed')
      console.log(err(`  Run 'nginx -t' to see the error, fix ${sitesAvailable}, then 'systemctl reload nginx'`))
      throw e
    }
  }

  console.log()
  console.log(success(`  ${config.domain} is now served by nginx.`))
  console.log(dim(`  https://${config.domain}/  →  ${frontendDist}`))

  return { sslMode, certPath, keyPath }
}

/**
 * Apply small, idempotent patches to an already-deployed main-app nginx
 * config. This is what `caw update` calls — it does NOT regenerate the
 * full file (certbot rewrites the TLS server block, custom edits would
 * be lost) and does NOT touch certs / TLS settings. Each entry in
 * PATCHES is a regex + replacement that's only applied if the deployed
 * file is missing the new state.
 *
 * Add a new entry here whenever the template in renderNginxConf changes
 * in a way that an operator's deployed file should pick up via
 * `caw update`, rather than waiting for a fresh `caw install`.
 *
 * Returns { status, ... } so callers can decide whether to mention it.
 *   status='unchanged'   — nothing needed patching
 *   status='patched'     — wrote + reloaded
 *   status='no-config'   — couldn't find the deployed file
 *   status='not-managed' — file exists but no "Auto-generated by caw cli" marker
 *   status='skipped'     — non-root or non-production
 *   status='nginx-test-failed' — wrote but nginx -t rejected; reverted
 */
// Each patch is keyed by the bot name and uses the same `w3c_validator`
// splice anchor — every patch inserts its bot right after w3c_validator,
// which keeps the anchor stable across patches (a prior patch's insertion
// goes after the anchor, so the anchor itself isn't shifted). Each patch
// runs only if its bot isn't already present in the alternation, so the
// patcher is fully idempotent.
//
// To add a new bot to the list later: append a new entry below with the
// bot's UA token. The next `caw update` on an already-installed box picks
// it up; fresh installs get the full list from renderNginxConf above.
function makeCrawlerPatch(bot) {
  return {
    name: `add ${bot} to crawler UA matcher`,
    pattern: /(http_user_agent\s+~\*\s+"\([^)]*twitterbot[^)]*)(w3c_validator)([^)]*\)")/i,
    apply: (s) => s.replace(
      /(http_user_agent\s+~\*\s+"\([^)]*twitterbot[^)]*)(w3c_validator)([^)]*\)")/i,
      (_, before, end, after) => before + end + '|' + bot + after,
    ),
    // Bot already present anywhere in the alternation? Skip. Anchored by
    // the alternation delimiters `(` or `|` on the left and `|` or `)` on
    // the right — `\b` alone is wrong for tokens containing hyphens (e.g.
    // `meta-externalagent` would false-positive on bare `meta`). Regex
    // metachars in bot names are escaped via the standard $&-callback dance.
    isApplied: (s) => new RegExp(`[(|]${bot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[|)]`, 'i').test(s),
  }
}

const NGINX_PATCHES = [
  // Order is preserved so the resulting config lists bots in a predictable
  // sequence; functionally the alternation is order-agnostic.
  ...[
    'cawbot',
    'meta-externalagent',
    'slack-imgproxy',
    'mastodon',
    'bluesky',
    'cardyb',
    'discoursebot',
    'yandexbot',
    'tumblr',
    'wechat',
    'line',
    'twitchbot',
    'vkshare',
    'notion',
    'pocket',
  ].map(makeCrawlerPatch),
  // Fix the prerender rewrite: `$request_uri` embeds the original query
  // string into the rewrite target, which nginx then percent-encodes
  // the embedded `?` into the path segment — Express then sees
  // req.path / req.params[*] contaminated with `%3Fa=d` and the
  // canonical-redirect short-circuit fails, producing a 301-to-self
  // infinite loop for any crawler URL that carries a query string.
  // The naive `$uri$is_args$args` rewrite is no better (nginx STILL
  // percent-encodes the `?` from $is_args into the path). The right
  // idiom is `$uri` alone — original args carry through implicitly.
  {
    name: 'fix prerender rewrite query-string encoding',
    // Match both the original `$request_uri` form AND the in-between
    // `$uri$is_args$args` form (which we briefly tried) so a re-run
    // of the patcher converges to the correct rewrite either way.
    pattern: /rewrite \^ \/__prerender\$(?:request_uri|uri\$is_args\$args) last;/,
    apply: (s) => s.replace(
      /rewrite \^ \/__prerender\$(?:request_uri|uri\$is_args\$args) last;/,
      'rewrite ^ /__prerender$uri last;',
    ),
    // Word boundary on `$uri` — careful not to false-positive on
    // `$uri$is_args$args` which contains `$uri` as a prefix.
    isApplied: (s) => /rewrite \^ \/__prerender\$uri last;/.test(s),
  },
]

export function patchMainNginxConfig(installDir) {
  if (process.env.NODE_ENV === 'development') {
    return { status: 'skipped', reason: 'dev mode' }
  }
  const isRoot = process.getuid && process.getuid() === 0
  if (!isRoot) {
    return { status: 'skipped', reason: 'not root' }
  }

  // Derive the domain from client/.env. The canonical key is
  // SHORTURL_DOMAIN (matches what the backend's publicUrl() reads in
  // client/src/api/util/publicUrl.ts). PUBLIC_URL is honored as a
  // legacy fallback for installs that set it under the old name.
  const envPath = path.join(installDir, 'client', '.env')
  if (!fs.existsSync(envPath)) return { status: 'no-config', reason: 'client/.env missing' }
  const envText = fs.readFileSync(envPath, 'utf8')
  const m = /^SHORTURL_DOMAIN=(.+)$/m.exec(envText) || /^PUBLIC_URL=(.+)$/m.exec(envText)
  if (!m) return { status: 'no-config', reason: 'SHORTURL_DOMAIN not set in client/.env' }
  let domain
  try { domain = new URL(m[1].replace(/^["']|["']$/g, '').trim()).hostname }
  catch { return { status: 'no-config', reason: `SHORTURL_DOMAIN is not a valid URL: ${m[1]}` } }
  if (!domain) return { status: 'no-config', reason: 'Could not derive hostname from SHORTURL_DOMAIN' }

  const sitesAvailable = `/etc/nginx/sites-available/${domain}`
  if (!fs.existsSync(sitesAvailable)) {
    return { status: 'no-config', reason: `${sitesAvailable} not found` }
  }

  const original = fs.readFileSync(sitesAvailable, 'utf8')

  // Marker check — only auto-patch files we wrote. Operators with hand-
  // managed configs get a hint, not a surprise edit. (Certbot rewrites
  // our file but preserves our header comment, so the marker survives.)
  if (!original.includes('Auto-generated by caw cli')) {
    return { status: 'not-managed', reason: `${sitesAvailable} has no caw marker` }
  }

  // Apply each patch only if its target state isn't already present.
  let patched = original
  const applied = []
  for (const p of NGINX_PATCHES) {
    if (p.isApplied(patched)) continue
    if (!p.pattern.test(patched)) {
      // Pattern doesn't match — likely an operator-customized config or
      // a future template change we don't know how to update. Log and
      // skip rather than risk a half-edit.
      console.log(warn(`  Nginx patch "${p.name}" couldn't locate its anchor — skipping. Edit ${sitesAvailable} by hand or re-run 'caw install'.`))
      continue
    }
    patched = p.apply(patched)
    applied.push(p.name)
  }

  if (patched === original) {
    return { status: 'unchanged', domain, sitesAvailable }
  }

  // Write + test + reload. If nginx -t fails, revert and surface the
  // error — an unreloadable nginx config is worse than a stale UA matcher.
  section('Nginx (patches)')
  for (const name of applied) console.log(dim(`  • ${name}`))

  const spinner = ora('Writing nginx config patch...').start()
  try {
    fs.writeFileSync(sitesAvailable, patched)
    spinner.succeed(`Wrote ${sitesAvailable}`)
  } catch (e) {
    spinner.fail('Failed to write nginx config')
    throw e
  }

  const reload = ora('Testing + reloading nginx...').start()
  try {
    execSync('nginx -t', { stdio: 'pipe' })
    execSync('systemctl reload nginx', { stdio: 'pipe' })
    reload.succeed('nginx reloaded')
  } catch (e) {
    reload.fail('nginx -t failed — reverting the patch')
    try { fs.writeFileSync(sitesAvailable, original) } catch { /* best effort */ }
    console.log(err(`  ${e.message}`))
    return { status: 'nginx-test-failed', domain, sitesAvailable }
  }

  return { status: 'patched', domain, sitesAvailable, applied }
}

/**
 * Look for a wildcard cert one level up from the install domain.
 * For testnet.caw.social, checks /etc/ssl/caw.social/{fullchain,*.key}.
 *
 * Returns null if not found or if the install domain has no parent (e.g. an
 * apex like example.com — there's no parent to look at).
 */
function detectParentWildcard(domain) {
  const parts = domain.split('.')
  if (parts.length < 3) return null // apex; no parent to check
  const parent = parts.slice(1).join('.')
  const dir = `/etc/ssl/${parent}`
  if (!fs.existsSync(dir)) return null
  // Common cert layouts: fullchain.pem + <parent>.key, fullchain.pem + privkey.pem.
  const cert = ['fullchain.pem', 'cert.pem'].map(n => path.join(dir, n)).find(p => fs.existsSync(p))
  const key = [`${parent}.key`, 'privkey.pem', 'private.key'].map(n => path.join(dir, n)).find(p => fs.existsSync(p))
  if (cert && key) return { parent, cert, key }
  return null
}

/**
 * Render the nginx server block. Kept pure (no fs/exec) so we can test it
 * without touching the system.
 */
// Detect whether the local nginx supports the standalone `http2 on;` directive.
// nginx 1.25.1+ deprecates `listen ssl http2;` in favor of `listen ssl;` +
// `http2 on;`. Older nginx (1.18 on Ubuntu 22.04, 1.24 on Debian 12) reject
// the new directive with "unknown directive http2". Pick the syntax that
// matches what the local binary actually parses.
function detectNginxHttp2DirectiveSupport() {
  try {
    const out = execSync('nginx -v 2>&1', { encoding: 'utf8' })
    // Output looks like: "nginx version: nginx/1.24.0 (Ubuntu)"
    const m = out.match(/nginx\/(\d+)\.(\d+)\.(\d+)/)
    if (!m) return false
    const [, major, minor] = m.map(Number)
    // 1.25.1 introduced `http2 on;`. Be conservative — require >= 1.25.
    return major > 1 || (major === 1 && minor >= 25)
  } catch {
    // No nginx installed yet or not on PATH — fall back to the old syntax,
    // which works on every nginx version still receiving security updates.
    return false
  }
}

function renderNginxConf({ domain, apiPort, frontendDist, uploadsDir, tls, nginxSupportsHttp2Directive }) {
  // The built frontend is a SPA — every unknown path falls through to
  // index.html so React Router handles the route. /api and /socket.io go to
  // the Node server. Static assets in /assets/ get long cache headers.
  const sharedLocations = `
    # Block any path that contains a dotfile segment (.git, .env, .htaccess,
    # .ssh, etc). Without this, requests for things like /.git/config fall
    # through to the SPA's try_files and return index.html with a 200 — not
    # a real leak (root is dist/, no .git there) but it looks like one to
    # security scanners and to humans who curl -I. Allow .well-known/ for
    # certbot's ACME challenge. Regex location wins over prefix locations
    # at the same priority, so this matches before /api/ etc.
    location ~ /\\.(?!well-known/) {
        deny all;
        return 404;
    }

    # API and websocket proxy to the local Node process
    location /api/ {
        proxy_pass http://127.0.0.1:${apiPort};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 300s;
    }

    location /socket.io/ {
        proxy_pass http://127.0.0.1:${apiPort};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_read_timeout 86400s;
    }

    # Short-URL redirector: /s/<code> resolves to the original long URL via
    # the API's ShortUrl table. Used in post bodies for image/video/external
    # links to keep on-chain text under the gas-priced character cap.
    # Also used by /s/<code>.jpg (image preview) and /s/<code>.mp4 (video).
    location /s/ {
        proxy_pass http://127.0.0.1:${apiPort};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    # User-uploaded media (avatars, post images, encrypted DM blobs).
    # Served directly by nginx — no Node round-trip — since filenames are
    # content-hashes (immutable). Previously this was proxy_pass'd to the
    # API's express.static handler; nginx is dramatically faster for
    # static files and offloads bandwidth from Node.
    #
    # The trailing slash on the alias path is required: nginx strips the
    # location prefix before joining, so a request for /uploads/x.png
    # becomes <uploadsDir>/x.png.
    location /uploads/ {
        alias ${uploadsDir}/;
        # Filenames are random-hex and never collide on rewrite, so files
        # at a given URL never change content. Cache aggressively.
        expires 1y;
        add_header Cache-Control "public, max-age=31536000, immutable";
        # If a file is missing (deleted post asset, future GC sweep), 404
        # immediately rather than falling through to the SPA index.
        try_files \$uri =404;
        # Serve common image MIME types correctly even if the file
        # extension casing is unusual. nginx's default mime.types is
        # comprehensive; this is a no-op fallback.
        access_log off;
    }

    # Long cache for hashed asset bundles
    location /assets/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # SPA fallback. Real users get the static dist/index.html. Crawlers
    # (Twitter, Slack, Discord, iMessage, Facebook, etc.) are routed
    # through the API's catch-all prerender, which reads the URL, looks
    # up per-route data (profile / post / hashtag) and returns the same
    # HTML shell with og:* / twitter:* meta tags injected. Real users
    # never touch the API for the HTML shell — zero perf cost.
    location / {
        if (\$http_user_agent ~* "(twitterbot|facebookexternalhit|meta-externalagent|slackbot|slack-imgproxy|discordbot|telegrambot|whatsapp|linkedinbot|skypeuripreview|googlebot|bingbot|applebot|redditbot|mastodon|bluesky|cardyb|discoursebot|yandexbot|tumblr|wechat|line|twitchbot|vkshare|notion|pocket|preview|embedly|nuzzel|pinterest|rogerbot|showyoubot|outbrain|w3c_validator|cawbot)") {
            # Prefix the path with /__prerender and let nginx carry the
            # original query string through implicitly. The naive
            # \$request_uri form embeds the query inside the rewrite
            # target — nginx then percent-encodes the literal \`?\` from
            # \$request_uri into the path (e.g.
            # /__prerender/users/foo%3Fa=d?a=d), which survives all the
            # way to Express where req.path / req.params end up with
            # \`%3F...\` glued onto the slug, defeating the canonical-
            # redirect short-circuit and producing an infinite
            # 301-to-self on any crawler URL with a query string (TG
            # share previews were the symptom).
            #
            # \$uri alone is the right idiom: it's the decoded path with
            # no query, and \`rewrite ... last;\` without an explicit \`?\`
            # in the target preserves the original args automatically.
            rewrite ^ /__prerender\$uri last;
        }
        try_files \$uri \$uri/ /index.html;
    }

    # Internal-only proxy: the SPA prerender catch-all on the API. The
    # 'internal' directive means external requests to /__prerender are
    # rejected — only the 'rewrite ... last' above can land here.
    location /__prerender {
        internal;
        rewrite ^/__prerender(.*)\$ \$1 break;
        proxy_pass http://127.0.0.1:${apiPort};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 30s;
    }
`

  if (!tls) {
    // Port-80-only block — used as the intermediate state for Let's Encrypt
    // before certbot bolts on the TLS server and 80→443 redirect.
    return `# Auto-generated by caw cli. Edit at your own risk.
server {
    listen 80;
    listen [::]:80;
    server_name ${domain};

    root ${frontendDist};
    index index.html;

    client_max_body_size 25m;
${sharedLocations}}
`
  }

  return `# Auto-generated by caw cli. Edit at your own risk.
server {
    listen 80;
    listen [::]:80;
    server_name ${domain};
    return 301 https://\$host\$request_uri;
}

server {
${nginxSupportsHttp2Directive
  ? `    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;`
  : `    listen 443 ssl http2;
    listen [::]:443 ssl http2;`}
    server_name ${domain};

    ssl_certificate     ${tls.certPath};
    ssl_certificate_key ${tls.keyPath};

    # Strong defaults — modern Mozilla intermediate.
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;

    # Defense-in-depth security headers. CSP makes XSS exploitation
    # much harder by restricting which scripts can run + where the
    # page can connect to. The Express layer also sets these on its
    # responses (programs/api routes), but most user traffic hits
    # nginx-served static dist, so we apply them here too.
    # Audit fix 2026-05-10 (Round 7 #3).
    #
    # The 'sha256-...' hash covers the inline theme-flash-prevention
    # script in dist/index.html. If that script changes, regenerate:
    #   node -e "require('crypto').createHash('sha256').update(\$SCRIPT).digest('base64')"
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' 'sha256-xkVMad1A/6ozRonIOqWni0BBYrgJP5OHmcnrwTlUgGc='; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob: https:; media-src 'self' blob: https:; connect-src 'self' https://*.caw.social wss://*.caw.social https://*.alchemyapi.io https://*.infura.io https://*.publicnode.com https://api.x.com https://*.filebase.io; frame-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Permissions-Policy "geolocation=(), microphone=(), camera=()" always;

    root ${frontendDist};
    index index.html;

    client_max_body_size 25m;
${sharedLocations}}
`
}
