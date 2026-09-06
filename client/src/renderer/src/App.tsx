import { InspirationWorkspace } from "./components/InspirationWorkspace";
import { useInspiration } from "./workbench/useInspiration";
import { Transcript } from "./components/conversation/Transcript";
import { profileName } from "./workbench/presentation";
import { useModels } from "./workbench/useModels";
import {
  SettingsWorkspace,
  type SettingsPageId,
} from "./components/SettingsWorkspace";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { create } from "zustand";
import useSWR from "swr";
import {
  Plus,
  Search,
  Settings,
  PanelLeft,
  PanelRight,
  X,
  Folder,
  ChevronRight,
  MessageSquare,
  Check,
  Circle,
  AlertCircle,
  FileText,
  Sparkles,
} from "lucide-react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { Markdown } from "./components/Markdown";
import { Composer } from "./components/Composer";
import { ImportPanel } from "./components/ImportPanel";
import {
  api,
  errorText,
  type TaskRecord,
  type AgentRequestRecord,
  type ProviderView,
  type TaskWorkbenchInspectorTarget,
  type FoundationSnapshot,
} from "./types";
import { useWorkbench, type Workbench } from "./useWorkbench";
import logoUrl from "./assets/logo.png";

// Only transient display controls enter zustand. Product facts stay in Host projections.
interface DisplayState {
  page: "task" | "settings" | "inspiration";
  settingsPage: SettingsPageId;
  search: boolean;
  importing: boolean;
  projectForm: boolean;
  overview: boolean;
  nav: boolean;
}
const useDisplay = create<
  DisplayState & { set: (patch: Partial<DisplayState>) => void }
