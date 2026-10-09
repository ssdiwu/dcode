// 界面自有文案的唯一来源（中／英）。用户内容、路径、代码、工具与模型原文不经过这里。
// 语言选择来自设置（product state），界面只读；切换语言不动工作位置、草稿与执行状态。

import { useEffect, useState } from "react";
import type { AppSnapshot } from "@/contracts";

export type Language = "zh" | "en";

const DICT = {
  "app.loading": ["载入中…", "Loading…"],
  "app.noticeFallback": [
    "上次的工作位置已不存在（任务可能已删除）。已回到 Home 默认任务的新草稿，已有工作仍可在侧栏找到。",
    "The previous work location no longer exists (the task may have been deleted). You're now at a fresh draft in Home's default task; existing work remains in the sidebar.",
  ],
  "app.noticeDismiss": ["知道了", "Got it"],
  "app.sendUnknown": ["发送结果待核对。原文已保留，请在原消息上选择“回查”。", "The send result is unknown. Your text is kept; choose “Look up” on the original message."],
  "app.renderError": ["工作界面无法显示，当前内容暂时无法操作。请关闭后重新打开 D Code，查看已保存的工作。", "The workspace could not be displayed, so its contents are temporarily unavailable. Close and reopen D Code to view saved work."],
  "app.closeErrorDismiss": ["知道了", "Got it"],
  "app.draftPersistFailed": ["草稿未能保存。文字仍保留在当前窗口，请先复制保留，避免关闭后丢失。", "The draft could not be saved. It remains in this window; copy it before closing to avoid losing it."],

  "nav.settings": ["设置", "Settings"],
  "nav.settings.missingModel": ["模型不可用", "Model unavailable"],
  "nav.treeLabel": ["工作空间与任务", "Workspaces and tasks"],
  "nav.defaultBadge": ["默认", "Default"],
  "nav.defaultTask": ["默认任务", "Default task"],
  "nav.newTaskHere": ["在此空间新建任务", "New task here"],
  "nav.newSubTask": ["新建短期任务", "New short-term task"],
  "nav.taskActions": ["任务操作", "Task actions"],
  "nav.moveTo": ["移动到「{name}」", "Move to \"{name}\""],
  "nav.newLongTask": ["新建长期任务", "New long-term task"],
  "nav.newShortTask": ["新建短期任务", "New short-term task"],
  "nav.taskNamePlaceholder": ["任务名称", "Task name"],
  "nav.longTermHint": ["长期任务可以持续生成短期任务。", "Long-term tasks keep spawning short-term tasks."],
  "nav.shortTermHint": ["短期任务不能再嵌套任务。", "Short-term tasks cannot nest further."],
  "nav.subSession": ["子会话", "Sub"],
  "nav.running": ["运行中", "Running"],
  "common.cancel": ["取消", "Cancel"],
  "common.create": ["创建", "Create"],

  "draft.greeting.lateNight": ["夜深了", "Up late"],
  "draft.greeting.morning": ["早上好", "Good morning"],
  "draft.greeting.noon": ["中午好", "Good afternoon"],
  "draft.greeting.afternoon": ["下午好", "Good afternoon"],
  "draft.greeting.evening": ["晚上好", "Good evening"],
  "draft.title": ["开始一项新工作", "Start new work"],
  "draft.modelMissing": ["当前没有可用模型，暂时无法开始工作。你可以先写下并保存草稿。", "No model is available, so work cannot start yet. You can write and save a draft."],
  "draft.composerPlaceholder": ["交代需求、提问或粘贴内容…", "Describe the task, ask, or paste content…"],
  "draft.composerPlaceholderNoModel": ["写下需求，保存为草稿…", "Write a request and keep it as a draft…"],
  "draft.continue": ["继续", "Continue"],
  "draft.recommendedToggle": ["不知道从哪开始？推荐动作", "Not sure where to start? Suggested actions"],
  "draft.recommendedEmpty": ["推荐动作", "Suggested actions"],
  "draft.recommended.0": ["描述一个开发任务，让 D Code 动手改代码", "Describe a development task and let D Code change code"],
  "draft.recommended.1": ["让 D Code 解释一段你不熟悉的代码", "Ask D Code to explain unfamiliar code"],
  "draft.recommended.2": ["把最近的一个想法整理成可执行的步骤", "Turn a recent idea into actionable steps"],

  "composer.sendHint": ["Enter 发送 · Shift+Enter 换行", "Enter to send · Shift+Enter for newline"],
  "composer.noModelHint": ["模型不可用；文字保留为草稿", "Model unavailable; your text stays as a draft"],
  "composer.send": ["发送", "Send"],
  "composer.sending": ["发送中", "Sending"],
  "composer.checking": ["待核对", "Needs lookup"],
  "composer.pause": ["暂停", "Pause"],
  "composer.pausing": ["暂停处理中", "Pausing"],
  "composer.resume": ["继续执行", "Resume"],
  "composer.unavailable": ["运行控制不可用", "Control unavailable"],
  "composer.inputOptions": ["输入选项", "Input options"],
  "composer.menu.sendAs": ["发送方式", "Send as"],
  "composer.menu.runOps": ["运行操作", "Run actions"],
  "composer.state.sending": ["发送中，正在等待接收结果", "Sending; waiting for the receipt"],
  "composer.state.checking": ["发送结果待核对，请在原消息上选择“回查”", "Send result unknown; choose “Look up” on the original message"],
  "composer.state.pausing": ["正在暂停，文字和已有进度保留", "Pausing; your text and progress are kept"],
  "composer.state.paused": ["已暂停。草稿可以编辑；选择“继续执行”后恢复工作", "Paused. You can edit the draft; choose “Resume” to continue work"],
  "composer.state.faulted": ["工作暂时无法继续，草稿和已有内容保留", "Work cannot continue right now; your draft and existing content are kept"],
  "composer.mode.steer": ["引导：立即纳入当前工作", "Steer: fold into current work"],
  "composer.mode.followUp": ["稍后处理：留到本轮结束", "Follow up: after this turn"],

  "receipt.accepted": ["已接收", "Accepted"],
  "receipt.pendingLookup": ["待核对", "Needs lookup"],
  "receipt.unanswered": ["未获回答", "Unanswered"],
  "receipt.lookup": ["回查", "Look up"],
  "receipt.retry": ["重试", "Retry"],
  "receipt.reason.paused": ["目标已暂停，输入未接收", "Target is paused; input not accepted"],
  "receipt.reason.stale-control": ["工作状态已变化，本次输入未接收", "Work has changed; this input was not accepted"],
  "receipt.reason.conflict": ["与已保存的输入冲突，未接收", "Conflicts with stored input; not accepted"],
  "receipt.reason.not-found": ["未找到提交记录，按未接收处理", "No submission record; treated as not accepted"],
  "receipt.reason.storage-rejected": ["本次输入未能保存，尚未接收", "This input could not be saved and was not accepted"],
  "receipt.reason.storage-unavailable": ["接收结果待核对，请回查原消息", "Receipt unknown; look up the original message"],

  "timeline.newSession": ["新会话", "New session"],
  "timeline.followupPlaceholder": ["追问、补充或纠正…", "Follow up, add detail, or correct…"],
  "timeline.pendingInputs": ["未完成输入 {n}", "{n} pending inputs"],
  "timeline.resumeBar": ["已打开上次的工作记录。工作仍暂停，选择“继续执行”后接续。", "Your previous work is open. It remains paused; choose “Resume” to continue."],
  "timeline.resume": ["继续执行", "Resume"],
  "timeline.viewOnly": ["仅查看", "Just view"],
  "run.running": ["执行中", "Running"],
  "run.paused": ["已暂停", "Paused"],
  "run.pausing": ["暂停处理中", "Pausing"],
  "run.failed": ["失败", "Failed"],
  "run.faulted": ["运行故障", "Faulted"],
  "run.done": ["完成", "Done"],
  "marker.paused": ["已暂停。进度已保存，可随时继续。", "Paused. Progress saved; resume anytime."],
  "marker.resumed": ["从中断处继续。", "Resuming from the interruption."],
  "marker.finished": ["本轮结束。", "Turn finished."],
  "marker.failed": ["本轮失败。", "Turn failed."],

  "tool.filesCount": ["{n} 个文件", ["{n} file", "{n} files"]],
  "tool.copyError": ["复制错误", "Copy error"],
  "tool.copying": ["复制中…", "Copying…"],
  "tool.copied": ["已复制", "Copied"],
  "tool.copyFailed": ["复制失败", "Copy failed"],
  "tool.waiting": ["等待中", "Waiting"],

  "changes.summary": ["本轮改动 {n} 个文件", ["{n} file changed", "{n} files changed"]],
  "inspector.title": ["文件改动（{n}）", "File changes ({n})"],
  "inspector.close": ["关闭检查器", "Close inspector"],

  "settings.title": ["设置", "Settings"],
  "settings.back": ["返回", "Back"],
  "settings.escHint": ["Esc 也可返回；会话草稿已保留", "Esc also returns; your draft is preserved"],
  "settings.appearance": ["外观", "Appearance"],
  "settings.startup": ["启动", "Startup"],
  "settings.model": ["模型", "Model"],
  "settings.about": ["关于", "About"],
  "settings.theme": ["主题", "Theme"],
  "settings.themeHint": ["跟随系统，或固定浅色／深色", "Follow the system, or pin light / dark"],
  "settings.theme.system": ["系统", "System"],
  "settings.theme.light": ["浅色", "Light"],
  "settings.theme.dark": ["深色", "Dark"],
  "settings.fontSize": ["界面字号", "Interface font size"],
  "settings.fontSizeHint": ["同时调整文字和控件大小", "Adjust text and control sizes together"],
  "settings.language": ["界面语言", "Interface language"],
  "settings.languageHint": ["切换不影响当前工作位置、草稿与执行状态", "Switching keeps your location, drafts, and running state"],
  "settings.launch": ["打开应用时", "On launch"],
  "settings.launchHint": ["恢复现场只还原界面位置，不会自动继续执行", "Restoring reopens the UI location only; execution never resumes automatically"],
  "settings.launch.restore": ["恢复上次现场", "Restore last state"],
  "settings.launch.homeDraft": ["Home 新草稿", "Home draft"],
  "settings.modelMissingBody": ["当前没有可用模型。草稿可以继续编辑和保存，工作暂时无法开始。", "No model is available. You can edit and save drafts, but work cannot start yet."],
  "settings.modelRow": ["当前模型", "Current model"],
  "settings.modelRowHintConfigured": ["{name}", "{name}"],
  "settings.modelRowHintEmpty": ["没有可用模型", "No model available"],
  "settings.modelConfigured": ["可用", "Available"],
  "settings.modelMissing": ["不可用", "Unavailable"],
  "settings.modelSetupTitle": ["添加 / 编辑服务商", "Add / edit provider"],
  "settings.modelSetupProvider": ["协议", "Protocol"],
  "settings.modelSetupProviderHint": ["选择服务商使用的对话协议", "Choose the conversation protocol of your provider"],
  "settings.modelSetupProviderOpenAI": ["OpenAI-compatible", "OpenAI-compatible"],
  "settings.modelSetupProviderAnthropic": ["Anthropic", "Anthropic"],
  "settings.modelSetupLabel": ["显示名", "Display name"],
  "settings.modelSetupLabelHint": ["在应用里显示的服务商名称（自定）", "The name shown in the app (your choice)"],
  "settings.modelSetupLabelPlaceholder": ["如：我的服务商", "e.g. My provider"],
  "settings.modelSetupModelId": ["模型 ID", "Model ID"],
  "settings.modelSetupModelIdHint": ["填写服务商提供的模型 ID", "Enter the model identifier provided by the provider"],
  "settings.modelSetupBaseUrl": ["Base URL", "Base URL"],
  "settings.modelSetupBaseUrlHint": ["填写 HTTPS 接口地址，本机服务可使用 HTTP；不要嵌入凭据", "Enter an HTTPS endpoint URL; local services may use HTTP; do not embed credentials"],
  "settings.modelSetupBaseUrlInvalid": ["URL 需用 http(s)、不得带 userinfo", "URL must be http(s) and must not embed userinfo"],
  "settings.modelSetupKey": ["API 凭据", "API key"],
  "settings.modelSetupKeyHint": ["原来填过密钥可沿用；切换服务商或地址时要换密钥", "You may keep a saved one; replace it when switching provider or address"],
  "settings.modelSetupKeyKeep": ["保留现有密钥", "Keep existing key"],
  "settings.modelSetupKeyReplace": ["更换", "Replace"],
  "settings.modelSetupKeyClear": ["清除", "Clear"],
  "settings.modelSetupApiKey": ["API 密钥", "API key"],
  "settings.modelSetupApiKeyHint": ["仅本次保存使用；不会在界面或日志回显", "Used only for this save; never shown or logged"],
  "settings.modelSetupApiKeyPlaceholder": ["粘贴 API key", "Paste API key"],
  "settings.modelSetupSaved": ["已保存", "Saved"],
  "settings.modelSetupFailed": ["保存失败", "Save failed"],
  "settings.modelSetupSaving": ["保存中…", "Saving…"],
  "settings.modelSetupSave": ["保存", "Save"],
  "settings.modelSetupNote.ready": ["已配置", "Configured"],
  "settings.modelSetupNote.auth-failed": ["凭据失败", "Auth failed"],
  "settings.modelSetupNote.auth-unverified": ["凭据未经验证", "Auth unverified"],
  "settings.modelSetupNote.connect-failed": ["连接失败", "Connect failed"],
  "issue.state-corrupt": ["保存的工作记录无法读取。已保留原文件，当前从空白工作区开始。", "Saved work could not be read. The original file is preserved; this workspace starts empty."],
  "issue.state-unreadable": ["无法读取保存的工作记录。本次更改无法保存，原文件保留；请先复制需要保留的内容，关闭后重新打开。", "Saved work could not be read. Changes cannot be saved in this window; the original file is preserved. Copy anything you need before closing and reopening."],
  "issue.initial-save-failed": ["工作区未能保存。当前内容仍可查看，请先复制需要保留的文字，避免关闭后丢失。", "The workspace could not be saved. You can still view it; copy any text you need before closing to avoid losing it."],
  "issue.save-failed": ["保存失败，当前更改尚未保存。请先复制需要保留的内容，关闭时会再次尝试保存。", "Saving failed; current changes are unsaved. Copy anything you need; closing will try to save again."],
  "issue.settings-save-failed": ["设置未能保存，仍使用上次保存的值。请重新选择需要的设置。", "Settings could not be saved; the last saved values remain in use. Select your settings again."],
  "issue.first-send-save-failed": ["这条需求未能保存，工作尚未开始。原文仍在，请复制保留；保存恢复后可重试原消息。", "The request could not be saved and work has not started. Your text is kept; copy it, then retry the original message when saving is available."],
  "issue.close-failed": ["关闭未完成，应用保持打开。工作暂停或保存的结果尚未全部确认，请先查看并复制需要保留的内容。", "Closing did not complete; the app remains open. Pausing or saving has not been fully confirmed. Review and copy anything you need to keep."],
  "issue.resume-stale": ["工作状态已变化，本次继续未生效。请确认当前状态，再选择“继续执行”。", "Work has changed and this resume request did not take effect. Check the current state, then choose “Resume” again."],
  "issue.resume-failed": ["继续执行失败，当前工作状态和已有内容保留。请查看当前状态后再次选择“继续执行”。", "Resuming failed; the current work state and existing content are kept. Check the state before choosing “Resume” again."],
  "issue.resume-unverified": ["继续执行未获确认，当前状态也无法读取。草稿和已有内容保留，请关闭后重新打开查看工作。", "Resuming could not be confirmed and the current state could not be read. Your draft and content are kept; close and reopen to view work."],
  "issue.auth-failed": ["服务商凭据未被接受，请到设置 → 模型检查凭据后再试。", "Provider credentials were not accepted; check your credentials in Settings → Model and try again."],
  "issue.model-request-failed": ["模型请求失败，请检查服务地址与模型配置后重试。", "The model request failed; check the service address and model configuration, then try again."],
  "tool.result": ["工具结果", "Tool result"],
  "common.decrease": ["减小", "Decrease"],
  "common.increase": ["增大", "Increase"],
} as const;

