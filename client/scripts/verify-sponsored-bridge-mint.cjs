// node --require tsx/cjs scripts/verify-sponsored-bridge-mint.cjs PORT FOUNDRY_OUT
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { AbiCoder, ContractFactory, JsonRpcProvider, Wallet, ZeroAddress, ZeroHash,
  getCreateAddress, zeroPadValue, dataLength } = require('ethers')
const [port, out] = process.argv.slice(2)
assert.match(port, /^\d+$/)
const url = 'http://127.0.0.1:' + port
const rpc = new JsonRpcProvider(url)
rpc.pollingInterval = 80
const amount = 10n**18n, username = 'servicecheck', dst = 40245
const types = ['uint32','uint32','uint256','string','address','uint64','uint256','uint64','uint32[]','address[]','uint128[]']
async function run() {
  assert.match(await rpc.send('web3_clientVersion',[]),/anvil/i)
  assert.equal((await rpc.getNetwork()).chainId,11155111n)
  const operator = await rpc.getSigner()
  const libraries = new Map()
  async function deploy(name,args=[],file=name) {
    const a = JSON.parse(fs.readFileSync(path.join(out,file+'.sol',name+'.json')))
    let code = a.bytecode.object
    for (const names of Object.values(a.bytecode.linkReferences ?? {})) {
      for (const [name, offsets] of Object.entries(names)) {
        const address = libraries.get(name)
        assert.ok(address,name)
        for (const {start,length} of offsets) {
          const i = 2+start*2
          code = code.slice(0,i)+address.slice(2)+code.slice(i+length*2)
        }
      }
    }
    return (await new ContractFactory(a.abi,code,operator).deploy(...args)).waitForDeployment()
  }
  async function mine(tx) { assert.equal((await (await tx).wait()).status,1) }
  const token = await deploy('E2EMockCAW',[],'PopBBootstrapE2E.t')
  const router = await deploy('MockSwapRouter',[token.target])
  const manager = await deploy('CawNetworkManager',[router.target])
  await mine(manager.createNetwork('mint',operator.address,dst,0,0,0,0,500000000000n))
  const source = await deploy('MockLayerZeroEndpoint',[1])
  const remote = await deploy('MockLayerZeroEndpoint',[dst])
  const smart = await deploy('SmartEOA')
  libraries.set('SessionMessageParser',(await deploy('SessionMessageParser')).target)
  const nonce = await rpc.send('eth_getTransactionCount',[operator.address,'pending'])
  const predict = i => getCreateAddress({from:operator.address,nonce:BigInt(nonce)+BigInt(i)})
  const profile = await deploy('CawProfile',[token.target,ZeroAddress,operator.address,manager.target,
    source.target,1,ZeroAddress,predict(2),operator.address,predict(1)])
  const minter = await deploy('CawProfileMinter',[token.target,profile.target,router.target,operator.address])
  const ledger = await deploy('CawProfileLedger',[1,remote.target,ZeroAddress,profile.target,
    operator.address,operator.address,false,operator.address])
  assert.equal(minter.target,predict(1)); assert.equal(ledger.target,predict(2))
  await mine(profile.setPeer(dst,zeroPadValue(ledger.target,32)))
  assert.equal(await ledger.peers(1),zeroPadValue(profile.target,32).toLowerCase())
  await mine(source.setDestLzEndpoint(ledger.target,remote.target))
  const sponsor = Wallet.createRandom().connect(rpc), user = Wallet.createRandom()
  const burn = await minter.costOfName(username)
  await mine(operator.sendTransaction({to:sponsor.address,value:amount}))
  await mine(token.mint(sponsor.address,burn+amount))
  await mine(token.connect(sponsor).approve(minter.target,burn+amount))
  const permitFields = ['uint32 networkId','address recipient','string username','uint256 depositAmount',
    'uint32 lzDestId','uint256 lzTokenAmount','uint256 nonce','uint8 kycLevel','uint32 sponsorTokenId','uint256 repayAmount']
  const permitSig = await user.signTypedData({name:'CawProfileMinter',version:'1',chainId:11155111,
    verifyingContract:minter.target},{MintAndDeposit:permitFields.map(field=>{
      const [type,name]=field.split(' '); return {name,type}
    })},{networkId:1,recipient:user.address,username,depositAmount:amount,lzDestId:dst,lzTokenAmount:0,
      nonce:0,kycLevel:0,sponsorTokenId:0,repayAmount:0})
  const auth = await user.authorize({address:smart.target,chainId:11155111,nonce:0})
  // Only indexer/database dependencies are substituted. Capture, then forward, the service RPC.
  for (const [file,exports] of [['../src/prismaClient.ts',{prisma:{}}],
    ['../src/api/util/indexerPoke.ts',{pokeIndexTokenId(){}}]]) {
    const filename=require.resolve(file); require.cache[filename]={id:filename,filename,loaded:true,exports}
  }
  const {SponsorService} = require('../src/services/SponsorService/index.ts')
  let quote, quoteArgs
  const send = JsonRpcProvider.prototype.send
  JsonRpcProvider.prototype.send = async function(method,params) {
    const reply = await send.call(this,method,params)
    if (method==='eth_call' && params[0].to?.toLowerCase()===profile.target.toLowerCase() &&
      params[0].data.startsWith(profile.interface.getFunction('lzQuote').selector)) {
      quoteArgs=profile.interface.decodeFunctionData('lzQuote',params[0].data)
      quote=profile.interface.decodeFunctionResult('lzQuote',reply)[0].nativeFee
    }
    return reply
  }
  let result
  try {
    const service = new SponsorService({l1ProviderUrl:url,l1ChainId:11155111,sponsorPrivateKey:sponsor.privateKey,
    minterAddress:minter.target,cawProfileAddress:profile.target,smartEoaAddress:smart.target,maxLzFeeWei:amount/100n})
    result=await service.sponsorBootstrap({authTupleNonce:0n,authTupleSignature:auth.signature,username,
      depositAmountCAW:amount,networkId:1,lzDestId:dst,lzTokenAmount:0n,passkeyPubkeyX:ZeroHash,
      passkeyPubkeyY:ZeroHash,ecdsaFallbackAddr:user.address,permitSig,permitNonce:0n})
  } finally { JsonRpcProvider.prototype.send=send }
  assert.ok(result.txHash, JSON.stringify(result))
  const receipt=await rpc.getTransactionReceipt(result.txHash), tx=await rpc.getTransaction(result.txHash)
  assert.equal(receipt.status,1); assert.equal(tx.type,4); assert.equal(tx.from,sponsor.address)
  const tokenId=await minter.idByUsername(username)
  assert.equal(tokenId,BigInt(result.tokenId))
  assert.equal(await profile.ownerOf(tokenId),user.address)
  assert.equal(await ledger.ownerOf(tokenId),user.address)
  assert.equal(await ledger.usernames(tokenId),username)
  assert.equal(await ledger.totalCaw(),amount)
  assert.equal(await ledger.cawBalanceOf(tokenId),amount)
  assert.equal(await token.balanceOf(profile.target),amount)
  assert.equal(await token.balanceOf('0xdead000000000000000042069420694206942069'),burn)
  const trace=await rpc.send('debug_traceTransaction',[tx.hash,{tracer:'callTracer'}])
  function flatten(call) { return [call,...(call.calls??[]).flatMap(flatten)] }
  const sends=flatten(trace).filter(c=>c.to?.toLowerCase()===source.target.toLowerCase() &&
    c.input.startsWith(source.interface.getFunction('send').selector))
  assert.equal(sends.length,1)
  const call=sends[0], [packet,refundTo]=source.interface.decodeFunctionData('send',call.input)
  const fee=source.interface.decodeFunctionResult('send',call.output)[0].fee.nativeFee
  assert.ok(quoteArgs, "missing service quote")
  const quoted=quoteArgs[3], actual='0x'+packet.message.slice(2+36*2)
  assert.equal(packet.dstEid,BigInt(dst)); assert.equal(packet.receiver,zeroPadValue(ledger.target,32).toLowerCase())
  assert.equal(refundTo,user.address); assert.equal(quote,fee); assert.ok(fee>0n)
  assert.equal(BigInt(call.value),quote*120n/100n); assert.equal(tx.value,BigInt(call.value))
  assert.equal(await rpc.getBalance(user.address,receipt.blockNumber),tx.value-fee)
  assert.equal(dataLength(actual),dataLength(quoted)); assert.equal(actual.slice(0,10),quoteArgs[1])
  const decode=p=>AbiCoder.defaultAbiCoder().decode(types,'0x'+p.slice(10))
  const [q,m]=[decode(quoted),decode(actual)]
  assert.equal(quoteArgs[2],1n)
  assert.equal(actual.slice(0,10),await profile.ownershipBundleSelector())
  for (const i of [0,2,3,4,5,6,7]) assert.equal(q[i],m[i])
  assert.deepEqual([...q[8]],[0n]); assert.deepEqual([...q[9]],[user.address])
  assert.equal(m[10][0] & ((1n<<64n)-1n),1n)
  assert.equal(q[1],0n); assert.equal(m[1],tokenId)
  assert.equal(q[3],username); assert.equal(m[3],username); assert.equal(m[2],amount)
  assert.deepEqual([...m[8]],[tokenId]); assert.deepEqual([...m[9]],[user.address])
  console.log(JSON.stringify({transaction:tx.hash,block:receipt.blockNumber,tokenId:String(tokenId),
    wireBytes:dataLength(packet.message),quotedBundleBytes:dataLength(quoted),actualBundleBytes:dataLength(actual),
    quoteWei:String(quote),chargedWei:String(fee),forwardedWei:String(tx.value),refundWei:String(tx.value-fee),
    ledgerCredit:String(amount),verdict:'PASS'}))
}
run().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>rpc.destroy())
