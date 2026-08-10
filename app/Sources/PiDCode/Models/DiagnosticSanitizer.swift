import Foundation

enum DiagnosticSanitizer {
    static func redact(_ input: String, limit: Int = 4_096) -> String {
        var output = input.count > limit ? String(input.prefix(limit)) + "…" : input
        let replacements: [(pattern: String, template: String)] = [
            (#"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+"#, "Bearer [REDACTED]"),
            (#"\bsk-[A-Za-z0-9_-]{8,}"#, "[REDACTED]"),
            (#"(?i)(api[_-]?key|access[_-]?token|refresh[_-]?token|oauth[_-]?token|authorization|password|secret)([\"']?\s*[:=]\s*[\"']?)([^\"',\s}]+)"#, "$1$2[REDACTED]"),
        ]
        for replacement in replacements {
            guard let expression = try? NSRegularExpression(pattern: replacement.pattern) else { continue }
            let range = NSRange(output.startIndex..<output.endIndex, in: output)
            output = expression.stringByReplacingMatches(
                in: output,
                range: range,
                withTemplate: replacement.template
            )
        }
        return output
    }
}
