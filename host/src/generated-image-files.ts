import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat,open,realpath} from 'node:fs/promises';
import {basename,dirname,join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {publishNewFileAtomically} from './atomic-file.js';
import {prepareManagedDCodeDirectory,type DCodeDataRootLayout} from './dcode-data-root.js';
import type {ArtifactRecord} from './product-store.js';
import {ImageGenerationError,type GeneratedImageInfo,type ImageGenerationRecord,type ImageExportDestination} from './image-generation-types.js';

export const MAX_GENERATED_IMAGE_BYTES=5_000_000;
export const generatedImageDigest=(bytes:Uint8Array)=>`sha256:${createHash('sha256').update(bytes).digest('hex')}`;
export function generatedImageArtifactMatches(layout:DCodeDataRootLayout,record:ImageGenerationRecord,artifact?:ArtifactRecord):boolean {
 const info=record.resultInfo,metadata=artifact?.metadata as Record<string,unknown>|undefined;
 return !!info&&!!artifact&&record.state==='succeeded'&&artifact.id===record.artifactId&&artifact.kind==='generated_image'&&artifact.taskId===record.taskId&&artifact.sessionId===record.sessionId&&artifact.managedPath===join(layout.artifactsDirectory,'generated-images',record.id,`image.${info.extension}`)&&artifact.digest===info.digest&&!!metadata&&metadata.generationId===record.id&&metadata.threadId===record.threadId&&metadata.turnId===record.turnId&&metadata.source===record.source&&metadata.componentVersion===record.componentVersion&&Object.entries(info).every(([key,value])=>metadata[key]===value);
}
const attemptId=(value:string)=>/^attempt-[a-f0-9-]{36}$/u.test(value);
export interface GeneratedImageManifest {
  version:1;attemptId:string;taskId:string;sessionId:string;descriptionDigest:string;
  threadId:string;turnId:string;info:GeneratedImageInfo;fileName:string;
}
async function nativeImage(bytes:Buffer,output?:ImageExportDestination&{name:string}):Promise<Omit<GeneratedImageInfo,'digest'>> {
 if(!bytes.length||bytes.length>MAX_GENERATED_IMAGE_BYTES)throw new ImageGenerationError('IMAGE_TOO_LARGE');
 return new Promise((resolve,reject)=>{
  const child=spawn(fileURLToPath(new URL('../bin/dcode-generated-image',import.meta.url)),[],{env:{PATH:'/usr/bin:/bin:/usr/sbin:/sbin'},stdio:'pipe'});
  let body='',settled=false;
  const fail=(error:Error)=>{if(settled)return;settled=true;clearTimeout(timer);child.kill('SIGKILL');reject(error);};
  const timer=setTimeout(()=>fail(new ImageGenerationError('IMAGE_VALIDATION_UNAVAILABLE')),15_000);
  child.on('error',()=>fail(new ImageGenerationError('IMAGE_VALIDATION_UNAVAILABLE')));
  child.stderr.on('data',()=>{});
  child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{body+=chunk;if(body.length>4096)fail(new ImageGenerationError('IMAGE_VALIDATION_UNAVAILABLE'));});
  child.on('close',code=>{
   if(settled)return;settled=true;clearTimeout(timer);
   try{
    if(code!==0)throw new ImageGenerationError('IMAGE_VALIDATION_UNAVAILABLE');
    const value=JSON.parse(body) as Record<string,unknown>;
    if(value.error)throw new ImageGenerationError(value.error==='IMAGE_EXPORT_EXISTS'?'IMAGE_EXPORT_EXISTS':output?'IMAGE_EXPORT_FAILED':'IMAGE_FORMAT_REJECTED');
    const extensions:Record<string,string>={'image/png':'png','image/jpeg':'jpg','image/webp':'webp'};
    if(typeof value.mimeType!=='string'||extensions[value.mimeType]!==value.extension||value.bytes!==bytes.length||!Number.isSafeInteger(value.width)||!Number.isSafeInteger(value.height)||(value.width as number)<1||(value.height as number)<1)throw new ImageGenerationError('IMAGE_FORMAT_REJECTED');
    resolve(value as unknown as Omit<GeneratedImageInfo,'digest'>);
   }catch(error){reject(error instanceof ImageGenerationError?error:new ImageGenerationError('IMAGE_FORMAT_REJECTED'));}
  });
  child.stdin.on('error',()=>fail(new ImageGenerationError('IMAGE_VALIDATION_UNAVAILABLE')));
  child.stdin.end(JSON.stringify({action:output?'export':'inspect',data:bytes.toString('base64'),...output}));
 });
}
export async function inspectGeneratedImage(encoded:string):Promise<{bytes:Buffer;info:GeneratedImageInfo}> {
 if(encoded.length>Math.ceil(MAX_GENERATED_IMAGE_BYTES/3)*4||!/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)||encoded.length%4!==0)throw new ImageGenerationError('IMAGE_FORMAT_REJECTED');
 const bytes=Buffer.from(encoded,'base64');if(bytes.toString('base64')!==encoded)throw new ImageGenerationError('IMAGE_FORMAT_REJECTED');
 return {bytes,info:{...await nativeImage(bytes),digest:generatedImageDigest(bytes)}};
}
function imageDirectory(layout:DCodeDataRootLayout,id:string):string {
 if(!attemptId(id))throw new ImageGenerationError('IMAGE_RECORD_INVALID');
 return join(layout.artifactsDirectory,'generated-images',id);
}
async function safeDirectory(path:string):Promise<void>{const stat=await lstat(path);if(!stat.isDirectory()||stat.isSymbolicLink())throw new ImageGenerationError('IMAGE_RECORD_INVALID');}
async function regularFile(path:string,max:number):Promise<Buffer> {
 const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const before=await handle.stat();if(!before.isFile()||before.size>max)throw new ImageGenerationError('IMAGE_RECORD_INVALID');const bytes=await handle.readFile();const after=await handle.stat();if(bytes.length!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs)throw new ImageGenerationError('IMAGE_RECORD_CHANGED');return bytes;}finally{await handle.close();}
}
export async function saveGeneratedImage(layout:DCodeDataRootLayout,record:ImageGenerationRecord,encoded:string,source:{threadId:string;turnId:string},retainProof:(info:GeneratedImageInfo)=>Promise<void>):Promise<{path:string;manifest:GeneratedImageManifest}> {
 const {bytes,info}=await inspectGeneratedImage(encoded),directory=imageDirectory(layout,record.id);
 await retainProof(info);
 for(const path of [layout.artifactsDirectory,join(layout.artifactsDirectory,'generated-images'),directory])await prepareManagedDCodeDirectory(path);
 const fileName=`image.${info.extension}`,path=join(directory,fileName);
 const manifest:GeneratedImageManifest={version:1,attemptId:record.id,taskId:record.taskId,sessionId:record.sessionId,descriptionDigest:generatedImageDigest(Buffer.from(record.description)),...source,info,fileName};
 await publishNewFileAtomically(path,bytes);
 await publishNewFileAtomically(join(directory,'manifest.json'),JSON.stringify(manifest));
 return {path,manifest};
}
export async function readGeneratedImage(layout:DCodeDataRootLayout,record:ImageGenerationRecord):Promise<{path:string;bytes:Buffer;manifest:GeneratedImageManifest}> {
 const directory=imageDirectory(layout,record.id);
 for(const path of [layout.root,layout.artifactsDirectory,join(layout.artifactsDirectory,'generated-images'),directory])await safeDirectory(path);
 const manifest=JSON.parse((await regularFile(join(directory,'manifest.json'),16_000)).toString('utf8')) as GeneratedImageManifest;
 if(!record.resultInfo||manifest.fileName!==`image.${record.resultInfo.extension}`||Object.entries(record.resultInfo).some(([key,value])=>manifest.info?.[key as keyof GeneratedImageInfo]!==value))throw new ImageGenerationError('IMAGE_RECORD_CHANGED');
 if(manifest.version!==1||manifest.attemptId!==record.id||manifest.taskId!==record.taskId||manifest.sessionId!==record.sessionId||manifest.descriptionDigest!==generatedImageDigest(Buffer.from(record.description))||manifest.threadId!==record.threadId||manifest.turnId!==record.turnId||!['image.png','image.jpg','image.webp'].includes(manifest.fileName))throw new ImageGenerationError('IMAGE_RECORD_INVALID');
 const path=join(directory,manifest.fileName),bytes=await regularFile(path,MAX_GENERATED_IMAGE_BYTES);
 if(bytes.length!==manifest.info.bytes||generatedImageDigest(bytes)!==manifest.info.digest)throw new ImageGenerationError('IMAGE_RECORD_CHANGED');
 const actual=await nativeImage(bytes);
 if(actual.mimeType!==manifest.info.mimeType||actual.width!==manifest.info.width||actual.height!==manifest.info.height)throw new ImageGenerationError('IMAGE_RECORD_CHANGED');
 return {path,bytes,manifest};
}
export async function exportGeneratedImage(bytes:Buffer,destination:string,managedRoot:string,expected:ImageExportDestination):Promise<{path:string}> {
 const directory=dirname(destination),name=basename(destination),canonical=await realpath(directory);
 const protectedParts=new Set(['.git','.dcode','.codex','.pi','.ssh','.aws','.gnupg']);
 if(canonical.split('/').some(part=>protectedParts.has(part.toLowerCase()))||relative(managedRoot,canonical)===''||!relative(managedRoot,canonical).startsWith('..')||name.startsWith('.'))throw new ImageGenerationError('IMAGE_EXPORT_LOCATION_INVALID');
 const identity=await lstat(canonical);
 if(expected.directory!==canonical||String(identity.dev)!==expected.device||String(identity.ino)!==expected.inode)throw new ImageGenerationError('IMAGE_EXPORT_LOCATION_CHANGED');
 await nativeImage(bytes,{directory:canonical,name,device:expected.device,inode:expected.inode});return {path:join(canonical,name)};
}
