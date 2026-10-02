export const CODEX_IMAGE_CLI_VERSION = '0.157.1';
export type ImageGenerationState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
export interface ImageGenerationRecord {
  id:string; requestId:string; taskId:string; sessionId:string; description:string; language:'zh-CN'|'en';
  state:ImageGenerationState; phase:'queued'|'submitting'|'active'|'finished';
  createdAt:string; updatedAt:string; source:'codex_chatgpt'; componentVersion:string;
  accountFingerprint?:string; plan?:string; threadId?:string; turnId?:string;
  artifactId?:string; errorCode?:string; revision:number;
  /** Store-owned result digest, committed before filesystem publication. */
  resultInfo?:GeneratedImageInfo;
  terminalStatus?:'completed'|'failed'|'interrupted';
}
export interface GeneratedImageInfo {mimeType:'image/png'|'image/jpeg'|'image/webp';extension:'png'|'jpg'|'webp';width:number;height:number;bytes:number;digest:string}
export interface ImageCapability {
  available:boolean; experimental:true; reasonCode?:string; componentVersion?:string;
  plan?:string; accountFingerprint?:string; quota:'unknown';
}
export interface KnownImageResult {data:string;threadId:string;turnId:string;terminalStatus?:'completed'|'failed'|'interrupted'}
export interface ImageExportContext {
 taskId:string;generationId:string;mimeType:string;
 project?:{id:string;revision:number;directory:string;device:string;inode:string};
}
export interface ImageExportDestination {directory:string;device:string;inode:string}
export class ImageGenerationError extends Error {
  constructor(readonly code:string,readonly uncertain=false,readonly result?:KnownImageResult){super(code);this.name='ImageGenerationError';}
}
