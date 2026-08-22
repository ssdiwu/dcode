import AppKit
import SwiftUI

struct ComposerView: View {
    @Environment(AppModel.self) private var model
    @FocusState private var focused: Bool
    @State private var showingContext = false
    @State private var showingFollowUpQueue = true
    @State private var branchState: GitBranchLookupState = .idle
    @State private var selectedCommandIndex = 0
    @AppStorage("dcode.runningMessageDeliveryMode") private var runningDeliveryRawValue = RunningMessageDeliveryMode.steer.rawValue
    @AppStorage(DCodeInterfaceFontScale.storageKey) private var interfaceFontScaleRawValue = DCodeInterfaceFontScale.standard.rawValue

    var body: some View {
        VStack(spacing: 0) {
            if !commandSuggestions.isEmpty {
                commandPalette
                Divider()
            }
            composer(text: Binding(
                get: { model.composerText },
                set: { model.updateComposerText($0) }
            ))
        }
    }

    private func composer(text: Binding<String>) -> some View {
        VStack(spacing: 0) {
            VStack(spacing: 8) {
                if let draftIssue = model.draftStoreIssue {
                    // ADR 0027 决定 6：草稿熔断常驻呈现，重试入口在 设置 › Host 诊断。
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Label(
                            "会话草稿暂无法保存：\(draftIssue)。重试入口见 设置 › Host 诊断 › 本机存储状态。",
                            systemImage: "exclamationmark.triangle.fill"
                        )
                        .font(.caption)
                        .foregroundStyle(.orange)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityLabel("会话草稿存储熔断：\(draftIssue)")
                    }
                }
                if let queueIssue = model.followUp.queueIssue {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Label(queueIssue, systemImage: "exclamationmark.triangle.fill")
                            .font(.caption)
                            .foregroundStyle(.orange)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .accessibilityLabel("后续消息队列不可写：\(queueIssue)")
                        Button("重新载入") {
                            Task { await model.reloadFollowUpQueues() }
                        }
                        .buttonStyle(.borderless)
                        .disabled(model.followUp.isMutatingQueue)
                        .help("修复或恢复原文件后重新载入后续消息队列")
                        .accessibilityLabel("重新载入后续消息队列")
                    }
                }
                if let draftStoreIssue = model.draftStoreIssue {
                    Label(draftStoreIssue, systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(.orange)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityLabel("草稿无法持久保存：\(draftStoreIssue)")
                }
                if model.pendingPathDraft != nil {
                    HStack(spacing: 8) {
                        Image(systemName: "arrow.triangle.branch")
                            .foregroundStyle(Color.accentColor)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("新会话路径草稿")
                                .font(.caption.weight(.semibold))
                            Text("尚未创建 · 原路径保留；发送成功后才形成新路径")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button("取消") { model.cancelPathDraft() }
                            .frame(minHeight: PiDCodeMetrics.compactControlHeight)
                            .disabled(model.isSendingRequest || model.pendingPrompt != nil)
                    }
                    .accessibilityElement(children: .combine)
                }
                if model.activity.currentRunState?.phase.requiresInteractionDock == true
                    || model.currentFollowUpQueue != nil
                    || model.followUp.pendingSteer != nil
                    || model.pendingPlanProposal != nil
                    || model.sessionConflict != nil {
                    interactionDock(queue: model.currentFollowUpQueue)
                }
                ComposerTextEditor(
                    text: text,
                    isEnabled: composerIsEnabled,
                    font: composerBodyFont,
                    placeholder: composerPlaceholder,
                    onSubmit: submitComposer,
                    navigate: handlePaletteKey
                )
                .frame(minHeight: 66, maxHeight: 126, alignment: .topLeading)
                .focused($focused)
                .accessibilityLabel("消息输入")
                .onChange(of: model.composerText) { _, _ in
                    selectedCommandIndex = 0
                }

                runtimeControls
            }
            if model.isNewSessionDraftActive {
                scopeTray
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .dCodeFloatingSurface(cornerRadius: 16)
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .task {
            if model.resources.snapshot == nil, !model.resources.isLoading {
                await model.loadResources()
            }
        }
        .onAppear { focusComposer() }
        .onChange(of: model.inspection?.summary.id) { _, _ in focusComposer() }
        .onChange(of: model.isNewSessionDraftActive) { _, isActive in
            if isActive { focusComposer() }
        }
    }

    /// 打开即输入：主页、新建会话、打开会话与返回工作台时，Composer 直接持有键盘焦点。
    private func focusComposer() {
        guard !model.search.presented else { return }
        focused = true
    }

    private var runtimeControls: some View {
        HStack(spacing: 4) {
            oneShotResourceMenu

            Spacer(minLength: 0)

            if model.hasActiveRun {
                Menu {
                    ForEach(RunningMessageDeliveryMode.allCases) { mode in
                        Button {
                            runningDeliveryRawValue = mode.rawValue
                        } label: {
                            if mode == runningDeliveryMode {
                                Label(mode.label, systemImage: "checkmark")
                            } else {
                                Text(mode.label)
                            }
                        }
                    }
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: runningDeliveryMode == .steer ? "arrow.turn.up.right" : "text.badge.plus")
                        Text(runningDeliveryMode.label)
                        Image(systemName: "chevron.up.chevron.down")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    .fixedSize()
                }
                .menuStyle(.borderlessButton)
                .help(runningDeliveryMode.detail)
                .accessibilityLabel("运行中发送方式：\(runningDeliveryMode.label)")
            }

            // 会话前草稿没有任何运行上下文，圆环不该以空环形态常驻；
            // 会话创建（存在运行上下文）后才显示。
            if !model.isNewSessionDraftActive {
                Button {
                    showingContext.toggle()
                } label: {
                    HStack(spacing: 4) {
                        contextRemainingRing
                            .frame(width: 18, height: 18)
                        if let delta = contextDeltaCaption {
                            Text(delta)
                                .font(.caption2.monospaced())
                                .foregroundStyle(.secondary)
                                .help("本轮运行累计的上下文 token 增减：+ 为新增，− 为压缩或修剪释放")
                        }
                    }
                    .frame(
                        width: PiDCodeMetrics.compactControlHeight,
                        height: PiDCodeMetrics.compactControlHeight
                    )
                    .contentShape(Rectangle())
                }
                .buttonStyle(.borderless)
                .popover(isPresented: $showingContext, arrowEdge: .bottom) {
                    contextPopover
                }
                .help(contextHelpLabel)
                .accessibilityLabel("上下文：\(contextAccessibilityLabel)")
            }

            modelAndThinkingMenu
                .disabled(
                    model.pendingPathDraft != nil
                        || model.isPromptTransactionActive
                )

            if !model.isStreaming || model.shouldQueueComposerText {
                Button {
                    submitComposer()
                } label: {
                    Image(systemName: submitIconName)
                }
                .buttonStyle(SendActionStyle())
                .disabled(!sendEnabled)
                .help(submitHelp)
                .accessibilityLabel(submitAccessibilityLabel)
            }
        }
        .font(.caption)
    }

