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
  const sitesAvailable = `/etc/nginx/sites-available/${config.domain}`
  const sitesEnabled = `/etc/nginx/sites-enabled/${config.domain}`

  // Letsencrypt requires a running HTTP-only block first so certbot can solve
  // the HTTP-01 challenge. Once it succeeds, certbot rewrites our config to
  // add the TLS server and 80→443 redirect.
  const tls = sslMode === 'letsencrypt' ? null : { certPath, keyPath, mode: sslMode }
  const conf = renderNginxConf({ domain: config.domain, apiPort, frontendDist, tls })

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
function renderNginxConf({ domain, apiPort, frontendDist, tls }) {
  // The built frontend is a SPA — every unknown path falls through to
  // index.html so React Router handles the route. /api and /socket.io go to
  // the Node server. Static assets in /assets/ get long cache headers.
  const sharedLocations = `
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

    # Long cache for hashed asset bundles
    location /assets/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # SPA fallback — everything else serves index.html
    location / {
        try_files \$uri \$uri/ /index.html;
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
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name ${domain};

    ssl_certificate     ${tls.certPath};
    ssl_certificate_key ${tls.keyPath};

    # Strong defaults — modern Mozilla intermediate.
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;

    add_header Strict-Transport-Security "max-age=31536000" always;

    root ${frontendDist};
    index index.html;

    client_max_body_size 25m;
${sharedLocations}}
`
}
