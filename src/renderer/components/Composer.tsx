// Composer：视觉主角。rounded-2xl 容器壳是 2xl 圆角的少数例外之一；
// 焦点反馈由容器壳统一承担（input-surface），textarea 本身没有焦点框。
// C01–C06（spec/页面与交互组件.md）：主运行按钮只有一个稳定位置，发送／暂停／继续互斥呈现，
// 按「先看实际运行约束，再看本次输入」由 derivePrimaryAction 推得；
// 「新文字」不含同一次已发送、仍待回执／待核对的旧文字（原消息由回执与回查负责）。
// 输入选项菜单是次级入口：发送方式（引导／稍后处理，互斥可辨）与运行操作（菜单内暂停）分组，
// 菜单打开、关闭与选项查看都不执行工作；Esc／点击外部只关闭菜单。

import { useEffect, useRef, useState } from "react";
import { ArrowUp, ChevronDown, Pause, Play } from "lucide-react";
import type { RunState, SendMode } from "@/contracts";
import { IconButton } from "./Button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { useT } from "../i18n";
import type { CopyKey } from "../i18n";

/** 主按钮的唯一动作；disabled 形态也绑定同一个位置与随时可辨的文案来源。 */
export type PrimaryAction = "send" | "sending" | "checking" | "pause" | "pausing" | "resume" | "unavailable";

/**
 * C01 状态表（spec/页面与交互组件.md#主按钮状态表）：
 * 判断先看实际运行约束（暂停处理中 > 已暂停 > 运行故障 > 运行中），
 * 已确认运行时按有无「新文字」选择发送或暂停——回执在途／未知不取消仍然有效的运行控制；
 * 只有尚无已确认运行状态时，本次发送的回执等待才呈现「发送中」防重、未知才呈现「待核对」。
 * 配置不足只限制相应发送，不得禁用仍然有效的暂停或继续。
 */
export function derivePrimaryAction(args: {
  hasNewDraft: boolean;
  run: RunState | null;
  /** 是否缺少必要配置（原型：未配置模型） */
  unconfigured: boolean;
  /** 同一次发送（文字未变的旧输入）等待回执 */
  sendPending: boolean;
  /** 同一次发送（文字未变的旧输入）接收结果未知 */
  sendUnknown: boolean;
}): { action: PrimaryAction; enabled: boolean } {
  const { hasNewDraft, run, unconfigured, sendPending, sendUnknown } = args;
  switch (run?.status) {
    case "pausing":
      return { action: "pausing", enabled: false };
    case "paused":
      return { action: "resume", enabled: true };
    case "faulted":
      return { action: "unavailable", enabled: false };
    case "running":
      return hasNewDraft ? { action: "send", enabled: !unconfigured } : { action: "pause", enabled: true };
    default: {
      // 尚无已确认运行状态（ready／草稿态／本轮已自然收束）
      if (hasNewDraft) return { action: "send", enabled: !unconfigured };
      if (sendUnknown) return { action: "checking", enabled: false };
      if (sendPending) return { action: "sending", enabled: false };
      return { action: "send", enabled: false };
    }
  }
}

