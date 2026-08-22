import Foundation
import XCTest
@testable import PiDCode

/// 统一命令面板（0.0.20）：扩展命令 + 命令 / Skill / 模板 混排、
/// 同名去重、类型标注与悬停全文。
@MainActor
final class ComposerCommandSuggestionTests: XCTestCase {
    private func command(_ name: String, description: String? = nil) -> CommandDescriptor {
        CommandDescriptor(name: name, description: description, source: "extension", sourceInfo: nil)
    }

    private func resource(
        _ name: String,
        description: String? = nil,
        source: String = "extension",
        argumentHint: String? = nil
    ) -> ResourceCommandEntry {
        ResourceCommandEntry(
            name: name,
            description: description,
            source: source,
            argumentHint: argumentHint
        )
    }

    func testBuildMergesAllResourceKindsWithTypeLabelsAndDedupesExtensionCommands() {
        let rows = ComposerCommandSuggestion.build(
            commands: [command("mcp", description: "MCP 状态")],
            resources: [
                resource("mcp", description: "重复的扩展命令应被去重"),
                resource("skill:llm-wiki", description: "知识库", source: "skill"),
                resource("review", description: "评审模板", source: "prompt", argumentHint: "目标"),
                resource("dhash", description: "哈希工具", source: "extension"),
            ],
            fragment: ""
        )

        XCTAssertEqual(rows.map(\.displayCommand), ["/mcp", "/skill:llm-wiki", "/review", "/dhash"])
        XCTAssertEqual(rows.map(\.typeLabel), ["扩展", "Skill", "模板", "命令"])
        XCTAssertEqual(rows[0].description, "MCP 状态", "同名扩展命令以 getCommands 版本为准")
        XCTAssertEqual(
            rows[2].invocationText, "/review <目标>",
            "Prompt 模板保留参数提示占位（0.0.16 合同）"
        )
        XCTAssertEqual(rows[1].invocationText, "/skill:llm-wiki ")
    }

    func testSkillNameCarriesSkillPrefixForInvocationButMatchesPlainFragment() {
        let rows = ComposerCommandSuggestion.build(
            commands: [],
            resources: [resource("skill:llm-wiki", description: nil, source: "skills")],
            fragment: "llm"
        )
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows[0].displayCommand, "/skill:llm-wiki")
        XCTAssertEqual(rows[0].invocationText, "/skill:llm-wiki ")
        XCTAssertEqual(rows[0].typeLabel, "Skill")

        let noMatch = ComposerCommandSuggestion.build(
            commands: [],
            resources: [resource("skill:llm-wiki", description: nil, source: "skills")],
            fragment: "wiki2"
        )
        XCTAssertTrue(noMatch.isEmpty)
    }

    func testHoverDescriptionIncludesTypeCommandAndFullDescription() {
        let row = ComposerCommandSuggestion.build(
            commands: [],
            resources: [resource("review", description: "对目标分支执行逐文件评审", source: "prompt")],
            fragment: "review"
        )[0]
        XCTAssertEqual(row.hoverDescription, "模板 · /review\n对目标分支执行逐文件评审")

        let undescribed = ComposerCommandSuggestion.build(
            commands: [command("mcp")],
            resources: [],
            fragment: ""
        )[0]
        XCTAssertEqual(undescribed.hoverDescription, "扩展 · /mcp")
    }

    func testEmptyFragmentShowsEverythingAndIdsStayStable() {
        let rows = ComposerCommandSuggestion.build(
            commands: [command("mcp")],
            resources: [resource("skill:x", source: "s"), resource("p", source: "prompt")],
            fragment: ""
        )
        XCTAssertEqual(rows.count, 3)
        XCTAssertEqual(Set(rows.map(\.id)).count, 3)
    }
}

/// 图片附件状态机（0.0.20，ADR 0028）：上限、payload 形态、
/// 队列拦截与 steer 失败恢复。
@MainActor
final class ComposerAttachmentStateTests: XCTestCase {
    private let timestamp = "2026-08-22T09:00:00Z"

    @MainActor
    private func makeModel(root: URL) -> AppModel {
        AppModel(
            projectStore: ProjectStore(fileURL: root.appending(path: "projects.json")),
            sessionDraftStore: SessionDraftStore(fileURL: root.appending(path: "drafts.json")),
            sessionArchiveStore: SessionArchiveStore(fileURL: root.appending(path: "archives.json")),
            sessionPinStore: SessionPinStore(fileURL: root.appending(path: "pins.json")),
            sessionChangeStore: SessionChangeStore(fileURL: root.appending(path: "changes.json")),
            followUpQueueStore: FollowUpQueueStore(fileURL: root.appending(path: "queues.json")),
            activityAttentionStore: ActivityAttentionStore(fileURL: root.appending(path: "activity.json"))
        )
    }

