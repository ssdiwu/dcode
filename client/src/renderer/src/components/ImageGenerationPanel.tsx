import {useEffect,useRef,useState} from 'react';
import useSWR from 'swr';
import {ImagePlus,Paperclip,Download,RefreshCw,X,Square} from 'lucide-react';
import {uiText,localizeUi} from '../../../shared/ui-language.ts';
import {api,type ManagedAttachment} from '../types';
import type {Workbench} from '../useWorkbench';
import type {ImageGenerationRecord,ImageCapability} from '../../../../../host/src/image-generation-types.js';
import {ImagePreview} from './conversation/ImagePreview';

const stateLabels=localizeUi({queued:'正在准备',running:'正在生成图片',succeeded:'图片已保存',failed:'生成未完成',cancelled:'已取消生成',unknown:'生成结果待核对'});
const reasons=localizeUi({
 IMAGE_COMPONENT_MISSING:'这台 Mac 尚未安装生图所需的 Codex 运行组件。',
 IMAGE_COMPONENT_VERSION_UNSUPPORTED:'当前 Codex 版本尚未通过 D Code 生图验证，暂不能使用。',
 IMAGE_ACCOUNT_REQUIRED:'请先连接 Codex 的 ChatGPT 订阅账号。',
 IMAGE_API_KEY_ACCOUNT:'当前 Codex 使用 API Key；本入口只使用订阅账号，不会自动切换计费方式。',
 IMAGE_CAPABILITY_UNAVAILABLE:'当前账号的图像能力不可用，请核对账号后重试。',
 IMAGE_ISOLATION_UNAVAILABLE:'当前运行组件不能满足生图的工具隔离要求，入口暂不可用。',
 IMAGE_QUOTA_EXCEEDED:'本次适用用量不足，请稍后核对 Codex 账号用量。',
 IMAGE_TASK_BUSY:'本任务已有图片正在生成，请等待或停止后再发起。',
 IMAGE_TASK_MAIN_REQUIRED:'请回到当前任务主对话使用图像能力。',
 IMAGE_TASK_INACTIVE:'当前任务不能新增图片，请创建或继续一个可工作的任务。',
 IMAGE_DESCRIPTION_CONTAINS_CREDENTIAL:'描述中可能包含凭据，请移除后再提交。',
 IMAGE_TOO_LARGE:'结果超过 5 MB 图像边界，未登记为成功产物。',
 IMAGE_FORMAT_REJECTED:'返回的图片无法完整解码，未登记为成功产物。',
 IMAGE_EXPORT_EXISTS:'目标文件已经存在，请选择其他名称；原文件未被覆盖。',
 IMAGE_EXPORT_FAILED:'导出未完成，原产物仍保留，请检查目标文件夹后重试。',
 IMAGE_RECORD_CHANGED:'受管图片或来源已变化，不能继续引用或导出。',
 IMAGE_STOPPED_RESULT_UNKNOWN:'已停止等待，但无法确认服务是否已生成；不会自动重发。',
 IMAGE_INTERRUPTED_BEFORE_SUBMIT:'生图请求发出前运行服务已中断，可重新发起。',
 IMAGE_CANCELLED_BEFORE_SUBMIT:'提交给生图服务前已取消。',
 IMAGE_CONNECTION_BUSY:'正在连接账号或生成图片，请稍后再操作。',
 IMAGE_PLAN_UNSUPPORTED:'当前 Codex 账号计划不支持此图像能力，请更换适用订阅账号。',
 IMAGE_ELIGIBILITY_UNKNOWN:'当前账号的订阅资格尚未确认，不能开始生图。',
 IMAGE_SAVE_FAILED:'图片结果尚未完成受管保存，请核对记录；不会自动重新生成。',
 IMAGE_SERVICE_TIMEOUT:'生图运行服务响应超时，请核对结果，不要重复发起。',
 IMAGE_EXPORT_LOCATION_INVALID:'所选导出位置不可写入，请选择普通文件夹。',
 IMAGE_EXPORT_LOCATION_CHANGED:'导出目录的身份已变化，请重新选择位置。',
 IMAGE_EXPORT_PROJECT_CHANGED:'项目目录在导出期间已变化，请重新选择位置；原产物仍保留。',
 IMAGE_TURN_INCOMPLETE:'图片已收到，但运行未完整结束；只保留待核对图片，不登记为成功交付。',
 IMAGE_COMPONENT_UNAVAILABLE:'Codex 运行组件无法启动，请检查安装后再试。',
 IMAGE_AUTH_LOCATION_INVALID:'Codex 登录资料位置不符合隔离要求，请使用独立的 Codex 配置目录。',
 IMAGE_LOGIN_UNAVAILABLE:'当前运行环境无法打开 Codex 登录，请检查浏览器连接。',
 IMAGE_LOGIN_FAILED:'Codex 登录未完成，请重新连接订阅账号。',
 IMAGE_CANCELLED:'已停止当前操作，请核对已有记录后再决定是否重新发起。',
 IMAGE_SERVICE_UNAVAILABLE:'生图运行服务暂不可用，请检查 Codex 运行组件后再试。',
 IMAGE_SERVICE_EXITED:'生图运行服务已退出，请先核对已有记录；未知结果不会自动重发。',
 IMAGE_SERVICE_REQUEST_FAILED:'生图服务未完成请求，请核对记录与账号状态后再试。',
 IMAGE_GENERATION_FAILED:'服务报告生成失败，请核对记录与账号用量后再决定是否新建请求。',
 IMAGE_GENERATION_TIMEOUT:'等待生图结果超时，请重新核对记录；超时不代表没有消耗用量。',
 IMAGE_VALIDATION_UNAVAILABLE:'本机图像校验组件无法运行，结果未登记为成功产物。',
 IMAGE_ISOLATION_VIOLATION:'生图运行尝试了未授权能力，已停止；请核对结果与账号用量。',
 IMAGE_UNEXPECTED_REQUEST:'生图运行提出了未授权请求，已拒绝并停止。',
 IMAGE_PROTOCOL_INVALID:'生图服务返回了无法核对的事件，结果未登记为成功产物。',
 IMAGE_MULTIPLE_RESULTS:'服务尝试生成多张图片，已停止且未登记为单图成功；请核对账号用量。',
 IMAGE_NOT_PRODUCED:'本次运行没有返回可核对的图片，请核对账号与图像记录。',
 IMAGE_RECORD_INVALID:'这条图像记录的来源或格式无效，不能继续引用。',
 IMAGE_RECORD_NOT_FOUND:'图像记录不存在，请重新读取当前任务的图像记录。',
 IMAGE_RESULT_UNAVAILABLE:'这条记录尚无已确认的成功图片，不能附为输入或导出。',
});
function message(error:unknown):string{
 const value=error instanceof Error?error.message:String(error);
 const key=Object.keys(reasons).find(code=>value.includes(code));
 return key?reasons[key as keyof typeof reasons]:uiText('图像操作未完成，请核对运行组件、账号或保存位置后重试。');
}
export function ImageGenerationPanel({work,onClose}:{work:Workbench;onClose:()=>void}){
 const taskId=work.task!.id,sessionId=work.session!.id;
 const [description,setDescription]=useState(''),[error,setError]=useState<unknown>(null),[busy,setBusy]=useState(false),[connecting,setConnecting]=useState(false);
 const [capability,setCapability]=useState<ImageCapability>(),[preview,setPreview]=useState<string|null>(null);
 const [unconfirmed,setUnconfirmed]=useState(false);
 const pending=useRef<{requestId:string;description:string}|undefined>(undefined);
 const textarea=useRef<HTMLTextAreaElement>(null);
 const {data,error:listError,mutate:reload}=useSWR(['imageGenerations',taskId],()=>api().request<{generations:ImageGenerationRecord[]}>('imageGeneration.list',{taskId}),
  {revalidateOnFocus:false,refreshInterval:value=>value?.generations.some(item=>['queued','running'].includes(item.state))?2000:0});
 useEffect(()=>{textarea.current?.focus();},[]);
 useEffect(()=>api().subscribe(event=>{
  const payload=event.data as {kind?:string;taskId?:string};
  if(event.event==='foundation.changed'&&payload.taskId===taskId&&payload.kind?.startsWith('imageGeneration.'))void reload();
 }),[taskId,reload]);
 const refresh=async()=>{
  setError(null);
  try{const current=await api().request<{generations:ImageGenerationRecord[]}>('imageGeneration.reconcile',{taskId});await reload(current,{revalidate:false});if(pending.current&&current.generations.some(item=>item.requestId===pending.current!.requestId)){pending.current=undefined;setUnconfirmed(false);setDescription('');}}
  catch(error){setError(error);}
 };
 const check=async()=>{setBusy(true);setError(null);try{const result=await api().request<ImageCapability>('imageGeneration.capability');setCapability(result);if(!result.available)setError(result.reasonCode);}catch(error){setError(error);}finally{setBusy(false);}};
 const connect=async()=>{setConnecting(true);setError(null);try{await api().request('imageGeneration.connect');await check();}catch(error){setError(error);}finally{setConnecting(false);}};
 const submit=async()=>{
  if(!description.trim()||busy)return;
  const request=pending.current??{requestId:crypto.randomUUID(),description};pending.current=request;
  setBusy(true);setError(null);
  try{
   const result=await work.mutateStore<{generation:ImageGenerationRecord}>('imageGeneration.start',{requestId:request.requestId,taskId,sessionId,description:request.description});
   pending.current=undefined;setUnconfirmed(false);setDescription('');
   await reload(current=>({generations:[current?.generations.find(item=>item.id===result.generation.id&&(item.revision>result.generation.revision))??result.generation,...(current?.generations.filter(item=>item.id!==result.generation.id)??[])]}),{revalidate:false});
   void reload().catch(()=>{});
  }catch(error){
   const rejected=/IMAGE_DESCRIPTION_CONTAINS_CREDENTIAL|IMAGE_TASK_INACTIVE|IMAGE_TASK_MAIN_REQUIRED|IMAGE_TASK_BUSY|IMAGE_CONNECTION_BUSY|IMAGE_SERVICE_EXITED|IDEMPOTENCY_KEY_REUSED|INVALID_PARAMS|INVALID_ARGUMENT/u.test(String(error));
   if(rejected)pending.current=undefined;
   setUnconfirmed(!rejected);setError(error);
  }
  finally{setBusy(false);}
 };
 const attach=async(record:ImageGenerationRecord)=>{
  setBusy(true);setError(null);
  try{
   const owner=work.draftKey;
   const result=await work.mutateStore<{attachment:ManagedAttachment}>('imageGeneration.attach',{taskId,generationId:record.id,sessionId,draftKey:owner});
   work.updateDraft(owner,previous=>({...previous,attachments:[...(previous.attachments??[]).filter(item=>item.id!==result.attachment.id),result.attachment]}));
  }
  catch(error){setError(error);}finally{setBusy(false);}
 };
 const inspect=async(record:ImageGenerationRecord)=>{setError(null);try{const result=await api().request<{dataUrl:string}>('imageGeneration.image',{taskId,generationId:record.id});setPreview(result.dataUrl);}catch(error){setError(error);}};
 const exportImage=async(record:ImageGenerationRecord)=>{setBusy(true);setError(null);try{await api().exportGeneratedImage({taskId,generationId:record.id});}catch(error){setError(error);}finally{setBusy(false);}};
 const active=data?.generations.some(item=>['queued','running'].includes(item.state));
 return <section className="image-generation-panel" aria-label={uiText('任务图像生成')}>
  <header><ImagePlus size={16}/><strong>{uiText('生成图片')}</strong><span className="image-experimental">{uiText('试验')}</span><span className="spacer"/>
   <button className="icon-button" type="button" aria-label={uiText('关闭图像生成')} onClick={onClose}><X size={16}/></button></header>
  <p className="muted image-disclosure">{uiText('只发送这次描述给 OpenAI，使用当前 Codex 订阅账号的适用用量。不会附带项目文件、任务历史或其他附件。本试验不能保证单次扣量，额度与实际消耗未知。')}</p>
  <div className="image-account"><span>{capability?.available?uiText('账号与运行前检查已通过'):uiText('提交前会核对账号与图像能力')}{capability?.plan?` · ${capability.plan}`:''}</span>
   <button className="text-button" disabled={busy||connecting||work.hostDead} onClick={()=>void check()}>{uiText('检查 Codex 账号')}</button>
   <button className="text-button" disabled={busy||connecting||active||work.hostDead} onClick={()=>void connect()}>{connecting?uiText('等待浏览器登录…'):uiText('连接 Codex')}</button>
   {connecting&&<button className="text-button" onClick={()=>void api().request('imageGeneration.cancelConnection')}>{uiText('停止等待登录')}</button>}
  </div>
  {!!error&&<p className="inline-error" role="alert">{message(error)}</p>}
  {listError&&<p className="inline-error" role="alert">{uiText('图像记录暂时无法读取，当前列表不能代表完整历史。')} <button className="text-button" onClick={()=>void refresh()}>{uiText('重新读取')}</button></p>}
  {unconfirmed&&<p className="inline-error" role="status">{uiText('提交结果尚未核对。可先重新读取；重新提交沿用原请求身份，若请求尚未送达，将开始生成并消耗适用用量。')} <button className="text-button" onClick={()=>void refresh()}>{uiText('核对提交状态')}</button></p>}
  <div className="input-surface image-description"><textarea ref={textarea} value={description} maxLength={8000} rows={3} disabled={busy||connecting||unconfirmed} onChange={event=>setDescription(event.target.value)} placeholder={uiText('描述一张你想生成的图片…')} aria-label={uiText('图像描述')}/></div>
  <div className="image-form-actions"><span className="muted">{uiText('当前普通消息草稿与附件会保留。App Server 属于试验能力。')}</span>
   <button type="button" className="primary-button" disabled={!description.trim()||busy||connecting||active||work.hostDead||work.closing} onClick={()=>void submit()}>{busy?uiText('正在处理图像请求…'):unconfirmed?uiText('重新提交原请求'):uiText('生成一张')}</button></div>
  <div className="image-generation-history" aria-label={uiText('本任务图像记录')}>
   {data?.generations.map(record=><article className="image-generation-record" key={record.id} data-generation-id={record.id} data-generation-state={record.state}>
    <div><strong>{stateLabels[record.state]}</strong><time>{new Date(record.createdAt).toLocaleString(work.preferences?.language??'zh-CN')}</time></div>
    <p>{record.description}</p>
    {record.errorCode&&<p className="muted">{message(record.errorCode)}</p>}
    {record.state==='unknown'&&<p className="muted">{uiText('中断或停止不代表没有生成，也不撤销已发生用量。本记录保留，不会在重启后自动重发。')}</p>}
    <div className="image-record-actions">
     {record.state==='succeeded'&&<><button className="text-button" onClick={()=>void inspect(record)}><ImagePlus size={14}/>{uiText('预览生成图片')}</button><button className="text-button" disabled={busy||work.viewingHistory} onClick={()=>void attach(record)}><Paperclip size={14}/>{uiText('用作输入附件')}</button><button className="text-button" disabled={busy} onClick={()=>void exportImage(record)}><Download size={14}/>{uiText('导出图片')}</button></>}
     {['queued','running'].includes(record.state)&&<button className="text-button" onClick={()=>void api().request('imageGeneration.cancel',{taskId,generationId:record.id}).then(()=>reload()).catch(error=>setError(error))}><Square size={12}/>{uiText('停止等待生图')}</button>}
     {record.state==='unknown'&&<button className="text-button" onClick={()=>void refresh()}><RefreshCw size={14}/>{uiText('重新核对记录')}</button>}
     {record.state==='unknown'&&record.errorCode==='IMAGE_TURN_INCOMPLETE'&&['failed','interrupted'].includes(record.terminalStatus??'')&&record.resultInfo&&<button className="text-button" onClick={()=>void inspect(record)}>{uiText('查看已保存的待核对图片')}</button>}
    </div>
   </article>)}
  </div>
  {preview&&<ImagePreview src={preview} onClose={()=>setPreview(null)}/>}
 </section>;
}
