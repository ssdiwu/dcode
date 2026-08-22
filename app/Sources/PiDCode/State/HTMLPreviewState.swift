import Foundation
import Observation

/// HTML 预览的联网策略状态（ADR 0026 决定 3）：默认阻断；导航层检测到联网
/// 尝试时呈现询问条；“本次允许”仅当前文件预览会话有效——切换文件或回到
/// 对话即恢复阻断，不持久化授权。
@MainActor
@Observable
final class HTMLPreviewState {
    /// 当前会话内被允许联网的文件路径（单值：同一时刻至多一个文件放行）。
    var allowedNetworkPath: String?
    /// 等待用户裁决的联网尝试（询问条）：触发文件与 URL 展示。
    var pendingAttemptPath: String?
    var pendingAttemptURL: String?

    func isNetworkAllowed(path: String) -> Bool {
        allowedNetworkPath == path
    }

    /// 导航层检测到外部联网尝试：已放行的文件不再弹询问。
    func recordNetworkAttempt(path: String, url: String) {
        guard !isNetworkAllowed(path: path) else { return }
        pendingAttemptPath = path
        pendingAttemptURL = url
    }

    func allowNetwork(path: String) {
        allowedNetworkPath = path
        pendingAttemptPath = nil
        pendingAttemptURL = nil
    }

    func keepBlocked() {
        pendingAttemptPath = nil
        pendingAttemptURL = nil
    }

    /// 切换文件 / 回到对话：放行与询问都不跨文件延续。
    func handleFileSelectionChanged(selectedPath: String?) {
        if let allowed = allowedNetworkPath, allowed != selectedPath {
            allowedNetworkPath = nil
        }
        if let pending = pendingAttemptPath, pending != selectedPath {
            pendingAttemptPath = nil
            pendingAttemptURL = nil
        }
    }
}