    func testAddEnforcesCountAndSizeLimitsAndBuildsRequestPayload() async throws {
        let root = FileManager.default.temporaryDirectory
            .appending(path: "DCodeAttachment-\(UUID().uuidString)", directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let model = makeModel(root: root)
        _ = await model.loadSessionMetadata()

        XCTAssertNil(model.composerImageRequestPayload, "无附件时不产生 images 参数")

        let png = Data([0x89, 0x50, 0x4E, 0x47])
        XCTAssertNil(model.addComposerImageAttachment(fileName: "shot.png", mimeType: "image/png", data: png))
        XCTAssertEqual(model.composerImages.count, 1)
        XCTAssertEqual(model.composerImageRequestPayload, .array([
            .object([
                "type": .string("image"),
                "data": .string(png.base64EncodedString()),
                "mimeType": .string("image/png"),
            ]),
        ]))

        for index in 1..<AppModel.composerImageCountLimit {
            XCTAssertNil(model.addComposerImageAttachment(fileName: "shot-\(index).png", mimeType: "image/png", data: png))
        }
        XCTAssertNotNil(
            model.addComposerImageAttachment(fileName: "over.png", mimeType: "image/png", data: png),
            "超过数量上限必须给出用户可读失败原因"
        )

        let oversized = Data(repeating: 0x41, count: AppModel.composerImageByteLimit + 1)
        XCTAssertNotNil(
            model.addComposerImageAttachment(fileName: "huge.png", mimeType: "image/png", data: oversized),
            "超过单张体积上限必须拒绝"
        )

        let firstID = model.composerImages[0].id
        model.removeComposerImageAttachment(id: firstID)
        XCTAssertEqual(model.composerImages.count, AppModel.composerImageCountLimit - 1)
        model.clearComposerImageAttachments()
        XCTAssertTrue(model.composerImages.isEmpty)
        XCTAssertNil(model.composerImageRequestPayload)
    }

    func testEnqueueFollowUpWithAttachmentsIsRejectedWithNoticeInsteadOfDroppingThem() async {
        let root = FileManager.default.temporaryDirectory
            .appending(path: "DCodeAttachmentQueue-\(UUID().uuidString)", directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let model = makeModel(root: root)
        _ = await model.loadSessionMetadata()
        prepareRunningSession(model, runID: "run-image")

        model.updateComposerText("带图排队")
        XCTAssertNil(model.addComposerImageAttachment(
            fileName: "shot.png",
            mimeType: "image/png",
            data: Data([0x89, 0x50])
        ))
        await model.enqueueFollowUpFromComposer()

        XCTAssertTrue(model.followUp.queues.isEmpty, "带附件的消息不得进入文本队列")
        XCTAssertEqual(model.composerText, "带图排队", "正文与附件都保留在输入区")
        XCTAssertEqual(model.composerImages.count, 1)
        XCTAssertEqual(model.notice?.level, "warning")
        XCTAssertNotNil(model.notice?.message.range(of: "后续消息队列"))

        model.removeComposerImageAttachment(id: model.composerImages[0].id)
        await model.enqueueFollowUpFromComposer()
        XCTAssertEqual(model.currentFollowUpQueue?.items.map(\.text), ["带图排队"], "移除附件后排队恢复正常")
    }

    func testSteerFailureRestoresAttachmentsTogetherWithDraftText() async throws {
        let root = FileManager.default.temporaryDirectory
            .appending(path: "DCodeAttachmentSteer-\(UUID().uuidString)", directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let model = makeModel(root: root)
        _ = await model.loadSessionMetadata()
        prepareRunningSession(model, runID: "run-steer-img")

        let attachment = ComposerImageAttachment(
            id: UUID(),
            fileName: "shot.png",
            mimeType: "image/png",
            base64Data: "aGlzdG9ncmFt",
            byteCount: 8
        )
        model.followUp.pendingSteer = PendingSteerDraft(
            sessionID: "session-a",
            runID: "run-steer-img",
            steerID: "steer-img",
            draft: "介入正文",
            draftTarget: model.currentDraftTarget,
            images: [attachment],
            accepted: true
        )
        model.composerText = ""
        model.composerImages = []

        model.handle(HostEvent(name: "session.runStateChanged", data: .object([
            "sessionId": .string("session-a"),
            "runId": .string("run-steer-img"),
            "phase": .string("aborted"),
            "startedAt": .string(timestamp),
            "updatedAt": .string(timestamp),
            "completedAt": .string(timestamp),
            "inputPersisted": .bool(true),
            "retryable": .bool(false),
        ])))

        XCTAssertEqual(model.composerText, "介入正文")
        XCTAssertEqual(model.composerImages, [attachment], "steer 未正常完成时附件随正文一起恢复")
    }

    private func prepareRunningSession(_ model: AppModel, runID: String) {
        model.selectedSessionID = "session-a"
        model.inspection = SessionInspection(
            summary: SessionSummary(
                path: "/tmp/session-a.jsonl",
                id: "session-a",
                cwd: "/work",
                name: "session-a",
                parentSessionPath: nil,
                created: "2026-08-22T09:00:00Z",
                modified: "2026-08-22T09:00:00Z",
                messageCount: 2,
                firstMessage: "ready"
            ),
            header: .object(["type": .string("session"), "id": .string("session-a")]),
            parentSessionId: nil,
            leafId: "assistant-a",
            currentPathId: "leaf:assistant-a",
            selectedPathId: "leaf:assistant-a",
            paths: [],
            entries: [
                .object(["id": .string("user-a")]),
                .object(["id": .string("assistant-a")]),
            ],
            context: SessionContextSnapshot(messageCount: 2, model: nil, thinkingLevel: "off"),
            activePlan: nil,
            activeProposal: nil
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
}

/// 端到端（脚本化假宿主）：图片附件随 `session.prompt` 请求真实进入 `images` 参数，
/// 发送后附件清空；协议侧形态见 host/test/protocol.test.ts。
@MainActor
final class ComposerAttachmentRequestTests: XCTestCase {
    func testPromptRequestCarriesImageAttachments() async throws {
        let root = FileManager.default.currentDirectoryPath
        let workspace = URL(fileURLWithPath: root)
            .appending(path: ".build/dcode-attachment-e2e-\(UUID().uuidString)", directoryHint: .isDirectory)
        let agentDirectory = workspace.appending(path: "agent", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: agentDirectory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: workspace) }

        let promptsFile = agentDirectory.appending(path: "prompt-params.json")
        let script = workspace.appending(path: "fake-host.py")
        let source = #"""
        import json, os, sys, threading

        agent_dir = sys.argv[2]
        session_id = "session-img"
        cwd = agent_dir
        session_path = os.path.join(agent_dir, "session-img.jsonl")
        prompts_file = os.path.join(agent_dir, "prompt-params.json")
        output_lock = threading.Lock()
        entries = [
            {"type": "message", "id": "user-a", "parentId": None, "timestamp": "2026-08-22T09:00:00Z",
             "message": {"role": "user", "content": "ready", "timestamp": 1}},
            {"type": "message", "id": "assistant-a", "parentId": "user-a", "timestamp": "2026-08-22T09:00:01Z",
             "message": {"role": "assistant", "content": [{"type": "text", "text": "ok"}], "stopReason": "stop", "timestamp": 2}},
        ]

        capabilities = {
            "sessionLease": True, "onDemandWrite": True, "structuredPlan": True,
            "mermaidUnicode": True, "projectCwdScope": True,
            "contextUsage": True, "contextBreakdown": True, "permissionGate": True,
            "fastMode": True, "sessionExternalSync": True, "dcodeSessionOrigin": True,
            "sessionSearch": True, "sessionPaths": True, "sessionCopy": True,
            "sessionTrash": True, "sessionVisibilityExclusions": True,
            "sessionChangeLedger": True, "sessionRename": True,
            "sessionRunCorrelation": True, "sessionRunState": True,
            "preSessionModelSelection": True, "modelSettings": True,
            "sessionSteer": True, "modelAuthentication": True,
        }

        def snapshot():
            return {
                "summary": {
                    "path": session_path, "id": session_id, "cwd": cwd, "name": "Images",
                    "parentSessionPath": None, "created": "2026-08-22T09:00:00Z",
                    "modified": "2026-08-22T09:00:01Z", "messageCount": len(entries),
                    "firstMessage": "ready",
                },
                "header": {"type": "session", "version": 3, "id": session_id, "timestamp": "2026-08-22T09:00:00Z", "cwd": cwd},
                "parentSessionId": None, "leafId": "assistant-a",
                "currentPathId": "leaf:assistant-a", "selectedPathId": "leaf:assistant-a",
                "paths": [], "entries": entries,
                "context": {"messageCount": len(entries), "model": None, "thinkingLevel": "off"},
                "activePlan": None,
            }

        def host_state():
            return {
                "mode": "writable", "sessionId": session_id, "sessionFile": session_path,
                "sessionName": "Images", "cwd": cwd, "model": None, "thinkingLevel": "off",
                "activePlan": None, "isStreaming": False, "pendingMessageCount": 0,
                "contextUsage": None, "fastMode": None, "writable": True, "conflict": None,
                "runState": None,
            }

        def emit(record):
            with output_lock:
                print(json.dumps(record), flush=True)

        for line in sys.stdin:
            request = json.loads(line)
            method = request["method"]
            params = request.get("params", {})
            if method == "host.hello":
                result = {"protocolVersion": 1, "hostVersion": "0.0.20", "piVersion": "0.84.1", "nodeVersion": "test", "capabilities": capabilities}
            elif method == "session.list":
                result = {"sessions": [snapshot()["summary"]]}
            elif method == "session.open":
                result = {"mode": "writable", "snapshot": snapshot(), "state": host_state(), "extensions": None}
            elif method == "session.refresh":
                result = snapshot()
            elif method == "session.getState":
                result = host_state()
            elif method == "session.getModels":
                result = {"models": []}
            elif method == "session.getThinkingLevels":
                result = {"levels": ["off"]}
            elif method == "session.getCommands":
                result = {"commands": []}
            elif method == "resources.list":
                result = {"packages": [], "extensions": [], "skills": [], "prompts": [], "commands": [], "diagnostics": []}
            elif method == "session.prompt":
                temporary = prompts_file + ".tmp"
                with open(temporary, "w", encoding="utf-8") as handle:
                    json.dump(params, handle, ensure_ascii=False)
                os.replace(temporary, prompts_file)
                result = {"accepted": True, "completed": True}
            elif method == "host.shutdown":
                emit({"version": 1, "type": "response", "id": request["id"], "method": method, "ok": True, "result": {"shuttingDown": True}})
                break
            else:
                result = {}
            emit({"version": 1, "type": "response", "id": request["id"], "method": method, "ok": True, "result": result})
        """#
        try source.write(to: script, atomically: true, encoding: .utf8)

        let model = AppModel(
            projectStore: ProjectStore(fileURL: workspace.appending(path: "projects.json")),
            sessionDraftStore: SessionDraftStore(fileURL: workspace.appending(path: "drafts.json")),
            sessionArchiveStore: SessionArchiveStore(fileURL: workspace.appending(path: "archives.json")),
            sessionPinStore: SessionPinStore(fileURL: workspace.appending(path: "pins.json")),
            sessionChangeStore: SessionChangeStore(fileURL: workspace.appending(path: "changes.json")),
            followUpQueueStore: FollowUpQueueStore(fileURL: workspace.appending(path: "queues.json")),
            activityAttentionStore: ActivityAttentionStore(fileURL: workspace.appending(path: "activity.json")),
            hostConfiguration: HostLaunchConfiguration(
                nodeURL: URL(fileURLWithPath: "/usr/bin/python3"),
                hostEntryURL: script,
                agentDirectoryURL: agentDirectory
            )
        )
        await model.start()
        XCTAssertTrue(model.connectionState == .ready)

        await model.selectSession("session-img")
        for _ in 0..<200 where model.selectedSessionID != "session-img" || !model.canWrite {
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertEqual(model.selectedSessionID, "session-img", "会话必须以可写打开后才能发送附件")

        model.updateComposerText("看这张截图")
        let png = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A])
        XCTAssertNil(model.addComposerImageAttachment(fileName: "shot.png", mimeType: "image/png", data: png))
        await model.sendPrompt()

        let raw = try Data(contentsOf: promptsFile)
        let recorded = try XCTUnwrap(
            JSONSerialization.jsonObject(with: raw) as? [String: Any],
            "假宿主必须记录 session.prompt 完整参数"
        )
        let message = try XCTUnwrap(recorded["message"] as? String)
        XCTAssertEqual(message, "看这张截图")
        let images = try XCTUnwrap(recorded["images"] as? [[String: Any]], "images 必须随请求发送")
        XCTAssertEqual(images.count, 1)
        XCTAssertEqual(images[0]["type"] as? String, "image")
        XCTAssertEqual(images[0]["mimeType"] as? String, "image/png")
        XCTAssertEqual(images[0]["data"] as? String, png.base64EncodedString())
        XCTAssertTrue(model.composerImages.isEmpty, "请求受理后附件清空")

        // 与既有脚本化宿主测试一致：结束时必须 shutdown，否则残留的主线程任务
        //（pendingPrompt 等待、草稿定时器）会阻塞同一 xctest 进程里的后续用例。
        await model.shutdown()
    }
}
