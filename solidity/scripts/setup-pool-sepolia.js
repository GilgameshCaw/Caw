/**
 * setup-pool-sepolia.js
 *
 * One-shot Sepolia bootstrap script that:
 *   1. Ensures the deployer has enough mCAW (mints from MintableCaw if short).
 *   2. Tops up the sponsor wallet with mCAW for the Population B sponsor flow.
 *   3. Creates a Uniswap V2 mCAW/WETH pair if it doesn't exist.
 *   4. Funds the pair via Router02.addLiquidityETH with the sizing chosen below.
 *   5. Records the pair address in solidity/.deploy-state.json under
 *      `external.cawWethPair` and prints a `CAW_WETH_PAIR=` line ready to
 *      paste into solidity/.env so the next deploy.js run picks it up.
 *
 * Idempotent:
 *   - mCAW mint is skipped when the balance already covers the need.
 *   - Sponsor top-up is skipped when sponsor already has the target balance.
 *   - Pair creation is skipped if the factory already has one.
 *   - Liquidity-add is skipped when the pair already has reserves >= 50% of
 *     the target sizing (so a half-failed prior run can be re-run safely).
 *
 * Re-running after a contract redeploy is harmless: the pool is independent
 * of the V2 contract addresses (only the mCAW token + Sepolia WETH matter),
 * so the same pair survives any number of CAW contract redeploys.
 *
 * Usage:
 *   node scripts/setup-pool-sepolia.js              # default sizing (0.1 ETH + 10M mCAW)
 *   node scripts/setup-pool-sepolia.js --dry-run    # show what would happen
 *
 * Prerequisites:
 *   - L1_RPC_URL + PRIVATE_KEYS in solidity/.env (same keys deploy.js uses).
 *   - Deployer has at least POOL_ETH_AMOUNT + ~0.005 ETH for gas on Sepolia.
 */

const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// ─── Constants ─────────────────────────────────────────────────────────────

const SEPOLIA_RPC = process.env.L1_RPC_URL || 'https://eth-sepolia.public.blastapi.io';

// Canonical Uniswap V2 deployment on Sepolia.
// Router resolved on first run via router.factory() / router.WETH() so the
// script self-checks if anyone updates the chain config.
const SEPOLIA_UNI_V2_ROUTER  = '0xeE567Fe1712Faf6149d80dA1E6934E354124CfE3';
const SEPOLIA_UNI_V2_FACTORY = '0xF62c03E08ada871A0bEb309762E260a7a6a880E6';
const SEPOLIA_WETH           = '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14';

// V1 mCAW. Same address on testnet across V1/V2.
const MCAW_ADDRESS = '0x56817dc696448135203C0556f702c6a953260411';

// Sponsor wallet target balance. The bootstrap flow delivers
// SPONSOR_MIN_DEPOSIT_CAW per signup (default 1M). 100M = ~100 signups
// at the floor, more if users pick larger deposits below the cap.
const SPONSOR_WALLET = '0xF71338f3eAa483aA66125598B09BA1988e694a95'; // same as deployer for now
const SPONSOR_TARGET_MCAW = ethers.parseUnits('100000000', 18); // 100M mCAW

// Pool sizing. Implied ratio: 0.1 ETH ↔ 4.8B mCAW (mainnet ratio: 1 ETH ↔ 48B CAW).
// Matches mainnet so the FE's USD math is accurate; testnet pool is small enough
// that an opportunistic drain costs the deployer ~0.1 Sepolia ETH, not real money.
const POOL_ETH_AMOUNT  = ethers.parseEther('0.1');
const POOL_MCAW_AMOUNT = ethers.parseUnits('4800000000', 18); // 4.8B mCAW

// Threshold below which we re-add liquidity (allows recovery from a half-failed run).
const POOL_REFILL_THRESHOLD_BPS = 5000; // 50% of target

// Slippage tolerance for the addLiquidityETH call. Empty pair has no slippage,
// existing pair we set min = target * (10000 - SLIPPAGE_BPS) / 10000.
const ADD_LIQ_SLIPPAGE_BPS = 500; // 5%
const ADD_LIQ_DEADLINE_S = 20 * 60; // 20 min

// ─── ABIs (minimal) ────────────────────────────────────────────────────────

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function mint(address account, uint256 amount) external',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
];

