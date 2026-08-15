import SwiftUI

struct ActivePlanView: View {
    let plan: ActivePlanPresentation?
    let changes: SessionChangeSummary?
    let isRunning: Bool
    @State private var presented = false

    var body: some View {
        HStack {
            Spacer(minLength: PiDCodeMetrics.spacingSection)
            Button {
                presented.toggle()
            } label: {
                HStack(spacing: PiDCodeMetrics.spacingStandard) {
                    if isRunning {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        Image(systemName: statusSymbol)
                            .foregroundStyle(.secondary)
                    }
                    if let plan, plan.totalCount > 0 {
                        Text("第 \(currentStepNumber(plan))/\(plan.totalCount) 步")
                            .monospacedDigit()
                    }
                    if plan?.totalCount ?? 0 > 0, changes != nil {
                        Text("·")
                            .foregroundStyle(.tertiary)
                    }
                    if let changes {
                        Text("\(changes.fileCount) 个文件")
                        Text("+\(changes.additions)")
                            .foregroundStyle(.green)
                            .monospacedDigit()
                        Text("-\(changes.deletions)")
                            .foregroundStyle(.red)
                            .monospacedDigit()
                    }
                    Image(systemName: "chevron.up.chevron.down")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.tertiary)
                }
                .font(.caption.weight(.medium))
                .padding(.horizontal, PiDCodeMetrics.spacingGroup)
                .frame(minHeight: PiDCodeMetrics.compactControlHeight)
                .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .background(.regularMaterial, in: Capsule())
            .overlay { Capsule().strokeBorder(Color.primary.opacity(0.1)) }
            .shadow(color: .black.opacity(0.08), radius: 8, y: 3)
            .popover(isPresented: $presented, arrowEdge: .bottom) {
                details
            }
            .dCodeAccessibleButton(accessibilityLabel)
            .accessibilityIdentifier("session-work-summary")
            .accessibilityHint("显示当前路径 Plan 和会话已确认变更")
            Spacer(minLength: PiDCodeMetrics.spacingSection)
        }
        .padding(.top, PiDCodeMetrics.spacingTight)
    }

    private var details: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: PiDCodeMetrics.spacingSection) {
                if let plan {
                    VStack(alignment: .leading, spacing: PiDCodeMetrics.spacingStandard) {
                        Text("当前路径 Plan")
                            .font(.headline)
                        Text(plan.objective)
                            .font(.callout.weight(.semibold))
                        Text("第 \(currentStepNumber(plan))/\(max(plan.totalCount, 1)) 步 · \(plan.currentLabel)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        if !plan.rootItems.isEmpty {
                            PlanItemGroup(title: nil, status: nil, items: plan.rootItems, currentItemID: plan.currentItem?.id)
                        }
                        ForEach(plan.phases) { phase in
                            PlanItemGroup(
                                title: phase.subject,
                                status: phase.status,
                                items: phase.items,
                                currentItemID: plan.currentItem?.id
                            )
                        }
                    }
                }
                if plan != nil, changes != nil { Divider() }
                if let changes {
                    VStack(alignment: .leading, spacing: PiDCodeMetrics.spacingStandard) {
                        HStack {
                            Text("会话已确认变更")
                                .font(.headline)
                            Spacer()
                            Text("\(changes.runCount) 个 Run")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Text("结构化工具已确认 · 覆盖可能不完整 · 不是 Git 净差异")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        ForEach(changes.files) { file in
                            SessionChangedFileRow(file: file)
                        }
                    }
                }
            }
            .padding(PiDCodeMetrics.spacingSection)
        }
        .frame(width: 430)
        .frame(maxHeight: 430)
    }

    private var accessibilityLabel: String {
        var parts: [String] = []
        if let plan, plan.totalCount > 0 {
            parts.append("当前路径 Plan 第 \(currentStepNumber(plan)) 步，共 \(plan.totalCount) 步")
        }
        if let changes {
            parts.append("会话已确认 \(changes.fileCount) 个文件，增加 \(changes.additions) 行，删除 \(changes.deletions) 行，覆盖可能不完整")
        }
        return parts.joined(separator: "；")
    }

    private var statusSymbol: String {
        guard let plan, plan.totalCount > 0 else { return "checkmark.circle" }
        return plan.completedCount == plan.totalCount ? "checkmark.circle" : "circle.dashed"
    }

    private func currentStepNumber(_ plan: ActivePlanPresentation) -> Int {
        guard plan.totalCount > 0 else { return 0 }
        if let currentID = plan.currentItem?.id,
           let index = plan.allItems.firstIndex(where: { $0.id == currentID }) {
            return index + 1
        }
        return min(plan.completedCount + 1, plan.totalCount)
    }
}

