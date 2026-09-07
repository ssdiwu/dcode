import {fork,execFile,type ChildProcess} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID,createHash} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import {createBashTool,type BashOperations} from '@earendil-works/pi-coding-agent';
import type {AgentTool} from '@earendil-works/pi-agent-core';
export interface AuxiliaryProcessInfo {
  id:string;pid:number;cwd:string;shellPid?:number;memberPids:number[];toolCallId:string;commandDigest:string;
  status:'starting'|'running'|'background'|'unknown'|'exited';startedAt:string;endedAt?:string;exitCode?:number|null;reason?:'stopped'|'completed'|'unexpected'|'supervisor_restarted';
}
interface Owned {child:ChildProcess;info:AuxiliaryProcessInfo;finished:Promise<void>;resolveFinished:()=>void;persistence:Promise<void>;stop?:Promise<void>}
/** Each command has a live, private process-group anchor until its last normal
 * child exits. Command text and environment travel over IPC, never argv/storage. */
export class AuxiliaryProcesses implements BashOperations {
  private entries=new Map<string,Owned>();
  private toolContext=new AsyncLocalStorage<string>();
  private disposed=false;
  constructor(private readonly onChanged:(info:AuxiliaryProcessInfo)=>Promise<void>){ }
  get hasLive():boolean{return [...this.entries.values()].some(entry=>entry.info.status!=='exited');}
  get snapshot():AuxiliaryProcessInfo[]{return [...this.entries.values()].map(entry=>structuredClone(entry.info));}
  tool(cwd:string):AgentTool {const tool=createBashTool(cwd,{operations:this,exposeSessionEnvironment:false});const execute=tool.execute.bind(tool);return {...tool,execute:(id,args,signal,update)=>this.toolContext.run(id,()=>execute(id,args as Parameters<typeof execute>[1],signal,update))};}
  private changed(entry:Owned):Promise<void>{const value=structuredClone(entry.info);entry.persistence=entry.persistence.then(()=>this.onChanged(value));void entry.persistence.catch(()=>{void this.stop(entry.info.id);});return entry.persistence;}
  exec:BashOperations['exec']=async(command,cwd,options)=>{
    if(this.disposed||options.signal?.aborted)throw new Error('aborted');
    if(options.timeout!==undefined&&(!Number.isFinite(options.timeout)||options.timeout<=0||options.timeout>2147483))throw new Error('Invalid timeout');
    const toolCallId=this.toolContext.getStore();if(!toolCallId)throw new Error('Command has no owning tool call');
    const executionId=randomUUID();
    const child=fork(new URL('./auxiliary-process-entry.js',import.meta.url),[executionId],{detached:true,serialization:'advanced',stdio:['ignore','ignore','ignore','ipc'],execArgv:['--disable-warning=ExperimentalWarning'],env:{PATH:process.env.PATH,TMPDIR:process.env.TMPDIR,LANG:process.env.LANG,ELECTRON_RUN_AS_NODE:'1'}});
    let resolveFinished!:()=>void;const finished=new Promise<void>(resolve=>{resolveFinished=resolve;});
    const info:AuxiliaryProcessInfo={id:executionId,pid:child.pid??0,cwd,memberPids:[],toolCallId,commandDigest:`sha256:${createHash('sha256').update(command).digest('hex')}`,status:'starting',startedAt:new Date().toISOString()};
    const entry:Owned={child,info,finished,resolveFinished,persistence:Promise.resolve()};this.entries.set(info.id,entry);
    let foregroundDone=false,timedOut=false,ready=false,resolveResult!:(result:{exitCode:number|null})=>void,rejectResult!:(error:Error)=>void;
    const result=new Promise<{exitCode:number|null}>((resolve,reject)=>{resolveResult=resolve;rejectResult=reject;});void result.catch(()=>undefined);
    const timeout=options.timeout===undefined?undefined:setTimeout(()=>{timedOut=true;void this.stop(info.id);},options.timeout*1000);
    const startup=setTimeout(()=>{rejectResult(new Error('Command process did not start'));void this.stop(info.id);},15000);
    const abort=()=>{void this.stop(info.id);};options.signal?.addEventListener('abort',abort,{once:true});
    const send=(value:Record<string,unknown>)=>{if(child.connected)child.send(value,()=>{});};
    child.on('message',(packet:unknown)=>{if(!packet||typeof packet!=='object')return;const message=packet as Record<string,unknown>;
      if(message.kind==='ready'){
        if(ready||message.pid!==child.pid){void this.stop(info.id);return;}ready=true;clearTimeout(startup);
        void this.changed(entry).then(()=>{if(options.signal?.aborted||this.disposed)return this.stop(info.id);send({kind:'run',command,cwd,env:options.env??process.env});}).catch(rejectResult);
      }else if(message.kind==='started'&&Number.isInteger(message.shellPid)){info.shellPid=Number(message.shellPid);info.status='running';void this.changed(entry);}
      else if(message.kind==='data'&&Buffer.isBuffer(message.data)){if(!foregroundDone)options.onData(message.data);}
      else if(message.kind==='settled'){
        foregroundDone=true;info.exitCode=typeof message.exitCode==='number'?message.exitCode:null;info.memberPids=Array.isArray(message.pids)?message.pids.filter((pid):pid is number=>Number.isInteger(pid)&&Number(pid)>0):[];
        info.status=message.inspectionFailed?'unknown':info.memberPids.length?'background':'running';
        void this.changed(entry).then(()=>{if(options.signal?.aborted)rejectResult(new Error('aborted'));else if(timedOut)rejectResult(new Error(`timeout:${options.timeout}`));else resolveResult({exitCode:info.exitCode??null});}).catch(rejectResult);
      }else if(message.kind==='members'&&Array.isArray(message.pids)){
        const pids=message.pids.filter((pid):pid is number=>Number.isInteger(pid)&&Number(pid)>0);if(JSON.stringify(pids)!==JSON.stringify(info.memberPids)){info.memberPids=pids;info.status=pids.length?'background':info.status;void this.changed(entry);}
      }else if(message.kind==='inspectionFailed'){info.status='unknown';void this.changed(entry);}
      else if(message.kind==='spawnFailed'){rejectResult(new Error('Command could not start'));}
    });
    child.once('error',()=>rejectResult(new Error('Command process failed')));
    child.once('exit',()=>{
      clearTimeout(startup);
      void (async()=>{
        const observed=await recoverAuxiliaryProcess(info);
        info.status=observed.status;info.memberPids=observed.memberPids;
        if(info.status==='exited')info.endedAt=new Date().toISOString();info.reason??=entry.stop?'stopped':foregroundDone&&child.exitCode===0?'completed':'unexpected';
        await this.changed(entry);
        if(!foregroundDone)rejectResult(new Error(timedOut?`timeout:${options.timeout}`:options.signal?.aborted?'aborted':'Command process exited before completion'));
      })().catch(error=>rejectResult(error instanceof Error?error:new Error('Could not confirm command shutdown'))).finally(()=>{if(info.status==='exited')this.entries.delete(info.id);resolveFinished();});
    });
    try{return await result;}finally{clearTimeout(startup);if(timeout)clearTimeout(timeout);options.signal?.removeEventListener('abort',abort);}
  };
  async stop(id:string):Promise<void>{
    const entry=this.entries.get(id);if(!entry)throw new Error('Auxiliary process does not belong to this member');if(entry.stop)return entry.stop;if(entry.child.exitCode!==null||entry.child.signalCode!==null){await entry.finished;if(entry.info.status==='unknown'){const observed=await recoverAuxiliaryProcess(entry.info);entry.info={...entry.info,...observed};await this.changed(entry);if(observed.status==='unknown')throw new Error('后台活动的控制进程已退出，仍有进程尚未确认结束；目录写入保持暂停');this.entries.delete(id);}return;}
    entry.info.reason='stopped';
    entry.stop=(async()=>{const timer=setTimeout(()=>{if(entry.child.exitCode===null&&entry.child.signalCode===null){try{process.kill(-entry.info.pid,'SIGKILL');}catch{entry.child.kill('SIGKILL');}}},2000);try{if(entry.child.connected)entry.child.send({kind:'stop'},()=>{});else entry.child.kill('SIGTERM');await entry.finished;}finally{clearTimeout(timer);}})();return entry.stop;
  }
  async stopAll():Promise<void>{await Promise.all([...this.entries.keys()].map(id=>this.stop(id)));}
  async dispose():Promise<void>{this.disposed=true;await this.stopAll();}
}

