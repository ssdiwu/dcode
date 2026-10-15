// 草稿态：新会话未发出首条消息时的输入界面。
// 层次：输入区是视觉主角 → 缺配置的真实修复入口 → 工作位置 → 问候；
// 「继续」与推荐动作都是次级辅助，且只呈现真实记录，不堆演示卡片（spec D01–D05）。

import { ArrowRight, Clock, Settings as SettingsIcon, Sparkles } from "lucide-react";
import type { AppSnapshot, SendMode , WorkReference} from "@/contracts";
import { Composer } from "../components/Composer";
import { useT, type CopyKey } from "../i18n";
import { Banner } from "../components/Banner";
import { Button } from "../components/Button";

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
  referenceScope,
  sessionModelState,
  references,
  onReferencesChange,
  pendingSendText,
  unknownSendText,
  mode,
  onModeChange,
  onPickRecent,
  onPickRecommended,
  onOpenSettings,
  focusKey,
}: {
  snapshot: AppSnapshot;
  locationLabel: string;
  draft: string;
  onDraftChange: (text: string) => void;
  /** C05：发送时带上这一版引用；新任务草稿同样可引用，但不因此创建或发送会话对象 */
  onSend: (references: readonly WorkReference[]) => void;
  /**
   * C05 引用归属：已有会话给 sessionId（含空时间线会话——它同样有正式归属），
   * 新任务草稿给 taskId；两者都没有时入口不可用。
   * 浏览与选取不因此创建或发送任何会话对象。
   */
  referenceScope?: { sessionId?: string; taskId?: string } | null;
  /** 该会话的模型状态（C07 第一层事实来源）；新任务草稿为 null，入口如实不可用 */
  sessionModelState?: import("@/contracts").SessionModelState | null;
  references?: readonly WorkReference[];
  onReferencesChange?: (update: (current: readonly WorkReference[]) => readonly WorkReference[]) => void;
  pendingSendText: string | null;
  unknownSendText: string | null;
  mode: SendMode;
  onModeChange: (mode: SendMode) => void;
  onPickRecent: (sessionId: string) => void;
  onPickRecommended: (text: string) => void;
  /** D02：缺配置时到真实配置位置，草稿保留 */
  onOpenSettings: () => void;
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
    <div className="flex flex-1 flex-col items-center justify-center px-8 pb-14">
      <div className="w-full max-w-172 space-y-5">
        {/* 标题保留屏幕身份（也是 E2E 与读屏的稳定锚点），但压到区块标题档：
            视觉主角是下面的输入卡片，问候与工作位置只作为一行辅助说明。
            标题在前是为了读屏与 Tab 顺序先拿到「这是哪里」，不是靠字号抢注意力。 */}
        <div className="space-y-1">
          <h1 className="text-ui-lg font-semibold tracking-tight">{t("draft.title")}</h1>
          <div className="flex items-baseline gap-2">
            <p className="truncate text-ui-sm text-subtle">{locationLabel}</p>
            <p className="shrink-0 text-ui-sm text-subtlest" aria-hidden="true">·</p>
            <p className="shrink-0 text-ui-sm text-subtlest">{t(greetingKey())}</p>
          </div>
        </div>

        {/* D02：缺配置不是一句提示就结束，给出到真实配置位置的入口；草稿保持可编辑 */}
        {!configured && (
          <Banner
            tone="warning"
            actions={
              <Button size="sm" variant="outline" onClick={onOpenSettings}>
                <SettingsIcon className="size-3.5" />
                {t("draft.openSettings")}
              </Button>
            }
          >
            {t("draft.modelMissing")}
          </Banner>
        )}

        {/* 视觉主角：输入卡片。draft 首屏仍按冷启动规格居中呈现 */}
        <Composer
          draft={draft}
          onDraftChange={onDraftChange}
          onSend={onSend}
          referenceScope={referenceScope ?? null}
          references={references}
          onReferencesChange={onReferencesChange}
          run={null}
          disabled={!configured}
          placeholder={configured ? t("draft.composerPlaceholder") : t("draft.composerPlaceholderNoModel")}
          autoFocusKey={focusKey}
          pendingSendText={pendingSendText}
          unknownSendText={unknownSendText}
          mode={mode}
          onModeChange={onModeChange}
          // D 片 C07：空会话同样按 sessionId 归属，模型入口在草稿页也可用（选模型不发送、不启动执行）
          sessionModelState={sessionModelState ?? null}
        />

        {hasHistory ? (
          <section className="space-y-1">
            <h2 className="flex items-center gap-1.5 text-ui-xs font-medium uppercase tracking-wide text-subtlest">
              <Clock className="size-3" />
              {t("draft.continue")}
            </h2>
            {/* 继续列表：靠行高与分隔（divide-y 用极弱 edge）组织，不再套一圈卡片边框 */}
            <div className="divide-y divide-[var(--edge)] overflow-hidden rounded-xl bg-raised px-1 shadow-[var(--shadow-sm)] ring-1 ring-[var(--edge)]">
              {recent.map(({ session, task, workspace }) => (
                <button
                  key={session.id}
                  className="group flex w-full cursor-default items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors duration-75 hover:bg-hover"
                  onClick={() => onPickRecent(session.id)}
                >
                  <span className="min-w-0 flex-1 truncate text-ui-sm">{session.title}</span>
                  <span className="shrink-0 text-ui-xs text-subtlest">
                    {workspace!.name} / {task!.isDefault ? t("nav.defaultTask") : task!.title}
                  </span>
                  <ArrowRight className="size-3.5 shrink-0 text-subtlest opacity-0 transition-opacity duration-75 group-hover:opacity-100" />
                </button>
              ))}
            </div>
            <details className="pt-1.5">
              <summary className="flex cursor-default select-none items-center gap-1.5 text-ui-xs text-subtlest">
                <Sparkles className="size-3" />
                {t("draft.recommendedToggle")}
              </summary>
              <RecommendedActions onPick={onPickRecommended} />
            </details>
          </section>
        ) : (
          <section className="space-y-1">
            <h2 className="flex items-center gap-1.5 text-ui-xs font-medium uppercase tracking-wide text-subtlest">
              <Sparkles className="size-3" />
              {t("draft.recommendedEmpty")}
            </h2>
            {/* 无历史时推荐动作是主要辅助入口：把文字填入草稿并聚焦，不自动发送（D04） */}
            <RecommendedActions onPick={onPickRecommended} />
          </section>
        )}
      </div>
    </div>
  );
}

/** 推荐动作：弱按钮形态（不是卡片）。点击只填入草稿并聚焦，不创建任务、不发送。 */
function RecommendedActions({ onPick }: { onPick: (text: string) => void }) {
  const t = useT();
  return (
    <div className="flex flex-wrap gap-1.5">
      {RECOMMENDED.map((key) => (
        <button
          key={key}
          className="h-7 cursor-default rounded-full bg-raised px-2.5 text-ui-sm text-subtle ring-1 ring-[var(--edge)] transition-colors duration-75 hover:bg-hover hover:text-foreground"
          onClick={() => onPick(t(key))}
        >
          {t(key)}
        </button>
      ))}
    </div>
  );
}
