import {useLayoutEffect,useRef} from "react";

const focusableSelector =
  'a[href],area[href],button,input,select,textarea,[contenteditable]:not([contenteditable="false"]),[tabindex]';

function focusableIn(panel:HTMLElement):HTMLElement[]{
  return [...panel.querySelectorAll<HTMLElement>(focusableSelector)]
    .filter(element=>{
      if(element.matches(":disabled") || element.getAttribute("aria-disabled")==="true" || element.matches('input[type="hidden"]'))return false;
      if(element.tabIndex<0 && (element.hasAttribute("tabindex") || !element.hasAttribute("contenteditable")))return false;
      for(let current:HTMLElement|null=element;current;current=current.parentElement){
        if(current.hidden || current.inert || current.getAttribute("aria-hidden")==="true")return false;
        const style=getComputedStyle(current);
        if(style.display==="none" || style.visibility==="hidden" || style.visibility==="collapse")return false;
        if(current===panel)break;
      }
      return true;
    })
    .sort((left,right)=>left.tabIndex>0&&right.tabIndex>0?left.tabIndex-right.tabIndex
      :left.tabIndex>0?-1:right.tabIndex>0?1:0);
}

export function useModalFocus<T extends HTMLElement>({
  onClose,returnFocus,
}:{onClose:()=>void;returnFocus?:()=>HTMLElement|null}){
  const panel=useRef<T|null>(null);
  const origin=useRef<HTMLElement|null>(document.activeElement instanceof HTMLElement?document.activeElement:null);
  const latest=useRef({onClose,returnFocus});
  latest.current={onClose,returnFocus};
  useLayoutEffect(()=>{
    const node=panel.current;
    if(!node)return;
    const items=focusableIn(node),preferred=node.querySelector<HTMLElement>("[data-dialog-initial-focus]");
    const initial=preferred&&items.includes(preferred)?preferred:items[0]??node;
    initial.focus();
    const onKeyDown=(event:KeyboardEvent)=>{
      if([...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')].at(-1)!==node || event.defaultPrevented)return;
      if(event.key==="Escape"){
        if(event.isComposing || event.keyCode===229)return;
        event.preventDefault();
        event.stopPropagation();
        latest.current.onClose();
      }else if(event.key==="Tab"){
        const items=focusableIn(node),first=items[0],last=items.at(-1);
        if(!first){event.preventDefault();node.focus();return;}
        const active=document.activeElement;
        if(!node.contains(active) || active===node || event.shiftKey&&active===first || !event.shiftKey&&active===last){
          event.preventDefault();
          (event.shiftKey?last:first)?.focus();
        }
      }
    };
    document.addEventListener("keydown",onKeyDown);
    return ()=>{
      document.removeEventListener("keydown",onKeyDown);
      queueMicrotask(()=>{
        if(node.isConnected)return;
        const top=[...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')].at(-1);
        const candidates=[origin.current,latest.current.returnFocus?.()];
        const target=candidates.find(candidate=>candidate?.isConnected && (!top || top.contains(candidate)));
        if(target)target.focus();
        else if(top)(top.querySelector<HTMLElement>("[data-dialog-initial-focus]")??focusableIn(top)[0]??top).focus();
      });
    };
  },[]);
  return panel;
}