    /// 一次性资源调用（0.0.16）：`+` 入口把 `/…` 调用写入当前草稿——只预填不发送，
    /// 实际采用的资源以草稿中可见的调用文本与菜单里的来源描述为准；
    /// 清单与 设置 > 本机资源 同源（Pi 真实加载合同）。
    private var oneShotResourceMenu: some View {
        Menu {
            if let snapshot = model.resources.snapshot {
                let commands = snapshot.commands.filter { entry in
                    !entry.name.hasPrefix("skill:") && entry.source != "prompt"
                }
                let skills = snapshot.commands.filter { $0.name.hasPrefix("skill:") }
                let prompts = snapshot.commands.filter { $0.source == "prompt" }
                if commands.isEmpty && skills.isEmpty && prompts.isEmpty {
                    Text("Pi 当前没有加载可调用资源")
                }
                if !commands.isEmpty {
                    Menu("命令") {
                        ForEach(commands) { resourceInvocationButton($0) }
                    }
                }
                if !skills.isEmpty {
                    Menu("Skill") {
                        ForEach(skills) { resourceInvocationButton($0) }
                    }
                }
                if !prompts.isEmpty {
                    Menu("Prompt 模板") {
                        ForEach(prompts) { resourceInvocationButton($0) }
                    }
                }
                Divider()
                Button("刷新资源列表") {
                    Task { await model.loadResources() }
                }
            } else if model.resources.isLoading {
                Text("正在读取 Pi 资源…")
            } else {
                Text("资源清单不可用")
                Button("重试") {
                    Task { await model.loadResources() }
                }
            }
        } label: {
            Image(systemName: "plus")
                .font(.system(size: 12, weight: .medium))
                .frame(minHeight: PiDCodeMetrics.compactControlHeight)
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .help("为这条消息选择本机 Skill / Prompt / Command（写入输入框，仍由你发送）")
        .accessibilityLabel("资源调用")
    }

    private func resourceInvocationButton(_ command: ResourceCommandEntry) -> some View {
        Button {
            model.insertComposerReference(command.composerInvocationText)
            focused = true
        } label: {
            HStack {
                Text(command.name)
                    .lineLimit(1)
                if let description = command.description, !description.isEmpty {
                    Text(description)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
        }
    }

    private var submitIconName: String {
        if model.shouldQueueComposerText,
           !(model.hasActiveRun && runningDeliveryMode == .steer) {
            return "text.badge.plus"
        }
        return "arrow.up"
    }

    /// 作用域托盘：与输入框连体的下挂条。承载新会话草稿的 Source Folder
    /// 选择（默认用户目录）；选中 Git 仓库目录后追加只读分支 chip。
    private var scopeTray: some View {
        VStack(spacing: 0) {
            Divider()
            HStack(spacing: PiDCodeMetrics.spacingGroup) {
                Button {
                    presentSourceFolderPicker()
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "folder")
                        Text(folderDisplayTitle)
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Image(systemName: "chevron.up.chevron.down")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(
                        Color.primary.opacity(0.05),
                        in: RoundedRectangle(cornerRadius: 7, style: .continuous)
                    )
                    .contentShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
                }
                .buttonStyle(.plain)
                .dCodeAccessibleButton("选择新会话工作目录，当前 \(folderDisplayTitle)")
                .help(folderPathHelp)
                .disabled(folderPickerDisabled)

                if case let .ready(branch) = branchState {
                    HStack(spacing: 5) {
                        Image(systemName: "arrow.triangle.branch")
                        Text(branch)
                            .lineLimit(1)
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .help("当前目录的 Git 分支（只读）")
                    .accessibilityLabel("当前 Git 分支 \(branch)")
                }

                Spacer(minLength: 0)
            }
            .padding(.top, PiDCodeMetrics.spacingStandard)
        }
        .task(id: model.newSessionDraftDirectoryPath) {
            guard let path = model.newSessionDraftDirectoryPath else { return }
            branchState = await GitBranchCache.shared.read(at: path)
        }
    }

    private func presentSourceFolderPicker() {
        let panel = NSOpenPanel()
        panel.title = "选择新会话的工作目录"
        panel.prompt = "选择"
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = false
        panel.allowsMultipleSelection = false
        panel.begin { response in
            guard response == .OK, let url = panel.url else { return }
            Task { await model.changeNewSessionDraftDirectory(to: url) }
        }
    }

    private var folderPickerDisabled: Bool {
        model.isCreatingSession || model.isSendingRequest || model.pendingPrompt != nil
    }

    private var folderDisplayTitle: String {
        guard let path = model.newSessionDraftDirectoryPath else { return "~" }
        if path == FileManager.default.homeDirectoryForCurrentUser.path {
            return "~"
        }
        let name = URL(fileURLWithPath: path, isDirectory: true).lastPathComponent
        return name.isEmpty ? path : name
    }

    private var folderPathHelp: String {
        "新会话将在该目录中运行，正文与模型选择随目录保留；当前：\(model.newSessionDraftDirectoryPath ?? "~")"
    }

    private func interactionDock(queue: FollowUpQueueRecord?) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            if let runState = model.activity.currentRunState, runState.phase.requiresInteractionDock {
                HStack(alignment: .center, spacing: 8) {
                    Image(systemName: runStatusIcon(runState.phase))
                        .foregroundStyle(runStatusColor(runState.phase))
                        .frame(width: 18)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(runStatusLabel(runState))
                            .font(.caption.weight(.semibold))
                        Text(runStatusDetail(runState))
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("\(runStatusLabel(runState))。\(runStatusDetail(runState))")
                    Spacer(minLength: 8)
                    if runState.phase == .running || runState.phase == .waitingForUser {
                        Button(role: .destructive) {
                            Task { await model.abort() }
                        } label: {
                            Label("停止", systemImage: "stop.fill")
                        }
                        .buttonStyle(.borderless)
                        .disabled(!model.canWrite)
                        .help("请求停止当前 D Code 拥有的运行")
                        .accessibilityLabel("停止当前运行")
                    } else if model.canSafelyRetryCurrentRun {
                        Button {
                            Task { await model.retryCurrentRunSafely() }
                        } label: {
                            Label("安全重试", systemImage: "arrow.clockwise")
                        }
                        .buttonStyle(.borderless)
                        .help("Host 已确认输入未持久化，使用已恢复草稿重试")
                        .accessibilityLabel("安全重试当前运行")
                    }
                }
            }

            if let pendingSteer = model.followUp.pendingSteer {
                if model.activity.currentRunState?.phase.requiresInteractionDock == true { Divider() }
                Label {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(pendingSteer.accepted ? "介入信息已交给 Pi" : "正在提交介入信息")
                            .font(.caption.weight(.semibold))
                        Text("等待当前工具安全结束后应用；若本轮异常结束，正文会恢复到输入框。")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                } icon: {
                    Image(systemName: "arrow.turn.up.right")
                        .foregroundStyle(Color.accentColor)
                }
            }

            if let conflict = model.sessionConflict {
                Divider()
                conflictCard(conflict)
            }

            if let proposal = model.pendingPlanProposal {
                Divider()
                planProposalCard(proposal)
            }

            if let queue {
                if model.activity.currentRunState?.phase.requiresInteractionDock == true || model.followUp.pendingSteer != nil {
                    Divider()
                }
                followUpQueue(queue)
            }
        }
        .padding(10)
        .background(Color(nsColor: .windowBackgroundColor).opacity(0.72), in: RoundedRectangle(cornerRadius: 10))
        .overlay {
            RoundedRectangle(cornerRadius: 10)
                .stroke(Color.primary.opacity(0.09), lineWidth: 1)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("交互坞")
    }

    private func followUpQueue(_ queue: FollowUpQueueRecord) -> some View {
        DisclosureGroup(isExpanded: $showingFollowUpQueue) {
            VStack(alignment: .leading, spacing: 8) {
                if queue.items.isEmpty, queue.activeRunID != nil {
                    Label("当前后续消息已进入会话，正在等待本轮正常收口。", systemImage: "hourglass")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                ForEach(Array(queue.items.enumerated()), id: \.element.id) { index, item in
                    FollowUpQueueItemRow(
                        queueID: queue.id,
                        item: item,
                        position: index + 1,
                        canMoveUp: index > 0 && queue.items[index - 1].state == .pending,
                        canMoveDown: index + 1 < queue.items.count
                            && queue.items[index + 1].state == .pending
                    )
                }
                if let pauseReason = queue.pauseReason {
                    followUpPauseControls(queue: queue, reason: pauseReason)
                }
            }
            .padding(.top, 8)
        } label: {
            HStack(spacing: 7) {
                Image(systemName: queue.pauseReason == nil ? "text.line.first.and.arrowtriangle.forward" : "pause.circle")
                Text(followUpQueueLabel(queue))
                    .font(.caption.weight(.semibold))
                Spacer(minLength: 8)
                if let pauseReason = queue.pauseReason {
                    Text(pauseReason.label)
                        .font(.caption2)
                        .foregroundStyle(.orange)
                }
            }
            .contentShape(Rectangle())
        }
        .accessibilityLabel("后续消息队列，共 \(queue.items.count) 项")
    }

    private func runStatusLabel(_ state: SessionRunState) -> String {
        switch state.phase {
        case .running: "正在运行"
        case .waitingForUser: state.waitingFor?.label ?? "等待你处理"
        case .stopRequested: "正在停止"
        case .completed: "本轮已完成"
        case .failed: "本轮失败"
        case .aborted: "本轮已中止"
        case .unknown: "运行结果未知"
        }
    }

    private func runStatusDetail(_ state: SessionRunState) -> String {
        switch state.phase {
        case .running:
            "当前 Agent 正在处理；可选择立即介入，或等待本轮结束后再发送。"
        case .waitingForUser:
            state.waitingFor?.instruction ?? "请在结构化请求中完成处理；普通队列不会截获答案。"
        case .stopRequested:
            "停止请求已经发出，Host 尚未确认运行真正结束。"
        case .completed:
            "Host 已确认正常收口并形成稳定完成结果。"
        case .failed where state.inputPersisted:
            "输入已经进入 Pi 会话；D Code 不会自动重复发送，请从现有历史继续。"
        case .failed where state.retryable:
            "Host 已确认输入未进入 Pi 会话；草稿恢复后可以安全重试。"
        case .failed:
            "运行失败，但当前证据不足以自动重试。"
        case .aborted:
            "Host 已确认运行中止；尚未派发的后续消息仍被保留。"
        case .unknown:
            "D Code 无法证明最终结果；已阻止自动继续与重复发送。"
        }
    }

    private func runStatusIcon(_ phase: SessionRunPhase) -> String {
        switch phase {
        case .running: "waveform"
        case .waitingForUser: "person.crop.circle.badge.exclamationmark"
        case .stopRequested: "stop.circle"
        case .completed: "checkmark.circle"
        case .failed: "exclamationmark.triangle"
        case .aborted: "xmark.circle"
        case .unknown: "questionmark.circle"
        }
    }

    private func runStatusColor(_ phase: SessionRunPhase) -> Color {
        switch phase {
        case .running, .completed: .accentColor
        case .waitingForUser, .stopRequested, .unknown: .orange
        case .failed: .red
        case .aborted: .secondary
        }
    }

    @ViewBuilder
    private func followUpPauseControls(
        queue: FollowUpQueueRecord,
        reason: FollowUpQueuePauseReason
    ) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Label(reason.label, systemImage: "exclamationmark.circle")
                .font(.caption)
                .foregroundStyle(.orange)
            switch reason {
            case .dispatchUnknown:
                Text("先在会话历史中核对队首正文是否已经出现，再选择结果。")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                HStack {
                    Button("未进入会话") {
                        Task { await model.resolveUnknownDispatch(queue.id, wasPersisted: false) }
                    }
                    Button("已进入会话") {
                        Task { await model.resolveUnknownDispatch(queue.id, wasPersisted: true) }
                    }
                }
            case .runOutcomeUnknown:
                Text("确认上一轮已经停止，且当前路径内容完整后，再解除等待。")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Button("已核对上一轮") {
                    Task { await model.resolveUnknownRun(queue.id) }
                }
            default:
                Button("继续派发") {
                    Task { await model.resumeFollowUpQueue(queue.id) }
                }
                .disabled(model.isStreaming || model.followUp.isMutatingQueue)
            }
        }
        .buttonStyle(.borderless)
    }

    private var modelAndThinkingMenu: some View {
        Menu {
            modelPickerMenu
            Divider()
            thinkingPickerMenu
            speedPickerMenu
            if model.isNewSessionDraftActive {
                Divider()
                Button {
                    model.resetNewSessionRuntimeToPiDefaults()
                } label: {
                    Label("重置为 Pi 默认设置", systemImage: "arrow.counterclockwise")
                }
                .disabled(model.modelSettings.defaultModel == nil)
            }
        } label: {
            HStack(spacing: 5) {
                Image(systemName: "cpu")
                Text(model.modelSettings.isLoadingModels ? "载入模型…" : (model.composerModel?.displayName ?? "选择模型"))
                    .lineLimit(1)
                if let thinkingLevel = model.composerThinkingLevel {
                    Text(thinkingLabel(thinkingLevel))
                        .foregroundStyle(.purple)
                }
            }
            .font(.caption)
            .controlSize(.small)
            .frame(minHeight: PiDCodeMetrics.compactControlHeight)
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .help("配置模型、思考强度与速度")
        .accessibilityLabel(
            "模型 \(model.composerModel?.displayName ?? "未选择")，思考强度 \(thinkingLabel(model.composerThinkingLevel))，速度 \(speedLabel)"
        )
    }

    private var modelPickerMenu: some View {
        Menu {
            if model.modelSettings.isLoadingModels {
                Text("正在读取 Pi 模型…")
            } else if let issue = model.modelSettings.modelIssue {
                Text(issue)
                Button("重新载入模型") {
                    Task { await model.reloadNewSessionModels() }
                }
            } else if model.modelSettings.models.isEmpty {
                Text("没有可用模型")
            } else {
                ForEach(Array(Dictionary(grouping: model.modelSettings.models, by: \.provider).keys.sorted()), id: \.self) { provider in
                    Menu(provider) {
                        ForEach(model.modelSettings.models.filter { $0.provider == provider }) { candidate in
                            Button {
                                if model.isNewSessionDraftActive {
                                    model.selectNewSessionModel(candidate)
                                } else {
                                    Task { await model.setModel(candidate) }
                                }
                            } label: {
                                let title = model.isNewSessionDraftActive && model.isPiDefaultNewSessionModel(candidate)
                                    ? "\(candidate.displayName) · Pi 默认"
                                    : candidate.displayName
                                if candidate.id == model.composerModel?.id,
                                   candidate.provider == model.composerModel?.provider {
                                    Label(title, systemImage: "checkmark")
                                } else {
                                    Text(title)
                                }
                            }
                        }
                    }
                }
            }
        } label: {
            Label(
                "模型 · \(model.modelSettings.isLoadingModels ? "载入中" : (model.composerModel?.displayName ?? "未选择"))",
                systemImage: "cpu"
            )
        }
    }

    private var thinkingPickerMenu: some View {
        Menu {
            ForEach(model.composerThinkingLevels, id: \.self) { level in
                Button {
                    Task { await model.setComposerThinkingLevel(level) }
                } label: {
                    if level == model.composerThinkingLevel {
                        Label(thinkingLabel(level), systemImage: "checkmark")
                    } else {
                        Text(thinkingLabel(level))
                    }
                }
            }
        } label: {
            Label("推理强度 · \(thinkingLabel(model.composerThinkingLevel))", systemImage: "brain")
        }
        .disabled(model.composerModel == nil || model.composerThinkingLevels.isEmpty)
    }

    private var speedPickerMenu: some View {
        Menu {
            Button {
                Task { await model.setComposerFastModeEnabled(false) }
            } label: {
                if !model.composerFastModeEnabled {
                    Label("标准", systemImage: "checkmark")
                } else {
                    Text("标准")
                }
            }
            Button {
                Task { await model.setComposerFastModeEnabled(true) }
            } label: {
                if model.composerFastModeEnabled {
                    Label("极速", systemImage: "checkmark")
                } else {
                    Text("极速")
                }
            }
            .disabled(!model.composerFastModeSupported)
            if !model.composerFastModeSupported {
                Divider()
                Text("当前模型不支持极速")
            }
        } label: {
            Label("速度 · \(speedLabel)", systemImage: "gauge.with.dots.needle.50percent")
        }
    }

    private var contextPopover: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("上下文")
                .font(.headline)
            if let usage = model.hostState?.contextUsage {
                VStack(alignment: .leading, spacing: 4) {
                    // 主数字回答“用了多少”：已用 / 窗口；剩余百分比是次级信息。
                    Text("\(ConversationTimingFormatter.tokenText(usedTokens(for: usage))) / \(ConversationTimingFormatter.tokenText(usage.contextWindow))")
                        .font(.title3.monospacedDigit().weight(.semibold))
                    if let remainingPercent = usage.remainingPercent {
                        Text("剩余 \(remainingPercent.formatted(.number.precision(.fractionLength(0))))%")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                contextSegmentedBar(usage: usage)
                contextLegend
            } else {
                Text("暂不可用")
                    .foregroundStyle(.secondary)
                Text("当前会话或模型尚未返回可计算的 token 用量。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            compactionSection
        }
        .padding(16)
        .frame(width: 300)
        .task {
            await model.loadContextBreakdown()
            await model.loadCompactionInfo()
        }
    }

    private func usedTokens(for usage: ContextUsage) -> Int {
        usage.tokens ?? model.contextBreakdown?.totalTokens ?? 0
    }

    /// 分段彩色条：构成分项从左到右各占一段，颜色与图例一一对应；
    /// 无锚定时退化为单色用量条。
    private func contextSegmentedBar(usage: ContextUsage) -> some View {
        let usedFraction = min(1, max(0, usage.usedFraction ?? 0))
        return GeometryReader { proxy in
            let width = proxy.size.width
            HStack(spacing: 0) {
                if let breakdown = model.contextBreakdown, breakdown.available {
                    ForEach(Array(contextSegments(breakdown).enumerated()), id: \.offset) { _, segment in
                        Capsule()
                            .fill(contextPartColor(segment.row.kind))
                            .frame(width: width * segment.fraction)
                    }
                } else {
                    Capsule()
                        .fill(Color.accentColor.opacity(0.55))
                        .frame(width: width * usedFraction)
                }
                Spacer(minLength: 0)
            }
        }
        .frame(height: 8)
        .background(Capsule().fill(Color.primary.opacity(0.08)))
        .accessibilityHidden(true)
    }

    /// 从左到右累计的分段；总占比封顶 1，“系统与工具 + 剩余”留在底色。
    private func contextSegments(_ breakdown: ContextBreakdownResult) -> [(row: ContextCompositionRow, fraction: Double)] {
        var segments: [(ContextCompositionRow, Double)] = []
        var cursor = 0.0
        for row in visibleCompositionRows(breakdown) {
            guard let fraction = row.fraction, fraction > 0 else { continue }
            let clamped = min(fraction, max(0, 1 - cursor))
            if clamped <= 0 { break }
            segments.append((row, clamped))
            cursor += clamped
        }
        return segments
    }

    private func visibleCompositionRows(_ breakdown: ContextBreakdownResult) -> [ContextCompositionRow] {
        breakdown.compositionRows.filter { row in
            row.kind != .systemTools && (row.fraction ?? 0) > 0
        }
    }

    /// 图例：色点 + 分项 + token 与百分比；与分段条同色。
    private var contextLegend: some View {
        VStack(alignment: .leading, spacing: 5) {
            if let breakdown = model.contextBreakdown, breakdown.available {
                ForEach(breakdown.compositionRows) { row in
                    contextLegendRow(row, total: breakdown.totalTokens)
                }
                if breakdown.estimated == true {
                    Text("尚未取得真实用量锚定；系统与工具部分暂不可推算。")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            } else if !model.isLoadingContextBreakdown {
                Text("构成占比暂不可用。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                Text("构成估算载入中…")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func contextLegendRow(_ row: ContextCompositionRow, total: Int?) -> some View {
        HStack(spacing: 8) {
            Circle()
                .fill(row.kind == .systemTools ? Color.primary.opacity(0.18) : contextPartColor(row.kind))
                .frame(width: 8, height: 8)
            Text(row.kind.label)
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer(minLength: 4)
            if let tokens = row.tokens {
                Text(legendValue(row: row, tokens: tokens, total: total))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            } else {
                Text("推算中")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func legendValue(row: ContextCompositionRow, tokens: Int, total: Int?) -> String {
        let tokenPart = ConversationTimingFormatter.tokenText(tokens)
        guard let total, total > 0, let fraction = row.fraction else {
            return tokenPart
        }
        let percent = Int((fraction * 100).rounded())
        return "\(tokenPart)（\(percent)%）"
    }

    /// 压缩区：自动阈值（Pi 语义：用量超过 窗口 − reserveTokens 即触发）+ 手动压缩。
    @ViewBuilder
    private var compactionSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Divider()
            if model.hostState?.isCompacting == true {
                Label("正在压缩上下文…", systemImage: "compress")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.orange)
            } else if let info = model.compactionInfo {
                if info.enabled, let window = model.hostState?.contextUsage?.contextWindow, window > 0 {
                    let thresholdPercent = Int((Double(window - info.reserveTokens) / Double(window) * 100).rounded())
                    Text("自动压缩：用量超过约 \(thresholdPercent)% 时自动进行")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else if !info.enabled {
                    Text("自动压缩已在 Pi 设置中关闭")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    Text("自动压缩阈值未知")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            } else {
                Text("自动压缩阈值载入中…")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Button(model.isStreaming ? "手动压缩（将中止当前运行）…" : "手动压缩…") {
                Task { await model.compactSession() }
            }
            .controlSize(.small)
            .disabled(
                model.hostState?.isCompacting == true
                    || !model.canWrite
            )
            .help("立即压缩当前会话上下文（Pi 会先中止当前操作；进行中会显示压缩状态）")
        }
    }

    /// 构成占比：分项 token 为估算口径（与 Pi 压缩判断一致），
    /// “系统与工具”由真实总量反推；无锚定时只显示消息分项。
    private var contextCompositionSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Divider()
            HStack {
                Text("构成")
                    .font(.subheadline.weight(.semibold))
                Spacer()
                Text(model.isLoadingContextBreakdown ? "载入中…" : "估算")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            if let breakdown = model.contextBreakdown {
                if breakdown.available {
                    ForEach(breakdown.compositionRows) { row in
                        contextCompositionRow(row)
                    }
                    if let free = breakdown.freeTokens {
                        contextCompositionRow(
                            ContextCompositionRow(kind: .systemTools, tokens: nil, fraction: nil),
                            freeLabel: "剩余可用 \(free.formatted())"
                        )
                    }
                    if breakdown.estimated == true {
                        Text("尚未取得真实用量锚定；系统与工具部分暂不可推算。")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                } else {
                    Text("当前为只读观察，构成占比需要打开为可写会话。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            } else if !model.isLoadingContextBreakdown {
                Text("构成占比暂不可用。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func contextCompositionRow(_ row: ContextCompositionRow, freeLabel: String? = nil) -> some View {
        HStack(spacing: 8) {
            Text(row.kind.label)
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(width: 62, alignment: .leading)
            GeometryReader { proxy in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.primary.opacity(0.08))
                    if let fraction = row.fraction {
                        Capsule()
                            .fill(contextPartColor(row.kind))
                            .frame(width: proxy.size.width * fraction)
                    }
                }
            }
            .frame(height: 6)
            Text(freeLabel ?? row.tokens.map { $0.formatted() } ?? "推算中")
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
                .frame(width: 64, alignment: .trailing)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(
            freeLabel ?? "\(row.kind.label) \(row.tokens.map { $0.formatted() } ?? "推算中") token"
        )
    }

    private func contextPartColor(_ kind: ContextPartKind) -> Color {
        switch kind {
        case .systemTools: .gray
        case .user: .accentColor
        case .assistant: .blue
        case .thinking: .purple
        case .toolResult: .green
        }
    }

    /// 冲突卡：外部写入或写入权被接管后，停止写入、保留草稿，一键重新接管。
    private func conflictCard(_ conflict: SessionConflictPresentation) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: conflict.isTakeover ? "arrow.triangle.2.circlepath" : "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 2) {
                Text(conflict.isTakeover ? "写入权已被其他 D Code 窗口接管" : "检测到 Pi 的新写入")
                    .font(.caption.weight(.semibold))
                Text(conflict.isTakeover
                    ? "草稿已保留；重新接管会从另一个窗口取回写入权。"
                    : "D Code 已停止写入并保留草稿；重新接管后可继续发送。")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            Button {
                Task { await model.retakeSessionOwnership() }
            } label: {
                Text("重新接管")
            }
            .controlSize(.small)
            .buttonStyle(.borderedProminent)
            .disabled(model.isOpeningSession)
            .help("重新以可写打开当前会话")
        }
        .accessibilityElement(children: .combine)
    }

    /// dgoal 待批计划提案卡：呈现提案并一键发起 `/dgoal review`，
    /// 由 dgoal 的原生启动门禁对话框完成实际批准 / 拒绝 / 反馈。
    private func planProposalCard(_ proposal: PlanProposalPresentation) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "doc.badge.gearshape")
                .foregroundStyle(Color.purple)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text("待批准计划提案")
                        .font(.caption.weight(.semibold))
                    Text(proposal.profile.label)
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(Color.purple.opacity(0.12), in: Capsule())
                }
                Text(proposal.objective)
                    .font(.caption)
                    .lineLimit(2)
                Text(proposalDetail(proposal))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            Button {
                Task { await model.requestPlanReview() }
            } label: {
                Text(model.hasActiveRun ? "运行结束可审阅" : "审阅提案")
            }
            .controlSize(.small)
            .buttonStyle(.borderedProminent)
            .disabled(model.hasActiveRun || model.isSendingRequest)
            .help("发送 /dgoal review，由 dgoal 弹出原生审阅对话框")
        }
        .accessibilityElement(children: .combine)
    }

    private func proposalDetail(_ proposal: PlanProposalPresentation) -> String {
        var parts: [String] = []
        if !proposal.phaseSubjects.isEmpty {
            parts.append("\(proposal.phaseSubjects.count) 个阶段")
        }
        if !proposal.acceptanceCriteria.isEmpty {
            parts.append("\(proposal.acceptanceCriteria.count) 条验收")
        }
        if !proposal.nonGoals.isEmpty {
            parts.append("排除 \(proposal.nonGoals.count) 项")
        }
        return parts.isEmpty ? "等待用户批准后才进入执行" : parts.joined(separator: " · ") + " · 等待批准"
    }

    private var contextRemainingRing: some View {
        ZStack {
            Circle()
                .stroke(contextRemainingColor, lineWidth: 3)
            if let usedFraction = model.hostState?.contextUsage?.usedFraction {
                Circle()
                    .trim(from: 0, to: usedFraction)
                    .stroke(
                        Color.white.opacity(0.94),
                        style: StrokeStyle(lineWidth: 3, lineCap: .round)
                    )
                    .rotationEffect(.degrees(-90))
                    .animation(.smooth(duration: 0.25), value: usedFraction)
            }
        }
        .accessibilityHidden(true)
    }

    /// 余量环保持“蓝为剩余、白为已用”；跌破阈值后底环转橙 / 红，提示即将耗尽。
    private var contextRemainingColor: Color {
        guard let remaining = model.hostState?.contextUsage?.remainingPercent else { return .accentColor }
        if remaining < 8 { return .red }
        if remaining < 20 { return .orange }
        return .accentColor
    }

    private var contextDeltaCaption: String? {
        let delta = model.contextDelta
        guard !delta.isEmpty else { return nil }
        var parts: [String] = []
        if delta.added > 0 { parts.append("+\(delta.added.formatted())") }
        if delta.released > 0 { parts.append("−\(delta.released.formatted())") }
        return parts.isEmpty ? nil : parts.joined(separator: " ")
    }

    private var commandPalette: some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(Array(commandSuggestions.prefix(6).enumerated()), id: \.element.id) { index, command in
                Button {
                    applyCommandSelection(at: index)
                } label: {
                    HStack(spacing: 10) {
                        Text("/\(command.name)")
                            .font(.callout.monospaced().weight(.medium))
                            .foregroundStyle(.primary)
                        Text(command.description ?? command.source)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                        Spacer()
                        Text(command.source)
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                    .padding(.horizontal, 16)
                    .frame(minHeight: PiDCodeMetrics.minimumTarget)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .background(
                    index == selectedCommandIndex
                        ? Color.accentColor.opacity(0.12)
                        : Color.clear,
                    in: RoundedRectangle(cornerRadius: PiDCodeMetrics.compactRadius, style: .continuous)
                )
                .accessibilityAddTraits(index == selectedCommandIndex ? .isSelected : [])
            }
        }
        .padding(.vertical, 5)
        .background(Color(nsColor: .controlBackgroundColor))
    }

    private func applyCommandSelection(at index: Int) {
        let suggestions = Array(commandSuggestions.prefix(6))
        guard suggestions.indices.contains(index) else { return }
        model.updateComposerText("/\(suggestions[index].name) ")
        selectedCommandIndex = 0
        focused = true
    }

    /// 命令面板键盘导航（↑↓ 选择、Esc 关闭）；返回false表示事件交回输入框默认处理。
    private func handlePaletteKey(_ key: ComposerPaletteKey) -> Bool {
        let visibleCount = min(commandSuggestions.count, 6)
        guard visibleCount > 0 else { return false }
        switch key {
        case .up:
            selectedCommandIndex = max(0, selectedCommandIndex - 1)
            return true
        case .down:
            selectedCommandIndex = min(visibleCount - 1, selectedCommandIndex + 1)
            return true
        case .escape:
            model.updateComposerText("")
            selectedCommandIndex = 0
            return true
        }
    }

    private var sendEnabled: Bool {
        model.canSubmitComposerText(deliveryMode: runningDeliveryMode)
    }

    private var composerIsEnabled: Bool {
        !model.isCreatingSession
            && !model.isSendingRequest
            && model.pendingPrompt == nil
            && model.followUp.pendingSteer == nil
            && !model.followUp.isMutatingQueue
    }

    private var commandSuggestions: [CommandDescriptor] {
        guard !model.shouldQueueComposerText,
              model.canWrite,
              model.composerText.hasPrefix("/") else { return [] }
        let fragment = model.composerText.dropFirst().split(separator: " ", maxSplits: 1).first.map(String.init) ?? ""
        guard !model.composerText.contains(" ") else { return [] }
        return model.availableCommands.filter { fragment.isEmpty || $0.name.localizedCaseInsensitiveContains(fragment) }
    }

    private var contextHelpLabel: String {
        guard let usage = model.hostState?.contextUsage,
              let remainingPercent = usage.remainingPercent else { return "上下文剩余量暂不可用" }
        let remaining = remainingPercent.formatted(.number.precision(.fractionLength(0)))
        guard let tokens = usage.tokens else { return "上下文剩余 \(remaining)%" }
        return "上下文剩余 \(remaining)% · 已用 \(tokens.formatted()) / \(usage.contextWindow.formatted()) token"
    }

    private var contextAccessibilityLabel: String {
        guard let usage = model.hostState?.contextUsage else { return "暂不可用" }
        let remaining = usage.remainingPercent.map {
            "\($0.formatted(.number.precision(.fractionLength(0))))% 剩余"
        } ?? "剩余量待估算"
        let tokens = usage.tokens?.formatted() ?? "待估算"
        return "\(remaining)，已用 \(tokens) / \(usage.contextWindow.formatted()) token"
    }

    private var speedLabel: String {
        if model.composerFastModeEnabled, !model.composerFastModeSupported { return "极速（不支持）" }
        return model.composerFastModeEnabled ? "极速" : "标准"
    }

    private var composerPlaceholder: String {
        if model.isNewSessionDraftActive {
            return ComposerPlaceholderCopy.idle
        }
        return model.shouldQueueComposerText
            ? (model.hasActiveRun && runningDeliveryMode == .steer
                ? ComposerPlaceholderCopy.steerRunning
                : ComposerPlaceholderCopy.queueNext)
            : ComposerPlaceholderCopy.idle
    }

    private var runningDeliveryMode: RunningMessageDeliveryMode {
        RunningMessageDeliveryMode(rawValue: runningDeliveryRawValue) ?? .steer
    }

    private var submitHelp: String {
        if model.hasActiveRun, runningDeliveryMode == .steer {
            return "立即介入当前运行（↩）"
        }
        if model.shouldQueueComposerText {
            return "加入后续消息队列（↩）"
        }
        return "发送（↩）"
    }

    private var submitAccessibilityLabel: String {
        if model.isNewSessionDraftActive { return "发送并创建会话" }
        if model.hasActiveRun, runningDeliveryMode == .steer { return "立即介入当前运行" }
        if model.shouldQueueComposerText { return "加入后续消息队列" }
        if model.pendingPathDraft != nil { return "发送并创建新路径" }
        return "发送消息"
    }

    private var interfaceFontScale: DCodeInterfaceFontScale {
        DCodeInterfaceFontScale.resolve(interfaceFontScaleRawValue)
    }

    private var composerBodyFontSize: CGFloat {
        interfaceFontScale.composerBodyFontSize
    }

    private var composerBodyFont: NSFont {
        NSFont.systemFont(ofSize: composerBodyFontSize, weight: .regular)
    }

    private func submitComposer() {
        if !commandSuggestions.isEmpty {
            applyCommandSelection(at: selectedCommandIndex)
            return
        }
        guard sendEnabled else { return }
        Task { await model.sendPrompt(deliveryMode: runningDeliveryMode) }
    }

    private func followUpQueueLabel(_ queue: FollowUpQueueRecord) -> String {
        if queue.items.isEmpty, queue.activeRunID != nil { return "后续消息运行中" }
        return "后续消息 \(queue.items.count)"
    }

    private func thinkingLabel(_ value: String?) -> String {
        switch value {
        case "off": "关闭"
        case "minimal": "最低"
        case "low": "低"
        case "medium": "中"
        case "high": "高"
        case "xhigh": "极高"
        case "max": "最大"
        case let value?: value
        case nil: "思考"
        }
    }
}

/// 占位符文案。视觉预算见设计系统 3.4（hint 档）与 7.6：一行、上限 `copyBudget`
/// 个字符、最多一条教学子句，且只教已经实现的快捷输入——`@ 添加上下文` 的插入能力
/// 尚未实现，不在占位符里预告。
enum ComposerPlaceholderCopy {
    /// 预算按全宽字符当量计（CJK 与全宽标点记 1，ASCII 记 0.5），
    /// 因为 `交给 D Code 一项工作` 这类中英混排里 ASCII 只占半格。
    static let copyBudget: Double = 18

    static let idle = "交给 D Code 一项工作，/ 使用命令"
    static let steerRunning = "输入要立即介入当前运行的信息"
    static let queueNext = "写下下一步，加入后续消息队列"

    static let all = [idle, steerRunning, queueNext]

    static func displayWidth(_ text: String) -> Double {
        text.unicodeScalars.reduce(0) { $0 + (isFullWidth($1) ? 1 : 0.5) }
    }

    private static func isFullWidth(_ scalar: Unicode.Scalar) -> Bool {
        let ranges: [ClosedRange<UInt32>] = [
            0x1100...0x115F, 0x2E80...0x303E, 0x3041...0x33FF,
            0x3400...0x4DBF, 0x4E00...0x9FFF, 0xA000...0xA4CF,
            0xAC00...0xD7A3, 0xF900...0xFAFF, 0xFE30...0xFE4F,
            0xFF00...0xFF60, 0xFFE0...0xFFE6,
        ]
        return ranges.contains { $0.contains(scalar.value) }
    }
}

enum ComposerKeyPolicy {
    static func shouldSubmit(keyCode: UInt16, modifiers: NSEvent.ModifierFlags) -> Bool {
        guard keyCode == 36 || keyCode == 76 else { return false }
        return !modifiers.contains(.shift) && !modifiers.contains(.option)
    }
}

/// 命令面板键盘导航事件：由输入框在文本编辑默认处理之前转发。
enum ComposerPaletteKey {
    case up
    case down
    case escape
}

final class ComposerNSTextView: NSTextView {
    var submit: (() -> Void)?
    var navigate: ((ComposerPaletteKey) -> Bool)?

    /// 占位符由文本视图自己绘制在 text container 原点，与真实首行共用同一套
    /// 布局几何：界面字号档位切换时不会再和输入正文错位，也不需要手工偏移常数。
    /// 颜色固定在 `tertiaryLabelColor`（提示档，约 `0.26`）。注意不能用
    /// `placeholderTextColor`——它在 macOS 上与 `secondaryLabelColor` 同为
    /// `0.5`，属于次级元信息档，空输入框会读成"已经有内容"。
    var placeholder: String = "" {
        didSet {
            guard placeholder != oldValue else { return }
            setAccessibilityPlaceholderValue(placeholder)
            needsDisplay = true
        }
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard string.isEmpty, !placeholder.isEmpty else { return }
        let placeholderFont = font ?? .systemFont(ofSize: NSFont.systemFontSize)
        (placeholder as NSString).draw(
            at: textContainerOrigin,
            withAttributes: [
                .font: placeholderFont,
                .foregroundColor: NSColor.tertiaryLabelColor,
            ]
        )
    }

    override func didChangeText() {
        super.didChangeText()
        needsDisplay = true
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
    }

    override func keyDown(with event: NSEvent) {
        switch event.keyCode {
        case 126 where navigate?(.up) == true: return
        case 125 where navigate?(.down) == true: return
        case 53 where navigate?(.escape) == true: return
        default: break
        }
        if ComposerKeyPolicy.shouldSubmit(keyCode: event.keyCode, modifiers: event.modifierFlags) {
            submit?()
            return
        }
        super.keyDown(with: event)
    }
}

private struct ComposerTextEditor: NSViewRepresentable {
    @Binding var text: String
    let isEnabled: Bool
    let font: NSFont
    let placeholder: String
    let onSubmit: () -> Void
    let navigate: (ComposerPaletteKey) -> Bool

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = NSScrollView()
        scrollView.drawsBackground = false
        scrollView.borderType = .noBorder
        scrollView.hasVerticalScroller = false
        scrollView.hasHorizontalScroller = false

        let textView = ComposerNSTextView()
        textView.delegate = context.coordinator
        textView.drawsBackground = false
        textView.isRichText = false
        textView.allowsUndo = true
        textView.font = font
        textView.textContainerInset = .zero
        textView.textContainer?.lineFragmentPadding = 0
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.autoresizingMask = [.width]
        textView.textContainer?.widthTracksTextView = true
        textView.string = text
        textView.submit = onSubmit
        textView.navigate = navigate
        textView.placeholder = placeholder
        textView.setAccessibilityLabel("消息输入")
        scrollView.documentView = textView
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        guard let textView = scrollView.documentView as? ComposerNSTextView else { return }
        context.coordinator.parent = self
        textView.submit = onSubmit
        textView.navigate = navigate
        textView.placeholder = placeholder
        textView.isEditable = isEnabled
        if textView.font?.pointSize != font.pointSize {
            textView.font = font
            textView.needsDisplay = true
        }
        textView.isSelectable = true
        if textView.string != text {
            context.coordinator.isUpdating = true
            let selection = textView.selectedRange()
            textView.string = text
            textView.setSelectedRange(NSRange(
                location: min(selection.location, text.utf16.count),
                length: 0
            ))
            context.coordinator.isUpdating = false
        }
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: ComposerTextEditor
        var isUpdating = false

        init(_ parent: ComposerTextEditor) {
            self.parent = parent
        }

        func textDidChange(_ notification: Notification) {
            guard !isUpdating,
                  let textView = notification.object as? NSTextView else { return }
            parent.text = textView.string
        }
    }
}

private struct FollowUpQueueItemRow: View {
    @Environment(AppModel.self) private var model
    let queueID: String
    let item: FollowUpQueueItem
    let position: Int
    let canMoveUp: Bool
    let canMoveDown: Bool

    @State private var editing = false
    @State private var editedText: String

    init(
        queueID: String,
        item: FollowUpQueueItem,
        position: Int,
        canMoveUp: Bool,
        canMoveDown: Bool
    ) {
        self.queueID = queueID
        self.item = item
        self.position = position
        self.canMoveUp = canMoveUp
        self.canMoveDown = canMoveDown
        _editedText = State(initialValue: item.text)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("\(position)")
                    .font(.caption2.monospacedDigit().weight(.semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 18, alignment: .trailing)
                Text(item.state.label)
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(item.state == .unknown ? .orange : .secondary)
                Spacer()
                if item.state == .pending, !editing {
                    Button {
                        editedText = item.text
                        editing = true
                    } label: {
                        Image(systemName: "pencil")
                    }
                    .help("编辑第 \(position) 条后续消息")
                    .accessibilityLabel("编辑第 \(position) 条后续消息")
                    Button {
                        Task { await model.moveFollowUpItem(queueID: queueID, itemID: item.id, offset: -1) }
                    } label: {
                        Image(systemName: "arrow.up")
                    }
                    .disabled(!canMoveUp || model.followUp.isMutatingQueue)
                    .help("上移第 \(position) 条后续消息")
                    .accessibilityLabel("上移第 \(position) 条后续消息")
                    Button {
                        Task { await model.moveFollowUpItem(queueID: queueID, itemID: item.id, offset: 1) }
                    } label: {
                        Image(systemName: "arrow.down")
                    }
                    .disabled(!canMoveDown || model.followUp.isMutatingQueue)
                    .help("下移第 \(position) 条后续消息")
                    .accessibilityLabel("下移第 \(position) 条后续消息")
                    Button(role: .destructive) {
                        Task { await model.removeFollowUpItem(queueID: queueID, itemID: item.id) }
                    } label: {
                        Image(systemName: "trash")
                    }
                    .disabled(model.followUp.isMutatingQueue)
                    .help("撤回第 \(position) 条后续消息")
                    .accessibilityLabel("撤回第 \(position) 条后续消息")
                }
            }
            if editing {
                TextField("后续消息正文", text: $editedText, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .lineLimit(2...8)
                HStack {
                    Spacer()
                    Button("取消") {
                        editedText = item.text
                        editing = false
                    }
                    Button("保存") {
                        let text = editedText
                        Task {
                            await model.editFollowUpItem(queueID: queueID, itemID: item.id, text: text)
                            if model.followUp.queues
                                .flatMap(\.items)
                                .first(where: { $0.id == item.id })?.text == text {
                                editing = false
                            }
                        }
                    }
                    .disabled(
                        editedText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                            || editedText == item.text
                            || model.followUp.isMutatingQueue
                    )
                }
            } else {
                Text(item.text)
                    .font(.caption)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(8)
        .background(Color.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 8))
        .buttonStyle(.borderless)
        .onChange(of: item.text) { _, newValue in
            if !editing { editedText = newValue }
        }
        .accessibilityElement(children: .contain)
    }
}
