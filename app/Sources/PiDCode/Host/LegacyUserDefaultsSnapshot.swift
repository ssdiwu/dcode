import Foundation

enum LegacyUserDefaultsSnapshot {
    static let keys = [
        "dcode.appearance",
        "dcode.appearance.fontScale",
        "dcode.sidebar.userHidden",
        "dcode.inspector.userHidden",
        "dcode.sidebar.width",
        "dcode.inspector.width",
        "dcode.notifications.completionEnabled",
        "dcode.selfBuildSourceRoot",
        "dcode.selfBuildRestart",
        "dcode.selfBuildRestartKind",
        "dcode.selfBuildPendingSessionId",
        "dcode.selfEvolutionPendingRunId",
    ]

    static func encoded(defaults: UserDefaults = .standard) throws -> String {
        var snapshot: [String: Any] = [:]
        for key in keys {
            if let value = defaults.object(forKey: key) { snapshot[key] = value }
        }
        guard JSONSerialization.isValidJSONObject(snapshot) else {
            throw PiHostClientError.invalidEnvelope("D Code 旧设置包含无法迁移的值；Product Store 尚未启动")
        }
        let data = try JSONSerialization.data(withJSONObject: snapshot, options: [.sortedKeys])
        guard let result = String(data: data, encoding: .utf8) else {
            throw PiHostClientError.invalidEnvelope("D Code 旧设置无法编码为 UTF-8；Product Store 尚未启动")
        }
        return result
    }
}
