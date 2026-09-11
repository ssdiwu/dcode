import {Socket} from 'node:net';
import type {Duplex} from 'node:stream';
import type {DeviceCodeDisplay} from './device-code-types.js';

/** One purpose: read the current OpenAI Codex device code. No generic RPC. */
export function serveDeviceCodeChannel(stream:Duplex,read:(flowId:string)=>Promise<DeviceCodeDisplay|null>):()=>void {
  let buffer='',closed=false,active=false;
  const close=()=>{closed=true;buffer='';stream.destroy();};
  stream.setEncoding('utf8');
  stream.on('error',close);stream.on('end',close);stream.on('close',()=>{closed=true;buffer='';});
  stream.on('data',(chunk:string)=>{
    buffer+=chunk;
    if(Buffer.byteLength(buffer)>4096){close();return;}
    let end:number;
    while(!closed&&(end=buffer.indexOf('\n'))>=0){
      let line=buffer.slice(0,end);buffer=buffer.slice(end+1);
      try{
        const input=JSON.parse(line) as Record<string,unknown>;
        if(!input||Object.keys(input).length!==2||typeof input.id!=='string'||!/^[a-z0-9-]{1,128}$/i.test(input.id)
          ||typeof input.flowId!=='string'||!/^[a-z0-9-]{1,128}$/i.test(input.flowId)){close();return;}
        if(active){stream.write(JSON.stringify({id:input.id,display:null})+'\n');continue;}
        active=true;
        const id=input.id,flowId=input.flowId;
        void Promise.resolve().then(()=>read(flowId)).then(value=>{
          if(!closed)stream.write(JSON.stringify({id,display:value?{userCode:value.userCode,expiresAt:value.expiresAt}:null})+'\n');
        },()=>{if(!closed)stream.write(JSON.stringify({id,display:null})+'\n');}).catch(close).finally(()=>{active=false;});
      }catch{close();}finally{line='';}
    }
  });
  return close;
}
export function inheritedDeviceCodeChannel(read:(flowId:string)=>Promise<DeviceCodeDisplay|null>):()=>void {
  const enabled=process.env.DCODE_DEVICE_CODE_PIPE_FD==='4';
  delete process.env.DCODE_DEVICE_CODE_PIPE_FD;
  if(!enabled)return()=>{};
  try{return serveDeviceCodeChannel(new Socket({fd:4,readable:true,writable:true}),read);}catch{return()=>{};}
}
