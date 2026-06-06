/**
 * LayerZero V2 DVN configuration for CAW mainnet pathways.
 *
 * We use a 2-of-3 OPTIONAL DVN set on every cross-chain pathway:
 *   - Canary           (LZ-built, used as the client-diverse anchor today)
 *   - LayerZero Labs   (LZ-built)
 *   - Horizen          (LZ-built)
 *
 * WHY OPTIONAL 2-OF-3 INSTEAD OF REQUIRED 3-OF-3:
 *
 *   Required DVNs form a unanimity gate: if ANY required DVN goes offline or
 *   withholds signatures, every message on that pathway stalls permanently.
 *   A 3-of-3 required set gives each individual DVN an unconditional veto
 *   over the protocol — too much power for a set that is still largely
 *   LZ-operated.
 *
 *   Optional DVNs with a threshold of 2 mean: any 2 of the 3 must sign.
 *   A single DVN going offline (or going rogue) cannot halt the chain — the
 *   remaining two still carry messages through. Two would need to collude
 *   to forge, vs. one under the required model.
 *
 * ESCALATION PATH (on-chain, additions-only):
 *
 *   PathwayExpander.addDvnToPathway (commit 5052e454) lets the owner ADD a
 *   single optional DVN at a time along a fixed schedule:
 *     step 0 → 1: optional 3 → 4, threshold 2 → 3
 *     step 1 → 2: optional 4 → 5, threshold stays 3
 *     step 2+   : LOCKED
 *   At every step the honest-DVN majority is preserved. The plan is to
 *   escalate to 3-of-4 then 3-of-5 as client-diverse DVNs (not LZ-built)
 *   come online — per Dane at LZ, that is a couple of months out from
 *   the initial mainnet deploy. This script only handles the initial
 *   configureNewPathway write; escalation is a separate operator action
 *   that runs addDvnToPathway directly.
 *
 * DVN DIVERSITY NOTE:
 *
 *   The starting 3 (Canary, LZ Labs, Horizen) are operator-diverse (separate
 *   organizations) but all three are LZ-build projects, so they're not yet
 *   client-diverse. Canary is the most independent in practice. True
 *   client-diverse DVNs (independent codebases) will be added in the first
 *   escalation step. This asymmetry is documented so future reviewers know
 *   why 3-of-5 is the eventual target, not the start.
 *
 * TESTNET IS INTENTIONALLY NOT COVERED: not every DVN operates on every
 * LZ testnet, and the security value on testnet is minimal. Testnet
 * stays on LayerZero's default ULN config.
 *
 * DVN MISMATCH PROTECTION: LZ's docs call out that if a sender sets
 * `optionalDVNs: [A]` and the receiver sets `optionalDVNs: [A, B]`, every
 * message is blocked because DVN B was never paid to sign on the send
 * side. We avoid this by configuring SEND and RECEIVE sides of each
 * pathway with the SAME provider set (the 3 above), sourced from the
 * same DVNS table keyed by chain. Symmetric by construction.
 *
 * DVN addresses verified against LayerZero's public deployments page
 * (https://docs.layerzero.network/v2/deployments/dvn-addresses) on 2026-06-06.
 * Canary + Horizen addresses ARE NOT YET FILLED — sentinels left as TODO
 * for the deployer to look up + verify on the day of deploy. The deploy
 * script will throw on the TODO sentinels rather than silently submit
 * invalid configs.
 */

