import XCTest
@testable import PiDCode

@MainActor
final class FoundationConsoleTests: XCTestCase {
    private func snapshotValue(
        revision: Int = 0,
        withOpenRequest: Bool = false,
        projectScope: Bool = false
    ) -> JSONValue {
        let task = taskValue(projectScope: projectScope)
        let session = sessionValue()
        return .object([
            "schemaVersion": .number(1),
            "storeRevision": .number(Double(revision)),
            "dataRoot": .string("/Users/tester/.dcode"),
            "currentUser": .object([
                "id": .string("current-user"),
                "homeDirectory": .string("/Users/tester"),
                "revision": .number(1),
            ]),
            "projects": .array([]),
            "agentProfiles": .array([
                .object([
                    "id": .string("builtin-coordinator"),
                    "role": .string("coordinator"),
                    "name": .string("Coordinator"),
                    "roleContract": .string("Coordinate the Task"),
                    "enabled": .bool(true),
                    "builtin": .bool(true),
                    "profileVersion": .number(1),
                    "revision": .number(1),
                ]),
                .object([
                    "id": .string("builtin-explore"),
                    "role": .string("explore"),
                    "name": .string("Explore"),
                    "roleContract": .string("Explore the Task"),
                    "enabled": .bool(true),
                    "builtin": .bool(true),
                    "profileVersion": .number(1),
                    "revision": .number(1),
                ]),
                .object([
                    "id": .string("builtin-worker"),
                    "role": .string("worker"),
                    "name": .string("Worker"),
                    "roleContract": .string("Implement the Task"),
                    "enabled": .bool(true),
                    "builtin": .bool(true),
                    "profileVersion": .number(1),
                    "revision": .number(1),
                ]),
            ]),
            "tasks": .array(withOpenRequest ? [task] : []),
            "taskContextSets": .array(withOpenRequest ? [.object([
                "taskId": .string("task-one"),
                "revision": .number(1),
                "sources": .array([]),
                "createdAt": .string("2026-08-25T00:00:00Z"),
                "updatedAt": .string("2026-08-25T00:00:00Z"),
            ])] : []),
            "sessions": .array(withOpenRequest ? [session] : []),
            "sessionPaths": .array([]),
            "sessionProvenance": .array([]),
            "coordinatorAssignments": .array([]),
            "piImports": .array([]),
            "sessionRuns": .array(withOpenRequest ? [.object([
                "id": .string("session-run-one"),
                "taskId": .string("task-one"),
                "sessionId": .string("session-one"),
                "runtimeId": .string("runtime-agent-one"),
                "agentRunId": .string("agent-one"),
                "effectiveInputId": .string("effective-one"),
                "runtimeEnvironmentId": .string("environment-one"),
                "activeToolSetId": .string("tools-one"),
                "status": .string("waiting"),
                "revision": .number(2),
            ])] : []),
            "operationAttempts": .array([]),
            "runtimeEnvironments": .array(withOpenRequest ? [.object([
                "id": .string("environment-one"),
                "taskId": .string("task-one"),
                "sessionId": .string("session-one"),
                "runtimeId": .string("runtime-agent-one"),
                "workspaceId": .string("workspace-one"),
                "cwd": .string("/Users/tester"),
                "workspaceAccess": .string("sharedReadOnly"),
                "environment": .object(["profileSnapshot": .object([:])]),
                "revision": .number(1),
                "createdAt": .string("2026-08-25T00:00:00Z"),
            ])] : []),
            "activeToolSets": .array(withOpenRequest ? [.object([
                "id": .string("tools-one"),
                "taskId": .string("task-one"),
                "sessionId": .string("session-one"),
                "revision": .number(1),
                "digest": .string("sha256:tools"),
                "tools": .array([]),
                "writable": .bool(false),
                "createdAt": .string("2026-08-25T00:00:00Z"),
            ])] : []),
            "promptReceipts": .array(withOpenRequest ? [.object([
                "id": .string("receipt-one"),
                "taskId": .string("task-one"),
                "sessionId": .string("session-one"),
                "sessionRunId": .string("session-run-one"),
                "effectiveInputId": .string("effective-one"),
                "runtimeEnvironmentId": .string("environment-one"),
                "activeToolSetId": .string("tools-one"),
                "systemPromptDigest": .string("sha256:prompt"),
                "identityRevision": .string("dcode-identity-v1"),
                "roleRevision": .string("builtin-coordinator:v1"),
                "sourceReceipts": .array([.object([
                    "path": .string("/Users/tester/AGENTS.md"),
                    "digest": .string("sha256:receipt"),
                    "bytes": .number(120),
                ])]),
                "sourceStates": .array([.object([
                    "path": .string("/Users/tester/AGENTS.md"),
                    "receiptDigest": .string("sha256:receipt"),
                    "receiptBytes": .number(120),
                    "state": .string("hash_mismatch"),
                    "contentStored": .bool(false),
                    "currentDigest": .string("sha256:current"),
                    "currentBytes": .number(128),
                ])]),
                "createdAt": .string("2026-08-25T00:00:00Z"),
            ])] : []),
            "teamRuns": .array(withOpenRequest ? [.object([
                "id": .string("team-one"),
                "taskId": .string("task-one"),
                "coordinatorAgentRunId": .string("agent-one"),
                "status": .string("waiting"),
                "revision": .number(2),
            ])] : []),
            "teamFailures": .array([]),
            "agentRuns": .array(withOpenRequest ? [.object([
                "id": .string("agent-one"),
                "taskId": .string("task-one"),
                "teamRunId": .string("team-one"),
                "sessionId": .string("session-one"),
                "profileId": .string("builtin-coordinator"),
                "profileSnapshot": .object([
                    "id": .string("builtin-coordinator"),
                    "role": .string("coordinator"),
                    "roleContract": .string("Coordinate the Task"),
                    "profileVersion": .number(1),
                ]),
                "role": .string("coordinator"),
                "status": .string("waiting"),
                "revision": .number(2),
            ])] : []),
            "agentAssignments": .array([]),
            "agentRequests": .array(withOpenRequest ? [.object([
                "id": .string("request-one"),
                "taskId": .string("task-one"),
                "teamRunId": .string("team-one"),
                "agentRunId": .string("agent-one"),
                "sessionId": .string("session-one"),
                "sessionRunId": .string("session-run-one"),
                "runtimeId": .string("runtime-agent-one"),
                "kind": .string("choice"),
                "prompt": .string("Choose one"),
                "options": .array([
                    .object([
                        "id": .string("one"),
                        "label": .string("First"),
                        "recommended": .bool(true),
                    ]),
                    .object([
                        "id": .string("two"),
                        "label": .string("Second"),
                        "recommended": .bool(false),
                    ]),
                ]),
                "status": .string("open"),
                "revision": .number(1),
                "createdAt": .string("2026-08-25T00:00:00Z"),
                "updatedAt": .string("2026-08-25T00:00:00Z"),
            ])] : []),
            "agentReports": .array([]),
            "findings": .array([]),
            "artifacts": .array([]),
            "managedWorkerWorktrees": .array([]),
            "evidence": .array([]),
            "events": .array([]),
        ])
    }

