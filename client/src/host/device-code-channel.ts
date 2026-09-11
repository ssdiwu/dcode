import {randomUUID} from 'node:crypto';
import type {Duplex} from 'node:stream';
import type {DeviceCodeDisplay} from '../../../host/src/device-code-types.js';

/** Private, bounded display response; never enters the generic protocol trace. */
export class DeviceCodeChannel {
  private buffer='';
  private closed=false;
  private pending?:{id:string;resolve:(value:DeviceCodeDisplay|null)=>void;timer:ReturnType<typeof setTimeout>};
  constructor(private readonly stream:Duplex){
    stream.setEncoding('utf8');
    stream.on('error',()=>this.close());stream.on('end',()=>this.close());stream.on('close',()=>this.close());
    stream.on('data',(chunk:string)=>{
      this.buffer+=chunk;
      if(Buffer.byteLength(this.buffer)>4096){this.close();return;}
      let end:number;
      while((end=this.buffer.indexOf('\n'))>=0){
        let line=this.buffer.slice(0,end);this.buffer=this.buffer.slice(end+1);
        try{
          const result=JSON.parse(line);
          if(typeof result?.id!=='string'){this.close();return;}
          const entry=this.pending;
          if(!entry||entry.id!==result.id)continue;
          clearTimeout(entry.timer);this.pending=undefined;
          const value=result.display;
          entry.resolve(value&&typeof value.userCode==='string'&&value.userCode.length>0&&value.userCode.length<=128
            &&!/[\x00-\x1f\x7f]/.test(value.userCode)&&typeof value.expiresAt==='number'&&Number.isFinite(value.expiresAt)
            &&value.expiresAt>Date.now()?{userCode:value.userCode,expiresAt:value.expiresAt}:null);
        }catch{this.close();}finally{line='';}
      }
    });
  }
  read(flowId:string):Promise<DeviceCodeDisplay|null>{
    if(this.closed||this.pending||typeof flowId!=='string'||!/^[a-z0-9-]{1,128}$/i.test(flowId))return Promise.resolve(null);
    const id=randomUUID();
    return new Promise(resolve=>{
      const timer=setTimeout(()=>{this.pending=undefined;resolve(null);},2000);
      this.pending={id,resolve,timer};
      try{this.stream.write(JSON.stringify({id,flowId})+'\n');}catch{this.close();}
    });
  }
  close(){
    if(this.closed)return;this.closed=true;this.buffer='';
    if(this.pending){clearTimeout(this.pending.timer);this.pending.resolve(null);this.pending=undefined;}
    this.stream.destroy();
  }
}
