import { MAX_API_KEY_LENGTH, type ApiKeyConnectionResult } from "./api-key-connection.js";
import { rememberAuthInput } from "./credential-material.js";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AuthType, AuthPrompt, Credential, CredentialStore } from "@earendil-works/pi-ai";
import { DCodeCredentialStore, authCancelled, type ConfidentialInteraction } from "./secure-model-credentials.js";

export type ConnectionState = "disconnected" | "configured" | "connected" | "reconnect_required" | "awaiting_input" | "awaiting_browser" | "saving" | "failed" | "cancelled" | "sync_required" | "timed_out" | "refresh_pending";
export type ConnectionFailureCode="interaction_unavailable"|"authorization_failed"|"credential_save_failed"|"catalog_sync_failed";
interface ManualInput {prompt:AuthPrompt;providerName:string;signal:AbortSignal;resolve:(value:string)=>void;opening:boolean;issue?:"input_unavailable"|"input_cancelled"}
export interface ProviderConnection {
  providerId:string;
  methods:{type:AuthType;label:string}[];
  state:ConnectionState;
  managed:boolean;
  external:boolean;
  flowId?:string;
  activeMethod?:AuthType;
  canOpenBrowser?:boolean;
  browserOpening?:boolean;
  browserFailed?:boolean;
  canEnterCode?:boolean;
  inputOpening?:boolean;
  inputIssue?:ManualInput["issue"];
  failureCode?:ConnectionFailureCode;
}
interface Flow {id:string;provider:string;type:AuthType;controller:AbortController;state:ConnectionState;done:Promise<void>;settled:boolean;timedOut:boolean;timer?:ReturnType<typeof setTimeout>;authUrl?:string;browserOpening?:boolean;browserFailed?:boolean;browserController?:AbortController;manual?:ManualInput;failureCode?:ConnectionFailureCode}
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
      return {providerId:provider.id,methods,state,managed:owned,external,...(flow?{flowId:flow.id,activeMethod:flow.type,failureCode:flow.failureCode,
        canOpenBrowser:this.live(flow)&&!!flow.authUrl,browserOpening:!!flow.browserOpening,browserFailed:!!flow.browserFailed,
        canEnterCode:this.live(flow)&&!!flow.manual,inputOpening:!!flow.manual?.opening,inputIssue:flow.manual?.issue}: {})};
    }))};
  }
  async start(provider:string,type:AuthType,id:string):Promise<{flowId:string;accepted:boolean}>{
    if(type==="api_key")throw new Error("请在供应商旁输入 API Key 后连接。");
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
      }catch{if(!flow.controller.signal.aborted)flow.failureCode??="authorization_failed";this.emitState(flow,flow.timedOut?"timed_out":flow.controller.signal.aborted?"cancelled":"failed");}
      finally{clearTimeout(flow.timer);flow.settled=true;flow.authUrl=undefined;flow.browserController?.abort();flow.manual=undefined;}
    })();
    return {flowId:id,accepted:true};
  }
  async connectApiKey(provider:string,key:string,id:string):Promise<ApiKeyConnectionResult>{
    if(typeof key!=="string"||!key.trim()||key.length>MAX_API_KEY_LENGTH||!/^[a-z0-9][a-z0-9._-]{0,199}$/i.test(provider))return {ok:false,code:"INVALID_INPUT"};
    if(this.seen.has(id)||this.mutationPending||[...this.flows.values()].some(flow=>!flow.settled))return {ok:false,code:"BUSY"};
    this.seen.add(id);if(this.seen.size>256)this.seen.delete(this.seen.values().next().value!);
    const flow:Flow={id,provider,type:"api_key",controller:new AbortController(),state:"saving",done:Promise.resolve(),settled:false,timedOut:false};
    this.flows.set(provider,flow);
    let result:ApiKeyConnectionResult={ok:false,code:"FAILED"};
    flow.done=(async()=>{
      let saved=false,announced=false;
      try{
        const runtime=await this.runtime();
        if(!runtime.getProvider(provider)?.auth.apiKey?.login)throw new Error("Unsupported connection method");
        announced=true;this.emitState(flow,"saving");
        await this.credentials.saveApiKey(provider,key.trim());saved=true;key="";
        await this.changed();this.emitState(flow,"configured");result={ok:true};
      }catch{if(announced)this.emitState(flow,saved?"sync_required":"failed");else this.flows.delete(provider);result={ok:false,code:saved?"SYNC_REQUIRED":"FAILED"};}
      finally{key="";flow.settled=true;}
    })();
    await flow.done;return result;
  }
  private live(flow:Flow){return this.flows.get(flow.provider)===flow&&!flow.settled&&!flow.controller.signal.aborted&&activeStates.has(flow.state)&&flow.state!=="saving";}
  openBrowser(id:string):{accepted:boolean;reason?:"inactive"|"busy"}{
    const flow=[...this.flows.values()].find(f=>f.id===id);
    if(!flow||!this.live(flow)||!flow.authUrl)return {accepted:false,reason:"inactive"};
    if(flow.browserOpening)return {accepted:false,reason:"busy"};
    const url=flow.authUrl,controller=new AbortController();flow.browserController=controller;flow.browserOpening=true;flow.browserFailed=false;this.emitState(flow,flow.state);
    // Return control immediately so the serial Host channel remains available
    // for cancel/status while the OS is opening the application.
    void (async()=>{
      try{await this.native.browser(url,AbortSignal.any([flow.controller.signal,controller.signal]));}
      catch{if(this.live(flow))flow.browserFailed=true;}
      finally{flow.browserOpening=false;if(this.live(flow))this.emitState(flow,flow.state);}
    })();
    return {accepted:true};
  }
  private waitForManualInput(flow:Flow,providerName:string,prompt:AuthPrompt):Promise<string>{
    const signal=AbortSignal.any([flow.controller.signal,...(prompt.signal?[prompt.signal]:[])]);
    return new Promise((resolve,reject)=>{
      const finish=(value?:string)=>{signal.removeEventListener("abort",abort);if(flow.manual===manual)flow.manual=undefined;if(value===undefined)reject(authCancelled());else resolve(value);};
      const abort=()=>finish();
      const manual:ManualInput={prompt,providerName,signal,resolve:value=>finish(value),opening:false};flow.manual=manual;
      if(signal.aborted){abort();return;}signal.addEventListener("abort",abort,{once:true});this.emitState(flow,"awaiting_browser");
    });
  }
  enterCode(id:string):{accepted:boolean}{
    const flow=[...this.flows.values()].find(f=>f.id===id),manual=flow?.manual;
    if(!flow||!this.live(flow)||!manual||manual.opening)return {accepted:false};
    manual.opening=true;manual.issue=undefined;this.emitState(flow,flow.state);
    void Promise.resolve().then(()=>this.native.prompt(manual.providerName,manual.prompt,manual.signal)).then(value=>{
      if(this.live(flow)&&flow.manual===manual&&!manual.signal.aborted){rememberAuthInput(value);manual.resolve(value);}
    },error=>{
      if(this.live(flow)&&flow.manual===manual&&!manual.signal.aborted)manual.issue=(error as Error)?.name==="AbortError"?"input_cancelled":"input_unavailable";
    }).finally(()=>{manual.opening=false;if(this.live(flow))this.emitState(flow,flow.state);});
    return {accepted:true};
  }
  private publishAuthUrl(flow:Flow,url:string){
    try{const parsed=new URL(url);if(parsed.protocol!=="https:"||parsed.username||parsed.password)throw Error();}
    catch{flow.failureCode="authorization_failed";flow.controller.abort();return;}
    flow.authUrl=url;this.emitState(flow,"awaiting_browser");void this.openBrowser(flow.id);
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
          if(prompt.type==="manual_code"&&flow.authUrl)return this.waitForManualInput(flow,provider.name,prompt);
          if(prompt.type!=="manual_code")this.emitState(flow,"awaiting_input");
          try{
            const value=await this.native.prompt(provider.name,prompt,signal);
            if(prompt.type==="select"&&!prompt.options.some(option=>option.id===value))throw Error("Invalid selection");
            if(prompt.type==="secret"||prompt.type==="manual_code")rememberAuthInput(value);
            return value;
          }catch(error){if((error as Error)?.name!=="AbortError")flow.failureCode="interaction_unavailable";throw error;}
        },
        notify:event=>{
          if(signal.aborted)return;
          let operation:Promise<void>|undefined;
          if(event.type==="auth_url"){
            this.publishAuthUrl(flow,event.url);
          }else if(event.type==="device_code"){
            this.publishAuthUrl(flow,event.verificationUri);
            operation=this.native.notice(`请在浏览器输入验证码：${event.userCode}`,signal);
          }else if(event.type==="info"){
            operation=this.native.notice(event.message,signal);
          }
          if(operation){nativeOperations.push(operation);void operation.catch(()=>{if(!signal.aborted){nativeFailed=true;flow.failureCode="interaction_unavailable";}flow.controller.abort();});}
        },
      });
      await Promise.all(nativeOperations);
      signal.throwIfAborted();
      if(this.flows.get(flow.provider)!==flow)throw authCancelled();
      // No cancellation after this visible commit boundary. Login values stay in Host memory.
      clearTimeout(flow.timer);flow.authUrl=undefined;flow.browserController?.abort();
      this.emitState(flow,"saving");flow.failureCode="credential_save_failed";
      await this.credentials.save(provider.id,result);
      saved=true;flow.failureCode="catalog_sync_failed";
      await this.changed();flow.failureCode=undefined;
      this.emitState(flow,result.type==="oauth"?"connected":"configured");
    }catch(error){
      if((error as Error).name==="AbortError")flow.controller.abort();
      const cancelled=!nativeFailed&&!flow.failureCode&&signal.aborted;
      if(!flow.timedOut&&!cancelled)flow.failureCode??="authorization_failed";
      this.emitState(flow,saved?"sync_required":flow.timedOut?"timed_out":cancelled?"cancelled":"failed");
    }finally{staged=undefined;nativeOperations=[];}
  }
  cancel(id:string):{cancelled:boolean}{
    const flow=[...this.flows.values()].find(f=>f.id===id);
    if(!flow||!activeStates.has(flow.state)||flow.state==="saving")return {cancelled:false};
    flow.authUrl=undefined;flow.controller.abort();
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
      for(const flow of this.flows.values())if(flow.state==="sync_required"){flow.failureCode=undefined;this.emitState(flow,flow.type==="oauth"?"connected":"configured");}
      return {refreshed:true};
    }finally{this.mutationPending=false;}
  }
  async close(){for(const flow of this.flows.values())if(flow.state!=="saving")flow.controller.abort();await Promise.all([...this.flows.values()].map(flow=>flow.done));}
  async idle(){await Promise.all([...this.flows.values()].map(flow=>flow.done));}
}
