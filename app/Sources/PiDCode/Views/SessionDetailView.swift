import SwiftUI

struct SessionDetailView: View {
    @Environment(AppModel.self) private var model
    @State private var showingTakeover = false

    var body: some View {
        Group {
            if let inspection = model.inspection {
                VStack(spacing: 0) {
                    sessionHeader(inspection)
                    Divider()
                    ConversationView()
                    if let plan = model.activePlan {
                        ActivePlanView(plan: plan)
                            .id(plan.id)
                    }
                    Divider()
                    ComposerView(showTakeover: presentTakeover)
                }
            } else {
                emptyDetail
            }
        }
        .overlay {
            if model.isOpeningSession {
                ZStack {
                    Color(nsColor: .windowBackgroundColor).opacity(0.72)
                    ProgressView("正在打开会话…")
                        .controlSize(.large)
                }
                .accessibilityLabel("正在打开会话")
            }
        }
        .sheet(isPresented: $showingTakeover) {
            takeoverSheet
        }
    }

    private func sessionHeader(_ inspection: SessionInspection) -> some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(inspection.summary.displayTitle)
                    .font(.headline)
                    .lineLimit(1)
                Text(inspection.summary.cwd)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .help(inspection.summary.cwd)
            }
            Spacer(minLength: 12)
            if model.canWrite {
                modelMenu
                thinkingMenu
                StatusPill(
                    label: model.isStreaming ? "运行中" : "可写",
                    systemImage: model.isStreaming ? "waveform" : "checkmark.circle.fill",
                    color: model.isStreaming ? .orange : .green
                )
            } else {
                StatusPill(label: "只读", systemImage: "eye", color: .secondary)
                Button("继续…", action: presentTakeover)
                    .accessibilityLabel("继续当前会话")
                    .accessibilityValue("在确认其他客户端已停止后继续")
                    .controlSize(.regular)
                    .disabled(model.isStreaming)
            }
        }
        .padding(.horizontal, 18)
        .frame(minHeight: 58)
        .background(Color(nsColor: .windowBackgroundColor))
    }

    private var modelMenu: some View {
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
        } label: {
            Label(model.hostState?.model?.displayName ?? "模型", systemImage: "cpu")
                .lineLimit(1)
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .help("切换当前 Pi 模型")
    }

    private var thinkingMenu: some View {
        Menu {
            ForEach(model.availableThinkingLevels, id: \.self) { level in
                Button {
                    Task { await model.setThinkingLevel(level) }
                } label: {
                    if level == model.hostState?.thinkingLevel {
                        Label(level, systemImage: "checkmark")
                    } else {
                        Text(level)
                    }
                }
            }
        } label: {
            Label(model.hostState?.thinkingLevel ?? "Thinking", systemImage: "brain")
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .help("切换 Thinking level")
    }

    private var emptyDetail: some View {
        ContentUnavailableView {
            Label("选择一个 Pi 会话", systemImage: "sidebar.left")
        } description: {
            if model.connectionState == .failed {
                Text("Pi Host 未能启动。检查错误提示后重试。")
            } else {
                Text("在侧栏继续既有会话，或选择工作目录创建新会话。")
            }
        }
    }

    private func presentTakeover() {
        showingTakeover = true
    }

    private var takeoverSheet: some View {
        VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 6) {
                Text("继续此会话")
                    .font(.title2.weight(.semibold))
                Text("D Code 将直接取得这个会话的写入权，不需要插件或交接 ID。")
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Label("继续前，请确认其他 Pi 客户端已经关闭，或不再使用这个会话。", systemImage: "person.2.slash")
                .fixedSize(horizontal: false, vertical: true)
            Label("Host 会检查会话静默状态并取得租约；如果之后检测到外部写入，会立即停止而不是静默覆盖。", systemImage: "shield.checkered")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if let id = model.selectedSessionID {
                LabeledContent("Session ID") {
                    Text(id).font(.caption.monospaced()).textSelection(.enabled)
                }
            }
            HStack {
                Button("取消", role: .cancel) {
                    showingTakeover = false
                }
                .accessibilityLabel("取消继续会话")
                .accessibilityValue("取消继续会话")
                Spacer()
                Button("已停止其他客户端，继续") {
                    showingTakeover = false
                    Task { await model.takeOverCurrentSession() }
                }
                .keyboardShortcut(.defaultAction)
                .accessibilityLabel("确认独占并继续会话")
                .accessibilityValue("确认独占并继续会话")
            }
        }
        .padding(24)
        .frame(width: 500)
    }
}
