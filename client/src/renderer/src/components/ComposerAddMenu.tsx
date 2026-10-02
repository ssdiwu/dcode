import { uiText } from "../../../shared/ui-language.ts";
import {useRef,useState, type RefObject} from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import {FileText, GitBranch, ImagePlus, Paperclip, Plus, Target, Terminal, Wrench} from "lucide-react";
import {commandGroupLabels,commandGroups,commandOptions} from "../workbench/command-menu";
import {useCommands} from "../workbench/useCommands";
import type {Workbench} from "../useWorkbench";

interface Props {
  work:Workbench;
  trigger:RefObject<HTMLButtonElement|null>;
  onAttachment:()=>void;
  onGoal?:()=>void;
  onWorkflow?:()=>void;
  onImage?:()=>void;
  onCommand:(name:string)=>void;
  onOpenChange?:(open:boolean)=>void;
  hints?:{file:boolean;member:boolean};
  disabled?:boolean;
}

/** The menu lists only capabilities returned for the current D Code scope. */
export function ComposerAddMenu({work,trigger,onAttachment,onGoal,onWorkflow,onImage,onCommand,onOpenChange,hints,disabled}:Props) {
  const [open,setOpen]=useState(false);
  const openingEditor=useRef(false);
  const {commands,loading,error}=useCommands(work,open);
  const options=commandOptions(commands,"");
  const change=(next:boolean)=>{setOpen(next);onOpenChange?.(next);};
  return <Menu.Root open={open} onOpenChange={change} modal={false}>
    <Menu.Trigger asChild><button ref={trigger} className="icon-button" type="button" aria-label={uiText("添加内容")} disabled={disabled}><Plus size={18}/></button></Menu.Trigger>
    <Menu.Portal><Menu.Content className="composer-add-menu" side="top" align="start" sideOffset={8} collisionPadding={8} onCloseAutoFocus={event=>{
      if(!openingEditor.current)return;
      event.preventDefault();openingEditor.current=false;
      requestAnimationFrame(()=>(document.querySelector<HTMLElement>(".task-goal-editor textarea")
        ??document.querySelector<HTMLElement>(".task-workflow-panel textarea")
        ??document.querySelector<HTMLElement>(".image-generation-panel textarea")
        ??document.querySelector<HTMLElement>(".task-workflow-panel"))?.focus());
    }}>
      <div className="composer-add-heading">{uiText("添加")}</div>
      <div className="composer-add-list">
        <Menu.Item className="composer-add-option" onSelect={onAttachment}><Paperclip size={16}/><span>{uiText("附件")}</span></Menu.Item>
        {onGoal&&<Menu.Item className="composer-add-option" onSelect={()=>{openingEditor.current=true;onGoal();}}><Target size={16}/><span>{uiText("目标")}</span></Menu.Item>}
        {onWorkflow&&<Menu.Item className="composer-add-option" onSelect={()=>{openingEditor.current=true;onWorkflow();}}><GitBranch size={16}/><span>{uiText("工作流")}</span></Menu.Item>}
        {onImage&&<Menu.Item className="composer-add-option" onSelect={()=>{openingEditor.current=true;onImage();}}><ImagePlus size={16}/><span>{uiText("生成图片（试验）")}</span></Menu.Item>}
        <Menu.Separator className="composer-add-separator"/>
        {commandGroups.map(group=>{
          const rows=options.filter(option=>option.group===group);
          if(!rows.length)return null;
          const Icon=group==="skill"?Wrench:group==="prompt"?FileText:Terminal;
          return <Menu.Group key={group}>
            <Menu.Label className="composer-add-group">{commandGroupLabels[group]}</Menu.Label>
            {rows.map(option=><Menu.Item key={option.key} className="composer-add-option capability" onSelect={()=>onCommand(option.command.name)} title={[option.label,option.command.description].filter(Boolean).join("\n")}>
              <Icon size={16}/><span className="composer-add-name">{option.label}</span><span className="composer-add-description">{option.command.description}</span>
            </Menu.Item>)}
          </Menu.Group>;
        })}
        {loading&&<p className="composer-add-state" role="status">{uiText("正在读取当前可用能力…")}</p>}
        {!loading&&error&&<p className="composer-add-state" role="alert">{error}</p>}
        {!loading&&!error&&!options.length&&<p className="composer-add-state">{uiText("当前没有可从输入区调用的技能、命令或模板。")}</p>}
      </div>
      <div className="composer-add-footer">
        {hints?.file&&<span><kbd>@</kbd> {uiText(" 搜索文件")}</span>}
        <span><kbd>/</kbd> {uiText(" 查找技能")}</span>
        {hints?.member&&<span><kbd>$</kbd> {uiText(" 选择子代理")}</span>}
        <span className="composer-add-help">{uiText("只显示当前可调用能力")}</span>
      </div>
    </Menu.Content></Menu.Portal>
  </Menu.Root>;
}
