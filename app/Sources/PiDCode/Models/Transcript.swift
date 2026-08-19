import Foundation
import ImageIO

enum TranscriptRole: String, Sendable {
    case user
    case assistant
    case tool
    case system
}

struct AssistantUsage: Sendable, Equatable {
    let input: Int?
    let output: Int?
    let cacheRead: Int?
    let cacheWrite: Int?
    let totalTokens: Int?

    static func parse(_ value: JSONValue?) -> AssistantUsage? {
        guard let object = value?.objectValue else { return nil }
        let usage = AssistantUsage(
            input: nonnegativeInt(object["input"]),
            output: nonnegativeInt(object["output"]),
            cacheRead: nonnegativeInt(object["cacheRead"]),
            cacheWrite: nonnegativeInt(object["cacheWrite"]),
            totalTokens: nonnegativeInt(object["totalTokens"])
        )
        return usage.input == nil
            && usage.output == nil
            && usage.cacheRead == nil
            && usage.cacheWrite == nil
            && usage.totalTokens == nil
            ? nil
            : usage
    }

    private static func nonnegativeInt(_ value: JSONValue?) -> Int? {
        guard let value = value?.intValue, value >= 0 else { return nil }
        return value
    }
}

struct ToolCallPresentation: Sendable, Equatable {
    let id: String
    let name: String
    let arguments: String
}

struct ToolResultPresentation: Sendable, Equatable {
    let id: String
    let name: String
    let content: String
    let details: String?
    let isError: Bool
}

struct TranscriptImagePresentation: Sendable, Equatable {
    static let maximumEncodedCharacters = 16 * 1_024 * 1_024
    static let maximumDecodedBytes = 12 * 1_024 * 1_024
    static let maximumPixelDimension = 16_384
    static let maximumPixelCount = 80_000_000

    let data: Data
    let mimeType: String
    let pixelWidth: Int
    let pixelHeight: Int

    static func decode(data encoded: String, mimeType rawMimeType: String) -> TranscriptImagePresentation? {
        let mimeType = rawMimeType.lowercased()
        guard supportedMimeTypes.contains(mimeType),
              !encoded.isEmpty,
              encoded.utf8.count <= maximumEncodedCharacters,
              let data = Data(base64Encoded: encoded),
              !data.isEmpty,
              data.count <= maximumDecodedBytes,
              let source = CGImageSourceCreateWithData(data as CFData, nil),
              CGImageSourceGetCount(source) > 0,
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue,
              let height = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue,
              width > 0,
              height > 0,
              width <= maximumPixelDimension,
              height <= maximumPixelDimension,
              width <= maximumPixelCount / height else {
            return nil
        }
        return TranscriptImagePresentation(
            data: data,
            mimeType: mimeType,
            pixelWidth: width,
            pixelHeight: height
        )
    }

    private static let supportedMimeTypes: Set<String> = [
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/webp",
        "image/tiff",
        "image/heic",
        "image/heif",
        "image/bmp",
    ]
}

enum TranscriptBlock: Identifiable, Sendable, Equatable {
    case text(id: String, value: String)
    case code(id: String, language: String?, source: String)
    case mermaid(id: String, source: String)
    case thinking(id: String, value: String)
    case toolCall(id: String, value: ToolCallPresentation)
    case toolResult(id: String, value: ToolResultPresentation)
    case error(id: String, value: String)
    case image(id: String, value: TranscriptImagePresentation)
    case attachment(id: String, label: String)

    var id: String {
        switch self {
        case let .text(id, _), let .code(id, _, _), let .mermaid(id, _),
             let .thinking(id, _), let .toolCall(id, _), let .toolResult(id, _),
             let .error(id, _), let .image(id, _), let .attachment(id, _):
            id
        }
    }
}

struct TranscriptItem: Identifiable, Sendable, Equatable {
    let id: String
    let role: TranscriptRole
    let timestamp: Date?
    let persistedAt: Date?
    let blocks: [TranscriptBlock]
    let editableText: String?
    let assistantStopReason: String?
    let assistantUsage: AssistantUsage?

