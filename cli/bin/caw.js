#!/usr/bin/env node

// Defensive Node-version check. Operators occasionally run the CLI via
// `sudo node ...`, which strips $PATH and falls back to root's system
// Node — often years older than what nvm has set up in their shell. The
// resulting "ReferenceError: structuredClone is not defined" or
// "SyntaxError: ?? unexpected" is opaque; a clear error here saves the
// detour. Bail out fast on <20.
{
  const major = Number(process.versions.node.split('.')[0])
  if (Number.isFinite(major) && major < 20) {
    const which = (() => {
      try { return require('child_process').execSync('command -v node', { stdio: ['ignore','pipe','ignore'], shell: '/bin/bash' }).toString().trim() }
      catch { return process.execPath }
    })()
    process.stderr.write(
      `\nNode ${process.versions.node} is too old — this CLI needs Node 20+.\n` +
      `Running: ${which}\n\n` +
      `If you have a newer Node via nvm: sudo strips your PATH so it doesn't see it.\n` +
      `Either:\n` +
      `  • Use sudo -E so your env (and PATH) carry through:\n` +
      `      sudo -E env "PATH=$PATH" node cli/bin/caw.js install --env client/.env\n` +
      `  • Or run without sudo and let the CLI prompt for sudo where it needs it.\n`
    )
    process.exit(1)
  }
}

import { Command } from 'commander'
import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import inquirer from 'inquirer'
import { banner, section, success, brand, dim } from '../src/utils/ui.js'
import { selectNodeType } from '../src/steps/nodeType.js'
import { collectNetworkAndMode } from '../src/steps/networkAndMode.js'
import { collectL1Rpc, collectL2Rpc } from '../src/steps/rpcUrls.js'
import { chainLabels } from '../src/steps/networkAndMode.js'
import { collectValidatorConfig } from '../src/steps/validator.js'
import { collectReplicationConfig } from '../src/steps/replication.js'
import { collectInfraEarly, collectInfraLate } from '../src/steps/infrastructure.js'
import { setNetwork as setAddressesNetwork } from '../src/addresses.js'
import { generateConfig } from '../src/steps/generate.js'
import { runInstall, startServices } from '../src/steps/install.js'
import { configureNginx } from '../src/steps/nginx.js'
import { configureMediaNginx } from '../src/steps/mediaNginx.js'
import { runUpdate, applyMigrations, buildFrontend, resolveInstallDir } from '../src/steps/update.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = path.resolve(__dirname, '../..')

const program = new Command()

program
  .name('caw')
  .description('CAW Protocol node installer and manager')
  .version('0.1.0')

