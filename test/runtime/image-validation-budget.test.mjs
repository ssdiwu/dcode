// 资源故障模型：只将固定解码Worker替为真实不回消息线程，核实际10秒预算与exit join；不证明图片解码。
import test from 'node:test';
import assert from 'node:assert/strict';
import workerThreads from 'node:worker_threads';
import {syncBuiltinESMExports} from 'node:module';
import {validateGeneratedImages} from '../../src/adapters/pi/image-validation.ts';
import {makeImageFixtureAssets} from '../e2e/ordinary-image-fixture.mjs';

test('图片资源故障模型：10秒预算仅发终止，真实不响应线程exit后才有限拒绝',{timeout:20000},async()=>{
 const Native=workerThreads.Worker;let onlineResolve,active=0,exitCode,settled=false;
 const online=new Promise(resolve=>{onlineResolve=resolve;});
 workerThreads.Worker=class UnresponsiveOwnedWorker extends Native{
  constructor(source,options){
   assert.match(source,/resizeImage/);assert.equal(options.eval,true);
   super("require('node:worker_threads').parentPort.on('message',()=>{});",options);
   active++;this.once('online',()=>onlineResolve());this.once('exit',code=>{exitCode=code;active--;});
  }
 };
 syncBuiltinESMExports();const started=performance.now();
 try{
  const pending=validateGeneratedImages([makeImageFixtureAssets('owned-budget-fault').outputImage],new AbortController().signal);
  pending.then(()=>{settled=true;},()=>{settled=true;});
  await online;assert.equal(active,1);assert.equal(settled,false);
  await assert.rejects(pending,/Image validation budget exceeded/);
  assert.ok(performance.now()-started>=10000);assert.equal(active,0);assert.equal(exitCode,1);assert.equal(settled,true);
 }finally{workerThreads.Worker=Native;syncBuiltinESMExports();}
});
