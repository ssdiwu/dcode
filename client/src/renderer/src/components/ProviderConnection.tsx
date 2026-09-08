import {useCallback,useEffect,useRef,useState} from "react";
import type { ProviderConnection as Connection } from "../../../../../host/src/model-connections.js";
import type { ApiKeyConnectionResult } from "../../../../../host/src/api-key-connection.js";
import type { ModelControls } from "../workbench/useModels";
import { LoaderCircle } from "lucide-react";

const labels:Record<Connection["state"],string>={
  refresh_pending:"登录待更新",timed_out:"登录已超时，请重试",sync_required:"连接已保存，目录更新失败",disconnected:"未连接",configured:"连接已保存",connected:"已连接",reconnect_required:"需要重新登录",awaiting_input:"请完成授权步骤",awaiting_browser:"等待浏览器授权",saving:"正在连接…",failed:"连接未完成",cancelled:"已取消连接",
};
const failures:Record<Extract<ApiKeyConnectionResult,{ok:false}>["code"],string>={
  INVALID_INPUT:"请输入有效的 API Key。",BUSY:"另一项连接正在处理，请稍后重试。",UNAVAILABLE:"连接服务暂不可用，请稍后重试。",FAILED:"连接失败，请检查后重试。",SYNC_REQUIRED:"密钥已保存，模型目录更新失败。请重试更新。",OUTCOME_UNKNOWN:"连接结果尚未确认，请刷新连接状态后检查。",
};
export function ProviderConnection({providerId,models}:{providerId:string;models:ModelControls}){
  const input=useRef<HTMLInputElement|null>(null),mounted=useRef(true),flight=useRef(false),container=useRef<HTMLDivElement|null>(null);
  const [hasKey,setHasKey]=useState(false),[editing,setEditing]=useState(false),[submitting,setSubmitting]=useState(false),[error,setError]=useState<string|null>(null);
  // The key lives only in this password input, never in React state or a draft.
  const bindInput=useCallback((node:HTMLInputElement|null)=>{if(input.current&&input.current!==node)input.current.value="";input.current=node;},[]);
  const clear=useCallback(()=>{if(input.current)input.current.value="";setHasKey(false);setEditing(false);setError(null);},[]);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;if(input.current)input.current.value="";};},[]);
  useEffect(()=>{if(editing)input.current?.focus();},[editing]);
  const connection=models.connections?.providers.find(p=>p.providerId===providerId);
  useEffect(()=>{const details=container.current?.closest("details");if(!details)return;const toggle=()=>{if(!details.open)clear();};details.addEventListener("toggle",toggle);return()=>details.removeEventListener("toggle",toggle);},[!!connection,clear]);
  if(!connection)return null;
  const pending=["awaiting_input","awaiting_browser","saving"].includes(connection.state);
  const supportsApiKey=connection.methods.some(method=>method.type==="api_key");
  const showInput=supportsApiKey&&(editing||!connection.managed||submitting)&&!(pending&&connection.activeMethod==="oauth");
  const submit=async(event:React.FormEvent)=>{
    event.preventDefault();
    if(flight.current||submitting||models.connecting||!input.current?.value.trim())return;
    flight.current=true;setSubmitting(true);setEditing(true);setError(null);
    let key=input.current.value;
    try{
      const result=await models.connectApiKey(providerId,key);key="";
      if(!mounted.current)return;
      if(result.ok){clear();}
      else if(result.code==="SYNC_REQUIRED"){clear();setError(failures.SYNC_REQUIRED);}
      else setError(failures[result.code]);
    }catch{if(mounted.current)setError(failures.OUTCOME_UNKNOWN);}
    finally{key="";flight.current=false;if(mounted.current)setSubmitting(false);}
  };
  return <div ref={container} className="provider-connection" aria-label={`${providerId} 连接`}>
    <div className="provider-connection-status"><span role="status">{(pending||submitting)&&<LoaderCircle className="connection-spinner" size={14}/>} {submitting?"正在连接…":labels[connection.state]}</span>
      {connection.state==="configured"&&<span className="secondary">首次使用时会验证模型访问权限。</span>}
      {connection.state==="refresh_pending"&&<span className="secondary">下次使用时自动更新授权。</span>}
      {connection.external&&<span className="secondary">当前使用已有的外部连接。</span>}
    </div>
    <div className="provider-connection-actions">
      {showInput&&<form className="provider-api-form" onSubmit={event=>void submit(event)} onKeyDown={event=>{if(event.key==="Enter"&&(event.nativeEvent.isComposing||event.nativeEvent.keyCode===229)){event.preventDefault();return;}if(event.key==="Escape"&&!submitting&&!pending){event.preventDefault();event.stopPropagation();clear();}}}>
        <input ref={bindInput} type="password" aria-label="API Key" placeholder="输入 API Key" autoComplete="off" autoCapitalize="off" spellCheck={false} maxLength={16384} required disabled={submitting||pending} onInput={event=>{setHasKey(!!event.currentTarget.value.trim());setError(null);}}/>
        <button type="submit" className="primary-button" disabled={!hasKey||models.connecting||submitting}>{submitting?"连接中…":"连接"}</button>
        {(hasKey||editing)&&<button type="button" className="text-button" disabled={submitting||pending} onClick={clear}>取消</button>}
      </form>}
      {pending&&!showInput?connection.state!=="saving"&&<button className="text-button" onClick={()=>void models.cancelConnection(connection.flowId!)}>取消连接</button>:!submitting&&!pending&&<>
        {connection.state==="sync_required"&&<button className="text-button" onClick={()=>void models.refreshConnections()}>重试更新</button>}
        {supportsApiKey&&connection.managed&&!showInput&&<button className="text-button" disabled={models.connecting} onClick={()=>setEditing(true)}>更换密钥</button>}
        {connection.methods.filter(method=>method.type==="oauth").map(method=><button className="text-button" key={method.type} disabled={models.connecting} onClick={()=>{clear();void models.connect(providerId,method.type);}}>{connection.managed?"重新登录":method.label}</button>)}
        {connection.managed&&!showInput&&<button className="text-button" disabled={models.connecting} onClick={()=>void models.disconnect(providerId)}>断开 D Code 连接</button>}
        {!connection.methods.length&&!connection.managed&&<span className="secondary">使用系统环境或供应商配置连接。</span>}
      </>}
    </div>
    {error&&<p className="provider-connection-error" role="alert">{error}</p>}
  </div>;
}
