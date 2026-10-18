import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import type { ImageContent } from '@earendil-works/pi-ai';
import { validateGeneratedImages } from '../../src/adapters/pi/image-validation.ts';
const assets = JSON.parse(await readFile(new URL('./image-decoder-assets.json', import.meta.url), 'utf8')) as Record<string, ImageContent>;

for (const name of ['pattern.png','pattern.jpeg','pattern.webp','pattern.gif','pattern.bmp','animated.png','animated.webp','animated.gif'])
  await test(`图片核验真实公开解码 ${name}：不变换原图且等真实线程退出`, async () => {
    const image=assets[name],before=JSON.stringify(image);
    await validateGeneratedImages([image],new AbortController().signal);
    assert.equal(JSON.stringify(image),before);
  });
for (const name of ['bad-full-idat.png','pixel-bomb.png']) await test(`图片核验拒绝 ${name}：完整容器坏正文或像素超容量`,async()=>{
  await assert.rejects(validateGeneratedImages([assets[name]],new AbortController().signal));
});
await test('图片核验拒绝MIME不符／规范base64外的同字节表示／图数与批次像素容量',async()=>{
  const png=assets['pattern.png'];
  await assert.rejects(validateGeneratedImages([{...png,mimeType:'image/jpeg'}],new AbortController().signal));
  await assert.rejects(validateGeneratedImages([{...png,data:png.data+'\n'}],new AbortController().signal));
  await assert.rejects(validateGeneratedImages([png,png,png,png,png],new AbortController().signal));
  await assert.rejects(validateGeneratedImages([assets['batch-large.png'],assets['batch-large.png'],assets['batch-large.png']],new AbortController().signal));
});
for(const phase of ['online','message'] as const) await test(`图片核验真实${phase}交错：较新取消优先，实际exit后Promise才结束`,async()=>{
  const signal=new AbortController(),emit=Worker.prototype.emit;let currentThreadId:(()=>number)|undefined,exitObserved=false,actualSuccess=false;
  Worker.prototype.emit=function(event:string,...args:unknown[]){
    if(event===phase&&!currentThreadId&&(phase==='online'||(args[0] as {ok?:boolean})?.ok===true)){
      currentThreadId=()=>this.threadId;actualSuccess=phase==='message';this.once('exit',()=>{exitObserved=true;});Worker.prototype.emit=emit;signal.abort();
    }
    return emit.call(this,event,...args);
  };
  try{
    await assert.rejects(validateGeneratedImages([assets['pattern.png']],signal.signal),{name:'AbortError'});
    assert.ok(currentThreadId);assert.equal(exitObserved,true);assert.equal(currentThreadId(),-1);assert.equal(actualSuccess,phase==='message');
  }finally{Worker.prototype.emit=emit;}
});
