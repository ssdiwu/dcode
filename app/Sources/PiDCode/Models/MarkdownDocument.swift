import Foundation

enum MarkdownTextStyle: Equatable, Sendable {
    case paragraph
    case heading(level: Int)
    case codeBlock
}

enum MarkdownListKind: Equatable, Sendable {
    case ordered
    case unordered
}

struct MarkdownTextBlock: Identifiable, Equatable, Sendable {
    let id: Int
    var content: AttributedString
    let style: MarkdownTextStyle
    let quoteDepth: Int
    let listDepth: Int
    let marker: String?

    var plainText: String { String(content.characters) }
}

enum MarkdownTableAlignment: Equatable, Sendable {
    case leading
    case center
    case trailing
}

struct MarkdownTableRow: Identifiable, Equatable, Sendable {
    let id: Int
    let isHeader: Bool
    let cells: [AttributedString]
}

struct MarkdownTableBlock: Identifiable, Equatable, Sendable {
    let id: Int
    let alignments: [MarkdownTableAlignment]
    let rows: [MarkdownTableRow]
}

enum MarkdownBlock: Identifiable, Equatable, Sendable {
    case text(MarkdownTextBlock)
    case rule(id: Int)
    case table(MarkdownTableBlock)
    case fallback(id: Int, source: String)

    var id: Int {
        switch self {
        case let .text(block): block.id
        case let .rule(id), let .fallback(id, _): id
        case let .table(table): table.id
        }
    }
}

struct MarkdownDocument: Equatable, Sendable {
    static let maximumRichTextBytes = 256 * 1_024

    let rawSource: String
    let blocks: [MarkdownBlock]
    let usesPlainTextFallback: Bool

    static func parse(_ source: String) -> MarkdownDocument {
        guard source.utf8.prefix(maximumRichTextBytes + 1).count <= maximumRichTextBytes else {
            return fallback(source)
        }
        let normalization = MarkdownSourceNormalizer.normalizeCJKStrongBoundaries(in: source)
        guard var attributed = try? AttributedString(
            markdown: normalization.source,
            options: .init(
                interpretedSyntax: .full,
                failurePolicy: .returnPartiallyParsedIfPossible
            )
        ) else {
            return fallback(source)
        }
        if let syntheticMarker = normalization.syntheticMarker {
            while let range = attributed.range(of: syntheticMarker) {
                attributed.removeSubrange(range)
            }
        }
        guard !attributed.runs.contains(where: { $0.imageURL != nil }) else {
            return fallback(source)
        }

        var blocks: [MarkdownBlock] = []
        var textBuilder: TextBuilder?
        var tableBuilder: TableBuilder?
        var seenListItems: Set<Int> = []
        var unsupported = false

        func sanitizedFragment(for run: AttributedString.Runs.Run) -> AttributedString {
            var fragment = AttributedString(attributed[run.range])
            fragment.presentationIntent = nil
            MarkdownLinkPolicy.sanitizeLinks(in: &fragment)
            return fragment
        }

        func flushText() {
            guard let builder = textBuilder else { return }
            blocks.append(.text(builder.block))
            textBuilder = nil
        }

        func flushTable() {
            guard let builder = tableBuilder else { return }
            blocks.append(.table(builder.block))
            tableBuilder = nil
        }

        for run in attributed.runs {
            guard let intent = run.presentationIntent else {
                unsupported = true
                break
            }
            let components = intent.components
            let fragment = sanitizedFragment(for: run)

            if let table = TableContext(components: components) {
                flushText()
                if tableBuilder?.id != table.tableID {
                    flushTable()
                    tableBuilder = TableBuilder(context: table)
                }
                tableBuilder?.append(fragment, context: table)
                continue
            }

            flushTable()
            guard let leaf = components.first else {
                unsupported = true
                break
            }

            if case .thematicBreak = leaf.kind {
                flushText()
                blocks.append(.rule(id: leaf.identity))
                continue
            }

            guard let style = MarkdownTextStyle(leaf.kind) else {
                unsupported = true
                break
            }

            if textBuilder?.id != leaf.identity {
                flushText()
                let list = ListContext(components: components)
                let marker: String?
                if let item = list.innermostItem, seenListItems.insert(item.id).inserted {
                    marker = item.kind == .ordered ? "\(item.ordinal)." : "•"
                } else {
                    marker = nil
                }
                textBuilder = TextBuilder(
                    id: leaf.identity,
                    content: AttributedString(),
                    style: style,
                    quoteDepth: components.reduce(into: 0) { count, component in
                        if case .blockQuote = component.kind { count += 1 }
                    },
                    listDepth: list.depth,
                    marker: marker
                )
            }
            textBuilder?.content.append(fragment)
        }

        flushText()
        flushTable()
        guard !unsupported, !blocks.isEmpty || source.isEmpty else { return fallback(source) }
        return MarkdownDocument(rawSource: source, blocks: blocks, usesPlainTextFallback: false)
    }

