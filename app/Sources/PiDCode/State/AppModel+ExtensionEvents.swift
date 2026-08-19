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
            showNotice(event.data?["message"]?.stringValue ?? "扩展通知", level: event.data?["level"]?.stringValue ?? "info")
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