    private func taskValue(projectScope: Bool = false) -> JSONValue {
        .object([
            "id": .string("task-one"),
            "scope": projectScope
                ? .object(["kind": .string("project"), "projectId": .string("project-one")])
                : .object(["kind": .string("user"), "userId": .string("current-user")]),
            "title": .string("Native Task"),
            "goal": .string("Exercise Foundation"),
            "acceptance": .array([]),
            "cwd": .string("/Users/tester"),
            "state": .string("draft"),
            "revision": .number(1),
        ])
    }

    private func sessionValue() -> JSONValue {
        .object([
            "id": .string("session-one"),
            "taskId": .string("task-one"),
            "kind": .string("coordination"),
            "title": .string("Native Task"),
            "runtimeAdapter": .string("pi"),
            "lineageStatus": .string("native"),
            "state": .string("idle"),
            "revision": .number(1),
        ])
    }

    func testFoundationHostStartsInConsoleModeWithoutLoadingLegacySessionNavigation() async {
        let harness = HostTestHarness(foundationMode: true)
        let snapshot = snapshotValue()
        await harness.client.script { method, _ in
            switch method {
            case "host.hello":
                HostTestHarness.helloValue()
            case "foundation.snapshot":
                snapshot
            case "piImport.listCandidates":
                .object(["candidates": .array([])])
            default:
                .object([:])
            }
        }

        await harness.model.start()

        XCTAssertEqual(harness.model.connectionState, .ready)
        XCTAssertTrue(harness.model.isFoundationMode)
        XCTAssertEqual(harness.model.foundationSnapshot?.dataRoot, "/Users/tester/.dcode")
        XCTAssertTrue(harness.model.projects.isEmpty, "legacy Swift Project Store must not become a second authority")
        let methods = await harness.client.recordedMethods()
        XCTAssertEqual(methods, ["host.hello", "foundation.snapshot", "piImport.listCandidates"])
    }