    static func cached(_ source: String) -> MarkdownDocument {
        MarkdownDocumentCache.shared.document(for: source)
    }

    private static func fallback(_ source: String) -> MarkdownDocument {
        MarkdownDocument(
            rawSource: source,
            blocks: [.fallback(id: 0, source: source)],
            usesPlainTextFallback: true
        )
    }
}

private struct MarkdownSourceNormalization {
    let source: String
    let syntheticMarker: String?
}

private enum MarkdownSourceNormalizer {
    /// Foundation follows CommonMark delimiter boundaries exactly. A closing `**`
    /// preceded by punctuation and immediately followed by CJK text is therefore
    /// treated as literal source. Insert a removable whitespace boundary only for
    /// that narrow shape, outside inline-code spans, so the user's visible source
    /// and copy payload remain unchanged.
    static func normalizeCJKStrongBoundaries(in source: String) -> MarkdownSourceNormalization {
        let characters = Array(source)
        guard characters.count >= 5,
              let sentinel = unusedSentinel(in: source) else {
            return MarkdownSourceNormalization(source: source, syntheticMarker: nil)
        }

        let syntheticMarker = " \(sentinel)"
        var output = ""
        output.reserveCapacity(source.count + 8)
        var strongOpenDepth = 0
        var codeDelimiterLength: Int?
        var linkDestinationDepth = 0
        var insideAngleDestination = false
        var index = 0

        while index < characters.count {
            let character = characters[index]

            if character == "\\", index + 1 < characters.count {
                output.append(character)
                output.append(characters[index + 1])
                index += 2
                continue
            }

            if linkDestinationDepth > 0 {
                output.append(character)
                if character == "(" { linkDestinationDepth += 1 }
                if character == ")" { linkDestinationDepth -= 1 }
                index += 1
                continue
            }

            if insideAngleDestination {
                output.append(character)
                if character == ">" { insideAngleDestination = false }
                index += 1
                continue
            }

            if character == "`" {
                var end = index
                while end < characters.count, characters[end] == "`" { end += 1 }
                let length = end - index
                output.append(contentsOf: characters[index..<end])
                if let activeLength = codeDelimiterLength {
                    if activeLength == length { codeDelimiterLength = nil }
                } else {
                    codeDelimiterLength = length
                }
                index = end
                continue
            }

            if codeDelimiterLength == nil,
               character == "]",
               index + 1 < characters.count,
               characters[index + 1] == "(" {
                output.append("](")
                linkDestinationDepth = 1
                index += 2
                continue
            }

            if codeDelimiterLength == nil, character == "<" {
                output.append(character)
                insideAngleDestination = true
                index += 1
                continue
            }

            let isExactDoubleAsterisk = codeDelimiterLength == nil
                && character == "*"
                && index + 1 < characters.count
                && characters[index + 1] == "*"
                && (index == 0 || characters[index - 1] != "*")
                && (index + 2 >= characters.count || characters[index + 2] != "*")

            if isExactDoubleAsterisk {
                let previous = index > 0 ? characters[index - 1] : nil
                let next = index + 2 < characters.count ? characters[index + 2] : nil
                let canOpen = isLeftFlanking(previous: previous, next: next)
                let canClose = isRightFlanking(previous: previous, next: next)
                if canClose, strongOpenDepth > 0 {
                    strongOpenDepth -= 1
                } else if strongOpenDepth > 0,
                          let previous, let next,
                          isPunctuation(previous), isCJK(next) {
                    output.append("**")
                    output.append(syntheticMarker)
                    strongOpenDepth -= 1
                    index += 2
                    continue
                } else if canOpen {
                    strongOpenDepth += 1
                }
            }

            output.append(character)
            index += 1
        }

        guard output != source else {
            return MarkdownSourceNormalization(source: source, syntheticMarker: nil)
        }
        return MarkdownSourceNormalization(source: output, syntheticMarker: syntheticMarker)
    }

