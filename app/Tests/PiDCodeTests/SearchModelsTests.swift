import XCTest
@testable import PiDCode

@MainActor
final class SearchModelsTests: XCTestCase {
    func testSearchResponseDecodesIndexStateAndStableMessageTarget() throws {
        let json = #"""
        {
          "requestToken":"generation-1",
          "index":{"state":"ready","complete":true,"revision":3},
          "results":[{
            "sessionId":"session-1",
            "entryId":"message-7",
            "entryDigest":"v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "matchKind":"message",
            "role":"assistant",
            "title":"搜索设计",
            "cwd":"/work/dcode",
            "modified":"2026-08-11T08:00:00.000Z",
            "snippet":"项目搜索应该立即出现结果",
            "matchCount":2
          }]
        }
        """#
        let response = try JSONDecoder().decode(SessionSearchResponse.self, from: Data(json.utf8))
        XCTAssertEqual(response.requestToken, "generation-1")
        XCTAssertEqual(response.index.state, .ready)
        XCTAssertEqual(response.index.revision, 3)
        XCTAssertEqual(response.results.first?.sessionId, "session-1")
        XCTAssertEqual(response.results.first?.entryId, "message-7")
        XCTAssertEqual(
            response.results.first?.entryDigest,
            "v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        )
        XCTAssertEqual(response.results.first?.role, "assistant")
        XCTAssertEqual(response.results.first?.matchCount, 2)
    }

    func testSearchOwnershipUsesExactRegisteredSourceFolder() {
        let model = AppModel()
        model.projects = [DCodeProject(
            name: "D Code",
            sourceFolders: [SourceFolder(path: "/work/dcode")]
        )]
        let result = SessionSearchResult(
            sessionId: "session-1",
            entryId: nil,
            matchKind: "title",
            role: nil,
            title: "标题",
            cwd: "/work/dcode",
            modified: "2026-08-11T08:00:00.000Z",
            snippet: "标题",
            matchCount: 1
        )
        XCTAssertEqual(
            model.ownership(for: result),
            SearchResultOwnership(projectName: "D Code", sourceFolderName: "dcode")
        )
    }

    func testSearchSelectionNeverLeavesTheAvailableResultRange() {
        let model = AppModel()
        model.searchResults = (0..<2).map { index in
            SessionSearchResult(
                sessionId: "session-\(index)",
                entryId: nil,
                matchKind: "title",
                role: nil,
                title: "标题 \(index)",
                cwd: "/work/\(index)",
                modified: "2026-08-11T08:00:00.000Z",
                snippet: "标题 \(index)",
                matchCount: 1
            )
        }
        model.moveSearchSelection(by: 4)
        XCTAssertEqual(model.searchSelection, 1)
        model.moveSearchSelection(by: -4)
        XCTAssertEqual(model.searchSelection, 0)
    }

    func testSearchResultAccessibilityDescriptionUsesVisibleValues() {
        let result = SessionSearchResult(
            sessionId: "session-1",
            entryId: "message-7",
            matchKind: "message",
            role: "assistant",
            title: "搜索设计",
            cwd: "/work/dcode",
            modified: "2026-08-11T08:00:00.000Z",
            snippet: "项目搜索应该立即出现结果",
            matchCount: 2
        )
        XCTAssertEqual(
            result.accessibilityDescription(ownership: SearchResultOwnership(
                projectName: "D Code",
                sourceFolderName: "dcode"
            )),
            "搜索设计，项目搜索应该立即出现结果，助手回复，共 2 处命中，项目 D Code，源文件夹 dcode，工作目录 /work/dcode"
        )

        let recent = SessionSearchResult(
            sessionId: "session-2",
            entryId: nil,
            matchKind: "title",
            role: nil,
            title: "未归类会话",
            cwd: "/work/notes",
            modified: "2026-08-11T08:00:00.000Z",
            snippet: "未归类会话",
            matchCount: 1
        )
        XCTAssertEqual(
            recent.accessibilityDescription(ownership: SearchResultOwnership(
                projectName: nil,
                sourceFolderName: nil
            )),
            "未归类会话，会话标题，未加入项目，工作目录 /work/notes"
        )
    }

    func testChangingSearchInputOrScopeRemovesStaleResultsImmediately() {
        let model = AppModel()
        let result = SessionSearchResult(
            sessionId: "stale-session",
            entryId: nil,
            matchKind: "title",
            role: nil,
            title: "旧结果",
            cwd: "/work/old",
            modified: "2026-08-11T08:00:00.000Z",
            snippet: "旧结果",
            matchCount: 1
        )
        model.searchPresented = true
        model.searchResults = [result]
        model.updateSearchQuery("新查询")
        XCTAssertTrue(model.searchResults.isEmpty)

        model.searchResults = [result]
        model.selectSearchProject(UUID())
        XCTAssertTrue(model.searchResults.isEmpty)

        model.searchResults = [result]
        model.selectSearchSourceFolder("/work/new")
        XCTAssertTrue(model.searchResults.isEmpty)
    }

    func testProjectChangesReconcilePersistedSearchScope() {
        let projectA = DCodeProject(
            name: "A",
            sourceFolders: [SourceFolder(path: "/work/shared")]
        )
        let projectB = DCodeProject(name: "B", sourceFolders: [])
        let model = AppModel()
        model.projects = [projectA, projectB]
        model.searchProjectID = projectA.id
        model.searchSourceFolderPath = "/work/shared"

        model.projects = [
            DCodeProject(id: projectA.id, name: "A", sourceFolders: []),
            DCodeProject(
                id: projectB.id,
                name: "B",
                sourceFolders: [SourceFolder(path: "/work/shared")]
            ),
        ]
        model.reconcileSearchScope()
        XCTAssertEqual(model.searchProjectID, projectA.id)
        XCTAssertNil(model.searchSourceFolderPath)

        model.projects.removeAll(where: { $0.id == projectA.id })
        model.reconcileSearchScope()
        XCTAssertNil(model.searchProjectID)
        XCTAssertNil(model.searchSourceFolderPath)
    }

    func testOpeningSearchResultFreezesSearchIntentUntilTheTransactionSettles() {
        let projectID = UUID()
        let model = AppModel()
        model.searchPresented = true
        model.searchQuery = "当前查询"
        model.searchProjectID = projectID
        model.searchSourceFolderPath = "/work/current"
        model.isOpeningSession = true

        model.updateSearchQuery("新查询")
        model.selectSearchProject(nil)
        model.selectSearchSourceFolder(nil)
        model.dismissSearch()

        XCTAssertEqual(model.searchQuery, "当前查询")
        XCTAssertEqual(model.searchProjectID, projectID)
        XCTAssertEqual(model.searchSourceFolderPath, "/work/current")
        XCTAssertTrue(model.searchPresented)
    }

    func testSearchRequestPlanIncludesVisibleUnionAndCombinedScopeBeforeLimit() {
        let generation = UUID()
        let plan = SessionSearchRequestPlan(
            generation: generation,
            query: "项目搜索",
            projectSourceFolders: ["/work/a", "/work/b"],
            filterSourceFolders: ["/work/b"],
            excludedSessionIDs: ["archived-session"],
            refresh: true
        )

        XCTAssertEqual(plan.parameters, [
            "query": .string("项目搜索"),
            "requestToken": .string(generation.uuidString),
            "limit": .number(50),
            "projectSourceFolders": .array([.string("/work/a"), .string("/work/b")]),
            "filterSourceFolders": .array([.string("/work/b")]),
            "excludedSessionIds": .array([.string("archived-session")]),
            "refresh": .bool(true),
        ])
    }

    func testSearchFreshnessProbeUsesOnlyTheVisibleScopeAndDoesNotRequestResults() {
        let token = UUID()
        let plan = SessionSearchProbePlan(
            token: token,
            projectSourceFolders: ["/work/a", "/work/b"],
            excludedSessionIDs: ["archived-session"]
        )

        XCTAssertEqual(plan.parameters, [
            "query": .string(""),
            "requestToken": .string(token.uuidString),
            "limit": .number(1),
            "projectSourceFolders": .array([.string("/work/a"), .string("/work/b")]),
            "excludedSessionIds": .array([.string("archived-session")]),
            "refresh": .bool(false),
            "probe": .bool(true),
        ])
    }

    func testSearchRequestPlanRejectsOlderOrHiddenResponses() {
        let oldGeneration = UUID()
        let currentGeneration = UUID()
        let plan = SessionSearchRequestPlan(
            generation: oldGeneration,
            query: "旧查询",
            projectSourceFolders: [],
            filterSourceFolders: nil,
            refresh: false
        )
        let response = SessionSearchResponse(
            requestToken: oldGeneration.uuidString,
            index: .idle,
            results: []
        )

        XCTAssertTrue(plan.accepts(
            response,
            searchPresented: true,
            currentGeneration: oldGeneration
        ))
        XCTAssertFalse(plan.accepts(
            response,
            searchPresented: true,
            currentGeneration: currentGeneration
        ))
        XCTAssertFalse(plan.accepts(
            response,
            searchPresented: false,
            currentGeneration: oldGeneration
        ))
        XCTAssertFalse(plan.accepts(
            SessionSearchResponse(
                requestToken: currentGeneration.uuidString,
                index: .idle,
                results: []
            ),
            searchPresented: true,
            currentGeneration: oldGeneration
        ))
    }

    func testSearchOpenRequestPreservesCurrentSessionAndPinsMessageContent() {
        let digest = "v1:" + String(repeating: "a", count: 64)
        let result = SessionSearchResult(
            sessionId: "session-1",
            entryId: "message-7",
            entryDigest: digest,
            matchKind: "message",
            role: "assistant",
            title: "搜索设计",
            cwd: "/work/dcode",
            modified: "2026-08-11T08:00:00.000Z",
            snippet: "项目搜索应该立即出现结果",
            matchCount: 1
        )

        XCTAssertEqual(SessionOpenRequestPlan.searchResult(result).parameters, [
            "sessionId": .string("session-1"),
            "mode": .string("readOnly"),
            "expectedEntryId": .string("message-7"),
            "expectedEntryDigest": .string(digest),
            "preserveActive": .bool(true),
        ])
    }

    func testSearchOpenFailureKeepsResultsAndConversationTargetClearsOnlyForItsToken() {
        let model = AppModel()
        let result = SessionSearchResult(
            sessionId: "session-1",
            entryId: "message-7",
            matchKind: "message",
            role: "assistant",
            title: "搜索设计",
            cwd: "/work/dcode",
            modified: "2026-08-11T08:00:00.000Z",
            snippet: "项目搜索应该立即出现结果",
            matchCount: 1
        )
        let targetToken = UUID()
        model.searchPresented = true
        model.searchQuery = "项目搜索"
        model.searchResults = [result]
        model.searchSelection = 0
        model.conversationTarget = ConversationTarget(
            sessionID: "session-1",
            entryID: "message-7",
            token: targetToken
        )

        model.recordSearchOpenFailure("SEARCH_TARGET_STALE")
        model.clearConversationTarget(UUID())

        XCTAssertTrue(model.searchPresented)
        XCTAssertEqual(model.searchQuery, "项目搜索")
        XCTAssertEqual(model.searchResults, [result])
        XCTAssertEqual(model.searchSelection, 0)
        XCTAssertEqual(model.searchOpenError, "SEARCH_TARGET_STALE")
        XCTAssertEqual(model.conversationTarget?.token, targetToken)

        model.clearConversationTarget(targetToken)
        XCTAssertNil(model.conversationTarget)
    }

    func testFailedIndexStatusStopsQueryingAndCannotTriggerAutomaticResultFetch() {
        let model = AppModel()
        model.searchPresented = true
        model.isSearchQuerying = true
        let failed = SessionSearchIndexStatus(
            state: .failed,
            complete: false,
            progress: nil,
            revision: 7,
            message: "缓存无法读取"
        )

        XCTAssertFalse(failed.canServeResults)
        model.handle(HostEvent(
            name: "session.searchIndexChanged",
            data: .object([
                "state": .string("failed"),
                "complete": .bool(false),
                "revision": .number(7),
                "message": .string("缓存无法读取"),
            ])
        ))

        XCTAssertEqual(model.searchIndexStatus, failed)
        XCTAssertFalse(model.isSearchQuerying)
        XCTAssertEqual(model.searchError, "缓存无法读取")
    }

    func testIncompleteIndexEventImmediatelyRemovesPreviouslyReadyResults() {
        let model = AppModel()
        model.searchPresented = true
        model.searchResults = [SessionSearchResult(
            sessionId: "stale-session",
            entryId: nil,
            matchKind: "title",
            role: nil,
            title: "旧缓存结果",
            cwd: "/work/stale",
            modified: "2026-08-11T08:00:00.000Z",
            snippet: "旧缓存结果",
            matchCount: 1
        )]

        model.handle(HostEvent(
            name: "session.searchIndexChanged",
            data: .object([
                "state": .string("updating"),
                "complete": .bool(false),
                "revision": .number(8),
            ])
        ))

        XCTAssertTrue(model.searchResults.isEmpty)
        XCTAssertTrue(model.isSearchQuerying)
        XCTAssertEqual(model.searchIndexStatus.state, .updating)
    }
}
