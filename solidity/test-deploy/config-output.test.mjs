import vm from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { publishConfigOutputs } from '../../cli/src/steps/config-output-core.mjs';
import { publishConfigOutputs as publishSupportedOutputs } from '../../cli/src/steps/config-output.mjs';
function fixture(run) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'caw-stage-test-'));
 try { const a=path.join(dir,'a'),b=path.join(dir,'b');fs.writeFileSync(a,'old-a');fs.writeFileSync(b,'old-b');run({dir,a,b,outputs:[{file:a,content:'new-a',mode:0o600},{file:b,content:'new-b'}]}); }
 finally { assert(path.dirname(dir)===os.tmpdir()&&path.basename(dir).startsWith('caw-stage-test-'));fs.rmSync(dir,{recursive:true}); }
}
const noStage=dir=>assert.deepEqual(fs.readdirSync(dir).sort(),['a','b']);
test('staged success replaces exact bytes and cleans temporary files',()=>fixture(({dir,a,b,outputs})=>{
 publishConfigOutputs(outputs);assert.equal(fs.readFileSync(a,'utf8'),'new-a');assert.equal(fs.readFileSync(b,'utf8'),'new-b');noStage(dir);
}));
for(const step of ['open','write','sync','verify','chmod'])test('stage '+step+' failure leaves original targets unchanged',()=>fixture(({dir,a,b,outputs})=>{
 let count=0;const io={...fs};const method={open:'openSync',write:'writeFileSync',sync:'fsyncSync',chmod:'chmodSync'}[step];
 if(method)io[method]=(...args)=>{if(++count===2)throw Error('private error');return fs[method](...args);};
 else outputs[1].verify=()=>{throw Error('private error');};
 assert.throws(()=>publishConfigOutputs(outputs,io),/0 file\(s\) replaced/);
 assert.equal(fs.readFileSync(a,'utf8'),'old-a');assert.equal(fs.readFileSync(b,'utf8'),'old-b');noStage(dir);
}));
test('observed operator edit prevents replacement and preserves edit',()=>fixture(({dir,a,b,outputs})=>{
 outputs[1].verify=()=>fs.writeFileSync(a,'operator-edit');
 assert.throws(()=>publishConfigOutputs(outputs),/0 file\(s\) replaced/);
 assert.equal(fs.readFileSync(a,'utf8'),'operator-edit');assert.equal(fs.readFileSync(b,'utf8'),'old-b');noStage(dir);
}));
test('second rename failure reports partial publication without claiming rollback',()=>fixture(({dir,a,b,outputs})=>{
 let count=0;const io={...fs,renameSync:(...args)=>{if(++count===2)throw Error('private error');return fs.renameSync(...args);}};
 assert.throws(()=>publishConfigOutputs(outputs,io),/1 file\(s\) replaced/);
 assert.equal(fs.readFileSync(a,'utf8'),'new-a');assert.equal(fs.readFileSync(b,'utf8'),'old-b');noStage(dir);
}));
test('duplicate target rejects before publication',()=>fixture(({dir,a,outputs})=>{
 outputs.push({file:a,content:'duplicate'});assert.throws(()=>publishConfigOutputs(outputs),/0 file\(s\) replaced/);assert.equal(fs.readFileSync(a,'utf8'),'old-a');noStage(dir);
}));
test('new destination is not created if staging later fails',()=>fixture(({dir,outputs})=>{
 const target=path.join(dir,'new');outputs.unshift({file:target,content:'new'});outputs[2].verify=()=>{throw Error('failure');};
 assert.throws(()=>publishConfigOutputs(outputs),/0 file\(s\) replaced/);assert(!fs.existsSync(target));noStage(dir);
}));
test('directory destination is refused without touching it',()=>fixture(({dir,outputs})=>{
 const target=path.join(dir,'directory');fs.mkdirSync(target);outputs[1].file=target;
 assert.throws(()=>publishConfigOutputs(outputs),/0 file\(s\) replaced/);assert(fs.statSync(target).isDirectory());assert.equal(fs.readFileSync(outputs[0].file,'utf8'),'old-a');
 assert(!fs.readdirSync(dir).some(x=>x.startsWith('.caw-stage-')));
}));
test('cleanup failure is explicit and does not expose original error details',()=>fixture(({dir,outputs})=>{
 outputs[1].verify=()=>{throw Error('private sentinel');};const io={...fs,unlinkSync(){throw Error('private sentinel');}};
 assert.throws(()=>publishConfigOutputs(outputs,io),e=>{assert.match(e.message,/staging files could not be removed/);assert.doesNotMatch(e.message,/private sentinel/);return true;});
 assert(fs.readdirSync(dir).some(x=>x.startsWith('.caw-stage-')));
}));

