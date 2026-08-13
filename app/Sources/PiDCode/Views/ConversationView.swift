import AppKit
import Foundation
import SwiftUI

struct ConversationView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var highlightedEntryID: String?
    @State private var highlightedRoundID: String?
    @State private var expandedRoundIDs: Set<String> = []
    @State private var selectedNavigationRoundID: String?
    @State private var followsLatest = true
    @State private var navigationHighlightToken = UUID()
    private let bottomID = "conversation-bottom"

    var body: some View {
        let rounds = model.conversationRounds
        let navigationItems = model.conversationNavigationItems
        let presentationIdentity = ConversationNavigation.presentationIdentity(
            sessionID: model.selectedSessionID,
            pathID: model.inspection?.selectedPathId
        )
        GeometryReader { geometry in
            let showsPersistentRail = ConversationNavigation.shouldShowPersistentRail(
                width: geometry.size.width,
                roundCount: rounds.count
            )
            ScrollViewReader { proxy in
                ZStack(alignment: .leading) {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 18) {
                            if model.transcript.isEmpty, model.optimisticUserMessage == nil, !model.isStreaming {
                                ContentUnavailableView(
                                    "空会话",
                                    systemImage: "text.bubble",
                                    description: Text("在下方输入第一条消息。")
                                )
                                .frame(maxWidth: .infinity)
                                .padding(.top, 80)
                            }
                            ForEach(rounds) { round in
                                ConversationRoundView(
                                    round: round,
                                    expanded: expansionBinding(for: round.id),
                                    highlightedEntryID: highlightedEntryID,
                                    highlighted: highlightedRoundID == round.id,
                                    pathActionDisabled: pathActionDisabled,
                                    pathAction: model.beginPathDraft
                                )
                                .id(ConversationNavigation.anchorID(for: round.id))
                            }
                            if let message = model.optimisticUserMessage {
                                MessageRow(item: TranscriptItem(
                                    id: "optimistic-user",
                                    role: .user,
                                    timestamp: Date(),
                                    blocks: [.text(id: "optimistic-user-text", value: message)]
                                ))
                                .opacity(0.78)
                            }
                            if model.isStreaming || !model.streamingText.isEmpty || !model.streamingThinking.isEmpty {
                                StreamingResponseView()
                            }
                            Color.clear.frame(height: 1).id(bottomID)
                        }
                        .frame(maxWidth: PiDCodeMetrics.contentMaxWidth)
                        .padding(.leading, showsPersistentRail ? 72 : 28)
                        .padding(.trailing, 28)
                        .padding(.vertical, 24)
                        .frame(maxWidth: .infinity)
                    }
                    .id(presentationIdentity)

                    if showsPersistentRail {
                        ConversationRoundRail(
                            items: navigationItems,
                            currentID: selectedNavigationRoundID ?? rounds.last?.id,
                            onNavigate: { navigate(to: $0, using: proxy) }
                        )
                        .id(presentationIdentity)
                        .padding(.leading, 4)
                        .padding(.vertical, 20)
                        .zIndex(2)
                    }

                    if !followsLatest {
                        Button {
                            returnToLatest(using: proxy)
                        } label: {
                            Label("回到最新", systemImage: "arrow.down.to.line")
                                .frame(minHeight: PiDCodeMetrics.minimumTarget)
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .help("恢复自动跟随最新回复")
                        .accessibilityHint("跳到会话末尾，并在新回复出现时继续自动跟随")
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
                        .padding(16)
                        .zIndex(3)
                    }
                }
                .onChange(of: presentationIdentity) { _, _ in
                    followsLatest = true
                    selectedNavigationRoundID = nil
                    highlightedRoundID = nil
                    highlightedEntryID = nil
                    expandedRoundIDs.removeAll()
                    navigationHighlightToken = UUID()
                    Task { @MainActor in
                        await Task.yield()
                        scrollToBottom(proxy)
                    }
                }
                .onChange(of: navigationItems.map(\.id)) { _, ids in
                    if let selectedNavigationRoundID, !ids.contains(selectedNavigationRoundID) {
                        self.selectedNavigationRoundID = nil
                        followsLatest = true
                    }
                }
                .onChange(of: model.transcript.count) { _, count in
                    if count > 6, followsLatest, model.conversationTarget == nil { scrollToBottom(proxy) }
                }
                .onChange(of: model.streamingText) { _, _ in
                    if followsLatest, model.conversationTarget == nil { scrollToBottom(proxy) }
                }
                .onChange(of: model.streamingThinking) { _, _ in
                    if followsLatest, model.conversationTarget == nil { scrollToBottom(proxy) }
                }
                .onChange(of: model.streamingTools) { _, _ in
                    if followsLatest, model.conversationTarget == nil { scrollToBottom(proxy) }
                }
                .task(id: model.conversationTarget?.token) {
                    guard let target = model.conversationTarget else {
                        highlightedEntryID = nil
                        return
                    }
                    defer {
                        if highlightedEntryID == target.entryID { highlightedEntryID = nil }
                        model.clearConversationTarget(target.token)
                    }
                    guard target.sessionID == model.selectedSessionID,
                          model.transcript.contains(where: { $0.id == target.entryID }) else { return }
                    if let round = rounds.first(where: { $0.entryIDs.contains(target.entryID) }) {
                        if round.processEntryIDs.contains(target.entryID) {
                            expandedRoundIDs.insert(round.id)
                        }
                        followsLatest = false
                        selectedNavigationRoundID = round.id
                    }
                    highlightedEntryID = target.entryID
                    await Task.yield()
                    if reduceMotion {
                        proxy.scrollTo(target.entryID, anchor: .center)
                    } else {
                        withAnimation(.smooth(duration: 0.28)) {
                            proxy.scrollTo(target.entryID, anchor: .center)
                        }
                    }
                    try? await Task.sleep(for: .seconds(1.6))
                    guard !Task.isCancelled else { return }
                    if reduceMotion { highlightedEntryID = nil }
                    else {
                        withAnimation(.easeOut(duration: 0.25)) { highlightedEntryID = nil }
                    }
                }
            }
        }
        .background(Color(nsColor: .textBackgroundColor))
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy) {
        if reduceMotion {
            proxy.scrollTo(bottomID, anchor: .bottom)
        } else {
            withAnimation(.smooth(duration: 0.2)) {
                proxy.scrollTo(bottomID, anchor: .bottom)
            }
        }
    }

    private func navigate(to item: ConversationNavigationItem, using proxy: ScrollViewProxy) {
        followsLatest = false
        selectedNavigationRoundID = item.id
        highlightedRoundID = item.id
        let token = UUID()
        navigationHighlightToken = token
        if reduceMotion {
            proxy.scrollTo(item.anchorID, anchor: .center)
        } else {
            withAnimation(.smooth(duration: 0.28)) {
                proxy.scrollTo(item.anchorID, anchor: .center)
            }
        }
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(1.6))
            guard navigationHighlightToken == token else { return }
            if reduceMotion {
                highlightedRoundID = nil
            } else {
                withAnimation(.easeOut(duration: 0.25)) {
                    highlightedRoundID = nil
                }
            }
        }
    }

    private func returnToLatest(using proxy: ScrollViewProxy) {
        followsLatest = true
        selectedNavigationRoundID = nil
        highlightedRoundID = nil
        navigationHighlightToken = UUID()
        scrollToBottom(proxy)
    }

    private var pathActionDisabled: Bool {
        model.isStreaming
            || model.isOpeningSession
            || model.isPromptTransactionActive
            || !model.canPersistSessionDrafts
    }

    private func expansionBinding(for roundID: String) -> Binding<Bool> {
        Binding(
            get: { expandedRoundIDs.contains(roundID) },
            set: { expanded in
                if expanded { expandedRoundIDs.insert(roundID) }
                else { expandedRoundIDs.remove(roundID) }
            }
        )
    }
}

