import Foundation
import Observation

/// 后续消息队列域状态：队列记录、派发中的待介入草稿与变更进行时标记。
/// 队列结算与派发时序由 `AppModel` 协调。
@MainActor
@Observable
final class FollowUpModel {
    var queues: [FollowUpQueueRecord] = []
    var queueIssue: String?
    var isMutatingQueue = false
    var pendingSteer: PendingSteerDraft?

    @ObservationIgnored var queueRevision = 0
}
