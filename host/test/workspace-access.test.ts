import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,writeFile,readFile,rm,rename,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {WorkspaceAccess} from '../src/workspace-access.js';
import {WorkspaceWriteGuard} from '../src/workspace-write-guard.js';
import type {ProductStore,FoundationSnapshot} from '../src/product-store.js';
import {PiHost} from '../src/pi-host.js';
const git=async(root:string,...args:string[])=>await promisify(execFile)('git',['-C',root,...args]);
const until=async(check:()=>boolean|Promise<boolean>)=>{const end=Date.now()+10000;while(!await check()){if(Date.now()>end)throw new Error('test condition timed out');await new Promise(resolve=>setTimeout(resolve,10));}};

test('Git filters tracked sensitive paths and rejects both staged and working diffs, including rename sources',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dcode-git-scope-'));const access=new WorkspaceAccess(async()=>{throw new Error('no store needed');});
 try{
  await git(root,'init');for(const name of ['.env','.ENV.local','AUTH.JSON','note.md'])await writeFile(join(root,name),'ordinary fixture before\n');await git(root,'add','.');await git(root,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','fixture');
  for(const name of ['.env','.ENV.local','AUTH.JSON','note.md'])await writeFile(join(root,name),'ordinary fixture after\n');await git(root,'add','.ENV.local');
  const status=await access.gitStatus(root);assert.deepEqual(status.files.map(file=>file.path),['note.md']);assert.equal(status.hiddenCount,3);
  for(const name of ['.env','.ENV.local','AUTH.JSON'])for(const staged of [false,true])await assert.rejects(access.diff(root,name,staged),error=>(error as {code:string}).code==='FILE_SCOPE');
  assert.match((await access.diff(root,'note.md',false)).diff,/ordinary fixture after/);
  const alias=root+'-link';await symlink(root,alias);try{await assert.rejects(access.gitStatus(alias),/链接|目录/);}finally{await rm(alias);}
  await git(root,'restore','.env');await git(root,'mv','.env','renamed.md');assert.ok(!(await access.gitStatus(root)).files.some(file=>file.path==='renamed.md'));await assert.rejects(access.diff(root,'renamed.md',true),/没有这个文件/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('a registered file artifact never grants its parent Git or directory listing',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dcode-file-artifact-'));await writeFile(join(root,'allowed.md'),'allowed');await writeFile(join(root,'sibling.md'),'not registered');
 const snapshot={tasks:[],projects:[],managedWorkerWorktrees:[],artifacts:[{id:'only-file',kind:'document',taskId:'owner-task',title:'Allowed',externalPath:join(root,'allowed.md')}]} as unknown as FoundationSnapshot;
 const access=new WorkspaceAccess(async()=>({snapshot:async()=>snapshot}) as unknown as ProductStore);
 try{
  assert.equal((await access.handle('workspace.read',{source:{artifactId:'only-file'}}) as {text:string}).text,'allowed');
  for(const action of ['workspace.git','workspace.tree','workspace.diff'])await assert.rejects(access.handle(action,{source:{artifactId:'only-file'}}),/单个文件/);
  await assert.rejects(access.handle('workspace.diff',{source:{artifactId:'only-file'},path:'sibling.md'}),/登记的文件/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('save reservations cover parent/child paths and release after failure',async()=>{
 let writers=['/tmp/repo/nested'];const guard=new WorkspaceWriteGuard(()=>writers);
 await assert.rejects(guard.run('/private/tmp/repo',async()=>{}),/正在准备或写入/);writers=[];
 let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});const first=guard.run('/tmp/repo',async()=>await held);
 assert.equal(guard.conflict('/private/tmp/REPO/nested'),'file-save');await assert.rejects(guard.run('/tmp/repo/nested',async()=>{}),/正在准备或写入/);
 release();await first;assert.equal(guard.conflict('/tmp/repo/nested'),undefined);await assert.rejects(guard.run('/tmp/repo',async()=>{throw new Error('fixture write failed');}),/fixture write failed/);assert.equal(guard.conflict('/tmp/repo'),undefined);
});

test('Host file saves and runtime startup share write ownership in both directions',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dcode-file-host-')),agent=join(root,'agent'),project=join(root,'project'),nested=join(project,'nested');await mkdir(agent);await mkdir(nested,{recursive:true});await writeFile(join(project,'note.md'),'before');
 await writeFile(join(agent,'settings.json'),JSON.stringify({defaultProvider:'fixture',defaultModel:'fixture'}));await writeFile(join(agent,'models.json'),JSON.stringify({providers:{fixture:{baseUrl:'https://fixture.invalid',api:'openai-completions',apiKey:'fixture-only',models:[{id:'fixture',name:'Fixture',reasoning:false,input:['text'],contextWindow:100000,maxTokens:4096}]}}}));
 const host=new PiHost({agentDir:agent,sessionsDirectory:join(agent,'sessions'),dataRoot:join(root,'.dcode'),userHome:root,emit:()=>{}});let release:()=>void=()=>{};
 try{
  await host.start();let snapshot=await host.handle('foundation.snapshot',{}) as FoundationSnapshot;
  const createProject=async(id:string,directory:string)=>host.handle('project.create',{requestId:id,expectedStoreRevision:(await host.handle('foundation.snapshot',{}) as FoundationSnapshot).storeRevision,title:id,directory}) as Promise<{project:{id:string}}>;
  const p=await createProject('parent',project),child=await createProject('nested',nested);
  const createTask=async(id:string,projectId:string)=>host.handle('task.create',{requestId:id,expectedStoreRevision:(await host.handle('foundation.snapshot',{}) as FoundationSnapshot).storeRevision,scope:{kind:'project',projectId},title:id,goal:'file ownership'}) as Promise<{task:{id:string;scope:unknown};coordinationSession:{id:string}}>;
  const task=await createTask('writer',p.project.id),nestedTask=await createTask('nested-writer',child.project.id);
  const start=(runtimeId:string,target:typeof task,cwd:string)=>host.handle('runtime.start',{runtimeId,taskId:target.task.id,dcodeSessionId:target.coordinationSession.id,scope:target.task.scope,workspace:{workspaceId:runtimeId,cwd,access:'exclusiveWrite'}});
  const file=await host.handle('workspace.read',{source:{projectId:p.project.id},path:'note.md'}) as {digest:string;root:string};
  await start('writer-runtime',task,project);await assert.rejects(host.handle('workspace.save',{source:{projectId:p.project.id},path:'note.md',text:'blocked',expectedDigest:file.digest,expectedRoot:file.root}),/正在准备或写入/);await host.handle('session.close',{runtimeId:'writer-runtime'});
  const workspace=(host as unknown as {workspaceAccess:WorkspaceAccess}).workspaceAccess,save=workspace.files.save.bind(workspace.files);let saving=false;const held=new Promise<void>(resolve=>{release=resolve;});workspace.files.save=async(...args)=>{saving=true;await held;return save(...args);};
  const pending=host.handle('workspace.save',{source:{projectId:p.project.id},path:'note.md',text:'after',expectedDigest:file.digest,expectedRoot:file.root});await until(()=>saving);await assert.rejects(start('nested-runtime',nestedTask,nested),/WORKSPACE|目录正在保存|workspace/i);release();await pending;assert.equal(await readFile(join(project,'note.md'),'utf8'),'after');await start('nested-runtime-after',nestedTask,nested);await host.handle('session.close',{runtimeId:'nested-runtime-after'});
 }finally{release();await host.close();await rm(root,{recursive:true,force:true});}
});


test('legacy startup and shutdown continuously reserve the directory, including startup failure',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dcode-legacy-save-')),agent=join(root,'agent'),project=join(root,'project'),other=join(root,'unrelated'),sessions=join(agent,'sessions');
 await mkdir(sessions,{recursive:true});await mkdir(project);await mkdir(other);await writeFile(join(agent,'settings.json'),'{}');await writeFile(join(project,'note.md'),'before');await writeFile(join(other,'note.md'),'unrelated');
 const id='legacy-file-owner',timestamp=new Date().toISOString();await writeFile(join(sessions,id+'.jsonl'),JSON.stringify({type:'session',version:3,id,timestamp,cwd:project})+'\n'+JSON.stringify({type:'message',id:'seed',parentId:null,timestamp,message:{role:'user',content:'Fixture only',timestamp:Date.now()}})+'\n');
 const host=new PiHost({agentDir:agent,sessionsDirectory:sessions,dataRoot:join(root,'.dcode'),userHome:root,emit:()=>{}});let release=()=>{};
 try{
  await host.start();
  const register=async(directory:string)=>host.handle('project.create',{requestId:directory,expectedStoreRevision:(await host.handle('foundation.snapshot',{}) as FoundationSnapshot).storeRevision,title:directory===project?'Project':'Other',directory}) as Promise<{project:{id:string}}>;
  const p=await register(project),o=await register(other);
  const save=async(projectId:string,text:string)=>{const file=await host.handle('workspace.read',{source:{projectId},path:'note.md'}) as {digest:string;root:string};return host.handle('workspace.save',{source:{projectId},path:'note.md',text,expectedDigest:file.digest,expectedRoot:file.root});};
  const internals=host as unknown as {acquireLeaseUntilIdle:(...args:unknown[])=>Promise<unknown>;legacyActive?:{session:{abort:()=>Promise<void>}};workspaceAccess:WorkspaceAccess};
  const lease=internals.acquireLeaseUntilIdle.bind(host);let opening=false,failOpen=true,gate=Promise.resolve();
  internals.acquireLeaseUntilIdle=async(...args)=>{opening=true;await gate;if(failOpen)throw new Error('fixture open failure');return lease(...args);};
  const hold=()=>{gate=new Promise<void>(resolve=>{release=resolve;});};
  hold();const failed=host.handle('session.open',{sessionId:id,mode:'writable',writeIntent:true});const expectedFailure=assert.rejects(failed,/fixture open failure/);await until(()=>opening);await assert.rejects(save(p.project.id,'must not save during startup'),/正在准备或写入/);await save(o.project.id,'other remains usable');release();await expectedFailure;await save(p.project.id,'after failed startup');
  failOpen=false;opening=false;hold();const opened=host.handle('session.open',{sessionId:id,mode:'writable',writeIntent:true});await until(()=>opening);await assert.rejects(save(p.project.id,'still blocked'),/正在准备或写入/);release();await opened;await assert.rejects(save(p.project.id,'active blocked'),/正在准备或写入/);
  let closing=false;const originalAbort=internals.legacyActive!.session.abort.bind(internals.legacyActive!.session);hold();internals.legacyActive!.session.abort=async()=>{closing=true;await gate;await originalAbort();};
  const closed=host.handle('session.close',{});await until(()=>closing);await assert.rejects(save(p.project.id,'closing blocked'),/正在准备或写入/);release();await closed;await save(p.project.id,'after close');
  const fileSave=internals.workspaceAccess.files.save.bind(internals.workspaceAccess.files);let saving=false;hold();internals.workspaceAccess.files.save=async(...args)=>{saving=true;await gate;return fileSave(...args);};
  const saved=save(p.project.id,'save owns first');await until(()=>saving);await assert.rejects(host.handle('session.open',{sessionId:id,mode:'writable',writeIntent:true}),/目录正在保存/);release();await saved;assert.equal(await readFile(join(project,'note.md'),'utf8'),'save owns first');
 }finally{release();await host.close();await rm(root,{recursive:true,force:true});}
});
