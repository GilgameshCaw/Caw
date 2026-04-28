import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { section, success, dim, brand, warn } from '../utils/ui.js'

// Per-network constants. The CLI asks the operator which network they want;
// everything chain-id-flavored derives from this single source so we never
// have to hand-update half a dozen call sites when adding a new network.
const NETWORKS = {
  testnet: {
    label: 'Testnet (Base Sepolia)',
    l2ChainId: 84532,    // Base Sepolia
    l1ChainId: 11155111, // Ethereum Sepolia
  },
  mainnet: {
    label: 'Mainnet (Base)',
    l2ChainId: 8453,     // Base
    l1ChainId: 1,        // Ethereum mainnet
  },
}

/**
 * Generate config.json and .env from collected answers, plus resolve the
 * client's storage chain on L1 and write a per-install addresses.ts.
 */
export async function generateConfig(nodeType, config, installDir) {
  section('Generating Configuration')

  const clientDir = path.join(installDir, 'client')

  // Build config.json (services to run)
  const services = buildServiceList(nodeType, config)
  const configJsonPath = path.join(clientDir, 'config.json')
  fs.writeFileSync(configJsonPath, JSON.stringify(services, null, 2) + '\n')
  console.log(success(`  Created ${dim(configJsonPath)}`))

  // Build .env. Mode 0600 — backend .env carries VALIDATOR_PRIVATE_KEY,
  // REPLICATOR_PRIVATE_KEY, JWT_SECRET, ADMIN_PASSWORD, and DB credentials.
  // World-readable would let any user on the box read keys that authorize
  // L2 submissions and admin-dashboard access. {mode: 0o600} on the
  // initial write covers fresh installs; existing files we explicitly
  // chmod afterward (writeFileSync's mode option is ignored for files
  // that already exist — Node's documented behavior).
  const envVars = buildEnvVars(nodeType, config)
  const envPath = path.join(clientDir, '.env')
  const envContent = Object.entries(envVars)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n') + '\n'
  fs.writeFileSync(envPath, envContent, { mode: 0o600 })
  fs.chmodSync(envPath, 0o600)
  console.log(success(`  Created ${dim(envPath)} (mode 600)`))

  // Build .env for frontend (Vite). Less sensitive than the backend .env
  // (only VITE_* values, which all end up in the public JS bundle anyway),
  // but no reason to leak. 0640 — owner write, owner+group read.
  if (['full', 'frontend-api', 'frontend-only'].includes(nodeType)) {
    const frontendEnv = buildFrontendEnv(nodeType, config)
    const frontendEnvPath = path.join(clientDir, 'src/services/FrontEnd/.env')
    const frontendEnvContent = Object.entries(frontendEnv)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n') + '\n'
    fs.writeFileSync(frontendEnvPath, frontendEnvContent, { mode: 0o640 })
    fs.chmodSync(frontendEnvPath, 0o640)
    console.log(success(`  Created ${dim(frontendEnvPath)} (mode 640)`))
  }

  // Build docker-compose.yml if needed
  if (config.useDocker === 'docker') {
    const dockerComposePath = path.join(installDir, 'docker-compose.yml')
    fs.writeFileSync(dockerComposePath, buildDockerCompose(config))
    console.log(success(`  Created ${dim(dockerComposePath)}`))
  }

  // Build pm2 ecosystem file
  const pm2Config = buildPm2Config(nodeType, config, installDir)
  const pm2Path = path.join(installDir, 'ecosystem.config.cjs')
  fs.writeFileSync(pm2Path, `module.exports = ${JSON.stringify(pm2Config, null, 2)}\n`)
  console.log(success(`  Created ${dim(pm2Path)}`))

  // Resolve the client's storage chain on L1 + write addresses.ts. Skipped
  // for frontend-only installs — they get their addresses from a sibling
  // API node (the static repo file works for those, since they don't run
  // the validator/indexer that need per-chain addresses to be exact).
  if (['full', 'frontend-api', 'api-only', 'validator'].includes(nodeType)) {
    await writeAddressesForClient(config, clientDir)
  }

  return { configJsonPath, envPath }
}

/**
 * Resolve the operator's chosen client to a storage chain on L1, pull the
 * matching contract addresses out of deployments.ts, and write a per-install
 * addresses.ts. The rest of the codebase imports singular constants from
 * addresses.ts and stays multi-chain-unaware.
 */
