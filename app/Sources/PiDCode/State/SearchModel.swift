import Foundation
import Observation

/// 会话搜索域状态：覆盖层展示、查询词、范围、结果与索引状态。
/// 编排（打开会话、与宿主通信）仍由 `AppModel` 协调。
@MainActor
@Observable
final class SearchModel {
    var presented = false
    var query = ""
    var projectID: UUID?
    var sourceFolderPath: String?
    var indexStatus: SessionSearchIndexStatus = .idle
    var results: [SessionSearchResult] = []
    var selection = 0
    var error: String?
    var openError: String?
    var isQuerying = false

    @ObservationIgnored var task: Task<Void, Never>?
    @ObservationIgnored var probeTask: Task<Void, Never>?
    @ObservationIgnored var generation = UUID()
    @ObservationIgnored var resultGeneration: UUID?

    var hasLiveResults: Bool {
        resultGeneration == generation && !results.isEmpty
    }

    func moveSelection(by offset: Int) {
        guard !results.isEmpty else { return }
        selection = min(max(0, selection + offset), results.count - 1)
    }

    func clearOpenError() {
        openError = nil
    }

    func applyIndexStatus(_ next: SessionSearchIndexStatus) {
        indexStatus = next
    }

    func resetTransientState() {
        task?.cancel()
        task = nil
        probeTask?.cancel()
        probeTask = nil
        isQuerying = false
        generation = UUID()
        resultGeneration = nil
    }
}
