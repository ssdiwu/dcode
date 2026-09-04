import XCTest
@testable import PiDCode

@MainActor
final class TaskWorkbenchModelsTests: XCTestCase {
    func testHUDLayoutPolicyUsesTheConfirmedThreeWidthBoundaries() {
        XCTAssertEqual(TaskHUDLayoutPolicy.layout(for: 1_320), .wideFloating)
        XCTAssertEqual(TaskHUDLayoutPolicy.layout(for: 1_319), .mediumOverlay)
        XCTAssertEqual(TaskHUDLayoutPolicy.layout(for: 880), .mediumOverlay)
        XCTAssertEqual(TaskHUDLayoutPolicy.layout(for: 879), .compactEntry)
        XCTAssertEqual(TaskHUDLayoutPolicy.layout(for: 640), .compactEntry)
        XCTAssertEqual(TaskHUDLayoutPolicy.wideCardWidth, 304)
        XCTAssertEqual(TaskHUDLayoutPolicy.wideCardTopInset, 66)
        XCTAssertEqual(TaskHUDLayoutPolicy.wideCardTrailingInset, 24)
        XCTAssertEqual(TaskHUDLayoutPolicy.wideCardBottomInset, 32)
        XCTAssertEqual(TaskHUDLayoutPolicy.wideCardMaximumHeight(for: 900), 620)
        XCTAssertEqual(TaskHUDLayoutPolicy.wideCardMaximumHeight(for: 600), 502)
        XCTAssertGreaterThanOrEqual(
            TaskHUDLayoutPolicy.wideConversationTrailingInset,
            TaskHUDLayoutPolicy.wideCardWidth + TaskHUDLayoutPolicy.wideCardTrailingInset
        )
    }

    func testInspectorTargetRoundTripsOnlyKnownObjectKinds() {
        let targets: [TaskWorkbenchInspectorTarget] = [
            .artifact("artifact-one"),
            .evidence("evidence-one"),
            .report("report-one"),
            .context("context-one"),
        ]
        for target in targets {
            XCTAssertEqual(TaskWorkbenchInspectorTarget.restore(target.persistenceKey), target)
        }
        XCTAssertNil(TaskWorkbenchInspectorTarget.restore("unknown:item"))
        XCTAssertNil(TaskWorkbenchInspectorTarget.restore("artifact:"))
    }

    func testWorkbenchStateAppliesCredentialFreeProductStorePresentationWithoutUserDefaults() {
        let state = TaskWorkbenchState()
        state.apply(remote: FoundationTaskWorkbenchViewState(
            version: 1,
            selection: FoundationTaskWorkbenchSelection(taskId: "task-one", sessionId: "session-coordinator"),
            expandedHudSections: ["progress", "waiting"],
            inspectorTarget: FoundationTaskWorkbenchInspectorTarget(kind: "evidence", id: "evidence-one"),
            workspaceContent: FoundationTaskWorkbenchWorkspaceContent(
                kind: "report",
                id: "report-one",
                sourceRevision: nil,
                anchorLine: 17
            ),
            revision: 3
        ))

        XCTAssertEqual(state.selectedTaskID, "task-one")
        XCTAssertEqual(state.selectedSessionID, "session-coordinator")
        XCTAssertEqual(state.expandedHUDSections, ["progress", "waiting"])
        XCTAssertEqual(state.inspectorTarget, .evidence("evidence-one"))
        XCTAssertEqual(state.contentTarget, .report("report-one"))
        XCTAssertEqual(state.contentAnchorLine, 17)
        XCTAssertEqual(state.viewStateRevision, 3)
        XCTAssertFalse(state.inspectorTarget?.persistenceKey.contains("正文") ?? false)
    }
}
