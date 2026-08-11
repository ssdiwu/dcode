import AppKit
import Foundation
import Observation

struct AppIssue: Identifiable, Equatable {
    let id = UUID()
    let title: String
    let message: String
}

enum HostConnectionState: Equatable {
    case idle
    case connecting
    case ready
    case failed

    var label: String {
        switch self {
        case .idle: "未连接"
        case .connecting: "正在连接"
        case .ready: "运行服务已就绪"
        case .failed: "连接失败"
        }
    }
}

struct StreamingTool: Identifiable, Equatable {
    let id: String
    let name: String
    var details: String
    var isRunning: Bool
    var isError: Bool
}

struct PendingPromptDraft: Equatable {
    let sessionID: String
    let promptID: String
    let draft: String
}

@MainActor
@Observable
final class AppModel {
    var connectionState: HostConnectionState = .idle
    var hostHello: HostHello?
    var projects: [DCodeProject] = []
    var recentSessions: [SessionSummary] = []
    var recentHasMore = false
    var projectSessions: [UUID: [SessionSummary]] = [:]
    var projectHasMore: [UUID: Bool] = [:]
    var projectSessionErrors: [UUID: String] = [:]
    var selectedProjectID: UUID?
    var expandedProjectIDs: Set<UUID> = []
    var inspectorScope: InspectorScope?
    var selectedSessionID: String?
    var inspection: SessionInspection?
    var transcript: [TranscriptItem] = []
    var hostState: HostState?
    var activePlan: ActivePlanPresentation?
    var composerText = ""
    var optimisticUserMessage: String?
    var streamingText = ""
    var streamingThinking = ""
    var streamingTools: [StreamingTool] = []
    var isStreaming = false
    var isLoadingRecentSessions = false
    var loadingProjectIDs: Set<UUID> = []
    var isOpeningSession = false
    var isSendingRequest = false
    var issue: AppIssue?
    var notice: ExtensionNotice?
    var extensionDialogs: [ExtensionDialog] = []
    var extensionStatuses: [String: String] = [:]
    var workingMessage: String?
    var availableModels: [HostModel] = []
    var availableThinkingLevels: [String] = []
    var availableCommands: [CommandDescriptor] = []

    @ObservationIgnored private var client: PiHostClient?
    @ObservationIgnored private var refreshTask: Task<Void, Never>?
    @ObservationIgnored private var openGeneration = UUID()
    @ObservationIgnored private var noticeTask: Task<Void, Never>?
    @ObservationIgnored private var mermaidCache: [String: MermaidRenderResult] = [:]
    @ObservationIgnored private var mermaidCacheOrder: [String] = []
    @ObservationIgnored private var mermaidTasks: [String: Task<MermaidRenderResult, Never>] = [:]
    @ObservationIgnored private var didEndStreamingAssistantMessage = false
    @ObservationIgnored var pendingPrompt: PendingPromptDraft?
    @ObservationIgnored private let projectStore: ProjectStore
    @ObservationIgnored private var projectStoreWritable = false
    @ObservationIgnored private var recentWindow = SessionListWindow()
    @ObservationIgnored private var projectWindows: [UUID: SessionListWindow] = [:]
    @ObservationIgnored private var projectLoadGenerations: [UUID: UUID] = [:]

    init(projectStore: ProjectStore = ProjectStore()) {
        self.projectStore = projectStore
    }

    static func recentSessionListParameters(limit: Int) -> [String: JSONValue] {
        [
            "limit": .number(Double(limit)),
            "origin": .string("dcode"),
        ]
    }

    var selectedSummary: SessionSummary? {
        guard let selectedSessionID else { return nil }
        if inspection?.summary.id == selectedSessionID { return inspection?.summary }
        if let recent = recentSessions.first(where: { $0.id == selectedSessionID }) { return recent }
        return projectSessions.values.lazy.flatMap { $0 }.first(where: { $0.id == selectedSessionID })
    }

    var selectedProject: DCodeProject? {
        guard let selectedProjectID else { return nil }
        return projects.first(where: { $0.id == selectedProjectID })
    }

