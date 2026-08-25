import SwiftUI

struct TaskWorkbenchView: View {
    @Environment(AppModel.self) private var model
    @State private var state = TaskWorkbenchState()
    @State private var navigationPresented = false
    @State private var taskSheetPresented = false
    @State private var taskSheetProjectID: String?
    @State private var projectSheetPresented = false
    @State private var agentProfilesPresented = false
    @State private var importCandidate: FoundationPiImportCandidate?
    @State private var workbenchStateWriteTail: Task<Void, Never>?

    var body: some View {
        GeometryReader { proxy in
            let compactNavigation = proxy.size.width < TaskHUDLayoutPolicy.mediumMinimum
            ZStack(alignment: .leading) {
                HStack(spacing: 0) {
                    if !compactNavigation {
                        TaskNavigationView(
                            snapshot: model.foundationSnapshot,
                            state: state,
                            persistViewState: persistTaskWorkbenchState,
                            createTask: { projectID in
                                taskSheetProjectID = projectID
                                taskSheetPresented = true
                            },
                            createProject: { projectSheetPresented = true },
                            openAgentProfiles: { agentProfilesPresented = true },
                            importSession: { candidate in
                                Task {
                                    if await model.previewFoundationPiSession(sourceSessionId: candidate.sourceSessionId) {
                                        importCandidate = candidate
                                    }
                                }
                            }
                        )
                        .frame(width: 258)
                        Divider()
                    }
                    TaskWorkbenchWorkspace(
                        snapshot: model.foundationSnapshot,
                        state: state,
                        windowWidth: proxy.size.width,
                        navigationAction: compactNavigation ? { navigationPresented = true } : nil,
                        persistViewState: persistTaskWorkbenchState
                    )
                }

                if compactNavigation, navigationPresented {
                    compactNavigationOverlay(width: proxy.size.width)
                }
            }
            .task(id: model.foundationSnapshot?.storeRevision) {
                guard let snapshot = model.foundationSnapshot else { return }
                if let remote = snapshot.taskWorkbenchViewState {
                    state.apply(remote: remote)
                }
                if let patch = state.reconcile(with: snapshot) {
                    persistTaskWorkbenchState(patch)
                }
                if let sessionID = state.selectedSessionID {
                    _ = await model.loadFoundationSessionPresentation(sessionID)
                }
            }
            .onChange(of: state.selectedSessionID) { _, sessionID in
                guard let sessionID else { return }
                Task { _ = await model.loadFoundationSessionPresentation(sessionID) }
            }
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .sheet(isPresented: $taskSheetPresented) {
            FoundationTaskCreateSheet(preferredProjectID: taskSheetProjectID)
        }
        .sheet(isPresented: $projectSheetPresented) {
            FoundationProjectCreateSheet()
        }
        .sheet(isPresented: $agentProfilesPresented) {
            FoundationAgentProfilesSettingsSheet()
        }
        .sheet(item: $importCandidate, onDismiss: { model.clearFoundationPiImportPreview() }) { candidate in
            FoundationPiImportPreviewSheet(candidate: candidate)
        }
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
    }

    @ViewBuilder
    private func compactNavigationOverlay(width: CGFloat) -> some View {
        Color.black.opacity(0.16)
            .ignoresSafeArea()
            .contentShape(Rectangle())
            .onTapGesture { navigationPresented = false }
        TaskNavigationView(
            snapshot: model.foundationSnapshot,
            state: state,
            persistViewState: persistTaskWorkbenchState,
            createTask: { projectID in
                navigationPresented = false
                taskSheetProjectID = projectID
                taskSheetPresented = true
            },
            createProject: {
                navigationPresented = false
                projectSheetPresented = true
            },
            openAgentProfiles: {
                navigationPresented = false
                agentProfilesPresented = true
            },
            importSession: { candidate in
                navigationPresented = false
                Task {
                    if await model.previewFoundationPiSession(sourceSessionId: candidate.sourceSessionId) {
                        importCandidate = candidate
                    }
                }
            }
        )
        .frame(width: min(320, width * 0.84))
        .frame(maxHeight: .infinity)
        .background(.background)
        .shadow(color: .black.opacity(0.18), radius: 22, x: 8)
        .transition(.move(edge: .leading))
    }

    private func persistTaskWorkbenchState(_ patch: [String: JSONValue]) {
        let previous = workbenchStateWriteTail
        workbenchStateWriteTail = Task {
            if let previous { await previous.value }
            var revision = state.viewStateRevision
            if let mutation = await model.patchFoundationTaskWorkbenchViewState(
                expectedViewStateRevision: revision,
                patch: patch
            ) {
                state.applyMutation(mutation)
                return
            }
            // A different D Code window can change the same Product Store between
            // local UI actions. Rebase this one field-level patch once instead of
            // overwriting its selection, HUD sections, or Inspector target.
            if let remote = model.foundationSnapshot?.taskWorkbenchViewState {
                state.apply(remote: remote)
            }
            revision = state.viewStateRevision
            if let mutation = await model.patchFoundationTaskWorkbenchViewState(
                expectedViewStateRevision: revision,
                patch: patch
            ) {
                state.applyMutation(mutation)
            }
        }
    }
}

private struct TaskNavigationView: View {
    let snapshot: FoundationSnapshot?
    let state: TaskWorkbenchState
    let persistViewState: ([String: JSONValue]) -> Void
    let createTask: (String?) -> Void
    let createProject: () -> Void
    let openAgentProfiles: () -> Void
    let importSession: (FoundationPiImportCandidate) -> Void
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Label("任务", systemImage: "checklist")
                    .font(.headline)
                Spacer()
                Button(action: { createTask(selectedProjectID) }) {
                    Image(systemName: "plus")
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("新建任务")
                Button(action: createProject) {
                    Image(systemName: "folder.badge.plus")
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("新建项目")
                Button(action: openAgentProfiles) {
                    Image(systemName: "gearshape")
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("设置：智能体档案")
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 13)
            Divider()

            if let snapshot {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 14) {
                        ForEach(snapshot.tasks.filter { task in
                            if case .user = task.scope { return true }
                            return false
                        }) { task in
                            TaskNavigationRow(
                                task: task,
                                snapshot: snapshot,
                                state: state,
                                persistViewState: persistViewState
                            )
                        }

                        ForEach(snapshot.projects) { project in
                            TaskNavigationSection(
                                title: project.title,
                                subtitle: project.directory,
                                tasks: snapshot.tasks.filter { task in
                                    if case let .project(projectID) = task.scope { return projectID == project.id }
                                    return false
                                },
                                snapshot: snapshot,
                                state: state,
                                persistViewState: persistViewState,
                                createTask: { createTask(project.id) }
                            )
                        }

                        VStack(alignment: .leading, spacing: 8) {
                            Text("导入")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                            if model.foundationImportCandidates.isEmpty {
                                Text("没有可导入的 Pi 会话")
                                    .font(.caption)
                                    .foregroundStyle(.tertiary)
                            } else {
                                ForEach(model.foundationImportCandidates.prefix(4)) { candidate in
                                    Button {
                                        importSession(candidate)
                                    } label: {
                                        Label(candidate.title, systemImage: "square.and.arrow.down")
                                            .lineLimit(1)
                                            .frame(maxWidth: .infinity, alignment: .leading)
                                    }
                                    .buttonStyle(.borderless)
                                    .font(.caption)
                                }
                            }
                        }
                        .padding(.horizontal, 12)
                        .padding(.bottom, 18)
                    }
                    .padding(.top, 12)
                }
            } else {
                ProgressView("正在读取任务…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(Color(nsColor: .controlBackgroundColor))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("任务导航")
    }

    private var selectedProjectID: String? {
        guard
            let selectedTaskID = state.selectedTaskID,
            let task = snapshot?.tasks.first(where: { $0.id == selectedTaskID }),
            case let .project(projectID) = task.scope
        else { return nil }
        return projectID
    }
}

private struct TaskNavigationSection: View {
    let title: String
    var subtitle: String? = nil
    let tasks: [FoundationTask]
    let snapshot: FoundationSnapshot
    let state: TaskWorkbenchState
    let persistViewState: ([String: JSONValue]) -> Void
    var createTask: (() -> Void)? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top, spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    if let subtitle {
                        Text(subtitle)
                            .font(.caption2.monospaced())
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
                if let createTask {
                    Button(action: createTask) {
                        Image(systemName: "plus")
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("在\(title)新建任务")
                }
            }
            .padding(.horizontal, 12)
            if tasks.isEmpty {
                Text("暂无任务")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .padding(.horizontal, 12)
            }
            ForEach(tasks) { task in
                TaskNavigationRow(task: task, snapshot: snapshot, state: state, persistViewState: persistViewState)
            }
        }
    }
}

private struct TaskNavigationRow: View {
    let task: FoundationTask
    let snapshot: FoundationSnapshot
    let state: TaskWorkbenchState
    let persistViewState: ([String: JSONValue]) -> Void

