import Foundation

typealias HostEventSink = @MainActor @Sendable (HostEvent) -> Void

/// AppModel 可依赖的宿主能力面。
/// 生产实现是 `PiHostClient`，测试通过注入脚本化假宿主覆盖状态机。
protocol HostProviding: Actor {
    nonisolated var lifecycle: HostProcessLifecycle { get }

    func start() throws
    func request<T: Decodable & Sendable>(
        _ method: String,
        params: [String: JSONValue],
        as type: T.Type
    ) async throws -> T
    func shutdown() async
}

extension HostProviding {
    func request<T: Decodable & Sendable>(_ method: String) async throws -> T {
        try await request(method, params: [:], as: T.self)
    }

    func request<T: Decodable & Sendable>(
        _ method: String,
        params: [String: JSONValue]
    ) async throws -> T {
        try await request(method, params: params, as: T.self)
    }
}