    var canWrite: Bool { hostState?.writable == true }

    var canEditProjects: Bool { projectStoreWritable }

    var canUseHostSessions: Bool {
        connectionState == .ready && hostHello != nil && client != nil
    }

    @ObservationIgnored private var readyClient: PiHostClient? {
        canUseHostSessions ? client : nil
    }

    var isLoadingSessions: Bool { isLoadingRecentSessions || !loadingProjectIDs.isEmpty }

    var activeDialog: ExtensionDialog? { extensionDialogs.first }

    func sessions(for project: DCodeProject) -> [SessionSummary] {
        projectSessions[project.id, default: []]
    }

    func sourceFolderName(for session: SessionSummary, in project: DCodeProject) -> String {
        let sessionPath = URL(fileURLWithPath: session.cwd).standardizedFileURL.resolvingSymlinksInPath().path
        return project.sourceFolders.first(where: { $0.path == sessionPath })?.displayName
            ?? URL(fileURLWithPath: session.cwd).lastPathComponent
    }

    func start() async {
        guard connectionState == .idle, client == nil else { return }
        connectionState = .connecting
        await loadProjects()
        do {
            let configuration = try HostLocator.resolve()
            let client = PiHostClient(configuration: configuration) { [weak self] event in
                self?.handle(event)
            }
            self.client = client
            try await client.start()
            let hello: HostHello = try await client.request("host.hello")
            try HostCompatibility.validate(hello)
            hostHello = hello
            connectionState = .ready
            await reloadRecentSessions()
            for projectID in expandedProjectIDs {
                await reloadProjectSessions(projectID)
            }
        } catch {
            connectionState = .failed
            present(error, title: "无法启动 D Code")
            await client?.shutdown()
            client = nil
        }
    }

    func reloadRecentSessions() async {
        guard let client = readyClient else { return }
        isLoadingRecentSessions = true
        defer { isLoadingRecentSessions = false }
        do {
            let result: SessionListResult = try await client.request(
                "session.list",
                params: Self.recentSessionListParameters(limit: recentWindow.requestLimit)
            )
            let page = recentWindow.page(from: result.sessions)
            recentSessions = page.items
            recentHasMore = page.hasMore
        } catch {
            present(error, title: "无法读取 Pi 会话")
        }
    }

    func loadMoreRecentSessions() async {
        recentWindow.loadMore()
        await reloadRecentSessions()
    }

    func reloadProjectSessions(_ projectID: UUID) async {
        guard let client = readyClient,
              let project = projects.first(where: { $0.id == projectID }) else { return }
        guard !project.sourceFolders.isEmpty else {
            projectSessions[projectID] = []
            projectHasMore[projectID] = false
            projectSessionErrors.removeValue(forKey: projectID)
            return
        }
        let window = projectWindows[projectID] ?? SessionListWindow()
        let sourcePaths = project.sourceFolders.map(\.path)
        let generation = UUID()
        projectLoadGenerations[projectID] = generation
        loadingProjectIDs.insert(projectID)
        projectSessionErrors.removeValue(forKey: projectID)
        defer {
            if projectLoadGenerations[projectID] == generation {
                loadingProjectIDs.remove(projectID)
            }
        }
        do {
            var merged: [String: SessionSummary] = [:]
            for chunkStart in stride(from: 0, to: sourcePaths.count, by: 64) {
                let chunk = Array(sourcePaths[chunkStart..<min(chunkStart + 64, sourcePaths.count)])
                let result: SessionListResult = try await client.request("session.list", params: [
                    "limit": .number(Double(window.requestLimit)),
                    "cwdScope": .object([
                        "match": .string("exact"),
                        "paths": .array(chunk.map(JSONValue.string)),
                    ]),
                ])
                for session in result.sessions {
                    if let existing = merged[session.id], existing.modified >= session.modified { continue }
                    merged[session.id] = session
                }
            }
            guard projectLoadGenerations[projectID] == generation,
                  projects.first(where: { $0.id == projectID })?.sourceFolders.map(\.path) == sourcePaths else { return }
            let ordered = merged.values.sorted { lhs, rhs in
                if lhs.modified == rhs.modified { return lhs.id < rhs.id }
                return lhs.modified > rhs.modified
            }
            let page = window.page(from: ordered)
            projectSessions[projectID] = page.items
            projectHasMore[projectID] = page.hasMore
            projectSessionErrors.removeValue(forKey: projectID)
        } catch {
            guard projectLoadGenerations[projectID] == generation else { return }
            projectSessionErrors[projectID] = DiagnosticSanitizer.redact(error.localizedDescription)
            present(error, title: "无法读取项目会话")
        }
    }

