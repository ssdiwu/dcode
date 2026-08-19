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
            List {
                if model.sidebarProjection == .activity {
                    activityList
                } else {
                    pinnedSection
                    recentSection
                    projectsSection
                }
            }
            .listStyle(.sidebar)
            .scrollContentBackground(.hidden)
            .background(Color.clear)
            connectionFooter
        }
        .dCodeSidebarSurface()
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
                Button(action: searchSessions) {
                    IconActionGlyph(systemName: "magnifyingglass")
                }
                .buttonStyle(IconActionStyle())
                .dCodeAccessibleButton("搜索会话")
                .disabled(
                    model.connectionState != .ready
                        || model.isOpeningSession
                        || model.isPromptTransactionActive
                )
                Button {
                    Task { await model.toggleSidebarProjection() }
                } label: {
                    ZStack(alignment: .topTrailing) {
                        IconActionGlyph(
                            systemName: model.sidebarProjection == .activity ? "bell.fill" : "bell"
                        )
                            .foregroundStyle(
                                model.sidebarProjection == .activity ? Color.accentColor : Color.primary
                            )
                        if model.hasUnseenActivity && model.sidebarProjection != .activity {
                            Circle()
                                .fill(Color.accentColor)
                                .frame(width: 7, height: 7)
                                .offset(x: -2, y: 2)
                                .accessibilityHidden(true)
                        }
                    }
                }
                .buttonStyle(IconActionStyle())
                .dCodeAccessibleButton(
                    model.sidebarProjection == .activity ? "返回会话导航" : "查看活动"
                )
                .accessibilityValue(
                    model.sidebarProjection.bellAccessibilityValue(
                        hasUnseenActivity: model.hasUnseenActivity
                    )
                )
                .accessibilityAddTraits(model.sidebarProjection == .activity ? .isSelected : [])
                .accessibilityIdentifier("sidebar.activity-toggle")
                .help(model.sidebarProjection == .activity ? "返回默认会话导航" : "查看正在运行和最近完成")
                .disabled(model.connectionState != .ready || model.isOpeningSession)
                Button(action: newGlobalSession) {
                    IconActionGlyph(systemName: "plus.bubble")
                }
                .buttonStyle(IconActionStyle())
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
            .frame(height: PiDCodeMetrics.navigationRowHeight)
            Button {
                editProject(nil)
            } label: {
                Label("新建项目", systemImage: "folder.badge.plus")
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .frame(height: PiDCodeMetrics.navigationRowHeight)
            }
            .buttonStyle(.borderless)
            .dCodeAccessibleButton("新建项目")
            .disabled(!model.canEditProjects)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, PiDCodeMetrics.spacingStandard)
    }

    @ViewBuilder
    private var activityList: some View {
        if let attentionIssue = model.activity.attentionIssue {
            Section {
                Label(attentionIssue, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(.orange)
            }
        }
        if let sessionError = model.activity.sessionError {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    Label("活动列表未完整载入", systemImage: "exclamationmark.triangle")
                        .font(.caption.weight(.semibold))
                    Text(sessionError)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                    Button("重试") {
                        Task { await model.reloadActivitySessions() }
                    }
                    .buttonStyle(.borderless)
                }
            }
        }
        ForEach(model.activitySections) { section in
            Section(section.title) {
                ForEach(section.sessions) { presentation in
                    ActivitySessionNavigationItem(
                        presentation: presentation,
                        selectionDisabled: model.connectionState != .ready || model.isOpeningSession,
                        select: { selectSession(presentation.id) }
                    )
                }
            }
        }
        if model.activitySections.isEmpty && !model.activity.isLoadingSessions {
            Section("活动") {
                Text("还没有可显示的会话活动")
                    .foregroundStyle(.secondary)
            }
        }
        if model.activity.isLoadingSessions {
            Section {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("正在载入活动…")
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    @ViewBuilder
    private var pinnedSection: some View {
        if !model.pinnedSessionPresentations.isEmpty {
            Section("置顶") {
                ForEach(model.pinnedSessionPresentations) { presentation in
                    SessionNavigationItem(
                        session: presentation.summary,
                        leadingInset: 0,
                        selectionDisabled: sessionSelectionDisabled,
                        select: { selectSession(presentation.id) }
                    )
                }
            }
        }
    }

    @ViewBuilder
    private var recentSection: some View {
        Section("最近会话") {
            if model.recentSessions.isEmpty,
               !model.isLoadingRecentSessions,
               !model.pinnedSessionPresentations.contains(where: \.isRecent) {
                Text("还没有在 D Code 新建的会话")
                    .foregroundStyle(.secondary)
            }
            ForEach(model.recentSessions) { session in
                SessionNavigationItem(
                    session: session,
                    leadingInset: 0,
                    selectionDisabled: sessionSelectionDisabled,
                    select: { selectSession(session.id) }
                )
            }
            if model.recentHasMore {
                Button("查看更多") {
                    Task { await model.loadMoreRecentSessions() }
                }
                .disabled(model.isLoadingRecentSessions)
            }
        }
    }

    private var sessionSelectionDisabled: Bool {
        model.connectionState != .ready
            || model.isStreaming
            || model.isOpeningSession
            || model.isPromptTransactionActive
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
            if let status = model.connectionState.sidebarLabel {
                Circle()
                    .fill(connectionColor)
                    .frame(width: 8, height: 8)
                    .accessibilityHidden(true)
                Text(status)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button {
                model.presentSettings()
            } label: {
                IconActionGlyph(systemName: "gearshape")
            }
            .buttonStyle(IconActionStyle())
            .accessibilityLabel("打开设置")
            .help("打开设置")
            if model.isLoadingSessions {
                ProgressView().controlSize(.small)
            } else {
                Button {
                    Task { await model.reloadAllSessionLists() }
                } label: {
                    IconActionGlyph(systemName: "arrow.clockwise")
                }
                .buttonStyle(IconActionStyle())
                .dCodeAccessibleButton("重新载入会话")
                .disabled(model.connectionState != .ready)
            }
        }
        .padding(.horizontal, 12)
        .frame(height: PiDCodeMetrics.navigationRowHeight)
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
                    .frame(height: PiDCodeMetrics.navigationRowHeight)
                }
                .buttonStyle(.plain)
                .dCodeAccessibleButton("打开项目 \(project.name)")
                .contextMenu {
                    Button("编辑项目…", action: edit)
                    Button("删除项目…", role: .destructive, action: delete)
                }

                sessionCreationControl

                Button {
                    model.toggleProject(project.id)
                } label: {
                    IconActionGlyph(
                        systemName: model.expandedProjectIDs.contains(project.id) ? "chevron.down" : "chevron.right"
                    )
                }
                .buttonStyle(IconActionStyle())
                .dCodeAccessibleButton(
                    model.expandedProjectIDs.contains(project.id) ? "收起项目会话" : "展开项目会话"
                )
            }
            .frame(height: PiDCodeMetrics.navigationRowHeight)
            .padding(.horizontal, 2)
            .background(
                model.selectedProjectID == project.id && model.inspectorScope == .project(project.id)
                    ? Color.accentColor.opacity(0.14)
                    : Color.clear,
                in: RoundedRectangle(cornerRadius: 7)
            )

            if model.expandedProjectIDs.contains(project.id) {
                let sessions = model.sessions(for: project)
                let hasPinnedSessions = model.pinnedSessionPresentations.contains { presentation in
                    presentation.projectIDs.contains(project.id)
                }
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
                                .frame(minHeight: PiDCodeMetrics.compactControlHeight)
                        }
                        .buttonStyle(.plain)
                        .disabled(model.loadingProjectIDs.contains(project.id))
                    }
                    .padding(.leading, 30)
                    .padding(.trailing, 8)
                    .padding(.vertical, 4)
                } else if sessions.isEmpty,
                          !hasPinnedSessions,
                          !model.loadingProjectIDs.contains(project.id) {
                    Text(project.sourceFolders.isEmpty ? "尚未添加源文件夹" : "没有关联的旧会话")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(.leading, 30)
                        .padding(.vertical, 4)
                }
                ForEach(sessions) { session in
                    SessionNavigationItem(
                        session: session,
                        leadingInset: 24,
                        selectionDisabled: model.connectionState != .ready
                            || model.isStreaming
                            || model.isOpeningSession
                            || model.isPromptTransactionActive,
                        select: { selectSession(session.id) }
                    )
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

    private var sessionCreationDisabled: Bool {
        model.connectionState != .ready
            || model.isCreatingSession
            || model.isOpeningSession
            || model.isStreaming
            || model.isPromptTransactionActive
    }

    @ViewBuilder
    private var sessionCreationControl: some View {
        switch ProjectSessionCreationRoute.resolve(for: project) {
        case .unavailable:
            Button {} label: {
                IconActionGlyph(systemName: "plus")
            }
            .buttonStyle(IconActionStyle())
            .disabled(true)
            .dCodeAccessibleButton("在 \(project.name) 新建会话")
            .help("请先为项目添加源文件夹")

        case let .direct(folder):
            Button {
                Task { await model.createSession(at: folder.url) }
            } label: {
                IconActionGlyph(systemName: "plus")
            }
            .buttonStyle(IconActionStyle())
            .disabled(sessionCreationDisabled)
            .dCodeAccessibleButton("在 \(project.name) 新建会话")
            .help("在 \(folder.displayName) 新建会话")

        case let .choose(folders):
            Menu {
                ForEach(folders) { folder in
                    Button(folder.displayName) {
                        Task { await model.createSession(at: folder.url) }
                    }
                }
            } label: {
                IconActionGlyph(systemName: "plus")
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .frame(width: PiDCodeMetrics.iconActionTarget, height: PiDCodeMetrics.iconActionTarget)
            .accessibilityLabel("在 \(project.name) 新建会话")
            .disabled(sessionCreationDisabled)
        }
    }
}

private struct ActivitySessionNavigationItem: View {
    @Environment(AppModel.self) private var model
    let presentation: ActivitySessionPresentation
    let selectionDisabled: Bool
    let select: () -> Void

    var body: some View {
        Button(action: select) {
            HStack(spacing: 9) {
                Image(systemName: iconName)
                    .foregroundStyle(statusColor)
                    .frame(width: 18)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(presentation.summary.displayTitle)
                        .font(.body.weight(.medium))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    HStack(spacing: 6) {
                        Text(statusLabel)
                            .foregroundStyle(statusColor)
                        Text(presentation.activityDate.piDCodeRelativeLabel)
                            .foregroundStyle(.secondary)
                    }
                    .font(.caption)
                    .lineLimit(1)
                }
                Spacer(minLength: 6)
                if presentation.hasUnseenCompletion {
                    Circle()
                        .fill(Color.accentColor)
                        .frame(width: 8, height: 8)
                        .accessibilityLabel("有新完成结果")
                }
            }
            .padding(.horizontal, PiDCodeMetrics.spacingStandard)
            .padding(.vertical, 7)
            .frame(maxWidth: .infinity, minHeight: PiDCodeMetrics.minimumTarget, alignment: .leading)
            .contentShape(RoundedRectangle(cornerRadius: PiDCodeMetrics.compactRadius))
            .background(
                model.selectedSessionID == presentation.id ? Color.primary.opacity(0.10) : Color.clear,
                in: RoundedRectangle(cornerRadius: PiDCodeMetrics.compactRadius)
            )
        }
        .buttonStyle(.plain)
        .disabled(selectionDisabled)
        .help("\(presentation.summary.displayTitle)\n\(statusLabel)\n\(presentation.summary.cwd)")
        .accessibilityLabel("打开会话 \(presentation.summary.displayTitle)，\(statusLabel)，\(presentation.hasUnseenCompletion ? "有新完成结果" : "没有新完成结果")")
        .accessibilityAddTraits(model.selectedSessionID == presentation.id ? .isSelected : [])
    }

    private var iconName: String {
        switch presentation.status {
        case .waitingForUser: "person.crop.circle.badge.exclamationmark"
        case .running: "waveform"
        case .stopRequested: "stop.circle"
        case .newCompletion, .completed: "checkmark.circle"
        case .failed: "exclamationmark.triangle"
        case .aborted: "xmark.circle"
        case .unknown: "questionmark.circle"
        case .history: "clock"
        }
    }

    private var statusLabel: String {
        switch presentation.status {
        case .waitingForUser: presentation.waitingFor?.label ?? "等待你处理"
        case .running: "正在运行"
        case .stopRequested: "正在停止"
        case .newCompletion: "新完成"
        case .completed: "已完成"
        case .failed: "运行失败"
        case .aborted: "已中止"
        case .unknown: "结果未知"
        case .history: "最近活动"
        }
    }

    private var statusColor: Color {
        switch presentation.status {
        case .waitingForUser, .stopRequested, .unknown: .orange
        case .running: .accentColor
        case .newCompletion: .accentColor
        case .failed: .red
        case .completed, .aborted, .history: .secondary
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
    let leadingInset: CGFloat
    let selectionDisabled: Bool
    let select: () -> Void

    @State private var hovering = false
    @State private var metadataPresented = false
    @State private var metadataPresentationTask: Task<Void, Never>?
    @State private var branchTask: Task<Void, Never>?
    @State private var branchState: GitBranchLookupState = .idle
    @FocusState private var focusedControl: FocusedControl?

    var body: some View {
        HStack(alignment: .center, spacing: 0) {
            Button(action: select) {
                SessionNavigationRow(session: session)
                    .padding(.leading, leadingInset)
            }
            .buttonStyle(.plain)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            .accessibilityElement(children: .combine)
            .focused($focusedControl, equals: .selection)
            .dCodeAccessibleButton(selectionAccessibilityLabel)
            .accessibilityIdentifier("session-row.\(session.id).select")
            .accessibilityAddTraits(isSelected ? .isSelected : [])
            .help("\(session.displayTitle)\n\(session.cwd)")
            .disabled(selectionDisabled)

            HStack(alignment: .center, spacing: 0) {
                Button {
                    Task { await model.togglePinnedSession(session) }
                } label: {
                    IconActionGlyph(systemName: isPinned ? "pin.fill" : "pin")
                }
                .buttonStyle(IconActionStyle())
                .focused($focusedControl, equals: .pin)
                .opacity(showsActions ? 1 : 0)
                .allowsHitTesting(showsActions)
                .disabled(!model.canToggleSessionPin(session))
                .dCodeAccessibleButton(pinLabel)
                .accessibilityIdentifier("session-row.\(session.id).pin")
                .help(isPinned ? "取消置顶" : "置顶")

                Button {
                    Task { await model.archiveSession(session) }
                } label: {
                    IconActionGlyph(systemName: "archivebox")
                }
                .buttonStyle(IconActionStyle())
                .focused($focusedControl, equals: .archive)
                .opacity(showsActions ? 1 : 0)
                .allowsHitTesting(showsActions)
                .disabled(!model.canArchiveSession(session))
                .dCodeAccessibleButton("归档 \(session.displayTitle)")
                .accessibilityIdentifier("session-row.\(session.id).archive")
                .accessibilityHint("只从 D Code 普通导航隐藏；Pi 会话与草稿均保留")
                .help("归档会话")
            }
            .frame(
                width: PiDCodeMetrics.iconActionTarget * 2,
                height: PiDCodeMetrics.iconActionTarget,
                alignment: .center
            )
        }
        .frame(maxWidth: .infinity)
        .frame(minHeight: PiDCodeMetrics.navigationRowHeight)
        .padding(.horizontal, PiDCodeMetrics.spacingStandard)
        .background(rowBackground, in: RoundedRectangle(cornerRadius: PiDCodeMetrics.compactRadius))
        .overlay {
            RoundedRectangle(cornerRadius: PiDCodeMetrics.compactRadius)
                .stroke(rowBorder, lineWidth: focusedControl == nil ? 1 : 2)
        }
        .contentShape(RoundedRectangle(cornerRadius: PiDCodeMetrics.compactRadius))
        .onHover {
            hovering = $0
            updateMetadataPresentation()
        }
        .onChange(of: focusedControl) { _, _ in updateMetadataPresentation() }
        .popover(
            isPresented: $metadataPresented,
            attachmentAnchor: .rect(.bounds),
            arrowEdge: .trailing
        ) {
            SessionNavigationMetadataPopover(
                session: session,
                projectName: ownership?.project.name,
                sourceFolderName: ownership?.sourceFolder.displayName ?? fallbackFolderName,
                branchState: branchState,
                isPinned: isPinned
            )
        }
        .onDisappear {
            metadataPresentationTask?.cancel()
            branchTask?.cancel()
        }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: showsActions)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: visualState)
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
    private var isSelected: Bool { model.selectedSessionID == session.id }
    private var showsActions: Bool { hovering || focusedControl != nil }
    private var visualState: Int {
        if focusedControl != nil { return 3 }
        if isSelected { return 2 }
        if hovering { return 1 }
        return 0
    }
    private var rowBackground: Color {
        if isSelected { return Color.primary.opacity(0.10) }
        if hovering || focusedControl != nil { return Color.primary.opacity(0.06) }
        return .clear
    }
    private var rowBorder: Color {
        if focusedControl != nil { return Color.accentColor.opacity(0.80) }
        if hovering || isSelected { return Color.primary.opacity(0.10) }
        return .clear
    }
    private var pinLabel: String {
        "\(isPinned ? "取消置顶" : "置顶") \(session.displayTitle)"
    }
    private var selectionAccessibilityLabel: String {
        let projectLabel = ownership?.project.name ?? "未归入项目"
        let updatedLabel = session.modifiedDate?.formatted(date: .abbreviated, time: .shortened) ?? "时间未知"
        return "打开会话 \(session.displayTitle)，\(isPinned ? "已置顶" : "未置顶")，项目 \(projectLabel)，源文件夹 \(fallbackFolderName)，工作目录 \(session.cwd)，\(branchAccessibilityLabel)，更新时间 \(updatedLabel)"
    }
    private var ownership: ProjectSessionOwnership? { model.projectOwnership(for: session) }
    private var fallbackFolderName: String {
        let name = URL(fileURLWithPath: session.cwd, isDirectory: true).lastPathComponent
        return name.isEmpty ? session.cwd : name
    }
    private var branchAccessibilityLabel: String {
        switch branchState {
        case .idle, .loading: "当前 Git 分支正在读取"
        case let .ready(branch): "当前 Git 分支 \(branch)"
        case .notRepository: "当前工作目录不是 Git 仓库"
        case .failed: "当前 Git 分支无法读取"
        }
    }
    private func updateMetadataPresentation() {
        metadataPresentationTask?.cancel()
        if focusedControl != nil {
            presentMetadata()
        } else if hovering {
            metadataPresentationTask = Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(350))
                guard !Task.isCancelled, hovering else { return }
                presentMetadata()
            }
        } else {
            metadataPresented = false
            branchTask?.cancel()
            branchTask = nil
        }
    }
    private func presentMetadata() {
        metadataPresented = true
        guard branchTask == nil else { return }
        branchState = .loading
        branchTask = Task { @MainActor in
            let state = await GitBranchCache.shared.read(at: session.cwd)
            guard !Task.isCancelled else { return }
            branchState = state
            branchTask = nil
        }
    }
}

