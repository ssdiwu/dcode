import { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { MAX_API_KEY_FRAME_BYTES, safeApiKeyConnectionResult, validApiKeySubmission, type ApiKeyConnectionResult } from "./api-key-connection.js";

/** The inherited private fd is never fed into the public JSONL decoder/logger. */
export function serveApiKeyChannel(stream:Duplex,connect:(providerId:string,key:string,id:string)=>Promise<ApiKeyConnectionResult>):()=>void {
  let buffer="",active=false,closed=false;
  stream.setEncoding("utf8");
  const close=()=>{closed=true;buffer="";stream.destroy();};
  const reply=(id:string,result:ApiKeyConnectionResult)=>{if(!closed){try{stream.write(JSON.stringify({id,result:safeApiKeyConnectionResult(result)})+"\n");}catch{close();}}};
  stream.on("error",close);stream.on("end",close);stream.on("close",()=>{closed=true;buffer="";});
  stream.on("data",(chunk:string)=>{
    buffer+=chunk;
    if(Buffer.byteLength(buffer)>MAX_API_KEY_FRAME_BYTES){close();return;}
    let end:number;
    while(!closed&&(end=buffer.indexOf("\n"))>=0){
      let line=buffer.slice(0,end);buffer=buffer.slice(end+1);
      let value:unknown;try{value=JSON.parse(line);}catch{close();return;}finally{line="";}
      if(!validApiKeySubmission(value)){close();return;}
      const {id,providerId}=value;
      if(active){value.apiKey="";reply(id,{ok:false,code:"BUSY"});continue;}
      active=true;
      let key=value.apiKey;value.apiKey="";
      void Promise.resolve().then(()=>connect(providerId,key,id)).then(result=>reply(id,result),()=>reply(id,{ok:false,code:"FAILED"})).finally(()=>{key="";active=false;}).catch(()=>close());
    }
  });
  return close;
}
export function inheritedApiKeyChannel(connect:(providerId:string,key:string,id:string)=>Promise<ApiKeyConnectionResult>):()=>void {
  if(process.env.DCODE_CREDENTIAL_PIPE_FD!=="3")return ()=>{};
  delete process.env.DCODE_CREDENTIAL_PIPE_FD;
  try{return serveApiKeyChannel(new Socket({fd:3,readable:true,writable:true}),connect);}catch{return ()=>{};}
}
