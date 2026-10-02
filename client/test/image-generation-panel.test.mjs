import test from 'node:test';import assert from 'node:assert/strict';import {JSDOM} from 'jsdom';import {createServer} from 'vite';import {fileURLToPath} from 'node:url';
const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://localhost/',pretendToBeVisual:true});
for(const key of ['window','document','HTMLElement','HTMLTextAreaElement','Node','Element','MutationObserver','Event','KeyboardEvent','MouseEvent','getComputedStyle'])Object.defineProperty(globalThis,key,{value:dom.window[key],configurable:true});Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true});globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const React=await import('react'),{render,screen,waitFor,cleanup,fireEvent}=await import('@testing-library/react');
const server=await createServer({configFile:fileURLToPath(new URL('../vite.config.ts',import.meta.url)),server:{middlewareMode:true},appType:'custom'});
const {ImageGenerationPanel}=await server.ssrLoadModule('/src/components/ImageGenerationPanel.tsx');const language=await server.ssrLoadModule('/@fs'+fileURLToPath(new URL('../src/shared/ui-language.ts',import.meta.url)));await server.close();
function setup(id,options={}){
 const calls=[],work={task:{id,state:'active'},session:{id:'session-'+id,kind:'coordination'},draftKey:'session-'+id,draft:{text:'普通草稿 KEEP',attachments:[]},preferences:{language:'zh-CN'},mutateStore:async(method,params)=>{calls.push({method,params});return options.mutate?options.mutate(method,params):{generation:{id:'generation',requestId:params.requestId,taskId:id,state:'failed',revision:1,createdAt:new Date().toISOString(),description:params.description}};},addAttachment:(key,attachment)=>{calls.push({key,attachment});}};
 window.dcode={subscribe:()=>()=>{},request:async(method,params)=>{calls.push({method,params});if(method==='imageGeneration.capability')return {available:false,reasonCode:'IMAGE_ACCOUNT_REQUIRED'};return {generations:options.records??[]};},exportGeneratedImage:async()=>true};
 return {work,calls};
}
test('opening and closing the form does not call image service or replace the ordinary draft',async()=>{
 const f=setup('open');let closed=false;try{render(React.createElement(ImageGenerationPanel,{work:f.work,onClose(){closed=true;}}));await waitFor(()=>assert.ok(f.calls.some(call=>call.method==='imageGeneration.list')));fireEvent.change(screen.getByRole('textbox',{name:'图像描述'}),{target:{value:'新的图片描述'}});fireEvent.click(screen.getByRole('button',{name:'关闭图像生成'}));assert.equal(closed,true);assert.equal(f.work.draft.text,'普通草稿 KEEP');assert.ok(!f.calls.some(call=>['imageGeneration.start','imageGeneration.capability','imageGeneration.connect'].includes(call.method)));}finally{cleanup();}
});
test('a definite rejection keeps the description editable and shows the actionable reason once',async()=>{
 for(const code of ['IMAGE_DESCRIPTION_CONTAINS_CREDENTIAL','IMAGE_CONNECTION_BUSY']){
  const f=setup('reject-'+code,{mutate:async()=>{throw Error(code);}});try{render(React.createElement(ImageGenerationPanel,{work:f.work,onClose(){}}));const input=screen.getByRole('textbox',{name:'图像描述'});fireEvent.change(input,{target:{value:'待修正描述'}});fireEvent.click(screen.getByRole('button',{name:'生成一张'}));await waitFor(()=>assert.equal(input.disabled,false));await waitFor(()=>assert.ok(screen.getByRole('alert')));assert.ok(screen.getByRole('alert').textContent.includes(code.includes('CREDENTIAL')?'可能包含凭据':'正在连接账号'));assert.equal(screen.queryByRole('button',{name:'重新提交原请求'}),null);fireEvent.change(input,{target:{value:'修改后的描述'}});assert.equal(input.value,'修改后的描述');}finally{cleanup();}
 }
});
test('capability failure names the missing account instead of a generic failure',async()=>{
 const f=setup('account');try{render(React.createElement(ImageGenerationPanel,{work:f.work,onClose(){}}));fireEvent.click(screen.getByRole('button',{name:'检查 Codex 账号'}));await waitFor(()=>assert.match(screen.getByRole('alert').textContent,/请先连接 Codex 的 ChatGPT 订阅账号/));}finally{cleanup();}
});
test('an uncertain submission uses an explicit resubmit action and preserves its request identity',async()=>{
 let attempts=0;const f=setup('uncertain',{mutate:async(_method,params)=>{if(++attempts===1)throw Error('REQUEST_TIMEOUT');return {generation:{id:'gen',requestId:params.requestId,state:'unknown',taskId:'uncertain',createdAt:new Date().toISOString(),description:params.description,revision:1}};}});
 try{render(React.createElement(ImageGenerationPanel,{work:f.work,onClose(){}}));const input=screen.getByRole('textbox',{name:'图像描述'});fireEvent.change(input,{target:{value:'明确描述'}});fireEvent.click(screen.getByRole('button',{name:'生成一张'}));await waitFor(()=>assert.ok(screen.getByRole('button',{name:'重新提交原请求'})));assert.equal(input.disabled,true);fireEvent.click(screen.getByRole('button',{name:'重新提交原请求'}));await waitFor(()=>assert.equal(attempts,2));const submitted=f.calls.filter(call=>call.method==='imageGeneration.start');assert.equal(submitted[0].params.requestId,submitted[1].params.requestId);assert.equal(f.work.draft.text,'普通草稿 KEEP');}finally{cleanup();}
});
test('provisional images can be inspected but never offered as successful input attachments or exports',async()=>{
 const f=setup('provisional',{records:[{id:'provisional',state:'unknown',errorCode:'IMAGE_TURN_INCOMPLETE',terminalStatus:'failed',resultInfo:{bytes:68},createdAt:new Date().toISOString(),description:'原始描述',revision:1}]});
 try{render(React.createElement(ImageGenerationPanel,{work:f.work,onClose(){}}));await waitFor(()=>assert.ok(screen.getByRole('button',{name:'查看已保存的待核对图片'})));assert.equal(screen.queryByRole('button',{name:'用作输入附件'}),null);assert.equal(screen.queryByRole('button',{name:'导出图片'}),null);}finally{cleanup();}
});

