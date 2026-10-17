import { defineTask, defineDoc, defineDocFamily } from '@earendil-works/pi-durable';
import type { ToolExecutionApi, UserInput, SubmissionRecord, SubmissionId, Submission, TaskId } from '@earendil-works/pi-durable';
import type { Context } from '@earendil-works/chord';
import type { ImageContent } from '@earendil-works/pi-ai';
import { taskToolApi } from './task-tool-api';

export type PreparedInput = { content: UserInput; handled: boolean };
export type InputPreparation = { requestId: string; innerRequestId: string; content: UserInput; text: string; images: ImageContent[]; mode: 'steer' | 'followUp'; source?: 'rpc' | 'extension'; expandPromptTemplates?: boolean };
type ReceivedInput = InputPreparation & { receiptId: SubmissionId; previousTaskId?: TaskId };
type Checkpoint = { phase: 'previous' } | { phase: 'call' } | { phase: 'interrupted' } | { phase: 'place'; prepared: PreparedInput };
export const processedInputId = (requestId: string) => `dcode.processed-input/${requestId}`;
export const Preparation = defineDocFamily<{taskId:number;innerRequestId?:string}, {taskId:number;innerRequestId:string}>({kind:'dcode.input-preparation',version:1,scope:'session',family:true,initial:seed=>seed});
export const PreparationOrder = defineDoc<{lastTaskId?:number}>({kind:'dcode.input-preparation-order',version:1,scope:'session',initial:()=>({})});
export const InnerReceipt = defineDocFamily<{originalRequestId:string},string>({kind:'dcode.prepared-input-link',version:1,scope:'session',family:true,initial:originalRequestId=>({originalRequestId})});
const base = (record:SubmissionRecord) => ({id:record.id,conversationId:record.conversationId,...(record.requestId===undefined?{}:{requestId:record.requestId})});

