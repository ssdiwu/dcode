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

struct WorkbenchLayoutPolicy: Equatable, Sendable {
    static let sidebarWidth: CGFloat = 286
    static let inspectorWidth: CGFloat = 340
    static let minimumConversationWidth: CGFloat = 480
    static let minimumInlineInspectorWidth: CGFloat = 880
    static let minimumThreeColumnWidth = sidebarWidth + minimumConversationWidth + inspectorWidth

    let width: CGFloat
    let sidebarUserHidden: Bool
    let inspectorUserHidden: Bool
    let hasInspectorScope: Bool
    let sidebarOverlayRequested: Bool
    let inspectorOverlayRequested: Bool

    var inlineInspector: Bool {
        width >= Self.minimumInlineInspectorWidth
            && hasInspectorScope
            && !inspectorUserHidden
    }

    var sidebarUsesTransientOverlay: Bool {
        width < Self.minimumInlineInspectorWidth
            || (inlineInspector && width < Self.minimumThreeColumnWidth)
    }

    var inlineSidebar: Bool {
        !sidebarUserHidden && !sidebarUsesTransientOverlay
    }

    var sidebarOverlay: Bool {
        sidebarOverlayRequested && !inlineSidebar
    }

    var inspectorOverlay: Bool {
        inspectorOverlayRequested && !inlineInspector && hasInspectorScope
    }

    var dimsBackground: Bool {
        sidebarOverlay || inspectorOverlay
    }

    var conversationWidth: CGFloat {
        max(
            0,
            width
                - (inlineSidebar ? Self.sidebarWidth : 0)
                - (inlineInspector ? Self.inspectorWidth : 0)
        )
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