    private var selected: Bool { state.selectedTaskID == task.id }
    private var childSessions: [FoundationSession] {
        TaskWorkbenchProjection.sessions(for: task.id, snapshot: snapshot)
            .filter { $0.kind == "child" }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button {
                persistViewState(state.select(task: task, snapshot: snapshot))
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: selected ? "chevron.down" : "chevron.right")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(.secondary)
                        .frame(width: 11)
                    TaskStateDot(state: task.state)
                    Text(task.title)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    if task.state == "waiting" {
                        Image(systemName: "exclamationmark.circle.fill")
                            .foregroundStyle(.orange)
                    }
                }
                .font(.subheadline)
                .padding(.horizontal, 10)
                .padding(.vertical, 7)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(selected ? Color.accentColor.opacity(0.13) : .clear, in: RoundedRectangle(cornerRadius: 8))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("任务：\(task.title)")

            if selected {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(childSessions) { session in
                        Button {
                            persistViewState(state.selectSession(session.id))
                        } label: {
                            HStack(spacing: 8) {
                                Image(systemName: "bubble.left.and.bubble.right")
                                    .font(.caption)
                                    .frame(width: 14)
                                Text(session.title)
                                    .lineLimit(1)
                                Spacer(minLength: 0)
                                SessionStateDot(state: session.state)
                            }
                            .font(.caption)
                            .foregroundStyle(state.selectedSessionID == session.id ? Color.accentColor : .secondary)
                            .padding(.leading, 30)
                            .padding(.trailing, 10)
                            .padding(.vertical, 5)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("子会话：\(session.title)")
                    }
                }
            }
        }
        .padding(.horizontal, 4)
    }
}

