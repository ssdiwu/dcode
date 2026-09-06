import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import electron from 'electron';
import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';
const root=fileURLToPath(new URL('../../src/renderer/src',import.meta.url));
const inventory=[];
function walk(folder){for(const entry of fs.readdirSync(folder,{withFileTypes:true})){const name=path.join(folder,entry.name);if(entry.isDirectory())walk(name);else if(name.endsWith('.tsx'))scan(name);}}
function attr(node,key){const a=node.attributes?.properties.find(a=>ts.isJsxAttribute(a)&&a.name.text===key);if(!a)return undefined;if(!a.initializer)return true;if(ts.isStringLiteral(a.initializer))return a.initializer.text;if(ts.isJsxExpression(a.initializer)&&a.initializer.expression&&ts.isTemplateExpression(a.initializer.expression))return a.initializer.expression.head.text;return undefined;}
function scan(file){const src=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);function visit(node){if((ts.isJsxSelfClosingElement(node)||ts.isJsxOpeningElement(node))&&['input','textarea','select'].includes(node.tagName.getText(src))){const tag=node.tagName.getText(src),type=attr(node,'type')??(tag==='input'?'text':tag);if(!attr(node,'hidden')&&type!=='file'){const ancestors=[];for(let parent=node.parent;parent;parent=parent.parent)if(ts.isJsxElement(parent)){const item=parent.openingElement;if(item===node)continue;const name=item.tagName.getText(src);const className=attr(item,'className');if(/^[a-z]/.test(name)&&typeof className==='string')ancestors.unshift({tag:name,className});}inventory.push({file:path.relative(root,file),line:src.getLineAndCharacterOfPosition(node.getStart()).line+1,tag,type,className:attr(node,'className')??'',ancestors});}}ts.forEachChild(node,visit);}visit(src);}
walk(root);
const temp=await mkdtemp(path.join(tmpdir(),'dcode-input-focus-'));
const assets=fileURLToPath(new URL('../../dist/renderer/assets',import.meta.url));
const links=(await readdir(assets)).filter(name=>name.endsWith('.css')).map(name=>`<link rel="stylesheet" href="${pathToFileURL(path.join(assets,name)).href}">`).join('');
const escape=text=>String(text).replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;');
const cases=inventory.map(item=>{
  const attributes=`id="target" aria-label="验证输入" class="${escape(item.className)}"`;
  const element=item.tag==='select'?`<select ${attributes}><option>选项</option></select>`:item.tag==='textarea'?`<textarea ${attributes} rows="4">输入内容</textarea>`:`<input ${attributes} type="${escape(item.type)}" value="示例内容">`;
  let html=item.ancestors.reduceRight((child,parent)=>`<${parent.tag}${parent.tag==='details'?' open':''} class="${escape(parent.className)}">${child}</${parent.tag}>`,element);
  if(item.file.includes('SettingsWorkspace'))html=`<section class="settings-content">${html}</section>`;
  return {...item,html};
});
try {
  const page=path.join(temp,'page.html'),runner=path.join(temp,'runner.cjs');
  await writeFile(page,`<!doctype html><html><head>${links}</head><body><div id="fixture"></div></body></html>`);
  await writeFile(runner,`
const {app,BrowserWindow,nativeTheme}=require('electron');
app.setPath('userData',${JSON.stringify(path.join(temp,'profile'))});
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:900,height:760,webPreferences:{sandbox:true,backgroundThrottling:false}});
 await win.loadFile(${JSON.stringify(page)});
 // Hidden windows are inactive; force CSS pseudo states instead of pretending el.focus() proves focus styling.
 win.webContents.debugger.attach('1.3');
 await win.webContents.debugger.sendCommand('DOM.enable');
 await win.webContents.debugger.sendCommand('CSS.enable');
 const results=[];
 for(const theme of ['light','dark']){
  nativeTheme.themeSource=theme;
  for(const input of ${JSON.stringify(cases)}){
   for(const mode of ['focus','readonly','disabled']){
    if(mode==='readonly'&&['checkbox','radio','range','color','select','file'].includes(input.type))continue;
    await win.webContents.executeJavaScript('document.getElementById("fixture").innerHTML='+JSON.stringify(input.html)+';document.getElementById("target").disabled='+JSON.stringify(mode==='disabled')+';document.getElementById("target").readOnly='+JSON.stringify(mode==='readonly')+';document.getElementById("target").focus();');
    const doc=await win.webContents.debugger.sendCommand('DOM.getDocument');
    const target=await win.webContents.debugger.sendCommand('DOM.querySelector',{nodeId:doc.root.nodeId,selector:'#target'});
    if(mode!=='disabled')await win.webContents.debugger.sendCommand('CSS.forcePseudoState',{nodeId:target.nodeId,forcedPseudoClasses:['focus','focus-visible']});
    const value=await win.webContents.executeJavaScript('('+(${function(input,mode){
      const element=document.getElementById('target');
      return new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>{
        const s=getComputedStyle(element),surface=element.closest('.input-surface');
        const ss=surface?getComputedStyle(surface):null;
        const color=value=>{const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const c=canvas.getContext('2d');c.fillStyle=value;c.fillRect(0,0,1,1);return Array.from(c.getImageData(0,0,1,1).data).slice(0,3);};
        const chroma=rgb=>Math.max(...rgb)-Math.min(...rgb);
        resolve({focused:document.activeElement===element,outline:s.outlineStyle,outlineChroma:chroma(color(s.outlineColor)),shadow:s.boxShadow,resize:s.resize,surfaceShadow:ss?.boxShadow,surfaceBorder:ss?.borderColor,border:s.borderColor});
      })));
    }.toString()})+')('+JSON.stringify(input)+','+JSON.stringify(mode)+')');
    results.push({theme,mode,file:input.file,line:input.line,type:input.type,...value});
   }
  }
 }
 console.log(JSON.stringify(results));app.exit(0);
}).catch(error=>{console.error(error);app.exit(1)});
`);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const {stdout}=await promisify(execFile)(electron,[runner],{env,timeout:60000,maxBuffer:5_000_000});
  const results=JSON.parse(stdout.trim().split('\n').at(-1));
  for(const result of results){
    const context=JSON.stringify(result);
    if(result.mode==='disabled')assert.equal(result.focused,false,context);
    else {
      assert.equal(result.focused,true,context);
      if(result.outline!=='none')assert.ok(result.outlineChroma<30,`Input must not show a blue outline: ${context}`);
      assert.ok(result.outline!=='none'||result.shadow!=='none'||(result.surfaceShadow&&result.surfaceShadow!=='none'),`A visible focus cue is required: ${context}`);
    }
    if(result.type==='textarea')assert.equal(result.resize,'none',context);
  }
  console.log(JSON.stringify({inputDefinitions:inventory.length,states:results.length,passed:results.length,files:[...new Set(inventory.map(item=>item.file))]}));
}finally{await rm(temp,{recursive:true,force:true});}
