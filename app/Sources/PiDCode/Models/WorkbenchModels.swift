import CoreGraphics
import Foundation

enum InspectorScope: Equatable, Sendable {
    case session(String)
    case project(UUID)
}

enum SettingsPage: String, CaseIterable, Equatable, Sendable {
    case models
    case appearance
    case workbench
    case archivedSessions
    case permissions
    case selfBuild
    case about
}

enum WorkbenchDestination: Equatable, Sendable {
    case workspace
    case settings(SettingsPage)
}

/// Maps every top-level page onto the same persisted left/right rail geometry.
/// Pages choose their content, but cannot invent their own panel widths.
struct WorkbenchSurfaceLayout: Equatable, Sendable {
    let navigationWidth: CGFloat
    let contentLeadingInset: CGFloat
    let canResizeNavigation: Bool

    init(destination: WorkbenchDestination, layout: WorkbenchLayoutPolicy) {
        switch destination {
        case .workspace:
            navigationWidth = layout.inlineSidebar ? layout.sidebarWidth : 0
            contentLeadingInset = navigationWidth
            canResizeNavigation = layout.inlineSidebar
        case .settings:
            navigationWidth = layout.sidebarWidth
            contentLeadingInset = 0
            canResizeNavigation = true
        }
    }

    var mainWorkspaceIsWrappedByNavigation: Bool {
        navigationWidth > 0
    }
}

enum WindowTitleBarDoubleClickAction: Equatable, Sendable {
    case zoom
    case minimize
    case none

    static func resolve(_ rawValue: String?) -> WindowTitleBarDoubleClickAction {
        switch rawValue?.lowercased() {
        case "minimize": .minimize
        case "none": .none
        default: .zoom
        }
    }
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
    static let defaultSidebarWidth: CGFloat = 400
    static let minimumSidebarWidth: CGFloat = 280
    static let maximumSidebarWidth: CGFloat = 520
    static let defaultInspectorWidth: CGFloat = 400
    static let minimumInspectorWidth: CGFloat = 400
    static let maximumInspectorWidth: CGFloat = 520
    static let minimumConversationWidth: CGFloat = 480
    static let minimumInlineInspectorWidth: CGFloat = 880

    let width: CGFloat
    let sidebarWidth: CGFloat
    let inspectorWidth: CGFloat
    let sidebarUserHidden: Bool
    let inspectorUserHidden: Bool
    let hasInspectorScope: Bool
    let sidebarOverlayRequested: Bool
    let inspectorOverlayRequested: Bool

    init(
        width: CGFloat,
        preferredSidebarWidth: CGFloat = Self.defaultSidebarWidth,
        preferredInspectorWidth: CGFloat = Self.defaultInspectorWidth,
        sidebarUserHidden: Bool,
        inspectorUserHidden: Bool,
        hasInspectorScope: Bool,
        sidebarOverlayRequested: Bool,
        inspectorOverlayRequested: Bool
    ) {
        self.width = width
        sidebarWidth = Self.clampSidebarWidth(preferredSidebarWidth)
        let preferredInspector = Self.clampInspectorWidth(preferredInspectorWidth)
        inspectorWidth = min(
            preferredInspector,
            max(Self.minimumInspectorWidth, width - Self.minimumConversationWidth)
        )
        self.sidebarUserHidden = sidebarUserHidden
        self.inspectorUserHidden = inspectorUserHidden
        self.hasInspectorScope = hasInspectorScope
        self.sidebarOverlayRequested = sidebarOverlayRequested
        self.inspectorOverlayRequested = inspectorOverlayRequested
    }

    var minimumThreeColumnWidth: CGFloat {
        sidebarWidth + Self.minimumConversationWidth + inspectorWidth
    }

    static func clampSidebarWidth(_ width: CGFloat) -> CGFloat {
        min(max(width, minimumSidebarWidth), maximumSidebarWidth)
    }

    static func clampInspectorWidth(_ width: CGFloat) -> CGFloat {
        min(max(width, minimumInspectorWidth), maximumInspectorWidth)
    }

    var inlineInspector: Bool {
        width >= Self.minimumInlineInspectorWidth
            && hasInspectorScope
            && !inspectorUserHidden
    }

    var sidebarUsesTransientOverlay: Bool {
        width < Self.minimumInlineInspectorWidth
            || (inlineInspector && width < minimumThreeColumnWidth)
    }

    var inlineSidebar: Bool {
        !sidebarUserHidden && !sidebarUsesTransientOverlay
    }

    var sidebarOverlay: Bool {
        sidebarOverlayRequested && !inlineSidebar
    }

    var sidebarIsVisible: Bool {
        inlineSidebar || sidebarOverlay
    }

    var showsTopBarNewSession: Bool {
        !sidebarIsVisible
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
                - (inlineSidebar ? sidebarWidth : 0)
                - (inlineInspector ? inspectorWidth : 0)
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