private struct SessionChangedFileRow: View {
    let file: SessionChangedFileSummary

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: PiDCodeMetrics.spacingStandard) {
            Image(systemName: "doc.text")
                .foregroundStyle(.secondary)
                .frame(width: PiDCodeMetrics.actionGlyphBox)
            VStack(alignment: .leading, spacing: 2) {
                Text(URL(fileURLWithPath: file.filePath).lastPathComponent)
                    .font(.callout.weight(.medium))
                Text(detail)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .help(file.filePath)
            }
            Spacer(minLength: PiDCodeMetrics.spacingStandard)
            Text("+\(file.additions)")
                .foregroundStyle(.green)
                .monospacedDigit()
            Text("-\(file.deletions)")
                .foregroundStyle(.red)
                .monospacedDigit()
        }
        .font(.caption)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(file.filePath)，增加 \(file.additions) 行，删除 \(file.deletions) 行，\(file.mutationCount) 次已确认变更")
    }

    private var detail: String {
        var parts = [file.filePath]
        if let line = file.firstChangedLine { parts.append("首个变更行 \(line)") }
        if file.mutationCount > 1 { parts.append("\(file.mutationCount) 次变更") }
        return parts.joined(separator: " · ")
    }
}

private struct PlanItemGroup: View {
    let title: String?
    let status: PlanItemStatus?
    let items: [PlanItemPresentation]
    let currentItemID: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            if let title {
                HStack(spacing: 7) {
                    Text(title)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    if let status {
                        Text(status.label)
                            .font(.caption2)
                            .foregroundStyle(statusColor(status))
                    }
                }
            }
            if items.isEmpty {
                Text("此阶段没有工作项")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            } else {
                ForEach(items) { item in
                    PlanItemRow(item: item, isCurrent: item.id == currentItemID)
                }
            }
        }
    }
}

private struct PlanItemRow: View {
    let item: PlanItemPresentation
    let isCurrent: Bool

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 9) {
            Image(systemName: statusIcon)
                .foregroundStyle(statusColor(item.status))
                .frame(width: 16)
            Text(item.subject)
                .font(.callout.weight(isCurrent ? .semibold : .regular))
                .foregroundStyle(item.status.isTerminal ? .secondary : .primary)
                .strikethrough(item.status == .abandoned, color: .secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
            if isCurrent {
                Text("当前")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(Color.accentColor)
            } else if item.status == .blocked {
                Text("阻塞")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.orange)
            }
        }
        .padding(.horizontal, 9)
        .frame(minHeight: PiDCodeMetrics.minimumTarget)
        .background(
            isCurrent ? Color.accentColor.opacity(0.08) : Color.clear,
            in: RoundedRectangle(cornerRadius: PiDCodeMetrics.compactRadius)
        )
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(item.subject)，\(item.status.label)\(isCurrent ? "，当前步骤" : "")")
    }

    private var statusIcon: String {
        switch item.status {
        case .done: "checkmark.circle.fill"
        case .inProgress, .active: "circle.inset.filled"
        case .blocked: "exclamationmark.circle.fill"
        case .paused: "pause.circle.fill"
        case .abandoned: "minus.circle"
        case .pending, .unknown: "circle"
        }
    }
}

private func statusColor(_ status: PlanItemStatus) -> Color {
    switch status {
    case .done: .green
    case .inProgress, .active: .accentColor
    case .blocked: .orange
    case .paused: .orange
    case .abandoned: .secondary
    case .pending, .unknown: .secondary
    }
}
