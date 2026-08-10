import Foundation

struct MermaidSpan: Codable, Sendable, Equatable {
    let text: String
    let cls: String
}

struct MermaidRenderResult: Codable, Sendable, Equatable {
    let rendered: Bool
    let kind: String?
    let width: Int?
    let lines: [String]?
    let styled: [[MermaidSpan]]?
    let warnings: [String]?
    let error: String?

    static func failure(_ message: String) -> MermaidRenderResult {
        MermaidRenderResult(
            rendered: false,
            kind: nil,
            width: nil,
            lines: nil,
            styled: nil,
            warnings: nil,
            error: message
        )
    }
}
