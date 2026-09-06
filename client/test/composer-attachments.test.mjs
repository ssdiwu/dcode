import test from "node:test";
import assert from "node:assert/strict";
import {JSDOM} from "jsdom";
import {createServer} from "vite";
import {fileURLToPath} from "node:url";


const dom=new JSDOM("<!doctype html><html><body></body></html>",{url:"http://localhost/",pretendToBeVisual:true});
for(const key of ["window","document","HTMLElement","HTMLTextAreaElement","Node","Element","MutationObserver","Event","KeyboardEvent","MouseEvent","File","FileReader","getComputedStyle"])
  Object.defineProperty(globalThis,key,{value:dom.window[key],configurable:true});
Object.defineProperty(globalThis,"navigator",{value:dom.window.navigator,configurable:true});
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
globalThis.ResizeObserver=class{observe(){}disconnect(){}};
const React=await import("react");
const {render,screen,fireEvent,waitFor,cleanup,act}=await import("@testing-library/react");
const server=await createServer({configFile:fileURLToPath(new URL("../vite.config.ts",import.meta.url)),server:{middlewareMode:true},appType:"custom"});
const {Composer}=await server.ssrLoadModule("/src/components/Composer.tsx");
await server.close();
const models={data:{models:[{key:"m",name:"模型",available:true}],selectedKey:"m",thinkingLevels:[]}};
let current, switchDraft;
const errors=[], previews=[];
let attachmentSequence=0;
window.dcode={request:async()=>({data:"iVBORw0KGgo="})};
function Harness(){
  const [key,setKey]=React.useState("a");
  const [drafts,setDrafts]=React.useState({a:{text:"保留原文",images:[],attachments:[]},b:{text:"另一任务",images:[],attachments:[]}});
  current=drafts[key];switchDraft=setKey;
  const work={draft:current,draftKey:key,snapshot:{projects:[]},error:null,session:{id:key},task:{id:key},updateDraft:(id,update)=>setDrafts(previous=>({...previous,[id]:typeof update==="function"?update(previous[id]):update})),fail:error=>errors.push(String(error)),send(){},previewAttachment:id=>previews.push(id),trackAttachmentImport(){},addAttachment:async(id,source)=>{
    await new Promise(resolve=>setTimeout(resolve,5));
    const name=source.path?.split("/").at(-1)??source.name;
    const attachment={id:`attachment-${(++attachmentSequence).toString(16).padStart(32,"0")}`,name,mimeType:name.endsWith("png")?"image/png":"application/pdf",bytes:4,digest:"sha256:"+"a".repeat(64),createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+86400000).toISOString()};
    setDrafts(previous=>({...previous,[id]:{...previous[id],attachments:[...previous[id].attachments,attachment]}}));
    return attachment;
  }};
  return React.createElement(Composer,{work,models,pathForFile:file=>`/tmp/${file.name}`,onSettings(){}});
}
const png=()=>new File([new Uint8Array([137,80,78,71])],"截图.png",{type:"image/png"});
const pdf=()=>new File(["%PDF fixture"],"说明.pdf",{type:"application/pdf"});
const transfer=files=>({types:["Files"],files,dropEffect:"none"});

test("mixed file drop adds an image thumbnail and removable file badge while preserving the typed draft",async()=>{
  render(React.createElement(Harness));
  try {
    const composer=document.querySelector(".composer"),dataTransfer=transfer([png(),pdf()]);
    assert.equal(fireEvent.dragEnter(composer,{dataTransfer}),false);
    assert.match(composer.className,/is-dragging/);
    assert.equal(fireEvent.dragOver(composer,{dataTransfer}),false);
    assert.equal(dataTransfer.dropEffect,"copy");
    assert.equal(fireEvent.drop(screen.getByRole("textbox",{name:"任务消息"}),{dataTransfer}),false);
    await waitFor(()=>assert.equal(current.attachments.length,2));
    assert.match(screen.getByAltText("截图.png").getAttribute("src"),/^data:image\/png;base64,/);
    assert.ok(screen.getByText("PDF"));assert.ok(screen.getByText("说明.pdf"));
    assert.equal(current.text,"保留原文");
    fireEvent.click(screen.getByRole("button",{name:"预览 说明.pdf"}));
    assert.equal(previews.at(-1),current.attachments[1].id);
    fireEvent.click(screen.getByRole("button",{name:"移除附件 说明.pdf"}));
    assert.equal(current.attachments.length,1);
    fireEvent.click(screen.getByRole("button",{name:"移除附件 截图.png"}));
    assert.equal(current.attachments.length,0);assert.equal(current.text,"保留原文");
  } finally {cleanup();}
});

test("paste and chooser use the same attachment path, and pending reads cannot cross task boundaries",async()=>{
  errors.length=0;render(React.createElement(Harness));
  try {
    fireEvent.paste(screen.getByRole("textbox"),{clipboardData:{files:[png()]}});
    await waitFor(()=>assert.equal(current.attachments.length,1));
    const chooser=document.querySelector('input[type="file"]:not([accept])');
    fireEvent.change(chooser,{target:{files:[pdf()]}});
    await waitFor(()=>assert.equal(current.attachments.length,2));
    const composer=document.querySelector(".composer");
    fireEvent.drop(composer,{dataTransfer:transfer([png()])});
    act(()=>switchDraft("b"));
    await act(async()=>{await new Promise(resolve=>setTimeout(resolve,25));});
    assert.equal(current.attachments.length,0);assert.equal(current.text,"另一任务");
    act(()=>switchDraft("a"));
    assert.equal(current.attachments.length,3);
  } finally {cleanup();}
});
