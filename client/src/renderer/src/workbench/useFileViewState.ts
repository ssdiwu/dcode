import {useLayoutEffect,type RefObject} from "react";
import type {FileTab,FileViewState,WorkspaceFileModel} from "./useWorkspaceFiles";

function textAnchor(element:HTMLElement):FileViewState["anchor"]{
  const bounds=element.getBoundingClientRect();
  const range=document.caretRangeFromPoint?.(bounds.left+20,bounds.top+12);
  if(!range||range.startContainer.nodeType!==Node.TEXT_NODE||!element.contains(range.startContainer))return;
  const path:number[]=[];let node:Node=range.startContainer;
  while(node!==element){const parent=node.parentNode;if(!parent)return;path.unshift(Array.prototype.indexOf.call(parent.childNodes,node));node=parent;}
  return {path,offset:range.startOffset,delta:range.getBoundingClientRect().top-bounds.top};
}
function restoreAnchor(element:HTMLElement,anchor:NonNullable<FileViewState["anchor"]>):boolean{
  let node:Node=element;
  for(const index of anchor.path){if(!node.childNodes[index])return false;node=node.childNodes[index];}
  if(node.nodeType!==Node.TEXT_NODE)return false;
  const range=document.createRange();range.setStart(node,Math.min(anchor.offset,node.textContent?.length??0));range.collapse(true);
  element.scrollTop+=range.getBoundingClientRect().top-element.getBoundingClientRect().top-anchor.delta;
  return true;
}

/** View coordinates belong to a tab; changing a container never copies its text. */
export function useFileViewState<T extends HTMLElement>(ref:RefObject<T|null>,tab:FileTab,surface:string,model:WorkspaceFileModel){
  useLayoutEffect(()=>{
    const element=ref.current;
    if(!element||!model.visible)return;
    const editor=element instanceof HTMLTextAreaElement?element:null;
    const revision=tab.lineRevision??0;
    const snapshot=():FileViewState=>({top:element.scrollTop,left:element.scrollLeft,lineRevision:revision,...(surface==="preview"?{anchor:textAnchor(element)}:{}),
      ...(editor?{start:editor.selectionStart,end:editor.selectionEnd,direction:editor.selectionDirection}: {})});
    const saved=model.readView(tab.id,surface);
    let restoring=true;
    if(editor&&tab.line!==undefined&&saved?.lineRevision!==revision){
      const lines=editor.value.split("\n");
      if(tab.line>0&&tab.line<=lines.length){
        const offset=lines.slice(0,tab.line-1).reduce((sum,line)=>sum+line.length+1,0);
        editor.setSelectionRange(offset,offset+lines[tab.line-1].length);
        editor.scrollTop=(tab.line-1)*20;
      }
      model.writeView(tab.id,surface,snapshot(),true);
    }else if(saved){
      if(editor&&saved.start!==undefined)editor.setSelectionRange(saved.start,saved.end??saved.start,saved.direction);
      element.scrollTop=saved.top;element.scrollLeft=saved.left;
      if(saved.anchor)restoreAnchor(element,saved.anchor);
    }
    // Preserve the desired offset if a larger viewport temporarily clamps it.
    // It changes only when the current view actually moves or the user edits.
    let applied=snapshot();
    const capture=()=>{
      if(restoring||!element.isConnected)return;
      const next=snapshot();
      if(JSON.stringify(next)!==JSON.stringify(applied)&&model.writeView(tab.id,surface,next))applied=next;
    };
    const unregister=model.registerView(tab.id,surface,capture);
    const frame=requestAnimationFrame(()=>{restoring=false;});
    for(const event of ["scroll","select","keyup","pointerup","input"])element.addEventListener(event,capture);
    return()=>{
      capture();unregister();cancelAnimationFrame(frame);
      for(const event of ["scroll","select","keyup","pointerup","input"])element.removeEventListener(event,capture);
    };
  },[tab.id,tab.mode,tab.loading,tab.document?.digest,tab.diff?.digest,tab.lineRevision,surface,model.expanded,model.visible]);
}