    func loadMoreProjectSessions(_ projectID: UUID) async {
        var window = projectWindows[projectID] ?? SessionListWindow()
        window.loadMore()
        projectWindows[projectID] = window
        await reloadProjectSessions(projectID)
    }

    func reloadAllSessionLists() async {
        await reloadRecentSessions()
        let reloadIDs = Set(projectSessions.keys).union(expandedProjectIDs)
        for project in projects where reloadIDs.contains(project.id) {
            await reloadProjectSessions(project.id)
        }
    }

    func selectProject(_ projectID: UUID) async {
        selectedProjectID = projectID
        inspectorScope = .project(projectID)
        expandedProjectIDs.insert(projectID)
    }

    func toggleProject(_ projectID: UUID) {
        if expandedProjectIDs.contains(projectID) { expandedProjectIDs.remove(projectID) }
        else { expandedProjectIDs.insert(projectID) }
    }

    func selectSession(_ sessionID: String?) async {
        guard let sessionID else { return }
        if sessionID == inspection?.summary.id {
            selectedSessionID = sessionID
            inspectorScope = .session(sessionID)
            return
        }
        guard !isStreaming, !isOpeningSession else { return }
        await openSession(sessionID, writable: false)
    }

    func createSession(at directory: URL) async {
        guard let client = readyClient, !isStreaming, !isOpeningSession else { return }
        isOpeningSession = true
        defer { isOpeningSession = false }
        do {
            let result: SessionCreateResult = try await client.request(
                "session.create",
                params: ["cwd": .string(directory.path)]
            )
            if let open = result.activation.open {
                await apply(open)
                await loadRuntimeControls(includeCommands: open.mode == "writable")
            } else {
                clearActiveSessionPresentation()
            }
            await reloadAllSessionLists()
            switch result.activation.status {
            case "observing":
                showNotice(
                    "会话已创建，当前先保持同步观察；发送时会重新尝试取得写入权。",
                    level: "warning"
                )
            case "unavailable":
                issue = AppIssue(
                    title: "会话已创建，但暂时无法打开",
                    message: "它已经保存在最近会话中。请稍后从左栏重新打开；原始原因：\(DiagnosticSanitizer.redact(result.activation.error?.message ?? "未知错误"))"
                )
            default:
                break
            }
        } catch {
            present(error, title: "无法创建会话")
        }
    }

    func sendPrompt() async {
        guard readyClient != nil, !isSendingRequest else { return }
        let draft = composerText
        let message = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !message.isEmpty else { return }
        isSendingRequest = true
        defer { isSendingRequest = false }
        guard await ensureWritable() else { return }
        guard let client = readyClient, let sessionID = selectedSessionID else { return }
        let promptID = UUID().uuidString
        pendingPrompt = PendingPromptDraft(sessionID: sessionID, promptID: promptID, draft: draft)
        composerText = ""
        optimisticUserMessage = message
        do {
            let _: Acknowledgement = try await client.request("session.prompt", params: [
                "message": .string(message),
                "promptId": .string(promptID),
            ])
        } catch {
            restorePendingPrompt(for: sessionID)
            present(error, title: "发送失败")
        }
    }

    func abort() async {
        guard let client = readyClient, canWrite else { return }
        do {
            let _: Acknowledgement = try await client.request("session.abort")
        } catch {
            present(error, title: "无法停止当前运行")
        }
    }

