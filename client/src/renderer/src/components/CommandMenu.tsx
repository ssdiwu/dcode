import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { createPortal } from "react-dom";
import { autoUpdate, flip, offset, shift, size, useFloating } from "@floating-ui/react-dom";
import { Box, FileText, Terminal, X } from "lucide-react";
import { commandGroupLabels, commandGroups, type CommandOption } from "../workbench/command-menu";

interface Props {
  anchor: RefObject<HTMLDivElement | null>;
  input: RefObject<HTMLTextAreaElement | null>;
  trigger: RefObject<HTMLButtonElement | null>;
  options: CommandOption[];
  active: number;
  loading: boolean;
  error: string;
  onActive: (index: number) => void;
  onChoose: (canonicalName: string) => void;
  onClose: () => void;
}

export function CommandMenu({anchor,input,trigger,options,active,loading,error,onActive,onChoose,onClose}:Props) {
  const list = useRef<HTMLDivElement>(null);
  const {refs,floatingStyles,isPositioned,placement} = useFloating({
    open:true, strategy:"fixed", placement:"top-start", whileElementsMounted:autoUpdate,
    middleware:[offset(8),flip({padding:8}),shift({padding:8}),size({padding:8,apply({availableWidth,availableHeight,rects,elements}) {
      Object.assign(elements.floating.style, {width:`${Math.max(0,Math.min(rects.reference.width,availableWidth))}px`,maxHeight:`${Math.max(0,Math.min(360,availableHeight))}px`});
    }})],
  });
  useLayoutEffect(() => { refs.setReference(anchor.current); }, [anchor,refs.setReference]);
  useEffect(() => {
    const outside = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Node) || input.current === target || trigger.current?.contains(target) || refs.floating.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener("pointerdown",outside,true);
    document.addEventListener("focusin",outside);
    return () => { document.removeEventListener("pointerdown",outside,true);document.removeEventListener("focusin",outside); };
  }, [input,trigger,refs.floating,onClose]);
  useLayoutEffect(() => {
    const pane = list.current;
    if (!pane || !isPositioned) return;
    const reveal = () => {
      const row = pane.querySelector<HTMLElement>(`[data-command-index="${active}"]`);
      if (!row) return;
      const top = row.offsetTop, bottom = top + row.offsetHeight;
      if (top < pane.scrollTop) pane.scrollTop = top;
      else if (bottom > pane.scrollTop + pane.clientHeight) pane.scrollTop = bottom - pane.clientHeight;
    };
    reveal();
    const observer = new ResizeObserver(reveal);observer.observe(pane);
    return () => observer.disconnect();
  }, [active,options,isPositioned]);

  return createPortal(<div ref={refs.setFloating} className="command-popover" data-placement={placement} style={{...floatingStyles,visibility:isPositioned?"visible":"hidden"}} onKeyDown={event => {
    if (event.key === "Escape" && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {event.preventDefault();event.stopPropagation();onClose();input.current?.focus();}
  }}>
    <div ref={list} className="command-list" id="composer-commands" role="listbox" aria-label="技能与命令" aria-busy={loading}>
      {commandGroups.map(group => {
        const rows = options.map((option,index)=>({option,index})).filter(row=>row.option.group===group);
        if (!rows.length) return null;
        const Icon = group === "skill" ? Box : group === "prompt" ? FileText : Terminal;
        return <div role="group" aria-label={commandGroupLabels[group]} className="command-group" key={group}>
          <div className="command-group-title" aria-hidden="true">{commandGroupLabels[group]}</div>
          {rows.map(({option,index}) => <button key={option.key} id={`composer-command-${index}`} data-command-index={index} className="command-option" type="button" role="option" tabIndex={-1} aria-label={option.label} aria-describedby={option.command.description?`composer-command-description-${index}`:undefined} aria-selected={active===index} title={[option.label,option.command.description].filter(Boolean).join("\n")} onMouseDown={event=>event.preventDefault()} onPointerMove={()=>onActive(index)} onClick={()=>onChoose(option.command.name)}>
            <Icon size={15} aria-hidden="true"/>
            <span className="command-name">{option.label}</span>
            <span className="command-description" id={`composer-command-description-${index}`}>{option.command.description}</span>
          </button>)}
        </div>;
      })}
      {loading&&<p className="command-menu-state" role="status">正在读取技能与命令…</p>}
      {!loading&&error&&<p className="command-menu-state" role="alert">{error}</p>}
      {!loading&&!error&&!options.length&&<p className="command-menu-state">没有匹配的技能、命令或模板。</p>}
    </div>
    <div className="command-menu-footer"><span>{!loading&&!error?`${options.length} 项`:""}</span><span className="command-key-hints">↑↓ 选择 · Enter 使用 · Esc 关闭</span><button className="icon-button" type="button" aria-label="关闭技能菜单" tabIndex={-1} onMouseDown={event=>event.preventDefault()} onClick={()=>{onClose();input.current?.focus();}}><X size={13}/></button></div>
  </div>,document.body);
}
