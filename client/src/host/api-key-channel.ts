import {randomUUID} from "node:crypto";
import type {Duplex} from "node:stream";
import type {ApiKeyConnectionResult} from "../../../host/src/api-key-connection-types.js";
const MAX_API_KEY_FRAME_BYTES=131_072;
function safeApiKeyConnectionResult(value:unknown):ApiKeyConnectionResult {
  if(value&&typeof value==="object"){
    const v=value as Record<string,unknown>;
    if(v.ok===true)return {ok:true};
    if(v.ok===false&&typeof v.code==="string"&&["INVALID_INPUT","BUSY","UNAVAILABLE","FAILED","SYNC_REQUIRED","OUTCOME_UNKNOWN"].includes(v.code))return {ok:false,code:v.code as Extract<ApiKeyConnectionResult,{ok:false}>["code"]};
  }
  return {ok:false,code:"OUTCOME_UNKNOWN"};
}

/** Only stores response resolvers; submitted values never enter diagnostics. */
export class ApiKeyChannel {
  private buffer="";
  private closed=false;
  private pending=new Map<string,{resolve:(result:ApiKeyConnectionResult)=>void;timer:ReturnType<typeof setTimeout>}>();
  constructor(private readonly stream:Duplex){
    stream.setEncoding("utf8");
    stream.on("error",()=>this.close());stream.on("close",()=>this.close());
    stream.on("data",(chunk:string)=>{
      this.buffer+=chunk;
      if(Buffer.byteLength(this.buffer)>MAX_API_KEY_FRAME_BYTES){this.close();return;}
      let end:number;
      while((end=this.buffer.indexOf("\n"))>=0){
        const line=this.buffer.slice(0,end);this.buffer=this.buffer.slice(end+1);
        try{const value=JSON.parse(line) as {id?:unknown;result?:unknown};if(typeof value.id!=="string"){this.close();return;}const entry=this.pending.get(value.id);if(entry){clearTimeout(entry.timer);this.pending.delete(value.id);entry.resolve(safeApiKeyConnectionResult(value.result));}}
        catch{this.close();return;}
      }
    });
  }
  submit(providerId:string,apiKey:string):Promise<ApiKeyConnectionResult>{
    const value={id:randomUUID(),providerId,apiKey};
    if(typeof providerId!=="string"||!/^[a-z0-9][a-z0-9._-]{0,199}$/i.test(providerId)||typeof apiKey!=="string"||!apiKey.trim()||apiKey.length>16_384)return Promise.resolve({ok:false,code:"INVALID_INPUT"});
    if(this.closed)return Promise.resolve({ok:false,code:"UNAVAILABLE"});
    if(this.pending.size)return Promise.resolve({ok:false,code:"BUSY"});
    return new Promise(resolve=>{
      const timer=setTimeout(()=>{this.pending.delete(value.id);resolve({ok:false,code:"OUTCOME_UNKNOWN"});},10*60_000+5000);
      this.pending.set(value.id,{resolve,timer});
      try{this.stream.write(JSON.stringify(value)+"\n");}catch{this.close();}finally{value.apiKey="";}
    });
  }
  close(){
    if(this.closed)return;this.closed=true;this.buffer="";
    for(const entry of this.pending.values()){clearTimeout(entry.timer);entry.resolve({ok:false,code:"OUTCOME_UNKNOWN"});}
    this.pending.clear();this.stream.destroy();
  }
}
