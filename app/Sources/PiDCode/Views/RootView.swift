import AppKit
import SwiftUI

struct RootView: View {
    private let sidebarWidth: CGFloat = 286
    private let inspectorWidth: CGFloat = 340

    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @AppStorage(WorkbenchPreferenceKey.sidebarUserHidden) private var sidebarUserHidden = false
    @AppStorage(WorkbenchPreferenceKey.inspectorUserHidden) private var inspectorUserHidden = false
    @State private var sidebarOverlayPresented = false
    @State private var inspectorOverlayPresented = false
    @State private var projectEditorPresented = false
    @State private var editingProject: DCodeProject?
    @State private var searchPreviousResponder: NSResponder?

    var body: some View {
        GeometryReader { proxy in
            let widthClass = WorkbenchWidthClass.classify(proxy.size.width)
            workbench(width: proxy.size.width, widthClass: widthClass)
                .toolbar { toolbar(widthClass: widthClass) }
                .onChange(of: widthClass) { _, next in
                    normalizeOverlays(for: next)
                }
                .onChange(of: model.selectedSessionID) { _, _ in
                    closeOverlays()
                }
                .onChange(of: model.inspectorScope) { _, scope in
                    guard case .project = scope else { return }
                    inspectorUserHidden = false
                    if widthClass != .wide {
                        sidebarOverlayPresented = false
                        inspectorOverlayPresented = true
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
        .sheet(item: dialogBinding) { dialog in
            ExtensionDialogView(dialog: dialog)
                .interactiveDismissDisabled()
        }
        .sheet(isPresented: $projectEditorPresented, onDismiss: { editingProject = nil }) {
            ProjectEditorView(project: editingProject)
        }
    }

    @ViewBuilder
    private func workbench(width: CGFloat, widthClass: WorkbenchWidthClass) -> some View {
        let inlineSidebar = widthClass != .compact && !sidebarUserHidden
        let inlineInspector = widthClass == .wide
            && !inspectorUserHidden
            && model.inspectorScope != nil

        ZStack {
            centralContent
                .padding(.leading, inlineSidebar ? sidebarWidth : 0)
                .padding(.trailing, inlineInspector ? inspectorWidth : 0)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .allowsHitTesting(!overlayIsPresented)
                .accessibilityHidden(overlayIsPresented)
                .disabled(model.searchPresented)

            if inlineSidebar {
                HStack(spacing: 0) {
                    sidebar(widthClass: widthClass)
                        .frame(width: sidebarWidth)
                    Divider()
                    Spacer(minLength: 0)
                }
                .transition(.move(edge: .leading))
                .allowsHitTesting(!inspectorOverlayPresented && !model.searchPresented)
                .accessibilityHidden(inspectorOverlayPresented || model.searchPresented)
                .disabled(model.searchPresented)
            }

            if inlineInspector {
                HStack(spacing: 0) {
                    Spacer(minLength: 0)
                    Divider()
                    WorkInspectorView()
                        .frame(width: inspectorWidth)
                }
                .transition(.move(edge: .trailing))
                .allowsHitTesting(!model.searchPresented)
                .accessibilityHidden(model.searchPresented)
                .disabled(model.searchPresented)
            }

            if sidebarOverlayPresented || inspectorOverlayPresented {
                Color.black.opacity(0.18)
                    .ignoresSafeArea()
                    .contentShape(Rectangle())
                    .onTapGesture { closeOverlays() }
                    .accessibilityHidden(true)
                    .transition(.opacity)
                    .zIndex(2)
            }

            if sidebarOverlayPresented {
                HStack(spacing: 0) {
                    sidebar(widthClass: widthClass)
                        .frame(width: min(sidebarWidth, width * 0.84))
                        .shadow(color: .black.opacity(0.2), radius: 18, x: 6)
                    Spacer(minLength: 0)
                }
                .transition(.move(edge: .leading))
                .zIndex(3)
                .disabled(model.searchPresented)
                .accessibilityHidden(model.searchPresented)
            }

            if inspectorOverlayPresented, model.inspectorScope != nil {
                HStack(spacing: 0) {
                    Spacer(minLength: 0)
                    WorkInspectorView()
                        .frame(width: min(inspectorWidth, width * 0.88))
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
                    canCreateSession: model.canUseHostSessions && !model.isOpeningSession && !model.isStreaming,
                    canCreateProject: model.canEditProjects
                )
            }
        }
        .background(Color(nsColor: .windowBackgroundColor))
    }

    private func sidebar(widthClass: WorkbenchWidthClass) -> some View {
        SidebarView(
            selectProject: { projectID in
                if widthClass == .compact { sidebarOverlayPresented = false }
                inspectorUserHidden = false
                if widthClass != .wide { inspectorOverlayPresented = true }
                Task { await model.selectProject(projectID) }
            },
            selectSession: { sessionID in
                if widthClass == .compact { sidebarOverlayPresented = false }
                inspectorOverlayPresented = false
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
    private func toolbar(widthClass: WorkbenchWidthClass) -> some ToolbarContent {
        ToolbarItem(placement: .navigation) {
            Button {
                toggleSidebar(for: widthClass)
            } label: {
                Image(systemName: "sidebar.left")
            }
            .help(sidebarIsVisible(for: widthClass) ? "隐藏左栏" : "显示左栏")
            .accessibilityLabel(sidebarIsVisible(for: widthClass) ? "隐藏左栏" : "显示左栏")
            .disabled(model.searchPresented)
            .accessibilityHidden(model.searchPresented)
        }
        ToolbarItem(placement: .primaryAction) {
            Button {
                toggleInspector(for: widthClass)
            } label: {
                Image(systemName: "sidebar.right")
            }
            .help(inspectorIsVisible(for: widthClass) ? "隐藏工作检查器" : "显示工作检查器")
            .accessibilityLabel(inspectorIsVisible(for: widthClass) ? "隐藏工作检查器" : "显示工作检查器")
            .disabled(model.inspectorScope == nil || model.searchPresented)
            .accessibilityHidden(model.searchPresented)
        }
    }

    private var dialogBinding: Binding<ExtensionDialog?> {
        Binding(get: { model.activeDialog }, set: { _ in })
    }

    private var overlayIsPresented: Bool {
        sidebarOverlayPresented || inspectorOverlayPresented || model.searchPresented
    }

    private func presentProjectEditor(_ project: DCodeProject?) {
        editingProject = project
        projectEditorPresented = true
    }

    private func createGlobalSession() {
        let homeDirectory = FileManager.default.homeDirectoryForCurrentUser
        Task { await model.createSession(at: homeDirectory) }
    }

    private func sidebarIsVisible(for widthClass: WorkbenchWidthClass) -> Bool {
        widthClass == .compact ? sidebarOverlayPresented : !sidebarUserHidden
    }

    private func inspectorIsVisible(for widthClass: WorkbenchWidthClass) -> Bool {
        if widthClass == .wide { return !inspectorUserHidden && model.inspectorScope != nil }
        return inspectorOverlayPresented && model.inspectorScope != nil
    }

    private func toggleSidebar(for widthClass: WorkbenchWidthClass) {
        if widthClass == .compact {
            sidebarOverlayPresented.toggle()
            if sidebarOverlayPresented { inspectorOverlayPresented = false }
        } else {
            sidebarUserHidden.toggle()
        }
    }

    private func toggleInspector(for widthClass: WorkbenchWidthClass) {
        guard model.inspectorScope != nil else { return }
        if widthClass == .wide {
            inspectorUserHidden.toggle()
        } else {
            inspectorOverlayPresented.toggle()
            if inspectorOverlayPresented, widthClass == .compact { sidebarOverlayPresented = false }
        }
    }

    private func normalizeOverlays(for widthClass: WorkbenchWidthClass) {
        switch widthClass {
        case .wide:
            closeOverlays()
        case .medium:
            sidebarOverlayPresented = false
        case .compact:
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
