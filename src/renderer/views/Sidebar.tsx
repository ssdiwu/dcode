// 侧栏树：工作空间（根节点，始终可见）→ 任务（两级）→ 会话（单任务手风琴）。
// 树的展开/收起与选择都是纯导航，不改变任何执行状态。

import { useMemo, useState } from "react";
import { ChevronRight, FolderClosed, MoreHorizontal, Plus, Settings as SettingsIcon } from "lucide-react";
import type { AppSnapshot, Session, Task, Workspace, WorkspaceCreationIntent } from "@/contracts";
import { Button, IconButton } from "../components/Button";
import { useT } from "../i18n";
import { Badge } from "../components/Badge";
import { Dialog, Menu } from "../components/Menu";
import { WorkspaceDialog } from "../components/WorkspaceDialog";

export interface SidebarSelection {
  sessionId: string | null;
  draftTaskId: string | null;
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
  onCreateTask,
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
  onCreateTask: (workspaceId: string, parentId: string | null, title: string) => void;
  onMoveTask: (taskId: string, targetWorkspaceId: string) => void;
  onWorkspaceCreated: (workspace: Workspace) => void;
}) {
  const t = useT();
  const [newTaskFor, setNewTaskFor] = useState<{ workspaceId: string; parentId: string | null } | null>(null);
  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [newWorkspace, setNewWorkspace] = useState(false);
  const [workspaceIntent, setWorkspaceIntent] = useState<WorkspaceCreationIntent | null>(null);

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
    const children = childTasks.get(task.id) ?? [];
    const hasSessions = sessions.length > 0;
    const hasChildren = children.length > 0;
    const expandable = hasSessions || hasChildren;
    // 会话列表是单手风琴；子任务展开是独立的多选集合
    const sessionsExpanded = expandedTaskId === task.id;
    const childrenExpanded = expandedTaskIds.includes(task.id);
    const selected = selection.draftTaskId === task.id;
    const run = sessions.map((s) => snapshot.runs[s.id]).find((r) => r && r.status === "running");

    return (
      <div key={task.id}>
        <div
          role="treeitem"
          data-task-id={task.id}
          aria-expanded={expandable ? sessionsExpanded || childrenExpanded : undefined}
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
            if (hasChildren) onToggleTaskChildren(task.id);
            if (hasSessions) {
              onExpandTask(sessionsExpanded ? null : task.id);
              if (!sessionsExpanded) onSelectSession(sessions[0].id);
            } else if (!hasChildren) {
              onSelectDraft(task.id);
            }
          }}
        >
          <ChevronRight
            className={`size-3.5 shrink-0 text-subtlest transition-transform duration-100 ${
              sessionsExpanded || childrenExpanded ? "rotate-90" : ""
            } ${expandable ? "" : "invisible"}`}
          />
          <span className={`flex-1 truncate text-ui-sm ${task.isDefault ? "text-subtlest" : ""}`}>
            {task.isDefault ? t("nav.defaultTask") : task.title}
          </span>
          {run && <span className="size-1.5 rounded-full bg-success shrink-0" aria-label={t("nav.running")} />}
          {/* 悬停或行/子控件持焦时可见：display:none 时 Tab 不可达，group-focus-within 补足键盘路径 */}
          <span className="hidden group-hover:flex group-focus-within:flex items-center shrink-0">
            {/* 任务类型显式声明：只有长期任务可再建短期子任务 */}
            {task.kind === "long" && !task.isDefault && (
              <IconButton
                icon={Plus}
                label={t("nav.newSubTask")}
                size={6}
                onClick={(event) => {
                  event.stopPropagation();
                  setNewTaskFor({ workspaceId: task.workspaceId, parentId: task.id });
                  setNewTaskTitle("");
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
            {sessions.map((session) => {
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
            <IconButton
              icon={Plus}
              label={t("nav.newTaskHere")}
              size={6}
              onClick={(event) => {
                event.stopPropagation();
                setNewTaskFor({ workspaceId: workspace.id, parentId: null });
                setNewTaskTitle("");
              }}
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

      {/* 底部只保留一条极弱上缘与设置入口；不再给整块加独立实色底栏 */}
      <div className="flex shrink-0 items-center justify-between border-t border-[var(--edge)] px-2 py-2">
        <Button size="sm" variant="ghost" onClick={onOpenSettings}>
          <SettingsIcon className="size-3.5" />
          {t("nav.settings")}
          {!snapshot.model.available && <span className="size-1.5 rounded-full bg-warning" aria-label={t("nav.settings.missingModel")} />}
        </Button>
      </div>

      {newWorkspace && <WorkspaceDialog initialIntent={workspaceIntent} onClose={() => setNewWorkspace(false)} onCreated={onWorkspaceCreated} />}
      {newTaskFor && (
        <Dialog
          title={newTaskFor.parentId ? t("nav.newShortTask") : t("nav.newLongTask")}
          onClose={() => setNewTaskFor(null)}
          actions={
            <>
              <Button variant="ghost" onClick={() => setNewTaskFor(null)}>
                {t("common.cancel")}
              </Button>
              <Button
                variant="primary"
                disabled={!newTaskTitle.trim()}
                onClick={() => {
                  onCreateTask(newTaskFor.workspaceId, newTaskFor.parentId, newTaskTitle);
                  setNewTaskFor(null);
                }}
              >
                {t("common.create")}
              </Button>
            </>
          }
        >
          <input
            value={newTaskTitle}
            onChange={(event) => setNewTaskTitle(event.target.value)}
            placeholder={t("nav.taskNamePlaceholder")}
            className="input-surface w-full h-8 rounded-lg border border-border bg-input px-2.5 text-ui-base"
            onKeyDown={(event) => {
              if (event.key === "Enter" && newTaskTitle.trim() && !event.nativeEvent.isComposing) {
                onCreateTask(newTaskFor.workspaceId, newTaskFor.parentId, newTaskTitle);
                setNewTaskFor(null);
              }
            }}
          />
          <p className="mt-2 text-ui-sm text-subtlest">
            {newTaskFor.parentId ? t("nav.shortTermHint") : t("nav.longTermHint")}
          </p>
        </Dialog>
      )}

    </nav>
  );
}
