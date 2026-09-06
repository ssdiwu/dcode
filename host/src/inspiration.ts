import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, lstat, realpath, unlink } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { prepareManagedDCodeDirectory, type DCodeDataRootLayout } from "./dcode-data-root.js";
import { publishNewFileAtomically } from "./atomic-file.js";
import { redactCredentialText } from "./credential-material.js";

export const INSPIRATION_KEY = "knowledge.inspiration";
export type IdeaKind = "text" | "image" | "link" | "video";
export interface IdeaMedia { fileName:string; name:string; mimeType:string; bytes:number; digest:string }
export interface IdeaNode {
  id:string; kind:IdeaKind; title:string; markdown:string; url?:string; tags:string[];
  media?:IdeaMedia; sourceTaskId?:string; revision:number; createdAt:string; updatedAt:string; archived:boolean;
}
export interface IdeaPosition { x:number; y:number }
export interface IdeaDraft { id:string;kind:IdeaKind;title:string;markdown:string;url:string;tags:string;expectedNodeRevision:number;mediaPath?:string;sourceTaskId?:string }
export interface InspirationDocument {
  version:1; nodes:IdeaNode[]; positions:Record<string,IdeaPosition>;
  edges:{from:string;to:string}[]; groups:{id:string;title:string;nodeIds:string[]}[];
  viewport:{x:number;y:number;zoom:number};
  draft?:IdeaDraft|null;
}
export type InspirationView = InspirationDocument & { revision:number; documentRoot:string };
export type InspirationOperation =
  | {kind:"save";node:Pick<IdeaNode,"id"|"kind"|"title"|"markdown"> & {url?:string;tags?:string[];sourceTaskId?:string};expectedNodeRevision:number;position?:IdeaPosition;mediaPath?:string}
  | {kind:"archive";nodeId:string;archived:boolean}
  | {kind:"move";positions:Record<string,IdeaPosition>}
  | {kind:"connect"|"disconnect";from:string;to:string}
  | {kind:"group";id:string;title:string;nodeIds:string[]}
  | {kind:"ungroup";id:string}
  | {kind:"draft";draft:IdeaDraft|null}
  | {kind:"viewport";viewport:InspirationDocument["viewport"]};
