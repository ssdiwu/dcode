import test from "node:test";
import assert from "node:assert/strict";
import {duplexPair} from "node:stream";
import {once} from "node:events";
import {serveApiKeyChannel} from "../src/api-key-channel.js";
import {validApiKeySubmission,MAX_API_KEY_LENGTH,safeApiKeyConnectionResult} from "../src/api-key-connection.js";
import {isHostMethod,validateMethodParams} from "../src/protocol.js";
const secret="private-inline-api-fixture";
const payload=(id="one")=>({id,providerId:"zai-coding-cn",apiKey:secret});
test("private API channel accepts split frames and only returns a safe receipt",async()=>{
  const [parent,child]=duplexPair();let received="";
  const close=serveApiKeyChannel(child,async(provider,key)=>{assert.equal(provider,"zai-coding-cn");received=key;return {ok:true,apiKey:secret} as {ok:true};});
  try{const reply=once(parent,"data");const bytes=JSON.stringify(payload())+"\n";parent.write(bytes.slice(0,13));parent.write(bytes.slice(13));const [data]=await reply;assert.equal(received,secret);assert.deepEqual(JSON.parse(data.toString()),{id:"one",result:{ok:true}});assert.ok(!data.toString().includes(secret));}finally{close();parent.destroy();}
});
test("synchronous exceptions and duplicate in-flight submissions cannot leak input or launch twice",async()=>{
  const [parent,child]=duplexPair();let finish:()=>void=()=>{},calls=0;
  const close=serveApiKeyChannel(child,async()=>{calls++;await new Promise<void>(r=>{finish=r;});throw Error(secret);});
  const replies:unknown[]=[];parent.on("data",data=>replies.push(...data.toString().trim().split("\n").map((line:string)=>JSON.parse(line))));
  try{parent.write(JSON.stringify(payload())+"\n");await new Promise(r=>setImmediate(r));parent.write(JSON.stringify(payload("two"))+"\n");await new Promise(r=>setImmediate(r));assert.equal(calls,1);finish();await new Promise(r=>setImmediate(r));assert.deepEqual(replies,[{id:"two",result:{ok:false,code:"BUSY"}},{id:"one",result:{ok:false,code:"FAILED"}}]);assert.ok(!JSON.stringify(replies).includes(secret));}finally{close();parent.destroy();}
  const [p,c]=duplexPair();const end=serveApiKeyChannel(c,()=>{throw Error(secret);});try{const read=once(p,"data");p.write(JSON.stringify(payload())+"\n");const [data]=await read;assert.deepEqual(JSON.parse(data.toString()).result,{ok:false,code:"FAILED"});}finally{end();p.destroy();}
});
test("invalid input, oversized frames and EOF close the private channel without starting work",async()=>{
  for(const bytes of ['{not JSON}\n',JSON.stringify({...payload(),extra:secret})+'\n','x'.repeat(131073)]){
    const [parent,child]=duplexPair();let calls=0;const close=serveApiKeyChannel(child,async()=>{calls++;return {ok:true};});const ended=once(child,"close");parent.write(bytes);await ended;assert.equal(calls,0);close();parent.destroy();
  }
  const [p,c]=duplexPair();let calls=0;serveApiKeyChannel(c,async()=>{calls++;return {ok:true};});const ended=once(c,"close");p.end('{"apiKey":"partial');await ended;assert.equal(calls,0);p.destroy();
});
test("bounded private input is not a new public credential method",()=>{
  assert.ok(validApiKeySubmission(payload()));
  for(const apiKey of [""," ","x".repeat(MAX_API_KEY_LENGTH+1),null,42])assert.equal(validApiKeySubmission({...payload(),apiKey}),false);
  assert.equal(isHostMethod("dcodeAuth.connectApiKey"),false);
  assert.throws(()=>validateMethodParams("dcodeAuth.start",{providerId:"zai-coding-cn",flowId:"one",authType:"api_key",apiKey:secret}),/does not accept credential/);
});

test("private receipt codes must be scalar whitelist strings",()=>{
  for(const code of [["SYNC_REQUIRED"],{toString:()=>"FAILED"},null,0,true])assert.deepEqual(safeApiKeyConnectionResult({ok:false,code}),{ok:false,code:"OUTCOME_UNKNOWN"});
});
