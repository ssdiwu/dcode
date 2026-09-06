import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID,createHash} from "node:crypto";
import {mkdtemp,mkdir,readFile,writeFile,rename,rm,symlink,chmod} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {ProductStore} from "../src/product-store.js";
import {assertIdeaSnapshotDigest,type InspirationOperation} from "../src/inspiration.js";
import {loadDCodePromptDocuments} from "../src/prompt-assembler.js";

async function fixture(){const root=await mkdtemp(join(tmpdir(),"dcode-inspiration-")),home=join(root,"home");await mkdir(home);const options={dataRoot:join(home,".dcode"),userHome:home};return {root,home,options,store:await ProductStore.open(options)};}
const id=()=>`idea-${randomUUID()}`;
const save=(nodeId:string,title:string,markdown:string,expectedNodeRevision=0):InspirationOperation=>({kind:"save",node:{id:nodeId,kind:"text",title,markdown},expectedNodeRevision});
async function mutate(store:ProductStore,operation:InspirationOperation){return store.mutateInspiration({requestId:randomUUID(),expectedStoreRevision:(await store.snapshot()).storeRevision,operation});}

test("inspiration persists content, draft and layout independently and refuses stale content edits",async()=>{
  const f=await fixture();let store=f.store;
  try {
    assert.deepEqual(store.inspirationView().nodes,[]);
    const first=id(),second=id();await mutate(store,save(first,"第一个想法","# Markdown 原文"));await mutate(store,save(second,"另一个想法","用于连线"));
    await mutate(store,{kind:"move",positions:{[first]:{x:340,y:180}}});
    assert.equal(store.inspirationView().nodes[0]?.markdown,"# Markdown 原文");assert.equal(store.inspirationView().nodes[0]?.revision,1);
    await mutate(store,{kind:"connect",from:first,to:second});await mutate(store,{kind:"group",id:randomUUID(),title:"调研",nodeIds:[first,second]});
    await mutate(store,{kind:"viewport",viewport:{x:-200,y:70,zoom:.75}});
    const draft={id:id(),kind:"text" as const,title:"未完成",markdown:"编辑中",url:"",tags:"",expectedNodeRevision:0};await mutate(store,{kind:"draft",draft});
    await store.close();store=await ProductStore.open(f.options);
    const view=store.inspirationView();assert.equal(view.nodes.length,2);assert.equal(view.edges.length,1);assert.equal(view.groups[0]?.title,"调研");assert.deepEqual(view.positions[first],{x:340,y:180});assert.deepEqual(view.draft,draft);assert.equal(view.viewport.zoom,.75);
    await mutate(store,save(first,"第一个想法","更新正文",1));
    await assert.rejects(mutate(store,save(first,"旧编辑","不得覆盖",1)),{code:"IDEA_REVISION_CONFLICT"});
    assert.equal(store.inspirationView().nodes[0]?.markdown,"更新正文");
    assert.deepEqual(store.inspirationView().positions[first],{x:340,y:180});
  }finally{await store.close();await rm(f.root,{recursive:true,force:true});}
});

test("references enter actual task context, preserve other sources and retain previous Markdown versions through archive",async()=>{
  const f=await fixture(),store=f.store;
  try {
    const snapshot=await store.snapshot();const task=await store.createTask({requestId:randomUUID(),expectedStoreRevision:snapshot.storeRevision,scope:{kind:"user",userId:snapshot.currentUser.id},title:"使用灵感",goal:"验证真实知识上下文"});
    await writeFile(join(f.home,"existing.md"),"现有任务资料");
    await store.replaceTaskContext({requestId:randomUUID(),expectedStoreRevision:(await store.snapshot()).storeRevision,taskId:task.task.id,scope:task.task.scope,expectedContextRevision:1,sources:[{kind:"scope_document",relativePath:"existing.md",title:"原有资料"}]});
    const nodeId=id();await mutate(store,save(nodeId,"知识节点","这是第一版知识。"));
    const input={requestId:randomUUID(),expectedStoreRevision:(await store.snapshot()).storeRevision,nodeId,nodeRevision:1,taskId:task.task.id};
    const linked=await store.referenceInspiration(input);assert.deepEqual(await store.referenceInspiration(input),linked);
    let context=(await store.snapshot()).taskContextSets.find(set=>set.taskId===task.task.id)!;
    assert.equal(context.sources.length,2);assert.equal(context.sources[0]?.relativePath,"existing.md");
    const source=context.sources.find(source=>source.kind==="global_knowledge")!;
    const documents=await loadDCodePromptDocuments(f.home,{sources:context.sources});
    assert.ok(documents.some(document=>document.content.includes("这是第一版知识。")),"The real prompt loader must consume the referenced Markdown");
    const oldPath=join(source.rootPath!,source.relativePath);assert.match(await readFile(oldPath,"utf8"),/第一版/);
    await mutate(store,save(nodeId,"知识节点","这是第二版知识。",1));
    await store.referenceInspiration({requestId:randomUUID(),expectedStoreRevision:(await store.snapshot()).storeRevision,nodeId,nodeRevision:2,taskId:task.task.id});
    context=(await store.snapshot()).taskContextSets.find(set=>set.taskId===task.task.id)!;
    assert.equal(context.sources.length,2);assert.notEqual(context.sources[1]?.relativePath,source.relativePath);assert.match(await readFile(oldPath,"utf8"),/第一版/);
    await mutate(store,{kind:"archive",nodeId,archived:true});assert.equal((await store.snapshot()).taskContextSets.find(set=>set.taskId===task.task.id)?.sources.length,2);
    await mutate(store,{kind:"archive",nodeId,archived:false});assert.equal(store.inspirationView().nodes[0]?.archived,false);
    await chmod(oldPath,0o600);await writeFile(oldPath,"被外部改写");
    await assert.rejects(assertIdeaSnapshotDigest(store.layout,oldPath,`sha256:${createHash("sha256").update("被外部改写").digest("hex")}`),{code:"IDEA_SNAPSHOT_CHANGED"});
  }finally{await store.close();await rm(f.root,{recursive:true,force:true});}
});

