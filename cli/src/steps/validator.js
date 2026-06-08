import inquirer from 'inquirer'
import crypto from 'crypto'
import { section, dim, tipBlock, brand, success, warn, err } from '../utils/ui.js'
import { addr } from '../addresses.js'

// Just enough ABI to look up token IDs and owners.
const MINTER_ABI = [
  'function idByUsername(string) view returns (uint32)',
]
const PROFILE_ABI = [
  'function ownerOf(uint256) view returns (address)',
]

export async function collectValidatorConfig(nodeType, installDir, ctx = {}) {
  if (!['full', 'validator'].includes(nodeType)) return {}

  section('Validator Configuration')

  // --env preload: three states.
  //
  //   1. Key + ID both present → skip every prompt. Values are already
  //      on disk; re-asking just makes the operator type them again
  //      (or worse, silently rotate the key by re-typing).
  //   2. Key present but ID missing → keep the preloaded key (don't
  //      re-prompt; the key is sensitive and the operator already
  //      committed it once), but do the username→tokenId lookup so
  //      we can populate ID + username.
  //   3. Neither → full flow.
  //
  // Username alone (key missing) doesn't get its own skip path; we'd
  // still need to ask for the key, and at that point we may as well
  // re-confirm the identity in the same flow.
  const preloadKey = process.env.CAW_VALIDATOR_PRIVATE_KEY || ''
  const preloadId = process.env.CAW_VALIDATOR_ID || ''
  const preloadUsername = process.env.CAW_VALIDATOR_USERNAME || ''
  if (preloadKey && preloadId) {
    console.log(dim(`  Loaded validator key + identity from --env preload (validatorId ${preloadId}${preloadUsername ? `, @${preloadUsername}` : ''}).`))
    console.log(dim('  To rotate: clear VALIDATOR_PRIVATE_KEY / VALIDATOR_ID from .env and re-run.'))
    return {
      validatorPrivateKey: preloadKey,
      validatorId: Number(preloadId),
      validatorUsername: preloadUsername,
      checkInterval: Number(process.env.CAW_TX_POLL_INTERVAL) || 3000,
    }
  }
  if (preloadKey && !preloadId) {
    console.log(dim('  Validator private key loaded from --env preload — keeping it.'))
    console.log(dim('  Just need the validator username so we can resolve its token ID on-chain.'))
    console.log()
    const { validatorId, validatorUsername } = await resolveValidatorByUsername(ctx)
    return {
      validatorPrivateKey: preloadKey,
      validatorId,
      validatorUsername,
      checkInterval: Number(process.env.CAW_TX_POLL_INTERVAL) || 3000,
    }
  }

  tipBlock([
    'The validator needs a private key to sign and submit transactions on L2.',
    'This key will hold ETH on Base (for gas fees) and be used to submit',
    'batched user actions on-chain. Validator tips are paid to the validator',
    'username (asked next) — whichever wallet owns that username can withdraw',
    'them. This signing key only pays gas; it does not receive tips.',
    '',
    'Options:',
    '  1. Generate a new key (recommended for fresh installs)',
    '  2. Import an existing private key (hex format)',
  ])

  // Defensive: drain stdin before this list prompt fires. Without this,
  // the Enter the operator pressed at the previous prompt (Eth Mainnet
  // RPC URL) can bleed through into the list prompt and immediately
  // confirm the highlighted choice — picking "Generate" before they
  // could see the menu. setImmediate after a small delay gives the
  // keypress event loop time to process the buffered Enter before
  // inquirer attaches its readline handler.
  await new Promise(resolve => setTimeout(resolve, 50))

  const { keySource } = await inquirer.prompt([
    {
      type: 'list',
      name: 'keySource',
      message: 'Validator private key:',
      choices: [
        { value: 'generate', name: `${brand('Generate new key')} ${dim('(recommended)')}` },
        { value: 'import', name: 'Import existing private key' },
      ],
    },
  ])

  let privateKey

  if (keySource === 'generate') {
    privateKey = '0x' + crypto.randomBytes(32).toString('hex')
    const { computeAddress } = await importEthersUtils()
    const address = computeAddress(privateKey)

    // The address is safe to print always — that's how you fund the key.
    // The private key is shown only if the operator explicitly asks. The
    // key always lives in client/.env (chmod 600, owned by caw), so a
    // power-user who wants to back it up can read it from there later.
    console.log()
    console.log(success('  New validator key generated!'))
    console.log()
    console.log(brand('  Address: ') + address)
    console.log(err.bold(`  Fund ${address} with ETH on Base — this address pays gas for every action you submit.`))
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
      console.log(warn('  Private key: ') + dim(privateKey))
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
        message: 'Enter private key (hex, with or without 0x prefix):',
        mask: '*',
        validate: (input) => {
          const hex = input.startsWith('0x') ? input.slice(2) : input
          if (!/^[0-9a-fA-F]{64}$/.test(hex)) return 'Invalid private key (must be 64 hex characters)'
          return true
        },
      },
    ])
    privateKey = importedKey.startsWith('0x') ? importedKey : '0x' + importedKey
  }

  // ----- Validator username (and on-chain lookup of tokenId + owner) -----
  console.log()
  tipBlock([
    'Each validator is identified by a CawName username NFT.',
    '',
    `${brand('Validator tips are paid in CAW to the username itself.')}`,
    'Whoever currently owns the username NFT can withdraw the accrued tips.',
    'If you transfer the username to another wallet, the new owner withdraws',
    'future tips. The signing key above only pays gas — it never holds tips.',
    '',
    'Type the username (no @, no .caw — just the name) and we\'ll look up the',
    'token ID + current owner on-chain to confirm.',
  ])

  const { validatorId, validatorUsername } = await resolveValidatorByUsername(ctx)

  // TxQueue poll interval — operators don't have a meaningful answer to this
  // and 3000ms is correct for >99% of installs. Hardcode with an env override
  // (CAW_TX_POLL_INTERVAL) for the rare case someone genuinely needs to tune it.
  const checkInterval = Number(process.env.CAW_TX_POLL_INTERVAL) || 3000

  // Optional: ZK sig-only path. Off by default — defaulting to on-chain
  // ecrecover is the right call until the operator has either a hosted
  // prover account or a high-RAM host with the SP1 toolchain installed.
  // Even with the flag flipped on, the validator silently falls back to
  // the sig path on every batch where no proof is staged in zkProofCache;
  // i.e. ZK_PROVER_ENABLED=1 alone is harmless.
  const zkProverEnabled = await collectZkProverConfig()

  return {
    validatorPrivateKey: privateKey,
    validatorId,
    validatorUsername,
    checkInterval,
    zkProverEnabled,
  }
}

