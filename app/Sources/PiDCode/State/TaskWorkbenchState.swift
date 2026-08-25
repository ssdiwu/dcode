import Foundation
import Observation

@Observable
final class TaskWorkbenchState {
    private(set) var selectedTaskID: String?
    private(set) var selectedSessionID: String?
    private(set) var expandedHUDSections: Set<String>
    private(set) var inspectorTarget: TaskWorkbenchInspectorTarget?
    private(set) var viewStateRevision = 0

    init() {
        expandedHUDSections = ["progress", "team", "waiting", "deliverables"]
    }

    func apply(remote: FoundationTaskWorkbenchViewState) {
        guard remote.version == 1, remote.revision >= viewStateRevision else { return }
        selectedTaskID = remote.selection.taskId
        selectedSessionID = remote.selection.sessionId
        expandedHUDSections = Set(remote.expandedHudSections)
        inspectorTarget = TaskWorkbenchInspectorTarget(remoteValue: remote.inspectorTarget)
        viewStateRevision = remote.revision
    }

    func reconcile(with snapshot: FoundationSnapshot) -> [String: JSONValue]? {
        let originalTaskID = selectedTaskID
        let originalSessionID = selectedSessionID
        let originalInspectorTarget = inspectorTarget
        let taskIDs = Set(snapshot.tasks.map(\.id))
        if selectedTaskID == nil || !taskIDs.contains(selectedTaskID ?? "") {
            let next = snapshot.tasks.first(where: { $0.state == "active" || $0.state == "waiting" })?.id
                ?? snapshot.tasks.first?.id
            selectTaskID(next, snapshot: snapshot)
        }
        guard let selectedTaskID else {
            selectedSessionID = nil
            inspectorTarget = nil
            return reconciliationPatch(
                originalTaskID: originalTaskID,
                originalSessionID: originalSessionID,
                originalInspectorTarget: originalInspectorTarget
            )
        }
        let taskSessions = TaskWorkbenchProjection.sessions(for: selectedTaskID, snapshot: snapshot)
        if selectedSessionID == nil || !taskSessions.contains(where: { $0.id == selectedSessionID }) {
            selectedSessionID = taskSessions.first(where: { $0.kind == "coordination" })?.id ?? taskSessions.first?.id
        }
        if let inspectorTarget, !contains(inspectorTarget, snapshot: snapshot, taskID: selectedTaskID) {
            self.inspectorTarget = nil
        }
        return reconciliationPatch(
            originalTaskID: originalTaskID,
            originalSessionID: originalSessionID,
            originalInspectorTarget: originalInspectorTarget
        )
    }

    func select(task: FoundationTask, sessionID: String? = nil, snapshot: FoundationSnapshot) -> [String: JSONValue] {
        let changedTask = selectedTaskID != task.id
        selectedTaskID = task.id
        selectedSessionID = sessionID ?? TaskWorkbenchProjection.defaultSessionID(for: task, snapshot: snapshot)
        if changedTask { inspectorTarget = nil }
        var patch = selectionPatch
        if changedTask { patch["inspectorTarget"] = .null }
        return patch
    }

    func selectSession(_ sessionID: String) -> [String: JSONValue] {
        selectedSessionID = sessionID
        return selectionPatch
    }

    func toggleHUDSection(_ section: String) -> [String: JSONValue] {
        if expandedHUDSections.contains(section) {
            expandedHUDSections.remove(section)
        } else {
            expandedHUDSections.insert(section)
        }
        return ["expandedHudSections": .array(expandedHUDSections.sorted().map(JSONValue.string))]
    }

    func openInspector(_ target: TaskWorkbenchInspectorTarget) -> [String: JSONValue] {
        inspectorTarget = target
        return ["inspectorTarget": inspectorTargetValue]
    }

    func closeInspector() -> [String: JSONValue] {
        inspectorTarget = nil
        return ["inspectorTarget": .null]
    }

    func applyMutation(_ mutation: FoundationTaskWorkbenchViewStateMutation) {
        apply(remote: mutation.taskWorkbenchViewState)
    }

    private var selectionPatch: [String: JSONValue] {
        [
            "selection": .object([
                "taskId": selectedTaskID.map(JSONValue.string) ?? .null,
                "sessionId": selectedSessionID.map(JSONValue.string) ?? .null,
            ]),
        ]
    }

    private var inspectorTargetValue: JSONValue {
        guard let inspectorTarget else { return .null }
        return .object([
            "kind": .string(inspectorTarget.remoteValue.kind),
            "id": .string(inspectorTarget.remoteValue.id),
        ])
    }

    private func reconciliationPatch(
        originalTaskID: String?,
        originalSessionID: String?,
        originalInspectorTarget: TaskWorkbenchInspectorTarget?
    ) -> [String: JSONValue]? {
        var patch: [String: JSONValue] = [:]
        if originalTaskID != selectedTaskID || originalSessionID != selectedSessionID {
            patch.merge(selectionPatch) { _, next in next }
        }
        if originalInspectorTarget != inspectorTarget {
            patch["inspectorTarget"] = inspectorTargetValue
        }
        return patch.isEmpty ? nil : patch
    }

    private func selectTaskID(_ taskID: String?, snapshot: FoundationSnapshot) {
        selectedTaskID = taskID
        guard let taskID else {
            selectedSessionID = nil
            inspectorTarget = nil
            return
        }
        let sessions = TaskWorkbenchProjection.sessions(for: taskID, snapshot: snapshot)
        selectedSessionID = sessions.first(where: { $0.kind == "coordination" })?.id ?? sessions.first?.id
    }

    private func contains(_ target: TaskWorkbenchInspectorTarget, snapshot: FoundationSnapshot, taskID: String) -> Bool {
        switch target {
        case let .artifact(id): snapshot.artifacts.contains { $0.id == id && $0.taskId == taskID }
        case let .evidence(id): snapshot.evidence.contains { $0.id == id && $0.taskId == taskID }
        case let .report(id): snapshot.agentReports.contains { $0.id == id && $0.taskId == taskID }
        case let .context(id): snapshot.taskContextSets
            .first(where: { $0.taskId == taskID })?
            .sources.contains(where: { $0.id == id }) == true
        }
    }
}
