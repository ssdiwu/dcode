import {createHash} from "node:crypto";
import {lstat,realpath} from "node:fs/promises";
import {exportGeneratedImage,generatedImageArtifactMatches,readGeneratedImage} from "./generated-image-files.js";
import type {ImageExportContext,ImageExportDestination} from './image-generation-types.js';
import {basename,dirname,isAbsolute,join,relative,sep} from "node:path";
import {fileURLToPath} from "node:url";
import {unified} from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type {FoundationSnapshot,ProductStore} from "./product-store.js";
import {WorkspaceFiles,WorkspaceFileError,workspaceRootPath,safeWorkspaceRelativePath,type WorkspaceFileIdentity} from "./workspace-files.js";
import {redactCredentialText} from "./credential-material.js";
export interface WorkspaceSource {taskId?:string;projectId?:string;artifactId?:string}
export interface GitFile {path:string;status:string;previousPath?:string}
interface FileMentionToken {v:1;taskId:string;projectId:string;rootIdentity:string;path:string;fileDevice:string;fileInode:string}
const FILE_MENTION_PREFIX="dcode-file:";
const protectedRootParts=new Set([".git",".ssh",".gnupg",".aws",".pi",".dcode","auth.json","credentials.json","id_rsa","id_ed25519",".npmrc",".netrc",".pypirc",".git-credentials",".gitconfig"]);
const markdownParser=unified().use(remarkParse).use(remarkGfm);
interface MarkdownNode {type:string;url?:string;value?:string;identifier?:string;children?:MarkdownNode[];position?:{start:{offset?:number};end:{offset?:number}}}
function walkMarkdown(node:MarkdownNode,visit:(node:MarkdownNode)=>void):void {visit(node);for(const child of node.children??[])walkMarkdown(child,visit);}
function rootIdentity(root:string,identity:Pick<WorkspaceFileIdentity,"rootDevice"|"rootInode">):string{return createHash("sha256").update(`${root}\0${identity.rootDevice}\0${identity.rootInode}`).digest("hex");}
function fileMentionMarkdown(path:string,reference:string):string{return `[${path.replaceAll("\\","\\\\").replaceAll("[","\\[").replaceAll("]","\\]").replaceAll("`","\\`").replaceAll("&","\\&").replaceAll("<","\\<").replaceAll(">","\\>").replaceAll("*","\\*").replaceAll("_","\\_").replaceAll("~","\\~").replaceAll("|","\\|")}](${reference})`;}
function encodeHex(value:string):string{return Buffer.from(value,"utf8").toString("hex");}
function decodeHex(value:string):string {
  if(!value||value.length%2!==0||!/^[a-f0-9]+$/u.test(value))throw new WorkspaceFileError("FILE_REFERENCE_INVALID","文件引用格式无效");
  const decoded=Buffer.from(value,"hex").toString("utf8");
  if(encodeHex(decoded)!==value)throw new WorkspaceFileError("FILE_REFERENCE_INVALID","文件引用格式无效");
  return decoded;
}
function encodeFileMention(token:FileMentionToken):string {
  return `${FILE_MENTION_PREFIX}1.${encodeHex(token.taskId)}.${encodeHex(token.projectId)}.${token.rootIdentity}.${token.fileDevice}.${token.fileInode}.${encodeHex(token.path)}`;
}
function decodeFileMention(value:string):FileMentionToken {
  if(!value.startsWith(FILE_MENTION_PREFIX))throw new WorkspaceFileError("FILE_REFERENCE_INVALID","文件引用格式无效");
  if(value.length>4096)throw new WorkspaceFileError("FILE_REFERENCE_INVALID","文件引用格式无效");
  const fields=value.slice(FILE_MENTION_PREFIX.length).split(".");
  if(fields.length!==7||fields[0]!=="1"||!/^[a-f0-9]{64}$/u.test(fields[3]!)||!/^\d+$/u.test(fields[4]!)||!/^\d+$/u.test(fields[5]!))throw new WorkspaceFileError("FILE_REFERENCE_INVALID","文件引用格式无效");
  const token:FileMentionToken={v:1,taskId:decodeHex(fields[1]!),projectId:decodeHex(fields[2]!),rootIdentity:fields[3]!,fileDevice:fields[4]!,fileInode:fields[5]!,path:decodeHex(fields[6]!)};
  safeWorkspaceRelativePath(token.path);
  return token;
}
export class WorkspaceAccess {
  readonly files=new WorkspaceFiles();
  constructor(private readonly store:()=>Promise<ProductStore>,private readonly saveGuard:<T>(root:string,save:()=>Promise<T>)=>Promise<T>=async(_root,save)=>save()){}
  async imageExportContext(taskId:string,generationId:string,mimeType:string):Promise<ImageExportContext>{
    const snapshot=await (await this.store()).snapshot(),task=snapshot.tasks.find(task=>task.id===taskId);
    if(!task)throw new WorkspaceFileError('WORKSPACE_NOT_FOUND','IMAGE_TASK_MAIN_REQUIRED');
    const projectId=task.scope.kind==='project'?task.scope.projectId:undefined;
    const project=projectId?snapshot.projects.find(project=>project.id===projectId):undefined;
    if(!project)return {taskId,generationId,mimeType};
    const directory=await realpath(project.directory),identity=await lstat(directory);
    return {taskId,generationId,mimeType,project:{id:project.id,revision:project.revision,directory,device:String(identity.dev),inode:String(identity.ino)}};
  }
  async exportImage(destination:string,bytes:Buffer,context:ImageExportContext,expected:ImageExportDestination):Promise<{path:string}>{
    const directory=await realpath(dirname(destination));
    const store=await this.store();
    const snapshot=await store.snapshot(),task=snapshot.tasks.find(task=>task.id===context.taskId);
    const projectId=task?.scope.kind==='project'?task.scope.projectId:undefined;
    const project=projectId?snapshot.projects.find(project=>project.id===projectId):undefined;
    const within=(root:string)=>{const path=relative(root,directory);return path!=='..'&&!path.startsWith('..'+sep)&&!isAbsolute(path);};
    if(context.project&&(within(context.project.directory)||(project&&within(project.directory)))){
      const identity=await lstat(context.project.directory);
      if(!project||project.id!==context.project.id||project.revision!==context.project.revision||await realpath(project.directory)!==context.project.directory||String(identity.dev)!==context.project.device||String(identity.ino)!==context.project.inode)throw new WorkspaceFileError('FILE_SOURCE_CHANGED','IMAGE_EXPORT_PROJECT_CHANGED');
    }
    return this.saveGuard(directory,()=>exportGeneratedImage(bytes,join(directory,basename(destination)),store.layout.root,expected));
  }
  async root(source:WorkspaceSource):Promise<{directory:string;file?:string;title:string;image?:Awaited<ReturnType<typeof readGeneratedImage>>}> {
    const snapshot=await (await this.store()).snapshot();
    const task=source.taskId?snapshot.tasks.find(task=>task.id===source.taskId):undefined;
    if(source.taskId&&!task)throw new WorkspaceFileError("WORKSPACE_NOT_FOUND","任务不存在");
    if(source.artifactId){
      const artifact=snapshot.artifacts.find(artifact=>artifact.id===source.artifactId&&(!task||artifact.taskId===task.id));
      let verifiedImage:Awaited<ReturnType<typeof readGeneratedImage>>|undefined;
      if(artifact?.kind==='generated_image'){
        const record=(await this.store()).imageGenerations(artifact.taskId).find(record=>record.artifactId===artifact.id&&record.state==='succeeded');
        if(!record||!generatedImageArtifactMatches((await this.store()).layout,record,artifact))throw new WorkspaceFileError('FILE_SOURCE_CHANGED','IMAGE_RECORD_CHANGED');
        const image=await readGeneratedImage((await this.store()).layout,record);
        if(image.path!==artifact.managedPath)throw new WorkspaceFileError('FILE_SOURCE_CHANGED','IMAGE_RECORD_CHANGED');
        verifiedImage=image;
      }
      const path=artifact?.managedPath??artifact?.externalPath;
      if(!artifact||!path)throw new WorkspaceFileError("WORKSPACE_NOT_FOUND","产物没有可读取的文件");
      const canonical=workspaceRootPath(path);const metadata=await lstat(canonical);
      if(metadata.isSymbolicLink())throw new WorkspaceFileError("FILE_SCOPE","产物链接不能越过登记的文件边界");
      const worktree=snapshot.managedWorkerWorktrees.find(tree=>tree.artifactId===artifact.id);
      if(worktree)return {directory:workspaceRootPath(worktree.workspaceCwd),title:artifact.title};
      return metadata.isDirectory()?{directory:canonical,title:artifact.title}:{directory:dirname(canonical),file:basename(canonical),title:artifact.title,...(verifiedImage?{image:verifiedImage}:{})};
    }
    const projectId=source.projectId??(task?.scope.kind==="project"?task.scope.projectId:undefined);
    const project=projectId?snapshot.projects.find(project=>project.id===projectId):undefined;
    if(projectId&&!project)throw new WorkspaceFileError("WORKSPACE_NOT_FOUND","项目不存在");
    if(projectId&&snapshot.projectDirectoryChanges?.some(change=>change.projectId===projectId&&["prepared","unknown"].includes(change.status)))throw new WorkspaceFileError("WORKSPACE_BUSY","项目目录维护尚未完成，请在编辑项目中先完成核对。");
    if(task&&project&&!(task.scope.kind==="project"&&task.scope.projectId===project.id))throw new WorkspaceFileError("WORKSPACE_MISMATCH","项目与任务不一致");
    const directory=project?.directory??task?.cwd;
    if(!directory)throw new WorkspaceFileError("WORKSPACE_NOT_FOUND","请选择项目或任务目录");
    return {directory:workspaceRootPath(directory),title:project?.title??task!.title};
  }
  async handle(action:string,params:Record<string,unknown>):Promise<unknown>{
    if(action==="workspace.reference")return this.reference(params);
    if(action==="workspace.readReference")return this.readReference(params.taskId as string,params.reference as string);
    if(action==="workspace.fileSearch")return this.fileSearch(params.taskId as string,params.query as string,params.limit as number|undefined);
    const source=params.source as WorkspaceSource;const root=await this.root(source);
    const path=typeof params.path==="string"?params.path:root.file??"";
    if(root.file&&path!==root.file)throw new WorkspaceFileError("WORKSPACE_MISMATCH","该产物只允许读取登记的文件");
    if(root.file&&["workspace.git","workspace.diff","workspace.tree"].includes(action))throw new WorkspaceFileError("WORKSPACE_MISMATCH","这项产物只登记了单个文件，不能浏览其父目录或 Git 信息");
    switch(action){
      case "workspace.describe":return {root:root.directory,title:root.title,...(root.file?{file:root.file}:{})};
      case "workspace.tree":return {...await this.files.tree(root.directory,path),root:root.directory,title:root.title};
      case "workspace.read":return root.image?{relativePath:path,text:'',kind:'image',editable:false,digest:root.image.manifest.info.digest,bytes:root.image.bytes.length,dataUrl:`data:${root.image.manifest.info.mimeType};base64,${root.image.bytes.toString('base64')}`,absolutePath:root.image.path,root:root.directory}:{...await this.files.read(root.directory,path),absolutePath:join(root.directory,path),root:root.directory};
      case "workspace.preview":if(params.expectedRoot!==root.directory)throw new WorkspaceFileError("FILE_SOURCE_CHANGED","预览所属目录已改变");this.files.validatePreview(path,params.text as string);return {allowed:true,root:root.directory};
      case "workspace.asset":if(params.expectedRoot!==root.directory)throw new WorkspaceFileError("FILE_SOURCE_CHANGED","资源所属目录已改变");return root.image?{mimeType:root.image.manifest.info.mimeType,base64:root.image.bytes.toString('base64')}:this.files.asset(root.directory,path);
      case "workspace.save":if(params.expectedRoot!==root.directory)throw new WorkspaceFileError("FILE_SOURCE_CHANGED","项目目录已改变，原编辑内容已保留，请重新选择文件");return {...await this.saveGuard(root.directory,()=>this.files.save(root.directory,path,params.text as string,params.expectedDigest as string,params.overwrite===true)),absolutePath:join(root.directory,path),root:root.directory};
      case "workspace.git":return this.gitStatus(root.directory);
      case "workspace.diff":return this.diff(root.directory,path,params.staged===true);
      default:throw new WorkspaceFileError("WORKSPACE_ACTION","文件操作不可用");
    }
  }
  private assertSearchRoot(root:string):void {
    if(root.split("/").some(part=>protectedRootParts.has(part.normalize("NFC").toLowerCase())||/^\.env(?:\.|$)/iu.test(part)))throw new WorkspaceFileError("FILE_SCOPE","当前目录包含受保护的凭据位置，不能搜索");
  }
  async fileSearch(taskId:string,query:string,limit=30):Promise<{scopeRequired:boolean;entries:Array<{name:string;relativePath:string;reference:string;markdown:string}>;truncated:boolean}>{
    const snapshot=await (await this.store()).snapshot();
    const task=snapshot.tasks.find(item=>item.id===taskId);
    if(!task)throw new WorkspaceFileError("WORKSPACE_NOT_FOUND","任务不存在");
    if(task.scope.kind==="user")return {scopeRequired:true,entries:[],truncated:false};
    const projectId=task.scope.projectId;
    if(!query.trim())return {scopeRequired:false,entries:[],truncated:false};
    const root=await this.root({taskId});this.assertSearchRoot(root.directory);
    const result=await this.files.search(root.directory,query,limit);
    const rootKey=rootIdentity(root.directory,result);
    let omitted=false;
    const entries=result.entries.flatMap(entry=>{
      const token:FileMentionToken={v:1,taskId,projectId,rootIdentity:rootKey,path:entry.relativePath,fileDevice:entry.fileDevice,fileInode:entry.fileInode};
      const reference=encodeFileMention(token);
      if(reference.length>4096){omitted=true;return [];}
      return [{name:entry.name,relativePath:entry.relativePath,reference,markdown:fileMentionMarkdown(entry.relativePath,reference)}];
    });
    return {scopeRequired:false,entries,truncated:result.truncated||omitted};
  }
  private async validateFileMention(taskId:string,reference:string):Promise<{source:WorkspaceSource;path:string;kind:"file";root:string;identity:WorkspaceFileIdentity}> {
    const token=decodeFileMention(reference);
    if(token.taskId!==taskId)throw new WorkspaceFileError("FILE_SOURCE_CHANGED","文件引用不属于当前任务，请重新选择");
    const snapshot=await (await this.store()).snapshot();
    const task=snapshot.tasks.find(item=>item.id===taskId);
    if(!task||task.scope.kind!=="project"||task.scope.projectId!==token.projectId)throw new WorkspaceFileError("FILE_SOURCE_CHANGED","文件引用的项目范围已改变，请重新选择");
    const root=await this.root({taskId});this.assertSearchRoot(root.directory);
    let identity:WorkspaceFileIdentity;
    try{identity=await this.files.identity(root.directory,token.path);}catch{throw new WorkspaceFileError("FILE_SOURCE_CHANGED","引用文件已删除、移动或不可读取，请重新选择");}
    if(rootIdentity(root.directory,identity)!==token.rootIdentity||identity.fileDevice!==token.fileDevice||identity.fileInode!==token.fileInode)throw new WorkspaceFileError("FILE_SOURCE_CHANGED","引用文件或项目目录已改变，请重新选择");
    return {source:{taskId},path:token.path,kind:"file",root:root.directory,identity};
  }
  private async readReference(taskId:string,reference:string):Promise<unknown>{
    const selected=await this.validateFileMention(taskId,reference);
    let file;
    try{file=await this.files.readMatchingIdentity(selected.root,selected.path,selected.identity);}catch(error){
      if(error instanceof WorkspaceFileError&&["FILE_CONFLICT","FILE_UNAVAILABLE"].includes(error.code))throw new WorkspaceFileError("FILE_SOURCE_CHANGED","引用文件在打开前发生变化，请重新选择");
      throw error;
    }
    const current=await this.root({taskId});
    if(current.directory!==selected.root)throw new WorkspaceFileError("FILE_SOURCE_CHANGED","项目目录已改变，请重新选择文件");
    return {...file,source:selected.source,path:selected.path,root:selected.root,absolutePath:join(selected.root,selected.path)};
  }
  async validateFileMentions(taskId:string,message:string):Promise<void>{
    const tree=markdownParser.parse(message) as MarkdownNode;
    const definitions=new Map<string,string>();
    walkMarkdown(tree,node=>{if(node.type==="definition"&&typeof node.identifier==="string"&&typeof node.url==="string"&&!definitions.has(node.identifier))definitions.set(node.identifier,node.url);});
    const links:MarkdownNode[]=[];
    walkMarkdown(tree,node=>{
      const url=node.type==="link"||node.type==="image"?node.url:node.type==="linkReference"||node.type==="imageReference"?definitions.get(node.identifier??""):undefined;
      if(typeof url==="string"&&/^dcode-file:/iu.test(url))links.push({...node,url});
    });
    if(links.length>32)throw new WorkspaceFileError("FILE_REFERENCE_LIMIT","一条消息最多引用 32 个文件");
    for(const link of links){
      if(link.type!=="link")throw new WorkspaceFileError("FILE_REFERENCE_INVALID","文件引用格式已改变，请重新选择");
      const reference=link.url!,validated=await this.validateFileMention(taskId,reference);
      const canonical=fileMentionMarkdown(validated.path,reference);
      const start=link.position?.start.offset,end=link.position?.end.offset;
      if(start===undefined||end===undefined||message.slice(start,end)!==canonical)throw new WorkspaceFileError("FILE_REFERENCE_INVALID","文件引用显示路径已改变，请重新选择");
    }
    const hasUnlinkedMarker=(node:MarkdownNode,insideLink=false):boolean=>{
      if(node.type==="text"&&!insideLink&&/dcode-file:/iu.test(node.value??""))return true;
      if(node.type==="definition"&&/^dcode-file:/iu.test(node.url??""))return true;
      return (node.children??[]).some(child=>hasUnlinkedMarker(child,insideLink||node.type==="link"||node.type==="image"));
    };
    if(hasUnlinkedMarker(tree))throw new WorkspaceFileError("FILE_REFERENCE_INVALID","文件引用格式已改变，请重新选择");
  }
  private async git(root:string,args:string[]):Promise<string>{return this.files.git(root,args);}

