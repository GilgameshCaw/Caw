import inquirer from 'inquirer'
import { section, dim, tipBlock, brand, success, warn, err } from '../utils/ui.js'
import { addr } from '../addresses.js'

// Just the bits of CawClientManager we use here.
const CLIENT_MANAGER_ABI = [
  'function createClient(string name, address feeAddress, uint32 storageChainEid, uint256 withdrawFee, uint256 depositFee, uint256 authFee, uint256 mintFee) public',
  'function getClient(uint32 clientId) view returns (tuple(uint32 id, uint32 storageChainEid, string name, address feeAddress, address ownerAddress, uint256 withdrawFee, uint256 depositFee, uint256 authFee, uint256 mintFee, uint256 creationBlock))',
  'event ClientCreated(uint32 indexed clientId, tuple(uint32 id, uint32 storageChainEid, string name, address feeAddress, address ownerAddress, uint256 withdrawFee, uint256 depositFee, uint256 authFee, uint256 mintFee, uint256 creationBlock) client)',
]

// LayerZero EIDs for the L2 storage chains. Today only Base is supported as
// a storage layer. When more chains come online, extend this list — the
// contracts already accept any EID; the constraint is just which L2s have
// CawProfileL2 deployed.
const STORAGE_CHAINS = {
  testnet: [
    { key: 'base-sepolia', label: 'Base Sepolia', eid: 40245 },
  ],
  mainnet: [
    { key: 'base', label: 'Base', eid: 30184 },
  ],
}

/**
 * Walk the operator through creating a new client on-chain. Signs the tx
 * with the validator key (passed in via ctx) and returns the new clientId.
 *
 * Returns null if the user backs out at any prompt.
 */
