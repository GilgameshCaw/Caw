const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {stripTypeScriptTypes}=require('node:module');
const {Contract,Interface,id}=require(process.env.CAW_ETHERS_PACKAGE || 'ethers');
const source=fs.readFileSync(path.resolve(__dirname,'../../client/src/services/ChainSyncService/index.ts'),'utf8');
const abi=source.slice(source.indexOf('const NETWORK_FEE_EVENT_ABI ='),source.indexOf('const L1_FEE_SYNC_BLOCK_KEY'));
const fn=source.slice(source.indexOf('async function syncL1FeeEvents()'),source.indexOf('// Task Management'));
async function run(mode){let checkpoint=10;const queries=[],refreshes=[];
 const c=vm.createContext({console:{log(){},error(){}},l1Provider:{getBlockNumber:async()=>11},NETWORK_MANAGER_ADDRESS:'0x1111111111111111111111111111111111111111',L1_FEE_EVENT_CHUNK_SIZE:2000,L1_FEE_EVENT_BOOTSTRAP_LOOKBACK:50000,
 getLastSyncedL1FeeBlock:async()=>checkpoint,setLastSyncedL1FeeBlock:async n=>{checkpoint=n;},syncNetwork:async n=>{refreshes.push(n);return mode!=='refresh-fails';},
 Contract:function(address,fragments){const contract=new Contract(address,fragments);contract.queryFilter=async(filter,from,to)=>{assert.deepEqual([from,to],[11,11]);const topics=await filter.getTopicFilter();queries.push(topics[0]);if(topics[0]!==id('NetworkFinalized(uint32,address)'))return [];if(mode==='query-fails')throw Error('synthetic query failure');if(mode==='no-event')return [];const event=contract.interface.getEvent('NetworkFinalized');const log=contract.interface.encodeEventLog(event,[1,'0x2222222222222222222222222222222222222222']);return [{blockNumber:11,index:0,args:mode==='missing-args'?undefined:mode==='invalid-id'?{networkId:0}:contract.interface.parseLog(log).args}];};return contract;}
 });
 vm.runInContext(stripTypeScriptTypes(abi+fn)+'\nglobalThis.run=syncL1FeeEvents;',c);await c.run();return {checkpoint,refreshes,queries};
}
test('real ethers topic/decode routes finalization to refresh before checkpoint',async()=>{const r=await run('ok');assert.equal(r.checkpoint,11);assert.deepEqual(r.refreshes,[1]);assert.equal(r.queries.length,7);});
for(const mode of ['refresh-fails','query-fails','missing-args','invalid-id'])test('holds checkpoint on '+mode,async()=>{assert.equal((await run(mode)).checkpoint,10);});
test('older contract without finalization events still advances empty range',async()=>{const r=await run('no-event');assert.equal(r.checkpoint,11);assert.equal(r.refreshes.length,0);});