// DVN addresses per mainnet chain, provided in ASCENDING order by address
// (UlnConfig requires this — unordered arrays revert).
//
// To add a new L2 (e.g. mainnetL2c for Optimism): append the chain to
// L2_CHAIN_KEYS in deploy.js, add a CHAINS entry, and add an entry here
// + in LZ_LIBRARIES_MAINNET below. The PATHWAYS list regenerates from
// L2_CHAIN_KEYS so no code changes needed in this file.
// TODO BEFORE MAINNET DEPLOY: fill in the Canary + Horizen sentinels below
// with verified addresses from
//   https://docs.layerzero.network/v2/deployments/dvn-addresses
// Re-verify LZ Labs addresses on the same page before signing any tx.
// .sort() at array construction enforces the lowercase-ascending ordering
// LZ's UlnConfig requires.
const DVNS_BY_CHAIN_MAINNET = {
  // Ethereum mainnet (lzEid 30101)
  mainnetL1: [
    '0x__CANARY_ETHEREUM__',                    // TODO: Canary
    '0x589dedbd617e0cbcb916a9223f4d1300c294236b', // LayerZero Labs (verified 2026-06-06)
    '0x__HORIZEN_ETHEREUM__',                   // TODO: Horizen
  ].sort(),
  // Base mainnet (lzEid 30184)
  mainnetL2: [
    '0x__CANARY_BASE__',                        // TODO: Canary
    '0xb1473ac9f58fb27597a21710da9d1071841e8163', // LayerZero Labs (verified 2026-06-06)
    '0x__HORIZEN_BASE__',                       // TODO: Horizen
  ].sort(),
  // Arbitrum mainnet (lzEid 30110)
  mainnetL2b: [
    '0x__CANARY_ARBITRUM__',                    // TODO: Canary
    '0x2f55c492897526677c5b68fb199ea31e2c126416', // LayerZero Labs (verified 2026-06-06)
    '0x__HORIZEN_ARBITRUM__',                   // TODO: Horizen
  ].sort(),
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

// LZ EndpointV2 getConfig ABI fragment (read-only; we no longer call setConfig
// on the endpoint directly — PathwayExpander is the delegate and handles that).
const ENDPOINT_ABI = [
  'function getConfig(address _oapp, address _lib, uint32 _eid, uint32 _configType) external view returns (bytes)',
];

// PathwayExpander ABI fragments needed for DVN config.
const PATHWAY_EXPANDER_ABI = [
  'function configureNewPathway(address oapp, address endpointAddr, address lib, uint32 eid, bytes calldata ulnConfig) external',
  'function isPathwayConfigured(address oapp, address lib, uint32 eid) external view returns (bool)',
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
  for (const d of dvns) {
    if (d.includes('__')) throw new Error(
      `DVN sentinel ${d} for ${chainKey} not filled — see lz-dvn-config.js header TODO`
    );
  }

  // 2-of-3 optional. Required is empty: no DVN has unilateral veto. The
  // escalation contract (PathwayExpander.addDvnToPathway) can later bump
  // this to 3-of-4 then 3-of-5 as client-diverse DVNs come online.
  const ulnConfig = {
    confirmations: 0n, // 0 = use default
    requiredDVNCount: 0,
    optionalDVNCount: 3,
    optionalDVNThreshold: 2,
    requiredDVNs: [],
    optionalDVNs: dvns,
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
 * Checks the 2-of-3 optional scheme: no required DVNs, correct optional set,
 * count 3, threshold 2.
 */
function configMatches(current, expectedDvns) {
  if (!current) return false;
  const expectedSet = expectedDvns.map(a => a.toLowerCase()).sort();
  const currentSet = [...current.optionalDVNs].sort();
  if (currentSet.length !== expectedSet.length) return false;
  for (let i = 0; i < currentSet.length; i++) {
    if (currentSet[i] !== expectedSet[i]) return false;
  }
  return current.optionalDVNCount === expectedDvns.length
      && current.optionalDVNThreshold === 2
      && current.requiredDVNCount === 0
      && current.requiredDVNs.length === 0;
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
    // Profile: L1 CawProfile ↔ this L2's CawProfileLedger_<L>
    pathways.push({ oapp: 'CawProfile',         srcChain: 'L1', destChain: L  });
    pathways.push({ oapp: `CawProfileLedger_${L}`,  srcChain: L,    destChain: 'L1' });
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
 *  1. Read current SEND config on source. If already matches 2-of-3, skip.
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
  console.log(`  Optional DVNs: Canary + LayerZero Labs + Horizen (2-of-3 threshold).`);

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
        state,
        l2ChainAbstract: pathway.srcChain,
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
        state,
        l2ChainAbstract: pathway.destChain,
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
 *   * CawProfile (on L1) ↔ CawProfileLedger_<destChain>
 *   * CawChallengeRelay_<src> ↔ CawActionsArchive_<dest>
 */
function destOappKeyFor(pathway) {
  // Profile L1 → L2: dest is the chain's CawProfileLedger_<destChain>.
  if (pathway.oapp === 'CawProfile') return `CawProfileLedger_${pathway.destChain}`;
  // Profile L2 → L1: dest is L1's CawProfile.
  if (pathway.oapp.startsWith('CawProfileLedger_')) return 'CawProfile';
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
 *
 * Calls endpoint.getConfig (read-only) to check the current effective config,
 * then — if an update is needed — routes through PathwayExpander.configureNewPathway
 * instead of calling endpoint.setConfig directly. PathwayExpander is the
 * registered LZ delegate for all CAW OApps, so only it can call setConfig on
 * their behalf. The deployer EOA is never the delegate after this change.
 *
 * Idempotency: PathwayExpander.isPathwayConfigured is checked first. If the
 * expander has already applied a config for this (oapp, lib, eid) triple it
 * refuses to rewrite it — so re-running deploy is safe.
 */
async function reconcileOneSide({ ethers, deployer, chainKey, oappAddress, libraryKind, peerEid, label, state, l2ChainAbstract }) {
  const libs = LZ_LIBRARIES_MAINNET[chainKey];
  if (!libs) {
    console.log(`     ${label}: no library addresses for ${chainKey}, skipping`);
    return 'missing';
  }
  const libAddress = libs[libraryKind];

  await deployer.initChain(chainKey);
  const wallet = deployer.wallets[chainKey];
  if (!wallet) throw new Error(`No wallet initialized for ${chainKey}`);

  // Resolve PathwayExpander address for this chain.
  // Convention: the per-chain expander key is PathwayExpander_<abstractChain>
  // where abstractChain is the abstract name used in CONTRACTS (L1/L2/L2b…).
  const expanderKey = `PathwayExpander_${l2ChainAbstract}`;
  const expanderAddress = state.addresses[expanderKey];
  if (!expanderAddress) {
    console.log(`     ${label}: no PathwayExpander for ${chainKey} (key ${expanderKey}), skipping`);
    return 'missing';
  }
  const expander = new ethers.Contract(expanderAddress, PATHWAY_EXPANDER_ABI, wallet);

  // Check whether expander already applied this config (additions-only guard).
  const alreadyConfigured = await expander.isPathwayConfigured(oappAddress, libAddress, peerEid);
  if (alreadyConfigured) {
    console.log(`     ${label}: expander already applied, skipping`);
    return 'skipped';
  }

  // Also check effective on-chain config — if it already matches our 2-of-3
  // optional target (e.g. from a prior deploy run that completed), skip.
  const endpoint = new ethers.Contract(libs.endpoint, ENDPOINT_ABI, wallet);
  let current = null;
  try {
    const raw = await endpoint.getConfig(oappAddress, libAddress, peerEid, CONFIG_TYPE_ULN);
    current = decodeUlnConfig(ethers, raw);
  } catch (e) {
    // getConfig may revert for unsupported eids on the test endpoint.
  }

  const expectedDvns = DVNS_BY_CHAIN_MAINNET[chainKey];
  if (configMatches(current, expectedDvns)) {
    console.log(`     ${label}: already correct on-chain, skipping`);
    return 'skipped';
  }

  // Build the raw ULN config bytes (the `config` field of SetConfigParam).
  // 2-of-3 optional, no required. See module header for rationale + escalation path.
  for (const d of expectedDvns) {
    if (d.includes('__')) throw new Error(
      `DVN sentinel ${d} for ${chainKey} not filled — see lz-dvn-config.js header TODO`
    );
  }
  const ulnConfig = {
    confirmations: 0n,
    requiredDVNCount: 0,
    optionalDVNCount: 3,
    optionalDVNThreshold: 2,
    requiredDVNs: [],
    optionalDVNs: expectedDvns,
  };
  const ULN_TUPLE = 'tuple(uint64 confirmations, uint8 requiredDVNCount, uint8 optionalDVNCount, uint8 optionalDVNThreshold, address[] requiredDVNs, address[] optionalDVNs)';
  const encodedUln = ethers.AbiCoder.defaultAbiCoder().encode([ULN_TUPLE], [ulnConfig]);

  console.log(`     ${label}: routing through PathwayExpander.configureNewPathway…`);
  const tx = await expander.configureNewPathway(oappAddress, libs.endpoint, libAddress, peerEid, encodedUln);
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