async function writeAddressesForClient(config, clientDir) {
  const env = config.network || 'testnet'
  const clientId = Number(config.clientId || 1)
  const l1RpcUrl = config.l1RpcUrlHttp || config.l1RpcUrl
  if (!l1RpcUrl) {
    console.log(dim('  Skipping addresses.ts (no L1 RPC) — fill in client/src/abi/addresses.ts manually.'))
    return
  }

  // Dynamic imports so the CLI doesn't hard-require ethers up front for
  // installs that skip this step.
  const { ethers } = await import('ethers')
  const { deployments, lzEids, chainKeyForEid } = await import(
    `file://${path.join(clientDir, 'src/abi/deployments.ts').replace(/\.ts$/, '.js')}`
  ).catch(async () => {
    // .ts isn't directly importable without a loader; fall back to reading
    // the file and pulling out what we need. Robust against the operator
    // not having tsx/ts-node set up at install time.
    const txt = fs.readFileSync(path.join(clientDir, 'src/abi/deployments.ts'), 'utf8')
    return {
      deployments: parseDeploymentsBlock(txt),
      lzEids: parseLzEids(txt),
      chainKeyForEid: (e, eid) => {
        const block = parseLzEids(txt)[e] || {}
        for (const [k, v] of Object.entries(block)) if (v === eid) return k
        return null
      },
    }
  })

  // Read CCM.getStorageChainEid(clientId) on L1.
  const envBlock = deployments[env] || {}
  const ccmAddr = envBlock.L1?.CawClientManager
  if (!ccmAddr) {
    console.log(dim(`  Skipping addresses.ts (no CawClientManager in deployments[${env}].L1).`))
    return
  }
  const provider = new ethers.JsonRpcProvider(l1RpcUrl)
  const ccm = new ethers.Contract(
    ccmAddr,
    ['function getStorageChainEid(uint32 clientId) view returns (uint32)'],
    provider,
  )
  let eid
  try {
    eid = Number(await ccm.getStorageChainEid(clientId))
  } catch (e) {
    console.log(dim(`  Couldn't read storageChainEid for client ${clientId} from L1: ${e.message?.slice(0, 80)}`))
    console.log(dim('  Skipping addresses.ts — verify the client exists on-chain and rerun.'))
    return
  }
  const chainKey = chainKeyForEid(env, eid)
  if (!chainKey) {
    console.log(dim(`  Client ${clientId} reports storage eid ${eid}, no matching chain in deployments[${env}].`))
    return
  }

  const l1 = envBlock.L1 || {}
  const l2 = envBlock[chainKey] || {}
  // Singular constants the codebase reads. Keys here mirror what was in the
  // hand-edited addresses.ts.
  const consts = {
    CAW_ADDRESS: l1.MintableCaw,
    CAW_NAMES_ADDRESS: l1.CawProfile,
    CAW_NAME_QUOTER_ADDRESS: l1.CawProfileQuoter,
    CAW_NAMES_MINTER_ADDRESS: l1.CawProfileMinter,
    URI_GENERATOR_ADDRESS: l1.CawProfileURI,
    CLIENT_MANAGER_ADDRESS: l1.CawClientManager,
    CAW_NAME_MARKETPLACE_ADDRESS: l1.CawProfileMarketplace,
    CAW_NAMES_L2_MAINNET_ADDRESS: l1.CawProfileL2,
    CAW_ACTIONS_MAINNET_ADDRESS: l1.CawActions,
    // Per-client-storage-chain — resolved here, not multi-chain in the codebase.
    CAW_NAMES_L2_ADDRESS: l2.CawProfileL2,
    CAW_ACTIONS_ADDRESS: l2.CawActions,
    CAW_ACTIONS_ARCHIVE_ADDRESS: l2.CawActionsArchive,
    CAW_CHALLENGE_RELAY_ADDRESS: l2.CawChallengeRelay,
  }
  const staticConsts = {
    WETH_ADDRESS: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
    USDC_ADDRESS: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    USDT_ADDRESS: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
  }

  const lines = [
    `// Generated by the CLI install step (cli/src/steps/generate.js).`,
    `// Resolved for env=${env}, clientId=${clientId}, storage chain=${chainKey} (eid=${eid}).`,
    `// To rebuild: rerun the CLI \`install\`, or pull addresses out of`,
    `// client/src/abi/deployments.ts with chainKeyForEid().`,
    ``,
  ]
  for (const [k, v] of Object.entries(staticConsts)) {
    lines.push(`export const ${k} = "${v}" as const;`)
  }
  for (const [k, v] of Object.entries(consts)) {
    if (v) lines.push(`export const ${k} = "${v}" as const;`)
    else lines.push(`// export const ${k} = '...' — not deployed for ${env}/${chainKey} yet`)
  }
  const out = lines.join('\n') + '\n'
  const outPath = path.join(clientDir, 'src/abi/addresses.ts')
  fs.writeFileSync(outPath, out)
  console.log(success(`  Wrote ${dim(outPath)} (client ${clientId} → ${chainKey})`))
}

