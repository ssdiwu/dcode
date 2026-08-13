import SwiftUI

struct ArchivedSessionsSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("已归档会话")
                        .font(.title2.weight(.semibold))
                    Text("归档只影响 D Code 可见性；底层 Pi 会话始终保留。")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button("完成") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                    .frame(minHeight: PiDCodeMetrics.minimumTarget)
            }

            if let pending = model.pendingArchiveRetry {
                GroupBox("复制成功，归档未完成") {
                    HStack {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(pending.sourceTitle).font(.headline)
                            if let copiedToTitle = pending.copiedToTitle {
                                Text("目标副本：\(copiedToTitle)")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        Spacer()
                        Button("重试归档") { Task { await model.retryPendingArchive() } }
                            .frame(minHeight: PiDCodeMetrics.minimumTarget)
                            .disabled(model.isMutatingArchive || model.isPromptTransactionActive)
                            .accessibilityLabel("重试归档 \(pending.sourceTitle)")
                    }
                }
            }

            if model.archivedSessions.isEmpty {
                ContentUnavailableView("没有已归档会话", systemImage: "archivebox")
            } else {
                List(model.archivedSessions.sorted { $0.archivedAt > $1.archivedAt }) { record in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(record.sourceTitle)
                            .font(.headline)
                        Text(record.sourceCwd)
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                        if let archivedDate = record.archivedDate {
                            Text("归档于 \(archivedDate.formatted(date: .abbreviated, time: .shortened))")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        if let copiedToTitle = record.copiedToTitle,
                           let copiedToCwd = record.copiedToCwd {
                            Text("复制目标：\(copiedToTitle) · \(copiedToCwd)")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        } else {
                            Text("直接归档 · Pi 会话与草稿均保留")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        HStack {
                            Button("查看") { Task { await model.openArchivedSession(record) } }
                                .frame(minHeight: PiDCodeMetrics.minimumTarget)
                                .disabled(
                                    model.isMutatingArchive
                                        || model.isStreaming
                                        || model.isOpeningSession
                                        || model.isPromptTransactionActive
                                )
                                .accessibilityLabel("查看 \(record.sourceTitle)")
                            Button("恢复显示") { Task { await model.restoreArchivedSession(record) } }
                                .frame(minHeight: PiDCodeMetrics.minimumTarget)
                                .disabled(model.isMutatingArchive || model.isPromptTransactionActive)
                                .accessibilityLabel("恢复显示 \(record.sourceTitle)")
                        }
                    }
                    .padding(.vertical, 6)
                }
            }
        }
        .padding(20)
        .frame(minWidth: 680, minHeight: 480)
    }
}