test('new file default mode uses the operator umask rather than a fixed public mode',()=>fixture(({dir})=>{
 const target=path.join(dir,'new');let applied;const io={...fs,chmodSync:(file,mode)=>{applied=mode;fs.chmodSync(file,mode);}};
 publishConfigOutputs([{file:target,content:'synthetic'}],io);
 assert.equal(applied,0o666 & ~process.umask());assert.equal(fs.readFileSync(target,'utf8'),'synthetic');
}));

test('same-byte replacement is detected by file identity before publication',()=>fixture(({dir,a,b,outputs})=>{
 const before=fs.statSync(a);
 outputs[1].verify=()=>{const replacement=path.join(dir,'replacement');fs.writeFileSync(replacement,'old-a');fs.chmodSync(replacement,before.mode & 0o777);fs.renameSync(replacement,a);};
 assert.throws(()=>publishConfigOutputs(outputs),/0 file\(s\) replaced/);
 assert.notEqual(fs.statSync(a).ino,before.ino);
 assert.equal(fs.readFileSync(a,'utf8'),'old-a');assert.equal(fs.readFileSync(b,'utf8'),'old-b');noStage(dir);
}));
for(const field of ['uid','gid','nlink'])test('observed '+field+' change rejects publication',()=>fixture(({dir,a,b,outputs})=>{
 let changed=false;outputs[1].verify=()=>{changed=true;};
 const io={...fs,lstatSync:file=>{const stat=fs.lstatSync(file);if(file===a && changed)return new Proxy(stat,{get:(target,key)=>key===field?target[field]+1:Reflect.get(target,key)});return stat;}};
 assert.throws(()=>publishConfigOutputs(outputs,io),/0 file\(s\) replaced/);
 assert.equal(fs.readFileSync(a,'utf8'),'old-a');assert.equal(fs.readFileSync(b,'utf8'),'old-b');noStage(dir);
}));

test('Windows production publisher refuses before any filesystem operation', {skip:process.platform!=='win32'},()=>{
 const io=new Proxy({}, {get(){throw Error('filesystem reached');}});
 assert.throws(()=>publishSupportedOutputs([{file:'synthetic',content:'synthetic'}],io),/unavailable on Windows/);
});
test('Windows refusal preserves existing files and creates no stage files', {skip:process.platform!=='win32'},()=>fixture(({dir,a,b,outputs})=>{
 assert.throws(()=>publishSupportedOutputs(outputs),/unavailable on Windows/);
 assert.equal(fs.readFileSync(a,'utf8'),'old-a');assert.equal(fs.readFileSync(b,'utf8'),'old-b');noStage(dir);
}));