    func setThinkingLevel(_ level: String) async {
        guard await ensureWritable(), let client = readyClient else { return }
        do {
            let _: Acknowledgement = try await client.request("session.setThinking", params: ["level": .string(level)])
            await refreshState()
        } catch {
            present(error, title: "无法切换 Thinking level")
        }
    }

    func setModel(_ model: HostModel) async {
        guard await ensureWritable(), let client = readyClient else { return }
        do {
            let _: JSONValue = try await client.request(
                "session.setModel",
                params: ["provider": .string(model.provider), "modelId": .string(model.id)]
            )
            await refreshState()
        } catch {
            present(error, title: "无法切换模型")
        }
    }

    func toggleFastMode() async {
        guard await ensureWritable(), let client = readyClient else { return }
        let enabled = !(hostState?.fastMode?.enabled ?? false)
        do {
            let _: FastModeState = try await client.request(
                "session.setFastMode",
                params: ["enabled": .bool(enabled)]
            )
            await refreshState()
        } catch {
            present(error, title: "无法切换极速模式")
        }
    }

    func respond(to dialog: ExtensionDialog, response: [String: JSONValue]) async {
        guard let client = readyClient else { return }
        do {
            let _: Acknowledgement = try await client.request("extension.respond", params: [
                "requestId": .string(dialog.id),
                "response": .object(response),
            ])
            extensionDialogs.removeAll(where: { $0.id == dialog.id })
        } catch {
            extensionDialogs.removeAll(where: { $0.id == dialog.id })
            present(error, title: "扩展交互失败")
        }
    }

    func cancel(_ dialog: ExtensionDialog) async {
        await respond(to: dialog, response: ["cancelled": .bool(true)])
    }

    func renderMermaid(source: String) async -> MermaidRenderResult {
        if let cached = mermaidCache[source] {
            touchMermaidCache(source)
            return cached
        }
        if let running = mermaidTasks[source] { return await running.value }
        guard let client = readyClient else { return .failure("Pi Host 尚未完成兼容性校验。") }
        guard source.utf16.count <= 100_000 else { return .failure("Mermaid 源码超过 100,000 字符限制。") }
        let task = Task<MermaidRenderResult, Never> {
            do {
                return try await client.request(
                    "content.renderMermaid",
                    params: ["source": .string(source)]
                )
            } catch {
                return .failure(DiagnosticSanitizer.redact(error.localizedDescription))
            }
        }
        mermaidTasks[source] = task
        let result = await task.value
        mermaidTasks.removeValue(forKey: source)
        if result.rendered {
            mermaidCache[source] = result
            touchMermaidCache(source)
            while mermaidCacheOrder.count > 64 {
                let removed = mermaidCacheOrder.removeFirst()
                mermaidCache.removeValue(forKey: removed)
            }
        }
        return result
    }

    private func touchMermaidCache(_ source: String) {
        mermaidCacheOrder.removeAll(where: { $0 == source })
        mermaidCacheOrder.append(source)
    }

    func projectFolderConflicts(folderURLs: [URL], excluding projectID: UUID?) throws -> [ProjectFolderConflict] {
        var paths: [String] = []
        for url in folderURLs {
            let path = try ProjectStore.canonicalDirectoryPath(url)
            if !paths.contains(path) { paths.append(path) }
        }
        return ProjectStore.conflicts(paths: paths, in: projects, excluding: projectID)
    }

    @discardableResult
    func saveProject(
        id: UUID?,
        name: String,
        folderURLs: [URL],
        moveConflicts: Bool
    ) async throws -> UUID {
        guard projectStoreWritable else { throw ProjectStoreError.unavailableAfterLoadFailure }
        let result = try ProjectStore.applying(
            projectID: id,
            name: name,
            folderURLs: folderURLs,
            to: projects,
            moveConflicts: moveConflicts
        )
        try await projectStore.save(result.projects)
        projects = result.projects
        selectedProjectID = result.savedProjectID
        expandedProjectIDs.insert(result.savedProjectID)
        inspectorScope = .project(result.savedProjectID)
        projectSessions.removeAll()
        projectHasMore.removeAll()
        projectSessionErrors.removeAll()
        projectWindows = Dictionary(uniqueKeysWithValues: projects.map { ($0.id, SessionListWindow()) })
        Task {
            for projectID in expandedProjectIDs where projects.contains(where: { $0.id == projectID }) {
                await reloadProjectSessions(projectID)
            }
        }
        return result.savedProjectID
    }

