import SwiftUI

struct SidebarView: View {
    @Environment(AppModel.self) private var model
    let selectProject: (UUID) -> Void
    let selectSession: (String) -> Void
    let searchSessions: () -> Void
    let newGlobalSession: () -> Void
    let editProject: (DCodeProject?) -> Void

    @State private var projectToDelete: DCodeProject?

    var body: some View {
        VStack(spacing: 0) {
            sidebarHeader
            Divider()
            List {
                recentSection
                projectsSection
                archiveSection
            }
            .listStyle(.sidebar)
            .scrollContentBackground(.hidden)
            .background(Color(nsColor: .controlBackgroundColor))
            Divider()
            connectionFooter
        }
        .background(Color(nsColor: .controlBackgroundColor))
        .confirmationDialog(
            "删除“\(projectToDelete?.name ?? "")”？",
            isPresented: Binding(
                get: { projectToDelete != nil },
                set: { if !$0 { projectToDelete = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("删除项目", role: .destructive) {
                guard let project = projectToDelete else { return }
                projectToDelete = nil
                Task {
                    do { try await model.deleteProject(project.id) }
                    catch {
                        model.issue = AppIssue(
                            title: "无法删除项目",
                            message: DiagnosticSanitizer.redact(error.localizedDescription)
                        )
                    }
                }
            }
            Button("取消", role: .cancel) { projectToDelete = nil }
        } message: {
            Text("只删除 D Code 的组织关系，不删除源文件夹、Git 或 Pi 会话。")
        }
    }

    private var sidebarHeader: some View {
        VStack(spacing: 8) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("D Code")
                        .font(.headline)
                    Text(NSUserName())
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button("搜索会话", systemImage: "magnifyingglass", action: searchSessions)
                .labelStyle(.iconOnly)
                .frame(width: PiDCodeMetrics.minimumTarget, height: PiDCodeMetrics.minimumTarget)
                .buttonStyle(.plain)
                .dCodeAccessibleButton("搜索会话")
                .disabled(
                    model.connectionState != .ready
                        || model.isOpeningSession
                        || model.isPromptTransactionActive
                )
                Button("新建会话", systemImage: "square.and.pencil", action: newGlobalSession)
                .labelStyle(.iconOnly)
                .frame(width: PiDCodeMetrics.minimumTarget, height: PiDCodeMetrics.minimumTarget)
                .buttonStyle(.plain)
                .dCodeAccessibleButton("新建会话")
                .accessibilityRepresentation {
                    Button("新建会话", action: newGlobalSession)
                }
                .disabled(
                    model.connectionState != .ready
                        || model.isCreatingSession
                        || model.isOpeningSession
                        || model.isStreaming
                        || model.isPromptTransactionActive
                )
            }
            Button {
                editProject(nil)
            } label: {
                Label("新建项目", systemImage: "folder.badge.plus")
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .frame(minHeight: PiDCodeMetrics.minimumTarget)
            }
            .buttonStyle(.borderless)
            .dCodeAccessibleButton("新建项目")
            .disabled(!model.canEditProjects)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    @ViewBuilder
    private var recentSection: some View {
        Section("最近会话") {
            if model.recentSessions.isEmpty, !model.isLoadingRecentSessions {
                Text("还没有在 D Code 新建的会话")
                    .foregroundStyle(.secondary)
            }
            ForEach(model.recentSessions) { session in
                SessionNavigationItem(
                    session: session,
                    subtitlePrefix: nil,
                    leadingInset: 0,
                    selectionDisabled: model.connectionState != .ready
                        || model.isStreaming
                        || model.isOpeningSession
                        || model.isPromptTransactionActive,
                    select: { selectSession(session.id) }
                )
                .listRowBackground(model.selectedSessionID == session.id ? Color.accentColor.opacity(0.14) : Color.clear)
                .help("\(session.cwd)\n会话 ID：\(session.id)")
            }
            if model.recentHasMore {
                Button("查看更多") {
                    Task { await model.loadMoreRecentSessions() }
                }
                .disabled(model.isLoadingRecentSessions)
            }
        }
    }

    @ViewBuilder
    private var projectsSection: some View {
        Section("项目") {
            ForEach(model.projects) { project in
                ProjectNavigationView(
                    project: project,
                    selectProject: { selectProject(project.id) },
                    selectSession: selectSession,
                    edit: { editProject(project) },
                    delete: { projectToDelete = project }
                )
            }
        }
    }

    private var connectionFooter: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(connectionColor)
                .frame(width: 8, height: 8)
                .accessibilityHidden(true)
            Text(model.connectionState.label)
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer()
            SettingsLink {
                Label("设置", systemImage: "gearshape")
                    .labelStyle(.iconOnly)
                    .frame(width: PiDCodeMetrics.minimumTarget, height: PiDCodeMetrics.minimumTarget)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("打开设置")
            .help("打开设置")
            if model.isLoadingSessions {
                ProgressView().controlSize(.small)
            } else {
                Button {
                    Task { await model.reloadAllSessionLists() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                        .frame(width: PiDCodeMetrics.minimumTarget, height: PiDCodeMetrics.minimumTarget)
                }
                .buttonStyle(.plain)
                .dCodeAccessibleButton("重新载入会话")
                .disabled(model.connectionState != .ready)
            }
        }
        .padding(.horizontal, 12)
        .frame(minHeight: 48)
    }

    private var archiveSection: some View {
        Section {
            Button {
                model.archivedSessionsPresented = true
            } label: {
                Label(
                    model.archivedSessions.isEmpty && model.pendingArchiveRetry == nil
                        ? "已归档会话"
                        : "已归档会话（\(model.archivedSessions.count + (model.pendingArchiveRetry == nil ? 0 : 1))）",
                    systemImage: "archivebox"
                )
                .frame(minHeight: PiDCodeMetrics.minimumTarget)
            }
            .buttonStyle(.plain)
            .dCodeAccessibleButton("查看已归档会话")
        }
    }

    private var connectionColor: Color {
        switch model.connectionState {
        case .ready: .green
        case .connecting: .orange
        case .failed: .red
        case .idle: .secondary
        }
    }
}

private struct ProjectNavigationView: View {
    @Environment(AppModel.self) private var model
    let project: DCodeProject
    let selectProject: () -> Void
    let selectSession: (String) -> Void
    let edit: () -> Void
    let delete: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 2) {
                Button(action: selectProject) {
                    HStack(spacing: 8) {
                        Image(systemName: "folder")
                            .foregroundStyle(.secondary)
                        Text(project.name)
                            .font(.body.weight(.medium))
                            .lineLimit(1)
                        Spacer()
                    }
                    .contentShape(Rectangle())
                    .frame(minHeight: PiDCodeMetrics.minimumTarget)
                }
                .buttonStyle(.plain)
                .dCodeAccessibleButton("打开项目 \(project.name)")
                .contextMenu {
                    Button("编辑项目…", action: edit)
                    Button("删除项目…", role: .destructive, action: delete)
                }

                Menu {
                    if project.sourceFolders.isEmpty {
                        Text("请先添加源文件夹")
                    } else {
                        ForEach(project.sourceFolders) { folder in
                            Button(folder.displayName) {
                                Task { await model.createSession(at: folder.url) }
                            }
                        }
                    }
                } label: {
                    Image(systemName: "plus")
                        .frame(width: PiDCodeMetrics.minimumTarget, height: PiDCodeMetrics.minimumTarget)
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .accessibilityLabel("在 \(project.name) 新建会话")
                .disabled(
                    model.connectionState != .ready
                        || project.sourceFolders.isEmpty
                        || model.isCreatingSession
                        || model.isOpeningSession
                        || model.isStreaming
                        || model.isPromptTransactionActive
                )

                Button {
                    model.toggleProject(project.id)
                } label: {
                    Image(systemName: model.expandedProjectIDs.contains(project.id) ? "chevron.down" : "chevron.right")
                        .frame(width: PiDCodeMetrics.minimumTarget, height: PiDCodeMetrics.minimumTarget)
                }
                .buttonStyle(.plain)
                .dCodeAccessibleButton(
                    model.expandedProjectIDs.contains(project.id) ? "收起项目会话" : "展开项目会话"
                )
            }
            .padding(.horizontal, 2)
            .background(
                model.selectedProjectID == project.id && model.inspectorScope == .project(project.id)
                    ? Color.accentColor.opacity(0.14)
                    : Color.clear,
                in: RoundedRectangle(cornerRadius: 7)
            )

            if model.expandedProjectIDs.contains(project.id) {
                let sessions = model.sessions(for: project)
                if let error = model.projectSessionErrors[project.id] {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("读取会话失败")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.red)
                        Text(error)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                        Button {
                            Task { await model.reloadProjectSessions(project.id) }
                        } label: {
                            Label("重试", systemImage: "arrow.clockwise")
                                .frame(minHeight: PiDCodeMetrics.minimumTarget)
                        }
                        .buttonStyle(.plain)
                        .disabled(model.loadingProjectIDs.contains(project.id))
                    }
                    .padding(.leading, 30)
                    .padding(.trailing, 8)
                    .padding(.vertical, 4)
                } else if sessions.isEmpty, !model.loadingProjectIDs.contains(project.id) {
                    Text(project.sourceFolders.isEmpty ? "尚未添加源文件夹" : "没有关联的旧会话")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(.leading, 30)
                        .padding(.vertical, 4)
                }
                ForEach(sessions) { session in
                    SessionNavigationItem(
                        session: session,
                        subtitlePrefix: "源文件夹：\(model.sourceFolderName(for: session, in: project))",
                        leadingInset: 24,
                        selectionDisabled: model.connectionState != .ready
                            || model.isStreaming
                            || model.isOpeningSession
                            || model.isPromptTransactionActive,
                        select: { selectSession(session.id) }
                    )
                    .listRowBackground(model.selectedSessionID == session.id ? Color.accentColor.opacity(0.14) : Color.clear)
                }
                if model.projectHasMore[project.id] == true {
                    Button("查看更多") {
                        Task { await model.loadMoreProjectSessions(project.id) }
                    }
                    .font(.caption)
                    .padding(.leading, 30)
                    .disabled(model.loadingProjectIDs.contains(project.id))
                }
            }
        }
        .task(id: model.expandedProjectIDs.contains(project.id)) {
            guard model.expandedProjectIDs.contains(project.id), model.projectSessions[project.id] == nil else { return }
            await model.reloadProjectSessions(project.id)
        }
    }
}

