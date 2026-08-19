import Foundation
import Observation

/// 活动域状态：按时间排序的会话视图、当前 Run 状态与注意力（蓝点）记录。
/// 会话列表加载与宿主通信由 `AppModel` 协调。
@MainActor
@Observable
final class ActivityModel {
    var sessions: [SessionSummary] = []
    var isLoadingSessions = false
    var sessionError: String?
    var currentRunState: SessionRunState?
    var attentionRecords: [ActivityAttentionRecord] = []
    var attentionIssue: String?

    @ObservationIgnored var attentionRevision = 0
    @ObservationIgnored var attentionSaveTask: Task<Void, Never>?
}
