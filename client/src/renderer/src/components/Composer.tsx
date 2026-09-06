import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUp, Square, Plus, ImagePlus, FileText, X } from "lucide-react";
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
    !reading &&
    !work.running &&
    !work.hostDead &&
    !work.closing;
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing &&
      event.nativeEvent.keyCode !== 229
    ) {
      event.preventDefault();
      if (canSend) void work.send();
    }
  };
  return (
    <div className="composer-wrap">
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
        <textarea
          ref={textarea}
          aria-label="任务消息"
          readOnly={work.closing}
          data-composer
          value={draft.text}
          onChange={(e) =>
            updateDraft(draftKey, { ...draft, text: e.target.value })
          }
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
          <span className="spacer" />
          <ModelPicker models={models.data?.models??[]} value={models.data?.selectedKey??null} onChange={models.choose} onManage={onSettings} onRefresh={()=>models.refresh()} refreshing={models.refreshing} busy={models.busy}/>
          {(models.data?.thinkingLevels.length??0)>1 && <SelectMenu ariaLabel="选择思考强度" value={models.data?.thinking??null} placeholder="思考强度" options={(models.data?.thinkingLevels??[]).map(level=>({value:level,label:`思考 · ${thinkingLabels[level]??level}`}))} onChange={level=>void models.setThinking(level)}/>}
          {work.running ? (
            <button
              className="send-button stopping"
              aria-label="停止"
              onClick={() => void work.stop()}
            >
              <Square size={13} fill="currentColor" />
            </button>
          ) : (
            <button
              className="send-button"
              aria-label="发送"
              onClick={() => void work.send()}
              disabled={!canSend}
            >
              <ArrowUp size={17} />
            </button>
          )}
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
              ? "正在执行，停止后可继续补充。"
              : !models.data?.selectedKey
                ? "选择模型后即可发送。"
                : draft.images.length && !draft.text.trim() && !draft.attachments?.length
                  ? "添加一句说明后即可发送。"
                  : draft.attachments?.length ? "附件已暂存，未发送时保留 1 天；发送后保留 30 天。" : ""}
      </div>
    </div>
  );
}
