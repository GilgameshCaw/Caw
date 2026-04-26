/**
 * LayerZero V2 DVN configuration for CAW mainnet pathways.
 *
 * We enforce a 3-of-3 required DVN set on every cross-chain pathway:
 *   - LayerZero Labs
 *   - Nethermind
 *   - Google Cloud
 *
 * WHY 3 AND NOT 1: a single-DVN ULN config means one compromised verifier
 * can forge messages and drain cross-chain state. 3-of-3 required makes
 * any single DVN compromise non-fatal — all three must sign for a
 * message to be delivered. This is the same guidance LZ gives to
 * production OApps and matches the aftermath of the 1-DVN hacks of
 * earlier 2026.
 *
 * TESTNET IS INTENTIONALLY NOT COVERED: not every DVN operates on every
 * LZ testnet, and the security value on testnet is minimal. Testnet
 * stays on LayerZero's default ULN config.
 *
 * DVN MISMATCH PROTECTION: LZ's docs call out that if a sender sets
 * `requiredDVNs: [A]` and the receiver sets `requiredDVNs: [A, B]`, every
 * message is blocked because DVN B was never paid to sign on the send
 * side. We avoid this by configuring SEND and RECEIVE sides of each
 * pathway with the SAME provider set (the 3 above), sourced from the
 * same DVNS table keyed by chain. Symmetric by construction.
 *
 * DVN addresses verified against LayerZero's public metadata API
 * (metadata.layerzero-api.com/v1/metadata/dvns) on 2026-04-24.
 */

// DVN addresses per mainnet chain, provided in ASCENDING order by address
// (UlnConfig requires this — unordered arrays revert).
//
// To add a new L2 (e.g. mainnetL2c for Optimism): append the chain to
// L2_CHAIN_KEYS in deploy.js, add a CHAINS entry, and add an entry here
// + in LZ_LIBRARIES_MAINNET below. The PATHWAYS list regenerates from
// L2_CHAIN_KEYS so no code changes needed in this file.
const DVNS_BY_CHAIN_MAINNET = {
  // Ethereum mainnet (lzEid 30101)
  mainnetL1: [
    '0x589dedbd617e0cbcb916a9223f4d1300c294236b', // LayerZero Labs
    '0xd56e4eab23cb81f43168f9f45211eb027b9ac7cc', // Google Cloud
    '0xf4064220871e3b94ca6ab3b0cee8e29178bf47de', // Nethermind
  ],
  // Base mainnet (lzEid 30184)
  mainnetL2: [
    '0xb1473ac9f58fb27597a21710da9d1071841e8163', // LayerZero Labs
    '0xcd37ca043f8479064e10635020c65ffc005d36f6', // Nethermind
    '0xd56e4eab23cb81f43168f9f45211eb027b9ac7cc', // Google Cloud
  ],
  // Arbitrum mainnet (lzEid 30110)
  mainnetL2b: [
    '0x14e570a1684c7ca883b35e1b25d2f7cec98a16cd', // Nethermind
    '0x2f55c492897526677c5b68fb199ea31e2c126416', // LayerZero Labs
    '0xd56e4eab23cb81f43168f9f45211eb027b9ac7cc', // Google Cloud
  ],
};

// LayerZero V2 send/receive library addresses per chain. Also from the
// metadata API. Same endpoint address across all three mainnets.
const LZ_LIBRARIES_MAINNET = {
  mainnetL1: {
    endpoint:     '0x1a44076050125825900e736c501f859c50fE728c',
    sendUln302:   '0xbB2Ea70C9E858123480642Cf96acbcCE1372dCe1',
    receiveUln302:'0xc02Ab410f0734EFa3F14628780e6e695156024C2',
  },
  mainnetL2: {
    endpoint:     '0x1a44076050125825900e736c501f859c50fE728c',
    sendUln302:   '0xB5320B0B3a13cC860893E2Bd79FCd7e13484Dda2',
    receiveUln302:'0xc70AB6f32772f59fBfc23889Caf4Ba3376C84bAf',
  },
  mainnetL2b: {
    endpoint:     '0x1a44076050125825900e736c501f859c50fE728c',
    sendUln302:   '0x975bcD720be66659e3EB3C0e4F1866a3020E493A',
    receiveUln302:'0x7B9E184e07a6EE1aC23eAe0fe8D6Be2f663f05e6',
  },
};

