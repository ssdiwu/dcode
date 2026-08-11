import SwiftUI

struct ComposerView: View {
    @Environment(AppModel.self) private var model
    @FocusState private var focused: Bool
    @State private var showingContext = false

    var body: some View {
        @Bindable var model = model
        VStack(spacing: 0) {
            if !commandSuggestions.isEmpty {
                commandPalette
                Divider()
            }
            composer(text: $model.composerText)
        }
        .background(Color(nsColor: .windowBackgroundColor))
    }

    private func composer(text: Binding<String>) -> some View {
        VStack(spacing: 0) {
            VStack(spacing: 8) {
                TextField(
                    "交给 D Code 一项工作，或输入 / 使用命令",
                    text: text,
                    axis: .vertical
                )
                .textFieldStyle(.plain)
                .font(.body)
                .lineLimit(3...7)
                .frame(minHeight: 66, maxHeight: 126, alignment: .topLeading)
                .focused($focused)
                .accessibilityLabel("消息输入")

                runtimeControls
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 16))
            .overlay {
                RoundedRectangle(cornerRadius: 16)
                    .strokeBorder(
                        focused ? Color.accentColor.opacity(0.58) : Color.primary.opacity(0.12),
                        lineWidth: focused ? 1.5 : 1
                    )
            }
            .shadow(color: .black.opacity(0.05), radius: 10, y: 4)
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
                    .frame(minHeight: PiDCodeMetrics.minimumTarget)
            }
            .buttonStyle(.borderless)
            .popover(isPresented: $showingContext, arrowEdge: .bottom) {
                contextPopover
            }
            .help("查看上下文占用")
            .accessibilityLabel("上下文占用：\(contextAccessibilityLabel)")

            Button {
                Task { await model.toggleFastMode() }
            } label: {
                Label(fastLabel, systemImage: "bolt.fill")
                    .foregroundStyle(fastColor)
                    .lineLimit(1)
                    .frame(minHeight: PiDCodeMetrics.minimumTarget)
            }
            .buttonStyle(.borderless)
            .accessibilityLabel(fastAccessibilityLabel)
            .help(fastHelp)

            Spacer(minLength: 4)

            modelAndThinkingMenu

            if model.isStreaming {
                Button {
                    Task { await model.abort() }
                } label: {
                    Image(systemName: "stop.fill")
                        .foregroundStyle(.white)
                        .frame(width: PiDCodeMetrics.minimumTarget, height: PiDCodeMetrics.minimumTarget)
                        .background(Color.red, in: Circle())
                }
                .buttonStyle(.plain)
                .help("停止当前运行")
                .accessibilityLabel("停止当前运行")
            } else {
                Button {
                    Task { await model.sendPrompt() }
                } label: {
                    Image(systemName: "arrow.up")
                        .font(.body.weight(.bold))
                        .foregroundStyle(.white)
                        .frame(width: PiDCodeMetrics.minimumTarget, height: PiDCodeMetrics.minimumTarget)
                        .background(sendEnabled ? Color.accentColor : Color.secondary.opacity(0.35), in: Circle())
                }
                .buttonStyle(.plain)
                .keyboardShortcut(.return, modifiers: .command)
                .disabled(!sendEnabled)
                .help("发送（⌘↩）")
                .accessibilityLabel("发送消息")
            }
        }
        .font(.caption)
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
                Image(systemName: "chevron.down")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            .frame(minHeight: PiDCodeMetrics.minimumTarget)
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
                    model.composerText = "/\(command.name) "
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
        !model.composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !model.isSendingRequest
            && !model.isStreaming
    }

    private var commandSuggestions: [CommandDescriptor] {
        guard model.canWrite, model.composerText.hasPrefix("/") else { return [] }
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
