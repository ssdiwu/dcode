import SwiftUI

struct ActivePlanView: View {
    let plan: ActivePlanPresentation
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var expanded = false

    var body: some View {
        VStack(spacing: 0) {
            Button(action: toggleExpanded) {
                HStack(spacing: 10) {
                    Image(systemName: "checklist")
                        .foregroundStyle(Color.accentColor)
                        .frame(width: 24)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(plan.objective)
                            .font(.callout.weight(.semibold))
                            .foregroundStyle(.primary)
                            .lineLimit(1)
                        Text(plan.currentLabel)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 12)
                    if plan.totalCount > 0 {
                        ProgressView(value: plan.progress)
                            .progressViewStyle(.linear)
                            .frame(width: 88)
                            .accessibilityLabel("Plan 进度")
                            .accessibilityValue("\(plan.completedCount) / \(plan.totalCount)")
                        Text("\(plan.completedCount)/\(plan.totalCount)")
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(.secondary)
                    }
                    Image(systemName: "chevron.down")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .rotationEffect(.degrees(expanded ? 180 : 0))
                }
                .accessibilityElement(children: .ignore)
                .padding(.horizontal, 18)
                .frame(minHeight: 52)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("活动 Plan：\(plan.objective)")
            .accessibilityValue("当前步骤 \(plan.currentLabel)，\(plan.completedCount) / \(plan.totalCount)")
            .accessibilityHint(expanded ? "收起 Plan" : "展开 Plan")

            if expanded {
                Divider()
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 14) {
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
                    .padding(.horizontal, 18)
                    .padding(.vertical, 14)
                }
                .frame(maxHeight: 270)
            }
        }
        .background(Color(nsColor: .controlBackgroundColor))
        .overlay(alignment: .top) { Divider() }
    }

    private func toggleExpanded() {
        if reduceMotion {
            expanded.toggle()
        } else {
            withAnimation(.smooth(duration: 0.2)) { expanded.toggle() }
        }
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