private struct ConversationRoundView: View {
    let round: ConversationRound
    @Binding var expanded: Bool
    let highlightedEntryID: String?
    let highlighted: Bool
    let pathActionDisabled: Bool
    let pathAction: (TranscriptItem) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if let user = round.user {
                row(user)
            }
            if round.completedAt != nil || !round.processItems.isEmpty || round.hasError {
                activitySummary
            }
            if let finalAssistant = round.finalAssistant {
                row(finalAssistant)
            }
        }
        .background(
            highlighted ? Color.accentColor.opacity(0.10) : Color.clear,
            in: RoundedRectangle(cornerRadius: 14, style: .continuous)
        )
        .overlay {
            if highlighted {
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(Color.accentColor.opacity(0.42), lineWidth: 1.5)
            }
        }
    }

    @ViewBuilder
    private var activitySummary: some View {
        if round.processItems.isEmpty {
            Label(summaryText, systemImage: round.hasError ? "exclamationmark.triangle.fill" : "clock")
                .font(.callout)
                .foregroundStyle(round.hasError ? Color.red : Color.secondary)
                .padding(.leading, 36)
                .accessibilityLabel(summaryAccessibilityLabel)
        } else {
            DisclosureGroup(isExpanded: $expanded) {
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(round.processItems) { item in
                        row(item, allowsPathAction: round.entryIDs.contains(item.id))
                    }
                }
                .padding(.top, 10)
                .padding(.leading, 6)
            } label: {
                Label(summaryText, systemImage: round.hasError ? "exclamationmark.triangle.fill" : "clock")
                    .font(.callout)
                    .foregroundStyle(round.hasError ? Color.red : Color.secondary)
            }
            .padding(.leading, 36)
            .accessibilityLabel(summaryAccessibilityLabel)
            .accessibilityHint(expanded ? "收起中间过程" : "展开查看中间思考与工具过程")
        }
    }

    private var summaryText: String {
        var parts: [String] = []
        if round.hasError, round.finalAssistant == nil {
            parts.append("执行失败")
        } else if let duration = ConversationTimingFormatter.durationText(round.duration) {
            parts.append("耗时 \(duration)")
        } else {
            parts.append("中间过程")
        }
        if round.toolCount > 0 { parts.append("\(round.toolCount) 个工具") }
        if let completedAt = round.completedAt {
            parts.append("\(completedAt.formatted(date: .omitted, time: .shortened)) 完成")
        }
        return parts.joined(separator: " · ")
    }

    private var summaryAccessibilityLabel: String {
        "本轮\(summaryText)"
    }

    private func row(_ item: TranscriptItem, allowsPathAction: Bool = true) -> some View {
        MessageRow(
            item: item,
            pathActionDisabled: pathActionDisabled,
            pathAction: allowsPathAction
                && (item.role == .assistant || (item.role == .user && item.editableText != nil))
                ? { pathAction(item) }
                : nil
        )
        .id(item.id)
        .padding(.horizontal, 6)
        .padding(.vertical, 4)
        .background(
            highlightedEntryID == item.id ? Color.accentColor.opacity(0.16) : Color.clear,
            in: RoundedRectangle(cornerRadius: 12, style: .continuous)
        )
        .overlay {
            if highlightedEntryID == item.id {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(Color.accentColor.opacity(0.45), lineWidth: 1.5)
            }
        }
    }
}

