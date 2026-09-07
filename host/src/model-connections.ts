import { rememberAuthInput } from "./credential-material.js";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AuthType, Credential, CredentialStore } from "@earendil-works/pi-ai";
import { DCodeCredentialStore, authCancelled, type ConfidentialInteraction } from "./secure-model-credentials.js";

export type ConnectionState = "disconnected" | "configured" | "connected" | "reconnect_required" | "awaiting_input" | "awaiting_browser" | "saving" | "failed" | "cancelled" | "sync_required" | "timed_out" | "refresh_pending";
export interface ProviderConnection {
  providerId:string;
  methods:{type:AuthType;label:string}[];
  state:ConnectionState;
  managed:boolean;
  external:boolean;
  flowId?:string;
}
interface Flow {id:string;provider:string;type:AuthType;controller:AbortController;state:ConnectionState;done:Promise<void>;settled:boolean;timedOut:boolean;timer?:ReturnType<typeof setTimeout>}
const activeStates=new Set<ConnectionState>(["awaiting_input","awaiting_browser","saving"]);
export class ModelConnections {
  private flows=new Map<string,Flow>();
  private seen=new Set<string>();
  private mutationPending=false;
  constructor(private readonly credentials:DCodeCredentialStore,private readonly native:ConfidentialInteraction,private readonly runtime:()=>Promise<ModelRuntime>,private readonly changed:()=>Promise<void>,private readonly emit:(event:string,data:unknown)=>void,private readonly options:{timeoutMs?:number}={}){}
  private emitState(flow:Flow,state:ConnectionState){flow.state=state;this.emit("dcodeAuth.changed",{providerId:flow.provider,flowId:flow.id,state});}
  async get():Promise<{providers:ProviderConnection[]}>{
    const runtime=await this.runtime();
    const managed=new Map((await this.credentials.managed()).map(item=>[item.providerId,item]));
    return {providers:await Promise.all(runtime.getProviders().map(async provider=>{
      const methods:ProviderConnection["methods"]=[];
      if(provider.auth.apiKey?.login)methods.push({type:"api_key",label:"连接 API 密钥"});
      if(provider.auth.oauth?.login)methods.push({type:"oauth",label:provider.id==="openai-codex"?"登录 ChatGPT":"浏览器登录"});
      const flow=this.flows.get(provider.id);
      const configured=runtime.hasConfiguredAuth(provider.id);
      const owned=managed.has(provider.id);
      let external=!owned&&configured;
      let state:ConnectionState=configured?"configured":"disconnected";
      try{
        const metadata=await this.credentials.connectionMetadata(provider.id);
        external=!owned&&(configured||!!metadata.type);
        if(metadata.type){
          state=metadata.type==="oauth"?(metadata.expires!>Date.now()+5*60_000?"connected":owned?"refresh_pending":"reconnect_required"):"configured";
        }
        if(metadata.verified&&state!=="refresh_pending")state="connected";
        if(metadata.failed)state="reconnect_required";
      }catch{state="reconnect_required";}
      if(flow&&[...activeStates,"failed","cancelled","sync_required","timed_out"].includes(flow.state))state=flow.state;
      return {providerId:provider.id,methods,state,managed:owned,external,...(flow?{flowId:flow.id}:{})};
    }))};
  }
  async start(provider:string,type:AuthType,id:string):Promise<{flowId:string;accepted:boolean}>{
    if(this.seen.has(id))return {flowId:id,accepted:false};
    if(this.mutationPending||[...this.flows.values()].some(flow=>!flow.settled))throw new Error("请先完成或取消当前连接。");
    // Reserve before any await so simultaneous callers cannot both open a prompt.
    this.seen.add(id);if(this.seen.size>256)this.seen.delete(this.seen.values().next().value!);
    const flow:Flow={id,provider,type,controller:new AbortController(),state:"awaiting_input",done:Promise.resolve(),settled:false,timedOut:false};
    flow.timer=setTimeout(()=>{flow.timedOut=true;flow.controller.abort();},this.options.timeoutMs??10*60_000);
    this.flows.set(provider,flow);
    this.emitState(flow,"awaiting_input");
    flow.done=(async()=>{
      try{
        const runtime=await this.runtime();
        flow.controller.signal.throwIfAborted();
        const selected=runtime.getProvider(provider);
        if(!selected||(type==="oauth"?!selected.auth.oauth?.login:!selected.auth.apiKey?.login))throw new Error("Unsupported connection method");
        await this.login(flow,selected);
      }catch{this.emitState(flow,flow.timedOut?"timed_out":flow.controller.signal.aborted?"cancelled":"failed");}
      finally{clearTimeout(flow.timer);flow.settled=true;}
    })();
    return {flowId:id,accepted:true};
  }
  private async login(flow:Flow,provider:ReturnType<ModelRuntime["getProvider"]>){
    if(!provider)return;
    const signal=flow.controller.signal;
    let staged:Credential|undefined;
    const scratch:CredentialStore={
      read:async()=>staged,list:async()=>staged?[{providerId:provider.id,type:staged.type}]:[],
      modify:async(_id,fn)=>{signal.throwIfAborted();const next=await fn(staged);signal.throwIfAborted();staged=next??staged;return staged;},
      delete:async()=>{staged=undefined;},
    };
    let nativeOperations:Promise<void>[]=[];
    let nativeFailed=false;
    let saved=false;
    try{
      const runtime=await ModelRuntime.create({credentials:scratch,modelsPath:null,refreshOnCreate:false,allowModelNetwork:false});
      runtime.registerNativeProvider(provider);
      const result=await runtime.login(provider.id,flow.type,{
        signal,
        prompt:async prompt=>{
          if(prompt.type!=="manual_code")this.emitState(flow,"awaiting_input");
          const value=await this.native.prompt(provider.name,prompt,signal);
          if(prompt.type==="secret"||prompt.type==="manual_code")rememberAuthInput(value);
          return value;
        },
        notify:event=>{
          if(signal.aborted)return;
          let operation:Promise<void>|undefined;
          if(event.type==="auth_url"){
            this.emitState(flow,"awaiting_browser");operation=this.native.browser(event.url,signal);
          }else if(event.type==="device_code"){
            this.emitState(flow,"awaiting_browser");
            operation=this.native.browser(event.verificationUri,signal).then(()=>this.native.notice(`请在浏览器输入验证码：${event.userCode}`,signal));
          }else if(event.type==="info"){
            operation=this.native.notice(event.message,signal);
          }
          if(operation){nativeOperations.push(operation);void operation.catch(()=>{if(!signal.aborted)nativeFailed=true;flow.controller.abort();});}
        },
      });
      await Promise.all(nativeOperations);
      signal.throwIfAborted();
      if(this.flows.get(flow.provider)!==flow)throw authCancelled();
      // No cancellation after this visible commit boundary. Login values stay in Host memory.
      clearTimeout(flow.timer);
      this.emitState(flow,"saving");
      await this.credentials.save(provider.id,result);
      saved=true;
      await this.changed();
      this.emitState(flow,result.type==="oauth"?"connected":"configured");
    }catch(error){
      if((error as Error).name==="AbortError")flow.controller.abort();
      this.emitState(flow,saved?"sync_required":flow.timedOut?"timed_out":!nativeFailed&&signal.aborted?"cancelled":"failed");
    }finally{staged=undefined;nativeOperations=[];}
  }
  cancel(id:string):{cancelled:boolean}{
    const flow=[...this.flows.values()].find(f=>f.id===id);
    if(!flow||!activeStates.has(flow.state)||flow.state==="saving")return {cancelled:false};
    flow.controller.abort();
    this.emitState(flow,"cancelled");
    return {cancelled:true};
  }
  async disconnect(provider:string):Promise<{disconnected:boolean}>{
    if(this.mutationPending||[...this.flows.values()].some(flow=>!flow.settled))throw new Error("请先完成或取消当前连接。");
    this.mutationPending=true;
    try{
      if(!(await this.credentials.managed()).some(item=>item.providerId===provider))return {disconnected:false};
      await this.credentials.delete(provider);
      this.flows.delete(provider);
      await this.changed();
      this.emit("dcodeAuth.changed",{providerId:provider,state:"disconnected"});
      return {disconnected:true};
    }finally{this.mutationPending=false;}
  }
  async refresh():Promise<{refreshed:boolean}>{
    if(this.mutationPending||[...this.flows.values()].some(flow=>!flow.settled))throw new Error("请先完成或取消当前连接。");
    this.mutationPending=true;
    try{
      await this.changed();
      for(const flow of this.flows.values())if(flow.state==="sync_required")this.emitState(flow,flow.type==="oauth"?"connected":"configured");
      return {refreshed:true};
    }finally{this.mutationPending=false;}
  }
  async close(){for(const flow of this.flows.values())if(flow.state!=="saving")flow.controller.abort();await Promise.all([...this.flows.values()].map(flow=>flow.done));}
  async idle(){await Promise.all([...this.flows.values()].map(flow=>flow.done));}
}
