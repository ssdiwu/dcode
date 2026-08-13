import SwiftUI

struct ConversationRoundRail: View {
    let items: [ConversationNavigationItem]
    let currentID: String?
    let onNavigate: (ConversationNavigationItem) -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var hoveredIndex: Int?
    @State private var keyboardIndex: Int?
    @State private var previewHeight: CGFloat = 128
    @FocusState private var isFocused: Bool

    var body: some View {
        GeometryReader { proxy in
            let height = proxy.size.height
            ZStack(alignment: .topLeading) {
                Button(action: navigateSelectedItem) {
                    railCanvas(height: height)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .focused($isFocused)
                .onContinuousHover { phase in
                    switch phase {
                    case let .active(location):
                        hoveredIndex = ConversationNavigation.index(
                            at: location.y,
                            height: height,
                            count: items.count
                        )
                    case .ended:
                        hoveredIndex = nil
                    }
                }
                .onMoveCommand { direction in
                    switch direction {
                    case .up: moveSelection(by: -1)
                    case .down: moveSelection(by: 1)
                    default: break
                    }
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("对话导航")
                .accessibilityValue(accessibilityValue)
                .accessibilityHint("上下方向键选择轮次，按下空格或回车跳转")
                .accessibilityAdjustableAction { direction in
                    switch direction {
                    case .increment: moveSelection(by: 1)
                    case .decrement: moveSelection(by: -1)
                    @unknown default: break
                    }
                }
                .background(
                    isFocused ? Color.accentColor.opacity(0.10) : Color.clear,
                    in: RoundedRectangle(cornerRadius: 10, style: .continuous)
                )
                .overlay {
                    if isFocused {
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .strokeBorder(Color.accentColor.opacity(0.65), lineWidth: 2)
                    }
                }

                if let previewIndex, items.indices.contains(previewIndex) {
                    ConversationRoundPreviewCard(
                        item: items[previewIndex],
                        index: previewIndex,
                        count: items.count
                    )
                    .offset(
                        x: 52,
                        y: previewOffset(for: previewIndex, height: height)
                    )
                    .allowsHitTesting(false)
                    .background {
                        GeometryReader { previewProxy in
                            Color.clear.preference(
                                key: ConversationPreviewHeightPreferenceKey.self,
                                value: previewProxy.size.height
                            )
                        }
                    }
                    .transition(.opacity.combined(with: .scale(scale: 0.98, anchor: .leading)))
                    .zIndex(2)
                }
            }
            .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: previewIndex)
            .onPreferenceChange(ConversationPreviewHeightPreferenceKey.self) { height in
                if height > 0 { previewHeight = height }
            }
        }
        .frame(width: 44)
        .onChange(of: items.map(\.id)) { _, ids in
            if let keyboardIndex, !ids.indices.contains(keyboardIndex) {
                self.keyboardIndex = nil
            }
            hoveredIndex = nil
        }
    }

    private func railCanvas(height: CGFloat) -> some View {
        Canvas { context, size in
            var indices = Set(ConversationNavigation.renderedIndices(
                count: items.count,
                height: size.height
            ))
            if let hoveredIndex { indices.insert(hoveredIndex) }
            if let currentIndex { indices.insert(currentIndex) }

            for index in indices.sorted() where items.indices.contains(index) {
                let y = ConversationNavigation.yPosition(
                    for: index,
                    height: size.height,
                    count: items.count
                )
                let isHovered = index == hoveredIndex
                let isCurrent = index == currentIndex
                let length: CGFloat = isCurrent ? 28 : (isHovered ? 22 : 11)
                var path = Path()
                path.move(to: CGPoint(x: 4, y: y))
                path.addLine(to: CGPoint(x: 4 + length, y: y))
                let color: Color
                if items[index].hasError {
                    color = .orange
                } else if isCurrent || isHovered {
                    color = .primary
                } else {
                    color = .secondary.opacity(0.46)
                }
                context.stroke(
                    path,
                    with: .color(color),
                    style: StrokeStyle(
                        lineWidth: isCurrent ? 2.5 : 2,
                        lineCap: .round
                    )
                )
            }
        }
        .frame(width: 44, height: height)
    }

    private var currentIndex: Int? {
        if let currentID, let index = items.firstIndex(where: { $0.id == currentID }) {
            return index
        }
        return items.indices.last
    }

    private var previewIndex: Int? {
        hoveredIndex ?? (isFocused ? (keyboardIndex ?? currentIndex) : nil)
    }

    private var selectedIndex: Int? {
        previewIndex ?? currentIndex
    }

    private var accessibilityValue: String {
        guard let selectedIndex else { return "没有可导航的轮次" }
        return "第 \(selectedIndex + 1) 轮，共 \(items.count) 轮，\(items[selectedIndex].questionPreview)"
    }

    private func navigateSelectedItem() {
        guard let selectedIndex, items.indices.contains(selectedIndex) else { return }
        keyboardIndex = selectedIndex
        onNavigate(items[selectedIndex])
    }

    private func moveSelection(by offset: Int) {
        guard !items.isEmpty else { return }
        let base = keyboardIndex ?? currentIndex ?? 0
        let next = min(items.count - 1, max(0, base + offset))
        keyboardIndex = next
        onNavigate(items[next])
    }

    private func previewOffset(for index: Int, height: CGFloat) -> CGFloat {
        let center = ConversationNavigation.yPosition(for: index, height: height, count: items.count)
        return min(max(8, center - (previewHeight / 2)), max(8, height - previewHeight - 8))
    }
}

private struct ConversationPreviewHeightPreferenceKey: PreferenceKey {
    static let defaultValue: CGFloat = 128

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

private struct ConversationRoundPreviewCard: View {
    let item: ConversationNavigationItem
    let index: Int
    let count: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("第 \(index + 1) 轮 · 共 \(count) 轮")
                .font(.caption)
                .foregroundStyle(.tertiary)
            Text(item.questionPreview)
                .font(.callout.weight(.semibold))
                .foregroundStyle(.primary)
                .lineLimit(2)
            Text(item.answerPreview)
                .font(.callout)
                .foregroundStyle(item.hasError ? Color.orange : Color.secondary)
                .lineLimit(3)
        }
        .frame(width: 320, alignment: .leading)
        .padding(14)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(Color.primary.opacity(0.12), lineWidth: 1)
        }
        .shadow(color: .black.opacity(0.18), radius: 16, y: 7)
        .accessibilityHidden(true)
    }
}
