import { useEffect, useState } from "react";

/**
 * 三区布局骨架（0.0.30 开发中）：数据真实（foundation.snapshot），
 * 形态占位——稳定几何、梗概浮卡（进度 + 团队）与详情侧栏按
 * PRD 0028 合同逐步落地。Tailwind / Motion / swr 随渲染工具链安装接入。
 */

interface DcodeApi {
  request: (
    method: string,
    params?: Record<string, unknown>,
  ) => Promise<unknown>;
  subscribe: (handler: (envelope: unknown) => void) => () => void;
}

interface TaskRecord {
  id: string;
  title: string;
  goal?: string;
  cwd: string;
}

interface ProjectRecord {
  id: string;
  name: string;
}

interface FoundationSnapshot {
  storeRevision: number;
  currentUser: { id: string };
  projects: ProjectRecord[];
  tasks: TaskRecord[];
  sessions: { id: string }[];
}

function api(): DcodeApi {
  return (window as unknown as { dcode: DcodeApi }).dcode;
}

export function App() {
  const [snapshot, setSnapshot] = useState<FoundationSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    api()
      .request("foundation.snapshot")
      .then(value => {
        if (alive) setSnapshot(value as FoundationSnapshot);
      })
      .catch((reason: unknown) => {
        if (alive) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      });
    const unsubscribe = api().subscribe(envelope => {
      const message = envelope as { event?: string };
      if (message.event === "foundation.changed") {
        api()
          .request("foundation.snapshot")
          .then(value => {
            if (alive) setSnapshot(value as FoundationSnapshot);
          })
          .catch(() => undefined);
      }
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  const tasks = snapshot?.tasks ?? [];
  const projects = snapshot?.projects ?? [];
  const selectedTask =
    tasks.find(task => task.id === selectedTaskId) ?? tasks[0] ?? null;
  const projectTasks = projects.map(project => ({
    project,
    tasks: tasks.filter(
      task =>
        typeof (task as { projectId?: unknown }).projectId === "string" &&
        (task as { projectId?: string }).projectId === project.id,
    ),
  }));
  const standaloneTasks = tasks.filter(
    task => (task as { projectId?: unknown }).projectId == null,
  );

  return (
    <div className="app">
      <nav className="nav" aria-label="D Code 导航区">
        <div className="nav-identity">
          <strong>D Code</strong>
        </div>
        <div className="nav-section">项目</div>
        {projectTasks.map(({ project, tasks: owned }) => (
          <div key={project.id} className="nav-project">
            <div className="nav-project-name">{project.name}</div>
            {owned.map(task => (
              <button
                key={task.id}
                className={
                  selectedTask?.id === task.id ? "nav-row is-active" : "nav-row"
                }
                onClick={() => setSelectedTaskId(task.id)}
              >
                {task.title}
              </button>
            ))}
          </div>
        ))}
        <div className="nav-section">任务</div>
        {standaloneTasks.map(task => (
          <button
            key={task.id}
            className={
              selectedTask?.id === task.id ? "nav-row is-active" : "nav-row"
            }
            onClick={() => setSelectedTaskId(task.id)}
          >
            {task.title}
          </button>
        ))}
        <div className="nav-footer">设置（占位）</div>
      </nav>

      <main
        className={
          detailOpen ? "workspace is-narrowed" : "workspace"
        }
        aria-label="D Code 工作区"
      >
        {error ? (
          <div className="state-card">
            <strong>Host 连接失败</strong>
            <p>{error}</p>
          </div>
        ) : !snapshot ? (
          <div className="state-card">正在连接 Host…</div>
        ) : (
          <div className="conversation">
            <h1>{selectedTask ? selectedTask.title : "暂无任务"}</h1>
            <p className="goal">
              {selectedTask?.goal ?? "在 Product Store 中创建第一个任务。"}
            </p>
            <p className="meta">
              store revision {snapshot.storeRevision} · 会话{" "}
              {snapshot.sessions.length} 条
            </p>
          </div>
        )}
      </main>

      {snapshot && !detailOpen ? (
        <aside className="hud-card" aria-label="任务梗概（占位）">
          <strong>梗概 · 占位</strong>
          <p>进度追踪与 Agent Team 追踪按 PRD 0028 合同落地。</p>
          <button onClick={() => setDetailOpen(true)}>打开详情侧栏</button>
        </aside>
      ) : null}

      {detailOpen ? (
        <aside className="detail-panel" aria-label="对象详情（占位）">
          <strong>详情 · 占位</strong>
          <p>挤压任务区宽度的侧边子栏；关闭后任务区恢复。</p>
          <button onClick={() => setDetailOpen(false)}>关闭</button>
        </aside>
      ) : null}
    </div>
  );
}
