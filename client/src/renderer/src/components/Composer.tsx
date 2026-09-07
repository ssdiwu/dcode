import {useCommands} from "../workbench/useCommands";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUp, Square, Plus, ImagePlus, FileText, X, Slash } from "lucide-react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { SelectMenu } from "./SelectMenu";
import { ModelPicker } from "./ModelPicker";
import type { ModelControls } from "../workbench/useModels";
import { thinkingLabels } from "../workbench/presentation";
import type { Workbench } from "../useWorkbench";
import { useComposerAttachments } from "../workbench/useComposerAttachments";
import { fileType } from "../workbench/attachments";

export function Composer({
  work,
  models,
  pathForFile,
  onSettings,
}: {
  work: Workbench;
  models: ModelControls;
  pathForFile: (file: File) => string;
  onSettings: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const filesInput = useRef<HTMLInputElement>(null);
  const {reading,add,thumbnails} = useComposerAttachments(work,pathForFile);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [dragging,setDragging] = useState(false);
  const dragDepth = useRef(0);
  const { draft, draftKey, updateDraft, snapshot } = work;
  const targetMember=draft.targetAgentRunId;
  const setTargetMember=(targetAgentRunId:string|undefined)=>updateDraft(draftKey,previous=>({...previous,targetAgentRunId}));
  const [mentionIndex,setMentionIndex]=useState(0);
  const [mentionOpen,setMentionOpen]=useState(false);
  const [commandOpen,setCommandOpen]=useState(false),[commandIndex,setCommandIndex]=useState(0);
  const {commands,error:commandError}=useCommands(work,commandOpen);
  const query=draft.text.match(/^\/(\S*)$/u)?.[1]?.toLowerCase()??"";
  const commandMatches=commands.filter(command=>command.name.toLowerCase().includes(query)||command.description?.toLowerCase().includes(query)).slice(0,50);
  const chooseCommand=(name:string)=>{setCommandOpen(false);updateDraft(draftKey,{...draft,text:/^\/[^/\s]*$/u.test(draft.text)?`/${name} `:`/${name} ${draft.text}`});textarea.current?.focus();};

  const members=(snapshot?.agentRuns??[]).filter(run=>run.taskId===work.task?.id&&run.role!=="coordinator").map(run=>({...run,title:snapshot?.sessions.find(session=>session.id===run.sessionId)?.title??"成员"}));
  useEffect(()=>{setMentionOpen(false);setCommandOpen(false);},[draftKey]);
  const [delivery,setDelivery]=useState<"queue"|"steer">("queue");
  const targetWorking=targetMember?snapshot?.sessionRuns.filter(run=>run.sessionId===members.find(member=>member.id===targetMember)?.sessionId).at(-1)?.status==="running":work.running;
  const send=()=>work.send(targetMember,targetWorking&&delivery==="steer"?"steer":undefined);
  const chooseMember=(id:string)=>{setMentionOpen(false);const member=members.find(item=>item.id===id);if(member){updateDraft(draftKey,{...draft,targetAgentRunId:id,text:draft.text.replace(/@[^\s@]*$/u,`@${member.title} `)});}textarea.current?.focus();};
  useLayoutEffect(() => {
    const element = textarea.current;
    if (!element) return;
    const resize = () => {element.style.height = "auto"; element.style.height = `${Math.min(200, Math.max(68, element.scrollHeight))}px`;};
    resize();
    let width = element.clientWidth;
    const observer = new ResizeObserver(() => { if (width !== element.clientWidth) {width = element.clientWidth;resize();} });
    observer.observe(element);
    return () => observer.disconnect();
  }, [draft.text,draftKey]);
  useEffect(() => {setDragging(false);dragDepth.current=0;}, [draftKey,work.closing]);
  useEffect(() => {
    const preventFileNavigation = (event: DragEvent) => { if ([...(event.dataTransfer?.types ?? [])].includes("Files")) event.preventDefault(); };
    window.addEventListener("dragover",preventFileNavigation);
    window.addEventListener("drop",preventFileNavigation);
    return () => {window.removeEventListener("dragover",preventFileNavigation);window.removeEventListener("drop",preventFileNavigation);};
  }, []);
  const canSend =
    !!snapshot &&
    !!models.data?.models.some(m=>m.key===models.data?.selectedKey&&m.available) &&
    (!!draft.text.trim() || !!draft.attachments?.length) &&
    !work.sending &&
    !mentionOpen && !commandOpen &&
    !(draft.pathAction&&work.running) &&
    !reading &&
    !work.hostDead &&
    !work.closing;
  const matchingMembers=members.filter(member=>member.title.includes(draft.text.match(/@([^\s@]*)$/u)?.[1]??""));
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if(commandOpen&&!event.nativeEvent.isComposing){if(event.key==="ArrowDown"||event.key==="ArrowUp"){event.preventDefault();setCommandIndex(index=>Math.max(0,Math.min(commandMatches.length-1,index+(event.key==="ArrowDown"?1:-1))));return;}if(event.key==="Enter"){event.preventDefault();const command=commandMatches[Math.min(commandIndex,commandMatches.length-1)];if(command)chooseCommand(command.name);return;}if(event.key==="Escape"){event.preventDefault();setCommandOpen(false);return;}}
    if(mentionOpen&&!event.nativeEvent.isComposing){
      if(event.key==="ArrowDown"||event.key==="ArrowUp"){event.preventDefault();setMentionIndex(index=>Math.max(0,Math.min(matchingMembers.length-1,index+(event.key==="ArrowDown"?1:-1))));return;}
      if(event.key==="Enter"){event.preventDefault();const member=matchingMembers[Math.min(mentionIndex,matchingMembers.length-1)];if(member)chooseMember(member.id);return;}
      if(event.key==="Escape"){event.preventDefault();setMentionOpen(false);return;}
    }
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing &&
      event.nativeEvent.keyCode !== 229
    ) {
      if(mentionOpen) {event.preventDefault();return;}
      event.preventDefault();
      if (canSend) void send();
    }
  };
  return (
    <div className="composer-wrap">
      {draft.pathAction&&<div className="path-draft-banner"><span>{draft.pathAction.kind==="editUser"?"编辑旧消息后继续":"从历史消息继续"} · 原路径会保留，已完成的文件操作不会撤销</span><button className="text-button" onClick={work.cancelPath}>取消，恢复原草稿</button></div>}
      {work.viewingHistory&&!draft.pathAction&&<div className="path-draft-banner"><span>正在查看历史路径</span><button className="text-button" onClick={()=>work.selectPath()}>返回当前对话</button></div>}
      {work.error && (
        <div role="alert" className="inline-error">
          {work.error}
          <button aria-label="关闭提示" onClick={() => work.setError(null)}>
            <X size={14} />
          </button>
        </div>
      )}
      <div className={`composer input-surface${dragging ? " is-dragging" : ""}`}
        onDragEnter={event=>{if ([...event.dataTransfer.types].includes("Files") && !work.closing) {event.preventDefault();dragDepth.current++;setDragging(true);}}}
        onDragOver={event=>{if ([...event.dataTransfer.types].includes("Files")) {event.preventDefault();event.dataTransfer.dropEffect=work.closing?"none":"copy";}}}
        onDragLeave={event=>{if (dragDepth.current>0) dragDepth.current--; if (!dragDepth.current) setDragging(false);}}
        onDrop={event=>{if (![...event.dataTransfer.types].includes("Files") && !event.dataTransfer.files.length) return; event.preventDefault();event.stopPropagation();dragDepth.current=0;setDragging(false);add([...event.dataTransfer.files]);}}
      >
        {dragging && <div className="composer-drop-hint">松开以添加图片或文件</div>}
        {(draft.images.length > 0 || !!draft.attachments?.length) && (
          <div className="attachments">
            {draft.images.map((img, i) => (
              <div className="attachment" key={i}>
                <img
                  src={`data:${img.mimeType};base64,${img.data}`}
                  alt={`图片 ${i + 1}`}
                />
                <button
                  className="attachment-remove"
                  aria-label={`移除图片 ${i + 1}`}
                  onClick={() =>
                    updateDraft(draftKey, {
                      ...draft,
                      images: draft.images.filter((_, index) => index !== i),
                    })
                  }
                >
                  <X size={12} />
                </button>
              </div>
            ))}
            {(draft.attachments ?? []).map(item => <div className={`attachment${item.mimeType.startsWith("image/") ? "" : " file-attachment"}`} key={item.id} title={`${item.name} · ${Date.parse(item.expiresAt)<=Date.now()?"已过期":"未发送时保留 1 天"}`}>
              <button className="attachment-preview" aria-label={`预览 ${item.name}`} onClick={()=>void work.previewAttachment(item.id)}>
                {thumbnails[item.id] ? <img src={`data:${item.mimeType};base64,${thumbnails[item.id]}`} alt={item.name}/> : <><span className="file-type">{fileType(item.name)}</span><span className="file-name">{item.name}</span></>}
              </button>
              <button className="attachment-remove" aria-label={`移除附件 ${item.name}`} onClick={()=>updateDraft(draftKey,previous=>({...previous,attachments:previous.attachments?.filter(value=>value.id!==item.id)}))}><X size={12}/></button>
            </div>)}
          </div>
        )}
        {targetMember&&<div className="composer-recipient">发送给 {members.find(member=>member.id===targetMember)?.title??"成员"}<button className="icon-button" aria-label="取消定向发送" onClick={()=>setTargetMember(undefined)}><X size={12}/></button></div>}
        {mentionOpen&&<div className="mention-options" id="member-mentions" role="listbox" aria-label="选择已有成员">{members.length?matchingMembers.map((member,index)=><button role="option" aria-selected={index===mentionIndex} id={`mention-${member.id}`} type="button" className="menu-item" key={member.id} onClick={()=>chooseMember(member.id)}>{member.title}<small>{member.role==="worker"?"执行":member.role==="verifier"?"验收":"调研"}</small></button>):<p className="secondary">暂无成员，可以让主智能体安排工作。</p>}<button className="text-button" onClick={()=>setMentionOpen(false)}>关闭</button></div>}
        {commandOpen&&<div className="mention-options command-options" role="listbox" aria-label="技能与命令">{commandMatches.map((command,index)=><button key={`${command.source}:${command.name}`} type="button" role="option" aria-selected={index===commandIndex} className="menu-item" onClick={()=>chooseCommand(command.name)}><span>/{command.name}<small>{command.description}</small></span><small>{command.source==="skill"?"技能":command.source==="prompt"?"模板":"命令"}</small></button>)}{!commandMatches.length&&<p className="secondary">{commandError||"没有匹配的已启用技能或命令。"}</p>}<button className="text-button" onClick={()=>setCommandOpen(false)}>关闭</button></div>}
        <textarea
          ref={textarea}
          aria-controls={mentionOpen?"member-mentions":undefined}
          aria-activedescendant={mentionOpen&&matchingMembers[mentionIndex]?`mention-${matchingMembers[mentionIndex].id}`:undefined}
          aria-label="任务消息"
          readOnly={work.closing}
          data-composer
          value={draft.text}
          onChange={(e) => {updateDraft(draftKey, { ...draft, text: e.target.value });setMentionOpen(!draft.pathAction&&/(?:^|\s)@[^\s@]*$/u.test(e.target.value));setMentionIndex(0);setCommandOpen(/^\/[^/\s]*$/u.test(e.target.value));setCommandIndex(0);}}
          onKeyDown={onKey}
          onPaste={(e) => {
            const files = [...e.clipboardData.files];
            if (files.length) {
              e.preventDefault();
              add(files);
            }
          }}
          placeholder={work.session ? "继续这项任务…" : "描述你想完成的任务…"}
          rows={3}
          maxLength={200000}
        />
        <div className="composer-controls">
          <Menu.Root>
            <Menu.Trigger asChild>
              <button
                className="icon-button"
                aria-label="添加附件"
                disabled={reading > 0}
              >
                <Plus size={18} />
              </button>
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Content
                className="menu"
                side="top"
                align="start"
                sideOffset={8}
              >
                <Menu.Item
                  className="menu-item"
                  onSelect={() => input.current?.click()}
                >
                  <ImagePlus size={15} />
                  图片…
                </Menu.Item>
                <Menu.Item
                  className="menu-item"
                  onSelect={() => filesInput.current?.click()}
                >
                  <FileText size={15} />
                  文件…
                </Menu.Item>
              </Menu.Content>
            </Menu.Portal>
          </Menu.Root>
          <input
            ref={input}
            hidden
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            onChange={(e) => {
              add([...(e.target.files ?? [])]);
              e.target.value = "";
            }}
          />
          <input
            ref={filesInput}
            hidden
            type="file"
            multiple
            onChange={(e) => {
              add([...(e.target.files ?? [])]);
              e.target.value = "";
            }}
          />
          {targetWorking&&!draft.pathAction&&<select className="delivery-select" aria-label="发送时机" value={delivery} onChange={event=>setDelivery(event.target.value as "queue"|"steer")}><option value="queue">排到后面</option><option value="steer">补充当前工作</option></select>}
          <button type="button" className="icon-button" aria-label="选择技能或命令" onClick={()=>{setCommandOpen(value=>!value);setMentionOpen(false);}}><Slash size={15}/></button>
          {!draft.pathAction&&members.length>0&&<Menu.Root><Menu.Trigger asChild><button type="button" className="text-button" aria-label="提及成员">@ 成员</button></Menu.Trigger><Menu.Portal><Menu.Content className="menu" side="top" onCloseAutoFocus={event=>{event.preventDefault();textarea.current?.focus();}}>{members.map(member=><Menu.Item className="menu-item" key={member.id} onSelect={()=>chooseMember(member.id)}>{member.title}</Menu.Item>)}</Menu.Content></Menu.Portal></Menu.Root>}
          <span className="spacer" />
          <ModelPicker models={models.data?.models??[]} value={models.data?.selectedKey??null} onChange={models.choose} onManage={onSettings} onRefresh={()=>models.refresh()} refreshing={models.refreshing} busy={models.busy || work.running}/>
          {(models.data?.thinkingLevels.length??0)>1 && <SelectMenu ariaLabel="选择思考强度" value={models.data?.thinking??null} placeholder="思考强度" options={(models.data?.thinkingLevels??[]).map(level=>({value:level,label:`思考 · ${thinkingLabels[level]??level}`}))} onChange={level=>void models.setThinking(level)}/>}
          {work.running ? (
            <button
              className="send-button stopping"
              aria-label="停止"
              onClick={() => void work.stop()}
            >
              <Square size={13} fill="currentColor" />
            </button>
          ) : null}
            <button
              className="send-button"
              aria-label="发送"
              onClick={() => void send()}
              disabled={!canSend}
            >
              <ArrowUp size={17} />
            </button>
        </div>
      </div>
      {!work.task && (
        <div className="scope-tray">
          <SelectMenu
            ariaLabel="任务归属"
            value={work.newProjectId ?? "user"}
            placeholder="独立任务"
            options={[
              { value: "user", label: "独立任务" },
              ...(snapshot?.projects ?? []).map((p) => ({
                value: p.id,
                label: p.title,
              })),
            ]}
            onChange={(id) => work.setNewProjectId(id === "user" ? null : id)}
          />
        </div>
      )}
      <div className="composer-status" role="status">
        {models.loading
          ? "正在读取模型与连接…"
          : reading
          ? "正在读取附件…"
          : work.sending
            ? "正在提交…"
            : work.running
              ? "可以继续补充，新消息会在当前回复结束后发送。"
              : !models.data?.selectedKey
                ? "选择模型后即可发送。"
                : draft.images.length && !draft.text.trim() && !draft.attachments?.length
                  ? "添加一句说明后即可发送。"
                  : draft.attachments?.length ? "附件已暂存，未发送时保留 1 天；发送后保留 30 天。" : ""}
      </div>
    </div>
  );
}
