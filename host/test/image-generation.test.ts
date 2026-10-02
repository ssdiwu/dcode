import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readFile,writeFile,rename,stat,realpath} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {ProductStore} from '../src/product-store.js';
import {ImageGenerationController} from '../src/image-generation.js';
import {ImageGenerationError,type ImageCapability,type ImageGenerationRecord} from '../src/image-generation-types.js';
import type {ImageBackend,ImageBackendFactory} from '../src/image-app-server.js';
import {WorkspaceAccess} from '../src/workspace-access.js';
import {generatedImageDigest,inspectGeneratedImage} from '../src/generated-image-files.js';

const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const until=async(check:()=>boolean|Promise<boolean>)=>{const end=Date.now()+10000;while(!await check()){if(Date.now()>end)throw Error('image state timeout');await new Promise(resolve=>setTimeout(resolve,10));}};
async function fixture(mode:'success'|'hold'|'incomplete'|'invalid'='success'){
 const root=await realpath(await mkdtemp(join(tmpdir(),'dcode-image-contract-'))),home=join(root,'home');await mkdir(home);
 let store=await ProductStore.open({dataRoot:join(root,'.dcode'),userHome:home});
 const initial=await store.snapshot();const task=await store.createTask({requestId:'image-task',expectedStoreRevision:initial.storeRevision,scope:{kind:'user',userId:initial.currentUser.id},title:'图片任务',goal:'验证单图产物与恢复'});
 let calls=0;const inputs:string[]=[];
 const factory:ImageBackendFactory=async signal=>{
  const backend:ImageBackend={turnRequested:false,capability:async()=>({available:true,experimental:true,quota:'unknown',plan:'pro'}),login:async()=>{},close:async()=>{},
   generate:async(description,_language,submitted)=>{
    calls++;inputs.push(description);(backend as {turnRequested:boolean}).turnRequested=true;
    await submitted({threadId:`thread-${calls}`,turnId:`turn-${calls}`});
    if(mode==='hold')await new Promise<never>((_resolve,reject)=>{signal.addEventListener('abort',()=>reject(new ImageGenerationError('IMAGE_CANCELLED',true)),{once:true});});
    const result={data:mode==='invalid'?'aW52YWxpZA==':png,threadId:`thread-${calls}`,turnId:`turn-${calls}`};
    if(mode==='incomplete')throw new ImageGenerationError('IMAGE_TURN_INCOMPLETE',true,{...result,terminalStatus:'failed'});
    return result;
   }};return backend;
 };
 const workspace=new WorkspaceAccess(async()=>store);
 const controller=()=>new ImageGenerationController(store,()=>{},factory,async()=>{},(destination,bytes,context,expected)=>workspace.exportImage(destination,bytes,context,expected),(taskId,id,mime)=>workspace.imageExportContext(taskId,id,mime));
 let image=controller();
 const request=async(id='image-request',description='  一盏橘色台灯\n保留提交原文  ')=>(image.start({requestId:id,expectedStoreRevision:(await store.snapshot()).storeRevision,taskId:task.task.id,sessionId:task.coordinationSession.id,description}));
 return {root,task,factory,get store(){return store;},get image(){return image;},workspace,get calls(){return calls;},inputs,request,
  finished:async()=>{await until(()=>store.imageGenerations(task.task.id).some(record=>!['queued','running'].includes(record.state)));return store.imageGenerations(task.task.id).at(-1)!;},
  reopen:async()=>{await image.close();await store.close();store=await ProductStore.open({dataRoot:join(root,'.dcode'),userHome:home});image=controller();await image.recover();},
  close:async()=>{await image.close();await store.close();await rm(root,{recursive:true,force:true});}};
}