// Map .env keys (as written by generate.js) → CAW_* env-override keys that
// the individual install steps already honor for skip-the-prompt behavior.
// Used by --env to pre-populate process.env from an existing .env so the
// operator can re-run after a failure without re-typing every answer.
const ENV_TO_CAW = {
  DATABASE_URL: 'CAW_DB_URL',
  REDIS_URL: 'CAW_REDIS_URL',
  ELASTICSEARCH_NODE: 'CAW_ES_URL',
  ES_INDEX_PREFIX: 'CAW_ES_INDEX_PREFIX',
  GIPHY_API_KEY: 'CAW_GIPHY_API_KEY',
  X_OAUTH_CLIENT_ID: 'CAW_X_OAUTH_CLIENT_ID',
  X_OAUTH_CLIENT_SECRET: 'CAW_X_OAUTH_CLIENT_SECRET',
  SENTRY_DSN: 'CAW_SENTRY_DSN',
  OTEL_EXPORTER_OTLP_ENDPOINT: 'CAW_SIGNOZ_ENDPOINT',
  OTEL_SERVICE_NAME: 'CAW_OTEL_SERVICE_NAME',
  INSTANCE_API_URL: 'CAW_INSTANCE_API_URL',
  // RPC URLs — paste-from-Infura values the operator definitely doesn't
  // want to retype after a hiccup. The collectL1Rpc / collectL2Rpc steps
  // honor these CAW_* keys and skip the whole prompt.
  L1_RPC_URL: 'CAW_L1_RPC_URL',
  L1_RPC_URL_HTTP: 'CAW_L1_RPC_URL_HTTP',
  L1_RPC_SECRET: 'CAW_L1_RPC_SECRET',
  L2_RPC_URL: 'CAW_L2_RPC_URL',
  L2_RPC_URL_HTTP: 'CAW_L2_RPC_URL_HTTP',
  L2_RPC_SECRET: 'CAW_L2_RPC_SECRET',
  ETH_MAINNET_RPC_URL: 'CAW_ETH_MAINNET_RPC_URL',
  ETH_MAINNET_RPC_SECRET: 'CAW_ETH_MAINNET_RPC_SECRET',
  // Generated-once values that MUST persist across re-runs. Without these
  // in the preload map a `--env` re-run silently regenerates them, which
  // for JWT_SECRET in particular invalidates every signed-in user's session.
  JWT_SECRET: 'CAW_JWT_SECRET',
  PRISMA_QUERY_ENGINE_TYPE: 'CAW_PRISMA_QUERY_ENGINE_TYPE',
  // Network selection — collectNetworkAndMode honors CAW_NETWORK to skip
  // the prompt on re-runs (otherwise it asks every time even though the
  // answer is locked in by everything downstream).
  NETWORK: 'CAW_NETWORK',
  // Replication — collectReplicationConfig skips the entire participate +
  // chain + RPC + client-IDs prompt sequence when these are preloaded.
  // The replicator key still re-prompts (sensitive, same as validator key).
  REPLICATION_RPC: 'CAW_REPLICATION_RPC',
  REPLICATION_CHAIN: 'CAW_REPLICATION_CHAIN',
  REPLICATE_CLIENT_IDS: 'CAW_REPLICATE_CLIENT_IDS',
  REPLICATOR_PRIVATE_KEY: 'CAW_REPLICATOR_PRIVATE_KEY',
  // Identity — preloading these skips the whole validator + admin pw +
  // clientId prompt sequence. The values are already on disk in the
  // previous .env; re-asking just re-types the same answers.
  VALIDATOR_PRIVATE_KEY: 'CAW_VALIDATOR_PRIVATE_KEY',
  VALIDATOR_ID: 'CAW_VALIDATOR_ID',
  VALIDATOR_USERNAME: 'CAW_VALIDATOR_USERNAME',
  ADMIN_PASSWORD: 'CAW_ADMIN_PASSWORD',
  CLIENT_ID: 'CAW_CLIENT_ID',
  // VITE_PROJECT_ID lives in the FRONTEND .env, handled separately.
}

function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return {}
  const out = {}
  const src = fs.readFileSync(envPath, 'utf8')
  for (const line of src.split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (!m) continue
    let val = m[2]
    // Strip matching quotes if present.
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    out[m[1]] = val
  }
  return out
}

// Vars the wizard knows it doesn't preserve. Flagging them as "expected
// drops" suppresses the unrecognized-key warning below — they'd otherwise
// appear scary every re-run even though we deliberately re-derive them.
const EXPECTED_DROPS = new Set([
  // Re-derived from network/chain/clientId on every run; safe to drop.
  'L1_CHAIN_ID', 'L2_CHAIN_ID', 'NETWORK',
  // Re-derived from CAW_DOMAIN (shell env, not .env) on every run.
  'SHORTURL_DOMAIN',
  // Generated each install but the value doesn't matter (logger flags etc).
  'NODE_ENV',
])

// When --env points at a previous install, read every supported value out
// and stash it into process.env under the CAW_* override key the steps
// already check. Lets the operator re-run install end-to-end without
// re-typing values they got right last time.
//
// Returns { loaded, unrecognized } so the caller can warn about keys we
// won't preserve — anything in the operator's .env that the wizard doesn't
// know about would be silently dropped on rewrite.
// uint32 on chain — anything outside this range is bogus. Catches the
// case where an operator pasted a wallet address into CLIENT_ID by mistake:
// Number('0x...') resolves to ~1.2e+48, which passes Number.isInteger but
// poisons every downstream lookup. Mirror of validateClientId in
// cli/src/steps/generate.js (kept in sync by hand; both files run early
// enough that pulling one in from the other adds startup latency for no win).
function isValidClientId(raw) {
  if (raw === undefined || raw === '') return false
  const n = Number(raw)
  return Number.isFinite(n) && Number.isInteger(n) && n > 0 && n <= 0xffffffff
}

