import {useState} from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import {Check,ChevronDown,Search,RefreshCw,Settings} from "lucide-react";
import type {ModelChoice} from "../../../../../host/src/model-catalog-view.js";

export function ModelPicker({models,value,onChange,onManage,onRefresh,busy=false,refreshing=false,label="选择模型"}: {
  models:ModelChoice[]; value:string|null; onChange:(key:string)=>unknown; onManage:()=>void; onRefresh:()=>unknown; busy?:boolean; refreshing?:boolean; label?:string;
}) {
  const [query,setQuery]=useState("");
  const selected=models.find(m=>m.key===value);
  const available=models.filter(m=>m.available&&(m.enabled||m.key===value));
  const matches=available.filter(m=>`${m.name} ${m.modelId} ${m.providerName}`.toLowerCase().includes(query.toLowerCase()));
  return <Menu.Root onOpenChange={()=>setQuery("")}>
    <Menu.Trigger asChild><button type="button" className="model-trigger" aria-label={label} disabled={busy}>{selected?.name??(refreshing?"正在读取模型…":"选择模型")}<ChevronDown size={13}/></button></Menu.Trigger>
    <Menu.Portal><Menu.Content className="menu model-picker" side="top" align="end" sideOffset={7}>
      <div className="model-picker-search"><Search size={14}/><input aria-label="搜索可用模型" placeholder="搜索模型或供应商…" value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>e.stopPropagation()}/></div>
      <div className="model-picker-list">
        {matches.length?matches.map((model,i)=><div key={model.key}>
          {(i===0||matches[i-1].providerId!==model.providerId)&&<Menu.Label className="model-provider-label">{model.providerName}</Menu.Label>}
          <Menu.Item aria-label={model.name} className="menu-item model-picker-option" onSelect={()=>onChange(model.key)}><span><strong>{model.name}</strong><small>{model.modelId}</small></span>{model.key===value&&<Check size={14}/>}</Menu.Item>
        </div>):<p className="model-picker-empty">{available.length?"没有匹配的模型":"还没有已连接的模型，请先配置连接。"}</p>}
      </div>
      <Menu.Separator className="menu-separator"/>
      <Menu.Item className="menu-item" disabled={refreshing} onSelect={()=>onRefresh()}><RefreshCw size={14}/>{refreshing?"正在刷新…":"刷新模型目录"}</Menu.Item>
      <Menu.Item className="menu-item" onSelect={onManage}><Settings size={14}/>管理模型与连接</Menu.Item>
    </Menu.Content></Menu.Portal>
  </Menu.Root>;
}
