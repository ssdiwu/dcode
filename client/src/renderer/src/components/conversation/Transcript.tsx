import { CopyButton } from "../CopyButton";
import { LoadingPlaceholder } from "../LoadingPlaceholder";
import {projectConversationOrigins} from "../../workbench/conversation-origins";
import {AuxiliaryActivities} from "../AuxiliaryActivities";
import { CollaborationFeed } from "./CollaborationFeed";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDown, CornerDownLeft, GitBranch, Pencil, Sparkles } from "lucide-react";
import { Markdown } from "../Markdown";
import type { Workbench } from "../../useWorkbench";
import { messageRows, type MessageRow } from "../../workbench";
import { conversationTurns } from "../../workbench/conversation-navigation";
import { useConversationNavigation } from "../../workbench/useConversationNavigation";
import { ConversationRail } from "./ConversationRail";
import { ExecutionProcess } from "./ExecutionProcess";
import { executionTurns, mergeLiveRows } from "../../workbench/execution-process";
import { projectMessageAttachments } from "../../workbench/message-attachments";
import { fileType } from "../../workbench/attachments";
import { ImagePreview } from "./ImagePreview";

export function Transcript({ work, emptyBrand, onSaveInspiration }: { work: Workbench; emptyBrand: ReactNode; onSaveInspiration?:(text:string)=>void }) {
  const scroll = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const navigationPausedFollowing = useRef(false);
  const [showLatest, setShowLatest] = useState(false);
  const [imagePreview,setImagePreview] = useState<string|null>(null);
  const storedRows = useMemo(
    () => projectConversationOrigins([
      ...messageRows(
        work.imported.map((e) => ({
          id: e.sourceEntryId??e.id,
          type: "message",
          timestamp: e.sourceTimestamp ?? e.createdAt,
          message: { role: e.messageRole, content: e.content },
        })),
      ),
      ...messageRows((work.presentation?.nativeEntries??[]).filter(entry=>entry.sourceKind==="native"&&["user","assistant","other"].includes(entry.messageRole)&&(!work.presentation?.inspection||(entry.content as {handled?:boolean})?.handled===true)).map(entry=>({id:entry.sourceEntryId??entry.id,type:"message",timestamp:entry.createdAt,message:{role:entry.messageRole==="other"?"user":entry.messageRole,content:typeof entry.content==="object"&&entry.content!==null&&"text" in entry.content?String(entry.content.text):entry.content}}))),
      ...messageRows(work.presentation?.inspection?.entries ?? []),
    ].sort((a,b)=>a.time&&b.time?a.time.localeCompare(b.time):0),work.presentation?.collaborationInputs??[],work.session?.kind==="child"),
    [work.presentation, work.imported,work.session?.kind],
  );
  const restored = useRef(false);
  useEffect(() => {
    if (
      restored.current ||
      !work.preferences ||
      !work.presentation ||
      !scroll.current
    )
      return;
    const offset = work.readingPosition(work.session?.id ?? "");
    if (offset !== undefined) {
      scroll.current.scrollTop = offset;
      atBottom.current =
        scroll.current.scrollHeight - offset - scroll.current.clientHeight < 48;
    }
    restored.current = true;
  }, [work.preferences, work.presentation, work.session?.id]);
  const rows = useMemo(() => mergeLiveRows(projectMessageAttachments(storedRows,work.presentation?.submissions), work.stream), [storedRows, work.stream,work.presentation?.submissions]);
  const runStatus = work.viewingHistory ? undefined : work.hostDead && ["prepared","running"].includes(work.run?.status ?? "") ? "interrupted" : work.run?.status;
  const runningHere = work.running && !work.viewingHistory;
  const executions = useMemo(() => executionTurns(rows, work.stream, runningHere, runStatus), [rows, work.stream, runningHere, runStatus]);
  const turns = useMemo(() => conversationTurns(rows, ""), [rows]);
  const navigation = useConversationNavigation(turns, scroll, content);
  const rowSignature = `${work.snapshot?.collaborationMessages?.map(message=>message.revision).join(":")}:${rows.map(row=>row.parts.map(part=>part.text.length).join(",")).join(":")}:${work.stream.tools?.map(tool=>tool.output.length).join(",")}`;
  useEffect(() => {
    if (atBottom.current && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [rowSignature]);
  const quote = (text: string) => {
    work.updateDraft(work.draftKey, {
      ...work.draft,
      text: `${work.draft.text}${work.draft.text ? "\n" : ""}${text
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n")}\n`,
    });
    document.querySelector<HTMLTextAreaElement>("[data-composer]")?.focus();
  };
  const liveIds = new Set(runningHere ? work.stream.messages.filter(message => !message.ended).map(message => message.id) : []);
  const renderMessage = (row: MessageRow) => <article className={`message ${row.role}`} data-live={row.role === "assistant" && !!row.messageId && liveIds.has(row.messageId) || undefined} key={row.id} data-conversation-turn={row.role === "user"||row.role==="coordination" ? row.id : undefined} aria-label={row.role === "user" ? "你的消息" : row.role==="coordination"?"收到的工作安排":"D Code 回答"}>
    {row.role==="coordination"&&<strong className="message-attribution">来自主对话的安排</strong>}
    {row.parts.filter(part=>part.kind === "text" || part.kind === "image" || part.kind === "file").map((part,index)=>{
      if(part.kind === "file" && part.attachment)return <button key={index} className="message-file" aria-label={`预览 ${part.attachment.name}`} onClick={()=>void work.previewAttachment(part.attachment!.id)}><span className="file-type">{fileType(part.attachment.name)}</span><span>{part.attachment.name}</span>{Date.parse(part.attachment.expiresAt)<=Date.now()&&<small>已过期</small>}</button>;
      if(part.kind === "image")return <button key={index} className="message-image-button" aria-label={`放大预览 ${part.attachment?.name??"消息图片"}`} onClick={()=>part.attachment?void work.previewAttachment(part.attachment.id):setImagePreview(`data:${part.mimeType};base64,${part.text}`)}><img className="message-image" alt={part.attachment?.name??"消息图片"} src={`data:${part.mimeType};base64,${part.text}`}/></button>;
      return row.role === "assistant" ? <Markdown key={index} text={part.text}/> : <div className="user-text" key={index}>{part.text}</div>;
    })}

    {row.role === "assistant" && !!row.messageId && liveIds.has(row.messageId) && <span className="reply-writing" role="status"><i aria-hidden="true"/>正在回复</span>}
    <div className="message-actions">
      <CopyButton text={row.parts.filter(part=>part.kind === "text").map(part=>part.text).join("\n")} onError={work.fail}/>
      <button className="icon-button" aria-label="引用到输入框" onClick={()=>quote(row.parts.filter(part=>part.kind === "text").map(part=>part.text).join("\n"))}><CornerDownLeft size={13}/></button>
      {onSaveInspiration&&row.parts.some(part=>part.kind==="text"&&part.text.trim())&&<button className="icon-button" aria-label="保存到灵感" onClick={()=>onSaveInspiration(row.parts.filter(part=>part.kind==="text").map(part=>part.text).join("\n"))}><Sparkles size={13}/></button>}
      {(row.role==="user"||row.role==="assistant")&&work.presentation?.nativeEntries?.some(entry=>entry.sourceEntryId===row.id)&&<button className="icon-button" disabled={work.running||work.sending} aria-label={row.role==="user"?"编辑并从这里继续":"从这里继续"} onClick={()=>work.startPath(row.role==="user"?"editUser":"continueAssistant",row.id,row.role==="user"?row.parts.filter(part=>part.kind==="text").map(part=>part.text).join("\n"):"")}>{row.role==="user"?<Pencil size={13}/>:<GitBranch size={13}/>}</button>}
      {row.time && <time dateTime={row.time}>{new Date(row.time).toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit"})}</time>}
    </div>
  </article>;
  return (
    <div className="transcript-frame">
      {imagePreview && <ImagePreview src={imagePreview} onClose={()=>setImagePreview(null)}/>}
      {!work.presentationError && work.presentation?.adapterState !== "unavailable" && <ConversationRail turns={turns} activeId={navigation.activeId} onNavigate={id => {
        const leaveFollowing = work.running || !!(scroll.current && scroll.current.scrollHeight > scroll.current.clientHeight + 1);
        navigationPausedFollowing.current = leaveFollowing;
        atBottom.current = !leaveFollowing;
        setShowLatest(leaveFollowing);
        navigation.navigate(id);
      }}/>}
      <div
        className="transcript"
        ref={scroll}
        onWheel={() => { navigationPausedFollowing.current = false; }}
        onTouchMove={() => { navigationPausedFollowing.current = false; }}
        onPointerDown={event => { if (event.target === event.currentTarget) navigationPausedFollowing.current = false; }}
        onKeyDown={event => {
          if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(event.key)) navigationPausedFollowing.current = false;
        }}
        onScroll={() => {
          const el = scroll.current;
          if (!el) return;
          if (!navigationPausedFollowing.current)
            atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
          setShowLatest(!atBottom.current);
          const sessionId = work.session?.id;
          const offset = Math.round(el.scrollTop);
          if (sessionId && restored.current)
            work.saveReading(sessionId, offset);
        }}
      >
        <div className="reading-lane" ref={content}>
          {work.presentationError ||
          work.presentation?.adapterState === "unavailable" ? (
            <div role="alert" className="inline-error">
              消息暂时无法读取。
              <button onClick={() => void work.refreshPresentation()}>
                重试
              </button>
            </div>
          ) : work.session && !work.presentation ? (
            <LoadingPlaceholder label="正在读取消息…"/>
          ) : !rows.length ? (
            <div className="empty-conversation">
              {emptyBrand}
              <h1>{work.task ? "开始这项任务" : "开始新任务"}</h1>
              {work.task ? <p>{work.task.goal}</p> : <p>描述目标，D Code 会接手推进。</p>}
            </div>
          ) : (
            <div className="message-list">
              {executions.map(turn => <div className="conversation-turn" key={turn.id}>
                {turn.updateLabel&&<div className="collaboration-update-heading">{turn.updateLabel}</div>}
                {turn.user && renderMessage(turn.user)}
                <ExecutionProcess turn={turn}/>
                {turn.answer && renderMessage(turn.answer)}
              </div>)}
            </div>
          )}
          <AuxiliaryActivities work={work}/><CollaborationFeed work={work}/>
        </div>
      </div>
      {showLatest && (
        <button
          className="jump-latest icon-button"
          aria-label="回到最新消息"
          onClick={() => {
            navigationPausedFollowing.current = false;
            atBottom.current = true;
            setShowLatest(false);
            navigation.goToLatest();
          }}
        >
          <ArrowDown size={15} />
        </button>
      )}
    </div>
  );
}
