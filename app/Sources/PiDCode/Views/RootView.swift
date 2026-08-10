import AppKit
import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        @Bindable var model = model
        NavigationSplitView {
            sidebar
                .navigationSplitViewColumnWidth(min: 230, ideal: 285, max: 380)
        } detail: {
            SessionDetailView()
        }
        .searchable(text: $model.searchText, placement: .sidebar, prompt: "搜索标题、路径或 Session ID")
        .overlay(alignment: .top) {
            if let notice = model.notice {
                NoticeBanner(notice: notice)
                    .padding(.top, 8)
                    .transition(reduceMotion ? .opacity : .move(edge: .top).combined(with: .opacity))
            }
        }
        .animation(reduceMotion ? nil : .smooth, value: model.notice?.id)
        .alert(
            model.issue?.title ?? "",
            isPresented: Binding(
                get: { model.issue != nil },
                set: { if !$0 { model.issue = nil } }
            ),
            presenting: model.issue
        ) { _ in
            Button("好", role: .cancel) { model.issue = nil }
        } message: { issue in
            Text(issue.message)
        }
        .sheet(item: dialogBinding) { dialog in
            ExtensionDialogView(dialog: dialog)
                .interactiveDismissDisabled()
        }
    }

    private var sidebar: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Text("工作区")
                    .font(.headline)
                Spacer()
                Button(action: chooseDirectory) {
                    Label("新会话", systemImage: "plus")
                }
                .buttonStyle(.borderless)
                .frame(minHeight: PiDCodeMetrics.minimumTarget)
                .accessibilityLabel("新建会话")
                .accessibilityValue("选择工作目录并开始新会话")
                .disabled(model.connectionState != .ready || model.isOpeningSession || model.isStreaming)
                .help("选择工作目录并新建会话")
            }
            .padding(.horizontal, 12)
            .frame(minHeight: 44)

            Divider()

            if model.sessions.isEmpty, !model.isLoadingSessions {
                ContentUnavailableView(
                    "没有 Pi 会话",
                    systemImage: "bubble.left.and.bubble.right",
                    description: Text("选择一个工作目录，开始新的原生会话。")
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List(selection: selectionBinding) {
                    ForEach(model.filteredSessionGroups) { group in
                        Section {
                            ForEach(group.sessions) { session in
                                SessionRow(session: session)
                                    .tag(session.id)
                                    .help("\(session.cwd)\nSession ID: \(session.id)")
                            }
                        } header: {
                            WorkspaceHeader(group: group)
                        }
                    }
                }
                .listStyle(.sidebar)
                .disabled(model.isStreaming)
                .overlay {
                    if model.filteredSessions.isEmpty {
                        ContentUnavailableView.search(text: model.searchText)
                    }
                }
            }

            Divider()
            HStack(spacing: 8) {
                Circle()
                    .fill(connectionColor)
                    .frame(width: 8, height: 8)
                    .accessibilityHidden(true)
                Text(model.connectionState.label)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if !model.isLoadingSessions {
                    Text("· \(model.sessions.count) 个会话")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.tertiary)
                }
                Spacer()
                if model.isLoadingSessions {
                    ProgressView().controlSize(.small)
                } else {
                    Button {
                        Task { await model.reloadSessions() }
                    } label: {
                        Label("重新载入", systemImage: "arrow.clockwise")
                    }
                    .buttonStyle(.plain)
                    .font(.caption)
                    .frame(minHeight: PiDCodeMetrics.minimumTarget)
                    .accessibilityLabel("重新载入会话列表")
                    .accessibilityValue("重新扫描 Pi 会话")
                    .disabled(model.connectionState != .ready || model.isStreaming)
                    .help("重新载入 Pi 会话")
                }
            }
            .padding(.horizontal, 12)
            .frame(minHeight: 44)
        }
    }

    private var selectionBinding: Binding<String?> {
        Binding(
            get: { model.selectedSessionID },
            set: { id in
                guard !model.isStreaming else { return }
                Task { await model.selectSession(id) }
            }
        )
    }

    private var dialogBinding: Binding<ExtensionDialog?> {
        Binding(get: { model.activeDialog }, set: { _ in })
    }

    private var connectionColor: Color {
        switch model.connectionState {
        case .ready: .green
        case .connecting: .orange
        case .failed: .red
        case .idle: .secondary
        }
    }

    private func chooseDirectory() {
        let panel = NSOpenPanel()
        panel.title = "选择新会话的工作目录"
        panel.prompt = "开始会话"
        panel.message = "D Code 会让 Pi Host 在此目录中工作。"
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        panel.begin { response in
            guard response == .OK, let url = panel.url else { return }
            Task { await model.createSession(at: url) }
        }
    }
}

private struct WorkspaceHeader: View {
    let group: SessionWorkspaceGroup

    var body: some View {
        HStack(alignment: .center, spacing: 7) {
            Image(systemName: "folder")
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 1) {
                Text(group.displayName)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                Text(group.cwd)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer(minLength: 4)
            Text("\(group.sessions.count)")
                .font(.caption2.monospacedDigit())
                .foregroundStyle(.tertiary)
        }
        .padding(.top, 6)
        .padding(.bottom, 2)
        .textCase(nil)
        .help(group.cwd)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("工作区 \(group.displayName)，\(group.sessions.count) 个会话")
    }
}

private struct SessionRow: View {
    let session: SessionSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(session.displayTitle)
                .font(.body.weight(.medium))
                .lineLimit(1)
            HStack(spacing: 6) {
                Text("\(session.messageCount) 条")
                    .monospacedDigit()
                Spacer(minLength: 4)
                if let date = session.modifiedDate {
                    Text(date.piDCodeRelativeLabel)
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(session.displayTitle)，\(session.messageCount) 条消息")
    }
}

private struct NoticeBanner: View {
    let notice: ExtensionNotice
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    var body: some View {
        Label(notice.message, systemImage: icon)
            .font(.callout)
            .foregroundStyle(foreground)
            .padding(.horizontal, 14)
            .padding(.vertical, 9)
            .background(
                reduceTransparency
                    ? AnyShapeStyle(Color(nsColor: .controlBackgroundColor))
                    : AnyShapeStyle(.regularMaterial),
                in: RoundedRectangle(cornerRadius: PiDCodeMetrics.controlRadius)
            )
            .overlay {
                RoundedRectangle(cornerRadius: PiDCodeMetrics.controlRadius)
                    .strokeBorder(foreground.opacity(0.18))
            }
            .shadow(color: .black.opacity(0.1), radius: 12, y: 5)
            .padding(.horizontal)
            .accessibilityAddTraits(.isStaticText)
    }

    private var icon: String {
        switch notice.level {
        case "error": "exclamationmark.triangle.fill"
        case "warning": "exclamationmark.circle.fill"
        default: "info.circle.fill"
        }
    }

    private var foreground: Color {
        switch notice.level {
        case "error": .red
        case "warning": .orange
        default: .accentColor
        }
    }
}
