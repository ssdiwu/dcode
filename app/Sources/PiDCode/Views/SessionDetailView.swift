import SwiftUI

enum SessionHeaderRunStatusPolicy {
    static func shouldShow(_ phase: SessionRunPhase) -> Bool {
        switch phase {
        case .waitingForUser, .stopRequested, .unknown:
            true
        case .running, .completed, .failed, .aborted:
            false
        }
    }
}

struct SessionDetailView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Group {
            if let inspection = model.inspection {
                VStack(spacing: 0) {
                    sessionHeader(inspection)
                    if let receipt = selfEvolutionReceipt(for: inspection.summary.id) {
                        selfEvolutionBanner(receipt)
                    }
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

    private func selfEvolutionReceipt(for sessionID: String) -> SelfEvolutionRunRecord? {
        guard let receipt = model.selfEvolution.latestReceipt,
              receipt.sessionID == sessionID,
              receipt.state == .sessionRestored || receipt.state == .recoveryRequired else { return nil }
        return receipt
    }

    private func selfEvolutionBanner(_ receipt: SelfEvolutionRunRecord) -> some View {
        HStack(spacing: 10) {
            Image(systemName: receipt.state == .recoveryRequired ? "exclamationmark.triangle.fill" : "arrow.triangle.2.circlepath")
                .foregroundStyle(receipt.state == .recoveryRequired ? Color.orange : Color.accentColor)
            Text(
                receipt.state == .recoveryRequired
                    ? "本次自进化需要处理"
                    : receipt.assurance == .legacyBootstrap
                        ? "0.0.27 已恢复本会话 · 引导回执不计入完整循环"
                        : "新构建已恢复本会话 · 等待人工验收"
            )
            .font(.caption)
            .lineLimit(1)
            Spacer()
            Button("查看回执") { model.presentSettings(.selfBuild) }
                .buttonStyle(.plain)
                .font(.caption.weight(.medium))
                .foregroundStyle(.tint)
        }
        .padding(.horizontal, 18)
        .frame(minHeight: 34)
        .background((receipt.state == .recoveryRequired ? Color.orange : Color.accentColor).opacity(0.08))
        .overlay(alignment: .bottom) { Divider() }
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
            if model.hostState?.isCompacting == true {
                StatusPill(label: "正在压缩上下文…", systemImage: "compress", color: .orange)
            }
            if let runState = model.activity.currentRunState,
               SessionHeaderRunStatusPolicy.shouldShow(runState.phase) {
                StatusPill(
                    label: headerStatusLabel(runState),
                    systemImage: headerStatusIcon(runState.phase),
                    color: runState.phase == .unknown ? .orange : .accentColor
                )
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
                Text("在侧栏继续既有会话、从用户首页创建会话，或在项目内开始新会话。")
            }
        }
    }

}
