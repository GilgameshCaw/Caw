const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {stripTypeScriptTypes}=require('node:module');
const {Contract}=require(process.env.CAW_ETHERS_PACKAGE || 'ethers');
const source=fs.readFileSync(process.env.CAW_REPLAY_SOURCE || path.resolve(__dirname,'../../client/src/services/ChainSyncService/index.ts'),'utf8').replace(/\r\n/g,'\n');
const block=source.slice(source.indexOf('const NETWORK_FEE_EVENT_ABI ='),source.indexOf('// Task Management'));
const zero='0x0000000000000000000000000000000000000000',owner='0x1111111111111111111111111111111111111111';
async function scenario(failure,baseline=false,finalize=false){
 let cp=10,row=null,reject=true;const writes=[];
 const context=vm.createContext({console:{log(){},error(){},warn(){}},NETWORK_MANAGER_ADDRESS:owner,l1Provider:{getBlockNumber:async()=>11},syncNetwork:async()=>{if(reject&&failure==='finalize')return false;row={...row,ownerAddress:zero,mintFee:'9'};return true;},
 prisma:{chainData:{findUnique:async()=>({value:{block:cp}}),upsert:async x=>{cp=x.update.value.block;}},network:{upsert:async x=>{writes.push('created');if(reject&&failure==='create')throw Error('synthetic write failure');row={...(row?x.update:x.create)};},update:async x=>{writes.push(Object.keys(x.data)[0]);if(reject&&((failure==='fee'&&'mintFee' in x.data)||(failure==='ceiling'&&'mintFeeCeiling' in x.data)))throw Error('synthetic write failure');if(!row)throw Object.assign(Error('missing'),{code:'P2025'});Object.assign(row,x.data);}}},
 Contract:function(address,abi){const c=new Contract(address,abi);c.queryFilter=async filter=>{const topics=await filter.getTopicFilter();const e=c.interface.getEvent(topics[0]);let args,index;
 if(e.name==='NetworkCreated'){args=[1,[1,30184,'review',owner,owner,1,2,3,4,10,11,12,13,14,15,16]];index=0;}
 else if(e.name==='NetworkFeeUpdated'){args=[1,'mint',9];index=1;}
 else if(e.name==='MintFeeCeilingLowered'){args=[1,14,12];index=2;}
 else if(e.name==='NetworkFinalized'&&finalize){args=[1,owner];index=3;}else return [];
 const log=c.interface.encodeEventLog(e,args);return [{blockNumber:11,index,args:c.interface.parseLog(log).args,transactionHash:'synthetic'}];};return c;}
 });
 // Baseline control removes only the three new error-propagation statements.
 if(baseline)assert.equal((block.match(/\n\s+throw err\n/g)||[]).length,3);
 const text=baseline?block.replace(/\n\s+throw err\n/g,'\n'):block;
 vm.runInContext(stripTypeScriptTypes(text)+'\nglobalThis.run=syncL1FeeEvents;',context);
 await context.run();const first={cp,row:row?{...row}:null};reject=false;await context.run();return {first,cp,row,writes};
}
test('ordered creation and fee/ceiling events are retained',async()=>{const r=await scenario('none');assert.equal(r.cp,11);assert.equal(r.row.mintFee,'9');assert.equal(r.row.mintFeeCeiling,12n);});
for(const failure of ['create','fee','ceiling'])test('failed '+failure+' write holds range and retries successfully',async()=>{const r=await scenario(failure);assert.equal(r.first.cp,10);assert.equal(r.cp,11);assert.equal(r.row.mintFee,'9');assert.equal(r.row.mintFeeCeiling,12n);});
test('baseline control advances cursor after a rejected creation write',async()=>{const r=await scenario('create',true);assert.equal(r.first.cp,11);assert.equal(r.row,null);});
if(process.env.CAW_REPLAY_SOURCE){
 test('combined finalization follows creation and fee events',async()=>{const r=await scenario('none',false,true);assert.equal(r.cp,11);assert.equal(r.row.ownerAddress,zero);assert.equal(r.row.mintFee,'9');});
 test('combined refresh failure holds cursor and replay restores finalized state',async()=>{const r=await scenario('finalize',false,true);assert.equal(r.first.cp,10);assert.equal(r.cp,11);assert.equal(r.row.ownerAddress,zero);});
}