    init(
        id: String,
        role: TranscriptRole,
        timestamp: Date?,
        persistedAt: Date? = nil,
        blocks: [TranscriptBlock],
        editableText: String? = nil,
        assistantStopReason: String? = nil,
        assistantUsage: AssistantUsage? = nil
    ) {
        self.id = id
        self.role = role
        self.timestamp = timestamp
        self.persistedAt = persistedAt
        self.blocks = blocks
        self.editableText = editableText
        self.assistantStopReason = assistantStopReason
        self.assistantUsage = assistantUsage
    }

    var plainText: String {
        blocks.compactMap { block in
            switch block {
            case let .text(_, value), let .code(_, _, value), let .thinking(_, value): value
            default: nil
            }
        }.joined(separator: "\n")
    }
}

enum MarkdownPresentation {
    static func attributedString(for value: String) -> AttributedString {
        var attributed = (try? AttributedString(
            markdown: value,
            options: .init(
                interpretedSyntax: .inlineOnlyPreservingWhitespace,
                failurePolicy: .returnPartiallyParsedIfPossible
            )
        )) ?? AttributedString(value)
        MarkdownLinkPolicy.sanitizeLinks(in: &attributed)
        return attributed
    }
}

enum TranscriptParser {
    static func parse(entries: [JSONValue]) -> [TranscriptItem] {
        entries.compactMap(parseEntry)
    }

    private static func parseEntry(_ entry: JSONValue) -> TranscriptItem? {
        guard let object = entry.objectValue,
              object["type"]?.stringValue == "message",
              let id = object["id"]?.stringValue,
              let message = object["message"]?.objectValue,
              let roleName = message["role"]?.stringValue else { return nil }

        let persistedAt = date(from: object["timestamp"])
        let timestamp = date(from: message["timestamp"]) ?? persistedAt
        switch roleName {
        case "user":
            return TranscriptItem(id: id, role: .user, timestamp: timestamp, persistedAt: persistedAt, blocks: contentBlocks(
                message["content"],
                entryID: id,
                includeTools: false
            ), editableText: message["content"]?.stringValue)
        case "assistant":
            var blocks = contentBlocks(message["content"], entryID: id, includeTools: true)
            if let error = message["errorMessage"]?.stringValue, !error.isEmpty {
                blocks.append(.error(id: "\(id)-error", value: error))
            }
            return TranscriptItem(
                id: id,
                role: .assistant,
                timestamp: timestamp,
                persistedAt: persistedAt,
                blocks: blocks,
                assistantStopReason: message["stopReason"]?.stringValue,
                assistantUsage: AssistantUsage.parse(message["usage"])
            )
        case "toolResult":
            let callID = message["toolCallId"]?.stringValue ?? id
            let name = message["toolName"]?.stringValue ?? "Tool"
            let content = text(from: message["content"])
            let details = message["details"].map { $0.prettyPrinted }
            let result = ToolResultPresentation(
                id: callID,
                name: name,
                content: content,
                details: details,
                isError: message["isError"]?.boolValue ?? false
            )
            return TranscriptItem(
                id: id,
                role: .tool,
                timestamp: timestamp,
                persistedAt: persistedAt,
                blocks: [.toolResult(id: "\(id)-result", value: result)]
                    + imageBlocks(message["content"], entryID: id)
            )
        default:
            let blocks = contentBlocks(message["content"], entryID: id, includeTools: false)
            guard !blocks.isEmpty else { return nil }
            return TranscriptItem(id: id, role: .system, timestamp: timestamp, persistedAt: persistedAt, blocks: blocks)
        }
    }