// LZ EndpointV2 setConfig / getConfig ABI fragments.
const ENDPOINT_ABI = [
  'function setConfig(address _oapp, address _lib, tuple(uint32 eid, uint32 configType, bytes config)[] _params) external',
  'function getConfig(address _oapp, address _lib, uint32 _eid, uint32 _configType) external view returns (bytes)',
];

// The ULN config type — LZ V2 has these standard ids.
// See: https://docs.layerzero.network/v2/developers/evm/configuration/default-config
// (CONFIG_TYPE_EXECUTOR = 1 is also defined by LZ but we don't configure
// the executor here — executor defaults stay untouched.)
const CONFIG_TYPE_ULN = 2;

// UlnConfig struct, matching LZ's ABI encoding.
const ULN_CONFIG_TUPLE = 'tuple(uint64 confirmations, uint8 requiredDVNCount, uint8 optionalDVNCount, uint8 optionalDVNThreshold, address[] requiredDVNs, address[] optionalDVNs)';

/**
 * Build the (ULN config) SetConfigParam tuple for a single pathway.
 *
 * chainKey names the LOCAL chain whose send or receive library is being
 * configured. We look up DVN addresses FOR THAT LOCAL CHAIN — they are the
 * addresses of our 3 providers ON THIS CHAIN, which is what setConfig
 * expects. Symmetric send/receive usage across chains is achieved by the
 * fact that provider identities (not addresses) are the same everywhere.
 *
 * confirmations: 0 = use the endpoint's default for this chain. We could
 * hardcode explicit values (15 for Ethereum, 10-20 for L2s) but 0 keeps
 * us tracking LZ's defaults and one less thing to update.
 */
function buildUlnSetConfigParams(ethers, chainKey, destEid) {
  const dvns = DVNS_BY_CHAIN_MAINNET[chainKey];
  if (!dvns) throw new Error(`No DVN config for chain ${chainKey}`);

  const ulnConfig = {
    confirmations: 0n, // 0 = use default
    requiredDVNCount: 3,
    optionalDVNCount: 0,
    optionalDVNThreshold: 0,
    requiredDVNs: dvns,
    optionalDVNs: [],
  };

  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    [ULN_CONFIG_TUPLE],
    [ulnConfig],
  );

  return [{
    eid: destEid,
    configType: CONFIG_TYPE_ULN,
    config: encoded,
  }];
}

/**
 * Decode a UlnConfig bytes blob returned by endpoint.getConfig.
 */
function decodeUlnConfig(ethers, encoded) {
  if (!encoded || encoded === '0x') return null;
  try {
    const [cfg] = ethers.AbiCoder.defaultAbiCoder().decode([ULN_CONFIG_TUPLE], encoded);
    return {
      confirmations: BigInt(cfg.confirmations),
      requiredDVNCount: Number(cfg.requiredDVNCount),
      optionalDVNCount: Number(cfg.optionalDVNCount),
      optionalDVNThreshold: Number(cfg.optionalDVNThreshold),
      requiredDVNs: [...cfg.requiredDVNs].map(a => a.toLowerCase()),
      optionalDVNs: [...cfg.optionalDVNs].map(a => a.toLowerCase()),
    };
  } catch {
    return null;
  }
}

/**
 * True iff the on-chain ULN config already matches what we'd set.
 */
function configMatches(current, expectedDvns) {
  if (!current) return false;
  const expectedSet = expectedDvns.map(a => a.toLowerCase()).sort();
  const currentSet = [...current.requiredDVNs].sort();
  if (currentSet.length !== expectedSet.length) return false;
  for (let i = 0; i < currentSet.length; i++) {
    if (currentSet[i] !== expectedSet[i]) return false;
  }
  return current.requiredDVNCount === expectedDvns.length
      && current.optionalDVNCount === 0
      && current.optionalDVNThreshold === 0;
}

