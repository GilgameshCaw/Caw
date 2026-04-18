import { JsonRpcProvider, WebSocketProvider, Network } from 'ethers'

/**
 * Create a JsonRpcProvider with `staticNetwork: true` so ethers skips its
 * internal "_detectNetwork" retry loop. Without staticNetwork, when the RPC
 * is unreachable ethers spams `JsonRpcProvider failed to detect network; retry
 * in 1s` forever — once per provider per second. We have ~8 long-lived
 * provider instances across services, so during a network outage the logs
 * get flooded with hundreds of lines per minute from ethers internals.
 *
 * With staticNetwork, the provider waits for the first real send() call to
 * establish the network and then locks it in. Failed sends surface as normal
 * timeouts in the caller's retry/backoff, which we control and can log once
 * per cycle instead of per second.
 *
 * If `chainId` is known up front, pass it so the provider is usable even
 * before the first successful RPC call.
 */
export function makeJsonRpcProvider(url: string, chainId?: number): JsonRpcProvider {
  if (chainId != null) {
    const network = Network.from(chainId)
    return new JsonRpcProvider(url, network, { staticNetwork: network })
  }
  return new JsonRpcProvider(url, undefined, { staticNetwork: true })
}

/**
 * Create a WebSocketProvider. Unlike JsonRpcProvider, we do NOT set
 * staticNetwork here — WebSocket providers need the normal startup
 * handshake to establish the connection before Contract.on() and other
 * subscription methods work. The "retry in 1s" spam is not an issue for
 * WebSocket providers since they have their own close/error event-driven
 * reconnection, not a polling loop.
 *
 * If `chainId` is known, pass it as a hint to skip the initial eth_chainId call.
 */
export function makeWebSocketProvider(url: string, chainId?: number): WebSocketProvider {
  if (chainId != null) {
    const network = Network.from(chainId)
    return new WebSocketProvider(url, network)
  }
  return new WebSocketProvider(url)
}
