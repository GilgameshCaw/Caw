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
    '  • handles HTTPS via your chosen TLS source',
  ])

  const { sslMode } = await inquirer.prompt([
    {
      type: 'list',
      name: 'sslMode',
      message: 'How are you handling SSL?',
      choices: [
        { value: 'own-cert', name: `${brand('I have my own cert')} ${dim('(point nginx at its files)')}` },
        { value: 'letsencrypt', name: `${brand('Use Let\'s Encrypt + certbot')} ${dim('(DNS must already be live)')}` },
        { value: 'skip', name: `${brand('Skip TLS for now')} ${dim('(HTTP only — dev/staging)')}` },
      ],
      default: 'own-cert',
    },
  ])

  let certPath, keyPath
  if (sslMode === 'own-cert') {
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

  // Dev/skip-TLS gets a port-80-only block. Everything else gets the full
  // 80→443 redirect + TLS server. Putting the dist/ + proxy logic in a single
  // location section keeps both modes' configs in lockstep.
  const tls = sslMode === 'skip' ? null : { certPath, keyPath, mode: sslMode }
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
    // Own-cert and skip both go through this path.
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
  if (sslMode === 'skip') {
    console.log(dim(`  http://${config.domain}/  →  ${frontendDist}`))
  } else {
    console.log(dim(`  https://${config.domain}/  →  ${frontendDist}`))
  }

  return { sslMode, certPath, keyPath }
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
    // HTTP-only mode (skip TLS). Nothing fancy.
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
