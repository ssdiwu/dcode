import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile,rename,rm,symlink} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {randomUUID} from "node:crypto";
import {unified} from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import {WorkspaceAccess} from "../src/workspace-access.js";
import type {FoundationSnapshot,ProductStore} from "../src/product-store.js";
import {PiHost} from "../src/pi-host.js";
import {validateMethodParams} from "../src/protocol.js";

type SearchResult={scopeRequired:boolean;entries:Array<{name:string;relativePath:string;reference:string;markdown:string}>;truncated:boolean};

test("rendered Markdown links cannot hide a changed file destination",async()=>{
  const access=new WorkspaceAccess(async()=>{throw new Error("invalid references must fail before reading the store");});
  for(const source of ["- item\n    [bad](dcode-file:invalid)","[bad](dcode-file&#58;invalid)","[bad](dcode-file\\:invalid)"]){
    await assert.rejects(access.validateFileMentions("task-a",source),/文件引用/,source);
  }
  await access.validateFileMentions("task-a","`[bad](dcode-file:invalid)`");
});

test("reading a file mention checks its selected identity at the actual open",async()=>{
  const root=await mkdtemp(join(tmpdir(),"dcode-file-read-")),project=join(root,"project");await mkdir(project);await writeFile(join(project,"same.md"),"selected");
  const snapshot={tasks:[{id:"task-a",scope:{kind:"project",projectId:"project-a"},cwd:project}],projects:[{id:"project-a",title:"Project",directory:project}],managedWorkerWorktrees:[],artifacts:[],projectDirectoryChanges:[]} as unknown as FoundationSnapshot;
  const access=new WorkspaceAccess(async()=>({snapshot:async()=>snapshot}) as unknown as ProductStore);
  try{
    const result=await access.handle("workspace.fileSearch",{taskId:"task-a",query:"same",limit:10}) as SearchResult;
    const reference=result.entries[0]!.reference;
    assert.equal((await access.handle("workspace.readReference",{taskId:"task-a",reference}) as {text:string}).text,"selected");
    const originalRead=access.files.readMatchingIdentity.bind(access.files);let swapped=false;
    access.files.readMatchingIdentity=async(...args)=>{
      if(!swapped){swapped=true;await rename(join(project,"same.md"),join(project,"old.md"));await writeFile(join(project,"same.md"),"replacement");}
      return originalRead(...args);
    };
    await assert.rejects(access.handle("workspace.readReference",{taskId:"task-a",reference}),/改变|重新选择/);
    assert.equal(swapped,true,"the replacement happened after Host identity validation and before native open");
  }finally{await rm(root,{recursive:true,force:true});}
});

