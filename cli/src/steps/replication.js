import inquirer from 'inquirer'
import crypto from 'crypto'
import { section, dim, tipBlock, brand, success, warn, err } from '../utils/ui.js'

// Replication chain options. Each entry maps to one archive chain that
// CawActionsArchive has been deployed to. We pick by network so operators
// see only the chains that exist for their chosen environment.
//
// Canonical pairing: a Network whose storage is Base typically replicates
// to Arbitrum (and vice-versa) — pick the L2 where you already have an ETH
// balance. The CLI surfaces this as a "(recommended for X storage)" hint
// when the operator has told us which storage chain their target Network
// uses.
const REPLICATION_CHAINS = {
  testnet: [
    {
      key: 'arbitrum-sepolia',
      label: 'Arbitrum Sepolia',
      hint: 'cheap L2 — recommended if your Network stores on Base Sepolia',
      pairsWith: ['base-sepolia', 'sepolia'],
    },
    {
      key: 'base-sepolia',
      label: 'Base Sepolia',
      hint: 'cheap L2 — recommended if your Network stores on Arbitrum Sepolia',
      pairsWith: ['arbitrum-sepolia', 'sepolia'],
    },
    // Future: optimism-sepolia, polygon-amoy, etc. Add as deployments land.
  ],
  mainnet: [
    {
      key: 'arbitrum',
      label: 'Arbitrum One',
      hint: 'cheap L2 — recommended if your Network stores on Base',
      pairsWith: ['base', 'ethereum'],
    },
    {
      key: 'base',
      label: 'Base',
      hint: 'cheap L2 — recommended if your Network stores on Arbitrum',
      pairsWith: ['arbitrum', 'ethereum'],
    },
    // Future entries gated on actually-deployed contracts. Don't list a chain
    // here unless CawActionsArchive is live on it.
  ],
}

/**
 * Optional replication participation. Replication is the optimistic-archive
 * fraud-detection layer: validators that opt in commit a hash of each batch
 * to an archive chain and watch for incorrect submissions from peers,
 * winning slashing rewards if they catch fraud.
 *
 * Each Network picks its own replication destinations on-chain (via
 * CawNetworkManager.addReplication). The validator just needs (a) an RPC for
 * one of those chains and (b) a key with ETH on that chain to submit batch
 * hashes and challenges.
 *
 * Env vars produced:
 *   REPLICATION_RPC        — RPC URL for the chosen archive chain
 *   REPLICATION_CHAIN      — short key identifying which chain (e.g.
 *                            "arbitrum-sepolia"); ValidatorService picks
 *                            the contract address by this key.
 *   REPLICATOR_PRIVATE_KEY — separate key for the submitter wallet. When
 *                            unset, ValidatorService falls back to the main
 *                            validator key. We recommend separate keys so a
 *                            compromise of one is contained.
 *   REPLICATE_NETWORK_IDS  — comma-separated list of Network IDs this validator
 *                            replicates (e.g. "1" or "1,3"). Per-validator
 *                            config; the chain has no on-chain replication
 *                            registry anymore.
 *
 * Skipped when nodeType isn't full or validator.
 */
