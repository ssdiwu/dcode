// 侧栏树：工作空间（根节点，始终可见）→ 任务（两级）→ 会话（单任务手风琴）。
// 树的展开/收起与选择都是纯导航，不改变任何执行状态。

import { useMemo, useRef, useState } from "react";
import { ChevronRight, FolderClosed, MoreHorizontal, Plus, Settings as SettingsIcon } from "lucide-react";
import type { AppSnapshot, CreatedTask, Session, Task, TaskCreationIntent, Workspace, WorkspaceCreationIntent } from "@/contracts";
import { Button, IconButton } from "../components/Button";
import { useT } from "../i18n";
import { Badge } from "../components/Badge";
import { Menu } from "../components/Menu";
import { WorkspaceDialog } from "../components/WorkspaceDialog";
import { TaskDialog } from "../components/TaskDialog";

export interface SidebarSelection {
  sessionId: string | null;
  draftTaskId: string | null;
}

// 只保存用户这次表单的身份与原文，供回执丢失后的只读查回；
// 是否真正创建仍只取应用快照与 lookupTaskCreation，不把本地记录当产品对象。
const TASK_INTENT_KEY = "dcode-task-creation-ui-v1";
function validTaskCreationIntent(value: unknown): TaskCreationIntent | null {
  if (!value || typeof value !== "object") return null;
  const intent = value as Partial<TaskCreationIntent>;
  if (typeof intent.operationId !== "string" || !intent.operationId || typeof intent.workspaceId !== "string" || !intent.workspaceId
    || typeof intent.title !== "string" || !intent.title.trim() || intent.title.length > 120 || /[\u0000-\u001f]/u.test(intent.title)) return null;
  return { operationId: intent.operationId, workspaceId: intent.workspaceId, title: intent.title };
}
function loadTaskCreationIntents(): TaskCreationIntent[] {
  try {
    const raw = localStorage.getItem(TASK_INTENT_KEY);
    if (!raw) return [];
    const value: unknown = JSON.parse(raw);
    const candidates = Array.isArray(value) ? value : [value];
    const intents = candidates.map(validTaskCreationIntent).filter((intent): intent is TaskCreationIntent => intent !== null);
    return [...new Map(intents.map((intent) => [intent.operationId, intent])).values()];
  } catch { return []; }
}

