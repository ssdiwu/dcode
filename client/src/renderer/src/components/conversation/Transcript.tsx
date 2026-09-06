import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDown, Copy, CornerDownLeft } from "lucide-react";
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

export function Transcript({ work, emptyBrand }: { work: Workbench; emptyBrand: ReactNode }) {
  const scroll = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const navigationPausedFollowing = useRef(false);
  const [showLatest, setShowLatest] = useState(false);
  const [imagePreview,setImagePreview] = useState<string|null>(null);
  const storedRows = useMemo(
    () => [
      ...messageRows(
        work.imported.map((e) => ({
          id: e.id,
          type: "message",
          timestamp: e.sourceTimestamp ?? e.createdAt,
          message: { role: e.messageRole, content: e.content },
        })),
      ),
      ...messageRows(work.presentation?.inspection?.entries ?? []),
    ],
    [work.presentation, work.imported],
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
  const executions = useMemo(() => executionTurns(rows, work.stream, work.running), [rows, work.stream, work.running]);
  const turns = useMemo(() => conversationTurns(rows, ""), [rows]);
  const navigation = useConversationNavigation(turns, scroll, content);
  const rowSignature = `${rows.map(row=>row.parts.map(part=>part.text.length).join(",")).join(":")}:${work.stream.tools?.map(tool=>tool.output.length).join(",")}`;
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
  const renderMessage = (row: MessageRow) => <article className={`message ${row.role}`} key={row.id} data-conversation-turn={row.role === "user" ? row.id : undefined} aria-label={row.role === "user" ? "你的消息" : "D Code 回答"}>
    {row.parts.filter(part=>part.kind === "text" || part.kind === "image" || part.kind === "file").map((part,index)=>{
      if(part.kind === "file" && part.attachment)return <button key={index} className="message-file" aria-label={`预览 ${part.attachment.name}`} onClick={()=>void work.previewAttachment(part.attachment!.id)}><span className="file-type">{fileType(part.attachment.name)}</span><span>{part.attachment.name}</span>{Date.parse(part.attachment.expiresAt)<=Date.now()&&<small>已过期</small>}</button>;
      if(part.kind === "image")return <button key={index} className="message-image-button" aria-label={`放大预览 ${part.attachment?.name??"消息图片"}`} onClick={()=>part.attachment?void work.previewAttachment(part.attachment.id):setImagePreview(`data:${part.mimeType};base64,${part.text}`)}><img className="message-image" alt={part.attachment?.name??"消息图片"} src={`data:${part.mimeType};base64,${part.text}`}/></button>;
      return row.role === "assistant" ? <Markdown key={index} text={part.text}/> : <div className="user-text" key={index}>{part.text}</div>;
    })}

    <div className="message-actions">
      <button className="icon-button" aria-label="复制消息" onClick={()=>void navigator.clipboard.writeText(row.parts.filter(part=>part.kind === "text").map(part=>part.text).join("\n")).catch(work.fail)}><Copy size={13}/></button>
      <button className="icon-button" aria-label="引用到输入框" onClick={()=>quote(row.parts.filter(part=>part.kind === "text").map(part=>part.text).join("\n"))}><CornerDownLeft size={13}/></button>
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
            <p className="loading">正在读取消息…</p>
          ) : !rows.length ? (
            <div className="empty-conversation">
              {emptyBrand}
              <h1>{work.task ? "开始这项任务" : "想完成什么？"}</h1>
              {work.task && <p>{work.task.goal}</p>}
            </div>
          ) : (
            <div className="message-list">
              {executions.map(turn => <div className="conversation-turn" key={turn.id}>
                {turn.user && renderMessage(turn.user)}
                <ExecutionProcess turn={turn}/>
                {turn.answer && renderMessage(turn.answer)}
              </div>)}
            </div>
          )}
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