const FACTORY_ABI = [
  'function getPair(address tokenA, address tokenB) view returns (address)',
  'function createPair(address tokenA, address tokenB) returns (address)',
];

const PAIR_ABI = [
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
];

const ROUTER_ABI = [
  'function factory() view returns (address)',
  'function WETH() view returns (address)',
  'function addLiquidityETH(address token, uint amountTokenDesired, uint amountTokenMin, uint amountETHMin, address to, uint deadline) payable returns (uint amountToken, uint amountETH, uint liquidity)',
];

// ─── Helpers ───────────────────────────────────────────────────────────────

function fmt(amount, decimals = 18) {
  return ethers.formatUnits(amount, decimals);
}

function withSlippageDown(amount, bps) {
  return (amount * BigInt(10000 - bps)) / 10000n;
}

async function ensureMcawBalance(wallet, mcaw, target, dryRun) {
  const bal = await mcaw.balanceOf(wallet.address);
  if (bal >= target) {
    console.log(`  ✓ Deployer mCAW balance ${fmt(bal)} >= target ${fmt(target)} — no mint needed`);
    return;
  }
  const shortfall = target - bal;
  console.log(`  Deployer mCAW balance ${fmt(bal)} < target ${fmt(target)}; minting ${fmt(shortfall)}…`);
  if (dryRun) {
    console.log('  [dry-run] would call MintableCaw.mint(deployer, shortfall)');
    return;
  }
  const tx = await mcaw.connect(wallet).mint(wallet.address, shortfall);
  console.log(`    tx: ${tx.hash}`);
  await tx.wait();
  const after = await mcaw.balanceOf(wallet.address);
  console.log(`  ✓ Minted. Deployer now holds ${fmt(after)} mCAW`);
}

async function topUpSponsor(wallet, mcaw, sponsorAddr, target, dryRun) {
  if (sponsorAddr.toLowerCase() === wallet.address.toLowerCase()) {
    console.log(`  ✓ Sponsor wallet == deployer; the mCAW we just secured covers both roles`);
    return;
  }
  const bal = await mcaw.balanceOf(sponsorAddr);
  if (bal >= target) {
    console.log(`  ✓ Sponsor mCAW balance ${fmt(bal)} >= target ${fmt(target)} — no transfer needed`);
    return;
  }
  const shortfall = target - bal;
  console.log(`  Sponsor mCAW balance ${fmt(bal)} < target ${fmt(target)}; transferring ${fmt(shortfall)}…`);
  if (dryRun) {
    console.log(`  [dry-run] would call mCAW.transfer(${sponsorAddr}, shortfall)`);
    return;
  }
  const tx = await mcaw.connect(wallet).transfer(sponsorAddr, shortfall);
  console.log(`    tx: ${tx.hash}`);
  await tx.wait();
  console.log(`  ✓ Sponsor now holds ${fmt(await mcaw.balanceOf(sponsorAddr))} mCAW`);
}

async function ensurePair(wallet, factoryAddr, mcawAddr, wethAddr, dryRun) {
  const factory = new ethers.Contract(factoryAddr, FACTORY_ABI, wallet);
  let pair = await factory.getPair(mcawAddr, wethAddr);
  if (pair !== ethers.ZeroAddress) {
    console.log(`  ✓ Pair already exists at ${pair}`);
    return pair;
  }
  console.log(`  No pair found; creating mCAW/WETH pair…`);
  if (dryRun) {
    console.log(`  [dry-run] would call factory.createPair(${mcawAddr}, ${wethAddr})`);
    return ethers.ZeroAddress;
  }
  const tx = await factory.createPair(mcawAddr, wethAddr);
  console.log(`    tx: ${tx.hash}`);
  await tx.wait();
  pair = await factory.getPair(mcawAddr, wethAddr);
  console.log(`  ✓ Pair created at ${pair}`);
  return pair;
}

async function pairReserves(provider, pairAddr, mcawAddr) {
  if (pairAddr === ethers.ZeroAddress) return { mcaw: 0n, weth: 0n };
  const c = new ethers.Contract(pairAddr, PAIR_ABI, provider);
  const [r0, r1] = await c.getReserves();
  const t0 = await c.token0();
  if (t0.toLowerCase() === mcawAddr.toLowerCase()) {
    return { mcaw: r0, weth: r1 };
  }
  return { mcaw: r1, weth: r0 };
}

