import { rememberCredential, rememberAuthInput } from "./credential-material.js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AuthOperationOptions, AuthPrompt, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

// Fixed Pi 0.85.1 exports the read-only store internally; resolve relative to its
// actual package entry, as with the existing ModelConfig adapter.
const {ReadOnlyAuthStorage}=await import(new URL("./core/auth-storage.js",import.meta.resolve("@earendil-works/pi-coding-agent")).href) as {ReadOnlyAuthStorage:new(path:string)=>CredentialStore};

export function authCancelled(): Error { return new DOMException("Connection cancelled", "AbortError"); }
export class SecureCredentialError extends Error {
  constructor(readonly code: "unavailable" | "reconnect" | "access_required" | "access_denied" = "unavailable") { super(code === "reconnect" ? "Reconnect this provider in D Code" : code === "access_required" ? "Keychain access requires user authorization" : code === "access_denied" ? "Keychain access was not allowed" : "Secure credential storage is unavailable"); }
}
export interface ManagedCredentialInfo extends CredentialInfo { expires?:number }
interface KnownManagedCredential {providerId:string;type?:Credential["type"];expires?:number}
export interface CredentialVault {
  list(): Promise<readonly ManagedCredentialInfo[]>;
  close?():void;
  transaction<T>(provider: string, operation: (current: Credential | undefined) => Promise<{ value: T; write?: Credential | null }>, signal?: AbortSignal, options?:{interactive?:boolean}): Promise<T>;
}
export interface ConfidentialInteraction {
  prompt(providerName: string, prompt: AuthPrompt, signal: AbortSignal): Promise<string>;
  browser(url: string, signal: AbortSignal): Promise<void>;
  notice(message: string, signal: AbortSignal): Promise<void>;
}
function credential(value: unknown): Credential | undefined {
  if (value == null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new SecureCredentialError();
  const v = value as Record<string, unknown>;
  if (v.type === "api_key" && (typeof v.key === "string" && !!v.key.trim() || v.env && typeof v.env === "object" && Object.keys(v.env).length>0)) return v as unknown as Credential;
  if (v.type === "oauth" && typeof v.access === "string" && typeof v.refresh === "string" && typeof v.expires === "number" && Number.isFinite(v.expires)) return v as unknown as Credential;
  throw new SecureCredentialError();
}
/** A private child pipe, never attached to Host's public stdin/stdout. */
class ConfidentialPipe {
  private child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private lines: Record<string, unknown>[] = [];
  private waiting?: {resolve:(v:Record<string, unknown>)=>void;reject:(e:Error)=>void};
  private failure?: Error;
  private readonly signal: AbortSignal;
  private readonly abort: () => void;
  constructor(signal?: AbortSignal, persistent=false) {
    this.signal = AbortSignal.any([...(signal ? [signal] : []), ...(!persistent?[AbortSignal.timeout(10 * 60_000)]:[])]);
    this.child = spawn(fileURLToPath(new URL("../bin/dcode-model-credentials", import.meta.url)), [], {stdio:"pipe", env:{PATH:"/usr/bin:/bin:/usr/sbin:/sbin"}});
    this.abort = () => { this.fail(authCancelled()); this.child.kill(); };
    this.signal.addEventListener("abort", this.abort, {once:true});
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk:string) => {
      this.buffer += chunk;
      if (this.buffer.length > 1_048_576) { this.fail(new SecureCredentialError()); this.child.kill(); return; }
      let end: number;
      while ((end = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0,end); this.buffer = this.buffer.slice(end+1);
        try {
          const value = JSON.parse(line) as Record<string,unknown>;
          if (value.error) { this.fail(value.error === "cancelled" ? authCancelled() : new SecureCredentialError(value.error === "access_required" || value.error === "access_denied" ? value.error : "unavailable")); continue; }
          if(this.waiting){const pending=this.waiting;this.waiting=undefined;pending.resolve(value);}else this.lines.push(value);
        } catch { this.fail(new SecureCredentialError()); }
      }
    });
    // Native/library messages are deliberately not forwarded to a public log.
    this.child.stderr.resume();
    this.child.stdin.on("error",()=>this.fail(new SecureCredentialError()));
    this.child.on("error",()=>this.fail(new SecureCredentialError()));
    this.child.on("close",()=>{this.signal.removeEventListener("abort",this.abort);this.fail(new SecureCredentialError());});
    if (this.signal.aborted) this.abort();
  }
  private fail(error:Error){this.failure??=error;if(this.waiting){this.waiting.reject(this.failure);this.waiting=undefined;}}
  async exchange(input:Record<string,unknown>):Promise<Record<string,unknown>>{
    this.signal.throwIfAborted();
    if(this.failure)throw this.failure;
    this.child.stdin.write(JSON.stringify(input)+"\n");
    if(this.lines.length)return this.lines.shift()!;
    return new Promise((resolve,reject)=>{this.waiting={resolve,reject};});
  }
  close(){this.fail(new SecureCredentialError());this.signal.removeEventListener("abort",this.abort);this.child.stdin.end();this.child.kill();this.buffer="";this.lines=[];}
}
export class MacCredentialAdapter implements CredentialVault, ConfidentialInteraction {
  readonly service: string;
  private readonly lockDirectory: string;
  private readonly providers=new Map<string,{tail:Promise<void>;pipe?:ConfidentialPipe}>();
  private closed=false;
  constructor(dataRoot:string){
    this.service=`com.dcode.model-auth.${createHash("sha256").update(dataRoot).digest("hex")}`;
    this.lockDirectory=join(dataRoot,"credential-locks");
  }
  private async request(input:Record<string,unknown>,signal?:AbortSignal){const pipe=new ConfidentialPipe(signal);try{return await pipe.exchange(input);}finally{pipe.close();}}
  async list():Promise<readonly ManagedCredentialInfo[]>{
    const result=await this.request({operation:"list",service:this.service},AbortSignal.timeout(5000));
    if(!Array.isArray(result.items))throw new SecureCredentialError();
    return result.items.flatMap((item:ManagedCredentialInfo)=>typeof item.providerId==="string"&&/^[a-z0-9][a-z0-9._-]{0,199}$/i.test(item.providerId)&&(item.type==="oauth"||item.type==="api_key")?[{providerId:item.providerId,type:item.type,...(typeof item.expires==="number"&&Number.isFinite(item.expires)?{expires:item.expires}:{})}]:[]);
  }
  async transaction<T>(provider:string,operation:(current:Credential|undefined)=>Promise<{value:T;write?:Credential|null}>,signal?:AbortSignal,options:{interactive?:boolean}={}):Promise<T>{
    if(!/^[a-z0-9][a-z0-9._-]{0,199}$/i.test(provider)||this.closed)throw new SecureCredentialError();
    let slot=this.providers.get(provider);if(!slot){slot={tail:Promise.resolve()};this.providers.set(provider,slot);}const currentSlot=slot;
    const task=currentSlot.tail.then(async()=>{
      if(this.closed)throw new SecureCredentialError();signal?.throwIfAborted();
      await mkdir(this.lockDirectory,{recursive:true,mode:0o700});
      const pipe=currentSlot.pipe??=new ConfidentialPipe(undefined,true);
      const timeout=AbortSignal.timeout(options.interactive?60_000:30_000);
      const combined=AbortSignal.any([timeout,...(signal?[signal]:[])]);
      const abort=()=>{pipe.close();if(currentSlot.pipe===pipe)currentSlot.pipe=undefined;};combined.addEventListener("abort",abort,{once:true});
      try{
        combined.throwIfAborted();
        const current=await pipe.exchange({operation:"transaction",service:this.service,provider,interactive:options.interactive===true,lockPath:join(this.lockDirectory,createHash("sha256").update(provider).digest("hex"))});
        const result=await operation(credential(current.credential));combined.throwIfAborted();
        await pipe.exchange({write:result.write!==undefined,...(result.write!==undefined?{credential:result.write}:{})});
        return result.value;
      }catch(error){abort();if(signal?.aborted)throw authCancelled();if(timeout.aborted)throw new SecureCredentialError("unavailable");throw error;}
      finally{combined.removeEventListener("abort",abort);}
    });
    currentSlot.tail=task.then(()=>{},()=>{});return task;
  }
  close(){this.closed=true;for(const slot of this.providers.values())slot.pipe?.close();this.providers.clear();}
  async prompt(providerName:string,prompt:AuthPrompt,signal:AbortSignal):Promise<string>{
    const combined=AbortSignal.any([signal,...(prompt.signal?[prompt.signal]:[])]);
    const {signal:_,...payload}=prompt;
    const result=await this.request({operation:"prompt",providerName,...payload},combined);
    if(typeof result.value!=="string")throw new SecureCredentialError();
    if(prompt.type==="secret"||prompt.type==="manual_code")rememberAuthInput(result.value);
    return result.value;
  }
  async browser(url:string,signal:AbortSignal){await this.request({operation:"browser",url},signal);}
  async notice(message:string,signal:AbortSignal){await this.request({operation:"notice",message},signal);}
}

