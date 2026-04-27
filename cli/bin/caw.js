#!/usr/bin/env node

import { Command } from 'commander'
import { execSync } from 'child_process'
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