private struct MessageRow: View {
    let item: TranscriptItem
    var pathActionDisabled = false
    var pathAction: (() -> Void)?

    init(
        item: TranscriptItem,
        pathActionDisabled: Bool = false,
        pathAction: (() -> Void)? = nil
    ) {
        self.item = item
        self.pathActionDisabled = pathActionDisabled
        self.pathAction = pathAction
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            if item.role == .user { Spacer(minLength: 80) }
            if item.role != .user { roleIcon }
            VStack(alignment: item.role == .user ? .trailing : .leading, spacing: item.role == .user ? 4 : 9) {
                ForEach(item.blocks) { block in
                    blockView(block, expands: item.role != .user)
                }
                if let timestamp = item.timestamp {
                    Text(timestamp.formatted(date: .omitted, time: .shortened))
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.tertiary)
                }
                if let pathAction,
                   item.role == .assistant || (item.role == .user && item.editableText != nil) {
                    Button(action: pathAction) {
                        Label(
                            item.role == .user ? "编辑并重走" : "从这里继续",
                            systemImage: "arrow.triangle.branch"
                        )
                        .frame(minHeight: PiDCodeMetrics.minimumTarget)
                    }
                    .buttonStyle(.plain)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityLabel(
                        item.role == .user ? "从这条用户消息编辑并重走" : "从这条助手消息继续"
                    )
                    .disabled(pathActionDisabled)
                }
            }
            .padding(.vertical, item.role == .user ? 8 : 0)
            .padding(.horizontal, item.role == .user ? 12 : 0)
            .background {
                if item.role == .user {
                    RoundedRectangle(cornerRadius: PiDCodeMetrics.messageRadius, style: .continuous)
                        .fill(Color.accentColor.opacity(0.08))
                }
            }
            if item.role != .user { Spacer(minLength: 44) }
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .contain)
    }

    private var roleIcon: some View {
        Image(systemName: item.role == .tool ? "wrench.and.screwdriver" : "sparkles")
            .font(.caption.weight(.semibold))
            .foregroundStyle(item.role == .tool ? Color.secondary : Color.accentColor)
            .frame(width: 24, height: 24)
            .background(Color.primary.opacity(0.045), in: Circle())
            .accessibilityHidden(true)
    }

    @ViewBuilder
    private func blockView(_ block: TranscriptBlock, expands: Bool) -> some View {
        switch block {
        case let .text(_, value):
            CopyableMarkdownText(value: value, expands: expands)
        case let .code(_, language, source):
            CodeBlockView(language: language, source: source)
        case let .mermaid(_, source):
            MermaidDiagramView(source: source)
        case let .thinking(_, value):
            DisclosureGroup {
                Text(value)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 5)
            } label: {
                Label("Thinking", systemImage: "brain")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
            }
        case let .toolCall(_, call):
            ToolCallCard(call: call)
        case let .toolResult(_, result):
            ToolResultCard(result: result)
        case let .error(_, value):
            TranscriptErrorView(value: value)
        case let .attachment(_, label):
            Label(label, systemImage: "photo")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
    }
}