private struct TaskWorkbenchWorkspace: View {
    let snapshot: FoundationSnapshot?
    let state: TaskWorkbenchState
    let windowWidth: CGFloat
    let navigationAction: (() -> Void)?
    let persistViewState: ([String: JSONValue]) -> Void
    @Environment(AppModel.self) private var model
    @State private var mediumHUDCollapsed = false
    @State private var compactHUDPresented = false
    @State private var contentTarget: TaskWorkbenchContentTarget?

    var body: some View {
        GeometryReader { proxy in
            let layout = TaskHUDLayoutPolicy.layout(for: windowWidth)
            let task = snapshot?.tasks.first(where: { $0.id == state.selectedTaskID })
            let session = task.flatMap { task in
                snapshot?.sessions.first(where: { $0.id == state.selectedSessionID && $0.taskId == task.id })
            }
            ZStack(alignment: .topTrailing) {
                if let snapshot, let task, let session {
                    taskSurface(snapshot: snapshot, task: task, session: session)
                        .padding(.leading, conversationLeadingInset(layout: layout))
                        .padding(.trailing, state.inspectorTarget == nil ? conversationTrailingInset(layout: layout) : 352)
                        .padding(.top, 54)
                        .animation(nil, value: snapshot.storeRevision)
                } else {
                    ContentUnavailableView(
                        "选择一个任务",
                        systemImage: "checklist",
                        description: Text("任务是 D Code 的工作根。进入任务后默认和协调者继续对话。")
                    )
                    .padding(.top, 34)
                }

                TaskWorkspaceHeader(
                    task: task,
                    session: session,
                    navigationAction: navigationAction,
                    inspectorOpen: state.inspectorTarget != nil,
                    closeInspector: { persistViewState(state.closeInspector()) }
                )
                .zIndex(3)

                if let snapshot, let task, state.inspectorTarget == nil {
                    switch layout {
                    case .wideFloating:
                        TaskHUDView(
                            snapshot: snapshot,
                            task: task,
                            state: state,
                            persistViewState: persistViewState,
                            openContent: { contentTarget = $0 }
                        )
                            .frame(width: TaskHUDLayoutPolicy.wideCardWidth)
                            .frame(maxHeight: max(240, proxy.size.height - 90))
                            .padding(.top, TaskHUDLayoutPolicy.wideCardTopInset)
                            .padding(.trailing, TaskHUDLayoutPolicy.wideCardTrailingInset)
                            .zIndex(2)
                    case .mediumOverlay:
                        if !mediumHUDCollapsed {
                            TaskHUDView(
                                snapshot: snapshot,
                                task: task,
                                state: state,
                                persistViewState: persistViewState,
                                openContent: { contentTarget = $0 },
                                dismiss: { mediumHUDCollapsed = true }
                            )
                                .frame(width: min(332, proxy.size.width - 32))
                                .frame(maxHeight: max(240, proxy.size.height - 82))
                                .padding(.top, 58)
                                .padding(.trailing, 16)
                                .transition(.opacity.combined(with: .move(edge: .trailing)))
                                .zIndex(4)
                        } else {
                            TaskHUDEntryButton(action: { mediumHUDCollapsed = false })
                                .padding(.top, 60)
                                .padding(.trailing, 18)
                                .zIndex(4)
                        }
                    case .compactEntry:
                        if compactHUDPresented {
                            TaskHUDView(
                                snapshot: snapshot,
                                task: task,
                                state: state,
                                persistViewState: persistViewState,
                                openContent: { contentTarget = $0 },
                                dismiss: { compactHUDPresented = false }
                            )
                                .frame(width: min(360, proxy.size.width - 28))
                                .frame(maxHeight: proxy.size.height - 88)
                                .padding(.top, 58)
                                .padding(.trailing, 14)
                                .transition(.opacity.combined(with: .move(edge: .trailing)))
                                .zIndex(4)
                        } else {
                            TaskHUDEntryButton(action: { compactHUDPresented = true })
                                .padding(.top, 60)
                                .padding(.trailing, 14)
                                .zIndex(4)
                        }
                    }
                }

                if let snapshot, let task, let target = state.inspectorTarget {
                    TaskObjectInspectorView(snapshot: snapshot, task: task, target: target, close: { persistViewState(state.closeInspector()) })
                        .frame(width: min(340, proxy.size.width * 0.46))
                        .frame(maxHeight: .infinity)
                        .background(.background)
                        .shadow(color: .black.opacity(0.14), radius: 18, x: -5)
                        .zIndex(5)
                }
            }
            .background(Color(nsColor: .textBackgroundColor))
            .animation(.easeOut(duration: 0.2), value: mediumHUDCollapsed)
            .animation(.easeOut(duration: 0.2), value: compactHUDPresented)
            .onChange(of: layout) { _, next in
                if next == .mediumOverlay { mediumHUDCollapsed = false }
                if next == .compactEntry { compactHUDPresented = false }
            }
            .onChange(of: state.selectedTaskID) { _, _ in
                contentTarget = nil
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("任务工作区")
    }

    private func conversationLeadingInset(layout: TaskHUDLayout) -> CGFloat {
        layout == .wideFloating ? TaskHUDLayoutPolicy.wideConversationLeadingInset : 20
    }

    private func conversationTrailingInset(layout: TaskHUDLayout) -> CGFloat {
        layout == .wideFloating ? TaskHUDLayoutPolicy.wideConversationTrailingInset : 20
    }

    @ViewBuilder
    private func taskSurface(
        snapshot: FoundationSnapshot,
        task: FoundationTask,
        session: FoundationSession
    ) -> some View {
        if let contentTarget {
            TaskWorkspaceContentView(
                snapshot: snapshot,
                task: task,
                target: contentTarget,
                close: { self.contentTarget = nil },
                inspect: { persistViewState(state.openInspector($0)) }
            )
        } else {
            TaskConversationSurface(
                task: task,
                session: session,
                requests: snapshot.agentRequests.filter { $0.taskId == task.id && $0.status == "open" },
                composerDraft: snapshot.composerDrafts?
                    .last(where: { $0.taskId == task.id && $0.sessionId == session.id && $0.draftKind == "session_path" }),
                agentRun: snapshot.agentRuns.first(where: { $0.taskId == task.id && $0.sessionId == session.id })
            )
        }
    }
}

private struct TaskWorkspaceHeader: View {
    let task: FoundationTask?
    let session: FoundationSession?
    let navigationAction: (() -> Void)?
    let inspectorOpen: Bool
    let closeInspector: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            if let navigationAction {
                Button(action: navigationAction) {
                    Image(systemName: "sidebar.left")
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("打开任务导航")
            }
            VStack(alignment: .leading, spacing: 1) {
                Text(task?.title ?? "D Code")
                    .font(.headline)
                    .lineLimit(1)
                Text(session?.kind == "coordination" ? "协调者 · 主任务对话" : (session?.title ?? "任务工作台"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
            if inspectorOpen {
                Button("返回任务概览", action: closeInspector)
                    .buttonStyle(.bordered)
                    .controlSize(.small)
            } else {
                Label("任务概览", systemImage: "rectangle.stack")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 18)
        .frame(height: 48)
        .frame(maxWidth: .infinity)
        .background(.bar)
        .overlay(alignment: .bottom) { Divider() }
    }
}

private struct TaskConversationSurface: View {
    let task: FoundationTask
    let session: FoundationSession
    let requests: [FoundationAgentRequest]
    let composerDraft: FoundationComposerDraft?
    let agentRun: FoundationAgentRun?
    @Environment(AppModel.self) private var model
    @State private var draft = ""
    @State private var restoredDraftText = ""
    @State private var restoredDraftSessionID: String?
    @State private var restoredDraftRevision: Int?
    @State private var draftWriteTask: Task<Void, Never>?

    private var presentation: FoundationDCodeSessionPresentation? {
        guard model.foundationSessionPresentation?.dcodeSession.id == session.id else { return nil }
        return model.foundationSessionPresentation
    }

    private var transcript: [TranscriptItem] {
        guard let inspection = presentation?.inspection else { return [] }
        return TranscriptParser.parse(entries: inspection.entries)
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Label(
                    session.kind == "coordination" ? "协调者 · 主任务对话" : "子智能体会话",
                    systemImage: session.kind == "coordination" ? "person.2.fill" : "bubble.left.and.bubble.right"
                )
                .font(.caption.weight(.semibold))
                .foregroundStyle(session.kind == "coordination" ? Color.accentColor : .secondary)
                Spacer()
                if let runtime = presentation?.runtime {
                    Text(runtime.state.isStreaming ? "正在运行" : "运行已就绪")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(runtime.state.isStreaming ? .blue : .secondary)
                    if let model = runtime.state.model {
                        Text("\(model.provider)/\(model.id)")
                            .font(.caption2.monospaced())
                            .foregroundStyle(.tertiary)
                    }
                    if let agentRun, agentRun.status == "running" || agentRun.status == "waiting" {
                        Button("停止") {
                            Task { await model.stopFoundationAgentRun(agentRun) }
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.mini)
                        .accessibilityHint("停止当前显示的智能体运行，不影响同一任务的其他成员")
                    }
                } else if presentation?.adapterState == "unbound" {
                    Text("尚未启动")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 11)

            Divider()

            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 14) {
                        if session.lineageStatus == "unknown" {
                            TaskImportedHistoryNotice()
                        }
                        if session.kind == "coordination", !requests.isEmpty {
                            VStack(alignment: .leading, spacing: 8) {
                                Text("等待你处理")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(.secondary)
                                ForEach(requests) { request in
                                    TaskAgentRequestCard(request: request, emphasis: .conversation)
                                }
                            }
                            .padding(12)
                            .background(Color.accentColor.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
                        }
                        if transcript.isEmpty {
                            ContentUnavailableView(
                                session.kind == "coordination" ? "从协调者开始" : "该成员尚无可见对话",
                                systemImage: "text.bubble",
                                description: Text(
                                    session.kind == "coordination"
                                        ? "提交第一条消息后，D Code 会建立协调者运行；历史导入内容仍保持来源区分。"
                                        : "进入成员会话不会停止其他成员；只有该成员 Runtime 活动时才能向它发送消息。"
                                )
                            )
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 56)
                        } else {
                            ForEach(transcript) { item in
                                if let text = visibleText(item) {
                                    TaskTranscriptBubble(
                                        item: item,
                                        text: text,
                                        assistantLabel: session.kind == "coordination" ? "协调者" : session.title
                                    )
                                        .id(item.id)
                                }
                            }
                        }
                    }
                    .frame(maxWidth: 680, alignment: .leading)
                    .padding(.horizontal, 4)
                    .padding(.vertical, 22)
                }
                .onChange(of: transcript.map(\.id)) { _, ids in
                    guard let last = ids.last else { return }
                    withAnimation(.easeOut(duration: 0.18)) { proxy.scrollTo(last, anchor: .bottom) }
                }
            }

            Divider()
            VStack(alignment: .leading, spacing: 7) {
                Text(session.kind == "coordination"
                    ? "发送到协调者，目标校准、成员问题去重与最终综合都回到这里。"
                    : "发送到 \(session.title)，这条消息只进入该成员的有界上下文。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                HStack(alignment: .bottom, spacing: 10) {
                    TextEditor(text: $draft)
                        .font(.body)
                        .frame(minHeight: 42, maxHeight: 96)
                        .padding(7)
                        .background(.background, in: RoundedRectangle(cornerRadius: 10))
                        .overlay {
                            RoundedRectangle(cornerRadius: 10)
                                .stroke(Color(nsColor: .separatorColor).opacity(0.72))
                        }
                        .accessibilityLabel("任务消息输入")
                    Button {
                        let message = draft.trimmingCharacters(in: .whitespacesAndNewlines)
                        guard !message.isEmpty else { return }
                        Task {
                            if await model.promptFoundationDCodeSession(dcodeSessionID: session.id, message: message) {
                                draft = ""
                            }
                        }
                    } label: {
                        Label("发送", systemImage: "arrow.up")
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityHint("消息会发送到当前显示的任务会话")
                }
            }
            .frame(maxWidth: 680, alignment: .leading)
            .padding(.horizontal, 18)
            .padding(.vertical, 12)
            .background(.bar)
        }
        .task(id: "\(session.id):\(model.foundationSnapshot?.storeRevision ?? -1)") {
            restoreComposerDraftIfNeeded()
            _ = await model.loadFoundationSessionPresentation(session.id)
        }
        .onChange(of: draft) { _, next in
            guard next != restoredDraftText else { return }
            scheduleComposerDraftSave(next)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(session.kind == "coordination" ? "协调者，主任务对话" : "子智能体会话")
    }

    private func visibleText(_ item: TranscriptItem) -> String? {
        let text = item.blocks.compactMap { block -> String? in
            switch block {
            case let .text(_, value), let .code(_, _, value), let .error(_, value): value
            default: nil
            }
        }.joined(separator: "\n")
        return text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : text
    }

    private func restoreComposerDraftIfNeeded() {
        let revision = composerDraft?.revision
        guard restoredDraftSessionID != session.id || restoredDraftRevision != revision else { return }
        let restored = composerDraft?.text ?? ""
        draft = restored
        restoredDraftText = restored
        restoredDraftSessionID = session.id
        restoredDraftRevision = revision
    }

    private func scheduleComposerDraftSave(_ text: String) {
        draftWriteTask?.cancel()
        draftWriteTask = Task {
            try? await Task.sleep(for: .milliseconds(220))
            guard !Task.isCancelled, draft == text else { return }
            if await model.saveFoundationDCodeSessionComposerDraft(
                taskID: task.id,
                dcodeSessionID: session.id,
                text: text
            ) {
                restoredDraftText = text
            }
        }
    }
}

private struct TaskImportedHistoryNotice: View {
    var body: some View {
        Label("这条会话含有导入历史。D Code 把它作为来源标记的上下文证据，不把它伪装成这次提交原文。", systemImage: "arrow.down.doc")
            .font(.caption)
            .foregroundStyle(.secondary)
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.accentColor.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
    }
}

private struct TaskTranscriptBubble: View {
    let item: TranscriptItem
    let text: String
    let assistantLabel: String

    var body: some View {
        VStack(alignment: item.role == .user ? .trailing : .leading, spacing: 5) {
            Text(item.role == .user ? "你" : assistantLabel)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(MarkdownPresentation.attributedString(for: text))
                .textSelection(.enabled)
                .frame(maxWidth: 600, alignment: .leading)
                .padding(12)
                .background(item.role == .user ? Color.accentColor.opacity(0.12) : Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 13))
        }
        .frame(maxWidth: .infinity, alignment: item.role == .user ? .trailing : .leading)
    }
}

private struct TaskWorkspaceContentView: View {
    let snapshot: FoundationSnapshot
    let task: FoundationTask
    let target: TaskWorkbenchContentTarget
    let close: () -> Void
    let inspect: (TaskWorkbenchInspectorTarget) -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Image(systemName: symbol)
                    .foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 1) {
                    Text(title)
                        .font(.headline)
                        .lineLimit(1)
                    Text("交付物内容")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                Button("查看详情") { inspect(inspectorTarget) }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                Button("返回任务对话", action: close)
                    .buttonStyle(.bordered)
                    .controlSize(.small)
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 11)
            .background(.bar)
            Divider()

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let artifact {
                        InspectorRows(rows: [
                            ("类型", artifact.kind),
                            ("路径", artifact.managedPath ?? artifact.externalPath ?? "未提供"),
                            ("摘要", artifact.digest ?? "未提供"),
                            ("revision", "\(artifact.revision)"),
                        ])
                        Text("内容元数据")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                        Text(artifact.metadata.prettyPrinted)
                            .font(.body.monospaced())
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(14)
                            .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 12))
                    } else if let report {
                        InspectorRows(rows: [
                            ("类别", report.reportKind),
                            ("Agent Run", report.agentRunId),
                            ("时间", report.createdAt),
                        ])
                        Text(report.body.prettyPrinted)
                            .font(.body)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(14)
                            .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 12))
                    } else {
                        ContentUnavailableView(
                            "内容已不可用",
                            systemImage: "exclamationmark.triangle",
                            description: Text("该对象不再属于当前任务。")
                        )
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 80)
                    }
                }
                .frame(maxWidth: 680, alignment: .leading)
                .padding(22)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("工作区交付物内容")
    }

    private var artifact: FoundationArtifact? {
        guard case let .artifact(id) = target else { return nil }
        return snapshot.artifacts.first { $0.id == id && $0.taskId == task.id }
    }

    private var report: FoundationAgentReport? {
        guard case let .report(id) = target else { return nil }
        return snapshot.agentReports.first { $0.id == id && $0.taskId == task.id }
    }

    private var inspectorTarget: TaskWorkbenchInspectorTarget {
        switch target {
        case let .artifact(id): .artifact(id)
        case let .report(id): .report(id)
        }
    }

    private var title: String {
        artifact?.title ?? (report.map { "报告 · \($0.reportKind)" } ?? "交付物")
    }

    private var symbol: String {
        if let artifact {
            switch artifact.kind {
            case "report": return "doc.text"
            case "diff": return "arrow.left.arrow.right"
            case "evidence": return "checkmark.seal"
            default: return "shippingbox"
            }
        }
        return "doc.text"
    }
}