/**
 * Tiny parser for the deployments.ts file. We can't `import` a .ts file
 * directly without a loader at CLI runtime, so fall back to extracting
 * just the bits we need with regex. Trades cleverness for portability.
 */
function parseDeploymentsBlock(txt) {
  // Match each `<env>: { ... }` block.
  const result = {}
  const envRegex = /(testnet|mainnet|dev): \{([\s\S]*?)\n  \},/g
  let m
  while ((m = envRegex.exec(txt)) !== null) {
    const env = m[1]
    const body = m[2]
    const block = {}
    const chainRegex = /(L1|L2b?[a-z]?): \{([\s\S]*?)\n    \},/g
    let cm
    while ((cm = chainRegex.exec(body)) !== null) {
      const chain = cm[1]
      const inner = cm[2]
      const entries = {}
      const entryRegex = /(\w+): '(0x[a-fA-F0-9]+)'/g
      let em
      while ((em = entryRegex.exec(inner)) !== null) entries[em[1]] = em[2]
      block[chain] = entries
    }
    result[env] = block
  }
  return result
}

function parseLzEids(txt) {
  const result = {}
  const envRegex = /(testnet|mainnet|dev): \{([\s\S]*?)\n  \},/g
  // The lzEids const is a separate block; narrow the search:
  const lzMatch = /export const lzEids[^=]+= \{([\s\S]*?)\n\}/m.exec(txt)
  if (!lzMatch) return result
  const body = lzMatch[1]
  let m
  while ((m = envRegex.exec(body)) !== null) {
    const env = m[1]
    const inner = m[2]
    const entries = {}
    const entryRegex = /(L1|L2b?[a-z]?):\s*(\d+)/g
    let em
    while ((em = entryRegex.exec(inner)) !== null) entries[em[1]] = Number(em[2])
    result[env] = entries
  }
  return result
}

function buildServiceList(nodeType, config) {
  const services = []
  const net = NETWORKS[config.network || 'testnet']
  // Node groupings — keep these in one place so future tweaks don't need
  // to touch every if-statement below.
  const RUNS_FRONTEND = ['full', 'frontend-api'].includes(nodeType)
  const RUNS_API = ['full', 'frontend-api', 'api-only'].includes(nodeType)
  const RUNS_VALIDATOR = ['full', 'validator'].includes(nodeType)
  const RUNS_INDEXER = ['full', 'frontend-api', 'api-only', 'validator'].includes(nodeType)

  if (RUNS_FRONTEND) {
    services.push({ service: 'FrontEnd', config: {} })
  }

  if (RUNS_API) {
    const apiConfig = {
      port: config.apiPort || 4000,
      allowedOrigins: config.domain
        ? [`https://${config.domain}`, 'http://localhost:5274']
        : ['http://localhost:5274', 'http://localhost:5174']
    }
    if (config.domain) {
      apiConfig.shortUrlDomain = `https://${config.domain}`
    }
    services.push({ service: 'Api', config: apiConfig })

    services.push({
      service: 'ActionProcessor',
      config: { redisUrl: config.redisUrl || 'redis://127.0.0.1:6379' }
    })
    services.push({ service: 'DataCleaner', config: {} })
    services.push({ service: 'ScheduledPostProcessor', config: {} })
    services.push({ service: 'MarketplaceIndexer', config: {} })
    services.push({
      service: 'InstanceRegistry',
      config: {
        l1RpcUrl: '${L1_RPC_URL}',
        clientId: config.clientId,
      },
    })
  }

  if (RUNS_VALIDATOR) {
    services.push({
      service: 'Validator',
      config: {
        l2RpcUrl: '${L2_RPC_URL}',
        validatorId: config.validatorId,
        checkInterval: config.checkInterval || 3000
      }
    })
  }

  if (RUNS_INDEXER) {
    // Read l2DeployBlock from solidity/.deploy-state.json so RawEventsGatherer
    // backfills from the right L2 block on a fresh DB. Without this, the
    // gatherer falls back to "current head" and silently misses every
    // historical event for this client.
    //
    // Failure modes are non-fatal: a missing / malformed deploy-state file
    // just means we don't write startBlock and the gatherer stays at
    // current-head behavior (the same default as today). Operators can
    // also override START_BLOCK in client/.env for backfill repair.
    const deployStatePath = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../solidity/.deploy-state.json')
    let l2DeployBlock
    try {
      const ds = JSON.parse(fs.readFileSync(deployStatePath, 'utf8'))
      if (typeof ds?.l2DeployBlock === 'number' && ds.l2DeployBlock > 0) {
        l2DeployBlock = ds.l2DeployBlock
      }
    } catch {
      // .deploy-state.json missing on a contributor checkout that didn't
      // run the deploy script — fine, just skip startBlock.
    }
    services.push({
      service: 'RawEventsGatherer',
      config: {
        chainId: net.l2ChainId,
        rpcUrl: '${L2_RPC_URL}',
        ...(l2DeployBlock ? { startBlock: l2DeployBlock } : {}),
      }
    })
    services.push({
      service: 'ChainSyncService',
      config: {
        l1RpcUrl: '${L1_RPC_URL}',
        ethMainnetRpcUrl: '${ETH_MAINNET_RPC_URL}'
      }
    })
    services.push({
      service: 'NftTransferWatcher',
      config: {
        l1RpcUrl: '${L1_RPC_URL}',
        chainId: net.l1ChainId,
      }
    })
  }

  return services
}

