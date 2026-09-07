import {app,BrowserWindow,webContents} from 'electron';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import assert from 'node:assert/strict';
import {HTMLPreview} from '../../dist/src/main/html-preview.js';
import {closePreviewProxy} from '../../dist/src/main/preview-network.js';
void (async()=>{
const profile=await mkdtemp(join(tmpdir(),'dcode-preview-browser-'));app.setPath('userData',profile);
const requests=[];const local=createServer((request,response)=>{requests.push(request.url);response.writeHead(200,{'Access-Control-Allow-Origin':'*'});response.end('controlled fixture');});
await new Promise(resolve=>local.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${local.address().port}`;
let window;let preview;let failed=false;
const waitFor=async(check,label)=>{const deadline=Date.now()+6000;while(!await check()){if(Date.now()>deadline)throw new Error(`Timed out: ${label}`);await new Promise(resolve=>setTimeout(resolve,25));}};
try {
  await app.whenReady();window=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});await window.loadURL('data:text/html,<p>Trusted workbench fixture</p>');
  const assets=[];const bridge={request:async(action,params)=>{if(action==='workspace.preview')return {allowed:true};assert.equal(action,'workspace.asset');assert.equal(params.expectedRoot,'/fixture');assets.push(params.path);if(params.path==='style.css')return {base64:Buffer.from('body { color: rgb(21, 42, 63) }').toString('base64'),mimeType:'text/css'};throw new Error('not a fixture asset');}};
  preview=new HTMLPreview(()=>window,()=>bridge,()=>{});
  const input={clientId:'first-editor',source:{taskId:'fixture'},path:'index.html',root:'/fixture',bounds:{x:0,y:0,width:600,height:400},text:`<!doctype html><link rel="stylesheet" href="style.css"><h1 id="result">Loading</h1><script>document.querySelector('#result').textContent='inline ran';localStorage.setItem('preview-fixture','one');fetch('${origin}/asset').then(r=>r.text()).then(text=>document.body.dataset.network=text).catch(()=>document.body.dataset.network='blocked')</script>`};
  const first=await preview.update(input);const child=()=>webContents.getAllWebContents().find(contents=>contents.getURL().startsWith('dcode-preview:'));
  await waitFor(async()=>await child().executeJavaScript("document.body.dataset.network==='blocked'"),'default network denial');
  assert.equal(requests.length,0);assert.ok(assets.includes('style.css'));assert.equal(await child().executeJavaScript("getComputedStyle(document.body).color"),'rgb(21, 42, 63)');
  assert.equal(await child().executeJavaScript("document.querySelector('#result').textContent"),'inline ran');
  assert.deepEqual(await child().executeJavaScript("[typeof require,typeof process,typeof window.dcode]"),['undefined','undefined','undefined']);
  const before=webContents.getAllWebContents().length;await child().executeJavaScript("window.open('about:blank')");assert.equal(webContents.getAllWebContents().length,before);
  await preview.allowNetwork(first.id,true);await waitFor(async()=>await child().executeJavaScript("document.body?.dataset.network==='controlled fixture'"),'explicit current-preview permission');assert.ok(requests.length>0);
  const second=await preview.update({...input,clientId:'second-editor',path:'second.html',text:`<h1 id="result">Fresh</h1><script>document.body.dataset.saved=localStorage.getItem('preview-fixture')||'none';fetch('${origin}/fresh').then(()=>document.body.dataset.network='unexpected').catch(()=>document.body.dataset.network='blocked')</script>`});
  assert.notEqual(second.id,first.id);assert.equal(second.network,false);
  await waitFor(async()=>await child().executeJavaScript("document.body.dataset.network==='blocked'"),'new file denies network again');assert.ok(!requests.includes('/fresh'));assert.equal(await child().executeJavaScript("document.body.dataset.saved"),'none');
  await assert.rejects(preview.allowNetwork(first.id,true),/已经改变/);
  await preview.close('first-editor');assert.ok(child(),'stale editor cleanup cannot close new preview');
  await preview.close('second-editor');assert.equal(child(),undefined);console.log('HTML preview browser checks passed: inline JS, local CSS, app isolation, popup denial, default network block, explicit permission, per-file reset, stale owner cleanup.');
}catch(error){failed=true;console.error(error);}finally{await preview?.close();window?.destroy();await closePreviewProxy();await new Promise(resolve=>local.close(resolve));await rm(profile,{recursive:true,force:true});app.exit(failed?1:0);}

})().catch(error=>{console.error(error);app.exit(1);});