/**
 * Ask whether to enable the ZK sig-only path. Honest about the prerequisites
 * so the operator doesn't enable it expecting it to "just work":
 *  - the dormant prover worker (TODO: not wired yet)
 *  - 16+ GB RAM for local proving, OR a hosted SP1 prover endpoint
 *
 * Reads CAW_ZK_PROVER_ENABLED from --env preload to skip the prompt on
 * automated reinstalls.
 */
async function collectZkProverConfig() {
  const preload = process.env.CAW_ZK_PROVER_ENABLED
  if (preload === '1' || preload === 'true') {
    console.log(dim('  ZK prover enabled via --env preload (CAW_ZK_PROVER_ENABLED=1).'))
    return true
  }
  if (preload === '0' || preload === 'false') {
    console.log(dim('  ZK prover disabled via --env preload (CAW_ZK_PROVER_ENABLED=0).'))
    return false
  }

  console.log()
  tipBlock([
    `${brand('ZK sig-only path (optional, advanced).')}`,
    '',
    'Replaces per-action ecrecover with one Groth16 verifier call (~265K gas)',
    'on-chain. Cheaper for batches of ~70+ actions; MORE expensive below that.',
    'Cawonce conflicts in the ZK path skip the affected slots rather than',
    'reverting the whole batch.',
    '',
    `${warn('At current prod batch sizes (n=20-30) the ZK path COSTS MORE')}`,
    `${warn('— roughly +25% over the sig path. ZK only pays off if you can')}`,
    `${warn('sustainably batch well above 70 actions per tx.')}`,
    '',
    `${warn('What you need before this is useful:')}`,
    '  • A wired-up proof generator. The validator reads from a proof cache;',
    '    a worker that fills the cache is not yet implemented (see',
    '    docs/ZK_SIG_PATH.md).',
    '  • Local proving needs ~16 GB RAM during the wrap stage. A 5.9 GB VPS',
    '    will OOM-kill itself.',
    '  • Hosted proving (SP1\'s prover network, ~10s/proof) is the realistic',
    '    path for low-RAM hosts; needs an account.',
    '',
    `${dim('Setting ZK_PROVER_ENABLED=1 alone is harmless — without proofs in')}`,
    `${dim('the cache, every batch falls through to the sig path.')}`,
  ])

  const { enabled } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'enabled',
      message: 'Enable the ZK sig-only path? (sets ZK_PROVER_ENABLED=1)',
      default: false,
    },
  ])
  return enabled
}