/** Recovery never sends a signal to a bare saved PID. A matching private helper
 * command and nonce are required; remaining unowned group members stay unknown. */
export async function recoverAuxiliaryProcess(info:AuxiliaryProcessInfo):Promise<AuxiliaryProcessInfo>{
  const inspect=async()=>{const {stdout}=await promisify(execFile)("/bin/ps",["-axo","pid=,pgid=,command="],{encoding:"utf8",timeout:3000,maxBuffer:4*1024*1024});return stdout.trim().split("\n").map(line=>{const match=line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);return match?{pid:Number(match[1]),group:Number(match[2]),command:match[3]!}:undefined;}).filter((item):item is {pid:number;group:number;command:string}=>!!item);};
  try{
    let entries=await inspect();const leader=entries.find(item=>item.pid===info.pid&&item.group===info.pid);
    if(leader?.command.endsWith(`/auxiliary-process-entry.js ${info.id}`)){
      process.kill(info.pid,"SIGTERM");
      for(let index=0;index<30;index++){await new Promise(resolve=>setTimeout(resolve,100));entries=await inspect();if(!entries.some(item=>item.group===info.pid))break;}
    }
    return entries.some(item=>item.group===info.pid)?{...info,status:"unknown",reason:"supervisor_restarted"}:{...info,status:"exited",memberPids:[],endedAt:new Date().toISOString(),reason:"supervisor_restarted"};
  }catch{return {...info,status:"unknown",reason:"supervisor_restarted"};}
}
