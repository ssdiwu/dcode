import type {ProductStore} from './product-store.js';
import type {ManagedAttachment} from './attachment-files.js';
import {defaultImageBackend,type ImageBackend,type ImageBackendFactory} from './image-app-server.js';
import {generatedImageArtifactMatches,readGeneratedImage,saveGeneratedImage} from './generated-image-files.js';
import {ImageGenerationError,type ImageCapability,type ImageGenerationRecord,type ImageExportContext,type ImageExportDestination} from './image-generation-types.js';

interface Flight {controller:AbortController;backend?:ImageBackend;promise:Promise<void>;resultReceived?:boolean}
/** Owns only the Task image capability. It neither opens Pi sessions nor resumes unknown requests. */
export class ImageGenerationController {
 private jobs=new Map<string,Flight>();private checks=new Set<Flight>();private closing=false;
 private loginFlight?:Flight;
 constructor(private readonly store:ProductStore,private readonly changed:(kind:string,taskId?:string)=>void,
  private readonly factory:ImageBackendFactory=defaultImageBackend,
  private readonly openBrowser:(url:string,signal:AbortSignal)=>Promise<void>=async()=>{throw new ImageGenerationError('IMAGE_LOGIN_UNAVAILABLE');},
  private readonly exportFile:(destination:string,bytes:Buffer,context:ImageExportContext,expected:ImageExportDestination)=>Promise<{path:string}>=async()=>{throw new ImageGenerationError('IMAGE_EXPORT_FAILED');},
  private readonly exportContext:(taskId:string,id:string,mimeType:string)=>Promise<ImageExportContext>=async(taskId,generationId,mimeType)=>({taskId,generationId,mimeType})){}
 private assertOpen():void{if(this.closing)throw new ImageGenerationError('IMAGE_SERVICE_EXITED');}
 list(taskId:string):{generations:ImageGenerationRecord[]}{
  return {generations:this.store.imageGenerations(taskId).slice(-50).reverse()};
 }
 async recover():Promise<void>{
  for(const record of this.store.imageGenerations())if(record.state==='unknown'){
   if(record.artifactId||this.jobs.has(record.id))continue;
   if(record.phase==='queued'){
    await this.store.transitionImageGeneration(record.id,{state:'failed',phase:'finished',errorCode:'IMAGE_INTERRUPTED_BEFORE_SUBMIT'});continue;
   }
   if(record.threadId&&record.turnId&&record.terminalStatus){
    try{
     const saved=await readGeneratedImage(this.store.layout,record);
     if(record.terminalStatus==='completed')await this.store.completeImageGeneration(record.id,saved.manifest.info);
     else if(record.errorCode!=='IMAGE_TURN_INCOMPLETE')await this.store.transitionImageGeneration(record.id,{state:'unknown',phase:'finished',errorCode:'IMAGE_TURN_INCOMPLETE'});
    }
    catch{ /* Preserve the unknown state unless an owned immutable result proves completion. */ }
   }
  }
 }
 async capability():Promise<ImageCapability>{
  this.assertOpen();const flight:Flight={controller:new AbortController(),promise:Promise.resolve()};this.checks.add(flight);
  let result:ImageCapability={available:false,experimental:true,quota:'unknown',reasonCode:'IMAGE_SERVICE_UNAVAILABLE'};
  flight.promise=(async()=>{
   try{flight.backend=await this.factory(flight.controller.signal);result=await flight.backend.capability();}
   catch(error){result={available:false,experimental:true,quota:'unknown',reasonCode:error instanceof ImageGenerationError?error.code:'IMAGE_SERVICE_UNAVAILABLE'};}
   finally{await flight.backend?.close();this.checks.delete(flight);}
  })();
  await flight.promise;return result;
 }
 async connect():Promise<{connected:boolean}>{
  this.assertOpen();if(this.loginFlight||this.jobs.size)throw new ImageGenerationError('IMAGE_CONNECTION_BUSY');
  const flight:Flight={controller:new AbortController(),promise:Promise.resolve()};this.loginFlight=flight;
  const timeout=setTimeout(()=>flight.controller.abort(),10*60_000);
  flight.promise=(async()=>{try{flight.backend=await this.factory(flight.controller.signal);await flight.backend.login(this.openBrowser);}finally{clearTimeout(timeout);await flight.backend?.close();this.loginFlight=undefined;}})();
  await flight.promise;return {connected:true};
 }
 async cancelConnection():Promise<{cancelled:boolean}>{this.loginFlight?.controller.abort();await this.loginFlight?.promise.catch(()=>{});return {cancelled:true};}
 async start(input:Parameters<ProductStore['prepareImageGeneration']>[0]):Promise<{storeRevision:number;generation:ImageGenerationRecord}>{
  this.assertOpen();if(this.loginFlight)throw new ImageGenerationError('IMAGE_CONNECTION_BUSY');
  const prepared=await this.store.prepareImageGeneration(input);
  let record=this.store.imageGenerations(input.taskId).find(record=>record.id===prepared.generation.id)!;
  if(['queued','running'].includes(record.state)&&record.phase!=='queued'&&!this.jobs.has(record.id)){
   const recovered=await this.store.transitionImageGeneration(record.id,{state:'unknown',phase:'finished',errorCode:'IMAGE_STOPPED_RESULT_UNKNOWN'});record=recovered.generation;
  }
  if(record.state==='queued'&&record.phase==='queued'&&!this.jobs.has(record.id)){
   const flight:Flight={controller:new AbortController(),promise:Promise.resolve()};this.jobs.set(record.id,flight);
   flight.promise=this.run(record,flight);void flight.promise.catch(()=>{});
  }
  this.changed('imageGeneration.prepared',record.taskId);
  return {storeRevision:prepared.storeRevision,generation:record};
 }
 private async run(record:ImageGenerationRecord,flight:Flight):Promise<void>{
  try{
   flight.backend=await this.factory(flight.controller.signal);
   const capability=await flight.backend.capability();if(!capability.available)throw new ImageGenerationError(capability.reasonCode??'IMAGE_CAPABILITY_UNAVAILABLE');
   if(flight.controller.signal.aborted)throw new ImageGenerationError('IMAGE_CANCELLED');
   // Commit this conservative boundary before any turn can be written. A restart must not replay it.
   await this.store.transitionImageGeneration(record.id,{state:'queued',phase:'submitting',...(capability.accountFingerprint?{accountFingerprint:capability.accountFingerprint}:{}),...(capability.plan?{plan:capability.plan}:{})});
   const result=await flight.backend.generate(record.description,record.language,async source=>{
    await this.store.transitionImageGeneration(record.id,{state:'running',phase:'active',...source});this.changed('imageGeneration.running',record.taskId);
   });
   flight.resultReceived=true;
   const active=this.store.imageGenerations(record.taskId).find(item=>item.id===record.id)!;
   const saved=await saveGeneratedImage(this.store.layout,active,result.data,{threadId:result.threadId,turnId:result.turnId},async info=>this.store.retainImageResultProof(record.id,info));
   await this.store.completeImageGeneration(record.id,saved.manifest.info);
   this.changed('imageGeneration.succeeded',record.taskId);
  }catch(error){
   if(error instanceof ImageGenerationError&&error.result&&error.code==='IMAGE_TURN_INCOMPLETE'){
    try{
     flight.resultReceived=true;
     const active=this.store.imageGenerations(record.taskId).find(item=>item.id===record.id)!;
     await saveGeneratedImage(this.store.layout,active,error.result.data,error.result,info=>this.store.retainImageResultProof(record.id,info,error.result!.terminalStatus??'failed'));
     await this.store.transitionImageGeneration(record.id,{state:'unknown',phase:'finished',errorCode:'IMAGE_TURN_INCOMPLETE'});
     this.changed('imageGeneration.unknown',record.taskId);return;
    }catch{ /* Continue with the explicit unknown outcome; never retry the service. */ }
   }
   const aborted=flight.controller.signal.aborted,uncertain=error instanceof ImageGenerationError?error.uncertain:flight.backend?.turnRequested===true;
   const state=aborted&&!flight.backend?.turnRequested?'cancelled':uncertain?'unknown':'failed';
   const errorCode=aborted?(state==='cancelled'?'IMAGE_CANCELLED_BEFORE_SUBMIT':'IMAGE_STOPPED_RESULT_UNKNOWN'):error instanceof ImageGenerationError?error.code:'IMAGE_SAVE_FAILED';
   try{await this.store.transitionImageGeneration(record.id,{state,phase:'finished',errorCode});this.changed(`imageGeneration.${state}`,record.taskId);}catch{ /* An immutable file + manifest can be reconciled on the next Store open. */ }
  }finally{await flight.backend?.close();this.jobs.delete(record.id);}
 }
 async cancel(taskId:string,id:string):Promise<{generation:ImageGenerationRecord}>{
  const record=this.store.imageGenerations(taskId).find(record=>record.id===id);if(!record)throw new ImageGenerationError('IMAGE_RECORD_NOT_FOUND');
  const flight=this.jobs.get(id);
  if(flight&&!flight.resultReceived){flight.controller.abort();await flight.promise;}
  return {generation:this.store.imageGenerations(taskId).find(record=>record.id===id)!};
 }
 private async succeeded(taskId:string,id:string):Promise<ImageGenerationRecord>{
  const record=this.store.imageGenerations(taskId).find(record=>record.id===id);
  if(!record||record.state!=='succeeded'||!record.artifactId||!record.resultInfo)throw new ImageGenerationError('IMAGE_RESULT_UNAVAILABLE');
  const artifact=(await this.store.snapshot()).artifacts.find(artifact=>artifact.id===record.artifactId&&artifact.taskId===taskId&&artifact.kind==='generated_image');
  if(!generatedImageArtifactMatches(this.store.layout,record,artifact))throw new ImageGenerationError('IMAGE_RECORD_CHANGED');return record;
 }
 async image(taskId:string,id:string):Promise<{dataUrl:string;artifactId?:string;provisional:boolean;width:number;height:number;bytes:number;mimeType:string}>{
  const pending=this.store.imageGenerations(taskId).find(record=>record.id===id&&record.state==='unknown'&&record.errorCode==='IMAGE_TURN_INCOMPLETE'&&['failed','interrupted'].includes(record.terminalStatus??'')&&record.resultInfo);
  const record=pending??await this.succeeded(taskId,id),saved=await readGeneratedImage(this.store.layout,record);
  return {dataUrl:`data:${saved.manifest.info.mimeType};base64,${saved.bytes.toString('base64')}`,...(record.artifactId?{artifactId:record.artifactId}:{}),provisional:!!pending,...saved.manifest.info};
 }
 async reconcile(taskId:string):Promise<{generations:ImageGenerationRecord[]}>{
  if(!this.store.imageGenerations(taskId).some(record=>record.state==='unknown'))return this.list(taskId);
  await this.recover();return this.list(taskId);
 }
 async attach(input:{requestId:string;expectedStoreRevision:number;taskId:string;generationId:string;sessionId:string;draftKey:string}):Promise<{storeRevision:number;attachment:ManagedAttachment}>{
  const record=await this.succeeded(input.taskId,input.generationId);
  const snapshot=await this.store.snapshot(),main=snapshot.sessions.find(session=>session.id===input.sessionId&&session.taskId===input.taskId&&session.kind==='coordination');
  if(!main||input.draftKey!==main.id||['archived','accepted'].includes(snapshot.tasks.find(task=>task.id===input.taskId)?.state??'archived'))throw new ImageGenerationError('IMAGE_TASK_MAIN_REQUIRED');
  const saved=await readGeneratedImage(this.store.layout,record);
  const result=await this.store.importAttachment({requestId:input.requestId,expectedStoreRevision:input.expectedStoreRevision,draftKey:input.draftKey,source:{data:saved.bytes.toString('base64'),name:saved.manifest.fileName,mimeType:saved.manifest.info.mimeType}});
  this.changed('attachment.imported',input.taskId);return result;
 }
 async context(taskId:string,id:string):Promise<ImageExportContext>{const record=await this.succeeded(taskId,id);return this.exportContext(taskId,id,record.resultInfo!.mimeType);}
 async export(taskId:string,id:string,destination:string,context:ImageExportContext,expected:ImageExportDestination):Promise<{path:string}>{
  if(context.taskId!==taskId||context.generationId!==id)throw new ImageGenerationError('IMAGE_EXPORT_LOCATION_INVALID');
  const record=await this.succeeded(taskId,id),saved=await readGeneratedImage(this.store.layout,record);
  return this.exportFile(destination,saved.bytes,context,expected);
 }
 async close():Promise<void>{
  if(this.closing)return;this.closing=true;
  const flights=[...this.jobs.values(),...this.checks,...(this.loginFlight?[this.loginFlight]:[])];
  for(const flight of flights)if(!flight.resultReceived)flight.controller.abort();
  await Promise.allSettled(flights.map(flight=>flight.promise));
 }
}
