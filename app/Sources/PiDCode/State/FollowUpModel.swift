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

    /// 当前唯一尚未返回的 `session.steer` RPC；仅用于短暂锁定本次提交。
    var steerSubmissionInFlight: SteerSubmission?
    /// Host/Pi 已接受但尚未取得应用证据的介入，按提交顺序保留。
    var acceptedSteerReceipts: [SteerSubmission] = []
    /// Pi 最近一次 `queue_update` 的完整 steering 队列快照。
    var steeringQueueMessages: [String] = []
    var steeringQueueSessionID: String?
    var steeringQueueRunID: String?
    var steeringQueueRevision = 0

    @ObservationIgnored var queueRevision = 0
}
