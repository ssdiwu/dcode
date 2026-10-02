import test from 'node:test';
import assert from 'node:assert/strict';
import {englishUi} from '../src/shared/ui-catalog.ts';
import {uiText,localizeUi,setDisplayLanguage,getDisplayLanguage,subscribeDisplayLanguage} from '../src/shared/ui-language.ts';
import {readdir,readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import ts from 'typescript';

test('UI language updates static options without changing source data or interpolated user text',()=>{
 const raw={menu:[['task','任务'],['settings','设置']]},labels=localizeUi(raw);let events=0;
 const unsubscribe=subscribeDisplayLanguage(()=>events++);
 try{
  setDisplayLanguage('en');
  assert.equal(labels.menu[0][1],'Tasks');assert.equal(uiText('第 {0} 条提问：{1}',[2,'用户正文 {0}']),'Question 2: 用户正文 {0}');
  assert.equal(raw.menu[0][1],'任务');assert.equal(uiText('User-authored title'),'User-authored title');
  setDisplayLanguage('zh-CN');assert.equal(labels.menu[0][1],'任务');assert.equal(events,2);
  assert.throws(()=>setDisplayLanguage('fr'));assert.equal(getDisplayLanguage(),'zh-CN');
 }finally{unsubscribe();setDisplayLanguage('zh-CN');}
});

test('English UI translations retain every dynamic slot',()=>{
 for(const [source,translated] of Object.entries(englishUi)){
  const slots=text=>[...text.matchAll(/\{(\d+)\}/gu)].map(match=>match[1]).sort();
  assert.deepEqual(slots(translated),slots(source),source);
  assert.ok(translated.trim()||source===' 版',source);
 }
});

test('explicit product UI keys and static option labels have English translations',async()=>{
 const missing=[];
 const visitDirectory=async directory=>{
  for(const entry of await readdir(directory,{withFileTypes:true})){
   const path=join(directory,entry.name);if(entry.isDirectory()){await visitDirectory(path);continue;}if(!/\.(?:ts|tsx)$/u.test(entry.name))continue;
   const source=ts.createSourceFile(path,await readFile(path,'utf8'),ts.ScriptTarget.Latest,true,path.endsWith('.tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS);
   const check=node=>{if(ts.isStringLiteralLike(node)&&/\p{Script=Han}/u.test(node.text)&&!Object.hasOwn(englishUi,node.text))missing.push(path+':'+(source.getLineAndCharacterOfPosition(node.pos).line+1)+' '+node.text);};
   const staticLabels=node=>{if(ts.isPropertyAssignment(node)){staticLabels(node.initializer);return;}check(node);ts.forEachChild(node,staticLabels);};
   const visit=node=>{if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)){if(node.expression.text==='uiText'&&node.arguments[0])check(node.arguments[0]);if(node.expression.text==='localizeUi'&&node.arguments[0])staticLabels(node.arguments[0]);}ts.forEachChild(node,visit);};
   visit(source);
  }
 };
 await visitDirectory(fileURLToPath(new URL('../src/renderer/src/',import.meta.url)));await visitDirectory(fileURLToPath(new URL('../src/main/',import.meta.url)));
 assert.deepEqual(missing,[],'Missing English product UI translations');
});
