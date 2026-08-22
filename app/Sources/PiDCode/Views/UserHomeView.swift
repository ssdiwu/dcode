import SwiftUI

/// 主页（0.0.14）：落地即可打字的会话前草稿。
/// 无会话打开时自动恢复或创建新会话草稿，与 Composer 共用同一组件；
/// 输入框保持画布几何中心，最近会话挂在其下方、不参与居中计算。
/// 不做问候语与建议 prompt。
struct HomeWorkspaceView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    let selectSession: (String) -> Void
    let newProject: () -> Void

    /// 最近会话块的实际高度：用于顶部补偿，让 Composer 在有/无最近会话时
    /// 都处于同一几何中心，而不是整组居中把输入框顶到中心线上方。
    @State private var recentsBlockHeight: CGFloat = 0

    var body: some View {
        VStack(spacing: 0) {
            Spacer(minLength: 0)
            Color.clear.frame(
                height: recentsBlockHeight > 0 ? recentsSpacing + recentsBlockHeight : 0
            )
            VStack(spacing: recentsSpacing) {
                if model.canUseHostSessions {
                    ComposerView()
                        .frame(maxWidth: 640)
                        .transition(reduceMotion ? .opacity : .opacity.combined(with: .scale(scale: 0.98)))
                } else {
                    connectionNotice
                }
                recentSessions
            }
            .frame(maxWidth: .infinity)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, PiDCodeMetrics.spacingSection)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .task(id: homeReadinessKey) {
            await model.ensureHomeDraft()
        }
        .onPreferenceChange(HomeRecentsHeightPreferenceKey.self) { recentsBlockHeight = $0 }
        .animation(reduceMotion ? nil : .smooth(duration: 0.2), value: model.canUseHostSessions)
    }

    private var recentsSpacing: CGFloat {
        PiDCodeMetrics.spacingSection + 10
    }

    /// key 不得包含 isNewSessionDraftActive：草稿激活正是本任务自身的工作结果，
    /// 若纳入 key，SwiftUI 会在任务中途取消它，把进行中的 session.getModels
    /// 掐成 CancellationError（0.0.14 实机回归）。
    private var homeReadinessKey: String {
        "\(model.connectionState)-\(model.workbenchDestination)"
    }

    private var connectionNotice: some View {
        VStack(spacing: PiDCodeMetrics.spacingGroup) {
            if model.connectionState == .failed {
                ContentUnavailableView(
                    "Pi 运行服务未能启动",
                    systemImage: "exclamationmark.triangle",
                    description: Text("当前运行已标记为结果未知；重新连接后可继续，无需重启应用。")
                )
                Button("重新连接 Pi Host") {
                    Task { await model.restartHost() }
                }
                .buttonStyle(.borderedProminent)
            } else {
                ProgressView("正在连接 Pi 运行服务…")
                    .controlSize(.large)
            }
        }
        .frame(maxWidth: 640)
    }

    @ViewBuilder
    private var recentSessions: some View {
        let sessions = Array(model.recentSessions.prefix(3))
        if !sessions.isEmpty {
            VStack(alignment: .leading, spacing: PiDCodeMetrics.spacingTight) {
                Text("最近会话")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, PiDCodeMetrics.spacingStandard)
                VStack(spacing: 2) {
                    ForEach(sessions) { session in
                        HomeRecentSessionRow(session: session) {
                            selectSession(session.id)
                        }
                    }
                }
                .frame(maxWidth: 640)
            }
            .frame(maxWidth: .infinity)
            .background(
                GeometryReader { proxy in
                    Color.clear.preference(
                        key: HomeRecentsHeightPreferenceKey.self,
                        value: proxy.size.height
                    )
                }
            )
        }
    }
}

private struct HomeRecentsHeightPreferenceKey: PreferenceKey {
    static let defaultValue: CGFloat = 0

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

private struct HomeRecentSessionRow: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    let session: SessionSummary
    let open: () -> Void

    @State private var hovering = false

    var body: some View {
        Button(action: open) {
            HStack(spacing: PiDCodeMetrics.spacingGroup) {
                Image(systemName: "clock")
                    .font(.system(size: PiDCodeMetrics.actionGlyphPointSize))
                    .foregroundStyle(.secondary)
                    .frame(width: PiDCodeMetrics.actionGlyphBox)
                    .accessibilityHidden(true)
                Text(session.displayTitle)
                    .font(.body)
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: PiDCodeMetrics.spacingGroup)
                if let modified = session.modifiedDate {
                    Text(modified.piDCodeRelativeLabel)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                }
            }
            .padding(.horizontal, PiDCodeMetrics.spacingStandard)
            .frame(minHeight: PiDCodeMetrics.navigationRowHeight)
            .frame(maxWidth: 640)
            .contentShape(RoundedRectangle(cornerRadius: PiDCodeMetrics.compactRadius, style: .continuous))
            .background(
                model.selectedSessionID == session.id || hovering
                    ? Color.primary.opacity(0.05)
                    : Color.clear,
                in: RoundedRectangle(cornerRadius: PiDCodeMetrics.compactRadius, style: .continuous)
            )
        }
        .buttonStyle(.plain)
        .dCodeAccessibleButton("继续会话 \(session.displayTitle)")
        .help("\(session.displayTitle)\n\(session.cwd)")
        .disabled(model.isOpeningSession || model.isPromptTransactionActive)
        .onHover { next in
            hovering = next
        }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: hovering)
    }
}
