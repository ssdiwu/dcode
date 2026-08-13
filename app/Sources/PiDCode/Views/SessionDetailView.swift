import SwiftUI

struct SessionDetailView: View {
    @Environment(AppModel.self) private var model

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
                    ComposerView()
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
    }

    private func sessionHeader(_ inspection: SessionInspection) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .center, spacing: 12) {
                Text(inspection.summary.displayTitle)
                    .font(.headline)
                    .lineLimit(1)
                Spacer(minLength: 12)
                if let parentSessionID = inspection.parentSessionId {
                    Button {
                        Task { await model.openLineageSourceSession(parentSessionID) }
                    } label: {
                        Label(
                            model.archivedSessions.contains(where: { $0.sessionID == parentSessionID })
                                ? "在已归档会话中查看"
                                : "查看原会话",
                            systemImage: "arrow.up.left"
                        )
                        .frame(minHeight: PiDCodeMetrics.minimumTarget)
                    }
                    .buttonStyle(.borderless)
                    .disabled(model.isOpeningSession || model.isStreaming || model.isPromptTransactionActive)
                }
                Button {
                    model.pathSheetPresented = true
                } label: {
                    Label("会话谱系", systemImage: "arrow.triangle.branch")
                    .frame(minHeight: PiDCodeMetrics.minimumTarget)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("查看会话谱系")
                .disabled(model.isOpeningSession || model.isStreaming || model.isPromptTransactionActive)

                Menu {
                    Button(model.isSessionPinned(inspection.summary.id) ? "取消置顶" : "置顶") {
                        Task { await model.togglePinnedSession(inspection.summary) }
                    }
                    .disabled(!model.canToggleSessionPin(inspection.summary))
                    Button("归档会话") {
                        Task { await model.archiveSession(inspection.summary) }
                    }
                    .disabled(!model.canArchiveSession(inspection.summary))
                    Divider()
                    Button("复制到项目…") { model.copySheetMode = .copy }
                    Button("复制到项目并归档原会话…") { model.copySheetMode = .copyAndArchive }
                        .disabled(
                            model.pendingArchiveRetry != nil
                                || model.archivedSessions.contains(where: { $0.sessionID == model.selectedSessionID })
                        )
                    if model.canTrashSession(inspection.summary) {
                        Divider()
                        Button("移到废纸篓…", role: .destructive) {
                            model.requestTrashSession(inspection.summary)
                        }
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                        .frame(width: PiDCodeMetrics.minimumTarget, height: PiDCodeMetrics.minimumTarget)
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .accessibilityLabel("会话操作")
                .disabled(
                    model.isOpeningSession
                        || model.isStreaming
                        || model.isCopyingSession
                        || model.isTrashingSession
                        || model.isPromptTransactionActive
                )
                if model.isStreaming {
                    StatusPill(label: "运行中", systemImage: "waveform", color: .orange)
                }
            }
            Text(inspection.summary.cwd)
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
                .help(inspection.summary.cwd)
            if let path = model.selectedPath {
                Text(path.isCurrent ? "当前路径：\(path.title)" : "正在查看：\(path.title)")
                    .font(.caption2)
                    .foregroundStyle(path.isCurrent ? Color.secondary : Color.accentColor)
                    .lineLimit(1)
            }
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 6)
        .frame(minHeight: 58)
        .background(Color(nsColor: .windowBackgroundColor))
    }

    private var emptyDetail: some View {
        ContentUnavailableView {
            Label("选择一个 Pi 会话", systemImage: "sidebar.left")
        } description: {
            if model.connectionState == .failed {
                Text("Pi 运行服务未能启动。检查错误提示后重试。")
            } else {
                Text("在侧栏继续既有会话、从用户首页创建会话，或在项目内选择 Source Folder。")
            }
        }
    }

}
