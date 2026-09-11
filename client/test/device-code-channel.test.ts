import test from 'node:test';
import assert from 'node:assert/strict';
import {duplexPair} from 'node:stream';
import {DeviceCodeChannel} from '../src/host/device-code-channel.js';

test('shell projects only an active device code, never arbitrary private response fields',async()=>{
  const [shell,host]=duplexPair(),channel=new DeviceCodeChannel(shell),expiresAt=Date.now()+5000;
  host.once('data',data=>host.write(JSON.stringify({id:JSON.parse(String(data)).id,display:{userCode:'TEST-1234',expiresAt,token:'private-token'}})+'\n'));
  try{assert.deepEqual(await channel.read('flow'),{userCode:'TEST-1234',expiresAt});}finally{channel.close();host.destroy();}
});
test('invalid, expired or closed display responses do not survive or replay',async()=>{
  for(const display of [null,{userCode:'old-code',expiresAt:0},{userCode:'x'.repeat(129),expiresAt:Date.now()+5000},{userCode:'bad\ncode',expiresAt:Date.now()+5000}]){
    const [a,b]=duplexPair(),channel=new DeviceCodeChannel(a);b.once('data',data=>b.write(JSON.stringify({id:JSON.parse(String(data)).id,display})+'\n'));
    try{assert.equal(await channel.read('flow'),null);}finally{channel.close();b.destroy();}
  }
  const [a,b]=duplexPair(),channel=new DeviceCodeChannel(a);const pending=channel.read('active');assert.equal(await channel.read('duplicate'),null);channel.close();assert.equal(await pending,null);assert.equal(await channel.read('active'),null);b.destroy();
});
test('malformed or oversized private replies safely clear pending display',async()=>{
  for(const response of ['not-json\n','x'.repeat(4097)]){
    const [a,b]=duplexPair(),channel=new DeviceCodeChannel(a);const pending=channel.read('flow');b.write(response);assert.equal(await pending,null);channel.close();b.destroy();
  }
});
