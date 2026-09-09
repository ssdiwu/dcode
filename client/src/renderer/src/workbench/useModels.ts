import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { api, errorText } from "../types";
import type { HostMethod } from "../../../../../host/src/protocol.js";
import type { DCodeModelsView } from "../../../../../host/src/model-catalog-view.js";

import type { ProviderConnection } from "../../../../../host/src/model-connections.js";
type AuthType = "api_key" | "oauth";

export function useModels({sessionId, mutateStore, onChanged, onError}: {
  sessionId?: string;
  mutateStore: <T>(method: HostMethod, params: Record<string, unknown>) => Promise<T>;
  onChanged: () => Promise<unknown>;
  onError: (error: unknown) => void;
}) {
  const key = ["dcodeModels", sessionId ?? "default"];
  const target = sessionId ? {dcodeSessionId:sessionId} : {};
  const {data, error, mutate} = useSWR<DCodeModelsView>(key, () => api().request("dcodeModels.get",target), {revalidateOnFocus:false});
  const {data:connections,error:connectionError,mutate:mutateConnections}=useSWR<{providers:ProviderConnection[]}>("dcodeAuth",()=>api().request("dcodeAuth.get",{}),{revalidateOnFocus:false});
  const [connectionBusy,setConnectionBusy]=useState(false);
  const connecting=connectionBusy||!!connections?.providers.some(p=>["awaiting_input","awaiting_browser","saving"].includes(p.state));
  const connectionAction=async(method:HostMethod,params:Record<string,unknown>)=>{
    setConnectionBusy(true);setFailure(null);
    try{await api().request(method,params);await Promise.all([mutateConnections(),mutate()]);await onChanged();}
    catch(e){setFailure(errorText(e));}
    finally{setConnectionBusy(false);}
  };
  const apiKeyFlight=useRef(false);
  const connectApiKey=async(providerId:string,key:string)=>{
    if(apiKeyFlight.current)return {ok:false as const,code:"BUSY" as const};
    apiKeyFlight.current=true;setConnectionBusy(true);setFailure(null);
    try{
      const result=await api().connectApiKey(providerId,key);key="";
      // Clear the input from the private receipt; metadata refresh must not hold
      // the secret or downgrade a confirmed save into an unknown outcome.
      void (async()=>{
        if(result.ok||result.code==="SYNC_REQUIRED"||result.code==="FAILED")await mutateConnections(current=>current?{providers:current.providers.map(p=>p.providerId===providerId?{...p,state:result.ok?"configured":result.code==="SYNC_REQUIRED"?"sync_required":"failed",...(result.ok||result.code==="SYNC_REQUIRED"?{managed:true,external:false}:{})}:p)}:current,false);
        await Promise.all([mutateConnections(),mutate()]);await onChanged();
      })().catch(()=>setFailure("连接操作已返回，页面刷新失败，请重新刷新连接状态。"));
      return result;
    }catch{return {ok:false as const,code:"OUTCOME_UNKNOWN" as const};}
    finally{key="";apiKeyFlight.current=false;setConnectionBusy(false);}
  };
  const [refreshing,setRefreshing]=useState(false);
  const [busy,setBusy]=useState(false);
  const [failure,setFailure]=useState<string|null>(null);
  const once=useRef(false);
  const refresh=async(force=true)=>{
    if(refreshing)return;
    setRefreshing(true);setFailure(null);
    try { await api().request("dcodeModels.refresh",{...target,force}); await mutate(); await onChanged(); }
    catch(e){setFailure(errorText(e));}
    finally {setRefreshing(false);}
  };
  useEffect(()=>{if(!once.current){once.current=true;void refresh(false);}},[]);
  useEffect(()=>api().subscribe(event=>{
    if(event.event==="foundation.changed" && /model|Model|clientPreferences/.test(String((event.data as {kind?:string})?.kind)))void mutate();
    if(event.event==="foundation.changed" && String((event.data as {kind?:string})?.kind)==="providerCall.changed")void mutateConnections();
    if(event.event==="dcodeAuth.changed"){void mutateConnections();void mutate();}
    if(event.event==="host.ready"){void mutate();void mutateConnections();}
  }),[sessionId,mutate,mutateConnections]);
  const run=async(method:HostMethod,params:Record<string,unknown>)=>{
    if(busy)return;
    setBusy(true);setFailure(null);
    try {await mutateStore(method,params);await mutate();await onChanged();}
    catch(e){setFailure(errorText(e));onError(e);}
    finally{setBusy(false);}
  };
  const choose=(value:string,asDefault=false)=>{
    const model=data?.models.find(m=>m.key===value);
    if(model)return run("dcodeModels.select",{...(asDefault?{}:target),providerId:model.providerId,modelId:model.modelId});
  };
  return {data,connections,connecting,connectApiKey,
    refreshConnections:()=>connectionAction("dcodeAuth.refresh",{}),
    connect:(providerId:string,authType:AuthType)=>connectionAction("dcodeAuth.start",{providerId,authType,flowId:crypto.randomUUID()}),
    openLoginPage:(flowId:string)=>connectionAction("dcodeAuth.openBrowser",{flowId}),
    enterLoginCode:(flowId:string)=>connectionAction("dcodeAuth.enterCode",{flowId}),
    cancelConnection:(flowId:string)=>connectionAction("dcodeAuth.cancel",{flowId}),
    disconnect:(providerId:string)=>connectionAction("dcodeAuth.disconnect",{providerId}),
    loading:!data&&!error,error:failure??(error?errorText(error):connectionError?errorText(connectionError):null),refreshing,busy,refresh,
    choose:(key:string)=>choose(key),chooseDefault:(key:string)=>choose(key,true),
    enableAll:()=>run("clientPreferences.set",{enabledModels:null}),
    setEnabled:(key:string,enabled:boolean)=>{const current=data?.models.filter(m=>m.enabled).map(m=>m.key)??[];return run("clientPreferences.set",{enabledModels:enabled?[...new Set([...current,key])]:current.filter(id=>id!==key)});},
    setThinking:(level:string)=>run("dcodeModels.setThinking",{...target,level}),
    setQuotaThreshold:(modelQuotaThresholdPercent:number)=>run("clientPreferences.set",{modelQuotaThresholdPercent}),
    setDefaultThinking:(level:string)=>run("dcodeModels.setThinking",{level}),
  };
}
export type ModelControls = ReturnType<typeof useModels>;
