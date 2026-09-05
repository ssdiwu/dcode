import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowUp, Paperclip, Plus, Settings, X } from "lucide-react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { SelectMenu } from "./components/SelectMenu";
import { ImportPanel } from "./components/ImportPanel";
import { Markdown } from "./components/Markdown";
import logoUrl from "./assets/logo.png";
import {
  api,
  fetchSnapshot,
  taskProjectId,
  type DCodeSessionPresentation,
  type FoundationSnapshot,
  type GitBranchResult,
  type ProviderView,
  type SessionEntry,
  type TaskRecord,
} from "./types";

/**
 * 验收面一（完整版）：导航区 + 任务对话富消息流。
 * - 消息渲染 Pi 会话条目：文本 / 思考（折叠）/ 工具调用与结果（折叠）/
 *   模型与思考等级变更系统行。
 * - Composer：模型与思考等级选择（runtimeModelSelection / setThinking）、
 *   发送（dcodeSession.prompt）、运行中停止（session.abort）。
 * - 梗概浮卡活数字：运行计时、工作项 n/m、成员、等待占位。
 * - 稳定几何与两态合同不变。
 */

const WIDE_MIN = 1320;
const MEDIUM_MIN = 880;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

type HudMode = "wide" | "medium" | "compact";

function relTime(iso?: string): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "昨天";
  return `${days} 天前`;
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h} 小时 ${m} 分 ${s} 秒`
    : m > 0
      ? `${m} 分 ${s} 秒`
      : `${s} 秒`;
}

function useNowInterval(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function useWorkspaceWidth(): number {
  const [width, setWidth] = useState(() =>
    typeof window === "undefined" ? 1440 : window.innerWidth,
  );
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return width;
}

function useFoundation(): {
  snapshot: FoundationSnapshot | null;
  error: string | null;
  reload: () => void;
} {
  const [snapshot, setSnapshot] = useState<FoundationSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    fetchSnapshot()
      .then(value => {
        if (alive) {
          setSnapshot(value);
          setError(null);
        }
      })
      .catch((reason: unknown) => {
        if (alive) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      });
    const unsubscribe = api().subscribe(envelope => {
      const message = envelope as { event?: string };
      if (
        message.event === "foundation.changed" ||
        message.event === "session.event"
      ) {
        setNonce(n => n + 1);
      }
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [nonce]);
  return { snapshot, error, reload: () => setNonce(n => n + 1) };
}

interface RenderedBlock {
  kind: "text" | "thinking" | "toolCall" | "toolResult" | "system";
  role?: string;
  text: string;
}

function renderEntry(entry: SessionEntry): RenderedBlock[] | null {
  if (entry.type === "model_change") {
    const value = entry as unknown as { provider?: string; modelId?: string };
    return [
      {
        kind: "system",
        text: `模型切换至 ${value.provider ?? "?"} / ${value.modelId ?? "?"}`,
      },
    ];
  }
  if (entry.type === "thinking_level_change") {
    const value = entry as unknown as { thinkingLevel?: string };
    return [
      { kind: "system", text: `思考强度调整为 ${value.thinkingLevel ?? "?"}` },
    ];
  }
  if (entry.type !== "message" || !entry.message) return null;
  const role = String(entry.message.role ?? "");
  const content = entry.message.content;
  const blocks: RenderedBlock[] = [];
  const push = (kind: RenderedBlock["kind"], text: string) => {
    if (text.trim().length > 0) blocks.push({ kind, role, text });
  };
  if (typeof content === "string") {
    push(role === "assistant" ? "text" : "text", content);
  } else if (Array.isArray(content)) {
    for (const part of content) {
      const block = part as {
        type?: string;
        text?: string;
        thinking?: string;
        toolName?: string;
        name?: string;
        arguments?: unknown;
        input?: unknown;
        output?: unknown;
      };
      if (block.type === "text") push("text", block.text ?? "");
      else if (block.type === "thinking")
        push("thinking", block.thinking ?? "");
      else if (block.type === "toolCall") {
        const args =
          block.arguments ??
          block.input ??
          {};
        let summary = "";
        try {
          summary = JSON.stringify(args);
        } catch {
          summary = String(args);
        }
        push(
          "toolCall",
          `${block.toolName ?? block.name ?? "工具调用"} ${summary}`.trim(),
        );
      } else if (block.type === "toolResult" || block.type === "tool_result") {
        let output = "";
        if (typeof block.output === "string") output = block.output;
        else {
          try {
            output = JSON.stringify(block.output ?? block);
          } catch {
            output = String(block.output ?? "");
          }
        }
        push("toolResult", output);
      }
    }
  }
  if (blocks.length === 0 && role === "toolResult") {
    blocks.push({ kind: "toolResult", text: "（工具已执行，无输出内容）" });
  }
  return blocks.length > 0 ? blocks : null;
}

function CollapsibleRow({
  label,
  text,
  monospace,
  defaultOpen = false,
}: {
  label: string;
  text: string;
  monospace?: boolean;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="my-1.5 overflow-hidden rounded-lg border border-line bg-nav/60">
      <button
        onClick={() => setOpen(!open)}
        className="flex h-7 w-full items-center gap-1.5 px-2.5 text-left text-[11px] text-hint hover:bg-ink/5"
      >
        <span
          className={`inline-block transition-transform ${open ? "rotate-90" : ""}`}
        >
          ›
        </span>
        {label}
        <span className="ml-1 min-w-0 flex-1 truncate font-normal opacity-70">
          {text.split("\n")[0]}
        </span>
      </button>
      {open ? (
        <div
          className={`border-t border-line px-3 py-2 text-[11.5px] leading-5 text-muted ${
            monospace
              ? "overflow-x-auto whitespace-pre font-mono"
              : "whitespace-pre-wrap"
          }`}
        >
          {text}
        </div>
      ) : null}
    </div>
  );
}

function Conversation({
  presentation,
  streaming,
  pendingImages,
  onRemoveImage,
  onAddImageFiles,
  onInsertPath,
  onQuote,
  imageInputRef,
  pathInputRef,
  draft,
  onDraftChange,
  onSend,
  sending,
  running,
  onStop,
  modelOptions,
  currentModel,
  onModelChange,
  currentThinking,
  onThinkingChange,
}: {
  presentation: DCodeSessionPresentation | null;
  streaming: { active: boolean; thinking: string; text: string };
  pendingImages: { mimeType: string; data: string }[];
  onRemoveImage: (index: number) => void;
  onAddImageFiles: (files: File[]) => void;
  onQuote: (text: string) => void;
  onInsertPath: (path: string) => void;
  imageInputRef: React.RefObject<HTMLInputElement | null>;
  pathInputRef: React.RefObject<HTMLInputElement | null>;
  draft: string;
  onDraftChange: (text: string) => void;
  onSend: () => void;
  sending: boolean;
  running: boolean;
  onStop: () => void;
  modelOptions: { providerId: string; modelId: string; name: string }[];
  currentModel: string | null;
  onModelChange: (providerId: string, modelId: string) => void;
  currentThinking: string | null;
  onThinkingChange: (level: string) => void;
}) {
  const entries = presentation?.inspection?.entries ?? [];
  const rendered = entries
    .map(renderEntry)
    .filter((value): value is RenderedBlock[] => value !== null)
    .flat();

  const canSend =
    presentation !== null && draft.trim().length > 0 && !sending && !running;

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {rendered.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <div className="max-w-[460px] text-center">
              <h2 className="text-[19px] font-semibold">想完成什么？</h2>
              <p className="mt-2 text-[12.5px] leading-5 text-muted">
                发送第一条消息后开始任务；标题可稍后调整。
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-4 pb-4">
            {rendered.map((block, index) => {
              if (block.kind === "system") {
                return (
                  <div
                    key={index}
                    className="text-center text-[10.5px] text-hint"
                  >
                    — {block.text} —
                  </div>
                );
              }
              if (block.kind === "thinking") {
                return (
                  <CollapsibleRow
                    key={index}
                    label="思考"
                    text={block.text}
                  />
                );
              }
              if (block.kind === "toolCall") {
                return (
                  <CollapsibleRow
                    key={index}
                    label="工具调用"
                    text={block.text}
                    monospace
                  />
                );
              }
              if (block.kind === "toolResult") {
                return (
                  <CollapsibleRow
                    key={index}
                    label="工具输出"
                    text={block.text}
                    monospace
                  />
                );
              }
              return (
                <div key={index} className="group/msg text-[13px] leading-6">
                  <div className="mb-0.5 flex items-center gap-2">
                    <span className="text-[11px] font-semibold text-hint">
                      {block.role === "assistant" ? "D Code" : "507"}
                    </span>
                    <span className="hidden gap-1 group-hover/msg:flex">
                      <button
                        aria-label="复制"
                        className="text-[10px] text-hint hover:text-accent"
                        onClick={() => {
                          void navigator.clipboard.writeText(block.text);
                        }}
                      >
                        复制
                      </button>
                      {block.role === "user" ? (
                        <button
                          aria-label="引用到输入框"
                          className="text-[10px] text-hint hover:text-accent"
                          onClick={() => onQuote(block.text)}
                        >
                          引用
                        </button>
                      ) : null}
                    </span>
                    {block.time ? (
                      <span className="ml-auto text-[10px] text-hint opacity-0 transition-opacity group-hover/msg:opacity-100">
                        {block.time}
                      </span>
                    ) : null}
                  </div>
                  {block.role === "assistant" ? (
                    <Markdown text={block.text} />
                  ) : (
                    <div className="whitespace-pre-wrap">{block.text}</div>
                  )}
                </div>
              );
            })}
            {streaming.active && streaming.thinking ? (
              <CollapsibleRow
                label="思考中…"
                text={streaming.thinking}
              />
            ) : null}
            {streaming.active && streaming.text ? (
              <div className="text-[13px] leading-6">
                <div className="mb-0.5 text-[11px] font-semibold text-hint">
                  D Code
                </div>
                <div className="whitespace-pre-wrap">
                  {streaming.text}
                  <span className="animate-pulse">▍</span>
                </div>
              </div>
            ) : null}
          </div>
        )}
      </div>
      <div className="pt-4">
        {running ? (
          <p className="pb-1.5 text-[11px] text-warn">
            任务正在运行，可随时停止。
          </p>
        ) : null}
        <div className="rounded-xl border border-line bg-raised p-3 shadow-sm">
          {pendingImages.length > 0 ? (
            <div className="mb-2 flex flex-wrap gap-2">
              {pendingImages.map((image, index) => (
                <div key={index} className="relative">
                  <img
                    src={`data:${image.mimeType};base64,${image.data}`}
                    alt={`附件 ${index + 1}`}
                    className="h-12 w-12 rounded-md border border-line object-cover"
                  />
                  <button
                    aria-label="移除图片"
                    onClick={() => onRemoveImage(index)}
                    className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-ink/70 text-[9px] text-canvas"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          <textarea
            value={draft}
            onPaste={event => {
              const files = Array.from(event.clipboardData.files).filter(file =>
                file.type.startsWith("image/"),
              );
              if (files.length > 0) {
                event.preventDefault();
                onAddImageFiles(files);
              }
            }}
            onChange={event => onDraftChange(event.target.value)}
            onKeyDown={event => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                onSend();
              }
            }}
            placeholder={
              presentation ? "继续说明你的判断…" : "选择任务后开始对话…"
            }
            rows={2}
            className="w-full resize-none bg-transparent text-[12.5px] leading-5 outline-none placeholder:text-hint"
          />
          <div className="flex items-center gap-1 pt-1">
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button
                  aria-label="添加附件"
                  className="flex h-6 w-6 items-center justify-center rounded-md text-hint hover:bg-ink/5"
                >
                  <Paperclip size={13} />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  side="top"
                  align="start"
                  className="z-50 min-w-[180px] rounded-lg border border-line bg-raised p-1 shadow-xl"
                >
                  <DropdownMenu.Item
                    onSelect={() => imageInputRef.current?.click()}
                    className="flex h-7 cursor-pointer items-center rounded-md px-2 text-[12px] outline-none data-[highlighted]:bg-accent-fill"
                  >
                    图片…
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    onSelect={() => pathInputRef.current?.click()}
                    className="flex h-7 cursor-pointer items-center rounded-md px-2 text-[12px] outline-none data-[highlighted]:bg-accent-fill"
                  >
                    文件路径引用…
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
            <input
              ref={imageInputRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={event => {
                const files = Array.from(event.target.files ?? []);
                if (files.length > 0) onAddImageFiles(files);
                event.target.value = "";
              }}
            />
            <input
              ref={pathInputRef}
              type="file"
              multiple
              hidden
              onChange={event => {
                for (const file of Array.from(event.target.files ?? [])) {
                  onInsertPath(api().getPathForFile(file));
                }
                event.target.value = "";
              }}
            />
            <SelectMenu
              ariaLabel="选择模型"
              accent
              placeholder="模型（未选择）"
              value={currentModel}
              options={modelOptions.map(option => ({
                value: option.providerId + "::" + option.modelId,
                label: option.name,
              }))}
              onChange={value => {
                const [providerId, modelId] = value.split("::");
                if (providerId && modelId) onModelChange(providerId, modelId);
              }}
            />
            <SelectMenu
              ariaLabel="选择思考强度"
              placeholder="思考"
              value={currentThinking ?? "medium"}
              options={THINKING_LEVELS.map(level => ({
                value: level,
                label: `思考 · ${level}`,
              }))}
              onChange={onThinkingChange}
            />
            <span className="flex-1" />
            {running ? (
              <button
                onClick={onStop}
                className="flex h-7 w-7 items-center justify-center rounded-md bg-warn text-white"
                aria-label="停止"
              >
                <span className="inline-block h-2.5 w-2.5 rounded-[2px] bg-white" />
              </button>
            ) : (
              <button
                onClick={onSend}
                disabled={!canSend}
                aria-label="发送"
                className="flex h-7 w-7 items-center justify-center rounded-md bg-accent text-white disabled:opacity-40"
              >
                <ArrowUp size={14} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function sendHint(running: boolean): string | null {
  return running ? "任务正在运行，可随时停止。" : null;
}
void sendHint;

function NavRow({
  label,
  meta,
  active,
  icon,
  onClick,
}: {
  label: string;
  meta?: string;
  active?: boolean;
  icon?: React.ReactNode;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex h-7 w-full items-center gap-2 truncate rounded-md px-2 text-left text-[12px] leading-none ${
        active
          ? "bg-accent-fill font-medium text-accent"
          : "text-ink/80 hover:bg-ink/5"
      }`}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {meta ? <span className="shrink-0 text-hint">{meta}</span> : null}
    </button>
  );
}