private struct TaskHUDEntryButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Label("任务概览", systemImage: "rectangle.stack.badge.exclamationmark")
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
        .accessibilityLabel("打开任务概览")
    }
}

private struct TaskHUDView: View {
    let snapshot: FoundationSnapshot
    let task: FoundationTask
    let state: TaskWorkbenchState
    let persistViewState: ([String: JSONValue]) -> Void
    let openContent: (TaskWorkbenchContentTarget) -> Void
    var dismiss: (() -> Void)? = nil
    @Environment(AppModel.self) private var model

    private var workItems: [FoundationTaskWorkItem] {
        snapshot.taskWorkItems.filter { $0.taskId == task.id }.sorted { $0.ordinal < $1.ordinal }
    }
    private var agentRuns: [FoundationAgentRun] {
        snapshot.agentRuns.filter { $0.taskId == task.id }
    }
    private var requests: [FoundationAgentRequest] {
        snapshot.agentRequests.filter { $0.taskId == task.id && $0.status == "open" }
    }
    private var artifacts: [FoundationArtifact] {
        snapshot.artifacts.filter { $0.taskId == task.id }
    }
    private var evidence: [FoundationEvidence] {
        snapshot.evidence.filter { $0.taskId == task.id }
    }
    private var profilesByID: [String: FoundationAgentProfile] {
        Dictionary(uniqueKeysWithValues: snapshot.agentProfiles.map { ($0.id, $0) })
    }
    private var activeTeam: FoundationTeamRun? {
        snapshot.teamRuns.last(where: { $0.taskId == task.id && ["prepared", "active", "waiting"].contains($0.status) })
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text("任务概览")
                        .font(.headline)
                    Spacer()
                    if let dismiss {
                        Button(action: dismiss) {
                            Image(systemName: "xmark")
                        }
                        .buttonStyle(.borderless)
                        .accessibilityLabel("收起任务概览")
                    }
                }
                HUDSection(title: "进度", id: "progress", state: state, toggle: {
                    persistViewState(state.toggleHUDSection("progress"))
                }) {
                    Text(task.goal)
                        .font(.subheadline.weight(.semibold))
                        .fixedSize(horizontal: false, vertical: true)
                    if workItems.isEmpty {
                        Text("尚未建立工作清单")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(workItems) { item in
                            HStack(alignment: .top, spacing: 7) {
                                TaskStateDot(state: item.state)
                                Text(item.title)
                                    .font(.caption)
                                    .strikethrough(item.state == "completed", color: .secondary)
                                Spacer(minLength: 0)
                                Text(workItemLabel(item.state))
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                    if let latest = evidence.last {
                        Button {
                            persistViewState(state.openInspector(.evidence(latest.id)))
                        } label: {
                            Label("最近证据：\(latest.evidenceKind)", systemImage: "checkmark.seal")
                                .font(.caption)
                        }
                        .buttonStyle(.borderless)
                    }
                }

                HUDSection(title: "Agent Team", id: "team", state: state, toggle: {
                    persistViewState(state.toggleHUDSection("team"))
                }, count: agentRuns.count) {
                    if agentRuns.isEmpty {
                        Text("协调者尚未开始运行，也还没有派出成员。")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    ForEach(agentRuns) { run in
                        teamMemberRow(run)
                    }
                    if activeTeam == nil {
                        Button("启动 Agent Team") {
                            Task { await startDefaultTeam() }
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                        .accessibilityHint("协调者会基于当前任务派出 Explore 与 Verifier 成员")
                    }
                }

                HUDSection(title: "等待你处理", id: "waiting", state: state, toggle: {
                    persistViewState(state.toggleHUDSection("waiting"))
                }, count: requests.count) {
                    if requests.isEmpty {
                        Text("当前没有等待事项")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    ForEach(requests) { request in
                        TaskAgentRequestCard(request: request, emphasis: .hud)
                    }
                }

                HUDSection(title: "交付物", id: "deliverables", state: state, toggle: {
                    persistViewState(state.toggleHUDSection("deliverables"))
                }, count: artifacts.count) {
                    if artifacts.isEmpty {
                        Text("子成员报告收口后会出现稳定交付物。")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    ForEach(artifacts) { artifact in
                        HStack(spacing: 8) {
                            Image(systemName: artifactSymbol(artifact.kind))
                                .foregroundStyle(.secondary)
                            Button(artifact.title) { openContent(.artifact(artifact.id)) }
                            .buttonStyle(.borderless)
                            .font(.caption)
                            .lineLimit(1)
                            Spacer(minLength: 0)
                            Text(artifact.kind)
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                        }
                    }
                }
            }
            .padding(14)
        }
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18))
        .overlay {
            RoundedRectangle(cornerRadius: 18)
                .stroke(Color(nsColor: .separatorColor).opacity(0.8))
        }
        .shadow(color: .black.opacity(0.15), radius: 20, y: 8)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("任务概览")
    }

    private func workItemLabel(_ state: String) -> String {
        switch state {
        case "completed": "已完成"
        case "running": "进行中"
        case "blocked": "受阻"
        case "cancelled": "已取消"
        default: "待处理"
        }
    }

    private func artifactSymbol(_ kind: String) -> String {
        switch kind {
        case "report": "doc.text"
        case "diff": "arrow.left.arrow.right"
        case "evidence": "checkmark.seal"
        default: "shippingbox"
        }
    }

    @ViewBuilder
    private func teamMemberRow(_ run: FoundationAgentRun) -> some View {
        let latestSessionRun = snapshot.sessionRuns.last(where: { $0.agentRunId == run.id })
        let latestReport = snapshot.agentReports.last(where: { $0.agentRunId == run.id })
        TaskHUDTeamMemberRow(
            run: run,
            profile: profilesByID[run.profileId],
            latestSessionRun: latestSessionRun,
            latestReport: latestReport,
            task: task,
            openSession: { persistViewState(state.selectSession(run.sessionId)) },
            openReport: { report in openContent(.report(report.id)) }
        )
    }

    private func startDefaultTeam() async {
        guard await model.createFoundationTeam(taskId: task.id),
              let refreshed = model.foundationSnapshot,
              let team = refreshed.teamRuns.last(where: {
                  $0.taskId == task.id && ["prepared", "active"].contains($0.status)
              })
        else { return }
        _ = await model.startFoundationTeam(task: task, teamRunId: team.id)
    }
}

private struct TaskHUDTeamMemberRow: View {
    let run: FoundationAgentRun
    let profile: FoundationAgentProfile?
    let latestSessionRun: FoundationSessionRun?
    let latestReport: FoundationAgentReport?
    let task: FoundationTask
    let openSession: () -> Void
    let openReport: (FoundationAgentReport) -> Void
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 7) {
                TaskStateDot(state: run.status)
                Text(profile?.name ?? run.role)
                    .font(.caption.weight(.semibold))
                Spacer(minLength: 0)
                Text(run.modelProvider.map { "\($0)/\(run.modelId ?? "unknown")" } ?? "模型待启动")
                    .font(.caption2.monospaced())
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
            }
            Text(run.status)
                .font(.caption2)
                .foregroundStyle(.secondary)
            HStack(spacing: 8) {
                Button("打开会话", action: openSession)
                    .buttonStyle(.borderless)
                    .font(.caption)
                if let latestReport {
                    Button("查看报告") { openReport(latestReport) }
                        .buttonStyle(.borderless)
                        .font(.caption)
                }
                if latestSessionRun != nil,
                   run.status == "running" || run.status == "waiting" {
                    Button("停止", role: .destructive) {
                        Task {
                            await model.stopFoundationAgentRun(run)
                        }
                    }
                    .buttonStyle(.borderless)
                    .font(.caption)
                }
            }
        }
        .padding(.top, 5)
    }
}