    func deleteProject(_ projectID: UUID) async throws {
        guard projectStoreWritable else { throw ProjectStoreError.unavailableAfterLoadFailure }
        let updated = projects.filter { $0.id != projectID }
        try await projectStore.save(updated)
        projects = updated
        projectSessions.removeValue(forKey: projectID)
        projectHasMore.removeValue(forKey: projectID)
        projectSessionErrors.removeValue(forKey: projectID)
        projectWindows.removeValue(forKey: projectID)
        expandedProjectIDs.remove(projectID)
        if selectedProjectID == projectID { selectedProjectID = nil }
        if inspectorScope == .project(projectID) {
            inspectorScope = selectedSessionID.map(InspectorScope.session)
        }
    }

    func loadProjects() async {
        do {
            projects = try await projectStore.load()
            projectStoreWritable = true
            expandedProjectIDs = []
            projectSessionErrors.removeAll()
        } catch {
            projects = []
            projectStoreWritable = false
            projectSessionErrors.removeAll()
            issue = AppIssue(
                title: "无法读取项目资料",
                message: "D Code 已保留原文件并停止项目写入。请检查或移走下面的文件后重新启动 D Code：\n\n\(projectStore.fileURL.path)\n\n\(DiagnosticSanitizer.redact(error.localizedDescription))"
            )
        }
    }

    func shutdown() async {
        refreshTask?.cancel()
        noticeTask?.cancel()
        resetExtensionUIState()
        await client?.shutdown()
        client = nil
        connectionState = .idle
    }

    func emergencyStop() {
        client?.lifecycle.terminate(expected: true)
    }

    @discardableResult
    private func openSession(_ id: String, writable: Bool) async -> Bool {
        guard let client = readyClient else { return false }
        let generation = UUID()
        openGeneration = generation
        isOpeningSession = true
        defer { if openGeneration == generation { isOpeningSession = false } }
        var params: [String: JSONValue] = [
            "sessionId": .string(id),
            "mode": .string(writable ? "writable" : "readOnly"),
        ]
        if writable { params["writeIntent"] = .bool(true) }
        do {
            let result: SessionOpenResult = try await client.request("session.open", params: params)
            guard openGeneration == generation else { return false }
            await apply(result)
            await loadRuntimeControls(includeCommands: writable)
            return true
        } catch {
            present(error, title: writable ? "暂时无法写入当前会话" : "无法打开会话")
            if writable { _ = await openSession(id, writable: false) }
            return false
        }
    }

    private func ensureWritable() async -> Bool {
        if canWrite { return true }
        guard let selectedSessionID, !isOpeningSession, !isStreaming else { return false }
        return await openSession(selectedSessionID, writable: true)
    }

    private func apply(_ result: SessionOpenResult) async {
        selectedSessionID = result.snapshot.summary.id
        inspectorScope = .session(result.snapshot.summary.id)
        inspection = result.snapshot
        hostState = result.state
        activePlan = ActivePlanParser.parse(result.state?.activePlan ?? result.snapshot.activePlan)
        isStreaming = result.state?.isStreaming ?? false
        clearStreamingPresentation()
        optimisticUserMessage = nil
        availableModels = []
        availableThinkingLevels = []
        availableCommands = []
        let entries = result.snapshot.entries
        transcript = await Task.detached(priority: .userInitiated) {
            TranscriptParser.parse(entries: entries)
        }.value
        if let errors = result.extensions?.errors, !errors.isEmpty {
            showNotice("有 \(errors.count) 个扩展未能加载；详情可在 Host 诊断中查看。", level: "warning")
        }
        if result.state == nil { Task { await refreshState() } }
    }

