import Foundation
import Observation

/// 宿主生命周期事件：诊断、进程退出与重启要求。
extension AppModel {
    func handleHostLifecycleEvent(_ event: HostEvent) {
        switch event.name {
        case "host.stderr", "host.outputError", "protocol.decodeError":
            showNotice(event.data?["message"]?.stringValue ?? "Host 诊断事件", level: "error")
        case "host.processEnded":
            resetExtensionUIState()
            cancelFollowUpSettlementGate()
            markCurrentRunUnknown()
            search.probeTask?.cancel()
            search.probeTask = nil
            let interruptedSessionID = selectedSessionID
            Task { [weak self] in
                await self?.pauseFollowUpQueues(
                    sessionID: interruptedSessionID,
                    reason: .hostInterrupted
                )
                if self?.pendingPrompt?.isFollowUpDispatch == true {
                    self?.pendingPrompt = nil
                }
            }
            let expected = event.data?["expected"]?.boolValue ?? false
            connectionState = expected ? .idle : .failed
            if !expected {
                issue = AppIssue(title: "Pi Host 已停止", message: "会话连接已中断。重新打开应用即可尝试恢复。")
            }
        case "host.restartRequired":
            cancelFollowUpSettlementGate()
            markCurrentRunUnknown()
            showNotice("会话运行时未能安全停止。D Code 已保留观察能力，但再次发送前需要重新打开应用。", level: "error")
            Task { [weak self] in
                await self?.pauseFollowUpQueues(
                    sessionID: self?.selectedSessionID,
                    reason: .hostInterrupted
                )
            }
        default:
            break
        }
    }
}
