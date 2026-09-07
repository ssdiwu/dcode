import {createHash} from "node:crypto";
import {lstat} from "node:fs/promises";
import {basename,dirname,isAbsolute,join,relative} from "node:path";
import {fileURLToPath} from "node:url";
import type {FoundationSnapshot,ProductStore} from "./product-store.js";
import {WorkspaceFiles,WorkspaceFileError,workspaceRootPath,safeWorkspaceRelativePath} from "./workspace-files.js";
import {redactCredentialText} from "./credential-material.js";
export interface WorkspaceSource {taskId?:string;projectId?:string;artifactId?:string}
export interface GitFile {path:string;status:string;previousPath?:string}
export class WorkspaceAccess {
  readonly files=new WorkspaceFiles();
  constructor(private readonly store:()=>Promise<ProductStore>,private readonly saveGuard:<T>(root:string,save:()=>Promise<T>)=>Promise<T>=async(_root,save)=>save()){}
  async root(source:WorkspaceSource):Promise<{directory:string;file?:string;title:string}> {
    const snapshot=await (await this.store()).snapshot();
    const task=source.taskId?snapshot.tasks.find(task=>task.id===source.taskId):undefined;
    if(source.taskId&&!task)throw new WorkspaceFileError("WORKSPACE_NOT_FOUND","任务不存在");
    if(source.artifactId){
      const artifact=snapshot.artifacts.find(artifact=>artifact.id===source.artifactId&&(!task||artifact.taskId===task.id));
      const path=artifact?.managedPath??artifact?.externalPath;
      if(!artifact||!path)throw new WorkspaceFileError("WORKSPACE_NOT_FOUND","产物没有可读取的文件");
      const canonical=workspaceRootPath(path);const metadata=await lstat(canonical);
      if(metadata.isSymbolicLink())throw new WorkspaceFileError("FILE_SCOPE","产物链接不能越过登记的文件边界");
      const worktree=snapshot.managedWorkerWorktrees.find(tree=>tree.artifactId===artifact.id);
      if(worktree)return {directory:workspaceRootPath(worktree.workspaceCwd),title:artifact.title};
      return metadata.isDirectory()?{directory:canonical,title:artifact.title}:{directory:dirname(canonical),file:basename(canonical),title:artifact.title};
    }
    const projectId=source.projectId??(task?.scope.kind==="project"?task.scope.projectId:undefined);
    const project=projectId?snapshot.projects.find(project=>project.id===projectId):undefined;
    if(projectId&&!project)throw new WorkspaceFileError("WORKSPACE_NOT_FOUND","项目不存在");
    if(task&&project&&!(task.scope.kind==="project"&&task.scope.projectId===project.id))throw new WorkspaceFileError("WORKSPACE_MISMATCH","项目与任务不一致");
    const directory=project?.directory??task?.cwd;
    if(!directory)throw new WorkspaceFileError("WORKSPACE_NOT_FOUND","请选择项目或任务目录");
    return {directory:workspaceRootPath(directory),title:project?.title??task!.title};
  }
  async handle(action:string,params:Record<string,unknown>):Promise<unknown>{
    if(action==="workspace.reference")return this.reference(params);
    const source=params.source as WorkspaceSource;const root=await this.root(source);
    const path=typeof params.path==="string"?params.path:root.file??"";
    if(root.file&&path!==root.file)throw new WorkspaceFileError("WORKSPACE_MISMATCH","该产物只允许读取登记的文件");
    if(root.file&&["workspace.git","workspace.diff","workspace.tree"].includes(action))throw new WorkspaceFileError("WORKSPACE_MISMATCH","这项产物只登记了单个文件，不能浏览其父目录或 Git 信息");
    switch(action){
      case "workspace.describe":return {root:root.directory,title:root.title,...(root.file?{file:root.file}:{})};
      case "workspace.tree":return {...await this.files.tree(root.directory,path),root:root.directory,title:root.title};
      case "workspace.read":return {...await this.files.read(root.directory,path),absolutePath:join(root.directory,path),root:root.directory};
      case "workspace.preview":if(params.expectedRoot!==root.directory)throw new WorkspaceFileError("FILE_SOURCE_CHANGED","预览所属目录已改变");this.files.validatePreview(path,params.text as string);return {allowed:true,root:root.directory};
      case "workspace.asset":if(params.expectedRoot!==root.directory)throw new WorkspaceFileError("FILE_SOURCE_CHANGED","资源所属目录已改变");return this.files.asset(root.directory,path);
      case "workspace.save":if(params.expectedRoot!==root.directory)throw new WorkspaceFileError("FILE_SOURCE_CHANGED","项目目录已改变，原编辑内容已保留，请重新选择文件");return {...await this.saveGuard(root.directory,()=>this.files.save(root.directory,path,params.text as string,params.expectedDigest as string,params.overwrite===true)),absolutePath:join(root.directory,path),root:root.directory};
      case "workspace.git":return this.gitStatus(root.directory);
      case "workspace.diff":return this.diff(root.directory,path,params.staged===true);
      default:throw new WorkspaceFileError("WORKSPACE_ACTION","文件操作不可用");
    }
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
    const snapshot=await (await this.store()).snapshot();const task=snapshot.tasks.find(task=>task.id===params.taskId);
    if(!task)throw new WorkspaceFileError("WORKSPACE_NOT_FOUND","任务不存在");
    let reference=String(params.reference);let line:number|undefined;
    const match=reference.match(/(?::(\d+)|#L?(\d+))$/u);if(match){line=Number(match[1]??match[2]);reference=reference.slice(0,match.index);}
    if(reference.startsWith("file:")){const url=new URL(reference);if(url.hostname&&url.hostname!=="localhost")throw new WorkspaceFileError("FILE_SCOPE","不支持外部文件地址");reference=fileURLToPath(url);}else reference=decodeURIComponent(reference);
    const roots:Array<{source:WorkspaceSource;root:string;file?:string}>=[{source:{taskId:task.id},root:workspaceRootPath(task.cwd)}];
    for(const worktree of snapshot.managedWorkerWorktrees.filter(tree=>tree.taskId===task.id&&tree.state==="ready"))roots.push({source:{taskId:task.id,artifactId:worktree.artifactId},root:workspaceRootPath(worktree.workspaceCwd)});
    for(const artifact of snapshot.artifacts.filter(item=>item.taskId===task.id&&item.kind!=="attachment"&&!snapshot.managedWorkerWorktrees.some(tree=>tree.artifactId===item.id))){
      if(!artifact.managedPath&&!artifact.externalPath)continue;
      try{const source={taskId:task.id,artifactId:artifact.id};const root=await this.root(source);roots.push({source,root:root.directory,...(root.file?{file:root.file}:{})});}catch{/* Unavailable artifacts do not enlarge the allowed roots. */}
    }
    const absolute=isAbsolute(reference)?workspaceRootPath(reference):join(roots[0]!.root,reference);
    const found=roots.sort((a,b)=>b.root.length-a.root.length).find(item=>{const path=relative(item.root,absolute);return path&&(!item.file||path===item.file)&&!path.startsWith("../")&&path!==".."&&!isAbsolute(path);});
    if(!found)throw new WorkspaceFileError("FILE_SCOPE","引用不在当前任务可查看的目录内");
    return {source:found.source,path:relative(found.root,absolute),...(Number.isSafeInteger(line)&&line!>0?{line}:{})};
  }
}