test('a result proof without a verified saved image does not offer a saved-image preview',async()=>{
 const f=setup('proof-only',{records:[{id:'proof-only',state:'unknown',terminalStatus:'failed',resultInfo:{bytes:68},createdAt:new Date().toISOString(),description:'尚未发布的图片',revision:1}]});
 try{render(React.createElement(ImageGenerationPanel,{work:f.work,onClose(){}}));await waitFor(()=>assert.ok(screen.getByRole('button',{name:'重新核对记录'})));assert.equal(screen.queryByRole('button',{name:'查看已保存的待核对图片'}),null);assert.equal(screen.queryByRole('button',{name:'用作输入附件'}),null);assert.equal(screen.queryByRole('button',{name:'导出图片'}),null);}finally{cleanup();}
});

test('a returned managed attachment is added to the existing draft without importing it a second time',async()=>{
 const attachment={id:'attachment-123',name:'image.png',mimeType:'image/png',digest:'sha256:fixture',bytes:68,expiresAt:new Date(Date.now()+86400000).toISOString()};
 const f=setup('attach',{records:[{id:'generated',state:'succeeded',createdAt:new Date().toISOString(),description:'Original image description',revision:1}],mutate:async()=>({attachment})});
 f.work.updateDraft=(owner,update)=>{assert.equal(owner,f.work.draftKey);f.work.draft=update(f.work.draft);};f.work.addAttachment=()=>{throw Error('managed metadata must not be imported as a new AttachmentSource');};
 try{render(React.createElement(ImageGenerationPanel,{work:f.work,onClose(){}}));await waitFor(()=>assert.ok(screen.getByRole('button',{name:'用作输入附件'})));fireEvent.click(screen.getByRole('button',{name:'用作输入附件'}));await waitFor(()=>assert.equal(f.work.draft.attachments.length,1));assert.equal(f.work.draft.text,'普通草稿 KEEP');assert.equal(f.work.draft.attachments[0].id,attachment.id);assert.equal(f.calls.filter(call=>call.method==='imageGeneration.attach').length,1);}finally{cleanup();}
});

test('saved service, generation, isolation and validation failures keep actionable reasons in both languages',async()=>{
 const codes=['IMAGE_SERVICE_EXITED','IMAGE_SERVICE_REQUEST_FAILED','IMAGE_GENERATION_FAILED','IMAGE_GENERATION_TIMEOUT','IMAGE_VALIDATION_UNAVAILABLE','IMAGE_ISOLATION_VIOLATION','IMAGE_MULTIPLE_RESULTS'];
 for(const displayLanguage of ['zh-CN','en']){
  language.setDisplayLanguage(displayLanguage);
  const f=setup('saved-errors-'+displayLanguage,{records:codes.map((errorCode,index)=>({id:'error-'+index,state:'unknown',errorCode,createdAt:new Date().toISOString(),description:'User-authored 中文 description '+index,revision:1}))});f.work.preferences.language=displayLanguage;
  try{render(React.createElement(ImageGenerationPanel,{work:f.work,onClose(){}}));await waitFor(()=>assert.equal(document.querySelectorAll('.image-generation-record').length,codes.length));
   const reasons=Array.from(document.querySelectorAll('.image-generation-record'),element=>element.querySelector('p.muted').textContent);
   assert.equal(reasons.length,codes.length);assert.equal(new Set(reasons).size,codes.length);
   for(const reason of reasons){assert.ok(!reason.includes('图像操作未完成')&&!reason.includes('Image operation incomplete'));if(displayLanguage==='en')assert.ok(!/\p{Script=Han}/u.test(reason));}
   assert.ok(document.body.textContent.includes('User-authored 中文 description 0'));
  }finally{cleanup();language.setDisplayLanguage('zh-CN');}
 }
});
