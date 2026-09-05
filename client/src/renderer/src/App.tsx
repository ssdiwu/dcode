import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  api,
  fetchSnapshot,
  taskProjectId,
  type DCodeSessionPresentation,
  type FoundationSnapshot,
  type SessionEntry,
  type TaskRecord,
} from "./types";

/**
 * 验收面一：导航区 + 任务对话真实消息流（PRD 0028 §3）。
 * - 导航区：项目树 / 独立任务 / 最近工作占位；选中任务固定行高、纯色选中。
 * - 任务对话：协调会话真实消息（dcodeSession.presentation → inspection.entries），
 *   composer 经 dcodeSession.prompt 发起真实运行；草稿经 composerDraft.set 入库。
 * - 梗概浮卡 / 详情侧栏两态合同不变。
 */

const WIDE_MIN = 1320;
const MEDIUM_MIN = 880;

type HudMode = "wide" | "medium" | "compact";

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

function entryText(entry: SessionEntry): { role: string; text: string } | null {
  if (entry.type !== "message" || !entry.message) return null;
  const role = entry.message.role === "assistant" ? "assistant" : "user";
  const content = entry.message.content;
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map(part => {
        const candidate = part as { type?: string; text?: string };
        return candidate.type === "text" ? (candidate.text ?? "") : "";
      })
      .join("");
  }
  if (text.trim().length === 0) return null;
  return { role, text };
}

function NavRow({
  label,
  meta,
  active,
  onClick,
}: {
  label: string;
  meta?: string;
  active?: boolean;
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
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {meta ? <span className="shrink-0 text-hint">{meta}</span> : null}
    </button>
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
    <div className="border-b border-line px-3 py-2 last:border-b-0">
      <button
        onClick={onToggle}
        className="flex h-6 w-full items-center gap-1.5 rounded px-1 text-left text-[10.5px] font-semibold tracking-wide text-hint hover:bg-ink/5"
      >
        <span
          className={`inline-block transition-transform ${expanded ? "rotate-90" : ""}`}
        >
          ›
        </span>
        {title}
      </button>
      {expanded ? <div className="pt-1.5">{children}</div> : null}
    </div>
  );
}

function HudCard({
  snapshot,
  task,
  messageCount,
  onOpenDetail,
  onClose,
  floating,
}: {
  snapshot: FoundationSnapshot;
  task: TaskRecord | null;
  messageCount: number;
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
              消息 {messageCount} · 工作项 完成 {done} / 进行 {inProgress}
              {blocked > 0 ? ` / 阻塞 ${blocked}` : ""}
              {items.length === 0 ? " · 暂无工作项" : ""}
            </div>
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

function Conversation({
  presentation,
  draft,
  onDraftChange,
  onSend,
  sending,
}: {
  presentation: DCodeSessionPresentation | null;
  draft: string;
  onDraftChange: (text: string) => void;
  onSend: () => void;
  sending: boolean;
}) {
  const entries = presentation?.inspection?.entries ?? [];
  const messages = entries
    .map(entryText)
    .filter((value): value is { role: string; text: string } => value !== null);

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {messages.length === 0 ? (
          <div className="mx-auto mt-24 max-w-[460px] text-center">
            <h2 className="text-[19px] font-semibold">想完成什么？</h2>
            <p className="mt-2 text-[12.5px] leading-5 text-muted">
              发送第一条消息后开始任务；标题可稍后调整。
            </p>
          </div>
        ) : (
          <div className="space-y-5">
            {messages.map((message, index) => (
              <div key={index} className="text-[13px] leading-6">
                <div className="mb-0.5 text-[11px] font-semibold text-hint">
                  {message.role === "assistant" ? "D Code" : "507"}
                </div>
                <div className="whitespace-pre-wrap">{message.text}</div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="pt-4">
        <div className="rounded-xl border border-line bg-raised p-3 shadow-sm">
          <textarea
            value={draft}
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
          <div className="flex justify-end">
            <button
              onClick={onSend}
              disabled={sending || draft.trim().length === 0}
              className="rounded-md bg-accent px-3 py-1 text-[12px] font-medium text-white disabled:opacity-40"
            >
              {sending ? "发送中…" : "发送"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function App() {
  const { snapshot, error, reload } = useFoundation();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
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
  const width = useWorkspaceWidth();
  const hudMode: HudMode =
    width >= WIDE_MIN ? "wide" : width >= MEDIUM_MIN ? "medium" : "compact";
  const hudVisible =
    !detailOpen && (hudMode === "wide" || (hudMode !== "compact" && hudOpen));

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

  useEffect(() => {
    if (!coordinationSession) {
      setPresentation(null);
      return;
    }
    let alive = true;
    api()
      .request("dcodeSession.presentation", {
        dcodeSessionId: coordinationSession.id,
      })
      .then(value => {
        if (alive) setPresentation(value as DCodeSessionPresentation);
      })
      .catch(() => {
        if (alive) setPresentation(null);
      });
    return () => {
      alive = false;
    };
  }, [coordinationSession?.id]);

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
      });
      setDraft("");
      reload();
    } catch (reason) {
      setSendError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSending(false);
    }
  };

  const messageCount = presentation?.inspection?.context.messageCount ?? 0;

  return (
    <div className="grid h-full grid-cols-[240px_minmax(0,1fr)] bg-canvas text-ink">
      <nav
        aria-label="D Code 导航区"
        className="flex flex-col gap-0.5 overflow-y-auto bg-nav px-2.5 py-4"
      >
        <div className="px-2 pb-3 text-[14px] font-semibold">D Code</div>
        <NavRow label="＋ 新建任务" />
        <div className="px-2 pt-4 pb-1 text-[10.5px] font-medium text-hint">
          最近工作
        </div>
        {tasks.slice(0, 3).map(task => (
          <NavRow
            key={task.id}
            label={task.title}
            active={selectedTask?.id === task.id}
            onClick={() => setSelectedTaskId(task.id)}
          />
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
                  <NavRow
                    key={task.id}
                    label={task.title}
                    active={selectedTask?.id === task.id}
                    onClick={() => setSelectedTaskId(task.id)}
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
            <NavRow
              key={task.id}
              label={task.title}
              active={selectedTask?.id === task.id}
              onClick={() => setSelectedTaskId(task.id)}
            />
          ))}
        <div className="mt-auto px-2 pt-4 text-[12px] text-hint">设置（占位）</div>
      </nav>

      <main
        aria-label="D Code 工作区"
        className="relative flex min-w-0 flex-row"
      >
        <section className="flex min-w-0 flex-1 flex-col px-9 py-7">
          <div className="mx-auto flex h-full w-[min(680px,100%)] flex-col">
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
                  {selectedTask ? "任务对话" : "暂无任务"}
                </div>
                <h1 className="mb-4 mt-1 text-[17px] font-semibold">
                  {selectedTask ? selectedTask.title : "D Code"}
                </h1>
                <div className="min-h-0 flex-1">
                  <Conversation
                    presentation={coordinationSession ? presentation : null}
                    draft={draft}
                    onDraftChange={setDraft}
                    onSend={send}
                    sending={sending}
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
      </main>
    </div>
  );
}
