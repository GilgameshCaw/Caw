/**
 * Set LZ MaxMessageSize for CawActionsReplicator
 *
 * Bumps the LayerZero executor config maxMessageSize for the replicator OApp
 * so that large replication payloads (256 actions with text) can be sent.
 *
 * The deployer wallet must be the LZ delegate for the replicator (set at deploy time).
 *
 * Usage:
 *   npx tsx scripts/set-lz-message-size.ts [maxBytes]
 *
 * Example:
 *   npx tsx scripts/set-lz-message-size.ts 200000
 */

import 'dotenv/config'
import { JsonRpcProvider, Contract, Wallet, AbiCoder } from 'ethers'
import { CAW_ACTIONS_REPLICATOR_L2_ADDRESS } from '../src/abi/addresses'

const LZ_ENDPOINT = '0x6EDCE65403992e310A62460808c4b910D972f10f'
const EXECUTOR_CONFIG_TYPE = 1

// Destination EIDs to configure
const DEST_EIDS = [
  { eid: 40231, name: 'Arbitrum Sepolia' },
  // Add more destinations here as needed
]

const endpointAbi = [
  'function setConfig(address _oapp, address _lib, tuple(uint32 eid, uint32 configType, bytes config)[] _params) external',
  'function getSendLibrary(address _sender, uint32 _dstEid) view returns (address)',
  'function getConfig(address _oapp, address _lib, uint32 _eid, uint32 _configType) view returns (bytes memory)',
  'function delegates(address) view returns (address)',
]

async function main() {
  const maxMessageSize = parseInt(process.argv[2]) || 200_000
  const rpcUrl = process.env.L2_RPC_URL_HTTP
  const privateKey = process.env.VALIDATOR_PRIVATE_KEY

  if (!rpcUrl) throw new Error('L2_RPC_URL_HTTP not set')
  if (!privateKey) throw new Error('VALIDATOR_PRIVATE_KEY not set')

  const provider = new JsonRpcProvider(rpcUrl)
  const wallet = new Wallet(privateKey, provider)
  const endpoint = new Contract(LZ_ENDPOINT, endpointAbi, wallet)
  const replicator = CAW_ACTIONS_REPLICATOR_L2_ADDRESS
  const coder = AbiCoder.defaultAbiCoder()

  console.log('='.repeat(60))
  console.log('Set LZ MaxMessageSize for CawActionsReplicator')
  console.log('='.repeat(60))
  console.log(`Replicator: ${replicator}`)
  console.log(`Wallet: ${wallet.address}`)
  console.log(`Target maxMessageSize: ${maxMessageSize.toLocaleString()} bytes`)
  console.log()

  // Verify delegate
  try {
    const delegate = await endpoint.delegates(replicator)
    console.log(`LZ Delegate for replicator: ${delegate}`)
    if (delegate.toLowerCase() !== wallet.address.toLowerCase()) {
      console.error(`WARNING: Your wallet (${wallet.address}) is not the delegate (${delegate}).`)
      console.error('The setConfig call will likely fail. The OApp owner must call setDelegate first.')
    }
  } catch (e: any) {
    console.log('Could not check delegate:', e.message)
  }

  for (const dest of DEST_EIDS) {
    console.log(`\n--- ${dest.name} (EID ${dest.eid}) ---`)

    // Get current send library
    const sendLib = await endpoint.getSendLibrary(replicator, dest.eid)
    console.log(`Send library: ${sendLib}`)

    // Get current config
    const currentBytes = await endpoint.getConfig(replicator, sendLib, dest.eid, EXECUTOR_CONFIG_TYPE)
    const [currentMax, currentExecutor] = coder.decode(['uint32', 'address'], currentBytes)
    console.log(`Current maxMessageSize: ${currentMax.toString()}`)
    console.log(`Current executor: ${currentExecutor}`)

    if (Number(currentMax) >= maxMessageSize) {
      console.log(`Already >= ${maxMessageSize}, skipping`)
      continue
    }

    // Encode the new ExecutorConfig
    const newConfig = coder.encode(['uint32', 'address'], [maxMessageSize, currentExecutor])

    // Build SetConfigParam
    const params = [{
      eid: dest.eid,
      configType: EXECUTOR_CONFIG_TYPE,
      config: newConfig,
    }]

    console.log(`Setting maxMessageSize to ${maxMessageSize}...`)
    const tx = await endpoint.setConfig(replicator, sendLib, params)
    const receipt = await tx.wait()
    console.log(`Done! tx: ${receipt?.hash}`)

    // Verify
    const updatedBytes = await endpoint.getConfig(replicator, sendLib, dest.eid, EXECUTOR_CONFIG_TYPE)
    const [updatedMax] = coder.decode(['uint32', 'address'], updatedBytes)
    console.log(`Verified maxMessageSize: ${updatedMax.toString()}`)
  }

  console.log('\nAll done.')
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Fatal:', err)
    process.exit(1)
  })
