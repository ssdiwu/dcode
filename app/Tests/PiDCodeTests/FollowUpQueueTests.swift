import Foundation
import XCTest
@testable import PiDCode

final class FollowUpQueueTests: XCTestCase {
    func testStoreRoundTripsOrderedItemsAndKeepsNewestRevision() async throws {
        let root = temporaryDirectory("round-trip")
        defer { try? FileManager.default.removeItem(at: root) }
        let store = FollowUpQueueStore(fileURL: root.appending(path: "queues.json"))
        let newest = FollowUpQueueDocument(queues: [queue(
            id: "queue-a",
            anchor: "user-a",
            items: [item("first", id: "item-a"), item("second", id: "item-b")]
        )])
        let stale = FollowUpQueueDocument()

        try await store.save(newest, revision: 2)
        try await store.save(stale, revision: 1)

        let loaded = try await store.load()
        XCTAssertEqual(loaded, newest)
    }

    func testMalformedOrUnknownDocumentFailsClosedWithoutOverwritingBytes() async throws {
        let root = temporaryDirectory("fail-closed")
        defer { try? FileManager.default.removeItem(at: root) }
        let fileURL = root.appending(path: "queues.json")
        let malformed = Data(#"{"version":2,"queues":[]}"#.utf8)
        try malformed.write(to: fileURL)
        let store = FollowUpQueueStore(fileURL: fileURL)

        do {
            _ = try await store.load()
            XCTFail("Expected unsupported version")
        } catch FollowUpQueueStoreError.invalidDocumentVersion(2) {
            // Expected.
        }
        do {
            try await store.save(FollowUpQueueDocument(), revision: 1)
            XCTFail("Expected writes to remain blocked")
        } catch FollowUpQueueStoreError.unavailableAfterLoadFailure {
            // Expected.
        }
        XCTAssertEqual(try Data(contentsOf: fileURL), malformed)
    }

    @MainActor
    func testAppCanReloadQueueAfterThePreservedStoreIsRepaired() async throws {
        let root = temporaryDirectory("reload-repaired")
        defer { try? FileManager.default.removeItem(at: root) }
        let queueURL = root.appending(path: "queues.json")
        try Data(#"{"version":2,"queues":[]}"#.utf8).write(to: queueURL)
        let model = makeModel(root: root, queueURL: queueURL)

        let metadataLoaded = await model.loadSessionMetadata()
        XCTAssertTrue(metadataLoaded)
        XCTAssertNotNil(model.followUp.queueIssue)

        let repaired = FollowUpQueueDocument(queues: [
            FollowUpQueueRecord(
                id: "queue-repaired",
                sessionID: "session-a",
                pathID: "leaf:assistant-a",
                lineageEntryID: "assistant-a",
                items: [item("恢复后的正文", id: "item-repaired")],
                createdAt: timestamp
            ),
        ])
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(repaired).write(to: queueURL, options: [.atomic])

        let reloaded = await model.reloadFollowUpQueues()
        XCTAssertTrue(reloaded)
        XCTAssertNil(model.followUp.queueIssue)
        XCTAssertEqual(model.followUp.queues.single?.items.single?.text, "恢复后的正文")
        XCTAssertEqual(model.followUp.queues.single?.pauseReason, .manualResume)
    }

    func testValidationRejectsOversizedTextAndMoreThanOneInFlightItem() throws {
        let oversized = String(repeating: "a", count: FollowUpQueueDocument.maximumTextUTF16Count + 1)
        XCTAssertThrowsError(try FollowUpQueueStore.validate(FollowUpQueueDocument(queues: [
            queue(id: "queue-a", anchor: "user-a", items: [item(oversized, id: "item-a")]),
        ]))) { error in
            XCTAssertEqual(error as? FollowUpQueueStoreError, .invalidText(itemID: "item-a"))
        }

        let first = FollowUpQueueItem(
            id: "item-a",
            text: "one",
            createdAt: timestamp,
            state: .dispatching,
            promptID: "prompt-a"
        )
        let second = FollowUpQueueItem(
            id: "item-b",
            text: "two",
            createdAt: timestamp,
            state: .unknown,
            promptID: "prompt-b"
        )
        XCTAssertThrowsError(try FollowUpQueueStore.validate(FollowUpQueueDocument(queues: [
            queue(id: "queue-b", anchor: "user-b", items: [first, second]),
        ]))) { error in
            XCTAssertEqual(error as? FollowUpQueueStoreError, .multipleInFlightItems(queueID: "queue-b"))
        }
    }

    func testMatchingQueueUsesTheDeepestAnchorOnTheSelectedPath() {
        let document = FollowUpQueueDocument(queues: [
            queue(id: "shared", anchor: "user-root", items: [item("root", id: "item-root")]),
            queue(id: "current", anchor: "assistant-current", items: [item("current", id: "item-current")]),
            queue(id: "sibling", anchor: "assistant-sibling", items: [item("sibling", id: "item-sibling")]),
            queue(id: "other-session", sessionID: "session-b", anchor: "assistant-current", items: [item("other", id: "item-other")]),
        ])

        let index = document.matchingQueueIndex(
            sessionID: "session-a",
            currentPathID: "leaf:assistant-current",
            orderedPathEntryIDs: ["user-root", "assistant-current"]
        )
        XCTAssertEqual(index.map { document.queues[$0].id }, "current")

        let sharedAncestorOnSibling = document.matchingQueueIndex(
            sessionID: "session-a",
            currentPathID: "leaf:assistant-sibling",
            orderedPathEntryIDs: ["user-root", "assistant-sibling"]
        )
        XCTAssertEqual(sharedAncestorOnSibling.map { document.queues[$0].id }, "sibling")
    }

    func testDispatchStateRequiresOneStablePromptIDOnTheQueueHead() throws {
        let invalidPending = FollowUpQueueItem(
            id: "item-a",
            text: "one",
            createdAt: timestamp,
            state: .pending,
            promptID: "prompt-a"
        )
        XCTAssertThrowsError(try FollowUpQueueStore.validate(FollowUpQueueDocument(queues: [
            queue(id: "queue-a", anchor: "user-a", items: [invalidPending]),
        ]))) { error in
            XCTAssertEqual(error as? FollowUpQueueStoreError, .invalidDispatchState(itemID: "item-a"))
        }

        let dispatching = FollowUpQueueItem(
            id: "item-b",
            text: "two",
            createdAt: timestamp,
            state: .dispatching,
            promptID: "prompt-b"
        )
        XCTAssertNoThrow(try FollowUpQueueStore.validate(FollowUpQueueDocument(queues: [
            queue(id: "queue-b", anchor: "user-b", items: [dispatching, item("later", id: "item-c")]),
        ])))
    }

    @MainActor
    func testAppModelPersistsExactQueuedTextAndPendingManagementOrder() async throws {
        let root = temporaryDirectory("app-management")
        defer { try? FileManager.default.removeItem(at: root) }
        let queueURL = root.appending(path: "queues.json")
        let model = makeModel(root: root, queueURL: queueURL)
        let metadataLoaded = await model.loadSessionMetadata()
        XCTAssertTrue(metadataLoaded)
        prepareRunningSession(model, runID: "run-a")

        model.updateComposerText("  第一条\n保留空格  ")
        await model.enqueueFollowUpFromComposer()
        model.updateComposerText("第二条")
        await model.enqueueFollowUpFromComposer()
        model.updateComposerText("第三条")
        await model.enqueueFollowUpFromComposer()

        guard let queue = model.currentFollowUpQueue else {
            return XCTFail("Expected a queue on the active path")
        }
        XCTAssertEqual(queue.items.map(\.text), ["  第一条\n保留空格  ", "第二条", "第三条"])
        XCTAssertEqual(queue.activeRunID, "run-a")
        XCTAssertEqual(model.composerText, "")
        XCTAssertTrue(model.transcript.isEmpty)
        XCTAssertNil(model.optimisticUserMessage)

        let firstID = queue.items[0].id
        let secondID = queue.items[1].id
        let thirdID = queue.items[2].id
        await model.editFollowUpItem(queueID: queue.id, itemID: secondID, text: "第二条（已修改）")
        await model.moveFollowUpItem(queueID: queue.id, itemID: thirdID, offset: -1)
        await model.moveFollowUpItem(queueID: queue.id, itemID: thirdID, offset: -1)
        await model.removeFollowUpItem(queueID: queue.id, itemID: firstID)

        let persisted = try await FollowUpQueueStore(fileURL: queueURL).load()
        XCTAssertEqual(persisted.queues.single?.items.map(\.text), ["第三条", "第二条（已修改）"])
        XCTAssertEqual(persisted.queues.single?.items.map(\.id), [thirdID, secondID])

        let empty = sessionSummary(id: "session-a", messageCount: 0)
        model.recentSessions = [empty]
        XCTAssertFalse(model.canTrashSession(empty))
    }

    @MainActor
    func testRejectedOversizedEnqueuePreservesComposerAndDoesNotPoisonTheStore() async throws {
        let root = temporaryDirectory("app-limit")
        defer { try? FileManager.default.removeItem(at: root) }
        let queueURL = root.appending(path: "queues.json")
        let model = makeModel(root: root, queueURL: queueURL)
        let metadataLoaded = await model.loadSessionMetadata()
        XCTAssertTrue(metadataLoaded)
        prepareRunningSession(model, runID: "run-limit")

        let oversized = String(repeating: "字", count: FollowUpQueueDocument.maximumTextUTF16Count + 1)
        model.updateComposerText(oversized)
        await model.enqueueFollowUpFromComposer()
        XCTAssertEqual(model.composerText, oversized)
        XCTAssertTrue(model.followUp.queues.isEmpty)
        XCTAssertNil(model.followUp.queueIssue)

        model.updateComposerText("仍然可以保存")
        await model.enqueueFollowUpFromComposer()
        XCTAssertEqual(model.currentFollowUpQueue?.items.map(\.text), ["仍然可以保存"])
        let reloaded = try await FollowUpQueueStore(fileURL: queueURL).load()
        XCTAssertEqual(reloaded.queues.single?.items.count, 1)
    }

    @MainActor
    func testAcceptedSteerRestoresItsDraftWhenTheRunDoesNotCompleteNormally() async throws {
        let root = temporaryDirectory("steer-restore")
        defer { try? FileManager.default.removeItem(at: root) }
        let model = makeModel(root: root, queueURL: root.appending(path: "queues.json"))
        let metadataLoaded = await model.loadSessionMetadata()
        XCTAssertTrue(metadataLoaded)
        prepareRunningSession(model, runID: "run-steer")
        let target = try XCTUnwrap(model.currentDraftTarget)
        model.followUp.pendingSteer = PendingSteerDraft(
            sessionID: "session-a",
            runID: "run-steer",
            steerID: "steer-a",
            draft: "必须恢复的介入正文",
            draftTarget: target,
            accepted: true
        )
        model.composerText = ""

        model.handle(HostEvent(name: "session.runStateChanged", data: .object([
            "sessionId": .string("session-a"),
            "runId": .string("run-steer"),
            "phase": .string("aborted"),
            "startedAt": .string(timestamp),
            "updatedAt": .string(timestamp),
            "completedAt": .string(timestamp),
            "inputPersisted": .bool(true),
            "retryable": .bool(false),
        ])))

        XCTAssertNil(model.followUp.pendingSteer)
        XCTAssertEqual(model.composerText, "必须恢复的介入正文")
    }

    @MainActor
    func testPendingSteerShutdownKeepsThePersistedDraftInsteadOfSavingTheEmptyComposer() async throws {
        let root = temporaryDirectory("steer-shutdown")
        defer { try? FileManager.default.removeItem(at: root) }
        let draftURL = root.appending(path: "drafts.json")
        let model = AppModel(
            projectStore: ProjectStore(fileURL: root.appending(path: "projects.json")),
            sessionDraftStore: SessionDraftStore(fileURL: draftURL),
            sessionArchiveStore: SessionArchiveStore(fileURL: root.appending(path: "archives.json")),
            sessionPinStore: SessionPinStore(fileURL: root.appending(path: "pins.json")),
            sessionChangeStore: SessionChangeStore(fileURL: root.appending(path: "changes.json")),
            followUpQueueStore: FollowUpQueueStore(fileURL: root.appending(path: "queues.json")),
            activityAttentionStore: ActivityAttentionStore(fileURL: root.appending(path: "activity.json"))
        )
        let metadataLoaded = await model.loadSessionMetadata()
        XCTAssertTrue(metadataLoaded)
        prepareRunningSession(model, runID: "run-steer-shutdown")
        let target = try XCTUnwrap(model.currentDraftTarget)
        model.updateComposerText("关闭前必须保留")
        model.followUp.pendingSteer = PendingSteerDraft(
            sessionID: "session-a",
            runID: "run-steer-shutdown",
            steerID: "steer-shutdown",
            draft: "关闭前必须保留",
            draftTarget: target,
            accepted: true
        )
        model.composerText = ""

        await model.shutdown()

        let restored = try await SessionDraftStore(fileURL: draftURL).load()
        XCTAssertEqual(restored.records.first(where: { $0.target.stableID == target.stableID })?.text, "关闭前必须保留")
    }

    @MainActor
    func testInterruptedDispatchAndRunRecoverAsExplicitUnknownStates() async throws {
        let root = temporaryDirectory("restart-normalization")
        defer { try? FileManager.default.removeItem(at: root) }
        let queueURL = root.appending(path: "queues.json")
        let dispatching = FollowUpQueueItem(
            id: "item-dispatching",
            text: "可能已经发出",
            createdAt: timestamp,
            state: .dispatching,
            promptID: "prompt-dispatching"
        )
        let document = FollowUpQueueDocument(queues: [
            FollowUpQueueRecord(
                id: "queue-dispatching",
                sessionID: "session-a",
                lineageEntryID: "assistant-a",
                items: [dispatching],
                createdAt: timestamp
            ),
            FollowUpQueueRecord(
                id: "queue-running",
                sessionID: "session-b",
                lineageEntryID: "user-b",
                items: [item("下一条", id: "item-next")],
                activeRunID: "run-b",
                activeRunEntryID: "user-b",
                createdAt: timestamp
            ),
        ])
        try await FollowUpQueueStore(fileURL: queueURL).save(document, revision: 1)

        let model = makeModel(root: root, queueURL: queueURL)
        let metadataLoaded = await model.loadSessionMetadata()
        XCTAssertTrue(metadataLoaded)
        XCTAssertEqual(
            model.followUp.queues.first(where: { $0.id == "queue-dispatching" })?.items.first?.state,
            .unknown
        )
        XCTAssertEqual(
            model.followUp.queues.first(where: { $0.id == "queue-dispatching" })?.pauseReason,
            .dispatchUnknown
        )
        XCTAssertEqual(
            model.followUp.queues.first(where: { $0.id == "queue-running" })?.pauseReason,
            .runOutcomeUnknown
        )

        let reloaded = try await FollowUpQueueStore(fileURL: queueURL).load()
        XCTAssertEqual(reloaded.queues.first(where: { $0.id == "queue-dispatching" })?.items.first?.state, .unknown)
        XCTAssertEqual(reloaded.queues.first(where: { $0.id == "queue-running" })?.pauseReason, .runOutcomeUnknown)
    }

    @MainActor
    func testRestartMakesAReadyButNotYetDispatchedQueueExplicitlyResumable() async throws {
        let root = temporaryDirectory("restart-ready")
        defer { try? FileManager.default.removeItem(at: root) }
        let queueURL = root.appending(path: "queues.json")
        let document = FollowUpQueueDocument(queues: [
            FollowUpQueueRecord(
                id: "queue-ready",
                sessionID: "session-a",
                pathID: "leaf:assistant-a",
                lineageEntryID: "assistant-a",
                items: [item("尚未交给 Host", id: "item-ready")],
                createdAt: timestamp
            ),
        ])
        try await FollowUpQueueStore(fileURL: queueURL).save(document, revision: 1)

        let model = makeModel(root: root, queueURL: queueURL)
        let metadataLoaded = await model.loadSessionMetadata()
        XCTAssertTrue(metadataLoaded)
        XCTAssertEqual(model.followUp.queues.single?.pauseReason, .manualResume)

        let reloaded = try await FollowUpQueueStore(fileURL: queueURL).load()
        XCTAssertEqual(reloaded.queues.single?.pauseReason, .manualResume)
    }

    @MainActor
    func testAgentEndAloneNeverAdvancesTheQueue() async throws {
        let root = temporaryDirectory("settlement-gate")
        defer { try? FileManager.default.removeItem(at: root) }
        let model = makeModel(root: root, queueURL: root.appending(path: "queues.json"))
        let metadataLoaded = await model.loadSessionMetadata()
        XCTAssertTrue(metadataLoaded)
        prepareRunningSession(model, runID: "run-gate")
        model.updateComposerText("完成后再做")
        await model.enqueueFollowUpFromComposer()

        model.handle(HostEvent(name: "session.event", data: .object([
            "type": .string("agent_end"),
            "runId": .string("run-gate"),
            "willRetry": .bool(false),
            "messages": .array([.object([
                "role": .string("assistant"),
                "stopReason": .string("stop"),
            ])]),
        ])))
        XCTAssertFalse(model.isStreaming)
        XCTAssertTrue(model.hasActiveRun)
        XCTAssertTrue(model.shouldQueueComposerText)
        XCTAssertTrue(model.isPromptTransactionActive)
        try await Task.sleep(for: .milliseconds(260))
        XCTAssertEqual(model.currentFollowUpQueue?.activeRunID, "run-gate")
        XCTAssertNil(model.currentFollowUpQueue?.pauseReason)

        model.handle(HostEvent(name: "session.event", data: .object([
            "type": .string("agent_settled"),
            "runId": .string("run-gate"),
        ])))
        try await Task.sleep(for: .milliseconds(420))
        XCTAssertEqual(model.currentFollowUpQueue?.activeRunID, "run-gate")
        XCTAssertNil(model.currentFollowUpQueue?.pauseReason)

        model.handle(HostEvent(name: "session.runStateChanged", data: .object([
            "sessionId": .string("session-a"),
            "runId": .string("run-gate"),
            "phase": .string("unknown"),
            "startedAt": .string(timestamp),
            "updatedAt": .string(timestamp),
            "completedAt": .string(timestamp),
            "inputPersisted": .bool(true),
            "retryable": .bool(false),
        ])))
        let paused = await waitUntil {
            model.currentFollowUpQueue?.pauseReason == .runOutcomeUnknown
        }
        XCTAssertTrue(paused)
        XCTAssertEqual(model.currentFollowUpQueue?.activeRunID, "run-gate")
        XCTAssertEqual(model.currentFollowUpQueue?.items.first?.state, .pending)
    }

    @MainActor
    func testQueueCreatedAfterAgentEndStillBindsToTheActiveHostRun() async throws {
        let root = temporaryDirectory("agent-end-bind")
        defer { try? FileManager.default.removeItem(at: root) }
        let model = makeModel(root: root, queueURL: root.appending(path: "queues.json"))
        let metadataLoaded = await model.loadSessionMetadata()
        XCTAssertTrue(metadataLoaded)
        prepareRunningSession(model, runID: "run-bind")

        model.handle(HostEvent(name: "session.event", data: .object([
            "type": .string("agent_end"),
            "sessionId": .string("session-a"),
            "runId": .string("run-bind"),
            "willRetry": .bool(false),
        ])))
        model.updateComposerText("仍属于这一轮之后")
        await model.enqueueFollowUpFromComposer()

        XCTAssertFalse(model.isStreaming)
        XCTAssertEqual(model.currentFollowUpQueue?.activeRunID, "run-bind")
        XCTAssertEqual(model.currentFollowUpQueue?.items.map(\.text), ["仍属于这一轮之后"])
    }

    @MainActor
    func testLatePromptFailurePausesQueueAfterPromptWasAlreadyPersisted() async throws {
        let root = temporaryDirectory("late-prompt-failure")
        defer { try? FileManager.default.removeItem(at: root) }
        let queueURL = root.appending(path: "queues.json")
        let model = makeModel(root: root, queueURL: queueURL)
        let metadataLoaded = await model.loadSessionMetadata()
        XCTAssertTrue(metadataLoaded)
        prepareRunningSession(model, runID: "run-late")
        model.updateComposerText("失败后不要自动继续")
        await model.enqueueFollowUpFromComposer()

        model.handle(HostEvent(name: "session.promptFailed", data: .object([
            "sessionId": .string("session-a"),
            "promptId": .string("run-late"),
            "persistedEntryId": .string("user-failed"),
            "message": .string("模拟运行失败"),
        ])))

        let paused = await waitUntil {
            model.followUp.queues.single?.pauseReason == .runFailed
        }
        XCTAssertTrue(paused)
        let queue = try XCTUnwrap(model.followUp.queues.single)
        XCTAssertNil(queue.activeRunID)
        XCTAssertNil(queue.activeRunEntryID)
        XCTAssertEqual(queue.lineageEntryID, "user-failed")
        XCTAssertEqual(queue.pathID, "leaf:user-failed")
        XCTAssertEqual(queue.items.map(\.text), ["失败后不要自动继续"])

        let persisted = try await FollowUpQueueStore(fileURL: queueURL).load()
        XCTAssertEqual(persisted.queues.single, queue)
    }

    @MainActor
    func testNormalSettlementDispatchesQueuedItemsExactlyOnceInOrder() async throws {
        let root = temporaryDirectory("end-to-end")
        defer { try? FileManager.default.removeItem(at: root) }
        let agentDirectory = root.appending(path: "agent", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: agentDirectory, withIntermediateDirectories: true)
        let script = root.appending(path: "queue-host.py")
        let source = #"""
        import json, os, sys, threading, time

        output_lock = threading.Lock()
        state_lock = threading.Lock()
        agent_dir = os.environ["PI_CODING_AGENT_DIR"]
        gate = os.path.join(agent_dir, "finish-first")
        prompts_file = os.path.join(agent_dir, "prompts.json")
        steers_file = os.path.join(agent_dir, "steers.json")
        session_id = "session-a"
        session_path = os.path.join(agent_dir, "session-a.jsonl")
        cwd = agent_dir
        entries = [
            {
                "type": "message", "id": "assistant-base", "parentId": None,
                "timestamp": "2026-08-15T09:00:00Z",
                "message": {"role": "assistant", "content": [{"type": "text", "text": "ready"}], "stopReason": "stop", "timestamp": 1},
            }
        ]
        prompts = []
        steers = []
        streaming = False
        run_state = None

        capabilities = {
            "sessionLease": True, "onDemandWrite": True, "structuredPlan": True,
            "mermaidUnicode": True, "projectCwdScope": True, "contextUsage": True,
            "fastMode": True, "sessionExternalSync": True, "dcodeSessionOrigin": True,
            "sessionSearch": True, "sessionPaths": True, "sessionCopy": True,
            "sessionTrash": True, "sessionVisibilityExclusions": True,
            "sessionChangeLedger": True, "sessionRename": True,
            "sessionRunCorrelation": True,
            "sessionRunState": True,
            "preSessionModelSelection": True,
            "modelSettings": True,
            "sessionSteer": True,
            "modelAuthentication": True,
        }

        def emit_event(name, data=None):
            record = {"version": 1, "type": "event", "event": name}
            if data is not None:
                record["data"] = data
            with output_lock:
                print(json.dumps(record), flush=True)

        def emit_response(request, result):
            with output_lock:
                print(json.dumps({
                    "version": 1, "type": "response", "id": request["id"],
                    "method": request["method"], "ok": True, "result": result,
                }), flush=True)

        def snapshot():
            with state_lock:
                copied = list(entries)
            leaf = copied[-1]["id"] if copied else None
            path_id = "leaf:" + leaf if leaf else "root"
            return {
                "summary": {
                    "path": session_path, "id": session_id, "cwd": cwd, "name": "Queue",
                    "parentSessionPath": None, "created": "2026-08-15T09:00:00Z",
                    "modified": "2026-08-15T09:00:00Z", "messageCount": len(copied),
                    "firstMessage": "ready",
                },
                "header": {"type": "session", "version": 3, "id": session_id, "timestamp": "2026-08-15T09:00:00Z", "cwd": cwd},
                "parentSessionId": None, "leafId": leaf, "currentPathId": path_id,
                "selectedPathId": path_id, "paths": [], "entries": copied,
                "context": {"messageCount": len(copied), "model": None, "thinkingLevel": "off"},
                "activePlan": None,
            }

        def host_state(writable=True):
            return {
                "mode": "writable" if writable else "readOnly", "sessionId": session_id,
                "sessionFile": session_path, "sessionName": "Queue", "cwd": cwd,
                "model": None, "thinkingLevel": "off", "activePlan": None,
                "isStreaming": streaming, "pendingMessageCount": 0,
                "contextUsage": None, "fastMode": None, "writable": writable,
                "conflict": None, "runState": run_state,
            }

        def persist_prompts():
            temporary = prompts_file + ".tmp"
            with open(temporary, "w", encoding="utf-8") as handle:
                json.dump(prompts, handle, ensure_ascii=False)
            os.replace(temporary, prompts_file)

        def persist_steers():
            temporary = steers_file + ".tmp"
            with open(temporary, "w", encoding="utf-8") as handle:
                json.dump(steers, handle, ensure_ascii=False)
            os.replace(temporary, steers_file)

        def finish_run(ordinal, prompt_id, user_id):
            global streaming, run_state
            if ordinal == 1:
                deadline = time.time() + 5
                while not os.path.exists(gate) and time.time() < deadline:
                    time.sleep(0.01)
            else:
                time.sleep(0.04)
            assistant_id = "assistant-" + str(ordinal)
            assistant = {
                "type": "message", "id": assistant_id, "parentId": user_id,
                "timestamp": "2026-08-15T09:00:02Z",
                "message": {"role": "assistant", "content": [{"type": "text", "text": "done"}], "stopReason": "stop", "timestamp": ordinal + 10},
            }
            with state_lock:
                entries.append(assistant)
                streaming = False
            wire_message = assistant["message"]
            emit_event("session.event", {"type": "agent_end", "sessionId": session_id, "runId": prompt_id, "willRetry": False, "messages": [wire_message]})
            emit_event("session.event", {"type": "agent_settled", "sessionId": session_id, "runId": prompt_id})
            run_state = {
                "sessionId": session_id, "runId": prompt_id, "phase": "completed",
                "startedAt": "2026-08-15T09:00:01Z", "updatedAt": "2026-08-15T09:00:02Z",
                "completionId": prompt_id + ":" + assistant_id, "completionEntryId": assistant_id,
                "completedAt": "2026-08-15T09:00:02Z", "inputPersisted": True, "retryable": False,
            }
            emit_event("session.runStateChanged", run_state)

        for line in sys.stdin:
            request = json.loads(line)
            method = request["method"]
            params = request.get("params", {})
            if method == "host.hello":
                result = {"protocolVersion": 1, "hostVersion": "0.0.7", "piVersion": "0.84.1", "nodeVersion": "test", "capabilities": capabilities}
            elif method == "session.list":
                result = {"sessions": [snapshot()["summary"]]}
            elif method == "session.open":
                writable = params.get("mode") == "writable"
                result = {"mode": "writable" if writable else "readOnly", "snapshot": snapshot(), "state": host_state(writable), "extensions": None}
            elif method == "session.refresh":
                result = snapshot()
            elif method == "session.getState":
                result = host_state(True)
            elif method == "session.getModels":
                result = {"models": []}
            elif method == "session.getThinkingLevels":
                result = {"levels": ["off"]}
            elif method == "session.getCommands":
                result = {"commands": []}
            elif method == "session.prompt":
                with state_lock:
                    ordinal = len(prompts) + 1
                    prompt_id = params["promptId"]
                    message = params["message"]
                    prompts.append(message)
                    persist_prompts()
                    user_id = "user-" + str(ordinal)
                    parent_id = entries[-1]["id"] if entries else None
                    entries.append({
                        "type": "message", "id": user_id, "parentId": parent_id,
                        "timestamp": "2026-08-15T09:00:01Z",
                        "message": {"role": "user", "content": message, "timestamp": ordinal},
                    })
                    streaming = True
                    run_state = {
                        "sessionId": session_id, "runId": prompt_id, "phase": "running",
                        "startedAt": "2026-08-15T09:00:01Z", "updatedAt": "2026-08-15T09:00:01Z",
                        "inputPersisted": True, "retryable": False,
                    }
                emit_event("session.runStateChanged", run_state)
                emit_event("session.event", {"type": "agent_start", "sessionId": session_id, "runId": prompt_id})
                emit_event("session.promptCompleted", {"sessionId": session_id, "promptId": prompt_id, "outcome": "persisted", "entryId": user_id})
                result = {"accepted": True, "completed": False}
                threading.Thread(target=finish_run, args=(ordinal, prompt_id, user_id), daemon=True).start()
            elif method == "session.steer":
                with state_lock:
                    steers.append(params["message"])
                    persist_steers()
                    active_run_id = run_state["runId"] if run_state else ""
                result = {"accepted": True, "steerId": params["steerId"], "runId": active_run_id}
            else:
                result = {"shuttingDown": True}
            emit_response(request, result)
            if method == "host.shutdown":
                break
        """#
        try source.write(to: script, atomically: true, encoding: .utf8)

        let model = AppModel(
            projectStore: ProjectStore(fileURL: root.appending(path: "projects.json")),
            sessionDraftStore: SessionDraftStore(fileURL: root.appending(path: "drafts.json")),
            sessionArchiveStore: SessionArchiveStore(fileURL: root.appending(path: "archives.json")),
            sessionPinStore: SessionPinStore(fileURL: root.appending(path: "pins.json")),
            sessionChangeStore: SessionChangeStore(fileURL: root.appending(path: "changes.json")),
            followUpQueueStore: FollowUpQueueStore(fileURL: root.appending(path: "queues.json")),
            activityAttentionStore: ActivityAttentionStore(fileURL: root.appending(path: "activity.json")),
            hostConfiguration: HostLaunchConfiguration(
                nodeURL: URL(fileURLWithPath: "/usr/bin/python3"),
                hostEntryURL: script,
                agentDirectoryURL: agentDirectory
            )
        )
        await model.start()
        XCTAssertEqual(model.connectionState, .ready)
        await model.selectSession("session-a")

        model.updateComposerText("first")
        await model.sendPrompt()
        let firstRunStarted = await waitUntil { model.pendingPrompt == nil && model.isStreaming }
        XCTAssertTrue(firstRunStarted)

        model.updateComposerText("  second  ")
        await model.sendPrompt()
        model.updateComposerText("third")
        await model.sendPrompt()
        XCTAssertEqual(model.currentFollowUpQueue?.items.map(\.text), ["  second  ", "third"])

        model.updateComposerText("change direction now")
        await model.sendPrompt(deliveryMode: .steer)
        XCTAssertTrue(model.followUp.pendingSteer?.accepted == true)
        XCTAssertEqual(model.currentFollowUpQueue?.items.map(\.text), ["  second  ", "third"])

        FileManager.default.createFile(atPath: agentDirectory.appending(path: "finish-first").path, contents: Data())
        let queueDrained = await waitUntil(timeout: .seconds(5)) {
            model.followUp.queues.isEmpty
                && !model.isStreaming
                && model.pendingPrompt == nil
                && model.followUp.pendingSteer == nil
        }
        XCTAssertTrue(queueDrained)
        XCTAssertEqual(model.composerText, "")

        let promptData = try Data(contentsOf: agentDirectory.appending(path: "prompts.json"))
        let prompts = try JSONDecoder().decode([String].self, from: promptData)
        XCTAssertEqual(prompts, ["first", "  second  ", "third"])
        let steerData = try Data(contentsOf: agentDirectory.appending(path: "steers.json"))
        XCTAssertEqual(try JSONDecoder().decode([String].self, from: steerData), ["change direction now"])
        await model.shutdown()
    }

    private var timestamp: String { "2026-08-15T09:00:00Z" }

    private func item(_ text: String, id: String) -> FollowUpQueueItem {
        FollowUpQueueItem(id: id, text: text, createdAt: timestamp)
    }

    private func queue(
        id: String,
        sessionID: String = "session-a",
        anchor: String,
        items: [FollowUpQueueItem]
    ) -> FollowUpQueueRecord {
        FollowUpQueueRecord(
            id: id,
            sessionID: sessionID,
            lineageEntryID: anchor,
            items: items,
            createdAt: timestamp
        )
    }

    @MainActor
    private func makeModel(root: URL, queueURL: URL) -> AppModel {
        AppModel(
            projectStore: ProjectStore(fileURL: root.appending(path: "projects.json")),
            sessionDraftStore: SessionDraftStore(fileURL: root.appending(path: "drafts.json")),
            sessionArchiveStore: SessionArchiveStore(fileURL: root.appending(path: "archives.json")),
            sessionPinStore: SessionPinStore(fileURL: root.appending(path: "pins.json")),
            sessionChangeStore: SessionChangeStore(fileURL: root.appending(path: "changes.json")),
            followUpQueueStore: FollowUpQueueStore(fileURL: queueURL),
            activityAttentionStore: ActivityAttentionStore(fileURL: root.appending(path: "activity.json"))
        )
    }

    @MainActor
    private func prepareRunningSession(_ model: AppModel, runID: String) {
        model.selectedSessionID = "session-a"
        model.inspection = inspection(
            sessionID: "session-a",
            selectedPathID: "leaf:assistant-a",
            entryIDs: ["user-a", "assistant-a"]
        )
        model.currentDraftTarget = .path(sessionID: "session-a", pathID: "leaf:assistant-a")
        model.handle(HostEvent(name: "session.event", data: .object([
            "type": .string("agent_start"),
            "runId": .string(runID),
        ])))
        model.handle(HostEvent(name: "session.runStateChanged", data: .object([
            "sessionId": .string("session-a"),
            "runId": .string(runID),
            "phase": .string("running"),
            "startedAt": .string(timestamp),
            "updatedAt": .string(timestamp),
            "inputPersisted": .bool(true),
            "retryable": .bool(false),
        ])))
    }

    private func inspection(
        sessionID: String,
        selectedPathID: String,
        entryIDs: [String]
    ) -> SessionInspection {
        SessionInspection(
            summary: sessionSummary(id: sessionID, messageCount: entryIDs.count),
            header: .object(["type": .string("session"), "id": .string(sessionID)]),
            parentSessionId: nil,
            leafId: entryIDs.last,
            currentPathId: selectedPathID,
            selectedPathId: selectedPathID,
            paths: [],
            entries: entryIDs.map { .object(["id": .string($0)]) },
            context: SessionContextSnapshot(messageCount: entryIDs.count, model: nil, thinkingLevel: "off"),
            activePlan: nil
        )
    }

    private func sessionSummary(id: String, messageCount: Int) -> SessionSummary {
        SessionSummary(
            path: "/tmp/\(id).jsonl",
            id: id,
            cwd: "/tmp",
            name: id,
            parentSessionPath: nil,
            created: timestamp,
            modified: timestamp,
            messageCount: messageCount,
            firstMessage: ""
        )
    }

    @MainActor
    private func waitUntil(
        timeout: Duration = .seconds(2),
        condition: @escaping @MainActor () -> Bool
    ) async -> Bool {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: timeout)
        while clock.now < deadline {
            if condition() { return true }
            try? await Task.sleep(for: .milliseconds(20))
        }
        return condition()
    }

    private func temporaryDirectory(_ name: String) -> URL {
        let directory = FileManager.default.temporaryDirectory
            .appending(path: "dcode-follow-up-\(name)-\(UUID().uuidString)", directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }
}

private extension Array {
    var single: Element? { count == 1 ? first : nil }
}
