// 普通Electron设置/系统目录绑定/扩展启用→真实typed请求及用量，全部隔离隐藏。
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import { gotoSession,launchApp,ready,waitForSnapshot,killApp} from './helpers.mjs';
import {prepareCodingProject} from './ordinary-coding-fixture.mjs';
import {startImageLoopback,imageExtensionSource,imageFixtureIds as ids,makeImageFixtureAssets,makeCapacityImageAssets} from './ordinary-image-fixture.mjs';
import {evidenceDir} from './evidence-root.mjs';
const settingsButton=page=>page.locator('nav').getByRole('button',{name:/设置|Settings/});
async function launchImageApp(stateDir,env){
  const handle=await launchApp(stateDir,env,'.',{prebindProject:false});
  handle.imageProcess=handle.app.process();
  // 本测试只准受控HTTP边界；端点透传错误须在发往公网前失败，不让“收到401”冒充loopback证据。
  await handle.app.evaluate(()=>{const original=globalThis.fetch;globalThis.fetch=(input,options)=>{
    const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
    if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw new Error('Image fixture requires actual loopback transport');
    return original(input,options);
  };});
  return handle;
}
async function bindProject(handle, folder, name) {
  await handle.app.evaluate(({ dialog }, path) => {
    globalThis.__mcpDirectoryChoices = [];
    dialog.showOpenDialog = async (window, options) => {
      globalThis.__mcpDirectoryChoices.push({ windowId: window.id, properties: options.properties });
      return { canceled: false, filePaths: [path] };
    };
  }, folder);
  const page = handle.page;
  await page.locator('nav').getByRole('button', { name: /新建工作空间|New workspace/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: /选择文件夹|Choose folder/ }).click();
  await dialog.locator('[data-slot="workspace-selected-folder"]').getByText(folder, { exact: true }).waitFor();
  await dialog.getByLabel(/工作空间名称|Workspace name/).fill(name);
  await dialog.getByRole('button', { name: /^创建$|^Create$/ }).click(); await dialog.waitFor({ state: 'hidden' });
  const snapshot = await waitForSnapshot(page, value => value.workspaces.some(item => item.name === name));
  const workspace = snapshot.workspaces.find(item => item.name === name);
  assert.deepEqual(workspace.folders, [folder]);
  const disk = JSON.parse(await readFile(join(handle.stateDir, 'dcode-prototype-state.json'), 'utf8'));
  assert.deepEqual(disk.workspaces.find(item => item.id === workspace.id).folders, [folder]);
  assert.equal(disk.tasks.find(item => item.id === workspace.defaultTaskId).workspaceId, workspace.id);
  const choices = await handle.app.evaluate(() => globalThis.__mcpDirectoryChoices);
  assert.equal(choices.length, 1); assert.deepEqual(choices[0].properties, ['openDirectory']); assert.ok(choices[0].windowId > 0);
  await page.locator('main').getByText(`${name} / 默认任务`, { exact: true }).waitFor();
  return workspace;
}
async function enableResources(page, stateDir) {
  await settingsButton(page).click();
  await page.locator('.w-44').getByRole('button', { name: /^项目扩展与 MCP$|^Project extensions & MCP$/ }).click();
  const group = page.getByRole('radiogroup', { name: /^项目扩展与 MCP$|^Project extensions & MCP$/ });
  assert.equal(await group.getByRole('radio', { name: /^关闭$|^Off$/ }).isChecked(), true);
  await group.getByRole('radio', { name: /^开启$|^On$/ }).click();
  await waitForSnapshot(page, snapshot => snapshot.settings.projectExtensionsEnabled === true);
  const on=await group.getByRole('radio',{name:/^开启$|^On$/}).elementHandle();
  await page.waitForFunction(element=>element?.checked===true||element?.getAttribute('aria-checked')==='true',on);
  assert.equal(await group.getByRole('radio', { name: /^开启$|^On$/ }).isChecked(), true);
  assert.equal(JSON.parse(await readFile(join(stateDir, 'dcode-prototype-state.json'), 'utf8')).settings.projectExtensionsEnabled, true);
  await page.keyboard.press('Escape');
}

