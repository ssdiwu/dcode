import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import electron from 'electron';

// The production CSS must fit the complete image, with card dimensions following its aspect ratio.
const cases=[{name:'wide',width:1200,height:300},{name:'portrait',width:240,height:960},{name:'square',width:900,height:900},{name:'small',width:100,height:60}];
const temp=await mkdtemp(join(tmpdir(),'dcode-inspiration-geometry-'));
try {
  const assets=fileURLToPath(new URL('../../dist/renderer/assets',import.meta.url));
  const links=(await readdir(assets)).filter(name=>name.endsWith('.css')).map(name=>`<link rel="stylesheet" href="${pathToFileURL(join(assets,name)).href}">`).join('');
  const cards=cases.map((item,index)=>{
    const source='data:image/svg+xml;base64,'+Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${item.width}" height="${item.height}"><rect width="100%" height="100%" fill="#aaa"/></svg>`).toString('base64');
    return `<article class="idea-node" data-kind="image" data-name="${item.name}" style="left:${index*380}px;top:50px"><div class="idea-node-title"><strong>完整图片</strong></div><img class="idea-node-image" src="${source}"><div class="idea-node-meta">图片</div></article>`;
  }).join('');
  const page=join(temp,'page.html'),runner=join(temp,'runner.cjs');
  await writeFile(page,`<!doctype html><html><head>${links}</head><body>${cards}</body></html>`);
  await writeFile(runner,`
const {app,BrowserWindow,nativeTheme}=require('electron');
app.setPath('userData',${JSON.stringify(join(temp,'profile'))});
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1600,height:900,webPreferences:{sandbox:true}});
 await win.loadFile(${JSON.stringify(page)});const results=[];
 for(const theme of ['light','dark']){
  nativeTheme.themeSource=theme;
  results.push(...await win.webContents.executeJavaScript('('+(${async function(theme){
    await Promise.all([...document.images].map(image=>image.decode()));
    return [...document.querySelectorAll('.idea-node')].map(card=>{
      const image=card.querySelector('img'),box=card.getBoundingClientRect(),ib=image.getBoundingClientRect();
      return {theme,name:card.dataset.name,width:box.width,height:box.height,imageWidth:ib.width,imageHeight:ib.height,naturalWidth:image.naturalWidth,naturalHeight:image.naturalHeight,fit:getComputedStyle(image).objectFit,inside:ib.left>=box.left&&ib.right<=box.right&&ib.top>=box.top&&ib.bottom<=box.bottom};
    });
  }.toString()})+')('+JSON.stringify(theme)+')'));
 }
 console.log(JSON.stringify(results));app.exit(0);
}).catch(error=>{console.error(error);app.exit(1)});
`);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const {stdout}=await promisify(execFile)(electron,[runner],{env,timeout:30000,maxBuffer:100000});
  const results=JSON.parse(stdout.trim().split('\n').at(-1));
  for(const item of results){
    assert.equal(item.inside,true,JSON.stringify(item));assert.equal(item.fit,'contain');
    assert.ok(Math.abs(item.imageWidth/item.naturalWidth-item.imageHeight/item.naturalHeight)<.001,JSON.stringify(item));
    assert.ok(item.width<=350&&item.imageHeight<=260&&item.imageWidth<=320,JSON.stringify(item));
  }
  for(const theme of ['light','dark']){
    const byName=Object.fromEntries(results.filter(item=>item.theme===theme).map(item=>[item.name,item]));
    assert.ok(byName.wide.width>byName.portrait.width);
    assert.ok(byName.portrait.height>byName.wide.height);
    assert.ok(byName.small.height<byName.square.height);
  }
  console.log(JSON.stringify({passed:results.length,cards:results}));
}finally{await rm(temp,{recursive:true,force:true});}
