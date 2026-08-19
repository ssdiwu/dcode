import Foundation
import Observation

/// 模型设置域状态：可用模型目录、全局启用设置快照与认证流。
/// 与 Pi Host 的读写由 `AppModel` 协调。
@MainActor
@Observable
final class ModelSettingsState {
    var models: [HostModel] = []
    var isLoadingModels = false
    var modelIssue: String?
    var snapshot: ModelSettingsSnapshot?
    var isLoadingSnapshot = false
    var isMutatingSnapshot = false
    var snapshotError: String?
    var authFlow: ModelAuthFlow?
    private(set) var defaultModel: HostModel?
    private(set) var defaultThinkingLevel: String?
    var thinkingLevels: [String] = []

    @ObservationIgnored var modelLoadGeneration = UUID()
    @ObservationIgnored var snapshotLoadGeneration = UUID()

    func clearSessionDefaults() {
        defaultModel = nil
        defaultThinkingLevel = nil
    }

    func setDefaultModel(_ model: HostModel?) {
        defaultModel = model
    }

    func setDefaultThinkingLevel(_ level: String?) {
        defaultThinkingLevel = level
    }
}