    private func loadRuntimeControls(includeCommands: Bool) async {
        guard let client = readyClient, let sessionID = selectedSessionID else { return }
        async let modelsRequest: ModelsResult = client.request("session.getModels")
        async let levelsRequest: ThinkingLevelsResult = client.request("session.getThinkingLevels")
        do {
            let (models, levels) = try await (modelsRequest, levelsRequest)
            guard selectedSessionID == sessionID else { return }
            availableModels = models.models
            availableThinkingLevels = levels.levels
        } catch {
            showNotice("当前会话的模型或思考强度选项未能加载。", level: "warning")
        }
        guard includeCommands, selectedSessionID == sessionID, canWrite else { return }
        do {
            let commands: CommandsResult = try await client.request("session.getCommands")
            guard selectedSessionID == sessionID else { return }
            availableCommands = commands.commands
        } catch {
            showNotice("当前会话的命令选项未能加载。", level: "warning")
        }
    }

    func applyRefreshedTranscript(_ parsed: [TranscriptItem]) {
        transcript = parsed
        optimisticUserMessage = nil
        if didEndStreamingAssistantMessage {
            streamingText = ""
            streamingThinking = ""
            streamingTools.removeAll(where: { !$0.isRunning })
            didEndStreamingAssistantMessage = false
        }
        if !isStreaming { clearStreamingPresentation() }
    }

    func markStreamingAssistantMessageEnded() {
        didEndStreamingAssistantMessage = true
    }

    private func clearStreamingPresentation() {
        streamingText = ""
        streamingThinking = ""
        streamingTools = []
        didEndStreamingAssistantMessage = false
    }

    private func clearActiveSessionPresentation() {
        selectedSessionID = nil
        inspection = nil
        transcript = []
        hostState = nil
        activePlan = nil
        optimisticUserMessage = nil
        isStreaming = false
        clearStreamingPresentation()
        availableModels = []
        availableThinkingLevels = []
        availableCommands = []
        pendingPrompt = nil
        resetExtensionUIState()
        inspectorScope = selectedProjectID.map(InspectorScope.project)
    }

