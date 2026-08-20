import Foundation

struct PermissionGrantRecord: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let kind: String
    let root: String
    let pattern: String?
    let createdAt: String
    let createdBySession: String

    var kindLabel: String {
        switch kind {
        case "bashPrefix": "命令前缀"
        case "fileWrite": "文件写入"
        default: "未知类型"
        }
    }

    var displayTarget: String {
        switch kind {
        case "bashPrefix": return "\(root) · \(pattern ?? "")*"
        default: return root
        }
    }
}

struct PermissionAuditEntry: Codable, Identifiable, Equatable, Sendable {
    let at: String
    let sessionId: String
    let tool: String
    let summary: String
    let risk: String
    let decision: String

    var id: String { "\(at)-\(sessionId)-\(tool)-\(summary)" }

    var decisionLabel: String {
        switch decision {
        case "allowOnce": "本次允许"
        case "allowScope": "范围允许"
        case "deny": "拒绝"
        case "autoAllow": "按授权放行"
        case "sessionClosed": "会话关闭"
        default: decision
        }
    }
}

struct PermissionListResult: Codable, Equatable, Sendable {
    let grants: [PermissionGrantRecord]
    let audit: [PermissionAuditEntry]
}

/// 权限请求卡呈现：由 Host 闸门在工具调用挂起时发出。
struct PermissionRequestPresentation: Identifiable, Equatable, Sendable {
    let requestID: String
    let sessionID: String
    let tool: String
    let summary: String
    let targets: [String]
    let risk: String
    let riskLabelText: String
    let scopeHint: String

    var id: String { requestID }

    var isHighRisk: Bool { risk == "fileWriteOutside" || risk == "commandHighRisk" }

    /// 项目外写入与自定义工具不支持范围授权，只提供本次允许 / 拒绝。
    var supportsScopeGrant: Bool { risk == "fileWriteInside" || risk == "command" }
}

enum PermissionRequestParser {
    static func parse(_ data: JSONValue?) -> PermissionRequestPresentation? {
        guard let object = data?.objectValue,
              let requestID = object["requestId"]?.stringValue,
              let sessionID = object["sessionId"]?.stringValue,
              let tool = object["tool"]?.stringValue,
              !tool.isEmpty else { return nil }
        return PermissionRequestPresentation(
            requestID: requestID,
            sessionID: sessionID,
            tool: tool,
            summary: object["summary"]?.stringValue ?? "",
            targets: (object["targets"]?.arrayValue ?? []).compactMap(\.stringValue),
            risk: object["risk"]?.stringValue ?? "otherTool",
            riskLabelText: object["riskLabel"]?.stringValue ?? "其他工具",
            scopeHint: object["scopeHint"]?.stringValue ?? ""
        )
    }
}

struct PermissionGrantList: Codable, Equatable, Sendable {
    let grants: [PermissionGrantRecord]
}
