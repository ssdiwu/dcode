import Foundation
@testable import PiDCode

struct RecordedHostRequest: Equatable {
    let method: String
    let params: [String: JSONValue]
}

/// 脚本化假宿主：按 method 匹配处理器返回结果，记录全部请求，
/// 并允许测试主动注入 HostEvent 驱动 AppModel 状态机。
actor FakeHostClient: HostProviding {
    nonisolated let lifecycle = HostProcessLifecycle()

    typealias Handler = @Sendable (
        _ method: String,
        _ params: [String: JSONValue]
    ) throws -> JSONValue

    private let eventSink: HostEventSink
    private var handler: Handler?
    private(set) var requests: [RecordedHostRequest] = []
    private(set) var shutdownCount = 0
    private(set) var startedCount = 0

    init(eventSink: @escaping HostEventSink) {
        self.eventSink = eventSink
    }

    func script(_ handler: Handler?) {
        self.handler = handler
    }

    func start() throws {
        startedCount += 1
    }

    func request<T: Decodable & Sendable>(
        _ method: String,
        params: [String: JSONValue],
        as type: T.Type
    ) async throws -> T {
        requests.append(RecordedHostRequest(method: method, params: params))
        guard let handler else {
            throw PiHostClientError.hostFailure(HostErrorPayload(code: "unhandled", message: "未脚本化：\(method)", details: nil))
        }
        let value = try handler(method, params)
        do {
            return try value.decoded(type)
        } catch {
            throw PiHostClientError.invalidEnvelope("\(method) 结果无法解码：\(error.localizedDescription)")
        }
    }

    func shutdown() async {
        shutdownCount += 1
    }

    func emit(_ event: HostEvent) async {
        await eventSink(event)
    }

    func recordedMethods() -> [String] {
        requests.map(\.method)
    }
}