struct SessionNavigationRow: View {
    let session: SessionSummary

    var body: some View {
        Text(session.displayTitle)
            .font(.body)
            .foregroundStyle(.primary)
            .lineLimit(1)
            .frame(
                maxWidth: .infinity,
                minHeight: PiDCodeMetrics.navigationRowHeight,
                alignment: .leading
            )
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

private struct SessionNavigationMetadataPopover: View {
    let session: SessionSummary
    let projectName: String?
    let sourceFolderName: String
    let branchState: GitBranchLookupState
    let isPinned: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: PiDCodeMetrics.spacingGroup) {
            HStack(alignment: .firstTextBaseline, spacing: PiDCodeMetrics.spacingStandard) {
                Text(session.displayTitle)
                    .font(.body.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: PiDCodeMetrics.spacingStandard)
                if let date = session.modifiedDate {
                    Text(date.piDCodeRelativeLabel)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                }
            }

            Divider()

            metadataRow(icon: "folder", title: "项目") {
                Text(projectName ?? "未归入项目")
            }
            metadataRow(icon: "folder.badge.gearshape", title: "源文件夹") {
                VStack(alignment: .leading, spacing: 2) {
                    Text(sourceFolderName)
                    Text(session.cwd)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                }
            }
            metadataRow(icon: "point.topleft.down.curvedto.point.bottomright.up", title: "当前分支") {
                HStack(spacing: PiDCodeMetrics.spacingTight) {
                    if branchState == .loading || branchState == .idle {
                        ProgressView().controlSize(.mini)
                    }
                    Text(branchLabel)
                }
            }
        }
        .padding(PiDCodeMetrics.spacingGroup)
        .frame(width: 340, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(isPinned ? "已置顶会话" : "会话") \(session.displayTitle)")
    }

    private var branchLabel: String {
        switch branchState {
        case .idle, .loading: "正在读取当前工作区"
        case let .ready(branch): branch
        case .notRepository: "非 Git 仓库"
        case .failed: "无法读取当前分支"
        }
    }

    private func metadataRow<Content: View>(
        icon: String,
        title: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        HStack(alignment: .top, spacing: PiDCodeMetrics.spacingStandard) {
            Image(systemName: icon)
                .foregroundStyle(.secondary)
                .frame(width: 20, height: 20)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                content()
            }
            Spacer(minLength: 0)
        }
    }
}
