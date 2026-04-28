#!/usr/bin/env node

import { Command } from 'commander'
import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
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
  SENTRY_DSN: 'CAW_SENTRY_DSN',
  OTEL_EXPORTER_OTLP_ENDPOINT: 'CAW_SIGNOZ_ENDPOINT',
  OTEL_SERVICE_NAME: 'CAW_OTEL_SERVICE_NAME',
  INSTANCE_API_URL: 'CAW_INSTANCE_API_URL',
  // RPC URLs — paste-from-Infura values the operator definitely doesn't
  // want to retype after a hiccup. The collectL1Rpc / collectL2Rpc steps
  // honor these CAW_* keys and skip the whole prompt.
  L1_RPC_URL: 'CAW_L1_RPC_URL',
  L1_RPC_URL_HTTP: 'CAW_L1_RPC_URL_HTTP',
  L2_RPC_URL: 'CAW_L2_RPC_URL',
  L2_RPC_URL_HTTP: 'CAW_L2_RPC_URL_HTTP',
  ETH_MAINNET_RPC_URL: 'CAW_ETH_MAINNET_RPC_URL',
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

// When --env points at a previous install, read every supported value out
// and stash it into process.env under the CAW_* override key the steps
// already check. Lets the operator re-run install end-to-end without
// re-typing values they got right last time.
function preloadFromEnv(envFilePath, frontendEnvFilePath) {
  const backend = loadEnvFile(envFilePath)
  const frontend = frontendEnvFilePath ? loadEnvFile(frontendEnvFilePath) : {}
  let loaded = 0
  for (const [k, v] of Object.entries(backend)) {
    const target = ENV_TO_CAW[k]
    if (target && !process.env[target] && v) {
      process.env[target] = v
      loaded++
    }
  }
  // Backend domain isn't written to .env directly, but install.sh already
  // forwards CAW_DOMAIN. If the operator wants to reuse, they should keep
  // CAW_DOMAIN set in their shell — we don't try to derive it from the .env.

  // VITE_PROJECT_ID from the frontend .env — same skip-the-prompt pattern.
  if (frontend.VITE_PROJECT_ID && !process.env.CAW_WALLETCONNECT_PROJECT_ID) {
    process.env.CAW_WALLETCONNECT_PROJECT_ID = frontend.VITE_PROJECT_ID
    loaded++
  }
  return loaded
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
        const loaded = preloadFromEnv(envPath, feEnvGuess)
        if (loaded > 0) {
          console.log(dim(`  Loaded ${loaded} value(s) from ${envPath} — those prompts will skip.`))
          console.log()
        } else {
          console.log(dim(`  --env ${envPath}: no recognized values found.`))
          console.log()
        }
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
  .option('--no-migrations', 'Skip the migration apply phase')
  .option('--no-restart', 'Skip the pm2 restart phase')
  .action(async (opts) => {
    try {
      const installDir = resolveInstallDir(opts, ROOT_DIR)
      await runUpdate(installDir, {
        yes: opts.yes,
        force: opts.force,
        skipMigrations: opts.migrations === false,
        skipRestart: opts.restart === false,
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
