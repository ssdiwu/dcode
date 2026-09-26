import type {SessionManager} from '@earendil-works/pi-coding-agent';
import {redactCredentialText} from './credential-material.js';
const structural=/^(?:id|parentId|sessionId|toolCallId|targetId|firstKeptEntryId|model|modelId|provider|providerId|cwd|path|filePath|rootPath|sourcePath|directory|timestamp|api|type|role)$/u;
const secret=/^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|client[_-]?secret|secret)$/iu;
/** Provider ciphertext is protocol state, not a credential-shaped prose token.
 * Parse this one SDK field so summaries still receive normal redaction. Never
 * send a partially redacted ciphertext back to the provider. */
function sanitizeThinkingSignature(value:string):string|undefined {
  // Older private sessions may already contain a damaged signature. Retain the
  // visible history but omit unusable provider state on the next projection.
  if(value.includes('[REDACTED]'))return undefined;
  let item:Record<string,unknown>;
  try{item=JSON.parse(value);}catch{return redactCredentialText(value).text;}
  if(!item||item.type!=='reasoning'||typeof item.id!=='string'||!/^rs_[\w-]+$/u.test(item.id)||!Array.isArray(item.summary)||typeof item.encrypted_content!=='string')return redactCredentialText(value).text;
  if(!/^[A-Za-z0-9_+/-]+={0,2}$/u.test(item.encrypted_content))return undefined;
  const encrypted=redactCredentialText(item.encrypted_content,{opaqueTokens:false});
  if(encrypted.redacted)return undefined;
  const {encrypted_content:_,...metadata}=item;
  return JSON.stringify({...sanitizeRuntimeValue(metadata),encrypted_content:encrypted.text});
}
/** Serialisable runtime payloads are sanitised before crossing into the model,
 * renderer or private SessionManager. Credential values never enter the receipt. */
export function sanitizeRuntimeValue<T>(value:T,key=''):T {
  if(typeof value==='string')return (value.startsWith('data:image/')?value:redactCredentialText(value,{opaqueTokens:!structural.test(key)}).text) as T;
  if(Array.isArray(value))return value.map(item=>sanitizeRuntimeValue(item)) as T;
  if(!value||typeof value!=='object'||value instanceof Date||ArrayBuffer.isView(value))return value;
  const record=value as Record<string,unknown>,auth=record.type==='api_key'||record.type==='oauth';
  return Object.fromEntries(Object.entries(record).map(([name,item])=>{
    if(name==='data'&&(record.type==='image'||record.type==='audio'))return [name,item];
    if(name==='thinkingSignature'&&record.type==='thinking'&&typeof item==='string')return [name,sanitizeThinkingSignature(item)];
    if(typeof item==='string'&&item.length>=8&&(secret.test(name)||auth&&['key','access','refresh'].includes(name)))return [name,'[REDACTED]'];
    return [name,sanitizeRuntimeValue(item,name)];
  })) as T;
}
const guarded=new WeakSet<SessionManager>();
export function guardPrivateSessionPersistence(manager:SessionManager):void {
  if(guarded.has(manager))return;guarded.add(manager);
  const methods=manager as unknown as Record<string,(...args:unknown[])=>unknown>;
  for(const name of ['appendMessage','appendContextEdit','appendCompaction','appendCustomEntry','appendCustomMessageEntry','appendSessionInfo','appendLabelChange','branchWithSummary']){
    const original=methods[name];if(typeof original!=='function')continue;
    methods[name]=(...args:unknown[])=>original.apply(manager,args.map(argument=>{
      const safe=sanitizeRuntimeValue(argument);
      // Pi's persistence listener uses message identity to acknowledge input.
      if(name==='appendMessage'&&argument&&typeof argument==='object'&&!Array.isArray(argument)){for(const key of Object.keys(argument))delete (argument as Record<string,unknown>)[key];Object.assign(argument,safe);return argument;}
      return safe;
    }));
  }
  const build=manager.buildSessionContext.bind(manager);manager.buildSessionContext=()=>sanitizeRuntimeValue(build());
  const projection=manager.buildSessionProjection.bind(manager);manager.buildSessionProjection=()=>sanitizeRuntimeValue(projection());
}
