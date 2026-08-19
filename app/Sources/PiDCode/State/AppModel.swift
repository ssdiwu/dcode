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

    var sidebarLabel: String? {
        switch self {
        case .idle: "未连接"
        case .connecting: "正在连接"
        case .ready: nil
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
    let draftTarget: SessionDraftTarget?
    let followUpQueueID: String?
    let followUpItemID: String?

    init(
        sessionID: String,
        promptID: String,
        draft: String,
        draftTarget: SessionDraftTarget? = nil,
        followUpQueueID: String? = nil,
        followUpItemID: String? = nil
    ) {
        self.sessionID = sessionID
        self.promptID = promptID
        self.draft = draft
        self.draftTarget = draftTarget
        self.followUpQueueID = followUpQueueID
        self.followUpItemID = followUpItemID
    }

    var isFollowUpDispatch: Bool { followUpQueueID != nil && followUpItemID != nil }
}

struct PendingSteerDraft: Equatable {
    let sessionID: String
    let runID: String
    let steerID: String
    let draft: String
    let draftTarget: SessionDraftTarget?
    var accepted: Bool
}

@MainActor
@Observable
final class AppModel {
    static let maximumStreamingThinkingUTF16Count = 100_000
    private static let truncatedStreamingThinkingPrefix = "…较早的实时思考已省略…\n\n"

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
    var workbenchDestination: WorkbenchDestination = .workspace
    var workspaceTabSelection: WorkspaceTabSelection = .conversation
    var workspaceFileTabs: [WorkspaceFileTab] = []
    var selectedSessionID: String?
    var inspection: SessionInspection?
    var transcript: [TranscriptItem] = []
    var conversationRounds: [ConversationRound] = []
    var conversationNavigationItems: [ConversationNavigationItem] = []
    var hostState: HostState?
    var activePlan: ActivePlanPresentation?
    var composerText = ""
    private(set) var newSessionDraft: NewSessionDraft?
    private(set) var isNewSessionDraftActive = false
    var optimisticUserMessage: String?
    var streamingText = ""
    var streamingThinking = ""
    var streamingTools: [StreamingTool] = []
    var isStreaming = false
    var isLoadingRecentSessions = false
    var loadingProjectIDs: Set<UUID> = []
    var isOpeningSession = false
    var isCreatingSession = false
    var isSendingRequest = false
    var issue: AppIssue?
    var notice: ExtensionNotice?
    var extensionDialogs: [ExtensionDialog] = []
    var extensionStatuses: [String: String] = [:]
    var workingMessage: String?
    var availableModels: [HostModel] = []
    var isLoadingNewSessionModels = false
    var newSessionModelIssue: String?
    var modelSettings: ModelSettingsSnapshot?
    var isLoadingModelSettings = false
    var isMutatingModelSettings = false
    var modelSettingsError: String?
    var modelAuthFlow: ModelAuthFlow?
    private(set) var newSessionDefaultModel: HostModel?
    private(set) var newSessionDefaultThinkingLevel: String?
    var availableThinkingLevels: [String] = []
    var availableCommands: [CommandDescriptor] = []
    var searchPresented = false
    var searchQuery = ""
    var searchProjectID: UUID?
    var searchSourceFolderPath: String?
    var searchIndexStatus: SessionSearchIndexStatus = .idle
    var searchResults: [SessionSearchResult] = []
    var searchSelection = 0
    var searchError: String?
    var searchOpenError: String?
    var isSearchQuerying = false
    var conversationTarget: ConversationTarget?
    var archivedSessions: [ArchivedSessionRecord] = []
    var pinnedSessions: [PinnedSessionRecord] = []
    var pinnedSessionPresentations: [PinnedSessionPresentation] = []
    var sidebarProjection: SidebarProjection = .navigation
    var activitySessions: [SessionSummary] = []
    var isLoadingActivitySessions = false
    var activitySessionError: String?
    var currentRunState: SessionRunState?
    var activityAttentionRecords: [ActivityAttentionRecord] = []
    var activityAttentionIssue: String?
    var sessionChangeSummary: SessionChangeSummary?
    var currentDraftTarget: SessionDraftTarget?
    var isCopyingSession = false
    var isTrashingSession = false
    var isRenamingSession = false
    var isMutatingArchive = false
    var isMutatingPins = false
    var pendingArchiveRetry: ArchivedSessionRecord?
    var draftStoreIssue: String?
    var followUpQueues: [FollowUpQueueRecord] = []
    var followUpQueueIssue: String?
    var isMutatingFollowUpQueue = false
    var pendingSteer: PendingSteerDraft?
    private var isSettlingFollowUpRun = false
    var pathSheetPresented = false
    var copySheetMode: SessionCopyMode?
    var pendingTrashSession: SessionSummary?

    @ObservationIgnored private var client: PiHostClient?
    @ObservationIgnored private var refreshTask: Task<Void, Never>?
    @ObservationIgnored private var openGeneration = UUID()
    @ObservationIgnored private var newSessionModelLoadGeneration = UUID()
    @ObservationIgnored private var modelSettingsLoadGeneration = UUID()
    @ObservationIgnored private var snapshotCommitGeneration = UUID()
    @ObservationIgnored private var noticeTask: Task<Void, Never>?
    @ObservationIgnored private var mermaidCache: [String: MermaidRenderResult] = [:]
    @ObservationIgnored private var mermaidCacheOrder: [String] = []
    @ObservationIgnored private var mermaidTasks: [String: Task<MermaidRenderResult, Never>] = [:]
    @ObservationIgnored private var didEndStreamingAssistantMessage = false
    @ObservationIgnored private var separatesNextThinkingDelta = false
    @ObservationIgnored private var workspaceFileLoadIDs: [String: UUID] = [:]
    var pendingPrompt: PendingPromptDraft?
    @ObservationIgnored private let projectStore: ProjectStore
    @ObservationIgnored private let sessionDraftStore: SessionDraftStore
    @ObservationIgnored private let sessionArchiveStore: SessionArchiveStore
    @ObservationIgnored private let sessionPinStore: SessionPinStore
    @ObservationIgnored private let sessionChangeStore: SessionChangeStore
    @ObservationIgnored private let followUpQueueStore: FollowUpQueueStore
    @ObservationIgnored private let activityAttentionStore: ActivityAttentionStore
    @ObservationIgnored private let hostConfiguration: HostLaunchConfiguration?
    @ObservationIgnored private var projectStoreWritable = false
    @ObservationIgnored private var sessionDraftStoreWritable = false
    @ObservationIgnored private var sessionArchiveStoreWritable = false
    @ObservationIgnored private var sessionPinStoreWritable = false
    @ObservationIgnored private var sessionChangeStoreWritable = false
    @ObservationIgnored private var followUpQueueStoreWritable = false
    @ObservationIgnored private var activityAttentionStoreWritable = false
    @ObservationIgnored private var draftDocument = SessionDraftDocument()
    @ObservationIgnored private var draftSaveTask: Task<Void, Never>?
    @ObservationIgnored private var draftRevision = 0
    @ObservationIgnored private var sessionChangeDocument = SessionChangeDocument()
    @ObservationIgnored private var sessionChangeSaveTask: Task<Void, Never>?
    @ObservationIgnored private var sessionChangeRevision = 0
    @ObservationIgnored private var followUpQueueRevision = 0
    @ObservationIgnored private var activityAttentionRevision = 0
    @ObservationIgnored private var activityAttentionSaveTask: Task<Void, Never>?
    @ObservationIgnored private var currentSessionRunID: String?
    @ObservationIgnored private var followUpSettlementTask: Task<Void, Never>?
    @ObservationIgnored private var followUpSettlementGeneration = UUID()
    @ObservationIgnored private var followUpSettlementRunID: String?
    @ObservationIgnored private var isShuttingDown = false
    @ObservationIgnored private var deferredComposerText: String?
    @ObservationIgnored private var visibilityGeneration = UUID()
    @ObservationIgnored private var recentWindow = SessionListWindow()
    @ObservationIgnored private var projectWindows: [UUID: SessionListWindow] = [:]
    @ObservationIgnored private var projectLoadGenerations: [UUID: UUID] = [:]
    @ObservationIgnored private var searchTask: Task<Void, Never>?
    @ObservationIgnored private var searchProbeTask: Task<Void, Never>?
    @ObservationIgnored private var searchGeneration = UUID()
    @ObservationIgnored private var searchResultGeneration: UUID?
    @ObservationIgnored private var shutdownTask: Task<Void, Never>?

    init(
        projectStore: ProjectStore = ProjectStore(),
        sessionDraftStore: SessionDraftStore = SessionDraftStore(),
        sessionArchiveStore: SessionArchiveStore = SessionArchiveStore(),
        sessionPinStore: SessionPinStore = SessionPinStore(),
        sessionChangeStore: SessionChangeStore = SessionChangeStore(),
        followUpQueueStore: FollowUpQueueStore = FollowUpQueueStore(),
        activityAttentionStore: ActivityAttentionStore = ActivityAttentionStore(),
        hostConfiguration: HostLaunchConfiguration? = nil
    ) {
        self.projectStore = projectStore
        self.sessionDraftStore = sessionDraftStore
        self.sessionArchiveStore = sessionArchiveStore
        self.sessionPinStore = sessionPinStore
        self.sessionChangeStore = sessionChangeStore
        self.followUpQueueStore = followUpQueueStore
        self.activityAttentionStore = activityAttentionStore
        self.hostConfiguration = hostConfiguration
    }

    static func recentSessionListParameters(
        limit: Int,
        excludedSessionIDs: [String] = [],
        sessionIDs: [String] = []
    ) -> [String: JSONValue] {
        var parameters: [String: JSONValue] = [
            "limit": .number(Double(limit)),
            "origin": .string("dcode"),
            "excludedSessionIds": .array(excludedSessionIDs.map(JSONValue.string)),
        ]
        if !sessionIDs.isEmpty {
            parameters["sessionIds"] = .array(sessionIDs.map(JSONValue.string))
        }
        return parameters
    }

    var archivedSessionIDs: [String] { archivedSessions.map(\.sessionID).sorted() }

    var pinnedSessionIDs: [String] { pinnedSessions.map(\.sessionID).sorted() }

    var isPromptTransactionActive: Bool {
        isCreatingSession
            || isSendingRequest
            || pendingPrompt != nil
            || isMutatingArchive
            || isSettlingFollowUpRun
            || pendingSteer != nil
            || hasActiveRun
            || currentRunState?.phase == .unknown
    }

    var hasActiveRun: Bool {
        isStreaming || currentRunState?.phase.isActive == true
    }

    var canPersistSessionDrafts: Bool { sessionDraftStoreWritable && draftStoreIssue == nil }

    var currentFollowUpQueue: FollowUpQueueRecord? {
        guard let sessionID = selectedSessionID else { return nil }
        let document = FollowUpQueueDocument(queues: followUpQueues)
        guard let index = document.matchingQueueIndex(
            sessionID: sessionID,
            currentPathID: currentPathIdentity,
            orderedPathEntryIDs: currentPathEntryIDs
        ) else { return nil }
        return followUpQueues[index]
    }

    var activitySections: [ActivitySection] {
        ActivityProjection.sections(
            sessions: activitySessions,
            runState: currentRunState,
            attentionRecords: activityAttentionRecords
        )
    }

    var hasUnseenActivity: Bool {
        let visibleIDs = Set(recentSessions.map(\.id))
            .union(pinnedSessionPresentations.map(\.id))
            .union(projectSessions.values.flatMap { $0.map(\.id) })
            .union(activitySessions.map(\.id))
        return activityAttentionRecords.contains(where: {
            $0.isUnseen && visibleIDs.contains($0.sessionID)
        })
    }

    var canSafelyRetryCurrentRun: Bool {
        guard currentRunState?.phase == .failed,
              currentRunState?.retryable == true,
              currentRunState?.inputPersisted == false,
              pendingPrompt == nil else { return false }
        return !composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var currentPathEntryIDs: [String] {
        var entryIDs = inspection?.entries.compactMap { $0["id"]?.stringValue } ?? []
        if let targetEntryID = currentDraftTarget?.pathID.flatMap(Self.entryID(fromPathID:)),
           !entryIDs.contains(targetEntryID) {
            entryIDs.append(targetEntryID)
        } else if let leafID = inspection?.leafId, !entryIDs.contains(leafID) {
            entryIDs.append(leafID)
        }
        return entryIDs
    }

    var currentLineageEntryID: String? {
        if let targetEntryID = currentDraftTarget?.pathID.flatMap(Self.entryID(fromPathID:)) {
            return targetEntryID
        }
        if let leafID = inspection?.leafId { return leafID }
        if let selectedEntryID = Self.entryID(fromPathID: inspection?.selectedPathId) {
            return selectedEntryID
        }
        return currentPathEntryIDs.last
    }

    var currentPathIdentity: String? {
        inspection?.selectedPathId ?? currentDraftTarget?.pathID
    }

    private static func entryID(fromPathID pathID: String?) -> String? {
        guard let pathID, pathID.hasPrefix("leaf:"), pathID.count > 5 else { return nil }
        return String(pathID.dropFirst(5))
    }

    var shouldQueueComposerText: Bool {
        hasActiveRun || currentFollowUpQueue != nil
    }

    var canSubmitComposerText: Bool {
        canSubmitComposerText(deliveryMode: .queue)
    }

    func canSubmitComposerText(deliveryMode: RunningMessageDeliveryMode) -> Bool {
        let text = composerText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty,
              readyClient != nil,
              !isCreatingSession,
              !isSendingRequest,
              pendingPrompt == nil,
              pendingSteer == nil,
              !isMutatingFollowUpQueue,
              currentRunState?.phase != .unknown else { return false }
        if isNewSessionDraftActive {
            return !hasActiveRun
                && !isLoadingNewSessionModels
                && newSessionModelIssue == nil
                && selectedNewSessionModel != nil
        }
        guard selectedSessionID != nil else { return false }
        if hasActiveRun, deliveryMode == .steer {
            return canWrite
                && isStreaming
                && currentRunState?.phase == .running
                && extensionDialogs.isEmpty
                && pendingPathDraft == nil
                && !text.hasPrefix("/")
                && canPersistSessionDrafts
        }
        if shouldQueueComposerText {
            return followUpQueueStoreWritable
                && followUpQueueIssue == nil
                && pendingPathDraft == nil
                && !text.hasPrefix("/")
                && currentLineageEntryID != nil
        }
        return !hasActiveRun
    }

    var selectedPath: SessionPathSummary? {
        guard let inspection else { return nil }
        return inspection.paths.first(where: { $0.id == inspection.selectedPathId })
    }

    var pendingPathDraft: SessionPathAction? { currentDraftTarget?.pathAction }

    func canTrashSession(_ session: SessionSummary) -> Bool {
        session.messageCount == 0
            && (
                recentSessions.contains(where: { $0.id == session.id })
                    || pinnedSessionPresentations.first(where: { $0.id == session.id })?.isRecent == true
            )
            && !archivedSessions.contains(where: { $0.sessionID == session.id })
            && !(selectedSessionID == session.id && hostState?.writable == true)
            && !followUpQueues.contains(where: { $0.sessionID == session.id && !$0.items.isEmpty })
    }

    func isSessionPinned(_ sessionID: String) -> Bool {
        pinnedSessions.contains(where: { $0.sessionID == sessionID })
    }

    func canToggleSessionPin(_ session: SessionSummary) -> Bool {
        sessionPinStoreWritable
            && !isMutatingPins
            && !archivedSessions.contains(where: { $0.sessionID == session.id })
            && isSessionVisible(session.id)
    }

    func canArchiveSession(_ session: SessionSummary) -> Bool {
        sessionArchiveStoreWritable
            && !isMutatingArchive
            && !isCopyingSession
            && !isTrashingSession
            && !isStreaming
            && !isOpeningSession
            && !isPromptTransactionActive
            && !archivedSessions.contains(where: { $0.sessionID == session.id })
            && pendingArchiveRetry?.sessionID != session.id
            && isSessionVisible(session.id)
    }

    var canRenameSelectedSession: Bool {
        guard let selectedSessionID else { return false }
        return readyClient != nil
            && !isRenamingSession
            && !isOpeningSession
            && !isStreaming
            && !isCopyingSession
            && !isTrashingSession
            && !isMutatingArchive
            && !isPromptTransactionActive
            && !archivedSessions.contains(where: { $0.sessionID == selectedSessionID })
    }

    var selectedSummary: SessionSummary? {
        guard let selectedSessionID else { return nil }
        if inspection?.summary.id == selectedSessionID { return inspection?.summary }
        if let recent = recentSessions.first(where: { $0.id == selectedSessionID }) { return recent }
        if let pinned = pinnedSessionPresentations.first(where: { $0.id == selectedSessionID }) {
            return pinned.summary
        }
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

    var newSessionDraftDirectoryPath: String? {
        isNewSessionDraftActive ? newSessionDraft?.directoryPath : nil
    }

    var selectedNewSessionModel: HostModel? {
        guard isNewSessionDraftActive,
              let selection = newSessionDraft?.selectedModel else { return nil }
        return availableModels.first(where: selection.matches)
    }

    var composerModel: HostModel? {
        isNewSessionDraftActive ? selectedNewSessionModel : hostState?.model
    }

    var composerThinkingLevels: [String] {
        if isNewSessionDraftActive {
            if let levels = composerModel?.thinkingLevels, !levels.isEmpty { return levels }
            return composerModel?.reasoning == false
                ? ["off"]
                : ["off", "minimal", "low", "medium", "high"]
        }
        return availableThinkingLevels
    }

    var composerThinkingLevel: String? {
        if isNewSessionDraftActive {
            guard composerModel != nil else { return nil }
            return newSessionDraft?.selectedThinkingLevel
                ?? Self.normalizedThinkingLevel(newSessionDefaultThinkingLevel, levels: composerThinkingLevels)
        }
        return hostState?.thinkingLevel
    }

    var composerFastModeEnabled: Bool {
        isNewSessionDraftActive
            ? (newSessionDraft?.fastModeEnabled ?? false)
            : (hostState?.fastMode?.enabled ?? false)
    }

    var composerFastModeSupported: Bool {
        composerModel?.fastModeSupported == true
    }

    @ObservationIgnored private var readyClient: PiHostClient? {
        canUseHostSessions ? client : nil
    }

    var isLoadingSessions: Bool {
        isLoadingRecentSessions || !loadingProjectIDs.isEmpty || isLoadingActivitySessions
    }

    var activeDialog: ExtensionDialog? { extensionDialogs.first }

    func sessions(for project: DCodeProject) -> [SessionSummary] {
        projectSessions[project.id, default: []]
    }

    private func isSessionVisible(_ sessionID: String) -> Bool {
        recentSessions.contains(where: { $0.id == sessionID })
            || pinnedSessionPresentations.contains(where: { $0.id == sessionID })
            || projectSessions.values.contains(where: { sessions in
                sessions.contains(where: { $0.id == sessionID })
            })
            || selectedSessionID == sessionID
    }

    func sourceFolderName(for session: SessionSummary, in project: DCodeProject) -> String {
        let sessionPath = URL(fileURLWithPath: session.cwd).standardizedFileURL.resolvingSymlinksInPath().path
        return project.sourceFolders.first(where: { $0.path == sessionPath })?.displayName
            ?? URL(fileURLWithPath: session.cwd).lastPathComponent
    }

    func projectOwnership(for session: SessionSummary) -> ProjectSessionOwnership? {
        ProjectSessionOwnershipResolver.resolve(cwd: session.cwd, projects: projects)
    }

    var allProjectSourceFolderPaths: [String] {
        projects.flatMap { $0.sourceFolders.map(\.path) }
    }

    func ownership(for result: SessionSearchResult) -> SearchResultOwnership {
        let canonical = URL(fileURLWithPath: result.cwd).standardizedFileURL.resolvingSymlinksInPath().path
        for project in projects {
            if let folder = project.sourceFolders.first(where: { $0.path == canonical }) {
                return SearchResultOwnership(projectName: project.name, sourceFolderName: folder.displayName)
            }
        }
        return SearchResultOwnership(projectName: nil, sourceFolderName: nil)
    }

    func start() async {
        guard connectionState == .idle, client == nil else { return }
        connectionState = .connecting
        await loadProjects()
        guard await loadSessionMetadata() else {
            connectionState = .failed
            return
        }
        do {
            let configuration: HostLaunchConfiguration
            if let hostConfiguration {
                configuration = hostConfiguration
            } else {
                configuration = try HostLocator.resolve()
            }
            let client = PiHostClient(configuration: configuration) { [weak self] event in
                self?.handle(event)
            }
            self.client = client
            try await client.start()
            let hello: HostHello = try await client.request("host.hello")
            try HostCompatibility.validate(hello)
            hostHello = hello
            connectionState = .ready
            await reloadAllSessionLists()
        } catch {
            connectionState = .failed
            present(error, title: "无法启动 D Code")
            await client?.shutdown()
            client = nil
        }
    }

    func reloadPinnedSessionPresentations() async {
        let records = pinnedSessions
        guard !records.isEmpty else {
            pinnedSessionPresentations = []
            return
        }
        guard let client = readyClient else { return }

        let ids = records.map(\.sessionID).sorted()
        let excludedSessionIDs = archivedSessionIDs
        let sourcePaths = Array(Set(allProjectSourceFolderPaths)).sorted()
        let projectSnapshot = projects
        let generation = visibilityGeneration

        do {
            let recent: SessionListResult = try await client.request(
                "session.list",
                params: Self.recentSessionListParameters(
                    limit: ids.count,
                    excludedSessionIDs: excludedSessionIDs,
                    sessionIDs: ids
                )
            )
            var projectCandidates: [SessionSummary] = []
            for chunkStart in stride(from: 0, to: sourcePaths.count, by: 64) {
                try Task.checkCancellation()
                let chunk = Array(sourcePaths[chunkStart..<min(chunkStart + 64, sourcePaths.count)])
                let result: SessionListResult = try await client.request("session.list", params: [
                    "limit": .number(Double(ids.count)),
                    "cwdScope": .object([
                        "match": .string("exact"),
                        "paths": .array(chunk.map(JSONValue.string)),
                    ]),
                    "sessionIds": .array(ids.map(JSONValue.string)),
                    "excludedSessionIds": .array(excludedSessionIDs.map(JSONValue.string)),
                ])
                projectCandidates.append(contentsOf: result.sessions)
            }
            try Task.checkCancellation()
            guard generation == visibilityGeneration,
                  projectSnapshot == projects,
                  records == pinnedSessions else { return }
            pinnedSessionPresentations = PinnedSessionPresentationBuilder.build(
                recentSessions: recent.sessions,
                projectSessions: projectCandidates,
                projects: projectSnapshot,
                pinnedRecords: records
            )
        } catch is CancellationError {
            return
        } catch {
            present(error, title: "无法读取置顶会话")
        }
    }

    func reloadRecentSessions() async {
        guard let client = readyClient else { return }
        let excludedSessionIDs = Array(Set(archivedSessionIDs + pinnedSessionIDs)).sorted()
        let generation = visibilityGeneration
        isLoadingRecentSessions = true
        defer { isLoadingRecentSessions = false }
        do {
            let result: SessionListResult = try await client.request(
                "session.list",
                params: Self.recentSessionListParameters(
                    limit: recentWindow.requestLimit,
                    excludedSessionIDs: excludedSessionIDs
                )
            )
            guard generation == visibilityGeneration else { return }
            let page = recentWindow.page(from: result.sessions)
            recentSessions = page.items
            recentHasMore = page.hasMore
        } catch is CancellationError {
            return
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
        let excludedSessionIDs = Array(Set(archivedSessionIDs + pinnedSessionIDs)).sorted()
        let visibilityAtStart = visibilityGeneration
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
                try Task.checkCancellation()
                let chunk = Array(sourcePaths[chunkStart..<min(chunkStart + 64, sourcePaths.count)])
                let result: SessionListResult = try await client.request("session.list", params: [
                    "limit": .number(Double(window.requestLimit)),
                    "cwdScope": .object([
                        "match": .string("exact"),
                        "paths": .array(chunk.map(JSONValue.string)),
                    ]),
                    "excludedSessionIds": .array(excludedSessionIDs.map(JSONValue.string)),
                ])
                try Task.checkCancellation()
                for session in result.sessions {
                    if let existing = merged[session.id], existing.modified >= session.modified { continue }
                    merged[session.id] = session
                }
            }
            guard projectLoadGenerations[projectID] == generation,
                  visibilityGeneration == visibilityAtStart,
                  projects.first(where: { $0.id == projectID })?.sourceFolders.map(\.path) == sourcePaths else { return }
            let ordered = SessionPinOrdering.ordered(Array(merged.values), pinnedRecords: [])
            let page = window.page(from: ordered)
            projectSessions[projectID] = page.items
            projectHasMore[projectID] = page.hasMore
            projectSessionErrors.removeValue(forKey: projectID)
        } catch is CancellationError {
            return
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
        await reloadPinnedSessionPresentations()
        await reloadRecentSessions()
        let reloadIDs = Set(projectSessions.keys).union(expandedProjectIDs)
        for project in projects where reloadIDs.contains(project.id) {
            await reloadProjectSessions(project.id)
        }
        if sidebarProjection == .activity || activityAttentionRecords.contains(where: \.isUnseen) {
            await reloadActivitySessions()
        }
    }

    func toggleSidebarProjection() async {
        if sidebarProjection == .activity {
            sidebarProjection = .navigation
            return
        }
        sidebarProjection = .activity
        await reloadActivitySessions()
    }

    func reloadActivitySessions() async {
        guard let client = readyClient, !isLoadingActivitySessions else { return }
        isLoadingActivitySessions = true
        activitySessionError = nil
        defer { isLoadingActivitySessions = false }
        let excludedSessionIDs = archivedSessionIDs
        let sourcePaths = Array(Set(allProjectSourceFolderPaths)).sorted()
        let visibilityAtStart = visibilityGeneration
        do {
            let recent: SessionListResult = try await client.request(
                "session.list",
                params: Self.recentSessionListParameters(
                    limit: 10_000,
                    excludedSessionIDs: excludedSessionIDs
                )
            )
            var groups = [recent.sessions]
            for chunkStart in stride(from: 0, to: sourcePaths.count, by: 64) {
                try Task.checkCancellation()
                let chunk = Array(sourcePaths[chunkStart..<min(chunkStart + 64, sourcePaths.count)])
                let project: SessionListResult = try await client.request("session.list", params: [
                    "limit": .number(10_000),
                    "cwdScope": .object([
                        "match": .string("exact"),
                        "paths": .array(chunk.map(JSONValue.string)),
                    ]),
                    "excludedSessionIds": .array(excludedSessionIDs.map(JSONValue.string)),
                ])
                groups.append(project.sessions)
            }
            guard visibilityGeneration == visibilityAtStart,
                  archivedSessionIDs == excludedSessionIDs,
                  Array(Set(allProjectSourceFolderPaths)).sorted() == sourcePaths else { return }
            activitySessions = SessionPinOrdering.mergedAndOrdered(groups, pinnedRecords: [])
            activitySessionError = nil
        } catch is CancellationError {
            return
        } catch {
            activitySessionError = DiagnosticSanitizer.redact(error.localizedDescription)
            showNotice("活动会话暂时无法完整载入。", level: "warning")
        }
    }

    func selectProject(_ projectID: UUID) async {
        parkNewSessionDraft()
        workbenchDestination = .workspace
        selectedProjectID = projectID
        inspectorScope = .project(projectID)
        expandedProjectIDs.insert(projectID)
    }

    func presentArchivedSessions() {
        dismissSearch()
        parkNewSessionDraft()
        workbenchDestination = .settings(.archivedSessions)
    }

    func dismissArchivedSessions() {
        workbenchDestination = .settings(.appearance)
    }

    func presentSettings(_ page: SettingsPage = .appearance) {
        dismissSearch()
        parkNewSessionDraft()
        workbenchDestination = .settings(page)
    }

    func dismissSettings() {
        workbenchDestination = .workspace
    }

    var modelSettingsCwd: String {
        if let selectedSessionID,
           let cwd = inspection?.summary.id == selectedSessionID ? inspection?.summary.cwd : selectedSummary?.cwd {
            return cwd
        }
        if selectedSessionID == nil, let draftPath = newSessionDraft?.directoryPath {
            return draftPath
        }
        if let projectPath = selectedProject?.sourceFolders.first?.path {
            return projectPath
        }
        return FileManager.default.homeDirectoryForCurrentUser.path
    }

    func reloadModelSettings(refreshCatalog: Bool = false) async {
        guard let client = readyClient else {
            modelSettingsError = "Pi Host 尚未就绪，暂时无法读取模型设置。"
            return
        }
        let cwd = modelSettingsCwd
        let generation = UUID()
        modelSettingsLoadGeneration = generation
        isLoadingModelSettings = true
        modelSettingsError = nil
        defer {
            if modelSettingsLoadGeneration == generation {
                isLoadingModelSettings = false
            }
        }
        do {
            let result: ModelSettingsSnapshot = try await client.request(
                refreshCatalog ? "modelSettings.refresh" : "modelSettings.get",
                params: ["cwd": .string(cwd)]
            )
            guard modelSettingsLoadGeneration == generation, modelSettingsCwd == cwd else { return }
            modelSettings = result
        } catch {
            guard modelSettingsLoadGeneration == generation else { return }
            modelSettingsError = DiagnosticSanitizer.redact(error.localizedDescription)
        }
    }

    func updateGlobalEnabledModels(_ rules: [String]) async {
        guard let client = readyClient,
              !isLoadingModelSettings,
              !isMutatingModelSettings else { return }
        let cwd = modelSettingsCwd
        isMutatingModelSettings = true
        modelSettingsError = nil
        defer { isMutatingModelSettings = false }
        do {
            let normalized = ModelSettingsRulePolicy.normalized(rules)
            let result: ModelSettingsSnapshot = try await client.request(
                "modelSettings.setEnabledModels",
                params: [
                    "cwd": .string(cwd),
                    "enabledModels": .array(normalized.map(JSONValue.string)),
                ]
            )
            guard modelSettingsCwd == cwd else { return }
            modelSettings = result
            await reloadModelChoicesAfterSettingsChange()
        } catch {
            if modelSettingsCwd == cwd {
                modelSettingsError = DiagnosticSanitizer.redact(error.localizedDescription)
            }
        }
    }

    func updateGlobalDefaultModel(_ model: HostModel) async {
        guard let client = readyClient,
              !isLoadingModelSettings,
              !isMutatingModelSettings else { return }
        let cwd = modelSettingsCwd
        isMutatingModelSettings = true
        modelSettingsError = nil
        defer { isMutatingModelSettings = false }
        do {
            let result: ModelSettingsSnapshot = try await client.request(
                "modelSettings.setDefaultModel",
                params: [
                    "cwd": .string(cwd),
                    "provider": .string(model.provider),
                    "modelId": .string(model.id),
                ]
            )
            guard modelSettingsCwd == cwd else { return }
            modelSettings = result
            await reloadModelChoicesAfterSettingsChange()
        } catch {
            if modelSettingsCwd == cwd {
                modelSettingsError = DiagnosticSanitizer.redact(error.localizedDescription)
            }
        }
    }

    func startModelAuthentication(
        provider: ModelSettingsProvider,
        method: ModelSettingsAuthMethod
    ) async {
        guard method.interactive,
              modelAuthFlow == nil,
              let client = readyClient else { return }
        let flowID = UUID().uuidString
        modelAuthFlow = ModelAuthFlow(
            id: flowID,
            providerID: provider.id,
            providerName: provider.name,
            method: method,
            prompt: nil,
            events: [],
            error: nil
        )
        do {
            let result: ModelSettingsSnapshot = try await client.request(
                "modelAuth.start",
                params: [
                    "cwd": .string(modelSettingsCwd),
                    "flowId": .string(flowID),
                    "provider": .string(provider.id),
                    "authType": .string(method.type),
                ]
            )
            guard modelAuthFlow?.id == flowID else { return }
            modelSettings = result
            modelAuthFlow = nil
            await reloadModelChoicesAfterSettingsChange()
            showNotice("\(provider.name) 已通过 Pi 完成关联。", level: "info")
        } catch {
            guard modelAuthFlow?.id == flowID else { return }
            if let clientError = error as? PiHostClientError,
               case let .hostFailure(payload) = clientError,
               payload.code == "MODEL_AUTH_CANCELLED" {
                modelAuthFlow = nil
                return
            }
            modelAuthFlow?.prompt = nil
            modelAuthFlow?.error = DiagnosticSanitizer.redact(error.localizedDescription)
        }
    }

    func respondToModelAuthPrompt(_ prompt: ModelAuthPrompt, value: String?, cancelled: Bool = false) async {
        guard let client = readyClient,
              modelAuthFlow?.id == prompt.flowID,
              modelAuthFlow?.prompt?.id == prompt.id else { return }
        modelAuthFlow?.prompt = nil
        var params: [String: JSONValue] = [
            "flowId": .string(prompt.flowID),
            "requestId": .string(prompt.id),
            "cancelled": .bool(cancelled),
        ]
        if !cancelled { params["value"] = .string(value ?? "") }
        do {
            let _: Acknowledgement = try await client.request("modelAuth.respond", params: params)
        } catch {
            guard modelAuthFlow?.id == prompt.flowID else { return }
            modelAuthFlow?.error = DiagnosticSanitizer.redact(error.localizedDescription)
        }
    }

    @discardableResult
    func cancelModelAuthentication() async -> Bool {
        guard let flow = modelAuthFlow else { return true }
        if flow.error != nil {
            modelAuthFlow = nil
            return true
        }
        guard let client = readyClient else {
            modelAuthFlow = nil
            return true
        }
        do {
            let result: ModelAuthCancelResult = try await client.request(
                "modelAuth.cancel",
                params: ["flowId": .string(flow.id)]
            )
            guard result.cancelled else {
                modelAuthFlow?.error = "Pi Host 未确认认证流程已经停止，请重试关闭。"
                return false
            }
            modelAuthFlow = nil
            return true
        } catch {
            guard modelAuthFlow?.id == flow.id else { return true }
            modelAuthFlow?.error = DiagnosticSanitizer.redact(error.localizedDescription)
            return false
        }
    }

    private func reloadModelChoicesAfterSettingsChange() async {
        if isNewSessionDraftActive {
            await reloadNewSessionModels()
        } else if selectedSessionID != nil {
            await loadRuntimeControls(includeCommands: false)
        }
    }

    func toggleProject(_ projectID: UUID) {
        if expandedProjectIDs.contains(projectID) { expandedProjectIDs.remove(projectID) }
        else { expandedProjectIDs.insert(projectID) }
    }

    func presentSearch() {
        guard canUseHostSessions, !isOpeningSession, !isPromptTransactionActive else { return }
        searchPresented = true
        searchError = nil
        searchOpenError = nil
        scheduleSearch(refresh: true)
        startSearchFreshnessProbe()
    }

    func dismissSearch() {
        guard !isOpeningSession else { return }
        searchPresented = false
        searchTask?.cancel()
        searchTask = nil
        searchProbeTask?.cancel()
        searchProbeTask = nil
        isSearchQuerying = false
        searchGeneration = UUID()
        searchResultGeneration = nil
        searchOpenError = nil
    }

    func updateSearchQuery(_ query: String) {
        guard !isOpeningSession, searchQuery != query else { return }
        searchQuery = query
        searchSelection = 0
        scheduleSearch(refresh: false)
    }

    func selectSearchProject(_ projectID: UUID?) {
        guard !isOpeningSession else { return }
        searchProjectID = projectID
        if let selectedPath = searchSourceFolderPath {
            let belongsToProject = projectID.flatMap { selectedID in
                projects.first(where: { $0.id == selectedID })
            }?.sourceFolders.contains(where: { $0.path == selectedPath }) ?? false
            if !belongsToProject { searchSourceFolderPath = nil }
        }
        searchSelection = 0
        scheduleSearch(refresh: false)
    }

    func selectSearchSourceFolder(_ path: String?) {
        guard !isOpeningSession else { return }
        searchSourceFolderPath = path
        searchSelection = 0
        scheduleSearch(refresh: false)
    }

    func reconcileSearchScope() {
        guard let projectID = searchProjectID,
              let project = projects.first(where: { $0.id == projectID }) else {
            searchProjectID = nil
            searchSourceFolderPath = nil
            return
        }
        if let path = searchSourceFolderPath,
           !project.sourceFolders.contains(where: { $0.path == path }) {
            searchSourceFolderPath = nil
        }
    }

    func moveSearchSelection(by offset: Int) {
        guard !searchResults.isEmpty else { return }
        searchSelection = min(max(0, searchSelection + offset), searchResults.count - 1)
    }

    func openSelectedSearchResult() async {
        guard searchPresented,
              searchResultGeneration == searchGeneration,
              searchResults.indices.contains(searchSelection),
              !isStreaming,
              !isOpeningSession,
              !isPromptTransactionActive else { return }
        await openSearchResult(searchResults[searchSelection])
    }

    func openSearchResult(_ result: SessionSearchResult) async {
        guard searchPresented,
              searchResultGeneration == searchGeneration,
              searchResults.contains(result),
              !isStreaming,
              !isOpeningSession,
              !isPromptTransactionActive else { return }
        guard !archivedSessions.contains(where: { $0.sessionID == result.sessionId }) else {
            searchOpenError = "该会话刚刚被归档；请前往“设置 > 会话 > 已归档会话”查看或恢复显示。"
            return
        }
        searchOpenError = nil
        let opened = await openSession(
            result.sessionId,
            writable: false,
            expectedEntryID: result.entryId,
            expectedEntryDigest: result.entryDigest,
            preserveActive: true,
            presentFailure: false,
            useOpenedPathDraftTarget: true
        )
        guard opened else { return }
        if let entryID = result.entryId {
            conversationTarget = ConversationTarget(sessionID: result.sessionId, entryID: entryID, token: UUID())
        }
        dismissSearch()
    }

    func clearConversationTarget(_ token: UUID) {
        guard conversationTarget?.token == token else { return }
        conversationTarget = nil
    }

    func selectWorkspaceFileTab(path: String) {
        guard workspaceFileTabs.contains(where: { $0.path == path }) else { return }
        workspaceTabSelection = .file(path)
    }

    func closeWorkspaceFileTab(path: String) {
        workspaceTabSelection = WorkspaceTabNavigation.selectionAfterClosing(
            path: path,
            tabs: workspaceFileTabs,
            current: workspaceTabSelection
        )
        workspaceFileTabs.removeAll(where: { $0.path == path })
        workspaceFileLoadIDs.removeValue(forKey: path)
    }

    func openWorkspaceFile(
        path: String,
        sourceFolderPath: String,
        line: Int? = nil
    ) async {
        let canonicalPath = WorkspaceFileReader.standardizedAbsolutePath(path)
        guard let sourceFolder = WorkspaceFileAuthorization.registeredSourceFolder(
            matching: sourceFolderPath,
            projects: projects
        ) else {
            issue = AppIssue(
                title: "无法打开文件",
                message: "该来源文件夹已不在当前 D Code 项目中，未读取磁盘内容。"
            )
            return
        }
        let canonicalRoot = WorkspaceFileReader.standardizedAbsolutePath(sourceFolder.path)
        guard WorkspaceFileReader.relativeComponents(of: canonicalPath, inside: canonicalRoot) != nil else {
            issue = AppIssue(
                title: "无法打开文件",
                message: "该文件不在当前登记的来源文件夹内，已停止读取。"
            )
            return
        }

        if let index = workspaceFileTabs.firstIndex(where: { $0.path == canonicalPath }) {
            workspaceFileTabs[index].requestedLine = line
            workspaceTabSelection = .file(canonicalPath)
            return
        }

        workspaceFileTabs.append(WorkspaceFileTab(
            path: canonicalPath,
            sourceFolderPath: canonicalRoot,
            requestedLine: line,
            snapshot: nil,
            errorMessage: nil,
            isLoading: true,
            authorizationAvailable: true
        ))
        workspaceTabSelection = .file(canonicalPath)
        await loadWorkspaceFile(path: canonicalPath)
    }

    func retryWorkspaceFile(path: String) async {
        guard let tab = workspaceFileTabs.first(where: { $0.path == path }),
              tab.authorizationAvailable else { return }
        await loadWorkspaceFile(path: path)
    }

    func openWorkspaceURL(_ url: URL) async {
        guard let target = WorkspaceFileLink.decode(url) else { return }
        let resolvedPath: String
        if target.path.hasPrefix("/") {
            resolvedPath = WorkspaceFileReader.standardizedAbsolutePath(target.path)
        } else if let cwd = inspection?.summary.cwd {
            resolvedPath = WorkspaceFileReader.standardizedAbsolutePath(
                URL(fileURLWithPath: cwd, isDirectory: true)
                    .appendingPathComponent(target.path)
                    .path
            )
        } else if let project = selectedProject, project.sourceFolders.count == 1 {
            resolvedPath = WorkspaceFileReader.standardizedAbsolutePath(
                URL(fileURLWithPath: project.sourceFolders[0].path, isDirectory: true)
                    .appendingPathComponent(target.path)
                    .path
            )
        } else {
            issue = AppIssue(
                title: "无法定位本机文件",
                message: "该相对路径缺少唯一的会话工作目录或项目来源文件夹。"
            )
            return
        }

        guard let sourceFolder = WorkspaceFileAuthorization.registeredSourceFolder(
            containing: resolvedPath,
            projects: projects
        ) else {
            issue = AppIssue(
                title: "无法打开本机文件",
                message: "该路径不属于任何已登记的 D Code 项目来源文件夹，未交给系统或其他应用打开。"
            )
            return
        }
        await openWorkspaceFile(
            path: resolvedPath,
            sourceFolderPath: sourceFolder.path,
            line: target.line
        )
    }

    private func loadWorkspaceFile(path: String) async {
        guard let index = workspaceFileTabs.firstIndex(where: { $0.path == path }),
              workspaceFileTabs[index].authorizationAvailable else { return }
        let root = workspaceFileTabs[index].sourceFolderPath
        guard WorkspaceFileAuthorization.registeredSourceFolder(
            matching: root,
            projects: projects
        ) != nil else {
            revokeWorkspaceFileAuthorization(path: path)
            return
        }

        let loadID = UUID()
        workspaceFileLoadIDs[path] = loadID
        workspaceFileTabs[index].isLoading = true
        workspaceFileTabs[index].errorMessage = nil
        do {
            let snapshot = try await WorkspaceFileReader.read(
                path: path,
                sourceFolderPath: root
            )
            guard workspaceFileLoadIDs[path] == loadID,
                  let currentIndex = workspaceFileTabs.firstIndex(where: { $0.path == path }) else {
                return
            }
            guard workspaceFileTabs[currentIndex].authorizationAvailable,
                  WorkspaceFileAuthorization.registeredSourceFolder(
                    matching: root,
                    projects: projects
                  ) != nil else {
                revokeWorkspaceFileAuthorization(path: path)
                return
            }
            workspaceFileTabs[currentIndex].snapshot = snapshot
            workspaceFileTabs[currentIndex].errorMessage = nil
            workspaceFileTabs[currentIndex].isLoading = false
            workspaceFileLoadIDs.removeValue(forKey: path)
        } catch {
            guard workspaceFileLoadIDs[path] == loadID,
                  let currentIndex = workspaceFileTabs.firstIndex(where: { $0.path == path }) else {
                return
            }
            workspaceFileTabs[currentIndex].snapshot = nil
            workspaceFileTabs[currentIndex].errorMessage = DiagnosticSanitizer.redact(error.localizedDescription)
            workspaceFileTabs[currentIndex].isLoading = false
            workspaceFileLoadIDs.removeValue(forKey: path)
        }
    }

    private func reconcileWorkspaceFileAuthorizations() {
        for tab in workspaceFileTabs where tab.authorizationAvailable {
            if WorkspaceFileAuthorization.registeredSourceFolder(
                matching: tab.sourceFolderPath,
                projects: projects
            ) == nil {
                revokeWorkspaceFileAuthorization(path: tab.path)
            }
        }
    }

    private func revokeWorkspaceFileAuthorization(path: String) {
        guard let index = workspaceFileTabs.firstIndex(where: { $0.path == path }) else { return }
        workspaceFileLoadIDs.removeValue(forKey: path)
        workspaceFileTabs[index].authorizationAvailable = false
        workspaceFileTabs[index].isLoading = false
        if workspaceFileTabs[index].snapshot == nil {
            workspaceFileTabs[index].errorMessage = "来源授权已移除；该文件尚未读取，D Code 不会继续访问磁盘。"
        }
    }

    func clearSearchOpenError() {
        searchOpenError = nil
    }

    private func scheduleSearch(refresh: Bool) {
        searchTask?.cancel()
        searchTask = nil
        searchResultGeneration = nil
        searchResults = []
        searchSelection = 0
        searchError = nil
        searchOpenError = nil
        isSearchQuerying = false
        guard searchPresented, let client = readyClient else { return }
        isSearchQuerying = true
        let generation = UUID()
        searchGeneration = generation
        let query = searchQuery
        let projectPaths = allProjectSourceFolderPaths
        let filterPaths: [String]?
        if let path = searchSourceFolderPath {
            filterPaths = [path]
        } else if let projectID = searchProjectID {
            filterPaths = projects.first(where: { $0.id == projectID })?.sourceFolders.map(\.path) ?? []
        } else {
            filterPaths = nil
        }
        let requestPlan = SessionSearchRequestPlan(
            generation: generation,
            query: query,
            projectSourceFolders: projectPaths,
            filterSourceFolders: filterPaths,
            excludedSessionIDs: archivedSessionIDs,
            refresh: refresh
        )
        searchTask = Task { [weak self] in
            do {
                let response: SessionSearchResponse = try await client.request(
                    "session.search",
                    params: requestPlan.parameters
                )
                guard let self,
                      requestPlan.accepts(
                          response,
                          searchPresented: self.searchPresented,
                          currentGeneration: self.searchGeneration
                      ) else { return }
                self.searchIndexStatus = response.index
                self.searchResults = response.results
                self.searchResultGeneration = generation
                self.isSearchQuerying = false
                self.searchSelection = min(self.searchSelection, max(0, response.results.count - 1))
                self.searchError = response.index.state == .failed
                    ? DiagnosticSanitizer.redact(response.index.message ?? "搜索索引不可用")
                    : nil
            } catch is CancellationError {
                return
            } catch {
                guard let self, self.searchPresented, self.searchGeneration == generation else { return }
                self.searchError = DiagnosticSanitizer.redact(error.localizedDescription)
                self.searchResultGeneration = nil
                self.isSearchQuerying = false
            }
        }
    }

    private func startSearchFreshnessProbe() {
        searchProbeTask?.cancel()
        searchProbeTask = Task { [weak self] in
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(1)) }
                catch { return }
                guard let self else { return }
                await self.probeSearchFreshness()
            }
        }
    }

    private func probeSearchFreshness() async {
        guard searchPresented,
              !isOpeningSession,
              searchIndexStatus.canServeResults,
              let client = readyClient else { return }
        let plan = SessionSearchProbePlan(
            token: UUID(),
            projectSourceFolders: allProjectSourceFolderPaths,
            excludedSessionIDs: archivedSessionIDs
        )
        do {
            let _: SessionSearchResponse = try await client.request(
                "session.search",
                params: plan.parameters
            )
        } catch is CancellationError {
            return
        } catch {
            // The normal search request and index events own user-facing errors.
        }
    }

    func applySearchIndexStatus(_ next: SessionSearchIndexStatus) {
        searchIndexStatus = next
        if next.state == .failed {
            searchTask?.cancel()
            isSearchQuerying = false
            searchResultGeneration = nil
            searchResults = []
            searchError = DiagnosticSanitizer.redact(next.message ?? "搜索索引不可用")
        } else if searchPresented, !next.canServeResults {
            searchTask?.cancel()
            searchTask = nil
            searchResultGeneration = nil
            searchResults = []
            searchSelection = 0
            searchOpenError = nil
            isSearchQuerying = true
        } else if searchPresented, next.canServeResults {
            scheduleSearch(refresh: false)
        }
    }

    func updateComposerText(_ text: String) {
        composerText = text
        if isNewSessionDraftActive {
            newSessionDraft?.text = text
            draftDocument.newSessionDraft = text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? nil
                : newSessionDraft
            scheduleDraftSave()
            return
        }
        guard let target = currentDraftTarget else { return }
        setDraftText(text, for: target)
        scheduleDraftSave()
    }

    func beginPathDraft(from item: TranscriptItem) {
        guard let sessionID = selectedSessionID,
              let originPathID = inspection?.selectedPathId,
              item.role == .user || item.role == .assistant,
              !isStreaming,
              !isOpeningSession,
              !isMutatingArchive,
              !isSendingRequest,
              pendingPrompt == nil else { return }
        guard canPersistSessionDrafts else {
            showNotice("草稿资料当前不可写，修复资料文件并重启 D Code 后才能创建新路径草稿。", level: "warning")
            return
        }
        persistCurrentDraftInMemory()
        let action = SessionPathAction(
            kind: item.role == .user ? .editUser : .continueAssistant,
            entryId: item.id
        )
        let target = SessionDraftTarget.pending(
            sessionID: sessionID,
            originPathID: originPathID,
            action: action
        )
        guard item.role != .user || item.editableText != nil else {
            showNotice("这条用户消息包含当前无法无损编辑的结构化内容；可以从其后的助手消息继续。", level: "warning")
            return
        }
        activateDraftTarget(target, defaultText: item.role == .user ? item.editableText ?? "" : "")
    }

    func cancelPathDraft() {
        guard !isMutatingArchive,
              !isSendingRequest,
              pendingPrompt == nil,
              case let .pending(sessionID, originPathID, _) = currentDraftTarget else { return }
        if let target = currentDraftTarget {
            draftDocument.records.removeAll(where: { $0.target.stableID == target.stableID })
        }
        let origin = SessionDraftTarget.path(sessionID: sessionID, pathID: originPathID)
        activateDraftTarget(origin, defaultText: "")
    }

    func selectPath(_ path: SessionPathSummary) async {
        guard let sessionID = selectedSessionID,
              !isStreaming,
              !isOpeningSession,
              !isMutatingArchive,
              !isSendingRequest,
              pendingPrompt == nil,
              path.id != inspection?.selectedPathId else { return }
        await flushCurrentDraft()
        _ = await openSession(
            sessionID,
            writable: false,
            pathID: path.id,
            draftTargetAfterOpen: .path(sessionID: sessionID, pathID: path.id)
        )
    }

    private func activateDraftTarget(_ target: SessionDraftTarget, defaultText: String) {
        currentDraftTarget = target
        draftDocument.activeTargets[target.sessionID] = target
        composerText = draftDocument.records.first(where: { $0.target.stableID == target.stableID })?.text
            ?? defaultText
        setDraftText(composerText, for: target)
        scheduleDraftSave()
    }

    private func persistCurrentDraftInMemory() {
        guard let target = currentDraftTarget else { return }
        setDraftText(composerText, for: target)
    }

    private func setDraftText(_ text: String, for target: SessionDraftTarget) {
        draftDocument.records.removeAll(where: { $0.target.stableID == target.stableID })
        guard !text.isEmpty else { return }
        draftDocument.records.append(SessionDraftRecord(
            target: target,
            text: text,
            updatedAt: Date().ISO8601Format()
        ))
    }

    private func scheduleDraftSave() {
        guard sessionDraftStoreWritable else { return }
        draftSaveTask?.cancel()
        let document = draftDocument
        draftRevision += 1
        let revision = draftRevision
        draftSaveTask = Task { [weak self] in
            do {
                try await Task.sleep(for: .milliseconds(180))
                guard !Task.isCancelled, let self else { return }
                try await self.sessionDraftStore.save(document, revision: revision)
            } catch is CancellationError {
                return
            } catch {
                self?.sessionDraftStoreWritable = false
                self?.draftStoreIssue = "草稿保存失败；原文件已保留，本次将停止继续写入：\(self?.sessionDraftStore.fileURL.path ?? "草稿资料文件")"
                self?.showNotice(self?.draftStoreIssue ?? "草稿保存失败。", level: "warning")
            }
        }
    }

    @discardableResult
    private func flushCurrentDraft() async -> Bool {
        if pendingPrompt == nil, pendingSteer == nil { persistCurrentDraftInMemory() }
        draftSaveTask?.cancel()
        draftSaveTask = nil
        guard sessionDraftStoreWritable else { return false }
        draftRevision += 1
        let revision = draftRevision
        do {
            try await sessionDraftStore.save(draftDocument, revision: revision)
            return true
        }
        catch {
            sessionDraftStoreWritable = false
            draftStoreIssue = "草稿保存失败；原文件已保留，本次将停止继续写入：\(sessionDraftStore.fileURL.path)"
            showNotice(draftStoreIssue ?? "草稿保存失败。", level: "warning")
            return false
        }
    }

    private func recordSessionChange(_ data: JSONValue?) {
        guard let data,
              let record = try? data.decoded(SessionMutationRecord.self),
              !sessionChangeDocument.records.contains(where: { $0.recordId == record.recordId }) else { return }
        do {
            try SessionChangeStore.validate(SessionChangeDocument(records: [record]))
        } catch {
            showNotice("Host 返回了无效的会话变更记录，本次未保存。", level: "warning")
            return
        }
        guard sessionChangeDocument.records.count < 50_000 else {
            sessionChangeStoreWritable = false
            showNotice("会话变更账本已达到 50,000 条安全上限，本次停止继续写入。", level: "warning")
            return
        }
        sessionChangeDocument.records.append(record)
        if selectedSessionID == record.sessionId { updateSelectedSessionChangeSummary() }
        scheduleSessionChangeSave()
    }

    private func updateSelectedSessionChangeSummary() {
        guard let selectedSessionID else {
            sessionChangeSummary = nil
            return
        }
        let summary = SessionChangeSummary.build(
            sessionID: selectedSessionID,
            records: sessionChangeDocument.records
        )
        sessionChangeSummary = summary.isEmpty ? nil : summary
    }

    private func scheduleSessionChangeSave() {
        guard sessionChangeStoreWritable else { return }
        sessionChangeSaveTask?.cancel()
        let document = sessionChangeDocument
        sessionChangeRevision += 1
        let revision = sessionChangeRevision
        sessionChangeSaveTask = Task { [weak self] in
            do {
                guard !Task.isCancelled, let self else { return }
                try await self.sessionChangeStore.save(document, revision: revision)
            } catch is CancellationError {
                return
            } catch {
                self?.sessionChangeStoreWritable = false
                self?.showNotice("会话变更账本保存失败；原文件已保留，本次停止继续写入。", level: "warning")
            }
        }
    }

    private func flushSessionChanges() async {
        sessionChangeSaveTask?.cancel()
        sessionChangeSaveTask = nil
        guard sessionChangeStoreWritable else { return }
        sessionChangeRevision += 1
        do {
            try await sessionChangeStore.save(sessionChangeDocument, revision: sessionChangeRevision)
        } catch {
            sessionChangeStoreWritable = false
            showNotice("会话变更账本保存失败；原文件已保留，本次停止继续写入。", level: "warning")
        }
    }

    private func recordCompletedRun(_ state: SessionRunState) {
        guard state.phase == .completed,
              let completionID = state.completionID,
              let entryID = state.completionEntryID,
              let completedAt = state.completedAt,
              ActivityTimestamp.parse(completedAt) != nil else { return }
        if let existing = activityAttentionRecords.first(where: { $0.sessionID == state.sessionID }),
           existing.completionID == completionID {
            return
        }
        activityAttentionRecords.removeAll(where: { $0.sessionID == state.sessionID })
        activityAttentionRecords.append(ActivityAttentionRecord(
            sessionID: state.sessionID,
            runID: state.runID,
            completionID: completionID,
            entryID: entryID,
            completedAt: completedAt,
            presentedAt: nil
        ))
        activityAttentionRecords.sort {
            if $0.completedAt != $1.completedAt { return $0.completedAt > $1.completedAt }
            return $0.sessionID < $1.sessionID
        }
        scheduleActivityAttentionSave()
        if !activitySessions.contains(where: { $0.id == state.sessionID }) {
            Task { [weak self] in await self?.reloadActivitySessions() }
        }
    }

    func markCompletionPresented(entryID: String) {
        guard workbenchDestination == .workspace,
              workspaceTabSelection == .conversation,
              let sessionID = selectedSessionID,
              transcript.contains(where: { $0.id == entryID }),
              let index = activityAttentionRecords.firstIndex(where: {
                  $0.sessionID == sessionID && $0.entryID == entryID && $0.isUnseen
              }) else { return }
        activityAttentionRecords[index].presentedAt = Date().ISO8601Format()
        scheduleActivityAttentionSave()
    }

    private func scheduleActivityAttentionSave() {
        guard activityAttentionStoreWritable else { return }
        activityAttentionSaveTask?.cancel()
        activityAttentionRevision += 1
        let revision = activityAttentionRevision
        let document = ActivityAttentionDocument(records: activityAttentionRecords)
        activityAttentionSaveTask = Task { [weak self] in
            do {
                try await self?.activityAttentionStore.save(document, revision: revision)
            } catch is CancellationError {
                return
            } catch {
                self?.activityAttentionStoreWritable = false
                self?.activityAttentionIssue = "活动关注记录保存失败；原文件已保留，本次停止继续写入：\(self?.activityAttentionStore.fileURL.path ?? "未知路径")"
                self?.showNotice(self?.activityAttentionIssue ?? "活动关注记录保存失败。", level: "warning")
            }
        }
    }

    private func flushActivityAttention() async {
        activityAttentionSaveTask?.cancel()
        activityAttentionSaveTask = nil
        guard activityAttentionStoreWritable else { return }
        activityAttentionRevision += 1
        do {
            try await activityAttentionStore.save(
                ActivityAttentionDocument(records: activityAttentionRecords),
                revision: activityAttentionRevision
            )
        } catch {
            activityAttentionStoreWritable = false
            activityAttentionIssue = "活动关注记录保存失败；原文件已保留，本次停止继续写入：\(activityAttentionStore.fileURL.path)"
            showNotice(activityAttentionIssue ?? "活动关注记录保存失败。", level: "warning")
        }
    }

    func selectSession(_ sessionID: String?) async {
        guard let sessionID else { return }
        guard !archivedSessions.contains(where: { $0.sessionID == sessionID }) else {
            showNotice("该会话已归档，请前往“设置 > 会话 > 已归档会话”查看或恢复显示。", level: "warning")
            return
        }
        if sessionID == inspection?.summary.id {
            workbenchDestination = .workspace
            workspaceTabSelection = .conversation
            selectedSessionID = sessionID
            updateSelectedSessionChangeSummary()
            inspectorScope = .session(sessionID)
            return
        }
        guard !hasActiveRun, !isOpeningSession, !isPromptTransactionActive else {
            if currentRunState?.phase == .unknown {
                showNotice("当前运行的最终结果无法确认；为避免重复写入，重新连接或核对会话前不能切换。", level: "warning")
            } else if hasActiveRun {
                showNotice("当前会话仍在运行；请先等待完成或请求停止。D Code 不会把它伪装成后台运行。", level: "warning")
            }
            return
        }
        parkNewSessionDraft()
        await flushCurrentDraft()
        await openSession(sessionID, writable: false)
    }

    func createSession(at directory: URL) async {
        guard readyClient != nil,
              !isStreaming,
              !isCreatingSession,
              !isOpeningSession,
              !isPromptTransactionActive else { return }

        let canonicalDirectoryPath: String
        do {
            canonicalDirectoryPath = try ProjectStore.canonicalDirectoryPath(directory)
        } catch {
            present(error, title: "新会话工作目录不可用")
            return
        }

        await flushCurrentDraft()

        if isNewSessionDraftActive {
            newSessionDraft?.text = composerText
        }
        let existingDraft = newSessionDraft.flatMap { draft in
            draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : draft
        }
        if let existingDraft, existingDraft.directoryPath != canonicalDirectoryPath {
            showNotice("已恢复之前未发送的新会话草稿；发送或取消后，才能在其他目录开始新会话。", level: "info")
        }
        let draft = existingDraft ?? NewSessionDraft(directoryPath: canonicalDirectoryPath, text: "")

        clearActiveSessionPresentation()
        workbenchDestination = .workspace
        workspaceTabSelection = .conversation
        inspectorScope = nil
        newSessionDraft = draft
        isNewSessionDraftActive = true
        composerText = draft.text
        draftDocument.newSessionDraft = draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? nil
            : draft
        await reloadNewSessionModels()
    }

    func discardNewSessionDraft() {
        guard newSessionDraft != nil else { return }
        newSessionDraft = nil
        newSessionDefaultModel = nil
        newSessionDefaultThinkingLevel = nil
        draftDocument.newSessionDraft = nil
        scheduleDraftSave()
        isNewSessionDraftActive = false
        clearActiveSessionPresentation()
        workbenchDestination = .workspace
        workspaceTabSelection = .conversation
    }

    private func parkNewSessionDraft() {
        guard isNewSessionDraftActive else { return }
        newSessionModelLoadGeneration = UUID()
        isLoadingNewSessionModels = false
        newSessionModelIssue = nil
        newSessionDefaultModel = nil
        newSessionDefaultThinkingLevel = nil
        newSessionDraft?.text = composerText
        if composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            newSessionDraft = nil
        }
        draftDocument.newSessionDraft = newSessionDraft
        scheduleDraftSave()
        isNewSessionDraftActive = false
        composerText = ""
    }

    func reloadNewSessionModels() async {
        guard let client = readyClient,
              isNewSessionDraftActive,
              let directoryPath = newSessionDraft?.directoryPath else { return }
        let generation = UUID()
        newSessionModelLoadGeneration = generation
        isLoadingNewSessionModels = true
        newSessionModelIssue = nil
        newSessionDefaultModel = nil
        newSessionDefaultThinkingLevel = nil
        defer {
            if newSessionModelLoadGeneration == generation {
                isLoadingNewSessionModels = false
            }
        }
        do {
            let result: ModelsResult = try await client.request(
                "session.getModels",
                params: ["cwd": .string(directoryPath)]
            )
            guard newSessionModelLoadGeneration == generation,
                  isNewSessionDraftActive,
                  newSessionDraft?.directoryPath == directoryPath else { return }
            availableModels = result.models

            let restored = newSessionDraft?.selectedModel.flatMap { selection in
                result.models.first(where: selection.matches)
            }
            let configuredDefault = result.defaultModel.flatMap { candidate in
                result.models.first(where: {
                    $0.provider == candidate.provider && $0.id == candidate.id
                })
            }
            newSessionDefaultModel = configuredDefault
            newSessionDefaultThinkingLevel = result.defaultThinkingLevel
            let selectedModel = restored ?? configuredDefault
            newSessionDraft?.selectedModel = selectedModel.map(NewSessionModelSelection.init)
            if let selectedThinkingLevel = newSessionDraft?.selectedThinkingLevel,
               !composerThinkingLevels.contains(selectedThinkingLevel) {
                newSessionDraft?.selectedThinkingLevel = nil
            }
            if selectedModel?.fastModeSupported != true {
                newSessionDraft?.fastModeEnabled = false
            }
            if result.models.isEmpty {
                newSessionModelIssue = "Pi 当前没有可用模型；请先完成 Provider 与认证配置。"
            }
            if let draft = newSessionDraft,
               !draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                draftDocument.newSessionDraft = draft
                scheduleDraftSave()
            }
        } catch {
            guard newSessionModelLoadGeneration == generation,
                  isNewSessionDraftActive,
                  newSessionDraft?.directoryPath == directoryPath else { return }
            availableModels = []
            newSessionDefaultModel = nil
            newSessionDefaultThinkingLevel = nil
            newSessionModelIssue = "无法读取 Pi 模型：\(DiagnosticSanitizer.redact(error.localizedDescription))"
        }
    }

    func selectNewSessionModel(_ model: HostModel) {
        guard isNewSessionDraftActive,
              availableModels.contains(where: {
                  $0.provider == model.provider && $0.id == model.id
              }) else { return }
        newSessionDraft?.selectedModel = NewSessionModelSelection(model)
        if let selectedThinkingLevel = newSessionDraft?.selectedThinkingLevel,
           !composerThinkingLevels.contains(selectedThinkingLevel) {
            newSessionDraft?.selectedThinkingLevel = nil
        }
        if model.fastModeSupported != true {
            newSessionDraft?.fastModeEnabled = false
        }
        newSessionModelIssue = nil
        persistNewSessionDraftIfMeaningful()
    }

    func selectNewSessionThinkingLevel(_ level: String) {
        guard isNewSessionDraftActive,
              composerThinkingLevels.contains(level) else { return }
        newSessionDraft?.selectedThinkingLevel = level
        persistNewSessionDraftIfMeaningful()
    }

    func resetNewSessionRuntimeToPiDefaults() {
        guard isNewSessionDraftActive,
              let newSessionDefaultModel else { return }
        newSessionDraft?.selectedModel = NewSessionModelSelection(newSessionDefaultModel)
        newSessionDraft?.selectedThinkingLevel = nil
        newSessionDraft?.fastModeEnabled = false
        newSessionModelIssue = nil
        persistNewSessionDraftIfMeaningful()
    }

    func isPiDefaultNewSessionModel(_ candidate: HostModel) -> Bool {
        guard let newSessionDefaultModel else { return false }
        return candidate.provider == newSessionDefaultModel.provider
            && candidate.id == newSessionDefaultModel.id
    }

    private func persistNewSessionDraftIfMeaningful() {
        if let draft = newSessionDraft,
           !draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            draftDocument.newSessionDraft = draft
            scheduleDraftSave()
        }
    }

    func requestTrashSession(_ session: SessionSummary) {
        guard canTrashSession(session), !isTrashingSession else { return }
        pendingTrashSession = session
    }

    func renameSelectedSession(to requestedName: String?) async {
        guard canRenameSelectedSession,
              let client = readyClient,
              let sessionID = selectedSessionID else { return }
        let name = requestedName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard requestedName == nil || !name.isEmpty else {
            issue = AppIssue(title: "无法重命名会话", message: "会话名称不能为空；若要恢复自动名称，请使用“恢复自动名称”。")
            return
        }
        guard name.utf16.count <= 200,
              !name.contains("\n"),
              !name.contains("\r") else {
            issue = AppIssue(title: "无法重命名会话", message: "会话名称必须是 200 个字符以内的单行文字。")
            return
        }

        isRenamingSession = true
        defer { isRenamingSession = false }
        guard await ensureWritable(), selectedSessionID == sessionID else { return }
        do {
            let result: SessionRenameResult = try await client.request(
                "session.setName",
                params: ["name": .string(name)]
            )
            guard selectedSessionID == sessionID else { return }
            replaceVisibleSummary(result.summary)
            await refreshSnapshot()
            Task { [weak self] in await self?.reloadAllSessionLists() }
            showNotice(requestedName == nil ? "已恢复自动会话名称。" : "会话已重命名。", level: "info")
        } catch {
            present(error, title: "无法重命名会话")
        }
    }

    func togglePinnedSession(_ session: SessionSummary) async {
        guard canToggleSessionPin(session) else { return }
        isMutatingPins = true
        defer { isMutatingPins = false }

        let wasPinned = isSessionPinned(session.id)
        let existingPresentation = pinnedSessionPresentations.first(where: { $0.id == session.id })
        let wasRecent = recentSessions.contains(where: { $0.id == session.id })
        let visibleProjectIDs = Set(projectSessions.compactMap { projectID, sessions in
            sessions.contains(where: { $0.id == session.id }) ? projectID : nil
        })
        var updated = pinnedSessions.filter { $0.sessionID != session.id }
        if !wasPinned {
            updated.append(PinnedSessionRecord(
                sessionID: session.id,
                pinnedAt: Date().ISO8601Format()
            ))
        }
        do {
            try await sessionPinStore.save(updated)
            pinnedSessions = updated
            visibilityGeneration = UUID()
            if wasPinned {
                pinnedSessionPresentations.removeAll(where: { $0.id == session.id })
                if existingPresentation?.isRecent == true {
                    recentSessions.append(session)
                    recentSessions = SessionPinOrdering.ordered(recentSessions, pinnedRecords: [])
                }
                for projectID in existingPresentation?.projectIDs ?? [] where projectSessions[projectID] != nil {
                    projectSessions[projectID, default: []].append(session)
                    projectSessions[projectID] = SessionPinOrdering.ordered(
                        projectSessions[projectID, default: []],
                        pinnedRecords: []
                    )
                }
            } else {
                pinnedSessionPresentations.append(PinnedSessionPresentation(
                    summary: session,
                    isRecent: wasRecent,
                    projectIDs: visibleProjectIDs.union(projectIDs(for: session))
                ))
                orderPinnedSessionPresentations(using: updated)
                recentSessions.removeAll(where: { $0.id == session.id })
                for projectID in Array(projectSessions.keys) {
                    projectSessions[projectID]?.removeAll(where: { $0.id == session.id })
                }
            }
            Task { [weak self] in await self?.reloadAllSessionLists() }
            showNotice(wasPinned ? "会话已取消置顶。" : "会话已置顶。", level: "info")
        } catch {
            present(error, title: wasPinned ? "无法取消置顶" : "无法置顶会话")
        }
    }

    func archiveSession(_ session: SessionSummary) async {
        guard canArchiveSession(session) else { return }
        isMutatingArchive = true
        defer { isMutatingArchive = false }

        let wasSelected = selectedSessionID == session.id
        if wasSelected, !(await flushCurrentDraft()) {
            issue = AppIssue(
                title: "无法归档会话",
                message: "当前草稿尚未安全保存；会话、搜索结果与 Pi 文件均保持原样。请修复草稿资料后重试。"
            )
            return
        }
        guard !isCopyingSession,
              !isTrashingSession,
              !isStreaming,
              !isOpeningSession,
              pendingPrompt == nil,
              (!wasSelected || selectedSessionID == session.id),
              pendingArchiveRetry?.sessionID != session.id,
              !archivedSessions.contains(where: { $0.sessionID == session.id }),
              isSessionVisible(session.id) else { return }

        let record = ArchivedSessionRecord(
            sessionID: session.id,
            archivedAt: Date().ISO8601Format(),
            copiedToSessionID: nil,
            copiedToTitle: nil,
            copiedToCwd: nil,
            sourceTitle: session.displayTitle,
            sourceCwd: session.cwd
        )
        var updated = archivedSessions.filter { $0.sessionID != session.id }
        updated.append(record)

        do {
            try await sessionArchiveStore.save(records: updated, pending: pendingArchiveRetry)
            archivedSessions = updated
            hideArchivedSessionFromOrdinaryNavigation(session.id)

            var closeWarning = false
            if wasSelected, let client = readyClient {
                do {
                    let _: JSONValue = try await client.request(
                        "session.close",
                        params: ["expectedSessionId": .string(session.id)]
                    )
                } catch {
                    closeWarning = true
                }
            }
            if closeWarning {
                showNotice(
                    "会话已归档；Pi 会话文件与草稿均保留，后台观察将在打开下一会话时结束。",
                    level: "warning"
                )
            } else {
                showNotice("会话已归档；Pi 会话文件与草稿均保留。", level: "info")
            }
        } catch {
            present(error, title: "无法归档会话")
        }
    }

    func trashSession(_ session: SessionSummary) async {
        guard let client = readyClient,
              canTrashSession(session),
              !isTrashingSession,
              !isStreaming,
              !isOpeningSession,
              !isPromptTransactionActive else { return }
        isTrashingSession = true
        defer { isTrashingSession = false }
        do {
            let result: SessionTrashResult = try await client.request(
                "session.trash",
                params: ["sessionId": .string(session.id)]
            )
            guard result.trashed, result.sessionId == session.id else {
                throw PiHostClientError.invalidEnvelope("session.trash 未确认请求的 Session ID")
            }
            visibilityGeneration = UUID()
            pinnedSessionPresentations.removeAll(where: { $0.id == session.id })
            recentSessions.removeAll(where: { $0.id == session.id })
            for projectID in Array(projectSessions.keys) {
                projectSessions[projectID]?.removeAll(where: { $0.id == session.id })
            }
            searchResults.removeAll(where: { $0.sessionId == session.id })
            draftDocument.records.removeAll(where: { $0.target.sessionID == session.id })
            draftDocument.activeTargets.removeValue(forKey: session.id)
            scheduleDraftSave()
            if selectedSessionID == session.id { clearActiveSessionPresentation() }
            if isSessionPinned(session.id) {
                let updatedPins = pinnedSessions.filter { $0.sessionID != session.id }
                pinnedSessions = updatedPins
                try? await sessionPinStore.save(updatedPins)
            }
            if searchPresented { scheduleSearch(refresh: true) }
            Task { [weak self] in await self?.reloadAllSessionLists() }
            showNotice("空会话已移到废纸篓。", level: "info")
        } catch {
            present(error, title: "无法移到废纸篓")
        }
    }

    func copySelectedSession(to directory: URL, in projectID: UUID, archiveSource: Bool) async -> Bool {
        guard let client = readyClient,
              let source = selectedSummary,
              !isCopyingSession,
              !isMutatingArchive,
              !isStreaming,
              !isOpeningSession,
              !isPromptTransactionActive else { return false }
        if archiveSource, pendingArchiveRetry != nil {
            issue = AppIssue(
                title: "请先完成上一次归档",
                message: "已有一个复制成功但尚未归档的原会话。请前往“设置 > 会话 > 已归档会话”重试归档后再使用“复制并归档”；普通复制不受影响。"
            )
            return false
        }
        if archiveSource, archivedSessions.contains(where: { $0.sessionID == source.id }) {
            issue = AppIssue(
                title: "原会话已经归档",
                message: "可以继续使用普通“复制到项目”，但无需再次执行“复制并归档”。"
            )
            return false
        }
        let canonicalTarget: String
        do {
            canonicalTarget = try ProjectStore.canonicalDirectoryPath(directory)
        } catch {
            present(error, title: "复制目标不可用")
            return false
        }
        guard projects.first(where: { $0.id == projectID })?.sourceFolders
            .contains(where: { $0.path == canonicalTarget }) == true else {
            issue = AppIssue(
                title: "复制目标已变化",
                message: "所选 Source Folder 已不再属于当前 Project。请重新选择目标。"
            )
            return false
        }
        isCopyingSession = true
        defer { isCopyingSession = false }
        do {
            let result: SessionCopyResult = try await client.request("session.copy", params: [
                "sessionId": .string(source.id),
                "targetCwd": .string(canonicalTarget),
            ])
            guard result.copied, result.verification.origin else {
                throw PiHostClientError.hostFailure(.init(
                    code: "SESSION_COPY_VERIFICATION_FAILED",
                    message: "复制目标未通过来源验证",
                    details: nil
                ))
            }
            let opened = await openSession(result.target.id, writable: false)
            guard opened else {
                issue = AppIssue(
                    title: "会话已复制，但暂时无法打开",
                    message: "目标会话已经完整保留，原会话未归档。请稍后从目标项目重新打开。"
                )
                await reloadAllSessionLists()
                return true
            }
            if archiveSource {
                let record = ArchivedSessionRecord(
                    sessionID: source.id,
                    archivedAt: Date().ISO8601Format(),
                    copiedToSessionID: result.target.id,
                    copiedToTitle: result.target.displayTitle,
                    copiedToCwd: result.target.cwd,
                    sourceTitle: source.displayTitle,
                    sourceCwd: source.cwd
                )
                guard sessionArchiveStoreWritable else {
                    pendingArchiveRetry = record
                    issue = AppIssue(
                        title: "复制成功，归档未完成",
                        message: "目标会话已保留并打开，但归档资料当前不可写；原会话继续显示。可前往“设置 > 会话 > 已归档会话”重试。"
                    )
                    await reloadAllSessionLists()
                    return true
                }
                guard !isMutatingArchive else { return true }
                isMutatingArchive = true
                defer { isMutatingArchive = false }
                do {
                    pendingArchiveRetry = record
                    try await sessionArchiveStore.save(records: archivedSessions, pending: record)
                    var updated = archivedSessions.filter { $0.sessionID != source.id }
                    updated.append(record)
                    try await sessionArchiveStore.save(records: updated, pending: nil)
                    archivedSessions = updated
                    pendingArchiveRetry = nil
                    await refreshSessionVisibility()
                    showNotice("复制完成；原会话已从 D Code 普通导航归档。", level: "info")
                } catch {
                    pendingArchiveRetry = record
                    issue = AppIssue(
                        title: "复制成功，归档未完成",
                        message: "目标会话已保留并打开，原会话继续显示。可前往“设置 > 会话 > 已归档会话”重试。\n\n\(DiagnosticSanitizer.redact(error.localizedDescription))"
                    )
                    await reloadAllSessionLists()
                }
            } else {
                await reloadAllSessionLists()
                showNotice("完整会话已复制到目标项目；原会话继续保留。", level: "info")
            }
            return true
        } catch {
            present(error, title: "无法复制会话")
            return false
        }
    }

    func restoreArchivedSession(_ record: ArchivedSessionRecord) async {
        guard sessionArchiveStoreWritable,
              !isMutatingArchive,
              !isPromptTransactionActive else { return }
        isMutatingArchive = true
        defer { isMutatingArchive = false }
        let updated = archivedSessions.filter { $0.sessionID != record.sessionID }
        do {
            try await sessionArchiveStore.save(records: updated, pending: pendingArchiveRetry)
            archivedSessions = updated
            await refreshSessionVisibility()
            showNotice("会话已恢复显示；它会按原有来源和工作目录重新参与导航。", level: "info")
        } catch {
            present(error, title: "无法恢复归档会话")
        }
    }

    func retryPendingArchive() async {
        guard let record = pendingArchiveRetry,
              let copiedToSessionID = record.copiedToSessionID,
              let copiedToCwd = record.copiedToCwd,
              let client = readyClient,
              sessionArchiveStoreWritable,
              !isMutatingArchive,
              !isPromptTransactionActive else { return }
        isMutatingArchive = true
        defer { isMutatingArchive = false }
        do {
            let target: SessionInspection = try await client.request(
                "session.inspect",
                params: ["sessionId": .string(copiedToSessionID)]
            )
            guard target.summary.id == copiedToSessionID,
                  target.summary.cwd == copiedToCwd else {
                throw PiHostClientError.hostFailure(.init(
                    code: "SESSION_COPY_TARGET_CHANGED",
                    message: "复制目标已经不存在或工作目录发生变化，不能归档原会话",
                    details: nil
                ))
            }
            var updated = archivedSessions.filter { $0.sessionID != record.sessionID }
            updated.append(record)
            try await sessionArchiveStore.save(records: updated, pending: nil)
            archivedSessions = updated
            pendingArchiveRetry = nil
            await refreshSessionVisibility()
            showNotice("原会话归档已完成。", level: "info")
        } catch {
            present(error, title: "归档仍未完成")
        }
    }

    func openArchivedSession(_ record: ArchivedSessionRecord) async {
        guard !isStreaming, !isOpeningSession, !isMutatingArchive, !isPromptTransactionActive else { return }
        await flushCurrentDraft()
        _ = await openSession(record.sessionID, writable: false)
    }

    func openLineageSourceSession(_ sessionID: String) async {
        if let archived = archivedSessions.first(where: { $0.sessionID == sessionID }) {
            await openArchivedSession(archived)
        } else {
            await selectSession(sessionID)
        }
    }

    private func refreshSessionVisibility() async {
        visibilityGeneration = UUID()
        pinnedSessionPresentations = []
        recentSessions = []
        projectSessions.removeAll()
        activitySessions = []
        if searchPresented { scheduleSearch(refresh: true) }
        await reloadAllSessionLists()
    }

    private func hideArchivedSessionFromOrdinaryNavigation(_ sessionID: String) {
        visibilityGeneration = UUID()
        pinnedSessionPresentations.removeAll(where: { $0.id == sessionID })
        recentSessions.removeAll(where: { $0.id == sessionID })
        for projectID in Array(projectSessions.keys) {
            projectSessions[projectID]?.removeAll(where: { $0.id == sessionID })
        }
        activitySessions.removeAll(where: { $0.id == sessionID })
        searchResults.removeAll(where: { $0.sessionId == sessionID })
        if selectedSessionID == sessionID { clearActiveSessionPresentation() }
        if searchPresented { scheduleSearch(refresh: true) }
        Task { [weak self] in await self?.reloadAllSessionLists() }
    }

    func enqueueFollowUpFromComposer() async {
        guard followUpQueueStoreWritable,
              followUpQueueIssue == nil,
              !isMutatingFollowUpQueue,
              pendingPrompt == nil,
              let sessionID = selectedSessionID,
              let pathID = currentPathIdentity,
              let lineageEntryID = currentLineageEntryID,
              pendingPathDraft == nil else { return }
        let originalDraft = composerText
        let trimmed = originalDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !trimmed.hasPrefix("/") else { return }

        isMutatingFollowUpQueue = true
        defer { isMutatingFollowUpQueue = false }
        let now = Date().ISO8601Format()
        var next = followUpQueues
        let document = FollowUpQueueDocument(queues: next)
        if let queueIndex = document.matchingQueueIndex(
            sessionID: sessionID,
            currentPathID: pathID,
            orderedPathEntryIDs: currentPathEntryIDs
        ) {
            next[queueIndex].items.append(FollowUpQueueItem(text: originalDraft))
            if hasActiveRun,
               next[queueIndex].activeRunID == nil,
               let currentSessionRunID {
                next[queueIndex].activeRunID = currentSessionRunID
                next[queueIndex].activeRunEntryID = lineageEntryID
            }
            next[queueIndex].updatedAt = now
        } else {
            next.append(FollowUpQueueRecord(
                sessionID: sessionID,
                pathID: pathID,
                lineageEntryID: lineageEntryID,
                items: [FollowUpQueueItem(text: originalDraft)],
                activeRunID: hasActiveRun ? currentSessionRunID : nil,
                activeRunEntryID: hasActiveRun && currentSessionRunID != nil ? lineageEntryID : nil
            ))
        }
        guard await persistFollowUpQueues(next) else { return }

        if composerText == originalDraft {
            composerText = ""
            if let target = currentDraftTarget {
                setDraftText("", for: target)
                _ = await flushCurrentDraft()
            }
        }
        showNotice("已加入后续消息队列；当前运行不会被打断。", level: "info")
    }

    func editFollowUpItem(queueID: String, itemID: String, text: String) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !isMutatingFollowUpQueue else { return }
        isMutatingFollowUpQueue = true
        defer { isMutatingFollowUpQueue = false }
        var next = followUpQueues
        guard let queueIndex = next.firstIndex(where: { $0.id == queueID }),
              let itemIndex = next[queueIndex].items.firstIndex(where: { $0.id == itemID }),
              next[queueIndex].items[itemIndex].state == .pending else { return }
        let now = Date().ISO8601Format()
        next[queueIndex].items[itemIndex].text = text
        next[queueIndex].items[itemIndex].updatedAt = now
        next[queueIndex].updatedAt = now
        _ = await persistFollowUpQueues(next)
    }

    func moveFollowUpItem(queueID: String, itemID: String, offset: Int) async {
        guard offset == -1 || offset == 1, !isMutatingFollowUpQueue else { return }
        isMutatingFollowUpQueue = true
        defer { isMutatingFollowUpQueue = false }
        var next = followUpQueues
        guard let queueIndex = next.firstIndex(where: { $0.id == queueID }),
              let itemIndex = next[queueIndex].items.firstIndex(where: { $0.id == itemID }),
              next[queueIndex].items[itemIndex].state == .pending else { return }
        let destination = itemIndex + offset
        guard next[queueIndex].items.indices.contains(destination),
              next[queueIndex].items[destination].state == .pending else { return }
        let item = next[queueIndex].items.remove(at: itemIndex)
        next[queueIndex].items.insert(item, at: destination)
        next[queueIndex].updatedAt = Date().ISO8601Format()
        _ = await persistFollowUpQueues(next)
    }

    func removeFollowUpItem(queueID: String, itemID: String) async {
        guard !isMutatingFollowUpQueue else { return }
        isMutatingFollowUpQueue = true
        defer { isMutatingFollowUpQueue = false }
        var next = followUpQueues
        guard let queueIndex = next.firstIndex(where: { $0.id == queueID }),
              let itemIndex = next[queueIndex].items.firstIndex(where: { $0.id == itemID }),
              next[queueIndex].items[itemIndex].state == .pending else { return }
        next[queueIndex].items.remove(at: itemIndex)
        if next[queueIndex].items.isEmpty, next[queueIndex].activeRunID == nil {
            next.remove(at: queueIndex)
        } else {
            next[queueIndex].updatedAt = Date().ISO8601Format()
        }
        _ = await persistFollowUpQueues(next)
    }

    func resumeFollowUpQueue(_ queueID: String) async {
        guard !isStreaming,
              extensionDialogs.isEmpty,
              !isMutatingFollowUpQueue,
              let queue = currentFollowUpQueue,
              queue.id == queueID,
              queue.pauseReason != nil,
              queue.pauseReason?.requiresResultResolution != true,
              queue.pathID == currentPathIdentity,
              currentPathEntryIDs.contains(queue.lineageEntryID),
              let lineageEntryID = currentLineageEntryID else { return }
        isMutatingFollowUpQueue = true
        var next = followUpQueues
        guard let queueIndex = next.firstIndex(where: { $0.id == queueID }) else {
            isMutatingFollowUpQueue = false
            return
        }
        next[queueIndex].lineageEntryID = lineageEntryID
        next[queueIndex].pathID = currentPathIdentity ?? next[queueIndex].pathID
        next[queueIndex].activeRunID = nil
        next[queueIndex].activeRunEntryID = nil
        next[queueIndex].pauseReason = nil
        next[queueIndex].updatedAt = Date().ISO8601Format()
        let saved = await persistFollowUpQueues(next)
        isMutatingFollowUpQueue = false
        if saved { await dispatchNextFollowUp(queueID: queueID) }
    }

    func resolveUnknownDispatch(_ queueID: String, wasPersisted: Bool) async {
        guard !isMutatingFollowUpQueue,
              let queue = currentFollowUpQueue,
              queue.id == queueID,
              queue.pauseReason == .dispatchUnknown,
              queue.items.first?.state == .unknown,
              currentPathEntryIDs.contains(queue.lineageEntryID),
              let lineageEntryID = currentLineageEntryID else { return }
        isMutatingFollowUpQueue = true
        defer { isMutatingFollowUpQueue = false }
        var next = followUpQueues
        guard let queueIndex = next.firstIndex(where: { $0.id == queueID }) else { return }
        if wasPersisted {
            next[queueIndex].items.removeFirst()
            next[queueIndex].lineageEntryID = lineageEntryID
            next[queueIndex].pathID = currentPathIdentity ?? next[queueIndex].pathID
        } else {
            next[queueIndex].items[0].state = .pending
            next[queueIndex].items[0].promptID = nil
            next[queueIndex].items[0].updatedAt = Date().ISO8601Format()
        }
        next[queueIndex].activeRunID = nil
        next[queueIndex].activeRunEntryID = nil
        next[queueIndex].pauseReason = .manualResume
        next[queueIndex].updatedAt = Date().ISO8601Format()
        if next[queueIndex].items.isEmpty {
            next.remove(at: queueIndex)
        }
        _ = await persistFollowUpQueues(next)
    }

    func resolveUnknownRun(_ queueID: String) async {
        guard !isMutatingFollowUpQueue,
              let queue = currentFollowUpQueue,
              queue.id == queueID,
              queue.pauseReason == .runOutcomeUnknown,
              currentPathEntryIDs.contains(queue.lineageEntryID),
              let lineageEntryID = currentLineageEntryID else { return }
        isMutatingFollowUpQueue = true
        defer { isMutatingFollowUpQueue = false }
        var next = followUpQueues
        guard let queueIndex = next.firstIndex(where: { $0.id == queueID }) else { return }
        next[queueIndex].lineageEntryID = lineageEntryID
        next[queueIndex].pathID = currentPathIdentity ?? next[queueIndex].pathID
        next[queueIndex].activeRunID = nil
        next[queueIndex].activeRunEntryID = nil
        next[queueIndex].pauseReason = .manualResume
        next[queueIndex].updatedAt = Date().ISO8601Format()
        if next[queueIndex].items.isEmpty {
            next.remove(at: queueIndex)
        }
        _ = await persistFollowUpQueues(next)
    }

    @discardableResult
    private func persistFollowUpQueues(_ next: [FollowUpQueueRecord]) async -> Bool {
        guard followUpQueueStoreWritable else { return false }
        followUpQueueRevision += 1
        do {
            try await followUpQueueStore.save(
                FollowUpQueueDocument(queues: next),
                revision: followUpQueueRevision
            )
            followUpQueues = next
            return true
        } catch let queueError as FollowUpQueueStoreError {
            switch queueError {
            case .unavailableAfterLoadFailure:
                followUpQueueStoreWritable = false
                followUpQueueIssue = "后续消息队列保存已锁止；原文件保留在：\(followUpQueueStore.fileURL.path)"
            default:
                showNotice(queueError.localizedDescription, level: "warning")
                return false
            }
        } catch {
            followUpQueueStoreWritable = false
            followUpQueueIssue = "后续消息队列保存失败；原文件已保留，本次停止继续写入：\(followUpQueueStore.fileURL.path)"
        }
        showNotice(followUpQueueIssue ?? "后续消息队列保存失败。", level: "warning")
        return false
    }

    @discardableResult
    func reloadFollowUpQueues(announceSuccess: Bool = true) async -> Bool {
        guard !isMutatingFollowUpQueue,
              pendingPrompt?.isFollowUpDispatch != true else { return false }
        isMutatingFollowUpQueue = true
        defer { isMutatingFollowUpQueue = false }
        do {
            var document = try await followUpQueueStore.load()
            var normalizedInterruptedState = false
            let now = Date().ISO8601Format()
            for queueIndex in document.queues.indices {
                if let itemIndex = document.queues[queueIndex].items.firstIndex(where: { $0.state == .dispatching }) {
                    document.queues[queueIndex].items[itemIndex].state = .unknown
                    document.queues[queueIndex].pauseReason = .dispatchUnknown
                    document.queues[queueIndex].updatedAt = now
                    normalizedInterruptedState = true
                } else if document.queues[queueIndex].activeRunID != nil {
                    document.queues[queueIndex].pauseReason = .runOutcomeUnknown
                    document.queues[queueIndex].updatedAt = now
                    normalizedInterruptedState = true
                } else if !document.queues[queueIndex].items.isEmpty,
                          document.queues[queueIndex].pauseReason == nil {
                    // The App may have stopped after durably marking the queue ready
                    // but before the next Host request began. Make that crash window
                    // explicit and user-resumable instead of leaving a silent queue.
                    document.queues[queueIndex].pauseReason = .manualResume
                    document.queues[queueIndex].updatedAt = now
                    normalizedInterruptedState = true
                }
            }
            if normalizedInterruptedState {
                followUpQueueRevision += 1
                try await followUpQueueStore.save(document, revision: followUpQueueRevision)
            }
            followUpQueues = document.queues
            followUpQueueStoreWritable = true
            followUpQueueIssue = nil
            if announceSuccess {
                showNotice("后续消息队列已重新载入。", level: "info")
            }
            return true
        } catch {
            followUpQueueStoreWritable = false
            followUpQueueIssue = "后续消息队列未能安全载入；原文件已保留，本次不会覆盖：\(followUpQueueStore.fileURL.path)"
            showNotice(followUpQueueIssue ?? "后续消息队列未能载入。", level: "warning")
            return false
        }
    }

    func sendPrompt(deliveryMode: RunningMessageDeliveryMode = .queue) async {
        if isNewSessionDraftActive {
            await createSessionFromDraftAndSend()
            return
        }
        if hasActiveRun, deliveryMode == .steer {
            await steerFromComposer()
            return
        }
        if shouldQueueComposerText {
            await enqueueFollowUpFromComposer()
            return
        }
        await sendPromptToSelectedSession()
    }

    private func steerFromComposer() async {
        guard let client = readyClient,
              let sessionID = selectedSessionID,
              let runID = currentSessionRunID,
              isStreaming,
              currentRunState?.phase == .running,
              canWrite,
              pendingPathDraft == nil,
              extensionDialogs.isEmpty,
              pendingSteer == nil,
              canPersistSessionDrafts else { return }
        let draft = composerText
        let message = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !message.isEmpty, !message.hasPrefix("/") else { return }
        guard await flushCurrentDraft() else { return }

        let steerID = UUID().uuidString
        pendingSteer = PendingSteerDraft(
            sessionID: sessionID,
            runID: runID,
            steerID: steerID,
            draft: draft,
            draftTarget: currentDraftTarget,
            accepted: false
        )
        composerText = ""
        isSendingRequest = true
        defer { isSendingRequest = false }
        do {
            let result: SessionSteerResult = try await client.request("session.steer", params: [
                "message": .string(message),
                "steerId": .string(steerID),
                "expectedRunId": .string(runID),
            ])
            guard result.accepted,
                  result.steerID == steerID,
                  result.runID == runID else {
                throw PiHostClientError.invalidEnvelope("session.steer 未确认请求的 Steer / Run 身份")
            }
            guard pendingSteer?.steerID == steerID else { return }
            pendingSteer?.accepted = true
            if let currentRunState { settlePendingSteer(for: currentRunState) }
        } catch {
            restorePendingSteer(steerID: steerID)
            present(error, title: "无法立即介入当前运行")
        }
    }

    private func settlePendingSteer(for state: SessionRunState) {
        guard let pendingSteer,
              pendingSteer.accepted,
              pendingSteer.sessionID == state.sessionID,
              pendingSteer.runID == state.runID,
              !state.phase.isActive else { return }
        self.pendingSteer = nil
        if state.phase == .completed {
            if let target = pendingSteer.draftTarget {
                setDraftText("", for: target)
                scheduleDraftSave()
            }
            showNotice("介入信息已由 Pi 应用。", level: "info")
            return
        }
        restoreSteerDraft(pendingSteer)
        showNotice("当前运行未正常完成，介入正文已恢复到输入框。", level: "warning")
    }

    private func restorePendingSteer(steerID: String) {
        guard let pendingSteer, pendingSteer.steerID == steerID else { return }
        self.pendingSteer = nil
        restoreSteerDraft(pendingSteer)
    }

    private func restoreSteerDraft(_ pending: PendingSteerDraft) {
        let restored = combineDraft(pending.draft, with: composerText)
        if pending.sessionID == selectedSessionID {
            composerText = restored
        }
        if let target = pending.draftTarget {
            setDraftText(restored, for: target)
            scheduleDraftSave()
        }
    }

    func retryCurrentRunSafely() async {
        guard canSafelyRetryCurrentRun else { return }
        await sendPromptToSelectedSession(failureTitle: "安全重试失败")
    }

    private func createSessionFromDraftAndSend() async {
        guard let client = readyClient,
              let draft = newSessionDraft,
              isNewSessionDraftActive,
              !isCreatingSession,
              !isOpeningSession,
              !isStreaming,
              !isMutatingArchive,
              !isSendingRequest,
              pendingPrompt == nil else { return }
        let message = draft.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !message.isEmpty else { return }
        guard let initialModel = selectedNewSessionModel else {
            newSessionModelIssue = "请先选择一个可用模型，再发送第一条消息。"
            return
        }

        isCreatingSession = true
        defer { isCreatingSession = false }
        do {
            let result: SessionCreateResult = try await client.request(
                "session.create",
                params: ["cwd": .string(draft.directoryPath)]
            )
            // The first submit action is the visibility commit point. A blank
            // local draft never reaches Pi or the Recent list.
            visibilityGeneration = UUID()
            upsertCreatedSession(result.session)

            let initialTarget = SessionDraftTarget.path(
                sessionID: result.session.id,
                pathID: "root"
            )
            draftDocument.activeTargets[result.session.id] = initialTarget
            setDraftText(draft.text, for: initialTarget)
            newSessionDraft = nil
            draftDocument.newSessionDraft = nil
            isNewSessionDraftActive = false
            guard await flushCurrentDraft() else {
                issue = AppIssue(
                    title: "会话已创建，但首次消息尚未发送",
                    message: "输入仍保留在当前内存中，但草稿资料未能完成到真实会话的安全转移；本次不会继续打开或发送。请先修复草稿资料，再从最近会话重试。"
                )
                return
            }

            // Make the newly durable row observable before the previous runtime
            // finishes yielding its write lease.
            await Task.yield()
            let openedWritable = await openSession(
                result.session.id,
                writable: true,
                draftTargetAfterOpen: initialTarget
            )
            Task { [weak self] in await self?.reloadAllSessionLists() }

            guard selectedSessionID == result.session.id else {
                issue = AppIssue(
                    title: "会话已创建，但首次消息尚未发送",
                    message: "输入内容已作为该会话的草稿保留。请稍后从最近会话重新打开并发送。"
                )
                return
            }
            if composerText != draft.text {
                updateComposerText(draft.text)
            }
            guard openedWritable else {
                issue = AppIssue(
                    title: "会话已创建，但首次消息尚未发送",
                    message: "输入内容已保留在该会话草稿中；当前只读或旧运行时尚未安全结束，请稍后重试。"
                )
                return
            }
            guard await applyInitialModel(initialModel, to: result.session.id) else { return }
            guard await applyInitialThinkingLevel(draft.selectedThinkingLevel, to: result.session.id) else { return }
            guard await applyInitialFastMode(draft.fastModeEnabled, to: result.session.id) else { return }
            await sendPromptToSelectedSession(failureTitle: "会话已创建，但首次消息尚未发送")
        } catch {
            present(error, title: "无法创建会话")
        }
    }

    private func applyInitialModel(_ model: HostModel, to sessionID: String) async -> Bool {
        guard let client = readyClient,
              selectedSessionID == sessionID,
              canWrite else { return false }
        do {
            let result: ModelSelectionResult = try await client.request(
                "session.setModel",
                params: [
                    "provider": .string(model.provider),
                    "modelId": .string(model.id),
                ]
            )
            guard result.model.provider == model.provider,
                  result.model.id == model.id else {
                issue = AppIssue(
                    title: "会话已创建，但首次消息尚未发送",
                    message: "Pi Host 未确认所选模型；输入内容仍保留在该会话草稿中，本次不会发送。"
                )
                return false
            }
            await refreshState()
            return true
        } catch {
            issue = AppIssue(
                title: "会话已创建，但首次消息尚未发送",
                message: "所选模型未能应用，输入内容仍保留在该会话草稿中，本次不会发送。\n\n\(DiagnosticSanitizer.redact(error.localizedDescription))"
            )
            return false
        }
    }

    private func applyInitialThinkingLevel(_ level: String?, to sessionID: String) async -> Bool {
        guard let level else { return true }
        guard let client = readyClient,
              selectedSessionID == sessionID,
              canWrite else { return false }
        do {
            let result: Acknowledgement = try await client.request(
                "session.setThinking",
                params: ["level": .string(level)]
            )
            guard result.level == level else {
                issue = AppIssue(
                    title: "会话已创建，但首次消息尚未发送",
                    message: "Pi Host 未确认所选思考强度；输入内容仍保留在该会话草稿中，本次不会发送。"
                )
                return false
            }
            await refreshState()
            return true
        } catch {
            issue = AppIssue(
                title: "会话已创建，但首次消息尚未发送",
                message: "所选思考强度未能应用，输入内容仍保留在该会话草稿中，本次不会发送。\n\n\(DiagnosticSanitizer.redact(error.localizedDescription))"
            )
            return false
        }
    }

    private func applyInitialFastMode(_ enabled: Bool, to sessionID: String) async -> Bool {
        guard enabled else { return true }
        guard let client = readyClient,
              selectedSessionID == sessionID,
              canWrite else { return false }
        do {
            let result: FastModeState = try await client.request(
                "session.setFastMode",
                params: ["enabled": .bool(true)]
            )
            guard result.enabled, result.active else {
                issue = AppIssue(
                    title: "会话已创建，但首次消息尚未发送",
                    message: "当前模型未确认支持极速；输入内容仍保留在该会话草稿中，本次不会发送。"
                )
                return false
            }
            await refreshState()
            return true
        } catch {
            issue = AppIssue(
                title: "会话已创建，但首次消息尚未发送",
                message: "极速设置未能应用，输入内容仍保留在该会话草稿中，本次不会发送。\n\n\(DiagnosticSanitizer.redact(error.localizedDescription))"
            )
            return false
        }
    }

    private func sendPromptToSelectedSession(failureTitle: String = "发送失败") async {
        guard readyClient != nil,
              let sourceSessionID = selectedSessionID,
              !isMutatingArchive,
              !isSendingRequest,
              pendingPrompt == nil else { return }
        let draft = composerText
        let draftTarget = currentDraftTarget
        guard draftTarget == nil || draftTarget?.sessionID == sourceSessionID else { return }
        let pathAction = draftTarget?.actionForSending(currentPathID: inspection?.currentPathId)
        let message = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !message.isEmpty else { return }
        deferredComposerText = nil
        isSendingRequest = true
        defer {
            isSendingRequest = false
            if pendingPrompt == nil { applyDeferredComposerText() }
        }
        guard await ensureWritable() else {
            applyDeferredComposerText()
            return
        }
        guard let client = readyClient, selectedSessionID == sourceSessionID else {
            applyDeferredComposerText()
            return
        }
        let sessionID = sourceSessionID
        let promptID = UUID().uuidString
        pendingPrompt = PendingPromptDraft(
            sessionID: sessionID,
            promptID: promptID,
            draft: draft,
            draftTarget: draftTarget
        )
        composerText = ""
        optimisticUserMessage = message
        do {
            var params: [String: JSONValue] = [
                "message": .string(message),
                "promptId": .string(promptID),
            ]
            if let pathAction {
                params["pathAction"] = .object([
                    "kind": .string(pathAction.kind.rawValue),
                    "entryId": .string(pathAction.entryId),
                ])
            }
            let _: Acknowledgement = try await client.request("session.prompt", params: params)
        } catch {
            restorePendingPrompt(for: sessionID)
            present(error, title: failureTitle)
        }
    }

    private func dispatchNextFollowUp(queueID: String) async {
        guard !isShuttingDown,
              !isMutatingFollowUpQueue,
              !hasActiveRun,
              currentRunState?.phase != .unknown,
              extensionDialogs.isEmpty,
              pendingPrompt == nil,
              let selectedSessionID,
              currentFollowUpQueue?.id == queueID else { return }
        isMutatingFollowUpQueue = true
        defer { isMutatingFollowUpQueue = false }

        guard await ensureWritable(),
              let client = readyClient,
              self.selectedSessionID == selectedSessionID else {
            await pauseFollowUpQueueInline(queueID: queueID, reason: .hostInterrupted)
            return
        }
        var next = followUpQueues
        guard let queueIndex = next.firstIndex(where: { $0.id == queueID }),
              next[queueIndex].sessionID == selectedSessionID,
              next[queueIndex].pauseReason == nil,
              next[queueIndex].activeRunID == nil,
              let item = next[queueIndex].items.first,
              item.state == .pending,
              currentPathEntryIDs.contains(next[queueIndex].lineageEntryID) else {
            return
        }

        let promptID = UUID().uuidString
        let now = Date().ISO8601Format()
        next[queueIndex].items[0].state = .dispatching
        next[queueIndex].items[0].promptID = promptID
        next[queueIndex].items[0].updatedAt = now
        next[queueIndex].updatedAt = now
        guard await persistFollowUpQueues(next) else { return }

        pendingPrompt = PendingPromptDraft(
            sessionID: selectedSessionID,
            promptID: promptID,
            draft: item.text,
            followUpQueueID: queueID,
            followUpItemID: item.id
        )
        isSendingRequest = true
        defer { isSendingRequest = false }
        do {
            let _: Acknowledgement = try await client.request("session.prompt", params: [
                "message": .string(item.text),
                "promptId": .string(promptID),
            ])
        } catch {
            await markFollowUpDispatchUnknown(
                queueID: queueID,
                itemID: item.id,
                promptID: promptID
            )
            if pendingPrompt?.promptID == promptID { pendingPrompt = nil }
            present(error, title: "后续消息派发结果未知")
        }
    }

    private func confirmFollowUpPromptPersisted(
        sessionID: String,
        promptID: String,
        entryID: String
    ) async {
        await waitForFollowUpMutation()
        guard let pending = pendingPrompt,
              pending.sessionID == sessionID,
              pending.promptID == promptID,
              let queueID = pending.followUpQueueID,
              let itemID = pending.followUpItemID else { return }
        isMutatingFollowUpQueue = true
        defer { isMutatingFollowUpQueue = false }
        var next = followUpQueues
        guard let queueIndex = next.firstIndex(where: { $0.id == queueID }),
              let itemIndex = next[queueIndex].items.firstIndex(where: {
                  $0.id == itemID && $0.promptID == promptID && $0.state == .dispatching
              }) else {
            await markFollowUpDispatchUnknown(
                queueID: queueID,
                itemID: itemID,
                promptID: promptID
            )
            pendingPrompt = nil
            return
        }
        next[queueIndex].items.remove(at: itemIndex)
        next[queueIndex].lineageEntryID = entryID
        next[queueIndex].pathID = "leaf:\(entryID)"
        next[queueIndex].activeRunID = promptID
        next[queueIndex].activeRunEntryID = entryID
        next[queueIndex].pauseReason = nil
        next[queueIndex].updatedAt = Date().ISO8601Format()
        let saved = await persistFollowUpQueues(next)
        if !saved {
            markFollowUpDispatchUnknownInMemory(
                queueID: queueID,
                itemID: itemID,
                promptID: promptID
            )
        }
        currentSessionRunID = promptID
        _ = completePersistedPrompt(sessionID: sessionID, promptID: promptID, entryID: entryID)
    }

    private func failFollowUpPrompt(
        sessionID: String,
        promptID: String,
        persistedEntryID: String?,
        message: String
    ) async {
        await waitForFollowUpMutation()
        guard let pending = pendingPrompt,
              pending.sessionID == sessionID,
              pending.promptID == promptID,
              let queueID = pending.followUpQueueID,
              let itemID = pending.followUpItemID else { return }
        isMutatingFollowUpQueue = true
        defer { isMutatingFollowUpQueue = false }
        var next = followUpQueues
        guard let queueIndex = next.firstIndex(where: { $0.id == queueID }),
              let itemIndex = next[queueIndex].items.firstIndex(where: {
                  $0.id == itemID && $0.promptID == promptID
              }) else {
            pendingPrompt = nil
            return
        }
        let now = Date().ISO8601Format()
        if let persistedEntryID {
            next[queueIndex].items.remove(at: itemIndex)
            next[queueIndex].lineageEntryID = persistedEntryID
            next[queueIndex].pathID = "leaf:\(persistedEntryID)"
        } else {
            next[queueIndex].items[itemIndex].state = .pending
            next[queueIndex].items[itemIndex].promptID = nil
            next[queueIndex].items[itemIndex].updatedAt = now
        }
        next[queueIndex].activeRunID = nil
        next[queueIndex].activeRunEntryID = nil
        next[queueIndex].pauseReason = .runFailed
        next[queueIndex].updatedAt = now
        if next[queueIndex].items.isEmpty {
            next.remove(at: queueIndex)
        }
        _ = await persistFollowUpQueues(next)
        if let persistedEntryID {
            _ = completePersistedPrompt(
                sessionID: sessionID,
                promptID: promptID,
                entryID: persistedEntryID
            )
        } else {
            pendingPrompt = nil
        }
        showNotice(message, level: "error")
    }

    private func failActiveFollowUpRun(
        sessionID: String,
        promptID: String,
        persistedEntryID: String?,
        message: String
    ) async {
        await waitForFollowUpMutation()
        guard !isMutatingFollowUpQueue else { return }
        isMutatingFollowUpQueue = true
        defer { isMutatingFollowUpQueue = false }
        var next = followUpQueues
        guard let queueIndex = next.firstIndex(where: {
            $0.sessionID == sessionID && $0.activeRunID == promptID
        }) else { return }
        if let persistedEntryID {
            next[queueIndex].lineageEntryID = persistedEntryID
            next[queueIndex].pathID = "leaf:\(persistedEntryID)"
        }
        next[queueIndex].activeRunID = nil
        next[queueIndex].activeRunEntryID = nil
        next[queueIndex].pauseReason = .runFailed
        next[queueIndex].updatedAt = Date().ISO8601Format()
        if next[queueIndex].items.isEmpty {
            next.remove(at: queueIndex)
        }
        _ = await persistFollowUpQueues(next)
        showNotice(message, level: "error")
    }

    private func settleFollowUpRun(runID: String?) async {
        guard !isShuttingDown else { return }
        await waitForFollowUpMutation()
        if readyClient != nil, selectedSessionID != nil {
            await refreshSnapshot()
        }
        await waitForFollowUpMutation()
        guard !isMutatingFollowUpQueue,
              let sessionID = selectedSessionID else { return }
        let document = FollowUpQueueDocument(queues: followUpQueues)
        let queueIndex = runID.flatMap { candidate in
            followUpQueues.firstIndex(where: {
                $0.sessionID == sessionID && $0.activeRunID == candidate
            })
        } ?? document.matchingQueueIndex(
            sessionID: sessionID,
            currentPathID: currentPathIdentity,
            orderedPathEntryIDs: currentPathEntryIDs
        )
        guard let queueIndex,
              followUpQueues[queueIndex].pauseReason == nil,
              followUpQueues[queueIndex].activeRunID == nil
                || runID == followUpQueues[queueIndex].activeRunID else { return }

        isMutatingFollowUpQueue = true
        var next = followUpQueues
        let queueID = next[queueIndex].id
        let now = Date().ISO8601Format()
        let pathStillMatches = currentPathEntryIDs.contains(next[queueIndex].lineageEntryID)
        let nextLineageEntryID = currentLineageEntryID
        let outcome: SessionRunPhase = {
            guard let runID,
                  let state = currentRunState,
                  state.sessionID == sessionID,
                  state.runID == runID,
                  !state.phase.isActive else { return .unknown }
            return state.phase
        }()
        var shouldDispatch = false

        if !pathStillMatches || nextLineageEntryID == nil {
            next[queueIndex].activeRunID = nil
            next[queueIndex].activeRunEntryID = nil
            next[queueIndex].pauseReason = .pathChanged
        } else if !extensionDialogs.isEmpty {
            next[queueIndex].lineageEntryID = nextLineageEntryID ?? next[queueIndex].lineageEntryID
            next[queueIndex].pathID = currentPathIdentity ?? next[queueIndex].pathID
            next[queueIndex].activeRunID = nil
            next[queueIndex].activeRunEntryID = nil
            next[queueIndex].pauseReason = .waitingForUser
        } else {
            switch outcome {
            case .completed:
                next[queueIndex].lineageEntryID = nextLineageEntryID ?? next[queueIndex].lineageEntryID
                next[queueIndex].pathID = currentPathIdentity ?? next[queueIndex].pathID
                next[queueIndex].activeRunID = nil
                next[queueIndex].activeRunEntryID = nil
                next[queueIndex].pauseReason = nil
                shouldDispatch = !next[queueIndex].items.isEmpty
            case .failed:
                next[queueIndex].lineageEntryID = nextLineageEntryID ?? next[queueIndex].lineageEntryID
                next[queueIndex].pathID = currentPathIdentity ?? next[queueIndex].pathID
                next[queueIndex].activeRunID = nil
                next[queueIndex].activeRunEntryID = nil
                next[queueIndex].pauseReason = .runFailed
            case .aborted:
                next[queueIndex].lineageEntryID = nextLineageEntryID ?? next[queueIndex].lineageEntryID
                next[queueIndex].pathID = currentPathIdentity ?? next[queueIndex].pathID
                next[queueIndex].activeRunID = nil
                next[queueIndex].activeRunEntryID = nil
                next[queueIndex].pauseReason = .runAborted
            case .unknown, .running, .waitingForUser, .stopRequested:
                if next[queueIndex].activeRunID == nil, let runID {
                    next[queueIndex].activeRunID = runID
                    next[queueIndex].activeRunEntryID = nextLineageEntryID
                }
                next[queueIndex].pauseReason = .runOutcomeUnknown
            }
        }
        next[queueIndex].updatedAt = now
        if next[queueIndex].items.isEmpty,
           next[queueIndex].activeRunID == nil,
           next[queueIndex].pauseReason == nil {
            next.remove(at: queueIndex)
            shouldDispatch = false
        }
        let saved = await persistFollowUpQueues(next)
        isMutatingFollowUpQueue = false
        if saved, shouldDispatch {
            await dispatchNextFollowUp(queueID: queueID)
        }
    }

    private func markFollowUpDispatchUnknown(
        queueID: String,
        itemID: String,
        promptID: String
    ) async {
        var next = followUpQueues
        guard let queueIndex = next.firstIndex(where: { $0.id == queueID }),
              let itemIndex = next[queueIndex].items.firstIndex(where: {
                  $0.id == itemID && $0.promptID == promptID
              }) else { return }
        next[queueIndex].items[itemIndex].state = .unknown
        next[queueIndex].items[itemIndex].updatedAt = Date().ISO8601Format()
        next[queueIndex].pauseReason = .dispatchUnknown
        next[queueIndex].updatedAt = Date().ISO8601Format()
        if !(await persistFollowUpQueues(next)) {
            followUpQueues = next
        }
    }

    private func markFollowUpDispatchUnknownInMemory(
        queueID: String,
        itemID: String,
        promptID: String
    ) {
        guard let queueIndex = followUpQueues.firstIndex(where: { $0.id == queueID }),
              let itemIndex = followUpQueues[queueIndex].items.firstIndex(where: {
                  $0.id == itemID && $0.promptID == promptID
              }) else { return }
        followUpQueues[queueIndex].items[itemIndex].state = .unknown
        followUpQueues[queueIndex].pauseReason = .dispatchUnknown
        followUpQueues[queueIndex].updatedAt = Date().ISO8601Format()
    }

    private func pauseFollowUpQueueInline(
        queueID: String,
        reason: FollowUpQueuePauseReason
    ) async {
        var next = followUpQueues
        guard let queueIndex = next.firstIndex(where: { $0.id == queueID }) else { return }
        if let itemIndex = next[queueIndex].items.firstIndex(where: { $0.state == .dispatching }) {
            next[queueIndex].items[itemIndex].state = .unknown
            next[queueIndex].pauseReason = .dispatchUnknown
        } else {
            next[queueIndex].pauseReason = reason
        }
        next[queueIndex].updatedAt = Date().ISO8601Format()
        _ = await persistFollowUpQueues(next)
    }

    private func pauseFollowUpQueues(
        sessionID: String?,
        reason: FollowUpQueuePauseReason
    ) async {
        await waitForFollowUpMutation()
        guard !isMutatingFollowUpQueue else { return }
        isMutatingFollowUpQueue = true
        defer { isMutatingFollowUpQueue = false }
        var next = followUpQueues
        var changed = false
        let now = Date().ISO8601Format()
        for queueIndex in next.indices where sessionID == nil || next[queueIndex].sessionID == sessionID {
            var queueChanged = false
            if let itemIndex = next[queueIndex].items.firstIndex(where: { $0.state == .dispatching }) {
                next[queueIndex].items[itemIndex].state = .unknown
                next[queueIndex].pauseReason = .dispatchUnknown
                queueChanged = true
            } else if next[queueIndex].activeRunID != nil {
                next[queueIndex].pauseReason = reason
                queueChanged = true
            }
            if queueChanged {
                next[queueIndex].updatedAt = now
                changed = true
            }
        }
        if changed { _ = await persistFollowUpQueues(next) }
    }

    private func pauseFollowUpQueuesForShutdown() async {
        await pauseFollowUpQueues(sessionID: nil, reason: .hostInterrupted)
    }

    private func waitForFollowUpMutation() async {
        while isMutatingFollowUpQueue, !Task.isCancelled {
            try? await Task.sleep(for: .milliseconds(10))
        }
    }

    private func isTrackedFollowUpRun(sessionID: String?, runID: String?) -> Bool {
        guard let sessionID else { return false }
        if let runID,
           followUpQueues.contains(where: {
               $0.sessionID == sessionID && $0.activeRunID == runID
           }) {
            return true
        }
        return selectedSessionID == sessionID
            && currentFollowUpQueue?.pauseReason == nil
            && currentFollowUpQueue?.items.isEmpty == false
    }

    private func cancelFollowUpSettlementGate() {
        followUpSettlementGeneration = UUID()
        followUpSettlementTask?.cancel()
        followUpSettlementTask = nil
        followUpSettlementRunID = nil
        isSettlingFollowUpRun = false
    }

    private func scheduleFollowUpSettlement(for state: SessionRunState) {
        guard !state.phase.isActive,
              isTrackedFollowUpRun(sessionID: state.sessionID, runID: state.runID) else { return }
        if followUpSettlementRunID == state.runID, followUpSettlementTask != nil { return }
        followUpSettlementTask?.cancel()
        isSettlingFollowUpRun = true
        followUpSettlementRunID = state.runID
        let generation = UUID()
        followUpSettlementGeneration = generation
        followUpSettlementTask = Task { [weak self] in
            do { try await Task.sleep(for: .milliseconds(180)) }
            catch {
                guard let self,
                      self.followUpSettlementGeneration == generation else { return }
                self.isSettlingFollowUpRun = false
                self.followUpSettlementTask = nil
                self.followUpSettlementRunID = nil
                return
            }
            await self?.settleFollowUpRun(runID: state.runID)
            guard let self,
                  self.followUpSettlementGeneration == generation else { return }
            self.isSettlingFollowUpRun = false
            self.followUpSettlementTask = nil
            self.followUpSettlementRunID = nil
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
        guard !isPromptTransactionActive else { return }
        guard await ensureWritable(), let client = readyClient else { return }
        do {
            let _: Acknowledgement = try await client.request("session.setThinking", params: ["level": .string(level)])
            await refreshState()
        } catch {
            present(error, title: "无法切换 Thinking level")
        }
    }

    func setComposerThinkingLevel(_ level: String) async {
        if isNewSessionDraftActive {
            selectNewSessionThinkingLevel(level)
            return
        }
        await setThinkingLevel(level)
    }

    func setModel(_ model: HostModel) async {
        guard !isPromptTransactionActive else { return }
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

    func setComposerFastModeEnabled(_ enabled: Bool) async {
        if isNewSessionDraftActive {
            guard !enabled || composerFastModeSupported else { return }
            newSessionDraft?.fastModeEnabled = enabled
            persistNewSessionDraftIfMeaningful()
            return
        }
        guard !enabled || composerFastModeSupported else { return }
        guard !isPromptTransactionActive else { return }
        guard await ensureWritable(), let client = readyClient else { return }
        do {
            let result: FastModeState = try await client.request(
                "session.setFastMode",
                params: ["enabled": .bool(enabled)]
            )
            guard result.enabled == enabled else {
                showNotice("Pi Host 未确认速度设置，请重试。", level: "warning")
                return
            }
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
        guard !isCopyingSession else { throw ProjectStoreError.mutationBlockedDuringSessionCopy }
        let result = try ProjectStore.applying(
            projectID: id,
            name: name,
            folderURLs: folderURLs,
            to: projects,
            moveConflicts: moveConflicts
        )
        try await projectStore.save(result.projects)
        projects = result.projects
        reconcileSearchScope()
        reconcileWorkspaceFileAuthorizations()
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
        if searchPresented { scheduleSearch(refresh: true) }
        return result.savedProjectID
    }

    func deleteProject(_ projectID: UUID) async throws {
        guard projectStoreWritable else { throw ProjectStoreError.unavailableAfterLoadFailure }
        guard !isCopyingSession else { throw ProjectStoreError.mutationBlockedDuringSessionCopy }
        let updated = projects.filter { $0.id != projectID }
        try await projectStore.save(updated)
        projects = updated
        reconcileSearchScope()
        reconcileWorkspaceFileAuthorizations()
        projectSessions.removeValue(forKey: projectID)
        projectHasMore.removeValue(forKey: projectID)
        projectSessionErrors.removeValue(forKey: projectID)
        projectWindows.removeValue(forKey: projectID)
        expandedProjectIDs.remove(projectID)
        if selectedProjectID == projectID { selectedProjectID = nil }
        if inspectorScope == .project(projectID) {
            inspectorScope = selectedSessionID.map(InspectorScope.session)
        }
        if searchProjectID == projectID {
            searchProjectID = nil
            searchSourceFolderPath = nil
        }
        if searchPresented { scheduleSearch(refresh: true) }
    }

    func loadProjects() async {
        do {
            projects = try await projectStore.load()
            reconcileSearchScope()
            reconcileWorkspaceFileAuthorizations()
            projectStoreWritable = true
            expandedProjectIDs = []
            projectSessionErrors.removeAll()
        } catch {
            projects = []
            reconcileSearchScope()
            reconcileWorkspaceFileAuthorizations()
            projectStoreWritable = false
            projectSessionErrors.removeAll()
            issue = AppIssue(
                title: "无法读取项目资料",
                message: "D Code 已保留原文件并停止项目写入。请检查或移走下面的文件后重新启动 D Code：\n\n\(projectStore.fileURL.path)\n\n\(DiagnosticSanitizer.redact(error.localizedDescription))"
            )
        }
    }

    func loadSessionMetadata() async -> Bool {
        do {
            let archiveDocument = try await sessionArchiveStore.loadDocument()
            archivedSessions = archiveDocument.records
            pendingArchiveRetry = archiveDocument.pending
            sessionArchiveStoreWritable = true
        } catch {
            archivedSessions = []
            sessionArchiveStoreWritable = false
            issue = AppIssue(
                title: "无法读取会话归档",
                message: "D Code 已保留原文件并停止普通会话导航，避免已归档会话重新泄漏。请检查或移走下面的文件后重新启动 D Code：\n\n\(sessionArchiveStore.fileURL.path)\n\n\(DiagnosticSanitizer.redact(error.localizedDescription))"
            )
            return false
        }
        do {
            pinnedSessions = try await sessionPinStore.load()
            sessionPinStoreWritable = true
        } catch {
            pinnedSessions = []
            sessionPinStoreWritable = false
            showNotice(
                "会话置顶资料未能安全载入；普通会话仍可使用，但本次不会覆盖原置顶文件。",
                level: "warning"
            )
        }
        do {
            draftDocument = try await sessionDraftStore.load()
            newSessionDraft = draftDocument.newSessionDraft
            isNewSessionDraftActive = false
            sessionDraftStoreWritable = true
            draftStoreIssue = nil
        } catch {
            draftDocument = SessionDraftDocument()
            sessionDraftStoreWritable = false
            draftStoreIssue = "草稿资料未能安全载入；原文件已保留，本次不会覆盖：\(sessionDraftStore.fileURL.path)"
            showNotice(draftStoreIssue ?? "草稿资料未能载入。", level: "warning")
        }
        do {
            sessionChangeDocument = try await sessionChangeStore.load()
            sessionChangeStoreWritable = true
        } catch {
            sessionChangeDocument = SessionChangeDocument()
            sessionChangeStoreWritable = false
            showNotice(
                "会话变更账本未能安全载入；普通会话仍可使用，但本次不会覆盖原账本文件。",
                level: "warning"
            )
        }
        do {
            let document = try await activityAttentionStore.load()
            activityAttentionRecords = document.records
            activityAttentionStoreWritable = true
            activityAttentionIssue = nil
        } catch {
            activityAttentionRecords = []
            activityAttentionStoreWritable = false
            activityAttentionIssue = "活动关注记录未能安全载入；原文件已保留，本次不会覆盖：\(activityAttentionStore.fileURL.path)"
            showNotice(activityAttentionIssue ?? "活动关注记录未能载入。", level: "warning")
        }
        _ = await reloadFollowUpQueues(announceSuccess: false)
        return true
    }

    func shutdown() async {
        if let shutdownTask {
            await shutdownTask.value
            return
        }
        let task = Task<Void, Never> { @MainActor [weak self] in
            guard let self else { return }
            await self.performShutdown()
        }
        shutdownTask = task
        await task.value
        shutdownTask = nil
    }

    private func performShutdown() async {
        isShuttingDown = true
        await followUpSettlementTask?.value
        await pauseFollowUpQueuesForShutdown()
        await flushCurrentDraft()
        refreshTask?.cancel()
        searchTask?.cancel()
        searchProbeTask?.cancel()
        searchProbeTask = nil
        noticeTask?.cancel()
        draftSaveTask?.cancel()
        sessionChangeSaveTask?.cancel()
        activityAttentionSaveTask?.cancel()
        await flushSessionChanges()
        await flushActivityAttention()
        resetExtensionUIState()
        await client?.shutdown()
        await flushCurrentDraft()
        await flushSessionChanges()
        await flushActivityAttention()
        client = nil
        connectionState = .idle
    }

    func emergencyStop() {
        client?.lifecycle.terminate(expected: true)
    }

    @discardableResult
    private func openSession(
        _ id: String,
        writable: Bool,
        expectedEntryID: String? = nil,
        expectedEntryDigest: String? = nil,
        preserveActive: Bool = false,
        presentFailure: Bool = true,
        pathID: String? = nil,
        draftTargetAfterOpen: SessionDraftTarget? = nil,
        useOpenedPathDraftTarget: Bool = false
    ) async -> Bool {
        guard let client = readyClient, !isMutatingArchive else { return false }
        refreshTask?.cancel()
        let commitGeneration = UUID()
        snapshotCommitGeneration = commitGeneration
        let storedDraftTarget = draftTargetAfterOpen
            ?? (currentDraftTarget?.sessionID == id ? currentDraftTarget : nil)
            ?? draftDocument.activeTargets[id]
        let effectivePathID = useOpenedPathDraftTarget ? pathID : (pathID ?? storedDraftTarget?.openingPathID)
        let generation = UUID()
        openGeneration = generation
        isOpeningSession = true
        defer { if openGeneration == generation { isOpeningSession = false } }
        let requestPlan = SessionOpenRequestPlan(
            sessionID: id,
            writable: writable,
            expectedEntryID: expectedEntryID,
            expectedEntryDigest: expectedEntryDigest,
            preserveActive: preserveActive,
            pathID: effectivePathID
        )
        do {
            let result: SessionOpenResult = try await client.request(
                "session.open",
                params: requestPlan.parameters
            )
            guard openGeneration == generation else { return false }
            let preferredTarget = useOpenedPathDraftTarget
                ? SessionDraftTarget.path(
                    sessionID: result.snapshot.summary.id,
                    pathID: result.snapshot.selectedPathId
                )
                : storedDraftTarget
            guard await apply(
                result,
                preferredDraftTarget: preferredTarget,
                openGeneration: generation,
                commitGeneration: commitGeneration
            ) else { return false }
            await loadRuntimeControls(
                includeCommands: result.mode == "writable" && result.state?.writable == true
            )
            return true
        } catch {
            if presentFailure {
                present(error, title: writable ? "暂时无法写入当前会话" : "无法打开会话")
            } else {
                recordSearchOpenFailure(error.localizedDescription)
            }
            if writable {
                _ = await openSession(id, writable: false)
            } else {
                await refreshSnapshot()
                if hostState?.writable != true { availableCommands = [] }
            }
            return false
        }
    }

    func recordSearchOpenFailure(_ message: String) {
        searchOpenError = DiagnosticSanitizer.redact(message)
    }

    private func ensureWritable() async -> Bool {
        if canWrite { return true }
        guard let selectedSessionID, !isMutatingArchive, !isOpeningSession, !isStreaming else { return false }
        return await openSession(selectedSessionID, writable: true)
    }

    private func apply(
        _ result: SessionOpenResult,
        preferredDraftTarget: SessionDraftTarget? = nil,
        openGeneration generation: UUID,
        commitGeneration: UUID
    ) async -> Bool {
        let previousDraftTarget = currentDraftTarget
        let entries = result.snapshot.entries
        let parsedTranscript = await Task.detached(priority: .userInitiated) {
            TranscriptParser.parse(entries: entries)
        }.value
        guard openGeneration == generation,
              snapshotCommitGeneration == commitGeneration else { return false }
        let opensDifferentSession = selectedSessionID != result.snapshot.summary.id
        conversationTarget = nil
        workbenchDestination = .workspace
        if opensDifferentSession { workspaceTabSelection = .conversation }
        selectedSessionID = result.snapshot.summary.id
        updateSelectedSessionChangeSummary()
        inspectorScope = .session(result.snapshot.summary.id)
        inspection = result.snapshot
        hostState = result.state
        activePlan = ActivePlanParser.parse(result.state?.activePlan ?? result.snapshot.activePlan)
        isStreaming = result.state?.isStreaming ?? false
        currentRunState = result.state?.runState
        currentSessionRunID = result.state?.runState?.phase.isActive == true
            ? result.state?.runState?.runID
            : nil
        if let runState = result.state?.runState { recordCompletedRun(runState) }
        clearStreamingPresentation()
        optimisticUserMessage = nil
        availableModels = []
        availableThinkingLevels = []
        availableCommands = []
        setTranscript(parsedTranscript)
        let sessionID = result.snapshot.summary.id
        let target = preferredDraftTarget
            ?? (previousDraftTarget?.sessionID == sessionID ? previousDraftTarget : nil)
            ?? draftDocument.activeTargets[sessionID]
            ?? .path(sessionID: sessionID, pathID: result.snapshot.selectedPathId)
        activateDraftTarget(target, defaultText: "")
        if let errors = result.extensions?.errors, !errors.isEmpty {
            showNotice("有 \(errors.count) 个扩展未能加载；详情可在 Host 诊断中查看。", level: "warning")
        }
        if result.state == nil { Task { await refreshState() } }
        return true
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
        setTranscript(parsed)
        optimisticUserMessage = nil
        if didEndStreamingAssistantMessage {
            streamingText = ""
            streamingTools.removeAll(where: { !$0.isRunning })
            didEndStreamingAssistantMessage = false
        }
        if !isStreaming { clearStreamingPresentation() }
    }

    private func setTranscript(_ parsed: [TranscriptItem]) {
        transcript = parsed
        let rounds = ConversationRoundProjector.project(parsed)
        conversationRounds = rounds
        conversationNavigationItems = ConversationNavigation.items(from: rounds)
    }

    func markStreamingAssistantMessageEnded() {
        didEndStreamingAssistantMessage = true
    }

    private func clearStreamingPresentation() {
        streamingText = ""
        streamingThinking = ""
        streamingTools = []
        didEndStreamingAssistantMessage = false
        separatesNextThinkingDelta = false
    }

    private func clearActiveSessionPresentation() {
        newSessionModelLoadGeneration = UUID()
        isLoadingNewSessionModels = false
        newSessionModelIssue = nil
        newSessionDefaultModel = nil
        newSessionDefaultThinkingLevel = nil
        snapshotCommitGeneration = UUID()
        conversationTarget = nil
        selectedSessionID = nil
        sessionChangeSummary = nil
        inspection = nil
        setTranscript([])
        hostState = nil
        activePlan = nil
        optimisticUserMessage = nil
        isStreaming = false
        currentSessionRunID = nil
        currentRunState = nil
        clearStreamingPresentation()
        availableModels = []
        availableThinkingLevels = []
        availableCommands = []
        pendingPrompt = nil
        currentDraftTarget = nil
        composerText = ""
        resetExtensionUIState()
        inspectorScope = selectedProjectID.map(InspectorScope.project)
    }

    private static func normalizedThinkingLevel(_ requested: String?, levels: [String]) -> String? {
        guard let requested, !levels.isEmpty else { return nil }
        if levels.contains(requested) { return requested }
        let order = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
        guard let requestedIndex = order.firstIndex(of: requested) else { return levels.first }
        if let higher = order[requestedIndex...].first(where: levels.contains) { return higher }
        return order[..<requestedIndex].reversed().first(where: levels.contains) ?? levels.first
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
        let commitGeneration = snapshotCommitGeneration
        do {
            let snapshot: SessionInspection = try await client.request("session.refresh")
            let entries = snapshot.entries
            let parsed = await Task.detached(priority: .utility) {
                TranscriptParser.parse(entries: entries)
            }.value
            guard !Task.isCancelled,
                  snapshotCommitGeneration == commitGeneration,
                  selectedSessionID == sessionID else { return }
            rebaseActiveDraftIfPathAdvanced(to: snapshot)
            inspection = snapshot
            applyRefreshedTranscript(parsed)
            replaceVisibleSummary(snapshot.summary)
            await refreshState()
        } catch is CancellationError {
            return
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
            if let runState = state.runState {
                applyRunState(runState)
            } else {
                currentRunState = nil
                currentSessionRunID = nil
                isStreaming = state.isStreaming
            }
        } catch {
            // A session can close between an event and this refresh; the next explicit action reports it.
        }
    }

    private func applyRunState(_ state: SessionRunState) {
        guard state.sessionID == selectedSessionID || state.sessionID == hostState?.sessionId else { return }
        currentRunState = state
        currentSessionRunID = state.phase.isActive ? state.runID : nil
        isStreaming = state.phase.isActive
        settlePendingSteer(for: state)
        recordCompletedRun(state)
        scheduleFollowUpSettlement(for: state)
        if let summary = inspection?.summary, summary.id == state.sessionID {
            replaceVisibleSummary(summary)
        }
    }

    private func markCurrentRunUnknown() {
        guard let state = currentRunState, state.phase.isActive else { return }
        let now = Date().ISO8601Format()
        currentRunState = SessionRunState(
            sessionID: state.sessionID,
            runID: state.runID,
            phase: .unknown,
            waitingFor: nil,
            startedAt: state.startedAt,
            updatedAt: now,
            completionID: nil,
            completionEntryID: nil,
            completedAt: now,
            inputPersisted: state.inputPersisted,
            retryable: false
        )
        currentSessionRunID = nil
        isStreaming = false
        if let state = currentRunState { settlePendingSteer(for: state) }
    }

    func handle(_ event: HostEvent) {
        switch event.name {
        case "session.closed":
            resetExtensionUIState()
        case "session.runStateChanged":
            guard let data = event.data,
                  let state = try? data.decoded(SessionRunState.self) else { return }
            applyRunState(state)
        case "session.event":
            handleSessionEvent(event.data)
        case "session.promptCompleted":
            if let sessionID = event.data?["sessionId"]?.stringValue,
               let promptID = event.data?["promptId"]?.stringValue,
               pendingPrompt?.sessionID == sessionID,
               pendingPrompt?.promptID == promptID {
                let outcome = event.data?["outcome"]?.stringValue
                if outcome == "persisted", let entryID = event.data?["entryId"]?.stringValue {
                    if pendingPrompt?.isFollowUpDispatch == true {
                        Task { [weak self] in
                            await self?.confirmFollowUpPromptPersisted(
                                sessionID: sessionID,
                                promptID: promptID,
                                entryID: entryID
                            )
                        }
                    } else {
                        currentSessionRunID = promptID
                        _ = completePersistedPrompt(sessionID: sessionID, promptID: promptID, entryID: entryID)
                    }
                } else if pendingPrompt?.isFollowUpDispatch == true {
                    let queueID = pendingPrompt?.followUpQueueID
                    let itemID = pendingPrompt?.followUpItemID
                    Task { [weak self] in
                        guard let self, let queueID, let itemID else { return }
                        await self.markFollowUpDispatchUnknown(
                            queueID: queueID,
                            itemID: itemID,
                            promptID: promptID
                        )
                        if self.pendingPrompt?.promptID == promptID { self.pendingPrompt = nil }
                        self.showNotice("Host 未返回后续消息的持久化条目；队列已暂停等待核对。", level: "warning")
                    }
                } else if pendingPrompt?.draftTarget?.pathAction != nil {
                    restorePendingPrompt(for: sessionID)
                } else {
                    completeHandledPrompt(sessionID: sessionID, promptID: promptID)
                }
            }
        case "session.promptFailed":
            guard let sessionID = event.data?["sessionId"]?.stringValue,
                  let promptID = event.data?["promptId"]?.stringValue else { return }
            let persistedEntryID = event.data?["persistedEntryId"]?.stringValue
            let message = event.data?["message"]?.stringValue
                ?? (persistedEntryID == nil
                    ? "本次输入未能完成。"
                    : "输入已经进入会话，但对应 Agent 运行失败。")
            if pendingPrompt?.sessionID != sessionID || pendingPrompt?.promptID != promptID {
                guard followUpQueues.contains(where: {
                    $0.sessionID == sessionID && $0.activeRunID == promptID
                }) else { return }
                Task { [weak self] in
                    await self?.failActiveFollowUpRun(
                        sessionID: sessionID,
                        promptID: promptID,
                        persistedEntryID: persistedEntryID,
                        message: message
                    )
                }
                return
            }
            if pendingPrompt?.isFollowUpDispatch == true {
                Task { [weak self] in
                    await self?.failFollowUpPrompt(
                        sessionID: sessionID,
                        promptID: promptID,
                        persistedEntryID: persistedEntryID,
                        message: message
                    )
                }
                return
            }
            if let entryID = event.data?["persistedEntryId"]?.stringValue,
               completePersistedPrompt(sessionID: sessionID, promptID: promptID, entryID: entryID) {
                showNotice("输入已经保存到新路径，但后续 Agent 运行失败。", level: "error")
                return
            }
            restorePendingPrompt(for: sessionID)
            showNotice(event.data?["message"]?.stringValue ?? "本次输入未能完成，草稿仍保留。", level: "error")
        case "session.changeRecorded":
            recordSessionChange(event.data)
        case "session.conflict":
            guard let sessionID = event.data?["sessionId"]?.stringValue else { return }
            cancelFollowUpSettlementGate()
            if pendingPrompt?.sessionID == sessionID, pendingPrompt?.isFollowUpDispatch != true {
                restorePendingPrompt(for: sessionID)
            }
            guard sessionID == selectedSessionID else { return }
            isStreaming = false
            markCurrentRunUnknown()
            showNotice("检测到 Pi 的新写入，D Code 已停止本次写入并切回持续同步；草稿已保留。", level: "warning")
            Task { [weak self] in
                guard let self else { return }
                await self.pauseFollowUpQueues(sessionID: sessionID, reason: .conflict)
                if self.pendingPrompt?.sessionID == sessionID,
                   self.pendingPrompt?.isFollowUpDispatch == true {
                    self.pendingPrompt = nil
                }
                await self.resumeObservationAfterConflict(sessionID)
            }
        case "session.changed":
            guard event.data?["sessionId"]?.stringValue == selectedSessionID else { return }
            scheduleRefresh()
        case "session.searchIndexChanged":
            if let value = event.data,
               let next = try? value.decoded(SessionSearchIndexStatus.self) {
                applySearchIndexStatus(next)
            }
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
        case "modelAuth.request":
            guard let prompt = ModelAuthPrompt(data: event.data),
                  modelAuthFlow?.id == prompt.flowID else { return }
            modelAuthFlow?.prompt = prompt
            modelAuthFlow?.error = nil
        case "modelAuth.promptClosed":
            if let flowID = event.data?["flowId"]?.stringValue,
               let requestID = event.data?["requestId"]?.stringValue,
               modelAuthFlow?.id == flowID,
               modelAuthFlow?.prompt?.id == requestID {
                modelAuthFlow?.prompt = nil
            }
        case "modelAuth.event":
            guard let flowID = event.data?["flowId"]?.stringValue,
                  modelAuthFlow?.id == flowID,
                  let presentation = ModelAuthEventPresentation(data: event.data) else { return }
            modelAuthFlow?.events.append(presentation)
            if let count = modelAuthFlow?.events.count, count > 12 {
                modelAuthFlow?.events.removeFirst(count - 12)
            }
            modelAuthFlow?.error = nil
        case "modelAuth.completed":
            if event.data?["flowId"]?.stringValue == modelAuthFlow?.id {
                modelAuthFlow?.prompt = nil
                if let presentation = ModelAuthEventPresentation(data: .object([
                    "event": .object([
                        "type": .string("progress"),
                        "message": .string("认证完成，正在刷新模型目录…"),
                    ]),
                ])) {
                    modelAuthFlow?.events.append(presentation)
                }
            }
        case "host.stderr", "host.outputError", "protocol.decodeError":
            showNotice(event.data?["message"]?.stringValue ?? "Host 诊断事件", level: "error")
        case "host.processEnded":
            resetExtensionUIState()
            cancelFollowUpSettlementGate()
            markCurrentRunUnknown()
            searchProbeTask?.cancel()
            searchProbeTask = nil
            let interruptedSessionID = selectedSessionID
            Task { [weak self] in
                await self?.pauseFollowUpQueues(
                    sessionID: interruptedSessionID,
                    reason: .hostInterrupted
                )
                if self?.pendingPrompt?.isFollowUpDispatch == true {
                    self?.pendingPrompt = nil
                }
            }
            let expected = event.data?["expected"]?.boolValue ?? false
            connectionState = expected ? .idle : .failed
            if !expected {
                issue = AppIssue(title: "Pi Host 已停止", message: "会话连接已中断。重新打开应用即可尝试恢复。")
            }
        case "host.restartRequired":
            cancelFollowUpSettlementGate()
            markCurrentRunUnknown()
            showNotice("会话运行时未能安全停止。D Code 已保留观察能力，但再次发送前需要重新打开应用。", level: "error")
            Task { [weak self] in
                await self?.pauseFollowUpQueues(
                    sessionID: self?.selectedSessionID,
                    reason: .hostInterrupted
                )
            }
        default:
            break
        }
    }

    private func handleSessionEvent(_ data: JSONValue?) {
        guard let type = data?["type"]?.stringValue else { return }
        switch type {
        case "agent_start":
            if let runID = data?["runId"]?.stringValue { currentSessionRunID = runID }
            isStreaming = true
            clearStreamingPresentation()
        case "message_start":
            if data?["message"]?["role"]?.stringValue == "assistant" {
                streamingText = ""
                separatesNextThinkingDelta = !streamingThinking.isEmpty
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
                let delta = update?["delta"]?.stringValue ?? ""
                var addition = delta
                if !delta.isEmpty, separatesNextThinkingDelta {
                    addition = "\n\n" + delta
                    separatesNextThinkingDelta = false
                }
                appendStreamingThinking(addition)
            case "error":
                showNotice(update?["error"]?.stringValue ?? "模型流式响应失败。", level: "error")
            default:
                break
            }
        case "tool_execution_start":
            streamingText = ""
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
        case "agent_end":
            let runID = data?["runId"]?.stringValue ?? currentSessionRunID
            let sessionID = data?["sessionId"]?.stringValue ?? selectedSessionID
            if data?["willRetry"]?.boolValue != true,
               isTrackedFollowUpRun(sessionID: sessionID, runID: runID) {
                isSettlingFollowUpRun = true
            }
            if data?["willRetry"]?.boolValue != true {
                isStreaming = false
            }
            scheduleRefresh()
        case "agent_settled":
            let runID = data?["runId"]?.stringValue ?? currentSessionRunID
            let sessionID = data?["sessionId"]?.stringValue ?? selectedSessionID
            isStreaming = false
            scheduleRefresh()
            let tracked = isTrackedFollowUpRun(sessionID: sessionID, runID: runID)
            guard tracked else {
                isSettlingFollowUpRun = false
                return
            }
            isSettlingFollowUpRun = true
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

    private func appendStreamingThinking(_ delta: String) {
        guard !delta.isEmpty else { return }
        let combined = streamingThinking + delta
        guard combined.utf16.count > Self.maximumStreamingThinkingUTF16Count else {
            streamingThinking = combined
            return
        }
        let prefix = Self.truncatedStreamingThinkingPrefix
        let available = max(0, Self.maximumStreamingThinkingUTF16Count - prefix.utf16.count)
        streamingThinking = prefix + String(decoding: combined.utf16.suffix(available), as: UTF16.self)
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
        let deferred = deferredComposerText
        deferredComposerText = nil
        guard selectedSessionID == sessionID else {
            if let target = pendingPrompt.draftTarget {
                let restored = combineDraft(pendingPrompt.draft, with: deferred)
                draftDocument.activeTargets[sessionID] = target
                setDraftText(restored, for: target)
                scheduleDraftSave()
            }
            self.pendingPrompt = nil
            return
        }
        let restored: String
        let nextDraft = deferred ?? composerText
        restored = combineDraft(pendingPrompt.draft, with: nextDraft)
        updateComposerText(restored)
        self.pendingPrompt = nil
        optimisticUserMessage = nil
    }

    @discardableResult
    private func completePersistedPrompt(sessionID: String, promptID: String, entryID: String) -> Bool {
        guard pendingPrompt?.sessionID == sessionID,
              pendingPrompt?.promptID == promptID else { return false }
        let nextDraft = deferredComposerText ?? (selectedSessionID == sessionID ? composerText : "")
        deferredComposerText = nil
        if let target = pendingPrompt?.draftTarget {
            draftDocument.records.removeAll(where: { $0.target.stableID == target.stableID })
        }
        var nextTarget = SessionDraftTarget.path(
            sessionID: sessionID,
            pathID: "leaf:\(entryID)"
        )
        if selectedSessionID == sessionID,
           let snapshot = inspection,
           snapshot.summary.id == sessionID,
           let rebased = nextTarget.rebasedPathTarget(
               sessionID: sessionID,
               nextPathID: snapshot.selectedPathId,
               visibleEntryIDs: Set(snapshot.entries.compactMap { $0["id"]?.stringValue })
           ) {
            nextTarget = rebased
        }
        draftDocument.activeTargets[sessionID] = nextTarget
        setDraftText(nextDraft, for: nextTarget)
        if selectedSessionID == sessionID {
            self.currentDraftTarget = nextTarget
            composerText = nextDraft
            optimisticUserMessage = nil
        }
        scheduleDraftSave()
        pendingPrompt = nil
        return true
    }

    private func completeHandledPrompt(sessionID: String, promptID: String) {
        guard pendingPrompt?.sessionID == sessionID,
              pendingPrompt?.promptID == promptID else { return }
        let nextDraft = deferredComposerText ?? (selectedSessionID == sessionID ? composerText : "")
        deferredComposerText = nil
        if let target = pendingPrompt?.draftTarget {
            draftDocument.records.removeAll(where: { $0.target.stableID == target.stableID })
            setDraftText(nextDraft, for: target)
            scheduleDraftSave()
        }
        pendingPrompt = nil
        if selectedSessionID == sessionID {
            composerText = nextDraft
            optimisticUserMessage = nil
        }
    }

    private func projectIDs(for session: SessionSummary) -> Set<UUID> {
        let canonicalCwd = URL(fileURLWithPath: session.cwd, isDirectory: true)
            .standardizedFileURL
            .resolvingSymlinksInPath()
            .path
        return Set(projects.compactMap { project in
            project.sourceFolders.contains(where: { folder in
                folder.url.standardizedFileURL.resolvingSymlinksInPath().path == canonicalCwd
            }) ? project.id : nil
        })
    }

    private func orderPinnedSessionPresentations(using records: [PinnedSessionRecord]) {
        let pinnedAt = Dictionary(uniqueKeysWithValues: records.map { ($0.sessionID, $0.pinnedAt) })
        pinnedSessionPresentations.sort { left, right in
            let leftPinnedAt = pinnedAt[left.id] ?? ""
            let rightPinnedAt = pinnedAt[right.id] ?? ""
            if leftPinnedAt != rightPinnedAt { return leftPinnedAt > rightPinnedAt }
            return left.id < right.id
        }
    }

    private func replaceVisibleSummary(_ summary: SessionSummary) {
        if let index = pinnedSessionPresentations.firstIndex(where: { $0.id == summary.id }) {
            let existing = pinnedSessionPresentations[index]
            pinnedSessionPresentations[index] = PinnedSessionPresentation(
                summary: summary,
                isRecent: existing.isRecent,
                projectIDs: existing.projectIDs
            )
        }
        if let index = recentSessions.firstIndex(where: { $0.id == summary.id }) {
            recentSessions[index] = summary
            recentSessions = SessionPinOrdering.ordered(recentSessions, pinnedRecords: [])
        }
        for projectID in Array(projectSessions.keys) {
            guard let index = projectSessions[projectID]?.firstIndex(where: { $0.id == summary.id }) else { continue }
            projectSessions[projectID]?[index] = summary
            projectSessions[projectID] = SessionPinOrdering.ordered(
                projectSessions[projectID, default: []],
                pinnedRecords: []
            )
        }
        if let index = activitySessions.firstIndex(where: { $0.id == summary.id }) {
            activitySessions[index] = summary
        }
    }

    private func upsertCreatedSession(_ summary: SessionSummary) {
        if sidebarProjection == .activity {
            activitySessions.removeAll(where: { $0.id == summary.id })
            activitySessions.append(summary)
        }
        if let index = pinnedSessionPresentations.firstIndex(where: { $0.id == summary.id }) {
            let existing = pinnedSessionPresentations[index]
            pinnedSessionPresentations[index] = PinnedSessionPresentation(
                summary: summary,
                isRecent: true,
                projectIDs: existing.projectIDs.union(projectIDs(for: summary))
            )
            return
        }
        recentSessions.removeAll(where: { $0.id == summary.id })
        recentSessions.append(summary)
        recentSessions = SessionPinOrdering.ordered(recentSessions, pinnedRecords: [])
        for project in projects where project.sourceFolders.contains(where: { $0.path == summary.cwd }) {
            var sessions = projectSessions[project.id] ?? []
            sessions.removeAll(where: { $0.id == summary.id })
            sessions.append(summary)
            projectSessions[project.id] = SessionPinOrdering.ordered(
                sessions,
                pinnedRecords: []
            )
        }
    }

    private func rebaseActiveDraftIfPathAdvanced(to snapshot: SessionInspection) {
        guard pendingPrompt == nil,
              let previousPathID = inspection?.selectedPathId,
              previousPathID != snapshot.selectedPathId,
              let currentDraftTarget,
              let nextTarget = currentDraftTarget.rebasedPathTarget(
                  sessionID: snapshot.summary.id,
                  nextPathID: snapshot.selectedPathId,
                  visibleEntryIDs: Set(snapshot.entries.compactMap { $0["id"]?.stringValue })
              ) else { return }
        let sessionID = snapshot.summary.id
        draftDocument.records.removeAll(where: { $0.target.stableID == currentDraftTarget.stableID })
        self.currentDraftTarget = nextTarget
        draftDocument.activeTargets[sessionID] = nextTarget
        setDraftText(composerText, for: nextTarget)
        scheduleDraftSave()
    }

    private func applyEditorText(_ data: JSONValue?) {
        guard let text = data?["text"]?.stringValue else { return }
        if isPromptTransactionActive {
            if data?["mode"]?.stringValue == "paste" {
                deferredComposerText = (deferredComposerText ?? "") + text
            } else {
                deferredComposerText = text
            }
            return
        }
        if data?["mode"]?.stringValue == "paste" { updateComposerText(composerText + text) }
        else { updateComposerText(text) }
    }

    private func combineDraft(_ original: String, with next: String?) -> String {
        guard let next, !next.isEmpty, next != original else { return original }
        guard !original.isEmpty else { return next }
        return "\(original)\n\n\(next)"
    }

    private func applyDeferredComposerText() {
        guard let deferredComposerText else { return }
        self.deferredComposerText = nil
        updateComposerText(combineDraft(composerText, with: deferredComposerText))
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