private struct CopyableMarkdownText: View {
    let value: String
    var expands = true
    @State private var copied = false
    @State private var hovering = false
    @FocusState private var copyFocused: Bool

    var body: some View {
        ZStack(alignment: .topTrailing) {
            messageText
            if expands {
                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(value, forType: .string)
                    copied = true
                    Task {
                        try? await Task.sleep(for: .seconds(1.2))
                        copied = false
                    }
                } label: {
                    Image(systemName: copied ? "checkmark" : "doc.on.doc")
                        .foregroundStyle(copied ? Color.green : Color.secondary)
                }
                .buttonStyle(IconActionStyle())
                .focused($copyFocused)
                .opacity(hovering || copyFocused || copied ? 1 : 0)
                .help(copied ? "已复制" : "复制消息")
                .accessibilityLabel(copied ? "已复制" : "复制消息")
            }
        }
        .onHover { hovering = $0 }
    }

    @ViewBuilder
    private var messageText: some View {
        if expands {
            Text(markdown)
                .font(.body)
                .lineSpacing(3)
                .textSelection(.enabled)
                .padding(.trailing, PiDCodeMetrics.minimumTarget + 6)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            Text(markdown)
                .font(.body)
                .lineSpacing(3)
                .textSelection(.enabled)
                .frame(width: preferredTextWidth, alignment: .leading)
        }
    }

    private var preferredTextWidth: CGFloat {
        let bounds = (value as NSString).boundingRect(
            with: NSSize(width: 560, height: 10_000),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            attributes: [.font: NSFont.preferredFont(forTextStyle: .body)]
        )
        return min(560, max(20, ceil(bounds.width)))
    }

    private var markdown: AttributedString {
        MarkdownPresentation.attributedString(for: value)
    }
}

