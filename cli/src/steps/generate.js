import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { section, success, dim, brand, warn } from '../utils/ui.js'
import { makeProvider } from '../utils/rpc.js'

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
 * Network's storage chain on L1 and write a per-install addresses.ts.
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
  // REPLICATOR_PRIVATE_KEY, JWT_SECRET, ADMIN_TOKEN_IDS, and DB credentials.
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

  // Same NaN/address-as-number trap as VITE_NETWORK_ID, but for the backend.
  // NETWORK_ID is read by InstanceRegistryService, DmRelayService, DataCleaner,
  // etc. If it got set to a wallet address by mistake, /api/instances returns
  // a networkId of ~1.2e+48 and the peer cache is empty — the failure mode
  // Nyaro hit. Catch it here so the operator gets a clear error at install
  // time instead of debugging it post-deploy.
  verifyBackendEnv(envPath)

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

    // Read the file back and confirm VITE_NETWORK_ID landed as a positive
    // integer. If it didn't, every contract-call hook in the FE will throw
    // `NaN can't be converted to BigInt` at runtime — a confusing failure
    // mode that pulls operators (and their AIs) into hours of debugging the
    // wrong layer. Fail the install instead.
    verifyFrontendEnv(frontendEnvPath)
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

  // Resolve the Network's storage chain on L1 + write addresses.ts. Skipped
  // for frontend-only installs — they get their addresses from a sibling
  // API node (the static repo file works for those, since they don't run
  // the validator/indexer that need per-chain addresses to be exact).
  if (['full', 'frontend-api', 'api-only', 'validator'].includes(nodeType)) {
    await writeAddressesForNetwork(config, clientDir)
  }

  return { configJsonPath, envPath }
}

/**
 * Resolve the operator's chosen Network to a storage chain on L1, pull the
 * matching contract addresses out of deployments.ts, and write a per-install
 * addresses.ts. The rest of the codebase imports singular constants from
 * addresses.ts and stays multi-chain-unaware.
 */