function preloadFromEnv(envFilePath, frontendEnvFilePath) {
  const backend = loadEnvFile(envFilePath)
  const frontend = frontendEnvFilePath ? loadEnvFile(frontendEnvFilePath) : {}
  let loaded = 0
  const unrecognized = []
  const rejected = []
  for (const [k, v] of Object.entries(backend)) {
    const target = ENV_TO_CAW[k]
    if (target && !process.env[target] && v) {
      // Per-key sanity filter for keys with known-bad failure modes. Bad
      // values get dropped on the floor with a warning — the wizard then
      // re-prompts normally for that field, instead of silently writing
      // garbage through to the new .env.
      if (k === 'CLIENT_ID' && !isValidClientId(v)) {
        rejected.push({ key: k, value: v, reason: 'must be a positive integer ≤ 4294967295 (looks like an address?)' })
        continue
      }
      process.env[target] = v
      loaded++
    } else if (!target && !EXPECTED_DROPS.has(k)) {
      unrecognized.push(k)
    }
  }
  if (rejected.length > 0) {
    console.log()
    console.log(brand('  ⚠ Values in your .env that look invalid — the wizard will re-prompt:'))
    for (const r of rejected) {
      console.log(dim(`     ${r.key} = ${JSON.stringify(r.value)}   (${r.reason})`))
    }
    console.log()
  }
  // Backend domain isn't written to .env directly, but install.sh already
  // forwards CAW_DOMAIN. If the operator wants to reuse, they should keep
  // CAW_DOMAIN set in their shell — we don't try to derive it from the .env.

  // VITE_PROJECT_ID from the frontend .env — same skip-the-prompt pattern.
  if (frontend.VITE_PROJECT_ID && !process.env.CAW_WALLETCONNECT_PROJECT_ID) {
    process.env.CAW_WALLETCONNECT_PROJECT_ID = frontend.VITE_PROJECT_ID
    loaded++
  }
  return { loaded, unrecognized }
}