async function addLiquidity(wallet, routerAddr, mcawAddr, mcawAmount, ethAmount, dryRun) {
  const router = new ethers.Contract(routerAddr, ROUTER_ABI, wallet);
  const mcaw = new ethers.Contract(mcawAddr, ERC20_ABI, wallet);

  // Approve router to spend mCAW.
  const allowance = await mcaw.allowance(wallet.address, routerAddr);
  if (allowance < mcawAmount) {
    console.log(`  Approving router to spend ${fmt(mcawAmount)} mCAW…`);
    if (dryRun) {
      console.log(`  [dry-run] would call mCAW.approve(router, mcawAmount)`);
    } else {
      const tx = await mcaw.approve(routerAddr, ethers.MaxUint256);
      console.log(`    tx: ${tx.hash}`);
      await tx.wait();
      console.log('  ✓ Approved (unlimited)');
    }
  } else {
    console.log(`  ✓ Router already has sufficient mCAW allowance`);
  }

  // addLiquidityETH.
  const tokenMin = withSlippageDown(mcawAmount, ADD_LIQ_SLIPPAGE_BPS);
  const ethMin   = withSlippageDown(ethAmount, ADD_LIQ_SLIPPAGE_BPS);
  const deadline = Math.floor(Date.now() / 1000) + ADD_LIQ_DEADLINE_S;
  console.log(`  Adding ${fmt(mcawAmount)} mCAW + ${ethers.formatEther(ethAmount)} ETH (deadline +${ADD_LIQ_DEADLINE_S}s)…`);
  if (dryRun) {
    console.log(`  [dry-run] would call router.addLiquidityETH(...)`);
    return;
  }
  const tx = await router.addLiquidityETH(
    mcawAddr, mcawAmount, tokenMin, ethMin,
    wallet.address, deadline,
    { value: ethAmount }
  );
  console.log(`    tx: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`  ✓ Liquidity added (gasUsed ${receipt.gasUsed})`);
}

async function recordPairInState(pairAddr, dryRun) {
  const statePath = path.join(__dirname, '..', '.deploy-state.json');
  if (!fs.existsSync(statePath)) {
    console.log(`  ⚠ ${statePath} not found — skipping state record. Add CAW_WETH_PAIR=${pairAddr} to solidity/.env manually.`);
    return;
  }
  if (dryRun) {
    console.log(`  [dry-run] would set state.external.cawWethPair = ${pairAddr}`);
    return;
  }
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.external = state.external || {};
  if (state.external.cawWethPair !== pairAddr) {
    state.external.cawWethPair = pairAddr;
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
    console.log(`  ✓ Recorded pair in .deploy-state.json (external.cawWethPair)`);
  } else {
    console.log(`  ✓ Pair already recorded in .deploy-state.json`);
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  if (dryRun) console.log('[DRY-RUN MODE — no transactions will be sent]\n');

  if (!process.env.PRIVATE_KEYS) {
    throw new Error('PRIVATE_KEYS env var not set (expected in solidity/.env)');
  }
  const provider = new ethers.JsonRpcProvider(SEPOLIA_RPC);
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEYS.split(',')[0], provider);

  const network = await provider.getNetwork();
  if (network.chainId !== 11155111n) {
    throw new Error(`Expected Sepolia (chainId 11155111), got ${network.chainId}`);
  }
  const ethBal = await provider.getBalance(wallet.address);
  console.log(`Sepolia connected. Deployer ${wallet.address} (${ethers.formatEther(ethBal)} ETH)`);

  // Sanity-check the canonical Uniswap V2 addresses.
  const router = new ethers.Contract(SEPOLIA_UNI_V2_ROUTER, ROUTER_ABI, provider);
  const factory = await router.factory();
  const routerWeth = await router.WETH();
  if (factory.toLowerCase() !== SEPOLIA_UNI_V2_FACTORY.toLowerCase()) {
    throw new Error(`Router factory ${factory} != expected ${SEPOLIA_UNI_V2_FACTORY}`);
  }
  if (routerWeth.toLowerCase() !== SEPOLIA_WETH.toLowerCase()) {
    throw new Error(`Router WETH ${routerWeth} != expected ${SEPOLIA_WETH}`);
  }
  console.log(`Router  : ${SEPOLIA_UNI_V2_ROUTER}`);
  console.log(`Factory : ${SEPOLIA_UNI_V2_FACTORY}`);
  console.log(`WETH    : ${SEPOLIA_WETH}`);
  console.log(`mCAW    : ${MCAW_ADDRESS}\n`);

  const mcaw = new ethers.Contract(MCAW_ADDRESS, ERC20_ABI, provider);

  // Step 1 — ensure deployer mCAW balance covers pool + sponsor top-up.
  // We need POOL_MCAW_AMOUNT for the pool. Sponsor top-up draws from the
  // same wallet if SPONSOR_WALLET == deployer (current default).
  console.log('─── Step 1: deployer mCAW balance ───');
  const needForPool = POOL_MCAW_AMOUNT;
  const needForSponsor = SPONSOR_WALLET.toLowerCase() === wallet.address.toLowerCase()
    ? SPONSOR_TARGET_MCAW
    : 0n;
  const totalNeeded = needForPool + needForSponsor;
  await ensureMcawBalance(wallet, mcaw, totalNeeded, dryRun);

  // Step 2 — top up sponsor wallet if it's separate from deployer.
  console.log('\n─── Step 2: sponsor wallet mCAW ───');
  await topUpSponsor(wallet, mcaw, SPONSOR_WALLET, SPONSOR_TARGET_MCAW, dryRun);

  // Step 3 — ensure mCAW/WETH pair exists.
  console.log('\n─── Step 3: mCAW/WETH pair ───');
  const pairAddr = await ensurePair(wallet, SEPOLIA_UNI_V2_FACTORY, MCAW_ADDRESS, SEPOLIA_WETH, dryRun);

  // Step 4 — fund the pair if reserves are below threshold.
  console.log('\n─── Step 4: liquidity provisioning ───');
  const before = await pairReserves(provider, pairAddr, MCAW_ADDRESS);
  const threshold = (POOL_MCAW_AMOUNT * BigInt(POOL_REFILL_THRESHOLD_BPS)) / 10000n;
  if (before.mcaw >= threshold) {
    console.log(`  ✓ Pair already has ${fmt(before.mcaw)} mCAW / ${ethers.formatEther(before.weth)} WETH (>= ${POOL_REFILL_THRESHOLD_BPS / 100}% of target) — no liquidity-add needed`);
  } else {
    if (pairAddr === ethers.ZeroAddress && dryRun) {
      console.log('  [dry-run] pair doesn\'t exist yet; would addLiquidity once it does');
    } else {
      await addLiquidity(wallet, SEPOLIA_UNI_V2_ROUTER, MCAW_ADDRESS, POOL_MCAW_AMOUNT, POOL_ETH_AMOUNT, dryRun);
      const after = await pairReserves(provider, pairAddr, MCAW_ADDRESS);
      console.log(`  Reserves now: ${fmt(after.mcaw)} mCAW / ${ethers.formatEther(after.weth)} WETH`);
    }
  }

  // Step 5 — record + emit env line.
  console.log('\n─── Step 5: record pair ───');
  if (pairAddr !== ethers.ZeroAddress) {
    await recordPairInState(pairAddr, dryRun);
  }

  console.log('\n════════════════════════════════════════════════════════════════');
  console.log('Pool setup complete.');
  console.log('');
  console.log('Add this line to solidity/.env to wire CawL1PriceReader on next deploy:');
  console.log(`  CAW_WETH_PAIR=${pairAddr}`);
  console.log('');
  console.log('Then re-run `node scripts/deploy.js` from contract-support-v2 worktree.');
  console.log('The deploy script will deploy CawL1PriceReader and link it to CawProfile.');
  console.log('Also update FE addresses.ts: CAW_PAIR_ADDRESS=' + pairAddr);
  console.log('(or update deploy.js staticConsts.CAW_PAIR_ADDRESS for the Sepolia env block).');
  console.log('════════════════════════════════════════════════════════════════');
}

main().catch(e => {
  console.error('Failed:', e.message || e);
  if (e.stack) console.error(e.stack.split('\n').slice(1, 5).join('\n'));
  process.exit(1);
});
