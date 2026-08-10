import AppKit
import Foundation
import SwiftUI

struct ConversationView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private let bottomID = "conversation-bottom"

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 18) {
                    if model.transcript.isEmpty, model.optimisticUserMessage == nil, !model.isStreaming {
                        ContentUnavailableView(
                            "空会话",
                            systemImage: "text.bubble",
                            description: Text(model.canWrite ? "在下方输入第一条消息。" : "接管会话后即可开始。")
                        )
                        .frame(maxWidth: .infinity)
                        .padding(.top, 80)
                    }
                    ForEach(model.transcript) { item in
                        MessageRow(item: item)
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
                .padding(.horizontal, 28)
                .padding(.vertical, 24)
                .frame(maxWidth: .infinity)
            }
            .id(model.selectedSessionID)
            .onChange(of: model.transcript.count) { _, count in
                if count > 6 { scrollToBottom(proxy) }
            }
            .onChange(of: model.streamingText) { _, _ in scrollToBottom(proxy) }
            .onChange(of: model.streamingThinking) { _, _ in scrollToBottom(proxy) }
            .onChange(of: model.streamingTools) { _, _ in scrollToBottom(proxy) }
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
}

private struct MessageRow: View {
    let item: TranscriptItem

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
        (try? AttributedString(
            markdown: value,
            options: .init(interpretedSyntax: .full, failurePolicy: .returnPartiallyParsedIfPossible)
        )) ?? AttributedString(value)
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
        DisclosureGroup(isExpanded: $expanded) {
            Text(call.arguments)
                .font(.caption.monospaced())
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 7)
        } label: {
            Label(call.name, systemImage: "terminal")
                .font(.callout.weight(.medium))
        }
        .padding(10)
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: PiDCodeMetrics.controlRadius))
        .overlay {
            RoundedRectangle(cornerRadius: PiDCodeMetrics.controlRadius)
                .strokeBorder(Color.primary.opacity(0.08))
        }
        .accessibilityLabel("工具调用 \(call.name)")
    }
}

private struct ToolResultCard: View {
    let result: ToolResultPresentation
    @State private var expanded = false

    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            VStack(alignment: .leading, spacing: 8) {
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
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 7)
        } label: {
            HStack {
                Label(result.name, systemImage: result.isError ? "xmark.circle.fill" : "checkmark.circle.fill")
                    .font(.callout.weight(.medium))
                    .foregroundStyle(result.isError ? Color.red : Color.primary)
                Spacer()
                Text(result.isError ? "失败" : "完成")
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
                if !model.streamingThinking.isEmpty {
                    DisclosureGroup("Thinking") {
                        Text(model.streamingThinking)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                            .padding(.top, 5)
                    }
                    .font(.caption.weight(.medium))
                }
                if !model.streamingText.isEmpty {
                    CopyableMarkdownText(value: model.streamingText)
                }
                ForEach(model.streamingTools) { tool in
                    HStack(spacing: 8) {
                        if tool.isRunning { ProgressView().controlSize(.small) }
                        else { Image(systemName: tool.isError ? "xmark.circle.fill" : "checkmark.circle.fill") }
                        VStack(alignment: .leading, spacing: 2) {
                            Text(tool.name).font(.callout.weight(.medium))
                            Text(tool.details).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(3)
                        }
                    }
                    .foregroundStyle(tool.isError ? Color.red : Color.primary)
                    .padding(10)
                    .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: PiDCodeMetrics.controlRadius))
                }
                if model.streamingText.isEmpty, model.streamingThinking.isEmpty, model.streamingTools.isEmpty {
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
