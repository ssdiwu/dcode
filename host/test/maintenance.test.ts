import assert from "node:assert/strict";
import {mkdtemp,mkdir,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {MaintenanceController} from "../src/maintenance.js";
import type {ProductStore} from "../src/product-store.js";

async function sourceFixture() {
  const root=await mkdtemp(join(tmpdir(),"dcode-maintenance-start-"));
  await mkdir(join(root,"client"));
  await mkdir(join(root,"host"));
  await writeFile(join(root,"client","package.json"),JSON.stringify({name:"@dcode/client"}));
  await writeFile(join(root,"host","package.json"),JSON.stringify({name:"@pi-dcode/host"}));
  return root;
}

test("concurrent maintenance starts reserve the slot before asynchronous validation and publication",async()=>{
  const root=await sourceFixture();
  let publishReached!:()=>void;
  const reached=new Promise<void>(resolve=>{publishReached=resolve;});
  let releasePublish!:()=>void;
  const gate=new Promise<void>((_resolve,reject)=>{releasePublish=()=>reject(new Error("fixture publication stopped"));});
  const store={recordMaintenance:async()=>{publishReached();await gate;}} as unknown as ProductStore;
  const controller=new MaintenanceController(store,()=>undefined);
  const first=controller.start(root,"verify");
  let second:Promise<unknown>|undefined;
  try {
    await reached;
    second=controller.start(root,"verify");
    await assert.rejects(Promise.race([
      second,
      new Promise<never>((_resolve,reject)=>setTimeout(()=>reject(new Error("second start stayed pending")),250)),
    ]),/已有检查或构建仍未结束/);
  } finally {
    releasePublish();
    await Promise.allSettled([first,...(second?[second]:[])]);
    await rm(root,{recursive:true,force:true});
  }
});

test("closing during maintenance startup prevents a late child process",async()=>{
  const root=await sourceFixture();
  let publishReached!:()=>void;
  const reached=new Promise<void>(resolve=>{publishReached=resolve;});
  let releasePublish!:()=>void;
  const gate=new Promise<void>(resolve=>{releasePublish=resolve;});
  const states:unknown[]=[];
  const store={recordMaintenance:async(state:unknown)=>{states.push(state);publishReached();await gate;},maintenanceState:()=>undefined} as unknown as ProductStore;
  const controller=new MaintenanceController(store,()=>undefined);
  const starting=controller.start(root,"verify");
  try {
    await reached;
    const closing=controller.close();
    releasePublish();
    await closing;
    const result=await starting;
    assert.equal(result.status,"failed");
    assert.equal((await controller.status()).status,"failed");
    assert.ok(states.length>=2,"running publication must be followed by stopped publication");
  } finally {
    releasePublish();
    await Promise.allSettled([starting]);
    await rm(root,{recursive:true,force:true});
  }
});