    func testFoundationTaskAndPiImportUseTheSharedMutationContract() async {
        let harness = HostTestHarness(foundationMode: true)
        let snapshot = snapshotValue()
        let task = taskValue()
        let session = sessionValue()
        await harness.client.script { method, _ in
            switch method {
            case "host.hello":
                HostTestHarness.helloValue()
            case "foundation.snapshot":
                snapshot
            case "piImport.listCandidates":
                .object(["candidates": .array([
                    .object([
                        "sourceSessionId": .string("pi-source"),
                        "title": .string("Pi Source"),
                        "cwd": .string("/tmp/source"),
                        "created": .string("2026-08-25T00:00:00Z"),
                        "modified": .string("2026-08-25T00:00:01Z"),
                        "messageCount": .number(2),
                        "firstMessage": .string("hello"),
                        "previouslyImported": .bool(false),
                    ]),
                ])])
            case "task.create", "piImport.importAsTask":
                .object([
                    "storeRevision": .number(1),
                    "task": task,
                    "coordinationSession": session,
                    "coordinatorAssignment": .object([
                        "id": .string("assignment-one"),
                        "taskId": .string("task-one"),
                        "sessionId": .string("session-one"),
                        "profileId": .string("builtin-coordinator"),
                        "revision": .number(1),
                    ]),
                ])
            default:
                .object([:])
            }
        }
        await harness.model.start()

        let created = await harness.model.createFoundationTask(
            title: "Native Task",
            goal: "Exercise Foundation",
            scope: .user(userId: "current-user")
        )
        XCTAssertTrue(created)
        let imported = await harness.model.importPiSessionAsFoundationTask(
            sourceSessionId: "pi-source",
            scope: .user(userId: "current-user")
        )
        XCTAssertTrue(imported)
        let methods = await harness.client.recordedMethods()
        XCTAssertTrue(methods.contains("task.create"))
        XCTAssertTrue(methods.contains("piImport.importAsTask"))
        XCTAssertGreaterThanOrEqual(methods.filter { $0 == "foundation.snapshot" }.count, 3)
    }

    func testFoundationAgentRequestAnswerCarriesTheCompleteRuntimeIdentity() async throws {
        let harness = HostTestHarness(foundationMode: true)
        let snapshot = snapshotValue(revision: 9, withOpenRequest: true)
        await harness.client.script { method, _ in
            switch method {
            case "host.hello": HostTestHarness.helloValue()
            case "foundation.snapshot": snapshot
            case "piImport.listCandidates": .object(["candidates": .array([])])
            case "agentRequest.answer": .object([:])
            default: .object([:])
            }
        }
        await harness.model.start()
        let request = try XCTUnwrap(harness.model.foundationSnapshot?.agentRequests.first)
        XCTAssertEqual(harness.model.foundationSnapshot?.runtimeEnvironments.first?.runtimeId, "runtime-agent-one")
        XCTAssertEqual(harness.model.foundationSnapshot?.activeToolSets.first?.id, "tools-one")
        XCTAssertEqual(harness.model.foundationSnapshot?.promptReceipts.first?.sessionRunId, "session-run-one")
        let promptSource = try XCTUnwrap(harness.model.foundationSnapshot?.promptReceipts.first?.sourceStates.first)
        XCTAssertEqual(promptSource.state, "hash_mismatch")
        XCTAssertFalse(promptSource.contentStored)
        XCTAssertEqual(promptSource.currentBytes, 128)
        let option = try XCTUnwrap(request.options.first)
        let answeredSuccessfully = await harness.model.answerFoundationAgentRequest(request, option: option)
        XCTAssertTrue(answeredSuccessfully)
        let calls = await harness.client.requests
        let answer = try XCTUnwrap(calls.first(where: { $0.method == "agentRequest.answer" }))
        XCTAssertEqual(answer.params["runtimeId"]?.stringValue, "runtime-agent-one")
        XCTAssertEqual(answer.params["taskId"]?.stringValue, "task-one")
        XCTAssertEqual(answer.params["teamRunId"]?.stringValue, "team-one")
        XCTAssertEqual(answer.params["agentRunId"]?.stringValue, "agent-one")
        XCTAssertEqual(answer.params["sessionRunId"]?.stringValue, "session-run-one")
        XCTAssertEqual(answer.params["agentRequestId"]?.stringValue, "request-one")
        XCTAssertEqual(answer.params["answer"]?["optionId"]?.stringValue, "one")
    }

