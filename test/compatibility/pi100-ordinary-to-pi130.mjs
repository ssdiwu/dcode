// 实际旧1.0普通扩展数据副本→新SDK；不伪造任务历史，不碰原记录。
import assert from 'node:assert/strict';
import {cp,mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {createRealPiBackend,ModelSetupStore} from '../../src/adapters/pi/index.ts';
import {startCodingLoopback} from '../e2e/ordinary-coding-fixture.mjs';
import {until} from '../runtime/fixtures.ts';
const [manifest,factsFile]=process.argv.slice(2);if(!manifest||!factsFile)throw Error('Expected old actual fixture manifest and new facts path');
const old=JSON.parse(await readFile(manifest,'utf8'));assert.equal(old.producerSdk,'1.0.0');
async function hashes(directory){const result={};async function walk(root,prefix=''){for(const entry of await readdir(root,{withFileTypes:true})){const name=prefix+entry.name;if(entry.isDirectory())await walk(join(root,entry.name),name+'/');else if(entry.isFile())result[name]=createHash('sha256').update(await readFile(join(root,entry.name))).digest('hex');}}await walk(directory);return result;}
const root=await mkdtemp(join(tmpdir(),'dcode-pi100-ordinary-upgrade-')),facts=[];
try{for(const record of old.records){
 const beforeHashes=await hashes(record.stateDir),stateDir=join(root,record.mode);await cp(record.stateDir,stateDir,{recursive:true});
 const remote=await startCodingLoopback({callsOverride:[]});let session;
 try{
  const cipher={isAvailable:()=>true,encrypt:text=>Buffer.from(text),decrypt:bytes=>bytes.toString()};const store=new ModelSetupStore({stateDir},cipher);
  const backend=createRealPiBackend({stateDir,cipher,store,config:{...record.config,baseUrl:remote.origin+'/v1'}});
  session=await backend.open({target:record.target,title:record.mode,workFolder:record.project,model:null,initialize:false,projectAccess:'task-owner',projectExtensionsEnabled:()=>true});
  const view=await session.read(),receipt=await session.lookupReceipt(record.input);
  assert.equal(view.phase,'paused');assert.equal(receipt.status,'accepted');assert.equal(receipt.submissionId,record.receipt.submissionId);assert.equal(remote.requests.length,0);
  for(const entry of record.before.entries)assert.deepEqual(JSON.parse(JSON.stringify(view.entries.find(one=>one.id===entry.id))),entry,'旧正式条目及内容逐字保留');
  const effect=join(record.project,'old-effect.txt');assert.equal(await readFile(effect,'utf8'),record.effect);
  await session.resume(view.control);await until(()=>remote.requests.length===1);await until(async()=> (await session.lookupReceipt(record.input)).processing==='done');
  assert.equal(remote.requests.length,1,'只有明确继续后的同一原输入模型续轮');assert.deepEqual(remote.errors,[]);
  assert.equal(await readFile(effect,'utf8'),record.effect,'旧unsafe扩展及嵌套模型不能在升级恢复时重复副作用');
  assert.ok((await session.read()).entries.some(entry=>entry.assistantText===remote.nonce));
  if(record.mode==='completed-nested')assert.match(JSON.stringify(remote.requests[0].body.messages),/old nested content exact nonce/);
  else assert.match(JSON.stringify(remote.requests[0].body.messages),/中断|interrupted/i);
  await session.close();assert.deepEqual(await hashes(record.stateDir),beforeHashes,'原旧盘未被写入');
  facts.push({mode:record.mode,originalReceiptId:receipt.submissionId,readonlyRequests:0,explicitResumeRequests:remote.requests.length,effectUnchanged:true,originalStateUnchanged:true});
 }finally{await session?.close();await remote.close();}
}
await writeFile(factsFile,JSON.stringify({sourceSdk:'1.0.0',targetSdk:'1.3.0',manifest,cases:facts,wholeProductAcceptance:false},null,2)+'\n');console.log(JSON.stringify({passed:facts.length,cases:facts}));
}finally{await rm(root,{recursive:true,force:true});}
