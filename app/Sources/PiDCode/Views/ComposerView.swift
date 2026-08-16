import SwiftUI

struct ComposerView: View {
    @Environment(AppModel.self) private var model
    @FocusState private var focused: Bool
    @State private var showingContext = false
    @State private var showingFollowUpQueue = true

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
                if let followUpQueueIssue = model.followUpQueueIssue {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Label(followUpQueueIssue, systemImage: "exclamationmark.triangle.fill")
                            .font(.caption)
                            .foregroundStyle(.orange)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .accessibilityLabel("后续消息队列不可写：\(followUpQueueIssue)")
                        Button("重新载入") {
                            Task { await model.reloadFollowUpQueues() }
                        }
                        .buttonStyle(.borderless)
                        .disabled(model.isMutatingFollowUpQueue)
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
                if model.currentRunState != nil || model.currentFollowUpQueue != nil {
                    interactionDock(queue: model.currentFollowUpQueue)
                }
                TextField(
                    composerPlaceholder,
                    text: text,
                    axis: .vertical
                )
                .textFieldStyle(.plain)
                .font(.body)
                .lineLimit(3...7)
                .frame(minHeight: 66, maxHeight: 126, alignment: .topLeading)
                .focused($focused)
                .disabled(
                    model.isCreatingSession
                        || model.isSendingRequest
                        || model.pendingPrompt != nil
                        || model.isMutatingFollowUpQueue
                )
                .accessibilityLabel("消息输入")

                runtimeControls
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .dCodeFloatingSurface(cornerRadius: 16)
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
    }

