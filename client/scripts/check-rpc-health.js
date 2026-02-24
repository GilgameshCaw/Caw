require('dotenv').config();
const { ethers } = require('ethers');

async function checkRPCHealth() {
  const wsUrl = process.env.L2_RPC_URL;
  const httpUrl = process.env.L2_RPC_URL_HTTP;

  if (!wsUrl || !httpUrl) {
    console.error('Missing L2_RPC_URL or L2_RPC_URL_HTTP in environment variables');
    process.exit(1);
  }

  const rpcUrls = [wsUrl, httpUrl];

  for (const url of rpcUrls) {
    console.log(`\nTesting RPC: ${url.replace(/\/v3\/.*/, '/v3/[API_KEY]')}`);
    console.log('=' .repeat(60));

    const isWs = url.startsWith('ws');
    const provider = isWs
      ? new ethers.WebSocketProvider(url)
      : new ethers.JsonRpcProvider(url);

    try {
      // Test 1: Get block number
      const startTime = Date.now();
      const blockNumber = await Promise.race([
        provider.getBlockNumber(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Timeout after 10s')), 10000)
        )
      ]);
      const elapsed = Date.now() - startTime;
      console.log(`✅ Block number: ${blockNumber} (${elapsed}ms)`);

      // Test 2: Get network info
      const network = await Promise.race([
        provider.getNetwork(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Timeout after 10s')), 10000)
        )
      ]);
      console.log(`✅ Network: ${network.name} (chainId: ${network.chainId})`);

      // Test 3: Simulate a simple call (check balance of zero address)
      const callStart = Date.now();
      const balance = await Promise.race([
        provider.getBalance('0x0000000000000000000000000000000000000000'),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Timeout after 10s')), 10000)
        )
      ]);
      const callElapsed = Date.now() - callStart;
      console.log(`✅ Balance call: ${ethers.formatEther(balance)} ETH (${callElapsed}ms)`);

    } catch (error) {
      console.log(`❌ Error: ${error.message}`);
    } finally {
      if (isWs && provider.destroy) {
        await provider.destroy();
      }
    }
  }

  console.log('\n' + '=' .repeat(60));
  console.log('RPC Health Check Complete');
}

checkRPCHealth().then(() => process.exit(0)).catch(console.error);