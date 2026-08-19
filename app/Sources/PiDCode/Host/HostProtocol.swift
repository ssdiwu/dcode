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
            case "WRITE_INTENT_REQUIRED":
                "本次操作缺少明确的写入意图，D Code 没有修改会话。请重试刚才的操作。"
            case "HOST_RESTART_REQUIRED":
                "上一次写入未能安全停止。D Code 仍可观察会话，但再次写入前需要重新打开 D Code。"
            case "SESSION_CHANGED_DURING_REFRESH":
                "Pi 会话仍在更新，本次刷新没有采用不稳定内容；D Code 会继续等待下一次完整更新。"
            case "SESSION_IDENTITY_CHANGED":
                "Pi 会话文件已被替换为不同身份。D Code 已保留上一次完整历史；请重新打开 D Code 后再继续。"
            case "SEARCH_TARGET_STALE":
                "这条搜索结果已不在当前会话路径中。搜索窗口已保留，请刷新结果后重试。"
            case "SESSION_TRASH_NOT_ALLOWED":
                "当前版本只允许把由 D Code 创建的空会话移到废纸篓。既有 Pi 会话仍保持不变。"
            case "SESSION_TRASH_NOT_EMPTY":
                "这个会话已经包含消息。当前版本不会删除有内容的 Pi 会话；可以改用归档。"
            case "SESSION_HAS_DESCENDANTS":
                "这个会话仍被复制或分叉会话引用。为保留谱系，请改用归档。"
            case "SESSION_TRASH_RESTORE_FAILED":
                "会话文件仍被完整保留，但无法放回原位置。请先不要继续操作，并从错误详情中的保留路径恢复。"
            case "SESSION_BUSY":
                "会话仍在运行、执行工具或持有可写状态。请等待它结束后重试。"
            case "INVALID_SESSION":
                "Pi 会话包含未完成或损坏的记录。D Code 已保留上一次完整历史；请等待 Pi 完成写入，持续出现时再检查会话文件。"
            case "MODEL_SETTINGS_UNREADABLE":
                "Pi 全局模型设置无法读取。D Code 已保留原文件，没有写入任何内容。"
            case "MODEL_NOT_AVAILABLE":
                "这个模型当前不在 Pi 目录中，或对应 Provider 尚未完成认证。"
            case "MODEL_NOT_ENABLED":
                "这个模型不在 Pi 的全局启用范围内；请先把它加入启用规则。"
            case "SESSION_NOT_RUNNING":
                "当前 Pi 运行已经结束，无法再介入；正文仍保留在输入框。"
            case "SESSION_RUN_CHANGED":
                "当前 Pi 运行已经变化，本次介入没有发送；正文已恢复到输入框。"
            case "SESSION_WAITING_FOR_USER":
                "请先完成当前结构化选择、确认或输入，再发送普通消息。"
            case "STEER_REJECTED":
                "Pi 未接受本次介入信息，正文已恢复到输入框。"
            case "MODEL_AUTH_CANCELLED":
                "Provider 认证已取消。"
            case "MODEL_AUTH_NOT_INTERACTIVE":
                "该 Provider 需要在 Pi 或系统环境中配置，不能在 D Code 内直接认证。"
            case "MODEL_AUTH_FAILED":
                "Provider 认证失败；凭据未由 D Code 保存，请检查网络或重新认证。"
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