/**
 * Ask the operator how they want to identify their validator (by username
 * with on-chain lookup, or by token ID directly), then collect + verify.
 * Using a separate menu prompt avoids the username/sentinel collision
 * problem — usernames are `[a-z0-9]+` on-chain so any sentinel string we
 * picked could in principle collide with a real username.
 */
// Embed an Infura-style API Key Secret as Basic Auth in the RPC URL, the
// same way the backend's makeJsonRpcProvider does (see
// client/src/utils/rpcProvider.ts withSecret). Produces
// `https://:SECRET@host/v3/KEY`; ethers' JsonRpcProvider over HTTPS forwards
// the userinfo as a Basic Auth header automatically. Without this, a project
// with "require API key secret" enabled rejects the lookup with a 403
// ("rejected due to project ID settings"). Empty secret is a no-op.
function withSecret(url, secret) {
  if (!url || !secret) return url
  try {
    const u = new URL(url)
    if (u.username || u.password) return url // operator already set auth
    u.password = secret
    return u.toString()
  } catch {
    return url
  }
}

async function resolveValidatorByUsername(ctx) {
  const { l1RpcUrl, l1RpcSecret } = ctx
  const minter = addr('CAW_NAMES_MINTER_ADDRESS')
  const profile = addr('CAW_NAMES_ADDRESS')

  // Up-front choice: lookup vs direct entry. Default is username lookup
  // when we have an L1 RPC; falls back to direct entry otherwise.
  const lookupAvailable = !!l1RpcUrl
  const choices = [
    {
      value: 'username',
      name: lookupAvailable
        ? `${brand('By username')} ${dim('(recommended — looks up tokenId on-chain)')}`
        : `${brand('By username')} ${dim('(unavailable — no L1 RPC)')}`,
      disabled: lookupAvailable ? false : 'Provide an L1 RPC URL earlier in the install',
    },
    { value: 'tokenId', name: 'By token ID directly' },
  ]
  const { method } = await inquirer.prompt([
    {
      type: 'list',
      name: 'method',
      message: 'How do you want to identify your validator?',
      choices,
      default: lookupAvailable ? 'username' : 'tokenId',
    },
  ])

  if (method === 'tokenId') {
    const { tokenId } = await inquirer.prompt([
      {
        type: 'number',
        name: 'tokenId',
        message: 'Validator token ID:',
        validate: (input) => input > 0 ? true : 'Token ID must be a positive number',
      },
    ])
    return { validatorId: tokenId, validatorUsername: '' }
  }

  // Username lookup — loop until the operator either confirms a result or
  // bails back to the menu.
  while (true) {
    const { username } = await inquirer.prompt([
      {
        type: 'input',
        name: 'username',
        message: 'Validator username:',
        validate: (input) => {
          const v = input.trim()
          if (!v) return 'Required'
          // CawNames are 1-255 lowercase alphanumerics on-chain. We don't
          // enforce the upper bound here; let the lookup just return 0.
          if (!/^[a-z0-9]+$/.test(v)) return 'Username must be lowercase letters and numbers only'
          return true
        },
      },
    ])

    let tokenId, owner
    let provider
    try {
      const { JsonRpcProvider, Contract, Network } = await import('ethers')
      // staticNetwork stops ethers from background-polling for the chainId
      // (and from spamming "failed to detect network, retry in 1s" forever
      // when the RPC rejects us). We don't actually know the chainId here,
      // so pass `null` to disable detection entirely — the two reads below
      // don't need it, and we destroy() the provider before looping anyway.
      provider = new JsonRpcProvider(withSecret(l1RpcUrl, l1RpcSecret), undefined, {
        staticNetwork: Network.from(0),
      })
      const minterContract = new Contract(minter, MINTER_ABI, provider)
      const profileContract = new Contract(profile, PROFILE_ABI, provider)

      const id = await minterContract.idByUsername(username.trim())
      tokenId = Number(id)
      if (tokenId === 0) {
        console.log(err(`  No token found for username "${username}".`))
        console.log(dim('  Check the spelling and try again.'))
        console.log()
        continue
      }
      owner = await profileContract.ownerOf(tokenId)
    } catch (e) {
      const msg = e?.message || String(e)
      // Distinguish "RPC rejected us" (auth / allowlist) from "username not
      // found" so the operator knows it's an infra problem, not a typo.
      if (/403|forbidden|project id|api key|unauthorized|401/i.test(msg)) {
        console.log(err(`  RPC rejected the request (not a username problem):`))
        console.log(dim(`    ${msg.split('\n')[0]}`))
        console.log(dim('  Your L1 RPC key is likely missing its API Key Secret, or the project'))
        console.log(dim('  has an allowlist blocking this server.'))
        console.log()
        // The on-chain lookup can't work with this RPC, so don't trap the
        // operator re-typing usernames against a dead endpoint. Offer the
        // two real escapes: enter the token ID directly, or abort + fix RPC.
        const { recover } = await inquirer.prompt([{
          type: 'list',
          name: 'recover',
          message: 'How do you want to proceed?',
          choices: [
            { value: 'tokenId', name: 'Enter the validator token ID directly (skip the lookup)' },
            { value: 'retry', name: 'Try another username (only if you fixed the RPC elsewhere)' },
            { value: 'abort', name: 'Abort — I\'ll fix the L1 RPC key/secret and re-run' },
          ],
          default: 'tokenId',
        }])
        if (recover === 'abort') {
          console.log(dim('  Aborting install. Fix the L1 RPC, then re-run `caw install`.'))
          process.exit(0)
        }
        if (recover === 'tokenId') {
          const { tokenId: tid } = await inquirer.prompt([{
            type: 'number', name: 'tokenId', message: 'Validator token ID:',
            validate: (input) => input > 0 ? true : 'Token ID must be a positive number',
          }])
          return { validatorId: tid, validatorUsername: '' }
        }
        // recover === 'retry' falls through to the loop.
      } else {
        console.log(err(`  Lookup failed: ${msg.split('\n')[0]}`))
        console.log(dim('  Try a different username, or restart the install with a working L1 RPC.'))
      }
      console.log()
      continue
    } finally {
      // Always tear down the provider so its keep-alive / retry timers don't
      // outlive this iteration and spam the console while we re-prompt.
      try { provider?.destroy?.() } catch { /* noop */ }
    }

    console.log()
    console.log(success(`  Found ${brand(username)}:`))
    console.log(`    Token ID:        ${brand(String(tokenId))}`)
    console.log(`    Current owner:   ${brand(owner)}`)
    console.log()
    console.log(warn(`  Validator tips for this node will be paid to @${username}.`))
    console.log(dim(`  Tips accrue to the username (the NFT). Whoever owns @${username} can`))
    console.log(dim(`  withdraw them — today that's ${owner}. If you transfer the username,`))
    console.log(dim('  the new owner withdraws future tips.'))
    console.log()

    const { confirmed } = await inquirer.prompt([
      { type: 'confirm', name: 'confirmed', message: 'Use this validator identity?', default: true },
    ])
    if (confirmed) return { validatorId: tokenId, validatorUsername: username.trim() }
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