export async function writeAddressesForNetwork(config, clientDir) {
  const env = config.network || 'testnet'
  const networkId = Number(config.networkId || 1)
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

  // Read CNM.getStorageChainEid(networkId) on L1.
  const envBlock = deployments[env] || {}
  const cnmAddr = envBlock.L1?.CawNetworkManager
  if (!cnmAddr) {
    console.log(dim(`  Skipping addresses.ts (no CawNetworkManager in deployments[${env}].L1).`))
    return
  }
  // makeProvider injects the API Key Secret (Basic Auth) + disables network
  // background-polling — same as every other CLI L1 read. A bare provider
  // 403s on a secret-required Infura project.
  const provider = makeProvider(ethers, l1RpcUrl, config.l1RpcSecret)
  const cnm = new ethers.Contract(
    cnmAddr,
    ['function getStorageChainEid(uint32 networkId) view returns (uint32)'],
    provider,
  )
  let eid
  try {
    eid = Number(await cnm.getStorageChainEid(networkId))
  } catch (e) {
    console.log(dim(`  Couldn't read storageChainEid for Network ${networkId} from L1: ${e.message?.slice(0, 80)}`))
    console.log(dim('  Skipping addresses.ts — verify the Network exists on-chain and rerun.'))
    return
  } finally {
    provider.destroy?.()
  }
  const chainKey = chainKeyForEid(env, eid)
  if (!chainKey) {
    console.log(dim(`  Network ${networkId} reports storage eid ${eid}, no matching chain in deployments[${env}].`))
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
    CAW_PROFILE_LENS_ADDRESS: l1.CawProfileLens,
    CAW_NAMES_MINTER_ADDRESS: l1.CawProfileMinter,
    URI_GENERATOR_ADDRESS: l1.CawProfileURI,
    NETWORK_MANAGER_ADDRESS: l1.CawNetworkManager,
    CAW_NAME_MARKETPLACE_ADDRESS: l1.CawProfileMarketplace,
    CAW_NAMES_L2_MAINNET_ADDRESS: l1.CawProfileLedger,
    CAW_ACTIONS_MAINNET_ADDRESS: l1.CawActions,
    // L1-side ERC-1271 sibling + the EIP-7702 SmartEOA delegate. The FE reads
    // both (population routing + sponsored-flow signing), so they must be in
    // addresses.ts — previously omitted, which broke the FE build (#196).
    CAW_ACTIONS_ERC1271_ADDRESS: l1.CawActionsERC1271,
    SMART_EOA_ADDRESS: l1.SmartEOA,
    // Per-Network-storage-chain — resolved here, not multi-chain in the codebase.
    CAW_NAMES_L2_ADDRESS: l2.CawProfileLedger,
    CAW_ACTIONS_ADDRESS: l2.CawActions,
    CAW_ACTIONS_ARCHIVE_ADDRESS: l2.CawActionsArchive,
    CAW_CHALLENGE_RELAY_ADDRESS: l2.CawChallengeRelay,
  }
  const staticConsts = {
    WETH_ADDRESS: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
    USDC_ADDRESS: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    USDT_ADDRESS: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    // CAW/WETH Uniswap V2 pair (Base mainnet, locked liquidity). Used by the
    // ZAP flows (pay-with-ETH mint+deposit / deposit) for slippage quoting.
    CAW_PAIR_ADDRESS: '0x48D20b3e529fB3DD7D91293f80638dF582AB2Daa',
  }

  const lines = [
    `// Generated by the CLI install step (cli/src/steps/generate.js).`,
    `// Resolved for env=${env}, networkId=${networkId}, storage chain=${chainKey} (eid=${eid}).`,
    `// To rebuild: rerun the CLI \`install\`, or pull addresses out of`,
    `// client/src/abi/deployments.ts with chainKeyForEid().`,
    ``,
  ]
  for (const [k, v] of Object.entries(staticConsts)) {
    lines.push(`export const ${k} = "${v}" as const;`)
  }
  for (const [k, v] of Object.entries(consts)) {
    if (v) {
      lines.push(`export const ${k} = "${v}" as const;`)
    } else {
      // Still EXPORT the symbol (as undefined) rather than commenting it out.
      // A commented-out export breaks `import { THAT_CONST }` at FE build time
      // ("has no exported member") even for a const the page only uses
      // conditionally. Emitting `= undefined` keeps the import resolvable;
      // consumers already guard on a falsy address. (Fixes #196.)
      lines.push(`export const ${k} = undefined; // not deployed for ${env}/${chainKey}`)
    }
  }
  const out = lines.join('\n') + '\n'
  const outPath = path.join(clientDir, 'src/abi/addresses.ts')
  fs.writeFileSync(outPath, out)
  console.log(success(`  Wrote ${dim(outPath)} (Network ${networkId} → ${chainKey})`))
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

export function buildServiceList(nodeType, config) {
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
        networkId: config.networkId,
      },
    })
  }

  if (RUNS_VALIDATOR) {
    services.push({
      service: 'Validator',
      config: {
        l2RpcUrl: '${L2_RPC_URL}',
        validatorId: config.validatorId,
        // 30s default — see ValidatorService liveSettings comment. Optimistic
        // UI hides the validator's poll cadence from end users, so the only
        // cost of a slower poll is "more actions batched per submission",
        // which is what we want for gas efficiency and Infura credit burn.
        checkInterval: config.checkInterval || 30000
      }
    })
  }

  if (RUNS_INDEXER) {
    // Read l2DeployBlock from solidity/.deploy-state.json so RawEventsGatherer
    // backfills from the right L2 block on a fresh DB. Without this, the
    // gatherer falls back to "current head" and silently misses every
    // historical event for this Network.
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

  // Append Prisma pool params if the operator-supplied URL doesn't already
  // carry them. Default connection_limit (num_physical_cpus * 2 + 1, usually
  // 9 on a 4-core box) is too low for this app — one process runs the API,
  // validator, indexer, watchers, and the action processor concurrently.
  // 20 was the original floor and proved insufficient on test.caw.social
  // (P2024 cascades during bursts when an action handler's parent tx +
  // a notification call held two slots each). Bumped to 40 with a 30s
  // pool_timeout to give transactions room to breathe under load. Postgres
  // default max_connections=100, so this leaves headroom for psql /
  // backups / a second app on the same DB.
  const baseDbUrl = config.dbUrl || 'postgresql://postgres:postgres@127.0.0.1:5432/caw'
  env.DATABASE_URL = baseDbUrl.includes('connection_limit=') || baseDbUrl.includes('pool_timeout=')
    ? baseDbUrl
    : `${baseDbUrl}${baseDbUrl.includes('?') ? '&' : '?'}connection_limit=40&pool_timeout=30`
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
  // ZK sig-only path. The validator hot-path checks this on every batch;
  // when the cache is empty (no proof worker wired yet), it falls through
  // to the sig path, so writing this is safe even on hosts that can't
  // actually run a prover. See docs/ZK_SIG_PATH.md.
  if (config.zkProverEnabled) env.ZK_PROVER_ENABLED = '1'
  // Bootstrap admin profile tokenId(s) — the backend's ADMIN_TOKEN_IDS env
  // list grants ADMIN to these accounts before any DB role is set. Replaces
  // the old ADMIN_PASSWORD (admin auth is wallet/token-based now).
  if (config.adminTokenIds) env.ADMIN_TOKEN_IDS = config.adminTokenIds

  // Giphy API key for the /api/giphy proxy that backs the GIF picker. No
  // VITE_ prefix — server-side only. When unset, /api/giphy returns 500
  // and the picker shows an error to the user; the rest of the app is
  // unaffected.
  if (config.giphyApiKey) env.GIPHY_API_KEY = config.giphyApiKey

  // X (Twitter) OAuth 2.0 credentials for the /api/verify/x flow that
  // links a CAW profile to an X handle and pulls a bucketed follower
  // count for the verified-account badge. Server-side only (no VITE_
  // prefix). Unset = Connect X button errors at start; rest of the app
  // is unaffected. The OAuth callback URL is derived at request time
  // from INSTANCE_API_URL — there's no separate redirect-URL env var.
  if (config.xOAuthClientId)     env.X_OAUTH_CLIENT_ID     = config.xOAuthClientId
  if (config.xOAuthClientSecret) env.X_OAUTH_CLIENT_SECRET = config.xOAuthClientSecret

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
  // name is auto-derived from domain/networkId in collectSignozEndpoint so
  // multiple CAW instances sharing one collector don't collide as one
  // merged "caw-backend" entry in the SigNoz UI.
  if (config.signozEndpoint) env.OTEL_EXPORTER_OTLP_ENDPOINT = config.signozEndpoint
  if (config.otelServiceName) env.OTEL_SERVICE_NAME = config.otelServiceName

  // NETWORK_ID is the same value the frontend reads as VITE_NETWORK_ID — the
  // duplication exists only because Vite requires the VITE_ prefix to expose
  // a var to the browser bundle. Backend services (RawEventsGatherer,
  // DmRelayService, DataCleaner, InstanceRegistryService) read NETWORK_ID
  // directly. Without it, they silently fall back to networkId=1, which is
  // wrong for any install serving a different Network.
  if (config.networkId) env.NETWORK_ID = String(config.networkId)

  // Replication is optional. REPLICATION_RPC + REPLICATION_CHAIN enable the
  // optimistic-archive loop in ValidatorService; REPLICATOR_PRIVATE_KEY is
  // only set when the operator chose a separate replicator key (otherwise
  // the service falls back to the validator key).
  if (config.replicationRpcUrl) env.REPLICATION_RPC = config.replicationRpcUrl
  if (config.replicationChain) env.REPLICATION_CHAIN = config.replicationChain
  if (config.replicatorPrivateKey) env.REPLICATOR_PRIVATE_KEY = config.replicatorPrivateKey

  // REPLICATE_NETWORK_IDS defaults to this install's own networkId — the common
  // case is "I run a node for Network N, so I replicate N." When replication
  // is enabled, prefer the operator's explicit answer (which may list
  // multiple); otherwise mirror NETWORK_ID so the var isn't missing. Skip
  // entirely when replication is off — writing it would be misleading.
  if (config.replicationRpcUrl) {
    env.REPLICATE_NETWORK_IDS = config.replicateNetworkIds || String(config.networkId || 1)
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

  // BIND_HOST controls which interface the API listens on. server.ts
  // defaults to 127.0.0.1 when this is unset; we make the choice
  // explicit per nodeType so the .env documents the decision.
  // - api-only: operator deliberately runs the API as a sibling box
  //   for one or more frontend-only nodes; needs to be reachable
  //   from those peers, so 0.0.0.0. They should put nginx + auth in
  //   front of it (same as the frontend-api node would).
  // - everything else: nginx on the same host fronts the API; the
  //   socket has no business being externally reachable. Closing it
  //   off prevents the bypass-nginx-and-hit-port-4000 footgun.
  env.BIND_HOST = nodeType === 'api-only' ? '0.0.0.0' : '127.0.0.1'

  // ALLOWED_ORIGINS lets the originGate middleware accept cross-origin
  // requests. In production the frontend and API share the same hostname via
  // nginx, so same-origin requests pass without this var. In dev the Vite
  // dev server runs on :5274 and the API on :4000 — different origins —
  // so we set it explicitly to avoid a wall of CORS errors on first run.
  if (config.deployment === 'dev') {
    env.ALLOWED_ORIGINS = 'http://localhost:5274'
  }

  // Sponsor signups. The server fails at boot with a clear error when
  // SPONSOR_ENABLED=1 but SPONSOR_CODE_HMAC_SECRET is missing, so we
  // only write these together.
  if (config.sponsorEnabled) {
    env.SPONSOR_ENABLED = '1'
    env.SPONSOR_CODE_HMAC_SECRET = config.sponsorCodeHmacSecret
    if (config.sponsorWalletPrivateKey) {
      env.SPONSOR_WALLET_PRIVATE_KEY = config.sponsorWalletPrivateKey
    }
    // Deposit env vars are read as WEI by SponsorService (BigInt(raw)), but the
    // CLI collects WHOLE CAW for legibility. Scale here: whole CAW × 1e18.
    if (config.sponsorMaxDepositCaw) {
      env.SPONSOR_MAX_DEPOSIT_CAW = (BigInt(config.sponsorMaxDepositCaw) * 10n ** 18n).toString()
    }
    if (config.sponsorDefaultDepositCaw) {
      const defaultWei = (BigInt(config.sponsorDefaultDepositCaw) * 10n ** 18n).toString()
      env.SPONSOR_DEFAULT_DEPOSIT_CAW = defaultWei
      // FE reads this (wei) to seed the onboarding deposit slider's initial value.
      env.VITE_SPONSOR_DEFAULT_DEPOSIT_CAW = defaultWei
    }
  }

  // Moonpay backend secret key. Only needed (and only written) for
  // production mode — it signs the URLs that Moonpay validates. Leaving it
  // out of sandbox installs means one fewer sensitive var in the .env.
  if (config.moonpayMode === 'production' && config.moonpaySecretKey) {
    env.MOONPAY_SECRET_KEY = config.moonpaySecretKey
  }

  // Stripe card checkout — backend secret + webhook signing secret. The
  // route 503s when STRIPE_SECRET_KEY is unset, so writing these is what
  // turns the flow on. Publishable key goes in the FE .env (below).
  if (config.stripeEnabled && config.stripeSecretKey) {
    env.STRIPE_SECRET_KEY = config.stripeSecretKey
    if (config.stripeWebhookSecret) env.STRIPE_WEBHOOK_SECRET = config.stripeWebhookSecret
  }

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

  env.VITE_NETWORK_ID = String(config.networkId || 1)

  // Frontend RPC URLs. By default we write NEITHER VITE_L1_RPC_URL nor
  // VITE_L2_RPC_URL — the browser bundle talks to the backend's same-origin
  // RPC proxy (/api/rpc/l1, /api/rpc/l2; Web3Provider.tsx falls through to it
  // when these vars are unset). That keeps the Infura key out of the bundle
  // and folds all browsers' identical reads into ~1× upstream fan-out.
  //
  // Writing the backend URL here (the old behavior) baked the RPC endpoint
  // into the public bundle AND made the FE prefer it over the proxy, which
  // defeated the proxy's caching + origin gate. We only emit a VITE var when
  // the operator has EXPLICITLY supplied a separate frontend URL (rare;
  // origin-locked browser key, or a static-host FE with no backend). The
  // interactive installer no longer asks — `l*RpcUrlHttpFrontend` is empty
  // unless preloaded via CAW_L*_RPC_URL_FRONTEND. Never write a *_SECRET
  // into VITE_* — those would land in the public bundle.
  if (config.l1RpcUrlHttpFrontend) env.VITE_L1_RPC_URL = config.l1RpcUrlHttpFrontend
  if (config.l2RpcUrlHttpFrontend) env.VITE_L2_RPC_URL = config.l2RpcUrlHttpFrontend

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

  // Moonpay card-payment onramp. Both vars are publishable — they ship in
  // the public bundle. When disabled (or not collected because this is an
  // api-only node), we write nothing and the FE auto-hides the button.
  if (config.moonpayMode && config.moonpayMode !== 'disabled' && config.moonpayApiKey) {
    env.VITE_MOONPAY_API_KEY = config.moonpayApiKey
    env.VITE_MOONPAY_BASE_URL = config.moonpayBaseUrl
  }

  // Stripe publishable key — shipped in the public bundle (that's its job;
  // pk_ keys are safe to expose). The FE gates the card-checkout entry on
  // VITE_STRIPE_PUBLISHABLE_KEY being set.
  if (config.stripeEnabled && config.stripePublishableKey) {
    env.VITE_STRIPE_PUBLISHABLE_KEY = config.stripePublishableKey
  }

  return env
}

/**
 * Read the freshly written FE .env back from disk and confirm the values
 * Vite cares most about are actually present and parseable. Disk is the
 * source of truth here — we deliberately don't trust the in-memory object,
 * because the failure mode this guard exists to catch is "the file on disk
 * doesn't match what we think we wrote" (filesystem error, permissions,
 * an earlier-aborted run leaving a stale file, etc.).
 *
 * VITE_NETWORK_ID is the killer: when missing, the FE bundle initializes
 * `NETWORK_ID = NaN`, which silently propagates into every wagmi
 * `args: [NETWORK_ID, ...]` call and surfaces as the cryptic runtime
 * `RangeError: NaN can't be converted to BigInt`. Catch it here so the
 * operator gets a clear error at install time.
 */
/**
 * Validate a networkId env value. CawNetworkManager stores networkId as a
 * uint32 on chain, so anything outside [1, 0xffffffff] is wrong. Catches:
 *   - empty / missing
 *   - non-numeric strings (NaN)
 *   - zero / negative
 *   - quoted Ethereum address (Number('0xabc...') yields ~1.2e+48, which
 *     passes Number.isInteger but exceeds uint32)
 * Returns { ok: true, value } | { ok: false, reason }.
 */
function validateNetworkId(raw) {
  if (raw === undefined || raw === '') {
    return { ok: false, reason: 'missing or empty' }
  }
  const n = Number(raw)
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return { ok: false, reason: `not an integer (got ${JSON.stringify(raw)})` }
  }
  if (n <= 0) {
    return { ok: false, reason: `must be > 0 (got ${n})` }
  }
  if (n > 0xffffffff) {
    return {
      ok: false,
      reason: `exceeds uint32 max — looks like a wallet address was pasted in by mistake (got ${JSON.stringify(raw)})`,
    }
  }
  return { ok: true, value: n }
}