    func testFoundationTaskContextUsesRevisionedHostMutation() async throws {
        let harness = HostTestHarness(foundationMode: true)
        let snapshot = snapshotValue(revision: 12, withOpenRequest: true)
        await harness.client.script { method, _ in
            switch method {
            case "host.hello": HostTestHarness.helloValue()
            case "foundation.snapshot": snapshot
            case "piImport.listCandidates": .object(["candidates": .array([])])
            case "task.context.replace": .object([
                "storeRevision": .number(13),
                "contextSet": .object([
                    "taskId": .string("task-one"),
                    "revision": .number(2),
                    "sources": .array([]),
                    "createdAt": .string("2026-08-25T00:00:00Z"),
                    "updatedAt": .string("2026-08-25T00:00:00Z"),
                ]),
            ])
            default: .object([:])
            }
        }
        await harness.model.start()
        let task = try XCTUnwrap(harness.model.foundationSnapshot?.tasks.first)
        let contextSet = try XCTUnwrap(harness.model.foundationSnapshot?.taskContextSets.first)
        let saved = await harness.model.replaceFoundationTaskContext(
            task: task,
            contextSet: contextSet,
            sources: [
                .init(kind: "scope_document", relativePath: "DESIGN.md", title: "设计", rootPath: nil),
                .init(
                    kind: "global_knowledge",
                    relativePath: "context.md",
                    title: "全局知识",
                    rootPath: "/Users/tester/Workspace/Write/Content"
                ),
            ]
        )
        XCTAssertTrue(saved)
        let calls = await harness.client.requests
        let call = try XCTUnwrap(calls.first(where: { $0.method == "task.context.replace" }))
        XCTAssertEqual(call.params["taskId"]?.stringValue, "task-one")
        XCTAssertEqual(call.params["expectedStoreRevision"]?.intValue, 12)
        XCTAssertEqual(call.params["expectedContextRevision"]?.intValue, 1)
        XCTAssertEqual(call.params["sources"]?.arrayValue?.count, 2)
        XCTAssertEqual(call.params["sources"]?.arrayValue?[1]["rootPath"]?.stringValue, "/Users/tester/Workspace/Write/Content")
    }

    func testWorkerTeamUsesHostDerivedWorkspaceAndRefusesUserScope() async throws {
        let userHarness = HostTestHarness(foundationMode: true)
        let userSnapshot = snapshotValue(revision: 4)
        await userHarness.client.script { method, _ in
            switch method {
            case "host.hello": HostTestHarness.helloValue()
            case "foundation.snapshot": userSnapshot
            case "piImport.listCandidates": .object(["candidates": .array([])])
            default: .object([:])
            }
        }
        await userHarness.model.start()
        let refused = await userHarness.model.createFoundationTeam(
            taskId: "task-one",
            memberProfileIDs: ["builtin-explore", "builtin-worker"]
        )
        XCTAssertFalse(refused)
        let userMethods = await userHarness.client.recordedMethods()
        XCTAssertFalse(userMethods.contains("team.create"))

        let projectHarness = HostTestHarness(foundationMode: true)
        let projectSnapshot = snapshotValue(revision: 8, withOpenRequest: true, projectScope: true)
        await projectHarness.client.script { method, _ in
            switch method {
            case "host.hello": HostTestHarness.helloValue()
            case "foundation.snapshot": projectSnapshot
            case "piImport.listCandidates": .object(["candidates": .array([])])
            case "team.create": .object([
                "storeRevision": .number(9),
                "teamRun": .object([
                    "id": .string("team-one"),
                    "taskId": .string("task-one"),
                    "coordinatorAgentRunId": .string("agent-one"),
                    "status": .string("active"),
                    "revision": .number(2),
                ]),
                "coordinatorAgentRun": .object([
                    "id": .string("agent-one"),
                    "taskId": .string("task-one"),
                    "teamRunId": .string("team-one"),
                    "sessionId": .string("session-one"),
                    "profileId": .string("builtin-coordinator"),
                    "profileSnapshot": .object([:]),
                    "role": .string("coordinator"),
                    "status": .string("prepared"),
                    "revision": .number(1),
                ]),
                "childSessions": .array([]),
                "childAgentRuns": .array([]),
                "assignments": .array([]),
            ])
            case "team.start": .object([
                "taskId": .string("task-one"),
                "teamRunId": .string("team-one"),
                "coordinatorManaged": .bool(true),
                "started": .bool(true),
            ])
            default: .object([:])
            }
        }
        await projectHarness.model.start()
        let created = await projectHarness.model.createFoundationTeam(
            taskId: "task-one",
            memberProfileIDs: ["builtin-explore", "builtin-worker"]
        )
        XCTAssertTrue(created)
        let task = try XCTUnwrap(projectHarness.model.foundationSnapshot?.tasks.first)
        let started = await projectHarness.model.startFoundationTeam(task: task, teamRunId: "team-one")
        XCTAssertTrue(started)
        let calls = await projectHarness.client.requests
        let create = try XCTUnwrap(calls.first(where: { $0.method == "team.create" }))
        let members = create.params["members"]?.arrayValue ?? []
        XCTAssertTrue(members.contains { $0["profileId"]?.stringValue == "builtin-worker" })
        let start = try XCTUnwrap(calls.first(where: { $0.method == "team.start" }))
        XCTAssertNil(start.params["workspace"])
    }
}