    private static func unusedSentinel(in source: String) -> Character? {
        for value in 0xE000...0xE00F {
            guard let scalar = UnicodeScalar(value) else { continue }
            let character = Character(String(scalar))
            if !source.contains(character) { return character }
        }
        return nil
    }

    private static func isPunctuation(_ character: Character) -> Bool {
        character.unicodeScalars.allSatisfy { scalar in
            switch scalar.properties.generalCategory {
            case .connectorPunctuation, .dashPunctuation, .openPunctuation,
                 .closePunctuation, .initialPunctuation, .finalPunctuation,
                 .otherPunctuation:
                true
            default:
                false
            }
        }
    }

    private static func isLeftFlanking(previous: Character?, next: Character?) -> Bool {
        guard let next, !next.isWhitespace else { return false }
        return !isPunctuation(next)
            || previous == nil
            || previous?.isWhitespace == true
            || previous.map(isPunctuation) == true
    }

    private static func isRightFlanking(previous: Character?, next: Character?) -> Bool {
        guard let previous, !previous.isWhitespace else { return false }
        return next == nil
            || next?.isWhitespace == true
            || !isPunctuation(previous)
            || next.map(isPunctuation) == true
    }

    private static func isCJK(_ character: Character) -> Bool {
        character.unicodeScalars.contains { scalar in
            switch scalar.value {
            case 0x2E80...0x2FDF, 0x3040...0x30FF, 0x31F0...0x31FF,
                 0x3400...0x4DBF, 0x4E00...0x9FFF, 0xAC00...0xD7AF,
                 0xF900...0xFAFF, 0x20000...0x3134F:
                true
            default:
                false
            }
        }
    }
}

private extension MarkdownTextStyle {
    init?(_ kind: PresentationIntent.Kind) {
        switch kind {
        case .paragraph:
            self = .paragraph
        case let .header(level):
            self = .heading(level: level)
        case .codeBlock:
            self = .codeBlock
        default:
            return nil
        }
    }
}

private struct TextBuilder {
    let id: Int
    var content: AttributedString
    let style: MarkdownTextStyle
    let quoteDepth: Int
    let listDepth: Int
    let marker: String?

    var block: MarkdownTextBlock {
        MarkdownTextBlock(
            id: id,
            content: content,
            style: style,
            quoteDepth: quoteDepth,
            listDepth: listDepth,
            marker: marker
        )
    }
}

private struct ListItemContext {
    let id: Int
    let ordinal: Int
    let kind: MarkdownListKind
}

private struct ListContext {
    let items: [ListItemContext]

    init(components: [PresentationIntent.IntentType]) {
        var innerToOuter: [ListItemContext] = []
        for (index, component) in components.enumerated() {
            let kind: MarkdownListKind
            switch component.kind {
            case .orderedList: kind = .ordered
            case .unorderedList: kind = .unordered
            default: continue
            }
            guard index > 0,
                  case let .listItem(ordinal) = components[index - 1].kind else { continue }
            innerToOuter.append(ListItemContext(
                id: components[index - 1].identity,
                ordinal: ordinal,
                kind: kind
            ))
        }
        items = innerToOuter.reversed()
    }