>((set) => ({
  page: "task",
  settingsPage: "models",
  search: false,
  importing: false,
  projectForm: false,
  overview: false,
  nav: true,
  set: (patch) => set(patch),
}));
const relativeTime = (iso: string) => {
  const minutes = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(iso)) / 60000),
  );
  return minutes < 1
    ? "刚刚"
    : minutes < 60
      ? `${minutes} 分钟`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)} 小时`
        : `${Math.floor(minutes / 1440)} 天`;
};
const stateLabel = (state: string) =>
  (
    ({
      idle: "待开始",
      active: "进行中",
      running: "运行中",
      waiting: "等待处理",
      completed: "已完成",
      failed: "失败",
      aborted: "已停止",
      cancelled: "已取消",
      pending: "待开始",
      in_progress: "进行中",
      blocked: "阻塞",
    }) as Record<string, string>
  )[state] ?? state;

export function App() {
  const work = useWorkbench();
  const display = useDisplay();
  const reduced = useReducedMotion();
  const models = useModels({sessionId:work.session?.id,mutateStore:work.mutateStore,onChanged:async()=>{await Promise.all([work.reload(),work.refreshPresentation()]);},onError:work.fail});
  const providers = models.data?.legacyProviders ?? [];
  const projectId =
    work.task?.scope.kind === "project" ? work.task.scope.projectId : null;
  const actualProject = work.snapshot?.projects.find((p) => p.id === projectId);
  const { data: git } = useSWR(
    projectId ? ["branch", projectId] : null,
    ([, id]) =>
      api().request<{ branch: string | null }>("project.gitBranch", {
        projectId: id,
      }),
    { refreshInterval: 15000 },
  );
  const [taskAction, setTaskAction] = useState<{
    taskId: string;
    action: "rename" | "archive" | "trash";
  } | null>(null);
  const [taskTitle, setTaskTitle] = useState("");
  const [taskActionBusy, setTaskActionBusy] = useState(false);
  const [taskActionError, setTaskActionError] = useState<string | null>(null);
  const [target, setTarget] = useState<
    TaskWorkbenchInspectorTarget | null | undefined
  >();
  const remoteTarget = work.snapshot?.taskWorkbenchViewState.inspectorTarget;
  const inspector = target === undefined ? remoteTarget : target;
  const select = (task: TaskRecord, sessionId?: string) => {
    setTarget(null);
    work.select(task, sessionId);
    display.set({
      page: "task",
      overview: work.preferences?.overviewVisible ?? true,
    });
  };
  const newTask = () => {
    setTarget(null);
    work.newTask();
    display.set({ page: "task", overview: false });
    requestAnimationFrame(() =>
      document.querySelector<HTMLTextAreaElement>("[data-composer]")?.focus(),
    );
  };
  const openDetail = (value: TaskWorkbenchInspectorTarget | null) => {
    setTarget(value);
    void work.patchView({ inspectorTarget: value }).catch(work.fail);
  };
  useEffect(
    () =>
      api().subscribe((event) => {
        if (event.event === "shell.focusSearch") display.set({ search: true });
        if (event.event === "shell.settings")
          display.set({ page: "settings", settingsPage: "models" });
        if (event.event === "shell.candidateRestored")
          display.set({ page: "settings", settingsPage: "evolution" });
        if (event.event === "shell.newProject")
          display.set({ projectForm: true });
        if (event.event === "shell.newTask") {
          display.set({ page: "task", overview: false });
          setTarget(null);
          requestAnimationFrame(() =>
            document
              .querySelector<HTMLTextAreaElement>("[data-composer]")
              ?.focus(),
          );
        }
      }),
    [display.set],
  );
  useEffect(() => {
    if (!work.preferences) return;
    display.set({
      nav: work.preferences.sidebarVisible ?? true,
      overview: work.preferences.overviewVisible ?? true,
    });
  }, [work.preferences?.sidebarVisible, work.preferences?.overviewVisible]);
  const inspiration=useInspiration(work,display.page==="inspiration");
  const ideaSources=work.snapshot?.taskContextSets.find(set=>set.taskId===work.task?.id)?.sources.filter(source=>source.kind==="global_knowledge"&&source.rootPath?.endsWith("/knowledge/inspiration"))??[];
  const showingSettings = display.page === "settings";
  if (showingSettings)
    return (
      <SettingsWorkspace
        initialPage={display.settingsPage}
        work={work}
        providers={providers}
        models={models}
        onClose={() => display.set({ page: "task" })}
        onImport={() => display.set({ page: "task", importing: true })}
        onOpenTask={(task) => {
          select(task);
          display.set({ page: "task" });
        }}
      />
    );
  const manageTask = async () => {
    if (!taskAction || taskActionBusy) return;
    setTaskActionBusy(true);
    setTaskActionError(null);
    try {
      await work.mutateStore("task.manage", {
        taskId: taskAction.taskId,
        action: taskAction.action,
        ...(taskAction.action === "rename" ? { title: taskTitle } : {}),
      });
      await work.reload();
      if (taskAction.action !== "rename") {
        work.newTask();
        setTarget(null);
      }
      setTaskAction(null);
    } catch (error) {
      setTaskActionError(errorText(error));
    } finally {
      setTaskActionBusy(false);
    }
  };
  const tasks = [...(work.snapshot?.tasks ?? [])]
    .filter((t) => t.state !== "archived")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return (
    <div
      className={`workbench ${display.nav ? "" : "nav-hidden"}`}
      style={
        {
          "--nav-width": `${work.preferences?.sidebarWidth ?? 240}px`,
          "--inspector-width": `${work.preferences?.inspectorWidth ?? 340}px`,
        } as React.CSSProperties
      }
    >
      {display.nav && (
        <nav className="navigation" aria-label="D Code 导航区">
          <div className="window-band drag-region">
            <button
              className="icon-button nav-toggle"
              aria-label="收起导航区"
              onClick={() => display.set({ nav: false })}
            >
              <PanelLeft size={16} />
            </button>
          </div>
          <div className="brand">
            <Logo />
            <span>D Code</span>
          </div>
          <button
            className="nav-row primary-action"
            aria-label="新建任务"
            aria-keyshortcuts="Meta+N"
            onClick={newTask}
          >
            <Plus size={17} />
            <span>新建任务</span>
            <kbd>⌘N</kbd>
          </button>
          <button
            className="nav-row"
            aria-label="搜索"
            aria-keyshortcuts="Meta+K"
            onClick={() => display.set({ search: true })}
          >
            <Search size={16} />
            <span>搜索</span>
            <kbd>⌘K</kbd>
          </button>
          <button className={`nav-row ${display.page==="inspiration"?"selected":""}`} aria-current={display.page==="inspiration"?"page":undefined} onClick={()=>{setTarget(undefined);display.set({page:"inspiration",search:false});}}><Sparkles size={16}/><span>灵感</span></button>
          <div className="navigation-scroll">
            {tasks.length > 0 && (
              <>
                <div className="nav-heading">最近工作</div>
                {tasks.slice(0, 3).map((t) => (
                  <TaskRow
                    key={t.id}
                    task={t}
                    active={display.page==="task"}
                    work={work}
                    select={select}
                    recent
                  />
                ))}
              </>
            )}
            <div className="nav-heading">
              <span>项目</span>
              <button
                className="icon-button"
                aria-label="新建项目"
                title="新建项目 ⇧⌘N"
                onClick={() => display.set({ projectForm: true })}
              >
                <Plus size={14} />
              </button>
            </div>
            {work.snapshot?.projects.map((p) => (
              <details className="project-group" key={p.id} open>
                <summary>
                  <ChevronRight size={13} />
                  <Folder size={14} />
                  <span>{p.title}</span>
                </summary>
                <div className="project-tasks">
                  {tasks
                    .filter(
                      (t) =>
                        t.scope.kind === "project" &&
                        t.scope.projectId === p.id,
                    )
                    .map((t) => (
                      <TaskRow
                        key={t.id}
                        task={t}
                        active={display.page==="task"}
                        work={work}
                        select={select}
                      />
                    ))}
                </div>
              </details>
            ))}
            {tasks.some((t) => t.scope.kind === "user") && (
              <>
                <div className="nav-heading">任务</div>
                {tasks
                  .filter((t) => t.scope.kind === "user")
                  .map((t) => (
                    <TaskRow key={t.id} task={t} active={display.page==="task"} work={work} select={select} />
                  ))}
              </>
            )}
          </div>
          <div className="navigation-footer">
            <button
              className="nav-row"
              aria-label="设置"
              onClick={() => display.set({ page: "settings" })}
            >
              <Settings size={16} />
              <span>设置</span>
            </button>
          </div>
        </nav>
      )}
      <main className="workspace" aria-label="D Code 工作区">
        <header
          className={`workspace-bar drag-region ${display.nav ? "" : "without-nav"}`}
        >
          {!display.nav && (
            <button
              className="icon-button"
              aria-label="显示导航区"
              onClick={() => display.set({ nav: true })}
            >
              <PanelLeft size={16} />
            </button>
          )}
          <span className="workspace-title">
            {display.page === "inspiration" ? "灵感" : (work.task?.title ?? "新任务")}
          </span>
          {actualProject && display.page === "task" && (
            <span className="workspace-context">
              {actualProject.title}
              {git?.branch ? ` · ${git.branch}` : ""}
            </span>
          )}
          {work.task && display.page==="task" && (
            <span className="workspace-context" title={work.task.cwd}>
              {work.task.scope.kind === "user" ? "个人任务" : "工作目录"} · {work.task.cwd}
            </span>
          )}
          <span className="spacer" />
          {work.task && display.page==="task" && (
            <Menu.Root>
              <Menu.Trigger asChild>
                <button className="icon-button" aria-label="任务操作">
                  ···
                </button>
              </Menu.Trigger>
              <Menu.Portal>
                <Menu.Content className="menu" align="end">
                  {(
                    [
                      ["rename", "重命名任务"],
                      ["archive", "归档任务"],
                      ["trash", "移入废纸篓（仅空任务）"],
                    ] as const
                  ).map(([action, label]) => (
                    <Menu.Item
                      key={action}
                      className="menu-item"
                      onSelect={() => {
                        setTaskAction({ taskId: work.task!.id, action });
                        setTaskTitle(work.task!.title);
                        setTaskActionError(null);
                      }}
                    >
                      {label}
                    </Menu.Item>
                  ))}
                  <Menu.Item
                    className="menu-item"
                    disabled={work.running || !work.session}
                    onSelect={() =>
                      void work
                        .mutateStore<import("./types").TaskBundle>(
                          "dcodeSession.copy",
                          { dcodeSessionId: work.session!.id },
                        )
                        .then(async (bundle) => {
                          await work.reload();
                          select(bundle.task, bundle.coordinationSession.id);
                        })
                        .catch(work.fail)
                    }
                  >
                    复制完整会话为新任务
                  </Menu.Item>
                </Menu.Content>
              </Menu.Portal>
            </Menu.Root>
          )}
          {display.page === "inspiration" ? (
            <button
              className="text-button"
              onClick={() => {setTarget(undefined);display.set({ page: "task" });}}
            >
              返回任务
            </button>
          ) : (
            work.task && display.page==="task" && (
              <button
                className="icon-button"
                aria-label="任务概览"
                aria-pressed={display.overview}
                onClick={() => {
                  if (inspector) openDetail(null);
                  display.set({ overview: !display.overview });
                }}
              >
                <PanelRight size={17} />
              </button>
            )
          )}
        </header>
        {display.page==="task"&&ideaSources.length>0&&<div className="idea-task-context" aria-label="任务引用的灵感"><Sparkles size={14}/><span>下次运行的灵感</span>{ideaSources.map(source=><span className="idea-context-tag" key={source.id}>{source.title} · 第 {source.relativePath.match(/\/r(\d+)-/)?.[1]??"已选"} 版</span>)}</div>}
        {work.loadError ? (
          <div className="workspace-error" role="alert">
            <AlertCircle />
            <h2>暂时无法读取任务</h2>
            <p>{errorText(work.loadError)}</p>
            <button className="text-button" onClick={() => void work.reload()}>
              重试
            </button>
            <button className="text-button" onClick={() => void work.restart()}>
              重新连接
            </button>
          </div>
        ) : !work.snapshot ? (
          <div className="loading" role="status">
            正在读取工作台…
          </div>
        ) : display.page==="inspiration" ? <InspirationWorkspace model={inspiration} pathForFile={file=>api().getPathForFile(file)} canSaveFromTask={!!work.task}/> : (
          <div className={`work-area ${inspector ? "with-inspector" : ""}`}>
            <section className={`conversation-space ${!work.session ? "new-conversation" : ""}`}>
              <Transcript key={work.session?.id ?? "new"} work={work} emptyBrand={<Logo />} onSaveInspiration={text=>{inspiration.begin("text",{title:text.trim().split("\n")[0]?.slice(0,80)||"新灵感",markdown:text,...(work.task?{sourceTaskId:work.task.id}:{})});setTarget(undefined);display.set({page:"inspiration"});}} />
              <div className="reading-lane">
                <Composer
                  work={work}
                  models={models}
                  pathForFile={(file)=>api().getPathForFile(file)}
                  onSettings={() => display.set({ page: "settings" })}
                />
              </div>
            </section>
            <AnimatePresence>
              {work.task && display.overview && !inspector && (
                <motion.aside
                  aria-label="任务概览"
                  className="overview"
                  initial={{ opacity: 0, y: reduced ? 0 : -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: reduced ? 0 : 0.16 }}
                >
                  <Overview
                    work={work}
                    onClose={() => display.set({ overview: false })}
                    onSelect={select}
                    onDetail={openDetail}
                  />
                </motion.aside>
              )}
            </AnimatePresence>
            {inspector && (
              <Inspector
                target={inspector}
                snapshot={work.snapshot}
                taskId={work.task?.id ?? null}
                onClose={() => openDetail(null)}
              />
            )}
          </div>
        )}
        {work.hostDead && (
          <div className="recovery" role="alert">
            <AlertCircle size={20} />
            <strong>运行服务已退出</strong>
            <p>任务记录已保留。重新连接后可继续工作。</p>
            {work.error && <p>{work.error}</p>}
            <button
              className="primary-button"
              disabled={work.restarting}
              onClick={() => void work.restart()}
            >
              {work.restarting ? "正在重新连接…" : "重新连接"}
            </button>
          </div>
        )}
      </main>
      {taskAction && (
        <Overlay
          label={taskAction.action === "rename" ? "重命名任务" : "归档任务"}
          onClose={() => {
            if (!taskActionBusy) setTaskAction(null);
          }}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void manageTask();
            }}
          >
            <div className="panel-heading">
              <strong>
                {taskAction.action === "rename"
                  ? "重命名任务"
                  : taskAction.action === "trash"
                    ? "将空任务移入废纸篓"
                    : "归档任务"}
              </strong>
            </div>
            <div className="form-fields">
              {taskAction.action === "rename" ? (
                <label>
                  任务名称
                  <input
                    autoFocus
                    required
                    maxLength={200}
                    value={taskTitle}
                    onChange={(e) => setTaskTitle(e.target.value)}
                  />
                </label>
              ) : (
                <p>“{taskTitle}”的记录会保留，可从设置中的已归档任务恢复。</p>
              )}
              {taskActionError && <p role="alert">{taskActionError}</p>}
            </div>
            <div className="dialog-actions">
              <button
                type="button"
                className="text-button"
                disabled={taskActionBusy}
                onClick={() => setTaskAction(null)}
              >
                取消
              </button>
              <button
                className="primary-button"
                disabled={taskActionBusy || !taskTitle.trim()}
              >
                {taskActionBusy ? "正在保存…" : "确认"}
              </button>
            </div>
          </form>
        </Overlay>
      )}
      {display.search && work.snapshot && (
        <SearchPanel
          work={work}
          select={select}
          onClose={() => display.set({ search: false })}
        />
      )}
      {display.importing && work.snapshot && (
        <Overlay
          label="导入 Pi 会话"
          onClose={() => display.set({ importing: false })}
        >
          <ImportPanel
            onClose={() => display.set({ importing: false })}
            onImported={async (bundle) => {
              await work.reload();
              select(bundle.task, bundle.coordinationSession.id);
            }}
            userId={work.snapshot.currentUser.id}
            mutateStore={work.mutateStore}
          />
        </Overlay>
      )}
      {display.projectForm && (
        <Overlay
          label="新建项目"
          onClose={() => display.set({ projectForm: false })}
        >
          <ProjectForm
            work={work}
            onClose={() => display.set({ projectForm: false })}
          />
        </Overlay>
      )}
    </div>
  );
}
function Logo() {
  return (
    <span
      className="logo"
      aria-hidden="true"
      style={{
        maskImage: `url(${logoUrl})`,
        WebkitMaskImage: `url(${logoUrl})`,
      }}
    />
  );
}
function TaskRow({
  task,
  work,
  select,
  recent = false,
  active = true,
}: {
  task: TaskRecord;
  work: Workbench;
  select: (task: TaskRecord, sessionId?: string) => void;
  recent?: boolean;
  active?: boolean;
}) {
  const children =
    work.snapshot?.sessions.filter(
      (s) => s.taskId === task.id && s.kind === "child",
    ) ?? [];
  const failed = work.snapshot?.sessionRuns
    .filter((run) => run.taskId === task.id)
    .at(-1)?.status;
  return (
    <div>
      <button
        className="nav-row task-row"
        aria-current={active && work.task?.id === task.id ? "page" : undefined}
        onClick={() => select(task)}
      >
        <span>{task.title}</span>
        {failed && ["failed", "interrupted", "unknown"].includes(failed) && (
          <AlertCircle size={13} aria-label="执行需要处理" />
        )}
        {recent && <small>{relativeTime(task.updatedAt)}</small>}
      </button>
      {!recent && children.length > 0 && (
        <details className="child-sessions">
          <summary>
            <ChevronRight size={12} />
            <span>子会话</span>
            <small>{children.length}</small>
          </summary>
          {children.map((s) => (
            <button
              key={s.id}
              className="nav-row"
              aria-current={active && work.session?.id === s.id ? "page" : undefined}
              onClick={() => select(task, s.id)}
            >
              <MessageSquare size={12} />
              <span>{s.title}</span>
            </button>
          ))}
        </details>
      )}
    </div>
  );
}
function RunStats({ work }: { work: Workbench }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!work.running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [work.running]);
  const run = work.run;
  const seconds = run?.startedAt
    ? Math.max(
        0,
        Math.floor(
          ((run.completedAt ? Date.parse(run.completedAt) : now) -
            Date.parse(run.startedAt)) /
            1000,
        ),
      )
    : null;
  const elapsed =
    seconds === null
      ? null
      : seconds >= 3600
        ? `${Math.floor(seconds / 3600)} 小时 ${Math.floor((seconds % 3600) / 60)} 分`
        : seconds >= 60
          ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
          : `${seconds} 秒`;
  const items =
    work.snapshot?.taskWorkItems.filter(
      (item) => item.taskId === work.task?.id,
    ) ?? [];
  return (
    <p className="run-statistics">
      {elapsed && (
        <span>
          {work.running ? "运行中" : "本次执行"} · {elapsed}
        </span>
      )}
      <span>
        消息{" "}
        {work.presentation?.inspection?.context.messageCount ??
          work.imported.length}
      </span>
      <span>
        工作项 {items.filter((item) => item.state === "completed").length} /{" "}
        {items.length}
      </span>
    </p>
  );
}

function Overview({
  work,
  onClose,
  onSelect,
  onDetail,
}: {
  work: Workbench;
  onClose: () => void;
  onSelect: (task: TaskRecord, sessionId?: string) => void;
  onDetail: (target: TaskWorkbenchInspectorTarget) => void;
}) {
  const snapshot = work.snapshot!;
  const task = work.task!;
  const expanded = snapshot.taskWorkbenchViewState.expandedHudSections;
  const section = (id: string, title: string, content: ReactNode) => (
    <div className="overview-section">
      <button
        className="section-toggle"
        aria-expanded={expanded.includes(id)}
        onClick={() =>
          void work
            .patchView({
              expandedHudSections: expanded.includes(id)
                ? expanded.filter((s) => s !== id)
                : [...expanded, id],
            })
            .catch(work.fail)
        }
      >
        <ChevronRight size={12} />
        {title}
      </button>
      {expanded.includes(id) && <div>{content}</div>}
    </div>
  );
  const items = snapshot.taskWorkItems.filter((i) => i.taskId === task.id);
  const members = snapshot.agentRuns.filter((r) => r.taskId === task.id);
  const requests = snapshot.agentRequests.filter(
    (r) => r.taskId === task.id && r.status === "open",
  );
  const artifacts = snapshot.artifacts.filter((a) => a.taskId === task.id && a.kind !== "attachment");
  const reports = snapshot.agentReports.filter((r) => r.taskId === task.id);
  return (
    <>
      <div className="panel-heading">
        <strong>任务概览</strong>
        <button
          className="icon-button"
          aria-label="关闭任务概览"
          onClick={onClose}
        >
          <X size={14} />
        </button>
      </div>
      {section(
        "progress",
        "进度",
        <>
          <p>{task.goal}</p>
          <RunStats work={work} />
          {work.run && (
            <p className="secondary">{stateLabel(work.run.status)}</p>
          )}
          {items.length ? (
            <ul className="work-items">
              {items.map((i) => (
                <li key={i.id}>
                  {i.state === "completed" ? (
                    <Check size={13} />
                  ) : i.state === "blocked" ? (
                    <AlertCircle size={13} />
                  ) : (
                    <Circle size={11} />
                  )}
                  <span className={i.state === "completed" ? "done" : ""}>
                    {i.title}
                  </span>
                  <small>{stateLabel(i.state)}</small>
                </li>
              ))}
            </ul>
          ) : (
            <p className="secondary">尚未制定工作清单</p>
          )}
        </>,
      )}
      {section(
        "team",
        "团队",
        members.length ? (
          <ul className="members">
            {members.map((m) => (
              <li key={m.id}>
                <button onClick={() => onSelect(task, m.sessionId)}>
                  <span>
                    {profileName(snapshot.agentProfiles.find((p) => p.id === m.profileId))}
                  </span>
                  <small>{stateLabel(m.status)}</small>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="secondary">任务开始后显示执行成员</p>
        ),
      )}
      {section(
        "waiting",
        `等待处理${requests.length ? ` · ${requests.length}` : ""}`,
        requests.length ? (
          requests.map((request) => (
            <RequestActions
              key={request.id}
              request={request}
              task={task}
              work={work}
            />
          ))
        ) : (
          <p className="secondary">没有等待事项</p>
        ),
      )}
      {section(
        "deliverables",
        "交付物",
        artifacts.length || reports.length ? (
          <ul className="deliverables">
            {artifacts.map((a) => (
              <li key={a.id}>
                <button
                  onClick={() => onDetail({ kind: "artifact", id: a.id })}
                >
                  <FileText size={13} />
                  {a.title}
                </button>
              </li>
            ))}
            {reports.map((r) => (
              <li key={r.id}>
                <button onClick={() => onDetail({ kind: "report", id: r.id })}>
                  <FileText size={13} />
                  执行报告
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="secondary">尚无交付物</p>
        ),
      )}
    </>
  );
}
function RequestActions({
  request,
  task,
  work,
}: {
  request: AgentRequestRecord;
  task: TaskRecord;
  work: Workbench;
}) {
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const respond = async (optionId?: string, withFeedback = false) => {
    if (busy) return;
    setBusy(true);
    const target = {
      taskId: task.id,
      scope: task.scope,
      runtimeId: request.runtimeId,
      agentRunId: request.agentRunId,
      sessionRunId: request.sessionRunId,
      ...(request.teamRunId ? { teamRunId: request.teamRunId } : {}),
      agentRequestId: request.id,
      expectedRequestRevision: request.revision,
    };
    try {
      if (request.kind === "choice")
        await work.mutateStore("agentRequest.answer", {
          ...target,
          answer: { kind: "choice", optionId },
        });
      else
        await work.mutateStore("task.acceptance", {
          ...target,
          expectedTaskRevision: task.revision,
          ...(withFeedback ? { feedback: feedback.trim() } : {}),
        });
      await work.reload();
    } catch (error) {
      work.fail(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="request">
      <p>{request.prompt}</p>
      {request.kind === "choice" ? (
        request.options.map((option) => (
          <button
            key={option.id}
            className="text-button"
            disabled={busy}
            onClick={() => void respond(option.id)}
          >
            {option.label}
          </button>
        ))
      ) : (
        <>
          <textarea
            className="request-feedback"
            aria-label="验收反馈"
            placeholder="需要调整的地方（可选）"
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            maxLength={20000}
          />
          <button
            className="text-button"
            disabled={busy}
            onClick={() => void respond()}
          >
            验收通过
          </button>
          <button
            className="text-button"
            disabled={busy || !feedback.trim()}
            onClick={() => void respond(undefined, true)}
          >
            提交反馈
          </button>
        </>
      )}
    </div>
  );
}

function Inspector({
  target,
  snapshot,
  taskId,
  onClose,
}: {
  target: TaskWorkbenchInspectorTarget;
  snapshot: FoundationSnapshot;
  taskId: string | null;
  onClose: () => void;
}) {
  const item =
    target.kind === "artifact"
      ? snapshot.artifacts.find(
          (a) => a.id === target.id && a.taskId === taskId,
        )
      : target.kind === "report"
        ? snapshot.agentReports.find(
            (r) => r.id === target.id && r.taskId === taskId,
          )
        : target.kind === "evidence"
          ? snapshot.evidence.find(
              (e) => e.id === target.id && e.taskId === taskId,
            )
          : undefined;
  const title =
    item && "title" in item
      ? item.title
      : target.kind === "report"
        ? "执行报告"
        : "记录详情";
  const content =
    item && "body" in item
      ? item.body
      : item && "metadata" in item
        ? item.metadata
        : item && "payload" in item
          ? item.payload
          : null;
  return (
    <aside className="inspector" aria-label="对象详情">
      <div className="panel-heading">
        <strong>{title}</strong>
        <button className="icon-button" aria-label="关闭详情" onClick={onClose}>
          <X size={15} />
        </button>
      </div>
      <div className="inspector-content">
        {item ? (
          <>
            {content != null && (
              <Markdown
                text={
                  typeof content === "string"
                    ? content
                    : JSON.stringify(content, null, 2)
                }
              />
            )}{" "}
            {"managedPath" in item && item.managedPath && (
              <p className="source-path">{item.managedPath}</p>
            )}
            {"externalPath" in item && item.externalPath && (
              <p className="source-path">{item.externalPath}</p>
            )}
          </>
        ) : (
          <p>此记录已不可用。关闭后可选择其他交付物。</p>
        )}
      </div>
    </aside>
  );
}
function Overlay({
  label,
  onClose,
  children,
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLElement>("input,button,textarea")?.focus();
    return () => previous?.focus();
  }, []);
  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
        if (e.key === "Tab") {
          const elements = [
            ...(panel.current?.querySelectorAll<HTMLElement>(
              'button:not(:disabled),input,textarea,[tabindex="0"]',
            ) ?? []),
          ];
          const first = elements[0],
            last = elements.at(-1);
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last?.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first?.focus();
          }
        }
      }}
    >
      <div
        ref={panel}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={label}
      >
        {children}
      </div>
    </div>
  );
}
function SearchPanel({
  work,
  select,
  onClose,
}: {
  work: Workbench;
  select: (task: TaskRecord, sessionId?: string) => void;
  onClose: () => void;
}) {
  const [indexRevision, setIndexRevision] = useState(0);
  useEffect(
    () =>
      api().subscribe((event) => {
        if (
          event.event === "session.searchIndexChanged" &&
          (event.data as { state?: string })?.state === "ready"
        )
          setIndexRevision((r) => r + 1);
      }),
    [],
  );
  const [query, setQuery] = useState("");
  const [remote, setRemote] = useState<
    { sessionId: string; snippet: string }[]
  >([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    const text = query.trim();
    setRemote([]);
    setError(null);
    setBusy(!!text);
    if (!text) return;
    const timer = setTimeout(() => {
      void api()
        .request<{
          results: { sessionId: string; snippet: string }[];
          index: { complete: boolean; state: string };
        }>("session.search", {
          query: text,
          requestToken: crypto.randomUUID(),
          projectSourceFolders:
            work.snapshot?.projects.map((p) => p.directory) ?? [],
          limit: 40,
        })
        .then((r) => {
          if (alive) {
            setRemote(r.results);
            setBusy(!r.index.complete && r.index.state !== "failed");
          }
        })
        .catch((e) => {
          if (alive) {
            setError(errorText(e));
            setBusy(false);
          }
        });
    }, 200);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [
    query,
    indexRevision,
    work.snapshot?.projects.map((p) => p.directory).join("|"),
  ]);
  const results = useMemo(() => {
    if (!query.trim()) return [];
    const map = new Map<
      string,
      { task: TaskRecord; sessionId?: string; snippet: string }
    >();
    for (const t of work.snapshot?.tasks ?? [])
      if (t.title.toLowerCase().includes(query.trim().toLowerCase()))
        map.set(t.id, { task: t, snippet: t.goal });
    for (const r of remote) {
      const binding = work.snapshot?.sessionRuntimeBindings.find(
        (b) => b.adapterSessionId === r.sessionId,
      );
      const session = work.snapshot?.sessions.find(
        (s) => s.id === binding?.sessionId,
      );
      const task = work.snapshot?.tasks.find((t) => t.id === session?.taskId);
      if (task && session)
        map.set(session.id, {
          task,
          sessionId: session.id,
          snippet: r.snippet,
        });
    }
    return [...map.values()];
  }, [query, remote, work.snapshot]);
  return (
    <Overlay label="搜索任务" onClose={onClose}>
      <div className="panel-heading input-surface">
        <Search size={17} />
        <input
          aria-label="搜索任务与消息"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索任务与消息…"
        />
        <button className="icon-button" aria-label="关闭搜索" onClick={onClose}>
          <X size={15} />
        </button>
      </div>
      <div className="search-results">
        {error && (
          <p role="alert" className="inline-error">
            消息搜索暂不可用：{error}
          </p>
        )}
        {results.map((r) => (
          <button
            key={r.sessionId ?? r.task.id}
            onClick={() => {
              select(r.task, r.sessionId);
              onClose();
            }}
          >
            <strong>{r.task.title}</strong>
            <span>{r.snippet}</span>
          </button>
        ))}
        {!results.length && (
          <p className="secondary" role="status">
            {busy
              ? "正在搜索…"
              : query
                ? "没有匹配结果"
                : "输入关键词查找任务和消息"}
          </p>
        )}
      </div>
    </Overlay>
  );
}
function ProjectForm({
  work,
  onClose,
}: {
  work: Workbench;
  onClose: () => void;
}) {
  const [title, setTitle] = useState("");
  const [directory, setDirectory] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = async () => {
    if (!title.trim() || !directory || busy) return;
    setBusy(true);
    try {
      const result = await work.mutateStore<{ project: { id: string } }>(
        "project.create",
        { title: title.trim(), directory },
      );
      await work.reload();
      work.setNewProjectId(result.project.id);
      work.newTask();
      useDisplay.getState().set({ page: "task" });
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void create();
      }}
    >
      <div className="panel-heading">
        <strong>新建项目</strong>
        <button
          type="button"
          className="icon-button"
          aria-label="关闭"
          onClick={onClose}
        >
          <X size={15} />
        </button>
      </div>
      <div className="form-fields">
        <label>
          项目名称
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
          />
        </label>
        <label>
          项目文件夹
          <button
            type="button"
            className="folder-picker"
            onClick={() =>
              void api()
                .chooseDirectory()
                .then((path) => {
                  if (path) setDirectory(path);
                })
                .catch((e) => setError(errorText(e)))
            }
          >
            <Folder size={16} />
            {directory || "选择文件夹…"}
          </button>
        </label>
        {error && <p role="alert">{error}</p>}
      </div>
      <div className="dialog-actions">
        <button type="button" className="text-button" onClick={onClose}>
          取消
        </button>
        <button
          className="primary-button"
          disabled={!title.trim() || !directory || busy}
        >
          {busy ? "正在创建…" : "创建项目"}
        </button>
      </div>
    </form>
  );
}
