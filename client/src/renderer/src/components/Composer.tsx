import { uiText, localizeUi } from "../../../shared/ui-language.ts";
import {CommandMenu} from "./CommandMenu";
import {ComposerAddMenu} from "./ComposerAddMenu";
import {TaskGoalEditor} from "./TaskGoalEditor";
import {TaskWorkflowPanel} from "./TaskWorkflowPanel";
import {ImageGenerationPanel} from "./ImageGenerationPanel";
import {commandOptions,hasCommandArguments} from "../workbench/command-menu";
import {useCommands} from "../workbench/useCommands";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUp, Square, X } from "lucide-react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { SelectMenu } from "./SelectMenu";
import { ModelPicker } from "./ModelPicker";
import type { ModelControls } from "../workbench/useModels";
import { thinkingLabels } from "../workbench/presentation";
import type { Workbench } from "../useWorkbench";
import { useComposerAttachments } from "../workbench/useComposerAttachments";
import { fileType } from "../workbench/attachments";
import { ContextUsage } from "./ContextUsage";
import {fileMentionAt,insertFileMention} from "../workbench/file-mentions";
import {useFileMentionSearch,type FileMentionEntry} from "../workbench/useFileMentionSearch";

type MemberPrefix = "$";
const memberToken = (text: string): { prefix: MemberPrefix; query: string; start: number } | null => {
  const match = /(^|\s)(\$)([^\s@$]*)$/u.exec(text);
  return match ? { prefix: match[2] as MemberPrefix, query: match[3], start: match.index + match[1].length } : null;
};
const memberStatusLabel: Record<string, string> = localizeUi({
  prepared: "待开始", running: "运行中", waiting: "等待处理", completed: "已完成",
  failed: "失败", aborted: "已停止", interrupted: "已中断", unknown: "状态待核对",
});