export async function collectReplicationConfig(nodeType, ctx = {}) {
  if (!['full', 'validator'].includes(nodeType)) return {}

  section('Replication (optional)')

  tipBlock([
    `${brand('What is replication?')}`,
    'CAW archives every batch of actions to a separate chain (today: Arbitrum',
    'Sepolia for testnet, Arbitrum mainnet for prod). Validators that opt in',
    'commit a hash of each batch and watch for incorrect submissions from',
    'peers. If you catch a peer committing fraud, you slash their stake and',
    'collect the reward.',
    '',
    `${brand('What does it cost?')}`,
    '  • An ETH balance on the archive chain to pay tx fees on every',
    '    submission. Costs scale with the volume of actions you replicate.',
    '  • A bit of validator runtime (one extra background loop)',
    '',
    `${brand('Should I enable it?')}`,
    '  Optional. The protocol works either way. Enabling improves the network\'s',
    '  fraud-detection coverage and may earn you slashing rewards.',
  ])

  // --env preload: presence of CAW_REPLICATION_RPC implies the previous
  // install opted in, so skip the participate question and pre-fill every
  // downstream prompt that has a recognized value. Sensitive bits (the
  // replicator key) still re-prompt — same pattern as the validator key.
  const preloadRpc = process.env.CAW_REPLICATION_RPC || ''
  const preloadChain = process.env.CAW_REPLICATION_CHAIN || ''
  const preloadNetworkIds = process.env.CAW_REPLICATE_NETWORK_IDS || ''
  const preloaded = preloadRpc || preloadChain || preloadNetworkIds

  let participate
  if (preloaded) {
    console.log(dim('  Replication settings found in --env preload — keeping participation on.'))
    participate = true
  } else {
    const ans = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'participate',
        message: 'Participate in replication?',
        default: false,
      },
    ])
    participate = ans.participate
  }

  if (!participate) {
    console.log(dim('  Skipping replication setup — you can enable it later by setting'))
    console.log(dim('  REPLICATION_RPC, REPLICATION_CHAIN, REPLICATE_NETWORK_IDS, and'))
    console.log(dim('  (optionally) REPLICATOR_PRIVATE_KEY in client/.env.'))
    return {}
  }

  // ---- Archive chain selection ----
  const network = ctx.network || 'testnet'
  const allChains = REPLICATION_CHAINS[network] || []
  if (allChains.length === 0) {
    console.log(warn(`  No replication chains are deployed yet for ${network}.`))
    return {}
  }

  // Filter out the operator's storage chain — replicating to the same
  // chain you store on defeats the purpose (the archive must live on a
  // *different* chain so a single chain failure doesn't take both copies
  // out at once). Also defends against the matching `addReplication`
  // contract revert.
  const storageChainKey = ctx.storageChainKey || ''
  const chains = allChains.filter(c => c.key !== storageChainKey)

  if (chains.length === 0) {
    console.log(warn(`  No replication chains available besides your storage chain (${storageChainKey}) — skipping.`))
    return {}
  }

  let replicationChain
  // Preload from --env: if the previous .env named a chain we still
  // support, skip the picker.
  const preloadedChainEntry = preloadChain && chains.find(c => c.key === preloadChain)
  if (preloadedChainEntry) {
    replicationChain = preloadedChainEntry.key
    console.log()
    console.log(dim(`  Using ${brand(preloadedChainEntry.label)} (from --env preload).`))
  } else if (chains.length === 1) {
    // Single-chain shortcut: with two L2s deployed today (Base + Arbitrum),
    // a client storing on one L2 has exactly one valid archive choice — the
    // other. Skip the picker; the operator's only meaningful input here is
    // the RPC URL for that chain (asked next).
    replicationChain = chains[0].key
    console.log()
    console.log(dim(`  Auto-selected ${brand(chains[0].label)} as the archive chain.`))
    console.log(dim(`  (Your client stores on ${storageChainKey || 'L1'}; replicating to a different L2`))
    console.log(dim(`   so a single-chain failure can't take both copies out at once.)`))
  } else {
    // Multi-chain picker. Today this only fires when storage is L1
    // (sepolia / ethereum) — both L2s are valid archive targets. Once a
    // third L2 lands in REPLICATION_CHAINS, L2-storage clients will land
    // here too and the recommendation logic below picks the partner.
    const recommendedKey = chains.find(c => c.pairsWith?.includes(storageChainKey))?.key
      || chains[0].key

    console.log()
    tipBlock([
      'Pick the chain you want to replicate to. The canonical pairing is',
      `${brand('Base ↔ Arbitrum')} — clients on one typically replicate to the other`,
      'so the validator only needs ETH on two L2s instead of three.',
      '',
      'You can pick any chain you have ETH on; the protocol doesn\'t care.',
    ])

    const answer = await inquirer.prompt([
      {
        type: 'list',
        name: 'chainKey',
        message: 'Replication chain:',
        choices: chains.map(c => {
          const tag = c.key === recommendedKey ? brand(' (recommended)') : ''
          return {
            value: c.key,
            name: `${brand(c.label)}${tag} ${dim('— ' + c.hint)}`,
          }
        }),
        default: recommendedKey,
      },
    ])
    replicationChain = answer.chainKey
  }
  const chosenChain = chains.find(c => c.key === replicationChain)

  console.log()
  tipBlock([
    `Replication chain: ${brand(chosenChain.label)}`,
    'You need an HTTP RPC URL for this chain. Free tiers from Infura,',
    'Alchemy, or QuickNode all work.',
  ])

  // Map replication chain key → EVM chain ID so we can verify the operator
  // pasted the right URL (vs. an Ethereum / wrong-L2 URL from another tab).
  const REPLICATION_CHAIN_IDS = {
    'arbitrum-sepolia': 421614,
    'base-sepolia': 84532,
    'sepolia': 11155111,
    'arbitrum': 42161,
    'base': 8453,
    'ethereum': 1,
  }
  const expectedChainId = REPLICATION_CHAIN_IDS[chosenChain.key] || null

  let replicationRpcUrl
  // Preload RPC URL only when the preloaded chain matches the one we
  // ended up using (could have been auto-picked instead of preloaded).
  if (preloadRpc && preloadedChainEntry && preloadedChainEntry.key === replicationChain) {
    replicationRpcUrl = preloadRpc
    console.log(dim(`  Using replication RPC from --env preload.`))
  }
  while (!replicationRpcUrl) {
    const ans = await inquirer.prompt([
      {
        type: 'input',
        name: 'replicationRpcUrl',
        message: `${chosenChain.label} HTTP RPC URL:`,
        validate: (input) => {
          if (!input.trim()) return 'Required'
          if (!/^https?:\/\//.test(input)) return 'Must start with http:// or https://'
          return true
        },
      },
    ])
    replicationRpcUrl = ans.replicationRpcUrl
    if (!expectedChainId) break

    const actual = await probeReplicationChainId(replicationRpcUrl.trim())
    if (actual === null) {
      console.log(dim(`  (Couldn't verify chain ID via eth_chainId — RPC may be temporarily unreachable.)`))
      break
    }
    if (actual === expectedChainId) {
      console.log(dim(`  ✓ Chain ID ${actual} matches ${chosenChain.label}.`))
      break
    }
    console.log()
    console.log(warn(`  Chain mismatch: that URL responded with chainId ${actual}.`))
    console.log(warn(`  Expected ${brand(chosenChain.label)} (chainId ${expectedChainId}) for replication.`))
    console.log()
    const { reenter } = await inquirer.prompt([{
      type: 'confirm',
      name: 'reenter',
      message: `Re-enter the ${chosenChain.label} URL?`,
      default: true,
    }])
    if (!reenter) break
  }

  // ---- Which Networks to replicate ----
  let replicateNetworkIds
  if (preloadNetworkIds) {
    replicateNetworkIds = preloadNetworkIds
    console.log(dim(`  Using replicate Network IDs from --env preload: ${preloadNetworkIds}`))
  } else {
    console.log()
    tipBlock([
      `${brand('Which Networks do you replicate?')}`,
      'Replication is per-validator: you decide which Networks\' actions you',
      'archive. Most operators replicate the Network they run a node for.',
      'Multiple comma-separated IDs are fine if you replicate for several.',
    ])
    const ans = await inquirer.prompt([
      {
        type: 'input',
        name: 'replicateNetworkIds',
        message: 'Network IDs to replicate (comma-separated):',
        default: ctx.networkId ? String(ctx.networkId) : '1',
        validate: (input) => {
          const ids = input.split(',').map(s => s.trim()).filter(Boolean)
          if (ids.length === 0) return 'At least one Network ID required'
          for (const id of ids) {
            if (!/^\d+$/.test(id) || Number(id) <= 0) return `Invalid Network ID: ${id}`
          }
          return true
        },
      },
    ])
    replicateNetworkIds = ans.replicateNetworkIds
  }

  // ---- Replicator key ----
  // --env preload: same logic as the validator key. If the previous .env
  // already has REPLICATOR_PRIVATE_KEY, reuse it — the value is on disk
  // either way, re-prompting just makes the operator paste back the same
  // hex they already had (or worse, silently rotate by generating a new
  // one and stranding the old key).
  let replicatorPrivateKey
  const preloadReplicatorKey = process.env.CAW_REPLICATOR_PRIVATE_KEY || ''
  if (preloadReplicatorKey) {
    replicatorPrivateKey = preloadReplicatorKey
    let address = '(install ethers to see)'
    try {
      const { computeAddress } = await importEthersUtils()
      address = computeAddress(replicatorPrivateKey)
    } catch {}
    console.log()
    console.log(dim(`  Loaded replicator key from --env preload (address ${address}).`))
    console.log(dim('  To rotate: clear REPLICATOR_PRIVATE_KEY from .env and re-run.'))
    return {
      replicationRpcUrl,
      replicationChain,
      replicateNetworkIds,
      replicatorPrivateKey,
      replicationEnabled: true,
    }
  }

  console.log()
  tipBlock([
    `${brand('Replicator key')}`,
    'The replicator submits batch-hash commitments to the archive chain.',
    'You can use the same key as your main validator, or a separate one.',
    '',
    `${brand('Recommendation:')} use a separate key. If either gets compromised,`,
    'the blast radius is contained — the validator key only authorizes L2',
    'submissions; a separate replicator key only authorizes archive-chain',
    'submissions.',
  ])

  const { keyChoice } = await inquirer.prompt([
    {
      type: 'list',
      name: 'keyChoice',
      message: 'Replicator key:',
      choices: [
        { value: 'separate-generate', name: `${brand('Generate a new replicator key')} ${dim('(recommended)')}` },
        { value: 'separate-import', name: 'Import an existing replicator private key' },
        { value: 'reuse', name: `${brand('Reuse the validator key')} ${dim('(simpler, less isolation)')}` },
      ],
      default: 'separate-generate',
    },
  ])

  if (keyChoice === 'reuse') {
    // Don't write REPLICATOR_PRIVATE_KEY at all — ValidatorService falls
    // back to the validator key when the var is missing. Cleaner than
    // duplicating the validator key into REPLICATOR_PRIVATE_KEY.
    replicatorPrivateKey = undefined
    console.log(dim('  ✓ Replicator will reuse the validator key.'))
  } else if (keyChoice === 'separate-generate') {
    replicatorPrivateKey = '0x' + crypto.randomBytes(32).toString('hex')
    const { computeAddress } = await importEthersUtils()
    const address = computeAddress(replicatorPrivateKey)

    // Same opt-in pattern as the validator key: address is safe to print
    // (you have to fund it); the secret key is only shown if the operator
    // explicitly asks for it. It always lives in client/.env regardless.
    console.log()
    console.log(success('  New replicator key generated!'))
    console.log()
    console.log(brand('  Address: ') + address)
    console.log(err.bold(`  Fund ${address} with ETH on ${chosenChain.label} — pays gas for batch submissions and challenges.`))
    console.log(dim('  Quick way: bridge a small amount via https://gas.zip → paste the address above.'))
    console.log()

    const { showKey } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'showKey',
        message: 'Print the private key now so you can back it up?',
        default: false,
      },
    ])
    if (showKey) {
      console.log()
      console.log(warn('  Private key: ') + dim(replicatorPrivateKey))
      console.log(err.bold('  IMPORTANT: Copy this somewhere safe. It cannot be recovered.'))
      console.log(dim('  (Also lives at client/.env on this server — readable only by the caw user.)'))
      console.log()
      await inquirer.prompt([{ type: 'confirm', name: 'ok', message: 'Saved? Continue.', default: true }])
    } else {
      console.log(dim('  Skipped. The key is in client/.env if you need it later.'))
    }
  } else {
    const { importedKey } = await inquirer.prompt([
      {
        type: 'password',
        name: 'importedKey',
        message: 'Replicator private key (hex, with or without 0x prefix):',
        mask: '*',
        validate: (input) => {
          const hex = input.startsWith('0x') ? input.slice(2) : input
          return /^[0-9a-fA-F]{64}$/.test(hex) ? true : 'Invalid private key (must be 64 hex chars)'
        },
      },
    ])
    replicatorPrivateKey = importedKey.startsWith('0x') ? importedKey : '0x' + importedKey
  }

  return {
    replicationRpcUrl,
    replicationChain,
    replicateNetworkIds,
    replicatorPrivateKey,
    replicationEnabled: true,
  }
}

async function importEthersUtils() {
  try {
    const ethers = await import('ethers')
    return { computeAddress: ethers.computeAddress }
  } catch {
    return { computeAddress: () => '(install ethers to see address)' }
  }
}

// Probe an RPC URL with eth_chainId. Mirrors the helper in rpcUrls.js —
// duplicated here rather than imported to keep the steps independent.
// Returns the decimal chain ID, or null on any failure (timeout, malformed
// response, network error). Caller treats null as "couldn't verify".
async function probeReplicationChainId(url, timeoutMs = 4000) {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeoutMs)
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      signal: ctrl.signal,
    })
    clearTimeout(t)
    if (!res.ok) return null
    const data = await res.json()
    if (typeof data?.result !== 'string') return null
    return parseInt(data.result, 16)
  } catch {
    return null
  }
}
