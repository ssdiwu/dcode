import SwiftUI

struct ArchivedSessionsView: View {
    @Environment(AppModel.self) private var model

    private var sortedRecords: [ArchivedSessionRecord] {
        model.archivedSessions.sorted { $0.archivedAt > $1.archivedAt }
    }

    var body: some View {
        VStack(spacing: 0) {
            pageHeader

            if sortedRecords.isEmpty, model.pendingArchiveRetry == nil {
                ContentUnavailableView(
                    "没有已归档会话",
                    systemImage: "archivebox",
                    description: Text("归档后的会话会显示在这里，并可随时恢复到普通导航。")
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                archiveList
            }
        }
    }

    private var pageHeader: some View {
        HStack(alignment: .firstTextBaseline, spacing: PiDCodeMetrics.spacingSection) {
            VStack(alignment: .leading, spacing: PiDCodeMetrics.spacingTight) {
                Text("已归档会话")
                    .font(.largeTitle.weight(.semibold))
                Text("归档只影响 D Code 可见性；底层 Pi 会话与逐路径草稿仍会保留。")
                    .font(.body)
                    .foregroundStyle(.secondary)
            }

            Spacer(minLength: 0)

            Text("\(sortedRecords.count)")
                .font(.callout.monospacedDigit())
                .foregroundStyle(.secondary)
                .accessibilityLabel("共 \(sortedRecords.count) 个已归档会话")
        }
        .padding(.horizontal, 48)
        .padding(.top, 44)
        .padding(.bottom, 24)
        .frame(maxWidth: 900)
        .frame(maxWidth: .infinity, alignment: .top)
    }

    private var archiveList: some View {
        List {
            if let pending = model.pendingArchiveRetry {
                PendingArchiveRow(record: pending)
            }

            ForEach(sortedRecords) { record in
                ArchivedSessionRow(record: record)
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .frame(maxWidth: 900)
        .frame(maxWidth: .infinity)
        .accessibilityLabel("已归档会话列表")
    }
}

private struct PendingArchiveRow: View {
    @Environment(AppModel.self) private var model
    let record: ArchivedSessionRecord

    var body: some View {
        HStack(spacing: PiDCodeMetrics.spacingGroup) {
            Image(systemName: "exclamationmark.arrow.triangle.2.circlepath")
                .foregroundStyle(.orange)
                .frame(width: PiDCodeMetrics.actionGlyphBox)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: PiDCodeMetrics.spacingTight) {
                Text(record.sourceTitle)
                    .font(.headline)
                    .lineLimit(1)
                Text(pendingDescription)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }

            Spacer(minLength: PiDCodeMetrics.spacingStandard)

            Button("重试归档") {
                Task { await model.retryPendingArchive() }
            }
            .frame(minHeight: PiDCodeMetrics.compactControlHeight)
            .disabled(model.isMutatingArchive || model.isPromptTransactionActive)
            .accessibilityLabel("重试归档 \(record.sourceTitle)")
        }
        .frame(minHeight: 52)
        .listRowInsets(EdgeInsets(top: 4, leading: 24, bottom: 4, trailing: 24))
        .listRowBackground(Color.clear)
        .accessibilityElement(children: .contain)
    }

    private var pendingDescription: String {
        if let copiedToTitle = record.copiedToTitle {
            return "复制已完成 · 目标副本：\(copiedToTitle) · 原会话尚未归档"
        }
        return "归档尚未完成，可安全重试"
    }
}

private struct ArchivedSessionRow: View {
    @Environment(AppModel.self) private var model
    let record: ArchivedSessionRecord

    private var navigationDisabled: Bool {
        model.isMutatingArchive
            || model.isStreaming
            || model.isOpeningSession
            || model.isPromptTransactionActive
    }

    var body: some View {
        HStack(spacing: PiDCodeMetrics.spacingStandard) {
            Button {
                Task { await model.openArchivedSession(record) }
            } label: {
                HStack(spacing: PiDCodeMetrics.spacingGroup) {
                    Image(systemName: "archivebox")
                        .foregroundStyle(.secondary)
                        .frame(width: PiDCodeMetrics.actionGlyphBox)
                        .accessibilityHidden(true)

                    VStack(alignment: .leading, spacing: PiDCodeMetrics.spacingTight) {
                        Text(record.sourceTitle)
                            .font(.headline)
                            .lineLimit(1)
                        Text(metadata)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }

                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
                .frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
            }
            .buttonStyle(.plain)
            .disabled(navigationDisabled)
            .accessibilityLabel("查看 \(record.sourceTitle)")
            .accessibilityHint(metadata)

            Button("恢复显示") {
                Task { await model.restoreArchivedSession(record) }
            }
            .frame(minHeight: PiDCodeMetrics.compactControlHeight)
            .disabled(model.isMutatingArchive || model.isPromptTransactionActive)
            .accessibilityLabel("恢复显示 \(record.sourceTitle)")
        }
        .listRowInsets(EdgeInsets(top: 2, leading: 24, bottom: 2, trailing: 24))
        .listRowBackground(Color.clear)
        .accessibilityElement(children: .contain)
    }

    private var metadata: String {
        var parts = [record.sourceCwd]
        if let archivedDate = record.archivedDate {
            parts.append("归档于 \(archivedDate.formatted(date: .abbreviated, time: .shortened))")
        }
        if let copiedToTitle = record.copiedToTitle,
           let copiedToCwd = record.copiedToCwd {
            parts.append("副本：\(copiedToTitle) · \(copiedToCwd)")
        } else {
            parts.append("直接归档")
        }
        return parts.joined(separator: " · ")
    }
}
