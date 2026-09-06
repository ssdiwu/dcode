import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { constants } from "node:fs";
import { lstat, open, readFile, readdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { prepareManagedDCodeDirectory, type DCodeDataRootLayout } from "./dcode-data-root.js";
import { publishNewFileAtomically } from "./atomic-file.js";
import { redactCredentialText } from "./credential-material.js";

export const MANAGED_ATTACHMENT_CAPABILITY = 1;
export const ATTACHMENT_DAY = 86_400_000;
export const ATTACHMENT_RETENTION_DAYS = 30;
export interface ManagedAttachment {
  id: string;
  name: string;
  mimeType: string;
  bytes: number;
  digest: string;
  createdAt: string;
  expiresAt: string;
  submittedAt?: string;
}
export interface AttachmentSource { path?: string; name?: string; data?: string; mimeType?: string }
export class AttachmentError extends Error { constructor(readonly code:string,message:string){super(message);} }
const validId = (id:string) => /^attachment-[a-f0-9]{32}$/.test(id);
const safeName = (name:string) => basename(name).replace(/[\u0000-\u001f/\\:]/g,"_").slice(0,180) || "附件";
export const attachmentRoot = (layout:DCodeDataRootLayout) => join(layout.root,"tmp","attachments");
export function attachmentPath(layout:DCodeDataRootLayout,attachment:ManagedAttachment):string {
  if (!validId(attachment.id) || attachment.name !== safeName(attachment.name) || attachment.name === "." || attachment.name === "..") throw new AttachmentError("INVALID_ATTACHMENT","附件记录无效。");
  return join(attachmentRoot(layout),attachment.id,`body-${attachment.name}`);
}
export function attachmentPrompt(message:string,attachments:ManagedAttachment[],layout:DCodeDataRootLayout):string {
  return [message,...attachments.map(item=>`附件：${JSON.stringify({name:item.name,path:attachmentPath(layout,item)})}`)].filter(Boolean).join("\n");
}
function mimeFor(name:string,bytes:Buffer,provided?:string):string {
  if (bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return "image/png";
  if (bytes[0]===255 && bytes[1]===216 && bytes[2]===255) return "image/jpeg";
  if (/^GIF8[79]a/.test(bytes.subarray(0,6).toString())) return "image/gif";
  if (bytes.subarray(0,4).toString()==="RIFF" && bytes.subarray(8,12).toString()==="WEBP") return "image/webp";
  if (bytes.subarray(0,5).toString()==="%PDF-") return "application/pdf";
  if (/\.(txt|md|json|csv|ts|tsx|js|jsx|py|yaml|yml|toml|log|sh|html|css|xml|svg)$/i.test(name)) return "text/plain";
  if (provided?.startsWith("image/")) throw new AttachmentError("INVALID_IMAGE","图片内容与格式不符，请重新选择图片。");
  return "application/octet-stream";
}
async function regularBytes(path:string,limit:number):Promise<Buffer> {
  const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const before=await handle.stat();
    if (!before.isFile() || before.size>limit) throw new AttachmentError("ATTACHMENT_TOO_LARGE","只支持不超过 50 MB 的普通文件。");
    const bytes=await handle.readFile();
    const after=await handle.stat();
    if (after.size!==before.size || after.mtimeMs!==before.mtimeMs || bytes.length!==before.size) throw new AttachmentError("ATTACHMENT_CHANGED","文件正在修改，请稍后重新添加。");
    return bytes;
  } finally {await handle.close();}
}
export async function stageAttachment(layout:DCodeDataRootLayout,source:AttachmentSource,id:string,now:string,validate?:(attachment:ManagedAttachment)=>void):Promise<ManagedAttachment> {
  if (!validId(id)) throw new AttachmentError("INVALID_ATTACHMENT","附件标识无效。");
  await prepareManagedDCodeDirectory(join(layout.root,"tmp"));
  await prepareManagedDCodeDirectory(attachmentRoot(layout));
  const name=safeName(source.path ? basename(source.path) : source.name ?? "粘贴图片.png");
  if (/^(\.env(?:\..*)?|\.npmrc|\.netrc|\.pypirc|\.git-credentials|auth\.json|credentials(?:\.json)?|id_(rsa|ed25519))$/i.test(name) || /\.(pem|key|p12|pfx)$/i.test(name)) throw new AttachmentError("CREDENTIAL_MATERIAL_REJECTED","此文件可能包含凭据，不能作为附件保存。");
  const bytes=source.path ? await regularBytes(source.path,50_000_000) : Buffer.from(source.data??"","base64");
  if (bytes.length>50_000_000) throw new AttachmentError("ATTACHMENT_TOO_LARGE","附件超过 50 MB。");
  const mimeType=mimeFor(name,bytes,source.mimeType);
  if (mimeType.startsWith("image/") && (!bytes.length || bytes.length>5_000_000)) throw new AttachmentError("ATTACHMENT_TOO_LARGE","图片需大于 0 字节且不超过 5 MB。");
  if (isUtf8(bytes) && redactCredentialText(bytes.toString("utf8")).redacted) throw new AttachmentError("CREDENTIAL_MATERIAL_REJECTED","文件中检测到疑似凭据，请移除后重新添加。");
  const immutable={id,name,mimeType,bytes:bytes.length,digest:`sha256:${createHash("sha256").update(bytes).digest("hex")}`,createdAt:now};
  validate?.({...immutable,expiresAt:new Date(Date.parse(now)+ATTACHMENT_DAY).toISOString()});
  const directory=join(attachmentRoot(layout),id);
  await prepareManagedDCodeDirectory(directory);
  try {
    await publishNewFileAtomically(join(directory,"manifest.json"),JSON.stringify(immutable));
    await publishNewFileAtomically(join(directory,`body-${name}`),bytes);
  } catch(error) {
    if ((error as NodeJS.ErrnoException).code!=="EEXIST") throw error;
    const existing=JSON.parse((await regularBytes(join(directory,"manifest.json"),16_000)).toString()) as typeof immutable;
    if (existing.id!==id || existing.digest!==immutable.digest || existing.name!==name) throw new AttachmentError("ATTACHMENT_CHANGED","重复导入的附件内容已改变，请重新选择。");
    try {await publishNewFileAtomically(join(directory,`body-${name}`),bytes);} catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;}
    return {...existing,expiresAt:new Date(Date.parse(existing.createdAt)+ATTACHMENT_DAY).toISOString()};
  }
  return {...immutable,expiresAt:new Date(Date.parse(now)+ATTACHMENT_DAY).toISOString()};
}
export async function stagedAttachmentBytes(layout:DCodeDataRootLayout,excludingId?:string):Promise<number> {
  let entries;try{entries=await readdir(attachmentRoot(layout),{withFileTypes:true});}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return 0;throw error;}
  let size=0;
  for(const entry of entries){
    if(!entry.isDirectory()||!validId(entry.name)||entry.name===excludingId)continue;
    for(const file of await readdir(join(attachmentRoot(layout),entry.name),{withFileTypes:true}))if(file.isFile())size+=(await lstat(join(attachmentRoot(layout),entry.name,file.name))).size;
  }
  return size;
}
export async function discardStagedAttachment(layout:DCodeDataRootLayout,id:string):Promise<void> {
  if(!validId(id))return;
  await rm(join(attachmentRoot(layout),id),{recursive:true,force:true});
}
export async function readAttachment(layout:DCodeDataRootLayout,attachment:ManagedAttachment,now:string):Promise<{path:string;bytes:Buffer}> {
  if (Date.parse(attachment.expiresAt)<=Date.parse(now)) throw new AttachmentError("ATTACHMENT_EXPIRED",`“${attachment.name}”已过期，请重新添加。`);
  const path=attachmentPath(layout,attachment);
  for (const dir of [join(layout.root,"tmp"),attachmentRoot(layout),join(attachmentRoot(layout),attachment.id)]) {
    const stat=await lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new AttachmentError("INVALID_ATTACHMENT","附件目录无效。");
  }
  let bytes:Buffer;
  try {bytes=await regularBytes(path,50_000_000);} catch(error) {if ((error as NodeJS.ErrnoException).code==="ENOENT") throw new AttachmentError("ATTACHMENT_MISSING",`“${attachment.name}”的副本已不存在，请重新添加。`);throw error;}
  if (bytes.length!==attachment.bytes || `sha256:${createHash("sha256").update(bytes).digest("hex")}`!==attachment.digest) throw new AttachmentError("ATTACHMENT_CHANGED","附件副本已改变，不能继续使用。");
  return {path,bytes};
}
/** Only our immutable manifests identify orphan files; mutable retention lives in Product Store. */
export async function sweepAttachmentFiles(layout:DCodeDataRootLayout,records:ManagedAttachment[],now:string):Promise<number> {
  const root=attachmentRoot(layout),expiry=new Map<string,number>();
  try {const info=await lstat(join(layout.root,"tmp"));if(info.isSymbolicLink()||!info.isDirectory())throw new AttachmentError("INVALID_ATTACHMENT","附件目录无效。");}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return 0;throw error;}
  for(const record of records) expiry.set(record.id,Math.max(expiry.get(record.id)??0,Date.parse(record.expiresAt)));
  let entries;try {entries=await readdir(root,{withFileTypes:true});}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return 0;throw error;}
  const rootInfo=await lstat(root);if(rootInfo.isSymbolicLink()||!rootInfo.isDirectory())throw new AttachmentError("INVALID_ATTACHMENT","附件目录无效。");
  let removed=0;
  for(const entry of entries){
    if(!entry.isDirectory()||!validId(entry.name))continue;
    const directory=join(root,entry.name);
    try {
      const manifest=JSON.parse((await regularBytes(join(directory,"manifest.json"),16_000)).toString()) as ManagedAttachment;
      if(manifest.id!==entry.name)continue;
      const deadline=expiry.get(entry.name)??Date.parse(manifest.createdAt)+ATTACHMENT_DAY;
      if(Number.isFinite(deadline)&&deadline<=Date.parse(now)){await rm(directory,{recursive:true});removed++;}
    }catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")console.warn(`[attachment-cleanup] Invalid attachment manifest ${entry.name}; files retained.`);}
  }
  return removed;
}
