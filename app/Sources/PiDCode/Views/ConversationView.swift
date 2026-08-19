import AppKit
import Foundation
import SwiftUI

struct ConversationView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var highlightedEntryID: String?
    @State private var expandedRoundIDs: Set<String> = []
    @State private var selectedNavigationRoundID: String?
    @State private var followsLatest = true
    @State private var visibleEntryIDs: Set<String> = []
    private let bottomID = "conversation-bottom"

    var body: some View {
        let rounds = model.conversationRounds
        let navigationItems = model.conversationNavigationItems
        let presentationIdentity = ConversationNavigation.presentationIdentity(
            sessionID: model.selectedSessionID,
            pathID: model.inspection?.selectedPathId
        )
        GeometryReader { geometry in
            let showsEmptyState = model.transcript.isEmpty
                && model.optimisticUserMessage == nil
                && !model.isStreaming
            let showsPersistentRail = ConversationNavigation.shouldShowPersistentRail(
                width: geometry.size.width,
                roundCount: rounds.count
            )
            if showsEmptyState {
                ContentUnavailableView(
                    model.isNewSessionDraftActive ? "新会话" : "空会话",
                    systemImage: "text.bubble",
                    description: Text(
                        model.isNewSessionDraftActive
                            ? "输入并发送第一条消息后，才会创建 Pi 会话。"
                            : "在下方输入第一条消息。"
                    )
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollViewReader { proxy in
                    ZStack(alignment: .leading) {
                        List {
                            Color.clear
                                .frame(height: 15)
                                .conversationListRow(showsPersistentRail: showsPersistentRail)

                            ForEach(rounds) { round in
                                ConversationRoundView(
                                    round: round,
                                    collapsesUserMessage: UserMessagePresentation.roundIsInactive(
                                        round,
                                        latestRoundID: rounds.last?.id
                                    ),
                                    expanded: expansionBinding(for: round.id),
                                    highlightedEntryID: highlightedEntryID,
                                    pathActionDisabled: pathActionDisabled,
                                    pathAction: model.beginPathDraft,
                                    entryVisibilityChanged: { entryID, isVisible in
                                        if isVisible {
                                            visibleEntryIDs.insert(entryID)
                                            model.markCompletionPresented(entryID: entryID)
                                        } else {
                                            visibleEntryIDs.remove(entryID)
                                        }
                                    }
                                )
                                .padding(.vertical, 9)
                                .conversationListRow(showsPersistentRail: showsPersistentRail)
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
                                .padding(.vertical, 9)
                                .conversationListRow(showsPersistentRail: showsPersistentRail)
                            }

                            if model.isStreaming || !model.streamingText.isEmpty || !model.streamingThinking.isEmpty {
                                StreamingResponseView()
                                    .padding(.vertical, 9)
                                    .conversationListRow(showsPersistentRail: showsPersistentRail)
                            }

                            Color.clear
                                .frame(height: 15)
                                .conversationListRow(showsPersistentRail: showsPersistentRail)
                                .id(bottomID)
                        }
                        .listStyle(.plain)
                        .scrollContentBackground(.hidden)
                        .environment(\.defaultMinListRowHeight, 0)
                        .id(presentationIdentity)
                        .task(id: "\(presentationIdentity):\(rounds.count)") {
                            await Task.yield()
                            await Task.yield()
                            guard followsLatest, model.conversationTarget == nil else { return }
                            scrollToBottom(proxy, animated: false)
                        }
                        .accessibilityScrollAction { edge in
                            accessibilityScroll(
                                toward: edge,
                                items: navigationItems,
                                using: proxy
                            )
                        }

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
                                    .frame(minHeight: PiDCodeMetrics.compactControlHeight)
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
                        highlightedEntryID = nil
                        expandedRoundIDs.removeAll()
                        visibleEntryIDs.removeAll()
                        Task { @MainActor in
                            await Task.yield()
                            await Task.yield()
                            scrollToBottom(proxy, animated: false)
                        }
                    }
                    .onChange(of: navigationItems.map(\.id)) { _, ids in
                        if let selectedNavigationRoundID, !ids.contains(selectedNavigationRoundID) {
                            self.selectedNavigationRoundID = nil
                            followsLatest = true
                        }
                    }
                    .onChange(of: model.activityAttentionRecords) { _, records in
                        guard let sessionID = model.selectedSessionID,
                              let record = records.first(where: {
                                  $0.sessionID == sessionID && $0.isUnseen
                              }),
                              visibleEntryIDs.contains(record.entryID) else { return }
                        model.markCompletionPresented(entryID: record.entryID)
                    }
                    .onChange(of: model.transcript.count) { _, count in
                        if count > 6 { scrollToBottomAfterLayout(proxy) }
                    }
                    .onChange(of: model.streamingText) { _, _ in
                        scrollToBottomAfterLayout(proxy)
                    }
                    .onChange(of: model.streamingThinking) { _, _ in
                        scrollToBottomAfterLayout(proxy)
                    }
                    .onChange(of: model.streamingTools) { _, _ in
                        scrollToBottomAfterLayout(proxy)
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
                            proxy.scrollTo(
                                ConversationNavigation.anchorID(for: round.id),
                                anchor: .center
                            )
                        }
                        highlightedEntryID = target.entryID
                        await Task.yield()
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
        }
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy, animated: Bool = true) {
        if reduceMotion || !animated {
            proxy.scrollTo(bottomID, anchor: .bottom)
        } else {
            withAnimation(.smooth(duration: 0.2)) {
                proxy.scrollTo(bottomID, anchor: .bottom)
            }
        }
    }

    private func scrollToBottomAfterLayout(_ proxy: ScrollViewProxy) {
        Task { @MainActor in
            await Task.yield()
            guard followsLatest, model.conversationTarget == nil else { return }
            scrollToBottom(proxy)
        }
    }

    private func accessibilityScroll(
        toward edge: Edge,
        items: [ConversationNavigationItem],
        using proxy: ScrollViewProxy
    ) {
        guard !items.isEmpty else { return }
        let lastIndex = items.count - 1
        let currentIndex = selectedNavigationRoundID
            .flatMap { selected in items.firstIndex(where: { $0.id == selected }) }
            ?? (followsLatest ? lastIndex : 0)
        let pageStep = min(5, max(1, items.count / 8))
        let targetIndex: Int
        switch edge {
        case .top:
            targetIndex = max(0, currentIndex - pageStep)
        case .bottom:
            targetIndex = min(lastIndex, currentIndex + pageStep)
        default:
            return
        }
        let target = items[targetIndex]
        followsLatest = targetIndex == lastIndex
        selectedNavigationRoundID = followsLatest ? nil : target.id
        proxy.scrollTo(target.anchorID, anchor: .center)
    }

    private func navigate(to item: ConversationNavigationItem, using proxy: ScrollViewProxy) {
        followsLatest = false
        selectedNavigationRoundID = item.id
        if reduceMotion {
            proxy.scrollTo(item.anchorID, anchor: .center)
        } else {
            withAnimation(.smooth(duration: 0.28)) {
                proxy.scrollTo(item.anchorID, anchor: .center)
            }
        }
    }

    private func returnToLatest(using proxy: ScrollViewProxy) {
        followsLatest = true
        selectedNavigationRoundID = nil
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

private extension View {
    func conversationListRow(showsPersistentRail: Bool) -> some View {
        frame(maxWidth: PiDCodeMetrics.contentMaxWidth)
            .padding(.leading, showsPersistentRail ? 72 : 28)
            .padding(.trailing, 28)
            .frame(maxWidth: .infinity)
            .listRowInsets(EdgeInsets())
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
    }
}

private struct ConversationRoundView: View {
    let round: ConversationRound
    let collapsesUserMessage: Bool
    @Binding var expanded: Bool
    let highlightedEntryID: String?
    let pathActionDisabled: Bool
    let pathAction: (TranscriptItem) -> Void
    let entryVisibilityChanged: (String, Bool) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if let user = round.user {
                row(user, collapsesCompletedUserMessage: collapsesUserMessage)
            }
            if !round.processItems.isEmpty || (round.hasError && round.finalAssistant == nil) {
                activitySummary
            }
            if let finalAssistant = round.finalAssistant {
                row(
                    finalAssistant,
                    completionMetadata: ConversationTimingFormatter.completionText(
                        duration: round.duration,
                        completedAt: round.completedAt,
                        totalTokens: round.totalTokens
                    ) ?? "",
                    completionFailed: round.finalAssistantFailed
                )
            }
        }
    }

    @ViewBuilder
    private var activitySummary: some View {
        if round.processItems.isEmpty {
            Label(summaryText, systemImage: round.hasError ? "exclamationmark.triangle.fill" : "ellipsis.circle")
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
                Label(summaryText, systemImage: round.hasError ? "exclamationmark.triangle.fill" : "ellipsis.circle")
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
        } else {
            parts.append("中间过程")
        }
        if round.toolCount > 0 { parts.append("\(round.toolCount) 个工具") }
        return parts.joined(separator: " · ")
    }

    private var summaryAccessibilityLabel: String {
        "本轮\(summaryText)"
    }

    private func row(
        _ item: TranscriptItem,
        allowsPathAction: Bool = true,
        collapsesCompletedUserMessage: Bool = false,
        completionMetadata: String? = nil,
        completionFailed: Bool = false
    ) -> some View {
        MessageRow(
            item: item,
            collapsesCompletedUserMessage: collapsesCompletedUserMessage,
            completionMetadata: completionMetadata,
            completionFailed: completionFailed,
            pathActionDisabled: pathActionDisabled,
            pathAction: allowsPathAction
                && (item.role == .assistant || (item.role == .user && item.editableText != nil))
                ? { pathAction(item) }
                : nil
        )
        .id(item.id)
        .onAppear { entryVisibilityChanged(item.id, true) }
        .onDisappear { entryVisibilityChanged(item.id, false) }
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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let item: TranscriptItem
    var collapsesCompletedUserMessage = false
    var completionMetadata: String?
    var completionFailed = false
    var pathActionDisabled = false
    var pathAction: (() -> Void)?
    @State private var userMessageExpanded = false
    @State private var hovering = false
    @State private var contentControlFocused = false
    @FocusState private var footerFocused: Bool

    init(
        item: TranscriptItem,
        collapsesCompletedUserMessage: Bool = false,
        completionMetadata: String? = nil,
        completionFailed: Bool = false,
        pathActionDisabled: Bool = false,
        pathAction: (() -> Void)? = nil
    ) {
        self.item = item
        self.collapsesCompletedUserMessage = collapsesCompletedUserMessage
        self.completionMetadata = completionMetadata
        self.completionFailed = completionFailed
        self.pathActionDisabled = pathActionDisabled
        self.pathAction = pathAction
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            if item.role == .user { Spacer(minLength: 80) }
            if item.role != .user { roleIcon }
            VStack(alignment: item.role == .user ? .trailing : .leading, spacing: 0) {
                messageSurface
                    .padding(.vertical, item.role == .user ? 8 : 0)
                    .padding(.horizontal, item.role == .user ? 12 : 0)
                    .background {
                        if item.role == .user {
                            RoundedRectangle(cornerRadius: PiDCodeMetrics.messageRadius, style: .continuous)
                                .fill(Color.accentColor.opacity(0.08))
                        }
                    }

                footerRow
            }
            if item.role != .user { Spacer(minLength: 44) }
        }
        .frame(maxWidth: .infinity)
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .onDisappear {
            hovering = false
            footerFocused = false
            contentControlFocused = false
        }
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private var messageSurface: some View {
        if userMessageCollapsible, !userMessageExpanded {
            Button(action: toggleUserMessageExpansion) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(MarkdownPresentation.attributedString(for: UserMessagePresentation.preview(for: item)))
                        .font(.body)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .frame(maxWidth: 560, alignment: .leading)
                    Image(systemName: "chevron.down")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.tertiary)
                }
                .frame(minHeight: 24)
            }
            .buttonStyle(.plain)
            .help("展开完整用户消息")
            .accessibilityLabel("已收起的用户消息：\(UserMessagePresentation.preview(for: item))")
            .accessibilityHint("展开完整内容")
        } else {
            VStack(alignment: item.role == .user ? .trailing : .leading, spacing: item.role == .user ? 4 : 9) {
                ForEach(item.blocks) { block in
                    blockView(block, expands: item.role != .user)
                }
            }
        }
    }

    @ViewBuilder
    private var footerRow: some View {
        if userMessageExpanded || pathActionAvailable || metadataText != nil {
            HStack(spacing: 10) {
                if item.role != .user, let metadataText {
                    metadataView(metadataText)
                }

                Spacer(minLength: 8)

                if userMessageCollapsible, userMessageExpanded {
                    Button(action: toggleUserMessageExpansion) {
                        Label("收起", systemImage: "chevron.up")
                            .frame(minHeight: PiDCodeMetrics.compactControlHeight)
                    }
                    .buttonStyle(.plain)
                    .focused($footerFocused)
                    .help("收起用户消息")
                    .accessibilityLabel("收起完整用户消息")
                }

                if pathActionAvailable, let pathAction {
                    Button(action: pathAction) {
                        Label(
                            item.role == .user ? "编辑并重走" : "从这里继续",
                            systemImage: "arrow.triangle.branch"
                        )
                        .frame(minHeight: PiDCodeMetrics.compactControlHeight)
                    }
                    .buttonStyle(.plain)
                    .focused($footerFocused)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityLabel(
                        item.role == .user ? "从这条用户消息编辑并重走" : "从这条助手消息继续"
                    )
                    .disabled(pathActionDisabled)
                    .opacity(showsMetadata ? 1 : 0)
                    .allowsHitTesting(showsMetadata)
                    .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: showsMetadata)
                }

                if item.role == .user, let metadataText {
                    metadataView(metadataText)
                }
            }
            .frame(
                maxWidth: .infinity,
                minHeight: userMessageExpanded || pathActionAvailable
                    ? PiDCodeMetrics.compactControlHeight
                    : 16,
                alignment: item.role == .user ? .trailing : .leading
            )
            .padding(.horizontal, item.role == .user ? 4 : 0)
        }
    }

    private var pathActionAvailable: Bool {
        pathAction != nil
            && (item.role == .assistant || (item.role == .user && item.editableText != nil))
    }

    private var metadataText: String? {
        completionMetadata ?? ConversationTimingFormatter.timestampText(item.timestamp)
    }

    private var metadataAccessibilityLabel: String {
        guard let metadataText else { return "" }
        guard completionMetadata != nil else { return "消息发送于 \(metadataText)" }
        let status = completionFailed ? "失败" : "已完成"
        return metadataText.isEmpty ? "本轮\(status)" : "本轮\(status)，\(metadataText)"
    }

    private var showsMetadata: Bool { hovering || footerFocused || contentControlFocused }

    private var metadataOpacity: Double {
        completionMetadata == nil ? (showsMetadata ? 0.72 : 0) : 0.72
    }

    private func metadataView(_ metadataText: String) -> some View {
        HStack(spacing: 6) {
            if completionMetadata != nil {
                Image(systemName: completionFailed ? "xmark" : "checkmark")
                    .foregroundStyle(completionFailed ? Color.red : Color.green)
                    .accessibilityHidden(true)
            }
            if !metadataText.isEmpty {
                Text(metadataText)
            }
        }
        .font(.caption2.monospacedDigit())
        .foregroundStyle(Color.secondary.opacity(metadataOpacity))
        .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: showsMetadata)
        .accessibilityLabel(metadataAccessibilityLabel)
    }

    private var userMessageCollapsible: Bool {
        UserMessagePresentation.shouldCollapse(
            item,
            roundIsInactive: collapsesCompletedUserMessage
        )
    }

    private func toggleUserMessageExpansion() {
        if reduceMotion {
            userMessageExpanded.toggle()
        } else {
            withAnimation(.smooth(duration: 0.2)) {
                userMessageExpanded.toggle()
            }
        }
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
            CopyableMarkdownText(
                value: value,
                expands: expands,
                rendersBlocks: expands,
                focusChanged: { contentControlFocused = $0 }
            )
        case let .code(_, language, source):
            CodeBlockView(language: language, source: source)
        case let .mermaid(_, source):
            MermaidDiagramView(source: source)
        case let .image(_, image):
            TranscriptImageView(presentation: image)
        case let .thinking(_, value):
            VStack(alignment: .leading, spacing: 6) {
                Label("思考过程", systemImage: "brain")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
                Text(value)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
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
    var rendersBlocks = true
    var focusChanged: ((Bool) -> Void)? = nil
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
        .onChange(of: copyFocused) { _, focused in focusChanged?(focused) }
        .onDisappear { focusChanged?(false) }
    }

    @ViewBuilder
    private var messageText: some View {
        if rendersBlocks {
            MarkdownDocumentView(document: MarkdownDocument.cached(value))
                .padding(.trailing, PiDCodeMetrics.iconActionTarget + 6)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else if expands {
            Text(value)
                .font(.body)
                .lineSpacing(3)
                .textSelection(.enabled)
                .padding(.trailing, PiDCodeMetrics.iconActionTarget + 6)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            Text(MarkdownPresentation.attributedString(for: value))
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
    @State private var showsThinking = true

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
                }

                if !model.streamingThinking.isEmpty {
                    DisclosureGroup(isExpanded: $showsThinking) {
                        Text(model.streamingThinking)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.top, 5)
                    } label: {
                        HStack(spacing: 8) {
                            ProgressView().controlSize(.small)
                            Label("Pi 正在思考", systemImage: "brain")
                                .font(.callout.weight(.medium))
                        }
                    }
                }

                if !model.streamingText.isEmpty {
                    CopyableMarkdownText(value: model.streamingText, rendersBlocks: false)
                }

                if model.streamingThinking.isEmpty,
                   model.streamingTools.last(where: \.isRunning) == nil,
                   model.streamingText.isEmpty {
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
}
