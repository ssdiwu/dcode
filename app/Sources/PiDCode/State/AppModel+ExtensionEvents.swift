import Foundation
import Observation

/// 扩展事件：请求对话、通知、状态与受限能力。
extension AppModel {
    func handleExtensionHostEvent(_ event: HostEvent) {
        switch event.name {
        case "extension.request":
            if let dialog = ExtensionDialog(data: event.data) { extensionDialogs.append(dialog) }
        case "extension.closed":
            if let id = event.data?["requestId"]?.stringValue {
                extensionDialogs.removeAll(where: { $0.id == id })
            }
        case "extension.notification":
            let message = event.data?["message"]?.stringValue ?? "扩展通知"
            // pi-di18n 等扩展把 TUI 状态提示经 notify 发出（"lang:{locale}…"、
            // "i18n: …fallback mode…" 等已知前缀，可能为 warning 级别）；
            // 它们在 Pi CLI 里是 transient footer/状态行，对 D Code 是每次打开
            // 会话的重复噪音。pi-marketplace 的 "loaded" 就绪广播同理：没有用户
            // 动作对应的扩展自报状态。与 host.stderr 同等对待：只进只读诊断日志，
            // 不弹横幅。
            if message.hasPrefix("lang:")
                || message.hasPrefix("i18n:")
                || message.hasPrefix("pi-marketplace loaded") {
                appendHostDiagnostic("扩展状态提示：\(message)")
            } else {
                showNotice(message, level: event.data?["level"]?.stringValue ?? "info")
            }
        case "extension.status":
            updateStatus(event.data)
        case "extension.working":
            workingMessage = event.data?["message"]?.stringValue
        case "extension.editorText":
            applyEditorText(event.data)
        case "extension.unsupported":
            guard event.data?["behavior"]?.stringValue == "blocked" else { return }
            let capability = event.data?["capability"]?.stringValue ?? "未知能力"
            issue = AppIssue(
                title: "当前交互无法完成",
                message: "当前会话请求了 D Code 尚未提供的交互：\(capability)。该操作未执行。"
            )
        default:
            break
        }
    }
}