test("Task file search reaches beyond 1000 entries and never offers secrets or symlink targets",async()=>{
  const root=await mkdtemp(join(tmpdir(),"dcode-file-mention-"));
  const project=join(root,"project"),outside=join(root,"outside");
  await mkdir(project);await mkdir(outside);await mkdir(join(project,"a"));await mkdir(join(project,"b"));await mkdir(join(project,".aws"));await mkdir(join(project,"node_modules"));await mkdir(join(project,"src"));
  const snapshot={tasks:[{id:"task-a",scope:{kind:"project",projectId:"project-a"},cwd:project},{id:"task-b",scope:{kind:"project",projectId:"project-a"},cwd:project},{id:"user-task",scope:{kind:"user",userId:"user"},cwd:root}],projects:[{id:"project-a",title:"Project",directory:project}],managedWorkerWorktrees:[],artifacts:[],projectDirectoryChanges:[]} as unknown as FoundationSnapshot;
  const access=new WorkspaceAccess(async()=>({snapshot:async()=>snapshot}) as unknown as ProductStore);
  try{
    for(let index=0;index<1_205;index++)await writeFile(join(project,`fixture-${String(index).padStart(4,"0")}.ts`),"");
    await writeFile(join(project,"z-target-1206.ts"),"export const result=1;");
    await writeFile(join(project,"a","same.ts"),"a");await writeFile(join(project,"b","same.ts"),"b");
    await writeFile(join(project,"node_modules","priority.ts"),"dependency");await writeFile(join(project,"src","priority.ts"),"source");
    await writeFile(join(project,"a&#47;b.md"),"special label");
    await writeFile(join(project,"a|b.md"),"table label");
    await writeFile(join(project,".env"),"synthetic fixture");await writeFile(join(project,"auth.json"),"synthetic fixture");await writeFile(join(project,".aws","secret.ts"),"synthetic fixture");
    await writeFile(join(outside,"outside.ts"),"outside");await symlink(outside,join(project,"linked"));
    const target=await access.handle("workspace.fileSearch",{taskId:"task-a",query:"z-target",limit:20}) as SearchResult;
    assert.deepEqual(target.entries.map(entry=>entry.relativePath),["z-target-1206.ts"]);
    const same=await access.handle("workspace.fileSearch",{taskId:"task-a",query:"same",limit:20}) as SearchResult;
    assert.deepEqual(same.entries.map(entry=>entry.relativePath),["a/same.ts","b/same.ts"]);
    const priority=await access.handle("workspace.fileSearch",{taskId:"task-a",query:"priority.ts",limit:1}) as SearchResult;
    assert.equal(priority.entries[0]?.relativePath,"src/priority.ts","source files should rank before generated directories without hiding them");
    assert.notEqual(same.entries[0]!.reference,same.entries[1]!.reference);
    assert.deepEqual(await access.handle("workspace.reference",{taskId:"task-a",reference:same.entries[0]!.reference}),{source:{taskId:"task-a"},path:"a/same.ts",kind:"file"});
    const special=await access.handle("workspace.fileSearch",{taskId:"task-a",query:"&#47;",limit:20}) as SearchResult;
    const rendered=unified().use(remarkParse).use(remarkGfm).parse(special.entries[0]!.markdown);
    const link=(rendered.children[0] as {children:Array<{type:string;children?:Array<{value:string}>}>}).children.find(node=>node.type==="link");
    assert.equal(link?.children?.[0]?.value,"a&#47;b.md","rendered label must name the selected file, without entity decoding it into another path");
    const pipe=await access.handle("workspace.fileSearch",{taskId:"task-a",query:"a|b",limit:20}) as SearchResult;
    const table=unified().use(remarkParse).use(remarkGfm).parse(`| 文件 |\n| --- |\n| ${pipe.entries[0]!.markdown} |`);
    let tableLinkCount=0;
    const visit=(node:{type:string;children?:unknown[]})=>{if(node.type==="link")tableLinkCount++;for(const child of node.children??[])visit(child as {type:string;children?:unknown[]});};
    visit(table);
    assert.equal(tableLinkCount,1,"a file name containing a pipe must remain a link inside a GFM table cell");
    await assert.rejects(access.validateFileMentions("task-a",`| 文件 |\n| --- |\n| ${pipe.entries[0]!.markdown.replace("\\|","|")} |`),/文件引用格式已改变/);
    assert.deepEqual((await access.handle("workspace.readReference",{taskId:"task-a",reference:same.entries[0]!.reference}) as {text:string}).text,"a");
    for(const query of ["secret","auth.json","outside"]){
      const found=await access.handle("workspace.fileSearch",{taskId:"task-a",query,limit:20}) as SearchResult;
      assert.equal(found.entries.length,0,query);
    }
    assert.deepEqual(await access.handle("workspace.fileSearch",{taskId:"user-task",query:"fixture",limit:20}),{scopeRequired:true,entries:[],truncated:false});
    await access.validateFileMentions("task-a",`See ${same.entries[0]!.markdown}`);
    await access.validateFileMentions("task-a","Plain @same.ts is ordinary user text");
    await access.validateFileMentions("task-a","Inline code `[example](dcode-file:not-a-link)` remains ordinary text");
    await access.validateFileMentions("task-a","```md\n[example](dcode-file:not-a-link)\n```");
    await assert.rejects(access.validateFileMentions("task-b",same.entries[0]!.markdown),/不属于当前任务/);
    await assert.rejects(access.validateFileMentions("task-a","[bad](dcode-file:invalid)"),/文件引用格式无效/);
    await assert.rejects(access.validateFileMentions("task-a",`[a/same.ts](${same.entries[0]!.reference} "title")`),/已改变/);
    await assert.rejects(access.validateFileMentions("task-a",`[a/same.ts][file]\n\n[file]: ${same.entries[0]!.reference}`),/格式已改变/);
    for(const disguised of ["- item\n    [bad](dcode-file:invalid)","[bad](dcode-file&#58;invalid)","[bad](dcode-file\\:invalid)"]){
      await assert.rejects(access.validateFileMentions("task-a",disguised),/文件引用/);
    }
    await assert.rejects(access.validateFileMentions("task-a",same.entries[0]!.markdown.replace("a/same.ts","b/same.ts")),/显示路径已改变/);
    const fields=same.entries[0]!.reference.slice("dcode-file:".length).split(".");
    const forgedFields=[...fields];forgedFields[6]=Buffer.from(".env","utf8").toString("hex");
    const forged=`[same](dcode-file:${forgedFields.join(".")})`;
    await assert.rejects(access.validateFileMentions("task-a",forged));
    const wrongFields=[...fields];wrongFields[5]="1";
    const wrongIdentity=`[a/same.ts](dcode-file:${wrongFields.join(".")})`;
    await assert.rejects(access.validateFileMentions("task-a",wrongIdentity),/目录已改变/);
    await rename(join(project,"a","same.ts"),join(project,"a","moved.ts"));
    await assert.rejects(access.validateFileMentions("task-a",same.entries[0]!.markdown),/已删除|移动/);
    await symlink(join(outside,"outside.ts"),join(project,"a","same.ts"));
    await assert.rejects(access.validateFileMentions("task-a",same.entries[0]!.markdown),/已删除|移动/);
    const other=join(root,"other");await mkdir(join(other,"b"),{recursive:true});await writeFile(join(other,"b","same.ts"),"other");
    snapshot.projects[0]!.directory=other;
    await assert.rejects(access.validateFileMentions("task-a",same.entries[1]!.markdown),/目录已改变/);
  }finally{await rm(root,{recursive:true,force:true});}
});

