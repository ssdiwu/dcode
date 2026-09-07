import type {SessionManager} from '@earendil-works/pi-coding-agent';
import {redactCredentialText} from './credential-material.js';
const structural=/^(?:id|parentId|sessionId|toolCallId|targetId|firstKeptEntryId|model|modelId|provider|providerId|cwd|path|filePath|rootPath|sourcePath|directory|timestamp|api|type|role)$/u;
const secret=/^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|client[_-]?secret|secret)$/iu;
/** Serialisable runtime payloads are sanitised before crossing into the model,
 * renderer or private SessionManager. Credential values never enter the receipt. */
export function sanitizeRuntimeValue<T>(value:T,key=''):T {
  if(typeof value==='string')return (value.startsWith('data:image/')?value:redactCredentialText(value,{opaqueTokens:!structural.test(key)}).text) as T;
  if(Array.isArray(value))return value.map(item=>sanitizeRuntimeValue(item)) as T;
  if(!value||typeof value!=='object'||value instanceof Date||ArrayBuffer.isView(value))return value;
  const record=value as Record<string,unknown>,auth=record.type==='api_key'||record.type==='oauth';
  return Object.fromEntries(Object.entries(record).map(([name,item])=>{
    if(name==='data'&&(record.type==='image'||record.type==='audio'))return [name,item];
    if(typeof item==='string'&&item.length>=8&&(secret.test(name)||auth&&['key','access','refresh'].includes(name)))return [name,'[REDACTED]'];
    return [name,sanitizeRuntimeValue(item,name)];
  })) as T;
}
const guarded=new WeakSet<SessionManager>();
export function guardPrivateSessionPersistence(manager:SessionManager):void {
  if(guarded.has(manager))return;guarded.add(manager);
  const methods=manager as unknown as Record<string,(...args:unknown[])=>unknown>;
  for(const name of ['appendMessage','appendCompaction','appendCustomEntry','appendCustomMessageEntry','appendSessionInfo','appendLabelChange','branchWithSummary']){
    const original=methods[name];if(typeof original!=='function')continue;
    methods[name]=(...args:unknown[])=>original.apply(manager,args.map(argument=>{
      const safe=sanitizeRuntimeValue(argument);
      // Pi's persistence listener uses message identity to acknowledge input.
      if(name==='appendMessage'&&argument&&typeof argument==='object'&&!Array.isArray(argument)){for(const key of Object.keys(argument))delete (argument as Record<string,unknown>)[key];Object.assign(argument,safe);return argument;}
      return safe;
    }));
  }
  const build=manager.buildSessionContext.bind(manager);manager.buildSessionContext=()=>sanitizeRuntimeValue(build());
}