/**
 * Build the full PATHWAYS list from the active L2 chain set. Each pathway
 * produces two setConfig txs: send on source, receive on destination.
 *
 * Includes:
 *   * Profile L1 ↔ each L2 (CawProfile setL2Peer'd to that chain).
 *   * Fraud-proof mesh: every CawChallengeRelay_<L> ↔ every other
 *     CawActionsArchive_<L'>. N×(N-1) directed pairs.
 *
 * Format: { oapp: string (state.addresses key), srcChain, destChain }
 * srcChain/destChain are the chain *abstract* names (L1/L2/L2b/...); the
 * deployer resolves them to concrete keys (mainnetL1 etc) at runtime.
 */
function buildPathways(l2ChainKeys) {
  const pathways = [];
  for (const L of l2ChainKeys) {
    // Profile: L1 CawProfile ↔ this L2's CawProfileL2_<L>
    pathways.push({ oapp: 'CawProfile',         srcChain: 'L1', destChain: L  });
    pathways.push({ oapp: `CawProfileL2_${L}`,  srcChain: L,    destChain: 'L1' });
  }
  // Fraud-proof mesh: relay on L → archive on L' for every L != L'.
  for (const L of l2ChainKeys) {
    for (const Lp of l2ChainKeys) {
      if (Lp === L) continue;
      pathways.push({ oapp: `CawChallengeRelay_${L}`,    srcChain: L,  destChain: Lp });
      pathways.push({ oapp: `CawActionsArchive_${Lp}`,   srcChain: Lp, destChain: L  });
    }
  }
  return pathways;
}

/**
 * Runs the full DVN config reconciliation. For each pathway:
 *  1. Read current SEND config on source. If already matches 3-of-3, skip.
 *  2. If mismatch, call setConfig on source endpoint's SEND library.
 *  3. Same for RECEIVE config on destination.
 *
 * Safe to re-run: reads before writes, only sends txs when needed.
 *
 * @param state - deployer.state
 * @param deployer - Deployer instance (provides getContract, initChain, etc.)
 * @param chainConfig - { env, ... }
 */
async function configureLzDvns(state, deployer, chainConfig, chainsMap, l2ChainKeys) {
  const ethers = require('ethers');
  const env = chainConfig.env;

  if (env !== 'mainnet') {
    console.log(`  DVN config is mainnet-only (env=${env}), skipping.`);
    return;
  }

  const pathways = buildPathways(l2ChainKeys);
  console.log(`\n  Reconciling DVN config across ${pathways.length} pathway(s)…`);
  console.log(`  Required DVNs: LayerZero Labs + Nethermind + Google Cloud (3-of-3).`);

  let applied = 0;
  let skipped = 0;

  for (const pathway of pathways) {
    const srcChainKey = deployer.getChainKey(pathway.srcChain);
    const destChainKey = deployer.getChainKey(pathway.destChain);
    const oappAddress = state.addresses[pathway.oapp];

    if (!oappAddress) {
      console.log(`   ${pathway.oapp}: no deployed address, skipping pathway`);
      continue;
    }

    const destEid = getChainEid(chainsMap, deployer, pathway.destChain);
    const srcEid  = getChainEid(chainsMap, deployer, pathway.srcChain);

    // --- SEND side on source chain ---
    {
      const result = await reconcileOneSide({
        ethers,
        deployer,
        chainKey: srcChainKey,
        oappAddress,
        libraryKind: 'sendUln302',
        peerEid: destEid,
        label: `SEND ${pathway.oapp} (${srcChainKey} → ${destChainKey})`,
      });
      if (result === 'applied') applied++;
      else if (result === 'skipped') skipped++;
    }

    // --- RECEIVE side on destination chain ---
    // The destination OApp is on destChain; find its state.addresses key
    // by convention. For the Profile pathways, the destination contract
    // key is deterministic:
    const destOappKey = destOappKeyFor(pathway);
    const destOappAddress = state.addresses[destOappKey];
    if (!destOappAddress) {
      console.log(`   ${destOappKey}: no deployed address, skipping RECEIVE side`);
      continue;
    }

    {
      const result = await reconcileOneSide({
        ethers,
        deployer,
        chainKey: destChainKey,
        oappAddress: destOappAddress,
        libraryKind: 'receiveUln302',
        peerEid: srcEid,
        label: `RECV ${destOappKey} (${srcChainKey} → ${destChainKey})`,
      });
      if (result === 'applied') applied++;
      else if (result === 'skipped') skipped++;
    }
  }

  console.log(`\n  DVN config summary: ${applied} applied, ${skipped} already-correct, ${pathways.length * 2 - applied - skipped} skipped (missing contracts)`);
}

