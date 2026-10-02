const {app,BrowserWindow,nativeTheme}=require("electron");
const fs=require("node:fs/promises");
const assert=require("node:assert/strict");

const url=process.env.DCODE_TEST_URL,output=process.env.DCODE_TEST_OUTPUT;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let win;
const run=code=>win.webContents.executeJavaScript(code,true);
async function until(code,label){
  for(let attempt=0;attempt<200;attempt++){if(await run(code))return;await sleep(25);}
  throw Error("Timeout "+label);
}
async function openAdd(){
  await run('document.querySelector("[aria-label=添加内容]").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",code:"Enter",bubbles:true}))');
  await until('!!document.querySelector(".composer-add-menu")',"add menu");
}
async function setText(value){
  await run('(()=>{const e=document.querySelector("[data-composer]");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(e,'+JSON.stringify(value)+');e.dispatchEvent(new Event("input",{bubbles:true}));})()');
}
async function key(value){
  await run('document.querySelector("[data-composer]").dispatchEvent(new KeyboardEvent("keydown",{key:'+JSON.stringify(value)+',bubbles:true}))');
}
async function capture(name){
  await sleep(70);
  await fs.writeFile(output+"/"+name+".png",(await win.webContents.capturePage()).toPNG());
}
async function main(){
  win=new BrowserWindow({show:false,width:1200,height:900,webPreferences:{backgroundThrottling:false,sandbox:true}});
  nativeTheme.themeSource="dark";
  await win.loadURL(url);
  await until('!!document.querySelector("[data-composer]")',"composer");
  const before=await run('(()=>{const r=document.querySelector(".composer").getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};})()');
  await openAdd();
  await until('document.querySelectorAll(".composer-add-option.capability").length===174',"capability catalog");
  assert.equal(await run('document.querySelector(".composer-add-heading").textContent'),"添加");
  assert.deepEqual(await run('Array.from(document.querySelectorAll(".composer-add-option:not(.capability)")).map(e=>e.textContent.trim())'),["附件","目标","工作流"]);
  assert.equal(await run('document.querySelectorAll(".composer-add-group").length'),3);
  assert.equal(await run('document.querySelector(".composer-add-list").scrollHeight>document.querySelector(".composer-add-list").clientHeight'),true);
  await sleep(80);
  const after=await run('(()=>{const r=document.querySelector(".composer").getBoundingClientRect(),p=document.querySelector(".composer-add-menu").getBoundingClientRect();return {composer:{x:r.x,y:r.y,width:r.width,height:r.height},panel:{left:p.left,top:p.top,right:p.right,bottom:p.bottom}};})()');
  assert.deepEqual(after.composer,before);
  assert.ok(after.panel.left>=7&&after.panel.top>=7&&after.panel.right<=1200-7&&after.panel.bottom<=900-7,"panel "+JSON.stringify(after.panel));
  await capture("add-menu-dark");
  await run('document.querySelector(".composer-add-option.capability").click()');
  await until('window.currentDraft==="/skill:507-breakdown "',"canonical skill prefill");
  assert.equal(await run('window.submissions.length'),0);
  await setText("/breakdown");
  await until('document.querySelectorAll("#composer-commands [role=option]").length===1',"slash skill search");
  await key("Enter");
  assert.equal(await run('window.currentDraft'),"/skill:507-breakdown ");
  await setText("/compact");
  await until('!!document.querySelector("#composer-commands")',"manual command");
  assert.equal(await run('document.querySelectorAll("#composer-commands [role=option]").length'),0);
  await key("Enter");
  await until('window.submissions.length===1',"manual command sent");
  assert.equal(await run('window.submissions[0]'),"/compact");
  nativeTheme.themeSource="light";win.setContentSize(760,560);
  await openAdd();await capture("add-menu-light-narrow");
  const narrow=await run('(()=>{const r=document.querySelector(".composer-add-menu").getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight};})()');
  assert.ok(narrow.left>=7&&narrow.top>=7&&narrow.right<=narrow.width-7&&narrow.bottom<=narrow.height-7);
  await run('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
  await win.loadURL(url+"?mode=error");
  await until('!!document.querySelector("[data-composer]")',"error composer");
  await openAdd();
  await until('!!document.querySelector(".composer-add-state[role=alert]")',"error state");
  await win.loadURL(url+"?mode=empty");
  await until('!!document.querySelector("[data-composer]")',"empty composer");
  await openAdd();
  await until('document.querySelector(".composer-add-state")?.textContent.includes("当前没有")',"empty state");
  return {passed:true,capabilities:174,groups:3,draftPreserved:true,manualCommand:true,narrow:true,errorAndEmpty:true};
}
app.whenReady().then(async()=>{
  try{const result=await main();await fs.writeFile(output+"/result.json",JSON.stringify(result));app.quit();}
  catch(error){if(win)await capture("failure").catch(()=>{});await fs.writeFile(output+"/result.json",JSON.stringify({passed:false,error:String(error),stack:error.stack}));app.exit(1);}
});
