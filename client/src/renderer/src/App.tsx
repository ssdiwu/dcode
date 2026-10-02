import { uiText, getDisplayLanguage, setDisplayLanguage, subscribeDisplayLanguage } from "../../shared/ui-language.ts";
import { uiMotion, useMotionReduction } from "./workbench/motion";
import { LoadingPlaceholder } from "./components/LoadingPlaceholder";
import {NewTaskScene} from "./components/NewTaskScene";
import {AuxiliaryActivities} from "./components/AuxiliaryActivities";
import {TaskContext} from "./components/TaskContext";
import {SourceDetail} from "./components/SourceDetail";
import {UsedSourceDetail} from "./components/UsedSourceDetail";
import { TaskRouteSummary } from "./components/TaskRouteSummary";
import {ExtensionRequests} from "./components/ExtensionRequests";
import {WorkspaceFiles,WorkspaceFileNavigation,FileCloseDialog} from "./components/WorkspaceFiles";
import {useModalFocus} from "./components/modal-focus";
import {useWorkspaceFiles,FileReferenceContext} from "./workbench/useWorkspaceFiles";
import { InspirationWorkspace } from "./components/InspirationWorkspace";
import { useInspiration } from "./workbench/useInspiration";
import { Transcript } from "./components/conversation/Transcript";
import { TeamOverview } from "./components/TeamOverview";
import { useModels } from "./workbench/useModels";
import {
  SettingsWorkspace,
  type SettingsPageId,
} from "./components/SettingsWorkspace";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
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
  Ellipsis,
  SquarePen,
  Maximize2,
  Minimize2,
} from "lucide-react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { Markdown, TaskSourceReferenceContext } from "./components/Markdown";
import { Composer } from "./components/Composer";
import { ImportPanel } from "./components/ImportPanel";
import {
  api,
  errorText,
  type TaskRecord,
  type TaskSourceSelector,
  type TaskBundle,
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
    ? uiText("刚刚")
    : minutes < 60
      ? uiText("{0} 分钟", [minutes])
      : minutes < 1440
        ? uiText("{0} 小时", [Math.floor(minutes / 60)])
        : uiText("{0} 天", [Math.floor(minutes / 1440)]);
};
const stateLabel = (state: string) =>
  (
    ({
      idle: uiText("待开始"),
      active: uiText("进行中"),
      running: uiText("运行中"),
      waiting: uiText("等待处理"),
      completed: uiText("已完成"),
      failed: uiText("失败"),
      aborted: uiText("已停止"),
      interrupted: uiText("已中断"),
      unknown: uiText("状态待核对"),
      prepared: uiText("待开始"),
      cancelled: uiText("已取消"),
      pending: uiText("待开始"),
      in_progress: uiText("进行中"),
      blocked: uiText("阻塞"),
    }) as Record<string, string>
  )[state] ?? state;

