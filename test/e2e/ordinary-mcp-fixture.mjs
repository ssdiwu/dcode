// 本地受控 stdio 对端。 args: [file, ownedTmpRoot, nonce]. Prepare .fixture-owner=nonce and input.txt.
// Pi MCP 1.0: JSON-RPC+LF, 2025-11-25; close=stdin EOF. No agent/input/history queue.
import {readFile,writeFile,rename,rm,appendFile,realpath} from 'node:fs/promises';
import {appendFileSync,watch} from 'node:fs';
import {createInterface} from 'node:readline';
import {join,relative,isAbsolute,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
const [path,nonce]=process.argv.slice(2);
if(!isAbsolute(path??'')||!/^[\w-]{8,100}$/.test(nonce??'')) throw Error('owned root/nonce required');
const root=await realpath(path),rel=relative(await realpath(tmpdir()),root);
if(!rel||rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel)||(await readFile(join(root,'.fixture-owner'),'utf8')).trim()!==nonce) throw Error('unowned root');
const log=join(root,`mcp-events-${process.pid}.jsonl`),disk=join(root,'effects.jsonl');
let seq=0,ready=false,closing=false,writing=false;
const pending=new Map(),active=new Set();
const event=(type,fields={})=>({type,nonce,pid:process.pid,seq:++seq,...fields});
const trace=(type,fields)=>appendFile(log,JSON.stringify(event(type,fields))+'\n',{mode:0o600});
const send=m=>new Promise((yes,no)=>process.stdout.write(JSON.stringify(m)+'\n',e=>e?no(e):yes()));
const ok=(id,result)=>send({jsonrpc:'2.0',id,result});
const bad=(id,code,message)=>send({jsonrpc:'2.0',id,error:{code,message}});
const answer=(data,isError=false)=>({content:[{type:'text',text:JSON.stringify({nonce,...data})}],...(isError?{isError:true}:{})});
const abort=s=>{if(s.aborted)throw Object.assign(Error('cancelled'),{name:'AbortError'});};
const tokenOK=x=>typeof x==='string'&&/^[\w-]{1,100}$/.test(x);
const token={type:'string',pattern:'^[A-Za-z0-9_-]{1,100}$'};
const shape=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false});
const tools=[{name:'read',inputSchema:shape({})},
{name:'append_once',inputSchema:shape({token,text:{type:'string',maxLength:4096}},['token','text'])},
...['fail','wait'].map(name=>({name,inputSchema:shape({token},['token'])}))];
async function append(a,id,s){
 if(!tokenOK(a.token)||typeof a.text!=='string'||Buffer.byteLength(a.text)>4096||writing)throw Error('invalid/busy append');
 writing=true;const tmp=disk+`.tmp-${process.pid}`;
 try{
  const raw=await readFile(disk,'utf8').catch(e=>{if(e.code==='ENOENT')return '';throw e;});
  const old=raw.split('\n').filter(Boolean).map(x=>JSON.parse(x)).find(x=>x.token===a.token);
  if(old){if(old.text!==a.text)throw Error('token conflict');return answer({status:'already-appended',token:a.token});}
  abort(s);const next=raw+JSON.stringify({nonce,token:a.token,text:a.text})+'\n';
  if(Buffer.byteLength(next)>65536)throw Error('effect limit');
  await writeFile(tmp,next,{flag:'wx',mode:0o600});abort(s);await rename(tmp,disk);
  await trace('effect.committed',{requestId:id,token:a.token,cancelledAfterCommit:s.aborted});
  return answer({status:'appended',token:a.token,file:'effects.jsonl'});
 }finally{writing=false;await rm(tmp,{force:true});}
}
async function wait(a,id,s){
 if(!tokenOK(a.token))throw Error('invalid token');
 const file='release-'+createHash('sha256').update(a.token).digest('hex');
 await trace('wait.pending',{requestId:id,token:a.token,releaseFile:file});
 await new Promise((yes,no)=>{
  let done=false;const end=e=>{if(done)return;done=true;w.close();s.removeEventListener('abort',cancel);if(e)no(e);else yes();};
  const cancel=()=>end(Object.assign(Error('cancelled'),{name:'AbortError'}));
  const check=async()=>{try{abort(s);if((await readFile(join(root,file),'utf8')).trim()!==nonce)throw Error('release mismatch');end();}catch(e){if(e.code!=='ENOENT')end(e);}};
  const w=watch(root,(_t,n)=>{if(n===null||String(n)===file)void check();});
  w.once('error',end);s.addEventListener('abort',cancel,{once:true});void check();
 });abort(s);return append({token:'wait_'+a.token,text:'released:'+nonce},id,s);
}
async function dispatch(m){
 if(m?.jsonrpc!=='2.0'||typeof m.method!=='string')return bad(null,-32600,'Invalid request');
 const id=m.id,p=m.params??{};
 if(id===undefined){
  if(m.method==='notifications/initialized'){ready=true;await trace('initialized');}
  if(m.method==='notifications/cancelled'){const c=pending.get(p.requestId);c?.abort();await trace('cancel.received',{requestId:p.requestId??null,matched:!!c});}
  return;
 }
 if(m.method==='initialize'){await trace('initialize',{requestId:id});return ok(id,{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'isolated-dcode',version:'draft'}});}
 if(m.method==='ping')return ok(id,{});
 if(closing||!ready)return bad(id,-32000,'Not executable');
 if(m.method==='tools/list')return ok(id,{tools});
 if(m.method!=='tools/call')return bad(id,-32601,'Method not found');
 if(typeof p.name!=='string'||pending.has(id))return bad(id,-32602,'Invalid tool request');
 const c=new AbortController(),a=p.arguments??{};pending.set(id,c);
 await trace('call.start',{requestId:id,tool:p.name,token:tokenOK(a.token)?a.token:null});
 try{
  let value;
  if(p.name==='read'){const content=await readFile(join(root,'input.txt'),'utf8');abort(c.signal);value=answer({file:'input.txt',content});}
  else if(p.name==='append_once')value=await append(a,id,c.signal);
  else if(p.name==='wait')value=await wait(a,id,c.signal);
  else value=answer({kind:p.name==='fail'?'expected-tool-error':'unknown-tool',token:a.token},true);
  abort(c.signal);await trace('call.end',{requestId:id,isError:value.isError===true});await ok(id,value);
 }catch(e){
  if(c.signal.aborted||e.name==='AbortError')await trace('call.cancelled',{requestId:id});
  else{await trace('call.error',{requestId:id,code:e.code??null});await ok(id,answer({kind:'fixture-tool-error'},true));}
 }finally{pending.delete(id);}
}
async function close(reason,code=0){
 if(closing)return;closing=true;for(const c of pending.values())c.abort();
 await trace('close.begin',{reason});await Promise.allSettled([...active]);
 await trace('close.drained',{reason,pending:pending.size});process.exit(code);
}
// Final CLI test evidence only. SIGKILL skips JS exit; caller records real child close(code,signal).
process.on('exit',code=>appendFileSync(log,JSON.stringify(event('exit',{code}))+'\n'));
process.once('SIGTERM',()=>{void close('SIGTERM',143);});
await trace('start');
const lines=createInterface({input:process.stdin,crlfDelay:Infinity});
lines.on('line',line=>{
 if(!line.trim()||closing)return;
 const work=(async()=>{let m;try{m=JSON.parse(line);}catch{return bad(null,-32700,'Parse error');}await dispatch(m);})();
 active.add(work);void work.catch(e=>trace('dispatch.error',{code:e.code??null})).finally(()=>active.delete(work));
});
lines.once('close',()=>{void close('stdin-eof');});