export function Sidebar({
  snapshot,
  selection,
  expandedWorkspaceIds,
  expandedTaskIds,
  expandedTaskId,
  onSelectSession,
  onSelectDraft,
  onToggleWorkspace,
  onToggleTaskChildren,
  onExpandTask,
  onOpenSettings,
  onNewDraft,
  onTaskCreated,
  onMoveTask,
  onWorkspaceCreated,
}: {
  snapshot: AppSnapshot;
  selection: SidebarSelection;
  expandedWorkspaceIds: string[];
  expandedTaskIds: string[];
  expandedTaskId: string | null;
  onSelectSession: (sessionId: string) => void;
  onSelectDraft: (taskId: string) => void;
  onToggleWorkspace: (workspaceId: string) => void;
  onToggleTaskChildren: (taskId: string) => void;
  onExpandTask: (taskId: string | null) => void;
  onOpenSettings: () => void;
  onNewDraft: (workspaceId: string, parentTaskId: string | null) => void;
  onTaskCreated: (task: CreatedTask) => void;
  onMoveTask: (taskId: string, targetWorkspaceId: string) => void;
  onWorkspaceCreated: (workspace: Workspace) => void;
}) {
  const t = useT();
  const [newTaskFor, setNewTaskFor] = useState<{ workspaceId: string; initialIntent?: TaskCreationIntent | null } | null>(null);
  const [newWorkspace, setNewWorkspace] = useState(false);
  const [workspaceIntent, setWorkspaceIntent] = useState<WorkspaceCreationIntent | null>(null);
  const [heldTaskIntents, setHeldTaskIntents] = useState<TaskCreationIntent[]>(loadTaskCreationIntents);
  const heldTaskIntentsRef = useRef(heldTaskIntents);
  const taskDialogTrigger = useRef<HTMLElement | null>(null);
  const pendingTaskIntents = snapshot.pendingTaskCreation
    ? [snapshot.pendingTaskCreation, ...heldTaskIntents.filter((intent) => intent.operationId !== snapshot.pendingTaskCreation?.operationId)]
    : heldTaskIntents;

  const updateTaskIntent = (intent: TaskCreationIntent | null, operationId: string): boolean => {
    const next = heldTaskIntentsRef.current.filter((item) => item.operationId !== operationId);
    if (intent) next.push(intent);
    try {
      if (next.length) localStorage.setItem(TASK_INTENT_KEY, JSON.stringify(next));
      else localStorage.removeItem(TASK_INTENT_KEY);
      heldTaskIntentsRef.current = next;
      setHeldTaskIntents(next);
      return true;
    } catch {
      window.dispatchEvent(new CustomEvent("dcode:draft-persist-failed"));
      return false;
    }
  };

  const sessionsByTask = useMemo(() => {
    const map = new Map<string, Session[]>();
    for (const session of snapshot.sessions) {
      const list = map.get(session.taskId) ?? [];
      list.push(session);
      map.set(session.taskId, list);
    }
    for (const list of map.values()) list.sort((a, b) => b.updatedAt - a.updatedAt);
    return map;
  }, [snapshot.sessions]);

  const tasksByWorkspace = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const task of snapshot.tasks) {
      if (task.parentId) continue;
      const list = map.get(task.workspaceId) ?? [];
      list.push(task);
      map.set(task.workspaceId, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || b.updatedAt - a.updatedAt);
    }
    return map;
  }, [snapshot.tasks]);

  // 任务操作菜单项（N07）：移动到其他空间；当前所属空间不作为重复目标
  const taskMenuItems = (task: Task) =>
    snapshot.workspaces
      .filter((w) => w.id !== task.workspaceId)
      .map((w) => ({
        label: t("nav.moveTo", { name: w.name }),
        onSelect: () => onMoveTask(task.id, w.id),
      }));

  const childTasks = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const task of snapshot.tasks) {
      if (!task.parentId) continue;
      const list = map.get(task.parentId) ?? [];
      list.push(task);
      map.set(task.parentId, list);
    }
    return map;
  }, [snapshot.tasks]);

  const taskRow = (task: Task, depth: number) => {
    const sessions = sessionsByTask.get(task.id) ?? [];
    const mainSession = sessions.find((session) => session.kind === "main");
    const memberSessions = sessions.filter((session) => session.kind === "sub");
    const children = childTasks.get(task.id) ?? [];
    const hasSessions = memberSessions.length > 0;
    const hasChildren = children.length > 0;
    const expandable = hasSessions || hasChildren;
    // 会话列表是单手风琴；子任务展开是独立的多选集合
    const sessionsExpanded = hasSessions && expandedTaskId === task.id;
    const childrenExpanded = expandedTaskIds.includes(task.id);
    const expanded = sessionsExpanded || childrenExpanded;
    const selected = selection.draftTaskId === task.id || selection.sessionId === mainSession?.id;
    const run = sessions.map((s) => snapshot.runs[s.id]).find((r) => r && r.status === "running");

    return (
      <div key={task.id}>
        <div
          role="treeitem"
          data-task-id={task.id}
          aria-label={task.isDefault ? t("nav.defaultTask") : task.title}
          aria-expanded={expandable ? expanded : undefined}
          // 键盘可达性：可点击目标须可聚焦并可用 Enter/Space 触发（主树 DESIGN 键盘路径要求）
          tabIndex={0}
          onKeyDown={(event) => {
            // 只响应行自身的键盘事件：子控件（新建按钮/任务菜单）的 Enter/Space 冒泡不得误触父行
            if (event.target !== event.currentTarget) return;
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              event.currentTarget.click();
            }
          }}
          className={`group relative flex items-center gap-1 h-7 rounded-md pr-1 cursor-default select-none ${
            selected ? "bg-selected" : "hover:bg-hover"
          }`}
          style={{ paddingLeft: `calc(${10 + depth * 14}px * var(--ui-scale))` }}
          onClick={() => {
            // 任务名称始终定位主会话；展开由独立箭头承担，不能被最近更新的成员会话抢走。
            if (mainSession) onSelectSession(mainSession.id);
            else onSelectDraft(task.id);
          }}
        >
          {expandable ? (
            <button
              type="button"
              aria-label={t(expanded ? "nav.collapseTask" : "nav.expandTask", { name: task.isDefault ? t("nav.defaultTask") : task.title })}
              aria-expanded={expanded}
              className="flex size-6 shrink-0 items-center justify-center rounded-md text-subtlest hover:bg-hover"
              onClick={(event) => {
                event.stopPropagation();
                // 子任务与成员会话同属这一个展开动作；行本身不做展开。
                if (hasChildren && childrenExpanded !== !expanded) onToggleTaskChildren(task.id);
                if (hasSessions && sessionsExpanded !== !expanded) onExpandTask(expanded ? null : task.id);
              }}
            >
              <ChevronRight className={`size-3.5 transition-transform duration-100 ${expanded ? "rotate-90" : ""}`} />
            </button>
          ) : <span className="size-6 shrink-0" aria-hidden="true" />}
          <span className={`flex-1 truncate text-ui-sm ${task.isDefault ? "text-subtlest" : ""}`}>
            {task.isDefault ? t("nav.defaultTask") : task.title}
          </span>
          {run && <span className="size-1.5 rounded-full bg-success shrink-0" aria-label={t("nav.running")} />}
          {/* 悬停或行/子控件持焦时可见：display:none 时 Tab 不可达，group-focus-within 补足键盘路径 */}
          <span className="hidden group-hover:flex group-focus-within:flex items-center shrink-0">
            {/* 任务类型显式声明：只有长期任务可再建短期子任务 */}
            {task.kind === "long" && (
              <IconButton
                icon={Plus}
                label={t("nav.newSubTask")}
                size={6}
                onClick={(event) => {
                  event.stopPropagation();
                  onNewDraft(task.workspaceId, task.id);
                }}
              />
            )}
            {/* N07 任务操作菜单：只列当前可执行的操作；首版不提供永久删除（507 选择可恢复归档 A），
                归档入口（L01）在独立切片落地，本片不应提供伪装动作 */}
            {!task.isDefault && taskMenuItems(task).length > 0 && (
              <Menu
                // 触发钮在侧栏右缘：菜单向左内开，避免被侧栏滚动容器横向裁切（frames 实复现过）
                align="end"
                trigger={<IconButton icon={MoreHorizontal} label={t("nav.taskActions")} size={6} />}
                items={taskMenuItems(task)}
              />
            )}
          </span>
        </div>
        {childrenExpanded && children.map((child) => taskRow(child, depth + 1))}
        {sessionsExpanded && (
          <div>
            {memberSessions.map((session) => {
              // 当前会话：文字回到前景色并加字重；其余会话保持说明色。
              // 「知道在哪里工作」靠这一处层级差，不靠给整行加框。
              const active = selection.sessionId === session.id;
              return (
              <div
                key={session.id}
                role="treeitem"
                data-session-id={session.id}
                aria-current={active ? "true" : undefined}
                tabIndex={0}
                onKeyDown={(event) => {
                  // 只响应行自身的键盘事件：子控件冒泡不得误触父行
                  if (event.target !== event.currentTarget) return;
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    event.currentTarget.click();
                  }
                }}
                className={`flex items-center h-6.5 rounded-md pr-2 cursor-default select-none ${
                  active ? "bg-selected text-foreground font-medium" : "text-subtle hover:bg-hover hover:text-foreground"
                }`}
                style={{ paddingLeft: `calc(${10 + depth * 14 + 18}px * var(--ui-scale))` }}
                onClick={(event) => {
                  event.stopPropagation();
                  onSelectSession(session.id);
                }}
              >
                <span className="flex-1 truncate text-ui-sm">{session.title}</span>
                {session.kind === "sub" && <Badge>{t("nav.subSession")}</Badge>}
              </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  const workspaceRow = (workspace: Workspace) => {
    const expanded = expandedWorkspaceIds.includes(workspace.id);
    const tasks = tasksByWorkspace.get(workspace.id) ?? [];
    return (
      <div key={workspace.id} className="mb-1" data-workspace-id={workspace.id}>
        <div
          role="treeitem"
          aria-expanded={expanded}
          tabIndex={0}
          onKeyDown={(event) => {
            // 只响应行自身的键盘事件：子控件（新建按钮/任务菜单）的 Enter/Space 冒泡不得误触父行
            if (event.target !== event.currentTarget) return;
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              event.currentTarget.click();
            }
          }}
          className={`group flex items-center gap-1 h-8 rounded-md px-2 cursor-default select-none hover:bg-hover ${expanded ? "text-foreground" : "text-subtle"}`}
          onClick={() => onToggleWorkspace(workspace.id)}
        >
          <ChevronRight className={`size-3.5 shrink-0 text-subtlest transition-transform duration-100 ${expanded ? "rotate-90" : ""}`} />
          <FolderClosed className="size-3.5 shrink-0 text-subtle" />
          <span className="flex-1 truncate text-ui-sm font-medium">{workspace.name}</span>
          {workspace.builtinHome && <Badge>{t("nav.defaultBadge")}</Badge>}
          <span className="hidden group-hover:flex group-focus-within:flex shrink-0">
            <Menu
              trigger={<IconButton icon={Plus} label={t("nav.newTaskHere")} size={6} />}
              items={[
                { label: t("nav.newWorkDraft"), onSelect: () => onNewDraft(workspace.id, null) },
                { label: t("nav.newLongTask"), disabled: pendingTaskIntents.length > 0, onSelect: (trigger) => {
                  taskDialogTrigger.current = trigger;
                  setNewTaskFor({ workspaceId: workspace.id });
                } },
              ]}
            />
          </span>
        </div>
        {expanded && <div role="group">{tasks.map((task) => taskRow(task, 1))}</div>}
      </div>
    );
  };

  return (
    // 侧栏是工作台的「架子」而不是又一个盒子：磨砂表面 + 极弱右缘，
    // 内部的层级由行高、字重与选中/悬停叠色承担（DESIGN 容器、颜色与信息层级）。
    <nav className="app-sidebar glass glass-sidebar flex h-full flex-col border-r border-[var(--edge)]">
      <div className="app-brand drag-region flex shrink-0 items-center gap-2 px-3">
        {/* 507 于 2026-10-08 定案采用 D2-R2 猫头鹰；同源同一母版，不加裁切/反色/滤镜/独立点击 */}
        <img
          src={new URL("../assets/dcode-owl.png", import.meta.url).href}
          alt=""
          aria-hidden="true"
          className="app-brand-owl pointer-events-none select-none shrink-0"
          draggable={false}
        />
        <span className="text-ui-base font-semibold tracking-tight">D Code</span>
        <IconButton icon={Plus} label={t(snapshot.pendingWorkspaceCreation ? 'workspace.check' : 'workspace.createTitle')}
          onClick={() => { setWorkspaceIntent(snapshot.pendingWorkspaceCreation ?? null); setNewWorkspace(true); }} />
      </div>

            {/* 树内容超出时只在本区域滚动，不带动窗口；min-h-0 是 flex 收缩前提 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pt-1 pb-2" role="tree" aria-label={t("nav.treeLabel")}>
        {snapshot.workspaces.map(workspaceRow)}
      </div>

      {pendingTaskIntents.length > 0 && (
        <div className="shrink-0 px-2 pb-2">
          {pendingTaskIntents.map((intent) => <Button key={intent.operationId} size="sm" variant="outline" className="w-full"
            onClick={() => setNewTaskFor({ workspaceId: intent.workspaceId, initialIntent: intent })}>
            {pendingTaskIntents.length === 1 ? t("task.check") : t("task.checkNamed", { name: intent.title })}
          </Button>)}
        </div>
      )}

      {/* 底部只保留一条极弱上缘与设置入口；不再给整块加独立实色底栏 */}
      <div className="flex shrink-0 items-center justify-between border-t border-[var(--edge)] px-2 py-2">
        <Button size="sm" variant="ghost" onClick={onOpenSettings}>
          <SettingsIcon className="size-3.5" />
          {t("nav.settings")}
          {!snapshot.model.available && <span className="size-1.5 rounded-full bg-warning" aria-label={t("nav.settings.missingModel")} />}
        </Button>
      </div>

      {newWorkspace && <WorkspaceDialog initialIntent={workspaceIntent} onClose={() => setNewWorkspace(false)} onCreated={onWorkspaceCreated} />}
      {newTaskFor && <TaskDialog
        workspaceId={newTaskFor.workspaceId}
        workspaceName={snapshot.workspaces.find((workspace) => workspace.id === newTaskFor.workspaceId)?.name ?? t("task.unknownWorkspace")}
        initialIntent={newTaskFor.initialIntent}
        restoreFocusTo={taskDialogTrigger.current}
        onIntentChange={updateTaskIntent}
        onClose={() => setNewTaskFor(null)}
        onCreated={onTaskCreated}
      />}

    </nav>
  );
}
