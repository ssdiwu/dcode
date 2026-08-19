import Foundation
import XCTest
@testable import PiDCode

/// Fake-host 集成测试：覆盖 AppModel 与宿主协议交互的核心状态机。
@MainActor
final class AppModelHostIntegrationTests: XCTestCase {
    func testStartPerformsHandshakeAndEntersReady() async throws {
        let harness = HostTestHarness()
        await harness.installDefaultScript()

        await harness.model.start()

        XCTAssertEqual(harness.model.connectionState, .ready)
        XCTAssertEqual(harness.model.hostHello?.protocolVersion, 1)
        let methods = await harness.client.recordedMethods()
        XCTAssertEqual(methods.first, "host.hello")
        XCTAssertTrue(methods.contains("session.list"))
    }

    func testStartFailsCleanlyWhenHandshakeVersionMismatches() async throws {
        let harness = HostTestHarness()
        await harness.client.script { method, _ in
            switch method {
            case "host.hello":
                .object([
                    "protocolVersion": .number(2),
                    "hostVersion": .string("mismatched"),
                    "piVersion": .string("0.84.1-test"),
                    "nodeVersion": .string("v22.22.3-test"),
                    "capabilities": .object([:]),
                ])
            default:
                .object([:])
            }
        }

        await harness.model.start()

        XCTAssertEqual(harness.model.connectionState, .failed)
        XCTAssertNotNil(harness.model.issue)
        let shutdownCount = await harness.client.shutdownCount
        XCTAssertEqual(shutdownCount, 1, "失败路径必须关闭宿主并清理引用")
        let methods = await harness.client.recordedMethods()
        XCTAssertEqual(methods, ["host.hello"], "握手失败后不应继续发会话请求")
    }
}