/** 原接收记录先于扩展代码：处理任务属于同一 Durable，处理后的正文只送原 inbox 一次。 */
export function createInputPreparation(prepare: (input: InputPreparation, api: ToolExecutionApi, context: Context) => Promise<PreparedInput>, isActive: () => boolean,
  submission: (id: SubmissionId, context: Context) => Promise<Submission | undefined>) {
  const tracking = defineTask<{requestId:string;receiptId:SubmissionId;innerId:SubmissionId},{phase:'wait'},SubmissionRecord>({
    name:'dcode.input-receipt',version:1,initial:()=>({phase:'wait'}),
    phases:{wait:async(task,runtime,context)=>{
      const admitted=await submission(task.input.innerId,context);if(!admitted)throw new Error('Input missing');
      const initial=await admitted.status(context);
      if(initial.entry!==undefined)await runtime.commit(async tx=>{const original=await tx.submissionByRequest(runtime.conversationId,task.input.requestId);if(original?.status==='queued')tx.placeSubmission(task.input.receiptId,initial.entry!);return undefined;},context);
      const completed=await admitted.wait(context);
      await runtime.commit(async tx=>{
        const original=await tx.submissionByRequest(runtime.conversationId,task.input.requestId);if(!original)throw new Error('Receipt missing');
        if(original.status==='done'||original.status==='unanswered')return {status:'terminal',outcome:{status:'completed',result:original}};
        let result:SubmissionRecord;
        if(completed.status==='done'&&completed.type==='input'){
          if(original.status==='queued')tx.placeSubmission(task.input.receiptId,completed.entry);
          tx.settleSubmission(task.input.receiptId,{status:'done',answer:completed.answer});
          result={...base(original),type:'input',status:'done',entry:completed.entry,answer:completed.answer};
        }else{tx.settleSubmission(task.input.receiptId,{status:'unanswered',reason:'input-processing-ended'});result={...base(original),type:'input',status:'unanswered',reason:'input-processing-ended'};}
        return {status:'terminal',outcome:{status:'completed',result}};
      },context);
    }},
    abort:async(task,runtime,context)=>{await runtime.commit(tx=>{tx.settleSubmission(task.input.receiptId,{status:'unanswered',reason:'aborted'});return {status:'terminal',outcome:{status:'aborted'}};},context);},
  });
  const preparation = defineTask<ReceivedInput, Checkpoint, SubmissionRecord>({
    name: 'dcode.input-preparation', version: 1, initial: () => ({ phase: 'previous' }),
    phases: {
      previous:async(task,runtime,context)=>{
        // 仅输入处理按正式 task 身份串行；模型执行不占用准备队列，后续 steer 仍能进入原 inbox。
        if(task.input.previousTaskId!==undefined)await runtime.waitForTask(task.input.previousTaskId,context);
        await runtime.commit(()=>({status:'running',checkpoint:{phase:'call'}}),context);
      },
      call: async (task, runtime, context) => {
        // 事件可以有副作用；先持久化进入事实，中断后不会重新运行已进入的 handler。
        await runtime.commit(() => ({ status: 'running', checkpoint: { phase: 'interrupted' } }), context);
        const invocation = await taskToolApi(runtime, `input/${task.input.requestId}`, context);
        try {
          const prepared = await prepare(task.input, invocation.api, context);
          if (!isActive()) throw new Error('Preparation superseded');
          await runtime.commit(() => ({ status: 'running', checkpoint: { phase: 'place', prepared } }), context);
        } catch (error) {
          if (runtime.signal.aborted) throw error;
          await runtime.commit(async tx => {
            tx.settleSubmission(task.input.receiptId, { status: 'unanswered', reason: 'execution-unavailable' });
            await tx.appendEntry(runtime.conversationId, { kind: 'dcode.preparation-error', data: { requestId: task.input.requestId } });
            return { status: 'terminal', outcome: { status: 'failed', error: { message: '项目资源或输入处理失败；已接收事实与已完成作用保留。' } } };
          }, context);
        } finally { invocation.finish({}); }
      },
      place: async (task, runtime, context) => {
        if (!isActive()) throw new Error('Preparation superseded');
        const prepared = task.state.checkpoint.prepared;
        if (prepared.handled) {
          // handled 不造模型回复；正式入口与该处理结果在同次事务收束。
          await runtime.commit(async tx => {
            const original = await tx.submissionByRequest(runtime.conversationId,task.input.requestId); if (!original) throw new Error('Receipt missing');
            const entry = await tx.appendEntry(runtime.conversationId, { kind: 'dcode.handled-input', data: { requestId: task.input.requestId } });
            tx.placeSubmission(task.input.receiptId, entry.id);
            tx.settleSubmission(task.input.receiptId, { status: 'done', answer: entry.id });
            const result: SubmissionRecord = { ...base(original), type:'input', status:'done', entry:entry.id, answer:entry.id };
            return { status: 'terminal', outcome: { status: 'completed', result } };
          }, context); return;
        }
        const conversation = await runtime.conversation(runtime.conversationId, context);
        if (!conversation) throw new Error('Conversation missing');
        const admitted = await conversation.submit({ type: 'input', requestId: task.input.innerRequestId, content: prepared.content, whenBusy: task.input.mode }, context);
        await runtime.commit(async tx => {
          const original = await tx.submissionByRequest(runtime.conversationId,task.input.requestId); if (!original) throw new Error('Receipt missing');
          await tx.createTask(tracking,{requestId:task.input.requestId,receiptId:task.input.receiptId,innerId:admitted.id},{conversationId:runtime.conversationId,ownership:{kind:'conversation'}});
          return {status:'terminal',outcome:{status:'completed',result:original}};
        }, context);
      },
      interrupted: async (task, runtime, context) => {
        await runtime.commit(async tx => {
          tx.settleSubmission(task.input.receiptId, {status:'unanswered',reason:'input-preparation-interrupted'});
          await tx.appendEntry(runtime.conversationId, {kind:'dcode.preparation-error',data:{requestId:task.input.requestId,interrupted:true}});
          return {status:'terminal',outcome:{status:'failed',error:{message:'扩展处理曾中断；保留已完成作用，不自动重放输入事件。'}}};
        }, context);
      },
    },
    abort: async (task, runtime, context) => { await runtime.commit(async tx => {
      tx.settleSubmission(task.input.receiptId,{status:'unanswered',reason:'aborted'});
      return { status: 'terminal', outcome: { status: 'aborted' } };
    }, context); },
  });
  return {preparation,tracking};
}