test("knowledge media has permanent copies, preview survives source moves, and unsafe sources are rejected",async()=>{
  const f=await fixture(),store=f.store;
  try {
    const path=join(f.home,"image.png"),bytes=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==","base64");await writeFile(path,bytes);
    const nodeId=id();await mutate(store,{kind:"save",node:{id:nodeId,kind:"image",title:"图片灵感",markdown:"图片说明"},expectedNodeRevision:0,mediaPath:path});
    const media=await store.inspirationMedia(nodeId);assert.match(media.path,/\.dcode\/knowledge\/inspiration\/media/);assert.equal(media.data,bytes.toString("base64"));
    await rename(path,path+".moved");await store.sweepAttachments();assert.equal((await store.inspirationMedia(nodeId)).data,media.data);
    const exported=await store.inspirationMarkdown(nodeId);assert.match(await readFile(exported.path,"utf8"),/\.\.\/media\//);
    await mutate(store,{kind:"save",node:{id:id(),kind:"link",title:"链接灵感",markdown:"引用资料",url:"https://example.com/article"},expectedNodeRevision:0});
    const video=join(f.home,"video.mp4");await writeFile(video,Buffer.from([0,0,0,24,102,116,121,112,105,115,111,109]));
    await mutate(store,{kind:"save",node:{id:id(),kind:"video",title:"视频灵感",markdown:"视频说明"},expectedNodeRevision:0,mediaPath:video});
    await assert.rejects(mutate(store,{kind:"save",node:{id:id(),kind:"link",title:"坏链接",markdown:"",url:"javascript:alert(1)"},expectedNodeRevision:0}),{code:"INVALID_IDEA"});
    await assert.rejects(mutate(store,save(id(),"凭据","password=fixture-secret-value")),{code:"CREDENTIAL_MATERIAL_REJECTED"});
    const link=join(f.home,"linked.png");await symlink(path+".moved",link);
    await assert.rejects(mutate(store,{kind:"save",node:{id:id(),kind:"image",title:"不安全来源",markdown:""},expectedNodeRevision:0,mediaPath:link}));
  }finally{await store.close();await rm(f.root,{recursive:true,force:true});}
});

test("drafts reject extra fields and unknown task sources without persisting them",async()=>{
  const f=await fixture();
  try {
    const draft={id:id(),kind:"text" as const,title:"草稿",markdown:"内容",url:"",tags:"",expectedNodeRevision:0};
    const extra={...draft,apiKey:"fixture-private-value"};
    await assert.rejects(mutate(f.store,{kind:"draft",draft:extra}),{code:"INVALID_IDEA"});
    await assert.rejects(mutate(f.store,{kind:"draft",draft:{...draft,sourceTaskId:"missing-task"}}),{code:"IDEA_SOURCE_NOT_FOUND"});
    assert.equal(f.store.inspirationView().draft,undefined);
    assert.doesNotMatch(JSON.stringify(f.store.inspirationView()),/fixture-private-value/);
  }finally{await f.store.close();await rm(f.root,{recursive:true,force:true});}
});

test("inspiration references respect the task context limit and do not replace unrelated selections on failure",async()=>{
  const f=await fixture(),store=f.store;
  try {
    const snapshot=await store.snapshot();const task=await store.createTask({requestId:randomUUID(),expectedStoreRevision:snapshot.storeRevision,scope:{kind:"user",userId:snapshot.currentUser.id},title:"完整上下文",goal:"保护已有选择"});
    const sources=await Promise.all(Array.from({length:32},async(_,i)=>{const relativePath=`source-${i}.md`;await writeFile(join(f.home,relativePath),`资料 ${i}`);return {kind:"scope_document" as const,relativePath,title:`资料 ${i}`};}));
    await store.replaceTaskContext({requestId:randomUUID(),expectedStoreRevision:(await store.snapshot()).storeRevision,taskId:task.task.id,scope:task.task.scope,expectedContextRevision:1,sources});
    const nodeId=id();await mutate(store,save(nodeId,"新的灵感","不能挤掉资料"));
    const before=(await store.snapshot()).taskContextSets.find(set=>set.taskId===task.task.id);
    await assert.rejects(store.referenceInspiration({requestId:randomUUID(),expectedStoreRevision:(await store.snapshot()).storeRevision,nodeId,nodeRevision:1,taskId:task.task.id}),{code:"TASK_CONTEXT_LIMIT"});
    assert.deepEqual((await store.snapshot()).taskContextSets.find(set=>set.taskId===task.task.id),before);
  }finally{await store.close();await rm(f.root,{recursive:true,force:true});}
});
