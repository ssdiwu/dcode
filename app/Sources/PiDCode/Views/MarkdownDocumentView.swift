import SwiftUI

struct MarkdownDocumentView: View {
    @Environment(AppModel.self) private var model
    let document: MarkdownDocument

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(document.blocks) { block in
                blockView(block)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .environment(\.openURL, OpenURLAction { url in
            guard url.scheme?.lowercased() == WorkspaceFileLink.scheme else {
                return .systemAction
            }
            Task { await model.openWorkspaceURL(url) }
            return .handled
        })
    }

    @ViewBuilder
    private func blockView(_ block: MarkdownBlock) -> some View {
        switch block {
        case let .text(text):
            MarkdownTextBlockView(block: text)
        case .rule:
            Divider()
                .padding(.vertical, 4)
                .accessibilityLabel("分隔线")
        case let .table(table):
            MarkdownTableBlockView(table: table)
        case let .fallback(_, source):
            Text(source)
                .font(.body)
                .lineSpacing(3)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityHint("此内容使用 Markdown 原文显示")
        }
    }
}

private struct MarkdownTextBlockView: View {
    let block: MarkdownTextBlock

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            ForEach(0..<block.quoteDepth, id: \.self) { _ in
                RoundedRectangle(cornerRadius: 1)
                    .fill(Color.secondary.opacity(0.45))
                    .frame(width: 3)
                    .accessibilityHidden(true)
            }
            listContent
        }
        .padding(.leading, CGFloat(max(0, block.listDepth - 1)) * 18)
        .padding(.vertical, block.listDepth > 0 || block.quoteDepth > 0 ? 1 : 0)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var listContent: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            if block.listDepth > 0 {
                Text(block.marker ?? "")
                    .font(.body.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .frame(width: 26, alignment: .trailing)
                    .accessibilityHidden(block.marker == nil)
            }
            text
        }
    }

    private var text: some View {
        Text(block.content)
            .font(font)
            .fontWeight(fontWeight)
            .lineSpacing(3)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(codePadding)
            .background(codeBackground)
            .accessibilityAddTraits(isHeading ? .isHeader : [])
    }

    private var font: Font {
        switch block.style {
        case .paragraph: .body
        case let .heading(level):
            switch level {
            case 1: .title2
            case 2: .title3
            case 3: .headline
            default: .subheadline
            }
        case .codeBlock: .body.monospaced()
        }
    }

    private var fontWeight: Font.Weight? {
        if case .heading = block.style { return .semibold }
        return nil
    }

    private var isHeading: Bool {
        if case .heading = block.style { return true }
        return false
    }

    private var codePadding: EdgeInsets {
        if case .codeBlock = block.style {
            return EdgeInsets(top: 8, leading: 10, bottom: 8, trailing: 10)
        }
        return EdgeInsets()
    }

    @ViewBuilder
    private var codeBackground: some View {
        if case .codeBlock = block.style {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(Color(nsColor: .controlBackgroundColor))
        }
    }
}

private struct MarkdownTableBlockView: View {
    let table: MarkdownTableBlock

    var body: some View {
        ScrollView(.horizontal) {
            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 7) {
                ForEach(table.rows) { row in
                    GridRow(alignment: .firstTextBaseline) {
                        ForEach(Array(row.cells.enumerated()), id: \.offset) { column, cell in
                            Text(cell)
                                .font(row.isHeader ? .callout.weight(.semibold) : .callout)
                                .textSelection(.enabled)
                                .frame(
                                    minWidth: 80,
                                    maxWidth: 320,
                                    alignment: alignment(for: column)
                                )
                                .accessibilityAddTraits(row.isHeader ? .isHeader : [])
                        }
                    }
                    if row.isHeader {
                        Divider().gridCellColumns(max(1, table.alignments.count))
                    }
                }
            }
            .padding(10)
        }
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Markdown 表格")
    }

    private func alignment(for column: Int) -> Alignment {
        guard table.alignments.indices.contains(column) else { return .leading }
        switch table.alignments[column] {
        case .leading: return Alignment.leading
        case .center: return Alignment.center
        case .trailing: return Alignment.trailing
        }
    }
}
