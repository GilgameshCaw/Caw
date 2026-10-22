const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {stripTypeScriptTypes} = require('node:module');
const {Contract} = require(process.env.CAW_ETHERS_PACKAGE || 'ethers');
const source = fs.readFileSync(process.env.CAW_L2_SOURCE || path.resolve(__dirname,'../../client/src/services/ChainSyncService/index.ts'),'utf8').replace(/\r\n/g,'\n');
const block = source.slice(source.indexOf('const CAW_NAME_L2_EVENT_ABI'),source.indexOf('const NETWORK_FEE_EVENT_ABI'));
const owner = '0x1111111111111111111111111111111111111111';
const key = '0x2222222222222222222222222222222222222222';
async function scenario(failure, baseline = false, reverse = false, interleaveSpend = false) {
  let cursor = 10, reject = true, session = null, authenticated = false;
  let inTransaction=false;
  let transactionClient;
  const atomic=!process.env.CAW_L2_SOURCE;
  const context = vm.createContext({
    console: {log(){},warn(){},error(){}}, CAW_NAMES_L2_ADDRESS: owner,
    l2Provider: {getBlockNumber: async()=>11}, maybeRebuildProviders(){},
    prisma: {
      $transaction:async callback=>{const snapshot={cursor,session:session?{...session}:null,authenticated};inTransaction=true;try{return await callback(transactionClient);}catch(error){cursor=snapshot.cursor;session=snapshot.session;authenticated=snapshot.authenticated;throw error;}finally{inTransaction=false;}},
      chainData: {findUnique:async()=>({value:{block:cursor}}),upsert:async x=>{if(reject&&failure==='checkpoint')throw Error('synthetic checkpoint failure');cursor=x.update.value.block;}},
      user: {findFirst:async()=>null},
      sessionKey: {
        upsert:async x=>{if(reject&&failure==='create')throw Error('synthetic creation write failure');session=session?{...session,...x.update}:{...x.create,revokedAt:null,spent:'0'};},
        updateMany:async x=>{if(reject&&failure==='revoke')throw Error('synthetic revocation write failure');if(session)Object.assign(session,x.data);return {count:session?1:0};}
      },
      networkAuth: {upsert:async()=>{if(reject&&failure==='auth')throw Error('synthetic authentication write failure');authenticated=true;}}
    },
    Contract:function(address,abi){
      const c=new Contract(address,abi);
      c.queryFilter=async filter=>{
        const [topic]=await filter.getTopicFilter();const event=c.interface.getEvent(topic);
        const created=event.name==='SessionCreated', revoked=event.name==='SessionRevoked';
        if(interleaveSpend && revoked)return [];
        const args=created?[owner,key,999999,1,100,0]:revoked?[owner,key]:[1,2];
        const index=created?(reverse?1:0):revoked?(reverse?0:1):2;
        const log=c.interface.encodeEventLog(event,args);
        return [{blockNumber:11,index,args:c.interface.parseLog(log).args}];
      };return c;
    }
  });
  transactionClient=context.prisma;
  context.prisma=new Proxy(transactionClient,{get(target,key){if(inTransaction)throw Error("global client used inside transaction");return target[key];}});
  assert.equal((block.match(/\n    throw err/g)||[]).length,3);
  const text=baseline?block.replace(/\n    throw err/g,''):block;
  vm.runInContext(stripTypeScriptTypes(text)+'\nglobalThis.run=syncL2Events;',context);
  await context.run();const first={cursor,session:session?{...session}:null,authenticated};
  if(interleaveSpend && session)session.spent='25';
  reject=false;await context.run();return {first,cursor,session,authenticated,atomic};
}
test('creation then revocation ends revoked',async()=>{const r=await scenario('none');assert.equal(r.cursor,11);assert.ok(r.session.revokedAt);assert.equal(r.authenticated,true);});
test('revocation then recreation ends active',async()=>{const r=await scenario('none',false,true);assert.equal(r.cursor,11);assert.equal(r.session.revokedAt,null);});
for(const failure of ['create','revoke','auth','checkpoint'])test(failure+' write failure holds checkpoint and retries',async()=>{const r=await scenario(failure);assert.equal(r.first.cursor,10);if(r.atomic){assert.equal(r.first.session,null);assert.equal(r.first.authenticated,false);}assert.equal(r.cursor,11);assert.ok(r.session.revokedAt);assert.equal(r.authenticated,true);});

test('failed range exposes no partial creation before retry',async()=>{
  const r=await scenario('auth',false,false,true);
  assert.equal(r.first.cursor,10);
  if(r.atomic)assert.equal(r.first.session,null);
  else assert.ok(r.first.session, 'historical control exposes partial state');
  assert.equal(r.cursor,11);
  assert.equal(r.session.spent,'0');
});
