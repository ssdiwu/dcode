import { MIN_MODEL_QUOTA_THRESHOLD_PERCENT, MAX_MODEL_QUOTA_THRESHOLD_PERCENT, DEFAULT_MODEL_QUOTA_THRESHOLD_PERCENT } from "../../../../../host/src/model-quota-policy.js";
import { ProviderConnection } from "./ProviderConnection";
import { ModelRouteEditor, type ModelRouteDraft } from "./ModelRouteEditor";
import { changeThemeFromButton } from "../workbench/theme-transition";
import { ModelPicker } from "./ModelPicker";
import type { ModelControls } from "../workbench/useModels";
import { thinkingLabels, profilePresentation } from "../workbench/presentation";
import { useEffect, useState, type ReactNode } from "react";
import useSWR from "swr";
import {
  ArrowLeft,
  Cpu,
  Server,
  Package,
  Users,
  Palette,
  PanelsTopLeft,
  Archive,
  RefreshCw,
  Bell,
  Activity,
  Info,
  Plus,
  X,
  Check,
  ExternalLink,
} from "lucide-react";
import {
  api,
  errorText,
  type ProviderView,
  type ClientPreferences,
  type TaskRecord,
} from "../types";
import type { Workbench } from "../useWorkbench";
import type { CatalogProviderInput } from "../../../../../host/src/model-catalog-configuration.js";
import type { ResourcesSnapshot } from "../../../../../host/src/resources.js";
import logoUrl from "../assets/logo.png";

