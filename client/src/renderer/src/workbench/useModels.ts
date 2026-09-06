import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { api, errorText } from "../types";
import type { HostMethod } from "../../../../../host/src/protocol.js";
import type { DCodeModelsView } from "../../../../../host/src/model-catalog-view.js";

export function useModels({sessionId, mutateStore, onChanged, onError}: {
  sessionId?: string;
  mutateStore: <T>(method: HostMethod, params: Record<string, unknown>) => Promise<T>;
  onChanged: () => Promise<unknown>;
  onError: (error: unknown) => void;
}) {
  const key = ["dcodeModels", sessionId ?? "default"];
  const target = sessionId ? {dcodeSessionId:sessionId} : {};
  const {data, error, mutate} = useSWR<DCodeModelsView>(key, () => api().request("dcodeModels.get",target), {revalidateOnFocus:false});
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
    if(event.event==="host.ready")void mutate();
  }),[sessionId,mutate]);
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
  return {data,loading:!data&&!error,error:failure??(error?errorText(error):null),refreshing,busy,refresh,
    choose:(key:string)=>choose(key),chooseDefault:(key:string)=>choose(key,true),
    enableAll:()=>run("clientPreferences.set",{enabledModels:null}),
    setEnabled:(key:string,enabled:boolean)=>{const current=data?.models.filter(m=>m.enabled).map(m=>m.key)??[];return run("clientPreferences.set",{enabledModels:enabled?[...new Set([...current,key])]:current.filter(id=>id!==key)});},
    setThinking:(level:string)=>run("dcodeModels.setThinking",{...target,level}),
    setDefaultThinking:(level:string)=>run("dcodeModels.setThinking",{level}),
  };
}
export type ModelControls = ReturnType<typeof useModels>;
