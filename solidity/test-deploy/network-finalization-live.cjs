// SPDX-License-Identifier: MIT
'use strict';
// Local Anvil only. Arguments: ethers UMD, solc standard-json output.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const ethers=require(path.resolve(process.argv[2]));
const output=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));
async function rpc(method,params){const r=await fetch('http://127.0.0.1:18672',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(5000)});const d=await r.json();if(d.error)throw Error(JSON.stringify(d.error));return d.result;}
(async()=>{
assert.equal(await rpc('eth_chainId',[]),'0x7a69');
const [owner,other,fee,sponsor,burn]=await rpc('eth_accounts',[]);
const art=output.contracts['contracts/CawNetworkManager.sol'].CawNetworkManager;
const iface=new ethers.Interface(art.abi);
async function send(tx){const h=await rpc('eth_sendTransaction',[{from:owner,gas:'0xe4e1c0',...tx}]);let receipt;for(let i=0;i<50;i++){receipt=await rpc('eth_getTransactionReceipt',[h]);if(receipt)break;await new Promise(r=>setTimeout(r,50));}assert.ok(receipt,'receipt timeout');assert.equal(receipt.status,'0x1');return receipt;}
const deployed=await send({data:'0x'+art.evm.bytecode.object+ethers.AbiCoder.defaultAbiCoder().encode(['address'],[burn]).slice(2)});
const address=deployed.contractAddress;
const tx=(fn,args,from=owner)=>send({to:address,from,data:iface.encodeFunctionData(fn,args)});
const read=async(fn,args)=>iface.decodeFunctionResult(fn,await rpc('eth_call',[{to:address,data:iface.encodeFunctionData(fn,args)},'latest']));
let rejected=0;
async function denied(fn,args,from=owner){await assert.rejects(rpc('eth_call',[{to:address,from,data:iface.encodeFunctionData(fn,args)},'latest']),/Not the owner/);rejected++;}
assert.equal((await read('networkFinalized',[999]))[0],false);
await denied('finalizeNetwork',[999]);
for(let mode=0;mode<4;mode++){
 await tx('createNetwork',['review',fee,30184,100,100,100,100,100]);
 const id=mode+1;
 await tx('addAuthorizedSponsor',[id,sponsor]);
 await tx('setGasOverride',[id,'0x12345678',1]);
 if(mode&1)await tx('lockNetworkFees',[id]);
 if(mode&2)await tx('lockNetworkOwnership',[id]);
 // Controls: both existing locks still permit sponsor and gas edits.
 if(mode===3){await tx('removeAuthorizedSponsor',[id,sponsor]);await tx('addAuthorizedSponsor',[id,sponsor]);await tx('setGasOverride',[id,'0x12345678',2]);}
 await denied('finalizeNetwork',[id],other);
 const before=await read('getNetwork',[id]);
 const receipt=await tx('finalizeNetwork',[id]);
 const event=receipt.logs.map(l=>{try{return iface.parseLog(l);}catch{return null;}}).find(e=>e?.name==='NetworkFinalized');
 assert.equal(event.args.networkId,BigInt(id));assert.equal(event.args.previousOwner.toLowerCase(),owner.toLowerCase());
 assert.equal((await read('networkFinalized',[id]))[0],true);
 assert.equal((await read('getNetworkOwner',[id]))[0],ethers.ZeroAddress);
 assert.equal((await read('networkFeesLocked',[id]))[0],true);
 assert.equal((await read('networkOwnershipLocked',[id]))[0],true);
 assert.equal((await read('isAuthorizedSponsor',[id,sponsor]))[0],true);
 assert.equal((await read('gasOverride',[id,'0x12345678']))[0],mode===3?2n:1n);
 const after=await read('getNetwork',[id]);
 for(let i=0;i<before[0].length;i++){if(i!==4)assert.equal(after[0][i],before[0][i]);}
 const calls=[['finalizeNetwork',[id]],['changeOwner',[id,other]],['setFeeAddress',[id,other]],['addAuthorizedSponsor',[id,other]],['removeAuthorizedSponsor',[id,sponsor]],['setGasOverride',[id,'0x12345678',3]],['lockNetworkFees',[id]],['lockNetworkOwnership',[id]],['setFees',[id,1,1,1,1]],['setTipTarget',[id,1]],['lowerTipCeiling',[id,50]]];
 for(const name of ['Withdraw','Deposit','Auth','Mint']){calls.push(['set'+name+'Fee',[id,1]],['lower'+name+'FeeCeiling',[id,50]]);}
 for(const [fn,args]of calls)await denied(fn,args);
 await tx('registerInstance',[id,'https://example.invalid',other],other);
 const instance=mode+1;
 await tx('updateInstance',[instance,'https://example.invalid/v2',other],other);
 await tx('deactivateInstance',[instance],other);await tx('activateInstance',[instance],other);
 assert.equal((await read('instanceActive',[instance]))[0],true);
}
console.log(JSON.stringify({passed:true,lockCombinations:4,deniedCalls:rejected,existingLockControl:true,instanceContinuity:true,scope:'real network manager on local Anvil; no CawProfile, LayerZero or production deployment'}));
})().catch(e=>{console.error(e);process.exitCode=1;});
