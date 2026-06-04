// Public read of the on-chain instance registry, served from the
// in-memory peer cache that InstanceRegistryService maintains.
//
// Why expose this from the API instead of having the FE scan chain:
//   - One eth_getLogs roundtrip per FE bootstrap is wasteful when the
//     answer is the same JSON every time.
//   - Free RPCs cap getLogs ranges at ~50K blocks; the FE chunk-walk
//     across the contract's deploy history is slow on cold load.
//   - Aggregating peer lists from multiple nodes gives the FE a
//     consensus view ("90% of nodes know about this peer") that a
//     single chain scan can't offer.
//
// CORS is wildcard because the response is fully public — nothing here
// is sensitive, and the same data is on-chain. This lets a static-hosted
// FE (github pages, IPFS, etc) bootstrap by fetching from any CAW node's
// /api/instances regardless of origin.

import { Router } from 'express'
import { getPeers } from '../../services/InstanceRegistryService'
import { getNetworkId } from '../../utils/networkId'

const router = Router()

router.get('/', (req, res) => {
  // Wildcard CORS — same posture as /api/shorturl. No credentials, no
  // auth state, no tokens. Just public on-chain data, cached.
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Vary', 'Origin')

  // Default to the configured CLIENT_ID; allow ?clientId=N override so
  // a frontend serving multiple networks (rare today but supported by
  // the protocol) can ask for any peer set.
  const clientIdParam = req.query.clientId
  const clientId = clientIdParam
    ? Number(clientIdParam)
    : Number(getNetworkId() || 1)

  if (!Number.isFinite(clientId) || clientId <= 0) {
    res.status(400).json({ error: 'Invalid clientId' })
    return
  }

  const peers = getPeers(clientId)
  res.json({
    clientId,
    instances: peers.map(p => ({
      instanceId: p.instanceId,
      apiUrl: p.apiUrl,
      validatorAddress: p.validatorAddress,
      owner: p.owner,
      // active flag included for forward compat with deactivateInstance
      // logic on the contract — currently always true since we don't
      // refresh the active flag from chain (best-effort field).
      active: p.active,
    })),
  })
})

export default router
