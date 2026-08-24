import Foundation
import XCTest
@testable import PiDCode

@MainActor
final class RelaunchShutdownTests: XCTestCase {
    private func temporaryRoot(_ name: String) throws -> URL {
        let root = FileManager.default.temporaryDirectory
            .appending(path: "dcode-shutdown-\(name)-\(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return root
    }

    private func writeHostScript(at root: URL, shutdownResponds: Bool) throws -> URL {
        let script = root.appending(path: "fake-host.py")
        let shutdownBranch = shutdownResponds
            ? "\n        print(json.dumps({\"version\": 1, \"type\": \"response\", \"id\": request[\"id\"], \"method\": method, \"ok\": True, \"result\": {\"shuttingDown\": True}}), flush=True)\n        break\n"
            : "\n        while True:\n            time.sleep(1)\n"
        let source = """
        import json, sys, time
        for line in sys.stdin:
            request = json.loads(line)
            method = request["method"]
            if method == "host.hello":
                result = {"protocolVersion": 1, "piVersion": "test", "nodeVersion": "test", "capabilities": {}}
                print(json.dumps({"version": 1, "type": "response", "id": request["id"], "method": method, "ok": True, "result": result}), flush=True)
            elif method == "host.shutdown":
        """ + shutdownBranch + """
            else:
                print(json.dumps({"version": 1, "type": "response", "id": request["id"], "method": method, "ok": True, "result": {}}), flush=True)
        """
        try source.write(to: script, atomically: true, encoding: .utf8)
        return script
    }

    private func waitForHostExit(_ lifecycle: HostProcessLifecycle) async {
        for _ in 0..<30 {
            if lifecycle.processIdentifier == nil { return }
            try? await Task.sleep(for: .milliseconds(50))
        }
    }

    func testNormalHostShutdownCompletesAndClearsOwnedProcess() async throws {
        let root = try temporaryRoot("normal")
        let script = try writeHostScript(at: root, shutdownResponds: true)
        let client = PiHostClient(
            configuration: HostLaunchConfiguration(
                nodeURL: URL(fileURLWithPath: "/usr/bin/python3"),
                hostEntryURL: script,
                agentDirectoryURL: root
            ),
            eventSink: { _ in }
        )
        try await client.start()
        _ = try await client.request("host.hello", as: HostHello.self)
        XCTAssertNotNil(client.lifecycle.processIdentifier)

        await client.shutdown()
        await waitForHostExit(client.lifecycle)

        XCTAssertNil(client.lifecycle.processIdentifier, "正常 Host shutdown 必须结束当前拥有的 Host")
    }

    func testStuckHostShutdownIsForceTerminatedWithinBoundedFallback() async throws {
        let root = try temporaryRoot("stuck")
        let script = try writeHostScript(at: root, shutdownResponds: false)
        let client = PiHostClient(
            configuration: HostLaunchConfiguration(
                nodeURL: URL(fileURLWithPath: "/usr/bin/python3"),
                hostEntryURL: script,
                agentDirectoryURL: root
            ),
            eventSink: { _ in }
        )
        try await client.start()
        _ = try await client.request("host.hello", as: HostHello.self)
        let startedAt = Date()

        await client.shutdown()
        await waitForHostExit(client.lifecycle)

        XCTAssertNil(client.lifecycle.processIdentifier)
        XCTAssertLessThan(Date().timeIntervalSince(startedAt), 5, "卡住 Host 不能让 shutdown 无限等待")
    }

    func testSecondQuitUsesImmediateCompletionPathInsteadOfSecondTerminateLater() async throws {
        let root = try temporaryRoot("second-quit")
        let client = BlockingShutdownHostClient()
        let model = AppModel(
            projectStore: ProjectStore(fileURL: root.appending(path: "projects.json")),
            sessionDraftStore: SessionDraftStore(fileURL: root.appending(path: "drafts.json")),
            sessionArchiveStore: SessionArchiveStore(fileURL: root.appending(path: "archives.json")),
            sessionPinStore: SessionPinStore(fileURL: root.appending(path: "pins.json")),
            sessionChangeStore: SessionChangeStore(fileURL: root.appending(path: "changes.json")),
            verificationStore: VerificationEvidenceStore(fileURL: root.appending(path: "evidence.json")),
            followUpQueueStore: FollowUpQueueStore(fileURL: root.appending(path: "followups.json")),
            activityAttentionStore: ActivityAttentionStore(fileURL: root.appending(path: "activity.json")),
            selfEvolution: SelfEvolutionModel(
                store: SelfEvolutionRunStore(fileURL: root.appending(path: "self-evolution.json"))
            ),
            hostConfiguration: HostLaunchConfiguration(
                nodeURL: URL(fileURLWithPath: "/usr/bin/true"),
                hostEntryURL: URL(fileURLWithPath: "/tmp/unused-host.js"),
                agentDirectoryURL: root.appending(path: "agent")
            ),
            clientFactory: { _, _ in client }
        )
        await model.start()
        XCTAssertEqual(model.connectionState, .ready)
        let delegate = PiDCodeAppDelegate()
        PiDCodeAppDelegate.model = model
        defer { PiDCodeAppDelegate.model = nil }

        let first = delegate.applicationShouldTerminate(NSApplication.shared)
        let second = delegate.applicationShouldTerminate(NSApplication.shared)

        XCTAssertEqual(first, .terminateLater)
        XCTAssertEqual(second, .terminateNow)
        await client.releaseShutdown()
        await model.shutdown()
    }
}

private actor BlockingShutdownHostClient: HostProviding {
    nonisolated let lifecycle = HostProcessLifecycle()
    private var released = false

    func start() throws {}

    func request<T: Decodable & Sendable>(
        _ method: String,
        params: [String: JSONValue],
        as type: T.Type
    ) async throws -> T {
        let value: JSONValue
        switch method {
        case "host.hello":
            value = HostTestHarness.helloValue()
        case "session.list":
            value = .object(["sessions": .array([])])
        default:
            value = .object([:])
        }
        return try value.decoded(type)
    }

    func shutdown() async {
        while !released {
            try? await Task.sleep(for: .milliseconds(20))
        }
    }

    func releaseShutdown() {
        released = true
    }
}