function parseDotenv(text) {
  const parsed = {}
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m) parsed[m[1]] = m[2]
  }
  return parsed
}

/**
 * Read the .env files we just wrote back from disk and re-validate the
 * critical networkId values, since a bogus write leaves operators chasing
 * symptoms ("NaN can't be converted to BigInt" / empty peer registry /
 * 'Sigs length mismatch' on chain) instead of fixing the root cause.
 *
 * Disk is the source of truth here — we deliberately don't trust the
 * in-memory object, because the failure mode this guard exists to catch
 * is "the file on disk doesn't match what we think we wrote" (filesystem
 * error, permissions, an earlier-aborted run leaving a stale file, etc.).
 *
 * VITE_NETWORK_ID is the killer: when missing, the FE bundle initializes
 * `NETWORK_ID = NaN`, which silently propagates into every wagmi
 * `args: [NETWORK_ID, ...]` call and surfaces as the cryptic runtime
 * `RangeError: NaN can't be converted to BigInt`. Catch it here so the
 * operator gets a clear error at install time.
 */
function verifyFrontendEnv(frontendEnvPath) {
  const parsed = parseDotenv(fs.readFileSync(frontendEnvPath, 'utf8'))
  const check = validateNetworkId(parsed.VITE_NETWORK_ID)
  if (!check.ok) {
    throw new Error(
      `VITE_NETWORK_ID is invalid in ${frontendEnvPath}: ${check.reason}.\n` +
      `  This will cause the frontend to throw "NaN can't be converted to BigInt" on every contract call,\n` +
      `  or to query the wrong Network's data on chain.\n` +
      `  Re-run the install (node cli/bin/caw.js install --dir <install-dir>) and pick a Network at the prompt,\n` +
      `  or set VITE_NETWORK_ID=<positive integer ≤ 4294967295> in that .env by hand and restart vite.`
    )
  }
  console.log(success(`  Verified ${dim('VITE_NETWORK_ID=' + check.value)}`))
}