private struct TranscriptErrorView: View {
    let value: String

    var body: some View {
        DisclosureGroup {
            Text(value)
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
                .padding(.top, 6)
        } label: {
            VStack(alignment: .leading, spacing: 3) {
                Label("模型请求失败", systemImage: "exclamationmark.triangle.fill")
                    .font(.callout.weight(.medium))
                    .foregroundStyle(.red)
                Text(conciseMessage)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityLabel("模型请求失败，\(conciseMessage)")
    }

    private var conciseMessage: String {
        guard let brace = value.firstIndex(of: "{"),
              let data = String(value[brace...]).data(using: .utf8),
              let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let error = payload["error"] as? [String: Any],
              let message = error["message"] as? String else {
            return value
        }
        let status = value[..<brace].trimmingCharacters(in: .whitespacesAndNewlines)
        return status.isEmpty ? message : "\(status) · \(message)"
    }
}

private struct ToolCallCard: View {
    let call: ToolCallPresentation
    @State private var expanded = false

    var body: some View {
        let descriptor = ToolPresentationFormatter.callDescriptor(call)
        DisclosureGroup(isExpanded: $expanded) {
            Text(ToolPresentationFormatter.expandedCallDetails(call))
                .font(.caption.monospaced())
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 7)
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Label(descriptor.title, systemImage: descriptor.systemImage)
                    .font(.callout.weight(.medium))
                if let subtitle = descriptor.subtitle {
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
        }
        .padding(10)
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: PiDCodeMetrics.controlRadius))
        .overlay {
            RoundedRectangle(cornerRadius: PiDCodeMetrics.controlRadius)
                .strokeBorder(Color.primary.opacity(0.08))
        }
        .accessibilityLabel("工具调用，\(descriptor.title)")
    }
}

private struct ToolResultCard: View {
    let result: ToolResultPresentation
    @State private var expanded = false

    var body: some View {
        let descriptor = ToolPresentationFormatter.resultDescriptor(result)
        DisclosureGroup(isExpanded: $expanded) {
            ToolResultDetailsView(result: result)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 7)
        } label: {
            HStack {
                Label(descriptor.title, systemImage: descriptor.systemImage)
                    .font(.callout.weight(.medium))
                    .foregroundStyle(result.isError ? Color.red : Color.primary)
                Spacer()
                Group {
                    if let subtitle = descriptor.subtitle {
                        Text(subtitle)
                            .lineLimit(1)
                    } else {
                        Text(result.isError ? "失败" : "完成")
                    }
                }
                .font(.caption)
                .foregroundStyle(result.isError ? Color.red : Color.secondary)
            }
        }
        .padding(10)
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: PiDCodeMetrics.controlRadius))
        .overlay {
            RoundedRectangle(cornerRadius: PiDCodeMetrics.controlRadius)
                .strokeBorder(result.isError ? Color.red.opacity(0.25) : Color.primary.opacity(0.08))
        }
    }
}

private struct ToolResultDetailsView: View {
    let result: ToolResultPresentation

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let diff = ToolPresentationFormatter.diff(from: result.details) {
                if !result.content.isEmpty {
                    Text(result.content)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
                NativeDiffView(diff: diff)
            } else if !anchorSections.isEmpty, anchorSections.contains(where: { !$0.lines.isEmpty }) {
                ForEach(anchorSections) { section in
                    DHashlineAnchorSectionView(
                        section: section,
                        toolName: result.name
                    )
                }
            } else {
                if !result.content.isEmpty {
                    Text(result.content)
                        .font(.caption.monospaced())
                        .textSelection(.enabled)
                }
                if let details = result.details, !details.isEmpty {
                    Text(details)
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
            }
        }
    }

    private var anchorSections: [DHashlineAnchorSection] {
        ToolPresentationFormatter.anchorSections(from: result.content)
    }
}

