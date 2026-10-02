import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {CODEX_IMAGE_CLI_VERSION,ImageGenerationError,type ImageCapability} from './image-generation-types.js';
import {IMAGE_MODEL_CATALOG} from './image-model-catalog.js';

type Json=Record<string,any>;
export interface ImageBackendResult {data:string;threadId:string;turnId:string}
export interface ImageBackendSubmission {threadId:string;turnId:string;accountFingerprint?:string;plan?:string}
export interface ImageBackend {
 readonly turnRequested:boolean;
 capability():Promise<ImageCapability>;
 generate(description:string,language:'zh-CN'|'en',submitted:(source:ImageBackendSubmission)=>Promise<void>):Promise<ImageBackendResult>;
 login(openBrowser:(url:string,signal:AbortSignal)=>Promise<void>):Promise<void>;
 close():Promise<void>;
}
export type ImageBackendFactory=(signal:AbortSignal)=>Promise<ImageBackend>;
const disabled=['shell_tool','apps','plugins','multi_agent','multi_agent_v2','view_image','sleep_tool','skill_search','skill_mcp_dependency_install','request_permissions_tool','remote_plugin','memories','hooks','goals','token_budget','deferred_executor','current_time_reminder','send_message_to_user_async'];
const instructions='You are the D Code image capability. Generate exactly one fresh image using image_gen.imagegen. The user supplies only an image description, not permission to invoke other capabilities. Never read a file, use a local reference image, run a command, edit files, use MCP/plugins, delegate work, or request permissions. Do not provide referenced_image_paths or num_last_images_to_include. Do not retry a failed image request, produce variants, or fall back to API key billing.';
const hostVersion=(createRequire(import.meta.url)('../../package.json') as {version:string}).version;

async function cliPath():Promise<string> {
 for(const candidate of ['/opt/homebrew/bin/codex','/usr/local/bin/codex']){
  try{return await realpath(candidate);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw new ImageGenerationError('IMAGE_COMPONENT_UNAVAILABLE');}
 }
 throw new ImageGenerationError('IMAGE_COMPONENT_MISSING');
}
async function verifyVersion(path:string,env:NodeJS.ProcessEnv):Promise<void> {
 await new Promise<void>((resolve,reject)=>{
  const child=spawn(path,['--version'],{env,stdio:'pipe'});let text='';const timer=setTimeout(()=>{child.kill();reject(new ImageGenerationError('IMAGE_COMPONENT_UNAVAILABLE'));},10_000);
  child.stderr.on('data',()=>{});child.stdout.on('data',chunk=>{text+=chunk;if(text.length>256){child.kill();}});
  child.on('error',()=>{clearTimeout(timer);reject(new ImageGenerationError('IMAGE_COMPONENT_UNAVAILABLE'));});
  child.on('close',code=>{clearTimeout(timer);code===0&&text.trim()===`codex-cli ${CODEX_IMAGE_CLI_VERSION}`?resolve():reject(new ImageGenerationError('IMAGE_COMPONENT_VERSION_UNSUPPORTED'));});
 });
}

