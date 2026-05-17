/**
 * Hardhat mainnet-fork tests: CawCapOracle + CawL1PriceReader vs real Uniswap
 * V2 pools. Validates that the TWAP math produces sane outputs when fed actual
 * on-chain cumulative accumulators, catching any drift vs the synthetic-sample
 * unit tests in test/cap-oracle-test.js.
 *
 * Run:
 *   FORK_MAINNET_RPC_URL=<mainnet-rpc> npx hardhat test test-fork/cap-oracle-fork-test.js
 *
 * Or with block pin:
 *   FORK_MAINNET_RPC_URL=<url> FORK_MAINNET_BLOCK=22500000 npx hardhat test test-fork/cap-oracle-fork-test.js
 *
 * If FORK_MAINNET_RPC_URL is not set, all tests self-skip with a clear message.
 * Do not add to CI — these tests require a paid/free-tier mainnet RPC.
 *
 * What this validates:
 *   Test 1 — Real CAW/WETH V2 pair: TWAP delta from readSample() agrees with
 *             the pair's instantaneous price; capForAction returns a number.
 *   Test 2 — PEPE/WETH or SHIB/WETH V2 pair: verifies token-ordering probe
 *             (cawIsToken0 flag), magnitude handling at "cheap token" prices.
 *   Test 3 — Wrap-around stress (synthetic, but anchored to real magnitudes):
 *             samples near 2^224 boundary, verify masking arithmetic.
 */

'use strict';
const hre = require('hardhat');
const { ethers } = require('ethers');
const { expect } = require('chai');
const fs = require('fs');
const path = require('path');

// ─── ethers provider wrapping hardhat's in-memory network ────────────────────
const provider = new ethers.BrowserProvider(hre.network.provider);

// ─── Well-known mainnet addresses ────────────────────────────────────────────
const UNI_V2_FACTORY   = '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f';
const WETH             = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const CAW_TOKEN        = '0xf3b9569F82B18aEf890De263B84189bd33EBe452';
const PEPE_TOKEN       = '0x6982508145454Ce325dDbE47a25d4ec3d2311933';
const SHIB_TOKEN       = '0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE';

// ─── ABIs (minimal) ──────────────────────────────────────────────────────────
const FACTORY_ABI = [
  'function getPair(address tokenA, address tokenB) external view returns (address pair)',
];
const PAIR_ABI = [
  'function token0() external view returns (address)',
  'function token1() external view returns (address)',
  'function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function price0CumulativeLast() external view returns (uint256)',
  'function price1CumulativeLast() external view returns (uint256)',
];