  async gitStatus(root:string):Promise<{repository:boolean;branch:string|null;files:GitFile[];truncated?:boolean;hiddenCount?:number}>{
    root=workspaceRootPath(root);
    let repository:string;
    try{repository=(await this.git(root,["rev-parse","--show-toplevel"])).trim();}catch(error){if(error instanceof WorkspaceFileError&&error.code==="GIT_NOT_REPOSITORY")return {repository:false,branch:null,files:[]};throw error;}
    const within=relative(workspaceRootPath(repository),root);
    if(within===".."||within.startsWith("../")||isAbsolute(within))throw new WorkspaceFileError("FILE_SCOPE","Git 工作目录不属于登记的项目范围");
    const branch=(await this.git(root,["rev-parse","--abbrev-ref","HEAD"]).catch(()=>"")).trim()||null;
    const entries=(await this.git(root,["status","--porcelain=v1","-z","--untracked-files=normal"])).split("\0");const files:GitFile[]=[];let hiddenCount=0;
    for(let index=0;index<entries.length;index++){
      const entry=entries[index]!;if(!entry)continue;
      const status=entry.slice(0,2),absolute=join(repository,entry.slice(3)),path=relative(root,absolute);
      const previous=/[RC]/u.test(status)?entries[++index]:undefined;
      if(!path||path===".."||path.startsWith("../")||isAbsolute(path))continue;
      const previousPath=previous?relative(root,join(repository,previous)):undefined;
      try{safeWorkspaceRelativePath(path);if(previousPath!==undefined)safeWorkspaceRelativePath(previousPath);}catch{hiddenCount++;continue;}
      files.push({path,status,...(previousPath?{previousPath}:{})});
    }
    return {repository:true,branch,files:files.slice(0,1000),truncated:files.length>1000,hiddenCount};
  }
  async diff(root:string,path:string,staged:boolean):Promise<{path:string;staged:boolean;diff:string;digest:string;absolutePath:string}>{
    root=workspaceRootPath(root);safeWorkspaceRelativePath(path);
    if(!path||isAbsolute(path)||path.split(/[\\/]/u).includes("..")||/[\u0000-\u001f]/u.test(path))throw new WorkspaceFileError("FILE_SCOPE","文件不在项目目录内");
    const status=await this.gitStatus(root);const entry=status.files.find(file=>file.path===path);
    if(!entry)throw new WorkspaceFileError("GIT_FILE_UNAVAILABLE","当前没有这个文件的改动");
    let output:string;
    if(entry.status==="??"){
      const file=await this.files.read(root,path);const lines=file.text?file.text.replace(/\n$/u,"").split("\n"):[];
      output=`--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(line=>`+${line}`).join("\n")}`;
    }else output=await this.git(root,["diff","--no-color","--no-ext-diff","--no-textconv","--unified=3",...(staged?["--cached"]:[]),"--",path]);
    if(redactCredentialText(output).redacted)throw new WorkspaceFileError("FILE_CREDENTIAL_MATERIAL","差异包含凭据内容，预览已隐藏");
    return {path,staged,diff:output,absolutePath:join(root,path),digest:`sha256:${createHash("sha256").update(output).digest("hex")}`};
  }
  private async reference(params:Record<string,unknown>):Promise<unknown>{
    if(typeof params.reference==="string"&&params.reference.startsWith(FILE_MENTION_PREFIX)){
      if(typeof params.taskId!=="string")throw new WorkspaceFileError("FILE_SOURCE_CHANGED","文件引用需要当前任务");
      const {source,path,kind}=await this.validateFileMention(params.taskId,params.reference);
      return {source,path,kind};
    }
    const snapshot=await (await this.store()).snapshot();
    const roots:Array<{source:WorkspaceSource;root:string;file?:string}>=[];
    if(params.source){
      const source=params.source as WorkspaceSource,root=await this.root(source);
      roots.push({source,root:root.directory,...(root.file?{file:root.file}:{})});
    }else{
      const task=snapshot.tasks.find(task=>task.id===params.taskId);
      if(!task)throw new WorkspaceFileError("WORKSPACE_NOT_FOUND","任务不存在");
      const root=await this.root({taskId:task.id});roots.push({source:{taskId:task.id},root:root.directory});
      for(const worktree of snapshot.managedWorkerWorktrees.filter(tree=>tree.taskId===task.id&&tree.state==="ready"))roots.push({source:{taskId:task.id,artifactId:worktree.artifactId},root:workspaceRootPath(worktree.workspaceCwd)});
      for(const artifact of snapshot.artifacts.filter(item=>item.taskId===task.id&&item.kind!=="attachment"&&!snapshot.managedWorkerWorktrees.some(tree=>tree.artifactId===item.id))){
        if(!artifact.managedPath&&!artifact.externalPath)continue;
        try{const source={taskId:task.id,artifactId:artifact.id};const root=await this.root(source);roots.push({source,root:root.directory,...(root.file?{file:root.file}:{})});}catch{/* Unavailable artifacts do not enlarge the allowed roots. */}
      }
    }
    let reference=String(params.reference);let line:number|undefined;
    const match=reference.match(/(?::(\d+)|#L?(\d+))$/u);if(match){line=Number(match[1]??match[2]);reference=reference.slice(0,match.index);}
    if(reference.startsWith("file:")){const url=new URL(reference);if(url.hostname&&url.hostname!=="localhost")throw new WorkspaceFileError("FILE_SCOPE","不支持外部文件地址");reference=fileURLToPath(url);}else reference=decodeURIComponent(reference);
    const absolute=isAbsolute(reference)?workspaceRootPath(reference):join(roots[0]!.root,reference);
    const found=roots.sort((a,b)=>b.root.length-a.root.length).find(item=>{const path=relative(item.root,absolute);return (!item.file||path===item.file)&&!path.startsWith("../")&&path!==".."&&!isAbsolute(path);});
    if(!found)throw new WorkspaceFileError("FILE_SCOPE","引用不在当前任务可查看的目录内");
    const path=relative(found.root,absolute);
    const kind=await this.files.kind(found.root,path);
    return {source:found.source,path,kind,...(Number.isSafeInteger(line)&&line!>0?{line}:{})};
  }
}
