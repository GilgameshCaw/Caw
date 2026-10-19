'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(process.env.CAW_VERIFIER_SOURCE||path.join(__dirname,'../scripts/verify-deploy-wiring.js'),'utf8');
const zero='0x'+'0'.repeat(40),pad=a=>'0x'+a.slice(2).padStart(64,'0');
async function run(mode) {
  const names=['CawProfile','CawProfileMinter','CawNetworkManager','CawProfileURI'];
  for(const role of ['L1','L2','L2b']) for(const n of ['PathwayExpander','CawProfileLedger','CawActions','CawActionsERC1271','CawActionsArchive','CawChallengeRelay'])names.push(n+'_'+role);
  const A=Object.fromEntries(names.map((n,i)=>[n,'0x'+(i+1).toString(16).padStart(40,'0')]));
  const byAddress=Object.fromEntries(Object.entries(A).map(([k,v])=>[v,k]));
  const eid={L1:40161,L2:40245,L2b:40231};
  const calls=[],logs=[];let exit=0;
  const ethers={zeroPadValue:pad,JsonRpcProvider:class{constructor(role){this.role=role;}},Contract:function(address,abi,provider){
    const name=byAddress[address];
    return new Proxy({}, {get:(_,method)=>async(...args)=>{
      calls.push([name||'endpoint',method]);
      if(!name){assert.equal(method,'delegates');return A['PathwayExpander_'+provider.role];}
      if(name==='CawProfileMinter'){
        if(mode==='authority-unreadable'&&method==='pathwayExpander')throw Error('read failed');
        if(method==='CawProfile')throw Error('current minter has no public profile getter');
        if(method==='pathwayExpander')return mode==='wrong-authority'?zero:A.PathwayExpander_L1;
      }
      if(method==='peers'){
        const remote=Object.keys(eid).find(r=>eid[r]===args[0]);
        if(name==='CawProfile')return pad(A['CawProfileLedger_'+remote]);
        if(name.startsWith('CawProfileLedger'))return pad(A.CawProfile);
        return pad(A[(name.startsWith('CawActionsArchive')?'CawChallengeRelay_':'CawActionsArchive_')+remote]);
      }
      if(name==='CawProfile')return ({minter:A.CawProfileMinter,cawProfileLedger:A.CawProfileLedger_L1,owner:A.PathwayExpander_L1,networkManager:A.CawNetworkManager,uriGenerator:A.CawProfileURI})[method];
      if(name==='CawNetworkManager')return ({cawProfile:A.CawProfile,minter:A.CawProfileMinter})[method];
      const role=name.split('_')[1];
      if(name.startsWith('CawProfileLedger'))return ({cawProfile:role==='L1'?A.CawProfile:zero,cawActions:A['CawActions_'+role],erc1271Sibling:A['CawActionsERC1271_'+role],bypassLZ:role==='L1',owner:zero})[method];
      if(method==='owner')return A['PathwayExpander_'+role];
      throw Error('unexpected read '+name+'.'+method);
    }});
  }};
  const context={__dirname:path.dirname(path.join(__dirname,'../scripts/verify-deploy-wiring.js')),console:{log:(...a)=>logs.push(a.join(' ')),error:(...a)=>logs.push(a.join(' '))},process:{env:{DEPLOY_ENV:'testnet',L1_RPC_URL:'L1',L2_RPC_URL:'L2',L2B_RPC_URL:'L2b'},exit:code=>{exit=code;}},require:name=>{
    if(name==='dotenv')return {config(){}};
    if(name==='fs')return {readFileSync:()=>JSON.stringify({addresses:A})};
    if(name==='path')return path;
    if(name==='ethers')return {ethers};
    if(name==='./lz-dvn-config')return {LZ_LIBRARIES_MAINNET:{}};
    throw Error('unexpected import '+name);
  }};
  vm.createContext(context);await vm.runInContext(source,context,{timeout:1000});
  return {exit,logs,calls};
}
test('complete verifier accepts matching testnet wiring',async()=>{
  const r=await run('valid');assert.equal(r.exit,0);assert.ok(r.logs.some(l=>l.includes('Verification complete:')&&l.includes('0 failed')));
});
for(const mode of ['wrong-authority','authority-unreadable'])test(mode+' must fail complete verifier',async()=>{
  const r=await run(mode);assert.equal(r.exit,1,JSON.stringify(r.logs));
});
test('complete verifier reads the public authority binding',async()=>{
  const r=await run('valid');for(const getter of ['pathwayExpander'])assert.ok(r.calls.some(([n,m])=>n==='CawProfileMinter'&&m===getter));
});
