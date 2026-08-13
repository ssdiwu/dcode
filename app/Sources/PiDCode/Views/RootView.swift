import AppKit
import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @AppStorage(WorkbenchPreferenceKey.sidebarUserHidden) private var sidebarUserHidden = false
    @AppStorage(WorkbenchPreferenceKey.inspectorUserHidden) private var inspectorUserHidden = false
    @State private var sidebarOverlayPresented = false
    @State private var inspectorOverlayPresented = false
    @State private var projectEditorPresented = false
    @State private var editingProject: DCodeProject?
    @State private var projectEditorAfterCopyDismiss = false
    @State private var searchPreviousResponder: NSResponder?

    var body: some View {
        GeometryReader { proxy in
            let layout = layoutPolicy(width: proxy.size.width)
            workbench(width: proxy.size.width, layout: layout)
                .toolbar { toolbar(layout: layout) }
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
                    .padding(.top, 8)
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
        .sheet(isPresented: Binding(
            get: { model.archivedSessionsPresented },
            set: { model.archivedSessionsPresented = $0 }
        )) {
            ArchivedSessionsSheet()
        }
    }

    @ViewBuilder
    private func workbench(
        width: CGFloat,
        layout: WorkbenchLayoutPolicy
    ) -> some View {
        ZStack {
            centralContent
                .padding(.leading, layout.inlineSidebar ? WorkbenchLayoutPolicy.sidebarWidth : 0)
                .padding(.trailing, layout.inlineInspector ? WorkbenchLayoutPolicy.inspectorWidth : 0)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .allowsHitTesting(!layout.dimsBackground && !model.searchPresented)
                .accessibilityHidden(layout.dimsBackground || model.searchPresented)
                .disabled(model.searchPresented)

            if layout.inlineSidebar {
                HStack(spacing: 0) {
                    sidebar(width: width)
                        .frame(width: WorkbenchLayoutPolicy.sidebarWidth)
                    Divider()
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
                    Divider()
                    WorkInspectorView()
                        .frame(width: WorkbenchLayoutPolicy.inspectorWidth)
                }
                .transition(.move(edge: .trailing))
                .allowsHitTesting(!layout.dimsBackground && !model.searchPresented)
                .accessibilityHidden(layout.dimsBackground || model.searchPresented)
                .disabled(model.searchPresented)
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
                        .frame(width: min(WorkbenchLayoutPolicy.sidebarWidth, width * 0.84))
                        .shadow(color: .black.opacity(0.2), radius: 18, x: 6)
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
                        .frame(width: min(WorkbenchLayoutPolicy.inspectorWidth, width * 0.88))
                        .shadow(color: .black.opacity(0.2), radius: 18, x: -6)
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
                    .padding(.vertical, 24)
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

    private var centralContent: some View {
        Group {
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
        .background(Color(nsColor: .windowBackgroundColor))
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

    @ToolbarContentBuilder
    private func toolbar(layout: WorkbenchLayoutPolicy) -> some ToolbarContent {
        ToolbarItem(placement: .navigation) {
            Button {
                toggleSidebar(layout: layout)
            } label: {
                Image(systemName: "sidebar.left")
            }
            .help(sidebarIsVisible(layout: layout) ? "隐藏左栏" : "显示左栏")
            .accessibilityLabel(sidebarIsVisible(layout: layout) ? "隐藏左栏" : "显示左栏")
            .disabled(model.searchPresented)
            .accessibilityHidden(model.searchPresented)
        }
        ToolbarItem(placement: .primaryAction) {
            Button {
                toggleInspector(layout: layout)
            } label: {
                Image(systemName: "sidebar.right")
            }
            .help(inspectorIsVisible(layout: layout) ? "隐藏工作检查器" : "显示工作检查器")
            .accessibilityLabel(inspectorIsVisible(layout: layout) ? "隐藏工作检查器" : "显示工作检查器")
            .disabled(model.inspectorScope == nil || model.searchPresented)
            .accessibilityHidden(model.searchPresented)
        }
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
        WorkbenchLayoutPolicy(
            width: width,
            sidebarUserHidden: sidebarUserHidden,
            inspectorUserHidden: inspectorUserHidden,
            hasInspectorScope: model.inspectorScope != nil,
            sidebarOverlayRequested: sidebarOverlayPresented,
            inspectorOverlayRequested: inspectorOverlayPresented
        )
    }

    private func sidebarIsVisible(layout: WorkbenchLayoutPolicy) -> Bool {
        layout.inlineSidebar || layout.sidebarOverlay
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
            if !inspectorUserHidden, layout.width < WorkbenchLayoutPolicy.minimumThreeColumnWidth {
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
           width < WorkbenchLayoutPolicy.minimumThreeColumnWidth {
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