export class InspirationError extends Error { constructor(readonly code:string,message:string){super(message);} }
export const inspirationRoot = (layout:DCodeDataRootLayout) => join(layout.root,"knowledge","inspiration");
export const emptyInspiration = ():InspirationDocument => ({version:1,nodes:[],positions:{},edges:[],groups:[],viewport:{x:0,y:0,zoom:1}});
export function ideaId(value:unknown):string {
  if(typeof value!=="string"||!/^idea-[a-f0-9-]{36}$/.test(value))throw new InspirationError("INVALID_IDEA","灵感标识无效。");
  return value;
}
const text=(value:unknown,maximum:number,empty=false):string=>{
  if(typeof value!=="string"||value.length>maximum||(!empty&&!value.trim()))throw new InspirationError("INVALID_IDEA","请检查灵感的标题或内容长度。");
  if(redactCredentialText(value).redacted)throw new InspirationError("CREDENTIAL_MATERIAL_REJECTED","内容包含疑似凭据，请移除后保存。");
  return value;
};
function position(value:IdeaPosition):IdeaPosition {
  if(!value||![value.x,value.y].every(v=>Number.isFinite(v)&&Math.abs(v)<=1_000_000))throw new InspirationError("INVALID_IDEA","画布位置无效。");
  return {x:value.x,y:value.y};
}
export function changeInspiration(current:InspirationDocument,operation:InspirationOperation,now:string,media?:IdeaMedia):InspirationDocument {
  const next=structuredClone(current);
  const node=(id:string)=>{ideaId(id);const found=next.nodes.find(n=>n.id===id);if(!found)throw new InspirationError("IDEA_NOT_FOUND","灵感不存在，请刷新画布。");return found;};
  switch(operation.kind){
    case "save": {
      const draft=operation.node;ideaId(draft?.id);
      const previous=next.nodes.find(n=>n.id===draft.id);
      if(operation.expectedNodeRevision!==(previous?.revision??0))throw new InspirationError("IDEA_REVISION_CONFLICT","这条灵感已更新，草稿仍保留，请重新载入后合并修改。");
      if(!["text","image","link","video"].includes(draft.kind)||previous&&previous.kind!==draft.kind)throw new InspirationError("INVALID_IDEA","已有灵感不能更换类型。");
      const title=text(draft.title,200).trim(),markdown=text(draft.markdown,50_000,true);
      let url:string|undefined;
      if(draft.url?.trim()){
        const parsed=new URL(text(draft.url,4096).trim());
        if(!["http:","https:"].includes(parsed.protocol)||parsed.username||parsed.password)throw new InspirationError("INVALID_IDEA","链接需要是 HTTP 或 HTTPS 地址，且不能包含凭据。");
        url=parsed.href;
      }
      if(draft.kind==="link"&&!url)throw new InspirationError("INVALID_IDEA","请填写链接地址。");
      const selectedMedia=media??previous?.media;
      if(draft.kind==="image"&&!selectedMedia)throw new InspirationError("INVALID_IDEA","请添加图片。");
      if(draft.kind==="video"&&!selectedMedia&&!url)throw new InspirationError("INVALID_IDEA","请添加视频文件或视频链接。");
      if(selectedMedia&&!(draft.kind==="image"?selectedMedia.mimeType.startsWith("image/"):draft.kind==="video"?selectedMedia.mimeType.startsWith("video/"):false))throw new InspirationError("INVALID_IDEA","媒体类型与灵感类型不符。");
      const tags=(draft.tags??[]).map(tag=>text(tag,40).trim());
      if(tags.length>12)throw new InspirationError("INVALID_IDEA","标签最多 12 个。");
      const updated:IdeaNode={id:draft.id,kind:draft.kind,title,markdown,tags:[...new Set(tags)],revision:(previous?.revision??0)+1,createdAt:previous?.createdAt??now,updatedAt:now,archived:previous?.archived??false,...(url?{url}:{}),...(selectedMedia?{media:selectedMedia}:{}),...(draft.sourceTaskId?{sourceTaskId:draft.sourceTaskId}:previous?.sourceTaskId?{sourceTaskId:previous.sourceTaskId}:{})};
      if(previous)next.nodes[next.nodes.indexOf(previous)]=updated;else {if(next.nodes.length>=200)throw new InspirationError("IDEA_LIMIT","当前画布最多保存 200 条灵感。");next.nodes.push(updated);next.positions[draft.id]=operation.position?position(operation.position):{x:80+(next.nodes.length-1)%4*270,y:80+Math.floor((next.nodes.length-1)/4)*220};}
      next.draft=null;
      break;
    }
    case "archive": {if(typeof operation.archived!=="boolean")throw new InspirationError("INVALID_IDEA","归档状态无效。");node(operation.nodeId).archived=operation.archived;break;}
    case "move": {const entries=Object.entries(operation.positions??{});if(entries.length>200)throw new InspirationError("INVALID_IDEA","位置更新过多。");for(const [id,value] of entries){node(id);next.positions[id]=position(value);}break;}
    case "connect": case "disconnect": {
      node(operation.from);node(operation.to);if(operation.from===operation.to)throw new InspirationError("INVALID_IDEA","请选择两个不同的节点。");
      next.edges=next.edges.filter(edge=>!(edge.from===operation.from&&edge.to===operation.to));
      if(operation.kind==="connect"){if(next.edges.length>=1000)throw new InspirationError("IDEA_LIMIT","连线数量已达上限。");next.edges.push({from:operation.from,to:operation.to});}break;
    }
    case "group": {
      const id=text(operation.id,100);const nodeIds=[...new Set(operation.nodeIds)];
      if(nodeIds.length<2||nodeIds.length>200)throw new InspirationError("INVALID_IDEA","至少选择两个节点成组。");
      nodeIds.forEach(node);next.groups=next.groups.filter(group=>group.id!==id).map(group=>({...group,nodeIds:group.nodeIds.filter(id=>!nodeIds.includes(id))})).filter(group=>group.nodeIds.length>1);
      next.groups.push({id,title:text(operation.title,100),nodeIds});break;
    }
    case "ungroup":next.groups=next.groups.filter(group=>group.id!==operation.id);break;
    case "draft": {
      if(!operation.draft){next.draft=null;break;}
      const draft=operation.draft;
      const allowed=new Set(["id","kind","title","markdown","url","tags","expectedNodeRevision","mediaPath","sourceTaskId"]);
      if(Object.keys(draft).some(key=>!allowed.has(key)))throw new InspirationError("INVALID_IDEA","草稿包含不支持的字段。");
      ideaId(draft.id);text(draft.title,200,true);text(draft.markdown,50_000,true);text(draft.url,4096,true);text(draft.tags,500,true);
      if(!["text","image","link","video"].includes(draft.kind)||!Number.isSafeInteger(draft.expectedNodeRevision)||draft.expectedNodeRevision<0)throw new InspirationError("INVALID_IDEA","灵感草稿无效。");
      if(draft.mediaPath!==undefined&&(typeof draft.mediaPath!=="string"||!draft.mediaPath.startsWith("/")||draft.mediaPath.length>4096||draft.mediaPath.includes("\0")))throw new InspirationError("INVALID_IDEA","媒体来源无效。");
      if(draft.sourceTaskId!==undefined)text(draft.sourceTaskId,200);
      next.draft={id:draft.id,kind:draft.kind,title:draft.title,markdown:draft.markdown,url:draft.url,tags:draft.tags,expectedNodeRevision:draft.expectedNodeRevision,...(draft.mediaPath?{mediaPath:draft.mediaPath}:{}),...(draft.sourceTaskId?{sourceTaskId:draft.sourceTaskId}:{})};
      break;
    }
    case "viewport": {const p=position(operation.viewport);if(!Number.isFinite(operation.viewport.zoom)||operation.viewport.zoom<.25||operation.viewport.zoom>2)throw new InspirationError("INVALID_IDEA","缩放比例无效。");next.viewport={...p,zoom:operation.viewport.zoom};break;}
    default:throw new InspirationError("INVALID_IDEA","不支持的灵感操作。");
  }
  if(Buffer.byteLength(JSON.stringify(next))>6_000_000)throw new InspirationError("IDEA_LIMIT","画布内容超过当前大小上限。");
  return next;
}

