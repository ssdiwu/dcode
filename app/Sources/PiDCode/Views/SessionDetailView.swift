import SwiftUI

struct SessionDetailView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Group {
            if let inspection = model.inspection {
                VStack(spacing: 0) {
                    sessionHeader(inspection)
                    ConversationView()
                    if model.activePlan != nil || model.sessionChangeSummary != nil {
                        ActivePlanView(
                            plan: model.activePlan,
                            changes: model.sessionChangeSummary,
                            isRunning: model.isStreaming
                        )
                    }
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
        HStack(spacing: 10) {
            Text(inspection.summary.cwd)
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
                .help(inspection.summary.cwd)
            if let path = model.selectedPath {
                Text(path.isCurrent ? "路径：\(path.title)" : "正在查看：\(path.title)")
                    .font(.caption2)
                    .foregroundStyle(path.isCurrent ? Color.secondary : Color.accentColor)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            if model.isStreaming {
                StatusPill(label: "运行中", systemImage: "waveform", color: .orange)
            }
        }
        .padding(.horizontal, 18)
        .frame(minHeight: PiDCodeMetrics.minimumTarget)
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
