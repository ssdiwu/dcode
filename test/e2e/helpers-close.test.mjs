// 验证工装已知退出事实，不把 app.exit 当作产品正常 flush 的证据。
// 只有空白隔离实例；退出监听先登记，测试不依赖迟到的新 exit 事件。
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { launchApp, ready, killApp, cleanup } from './helpers.mjs';

for (const code of [0, 1]) test(`退出工装：已退出进程 ${code} 不等新的 exit，正常与异常出口分别处理`, async () => {
  const handle = await launchApp(undefined, { DCODE_VALIDATION_ASSEMBLY: '', DCODE_VALIDATION_SAMPLE: '0' });
  try {
    await ready(handle.page);
    const proc = handle.app.process();
    const exited = once(proc, 'exit');
    // 故意只验证已退出事实的消费；这条直接退出不证明应用保存或执行收束成功。
    await handle.app.evaluate(({ app }, exitCode) => app.exit(exitCode), code).catch(() => undefined);
    const [actualCode, signal] = await exited;
    assert.equal(actualCode, code);
    assert.equal(signal, null);
    assert.equal(proc.exitCode, code);
    if (code === 0) await handle.close();
    else await assert.rejects(handle.close(), /关闭前已异常退出.*code=1/);
  } finally {
    await killApp(handle);
    cleanup(handle.stateDir);
  }
});

test('退出工装：并发 close 共同等待真实退出，不提前报已关闭', async () => {
  const handle = await launchApp(undefined, { DCODE_VALIDATION_ASSEMBLY: '', DCODE_VALIDATION_SAMPLE: '0' });
  // Playwright channel 在关闭后已释放，真实 ChildProcess 须在此前取出并保留。
  const proc = handle.app.process();
  const original = handle.app.close.bind(handle.app);
  let release = () => {};
  const gate = new Promise(resolve => { release = resolve; });
  const flights = [];
  try {
    await ready(handle.page);
    let calls = 0;
    let secondSettled = false;
    // 只停工装向 Playwright 发出关闭的阶段，产品退出逻辑仍沿原正式入口。
    handle.app.close = () => { calls += 1; return gate.then(original); };
    const first = handle.close();
    const second = handle.close().then(() => { secondSettled = true; });
    flights.push(first, second);
    for (const flight of flights) void flight.catch(() => undefined);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(calls, 1);
    assert.equal(proc.exitCode, null);
    assert.equal(secondSettled, false, '真实关闭仍未发出，第二次 close 也必须保持在途');
    release();
    await Promise.all(flights);
    assert.equal(proc.exitCode, 0);
  } finally {
    release();
    await Promise.allSettled(flights);
    handle.app.close = original;
    await killApp(handle);
    cleanup(handle.stateDir);
  }
});