async function prepareRoot(layout:DCodeDataRootLayout):Promise<string> {
  await prepareManagedDCodeDirectory(join(layout.root,"knowledge"));
  const root=inspirationRoot(layout);await prepareManagedDCodeDirectory(root);return root;
}
async function safeBytes(path:string,limit:number):Promise<Buffer> {
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {const before=await file.stat();if(!before.isFile()||before.size>limit)throw new InspirationError("IDEA_MEDIA_LIMIT","请选择不超过 50 MB 的普通媒体文件。");const bytes=await file.readFile();const after=await file.stat();if(before.size!==bytes.length||before.mtimeMs!==after.mtimeMs)throw new InspirationError("IDEA_MEDIA_CHANGED","文件正在改变，请重新添加。");return bytes;}finally{await file.close();}
}
export async function publishIdeaMedia(layout:DCodeDataRootLayout,path:string,kind:IdeaKind):Promise<{media:IdeaMedia;created:boolean}> {
  if(!["image","video"].includes(kind)||!path.startsWith("/"))throw new InspirationError("INVALID_IDEA","媒体来源无效。");
  const bytes=await safeBytes(path,kind==="image"?5_000_000:50_000_000);
  if(isUtf8(bytes)&&redactCredentialText(bytes.toString("utf8")).redacted)throw new InspirationError("CREDENTIAL_MATERIAL_REJECTED","媒体文件包含疑似凭据，不能保存。");
  let mimeType:string,extension:string;
  if(kind==="image"){
    if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))){mimeType="image/png";extension="png";}
    else if(bytes[0]===255&&bytes[1]===216){mimeType="image/jpeg";extension="jpg";}
    else if(/^GIF8[79]a/.test(bytes.subarray(0,6).toString())){mimeType="image/gif";extension="gif";}
    else if(bytes.subarray(0,4).toString()==="RIFF"&&bytes.subarray(8,12).toString()==="WEBP"){mimeType="image/webp";extension="webp";}
    else throw new InspirationError("INVALID_IDEA","图片需为 PNG、JPEG、GIF 或 WebP。");
  }else{
    extension=extname(path).slice(1).toLowerCase();
    const valid=extension==="webm"?bytes.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3])):["ftyp","moov","mdat","wide"].includes(bytes.subarray(4,8).toString());
    if(!["mp4","mov","m4v","webm"].includes(extension)||!valid)throw new InspirationError("INVALID_IDEA","视频需为 MP4、MOV、M4V 或 WebM。");
    mimeType=extension==="mov"?"video/quicktime":extension==="webm"?"video/webm":"video/mp4";
  }
  const digest=createHash("sha256").update(bytes).digest("hex"),root=await prepareRoot(layout),folder=join(root,"media");await prepareManagedDCodeDirectory(folder);
  const fileName=`${digest}.${extension}`,target=join(folder,fileName);
  let created=true;
  try{await publishNewFileAtomically(target,bytes,0o400);}catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;created=false;const existing=await safeBytes(target,50_000_000);if(!existing.equals(bytes))throw new InspirationError("IDEA_MEDIA_CHANGED","已有媒体副本损坏，请检查灵感资料。");}
  return {media:{fileName,name:basename(path).slice(0,200),mimeType,bytes:bytes.length,digest:`sha256:${digest}`},created};
}
export async function resolveIdeaMedia(layout:DCodeDataRootLayout,media:IdeaMedia):Promise<{path:string;data?:string;mimeType:string;name:string}> {
  if(!/^[a-f0-9]{64}\.(png|jpg|gif|webp|mp4|mov|m4v|webm)$/.test(media.fileName))throw new InspirationError("INVALID_IDEA","媒体记录无效。");
  const root=await prepareRoot(layout),folder=join(root,"media");const info=await lstat(folder);if(info.isSymbolicLink()||!info.isDirectory())throw new InspirationError("INVALID_IDEA","媒体目录无效。");
  const path=join(folder,media.fileName),bytes=await safeBytes(path,50_000_000);
  if(`sha256:${createHash("sha256").update(bytes).digest("hex")}`!==media.digest)throw new InspirationError("IDEA_MEDIA_CHANGED","媒体副本已改变。");
  return {path,name:media.name,mimeType:media.mimeType,...(media.mimeType.startsWith("image/")?{data:bytes.toString("base64")}: {})};
}
export async function removeUnreferencedIdeaMedia(layout:DCodeDataRootLayout,media:IdeaMedia):Promise<void> {
  const root=await prepareRoot(layout);await unlink(join(root,"media",media.fileName)).catch(error=>{if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;});
}
export async function exportIdeaMarkdown(layout:DCodeDataRootLayout,node:IdeaNode):Promise<{rootPath:string;relativePath:string;path:string;digest:string;name:string}> {
  ideaId(node.id);
  const root=await prepareRoot(layout),directory=join(root,node.id);await prepareManagedDCodeDirectory(directory);
  const media=node.media?`\n\n${node.kind==="image"?"!":""}[${node.kind==="image"?"图片":"视频"}](../media/${node.media.fileName})`:"";
  const body=`# ${node.title}\n\n${node.markdown}${node.url?`\n\n[原始链接](<${node.url}>)`:""}${media}\n`;
  const bytes=Buffer.from(body),digest=createHash("sha256").update(bytes).digest("hex"),relativePath=`${node.id}/r${node.revision}-${digest}.md`,path=join(root,relativePath);
  try{await publishNewFileAtomically(path,bytes,0o400);}catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;if(!(await safeBytes(path,1_000_000)).equals(bytes))throw new InspirationError("IDEA_SNAPSHOT_CHANGED","灵感引用版本已改变，请检查知识资料。");}
  return {rootPath:root,relativePath,path,digest:`sha256:${digest}`,name:`${node.title}.md`};
}
export async function assertIdeaSnapshotDigest(layout:DCodeDataRootLayout,path:string,digest:string):Promise<void> {
  const root=join(await realpath(layout.root),"knowledge","inspiration");
  if(!resolve(path).startsWith(`${root}/`))return;
  const match=basename(path).match(/^r\d+-([a-f0-9]{64})\.md$/);
  if(match&&digest!==`sha256:${match[1]}`)throw new InspirationError("IDEA_SNAPSHOT_CHANGED","任务引用的灵感版本已被修改，请重新引用。");
}
