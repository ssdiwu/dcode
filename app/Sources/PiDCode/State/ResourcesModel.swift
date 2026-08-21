import Foundation
import Observation

/// 本机资源域状态（ADR 0024 / 0.0.15）：Pi 真实加载的扩展 / Skill / Prompt /
/// 命令快照与扩展包启停。启停只经 Pi 真实配置写与热重载；判定与持久化在 Host 侧。
@MainActor
@Observable
final class ResourcesModel {
    var snapshot: ResourcesListResult?
    var isLoading = false
    var issue: String?
    var isMutating = false

    @ObservationIgnored var mutatingSource: String?

    func isMutating(_ source: String) -> Bool {
        mutatingSource == source
    }
}
