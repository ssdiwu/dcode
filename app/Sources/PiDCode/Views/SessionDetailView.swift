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
            if model.isStreaming {
                StatusPill(label: "运行中", systemImage: "waveform", color: .orange)
            }
        }
        .padding(.horizontal, 18)
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
                Text("在侧栏继续既有会话，或选择工作目录创建新会话。")
            }
        }
    }

}
