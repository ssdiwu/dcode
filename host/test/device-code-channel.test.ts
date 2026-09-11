import test from 'node:test';
import assert from 'node:assert/strict';
import {duplexPair} from 'node:stream';
import {once} from 'node:events';
import {serveDeviceCodeChannel} from '../src/device-code-channel.js';

test('private device channel only projects the transient code and expiry',async()=>{
  const [server,client]=duplexPair();
  const close=serveDeviceCodeChannel(server,async flowId=>flowId==='active'?{userCode:'TEST-1234',expiresAt:Date.now()+5000,token:'must-not-project'}:null);
  try{
    const response=once(client,'data');client.write('{"id":"request","flowId":"active"}\n');
    const result=JSON.parse(String((await response)[0]));assert.equal(result.display.userCode,'TEST-1234');assert.deepEqual(Object.keys(result.display),['userCode','expiresAt']);
    const expired=once(client,'data');client.write('{"id":"old","flowId":"inactive"}\n');assert.deepEqual(JSON.parse(String((await expired)[0])),{id:'old',display:null});
  }finally{close();client.destroy();}
});
test('private display channel rejects generic requests, extra fields and oversized input before lookup',async()=>{
  for(const input of ['{"id":"x","flowId":"flow","method":"credential.read"}\n','{"id":"x","flowId":"bad/path"}\n','null\n','x'.repeat(4097)]){
    const [server,client]=duplexPair();let calls=0;
    const closed=once(server,'close');serveDeviceCodeChannel(server,async()=>{calls++;return null;});client.write(input);await closed;assert.equal(calls,0);client.destroy();
  }
});
test('private display failures expose no raw error and disconnect drops a delayed value',async()=>{
  const [server,client]=duplexPair();const close=serveDeviceCodeChannel(server,async()=>{throw Error('private-code-error');});
  try{const response=once(client,'data');client.write('{"id":"failed","flowId":"live"}\n');assert.deepEqual(JSON.parse(String((await response)[0])),{id:'failed',display:null});}finally{close();client.destroy();}
  const [a,b]=duplexPair();let finish:(value:{userCode:string;expiresAt:number})=>void=()=>{};
  const stop=serveDeviceCodeChannel(a,()=>new Promise(resolve=>{finish=resolve;}));let output='';b.on('data',value=>{output+=String(value);});b.write('{"id":"late","flowId":"live"}\n');await new Promise(r=>setImmediate(r));stop();finish({userCode:'late-private',expiresAt:Date.now()+5000});await new Promise(r=>setImmediate(r));assert.equal(output,'');b.destroy();
});
