// Run each version in a new process to isolate ChainSync's in-memory cache.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { ContractFactory, JsonRpcProvider, Wallet, ZeroAddress, ZeroHash, zeroPadValue, id, Interface } = require('ethers')
const [port, version, out, fixtureOut] = process.argv.slice(2)
assert.match(port, /^\d+$/)
assert.ok(['base','generation'].includes(version))
const url = 'http://127.0.0.1:' + port
const provider = new JsonRpcProvider(url)
function replaceModule(file, exports) {
  const filename = require.resolve(file)
  require.cache[filename] = { id: filename, filename, loaded: true, exports }
}
async function run() {
  assert.match(await provider.send('web3_clientVersion', []), /anvil/i)
  assert.equal((await provider.getNetwork()).chainId, 11155111n)
  const signer = await provider.getSigner()
  const deploy = async (name, args, dir = fixtureOut) => {
    const artifact = JSON.parse(fs.readFileSync(path.join(dir,name+'.sol',name+'.json')))
    if (name === 'CawProfile') {
      const meta = typeof artifact.metadata === 'string' ? JSON.parse(artifact.metadata) : artifact.metadata
      assert.equal(meta.sources['contracts/CawProfile.sol'].keccak256, version === 'base'
        ? '0xc864c9a86de90e7afc69fc8b284de78164ccbbc29c3594086dc4cb2cd0da9e1f'
        : '0x0cf32dff492e393cfdc9a75977d6d5ba0f61988b51bfc7b39b544d0b9bc9fb7a')
    }
    const c = await new ContractFactory(artifact.abi,artifact.bytecode.object,signer).deploy(...args)
    return c.waitForDeployment()
  }
  const manager = await deploy('CawNetworkManager',[signer.address])
  const endpoint = await deploy('MockLayerZeroEndpoint',[1])
  const profile = await deploy('CawProfile',[ZeroAddress,ZeroAddress,ZeroAddress,manager.target,
    endpoint.target,1,ZeroAddress,ZeroAddress,signer.address,signer.address],out)
  await (await profile.setPeer(40245,zeroPadValue(signer.address,32))).wait()
  const router = await deploy('MockSwapRouter',[signer.address])
  const minter = await deploy('CawProfileMinter',[signer.address,profile.target,router.target,signer.address])
  const sponsor = Wallet.createRandom(), user = Wallet.createRandom()
  await (await signer.sendTransaction({to:sponsor.address,value:10n**18n})).wait()
  // Replace only the installation's address table and unrelated DB/indexer dependencies.
  const addresses = require('../src/abi/addresses.ts')
  replaceModule('../src/abi/addresses.ts',{...addresses,CAW_NAMES_ADDRESS:profile.target,NETWORK_MANAGER_ADDRESS:manager.target})
  replaceModule('../src/prismaClient.ts',{prisma:{chainData:{findUnique:async()=>null},$disconnect:async()=>{}}})
  replaceModule('../src/api/util/indexerPoke.ts',{})
  for (const key of Object.keys(process.env)) if (/^(L[12]_RPC|ETH_MAINNET_RPC|LZ_QUOTE_)/.test(key)) delete process.env[key]
  const sync = require('../src/services/ChainSyncService/index.ts')
  const { SponsorService } = require('../src/services/SponsorService/index.ts')
  const iface = new Interface(require('../src/abi/generated.ts').cawProfileAbi)
  const selector = version === 'base' ? '0xe179bcce' : '0x1010d949'
  const quotes = []
  const send = JsonRpcProvider.prototype.send
  JsonRpcProvider.prototype.send = async function(method, params) {
    const result = await send.call(this,method,params)
    if (method === 'eth_call' && params[0].to?.toLowerCase() === profile.target.toLowerCase()
      && params[0].data.startsWith(iface.getFunction('lzQuote').selector)) {
      const args = iface.decodeFunctionData('lzQuote',params[0].data)
      assert.equal(args[1],selector)
      assert.equal(args[3].slice(0,10),selector)
      quotes.push(iface.decodeFunctionResult('lzQuote',result)[0].nativeFee)
    }
    return result
  }
  const service = sync.chainSyncService.start({l1RpcUrl:url},{declareLoop(){},heartbeat(){}})
  try {
    await service.started
    const cache = await sync.ensureFreshLzDepositFeeCache(0)
    assert.ok(quotes.length && cache?.nativeFeeWei > 0n)
    assert.equal(cache.nativeFeeWei,quotes.at(-1))
    const count = quotes.length
    // A deliberately low cap exercises the actual post-quote decision without a sponsored send.
    const bootstrap = new SponsorService({l1ProviderUrl:url,l1ChainId:11155111,
      sponsorPrivateKey:sponsor.privateKey,smartEoaAddress:signer.address,
      cawProfileAddress:profile.target,minterAddress:minter.target,maxLzFeeWei:1n})
    const auth = await user.authorize({address:signer.address,chainId:11155111,nonce:0})
    const result = await bootstrap.sponsorBootstrap({authTupleNonce:0n,authTupleSignature:auth.signature,
      username:'servicecheck',depositAmountCAW:10n**18n,networkId:1,lzDestId:40245,lzTokenAmount:0n,
      passkeyPubkeyX:ZeroHash,passkeyPubkeyY:ZeroHash,ecdsaFallbackAddr:user.address,permitSig:'0x',permitNonce:0n})
    assert.equal(result.error,'LZ_FEE_TOO_LARGE',JSON.stringify(result))
    assert.equal(quotes.length,count+1)
    const padded = quotes.at(-1)*120n/100n
    assert.ok(result.detail.includes(' '+padded+' exceeds '))
    assert.equal(await provider.getTransactionCount(sponsor.address),0)
    console.log('PASS',version,selector,'cacheWei='+cache.nativeFeeWei,'sponsorPaddedWei='+padded)
  } finally { await service.stop(); JsonRpcProvider.prototype.send = send }
}
run().then(()=>process.exitCode=0).catch(e=>{console.error(e);process.exitCode=1}).finally(()=>provider.destroy())
