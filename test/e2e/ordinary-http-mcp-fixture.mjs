// 本地受控 HTTP 对端，模块导入不启动服务。 start() is explicit; importing this module opens nothing.
// Prepare an owned child of tmpdir(), .fixture-owner=nonce, and input.txt.
// Returned origin is the complete MCP URL (including /mcp), not just its host.
// Assert call.start counts as well as effects: append_once idempotence is not proof of no replay.
import {createServer} from 'node:http';
import {open,realpath,writeFile,rename,rm} from 'node:fs/promises';
import {constants,watch} from 'node:fs';
import {join,relative,isAbsolute,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';

export async function start(ownedRoot,nonce,{holdCancelAck=false}={}) {
 if(!isAbsolute(ownedRoot??'')||!/^[A-Za-z0-9_-]{8,100}$/.test(nonce??''))throw Error('owned root/nonce required');
 const root=await realpath(ownedRoot),rel=relative(await realpath(tmpdir()),root);
 if(!rel||rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel))throw Error('root must be an owned tmp child');
 async function readOwn(name,missing=false) {
  let h;
  try{
   h=await open(join(root,name),constants.O_RDONLY|constants.O_NOFOLLOW);
   const stat=await h.stat();if(!stat.isFile()||stat.size>65536)throw Error('invalid fixture file');
   return await h.readFile('utf8');
  }catch(e){if(missing&&e.code==='ENOENT')return '';throw e;}
  finally{await h?.close();}
 }
 if((await readOwn('.fixture-owner')).trim()!==nonce)throw Error('unowned root');
 const events=[],sessions=new Map(),sockets=new Map(),active=new Set();
 const protocol='2025-11-25',base=`fixture://${nonce}/`,disk=join(root,'effects.jsonl');
 let sequence=0,socketSequence=0,closing=false,closePromise,writing=false;
 const trace=(type,fields={})=>events.push({type,nonce,seq:++sequence,...fields});
 const validId=id=>typeof id==='number'&&Number.isFinite(id)||typeof id==='string'&&id.length<=128;
 const tokenOK=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(x);
 const check=s=>{if(s.aborted)throw Object.assign(Error('cancelled'),{name:'AbortError'});};
 const answer=(data,isError=false)=>({content:[{type:'text',text:JSON.stringify({nonce,...data})}],...(isError?{isError:true}:{})});
 const shape=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false});
 const token={type:'string',pattern:'^[A-Za-z0-9_-]{1,100}$'};
 const tools=[{name:'read',inputSchema:shape({})},
  {name:'append_once',inputSchema:shape({token,text:{type:'string',maxLength:4096}},['token','text'])},
  ...['fail','wait'].map(name=>({name,inputSchema:shape({token},['token'])}))];
 const json=(res,id,result,error)=>{
  if(res.destroyed||res.writableEnded)return;
  res.writeHead(200,{'content-type':'application/json'});
  res.end(JSON.stringify({jsonrpc:'2.0',id,...(error?{error}:{result})}));
 };
 const bad=(res,id,code,message)=>json(res,id,undefined,{code,message});
 const empty=(res,status)=>{if(!res.destroyed&&!res.writableEnded)res.writeHead(status).end();};
 async function appendOnce(a,id,sessionId,signal) {
  if(!tokenOK(a.token)||typeof a.text!=='string'||Buffer.byteLength(a.text)>4096||writing)throw Error('invalid/busy append');
  writing=true;const temporary=disk+`.tmp-${randomUUID()}`;
  try{
   const raw=await readOwn('effects.jsonl',true),rows=raw.split('\n').filter(Boolean).map(x=>JSON.parse(x));
   if(rows.some(x=>x.nonce!==nonce))throw Error('foreign effects');
   const old=rows.find(x=>x.token===a.token);
   if(old){if(old.text!==a.text)throw Error('token conflict');trace('effect.reused',{sessionId,requestId:id,token:a.token});return answer({status:'already-appended',token:a.token});}
   check(signal);const next=raw+JSON.stringify({nonce,token:a.token,text:a.text})+'\n';
   if(Buffer.byteLength(next)>65536)throw Error('effect limit');
   await writeFile(temporary,next,{flag:'wx',mode:0o600});check(signal);await rename(temporary,disk);
   trace('effect.committed',{sessionId,requestId:id,token:a.token,cancelledAfterCommit:signal.aborted});
   return answer({status:'appended',token:a.token,file:'effects.jsonl'});
  }finally{writing=false;await rm(temporary,{force:true});}
 }
 async function wait(a,id,sessionId,signal) {
  if(!tokenOK(a.token))throw Error('invalid token');check(signal);
  const releaseFile='release-'+createHash('sha256').update(a.token).digest('hex');
  trace('wait.pending',{sessionId,requestId:id,token:a.token,releaseFile});
  await new Promise((resolve,reject)=>{
   let done=false;
   const finish=error=>{if(done)return;done=true;watcher.close();signal.removeEventListener('abort',cancel);if(error)reject(error);else resolve();};
   const cancel=()=>finish(Object.assign(Error('cancelled'),{name:'AbortError'}));
   const inspect=async()=>{try{check(signal);const text=await readOwn(releaseFile);check(signal);if(text.trim()!==nonce)throw Error('release mismatch');finish();}catch(e){if(e.code!=='ENOENT')finish(e);}};
   const watcher=watch(root,(_event,name)=>{if(name===null||String(name)===releaseFile)void inspect();});
   watcher.once('error',finish);signal.addEventListener('abort',cancel,{once:true});void inspect();
  });check(signal);trace('wait.released',{sessionId,requestId:id,token:a.token});return answer({status:'released',token:a.token});
 }
 async function call(session,m,res) {
  const p=m.params??{},name=p.name,a=p.arguments??{},id=m.id;
  if(!tools.some(t=>t.name===name)||session.pending.has(id))return bad(res,id,-32602,'Invalid tool request');
  const controller=new AbortController(),entry={controller,res,done:null};session.pending.set(id,entry);
  res.once('close',()=>{if(!res.writableFinished){trace('call.http-disconnected',{sessionId:session.id,requestId:id});controller.abort();}});
  trace('call.start',{sessionId:session.id,requestId:id,tool:name,token:tokenOK(a.token)?a.token:null});
  entry.done=(async()=>{
   try{
    let result;
    if(name==='read'){const content=await readOwn('input.txt');check(controller.signal);result=answer({file:'input.txt',content});}
    else if(name==='append_once')result=await appendOnce(a,id,session.id,controller.signal);
    else if(name==='wait')result=await wait(a,id,session.id,controller.signal);
    else {if(!tokenOK(a.token))throw Error('invalid token');result=answer({kind:'expected-tool-error',token:a.token},true);}
    check(controller.signal);trace('call.end',{sessionId:session.id,requestId:id,isError:result.isError===true});json(res,id,result);
   }catch(e){
    if(controller.signal.aborted||e.name==='AbortError'){
     trace('call.cancelled',{sessionId:session.id,requestId:id});
     // No late JSON-RPC response for a removed request. Release only its HTTP POST.
     empty(res,204);
    }else{trace('call.error',{sessionId:session.id,requestId:id,code:e.code??null});json(res,id,answer({kind:'fixture-tool-error'},true));}
   }finally{session.pending.delete(id);}
  })();return entry.done;
 }
 async function drain(session,reason) {
  session.closed=true;for(const entry of session.pending.values())entry.controller.abort();
  await Promise.allSettled([...session.pending.values()].map(entry=>entry.done));
  trace('session.drained',{sessionId:session.id,reason,pending:session.pending.size});
 }
 async function handle(req,res) {
  const socketId=sockets.get(req.socket)?.id??null,path=req.url==='/mcp'?'/mcp':'other';
  const method=['POST','GET','DELETE'].includes(req.method)?req.method:'other';
  trace('http.received',{socketId,method,path});
  res.once('finish',()=>trace('http.response-finished',{socketId,method,status:res.statusCode}));
  res.once('close',()=>trace('http.response-closed',{socketId,method,finished:res.writableFinished}));
  if(path!=='/mcp')return empty(res,404);
  if(closing)return empty(res,503);
  const header=req.headers['mcp-session-id'],session=typeof header==='string'?sessions.get(header):undefined;
  if(method==='GET'){
   if(!session||session.closed)return empty(res,404);
   if(req.headers['mcp-protocol-version']!==protocol)return empty(res,400);
   trace('get.unsupported',{sessionId:session.id});return empty(res,405);
  }
  if(method==='DELETE'){
   if(!session||session.closed)return empty(res,404);
   if(req.headers['mcp-protocol-version']!==protocol)return empty(res,400);
   trace('delete.received',{sessionId:session.id,socketId});sessions.delete(session.id);
   await drain(session,'DELETE');res.setHeader('connection','close');
   // TCP connections may carry other sessions; close only this DELETE response's connection.
   return empty(res,204);
  }
  if(method!=='POST')return empty(res,405);
  let message;
  try{
   const chunks=[];let length=0;
   for await(const chunk of req){length+=chunk.length;if(length>65536)throw Error('oversize');chunks.push(chunk);}
   message=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }catch{return bad(res,null,-32700,'Invalid JSON');}
  if(!message||message.jsonrpc!=='2.0'||typeof message.method!=='string'||(message.id!==undefined&&!validId(message.id)))return bad(res,null,-32600,'Invalid request');
  const id=message.id,p=message.params??{};
  if(message.method==='initialize'&&id!==undefined){
   if(header!==undefined||p.protocolVersion!==protocol)return bad(res,id,-32602,'Invalid initialization');
   const fresh={id:randomUUID(),ready:false,closed:false,pending:new Map()};sessions.set(fresh.id,fresh);
   trace('initialize',{sessionId:fresh.id,requestId:id,socketId});res.setHeader('Mcp-Session-Id',fresh.id);
   return json(res,id,{protocolVersion:protocol,capabilities:{tools:{},resources:{}},serverInfo:{name:'isolated-dcode-http',version:'draft'}});
  }
  if(!session||session.closed)return empty(res,404);
  if(req.headers['mcp-protocol-version']!==protocol)return bad(res,id??null,-32602,'Invalid protocol');
  if(id===undefined){
   if(message.method==='notifications/initialized'){session.ready=true;trace('initialized',{sessionId:session.id});}
   else if(message.method==='notifications/cancelled'){
    const entry=validId(p.requestId)?session.pending.get(p.requestId):undefined;
    trace('cancel.received',{sessionId:session.id,requestId:validId(p.requestId)?p.requestId:null,matched:!!entry});entry?.controller.abort();
    if(holdCancelAck){trace('cancel.ack-held',{sessionId:session.id,requestId:p.requestId});await new Promise(resolve=>res.once('close',resolve));trace('cancel.ack-released',{sessionId:session.id,requestId:p.requestId});}
   }
   return empty(res,202);
  }
  if(message.method==='ping')return json(res,id,{});
  if(!session.ready)return bad(res,id,-32000,'Not initialized');
  if(message.method==='tools/list')return json(res,id,{tools});
  if(message.method==='tools/call')return call(session,message,res);
  if(message.method==='resources/list')return json(res,id,{resources:[{uri:base+'input',name:'fixture input',mimeType:'text/plain'}]});
  if(message.method==='resources/templates/list')return json(res,id,{resourceTemplates:[{uriTemplate:base+'files/{name}',name:'owned fixture files',mimeType:'text/plain'}]});
  if(message.method==='resources/read'){
   const file=p.uri===base+'input'||p.uri===base+'files/input'?'input.txt':p.uri===base+'files/effects'?'effects.jsonl':null;
   trace('resource.read',{sessionId:session.id,requestId:id,ownURI:file!==null});
   if(file===null)return bad(res,id,-32602,'Resource outside owned URI set');
   const text=await readOwn(file,file==='effects.jsonl');return json(res,id,{contents:[{uri:p.uri,mimeType:'text/plain',text:JSON.stringify({nonce,file,content:text})}]});
  }
  return bad(res,id,-32601,'Method not found');
 }
 const server=createServer((req,res)=>{
  const work=handle(req,res).catch(()=>{trace('http.handler-error');if(!res.headersSent)bad(res,null,-32603,'Fixture error');else res.destroy();});
  active.add(work);void work.finally(()=>active.delete(work));
 });
 server.on('connection',socket=>{
  const entry={id:++socketSequence};sockets.set(socket,entry);trace('socket.opened',{socketId:entry.id});
  socket.once('close',hadError=>{sockets.delete(socket);trace('socket.closed',{socketId:entry.id,hadError});});
  socket.on('error',()=>trace('socket.error',{socketId:entry.id}));
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.removeListener('error',reject);resolve();});});
 const origin=`http://127.0.0.1:${server.address().port}/mcp`;trace('listening');
 const close=()=>closePromise??=(async()=>{
  closing=true;trace('close.begin');await Promise.allSettled([...sessions.values()].map(s=>drain(s,'fixture-close')));sessions.clear();
  const closed=new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  const socketCloses=[...sockets.keys()].map(socket=>new Promise(resolve=>{socket.once('close',resolve);socket.destroy();}));
  await Promise.all([closed,...socketCloses]);await Promise.allSettled([...active]);trace('close.drained',{active:active.size,sockets:sockets.size});
 })();
 return {origin,events,close};
}
