// Composer：视觉主角。复合输入壳（PromptInput / InputGroup）承担表面、边界、圆角与唯一的焦点框；
// textarea 本身没有焦点框。
// C01–C06（spec/页面与交互组件.md）：主运行按钮只有一个稳定位置，发送／暂停／继续互斥呈现，
// 按「先看实际运行约束，再看本次输入」由 derivePrimaryAction 推得；
// 「新文字」不含同一次已发送、仍待回执／待核对的旧文字（原消息由回执与回查负责）。
// 输入选项菜单是次级入口，只承载发送用途（引导／稍后处理，互斥可辨）；2026-10-10 已取消菜单内的
// 暂停／继续，运行控制只有同位主按钮一个位置。菜单打开、关闭与选项查看都不执行工作；
// Esc／点击外部只关闭菜单。
// 输入区几何：单行垂直居中、按内容向上展开无固定行数上限、长内容内部滚动且滚动条不可见、
// 会话真实滚动时暂收并按暂收前实测高度恢复（见本文件 useLayoutEffect 与 DESIGN）。
//
// 与上游 ai-elements PromptInput 的差异（依据 spec，不照搬默认表单行为）：
//  · 主按钮是 type="button" 的显式动作按钮，不随运行状态改变 type：Enter 永远不会触发暂停或继续，
//    它只经 form submit 走「尝试发送新文字」这一条通路（spec C02）。
//  · 提交后不清空输入：草稿只在收到 accepted 回执后由 App 清除。确认未接收保留原文与重试入口，
//    待核对保留原文并只在原消息上回查（spec T02 / T03）。

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, ChevronDown, Pause, Play } from "lucide-react";
import type { RunState, SendMode, WorkReference } from "@/contracts";
import {
  PromptInput,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  PromptInputFooter,
  PromptInputTextarea,
  PromptInputTools,
} from "./ai/prompt-input";
import { IconButton } from "./Button";
import {
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "./ui/dropdown-menu";
import { ReferenceChips, ReferencePicker } from "./ReferencePicker";
import { useT } from "../i18n";
import type { CopyKey } from "../i18n";

/**
 * 主按钮的唯一动作；disabled 形态也绑定同一个位置与随时可辨的文案来源。
 */
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
  /** 是否缺少必要配置（未配置可用模型） */
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

const EMPTY_REFERENCES: readonly WorkReference[] = Object.freeze([]);

export function Composer({
  draft,
  onDraftChange,
  onSend,
  referenceScope,
  references,
  onReferencesChange,
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
  collapsed = false,
}: {
  draft: string;
  onDraftChange: (text: string) => void;
  /** 发送时带上这一版引用；组件自己不持有第二份草稿引用状态 */
  onSend: (references: readonly WorkReference[]) => void;
  /** 引用归属：已有会话给 sessionId；新任务草稿给 taskId；都没有时入口不可用 */
  referenceScope?: { sessionId?: string; taskId?: string } | null;
  references?: readonly WorkReference[];
  /** 更新式写入：始终作用在草稿唯一所有者的**当前**引用集合上，
   *  不用渲染时的旧副本，避免 A 挂起期间 B 的增删被旧值覆盖。 */
  onReferencesChange?: (update: (current: readonly WorkReference[]) => readonly WorkReference[]) => void;
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
  /** 会话正在真实滚动：收起展开部分，保留可继续输入的形态（几何变化，不是状态变化） */
  collapsed?: boolean;
}) {
  const t = useT();
  const [composing, setComposing] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  // ---------- C05 引用（草稿内的可移除附加项） ----------
  // 唯一事实在调用方的草稿键下；组件只做呈现与增删转发，不另存一份。
  const refs = references ?? EMPTY_REFERENCES;
  const addReference = (captured: WorkReference) => {
    // 用 captureReference 的真实快照入草稿：没有快照的项不进草稿，也就绝不会被发送带走。
    onReferencesChange?.((current) => {
      // 同一 (kind, locator) 不重复加：重复项对模型没有新增信息。
      if (current.some((r) => r.kind === captured.kind && r.locator === captured.locator)) return current;
      return [...current, captured];
    });
  };
  const removeReference = (refId: string) => {
    onReferencesChange?.((current) => current.filter((r) => r.refId !== refId));
  };

  useEffect(() => {
    if (autoFocusKey !== undefined) areaRef.current?.focus();
  }, [autoFocusKey]);

  // ---------- 输入区几何（DESIGN 会话输入几何与暂收） ----------
  // 单行垂直居中；换行/折行按内容向上展开到需要的高度，不设固定行数上限；
  // 超过可用空间后在卡片内部滚动，内侧滚动条由 .composer-input 隐藏；
  // 会话真实滚动时暂收到单行高度，停止滚动后按**暂收前实测的高度**恢复。
  // 暂收只改高度：textarea 不卸载，草稿、光标/选区与输入法组合因此天然保留。
  const expandedHeightRef = useRef<number | null>(null);
  const restoreHeightRef = useRef<number | null>(null);
  const wasCollapsedRef = useRef(false);
  /** 单行形态：输入行与操作行并排且垂直居中（已认可原型的 .composer.compact）。多行时二者上下堆叠。
   *  判定只取卡片全宽下的内容高度：全宽与当前是否紧凑无关，
   *  紧凑形态本身改变的 textarea 宽度因此不会立即逆转判定、也不会触发来回抖动。 */
  const [compact, setCompact] = useState(false);


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

  useLayoutEffect(() => {
    const el = areaRef.current;
    const shell = el?.closest<HTMLElement>(".input-surface");
    if (!el || !shell) return;
    // 真实输入框压到零高会改变时间线 max，浏览器钳制生成的迟到 scroll 又被当成暂收。
    // 独立测量节点不参与布局、焦点或可访问输入；真实编辑区不再为量内容而改变几何。
    const measureArea = document.createElement("textarea");
    measureArea.setAttribute("aria-hidden", "true");
    measureArea.tabIndex = -1;
    measureArea.rows = 1;
    measureArea.wrap = el.wrap;
    Object.assign(measureArea.style, { position: "fixed", left: "-10000px", top: "0", height: "0px",
      minHeight: "0px", maxHeight: "none", minWidth: "0px", maxWidth: "none", overflow: "auto",
      visibility: "hidden", pointerEvents: "none" });
    const measure = () => {
      const style = getComputedStyle(el);
      for (const name of ["font-family", "font-size", "font-weight", "font-style", "font-stretch", "font-variant",
        "font-kerning", "font-feature-settings", "line-height", "letter-spacing", "word-spacing", "text-transform",
        "text-indent", "tab-size", "word-break", "overflow-wrap", "white-space", "direction", "box-sizing", "scrollbar-width",
        "padding-top", "padding-bottom", "padding-left", "padding-right", "border-top-width", "border-bottom-width",
        "border-left-width", "border-right-width", "border-style"]) {
        measureArea.style.setProperty(name, style.getPropertyValue(name));
      }
      measureArea.value = el.value || el.placeholder;
      const singleLine = Math.ceil(
        parseFloat(style.lineHeight) +
          parseFloat(style.paddingTop) +
          parseFloat(style.paddingBottom) +
          parseFloat(style.borderTopWidth) +
          parseFloat(style.borderBottomWidth),
      );
      // 卡片内容宽度＝展开形态下 textarea 的真实宽度，与当前紧凑状态无关
      const shellStyle = getComputedStyle(shell);
      const fullWidth = shell.clientWidth - parseFloat(shellStyle.paddingLeft) - parseFloat(shellStyle.paddingRight);
      // 仅将离屏测量盒压到 0 并建立滚动盒，读取当前文字样式在指定宽度下的真实内容需求。
      const heightAt = (width: number) => {
        measureArea.style.width = `${Math.max(24, Math.floor(width))}px`;
        document.body.append(measureArea);
        try { return measureArea.scrollHeight; }
        finally { measureArea.remove(); }
      };
      const neededFull = heightAt(fullWidth);
      // 紧凑判定只用与当前形态无关的量：全宽下是否装得下一行、操作行的固有宽度、
      // 以及输入区自己需要的宽度。改用当前宽度判定会被自身收窄的宽度立即逆转——
      // 一行变两行、判定翻转、外壳高度变化又触发 ResizeObserver，形成来回抖动。
      const footer = shell.querySelector<HTMLElement>('[data-slot="input-group-addon"]');
      // 操作行的固有预算：max-content 一次读数后恢复原宽。
      // （模型入口已移出输入卡片，操作行不再含可收起的标签，两态预算合并为一种。）
      const previousFooterWidth = footer?.style.width ?? null;
      let footerWidth = 0;
      if (footer) {
        footer.style.width = "max-content";
        footerWidth = footer.offsetWidth;
        footer.style.width = previousFooterWidth ?? "";
      }
      // 单行并排没有窄窗/检查器/滚动条模式例外（DESIGN 会话输入几何与开发任务路径行为图：
      // 一行→输入行与操作行并排居中；折行按内容向上长高）。据此定一件事：
      //  并排的底线是最小可用编辑宽（heightAt 的同一 24px 地板）：剩余宽装不下整段草稿时
      //  按内容折行、卡片向上长高（见下方 neededNow 按当前真实宽度重测，宁可长高也不裁
      //  内容），只有操作行本身挤掉底线才退堆叠——那是物理放不下，不是预算例外。
      const minEditWidth = 24;
      const singleLineForm = neededFull <= singleLine;
      const roomy = fullWidth >= footerWidth + minEditWidth;
      const nextCompact = singleLineForm && roomy;
      setCompact(nextCompact);
      // 改形态时 React 尚未提交对应的编辑宽，不用旧形态宽度提前写目标高度；
      // 由同一 compact 状态提交的布局阶段重测，保持形态与实际内容宽度一致。
      if (compact !== nextCompact) return;
      // 目标高度：并排形态宽度更窄，临界文本可能仍需折行——按当前真实宽度再量一次，
      // 宁可长高也不裁掉内容（判定仍只用全宽结果，故不会因此抖动）。
      const currentWidth = el.clientWidth;
      const neededNow = currentWidth > 0 && Math.abs(currentWidth - fullWidth) > 1 ? heightAt(currentWidth) : neededFull;
      const needed = Math.max(neededFull, neededNow);
      // 可用空间取滚动视口的真实高度：展开上限随窗口与面板几何派生，不是固定行数常数
      const scroller = el.closest(".overflow-y-auto");
      const available = Math.max(scroller?.clientHeight ?? window.innerHeight, singleLine * 3);
      const ceiling = Math.max(singleLine, Math.floor(available * 0.4));
      const expanded = Math.min(Math.max(needed, singleLine), ceiling);
      let target: number;
      if (collapsed) {
        // 进入暂收：记下此刻的实际展开高度，恢复时用它，不重新估算
        if (!wasCollapsedRef.current) restoreHeightRef.current = expandedHeightRef.current ?? expanded;
        target = singleLine;
      } else if (wasCollapsedRef.current) {
        const recorded = restoreHeightRef.current;
        restoreHeightRef.current = null;
        target = Math.min(Math.max(recorded ?? expanded, singleLine), ceiling);
        expandedHeightRef.current = target;
      } else {
        target = expanded;
        expandedHeightRef.current = expanded;
      }
      wasCollapsedRef.current = collapsed;
      el.style.height = `${target}px`;
      el.style.overflowY = needed > target ? "auto" : "hidden";
    };
    measure();
    // 几何变化同样要重测：窗口缩放、检查器开闭、字号与语言改变排版时，
    // 草稿未变也必须按新的宽度与可用视口重新计算，不能等用户再敲一个字符。
    // 自身改高会再触发一次 RO，但测量是幂等的（同一输入与同一宽度得同一结果），自然收敛。
    // 观察对象不只外壳：编辑区与操作行的实际宽度变化（检查器开闭、窗口缩放、说明或用途变化
    // 引起的重排）未必改变外壳自身的宽高，只盯外壳会漏掉这一路。
    const ro = new ResizeObserver(() => measure());
    ro.observe(shell);
    ro.observe(el);
    const footer = el.parentElement?.querySelector<HTMLElement>('[data-slot="input-group-addon"]');
    if (footer) ro.observe(footer);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
      measureArea.remove();
    };
  }, [draft, collapsed, compact, placeholder, note]);

  const primary = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (!enabled) return;
    if (action === "send") {
      onSend(refs);
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

  /** Enter 与表单提交只尝试发送新文字（C02）：待核对旧发送经 T02 回查、确认未接收后经 T03 重试；
   *  暂停中输入框 Enter 仍尝试发送新文字（执行通路如实拒收），不代替明确继续；
   *  空 Enter、待回执中的同次旧发送、配置缺失、运行故障不触发动作。 */
  const canAttemptSend = !unconfigured && run?.status !== "faulted" && hasNewDraft;
  const trySend = () => {
    if (!canAttemptSend) return;
    // Enter 与主按钮走同一次提交：带上这一版引用，引用不改变文字。
    onSend(refs);
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

  return (
    // 悬浮输入卡片（DESIGN 容器规则 + spec 桌面会话输入区）：
    // 玻璃底色让下方滚动的时间线透出一点，深度由 --shadow-float 说明它浮在内容之上；
    // 外围留白仍属时间线表面，不形成横贯主区的分隔线或实色底栏。
    <PromptInput
      surfaceClassName={`glass glass-composer shadow-[var(--shadow-float)] ${compact ? "composer-compact" : ""}`}
      // C06：状态说明是状态说明，不是发送或恢复入口。它排在输入卡片之外、与已认可原型的
      // .composer-hint 同层，因此不与输入行争抢宽度：窄窗下输入行仍能与操作行并排居中，
      // 说明变长也不会挤走编辑区宽度。末尾消息避让按整个 dock（卡片＋说明）计算。
      afterSurface={
        <div data-slot="composer-note" className="mt-1.5 min-w-0 truncate text-ui-xs text-subtlest">
          {note}
        </div>
      }
      onSubmit={trySend}
    >
      {/* C05 引用项：可移除的附加项，排在编辑区之上；没有引用时不渲染，不改变既有几何 */}
      <ReferenceChips references={refs} onRemove={removeReference} />
      <PromptInputTextarea
        ref={areaRef}
        value={draft}
        /* rows 只是内在最小行（未声明时宿主默认 2 行，会让单行卡片凭空多出一行）；
           实际高度由本组件的 useLayoutEffect 按内容测量后设置，不构成固定行数上限 */
        rows={1}
        placeholder={placeholder}
        isComposing={composing}
        onChange={(event) => onDraftChange(event.target.value)}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
      />
      <PromptInputFooter>
        <PromptInputTools>
          {/* C05 引用入口：次级入口、向上展开；打开/查看/移除都不发送、不执行、不安装 */}
          <ReferencePicker scope={referenceScope ?? null} onAdd={addReference} />
          {/* 唯一主运行按钮（C01）：发送／暂停／继续互斥呈现，位置、可访问名称和提示随状态同步变化。
              type="button" 是硬要求：本按钮位于 <form> 内，若按宿主默认成为 submit，
              点「继续执行」会连带触发表单提交，把新草稿一起发出去（spec C01「不顺带提交新草稿」）。
              Enter 只经 PromptInput 的提交通路走 trySend。 */}
          <IconButton
            data-slot="composer-primary"
            type="button"
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
          <PromptInputActionMenu modal={false}>
            <PromptInputActionMenuTrigger
              label={t("composer.inputOptions")}
              tooltip={t("composer.inputOptions")}
              size="icon-sm"
            >
              <ChevronDown className="size-4" strokeWidth={1.75} />
            </PromptInputActionMenuTrigger>
            <PromptInputActionMenuContent align="end" side={menuSide === "up" ? "top" : "bottom"}>
              <DropdownMenuGroup>
                <DropdownMenuLabel>{t("composer.menu.sendAs")}</DropdownMenuLabel>
                {/* C04：两项互斥、当前选择可辨；只改下一次提交用途，不执行工作，不改写已提交输入 */}
                <DropdownMenuRadioGroup value={mode} onValueChange={(value) => onModeChange(value === "steer" ? "steer" : "follow-up")}>
                  <DropdownMenuRadioItem value="steer">{t("composer.mode.steer")}</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="follow-up">{t("composer.mode.followUp")}</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuGroup>
              {/* 2026-10-10 取消菜单内的运行控制：暂停只有同位主按钮一个入口。
                  菜单不再出现第二个暂停／继续，也不在这里改变运行状态。 */}
            </PromptInputActionMenuContent>
          </PromptInputActionMenu>
        </PromptInputTools>
      </PromptInputFooter>
    </PromptInput>
  );
}
