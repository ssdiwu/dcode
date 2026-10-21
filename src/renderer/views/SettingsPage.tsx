// 设置：主工作区内的页面，不整窗替换；侧栏保持可见，Esc 或返回按钮回到会话。
// 草稿在进出设置时保留（界面本地持久化）。
// 模型区双入口：「预设供应商」沿 Pi 正式身份/目录/认证通路；「自定义」保留原四字段+密钥动作。

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import type {
  AppSnapshot,
  AuthEventPayload,
  CatalogModelView,
  ColdStartSetting,
  LanguageSetting,
  ModelCatalogView,
  ModelSetupInput,
  ModelSourcesView,
  ThemeSetting,
} from "@/contracts";
import { useT, type CopyKey } from "../i18n";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { SegmentedControl, SettingsRow, Stepper } from "../components/Controls";
import { ModelSourceBrowser } from "../components/ModelSourceBrowser";

type Section = "appearance" | "startup" | "model" | "resources" | "about";

const SECTIONS: { id: Section; label: CopyKey }[] = [
  { id: "appearance", label: "settings.appearance" },
  { id: "startup", label: "settings.startup" },
  { id: "model", label: "settings.model" },
  { id: "about", label: "settings.about" },
];

export function SettingsPage({
  snapshot,
  onBack,
  onUpdateSettings,
  initialSection = "appearance",
}: {
  snapshot: AppSnapshot;
  onBack: () => void;
  onUpdateSettings: (input: Partial<AppSnapshot["settings"]>) => void;
  /** D02：从缺配置提示进入时直接落在「模型」分区，而不是通用设置首页 */
  initialSection?: Section;
}) {
  const t = useT();
  const [section, setSection] = useState<Section>(initialSection);
  const { settings, model } = snapshot;

  return (
    // 补 min-h-0：窗口滚动只发生在右侧设置内容容器（overflow-y-auto），侧栏不被卷走
    <div className="flex flex-1 min-w-0 min-h-0">
      <div className="w-44 shrink-0 border-r border-[var(--edge)] bg-sidebar px-2 py-3">
        <div className="px-2 pb-2 text-ui-xs font-medium text-subtlest uppercase tracking-wide">{t("settings.title")}</div>
        {[...SECTIONS.slice(0, 3), { id: "resources" as const, label: "settings.resources" as CopyKey }, ...SECTIONS.slice(3)].map((item) => (
          <button
            key={item.id}
            // S01：每项选中状态可辨，并让「当前落在哪个分区」对读屏与自动验收都可判定
            aria-current={section === item.id ? "page" : undefined}
            className={`flex w-full items-center h-7 rounded-md px-2 text-ui-sm cursor-default transition-colors duration-75 ${
              section === item.id ? "bg-selected text-foreground font-medium" : "text-subtle hover:bg-hover hover:text-foreground"
            }`}
            onClick={() => setSection(item.id)}
          >
            {t(item.label)}
            {item.id === "model" && !model.available && (
              <span className="ml-auto size-1.5 rounded-full bg-warning" aria-label={t("settings.modelMissing")} />
            )}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-140 px-6 py-4">
          <header className="flex items-center gap-2 pb-3">
            <Button size="sm" variant="ghost" onClick={onBack}>
              <ArrowLeft className="size-3.5" />
              {t("settings.back")}
            </Button>
            <span className="text-ui-sm text-subtlest">{t("settings.escHint")}</span>
          </header>

          {section === "appearance" && (
            <div className="rounded-xl bg-raised px-4 ring-1 ring-[var(--edge)]">
              <SettingsRow label={t("settings.theme")} hint={t("settings.themeHint")}>
                <SegmentedControl<ThemeSetting>
                  label={t("settings.theme")}
                  value={settings.theme}
                  onChange={(theme) => onUpdateSettings({ theme })}
                  options={[
                    { value: "system", label: t("settings.theme.system") },
                    { value: "light", label: t("settings.theme.light") },
                    { value: "dark", label: t("settings.theme.dark") },
                  ]}
                />
              </SettingsRow>
              <SettingsRow label={t("settings.fontSize")} hint={t("settings.fontSizeHint")}>
                <Stepper
                  label={t("settings.fontSize")}
                  value={settings.fontSize}
                  min={13}
                  max={16}
                  unit="px"
                  onChange={(fontSize) => onUpdateSettings({ fontSize })}
                />
              </SettingsRow>
              <SettingsRow label={t("settings.language")} hint={t("settings.languageHint")}>
                <SegmentedControl<LanguageSetting>
                  label={t("settings.language")}
                  value={settings.language}
                  onChange={(language) => onUpdateSettings({ language })}
                  options={[
                    { value: "system", label: t("settings.theme.system") },
                    { value: "zh", label: "中文" },
                    { value: "en", label: "English" },
                  ]}
                />
              </SettingsRow>
            </div>
          )}

          {section === "startup" && (
            <div className="rounded-xl bg-raised px-4 ring-1 ring-[var(--edge)]">
              <SettingsRow label={t("settings.launch")} hint={t("settings.launchHint")}>
                <SegmentedControl<ColdStartSetting>
                  label={t("settings.launch")}
                  value={settings.coldStart}
                  onChange={(coldStart) => onUpdateSettings({ coldStart })}
                  options={[
                    { value: "restore", label: t("settings.launch.restore") },
                    { value: "home-draft", label: t("settings.launch.homeDraft") },
                  ]}
                />
              </SettingsRow>
            </div>
          )}

          {section === "resources" && (
            <div className="rounded-xl bg-raised px-4 ring-1 ring-[var(--edge)]">
              <SettingsRow label={t("settings.resources")}
                hint={t("settings.resourcesHint")}>
                <SegmentedControl<"off" | "on"> label={t("settings.resources")}
                  value={settings.projectExtensionsEnabled ? "on" : "off"}
                  onChange={(value) => onUpdateSettings({ projectExtensionsEnabled: value === "on" })}
                  options={[{ value: "off", label: t("settings.resourcesOff") }, { value: "on", label: t("settings.resourcesOn") }]} />
              </SettingsRow>
            </div>
          )}

          {section === "model" && (
            <div className="space-y-3">
              {!model.available && (
                <p className="text-ui-sm text-subtle">
                  {t("settings.modelMissingBody")}
                </p>
              )}
              <ModelSection snapshot={snapshot} />
            </div>
          )}

          {section === "about" && (
            <div className="rounded-xl bg-raised px-4 py-3 ring-1 ring-[var(--edge)] space-y-2 text-ui-sm">
              <div className="flex items-center gap-2">
                {/* 同源 D2-R2 猫头鹰；无裁切/反色/滤镜 */}
                <img
                  src={new URL("../assets/dcode-owl.png", import.meta.url).href}
                  alt=""
                  aria-hidden="true"
                  className="app-brand-owl pointer-events-none select-none shrink-0"
                  draggable={false}
                />
                <span className="font-medium">D Code</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function formatTime(t: (k: CopyKey, vars?: Record<string, string>) => string, ts: number): string {
  return new Date(ts).toLocaleString();
}

/** 模型分区：预设供应商 + 自定义双入口（S07/S08 正文）。 */
function ModelSection({ snapshot }: { snapshot: AppSnapshot }) {
  const t = useT();
  const setup = snapshot.modelSetup;
  const [tab, setTab] = useState<"preset" | "custom">(
    setup.kind === "custom" || setup.kind === "preset-with-custom" ? "custom" : "preset",
  );
  const [catalog, setCatalog] = useState<ModelCatalogView | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const view = await window.dcode.listModelCatalog();
        if (!cancelled) {
          setCatalog(view);
          setCatalogError(null);
        }
      } catch (err) {
        if (!cancelled) setCatalogError(String((err as Error)?.message ?? err));
      }
    };
    void load();
    const off = window.dcode.onCatalogChanged(() => void load());
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    setRefreshing(true);
    try {
      await window.dcode.refreshModelCatalog();
      const view = await window.dcode.listModelCatalog();
      setCatalog(view);
      setCatalogError(null);
    } catch (err) {
      setCatalogError(String((err as Error)?.message ?? err));
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <>
      <div className="rounded-xl bg-raised px-4 ring-1 ring-[var(--edge)]">
        <SettingsRow
          label={t("settings.modelRow")}
          hint={
            setup.kind === "preset"
              ? `${setup.providerName} / ${setup.modelName}`
              : setup.kind === "preset-with-custom"
                ? `${setup.preset.providerName} / ${setup.preset.modelName}`
                : setup.kind === "custom"
                  ? `${setup.label} / ${setup.modelId}`
                  : t("settings.modelRowHintEmpty")
          }
        >
          <Badge tone={snapshot.model.available ? "success" : "warning"}>
            {t(snapshot.model.available ? "settings.modelConfigured" : "settings.modelMissing")}
          </Badge>
        </SettingsRow>
      </div>

      <div className="rounded-xl bg-raised px-4 pt-3 ring-1 ring-[var(--edge)]">
        <SegmentedControl<"preset" | "custom">
          label={t("settings.modelSetupTitle")}
          value={tab}
          onChange={setTab}
          options={[
            { value: "preset", label: t("settings.providerTabPreset") },
            { value: "custom", label: t("settings.providerTabCustom") },
          ]}
        />
      </div>

      {/* 自动模式的唯一范围依据：用户配置的候选名单。
          没有名单 = 自动没有范围（不扩大到目录全部）；这份配置不执行工作、不发请求。 */}
      <CandidatePanel snapshot={snapshot} />

      {tab === "preset" ? (
        <PresetPanel
          snapshot={snapshot}
          catalog={catalog}
          catalogError={catalogError}
          refreshing={refreshing}
          onRefresh={() => void refresh()}
          formatTime={(ts) => formatTime(t, ts)}
        />
      ) : (
        <CustomPanel snapshot={snapshot} />
      )}
    </>
  );
}

/**
 * 候选名单配置：从真实来源目录里点名具体模型。
 *
 * 名单是自动路由的**唯一**范围依据：名单外的模型即使目录里有、即使更便宜，也不参与自动选择。
 * 已勾选的项对应 `settings.modelCandidates`，保存走既有 `updateSettings`（保存成立才发布）。
 */
function CandidatePanel({ snapshot }: { snapshot: AppSnapshot }) {
  const t = useT();
  const [sources, setSources] = useState<ModelSourcesView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // 两级浏览的第一级：当前展开的来源；搜索词由共享组件持有
  const [activeSourceId, setActiveSourceId] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    void window.dcode.listModelSources().then((next) => {
      if (!cancelled) setSources(next);
    }).catch((err: unknown) => {
      if (!cancelled) setError(String((err as Error)?.message ?? err));
    });
    return () => { cancelled = true; };
  }, []);

  const chosen = new Set(snapshot.settings.modelCandidates.map((c) => `${c.sourceId}\u0000${c.modelId}`));
  const toggle = async (sourceId: string, modelId: string) => {
    const key = `${sourceId}\u0000${modelId}`;
    const next = chosen.has(key)
      ? snapshot.settings.modelCandidates.filter((c) => `${c.sourceId}\u0000${c.modelId}` !== key)
      : [...snapshot.settings.modelCandidates, { sourceId, modelId }];
    setSaving(true);
    try {
      await window.dcode.updateSettings({ modelCandidates: next });
      setError(null);
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section data-testid="settings-candidates" className="rounded-xl bg-raised px-4 py-3 ring-1 ring-[var(--edge)]">
      <h3 className="text-ui-sm font-medium">{t("settings.candidates.title")}</h3>
      <p className="mt-1 text-ui-xs text-subtle">{t("settings.candidates.hint")}</p>
      {error && <p data-testid="settings-candidates-error" className="mt-1 text-ui-xs opacity-80">{error}</p>}
      {!sources && !error && <p className="mt-2 text-ui-xs text-subtle">{t("settings.candidates.loading")}</p>}
      {sources && sources.sources.length === 0 && (
        <p data-testid="settings-candidates-empty" className="mt-2 text-ui-xs text-subtle">{t("settings.candidates.empty")}</p>
      )}
      <ModelSourceBrowser
        sources={sources?.sources ?? []}
        query={query}
        onQueryChange={setQuery}
        activeSourceId={activeSourceId}
        onActiveSourceChange={setActiveSourceId}
        emptyText="settings.candidates.noMatch"
        searchPlaceholder="settings.candidates.search"
        unconfiguredText="settings.candidates.unconfigured"
        renderModel={(source, model) => {
          const key = `${source.sourceId}\u0000${model.modelId}`;
          const checked = chosen.has(key);
          return (
            <label key={key} className="flex cursor-default items-center gap-2 px-2 py-0.5 text-ui-xs">
              <input
                type="checkbox"
                data-testid={`candidate-${source.sourceId}-${model.modelId}`}
                checked={checked}
                disabled={saving}
                onChange={() => void toggle(source.sourceId, model.modelId)}
              />
              <span>{model.modelLabel}</span>
              <span className="text-subtle">{model.modelId}</span>
            </label>
          );
        }}
      />
      <p data-testid="settings-candidates-count" className="mt-2 text-ui-xs text-subtle">
        {t("settings.candidates.count", { n: snapshot.settings.modelCandidates.length })}
      </p>
    </section>
  );
}

// ---------- 预设供应商面板 ----------

function PresetPanel({
  snapshot,
  catalog,
  catalogError,
  refreshing,
  onRefresh,
  formatTime,
}: {
  snapshot: AppSnapshot;
  catalog: ModelCatalogView | null;
  catalogError: string | null;
  refreshing: boolean;
  onRefresh: () => void;
  formatTime: (ts: number) => string;
}) {
  const t = useT();
  const formId = useId();
  const setup = snapshot.modelSetup;
  const currentPreset = setup.kind === "preset"
    ? setup
    : setup.kind === "preset-with-custom"
      ? setup.preset
      : null;
  const [providerId, setProviderId] = useState<string>(currentPreset?.providerId ?? "");
  const [modelId, setModelId] = useState<string>(currentPreset?.modelId ?? "");
  const [filter, setFilter] = useState("");
  const [applyBusy, setApplyBusy] = useState(false);
  const [applyResult, setApplyResult] = useState<{ ok: boolean; message?: string } | null>(null);

  const provider = catalog?.providers.find((p) => p.id === providerId) ?? null;
  const models: readonly CatalogModelView[] = useMemo(
    () => (catalog && providerId ? catalog.models[providerId] : undefined) ?? [],
    [catalog, providerId],
  );
  const filteredModels = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return models;
    return models.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
  }, [models, filter]);
  const selectedModel = models.find((m) => m.id === modelId) ?? null;

  // 目录刷新后若当前选择消失，保留原选择但不静默替换（界面提示交给 badge/状态）
  const modelStillListed = !modelId || models.some((m) => m.id === modelId);

  const canApply = !applyBusy && providerId.length > 0 && modelId.length > 0 && modelStillListed && provider !== null
    && (selectedModel === null || selectedModel.executable);

  const apply = async () => {
    if (!canApply) return;
    setApplyBusy(true);
    setApplyResult(null);
    try {
      const r = await window.dcode.applyModel({ kind: "preset", providerId, modelId });
      setApplyResult({ ok: r.ok, message: r.ok ? undefined : r.message });
    } catch (err) {
      setApplyResult({ ok: false, message: String((err as Error)?.message ?? err) });
    } finally {
      setApplyBusy(false);
    }
  };

  return (
    <div className="rounded-xl bg-raised px-4 py-3 ring-1 ring-[var(--edge)] space-y-3">
      {/* 目录来源：可编辑保存（setCatalogSource 真实写入并立即完成一次检查；未完成检查之前不显示已更新） */}
      <div className="flex items-center gap-2 py-2 border-b border-[var(--edge)]">
        <div className="min-w-0 flex-1">
          <div className="text-ui-sm">
            {t("settings.catalogSource")}：{catalog?.source.baseUrl ?? "…"}
          </div>
          <div className="text-ui-xs text-subtle">
            {catalog?.source.updating || refreshing
              ? t("settings.catalogUpdating")
              : catalog?.source.lastError
                ? t("settings.catalogError", { message: catalog.source.lastError })
                : catalog?.source.lastSuccessAt
                  ? t("settings.catalogLastSuccess", { time: formatTime(catalog.source.lastSuccessAt) })
                  : t("settings.catalogNever")}
          </div>
          {catalogError && <div className="text-ui-xs text-destructive">{catalogError}</div>}
        </div>
        <Button size="sm" variant="ghost" disabled={refreshing || catalog?.source.updating} onClick={onRefresh}>
          {t("settings.catalogRefresh")}
        </Button>
      </div>
      <CatalogSourceEditor
        current={catalog?.source.baseUrl ?? ""}
        onSaved={onRefresh}
      />

      {/* 供应商选择（label 关联原生 select；键盘可达） */}
      <div className="flex flex-col gap-1 py-2 border-b border-[var(--edge)]">
        <label htmlFor={`${formId}-provider`} className="text-ui-base">{t("settings.presetProvider")}</label>
        <div className="text-ui-sm text-subtle">{t("settings.presetProviderHint")}</div>
        <select
          id={`${formId}-provider`}
          className="w-full h-7 rounded-md border border-[var(--edge)] bg-input px-2 text-ui-sm mt-1"
          value={providerId}
          onChange={(e) => {
            setProviderId(e.target.value);
            setModelId("");
            setApplyResult(null);
          }}
        >
          <option value="">{t("settings.presetPickProvider")}</option>
          {(catalog?.providers ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>

      {/* 认证（按供应商支持的方式展示；无认证也能浏览目录） */}
      {provider && (
        <div className="py-2 border-b border-[var(--edge)] space-y-2">
          <div className="text-ui-base">{t("settings.presetAuth")}</div>
          <div className="text-ui-sm text-subtle">{t("settings.presetAuthHint")}</div>
          <div className="text-ui-xs text-subtlest">
            {provider.hasStoredKey ? t("settings.presetAuthConfigured") : t("settings.presetAuthMissing")}
          </div>
          <AuthControls providerId={provider.id} auth={provider.auth} hasStoredKey={provider.hasStoredKey} />
        </div>
      )}

      {/* 模型选择（目录来源标注；真实参数展示） */}
      {provider && (
        <div className="py-2 space-y-2">
          <label htmlFor={`${formId}-model-filter`} className="text-ui-base">{t("settings.presetModel")}</label>
          <input
            id={`${formId}-model-filter`}
            className="w-full h-7 rounded-md border border-[var(--edge)] bg-input px-2 text-ui-sm"
            placeholder={t("settings.presetModelSearch")}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <div className="max-h-56 overflow-y-auto rounded-md border border-[var(--edge)]">
            {filteredModels.length === 0 ? (
              <div className="px-2 py-3 text-ui-sm text-subtle">{t("settings.presetEmpty")}</div>
            ) : (
              filteredModels.map((m) => (
                <button
                  key={m.id}
                  disabled={!m.executable}
                  className={`flex w-full flex-col items-start gap-0.5 px-2 py-1.5 text-left transition-colors duration-75 ${
                    modelId === m.id ? "bg-selected" : m.executable ? "hover:bg-hover cursor-default" : "opacity-60 cursor-not-allowed"
                  }`}
                  onClick={() => {
                    if (!m.executable) return;
                    setModelId(m.id);
                    setApplyResult(null);
                  }}
                >
                  <span className="text-ui-sm font-mono">{m.id}</span>
                  <span className="text-ui-xs text-subtle">
                    {t("settings.presetModelMeta", { context: String(m.contextWindow), max: String(m.maxTokens) })}
                    {m.input.includes("image") ? ` · ${t("settings.presetModelInputImage")}` : ""}
                    {m.reasoning ? ` · ${t("settings.presetModelReasoning")}` : ""}
                    {` · ${t(m.source === "remote" ? "settings.presetModelSourceRemote" : "settings.presetModelSourceBuiltin")}`}
                    {!m.executable && (
                      <span className="text-warning">
                        {` · ${t("settings.presetModelNotExecutable", { reason: m.reason ?? "" })}`}
                      </span>
                    )}
                  </span>
                </button>
              ))
            )}
          </div>
          {!modelStillListed && (
            <p className="text-ui-xs text-warning">{t("settings.presetUnknownCapability")}</p>
          )}
          <div className="flex justify-end pt-1">
            <Button variant="primary" disabled={!canApply} onClick={() => void apply()}>
              {applyBusy ? t("settings.presetModelApplying") : t("settings.presetModelApply")}
            </Button>
          </div>
          {applyResult && (
            <p className={`text-ui-xs ${applyResult.ok ? "text-success" : "text-destructive"}`}>
              {applyResult.ok ? t("settings.presetModelApplied") : (applyResult.message ?? t("settings.presetModelApplyFailed"))}
            </p>
          )}
        </div>
      )}
      {selectedModel && null}
    </div>
  );
}

/** 目录来源编辑：真实调用 setCatalogSource；未完成检查之前不显示已更新，失败保留原目录并如实呈现。 */
function CatalogSourceEditor({ current, onSaved }: { current: string; onSaved: () => void }) {
  const t = useT();
  const [draft, setDraft] = useState(current);
  const [saving, setSaving] = useState(false);
  const [outcome, setOutcome] = useState<{ ok: boolean; committed?: boolean; message?: string } | null>(null);
  useEffect(() => {
    setDraft(current);
  }, [current]);
  const apply = async () => {
    setSaving(true);
    setOutcome(null);
    try {
      const r = await window.dcode.setCatalogSource({ baseUrl: draft.replace(/\s/g, "") });
      if (r.ok) { setOutcome({ ok: true }); onSaved(); }
      // 来源定义已原子提交但收尾检查未跑：如实说「已保存、检查未完成」，不能说成未保存
      else if (r.issue === "committed-not-checked") setOutcome({ ok: false, committed: true, message: r.message });
      else setOutcome({ ok: false, message: r.message });
    } catch (err) {
      setOutcome({ ok: false, message: String((err as Error)?.message ?? err) });
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="flex flex-col gap-1 py-2 border-b border-[var(--edge)]">
      <label htmlFor="catalog-source-input" className="text-ui-xs text-subtle">{t("settings.catalogSourceEdit")}</label>
      <div className="flex items-center gap-2">
        <input
          id="catalog-source-input"
          className="flex-1 h-7 rounded-md border border-[var(--edge)] bg-input px-2 text-ui-sm font-mono"
          placeholder={t("settings.catalogSourcePlaceholder")}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={saving}
          aria-label={t("settings.catalogSource")}
        />
        <Button size="sm" variant="ghost" disabled={saving || draft.trim() === "" || draft.trim() === current} onClick={() => void apply()}>
          {saving ? t("settings.catalogSourceApplying") : t("settings.catalogSourceApply")}
        </Button>
      </div>
      {outcome && (
        <div className={`text-ui-xs ${outcome.ok ? "text-success" : outcome.committed ? "text-warning" : "text-destructive"}`}>
          {outcome.ok
            ? t("settings.catalogSourceSaved")
            : outcome.committed
              ? t("settings.catalogSourceSavedNotChecked", { message: outcome.message ?? "?" })
              : t("settings.catalogSourceFailed", { message: outcome.message ?? "?" })}
        </div>
      )}
    </div>
  );
}

/** 认证交互：经 onAuthEvent 收 prompt/auth_url；取消走 cancelLogin；结果等待 loginProvider 真实回执。 */
function AuthControls({
  providerId,
  auth,
  hasStoredKey,
}: {
  providerId: string;
  auth: readonly ("api_key" | "oauth")[];
  hasStoredKey: boolean;
}) {
  const t = useT();
  const [loginId, setLoginId] = useState<string | null>(null);
  // loginId 同步 ref：常驻订阅挂载一次，SDK 立即 prompt 不被旧闭包丢弃（避免 loginId 状态 commit 间隙丢事件）
  const loginIdRef = useRef<string | null>(null);
  const [busyType, setBusyType] = useState<"api_key" | "oauth" | null>(null);
  const [prompt, setPrompt] = useState<Extract<AuthEventPayload, { type: "prompt" }> | null>(null);
  const [promptValue, setPromptValue] = useState("");
  interface InfoState {
    type: "auth_url" | "device_code";
    url?: string;
    userCode?: string;
    verificationUri?: string;
  }
  const [info, setInfo] = useState<InfoState | null>(null);
  const [outcome, setOutcome] = useState<{ kind: "done" | "cancelled" | "failed"; message?: string } | null>(null);

  // 切换 provider/卸载（切 custom/离开模型分区）：真实 cancel 在途 login（pending/count 释放），不只 off
  const providerIdRef = useRef(providerId);
  providerIdRef.current = providerId;
  useEffect(() => {
    return () => {
      const id = loginIdRef.current;
      if (id) void window.dcode.cancelLogin({ loginId: id }).catch(() => undefined);
    };
  }, [providerId]);

  useEffect(() => {
    const off = window.dcode.onAuthEvent((event) => {
      const current = loginIdRef.current;
      if (!current || event.loginId !== current) return;
      if (event.type === "prompt") {
        setPrompt(event);
        setPromptValue("");
      } else if (event.type === "auth_url") {
        setInfo({ type: "auth_url", url: event.url });
      } else if (event.type === "device_code") {
        setInfo({ type: "device_code", userCode: event.userCode, verificationUri: event.verificationUri });
      }
    });
    return off;
  }, []);

  const start = async (type: "api_key" | "oauth") => {
    const id = `login-${providerId}-${Date.now().toString(36)}`;
    loginIdRef.current = id;
    setLoginId(id);
    setBusyType(type);
    setOutcome(null);
    setPrompt(null);
    setInfo(null);
    try {
      const r = await window.dcode.loginProvider({ loginId: id, providerId, type });
      setOutcome(r.ok ? { kind: "done" } : { kind: r.issue === "cancelled" ? "cancelled" : "failed", message: r.message });
    } catch (err) {
      setOutcome({ kind: "failed", message: String((err as Error)?.message ?? err) });
    } finally {
      setBusyType(null);
      setPrompt(null);
      loginIdRef.current = null;
      setLoginId(null);
    }
  };

  const cancel = async () => {
    const id = loginIdRef.current;
    if (!id) return;
    await window.dcode.cancelLogin({ loginId: id });
  };

  const submitPrompt = async () => {
    if (!prompt) return;
    const requestId = prompt.requestId;
    setPrompt(null);
    await window.dcode.replyAuthPrompt({ requestId, value: promptValue });
  };

  const cancelPrompt = async () => {
    if (!prompt) return;
    const requestId = prompt.requestId;
    setPrompt(null);
    await window.dcode.replyAuthPrompt({ requestId, cancel: true });
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {auth.includes("api_key") && (
          <Button size="sm" variant="outline" disabled={busyType !== null} onClick={() => void start("api_key")}>
            {hasStoredKey ? t("settings.presetAuthReauth") : t("settings.presetAuthApiKey")}
          </Button>
        )}
        {auth.includes("oauth") && (
          <Button size="sm" variant="outline" disabled={busyType !== null} onClick={() => void start("oauth")}>
            {t("settings.presetAuthOAuth")}
          </Button>
        )}
        {loginId && (
          <Button size="sm" variant="ghost" onClick={() => void cancel()}>
            {t("settings.authCancel")}
          </Button>
        )}
      </div>
      {loginId && !prompt && (
        <p className="text-ui-xs text-subtle">{t("settings.authInProgress")}</p>
      )}
      {info?.type === "auth_url" && (
        <p className="text-ui-xs break-all">
          <a className="text-accent underline" href={info.url} target="_blank" rel="noreferrer">{info.url}</a>
        </p>
      )}
      {info?.type === "device_code" && (
        <p className="text-ui-xs">{t("settings.authDeviceCode", { uri: info.verificationUri ?? "", code: info.userCode ?? "" })}</p>
      )}
      {prompt && (
        <div className="rounded-md border border-[var(--edge)] bg-input p-2 space-y-2">
          <label htmlFor={`auth-prompt-input-${prompt.requestId}`} className="block text-ui-sm">{prompt.message}</label>
          {prompt.kind === "select" ? (
            <div className="flex flex-col gap-1">
              {(prompt.options ?? []).map((o) => (
                <label key={o.id} className="flex items-center gap-2 text-ui-sm">
                  <input
                    type="radio"
                    name={prompt.requestId}
                    value={o.id}
                    checked={promptValue === o.id}
                    onChange={() => setPromptValue(o.id)}
                  />
                  <span>{o.label}{o.description ? ` — ${o.description}` : ""}</span>
                </label>
              ))}
            </div>
          ) : (
            <input
              id={`auth-prompt-input-${prompt.requestId}`}
              className="w-full h-7 rounded-md border border-[var(--edge)] bg-raised px-2 text-ui-sm"
              type={prompt.kind === "secret" ? "password" : "text"}
              autoComplete="off"
              placeholder={prompt.placeholder}
              value={promptValue}
              onChange={(e) => setPromptValue(e.target.value)}
            />
          )}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => void cancelPrompt()}>{t("common.cancel")}</Button>
            <Button size="sm" variant="primary" disabled={prompt.kind === "select" && promptValue.length === 0} onClick={() => void submitPrompt()}>
              {t("settings.authPromptSubmit")}
            </Button>
          </div>
        </div>
      )}
      {outcome && (
        <p className={`text-ui-xs ${outcome.kind === "done" ? "text-success" : outcome.kind === "cancelled" ? "text-subtle" : "text-destructive"}`}>
          {outcome.kind === "done" ? t("settings.authDone") : outcome.kind === "cancelled" ? t("settings.authCancelled") : (outcome.message ?? t("settings.authFailed"))}
        </p>
      )}
    </div>
  );
}

// ---------- 自定义面板（保留原四字段 + 密钥动作） ----------

type ModelForm = {
  provider: ModelSetupInput["provider"];
  label: string;
  modelId: string;
  baseUrl: string;
  keyAction: ModelSetupInput["keyAction"];
  apiKey: string;
};

function CustomPanel({ snapshot }: { snapshot: AppSnapshot }) {
  const t = useT();
  const setup = snapshot.modelSetup;
  // 可访问名称关联：四个可见字段由真实 <label htmlFor> 关联（前缀 useId 稳定且不重名）
  const formId = useId();
  // 自定义定义独立于当前选择保留：preset-with-custom 时从 customDefinition 回显（非空表单）
  const existing = setup.kind === "custom"
    ? setup
    : setup.kind === "preset-with-custom" && setup.custom
      ? setup.custom
      : null;
  const [form, setForm] = useState<ModelForm>({
    provider: existing?.provider ?? "openai-completions",
    label: existing?.label ?? "",
    modelId: existing?.modelId ?? "",
    baseUrl: existing?.baseUrl ?? "",
    keyAction: existing ? "keep" : "replace",
    apiKey: "",
  });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message?: string } | null>(null);

  const validUrl = (() => {
    try {
      const u = new URL(form.baseUrl);
      return (u.protocol === "http:" || u.protocol === "https:") && !u.username && !u.password;
    } catch { return false; }
  })();
  const canSubmit = !busy
    && form.label.trim().length > 0
    && form.modelId.trim().length > 0
    && validUrl
    && (form.keyAction !== "replace" || form.apiKey.length > 0);

  const onSubmit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setResult(null);
    try {
      const r = await window.dcode.configureModel({
        provider: form.provider,
        label: form.label.trim(),
        modelId: form.modelId.trim(),
        baseUrl: form.baseUrl.trim(),
        keyAction: form.keyAction,
        ...(form.keyAction === "replace" ? { apiKey: form.apiKey } : {}),
      });
      setResult({ ok: r.ok, message: r.ok ? undefined : r.message });
      if (r.ok) setForm((f) => ({ ...f, apiKey: "", keyAction: "keep" }));
    } catch (err) {
      setResult({ ok: false, message: String((err as Error)?.message ?? err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl bg-raised px-4 py-3 ring-1 ring-[var(--edge)] space-y-3">
      <div className="flex items-center justify-between">
        <span className="font-medium text-ui-sm">{t("settings.customEntryHint")}</span>
        {existing && (
          <Badge tone={existing.note === "ready" ? "success" : existing.note === "connect-failed" ? "warning" : "neutral"}>
            {t(`settings.modelSetupNote.${existing.note}` as CopyKey)}
          </Badge>
        )}
      </div>

      <div className="space-y-2.5">
        <div className="flex flex-col gap-1 py-3 border-b border-[var(--edge)] last:border-b-0">
          <div className="text-ui-base">{t("settings.modelSetupProvider")}</div>
          <div className="text-ui-sm text-subtle">{t("settings.modelSetupProviderHint")}</div>
          <div className="mt-1">
            <SegmentedControl<ModelSetupInput["provider"]>
              label={t("settings.modelSetupProvider")}
              value={form.provider}
              onChange={(provider) => setForm((f) => ({ ...f, provider }))}
              options={[
                { value: "openai-completions", label: t("settings.modelSetupProviderOpenAI") },
                { value: "anthropic-messages", label: t("settings.modelSetupProviderAnthropic") },
              ]}
            />
          </div>
        </div>

        <div className="flex flex-col gap-1 py-3 border-b border-[var(--edge)] last:border-b-0">
          <label htmlFor={`${formId}-label`} className="text-ui-base">{t("settings.modelSetupLabel")}</label>
          <div className="text-ui-sm text-subtle">{t("settings.modelSetupLabelHint")}</div>
          <input
            id={`${formId}-label`}
            className="w-full h-7 rounded-md border border-[var(--edge)] bg-input px-2 text-ui-sm mt-1"
            placeholder={t("settings.modelSetupLabelPlaceholder")}
            value={form.label}
            onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
          />
        </div>

        <div className="flex flex-col gap-1 py-3 border-b border-[var(--edge)] last:border-b-0">
          <label htmlFor={`${formId}-model-id`} className="text-ui-base">{t("settings.modelSetupModelId")}</label>
          <div className="text-ui-sm text-subtle">{t("settings.modelSetupModelIdHint")}</div>
          <input
            id={`${formId}-model-id`}
            className="w-full h-7 rounded-md border border-[var(--edge)] bg-input px-2 text-ui-sm font-mono mt-1"
            placeholder="gpt-4o-mini / claude-sonnet-4.5"
            value={form.modelId}
            onChange={(e) => setForm((f) => ({ ...f, modelId: e.target.value }))}
          />
        </div>

        <div className="flex flex-col gap-1 py-3 border-b border-[var(--edge)] last:border-b-0">
          <label htmlFor={`${formId}-base-url`} className="text-ui-base">{t("settings.modelSetupBaseUrl")}</label>
          <div className="text-ui-sm text-subtle">{t("settings.modelSetupBaseUrlHint")}</div>
          <input
            id={`${formId}-base-url`}
            className="w-full h-7 rounded-md border border-[var(--edge)] bg-input px-2 text-ui-sm font-mono mt-1"
            placeholder="https://api.openai.com/v1"
            value={form.baseUrl}
            onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
          />
          {!validUrl && form.baseUrl.length > 0 && (
            <p className="mt-1 text-ui-xs text-destructive">{t("settings.modelSetupBaseUrlInvalid")}</p>
          )}
        </div>

        <div className="flex flex-col gap-1 py-3 border-b border-[var(--edge)] last:border-b-0">
          <div className="text-ui-base">{t("settings.modelSetupKey")}</div>
          <div className="text-ui-sm text-subtle">{t("settings.modelSetupKeyHint")}</div>
          <div className="mt-1">
            <SegmentedControl<ModelSetupInput["keyAction"]>
              label={t("settings.modelSetupKey")}
              value={form.keyAction}
              onChange={(keyAction) => setForm((f) => ({ ...f, keyAction }))}
              options={[
                ...(existing ? [{ value: "keep" as const, label: t("settings.modelSetupKeyKeep") }] : []),
                { value: "replace", label: t("settings.modelSetupKeyReplace") },
                ...(existing ? [{ value: "clear" as const, label: t("settings.modelSetupKeyClear") }] : []),
              ]}
            />
          </div>
        </div>

        {form.keyAction === "replace" && (
          <div className="flex flex-col gap-1 py-3 border-b border-[var(--edge)] last:border-b-0">
            <label htmlFor={`${formId}-api-key`} className="text-ui-base">{t("settings.modelSetupApiKey")}</label>
            <div className="text-ui-sm text-subtle">{t("settings.modelSetupApiKeyHint")}</div>
            <input
              id={`${formId}-api-key`}
              type="password"
              autoComplete="off"
              className="w-full h-7 rounded-md border border-[var(--edge)] bg-input px-2 text-ui-sm mt-1"
              placeholder={t("settings.modelSetupApiKeyPlaceholder")}
              value={form.apiKey}
              onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
            />
          </div>
        )}
      </div>

      {result && !result.ok && (
        <p className="text-ui-xs text-destructive">{result.message ?? t("settings.modelSetupFailed")}</p>
      )}
      {result?.ok && (
        <p className="text-ui-xs text-success">{t("settings.modelSetupSaved")}</p>
      )}

      <div className="flex justify-end pt-1">
        <Button variant="primary" disabled={!canSubmit} onClick={() => void onSubmit()}>
          {busy ? t("settings.modelSetupSaving") : t("settings.modelSetupSave")}
        </Button>
      </div>
    </div>
  );
}
