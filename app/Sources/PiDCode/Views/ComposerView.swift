import SwiftUI

struct ComposerView: View {
    @Environment(AppModel.self) private var model
    @FocusState private var focused: Bool
    let showTakeover: () -> Void

    var body: some View {
        @Bindable var model = model
        VStack(spacing: 0) {
            if !commandSuggestions.isEmpty {
                commandPalette
                Divider()
            }
            if model.canWrite {
                writableComposer(text: $model.composerText)
            } else {
                readOnlyBar
            }
        }
        .background(Color(nsColor: .windowBackgroundColor))
    }

    private func writableComposer(text: Binding<String>) -> some View {
        VStack(spacing: 8) {
            HStack(alignment: .bottom, spacing: 10) {
                ZStack(alignment: .topLeading) {
                    if text.wrappedValue.isEmpty {
                        Text("交给 Pi 一项工作，或输入 / 使用命令")
                            .foregroundStyle(.tertiary)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 9)
                            .allowsHitTesting(false)
                    }
                    TextEditor(text: text)
                        .font(.body)
                        .scrollContentBackground(.hidden)
                        .padding(.horizontal, 3)
                        .frame(minHeight: 62, maxHeight: 116)
                        .focused($focused)
                        .accessibilityLabel("消息输入")
                }
                .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: PiDCodeMetrics.controlRadius))
                .overlay {
                    RoundedRectangle(cornerRadius: PiDCodeMetrics.controlRadius)
                        .strokeBorder(focused ? Color.accentColor.opacity(0.65) : Color.primary.opacity(0.12), lineWidth: focused ? 1.5 : 1)
                }

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
            HStack(spacing: 8) {
                Text("⌘↩ 发送 · ↩ 换行")
                if let pending = model.hostState?.pendingMessageCount, pending > 0 {
                    Text("·")
                    Text("队列 \(pending)").monospacedDigit()
                }
                Spacer()
                if !model.extensionStatuses.isEmpty {
                    Menu {
                        ForEach(model.extensionStatuses.sorted(by: { $0.key < $1.key }), id: \.key) { key, value in
                            Text("\(key): \(value)")
                        }
                    } label: {
                        Label("扩展状态", systemImage: "waveform.path.ecg")
                    }
                    .menuStyle(.borderlessButton)
                    .fixedSize()
                    .help("查看扩展状态")
                }
                if let working = model.workingMessage, !working.isEmpty {
                    Label(working, systemImage: "ellipsis")
                        .lineLimit(1)
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    private var readOnlyBar: some View {
        HStack(spacing: 12) {
            Image(systemName: "lock.open.display")
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text("当前以只读方式打开")
                    .font(.callout.weight(.medium))
                Text("停止在其他客户端中使用此会话后，可直接继续。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button("继续会话…", action: showTakeover)
                .accessibilityLabel("继续当前会话")
                .accessibilityValue("在确认其他客户端已停止后继续")
        }
        .padding(.horizontal, 18)
        .frame(minHeight: 66)
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
}