program
  .command('install')
  .description('Interactive setup wizard for a new CAW node')
  .option('--dir <path>', 'Installation directory', ROOT_DIR)
  .option('--env <path>', 'Reuse values from an existing .env (skips prompts that already have answers)')
  .action(async (opts) => {
    try {
      banner()

      console.log(dim('  Welcome to the CAW node setup wizard.'))
      console.log(dim('  This will walk you through configuring and starting your node.'))
      console.log()

      // --env: pre-populate process.env from a previous install's .env files
      // so prompts that have answers there get auto-skipped. Resolves the
      // path against opts.dir if relative — `--env client/.env` is the
      // common case when re-running after a hiccup.
      if (opts.env) {
        const envPath = path.isAbsolute(opts.env) ? opts.env : path.resolve(opts.dir, opts.env)
        // The frontend has its own .env (VITE_*); look for it next to the
        // backend one when --env points at client/.env.
        const feEnvGuess = envPath.endsWith('/.env')
          ? envPath.replace(/\/\.env$/, '/src/services/FrontEnd/.env')
          : null
        const { loaded, unrecognized } = preloadFromEnv(envPath, feEnvGuess)
        if (loaded > 0) {
          console.log(dim(`  Loaded ${loaded} value(s) from ${envPath} — those prompts will skip.`))
        } else {
          console.log(dim(`  --env ${envPath}: no recognized values found.`))
        }
        if (unrecognized.length > 0) {
          // The wizard rewrites .env from scratch. Anything it doesn't
          // recognize gets dropped on save. The operator gets to decide:
          // back up first, ignore (and lose them), or abort. We previously
          // just printed a warning and slept 5s — too quick to read,
          // especially with N vars listed. An explicit prompt is safer.
          console.log()
          console.log(brand('  ⚠ Vars in your .env the wizard doesn\'t know about — these will be DROPPED on rewrite:'))
          for (const k of unrecognized) console.log(dim(`     ${k}`))
          console.log()

          const { choice } = await inquirer.prompt([
            {
              type: 'list',
              name: 'choice',
              message: 'How do you want to handle these?',
              choices: [
                { name: `Back up to .env.bak and continue`, value: 'backup' },
                { name: `Continue anyway (these vars will be lost)`, value: 'ignore' },
                { name: `Abort — I'll fix this myself`, value: 'abort' },
              ],
              default: 'backup',
            },
          ])

          if (choice === 'abort') {
            console.log(dim('  Aborted. To preserve these vars, either add them to'))
            console.log(dim('  ENV_TO_CAW in cli/bin/caw.js (open an issue if unsure) or'))
            console.log(dim('  back them up manually with: cp .env .env.bak'))
            process.exit(0)
          }
          if (choice === 'backup') {
            const backupPath = `${envPath}.bak`
            try {
              fs.copyFileSync(envPath, backupPath)
              console.log(dim(`  ✓ Backed up to ${backupPath}`))
            } catch (e) {
              console.log(dim(`  Could not write backup: ${e.message}`))
              const { ack } = await inquirer.prompt([
                { type: 'confirm', name: 'ack', message: 'Continue anyway?', default: false },
              ])
              if (!ack) process.exit(0)
            }
          }
        }
        console.log()
      }

      // Step 1: Node type
      const nodeType = await selectNodeType()

      // Step 2: Network + deployment mode (drives chain labels in step 3)
      const networkConfig = await collectNetworkAndMode(nodeType)

      // Tell the addresses module which env block to fall back to in
      // deployments.ts when the per-install addresses.ts isn't written
      // yet (fresh checkout). Validator/client steps below call addr()
      // before generate.js produces the real file.
      setAddressesNetwork(networkConfig.network)

      // Step 3: L1 RPC. Asked early — L1 is unambiguous (always Ethereum
      // mainnet/Sepolia) and the validator + client-lookup steps both need
      // it. The L2 RPC comes later, after we know which storage chain the
      // operator's chosen client uses.
      const l1RpcConfig = await collectL1Rpc(nodeType, networkConfig.network)

      // Step 4: Validator config (if applicable). Pass the L1 RPC + network
      // so we can look up the validator's tokenId by username on-chain.
      const validatorConfig = await collectValidatorConfig(nodeType, opts.dir, {
        l1RpcUrl: l1RpcConfig.l1RpcUrlHttp || l1RpcConfig.l1RpcUrl,
        network: networkConfig.network,
      })

      // Step 5: Infrastructure phase 1 — domain + admin password + client
      // selection + WalletConnect ID. Returns the chosen storage chain so
      // step 6 can name it in the L2 RPC prompt.
      const infraEarly = await collectInfraEarly(nodeType, {
        l1RpcUrl: l1RpcConfig.l1RpcUrlHttp || l1RpcConfig.l1RpcUrl,
        validatorPrivateKey: validatorConfig.validatorPrivateKey,
        network: networkConfig.network,
      })

      // Step 6: L2 RPC, labeled by the actual storage chain (Base Sepolia /
      // Arbitrum Sepolia / Ethereum Sepolia / …) when we managed to look it
      // up. Falls back to the network's default L2 label otherwise.
      const l2Label = infraEarly.storageChain?.label || chainLabels(networkConfig.network).l2
      const l2RpcConfig = await collectL2Rpc(nodeType, l2Label)

      // Step 7: Replication (optional). The replication step gets a hint
      // about the storage chain so it can sort the canonical pairing
      // (Base ↔ Arbitrum) to the top of the choices.
      const replicationConfig = await collectReplicationConfig(nodeType, {
        network: networkConfig.network,
        storageChainKey: infraEarly.storageChain?.key,
      })

      // Step 8: Infrastructure phase 2 — DB / Redis / Elasticsearch / API
      // port. None of these need on-chain state, so they happen after the
      // chain-aware steps to keep the natural flow.
      const infraLate = await collectInfraLate(nodeType)

      // Merge all config
      const fullConfig = {
        ...networkConfig,
        ...l1RpcConfig,
        ...l2RpcConfig,
        ...validatorConfig,
        ...replicationConfig,
        ...infraEarly,
        ...infraLate,
      }

      // Step 5: Generate config files
      await generateConfig(nodeType, fullConfig, opts.dir)

      // Step 6: Install dependencies + (production) build the frontend
      await runInstall(nodeType, fullConfig, opts.dir)

      // Step 7: nginx + TLS for production deployments with a domain.
      // Runs *after* install so the built dist/ exists for nginx to serve.
      await configureNginx(fullConfig, opts.dir)

      // Step 7b: media reverse-proxy vhost (Filebase). No-op unless the
      // generated .env has MEDIA_STORAGE_BACKEND=filebase. Wildcard cert
      // detection here mirrors the main nginx step's logic.
      try { await configureMediaNginx(opts.dir) } catch (e) {
        console.log(`  Media nginx setup failed: ${e.message}`)
      }

      // Step 8: Start everything via pm2
      await startServices(nodeType, opts.dir)

      // Done!
      section('Setup Complete!')
      console.log(success.bold('  Your CAW node is running!'))
      console.log()
      if (fullConfig.domain) {
        console.log(brand(`  Frontend: https://${fullConfig.domain}`))
        console.log(brand(`  API:      https://${fullConfig.domain}/api`))
      } else {
        console.log(brand(`  API:      http://localhost:${fullConfig.apiPort || 4000}`))
        if (['full', 'frontend-api', 'frontend-only'].includes(nodeType)) {
          console.log(brand(`  Frontend: http://localhost:5173`))
        }
      }
      console.log()

      // api-only nodes need port 4000 reachable from their sibling
      // frontend-only host (BIND_HOST is 0.0.0.0 for this nodeType).
      // ufw was configured before the wizard knew which nodeType you
      // picked, so it currently denies 4000. Tell the operator how to
      // open it. Restrict by source IP so the API isn't world-readable.
      if (nodeType === 'api-only') {
        console.log(brand('  ⚠  api-only node — port 4000 needs to be reachable from your FE box'))
        console.log(dim('     ufw is currently denying it. Allow only your FE host:'))
        console.log(dim('       sudo ufw allow from <FE-box-IP> to any port 4000 proto tcp'))
        console.log(dim('     Do NOT `ufw allow 4000/tcp` without a source restriction —'))
        console.log(dim('     that exposes the API to the whole internet.'))
        console.log()
      }

      // RPC URL leak warning. The frontend bundles VITE_L1_RPC_URL /
      // VITE_L2_RPC_URL into the built JS — they're visible in any browser's
      // DevTools to anyone who loads the page. Without provider-side
      // allowlists this lets randos burn through your free-tier quota or
      // rack up your paid bill in a few hours.
      if (fullConfig.domain && ['full', 'frontend-api'].includes(nodeType)) {
        console.log(brand('  ⚠  Lock down your RPC URLs at the provider'))
        console.log(dim('     Your frontend RPC URLs ship in the public JS bundle and are'))
        console.log(dim('     visible in DevTools to anyone who loads your site. Allowlist them'))
        console.log(dim('     at your provider so other people can\'t use them on your dime.'))
        console.log()
        console.log(`     ${brand('HTTP referer / domain allowlist:')} https://${fullConfig.domain}`)
        console.log(`     ${brand('Server IP allowlist (for backend calls):')} the public IP of this VPS`)
        console.log()
        console.log(dim('     Provider docs:'))
        console.log(dim('       Infura:    Settings → Configure → Allowlists'))
        console.log(dim('       Alchemy:   Apps → your app → Security → Add allowed origin / IP'))
        console.log(dim('       QuickNode: your endpoint → Endpoint Security'))
        console.log()
      }

      console.log(dim('  Run `pm2 list` to see running services.'))
      console.log(dim('  Run `pm2 logs` to view logs.'))
      console.log()

    } catch (error) {
      console.error('\n  Setup failed:', error.message)
      process.exit(1)
    }
  })

