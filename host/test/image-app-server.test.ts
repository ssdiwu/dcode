import test from 'node:test';import assert from 'node:assert/strict';
import {CodexImageBackend} from '../src/image-app-server.js';
import {ImageGenerationError} from '../src/image-generation-types.js';
function transport(){
 const written:string[]=[];let resolved=false;
 const backend=Object.create(CodexImageBackend.prototype) as any;
 Object.assign(backend,{pending:new Map(),sequence:0,buffer:'',closed:false,signal:new AbortController().signal,threadId:'owned-thread',turnId:'owned-turn',turnRequested:true,imageCount:0,imageStarted:false,turnCompleted:false,child:{stdin:{write:(text:string)=>written.push(text)}},close:async()=>{backend.closed=true;}});
 const completion=new Promise<any>((resolve,reject)=>{backend.completion={resolve:(result:unknown)=>{resolved=true;resolve(result);},reject};});void completion.catch(()=>{});
 const notify=(method:string,item:unknown)=>backend.notification(method,{threadId:'owned-thread',turnId:'owned-turn',item});
 return {backend,written,completion,notify,get resolved(){return resolved;}};
}
const image={id:'only-image',type:'imageGeneration',status:'completed',result:'aW1hZ2U='};
test('image completion waits for a successful terminal turn and rejects a second image before acceptance',async()=>{
 const f=transport();f.notify('item/started',image);f.notify('item/completed',image);assert.equal(f.resolved,false);
 f.notify('item/started',{...image,id:'unexpected-second-image'});await assert.rejects(f.completion,{code:'IMAGE_MULTIPLE_RESULTS'});assert.equal(f.resolved,false);
});
test('failed terminal turn preserves a provisional result without resolving success',async()=>{
 const f=transport();f.notify('item/started',image);f.notify('item/completed',image);f.backend.notification('turn/completed',{threadId:'owned-thread',turn:{id:'owned-turn',status:'failed'}});
 await assert.rejects(f.completion,(error:unknown)=>error instanceof ImageGenerationError&&error.code==='IMAGE_TURN_INCOMPLETE'&&error.result?.data===image.result&&error.result.terminalStatus==='failed');assert.equal(f.resolved,false);
});
test('a successful owned terminal turn resolves one image; events from other turns are ignored',async()=>{
 const f=transport();f.backend.notification('item/completed',{threadId:'other-thread',turnId:'owned-turn',item:image});assert.equal(f.backend.result,undefined);
 f.notify('item/started',image);f.notify('item/completed',image);f.backend.notification('turn/completed',{threadId:'owned-thread',turn:{id:'owned-turn',status:'completed'}});assert.equal((await f.completion).data,image.result);assert.equal(f.resolved,true);
});
test('approval and dynamic-tool requests receive explicit refusal and abort the image capability',async()=>{
 for(const method of ['item/commandExecution/requestApproval','item/fileChange/requestApproval','item/permissions/requestApproval','item/tool/call']){const f=transport();f.backend.consume(JSON.stringify({id:42,method,params:{threadId:'owned-thread'}})+'\n');await assert.rejects(f.completion,{code:'IMAGE_UNEXPECTED_REQUEST'});const answer=JSON.parse(f.written[0]!);assert.equal(answer.id,42);assert.ok(answer.error);assert.equal(f.backend.closed,true);}
});
test('command, patch, and MCP result events fail the capability instead of entering the artifact pipeline',async()=>{
 for(const type of ['commandExecution','fileChange','mcpToolCall']){const f=transport();f.notify('item/started',{type,id:'forbidden'});await assert.rejects(f.completion,{code:'IMAGE_ISOLATION_VIOLATION'});assert.equal(f.resolved,false);}
});
test('Free and unknown subscription eligibility do not advertise image availability',async()=>{
 for(const planType of ['free','unknown']){const f=transport();f.backend.request=async()=>({account:{type:'chatgpt',planType}});const result=await f.backend.accountCapability();assert.equal(result.available,false);assert.equal(result.reasonCode,planType==='free'?'IMAGE_PLAN_UNSUPPORTED':'IMAGE_ELIGIBILITY_UNKNOWN');}
});
test('feature inventory is fully paginated and rejects repeated cursors',async()=>{
 const f=transport();let calls=0;f.backend.request=async(_method:string,params:any)=>{calls++;return params.cursor?{data:[{name:'goals',enabled:false}],nextCursor:null}:{data:Array.from({length:100},(_,index)=>({name:`flag-${index}`,enabled:false})),nextCursor:'page2'};};assert.equal((await f.backend.inventory('experimentalFeature/list')).length,101);assert.equal(calls,2);
 f.backend.request=async()=>({data:[],nextCursor:'same'});await assert.rejects(f.backend.inventory('experimentalFeature/list'),{code:'IMAGE_ISOLATION_UNAVAILABLE'});
});
