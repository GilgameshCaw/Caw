#!/usr/bin/env node

import { Command } from 'commander'
import { execSync } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'
import { banner, section, success, brand, dim } from '../src/utils/ui.js'
import { selectNodeType } from '../src/steps/nodeType.js'
import { collectNetworkAndMode } from '../src/steps/networkAndMode.js'
import { collectRpcUrls } from '../src/steps/rpcUrls.js'
import { collectValidatorConfig } from '../src/steps/validator.js'
import { collectReplicationConfig } from '../src/steps/replication.js'
import { collectInfraConfig } from '../src/steps/infrastructure.js'
import { generateConfig } from '../src/steps/generate.js'
import { runInstall, startServices } from '../src/steps/install.js'
import { configureNginx } from '../src/steps/nginx.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = path.resolve(__dirname, '../..')

const program = new Command()

program
  .name('caw')
  .description('CAW Protocol node installer and manager')
  .version('0.1.0')

program
  .command('install')
  .description('Interactive setup wizard for a new CAW node')
  .option('--dir <path>', 'Installation directory', ROOT_DIR)
  .action(async (opts) => {
    try {
      banner()

      console.log(dim('  Welcome to the CAW node setup wizard.'))
      console.log(dim('  This will walk you through configuring and starting your node.'))
      console.log()

      // Step 1: Node type
      const nodeType = await selectNodeType()

      // Step 2: Network + deployment mode (drives chain labels in step 3)
      const networkConfig = await collectNetworkAndMode(nodeType)

      // Step 3: RPC URLs (labels reflect the chosen network)
      const rpcConfig = await collectRpcUrls(nodeType, networkConfig.network)

      // Step 4: Validator config (if applicable). Pass the L1 RPC + network
      // so we can look up the validator's tokenId by username on-chain.
      const validatorConfig = await collectValidatorConfig(nodeType, opts.dir, {
        l1RpcUrl: rpcConfig.l1RpcUrlHttp || rpcConfig.l1RpcUrl,
        network: networkConfig.network,
      })

      // Step 5: Replication (optional). Asked separately because operators
      // can run a validator without participating in fraud-detection.
      const replicationConfig = await collectReplicationConfig(nodeType, {
        network: networkConfig.network,
      })

      // Step 6: Infrastructure (DB, Redis, domain, client ID). Passes the
      // L1 RPC + validator key so the client-creation sub-flow has what it
      // needs to sign + broadcast the createClient tx.
      const infraConfig = await collectInfraConfig(nodeType, {
        l1RpcUrl: rpcConfig.l1RpcUrlHttp || rpcConfig.l1RpcUrl,
        validatorPrivateKey: validatorConfig.validatorPrivateKey,
        network: networkConfig.network,
      })

      // Merge all config
      const fullConfig = {
        ...networkConfig,
        ...rpcConfig,
        ...validatorConfig,
        ...replicationConfig,
        ...infraConfig,
      }

      // Step 5: Generate config files
      generateConfig(nodeType, fullConfig, opts.dir)

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
      if (infraConfig.domain) {
        console.log(brand(`  Frontend: https://${infraConfig.domain}`))
        console.log(brand(`  API:      https://${infraConfig.domain}/api`))
      } else {
        console.log(brand(`  API:      http://localhost:${infraConfig.apiPort || 4000}`))
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
      if (infraConfig.domain && ['full', 'frontend-api'].includes(nodeType)) {
        console.log(brand('  ⚠  Lock down your RPC URLs at the provider'))
        console.log(dim('     Your frontend RPC URLs ship in the public JS bundle and are'))
        console.log(dim('     visible in DevTools to anyone who loads your site. Allowlist them'))
        console.log(dim('     at your provider so other people can\'t use them on your dime.'))
        console.log()
        console.log(`     ${brand('HTTP referer / domain allowlist:')} https://${infraConfig.domain}`)
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