/**
 * Parallel guard for the backend .env. NETWORK_ID is read at runtime by
 * InstanceRegistryService, DmRelayService, DataCleaner, etc. A wallet
 * address sneaking in here causes /api/instances to return networkId of
 * ~1.2e+48 and an empty peer cache, with no other obvious symptom.
 */
function verifyBackendEnv(envPath) {
  const parsed = parseDotenv(fs.readFileSync(envPath, 'utf8'))
  const check = validateNetworkId(parsed.NETWORK_ID)
  if (!check.ok) {
    throw new Error(
      `NETWORK_ID is invalid in ${envPath}: ${check.reason}.\n` +
      `  The backend uses this to scope peer discovery, replication, and DM relay.\n` +
      `  Re-run the install and pick a Network at the prompt, or set NETWORK_ID=<positive integer ≤ 4294967295> by hand.`
    )
  }
  console.log(success(`  Verified ${dim('NETWORK_ID=' + check.value)}`))
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
      // dotenv-preload first so process.env is populated before any other
      // require() runs. Has to be -r, not a top-of-start.ts line, because
      // TypeScript hoists `import` statements above sibling `require()`
      // calls — leaving Sentry / OTel / etc. seeing an unpopulated env.
      args: '-r ./dotenv-preload.js -r ./file-polyfill.js -r tsx/cjs programs/start.ts',
      // PORT is referenced by the install-side port scan and is the single
      // source of truth for which port this install's API listens on.
      // config.json's Api.port should match (we set both from config.apiPort).
      env: { NODE_ENV: 'production', PORT: String(apiPort) },
      // 2G headroom: the single-process app runs the API + validator +
      // indexer + watchers in one Node, and the StakeLedger / Action /
      // CountManager in-memory caches legitimately sit around 1.2-1.5GB
      // on a populated testnet. 1G was too tight — observed a 333-restart
      // PM2 loop on test.caw.social 2026-05-12 when steady-state crossed
      // 1G and PM2 SIGINT'd the process every ~2 min, causing cascading
      // Prisma pool-exhaustion 500s from the constant cold-restarts.
      max_memory_restart: '2G',
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