    private func scheduleRefresh() {
        refreshTask?.cancel()
        refreshTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(140))
            guard !Task.isCancelled else { return }
            await self?.refreshSnapshot()
        }
    }

    private func refreshSnapshot() async {
        guard let client = readyClient, let sessionID = selectedSessionID else { return }
        do {
            let snapshot: SessionInspection = try await client.request("session.refresh")
            let entries = snapshot.entries
            let parsed = await Task.detached(priority: .utility) {
                TranscriptParser.parse(entries: entries)
            }.value
            guard selectedSessionID == sessionID else { return }
            inspection = snapshot
            applyRefreshedTranscript(parsed)
            replaceVisibleSummary(snapshot.summary)
            await refreshState()
        } catch {
            showNotice("会话已更新，但历史刷新失败：\(error.localizedDescription)", level: "warning")
        }
    }

    private func refreshState() async {
        guard let client = readyClient, let sessionID = selectedSessionID else { return }
        do {
            let state: HostState = try await client.request("session.getState")
            guard selectedSessionID == sessionID, state.sessionId == sessionID else { return }
            hostState = state
            activePlan = ActivePlanParser.parse(state.activePlan)
            isStreaming = state.isStreaming
        } catch {
            // A session can close between an event and this refresh; the next explicit action reports it.
        }
    }

    func handle(_ event: HostEvent) {
        switch event.name {
        case "session.closed":
            resetExtensionUIState()
        case "session.event":
            handleSessionEvent(event.data)
        case "session.promptCompleted":
            if let sessionID = event.data?["sessionId"]?.stringValue,
               let promptID = event.data?["promptId"]?.stringValue,
               pendingPrompt?.sessionID == sessionID,
               pendingPrompt?.promptID == promptID {
                pendingPrompt = nil
            }
        case "session.promptFailed":
            guard let sessionID = event.data?["sessionId"]?.stringValue,
                  let promptID = event.data?["promptId"]?.stringValue,
                  pendingPrompt?.sessionID == sessionID,
                  pendingPrompt?.promptID == promptID else { return }
            if selectedSessionID == sessionID {
                restorePendingPrompt(for: sessionID)
            }
            showNotice(event.data?["message"]?.stringValue ?? "本次输入未能完成，草稿仍保留。", level: "error")
        case "session.conflict":
            guard let sessionID = event.data?["sessionId"]?.stringValue,
                  sessionID == selectedSessionID else { return }
            isStreaming = false
            restorePendingPrompt(for: sessionID)
            showNotice("检测到 Pi 的新写入，D Code 已停止本次写入并切回持续同步；草稿已保留。", level: "warning")
            Task { [weak self] in await self?.resumeObservationAfterConflict(sessionID) }
        case "session.changed":
            guard event.data?["sessionId"]?.stringValue == selectedSessionID else { return }
            scheduleRefresh()
        case "session.syncError":
            guard event.data?["sessionId"]?.stringValue == selectedSessionID else { return }
            showNotice("暂时无法同步 Pi 会话：\(event.data?["message"]?.stringValue ?? "未知错误")", level: "warning")
        case "session.operationError", "extension.error":
            showNotice(event.data?["message"]?.stringValue ?? "扩展或会话操作失败。", level: "error")
        case "plan.changed":
            activePlan = ActivePlanParser.parse(event.data?["plan"])
            scheduleRefresh()
        case "extension.request":
            if let dialog = ExtensionDialog(data: event.data) { extensionDialogs.append(dialog) }
        case "extension.closed":
            if let id = event.data?["requestId"]?.stringValue {
                extensionDialogs.removeAll(where: { $0.id == id })
            }
        case "extension.notification":
            showNotice(event.data?["message"]?.stringValue ?? "扩展通知", level: event.data?["level"]?.stringValue ?? "info")
        case "extension.status":
            updateStatus(event.data)
        case "extension.working":
            workingMessage = event.data?["message"]?.stringValue
        case "extension.editorText":
            applyEditorText(event.data)
        case "extension.unsupported":
            guard event.data?["behavior"]?.stringValue == "blocked" else { return }
            let capability = event.data?["capability"]?.stringValue ?? "未知能力"
            issue = AppIssue(
                title: "当前交互无法完成",
                message: "当前会话请求了 D Code 尚未提供的交互：\(capability)。该操作未执行。"
            )
        case "host.stderr", "host.outputError", "protocol.decodeError":
            showNotice(event.data?["message"]?.stringValue ?? "Host 诊断事件", level: "error")
        case "host.processEnded":
            resetExtensionUIState()
            let expected = event.data?["expected"]?.boolValue ?? false
            connectionState = expected ? .idle : .failed
            if !expected {
                issue = AppIssue(title: "Pi Host 已停止", message: "会话连接已中断。重新打开应用即可尝试恢复。")
            }
        case "host.restartRequired":
            showNotice("会话运行时未能安全停止。D Code 已保留观察能力，但再次发送前需要重新打开应用。", level: "error")
        default:
            break
        }
    }

    private func handleSessionEvent(_ data: JSONValue?) {
        guard let type = data?["type"]?.stringValue else { return }
        switch type {
        case "agent_start":
            isStreaming = true
            clearStreamingPresentation()
        case "message_start":
            if data?["message"]?["role"]?.stringValue == "assistant" {
                streamingText = ""
                streamingThinking = ""
                didEndStreamingAssistantMessage = false
            }
        case "message_update":
            let update = data?["assistantMessageEvent"]
            switch update?["type"]?.stringValue {
            case "text_delta":
                didEndStreamingAssistantMessage = false
                streamingText += update?["delta"]?.stringValue ?? ""
            case "thinking_delta":
                didEndStreamingAssistantMessage = false
                streamingThinking += update?["delta"]?.stringValue ?? ""
            case "error":
                showNotice(update?["error"]?.stringValue ?? "模型流式响应失败。", level: "error")
            default:
                break
            }
        case "tool_execution_start":
            let id = data?["toolCallId"]?.stringValue ?? UUID().uuidString
            streamingTools.append(StreamingTool(
                id: id,
                name: data?["toolName"]?.stringValue ?? "Tool",
                details: data?["args"]?.prettyPrinted ?? "{}",
                isRunning: true,
                isError: false
            ))
        case "tool_execution_update":
            updateStreamingTool(data, finished: false)
        case "tool_execution_end":
            updateStreamingTool(data, finished: true)
        case "agent_end", "agent_settled":
            isStreaming = false
            scheduleRefresh()
        case "message_end":
            if data?["message"]?["role"]?.stringValue == "assistant" {
                markStreamingAssistantMessageEnded()
            }
            scheduleRefresh()
        case "thinking_level_changed", "session_info_changed", "compaction_end":
            scheduleRefresh()
        default:
            break
        }
    }

    private func updateStreamingTool(_ data: JSONValue?, finished: Bool) {
        guard let id = data?["toolCallId"]?.stringValue,
              let index = streamingTools.firstIndex(where: { $0.id == id }) else { return }
        if let partial = data?["partialResult"] { streamingTools[index].details = partial.prettyPrinted }
        if let result = data?["result"] { streamingTools[index].details = result.prettyPrinted }
        streamingTools[index].isRunning = !finished
        streamingTools[index].isError = data?["isError"]?.boolValue ?? false
    }

    private func updateStatus(_ data: JSONValue?) {
        guard let key = data?["key"]?.stringValue else { return }
        if let text = data?["text"]?.stringValue { extensionStatuses[key] = text }
        else { extensionStatuses.removeValue(forKey: key) }
    }

    private func resetExtensionUIState() {
        extensionDialogs.removeAll()
        extensionStatuses.removeAll()
        workingMessage = nil
    }

    private func resumeObservationAfterConflict(_ sessionID: String) async {
        guard selectedSessionID == sessionID else { return }
        _ = await openSession(sessionID, writable: false)
    }

    private func restorePendingPrompt(for sessionID: String) {
        guard let pendingPrompt, pendingPrompt.sessionID == sessionID else {
            optimisticUserMessage = nil
            return
        }
        if composerText.isEmpty {
            composerText = pendingPrompt.draft
        } else if composerText != pendingPrompt.draft {
            composerText = "\(pendingPrompt.draft)\n\n\(composerText)"
        }
        self.pendingPrompt = nil
        optimisticUserMessage = nil
    }

    private func replaceVisibleSummary(_ summary: SessionSummary) {
        if let index = recentSessions.firstIndex(where: { $0.id == summary.id }) {
            recentSessions[index] = summary
            recentSessions.sort { left, right in
                left.modified == right.modified ? left.id < right.id : left.modified > right.modified
            }
        }
        for projectID in Array(projectSessions.keys) {
            guard let index = projectSessions[projectID]?.firstIndex(where: { $0.id == summary.id }) else { continue }
            projectSessions[projectID]?[index] = summary
            projectSessions[projectID]?.sort { left, right in
                left.modified == right.modified ? left.id < right.id : left.modified > right.modified
            }
        }
    }

    private func applyEditorText(_ data: JSONValue?) {
        guard let text = data?["text"]?.stringValue else { return }
        if data?["mode"]?.stringValue == "paste" { composerText += text }
        else { composerText = text }
    }

    private func showNotice(_ message: String, level: String) {
        let notice = ExtensionNotice(message: DiagnosticSanitizer.redact(message), level: level)
        self.notice = notice
        noticeTask?.cancel()
        noticeTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(5))
            guard !Task.isCancelled, self?.notice?.id == notice.id else { return }
            self?.notice = nil
        }
    }

    private func present(_ error: Error, title: String) {
        issue = AppIssue(title: title, message: DiagnosticSanitizer.redact(error.localizedDescription))
    }
}