test("Host rejects stale selected file links before any Task prompt branch creates a run",async()=>{
  const root=await mkdtemp(join(tmpdir(),"dcode-file-prompt-")),agent=join(root,"agent"),project=join(root,"project");
  await mkdir(agent);await mkdir(project);await writeFile(join(agent,"settings.json"),"{}");await writeFile(join(project,"note.md"),"fixture");
  const host=new PiHost({agentDir:agent,sessionsDirectory:join(agent,"sessions"),dataRoot:join(root,".dcode"),userHome:root,emit:()=>{}});
  try{
    await host.start();let snapshot=await host.handle("foundation.snapshot",{}) as FoundationSnapshot;
    const p=await host.handle("project.create",{requestId:"project",expectedStoreRevision:snapshot.storeRevision,title:"Project",directory:project}) as {project:{id:string}};
    snapshot=await host.handle("foundation.snapshot",{}) as FoundationSnapshot;
    const t=await host.handle("task.create",{requestId:"task",expectedStoreRevision:snapshot.storeRevision,scope:{kind:"project",projectId:p.project.id},title:"Task",goal:"Check file"}) as {task:{id:string};coordinationSession:{id:string}};
    const result=await host.handle("workspace.fileSearch",{taskId:t.task.id,query:"note",limit:20}) as SearchResult;
    const link=result.entries[0]!.markdown;
    snapshot=await host.handle("foundation.snapshot",{}) as FoundationSnapshot;
    await host.handle("dcodeSession.composerDraft.set",{requestId:"file-mention-draft",expectedStoreRevision:snapshot.storeRevision,taskId:t.task.id,dcodeSessionId:t.coordinationSession.id,text:`Read ${link}`});
    await rm(join(project,"note.md"));
    for(const extra of [{},{targetAgentRunId:"fake-member"},{deliveryMode:"steer",expectedSessionRunId:"fake-run"}]){
      await assert.rejects(host.handle("dcodeSession.prompt",{dcodeSessionId:t.coordinationSession.id,promptId:randomUUID(),message:`Read ${link}`,...extra}),/已删除|移动/);
    }
    const runtimeHost=host as unknown as {requireWritable:()=>unknown};
    const originalWritable=runtimeHost.requireWritable.bind(host);
    runtimeHost.requireWritable=()=>({runtimeIdentity:{taskId:t.task.id},seenPromptIds:new Map(),seenSteerIds:new Map()});
    try{
      await assert.rejects(host.handle("session.prompt",{runtimeId:"direct-file-reference",promptId:randomUUID(),message:`Read ${link}`}),/已删除|移动/);
      await assert.rejects(host.handle("session.steer",{runtimeId:"direct-file-reference",steerId:randomUUID(),expectedRunId:"fixture-run",message:`Read ${link}`}),/已删除|移动/);
    }finally{runtimeHost.requireWritable=originalWritable;}
    const store=(host as unknown as {productStore:ProductStore}).productStore;
    const ensured=await store.ensureCoordinatorAgentRun({requestId:"coordinator-for-stale-ref",taskId:t.task.id,scope:{kind:"project",projectId:p.project.id}});
    const queued=await store.queueCollaborationMessage({requestId:"stale-ref-queued",taskId:t.task.id,sourceSessionId:t.coordinationSession.id,targetAgentRunId:ensured.agentRun.id,author:"user",text:`Read ${link}`});
    const db=store as unknown as {database:{prepare:(sql:string)=>{get:(id:string)=>{submitted_text:string}|undefined}}};
    assert.equal(db.database.prepare("SELECT submitted_text FROM raw_inputs WHERE id=?").get(queued.message.originRawInputId)?.submitted_text,`Read ${link}`);
    const paused=await store.transitionCollaborationMessage({requestId:"stale-ref-paused",id:queued.message.id,expectedRevision:queued.message.revision,state:"paused"});
    await assert.rejects(host.handle("collaboration.messageEdit",{requestId:"invalid-ref-edit",id:paused.message.id,expectedRevision:paused.message.revision,text:"[bad](dcode-file:invalid)"}),/文件引用格式无效/);
    assert.equal(store.collaborationMessages().find(item=>item.id===paused.message.id)?.text,`Read ${link}`);
    await host.handle("collaboration.messageControl",{requestId:"resume-stale-ref",id:paused.message.id,expectedRevision:paused.message.revision,state:"queued"});
    const until=Date.now()+10_000;
    while(store.collaborationMessages().find(item=>item.id===paused.message.id)?.state!=="paused"){
      if(Date.now()>until)throw new Error("stale queue was not paused");
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    snapshot=await host.handle("foundation.snapshot",{}) as FoundationSnapshot;
    assert.equal(snapshot.sessionRuns.length,0);
    assert.equal(snapshot.composerDrafts.find(draft=>draft.sessionId===t.coordinationSession.id)?.text,`Read ${link}`);
    assert.doesNotThrow(()=>validateMethodParams("workspace.fileSearch",{taskId:t.task.id,query:"note",limit:20}));
    assert.throws(()=>validateMethodParams("workspace.fileSearch",{taskId:t.task.id,query:"x".repeat(129)}));
  }finally{await host.close();await rm(root,{recursive:true,force:true});}
});
