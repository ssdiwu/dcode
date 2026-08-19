import Foundation
import Observation

/// 模型认证事件：认证提示、事件流与完成。
extension AppModel {
    func handleModelAuthHostEvent(_ event: HostEvent) {
        switch event.name {
        case "modelAuth.request":
            guard let prompt = ModelAuthPrompt(data: event.data),
                  modelSettings.authFlow?.id == prompt.flowID else { return }
            modelSettings.authFlow?.prompt = prompt
            modelSettings.authFlow?.error = nil
        case "modelAuth.promptClosed":
            if let flowID = event.data?["flowId"]?.stringValue,
               let requestID = event.data?["requestId"]?.stringValue,
               modelSettings.authFlow?.id == flowID,
               modelSettings.authFlow?.prompt?.id == requestID {
                modelSettings.authFlow?.prompt = nil
            }
        case "modelAuth.event":
            guard let flowID = event.data?["flowId"]?.stringValue,
                  modelSettings.authFlow?.id == flowID,
                  let presentation = ModelAuthEventPresentation(data: event.data) else { return }
            modelSettings.authFlow?.events.append(presentation)
            if let count = modelSettings.authFlow?.events.count, count > 12 {
                modelSettings.authFlow?.events.removeFirst(count - 12)
            }
            modelSettings.authFlow?.error = nil
        case "modelAuth.completed":
            if event.data?["flowId"]?.stringValue == modelSettings.authFlow?.id {
                modelSettings.authFlow?.prompt = nil
                if let presentation = ModelAuthEventPresentation(data: .object([
                    "event": .object([
                        "type": .string("progress"),
                        "message": .string("认证完成，正在刷新模型目录…"),
                    ]),
                ])) {
                    modelSettings.authFlow?.events.append(presentation)
                }
            }
        default:
            break
        }
    }
}
