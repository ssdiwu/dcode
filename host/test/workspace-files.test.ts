import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile,readFile,symlink,rename,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {WorkspaceFiles} from "../src/workspace-files.js";

test("native file access preserves editor snapshots, rejects conflicts and symlink escapes, and supports local preview resources",async()=>{
  const root=await mkdtemp(join(tmpdir(),"dcode-files-"));const project=join(root,"project"),outside=join(root,"outside");await mkdir(project);await mkdir(outside);
  const files=new WorkspaceFiles();
  try {
    await writeFile(join(project,"note.md"),"原文\n第二行");await writeFile(join(project,"code.ts"),"export const value=1;");await writeFile(join(project,"demo.HTML"),"<h1>动态预览</h1><script>document.body.dataset.ready='yes'</script>");
    await writeFile(join(project,"app.css"),"h1 { color: red }");await writeFile(join(outside,"other.md"),"必须保留");await symlink(outside,join(project,"link"));
    const tree=await files.tree(project);assert.ok(tree.entries.some(entry=>entry.name==="link"&&entry.kind==="link"));assert.equal(tree.truncated,false);
    const original=await files.read(project,"note.md");assert.equal(original.text,"原文\n第二行");assert.match(original.digest,/^sha256:[a-f0-9]{64}$/u);assert.equal(original.editable,true);
    await writeFile(join(project,"note.md"),"外部修改");
    await assert.rejects(files.save(project,"note.md","新编辑",original.digest),error=>(error as {code:string}).code==="FILE_CONFLICT");assert.equal(await readFile(join(project,"note.md"),"utf8"),"外部修改");
    const saved=await files.save(project,"note.md","确认覆盖",original.digest,true);assert.equal(saved.text,"确认覆盖");assert.equal(await readFile(join(project,"note.md"),"utf8"),"确认覆盖");
    assert.equal((await files.read(project,"demo.HTML")).kind,"html");assert.equal((await files.asset(project,"app.css")).mimeType,"text/css");
    await assert.rejects(files.save(project,"code.ts","replace",original.digest),/只支持/);
    for(const path of ["../outside/other.md","link/other.md"]){await assert.rejects(files.read(project,path));await assert.rejects(files.save(project,path,"不得写入",original.digest,true));}
    assert.equal(await readFile(join(outside,"other.md"),"utf8"),"必须保留");
    await writeFile(join(project,".env"),"placeholder");await assert.rejects(files.read(project,".env"),/不能/);
    await rename(project,join(root,"original-project"));await symlink(outside,project);
    await assert.rejects(files.read(project,"other.md"),/链接|打开/);
    await assert.rejects(files.save(project,"other.md","不得跟随新根",original.digest,true));assert.equal(await readFile(join(outside,"other.md"),"utf8"),"必须保留");
  }finally{await rm(root,{recursive:true,force:true});}
});

 test("macOS case aliases cannot enter sensitive paths through files, assets or trees",async()=>{
  const files=new WorkspaceFiles("/usr/bin/false");
  for(const path of [".ENV",".Env.local",".GIT/config","AUTH.JSON","nested/Credentials.JSON",".sSh/config"]){
    for(const operation of [()=>files.read("/tmp",path),()=>files.asset("/tmp",path),()=>files.tree("/tmp",path)])await assert.rejects(operation(),error=>(error as {code:string}).code==="FILE_SCOPE");
  }
});