/**
 * Look up the OApp key for the destination end of a pathway. Derived from
 * the source contract's role:
 *   * CawProfile (on L1) ↔ CawProfileL2_<destChain>
 *   * CawChallengeRelay_<src> ↔ CawActionsArchive_<dest>
 */
function destOappKeyFor(pathway) {
  // Profile L1 → L2: dest is the chain's CawProfileL2_<destChain>.
  if (pathway.oapp === 'CawProfile') return `CawProfileL2_${pathway.destChain}`;
  // Profile L2 → L1: dest is L1's CawProfile.
  if (pathway.oapp.startsWith('CawProfileL2_')) return 'CawProfile';
  // Fraud-proof relay → archive: dest is the destChain's CawActionsArchive.
  if (pathway.oapp.startsWith('CawChallengeRelay_')) return `CawActionsArchive_${pathway.destChain}`;
  // Fraud-proof archive ← relay: dest is the destChain's CawChallengeRelay.
  if (pathway.oapp.startsWith('CawActionsArchive_')) return `CawChallengeRelay_${pathway.destChain}`;
  throw new Error(`No destination mapping for pathway ${pathway.oapp}`);
}

/**
 * Get the LZ eid for a chain abstract name in current env. Accepts the
 * CHAINS map as a parameter since it's a module-level const in deploy.js
 * and not exposed via the deployer instance.
 */
function getChainEid(chainsMap, deployer, abstractChain) {
  const chainKey = deployer.getChainKey(abstractChain);
  const cfg = chainsMap[chainKey];
  if (!cfg) throw new Error(`No CHAINS entry for ${chainKey}`);
  return cfg.lzEid;
}

/**
 * Reconcile SEND or RECEIVE side for one pathway on one chain.
 */
async function reconcileOneSide({ ethers, deployer, chainKey, oappAddress, libraryKind, peerEid, label }) {
  const libs = LZ_LIBRARIES_MAINNET[chainKey];
  if (!libs) {
    console.log(`     ${label}: no library addresses for ${chainKey}, skipping`);
    return 'missing';
  }
  const libAddress = libs[libraryKind];

  await deployer.initChain(chainKey);
  const wallet = deployer.wallets[chainKey];
  if (!wallet) throw new Error(`No wallet initialized for ${chainKey}`);
  const endpoint = new ethers.Contract(libs.endpoint, ENDPOINT_ABI, wallet);

  // Read current config
  let current = null;
  try {
    const raw = await endpoint.getConfig(oappAddress, libAddress, peerEid, CONFIG_TYPE_ULN);
    current = decodeUlnConfig(ethers, raw);
  } catch (e) {
    // Fresh pathway — no config set yet. That's fine, we'll apply.
  }

  const expectedDvns = DVNS_BY_CHAIN_MAINNET[chainKey];
  if (configMatches(current, expectedDvns)) {
    console.log(`     ${label}: already correct, skipping`);
    return 'skipped';
  }

  const params = buildUlnSetConfigParams(ethers, chainKey, peerEid);

  console.log(`     ${label}: applying 3-of-3 DVN config…`);
  const tx = await endpoint.setConfig(oappAddress, libAddress, params);
  console.log(`       tx=${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`       confirmed in block ${receipt.blockNumber}`);
  return 'applied';
}

module.exports = {
  configureLzDvns,
  DVNS_BY_CHAIN_MAINNET,
  LZ_LIBRARIES_MAINNET,
};