function buildEnvVars(nodeType, config) {
  const env = {}
  const net = NETWORKS[config.network || 'testnet']

  env.DATABASE_URL = config.dbUrl || 'postgresql://postgres:postgres@127.0.0.1:5432/caw'
  env.REDIS_URL = config.redisUrl || 'redis://127.0.0.1:6379'
  env.ELASTICSEARCH_NODE = config.elasticsearchNode || 'http://127.0.0.1:9200'

  // Public origin for URLs the API hands back to the browser (uploaded image
  // URLs, short links, etc). Without this, upload routes fall back to
  // http://localhost:4000, which a browser served over HTTPS rejects as
  // mixed content. publicUrl() in client/src/api/util/publicUrl.ts reads it.
  if (config.domain) env.SHORTURL_DOMAIN = `https://${config.domain}`

  // Per-install Elasticsearch index prefix. install.sh derives it from the
  // domain so two installs don't collide on flat index names like "caws"
  // and "users". The ES service still uses flat names today (backlog),
  // but writing the var here means the eventual fix won't need a re-config.
  if (process.env.CAW_ES_INDEX_PREFIX) env.ES_INDEX_PREFIX = process.env.CAW_ES_INDEX_PREFIX

  if (config.l2RpcUrl) env.L2_RPC_URL = config.l2RpcUrl
  if (config.l2RpcUrlHttp) env.L2_RPC_URL_HTTP = config.l2RpcUrlHttp
  if (config.l1RpcUrl) env.L1_RPC_URL = config.l1RpcUrl
  if (config.l1RpcUrlHttp) env.L1_RPC_URL_HTTP = config.l1RpcUrlHttp
  if (config.ethMainnetRpcUrl) env.ETH_MAINNET_RPC_URL = config.ethMainnetRpcUrl
  // Optional Infura-style API Key Secrets. Backend-only — embedded as
  // Basic Auth in the URL by rpcProvider.ts withSecret() so the same
  // RPC project can have its origin allowlist locked down for the
  // frontend bundle while server traffic still authorizes correctly.
  if (config.l1RpcSecret) env.L1_RPC_SECRET = config.l1RpcSecret
  if (config.l2RpcSecret) env.L2_RPC_SECRET = config.l2RpcSecret
  if (config.ethMainnetRpcSecret) env.ETH_MAINNET_RPC_SECRET = config.ethMainnetRpcSecret
  if (config.validatorPrivateKey) env.VALIDATOR_PRIVATE_KEY = config.validatorPrivateKey
  if (config.validatorId) env.VALIDATOR_ID = String(config.validatorId)
  if (config.validatorUsername) env.VALIDATOR_USERNAME = config.validatorUsername
  if (config.adminPassword) env.ADMIN_PASSWORD = config.adminPassword

  // Giphy API key for the /api/giphy proxy that backs the GIF picker. No
  // VITE_ prefix — server-side only. When unset, /api/giphy returns 500
  // and the picker shows an error to the user; the rest of the app is
  // unaffected.
  if (config.giphyApiKey) env.GIPHY_API_KEY = config.giphyApiKey

  // INSTANCE_API_URL drives the on-chain registerInstance call in
  // InstanceRegistryService — the gossip layer other CAW nodes use to
  // route DMs / mentions to this instance. Empty = skip registration.
  if (config.instanceApiUrl) env.INSTANCE_API_URL = config.instanceApiUrl

  // Sentry — same DSN serves both backend (SENTRY_DSN) and the frontend
  // bundle (VITE_SENTRY_DSN); Sentry routes events by source. Both unset =
  // no error reporting (instrument.ts and the start.ts handlers are no-ops).
  if (config.sentryDsn) env.SENTRY_DSN = config.sentryDsn

  // OpenTelemetry / SigNoz — backend-only. The standard OTLP env var name
  // gets the OTel SDK initialized in src/otel.ts; unset = no-op. Service
  // name is auto-derived from domain/clientId in collectSignozEndpoint so
  // multiple CAW instances sharing one collector don't collide as one
  // merged "caw-backend" entry in the SigNoz UI.
  if (config.signozEndpoint) env.OTEL_EXPORTER_OTLP_ENDPOINT = config.signozEndpoint
  if (config.otelServiceName) env.OTEL_SERVICE_NAME = config.otelServiceName

  // CLIENT_ID is the same value the frontend reads as VITE_CLIENT_ID — the
  // duplication exists only because Vite requires the VITE_ prefix to expose
  // a var to the browser bundle. Backend services (RawEventsGatherer,
  // DmRelayService, DataCleaner, InstanceRegistryService) read CLIENT_ID
  // directly. Without it, they silently fall back to clientId=1, which is
  // wrong for any install serving a different client.
  if (config.clientId) env.CLIENT_ID = String(config.clientId)

  // Replication is optional. REPLICATION_RPC + REPLICATION_CHAIN enable the
  // optimistic-archive loop in ValidatorService; REPLICATOR_PRIVATE_KEY is
  // only set when the operator chose a separate replicator key (otherwise
  // the service falls back to the validator key).
  if (config.replicationRpcUrl) env.REPLICATION_RPC = config.replicationRpcUrl
  if (config.replicationChain) env.REPLICATION_CHAIN = config.replicationChain
  if (config.replicatorPrivateKey) env.REPLICATOR_PRIVATE_KEY = config.replicatorPrivateKey

  // REPLICATE_CLIENT_IDS defaults to this install's own clientId — the common
  // case is "I run a node for client N, so I replicate N." When replication
  // is enabled, prefer the operator's explicit answer (which may list
  // multiple); otherwise mirror CLIENT_ID so the var isn't missing. Skip
  // entirely when replication is off — writing it would be misleading.
  if (config.replicationRpcUrl) {
    env.REPLICATE_CLIENT_IDS = config.replicateClientIds || String(config.clientId || 1)
  }

  // JWT signs API session tokens. Precedence:
  //   1. CAW_JWT_SECRET — preloaded from a previous --env re-run. Critical:
  //      regenerating this invalidates every signed-in user's session, so
  //      we MUST honor the preload above any fresh-random fallback.
  //   2. config.jwtSecret — set by callers that want to inject one explicitly.
  //   3. fresh random — fresh installs only.
  env.JWT_SECRET =
    process.env.CAW_JWT_SECRET ||
    config.jwtSecret ||
    crypto.randomBytes(48).toString('hex')

  // Preserve any custom Prisma engine selection across re-runs (default is
  // the schema's setting; operators sometimes flip to 'binary' to avoid
  // libssl version mismatches on older distros).
  if (process.env.CAW_PRISMA_QUERY_ENGINE_TYPE) {
    env.PRISMA_QUERY_ENGINE_TYPE = process.env.CAW_PRISMA_QUERY_ENGINE_TYPE
  }

  env.L2_CHAIN_ID = String(net.l2ChainId)
  env.L1_CHAIN_ID = String(net.l1ChainId)
  env.NETWORK = config.network || 'testnet'

  return env
}