private struct SessionNavigationItem: View {
    private enum FocusedControl: Hashable {
        case selection
        case pin
        case archive
    }

    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let session: SessionSummary
    let subtitlePrefix: String?
    let leadingInset: CGFloat
    let selectionDisabled: Bool
    let select: () -> Void

    @State private var hovering = false
    @FocusState private var focusedControl: FocusedControl?

    var body: some View {
        HStack(spacing: 0) {
            Button(action: select) {
                SessionNavigationRow(session: session, subtitlePrefix: subtitlePrefix)
                    .padding(.leading, leadingInset)
            }
            .buttonStyle(.plain)
            .focused($focusedControl, equals: .selection)
            .dCodeAccessibleButton(selectionAccessibilityLabel)
            .disabled(selectionDisabled)

            HStack(spacing: 0) {
                Button {
                    Task { await model.togglePinnedSession(session) }
                } label: {
                    Image(systemName: isPinned ? "pin.fill" : "pin")
                        .frame(
                            width: PiDCodeMetrics.minimumTarget,
                            height: PiDCodeMetrics.minimumTarget,
                            alignment: .top
                        )
                }
                .buttonStyle(IconActionStyle())
                .focused($focusedControl, equals: .pin)
                .opacity(showsActions || isPinned ? 1 : 0)
                .allowsHitTesting(showsActions || isPinned)
                .disabled(!model.canToggleSessionPin(session))
                .dCodeAccessibleButton(pinLabel)
                .help(isPinned ? "取消置顶" : "置顶")

                Button {
                    Task { await model.archiveSession(session) }
                } label: {
                    Image(systemName: "archivebox")
                        .frame(
                            width: PiDCodeMetrics.minimumTarget,
                            height: PiDCodeMetrics.minimumTarget,
                            alignment: .top
                        )
                }
                .buttonStyle(IconActionStyle())
                .focused($focusedControl, equals: .archive)
                .opacity(showsActions ? 1 : 0)
                .allowsHitTesting(showsActions)
                .disabled(!model.canArchiveSession(session))
                .dCodeAccessibleButton("归档 \(session.displayTitle)")
                .accessibilityHint("只从 D Code 普通导航隐藏；Pi 会话与草稿均保留")
                .help("归档会话")
            }
            .frame(width: PiDCodeMetrics.minimumTarget * 2)
        }
        .onHover { hovering = $0 }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: showsActions)
        .contextMenu {
            Button(pinLabel) {
                Task { await model.togglePinnedSession(session) }
            }
            .disabled(!model.canToggleSessionPin(session))

            Button("归档会话") {
                Task { await model.archiveSession(session) }
            }
            .disabled(!model.canArchiveSession(session))

            if model.canTrashSession(session) {
                Divider()
                Button("移到废纸篓…", role: .destructive) {
                    model.requestTrashSession(session)
                }
            }
        }
    }

    private var isPinned: Bool { model.isSessionPinned(session.id) }
    private var showsActions: Bool { hovering || focusedControl != nil }
    private var pinLabel: String {
        "\(isPinned ? "取消置顶" : "置顶") \(session.displayTitle)"
    }
    private var selectionAccessibilityLabel: String {
        if let subtitlePrefix {
            return "\(session.displayTitle)，\(subtitlePrefix)"
        }
        return "\(session.displayTitle)，\(session.messageCount) 条消息"
    }
}

struct SessionNavigationRow: View {
    let session: SessionSummary
    let subtitlePrefix: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(session.displayTitle)
                .font(.body)
                .foregroundStyle(.primary)
                .lineLimit(1)
            HStack(spacing: 4) {
                if let subtitlePrefix { Text(subtitlePrefix) }
                else { Text("\(session.messageCount) 条消息") }
                if let date = session.modifiedDate {
                    Text("·")
                    Text(date.piDCodeRelativeLabel)
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}
