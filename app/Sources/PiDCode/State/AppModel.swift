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
        case .ready: "Host 就绪"
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

struct SessionWorkspaceGroup: Identifiable, Equatable {
    let cwd: String
    let sessions: [SessionSummary]

    var id: String { cwd }
    var displayName: String { sessions.first?.projectName ?? cwd }

    static func ordered(from sessions: [SessionSummary]) -> [SessionWorkspaceGroup] {
        var order: [String] = []
        var grouped: [String: [SessionSummary]] = [:]
        for session in sessions {
            if grouped[session.cwd] == nil { order.append(session.cwd) }
            grouped[session.cwd, default: []].append(session)
        }
        return order.compactMap { cwd in
            grouped[cwd].map { SessionWorkspaceGroup(cwd: cwd, sessions: $0) }
        }
    }
}

@MainActor
@Observable
final class AppModel {
    var connectionState: HostConnectionState = .idle
    var hostHello: HostHello?
    var sessions: [SessionSummary] = []
    var selectedSessionID: String?
    var inspection: SessionInspection?
    var transcript: [TranscriptItem] = []
    var hostState: HostState?
    var activePlan: ActivePlanPresentation?
    var searchText = ""
    var composerText = ""
    var optimisticUserMessage: String?
    var streamingText = ""
    var streamingThinking = ""
    var streamingTools: [StreamingTool] = []
    var isStreaming = false
    var isLoadingSessions = false
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