export async function createClientFlow(ctx) {
  const { l1RpcUrl, validatorPrivateKey, network = 'testnet' } = ctx
  if (!l1RpcUrl || !validatorPrivateKey) {
    console.log(warn('  Missing L1 RPC or validator key — cannot create a client from the CLI.'))
    return null
  }

  section('Create a new client')

  const { ethers } = await import('ethers')
  const provider = new ethers.JsonRpcProvider(l1RpcUrl)
  const wallet = new ethers.Wallet(validatorPrivateKey, provider)

  // Show the operator who's about to spend gas + own the new client.
  const balance = await provider.getBalance(wallet.address).catch(() => 0n)
  const balanceEth = ethers.formatEther(balance)
  console.log(brand(`  Tx will be sent from: ${wallet.address}`))
  console.log(dim(`  Balance: ${balanceEth} ETH on the L1 RPC`))
  if (balance < ethers.parseEther('0.005')) {
    console.log(warn('  Low balance — you may need to fund this address before the tx will land.'))
  }
  console.log()

  // ---- Client metadata ----
  const { name } = await inquirer.prompt([
    {
      type: 'input',
      name: 'name',
      message: 'Client name (shown on-chain, ~30 chars max):',
      validate: (input) => {
        const v = input.trim()
        if (!v) return 'Required'
        if (v.length > 64) return 'Too long (max 64 characters)'
        return true
      },
    },
  ])

  // ---- Storage chain ----
  const chains = STORAGE_CHAINS[network] || []
  let storageChainEid
  if (chains.length === 1) {
    storageChainEid = chains[0].eid
    console.log(dim(`  Storage chain: ${chains[0].label} (only option on ${network})`))
  } else {
    const answer = await inquirer.prompt([
      {
        type: 'list',
        name: 'eid',
        message: 'Storage chain (where this client\'s actions are processed):',
        choices: chains.map(c => ({ value: c.eid, name: `${brand(c.label)} ${dim('(EID ' + c.eid + ')')}` })),
        default: chains[0].eid,
      },
    ])
    storageChainEid = answer.eid
  }

  // ---- Fee address (default: validator wallet) ----
  const { feeAddress } = await inquirer.prompt([
    {
      type: 'input',
      name: 'feeAddress',
      message: 'Address that receives fees (default: validator address):',
      default: wallet.address,
      validate: (input) => /^0x[a-fA-F0-9]{40}$/.test(input.trim()) ? true : 'Invalid Ethereum address',
    },
  ])

  // ---- Fees ----
  tipBlock([
    'Set the on-chain fees your client charges. Fees are in ETH (wei).',
    `${brand('Each fee is matched 1:1 by the protocol burn pool')}, so a 0.001 ETH`,
    'mintFee actually costs the user 0.002 ETH (half goes to your fee address',
    'as CAW after withdrawal; half is burned).',
    '',
    `Defaults below are reasonable testnet values — you can change them later`,
    'with CawClientManager.setFees(). All can be 0 if you want a free client.',
  ])

  const { mintFeeEth, depositFeeEth, withdrawFeeEth, authFeeEth } = await inquirer.prompt([
    { type: 'input', name: 'mintFeeEth',     message: 'Mint fee (ETH, charged when minting a username):',           default: '0.001' },
    { type: 'input', name: 'depositFeeEth',  message: 'Deposit fee (ETH, charged when depositing CAW to L2):',      default: '0' },
    { type: 'input', name: 'withdrawFeeEth', message: 'Withdraw fee (ETH, charged when withdrawing CAW back to L1):', default: '0' },
    { type: 'input', name: 'authFeeEth',     message: 'Auth fee (ETH, charged when authenticating to a new client):', default: '0' },
  ])
  const toWei = (eth) => ethers.parseEther(String(eth || '0').trim())
  const mintFee = toWei(mintFeeEth)
  const depositFee = toWei(depositFeeEth)
  const withdrawFee = toWei(withdrawFeeEth)
  const authFee = toWei(authFeeEth)

  // ---- Confirm ----
  console.log()
  console.log(brand('  About to create a client with:'))
  console.log(`    name:        ${name}`)
  console.log(`    storage:     EID ${storageChainEid}`)
  console.log(`    feeAddress:  ${feeAddress}`)
  console.log(`    mintFee:     ${ethers.formatEther(mintFee)} ETH`)
  console.log(`    depositFee:  ${ethers.formatEther(depositFee)} ETH`)
  console.log(`    withdrawFee: ${ethers.formatEther(withdrawFee)} ETH`)
  console.log(`    authFee:     ${ethers.formatEther(authFee)} ETH`)
  console.log(`    sender/owner: ${wallet.address}`)
  console.log()

  const { confirm } = await inquirer.prompt([
    { type: 'confirm', name: 'confirm', message: 'Send the createClient transaction?', default: true },
  ])
  if (!confirm) {
    console.log(dim('  Cancelled. Picking an existing client ID instead.'))
    return null
  }

  // ---- Send tx ----
  const clientManagerAddress = addr('CLIENT_MANAGER_ADDRESS')
  const cm = new ethers.Contract(clientManagerAddress, CLIENT_MANAGER_ABI, wallet)

  console.log()
  console.log(dim('  Sending transaction...'))
  let tx, receipt
  try {
    tx = await cm.createClient(name.trim(), feeAddress.trim(), storageChainEid, withdrawFee, depositFee, authFee, mintFee)
    console.log(dim(`  tx hash: ${tx.hash}`))
    console.log(dim('  Waiting for confirmation...'))
    receipt = await tx.wait()
  } catch (e) {
    console.log(err(`  Transaction failed: ${e?.shortMessage || e?.message || e}`))
    return null
  }

  // ---- Find the new clientId from the ClientCreated event ----
  let newClientId
  for (const log of receipt.logs || []) {
    try {
      const parsed = cm.interface.parseLog(log)
      if (parsed?.name === 'ClientCreated') {
        newClientId = Number(parsed.args.clientId)
        break
      }
    } catch { /* not our event */ }
  }
  if (!newClientId) {
    console.log(warn('  Tx succeeded but no ClientCreated event found — check the receipt manually.'))
    return null
  }

  console.log()
  console.log(success(`  Client #${newClientId} created.`))
  console.log(dim(`  Owner: ${wallet.address}`))
  console.log(dim(`  Block: ${receipt.blockNumber}`))
  return newClientId
}
