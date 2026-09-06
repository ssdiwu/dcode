import { useRef, useState } from "react";
import useSWR from "swr";
import type { Workbench } from "../useWorkbench";
import { api, type ManagedAttachment } from "../types";
import { attachmentSource } from "./attachments";

export function useComposerAttachments(work: Workbench, pathForFile:(file:File)=>string) {
  const [reading,setReading] = useState(0);
  const latest = useRef(work); latest.current = work;
  const queue = useRef<Promise<void>>(Promise.resolve());
  const items=work.draft.attachments??[];
  const {data:thumbnails}=useSWR(items.some(item=>item.mimeType.startsWith("image/"))?["attachment-thumbnails",items.map(item=>item.id).join(",")]:null,async()=>{
    const values=await Promise.all(items.filter(item=>item.mimeType.startsWith("image/")).map(async item=>{
      try {const value=await api().request<{data?:string}>("attachment.get",{id:item.id});return [item.id,value.data] as const;}catch{return [item.id,undefined] as const;}
    }));
    return Object.fromEntries(values);
  },{revalidateOnFocus:false});
  const add = (files: File[]) => {
    if (!files.length || work.closing) return;
    const owner = work.draftKey;
    setReading(count=>count+1);
    queue.current = queue.current.then(async()=>{
      if(files.length>32)throw new Error("一次最多添加 32 个附件。");
      for(const file of files){
        const source=await attachmentSource(file,pathForFile);
        await latest.current.addAttachment(owner,source);
      }
    }).catch(error=>latest.current.fail(error)).finally(()=>setReading(count=>count-1));
    work.trackAttachmentImport(queue.current);
  };
  return {reading,add,thumbnails:thumbnails??{}};
}