/** One shared Host store; the native lock also serializes another process's refresh. */
export class DCodeCredentialStore implements CredentialStore {
  private metadata: readonly KnownManagedCredential[] | undefined;
  private metadataFlight?:Promise<readonly KnownManagedCredential[]>;
  private metadataEpoch=0;
  private readonly knownManaged=new Set<string>();
  private catalogSeen=false;
  private readonly observed=new Map<string,{type?:Credential["type"];expires?:number;fingerprint:string}>();
  private readonly blocked=new Map<string,"access_required"|"access_denied"|"unavailable">();
  private readonly readFlights=new Map<string,Promise<Credential|undefined>>();
  private closed=false;
  private failedRefresh = new Set<string>();
  private verified = new Set<string>();
  private generations=new Map<string,number>();
  private externalVersions=new Map<string,string>();
  constructor(readonly vault:CredentialVault, private readonly externalPath:string,private readonly options:{knownManagedProviderIds?:()=>Promise<string[]>;onAccessChanged?:(id:string)=>void}={}){}
  generation(id:string){return this.generations.get(id)??0;}
  async recordResponse(id:string,generation:number,status:number):Promise<boolean>{
    if(generation!==this.generation(id))return false;
    try{if(!(await this.managed()).some(item=>item.providerId===id))await this.readExternal(id);}catch{return false;}
    if(generation!==this.generation(id))return false;
    if(status===401){this.failedRefresh.add(id);this.verified.delete(id);return true;}
    if(status>=200&&status<300){this.verified.add(id);this.failedRefresh.delete(id);return true;}
    return false;
  }
  private invalidateMetadata(){this.metadataEpoch++;this.metadata=undefined;this.metadataFlight=undefined;}
  async managed():Promise<readonly KnownManagedCredential[]>{
    if(this.closed)throw new SecureCredentialError();
    if(this.metadata)return this.metadata;
    if(this.metadataFlight)return this.metadataFlight;
    const epoch=this.metadataEpoch;
    const flight=(async()=>{
      try{
        const items=await this.vault.list();if(this.closed)throw new SecureCredentialError();if(epoch!==this.metadataEpoch)return this.managed();
        this.catalogSeen=true;this.knownManaged.clear();for(const item of items)this.knownManaged.add(item.providerId);return this.metadata=items;
      }catch(error){
        if(this.closed)throw error;if(epoch!==this.metadataEpoch)return this.managed();
        if(!this.catalogSeen){const ids=await this.options.knownManagedProviderIds?.()??[];if(epoch!==this.metadataEpoch)return this.managed();for(const id of ids)this.knownManaged.add(id);}
        for(const id of this.knownManaged)this.block(id,error);
        return this.metadata=[...this.knownManaged].map(providerId=>({providerId,type:this.observed.get(providerId)?.type,expires:this.observed.get(providerId)?.expires}));
      }
    })().finally(()=>{if(this.metadataFlight===flight)this.metadataFlight=undefined;});this.metadataFlight=flight;return flight;
  }
  accessState(id:string){return this.blocked.get(id);}
  private block(id:string,error:unknown){if(this.closed)return;const state=error instanceof SecureCredentialError&&(error.code==="access_required"||error.code==="access_denied")?error.code:"unavailable";if(this.blocked.get(id)!==state){this.blocked.set(id,state);this.options.onAccessChanged?.(id);}}
  async refreshMetadata(){this.invalidateMetadata();await this.managed();}
  private observe(id:string,value:Credential|undefined){
    if(!value){this.verified.delete(id);this.failedRefresh.delete(id);this.observed.delete(id);this.knownManaged.delete(id);this.blocked.delete(id);this.generations.set(id,this.generation(id)+1);this.invalidateMetadata();this.options.onAccessChanged?.(id);return;}
    const fingerprint=createHash("sha256").update(JSON.stringify(value??null)).digest("hex"),prior=this.observed.get(id);
    if(prior&&prior.fingerprint!==fingerprint){this.failedRefresh.delete(id);this.verified.delete(id);this.generations.set(id,this.generation(id)+1);this.invalidateMetadata();}
    this.observed.set(id,{fingerprint,type:value?.type,...(value?.type==="oauth"?{expires:value.expires}:{})});rememberCredential(value);
  }
  async authorize(id:string,signal:AbortSignal):Promise<void>{
    if(this.closed)throw new SecureCredentialError();
    this.generations.set(id,this.generation(id)+1);this.readFlights.delete(id);
    try{const value=await this.vault.transaction(id,async current=>({value:current}),signal,{interactive:true});signal.throwIfAborted();if(!value)throw new SecureCredentialError("reconnect");this.observe(id,value);this.blocked.delete(id);this.invalidateMetadata();this.options.onAccessChanged?.(id);}
    catch(error){this.block(id,signal.aborted?new SecureCredentialError("access_required"):error);throw error;}
  }
  close(){this.closed=true;this.vault.close?.();this.invalidateMetadata();this.observed.clear();this.readFlights.clear();this.blocked.clear();}
  private async external():Promise<CredentialStore>{
    try{
      const info=await stat(this.externalPath).catch(error=>{if((error as NodeJS.ErrnoException).code==="ENOENT")return undefined;throw error;});
      if(info&&(!info.isFile()||info.size>1_048_576))throw new SecureCredentialError();
      return new ReadOnlyAuthStorage(this.externalPath);
    }catch{throw new SecureCredentialError();}
  }
  private async readExternal(id:string):Promise<Credential|undefined>{
    try{
      const value=await (await this.external()).read(id);
      if(value?.type!=="api_key"||!value.key?.startsWith("!"))rememberCredential(value);
      // Only an in-memory identity fingerprint; never persisted or projected.
      const version=createHash("sha256").update(JSON.stringify(value??null)).digest("hex");
      if(this.externalVersions.has(id)&&this.externalVersions.get(id)!==version){this.failedRefresh.delete(id);this.verified.delete(id);this.generations.set(id,this.generation(id)+1);}
      this.externalVersions.set(id,version);
      return value;
    }catch{throw new SecureCredentialError("reconnect");}
  }
  async read(id:string,options?:AuthOperationOptions):Promise<Credential|undefined>{
    options?.signal?.throwIfAborted();
    if(this.closed)throw new SecureCredentialError();
    if((await this.managed()).some(item=>item.providerId===id)){
      const blocked=this.blocked.get(id);if(blocked)throw new SecureCredentialError(blocked);
      let flight=this.readFlights.get(id);
      if(!flight){
        const generation=this.generation(id);
        flight=this.vault.transaction(id,async current=>({value:current})).then(value=>{
          if(this.closed||generation!==this.generation(id))throw authCancelled();this.observe(id,value);return value;
        }).catch(error=>{if(this.closed||generation!==this.generation(id))throw authCancelled();const failure=error instanceof SecureCredentialError?error:new SecureCredentialError("unavailable");this.block(id,failure);throw failure;}).finally(()=>{if(this.readFlights.get(id)===flight)this.readFlights.delete(id);});
        this.readFlights.set(id,flight);
      }
      // One caller aborting must not cancel another caller's shared read.
      if(!options?.signal)return flight;
      const signal=options.signal;return new Promise((resolve,reject)=>{const abort=()=>reject(authCancelled());if(signal.aborted){abort();return;}signal.addEventListener("abort",abort,{once:true});flight!.then(value=>{signal.removeEventListener("abort",abort);if(!signal.aborted)resolve(value);},error=>{signal.removeEventListener("abort",abort);reject(error);});});
    }
    const external=await this.readExternal(id);
    // The read-only SDK adapter leaves command references unresolved; never send them as literal keys.
    return external?.type==="api_key"&&external.key?.startsWith("!")?{type:"api_key"}:external;
  }
  async connectionMetadata(id:string):Promise<{managed:boolean;type?:Credential["type"];expires?:number;failed:boolean;verified:boolean}> {
    const item=(await this.managed()).find(item=>item.providerId===id),managed=!!item;
    if(item)return {managed:true,type:this.observed.get(id)?.type??item.type,...(this.observed.has(id)?{expires:this.observed.get(id)?.expires}:typeof item.expires==="number"?{expires:item.expires}:{}),failed:this.failedRefresh.has(id),verified:this.verified.has(id)};
    const value=await this.readExternal(id);
    return {managed,type:value?.type,...(value?.type==="oauth"?{expires:value.expires}:{}),failed:this.failedRefresh.has(id)||value?.type==="api_key"&&!!value.key?.startsWith("!")||value?.type==="oauth"&&value.expires<=Date.now()+5*60_000,verified:this.verified.has(id)};
  }
  async unavailableProviders(ids:readonly string[]):Promise<Set<string>> {
    const entries=await Promise.all(ids.map(async id=>{try{return [id,!!this.blocked.get(id)||(await this.connectionMetadata(id)).failed] as const;}catch{return [id,true] as const;}}));
    return new Set(entries.filter(([,failed])=>failed).map(([id])=>id));
  }
  async list(options?:AuthOperationOptions):Promise<readonly CredentialInfo[]>{
    options?.signal?.throwIfAborted();
    const managed=await this.managed();
    let external:readonly CredentialInfo[];try{external=await (await this.external()).list(options);}catch{throw new SecureCredentialError();}
    const entries=new Map(external.map(item=>[item.providerId,item]));
    for(const item of managed)if(item.type)entries.set(item.providerId,{providerId:item.providerId,type:item.type});
    return [...entries.values()];
  }
  async modify(id:string,fn:(current:Credential|undefined)=>Promise<Credential|undefined>,options?:AuthOperationOptions):Promise<Credential|undefined>{
    // External OAuth refresh must never write auth.json or silently adopt its body.
    if(!(await this.managed()).some(item=>item.providerId===id))throw new SecureCredentialError("reconnect");
    const blocked=this.blocked.get(id);if(blocked)throw new SecureCredentialError(blocked);
    let written=false;
    const result=await this.vault.transaction(id,async current=>{
      if(!current)return {value:undefined};
      try{const next=await fn(current);rememberCredential(next);written=next!==undefined;return {value:next??current,...(next?{write:next}:{})};}
      catch(e){if(options?.signal?.aborted)throw authCancelled();this.failedRefresh.add(id);throw new SecureCredentialError("reconnect");}
    },options?.signal).catch(error=>{if(error instanceof SecureCredentialError&&error.code!=="reconnect")this.block(id,error);throw error;});
    if(written){this.readFlights.delete(id);this.observe(id,result);this.invalidateMetadata();this.generations.set(id,this.generation(id)+1);}
    return result;
  }
  async save(id:string,value:Credential):Promise<void>{
    credential(value);rememberCredential(value);
    await this.vault.transaction(id,async()=>({value:undefined,write:value}),undefined,{interactive:true});
    this.readFlights.delete(id);this.blocked.delete(id);this.observe(id,value);
    this.failedRefresh.delete(id);this.verified.delete(id);this.generations.set(id,this.generation(id)+1);
    this.invalidateMetadata();
  }
  async saveApiKey(id:string,key:string):Promise<void>{
    rememberCredential({key});
    await this.vault.transaction(id,async current=>({value:undefined,write:{type:"api_key",...(current?.type==="api_key"&&current.env?{env:current.env}:{}),key}}),undefined,{interactive:true});
    this.readFlights.delete(id);this.blocked.delete(id);this.observed.delete(id);
    this.failedRefresh.delete(id);this.verified.delete(id);this.generations.set(id,this.generation(id)+1);
    this.invalidateMetadata();
  }
  async delete(id:string,options?:AuthOperationOptions):Promise<void>{
    await this.vault.transaction(id,async()=>({value:undefined,write:null}),options?.signal,{interactive:true});
    this.readFlights.delete(id);this.blocked.delete(id);this.observed.delete(id);
    this.failedRefresh.delete(id);this.verified.delete(id);this.generations.set(id,this.generation(id)+1);
    this.invalidateMetadata();
  }
}
