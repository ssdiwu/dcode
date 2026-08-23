import AppKit
import Foundation
import Observation

/// 自构建域状态：构建执行、候选校验、受控重启与回滚（ADR 0022 协议的 App 侧承载）。
@MainActor
@Observable
final class SelfBuildModel {
    enum Phase: Equatable {
        case idle
        case verifying
        case building
        case built
        case failed
    }

    var phase: Phase = .idle
    private(set) var lastOutput: SelfBuildOutput?
    var candidate: SelfBuildCandidateInfo?
    private(set) var issue: String?
    private(set) var backupAvailable = false
    private(set) var verificationResults: [SelfBuildCommandResult] = []
    private(set) var sourceSnapshot: SelfBuildSourceSnapshot?
    private(set) var activeManifest: SelfBuildCandidateManifest?
    private(set) var sourceRootIssue: String?
    private(set) var sourceRootSelectionIssue: String?

    var rootDirectory: URL
    @ObservationIgnored var distDirectory: URL
    @ObservationIgnored var scriptURL: URL
    @ObservationIgnored private let followsRootDistDirectory: Bool
    @ObservationIgnored private let followsRootScriptURL: Bool
    @ObservationIgnored private let verificationRunner: @Sendable (URL) async -> [SelfBuildCommandResult]
    @ObservationIgnored private let buildRunner: @Sendable (URL, [String: String], URL) async -> SelfBuildOutput
    @ObservationIgnored private let snapshotter: @Sendable (URL) throws -> SelfBuildSourceSnapshot

    init(
        rootDirectory: URL? = nil,
        distDirectory: URL? = nil,
        scriptURL: URL? = nil,
        verificationRunner: @escaping @Sendable (URL) async -> [SelfBuildCommandResult] = SelfBuildVerificationRunner.run,
        buildRunner: @escaping @Sendable (URL, [String: String], URL) async -> SelfBuildOutput = { script, environment, root in
            await SelfBuildRunner.run(
                scriptURL: script,
                additionalEnvironment: environment,
                currentDirectoryURL: root
            )
        },
        snapshotter: @escaping @Sendable (URL) throws -> SelfBuildSourceSnapshot = SelfBuildSourceSnapshotter.capture
    ) {
        let configuredPath = UserDefaults.standard.string(forKey: SelfBuildModels.sourceRootPreferenceKey)
        let info = rootDirectory.map(SelfBuildSourceRootResolver.validate)
            ?? SelfBuildSourceRootResolver.discover(configuredPath: configuredPath)
        let resolvedRoot = info?.rootURL
            ?? URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
                .standardizedFileURL.resolvingSymlinksInPath()
        self.rootDirectory = resolvedRoot
        followsRootDistDirectory = distDirectory == nil
        followsRootScriptURL = scriptURL == nil
        self.distDirectory = distDirectory ?? resolvedRoot.appending(path: "dist")
        self.scriptURL = scriptURL ?? resolvedRoot.appending(path: "app/build.sh")
        self.verificationRunner = verificationRunner
        self.buildRunner = buildRunner
        self.snapshotter = snapshotter
        sourceRootIssue = info == nil ? "尚未找到有效的 D Code 源码 checkout" : info?.issue
        activeManifest = SelfBuildCandidateManifest.load(from: Bundle.main.bundleURL)
        refreshBackupState()
    }

    var candidateBundleURL: URL {
        rootDirectory.appending(path: SelfBuildModels.candidateDirectoryName)
            .appending(path: SelfBuildModels.activeBundleName)
    }

    func refreshBackupState() {
        backupAvailable = SelfBuildBundleSwapper.backupExists(distDirectory: distDirectory)
    }

