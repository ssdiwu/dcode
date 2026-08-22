import Foundation
import Observation

/// 宿主生命周期事件：诊断、进程退出与重启要求。
extension AppModel {
    func handleHostLifecycleEvent(_ event: HostEvent) {
        switch event.name {
        case "host.stderr":
            // stderr 来自 Node 子进程本身，可能是任意扩展的自身输出（例如 pi-tui 专用的
            // 状态行），不代表 D Code 或 Host 的真实错误；只留存只读诊断，不弹出通知。
            appendHostDiagnostic(event.data?["message"]?.stringValue ?? "")
        case "host.outputError", "protocol.decodeError":
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
                issue = AppIssue(
                    title: "Pi Host 已停止",
                    message: "会话连接已中断。当前运行已标记为结果未知；点击侧栏“重新连接 Pi Host”可在不重启应用的情况下恢复。"
                )
            }
        case "host.restartRequired":
            cancelFollowUpSettlementGate()
            markCurrentRunUnknown()
            hostRestartRequired = true
            showNotice("会话运行时未能安全停止。写入已被暂停；点击侧栏“重新连接 Pi Host”可恢复。", level: "error")
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
