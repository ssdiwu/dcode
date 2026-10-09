// 草稿态：新会话未发出首条消息时的输入界面。
// Composer 是视觉主角；有历史时「继续」区为主、推荐动作为辅，无历史时反之。

import { Clock, Sparkles } from "lucide-react";
import type { AppSnapshot, SendMode } from "@/contracts";
import { Composer } from "../components/Composer";
import { useT, type CopyKey } from "../i18n";
import { Banner } from "../components/Banner";

const RECOMMENDED: CopyKey[] = ["draft.recommended.0", "draft.recommended.1", "draft.recommended.2"];

function greetingKey(): CopyKey {
  const hour = new Date().getHours();
  if (hour < 6) return "draft.greeting.lateNight";
  if (hour < 12) return "draft.greeting.morning";
  if (hour < 14) return "draft.greeting.noon";
  if (hour < 18) return "draft.greeting.afternoon";
  return "draft.greeting.evening";
}

export function DraftState({
  snapshot,
  locationLabel,
  draft,
  onDraftChange,
  onSend,
  pendingSendText,
  unknownSendText,
  mode,
  onModeChange,
  onPickRecent,
  onPickRecommended,
  focusKey,
}: {
  snapshot: AppSnapshot;
  locationLabel: string;
  draft: string;
  onDraftChange: (text: string) => void;
  onSend: () => void;
  pendingSendText: string | null;
  unknownSendText: string | null;
  mode: SendMode;
  onModeChange: (mode: SendMode) => void;
  onPickRecent: (sessionId: string) => void;
  onPickRecommended: (text: string) => void;
  focusKey: number;
}) {
  const t = useT();
  // 继续区：有真实历史的近期任务（按会话更新时间，最多 5 个）
  const recent = snapshot.sessions
    .filter((s) => (snapshot.timelines[s.id] ?? []).length > 0)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 5)
    .map((session) => {
      const task = snapshot.tasks.find((t) => t.id === session.taskId);
      const workspace = snapshot.workspaces.find((w) => w.id === task?.workspaceId);
      return { session, task, workspace };
    })
    .filter((entry) => entry.task && entry.workspace);

  const hasHistory = recent.length > 0;
  const configured = snapshot.model.available;

  return (
    <div className="flex flex-1 flex-col items-center justify-center px-8 pb-16">
      <div className="w-full max-w-172 space-y-6">
        <div className="space-y-1.5">
          <p className="text-ui-sm text-subtlest">{t(greetingKey())}</p>
          <h1 className="text-ui-xl font-semibold tracking-tight">{t("draft.title")}</h1>
          <p className="text-ui-sm text-subtlest">{locationLabel}</p>
        </div>

        {!configured && (
          <Banner
            tone="warning"
          >
            {t("draft.modelMissing")}
          </Banner>
        )}

        <Composer
          draft={draft}
          onDraftChange={onDraftChange}
          onSend={onSend}
          run={null}
          disabled={!configured}
          placeholder={configured ? t("draft.composerPlaceholder") : t("draft.composerPlaceholderNoModel")}
          autoFocusKey={focusKey}
          pendingSendText={pendingSendText}
          unknownSendText={unknownSendText}
          mode={mode}
          onModeChange={onModeChange}
        />

        {hasHistory ? (
          <section className="space-y-1.5">
            <h2 className="flex items-center gap-1.5 text-ui-xs font-medium text-subtlest uppercase tracking-wide">
              <Clock className="size-3" />
              {t("draft.continue")}
            </h2>
            <div className="rounded-xl border border-border bg-card divide-y divide-border overflow-hidden">
              {recent.map(({ session, task, workspace }) => (
                <button
                  key={session.id}
                  className="flex w-full items-center gap-3 px-3 py-2 text-left cursor-default hover:bg-hover transition-colors duration-75"
                  onClick={() => onPickRecent(session.id)}
                >
                  <span className="flex-1 min-w-0 truncate text-ui-sm">{session.title}</span>
                  <span className="shrink-0 text-ui-xs text-subtlest">
                    {workspace!.name} / {task!.isDefault ? t("nav.defaultTask") : task!.title}
                  </span>
                </button>
              ))}
            </div>
            <details className="pt-1">
              <summary className="text-ui-xs text-subtlest cursor-default select-none flex items-center gap-1.5">
                <Sparkles className="size-3" />
                {t("draft.recommendedToggle")}
              </summary>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {RECOMMENDED.map((key) => (
                  <button
                    key={key}
                    className="rounded-full border border-border bg-card px-2.5 h-7 text-ui-sm text-subtle hover:bg-hover hover:text-foreground transition-colors duration-75 cursor-default"
                    onClick={() => onPickRecommended(t(key))}
                  >
                    {t(key)}
                  </button>
                ))}
              </div>
            </details>
          </section>
        ) : (
          <section className="space-y-1.5">
            <h2 className="flex items-center gap-1.5 text-ui-xs font-medium text-subtlest uppercase tracking-wide">
              <Sparkles className="size-3" />
              {t("draft.recommendedEmpty")}
            </h2>
            <div className="flex flex-wrap gap-1.5">
              {RECOMMENDED.map((key) => (
                <button
                  key={key}
                  className="rounded-full border border-border bg-card px-2.5 h-7 text-ui-sm text-subtle hover:bg-hover hover:text-foreground transition-colors duration-75 cursor-default"
                  onClick={() => onPickRecommended(t(key))}
                >
                  {t(key)}
                </button>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
