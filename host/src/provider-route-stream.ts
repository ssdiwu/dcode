import {rememberRequestCredentials} from "./credential-material.js";
import {randomUUID,createHash} from 'node:crypto';
import {createAssistantMessageEventStream,type AssistantMessage,type AssistantMessageEvent} from '@earendil-works/pi-ai';
import type {AgentOptions} from '@earendil-works/pi-agent-core';
type Stream=NonNullable<AgentOptions['streamFn']>;
export type ProviderModel=Parameters<Stream>[0];
export type ProviderContext=Parameters<Stream>[1];
export interface ProviderCallRecord {id:string;purpose?:'agent'|'context_summary';sourceLeafEntryId?:string;rawInputIds?:string[];effectiveInputIds?:string[];reasoning?:string;providerId:string;modelId:string;state:'started'|'completed'|'failed';systemPromptDigest?:string;toolNames?:string[];toolManifestDigest?:string;httpStatus?:number;error?:string;usage?:AssistantMessage['usage']}
export interface ProviderRouteControl {
  select(model:ProviderModel,context:ProviderContext,signal:AbortSignal|undefined,rejected:ReadonlySet<string>):Promise<{model:ProviderModel;context:ProviderContext;reasoning?:Exclude<import("@earendil-works/pi-agent-core").ThinkingLevel,"off">|null}>;
  record(call:ProviderCallRecord):Promise<void>;
  response?(model:ProviderModel,status:number,headers:Record<string,string>):void;
}
/** A rejected HTTP 429 has no generated answer or tool invocation. Only that
 * completed, empty request can retry through the member's explicit route. */
export function routedProviderStream(base:Stream,control:ProviderRouteControl):Stream {
  return (initial,initialContext,options)=>{
    const output=createAssistantMessageEventStream();
    void (async()=>{
      let model=initial,context=initialContext;const rejected=new Set<string>();
      try{
        for(let attempt=0;attempt<32;attempt++){
          if(options?.signal?.aborted)throw new Error('本次执行已停止');
          const selected=await control.select(model,context,options?.signal,rejected);({model,context}=selected);
          const reasoning=selected.reasoning===null?undefined:selected.reasoning??options?.reasoning;
          const id=randomUUID(),systemPromptDigest=`sha256:${createHash('sha256').update(context.systemPrompt??'').digest('hex')}`;
          const toolNames=(context.tools??[]).map(tool=>tool.name),toolManifestDigest=`sha256:${createHash('sha256').update(JSON.stringify(context.tools??[])).digest('hex')}`;
          await control.record({id,providerId:model.provider,modelId:model.id,state:'started',systemPromptDigest,toolNames,toolManifestDigest,...(reasoning?{reasoning}:{})});
          let httpStatus:number|undefined,notifiedStatus:number|undefined,visible=false;const buffered:AssistantMessageEvent[]=[];
          const observedFetch:NonNullable<NonNullable<Parameters<Stream>[2]>["fetch"]>=async(input,init)=>{
            rememberRequestCredentials(input,init);
            const response=await (options?.fetch??globalThis.fetch)(input,init);httpStatus=response.status;control.response?.(model,response.status,Object.fromEntries(response.headers.entries()));
            // Pi's OpenAI adapters invoke onResponse only after .withResponse()
            // succeeds. Observe non-2xx responses through its supported fetch hook.
            if(!response.ok){notifiedStatus=response.status;await options?.onResponse?.({status:response.status,headers:Object.fromEntries(response.headers.entries())},model);}
            return response;
          };
          const stream=await Promise.resolve().then(()=>base(model,context,{...options,reasoning,maxRetries:0,fetch:observedFetch,onResponse:async(response,actualModel)=>{httpStatus=response.status;control.response?.(actualModel,response.status,response.headers);if(notifiedStatus!==response.status)await options?.onResponse?.(response,actualModel);notifiedStatus=response.status;}})).catch(async(error)=>{await control.record({id,providerId:model.provider,modelId:model.id,state:'failed',systemPromptDigest,toolNames,toolManifestDigest,error:error instanceof Error?error.message:'模型调用未开始'});throw error;});
          let final:AssistantMessage|undefined,retry=false;
          try{for await(const event of stream){
            if(event.type==='error'){
              final=event.error;
              await control.record({id,providerId:model.provider,modelId:model.id,state:'failed',systemPromptDigest,toolNames,toolManifestDigest,...(reasoning?{reasoning}:{}),...(httpStatus!==undefined?{httpStatus}:{}),error:event.error.errorMessage??'模型请求未完成'});
              if(httpStatus===429&&!visible&&!options?.signal?.aborted){rejected.add(model.provider);retry=true;break;}
              for(const held of buffered)output.push(held);buffered.length=0;output.push(event);break;
            }
            if(event.type==='done'){
              final=event.message;await control.record({id,providerId:model.provider,modelId:model.id,state:'completed',systemPromptDigest,toolNames,toolManifestDigest,...(reasoning?{reasoning}:{}),...(httpStatus!==undefined?{httpStatus}:{}),usage:final.usage});
              for(const held of buffered)output.push(held);buffered.length=0;output.push(event);break;
            }
            if('delta' in event&&typeof event.delta==='string'&&event.delta.length||'content' in event&&typeof event.content==='string'&&event.content.length||'toolCall' in event)visible=true;
            if(!visible)buffered.push(event);else{for(const held of buffered)output.push(held);buffered.length=0;output.push(event);}
          }
          }catch(error){await control.record({id,providerId:model.provider,modelId:model.id,state:'failed',systemPromptDigest,toolNames,toolManifestDigest,...(httpStatus!==undefined?{httpStatus}:{}),error:error instanceof Error?error.message:'模型响应意外结束'});throw error;}
          if(retry)continue;
          output.end(final??await stream.result());return;
        }
        throw new Error('回退候选已用尽，进度已保留');
      }catch(error){
        const aborted=options?.signal?.aborted===true;
        const message:AssistantMessage={role:'assistant',content:[],api:model.api,provider:model.provider,model:model.id,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:aborted?'aborted':'error',errorMessage:error instanceof Error?error.message:'模型暂不可用，进度已保留',timestamp:Date.now()};
        output.push({type:'error',reason:aborted?'aborted':'error',error:message});output.end(message);
      }
    })();return output;
  };
}
