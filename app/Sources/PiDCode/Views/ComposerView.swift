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
                if let queue = model.currentFollowUpQueue {
                    followUpQueue(queue)
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
            Button {
                showingContext.toggle()
            } label: {
                Label(contextCompactLabel, systemImage: "chart.pie")
                    .lineLimit(1)
                    .frame(minHeight: PiDCodeMetrics.compactControlHeight)
            }
            .buttonStyle(.borderless)
            .popover(isPresented: $showingContext, arrowEdge: .bottom) {
                contextPopover
            }
            .help("查看上下文占用")
            .accessibilityLabel("上下文占用：\(contextAccessibilityLabel)")
            .disabled(model.isNewSessionDraftActive)

            Button {
                Task { await model.toggleFastMode() }
            } label: {
                Label(fastLabel, systemImage: "bolt.fill")
                    .foregroundStyle(fastColor)
                    .lineLimit(1)
                    .frame(minHeight: PiDCodeMetrics.compactControlHeight)
            }
            .buttonStyle(.borderless)
            .accessibilityLabel(fastAccessibilityLabel)
            .help(fastHelp)
            .disabled(
                model.isNewSessionDraftActive
                    || model.pendingPathDraft != nil
                    || model.isPromptTransactionActive
            )

            Spacer(minLength: 4)

            modelAndThinkingMenu
                .disabled(
                    model.isNewSessionDraftActive
                        || model.pendingPathDraft != nil
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

            if model.isStreaming {
                Button {
                    Task { await model.abort() }
                } label: {
                    Image(systemName: "stop.fill")
                        .foregroundStyle(.white)
                        .frame(
                            width: PiDCodeMetrics.prominentIconActionTarget,
                            height: PiDCodeMetrics.prominentIconActionTarget
                        )
                        .background(Color.red, in: Circle())
                }
                .buttonStyle(.plain)
                .help("停止当前运行")
                .accessibilityLabel("停止当前运行")
            } else if !model.shouldQueueComposerText {
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
        .padding(10)
        .background(Color(nsColor: .windowBackgroundColor).opacity(0.72), in: RoundedRectangle(cornerRadius: 10))
        .overlay {
            RoundedRectangle(cornerRadius: 10)
                .stroke(Color.primary.opacity(0.09), lineWidth: 1)
        }
        .accessibilityLabel("后续消息队列，共 \(queue.items.count) 项")
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
            if model.availableModels.isEmpty {
                Text("没有可用模型")
            } else {
                ForEach(Array(Dictionary(grouping: model.availableModels, by: \.provider).keys.sorted()), id: \.self) { provider in
                    Menu(provider) {
                        ForEach(model.availableModels.filter { $0.provider == provider }) { candidate in
                            Button {
                                Task { await model.setModel(candidate) }
                            } label: {
                                if candidate.id == model.hostState?.model?.id,
                                   candidate.provider == model.hostState?.model?.provider {
                                    Label(candidate.displayName, systemImage: "checkmark")
                                } else {
                                    Text(candidate.displayName)
                                }
                            }
                        }
                    }
                }
            }
            Divider()
            Menu("思考强度") {
                ForEach(model.availableThinkingLevels, id: \.self) { level in
                    Button {
                        Task { await model.setThinkingLevel(level) }
                    } label: {
                        if level == model.hostState?.thinkingLevel {
                            Label(thinkingLabel(level), systemImage: "checkmark")
                        } else {
                            Text(thinkingLabel(level))
                        }
                    }
                }
            }
        } label: {
            HStack(spacing: 5) {
                Image(systemName: "cpu")
                Text(model.hostState?.model?.displayName ?? "模型")
                    .lineLimit(1)
                Text(thinkingLabel(model.hostState?.thinkingLevel))
                    .foregroundStyle(.purple)
            }
            .frame(minHeight: PiDCodeMetrics.compactControlHeight)
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .help("切换模型与思考强度")
        .accessibilityLabel("模型 \(model.hostState?.model?.displayName ?? "未知")，思考强度 \(thinkingLabel(model.hostState?.thinkingLevel))")
    }

    private var contextPopover: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("上下文占用")
                .font(.headline)
            if let usage = model.hostState?.contextUsage {
                if let percent = usage.percent {
                    ProgressView(value: percent, total: 100)
                    Text("\(percent.formatted(.number.precision(.fractionLength(0))))%")
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

    private var contextCompactLabel: String {
        guard let percent = model.hostState?.contextUsage?.percent else { return "上下文" }
        return "\(percent.formatted(.number.precision(.fractionLength(0))))%"
    }

    private var contextAccessibilityLabel: String {
        guard let usage = model.hostState?.contextUsage else { return "暂不可用" }
        let percent = usage.percent.map { "\($0.formatted(.number.precision(.fractionLength(0))))%" } ?? "待估算"
        let tokens = usage.tokens?.formatted() ?? "待估算"
        return "\(percent)，\(tokens) / \(usage.contextWindow.formatted()) token"
    }

    private var fastLabel: String {
        guard let fast = model.hostState?.fastMode else { return "极速" }
        if fast.enabled, !fast.active { return "极速：开 · 不支持" }
        return fast.enabled ? "极速：开" : "极速：关"
    }

    private var fastAccessibilityLabel: String {
        guard let fast = model.hostState?.fastMode else { return "极速模式：状态读取中" }
        if fast.enabled, !fast.active { return "极速模式：已开启，但当前模型不支持" }
        return fast.enabled ? "极速模式：开启" : "极速模式：关闭"
    }

    private var fastHelp: String {
        guard let fast = model.hostState?.fastMode else { return "正在读取当前会话的极速状态" }
        if fast.enabled, !fast.active { return "已开启，但当前 Provider 或模型不支持，请求不会改变" }
        return fast.enabled ? "当前请求会申请 priority 服务等级" : "使用默认服务等级"
    }

    private var fastColor: Color {
        guard let fast = model.hostState?.fastMode else { return .secondary }
        if fast.enabled, !fast.active { return .orange }
        return fast.enabled ? .accentColor : .secondary
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