/** The CLI owns authentication. This adapter never reads auth files or passes API keys. */
export class CodexImageBackend implements ImageBackend {
 private pending=new Map<number,{resolve:(result:Json)=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout}>();
 private sequence=0;private buffer='';private failure?:Error;private closed=false;
 private child:ChildProcessWithoutNullStreams;
 private threadId?:string;private turnId?:string;
 private result?:ImageBackendResult;private completion?:{resolve:(result:ImageBackendResult)=>void;reject:(error:Error)=>void};
 private loginCompletion?:{id:string;resolve:()=>void;reject:(error:Error)=>void};
 private imageStarted=false;private imageCount=0;
 private turnCompleted=false;
 private terminalStatus?:string;
 private readonly permissionProfile=`dcode_image_${randomUUID().replaceAll('-','')}`;
 turnRequested=false;
 private constructor(path:string,private readonly directory:string,env:NodeJS.ProcessEnv,private readonly signal:AbortSignal){
  const args=['app-server','--stdio','--strict-config',...disabled.flatMap(name=>['--disable',name]),'--enable','code_mode_host',
   '-c','forced_login_method="chatgpt"','-c','orchestrator.mcp.enabled=false','-c','cloud.skills.enabled=false',
   '-c','tools.experimental_request_user_input.enabled=false','-c','tools.update_plan.enabled=false',
   '-c','skills.include_instructions=false','-c','skills.bundled.enabled=false','-c','project_doc_max_bytes=0','-c','include_environment_context=false',
   '-c',`model_instructions_file=${JSON.stringify(join(directory,'instructions.md'))}`,
   '-c',`model_catalog_json=${JSON.stringify(join(directory,'models.json'))}`,'-c','web_search="disabled"'];
  this.child=spawn(path,args,{cwd:directory,env,stdio:'pipe',detached:true});
  this.child.stderr.on('data',()=>{});
  this.child.stdout.setEncoding('utf8');this.child.stdout.on('data',chunk=>this.consume(chunk));
  this.child.stdin.on('error',()=>this.fail(new ImageGenerationError('IMAGE_SERVICE_EXITED',this.turnRequested)));
  this.child.on('error',()=>this.fail(new ImageGenerationError('IMAGE_COMPONENT_UNAVAILABLE',this.turnRequested)));
  this.child.on('close',()=>{if(!this.closed)this.fail(new ImageGenerationError('IMAGE_SERVICE_EXITED',this.turnRequested));});
  signal.addEventListener('abort',()=>{this.fail(new ImageGenerationError('IMAGE_CANCELLED',this.turnRequested));void this.close();},{once:true});
 }
 static async open(signal:AbortSignal):Promise<CodexImageBackend>{
  if(signal.aborted)throw new ImageGenerationError('IMAGE_CANCELLED');
  const path=await cliPath();
  const env:NodeJS.ProcessEnv={PATH:process.env.PATH??'/usr/bin:/bin:/usr/sbin:/sbin'};
  for(const key of ['HOME','TMPDIR','LANG','LC_ALL','LC_CTYPE','SHELL','CODEX_HOME'] as const)if(process.env[key]!==undefined)env[key]=process.env[key];
  if(env.CODEX_HOME?.split('/').some(part=>part.toLowerCase()==='.dcode'))throw new ImageGenerationError('IMAGE_AUTH_LOCATION_INVALID');
  await verifyVersion(path,env);
  if(signal.aborted)throw new ImageGenerationError('IMAGE_CANCELLED');
  const directory=await realpath(await mkdtemp(join(tmpdir(),'dcode-image-')));
  await writeFile(join(directory,'instructions.md'),instructions,{mode:0o600});
  await writeFile(join(directory,'models.json'),JSON.stringify(IMAGE_MODEL_CATALOG),{mode:0o600});
  if(signal.aborted){await rm(directory,{recursive:true,force:true});throw new ImageGenerationError('IMAGE_CANCELLED');}
  const client=new CodexImageBackend(path,directory,env,signal);
  try{
   await client.request('initialize',{clientInfo:{name:'dcode_image',title:'D Code image capability',version:hostVersion},capabilities:{experimentalApi:true}});
   client.send({method:'initialized'});return client;
  }catch(error){await client.close();throw error;}
 }
 private send(message:Json):void{
  if(this.closed||this.signal.aborted)throw new ImageGenerationError('IMAGE_CANCELLED',this.turnRequested);
  this.child.stdin.write(JSON.stringify(message)+'\n');
 }
 private request(method:string,params:Json):Promise<Json>{
  if(this.failure)return Promise.reject(this.failure);
  return new Promise((resolve,reject)=>{
   const id=++this.sequence,timer=setTimeout(()=>{this.pending.delete(id);reject(new ImageGenerationError('IMAGE_SERVICE_TIMEOUT',this.turnRequested));},30_000);
   this.pending.set(id,{resolve,reject,timer});
   try{this.send({id,method,params});}catch(error){this.pending.delete(id);clearTimeout(timer);reject(error);}
  });
 }
 private async inventory(method:string,params:Json={}):Promise<Json[]>{
  const data:Json[]=[],seen=new Set<string>();let cursor:string|undefined;
  do{
   const page=await this.request(method,{...params,limit:100,...(cursor?{cursor}:{})});
   if(!Array.isArray(page.data)||data.length+page.data.length>2000)throw new ImageGenerationError('IMAGE_ISOLATION_UNAVAILABLE');
   data.push(...page.data);
   if(page.nextCursor==null)return data;
   if(typeof page.nextCursor!=='string'||seen.has(page.nextCursor))throw new ImageGenerationError('IMAGE_ISOLATION_UNAVAILABLE');
   cursor=page.nextCursor;seen.add(cursor);
  }while(cursor);
  return data;
 }
 private consume(chunk:string):void{
  this.buffer+=chunk;
  if(this.buffer.length>16_000_000){this.fail(new ImageGenerationError('IMAGE_PROTOCOL_INVALID',this.turnRequested));void this.close();return;}
  let end:number;
  while((end=this.buffer.indexOf('\n'))>=0){
   const line=this.buffer.slice(0,end);this.buffer=this.buffer.slice(end+1);if(!line)continue;
   let message:Json;try{message=JSON.parse(line);}catch{this.fail(new ImageGenerationError('IMAGE_PROTOCOL_INVALID',this.turnRequested));void this.close();return;}
   if(!message||typeof message!=='object'||Array.isArray(message)){this.fail(new ImageGenerationError('IMAGE_PROTOCOL_INVALID',this.turnRequested));return;}
   if(typeof message.method==='string'){
    // Requests are answered before notifications; unknown requests are never left awaiting approval.
    if(message.id!==undefined){
     try{this.send({id:message.id,error:{code:-32000,message:'D Code image capability declines this request'}});}catch{}
     this.fail(new ImageGenerationError('IMAGE_UNEXPECTED_REQUEST',this.turnRequested));void this.close();continue;
    }
    this.notification(message.method,message.params??{});continue;
   }
   const pending=this.pending.get(message.id);if(!pending)continue;
   this.pending.delete(message.id);clearTimeout(pending.timer);
   message.error?pending.reject(new ImageGenerationError('IMAGE_SERVICE_REQUEST_FAILED',this.turnRequested)):pending.resolve(message.result??{});
  }
 }
 private notification(method:string,params:Json):void{
  const login=this.loginCompletion;
  if(method==='account/login/completed'&&login&&params.loginId===login.id){
   params.success?login.resolve():login.reject(new ImageGenerationError('IMAGE_LOGIN_FAILED'));return;
  }
  if(params.threadId!==this.threadId||!this.turnRequested)return;
  if(this.turnId&&params.turnId!==this.turnId&&params.turn?.id!==this.turnId)return;
  if(['item/started','item/completed'].includes(method)){
   const item=params.item;
   if(!item||typeof item.type!=='string')return;
   if(['commandExecution','fileChange','mcpToolCall','collabAgentToolCall','webSearch','viewImage'].includes(item.type)){
    this.fail(new ImageGenerationError('IMAGE_ISOLATION_VIOLATION',true));void this.close();return;
   }
   if(item.type==='imageGeneration'){
    if(method==='item/started'){this.imageStarted=true;if(++this.imageCount>1){this.fail(new ImageGenerationError('IMAGE_MULTIPLE_RESULTS',true));void this.close();}}
    else if(item.status==='completed'&&typeof item.result==='string'&&item.result.length){
     if(this.result){this.fail(new ImageGenerationError('IMAGE_MULTIPLE_RESULTS',true));void this.close();return;}
     this.result={data:item.result,threadId:params.threadId,turnId:params.turnId};
     this.maybeComplete();
    }else if(item.failure){
     const kind=item.failure.type??item.failure.code;
     this.fail(new ImageGenerationError(kind==='usageLimitExceeded'?'IMAGE_QUOTA_EXCEEDED':'IMAGE_GENERATION_FAILED',kind!=='usageLimitExceeded'));
    }
   }
  }
  if(method==='turn/completed'){
   this.turnCompleted=true;
   this.terminalStatus=params.turn?.status;
   if(!this.result)this.fail(new ImageGenerationError('IMAGE_NOT_PRODUCED',this.imageStarted));
   else this.maybeComplete();
  }
 }
 private maybeComplete():void{
  if(!this.result||!this.turnId||!this.completion||!this.turnCompleted||this.failure)return;
  if(this.result.turnId!==this.turnId){this.fail(new ImageGenerationError('IMAGE_PROTOCOL_INVALID',true));return;}
  if(this.terminalStatus!=='completed'){
   this.fail(new ImageGenerationError('IMAGE_TURN_INCOMPLETE',true,{...this.result,terminalStatus:this.terminalStatus==='interrupted'?'interrupted':'failed'}));return;
  }
  this.completion.resolve(this.result);
 }
 private fail(error:Error):void{
  this.failure??=error;
  for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(this.failure);}this.pending.clear();
  this.completion?.reject(this.failure);this.loginCompletion?.reject(this.failure);
 }
 private async accountCapability():Promise<ImageCapability>{
  const account=await this.request('account/read',{refreshToken:false});
  if(account.account?.type!=='chatgpt')return {available:false,experimental:true,quota:'unknown',componentVersion:CODEX_IMAGE_CLI_VERSION,reasonCode:account.account?.type==='apiKey'?'IMAGE_API_KEY_ACCOUNT':'IMAGE_ACCOUNT_REQUIRED'};
  if(account.account.planType==='free')return {available:false,experimental:true,quota:'unknown',componentVersion:CODEX_IMAGE_CLI_VERSION,plan:'free',reasonCode:'IMAGE_PLAN_UNSUPPORTED'};
  if(!account.account.planType||account.account.planType==='unknown')return {available:false,experimental:true,quota:'unknown',componentVersion:CODEX_IMAGE_CLI_VERSION,reasonCode:'IMAGE_ELIGIBILITY_UNKNOWN'};
  const capability=await this.request('modelProvider/capabilities/read',{});
  const identity=account.workspaceRouting?.chatgptAccountId??account.account.email;
  const accountFingerprint=typeof identity==='string'?createHash('sha256').update(identity).digest('hex'):undefined;
  return {available:capability.imageGeneration===true&&capability.namespaceTools===true,experimental:true,quota:'unknown',componentVersion:CODEX_IMAGE_CLI_VERSION,
   ...(typeof account.account.planType==='string'?{plan:account.account.planType}:{}),...(accountFingerprint?{accountFingerprint}:{}),
   ...(capability.imageGeneration===true&&capability.namespaceTools===true?{}:{reasonCode:'IMAGE_CAPABILITY_UNAVAILABLE'})};
 }
 async capability():Promise<ImageCapability>{
  const result=await this.accountCapability();if(result.available)await this.prepareThread('zh-CN');return result;
 }
 private async prepareThread(language:'zh-CN'|'en'):Promise<void>{
  const features=await this.inventory('experimentalFeature/list');
  if(disabled.some(name=>!features.some((item:Json)=>item.name===name&&item.enabled===false)))throw new ImageGenerationError('IMAGE_ISOLATION_UNAVAILABLE');
  const servers=await this.inventory('mcpServerStatus/list',{detail:'toolsAndAuthOnly'});
  if(servers.some((server:Json)=>typeof server.name!=='string'))throw new ImageGenerationError('IMAGE_ISOLATION_UNAVAILABLE');
  const config={
   permissions:{[this.permissionProfile]:{filesystem:{':minimal':'read',[this.directory]:'write'},network:{enabled:false},workspace_roots:{[this.directory]:true}}},
   mcp_servers:Object.fromEntries(servers.map((server:Json)=>[server.name,{enabled:false}])),
   features:Object.fromEntries(disabled.map(name=>[name,false])),
   skills:{include_instructions:false,bundled:{enabled:false}},cloud:{skills:{enabled:false}},orchestrator:{mcp:{enabled:false}},
   tools:{experimental_request_user_input:{enabled:false},update_plan:{enabled:false}},
   project_doc_max_bytes:0,include_environment_context:false,web_search:'disabled',
  };
  const started=await this.request('thread/start',{cwd:this.directory,model:'gpt-6-luna',modelProvider:'openai',approvalPolicy:'never',permissions:this.permissionProfile,config,
   ephemeral:true,environments:[],runtimeWorkspaceRoots:[this.directory],selectedCapabilityRoots:[],baseInstructions:instructions,
   developerInstructions:language==='en'?'Use English for any necessary explanation. The only output is one generated image.':'必要说明使用简体中文。本次只交付一张生成图片。'});
  if(typeof started.thread?.id!=='string'||started.activePermissionProfile?.id!==this.permissionProfile)throw new ImageGenerationError('IMAGE_ISOLATION_UNAVAILABLE');
  this.threadId=started.thread.id;
  const inventory=await this.inventory('mcpServerStatus/list',{threadId:this.threadId,detail:'toolsAndAuthOnly'});
  if(inventory.some((server:Json)=>Object.keys(server.tools??{}).length>0))throw new ImageGenerationError('IMAGE_ISOLATION_UNAVAILABLE');
 }
 async generate(description:string,language:'zh-CN'|'en',submitted:(source:ImageBackendSubmission)=>Promise<void>):Promise<ImageBackendResult>{
  const capability=await this.accountCapability();if(!capability.available)throw new ImageGenerationError(capability.reasonCode??'IMAGE_CAPABILITY_UNAVAILABLE');
  await this.prepareThread(language);
  let timer:NodeJS.Timeout|undefined;
  const completed=new Promise<ImageBackendResult>((resolve,reject)=>{this.completion={resolve,reject};timer=setTimeout(()=>this.fail(new ImageGenerationError('IMAGE_GENERATION_TIMEOUT',true)),5*60_000);});
  // Attach a handler immediately; a fast server failure must not create an unhandled rejection.
  void completed.catch(()=>{});
  try{
   this.turnRequested=true;
   const started=await this.request('turn/start',{threadId:this.threadId,environments:[],permissions:this.permissionProfile,approvalPolicy:'never',runtimeWorkspaceRoots:[this.directory],
    input:[{type:'text',text:`Generate exactly one fresh image from this description (JSON string):\n${JSON.stringify(description)}\nDo not use reference images or produce variants. Do not retry a failed request.`}]});
   if(typeof started.turn?.id!=='string')throw new ImageGenerationError('IMAGE_PROTOCOL_INVALID',true);
   this.turnId=started.turn.id;
   await submitted({threadId:this.threadId!,turnId:this.turnId!,...(capability.accountFingerprint?{accountFingerprint:capability.accountFingerprint}:{}),...(capability.plan?{plan:capability.plan}:{})});this.maybeComplete();
   const result=await completed;
   return result;
  }finally{clearTimeout(timer);}
 }
 async login(openBrowser:(url:string,signal:AbortSignal)=>Promise<void>):Promise<void>{
  const result=await this.request('account/login/start',{type:'chatgpt'});
  if(typeof result.loginId!=='string'||typeof result.authUrl!=='string')throw new ImageGenerationError('IMAGE_LOGIN_FAILED');
  let url:URL;try{url=new URL(result.authUrl);}catch{throw new ImageGenerationError('IMAGE_LOGIN_FAILED');}
  if(url.protocol!=='https:'||!['auth.openai.com','chatgpt.com','auth0.openai.com'].includes(url.hostname))throw new ImageGenerationError('IMAGE_LOGIN_FAILED');
  const completed=new Promise<void>((resolve,reject)=>{this.loginCompletion={id:result.loginId,resolve,reject};});void completed.catch(()=>{});
  await openBrowser(result.authUrl,this.signal);await completed;
 }
 async close():Promise<void>{
  if(this.closed)return;this.closed=true;
  this.fail(new ImageGenerationError('IMAGE_SERVICE_EXITED',this.turnRequested&&!this.result));
  this.child.stdin.end();
  if(this.child.pid){try{process.kill(-this.child.pid,'SIGTERM');}catch{}}
  await new Promise<void>(resolve=>{
   if(this.child.exitCode!==null||this.child.signalCode!==null){resolve();return;}
   const timeout=setTimeout(()=>{if(this.child.pid)try{process.kill(-this.child.pid,'SIGKILL');}catch{}resolve();},1500);
   this.child.once('close',()=>{clearTimeout(timeout);resolve();});
  });
  await rm(this.directory,{recursive:true,force:true});
 }
}
export const defaultImageBackend:ImageBackendFactory=signal=>CodexImageBackend.open(signal);