private struct TaskAgentRequestCard: View {
    enum Emphasis: Equatable {
        case conversation
        case hud
    }

    let request: FoundationAgentRequest
    let emphasis: Emphasis
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(request.prompt)
                .font(emphasis == .conversation ? .subheadline : .caption)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 6) {
                ForEach(request.options) { option in
                    Button(option.label) {
                        answer(request: request, option: option)
                    }
                    .buttonStyle(.bordered)
                    .tint(option.recommended ? .accentColor : .secondary)
                    .controlSize(.mini)
                    .accessibilityHint(option.description ?? "回答该成员请求")
                }
            }
        }
    }

    private func answer(request: FoundationAgentRequest, option: FoundationAgentRequestOption) {
        Task { _ = await model.answerFoundationAgentRequest(request, option: option) }
    }
}

private struct HUDSection<Content: View>: View {
    let title: String
    let id: String
    let state: TaskWorkbenchState
    let toggle: () -> Void
    var count: Int? = nil
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                toggle()
            } label: {
                HStack {
                    Text(title)
                        .font(.subheadline.weight(.semibold))
                    if let count {
                        Text("\(count)")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(.quaternary, in: Capsule())
                    }
                    Spacer()
                    Image(systemName: state.expandedHUDSections.contains(id) ? "chevron.down" : "chevron.right")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(.secondary)
                }
            }
            .buttonStyle(.plain)
            if state.expandedHUDSections.contains(id) {
                content()
            }
        }
        .padding(11)
        .background(.background, in: RoundedRectangle(cornerRadius: 12))
        .overlay {
            RoundedRectangle(cornerRadius: 12)
                .stroke(Color(nsColor: .separatorColor).opacity(0.58))
        }
    }
}