function nonWindowsPublisher(io){
 const source=fs.readFileSync(process.env.CAW_CONFIG_OUTPUT_SOURCE || new URL('../../cli/src/steps/config-output.mjs',import.meta.url),'utf8').replace(/^import .*$/gm,'').replace(/export /g,'');
 const checkedIO={realpathSync:file=>file,lstatSync:()=>{throw Object.assign(Error('absent'),{code:'ENOENT'});},...io};
 const ctx={fs:checkedIO,path,process:{platform:'linux'}};vm.createContext(ctx);vm.runInContext(source+'\nglobalThis.publish=publishConfigOutputs',ctx);return ctx.publish;
}
test('non-Windows production path writes in place without invoking staged replacement',()=>{
 const writes=[],modes=[],verified=[];
 const io={writeFileSync:(...args)=>writes.push(args),chmodSync:(...args)=>modes.push(args),renameSync:()=>{throw Error('replacement reached');}};
 nonWindowsPublisher(io)([{file:'synthetic-a',content:'a',mode:0o600,verify:file=>verified.push(file)},{file:'synthetic-b',content:'b'}]);
 assert.equal(writes.length,2);assert.deepEqual(modes,[['synthetic-a',0o600]]);assert.deepEqual(verified,['synthetic-a']);
});
test('non-Windows write failure stops later outputs and reports possible partial file',()=>{
 let calls=0;const io={writeFileSync(){if(++calls===2)throw Error('private path');}};
 assert.throws(()=>nonWindowsPublisher(io)([{file:'a',content:'a'},{file:'b',content:'b'},{file:'c',content:'c'}]),e=>{assert.match(e.message,/1 completed write/);assert.match(e.message,/failing file may also be partial/);assert.doesNotMatch(e.message,/private path/);return true;});assert.equal(calls,2);
});
test('non-Windows readback failure prevents later writes',()=>{
 let calls=0;const io={writeFileSync(){calls++;}};
 assert.throws(()=>nonWindowsPublisher(io)([{file:'a',content:'a',verify(){throw Error('bad readback');}},{file:'b',content:'b'}]),/Installation incomplete/);assert.equal(calls,1);
});

// Actual Windows filesystem operations, but the production non-Windows branch
// is selected in a VM. These are not native Linux permission tests.
test('production preflight rejects hardlinked outputs before either content changes',()=>fixture(({a,b,outputs})=>{
 fs.unlinkSync(b);fs.linkSync(a,b);
 assert.throws(()=>nonWindowsPublisher(fs)(outputs),/target preflight failed/);
 assert.equal(fs.readFileSync(a,'utf8'),'old-a');assert.equal(fs.readFileSync(b,'utf8'),'old-a');
}));
test('production preflight rejects duplicate absent paths before creating files',()=>fixture(({dir})=>{
 const file=path.join(dir,'new');
 assert.throws(()=>nonWindowsPublisher(fs)([{file,content:'first'},{file:path.join(dir,'.','new'),content:'second'}]),/target preflight failed/);
 assert.equal(fs.existsSync(file),false);
}));
test('production preflight rejects observed symlink target before any write',()=>{
 let writes=0;
 const io={realpathSync:file=>file,lstatSync:()=>({isFile:()=>false,nlink:1n,dev:1n,ino:1n}),writeFileSync(){writes++;}};
 assert.throws(()=>nonWindowsPublisher(io)([{file:'alias',content:'synthetic'}]),/target preflight failed/);assert.equal(writes,0);
});
test('production preflight resolves parent aliases for absent destinations',()=>{
 let writes=0;const io={realpathSync:()=>path.resolve('shared-parent'),writeFileSync(){writes++;}};
 assert.throws(()=>nonWindowsPublisher(io)([{file:'one/env',content:'a'},{file:'two/env',content:'b'}]),/target preflight failed/);assert.equal(writes,0);
});
test('production preflight failure on a later target preserves earlier real file',()=>fixture(({a,b,outputs})=>{
 const io={...fs,lstatSync:(file,...args)=>{if(file===b)throw Object.assign(Error('private path'),{code:'EACCES'});return fs.lstatSync(file,...args);}};
 assert.throws(()=>nonWindowsPublisher(io)(outputs),e=>{assert.match(e.message,/No configuration files were written/);assert.doesNotMatch(e.message,/private path/);return true;});
 assert.equal(fs.readFileSync(a,'utf8'),'old-a');assert.equal(fs.readFileSync(b,'utf8'),'old-b');
}));
test('production preflight allows distinct ordinary files',()=>fixture(({a,b,outputs})=>{
 nonWindowsPublisher(fs)(outputs);assert.equal(fs.readFileSync(a,'utf8'),'new-a');assert.equal(fs.readFileSync(b,'utf8'),'new-b');
}));
