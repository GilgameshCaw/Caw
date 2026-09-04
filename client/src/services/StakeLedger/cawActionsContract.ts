import { JsonRpcProvider, WebSocketProvider, Contract } from 'ethers'
import { makeJsonRpcProvider, makeWebSocketProvider, getL2HttpRpcUrl } from '../../utils/rpcProvider'
import { cawActionsAbi } from '../../abi/generated'

let _provider: JsonRpcProvider | WebSocketProvider | null = null
let _contract: Contract | null = null

export function getCawActions(): Contract {
  if (_contract) return _contract
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { CAW_ACTIONS_ADDRESS } = require('../../abi/addresses') as { CAW_ACTIONS_ADDRESS: string }
  const rpcUrl = getL2HttpRpcUrl()
  if (!rpcUrl) throw new Error('[StakeLedger] L2 RPC not configured')
  _provider = rpcUrl.startsWith('wss://') || rpcUrl.startsWith('ws://')
    ? makeWebSocketProvider(rpcUrl, 84532)
    : makeJsonRpcProvider(rpcUrl, 84532)
  _contract = new Contract(CAW_ACTIONS_ADDRESS, cawActionsAbi as any, _provider)
  return _contract
}