// APPEND CANDIDATE for test/e2e/helpers-close.test.mjs (existing imports/tests unchanged).
import { chmod, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { waitForSnapshot } from './helpers.mjs';
import { evidenceDir } from './evidence-root.mjs';

test('真实quit保存失败后恢复：原进程保持可读，修复权限后第二次正常quit重新flush并exit0', async () => {
  const events=[],secondary=[],permissionCodes=[];let primary,handle,proc,catalog,phase='fixture-start',exitPromise;
  let permissionSampleArmed=false,stderrWindow='',samplePermissionCode;
  const evidencePath=join(evidenceDir('helpers-close','real-quit-retry'),'close-retry.json');
  const note=(next,details={})=>{phase=next;events.push({phase:next,...details});};
  const preserve=async(label,action)=>{try{await action();}catch(error){secondary.push({label,error});}};
  try{
    // Own catalog endpoint only; no external directory, account or model endpoint is contacted.
    catalog=http.createServer((_request,response)=>{response.writeHead(404,{'content-type':'application/json'});response.end('{"error":"owned-empty-catalog"}');});
    await new Promise(resolve=>catalog.listen(0,'127.0.0.1',resolve));
    const origin='http://127.0.0.1:'+catalog.address().port;
    handle=await launchApp(undefined,{DCODE_VALIDATION_ASSEMBLY:'',DCODE_VALIDATION_SAMPLE:'0',
      DCODE_CATALOG_BASE_URL:origin,DCODE_E2E_STATE_ROOT:tmpdir()});
    // Capture actual ChildProcess while the original Playwright connection is still live.
    proc=handle.app.process();exitPromise=once(proc,'exit');void exitPromise.catch(()=>{});
    assert.ok(proc.stderr,'Owned Electron stderr pipe is required for the finite permission-code observation');
    samplePermissionCode=chunk=>{
      if(!permissionSampleArmed)return;
      // Transient bounded parsing only. Never write or print the raw chunk/window, paths, frames or other diagnostics.
      stderrWindow=(stderrWindow+String(chunk)).slice(-4096);
      const marker='[dcode] close-save-failed',start=stderrWindow.lastIndexOf(marker);if(start<0)return;
      let diagnostic=stderrWindow.slice(start+marker.length);const next=diagnostic.indexOf('[dcode]');if(next>=0)diagnostic=diagnostic.slice(0,next);
      const match=/\bcode["']?\s*:\s*["']?(EACCES|EPERM)\b/.exec(diagnostic);
      if(match){if(!permissionCodes.includes(match[1]))permissionCodes.push(match[1]);stderrWindow='';}
    };
    proc.stderr.on('data',samplePermissionCode);
    await ready(handle.page);const before=await handle.page.evaluate(()=>window.dcode.getSnapshot());
    assert.equal(before.closeError,null,'A pre-existing save failure is not this first quit failure');
    const stateFile=join(handle.stateDir,'dcode-prototype-state.json');
    const beforeBytes=await readFile(stateFile),beforeStat=await stat(stateFile);
    note('ready',{pid:proc.pid,closeError:before.closeError,closeErrorRevision:before.closeErrorRevision});

    await chmod(handle.stateDir,0o555);assert.equal((await stat(handle.stateDir)).mode&0o777,0o555);
    permissionSampleArmed=true;stderrWindow='';note('first-quit-requested-with-readonly-dir');
    // Do NOT call handle.close here: caching its first failed result would test the helper, not main's next quit.
    await handle.app.evaluate(({app})=>{app.quit();});
    const failed=await waitForSnapshot(handle.page,snapshot=>snapshot.closeError==='close-failed'&&permissionCodes.length>0);
    assert.ok(failed.closeErrorRevision>before.closeErrorRevision,'Real flush failure must publish its own error occurrence');
    assert.equal(proc.exitCode,null);assert.equal(proc.signalCode,null,'The failed quit cannot be mistaken for a normal or forced exit');
    assert.deepEqual(await readFile(stateFile),beforeBytes,'Permission-denied flush must not replace the last saved disk state');
    permissionSampleArmed=false;stderrWindow='';
    assert.ok(permissionCodes.length>0);assert.ok(permissionCodes.every(code=>code==='EACCES'||code==='EPERM'),'Only the real close-save-failed permission codes qualify this first failure');
    // Pin identity AFTER the first real failed flush returned, not a potentially earlier startup save.
    const failedStat=await stat(stateFile,{bigint:true});
    const failedFileIdentity={dev:failedStat.dev.toString(),ino:failedStat.ino.toString()};
    note('first-quit-real-flush-failed',{closeError:failed.closeError,closeErrorRevision:failed.closeErrorRevision,
      pid:proc.pid,exitCode:proc.exitCode,signalCode:proc.signalCode,diskUnchanged:true,permissionCodes:[...permissionCodes],failedFileIdentity});

    await chmod(handle.stateDir,0o755);assert.equal((await stat(handle.stateDir)).mode&0o777,0o755);
    note('permission-restored-second-quit-requested');
    // First invocation of this helper's closeFlight. Its existing 15s real-exit bound is unchanged.
    await handle.close();const [code,signal]=await exitPromise;
    assert.equal(code,0);assert.equal(signal,null);assert.equal(proc.exitCode,0);assert.equal(proc.signalCode,null);
    note('second-quit-exited-checking-atomic-save',{code,signal,pid:proc.pid});
    const finalBytes=await readFile(stateFile),finalStat=await stat(stateFile,{bigint:true});assert.ok(JSON.parse(finalBytes.toString('utf8')));
    const finalFileIdentity={dev:finalStat.dev.toString(),ino:finalStat.ino.toString()};
    assert.notDeepEqual(finalFileIdentity,failedFileIdentity,'Second normal quit must atomically replace the state file after the failed flush; merely exiting without retrying save is not success');
    note('second-quit-normal-exit',{code,signal,pid:proc.pid,stateFileReadable:true,
      beforeInode:String(beforeStat.ino),afterInode:String(finalStat.ino),failedFileIdentity,finalFileIdentity,atomicReplacementConfirmed:true});
  }catch(error){primary={phase,error};}
  finally{
    permissionSampleArmed=false;stderrWindow='';if(proc?.stderr&&samplePermissionCode)proc.stderr.off('data',samplePermissionCode);
    // Cleanup is not a successful close oracle. Restore owned permissions even when the assertion or close failed.
    if(handle){
      await preserve('restore-owned-permission',()=>chmod(handle.stateDir,0o755));
      if(proc)note('cleanup-before-owned-reclaim',{exitCode:proc.exitCode,signalCode:proc.signalCode,normalExit:proc.exitCode===0&&proc.signalCode===null});
      await preserve('reclaim-original-handle',()=>killApp(handle));
      await preserve('cleanup-owned-state',async()=>cleanup(handle.stateDir));
    }
    if(catalog)await preserve('close-owned-catalog',()=>new Promise(resolve=>{catalog.closeAllConnections();catalog.close(resolve);}));
    await preserve('write-external-evidence',()=>writeFile(evidencePath,JSON.stringify({events,
      primary:primary?{phase:primary.phase,name:primary.error?.name,message:primary.error?.message}:null,
      secondary:secondary.map(item=>({label:item.label,name:item.error?.name,message:item.error?.message}))},null,2)));
  }
  if(primary)throw new AggregateError([primary.error,...secondary.map(item=>item.error)],'real quit retry failed at '+primary.phase+': '+primary.error.message,{cause:primary.error});
  if(secondary.length)throw new AggregateError(secondary.map(item=>item.error),'real quit retry fixture cleanup failed');
});
