import Foundation
import Observation

/// 动作级权限域状态：挂起的权限请求卡、授权表与审计记录。
/// 闸门判定与持久化在 Host 侧；本模型只承接呈现与回传。
@MainActor
@Observable
final class PermissionModel {
    var pendingRequest: PermissionRequestPresentation?
    var grants: [PermissionGrantRecord] = []
    var audit: [PermissionAuditEntry] = []
    var isLoading = false
    var issue: String?

    @ObservationIgnored var isResponding = false

    func clearRequest(_ requestID: String) {
        if pendingRequest?.requestID == requestID { pendingRequest = nil }
    }
}