    var depth: Int { items.count }
    var innermostItem: ListItemContext? { items.last }
}

private struct TableContext {
    let tableID: Int
    let alignments: [MarkdownTableAlignment]
    let rowID: Int
    let rowIsHeader: Bool
    let columnIndex: Int

    init?(components: [PresentationIntent.IntentType]) {
        guard let table = components.first(where: {
            if case .table = $0.kind { return true }
            return false
        }),
        let row = components.first(where: {
            switch $0.kind {
            case .tableHeaderRow, .tableRow: true
            default: false
            }
        }),
        let cell = components.first(where: {
            if case .tableCell = $0.kind { return true }
            return false
        }) else { return nil }

        guard case let .table(columns) = table.kind,
              case let .tableCell(columnIndex) = cell.kind else { return nil }
        tableID = table.identity
        alignments = columns.map { column in
            switch column.alignment {
            case .left: .leading
            case .center: .center
            case .right: .trailing
            @unknown default: .leading
            }
        }
        rowID = row.identity
        if case .tableHeaderRow = row.kind { rowIsHeader = true }
        else { rowIsHeader = false }
        self.columnIndex = columnIndex
    }
}

private struct TableRowBuilder {
    let id: Int
    let isHeader: Bool
    var cells: [Int: AttributedString] = [:]
}

private struct TableBuilder {
    let id: Int
    let alignments: [MarkdownTableAlignment]
    var rows: [TableRowBuilder] = []

    init(context: TableContext) {
        id = context.tableID
        alignments = context.alignments
    }

    mutating func append(_ fragment: AttributedString, context: TableContext) {
        if rows.last?.id != context.rowID {
            rows.append(TableRowBuilder(id: context.rowID, isHeader: context.rowIsHeader))
        }
        guard let index = rows.indices.last else { return }
        var content = rows[index].cells[context.columnIndex] ?? AttributedString()
        content.append(fragment)
        rows[index].cells[context.columnIndex] = content
    }

    var block: MarkdownTableBlock {
        let columnCount = max(
            alignments.count,
            rows.flatMap { $0.cells.keys }.max().map { $0 + 1 } ?? 0
        )
        return MarkdownTableBlock(
            id: id,
            alignments: alignments + Array(
                repeating: .leading,
                count: max(0, columnCount - alignments.count)
            ),
            rows: rows.map { row in
                MarkdownTableRow(
                    id: row.id,
                    isHeader: row.isHeader,
                    cells: (0..<columnCount).map { row.cells[$0] ?? AttributedString() }
                )
            }
        )
    }
}

enum MarkdownLinkPolicy {
    static func sanitizeLinks(in attributed: inout AttributedString) {
        let links = attributed.runs.compactMap { run -> (Range<AttributedString.Index>, URL)? in
            guard let link = run.link else { return nil }
            return (run.range, link)
        }
        for (range, link) in links {
            attributed[range].link = WorkspaceFileLink.presentationURL(for: link)
        }
    }
}

private final class MarkdownDocumentBox: NSObject {
    let value: MarkdownDocument
    init(_ value: MarkdownDocument) { self.value = value }
}

private final class MarkdownDocumentCache: @unchecked Sendable {
    static let shared = MarkdownDocumentCache()
    private let cache = NSCache<NSString, MarkdownDocumentBox>()

    private init() {
        cache.countLimit = 256
        cache.totalCostLimit = 8 * 1_024 * 1_024
    }

    func document(for source: String) -> MarkdownDocument {
        guard source.utf8.prefix(MarkdownDocument.maximumRichTextBytes + 1).count
                <= MarkdownDocument.maximumRichTextBytes else {
            return MarkdownDocument.parse(source)
        }
        let key = source as NSString
        if let cached = cache.object(forKey: key) { return cached.value }
        let document = MarkdownDocument.parse(source)
        cache.setObject(
            MarkdownDocumentBox(document),
            forKey: key,
            cost: min(source.utf8.count, MarkdownDocument.maximumRichTextBytes)
        )
        return document
    }
}
