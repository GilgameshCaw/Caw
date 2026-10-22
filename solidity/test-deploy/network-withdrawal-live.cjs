// SPDX-License-Identifier: MIT
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const ethers=require(path.resolve(process.argv[2]));
const out=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));
async function rpc(method,params){const r=await fetch('http://127.0.0.1:18672',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(5000)});const d=await r.json();if(d.error)throw Error(JSON.stringify(d.error));return d.result;}
(async()=>{
assert.equal(await rpc('eth_chainId',[]),'0x7a69');
const [owner,other,recipient]=await rpc('eth_accounts',[]);
async function send(tx){const h=await rpc('eth_sendTransaction',[{from:owner,gas:'0xe4e1c0',...tx}]);let r;for(let i=0;i<50;i++){r=await rpc('eth_getTransactionReceipt',[h]);if(r)break;await new Promise(r=>setTimeout(r,50));}assert.ok(r);assert.equal(r.status,'0x1');return r;}
async function deploy(file,name,types,args){const a=out.contracts[file][name];const r=await send({data:'0x'+a.evm.bytecode.object+ethers.AbiCoder.defaultAbiCoder().encode(types,args).slice(2)});return {address:r.contractAddress,iface:new ethers.Interface(a.abi)};}
const swap=await deploy('WithdrawalFixture.sol','SwapRecorder',[],[]);
const network=await deploy('contracts/CawNetworkManager.sol','CawNetworkManager',['address'],[swap.address]);
const profile=await deploy('WithdrawalFixture.sol','WithdrawalFixture',['address','address'],[network.address,swap.address]);
const transaction=(c,fn,args,from=owner,value='0x0')=>send({to:c.address,from,value,data:c.iface.encodeFunctionData(fn,args)});
const read=async(c,fn,args=[])=>c.iface.decodeFunctionResult(fn,await rpc('eth_call',[{to:c.address,data:c.iface.encodeFunctionData(fn,args)},'latest']));
async function denied(c,fn,args,from,pattern){await assert.rejects(rpc('eth_call',[{to:c.address,from,data:c.iface.encodeFunctionData(fn,args)},'latest']),pattern);}
async function seed(to,amount,pool){await transaction(profile,'seed',[to,amount,pool],owner,ethers.toBeHex(amount+pool));}
const notOwner=profile.iface.getError('NotNetOwner').selector.slice(2);
await transaction(network,'createNetwork',['review',recipient,30184,100,100,100,100,100]);
await transaction(network,'lockNetworkFees',[1]);await transaction(network,'lockNetworkOwnership',[1]);
await seed(recipient,100n,100n);
await transaction(profile,'withdrawFeesFor',[1,7]);
assert.equal((await read(swap,'value'))[0],200n);assert.equal((await read(swap,'minOut'))[0],7n);
assert.equal((await read(swap,'recipient'))[0].toLowerCase(),recipient.toLowerCase());
await seed(recipient,100n,30n);await transaction(network,'finalizeNetwork',[1]);
await denied(profile,'withdrawFeesFor',[1,0],owner,new RegExp(notOwner,'i'));
await denied(profile,'withdrawFeesFor',[1,0],other,new RegExp(notOwner,'i'));
assert.equal((await read(profile,'accruedFees',[recipient]))[0],100n);
assert.equal((await read(profile,'accruedFees',[swap.address]))[0],30n);
// Real failed transaction verifies EVM rollback, not merely an eth_call.
await transaction(swap,'setReject',[true]);
const failedHash=await rpc('eth_sendTransaction',[{from:recipient,to:profile.address,gas:'0x100000',data:profile.iface.encodeFunctionData('withdrawFees',[9])}]);
let failed;for(let i=0;i<50;i++){failed=await rpc('eth_getTransactionReceipt',[failedHash]);if(failed)break;await new Promise(r=>setTimeout(r,50));}assert.ok(failed);assert.equal(failed.status,'0x0');
assert.equal((await read(profile,'accruedFees',[recipient]))[0],100n);assert.equal((await read(profile,'accruedFees',[swap.address]))[0],30n);
await transaction(swap,'setReject',[false]);await transaction(profile,'withdrawFees',[9],recipient);
assert.equal((await read(swap,'value'))[0],130n);assert.equal((await read(swap,'minOut'))[0],9n);
assert.equal((await read(swap,'recipient'))[0].toLowerCase(),recipient.toLowerCase());
assert.equal((await read(profile,'accruedFees',[recipient]))[0],0n);assert.equal((await read(profile,'accruedFees',[swap.address]))[0],0n);
// A former owner who is also the recipient keeps recipient rights only.
await transaction(network,'createNetwork',['same-role',owner,30184,100,100,100,100,100]);
await seed(owner,50n,70n);await transaction(network,'finalizeNetwork',[2]);
await denied(profile,'withdrawFeesFor',[2,1],owner,new RegExp(notOwner,'i'));
await transaction(profile,'withdrawFees',[11],owner);
assert.equal((await read(swap,'value'))[0],100n);assert.equal((await read(swap,'recipient'))[0].toLowerCase(),owner.toLowerCase());
assert.equal((await read(profile,'accruedFees',[swap.address]))[0],20n);
console.log(JSON.stringify({passed:true,preFinalizationDelegatedControl:true,postFinalizationDelegationRejected:true,recipientRightsPreserved:true,failedSwapRollback:true,partialAndSurplusProtocolPool:true,scope:'exact extracted withdrawal methods with synthetic storage/funding and swap recorder; actual candidate network manager'}));
})().catch(e=>{console.error(e);process.exitCode=1;});