function buildFrontendEnv(nodeType, config) {
  const env = {}

  if (nodeType === 'frontend-only') {
    env.VITE_API_HOST = config.apiUrl
  } else {
    // Frontend talks to its own API
    env.VITE_API_HOST = ''
  }

  env.VITE_CLIENT_ID = String(config.clientId || 1)

  // Frontend RPC URLs. When the operator opted into a separate frontend
  // key during the RPC step, use that — this is the two-key flow:
  // backend gets L*_RPC_URL_HTTP (with optional secret); frontend gets
  // a different VITE_L*_RPC_URL that's origin-locked at the provider.
  // When no separate key was given, fall back to the shared URL (the
  // single-key flow, where the backend secret unblocks the locked-down
  // project for server traffic). Either way, never write a *_SECRET into
  // VITE_* — those would end up in the public bundle.
  const viteL1 = config.l1RpcUrlHttpFrontend || config.l1RpcUrlHttp
  const viteL2 = config.l2RpcUrlHttpFrontend || config.l2RpcUrlHttp
  if (viteL1) env.VITE_L1_RPC_URL = viteL1
  if (viteL2) env.VITE_L2_RPC_URL = viteL2

  // WalletConnect / Reown project ID — per-operator, asked at install time.
  // When blank, Web3Provider.tsx falls back to a placeholder and WC wallets
  // simply won't connect until the operator fills it in. We don't bake in a
  // shared project ID because IDs are tied to one dashboard's quota /
  // origin allowlist, and rotating it would break every install at once.
  if (config.walletConnectProjectId) {
    env.VITE_PROJECT_ID = config.walletConnectProjectId
  }

  // Sentry DSN for the browser bundle (instrument.ts gates its init on
  // this var). Same value the backend reads as SENTRY_DSN; Sentry routes
  // events by source so one DSN works for both.
  if (config.sentryDsn) {
    env.VITE_SENTRY_DSN = config.sentryDsn
  }

  return env
}