private struct TaskObjectInspectorView: View {
    let snapshot: FoundationSnapshot
    let task: FoundationTask
    let target: TaskWorkbenchInspectorTarget
    let close: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(title)
                    .font(.headline)
                    .lineLimit(1)
                Spacer()
                Button(action: close) {
                    Image(systemName: "xmark")
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("关闭信息检查器")
            }
            .padding(14)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    Text("这是具体对象详情。打开它不会自动加入模型 Context、修改文件、改变 Git 状态或启动 Agent。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    inspectorBody
                }
                .padding(14)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("信息检查器")
    }

    private var title: String {
        switch target {
        case .artifact: "Artifact 详情"
        case .evidence: "Evidence 详情"
        case .report: "报告详情"
        case .context: "上下文来源"
        }
    }

    @ViewBuilder
    private var inspectorBody: some View {
        switch target {
        case let .artifact(id):
            if let artifact = snapshot.artifacts.first(where: { $0.id == id && $0.taskId == task.id }) {
                InspectorRows(rows: [
                    ("类型", artifact.kind),
                    ("标题", artifact.title),
                    ("路径", artifact.managedPath ?? artifact.externalPath ?? "未提供"),
                    ("摘要", artifact.digest ?? "未提供"),
                    ("revision", "\(artifact.revision)"),
                ])
            } else { Text("该 Artifact 已不可用。").foregroundStyle(.secondary) }
        case let .evidence(id):
            if let evidence = snapshot.evidence.first(where: { $0.id == id && $0.taskId == task.id }) {
                InspectorRows(rows: [
                    ("类型", evidence.evidenceKind),
                    ("命令", evidence.commandRedacted ?? "未提供"),
                    ("结果", evidence.exitKind ?? "未知"),
                    ("目录", evidence.cwd ?? "未提供"),
                    ("时间", evidence.createdAt),
                ])
            } else { Text("该 Evidence 已不可用。").foregroundStyle(.secondary) }
        case let .report(id):
            if let report = snapshot.agentReports.first(where: { $0.id == id && $0.taskId == task.id }) {
                InspectorRows(rows: [
                    ("类别", report.reportKind),
                    ("Agent Run", report.agentRunId),
                    ("时间", report.createdAt),
                ])
                Text(report.body.prettyPrinted)
                    .font(.caption.monospaced())
                    .textSelection(.enabled)
            } else { Text("该报告已不可用。").foregroundStyle(.secondary) }
        case let .context(id):
            if let source = snapshot.taskContextSets.first(where: { $0.taskId == task.id })?.sources.first(where: { $0.id == id }) {
                InspectorRows(rows: [
                    ("类型", source.kind),
                    ("标题", source.title),
                    ("路径", source.relativePath),
                    ("根目录", source.rootPath ?? task.cwd),
                ])
            } else { Text("该上下文来源已不可用。").foregroundStyle(.secondary) }
        }
    }
}

private struct InspectorRows: View {
    let rows: [(String, String)]

    var body: some View {
        Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 8) {
            ForEach(rows.indices, id: \.self) { index in
                GridRow {
                    Text(rows[index].0)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(rows[index].1)
                        .font(.caption)
                        .textSelection(.enabled)
                }
            }
        }
    }
}

private struct TaskStateDot: View {
    let state: String

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 8, height: 8)
            .accessibilityHidden(true)
    }

    private var color: Color {
        switch state {
        case "running", "active": .blue
        case "waiting", "blocked": .orange
        case "completed": .green
        case "failed", "rejected", "aborted", "unknown": .red
        default: .secondary
        }
    }
}

private struct SessionStateDot: View {
    let state: String

    var body: some View {
        TaskStateDot(state: state)
    }
}