const pages = [
  ["models", "模型", Cpu],
  ["providers", "自定义供应商", Server],
  ["resources", "本机资源", Package],
  ["profiles", "智能体档案", Users],
  ["appearance", "外观", Palette],
  ["workbench", "工作台", PanelsTopLeft],
  ["archives", "已归档任务", Archive],
  ["evolution", "自进化", RefreshCw],
  ["notifications", "通知", Bell],
  ["diagnostics", "Host 诊断", Activity],
  ["about", "关于 D Code", Info],
] as const;
export type SettingsPageId = (typeof pages)[number][0];
type Page = SettingsPageId;
export function SettingsWorkspace({
  work,
  providers,
  models,
  onClose,
  onImport,
  onOpenTask,
  initialPage,
}: {
  initialPage?: SettingsPageId;
  work: Workbench;
  providers: ProviderView[];
  models: ModelControls;
  onClose: () => void;
  onImport: () => void;
  onOpenTask: (task: TaskRecord) => void;
}) {
  const [page, setPage] = useState<Page>(initialPage ?? "models");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const update = async (patch: Partial<ClientPreferences>, origin?: HTMLElement) => {
    setBusy(true);
    setError(null);
    try {
      const save = async () => {
        await work.mutateStore("clientPreferences.set", patch);
        await work.reload();
      };
      if (origin) await changeThemeFromButton(origin, save);
      else await save();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const execute = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await operation();
      await work.reload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className="settings-workbench"
      style={
        {
          "--nav-width": `${work.preferences?.sidebarWidth ?? 240}px`,
        } as React.CSSProperties
      }
    >
      <nav className="settings-navigation" aria-label="设置分类">
        <div className="window-band drag-region" />
        <button className="nav-row" onClick={onClose}>
          <ArrowLeft size={16} />
          <span>返回工作台</span>
        </button>
        <h1>设置</h1>
        {pages.map(([id, label, Icon], i) => (
          <div key={id}>
            {[0, 4, 6, 8].includes(i) && (
              <div className="nav-heading">
                {i === 0
                  ? "能力"
                  : i === 4
                    ? "偏好"
                    : i === 6
                      ? "任务"
                      : "应用"}
              </div>
            )}
            <button
              className="nav-row"
              aria-current={page === id ? "page" : undefined}
              onClick={() => {
                setPage(id);
                setError(null);
              }}
            >
              <Icon size={16} />
              <span>{label}</span>
            </button>
          </div>
        ))}
      </nav>
      <main className="settings-main">
        <div className="window-band drag-region" />
        <div className="settings-content">
          <h1>{pages.find((p) => p[0] === page)?.[1]}</h1>
          {work.hostDead && <div role="alert" className="inline-error">运行服务已断开。<button className="text-button" disabled={work.restarting} onClick={() => void work.restart()}>重新连接</button></div>}
          {error && (
            <div role="alert" className="inline-error">
              {error}
              <button
                className="icon-button"
                aria-label="关闭错误"
                onClick={() => setError(null)}
              >
                <X size={14} />
              </button>
            </div>
          )}
          {page === "models" && (
            <Models models={models} onProviders={()=>setPage("providers")}
            />
          )}
          {page === "providers" && (
            <Providers
              work={work}
              providers={providers}
              execute={execute}
              busy={busy}
            />
          )}
          {page === "resources" && (
            <Resources work={work} execute={execute} busy={busy} />
          )}
          {page === "profiles" && (
            <Profiles work={work} models={models} execute={execute} busy={busy} />
          )}
          {page === "appearance" && (
            <>
              <p className="settings-intro">选择这台 Mac 上的显示方式。</p>
              <Group>
                <Row title="应用外观" detail="跟随系统，或固定使用浅色、深色。">
                  <Segments
                    value={work.preferences?.appearance ?? "system"}
                    options={[
                      ["system", "系统"],
                      ["light", "浅色"],
                      ["dark", "深色"],
                    ]}
                    disabled={busy}
                    onChange={(appearance, button) =>
                      void update({
                        appearance:
                          appearance as ClientPreferences["appearance"],
                      }, button)
                    }
                  />
                </Row>
                <Row title="界面字号" detail="整体调整文字和控件大小。">
                  <Segments
                    value={work.preferences?.fontScale ?? "standard"}
                    options={[
                      ["compact", "紧凑"],
                      ["standard", "标准"],
                      ["large", "大"],
                    ]}
                    onChange={(fontScale) =>
                      void update({
                        fontScale: fontScale as ClientPreferences["fontScale"],
                      })
                    }
                  />
                </Row>
              </Group>
            </>
          )}
          {page === "workbench" && (
            <>
              <p className="settings-intro">
                导航区、设置分类和对象详情共用已保存的栏宽。
              </p>
              <Group>
                <Row title="显示导航区">
                  <input
                    type="checkbox"
                    aria-label="显示导航区"
                    checked={work.preferences?.sidebarVisible ?? true}
                    onChange={(e) =>
                      void update({ sidebarVisible: e.target.checked })
                    }
                  />
                </Row>
                <Row title="进入任务时显示概览">
                  <input
                    type="checkbox"
                    aria-label="进入任务时显示概览"
                    checked={work.preferences?.overviewVisible ?? true}
                    onChange={(e) =>
                      void update({ overviewVisible: e.target.checked })
                    }
                  />
                </Row>
                <Row title="导航区宽度">
                  <input
                    type="range"
                    aria-label="导航区宽度"
                    min={200}
                    max={360}
                    value={work.preferences?.sidebarWidth ?? 240}
                    onChange={(e) =>
                      void update({ sidebarWidth: Number(e.target.value) })
                    }
                  />
                </Row>
                <Row title="对象详情宽度">
                  <input
                    type="range"
                    aria-label="对象详情宽度"
                    min={280}
                    max={520}
                    value={work.preferences?.inspectorWidth ?? 340}
                    onChange={(e) =>
                      void update({ inspectorWidth: Number(e.target.value) })
                    }
                  />
                </Row>
                <Row title="恢复默认布局">
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() =>
                      void update({
                        sidebarVisible: true,
                        overviewVisible: true,
                        sidebarWidth: 240,
                        inspectorWidth: 340,
                      })
                    }
                  >
                    恢复默认
                  </button>
                </Row>
              </Group>
            </>
          )}
          {page === "archives" && (
            <>
              <div className="settings-toolbar">
                <p className="settings-intro">
                  归档保留任务、会话和历史记录，可以随时恢复。
                </p>
                <button className="text-button" onClick={onImport}>
                  导入 Pi 会话…
                </button>
              </div>
              <Group>
                {work.snapshot?.tasks.filter((t) => t.state === "archived")
                  .length ? (
                  work.snapshot.tasks
                    .filter((t) => t.state === "archived")
                    .map((t) => (
                      <Row key={t.id} title={t.title} detail={t.goal}>
                        <button
                          disabled={busy}
                          className="text-button"
                          onClick={() =>
                            void execute(async () => {
                              const result = await work.mutateStore<{
                                task: TaskRecord;
                              }>("task.manage", {
                                taskId: t.id,
                                action: "restore",
                              });
                              onOpenTask(result.task);
                            })
                          }
                        >
                          恢复任务
                        </button>
                      </Row>
                    ))
                ) : (
                  <p className="settings-empty-row">没有已归档任务。</p>
                )}
              </Group>
            </>
          )}
          {page === "evolution" && (
            <Evolution work={work} execute={execute} busy={busy} />
          )}
          {page === "notifications" && (
            <>
              <p className="settings-intro">
                只在一次执行已确认结束时发送通知。
              </p>
              <Group>
                <Row
                  title="任务完成时通知我"
                  detail="通知只包含任务标题，不包含回答正文。"
                >
                  <input
                    type="checkbox"
                    aria-label="任务完成时通知我"
                    checked={work.preferences?.notificationsEnabled ?? true}
                    onChange={(e) =>
                      void update({ notificationsEnabled: e.target.checked })
                    }
                  />
                </Row>
                <Row
                  title="系统通知设置"
                  detail="提醒方式、声音与专注模式由 macOS 管理。"
                >
                  <button
                    className="text-button"
                    onClick={() =>
                      void api().openNotificationSettings().catch(setError)
                    }
                  >
                    打开系统设置
                  </button>
                </Row>
              </Group>
            </>
          )}
          {page === "diagnostics" && (
            <Diagnostics work={work} execute={execute} busy={busy} />
          )}
          {page === "about" && <About />}
        </div>
      </main>
      {work.closing && (
        <div className="app-transition" role="status">
          正在保存工作台并切换应用…
        </div>
      )}
    </div>
  );
}
function Group({ children }: { children: ReactNode }) {
  return <div className="settings-group">{children}</div>;
}
function Row({
  title,
  detail,
  children,
}: {
  title: ReactNode;
  detail?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="settings-row">
      <div>
        <strong>{title}</strong>
        {detail && <p>{detail}</p>}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}
function Segments({
  value,
  options,
  onChange,
  disabled = false,
}: {
  value: string;
  options: readonly (readonly [string, string])[];
  onChange: (v: string, button: HTMLButtonElement) => void;
  disabled?: boolean;
}) {
  return (
    <div className="segments">
      {options.map(([id, label]) => (
        <button
          key={id}
          aria-pressed={value === id}
          disabled={disabled}
          onClick={event => onChange(id, event.currentTarget)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
type Controls = {
  work: Workbench;
  busy: boolean;
  execute: (op: () => Promise<unknown>) => Promise<void>;
};
function Models({models,onProviders}: {models:ModelControls;onProviders:()=>void}) {
  const [query,setQuery]=useState("");
  const [connectedOnly,setConnectedOnly]=useState(false);
  const data=models.data;
  const showConnections=()=>{setConnectedOnly(false);setQuery("");requestAnimationFrame(()=>document.getElementById("model-connection-list")?.scrollIntoView({block:"start"}));};
  const available=data?.models.filter(m=>m.available)??[];
  const shown=data?.models.filter(m=>(!connectedOnly||m.available)&&`${m.name} ${m.modelId} ${m.providerName}`.toLowerCase().includes(query.toLowerCase()))??[];
  const levels=data?.models.find(m=>m.key===data.defaultKey)?.thinkingLevels??["off","minimal","low","medium","high","xhigh","max"];
  return <>
    <div className="settings-toolbar model-settings-toolbar"><p className="settings-intro">选择对话使用的模型，并管理已有连接。</p><button className="text-button" onClick={()=>void models.refresh()} disabled={models.refreshing}><RefreshCw size={14}/>{models.refreshing?"正在刷新…":"刷新目录"}</button></div>
    {models.error&&<p role="alert" className="inline-error">{models.error}</p>}
    {data?.refresh.failedProviders.length ? <p role="status" className="secondary">部分模型目录未能更新：{data.refresh.failedProviders.map(id=>data.providers.find(provider=>provider.id===id)?.name??id).join("、")}。目录已保留，请检查对应连接状态。</p> : null}
    <Group>
      <Row title="默认模型" detail={available.length?"用于新对话，可在输入区随时切换。":"尚无可用连接。请在下方检查连接状态，再选择模型开始对话。"}>
        {available.length?<ModelPicker label="默认模型" models={data?.models??[]} value={data?.defaultKey??null} onChange={models.chooseDefault} onManage={showConnections} onRefresh={()=>models.refresh()} refreshing={models.refreshing} busy={models.busy}/>:<button className="primary-button" onClick={showConnections}>连接模型</button>}
      </Row>
      <Row title="默认思考强度" detail="用于新对话。可选范围随模型变化。"><select aria-label="默认思考强度" disabled={models.busy||levels.length===1} value={levels.includes(data?.defaultThinking??"")?data?.defaultThinking:levels.includes("medium")?"medium":levels[0]} onChange={e=>void models.setDefaultThinking(e.target.value)}>{levels.map(level=><option key={level} value={level}>{thinkingLabels[level]??level}</option>)}</select></Row>
      <Row title="自动选择的剩余额度门槛" detail="剩余额度不高于此值时，沿原有回退顺序选择下一个模型。用于后续自动派发和回退，不中断正在执行的工作。"><select aria-label="自动选择的剩余额度门槛" disabled={models.busy||!data} value={data?.modelQuotaThresholdPercent??DEFAULT_MODEL_QUOTA_THRESHOLD_PERCENT} onChange={e=>void models.setQuotaThreshold(Number(e.target.value))}>{Array.from({length:MAX_MODEL_QUOTA_THRESHOLD_PERCENT-MIN_MODEL_QUOTA_THRESHOLD_PERCENT+1},(_,i)=>i+MIN_MODEL_QUOTA_THRESHOLD_PERCENT).map(value=><option key={value} value={value}>{value}%</option>)}</select></Row>
      <Row title="模型连接" detail={`${data?.providers.filter(p=>p.connected).length??0} 个可用供应商 · ${available.length} 个可选择模型`}><button className="text-button" onClick={onProviders}>管理自定义供应商</button></Row>
    </Group>
    <div className="settings-toolbar" id="model-connection-list"><h2>模型连接与目录</h2><span className="secondary">{models.refreshing?"正在获取最新目录":data?.refresh.updatedAt?`更新于 ${new Date(data.refresh.updatedAt).toLocaleTimeString()}`:"已缓存的目录"}</span></div>
    <div className="settings-toolbar"><input className="model-search" aria-label="搜索模型目录" placeholder="搜索模型或供应商…" value={query} onChange={e=>setQuery(e.target.value)}/><label><input type="checkbox" checked={connectedOnly} onChange={e=>setConnectedOnly(e.target.checked)}/>仅看可用连接</label>{data?.models.some(m=>!m.enabled)&&<button className="text-button" disabled={models.busy} onClick={()=>void models.enableAll()}>启用全部模型</button>}</div>
    {data?.providers.filter(p=>shown.some(m=>m.providerId===p.id)).map(provider=><details className="model-provider" key={provider.id} open={connectedOnly||!!query||["openai","openai-codex"].includes(provider.id)}>
      <summary><span>{provider.name}</span><span className="secondary">{provider.connected?"可用":models.connections?.providers.find(connection=>connection.providerId===provider.id)?.managed?"已保存，暂不可用":"未连接"} · {shown.filter(m=>m.providerId===provider.id).length} 个模型</span></summary>
      <ProviderConnection providerId={provider.id} models={models}/>
      <details className="model-provider-models"><summary>查看模型与启用范围</summary>
      <Group>{shown.filter(m=>m.providerId===provider.id).map(model=><Row key={model.key} title={model.name} detail={`${model.modelId}${model.contextWindow?` · 上下文 ${model.contextWindow.toLocaleString()}`:""}${model.reasoning?" · 支持思考":""}`}><input type="checkbox" aria-label={`启用模型 ${model.name}`} checked={model.enabled} disabled={models.busy} onChange={e=>void models.setEnabled(model.key,e.target.checked)}/></Row>)}</Group></details>
    </details>)}
    {!shown.length&&<p className="settings-empty-row">{models.loading?"正在读取模型…":query?"没有找到匹配的模型。":connectedOnly?"暂无已连接的模型，可管理供应商或查看全部目录。":"没有模型信息，请刷新目录。"}</p>}
  </>;
}
function Providers({
  work,
  providers,
  execute,
  busy,
}: Controls & { providers: ProviderView[] }) {
  const [editing, setEditing] = useState<CatalogProviderInput | null>(null);
  const custom =
    work.snapshot?.modelProviders.filter(
      (p) => (p.nonsecret as { source?: string })?.source === "dcode_custom",
    ) ?? [];
  const empty = () => ({
    id: "",
    name: "",
    baseUrl: "",
    apiKind: "openai-completions",
    credentialEnv: "",
    managedAuth: true,
    models: [
      {
        modelId: "",
        name: "",
        reasoning: false,
        contextWindow: 128000,
        maxTokens: 8192,
      },
    ],
  });
  const save = () =>
    execute(async () => {
      await work.mutateStore("dcodeModelProvider.save", { provider: editing });
      setEditing(null);
    });
  return (
    <>
      <div className="settings-toolbar">
        <p className="settings-intro">
          自定义 API 地址和模型。保存后可在模型页连接，也可使用已有环境变量。
        </p>
        <button className="primary-button" onClick={() => setEditing(empty())}>
          <Plus size={14} />
          新建供应商
        </button>
      </div>
      <Group>
        {custom.length ? (
          custom.map((p) => (
            <Row key={p.id} title={p.name} detail={`${p.id} · ${p.baseUrl}`}>
              <button
                className="text-button"
                disabled={busy}
                onClick={() =>
                  setEditing({
                    id: p.id,
                    name: p.name,
                    baseUrl: p.baseUrl ?? "",
                    apiKind: p.apiKind ?? "openai-completions",
                    credentialEnv:
                      (p.nonsecret as { credentialEnv?: string })
                        .credentialEnv ?? "",
                    managedAuth: (p.nonsecret as {managedAuth?:boolean}).managedAuth === true,
                    keepExistingAuth: (
                      p.nonsecret as { keepExistingAuth?: boolean }
                    ).keepExistingAuth,
                    compatJson: JSON.stringify(
                      (p.nonsecret as { compat?: unknown }).compat ?? {},
                      null,
                      2,
                    ),
                    models: work
                      .snapshot!.modelCatalogEntries.filter(
                        (m) => m.providerId === p.id,
                      )
                      .map((m) => ({
                        modelId: m.modelId,
                        name: m.name,
                        reasoning: m.reasoning,
                        contextWindow: m.contextWindow ?? 128000,
                        maxTokens: m.maxTokens ?? 8192,
                        api:
                          (m.nonsecret as { apiOverride?: string })
                            .apiOverride ?? "",
                        baseUrl:
                          (m.nonsecret as { baseUrlOverride?: string })
                            .baseUrlOverride ?? "",
                      })),
                  })
                }
              >
                编辑
              </button>
              <button
                className="text-button danger"
                disabled={busy}
                onClick={() =>
                  void execute(() =>
                    work.mutateStore("dcodeModelProvider.remove", {
                      providerId: p.id,
                    }),
                  )
                }
              >
                删除
              </button>
            </Row>
          ))
        ) : (
          <p className="settings-empty-row">尚未添加自定义供应商。</p>
        )}
      </Group>
      {providers.filter((provider) => !custom.some((p) => p.id === provider.id))
        .length > 0 && (
        <>
          <h2>既有自定义供应商</h2>
          <Group>
            {providers
              .filter((provider) => !custom.some((p) => p.id === provider.id))
              .map((p) => (
                <Row
                  key={p.id}
                  title={p.name ?? p.id}
                  detail={`${p.id} · ${p.authConfigured ? "已配置认证" : "未配置认证"}`}
                >
                  <button
                    className="text-button"
                    onClick={() =>
                      setEditing({
                        id: p.id,
                        name: p.name ?? p.id,
                        baseUrl:
                          p.baseUrl ??
                          work.snapshot?.modelProviders.find(
                            (m) => m.id === p.id,
                          )?.baseUrl ??
                          (
                            work.snapshot?.modelCatalogEntries.find(
                              (m) => m.providerId === p.id,
                            )?.nonsecret as { baseUrl?: string }
                          )?.baseUrl ??
                          "",
                        apiKind:
                          p.api ??
                          work.snapshot?.modelProviders.find(
                            (m) => m.id === p.id,
                          )?.apiKind ??
                          (
                            work.snapshot?.modelCatalogEntries.find(
                              (m) => m.providerId === p.id,
                            )?.nonsecret as { api?: string }
                          )?.api ??
                          "openai-completions",
                        credentialEnv: "",
                        keepExistingAuth: true,
                        adoptExisting: true,
                        compatJson: p.compatJson ?? "{}",
                        models:
                          work.snapshot?.modelCatalogEntries
                            .filter((m) => m.providerId === p.id)
                            .map((m) => ({
                              modelId: m.modelId,
                              name: m.name,
                              reasoning: m.reasoning,
                              contextWindow: m.contextWindow ?? 128000,
                              maxTokens: m.maxTokens ?? 8192,
                              api:
                                p.models.find((v) => v.id === m.modelId)?.api ??
                                "",
                              baseUrl:
                                p.models.find((v) => v.id === m.modelId)
                                  ?.baseUrl ?? "",
                            })) ?? [],
                      })
                    }
                  >
                    编辑
                  </button>
                </Row>
              ))}
          </Group>
        </>
      )}
      {editing && (
        <form
          className="settings-editor"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <h2>
            {custom.some((p) => p.id === editing.id)
              ? "编辑供应商"
              : "新建供应商"}
          </h2>
          {editing.adoptExisting && (
            <p className="secondary">
              保存后由 D Code
              管理这份供应商配置；既有认证继续引用，旧配置文件保持原样。
            </p>
          )}
          {(editing.adoptExisting ||
            providers.some((p) => p.id === editing.id) ||
            custom.some(
              (p) =>
                p.id === editing.id &&
                (p.nonsecret as { keepExistingAuth?: boolean })
                  .keepExistingAuth,
            )) && (
            <label>
              <input
                type="checkbox"
                checked={editing.keepExistingAuth ?? false}
                onChange={(e) =>
                  setEditing({ ...editing, keepExistingAuth: e.target.checked })
                }
              />
              使用旧配置的认证引用
            </label>
          )}
          {!editing.keepExistingAuth&&<label className="checkbox-row"><input type="checkbox" checked={editing.managedAuth===true} onChange={e=>setEditing({...editing,managedAuth:e.target.checked})}/>保存后通过安全窗口连接密钥</label>}
          <div className="form-grid">
            {(
              [
                ["id", "供应商 ID"],
                ["name", "显示名称"],
                ["baseUrl", "API 地址"],
                ["credentialEnv", "密钥所在环境变量"],
              ] as const
            ).map(([key, label]) => (
              <label key={key}>
                {label}
                <input
                  required={
                    key !== "credentialEnv" || !(editing.keepExistingAuth||editing.managedAuth)
                  }
                  disabled={
                    (key === "credentialEnv" && (editing.keepExistingAuth||editing.managedAuth)) ||
                    (key === "id" &&
                      (editing.adoptExisting ||
                        custom.some((p) => p.id === editing.id)))
                  }
                  value={editing[key]}
                  onChange={(e) =>
                    setEditing({ ...editing, [key]: e.target.value })
                  }
                  placeholder={
                    key === "credentialEnv"
                      ? "例如 MY_PROVIDER_API_KEY"
                      : undefined
                  }
                />
              </label>
            ))}
            <label>
              API 协议
              <select
                value={editing.apiKind}
                onChange={(e) =>
                  setEditing({ ...editing, apiKind: e.target.value })
                }
              >
                {[
                  "openai-completions",
                  "openai-responses",
                  "anthropic-messages",
                  "google-generative-ai",
                ].map((id) => (
                  <option key={id}>{id}</option>
                ))}
              </select>
            </label>
          </div>
          <h3>模型</h3>
          {editing.models.map((m, i) => (
            <div className="provider-model-editor" key={i}>
              <label>
                模型 ID
                <input
                  required
                  value={m.modelId}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      models: editing.models.map((v, n) =>
                        n === i ? { ...v, modelId: e.target.value } : v,
                      ),
                    })
                  }
                />
              </label>
              <label>
                模型名称
                <input
                  required
                  value={m.name}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      models: editing.models.map((v, n) =>
                        n === i ? { ...v, name: e.target.value } : v,
                      ),
                    })
                  }
                />
              </label>
              <label>
                上下文长度
                <input
                  type="number"
                  min={1}
                  value={m.contextWindow}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      models: editing.models.map((v, n) =>
                        n === i
                          ? { ...v, contextWindow: Number(e.target.value) }
                          : v,
                      ),
                    })
                  }
                />
              </label>
              <label>
                最大输出
                <input
                  type="number"
                  min={1}
                  value={m.maxTokens}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      models: editing.models.map((v, n) =>
                        n === i
                          ? { ...v, maxTokens: Number(e.target.value) }
                          : v,
                      ),
                    })
                  }
                />
              </label>
              <details className="provider-model-advanced">
                <summary>模型单独配置</summary>
                <label>
                  API 协议（可选）
                  <input
                    value={m.api ?? ""}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        models: editing.models.map((v, n) =>
                          n === i ? { ...v, api: e.target.value } : v,
                        ),
                      })
                    }
                    placeholder="跟随供应商"
                  />
                </label>
                <label>
                  API 地址（可选）
                  <input
                    value={m.baseUrl ?? ""}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        models: editing.models.map((v, n) =>
                          n === i ? { ...v, baseUrl: e.target.value } : v,
                        ),
                      })
                    }
                    placeholder="跟随供应商"
                  />
                </label>
              </details>
              <label>
                <input
                  type="checkbox"
                  checked={m.reasoning}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      models: editing.models.map((v, n) =>
                        n === i ? { ...v, reasoning: e.target.checked } : v,
                      ),
                    })
                  }
                />
                支持推理
              </label>
              <button
                type="button"
                className="icon-button"
                aria-label={`删除模型 ${i + 1}`}
                disabled={editing.models.length === 1}
                onClick={() =>
                  setEditing({
                    ...editing,
                    models: editing.models.filter((_, n) => n !== i),
                  })
                }
              >
                <X size={14} />
              </button>
            </div>
          ))}
          <button
            type="button"
            className="text-button"
            onClick={() =>
              setEditing({
                ...editing,
                models: [...editing.models, empty().models[0]],
              })
            }
          >
            添加模型
          </button>
          <details className="settings-advanced">
            <summary>高级兼容性参数</summary>
            <label>
              兼容性参数 JSON
              <textarea
                rows={6}
                value={editing.compatJson ?? ""}
                onChange={(e) =>
                  setEditing({ ...editing, compatJson: e.target.value })
                }
                placeholder="{}"
              />
            </label>
          </details>
          <div className="dialog-actions">
            <button
              type="button"
              className="text-button"
              onClick={() => setEditing(null)}
            >
              取消
            </button>
            <button className="primary-button" disabled={busy}>
              保存供应商
            </button>
          </div>
        </form>
      )}
    </>
  );
}
function Resources({ work, execute, busy }: Controls) {
  const { data, error, mutate } = useSWR(
    "settings-resources",
    () => api().request<ResourcesSnapshot>("resources.list"),
    { revalidateOnFocus: false },
  );
  return (
    <>
      <div className="settings-toolbar">
        <p className="settings-intro">
          查看当前加载的扩展包、技能、提示模板与命令。
        </p>
        <button className="text-button" onClick={() => void mutate()}>
          重新加载
        </button>
      </div>
      {error ? (
        <p role="alert">{errorText(error)}</p>
      ) : !data ? (
        <p>正在读取资源…</p>
      ) : (
        <>
          <h2>扩展包来源 · {data.packages.length}</h2>
          <p className="secondary">
            保留发现的资源来源。外部扩展代码不在当前任务中加载。
          </p>
          <Group>
            {data.packages.length ? (
              data.packages.map((p) => (
                <Row key={p.source} title={p.source} detail={p.kind}>
                  <span className="secondary">来源记录</span>
                </Row>
              ))
            ) : (
              <p className="settings-empty-row">没有配置扩展包。</p>
            )}
          </Group>
          {(
            [
              ["extensions", "扩展"],
              ["skills", "技能"],
              ["prompts", "提示模板"],
              ["commands", "命令"],
            ] as const
          ).map(([key, label]) => (
            <section key={key}>
              <h2>
                {label} · {data[key].length}
              </h2>
              <Group>
                {data[key].length ? (
                  data[key].map((r, i) => (
                    <Row
                      key={`${r.name}-${i}`}
                      title={r.name}
                      detail={
                        "description" in r
                          ? (r.description ?? r.source)
                          : r.source
                      }
                    >
                      {(key === "skills" || key === "prompts") &&
                        "filePath" in r && (
                          <input
                            type="checkbox"
                            aria-label={`启用${label} ${r.name}`}
                            checked={
                              !work.preferences?.disabledResources?.includes(
                                `${key === "skills" ? "skill" : "prompt"}:${r.filePath}`,
                              )
                            }
                            onChange={(e) => {
                              const id = `${key === "skills" ? "skill" : "prompt"}:${r.filePath}`;
                              void execute(() =>
                                work.mutateStore("clientPreferences.set", {
                                  disabledResources: e.target.checked
                                    ? (
                                        work.preferences?.disabledResources ??
                                        []
                                      ).filter((v) => v !== id)
                                    : [
                                        ...new Set([
                                          ...(work.preferences
                                            ?.disabledResources ?? []),
                                          id,
                                        ]),
                                      ],
                                }),
                              );
                            }}
                          />
                        )}
                    </Row>
                  ))
                ) : (
                  <p className="settings-empty-row">没有已加载的{label}。</p>
                )}
              </Group>
            </section>
          ))}
          {data.diagnostics.length > 0 && (
            <details>
              <summary>加载诊断</summary>
              {data.diagnostics.map((d, i) => (
                <p key={i}>{d.message}</p>
              ))}
            </details>
          )}
        </>
      )}
    </>
  );
}
function Profiles({ work, models, execute, busy }: Controls & { models: ModelControls }) {
  const [routes, setRoutes] = useState<ModelRouteDraft[]>([]);
  const [name, setName] = useState(""),
    [contract, setContract] = useState(""),
    [edit, setEdit] = useState<string | null>(null);
  const save = () =>
    execute(async () => {
      const p = work.snapshot?.agentProfiles.find((p) => p.id === edit);
      await work.mutateStore(
        p ? "agentProfile.update" : "agentProfile.create",
        {
          ...(p
            ? { profileId: p.id, expectedProfileRevision: p.revision }
            : {}),
          name,
          role: "custom",
          roleContract: contract,
          enabled: p?.enabled ?? true,
          modelCandidates: routes.length ? routes.map((row) => row.model) : null,
        },
      );
      setEdit(null);
      setRoutes([]);
      setName("");
      setContract("");
    });
  return (
    <>
      <p className="settings-intro">
        保存可复用的智能体职责与行为约定，已有运行保留启动时的档案快照。
      </p>
      <Group>
        {work.snapshot?.agentProfiles.map((p) => (
          <Row key={p.id} title={profilePresentation(p).name} detail={profilePresentation(p).description}>
            <button
              className="text-button"
              onClick={() => {
                setEdit(p.id);
                setRoutes((p.modelCandidates ?? []).map((model) => ({ id: crypto.randomUUID(), model })));
                setName(profilePresentation(p).name);
                setContract(profilePresentation(p).description);
              }}
            >
              编辑
            </button>
            <input
              type="checkbox"
              aria-label={`启用档案 ${profilePresentation(p).name}`}
              checked={p.enabled}
              disabled={busy}
              onChange={(e) =>
                void execute(() =>
                  work.mutateStore("agentProfile.update", {
                    profileId: p.id,
                    expectedProfileRevision: p.revision,
                    name: p.name,
                    roleContract: p.roleContract,
                    enabled: e.target.checked,
                  }),
                )
              }
            />
          </Row>
        ))}
      </Group>
      <form
        className="settings-editor"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <h2>{edit ? "编辑档案" : "新建档案"}</h2>
        <label>
          名称
          <input
            required
            maxLength={200}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          职责约定
          <textarea
            required
            rows={6}
            value={contract}
            onChange={(e) => setContract(e.target.value)}
          />
        </label>
        <ModelRouteEditor value={routes} onChange={setRoutes} models={models.data?.models ?? []} busy={busy} />
        <div className="dialog-actions">
          {edit && (
            <button
              type="button"
              className="text-button"
              onClick={() => {
                setEdit(null);
                setRoutes([]);
                setName("");
                setContract("");
              }}
            >
              取消
            </button>
          )}
          <button
            disabled={busy || !name.trim() || !contract.trim() || routes.some((row) => !row.model.providerId || !row.model.modelId)}
            className="primary-button"
          >
            保存档案
          </button>
        </div>
      </form>
    </>
  );
}
function Diagnostics({ work, execute, busy }: Controls) {
  const { data, mutate } = useSWR(
    "shell-diagnostics",
    () => api().diagnostics(),
    { refreshInterval: 2000 },
  );
  return (
    <>
      <p className="settings-intro">查看运行服务、连接和应用诊断。</p>
      <Group>
        <Row title="运行服务">
          <span>{data?.hostReady ? "已连接" : "未连接"}</span>
        </Row>
        <Row title="应用版本">
          <span>{data?.version ?? "正在读取"}</span>
        </Row>
        <Row title="Product Store">
          <span>
            {work.snapshot
              ? `版本 ${work.snapshot.schemaVersion} · 修订 ${work.snapshot.storeRevision}`
              : "未连接"}
          </span>
        </Row>
        <Row title="重启运行服务" detail="重新连接前先停止正在执行的任务。">
          <button
            className="text-button"
            disabled={
              busy ||
              work.snapshot?.sessionRuns.some((run) =>
                ["prepared", "running", "waiting"].includes(run.status),
              ) ||
              work.snapshot?.teamRuns.some((run) =>
                ["prepared", "active", "waiting"].includes(run.status),
              )
            }
            onClick={() => void execute(() => work.restart())}
          >
            重新连接
          </button>
        </Row>
      </Group>
      <div className="settings-toolbar">
        <h2>诊断记录</h2>
        <button
          className="text-button"
          onClick={() =>
            void api()
              .clearDiagnostics()
              .then(() => mutate())
          }
        >
          清空记录
        </button>
      </div>
      <Group>
        {data?.events.length ? (
          data.events.map((e, i) => (
            <Row key={i} title={e.message} detail={e.time} />
          ))
        ) : (
          <p className="settings-empty-row">暂无诊断记录。</p>
        )}
      </Group>
    </>
  );
}
function Evolution({ work, execute, busy }: Controls) {
  const [source, setSource] = useState("");
  const { data, mutate } = useSWR(
    "maintenance",
    () => api().request<MaintenanceState>("maintenance.status"),
    { refreshInterval: 1500 },
  );
  const { data: history, mutate: reloadHistory } = useSWR(
    "self-evolution",
    () => api().request<{ receipts: WebReceipt[] }>("selfEvolution.list"),
    { refreshInterval: 1500 },
  );
  const { data: shell } = useSWR("shell-about", () => api().diagnostics());
  const working = data?.status === "running";
  const sourceDirectory = source || data?.sourceDirectory || "";
  const pending = history?.receipts.find((r) => r.state === "session_restored");
  const active =
    work.snapshot?.sessionRuns.some((r) =>
      ["prepared", "running", "waiting"].includes(r.status),
    ) ||
    work.snapshot?.teamRuns.some((r) =>
      ["prepared", "active", "waiting"].includes(r.status),
    );
  const transition = async (direction: "candidate" | "rollback") =>
    execute(() => api().switchCandidate(direction));
  return (
    <>
      <p className="settings-intro">
        验证与构建隔离候选，受控重启后恢复工作台，再由你验收或回滚。
      </p>
      {pending && (
        <Group>
          <Row
            title="候选已恢复原工作台"
            detail="确认可以继续工作后，记录本次人工验收。"
          >
            <button
              className="primary-button"
              disabled={busy}
              onClick={() =>
                void execute(async () => {
                  await work.mutateStore("selfEvolution.transition", {
                    id: pending.id,
                    state: pending.rollbackOf
                      ? "rolled_back"
                      : "manual_accepted",
                  });
                  await reloadHistory();
                })
              }
            >
              确认可继续使用
            </button>
          </Row>
          <Row title="发现问题">
            <button
              className="text-button danger"
              disabled={busy || active}
              onClick={() => void transition("rollback")}
            >
              回滚上一构建
            </button>
          </Row>
        </Group>
      )}
      <Group>
        <Row
          title="D Code 源码目录"
          detail={sourceDirectory || "选择 D Code 项目文件夹"}
        >
          <button
            className="text-button"
            disabled={working}
            onClick={() =>
              void api()
                .chooseDirectory()
                .then((path) => {
                  if (path) setSource(path);
                })
            }
          >
            选择…
          </button>
        </Row>
        <Row title="自动检查" detail="运行 Host 和 Web 客户端的检查与测试。">
          <button
            disabled={busy || working || !sourceDirectory}
            className="text-button"
            onClick={() =>
              void execute(async () => {
                await api().request("maintenance.start", {
                  sourceDirectory,
                  action: "verify",
                });
                await mutate();
              })
            }
          >
            运行检查
          </button>
        </Row>
        <Row title="准备下一构建" detail="生成独立的本地候选，不替换当前应用。">
          <button
            disabled={busy || working || !sourceDirectory}
            className="text-button"
            onClick={() =>
              void execute(async () => {
                await api().request("maintenance.start", {
                  sourceDirectory,
                  action: "build",
                });
                await mutate();
              })
            }
          >
            构建候选
          </button>
        </Row>
      </Group>
      {data && data.status !== "idle" && (
        <>
          <h2>
            {working
              ? "正在执行"
              : data.status === "succeeded"
                ? "执行完成"
                : "需要处理"}
          </h2>
          <p>{data.summary}</p>
          <details><summary>查看构建输出</summary><pre className="maintenance-output">{data.output.join("\n")}</pre></details>
          {data.candidatePath && (
            <div className="dialog-actions">
              <button
                className="text-button"
                onClick={() => void api().revealCandidate(data.candidatePath!)}
              >
                在访达中查看
              </button>
              <button
                className="primary-button"
                disabled={
                  busy || active || working || !shell?.packaged || !!pending
                }
                onClick={() => void transition("candidate")}
              >
                重启到候选并恢复任务
              </button>
            </div>
          )}
        </>
      )}
      <h2>自进化记录</h2>
      <Group>
        {history?.receipts.length ? (
          history.receipts.map((r) => (
            <Row
              key={r.id}
              title={
                (
                  {
                    restart_requested: "已记录重启请求",
                    session_restored: "原任务已恢复，待验收",
                    manual_accepted: "已人工验收",
                    rolled_back: "已回滚",
                    cancelled: "切换未完成，原应用仍在运行",
                    recovery_required: "需要恢复",
                  } as Record<string, string>
                )[r.state] ?? r.state
              }
              detail={
                <>
                  {new Date(r.updatedAt).toLocaleString()}
                  <details>
                    <summary>事件记录</summary>
                    {r.events.map((e, i) => (
                      <p key={i}>
                        {e.kind} · {new Date(e.occurredAt).toLocaleString()}
                      </p>
                    ))}
                  </details>
                </>
              }
            />
          ))
        ) : (
          <p className="settings-empty-row">尚无 Web 客户端自进化记录。</p>
        )}
      </Group>
    </>
  );
}
interface WebReceipt {
  id: string;
  rollbackOf?: string;
  state: string;
  updatedAt: string;
  events: { kind: string; occurredAt: string }[];
}

interface MaintenanceState {
  status: "idle" | "running" | "succeeded" | "failed";
  sourceDirectory?: string;
  summary: string;
  output: string[];
  candidatePath?: string;
}
function About() {
  const { data } = useSWR("shell-about", () => api().diagnostics());
  return (
    <>
      <div className="about-identity">
        <span
          className="logo"
          style={{
            maskImage: `url(${logoUrl})`,
            WebkitMaskImage: `url(${logoUrl})`,
          }}
        />
        <div>
          <h2>D Code</h2>
          <p>版本 {data?.version ?? "0.0.30"}</p>
        </div>
      </div>
      <Group>
        <Row title="作者 GitHub" detail="ssdiwu">
          <button
            className="icon-button"
            aria-label="打开作者 GitHub"
            onClick={() => void api().openExternal("https://github.com/ssdiwu")}
          >
            <ExternalLink size={16} />
          </button>
        </Row>
        <Row title="项目 GitHub" detail="ssdiwu/dcode">
          <button
            className="icon-button"
            aria-label="打开项目 GitHub"
            onClick={() =>
              void api().openExternal("https://github.com/ssdiwu/dcode")
            }
          >
            <ExternalLink size={16} />
          </button>
        </Row>
      </Group>
    </>
  );
}