    @discardableResult
    func setSourceRoot(_ candidate: URL, persist: Bool = true) -> Bool {
        let info = SelfBuildSourceRootResolver.validate(candidate)
        guard info.isValid else {
            sourceRootSelectionIssue = info.issue
            return false
        }
        rootDirectory = info.rootURL
        if followsRootDistDirectory { distDirectory = info.rootURL.appending(path: "dist") }
        if followsRootScriptURL { scriptURL = info.rootURL.appending(path: "app/build.sh") }
        sourceRootIssue = nil
        sourceRootSelectionIssue = nil
        self.candidate = nil
        verificationResults = []
        sourceSnapshot = nil
        phase = .idle
        if persist {
            UserDefaults.standard.set(info.rootURL.path, forKey: SelfBuildModels.sourceRootPreferenceKey)
        }
        refreshBackupState()
        return true
    }

    /// 构建候选：产物落 dist-candidate，不触碰在用 App。
    func build() async {
        guard phase != .building, phase != .verifying else { return }
        issue = nil
        candidate = nil
        verificationResults = []
        sourceSnapshot = nil
        lastOutput = nil

        let sourceInfo = SelfBuildSourceRootResolver.validate(rootDirectory)
        guard sourceInfo.isValid else {
            sourceRootIssue = sourceInfo.issue
            issue = sourceInfo.issue
            phase = .failed
            return
        }
        sourceRootIssue = nil
        if FileManager.default.fileExists(atPath: candidateBundleURL.path) {
            try? FileManager.default.removeItem(at: candidateBundleURL)
        }

        let initialSnapshot: SelfBuildSourceSnapshot
        do {
            initialSnapshot = try snapshotter(rootDirectory)
        } catch {
            issue = error.localizedDescription
            phase = .failed
            return
        }
        sourceSnapshot = initialSnapshot
        phase = .verifying
        let checks = await verificationRunner(rootDirectory)
        verificationResults = checks
        guard checks.count == 2, checks.allSatisfy(\.succeeded) else {
            issue = checks.last.map { "\($0.label)未通过" } ?? "自动门禁未能运行"
            phase = .failed
            return
        }

        let candidateDist = rootDirectory.appending(path: SelfBuildModels.candidateDirectoryName)
        do {
            try FileManager.default.createDirectory(at: candidateDist, withIntermediateDirectories: true)
        } catch {
            issue = "无法建立候选目录：\(error.localizedDescription)"
            phase = .failed
            return
        }
        // 再次清掉旧候选，避免检查到构建之间的异常残留冒充新候选。
        let staleCandidate = candidateBundleURL
        if FileManager.default.fileExists(atPath: staleCandidate.path) {
            try? FileManager.default.removeItem(at: staleCandidate)
        }

        let manifest = SelfBuildCandidateManifest(snapshot: initialSnapshot, verifications: checks)
        let manifestURL = candidateDist.appending(path: ".self-build-manifest-\(UUID().uuidString).json")
        do {
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
            try encoder.encode(manifest).write(to: manifestURL, options: [.atomic])
        } catch {
            issue = "无法生成候选来源清单：\(error.localizedDescription)"
            phase = .failed
            return
        }
        defer { try? FileManager.default.removeItem(at: manifestURL) }

        phase = .building
        let buildEnvironment = [
                "PI_DCODE_DIST_DIR": candidateDist.path,
                "PI_DCODE_ALLOW_DIRTY_BUILD": "1",
                "PI_DCODE_SELF_BUILD_MANIFEST": manifestURL.path,
            ]
        let output = await buildRunner(scriptURL, buildEnvironment, rootDirectory)
        lastOutput = output
        if output.succeeded {
            do {
                let finalSnapshot = try snapshotter(rootDirectory)
                guard finalSnapshot == initialSnapshot else {
                    try? FileManager.default.removeItem(at: staleCandidate)
                    issue = "构建期间源码发生变化；本次候选已废弃"
                    phase = .failed
                    refreshBackupState()
                    return
                }
                let info = SelfBuildCandidateValidator.validate(candidateBundleURL: candidateBundleURL)
                candidate = info
                issue = info.issue
                phase = info.isReady ? .built : .failed
            } catch {
                try? FileManager.default.removeItem(at: staleCandidate)
                issue = error.localizedDescription
                phase = .failed
            }
        } else {
            candidate = nil
            issue = "候选构建未通过"
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