async function openModel(page){
  await settingsButton(page).click();
  await page.locator('.w-44').getByRole('button',{name:/^模型\s*(不可用)?$|^Model\s*(Unavailable)?$/i}).click();
}
async function loginPreset(page,key,{apply=true,chatModel=ids.chat}={}){
  await openModel(page);
  await page.getByRole('radio',{name:/^预设供应商$|^Preset providers$/}).click();
  await page.getByLabel(/供应商|Provider/).selectOption(ids.provider);
  await page.getByRole('button',{name:/API 密钥认证|API key/}).click();
  await page.getByLabel(/OpenRouter API key/i).first().fill(key);
  await page.getByRole('button',{name:/确认|Confirm/}).click();
  await waitForSnapshot(page,async()=> (await page.evaluate(()=>window.dcode.listModelCatalog())).providers.find(item=>item.id==='openrouter')?.hasStoredKey===true);
  if(apply){
    await page.getByRole('button',{name:new RegExp('^'+chatModel.replaceAll('.','\\.')+'\\s')}).click();
    await page.getByRole('button',{name:/应用当前模型|Apply as current model/}).click();
    await waitForSnapshot(page,snapshot=>snapshot.model?.available===true&&['preset','preset-with-custom'].includes(snapshot.modelSetup?.kind));
  }
  await page.keyboard.press('Escape');
}
async function custom(page,server,key){
  await openModel(page);await page.getByRole('radio',{name:/^自定义$|^Custom$/}).click();
  await page.getByRole('radio',{name:/OpenAI-compatible|OpenAI/i}).click();
  await page.getByLabel(/显示名|Display name/).fill('图像普通来源');
  await page.getByLabel(/模型 ID|Model ID/).fill(ids.chat);
  await page.getByLabel(/Base URL/).fill(server.origin+'/v1');
  await page.getByLabel(/API 密钥|API key/i).fill(key);
  await page.getByRole('button',{name:/^保存$|^Save$/}).click();
  await waitForSnapshot(page,snapshot=>snapshot.model?.available===true);await page.keyboard.press('Escape');
}
async function send(page,text){const box=page.getByPlaceholder(/交代需求|Describe|追问、补充|Follow up/).first();await box.fill(text);await box.press('Enter');}
const sessionFor=(snapshot,text)=>snapshot.sessions.find(session=>snapshot.timelines[session.id]?.some(block=>block.kind==='message'&&block.role==='user'&&block.text===text));
async function withFixture(t,{mode='success',current='preset',dynamic=false,hold=false},action){
  const root=await realpath(await mkdtemp(join(tmpdir(),'dcode-image-desktop-'))),project=join(root,'project'),stateDir=join(root,'state');
  const nonce=randomUUID(),key='isolated-desktop-image-'+randomUUID(),chatModel=mode==='capacity'?'openai/gpt-4.1':ids.chat,assets=mode==='capacity'?makeCapacityImageAssets(nonce):makeImageFixtureAssets(nonce);let handle,server,passed=false,original;
  const f={root,project,stateDir,nonce,key,chatModel,assets,get handle(){return handle;},set handle(value){handle=value;},get server(){return server;}};
  try{
    await prepareCodingProject(project);await mkdir(join(project,'.pi/extensions'),{recursive:true});
    await writeFile(join(project,'.pi/mcp.json'),'{}');
    await writeFile(join(project,'.pi/extensions/image.ts'),imageExtensionSource(nonce,mode,assets));
    server=await startImageLoopback({nonce,key,mode,hold,warmup:current==='custom',chatModel,assets});
    f.env={DCODE_VALIDATION_ASSEMBLY:'',DCODE_VALIDATION_SAMPLE:'0',DCODE_CATALOG_BASE_URL:server.origin+'/catalog',
      DCODE_E2E_PRESET_BASE_URLS:JSON.stringify({openrouter:server.origin+'/v1'}),DCODE_E2E_STATE_ROOT:await realpath(tmpdir())};
    handle=await launchImageApp(stateDir,f.env);await ready(handle.page);
    if(current==='preset')await loginPreset(handle.page,key,{chatModel});else await custom(handle.page,server,key);
    await bindProject(handle,project,'图像项目 '+nonce.slice(0,8));await enableResources(handle.page,stateDir);
    assert.equal(server.requests.length,0,'配置、绑定和开启意图不执行模型');
    if(current==='custom'&&!dynamic){
      const text='原custom冷重开前准备 '+nonce;await send(handle.page,text);
      const warm=await waitForSnapshot(handle.page,s=>{const session=sessionFor(s,text);return session&&s.runs[session.id]?.status==='ready'&&s.timelines[session.id]?.some(b=>b.kind==='message'&&b.role==='assistant'&&b.text==='IMAGE_WARMUP_REPLY_'+nonce);});
      f.sessionId=sessionFor(warm,text).id;assert.equal(server.chats().length,1);assert.equal(server.images().length,0);
      await loginPreset(handle.page,key,{apply:false});assert.equal(server.requests.length,1);
      await handle.close();assert.equal(handle.imageProcess.exitCode,0);
      handle=await launchImageApp(stateDir,f.env);await ready(handle.page);
      assert.equal((await handle.page.evaluate(()=>window.dcode.getSnapshot())).modelSetup.kind,'custom');
      assert.equal(server.requests.length,1,'custom冷启动与已有preset目录读取不增加原请求');
      await gotoSession(handle.page,f.sessionId);
    }
    if(dynamic){
      const text='先打开普通客户端 '+nonce;await send(handle.page,text);
      const warm=await waitForSnapshot(handle.page,snapshot=>{const session=sessionFor(snapshot,text);return session&&snapshot.runs[session.id]?.status==='ready'&&snapshot.timelines[session.id]?.some(block=>block.kind==='message'&&block.role==='assistant'&&block.text==='IMAGE_WARMUP_REPLY_'+nonce);});
      f.sessionId=sessionFor(warm,text).id;assert.equal(server.chats().length,1);assert.equal(server.images().length,0);
      await loginPreset(handle.page,key,{apply:false});await gotoSession(handle.page,f.sessionId);
      assert.equal(server.chats().length,1,'认证保存只同步已打开client，不重输旧输入');
    }
    if(current==='custom'){
      const before=server.requests.length;await handle.page.getByTestId('model-entry-trigger').click();
      await handle.page.getByTestId('model-item-openrouter-'+ids.chat).click();await handle.page.keyboard.press('Escape');
      await waitForSnapshot(handle.page,s=>s.sessionModels[f.sessionId]?.choice?.mode==='explicit'&&s.sessionModels[f.sessionId]?.choice.sourceId===ids.provider);
      assert.equal(server.requests.length,before,'显式改选已核图像输入的预设只影响未来请求，不重放');
      assert.equal((await handle.page.evaluate(()=>window.dcode.getSnapshot())).modelSetup.kind,'custom','全局custom配置保持原样');
    }
    await action(f);passed=true;
  }catch(error){original=error;if(handle){await handle.page.screenshot({path:join(evidenceDir('ordinary-image'),'failure-'+nonce+'.png')}).catch(()=>{});await writeFile(join(root,'page.txt'),await handle.page.locator('body').innerText().catch(()=>''));await writeFile(join(root,'request-failure.json'),JSON.stringify({nonce,requests:server.requests,invalid:server.invalid},null,2));}throw error;}finally{
    if(handle){try{await handle.close();}catch(error){if(!original)throw error;await killApp(handle);}}
    await server?.close();if(passed)await rm(root,{recursive:true,force:true});else t.diagnostic('隔离失败数据保留 '+root);
  }
}
function usageFacts(snapshot,sessionId,f,{mode='success',current='preset'}={}){
  const state=snapshot.sessionModels[sessionId],session=snapshot.sessions.find(one=>one.id===sessionId),task=snapshot.taskUsage[session.taskId];
  const chatCount=current==='custom'?3:2,known=mode==='no-usage'?0:1;
  const expected={input:chatCount*2+known*108,output:chatCount+known*13,cacheRead:known*7,cacheWrite:known*2,requests:chatCount+known};
  assert.deepEqual(state.usage,expected);assert.deepEqual(task.totals,expected);
  const typed=state.requests.filter(one=>one.operation==='generateImages');assert.equal(typed.length,1);
  assert.equal(typed[0].responseId,undefined);assert.ok(typed[0].requestId);assert.equal(typed[0].modelId,ids.image);
  assert.equal(state.actual?.sourceId,ids.provider);assert.equal(state.actual?.modelId,f.chatModel);
  assert.equal(state.actualResponseId,f.server.chats().at(-1).responseId);assert.equal(state.lastResult,'succeeded');
  assert.equal(Boolean(task.incompleteReason),mode==='no-usage');
  return{state,task,expected};
}
async function captureUsage(f,sessionId,phase,expected){
  const page=f.handle.page;await page.getByTestId('model-entry-trigger').click();
  const usage=page.getByTestId('model-usage-task');await usage.waitFor({state:'visible'});
  const text=await usage.innerText();assert.match(text,new RegExp('(?:输入 '+expected.input+'／输出 '+expected.output+'|in '+expected.input+' / out '+expected.output+')'));
  await page.getByTestId('model-usage-scope-toggle').click();await page.getByTestId('model-usage-source-openrouter').waitFor({state:'visible'});
  await usage.screenshot({path:join(evidenceDir('ordinary-image'),phase+'-'+f.nonce+'.png')});await page.keyboard.press('Escape');
}
for(const options of [{mode:'success'},{mode:'capacity'},{mode:'billed-malformed-images'},{mode:'bad-pixels'},{mode:'no-usage'},{mode:'success',current:'custom'},{mode:'success',current:'custom',dynamic:true}])
 test('普通桌面图片 '+JSON.stringify(options)+'：原图像素/正式工具/任务用量/关闭只读重开',async t=>withFixture(t,options,async f=>{
  const page=f.handle.page,text='生成原工具图像 '+f.nonce,assets=f.assets;await send(page,text);
  const done=await waitForSnapshot(page,s=>{const session=sessionFor(s,text);return session&&s.runs[session.id]?.status==='ready'&&s.timelines[session.id]?.some(b=>b.kind==='tool'&&b.tool.name===ids.tool&&['done','failed'].includes(b.tool.status));});
  const sessionId=sessionFor(done,text).id;if(f.sessionId)assert.equal(sessionId,f.sessionId);assert.equal(f.server.images().length,1);const request=f.server.images()[0];assert.equal(request.accepted,true);assert.equal(request.body.model,ids.image);assert.deepEqual(f.server.invalid,[]);
  const block=done.timelines[sessionId].find(b=>b.kind==='tool'&&b.tool.name===ids.tool),success=['success','no-usage','capacity'].includes(options.mode);
  assert.equal(block.tool.status,success?'done':'failed');assert.deepEqual(block.tool.images??[],success?[assets.outputImage]:[]);
  const trigger=page.getByRole('button',{name:new RegExp('^(工具结果|Tool result) '+ids.tool+' ')});if(await trigger.getAttribute('aria-expanded')!=='true')await trigger.click();
  const card=page.locator('[data-slot="tool"]').filter({has:trigger});await card.locator('pre').waitFor({state:'visible'});assert.equal(await card.locator('pre').innerText(),block.tool.output);
  if(success){
    if(options.mode==='capacity'){assert.ok(block.tool.output.startsWith(assets.outputText.slice(0,128)));assert.match(block.tool.output,/Output truncated to its beginning/);}else assert.equal(block.tool.output,assets.outputText);const image=card.getByRole('img');await image.waitFor({state:'visible'});
    await image.evaluate(image=>image.decode());assert.deepEqual(await image.evaluate(image=>({width:image.naturalWidth,height:image.naturalHeight,complete:image.complete,src:image.getAttribute('src')})),{width:8,height:6,complete:true,src:'data:image/png;base64,'+assets.outputImage.data});
    assert.equal(f.server.chats().at(-1).forwardedOutputImage,true);assert.equal(f.server.chats().at(-1).hasOriginalToolResult,true);
  }else assert.equal(await card.getByRole('img').count(),0,'Bad image bytes must not reach rendered history');
  await card.screenshot({path:join(evidenceDir('ordinary-image'),'result-'+f.nonce+'.png')});
  const readySnapshot=await waitForSnapshot(page,s=>s.sessionModels[sessionId]?.requests.some(r=>r.operation==='generateImages')&&s.sessionModels[sessionId]?.actualResponseId===f.server.chats().at(-1).responseId);
  const before=usageFacts(readySnapshot,sessionId,f,options);await captureUsage(f,sessionId,'before-close',before.expected);
  const count=f.server.requests.length;await f.handle.close();assert.equal(f.handle.imageProcess.exitCode,0);
  f.handle=await launchImageApp(f.stateDir,f.env);await ready(f.handle.page);await gotoSession(f.handle.page,sessionId);
  const after=await f.handle.page.evaluate(()=>window.dcode.getSnapshot());assert.equal(f.server.requests.length,count);assert.deepEqual(usageFacts(after,sessionId,f,options),before);await captureUsage(f,sessionId,'readonly-reopen',before.expected);
  assert.deepEqual(after.timelines[sessionId].find(b=>b.id===block.id)?.tool,block.tool);
  await writeFile(join(evidenceDir('ordinary-image'),'facts-'+f.nonce+'.json'),JSON.stringify({nonce:f.nonce,options,sessionId,request:request.body,outputSha256:assets.outputSha256,originalInputSha256:assets.inputSha256,before,after:usageFacts(after,sessionId,f,options),actualImage:success?{width:8,height:6,data:assets.outputImage.data}:null},null,2));
 }));