export type CopyKey = keyof typeof DICT;

let currentLang: Language = "zh";
const langListeners = new Set<() => void>();

export function resolveLanguage(snapshot: AppSnapshot | null): Language {
  const setting = snapshot?.settings.language ?? "system";
  if (setting === "zh" || setting === "en") return setting;
  return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
}

/** 由 App 在快照变化时驱动；语言是产品设置，界面不另存一份 */
export function syncLanguage(snapshot: AppSnapshot | null): void {
  const next = resolveLanguage(snapshot);
  if (next === currentLang) return;
  currentLang = next;
  document.documentElement.lang = next === "zh" ? "zh-CN" : "en";
  langListeners.forEach((l) => l());
}

export function useT(): (key: CopyKey, vars?: Record<string, string | number>) => string {
  const [, force] = useState(0);
  useEffect(() => {
    const cb = () => force((n) => n + 1);
    langListeners.add(cb);
    return () => {
      langListeners.delete(cb);
    };
  }, []);
  return (key, vars) => translate(key, vars, currentLang);
}

export function translate(key: CopyKey, vars?: Record<string, string | number>, language: Language = currentLang): string {
    const pair = DICT[key];
    const raw: unknown = pair[language === "zh" ? 0 : 1];
    let text: string;
    if (Array.isArray(raw)) {
      const n = Number(vars?.n);
      text = n === 1 ? raw[0] : raw[1];
    } else {
      text = raw as string;
    }
    if (vars) {
      for (const [k, v] of Object.entries(vars)) text = text.replaceAll(`{${k}}`, String(v));
    }
    return text;
}