test('image request is idempotent, preserves exact description, and survives restart as an immutable artifact',async()=>{
 const f=await fixture();try{
  const started=await f.request();await f.request();const result=await f.finished();assert.equal(result.state,'succeeded');assert.equal(f.calls,1);
  assert.equal(result.description,'  一盏橘色台灯\n保留提交原文  ');assert.deepEqual(f.inputs,[result.description]);
  const before=await f.image.image(f.task.task.id,result.id);assert.equal(before.provisional,false);assert.equal(before.width,1);
  await f.reopen();const after=await f.image.image(f.task.task.id,result.id);assert.equal(after.dataUrl,before.dataUrl);assert.equal(f.calls,1);
  await f.request();assert.equal(f.calls,1);assert.equal(f.image.list(f.task.task.id).generations[0]!.id,started.generation.id);
  await assert.rejects(f.image.image('other-task',result.id),{code:'IMAGE_RESULT_UNAVAILABLE'});
 }finally{await f.close();}
});

test('cancel after submission remains unknown and same request never repeats generation',async()=>{
 const f=await fixture('hold');try{
  const prepared=await f.request();await until(()=>f.calls===1&&f.store.imageGenerations()[0]!.state==='running');
  await f.image.cancel(f.task.task.id,prepared.generation.id);assert.equal(f.store.imageGenerations()[0]!.state,'unknown');
  await f.request();await f.reopen();await f.request();assert.equal(f.calls,1);assert.equal((await f.store.snapshot()).artifacts.length,0);
 }finally{await f.close();}
});

test('completed image in an incomplete turn is provisional, never a formal deliverable or restart success',async()=>{
 const f=await fixture('incomplete');try{
  await f.request();const record=await f.finished();assert.equal(record.state,'unknown');assert.equal(record.errorCode,'IMAGE_TURN_INCOMPLETE');assert.ok(record.resultInfo);
  assert.equal((await f.store.snapshot()).artifacts.length,0);assert.equal((await f.image.image(f.task.task.id,record.id)).provisional,true);
  await f.reopen();await f.image.reconcile(f.task.task.id);assert.equal(f.store.imageGenerations()[0]!.state,'unknown');assert.equal((await f.store.snapshot()).artifacts.length,0);assert.equal(f.calls,1);
  await assert.rejects(f.image.attach({requestId:'provisional-attach',expectedStoreRevision:(await f.store.snapshot()).storeRevision,taskId:f.task.task.id,generationId:record.id,sessionId:f.task.coordinationSession.id,draftKey:f.task.coordinationSession.id}),{code:'IMAGE_RESULT_UNAVAILABLE'});
 }finally{await f.close();}
});

test('invalid image is never a successful artifact',async()=>{
 const f=await fixture('invalid');try{await f.request();const record=await f.finished();assert.equal(record.state,'failed');assert.equal(record.errorCode,'IMAGE_FORMAT_REJECTED');assert.equal((await f.store.snapshot()).artifacts.length,0);}finally{await f.close();}
});

test('changing both image and manifest cannot bypass Store digest or the artifact inspector',async()=>{
 const f=await fixture();try{
  await f.request();const record=await f.finished(),artifact=(await f.store.snapshot()).artifacts[0]!;
  const changed=Buffer.concat([Buffer.from(png,'base64'),Buffer.from('altered')]);
  const manifestPath=join(dirname(artifact.managedPath!),'manifest.json'),manifest=JSON.parse(await readFile(manifestPath,'utf8'));
  manifest.info.bytes=changed.length;manifest.info.digest=generatedImageDigest(changed);
  await writeFile(artifact.managedPath!,changed);await writeFile(manifestPath,JSON.stringify(manifest));
  await assert.rejects(f.image.image(f.task.task.id,record.id),{code:'IMAGE_RECORD_CHANGED'});
  await assert.rejects(f.workspace.handle('workspace.read',{source:{artifactId:artifact.id},path:'image.png'}),{code:'IMAGE_RECORD_CHANGED'});
 }finally{await f.close();}
});

