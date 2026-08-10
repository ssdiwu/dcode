import Foundation

struct HostEvent: Sendable, Equatable {
    let name: String
    let data: JSONValue?
}

struct HostErrorPayload: Codable, Equatable, Sendable {
    let code: String
    let message: String
    let details: JSONValue?
}

private struct HostWireMessage: Decodable {
    let version: Int
    let type: String
    let id: String?
    let method: String?
    let ok: Bool?
    let result: JSONValue?
    let error: HostErrorPayload?
    let event: String?
    let data: JSONValue?
}

private struct HostWireRequest: Encodable {
    let version = 1
    let type = "request"
    let id: String
    let method: String
    let params: [String: JSONValue]
}

enum HostInboundMessage: Sendable, Equatable {
    case response(id: String, method: String, result: JSONValue)
    case failure(id: String, method: String, error: HostErrorPayload)
    case event(HostEvent)
}

enum PiHostClientError: LocalizedError, Sendable, Equatable {
    case notStarted
    case alreadyStarted
    case invalidEnvelope(String)
    case hostFailure(HostErrorPayload)
    case processEnded(Int32)
    case launchFailure(String)
    case writeFailure(String)

    var errorDescription: String? {
        switch self {
        case .notStarted:
            "Pi Host 尚未启动。"
        case .alreadyStarted:
            "Pi Host 已经启动。"
        case let .invalidEnvelope(reason):
            "Pi Host 返回了无法识别的消息：\(reason)"
        case let .hostFailure(error):
            switch error.code {
            case "SESSION_IN_USE":
                "这个会话正在另一个 D Code 进程中使用。请关闭那个窗口，稍候再试。"
            case "SESSION_NOT_IDLE":
                "这个会话仍在其他客户端中变化。请先停止该客户端，等待片刻后重试。"
            case "EXTERNAL_WRITE_DETECTED":
                "检测到其他客户端写入。D Code 已停止写入以保护会话；关闭其他客户端后可重新继续。"
            case "EXCLUSIVE_USE_CONFIRMATION_REQUIRED":
                "继续会话前必须确认其他客户端已经停止使用它。"
            default:
                "\(error.message)（\(error.code)）"
            }
        case let .processEnded(status):
            "Pi Host 已退出（状态码 \(status)）。"
        case let .launchFailure(reason):
            "无法启动 Pi Host：\(reason)"
        case let .writeFailure(reason):
            "无法向 Pi Host 发送请求：\(reason)"
        }
    }
}

enum HostProtocolCodec {
    static let decoder = JSONDecoder()
    static let encoder = JSONEncoder()

    static func decode(line: String) throws -> HostInboundMessage {
        guard let data = line.data(using: .utf8) else {
            throw PiHostClientError.invalidEnvelope("不是 UTF-8")
        }
        let message: HostWireMessage
        do {
            message = try decoder.decode(HostWireMessage.self, from: data)
        } catch {
            throw PiHostClientError.invalidEnvelope(error.localizedDescription)
        }
        guard message.version == 1 else {
            throw PiHostClientError.invalidEnvelope("协议版本 \(message.version) 不受支持")
        }
        switch message.type {
        case "response":
            guard let id = message.id, let method = message.method, let ok = message.ok else {
                throw PiHostClientError.invalidEnvelope("response 缺少关联字段")
            }
            if ok {
                return .response(id: id, method: method, result: message.result ?? .null)
            }
            guard let error = message.error else {
                throw PiHostClientError.invalidEnvelope("失败 response 缺少 error")
            }
            return .failure(id: id, method: method, error: error)
        case "event":
            guard let event = message.event else {
                throw PiHostClientError.invalidEnvelope("event 缺少名称")
            }
            return .event(HostEvent(name: event, data: message.data))
        default:
            throw PiHostClientError.invalidEnvelope("未知消息类型 \(message.type)")
        }
    }

    static func encodeRequest(id: String, method: String, params: [String: JSONValue]) throws -> Data {
        var data = try encoder.encode(HostWireRequest(id: id, method: method, params: params))
        data.append(0x0A)
        return data
    }
}