function TaskNavGroup({
  task,
  selected,
  childSessions,
  onSelect,
}: {
  task: TaskRecord;
  selected: boolean;
  childSessions: { id: string; title?: string; state: string }[];
  onSelect: () => void;
}) {
  return (
    <div>
      <NavRow label={task.title} active={selected} onClick={onSelect} />
      {selected && childSessions.length > 0 ? (
        <div className="ml-3 border-l border-line pl-1.5">
          {childSessions.map(session => (
            <div
              key={session.id}
              className="flex h-7 items-center gap-2 rounded-md px-2 text-[11.5px] text-muted"
            >
              <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-violet" />
              <span className="min-w-0 flex-1 truncate">
                {session.title || "子会话"}
              </span>
              <span className="shrink-0 text-[10px] text-hint">
                {session.state === "active"
                  ? "进行中"
                  : session.state === "waiting"
                    ? "等待"
                    : session.state === "completed"
                      ? "已完成"
                      : ""}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function HudSection({
  title,
  children,
  expanded,
  onToggle,
}: {
  title: string;
  children: React.ReactNode;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="border-b border-line px-3 py-1.5 last:border-b-0">
      <button
        onClick={onToggle}
        className="flex h-5 w-full items-center gap-1.5 rounded px-1 text-left text-[10.5px] font-semibold tracking-wide text-hint hover:bg-ink/5"
      >
        <span
          className={`inline-block transition-transform ${expanded ? "rotate-90" : ""}`}
        >
          ›
        </span>
        {title}
      </button>
      {expanded ? <div className="pt-1">{children}</div> : null}
    </div>
  );
}

function HudCard({
  snapshot,
  task,
  messageCount,
  runElapsed,
  runActive,
  onOpenDetail,
  onClose,
  floating,
}: {
  snapshot: FoundationSnapshot;
  task: TaskRecord | null;
  messageCount: number;
  runElapsed: string | null;
  runActive: boolean;
  onOpenDetail: () => void;
  onClose: () => void;
  floating: boolean;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    progress: true,
    team: true,
    waiting: false,
    deliverables: false,
  });
  const toggle = (id: string) =>
    setExpanded(prev => ({ ...prev, [id]: !prev[id] }));

  const items = task
    ? snapshot.taskWorkItems.filter(item => item.taskId === task.id)
    : [];
  const done = items.filter(item => item.state === "completed").length;
  const inProgress = items.filter(item => item.state === "in_progress").length;
  const blocked = items.filter(item => item.state === "blocked").length;
  const members = task
    ? snapshot.coordinatorAssignments.filter(a => a.taskId === task.id)
    : [];
  const memberName = (profileId: string) =>
    snapshot.agentProfiles.find(profile => profile.id === profileId)?.name ??
    "成员";

  return (
    <motion.aside
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      aria-label="任务梗概"
      className={`flex max-h-[620px] flex-col overflow-y-auto rounded-xl border border-line bg-raised shadow-lg ${
        floating
          ? "absolute right-6 top-[66px] w-[304px]"
          : "w-[304px] shrink-0"
      }`}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="text-[11px] font-semibold text-hint">任务梗概</span>
        <span className="ml-auto flex items-center gap-1">
          <button
            onClick={onOpenDetail}
            className="rounded px-1.5 py-0.5 text-[10.5px] text-accent hover:bg-ink/5"
          >
            详情
          </button>
          {!floating ? (
            <button
              onClick={onClose}
              aria-label="收起梗概"
              className="rounded px-1.5 py-0.5 text-[10.5px] text-hint hover:bg-ink/5"
            >
              ✕
            </button>
          ) : null}
        </span>
      </div>
      <HudSection
        title="进度"
        expanded={expanded["progress"] ?? true}
        onToggle={() => toggle("progress")}
      >
        {task ? (
          <div className="space-y-1 px-1 pb-1 text-[11.5px] leading-5">
            <div className="font-medium">{task.title}</div>
            <div className="text-muted">{task.goal}</div>
            <div className="text-hint">
              {runActive && runElapsed ? `运行中 · ${runElapsed} · ` : ""}
              消息 {messageCount} · 工作项 完成 {done} / 进行 {inProgress}
              {blocked > 0 ? ` / 阻塞 ${blocked}` : ""}
              {items.length === 0 ? " · 暂无工作项" : ""}
            </div>
            {items.length > 0 ? (
              <ul className="mt-1 space-y-0.5">
                {items.map(item => (
                  <li
                    key={item.id}
                    className="flex items-center gap-1.5 text-[11px] text-muted"
                  >
                    <span className="w-3 shrink-0 text-center">
                      {item.state === "completed"
                        ? "☑"
                        : item.state === "in_progress"
                          ? "◐"
                          : item.state === "blocked"
                            ? "⚠"
                            : "○"}
                    </span>
                    <span
                      className={`min-w-0 truncate ${
                        item.state === "completed" ? "line-through opacity-60" : ""
                      }`}
                    >
                      {item.title}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : (
          <p className="px-1 pb-1 text-[11.5px] text-muted">尚未选择任务。</p>
        )}
      </HudSection>
      <HudSection
        title="Agent Team"
        expanded={expanded["team"] ?? true}
        onToggle={() => toggle("team")}
      >
        {members.length > 0 ? (
          <ul className="space-y-1 px-1 pb-1 text-[11.5px]">
            {members.map(member => (
              <li key={member.id} className="flex items-center gap-2">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-violet" />
                <span className="truncate">{memberName(member.profileId)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-1 pb-1 text-[11.5px] text-muted">
            {task ? "当前任务没有运行中的成员。" : "尚未选择任务。"}
          </p>
        )}
      </HudSection>
      <HudSection
        title="等待你处理"
        expanded={expanded["waiting"] ?? false}
        onToggle={() => toggle("waiting")}
      >
        <p className="px-1 pb-1 text-[11.5px] text-muted">当前没有等待事项。</p>
      </HudSection>
      <HudSection
        title="交付物"
        expanded={expanded["deliverables"] ?? false}
        onToggle={() => toggle("deliverables")}
      >
        <p className="px-1 pb-1 text-[11.5px] text-muted">暂无交付物。</p>
      </HudSection>
    </motion.aside>
  );
}

const FIXTURE_ENTRIES: SessionEntry[] = [
  {
    id: "f1",
    type: "message",
    message: {
      role: "user",
      content: [{ type: "text", text: "把视觉摘要的默认关系收口一下，先说结论。" }],
    },
  } as unknown as SessionEntry,
  {
    id: "f2",
    type: "message",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "先看现有摘要管线的分组逻辑，确认默认关系写在哪里。" },
        { type: "text", text: "结论：默认关系应由「视觉方向」决定分组，摘要只做引用。\n\n我先读一遍现有实现确认。" },
        { type: "toolCall", toolName: "read", arguments: { path: "Sources/SummaryCardView.swift" } },
      ],
    },
  } as unknown as SessionEntry,
  {
    id: "f3",
    type: "message",
    message: {
      role: "toolResult",
      content: [
        { type: "toolResult", toolName: "read", output: "struct SummaryCardView: View {\n  // 42 行\n}" },
      ],
    },
  } as unknown as SessionEntry,
  {
    id: "f4",
    type: "message",
    message: {
      role: "assistant",
      content: [
          {
            type: "text",
            text: "已确认：分组逻辑集中在 SummaryCardView。建议直接把默认关系常量收敛到一个文件。\n\n## 收口方案\n\n1. 常量收敛到 `DefaultRelations.swift`\n2. 摘要卡片只读引用\n\n| 方案 | 影响 |\n|---|---|\n| 常量收敛 | 低 |\n| 重写分组 | 高 |\n\n```swift\nenum DefaultRelation {\n    static let group = \"visual\"\n}\n```\n\n```mermaid\nflowchart LR\n  A[视觉方向] --> B[摘要卡片]\n```\n",
          },
        ],
    },
  } as unknown as SessionEntry,
];

function SettingsView({
  snapshot,
  providers,
  currentModel,
  onModelChange,
}: {
  snapshot: FoundationSnapshot | null;
  providers: ProviderView[];
  currentModel: string | null;
  onModelChange: (providerId: string, modelId: string) => void;
}) {
  const catalog = snapshot?.modelCatalogEntries ?? [];
  const selection = snapshot?.runtimeModelSelection ?? null;
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-[min(760px,100%)] py-8">
        <h1 className="text-[19px] font-semibold">设置</h1>
        <p className="mt-1 text-[12px] leading-5 text-muted">
          凭据正文永不进入 D Code 画面；供应商认证状态由 Host 只读投影。
        </p>

        <h2 className="mt-8 text-[13px] font-semibold">模型</h2>
        <p className="mt-1 text-[11.5px] text-muted">
          点击「设为当前」切换任务对话使用的模型；已认证供应商下的模型才可被选择。
        </p>
        <div className="mt-3 overflow-hidden rounded-xl border border-line">
          {catalog.length === 0 ? (
            <p className="px-4 py-3 text-[12px] text-muted">
              模型目录为空：先在核心侧完成 Provider 认证与目录发现。
            </p>
          ) : (
            catalog.map(entry => {
              const isCurrent =
                selection?.providerId === entry.providerId &&
                selection?.modelId === entry.modelId;
              const authed =
                providers.find(provider => provider.id === entry.providerId)
                  ?.authConfigured ?? false;
              return (
                <div
                  key={entry.id}
                  className="flex h-11 items-center gap-3 border-b border-line px-4 last:border-b-0"
                >
                  <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">
                    {entry.name}
                  </span>
                  <span className="text-[11px] text-hint">
                    {entry.providerId}
                  </span>
                  {entry.reasoning ? (
                    <span className="rounded bg-violet/15 px-1.5 py-0.5 text-[10px] text-violet">
                      推理
                    </span>
                  ) : null}
                  {authed ? null : (
                    <span className="text-[10px] text-warn">未认证</span>
                  )}
                  {isCurrent ? (
                    <span className="rounded bg-accent-fill px-1.5 py-0.5 text-[10.5px] text-accent">
                      当前
                    </span>
                  ) : (
                    <button
                      onClick={() =>
                        onModelChange(entry.providerId, entry.modelId)
                      }
                      className="rounded border border-line px-1.5 py-0.5 text-[10.5px] text-muted hover:bg-ink/5"
                    >
                      设为当前
                    </button>
                  )}
                </div>
              );
            })
          )}
        </div>

        <h2 className="mt-8 text-[13px] font-semibold">智能体供应商</h2>
        <div className="mt-3 overflow-hidden rounded-xl border border-line">
          {providers.length === 0 ? (
            <p className="px-4 py-3 text-[12px] text-muted">暂无已注册供应商。</p>
          ) : (
            providers.map(provider => (
              <div
                key={provider.id}
                className="flex h-11 items-center gap-3 border-b border-line px-4 last:border-b-0"
              >
                <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">
                  {provider.name ?? provider.id}
                </span>
                <span className="text-[11px] text-hint">
                  模型 {provider.models.length}
                </span>
                <span
                  className={`rounded px-1.5 py-0.5 text-[10.5px] ${
                    provider.authConfigured
                      ? "bg-violet/15 text-violet"
                      : "text-hint"
                  }`}
                >
                  {provider.authConfigured ? "已认证" : "未配置"}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

export function App() {
  const { snapshot, error, reload } = useFoundation();
  const [searchParams] = useState(
    () => new URLSearchParams(window.location.search),
  );
  const fixtures = searchParams.get("fixtures") === "1";
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [view, setView] = useState<"task" | "settings">(() =>
    new URLSearchParams(window.location.search).get("view") === "settings"
      ? "settings"
      : "task",
  );
  const [importOpen, setImportOpen] = useState(
    () => new URLSearchParams(window.location.search).get("import") === "1",
  );
  const [searchOpen, setSearchOpen] = useState(
    () => new URLSearchParams(window.location.search).get("search") === "1",
  );
  const [searchQuery, setSearchQuery] = useState(
    () => new URLSearchParams(window.location.search).get("q") ?? "",
  );
  const [searchResults, setSearchResults] = useState<
    {
      sessionId: string;
      title: string;
      snippet: string;
      matchKind: string;
      role?: string;
    }[]
  >([]);
  const [searching, setSearching] = useState(false);
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [branchByProject, setBranchByProject] = useState<
    Record<string, string | null>
  >({});
  const [detailOpen, setDetailOpen] = useState(
    () => new URLSearchParams(window.location.search).get("detail") === "1",
  );
  const [hudOpen, setHudOpen] = useState(
    () => new URLSearchParams(window.location.search).get("hud") === "1",
  );
  const [presentation, setPresentation] =
    useState<DCodeSessionPresentation | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [pendingImages, setPendingImages] = useState<
    { mimeType: string; data: string }[]
  >([]);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const pathInputRef = useRef<HTMLInputElement | null>(null);
  const width = useWorkspaceWidth();
  const hudMode: HudMode =
    width >= WIDE_MIN ? "wide" : width >= MEDIUM_MIN ? "medium" : "compact";
  const hudVisible =
    view === "task" &&
    !detailOpen &&
    (hudMode === "wide" || (hudMode !== "compact" && hudOpen));

  const tasks = snapshot?.tasks ?? [];
  const selectedTask =
    tasks.find(task => task.id === selectedTaskId) ?? tasks[0] ?? null;
  const coordinationSession = useMemo(() => {
    if (!snapshot || !selectedTask) return null;
    return (
      snapshot.sessions.find(
        session =>
          session.taskId === selectedTask.id &&
          session.kind === "coordination",
      ) ?? null
    );
  }, [snapshot, selectedTask]);
  const sessionRun = useMemo(() => {
    if (!snapshot || !coordinationSession) return null;
    const runs = snapshot.sessionRuns.filter(
      run => run.sessionId === coordinationSession.id,
    );
    return runs.length > 0 ? runs[runs.length - 1] : null;
  }, [snapshot, coordinationSession]);
  const runActive =
    sessionRun !== null &&
    sessionRun.status === "running" &&
    sessionRun.startedAt !== undefined;
  const now = useNowInterval(runActive);
  const runElapsed = sessionRun?.startedAt
    ? formatElapsed(now - new Date(sessionRun.startedAt).getTime())
    : null;

  const [streaming, setStreaming] = useState({
    active: false,
    thinking: "",
    text: "",
  });
  const lastDeltaRef = useRef(Date.now());

  const refreshPresentation = useCallback(
    (sessionId: string) => {
      api()
        .request("dcodeSession.presentation", { dcodeSessionId: sessionId })
        .then(value => setPresentation(value as DCodeSessionPresentation))
        .catch(() => undefined);
    },
    [],
  );

  useEffect(() => {
    if (fixtures) {
      setPresentation(null);
      return;
    }
    if (!coordinationSession) {
      setPresentation(null);
      return;
    }
    refreshPresentation(coordinationSession.id);
  }, [coordinationSession?.id, fixtures, refreshPresentation]);

  // 流式管道（议题：直播而非快照）：增量事件实时累积，节流回读落库条目。
  const adapterSessionId = presentation?.binding?.adapterSessionId ?? null;
  useEffect(() => {
    if (!adapterSessionId || fixtures) return;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefresh = () => {
      if (refreshTimer) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        refreshPresentation(coordinationSession?.id ?? "");
      }, 800);
    };
    const unsubscribe = api().subscribe(envelope => {
      const message = envelope as { event?: string; data?: unknown };
      if (message.event !== "session.event") return;
      const data = message.data as {
        sessionId?: string;
        type?: string;
        delta?: string;
        toolName?: string;
      };
      if (data?.sessionId !== adapterSessionId) return;
      switch (data.type) {
        case "thinking_delta":
          lastDeltaRef.current = Date.now();
          setStreaming(prev => ({
            ...prev,
            active: true,
            thinking: prev.thinking + (data.delta ?? ""),
          }));
          break;
        case "text_delta":
          lastDeltaRef.current = Date.now();
          setStreaming(prev => ({
            ...prev,
            active: true,
            thinking: "",
            text: prev.text + (data.delta ?? ""),
          }));
          break;
        case "message_end":
          scheduleRefresh();
          setStreaming(prev => ({ ...prev, thinking: "", text: "" }));
          break;
        case "tool_execution_start":
          scheduleRefresh();
          break;
        case "tool_execution_end":
          scheduleRefresh();
          break;
        default:
          break;
      }
    });
    return unsubscribe;
  }, [adapterSessionId, fixtures, coordinationSession?.id, refreshPresentation]);

  // 流式停滞（2 秒无增量）且已不活跃 → 清空直播缓冲并回读一次。
  useEffect(() => {
    if (!streaming.active) return;
    const timer = setInterval(() => {
      if (Date.now() - lastDeltaRef.current > 2_000) {
        setStreaming({ active: false, thinking: "", text: "" });
        if (coordinationSession) refreshPresentation(coordinationSession.id);
      }
    }, 1_000);
    return () => clearInterval(timer);
  }, [streaming.active, coordinationSession, refreshPresentation]);

  // 只出现已认证（authConfigured）供应商下的模型；当前选择始终保留。
  const modelOptions = (snapshot?.modelCatalogEntries ?? []).filter(entry => {
    if (
      snapshot?.runtimeModelSelection &&
      snapshot.runtimeModelSelection.providerId === entry.providerId &&
      snapshot.runtimeModelSelection.modelId === entry.modelId
    ) {
      return true;
    }
    return (
      (providers.find(provider => provider.id === entry.providerId)
        ?.authConfigured ?? false) === true
    );
  }).map(entry => ({
    providerId: entry.providerId,
    modelId: entry.modelId,
    name: entry.name,
  }));
  const currentModel = snapshot?.runtimeModelSelection
    ? `${snapshot.runtimeModelSelection.providerId}::${snapshot.runtimeModelSelection.modelId}`
    : null;
  const currentThinking = presentation?.inspection?.context.thinkingLevel ?? null;

  const changeModel = async (providerId: string, modelId: string) => {
    if (!snapshot) return;
    try {
      await api().request("runtimeModelSelection.set", {
        requestId: `web-model-${Date.now()}`,
        expectedStoreRevision: snapshot.storeRevision,
        providerId,
        modelId,
      });
      reload();
    } catch (reason) {
      setSendError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const changeThinking = async (level: string) => {
    try {
      await api().request("session.setThinking", { level });
    } catch (reason) {
      setSendError(
        `思考强度尚未生效（需要运行中的会话）：${reason instanceof Error ? reason.message : String(reason)}`,
      );
    }
  };

  const stop = async () => {
    try {
      await api().request("session.abort", {});
      reload();
    } catch (reason) {
      setSendError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const send = async () => {
    const text = draft.trim();
    if (!coordinationSession || text.length === 0 || sending) return;
    setSending(true);
    setSendError(null);
    try {
      await api().request("dcodeSession.prompt", {
        dcodeSessionId: coordinationSession.id,
        message: text,
        promptId: `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        ...(pendingImages.length > 0 ? { images: pendingImages } : {}),
      });
      setDraft("");
      setPendingImages([]);
      reload();
    } catch (reason) {
      setSendError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSending(false);
    }
  };

  const addImageFiles = (files: File[]) => {
    for (const file of files.slice(0, 8 - pendingImages.length)) {
      if (!file.type.startsWith("image/")) continue;
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result ?? "");
        const base64 = dataUrl.split(",")[1] ?? "";
        if (base64.length > 7_000_000) {
          setSendError("图片过大（base64 上限 7,000,000 字符）");
          return;
        }
        setPendingImages(prev =>
          prev.length >= 8
            ? prev
            : [...prev, { mimeType: file.type, data: base64 }],
        );
      };
      reader.readAsDataURL(file);
    }
  };

  const insertPath = (path: string) => {
    setDraft(
      prev => `${prev}${prev.length > 0 && !prev.endsWith("\n") ? "\n" : ""}${path}`,
    );
  };

  const quoteToComposer = (text: string) => {
    setDraft(
      prev =>
        `${prev}${prev.length > 0 && !prev.endsWith("\n") ? "\n" : ""}> ${text}\n`,
    );
  };

  const [hostDead, setHostDead] = useState(false);
  const prevRunActiveRef = useRef(false);
  useEffect(() => {
    const unsubscribe = api().subscribe(envelope => {
      const message = envelope as { event?: string };
      if (message.event === "host.exit") setHostDead(true);
      if (message.event === "shell.focusComposer") {
        document.querySelector("textarea")?.focus();
      }
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!hostDead) return;
    setStreaming({ active: false, thinking: "", text: "" });
  }, [hostDead]);

  const restartHost = async () => {
    await api().restartHost();
    setHostDead(false);
    reload();
  };

  const messageCount =
    fixtures
      ? FIXTURE_ENTRIES.length
      : (presentation?.inspection?.context.messageCount ?? 0);

  const selectedProject = selectedTask
    ? (snapshot?.projects.find(
        project => project.id === taskProjectId(selectedTask),
      ) ?? null)
    : null;

  useEffect(() => {
    const unsubscribe = api().subscribe(envelope => {
      const message = envelope as { event?: string };
      if (message.event === "shell.focusSearch") setSearchOpen(true);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!searchOpen) return;
    const query = searchQuery.trim();
    if (query.length === 0) {
      setSearchResults([]);
      return;
    }
    setSearching(true);
    const timer = setTimeout(() => {
      let alive = true;
      api()
        .request("session.search", {
          query,
          requestToken: `web-k-${Date.now()}`,
          limit: 20,
        })
        .then(value => {
          if (!alive) return;
          const result = value as { results?: Record<string, unknown>[] };
          setSearchResults(
            (result.results ?? []).map(item => ({
              sessionId: String(item.sessionId ?? ""),
              title: String(item.title ?? item.sessionId ?? ""),
              snippet: String(
                (item as { snippet?: string }).snippet ?? "",
              ).slice(0, 160),
              matchKind: String((item as { matchKind?: string }).matchKind ?? ""),
              role: typeof (item as { role?: string }).role === "string" ? (item as { role?: string }).role : undefined,
            })),
          );
          setSearching(false);
        })
        .catch(() => {
          if (alive) setSearching(false);
        });
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [searchOpen, searchQuery]);

  useEffect(() => {
    let alive = true;
    api()
      .request("modelProviders.list")
      .then(value => {
        if (alive) {
          setProviders(
            (value as { providers?: ProviderView[] }).providers ?? [],
          );
        }
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [snapshot?.storeRevision]);
  useEffect(() => {
    const projectId = selectedProject?.id;
    if (!projectId || branchByProject[projectId] !== undefined) return;
    let alive = true;
    api()
      .request("project.gitBranch", { projectId })
      .then(value => {
        if (alive) {
          const result = value as GitBranchResult;
          setBranchByProject(prev => ({
            ...prev,
            [projectId]: result.branch,
          }));
        }
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [selectedProject?.id, branchByProject]);
  const conversationPresentation = fixtures
    ? ({
        dcodeSession: coordinationSession ?? {
          id: "fixture",
          taskId: "fixture",
          kind: "coordination",
          title: "样式样例",
          state: "idle",
          updatedAt: "",
        },
        adapterState: "ready",
        runtime: null,
        binding: null,
        inspection: { leafId: null, entries: FIXTURE_ENTRIES, context: { messageCount: FIXTURE_ENTRIES.length, model: null, thinkingLevel: "medium" } },
      } as DCodeSessionPresentation)
    : presentation;
  const runElapsedForHud = fixtures ? "1 分 24 秒" : runElapsed;
  const runActiveForHud = fixtures ? true : runActive;

  useEffect(() => {
    const active = runActiveForHud || streaming.active;
    if (prevRunActiveRef.current && !active && selectedTask) {
      void api()
        .notify({ title: "任务已收口", body: selectedTask.title })
        .catch(() => undefined);
    }
    prevRunActiveRef.current = active;
  }, [runActiveForHud, streaming.active, selectedTask]);


  return (
    <div className="grid h-full grid-cols-[240px_minmax(0,1fr)] bg-canvas text-ink">
      <nav
        aria-label="D Code 导航区"
        className="flex flex-col gap-0.5 overflow-y-auto bg-nav px-2.5 pb-4"
      >
        <div className="drag-region h-[38px] shrink-0" />
        <div className="flex items-center gap-2 px-2 pb-3">
          <img src={logoUrl} alt="" className="h-5 w-5 rounded-md" />
          <span className="text-[14px] font-semibold">D Code</span>
        </div>
        <NavRow label="新建任务" icon={<Plus size={13} />} />
        <div className="px-2 pt-4 pb-1 text-[10.5px] font-medium text-hint">
          最近工作
        </div>
        {tasks.slice(0, 3).map(task => (
          <div key={task.id}>
            <NavRow
              label={task.title}
              meta={relTime(task.updatedAt)}
              active={selectedTask?.id === task.id}
              onClick={() => { setSelectedTaskId(task.id); setView("task"); }}
            />
          </div>
        ))}
        <div className="px-2 pt-4 pb-1 text-[10.5px] font-medium text-hint">
          项目
        </div>
        {(snapshot?.projects ?? []).map(project => {
          const owned = tasks.filter(
            task => taskProjectId(task) === project.id,
          );
          return (
            <div key={project.id}>
              <NavRow label={project.title} meta={`${owned.length}`} />
              <div className="ml-3 border-l border-line pl-1.5">
                {owned.map(task => (
                  <TaskNavGroup
                    key={task.id}
                    task={task}
                    selected={selectedTask?.id === task.id}
                    childSessions={(snapshot?.sessions ?? []).filter(
                      session =>
                        session.taskId === task.id &&
                        session.kind === "child",
                    )}
                    onSelect={() => { setSelectedTaskId(task.id); setView("task"); }}
                  />
                ))}
              </div>
            </div>
          );
        })}
        <div className="px-2 pt-4 pb-1 text-[10.5px] font-medium text-hint">
          任务
        </div>
        {tasks
          .filter(task => taskProjectId(task) === null)
          .map(task => (
            <TaskNavGroup
              key={task.id}
              task={task}
              selected={selectedTask?.id === task.id}
              childSessions={(snapshot?.sessions ?? []).filter(
                session =>
                  session.taskId === task.id && session.kind === "child",
              )}
              onSelect={() => { setSelectedTaskId(task.id); setView("task"); }}
            />
          ))}
        <div className="px-2 pt-4 pb-1 text-[10.5px] font-medium text-hint">
          导入
        </div>
        <NavRow label="导入 Pi 会话…" onClick={() => setImportOpen(true)} />
        <div className="mt-auto px-2 pt-4 text-[11px] text-hint">
          本机 · Provider{" "}
          {(snapshot?.modelProviders ?? []).length} 个
        </div>
        <button
          onClick={() => setView("settings")}
          className={`mt-1 flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[12px] ${
            view === "settings" ? "bg-accent-fill text-accent" : "text-ink/80 hover:bg-ink/5"
          }`}
        >
          <Settings size={13} /> 设置
        </button>
      </nav>

      <main
        aria-label="D Code 工作区"
        className="relative flex min-w-0 flex-col"
      >
        {view === "settings" ? (
          <SettingsView
            snapshot={snapshot}
            providers={providers}
            currentModel={currentModel}
            onModelChange={changeModel}
          />
        ) : (
        <>
        <AnimatePresence>
          {importOpen ? (
            <motion.div
              key="import"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 z-30 flex items-center justify-center bg-ink/40"
              onClick={() => setImportOpen(false)}
            >
              <ImportPanel
                onClose={() => setImportOpen(false)}
                onImported={reload}
                userId={snapshot.currentUser.id}
              />
            </motion.div>
          ) : null}
        </AnimatePresence>
        {snapshot ? (
          <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-4 text-[11.5px] text-muted">
            <strong className="text-ink">
              {selectedTask ? selectedTask.title : "D Code"}
            </strong>
            {selectedProject ? (
              <span className="text-hint">· {selectedProject.title}</span>
            ) : null}
            {selectedProject ? (
              <span className="rounded bg-ink/5 px-1.5 py-0.5 text-[10.5px] text-accent">
                ⎇ {branchByProject[selectedProject.id] ?? "无 Git"}
              </span>
            ) : null}
            <span className="flex-1" />
            <button
              onClick={() => setSearchOpen(true)}
              className="rounded px-1.5 py-0.5 text-hint hover:bg-ink/5"
              aria-label="搜索会话"
            >
              搜索
            </button>
            {coordinationSession && presentation?.inspection ? (
              <span className="text-hint">
                路径 ·{" "}
                {
                  presentation.inspection.paths.find(
                    path => path.id === presentation.inspection?.currentPathId,
                  )?.title ?? "主路径"
                }
              </span>
            ) : null}
            <span className="text-hint">任务对话</span>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button
                  aria-label="会话操作"
                  className="rounded px-1.5 py-0.5 text-hint hover:bg-ink/5"
                >
                  ⋯
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  align="end"
                  className="z-50 min-w-[160px] rounded-lg border border-line bg-raised p-1 shadow-xl"
                >
                  <DropdownMenu.Item
                    onSelect={() => {
                      const title = window.prompt("重命名任务", task?.title ?? "");
                      if (title && coordinationSession) {
                        void api()
                          .request("session.setName", { name: title })
                          .then(() => reload())
                          .catch((reason: unknown) =>
                            setSendError(
                              reason instanceof Error
                                ? reason.message
                                : String(reason),
                            ),
                          );
                      }
                    }}
                    className="flex h-7 cursor-pointer items-center rounded-md px-2 text-[12px] outline-none data-[highlighted]:bg-accent-fill"
                  >
                    重命名会话
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    onSelect={() => {
                      if (coordinationSession && task) {
                        void api()
                          .request("session.copy", {
                            sessionId: coordinationSession.id,
                            targetCwd: task.cwd,
                          })
                          .then(() => reload())
                          .catch((reason: unknown) =>
                            setSendError(
                              reason instanceof Error
                                ? reason.message
                                : String(reason),
                            ),
                          );
                      }
                    }}
                    className="flex h-7 cursor-pointer items-center rounded-md px-2 text-[12px] outline-none data-[highlighted]:bg-accent-fill"
                  >
                    复制完整会话
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    onSelect={() => {
                      if (coordinationSession) {
                        void api()
                          .request("session.trash", {
                            sessionId: coordinationSession.id,
                          })
                          .then(() => reload())
                          .catch((reason: unknown) =>
                            setSendError(
                              reason instanceof Error
                                ? reason.message
                                : String(reason),
                            ),
                          );
                      }
                    }}
                    className="flex h-7 cursor-pointer items-center rounded-md px-2 text-[12px] text-warn outline-none data-[highlighted]:bg-warn/10"
                  >
                    移入废纸篓（仅空会话）
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
        ) : null}
        <div className="relative flex min-w-0 flex-1 flex-row">
        <section
          className={`flex min-w-0 flex-1 flex-col overflow-y-auto py-7 ${
            hudMode === "wide" ? "pl-[72px] pr-[374px]" : "px-9"
          }`}
        >
          <div className="mx-auto flex h-full w-[min(680px,100%)] flex-col">
            {fixtures ? (
              <div className="mb-3 rounded-md border border-warn/40 bg-warn/10 px-2 py-1 text-center text-[10.5px] text-warn">
                样式样例（非真实数据）——用于验收消息渲染形态
              </div>
            ) : null}
            {error ? (
              <div className="rounded-xl border border-line bg-raised p-5">
                <strong className="text-warn">Host 连接失败</strong>
                <p className="mt-1 text-[12.5px] text-muted">{error}</p>
                <button
                  onClick={reload}
                  className="mt-3 rounded-md border border-line px-2 py-1 text-[12px] hover:bg-ink/5"
                >
                  重试
                </button>
              </div>
            ) : !snapshot ? (
              <div className="rounded-xl border border-line bg-raised p-5 text-[12.5px] text-muted">
                正在连接 Host…
              </div>
            ) : (
              <>
                <div className="text-[10.5px] text-hint">
                  {selectedTask
                    ? `${
                        selectedTask.scope.kind === "project"
                          ? (snapshot.projects.find(
                              project =>
                                project.id === selectedTask.scope.projectId,
                            )?.title ?? "项目")
                          : "独立任务"
                      } / ${selectedTask.title} · 任务对话`
                    : "暂无任务"}
                </div>
                <h1 className="mb-4 mt-1 text-[17px] font-semibold">
                  {selectedTask ? selectedTask.title : "D Code"}
                </h1>
                <div className="min-h-0 flex-1">
                  <Conversation
                    presentation={
                      fixtures || coordinationSession
                        ? conversationPresentation
                        : null
                    }
                    streaming={streaming}
                    pendingImages={pendingImages}
                    onRemoveImage={index =>
                      setPendingImages(prev =>
                        prev.filter((_, i) => i !== index),
                      )
                    }
                    onAddImageFiles={addImageFiles}
                    onInsertPath={insertPath}
                    onQuote={quoteToComposer}
                    imageInputRef={imageInputRef}
                    draft={draft}
                    onDraftChange={setDraft}
                    onSend={send}
                    sending={sending}
                    running={runActiveForHud || streaming.active}
                    onStop={stop}
                    modelOptions={modelOptions}
                    currentModel={currentModel}
                    onModelChange={changeModel}
                    currentThinking={currentThinking}
                    onThinkingChange={changeThinking}
                  />
                </div>
                {sendError ? (
                  <p className="pt-2 text-[11.5px] text-warn">{sendError}</p>
                ) : null}
              </>
            )}
          </div>
        </section>

        <AnimatePresence>
          {snapshot && hudVisible && hudMode !== "compact" ? (
            <motion.div
              key="hud-overlay"
              className="absolute inset-y-0 right-0 z-10 flex items-start pt-[66px] pr-6"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              <HudCard
                snapshot={snapshot}
                task={selectedTask}
                messageCount={messageCount}
                runElapsed={runElapsedForHud}
                runActive={runActiveForHud}
                floating={hudMode === "wide"}
                onOpenDetail={() => {
                  setDetailOpen(true);
                  setHudOpen(false);
                }}
                onClose={() => setHudOpen(false)}
              />
            </motion.div>
          ) : null}
        </AnimatePresence>

        {snapshot && hudMode !== "wide" && !hudVisible && !detailOpen ? (
          <button
            onClick={() => setHudOpen(true)}
            className="absolute right-6 top-4 z-10 rounded-md border border-line bg-raised px-2 py-1 text-[11px] text-muted hover:bg-ink/5"
          >
            任务概览
          </button>
        ) : null}

        <AnimatePresence>
          {detailOpen ? (
            <motion.aside
              key="detail"
              aria-label="对象详情"
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 320, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              className="h-full shrink-0 overflow-hidden border-l border-line bg-nav"
            >
              <div className="flex h-full w-[320px] flex-col p-4">
                <div className="flex items-center">
                  <strong className="text-[13px]">详情 · 占位</strong>
                  <button
                    onClick={() => setDetailOpen(false)}
                    className="ml-auto rounded px-1.5 py-0.5 text-[11px] text-hint hover:bg-ink/5"
                  >
                    关闭
                  </button>
                </div>
                <p className="mt-2 text-[11.5px] leading-5 text-muted">
                  挤压任务区宽度的侧边子栏；对象详情（文件 / 变更 / 报告 /
                  证据）按 PRD 0028 后续面落地。
                </p>
              </div>
            </motion.aside>
          ) : null}
        </AnimatePresence>
        <AnimatePresence>
          {searchOpen ? (
            <motion.div
              key="search"
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.15 }}
              className="absolute inset-x-0 top-14 z-40 mx-auto w-[min(640px,90%)]"
              onMouseDown={event => event.stopPropagation()}
            >
              <div className="overflow-hidden rounded-xl border border-line bg-raised shadow-2xl">
                <div className="border-b border-line px-3 py-2">
                  <input
                    autoFocus
                    value={searchQuery}
                    onChange={event => setSearchQuery(event.target.value)}
                    onKeyDown={event => {
                      if (event.key === "Escape") {
                        setSearchOpen(false);
                        setSearchQuery("");
                      }
                    }}
                    placeholder="搜索任务与会话内容…"
                    className="h-8 w-full bg-transparent text-[13px] outline-none placeholder:text-hint"
                  />
                </div>
                <div className="max-h-[380px] overflow-y-auto p-1.5">
                  {searching ? (
                    <p className="px-3 py-2 text-[12px] text-muted">搜索中…</p>
                  ) : searchResults.length === 0 ? (
                    <p className="px-3 py-2 text-[12px] text-muted">
                      {searchQuery.trim().length === 0
                        ? "输入关键词搜索任务与会话。"
                        : "没有匹配结果。"}
                    </p>
                  ) : (
                    searchResults.map((result, index) => (
                      <button
                        key={result.sessionId + String(index)}
                        onClick={() => {
                          void api()
                            .request("session.open", {
                              sessionId: result.sessionId,
                            })
                            .then(() => reload())
                            .catch(() => undefined);
                          setSearchOpen(false);
                        }}
                        className="block w-full rounded-lg px-3 py-2 text-left hover:bg-ink/5"
                      >
                        <div className="flex items-center gap-2">
                          <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">
                            {result.title}
                          </span>
                          <span className="shrink-0 text-[10px] text-hint">
                            {result.matchKind === "title" ? "标题" : "正文"}
                          </span>
                        </div>
                        {result.snippet ? (
                          <div className="mt-0.5 truncate text-[11px] text-muted">
                            {result.snippet}
                          </div>
                        ) : null}
                      </button>
                    ))
                  )}
                </div>
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
        {hostDead ? (
          <div className="absolute inset-0 z-40 flex items-center justify-center bg-ink/50">
            <div className="rounded-xl border border-line bg-raised p-6 text-center shadow-2xl">
              <strong className="text-[14px]">核心已退出</strong>
              <p className="mt-2 max-w-[320px] text-[12px] leading-5 text-muted">
                界面仍在。正在运行的任务随核心退出而中断，恢复以最近安全点为准。
              </p>
              <button
                onClick={() => void restartHost()}
                className="mt-4 rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-white"
              >
                重启核心
              </button>
            </div>
          </div>
        ) : null}
        </div>
        </>
        )}
      </main>
    </div>
  );
}
