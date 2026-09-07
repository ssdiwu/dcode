import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {AuxiliaryProcesses,recoverAuxiliaryProcess,type AuxiliaryProcessInfo} from '../src/auxiliary-process.js';
const until=async(check:()=>Promise<boolean>,label:string)=>{const deadline=Date.now()+10000;while(!await check()){if(Date.now()>deadline)throw new Error(label);await new Promise(resolve=>setTimeout(resolve,30));}};
const exists=(pid:number)=>{try{process.kill(pid,0);return true;}catch{return false;}};

test('background commands retain a distinct live process-group owner; stopping one does not stop another',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dcode-auxiliary-')),records:AuxiliaryProcessInfo[]=[];
  const left=new AuxiliaryProcesses(async info=>{records.push(info);}),right=new AuxiliaryProcesses(async info=>{records.push(info);});
  try{
    await Promise.all([left.tool(root).execute('left',{command:'sleep 60 > /dev/null 2>&1 & echo $! > left.pid'},undefined),right.tool(root).execute('right',{command:'sleep 60 > /dev/null 2>&1 & echo $! > right.pid'},undefined)]);
    await until(async()=>left.snapshot.some(info=>info.status==='background')&&right.snapshot.some(info=>info.status==='background'),'both background groups remain owned');
    const a=left.snapshot[0]!,b=right.snapshot[0]!,leftPid=Number(await readFile(join(root,'left.pid'),'utf8')),rightPid=Number(await readFile(join(root,'right.pid'),'utf8'));
    assert.notEqual(a.pid,b.pid);assert.notEqual(a.pid,process.pid);assert.ok(a.memberPids.includes(leftPid));assert.ok(b.memberPids.includes(rightPid));assert.equal(a.toolCallId,'left');assert.ok(exists(leftPid)&&exists(rightPid));
    await assert.rejects(left.stop(b.id),/does not belong/);await left.stop(a.id);await until(async()=>!exists(leftPid),'left group stopped');assert.ok(exists(rightPid),'unrelated member stays active');assert.ok(right.hasLive);
    await right.dispose();await until(async()=>!exists(rightPid),'owning Host cleanup stops background group');assert.ok(records.filter(info=>info.status==='exited').length>=2);
    assert.ok(!JSON.stringify(records).includes('sleep 60'),'command text is not stored in process facts');
  }finally{await left.dispose();await right.dispose();await rm(root,{recursive:true,force:true});}
});

test('explicit stop during a foreground command kills its process group and preserves the stopped fact',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dcode-auxiliary-stop-')),controller=new AbortController(),records:AuxiliaryProcessInfo[]=[];const manager=new AuxiliaryProcesses(async info=>{records.push(info);});
  try{
    const run=manager.tool(root).execute('foreground',{command:'sleep 60'},controller.signal);const rejected=assert.rejects(run,/aborted/);await until(async()=>records.some(info=>info.status==='running'),'foreground starts');controller.abort();await rejected;await manager.dispose();assert.ok(records.some(info=>info.status==='exited'&&info.reason==='stopped'));
  }finally{await manager.dispose();await rm(root,{recursive:true,force:true});}
});

test('recovery requires the helper nonce and never kills a reused PID',async()=>{
  const current:AuxiliaryProcessInfo={id:crypto.randomUUID(),pid:process.pid,cwd:tmpdir(),memberPids:[],toolCallId:'old',commandDigest:'sha256:fixture',status:'running',startedAt:new Date().toISOString()};
  const recovered=await recoverAuxiliaryProcess(current);assert.ok(exists(process.pid));assert.ok(['unknown','exited'].includes(recovered.status));
});

test('a foreground-only command releases its helper without counting the process probe as a background member',async()=>{
  const records:AuxiliaryProcessInfo[]=[];const manager=new AuxiliaryProcesses(async info=>{records.push(info);});
  try{const result=await manager.tool(tmpdir()).execute('short',{command:'echo finished'},undefined);assert.ok(result);await until(async()=>!manager.hasLive,'helper automatically exits');assert.ok(records.some(info=>info.status==='exited'));assert.ok(!records.some(info=>info.status==='background'));}finally{await manager.dispose();}
});

test('an unexpectedly killed helper leaves the live group unknown until the remaining service exits',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dcode-auxiliary-crash-')),records:AuxiliaryProcessInfo[]=[];const manager=new AuxiliaryProcesses(async info=>{records.push(info);});let servicePid=0;
  try{
    await manager.tool(root).execute('service',{command:'sleep 60 > /dev/null 2>&1 & echo $! > service.pid'},undefined);await until(async()=>manager.snapshot.some(info=>info.status==='background'),'background started');const info=manager.snapshot[0]!;servicePid=Number(await readFile(join(root,'service.pid'),'utf8'));
    process.kill(info.pid,'SIGKILL');await until(async()=>records.some(record=>record.status==='unknown'),'orphaned service is not falsely declared exited');assert.ok(manager.hasLive);assert.ok(exists(servicePid));await assert.rejects(manager.stop(info.id),/尚未确认/);
    process.kill(servicePid,'SIGTERM');await until(async()=>!exists(servicePid),'fixture service stopped');await manager.stop(info.id);assert.ok(!manager.hasLive);
  }finally{if(servicePid&&exists(servicePid))process.kill(servicePid,'SIGKILL');await manager.dispose();await rm(root,{recursive:true,force:true});}
});
