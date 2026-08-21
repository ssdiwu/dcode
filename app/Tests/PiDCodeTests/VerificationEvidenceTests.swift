import SwiftUI
import XCTest
@testable import PiDCode

/// 0.0.12 结构化验证证据：退出推导、入账与渲染。
@MainActor
final class VerificationEvidenceTests: XCTestCase {
    func testExitParserDerivesHonestStatuses() {
        XCTAssertEqual(VerificationExitParser.parse(isError: false, resultText: nil).kind, "ok")
        let failed = VerificationExitParser.parse(isError: true, resultText: "...\nCommand exited with code 2\n...")
        XCTAssertEqual(failed.kind, "failure")
        XCTAssertEqual(failed.code, 2)
        let unknown = VerificationExitParser.parse(isError: true, resultText: "工具异常中断")
        XCTAssertEqual(unknown.kind, "unknown")
        XCTAssertNil(unknown.code)
    }

    func testBashExecutionEventsPersistEvidenceWithRunLinkage() async throws {
        let root = FileManager.default.temporaryDirectory
            .appending(path: "dcode-evidence-\(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let harness = HostTestHarness()
        await harness.installDefaultScript()
        await harness.model.start()
        harness.model.selectedSessionID = "session-a"

        await harness.client.emit(HostEvent(name: "session.event", data: .object([
            "type": .string("tool_execution_start"),
            "toolCallId": .string("tc-1"),
            "toolName": .string("bash"),
            "args": .object(["command": .string("swift test")]),
            "sessionId": .string("session-a"),
            "runId": .string("run-1"),
        ])))
        try await Task.sleep(for: .milliseconds(20))
        await harness.client.emit(HostEvent(name: "session.event", data: .object([
            "type": .string("tool_execution_end"),
            "toolCallId": .string("tc-1"),
            "toolName": .string("bash"),
            "result": .object(["output": .string("all tests passed")]),
            "isError": .bool(false),
            "sessionId": .string("session-a"),
            "runId": .string("run-1"),
        ])))
        try await Task.sleep(for: .milliseconds(120))

        let record = harness.model.verificationEvidence.first { $0.toolCallId == "tc-1" }
        let unwrapped = try XCTUnwrap(record)
        XCTAssertEqual(unwrapped.command, "swift test")
        XCTAssertEqual(unwrapped.exitKind, "ok")
        XCTAssertEqual(unwrapped.runId, "run-1")
        XCTAssertGreaterThanOrEqual(unwrapped.durationMs, 0)

        // 非 bash 工具不入账
        await harness.client.emit(HostEvent(name: "session.event", data: .object([
            "type": .string("tool_execution_start"),
            "toolCallId": .string("tc-2"),
            "toolName": .string("read"),
            "args": .object(["path": .string("a.txt")]),
        ])))
        await harness.client.emit(HostEvent(name: "session.event", data: .object([
            "type": .string("tool_execution_end"),
            "toolCallId": .string("tc-2"),
            "toolName": .string("read"),
            "result": .object(["output": .string("x")]),
            "isError": .bool(false),
        ])))
        try await Task.sleep(for: .milliseconds(80))
        XCTAssertNil(harness.model.verificationEvidence.first { $0.toolCallId == "tc-2" }, "非 bash 工具不入证据账本")
    }

    func testEvidenceRowRendersBothStates() {
        let ok = VerificationEvidenceRecord(
            recordId: "s:r:1", sessionId: "s", runId: "r", toolCallId: "1",
            command: "swift test", exitKind: "ok", exitCode: 0,
            startedAt: Date(timeIntervalSince1970: 1_800_000_000),
            endedAt: Date(timeIntervalSince1970: 1_800_000_030),
            cwd: "/tmp/p", modelProvider: "openai", modelId: "gpt", gitRevision: "abc1234def"
        )
        let failed = VerificationEvidenceRecord(
            recordId: "s:r:2", sessionId: "s", runId: "r", toolCallId: "2",
            command: "npm test", exitKind: "failure", exitCode: 2,
            startedAt: Date(timeIntervalSince1970: 1_800_000_100),
            endedAt: Date(timeIntervalSince1970: 1_800_000_160),
            cwd: "/tmp/p", modelProvider: nil, modelId: nil, gitRevision: nil
        )
        for record in [ok, failed] {
            let host = NSHostingView(
                rootView: VerificationEvidenceRow(record: record)
                    .environment(AppModel())
                    .frame(width: 380, height: 120)
            )
            host.layoutSubtreeIfNeeded()
            XCTAssertFalse(host.fittingSize == .zero)
        }
    }
}