test('attachment uses verified bytes and cannot be attached to a different Task',async()=>{
 const f=await fixture();try{
  await f.request();const record=await f.finished();
  await assert.rejects(f.image.attach({requestId:'wrong-task',expectedStoreRevision:(await f.store.snapshot()).storeRevision,taskId:'other-task',generationId:record.id,sessionId:f.task.coordinationSession.id,draftKey:f.task.coordinationSession.id}),{code:'IMAGE_RESULT_UNAVAILABLE'});
  const imported=await f.image.attach({requestId:'attach-image',expectedStoreRevision:(await f.store.snapshot()).storeRevision,taskId:f.task.task.id,generationId:record.id,sessionId:f.task.coordinationSession.id,draftKey:f.task.coordinationSession.id});
  assert.equal(imported.attachment.digest,record.resultInfo!.digest);
 }finally{await f.close();}
});

test('export creates one file without replacing an existing filename and rejects changed directory identity',async()=>{
 const f=await fixture();try{
  await f.request();const record=await f.finished(),directory=join(f.root,'export');await mkdir(directory);
  const context=await f.image.context(f.task.task.id,record.id),identity=await stat(directory),expected={directory,device:String(identity.dev),inode:String(identity.ino)},destination=join(directory,'image.png');
  await f.image.export(f.task.task.id,record.id,destination,context,expected);assert.deepEqual(await readFile(destination),Buffer.from(png,'base64'));
  await assert.rejects(f.image.export(f.task.task.id,record.id,destination,context,expected),{code:'IMAGE_EXPORT_EXISTS'});assert.deepEqual(await readFile(destination),Buffer.from(png,'base64'));
  await rename(directory,join(f.root,'moved'));await mkdir(directory);
  await assert.rejects(f.image.export(f.task.task.id,record.id,destination,context,expected),{code:'IMAGE_EXPORT_LOCATION_CHANGED'});
 }finally{await f.close();}
});

test('a submitting record without a live job is not replayed, even before restart',async()=>{
 const f=await fixture();try{
  const input={requestId:'orphan-submit',expectedStoreRevision:(await f.store.snapshot()).storeRevision,taskId:f.task.task.id,sessionId:f.task.coordinationSession.id,description:'提交边界验证'};
  const prepared=await f.store.prepareImageGeneration(input);await f.store.transitionImageGeneration(prepared.generation.id,{state:'queued',phase:'submitting'});
  await f.image.start(input);assert.equal(f.calls,0);assert.equal(f.store.imageGenerations()[0]!.state,'unknown');
 }finally{await f.close();}
});

test('saved result is reconciled after a Store completion failure without another backend request',async()=>{
 const f=await fixture();try{
  const complete=f.store.completeImageGeneration.bind(f.store);let failed=false;
  f.store.completeImageGeneration=async(...args)=>{if(!failed){failed=true;throw Error('synthetic Store commit unavailable');}return complete(...args);};
  await f.request();const unknown=await f.finished();assert.equal(unknown.state,'unknown');assert.ok(unknown.resultInfo);assert.equal((await f.store.snapshot()).artifacts.length,0);
  await until(()=>!(f.image as unknown as {jobs:Map<string,unknown>}).jobs.size);
  await f.image.reconcile(f.task.task.id);assert.equal(f.store.imageGenerations()[0]!.state,'succeeded');assert.equal(f.calls,1);assert.equal((await f.store.snapshot()).artifacts.length,1);
 }finally{await f.close();}
});

