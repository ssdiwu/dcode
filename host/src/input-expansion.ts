import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {open,realpath} from 'node:fs/promises';
import {dirname,isAbsolute} from 'node:path';
import type {AgentSession} from '@earendil-works/pi-coding-agent';
import {redactCredentialText} from './credential-material.js';
export interface InputSourceReceipt {kind:'skill'|'prompt';name:string;path:string;digest:string;bytes:number}
export function inputSourceReceipts(value:unknown):InputSourceReceipt[]{
  if(value===undefined)return [];
  if(!Array.isArray(value)||value.length>2)throw new Error('输入来源记录无效');
  return value.map(item=>{if(!item||typeof item!=='object'||!['skill','prompt'].includes(item.kind)||typeof item.name!=='string'||!item.name||item.name.length>200||typeof item.path!=='string'||!isAbsolute(item.path)||item.path.length>4096||typeof item.digest!=='string'||!/^sha256:[a-f0-9]{64}$/u.test(item.digest)||!Number.isInteger(item.bytes)||item.bytes<0||item.bytes>128*1024)throw new Error('输入来源记录无效');return {kind:item.kind,name:item.name,path:item.path,digest:item.digest,bytes:item.bytes};});
}
const body=(text:string)=>text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u,'').trim();
const escape=(text:string)=>text.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;');
/** Pi 0.84.4 argument syntax, kept in D Code so raw input and expansion receipts
 * are committed together. No shell evaluation and no recursive substitution. */
export function templateArguments(content:string,input:string):string {
  const args:string[]=[];let current='',quote:string|undefined;
  for(const char of input){if(quote){if(char===quote)quote=undefined;else current+=char;}else if(char==='"'||char==="'")quote=char;else if(/\s/u.test(char)){if(current){args.push(current);current='';}}else current+=char;}if(current)args.push(current);
  const all=args.join(' ');
  return content.replace(/\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g,(_match,defaultTarget,defaultValue,sliceStart,sliceLength,simple)=>{
    if(defaultTarget){const value=defaultTarget==='@'||defaultTarget==='ARGUMENTS'?all:args[Number(defaultTarget)-1];return value||defaultValue;}
    if(sliceStart){const start=Math.max(0,Number(sliceStart)-1);return args.slice(start,sliceLength?start+Number(sliceLength):undefined).join(' ');}
    return simple==='ARGUMENTS'||simple==='@'?all:args[Number(simple)-1]??'';
  });
}
export async function expandDCodeInput(text:string,session:AgentSession):Promise<{text:string;sources:InputSourceReceipt[];command?:string}> {
  const match=text.match(/^\/(\S+)(?:\s+([\s\S]*))?$/u);if(!match)return {text,sources:[]};
  const name=match[1]!,args=match[2]??'';
  if(session.extensionRunner.getRegisteredCommands().some(command=>command.invocationName===name))return {text,sources:[],command:name};
  const skill=name.startsWith('skill:')?session.resourceLoader.getSkills().skills.find(skill=>skill.name===name.slice(6)):undefined;
  if(name.startsWith('skill:')&&!skill)throw new Error('所选技能已停用或不可用，输入内容已保留');
  const template=skill?undefined:session.promptTemplates.find(template=>template.name===name);
  const source=skill??template;if(!source)return {text,sources:[]};
  const path=await realpath(source.filePath);const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  let bytes:Buffer;try{const before=await file.stat();if(!before.isFile()||before.size>128*1024)throw new Error('技能或模板不是可读取的小型文本文件');bytes=await file.readFile();const after=await file.stat();if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||bytes.length!==before.size)throw new Error('技能或模板正在修改，请稍后重试');}finally{await file.close();}
  const content=body(bytes.toString('utf8'));if(redactCredentialText(content).redacted)throw new Error('技能或模板包含凭据内容，未交给模型');
  const expanded=skill?`<skill name="${escape(skill.name)}" location="${escape(path)}">\n相对引用以 ${dirname(path)} 为基准。\n\n${content}\n</skill>${args?`\n\n${args}`:''}`:templateArguments(content,args);
  if(expanded.length>200000)throw new Error('展开后的输入过长，请减少模板参数');
  return {text:expanded,sources:[{kind:skill?'skill':'prompt',name:source.name,path,digest:`sha256:${createHash('sha256').update(bytes).digest('hex')}`,bytes:bytes.length}]};
}
