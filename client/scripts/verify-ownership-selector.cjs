// Run with node --require tsx/cjs from client/. Use a fresh loopback Anvil only.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { JsonRpcProvider, ContractFactory, Contract, ZeroAddress, version, id } = require('ethers')
const { ownershipBundleSelector } = require('../src/utils/ownershipBundleSelector.ts')

async function main() {
  const [port, baseOut, updatedOut] = process.argv.slice(2)
  assert.match(port, /^\d+$/)
  const provider = new JsonRpcProvider('http://127.0.0.1:' + port)
  try {
    assert.match(await provider.send('web3_clientVersion', []), /anvil/i)
    assert.equal((await provider.getNetwork()).chainId, 31337n)
    const signer = await provider.getSigner(0)
    const deploy = async (out, name, args) => {
      const a = JSON.parse(fs.readFileSync(path.join(out, name + '.sol', name + '.json')))
      if (name === 'CawProfile') {
        const metadata = typeof a.metadata === 'string' ? JSON.parse(a.metadata) : a.metadata
        const expected = out === baseOut ? '0xc864c9a86de90e7afc69fc8b284de78164ccbbc29c3594086dc4cb2cd0da9e1f' :
          '0x0cf32dff492e393cfdc9a75977d6d5ba0f61988b51bfc7b39b544d0b9bc9fb7a'
        assert.equal(metadata.sources['contracts/CawProfile.sol'].keccak256, expected)
      }
      const c = await new ContractFactory(a.abi, a.bytecode.object, signer).deploy(...args)
      await c.waitForDeployment()
      return c.target
    }
    const endpoint = await deploy(updatedOut, 'MockLayerZeroEndpoint', [1])
    const args = [ZeroAddress, ZeroAddress, ZeroAddress, ZeroAddress, endpoint, 1,
      ZeroAddress, ZeroAddress, signer.address, signer.address]
    const abi = ['function ownershipBundleSelector() view returns(bytes4)',
      'function name() view returns(string)', 'function symbol() view returns(string)']
    for (const [out, stamp] of [[baseOut,'uint64'],[updatedOut,'uint128']]) {
      const profile = new Contract(await deploy(out,'CawProfile',args),abi,provider)
      if (out === baseOut) await assert.rejects(profile.ownershipBundleSelector(),
        err => err.code === 'BAD_DATA' && err.value === '0x')
      const expected = id('lzDepositMintSession(uint32,uint32,uint256,string,address,uint64,uint256,uint64,uint32[],address[],' + stamp + '[])').slice(0,10)
      assert.equal(await ownershipBundleSelector(profile), expected)
      console.log(stamp, expected)
    }
    await assert.rejects(ownershipBundleSelector(new Contract(signer.address,abi,provider)), {code:'BAD_DATA'})
    await assert.rejects(ownershipBundleSelector({ownershipBundleSelector:async ()=>'0xffffffff'}), /Unsupported/)
    for (const error of [{code:'NETWORK_ERROR'}, {code:'BAD_DATA',value:'0x12'},
      {code:'CALL_EXCEPTION',data:'0x12345678'}]) {
      await assert.rejects(ownershipBundleSelector({ownershipBundleSelector:async()=>{throw error}}), e=>e===error)
    }
    console.log('PASS ethers', version)
  } finally { provider.destroy() }
}
main().catch(err=>{ console.error(err); process.exitCode=1 })
