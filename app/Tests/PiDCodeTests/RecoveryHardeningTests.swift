import SwiftUI
import XCTest
@testable import PiDCode

/// 0.0.19 失败与恢复加固（ADR 0027）：Host 重连状态机、尾部不完整会话的
/// 修复卡全链路（fake host 返回 repairable details → session.repair → 重开）、
/// store 熔断显式重试与存储状态呈现。
@MainActor
final class RecoveryHardeningTests: XCTestCase {
    // MARK: - Host 重连

    func testRestartHostRecoversFromUnexpectedProcessEnd() async throws {
        let harness = HostTestHarness()
        await harness.installDefaultScript()
        await harness.model.start()
        XCTAssertEqual(harness.model.connectionState, .ready)
        harness.model.selectedSessionID = "session-a"

        await harness.client.emit(HostEvent(
            name: "host.processEnded",
            data: .object(["status": .number(1), "expected": .bool(false)])
        ))
        XCTAssertEqual(harness.model.connectionState, .failed)

        await harness.model.restartHost()
        XCTAssertEqual(harness.model.connectionState, .ready, "应用内重连不重启 App")
        XCTAssertFalse(harness.model.hostRestartRequired)

        let methods = await harness.client.recordedMethods()
        XCTAssertTrue(
            methods.contains("session.open"),
            "重连后必须尝试以可写重开当前会话（fake 默认脚本下重开失败，但尝试行为已锁定）"
        )
    }

    func testRestartRequiredFlagDrivesReconnectEntryAndClears() async throws {
        let harness = HostTestHarness()
        await harness.installDefaultScript()
        await harness.model.start()
        XCTAssertFalse(harness.model.hostRestartRequired)

        await harness.client.emit(HostEvent(name: "host.restartRequired", data: .object([:])))
        XCTAssertTrue(harness.model.hostRestartRequired, "需重启态出现重连入口")

        await harness.model.restartHost()
        XCTAssertTrue(harness.model.connectionState == .ready)
        XCTAssertFalse(harness.model.hostRestartRequired, "重连成功后清除标记")
    }

    // MARK: - 尾部不完整会话的修复卡（ADR 0027 决定 4）

    func testInvalidSessionWithRepairableDetailPresentsRepairFlow() async throws {
        let harness = HostTestHarness()
        await harness.client.script { method, _ in
            switch method {
            case "host.hello":
                HostTestHarness.helloValue()
            case "session.list":
                .object(["sessions": .array([])])
            case "session.open":
                throw PiHostClientError.hostFailure(HostErrorPayload(
                    code: "INVALID_SESSION",
                    message: "Session has an incomplete trailing JSONL entry",
                    details: .object([
                        "repairable": .bool(true),
                        "repairReason": .string("尾部一条记录不完整（缺少终止换行），其余 5 条记录完好。"),
                    ])
                ))
            case "session.repair":
                .object([
                    "ok": .bool(true),
                    "backupPath": .string("/tmp/sessions/x.jsonl.bak-1"),
                    "entryCount": .number(5),
                ])
            default:
                .object([:])
            }
        }
        await harness.model.start()

        await harness.model.selectSession("session-a")
        let prompt = try XCTUnwrap(harness.model.sessionRepairPrompt, "repairable 的 INVALID_SESSION 必须呈现修复卡")
        XCTAssertEqual(prompt.sessionID, "session-a")
        XCTAssertTrue(prompt.reason.contains("尾部"))

        await harness.model.repairSessionAndReopen()
        let methods = await harness.client.recordedMethods()
        XCTAssertTrue(methods.contains("session.repair"), "必须调用 session.repair")
        XCTAssertTrue(methods.filter { $0 == "session.open" }.count >= 2, "修复后必须尝试重开")
        // fake 脚本对 open 永远返回可修错误：重开失败时修复卡如实再次呈现（不静默）。
        XCTAssertNotNil(harness.model.sessionRepairPrompt, "重开仍失败时再次提示修复而非吞掉结果")
        XCTAssertNotNil(harness.model.notice)
    }