    var filteredSessions: [SessionSummary] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !query.isEmpty else { return sessions }
        return sessions.filter {
            $0.displayTitle.lowercased().contains(query)
                || $0.cwd.lowercased().contains(query)
                || $0.id.lowercased().contains(query)
        }
    }

    var filteredSessionGroups: [SessionWorkspaceGroup] {
        SessionWorkspaceGroup.ordered(from: filteredSessions)
    }

    var selectedSummary: SessionSummary? {
        sessions.first(where: { $0.id == selectedSessionID })
    }

    var canWrite: Bool { hostState?.writable == true }

    var activeDialog: ExtensionDialog? { extensionDialogs.first }

    func start() async {
        guard client == nil else { return }
        connectionState = .connecting
        do {
            let configuration = try HostLocator.resolve()
            let client = PiHostClient(configuration: configuration) { [weak self] event in
                self?.handle(event)
            }
            self.client = client
            try await client.start()
            let hello: HostHello = try await client.request("host.hello")
            hostHello = hello
            connectionState = .ready
            await reloadSessions(selectFirst: true)
        } catch {
            connectionState = .failed
            present(error, title: "无法启动 D Code")
            client = nil
        }
    }

    func reloadSessions(selectFirst: Bool = false) async {
        guard let client else { return }
        isLoadingSessions = true
        defer { isLoadingSessions = false }
        do {
            let result: SessionListResult = try await client.request("session.list", params: ["limit": .number(60)])
            sessions = result.sessions
            if selectFirst, selectedSessionID == nil, let first = sessions.first {
                selectedSessionID = first.id
                await openSession(first.id, writable: false)
            }
        } catch {
            present(error, title: "无法读取 Pi 会话")
        }
    }

    func selectSession(_ sessionID: String?) async {
        guard let sessionID, sessionID != inspection?.summary.id else { return }
        selectedSessionID = sessionID
        await openSession(sessionID, writable: false)
    }

    func createSession(at directory: URL) async {
        guard let client else { return }
        isOpeningSession = true
        defer { isOpeningSession = false }
        do {
            let result: SessionOpenResult = try await client.request(
                "session.create",
                params: ["cwd": .string(directory.path)]
            )
            await apply(result)
            selectedSessionID = result.snapshot.summary.id
            await reloadSessions()
            await loadWritableControls()
        } catch {
            present(error, title: "无法创建会话")
        }
    }

    func takeOverCurrentSession() async {
        guard let selectedSessionID else { return }
        await openSession(selectedSessionID, writable: true)
    }

    func sendPrompt() async {
        guard let client, canWrite, !isSendingRequest else { return }
        let message = composerText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !message.isEmpty else { return }
        composerText = ""
        optimisticUserMessage = message
        isSendingRequest = true
        do {
            let _: Acknowledgement = try await client.request("session.prompt", params: ["message": .string(message)])
        } catch {
            if composerText.isEmpty { composerText = message }
            optimisticUserMessage = nil
            present(error, title: "发送失败")
        }
        isSendingRequest = false
    }

    func abort() async {
        guard let client, canWrite else { return }
        do {
            let _: Acknowledgement = try await client.request("session.abort")
        } catch {
            present(error, title: "无法停止当前运行")
        }
    }

    func setThinkingLevel(_ level: String) async {
        guard let client, canWrite else { return }
        do {
            let _: Acknowledgement = try await client.request("session.setThinking", params: ["level": .string(level)])
            await refreshState()
        } catch {
            present(error, title: "无法切换 Thinking level")
        }
    }

    func setModel(_ model: HostModel) async {
        guard let client, canWrite else { return }
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

    func respond(to dialog: ExtensionDialog, response: [String: JSONValue]) async {
        guard let client else { return }
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
        guard let client else { return .failure("Pi Host 尚未连接。") }
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

    private func openSession(_ id: String, writable: Bool) async {
        guard let client else { return }
        let generation = UUID()
        openGeneration = generation
        isOpeningSession = true
        defer { if openGeneration == generation { isOpeningSession = false } }
        var params: [String: JSONValue] = [
            "sessionId": .string(id),
            "mode": .string(writable ? "writable" : "readOnly"),
        ]
        if writable { params["exclusiveUseConfirmed"] = .bool(true) }
        do {
            let result: SessionOpenResult = try await client.request("session.open", params: params)
            guard openGeneration == generation else { return }
            await apply(result)
            if writable { await loadWritableControls() }
        } catch {
            present(error, title: writable ? "无法继续会话" : "无法打开会话")
            if writable { await openSession(id, writable: false) }
        }
    }

    private func apply(_ result: SessionOpenResult) async {
        inspection = result.snapshot
        hostState = result.state
        activePlan = ActivePlanParser.parse(result.state?.activePlan ?? result.snapshot.activePlan)
        isStreaming = result.state?.isStreaming ?? false
        clearStreamingPresentation()
        optimisticUserMessage = nil
        let entries = result.snapshot.entries
        transcript = await Task.detached(priority: .userInitiated) {
            TranscriptParser.parse(entries: entries)
        }.value
        if let errors = result.extensions?.errors, !errors.isEmpty {
            showNotice("有 \(errors.count) 个扩展未能加载；详情可在 Host 诊断中查看。", level: "warning")
        }
        if result.state == nil { Task { await refreshState() } }
    }

    private func loadWritableControls() async {
        guard let client, canWrite else { return }
        async let modelsRequest: ModelsResult = client.request("session.getModels")
        async let levelsRequest: ThinkingLevelsResult = client.request("session.getThinkingLevels")
        async let commandsRequest: CommandsResult = client.request("session.getCommands")
        do {
            let (models, levels, commands) = try await (modelsRequest, levelsRequest, commandsRequest)
            availableModels = models.models
            availableThinkingLevels = levels.levels
            availableCommands = commands.commands
        } catch {
            showNotice("会话已接管，但部分模型或命令信息未能加载。", level: "warning")
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

    private func scheduleRefresh() {
        refreshTask?.cancel()
        refreshTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(140))
            guard !Task.isCancelled else { return }
            await self?.refreshSnapshot()
        }
    }

    private func refreshSnapshot() async {
        guard let client, let sessionID = selectedSessionID else { return }
        do {
            let snapshot: SessionInspection = try await client.request(
                "session.inspect",
                params: ["sessionId": .string(sessionID)]
            )
            let entries = snapshot.entries
            let parsed = await Task.detached(priority: .utility) {
                TranscriptParser.parse(entries: entries)
            }.value
            guard selectedSessionID == sessionID else { return }
            inspection = snapshot
            applyRefreshedTranscript(parsed)
            await refreshState()
            await reloadSessions()
        } catch {
            showNotice("会话已更新，但历史刷新失败：\(error.localizedDescription)", level: "warning")
        }
    }

    private func refreshState() async {
        guard let client, selectedSessionID != nil else { return }
        do {
            let state: HostState = try await client.request("session.getState")
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
        case "session.conflict":
            isStreaming = false
            issue = AppIssue(
                title: "会话写入权已暂停",
                message: DiagnosticSanitizer.redact(
                    event.data?["message"]?.stringValue ?? "检测到其他客户端写入。D Code 已停止继续写入，请先确认会话所有权。"
                )
            )
            scheduleRefresh()
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
            let capability = event.data?["capability"]?.stringValue ?? "未知能力"
            let behavior = event.data?["behavior"]?.stringValue == "blocked" ? "已阻止" : "已忽略"
            showNotice("扩展界面能力 \(capability) 不受支持，操作\(behavior)。D Code 不渲染 Pi TUI。", level: "warning")
        case "host.stderr", "host.outputError", "protocol.decodeError":
            showNotice(event.data?["message"]?.stringValue ?? "Host 诊断事件", level: "error")
        case "host.processEnded":
            resetExtensionUIState()
            let expected = event.data?["expected"]?.boolValue ?? false
            connectionState = expected ? .idle : .failed
            if !expected {
                issue = AppIssue(title: "Pi Host 已停止", message: "会话连接已中断。重新打开应用即可尝试恢复。")
            }
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