program
  .command('update')
  .description('Pull latest code, run migrations, rebuild FE if needed, restart services')
  .option('--dir <path>', 'Installation directory', ROOT_DIR)
  .option('--yes', 'Skip the confirmation prompt (for headless / cron use)')
  .option('--force', 'Allow destructive migrations (DROP TABLE, DROP COLUMN, etc) — USE WITH CARE')
  .option('--rebuild', 'Re-run yarn install + prisma generate + FE build + restart even if there are no new commits (recovery from a partial previous run)')
  .option('--no-migrations', 'Skip the migration apply phase')
  .option('--no-restart', 'Skip the pm2 restart phase')
  .option('--skip-verify-schema', 'Skip the schema-drift check (escape hatch — fix and remove ASAP)')
  .action(async (opts) => {
    try {
      const installDir = resolveInstallDir(opts, ROOT_DIR)
      await runUpdate(installDir, {
        yes: opts.yes,
        force: opts.force,
        rebuild: opts.rebuild,
        skipMigrations: opts.migrations === false,
        skipRestart: opts.restart === false,
        skipVerifySchema: opts.skipVerifySchema,
      })
    } catch (e) {
      console.error()
      console.error('Update failed:', e.message)
      process.exit(1)
    }
  })

program
  .command('migrate')
  .description('Apply any pending Prisma migrations against this install\'s DB')
  .option('--dir <path>', 'Installation directory', ROOT_DIR)
  .action(async (opts) => {
    try {
      const installDir = resolveInstallDir(opts, ROOT_DIR)
      await applyMigrations(installDir)
    } catch (e) {
      console.error('Migration failed:', e.message)
      process.exit(1)
    }
  })

