import {createHash} from "node:crypto";
import {constants} from "node:fs";
import {open} from "node:fs/promises";
import {lstat,readdir,realpath} from 'node:fs/promises';
import {isAbsolute,relative,resolve} from 'node:path';
import {WorkspaceFiles} from './workspace-files.js';
export interface DirectoryIdentity {device:string;inode:string}
export interface ProjectBindingCandidate {sessionId:string;previousAdapterId:string;previousBindingRevision:number;adapterSessionId:string;adapterSessionPath:string;digest:string}
export interface ProjectDirectoryChange {
  id:string;projectId:string;expectedProjectRevision:number;requestedDirectory:string;title:string;
  sourceDirectory:string;targetDirectory:string;moveFiles:boolean;
  sourceIdentity:DirectoryIdentity;targetIdentity:DirectoryIdentity;bindings:ProjectBindingCandidate[];
  status:'prepared'|'committed'|'cancelled'|'unknown';error?:string;
}
export async function directoryIdentity(path:string):Promise<DirectoryIdentity>{const value=await lstat(path,{bigint:true});if(!value.isDirectory()||value.isSymbolicLink())throw new Error('目录不可用或已变成符号链接');return {device:String(value.dev),inode:String(value.ino)};}
const same=(a:DirectoryIdentity,b:DirectoryIdentity)=>a.device===b.device&&a.inode===b.inode;
export async function directoryPosition(change:ProjectDirectoryChange):Promise<'original'|'swapped'|'unknown'>{
  try{const a=await directoryIdentity(change.sourceDirectory),b=await directoryIdentity(change.targetDirectory);if(same(a,change.sourceIdentity)&&same(b,change.targetIdentity))return 'original';if(same(a,change.targetIdentity)&&same(b,change.sourceIdentity))return 'swapped';}catch{/* Unknown paths cannot be moved or overwritten during recovery. */}return 'unknown';
}
export async function swapProjectDirectories(change:ProjectDirectoryChange,undo=false):Promise<void>{
  const expected=undo?'swapped':'original';if(await directoryPosition(change)!==expected)throw new Error('目录已改变，不能继续移动');
  const files=new WorkspaceFiles();
  try{await files.swapDirectories(change.sourceDirectory,change.targetDirectory,undo?change.targetIdentity:change.sourceIdentity,undo?change.sourceIdentity:change.targetIdentity,!undo);}catch(error){if(await directoryPosition(change)!==(undo?'original':'swapped'))throw error;}
  if(await directoryPosition(change)!==(undo?'original':'swapped'))throw new Error('目录移动结果未能确认');
}
export async function directoryChangeTargets(source:string,target:string,moveFiles:boolean):Promise<{sourceDirectory:string;targetDirectory:string;sourceIdentity:DirectoryIdentity;targetIdentity:DirectoryIdentity}>{
  const sourceDirectory=moveFiles?await realpath(source):resolve(source),targetDirectory=await realpath(target);
  const sourceIdentity=moveFiles?await directoryIdentity(sourceDirectory):await directoryIdentity(sourceDirectory).catch(()=>({device:"unavailable",inode:"unavailable"})),targetIdentity=await directoryIdentity(targetDirectory);
  if(sourceDirectory===targetDirectory)throw new Error('请选择不同的目录');
  const inside=(root:string,path:string)=>{const value=relative(root,path);return value===''||value!== '..'&&!value.startsWith('../')&&!isAbsolute(value);};
  if(moveFiles&&(inside(sourceDirectory,targetDirectory)||inside(targetDirectory,sourceDirectory)))throw new Error('原目录与目标目录不能互相包含');
  if(moveFiles){if(sourceIdentity.device!==targetIdentity.device)throw new Error('项目文件只能在同一磁盘内直接移动；可先在系统中完成跨磁盘迁移，再只更换项目目录');if((await readdir(targetDirectory)).length)throw new Error('移动项目文件需要一个空的目标目录，不会合并或覆盖已有内容');}
  return {sourceDirectory,targetDirectory,sourceIdentity,targetIdentity};
}

export async function privateSessionDigest(path:string):Promise<string>{
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const before=await file.stat({bigint:true});if(!before.isFile()||before.size>256n*1024n*1024n)throw new Error("会话文件过大或不可用");const hash=createHash("sha256");for await(const chunk of file.createReadStream({autoClose:false}))hash.update(chunk);const after=await file.stat({bigint:true});if(before.size!==after.size||before.mtimeNs!==after.mtimeNs)throw new Error("会话正在变化");return `sha256:${hash.digest("hex")}`;}finally{await file.close();}
}