// ─── Artifact loader (no hardhat-ethers plugin) ───────────────────────────────
function loadArtifact(name) {
  const p = path.join(
    __dirname, '..', 'artifacts', 'contracts', `${name}.sol`, `${name}.json`
  );
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// Deploy a contract using signer + artifact.
async function deploy(signer, artifactName, ...args) {
  const art = loadArtifact(artifactName);
  const factory = new ethers.ContractFactory(art.abi, art.bytecode, signer);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  return contract;
}

// ─── Skip guard ──────────────────────────────────────────────────────────────
const forkConfigured = !!process.env.FORK_MAINNET_RPC_URL;
const maybeDescribe = forkConfigured ? describe : describe.skip;

if (!forkConfigured) {
  console.log(
    '\n  [cap-oracle-fork-test] Skipping: FORK_MAINNET_RPC_URL not set.\n' +
    '  Run with: FORK_MAINNET_RPC_URL=<mainnet-rpc> npx hardhat test ' +
    'test-fork/cap-oracle-fork-test.js\n'
  );
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

// Look up a V2 pair via the factory.
async function getV2Pair(signer, tokenA, tokenB) {
  const factory = new ethers.Contract(UNI_V2_FACTORY, FACTORY_ABI, signer);
  const pairAddr = await factory.getPair(tokenA, tokenB);
  if (pairAddr === ethers.ZeroAddress) return null;
  const pairContract = new ethers.Contract(pairAddr, PAIR_ABI, signer);
  return { pairAddr, pairContract };
}

// Compute the instantaneous WETH-per-token price as UQ112.112.
async function instantaneousPrice(pairContract, tokenAddr) {
  const [r0, r1, ] = await pairContract.getReserves();
  const t0 = await pairContract.token0();
  const tokenIsToken0 = t0.toLowerCase() === tokenAddr.toLowerCase();
  const TWO_112 = 1n << 112n;
  if (tokenIsToken0) {
    return (BigInt(r1) * TWO_112) / BigInt(r0);
  } else {
    return (BigInt(r0) * TWO_112) / BigInt(r1);
  }
}

/**
 * Core validation flow used by Test 1 and Test 2.
 * Deploys CawL1PriceReader + CawCapOracle, reads two samples 1 hour apart,
 * feeds them into the oracle via a synthetic 2-day anchor, and validates
 * TWAP + capForAction.
 */
async function runPoolValidation(signer, pairAddr, tokenAddr, label) {
  const reader = await deploy(signer, 'CawL1PriceReader', pairAddr, tokenAddr);
  console.log(`\n    [${label}] CawL1PriceReader deployed: ${await reader.getAddress()}`);
  console.log(`    [${label}] cawIsToken0: ${await reader.cawIsToken0()}`);

  const [cum0, ts0] = await reader.readSample();
  console.log(`    [${label}] sample0 cumulative: ${cum0.toString()}`);
  console.log(`    [${label}] sample0 timestamp:  ${ts0.toString()}`);

  await hre.network.provider.send('evm_increaseTime', [3600]);
  await hre.network.provider.send('evm_mine');

  const [cum1, ts1] = await reader.readSample();
  console.log(`    [${label}] sample1 cumulative: ${cum1.toString()}`);
  console.log(`    [${label}] sample1 timestamp:  ${ts1.toString()}`);

  const elapsed = BigInt(ts1) - BigInt(ts0);
  console.log(`    [${label}] elapsed seconds: ${elapsed.toString()}`);

  const MASK_224 = (1n << 224n) - 1n;
  const cumDelta = (BigInt(cum1) - BigInt(cum0)) & MASK_224;
  const manualTwap = elapsed > 0n ? cumDelta / elapsed : 0n;
  console.log(`    [${label}] manual TWAP (UQ112.112): ${manualTwap.toString()}`);

  const pairContract = new ethers.Contract(pairAddr, PAIR_ABI, signer);
  const instPrice = await instantaneousPrice(pairContract, tokenAddr);
  console.log(`    [${label}] instantaneous price (UQ112.112): ${instPrice.toString()}`);

  // Deploy CawCapOracle with signer as writer (test-only).
  const signerAddr = await signer.getAddress();
  const oracle = await deploy(signer, 'CawCapOracle', signerAddr);
  console.log(`    [${label}] CawCapOracle deployed: ${await oracle.getAddress()}`);

  // Seed a synthetic anchor 2 days back so MIN_WINDOW (1 day) is satisfied.
  // This mimics steady-state oracle operation with accumulated history.
  const twoDays = 2n * 86400n;
  const syntheticTs = BigInt(ts0) - twoDays;
  // Walk back the cumulative using the measured TWAP.
  const syntheticCum = (BigInt(cum0) - manualTwap * twoDays) & MASK_224;

  await oracle.recordSample(syntheticCum, Number(syntheticTs));
  await oracle.recordSample(cum0, Number(ts0));
  await oracle.recordSample(cum1, Number(ts1));

  const [twapFromOracle, fresh] = await oracle.twapEthPerCaw();
  console.log(`    [${label}] oracle TWAP (UQ112.112): ${twapFromOracle.toString()}, fresh=${fresh}`);

  const capResult = await oracle.capForAction(2000n, 200000000000n); // 2e11 wei
  console.log(`    [${label}] capForAction(2000, 2e11) = ${capResult.toString()}`);

  if (BigInt(capResult) < 2000n) {
    console.log(`    [${label}] cap BINDS at ${capResult.toString()} whole CAW`);
  } else {
    console.log(`    [${label}] cap DORMANT — baseline 2000 applies`);
  }

  return {
    capResult: BigInt(capResult),
    twapUQ: BigInt(twapFromOracle),
    instPrice,
    sample0: [cum0, ts0],
    sample1: [cum1, ts1],
    fresh,
    manualTwap,
  };
}

// ─── Test 1: Real CAW/WETH pool ──────────────────────────────────────────────

maybeDescribe('Test 1 — CAW/WETH Uniswap V2 mainnet fork', function () {
  this.timeout(180_000);

  let signer, pairAddr, pairContract;

  before(async () => {
    signer = await provider.getSigner(0);
    const pair = await getV2Pair(signer, CAW_TOKEN, WETH);
    if (!pair) throw new Error('CAW/WETH V2 pair not found via factory');
    pairAddr = pair.pairAddr;
    pairContract = pair.pairContract;
    console.log(`\n  CAW/WETH pair: ${pairAddr}`);

    const [r0, r1, ] = await pairContract.getReserves();
    const t0 = await pairContract.token0();
    console.log(`  token0: ${t0}`);
    console.log(`  reserve0: ${r0.toString()}, reserve1: ${r1.toString()}`);
    if (BigInt(r0) === 0n || BigInt(r1) === 0n) {
      throw new Error('CAW/WETH pair has zero reserves — bad fork block?');
    }
  });

  it('CawL1PriceReader deploys and accepts CAW/WETH pair', async () => {
    const reader = await deploy(signer, 'CawL1PriceReader', pairAddr, CAW_TOKEN);
    expect(await reader.pair()).to.equal(pairAddr);
    const cawIsToken0 = await reader.cawIsToken0();
    const t0 = await pairContract.token0();
    const expectedCawIsToken0 = t0.toLowerCase() === CAW_TOKEN.toLowerCase();
    expect(cawIsToken0).to.equal(expectedCawIsToken0);
  });

  it('readSample returns non-zero cumulative at fork block', async () => {
    const reader = await deploy(signer, 'CawL1PriceReader', pairAddr, CAW_TOKEN);
    const [cum, ts] = await reader.readSample();
    expect(BigInt(cum) > 0n, 'cumulative should be non-zero on live pool').to.equal(true);
    expect(BigInt(ts) > 0n, 'timestamp should be non-zero').to.equal(true);
  });

  it('TWAP delta vs instantaneous price: within 20% epsilon', async () => {
    // On the burned-LP CAW pool (no trades), the TWAP over 1 hour equals the
    // instantaneous price exactly. We allow 20% epsilon for any edge case.
    const reader = await deploy(signer, 'CawL1PriceReader', pairAddr, CAW_TOKEN);
    const [cum0, ts0] = await reader.readSample();

    await hre.network.provider.send('evm_increaseTime', [3600]);
    await hre.network.provider.send('evm_mine');

    const [cum1, ts1] = await reader.readSample();
    const elapsed = BigInt(ts1) - BigInt(ts0);
    expect(elapsed > 0n, 'time must advance').to.equal(true);

    const MASK_224 = (1n << 224n) - 1n;
    const cumDelta = (BigInt(cum1) - BigInt(cum0)) & MASK_224;
    const manualTwap = elapsed > 0n ? cumDelta / elapsed : 0n;

    const instPrice = await instantaneousPrice(pairContract, CAW_TOKEN);
    expect(instPrice > 0n, 'instantaneous price must be non-zero').to.equal(true);
    expect(manualTwap > 0n, 'TWAP delta must be non-zero').to.equal(true);

    const diff = manualTwap > instPrice
      ? manualTwap - instPrice
      : instPrice - manualTwap;
    const pct20 = instPrice / 5n; // 20%
    console.log(`\n    TWAP delta:    ${manualTwap.toString()}`);
    console.log(`    Instantaneous: ${instPrice.toString()}`);
    console.log(`    Epsilon (20%): ${pct20.toString()}`);
    expect(diff <= pct20, 'TWAP delta should be within 20% of instantaneous price').to.equal(true);
  });

  it('capForAction(2000, 2e11) on CAW/WETH: returns non-zero, logs binding state', async () => {
    const result = await runPoolValidation(signer, pairAddr, CAW_TOKEN, 'CAW/WETH');
    expect(result.capResult > 0n, 'cap must not be zero').to.equal(true);
    expect(result.fresh).to.equal(true, 'oracle should be fresh after seeding');
    // At today's CAW price (~$1e-9/CAW) the cap is DORMANT — baseline applies.
  });
});

// ─── Test 2: PEPE/WETH or SHIB/WETH — sensitivity at higher mcap ─────────────

maybeDescribe('Test 2 — Alternate V2 pool sensitivity (PEPE/WETH or SHIB/WETH)', function () {
  this.timeout(180_000);

  // tokenLabel/pairAddr/tokenAddr are populated in before(); fixed strings used
  // in test titles to avoid undefined-capture at describe-parse time.
  let signer, pairAddr, tokenAddr, tokenLabel;

  before(async () => {
    signer = await provider.getSigner(0);

    const pepePair = await getV2Pair(signer, PEPE_TOKEN, WETH);
    let useShib = false;
    if (pepePair) {
      const [r0, r1, ] = await pepePair.pairContract.getReserves();
      if (BigInt(r0) > 0n && BigInt(r1) > 0n) {
        pairAddr  = pepePair.pairAddr;
        tokenAddr = PEPE_TOKEN;
        tokenLabel = 'PEPE';
      } else {
        useShib = true;
      }
    } else {
      useShib = true;
    }

    if (useShib) {
      const shibPair = await getV2Pair(signer, SHIB_TOKEN, WETH);
      if (!shibPair) throw new Error('Neither PEPE/WETH nor SHIB/WETH V2 pair found');
      const [r0, r1, ] = await shibPair.pairContract.getReserves();
      if (BigInt(r0) === 0n || BigInt(r1) === 0n) {
        throw new Error('SHIB/WETH pair also has zero reserves');
      }
      pairAddr  = shibPair.pairAddr;
      tokenAddr = SHIB_TOKEN;
      tokenLabel = 'SHIB';
    }

    console.log(`\n  Using ${tokenLabel}/WETH pair: ${pairAddr}`);
    const pairContract = new ethers.Contract(pairAddr, PAIR_ABI, signer);
    const [r0, r1, ] = await pairContract.getReserves();
    const t0 = await pairContract.token0();
    console.log(`  token0: ${t0}`);
    console.log(`  reserve0: ${r0.toString()}, reserve1: ${r1.toString()}`);
  });

  it('CawL1PriceReader: token-ordering probe correct for PEPE or SHIB pair', async () => {
    const reader = await deploy(signer, 'CawL1PriceReader', pairAddr, tokenAddr);
    const pairContract = new ethers.Contract(pairAddr, PAIR_ABI, signer);
    const t0 = await pairContract.token0();
    const expectedCawIsToken0 = t0.toLowerCase() === tokenAddr.toLowerCase();
    const cawIsToken0 = await reader.cawIsToken0();
    expect(cawIsToken0).to.equal(expectedCawIsToken0, `token ordering mismatch for ${tokenLabel}`);
    console.log(`\n    ${tokenLabel} is token${cawIsToken0 ? '0' : '1'} in pair — ordering probe correct`);
  });

  it('capForAction(2000, 2e11) on PEPE or SHIB pool: logs binding state, asserts non-zero', async () => {
    // At multi-billion-mcap "cheap" tokens:
    //   PEPE ~$4B mcap → ~1.9e12 wei/PEPE → capped = 2e11 / 1.9e12 ≈ 0.1 → floors at 1
    //   SHIB ~$10B mcap → ~3.4e12 wei/SHIB → capped ≈ 0.06 → floors at 1
    // In both cases the cap BINDS. If it returns 2000 (dormant), that is a
    // precision bug — the UQ112.112 per-unit price is so small it evaporated.
    const result = await runPoolValidation(signer, pairAddr, tokenAddr, `${tokenLabel}/WETH`);
    expect(result.capResult > 0n, 'cap must not be zero (floor-at-1 applies)').to.equal(true);

    console.log(`\n    PRECISION CHECK for ${tokenLabel}:`);
    if (result.fresh) {
      if (result.capResult < 2000n) {
        console.log(`    cap BINDS at ${result.capResult.toString()} — expected at ${tokenLabel} price level`);
      } else {
        console.log(
          `    BUG: cap DORMANT (${result.capResult.toString()}) on ${tokenLabel} — ` +
          `per-unit price too small to register in UQ112.112 arithmetic`
        );
      }
    } else {
      console.log(`    oracle not fresh — TWAP not evaluated`);
    }

    // Positive precision assertion: at multi-billion mcap the cap MUST bind.
    // A dormant cap here is wrong economic behavior — flag it loudly.
    if (result.fresh) {
      expect(
        result.capResult < 2000n,
        `cap should bind on ${tokenLabel} (multi-billion mcap) — got ${result.capResult.toString()}`
      ).to.equal(true);
    }
  });
});

// ─── Test 3: Wrap-around stress (synthetic, anchored to real cumulative magnitudes)

maybeDescribe('Test 3 — Wrap-around stress (2^224 boundary)', function () {
  this.timeout(120_000);

  let signer;

  before(async () => {
    signer = await provider.getSigner(0);
  });

  it('cumulative near 2^224: oracle recovers correct TWAP via 224-bit masking', async () => {
    const signerAddr = await signer.getAddress();
    const oracle = await deploy(signer, 'CawCapOracle', signerAddr);

    const now = Math.floor(Date.now() / 1000);
    const MASK_224 = (1n << 224n) - 1n;

    // Place cumulative just below 2^224, then advance by `increment` to force wrap.
    const cumNearMax = (1n << 224n) - 1000n;
    const increment  = 2000n; // cumNearMax + 2000 > 2^224, so wraps in 224-bit space
    // After truncation to uint224: stored value is 1000.
    const cumWrapped = (cumNearMax + increment) & MASK_224; // = 1000

    const minWindowSecs = 86401; // just over MIN_WINDOW
    const t0 = now - minWindowSecs;
    const t1 = now;

    // recordSample accepts uint256; oracle internally truncates to uint224.
    await oracle.recordSample(cumNearMax, t0);
    await oracle.recordSample(cumWrapped, t1);

    const [twap, fresh] = await oracle.twapEthPerCaw();
    console.log(`\n    wrap-around: cumNearMax=${cumNearMax.toString()}`);
    console.log(`    cumWrapped=${cumWrapped.toString()}`);
    console.log(`    oracle TWAP (UQ112.112): ${twap.toString()}, fresh=${fresh}`);

    // expected: delta recovered by unchecked-subtract + mask = increment = 2000.
    // elapsed = 86401. 2000 / 86401 = 0 (integer floor).
    const expectedDelta = increment;
    const elapsed = BigInt(t1 - t0);
    const expectedTwap = expectedDelta / elapsed;

    expect(fresh, 'oracle should be fresh with min-window-spanning samples').to.equal(true);
    expect(BigInt(twap).toString()).to.equal(
      expectedTwap.toString(),
      'TWAP should correctly recover wrap-around delta via 224-bit masking'
    );
    console.log(`    Expected TWAP: ${expectedTwap.toString()} — MATCH: ${BigInt(twap).toString() === expectedTwap.toString()}`);
  });

  it('wrap-around: capForAction returns correct value when cumulative wraps mid-window', async () => {
    const signerAddr = await signer.getAddress();
    const oracle = await deploy(signer, 'CawCapOracle', signerAddr);

    // Anchor a realistic price: $3B mcap equivalent → 1e9 wei/whole CAW.
    // The cumulative wraps through 2^224 during the window.
    const now = Math.floor(Date.now() / 1000);
    const price_wei = 1_000_000_000n; // 1e9 wei per whole CAW
    const TWO_112   = 1n << 112n;
    const priceUQ   = (price_wei * TWO_112) / (10n ** 18n);
    const elapsed   = 86401n; // MIN_WINDOW + 1 second
    const MASK_224  = (1n << 224n) - 1n;

    // Place cum0 just below 2^224 so that cum0 + (priceUQ * elapsed) wraps.
    const cum0 = ((1n << 224n) - priceUQ * elapsed / 2n) & MASK_224;
    const cum1 = (cum0 + priceUQ * elapsed) & MASK_224;

    await oracle.recordSample(cum0, now - Number(elapsed));
    await oracle.recordSample(cum1, now);

    const cap = BigInt(await oracle.capForAction(2000n, 200000000000n)); // 2e11
    console.log(`\n    wrap-around capForAction(2000, 2e11) = ${cap.toString()}`);

    expect(cap > 0n, 'cap must be non-zero post wrap-around').to.equal(true);
    expect(cap < 2000n, 'cap should bind at $3B mcap equivalent price').to.equal(true);

    // Expected: (2e11 << 112) / priceUQ / 1e18 = 200.
    const expected = (200_000_000_000n << 112n) / priceUQ / (10n ** 18n);
    const diff = cap > expected ? cap - expected : expected - cap;
    console.log(`    Expected ~${expected.toString()}, got ${cap.toString()} — diff=${diff.toString()}`);
    expect(diff <= 1n, `cap should be ~${expected} (got ${cap}, diff=${diff})`).to.equal(true);
  });
});