program
  .command('build')
  .description('Rebuild the production frontend bundle (dist/) — no service restart needed')
  .option('--dir <path>', 'Installation directory', ROOT_DIR)
  .action(async (opts) => {
    try {
      const installDir = resolveInstallDir(opts, ROOT_DIR)
      await buildFrontend(installDir)
    } catch (e) {
      console.error('Build failed:', e.message)
      process.exit(1)
    }
  })

program
  .command('regen-addresses')
  .description('Regenerate client/src/abi/addresses.ts from deployments.ts (use after redeploying contracts)')
  .option('--dir <path>', 'Installation directory', ROOT_DIR)
  .option('--env <path>', 'Path to existing .env (default: <dir>/client/.env)')
  .action(async (opts) => {
    try {
      const installDir = resolveInstallDir(opts, ROOT_DIR)
      const envPath = opts.env
        ? (path.isAbsolute(opts.env) ? opts.env : path.resolve(installDir, opts.env))
        : path.join(installDir, 'client', '.env')
      if (!fs.existsSync(envPath)) {
        console.error(`No .env at ${envPath}. Specify with --env or run 'caw install' first.`)
        process.exit(1)
      }
      // Pull just the values writeAddressesForClient needs out of the
      // existing .env. No prompts, no preload trickery.
      const { generateConfig: _generateConfig, writeAddressesForClient } = await import('../src/steps/generate.js')
      void _generateConfig
      const env = loadEnvFile(envPath)
      if (env.CLIENT_ID && !isValidClientId(env.CLIENT_ID)) {
        console.error(
          `CLIENT_ID in ${envPath} is invalid: ${JSON.stringify(env.CLIENT_ID)} ` +
          `(must be a positive integer ≤ 4294967295). Fix it and re-run.`
        )
        process.exit(1)
      }
      const config = {
        network: env.NETWORK || 'testnet',
        clientId: Number(env.CLIENT_ID || 1),
        l1RpcUrl: env.L1_RPC_URL,
        l1RpcUrlHttp: env.L1_RPC_URL_HTTP,
      }
      const clientDir = path.join(installDir, 'client')
      setAddressesNetwork(config.network)
      console.log(brand(`Regenerating addresses.ts (network=${config.network}, clientId=${config.clientId})...`))
      await writeAddressesForClient(config, clientDir)
      console.log(success(`Done. addresses.ts now reflects deployments.ts for ${config.network}/client ${config.clientId}.`))
    } catch (e) {
      console.error('regen-addresses failed:', e.message)
      process.exit(1)
    }
  })

program
  .command('status')
  .description('Show status of CAW services')
  .action(() => {
    try {
      execSync('pm2 list', { stdio: 'inherit' })
    } catch {
      console.log('pm2 is not installed or no services are running.')
    }
  })

program
  .command('logs')
  .description('Tail CAW service logs')
  .argument('[service]', 'Service name (caw-server, caw-frontend)')
  .action((service) => {
    const target = service || 'all'
    try {
      execSync(`pm2 logs ${target} --lines 50`, { stdio: 'inherit' })
    } catch {
      console.log('pm2 is not installed or no services are running.')
    }
  })

program
  .command('restart')
  .description('Restart CAW services')
  .argument('[service]', 'Service name (or "all")', 'all')
  .action((service) => {
    try {
      execSync(`pm2 restart ${service}`, { stdio: 'inherit' })
    } catch {
      console.log('Failed to restart services.')
    }
  })

program
  .command('stop')
  .description('Stop CAW services')
  .action(() => {
    try {
      execSync('pm2 stop all', { stdio: 'inherit' })
    } catch {
      console.log('Failed to stop services.')
    }
  })

// Default: show help
program.parse(process.argv)
if (!process.argv.slice(2).length) {
  banner()
  program.outputHelp()
}