for(const stop of ['pause','close'])test('普通桌面图片 '+stop+'：原HTTP取消/RO重开/原输入明确继续不重发',async t=>withFixture(t,{hold:true},async f=>{
 const text='图片在途 '+f.nonce;await send(f.handle.page,text);
 const running=await waitForSnapshot(f.handle.page,s=>{const session=sessionFor(s,text);return f.server.images().length===1&&session&&s.runs[session.id]?.status==='running';});
 const sessionId=sessionFor(running,text).id,user=running.timelines[sessionId].find(b=>b.kind==='message'&&b.role==='user'&&b.text===text),held=f.server.images()[0];assert.equal(held.finished,false);assert.equal(held.responseWritten,false);assert.equal(held.authOk,true);
 if(stop==='pause'){const primary=f.handle.page.locator('[data-slot="composer-primary"]');assert.match(await primary.getAttribute('aria-label'),/^暂停$|^Pause$/);await primary.click();await waitForSnapshot(f.handle.page,s=>s.runs[sessionId]?.status==='paused');}
 await f.handle.close();assert.equal(f.handle.imageProcess.exitCode,0);assert.equal(held.closedBeforeFinal,true);assert.equal(held.finished,false);
 f.handle=await launchImageApp(f.stateDir,f.env);await ready(f.handle.page);await gotoSession(f.handle.page,sessionId);const ro=await f.handle.page.evaluate(()=>window.dcode.getSnapshot());assert.equal(ro.runs[sessionId].status,'paused');assert.equal(f.server.images().length,1);assert.equal(f.server.chats().length,1);assert.equal(ro.timelines[sessionId].find(b=>b.id===user.id)?.operationId,user.operationId);
 await f.handle.page.evaluate(({sessionId,blockId})=>window.dcode.checkReceipt({sessionId,blockId}),{sessionId,blockId:user.id});assert.equal(f.server.images().length,1);
 const primary=f.handle.page.locator('[data-slot="composer-primary"]');assert.match(await primary.getAttribute('aria-label'),/^继续(执行)?$|^Continue$/);await primary.click();
 const resumed=await waitForSnapshot(f.handle.page,s=>s.runs[sessionId]?.status==='ready'&&s.timelines[sessionId]?.some(b=>b.kind==='tool'&&b.tool.name===ids.tool&&b.tool.status==='failed'));assert.equal(f.server.images().length,1);assert.equal(f.server.chats().length,2);assert.equal(resumed.timelines[sessionId].filter(b=>b.kind==='message'&&b.role==='user'&&b.text===text).length,1);assert.deepEqual(f.server.invalid,[]);
 await writeFile(join(evidenceDir('ordinary-image'),'lifecycle-'+stop+'-'+f.nonce+'.json'),JSON.stringify({nonce:f.nonce,stop,sessionId,operationId:user.operationId,imageHttp:1,chatHttp:2,closedBeforeFinal:held.closedBeforeFinal,remoteFinished:held.finished,readOnlyPhase:ro.runs[sessionId].status,finalPhase:resumed.runs[sessionId].status},null,2));
}));
