import Foundation
import XCTest
@testable import PiDCode

/// 组装 AppModel + FakeHostClient 的测试基座：
/// 全部本地 store 指向临时目录，宿主进程由脚本化假宿主替代，
/// 不触碰真实 `~/.pi/agent` 与用户 `Library/Application Support/D Code`。
@MainActor
final class HostTestHarness {
    let root: URL
    let client: FakeHostClient
    let model: AppModel

    init() {
        let root = FileManager.default.temporaryDirectory
            .appending(path: "DCodeHostHarness-\(UUID().uuidString)", directoryHint: .isDirectory)
        self.root = root
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)

        // 假宿主先于 AppModel 创建；事件汇在 model.start() 的
        // clientFactory 回调里才接上 model.handle，之后事件才真正流动。
        let sinkBox = EventSinkBox()
        let fake = FakeHostClient(eventSink: { event in
            sinkBox.sink?(event)
        })
        client = fake
        let configuration = HostLaunchConfiguration(
            nodeURL: URL(fileURLWithPath: "/usr/bin/true"),
            hostEntryURL: URL(fileURLWithPath: "/nonexistent/host.js"),
            agentDirectoryURL: root.appending(path: "agent", directoryHint: .isDirectory)
        )
        model = AppModel(
            projectStore: ProjectStore(fileURL: root.appending(path: "projects.json")),
            sessionDraftStore: SessionDraftStore(fileURL: root.appending(path: "drafts.json")),
            sessionArchiveStore: SessionArchiveStore(fileURL: root.appending(path: "archives.json")),
            sessionPinStore: SessionPinStore(fileURL: root.appending(path: "pins.json")),
            sessionChangeStore: SessionChangeStore(fileURL: root.appending(path: "changes.json")),
            followUpQueueStore: FollowUpQueueStore(fileURL: root.appending(path: "followups.json")),
            activityAttentionStore: ActivityAttentionStore(fileURL: root.appending(path: "activity.json")),
            hostConfiguration: configuration,
            clientFactory: { _, eventSink in
                sinkBox.sink = eventSink
                return fake
            }
        )
    }

    deinit {
        try? FileManager.default.removeItem(at: root)
    }

    /// 为假宿主安装默认脚本：握手 + 空会话列表，足以让 AppModel 进入 ready。
    func installDefaultScript() async {
        await client.script { method, _ in
            switch method {
            case "host.hello":
                HostTestHarness.helloValue()
            case "session.list":
                .object(["sessions": .array([])])
            default:
                .object([:])
            }
        }
    }

    nonisolated static func helloValue() -> JSONValue {
        .object([
            "protocolVersion": .number(1),
            "hostVersion": .string(HostCompatibility.appVersion),
            "piVersion": .string("0.84.1-test"),
            "nodeVersion": .string("v22.22.3-test"),
            "capabilities": .object(
                Dictionary(
                    uniqueKeysWithValues: HostCompatibility.requiredCapabilities.map { ($0, JSONValue.bool(true)) }
                )
            ),
        ])
    }

    nonisolated static func sessionSummaryValue(
        id: String,
        messageCount: Int = 3,
        modified: String = "2026-08-18T08:00:00.000Z"
    ) -> JSONValue {
        .object([
            "path": .string("/tmp/harness/\(id).jsonl"),
            "id": .string(id),
            "cwd": .string("/tmp/harness"),
            "name": .null,
            "parentSessionPath": .null,
            "created": .string("2026-08-18T07:00:00.000Z"),
            "modified": .string(modified),
            "messageCount": .number(Double(messageCount)),
            "firstMessage": .string("summary of \(id)"),
        ])
    }
}

/// AppModel.start() 在 clientFactory 里传入真实事件汇；
/// 假宿主在此之前创建，靠引用盒持有汇，首启后才转发事件。
private final class EventSinkBox: @unchecked Sendable {
    private let lock = NSLock()
    private var boxed: HostEventSink?

    var sink: HostEventSink? {
        get { lock.withLock { boxed } }
        set { lock.withLock { boxed = newValue } }
    }
}
