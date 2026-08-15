import AppKit
import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @AppStorage(WorkbenchPreferenceKey.sidebarUserHidden) private var sidebarUserHidden = false
    @AppStorage(WorkbenchPreferenceKey.inspectorUserHidden) private var inspectorUserHidden = false
    @AppStorage(WorkbenchPreferenceKey.sidebarWidth) private var preferredSidebarWidth = Double(WorkbenchLayoutPolicy.defaultSidebarWidth)
    @AppStorage(WorkbenchPreferenceKey.inspectorWidth) private var preferredInspectorWidth = Double(WorkbenchLayoutPolicy.defaultInspectorWidth)
    @State private var sidebarOverlayPresented = false
    @State private var inspectorOverlayPresented = false
    @State private var projectEditorPresented = false
    @State private var editingProject: DCodeProject?
    @State private var projectEditorAfterCopyDismiss = false
    @State private var searchPreviousResponder: NSResponder?
    @State private var renameSessionPresented = false
    @State private var renameDraft = ""

    var body: some View {
        GeometryReader { proxy in
            let layout = layoutPolicy(width: proxy.size.width)
            let surface = WorkbenchSurfaceLayout(
                destination: model.workbenchDestination,
                layout: layout
            )
            ZStack(alignment: .top) {
                mainWorkspaceBackground(surface: surface)

                workbench(width: proxy.size.width, layout: layout, surface: surface)

                workbenchTopBar(layout: layout, surface: surface)
                    .frame(height: PiDCodeMetrics.windowTopBarHeight)
                    .zIndex(6)
            }
                .ignoresSafeArea(.container, edges: .top)
                .background { DCodeSidebarBackground().ignoresSafeArea() }
                .onChange(of: proxy.size.width) { _, next in
                    normalizeOverlays(for: next)
                }
                .onChange(of: model.selectedSessionID) { _, _ in
                    closeOverlays()
                }
                .onChange(of: model.inspectorScope) { _, scope in
                    guard case .project = scope else { return }
                    inspectorUserHidden = false
                    if proxy.size.width < WorkbenchLayoutPolicy.minimumInlineInspectorWidth {
                        sidebarOverlayPresented = false
                        inspectorOverlayPresented = true
                    } else {
                        closeOverlays()
                    }
                }
                .onChange(of: model.searchPresented) { _, presented in
                    if presented {
                        searchPreviousResponder = NSApp.keyWindow?.firstResponder
                    } else if let responder = searchPreviousResponder {
                        searchPreviousResponder = nil
                        DispatchQueue.main.async {
                            NSApp.keyWindow?.makeFirstResponder(responder)
                        }
                    }
                }
        }
        .overlay(alignment: .top) {
            if let notice = model.notice {
                NoticeBanner(notice: notice)
                    .padding(.top, PiDCodeMetrics.windowTopBarHeight + 8)
                    .transition(reduceMotion ? .opacity : .move(edge: .top).combined(with: .opacity))
            }
        }
        .animation(reduceMotion ? nil : .smooth(duration: 0.2), value: model.notice?.id)
        .alert(
            model.issue?.title ?? "",
            isPresented: Binding(
                get: { model.issue != nil },
                set: { if !$0 { model.issue = nil } }
            ),
            presenting: model.issue
        ) { _ in
            Button("好", role: .cancel) { model.issue = nil }
        } message: { issue in
            Text(issue.message)
        }
        .confirmationDialog(
            "将“\(model.pendingTrashSession?.displayTitle ?? "")”移到废纸篓？",
            isPresented: Binding(
                get: { model.pendingTrashSession != nil },
                set: { if !$0 { model.pendingTrashSession = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("移到废纸篓", role: .destructive) {
                guard let session = model.pendingTrashSession else { return }
                model.pendingTrashSession = nil
                Task { await model.trashSession(session) }
            }
            Button("取消", role: .cancel) { model.pendingTrashSession = nil }
        } message: {
            Text("这只适用于尚无消息的 D Code 会话。会话文件将从 D Code 与 Pi CLI 中移除，但仍可在 Finder 的废纸篓中恢复；对应的未发送草稿也会清除。")
        }
        .sheet(item: dialogBinding) { dialog in
            ExtensionDialogView(dialog: dialog)
                .interactiveDismissDisabled()
        }
        .sheet(isPresented: $projectEditorPresented, onDismiss: { editingProject = nil }) {
            ProjectEditorView(project: editingProject)
        }
        .sheet(isPresented: Binding(
            get: { model.pathSheetPresented },
            set: { model.pathSheetPresented = $0 }
        )) {
            SessionPathSheet()
        }
        .sheet(
            item: Binding(
                get: { model.copySheetMode },
                set: { model.copySheetMode = $0 }
            ),
            onDismiss: presentDeferredProjectEditor
        ) { mode in
            CopySessionSheet(mode: mode, editProject: deferProjectEditorUntilCopyDismiss)
        }
        .sheet(isPresented: $renameSessionPresented) {
            SessionRenameSheet(initialName: renameDraft) { name in
                Task { await model.renameSelectedSession(to: name) }
            }
        }
    }

    @ViewBuilder
    private func workbench(
        width: CGFloat,
        layout: WorkbenchLayoutPolicy,
        surface: WorkbenchSurfaceLayout
    ) -> some View {
        ZStack {
            centralContent(navigationWidth: surface.navigationWidth)
                .padding(.top, PiDCodeMetrics.windowTopBarHeight)
                .padding(.leading, surface.contentLeadingInset)
                .padding(.trailing, layout.inlineInspector ? layout.inspectorWidth : 0)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .allowsHitTesting(!layout.dimsBackground && !model.searchPresented)
                .accessibilityHidden(layout.dimsBackground || model.searchPresented)
                .disabled(model.searchPresented)

            if layout.inlineSidebar {
                HStack(spacing: 0) {
                    sidebar(width: width)
                        .padding(.top, PiDCodeMetrics.windowTopBarHeight)
                        .frame(width: layout.sidebarWidth)
                    Spacer(minLength: 0)
                }
                .transition(.move(edge: .leading))
                .allowsHitTesting(!layout.dimsBackground && !model.searchPresented)
                .accessibilityHidden(layout.dimsBackground || model.searchPresented)
                .disabled(model.searchPresented)
            }

            if layout.inlineInspector {
                HStack(spacing: 0) {
                    Spacer(minLength: 0)
                    WorkInspectorView()
                        .padding(.leading, 8)
                        .padding(.trailing, PiDCodeMetrics.workbenchInset)
                        .padding(.top, PiDCodeMetrics.windowTopBarHeight + PiDCodeMetrics.workbenchInset)
                        .padding(.bottom, PiDCodeMetrics.workbenchInset)
                        .frame(width: layout.inspectorWidth)
                }
                .transition(.move(edge: .trailing))
                .allowsHitTesting(!layout.dimsBackground && !model.searchPresented)
                .accessibilityHidden(layout.dimsBackground || model.searchPresented)
                .disabled(model.searchPresented)
            }

            if surface.canResizeNavigation {
                HStack(spacing: 0) {
                    Color.clear.frame(width: max(0, surface.navigationWidth - 5))
                    WorkbenchResizeHandle(
                        side: .sidebar,
                        width: $preferredSidebarWidth,
                        currentWidth: surface.navigationWidth,
                        maximumAvailableWidth: width
                            - WorkbenchLayoutPolicy.minimumConversationWidth
                            - (layout.inlineInspector ? layout.inspectorWidth : 0)
                    )
                    Spacer(minLength: 0)
                }
                .padding(.top, PiDCodeMetrics.windowTopBarHeight)
                .zIndex(1)
                .allowsHitTesting(!layout.dimsBackground && !model.searchPresented)
                .accessibilityHidden(layout.dimsBackground || model.searchPresented)
            }

            if layout.inlineInspector {
                HStack(spacing: 0) {
                    Spacer(minLength: 0)
                    WorkbenchResizeHandle(
                        side: .inspector,
                        width: $preferredInspectorWidth,
                        currentWidth: layout.inspectorWidth,
                        maximumAvailableWidth: width
                            - WorkbenchLayoutPolicy.minimumConversationWidth
                            - (layout.inlineSidebar ? layout.sidebarWidth : 0)
                    )
                    Color.clear.frame(width: max(0, layout.inspectorWidth - 5))
                }
                .zIndex(1)
                .allowsHitTesting(!layout.dimsBackground && !model.searchPresented)
                .accessibilityHidden(layout.dimsBackground || model.searchPresented)
            }

            if layout.dimsBackground {
                Color.black.opacity(0.18)
                    .ignoresSafeArea()
                    .contentShape(Rectangle())
                    .onTapGesture { closeOverlays() }
                    .accessibilityHidden(true)
                    .transition(.opacity)
                    .zIndex(2)
            }

            if layout.sidebarOverlay {
                HStack(spacing: 0) {
                    sidebar(width: width)
                        .padding(.top, PiDCodeMetrics.windowTopBarHeight)
                        .frame(width: min(layout.sidebarWidth, width * 0.84))
                        .shadow(color: .black.opacity(0.18), radius: 18, x: 6)
                    Spacer(minLength: 0)
                }
                .transition(.move(edge: .leading))
                .zIndex(3)
                .disabled(model.searchPresented)
                .accessibilityHidden(model.searchPresented)
            }

            if layout.inspectorOverlay {
                HStack(spacing: 0) {
                    Spacer(minLength: 0)
                    WorkInspectorView()
                        .padding(.leading, PiDCodeMetrics.workbenchInset)
                        .padding(.trailing, PiDCodeMetrics.workbenchInset)
                        .padding(.top, PiDCodeMetrics.windowTopBarHeight + PiDCodeMetrics.workbenchInset)
                        .padding(.bottom, PiDCodeMetrics.workbenchInset)
                        .frame(width: min(layout.inspectorWidth, width * 0.88))
                }
                .transition(.move(edge: .trailing))
                .zIndex(3)
                .disabled(model.searchPresented)
                .accessibilityHidden(model.searchPresented)
            }

            if model.searchPresented {
                Color.black.opacity(0.24)
                    .ignoresSafeArea()
                    .contentShape(Rectangle())
                    .onTapGesture { model.dismissSearch() }
                    .accessibilityHidden(true)
                    .transition(.opacity)
                    .zIndex(4)

                SearchOverlayView()
                    .padding(.horizontal, 16)
                    .padding(.top, PiDCodeMetrics.windowTopBarHeight + 24)
                    .padding(.bottom, 24)
                    .transition(reduceMotion ? .opacity : .scale(scale: 0.97).combined(with: .opacity))
                    .zIndex(5)
            }
        }
        .animation(reduceMotion ? nil : .smooth(duration: 0.22), value: sidebarUserHidden)
        .animation(reduceMotion ? nil : .smooth(duration: 0.22), value: inspectorUserHidden)
        .animation(reduceMotion ? nil : .smooth(duration: 0.22), value: sidebarOverlayPresented)
        .animation(reduceMotion ? nil : .smooth(duration: 0.22), value: inspectorOverlayPresented)
        .animation(reduceMotion ? nil : .smooth(duration: 0.18), value: model.searchPresented)
    }

    private func centralContent(navigationWidth: CGFloat) -> some View {
        Group {
            if case let .settings(page) = model.workbenchDestination {
                SettingsView(page: page, navigationWidth: navigationWidth)
            } else {
                WorkspaceContentView {
                    if model.inspection != nil {
                        SessionDetailView()
                    } else {
                        UserHomeView(
                            newSession: createGlobalSession,
                            newProject: { presentProjectEditor(nil) },
                            canCreateSession: model.canUseHostSessions
                                && !model.isCreatingSession
                                && !model.isOpeningSession
                                && !model.isStreaming
                                && !model.isPromptTransactionActive,
                            canCreateProject: model.canEditProjects
                        )
                    }
                }
            }
        }
    }

    private func sidebar(width: CGFloat) -> some View {
        SidebarView(
            selectProject: { projectID in
                inspectorUserHidden = false
                sidebarOverlayPresented = false
                if width < WorkbenchLayoutPolicy.minimumInlineInspectorWidth {
                    inspectorOverlayPresented = true
                } else {
                    inspectorOverlayPresented = false
                }
                Task { await model.selectProject(projectID) }
            },
            selectSession: { sessionID in
                closeOverlays()
                Task { await model.selectSession(sessionID) }
            },
            searchSessions: {
                model.presentSearch()
            },
            newGlobalSession: createGlobalSession,
            editProject: presentProjectEditor
        )
    }

    private func mainWorkspaceBackground(surface: WorkbenchSurfaceLayout) -> some View {
        HStack(spacing: 0) {
            Color.clear
                .frame(width: surface.navigationWidth)
            DCodeMainWorkspaceBackground(
                wrappedByNavigation: surface.mainWorkspaceIsWrappedByNavigation
            )
        }
        .ignoresSafeArea()
        .accessibilityHidden(true)
    }

    private func workbenchTopBar(
        layout: WorkbenchLayoutPolicy,
        surface: WorkbenchSurfaceLayout
    ) -> some View {
        let workspaceVisible = model.workbenchDestination == .workspace
        let leadingRailWidth = workspaceVisible
            ? (layout.inlineSidebar
                ? layout.sidebarWidth
                : PiDCodeMetrics.windowControlsReservedWidth
                    + PiDCodeMetrics.toolbarIconTarget * (layout.showsTopBarNewSession ? 2 : 1)
                    + 12)
            : surface.navigationWidth
        let trailingRailWidth = workspaceVisible
            ? (layout.inlineInspector
                ? layout.inspectorWidth
                : PiDCodeMetrics.toolbarIconTarget + 24)
            : 0

        return ZStack {
            WindowDragRegion()
                .accessibilityHidden(true)

            HStack(spacing: 0) {
                HStack(spacing: 0) {
                    Color.clear
                        .frame(width: PiDCodeMetrics.windowControlsReservedWidth)
                        .accessibilityHidden(true)
                    if workspaceVisible {
                        TopBarActionButton(
                            systemName: "sidebar.left",
                            label: layout.sidebarIsVisible ? "隐藏会话栏" : "显示会话栏",
                            disabled: model.searchPresented
                        ) {
                            toggleSidebar(layout: layout)
                        }
                        .accessibilityHidden(model.searchPresented)
                        if layout.showsTopBarNewSession {
                            TopBarActionButton(
                                systemName: "plus.bubble",
                                label: "新建会话",
                                disabled: !model.canUseHostSessions
                                    || model.isCreatingSession
                                    || model.isOpeningSession
                                    || model.isStreaming
                                    || model.isPromptTransactionActive
                                    || model.searchPresented
                            ) {
                                createGlobalSession()
                            }
                            .accessibilityHidden(model.searchPresented)
                        }
                    }
                    Spacer(minLength: 0)
                }
                .frame(width: leadingRailWidth)

                HStack(spacing: 0) {
                    topBarIdentity
                        .allowsHitTesting(!model.searchPresented)
                        .accessibilityHidden(model.searchPresented)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, PiDCodeMetrics.spacingSection)
                .frame(maxWidth: .infinity)

                HStack(spacing: 0) {
                    Spacer(minLength: 0)
                    if workspaceVisible, model.inspectorScope != nil {
                        TopBarActionButton(
                            systemName: "sidebar.right",
                            label: inspectorIsVisible(layout: layout) ? "隐藏信息检查器" : "显示信息检查器",
                            disabled: model.searchPresented
                        ) {
                            toggleInspector(layout: layout)
                        }
                        .accessibilityHidden(model.searchPresented)
                    }
                }
                .padding(.trailing, PiDCodeMetrics.spacingGroup)
                .frame(width: trailingRailWidth)
            }
        }
    }

    @ViewBuilder
    private var topBarIdentity: some View {
        if case .settings = model.workbenchDestination {
            Label("设置", systemImage: "gearshape")
                .font(.headline)
                .lineLimit(1)
        } else if model.workbenchDestination == .workspace, let inspection = model.inspection {
            HStack(spacing: 4) {
                Image(
                    systemName: model.projectOwnership(for: inspection.summary) == nil
                        ? "bubble.left.and.bubble.right"
                        : "folder"
                )
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
                Text(inspection.summary.displayTitle)
                    .font(.headline)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .help(inspection.summary.displayTitle)
                sessionTopBarMenu(inspection)
                if model.isStreaming {
                    ProgressView()
                        .controlSize(.small)
                        .accessibilityLabel("会话运行中")
                }
            }
            .frame(maxWidth: 440, alignment: .leading)
            .accessibilityElement(children: .contain)
        } else if let project = model.selectedProject {
            Label(project.name, systemImage: "folder")
                .font(.headline)
                .lineLimit(1)
        }
    }

    private func sessionTopBarMenu(_ inspection: SessionInspection) -> some View {
        Menu {
            Button("重命名会话…", systemImage: "pencil") {
                renameDraft = inspection.summary.name ?? inspection.summary.displayTitle
                renameSessionPresented = true
            }
            .disabled(!model.canRenameSelectedSession)
            if inspection.summary.name != nil {
                Button("恢复自动名称", systemImage: "arrow.uturn.backward") {
                    Task { await model.renameSelectedSession(to: nil) }
                }
                .disabled(!model.canRenameSelectedSession)
            }
            Button(model.isSessionPinned(inspection.summary.id) ? "取消置顶" : "置顶", systemImage: "pin") {
                Task { await model.togglePinnedSession(inspection.summary) }
            }
            .disabled(!model.canToggleSessionPin(inspection.summary))
            Button("归档会话", systemImage: "archivebox") {
                Task { await model.archiveSession(inspection.summary) }
            }
            .disabled(!model.canArchiveSession(inspection.summary))
            Divider()
            Button("查看会话谱系", systemImage: "arrow.triangle.branch") {
                model.pathSheetPresented = true
            }
            .disabled(model.isOpeningSession || model.isStreaming || model.isPromptTransactionActive)
            if let parentSessionID = inspection.parentSessionId {
                Button(
                    model.archivedSessions.contains(where: { $0.sessionID == parentSessionID })
                        ? "在已归档会话中查看原会话"
                        : "查看原会话",
                    systemImage: "arrow.up.left"
                ) {
                    Task { await model.openLineageSourceSession(parentSessionID) }
                }
                .disabled(model.isOpeningSession || model.isStreaming || model.isPromptTransactionActive)
            }
            Divider()
            Button("复制到项目…", systemImage: "doc.on.doc") { model.copySheetMode = .copy }
            Button("复制到项目并归档原会话…", systemImage: "archivebox") {
                model.copySheetMode = .copyAndArchive
            }
            .disabled(
                model.pendingArchiveRetry != nil
                    || model.archivedSessions.contains(where: { $0.sessionID == model.selectedSessionID })
            )
            if model.canTrashSession(inspection.summary) {
                Divider()
                Button("移到废纸篓…", systemImage: "trash", role: .destructive) {
                    model.requestTrashSession(inspection.summary)
                }
            }
        } label: {
            IconActionGlyph(systemName: "ellipsis")
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .frame(width: PiDCodeMetrics.iconActionTarget, height: PiDCodeMetrics.iconActionTarget)
        .contentShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .accessibilityLabel("会话操作")
        .disabled(
            model.isOpeningSession
                || model.isCopyingSession
                || model.isTrashingSession
                || model.isPromptTransactionActive
        )
    }

    private var dialogBinding: Binding<ExtensionDialog?> {
        Binding(get: { model.activeDialog }, set: { _ in })
    }

    private func presentProjectEditor(_ project: DCodeProject?) {
        editingProject = project
        projectEditorPresented = true
    }

    private func deferProjectEditorUntilCopyDismiss(_ project: DCodeProject?) {
        editingProject = project
        projectEditorAfterCopyDismiss = true
        model.copySheetMode = nil
    }

    private func presentDeferredProjectEditor() {
        guard projectEditorAfterCopyDismiss else { return }
        projectEditorAfterCopyDismiss = false
        projectEditorPresented = true
    }

    private func createGlobalSession() {
        let homeDirectory = FileManager.default.homeDirectoryForCurrentUser
        Task { await model.createSession(at: homeDirectory) }
    }

    private func layoutPolicy(width: CGFloat) -> WorkbenchLayoutPolicy {
        let workspaceVisible = model.workbenchDestination == .workspace
        return WorkbenchLayoutPolicy(
            width: width,
            preferredSidebarWidth: CGFloat(preferredSidebarWidth),
            preferredInspectorWidth: CGFloat(preferredInspectorWidth),
            sidebarUserHidden: sidebarUserHidden || !workspaceVisible,
            inspectorUserHidden: inspectorUserHidden || !workspaceVisible,
            hasInspectorScope: workspaceVisible && model.inspectorScope != nil,
            sidebarOverlayRequested: workspaceVisible && sidebarOverlayPresented,
            inspectorOverlayRequested: workspaceVisible && inspectorOverlayPresented
        )
    }

    private func inspectorIsVisible(layout: WorkbenchLayoutPolicy) -> Bool {
        layout.inlineInspector || layout.inspectorOverlay
    }

    private func toggleSidebar(layout: WorkbenchLayoutPolicy) {
        if layout.sidebarUsesTransientOverlay {
            sidebarOverlayPresented.toggle()
            if sidebarOverlayPresented { inspectorOverlayPresented = false }
        } else {
            sidebarUserHidden.toggle()
        }
    }

    private func toggleInspector(layout: WorkbenchLayoutPolicy) {
        guard model.inspectorScope != nil else { return }
        if layout.width >= WorkbenchLayoutPolicy.minimumInlineInspectorWidth {
            inspectorUserHidden.toggle()
            inspectorOverlayPresented = false
            if !inspectorUserHidden, layout.width < layout.minimumThreeColumnWidth {
                sidebarOverlayPresented = false
            }
        } else {
            inspectorOverlayPresented.toggle()
            if inspectorOverlayPresented { sidebarOverlayPresented = false }
        }
    }

    private func normalizeOverlays(for width: CGFloat) {
        let layout = layoutPolicy(width: width)
        if layout.inlineSidebar { sidebarOverlayPresented = false }
        if layout.inlineInspector { inspectorOverlayPresented = false }
        if width >= WorkbenchLayoutPolicy.minimumInlineInspectorWidth,
           layout.inlineInspector,
           width < layout.minimumThreeColumnWidth {
            sidebarOverlayPresented = false
        }
        if width < WorkbenchLayoutPolicy.minimumInlineInspectorWidth {
            if sidebarOverlayPresented && inspectorOverlayPresented { inspectorOverlayPresented = false }
        }
    }

    private func closeOverlays() {
        sidebarOverlayPresented = false
        inspectorOverlayPresented = false
    }
}

private struct TopBarActionButton: View {
    let systemName: String
    let label: String
    let disabled: Bool
    let action: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var hovered = false

    var body: some View {
        Button(action: action) {
            IconActionGlyph(systemName: systemName)
                .frame(
                    width: PiDCodeMetrics.toolbarIconTarget,
                    height: PiDCodeMetrics.toolbarIconTarget
                )
                .background(
                    hovered ? Color.primary.opacity(0.08) : .clear,
                    in: RoundedRectangle(cornerRadius: 7, style: .continuous)
                )
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .focusable(false)
        .focusEffectDisabled()
        .onHover { next in
            withAnimation(reduceMotion ? nil : .smooth(duration: 0.12)) {
                hovered = next
            }
        }
        .help(label)
        .accessibilityLabel(label)
        .disabled(disabled)
    }
}

private final class WindowDragNSView: NSView {
    override func mouseDown(with event: NSEvent) {
        guard let window else { return }
        guard event.clickCount == 2 else {
            window.performDrag(with: event)
            return
        }

        let preference = UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick")
        switch WindowTitleBarDoubleClickAction.resolve(preference) {
        case .zoom:
            window.performZoom(nil)
        case .minimize:
            window.miniaturize(nil)
        case .none:
            break
        }
    }
}

private struct WindowDragRegion: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView {
        WindowDragNSView()
    }

    func updateNSView(_ nsView: NSView, context: Context) {}
}

private struct WorkbenchResizeHandle: View {
    enum Side {
        case sidebar
        case inspector

        var label: String {
            switch self {
            case .sidebar: "调整会话栏宽度"
            case .inspector: "调整信息检查器宽度"
            }
        }

        var defaultWidth: CGFloat {
            switch self {
            case .sidebar: WorkbenchLayoutPolicy.defaultSidebarWidth
            case .inspector: WorkbenchLayoutPolicy.defaultInspectorWidth
            }
        }
    }

    let side: Side
    @Binding var width: Double
    let currentWidth: CGFloat
    let maximumAvailableWidth: CGFloat

    @State private var dragStartWidth: CGFloat?
    @State private var hovered = false

    var body: some View {
        Rectangle()
            .fill(.clear)
            .frame(width: 10)
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        let start = dragStartWidth ?? currentWidth
                        dragStartWidth = start
                        let proposed: CGFloat
                        switch side {
                        case .sidebar: proposed = start + value.translation.width
                        case .inspector: proposed = start - value.translation.width
                        }
                        width = Double(clamped(proposed))
                    }
                    .onEnded { _ in
                        dragStartWidth = nil
                    }
            )
            .onTapGesture(count: 2) {
                width = Double(clamped(side.defaultWidth))
            }
            .onHover { next in
                hovered = next
                (next ? NSCursor.resizeLeftRight : NSCursor.arrow).set()
            }
            .onDisappear {
                if hovered {
                    NSCursor.arrow.set()
                }
            }
            .focusable()
            .focusEffectDisabled()
            .accessibilityLabel(side.label)
            .accessibilityValue("\(Int(currentWidth.rounded())) 点")
            .accessibilityAdjustableAction { direction in
                switch direction {
                case .increment: width = Double(clamped(currentWidth + 16))
                case .decrement: width = Double(clamped(currentWidth - 16))
                @unknown default: break
                }
            }
            .help("拖动调整宽度；双击恢复默认")
    }

    private func clamped(_ proposed: CGFloat) -> CGFloat {
        let available = max(0, maximumAvailableWidth)
        switch side {
        case .sidebar:
            return min(WorkbenchLayoutPolicy.clampSidebarWidth(proposed), available)
        case .inspector:
            return min(WorkbenchLayoutPolicy.clampInspectorWidth(proposed), available)
        }
    }
}

private struct SessionRenameSheet: View {
    @Environment(\.dismiss) private var dismiss
    @FocusState private var nameFocused: Bool
    @State private var name: String

    let onSave: (String) -> Void

    init(initialName: String, onSave: @escaping (String) -> Void) {
        _name = State(initialValue: initialName)
        self.onSave = onSave
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("重命名会话")
                .font(.title3.weight(.semibold))
            TextField("会话名称", text: $name)
                .textFieldStyle(.roundedBorder)
                .focused($nameFocused)
                .onSubmit(save)
            Text("名称会写入当前 Pi Session（Pi 会话），并同步用于会话栏、搜索和窗口顶栏。")
                .font(.caption)
                .foregroundStyle(.secondary)

            HStack {
                Spacer()
                Button("取消", role: .cancel) { dismiss() }
                    .frame(minHeight: PiDCodeMetrics.compactControlHeight)
                Button("保存", action: save)
                    .keyboardShortcut(.defaultAction)
                    .frame(minHeight: PiDCodeMetrics.compactControlHeight)
                    .disabled(!isValid)
            }
        }
        .padding(20)
        .frame(width: 390)
        .onAppear { nameFocused = true }
    }

    private var normalizedName: String {
        name.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var isValid: Bool {
        !normalizedName.isEmpty
            && normalizedName.utf16.count <= 200
            && !normalizedName.contains("\n")
            && !normalizedName.contains("\r")
    }

    private func save() {
        guard isValid else { return }
        onSave(normalizedName)
        dismiss()
    }
}

private struct NoticeBanner: View {
    let notice: ExtensionNotice
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    var body: some View {
        Label(notice.message, systemImage: icon)
            .font(.callout)
            .foregroundStyle(foreground)
            .padding(.horizontal, 14)
            .padding(.vertical, 9)
            .background(
                reduceTransparency
                    ? AnyShapeStyle(Color(nsColor: .controlBackgroundColor))
                    : AnyShapeStyle(.regularMaterial),
                in: RoundedRectangle(cornerRadius: PiDCodeMetrics.controlRadius)
            )
            .overlay {
                RoundedRectangle(cornerRadius: PiDCodeMetrics.controlRadius)
                    .strokeBorder(foreground.opacity(0.18))
            }
            .shadow(color: .black.opacity(0.1), radius: 12, y: 5)
            .padding(.horizontal)
            .accessibilityAddTraits(.isStaticText)
    }

    private var icon: String {
        switch notice.level {
        case "error": "exclamationmark.triangle.fill"
        case "warning": "exclamationmark.circle.fill"
        default: "info.circle.fill"
        }
    }

    private var foreground: Color {
        switch notice.level {
        case "error": .red
        case "warning": .orange
        default: .accentColor
        }
    }
}
