import test from "node:test";
import assert from "node:assert/strict";
import {fileURLToPath} from "node:url";
import {JSDOM} from "jsdom";
import {createServer} from "vite";
const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://localhost',pretendToBeVisual:true});
for(const name of ['window','document','HTMLElement','Element','Node','MutationObserver','Event','MouseEvent','KeyboardEvent','getComputedStyle'])Object.defineProperty(globalThis,name,{value:dom.window[name],configurable:true});
Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true});globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const React=await import('react'),{render,screen,fireEvent,cleanup,waitFor,act}=await import('@testing-library/react'),{SWRConfig}=await import('swr');
const server=await createServer({configFile:fileURLToPath(new URL('../vite.config.ts',import.meta.url)),server:{middlewareMode:true,hmr:false},appType:'custom'});
const{ProviderConnection}=await server.ssrLoadModule('/src/components/ProviderConnection.tsx');const{useModels}=await server.ssrLoadModule('/src/workbench/useModels.ts');await server.close();
const secret='inline-component-private-fixture';
const connection={providerId:'zai-coding-cn',methods:[{type:'api_key',label:'连接 API 密钥'}],state:'disconnected',managed:false,external:false};
const tree=models=>React.createElement('details',{open:true},React.createElement('summary',null,'Provider'),React.createElement(ProviderConnection,{providerId:connection.providerId,models}));
test('inline key is masked, duplicate submit is ignored, failure retries and success clears',async()=>{
 let finish,calls=0;const models={connections:{providers:[connection]},connecting:false,connectApiKey:async(provider,key)=>{assert.equal(provider,connection.providerId);assert.equal(key,secret);calls++;return new Promise(resolve=>{finish=resolve;});}};
 try{render(tree(models));const input=screen.getByLabelText('API Key');assert.equal(input.type,'password');assert.equal(input.name,'');
  fireEvent.input(input,{target:{value:secret}});assert.ok(!document.body.innerHTML.includes(secret));const form=input.closest('form');
  fireEvent.submit(form);fireEvent.submit(form);assert.equal(calls,1);await act(async()=>finish({ok:false,code:'FAILED'}));assert.equal(input.value,secret);assert.ok(screen.getByRole('alert').textContent.includes('重试'));
  fireEvent.submit(form);assert.equal(calls,2);await act(async()=>finish({ok:true}));assert.equal(input.value,'');assert.equal(window.localStorage.length,0);
 }finally{cleanup();}
});
test('cancel, collapse, unmount and switching to OAuth clear the temporary value',async()=>{
 const events=[];const models={connections:{providers:[{...connection,methods:[...connection.methods,{type:'oauth',label:'浏览器登录'}]}]},connecting:false,connect:async(...args)=>events.push(args)};
 try{const view=render(tree(models));const input=screen.getByLabelText('API Key');const fill=()=>fireEvent.input(input,{target:{value:secret}});
  fill();fireEvent.click(screen.getByRole('button',{name:'取消'}));assert.equal(input.value,'');
  fill();fireEvent.keyDown(input,{key:'Escape'});assert.equal(input.value,'');
  fill();const details=input.closest('details');details.open=false;fireEvent(details,new Event('toggle'));assert.equal(input.value,'');details.open=true;
  fill();fireEvent.click(screen.getByRole('button',{name:'浏览器登录'}));assert.equal(input.value,'');assert.deepEqual(events,[[connection.providerId,'oauth']]);
  fill();view.unmount();assert.equal(input.value,'');
 }finally{cleanup();}
});
test('confirmed save clears input even when subsequent metadata refresh fails',async()=>{
 let fail=false,privateCalls=0;const publicCalls=[];const data={models:[],providers:[],refresh:{failedProviders:[],offline:true}};
 window.dcode={subscribe:()=>()=>{},connectApiKey:async(provider,key)=>{assert.equal(key,secret);privateCalls++;fail=true;return{ok:true};},request:async(method,params)=>{publicCalls.push({method,params});if(fail)throw Error('metadata unavailable');return method==='dcodeAuth.get'?{providers:[connection]}:data;}};
 function Harness(){const models=useModels({mutateStore:async()=>{},onChanged:async()=>{},onError:()=>{}});return tree(models);}
 try{render(React.createElement(SWRConfig,{value:{provider:()=>new Map(),dedupingInterval:0,errorRetryCount:0}},React.createElement(Harness)));
  const input=await screen.findByLabelText('API Key');fireEvent.input(input,{target:{value:secret}});fireEvent.submit(input.closest('form'));
  await waitFor(()=>assert.equal(input.value,''));assert.equal(privateCalls,1);assert.ok(!JSON.stringify(publicCalls).includes(secret));
 }finally{cleanup();}
});
test('failed private receipt releases stale saving state even when metadata refresh fails',async()=>{
 let listener=()=>{},saving=false,fail=false,finish;const data={models:[],providers:[],refresh:{failedProviders:[],offline:true}};
 window.dcode={subscribe:fn=>{listener=fn;return()=>{};},connectApiKey:async()=>{saving=true;listener({event:'dcodeAuth.changed'});return new Promise(resolve=>{finish=()=>{fail=true;resolve({ok:false,code:'FAILED'});};});},request:async method=>{if(fail)throw Error('metadata unavailable');return method==='dcodeAuth.get'?{providers:[{...connection,state:saving?'saving':'disconnected',activeMethod:'api_key'}]}:data;}};
 function Harness(){const models=useModels({mutateStore:async()=>{},onChanged:async()=>{},onError:()=>{}});return tree(models);}
 try{render(React.createElement(SWRConfig,{value:{provider:()=>new Map(),dedupingInterval:0,errorRetryCount:0}},React.createElement(Harness)));
  const input=await screen.findByLabelText('API Key');fireEvent.input(input,{target:{value:secret}});fireEvent.submit(input.closest('form'));
  await waitFor(()=>assert.equal(input.disabled,true));await act(async()=>finish());
  await waitFor(()=>assert.equal(input.disabled,false));assert.equal(input.value,secret);fireEvent.click(screen.getByRole('button',{name:'取消'}));assert.equal(input.value,'');
 }finally{cleanup();}
});
