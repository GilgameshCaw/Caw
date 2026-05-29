/**
 * Probe whether Infura's estimateGas still fails on processActions calldata.
 * Finds recent validator txs by querying ActionsProcessed events (logs) on
 * the deployed CawActions_L2 contract — covers both your local validator and
 * the VPS validator (any caller of processActions).
 */
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const STATE = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '.deploy-state.json'), 'utf8')
);
const CAW_ACTIONS = STATE.addresses.CawActions_L2;

const INFURA_URL = process.env.L2_RPC_URL;
if (!INFURA_URL) throw new Error('L2_RPC_URL not set');
const NON_INFURA_URL = 'https://base-sepolia-rpc.publicnode.com';

const infura = new ethers.JsonRpcProvider(INFURA_URL);
const publicnode = new ethers.JsonRpcProvider(NON_INFURA_URL);

const FORMULA = (n) => Math.ceil((100_000 + n * 50_000) * 1.3);

const ACTIONS_PROCESSED_TOPIC = ethers.id(
  'ActionsProcessed(uint32,uint32,uint16,bytes32)'
);

async function findRecentActionsProcessedTxs(provider, want = 10) {
  const head = await provider.getBlockNumber();
  console.log(`L2 head: ${head}`);

  const txHashes = new Set();
  // Walk back 40K blocks in 9K chunks (Infura's getLogs cap is 10K).
  for (let to = head; to > head - 40000 && txHashes.size < want; to -= 9000) {
    const from = Math.max(to - 9000 + 1, head - 40000);
    let logs = [];
    try {
      logs = await provider.send('eth_getLogs', [{
        fromBlock: '0x' + from.toString(16),
        toBlock: '0x' + to.toString(16),
        address: CAW_ACTIONS,
        topics: [ACTIONS_PROCESSED_TOPIC],
      }]);
    } catch (e) {
      console.warn(`  getLogs [${from}..${to}] failed: ${e.shortMessage || e.message}`);
      continue;
    }
    for (let i = logs.length - 1; i >= 0 && txHashes.size < want; i--) {
      txHashes.add(logs[i].transactionHash);
    }
    process.stdout.write(`\r  scanned [${from}..${to}], found ${txHashes.size} unique txs ...`);
  }
  console.log('');

  // Also find a few REVERTED validator txs to compare. We can't see those
  // via ActionsProcessed (no event emitted on revert) — skip for now and
  // only probe successful ones.

  return Array.from(txHashes).slice(0, want);
}

function decodeActionCount(data) {
  try {
    const iface = new ethers.Interface([
      'function processActions(uint32,bytes,bytes,uint256,uint256)',
      'function safeProcessActions(uint32,bytes,bytes,uint256,uint256)',
      'function processActionsWithZkSigs(uint32,bytes,bytes,bytes,bytes,uint256,uint256)',
      'function processActionsERC1271(uint32,bytes,bytes[],bytes32[],uint256,uint256)',
    ]);
    const decoded = iface.parseTransaction({ data });
    if (!decoded) return null;
    const packedActions = decoded.args[1];
    if (typeof packedActions !== 'string' || packedActions.length < 6) return null;
    return parseInt(packedActions.slice(2, 6), 16);
  } catch { return null; }
}

async function probeEstimateGas(provider, tx) {
  const t0 = Date.now();
  try {
    const parentBlock = `0x${(tx.blockNumber - 1).toString(16)}`;
    const result = await provider.send('eth_estimateGas', [
      {
        from: tx.from, to: tx.to, data: tx.data,
        value: '0x' + tx.value.toString(16),
      },
      parentBlock,
    ]);
    return { ok: true, gas: BigInt(result), ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, error: (e.shortMessage || e.message || String(e)).slice(0, 100), ms: Date.now() - t0 };
  }
}

async function main() {
  console.log('CawActions_L2:    ', CAW_ACTIONS);
  console.log('Infura RPC:       ', INFURA_URL.replace(/\/v3\/[^/]+/, '/v3/<hidden>'));
  console.log('Non-Infura RPC:   ', NON_INFURA_URL);
  console.log('');

  const txHashes = await findRecentActionsProcessedTxs(infura, 10);
  if (txHashes.length === 0) {
    console.error('No ActionsProcessed events found.');
    process.exit(1);
  }
  console.log(`Found ${txHashes.length} txs to probe.\n`);

  for (const hash of txHashes) {
    const tx = await infura.getTransaction(hash);
    const receipt = await infura.getTransactionReceipt(hash);
    if (!tx || !receipt) continue;

    const actionCount = decodeActionCount(tx.data);
    const formulaGas = actionCount != null ? FORMULA(actionCount) : null;
    const status = receipt.status === 1 ? 'OK' : 'REVERT';
    const actualGas = Number(receipt.gasUsed);
    const calldataBytes = (tx.data.length - 2) / 2;

    const txProbeInput = {
      from: tx.from, to: tx.to, data: tx.data, value: tx.value, blockNumber: receipt.blockNumber,
    };
    const infuraProbe = await probeEstimateGas(infura, txProbeInput);
    const publicProbe = await probeEstimateGas(publicnode, txProbeInput);

    console.log(`tx ${hash.slice(0, 14)} block ${receipt.blockNumber} ${status} from=${tx.from.slice(0, 10)}`);
    console.log(`  actionCount=${actionCount ?? '?'}  calldataBytes=${calldataBytes}  actualGas=${actualGas}  formula=${formulaGas ?? '?'}`);
    console.log(`  infura.estGas:     ${infuraProbe.ok ? infuraProbe.gas.toString() : 'FAIL: ' + infuraProbe.error}  (${infuraProbe.ms}ms)`);
    console.log(`  publicnode.estGas: ${publicProbe.ok ? publicProbe.gas.toString() : 'FAIL: ' + publicProbe.error}  (${publicProbe.ms}ms)`);
    if (infuraProbe.ok && actualGas) {
      const h = Number(infuraProbe.gas) - actualGas;
      console.log(`  infura headroom: ${h} (${(h*100/actualGas).toFixed(1)}%)`);
    }
    if (formulaGas && actualGas) {
      const h = formulaGas - actualGas;
      console.log(`  formula headroom: ${h} (${(h*100/actualGas).toFixed(1)}%)${h < 0 ? '   ← FORMULA UNDERFUNDED' : ''}`);
    }
    console.log('');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
