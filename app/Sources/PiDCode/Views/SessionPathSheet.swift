import SwiftUI

struct SessionPathSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("会话谱系")
                        .font(.title2.weight(.semibold))
                    Text("切换路径只改变对话历史和模型上下文，不改变文件、Git 或工作树。")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button("完成") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                    .frame(minHeight: PiDCodeMetrics.compactControlHeight)
            }

            if let paths = model.inspection?.paths, !paths.isEmpty {
                List(paths) { path in
                    Button {
                        Task {
                            await model.selectPath(path)
                            if model.inspection?.selectedPathId == path.id { dismiss() }
                        }
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: path.isCurrent ? "point.topleft.down.to.point.bottomright.curvepath" : "arrow.triangle.branch")
                                .foregroundStyle(path.isCurrent ? Color.accentColor : Color.secondary)
                            VStack(alignment: .leading, spacing: 4) {
                                HStack {
                                    Text(path.title).lineLimit(1)
                                    if path.isCurrent { Text("当前").font(.caption.weight(.semibold)).foregroundStyle(Color.accentColor) }
                                    if path.isSelected, !path.isCurrent { Text("正在查看").font(.caption.weight(.semibold)).foregroundStyle(.orange) }
                                }
                                Text("\(path.entryCount) 条持久化记录 · \(path.updated)")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                                if let branchFromPreview = path.branchFromPreview {
                                    Text("从“\(branchFromPreview)”分叉")
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(1)
                                }
                            }
                            Spacer()
                            if path.isSelected { Image(systemName: "checkmark") }
                        }
                        .frame(minHeight: PiDCodeMetrics.minimumTarget)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(
                        model.isOpeningSession
                            || model.isStreaming
                            || model.isSendingRequest
                            || model.pendingPrompt != nil
                            || path.isSelected
                    )
                    .accessibilityLabel(accessibilityDescription(for: path))
                }
            } else {
                ContentUnavailableView("没有可用路径", systemImage: "arrow.triangle.branch")
            }
        }
        .padding(20)
        .frame(minWidth: 620, minHeight: 440)
    }

    private func accessibilityDescription(for path: SessionPathSummary) -> String {
        var parts = [path.title, "\(path.entryCount) 条持久化记录", path.updated]
        if path.isCurrent { parts.append("当前路径") }
        if path.isSelected { parts.append("正在查看") }
        if let branchFromPreview = path.branchFromPreview {
            parts.append("从 \(branchFromPreview) 分叉")
        }
        return parts.joined(separator: "，")
    }
}
