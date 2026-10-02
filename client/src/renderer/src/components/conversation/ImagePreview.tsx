import { uiText } from "../../../../shared/ui-language.ts";
import { useEffect, useRef } from "react";
import { X } from "lucide-react";

/** Older inline images still have a viewer even when they predate managed attachment IDs. */
export function ImagePreview({src,onClose}:{src:string;onClose:()=>void}) {
  const dialog=useRef<HTMLDialogElement>(null);
  useEffect(()=>{dialog.current?.showModal();},[]);
  return <dialog className="image-preview-dialog" ref={dialog} aria-label={uiText("图片预览")} onClose={onClose} onClick={event=>{if(event.target===event.currentTarget)dialog.current?.close();}}>
    <button className="icon-button image-preview-close" aria-label={uiText("关闭图片预览")} onClick={()=>dialog.current?.close()}><X size={20}/></button>
    <img src={src} alt={uiText("图片预览")}/>
  </dialog>;
}
