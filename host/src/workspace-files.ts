import {createHash} from "node:crypto";
import {spawn} from "node:child_process";
import {fileURLToPath} from "node:url";
import {isAbsolute,join,relative,extname,resolve} from "node:path";
import {redactCredentialText} from "./credential-material.js";

export interface WorkspaceFile {relativePath:string;text:string;digest:string;bytes:number;editable:boolean;kind:"markdown"|"html"|"source"|"image";dataUrl?:string}
export interface WorkspaceTree {relativePath:string;entries:Array<{name:string;relativePath:string;kind:"directory"|"file"|"link"|"other"}>;truncated:boolean}
export class WorkspaceFileError extends Error {constructor(readonly code:string,message:string){super(message);}}
// macOS system aliases are fixed platform paths. Never resolve a changed
// project/saved-root symlink into a newly authorized directory.
export function workspaceRootPath(root:string):string{return resolve(root).replace(/^\/(var|tmp|etc)(?=\/|$)/u,"/private/$1");}
const denied=new Set([".git",".ssh",".gnupg",".aws",".pi",".dcode","auth.json","credentials.json","id_rsa","id_ed25519",".npmrc",".netrc",".pypirc",".git-credentials",".gitconfig"]);
export function safeWorkspaceRelativePath(value:string,rootAllowed=false):string {
  if(typeof value!=="string"||value.length>4096||isAbsolute(value)||/[\u0000-\u001f]/u.test(value)||value.split(/[\\/]/).some(part=>part===".."||denied.has(part.normalize("NFC").toLowerCase())||/^\.env(?:\.|$)/iu.test(part))||redactCredentialText(value).redacted)throw new WorkspaceFileError("FILE_SCOPE","此路径不能通过项目预览访问");
  if(!value&&!rootAllowed)throw new WorkspaceFileError("FILE_SCOPE","请选择一个文件");
  return value;
}
export class WorkspaceFiles {
  private readonly writes=new Map<string,Promise<unknown>>();
  private active=0;
  private waiting:Array<()=>void>=[];
  constructor(private readonly helper=fileURLToPath(new URL("../bin/dcode-files",import.meta.url))){}
  private async call(root:string,relativePath:string,action:string,extra:Record<string,unknown>={}):Promise<Record<string,unknown>> {
    const canonical=workspaceRootPath(root);safeWorkspaceRelativePath(relativePath,action==="tree"||action==="git"||action==="swap-directories");
    const path=join(canonical,relativePath);
    if(relative(canonical,path).startsWith("..")||isAbsolute(relative(canonical,path)))throw new WorkspaceFileError("FILE_SCOPE","文件不在项目目录内");
    if(this.active>=4)await new Promise<void>(resolve=>this.waiting.push(resolve));
    else this.active++;
    return new Promise<Record<string,unknown>>((resolve,reject)=>{
      const child=spawn(this.helper,[],{stdio:["pipe","pipe","ignore"],env:{PATH:process.env.PATH,LANG:process.env.LANG}});
      const chunks:Buffer[]=[];let bytes=0,settled=false;
      const finish=(error?:Error,result?:Record<string,unknown>)=>{if(settled)return;settled=true;clearTimeout(timer);if(error)reject(error);else resolve(result!);};
      const timer=setTimeout(()=>{child.kill("SIGKILL");finish(new WorkspaceFileError("FILE_TIMEOUT","读取或保存未能及时完成"));},15000);
      child.on("error",()=>finish(new WorkspaceFileError("FILE_HELPER_UNAVAILABLE","文件服务尚未构建或无法启动")));
      child.stdin.on("error",()=>{});
      child.stdout.on("data",(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>13*1024*1024){child.kill("SIGKILL");finish(new WorkspaceFileError("FILE_TOO_LARGE","文件响应超过上限"));}else chunks.push(chunk);});
      child.on("close",code=>{
        if(code!==0){finish(new WorkspaceFileError("FILE_HELPER_FAILED","文件服务未能完成操作"));return;}
        try{const result=JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string,unknown>;if(result.ok!==true)finish(new WorkspaceFileError(String(result.code??"FILE_UNAVAILABLE"),String(result.message??"文件不可用")));else finish(undefined,result);}catch{finish(new WorkspaceFileError("FILE_HELPER_FAILED","文件服务返回了无效结果"));}
      });
      child.stdin.end(JSON.stringify({action,root:canonical,path,...extra}));
    }).finally(()=>{const next=this.waiting.shift();if(next)next();else this.active--;});
  }
  async git(root:string,args:string[]):Promise<string>{const result=await this.call(root,"","git",{arguments:args});return String(result.stdout??"");}
  async swapDirectories(sourceRoot:string,targetRoot:string,source:{device:string;inode:string},target:{device:string;inode:string},requireEmptyTarget=true):Promise<void>{
    await this.call(sourceRoot,"","swap-directories",{targetRoot:workspaceRootPath(targetRoot),sourceDevice:source.device,sourceInode:source.inode,targetDevice:target.device,targetInode:target.inode,requireEmptyTarget});
  }
  private snapshot(path:string,result:Record<string,unknown>):WorkspaceFile {
    if(typeof result.text!=="string"||typeof result.digest!=="string")throw new WorkspaceFileError("FILE_UNAVAILABLE","文件正文不可用");
    if(redactCredentialText(result.text).redacted)throw new WorkspaceFileError("FILE_CREDENTIAL_MATERIAL","文件包含凭据内容，预览已隐藏");
    const extension=extname(path).toLowerCase();const kind=extension===".md"?"markdown":[".html",".htm"].includes(extension)?"html":"source";
    return {relativePath:path,text:result.text,digest:`sha256:${result.digest}`,bytes:Number(result.bytes),editable:kind!=="source",kind};
  }
  validatePreview(path:string,text:string):void {
    safeWorkspaceRelativePath(path);
    if(![".html",".htm"].includes(extname(path).toLowerCase())||typeof text!=="string"||Buffer.byteLength(text)>2*1024*1024||redactCredentialText(text).redacted)throw new WorkspaceFileError("HTML_CONTENT_REJECTED","HTML 预览内容不可用或包含凭据");
  }
  async tree(root:string,path=""):Promise<WorkspaceTree>{
    const result=await this.call(root,path,"tree");const entries=(result.entries as Array<{name:string;kind:WorkspaceTree["entries"][number]["kind"]}>).filter(entry=>{try{safeWorkspaceRelativePath(join(path,entry.name));return true;}catch{return false;}}).map(entry=>({...entry,relativePath:join(path,entry.name)})).sort((a,b)=>(a.kind==="directory"?0:1)-(b.kind==="directory"?0:1)||a.name.localeCompare(b.name));
    return {relativePath:path,entries,truncated:result.truncated===true};
  }
  async read(root:string,path:string):Promise<WorkspaceFile>{
    if([".png",".jpg",".jpeg",".gif",".webp"].includes(extname(path).toLowerCase())){const asset=await this.asset(root,path);const bytes=Buffer.from(asset.base64,"base64");return {relativePath:path,text:"",kind:"image",editable:false,bytes:bytes.length,digest:`sha256:${createHash("sha256").update(bytes).digest("hex")}`,dataUrl:`data:${asset.mimeType};base64,${asset.base64}`};}
    return this.snapshot(path,await this.call(root,path,"read"));
  }
  async asset(root:string,path:string):Promise<{base64:string;mimeType:string}>{
    const result=await this.call(root,path,"asset");const base64=String(result.base64??"");
    const mime:Record<string,string>={".css":"text/css",".js":"text/javascript",".mjs":"text/javascript",".json":"application/json",".html":"text/html",".htm":"text/html",".svg":"image/svg+xml",".png":"image/png",".jpg":"image/jpeg",".jpeg":"image/jpeg",".gif":"image/gif",".webp":"image/webp",".woff":"font/woff",".woff2":"font/woff2",".ttf":"font/ttf",".otf":"font/otf",".mp4":"video/mp4",".webm":"video/webm",".mp3":"audio/mpeg",".wav":"audio/wav",".pdf":"application/pdf"};
    const mimeType=mime[extname(path).toLowerCase()]??"application/octet-stream";
    if(redactCredentialText(Buffer.from(base64,"base64").toString("utf8")).redacted)throw new WorkspaceFileError("FILE_CREDENTIAL_MATERIAL","本机资源包含凭据内容");
    return {base64,mimeType};
  }
  async save(root:string,path:string,text:string,expectedDigest:string,overwrite=false):Promise<WorkspaceFile>{
    if(![".md",".html",".htm"].includes(extname(path).toLowerCase()))throw new WorkspaceFileError("FILE_READ_ONLY","只支持编辑 Markdown 和 HTML");
    if(typeof text!=="string"||Buffer.byteLength(text)>2*1024*1024||redactCredentialText(text).redacted)throw new WorkspaceFileError("FILE_CONTENT_REJECTED","正文过大或包含凭据内容");
    if(!/^sha256:[a-f0-9]{64}$/u.test(expectedDigest))throw new WorkspaceFileError("FILE_VERSION_REQUIRED","保存需要原文件版本");
    const key=join(workspaceRootPath(root),safeWorkspaceRelativePath(path)).normalize("NFD").toLowerCase();
    const operation=async()=>this.snapshot(path,await this.call(root,path,"save",{text,expectedDigest:expectedDigest.slice(7),overwrite}));
    const pending=(this.writes.get(key)??Promise.resolve()).then(operation,operation);this.writes.set(key,pending);
    try{return await pending;}finally{if(this.writes.get(key)===pending)this.writes.delete(key);}
  }
}
