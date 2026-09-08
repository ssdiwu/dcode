import test from "node:test";
import assert from "node:assert/strict";
import {duplexPair} from "node:stream";
import {ApiKeyChannel} from "../src/host/api-key-channel.js";
const secret="private-inline-shell-fixture";
test("shell private channel projects the receipt and rejects concurrent work without using public requests",async()=>{
  const [parent,child]=duplexPair();const channel=new ApiKeyChannel(parent);let input:any;
  child.once("data",data=>{input=JSON.parse(data.toString());});
  try{const result=channel.submit("zai-coding-cn",secret);await new Promise(r=>setImmediate(r));assert.equal(input.apiKey,secret);assert.deepEqual(await channel.submit("openai",secret),{ok:false,code:"BUSY"});child.write(JSON.stringify({id:input.id,result:{ok:true,apiKey:secret}})+"\n");assert.deepEqual(await result,{ok:true});}finally{channel.close();child.destroy();}
});
test("closed or malformed private channels resolve uncertainty and never replay into a replacement",async()=>{
  for(const malformed of [false,true]){
    const [parent,child]=duplexPair(),channel=new ApiKeyChannel(parent);const result=channel.submit("zai-coding-cn",secret);if(malformed)child.write('bad response '+secret+'\n');else channel.close();assert.deepEqual(await result,{ok:false,code:"OUTCOME_UNKNOWN"});channel.close();child.destroy();
    const [a,b]=duplexPair();const replacement=new ApiKeyChannel(a);let sent=false;b.on("data",()=>{sent=true;});await new Promise(r=>setImmediate(r));assert.equal(sent,false);replacement.close();b.destroy();
  }
});

test("shell rejects array/object receipt codes instead of treating them as a confirmed save",async()=>{
  for(const code of [["SYNC_REQUIRED"],{},null,0]){
    const [parent,child]=duplexPair(),channel=new ApiKeyChannel(parent);
    child.once("data",data=>child.write(JSON.stringify({id:JSON.parse(data.toString()).id,result:{ok:false,code}})+"\n"));
    try{assert.deepEqual(await channel.submit("zai-coding-cn",secret),{ok:false,code:"OUTCOME_UNKNOWN"});}finally{channel.close();child.destroy();}
  }
});
