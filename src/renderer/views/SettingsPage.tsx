// 设置：主工作区内的页面，不整窗替换；侧栏保持可见，Esc 或返回按钮回到会话。
// 草稿在进出设置时保留（界面本地持久化）。

import { useId, useState } from "react";
import { ArrowLeft } from "lucide-react";
import type { AppSnapshot, ColdStartSetting, LanguageSetting, ModelSetupInput, ThemeSetting } from "@/contracts";
import { useT, type CopyKey } from "../i18n";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { SegmentedControl, SettingsRow, Stepper } from "../components/Controls";

type ModelForm = {
  provider: ModelSetupInput["provider"];
  label: string;
  modelId: string;
  baseUrl: string;
  keyAction: ModelSetupInput["keyAction"];
  apiKey: string;
};

type Section = "appearance" | "startup" | "model" | "about";

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
}: {
  snapshot: AppSnapshot;
  onBack: () => void;
  onUpdateSettings: (input: Partial<AppSnapshot["settings"]>) => void;
}) {
  const t = useT();
  const [section, setSection] = useState<Section>("appearance");
  const { settings, model } = snapshot;

  return (
    // 补 min-h-0：flex 子项默认 min-height:auto，App.main 虽已 min-h-0，但嵌套 flex 子项在自然高度
    // 大于容器时仍会撑出主区；此处确保窗口滚动只发生在右侧设置内容容器（overflow-y-auto），
    // 侧栏品牌/任务树/底部导航不被卷走。
    <div className="flex flex-1 min-w-0 min-h-0">
      <div className="w-44 shrink-0 border-r border-border bg-sidebar px-2 py-3">
        <div className="px-2 pb-2 text-ui-xs font-medium text-subtlest uppercase tracking-wide">{t("settings.title")}</div>
        {SECTIONS.map((item) => (
          <button
            key={item.id}
            className={`flex w-full items-center h-7 rounded-md px-2 text-ui-sm cursor-default transition-colors duration-75 ${
              section === item.id ? "bg-selected text-foreground" : "text-subtle hover:bg-hover hover:text-foreground"
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
            <div className="rounded-xl border border-border bg-card px-4">
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
            <div className="rounded-xl border border-border bg-card px-4">
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

          {section === "model" && (
            <div className="space-y-3">
              {!model.available && (
                <p className="text-ui-sm text-subtle">
                  {t("settings.modelMissingBody")}
                </p>
              )}
              <div className="rounded-xl border border-border bg-card px-4">
                <SettingsRow
                  label={t("settings.modelRow")}
                  hint={model.available ? t("settings.modelRowHintConfigured", { name: model.name ?? "" }) : t("settings.modelRowHintEmpty")}
                >
                  <Badge tone={model.available ? "success" : "warning"}>{t(model.available ? "settings.modelConfigured" : "settings.modelMissing")}</Badge>
                </SettingsRow>
              </div>
              <ModelSetupCard snapshot={snapshot} />
            </div>
          )}

          {section === "about" && (
            <div className="rounded-xl border border-border bg-card px-4 py-3 space-y-2 text-ui-sm">
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

function ModelSetupCard({ snapshot }: { snapshot: AppSnapshot }) {
  const t = useT();
  const setup = snapshot.modelSetup;
  // 可访问名称关联：四个可见字段由真实 <label htmlFor> 关联（前缀 useId 稳定且不重名）
  const formId = useId();
  const existing = setup.kind === "configured" ? setup : null;
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
    <div className="rounded-xl border border-border bg-card px-4 py-3 space-y-3">
      <div className="flex items-center justify-between">
        <span className="font-medium text-ui-sm">{t("settings.modelSetupTitle")}</span>
        {existing && (
          <Badge tone={existing.note === "ready" ? "success" : existing.note === "connect-failed" ? "warning" : "neutral"}>
            {t(`settings.modelSetupNote.${existing.note}`)}
          </Badge>
        )}
      </div>

      <div className="space-y-2.5">
        <div className="flex flex-col gap-1 py-3 border-b border-border last:border-b-0">
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

        {/*
          长输入字段使用纵向排列：与 SettingsRow（左右分布 + shrink-0 内容）布局语义不同，
          保留 label/hint 上移 + input 全宽，避免在 720 窄窗下 label 被挤至 0 宽、输入被裁切。
          使用 DESIGN 已有 text/border/spacing token，不引入新共享样式。
        */}
        <div className="flex flex-col gap-1 py-3 border-b border-border last:border-b-0">
          <label htmlFor={`${formId}-label`} className="text-ui-base">{t("settings.modelSetupLabel")}</label>
          <div className="text-ui-sm text-subtle">{t("settings.modelSetupLabelHint")}</div>
          <input
            id={`${formId}-label`}
            className="w-full h-7 rounded-md border border-border bg-input px-2 text-ui-sm mt-1"
            placeholder={t("settings.modelSetupLabelPlaceholder")}
            value={form.label}
            onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
          />
        </div>

        <div className="flex flex-col gap-1 py-3 border-b border-border last:border-b-0">
          <label htmlFor={`${formId}-model-id`} className="text-ui-base">{t("settings.modelSetupModelId")}</label>
          <div className="text-ui-sm text-subtle">{t("settings.modelSetupModelIdHint")}</div>
          <input
            id={`${formId}-model-id`}
            className="w-full h-7 rounded-md border border-border bg-input px-2 text-ui-sm font-mono mt-1"
            placeholder="gpt-4o-mini / claude-sonnet-4.5"
            value={form.modelId}
            onChange={(e) => setForm((f) => ({ ...f, modelId: e.target.value }))}
          />
        </div>

        <div className="flex flex-col gap-1 py-3 border-b border-border last:border-b-0">
          <label htmlFor={`${formId}-base-url`} className="text-ui-base">{t("settings.modelSetupBaseUrl")}</label>
          <div className="text-ui-sm text-subtle">{t("settings.modelSetupBaseUrlHint")}</div>
          <input
            id={`${formId}-base-url`}
            className="w-full h-7 rounded-md border border-border bg-input px-2 text-ui-sm font-mono mt-1"
            placeholder="https://api.openai.com/v1"
            value={form.baseUrl}
            onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
          />
          {!validUrl && form.baseUrl.length > 0 && (
            <p className="mt-1 text-ui-xs text-destructive">{t("settings.modelSetupBaseUrlInvalid")}</p>
          )}
        </div>

        <div className="flex flex-col gap-1 py-3 border-b border-border last:border-b-0">
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
          <div className="flex flex-col gap-1 py-3 border-b border-border last:border-b-0">
            <label htmlFor={`${formId}-api-key`} className="text-ui-base">{t("settings.modelSetupApiKey")}</label>
            <div className="text-ui-sm text-subtle">{t("settings.modelSetupApiKeyHint")}</div>
            <input
              id={`${formId}-api-key`}
              type="password"
              autoComplete="off"
              className="w-full h-7 rounded-md border border-border bg-input px-2 text-ui-sm mt-1"
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