test('a saved incomplete image remains inspectable when the Host stops before its final status update',async()=>{
 const f=await fixture('incomplete');try{
  const transition=f.store.transitionImageGeneration.bind(f.store);
  f.store.transitionImageGeneration=async(id,patch)=>{if(patch.state==='unknown')throw Error('synthetic stop before provisional marker');return transition(id,patch);};
  await f.request();await until(()=>!!f.store.imageGenerations()[0]?.resultInfo);
  await until(()=>!(f.image as unknown as {jobs:Map<string,unknown>}).jobs.size);
  const unfinished=f.store.imageGenerations()[0]!;assert.equal(unfinished.terminalStatus,'failed');assert.equal(unfinished.errorCode,undefined);
  await f.reopen();const recovered=f.store.imageGenerations()[0]!;assert.equal(recovered.state,'unknown');assert.equal(recovered.errorCode,'IMAGE_TURN_INCOMPLETE');
  const shown=await f.image.image(f.task.task.id,recovered.id);assert.equal(shown.provisional,true);assert.equal(shown.dataUrl,`data:image/png;base64,${png}`);
  assert.equal(f.calls,1);assert.equal((await f.store.snapshot()).artifacts.length,0);
  await assert.rejects(f.image.attach({requestId:'never-attach-incomplete',expectedStoreRevision:(await f.store.snapshot()).storeRevision,taskId:f.task.task.id,generationId:recovered.id,sessionId:f.task.coordinationSession.id,draftKey:f.task.coordinationSession.id}),{code:'IMAGE_RESULT_UNAVAILABLE'});
 }finally{await f.close();}
});

test('a proof without a published image does not become a saved provisional image after restart',async()=>{
 const f=await fixture('hold');try{
  await f.request();await until(()=>f.store.imageGenerations()[0]?.state==='running');const record=f.store.imageGenerations()[0]!;
  await f.store.retainImageResultProof(record.id,(await inspectGeneratedImage(png)).info,'failed');
  await f.reopen();const recovered=f.store.imageGenerations()[0]!;assert.equal(recovered.state,'unknown');assert.ok(recovered.resultInfo);assert.notEqual(recovered.errorCode,'IMAGE_TURN_INCOMPLETE');
  await assert.rejects(f.image.image(f.task.task.id,recovered.id),{code:'IMAGE_RESULT_UNAVAILABLE'});assert.equal(f.calls,1);assert.equal((await f.store.snapshot()).artifacts.length,0);
 }finally{await f.close();}
});

test('artifact inspector returns the verified image buffer when the filesystem changes after verification',async()=>{
 const f=await fixture();try{
  await f.request();const record=await f.finished(),artifact=(await f.store.snapshot()).artifacts[0]!;
  const original=f.workspace.root.bind(f.workspace);
  f.workspace.root=async source=>{const result=await original(source);await writeFile(artifact.managedPath!,Buffer.from('changed after verification'));return result;};
  const shown=await f.workspace.handle('workspace.read',{source:{artifactId:artifact.id},path:'image.png'}) as {dataUrl:string;digest:string};
  assert.equal(shown.dataUrl,`data:image/png;base64,${png}`);assert.equal(shown.digest,record.resultInfo!.digest);
  await assert.rejects(f.image.image(f.task.task.id,record.id),{code:'IMAGE_RECORD_CHANGED'});
 }finally{await f.close();}
});

test('the dedicated image and generic artifact inspector reject changed runtime source metadata',async()=>{
 const f=await fixture();try{
  await f.request();const record=await f.finished(),artifact=(await f.store.snapshot()).artifacts[0]!;
  const database=(f.store as unknown as {database:{prepare:(sql:string)=>{run:(...values:unknown[])=>unknown}}}).database;
  database.prepare('UPDATE artifacts SET metadata_json=? WHERE id=?').run(JSON.stringify({...artifact.metadata as Record<string,unknown>,threadId:'unrelated-runtime-thread'}),artifact.id);
  await assert.rejects(f.image.image(f.task.task.id,record.id),{code:'IMAGE_RECORD_CHANGED'});
  await assert.rejects(f.workspace.handle('workspace.read',{source:{artifactId:artifact.id},path:'image.png'}),error=>String(error).includes('IMAGE_RECORD_CHANGED'));
 }finally{await f.close();}
});