    private var runtimeControls: some View {
        HStack(spacing: 4) {
            Spacer(minLength: 4)

            Button {
                showingContext.toggle()
            } label: {
                contextRemainingRing
                    .frame(width: 18, height: 18)
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
            .disabled(model.isNewSessionDraftActive)

            modelAndThinkingMenu
                .disabled(
                    model.pendingPathDraft != nil
                        || model.isPromptTransactionActive
                )

            if model.shouldQueueComposerText {
                Button {
                    Task { await model.sendPrompt() }
                } label: {
                    Image(systemName: "text.badge.plus")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(.white)
                        .frame(
                            width: PiDCodeMetrics.prominentIconActionTarget,
                            height: PiDCodeMetrics.prominentIconActionTarget
                        )
                        .background(sendEnabled ? Color.accentColor : Color.secondary.opacity(0.35), in: Circle())
                }
                .buttonStyle(.plain)
                .keyboardShortcut(.return, modifiers: .command)
                .disabled(!sendEnabled)
                .help("加入后续消息（⌘↩）")
                .accessibilityLabel("加入后续消息队列")
            }

            if !model.isStreaming && !model.shouldQueueComposerText {
                Button {
                    Task { await model.sendPrompt() }
                } label: {
                    Image(systemName: "arrow.up")
                        .font(.body.weight(.bold))
                        .foregroundStyle(.white)
                        .frame(
                            width: PiDCodeMetrics.prominentIconActionTarget,
                            height: PiDCodeMetrics.prominentIconActionTarget
                        )
                        .background(sendEnabled ? Color.accentColor : Color.secondary.opacity(0.35), in: Circle())
                }
                .buttonStyle(.plain)
                .keyboardShortcut(.return, modifiers: .command)
                .disabled(!sendEnabled)
                .help("发送（⌘↩）")
                .accessibilityLabel(
                    model.isNewSessionDraftActive
                        ? "发送并创建会话"
                        : (model.pendingPathDraft == nil ? "发送消息" : "发送并创建新路径")
                )
            }
        }
        .font(.caption)
    }

    private func interactionDock(queue: FollowUpQueueRecord?) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            if let runState = model.currentRunState {
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

            if let queue {
                if model.currentRunState != nil { Divider() }
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
            "当前 Agent 正在处理；后续消息只进入 D Code 队列。"
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
                .disabled(model.isStreaming || model.isMutatingFollowUpQueue)
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
                .disabled(model.newSessionDefaultModel == nil)
            }
        } label: {
            HStack(spacing: 5) {
                Image(systemName: "cpu")
                Text(model.isLoadingNewSessionModels ? "载入模型…" : (model.composerModel?.displayName ?? "选择模型"))
                    .lineLimit(1)
                if let thinkingLevel = model.composerThinkingLevel {
                    Text(thinkingLabel(thinkingLevel))
                        .foregroundStyle(.purple)
                }
            }
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
            if model.isLoadingNewSessionModels {
                Text("正在读取 Pi 模型…")
            } else if let issue = model.newSessionModelIssue {
                Text(issue)
                Button("重新载入模型") {
                    Task { await model.reloadNewSessionModels() }
                }
            } else if model.availableModels.isEmpty {
                Text("没有可用模型")
            } else {
                ForEach(Array(Dictionary(grouping: model.availableModels, by: \.provider).keys.sorted()), id: \.self) { provider in
                    Menu(provider) {
                        ForEach(model.availableModels.filter { $0.provider == provider }) { candidate in
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
                "模型 · \(model.isLoadingNewSessionModels ? "载入中" : (model.composerModel?.displayName ?? "未选择"))",
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
        VStack(alignment: .leading, spacing: 10) {
            Text("上下文")
                .font(.headline)
            if let usage = model.hostState?.contextUsage {
                if let remainingPercent = usage.remainingPercent {
                    ProgressView(value: remainingPercent, total: 100)
                    Text("\(remainingPercent.formatted(.number.precision(.fractionLength(0))))% 剩余")
                        .font(.title3.monospacedDigit().weight(.semibold))
                } else {
                    Text("暂不可用")
                        .font(.title3.weight(.semibold))
                }
                if let tokens = usage.tokens {
                    LabeledContent("已使用", value: tokens.formatted())
                } else {
                    LabeledContent("已使用", value: "待估算")
                }
                LabeledContent("窗口", value: usage.contextWindow.formatted())
            } else {
                Text("暂不可用")
                    .foregroundStyle(.secondary)
                Text("当前会话或模型尚未返回可计算的 token 用量。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(16)
        .frame(width: 230)
    }

    private var contextRemainingRing: some View {
        ZStack {
            Circle()
                .stroke(Color.secondary.opacity(0.22), lineWidth: 3)
            if let remainingPercent = model.hostState?.contextUsage?.remainingPercent {
                Circle()
                    .trim(from: 0, to: remainingPercent / 100)
                    .stroke(
                        Color.secondary,
                        style: StrokeStyle(lineWidth: 3, lineCap: .round)
                    )
                    .rotationEffect(.degrees(-90))
            }
        }
        .accessibilityHidden(true)
    }

    private var commandPalette: some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(commandSuggestions.prefix(6)) { command in
                Button {
                    model.updateComposerText("/\(command.name) ")
                    focused = true
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
            }
        }
        .padding(.vertical, 5)
        .background(Color(nsColor: .controlBackgroundColor))
    }

    private var sendEnabled: Bool {
        model.canSubmitComposerText
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
            return "输入第一条消息；发送后才会创建 Pi 会话"
        }
        return model.shouldQueueComposerText
            ? "写下下一步，加入后续消息队列"
            : "交给 D Code 一项工作，或输入 / 使用命令"
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
                    .disabled(!canMoveUp || model.isMutatingFollowUpQueue)
                    .help("上移第 \(position) 条后续消息")
                    .accessibilityLabel("上移第 \(position) 条后续消息")
                    Button {
                        Task { await model.moveFollowUpItem(queueID: queueID, itemID: item.id, offset: 1) }
                    } label: {
                        Image(systemName: "arrow.down")
                    }
                    .disabled(!canMoveDown || model.isMutatingFollowUpQueue)
                    .help("下移第 \(position) 条后续消息")
                    .accessibilityLabel("下移第 \(position) 条后续消息")
                    Button(role: .destructive) {
                        Task { await model.removeFollowUpItem(queueID: queueID, itemID: item.id) }
                    } label: {
                        Image(systemName: "trash")
                    }
                    .disabled(model.isMutatingFollowUpQueue)
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
                            if model.followUpQueues
                                .flatMap(\.items)
                                .first(where: { $0.id == item.id })?.text == text {
                                editing = false
                            }
                        }
                    }
                    .disabled(
                        editedText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                            || editedText == item.text
                            || model.isMutatingFollowUpQueue
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
