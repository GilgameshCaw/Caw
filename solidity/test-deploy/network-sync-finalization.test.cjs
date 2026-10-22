const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {stripTypeScriptTypes}=require('node:module');
const source=fs.readFileSync(path.resolve(__dirname,'../../client/src/services/ChainSyncService/index.ts'),'utf8');
const code=source.slice(source.indexOf('async function syncNetwork('),source.indexOf('async function syncAllNetworks('));
const zero='0x0000000000000000000000000000000000000000';
async function run(id,owner=zero,baseline=false,fail=false){
 const writes=[];const network={id,ownerAddress:owner,feeAddress:zero,mintFee:0n,depositFee:0n,withdrawFee:0n,authFee:0n,creationBlock:1n};
 const c=vm.createContext({networkManager:{getNetwork:async()=>{if(fail)throw Error('synthetic unavailable');return network;}},l1Provider:{getBlockNumber:async()=>12},prisma:{network:{upsert:async x=>writes.push(x)}},console:{log(){},error(){}},maybeRebuildProviders(){}});
 const text=baseline?code.replace('network.id === 0n || Number(network.id) !== networkId',"network.ownerAddress === '"+zero+"'"):code;
 vm.runInContext(stripTypeScriptTypes(text)+'\nglobalThis.sync=syncNetwork;',c);
 return {ok:await c.sync(1),writes};
}
test('control: baseline skips a real owner-zero network',async()=>{const r=await run(1n,zero,true);assert.equal(r.ok,false);assert.equal(r.writes.length,0);});
test('finalized network is upserted with zero owner and unchanged fee fields',async()=>{const r=await run(1n);assert.equal(r.ok,true);assert.equal(r.writes.length,1);assert.equal(r.writes[0].update.ownerAddress,zero);assert.equal(r.writes[0].update.mintFee,'0');});
test('nonexistent and mismatched IDs do not write',async()=>{for(const id of [0n,2n]){const r=await run(id);assert.equal(r.ok,false);assert.equal(r.writes.length,0);}});
test('ordinary owned networks still sync',async()=>{const r=await run(1n,'0x1111111111111111111111111111111111111111');assert.equal(r.ok,true);});
test('unavailable RPC fails without a database write',async()=>{const r=await run(1n,zero,false,true);assert.equal(r.ok,false);assert.equal(r.writes.length,0);});
