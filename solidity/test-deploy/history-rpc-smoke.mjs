import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateConfig } from '../../cli/src/steps/generate.js';
import { createRequire } from 'node:module';
import { resolveHistoryFloor } from '../../cli/src/steps/history-floor.mjs';
const require = createRequire(new URL('../../cli/package.json', import.meta.url));
const { ethers } = require('ethers');
// Synthetic transport fixture: no real chain, keys, signatures or finality claim.
const hash = n => '0x'+n.repeat(64);
const address = '0x'+'11'.repeat(20);
const txHash=hash('2'), blockHash=hash('3'), from='0x'+'44'.repeat(20);
const record={chainId:84532,contractAddress:address,transactionHash:txHash,blockNumber:12,blockHash,transactionIndex:0};
const manifest={schemaVersion:1,environment:'testnet',contracts:{CawActions_L2:record}};
let mode='valid', networkReads=0;const calls=[];
function result(method,route){
 calls.push(method);
 if(method==='eth_chainId' && route==='/l1')return '0xaa36a7';
 if(method==='eth_call'){networkReads++;return '0x'+(mode==='late-change'&&networkReads===2?99999:40245).toString(16).padStart(64,'0');}
 if(method==='eth_chainId')return mode==='wrong-chain'?'0x1':'0x14a34';
 if(method==='eth_getTransactionReceipt')return mode==='missing-receipt'?null:{transactionHash:txHash,transactionIndex:'0x0',blockHash,blockNumber:'0xc',from,to:null,contractAddress:address,cumulativeGasUsed:'0x5208',gasUsed:'0x5208',effectiveGasPrice:'0x1',logs:[],logsBloom:'0x'+'00'.repeat(256),status:mode==='failed-receipt'?'0x0':'0x1',type:'0x0'};
 if(method==='eth_getTransactionByHash')return {hash:txHash,nonce:'0x0',blockHash,blockNumber:'0xc',transactionIndex:'0x0',from,to:null,value:'0x0',gas:'0x100000',gasPrice:'0x1',input:'0x6000',chainId:'0x14a34',type:'0x0',v:'0x2958b',r:hash('1'),s:hash('1')};
 if(method==='eth_getBlockByNumber')return {number:'0xc',hash:mode==='reorg'?hash('5'):blockHash,parentHash:hash('6'),timestamp:'0x1',nonce:'0x0000000000000000',difficulty:'0x0',gasLimit:'0x100000',gasUsed:'0x5208',miner:from,extraData:'0x',transactions:[txHash]};
 throw new Error('unexpected RPC method '+method);
}
const server=http.createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;const data=JSON.parse(body);const reply=x=>({jsonrpc:'2.0',id:x.id,result:result(x.method,req.url)});res.setHeader('Content-Type','application/json');res.end(JSON.stringify(Array.isArray(data)?data.map(reply):reply(data)));});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
try{
 for(mode of ['valid','wrong-chain','missing-receipt','failed-receipt','reorg','missing-sibling']){
  const provider=new ethers.JsonRpcProvider(`http://127.0.0.1:${server.address().port}`,undefined,{cacheTimeout:-1});
  try{
   const args={environment:'testnet',chainKey:'L2',chainId:84532,addresses:{CawActions:address,...(mode==='missing-sibling'?{CawActionsERC1271:'0x'+'77'.repeat(20)}:{})},manifest,provider};
   if(mode==='valid')assert.deepEqual(await resolveHistoryFloor(args),{chainId:84532,chainKey:'L2',actions:address,startBlock:12});
   else await assert.rejects(resolveHistoryFloor(args),mode==='wrong-chain'?/RPC chain mismatch/:mode==='missing-receipt'?/unavailable/:mode==='failed-receipt'?/unsuccessful/:mode==='reorg'?/canonical block/:/Missing creation metadata/);
   console.log('PASS '+mode+(mode==='generate-valid'&&process.platform==='win32'?' (Windows publication refused)':''));
  }finally{provider.destroy();}
 }
 for(mode of ['generate-valid','missing-receipt','late-change']){
  networkReads=0;
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'caw-generator-smoke-'));
  const abi=path.join(dir,'client/src/abi');fs.mkdirSync(abi,{recursive:true});
  const text=`export const deployments = {
  testnet: {
    L1: { CawNetworkManager: '${from}', CawProfile: '${from}', CawProfileLens: '${from}', CawProfileMinter: '${from}'
    },
    L2: { CawActions: '${address}', CawProfileLedger: '${from}'
    },
  },
}
export const lzEids = {
  testnet: { L1: 40161, L2: 40245,
  },
}`;
  fs.writeFileSync(path.join(abi,'deployments.ts'),text);
  fs.writeFileSync(path.join(abi,'creation-receipts.testnet.json'),JSON.stringify(manifest));
  const url=`http://127.0.0.1:${server.address().port}`;
  const cfg={network:'testnet',networkId:1,l1RpcUrl:url+'/l1',l2RpcUrl:url+'/storage'};
  if(mode==='late-change'){
   fs.writeFileSync(path.join(dir,'client/config.json'),'operator config');
   fs.writeFileSync(path.join(dir,'client/.env'),'operator env');
   fs.writeFileSync(path.join(dir,'ecosystem.config.cjs'),'operator process');
  }
  // Restore the caller's manifest override after this isolated fixture.
  const override=process.env.CAW_CREATION_MANIFEST;delete process.env.CAW_CREATION_MANIFEST;
  try{
   if(mode==='generate-valid' && process.platform==='win32'){
    await assert.rejects(generateConfig('validator',cfg,dir),/unavailable on Windows/);
    for(const name of ['client/config.json','client/.env','ecosystem.config.cjs','client/src/abi/addresses.ts'])assert.equal(fs.existsSync(path.join(dir,name)),false);
    assert.equal(networkReads,2);
   }else if(mode==='generate-valid'){
    await generateConfig('validator',cfg,dir);
    const scanner=JSON.parse(fs.readFileSync(path.join(dir,'client/config.json'))).find(x=>x.service==='RawEventsGatherer');
    assert.equal(scanner.config.chainId,84532);assert.equal(scanner.config.startBlock,12);
    assert.match(fs.readFileSync(path.join(dir,'client/.env'),'utf8'),/L2_CHAIN_ID=84532/);
    assert.match(fs.readFileSync(path.join(abi,'addresses.ts'),'utf8'),new RegExp(address));
    assert(fs.existsSync(path.join(dir,'ecosystem.config.cjs')));assert.equal(networkReads,2);
    assert.match(fs.readFileSync(path.join(dir,'client/.env'),'utf8'),new RegExp('CAW_NAMES_ADDRESS='+from));
    assert(fs.readFileSync(path.join(dir,'ecosystem.config.cjs'),'utf8').includes(JSON.stringify(path.join(dir,'client'))));
   }else{
    await assert.rejects(generateConfig('validator',cfg,dir),mode==='missing-receipt'?/History verification failed/:/installation incomplete/);
    assert.equal(fs.existsSync(path.join(abi,'addresses.ts')),false);
    if(mode==='late-change'){
     assert.equal(fs.readFileSync(path.join(dir,'client/config.json'),'utf8'),'operator config');
     assert.equal(fs.readFileSync(path.join(dir,'client/.env'),'utf8'),'operator env');
     assert.equal(fs.readFileSync(path.join(dir,'ecosystem.config.cjs'),'utf8'),'operator process');
    }else{
     for(const name of ['client/config.json','client/.env','ecosystem.config.cjs'])assert.equal(fs.existsSync(path.join(dir,name)),false);
    }
   }
   console.log('PASS '+mode+(mode==='generate-valid'&&process.platform==='win32'?' (Windows publication refused)':''));
  }finally{
   if(override===undefined)delete process.env.CAW_CREATION_MANIFEST;else process.env.CAW_CREATION_MANIFEST=override;
   // Only remove this invocation's freshly-created temporary fixture.
   assert(path.dirname(dir)===os.tmpdir() && path.basename(dir).startsWith('caw-generator-smoke-'));
   fs.rmSync(dir,{recursive:true});
  }
 }
 assert(calls.includes('eth_getTransactionReceipt')&&calls.includes('eth_getTransactionByHash')&&calls.includes('eth_getBlockByNumber'));
 console.log('9 transport/generation cases passed; synthetic RPC only');
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