test('Project export checks the Project folder identity captured before the native dialog',async()=>{
 const f=await fixture();try{
  const directory=join(f.root,'project');await mkdir(directory);let snapshot=await f.store.snapshot();
  const project=await f.store.createProject({requestId:'export-project',expectedStoreRevision:snapshot.storeRevision,title:'Export project',directory});
  const task=await f.store.createTask({requestId:'export-task',expectedStoreRevision:project.storeRevision,scope:{kind:'project',projectId:project.project.id},title:'Project image',goal:'Export with folder identity'});
  const started=await f.image.start({requestId:'project-image',expectedStoreRevision:task.storeRevision,taskId:task.task.id,sessionId:task.coordinationSession.id,description:'One test image'});
  await until(()=>f.store.imageGenerations(task.task.id)[0]?.state==='succeeded');
  const context=await f.image.context(task.task.id,started.generation.id);
  const originalAlbum=join(directory,'..photos');await mkdir(originalAlbum);const originalIdentity=await stat(originalAlbum);
  await f.image.export(task.task.id,started.generation.id,join(originalAlbum,'image.png'),context,{directory:originalAlbum,device:String(originalIdentity.dev),inode:String(originalIdentity.ino)});
  assert.deepEqual(await readFile(join(originalAlbum,'image.png')),Buffer.from(png,'base64'));
  await rename(directory,join(f.root,'old-project'));await mkdir(directory);
  for(const name of ['', '..photos', 'album']){
   const replacement=join(directory,name);await mkdir(replacement,{recursive:true});const current=await stat(replacement);
   await assert.rejects(f.image.export(task.task.id,started.generation.id,join(replacement,'image.png'),context,{directory:replacement,device:String(current.dev),inode:String(current.ino)}),error=>String(error).includes('IMAGE_EXPORT_PROJECT_CHANGED'));
   await assert.rejects(readFile(join(replacement,'image.png')),{code:'ENOENT'});
  }
 }finally{await f.close();}
});

test('cancelling during preflight is a confirmed cancellation and never invokes generation',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'dcode-image-preflight-cancel-'))),home=join(root,'home');await mkdir(home);const store=await ProductStore.open({dataRoot:join(root,'.dcode'),userHome:home});let calls=0;
 const factory:ImageBackendFactory=async signal=>({turnRequested:false,capability:async()=>new Promise<ImageCapability>((_resolve,reject)=>{signal.addEventListener('abort',()=>reject(new ImageGenerationError('IMAGE_CANCELLED')),{once:true});}),generate:async()=>{calls++;throw Error('generation must not start');},login:async()=>{},close:async()=>{}});
 const controller=new ImageGenerationController(store,()=>{},factory);
 try{const snapshot=await store.snapshot(),task=await store.createTask({requestId:'preflight-task',expectedStoreRevision:snapshot.storeRevision,scope:{kind:'user',userId:snapshot.currentUser.id},title:'Preflight cancel',goal:'No generation on cancel'});const input={requestId:'preflight-request',expectedStoreRevision:task.storeRevision,taskId:task.task.id,sessionId:task.coordinationSession.id,description:'未发出的描述'};const record=await controller.start(input);await new Promise(resolve=>setTimeout(resolve,10));await controller.cancel(task.task.id,record.generation.id);assert.equal(store.imageGenerations()[0]!.state,'cancelled');await controller.start(input);assert.equal(calls,0);}finally{await controller.close();await store.close();await rm(root,{recursive:true,force:true});}
});

test('binary image bytes are not interpreted as credential text, while UTF-8 secret resources still fail closed',async()=>{
 const files=new (await import('../src/workspace-files.js')).WorkspaceFiles();
 const secret='OPENAI_API_KEY=sk-proj-'+('A'.repeat(80));
 const binary=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.from(secret)]);
 (files as unknown as {call:()=>Promise<unknown>}).call=async()=>({ok:true,base64:binary.toString('base64')});
 assert.equal((await files.asset('/private/tmp','image.png')).base64,binary.toString('base64'));
 (files as unknown as {call:()=>Promise<unknown>}).call=async()=>({ok:true,base64:Buffer.from(secret).toString('base64')});
 await assert.rejects(files.asset('/private/tmp','config.js'),{code:'FILE_CREDENTIAL_MATERIAL'});
});