    func testRepairRejectionIsHonestAndDoesNotReopen() async throws {
        let harness = HostTestHarness()
        await harness.client.script { method, _ in
            switch method {
            case "host.hello":
                HostTestHarness.helloValue()
            case "session.list":
                .object(["sessions": .array([])])
            case "session.open":
                throw PiHostClientError.hostFailure(HostErrorPayload(
                    code: "INVALID_SESSION",
                    message: "Invalid JSONL",
                    details: .object([
                        "repairable": .bool(false),
                        "repairReason": .string("不只尾部损坏，拒绝修复。"),
                    ])
                ))
            case "session.repair":
                .object(["ok": .bool(false), "repairable": .bool(false), "reason": .string("不只尾部损坏，拒绝修复。")])
            default:
                .object([:])
            }
        }
        await harness.model.start()

        await harness.model.selectSession("session-a")
        // repairable=false：不呈现修复卡。
        XCTAssertNil(harness.model.sessionRepairPrompt)

        // 直接呈现提示后走拒绝路径（人工或后续入口触发），拒绝必须如实且不重开。
        harness.model.presentSessionRepairPrompt(sessionID: "session-a", reason: "测试")
        await harness.model.repairSessionAndReopen()
        let methods = await harness.client.recordedMethods()
        XCTAssertEqual(methods.filter { $0 == "session.repair" }.count, 1)
        XCTAssertEqual(methods.filter { $0 == "session.open" }.count, 1, "修复被拒绝后不得重开")
        XCTAssertNotNil(harness.model.notice)
    }

    // MARK: - store 熔断显式重试（ADR 0027 决定 6）

    func testVerificationEvidenceStoreUnblockRetriesFlush() async throws {
        let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
            .appendingPathComponent(".build", isDirectory: true)
            .appendingPathComponent("DCodeRecoveryHardening-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        // 写入目标是一个已存在目录 → data.write 失败 → 熔断。
        let blocker = root.appending(path: "blocker", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: blocker, withIntermediateDirectories: true)
        let store = VerificationEvidenceStore(fileURL: blocker)
        let record = VerificationEvidenceRecord(
            recordId: "r1",
            sessionId: "s1",
            runId: "run-1",
            toolCallId: "tool-1",
            command: "npm test",
            exitKind: "ok",
            exitCode: 0,
            startedAt: Date(),
            endedAt: Date(),
            cwd: "/repo",
            modelProvider: nil,
            modelId: nil,
            gitRevision: nil
        )
        await store.append(record)
        let blocked = await store.writeBlockedProbe()
        XCTAssertTrue(blocked, "写盘失败后熔断可见")

        // 障碍未排除：显式重试如实回到熔断。
        let stillBlocked = await store.retryFlushUnblock()
        XCTAssertFalse(stillBlocked)

        // 排除障碍后重试成功恢复写入。
        try FileManager.default.removeItem(at: blocker)
        let recovered = await store.retryFlushUnblock()
        XCTAssertTrue(recovered)
        let afterRecovery = await store.writeBlockedProbe()
        XCTAssertFalse(afterRecovery)
        let records = await store.allRecords()
        XCTAssertEqual(records.map(\.recordId), ["r1"], "熔断期间的内存账本在恢复后补写")
    }

    func testSessionDraftStoreUnblockReloadsAfterRepair() async throws {
        let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
            .appendingPathComponent(".build", isDirectory: true)
            .appendingPathComponent("DCodeRecoveryHardening-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let fileURL = root.appending(path: "drafts.json")
        try Data("not-json".utf8).write(to: fileURL)
        let store = SessionDraftStore(fileURL: fileURL)
        _ = try? await store.load()
        let blocked = await store.writeBlockedProbe()
        XCTAssertTrue(blocked, "损坏文件触发熔断")

        let encoder = JSONEncoder()
        try encoder.encode(SessionDraftDocument()).write(to: fileURL, options: [.atomic])
        let recovered = await store.retryLoadUnblock()
        XCTAssertTrue(recovered, "修复文件后显式重试解除熔断")
        let afterRecovery = await store.writeBlockedProbe()
        XCTAssertFalse(afterRecovery)
    }

    // MARK: - 存储状态呈现（渲染冒烟）

    func testHostDiagnosticsPageRendersStoreHealthSection() {
        let model = AppModel()
        let host = NSHostingView(
            rootView: HostDiagnosticsSettingsView()
                .environment(model)
                .frame(width: 640, height: 720)
        )
        host.layoutSubtreeIfNeeded()
        XCTAssertFalse(host.fittingSize == .zero, "本机存储状态区必须完成布局")
    }
}
