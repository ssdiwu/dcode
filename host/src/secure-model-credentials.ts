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
  constructor(readonly code: "unavailable" | "reconnect" = "unavailable") { super(code === "reconnect" ? "Reconnect this provider in D Code" : "Secure credential storage is unavailable"); }
}
export interface CredentialVault {
  list(): Promise<readonly CredentialInfo[]>;
  transaction<T>(provider: string, operation: (current: Credential | undefined) => Promise<{ value: T; write?: Credential | null }>, signal?: AbortSignal): Promise<T>;
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
  constructor(signal?: AbortSignal) {
    this.signal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(10 * 60_000)]);
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
          if (value.error) { this.fail(value.error === "cancelled" ? authCancelled() : new SecureCredentialError()); continue; }
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
  close(){this.signal.removeEventListener("abort",this.abort);this.child.stdin.end();this.child.kill();this.buffer="";this.lines=[];}
}
export class MacCredentialAdapter implements CredentialVault, ConfidentialInteraction {
  readonly service: string;
  private readonly lockDirectory: string;
  constructor(dataRoot:string){
    this.service=`com.dcode.model-auth.${createHash("sha256").update(dataRoot).digest("hex")}`;
    this.lockDirectory=join(dataRoot,"credential-locks");
  }
  private async request(input:Record<string,unknown>,signal?:AbortSignal){const pipe=new ConfidentialPipe(signal);try{return await pipe.exchange(input);}finally{pipe.close();}}
  async list():Promise<readonly CredentialInfo[]>{
    const result=await this.request({operation:"list",service:this.service});
    if(!Array.isArray(result.items))throw new SecureCredentialError();
    return result.items.flatMap((item:CredentialInfo)=>typeof item.providerId==="string"&&(item.type==="oauth"||item.type==="api_key")?[{providerId:item.providerId,type:item.type}]:[]);
  }
  async transaction<T>(provider:string,operation:(current:Credential|undefined)=>Promise<{value:T;write?:Credential|null}>,signal?:AbortSignal):Promise<T>{
    if(!/^[a-z0-9][a-z0-9._-]{0,199}$/i.test(provider))throw new SecureCredentialError();
    await mkdir(this.lockDirectory,{recursive:true,mode:0o700});
    const pipe=new ConfidentialPipe(signal);
    try{
      const current=await pipe.exchange({operation:"transaction",service:this.service,provider,lockPath:join(this.lockDirectory,createHash("sha256").update(provider).digest("hex"))});
      const result=await operation(credential(current.credential));
      signal?.throwIfAborted();
      await pipe.exchange({write:result.write!==undefined,...(result.write!==undefined?{credential:result.write}:{})});
      return result.value;
    }finally{pipe.close();}
  }
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
  private metadata: readonly CredentialInfo[] | undefined;
  private failedRefresh = new Set<string>();
  private verified = new Set<string>();
  private generations=new Map<string,number>();
  private externalVersions=new Map<string,string>();
  constructor(readonly vault:CredentialVault, private readonly externalPath:string){}
  generation(id:string){return this.generations.get(id)??0;}
  async recordResponse(id:string,generation:number,status:number):Promise<boolean>{
    if(generation!==this.generation(id))return false;
    try{if(!(await this.managed()).some(item=>item.providerId===id))await this.readExternal(id);}catch{return false;}
    if(generation!==this.generation(id))return false;
    if(status===401){this.failedRefresh.add(id);this.verified.delete(id);return true;}
    if(status>=200&&status<300){this.verified.add(id);this.failedRefresh.delete(id);return true;}
    return false;
  }
  async managed(){return this.metadata??=await this.vault.list();}
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
    if((await this.managed()).some(item=>item.providerId===id))return this.vault.transaction(id,async current=>{rememberCredential(current);return {value:current};},options?.signal);
    const external=await this.readExternal(id);
    // The read-only SDK adapter leaves command references unresolved; never send them as literal keys.
    return external?.type==="api_key"&&external.key?.startsWith("!")?{type:"api_key"}:external;
  }
  async connectionMetadata(id:string):Promise<{managed:boolean;type?:Credential["type"];expires?:number;failed:boolean;verified:boolean}> {
    const managed=(await this.managed()).some(item=>item.providerId===id);
    const value=managed?await this.vault.transaction(id,async current=>({value:current})):await this.readExternal(id);
    return {managed,type:value?.type,...(value?.type==="oauth"?{expires:value.expires}:{}),failed:this.failedRefresh.has(id)||value?.type==="api_key"&&!!value.key?.startsWith("!")||!managed&&value?.type==="oauth"&&value.expires<=Date.now()+5*60_000,verified:this.verified.has(id)};
  }
  async unavailableProviders(ids:readonly string[]):Promise<Set<string>> {
    const entries=await Promise.all(ids.map(async id=>{try{return [id,(await this.connectionMetadata(id)).failed] as const;}catch{return [id,true] as const;}}));
    return new Set(entries.filter(([,failed])=>failed).map(([id])=>id));
  }
  async list(options?:AuthOperationOptions):Promise<readonly CredentialInfo[]>{
    options?.signal?.throwIfAborted();
    this.metadata=await this.vault.list();
    let external:readonly CredentialInfo[];try{external=await (await this.external()).list(options);}catch{throw new SecureCredentialError();}
    const entries=new Map(external.map(item=>[item.providerId,item]));
    for(const item of this.metadata)entries.set(item.providerId,item);
    return [...entries.values()];
  }
  async modify(id:string,fn:(current:Credential|undefined)=>Promise<Credential|undefined>,options?:AuthOperationOptions):Promise<Credential|undefined>{
    // External OAuth refresh must never write auth.json or silently adopt its body.
    if(!(await this.managed()).some(item=>item.providerId===id))throw new SecureCredentialError("reconnect");
    let written=false;
    const result=await this.vault.transaction(id,async current=>{
      if(!current)return {value:undefined};
      try{const next=await fn(current);rememberCredential(next);written=next!==undefined;return {value:next??current,...(next?{write:next}:{})};}
      catch(e){if(options?.signal?.aborted)throw authCancelled();this.failedRefresh.add(id);throw new SecureCredentialError("reconnect");}
    },options?.signal);
    if(written)this.generations.set(id,this.generation(id)+1);
    return result;
  }
  async save(id:string,value:Credential):Promise<void>{
    credential(value);rememberCredential(value);
    await this.vault.transaction(id,async()=>({value:undefined,write:value}));
    this.failedRefresh.delete(id);this.verified.delete(id);this.generations.set(id,this.generation(id)+1);
    this.metadata=undefined;
  }
  async delete(id:string,options?:AuthOperationOptions):Promise<void>{
    await this.vault.transaction(id,async()=>({value:undefined,write:null}),options?.signal);
    this.failedRefresh.delete(id);this.verified.delete(id);this.generations.set(id,this.generation(id)+1);
    this.metadata=undefined;
  }
}