export function Composer({
  draft,
  onDraftChange,
  onSend,
  run,
  onPause,
  onResume,
  disabled,
  placeholder,
  autoFocusKey,
  pendingSendText = null,
  unknownSendText = null,
  resumePending = false,
  menuSide = "down",
  mode,
  onModeChange,
}: {
  draft: string;
  onDraftChange: (text: string) => void;
  onSend: () => void;
  run: RunState | null;
  onPause?: () => void;
  /** 返回在途请求的真实 Promise：继续的防重随其 settle 自然结束（失败后可重试） */
  onResume?: () => Promise<void>;
  /** 该会话恢复请求的在途事实（T08：恢复条与本按钮共用同一防重） */
  resumePending?: boolean;
  disabled?: boolean;
  placeholder: string;
  /** 变化时重新聚焦（例如点击推荐动作后） */
  autoFocusKey?: string | number;
  /** 同一次已发送且仍等待回执的旧文字（文字未变时它不是新草稿） */
  pendingSendText?: string | null;
  /** 同一次已发送且接收结果待核对的旧文字（文字未变时它不是新草稿） */
  unknownSendText?: string | null;
  /** 菜单的展开方向：共享默认向下；会话页贴底卡片传 "up"（不被滚动容器裁切） */
  menuSide?: "down" | "up";
  mode: SendMode;
  onModeChange: (mode: SendMode) => void;
}) {
  const t = useT();
  const [composing, setComposing] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (autoFocusKey !== undefined) areaRef.current?.focus();
  }, [autoFocusKey]);

  const draftTrim = draft.trim();
  // 「新文字」：非空且不是同一次已发送、尚待回执／待核对的旧文字
  const oldSendText = (pendingSendText ?? unknownSendText)?.trim() ?? null;
  const hasNewDraft = draftTrim.length > 0 && draftTrim !== oldSendText;
  const unconfigured = Boolean(disabled);
  const { action, enabled } = derivePrimaryAction({
    hasNewDraft,
    run,
    unconfigured,
    sendPending: Boolean(pendingSendText),
    sendUnknown: Boolean(unknownSendText),
  });

  const primary = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (!enabled) return;
    if (action === "send") {
      onSend();
    } else if (action === "pause") {
      // 同一次双击手势的第二击（event.detail === 2）不得在按钮刚切成暂停时误触暂停；
      // 时间无关：按实际点击手势身份区分，用户随后的新一次明确暂停不受限制
      if (event.detail >= 2) return;
      onPause?.();
    } else if (action === "resume") {
      // 在途防重的事实由 App 持有（恢复条与本按钮交错连点在同一身份下只执行一次）：这里只呈报动作
      if (resumePending) return;
      void Promise.resolve(onResume?.());
    }
  };

  /** Enter 仅尝试发送新文字（C02）；待核对旧发送经 T02 回查、确认未接收后经 T03 重试：
   *  暂停中输入框 Enter 仍尝试发送新文字（执行通路如实拒收），不代替明确继续；
   *  空 Enter、待回执中的同次旧发送、配置缺失、运行故障不触发动作。 */
  const canAttemptSend =
    !unconfigured &&
    run?.status !== "faulted" &&
    hasNewDraft;
  const trySend = () => {
    if (!canAttemptSend) return;
    onSend();
  };

  const buttonVisual: Record<PrimaryAction, { icon: typeof ArrowUp; label: CopyKey }> = {
    send: { icon: ArrowUp, label: "composer.send" },
    sending: { icon: ArrowUp, label: "composer.sending" },
    checking: { icon: ArrowUp, label: "composer.checking" },
    pause: { icon: Pause, label: "composer.pause" },
    pausing: { icon: Pause, label: "composer.pausing" },
    resume: { icon: Play, label: "composer.resume" },
    unavailable: { icon: ArrowUp, label: "composer.unavailable" },
  };
  const visual = buttonVisual[action];
  const resumeDisabled = action === "resume" && (resumePending || disabled);

  // C06 当前输入状态说明：是状态说明，不是额外发送或恢复入口。
  // 未知回执只在原消息与这里说明，不替换本来应有的暂停/继续/运行态主按钮
  const runNote = unconfigured
    ? t("composer.noModelHint")
    : action === "sending"
      ? t("composer.state.sending")
      : action === "checking"
        ? t("composer.state.checking")
        : run?.status === "pausing"
          ? t("composer.state.pausing")
          : run?.status === "paused"
            ? t("composer.state.paused")
            : run?.status === "faulted"
              ? t("composer.state.faulted")
              : t(mode === "steer" ? "composer.mode.steer" : "composer.mode.followUp");
  const note =
    unknownSendText && action !== "checking" ? `${runNote}｜${t("composer.state.checking")}` : runNote;

  const menuPauseEnabled = run?.status === "running" && Boolean(onPause);

  return (
    <div className="composer-surface input-surface rounded-2xl border border-border bg-input p-3 shadow-sm">
      <textarea
        ref={areaRef}
        value={draft}
        rows={3}
        placeholder={placeholder}
        onChange={(event) => onDraftChange(event.target.value)}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !composing && !event.nativeEvent.isComposing) {
            event.preventDefault();
            trySend();
          }
        }}
        className="composer-input w-full bg-transparent text-ui-base leading-normal placeholder:text-subtlest"
      />
      <div className="flex items-center justify-between mt-1.5">
        <div className="text-ui-xs text-subtlest">{note}</div>
        <div className="flex items-center gap-1">
          {/* 唯一主运行按钮（C01）：发送／暂停／继续互斥呈现，位置、可访问名称和提示随状态同步变化 */}
          <IconButton
            data-slot="composer-primary"
            icon={visual.icon}
            label={t(visual.label)}
            tooltip={t(visual.label)}
            variant="primary"
            size={8}
            strokeWidth={2}
            aria-busy={resumePending}
            disabled={!enabled || resumeDisabled}
            onClick={primary}
          />
          {/* 输入选项菜单（C03）：发送方式与运行操作分组的次级入口；打开、关闭、查看选项不执行工作 */}
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <IconButton icon={ChevronDown} label={t("composer.inputOptions")} size={6} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side={menuSide === "up" ? "top" : "bottom"}>
              <DropdownMenuGroup>
                <DropdownMenuLabel>{t("composer.menu.sendAs")}</DropdownMenuLabel>
                {/* C04：两项互斥、当前选择可辨；只改下一次提交用途，不执行工作，不改写已提交输入 */}
                <DropdownMenuRadioGroup value={mode} onValueChange={(value) => onModeChange(value === "steer" ? "steer" : "follow-up")}>
                  <DropdownMenuRadioItem value="steer">{t("composer.mode.steer")}</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="follow-up">{t("composer.mode.followUp")}</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuLabel>{t("composer.menu.runOps")}</DropdownMenuLabel>
                {/* C05 菜单内暂停：运行中可用（包括已输入新文字、主按钮显示发送时）；暂停不取消草稿 */}
                <DropdownMenuItem disabled={!menuPauseEnabled} onSelect={() => onPause?.()}>
                  {t("composer.pause")}
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );
}