export function Composer({
  work,
  models,
  pathForFile,
  onSettings,
  onCommandMenuChange,
  workflowOpenSignal,
  onWorkflowSignalConsumed,
}: {
  work: Workbench;
  models: ModelControls;
  pathForFile: (file: File) => string;
  onSettings: () => void;
  onCommandMenuChange?: (open: boolean) => void;
  workflowOpenSignal?:number;
  onWorkflowSignalConsumed?:()=>void;
}) {
  const composer = useRef<HTMLDivElement>(null);
  const commandTrigger = useRef<HTMLButtonElement>(null);
  const workflowQuickTrigger=useRef<HTMLButtonElement>(null);
  const workflowOpenSource=useRef<"menu"|"quick"|"hud">("menu");
  const workflowCreatePending=useRef<{sourceDraftKey:string;promptId:string}|null>(null);
  const filesInput = useRef<HTMLInputElement>(null);
  const {reading,add,thumbnails} = useComposerAttachments(work,pathForFile);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [dragging,setDragging] = useState(false);
  const dragDepth = useRef(0);
  const { draft, draftKey, updateDraft, snapshot } = work;
  const targetMember=draft.targetAgentRunId;
  const setTargetMember=(targetAgentRunId:string|undefined)=>updateDraft(draftKey,previous=>({...previous,targetAgentRunId}));
  const [mentionIndex,setMentionIndex]=useState<number|null>(null);
  const [mentionOpen,setMentionOpen]=useState(false);
  const [fileCursor,setFileCursor]=useState<number|null>(null);
  const [fileOpen,setFileOpen]=useState(false);
  const [fileIndex,setFileIndex]=useState<number|null>(null);
  const fileToken=fileCursor===null?null:fileMentionAt(draft.text,fileCursor);
  const fileQuery=fileToken?.query??"";
  const projectId=work.task?.scope?.kind==="project"?work.task.scope.projectId:null;
  const project=projectId?snapshot?.projects.find(item=>item.id===projectId):undefined;
  const {entries:fileEntries,loading:fileLoading,error:fileError,scopeRequired:fileScopeRequired,truncated:fileTruncated}=useFileMentionSearch({open:fileOpen,query:fileQuery,taskId:work.task?.id,projectId,projectDirectory:project?.directory,projectRevision:project?.revision,hostDead:work.hostDead});
  const [commandOpen,setCommandOpen]=useState(false),[commandIndex,setCommandIndex]=useState(0);
  const [addOpen,setAddOpen]=useState(false);
  const [goalOpen,setGoalOpen]=useState(false);
  const [workflowOpen,setWorkflowOpen]=useState(false);
  const [imageOpen,setImageOpen]=useState(false);
  useEffect(()=>{setImageOpen(false);},[work.task?.id,work.session?.id]);
  useEffect(()=>{
    if(!workflowOpenSignal)return;
    workflowOpenSource.current="hud";setGoalOpen(false);setWorkflowOpen(true);
    onWorkflowSignalConsumed?.();
  },[workflowOpenSignal,onWorkflowSignalConsumed]);
  const [commandMode,setCommandMode]=useState<"browse"|"typing">("browse");
  const {commands,error:commandError,loading:commandsLoading}=useCommands(work,commandOpen);
  const query=(commandMode==="typing"?draft.text.match(/^\/([^/\n]*)$/u):draft.text.match(/^\/(\S*)$/u))?.[1]??"";
  const commandMatches=useMemo(()=>commandOptions(commands,query).filter(option=>commandMode==="browse"||option.group==="skill"),[commands,query,commandMode]);
  const activeCommand=Math.min(commandIndex,Math.max(0,commandMatches.length-1));
  const closeCommands=useCallback(()=>setCommandOpen(false),[]);
  useEffect(()=>{onCommandMenuChange?.(commandOpen||addOpen);return()=>onCommandMenuChange?.(false);},[commandOpen,addOpen,onCommandMenuChange]);
  useEffect(()=>{if(commandOpen&&commandMode==="typing"&&hasCommandArguments(draft.text,commands))setCommandOpen(false);},[commandOpen,commandMode,draft.text,commands]);
  const chooseCommand=(name:string)=>{setCommandOpen(false);updateDraft(draftKey,{...draft,text:(commandMode==="typing"?/^\/[^/\n]*$/u:/^\/[^/\s]*$/u).test(draft.text)?`/${name} `:`/${name} ${draft.text}`});textarea.current?.focus();};

  const members=(snapshot?.agentRuns??[]).filter(run=>run.taskId===work.task?.id&&run.role!=="coordinator").flatMap(run=>{
    const session=snapshot?.sessions.find(item=>item.id===run.sessionId&&item.taskId===work.task?.id&&item.kind==="child");
    return session?[{...run,title:session.title??uiText("成员")}]:[];
  });
  const canChooseSubagent=work.session?.kind==="coordination"&&work.task?.state!=="archived"&&!work.closing;
  const activeToken=memberToken(draft.text);
  const matchingMembers=members.filter(member=>member.title.toLocaleLowerCase().includes((activeToken?.query??"").toLocaleLowerCase()));
  const selectedMember=members.find(member=>member.id===targetMember);
  const invalidTarget=!!targetMember&&!selectedMember;
  const previousDraftKey=useRef(draftKey);
  useEffect(()=>{
    const previous=previousDraftKey.current;
    previousDraftKey.current=draftKey;
    const pending=workflowCreatePending.current;
    const targetIsCreatedTask=!!pending&&previous===pending.sourceDraftKey
      &&previous.startsWith("new:")
      &&draft.pendingWorkflowSubmission?.promptId===pending.promptId
      &&!!work.task&&!!work.session;
    if(previous!==draftKey&&!targetIsCreatedTask){workflowCreatePending.current=null;setWorkflowOpen(false);}
    setMentionOpen(false);setCommandOpen(false);setGoalOpen(false);setFileOpen(false);setFileCursor(null);
  },[draftKey]);
  const [delivery,setDelivery]=useState<"queue"|"steer">("queue");
  const targetWorking=targetMember?snapshot?.sessionRuns.filter(run=>run.sessionId===members.find(member=>member.id===targetMember)?.sessionId).at(-1)?.status==="running":work.running;
  const send=()=>work.send(targetMember,targetWorking&&delivery==="steer"?"steer":undefined);
  const chooseMember=(id:string,prefix:MemberPrefix)=>{
    setMentionOpen(false);
    setMentionIndex(null);
    const member=members.find(item=>item.id===id);
    if(!member||!canChooseSubagent)return;
    updateDraft(draftKey,previous=>{
      const token=memberToken(previous.text);
      const text=token?.prefix===prefix
        ? previous.text.slice(0,token.start)
        : previous.text;
      return {...previous,targetAgentRunId:id,text};
    });
    textarea.current?.focus();
  };
  const chooseFile=(entry:FileMentionEntry)=>{
    const token=fileCursor===null?null:fileMentionAt(draft.text,fileCursor);
    if(!token||!entry.markdown||!work.task||!projectId)return;
    const replacement=insertFileMention(draft.text,token,entry.markdown);
    updateDraft(draftKey,previous=>({...previous,text:replacement.text}));
    setFileOpen(false);setFileCursor(null);setFileIndex(null);
    const restoreCaret=()=>{textarea.current?.focus();textarea.current?.setSelectionRange(replacement.caret,replacement.caret);};
    if(typeof requestAnimationFrame==="function")requestAnimationFrame(restoreCaret);
    else setTimeout(restoreCaret,0);
  };
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
    !commandOpen && !invalidTarget &&
    !(draft.pathAction&&work.running) &&
    !reading &&
    !work.hostDead &&
    !work.closing;
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if(fileOpen){
      if(event.key==="Tab"){setFileOpen(false);return;}
      if((event.key==="ArrowDown"||event.key==="ArrowUp")&&fileEntries.length){event.preventDefault();setFileIndex(index=>index===null?(event.key==="ArrowDown"?0:fileEntries.length-1):Math.max(0,Math.min(fileEntries.length-1,index+(event.key==="ArrowDown"?1:-1))));return;}
      if(event.key==="Enter"&&fileIndex!==null&&fileEntries[fileIndex]){event.preventDefault();chooseFile(fileEntries[fileIndex]);return;}
      if(event.key==="Escape"){event.preventDefault();setFileOpen(false);return;}
    }
    if (commandOpen && event.key === "Tab") {setCommandOpen(false);return;}
    if(commandOpen&&!event.nativeEvent.isComposing){if(event.key==="ArrowDown"||event.key==="ArrowUp"){event.preventDefault();setCommandIndex(index=>Math.max(0,Math.min(commandMatches.length-1,index+(event.key==="ArrowDown"?1:-1))));return;}if(event.key==="Enter"){event.preventDefault();const command=commandMatches[Math.min(commandIndex,commandMatches.length-1)];if(command)chooseCommand(command.command.name);else if(!commandsLoading&&commands.some(item=>`/${item.name}`===draft.text.trim())){setCommandOpen(false);void send();}return;}if(event.key==="Escape"){event.preventDefault();setCommandOpen(false);return;}}
    if(mentionOpen&&!event.nativeEvent.isComposing){
      if(event.key==="Tab"){setMentionOpen(false);return;}
      if((event.key==="ArrowDown"||event.key==="ArrowUp")&&matchingMembers.length){event.preventDefault();setMentionIndex(index=>index===null?(event.key==="ArrowDown"?0:matchingMembers.length-1):Math.max(0,Math.min(matchingMembers.length-1,index+(event.key==="ArrowDown"?1:-1))));return;}
      if(event.key==="Enter"&&mentionIndex!==null){const member=matchingMembers[mentionIndex];if(member&&activeToken){event.preventDefault();chooseMember(member.id,activeToken.prefix);return;}}
      if(event.key==="Escape"){event.preventDefault();setMentionOpen(false);return;}
    }
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing &&
      event.nativeEvent.keyCode !== 229
    ) {
      event.preventDefault();
      if (canSend) {setMentionOpen(false);void send();}
    }
  };
  return (
    <div className="composer-wrap">
      {imageOpen&&work.task&&work.session?.kind==="coordination"&&!work.viewingHistory&&<ImageGenerationPanel key={work.task.id} work={work} onClose={()=>{setImageOpen(false);requestAnimationFrame(()=>commandTrigger.current?.focus());}}/>}
      {goalOpen&&(!work.session||work.session.kind==="coordination")&&<TaskGoalEditor key={work.task?.id??draftKey} work={work} onClose={()=>{setGoalOpen(false);commandTrigger.current?.focus();}}/>}
      {workflowOpen&&(!work.session||work.session.kind==="coordination")&&<TaskWorkflowPanel work={work} onSubmissionState={(active,promptId)=>{workflowCreatePending.current=active&&promptId?{sourceDraftKey:work.draftKey,promptId}:null;}} onClose={()=>{workflowCreatePending.current=null;setWorkflowOpen(false);requestAnimationFrame(()=>(workflowOpenSource.current==="quick"?workflowQuickTrigger.current:commandTrigger.current)?.focus());}}/>}
      {!workflowOpen&&work.task&&work.session?.kind==="coordination"&&(snapshot?.taskWorkflows??[]).some(item=>item.taskId===work.task?.id)&&<button ref={workflowQuickTrigger} type="button" className="task-workflow-open" onClick={()=>{workflowOpenSource.current="quick";setGoalOpen(false);setWorkflowOpen(true);}}>{uiText("查看本任务工作流")}</button>}
      {draft.pathAction&&<div className="path-draft-banner"><span>{draft.pathAction.kind==="editUser"?uiText("编辑旧消息后继续"):uiText("从历史消息继续")} {uiText(" · 原路径会保留，已完成的文件操作不会撤销")}</span><button className="text-button" onClick={work.cancelPath}>{uiText("取消，恢复原草稿")}</button></div>}
      {work.viewingHistory&&!draft.pathAction&&<div className="path-draft-banner"><span>{uiText("正在查看历史路径")}</span><button className="text-button" onClick={()=>work.selectPath()}>{uiText("返回当前对话")}</button></div>}
      {work.error && (
        <div role="alert" className="inline-error">
          {work.error}
          <button aria-label={uiText("关闭提示")} onClick={() => work.setError(null)}>
            <X size={14} />
          </button>
        </div>
      )}
      <div ref={composer} className={`composer input-surface${dragging ? " is-dragging" : ""}`}
        onDragEnter={event=>{if ([...event.dataTransfer.types].includes("Files") && !work.closing) {event.preventDefault();dragDepth.current++;setDragging(true);}}}
        onDragOver={event=>{if ([...event.dataTransfer.types].includes("Files")) {event.preventDefault();event.dataTransfer.dropEffect=work.closing?"none":"copy";}}}
        onDragLeave={event=>{if (dragDepth.current>0) dragDepth.current--; if (!dragDepth.current) setDragging(false);}}
        onDrop={event=>{if (![...event.dataTransfer.types].includes("Files") && !event.dataTransfer.files.length) return; event.preventDefault();event.stopPropagation();dragDepth.current=0;setDragging(false);add([...event.dataTransfer.files]);}}
      >
        {dragging && <div className="composer-drop-hint">{uiText("松开以添加图片或文件")}</div>}
        {(draft.images.length > 0 || !!draft.attachments?.length) && (
          <div className="attachments">
            {draft.images.map((img, i) => (
              <div className="attachment" key={i}>
                <img
                  src={`data:${img.mimeType};base64,${img.data}`}
                  alt={uiText("图片 {0}", [i + 1])}
                />
                <button
                  className="attachment-remove"
                  aria-label={uiText("移除图片 {0}", [i + 1])}
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
            {(draft.attachments ?? []).map(item => <div className={`attachment${item.mimeType.startsWith("image/") ? "" : " file-attachment"}`} key={item.id} title={`${item.name} · ${Date.parse(item.expiresAt)<=Date.now()?uiText("已过期"):uiText("未发送时保留 1 天")}`}>
              <button className="attachment-preview" aria-label={uiText("预览 {0}", [item.name])} onClick={()=>void work.previewAttachment(item.id)}>
                {thumbnails[item.id] ? <img src={`data:${item.mimeType};base64,${thumbnails[item.id]}`} alt={item.name}/> : <><span className="file-type">{fileType(item.name)}</span><span className="file-name">{item.name}</span></>}
              </button>
              <button className="attachment-remove" aria-label={uiText("移除附件 {0}", [item.name])} onClick={()=>updateDraft(draftKey,previous=>({...previous,attachments:previous.attachments?.filter(value=>value.id!==item.id)}))}><X size={12}/></button>
            </div>)}
          </div>
        )}
        {targetMember&&<div className="composer-recipient">{invalidTarget?<span role="alert">{uiText("所选成员不可接续或不在当前任务，请重新选择")}</span>:<span>{uiText("发送给 ")}{selectedMember?.title}</span>}<button className="icon-button" aria-label={uiText("取消定向发送")} onClick={()=>setTargetMember(undefined)}><X size={12}/></button></div>}
        {fileOpen&&fileToken&&<div className="mention-options file-mention-options" id="file-mentions" role="listbox" aria-label={uiText("搜索项目文件")} aria-busy={fileLoading}>
          {fileEntries.map((entry,index)=><button role="option" aria-selected={fileIndex===index} id={`file-mention-${index}`} type="button" tabIndex={-1} className="menu-item" key={entry.reference} onMouseDown={event=>event.preventDefault()} onClick={()=>chooseFile(entry)}><span>{entry.name}</span><small>{entry.relativePath}</small></button>)}
          {fileLoading&&<p className="secondary" role="status">{uiText("正在搜索项目文件…")}</p>}
          {!fileLoading&&fileError&&<p className="secondary" role="alert">{fileError}</p>}
          {!fileLoading&&!fileError&&fileScopeRequired&&<p className="secondary">{uiText("请先进入一个项目任务，再搜索该项目文件。")}</p>}
          {!fileLoading&&!fileError&&!fileScopeRequired&&!fileQuery.trim()&&<p className="secondary">{uiText("输入文件名以搜索当前项目。")}</p>}
          {!fileLoading&&!fileError&&!fileScopeRequired&&fileTruncated&&<p className="secondary" role="status">{uiText("项目文件未搜索完整，请输入更具体的文件名或路径。")}</p>}
          {!fileLoading&&!fileError&&!fileScopeRequired&&!!fileQuery.trim()&&!fileEntries.length&&!fileTruncated&&<p className="secondary">{uiText("没有匹配的项目文件。")}</p>}
          {!!fileEntries.length&&<p className="secondary">{uiText("引用指向当前项目文件；部分二进制格式暂不能在工作台预览。")}</p>}
          <button className="text-button" type="button" onClick={()=>setFileOpen(false)}>{uiText("关闭")}</button>
        </div>}
        {mentionOpen&&activeToken&&<div className="mention-options" id="member-mentions" role="listbox" aria-label={uiText("选择子代理")}>{matchingMembers.length?matchingMembers.map((member,index)=><button role="option" aria-selected={index===mentionIndex} id={`mention-${member.id}`} type="button" tabIndex={-1} className="menu-item" key={member.id} onMouseDown={event=>event.preventDefault()} onClick={()=>chooseMember(member.id,activeToken.prefix)}><span>{member.title}{members.filter(item=>item.title===member.title).length>1?` · #${member.id.slice(-6)}`:""}</span><small>{member.role==="worker"?uiText("执行"):member.role==="verifier"?uiText("验收"):uiText("调研")} · {memberStatusLabel[member.status]??uiText("状态待核对")}</small></button>):<p className="secondary">{uiText("暂无子代理，可直接请协调者分工")}</p>}<button className="text-button" type="button" onClick={()=>setMentionOpen(false)}>{uiText("关闭")}</button></div>}

        <textarea
          ref={textarea}
          aria-controls={fileOpen?"file-mentions":mentionOpen?"member-mentions":commandOpen?"composer-commands":undefined}
          aria-activedescendant={fileOpen&&fileIndex!==null&&fileEntries[fileIndex]?`file-mention-${fileIndex}`:mentionOpen&&mentionIndex!==null&&matchingMembers[mentionIndex]?`mention-${matchingMembers[mentionIndex].id}`:commandOpen&&commandMatches[activeCommand]?`composer-command-${activeCommand}`:undefined}
          aria-haspopup={commandOpen||mentionOpen||fileOpen?"listbox":undefined}
          aria-label={uiText("任务消息")}
          readOnly={work.closing}
          data-composer
          value={draft.text}
          onChange={(e) => {const text=e.target.value,caret=e.target.selectionStart,token=memberToken(text),file=fileMentionAt(text,caret),composing=(e.nativeEvent as InputEvent).isComposing;updateDraft(draftKey,{...draft,text});setFileCursor(caret);setFileOpen(!composing&&!draft.pathAction&&!!file);setFileIndex(null);setMentionOpen(!composing&&!draft.pathAction&&e.target.selectionStart===text.length&&!!token&&canChooseSubagent&&(!token.query||members.some(member=>member.title.toLocaleLowerCase().includes(token.query.toLocaleLowerCase()))));setMentionIndex(null);setCommandMode("typing");setCommandOpen(!file&&(/^\/[^/\s]*$/u.test(text)||(commandOpen&&/^\/[^/\n]*$/u.test(text)&&!hasCommandArguments(text,commands))));setCommandIndex(0);}}
          onSelect={event=>{const caret=event.currentTarget.selectionStart;setFileCursor(caret);setFileOpen(!!fileMentionAt(draft.text,caret));}}
          onKeyDown={onKey}
          onPaste={(e) => {
            const files = [...e.clipboardData.files];
            if (files.length) {
              e.preventDefault();
              add(files);
            }
          }}
          placeholder={work.session ? uiText("继续这项任务…") : uiText("描述你想完成的任务，输入 / 选择技能…")}
          rows={3}
          maxLength={200000}
        />
        <div className="composer-controls">
          <ComposerAddMenu work={work} trigger={commandTrigger} disabled={reading>0||work.closing}
            onOpenChange={open=>{setAddOpen(open);if(open){setCommandOpen(false);setMentionOpen(false);setFileOpen(false);}}}
            onAttachment={()=>filesInput.current?.click()}
            onGoal={!work.session||work.session.kind==="coordination"?()=>{setImageOpen(false);setWorkflowOpen(false);setGoalOpen(true);}:undefined}
            onWorkflow={!work.session||work.session.kind==="coordination"?()=>{workflowOpenSource.current="menu";setImageOpen(false);setGoalOpen(false);setWorkflowOpen(true);}:undefined}
            onImage={work.task&&work.session?.kind==="coordination"&&!work.viewingHistory&&!['accepted','archived'].includes(work.task.state)?()=>{setGoalOpen(false);setWorkflowOpen(false);setImageOpen(true);}:undefined}
            onCommand={name=>{updateDraft(draftKey,previous=>({...previous,text:`/${name} ${previous.text}`}));requestAnimationFrame(()=>textarea.current?.focus());}}
            hints={{file:!!projectId,member:canChooseSubagent}}/>
          {!work.task && (
          <SelectMenu
            ariaLabel={uiText("任务归属")}
            className="task-scope-chip"
            value={work.newProjectId ?? "user"}
            placeholder={uiText("独立任务")}
            options={[
              { value: "user", label: uiText("独立任务") },
              ...(snapshot?.projects ?? []).map((p) => ({
                value: p.id,
                label: p.title,
              })),
            ]}
            onChange={(id) => work.setNewProjectId(id === "user" ? null : id)}
          />
          )}
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
          {targetWorking&&!draft.pathAction&&<select className="delivery-select" aria-label={uiText("发送时机")} value={delivery} onChange={event=>setDelivery(event.target.value as "queue"|"steer")}><option value="queue">{uiText("排到后面")}</option><option value="steer">{uiText("补充当前工作")}</option></select>}
          {!draft.pathAction&&canChooseSubagent&&members.length>0&&<Menu.Root><Menu.Trigger asChild><button type="button" className="text-button" aria-label={uiText("选择子代理")}>{uiText("$ 子代理")}</button></Menu.Trigger><Menu.Portal><Menu.Content className="menu" side="top" onCloseAutoFocus={event=>{event.preventDefault();textarea.current?.focus();}}>{members.map(member=><Menu.Item className="menu-item" key={member.id} onSelect={()=>chooseMember(member.id,"$")}>{member.title}<small>{memberStatusLabel[member.status]??uiText("状态待核对")} · #{member.id.slice(-6)}</small></Menu.Item>)}</Menu.Content></Menu.Portal></Menu.Root>}
          {work.session && <ContextUsage key={`${work.session.id}:${work.presentation?.runtime?.runtimeId??"inactive"}:${work.presentation?.selectedNativePathId??"current"}`} work={work} models={models}/>}
          <div className="composer-actions">
          <ModelPicker models={models.data?.models??[]} value={models.data?.selectedKey??null} onChange={models.choose} onManage={onSettings} onRefresh={()=>models.refresh()} refreshing={models.refreshing} busy={models.busy || work.running}/>
          {(models.data?.thinkingLevels.length??0)>1 && <SelectMenu ariaLabel={uiText("选择思考强度")} value={models.data?.thinking??null} placeholder={uiText("思考强度")} options={(models.data?.thinkingLevels??[]).map(level=>({value:level,label:uiText("思考 · {0}", [thinkingLabels[level]??level])}))} onChange={level=>void models.setThinking(level)}/>}
          {work.running ? (
            <button
              className="send-button stopping"
              aria-label={uiText("停止")}
              onClick={() => void work.stop()}
            >
              <Square size={13} fill="currentColor" />
            </button>
          ) : null}
            <button
              className="send-button"
              aria-label={uiText("发送")}
              onClick={() => void send()}
              disabled={!canSend}
            >
              <ArrowUp size={17} />
            </button>
          </div>
        </div>
      </div>
      {commandOpen&&<CommandMenu anchor={composer} input={textarea} trigger={commandTrigger} options={commandMatches} active={activeCommand} loading={commandsLoading} error={commandError} onActive={setCommandIndex} onChoose={chooseCommand} onClose={closeCommands}/>}
      <div className="composer-status" role="status">
        {models.loading
          ? uiText("正在读取模型与连接…")
          : reading
          ? uiText("正在读取附件…")
          : work.sending
            ? uiText("正在提交…")
            : work.running
              ? uiText("可以继续补充，新消息会在当前回复结束后发送。")
              : !models.data?.selectedKey
                ? uiText("选择模型后即可发送。")
                : draft.images.length && !draft.text.trim() && !draft.attachments?.length
                  ? uiText("添加一句说明后即可发送。")
                  : draft.attachments?.length ? uiText("附件已暂存，未发送时保留 1 天；发送后保留 30 天。") : ""}
      </div>
    </div>
  );
}