function buildDockerCompose(config) {
  const dbPassword = config.dbUrl?.match(/:([^@]+)@/)?.[1] || 'postgres'

  return `version: '3.8'

services:
  postgres:
    image: postgres:16-alpine
    restart: always
    environment:
      POSTGRES_PASSWORD: ${dbPassword}
      POSTGRES_DB: caw
    ports:
      - "5432:5432"
    volumes:
      - caw_pgdata:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    restart: always
    ports:
      - "6379:6379"
    volumes:
      - caw_redis:/data

volumes:
  caw_pgdata:
  caw_redis:
`
}

function buildPm2Config(nodeType, config, installDir) {
  const apps = []
  // If `pm2 startup` is wired to systemd, pm2 boots as root and launches each
  // app. Set the per-app `user` so workloads drop privileges. When pm2 runs
  // unprivileged (the typical CLI install path), this is a no-op.
  const runAsUser = config.runAsUser || process.env.SUDO_USER || (process.getuid && process.getuid() === 0 ? 'caw' : undefined)

  // Multiple CAW installs share one pm2 daemon, so app names need to be
  // unique. Use the domain (or "default" for dirless installs) as a suffix
  // so `pm2 list` reads cleanly: caw-server-test1.caw.social,
  // caw-server-test2.caw.social, etc.
  const suffix = config.domain || 'default'
  const apiPort = config.apiPort || 4000

  // Main CAW server (all backend services run in one process)
  if (nodeType !== 'frontend-only') {
    apps.push({
      name: `caw-server-${suffix}`,
      cwd: path.join(installDir, 'client'),
      script: 'node',
      args: '-r ./file-polyfill.js -r tsx/cjs programs/start.ts',
      // PORT is referenced by the install-side port scan and is the single
      // source of truth for which port this install's API listens on.
      // config.json's Api.port should match (we set both from config.apiPort).
      env: { NODE_ENV: 'production', PORT: String(apiPort) },
      max_memory_restart: '1G',
      error_file: path.join(installDir, 'logs/caw-server-error.log'),
      out_file: path.join(installDir, 'logs/caw-server-out.log'),
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      ...(runAsUser ? { user: runAsUser } : {}),
    })
  }

  // Frontend: dev mode runs vite under pm2; production hands off to nginx
  // (which serves the static build produced during `runInstall`). So we only
  // add the pm2 app when we're in dev mode.
  const runFrontendUnderPm2 =
    ['full', 'frontend-api', 'frontend-only'].includes(nodeType) &&
    config.deployment !== 'production'
  if (runFrontendUnderPm2) {
    apps.push({
      name: `caw-frontend-${suffix}`,
      cwd: path.join(installDir, 'client/src/services/FrontEnd'),
      script: 'npx',
      args: 'vite --host 0.0.0.0',
      env: { NODE_ENV: 'development' },
      error_file: path.join(installDir, 'logs/caw-frontend-error.log'),
      out_file: path.join(installDir, 'logs/caw-frontend-out.log'),
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      ...(runAsUser ? { user: runAsUser } : {}),
    })
  }

  return { apps }
}
