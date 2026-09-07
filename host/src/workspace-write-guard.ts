import {WorkspaceFileError,workspaceRootPath} from "./workspace-files.js";

export function workspacePathsOverlap(a:string,b:string):boolean {
  const normalize=(value:string)=>workspaceRootPath(value).normalize("NFD").toLowerCase().replace(/\/+$/u,"")+"/";
  a=normalize(a);b=normalize(b);return a.startsWith(b)||b.startsWith(a);
}

/** Hold a short reservation for an editor save. Runtime startup consults the
 * same reservation; an existing writer or opening runtime blocks the save. */
export class WorkspaceWriteGuard {
  private reservations=new Set<string>();
  constructor(private readonly writers:()=>Iterable<string>){}
  conflict(root:string):string|undefined{return [...this.reservations].some(path=>workspacePathsOverlap(path,root))?"file-save":undefined;}
  async run<T>(root:string,write:()=>Promise<T>):Promise<T>{
    if(this.conflict(root)||[...this.writers()].some(path=>workspacePathsOverlap(path,root)))throw new WorkspaceFileError("WORKSPACE_IN_USE","这个目录仍有工作正在准备或写入，编辑内容已保留，请稍后保存");
    this.reservations.add(root);
    try{return await write();}finally{this.reservations.delete(root);}
  }
}
