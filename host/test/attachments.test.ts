import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,mkdir,writeFile,readFile,rm,stat,symlink,rename,readdir,open } from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {ProductStore} from "../src/product-store.js";
import {ATTACHMENT_DAY,attachmentPath,attachmentPrompt,stageAttachment} from "../src/attachment-files.js";
import {validateMethodParams} from "../src/protocol.js";

test("owned draft attachments survive restart, source changes and text edits; expire after one day without deleting history",async()=>{
  const root=await mkdtemp(join(tmpdir(),"dcode-attachments-")),home=join(root,"home"),dataRoot=join(root,".dcode");await mkdir(home);
  let time=Date.parse("2026-09-06T00:00:00Z");const options={dataRoot,userHome:home,now:()=>new Date(time).toISOString()};
  let store=await ProductStore.open(options);
  try {
    const source=join(root,"说明.txt");await writeFile(source,"原始附件内容");
    const input={requestId:"attach-replay",expectedStoreRevision:0,draftKey:"new:user",source:{path:source}};
    const added=await store.importAttachment(input);
    const path=attachmentPath(store.layout,added.attachment);
    assert.match(path,/\.dcode\/tmp\/attachments\//);assert.equal((await stat(path)).mode&0o777,0o600);
    await writeFile(source,"原件已改变");assert.equal(await readFile(path,"utf8"),"原始附件内容");
    await rename(source,source+".moved");assert.deepEqual(await store.importAttachment(input),added);
    let snapshot=await store.snapshot();
    await store.setTaskDraft({requestId:"edit-text",expectedStoreRevision:snapshot.storeRevision,scope:{kind:"user",userId:snapshot.currentUser.id},text:"新的文字"});
    await store.close();store=await ProductStore.open(options);
    snapshot=await store.snapshot();assert.equal(snapshot.composerDrafts[0]!.attachments?.[0]?.id,added.attachment.id);assert.equal(snapshot.composerDrafts[0]!.text,"新的文字");
    time+=ATTACHMENT_DAY+1;
    await assert.rejects(store.resolveAttachment(added.attachment.id),{code:"ATTACHMENT_EXPIRED"});
    assert.equal(await store.sweepAttachments(),1);
    await assert.rejects(stat(path),{code:"ENOENT"});
    assert.equal((await store.snapshot()).composerDrafts[0]!.attachments?.[0]?.name,"说明.txt");
    assert.equal(await readFile(source+".moved","utf8"),"原件已改变");
  }finally{await store.close();await rm(root,{recursive:true,force:true});}
});

test("accepted submissions atomically retain files for thirty days and separate authored input from expanded paths",async()=>{
  const root=await mkdtemp(join(tmpdir(),"dcode-attachment-submit-")),home=join(root,"home"),dataRoot=join(root,".dcode");await mkdir(home);
  let time=Date.parse("2026-09-06T00:00:00Z");const store=await ProductStore.open({dataRoot,userHome:home,now:()=>new Date(time).toISOString()});
  try {
    const source=join(root,"input.txt");await writeFile(source,"sample");
    const added=await store.importAttachment({requestId:"attach",expectedStoreRevision:0,draftKey:"new:user",source:{path:source}});
    let snapshot=await store.snapshot();
    const task=await store.createTask({requestId:"create",expectedStoreRevision:snapshot.storeRevision,scope:{kind:"user",userId:snapshot.currentUser.id},title:"附件任务",goal:"检查附件"});
    const params={requestId:"submit",taskId:task.task.id,sessionId:task.coordinationSession.id,scope:task.task.scope,runtimeId:"runtime",workspaceId:"workspace",cwd:home,workspaceAccess:"exclusiveWrite" as const,message:"原始提交",attachmentRefs:[added.attachment],managedAttachmentIds:[added.attachment.id],roleRevision:"builtin-coordinator:v1",contextRevision:1,profileSnapshot:{role:"coordinator"},tools:[],toolsWritable:false,systemPromptDigest:`sha256:${"a".repeat(64)}`,promptSources:[]};
    await assert.rejects(store.prepareSessionRun({...params,requestId:"bad-target",contextRevision:100}),{code:"REVISION_CONFLICT"});
    assert.equal((await store.snapshot()).artifacts.length,0,"Failed submission must not extend retention");
    await store.prepareSessionRun(params);
    const retained=store.attachmentCatalog().find(item=>item.id===added.attachment.id)!;
    assert.equal(Date.parse(retained.expiresAt)-time,30*ATTACHMENT_DAY);
    snapshot=await store.snapshot();
    await store.setTaskDraft({requestId:"clear",expectedStoreRevision:snapshot.storeRevision,scope:task.task.scope,text:"",attachmentIds:[]});
    time+=2*ATTACHMENT_DAY;assert.equal(await store.sweepAttachments(),0);assert.ok((await store.resolveAttachment(retained.id)).path);
    const db=new DatabaseSync(store.layout.productStorePath,{readOnly:true});
    try {assert.equal((db.prepare("SELECT submitted_text FROM raw_inputs").get() as {submitted_text:string}).submitted_text,"原始提交");
      const value=db.prepare("SELECT effective_content_json FROM effective_inputs").get() as {effective_content_json:string};assert.equal(JSON.parse(value.effective_content_json).message,attachmentPrompt("原始提交",[added.attachment],store.layout));
    }finally{db.close();}
    time+=29*ATTACHMENT_DAY;assert.equal(await store.sweepAttachments(),1);
    assert.equal((await store.snapshot()).artifacts.length,1,"Expired attachment names remain in history");
  }finally{await store.close();await rm(root,{recursive:true,force:true});}
});

test("attachment imports reject unsafe sources and garbage collection cannot escape its owned root",async()=>{
  const root=await mkdtemp(join(tmpdir(),"dcode-attachment-safety-")),home=join(root,"home");await mkdir(home);const store=await ProductStore.open({dataRoot:join(root,".dcode"),userHome:home});
  try {
    const source=join(root,"readme.txt"),link=join(root,"link.txt");await writeFile(source,"safe");await symlink(source,link);
    await assert.rejects(store.importAttachment({requestId:"symlink",expectedStoreRevision:0,draftKey:"new:user",source:{path:link}}));
    await writeFile(join(root,".env"),"TOKEN=not-for-attachment");
    await assert.rejects(store.importAttachment({requestId:"credentials",expectedStoreRevision:0,draftKey:"new:user",source:{path:join(root,".env")}}),{code:"CREDENTIAL_MATERIAL_REJECTED"});
    for(const name of [".npmrc","config"]){
      await writeFile(join(root,name),"password=fixture-secret-value");
      await assert.rejects(store.importAttachment({requestId:`credential-${name}`,expectedStoreRevision:0,draftKey:"new:user",source:{path:join(root,name)}}),{code:"CREDENTIAL_MATERIAL_REJECTED"});
    }
    await assert.rejects(store.resolveAttachment("../../outside"),{code:"NOT_FOUND"});
    await rm(join(store.layout.root,"tmp"),{recursive:true,force:true});await symlink(root,join(store.layout.root,"tmp"));
    await assert.rejects(store.sweepAttachments(),{code:"INVALID_ATTACHMENT"});assert.equal(await readFile(source,"utf8"),"safe");
    validateMethodParams("dcodeSession.prompt",{dcodeSessionId:"s",promptId:"p",message:"",attachmentIds:["attachment-"+"a".repeat(32)]});
    assert.throws(()=>validateMethodParams("attachment.resolve",{id:"../readme.txt"}));
  }finally{await store.close();await rm(root,{recursive:true,force:true});}
});

test("failed limits leave no new files and unregistered files count toward the disk quota",async()=>{
  const root=await mkdtemp(join(tmpdir(),"dcode-attachment-limits-")),home=join(root,"home");await mkdir(home);const store=await ProductStore.open({dataRoot:join(root,".dcode"),userHome:home});
  try {
    const source=join(root,"image.png");await writeFile(source,Buffer.from([137,80,78,71,13,10,26,10]));
    for(let i=0;i<8;i++)await store.importAttachment({requestId:`image-${i}`,expectedStoreRevision:(await store.snapshot()).storeRevision,draftKey:"new:user",source:{path:source}});
    const directory=join(store.layout.root,"tmp","attachments");const before=await readdir(directory);
    await assert.rejects(store.importAttachment({requestId:"ninth",expectedStoreRevision:(await store.snapshot()).storeRevision,draftKey:"new:user",source:{path:source}}),{code:"ATTACHMENT_LIMIT"});
    assert.deepEqual(await readdir(directory),before);
    const orphan=join(directory,"attachment-"+"f".repeat(32));await mkdir(orphan);await writeFile(join(orphan,"manifest.json"),JSON.stringify({id:"attachment-"+"f".repeat(32),createdAt:new Date().toISOString()}));
    const sparse=await open(join(orphan,"body-sparse"),"w");await sparse.truncate(500_000_000);await sparse.close();
    const text=join(root,"ordinary.txt");await writeFile(text,"ordinary file");
    await assert.rejects(store.importAttachment({requestId:"quota",expectedStoreRevision:(await store.snapshot()).storeRevision,draftKey:"new:user",source:{path:text}}),{code:"ATTACHMENT_STORAGE_FULL"});
    assert.equal((await readdir(directory)).length,9);
  }finally{await store.close();await rm(root,{recursive:true,force:true});}
});

test("a corrupt temporary manifest is isolated without stopping the remaining expiration sweep",async()=>{
  const root=await mkdtemp(join(tmpdir(),"dcode-attachment-corrupt-")),home=join(root,"home");await mkdir(home);let time=Date.parse("2026-09-06T00:00:00Z");const store=await ProductStore.open({dataRoot:join(root,".dcode"),userHome:home,now:()=>new Date(time).toISOString()});
  try {
    const source=join(root,"input.txt");await writeFile(source,"sample");await store.importAttachment({requestId:"valid",expectedStoreRevision:0,draftKey:"new:user",source:{path:source}});
    const corrupt=join(store.layout.root,"tmp","attachments","attachment-"+"b".repeat(32));await mkdir(corrupt);await writeFile(join(corrupt,"manifest.json"),"{invalid");
    time+=ATTACHMENT_DAY+1;assert.equal(await store.sweepAttachments(),1);assert.equal(await readFile(join(corrupt,"manifest.json"),"utf8"),"{invalid");
  }finally{await store.close();await rm(root,{recursive:true,force:true});}
});

test("unregistered immutable manifests only permit orphan cleanup after a day",async()=>{
  const root=await mkdtemp(join(tmpdir(),"dcode-attachment-orphan-")),home=join(root,"home");await mkdir(home);let time=Date.parse("2026-09-06T00:00:00Z");const store=await ProductStore.open({dataRoot:join(root,".dcode"),userHome:home,now:()=>new Date(time).toISOString()});
  try {
    const source=join(root,"manifest.json");await writeFile(source,"{}");
    const record=await stageAttachment(store.layout,{path:source},"attachment-"+"a".repeat(32),new Date(time).toISOString());
    assert.equal(await readFile(attachmentPath(store.layout,record),"utf8"),"{}");
    assert.equal(await store.sweepAttachments(),0);time+=ATTACHMENT_DAY+1;assert.equal(await store.sweepAttachments(),1);
  }finally{await store.close();await rm(root,{recursive:true,force:true});}
});
