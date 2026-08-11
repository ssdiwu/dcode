import CoreGraphics
import Foundation

enum InspectorScope: Equatable, Sendable {
    case session(String)
    case project(UUID)
}

enum WorkbenchWidthClass: Equatable, Sendable {
    case wide
    case medium
    case compact

    static func classify(_ width: CGFloat) -> WorkbenchWidthClass {
        if width >= 1_280 { return .wide }
        if width >= 880 { return .medium }
        return .compact
    }
}

struct SessionListWindow: Equatable, Sendable {
    static let batchSize = 10

    private(set) var visibleLimit = batchSize

    var requestLimit: Int { visibleLimit + 1 }

    mutating func loadMore() {
        visibleLimit += Self.batchSize
    }

    mutating func reset() {
        visibleLimit = Self.batchSize
    }

    func page(from sessions: [SessionSummary]) -> (items: [SessionSummary], hasMore: Bool) {
        (Array(sessions.prefix(visibleLimit)), sessions.count > visibleLimit)
    }
}
