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
            } else if let directoryPath = model.newSessionDraftDirectoryPath {
                VStack(spacing: 0) {
                    newSessionHeader(directoryPath)
                    ConversationView()
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

    private func newSessionHeader(_ directoryPath: String) -> some View {
        HStack(spacing: 10) {
            Text(directoryPath)
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
                .help(directoryPath)
            Spacer(minLength: 8)
            Text("尚未创建 Pi 会话")
                .font(.caption2)
                .foregroundStyle(.secondary)
            Button("取消") { model.discardNewSessionDraft() }
                .buttonStyle(.borderless)
                .disabled(model.isCreatingSession || model.isSendingRequest)
                .help("丢弃这个本地新会话草稿")
        }
        .padding(.horizontal, 18)
        .frame(minHeight: PiDCodeMetrics.minimumTarget)
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
            if let runState = model.activity.currentRunState,
               runState.phase.isActive || runState.phase == .unknown {
                StatusPill(
                    label: headerStatusLabel(runState),
                    systemImage: headerStatusIcon(runState.phase),
                    color: runState.phase == .unknown ? .orange : .accentColor
                )
            } else if model.isStreaming {
                StatusPill(label: "运行中", systemImage: "waveform", color: .orange)
            }
        }
        .padding(.horizontal, 18)
        .frame(minHeight: PiDCodeMetrics.minimumTarget)
    }

    private func headerStatusLabel(_ state: SessionRunState) -> String {
        switch state.phase {
        case .running: "运行中"
        case .waitingForUser: state.waitingFor?.label ?? "等待处理"
        case .stopRequested: "正在停止"
        case .unknown: "结果未知"
        case .completed: "已完成"
        case .failed: "失败"
        case .aborted: "已中止"
        }
    }

    private func headerStatusIcon(_ phase: SessionRunPhase) -> String {
        switch phase {
        case .running: "waveform"
        case .waitingForUser: "person.crop.circle.badge.exclamationmark"
        case .stopRequested: "stop.circle"
        case .unknown: "questionmark.circle"
        case .completed: "checkmark.circle"
        case .failed: "exclamationmark.triangle"
        case .aborted: "xmark.circle"
        }
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