    private static func contentBlocks(
        _ content: JSONValue?,
        entryID: String,
        includeTools: Bool
    ) -> [TranscriptBlock] {
        if let string = content?.stringValue, !string.isEmpty {
            return fencedBlocks(in: string, baseID: "\(entryID)-text-0")
        }
        guard let parts = content?.arrayValue else { return [] }
        var blocks: [TranscriptBlock] = []
        for (index, part) in parts.enumerated() {
            guard let object = part.objectValue, let type = object["type"]?.stringValue else { continue }
            let blockID = "\(entryID)-\(index)"
            switch type {
            case "text":
                guard let value = object["text"]?.stringValue, !value.isEmpty else { continue }
                blocks.append(contentsOf: fencedBlocks(in: value, baseID: blockID))
            case "thinking":
                guard let value = object["thinking"]?.stringValue, !value.isEmpty else { continue }
                blocks.append(.thinking(id: blockID, value: value))
            case "toolCall" where includeTools:
                blocks.append(.toolCall(id: blockID, value: ToolCallPresentation(
                    id: object["id"]?.stringValue ?? blockID,
                    name: object["name"]?.stringValue ?? "Tool",
                    arguments: object["arguments"]?.prettyPrinted ?? "{}"
                )))
            case "image":
                blocks.append(imageBlock(from: object, id: blockID))
            default:
                continue
            }
        }
        return blocks
    }

    private static func imageBlocks(_ content: JSONValue?, entryID: String) -> [TranscriptBlock] {
        guard let parts = content?.arrayValue else { return [] }
        return parts.enumerated().compactMap { index, part in
            guard let object = part.objectValue,
                  object["type"]?.stringValue == "image" else { return nil }
            return imageBlock(from: object, id: "\(entryID)-\(index)")
        }
    }

    private static func imageBlock(from object: [String: JSONValue], id: String) -> TranscriptBlock {
        guard let encoded = object["data"]?.stringValue,
              let mimeType = object["mimeType"]?.stringValue,
              let presentation = TranscriptImagePresentation.decode(data: encoded, mimeType: mimeType) else {
            return .attachment(id: id, label: "无法显示图片")
        }
        return .image(id: id, value: presentation)
    }

    private static func fencedBlocks(in text: String, baseID: String) -> [TranscriptBlock] {
        let lines = text.components(separatedBy: "\n")
        var blocks: [TranscriptBlock] = []
        var plainStart = 0
        var cursor = 0
        var sequence = 0

        func appendPlain(until end: Int) {
            guard plainStart < end else { return }
            let value = lines[plainStart..<end].joined(separator: "\n")
            guard !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
            blocks.append(.text(id: "\(baseID)-plain-\(sequence)", value: value))
            sequence += 1
        }

        while cursor < lines.count {
            let opening = lines[cursor].trimmingCharacters(in: .whitespaces)
            guard opening.hasPrefix("```"), opening.count >= 3 else {
                cursor += 1
                continue
            }
            var closing = cursor + 1
            while closing < lines.count,
                  lines[closing].trimmingCharacters(in: .whitespaces) != "```" {
                closing += 1
            }
            guard closing < lines.count else { break }
            appendPlain(until: cursor)
            let languageText = opening.dropFirst(3).trimmingCharacters(in: .whitespaces)
            let language = languageText.split(whereSeparator: \.isWhitespace).first.map(String.init)
            let source = lines[(cursor + 1)..<closing].joined(separator: "\n")
            if language?.lowercased() == "mermaid" {
                blocks.append(.mermaid(id: "\(baseID)-mermaid-\(sequence)", source: source))
            } else {
                blocks.append(.code(
                    id: "\(baseID)-code-\(sequence)",
                    language: language?.isEmpty == false ? language : nil,
                    source: source
                ))
            }
            sequence += 1
            cursor = closing + 1
            plainStart = cursor
        }
        appendPlain(until: lines.count)
        return blocks.isEmpty ? [.text(id: "\(baseID)-plain-0", value: text)] : blocks
    }

    private static func text(from content: JSONValue?) -> String {
        if let value = content?.stringValue { return value }
        guard let parts = content?.arrayValue else { return "" }
        return parts.compactMap { part in
            guard let object = part.objectValue else { return nil }
            if object["type"]?.stringValue == "text" { return object["text"]?.stringValue }
            return nil
        }.joined(separator: "\n")
    }

    private static func date(from value: JSONValue?) -> Date? {
        if case let .number(milliseconds) = value { return Date(timeIntervalSince1970: milliseconds / 1_000) }
        if let string = value?.stringValue {
            return try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(string)
        }
        return nil
    }
}