private struct DHashlineAnchorSectionView: View {
    let section: DHashlineAnchorSection
    let toolName: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text(section.path)
                    .font(.caption.weight(.medium))
                    .textSelection(.enabled)
                Text("#\(section.tag)")
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
            }
            if omittedLineCount > 0,
               let first = visibleLines.first,
               let last = visibleLines.last {
                anchorLine(first)
                Text("… 省略第 \(first.number + 1)–\(last.number - 1) 行 …")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityLabel("省略 \(omittedLineCount) 行")
                anchorLine(last)
            } else {
                ForEach(visibleLines) { line in
                    anchorLine(line)
                }
            }
        }
        .padding(8)
        .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
    }

    private var visibleLines: [DHashlineAnchorLine] {
        ToolPresentationFormatter.visibleAnchorLines(toolName: toolName, section: section)
    }

    private var omittedLineCount: Int {
        max(0, section.lines.count - visibleLines.count)
    }

    private func anchorLine(_ line: DHashlineAnchorLine) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text("\(line.number)")
                .font(.caption2.monospacedDigit())
                .foregroundStyle(line.isMatch ? Color.accentColor : Color.secondary)
                .frame(minWidth: 34, alignment: .trailing)
            Text(line.text)
                .font(.caption.monospaced())
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 2)
        .background(line.isMatch ? Color.accentColor.opacity(0.08) : Color.clear)
    }
}

private struct NativeDiffView: View {
    let diff: String

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            ForEach(Array(diff.components(separatedBy: "\n").enumerated()), id: \.offset) { _, line in
                Text(line.isEmpty ? " " : line)
                    .font(.caption.monospaced())
                    .foregroundStyle(foreground(for: line))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 1)
                    .background(background(for: line))
                    .textSelection(.enabled)
            }
        }
        .padding(.vertical, 6)
        .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
    }

    private func foreground(for line: String) -> Color {
        if line.hasPrefix("+") && !line.hasPrefix("+++") { return .green }
        if line.hasPrefix("-") && !line.hasPrefix("---") { return .red }
        return .secondary
    }

    private func background(for line: String) -> Color {
        if line.hasPrefix("+") && !line.hasPrefix("+++") { return Color.green.opacity(0.08) }
        if line.hasPrefix("-") && !line.hasPrefix("---") { return Color.red.opacity(0.08) }
        return .clear
    }
}

private struct StreamingResponseView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "sparkles")
                .font(.caption.weight(.semibold))
                .foregroundStyle(Color.accentColor)
                .frame(width: 26, height: 26)
                .background(Color.primary.opacity(0.055), in: Circle())
            VStack(alignment: .leading, spacing: 10) {
                if let tool = model.streamingTools.last(where: \.isRunning) {
                    let descriptor = ToolPresentationFormatter.callDescriptor(
                        name: tool.name,
                        arguments: tool.details
                    )
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        VStack(alignment: .leading, spacing: 2) {
                            Label(descriptor.title, systemImage: descriptor.systemImage)
                                .font(.callout.weight(.medium))
                            if let subtitle = descriptor.subtitle {
                                Text(subtitle)
                                    .font(.caption.monospaced())
                                    .foregroundStyle(.secondary)
                                    .lineLimit(2)
                            }
                        }
                    }
                    .padding(10)
                    .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: PiDCodeMetrics.controlRadius))
                } else if !model.streamingThinking.isEmpty {
                    HStack(alignment: .top, spacing: 8) {
                        ProgressView().controlSize(.small)
                        VStack(alignment: .leading, spacing: 3) {
                            Label("正在思考", systemImage: "brain")
                                .font(.callout.weight(.medium))
                            Text(currentThinkingExcerpt)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(3)
                                .textSelection(.enabled)
                        }
                    }
                } else if !model.streamingText.isEmpty {
                    CopyableMarkdownText(value: model.streamingText)
                } else {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text(model.workingMessage ?? "Pi 正在思考…")
                            .foregroundStyle(.secondary)
                    }
                    .font(.callout)
                }
            }
            Spacer(minLength: 44)
        }
    }

    private var currentThinkingExcerpt: String {
        let paragraphs = model.streamingThinking
            .components(separatedBy: "\n")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        return paragraphs.suffix(3).joined(separator: "\n")
    }
}
