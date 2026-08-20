import AppKit
import Foundation
import Observation

/// 自构建域状态：构建执行、候选校验、受控重启与回滚（ADR 0022 协议的 App 侧承载）。
@MainActor
@Observable
final class SelfBuildModel {
    enum Phase: Equatable {
        case idle
        case building
        case built
        case failed
    }

    var phase: Phase = .idle
    private(set) var lastOutput: SelfBuildOutput?
    var candidate: SelfBuildCandidateInfo?
    private(set) var issue: String?
    private(set) var backupAvailable = false

    @ObservationIgnored var rootDirectory: URL
    @ObservationIgnored var distDirectory: URL
    @ObservationIgnored var scriptURL: URL

    init(
        rootDirectory: URL = URL(fileURLWithPath: "/Users/diwu/Workspace/Codes/Apps/dcode"),
        distDirectory: URL? = nil,
        scriptURL: URL? = nil
    ) {
        self.rootDirectory = rootDirectory
        self.distDirectory = distDirectory ?? rootDirectory.appending(path: "dist")
        self.scriptURL = scriptURL ?? rootDirectory.appending(path: "app/build.sh")
        refreshBackupState()
    }

    var candidateBundleURL: URL {
        rootDirectory.appending(path: SelfBuildModels.candidateDirectoryName)
            .appending(path: SelfBuildModels.activeBundleName)
    }

    func refreshBackupState() {
        backupAvailable = SelfBuildBundleSwapper.backupExists(distDirectory: distDirectory)
    }

    /// 构建候选：产物落 dist-candidate，不触碰在用 App。
    func build() async {
        guard phase != .building else { return }
        phase = .building
        issue = nil
        let candidateDist = rootDirectory.appending(path: SelfBuildModels.candidateDirectoryName)
        try? FileManager.default.createDirectory(at: candidateDist, withIntermediateDirectories: true)
        // 清掉旧候选，避免 build.sh 失败时把陈旧产物当新候选
        let staleCandidate = candidateBundleURL
        if FileManager.default.fileExists(atPath: staleCandidate.path) {
            try? FileManager.default.removeItem(at: staleCandidate)
        }
        let output = await SelfBuildRunner.run(
            scriptURL: scriptURL,
            additionalEnvironment: ["PI_DCODE_DIST_DIR": candidateDist.path],
            currentDirectoryURL: rootDirectory
        )
        lastOutput = output
        if output.succeeded {
            candidate = SelfBuildCandidateValidator.validate(candidateBundleURL: candidateBundleURL)
            phase = .built
        } else {
            candidate = nil
            phase = .failed
        }
        refreshBackupState()
    }

    enum RestartOutcome: Equatable {
        case restarted
        case validationFailed(String)
        case swapFailed(String)
    }

    /// 受控重启到候选：校验 → 原子交换 → 标记恢复会话 → 拉起新 App → 关机。
    func restartIntoCandidate(pendingSessionID: String?) async -> RestartOutcome {
        guard phase == .built else { return .validationFailed("尚无可用的候选构建") }
        let info = SelfBuildCandidateValidator.validate(candidateBundleURL: candidateBundleURL)
        candidate = info
        guard info.isReady else {
            phase = .failed
            return .validationFailed(info.issue ?? "候选校验未通过")
        }
        let swap = SelfBuildBundleSwapper.installCandidate(candidateBundleURL: candidateBundleURL, distDirectory: distDirectory)
        refreshBackupState()
        guard swap.succeeded else {
            return .swapFailed(swap.issue ?? "交换失败")
        }
        markRestart(pendingSessionID: pendingSessionID)
        relaunchActiveBundle()
        NSApp.terminate(nil)
        return .restarted
    }

    /// 回滚到备份构建并重启。
    func rollbackAndRestart(pendingSessionID: String?) async -> RestartOutcome {
        let swap = SelfBuildBundleSwapper.rollback(distDirectory: distDirectory)
        refreshBackupState()
        guard swap.succeeded else {
            return .swapFailed(swap.issue ?? "回滚失败")
        }
        markRestart(pendingSessionID: pendingSessionID)
        relaunchActiveBundle()
        NSApp.terminate(nil)
        return .restarted
    }

    private func markRestart(pendingSessionID: String?) {
        let defaults = UserDefaults.standard
        defaults.set(true, forKey: SelfBuildModels.restartMarkerKey)
        if let pendingSessionID {
            defaults.set(pendingSessionID, forKey: SelfBuildModels.pendingSessionKey)
        } else {
            defaults.removeObject(forKey: SelfBuildModels.pendingSessionKey)
        }
    }

    private func relaunchActiveBundle() {
        let activeURL = distDirectory.appending(path: SelfBuildModels.activeBundleName)
        NSWorkspace.shared.openApplication(
            at: activeURL,
            configuration: NSWorkspace.OpenConfiguration()
        )
    }

    /// 启动恢复：读并清除自构建重启标记，返回应恢复的会话 ID。
    nonisolated static func consumeRestartMarker() -> String? {
        let defaults = UserDefaults.standard
        guard defaults.bool(forKey: SelfBuildModels.restartMarkerKey) else { return nil }
        defaults.set(false, forKey: SelfBuildModels.restartMarkerKey)
        return defaults.string(forKey: SelfBuildModels.pendingSessionKey)
    }
}
