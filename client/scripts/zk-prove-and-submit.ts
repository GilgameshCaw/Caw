// Manual end-to-end test for the ZK action path on a live testnet.
//
// Usage:
//   cd client
//   ZK_PROVER_ENABLED=1 npx tsx scripts/zk-prove-and-submit.ts <multiData.json>
//
// The multiData.json file should be a JSON object with the same shape the
// validator builds at runtime:
//   {
//     "validatorId": <number>,
//     "packedActions": "0x…",
//     "packedSigs":    "0x…",
//     "signers":       ["0xabc…", "0xdef…", …]   // one per action, lowercase ok
//   }
//
// To capture one: instrument ValidatorService.processActions to fs.writeFile()
// the multiData blob just before calling the contract, run a real batch on
// dev, copy the file to a known path, and feed it here.
//
// The script:
//   1. Calls solidity/zk/sig-recovery/script prove-batch (Mac-local Groth16)
//   2. Sanity-checks signersHash == keccak256(signers concat)
//   3. Submits processActionsWithZkSigs to the live CawActions on the
//      configured L2 (defaults to base-sepolia)
//
// Failure modes:
//   - prove-batch missing → run `cargo build --release --bin prove-batch`
//     in solidity/zk/sig-recovery first
//   - signersHash mismatch → the multiData blob's signers don't match the
//     proof's recovered addresses (probably bad checksum casing client-side)
//   - on-chain revert → likely wrong validator / clientId / chainId
import 'dotenv/config'
import { ethers } from 'ethers'
import * as fs from 'fs'
import { proveBatch } from '../src/services/ValidatorService/zkProver'
import { deployments, type Env, type ChainKey } from '../src/abi/deployments'
import { makeJsonRpcProvider } from '../src/utils/rpcProvider'

const PROCESS_ACTIONS_ABI = [
  'function processActionsWithZkSigs(uint32 validatorId, bytes packedActions, bytes packedSigs, bytes signers, bytes proof, uint256 withdrawFee, uint256 withdrawLzTokenAmount) payable',
  'function eip712DomainHash() view returns (bytes32)',
]

interface MultiDataFile {
  validatorId: number
  packedActions: string
  packedSigs: string
  signers: string[]
  withdrawFee?: string
  withdrawLzTokenAmount?: string
}

function envOrThrow(k: string): string {
  const v = process.env[k]
  if (!v) throw new Error(`Missing env var ${k}`)
  return v
}

function packSigners(addrs: string[]): string {
  const buf = Buffer.alloc(addrs.length * 20)
  for (let i = 0; i < addrs.length; i++) {
    Buffer.from(addrs[i].replace(/^0x/, ''), 'hex').copy(buf, i * 20)
  }
  return '0x' + buf.toString('hex')
}

async function main() {
  const inputPath = process.argv[2]
  if (!inputPath) {
    console.error('Usage: npx tsx scripts/zk-prove-and-submit.ts <multiData.json>')
    process.exit(1)
  }
  const multiData: MultiDataFile = JSON.parse(fs.readFileSync(inputPath, 'utf8'))
  if (!multiData.packedActions?.startsWith('0x')) throw new Error('packedActions must be 0x-prefixed hex')
  if (!multiData.packedSigs?.startsWith('0x')) throw new Error('packedSigs must be 0x-prefixed hex')
  if (!Array.isArray(multiData.signers) || multiData.signers.length === 0) throw new Error('signers must be a non-empty array')

  const env = (process.env.ENV_NAME || 'testnet') as Env
  const chainKey: ChainKey = (process.env.L2_CHAIN as ChainKey) || 'L2'
  const chainEntry = (deployments as any)[env]?.[chainKey]
  if (!chainEntry) throw new Error(`No deployment for env=${env} chain=${chainKey}`)
  const cawActionsAddress: string = chainEntry.cawActions
  if (!cawActionsAddress) throw new Error(`No CawActions in deployments[${env}][${chainKey}]`)

  // Build provider/signer.
  const rpcUrl = envOrThrow('L2_RPC_URL')
  const rpcSecret = process.env.L2_RPC_SECRET
  const chainIdEnv = process.env.L2_CHAIN_ID ? Number(process.env.L2_CHAIN_ID) : undefined
  const provider = makeJsonRpcProvider(rpcUrl, chainIdEnv, rpcSecret)
  const wallet = new ethers.Wallet(envOrThrow('VALIDATOR_PRIVATE_KEY'), provider)
  const cawActions = new ethers.Contract(cawActionsAddress, PROCESS_ACTIONS_ABI, wallet)

  // Read the contract's actual EIP-712 domain hash so the proof commits to
  // exactly what the verifier will recompute.
  const domainSeparator: string = await cawActions.eip712DomainHash()
  console.log(`CawActions:        ${cawActionsAddress}`)
  console.log(`domainSeparator:   ${domainSeparator}`)
  console.log(`actions in batch:  ${multiData.signers.length}`)

  // Sanity: signersHash from the proof MUST match keccak256(packedSigners).
  const signersHex = packSigners(multiData.signers)
  const expectedSignersHash = ethers.keccak256(signersHex)

  console.log('\n[1/3] Generating Groth16 proof (10–15 min on Mac, ~10s on hosted)…')
  const proofRes = await proveBatch({
    packedActions: multiData.packedActions,
    packedSigs: multiData.packedSigs,
    domainSeparator,
  })
  if (proofRes.signersHash.toLowerCase() !== expectedSignersHash.toLowerCase()) {
    throw new Error(
      `signersHash mismatch — proof says ${proofRes.signersHash}, ` +
      `but local keccak256(signers) is ${expectedSignersHash}. ` +
      `The multiData.signers array probably doesn't match the addresses the ` +
      `circuit recovered. Re-derive locally.`
    )
  }
  console.log(`✓ Proof generated, signersHash matches.`)

  console.log('\n[2/3] Submitting processActionsWithZkSigs…')
  const tx = await cawActions.processActionsWithZkSigs(
    multiData.validatorId,
    multiData.packedActions,
    multiData.packedSigs,
    signersHex,
    proofRes.proof,
    multiData.withdrawFee || '0',
    multiData.withdrawLzTokenAmount || '0',
  )
  console.log(`tx hash: ${tx.hash}`)

  console.log('\n[3/3] Waiting for confirmation…')
  const receipt = await tx.wait()
  console.log(`block: ${receipt.blockNumber}, gasUsed: ${receipt.gasUsed.toString()}, status: ${receipt.status}`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