export function App() {
  const work = useWorkbench();
  const language=useSyncExternalStore(subscribeDisplayLanguage,getDisplayLanguage);
  useLayoutEffect(()=>{if(work.preferences)setDisplayLanguage(work.preferences.language??"zh-CN");},[work.preferences?.language]);
  useLayoutEffect(()=>{document.documentElement.lang=language;},[language]);
  const files=useWorkspaceFiles(work);
  const display = useDisplay();
  useEffect(()=>{if(files.navigationRequest)display.set({nav:true});},[files.navigationRequest,display.set]);
  const reduced = useMotionReduction();
  const newTaskDraft = !work.task && !work.session;
  const showNewTask = newTaskDraft;
  const previousTask = useRef<{taskId:string;sessionId?:string}|null>(null);
  useEffect(() => {
    if (work.task) previousTask.current = {taskId:work.task.id,sessionId:work.session?.id};
  }, [work.task?.id, work.session?.id]);
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
  const [contextOpen,setContextOpen]=useState(false);
  const [commandMenuOpen,setCommandMenuOpen]=useState(false);
  const [workflowOpenSignal,setWorkflowOpenSignal]=useState(0);
  const [projectEditingId,setProjectEditingId]=useState<string|null>(null);
  const [projectMenuId,setProjectMenuId]=useState<string|null>(null);
  const projectFormBusy=useRef(false);
  const pendingSessionCopies=useRef(new Map<string,{requestId:string;bundle?:TaskBundle}>());
  const closeProjectForm=()=>{if(!projectFormBusy.current)display.set({projectForm:false});};
  const importBusy=useRef(false);
  const closeImport=()=>{if(!importBusy.current)display.set({importing:false});};
  const focusDraftAfterMenu=useRef(false);
  useEffect(()=>{if(display.page==="settings"||!display.nav)setProjectMenuId(null);},[display.page,display.nav]);
  const [target, setTarget] = useState<
    TaskWorkbenchInspectorTarget | null | undefined
  >();
  const [sourceTarget,setSourceTarget]=useState<TaskSourceSelector|null>(null);
  const [usedSourceId,setUsedSourceId]=useState<string|null>(null);
  const usedSourceTaskId=useRef<string|null>(null);
  const remoteTarget = work.snapshot?.taskWorkbenchViewState.inspectorTarget;
  const inspector = target === undefined ? remoteTarget : target;
  useEffect(()=>{if(files.visible){setTarget(null);setSourceTarget(null);}},[files.visible]);
  useEffect(()=>{if(display.page!=="task"){setSourceTarget(null);setUsedSourceId(null);}},[display.page]);
  useEffect(()=>{if(usedSourceTaskId.current!==work.task?.id)setUsedSourceId(null);if(sourceTarget&&sourceTarget.taskId!==work.task?.id)setSourceTarget(null);},[work.task?.id]);
  const select = (task: TaskRecord, sessionId?: string) => {
    setTarget(null);setSourceTarget(null);setUsedSourceId(null);
    work.select(task, sessionId);
    display.set({
      page: "task",
      overview: work.preferences?.overviewVisible ?? true,
    });
  };
  const projectDraft = (projectId:string|null) => {
    focusDraftAfterMenu.current=true;setProjectMenuId(null);
    setTarget(null);setSourceTarget(null);setUsedSourceId(null);
    files.hideForDraft();
    work.setNewProjectId(projectId);
    work.newTask();
    display.set({ page: "task", overview: false });
    requestAnimationFrame(() =>
      document.querySelector<HTMLTextAreaElement>("[data-composer]")?.focus(),
    );
  };
  const newTask = () => projectDraft(work.newProjectId);
  const returnFromDraft = () => {
    const previous = previousTask.current;
    const task = work.snapshot?.tasks.find(task => task.id === previous?.taskId && task.state !== "archived");
    if (task) select(task, previous?.sessionId);
  };
  const openDetail = (value: TaskWorkbenchInspectorTarget | null) => {
    files.conversation();
    setSourceTarget(null);
    setTarget(value);
    void work.patchView({ inspectorTarget: value }).catch(work.fail);
  };
  const openSource=(selector:TaskSourceSelector)=>{
    files.conversation();
    setSourceTarget(selector);
  };
  useEffect(
    () =>
      api().subscribe((event) => {
        if (event.event === "shell.focusSearch") display.set({ search: true });
        if (event.event === "shell.settings")
          display.set({ page: "settings", settingsPage: "models" });
        if (event.event === "shell.candidateRestored")
          display.set({ page: "settings", settingsPage: "evolution" });
        if (event.event === "shell.newProject") {setProjectEditingId(null);display.set({ projectForm: true });}
        if (event.event === "shell.newTask") {
          focusDraftAfterMenu.current=true;setProjectMenuId(null);
          files.hideForDraft();
          display.set({ page: "task", overview: false });
          setTarget(null);setSourceTarget(null);setUsedSourceId(null);
          requestAnimationFrame(() =>
            document
              .querySelector<HTMLTextAreaElement>("[data-composer]")
              ?.focus(),
          );
        }
      }),
    [display.set,work.newProjectId],
  );
  useEffect(() => {
    if (!work.preferences) return;
    display.set({
      nav: work.preferences.sidebarVisible ?? true,
      overview: work.preferences.overviewVisible ?? true,
    });
  }, [work.preferences?.sidebarVisible, work.preferences?.overviewVisible]);
  const inspiration=useInspiration(work,display.page==="inspiration");
  const ideaSources=work.snapshot?.taskContextSets.find(set=>set.taskId===work.task?.id)?.sources.filter(source=>!!source.inspirationVersion)??[];
  const showingSettings = display.page === "settings";
  if (showingSettings)
    return (<><FileCloseDialog model={files}/>
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
      /></>
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
  return (<TaskSourceReferenceContext.Provider value={display.page==="task"&&work.task?sourceUseId=>{usedSourceTaskId.current=work.task!.id;setUsedSourceId(sourceUseId);}:null}><FileReferenceContext.Provider value={display.page==="task"?reference=>void files.openReference(reference):undefined}>
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
        <nav className="navigation" aria-label={uiText("D Code 导航区")}>
          <div className="window-band drag-region">
            <button
              className="icon-button nav-toggle"
              aria-label={uiText("收起导航区")}
              onClick={() => display.set({ nav: false })}
            >
              <PanelLeft size={16} />
            </button>
          </div>
          {files.navigationVisible?<WorkspaceFileNavigation model={files}/>:<>
          <div className="brand">
            <Logo />
            <span>D Code</span>
          </div>
          <button
            className="nav-row primary-action"
            aria-label={uiText("新建任务")}
            aria-keyshortcuts="Meta+N"
            onClick={newTask}
          >
            <Plus size={17} />
            <span>{uiText("新建任务")}</span>
            <kbd>⌘N</kbd>
          </button>
          <button
            className="nav-row"
            aria-label={uiText("搜索")}
            aria-keyshortcuts="Meta+K"
            onClick={() => display.set({ search: true })}
          >
            <Search size={16} />
            <span>{uiText("搜索")}</span>
            <kbd>⌘K</kbd>
          </button>
          <button className={`nav-row ${display.page==="inspiration"?"selected":""}`} aria-current={display.page==="inspiration"?"page":undefined} onClick={()=>{setTarget(undefined);display.set({page:"inspiration",search:false});}}><Sparkles size={16}/><span>{uiText("灵感")}</span></button>
          <div className="navigation-scroll">
            {tasks.length > 0 && (
              <>
                <div className="nav-heading">{uiText("最近工作")}</div>
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
              <span>{uiText("项目")}</span>
              <button
                className="icon-button"
                aria-label={uiText("新建项目")}
                title={uiText("新建项目 ⇧⌘N")}
                onClick={() => {setProjectEditingId(null);display.set({ projectForm: true });}}
              >
                <Plus size={14} />
              </button>
            </div>
            {work.snapshot?.projects.map((p) => (
              <details className="project-group" key={p.id} open>
                <summary>
                  <ChevronRight size={13} />
                  <Folder size={14} />
                  <span className="project-title" title={p.title}>{p.title}</span>
                  <span className="project-row-actions" onClick={event=>{event.preventDefault();event.stopPropagation();}}>
                    <Menu.Root open={projectMenuId===p.id} onOpenChange={open=>{if(open)focusDraftAfterMenu.current=false;setProjectMenuId(current=>open?p.id:current===p.id?null:current);}}>
                      <Menu.Trigger asChild><button type="button" id={`project-actions-${p.id}`} className="icon-button" aria-label={uiText("更多项目操作 {0}", [p.title])} title={uiText("更多")}><Ellipsis size={15}/></button></Menu.Trigger>
                      <Menu.Portal><Menu.Content className="menu" align="start" sideOffset={4} onCloseAutoFocus={event=>{if(useDisplay.getState().projectForm||focusDraftAfterMenu.current)event.preventDefault();}}>
                        <Menu.Item className="menu-item" onSelect={()=>{setProjectEditingId(p.id);display.set({projectForm:true});}}>{uiText("编辑项目")}</Menu.Item>
                      </Menu.Content></Menu.Portal>
                    </Menu.Root>
                    <button type="button" className="icon-button" aria-label={uiText("查看 {0} 的文件", [p.title])} title={uiText("查看文件")} onClick={()=>{setProjectMenuId(null);files.browseProject(p.id);display.set({page:"task"});}}><Folder size={14}/></button>
                    <button type="button" className="icon-button" aria-label={uiText("在 {0} 中新建任务", [p.title])} title={uiText("新建任务")} onClick={()=>projectDraft(p.id)}><SquarePen size={14}/></button>
                  </span>
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
                <div className="nav-heading">{uiText("任务")}</div>
                {tasks
                  .filter((t) => t.scope.kind === "user")
                  .map((t) => (
                    <TaskRow key={t.id} task={t} active={display.page==="task"} work={work} select={select} />
                  ))}
              </>
            )}
          </div>
          </>}
          <div className="navigation-footer">
            <button
              className="nav-row"
              aria-label={uiText("设置")}
              onClick={() => display.set({ page: "settings" })}
            >
              <Settings size={16} />
              <span>{uiText("设置")}</span>
            </button>
          </div>
        </nav>
      )}
      <main className="workspace" aria-label={uiText("D Code 工作区")}>
        <header
          className={`workspace-bar drag-region ${display.nav ? "" : "without-nav"}`}
        >
          {!display.nav && (
            <button
              className="icon-button"
              aria-label={uiText("显示导航区")}
              onClick={() => display.set({ nav: true })}
            >
              <PanelLeft size={16} />
            </button>
          )}
          <span className="workspace-title" title={display.page === "inspiration" ? uiText("灵感") : (work.task?.title ?? uiText("新任务"))}>
            {display.page === "inspiration" ? uiText("灵感") : (work.task?.title ?? uiText("新任务"))}
          </span>
          {display.page==="task"&&work.task&&work.session?.kind==="child"&&<div className="workspace-session" aria-label={uiText("当前成员对话：{0}", [work.session.title])}><button className="text-button" onClick={()=>select(work.task!)} aria-label={uiText("返回主对话")}>{uiText("主对话")}</button><ChevronRight size={12}/><strong title={work.session.title}>{work.session.title}</strong></div>}
          {actualProject && display.page === "task" && (
            <span className="workspace-context">
              {actualProject.title}
              {git?.branch ? ` · ${git.branch}` : ""}
            </span>
          )}
          {work.task && display.page==="task" && (
            <span className="workspace-context" title={work.task.cwd}>
              {work.task.scope.kind === "user" ? uiText("个人任务") : uiText("工作目录")} · {work.task.cwd}
            </span>
          )}
          {display.page === "task" && newTaskDraft && work.snapshot?.tasks.some(task => task.id === previousTask.current?.taskId && task.state !== "archived") && <button className="text-button" onClick={returnFromDraft}>{uiText("返回任务")}</button>}
          {work.presentation?.nativePaths&&work.presentation.nativePaths.length>1&&display.page==="task"&&<Menu.Root><Menu.Trigger asChild><button className="text-button" aria-label={uiText("对话路径")}>{work.viewingHistory?uiText("历史路径"):uiText("当前路径")}</button></Menu.Trigger><Menu.Portal><Menu.Content className="menu" sideOffset={5}>{work.presentation.nativePaths.map(path=><Menu.Item className="menu-item" key={path.id} onSelect={()=>{work.selectPath(path.isCurrent?undefined:path.id);files.conversation();}}>{path.title}{path.isCurrent?uiText(" · 当前"):""}<small>{new Date(path.createdAt).toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit"})}</small></Menu.Item>)}</Menu.Content></Menu.Portal></Menu.Root>}
          {work.task&&display.page==="task"&&<button className="icon-button" aria-label={uiText("上下文与运行依据")} onClick={()=>setContextOpen(true)}><FileText size={16}/></button>}
          {files.source&&display.page==="task"&&<button className="icon-button" aria-label={uiText("文件与 Git")} aria-pressed={files.navigationVisible&&display.nav} onClick={()=>files.navigationVisible&&display.nav?files.returnToTasks():files.show(!display.nav&&files.navigationVisible)}><Folder size={16}/></button>}
          {!!files.tabs.length&&!files.visible&&display.page==="task"&&<button className="icon-button" aria-label={uiText("打开文件详情")} onClick={files.showInspector}><FileText size={16}/></button>}
          {work.task && display.page==="task" && (
            <Menu.Root>
              <Menu.Trigger asChild>
                <button className="icon-button" aria-label={uiText("任务操作")}>
                  ···
                </button>
              </Menu.Trigger>
              <Menu.Portal>
                <Menu.Content className="menu" align="end">
                  {work.session?.kind === "coordination" && (work.draft.targetAgentRunId||work.draft.pathAction||work.draft.pathDraftBackup||work.draft.images.length ? <Menu.Item className="menu-item" disabled>{uiText("先处理定向、历史续写或未保存图片草稿，再开始新对话")}</Menu.Item> : <Menu.Item className="menu-item" disabled={work.running} onSelect={() => {
                    void (async()=>{
                      const sourceSessionId=work.session!.id;
                      await work.flushDrafts();
                      const bundle=await work.mutateStore<TaskBundle>("task.session.continue", {requestId:`continue-session:${sourceSessionId}`,taskId:work.task!.id });
                      await work.reloadConfirmed();
                      select(bundle.task,bundle.coordinationSession.id);
                    })().catch(work.fail);
                  }}>{uiText("开始新一段对话")}</Menu.Item>)}
                  {(
                    [
                      ["rename", uiText("重命名任务")],
                      ["archive", uiText("归档任务")],
                      ["trash", uiText("移入废纸篓（仅空任务）")],
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
                    onSelect={() => {void (async()=>{
                      const sourceSessionId=work.session!.id;
                      let pending=pendingSessionCopies.current.get(sourceSessionId);
                      if(!pending){pending={requestId:crypto.randomUUID()};pendingSessionCopies.current.set(sourceSessionId,pending);}
                      const bundle=pending.bundle??await work.mutateStore<TaskBundle>("dcodeSession.copy",{requestId:pending.requestId,dcodeSessionId:sourceSessionId});
                      pending.bundle=bundle;
                      await work.reloadConfirmed();
                      select(bundle.task,bundle.coordinationSession.id);
                      pendingSessionCopies.current.delete(sourceSessionId);
                    })().catch(work.fail);}}
                  >
                    {uiText("复制完整会话为新任务")}</Menu.Item>
                </Menu.Content>
              </Menu.Portal>
            </Menu.Root>
          )}
          {display.page === "inspiration" ? (
            <button
              className="text-button"
              onClick={() => {setTarget(undefined);display.set({ page: "task" });}}
            >
              {uiText("返回任务")}</button>
          ) : (
            work.task && display.page==="task" && (
              <button
                className="icon-button"
                aria-label={uiText("任务概览")}
                aria-pressed={display.overview&&!inspector&&!sourceTarget&&!files.visible}
                onClick={() => {
                  if (inspector||sourceTarget||files.visible){setSourceTarget(null);openDetail(null);display.set({overview:true});}
                  else display.set({ overview: !display.overview });
                }}
              >
                <PanelRight size={17} />
              </button>
            )
          )}
        </header>
        {work.loadError&&work.snapshot&&<div className="workspace-refresh-error" role="alert"><span>{uiText("任务暂时无法刷新，当前内容可能已过期。")}</span><button type="button" className="text-button" onClick={()=>void work.reload()}>{uiText("重新读取")}</button></div>}
        {display.page==="task"&&ideaSources.length>0&&<div className="idea-task-context" aria-label={uiText("任务引用的灵感")}><Sparkles size={14}/><span>{uiText("下次运行的灵感")}</span>{ideaSources.map(source=><button type="button" className="idea-context-tag" key={source.id} onClick={()=>openSource({taskId:work.task!.id,contextSourceId:source.id})}>{uiText("查看 ")}{source.title} {uiText(" · 第 ")}{source.inspirationVersion!.revision} {uiText(" 版")}</button>)}</div>}
        {work.loadError&&!work.snapshot ? (
          <div className="workspace-error" role="alert">
            <AlertCircle />
            <h2>{uiText("暂时无法读取任务")}</h2>
            <p>{errorText(work.loadError)}</p>
            <button className="text-button" onClick={() => void work.reload()}>
              {uiText("重试")}</button>
            <button className="text-button" onClick={() => void work.restart()}>
              {uiText("重新连接")}</button>
          </div>
        ) : !work.snapshot ? (
          <LoadingPlaceholder label={uiText("正在读取工作台…")}/>
        ) : display.page==="inspiration" ? <InspirationWorkspace model={inspiration} pathForFile={file=>api().getPathForFile(file)} canSaveFromTask={!!work.task}/> : (
          <div className={`work-area ${inspector||sourceTarget||files.visible ? "with-inspector" : ""} ${showNewTask ? "new-task-stage" : ""} ${files.expanded ? "file-expanded" : ""}`}>
            {showNewTask && !files.expanded && <NewTaskScene />}
            <section className={`conversation-space ${showNewTask ? "new-conversation" : ""}`} inert={files.expanded||undefined} aria-hidden={files.expanded||undefined} onKeyDown={event => {
              if (showNewTask && event.key === "Escape" && !event.defaultPrevented && !event.nativeEvent.isComposing && !event.currentTarget.querySelector('[role="listbox"]')) returnFromDraft();
            }}>
              {<Transcript key={work.session?.id ?? "new"} work={work} emptyBrand={<Logo />} onOpenSummarySource={()=>display.set({overview:false})} onSaveInspiration={text=>{inspiration.begin("text",{title:text.trim().split("\n")[0]?.slice(0,80)||uiText("新灵感"),markdown:text,...(work.task?{sourceTaskId:work.task.id}:{})});setTarget(undefined);display.set({page:"inspiration"});}} />}
              <div className="reading-lane">
                <ExtensionRequests work={work}/>
                {work.session?.kind === "standard" ? <button className="text-button" onClick={() => select(work.task!)}>{uiText("返回当前主对话")}</button> : <Composer
                  work={work}
                  models={models}
                  pathForFile={(file)=>api().getPathForFile(file)}
                  onSettings={() => display.set({ page: "settings" })}
                  onCommandMenuChange={setCommandMenuOpen}
                  workflowOpenSignal={workflowOpenSignal}
                  onWorkflowSignalConsumed={()=>setWorkflowOpenSignal(0)}
                />}
              </div>
            </section>
            <AnimatePresence>
              {work.task && display.overview && !inspector && !files.visible && (
                <motion.aside
                  aria-label={uiText("任务概览")}
                  className="overview"
                  initial={{ opacity: 0, y: reduced ? 0 : -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: reduced ? 0 : uiMotion.standard, ease: uiMotion.glide }}
                >
                  <Overview
                    key={work.task.id}
                    work={work}
                    onClose={() => display.set({ overview: false })}
                    onSelect={select}
                    onDetail={openDetail}
                    onWorkflow={()=>{setWorkflowOpenSignal(value=>value+1);display.set({overview:false});}}
                  />
                </motion.aside>
              )}
            </AnimatePresence>
            {files.visible&&!files.expanded&&<button type="button" className="inspector-scrim" aria-label={uiText("关闭文件覆盖层")} onClick={files.conversation}/>}
            {(files.tabs.length>0||files.notice)&&<aside className={`inspector file-inspector ${files.expanded?"is-expanded":""}`} aria-label={uiText("文件详情")} hidden={!files.visible}>
              <div className="panel-heading"><strong>{uiText("文件")}</strong><span className="spacer"/>{files.active&&<button id="file-size-toggle" className={files.expanded?"text-button":"icon-button"} aria-label={files.expanded?uiText("返回对话"):uiText("展开文件内容")} aria-expanded={files.expanded} title={files.expanded?uiText("返回对话"):uiText("展开文件内容")} onClick={()=>{if(files.expanded){files.collapse();requestAnimationFrame(()=>document.querySelector<HTMLTextAreaElement>("[data-composer]")?.focus({preventScroll:true}));}else{files.expand();requestAnimationFrame(()=>document.getElementById("file-size-toggle")?.focus({preventScroll:true}));}}}>{files.expanded?<><Minimize2 size={15}/>{uiText("返回对话")}</>:<Maximize2 size={15}/>}</button>}<button className="icon-button" aria-label={uiText("收起文件详情")} onClick={files.conversation}><X size={15}/></button></div>
              <WorkspaceFiles model={files} work={work} overlay={contextOpen||commandMenuOpen||!!projectMenuId||display.search||display.importing||display.projectForm||!!taskAction}/>
            </aside>}
            {sourceTarget&&work.task?.id===sourceTarget.taskId&&!files.visible&&<SourceDetail selector={sourceTarget} onClose={()=>setSourceTarget(null)}/>}
            {inspector && !sourceTarget && !files.visible && (
              <Inspector
                target={inspector}
                snapshot={work.snapshot}
                taskId={work.task?.id ?? null}
                onOpenArtifact={id=>{openDetail(null);void files.openArtifact(id);}}
                onClose={() => openDetail(null)}
              />
            )}
          </div>
        )}
        {work.hostDead && (
          <div className="recovery" role="alert">
            <AlertCircle size={20} />
            <strong>{uiText("运行服务已退出")}</strong>
            <p>{uiText("任务记录已保留。重新连接后可继续工作。")}</p>
            {work.error && <p>{work.error}</p>}
            <button
              className="primary-button"
              disabled={work.restarting}
              onClick={() => void work.restart()}
            >
              {work.restarting ? uiText("正在重新连接…") : uiText("重新连接")}
            </button>
          </div>
        )}
      </main>
      {taskAction && (
        <Overlay
          label={taskAction.action === "rename" ? uiText("重命名任务") : uiText("归档任务")}
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
                  ? uiText("重命名任务")
                  : taskAction.action === "trash"
                    ? uiText("将空任务移入废纸篓")
                    : uiText("归档任务")}
              </strong>
            </div>
            <div className="form-fields">
              {taskAction.action === "rename" ? (
                <label>
                  {uiText("任务名称")}<input
                    data-dialog-initial-focus
                    required
                    maxLength={200}
                    value={taskTitle}
                    disabled={taskActionBusy}
                    onChange={(e) => setTaskTitle(e.target.value)}
                  />
                </label>
              ) : (
                <p>“{taskTitle}{uiText("”的记录会保留，可从设置中的已归档任务恢复。")}</p>
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
                {uiText("取消")}</button>
              <button
                className="primary-button"
                disabled={taskActionBusy || !taskTitle.trim()}
              >
                {taskActionBusy ? uiText("正在保存…") : uiText("确认")}
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
          label={uiText("导入 Pi 会话")}
          onClose={closeImport}
        >
          <ImportPanel
            onClose={closeImport}
            onBusyChange={busy=>{importBusy.current=busy;}}
            onImported={async (bundle) => {
              await work.reloadConfirmed();
              select(bundle.task, bundle.coordinationSession.id);
            }}
            userId={work.snapshot.currentUser.id}
            mutateStore={work.mutateStore}
          />
        </Overlay>
      )}
      {display.projectForm && (
        <Overlay
          label={projectEditingId?uiText("编辑项目"):uiText("新建项目")}
          returnFocus={projectEditingId?()=>document.getElementById(`project-actions-${projectEditingId}`):undefined}
          onClose={closeProjectForm}
        >
          <ProjectForm
            key={projectEditingId??"new"}
            work={work}
            project={work.snapshot?.projects.find(project=>project.id===projectEditingId)}
            beforeDirectoryChange={files.beforeProjectDirectoryChange}
            afterDirectoryChange={files.invalidateProject}
            onClose={closeProjectForm}
            onBusyChange={busy=>{projectFormBusy.current=busy;}}
          />
        </Overlay>
      )}
      {contextOpen&&work.task&&<Overlay label={uiText("上下文与运行依据")} onClose={()=>setContextOpen(false)}><div className="panel-heading"><strong>{uiText("上下文与运行依据")}</strong><button className="icon-button" aria-label={uiText("关闭上下文")} onClick={()=>setContextOpen(false)}><X size={15}/></button></div><TaskContext key={work.task.id} work={work}/></Overlay>}
      {usedSourceId&&work.task&&usedSourceTaskId.current===work.task.id&&<Overlay label={uiText("已用来源")} onClose={()=>setUsedSourceId(null)}><div className="panel-heading"><strong>{uiText("已用来源")}</strong><button className="icon-button" aria-label={uiText("关闭来源")} onClick={()=>setUsedSourceId(null)}><X size={15}/></button></div><UsedSourceDetail key={`${work.task.id}:${usedSourceId}`} taskId={work.task.id} sourceUseId={usedSourceId} onOpenSession={sessionId=>{setUsedSourceId(null);select(work.task!,sessionId);}}/></Overlay>}
      <FileCloseDialog model={files}/>
    </div></FileReferenceContext.Provider></TaskSourceReferenceContext.Provider>
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
  const childDisclosure=useRef<HTMLDetailsElement>(null);
  useEffect(()=>{if(active&&work.task?.id===task.id&&work.session?.kind==="child"&&childDisclosure.current)childDisclosure.current.open=true;},[active,task.id,work.task?.id,work.session?.id]);
  const children =
    work.snapshot?.sessions.filter(
      (s) => s.taskId === task.id && s.kind === "child",
    ) ?? [];
  const history = work.snapshot?.sessions.filter(s => s.taskId === task.id && s.kind === "standard") ?? [];
  const failed = work.snapshot?.sessionRuns
    .filter((run) => run.taskId === task.id)
    .at(-1)?.status;
  return (
    <div>
      <button
        className="nav-row task-row"
        aria-current={!recent && active && work.task?.id === task.id && work.session?.kind!=="child" ? "page" : undefined}
        onClick={() => select(task)}
      >
        <span>{task.title}</span>
        {failed && ["failed", "interrupted", "unknown"].includes(failed) && (
          <AlertCircle size={13} aria-label={uiText("执行需要处理")} />
        )}
        {recent && <small>{relativeTime(task.updatedAt)}</small>}
      </button>
      {!recent && children.length > 0 && (
        <details className="child-sessions" ref={childDisclosure}>
          <summary>
            <ChevronRight size={12} />
            <span>{uiText("子会话")}</span>
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
      {history.length > 0 && <details className="child-sessions"><summary><ChevronRight size={12}/><span>{uiText("历史对话")}</span><small>{history.length}</small></summary>{history.map(session => <button className="nav-row" key={session.id} aria-current={active && work.session?.id === session.id ? "page" : undefined} onClick={() => select(task, session.id)}><MessageSquare size={12}/><span>{session.title}</span></button>)}</details>}
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
        ? uiText("{0} 小时 {1} 分", [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60)])
        : seconds >= 60
          ? uiText("{0} 分 {1} 秒", [Math.floor(seconds / 60), seconds % 60])
          : uiText("{0} 秒", [seconds]);
  const items =
    work.snapshot?.taskWorkItems.filter(
      (item) => item.taskId === work.task?.id,
    ) ?? [];
  return (
    <p className="run-statistics">
      {elapsed && (
        <span>
          {work.running ? uiText("运行中") : uiText("本次执行")} · {elapsed}
        </span>
      )}
      <span>
        {uiText("消息")}{" "}
        {work.presentation?.inspection?.context.messageCount ??
          work.imported.length}
      </span>
      <span>
        {uiText("工作项 ")}{items.filter((item) => item.state === "completed").length} /{" "}
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
  onWorkflow,
}: {
  work: Workbench;
  onClose: () => void;
  onSelect: (task: TaskRecord, sessionId?: string) => void;
  onDetail: (target: TaskWorkbenchInspectorTarget) => void;
  onWorkflow: () => void;
}) {
  const snapshot = work.snapshot!;
  const task = work.task!;
  const [reviewDetail,setReviewDetail]=useState<{id:string;path:string;digest:string;baseHead:string;round:number;diff:string}|null>(null);
  const [reviewError,setReviewError]=useState("");
  const reviewRequest=useRef(0);
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
      {expanded.includes(id) && <div className="overview-content">{content}</div>}
    </div>
  );
  const items = snapshot.taskWorkItems.filter((i) => i.taskId === task.id);
  const reviews = snapshot.taskReviewRequests.filter(review => review.taskId === task.id);
  const reviewRound=(review:(typeof reviews)[number])=>reviews.filter(item=>item.path===review.path&&item.staged===review.staged).findIndex(item=>item.id===review.id)+1;
  const openReview=(review:(typeof reviews)[number])=>{const request=++reviewRequest.current;setReviewDetail(null);setReviewError("");void api().request<{diff:string}>("task.review.read",{taskId:task.id,reviewId:review.id}).then(result=>{if(request===reviewRequest.current)setReviewDetail({id:review.id,path:review.path,digest:review.digest,baseHead:review.baseHead,round:reviewRound(review),diff:result.diff});}).catch(reason=>{if(request===reviewRequest.current)setReviewError(errorText(reason));});};
  const requests = snapshot.agentRequests.filter(
    (r) => r.taskId === task.id && r.status === "open",
  );
  const artifacts = snapshot.artifacts.filter((a) => a.taskId === task.id && a.kind !== "attachment");
  const reports = snapshot.agentReports.filter((r) => r.taskId === task.id);
  const activeWorkflowRun=snapshot.taskWorkflowRuns.find(run=>run.taskId===task.id&&run.status==="active");
  const workflow=activeWorkflowRun?snapshot.taskWorkflows.find(item=>item.id===activeWorkflowRun.workflowId):snapshot.taskWorkflows.filter(item=>item.taskId===task.id).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0];
  const workflowRun=activeWorkflowRun??snapshot.taskWorkflowRuns.filter(run=>run.workflowId===workflow?.id).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0];
  const workflowVersion=workflow?snapshot.taskWorkflowVersions.find(item=>item.workflowId===workflow.id&&item.version===(workflowRun?.version??workflow.currentVersion)):undefined;
  const workflowStages=workflow?snapshot.taskWorkflowStages.filter(stage=>stage.workflowId===workflow.id&&stage.version===(workflowRun?.version??workflow.currentVersion)).sort((a,b)=>a.ordinal-b.ordinal):[];
  const stageWork=(stageId:string)=>{const binding=snapshot.taskWorkflowWorkItems.find(item=>item.runId===workflowRun?.id&&item.stageId===stageId);return binding?snapshot.taskWorkItems.find(item=>item.id===binding.workItemId):undefined;};
  const completedWorkflowStages=workflowStages.filter(stage=>stageWork(stage.id)?.state==="completed").length;
  const currentWorkflowStage=workflowStages.find(stage=>stageWork(stage.id)?.state!=="completed")??workflowStages.at(-1);
  const currentWorkflowWork=currentWorkflowStage?stageWork(currentWorkflowStage.id):undefined;
  const workflowMembers=workflowRun&&currentWorkflowStage?snapshot.agentAssignments.filter(assignment=>{const binding=(assignment.taskPacket as {workflowBinding?:{workflowRunId?:string;stageId?:string}}|undefined)?.workflowBinding;return binding?.workflowRunId===workflowRun.id&&binding.stageId===currentWorkflowStage.id;}).map(assignment=>snapshot.agentRuns.find(run=>run.id===assignment.agentRunId)).filter((run):run is NonNullable<typeof run>=>!!run):[];
  const workflowMemberNames=workflowMembers.map(run=>snapshot.sessions.find(session=>session.id===run.sessionId)?.title??run.id.slice(-6));
  const workflowReportCount=workflowRun?snapshot.agentReports.filter(report=>report.taskId===task.id&&workflowMembers.some(run=>run.id===report.agentRunId)).length:0;
  const workflowNext=workflowRun?.status==="completed"?uiText("查看整体报告；任务仍需单独验收"):workflowRun?.status==="stopped"?uiText("核对在途结果后继续"):workflowRun?.status==="interrupted"?uiText("核对中断结果后继续"):!workflowStages.length?uiText("等待协调者形成阶段"):currentWorkflowWork?.state==="blocked"?uiText("处理阶段阻塞与返工"):completedWorkflowStages===workflowStages.length?uiText("核对证据并形成整体报告"):!currentWorkflowWork?uiText("等待协调者派发当前阶段"):uiText("等待成员结果与独立验收");
  return (
    <>
      <div className="panel-heading">
        <strong>{uiText("任务概览")}</strong>
        <button
          className="icon-button"
          aria-label={uiText("关闭任务概览")}
          onClick={onClose}
        >
          <X size={14} />
        </button>
      </div>
      {section(
        "progress",
        uiText("进度"),
        <>
          <p>{task.goal}</p>
          <TaskRouteSummary snapshot={snapshot} taskId={task.id} onMember={sessionId => onSelect(task, sessionId)} />
          {workflow&&<div className="overview-workflow"><div><strong>{uiText("工作流 · ")}{workflowRun?workflowRun.status==="active"?uiText("进行中"):workflowRun.status==="stopped"?uiText("已停止后续推进"):workflowRun.status==="interrupted"?uiText("中断待核对"):uiText("已完成"):uiText("待开始")}</strong><button type="button" className="text-button" onClick={onWorkflow}>{uiText("查看工作流")}</button></div><p>{workflowVersion?.goal??uiText("正在读取安排")}</p><p>{uiText("当前阶段：")}{currentWorkflowStage?.title??uiText("尚未形成")}{currentWorkflowWork?` · ${stateLabel(currentWorkflowWork.state)}`:""}</p>{workflowRun?.reason&&<p>{uiText("原因：")}{workflowRun.reason}</p>}<p>{uiText("成员：")}{workflowMemberNames.length?workflowMemberNames.join("、"):uiText("待派发")}</p><p>{uiText("已验收阶段 ")}{completedWorkflowStages}/{workflowStages.length} {uiText(" · 当前阶段成员报告 ")}{workflowReportCount}</p><p>{uiText("下一步：")}{workflowNext}</p></div>}
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
            <p className="secondary">{uiText("尚未制定工作清单")}</p>
          )}
          {reviews.length>0&&<div className="task-reviews"><strong>{uiText("审查")}</strong><ul>{reviews.map(review=>{const verification=snapshot.verifications?.filter(record=>record.subjectReviewId===review.id).at(-1);const checked=verification&&snapshot.coordinatorReviews?.find(item=>item.verificationId===verification.id);return <li key={review.id}><button className="text-button" onClick={()=>openReview(review)}>{review.path} {uiText(" · 第 ")}{reviewRound(review)} {uiText(" 次 · ")}{review.digest.slice(7,15)}</button><small>{checked?checked.outcome==="accepted"?uiText("协调复核通过"):checked.outcome==="rework"?uiText("需要返工"):uiText("需要复查"):verification?verification.verdict==="pass"?uiText("独立检查通过，待复核"):uiText("发现问题，待复核"):uiText("待独立检查")}</small></li>;})}</ul>{reviewError&&<p role="alert" className="inline-error">{reviewError}</p>}{reviewDetail&&<div className="task-review-snapshot"><div><strong>{reviewDetail.path} {uiText(" · 第 ")}{reviewDetail.round} {uiText(" 次审查的差异")}</strong><button className="text-button" onClick={()=>{reviewRequest.current++;setReviewDetail(null);}}>{uiText("关闭")}</button></div><pre>{reviewDetail.diff}</pre><details><summary>{uiText("审查身份")}</summary><p className="secondary">{reviewDetail.id} · {reviewDetail.digest} · HEAD {reviewDetail.baseHead}</p></details></div>}</div>}
        </>,
      )}
      {section(
        "team",
        uiText("团队"),
        <><AuxiliaryActivities work={work} taskWide/><TeamOverview snapshot={snapshot} task={task} onSelect={sessionId => onSelect(task, sessionId)} onDetail={onDetail}/></>,
      )}
      {section(
        "waiting",
        uiText("等待处理{0}", [requests.length ? ` · ${requests.length}` : ""]),
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
          <p className="secondary">{uiText("没有等待事项")}</p>
        ),
      )}
      {section(
        "deliverables",
        uiText("交付物"),
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
                  {r.reportKind==="verification"?uiText("验收报告"):r.reportKind==="coordinator"?uiText("综合报告"):uiText("成员报告")} · {snapshot.sessions.find(session=>session.id===snapshot.agentRuns.find(run=>run.id===r.agentRunId)?.sessionId)?.title??uiText("成员")}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="secondary">{uiText("尚无交付物")}</p>
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
            aria-label={uiText("验收反馈")}
            placeholder={uiText("需要调整的地方（可选）")}
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            maxLength={20000}
          />
          <button
            className="text-button"
            disabled={busy}
            onClick={() => void respond()}
          >
            {uiText("验收通过")}</button>
          <button
            className="text-button"
            disabled={busy || !feedback.trim()}
            onClick={() => void respond(undefined, true)}
          >
            {uiText("提交反馈")}</button>
        </>
      )}
    </div>
  );
}

function Inspector({
  target,
  snapshot,
  taskId,
  onOpenArtifact,
  onClose,
}: {
  target: TaskWorkbenchInspectorTarget;
  snapshot: FoundationSnapshot;
  taskId: string | null;
  onOpenArtifact:(id:string)=>void;
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
  const verification=target.kind==="report"?snapshot.verifications?.find(record=>record.id===target.id&&record.taskId===taskId):undefined;
  const review=verification?snapshot.coordinatorReviews?.find(record=>record.verificationId===verification.id):undefined;
  const title = verification ? uiText("验收报告") :
    item && "title" in item
      ? item.title
      : target.kind === "report"
        ? uiText("执行报告")
        : uiText("记录详情");
  const content =
    item && "body" in item
      ? item.body
      : item && "metadata" in item
        ? item.metadata
        : item && "payload" in item
          ? item.payload
          : null;
  return (
    <aside className="inspector" aria-label={uiText("对象详情")}>
      <div className="panel-heading">
        <strong>{title}</strong>
        <button className="icon-button" aria-label={uiText("关闭详情")} onClick={onClose}>
          <X size={15} />
        </button>
      </div>
      <div className="inspector-content">
        {item || verification ? (
          <>
            {verification&&<><p>{verification.verdict==="pass"?uiText("独立验收通过"):uiText("独立验收未通过")} · {review?({accepted:uiText("协调复核通过"),rework:uiText("已安排返工"),recheck:uiText("已安排复验")})[review.outcome]:uiText("待协调者复核")}</p><Markdown text={verification.summary}/>{verification.findings.length>0&&<ul>{verification.findings.map((finding,index)=><li key={index}>{finding.kind==="product"?uiText("成果问题"):uiText("验收依据")}：{finding.description}</li>)}</ul>}{review&&<Markdown text={review.reason}/>}<p className="secondary">{verification.evidenceIds.length} {uiText(" 项独立检查记录")}</p></>}
            {!verification&&content != null && (
              <Markdown
                text={
                  typeof content === "string"
                    ? content
                    : typeof content==="object"&&content!==null&&"text" in content&&typeof content.text==="string"?content.text:uiText("记录已保存，可在相关产物与执行过程查看详情。")
                }
              />
            )}{" "}
            {target.kind==="artifact"&&item&&("managedPath" in item&&item.managedPath||"externalPath" in item&&item.externalPath)&&<button className="primary-button" onClick={()=>onOpenArtifact(item.id)}>{uiText("打开产物")}</button>}
            {item && "managedPath" in item && item.managedPath && (
              <p className="source-path">{item.managedPath}</p>
            )}
            {item && "externalPath" in item && item.externalPath && (
              <p className="source-path">{item.externalPath}</p>
            )}
          </>
        ) : (
          <p>{uiText("此记录已不可用。关闭后可选择其他交付物。")}</p>
        )}
      </div>
    </aside>
  );
}
function Overlay({
  label,
  onClose,
  children,
  returnFocus,
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
  returnFocus?:()=>HTMLElement|null;
}) {
  const panel=useModalFocus<HTMLDivElement>({onClose,returnFocus});
  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
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
    <Overlay label={uiText("搜索任务")} onClose={onClose}>
      <div className="panel-heading input-surface">
        <Search size={17} />
        <input
          data-dialog-initial-focus
          aria-label={uiText("搜索任务与消息")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={uiText("搜索任务与消息…")}
        />
        <button className="icon-button" aria-label={uiText("关闭搜索")} onClick={onClose}>
          <X size={15} />
        </button>
      </div>
      <div className="search-results">
        {error && (
          <p role="alert" className="inline-error">
            {uiText("消息搜索暂不可用：")}{error}
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
              ? uiText("正在搜索…")
              : query
                ? uiText("没有匹配结果")
                : uiText("输入关键词查找任务和消息")}
          </p>
        )}
      </div>
    </Overlay>
  );
}
function ProjectForm({
  work,project,beforeDirectoryChange,afterDirectoryChange,
  onClose,onBusyChange,
}: {
  work: Workbench;
  project?:FoundationSnapshot["projects"][number];
  beforeDirectoryChange:(projectId:string,targetDirectory:string,moveFiles:boolean)=>void;
  afterDirectoryChange:(projectId:string,targetDirectory:string,moveFiles:boolean)=>void;
  onClose: () => void;
  onBusyChange:(busy:boolean)=>void;
}) {
  const initial=useRef(project);
  const [title, setTitle] = useState(project?.title??"");
  const [directory, setDirectory] = useState(project?.directory??"");
  const [moveFiles,setMoveFiles]=useState(false);
  const [busy, setBusy] = useState(false);
  const [savedRemotely,setSavedRemotely]=useState(false);
  const saving=useRef(false);
  const pendingWrite=useRef<{requestId:string;project?:{id:string};directoryChangeApplied?:boolean}|null>(null);
  const [error, setError] = useState<string | null>(null);
  const create = async () => {
    if (!title.trim() || !directory || saving.current) return;
    saving.current=true;
    setBusy(true);
    onBusyChange(true);
    let completed=false;
    try {
      const changed=!!initial.current&&directory!==initial.current.directory;
      const pending=pendingWrite.current??{requestId:crypto.randomUUID()};
      pendingWrite.current=pending;
      if(changed&&!pending.project)beforeDirectoryChange(initial.current!.id,directory,moveFiles);
      const result=pending.project?{project:pending.project}:initial.current?await api().request<{project:{id:string}}>("project.update",{requestId:pending.requestId,projectId:initial.current.id,expectedProjectRevision:initial.current.revision,title:title.trim(),directory,moveFiles:changed&&moveFiles}):await work.mutateStore<{ project: { id: string } }>("project.create",{requestId:pending.requestId,title:title.trim(),directory});
      pending.project=result.project;
      setSavedRemotely(true);
      if(changed&&!pending.directoryChangeApplied){afterDirectoryChange(initial.current!.id,directory,moveFiles);pending.directoryChangeApplied=true;}
      await work.reloadConfirmed();
      await work.refreshPresentation();
      if(!initial.current){work.setNewProjectId(result.project.id);work.newTask();}
      useDisplay.getState().set({ page: "task" });
      pendingWrite.current=null;
      completed=true;
    } catch (e) {
      setError(pendingWrite.current?.project?uiText("项目已保存，但界面尚未确认刷新：{0}。请重新读取，勿重复创建。", [errorText(e)]):errorText(e));
    } finally {
      saving.current=false;
      onBusyChange(false);
      setBusy(false);
      if(completed)onClose();
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
        <strong>{project?uiText("编辑项目"):uiText("新建项目")}</strong>
        <button
          type="button"
          className="icon-button"
          aria-label={uiText("关闭")}
          onClick={onClose}
          disabled={busy}
        >
          <X size={15} />
        </button>
      </div>
      <div className="form-fields">
        <label>
          {uiText("项目名称")}<input
            data-dialog-initial-focus
            value={title}
            disabled={busy||savedRemotely}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
          />
        </label>
        <label>
          {uiText("项目文件夹")}<button
            type="button"
            className="folder-picker"
            disabled={busy||savedRemotely}
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
            {directory || uiText("选择文件夹…")}
          </button>
        </label>
        {project&&directory!==initial.current?.directory&&<><p className="secondary">{uiText("任务与对话会保留，后续工作使用新目录。")}</p><label className="checkbox-label"><input type="checkbox" checked={moveFiles} disabled={busy||savedRemotely} onChange={event=>setMoveFiles(event.target.checked)}/>{uiText("同时移动项目文件")}</label>{moveFiles&&<p className="secondary">{uiText("目标需为同一磁盘上的空文件夹，已有文件不会被合并或覆盖。")}</p>}</>}
        {project&&work.snapshot?.projectDirectoryChanges?.filter(change=>change.projectId===project.id&&["prepared","unknown"].includes(change.status)).map(change=><div role="alert" key={change.id}><p>{change.error??uiText("目录更换尚未完成")}</p><p className="source-path">{change.sourceDirectory} → {change.targetDirectory}</p><button type="button" className="text-button" disabled={busy} onClick={()=>void api().request("project.recover",{projectId:project.id}).then(()=>work.reload()).catch(error=>setError(errorText(error)))}>{uiText("重新核对目录状态")}</button></div>)}
        {error && <p role="alert">{error}</p>}
      </div>
      <div className="dialog-actions">
        <button type="button" className="text-button" onClick={onClose} disabled={busy}>
          {uiText("取消")}</button>
        <button
          className="primary-button"
          disabled={!title.trim() || !directory || busy}
        >
          {busy ? uiText("正在保存…") : savedRemotely?uiText("重新读取已保存项目"):project?uiText("保存项目"):uiText("创建项目")}
        </button>
      </div>
    </form>
  );
}
